/**
 * Rate-Based Physics Operators for RK45 Integration
 *
 * These operators compute derivatives (rates of change) rather than
 * applying changes directly. This allows the RK45 solver to combine
 * them properly for higher-order accuracy.
 *
 * Each operator returns StateRates describing dm/dt, dU/dt, dT/dt, etc.
 */

import { SimulationState, FlowNode } from '../types';
import {
  RateOperator,
  ConstraintOperator,
  StateRates,
  createZeroRates,
} from '../rk45-solver';
import { cloneSimulationState } from '../solver';
import * as Water from '../water-properties';
import { simulationConfig } from '../types';

// ============================================================================
// Conduction Rate Operator
// ============================================================================

export class ConductionRateOperator implements RateOperator {
  name = 'Conduction';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    // For each thermal connection, compute heat flow rate
    for (const conn of state.thermalConnections) {
      const node1 = state.thermalNodes.get(conn.fromNodeId);
      const node2 = state.thermalNodes.get(conn.toNodeId);

      if (!node1 || !node2) continue;

      // Heat flow from node1 to node2 (W)
      const Q = conn.conductance * (node1.temperature - node2.temperature);

      // Temperature rate: dT/dt = Q / (m * cp)
      const dT1 = -Q / (node1.mass * node1.specificHeat);
      const dT2 = Q / (node2.mass * node2.specificHeat);

      // Accumulate rates
      const existing1 = rates.thermalNodes.get(conn.fromNodeId) || { dTemperature: 0 };
      rates.thermalNodes.set(conn.fromNodeId, { dTemperature: existing1.dTemperature + dT1 });

      const existing2 = rates.thermalNodes.get(conn.toNodeId) || { dTemperature: 0 };
      rates.thermalNodes.set(conn.toNodeId, { dTemperature: existing2.dTemperature + dT2 });
    }

    return rates;
  }
}

// ============================================================================
// Convection Rate Operator
// ============================================================================

export class ConvectionRateOperator implements RateOperator {
  name = 'Convection';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const conn of state.convectionConnections) {
      const thermalNode = state.thermalNodes.get(conn.thermalNodeId);
      const flowNode = state.flowNodes.get(conn.flowNodeId);

      if (!thermalNode || !flowNode) continue;

      // Heat transfer coefficient
      const h = this.computeHeatTransferCoeff(flowNode, state);
      const Q = h * conn.surfaceArea * (thermalNode.temperature - flowNode.fluid.temperature);

      // Solid temperature rate
      const dT_solid = -Q / (thermalNode.mass * thermalNode.specificHeat);

      // Fluid energy rate (positive Q means heat INTO fluid)
      const dU_fluid = Q;

      // Accumulate rates
      const existingThermal = rates.thermalNodes.get(conn.thermalNodeId) || { dTemperature: 0 };
      rates.thermalNodes.set(conn.thermalNodeId, {
        dTemperature: existingThermal.dTemperature + dT_solid,
      });

      const existingFlow = rates.flowNodes.get(conn.flowNodeId) || { dMass: 0, dEnergy: 0 };
      rates.flowNodes.set(conn.flowNodeId, {
        dMass: existingFlow.dMass,
        dEnergy: existingFlow.dEnergy + dU_fluid,
      });
    }

    return rates;
  }

  private computeHeatTransferCoeff(flowNode: FlowNode, state: SimulationState): number {
    const fluid = flowNode.fluid;

    // Get flow rate through this node
    let totalMassFlow = 0;
    for (const conn of state.flowConnections) {
      if (conn.fromNodeId === flowNode.id || conn.toNodeId === flowNode.id) {
        totalMassFlow += Math.abs(conn.massFlowRate);
      }
    }

    // Fluid properties
    const rho = fluid.mass / flowNode.volume;
    const mu = fluid.phase === 'liquid' ? 0.0003 : 0.00002; // Pa·s
    const k = fluid.phase === 'liquid' ? 0.6 : 0.03; // W/m-K
    const Pr = fluid.phase === 'liquid' ? 2.0 : 1.0;

    const D = flowNode.hydraulicDiameter;
    const A = flowNode.flowArea;

    // Velocity from mass flow
    const velocity = totalMassFlow / (rho * A);

    // Reynolds number
    const Re = rho * velocity * D / mu;

    // Minimum h for natural convection
    const h_natural = 500; // W/m²-K

    if (Re < 2300) {
      return h_natural;
    }

    // Turbulent: Dittus-Boelter correlation
    const Nu = 0.023 * Math.pow(Re, 0.8) * Math.pow(Pr, 0.4);
    const h_forced = Nu * k / D;

    return Math.max(h_natural, h_forced);
  }
}

// ============================================================================
// Heat Generation Rate Operator (for reactor cores)
// ============================================================================

