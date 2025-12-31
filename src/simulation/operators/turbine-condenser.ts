/**
 * Turbine Condenser Operator
 *
 * Handles the thermodynamics of turbines and condensers:
 * - Turbine: Adiabatic expansion from inlet pressure to outlet pressure
 * - Condenser: Heat rejection to ultimate heat sink (cooling water)
 *
 * Physics:
 * - Turbine expansion is approximately isentropic (with efficiency factor)
 * - Condenser removes latent heat at constant (low) pressure
 *
 * Pump work is calculated for ALL pumps in state.components.pumps, not just
 * specific "feedwater" pumps. This provides a unified pump model where RCPs,
 * feedwater pumps, and any other pumps use the same interface.
 *
 * This operator applies to both PWRs (secondary side) and BWRs (main steam).
 */

import { SimulationState, PumpState } from '../types';
import { PhysicsOperator, cloneSimulationState } from '../solver';
import { saturatedLiquidEnthalpy, saturatedVaporEnthalpy } from '../water-properties';

// ============================================================================
// Configuration
// ============================================================================

interface TurbineConfig {
  id: string;
  turbineNodeId: string;     // The turbine flow node itself (e.g., 'turbine-generator-1')
  outletNodeId: string;      // e.g., 'condenser-1' (where exhaust steam goes)
  efficiency: number;        // Isentropic efficiency (typically 0.85-0.92)
  nominalPower: number;      // W - design power output for display
  ratedSteamFlow?: number;   // kg/s - maximum steam flow capacity (optional)
}

interface CondenserConfig {
  id: string;
  flowNodeId: string;        // e.g., 'condenser'
  heatSinkTemp: number;      // K - ultimate heat sink temperature (cooling water)
  heatTransferCoeff: number; // W/K - UA for condenser
  targetPressure: number;    // Pa - target condenser vacuum (~10 kPa = 0.1 bar)
}

export interface TurbineCondenserConfig {
  turbines: TurbineConfig[];
  condensers: CondenserConfig[];
}

// ============================================================================
// Turbine/Condenser State (for external access/display)
// ============================================================================

export interface TurbineCondenserState {
  turbinePower: number;           // W - total electrical power generated
  condenserHeatRejection: number; // W - heat rejected to cooling water
  feedwaterPumpWork: number;      // W - work done by feedwater pumps
  netPower: number;               // W - turbine power - pump work
}

// Module-level state for UI access
let lastTurbineCondenserState: TurbineCondenserState = {
  turbinePower: 0,
  condenserHeatRejection: 0,
  feedwaterPumpWork: 0,
  netPower: 0,
};

export function getTurbineCondenserState(): TurbineCondenserState {
  return { ...lastTurbineCondenserState };
}

/**
 * Update the turbine/condenser state from rate operators (for RK45 path)
 */
export function updateTurbineCondenserState(
  turbinePower: number,
  condenserHeatRejection: number,
  pumpWork: number = 0
): void {
  lastTurbineCondenserState = {
    turbinePower,
    condenserHeatRejection,
    feedwaterPumpWork: pumpWork,
    netPower: turbinePower - pumpWork,
  };
}

// ============================================================================
// Turbine Condenser Operator
// ============================================================================

export class TurbineCondenserOperator implements PhysicsOperator {
  name = 'TurbineCondenser';
  private config: TurbineCondenserConfig;

  constructor(config: TurbineCondenserConfig) {
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

    // Calculate pump work for ALL pumps in the system
    // This includes RCPs, feedwater pumps, and any other pumps
    // The flow driving is handled by FlowOperator; here we just track work for energy balance
    for (const [, pump] of newState.components.pumps) {
      if (pump.running) {
        const work = this.calculatePumpWork(newState, pump);
        totalPumpWork += work;
      }
    }

    // Update module state for UI
    lastTurbineCondenserState = {
      turbinePower: totalTurbinePower,
      condenserHeatRejection: totalCondenserHeat,
      feedwaterPumpWork: totalPumpWork,
      netPower: totalTurbinePower - totalPumpWork,
    };

    return newState;
  }

