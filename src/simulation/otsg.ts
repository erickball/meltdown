/**
 * Moving-boundary once-through steam generator - analytic core.
 *
 * See docs/otsg-moving-boundary-design.md. The tube side of an OTSG is up to
 * three sections in series - subcooled liquid / two-phase / superheated
 * vapor - whose boundaries move so each section stays in ONE phase regime by
 * construction. The regime transitions live at the interfaces, not inside
 * nodes, which is what removes both lumped-SG pathologies at once: bulk
 * temperatures that cannot express a counterflow cross, and phase-spanning
 * lumps that pin the whole exchanger at T_sat.
 *
 * STATE. The reference closure (evaluateOtsg) integrates section masses m1,
 * m2, m3 and the superheat energy U3 and solves pressure from the volume.
 * The RUNTIME closure (evaluateOtsgPartition) is the one the plant uses: the node's
 * ordinary (mass, energy) totals and its (u,v) pressure stay where they are,
 * and the WHOLE partition is SOLVED from them - no partition state is
 * integrated at all. The one degree of freedom the totals cannot supply (a
 * cold slug plus hot steam and lukewarm mush have identical totals) comes
 * from the WALL: the superheat section's temperature is pinned by its own
 * approach to its own metal. See evaluateOtsgAtP for the closure and the
 * regime lattice. Everything else is DERIVED here:
 *  - the subcooled and two-phase section mean states come from linear
 *    profile assumptions (mean enthalpy midway between the section's inlet
 *    and its saturation boundary; quality linear along the boiling section,
 *    MASS-averaged over that profile - see boilingMeanQuality) - the standard
 *    moving-boundary closure;
 *  - pressure comes from the volume constraint sum(m_i v_i) = V_tube in the
 *    reference closure; in the runtime one that constraint sets the split
 *    instead, and pressure comes from the node;
 *  - section lengths/areas are proportional to section volumes;
 *  - the interface mass fluxes W12 (at h_f) and W23 (at h_g) follow from
 *    the section energy balances with the profiles held - derived in the
 *    design doc, verified energy-exact by test.
 *
 * EMPTY SECTIONS die and are born asymptotically: every rate a section owns
 * carries its area (proportional to its mass), so m -> 0 sends all its
 * physics to zero smoothly, and the first gram entering restores it. No
 * switching, no minimum masses.
 *
 * This module is pure functions over plain data - no solver imports - so the
 * physics is unit-testable in isolation before it touches the plant.
 */

import {
  calculateState,
  saturationTemperature,
  saturatedLiquidEnergy,
  saturatedVaporEnergy,
  saturatedLiquidDensity,
  saturatedVaporDensity,
  estimateVaporV,
} from './water-properties';

// ---------------------------------------------------------------------------
// Saturation bundle
// ---------------------------------------------------------------------------

/** Tube-side film coefficients (W/m2-K). The gas shell is the limiting
 *  resistance by an order of magnitude, so correlation-grade constants are
 *  adequate; each is the standard scale for its regime. Live here (pure
 *  module) so the factory's design-point seeding and the operator's duty
 *  calculation use the SAME numbers by construction. */
export const H_TUBE_LIQUID = 4000;
export const H_TUBE_BOILING = 25000;
export const H_TUBE_STEAM = 1200;
export const H_TUBE_NATURAL = 250;

export interface SaturationProps {
  P: number;      // Pa
  T: number;      // K
  u_f: number;    // J/kg
  u_g: number;
  v_f: number;    // m3/kg
  v_g: number;
  h_f: number;    // J/kg
  h_g: number;
}

/** Pa - the critical pressure. Above it water has no phase boundary at all,
 *  which the sectioned model has to say out loud rather than extrapolate
 *  through (see saturationAtP and evaluateOtsgAtP). */
export const P_CRITICAL = 22.064e6;

export function saturationAtP(P: number): SaturationProps {
  // Above the critical pressure there IS no saturation state. Left to itself
  // saturationTemperature extrapolates its table straight past the dome and
  // returns temperatures like 679 K at 300 bar, while the u/v lookups quietly
  // saturate at the dome's top point - a phase boundary that does not exist,
  // at a temperature that does not either. Anchor on the top of the dome
  // instead: that IS the pseudo-critical point a supercritical boiler
  // transitions through, and evaluateOtsgAtP stops splitting phases there.
  const T = saturationTemperature(Math.min(P, P_CRITICAL));
  const u_f = saturatedLiquidEnergy(T);
  const u_g = saturatedVaporEnergy(T);
  const v_f = 1 / saturatedLiquidDensity(T);
  const v_g = 1 / saturatedVaporDensity(T);
  return { P, T, u_f, u_g, v_f, v_g, h_f: u_f + P * v_f, h_g: u_g + P * v_g };
}

// ---------------------------------------------------------------------------
// The boiling section's mean state
// ---------------------------------------------------------------------------

/**
 * MASS-averaged quality of a boiling section carrying a linear quality
 * profile - the closure this model rests on, done properly.
 *
 * A linear profile means quality runs 0 -> 1 with POSITION, so the
 * length-averaged quality is 1/2. That is the number the moving-boundary
 * literature quotes and the number this model used everywhere. But a
 * section's mass is not distributed along its length evenly: mass integrates
 * DENSITY,
 *
 *     dm = A dz / v(z),    v(z) = v_f + x(z) (v_g - v_f)
 *
 * so the dense, low-quality end holds most of the kilograms and the
 * MASS-averaged quality is far below one half. Averaging the specific volume
 * arithmetically instead - v = (v_f + v_g)/2, which is what a length average
 * gives - overstates how much room a given mass of boiling water needs: by
 * 21% at 165 bar and by nearly 4x at atmospheric pressure. That was enough to
 * put 2.6x the tube volume into an Xe-100 bundle while the reported section
 * lengths still looked reasonable, because they are normalized over the
 * sections' own summed volume.
 *
 * Integrating dm and x dm over the profile gives, with L = ln(v_g/v_f):
 *
 *     v-bar = (v_g - v_f) / L          (the logarithmic mean)
 *     x-bar = 1/L - v_f/(v_g - v_f)
 *
 * and the two are consistent by construction: v_f + x-bar (v_g - v_f) = v-bar.
 * This is the same reason a heat exchanger uses a log-mean temperature
 * difference rather than an arithmetic one.
 *
 * Near the critical point the phases converge, L -> 0, and the expression
 * tends to exactly 1/2 - so the old assumption is the correct LIMIT of this
 * one, which is why it never looked wrong at high pressure. The series form
 * takes over there because the closed form is 0/0.
 */
export function boilingMeanQuality(v_f: number, v_g: number, xOut = 1): number {
  return (boilingMeanVolume(v_f, v_g, xOut) - v_f) / (v_g - v_f);
}

/**
 * MASS-averaged specific volume of a boiling section whose quality runs from
 * 0 at its inlet to `xOut` at its outlet.
 *
 * `xOut` is the piece the original closure was missing. A linear profile
 * reaching saturated vapour - xOut = 1 - is only what happens when there is
 * a SUPERHEAT SECTION downstream to receive dry steam. A flooded bundle has
 * nowhere to hand it to, so its boiling section ends part-way up the dome,
 * and insisting on the full-range average then demands more vapour than the
 * node holds (the arithmetic that falls out is a negative superheat mass).
 *
 * Integrating dm = A dz / v(z) with v linear in z over [0, xOut]:
 *
 *     v-bar = xOut * dv / ln(1 + xOut * dv / v_f)
 *
 * which is the logarithmic mean of v_f and v(xOut), and reduces to the
 * familiar full-range form at xOut = 1. As xOut -> 0 it tends to v_f: a
 * section that barely boils is liquid, as it must be.
 */
