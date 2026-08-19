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
