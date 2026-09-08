/**
 * Neutronics Operator
 *
 * Handles reactor power using simplified point kinetics with one
 * delayed neutron group. Also computes reactivity feedback from
 * temperature changes.
 *
 * Physics:
 *   dN/dt = (ρ - β) / Λ * N + λ * C + S
 *   dC/dt = β / Λ * N - λ * C
 *
 * Where:
 *   N = neutron population (proportional to power)
 *   C = delayed neutron precursor concentration
 *   ρ = reactivity (Δk/k)
 *   β = delayed neutron fraction (~0.0065 for U-235)
 *   Λ = prompt neutron lifetime (~1e-4 s for LWRs)
 *   λ = precursor decay constant (~0.08 s⁻¹ effective)
 *   S = neutron source, in the same normalized units as N (see
 *       normalizedNeutronSource below)
 *
 * For stability, this operator subcycles with smaller timesteps
 * since neutronics can be much faster than thermal-hydraulics.
 */

import { SimulationState, NeutronicsState } from '../types';
import { PhysicsOperator, cloneSimulationState } from '../solver';
import { latticeKeff } from '../lattice';

// Differential boron worth at reference moderator density. ~-8 pcm/ppm is
// the textbook PWR value; components may override via boronWorthPerPpm.
export const BORON_WORTH_PER_PPM = -8e-5;

// Water density at which the textbook per-ppm worth is defined (PWR operating
// conditions). The boron term always normalizes by THIS, not by the core's
// anchored reference density: a gas-cooled core anchors its reference at the
// trace-steam density (~0.01 kg/m³), and normalizing by that would hand a
// later-flooded core hundreds of times the physical worth.
export const BORON_REF_WATER_DENSITY = 750; // kg/m³

// ============================================================================
// Fission-product decay heat groups
// ============================================================================

/**
 * Fission-product decay heat groups: a coarse 4-group fit to ANS-5.1 decay
 * power after long operation. Each group builds toward fraction*P_fission
 * with time constant 1/lambda and releases its inventory after shutdown:
 * ~5% of prior power at 10 s, ~3% at 100 s, ~1.5% at 1000 s.
 *
 * (Lives here rather than with the rate operator that integrates the pools
 * because the neutron source model below reads the pool inventory too.)
 */
export const DECAY_HEAT_GROUPS: ReadonlyArray<{ fraction: number; lambda: number }> = [
  { fraction: 0.026, lambda: 0.1 },   // short-lived products, tau ~10 s
  { fraction: 0.020, lambda: 0.01 },  // tau ~100 s
  { fraction: 0.012, lambda: 1e-3 },  // tau ~17 min
  { fraction: 0.012, lambda: 1e-4 },  // tau ~2.8 h
];

/** Fraction of fission energy that is delayed (deposited via the pools) */
export const DECAY_HEAT_TOTAL_FRACTION = DECAY_HEAT_GROUPS.reduce((s, g) => s + g.fraction, 0);

// ============================================================================
// Neutron source
// ============================================================================
//
// A real core is never a pure multiplier of its own neutrons: it always sits
// on top of a source, so flux and precursors relax to a positive
// source-driven subcritical level instead of decaying toward zero. With the
// source term S in the kinetics,
//
//   dN/dt = (rho - beta)/Lambda * N + lambda * C + S
//   dC/dt = beta/Lambda * N - lambda * C
//
// the subcritical steady state (rho < 0) is
//
//   C_ss = beta * S / (lambda * (-rho)),   N_ss = S * Lambda / (-rho)
//
// which is what keeps a shut-down core at a readable, physical power level
// and makes a restart take the real amount of time instead of climbing out
// of an arbitrary floor (or out of 1e-90).
//
// Source strengths below are physical: neutrons/s emitted in the core. The
// conversion to the normalized units of N (N = P_fission / P_nominal) is
//
//   S = s_n * E_fission / (P_nominal * Lambda)
//
// because the normalized population and the fission power are related by
// P = N * P_nominal = n * E_fission / Lambda for a population n. Note that
// Lambda cancels in the steady state:
//
//   N_ss = s_n * E_fission / (P_nominal * (-rho))
//
// i.e. P_ss = s_n * E_fission * k/(1-k) - source neutrons times the number
// of fissions each one causes by subcritical multiplication. That is the
// number to check this model against, and it has no free parameters.