export function boilingMeanVolume(v_f: number, v_g: number, xOut = 1): number {
  const dv = v_g - v_f;
  if (!(dv > 0) || !(v_f > 0)) {
    throw new Error(`[OTSG] boilingMeanVolume: saturation volumes are not ordered ` +
      `(v_f=${v_f}, v_g=${v_g} m3/kg) - the dome has collapsed or the state is not two-phase`);
  }
  if (!(xOut >= 0 && xOut <= 1)) {
    throw new Error(`[OTSG] boilingMeanVolume: outlet quality ${xOut} is outside [0, 1] - ` +
      `a boiling section runs from saturated liquid to at most saturated vapour`);
  }
  const r = xOut * dv / v_f;
  // Series limit: ln(1+r) -> r - r^2/2 + r^3/3, so v-bar -> v_f (1 + r/2).
  // This covers both a barely-boiling section and the critical point, where
  // the phases converge and the closed form is 0/0.
  if (r < 1e-6) return v_f * (1 + r / 2);
  return xOut * dv / Math.log1p(r);
}

// ---------------------------------------------------------------------------
// Regime-specific specific volumes
// ---------------------------------------------------------------------------

/**
 * Subcooled liquid: invert u -> T along the saturated-liquid line, take v_f
 * there. Liquid compressibility is neglected (v changes ~1% over the whole
 * pressure range), which also means section 1 contributes an essentially
 * pressure-independent volume to the closure - physically right, the
 * pressure response of a boiler lives in its vapor.
 */
export function subcooledLiquidV(u: number): number {
  // Secant on T over the saturated-liquid energy curve. The bracket runs to
  // the dome top itself: stopping at 645 K left a 2-K gap under the
  // critical point, and near-critical flooded probes (u ~ 1.9 MJ/kg) landed
  // in it and were refused as "not subcooled" when they plainly are.
  let Tlo = 274, Thi = 647.09;
  const ulo = saturatedLiquidEnergy(Tlo), uhi = saturatedLiquidEnergy(Thi);
  if (u <= ulo) return 1 / saturatedLiquidDensity(274);
  if (u >= uhi) {
    throw new Error(`[OTSG] subcooledLiquidV: u=${(u / 1e3).toFixed(0)} kJ/kg is above ` +
      `the saturated-liquid line's ceiling - this is not a subcooled state`);
  }
  for (let i = 0; i < 60; i++) {
    const Tm = 0.5 * (Tlo + Thi);
    if (saturatedLiquidEnergy(Tm) < u) Tlo = Tm; else Thi = Tm;
    if (Thi - Tlo < 1e-4) break;
  }
  return 1 / saturatedLiquidDensity(0.5 * (Tlo + Thi));
}

/**
 * Superheated vapor: v such that the (u,v) state evaluates to pressure P.
 * Bisection on ln(v) - P falls monotonically with v at fixed u in the vapor
 * region, and the bracket is generous.
 */
export function superheatedV(u: number, P: number, tolLn = 1e-10, vHint?: number): number {
  // Superheated vapor at pressure P always has v > v_g(P), so the saturated-
  // vapor volume is the exact lower bracket - guaranteed inside the property
  // grid's vapor region, unlike any fixed constant (a constant either strays
  // into the compressed-liquid fringe at high P or wastes bracket at low P).
  const satP = saturationAtP(P);
  const vg = satP.v_g;
  // Degenerate near-saturation case: a nascent superheat section sits within
  // property-interpolation noise of the saturated-vapor line, where the
  // bracket has zero width. Its volume IS v_g there (to second order), so
  // return it directly - this is the smooth limit, not a fallback.
  if (u <= satP.u_g + 5e3) return vg;
  // Upper bracket scales with v_g so near-vacuum pressures (v_g ~ 200 m3/kg)
  // stay bracketed when the closure solver probes them.
  let lnLo = Math.log(vg * (1 + 1e-9)), lnHi = Math.log(Math.max(50, vg * 200));
  const pOf = (lnV: number) => calculateState(1, u, Math.exp(lnV)).pressure;
  // A caller iterating nearby states can hand back its previous answer: a
  // +/-30% bracket around it replaces the full five-decade one and cuts the
  // bisection from ~16 property probes to ~4. Verified by the same sign
  // check as the wide bracket - a stale hint just falls through.
  // No caller hint? The inverse vapor index estimates v to a few tenths of
  // a percent in one cheap query; the +/-2% bracket around it is then
  // verified and polished on the ordinary forward surface exactly like a
  // caller hint - same converged answer, ~3 probes instead of ~17.
  let hint = vHint;
  if (!hint) {
    const est = estimateVaporV(u, P);
    if (est && est > vg) hint = est;
  }
  if (hint && hint > vg) {
    // Try a tight bracket around the estimate first (inverse index is good
    // to a few tenths of a percent; a caller's previous iterate better),
    // then a loose one; inside a verified bracket, SECANT on ln P vs ln v -
    // near-affine locally - lands within tolerance in 2-3 probes where
    // bisection took 13.
    for (const span of [1.02, 1.3]) {
      const lo = Math.max(Math.log(vg * (1 + 1e-9)), Math.log(hint / span));
      const hi = Math.min(lnHi, Math.log(hint * span));
      if (hi <= lo) continue;
      let a = lo, b = hi;
      let ra = pOf(a) - P, rb = pOf(b) - P;
      if (!(ra >= 0 && rb <= 0)) continue;
      // Illinois false position: plain regula falsi STALLS on convex
      // residuals (one endpoint sticks and convergence goes one-sided
      // linear - measured ~17 probes per call against the intended ~4).
      // Halving the retained endpoint's residual restores superlinear
      // convergence with the bracket guarantee intact.
      let side = 0;
      for (let i = 0; i < 24; i++) {
        if (b - a < tolLn) break;
        let m = ra - rb !== 0 ? a + (b - a) * ra / (ra - rb) : 0.5 * (a + b);
        if (!(m > a && m < b)) m = 0.5 * (a + b);
        const rm = pOf(m) - P;
        if (rm > 0) {
          a = m; ra = rm;
          if (side === 1) rb *= 0.5;
          side = 1;
        } else {
          b = m; rb = rm;
          if (side === -1) ra *= 0.5;
          side = -1;
        }
      }
      return Math.exp(0.5 * (a + b));
    }
  }
  let pLo = pOf(lnLo), pHi = pOf(lnHi);
  if (!(pLo >= P * (1 - 1e-6) && pHi <= P)) {
    // Near the critical point the isobars run almost flat in v, so the
    // saturation-table v_g and the property grid's own pressure there
    // disagree by up to a percent or two of P - and a state a few tens of
    // kJ/kg above u_g then has no bracket even though it IS just-saturated
    // vapor. Within that table-consistency band the answer is v_g itself
    // (the same limit the u <= u_g + 5 kJ/kg early-exit already takes).
    // Below the band the state genuinely is not vapor at this pressure.
    if (pLo >= P * 0.98 && pLo < P) return vg;
    throw new Error(`[OTSG] superheatedV: P=${(P / 1e5).toFixed(2)} bar not bracketed at ` +
      `u=${(u / 1e3).toFixed(0)} kJ/kg (P(${Math.exp(lnLo).toExponential(1)})=${(pLo / 1e5).toFixed(2)}, ` +
      `P(${Math.exp(lnHi).toExponential(1)})=${(pHi / 1e5).toFixed(2)} bar). ` +
      `The superheat section state is outside the vapor region.`);
  }
  for (let i = 0; i < 80; i++) {
    const lnM = 0.5 * (lnLo + lnHi);
    if (pOf(lnM) > P) lnLo = lnM; else lnHi = lnM;
    if (lnHi - lnLo < tolLn) break;
  }
  return Math.exp(0.5 * (lnLo + lnHi));
}

// ---------------------------------------------------------------------------
// State evaluation: pressure closure and derived geometry
// ---------------------------------------------------------------------------

