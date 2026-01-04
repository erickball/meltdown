/**
 * Semi-Implicit Pressure-Flow Solver
 *
 * For compressed liquid, the bulk modulus K is extremely high (~2200 MPa at low T),
 * meaning tiny density changes cause huge pressure swings. This creates stiffness
 * in the explicit solver.
 *
 * The semi-implicit approach:
 * 1. For each liquid node, compute what mass imbalance would occur with current flows
 * 2. Compute a "virtual pressure adjustment" based on this imbalance
 * 3. Use these virtual pressures to adjust flow rates toward mass balance
 * 4. Iterate until flows approximately conserve mass
 *
 * This runs BEFORE the constraint operators to pre-condition the flow rates.
 * The actual node pressures remain computed by steam tables (thermodynamically consistent).
 * We only adjust the massFlowRate on connections, not the node pressures.
 *
 * Physical interpretation: we're finding the flow rates that would exist in
 * quasi-steady-state, where the pressure wave has already propagated through
 * the liquid network. This removes the acoustic timescale from the problem.
 */

import {
  SimulationState,
  FlowNode,
  FlowConnection,
  PressureSolverConfig,
  DEFAULT_PRESSURE_SOLVER_CONFIG,
} from '../types';
import {
  numericalBulkModulus,
  saturationPressure,
  calculateState,
  distanceToSaturationLine,
} from '../water-properties';

const g = 9.81; // m/s²

// Debug log entry for a single node at one iteration
interface NodeDebugEntry {
  nodeId: string;
  phase: string;
  mass: number;
  volume: number;
  density: number;
  pressure: number;
  temperature: number;
  dm_net: number;
  K: number;
  dP_virtual: number;
  virtualCorrection: number;
}

// Debug log entry for a single connection at one iteration
interface ConnectionDebugEntry {
  connId: string;
  fromNodeId: string;
  toNodeId: string;
  P_from_actual: number;
  P_to_actual: number;
  P_from_virtual: number;
  P_to_virtual: number;
  dP_pressure: number;
  dP_gravity: number;
  dP_pump: number;
  dP_friction: number;
  dP_net: number;
  oldFlowRate: number;
  newFlowRate: number;
  dm_dot_dt: number;
}

// Debug log for one complete iteration
interface IterationDebugEntry {
  iteration: number;
  nodes: NodeDebugEntry[];
  connections: ConnectionDebugEntry[];
  maxImbalance: number;
  converged: boolean;
  stagnated: boolean;
}

// Complete debug log for one solve() call
interface SolveDebugLog {
  dt: number;
  initialState: {
    nodes: Array<{ id: string; mass: number; pressure: number; density: number }>;
    connections: Array<{ id: string; fromId: string; toId: string; flowRate: number }>;
  };
  iterations: IterationDebugEntry[];
  finalState: {
    nodes: Array<{ id: string; mass: number; pressure: number; density: number }>;
    connections: Array<{ id: string; fromId: string; toId: string; flowRate: number }>;
  };
}

/** Status of the last pressure solve */
export interface PressureSolverStatus {
  /** Whether the solver ran this timestep */
  ran: boolean;
  /** Number of iterations performed */
  iterations: number;
  /** Whether the solver converged */
  converged: boolean;
  /** Whether the solver stagnated (stopped making progress) */
  stagnated: boolean;
  /** Maximum mass imbalance at end of solve (kg/s) */
  maxImbalance: number;
  /** Current K_max setting (Pa), or undefined if using physical K */
  K_max: number | undefined;
}

/**
 * Semi-Implicit Pressure-Flow Solver
 */
export class PressureSolver {
  public config: PressureSolverConfig;

  // Virtual pressure corrections (not applied to state, only used in iteration)
  private virtualPressureCorrection = new Map<string, number>();

  // Debug logging
  private debugLog: SolveDebugLog | null = null;
  private previousDebugLog: SolveDebugLog | null = null; // Keep previous for spike analysis
  private currentIterationLog: IterationDebugEntry | null = null;

