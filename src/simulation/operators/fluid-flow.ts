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

import { SimulationState, FlowNode, FlowConnection, PumpState, ValveState, CheckValveState } from '../types';
import { PhysicsOperator, cloneSimulationState } from '../solver';
import { calculateLiquidLevelWithObstructions } from './rate-operators';

// ============================================================================
// Flow Operator
// ============================================================================

// Profiling data structure
export interface FlowOperatorProfile {
  computeFlowRates: number;
  transferMass: number;
  totalCalls: number;
}

// Module-level profiling accumulator
let operatorProfile: FlowOperatorProfile = {
  computeFlowRates: 0,
  transferMass: 0,
  totalCalls: 0,
};

export function getFlowOperatorProfile(): FlowOperatorProfile {
  return { ...operatorProfile };
}

export function resetFlowOperatorProfile(): void {
  operatorProfile = {
    computeFlowRates: 0,
    transferMass: 0,
    totalCalls: 0,
  };
}

export class FlowOperator implements PhysicsOperator {
  name = 'FluidFlow';

  // Maximum flow rate to prevent runaway (kg/s)
  private maxFlowRate = 50000;

  // Performance monitoring
  private perfStats = {
    callCount: 0,
    totalPhaseTime: 0,
    totalDensityTime: 0,
    totalPumpTime: 0,
    totalFlowTime: 0,
    lastReportTime: Date.now(),
    minDt: Infinity,
    maxDt: 0,
    sumDt: 0,
  };

