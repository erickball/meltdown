/**
 * Water + non-condensible-gas equilibrium state.
 *
 * A flow node holds m_w kg of water and n mol of NCG sharing one volume V at
 * one temperature. Dalton's law says the steam behaves as if the gas were not
 * there, so the WATER sub-problem is EXACTLY the pure-water problem:
 *
 *     Water.calculateState(m_w, U_w, V)
 *
 * Same steam tables, same (u,v) dome test, no special cases for "how much
 * water is there". The gas just rides along at its own partial pressure and
 * adds it on top. The only coupling between the two is a single scalar - how
 * the node's internal energy U splits into water energy U_w and gas energy -
 * because they share a temperature:
 *
 *     f(U_w) = U_w + n·Cv·T(U_w) − U_total = 0
 *
 * f is strictly increasing (dT/dU_w > 0), so the root is unique and a
 * bracketed secant finds it in a couple of iterations from the previous
 * step's temperature.
 *
 * WHY THIS SHAPE MATTERS. The obvious alternative - and what this replaced -
 * is to model the mixture directly with a cheap caloric fit
 * (u_f = 4186·(T−273), u_g = 2.375e6 + 1900·(T−273)) and switch to the steam
 * tables once there is "enough" water to trust them. That fit is 19% high on
 * u_g at 600 K and 35% high at 640 K, so the two models disagree badly, and
 * the switch put a step discontinuity into the state function right where a
 * gas node slowly accumulates water - e.g. steam bleeding into a helium loop
 * through an SG tube leak, which crossed the seam with a 110 K / 10 bar jump.
 * A discontinuous state function is poison for both the RK45 error controller
 * (which sees an un-shrinkable error) and the pressure solver (whose dP/dm
 * compliance is meaningless across the step). One code path for every water
 * fraction is what keeps it smooth.
 *
 * KNOWN SIMPLIFICATION (unchanged from before this module existed): the gas
 * partial pressure uses the FULL node volume rather than the vapour space
 * V − V_liquid. That over-states the vapour room available to the gas when a
 * lot of liquid coexists with it, but the alternative divides by zero for a
 * water-solid node holding gas (a PWR accumulator, a flooded containment), so
 * changing it is a separate piece of work with its own blast radius.
 */

import * as Water from './water-properties-v4';
import { mixtureCv, totalMoles, type GasComposition } from './gas-properties';

const R_GAS = 8.31446;  // J/(mol·K) - must match gas-properties

/** Bracket for the water's specific internal energy, J/kg.
 *  Low end: saturated liquid at the triple point (T ~ 273 K).
 *  High end: steam hot enough that calculateState itself rejects it (5000 K).
 *  These bound the PHYSICS, not the numerics - the solve never needs to be
 *  told how much water there is. */
const U_SPECIFIC_MIN = 1.0e3;
const U_SPECIFIC_MAX = 9.5e6;

export interface MixtureState {
  temperature: number;      // K - common to water and gas
  pressure: number;         // Pa - total (Dalton)
  steamPressure: number;    // Pa - water's partial pressure
  gasPressure: number;      // Pa - NCG partial pressure
  phase: 'liquid' | 'vapor' | 'two-phase';
  quality: number;          // vapour mass fraction of the WATER
  waterEnergy: number;      // J
  gasEnergy: number;        // J
  iterations: number;       // secant iterations used (0 = no gas present)
}

/**
 * Equilibrium (T, P, phase) for `waterMass` kg of water and `ncg` moles of
 * non-condensible gas sharing `volume` m³ with total internal energy
 * `totalEnergy` J.
 *
 * `temperatureGuess` seeds the solve - pass the node's previous temperature.
 * Throws (via Water.calculateState) on states outside the steam tables'
 * physical range, the same as the pure-water path.
 */
