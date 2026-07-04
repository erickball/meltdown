/**
 * Centrifugal pump head curve (affinity-law quadratic).
 *
 * Real pumps do not deliver constant head: head falls off with flow and reaches
 * zero at runout. Constant-head pumps are qualitatively wrong - flow is then
 * limited only by pipe friction (typically ~2x rated flow) and startup produces
 * violent inrush transients that water-hammer small downstream nodes.
 *
 *   H(Q, s) = H_rated * (1.25 * s² - 0.25 * (Q / Q_rated)²)
 *
 * - Shutoff head (Q=0, s=1): 1.25 * H_rated (typical centrifugal: 1.2-1.3x)
 * - Rated point (Q=Q_rated, s=1): exactly H_rated
 * - Runout (H=0, s=1): Q = sqrt(5) * Q_rated ≈ 2.24x rated
 * - Affinity laws: head scales with s², flow with s, so the Q² coefficient is
 *   speed-independent and the curve family is self-similar.
 * - Beyond runout the head continues smoothly negative (the pump becomes an
 *   obstruction) - self-limiting with no clamping.
 * - Reverse flow (Q < 0) sees shutoff head (the impeller still pushes forward);
 *   reverse flow through running pumps is additionally blocked by high friction
 *   in the momentum operator.
 */

const g = 9.81; // m/s²

interface PumpLike {
  ratedHead: number;      // m
  ratedFlow: number;      // kg/s
  effectiveSpeed: number; // 0-1
}

/** Head as a fraction of ratedHead at the given flow and speed. */
export function pumpHeadFraction(massFlowRate: number, ratedFlow: number, effectiveSpeed: number): number {
  const s = effectiveSpeed;
  const q = ratedFlow > 0 ? Math.max(0, massFlowRate) / ratedFlow : 0;
  return 1.25 * s * s - 0.25 * q * q;
}

/** Pump differential pressure (Pa) at the given flow and pumped-fluid density. */
export function pumpHeadPressure(pump: PumpLike, massFlowRate: number, rho: number): number {
  return pumpHeadFraction(massFlowRate, pump.ratedFlow, pump.effectiveSpeed) * pump.ratedHead * rho * g;
}

/**
 * Magnitude of the (negative) head-curve slope d(dP_pump)/d(mdot) in Pa/(kg/s).
 * Used as an implicit damping term by the pressure solver - the falling curve
 * resists flow perturbations just like friction does.
 */
export function pumpHeadSlopeMagnitude(pump: PumpLike, massFlowRate: number, rho: number): number {
  if (pump.ratedFlow <= 0 || massFlowRate <= 0) return 0;
  return 0.5 * pump.ratedHead * rho * g * massFlowRate / (pump.ratedFlow * pump.ratedFlow);
}
