/**
 * Fluid Flow Operator
 *
 * Handles mass and momentum balance for the flow network.
 * Uses a simplified quasi-steady momentum equation where flow
 * adjusts to balance pressure drops.
 *
 * Physics:
 * - Mass conservation: dm/dt = m_dot_in - m_dot_out
 * - Momentum (simplified): ΔP = K * (1/2) * ρ * v² + ρ * g * Δz
 * - Pump head: ΔP = ρ * g * H(Q)
 *
 * For stability, flow rates are updated gradually rather than
 * instantaneously to prevent oscillations.
 */

import { SimulationState, FlowNode, FlowConnection, PumpState, ValveState } from '../types';
import { PhysicsOperator, cloneSimulationState } from '../solver';
import * as Water from '../water-properties';

// ============================================================================
// Flow Operator
// ============================================================================

export class FlowOperator implements PhysicsOperator {
  name = 'FluidFlow';

  // Relaxation factor - how quickly flow adjusts (0-1)
  // Higher = faster response, but can cause oscillation
  // Lower value needed because:
  // 1. Explicit coupling between flow and pressure can oscillate
  // 2. Small volumes (like hot leg) are very sensitive to flow imbalance
  private relaxationFactor = 0.02; // Very low to prevent oscillation

  // Maximum flow rate to prevent runaway (kg/s)
  private maxFlowRate = 50000;

  // Cache for freshly computed pressures (computed once per apply() call)
  private freshPressures: Map<string, number> = new Map();

  apply(state: SimulationState, dt: number): SimulationState {
    const newState = cloneSimulationState(state);

    // CRITICAL FIX: Compute fresh pressures BEFORE calculating flows
    // The stored fluid.pressure values are stale (from end of last timestep).
    // We need to recompute pressures based on current mass/energy/volume
    // to get consistent flow calculations.
    this.freshPressures = this.computeFreshPressures(newState);

    // Update flow rates in each connection based on pressure balance
    for (const conn of newState.flowConnections) {
      const fromNode = newState.flowNodes.get(conn.fromNodeId);
      const toNode = newState.flowNodes.get(conn.toNodeId);

      if (!fromNode || !toNode) continue;

      // Compute target flow rate from momentum balance
      let targetFlow = this.computeTargetFlow(conn, fromNode, toNode, newState);

      // SAFEGUARD: Clamp target flow to reasonable range
      const unclamped = targetFlow;
      targetFlow = Math.max(-this.maxFlowRate, Math.min(this.maxFlowRate, targetFlow));

      // Debug: log when clamping happens (indicates pressure imbalance)
      if (Math.abs(unclamped) > this.maxFlowRate) {
        const P_from = fromNode.fluid.pressure / 1e5;
        const P_to = toNode.fluid.pressure / 1e5;
        console.warn(`[FlowOp] ${conn.id}: CLAMPED targetFlow from ${unclamped.toFixed(0)} to ${targetFlow.toFixed(0)} kg/s`);
        console.warn(`  Pressures: ${conn.fromNodeId}=${P_from.toFixed(2)}bar, ${conn.toNodeId}=${P_to.toFixed(2)}bar, dP=${(P_from-P_to).toFixed(2)}bar`);
      }

      // SAFEGUARD: Check for NaN
      if (!isFinite(targetFlow)) {
        console.warn('FlowOperator: Invalid target flow, keeping current');
        continue;
      }

      // Store target flow for debugging display
      conn.targetFlowRate = targetFlow;

      // Relax toward target (prevents oscillation)
      const flowChange = (targetFlow - conn.massFlowRate) * this.relaxationFactor;
      conn.massFlowRate += flowChange;

      // SAFEGUARD: Final clamp
      conn.massFlowRate = Math.max(-this.maxFlowRate, Math.min(this.maxFlowRate, conn.massFlowRate));
    }

    // MASS AND ENERGY CONSERVATION: Transfer mass and energy together
    // to ensure consistent specific energy during advection.
    this.transferMassConservatively(newState, dt);

    return newState;
  }

