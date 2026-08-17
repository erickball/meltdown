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
 * The RUNTIME closure (evaluateOtsgAtP) is the one the plant uses: the node's
 * ordinary (mass, energy) totals and its (u,v) pressure stay where they are,
 * ONE descriptor is integrated - the subcooled section's energy U1 - and the
 * boiling/superheat split is SOLVED from the totals and the tube volume. See
 * that function for why m3 cannot be integrated too, and why the subcooled
 * section is carried as an energy rather than a mass. Everything else is
 * DERIVED here:
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
} from './water-properties';

// ---------------------------------------------------------------------------
// Saturation bundle
// ---------------------------------------------------------------------------

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
  // Secant on T over the saturated-liquid energy curve
  let Tlo = 274, Thi = 645;
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
export function superheatedV(u: number, P: number): number {
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
  let pLo = pOf(lnLo), pHi = pOf(lnHi);
  if (!(pLo >= P * (1 - 1e-6) && pHi <= P)) {
    throw new Error(`[OTSG] superheatedV: P=${(P / 1e5).toFixed(2)} bar not bracketed at ` +
      `u=${(u / 1e3).toFixed(0)} kJ/kg (P(${Math.exp(lnLo).toExponential(1)})=${(pLo / 1e5).toFixed(2)}, ` +
      `P(${Math.exp(lnHi).toExponential(1)})=${(pHi / 1e5).toFixed(2)} bar). ` +
      `The superheat section state is outside the vapor region.`);
  }
  for (let i = 0; i < 80; i++) {
    const lnM = 0.5 * (lnLo + lnHi);
    if (pOf(lnM) > P) lnLo = lnM; else lnHi = lnM;
    if (lnHi - lnLo < 1e-10) break;
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
 * Sectioned evaluation AT a given pressure, with the PARTITION SOLVED from
 * the node's own conserved totals - mass, energy and the tube volume - rather
 * than integrated alongside them.
 *
 * This is the runtime form: the ordinary (u,v) machinery owns the node's
 * pressure dynamics (proven robust), and the sections are the fine structure
 * that machinery lumps together, recovered here at that pressure for heat
 * transfer, draw enthalpy and partition motion.
 *
 * WHY THE SUPERHEAT MASS IS NOT INTEGRATED. The tube side carries four
 * descriptors - the subcooled section, the boiling section's outlet quality,
 * m3 and u3 - against three totals, so integrating the superheat section as
 * well as the subcooled one over-specifies the model by one. That is not a
 * tidiness complaint: an m3 accumulated from the interface fluxes has no idea
 * what volume it is being asked to fit into, and the Xe-100 bundle duly
 * reached partitions whose sections claimed 2.6x the tube volume while the
 * reported lengths still looked plausible (they normalize over the sections'
 * OWN summed volume).
 *
 * The ONE dynamic descriptor left is the subcooled section, and it is its
 * ENERGY U1 that is integrated - see below for why the energy and not the
 * mass. Its boundary is set by the feed's history, not by the totals.
 *
 * THE CLOSURE. Take out the subcooled section (m1 = U1/u1Bar at its profile
 * mean) and
 * what is left - m_rest, V_rest, U_rest - is shared between a boiling section
 * and a superheat section under one structural rule: a boiling section only
 * stops short of dry steam when there is nothing downstream to hand it to.
 * In (u,v) space at this pressure the boiling section is a point on the dome
 * chord and the superheat section a point on the vapor isobar, and the rest
 * has to be their mass-weighted mixture. Three cases, and they join
 * continuously:
 *
 *   (A) v_rest <= v-bar(1)  - flooded. No dry steam anywhere: m3 = 0 and the
 *       boiling section's OUTLET QUALITY takes whatever value makes the
 *       volume close. Near-saturated water packed into the tubes comes back
 *       at ~1% quality, not the 37% a profile average insists on.
 *   (T) enough volume for dry steam but not enough energy to superheat it:
 *       the boiling section reaches x = 1 and hands over to a saturated-VAPOR
 *       region, u3 = u_g, whose mass closes the volume. This is dryout, and
 *       it is where a two-phase bulk lands exactly: a homogeneous mixture
 *       decomposes into (boiling section + saturated vapor) with the same
 *       mass split whether you ask volume or energy, because both parts sit
 *       on the same chord.
 *   (B) beyond that - genuine superheat: m3 and u3 solve the volume AND the
 *       energy together, with the section's own (u3, v3) required to evaluate
 *       at P. One bisection on m3; u3 and v3 follow from the two constraints,
 *       so each iterate costs a single property evaluation.
 *
 * Case A gives up the energy constraint (one descriptor, two totals) and case
 * T gives it up as well; both are regimes where the leftover energy has
 * nowhere to sit but the wall. Case B satisfies everything. The regime
 * boundaries are exactly the states where the two descriptions coincide, so
 * nothing steps as a bundle floods or dries out.
 */
export function evaluateOtsgAtP(
  U1: number,
  massTotal: number,
  UTotal: number,
  P: number,
  uFeedIn: number,
  geom: OtsgGeometry,
): OtsgEval {
  if (!Number.isFinite(U1)) {
    throw new Error(`[OTSG] subcooled section energy is not a number: U1=${U1} J`);
  }
  const sat = saturationAtP(P);
  const u1Bar = subcooledSectionMean(uFeedIn, sat);
  // The economizer's MASS follows from the energy it holds. Both descriptions
  // carry the same information under the profile closure - m1 = U1/u1Bar -
  // but which one is integrated decides where the slack goes when u1Bar moves
  // (a pressure transient moves it every step). Integrating the mass makes
  // the section's ENERGY jump with u1Bar, and since the leftovers are a
  // residual, that jump lands on the vapour's temperature, which nothing
  // bounds. Integrating the energy instead makes its MASS jump, and mass
  // lands in m2/m3 - which the closure re-solves anyway, against the tube
  // volume. The slack has to go somewhere; this puts it in the bounded
  // descriptor rather than the unbounded one.
  //
  // The section cannot hold more water than the node has. When that bites,
  // the leftovers are empty and the energy above what m1 can carry is the
  // part with nowhere to sit - the same slack case A and T already have.
  const m1 = Math.min(Math.max(0, U1) / u1Bar, Math.max(0, massTotal));
  const v1 = m1 > 0 ? subcooledLiquidV(u1Bar) : sat.v_f;

  // What the boiling and superheat sections have to account for between them
  const mR = massTotal - m1;
  const VRest = geom.tubeVolume - m1 * v1;
  const URest = UTotal - m1 * u1Bar;

  // The boiling section as it runs whenever there IS something downstream:
  // quality 0 -> 1, mass-averaged over its linear profile (boilingMeanQuality)
  const vBarFull = boilingMeanVolume(sat.v_f, sat.v_g, 1);
  const x2Full = (vBarFull - sat.v_f) / (sat.v_g - sat.v_f);
  const u2Full = sat.u_f + x2Full * (sat.u_g - sat.u_f);

  let x2Out = 1;            // boiling section's outlet quality
  let m3 = 0;               // kg  - superheat (or dry saturated vapor) section
  let u3 = sat.u_g;         // J/kg
  let v3 = sat.v_g;         // m3/kg

  if (mR > 0 && P >= P_CRITICAL) {
    // SUPERCRITICAL: there is no dome, so there is nothing to boil and no
    // second phase to hold anything. The tube is one fluid, and the split the
    // rest of this function makes has no meaning - the leftovers ARE the hot
    // section, at their own (u, v). Section 1 survives as the cold END of
    // that fluid (its boundary is now the pseudo-critical point, which is
    // what sat carries above P_crit), so nothing steps as a boiler is pushed
    // through the critical pressure and back.
    m3 = mR;
    u3 = URest / mR;
    v3 = VRest / mR;
  } else if (mR > 0) {
    const vRest = VRest / mR;
    if (vRest <= vBarFull) {
      // (A) Flooded: no room for dry steam, so the boiling section is the top
      // of the tube and ends wherever the volume says it does.
      x2Out = boilingOutletQuality(sat.v_f, sat.v_g, vRest);
    } else {
      // Energy the rest carries above an all-boiling description of itself.
      // Every kilogram promoted out of the boiling section into dry vapor
      // costs (u_g - u2Full), so E fixes how much vapor the energy can pay
      // for; the volume fixes how much the tube has room for.
      const E = URest - mR * u2Full;
      const m3Sat = Math.min(mR, Math.max(0, E / (sat.u_g - u2Full)));
      const m3Vol = (VRest - mR * vBarFull) / (sat.v_g - vBarFull);
      // Every way of failing to describe the leftovers is the same failure:
      // this (mass, energy, volume) triple is not water at this pressure. The
      // runtime cannot ask for one - it passes the node's OWN pressure, which
      // is a function of these very totals - so this is the backstop, and it
      // says what it saw rather than inventing a section.
      const unrepresentable = (why: string) => new Error(
        `[OTSG] the node's leftovers cannot be a boiling section plus dry steam at ` +
        `${(P / 1e5).toFixed(2)} bar: ${mR.toFixed(1)} kg carrying ` +
        `${(URest / mR / 1e3).toFixed(0)} kJ/kg in ${VRest.toFixed(3)} m3 ` +
        `(v=${(VRest / mR).toFixed(4)} m3/kg, needing ${m3Vol.toFixed(1)} kg of vapor to fill it). ` +
        `${why} The node's totals and its pressure disagree about what phase it is in.`);
      if (m3Vol <= m3Sat) {
        // (T) Dryout: the volume fills before the energy runs out, so the
        // vapor region sits at saturation and its mass is the volume's to set.
        // m3Vol <= m3Sat <= m_rest, so section 2 keeps a non-negative mass and
        // the leftover energy is the part with nowhere to sit.
        m3 = m3Vol;
      } else if (!(E > 0)) {
        // No energy for dry steam at all, yet the volume demands some: the
        // rest is at once more voluminous than a boiling section and colder
        // than one.
        throw unrepresentable(`It carries less than the ${(u2Full / 1e3).toFixed(0)} kJ/kg a ` +
          `boiling section alone would hold, so no vapor region can be paid for.`);
      } else {
        // (B) Superheat. Solve for m3 with BOTH constraints imposed:
        //   energy:  u3 = u2Full + E/m3
        //   volume:  v3 = (V_rest - (m_rest - m3) v-bar(1)) / m3
        // and require that state to evaluate at P. One property call per
        // iterate - the section's own (u3, v3) is already pinned by the two
        // constraints, so nothing has to be inverted along the isobar.
        //
        // WHICH ROOT. Coming down from the dryout end, less superheat mass
        // means a hotter, thinner section, and the pressure that pair implies
        // first rises above P and then - once the section is hot enough that
        // its volume outruns its energy - falls back through P again. That
        // far crossing is a sliver of 1500 C steam sitting on top of boiling
        // water: arithmetically a solution, physically not the state a bundle
        // is ever in, and not continuous with the dryout case next door. So
        // walk DOWN from m3Sat and take the first bracket found.
        const residual = (mm: number) => {
          const uu = u2Full + E / mm;
          const vv = (VRest - (mR - mm) * vBarFull) / mm;
          return calculateState(1, uu, vv).pressure - P;
        };
        // Property-surface noise scale: at the dryout join and in the
        // all-superheat case the root sits exactly ON m3Sat, where the
        // residual is a difference of two evaluations of the same state.
        const rTol = 1e-6 * P;
        let hi = m3Sat, rHi = residual(hi);
        if (rHi >= -rTol) {
          // The upper end IS the answer: either the whole rest is superheated
          // (m3Sat = m_rest, nothing left to boil) or it sits on the dryout
          // boundary. Both are the edge of the feasible set, not a cap on
          // anything conserved.
          m3 = m3Sat;
        } else {
          const m3Floor = E / (U3_CEILING - u2Full);
          let lo = hi, rLo = rHi;
          while (rLo < 0 && lo > m3Floor) {
            hi = lo;
            lo = Math.max(m3Floor, 0.5 * lo);
            rLo = residual(lo);
          }
          if (!(rLo > 0)) {
            throw unrepresentable(`Filling it would need vapor beyond ` +
              `${(U3_CEILING / 1e6).toFixed(1)} MJ/kg, which still lands at ` +
              `${((rLo + P) / 1e5).toFixed(2)} bar.`);
          }
          for (let i = 0; i < 60; i++) {
            const mid = 0.5 * (lo + hi);
            if (residual(mid) > 0) lo = mid; else hi = mid;
            if (hi - lo < 1e-12 * m3Sat) break;
          }
          m3 = 0.5 * (lo + hi);
        }
        u3 = u2Full + E / m3;
        v3 = (VRest - (mR - m3) * vBarFull) / m3;
      }
    }
  }

  // One mean quality sets the boiling section's volume, energy and enthalpy
  // together, so they cannot disagree with each other.
  const x2Bar = boilingMeanQuality(sat.v_f, sat.v_g, x2Out);
  const v2 = sat.v_f + x2Bar * (sat.v_g - sat.v_f);
  const m2 = mR - m3;

  const h1Bar = u1Bar + P * v1;
  const h2Bar = sat.h_f + x2Bar * (sat.h_g - sat.h_f);
  const h3Bar = u3 + P * v3;

  const T1 = m1 > 0 ? tempOfSubcooledU(u1Bar) : sat.T;
  // A dry-saturated vapor region (case T) is at T_sat by definition; a
  // genuinely superheated one - and any supercritical fluid, which has no
  // saturation temperature to fall back on - needs the property surface.
  const T3 = m3 > 0 && (u3 > sat.u_g || P >= P_CRITICAL)
    ? calculateState(1, u3, v3).temperature
    : sat.T;

  const V1 = m1 * v1, V2 = m2 * v2, V3 = m3 * v3;
  const VT = Math.max(1e-12, V1 + V2 + V3);
  const mk = (mass: number, vBar: number, V: number, hBar: number, T: number): OtsgSectionEval => ({
    mass, vBar, volume: V,
    lengthFrac: V / VT,
    area: geom.heatArea * (V / VT),
    hBar, T,
  });

  // No blend needed on the draw enthalpy any more: a vanishing superheat
  // section now vanishes through saturation (case T), where h3Bar IS h_g, so
  // the draw is continuous by construction rather than by smoothing.
  const hSteamOut = m3 > 0 ? h3Bar : sat.h_g;

  return {
    P, sat,
    sections: [
      mk(m1, v1, V1, h1Bar, T1),
      mk(m2, v2, V2, h2Bar, sat.T),
      mk(m3, v3, V3, h3Bar, T3),
    ],
    hSteamOut,
    u3,
    x2Out,
  };
}

/** Invert specific energy to temperature along the saturated-liquid line. */
export function tempOfSubcooledU(u: number): number {
  let Tlo = 274, Thi = 645;
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
 * Wall-to-stream heat rate as two parallel branches (design doc section 5):
 *
 *   Q = eps * mcp * (T_wall - T_in)      transit branch, eps = 1 - e^(-NTU)
 *     + hA_nat * (T_wall - T_bulk)       standing branch
 *
 * The transit branch's conductance eps*mcp is identically hA*theta(NTU) -
 * the "theta blend" and this parallel form are the same algebra - and it is
 * capped at the stream's carrying capacity mcp by construction. The standing
 * branch never turns off, so a bottled boiler still heats. Dominance follows
 * from mcp vs hA_nat; there is no interpolation function anywhere.
 */
export function transitStandingQ(
  hAForced: number,   // W/K - forced-convection conductance of the passage
  hANat: number,      // W/K - natural-convection conductance to the bulk
  mcp: number,        // W/K - stream carrying capacity (mdot * cp), >= 0
  TIn: number,        // K - stream inlet temperature
  TBulk: number,      // K - standing inventory temperature
  TWall: number,      // K
): number {
  const transit = mcp > 0
    ? (1 - Math.exp(-hAForced / mcp)) * mcp * (TWall - TIn)
    : 0;
  return transit + hANat * (TWall - TBulk);
}

export interface GasMarchSection {
  hA: number;      // W/K - gas-side conductance of this section
  TWall: number;   // K   - wall temperature this section's gas sees
}

/**
 * March a quasi-steady gas stream through sections in ITS flow order (for
 * counterflow, that is superheater first). Each section is an exponential
 * approach to its wall temperature; the outlet of one is the inlet of the
 * next. Returns heat given up TO each wall (positive = gas heats wall) and
 * the final gas outlet temperature. Zero-area sections pass through
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
    const eps = 1 - Math.exp(-s.hA / mcpGas);
    const q = eps * mcpGas * (T - s.TWall);
    Q.push(q);
    T = T - q / mcpGas;
  }
  return { Q, TGasOut: T };
}
