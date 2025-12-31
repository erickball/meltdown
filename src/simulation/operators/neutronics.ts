/**
 * Neutronics Operator
 *
 * Handles reactor power using simplified point kinetics with one
 * delayed neutron group. Also computes reactivity feedback from
 * temperature changes.
 *
 * Physics:
 *   dN/dt = (ρ - β) / Λ * N + λ * C
 *   dC/dt = β / Λ * N - λ * C
 *
 * Where:
 *   N = neutron population (proportional to power)
 *   C = delayed neutron precursor concentration
 *   ρ = reactivity (Δk/k)
 *   β = delayed neutron fraction (~0.0065 for U-235)
 *   Λ = prompt neutron lifetime (~1e-4 s for LWRs)
 *   λ = precursor decay constant (~0.08 s⁻¹ effective)
 *
 * For stability, this operator subcycles with smaller timesteps
 * since neutronics can be much faster than thermal-hydraulics.
 */

import { SimulationState, NeutronicsState } from '../types';
import { PhysicsOperator, cloneSimulationState } from '../solver';

// ============================================================================
// Neutronics Operator
// ============================================================================

export class NeutronicsOperator implements PhysicsOperator {
  name = 'Neutronics';

  // Track previous power for rate-of-change detection
  private lastPower: number = 0;
  private lastPowerTime: number = 0;
  private powerRateOfChange: number = 0;  // dP/dt / P (relative rate)

  // Standby mode for post-SCRAM with negligible power
  private inStandby: boolean = false;

  apply(state: SimulationState, dt: number): SimulationState {
    const n = state.neutronics;

    // If no core is linked, neutronics is disabled - return unchanged
    if (!n.coreId) {
      return state;
    }

    const newState = cloneSimulationState(state);
    const nNew = newState.neutronics;

    // Always compute reactivity (needed for standby mode too)
    const rho = this.computeTotalReactivity(nNew, newState);
    nNew.reactivity = rho;

    // Check for standby mode: scrammed AND power < 1% nominal AND subcritical
    const powerFraction = nNew.power / nNew.nominalPower;
    const shouldBeStandby = nNew.scrammed && powerFraction < 0.01 && rho < 0;

    if (shouldBeStandby && !this.inStandby) {
      this.inStandby = true;
      // console.log('[Neutronics] Entering standby mode - power negligible, reactor subcritical');
    } else if (!shouldBeStandby && this.inStandby) {
      this.inStandby = false;
      // Recriticality or power increase - wake up
      if (rho >= 0) {
        console.log('[Neutronics] Exiting standby - reactivity went positive (recriticality risk)');
        // Set precursors to a minimum "source" level for restart calculations
        nNew.precursorConcentration = Math.max(nNew.precursorConcentration, 1e-6);
      } else {
        // console.log('[Neutronics] Exiting standby - power increasing');
      }
    }

    // In standby mode, just update decay heat and skip kinetics
    if (this.inStandby) {
      this.updateDecayHeat(nNew, state.time, dt);

      // Power is just decay heat in standby
      nNew.power = nNew.nominalPower * nNew.decayHeatFraction;

      // Precursors decay away
      const lambda = nNew.precursorDecayConstant;
      nNew.precursorConcentration *= Math.exp(-lambda * dt);
      nNew.precursorConcentration = Math.max(nNew.precursorConcentration, 1e-10);

      return newState;
    }

    // Full point kinetics calculation
    const beta = nNew.delayedNeutronFraction;
    const Lambda = nNew.promptNeutronLifetime;
    const lambda = nNew.precursorDecayConstant;

    // Normalized power (N = P / P_nominal)
    let N = nNew.power / nNew.nominalPower;
    let C = nNew.precursorConcentration;

    // Rate equations
    const dN_dt = (rho - beta) / Lambda * N + lambda * C;
    const dC_dt = beta / Lambda * N - lambda * C;

    // Update
    N += dN_dt * dt;
    C += dC_dt * dt;

    // Prevent negative values
    N = Math.max(N, 1e-10);
    C = Math.max(C, 1e-10);

    // Limit power rate of change for ease of use
    const maxPowerChangeRate = 4; // 400% per second (still very fast)
    const maxChange = maxPowerChangeRate * dt;
    const oldN = nNew.power / nNew.nominalPower;
    if (N > oldN + maxChange) N = oldN + maxChange;
    if (N < oldN - maxChange && N < oldN) N = Math.max(oldN - maxChange, 1e-10);

    // Update decay heat fraction based on operating history
    this.updateDecayHeat(nNew, state.time, dt);

    // Fission power from kinetics. Includes decay heat.
    const fissionPower = N * nNew.nominalPower;

    // Decay heat provides a power floor
    const decayHeatPower = nNew.nominalPower * nNew.decayHeatFraction;
    nNew.power = (1.0 - nNew.decayHeatFraction) * fissionPower + decayHeatPower;
    nNew.precursorConcentration = C;

    // Track power rate of change for adaptive timestep
    if (this.lastPowerTime > 0 && state.time > this.lastPowerTime) {
      const dP = nNew.power - this.lastPower;
      const elapsed = state.time - this.lastPowerTime;
      // Relative rate: (dP/dt) / P
      this.powerRateOfChange = Math.abs(dP / elapsed) / Math.max(nNew.power, nNew.nominalPower * 0.01);
    }
    this.lastPower = nNew.power;
    this.lastPowerTime = state.time;

    // Clear SCRAM flag if operator withdraws rods and goes critical
    if (nNew.scrammed && nNew.controlRodPosition > 0.2 && rho > 0) {
      console.log('[Neutronics] Reactor reset from SCRAM - rods withdrawn, now supercritical');
      nNew.scrammed = false;
      nNew.scramTime = -1;
    }

    return newState;
  }