export interface OtsgState {
  m1: number;   // kg - subcooled section
  m2: number;   // kg - two-phase section
  m3: number;   // kg - superheated section
  U3: number;   // J  - superheated section energy (its only free intensive DOF)
}

export interface OtsgGeometry {
  tubeVolume: number;  // m3 - total tube-side volume
  tubeLength: number;  // m  - effective heated length
  heatArea: number;    // m2 - total tube heat-transfer area
}

export interface OtsgSectionEval {
  mass: number;
  vBar: number;      // mean specific volume (m3/kg)
  volume: number;    // m3
  lengthFrac: number;
  area: number;      // m2 - heat-transfer area allotted to this section
  hBar: number;      // mean specific enthalpy (J/kg)
  T: number;         // representative temperature seen by the wall (K)
}

export interface OtsgEval {
  P: number;
  sat: SaturationProps;
  sections: [OtsgSectionEval, OtsgSectionEval, OtsgSectionEval];
  /** Steam-outlet specific enthalpy: superheated state, or h_g pass-through
   *  when the superheat section is empty. Smoothly mass-weighted between the
   *  two so an emptying section does not step the draw enthalpy. */
  hSteamOut: number;
  u3: number;        // superheat specific energy actually used (J/kg)
  /** Quality the boiling section reaches at its OUTLET. 1 whenever there is
   *  anything downstream to hand dry steam to; below 1 only for a flooded
   *  bundle whose boiling section IS the top of the tube. */
  x2Out: number;
  /** Which of the closure's cases produced this split - see evaluateOtsgAtP.
   *  'flooded' (no dry steam), 'dryout' (dry steam at saturation), 'superheat'
   *  (volume and energy both enforced), 'supercritical' (no dome at all). */
  regime: 'flooded' | 'dryout' | 'superheat' | 'supercritical';
}

const P_MIN = 700;      // Pa - just above the triple point
const P_MAX = 2.15e7;   // Pa - just below critical

/**
 * Evaluate the tube side: solve pressure from the volume constraint and
 * derive every section's geometry and mean state.
 *
 * @param uFeedIn  feed specific internal energy (J/kg) - sets the subcooled
 *                 section's mean via the linear profile
 */
export function evaluateOtsg(
  state: OtsgState,
  geom: OtsgGeometry,
  uFeedIn: number,
): OtsgEval {
  const { m1, m2, m3, U3 } = state;
  if (!(m1 >= 0 && m2 >= 0 && m3 >= 0)) {
    throw new Error(`[OTSG] negative section mass: m=[${m1}, ${m2}, ${m3}] kg`);
  }
  const mTot = m1 + m2 + m3;
  if (mTot <= 0) {
    throw new Error(`[OTSG] tube side is completely empty - the model has no state to evaluate. ` +
      `An OTSG with zero water inventory is a configuration error upstream.`);
  }

  // Superheat specific energy. With m3 = 0 the section has no state of its
  // own; u_g at the solved pressure is its nascent state (pass-through).
  const u3Free = m3 > 0 ? U3 / m3 : NaN;

  const volumeAt = (P: number): { V: number; sat: SaturationProps; v1: number; v2: number; v3: number; u3: number } => {
    const sat = saturationAtP(P);
    const u1Bar = 0.5 * (uFeedIn + sat.u_f);        // linear enthalpy profile
    const v1 = m1 > 0 ? subcooledLiquidV(Math.min(u1Bar, sat.u_f)) : sat.v_f;
    // Mass-averaged over the linear quality profile - see boilingMeanQuality
    const v2 = sat.v_f + boilingMeanQuality(sat.v_f, sat.v_g) * (sat.v_g - sat.v_f);
    const u3 = m3 > 0 ? u3Free : sat.u_g;
    const v3 = m3 > 0 ? superheatedV(Math.max(u3, sat.u_g + 1e3), P) : sat.v_g;
    return { V: m1 * v1 + m2 * v2 + m3 * v3, sat, v1, v2, v3, u3 };
  };

  // Bisection on ln(P): total volume falls monotonically with P (all three
  // v_i shrink as pressure rises), so the bracket is clean.
  let lnLo = Math.log(P_MIN), lnHi = Math.log(P_MAX);
  const vLo = volumeAt(Math.exp(lnLo)).V, vHi = volumeAt(Math.exp(lnHi)).V;
  if (!(vLo >= geom.tubeVolume && vHi <= geom.tubeVolume)) {
    throw new Error(`[OTSG] pressure closure not bracketed: need V=${geom.tubeVolume.toFixed(3)} m3, ` +
      `got V(${(P_MIN / 1e5).toFixed(3)} bar)=${vLo.toFixed(3)}, V(${(P_MAX / 1e5).toFixed(1)} bar)=${vHi.toFixed(3)} m3 ` +
      `with m=[${m1.toFixed(1)}, ${m2.toFixed(1)}, ${m3.toFixed(1)}] kg. ` +
      `The inventory cannot occupy the tube volume at any physical pressure.`);
  }
  for (let i = 0; i < 100; i++) {
    const lnM = 0.5 * (lnLo + lnHi);
    if (volumeAt(Math.exp(lnM)).V > geom.tubeVolume) lnLo = lnM; else lnHi = lnM;
    if (lnHi - lnLo < 1e-12) break;
  }
  const P = Math.exp(0.5 * (lnLo + lnHi));
  const fin = volumeAt(P);
  const sat = fin.sat;

  // Section mean enthalpies (profile closures; section 3 is free)
  const u1Bar = 0.5 * (uFeedIn + sat.u_f);
  const h1Bar = u1Bar + P * fin.v1;
  // Same mass-weighting as the volume: the enthalpy a kilogram of this
  // section carries on average, not the enthalpy at its mid-LENGTH
  const x2Bar = boilingMeanQuality(sat.v_f, sat.v_g);
  const h2Bar = sat.h_f + x2Bar * (sat.h_g - sat.h_f);
  const h3Bar = fin.u3 + P * fin.v3;

  // Representative wall-facing temperatures: subcooled at its mean
  // (inverted from u1Bar), two-phase at T_sat, superheated at its state.
  const T1 = m1 > 0 ? tempOfSubcooledU(Math.min(u1Bar, sat.u_f)) : sat.T;
  const T3 = m3 > 0 ? calculateState(1, fin.u3, fin.v3).temperature : sat.T;

  const V1 = m1 * fin.v1, V2 = m2 * fin.v2, V3 = m3 * fin.v3;
  const VT = Math.max(1e-12, V1 + V2 + V3);
  const mk = (mass: number, vBar: number, V: number, hBar: number, T: number): OtsgSectionEval => ({
    mass, vBar, volume: V,
    lengthFrac: V / VT,
    area: geom.heatArea * (V / VT),
    hBar, T,
  });

  // Steam-draw enthalpy: superheated state, blending smoothly to h_g as the
  // superheat section empties (mass-weighted over the last ~1 kg so the draw
  // never steps).
  const w = m3 / (m3 + 1);
  const hSteamOut = w * h3Bar + (1 - w) * sat.h_g;

  return {
    P, sat,
    sections: [
      mk(m1, fin.v1, V1, h1Bar, T1),
      mk(m2, fin.v2, V2, h2Bar, sat.T),
      mk(m3, fin.v3, V3, h3Bar, T3),
    ],
    hSteamOut,
    u3: fin.u3,
    // The reference closure carries m3 as state, so its boiling section
    // always has somewhere to hand dry steam to.
    x2Out: 1,
    regime: m3 > 0 ? 'superheat' : 'dryout',
  };
}

/**
 * Outlet quality of a boiling section that has to occupy a given mean
 * specific volume. boilingMeanVolume rises monotonically with xOut from v_f
 * (a section that never boils) to v-bar(1) (one that reaches dry steam), so
 * this inverse is a clean bisection. Volumes outside that span return the
 * endpoint - they are not a boiling section at all.
 */
