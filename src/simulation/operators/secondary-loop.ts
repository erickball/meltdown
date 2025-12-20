/**
 * Secondary Loop Operator
 *
 * Handles the thermodynamics of the secondary (steam/power) side:
 * - Turbine: Adiabatic expansion from SG pressure to condenser pressure
 * - Condenser: Heat rejection to ultimate heat sink (cooling water)
 * - Feedwater pump: Pressurizes condensate back to SG pressure
 *
 * Physics:
 * - Turbine expansion is approximately isentropic (with efficiency factor)
 * - Condenser removes latent heat at constant (low) pressure
 * - Pump adds enthalpy equal to work done on the fluid
 *
 * Unlike the primary loop which uses detailed steam tables for everything,
 * the secondary loop uses simplified thermodynamic models since the exact
 * states are less critical for reactor safety simulation.
 */

import { SimulationState } from '../types';
import { PhysicsOperator, cloneSimulationState } from '../solver';

// ============================================================================
// Configuration
// ============================================================================

interface TurbineConfig {
  id: string;
  inletNodeId: string;       // e.g., 'turbine-inlet' (steam from SG)
  outletNodeId: string;      // e.g., 'turbine-outlet' (wet steam to condenser)
  efficiency: number;        // Isentropic efficiency (typically 0.85-0.92)
  nominalPower: number;      // W - design power output for display
}

interface CondenserConfig {
  id: string;
  flowNodeId: string;        // e.g., 'condenser'
  heatSinkTemp: number;      // K - ultimate heat sink temperature (cooling water)
  heatTransferCoeff: number; // W/K - UA for condenser
  targetPressure: number;    // Pa - target condenser vacuum (~10 kPa = 0.1 bar)
}

interface FeedwaterPumpConfig {
  id: string;
  connectedFlowPath: string; // Flow connection ID this pump drives
  targetPressure: number;    // Pa - discharge pressure (SG pressure + margin)
  efficiency: number;        // Pump efficiency (typically 0.8-0.9)
}

export interface SecondaryLoopConfig {
  turbines: TurbineConfig[];
  condensers: CondenserConfig[];
  feedwaterPumps: FeedwaterPumpConfig[];
}

// ============================================================================
// Secondary Loop State (for external access/display)
// ============================================================================

export interface SecondaryLoopState {
  turbinePower: number;           // W - total electrical power generated
  condenserHeatRejection: number; // W - heat rejected to cooling water
  feedwaterPumpWork: number;      // W - work done by feedwater pumps
  netPower: number;               // W - turbine power - pump work
}

// Module-level state for UI access
let lastSecondaryLoopState: SecondaryLoopState = {
  turbinePower: 0,
  condenserHeatRejection: 0,
  feedwaterPumpWork: 0,
  netPower: 0,
};

export function getSecondaryLoopState(): SecondaryLoopState {
  return { ...lastSecondaryLoopState };
}

// ============================================================================
// Secondary Loop Operator
// ============================================================================

export class SecondaryLoopOperator implements PhysicsOperator {
  name = 'SecondaryLoop';
  private config: SecondaryLoopConfig;

  constructor(config: SecondaryLoopConfig) {
    this.config = config;
  }

  apply(state: SimulationState, dt: number): SimulationState {
    const newState = cloneSimulationState(state);

    let totalTurbinePower = 0;
    let totalCondenserHeat = 0;
    let totalPumpWork = 0;

    // Process turbines
    for (const turbine of this.config.turbines) {
      const power = this.processTurbine(newState, turbine, dt);
      totalTurbinePower += power;
    }

    // Process condensers
    for (const condenser of this.config.condensers) {
      const heat = this.processCondenser(newState, condenser, dt);
      totalCondenserHeat += heat;
    }

    // Note: Feedwater pumps affect flow, which is handled by FlowOperator
    // Here we just track the work done for energy balance
    for (const pump of this.config.feedwaterPumps) {
      const work = this.calculatePumpWork(newState, pump);
      totalPumpWork += work;
    }

    // Update module state for UI
    lastSecondaryLoopState = {
      turbinePower: totalTurbinePower,
      condenserHeatRejection: totalCondenserHeat,
      feedwaterPumpWork: totalPumpWork,
      netPower: totalTurbinePower - totalPumpWork,
    };

    return newState;
  }