export class HeatGenerationRateOperator implements RateOperator {
  name = 'HeatGeneration';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    // Add heat generation to thermal nodes
    for (const [id, node] of state.thermalNodes) {
      if (node.heatGeneration > 0) {
        // For fuel nodes linked to neutronics, use reactor power
        if (id === state.neutronics.fuelNodeId || id.includes('fuel')) {
          const power = state.neutronics.power;
          const dT = power / (node.mass * node.specificHeat);
          rates.thermalNodes.set(id, { dTemperature: dT });
        } else {
          // Other heat-generating nodes use their fixed rate
          const dT = node.heatGeneration / (node.mass * node.specificHeat);
          rates.thermalNodes.set(id, { dTemperature: dT });
        }
      }
    }

    return rates;
  }
}

// ============================================================================
// Neutronics Rate Operator
// ============================================================================

export class NeutronicsRateOperator implements RateOperator {
  name = 'Neutronics';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();
    const n = state.neutronics;

    // If no core is linked, no neutronics rates
    if (!n.coreId) {
      return rates;
    }

    // Point kinetics equations:
    // dN/dt = (ρ - β) / Λ * N + λ * C
    // dC/dt = β / Λ * N - λ * C

    const rho = this.computeTotalReactivity(n, state);
    const beta = n.delayedNeutronFraction;
    const Lambda = n.promptNeutronLifetime;
    const lambda = n.precursorDecayConstant;

    // Normalized power
    const N = n.power / n.nominalPower;
    const C = n.precursorConcentration;

    // Rate equations
    const dN_dt = (rho - beta) / Lambda * N + lambda * C;
    const dC_dt = beta / Lambda * N - lambda * C;

    // Convert back to absolute power rate
    rates.neutronics.dPower = dN_dt * n.nominalPower;
    rates.neutronics.dPrecursorConcentration = dC_dt;

    return rates;
  }

  private computeTotalReactivity(n: any, state: SimulationState): number {
    // Control rod contribution
    const rhoRods = -n.controlRodWorth * (1 - n.controlRodPosition);

    // Fuel temperature feedback (Doppler)
    const fuelTemp = this.getAverageFuelTemperature(state, n);
    const dT_fuel = fuelTemp - n.refFuelTemp;
    const rhoDoppler = n.fuelTempCoeff * dT_fuel;

    // Coolant temperature feedback
    const coolantTemp = this.getAverageCoolantTemperature(state, n);
    const dT_coolant = coolantTemp - n.refCoolantTemp;
    const rhoCoolantTemp = n.coolantTempCoeff * dT_coolant;

    // Coolant density feedback
    const coolantDensity = this.getAverageCoolantDensity(state, n);
    const dRho_coolant = coolantDensity - n.refCoolantDensity;
    const rhoCoolantDensity = n.coolantDensityCoeff * dRho_coolant;

    return rhoRods + rhoDoppler + rhoCoolantTemp + rhoCoolantDensity;
  }

  private getAverageFuelTemperature(state: SimulationState, n: any): number {
    if (n.fuelNodeId) {
      const fuelNode = state.thermalNodes.get(n.fuelNodeId);
      if (fuelNode) return fuelNode.temperature;
    }
    for (const [, node] of state.thermalNodes) {
      if (node.label.toLowerCase().includes('fuel')) {
        return node.temperature;
      }
    }
    return n.refFuelTemp;
  }

  private getAverageCoolantTemperature(state: SimulationState, n: any): number {
    if (n.coolantNodeId) {
      const coolantNode = state.flowNodes.get(n.coolantNodeId);
      if (coolantNode) return coolantNode.fluid.temperature;
    }
    for (const [, node] of state.flowNodes) {
      if (node.label.toLowerCase().includes('coolant') || node.label.toLowerCase().includes('core')) {
        return node.fluid.temperature;
      }
    }
    return n.refCoolantTemp;
  }

  private getAverageCoolantDensity(state: SimulationState, n: any): number {
    if (n.coolantNodeId) {
      const coolantNode = state.flowNodes.get(n.coolantNodeId);
      if (coolantNode) return coolantNode.fluid.mass / coolantNode.volume;
    }
    for (const [, node] of state.flowNodes) {
      if (node.label.toLowerCase().includes('coolant') || node.label.toLowerCase().includes('core')) {
        return node.fluid.mass / node.volume;
      }
    }
    return n.refCoolantDensity;
  }
}

// ============================================================================
// Flow Rate Operator - Mass and Energy Transport
// ============================================================================

export class FlowRateOperator implements RateOperator {
  name = 'FluidFlow';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    // Initialize all flow nodes with zero rates
    for (const [id] of state.flowNodes) {
      rates.flowNodes.set(id, { dMass: 0, dEnergy: 0 });
    }

