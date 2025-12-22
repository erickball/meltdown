/**
 * Heat Transfer Operators
 *
 * Handles conduction between solid nodes and convection between
 * solids and fluids. Uses explicit forward Euler integration.
 *
 * Physics:
 * - Conduction: Q = k * A / L * (T1 - T2)  [Fourier's law]
 * - Convection: Q = h * A * (T_solid - T_fluid)  [Newton's law of cooling]
 *
 * Energy Conservation:
 * - Solids: dT = Q * dt / (m * cp)
 * - Fluids: dU = Q * dt, then derive T, P, phase from (mass, energy, volume)
 *
 * The heat transfer coefficient h is computed from correlations
 * based on flow conditions.
 */

import { SimulationState, FlowNode, FluidState } from '../types';
import { PhysicsOperator, cloneSimulationState } from '../solver';
import * as Water from '../water-properties';

// ============================================================================
// Fluid State Debug Logging
// ============================================================================

// Use globalThis to ensure the debug state is shared across all module instances
// This is necessary because tsx/ESM may load the module multiple times
declare global {
  // eslint-disable-next-line no-var
  var __fluidStateDebugState: { enabled: boolean; count: number; MAX: number } | undefined;
}

// Initialize global debug state if not already present
if (!globalThis.__fluidStateDebugState) {
  globalThis.__fluidStateDebugState = {
    enabled: false,
    count: 0,
    MAX: 500
  };
}

// Reference to global state for convenience
const FluidStateDebugState = globalThis.__fluidStateDebugState;

/**
 * Enable/disable detailed fluid state update debugging.
 * When enabled, logs BFS pressure propagation and pressure calculations.
 */
export function enableFluidStateDebug(enabled: boolean, reset: boolean = true): void {
  const wasEnabled = FluidStateDebugState.enabled;
  FluidStateDebugState.enabled = enabled;
  // Only reset counter if explicitly requested or if newly enabling
  if (reset || (!wasEnabled && enabled)) {
    FluidStateDebugState.count = 0;
  }
  if (enabled && !wasEnabled) {
    console.log('[FluidStateDebug] Debug logging ENABLED - will log next', FluidStateDebugState.MAX, 'fluid state updates');
  }
}

// ============================================================================
// Conduction Operator - Heat transfer between solid nodes
// ============================================================================

export class ConductionOperator implements PhysicsOperator {
  name = 'Conduction';

  apply(state: SimulationState, dt: number): SimulationState {
    const newState = cloneSimulationState(state);

    // For each thermal connection, compute heat flow and update temperatures
    for (const conn of state.thermalConnections) {
      const node1 = newState.thermalNodes.get(conn.fromNodeId);
      const node2 = newState.thermalNodes.get(conn.toNodeId);

      if (!node1 || !node2) continue;

      // Heat flow from node1 to node2 (positive if T1 > T2)
      // Q = conductance * (T1 - T2)
      const Q = conn.conductance * (node1.temperature - node2.temperature);

      // Temperature changes: dT = Q * dt / (m * cp)
      const dT1 = -Q * dt / (node1.mass * node1.specificHeat);
      const dT2 = Q * dt / (node2.mass * node2.specificHeat);

      node1.temperature += dT1;
      node2.temperature += dT2;
    }

    return newState;
  }

  getMaxStableDt(state: SimulationState): number {
    // Stability criterion for explicit heat conduction:
    // dt < (m * cp) / (2 * sum of conductances to node)

    let minDt = Infinity;

    // Build map of total conductance per node
    const totalConductance = new Map<string, number>();

    for (const conn of state.thermalConnections) {
      totalConductance.set(
        conn.fromNodeId,
        (totalConductance.get(conn.fromNodeId) ?? 0) + conn.conductance
      );
      totalConductance.set(
        conn.toNodeId,
        (totalConductance.get(conn.toNodeId) ?? 0) + conn.conductance
      );
    }

    for (const [nodeId, G] of totalConductance) {
      const node = state.thermalNodes.get(nodeId);
      if (!node || G === 0) continue;

      const thermalMass = node.mass * node.specificHeat;
      const maxDt = thermalMass / (2 * G);

      if (maxDt < minDt) {
        minDt = maxDt;
      }
    }

    return minDt;
  }
}

// ============================================================================
// Convection Operator - Heat transfer between solids and fluids
// ============================================================================

export class ConvectionOperator implements PhysicsOperator {
  name = 'Convection';

  // Cache for getMaxStableDt to avoid recomputing every solver iteration
  // Invalidated when state changes (detected by checking a hash of key values)
  private cachedMaxDt: number = Infinity;
  private lastStateHash: string = '';