/**
 * Recoverable energy per fission (J). 200 MeV, the standard LWR value.
 */
export const FISSION_ENERGY = 3.204e-11;

/**
 * Spontaneous-fission neutron yield of U-238: 0.0136 n/(s*g), i.e. 13.6
 * n/(s*kg) (LANL neutron source tables; U-238 SF half-life 8.2e15 y).
 * This is the ONE source term a never-irradiated core cannot be without,
 * so even fresh fuel with no installed source has a positive steady state.
 */
export const U238_SF_YIELD = 13.6; // n/(s*kg of U-238)

/**
 * Neutron emission of an operating core's own irradiated fuel, per kg of
 * heavy metal, when the fission-product inventory is at its full-power
 * equilibrium.
 *
 * Basis: discharged PWR fuel at ~45 GWd/tHM carries ~40 g/tHM of Cm-244
 * whose spontaneous-fission yield is 1.08e7 n/(s*g) - about 4e8 n/s per
 * tonne of heavy metal, and curium dominates the neutron emission of spent
 * LWR fuel. Cm-244 builds up roughly as burnup^3, so a core holding a
 * uniform spread of burnups from fresh to discharge averages ~1/4 of the
 * discharge value: ~1e8 n/s per tonne = 1e5 n/(s*kg HM).
 *
 * ASSUMPTION (stated because the model has no burnup accounting): this term
 * is scaled by the fission-product decay-heat inventory, the only measure of
 * irradiation history the simulation carries. That is exactly right for the
 * photoneutron part of the shutdown source (D(gamma,n) driven by
 * fission-product gammas) but it makes the curium part decay over hours
 * after shutdown, whereas real Cm-244 persists for years (18 y half-life).
 * The consequence is that a core shut down for much longer than the pools'
 * ~3 h memory falls back to the installed source plus U-238 spontaneous
 * fission - roughly an order of magnitude low for an equilibrium core, and
 * three e-foldings of restart ramp, not a qualitative change.
 */
export const IRRADIATED_FUEL_SOURCE_PER_KG_HM = 1e5; // n/(s*kg HM)

/**
 * Default installed startup-source strength (neutrons/s), used when a core
 * does not specify one. Real PWR source assemblies span ~1e8 n/s (a primary
 * Cf-252 capsule) to ~1e9 n/s (a pair of activated Sb-124/Be secondary
 * source assemblies); 1e9 is the strong end of that range and is what a
 * plant that expects to start up from cold, fresh fuel installs.
 *
 * Sanity check on a 1000 MWt core held 5 $ subcritical (rho = -0.0325):
 * P_ss = 1e9 * 3.2e-11 / 0.0325 = 1 W = 1e-9 of nominal - the bottom of the
 * source range on a real startup chart.
 */
export const DEFAULT_STARTUP_SOURCE_RATE = 1e9; // n/s

/**
 * Total neutron source in the core, neutrons/s: the installed startup
 * source, spontaneous fission of the U-238 in the fuel, and the irradiated
 * fuel's own emission scaled by the current fission-product inventory.
 */
export function neutronSourceRate(n: NeutronicsState): number {
  let s = (n.startupSourceRate ?? 0) + (n.spontaneousFissionSource ?? 0);

  const irradiated = n.irradiatedFuelSource ?? 0;
  const pools = n.decayHeatPools;
  if (irradiated > 0 && pools && pools.length > 0 && n.nominalPower > 0) {
    let decayPower = 0;
    for (const q of pools) decayPower += q;
    // Pools sit at DECAY_HEAT_TOTAL_FRACTION * P_nominal after long
    // operation at rated power, which is the state the per-kg figure above
    // is anchored at.
    s += irradiated * decayPower / (DECAY_HEAT_TOTAL_FRACTION * n.nominalPower);
  }

  if (!(s >= 0) || !isFinite(s)) {
    throw new Error(
      `[Neutronics] Non-finite or negative neutron source: startup=${n.startupSourceRate} ` +
      `spontaneous=${n.spontaneousFissionSource} irradiated=${irradiated} ` +
      `pools=${pools} P_nom=${n.nominalPower}. Physics has failed.`
    );
  }
  return s;
}

