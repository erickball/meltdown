/**
 * Inverse water properties: (T, P) -> (u, v).
 *
 * The forward direction - calculateState(m, U, V) -> (T, P, phase) - is what
 * the simulation runs on, because mass and energy are the conserved
 * quantities. But INITIAL CONDITIONS are naturally written the other way
 * round: a preset says "this node is superheated steam at 165 bar and 565 C",
 * and the factory has to turn that into the (mass, energy) pair that reads
 * back as exactly those conditions.
 *
 * Getting that inversion wrong puts a step change into every plant at t = 0.
 * The node is built claiming one temperature, the first constraint evaluation
 * derives another from its (m, U, V), and the difference is dumped into the
 * transient the solver then has to chase. The previous approach - ideal-gas
 * density plus u = u_g(T_sat(P)) + 1500*(T - T_sat) - was off by 74 K for
 * steam at 6 MPa / 700 K, and worse at higher pressure where steam is least
 * ideal.
 *
 * This inverts the real tables instead, as two nested monotone bisections:
 *
 *   inner: at fixed v, T increases with u   -> u such that T(u, v) = T_target
 *   outer: at fixed T, P decreases with v   -> v such that P(v)    = P_target
 *
 * Both directions are monotone, so bisection converges unconditionally; there
 * is no initial guess to get wrong. It runs once per node at construction, so
 * the ~10^2 table lookups it costs are irrelevant.
 */

import { calculateState } from './water-properties-v4';

const R_WATER = 461.5;  // J/kg-K

export interface SuperheatedPoint {
  specificVolume: number;   // m³/kg
  specificEnergy: number;   // J/kg
  temperature: number;      // K - achieved (should match the target)
  pressure: number;         // Pa - achieved
}

/**
 * Find the superheated-vapour state at (T, P) by inverting the steam tables.
 * Returns null if the inversion cannot be bracketed (caller should fall back
 * and say so loudly rather than pretending).
 */
export function superheatedFromTP(T_target: number, P_target: number): SuperheatedPoint | null {
  if (!(T_target > 0) || !(P_target > 0)) return null;

  /** T at (u, v), or null if that state is not evaluable. */
  const tempAt = (u: number, v: number): number | null => {
    try {
      return calculateState(1, u, v).temperature;
    } catch {
      return null;
    }
  };

  /** u such that T(u, v) = T_target, by bisection on the monotone T(u). */
  const energyForTemp = (v: number): number | null => {
    // Ideal-gas caloric estimate only to CENTRE the bracket; the bisection
    // does not depend on it being good.
    // Keep the starting bracket close to the estimate: probing wildly high
    // energies drags calculateState into its beyond-grid extrapolation and
    // makes it log warnings about states we are only searching through, never
    // using. The expansion loops below widen it if the target is outside.
    const u_mid = 2.375e6 + 1500 * (T_target - 273.16);
    let lo = Math.max(1e3, u_mid - 0.8e6);
    let hi = Math.min(9.3e6, u_mid + 0.8e6);

    let tLo = tempAt(lo, v);
    let tHi = tempAt(hi, v);
    // Walk the ends inward until both are evaluable
    for (let i = 0; i < 40 && tLo === null; i++) { lo = lo + 0.25 * (hi - lo); tLo = tempAt(lo, v); }
    for (let i = 0; i < 40 && tHi === null; i++) { hi = hi - 0.25 * (hi - lo); tHi = tempAt(hi, v); }
    if (tLo === null || tHi === null) return null;
    // Expand if the target is outside
    for (let i = 0; i < 30 && tLo > T_target && lo > 1.1e3; i++) {
      lo = Math.max(1e3, lo * 0.7);
      const t = tempAt(lo, v);
      if (t === null) break;
      tLo = t;
    }
    for (let i = 0; i < 30 && tHi < T_target && hi < 9.29e6; i++) {
      hi = Math.min(9.3e6, hi * 1.3);
      const t = tempAt(hi, v);
      if (t === null) break;
      tHi = t;
    }
    if (!(tLo <= T_target && T_target <= tHi)) return null;

    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      const t = tempAt(mid, v);
      if (t === null) return null;
      if (t < T_target) lo = mid; else hi = mid;
      if (hi - lo < 1e-3) break;
    }
    return 0.5 * (lo + hi);
  };

  /** P at the (u, v) that sits on the T_target isotherm at this v. */
  const pressureAt = (v: number): number | null => {
    const u = energyForTemp(v);
    if (u === null) return null;
    try {
      return calculateState(1, u, v).pressure;
    } catch {
      return null;
    }
  };

  // Outer bisection on v. P falls monotonically with v along an isotherm, so
  // bracket around the ideal-gas volume and expand.
  const v_ideal = (R_WATER * T_target) / P_target;
  let vLo = v_ideal * 0.3;   // higher P
  let vHi = v_ideal * 3.0;   // lower P

  let pLo = pressureAt(vLo);
  let pHi = pressureAt(vHi);
  for (let i = 0; i < 30 && (pLo === null || pLo < P_target); i++) {
    vLo *= 0.6;
    if (vLo < 1e-4) break;
    pLo = pressureAt(vLo);
  }
  for (let i = 0; i < 30 && (pHi === null || pHi > P_target); i++) {
    vHi *= 1.7;
    if (vHi > 1e5) break;
    pHi = pressureAt(vHi);
  }
  if (pLo === null || pHi === null) return null;
  if (!(pLo >= P_target && P_target >= pHi)) return null;

  for (let i = 0; i < 60; i++) {
    const vMid = Math.sqrt(vLo * vHi);   // geometric: v spans decades
    const p = pressureAt(vMid);
    if (p === null) return null;
    if (p > P_target) vLo = vMid; else vHi = vMid;
    if (vHi / vLo < 1 + 1e-9) break;
  }

  const v = Math.sqrt(vLo * vHi);
  const u = energyForTemp(v);
  if (u === null) return null;

  let achieved;
  try {
    achieved = calculateState(1, u, v);
  } catch {
    return null;
  }

  return {
    specificVolume: v,
    specificEnergy: u,
    temperature: achieved.temperature,
    pressure: achieved.pressure,
  };
}