    // For each flow connection, compute mass and energy transfer rates
    for (const conn of state.flowConnections) {
      const fromNode = state.flowNodes.get(conn.fromNodeId);
      const toNode = state.flowNodes.get(conn.toNodeId);

      if (!fromNode || !toNode) continue;

      // Use current flow rate (computed by flow dynamics)
      const massFlow = conn.massFlowRate; // kg/s

      // Determine which node is upstream based on flow direction
      let upstreamNode: FlowNode;
      let upstreamId: string;
      let downstreamId: string;
      let upstreamElevation: number | undefined;

      if (massFlow >= 0) {
        upstreamNode = fromNode;
        upstreamId = conn.fromNodeId;
        downstreamId = conn.toNodeId;
        upstreamElevation = conn.fromElevation;
      } else {
        upstreamNode = toNode;
        upstreamId = conn.toNodeId;
        downstreamId = conn.fromNodeId;
        upstreamElevation = conn.toElevation;
      }

      const absMassFlow = Math.abs(massFlow);

      // Determine what phase is actually flowing based on connection elevation
      // For two-phase nodes, we need to use phase-specific enthalpy
      const flowPhase = this.getFlowPhase(upstreamNode, upstreamElevation);

      // Get specific enthalpy based on what's actually flowing
      const h_up = this.getSpecificEnthalpy(upstreamNode, flowPhase);

      // Energy flow rate = mass flow * specific enthalpy
      const energyFlow = absMassFlow * h_up;

      // Update rates: upstream loses mass/energy, downstream gains
      const upRates = rates.flowNodes.get(upstreamId)!;
      const downRates = rates.flowNodes.get(downstreamId)!;

      upRates.dMass -= absMassFlow;
      upRates.dEnergy -= energyFlow;

      downRates.dMass += absMassFlow;
      downRates.dEnergy += energyFlow;
    }

    return rates;
  }

  /**
   * Determine what phase of fluid is flowing based on connection elevation
   * relative to liquid level in a two-phase node.
   */
  private getFlowPhase(node: FlowNode, connectionElevation?: number): 'liquid' | 'vapor' | 'mixture' {
    // Single phase nodes always flow their phase
    if (node.fluid.phase !== 'two-phase') {
      return node.fluid.phase === 'vapor' ? 'vapor' : 'liquid';
    }

    // Estimate node height (assume cylindrical with height ≈ diameter)
    const nodeHeight = Math.sqrt(node.volume / (Math.PI * 0.25));

    // If no elevation specified, assume mid-height connection (mixture)
    if (connectionElevation === undefined) {
      connectionElevation = nodeHeight / 2;
    }

    // Calculate liquid level from quality
    const quality = node.fluid.quality ?? 0.5;
    const T_C = node.fluid.temperature - 273.15;

    // Approximate saturated liquid/vapor densities
    const rho_liquid = T_C < 100 ? 1000 - 0.08 * T_C :
                       T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                       700 - 2.5 * (T_C - 300);
    const rho_vapor = node.fluid.pressure * 0.018 / (8.314 * node.fluid.temperature);

    // Void fraction = vapor volume / total volume
    // α = x * ρ_l / (x * ρ_l + (1-x) * ρ_v)  where x is quality
    const voidFraction = (quality * rho_liquid) / (quality * rho_liquid + (1 - quality) * rho_vapor);

    // Liquid level (assuming liquid settles at bottom)
    const liquidLevel = nodeHeight * (1 - voidFraction);

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
   * Get specific enthalpy of the flowing phase.
   * h = u + Pv for the phase actually being drawn from the node.
   */
  private getSpecificEnthalpy(node: FlowNode, flowPhase: 'liquid' | 'vapor' | 'mixture'): number {
    const P = node.fluid.pressure;
    const T = node.fluid.temperature;
    const T_C = T - 273.15;

    // For single-phase or mixture, use bulk average
    if (node.fluid.phase !== 'two-phase' || flowPhase === 'mixture') {
      const u = node.fluid.internalEnergy / node.fluid.mass;
      const v = node.volume / node.fluid.mass;
      return u + P * v;
    }

    // For two-phase node drawing from specific phase, use phase-specific properties
    if (flowPhase === 'liquid') {
      // Saturated liquid specific internal energy
      // u_f ≈ c_p * (T - T_ref) where c_p ≈ 4186 J/kg/K for water
      const u_f = 4186 * T_C; // J/kg relative to 0°C

      // Saturated liquid specific volume (approximate)
      const rho_f = T_C < 100 ? 1000 - 0.08 * T_C :
                    T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                    700 - 2.5 * (T_C - 300);
      const v_f = 1 / rho_f;

      // Specific enthalpy h_f = u_f + P*v_f
      return u_f + P * v_f;
    } else {
      // Saturated vapor specific internal energy
      // u_g = u_f + u_fg where u_fg ≈ h_fg - P*(v_g - v_f) ≈ h_fg - P*v_g
      // h_fg varies from ~2257 kJ/kg at 100°C to ~1000 kJ/kg near critical
      const u_f = 4186 * T_C;

      // Approximate h_fg (latent heat)
      const P_bar = P / 1e5;
      const h_fg = P_bar < 10 ? 2200e3 :
                   P_bar < 100 ? 2200e3 - (P_bar - 10) * 10e3 :
                   1300e3 - (P_bar - 100) * 10e3;

      // Saturated vapor specific volume
      const rho_g = P * 0.018 / (8.314 * T);
      const v_g = 1 / rho_g;

      // u_g ≈ u_f + h_fg - P*v_g (from h = u + Pv and h_g = h_f + h_fg)
      const u_g = u_f + h_fg - P * v_g;

      // Specific enthalpy h_g = u_g + P*v_g = u_f + h_fg
      return u_g + P * v_g;
    }
  }
}

