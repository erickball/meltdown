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

  apply(state: SimulationState, dt: number): SimulationState {
    const newState = cloneSimulationState(state);
    operatorProfile.totalCalls++;

    // Update pump effective speeds based on ramp-up/coast-down dynamics
    this.updatePumpSpeeds(newState, dt);

    // Update flow rates in each connection based on pressure balance
    // We use the stored fluid.pressure values set by FluidStateUpdateOperator
    // at the end of the previous timestep. These use the hybrid pressure model.
    const t1 = performance.now();
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

    // Gravity head (positive = downward flow is favored)
    const rho = this.getNodeDensity(fromNode);
    const g = 9.81; // m/s²
    const dP_gravity = rho * g * conn.elevation;

    // Check for pump in this connection
    const pump = this.getPumpForConnection(conn.id, state);
    let dP_pump = 0;
    if (pump && pump.effectiveSpeed > 0) {
      // Pump provides forward head (from -> to) based on its current effective speed.
      // The effectiveSpeed is updated by updatePumpSpeeds() each timestep, accounting
      // for ramp-up and coast-down dynamics.
      // For pumps, we should use the liquid density if available (pumps draw from bottom)
      const pumpRho = this.getNodeDensity(fromNode, 'liquid');
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
    // Always log condenser->feedwater to understand the flow paradox
    // Sample others at 0.1%
    if (conn.id === "flow-condenser-feedwater" ||
        conn.id === "flow-feedwater-sg" ||
        ((conn.id === "flow-sg-coldleg" || conn.id === 'flow-coldleg-core' || conn.id === 'flow-core-hotleg') && Math.random() < 0.001)) {
      console.log(`[FlowOp] ${conn.id}:`);
      console.log(`  From: ${fromNode.id} (P=${(P_from/1e5).toFixed(2)}bar, ρ=${rho.toFixed(0)}kg/m³)`);
      console.log(`  To: ${toNode.id} (P=${(P_to/1e5).toFixed(2)}bar)`);
      console.log(`  Pressure components:`);
      console.log(`    dP_pressure=${(dP_pressure/1e5).toFixed(3)}bar (P_from - P_to)`);
      console.log(`    dP_gravity=${(dP_gravity/1e5).toFixed(3)}bar (ρ*g*h, elev=${conn.elevation}m)`);
      console.log(`    dP_pump=${(dP_pump/1e5).toFixed(3)}bar`);
      console.log(`    dP_driving=${(dP_driving/1e5).toFixed(3)}bar (total)`);
      if (pump) {
        const pumpRho = this.getNodeDensity(fromNode, 'liquid');
        console.log(`  Pump details:`);
        console.log(`    effectiveSpeed=${pump.effectiveSpeed.toFixed(3)}`);
        console.log(`    ratedHead=${pump.ratedHead}m`);
        console.log(`    actual node density=${rho.toFixed(0)}kg/m³`);
        console.log(`    liquid density used for pump=${pumpRho.toFixed(0)}kg/m³`);
        console.log(`    => dP_pump = ${pump.effectiveSpeed.toFixed(3)} * ${pump.ratedHead} * ${pumpRho.toFixed(0)} * 9.81 = ${(dP_pump/1e5).toFixed(3)}bar`);
      }
      if (checkValve) {
        console.log(`  Check valve: cracking pressure=${(checkValve.crackingPressure/1e5).toFixed(3)}bar`);
      }

      // Flow paradox warning
      if (conn.id === "flow-condenser-feedwater" && dP_pressure < 0 && dP_driving > 0) {
        console.log(`  ⚠️ FLOW PARADOX: Flow is positive (condenser→feedwater) despite adverse pressure!`);
        console.log(`    Adverse pressure: ${(Math.abs(dP_pressure)/1e5).toFixed(2)}bar`);
        console.log(`    Pump overcomes: ${(dP_pump/1e5).toFixed(2)}bar`);
        console.log(`    Net driving: ${(dP_driving/1e5).toFixed(2)}bar`);
      }
    }

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
    if (conn.id === "flow-feedwater-sg") {
      console.log(`  calculated flow=${massFlow.toFixed(1)} kg/s (v=${(sign*v).toFixed(2)} m/s, K=${K.toFixed(3)})`);
    }

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
