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

  apply(state: SimulationState, dt: number): SimulationState {
    const newState = cloneSimulationState(state);
    const n = newState.neutronics;

    // Always compute reactivity
    const rho = this.computeTotalReactivity(n, newState);
    n.reactivity = rho;

    // Point kinetics with one delayed group
    const beta = n.delayedNeutronFraction;
    const Lambda = n.promptNeutronLifetime;
    const lambda = n.precursorDecayConstant;

    // Normalized power (N = P / P_nominal)
    let N = n.power / n.nominalPower;
    let C = n.precursorConcentration;

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
    const oldN = n.power / n.nominalPower;
    if (N > oldN + maxChange) N = oldN + maxChange;
    if (N < oldN - maxChange && N < oldN) N = Math.max(oldN - maxChange, 1e-10);

    // Update decay heat fraction based on operating history
    this.updateDecayHeat(n, state.time, dt);

    // Fission power from kinetics. Includes decay heat.
    const fissionPower = N * n.nominalPower;

    // Decay heat provides a power floor only after SCRAM
    // During normal operation, fission dominates and decay heat is negligible
    // After shutdown, decay heat prevents power from going to zero
    const decayHeatPower = n.nominalPower * n.decayHeatFraction
    n.power = (1.0-n.decayHeatFraction)*fissionPower + decayHeatPower
    // if (n.scrammed) {
    //   const decayHeatPower = n.nominalPower * n.decayHeatFraction;
    //   n.power = Math.max(fissionPower, decayHeatPower);
    // } else {
    //   n.power = fissionPower;
    // }
    n.precursorConcentration = C;

    // Clear SCRAM flag if operator withdraws rods and goes critical
    if (n.scrammed && n.controlRodPosition > 0.2 && rho > 0) {
      console.log('[Neutronics] Reactor reset from SCRAM - rods withdrawn, now supercritical');
      n.scrammed = false;
      n.scramTime = -1;
    }

    return newState;
  }

  getMaxStableDt(state: SimulationState): number {
    // Point kinetics has two timescales:
    // 1. Prompt: τ_prompt = Λ / |ρ - β| (very fast, ~0.01-0.1s)
    // 2. Delayed: τ_delayed = 1 / λ (slower, ~12s)
    //
    // For explicit Euler stability, we need dt < τ (approximately).
    // The prompt term (ρ - β) / Λ * N always has fast dynamics
    // regardless of whether ρ is positive or negative.

    const n = state.neutronics;
    const beta = n.delayedNeutronFraction;
    const Lambda = n.promptNeutronLifetime;

    // Estimate reactivity (can't compute feedback without full state)
    const rho = n.reactivity;

    // Prompt dynamics timescale - this is always fast
    // |ρ - β| is always at least β when subcritical, and larger when supercritical
    const promptTau = Lambda / Math.abs(rho - beta);

    // Use a safety factor to stay well within stability region
    // Allow up to 50ms for stability, but cap based on prompt dynamics
    return Math.min(0.05, promptTau * 0.5);
  }

  getSubcycleCount(state: SimulationState, dt: number): number {
    const maxDt = this.getMaxStableDt(state);
    if (maxDt >= dt) return 1;

    // Need to subcycle
    const count = Math.ceil(dt / maxDt);

    // Cap subcycles to prevent runaway computation
    // If we need more than 1000 subcycles, something is wrong
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
   * Get average fuel temperature from thermal nodes
   * Looks for nodes with "fuel" in their label
   */
  private getAverageFuelTemperature(state: SimulationState): number {
    let sum = 0;
    let count = 0;

    for (const [, node] of state.thermalNodes) {
      if (node.label.toLowerCase().includes('fuel')) {
        sum += node.temperature;
        count++;
      }
    }

    return count > 0 ? sum / count : state.neutronics.refFuelTemp;
  }

  /**
   * Get average coolant temperature from flow nodes
   * Looks for nodes with "coolant" or "core" in their label
   */
  private getAverageCoolantTemperature(state: SimulationState): number {
    let sum = 0;
    let count = 0;

    for (const [, node] of state.flowNodes) {
      if (node.label.toLowerCase().includes('coolant') ||
          node.label.toLowerCase().includes('core')) {
        sum += node.fluid.temperature;
        count++;
      }
    }

    return count > 0 ? sum / count : state.neutronics.refCoolantTemp;
  }

  /**
   * Get average coolant density
   */
  private getAverageCoolantDensity(state: SimulationState): number {
    let sum = 0;
    let count = 0;

    for (const [, node] of state.flowNodes) {
      if (node.label.toLowerCase().includes('coolant') ||
          node.label.toLowerCase().includes('core')) {
        const rho = node.fluid.mass / node.volume;
        sum += rho;
        count++;
      }
    }

    return count > 0 ? sum / count : state.neutronics.refCoolantDensity;
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
    newState.neutronics.controlRodPosition = 0; // Rods fully inserted
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