  // Status of last solve
  private lastStatus: PressureSolverStatus = {
    ran: false,
    iterations: 0,
    converged: false,
    stagnated: false,
    maxImbalance: 0,
    K_max: undefined,
  };

  constructor(config?: Partial<PressureSolverConfig>) {
    this.config = { ...DEFAULT_PRESSURE_SOLVER_CONFIG, ...config };
  }

  /** Get the status of the last pressure solve */
  getLastStatus(): PressureSolverStatus {
    return { ...this.lastStatus, K_max: this.config.K_max };
  }

  /**
   * Solve for flow rates that approximately satisfy mass conservation
   * at each liquid node, given the current pressures.
   *
   * This modifies conn.massFlowRate in place, but does NOT modify node pressures.
   *
   * @param state - Simulation state (flow rates modified in place)
   * @param dt - Timestep in seconds
   */
  solve(state: SimulationState, dt: number): void {
    // Process ALL flow nodes - the pressure solver must handle the entire network
    // to properly balance flows. Phase boundaries are exactly where stiffness occurs,
    // so excluding two-phase or vapor nodes would leave gaps in the flow network.
    const allNodes = state.flowNodes;

    if (allNodes.size === 0) return;

    // Initialize debug log - capture initial state
    this.debugLog = {
      dt,
      initialState: {
        nodes: Array.from(state.flowNodes.entries()).map(([id, node]) => ({
          id,
          mass: node.fluid.mass,
          pressure: node.fluid.pressure,
          density: node.fluid.mass / node.volume,
        })),
        connections: state.flowConnections.map(conn => ({
          id: conn.id,
          fromId: conn.fromNodeId,
          toId: conn.toNodeId,
          flowRate: conn.massFlowRate,
        })),
      },
      iterations: [],
      finalState: { nodes: [], connections: [] },
    };

    // Check for density spike at START - if we enter with dangerous density,
    // the previous timestep failed to balance flows properly
    // Normal water at 20°C is ~998 kg/m³, at 100°C is ~958 kg/m³
    // High-pressure compressed liquid can reach ~1050 kg/m³
    // Only trigger at truly dangerous levels that will cause steam table problems
    const DENSITY_SPIKE_THRESHOLD = 1050; // kg/m³ - dangerously compressed
    for (const [id, node] of state.flowNodes) {
      const density = node.fluid.mass / node.volume;
      if (density > DENSITY_SPIKE_THRESHOLD && node.fluid.phase === 'liquid') {
        console.error(`[PressureSolver] DENSITY SPIKE AT START: ${id} at ρ=${density.toFixed(1)} kg/m³ (P=${(node.fluid.pressure / 1e6).toFixed(2)} MPa)`);
        console.error(`[PressureSolver] This means previous timestep accumulated too much mass.`);

        // Dump the PREVIOUS debug log - that's the timestep that caused this
        if (this.previousDebugLog) {
          console.error(`[PressureSolver] Dumping PREVIOUS timestep that led to this spike:`);
          const savedLog = this.debugLog;
          this.debugLog = this.previousDebugLog;
          this.dumpDebugLog();
          this.debugLog = savedLog;
        } else {
          console.error(`[PressureSolver] No previous debug log available (first timestep?)`);
          console.error(`[PressureSolver] Dumping current initial state:`);
          this.dumpDebugLog();
        }

        throw new Error(`[PressureSolver] Density spike detected: ${id} at ρ=${density.toFixed(1)} kg/m³. Check debug log above.`);
      }
    }

    // Build connection map: which connections touch which nodes
    const nodeConnections = this.buildNodeConnectionMap(state, allNodes);

    // Reset virtual pressure corrections
    this.virtualPressureCorrection.clear();
    for (const nodeId of allNodes.keys()) {
      this.virtualPressureCorrection.set(nodeId, 0);
    }

    // Track convergence
    let lastMaxImbalance = Infinity;

    // Gauss-Seidel iteration
    for (let iter = 0; iter < this.config.maxIterations; iter++) {
      let maxImbalance = 0;

      // Start new iteration log
      this.currentIterationLog = {
        iteration: iter,
        nodes: [],
        connections: [],
        maxImbalance: 0,
        converged: false,
        stagnated: false,
      };

      // Pass 1: Compute virtual pressure corrections from mass imbalance
      for (const [nodeId, node] of allNodes) {
        const connections = nodeConnections.get(nodeId) || [];

        // Compute net mass flow into this node
        let dm_net = 0;
        for (const { conn, isFrom } of connections) {
          if (isFrom) {
            dm_net -= conn.massFlowRate; // Outflow
          } else {
            dm_net += conn.massFlowRate; // Inflow
          }
        }

        // Track maximum imbalance for convergence check
        maxImbalance = Math.max(maxImbalance, Math.abs(dm_net));

        const T_C = node.fluid.temperature - 273.15;
        const rho = node.fluid.mass / node.volume;

        // Get phase-appropriate bulk modulus
        const K = this.getEffectiveBulkModulus(node, T_C, rho);

        let dP_virtual = 0;
        let newCorrection = this.virtualPressureCorrection.get(nodeId) || 0;

        // Skip if nearly balanced
        if (Math.abs(dm_net) >= 1e-10) {
          // Compute virtual pressure correction
          // If dm_net > 0, mass is accumulating -> pressure would rise -> reduce inflow
          // If dm_net < 0, mass is depleting -> pressure would fall -> increase inflow

          // dP = K/rho * (dm/V) where dm = dm_net * dt
          // This is the pressure change that WOULD occur over this timestep
          dP_virtual = (K / rho) * (dm_net * dt / node.volume);

          // Apply with relaxation
          const oldCorrection = this.virtualPressureCorrection.get(nodeId) || 0;
          newCorrection = oldCorrection + this.config.relaxation * dP_virtual;
          this.virtualPressureCorrection.set(nodeId, newCorrection);
        }

        // Log node state for this iteration
        this.currentIterationLog.nodes.push({
          nodeId,
          phase: node.fluid.phase,
          mass: node.fluid.mass,
          volume: node.volume,
          density: rho,
          pressure: node.fluid.pressure,
          temperature: node.fluid.temperature,
          dm_net,
          K,
          dP_virtual,
          virtualCorrection: newCorrection,
        });
      }

      // Pass 2: Update flow rates based on virtual pressures
      this.updateFlowRatesWithVirtualPressure(state, allNodes, dt);

      // Check convergence based on mass imbalance
      // For a 1 m³ liquid node at 1000 kg/m³, 0.01 kg/s imbalance = 1e-5 density change/s
      // That's acceptable for stability
      const maxMass = this.getMaxNodeMass(allNodes);
      const relativeImbalance = maxImbalance / Math.max(maxMass, 1);

      this.currentIterationLog.maxImbalance = maxImbalance;

      if (relativeImbalance < this.config.tolerance) {
        // Converged - mass imbalance is small relative to node mass
        this.currentIterationLog.converged = true;
        this.debugLog.iterations.push(this.currentIterationLog);
        break;
      }

      // Check for stagnation
      if (iter > 3 && maxImbalance >= lastMaxImbalance * 0.99) {
        // Not making progress, stop early
        this.currentIterationLog.stagnated = true;
        this.debugLog.iterations.push(this.currentIterationLog);
        break;
      }

      this.debugLog.iterations.push(this.currentIterationLog);
      lastMaxImbalance = maxImbalance;
    }

    // Capture final state
    this.debugLog.finalState = {
      nodes: Array.from(state.flowNodes.entries()).map(([id, node]) => ({
        id,
        mass: node.fluid.mass,
        pressure: node.fluid.pressure,
        density: node.fluid.mass / node.volume,
      })),
      connections: state.flowConnections.map(conn => ({
        id: conn.id,
        fromId: conn.fromNodeId,
        toId: conn.toNodeId,
        flowRate: conn.massFlowRate,
      })),
    };

    // Update status from last iteration
    const lastIter = this.debugLog.iterations[this.debugLog.iterations.length - 1];
    this.lastStatus = {
      ran: true,
      iterations: this.debugLog.iterations.length,
      converged: lastIter?.converged ?? false,
      stagnated: lastIter?.stagnated ?? false,
      maxImbalance: lastIter?.maxImbalance ?? 0,
      K_max: this.config.K_max,
    };

    // Check for pressure spike and dump debug log if found
    this.checkForPressureSpike(state);

    // Save this debug log for next timestep's spike detection
    this.previousDebugLog = this.debugLog;
  }