/**
 * The neutron source in the normalized units of the kinetics equations
 * (fraction of nominal fission power per second):
 *   S = s_n * E_fission / (P_nominal * Lambda)
 */
export function normalizedNeutronSource(n: NeutronicsState): number {
  if (!(n.nominalPower > 0) || !(n.promptNeutronLifetime > 0)) {
    throw new Error(
      `[Neutronics] Cannot normalize the neutron source: nominalPower=${n.nominalPower} W, ` +
      `promptNeutronLifetime=${n.promptNeutronLifetime} s. Physics has failed.`
    );
  }
  return neutronSourceRate(n) * FISSION_ENERGY / (n.nominalPower * n.promptNeutronLifetime);
}

// ============================================================================
// Shared reactivity computation (used by NeutronicsOperator,
// NeutronicsRateOperator, and the factory's t=0 initialization)
// ============================================================================

export interface ReactivityInputs {
  fuelTemp: number;                 // K
  coolantTemp: number;              // K
  coolantDensity: number;           // kg/m³
  relocatedFuelFraction: number;    // 0-1, fuel mass slumped out of the lattice
}

export interface ReactivityResult {
  total: number;
  breakdown: NeutronicsState['reactivityBreakdown'];
}

/**
 * Compute total reactivity and its breakdown from the sampled core state.
 *
 * Two feedback models:
 * - Lattice path (n.latticeParams present): reactivity is (k-1)/k from
 *   latticeKeff evaluated at the CURRENT fuel temperature and coolant
 *   density, minus the constant burnable-poison worth. Exact at every
 *   state - no linearization. The breakdown attributes the lattice total
 *   to excess/Doppler/density by evaluating k at the reference anchors
 *   (a telescoping decomposition, so the parts sum exactly to the total).
 * - Linear path (no latticeParams): classic coefficient * deviation terms
 *   around the reference conditions (presets with validated explicit
 *   coefficients).
 *
 * Terms the lattice does not model are additive in both paths: control
 * rods, soluble boron (density-weighted), the small spectral coolant-
 * temperature term, and relocated-fuel worth.
 */
export function computeReactivityComponents(
  n: NeutronicsState,
  inp: ReactivityInputs
): ReactivityResult {
  // Control rods: position 0 = inserted = full negative worth
  const rhoRods = -n.controlRodWorth * (1 - n.controlRodPosition);

  // Soluble boron: worth proportional to concentration AND to the water
  // density actually in the core (voiding expels absorber with moderator,
  // so high ppm can flip the net density coefficient positive).
  const boronPpm = n.boronPpm ?? 0;
  const rhoBoron = boronPpm !== 0
    ? (n.boronWorthPerPpm ?? BORON_WORTH_PER_PPM) * boronPpm *
      (inp.coolantDensity / BORON_REF_WATER_DENSITY)
    : 0;

  // Relocated (slumped) fuel has left the moderated critical geometry:
  // shutdown-scale negative worth (recriticality of reflooded debris is
  // out of scope - flagged in operators/corium.ts).
  const rhoRelocation = -0.5 * inp.relocatedFuelFraction;

  // Small direct spectral term at constant density (the lattice model does
  // not resolve moderator temperature separately from density).
  const rhoCoolantTemp = n.coolantTempCoeff * (inp.coolantTemp - n.refCoolantTemp);

  let rhoExcess: number;
  let rhoDoppler: number;
  let rhoCoolantDensity: number;

  if (n.latticeParams) {
    const lp = n.latticeParams;
    const poison = n.poisonWorth ?? 0;
    const rhoOf = (k: number) => (k - 1) / k;
    const rhoAnchor = rhoOf(latticeKeff(lp, n.refFuelTemp, n.refCoolantDensity));
    const rhoT = rhoOf(latticeKeff(lp, inp.fuelTemp, n.refCoolantDensity));
    const rhoNow = rhoOf(latticeKeff(lp, inp.fuelTemp, inp.coolantDensity));
    rhoExcess = rhoAnchor - poison;
    rhoDoppler = rhoT - rhoAnchor;
    rhoCoolantDensity = rhoNow - rhoT;
  } else {
    rhoExcess = n.excessReactivity ?? 0;
    rhoDoppler = n.fuelTempCoeff * (inp.fuelTemp - n.refFuelTemp);
    rhoCoolantDensity = n.coolantDensityCoeff * (inp.coolantDensity - n.refCoolantDensity);
  }

  const total = rhoExcess + rhoRods + rhoDoppler + rhoCoolantTemp +
    rhoCoolantDensity + rhoBoron + rhoRelocation;

  if (!isFinite(total)) {
    throw new Error(
      `[Neutronics] Non-finite reactivity: excess=${rhoExcess} rods=${rhoRods} ` +
      `doppler=${rhoDoppler} coolantT=${rhoCoolantTemp} density=${rhoCoolantDensity} ` +
      `boron=${rhoBoron} relocation=${rhoRelocation} ` +
      `(T_fuel=${inp.fuelTemp} K, rho_cool=${inp.coolantDensity} kg/m³). Physics has failed.`
    );
  }

  return {
    total,
    breakdown: {
      excess: rhoExcess,
      controlRods: rhoRods,
      doppler: rhoDoppler,
      coolantTemp: rhoCoolantTemp,
      coolantDensity: rhoCoolantDensity,
      boron: rhoBoron,
    },
  };
}