  getMaxStableDt(_state: SimulationState): number {
    // Secondary loop dynamics are slower than primary
    // The condenser is the limiting factor due to heat removal rate
    return 0.1; // 100 ms is fine
  }

  /**
   * Process turbine expansion
   *
   * The turbine extracts enthalpy from steam as it expands from inlet pressure
   * to outlet pressure. The expansion is approximately isentropic:
   *
   * h_out_ideal = h(s_in, P_out)  <- isentropic expansion
   * h_out_actual = h_in - η * (h_in - h_out_ideal)
   * Power = m_dot * (h_in - h_out_actual)
   *
   * For simplicity, we use a polynomial approximation instead of full
   * isentropic calculations.
   */
  private processTurbine(
    state: SimulationState,
    turbine: TurbineConfig,
    dt: number
  ): number {
    const inletNode = state.flowNodes.get(turbine.inletNodeId);
    const outletNode = state.flowNodes.get(turbine.outletNodeId);

    if (!inletNode || !outletNode) return 0;

    // Find flow rate through turbine (from flow connections)
    let massFlowRate = 0;
    for (const conn of state.flowConnections) {
      if (conn.fromNodeId === turbine.inletNodeId &&
          conn.toNodeId === turbine.outletNodeId) {
        massFlowRate = Math.abs(conn.massFlowRate);
        break;
      }
    }

    if (massFlowRate < 1) return 0; // No significant flow

    // Inlet conditions
    const P_in = inletNode.fluid.pressure;
    const phase_in = inletNode.fluid.phase;

    // Outlet conditions (target)
    const P_out = outletNode.fluid.pressure;

    // Skip if inlet is not steam or pressures are inverted
    if (phase_in === 'liquid' || P_in <= P_out) return 0;

    // Calculate specific enthalpy at inlet
    // h = u + Pv
    const u_in = inletNode.fluid.internalEnergy / inletNode.fluid.mass;
    const v_in = inletNode.volume / inletNode.fluid.mass;
    const h_in = u_in + P_in * v_in;

    // For isentropic expansion of steam:
    // Use simplified approximation based on pressure ratio
    // Actual turbine outlet enthalpy depends on inlet entropy and outlet pressure
    //
    // For saturated/superheated steam expanding to wet steam region:
    // The outlet will typically be two-phase (wet steam)
    //
    // Simplified model: enthalpy drop proportional to pressure ratio
    // This is a reasonable approximation for steam turbines
    const pressureRatio = P_out / P_in;

    // Approximate isentropic enthalpy drop
    // For steam: Δh_isentropic ≈ h_in * (1 - (P_out/P_in)^0.3) is a rough fit
    // This gives about 30-40% enthalpy extraction for typical 55 bar -> 0.1 bar expansion
    const h_out_ideal = h_in * Math.pow(pressureRatio, 0.3);
    const deltaH_ideal = h_in - h_out_ideal;

    // Apply turbine efficiency
    const deltaH_actual = turbine.efficiency * deltaH_ideal;
    // h_out_actual would be: h_in - deltaH_actual (not used currently)

    // Power extracted (W)
    const power = massFlowRate * deltaH_actual;

    // Update outlet node internal energy
    // The mass flow carries energy from inlet to outlet
    // Energy balance: outlet gains mass*h_out from flow
    // We need to remove the work extracted from the internal energy

    // Energy removed from the steam (goes to turbine shaft)
    const energyExtracted = power * dt;

    // Remove energy from outlet node (this represents the work extraction)
    // The actual enthalpy change is handled by the flow operator moving mass
    // We just need to account for the work extraction
    if (outletNode.fluid.internalEnergy > energyExtracted) {
      outletNode.fluid.internalEnergy -= energyExtracted;
    }

    return power;
  }