// ============================================================================
// Turbine/Condenser Rate Operator
// ============================================================================

export class TurbineCondenserRateOperator implements RateOperator {
  name = 'TurbineCondenser';

  private turbineInletNodeId = 'turbine-inlet';
  private turbineOutletNodeId = 'turbine-outlet';
  private condenserNodeId = 'condenser';
  private turbineEfficiency = 0.87;
  private condenserUA = 10e6; // W/K
  private heatSinkTemp = 300; // K

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    // Initialize
    for (const [id] of state.flowNodes) {
      rates.flowNodes.set(id, { dMass: 0, dEnergy: 0 });
    }

    // Turbine: extract work from steam expansion
    const inletNode = state.flowNodes.get(this.turbineInletNodeId);
    const outletNode = state.flowNodes.get(this.turbineOutletNodeId);

    if (inletNode && outletNode) {
      // Find flow through turbine
      let massFlowRate = 0;
      for (const conn of state.flowConnections) {
        if (conn.fromNodeId === this.turbineInletNodeId && conn.toNodeId === this.turbineOutletNodeId) {
          massFlowRate = Math.abs(conn.massFlowRate);
          break;
        }
      }

      if (massFlowRate > 1 && inletNode.fluid.phase !== 'liquid') {
        const P_in = inletNode.fluid.pressure;
        const P_out = outletNode.fluid.pressure;

        if (P_in > P_out) {
          // Compute enthalpy at inlet
          const u_in = inletNode.fluid.internalEnergy / inletNode.fluid.mass;
          const v_in = inletNode.volume / inletNode.fluid.mass;
          const h_in = u_in + P_in * v_in;

          // Approximate isentropic expansion
          const pressureRatio = P_out / P_in;
          const h_out_ideal = h_in * Math.pow(pressureRatio, 0.3);
          const deltaH = this.turbineEfficiency * (h_in - h_out_ideal);

          // Power extracted
          const power = massFlowRate * deltaH;

          // Remove energy from outlet node
          const outRates = rates.flowNodes.get(this.turbineOutletNodeId);
          if (outRates) {
            outRates.dEnergy -= power;
          }
        }
      }
    }

    // Condenser: remove heat to ultimate heat sink
    const condenserNode = state.flowNodes.get(this.condenserNodeId);
    if (condenserNode) {
      const T_sat = condenserNode.fluid.temperature;
      const T_sink = this.heatSinkTemp;

      let heatRate = this.condenserUA * Math.max(0, T_sat - T_sink);

      // Limit based on quality
      const quality = condenserNode.fluid.quality ?? 0;
      if (quality < 0.1) {
        heatRate *= quality / 0.1;
      }

      // Cap heat rate
      heatRate = Math.min(heatRate, 800e6);

      const condRates = rates.flowNodes.get(this.condenserNodeId);
      if (condRates) {
        condRates.dEnergy -= heatRate;
      }
    }

    return rates;
  }
}

// ============================================================================
// Fluid State Constraint Operator
// ============================================================================

export class FluidStateConstraintOperator implements ConstraintOperator {
  name = 'FluidState';

  applyConstraints(state: SimulationState): SimulationState {
    const newState = cloneSimulationState(state);

    // Update fluid properties (T, P, phase) from (m, U, V)
    for (const [nodeId, flowNode] of newState.flowNodes) {
      const waterState = Water.calculateState(
        flowNode.fluid.mass,
        flowNode.fluid.internalEnergy,
        flowNode.volume
      );

      // Update temperature and phase
      flowNode.fluid.temperature = waterState.temperature;
      flowNode.fluid.phase = waterState.phase;
      flowNode.fluid.quality = waterState.quality;

      // Determine pressure based on phase
      if (waterState.phase === 'two-phase' || waterState.phase === 'vapor') {
        flowNode.fluid.pressure = waterState.pressure;
      } else {
        // Liquid: use pressure model
        const v_specific = flowNode.volume / flowNode.fluid.mass;

        if (simulationConfig.pressureModel === 'pure-triangulation') {
          flowNode.fluid.pressure = waterState.pressure;
        } else {
          // Hybrid model with bulk modulus
          const P_base = newState.liquidBasePressures?.get(nodeId) ?? waterState.pressure;
          const rho_current = flowNode.fluid.mass / flowNode.volume;
          const rho_base = 1 / v_specific;
          const K = Water.bulkModulus(waterState.temperature - 273.15);
          const dP = K * (rho_current - rho_base) / rho_base;
          flowNode.fluid.pressure = P_base + dP;
        }
      }

      // Sanity checks
      if (!isFinite(flowNode.fluid.temperature) || flowNode.fluid.temperature < 200 || flowNode.fluid.temperature > 2000) {
        console.warn(`[FluidState] Invalid temperature in ${nodeId}: ${flowNode.fluid.temperature}K`);
        flowNode.fluid.temperature = Math.max(280, Math.min(700, flowNode.fluid.temperature || 300));
      }
      if (!isFinite(flowNode.fluid.pressure) || flowNode.fluid.pressure < 1000 || flowNode.fluid.pressure > 50e6) {
        console.warn(`[FluidState] Invalid pressure in ${nodeId}: ${flowNode.fluid.pressure}Pa`);
        flowNode.fluid.pressure = Math.max(1e5, Math.min(20e6, flowNode.fluid.pressure || 1e6));
      }
    }

    return newState;
  }
}