export function boilingOutletQuality(v_f: number, v_g: number, vBar: number): number {
  if (vBar <= v_f) return 0;
  if (vBar >= boilingMeanVolume(v_f, v_g, 1)) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (boilingMeanVolume(v_f, v_g, mid) < vBar) lo = mid; else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  return 0.5 * (lo + hi);
}

/** J/kg - the top of the property grid's vapor coverage (2000 C steam sits at
 *  ~6.3 MJ/kg). A superheat section is searched for up to here; needing more
 *  than this means the node's totals do not describe water. */
const U3_CEILING = 6.0e6;

/**
 * Mean specific internal energy of the subcooled section: the linear
 * enthalpy profile's midpoint between the feed and saturation.
 *
 * The feed energy is capped ~25 kJ/kg (~6 K) below saturation because the
 * interface flux divides by (h_f - hBar1) and the closure has to stay inside
 * its valid domain. That is a width WITHIN an assumed profile shape - the
 * same standing the melt logistic's width has - not a clamp on any conserved
 * quantity: when the real feed runs hotter (a heat-soaked feed line during a
 * pressure transient), the section simply drains via the now-large W12, which
 * is the physically right outcome for saturated feed.
 */
export function subcooledSectionMean(uFeedIn: number, sat: SaturationProps): number {
  return 0.5 * (Math.min(uFeedIn, sat.u_f - 25e3) + sat.u_f);
}

/**
 * The RUNTIME closure: partition AND pressure solved together from the
 * node's conserved totals, the economizer's integrated energy, and the wall.
 *
 * WHY PRESSURE IS SOLVED HERE. A boiler tube holds cold feed at one end and
 * superheated steam at the other, and both sit BELOW the saturation tie line
 * in (u, v) - the subcooled slug by its energy deficit, the steam because
 * the vapor isobar's du/dv runs at about half the tie line's slope. Blend
 * them into one (u, v) pair and the uniform EOS reads the mixture as
 * low-pressure two-phase: a partition built at 80 bar comes back at 53. That
 * bias is not a detail - the flow solver, the relief valves and the
 * governor were all steering on it. So the tube's pressure is the one the
 * PARTITION needs to pack its sections into the tube volume,
 *
 *     m1 v1(P) + m2 v2(P) + m3 v3(P) = V_tube
 *
 * exactly as the reference closure (evaluateOtsg) always computed it - and
 * OtsgPartitionConstraintOperator publishes it as the node's pressure.
 *
 * THE FOUR DESCRIPTORS AND WHERE EACH COMES FROM. Against the node's two
 * conserved totals the tube carries four unknowns; each gets its value from
 * the physics that actually sets it:
 *   - the ECONOMIZER from its integrated MASS m1: how much cold water is
 *     in the tube is genuine dynamics - the history of feed that has not yet
 *     boiled - with the transit-balance rate (otsgRates) as its update. Its
 *     ENERGY is priced at the profile mean u1(P), so a falling pressure
 *     reprices the slug colder and hands the difference to the vapor side
 *     of the books: the flash a depressurized slug really undergoes;
 *   - the BOILING OUTLET from the structural rule (dry steam only when
 *     there is somewhere to hand it, else the energy says where it stops);
 *   - the SUPERHEAT MASS from the energy total;
 *   - the SUPERHEAT ENERGY from the WALL: the steam's approach to its own
 *     metal, T3 = Tsat + theta_mean (T_wall3 - Tsat) with
 *     theta_mean = hA3/(2 W cp + hA3) - the mean-stream form of the duty
 *     calculation's own theta machinery. A stagnant section soaks to its
 *     metal; a strongly drawn one barely leaves saturation; a cold wall
 *     pins it AT saturation, which is dryout. The steam physically cannot
 *     leave hotter than the metal heating it, which is the property no
 *     integrated vapor state could deliver (measured failure: 329-bar
 *     steam inside what the uniform EOS called a 160-bar node, held for
 *     hundreds of seconds by a drifted ledger).
 *
 * At a given pressure everything is CLOSED FORM - mass and energy split the
 * leftovers in every regime - so the pressure search is one safeguarded
 * 1-D root find on the volume residual, warm-started from the node's last
 * published pressure. Regimes join continuously at their seams (each switch
 * happens exactly where the two descriptions coincide):
 *
 *   m3 < 0  - flooded: no dry steam; the boiling section's mean quality
 *             comes from the energy (and below zero quality the leftovers
 *             are simply cooler-than-saturated liquid - a cold-filled tube
 *             needs no special case, subcooledLiquidV is continuous with
 *             the dome at x = 0);
 *   m2 < 0  - the totals carry more energy than wall-limited steam can
 *             hold: u3 unpins upward and the leftovers are one superheated
 *             region (the post-depressurization transient; Q3 then runs
 *             backwards and relaxes it, and there is no ledger to hold it
 *             there);
 *   above P_MAX - no sub-critical pressure can pack the inventory: the
 *             dome is gone, the tube is one supercritical fluid at its own
 *             uniform (u, v), whose EOS has no tie line to be biased by.
 *
 * THE LEDGER AND ITS LEASH. m1 is the one integrated descriptor left, and
 * it is watched, not trusted: the integrator floors it at zero and ceilings
 * it at the node's own mass; the closure caps the claim at the inventory
 * (draws that removed slug water the ledger never saw leave - reported by
 * OtsgLedgerCheckOperator); and because u3 is pinned, a drifting claim can
 * no longer hide in phantom steam - it shows up as the pressure and the
 * sections visibly disagreeing with the plant around them.
 */

/** How the superheat section's wall pins its temperature - see
 *  evaluateOtsgPartition. Built by the operator (and every diagnostic) from
 *  the bundle's own metal and flows via otsgWallPin in otsg-operator.ts. */
export interface OtsgWallPin {
  TWall3: number;   // K   - the superheat section's metal temperature
  hA3Full: number;  // W/K - steam-film conductance if section 3 owned the whole bundle
  WCp3: number;     // W/K - steam draw's carrying capacity (W_steam * cp)
}