  /**
   * Transfer mass AND energy between nodes together.
   * This ensures conservation of both quantities and prevents
   * artificial heating from mismatched transfers.
   *
   * Key insight: We must calculate specific energy BEFORE removing mass,
   * then transfer both mass and energy together.
   */
  private transferMassConservatively(state: SimulationState, dt: number): void {
    // First pass: calculate what each connection will transfer
    // We need to know the specific energy of each upstream node BEFORE any transfers
    const transfers: Array<{
      upstreamId: string;
      downstreamId: string;
      mass: number;
      energy: number;
    }> = [];

    for (const conn of state.flowConnections) {
      if (Math.abs(conn.massFlowRate) < 0.1) continue; // Skip tiny flows

      const upstreamId = conn.massFlowRate > 0 ? conn.fromNodeId : conn.toNodeId;
      const downstreamId = conn.massFlowRate > 0 ? conn.toNodeId : conn.fromNodeId;

      const upstream = state.flowNodes.get(upstreamId);
      const downstream = state.flowNodes.get(downstreamId);
      if (!upstream || !downstream) continue;

      // Mass to transfer this timestep
      let massToMove = Math.abs(conn.massFlowRate) * dt;

      // Don't transfer more than 5% of upstream mass per timestep
      const maxTransfer = upstream.fluid.mass * 0.05;
      massToMove = Math.min(massToMove, maxTransfer);

      if (massToMove < 1e-6) continue; // Skip only truly negligible transfers

      // Calculate specific energy BEFORE any mass is removed
      // This is the key fix - we use the current (unchanged) upstream state
      const upstreamSpecificEnergy = upstream.fluid.internalEnergy / upstream.fluid.mass;

      // Energy carried by this mass
      const energyToMove = massToMove * upstreamSpecificEnergy;

      // Validate
      if (!isFinite(energyToMove) || !isFinite(massToMove)) continue;

      transfers.push({
        upstreamId,
        downstreamId,
        mass: massToMove,
        energy: energyToMove,
      });

    }

    // Second pass: apply all transfers
    for (const transfer of transfers) {
      const upstream = state.flowNodes.get(transfer.upstreamId);
      const downstream = state.flowNodes.get(transfer.downstreamId);
      if (!upstream || !downstream) continue;

      // Transfer mass
      upstream.fluid.mass -= transfer.mass;
      downstream.fluid.mass += transfer.mass;

      // Transfer energy (same proportion as mass)
      upstream.fluid.internalEnergy -= transfer.energy;
      downstream.fluid.internalEnergy += transfer.energy;

      // SAFEGUARD: Ensure non-negative values
      if (upstream.fluid.internalEnergy < 0) {
        // This shouldn't happen if we're transferring proportionally,
        // but clamp just in case
        downstream.fluid.internalEnergy += upstream.fluid.internalEnergy;
        upstream.fluid.internalEnergy = 0;
      }
    }

    // Third pass: enforce minimum mass
    for (const [, node] of state.flowNodes) {
      node.fluid.mass = Math.max(node.fluid.mass, 1);
    }

    // Debug: verify conservation
    let totalMass = 0;
    let totalEnergy = 0;
    for (const [, node] of state.flowNodes) {
      totalMass += node.fluid.mass;
      totalEnergy += node.fluid.internalEnergy;
    }
    (state as any)._totalFluidMass = totalMass;
    (state as any)._totalFluidEnergy = totalEnergy;
  }

  getMaxStableDt(state: SimulationState): number {
    // CFL-like condition for advection:
    // dt < volume / max_flow_rate
    //
    // This ensures fluid doesn't flow through a volume in less than one timestep

    let minDt = Infinity;

    for (const [, node] of state.flowNodes) {
      const totalInflow = Math.abs(this.computeNetMassFlow(node.id, state.flowConnections));
      if (totalInflow < 1) continue; // Skip near-zero flow

      // Time to replace the fluid in the node
      const residenceTime = node.fluid.mass / totalInflow;

      // Use fraction of residence time for stability
      const dtLimit = residenceTime * 0.5;

      if (dtLimit < minDt) {
        minDt = dtLimit;
      }
    }

    // SAFEGUARD: Floor at 1ms to prevent runaway timestep reduction
    return Math.max(minDt, 0.001);
  }