  getMaxStableDt(state: SimulationState): number {
    // If no core, neutronics imposes no constraint
    if (!state.neutronics.coreId) {
      return Infinity;
    }

    // The GLOBAL timestep doesn't need to resolve prompt neutron dynamics -
    // that's handled internally by subcycling. The global timestep needs to
    // capture the feedback coupling: temperatures → reactivity → power → heat.
    //
    // This coupling happens on thermal timescales (seconds), not prompt
    // neutron timescales (milliseconds).

    // In standby mode, neutronics imposes no constraint
    if (this.inStandby) {
      return Infinity;
    }

    // If power is very stable (low rate of change), allow larger steps
    // powerRateOfChange is |dP/dt| / P in units of 1/s
    // A rate of 0.01/s means 1% change per second - very stable
    // A rate of 1.0/s means 100% change per second - rapid transient
    if (this.powerRateOfChange < 0.1) {
      // Stable operation - feedback coupling is slow
      // Allow up to 100ms steps
      return 0.1;
    } else if (this.powerRateOfChange < 1.0) {
      // Moderate transient - be more careful
      // Allow up to 20ms steps
      return 0.02;
    } else {
      // Rapid transient - need to track feedback closely
      // Allow up to 5ms steps
      return 0.005;
    }
  }

  /**
   * Get the internal stability timestep for point kinetics.
   * This is used for subcycling within the operator.
   */
  private getInternalMaxDt(state: SimulationState): number {
    const n = state.neutronics;
    const beta = n.delayedNeutronFraction;
    const Lambda = n.promptNeutronLifetime;
    const rho = n.reactivity;

    // Prompt dynamics timescale
    const promptTau = Lambda / Math.abs(rho - beta);

    // Use safety factor for explicit Euler stability
    return Math.min(0.05, promptTau * 0.5);
  }

  getSubcycleCount(state: SimulationState, dt: number): number {
    // If no core, no subcycling needed
    if (!state.neutronics.coreId) {
      return 1;
    }

    // In standby mode, no subcycling needed
    if (this.inStandby) {
      return 1;
    }

    // Use internal stability requirement for subcycling
    const maxDt = this.getInternalMaxDt(state);
    if (maxDt >= dt) return 1;

    // Need to subcycle to maintain internal stability
    const count = Math.ceil(dt / maxDt);

    // Cap subcycles to prevent runaway computation
    return Math.min(count, 1000);
  }