export function solveMixtureState(
  waterMass: number,
  totalEnergy: number,
  volume: number,
  ncg: GasComposition | undefined,
  temperatureGuess: number
): MixtureState {
  const gasMoles = ncg ? totalMoles(ncg) : 0;

  // -- No gas: the pure-water problem, untouched ---------------------------
  if (gasMoles <= 0) {
    const ws = Water.calculateState(waterMass, totalEnergy, volume);
    return {
      temperature: ws.temperature,
      pressure: ws.pressure,
      steamPressure: ws.pressure,
      gasPressure: 0,
      phase: ws.phase,
      quality: ws.quality,
      waterEnergy: totalEnergy,
      gasEnergy: 0,
      iterations: 0,
    };
  }

  const Cv_gas = mixtureCv(ncg!);
  const gasHeatCapacity = gasMoles * Cv_gas;  // J/K

  // -- No water: the pure-gas limit ----------------------------------------
  // A dried-out gas space is a VALID state, not an error.
  if (waterMass <= 0) {
    const T = totalEnergy / gasHeatCapacity;
    const P = (gasMoles * R_GAS * T) / volume;
    return {
      temperature: T,
      pressure: P,
      steamPressure: 0,
      gasPressure: P,
      phase: 'vapor',
      quality: 1,
      waterEnergy: 0,
      gasEnergy: totalEnergy,
      iterations: 0,
    };
  }

  // -- Both present: solve the energy split --------------------------------
  // Work in the water's SPECIFIC energy so the search range is bounded by
  // physics and independent of how much water there is (grams of humidity in
  // a helium loop search the same interval as a flooded vessel).
  //
  // Not every u in that interval is a real state at THIS specific volume:
  // below the triple-point isotherm the water would be ice, and a dilute
  // node (v beyond the saturation line's reach, ~206 m³/kg) has no
  // sub-saturation states at all. calculateState throws on those, and the
  // throw is INFORMATION - it says the trial u is off the cold end of the
  // physical band - so the search uses it to tighten the bracket rather than
  // swallowing it.
  let lo = U_SPECIFIC_MIN;
  let hi = U_SPECIFIC_MAX;

  let water: Water.WaterState | null = null;   // state at the current iterate
  let uAt = NaN;                               // u that produced `water`

  /** f(u) = m·u + n·Cv·T(u) − U_total, strictly increasing in u.
   *  Returns null when (u, v) is not a physical water state. */
  const probe = (u: number): number | null => {
    let ws: Water.WaterState;
    try {
      ws = Water.calculateState(waterMass, waterMass * u, volume);
    } catch {
      return null;
    }
    water = ws;
    uAt = u;
    return waterMass * u + gasHeatCapacity * ws.temperature - totalEnergy;
  };

  /** Evaluate at `u`, walking back toward the known-feasible `anchor` if the
   *  trial state is not physical. Deliberately does NOT touch lo/hi: an
   *  infeasible probe carries no sign information, so letting it move the
   *  bracket can collapse the interval onto nothing. A shortened step toward
   *  the anchor is exactly what a safeguarded method should do here. */
  const probeFeasible = (u: number, anchor: number): { u: number; f: number } | null => {
    let trial = u;
    for (let i = 0; i < 40; i++) {
      const f = probe(trial);
      if (f !== null) return { u: trial, f };
      trial = 0.5 * (trial + anchor);
      if (Math.abs(trial - anchor) < 1e-9 * Math.max(1, Math.abs(anchor))) break;
    }
    return null;
  };

  // Seed the water's specific energy from the previous temperature. Which
  // estimator is well-conditioned depends on who holds the energy:
  //
  //  - Water-dominated: u ~ (U_total − n·Cv·T_prev)/m. Exact bookkeeping.
  //  - Gas-dominated: that SAME subtraction is two nearly-equal numbers over
  //    a tiny mass. For grams of steam in a helium loop the difference is
  //    pure round-off and the "seed" comes out anywhere from negative to
  //    1e11 J/kg. Estimate the water's own energy from T instead - it does
  //    not reference the gas at all, so nothing can cancel. A dilute node is
  //    superheated vapour by construction (v = V/m is enormous), so the
  //    low-density caloric form is the right one.
  const gasEnergyAtGuess = gasHeatCapacity * temperatureGuess;
  const seedRaw = gasEnergyAtGuess > 0.5 * Math.abs(totalEnergy)
    ? 2.375e6 + 1500 * (temperatureGuess - 273.16)
    : (totalEnergy - gasEnergyAtGuess) / waterMass;
  const seed = clampToRange(seedRaw, lo, hi);

  let first = probeFeasible(seed, 0.5 * (lo + hi));
  if (!first) {
    // Seed unusable (stale temperature, or a node far from equilibrium).
    // Sweep the physical band for any feasible point before giving up.
    for (let e = 3; e <= 6.98 && !first; e += 0.1) {
      const u = Math.pow(10, e);
      const f = probe(u);
      if (f !== null) first = { u, f };
    }
  }
  if (!first) {
    throw new Error(
      `[Mixture] No physical water state anywhere in u = ${(lo / 1e3).toFixed(1)}..` +
      `${(hi / 1e3).toFixed(1)} kJ/kg at v=${(volume / waterMass).toExponential(3)} m³/kg. ` +
      `m_water=${waterMass.toExponential(3)} kg, n_gas=${gasMoles.toFixed(1)} mol, ` +
      `U_total=${(totalEnergy / 1e6).toFixed(4)} MJ, V=${volume.toFixed(3)} m³, ` +
      `T_guess=${temperatureGuess.toFixed(1)} K`
    );
  }

  let u0 = first.u;
  let f0 = first.f;
  if (f0 < 0) lo = Math.max(lo, u0); else hi = Math.min(hi, u0);

  // Second point for the secant: a Newton-ish step using an order-of-magnitude
  // water heat capacity. df/du ≈ m·(1 + n·Cv/(m·cv_water)); cv_water ~ 2000
  // J/kg-K is close enough to start, and the secant corrects it immediately.
  const dfdu_seed = waterMass * (1 + gasHeatCapacity / (waterMass * 2000));
  let u1 = clampToRange(u0 - f0 / dfdu_seed, lo, hi);
  if (Math.abs(u1 - u0) < 1e-9 * Math.max(1, u0)) {
    u1 = clampToRange(u0 + (f0 < 0 ? 1 : -1) * (1e3 + 1e-3 * u0), lo, hi);
  }
  let second = probeFeasible(u1, u0);
  if (!second) {
    throw new Error(
      `[Mixture] Could not find a second feasible point from u=${(u0 / 1e3).toFixed(2)} kJ/kg ` +
      `(v=${(volume / waterMass).toExponential(3)} m³/kg)`
    );
  }
  u1 = second.u;
  let f1 = second.f;
  if (f1 < 0) lo = Math.max(lo, u1); else hi = Math.min(hi, u1);

  // Bracketed secant. Tolerance is on the energy residual relative to the
  // node's total energy scale, so it means the same thing at every size.
  const tol = 1e-10 * Math.max(Math.abs(totalEnergy), 1) + 1e-6;
  let iterations = 2;
  const MAX_ITER = 40;
  while (iterations < MAX_ITER && Math.abs(f1) > tol) {
    const denom = f1 - f0;
    let u2 = denom !== 0 ? u1 - f1 * (u1 - u0) / denom : 0.5 * (lo + hi);
    // Safeguard: a secant step that leaves the bracket (or stalls) bisects
    // instead. Guarantees convergence without ever clamping the ANSWER.
    if (!(u2 > lo && u2 < hi)) u2 = 0.5 * (lo + hi);

    const next = probeFeasible(u2, u1);
    if (!next) break;
    u0 = u1; f0 = f1;
    u1 = next.u; f1 = next.f;
    if (f1 < 0) lo = Math.max(lo, u1); else hi = Math.min(hi, u1);
    iterations++;

    if (hi - lo < 1e-9 * Math.max(1, Math.abs(u1))) break;
  }

  if (Math.abs(f1) > 1e-3 * Math.max(Math.abs(totalEnergy), 1)) {
    throw new Error(
      `[Mixture] Energy split failed to converge after ${iterations} iterations: ` +
      `residual=${(f1 / 1e6).toFixed(6)} MJ of U_total=${(totalEnergy / 1e6).toFixed(6)} MJ. ` +
      `m_water=${waterMass.toExponential(3)} kg, n_gas=${gasMoles.toFixed(1)} mol, ` +
      `V=${volume.toFixed(3)} m³, u_water=${(u1 / 1e3).toFixed(2)} kJ/kg, ` +
      `bracket=[${(lo / 1e3).toFixed(2)}, ${(hi / 1e3).toFixed(2)}] kJ/kg`
    );
  }

  // Make sure the returned properties belong to the converged u, not to some
  // later infeasible probe that bailed out of the loop.
  if (uAt !== u1) probe(u1);
  const ws = water as unknown as Water.WaterState;
  if (!ws) {
    throw new Error('[Mixture] internal error: no water state captured');
  }

  const T = ws.temperature;
  const gasEnergy = gasHeatCapacity * T;
  const gasPressure = (gasMoles * R_GAS * T) / volume;

  return {
    temperature: T,
    pressure: ws.pressure + gasPressure,
    steamPressure: ws.pressure,
    gasPressure,
    phase: ws.phase,
    quality: ws.quality,
    waterEnergy: waterMass * u1,
    gasEnergy,
    iterations,
  };
}

function clampToRange(x: number, lo: number, hi: number): number {
  if (!isFinite(x)) return 0.5 * (lo + hi);
  if (x <= lo) return lo + 1e-6 * (hi - lo);
  if (x >= hi) return hi - 1e-6 * (hi - lo);
  return x;
}
