/**
 * Steam-turbine expansion: stage work and end states.
 *
 * A turbine stage takes steam from (P1, h1) to a lower pressure P2 and hands
 * back the work it did and the state the steam leaves in. Both matter here:
 * the work is the plant's output, and the END STATE is what an extraction
 * line delivers to a feedwater heater, so getting it wrong shows up as a
 * heater that boils its feedwater or does nothing.
 *
 * THE IDEAL EXPANSION, WITHOUT AN ENTROPY TABLE: our property library is
 * built on (u, v) -> (T, P, phase) and carries no entropy, which is all the
 * node physics ever needed. But an isentropic path does not require entropy
 * as a variable - along it,
 *
 *     dh = v dP
 *
 * exactly (Gibbs, with ds = 0). So the ideal end state comes from
 * integrating that down the pressure range, taking v from the REAL property
 * surface at each step through the (P, h) inversion below. Inside the dome
 * that inversion is analytic and outside it is a bracketed bisection, so the
 * path is as good as the steam tables underneath it - and it crosses the
 * saturation line without noticing, which is exactly where a polytropic
 * P*v^n line fails worst (that approximation overstated the available work
 * of a 165 bar -> 0.05 bar expansion by 58%, and its exhaust came out at
 * quality 0.41 against the table's 0.76).
 *
 * The machine's isentropic efficiency is then applied the standard way:
 *
 *     h2 = h1 - eta * (h1 - h2s)
 *
 * so `efficiency` on a turbine component keeps its usual meaning, and the
 * ACTUAL end state (which an extraction line delivers to a feedwater heater,
 * and which the next stage expands from) is recovered from the property
 * surface at (P2, h2).
 *
 * The integration is memoized on quantized inputs: it is a pure function of
 * (P1, h1, P2), a rate operator asks for it several times per solver step
 * with inputs that barely move, and the property calls underneath are the
 * expensive part of the whole model.
 */

import {
  calculateState,
  saturationTemperature,
  saturatedLiquidDensity,
  saturatedVaporDensity,
  saturatedLiquidEnergy,
  saturatedVaporEnergy,
} from './water-properties';

/** Pressure steps per decade of expansion for the dh = v dP integration.
 *  Trapezoidal with one corrector, so the error falls as the step squared;
 *  16 per decade puts a full 165 bar -> 0.05 bar expansion inside 0.5% of
 *  the same integral run 10x finer. */
const STEPS_PER_DECADE = 16;

export interface SteamState {
  P: number;   // Pa
  v: number;   // m3/kg
  u: number;   // J/kg
  h: number;   // J/kg
  T: number;   // K
  quality: number;
  phase: 'liquid' | 'two-phase' | 'vapor';
}

export interface StageResult {
  /** Specific work delivered by the stage (J/kg), >= 0. */
  work: number;
  /** State the steam actually leaves in (after the efficiency haircut). */
  outlet: SteamState;
  /** Ideal end-state enthalpy (J/kg) - diagnostic. */
  hIdeal: number;
}

function stateOf(u: number, v: number): SteamState {
  const s = calculateState(1, u, v);
  return {
    P: s.pressure, v, u, h: u + s.pressure * v,
    T: s.temperature, quality: s.quality, phase: s.phase,
  };
}

/**
 * Enthalpy after an ISENTROPIC expansion from (P1, h1) to P2, by integrating
 * dh = v dP down the pressure range on the real property surface.
 *
 * Trapezoidal in ln P with one corrector step: v varies over orders of
 * magnitude through an expansion, so equal steps in ln P spend resolution
 * where the integrand is actually changing.
 */