  /**
   * Process condenser heat rejection
   *
   * The condenser removes latent heat from wet steam to produce saturated liquid.
   * Heat is rejected to the ultimate heat sink (cooling water).
   *
   * Q = UA * (T_sat - T_cooling)
   * Q = m_dot * h_fg (if condensing)
   *
   * The condenser pressure is determined by equilibrium between heat rejection
   * rate and steam flow rate.
   */
  private processCondenser(
    state: SimulationState,
    condenser: CondenserConfig,
    dt: number
  ): number {
    const node = state.flowNodes.get(condenser.flowNodeId);
    if (!node) return 0;

    // Current condenser state
    const T_sat = node.fluid.temperature;
    const T_sink = condenser.heatSinkTemp;

    // Heat transfer rate (W)
    // Q = UA * LMTD, but simplified to just temperature difference
    let heatRate = condenser.heatTransferCoeff * Math.max(0, T_sat - T_sink);

    // Limit heat rejection to avoid overcooling
    // At steady state, should reject about 2/3 of thermal power (after turbine work extraction)
    // For 1 GW thermal, that's about 650 MW max
    const maxHeatRate = 800e6; // W
    heatRate = Math.min(heatRate, maxHeatRate);

    // Also limit based on quality - if mostly liquid, less latent heat to remove
    const quality = node.fluid.quality ?? 0;
    if (quality < 0.1) {
      // Mostly liquid - reduce heat removal to avoid subcooling too much
      heatRate *= quality / 0.1;
    }

    // Remove heat from the condenser node
    const energyRemoved = heatRate * dt;

    if (energyRemoved > 0 && node.fluid.internalEnergy > energyRemoved) {
      node.fluid.internalEnergy -= energyRemoved;
    }

    // The condenser should maintain low pressure through condensation
    // If we're above saturation conditions at target pressure, we need to
    // condense more steam. This is implicitly handled by removing energy
    // which will shift quality toward liquid.

    return heatRate;
  }

  /**
   * Calculate feedwater pump work
   *
   * W_pump = m_dot * v * ΔP / η
   *
   * For liquid, specific volume is approximately constant.
   */
  private calculatePumpWork(
    state: SimulationState,
    pump: FeedwaterPumpConfig
  ): number {
    // Find the flow connection for this pump
    let massFlowRate = 0;
    let suctionPressure = 0;

    for (const conn of state.flowConnections) {
      if (conn.id === pump.connectedFlowPath) {
        massFlowRate = Math.abs(conn.massFlowRate);

        // Get suction node pressure
        const suctionNode = state.flowNodes.get(conn.fromNodeId);
        if (suctionNode) {
          suctionPressure = suctionNode.fluid.pressure;
        }
        break;
      }
    }

    if (massFlowRate < 1 || suctionPressure <= 0) return 0;

    // Pressure rise across pump
    const deltaP = pump.targetPressure - suctionPressure;
    if (deltaP <= 0) return 0;

    // Specific volume of liquid (approximately 0.001 m³/kg at low temps)
    const v = 0.001;

    // Pump work = m_dot * v * ΔP / η
    const work = massFlowRate * v * deltaP / pump.efficiency;

    return work;
  }
}

// ============================================================================
// Helper: Create default secondary loop configuration
// ============================================================================

export function createDefaultSecondaryConfig(): SecondaryLoopConfig {
  return {
    turbines: [{
      id: 'hp-turbine',
      inletNodeId: 'turbine-inlet',
      outletNodeId: 'turbine-outlet',
      efficiency: 0.87,
      nominalPower: 333e6, // ~1/3 of thermal power
    }],
    condensers: [{
      id: 'main-condenser',
      flowNodeId: 'condenser',
      heatSinkTemp: 300, // K - cooling water at ~27°C
      heatTransferCoeff: 10e6, // W/K - sized for ~700 MW at 70K dT
      targetPressure: 1e5, // Pa - 1 bar (not full vacuum, for stability)
    }],
    feedwaterPumps: [{
      id: 'fw-pump',
      connectedFlowPath: 'flow-feedwater-sg',
      targetPressure: 5.5e6, // Pa - SG pressure (~55 bar)
      efficiency: 0.85,
    }],
  };
}