  apply(state: SimulationState, dt: number): SimulationState {
    const newState = cloneSimulationState(state);
    // Invalidate dt cache since state is changing
    this.lastStateHash = '';

    // Initialize energy diagnostics if not present
    if (!newState.energyDiagnostics) {
      newState.energyDiagnostics = {
        totalFluidEnergy: 0,
        totalSolidEnergy: 0,
        heatTransferRates: new Map(),
        fuelToCoreCoolant: 0,
        coreCoolantToSG: 0,
        sgToSecondary: 0,
        heatGenerationTotal: 0,
        advectedEnergy: 0,
      };
    }

    for (const conn of state.convectionConnections) {
      const thermalNode = newState.thermalNodes.get(conn.thermalNodeId);
      const flowNode = newState.flowNodes.get(conn.flowNodeId);

      if (!thermalNode || !flowNode) continue;

      // Compute heat transfer coefficient based on flow conditions
      const h = computeHeatTransferCoeff(flowNode, state);

      // Heat flow from solid to fluid (positive if T_solid > T_fluid)
      const Q = h * conn.surfaceArea * (thermalNode.temperature - flowNode.fluid.temperature);

      // Store heat transfer rate for diagnostics
      newState.energyDiagnostics.heatTransferRates.set(conn.id, Q);

      // Track specific heat flows for display
      if (conn.thermalNodeId === 'fuel' && conn.flowNodeId === 'core-coolant') {
        newState.energyDiagnostics.fuelToCoreCoolant = Q;
      }
      if (conn.thermalNodeId === 'sg-tubes' && conn.flowNodeId === 'sg-primary') {
        newState.energyDiagnostics.coreCoolantToSG = -Q; // Negative because heat flows OUT of primary
      }

      // Energy transferred in this timestep
      const energyTransferred = Q * dt;

      // Update solid temperature (solids still use simple T equation)
      const dT_solid = -energyTransferred / (thermalNode.mass * thermalNode.specificHeat);
      thermalNode.temperature += dT_solid;

      // Update fluid using energy-based approach
      // Add energy to fluid's internal energy, then recalculate state
      const newFluidEnergy = flowNode.fluid.internalEnergy + energyTransferred;
      const newState_water = Water.calculateState(
        flowNode.fluid.mass,
        newFluidEnergy,
        flowNode.volume
      );

      // Update fluid state with derived quantities
      // NOTE: We deliberately do NOT update pressure here. Pressure is handled by
      // FluidStateUpdateOperator using the hybrid model (P_base + feedback).
      // Setting pressure here from raw Water.calculateState() would overwrite the
      // correct hybrid pressures, causing FlowOperator to see wrong values.
      flowNode.fluid.internalEnergy = newFluidEnergy;
      flowNode.fluid.temperature = newState_water.temperature;
      // flowNode.fluid.pressure - left unchanged, will be set by FluidStateUpdateOperator
      flowNode.fluid.phase = newState_water.phase;
      flowNode.fluid.quality = newState_water.quality;
    }

    // Update total energy diagnostics
    let totalFluidEnergy = 0;
    let totalSolidEnergy = 0;
    for (const [, node] of newState.flowNodes) {
      totalFluidEnergy += node.fluid.internalEnergy;
    }
    for (const [, node] of newState.thermalNodes) {
      totalSolidEnergy += node.mass * node.specificHeat * node.temperature;
    }
    newState.energyDiagnostics.totalFluidEnergy = totalFluidEnergy;
    newState.energyDiagnostics.totalSolidEnergy = totalSolidEnergy;
    newState.energyDiagnostics.heatGenerationTotal = state.neutronics.power;

    return newState;
  }

  getMaxStableDt(state: SimulationState): number {
    // Stability criterion for convection
    // For solids: dt < (m * cp) / (2 * h * A)
    // For fluids: dt < (m * cv_eff) / (2 * h * A)
    // Also consider water properties stability

    // Check cache - compute a simple hash of state to detect changes
    // We only need to recompute when masses/energies change significantly
    const stateHash = this.computeStateHash(state);
    if (stateHash === this.lastStateHash && this.cachedMaxDt < Infinity) {
      return this.cachedMaxDt;
    }

    let minDt = Infinity;
    const warnings: string[] = [];

    for (const conn of state.convectionConnections) {
      const thermalNode = state.thermalNodes.get(conn.thermalNodeId);
      const flowNode = state.flowNodes.get(conn.flowNodeId);

      if (!thermalNode || !flowNode) continue;

      const h = computeHeatTransferCoeff(flowNode, state);
      if (h === 0) continue;

      const hA = h * conn.surfaceArea;

      // Solid constraint
      const solidThermalMass = thermalNode.mass * thermalNode.specificHeat;
      const dtSolid = solidThermalMass / (2 * hA);

      // Fluid constraint using effective specific heat
      const waterState = Water.calculateState(
        flowNode.fluid.mass,
        flowNode.fluid.internalEnergy,
        flowNode.volume
      );
      const cv_eff = Water.effectiveSpecificHeat(waterState);
      const fluidThermalMass = flowNode.fluid.mass * cv_eff;
      const dtFluid = fluidThermalMass / (2 * hA);

      // Also check water properties stability
      const stability = Water.analyzeStability(waterState, flowNode.volume);
      const dtWater = stability.characteristicTime * 0.5;

      // Collect warnings
      if (stability.warnings.length > 0) {
        warnings.push(`${flowNode.id}: ${stability.warnings.join(', ')}`);
      }

      const dtLimit = Math.min(dtSolid, dtFluid, dtWater);

      // Log if timestep is becoming very small (rate-limited to avoid spam)
      // Only log once per node per 1000 calls
      if (dtLimit < 0.001 && Math.random() < 0.001) {
        console.warn(`[Convection] Very small timestep for ${flowNode.id}: ${dtLimit.toFixed(6)}s (Solid: ${dtSolid.toFixed(6)}s, Fluid: ${dtFluid.toFixed(6)}s, Water: ${dtWater.toFixed(6)}s)`);
      }

      if (dtLimit < minDt) {
        minDt = dtLimit;
      }
    }

    // Report any stability warnings
    if (warnings.length > 0 && Math.random() < 0.01) { // Don't spam console
      console.warn('[Convection] Stability warnings:', warnings);
    }

    // Cache the result
    this.cachedMaxDt = minDt;
    this.lastStateHash = stateHash;

    return minDt;
  }