  /**
   * Compute total reactivity including all feedback effects
   * Also stores the breakdown in n.reactivityBreakdown for debugging
   */
  private computeTotalReactivity(n: NeutronicsState, state: SimulationState): number {
    // Control rod contribution
    // Position 0 = inserted = negative reactivity
    // Position 1 = withdrawn = zero contribution
    const rhoRods = -n.controlRodWorth * (1 - n.controlRodPosition);

    // Fuel temperature feedback (Doppler)
    const fuelTemp = this.getAverageFuelTemperature(state);
    const dT_fuel = fuelTemp - n.refFuelTemp;
    const rhoDoppler = n.fuelTempCoeff * dT_fuel;

    // Coolant temperature feedback
    const coolantTemp = this.getAverageCoolantTemperature(state);
    const dT_coolant = coolantTemp - n.refCoolantTemp;
    const rhoCoolantTemp = n.coolantTempCoeff * dT_coolant;

    // Coolant density feedback (void coefficient)
    const coolantDensity = this.getAverageCoolantDensity(state);
    const dRho_coolant = coolantDensity - n.refCoolantDensity;
    const rhoCoolantDensity = n.coolantDensityCoeff * dRho_coolant;

    // Store breakdown for debugging
    n.reactivityBreakdown = {
      controlRods: rhoRods,
      doppler: rhoDoppler,
      coolantTemp: rhoCoolantTemp,
      coolantDensity: rhoCoolantDensity,
    };

    // Store diagnostic values
    n.diagnostics = {
      fuelTemp,
      coolantTemp,
      coolantDensity,
    };

    return rhoRods + rhoDoppler + rhoCoolantTemp + rhoCoolantDensity;
  }

  /**
   * Get fuel temperature from the linked fuel thermal node
   */
  private getAverageFuelTemperature(state: SimulationState): number {
    const n = state.neutronics;

    // Use linked fuel node if available
    if (n.fuelNodeId) {
      const fuelNode = state.thermalNodes.get(n.fuelNodeId);
      if (fuelNode) {
        return fuelNode.temperature;
      }
    }

    // Fallback: search by label (for backwards compatibility)
    for (const [, node] of state.thermalNodes) {
      if (node.label.toLowerCase().includes('fuel')) {
        return node.temperature;
      }
    }

    return n.refFuelTemp;
  }

  /**
   * Get coolant temperature from the linked coolant flow node
   */
  private getAverageCoolantTemperature(state: SimulationState): number {
    const n = state.neutronics;

    // Use linked coolant node if available
    if (n.coolantNodeId) {
      const coolantNode = state.flowNodes.get(n.coolantNodeId);
      if (coolantNode) {
        return coolantNode.fluid.temperature;
      }
    }

    // Fallback: search by label (for backwards compatibility)
    for (const [, node] of state.flowNodes) {
      if (node.label.toLowerCase().includes('coolant') ||
          node.label.toLowerCase().includes('core')) {
        return node.fluid.temperature;
      }
    }

    return n.refCoolantTemp;
  }

  /**
   * Get coolant density from the linked coolant flow node
   */
  private getAverageCoolantDensity(state: SimulationState): number {
    const n = state.neutronics;

    // Use linked coolant node if available
    if (n.coolantNodeId) {
      const coolantNode = state.flowNodes.get(n.coolantNodeId);
      if (coolantNode) {
        return coolantNode.fluid.mass / coolantNode.volume;
      }
    }

    // Fallback: search by label (for backwards compatibility)
    for (const [, node] of state.flowNodes) {
      if (node.label.toLowerCase().includes('coolant') ||
          node.label.toLowerCase().includes('core')) {
        return node.fluid.mass / node.volume;
      }
    }

    return n.refCoolantDensity;
  }