/**
 * Fraction of fuel mass that has relocated (slumped) out of the lattice,
 * from the fuel thermal node's mass vs its initial mass.
 */
export function getRelocatedFuelFraction(n: NeutronicsState, state: SimulationState): number {
  if (!n.fuelNodeId) return 0;
  const fuelNode = state.thermalNodes.get(n.fuelNodeId);
  if (fuelNode?.initialMass && fuelNode.initialMass > 0) {
    return Math.max(0, Math.min(1, 1 - fuelNode.mass / fuelNode.initialMass));
  }
  return 0;
}

// ============================================================================
// Neutronics Operator
// ============================================================================

/**
 * Explicit-Euler point kinetics with internal subcycling. The shipping
 * operator stack uses NeutronicsRateOperator (rate-operators.ts) instead,
 * which hands the same physics to the RK45 error controller.
 *
 * There is no "standby mode" that skips the kinetics after a scram: with a
 * neutron source the subcritical equations have a positive steady state that
 * the integrator walks to on the precursor timescale (~10 s), so the fast
 * mode it was avoiding is gone and nothing has to be floored on the way out.
 */
export class NeutronicsOperator implements PhysicsOperator {
  name = 'Neutronics';

  // Track previous power for rate-of-change detection
  private lastPower: number = 0;
  private lastPowerTime: number = 0;
  private powerRateOfChange: number = 0;  // dP/dt / P (relative rate)