export function isentropicEnthalpy(P1: number, h1: number, P2: number): number {
  if (!(P2 < P1)) return h1;
  const decades = Math.log10(P1 / P2);
  const steps = Math.max(4, Math.ceil(STEPS_PER_DECADE * decades));
  const ratio = Math.pow(P2 / P1, 1 / steps);

  let P = P1, h = h1, v = stateAtPh(P1, h1).v;
  for (let i = 0; i < steps; i++) {
    const Pn = i === steps - 1 ? P2 : P * ratio;
    const dP = Pn - P;
    // Predictor with the volume at this end of the step...
    const hPred = h + v * dP;
    // ...then correct with the mean of the two ends
    const vNext = stateAtPh(Pn, hPred).v;
    const hNext = h + 0.5 * (v + vNext) * dP;
    v = stateAtPh(Pn, hNext).v;
    h = hNext;
    P = Pn;
  }
  return h;
}

// The expansion is a pure function of (P1, h1, P2) and a rate operator asks
// for it repeatedly with inputs that barely move between solver stages, so
// results are cached on inputs quantized to 0.1%.
//
// What is cached is the DROP, not the end enthalpy. Quantizing the inlet
// enthalpy to 0.1% is ±2.6 kJ/kg at steam conditions, which is far larger
// than the drop across a stage with a small pressure ratio - so a cached END
// enthalpy borrowed from a neighbouring inlet came back ABOVE the enthalpy it
// was supposed to expand from, an expansion that gains energy. The drop
// varies slowly with inlet enthalpy, so quantizing it is second-order, and
// h1 - drop can never exceed h1.
const isentropicDropCache = new Map<string, number>();
const CACHE_LIMIT = 4096;

export function isentropicEnthalpyCached(P1: number, h1: number, P2: number): number {
  const q = (x: number) => Math.round(Math.log(x) * 1000);
  const key = `${q(P1)}|${q(h1)}|${q(P2)}`;
  let drop = isentropicDropCache.get(key);
  if (drop === undefined) {
    drop = Math.max(0, h1 - isentropicEnthalpy(P1, h1, P2));
    // Plain eviction: the working set is a handful of operating points, and a
    // cache that grows without bound in a long run is a leak, not a cache.
    if (isentropicDropCache.size >= CACHE_LIMIT) isentropicDropCache.clear();
    isentropicDropCache.set(key, drop);
  }
  return h1 - drop;
}

/** The saturation dome at a pressure - the anchor every inversion here uses. */
function dome(P: number) {
  const T = saturationTemperature(P);
  const v_f = 1 / saturatedLiquidDensity(T);
  const v_g = 1 / saturatedVaporDensity(T);
  const u_f = saturatedLiquidEnergy(T);
  const u_g = saturatedVaporEnergy(T);
  return { T, v_f, v_g, u_f, u_g, h_f: u_f + P * v_f, h_g: u_g + P * v_g };
}

/**
 * State at pressure P with specific enthalpy h.
 *
 * The dome decides which branch to take, which is both faster and far more
 * robust than one bisection over the whole isobar: inside the dome the answer
 * is analytic (quality from the enthalpy split), and outside it the dome
 * provides the exact bracket, so no probe is ever handed an impossible
 * (u, v) pair - a vapor-like energy at a liquid-like volume, which is what a
 * naive bracket does and which the property library rightly refuses.
 */