// ============================================================================
// Flow Dynamics Constraint Operator
// ============================================================================
//
// NOTE: With inertial flow dynamics (FlowMomentumRateOperator), this operator
// should NOT set massFlowRate. Flow rate is now a state variable that gets
// integrated via the momentum equation. This operator only computes the
// steady-state target flow for debugging display purposes.

export class FlowDynamicsConstraintOperator implements ConstraintOperator {
  name = 'FlowDynamics';

  /**
   * Calculate pressure at a specific connection elevation within a node,
   * accounting for hydrostatic head within the node.
   */
  private getPressureAtConnection(node: FlowNode, connectionElevation?: number): number {
    const g = 9.81;
    const baseP = node.fluid.pressure;
    const nodeHeight = Math.sqrt(node.volume / (Math.PI * 0.25));

    if (connectionElevation === undefined) {
      connectionElevation = nodeHeight / 2;
    }

    if (node.fluid.phase === 'two-phase') {
      const quality = node.fluid.quality || 0;
      const T_C = node.fluid.temperature - 273.15;
      const rho_liquid = T_C < 100 ? 1000 - 0.08 * T_C :
                         T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                         700 - 2.5 * (T_C - 300);
      const rho_vapor = node.fluid.pressure * 0.018 / (8.314 * node.fluid.temperature);
      const voidFraction = (quality * rho_liquid) / (quality * rho_liquid + (1 - quality) * rho_vapor);
      const liquidLevel = nodeHeight * (1 - voidFraction);

      if (connectionElevation < liquidLevel) {
        return baseP + rho_liquid * g * (liquidLevel - connectionElevation);
      }
      return baseP;
    } else if (node.fluid.phase === 'liquid') {
      // Liquid nodes: base pressure is at top, add hydrostatic head below
      const rho = node.fluid.mass / node.volume;
      const liquidHead = nodeHeight - connectionElevation;
      return baseP + rho * g * liquidHead;
    }
    return baseP;
  }

  applyConstraints(state: SimulationState): SimulationState {
    const newState = cloneSimulationState(state);

    for (const conn of newState.flowConnections) {
      const fromNode = newState.flowNodes.get(conn.fromNodeId);
      const toNode = newState.flowNodes.get(conn.toNodeId);

      if (!fromNode || !toNode) continue;

      // Compute what the steady-state flow would be (for debugging/display)
      const targetFlow = this.computeSteadyStateFlow(conn, fromNode, toNode, newState);
      conn.targetFlowRate = targetFlow;
      conn.steadyStateFlow = targetFlow;

      // === PHYSICAL CONSTRAINTS ON FLOW ===

      // Running pumps act as check valves - clamp reverse flow to zero
      // This is a hard physical constraint that must be enforced after integration
      for (const [, pump] of newState.components.pumps) {
        if (pump.connectedFlowPath === conn.id && pump.running && pump.effectiveSpeed > 0.01) {
          if (conn.massFlowRate < 0) {
            // Reverse flow through a running pump is physically impossible
            // The impeller blocks backflow
            conn.massFlowRate = 0;
          }
          break;
        }
      }

      // Check valves prevent reverse flow
      const checkValve = newState.components.checkValves?.get(conn.id);
      if (checkValve && conn.massFlowRate < 0) {
        conn.massFlowRate = 0;
      }
    }

    return newState;
  }