  /**
   * Update decay heat fraction based on operating history
   *
   * Decay heat follows ANS standard curves approximately:
   * P_decay/P0 ≈ 0.066 * (t^-0.2 - (t+T)^-0.2)
   *
   * Where t = time since shutdown, T = operating time before shutdown
   *
   * For simplicity, we use a fit: P_decay/P0 ≈ 0.07 * t^-0.2 for t > 1s
   */
  private updateDecayHeat(n: NeutronicsState, simTime: number, _dt: number): void {
    if (n.scrammed && n.scramTime >= 0) {
      const timeSinceScram = simTime - n.scramTime;

      if (timeSinceScram < 0.1) {
        // Immediately after SCRAM, still have prompt power dropping
        n.decayHeatFraction = 0.07 + 0.03 * Math.exp(-timeSinceScram / 0.01);
      } else if (timeSinceScram < 1) {
        // First second - rapid decrease
        n.decayHeatFraction = 0.07 * Math.pow(timeSinceScram, -0.2);
      } else {
        // Long-term decay heat (ANS approximation)
        n.decayHeatFraction = 0.066 * Math.pow(timeSinceScram, -0.2);
      }

      // Minimum decay heat (approaches ~1% after hours)
      n.decayHeatFraction = Math.max(n.decayHeatFraction, 0.01);
    } else {
      // During operation, decay heat is part of total power
      // Track it for use after shutdown
      n.decayHeatFraction = 0.07; // ~7% at steady state
    }
    // If fission power is higher than 1/decayHeatFraction, it should go up
    // towards 7% of fission power. But gradually. Like 1% per second (?)
    if (n.power/n.nominalPower * 0.07 > 1.0/n.decayHeatFraction) {
      const fraction = _dt / 100;
      n.decayHeatFraction = (1.0 - fraction) * n.decayHeatFraction + fraction * 0.07 * n.power/n.nominalPower;
    }
  }
}

// ============================================================================
// SCRAM Logic (can be triggered by various conditions)
// ============================================================================

export function triggerScram(state: SimulationState, reason: string): SimulationState {
  const newState = cloneSimulationState(state);

  if (!newState.neutronics.scrammed) {
    console.log(`[SCRAM] Reactor scrammed at t=${state.time.toFixed(2)}s - Reason: ${reason}`);
    newState.neutronics.scrammed = true;
    newState.neutronics.scramTime = state.time;
    newState.neutronics.scramReason = reason;
    newState.neutronics.controlRodPosition = 0; // Rods fully inserted
  }

  return newState;
}

/**
 * Reset SCRAM - allows reactor to be restarted after a scram
 * Control rods remain at their current position (typically fully inserted)
 * Operator must manually withdraw rods to restart reactor
 */
export function resetScram(state: SimulationState): SimulationState {
  const newState = cloneSimulationState(state);

  if (newState.neutronics.scrammed) {
    console.log(`[SCRAM] Scram reset at t=${state.time.toFixed(2)}s - Control rods remain at ${(newState.neutronics.controlRodPosition * 100).toFixed(1)}% insertion`);
    newState.neutronics.scrammed = false;
    newState.neutronics.scramTime = 0; // Reset to 0 instead of undefined
    newState.neutronics.scramReason = '';
    // Note: Control rods stay at current position (usually 0 = fully inserted)
    // Operator must manually withdraw them to restart
  }

  return newState;
}

/**
 * Check automatic SCRAM conditions
 */
export function checkScramConditions(state: SimulationState): { shouldScram: boolean; reason: string } {
  const n = state.neutronics;

  // High power SCRAM (e.g., >125% nominal)
  if (n.power > n.nominalPower * 1.25) {
    return { shouldScram: true, reason: 'High power (>125%)' };
  }

  // Low power SCRAM (e.g., <12% nominal)
  if (n.power < n.nominalPower * 0.12) {
    return { shouldScram: true, reason: 'Low power (<12%)' };
  }

  // High fuel temperature
  for (const [, node] of state.thermalNodes) {
    if (node.label.toLowerCase().includes('fuel')) {
      if (node.temperature > node.maxTemperature * 0.95) {
        return { shouldScram: true, reason: `High fuel temperature (${node.temperature.toFixed(0)}K)` };
      }
    }
  }

  // Low coolant flow (simplified check)
  let totalCoolantFlow = 0;
  for (const conn of state.flowConnections) {
    if (conn.fromNodeId.includes('core') || conn.toNodeId.includes('core')) {
      totalCoolantFlow += Math.abs(conn.massFlowRate);
    }
  }
  // This threshold should be configurable
  if (totalCoolantFlow < 10 && n.power > n.nominalPower * 0.1) {
    return { shouldScram: true, reason: 'Low coolant flow' };
  }

  return { shouldScram: false, reason: '' };
}