  apply(state: SimulationState, dt: number): SimulationState {
    const newState = cloneSimulationState(state);
    operatorProfile.totalCalls++;

    // Track timestep stats
    this.perfStats.callCount++;
    this.perfStats.minDt = Math.min(this.perfStats.minDt, dt);
    this.perfStats.maxDt = Math.max(this.perfStats.maxDt, dt);
    this.perfStats.sumDt += dt;

    // Update pump effective speeds based on ramp-up/coast-down dynamics
    this.updatePumpSpeeds(newState, dt);

    // Update flow rates in each connection based on pressure balance
    // We use the stored fluid.pressure values set by FluidStateUpdateOperator
    // at the end of the previous timestep. These use the hybrid pressure model.
    const t1 = performance.now();
    // Timing variables (commented out for performance)
    // let phaseDetectionTime = 0;
    // let densityCalcTime = 0;
    // let pumpCheckTime = 0;
    // let flowCalcTime = 0;
    // let debugLogTime = 0;

    for (const conn of newState.flowConnections) {
      const fromNode = newState.flowNodes.get(conn.fromNodeId);
      const toNode = newState.flowNodes.get(conn.toNodeId);

      if (!fromNode || !toNode) continue;

      // Compute target flow rate from momentum balance
      // const tFlowStart = performance.now();
      let targetFlow = this.computeFlowRate(conn, fromNode, toNode, newState, dt);
      // flowCalcTime += performance.now() - tFlowStart;

      // Note: Reverse flow through running pumps is handled via high friction
      // in computeFlowRate, not by hard clamping here.

      // SAFEGUARD: Clamp target flow to reasonable range
      // const unclamped = targetFlow;
      // We need to change this to just stop the simulation with an error message and debug info.
      // targetFlow = Math.max(-this.maxFlowRate, Math.min(this.maxFlowRate, targetFlow));
      if (targetFlow > this.maxFlowRate || targetFlow < -this.maxFlowRate) {
        console.warn('Target flow exceeded maximum bounds.');
        console.warn(conn, 'from:', fromNode, 'to:', toNode, 'state:', newState, 'dt:', dt);

      }

      // Debug: log when clamping happens (indicates pressure imbalance)
      // if (Math.abs(unclamped) > this.maxFlowRate) {
      //   const P_from = fromNode.fluid.pressure / 1e5;
      //   const P_to = toNode.fluid.pressure / 1e5;
      //   console.warn(`[FlowOp] ${conn.id}: CLAMPED targetFlow from ${unclamped.toFixed(0)} to ${targetFlow.toFixed(0)} kg/s`);
      //   console.warn(`  Pressures: ${conn.fromNodeId}=${P_from.toFixed(2)}bar, ${conn.toNodeId}=${P_to.toFixed(2)}bar, dP=${(P_from-P_to).toFixed(2)}bar`);
      // }

      // Check for NaN
      if (!isFinite(targetFlow)) {
        throw new Error(`[FlowOperator] Invalid target flow in '${conn.id}': ${targetFlow}. Physics has failed.`);
      }

      // Store target flow for debugging display
      conn.targetFlowRate = targetFlow;

      // Set flow directly to target (no relaxation)
      conn.massFlowRate = targetFlow;

      // SAFEGUARD: Final clamp
      //conn.massFlowRate = Math.max(-this.maxFlowRate, Math.min(this.maxFlowRate, conn.massFlowRate));
    }
    operatorProfile.computeFlowRates += performance.now() - t1;

    // MASS AND ENERGY CONSERVATION: Transfer mass and energy together
    // to ensure consistent specific energy during advection.
    const t2 = performance.now();
    this.transferMassConservatively(newState, dt);
    operatorProfile.transferMass += performance.now() - t2;

    // Periodic performance reporting (every 5 seconds)
    const now = Date.now();
    if (now - this.perfStats.lastReportTime > 5000) {
      const avgDt = this.perfStats.sumDt / this.perfStats.callCount;
      console.log(`[FlowOp Performance] ${this.perfStats.callCount} calls in 5s:`);
      console.log(`  dt: min=${(this.perfStats.minDt*1000).toFixed(3)}ms, avg=${(avgDt*1000).toFixed(3)}ms, max=${(this.perfStats.maxDt*1000).toFixed(3)}ms`);
      console.log(`  Simulation rate: ${(this.perfStats.sumDt).toFixed(3)}s simulated in 5s wall time`);
      console.log(`  Speed factor: ${(this.perfStats.sumDt / 5).toFixed(5)}x real time`);

      // Reset stats
      this.perfStats.callCount = 0;
      this.perfStats.minDt = Infinity;
      this.perfStats.maxDt = 0;
      this.perfStats.sumDt = 0;
      this.perfStats.lastReportTime = now;
    }

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
      const upstreamElevation = conn.massFlowRate > 0 ? conn.fromElevation : conn.toElevation;
      const upstreamPhaseTolerance = conn.massFlowRate > 0 ? conn.fromPhaseTolerance : conn.toPhaseTolerance;

      const upstream = state.flowNodes.get(upstreamId);
      const downstream = state.flowNodes.get(downstreamId);
      if (!upstream || !downstream) continue;

      // Mass to transfer this timestep
      let massToMove = Math.abs(conn.massFlowRate) * dt;

      // Don't transfer more than 5% of upstream mass per timestep
      const maxTransfer = upstream.fluid.mass * 0.05;
      massToMove = Math.min(massToMove, maxTransfer);

      if (massToMove < 1e-6) continue; // Skip only truly negligible transfers

      // Determine what phase is actually flowing based on connection elevation
      // For two-phase nodes, use phase-specific energy to correctly model
      // liquid vs vapor flow from different parts of the node
      let specificEnergyToUse: number;
      const flowPhase = this.getFlowPhase(upstream, upstreamElevation, upstreamPhaseTolerance);

      if (upstream.fluid.phase === 'two-phase' && flowPhase !== 'mixture') {
        // Use phase-specific specific energy for the flowing phase
        if (flowPhase === 'vapor') {
          // Vapor space: use saturated vapor internal energy
          // Approximate saturated vapor specific internal energy
          // u_g ≈ u_f + h_fg - Pv_g, but for simplicity use average vapor energy
          // Steam at 150 bar: u_g ≈ 2600 kJ/kg, at 10 bar: u_g ≈ 2580 kJ/kg
          // The upstream node's quality gives us the vapor fraction
          const quality = upstream.fluid.quality ?? 0.5;
          if (quality > 0.01) {
            // Vapor energy = (total energy - liquid mass * liquid energy) / vapor mass
            // Estimate liquid specific energy from saturation properties
            const T = upstream.fluid.temperature;
            const u_f = 4186 * (T - 273.15); // Approximate saturated liquid u (kJ/kg)
            const liquidMass = upstream.fluid.mass * (1 - quality);
            const vaporMass = upstream.fluid.mass * quality;
            const vaporEnergy = upstream.fluid.internalEnergy - liquidMass * u_f;
            specificEnergyToUse = vaporEnergy / vaporMass;
          } else {
            // Very low quality - use bulk average
            specificEnergyToUse = upstream.fluid.internalEnergy / upstream.fluid.mass;
          }
        } else {
          // Liquid space: use saturated liquid internal energy
          const T = upstream.fluid.temperature;
          // Approximate saturated liquid specific internal energy
          // u_f ≈ c_p * (T - T_ref) where c_p ≈ 4186 J/kg/K for water
          specificEnergyToUse = 4186 * (T - 273.15);
        }
        // Bound to reasonable values
        const bulkSpecificEnergy = upstream.fluid.internalEnergy / upstream.fluid.mass;
        specificEnergyToUse = Math.max(0.5 * bulkSpecificEnergy, Math.min(2 * bulkSpecificEnergy, specificEnergyToUse));
      } else {
        // Single-phase or mixture: use bulk average specific energy
        specificEnergyToUse = upstream.fluid.internalEnergy / upstream.fluid.mass;
      }

      // Energy carried by this mass
      const energyToMove = massToMove * specificEnergyToUse;

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

      // Check for negative energy
      if (upstream.fluid.internalEnergy < 0) {
        throw new Error(`[FlowOperator] Negative internal energy in '${upstream.id}': ${upstream.fluid.internalEnergy} J. Physics has failed.`);
      }
    }