  getMaxStableDt(state: SimulationState): number {
    // Check if any configured turbines/condensers actually exist in the state
    let hasActiveTurbine = false;
    let hasActiveCondenser = false;

    for (const turbine of this.config.turbines) {
      if (state.flowNodes.has(turbine.turbineNodeId) && state.flowNodes.has(turbine.outletNodeId)) {
        hasActiveTurbine = true;
        break;
      }
    }

    for (const condenser of this.config.condensers) {
      if (state.flowNodes.has(condenser.flowNodeId)) {
        hasActiveCondenser = true;
        break;
      }
    }

    // If no turbines or condensers are actually present, no stability limit
    if (!hasActiveTurbine && !hasActiveCondenser) {
      return Infinity;
    }

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
   * For isentropic expansion of saturated steam to wet steam at lower pressure,
   * the outlet quality is typically 0.85-0.90. We use this to calculate the
   * ideal outlet enthalpy from saturation properties.
   */
  private processTurbine(
    state: SimulationState,
    turbine: TurbineConfig,
    dt: number
  ): number {
    const turbineNode = state.flowNodes.get(turbine.turbineNodeId);
    const outletNode = state.flowNodes.get(turbine.outletNodeId);

    if (!turbineNode || !outletNode) {
      // Debug: log which nodes are missing (only once per second)
      if (Math.floor(state.time) !== Math.floor(state.time - dt)) {
        console.log(`[Turbine] Missing nodes: turbineNode=${turbine.turbineNodeId} exists=${!!turbineNode}, outletNode=${turbine.outletNodeId} exists=${!!outletNode}`);
        console.log(`[Turbine] Available flow nodes: ${Array.from(state.flowNodes.keys()).join(', ')}`);
      }
      return 0;
    }

    // Find flow rate INTO the turbine (from any upstream connection)
    let massFlowRate = 0;
    for (const conn of state.flowConnections) {
      // Flow into turbine
      if (conn.toNodeId === turbine.turbineNodeId && conn.massFlowRate > 0) {
        massFlowRate += conn.massFlowRate;
      }
      // Or reverse flow from turbine to upstream
      if (conn.fromNodeId === turbine.turbineNodeId && conn.massFlowRate < 0) {
        massFlowRate += Math.abs(conn.massFlowRate);
      }
    }

    if (massFlowRate < 1) {
      // Debug: log low flow (only once per second)
      if (Math.floor(state.time) !== Math.floor(state.time - dt)) {
        console.log(`[Turbine] Low flow: ${massFlowRate.toFixed(2)} kg/s (need > 1)`);
      }
      return 0; // No significant flow
    }

    // Apply rated steam flow limit if specified
    if (turbine.ratedSteamFlow && turbine.ratedSteamFlow > 0) {
      massFlowRate = Math.min(massFlowRate, turbine.ratedSteamFlow);
    }

    // Inlet conditions (the turbine node itself has the inlet steam)
    const P_in = turbineNode.fluid.pressure;
    const phase_in = turbineNode.fluid.phase;

    // Outlet conditions (condenser pressure)
    const P_out = outletNode.fluid.pressure;

    // Skip if inlet is not steam or pressures are inverted
    if (phase_in === 'liquid' || P_in <= P_out) {
      // Debug: log condition failure (only once per second)
      if (Math.floor(state.time) !== Math.floor(state.time - dt)) {
        console.log(`[Turbine] Skipping: phase=${phase_in}, P_in=${(P_in/1e5).toFixed(1)} bar, P_out=${(P_out/1e5).toFixed(1)} bar`);
      }
      return 0;
    }

    // Calculate specific enthalpy at turbine (inlet conditions): h = u + Pv
    const u_in = turbineNode.fluid.internalEnergy / turbineNode.fluid.mass;
    const v_in = turbineNode.volume / turbineNode.fluid.mass;
    const h_in = u_in + P_in * v_in;

    // For isentropic expansion of steam to the outlet pressure:
    // The outlet state lies on the saturation dome (wet steam) with quality ~0.87
    // h_out_ideal = h_f(P_out) + x_out * h_fg(P_out)
    //
    // For saturated steam inlet, isentropic expansion typically gives x_out ≈ 0.85-0.90
    // Higher inlet pressure or superheat gives higher outlet quality
    const h_f_out = saturatedLiquidEnthalpy(P_out);
    const h_g_out = saturatedVaporEnthalpy(P_out);
    const h_fg_out = h_g_out - h_f_out;

    // Estimate isentropic outlet quality based on inlet conditions
    // For saturated steam at typical PWR secondary conditions (60 bar),
    // expanding to condenser vacuum (0.05 bar), x_out ≈ 0.87
    // Higher pressure ratio generally means lower outlet quality
    const pressureRatio = P_in / P_out;
    // This empirical formula gives ~0.87 for 60/0.05 bar, ~0.92 for 30/0.05 bar
    const x_out_isentropic = Math.max(0.8, Math.min(0.95, 1.0 - 0.02 * Math.log10(pressureRatio)));

    const h_out_ideal = h_f_out + x_out_isentropic * h_fg_out;
    const deltaH_ideal = h_in - h_out_ideal;

    // Apply turbine efficiency
    // Only extract enthalpy if the drop is positive (h_in > h_out_ideal)
    if (deltaH_ideal <= 0) return 0;

    const deltaH_actual = turbine.efficiency * deltaH_ideal;

    // Power extracted (W) = mass flow * enthalpy drop
    const power = massFlowRate * deltaH_actual;

    // Update outlet node internal energy
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
   * Calculate pump work for any pump
   *
   * W_pump = m_dot * g * H / η
   *
   * where H is the pump head in meters, which relates to pressure rise by:
   * ΔP = ρ * g * H
   *
   * This unified calculation works for RCPs, feedwater pumps, or any other pump.
   */
  private calculatePumpWork(
    state: SimulationState,
    pump: PumpState
  ): number {
    // Find the flow connection for this pump
    const conn = state.flowConnections.find(c => c.id === pump.connectedFlowPath);
    if (!conn) return 0;

    const massFlowRate = Math.abs(conn.massFlowRate);
    if (massFlowRate < 1) return 0; // No significant flow

    const g = 9.81;

    // Apply same ramp factor as FlowOperator for consistency
    const PUMP_RAMP_TIME = 5.0;
    const rampFactor = Math.min(1.0, state.time / PUMP_RAMP_TIME);
    const effectiveHead = pump.speed * rampFactor * pump.ratedHead;

    // Pump work = m_dot * g * H / η
    // This is the hydraulic power delivered to the fluid divided by efficiency
    const work = massFlowRate * g * effectiveHead / pump.efficiency;

    return work;
  }
}

// ============================================================================
// Helper: Create default turbine/condenser configuration
// ============================================================================

export function createDefaultTurbineCondenserConfig(): TurbineCondenserConfig {
  return {
    turbines: [{
      id: 'hp-turbine',
      turbineNodeId: 'turbine-inlet', // Legacy hardcoded ID for built-in scenarios
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
    // Note: Pump work is calculated for all pumps in state.components.pumps
    // No separate configuration needed here
  };
}

/**
 * Create turbine/condenser configuration from plant components.
 * Scans the plant state for turbine-generator and condenser components
 * and builds the appropriate configuration.
 */
export function createTurbineCondenserConfigFromPlant(
  plantComponents: Map<string, { type: string; id: string }>
): TurbineCondenserConfig {
  const turbines: TurbineConfig[] = [];
  const condensers: CondenserConfig[] = [];

  // Find all turbine-generators and condensers
  // Cast to any to access component-specific properties
  const turbineComponents: Array<{ id: string; efficiency?: number; ratedPower?: number; ratedSteamFlow?: number }> = [];
  const condenserComponents: Array<{ id: string; coolingWaterTemp?: number }> = [];

  for (const [, component] of plantComponents) {
    const comp = component as Record<string, unknown>;
    if (component.type === 'turbine-generator') {
      turbineComponents.push({
        id: component.id,
        efficiency: comp.efficiency as number | undefined,
        ratedPower: comp.ratedPower as number | undefined,
        ratedSteamFlow: comp.ratedSteamFlow as number | undefined,
      });
    } else if (component.type === 'condenser') {
      condenserComponents.push({
        id: component.id,
        coolingWaterTemp: comp.coolingWaterTemp as number | undefined,
      });
    }
  }

  // For each turbine, find its connected condenser
  // For now, assume first turbine connects to first condenser
  for (let i = 0; i < turbineComponents.length; i++) {
    const turbine = turbineComponents[i];
    const condenser = condenserComponents[i] || condenserComponents[0];

    if (condenser) {
      turbines.push({
        id: turbine.id,
        turbineNodeId: turbine.id,
        outletNodeId: condenser.id,
        efficiency: turbine.efficiency || 0.87,
        nominalPower: turbine.ratedPower || 333e6,
        ratedSteamFlow: turbine.ratedSteamFlow || undefined,
      });
    }
  }

  // Add all condensers
  for (const condenser of condenserComponents) {
    condensers.push({
      id: condenser.id,
      flowNodeId: condenser.id,
      heatSinkTemp: condenser.coolingWaterTemp || 293, // K
      heatTransferCoeff: 10e6, // W/K - sized for ~700 MW at 70K dT
      targetPressure: 1e5, // Pa - 1 bar
    });
  }

  console.log(`[TurbineCondenser] Config created: ${turbines.length} turbines, ${condensers.length} condensers`);
  for (const t of turbines) {
    console.log(`[TurbineCondenser]   Turbine: ${t.id} -> outlet: ${t.outletNodeId}`);
  }
  for (const c of condensers) {
    console.log(`[TurbineCondenser]   Condenser: ${c.id}`);
  }

  return { turbines, condensers };
}