  private computeSteadyStateFlow(
    conn: any,
    fromNode: FlowNode,
    toNode: FlowNode,
    state: SimulationState
  ): number {
    // Pressure difference with hydrostatic adjustment at connection points
    const P_from = this.getPressureAtConnection(fromNode, conn.fromElevation);
    const P_to = this.getPressureAtConnection(toNode, conn.toElevation);
    const dP_pressure = P_from - P_to;

    // Gravity head
    const rho_avg = (fromNode.fluid.mass / fromNode.volume + toNode.fluid.mass / toNode.volume) / 2;
    const dz = conn.elevation || 0;
    const dP_gravity = -rho_avg * 9.81 * dz;

    // Pump head
    let dP_pump = 0;
    for (const [, pump] of state.components.pumps) {
      if (pump.connectedFlowPath === conn.id && pump.running && pump.effectiveSpeed > 0) {
        dP_pump = pump.effectiveSpeed * pump.ratedHead * rho_avg * 9.81;
      }
    }

    // Valve position
    let valveOpenFraction = 1.0;
    for (const [, valve] of state.components.valves) {
      if (valve.connectedFlowPath === conn.id) {
        valveOpenFraction = valve.position;
      }
    }

    if (valveOpenFraction < 0.01) {
      return 0; // Valve closed
    }

    // Total driving pressure
    const dP_total = dP_pressure + dP_gravity + dP_pump;

    // Flow from steady-state momentum: dP = K * (1/2) * rho * v²
    const K = (conn.resistanceCoeff || 10) / Math.pow(valveOpenFraction, 2);
    const A = conn.flowArea || 0.1;

    const sign = dP_total >= 0 ? 1 : -1;
    const v = sign * Math.sqrt(2 * Math.abs(dP_total) / (K * rho_avg));
    const massFlow = rho_avg * A * v;

    return massFlow;
  }
}

// ============================================================================
// Pump Speed Rate Operator
// ============================================================================

/**
 * Computes the rate of change of pump effectiveSpeed based on ramp-up/coast-down
 * dynamics. This integrates properly with the RK45 solver.
 *
 * When pump is running: dEffectiveSpeed/dt = targetSpeed / rampUpTime
 * When pump is stopped: dEffectiveSpeed/dt = -effectiveSpeed / coastDownTime
 */
export class PumpSpeedRateOperator implements RateOperator {
  name = 'PumpSpeed';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const [id, pump] of state.components.pumps) {
      let dEffectiveSpeed = 0;

      if (pump.running) {
        const targetSpeed = pump.speed;
        if (pump.effectiveSpeed < targetSpeed) {
          // Ramp up: constant rate to reach target in rampUpTime
          dEffectiveSpeed = targetSpeed / pump.rampUpTime;
        } else if (pump.effectiveSpeed > targetSpeed) {
          // Speed reduced: coast down to new target
          dEffectiveSpeed = -1.0 / pump.coastDownTime;
        }
        // else: at target, no change needed
      } else {
        // Pump stopped: coast down to zero
        if (pump.effectiveSpeed > 0) {
          dEffectiveSpeed = -1.0 / pump.coastDownTime;
        }
      }

      if (dEffectiveSpeed !== 0) {
        rates.pumps.set(id, { dEffectiveSpeed });
      }
    }

    return rates;
  }
}

// ============================================================================
// Pump Speed Constraint Operator (DEPRECATED - kept for backwards compatibility)
// ============================================================================

/**
 * @deprecated Use PumpSpeedRateOperator instead. This constraint-based approach
 * doesn't work well with RK45 because constraint operators don't receive dt.
 */
export class PumpSpeedConstraintOperator implements ConstraintOperator {
  name = 'PumpSpeed';

  applyConstraints(state: SimulationState): SimulationState {
    // This operator is deprecated - pump speeds are now handled by PumpSpeedRateOperator
    // Just return the state unchanged
    return state;
  }

  reset(): void {
    // No-op
  }
}

// ============================================================================
// Flow Momentum Rate Operator
// ============================================================================

/**
 * Computes the rate of change of mass flow rate for each flow connection
 * using the momentum equation:
 *
 *   ρ * (L/A) * dv/dt = ΔP - friction
 *
 * where:
 *   - L/A is the inertance (length / flow area)
 *   - ΔP is the net driving pressure (pressure diff + gravity + pump)
 *   - friction = K * 0.5 * ρ * v²
 *
 * Converting to mass flow rate ṁ = ρ * A * v:
 *   dṁ/dt = A * (ΔP - friction) / inertance
 */
export class FlowMomentumRateOperator implements RateOperator {
  name = 'FlowMomentum';