  /**
   * Compute the target (equilibrium) mass flow rate for a connection
   * based on the pressure drop and driving forces.
   */
  private computeTargetFlow(
    conn: FlowConnection,
    fromNode: FlowNode,
    toNode: FlowNode,
    state: SimulationState
  ): number {
    // CRITICAL FIX: Use freshly computed pressures, not stale stored values
    // The stored fluid.pressure values were computed at the END of the last
    // timestep based on the mass distribution at that time. But mass has
    // potentially changed since then (from other operators or previous
    // iterations), so we need fresh pressure values.
    const P_from = this.freshPressures.get(conn.fromNodeId) ?? fromNode.fluid.pressure;
    const P_to = this.freshPressures.get(conn.toNodeId) ?? toNode.fluid.pressure;

    // Base pressure difference (positive = from has higher pressure)
    // For liquid loops, this should be small (just friction losses)
    // The pressurizer sets the system pressure
    const dP_pressure = P_from - P_to;

    // Gravity head (positive = downward flow is favored)
    const rho = this.getFluidDensity(fromNode.fluid);
    const g = 9.81; // m/s²
    const dP_gravity = rho * g * conn.elevation;

    // Check for pump in this connection
    const pump = this.getPumpForConnection(conn.id, state);
    let dP_pump = 0;
    if (pump && pump.running) {
      // Pump adds head in flow direction
      // Simplified pump curve: head decreases with flow
      const Q = Math.abs(conn.massFlowRate) / rho; // Volumetric flow m³/s
      const Q_rated = pump.ratedFlow / rho;
      const headRatio = 1 - 0.5 * Math.pow(Q / Q_rated, 2); // Quadratic pump curve
      dP_pump = pump.speed * pump.ratedHead * headRatio * rho * g;
    }

    // Check for valve in this connection
    const valve = this.getValveForConnection(conn.id, state);
    let resistanceMult = 1.0;
    if (valve) {
      if (valve.position < 0.01) {
        // Valve closed - no flow
        return 0;
      }
      // Valve increases resistance as it closes
      // K_valve = K_open / position²
      resistanceMult = 1 / Math.pow(valve.position, 2);
    }

    // Total driving pressure
    const dP_driving = dP_pressure + dP_gravity + dP_pump;

    // Compute flow from pressure drop
    // ΔP = K * (1/2) * ρ * v²  =>  v = sqrt(2 * ΔP / (ρ * K))
    // m_dot = ρ * A * v

    const K = conn.resistanceCoeff * resistanceMult;
    if (K <= 0) return 0;

    const A = conn.flowArea;

    // Handle flow direction
    const sign = dP_driving >= 0 ? 1 : -1;
    const dP_abs = Math.abs(dP_driving);

    // Velocity from pressure drop
    const v = Math.sqrt(2 * dP_abs / (rho * K));

    // Mass flow rate
    const massFlow = sign * rho * A * v;

    return massFlow;
  }

  /**
   * Compute net mass flow rate into a node (positive = net inflow)
   */
  private computeNetMassFlow(nodeId: string, connections: FlowConnection[]): number {
    let netFlow = 0;

    for (const conn of connections) {
      if (conn.toNodeId === nodeId) {
        // Inflow (positive flow adds mass)
        netFlow += conn.massFlowRate;
      }
      if (conn.fromNodeId === nodeId) {
        // Outflow (positive flow removes mass)
        netFlow -= conn.massFlowRate;
      }
    }

    return netFlow;
  }