    // Third pass: check minimum mass
    for (const [, node] of state.flowNodes) {
      if (node.fluid.mass < 1) {
        throw new Error(`[FlowOperator] Mass too low in '${node.id}': ${node.fluid.mass} kg. Node has drained. Physics has failed.`);
      }
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
    // Two stability constraints:
    // 1. CFL-like condition for advection: dt < volume / max_flow_rate
    // 2. Inertial stability: dt < 2 * inertance / K (for connections with inertance)

    let minDt = Infinity;

    // 1. Check residence time constraint (original CFL condition)
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

    // 2. Check inertial stability for connections with momentum
    for (const conn of state.flowConnections) {
      // Only check connections with inertance
      if (!conn.inertance || conn.inertance <= 0) continue;
      if (conn.resistanceCoeff <= 0) continue;

      // For stability checking, use base resistance (valves would slow flow more, making it more stable)
      const K_eff = conn.resistanceCoeff;

      // Inertial timestep limit: dt < 2 * inertance / K
      // This ensures the momentum equation remains stable
      const dtInertial = 2.0 * conn.inertance / K_eff;

      if (dtInertial < minDt) {
        minDt = dtInertial;
      }
    }

    // Return the minimum timestep without artificial floor
    return minDt;
  }

  /**
   * Compute the actual mass flow rate for a connection this timestep.
   *
   * Calculates the driving pressure (pressure difference + gravity + pump head),
   * handles valve resistance and check valves, then either:
   * - Returns steady-state flow directly (if no inertance)
   * - Applies momentum equation to smoothly transition toward steady state (if inertance defined)
   */
  private computeFlowRate(
    conn: FlowConnection,
    fromNode: FlowNode,
    toNode: FlowNode,
    state: SimulationState,
    dt: number
  ): number {
    // Calculate pressures at the actual connection points, accounting for hydrostatic
    // head within each node. For two-phase nodes, connections below the liquid level
    // experience higher pressure due to the liquid column above.
    //
    // This replaces the previous approach of using node.fluid.pressure directly,
    // which didn't account for where on the node the connection was located.
    const P_from = this.getPressureAtConnection(fromNode, conn.fromElevation);
    const P_to = this.getPressureAtConnection(toNode, conn.toElevation);

    // Base pressure difference (positive = from has higher pressure)
    // Now includes hydrostatic effects within each node
    const dP_pressure = P_from - P_to;

    // For density calculation, determine which node is upstream based on current flow direction
    // This ensures we use the density of the fluid actually flowing through the connection
    const currentFlow = conn.massFlowRate;
    const upstreamNode = currentFlow >= 0 ? fromNode : toNode;
    const upstreamElevation = currentFlow >= 0 ? conn.fromElevation : conn.toElevation;
    const upstreamPhaseTolerance = currentFlow >= 0 ? conn.fromPhaseTolerance : conn.toPhaseTolerance;

    // Determine what phase is flowing based on connection elevation at upstream node
    // const tPhase = performance.now();
    const flowPhase = this.getFlowPhase(upstreamNode, upstreamElevation, upstreamPhaseTolerance);
    // const phaseTime = performance.now() - tPhase;

    // Get appropriate density based on what's actually flowing from upstream
    // const tDensity = performance.now();
    let rho: number;
    if (flowPhase === 'liquid') {
      rho = this.getNodeDensity(upstreamNode, 'liquid');
    } else if (flowPhase === 'vapor') {
      rho = this.getNodeDensity(upstreamNode, 'vapor');
    } else {
      rho = this.getNodeDensity(upstreamNode, 'actual'); // mixture
    }
    // const densityTime = performance.now() - tDensity;

    // Gravity head (positive = downward flow is favored)
    // conn.elevation = toElevation - fromElevation
    // If going uphill (to higher than from), conn.elevation > 0, gravity opposes flow
    // If going downhill (to lower than from), conn.elevation < 0, gravity favors flow
    // dP_gravity = -ρ * g * dz, so downhill gives positive dP (favors forward flow)
    //
    // IMPORTANT: Use the density of the fluid filling the pipe between nodes.
    // If we're drawing liquid from the upstream node (e.g., from bottom of condenser),
    // the pipe between nodes is filled with liquid, so use liquid density for gravity.
    // This is critical for condensate pump suction where the 20m elevation difference
    // should provide ~2 bar of liquid head, not a fraction of that with mixture density.
    const g = 9.81; // m/s²
    let rho_gravity: number;
    if (flowPhase === 'liquid') {
      // Liquid flowing - pipe is filled with liquid
      rho_gravity = this.getNodeDensity(upstreamNode, 'liquid');
    } else if (flowPhase === 'vapor') {
      // Vapor flowing - use vapor density (small effect anyway)
      rho_gravity = this.getNodeDensity(upstreamNode, 'vapor');
    } else {
      // Mixture - use actual mixture density
      rho_gravity = rho;
    }
    const dP_gravity = -rho_gravity * g * conn.elevation;

    // Check for pump in this connection
    const pump = this.getPumpForConnection(conn.id, state);
    let dP_pump = 0;
    let pumpRho = rho; // Default to actual density

    if (pump && pump.effectiveSpeed > 0) {
      // Pump provides forward head (from -> to) based on its current effective speed.
      // The effectiveSpeed is updated by updatePumpSpeeds() each timestep, accounting
      // for ramp-up and coast-down dynamics.

      // Use upstream node for pump suction (same as for density calculation)
      const pumpSuctionNode = upstreamNode;

      // For two-phase nodes, pumps draw from the bottom (liquid) if available
      if (pumpSuctionNode.fluid.phase === 'two-phase' && pumpSuctionNode.fluid.quality !== undefined) {
        // Check if there's enough liquid to draw from
        // Liquid fraction = 1 - quality
        const liquidFraction = 1 - pumpSuctionNode.fluid.quality;
        const liquidMass = pumpSuctionNode.fluid.mass * liquidFraction;

        // Estimate the mass flow this pump would draw this timestep
        // Use rated flow as an estimate (actual flow will be calculated later)
        const expectedFlow = pump.ratedFlow * pump.effectiveSpeed;
        const massNeeded = expectedFlow * dt;

        // Only use liquid density if there's enough liquid
        if (liquidMass > massNeeded * 2) {  // Safety factor of 2
          pumpRho = this.getNodeDensity(pumpSuctionNode, 'liquid');
        } else {
          // Not enough liquid - pump is drawing mixture or vapor
          // console.log(`[FlowOp] Warning: Pump ${pump.id} has insufficient liquid (${liquidMass.toFixed(0)}kg available, ${massNeeded.toFixed(0)}kg needed)`);
          pumpRho = this.getNodeDensity(pumpSuctionNode, 'actual'); // Use actual mixture density
        }
      } else {
        // Use actual density from suction node
        pumpRho = this.getNodeDensity(pumpSuctionNode, 'actual');
      }

      // Pump head is always positive in the forward direction (from -> to)
      // If flow reverses, the pump still tries to push forward, opposing the reverse flow
      dP_pump = pump.effectiveSpeed * pump.ratedHead * pumpRho * g;
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

    // Check for check valve in this connection
    // Check valves prevent reverse flow and require minimum forward pressure to open
    const checkValve = this.getCheckValveForConnection(conn.id, state);
    if (checkValve) {
      if (dP_driving < checkValve.crackingPressure) {
        // Either reverse flow (negative) or forward pressure below cracking pressure
        // Check valve is closed - no flow
        return 0;
      }
    }

    // Debug: log components for key connections
    // Disable for now - even at 0.01% sampling it's too expensive
    // const shouldLog = false; // Math.random() < 0.0001; // 0.01% sampling
    // if (shouldLog && (conn.id === "flow-condenser-feedwater" ||
    //     conn.id === "flow-feedwater-sg")) {
    //   console.log(`[FlowOp] ${conn.id}: P_from=${(P_from/1e5).toFixed(2)}bar, P_to=${(P_to/1e5).toFixed(2)}bar, ρ=${rho.toFixed(0)}kg/m³, phase=${flowPhase}`);
    // }

    // Compute flow from pressure drop
    let K = conn.resistanceCoeff * resistanceMult;
    if (K <= 0) return 0;

    // Running pumps have very high resistance to reverse flow
    // The pump impeller physically blocks backflow - model this as extremely high friction
    if (pump && pump.running && conn.massFlowRate < 0) {
      // Add massive friction coefficient for reverse flow (10000x base resistance)
      K += 10000 * conn.resistanceCoeff;
    }

    const A = conn.flowArea;

    // First, always calculate the steady-state flow (what flow would be without momentum)
    // This is useful for debugging and understanding the pressure balance
    const sign = dP_driving >= 0 ? 1 : -1;
    const dP_abs = Math.abs(dP_driving);
    const v_steady = Math.sqrt(2 * dP_abs / (rho * K));
    const steadyStateFlow = sign * rho * A * v_steady;

    // Store for debug display
    conn.steadyStateFlow = steadyStateFlow;

    // Check if this connection has inertance defined (flow momentum)
    if (conn.inertance && conn.inertance > 0) {
      // WITH INERTANCE: Implement momentum equation
      // ρ * inertance * dv/dt = ΔP - friction_loss
      // where friction_loss = K * (1/2) * ρ * v²

      // Current velocity from current mass flow
      const currentFlow = conn.massFlowRate;
      const currentVelocity = currentFlow / (rho * A);

      // Friction pressure drop (always opposes flow)
      const dP_friction = -K * 0.5 * rho * currentVelocity * Math.abs(currentVelocity);

      // Net driving pressure (pressure difference minus friction)
      const dP_net = dP_driving + dP_friction;

      // Acceleration from momentum equation: dv/dt = dP_net / (ρ * inertance)
      const acceleration = dP_net / (rho * conn.inertance);

      // New velocity using forward Euler integration
      const newVelocity = currentVelocity + acceleration * dt;

      // New mass flow rate
      const massFlow = rho * A * newVelocity;

      // Debug: log calculated flow for feedwater-sg
      // if (conn.id === "flow-feedwater-sg") {
      //   console.log(`  [Inertial] flow=${massFlow.toFixed(1)} kg/s, v: ${currentVelocity.toFixed(2)}→${newVelocity.toFixed(2)} m/s`);
      //   console.log(`    dP_driving=${(dP_driving/1e5).toFixed(3)} bar, dP_friction=${(dP_friction/1e5).toFixed(3)} bar`);
      //   console.log(`    acceleration=${acceleration.toFixed(3)} m/s², inertance=${conn.inertance.toFixed(1)} m⁻¹`);
      //   console.log(`    Steady-state flow would be: ${steadyStateFlow.toFixed(1)} kg/s`);
      // }

      return massFlow;

    } else {
      // WITHOUT INERTANCE: Use steady-state equation (backward compatibility)
      // The steady-state flow we calculated above is the actual flow

      // Debug: log calculated flow for feedwater-sg
      // if (conn.id === "flow-feedwater-sg") {
      //   console.log(`  [Steady] flow=${steadyStateFlow.toFixed(1)} kg/s (v=${(sign*v_steady).toFixed(2)} m/s, K=${K.toFixed(3)})`);
      // }

      return steadyStateFlow;
    }
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
   * Calculate liquid level height in a two-phase node.
   * Accounts for internal obstructions that reduce available cross-sectional area.
   *
   * @param node The flow node
   * @returns Liquid level height from bottom (m), or node height if single phase
   */
  private getLiquidLevel(node: FlowNode): number {
    // Use stored height if available, otherwise estimate from volume
    const height = node.height ?? Math.sqrt(node.volume / (Math.PI * 0.25));

    // For single phase, return appropriate level
    if (node.fluid.phase === 'liquid') {
      return height; // Full of liquid
    }
    if (node.fluid.phase === 'vapor') {
      return 0; // No liquid
    }

    // Two-phase: calculate based on liquid mass and density
    const quality = node.fluid.quality || 0;

    // Get liquid density
    const rho_f = this.getNodeDensity(node, 'liquid');

    // Calculate liquid mass and volume
    const liquidMass = node.fluid.mass * (1 - quality);
    const liquidVolume = liquidMass / rho_f;

    // Calculate liquid level accounting for internal obstructions
    return calculateLiquidLevelWithObstructions(node, liquidVolume);
  }

  /**
   * Determine what phase should flow based on connection elevation and liquid level.
   *
   * @param node Source flow node
   * @param connectionElevation Height of connection point relative to node bottom (m)
   * @param phaseTolerance Tolerance zone around interface (m). 0 = no tolerance, undefined = use default (0.1m).
   * @returns 'liquid', 'vapor', or 'mixture' depending on connection position
   */
  private getFlowPhase(node: FlowNode, connectionElevation?: number, phaseTolerance?: number): 'liquid' | 'vapor' | 'mixture' {
    // Single phase nodes always flow their phase
    if (node.fluid.phase !== 'two-phase') {
      return node.fluid.phase === 'vapor' ? 'vapor' : 'liquid';
    }

    // If no elevation specified, assume mid-height connection (mixture)
    if (connectionElevation === undefined) {
      // Use stored height if available, otherwise estimate from volume
      const height = node.height ?? Math.sqrt(node.volume / (Math.PI * 0.25));
      connectionElevation = height / 2;
    }

    const liquidLevel = this.getLiquidLevel(node);

    // Tolerance zone around the interface
    // If phaseTolerance is specified (including 0), use it directly
    // Otherwise use default of 0.1m (10cm)
    const tolerance = phaseTolerance !== undefined ? phaseTolerance : 0.1;

    // Connection below liquid level: draw liquid
    if (connectionElevation < liquidLevel - tolerance) {
      return 'liquid';
    }

    // Connection above liquid level: draw vapor
    if (connectionElevation > liquidLevel + tolerance) {
      return 'vapor';
    }

    // Connection at interface: draw mixture
    return 'mixture';
  }

  /**
   * Get node density - uses actual mass/volume ratio.
   *
   * @param node The flow node
   * @param phasePreference For two-phase nodes:
   *   - 'actual' (default): returns the actual mixture density (mass/volume)
   *   - 'liquid': returns approximate saturated liquid density
   *   - 'vapor': returns approximate saturated vapor density
   */
  private getNodeDensity(node: FlowNode, phasePreference: 'actual' | 'liquid' | 'vapor' = 'actual'): number {
    // Always have the actual density from mass/volume
    const actualDensity = node.fluid.mass / node.volume;

    // For single-phase or when actual density is requested, return it directly
    if (node.fluid.phase !== 'two-phase' || phasePreference === 'actual') {
      return actualDensity;
    }

    // For two-phase with specific phase preference
    const T = node.fluid.temperature;

    if (phasePreference === 'liquid') {
      // Approximate saturated liquid density
      // At saturation, liquid density decreases with temperature
      // From ~1000 kg/m³ at 20°C to ~600 kg/m³ near critical point (374°C)
      const T_C = T - 273.15; // Convert to Celsius
      if (T_C < 100) {
        return 1000 - 0.08 * T_C; // Slight decrease at low temps
      } else if (T_C < 300) {
        return 958 - 1.3 * (T_C - 100); // Faster decrease at medium temps
      } else {
        return 700 - 2.5 * (T_C - 300); // Rapid decrease approaching critical
      }
    } else if (phasePreference === 'vapor') {
      // Use ideal gas approximation for saturated vapor
      const P = node.fluid.pressure;
      const R = 8.314; // J/mol-K
      const M = 0.018; // kg/mol for water
      return P * M / (R * T);
    }

    return actualDensity; // Fallback
  }

  /**
   * Calculate the pressure at a specific connection elevation within a node.
   *
   * For two-phase nodes, the node's stored pressure is the saturation pressure
   * at the liquid surface. Connections below the liquid level experience additional
   * hydrostatic pressure from the liquid column above them.
   *
   * P_connection = P_node + ρ_liquid * g * (liquidLevel - connectionElevation)
   *
   * For single-phase liquid nodes, the stored pressure is typically at some
   * reference point. We adjust based on connection elevation.
   *
   * @param node The flow node
   * @param connectionElevation Height of connection point relative to node bottom (m)
   * @returns Pressure at the connection point (Pa)
   */
  private getPressureAtConnection(node: FlowNode, connectionElevation?: number): number {
    const g = 9.81;
    const baseP = node.fluid.pressure;

    // Get node height estimate
    const nodeHeight = Math.sqrt(node.volume / (Math.PI * 0.25));

    // Default connection elevation to mid-height if not specified
    if (connectionElevation === undefined) {
      connectionElevation = nodeHeight / 2;
    }

    if (node.fluid.phase === 'two-phase') {
      // For two-phase, base pressure is saturation pressure at the liquid surface
      // Connections below liquid level have higher pressure due to liquid head
      const liquidLevel = this.getLiquidLevel(node);
      const rho_liquid = this.getNodeDensity(node, 'liquid');

      if (connectionElevation < liquidLevel) {
        // Below liquid level: add hydrostatic head from liquid above
        const liquidHead = liquidLevel - connectionElevation;
        return baseP + rho_liquid * g * liquidHead;
      } else {
        // Above liquid level (in steam space): just saturation pressure
        // (vapor is compressible, hydrostatic effect is negligible)
        return baseP;
      }
    } else if (node.fluid.phase === 'liquid') {
      // For liquid nodes, treat like 100% filled two-phase: base pressure is at top,
      // connections below get hydrostatic head from the liquid column above
      const rho = this.getNodeDensity(node, 'actual');
      const liquidHead = nodeHeight - connectionElevation;  // distance from connection to top
      return baseP + rho * g * liquidHead;
    } else {
      // Vapor - negligible hydrostatic effect
      return baseP;
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
   * Find check valve affecting this connection
   */
  private getCheckValveForConnection(connId: string, state: SimulationState): CheckValveState | undefined {
    if (!state.components.checkValves) return undefined;
    for (const [, cv] of state.components.checkValves) {
      if (cv.connectedFlowPath === connId) {
        return cv;
      }
    }
    return undefined;
  }

  /**
   * Update pump effective speeds based on running state and ramp dynamics.
   * This must be called each timestep before computing flows.
   */
  private updatePumpSpeeds(state: SimulationState, dt: number): void {
    for (const [, pump] of state.components.pumps) {
      if (pump.running) {
        // Ramp up toward target speed
        const targetSpeed = pump.speed;
        if (pump.effectiveSpeed < targetSpeed) {
          const rampRate = targetSpeed / pump.rampUpTime;  // speed per second
          pump.effectiveSpeed = Math.min(targetSpeed, pump.effectiveSpeed + rampRate * dt);
        } else if (pump.effectiveSpeed > targetSpeed) {
          // Speed setpoint was reduced - coast down to new target
          const coastRate = 1.0 / pump.coastDownTime;  // speed per second
          pump.effectiveSpeed = Math.max(targetSpeed, pump.effectiveSpeed - coastRate * dt);
        }
      } else {
        // Pump is not running - coast down to zero
        if (pump.effectiveSpeed > 0) {
          const coastRate = 1.0 / pump.coastDownTime;
          pump.effectiveSpeed = Math.max(0, pump.effectiveSpeed - coastRate * dt);
        }
      }
    }
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