  /**
   * Compute a simple hash of state values that affect dt calculation.
   * We use quantized values to avoid recomputing on tiny changes.
   */
  private computeStateHash(state: SimulationState): string {
    // Hash based on quantized masses and energies of flow nodes
    // Only changes when values change by more than ~1%
    const parts: string[] = [];
    for (const conn of state.convectionConnections) {
      const flowNode = state.flowNodes.get(conn.flowNodeId);
      if (flowNode) {
        // Quantize to 2 significant figures for coarse change detection
        const qMass = flowNode.fluid.mass.toPrecision(2);
        const qEnergy = flowNode.fluid.internalEnergy.toPrecision(2);
        parts.push(`${conn.flowNodeId}:${qMass}:${qEnergy}`);
      }
    }
    return parts.join('|');
  }
}

// ============================================================================
// Heat Generation Operator - Applies internal heat sources
// ============================================================================

export class HeatGenerationOperator implements PhysicsOperator {
  name = 'HeatGeneration';

  apply(state: SimulationState, dt: number): SimulationState {
    const newState = cloneSimulationState(state);

    for (const [, node] of newState.thermalNodes) {
      if (node.heatGeneration === 0) continue;

      // dT = Q * dt / (m * cp)
      const dT = node.heatGeneration * dt / (node.mass * node.specificHeat);
      node.temperature += dT;
    }

    return newState;
  }

  getMaxStableDt(_state: SimulationState): number {
    // Heat generation alone doesn't have a stability constraint
    // (it's a source term, not a diffusion term)
    return Infinity;
  }
}

// ============================================================================
// Fluid State Update Operator - Ensures consistency after all operations
// ============================================================================

export class FluidStateUpdateOperator implements PhysicsOperator {
  name = 'FluidStateUpdate';

  // Cache for getMaxStableDt to avoid recomputing every solver iteration
  private cachedMaxDt: number = Infinity;
  private lastStateHash: string = '';