  /**
   * Get fluid density (simplified)
   */
  private getFluidDensity(fluid: { phase: string; pressure: number; temperature: number }): number {
    if (fluid.phase === 'liquid') {
      // Water density decreases with temperature
      // ρ ≈ 1000 - 0.5 * (T - 293) for rough approximation
      return Math.max(700, 1000 - 0.5 * (fluid.temperature - 293));
    } else if (fluid.phase === 'vapor') {
      // Ideal gas approximation: ρ = P * M / (R * T)
      // For steam: M ≈ 18 g/mol
      const R = 8.314; // J/mol-K
      const M = 0.018; // kg/mol
      return fluid.pressure * M / (R * fluid.temperature);
    } else {
      // Two-phase - use liquid density (conservative)
      return Math.max(700, 1000 - 0.5 * (fluid.temperature - 293));
    }
  }

  /**
   * Find pump affecting this connection
   */
  private getPumpForConnection(connId: string, state: SimulationState): PumpState | undefined {
    for (const [, pump] of state.components.pumps) {
      if (pump.connectedFlowPath === connId) {
        return pump;
      }
    }
    return undefined;
  }

  /**
   * Find valve affecting this connection
   */
  private getValveForConnection(connId: string, state: SimulationState): ValveState | undefined {
    for (const [, valve] of state.components.valves) {
      if (valve.connectedFlowPath === connId) {
        return valve;
      }
    }
    return undefined;
  }

