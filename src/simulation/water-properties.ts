/**
 * Water/Steam Properties Module
 *
 * Re-exports the v4 (u,v) grid-based implementation.
 * This module uses a custom-built (u,v) grid from IAPWS-IF97 equations
 * with saturation-anchored interpolation for compressed liquid.
 */

export * from './water-properties-v4';

/**
 * Surface tension of water against its own vapor - IAPWS R1-76(2014):
 *   sigma = B tau^mu (1 + b tau),  tau = 1 - T/Tc
 * with B = 235.8 mN/m, b = -0.625, mu = 1.256. Valid from the triple point
 * to the critical point, where it vanishes - and a vanishing sigma is not a
 * degenerate corner but the physics itself: no interface, nothing to
 * stratify, which is exactly what the phase-separation model needs there.
 */
export function surfaceTension(T_K: number): number {
  const tau = 1 - T_K / 647.096;
  if (tau <= 0) return 0;   // at/above critical: no liquid-vapor interface
  return 235.8e-3 * Math.pow(tau, 1.256) * (1 - 0.625 * tau);
}

/**
 * Dynamic viscosity of saturated liquid water (Pa s).
 *
 * Vogel-Fulcher-Tammann form fitted to the IAPWS saturated-liquid line:
 *   mu = A exp(B / (T - C)),  A = 2.414e-5, B = 570.6, C = 140.0
 * This is the classic three-parameter water fit; it holds to a few percent
 * from the triple point to ~250 C and degrades gracefully above that.
 *
 * The temperature dependence is the point of having it at all: water is ten
 * times less viscous at 150 C than at 20 C, and any film or boundary layer
 * built on a single room-temperature value is wrong by that factor wherever
 * it matters. Near the critical point the fit has no physics left in it, so
 * it is blended onto the critical viscosity over the last 20 K rather than
 * being allowed to run away.
 */
export function liquidViscosity(T_K: number): number {
  const MU_CRIT = 3.95e-5;   // Pa s, IAPWS value at 647.096 K
  const T = Math.min(T_K, 647.096);
  const vft = 2.414e-5 * Math.exp(570.6 / Math.max(T - 140.0, 1));
  // Last 20 K: cross-fade onto the critical value, where the fit is spent.
  const blend = Math.min(1, Math.max(0, (T - 627.096) / 20));
  return (1 - blend) * vft + blend * MU_CRIT;
}

/**
 * Thermal conductivity of saturated liquid water (W/m-K).
 *
 * Quadratic in temperature, fitted to the IAPWS saturated-liquid line at
 * 300/450/600 K and within ~1.5% of it from the triple point to 640 K: it
 * rises from 0.57 at the triple point to a maximum of 0.685 near 415 K and
 * falls to 0.41 by 640 K. The MAXIMUM is the part worth keeping - a
 * monotonic fit gets the sign of the trend wrong over half the range a
 * plant visits.
 */
export function liquidThermalConductivity(T_K: number): number {
  const T = Math.min(Math.max(T_K, 273.15), 647.096);
  return -0.27279 + 4.6043e-3 * T - 5.5356e-6 * T * T;
}