export function evaluateOtsgPartition(
  massTotal: number,
  UTotal: number,
  m1Ledger: number,
  uFeedIn: number,
  geom: OtsgGeometry,
  pin: OtsgWallPin,
  PStart?: number,
): OtsgEval {
  if (!Number.isFinite(m1Ledger) || m1Ledger < 0) {
    throw new Error(`[OTSG] economizer ledger is not a physical mass: m1=${m1Ledger} kg`);
  }
  const V = geom.tubeVolume;

  const probe = (u: number, v: number, what: string) => {
    try {
      return calculateState(1, u, v);
    } catch (e) {
      throw new Error(
        `[OTSG] the ${what} the partition needs is off the property surface: ` +
        `${(u / 1e6).toFixed(1)} MJ/kg at ${v.toFixed(4)} m3/kg. The node holds ` +
        `${massTotal.toFixed(0)} kg with ${(UTotal / 1e9).toFixed(2)} GJ in ` +
        `${V.toFixed(1)} m3, the economizer claims ${m1Ledger.toFixed(0)} kg. ` +
        `(${e instanceof Error ? e.message : String(e)})`);
    }
  };

  // Assemble the final evaluation from a solved configuration.
  const finish = (
    P: number, sat: SaturationProps,
    m1: number, u1: number, v1: number,
    m2: number, x2Bar: number, v2: number,
    m3: number, u3: number, v3: number,
    regime: OtsgEval['regime'],
  ): OtsgEval => {
    const h1Bar = u1 + P * v1;
    const h2Bar = (sat.u_f + x2Bar * (sat.u_g - sat.u_f)) + P * v2;
    const h3Bar = u3 + P * v3;
    const T1 = m1 > 0 ? tempOfSubcooledU(Math.min(u1, sat.u_f)) : sat.T;
    const T2 = m2 > 0 && x2Bar < 0 ? tempOfSubcooledU(Math.min(sat.u_f, sat.u_f + x2Bar * (sat.u_g - sat.u_f))) : sat.T;
    const T3 = m3 > 0 && (u3 > sat.u_g + 1e3 || P >= P_CRITICAL)
      ? probe(u3, v3, 'steam section').temperature
      : sat.T;
    const V1 = m1 * v1, V2 = m2 * v2, V3 = m3 * v3;
    const VT = Math.max(1e-12, V1 + V2 + V3);
    const mk = (mass: number, vBar: number, Vs: number, hBar: number, T: number): OtsgSectionEval => ({
      mass, vBar, volume: Vs,
      lengthFrac: Vs / VT,
      area: geom.heatArea * (Vs / VT),
      hBar, T,
    });
    // Outlet quality from the mean (monotone inversion, no property calls).
    // A flooded section that is subcooled on average never boils at all.
    let x2Out = 1;
    if (m3 <= 0) {
      const xb = Math.max(0, x2Bar);
      const xbMax = boilingMeanQuality(sat.v_f, sat.v_g, 1);
      if (xb >= xbMax) x2Out = 1;
      else {
        let lo = 0, hi = 1;
        for (let i = 0; i < 50; i++) {
          const xm = 0.5 * (lo + hi);
          if (boilingMeanQuality(sat.v_f, sat.v_g, xm) < xb) lo = xm; else hi = xm;
          if (hi - lo < 1e-12) break;
        }
        x2Out = 0.5 * (lo + hi);
      }
    }
    // The draw leaves from the section's OUTLET - but the linear profile's
    // outlet (2 h_bar - h_g) only exists when a boiling section actually
    // FEEDS this one at saturation, so the inlet assumption fades with the
    // boiling section's own presence. A supercritical pass has no h_g inlet
    // at all (its inlet is the feed) and draws at its mean.
    const w2 = m2 / (m2 + 1);
    const hSteamOut = m3 <= 0 ? sat.h_g
      : regime === 'supercritical' ? h3Bar
      : Math.max(sat.h_g, h3Bar + w2 * (h3Bar - sat.h_g));
    return {
      P, sat,
      sections: [
        mk(m1, v1, V1, h1Bar, T1),
        mk(m2, v2, V2, h2Bar, T2),
        mk(m3, v3, V3, h3Bar, T3),
      ],
      hSteamOut, u3, x2Out, regime,
    };
  };

  // Empty tube: nothing to partition and no pressure of its own.
  if (!(massTotal > 0)) {
    const P = PStart ?? 1e5;
    const sat = saturationAtP(P);
    return finish(P, sat, 0, sat.u_f, sat.v_f, 0, 1, sat.v_f, 0, sat.u_g, sat.v_g, 'dryout');
  }

  // One-fluid states short-circuit the pressure walk entirely. A tube of
  // pure liquid or supercritical fluid has no dome to partition across, and
  // both sides' uniform EOS is unbiased (no tie line to blend across) - it
  // IS the pressure. The walk would also be degenerate for liquid: the
  // closure neglects liquid compressibility, so an all-liquid volume
  // residual is flat in P and never crosses zero.
  const bulk = probe(UTotal / massTotal, V / massTotal, 'bulk state');
  if (bulk.pressure >= P_CRITICAL) {
    // Dense supercritical fluid can come back labelled 'liquid' by the
    // property tables; the pressure is the discriminator that matters.
    const sat = saturationAtP(P_CRITICAL);
    return finish(bulk.pressure, sat, 0, sat.u_f, sat.v_f, 0, 1, sat.v_f,
      massTotal, UTotal / massTotal, V / massTotal, 'supercritical');
  }
  if (bulk.phase === 'liquid') {
    const sat = saturationAtP(bulk.pressure);
    return finish(bulk.pressure, sat,
      massTotal, UTotal / massTotal, V / massTotal, 0, 0, sat.v_f, 0, sat.u_g, sat.v_g, 'flooded');
  }

  // ----------------------------------------------------------------
  // The partition at one pressure - closed form given the pin's u3.
  // ----------------------------------------------------------------
  interface AtP {
    sat: SaturationProps;
    m1: number; u1: number; v1: number;
    m2: number; x2Bar: number; v2: number;
    m3: number; u3: number; v3: number;
    Vsum: number;
    regime: OtsgEval['regime'];
  }
  // The pin's exact placement needs the section's own conductance (theta
  // depends on L3) and a property inversion, both too heavy for the inner
  // pressure iterations - so the OUTER loop carries the pin as an energy
  // OFFSET above saturation (du3 = u3 - u_g) and a length fraction, and
  // refreshes both against the property surface after each pressure solve.
  let du3 = 0;
  let L3 = Math.max(0, Math.min(1, 1 - (massTotal * 0.0015) / V));
  let v3Carry: number | undefined;
  const atP = (P: number): AtP => {
    const sat = saturationAtP(P);
    const u1 = subcooledSectionMean(uFeedIn, sat);
    const v1 = subcooledLiquidV(Math.max(1e4, Math.min(u1, sat.u_f)));
    // The slug ledger is a MASS, priced at the profile mean u1(P) - so a
    // falling pressure reprices the same slug COLDER and the energy
    // difference flows to the vapor side of the books by construction,
    // which is exactly the flash a depressurized slug undergoes. (The
    // energy-ledger variant could not express that: as u_f fell, the same
    // joules claimed MORE mass than the tube held, and a blowdown walked
    // it into a partition no pressure could pack.) The cap at the node's
    // inventory bites only when draws have removed slug water the ledger
    // never saw leave - which the drift watch reports.
    const m1 = Math.min(m1Ledger, massTotal);
    const mR = massTotal - m1;
    const UR = UTotal - m1 * u1;
    const vBarFull = boilingMeanVolume(sat.v_f, sat.v_g, 1);
    const x2BarFull = (vBarFull - sat.v_f) / (sat.v_g - sat.v_f);
    const u2Full = sat.u_f + x2BarFull * (sat.u_g - sat.u_f);
    if (mR <= Math.max(1e-12, UR / U3_CEILING)) {
      // The leftovers cannot carry the leftover energy below the table
      // ceiling (a sliver holding everything, or nothing holding
      // something). The truthful monotone signal is that this pressure is
      // far too low: the slug is over-priced here, and more pressure
      // reprices it hotter. Continuous with the sliver sentinel below.
      if (UR > 1e-6 * Math.max(1, UTotal)) {
        return { sat, m1, u1, v1, m2: 0, x2Bar: x2BarFull, v2: vBarFull, m3: mR, u3: U3_CEILING, v3: 1e6, Vsum: 1e6, regime: 'superheat' };
      }
      return { sat, m1, u1, v1, m2: 0, x2Bar: 0, v2: sat.v_f, m3: 0, u3: sat.u_g, v3: sat.v_g, Vsum: m1 * v1, regime: 'flooded' };
    }
    const u3 = sat.u_g + du3;
    // Superheat mass from the energy total: every kilogram promoted from
    // the full boiling profile to pinned steam costs (u3 - u2Full).
    const m3 = du3 > 1e-9 ? (UR - mR * u2Full) / (u3 - u2Full)
      : (UR - mR * u2Full) / (sat.u_g - u2Full);   // dryout pin: vapor at u_g
    if (m3 <= 0) {
      // Flooded: the mean quality is the energy's to set, and below zero it
      // is simply liquid cooler than saturation - continuous at x2Bar = 0.
      const uBar2 = UR / mR;
      const x2Bar = (uBar2 - sat.u_f) / (sat.u_g - sat.u_f);
      const v2 = x2Bar >= 0
        ? sat.v_f + x2Bar * (sat.v_g - sat.v_f)
        : subcooledLiquidV(uBar2);
      return { sat, m1, u1, v1, m2: mR, x2Bar, v2, m3: 0, u3: sat.u_g, v3: sat.v_g, Vsum: m1 * v1 + mR * v2, regime: 'flooded' };
    }
    if (m3 >= mR) {
      // More energy than wall-limited steam can hold: u3 unpins upward and
      // the leftovers are one superheated region (or the seam itself).
      const u3Free = UR / mR;
      if (u3Free > U3_CEILING) {
        // A sliver carrying energy past the steam tables. While the root
        // find is PROBING a pressure far below the root, the ledger's mass
        // claim swells (u1 falls with P) and squeezes the leftovers into
        // exactly this - and the truthful monotone answer is that such a
        // sliver would need unbounded volume: the residual says "P is far
        // too low" and the search moves on. If the SOLVED pressure lands
        // here, the volume never closes and the loud no-pressure error
        // reports it.
        return { sat, m1, u1, v1, m2: 0, x2Bar: x2BarFull, v2: vBarFull, m3: mR, u3: U3_CEILING, v3: 1e6, Vsum: 1e6, regime: 'superheat' };
      }
      const v3 = u3Free > sat.u_g + 1e3 ? superheatedV(u3Free, P, 1e-6, v3Carry) : sat.v_g;
      if (u3Free > sat.u_g + 1e3) v3Carry = v3;
      return { sat, m1, u1, v1, m2: 0, x2Bar: x2BarFull, v2: vBarFull, m3: mR, u3: u3Free, v3, Vsum: m1 * v1 + mR * v3, regime: 'superheat' };
    }
    const v3 = du3 > 1e-9 ? superheatedV(u3, P, 1e-6, v3Carry) : sat.v_g;
    if (du3 > 1e-9) v3Carry = v3;
    const m2 = mR - m3;
    return {
      sat, m1, u1, v1, m2, x2Bar: x2BarFull, v2: vBarFull, m3, u3, v3,
      Vsum: m1 * v1 + m2 * vBarFull + m3 * v3,
      regime: du3 > 1e-9 ? 'superheat' : 'dryout',
    };
  };

  // ----------------------------------------------------------------
  // Pressure from the volume constraint: safeguarded root find on ln P,
  // warm-started from the node's last published pressure. V(P) falls with
  // P (every section shrinks), so the bracket is clean.
  // ----------------------------------------------------------------
  const solveP = (): { P: number; fin: AtP } | 'supercritical' | null => {
    // The Illinois loop's accepting exit collapses the bracket onto its last
    // probe (a = b = lnM below), so the closing atP(exp(lnP)) re-evaluated
    // the exact pressure resid had just evaluated - one full partition
    // evaluation per solve, measured at 14.8% of ALL atP calls in a running
    // Xe-100, spent recomputing a result already in hand. Remember the last
    // probe and hand it back when the final lnP IS that probe. Within one
    // solveP call du3 and L3 are fixed, so lnP alone is the key. This is not
    // merely as good as recomputing, it is more consistent: the reused
    // evaluation is the one the accepted residual was computed FROM, where a
    // recompute answered with a v3 shifted by superheatedV's own tolerance
    // (its v3Carry hint having been updated by the probe itself).
    let lnLast = NaN;
    let atPLast: AtP | null = null;
    const resid = (lnP: number) => {
      const r = atP(Math.exp(lnP));
      lnLast = lnP;
      atPLast = r;
      return r.Vsum - V;
    };
    // Bracket by expanding OUTWARD from a physical starting point - the
    // node's last published pressure, or failing that the uniform-EOS read
    // (biased low, but the same order as the root). Probing the global
    // [triple point, near-critical] ends instead walks the partition through
    // corners no boiler is near: at 700 Pa the profile mean collapses and
    // the ledger claim goes degenerate, and at 215 bar a mid-pressure
    // vapor state lands in the near-critical property hole.
    let PSeed = PStart;
    if (!(PSeed && PSeed > P_MIN && PSeed < 0.998 * P_CRITICAL)) {
      PSeed = Math.min(0.997 * P_CRITICAL, Math.max(P_MIN * 1.001, bulk.pressure));
    }
    let a = Math.log(PSeed), ra = resid(a);
    let b = a, rb = ra;
    // The cap sits just under the critical point: a tube being packed full
    // legitimately runs its pressure through the 215-220 bar band (that is
    // what lifts its relief valves), and cutting the walk at the reference
    // closure's conservative 215 misread a 217-bar overfill as
    // supercritical.
    const lnMin = Math.log(P_MIN), lnMax = Math.log(0.998 * P_CRITICAL);
    // Steps grow geometrically from 2%: a seed already at the root flips the
    // sign within a step or two and the search never strays toward the
    // brackets' far corners (a near-critical overshoot from a converged seed
    // was landing probes in the v4 grid's near-critical hole).
    let step = 0.02;
    if (ra > 0) {
      // Volume too big: pressure must rise. Walk b up until the sign flips.
      for (let i = 0; i < 60 && rb > 0; i++) {
        if (b >= lnMax) return 'supercritical';   // even ~215 bar cannot pack it
        a = b; ra = rb;
        b = Math.min(lnMax, b + step);
        step = Math.min(0.5, step * 2);
        rb = resid(b);
      }
      if (rb > 0) return 'supercritical';
    } else {
      // Volume too small: pressure must fall. Walk a down until it flips.
      for (let i = 0; i < 60 && ra < 0; i++) {
        if (a <= lnMin) return null;              // emptier than the triple point allows
        b = a; rb = ra;
        a = Math.max(lnMin, a - step);
        step = Math.min(0.5, step * 2);
        ra = resid(a);
      }
      if (ra < 0) return null;
    }
    // Tolerances are a coherent stack: the vapor inversions inside the
    // residual run at 1e-6 (cheap with a good hint), so the volume residual
    // is trustworthy to ~1e-5 V and pressure to ~2e-6 in ln P (~0.03 bar) -
    // and the exits sit exactly there. Demanding more than the residual's
    // own noise floor (the original 1e-10) made secant chatter and burn 50+
    // property probes per solve on precision nothing downstream can see.
    // Secant leads and bisection only rescues it: the residual is smooth at
    // this scale and secant lands in 4-8 iterations.
    const rExit = 1e-5 * V;
    let side = 0;
    for (let i = 0; i < 48; i++) {
      if (b - a < 2e-6) break;
      const denom = rb - ra;
      let lnM = Math.abs(denom) > 0 ? a - ra * (b - a) / denom : 0.5 * (a + b);
      if (!(lnM > a && lnM < b)) lnM = 0.5 * (a + b);
      const rM = resid(lnM);
      // Illinois anti-stall, as in superheatedV: see the comment there.
      if (rM > 0) {
        a = lnM; ra = rM;
        if (side === 1) rb *= 0.5;
        side = 1;
      } else {
        b = lnM; rb = rM;
        if (side === -1) ra *= 0.5;
        side = -1;
      }
      if (Math.abs(rM) < rExit) { a = lnM; b = lnM; break; }
    }
    const lnP = 0.5 * (a + b);
    const fin = lnP === lnLast && atPLast ? atPLast : atP(Math.exp(lnP));
    return { P: Math.exp(lnP), fin };
  };

  // Outer pin refinement: refresh (du3, L3) against the property surface at
  // the solved pressure, and re-solve until both are consistent. theta is a
  // mild function of L3 and du3 shifts the volume only through v3, so this
  // settles in a couple of rounds.
  let result: { P: number; fin: AtP } | null = null;
  let lastT3target = -1;
  for (let outer = 0; outer < 5; outer++) {
    const solved = solveP();
    if (solved === 'supercritical') {
      // The walk topped out just under the critical point - yet the bulk
      // state reads sub-critical two-phase (the one-fluid cases were
      // dispatched before the walk). No configuration of these books is
      // water: the ledger claims a slug the tube's totals cannot host at
      // ANY pressure under the dome's top. Say so.
      throw new Error(`[OTSG] the partition needs more than ${(0.998 * P_CRITICAL / 1e5).toFixed(0)} bar ` +
        `to pack while the totals read two-phase at ${(bulk.pressure / 1e5).toFixed(1)} bar: ` +
        `${massTotal.toFixed(1)} kg carrying ${(UTotal / massTotal / 1e3).toFixed(0)} kJ/kg in ` +
        `${V.toFixed(2)} m3 with an economizer claim of ${m1Ledger.toFixed(0)} kg. ` +
        `The ledger and the node's totals disagree about what is in the tube.`);
    }
    if (solved === null) {
      throw new Error(`[OTSG] no pressure above the triple point packs this inventory into ` +
        `the tube: ${massTotal.toFixed(1)} kg carrying ${(UTotal / massTotal / 1e3).toFixed(0)} kJ/kg ` +
        `in ${V.toFixed(2)} m3 (economizer claim ${m1Ledger.toFixed(0)} kg). ` +
        `The tube is emptier than saturated steam at vacuum.`);
    }
    result = solved;
    const { P, fin } = solved;
    // Refresh the pin at the solved pressure.
    const L3New = Math.max(0, Math.min(1, (fin.m3 * fin.v3) / V));
    const hA3 = pin.hA3Full * L3New;
    const thetaMean = hA3 > 0 ? hA3 / (2 * pin.WCp3 + hA3) : 0;
    const T3target = fin.sat.T + thetaMean * Math.max(0, pin.TWall3 - fin.sat.T);
    let du3New = 0;
    if (T3target > fin.sat.T + 0.1) {
      // The inversion costs ~a hundred property calls; when the target has
      // moved less than the pin's own fidelity since the last round, the
      // carried offset is already the answer.
      if (result && Math.abs(T3target - lastT3target) < 0.25 && du3 > 0) {
        du3New = du3;
      } else {
        const u3Pin = u3AtTemperature(T3target, P, fin.sat, probe,
          fin.u3 > fin.sat.u_g ? fin.u3 : fin.sat.u_g + 2500 * (T3target - fin.sat.T), pin.TWall3);
        du3New = u3Pin - fin.sat.u_g;
      }
    }
    lastT3target = T3target;
    const settled = Math.abs(du3New - du3) < 2e3 && Math.abs(L3New - L3) < 1e-3;
    du3 = du3New;
    L3 = L3New;
    if (settled) break;
  }
  const { P, fin } = result!;
  // Volume is the HARD constraint: the linear branches close it exactly by
  // construction, and the vapor branch closes it here - superheatedV's loose
  // tolerance (1e-4 in ln v, a speed choice) otherwise leaves its slack in
  // the section volumes, where the fits-the-tube invariant lives. Moving the
  // slack onto v3 puts it in pressure-consistency noise instead, where the
  // root-finder already owns it.
  let v3 = fin.v3;
  if (fin.m3 > 1e-12) {
    v3 = (V - fin.m1 * fin.v1 - fin.m2 * fin.v2) / fin.m3;
  }
  return finish(P, fin.sat, fin.m1, fin.u1, fin.v1, fin.m2, fin.x2Bar, fin.v2,
    fin.m3, fin.u3, v3, fin.regime);
}