  /**
   * Compute fresh pressures for all flow nodes based on current mass/energy/volume.
   *
   * This is CRITICAL for correct flow calculation. The stored fluid.pressure values
   * are stale - they were computed at the end of the previous timestep. Since mass
   * has been transferred by other operators, the actual pressure based on the current
   * density can be very different.
   *
   * This method uses the same hybrid pressure model as FluidStateUpdateOperator:
   * - Two-phase nodes: pressure = saturation pressure at current temperature
   * - Liquid nodes connected to two-phase: base pressure from two-phase + deviation
   * - Isolated liquid nodes: saturation pressure + compression term
   */
  private computeFreshPressures(state: SimulationState): Map<string, number> {
    const pressures = new Map<string, number>();

    // First pass: compute water state and identify two-phase nodes
    const waterStates = new Map<string, ReturnType<typeof Water.calculateState>>();
    const twoPhaseNodes: string[] = [];

    for (const [nodeId, flowNode] of state.flowNodes) {
      const waterState = Water.calculateState(
        flowNode.fluid.mass,
        flowNode.fluid.internalEnergy,
        flowNode.volume
      );
      waterStates.set(nodeId, waterState);

      if (waterState.phase === 'two-phase') {
        twoPhaseNodes.push(nodeId);
        // Two-phase pressure is saturation pressure
        pressures.set(nodeId, waterState.pressure);
      }
    }

    // Build connectivity map
    const connections = new Map<string, Set<string>>();
    for (const conn of state.flowConnections) {
      if (!connections.has(conn.fromNodeId)) {
        connections.set(conn.fromNodeId, new Set());
      }
      if (!connections.has(conn.toNodeId)) {
        connections.set(conn.toNodeId, new Set());
      }
      connections.get(conn.fromNodeId)!.add(conn.toNodeId);
      connections.get(conn.toNodeId)!.add(conn.fromNodeId);
    }

    // Propagate pressure from two-phase nodes to connected liquid nodes
    const liquidBasePressures = new Map<string, number>();

    for (const twoPhaseId of twoPhaseNodes) {
      const twoPhaseState = waterStates.get(twoPhaseId)!;

      const visited = new Set<string>();
      const queue: Array<{ nodeId: string; pressure: number }> = [{
        nodeId: twoPhaseId,
        pressure: twoPhaseState.pressure
      }];

      while (queue.length > 0) {
        const { nodeId, pressure } = queue.shift()!;
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const nodeWaterState = waterStates.get(nodeId)!;
        const node = state.flowNodes.get(nodeId)!;

        if (nodeWaterState.phase === 'liquid' || nodeId === twoPhaseId) {
          if (!liquidBasePressures.has(nodeId) || nodeId === twoPhaseId) {
            liquidBasePressures.set(nodeId, pressure);
          }

          // Propagate to connected nodes
          const neighbors = connections.get(nodeId) || new Set();
          for (const neighborId of neighbors) {
            if (visited.has(neighborId)) continue;

            const neighborNode = state.flowNodes.get(neighborId);
            const neighborState = waterStates.get(neighborId);
            if (!neighborNode || !neighborState) continue;

            // Only propagate to liquid nodes
            if (neighborState.phase !== 'liquid') continue;

            // Calculate pressure with hydrostatic adjustment
            const elevationDiff = neighborNode.elevation - node.elevation;
            const rho = node.fluid.mass / node.volume;
            const hydrostaticAdj = rho * 9.81 * elevationDiff;
            const neighborPressure = pressure - hydrostaticAdj;

            queue.push({ nodeId: neighborId, pressure: neighborPressure });
          }
        }
      }
    }

    // Second pass: compute final pressures for all nodes
    for (const [nodeId, flowNode] of state.flowNodes) {
      if (pressures.has(nodeId)) continue; // Already set (two-phase)

      const waterState = waterStates.get(nodeId)!;
      const rho = flowNode.fluid.mass / flowNode.volume;
      const T = waterState.temperature;

      if (waterState.phase === 'vapor') {
        // Vapor: use steam table pressure
        pressures.set(nodeId, waterState.pressure);
      } else {
        // Liquid: hybrid pressure model - MUST match FluidStateUpdateOperator exactly
        // to ensure flow calculations use consistent pressures
        if (liquidBasePressures.has(nodeId)) {
          // Connected to two-phase - use shared pressure feedback calculation
          const P_base = liquidBasePressures.get(nodeId)!;
          const u_specific = flowNode.fluid.internalEnergy / flowNode.fluid.mass;
          const v_specific = flowNode.volume / flowNode.fluid.mass;
          const result = Water.computePressureFeedback(rho, P_base, u_specific, T);

          // Floor: liquid pressure cannot be below saturation pressure at this temperature
          const P_sat = Water.saturationPressure(T);
          let P_final = Math.max(result.P_final, P_sat);

          // Near the liquid/supercritical boundary (u > 1750 kJ/kg), blend toward
          // triangulation lookup to ensure smooth transition
          const u_kJkg = u_specific / 1000;
          const U_BLEND_START = 1750;
          const U_BLEND_END = 1800;

          if (u_kJkg > U_BLEND_START) {
            const P_triangulation = Water.lookupPressureFromUV(u_specific, v_specific);
            if (P_triangulation !== null) {
              const blend = Math.min(1, (u_kJkg - U_BLEND_START) / (U_BLEND_END - U_BLEND_START));
              P_final = (1 - blend) * P_final + blend * P_triangulation;
            }
          }

          pressures.set(nodeId, P_final);
        } else {
          // Isolated liquid region
          pressures.set(nodeId, Water.computeIsolatedLiquidPressure(rho, T));
        }
      }
    }

    // Store base pressures in state for debugging
    state.liquidBasePressures = liquidBasePressures;

    return pressures;
  }
}

// ============================================================================
// Pressure Update Operator (Optional - for compressible effects)
// ============================================================================

export class PressureOperator implements PhysicsOperator {
  name = 'Pressure';

  // NOTE: This operator is now DISABLED in favor of the hybrid pressure model
  // in FluidStateUpdateOperator, which properly accounts for temperature-dependent
  // density and provides physically meaningful pressure feedback.
  //
  // The FluidStateUpdateOperator uses temperature-dependent bulk modulus via
  // Water.bulkModulus(T_celsius), which varies from ~2200 MPa at 50°C to ~60 MPa at 350°C.
  //
  // This operator is kept for reference but should not be in the operator chain.

  apply(state: SimulationState, _dt: number): SimulationState {
    // No-op - pressure is now handled by FluidStateUpdateOperator
    return state;
  }

  getMaxStableDt(_state: SimulationState): number {
    return Infinity;
  }
}