  /**
   * Check if any node would have pressure > 25 MPa based on current (m, U, V).
   * This computes the THERMODYNAMIC pressure from water properties - what the
   * constraint operator will compute next timestep. If this is too high,
   * the pressure solver failed to prevent mass accumulation.
   */
  private checkForPressureSpike(state: SimulationState): void {
    const PRESSURE_SPIKE_THRESHOLD = 25e6; // 25 MPa

    for (const [id, node] of state.flowNodes) {
      // Compute the pressure that would result from current (m, U, V)
      // This is what FluidStateConstraintOperator will compute next timestep
      const mass = node.fluid.mass;
      const U = node.fluid.internalEnergy;
      const V = node.volume;

      // Specific internal energy and specific volume (for display)
      const u = U / mass; // J/kg
      const v = V / mass; // m³/kg

      // Calculate thermodynamic state from (mass, U, V)
      try {
        const waterState = calculateState(mass, U, V);
        const computedP = waterState.pressure;
        const computedPhase = waterState.phase;

        // Check for phase transition that would cause a pressure spike
        // If current phase is two-phase but computed phase is liquid, that's dangerous
        const currentPhase = node.fluid.phase;
        if (currentPhase === 'two-phase' && computedPhase === 'liquid') {
          console.error(`[PressureSolver] PHASE TRANSITION DETECTED: ${id}`);
          console.error(`  Current phase: ${currentPhase} → Computed phase: ${computedPhase}`);
          console.error(`  This transition from two-phase to liquid causes pressure spikes!`);
        }

        if (computedP > PRESSURE_SPIKE_THRESHOLD) {
          const density = mass / V;
          console.error(`[PressureSolver] PRESSURE SPIKE PREDICTED: ${id}`);
          console.error(`  Current state: m=${mass.toFixed(1)}kg, U=${(U/1e6).toFixed(3)}MJ, V=${(V*1000).toFixed(1)}L`);
          console.error(`  Specific: u=${(u/1000).toFixed(1)}kJ/kg, v=${(v*1000).toFixed(4)}L/kg`);
          console.error(`  Density: ρ=${density.toFixed(1)}kg/m³`);
          console.error(`  Current phase: ${currentPhase}, Computed phase: ${computedPhase}`);
          console.error(`  Computed P from (m,U,V): ${(computedP / 1e6).toFixed(2)} MPa`);
          console.error(`  Current node.fluid.pressure: ${(node.fluid.pressure / 1e6).toFixed(2)} MPa`);
          console.error(`[PressureSolver] The pressure solver failed to prevent mass accumulation.`);

          // Dump the current debug log - shows iterations that led to this state
          this.dumpDebugLog();

          throw new Error(`[PressureSolver] Pressure spike predicted: ${id} at ${(computedP / 1e6).toFixed(2)} MPa from (m,U,V). Check debug log above.`);
        }
      } catch (e) {
        // If calculateWaterState itself throws, that's also bad
        if (e instanceof Error && e.message.includes('Pressure spike')) {
          throw e; // Re-throw our own error
        }
        console.error(`[PressureSolver] Failed to compute water state for ${id}: ${e}`);
        // Don't throw for water property errors - let the constraint operator handle it
      }

      // Also check if density is dangerously high
      const density = node.fluid.mass / node.volume;
      if (density > 1100) {
        console.error(`[PressureSolver] DENSITY SPIKE DETECTED: ${id} at ${density.toFixed(1)} kg/m³`);
        this.dumpDebugLog();
        throw new Error(`[PressureSolver] Density spike detected: ${id} at ${density.toFixed(1)} kg/m³. Check debug log above.`);
      }
    }
  }