  apply(state: SimulationState, dt: number): SimulationState {
    const n = state.neutronics;

    // If no core is linked, neutronics is disabled - return unchanged
    if (!n.coreId) {
      return state;
    }

    const newState = cloneSimulationState(state);
    const nNew = newState.neutronics;

    const rho = this.computeTotalReactivity(nNew, newState);
    nNew.reactivity = rho;

    // Full point kinetics calculation
    const beta = nNew.delayedNeutronFraction;
    const Lambda = nNew.promptNeutronLifetime;
    const lambda = nNew.precursorDecayConstant;
    const S = normalizedNeutronSource(nNew);

    // Normalized power (N = P / P_nominal)
    let N = nNew.power / nNew.nominalPower;
    let C = nNew.precursorConcentration;

    // Rate equations
    const dN_dt = (rho - beta) / Lambda * N + lambda * C + S;
    const dC_dt = beta / Lambda * N - lambda * C;

    // Update
    N += dN_dt * dt;
    C += dC_dt * dt;

    // No floors: with the source term, N and C relax to the positive
    // subcritical steady state N_ss = S*Lambda/(-rho), C_ss = beta*S/(lambda*(-rho)).
    // A negative value here would be an integration failure, and the solver's
    // state validation (solver.ts) throws on it rather than hiding it.

    // No rate limit on power: a reactivity excursion is quenched by Doppler
    // feedback, which the subcycled kinetics and the thermal operators
    // resolve on their own. (The shipping RK45 path never had one - a
    // prompt-critical prompt-crit.json run peaks at 90x nominal and passes
    // through 90000 %/s, 200 times the 400 %/s this used to allow.)

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
    const fuelTemp = this.getAverageFuelTemperature(state);
    const coolantTemp = this.getAverageCoolantTemperature(state);
    const coolantDensity = this.getAverageCoolantDensity(state);

    const { total, breakdown } = computeReactivityComponents(n, {
      fuelTemp,
      coolantTemp,
      coolantDensity,
      relocatedFuelFraction: getRelocatedFuelFraction(n, state),
    });

    n.reactivityBreakdown = breakdown;
    n.diagnostics = { fuelTemp, coolantTemp, coolantDensity };

    return total;
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

    // No fallback - if fuelNodeId is set but node doesn't exist, that's a configuration error
    if (n.fuelNodeId) {
      throw new Error(`[Neutronics] Fuel node '${n.fuelNodeId}' not found in thermalNodes`);
    }

    // If no fuelNodeId is configured, use reference temperature (no reactor core present)
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

    // No fallback - if coolantNodeId is set but node doesn't exist, that's a configuration error
    if (n.coolantNodeId) {
      throw new Error(`[Neutronics] Coolant node '${n.coolantNodeId}' not found in flowNodes`);
    }

    // If no coolantNodeId is configured, use reference temperature (no reactor core present)
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

    // No fallback - if coolantNodeId is set but node doesn't exist, that's a configuration error
    if (n.coolantNodeId) {
      throw new Error(`[Neutronics] Coolant node '${n.coolantNodeId}' not found in flowNodes`);
    }

    // If no coolantNodeId is configured, use reference density (no reactor core present)
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
 * Scram setpoint configuration
 */
export interface ScramSetpoints {
  highPower: number;      // % of nominal power (default 125)
  lowPower: number;       // % of nominal power (default 12)
  highFuelTemp: number;   // Fraction of melting point (default 0.95)
  lowCoolantFlow: number; // kg/s (default 10)
}

/**
 * Default scram setpoints (used when no controller is present)
 */
export const DEFAULT_SCRAM_SETPOINTS: ScramSetpoints = {
  highPower: 125,
  lowPower: 12,
  highFuelTemp: 0.95,
  lowCoolantFlow: 10
};

/**
 * Check automatic SCRAM conditions
 * @param state - Current simulation state
 * @param setpoints - Optional scram setpoints (if undefined, returns shouldScram: false for manual-only mode)
 */
export function checkScramConditions(
  state: SimulationState,
  setpoints?: ScramSetpoints
): { shouldScram: boolean; reason: string } {
  // If no setpoints provided, automatic scram is disabled (manual only mode)
  if (!setpoints) {
    return { shouldScram: false, reason: '' };
  }

  const n = state.neutronics;

  // High power SCRAM
  const highPowerFraction = setpoints.highPower / 100;
  if (n.power > n.nominalPower * highPowerFraction) {
    return { shouldScram: true, reason: `High power (>${setpoints.highPower}%)` };
  }

  // Low power SCRAM
  const lowPowerFraction = setpoints.lowPower / 100;
  if (n.power < n.nominalPower * lowPowerFraction) {
    return { shouldScram: true, reason: `Low power (<${setpoints.lowPower}%)` };
  }

  // High fuel temperature
  for (const [, node] of state.thermalNodes) {
    if (node.label.toLowerCase().includes('fuel')) {
      if (node.temperature > node.maxTemperature * setpoints.highFuelTemp) {
        return { shouldScram: true, reason: `High fuel temperature (${node.temperature.toFixed(0)}K)` };
      }
    }
  }

  // Low coolant flow: inflow to the core coolant node (the node neutronics
  // reads its feedback from). Name-based matching ('core' in the node id)
  // silently read zero flow on plants whose core node is named differently.
  if (n.coolantNodeId) {
    let totalCoolantFlow = 0;
    for (const conn of state.flowConnections) {
      if (conn.toNodeId === n.coolantNodeId) totalCoolantFlow += Math.max(0, conn.massFlowRate);
      if (conn.fromNodeId === n.coolantNodeId) totalCoolantFlow += Math.max(0, -conn.massFlowRate);
    }
    // Only scram on low flow if power is significant
    if (totalCoolantFlow < setpoints.lowCoolantFlow && n.power > n.nominalPower * 0.1) {
      return { shouldScram: true, reason: `Low coolant flow (<${setpoints.lowCoolantFlow} kg/s)` };
    }
  }

  return { shouldScram: false, reason: '' };
}
