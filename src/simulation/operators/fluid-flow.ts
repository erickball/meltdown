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

// ============================================================================
// Flow Operator
// ============================================================================

// Profiling data structure
export interface FlowOperatorProfile {
  computeTargetFlows: number;
  transferMass: number;
  totalCalls: number;
}

// Module-level profiling accumulator
let operatorProfile: FlowOperatorProfile = {
  computeTargetFlows: 0,
  transferMass: 0,
  totalCalls: 0,
};

export function getFlowOperatorProfile(): FlowOperatorProfile {
  return { ...operatorProfile };
}

export function resetFlowOperatorProfile(): void {
  operatorProfile = {
    computeTargetFlows: 0,
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
    let phaseDetectionTime = 0;
    let densityCalcTime = 0;
    let pumpCheckTime = 0;
    let flowCalcTime = 0;
    let debugLogTime = 0;

    for (const conn of newState.flowConnections) {
      const fromNode = newState.flowNodes.get(conn.fromNodeId);
      const toNode = newState.flowNodes.get(conn.toNodeId);

      if (!fromNode || !toNode) continue;

      // Compute target flow rate from momentum balance
      const tFlowStart = performance.now();
      let targetFlow = this.computeTargetFlow(conn, fromNode, toNode, newState, dt);
      flowCalcTime += performance.now() - tFlowStart;

      // SAFEGUARD: Clamp target flow to reasonable range
      const unclamped = targetFlow;
      targetFlow = Math.max(-this.maxFlowRate, Math.min(this.maxFlowRate, targetFlow));

      // Debug: log when clamping happens (indicates pressure imbalance)
      // if (Math.abs(unclamped) > this.maxFlowRate) {
      //   const P_from = fromNode.fluid.pressure / 1e5;
      //   const P_to = toNode.fluid.pressure / 1e5;
      //   console.warn(`[FlowOp] ${conn.id}: CLAMPED targetFlow from ${unclamped.toFixed(0)} to ${targetFlow.toFixed(0)} kg/s`);
      //   console.warn(`  Pressures: ${conn.fromNodeId}=${P_from.toFixed(2)}bar, ${conn.toNodeId}=${P_to.toFixed(2)}bar, dP=${(P_from-P_to).toFixed(2)}bar`);
      // }

      // SAFEGUARD: Check for NaN
      if (!isFinite(targetFlow)) {
        console.warn('FlowOperator: Invalid target flow, keeping current');
        continue;
      }

      // Store target flow for debugging display
      conn.targetFlowRate = targetFlow;

      // Set flow directly to target (no relaxation)
      conn.massFlowRate = targetFlow;

      // SAFEGUARD: Final clamp
      conn.massFlowRate = Math.max(-this.maxFlowRate, Math.min(this.maxFlowRate, conn.massFlowRate));
    }
    operatorProfile.computeTargetFlows += performance.now() - t1;

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
    state: SimulationState,
    dt: number
  ): number {
    // Use stored pressures from FluidStateUpdateOperator (which ran at end of last step).
    // These use the hybrid pressure model (P_base + feedback) which is physically correct.
    // Previously we computed "fresh" pressures here, but that caused mismatches because
    // operators before FlowOperator (like ConvectionOperator) modify energy, which changes
    // what the fresh pressure calculation would produce.
    const P_from = fromNode.fluid.pressure;
    const P_to = toNode.fluid.pressure;

    // Base pressure difference (positive = from has higher pressure)
    // For liquid loops, this should be small (just friction losses)
    // The pressurizer sets the system pressure
    const dP_pressure = P_from - P_to;

    // Determine what phase is flowing based on connection elevation
    const tPhase = performance.now();
    const flowPhase = this.getFlowPhase(fromNode, conn.fromElevation);
    const phaseTime = performance.now() - tPhase;

    // Get appropriate density based on what's actually flowing
    const tDensity = performance.now();
    let rho: number;
    if (flowPhase === 'liquid') {
      rho = this.getNodeDensity(fromNode, 'liquid');
    } else if (flowPhase === 'vapor') {
      rho = this.getNodeDensity(fromNode, 'vapor');
    } else {
      rho = this.getNodeDensity(fromNode, 'actual'); // mixture
    }
    const densityTime = performance.now() - tDensity;

    // Gravity head (positive = downward flow is favored)
    const g = 9.81; // m/s²
    const dP_gravity = rho * g * conn.elevation;

    // Check for pump in this connection
    const pump = this.getPumpForConnection(conn.id, state);
    let dP_pump = 0;
    let pumpRho = rho; // Default to actual density

    if (pump && pump.effectiveSpeed > 0) {
      // Pump provides forward head (from -> to) based on its current effective speed.
      // The effectiveSpeed is updated by updatePumpSpeeds() each timestep, accounting
      // for ramp-up and coast-down dynamics.

      // Use upstream node density (fromNode is upstream in computeTargetFlow)
      const pumpSuctionNode = fromNode;

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

    // Debug FW->SG connection
    if (conn.id === "flow-feedwater-sg") {
      console.log(`[FlowOp] ${conn.id} pressure analysis:`);
      console.log(`  P_from (FW): ${(P_from/1e5).toFixed(2)} bar`);
      console.log(`  P_to (SG): ${(P_to/1e5).toFixed(2)} bar`);
      console.log(`  dP_pressure: ${(dP_pressure/1e5).toFixed(2)} bar`);
      console.log(`  dP_gravity: ${(dP_gravity/1e5).toFixed(2)} bar`);
      console.log(`  dP_pump: ${(dP_pump/1e5).toFixed(2)} bar`);
      console.log(`  dP_driving total: ${(dP_driving/1e5).toFixed(2)} bar`);
      console.log(`  Density used: ${rho.toFixed(0)} kg/m³`);
    }

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
    const shouldLog = false; // Math.random() < 0.0001; // 0.01% sampling
    // if (shouldLog && (conn.id === "flow-condenser-feedwater" ||
    //     conn.id === "flow-feedwater-sg")) {
    //   console.log(`[FlowOp] ${conn.id}: P_from=${(P_from/1e5).toFixed(2)}bar, P_to=${(P_to/1e5).toFixed(2)}bar, ρ=${rho.toFixed(0)}kg/m³, phase=${flowPhase}`);
    // }

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

    // Debug: log calculated flow for feedwater-sg
    // if (conn.id === "flow-feedwater-sg") {
    //   console.log(`  calculated flow=${massFlow.toFixed(1)} kg/s (v=${(sign*v).toFixed(2)} m/s, K=${K.toFixed(3)})`);
    // }

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
   * Calculate liquid level height in a two-phase node.
   * Assumes node is a vertical cylinder or rectangular tank.
   *
   * @param node The flow node
   * @returns Liquid level height from bottom (m), or node height if single phase
   */
  private getLiquidLevel(node: FlowNode): number {
    // For single phase, return appropriate level
    if (node.fluid.phase === 'liquid') {
      // Assume cylindrical tank with height = diameter for rough estimate
      const height = Math.sqrt(node.volume / (Math.PI * 0.25));
      return height; // Full of liquid
    }
    if (node.fluid.phase === 'vapor') {
      return 0; // No liquid
    }

    // Two-phase: calculate based on void fraction
    // Void fraction α = volume of vapor / total volume
    // For homogeneous flow: α ≈ x / (x + (1-x) * ρ_g/ρ_f)
    // But we can also estimate from quality and densities
    const quality = node.fluid.quality || 0;

    // Approximate densities
    const rho_f = this.getNodeDensity(node, 'liquid');
    const rho_g = this.getNodeDensity(node, 'vapor');

    // Void fraction (Homogeneous model)
    const voidFraction = (quality * rho_f) / (quality * rho_f + (1 - quality) * rho_g);

    // Liquid fraction by volume
    const liquidVolumeFraction = 1 - voidFraction;

    // Assume cylindrical tank with height = diameter
    const height = Math.sqrt(node.volume / (Math.PI * 0.25));

    return height * liquidVolumeFraction;
  }

  /**
   * Determine what phase should flow based on connection elevation and liquid level.
   *
   * @param node Source flow node
   * @param connectionElevation Height of connection point relative to node bottom (m)
   * @returns 'liquid', 'vapor', or 'mixture' depending on connection position
   */
  private getFlowPhase(node: FlowNode, connectionElevation?: number): 'liquid' | 'vapor' | 'mixture' {
    // Single phase nodes always flow their phase
    if (node.fluid.phase !== 'two-phase') {
      return node.fluid.phase === 'vapor' ? 'vapor' : 'liquid';
    }

    // If no elevation specified, assume mid-height connection (mixture)
    if (connectionElevation === undefined) {
      // Estimate tank height
      const height = Math.sqrt(node.volume / (Math.PI * 0.25));
      connectionElevation = height / 2;
    }

    const liquidLevel = this.getLiquidLevel(node);

    // Connection below liquid level: draw liquid
    if (connectionElevation < liquidLevel - 0.1) {  // 10cm tolerance
      return 'liquid';
    }

    // Connection above liquid level: draw vapor
    if (connectionElevation > liquidLevel + 0.1) {  // 10cm tolerance
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