  /**
   * Dump the complete debug log to console.
   */
  private dumpDebugLog(): void {
    if (!this.debugLog) {
      console.error('[PressureSolver] No debug log available');
      return;
    }

    console.group('[PressureSolver] Debug Log Dump');

    console.log(`dt = ${(this.debugLog.dt * 1000).toFixed(3)} ms`);

    console.group('Initial State');
    console.log('Nodes:');
    for (const node of this.debugLog.initialState.nodes) {
      console.log(`  ${node.id}: m=${node.mass.toFixed(1)}kg, P=${(node.pressure / 1e6).toFixed(3)}MPa, ρ=${node.density.toFixed(1)}kg/m³`);
    }
    console.log('Connections:');
    for (const conn of this.debugLog.initialState.connections) {
      console.log(`  ${conn.id}: ${conn.fromId} → ${conn.toId}, ṁ=${conn.flowRate.toFixed(2)}kg/s`);
    }
    console.groupEnd();

    for (const iter of this.debugLog.iterations) {
      console.group(`Iteration ${iter.iteration} (maxImbalance=${iter.maxImbalance.toFixed(3)}kg/s, converged=${iter.converged}, stagnated=${iter.stagnated})`);

      console.log('Nodes:');
      for (const node of iter.nodes) {
        console.log(`  ${node.nodeId} [${node.phase}]:`);
        console.log(`    m=${node.mass.toFixed(1)}kg, V=${(node.volume * 1000).toFixed(1)}L, ρ=${node.density.toFixed(1)}kg/m³`);
        console.log(`    P=${(node.pressure / 1e6).toFixed(3)}MPa, T=${(node.temperature - 273.15).toFixed(1)}°C`);
        console.log(`    dm_net=${node.dm_net.toFixed(3)}kg/s, K=${(node.K / 1e3).toFixed(2)}kPa (${(node.K / 1e6).toFixed(4)}MPa)`);
        console.log(`    dP_virtual=${(node.dP_virtual / 1e6).toFixed(3)}MPa, virtualCorrection=${(node.virtualCorrection / 1e6).toFixed(3)}MPa`);
      }

      console.log('Connections:');
      for (const conn of iter.connections) {
        console.log(`  ${conn.connId}: ${conn.fromNodeId} → ${conn.toNodeId}`);
        console.log(`    P_from: actual=${(conn.P_from_actual / 1e6).toFixed(3)}MPa, virtual=${(conn.P_from_virtual / 1e6).toFixed(3)}MPa`);
        console.log(`    P_to: actual=${(conn.P_to_actual / 1e6).toFixed(3)}MPa, virtual=${(conn.P_to_virtual / 1e6).toFixed(3)}MPa`);
        console.log(`    dP: pressure=${(conn.dP_pressure / 1e6).toFixed(3)}MPa, gravity=${(conn.dP_gravity / 1e3).toFixed(3)}kPa, pump=${(conn.dP_pump / 1e6).toFixed(3)}MPa, friction=${(conn.dP_friction / 1e3).toFixed(3)}kPa`);
        console.log(`    dP_net=${(conn.dP_net / 1e6).toFixed(3)}MPa, dm_dot_dt=${conn.dm_dot_dt.toFixed(3)}kg/s²`);
        console.log(`    ṁ: ${conn.oldFlowRate.toFixed(2)} → ${conn.newFlowRate.toFixed(2)} kg/s`);
      }

      console.groupEnd();
    }

    console.group('Final State');
    console.log('Nodes:');
    for (const node of this.debugLog.finalState.nodes) {
      console.log(`  ${node.id}: m=${node.mass.toFixed(1)}kg, P=${(node.pressure / 1e6).toFixed(3)}MPa, ρ=${node.density.toFixed(1)}kg/m³`);
    }
    console.log('Connections:');
    for (const conn of this.debugLog.finalState.connections) {
      console.log(`  ${conn.id}: ${conn.fromId} → ${conn.toId}, ṁ=${conn.flowRate.toFixed(2)}kg/s`);
    }
    console.groupEnd();

    console.groupEnd();
  }