export function stateAtPh(P: number, h: number): SteamState {
  if (!(P > 0 && h > 0)) {
    throw new Error(`[Turbine] stateAtPh: nonsense inputs P=${P} Pa, h=${h} J/kg`);
  }
  const d = dome(P);

  // Wet steam: quality straight from the enthalpy split
  if (h > d.h_f && h < d.h_g) {
    const x = (h - d.h_f) / (d.h_g - d.h_f);
    const v = d.v_f + x * (d.v_g - d.v_f);
    return { P, v, u: h - P * v, h, T: d.T, quality: x, phase: 'two-phase' };
  }

  // Subcooled liquid: v barely moves, so the saturated-liquid volume at this
  // pressure is the state to within far less than the model's own accuracy
  if (h <= d.h_f) {
    return { P, v: d.v_f, u: h - P * d.v_f, h, T: d.T, quality: 0, phase: 'liquid' };
  }

  // Superheated vapor. Search on INTERNAL ENERGY rather than volume, with
  // v = (h - u)/P: that keeps every probe at or above the saturated-vapor
  // energy of the isobar, where a search on volume walks the constant-h line
  // straight out of the vapor region and hands the property library a state
  // it rightly refuses (sub-saturation energy at a huge specific volume).
  //
  // The dense end is exact: u = h - P*v_g puts the probe at v_g with more
  // energy than u_g, which is superheated and above P. From there, marching
  // the energy DOWN grows the volume and drops the pressure, so the first
  // probe below P brackets the answer - and the march never runs far past
  // it, because the answer's volume is a small multiple of v_g.
  // The bracket is exact and needs no searching: at u = u_g the volume is
  // v_g + (h - h_g)/P, which is thinner than saturated vapor and so below P;
  // at u = h - P*v_g the volume is v_g itself with more than u_g of energy,
  // which is above P. Its width is precisely the superheat margin h - h_g, so
  // it collapses onto the dome exactly as the superheat vanishes - a nascent
  // superheat section is saturated vapor, and comes back as such.
  const pAtU = (u: number) => calculateState(1, u, (h - u) / P).pressure;
  let uLo = d.u_g;
  let uHi = h - P * d.v_g;
  for (let i = 0; i < 50; i++) {
    const um = 0.5 * (uLo + uHi);
    if (pAtU(um) > P) uHi = um; else uLo = um;
    if (uHi - uLo < 10) break;
  }
  const u = 0.5 * (uLo + uHi);
  return stateOf(u, (h - u) / P);
}

/**
 * Expand steam from `inlet` to pressure P2 at isentropic efficiency `eta`.
 *
 * Returns zero work (and the inlet state) when there is nothing to expand
 * into - P2 at or above the inlet pressure - so a stage list that runs past
 * the machine's own pressure costs nothing and needs no special-casing.
 */
export function expandStage(inlet: SteamState, P2: number, eta: number): StageResult {
  if (!(P2 > 0) || P2 >= inlet.P) {
    return { work: 0, outlet: inlet, hIdeal: inlet.h };
  }
  const hIdeal = isentropicEnthalpyCached(inlet.P, inlet.h, P2);
  // An expansion that RAISED enthalpy would mean the integration walked off
  // the property surface - worth stopping over, not smoothing away. The
  // tolerance is round-off, not slack: across a pressure ratio of a fraction
  // of a percent the whole drop is a few J/kg, and floating-point noise in
  // the property calls is the same size.
  if (hIdeal > inlet.h * (1 + 1e-9)) {
    throw new Error(
      `[Turbine] expansion from ${(inlet.P / 1e5).toFixed(2)} bar to ${(P2 / 1e5).toFixed(2)} bar ` +
      `raised enthalpy ${(inlet.h / 1e3).toFixed(0)} -> ${(hIdeal / 1e3).toFixed(0)} kJ/kg. ` +
      `The isentropic integration left the property surface.`
    );
  }
  const h2 = inlet.h - eta * (inlet.h - hIdeal);
  return { work: inlet.h - h2, outlet: stateAtPh(P2, h2), hIdeal };
}

/**
 * March steam through a machine: expand from `inlet` down through each stage
 * pressure in turn, with `flowAt(i)` kilograms per second passing through
 * stage i (extraction leaves between stages, so later stages carry less).
 *
 * Returns the power of each stage and the state leaving it, so the caller
 * can charge each stream's work to the node that actually holds that mass.
 */
export function expandMachine(
  inlet: SteamState,
  stagePressures: number[],
  eta: number,
  flowAt: (stageIndex: number) => number,
): Array<{ power: number; work: number; outlet: SteamState }> {
  const out: Array<{ power: number; work: number; outlet: SteamState }> = [];
  let state = inlet;
  for (let i = 0; i < stagePressures.length; i++) {
    const stage = expandStage(state, stagePressures[i], eta);
    out.push({ power: Math.max(0, flowAt(i)) * stage.work, work: stage.work, outlet: stage.outlet });
    state = stage.outlet;
  }
  return out;
}