/**
 * Superheated state at (P, T) - the (u, v) pair on the P-isobar whose
 * temperature is T. Used by the wall pin and by design-point initialization
 * (a preset that says "the superheater runs saturation -> 565 C" needs the
 * mean state of that span to seed the node's totals).
 */
export function superheatedStateAtPT(P: number, T: number): { u: number; v: number } {
  const sat = saturationAtP(P);
  if (!(T > sat.T)) {
    return { u: sat.u_g, v: sat.v_g };
  }
  const probe = (u: number, v: number) => calculateState(1, u, v);
  const u = u3AtTemperature(T, P, sat,
    (uu, vv) => probe(uu, vv), sat.u_g + 2500 * (T - sat.T), T);
  return { u, v: superheatedV(u, P, 1e-4) };
}

/** Invert the section temperature to u3 along the P-isobar - bisection with
 *  one final interpolation so the pin varies smoothly with its target. */
function u3AtTemperature(
  Tt: number, P: number, sat: SaturationProps,
  probe: (u: number, v: number, what: string) => { temperature: number },
  uGuess: number, TWall3: number,
): number {
  let vT: number | undefined;
  const TOf = (u: number) => {
    const v = superheatedV(u, P, 1e-4, vT);
    vT = v;
    return probe(u, v, 'pinned steam state').temperature;
  };
  let uLo = sat.u_g, TLo = sat.T;
  let uHi = Math.max(uGuess, sat.u_g + 10e3);
  let THi = TOf(uHi);
  while (THi < Tt && uHi < U3_CEILING) {
    uLo = uHi; TLo = THi;
    uHi = Math.min(U3_CEILING, uHi + 2 * (uHi - sat.u_g));
    THi = TOf(uHi);
  }
  if (THi < Tt) {
    throw new Error(`[OTSG] the wall pin asks for steam at ${(Tt - 273.15).toFixed(0)} C ` +
      `and ${(P / 1e5).toFixed(1)} bar, past the ${(U3_CEILING / 1e6).toFixed(1)} MJ/kg ` +
      `where the steam tables end. The wall temperature driving it ` +
      `(${(TWall3 - 273.15).toFixed(0)} C) is not one a boiler tube survives.`);
  }
  for (let i = 0; i < 20; i++) {
    if (uHi - uLo < 5e3) break;
    const um = 0.5 * (uLo + uHi);
    const Tm = TOf(um);
    if (Tm < Tt) { uLo = um; TLo = Tm; } else { uHi = um; THi = Tm; }
  }
  return THi > TLo ? uLo + (uHi - uLo) * (Tt - TLo) / (THi - TLo) : uLo;
}