  apply(state: SimulationState, _dt: number): SimulationState {
    // Invalidate dt cache since state is changing
    this.lastStateHash = '';
    const newState = cloneSimulationState(state);

    // First pass: calculate state for all nodes using steam tables
    // This determines temperature and initial phase/pressure estimates
    const nodeStates = new Map<string, {
      waterState: ReturnType<typeof Water.calculateState>;
      finalPhase: 'liquid' | 'two-phase' | 'vapor';
    }>();

    for (const [, flowNode] of newState.flowNodes) {
      const waterState = Water.calculateState(
        flowNode.fluid.mass,
        flowNode.fluid.internalEnergy,
        flowNode.volume
      );

      nodeStates.set(flowNode.id, { waterState, finalPhase: waterState.phase });
    }

    // Build connectivity map from flow connections
    // Also track which connection links each pair of nodes, and the direction
    const connections = new Map<string, Set<string>>();
    const connectionMap = new Map<string, { conn: typeof state.flowConnections[0]; forward: boolean }>();

    for (const conn of state.flowConnections) {
      if (!connections.has(conn.fromNodeId)) {
        connections.set(conn.fromNodeId, new Set());
      }
      if (!connections.has(conn.toNodeId)) {
        connections.set(conn.toNodeId, new Set());
      }
      connections.get(conn.fromNodeId)!.add(conn.toNodeId);
      connections.get(conn.toNodeId)!.add(conn.fromNodeId);

      // Store connection info for each direction
      // Key format: "fromNode->toNode"
      connectionMap.set(`${conn.fromNodeId}->${conn.toNodeId}`, { conn, forward: true });
      connectionMap.set(`${conn.toNodeId}->${conn.fromNodeId}`, { conn, forward: false });
    }

    // Build pump map for quick lookup
    const pumpsByConnection = new Map<string, typeof state.components.pumps extends Map<string, infer V> ? V : never>();
    for (const [, pump] of state.components.pumps) {
      pumpsByConnection.set(pump.connectedFlowPath, pump);
    }

    // Find all two-phase nodes - these are pressure-setting nodes
    const twoPhaseNodes: string[] = [];
    for (const [nodeId, { finalPhase }] of nodeStates) {
      if (finalPhase === 'two-phase') {
        twoPhaseNodes.push(nodeId);
      }
    }

    // DEBUG: Log two-phase nodes found
    if (FluidStateDebugState.enabled) {
      // Always log this basic info when debug is enabled (ignore counter for this)
      if (FluidStateDebugState.count < FluidStateDebugState.MAX) {
        console.log(`[FluidStateDebug #${FluidStateDebugState.count}] Two-phase nodes: ${twoPhaseNodes.join(', ') || 'NONE'}`);
        for (const id of twoPhaseNodes) {
          const { waterState } = nodeStates.get(id)!;
          console.log(`  ${id}: P_sat=${(waterState.pressure/1e5).toFixed(2)}bar, T=${(waterState.temperature-273.15).toFixed(1)}°C, x=${(waterState.quality*100).toFixed(1)}%`);
        }
      } else if (FluidStateDebugState.count === FluidStateDebugState.MAX) {
        console.log(`[FluidStateDebug] Reached max debug count (${FluidStateDebugState.MAX}), suppressing further output`);
      }
    }

    // Propagate pressure from two-phase nodes to connected liquid nodes
    // Each liquid node gets pressure from nearest two-phase node (with hydrostatic adjustment)
    const liquidPressures = new Map<string, number>();
    const pressureSource = new Map<string, string>(); // Track where P_base came from

    // BFS from each two-phase node to find connected liquid nodes
    for (const twoPhaseId of twoPhaseNodes) {
      const { waterState } = nodeStates.get(twoPhaseId)!;

      const visited = new Set<string>();
      const queue: Array<{ nodeId: string; pressure: number; path: string[] }> = [{
        nodeId: twoPhaseId,
        pressure: waterState.pressure,
        path: [twoPhaseId]
      }];

      while (queue.length > 0) {
        const { nodeId, pressure, path } = queue.shift()!;
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const { finalPhase } = nodeStates.get(nodeId)!;
        const node = newState.flowNodes.get(nodeId)!;

        if (finalPhase === 'liquid' || nodeId === twoPhaseId) {
          // Set pressure for this liquid node (or record the two-phase source)
          if (!liquidPressures.has(nodeId) || nodeId === twoPhaseId) {
            liquidPressures.set(nodeId, pressure);
            pressureSource.set(nodeId, path.join(' -> '));
          }

          // Propagate to connected nodes
          const neighbors = connections.get(nodeId) || new Set();
          for (const neighborId of neighbors) {
            if (visited.has(neighborId)) continue;

            const neighborNode = newState.flowNodes.get(neighborId);
            const neighborState = nodeStates.get(neighborId);
            if (!neighborNode || !neighborState) continue;

            // Only propagate to liquid nodes
            if (neighborState.finalPhase !== 'liquid') continue;

            // Calculate pressure with hydrostatic adjustment
            const elevationDiff = neighborNode.elevation - node.elevation;
            const rho = node.fluid.mass / node.volume;
            const hydrostaticAdj = rho * 9.81 * elevationDiff;

            // Check for pump on this connection and adjust pressure accordingly
            // Pump adds head in the forward direction (from -> to)
            // When propagating pressure backwards through a pump, we subtract the pump head
            const connKey = `${nodeId}->${neighborId}`;
            const connInfo = connectionMap.get(connKey);
            let pumpAdj = 0;
            if (connInfo) {
              const pump = pumpsByConnection.get(connInfo.conn.id);
              if (pump && pump.effectiveSpeed > 0) {
                // Pump head should use the density of the fluid being pumped (upstream node
                // based on actual flow direction), not the BFS traversal direction.
                // The connection's massFlowRate tells us the actual flow direction:
                // positive = from -> to, negative = to -> from
                const conn = connInfo.conn;
                const flowIsForward = conn.massFlowRate >= 0;
                const pumpUpstreamId = flowIsForward ? conn.fromNodeId : conn.toNodeId;
                const pumpUpstreamNode = newState.flowNodes.get(pumpUpstreamId);
                const pumpRho = pumpUpstreamNode
                  ? pumpUpstreamNode.fluid.mass / pumpUpstreamNode.volume
                  : rho;  // fallback to current node density

                // Pump head in pressure units: ΔP = ρ * g * H
                // effectiveSpeed is maintained by FlowOperator.updatePumpSpeeds()
                const pumpHead = pump.effectiveSpeed * pump.ratedHead * pumpRho * 9.81;
                // If propagating in the forward direction (same as pump flow), pressure increases
                // If propagating backwards (against pump flow), pressure decreases
                // BFS propagates from two-phase source, so:
                // - If pump pushes toward the source, going away from source means going against pump → subtract
                // - If pump pushes away from source, going away from source means going with pump → add
                // The pump is on the connection and pushes from conn.fromNodeId to conn.toNodeId
                // We're going from nodeId to neighborId
                // If forward (nodeId = from, neighbor = to), we're going with pump flow
                // If backward (nodeId = to, neighbor = from), we're going against pump flow
                if (connInfo.forward) {
                  // Going in pump direction: pressure would increase (pump adds energy)
                  // But we're propagating P_base, so downstream of pump has higher P_base
                  pumpAdj = pumpHead;
                } else {
                  // Going against pump direction: pressure would decrease
                  pumpAdj = -pumpHead;
                }
              }
            }

            const neighborPressure = pressure - hydrostaticAdj + pumpAdj;

            // DEBUG: Log BFS propagation
            // Always log feedwater to debug flow reversal issue
            if (neighborId === 'feedwater' || (FluidStateDebugState.enabled && FluidStateDebugState.count < FluidStateDebugState.MAX)) {
              const pumpStr = pumpAdj !== 0 ? `, pump=${(pumpAdj/1e5).toFixed(2)}bar` : '';
              console.log(`[FluidStateDebug] BFS: ${nodeId} -> ${neighborId}: elev=${elevationDiff.toFixed(1)}m, ρ=${rho.toFixed(0)}, hydro=${(hydrostaticAdj/1e5).toFixed(3)}bar${pumpStr}, P_base=${(neighborPressure/1e5).toFixed(2)}bar`);
              // Log pump details if this connection has a pump and goes to feedwater
              if (connInfo && pumpAdj !== 0 && neighborId === 'feedwater') {
                const pump = pumpsByConnection.get(connInfo.conn.id);
                if (pump) {
                  const flowIsForward = connInfo.conn.massFlowRate >= 0;
                  const pumpUpstreamId = flowIsForward ? connInfo.conn.fromNodeId : connInfo.conn.toNodeId;
                  const pumpUpstreamNode = newState.flowNodes.get(pumpUpstreamId);
                  const pumpRho = pumpUpstreamNode ? pumpUpstreamNode.fluid.mass / pumpUpstreamNode.volume : rho;
                  console.log(`  pump details: effectiveSpeed=${pump.effectiveSpeed.toFixed(3)}, flowDir=${flowIsForward ? 'forward' : 'reverse'}, pumpRho=${pumpRho.toFixed(0)}`);
                }
              }
            }

            queue.push({ nodeId: neighborId, pressure: neighborPressure, path: [...path, neighborId] });
          }
        }
      }
    }

    // DEBUG: Log final P_base assignments
    // Always log feedwater to debug flow reversal issue
    if (FluidStateDebugState.enabled && FluidStateDebugState.count < FluidStateDebugState.MAX) {
      console.log(`[FluidStateDebug] P_base assignments:`);
      for (const [nodeId, P_base] of liquidPressures) {
        const source = pressureSource.get(nodeId) || 'unknown';
        console.log(`  ${nodeId}: P_base=${(P_base/1e5).toFixed(2)}bar via ${source}`);
      }
    } else if (liquidPressures.has('feedwater')) {
      // Even if debug is disabled, always log feedwater P_base
      const P_base = liquidPressures.get('feedwater')!;
      const source = pressureSource.get('feedwater') || 'unknown';
      console.log(`[FluidStateDebug] feedwater: P_base=${(P_base/1e5).toFixed(2)}bar via ${source}`);
    }

    // Second pass: apply states with proper pressure handling
    for (const [nodeId, flowNode] of newState.flowNodes) {
      const { waterState, finalPhase } = nodeStates.get(nodeId)!;

      // Check for numerical issues (only log serious warnings)
      const stability = Water.analyzeStability(waterState, flowNode.volume);
      if (stability.warnings.length > 0) {
        for (const warning of stability.warnings) {
          if (warning.includes('near condensation') ||
              warning.includes('near superheat') ||
              warning.includes('outside expected range') ||
              warning.includes('Near saturation')) {
            continue;
          }
          console.warn(`[FluidStateUpdate] ${nodeId}: ${warning}`);
        }
      }

      // Update temperature and phase from steam tables
      flowNode.fluid.temperature = waterState.temperature;
      flowNode.fluid.phase = finalPhase;
      flowNode.fluid.quality = waterState.quality;

      // Determine pressure based on phase and connectivity
      if (finalPhase === 'two-phase') {
        // Two-phase: pressure is determined by saturation (steam tables)
        flowNode.fluid.pressure = waterState.pressure;
      } else if (finalPhase === 'vapor') {
        // Vapor: use steam table pressure (ideal gas-like behavior)
        flowNode.fluid.pressure = waterState.pressure;
      } else {
        // LIQUID: Hybrid pressure model
        // P = P_base + K * (ρ - ρ_expected) / ρ_expected
        //
        // Where ρ_expected is the density of compressed liquid at the current
        // temperature T and the base pressure P_base. This accounts for thermal
        // expansion: as fluid heats up and expands, ρ_expected decreases, so
        // there's no spurious pressure rise from expansion alone.
        //
        // We use temperature-dependent bulk modulus via Water.bulkModulus(T_C).
        // This varies from ~2200 MPa at 50°C to ~60 MPa at 350°C, which is
        // physically accurate - water becomes much more compressible near the
        // critical point.

        const rho = flowNode.fluid.mass / flowNode.volume;
        const T = waterState.temperature;
        const T_C = T - 273.15;

        // Guard against zero/near-zero mass (node has drained)
        // In this case, just use saturation pressure at the current temperature
        if (flowNode.fluid.mass < 0.01 || !isFinite(rho) || rho < 0.01) {
          flowNode.fluid.pressure = Water.saturationPressure(T);
          if (Math.random() < 0.001) {
            console.warn(`[FluidState] ${nodeId}: Near-zero mass (${flowNode.fluid.mass.toFixed(3)} kg), using P_sat`);
          }
          continue;  // Skip the rest of the liquid pressure calculation
        }

        // Temperature-dependent bulk modulus
        const K = Water.bulkModulus(T_C);

        if (liquidPressures.has(nodeId)) {
          // Connected to two-phase - use base pressure + local deviation
          const P_base = liquidPressures.get(nodeId)!;

          // Expected density from steam table interpolation at (P_base, u)
          // This uses actual compressed liquid data rather than saturation approximation
          const u_specific = flowNode.fluid.internalEnergy / flowNode.fluid.mass;  // J/kg
          const v_specific = flowNode.volume / flowNode.fluid.mass;  // m³/kg

          const rho_table = Water.lookupCompressedLiquidDensity(P_base, u_specific);

          // Fallback to saturation-based calculation if outside interpolation domain
          const rho_sat = Water.saturatedLiquidDensity(T);
          const P_sat = Water.saturationPressure(T);
          let rho_expected: number;
          let usedTableLookup = false;

          if (rho_table !== null) {
            // Use steam table interpolated density
            rho_expected = rho_table;
            usedTableLookup = true;
          } else {
            // Fallback: saturation + bulk modulus adjustment
            const dP_compression_base = Math.max(0, P_base - P_sat);
            rho_expected = rho_sat * (1 + dP_compression_base / K);
          }

          // Pressure deviation from mass accumulation/depletion
          const densityRatio = (rho - rho_expected) / rho_expected;
          const dP = K * densityRatio;

          let P_feedback = P_base + dP;

          // Floor: liquid pressure cannot be below saturation pressure at this temperature
          // This enforces the thermodynamic constraint that subcooled liquid P >= P_sat(T)
          P_feedback = Math.max(P_feedback, P_sat);

          // Near the liquid/supercritical boundary (u > 1750 kJ/kg), the bulk modulus
          // model diverges from true thermodynamics. Blend toward triangulation lookup
          // to ensure smooth transition when crossing the 1800 kJ/kg boundary.
          const u_kJkg = u_specific / 1000;
          const U_BLEND_START = 1750;  // Start blending at this u (kJ/kg)
          const U_BLEND_END = 1800;    // Full triangulation at this u (kJ/kg)

          if (u_kJkg > U_BLEND_START) {
            const P_triangulation = Water.lookupPressureFromUV(u_specific, v_specific);
            if (P_triangulation !== null) {
              const blend = Math.min(1, (u_kJkg - U_BLEND_START) / (U_BLEND_END - U_BLEND_START));
              flowNode.fluid.pressure = (1 - blend) * P_feedback + blend * P_triangulation;
            } else {
              flowNode.fluid.pressure = P_feedback;
            }
          } else {
            flowNode.fluid.pressure = P_feedback;
          }

          // DEBUG: Log full pressure calculation for connected liquid
          if (FluidStateDebugState.enabled && FluidStateDebugState.count < FluidStateDebugState.MAX) {
            console.log(`[FluidStateDebug] ${nodeId} (connected liquid):`);
            console.log(`  T=${(T-273.15).toFixed(1)}°C, ρ=${rho.toFixed(1)}, P_base=${(P_base/1e5).toFixed(2)}bar, K=${(K/1e6).toFixed(0)}MPa`);
            console.log(`  u=${(u_specific/1000).toFixed(1)}kJ/kg, ρ_table=${rho_table?.toFixed(1) ?? 'null'}, used_table=${usedTableLookup}`);
            console.log(`  ρ_sat=${rho_sat.toFixed(1)}, P_sat=${(P_sat/1e5).toFixed(2)}bar`);
            console.log(`  ρ_expected=${rho_expected.toFixed(1)}, ratio=${(densityRatio*100).toFixed(2)}%, dP=${(dP/1e5).toFixed(2)}bar`);
            console.log(`  P_final=${(flowNode.fluid.pressure/1e5).toFixed(2)}bar`);
          }

          // Debug: log when large mass accumulation is detected
          if (Math.abs(densityRatio) > 0.1 && Math.random() < 0.01) {
            console.log(`[FluidState] ${nodeId}: ρ=${rho.toFixed(0)}, ρ_expected=${rho_expected.toFixed(0)} (table=${usedTableLookup}), ratio=${(densityRatio*100).toFixed(1)}%, dP=${(dP/1e5).toFixed(1)}bar`);
          }
        } else {
          // Isolated liquid region - use saturation pressure + compression
          const rho_sat = Water.saturatedLiquidDensity(T);
          const P_sat = Water.saturationPressure(T);
          // For isolated region, expected density is just saturation density
          const densityRatio = (rho - rho_sat) / rho_sat;
          const dP_compression = K * densityRatio;
          flowNode.fluid.pressure = P_sat + Math.max(0, dP_compression);

          // DEBUG: Log isolated liquid calculation
          if (FluidStateDebugState.enabled && FluidStateDebugState.count < FluidStateDebugState.MAX) {
            console.log(`[FluidStateDebug] ${nodeId} (ISOLATED liquid - no P_base!):`);
            console.log(`  T=${(T-273.15).toFixed(1)}°C, ρ=${rho.toFixed(1)}, K=${(K/1e6).toFixed(0)}MPa`);
            console.log(`  ρ_sat=${rho_sat.toFixed(1)}, P_sat=${(P_sat/1e5).toFixed(2)}bar`);
            console.log(`  ratio=${(densityRatio*100).toFixed(2)}%, dP=${(dP_compression/1e5).toFixed(2)}bar`);
            console.log(`  P_final=${(flowNode.fluid.pressure/1e5).toFixed(2)}bar`);
          }
        }
      }

      // Sanity clamp on pressure
      flowNode.fluid.pressure = Math.max(1000, Math.min(flowNode.fluid.pressure, 100e6));
    }

    // Increment debug counter
    if (FluidStateDebugState.enabled && FluidStateDebugState.count < FluidStateDebugState.MAX) {
      FluidStateDebugState.count++;
      console.log(`[FluidStateDebug] --- End of fluid state update ${FluidStateDebugState.count}/${FluidStateDebugState.MAX} ---\n`);
    }

    // Store base pressures in state for debugging (used by debug panel)
    newState.liquidBasePressures = liquidPressures;

    return newState;
  }