  /**
   * Build a map from node ID to its connected flow connections.
   */
  private buildNodeConnectionMap(
    state: SimulationState,
    nodes: Map<string, FlowNode>
  ): Map<string, Array<{ conn: FlowConnection; isFrom: boolean }>> {
    const map = new Map<string, Array<{ conn: FlowConnection; isFrom: boolean }>>();

    for (const nodeId of nodes.keys()) {
      map.set(nodeId, []);
    }

    for (const conn of state.flowConnections) {
      if (nodes.has(conn.fromNodeId)) {
        map.get(conn.fromNodeId)!.push({ conn, isFrom: true });
      }
      if (nodes.has(conn.toNodeId)) {
        map.get(conn.toNodeId)!.push({ conn, isFrom: false });
      }
    }

    return map;
  }

  /**
   * Get phase-appropriate effective bulk modulus for a node.
   *
   * The bulk modulus K = ρ * (dP/dρ) determines how pressure responds to density changes.
   *
   * For liquid: use the temperature-dependent bulk modulus from steam tables
   * For two-phase: use P_sat as scale (phase change absorbs density changes)
   * For vapor: use γP (ideal gas approximation)
   *
   * All transitions use smooth blending to avoid discontinuities.
   */
  private getEffectiveBulkModulus(node: FlowNode, T_C: number, _rho: number): number {
    const phase = node.fluid.phase;
    const T_K = T_C + 273.15;
    const P = node.fluid.pressure;

    // Heat capacity ratio for steam (used for vapor and blending)
    const gamma = 1.3;
    const K_ideal = gamma * P;

    if (phase === 'liquid') {
      // Compressed liquid - use physical bulk modulus with optional numerical cap
      // At phase boundary, need to blend toward two-phase behavior
      const P_sat = saturationPressure(T_K);
      const K_liquid = numericalBulkModulus(T_C, this.config.K_max);

      // Check distance to saturation line in (u,v) space
      // For liquid: distance > 0 (v < v_f), distance → 0 as we approach saturation
      const u = node.fluid.internalEnergy / node.fluid.mass;
      const v = node.volume / node.fluid.mass;
      const satDist = distanceToSaturationLine(u, v);

      // Blend toward two-phase K (≈ P_sat) when close to saturation line
      const BLEND_DISTANCE = 0.05; // mL/kg in normalized space
      if (satDist.distance > 0 && satDist.distance < BLEND_DISTANCE) {
        // Close to saturation line - blend from liquid K toward P_sat
        // blend = 0 at edge (far from sat), blend = 1 at sat line
        const blend = 1 - (satDist.distance / BLEND_DISTANCE);
        return (1 - blend) * K_liquid + blend * P_sat;
      }
      return K_liquid;
    } else if (phase === 'two-phase') {
      // Two-phase: phase change absorbs most density changes.
      // The effective bulk modulus is determined by how pressure responds to
      // adding/removing mass at constant quality - which is just P_sat(T).
      // At low pressures (e.g., condenser at 5 kPa), K_eff is correspondingly low,
      // but this is physically correct - low-pressure two-phase is very compressible.
      //
      // HOWEVER: if we're close to leaving the two-phase region (low quality, about
      // to become compressed liquid), we need to start using liquid K to prevent
      // a sudden jump when the phase transition occurs.
      const P_sat = saturationPressure(T_K);

      // Check how close we are to the liquid saturation line
      const u = node.fluid.internalEnergy / node.fluid.mass;
      const v = node.volume / node.fluid.mass;
      const satDist = distanceToSaturationLine(u, v);

      // For two-phase: distance < 0 (v > v_f, inside dome)
      // As distance approaches 0 from below, we're approaching liquid saturation
      const BLEND_DISTANCE = 0.05; // mL/kg in normalized space
      if (satDist.distance < 0 && satDist.distance > -BLEND_DISTANCE) {
        // Close to liquid saturation line - blend from two-phase K toward liquid K
        // |distance| is how far we are from saturation
        const K_liquid = numericalBulkModulus(T_C, this.config.K_max);
        const blend = 1 - (Math.abs(satDist.distance) / BLEND_DISTANCE); // 0 at edge, 1 at sat line
        return (1 - blend) * P_sat + blend * K_liquid;
      }
      return P_sat;
    } else {
      // Vapor: use ideal gas bulk modulus K = γP
      // Even saturated vapor behaves as a gas - phase change only matters if
      // there's liquid present (which would make it two-phase).
      // At low condenser pressures (5-20 kPa), this gives K = 6.5-26 kPa,
      // which is correct - low-pressure vapor is very compressible.
      return K_ideal;
    }
  }