/** Invert specific energy to temperature along the saturated-liquid line. */
export function tempOfSubcooledU(u: number): number {
  let Tlo = 274, Thi = 647.09;   // to the dome top - see subcooledLiquidV
  if (u <= saturatedLiquidEnergy(Tlo)) return Tlo;
  for (let i = 0; i < 60; i++) {
    const Tm = 0.5 * (Tlo + Thi);
    if (saturatedLiquidEnergy(Tm) < u) Tlo = Tm; else Thi = Tm;
    if (Thi - Tlo < 1e-4) break;
  }
  return 0.5 * (Tlo + Thi);
}

// ---------------------------------------------------------------------------
// Interface fluxes and section rates
// ---------------------------------------------------------------------------

export interface OtsgRates {
  dm1: number;  // kg/s
  dm2: number;
  dm3: number;
  dU1: number;  // W  - subcooled section energy (the runtime closure's state)
  dU3: number;  // W
  W12: number;  // kg/s crossing at h_f (positive = 1 -> 2)
  W23: number;  // kg/s crossing at h_g (positive = 2 -> 3)
}

/**
 * Section rates from the energy balances with the profile closures held.
 * Each balance is d(m h-bar - m P v-bar)/dt = W_in h_in - W_out h_out + Q -
 * P dV/dt; with v-bar constant per evaluation the P dV folds into using the
 * section MEAN enthalpy h-bar on the storage side, giving
 *
 *   W12 = (Q1 - W_in (hBar1 - h_in)) / (h_f - hBar1)
 *   W23 = (Q2 - W12 (hBar2 - h_f)) / (h_g - hBar2)
 *
 * with hBar taken from the EVALUATED section means (not the idealized
 * midpoint) so the total energy balance closes exactly - the test checks it
 * to 1e-9. Both fluxes reduce to W at steady state and go NEGATIVE when the
 * physics says the boundary recedes: cold feed with no heat pushes the
 * saturation boundary upward, mass converting 2 -> 1 at h_f.
 *
 * @param Q1,Q2,Q3  heat INTO each section from the wall (W)
 * @param WIn       feed mass flow into section 1 (kg/s)
 * @param hIn       feed specific enthalpy (J/kg)
 * @param WOut      steam draw out of section 3 (kg/s)
 */