  getMaxStableDt(state: SimulationState): number {
    // This operator doesn't have its own stability constraint
    // but we check the overall fluid state stability

    // Check cache - only recompute when state changes significantly
    const stateHash = this.computeStateHash(state);
    if (stateHash === this.lastStateHash && this.cachedMaxDt < Infinity) {
      return this.cachedMaxDt;
    }

    let minDt = Infinity;

    for (const [, flowNode] of state.flowNodes) {
      const waterState = Water.calculateState(
        flowNode.fluid.mass,
        flowNode.fluid.internalEnergy,
        flowNode.volume
      );
      const suggestedDt = Water.suggestMaxTimestep(waterState, flowNode.volume);
      if (suggestedDt < minDt) {
        minDt = suggestedDt;
      }
    }

    // Cache the result
    this.cachedMaxDt = minDt;
    this.lastStateHash = stateHash;

    return minDt;
  }

  /**
   * Compute a simple hash of state values that affect dt calculation.
   */
  private computeStateHash(state: SimulationState): string {
    const parts: string[] = [];
    for (const [id, flowNode] of state.flowNodes) {
      // Quantize to 2 significant figures for coarse change detection
      const qMass = flowNode.fluid.mass.toPrecision(2);
      const qEnergy = flowNode.fluid.internalEnergy.toPrecision(2);
      parts.push(`${id}:${qMass}:${qEnergy}`);
    }
    return parts.join('|');
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Compute convective heat transfer coefficient (W/m²-K)
 *
 * Uses Dittus-Boelter correlation for turbulent flow:
 *   Nu = 0.023 * Re^0.8 * Pr^n
 *   h = Nu * k / D
 *
 * For natural convection or low flow, uses a minimum value.
 */
function computeHeatTransferCoeff(flowNode: FlowNode, state: SimulationState): number {
  const fluid = flowNode.fluid;

  // Get flow rate through this node (simplified - sum of connected flows)
  let totalMassFlow = 0;
  for (const conn of state.flowConnections) {
    if (conn.fromNodeId === flowNode.id || conn.toNodeId === flowNode.id) {
      totalMassFlow += Math.abs(conn.massFlowRate);
    }
  }

  // Fluid properties (simplified - should use steam tables)
  const { k, mu, Pr, rho } = getFluidProperties(fluid);

  const D = flowNode.hydraulicDiameter;
  const A = flowNode.flowArea;

  // Velocity from mass flow
  const velocity = totalMassFlow / (rho * A);

  // Reynolds number
  const Re = rho * velocity * D / mu;

  // Minimum h for natural convection (rough estimate)
  const h_natural = 500; // W/m²-K - typical for water natural convection

  if (Re < 2300) {
    // Laminar or natural convection regime
    return h_natural;
  }

  // Turbulent: Dittus-Boelter correlation
  // n = 0.4 for heating, 0.3 for cooling - use 0.4 as default
  const Nu = 0.023 * Math.pow(Re, 0.8) * Math.pow(Pr, 0.4);
  const h_forced = Nu * k / D;

  return Math.max(h_forced, h_natural);
}

/**
 * Get fluid transport properties (simplified)
 * In a full implementation, this would use steam tables
 */
function getFluidProperties(fluid: FluidState): {
  k: number;    // Thermal conductivity W/m-K
  mu: number;   // Dynamic viscosity Pa-s
  Pr: number;   // Prandtl number
  rho: number;  // Density kg/m³
} {
  // Calculate density from mass and assume we have access to volume
  // For now, use simplified correlations based on phase

  if (fluid.phase === 'liquid') {
    // Subcooled or saturated water
    // Properties vary with temperature, but use representative values
    const rho = Water.saturatedLiquidDensity(fluid.temperature);
    return {
      k: 0.6,       // W/m-K (water at ~100°C)
      mu: 0.0003,   // Pa-s
      Pr: 2.0,      // dimensionless
      rho,
    };
  } else if (fluid.phase === 'vapor') {
    // Steam
    const rho = Water.saturatedVaporDensity(fluid.temperature);
    return {
      k: 0.03,      // W/m-K (steam)
      mu: 0.00002,  // Pa-s
      Pr: 1.0,
      rho,
    };
  } else {
    // Two-phase - interpolate by quality
    const q = fluid.quality;
    const rho_f = Water.saturatedLiquidDensity(fluid.temperature);
    const rho_g = Water.saturatedVaporDensity(fluid.temperature);
    const rho = 1 / (q / rho_g + (1 - q) / rho_f);

    return {
      k: 0.6 * (1 - q) + 0.03 * q,
      mu: 0.0003 * (1 - q) + 0.00002 * q,
      Pr: 2.0 * (1 - q) + 1.0 * q,
      rho,
    };
  }
}

/**
 * Get fluid specific heat (J/kg-K)
 * Now uses water properties module
 */
export function getFluidSpecificHeat(fluid: FluidState): number {
  if (fluid.phase === 'liquid') {
    return Water.liquidCv(fluid.temperature);
  } else if (fluid.phase === 'vapor') {
    return Water.vaporCv(fluid.temperature);
  } else {
    // Two-phase: use effective specific heat (very large due to latent heat)
    return Water.latentHeat(fluid.temperature) / 10;
  }
}

// ============================================================================
// Utility function to initialize fluid state from T, P, phase
// ============================================================================

/**
 * Create a FluidState from temperature, pressure, phase, and volume
 * Calculates mass and internal energy for the new energy-conserving formulation
 */
export function createFluidState(
  temperature: number,
  pressure: number,
  phase: 'liquid' | 'two-phase' | 'vapor',
  quality: number,
  volume: number
): FluidState {
  // Calculate density based on phase
  let density: number;

  if (phase === 'liquid') {
    // For compressed liquid, use steam table lookup to get the density that
    // corresponds exactly to this (P, u) point. This ensures dP_feedback = 0
    // at initialization, since the feedback model uses the same lookup.
    const u_specific = Water.energyFromTemperature(temperature, 'liquid', 0);
    const rho_table = Water.lookupCompressedLiquidDensity(pressure, u_specific);

    if (rho_table !== null) {
      // Use exact steam table density - this minimizes initial pressure feedback
      density = rho_table;
    } else {
      // Fallback to bulk modulus approximation if outside table range
      const rho_sat = Water.saturatedLiquidDensity(temperature);
      const P_sat = Water.saturationPressure(temperature);
      const T_C = temperature - 273.15;
      const K_physical = Water.bulkModulus(T_C);
      const dP = Math.max(0, pressure - P_sat);
      density = rho_sat * (1 + dP / K_physical);
    }
  } else if (phase === 'vapor') {
    // For vapor, use ideal gas with given pressure
    // ρ = P / (R * T), with R = 461.5 J/kg-K for water vapor
    const R_WATER = 461.5;
    density = pressure / (R_WATER * temperature);
  } else {
    // Two-phase mixture - pressure is locked to saturation
    const rho_f = Water.saturatedLiquidDensity(temperature);
    const rho_g = Water.saturatedVaporDensity(temperature);
    density = 1 / (quality / rho_g + (1 - quality) / rho_f);
  }

  const mass = density * volume;
  const specificEnergy = Water.energyFromTemperature(temperature, phase, quality);
  const internalEnergy = mass * specificEnergy;

  return {
    mass,
    internalEnergy,
    temperature,
    pressure,
    phase,
    quality,
  };
}