  /**
   * Calculate pressure at a specific connection elevation within a node,
   * accounting for hydrostatic head within the node.
   */
  private getPressureAtConnection(node: FlowNode, connectionElevation?: number): number {
    const g = 9.81;
    const baseP = node.fluid.pressure;

    // Estimate node height (assume cylindrical with height ≈ diameter)
    const nodeHeight = Math.sqrt(node.volume / (Math.PI * 0.25));

    if (connectionElevation === undefined) {
      connectionElevation = nodeHeight / 2;
    }

    if (node.fluid.phase === 'two-phase') {
      // Calculate liquid level from quality
      const quality = node.fluid.quality || 0;
      // Approximate liquid/vapor densities
      const T_C = node.fluid.temperature - 273.15;
      const rho_liquid = T_C < 100 ? 1000 - 0.08 * T_C :
                         T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                         700 - 2.5 * (T_C - 300);
      const rho_vapor = node.fluid.pressure * 0.018 / (8.314 * node.fluid.temperature);

      // Void fraction and liquid level
      const voidFraction = (quality * rho_liquid) / (quality * rho_liquid + (1 - quality) * rho_vapor);
      const liquidVolumeFraction = 1 - voidFraction;
      const liquidLevel = nodeHeight * liquidVolumeFraction;

      if (connectionElevation < liquidLevel) {
        // Below liquid: add hydrostatic head
        return baseP + rho_liquid * g * (liquidLevel - connectionElevation);
      }
      return baseP;  // In steam space
    } else if (node.fluid.phase === 'liquid') {
      // Liquid nodes: base pressure is at top, add hydrostatic head below
      const rho = node.fluid.mass / node.volume;
      const liquidHead = nodeHeight - connectionElevation;
      return baseP + rho * g * liquidHead;
    }

    return baseP;  // Vapor - no adjustment
  }

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const conn of state.flowConnections) {
      const fromNode = state.flowNodes.get(conn.fromNodeId);
      const toNode = state.flowNodes.get(conn.toNodeId);

      if (!fromNode || !toNode) continue;

      // Get pipe length L for momentum equation
      // Standard inertance I = ρL/A, and ΔP = I * dQ/dt where Q = v*A
      // This gives: ΔP = ρL/A * A * dv/dt = ρL * dv/dt
      // So: dv/dt = ΔP / (ρ * L)
      // We store just L here; density is applied separately
      let L = conn.length;
      if (!L || L <= 0) {
        L = 10; // Default 10m pipe length
      }

      // Current flow state
      const currentFlow = conn.massFlowRate;
      const A = conn.flowArea || 0.1;

      // Densities for momentum calculations
      const rho_from = fromNode.fluid.mass / fromNode.volume;
      const rho_to = toNode.fluid.mass / toNode.volume;

      // For momentum/inertia, use upstream density - that's the fluid actually moving
      // For positive flow (from->to), upstream is fromNode
      // For negative flow (to->from), upstream is toNode
      const rho_upstream = currentFlow >= 0 ? rho_from : rho_to;

      // Average density for things that depend on both ends (like hydrostatic head in the connection)
      const rho_avg = (rho_from + rho_to) / 2;

      // Current velocity - use upstream density since that's what's flowing
      const v = currentFlow / (rho_upstream * A);

      // === Driving pressures ===

      // Pressure difference at connection points, with hydrostatic adjustment
      // This accounts for liquid head within each node based on connection elevation
      const P_from = this.getPressureAtConnection(fromNode, conn.fromElevation);
      const P_to = this.getPressureAtConnection(toNode, conn.toElevation);
      const dP_pressure = P_from - P_to;

      // Gravity head (positive = downward flow is favored)
      const g = 9.81;
      const dz = conn.elevation || 0; // positive = upward
      const dP_gravity = -rho_avg * g * dz; // negative if going up

      // Pump head - need to determine correct density for pump suction
      let dP_pump = 0;
      for (const [, pump] of state.components.pumps) {
        if (pump.connectedFlowPath === conn.id && pump.running && pump.effectiveSpeed > 0) {
          // For two-phase suction, pumps draw from the bottom (liquid) if available
          const upstreamNode = currentFlow >= 0 ? fromNode : toNode;
          let pumpRho = rho_upstream; // Default to upstream density

          if (upstreamNode.fluid.phase === 'two-phase' && upstreamNode.fluid.quality !== undefined) {
            // Check if there's enough liquid to draw from
            const liquidFraction = 1 - upstreamNode.fluid.quality;
            const liquidMass = upstreamNode.fluid.mass * liquidFraction;

            // If there's significant liquid (more than 10kg), use liquid density
            if (liquidMass > 10) {
              // Approximate saturated liquid density
              const T_C = upstreamNode.fluid.temperature - 273.15;
              pumpRho = T_C < 100 ? 1000 - 0.08 * T_C :
                        T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                        700 - 2.5 * (T_C - 300);
            }
            // Otherwise use mixture density (pump is cavitating)
          }

          dP_pump = pump.effectiveSpeed * pump.ratedHead * pumpRho * g;
        }
      }

      // === Resistances ===

      // Valve position affects resistance
      let valveOpenFraction = 1.0;
      for (const [, valve] of state.components.valves) {
        if (valve.connectedFlowPath === conn.id) {
          valveOpenFraction = valve.position;
        }
      }

      // If valve is closed, flow rate should decay to zero
      if (valveOpenFraction < 0.01) {
        // Apply strong damping to bring flow to zero
        // dṁ/dt = -ṁ / τ where τ is a short time constant
        const tau = 0.1; // 100ms decay time
        rates.flowConnections.set(conn.id, { dMassFlowRate: -currentFlow / tau });
        continue;
      }

      // === Total driving pressure (computed early for pump/valve checks) ===
      const dP_driving = dP_pressure + dP_gravity + dP_pump;

      // Check valve - prevents reverse flow and requires cracking pressure to open
      const checkValve = state.components.checkValves?.get(conn.id);
      if (checkValve) {
        const crackingPressure = checkValve.crackingPressure ?? 0;
        // Check valve remains closed if:
        // 1. Driving pressure is below cracking pressure (not enough to open)
        // 2. OR driving pressure is negative (trying to reverse)
        if (dP_driving < crackingPressure) {
          // Check valve is closed - decay flow to zero
          const tau = 0.1;
          rates.flowConnections.set(conn.id, { dMassFlowRate: -currentFlow / tau });
          continue;
        }
      }

      // Running pumps act as check valves - prevent reverse flow
      // The constraint operator will clamp flow to >= 0 after each step,
      // but we also need to prevent the rate equation from driving flow negative
      let pumpOnThisConnection: { running: boolean; effectiveSpeed: number } | undefined;
      for (const [, pump] of state.components.pumps) {
        if (pump.connectedFlowPath === conn.id) {
          pumpOnThisConnection = pump;
          break;
        }
      }
      if (pumpOnThisConnection && pumpOnThisConnection.running && pumpOnThisConnection.effectiveSpeed > 0.01) {
        // If flow is at or near zero and pressure would drive it backward, prevent acceleration
        // The pump impeller physically blocks reverse flow
        if (currentFlow <= 0 && dP_driving < 0) {
          // No acceleration - pump holds flow at zero
          rates.flowConnections.set(conn.id, { dMassFlowRate: 0 });
          continue;
        }
        // If flow is small positive but about to go negative, also prevent
        if (currentFlow > 0 && currentFlow < 1 && dP_driving < 0) {
          // Clamp acceleration to prevent going negative
          rates.flowConnections.set(conn.id, { dMassFlowRate: 0 });
          continue;
        }
      }

      // Resistance coefficient (K-factor)
      const K_base = conn.resistanceCoeff || 10;
      // Valve increases resistance as it closes: K_eff = K_base / position²
      const K_eff = K_base / Math.pow(valveOpenFraction, 2);

      // === Momentum equation ===

      // Friction pressure drop (always opposes flow direction)
      // dP_friction = -K * 0.5 * ρ * v * |v|  (negative when flow is positive)
      // Uses upstream density since that's the fluid experiencing the friction
      const dP_friction = -K_eff * 0.5 * rho_upstream * v * Math.abs(v);

      // Net accelerating pressure
      const dP_net = dP_driving + dP_friction;

      // Momentum equation: ΔP = ρ * L * dv/dt  (from inertance I = ρL/A, ΔP = I * dQ/dt where Q = v*A)
      // dv/dt = ΔP / (ρ * L)
      // Uses upstream density - that's the fluid being accelerated
      const dv_dt = dP_net / (rho_upstream * L);

      // Convert velocity rate to mass flow rate:
      // ṁ = ρ * A * v
      // dṁ/dt = ρ * A * dv/dt  (assuming ρ changes slowly)
      // Uses upstream density since that's what's flowing
      const dMassFlowRate = rho_upstream * A * dv_dt;

      // DEBUG: Log momentum equation details for pum-5
      if (conn.id.includes('pum-5') || conn.fromNodeId.includes('pum-5') || conn.toNodeId.includes('pum-5')) {
        console.log(`[FlowMomentum DEBUG] ${conn.id}:`);
        console.log(`  Pressures: P_from=${(P_from/1e5).toFixed(2)} bar, P_to=${(P_to/1e5).toFixed(2)} bar, dP_pressure=${(dP_pressure/1e5).toFixed(2)} bar`);
        console.log(`  Driving: dP_gravity=${(dP_gravity/1e5).toFixed(3)} bar, dP_pump=${(dP_pump/1e5).toFixed(2)} bar, dP_driving=${(dP_driving/1e5).toFixed(2)} bar`);
        console.log(`  Densities: rho_from=${rho_from.toFixed(1)}, rho_to=${rho_to.toFixed(1)}, rho_upstream=${rho_upstream.toFixed(1)} kg/m³`);
        console.log(`  Flow: currentFlow=${currentFlow.toFixed(1)} kg/s, v=${v.toFixed(2)} m/s, A=${A.toFixed(4)} m²`);
        console.log(`  Friction: K_eff=${K_eff.toFixed(1)}, dP_friction=${(dP_friction/1e5).toFixed(3)} bar`);
        console.log(`  Momentum: L=${L.toFixed(1)} m, dP_net=${(dP_net/1e5).toFixed(2)} bar`);
        console.log(`  Result: dv_dt=${dv_dt.toFixed(2)} m/s², dMassFlowRate=${dMassFlowRate.toFixed(2)} kg/s²`);
      }

      rates.flowConnections.set(conn.id, { dMassFlowRate });
    }

    return rates;
  }
}