export function otsgRates(
  ev: OtsgEval,
  WIn: number,
  hIn: number,
  WOut: number,
  Q1: number,
  Q2: number,
  Q3: number,
): OtsgRates {
  const { sat } = ev;
  const hBar1 = ev.sections[0].hBar;
  const hBar2 = ev.sections[1].hBar;

  const d1 = sat.h_f - hBar1;
  if (d1 <= 1e3) {
    throw new Error(`[OTSG] subcooled section mean enthalpy ${(hBar1 / 1e3).toFixed(0)} kJ/kg ` +
      `is at or above saturated liquid (${(sat.h_f / 1e3).toFixed(0)} kJ/kg at ` +
      `${(ev.P / 1e5).toFixed(1)} bar). A subcooled section cannot exist with ` +
      `near-saturated feed - this needs the feed rerouted to the two-phase ` +
      `section, which the model does not do yet.`);
  }
  const d2 = sat.h_g - hBar2;

  const W12 = (Q1 - WIn * (hBar1 - hIn)) / d1;
  const W23 = (Q2 - W12 * (hBar2 - sat.h_f)) / d2;

  // Subcooled section: the ordinary open-system balance. Feed enters at its
  // own enthalpy, mass leaves across the boundary at h_f, the wall adds Q1,
  // and the moving boundary does P dV work. This is the runtime closure's
  // integrated state - every joule it reports came in through one of these
  // three terms, so the leftovers cannot inherit energy the wall never
  // delivered. (Its MASS follows: m1 = U1/u1Bar - see evaluateOtsgAtP.)
  const dm1 = WIn - W12;
  const dU1 = WIn * hIn - W12 * sat.h_f + Q1 - ev.P * (dm1 * ev.sections[0].vBar);

  // Superheat section: free energy state, ordinary open-system balance.
  // Outflow leaves at the section's own enthalpy (or its h_g nascent state
  // when empty - ev.hSteamOut blends the two).
  const dm3 = W23 - WOut;
  const dU3 = W23 * sat.h_g - WOut * ev.hSteamOut + Q3
    - ev.P * (dm3 * ev.sections[2].vBar);

  return {
    dm1,
    dm2: W12 - W23,
    dm3,
    dU1,
    dU3,
    W12,
    W23,
  };
}

// ---------------------------------------------------------------------------
// Heat-transfer helpers: transit + standing branches, counterflow gas march
// ---------------------------------------------------------------------------

/**
 * Does this section's wall hold ONE temperature along its length, or does it
 * ramp with the stream?
 *
 * A boiling section's wall really is isothermal: the water under it is at
 * T_sat from end to end and its film coefficient is enormous, so the wall
 * cannot depart far from T_sat anywhere. A stream flowing under it approaches
 * that fixed wall exponentially - eps = 1 - e^(-NTU) is exact.
 *
 * An economizer or superheater in COUNTERFLOW is the opposite. Its wall runs
 * from near the feed temperature at the cold end to near saturation at the
 * hot end, tracking both streams, so the local driving difference is roughly
 * uniform and the right integral is hA times the difference of the two MEANS.
 * Solving that against the stream's own mean (T_bar = T_in + Q/2mcp) gives
 *
 *     Q = hA (T_wall_mean - T_in) / (1 + NTU/2) = mcp (T_wall - T_in) * theta
 *     theta = 2 NTU / (2 + NTU)
 *
 * which is the small-area limit hA*dT at NTU -> 0, exactly like the
 * exponential form, but tends to 2 rather than 1 as the area grows: the
 * stream's MEAN reaches the section-average wall, so its OUTLET passes it.
 * That is not a licence to exceed the heat source - two of these back to back
 * (gas -> wall, wall -> water) compose to
 *
 *     Q = (T_gas_in - T_water_in) / (1/hA_g + 1/hA_w + 1/2C_g + 1/2C_w)
 *
 * the standard counterflow result with the wall as a series resistance, which
 * is bounded by the capacity rates. The exponential form cannot express this:
 * with one wall temperature per section it caps the water's outlet at the
 * section-AVERAGE wall, so a counterflow economizer whose average wall sits
 * below saturation can never bring its water to h_f - its boundary then has
 * no length that ends it, and it grows until it owns the whole node. That is
 * exactly what the Xe-100 bundle did (section-1 wall 184 K below T_sat, Q1
 * stuck at 0.36 of the duty that would hold the boundary still).
 */
export type WallProfile = 'isothermal' | 'ramping';

/**
 * Fraction of a stream's carrying capacity that a passage actually uses:
 * Q = theta(NTU) * mcp * (T_wall - T_in). See WallProfile for the derivation.
 */
export function streamApproach(NTU: number, wall: WallProfile): number {
  if (!(NTU > 0)) return 0;
  return wall === 'isothermal' ? 1 - Math.exp(-NTU) : 2 * NTU / (2 + NTU);
}

/**
 * Wall-to-stream heat rate as two parallel branches (design doc section 5):
 *
 *   Q = theta * mcp * (T_wall - T_in)     transit branch
 *     + hA_nat * (T_wall - T_bulk)        standing branch
 *
 * The transit branch's conductance theta*mcp is identically hA times an
 * approach factor - the "theta blend" and this parallel form are the same
 * algebra - and it is bounded by the stream's carrying capacity by
 * construction. The standing branch never turns off, so a bottled boiler
 * still heats. Dominance follows from mcp vs hA_nat; there is no
 * interpolation function anywhere.
 */
export function transitStandingQ(
  hAForced: number,   // W/K - forced-convection conductance of the passage
  hANat: number,      // W/K - natural-convection conductance to the bulk
  mcp: number,        // W/K - stream carrying capacity (mdot * cp), >= 0
  TIn: number,        // K - stream inlet temperature
  TBulk: number,      // K - standing inventory temperature
  TWall: number,      // K
  wall: WallProfile = 'isothermal',
): number {
  const transit = mcp > 0
    ? streamApproach(hAForced / mcp, wall) * mcp * (TWall - TIn)
    : 0;
  return transit + hANat * (TWall - TBulk);
}

export interface GasMarchSection {
  hA: number;      // W/K - gas-side conductance of this section
  TWall: number;   // K   - wall temperature this section's gas sees
  /** Isothermal under a boiling section, ramping under an economizer or a
   *  superheater - see WallProfile. Defaults to isothermal. */
  wall?: WallProfile;
}

/**
 * March a quasi-steady gas stream through sections in ITS flow order (for
 * counterflow, that is superheater first). Each section approaches its wall
 * by that wall's own profile (see WallProfile); the outlet of one is the
 * inlet of the next. Returns heat given up TO each wall (positive = gas heats
 * wall) and the final gas outlet temperature. Zero-area sections pass through
 * untouched - the empty-section limit costs nothing.
 */
export function marchCounterflowGas(
  TGasIn: number,
  mcpGas: number,
  sections: GasMarchSection[],
): { Q: number[]; TGasOut: number } {
  const Q: number[] = [];
  let T = TGasIn;
  for (const s of sections) {
    if (mcpGas <= 0 || s.hA <= 0) { Q.push(0); continue; }
    const q = streamApproach(s.hA / mcpGas, s.wall ?? 'isothermal') * mcpGas * (T - s.TWall);
    Q.push(q);
    T = T - q / mcpGas;
  }
  return { Q, TGasOut: T };
}