  /**
   * Update flow rates based on actual pressures PLUS virtual pressure corrections.
   * Returns the maximum absolute flow change for convergence tracking.
   */
  private updateFlowRatesWithVirtualPressure(
    state: SimulationState,
    allNodes: Map<string, FlowNode>,
    dt: number
  ): number {
    let maxFlowChange = 0;

    for (const conn of state.flowConnections) {
      const fromNode = state.flowNodes.get(conn.fromNodeId);
      const toNode = state.flowNodes.get(conn.toNodeId);
      if (!fromNode || !toNode) continue;

      // Process all connections - both nodes should be in our node set
      const fromInSet = allNodes.has(conn.fromNodeId);
      const toInSet = allNodes.has(conn.toNodeId);
      if (!fromInSet && !toInSet) continue;

      // Check for closed valve - if so, decay flow to zero
      const valveState = this.findValveOnConnection(state, conn.id);
      if (valveState && valveState.position < 0.01) {
        const tau = 0.1; // 100ms decay time
        const oldFlow = conn.massFlowRate;
        conn.massFlowRate *= Math.exp(-dt / tau);
        maxFlowChange = Math.max(maxFlowChange, Math.abs(conn.massFlowRate - oldFlow));

        // Log closed valve connection
        if (this.currentIterationLog) {
          this.currentIterationLog.connections.push({
            connId: conn.id,
            fromNodeId: conn.fromNodeId,
            toNodeId: conn.toNodeId,
            P_from_actual: fromNode.fluid.pressure,
            P_to_actual: toNode.fluid.pressure,
            P_from_virtual: fromNode.fluid.pressure,
            P_to_virtual: toNode.fluid.pressure,
            dP_pressure: 0,
            dP_gravity: 0,
            dP_pump: 0,
            dP_friction: 0,
            dP_net: 0,
            oldFlowRate: oldFlow,
            newFlowRate: conn.massFlowRate,
            dm_dot_dt: 0,
          });
        }
        continue;
      }

      // Start with actual node pressures
      const P_from_actual = fromNode.fluid.pressure;
      const P_to_actual = toNode.fluid.pressure;
      let P_from = P_from_actual;
      let P_to = P_to_actual;

      // Add virtual pressure corrections for all nodes in the set
      if (fromInSet) {
        P_from += this.virtualPressureCorrection.get(conn.fromNodeId) || 0;
      }
      if (toInSet) {
        P_to += this.virtualPressureCorrection.get(conn.toNodeId) || 0;
      }

      const dP_pressure = P_from - P_to;

      // Gravity (using average density and connection elevation change)
      const rho_from = fromNode.fluid.mass / fromNode.volume;
      const rho_to = toNode.fluid.mass / toNode.volume;
      const rho_avg = (rho_from + rho_to) / 2;
      const dz = conn.elevation || 0;
      const dP_gravity = -rho_avg * g * dz;

      // Pump head
      let dP_pump = 0;
      const pump = this.findPumpOnConnection(state, conn.id);
      if (pump && pump.running && pump.effectiveSpeed > 0) {
        dP_pump = pump.effectiveSpeed * pump.ratedHead * rho_avg * g;
      }

      // Friction (quadratic drag) - use current flow for linearization
      const A = conn.flowArea || 0.1;
      const v = conn.massFlowRate / (rho_avg * A);
      let K_fric = conn.resistanceCoeff || 10;

      // Valve increases resistance
      if (valveState) {
        K_fric = K_fric / Math.pow(Math.max(0.01, valveState.position), 2);
      }

      const dP_friction = -K_fric * 0.5 * rho_avg * v * Math.abs(v);

      // Check valve - prevents reverse flow
      const checkValve = state.components.checkValves?.get(conn.id);
      if (checkValve) {
        const dP_driving = dP_pressure + dP_gravity + dP_pump;
        if (dP_driving < checkValve.crackingPressure) {
          const tau = 0.1;
          const oldFlow = conn.massFlowRate;
          conn.massFlowRate *= Math.exp(-dt / tau);
          maxFlowChange = Math.max(maxFlowChange, Math.abs(conn.massFlowRate - oldFlow));

          // Log check valve blocked connection
          if (this.currentIterationLog) {
            this.currentIterationLog.connections.push({
              connId: conn.id,
              fromNodeId: conn.fromNodeId,
              toNodeId: conn.toNodeId,
              P_from_actual,
              P_to_actual,
              P_from_virtual: P_from,
              P_to_virtual: P_to,
              dP_pressure,
              dP_gravity,
              dP_pump,
              dP_friction,
              dP_net: dP_driving,
              oldFlowRate: oldFlow,
              newFlowRate: conn.massFlowRate,
              dm_dot_dt: 0,
            });
          }
          continue;
        }
      }

      // Pump reverse-flow blocking
      if (pump && pump.running && conn.massFlowRate < 0) {
        K_fric += 10000 * (conn.resistanceCoeff || 10);
      }

      // Net driving pressure (including virtual corrections)
      const dP_net = dP_pressure + dP_gravity + dP_pump + dP_friction;

      // Momentum equation: dm_dot/dt = dP_net * A / (rho * L)
      const L = conn.length || 10;
      const dm_dot_dt = dP_net * A / (rho_avg * L);

      // Update flow rate with relaxation
      const oldFlow = conn.massFlowRate;
      conn.massFlowRate += this.config.relaxation * dm_dot_dt * dt;
      maxFlowChange = Math.max(maxFlowChange, Math.abs(conn.massFlowRate - oldFlow));

      // Log connection update
      if (this.currentIterationLog) {
        this.currentIterationLog.connections.push({
          connId: conn.id,
          fromNodeId: conn.fromNodeId,
          toNodeId: conn.toNodeId,
          P_from_actual,
          P_to_actual,
          P_from_virtual: P_from,
          P_to_virtual: P_to,
          dP_pressure,
          dP_gravity,
          dP_pump,
          dP_friction,
          dP_net,
          oldFlowRate: oldFlow,
          newFlowRate: conn.massFlowRate,
          dm_dot_dt,
        });
      }
    }

    return maxFlowChange;
  }

  /**
   * Find a valve connected to the given flow path.
   */
  private findValveOnConnection(
    state: SimulationState,
    connId: string
  ): { position: number } | undefined {
    for (const [, valve] of state.components.valves) {
      if (valve.connectedFlowPath === connId) {
        return valve;
      }
    }
    return undefined;
  }

  /**
   * Find a pump connected to the given flow path.
   */
  private findPumpOnConnection(
    state: SimulationState,
    connId: string
  ): { running: boolean; effectiveSpeed: number; ratedHead: number } | undefined {
    for (const [, pump] of state.components.pumps) {
      if (pump.connectedFlowPath === connId) {
        return pump;
      }
    }
    return undefined;
  }

  /**
   * Get maximum node mass (for relative convergence check).
   */
  private getMaxNodeMass(nodes: Map<string, FlowNode>): number {
    let maxMass = 0;
    for (const node of nodes.values()) {
      maxMass = Math.max(maxMass, node.fluid.mass);
    }
    return maxMass;
  }
}
