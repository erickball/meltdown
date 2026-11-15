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
  lastVaporPressureSlope,
  saturationTemperature,
  saturatedLiquidEnergy,
  saturatedVaporEnergy,
  saturatedLiquidDensity,
  saturatedVaporDensity,
  estimateVaporV,
} from './water-properties';
import type { OtsgAxialProfile, OtsgSteamProfile } from './types';

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
export function superheatedV(u: number, P: number, tolLn = 1e-10, vHint?: number, satIn?: SaturationProps): number {
  // Superheated vapor at pressure P always has v > v_g(P), so the saturated-
  // vapor volume is the exact lower bracket - guaranteed inside the property
  // grid's vapor region, unlike any fixed constant (a constant either strays
  // into the compressed-liquid fringe at high P or wastes bracket at low P).
  // The dominant caller (atP) has this bundle in hand already - recomputing
  // it here was 55% of ALL saturationAtP traffic.
  const satP = satIn && satIn.P === P ? satIn : saturationAtP(P);
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
    // Newton from the hint, using the property surface's OWN derivative. The
    // MLS vapor interpolation fits lnP locally as a linear model and always
    // computed its slope on the way to the value; calculateState now records
    // it (lastVaporPressureSlope), and the ideal-gas extensions' slope is
    // exactly -1. So every probe returns both a residual and the true local
    // dlnP/dlnv, and this loop is plain damped Newton where its predecessor
    // (a secant engine) had to spend probes LEARNING the slope - and its
    // predecessor's predecessor (a bracket ladder) spent them checking
    // fences. Measured: ladder 9.85 probes/call, secant 5.61, this ~2-3.
    //
    // Safeguards, in the order they matter:
    //  - a sign bracket is maintained as probes land; once both sides are
    //    seen, a Newton step outside the bracket bisects instead;
    //  - steps are capped at 0.7 in ln v, so a degenerate fitted slope
    //    (grid fringe, where the getter reports NaN and -1.1 is assumed)
    //    cannot fling an iterate across the domain;
    //  - convergence is declared when the Newton step ITSELF is smaller than
    //    tolLn - for a C1 surface that step bounds the distance to the root
    //    the same way the old bracket width did;
    //  - 12 probes without convergence falls through to the wide
    //    verified-bracket path below, which keeps the loud
    //    not-actually-vapor error exactly as it was.
    const xFloor = Math.log(vg * (1 + 1e-9));
    let a = xFloor, b = lnHi;          // sign bracket: a has r > 0, b has r < 0
    let haveA = false, haveB = false;
    let x = Math.min(Math.max(Math.log(hint), xFloor), lnHi);
    for (let i = 0; i < 12; i++) {
      const r = Math.log(pOf(x) / P);
      if (r === 0) return Math.exp(x);
      let s = lastVaporPressureSlope();
      if (!(s < 0)) s = -1.1;          // no vapor-path slope: assumed value
      if (r > 0) { a = x; haveA = true; } else { b = x; haveB = true; }
      const dxNewton = -r / s;
      if (Math.abs(dxNewton) < tolLn) {
        const xr = Math.min(Math.max(x + dxNewton, xFloor), lnHi);
        return Math.exp(xr);
      }
      x += Math.min(0.7, Math.max(-0.7, dxNewton));
      if (haveA && haveB && !(x > a && x < b)) x = 0.5 * (a + b);
      else if (x < xFloor) x = xFloor;
      else if (x > lnHi) x = lnHi;
    }
    // No convergence: fall through to the wide verified-bracket path.
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
  if (pLo <= P) {
    // Inside the sign-tolerance band the bracket check admits (pLo within
    // 1e-6 of P from below): the residual is non-positive over the whole
    // bracket, so bisection converged onto lnLo - which is v_g. Say so
    // directly instead of spending 22 probes walking there.
    return Math.exp(lnLo);
  }
  // Verified bracket: Illinois false position instead of pure bisection.
  // ln P is near-affine in ln v across the vapor region, so false position
  // lands in a handful of probes where bisection paid log2(span/tol) - about
  // 22 at the default tolerance over this five-decade bracket (measured 23-30
  // probes per hintless call, a quarter of ALL property queries).
  let wa = lnLo, wra = pLo - P;
  let wb = lnHi, wrb = pHi - P;
  let wside = 0;
  for (let i = 0; i < 80; i++) {
    if (wb - wa < tolLn) break;
    let m = wra - wrb !== 0 ? wa + (wb - wa) * wra / (wra - wrb) : 0.5 * (wa + wb);
    if (!(m > wa && m < wb)) m = 0.5 * (wa + wb);
    const rm = pOf(m) - P;
    if (rm > 0) {
      wa = m; wra = rm;
      if (wside === 1) wrb *= 0.5;
      wside = 1;
    } else {
      wb = m; wrb = rm;
      if (wside === -1) wra *= 0.5;
      wside = -1;
    }
  }
  return Math.exp(0.5 * (wa + wb));
}

// ---------------------------------------------------------------------------
// State evaluation: pressure closure and derived geometry
// ---------------------------------------------------------------------------

export interface OtsgState {
  m1: number;   // kg - subcooled section
  m2: number;   // kg - two-phase section
  m3: number;   // kg - superheated section
  U1: number;   // J  - subcooled section energy (the slug carries its own)
  U3: number;   // J  - superheated section energy
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
  /** Specific volume of that same outlet steam (m3/kg): built from the same
   *  states with the same weights as hSteamOut, so a vapour draw's density
   *  and its enthalpy describe one fluid. */
  vSteamOut: number;
  /** Temperature of that same outlet steam (K): what a thermocouple in the
   *  steam nozzle reads. Saturation when there is no superheat section. */
  TSteamOut: number;
  u3: number;        // superheat specific energy actually used (J/kg)
  /** Quality the boiling section reaches at its OUTLET. 1 whenever there is
   *  anything downstream to hand dry steam to; below 1 only for a flooded
   *  bundle whose boiling section IS the top of the tube. */
  x2Out: number;
  /** Which of the closure's cases produced this split - see evaluateOtsgAtP.
   *  'flooded' (no dry steam), 'dryout' (dry steam at saturation), 'superheat'
   *  (volume and energy both enforced), 'supercritical' (no dome at all). */
  regime: 'flooded' | 'dryout' | 'superheat' | 'supercritical';
  /** The steam isobar at P that the outlet and the mean pin were read from,
   *  present whenever there is a superheat section - the wall duty reads the
   *  same one (otsgWaterSideDuties). Above the dome it is the local tangent
   *  of the one fluid's own state instead. */
  steamIsobar?: SteamIsobar;
  /** The steam along the superheat section, inlet to outlet - the march that
   *  set hSteamOut, point by point (see finish). Its last point IS the
   *  outlet. Absent when there is no superheat section. */
  steamProfile?: OtsgSteamProfile;
  /** Pressure tangent at the solved point (Pa/kg, Pa/J, Pa/kg), when asked
   *  for: dPdm follows feed addition (mass, its enthalpy and the slug's own
   *  pair together), dPdU energy alone, dPdm1 and dPdU1 the slug's mass and
   *  energy alone. From the
   *  implicit function - residual derivatives at the solved pressure - so
   *  it costs residual evaluations, not root finds. Absent when a
   *  perturbation lands on a regime edge (no tangent there). */
  tangent?: { dPdm: number; dPdU: number; dPdm1: number; dPdU1: number };
}

const P_MIN = 700;      // Pa - just above the triple point
const P_MAX = 2.15e7;   // Pa - just below critical

/**
 * Evaluate the tube side: solve pressure from the volume constraint and
 * derive every section's geometry and mean state.
 *
 * Both end sections carry their own energy: the subcooled section's mean
 * comes from U1/m1 (its cold end is then 2 u1 - u_f - see OtsgSlug), the
 * superheat section's from U3/m3. No feed enthalpy appears anywhere in the
 * evaluation; it prices only the mass entering, in otsgRates.
 */
export function evaluateOtsg(
  state: OtsgState,
  geom: OtsgGeometry,
): OtsgEval {
  const { m1, m2, m3, U1, U3 } = state;
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
  // Subcooled specific energy: its own integrated state.
  const u1Bar = m1 > 0 ? U1 / m1 : NaN;

  const volumeAt = (P: number): { V: number; sat: SaturationProps; v1: number; v2: number; v3: number; u3: number } => {
    const sat = saturationAtP(P);
    const v1 = m1 > 0 ? subcooledLiquidV(Math.min(u1Bar, sat.u_f)) : sat.v_f;
    // Mass-averaged over the linear quality profile - see boilingMeanQuality
    const v2 = sat.v_f + boilingMeanQuality(sat.v_f, sat.v_g) * (sat.v_g - sat.v_f);
    const u3 = m3 > 0 ? u3Free : sat.u_g;
    const v3 = m3 > 0 ? superheatedV(Math.max(u3, sat.u_g + 1e3), P, undefined, undefined, sat) : sat.v_g;
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

  // Section mean enthalpies (the boiling profile closure; the ends are free)
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
  const vSteamOut = m3 > 0 ? w * fin.v3 + (1 - w) * sat.v_g : sat.v_g;
  const TSteamOut = w * T3 + (1 - w) * sat.T;

  return {
    P, sat,
    sections: [
      mk(m1, fin.v1, V1, h1Bar, T1),
      mk(m2, fin.v2, V2, h2Bar, sat.T),
      mk(m3, fin.v3, V3, h3Bar, T3),
    ],
    hSteamOut,
    vSteamOut,
    TSteamOut,
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
 * The economizer's integrated state: its mass, its ENERGY, and the
 * saturation the pair was last made consistent with.
 *
 * The slug used to be a mass ledger alone, priced on a linear profile pinned
 * at the instantaneous inlet enthalpy - U1 = m1 (u_in + u_f(P))/2. That pin
 * had two consequences the plant could feel. A feed-temperature change
 * repriced the WHOLE slug in one step (a 20 K move is ~10 MJ across a 220 kg
 * Xe-100 slug, all of it landing on the leftovers that set the pressure).
 * And a STANDING slug under a hot wall could not warm: the only way the
 * model could absorb Q1 was to move the boundary, so at W = 0 it reported
 * W12 = 2 Q1/(u_f - u_in) - twice the batch-heating rate - while the real
 * slug's mean energy rose. The energy the pinned profile could not hold
 * landed on the leftovers, which is one source of the "steam section hotter
 * than its wall" reports.
 *
 * Carrying U1 fixes both, and the profile is then DERIVED from the pair: it
 * stays linear (uniform in u per unit mass to this model's accuracy), so
 * with mean u1 = U1/m1 running to the saturation the pair is referenced to,
 * the COLD END is
 *
 *     u_a = 2 u1 - u_f
 *
 * and the inlet enthalpy prices only the mass actually entering (otsgRates),
 * never the water already standing there.
 */
export interface OtsgSlug {
  m1: number;      // kg
  U1: number;      // J
  /** Saturated-liquid energy (J/kg) the pair was last reconciled to;
   *  undefined = take it as it stands (first evaluation). */
  uFRef?: number;
}

/** Never more slug than the tube holds. Capping the mass rescales the energy
 *  with it, so the profile keeps its shape (its mean u is unchanged). */
function capSlug(m1: number, U1: number, massTotal: number): { m1: number; U1: number } {
  if (!(m1 > massTotal)) return { m1, U1 };
  return { m1: massTotal, U1: massTotal > 0 ? U1 * massTotal / m1 : 0 };
}

/**
 * Move the economizer boundary with pressure - one expression, both
 * directions.
 *
 * The profile's COLD END is the physical invariant of a pressure move: no
 * heat has crossed the tube wall, so the coldest water in the slug is still
 * the coldest water in the slug. What moves is the hot end, which is where
 * saturation now is. Preserving the profile's mass density in energy space,
 * dm/du = m1/(u_fRef - u_a), and re-cutting it at the new saturation gives
 *
 *     m1' = m1 (u_f - u_a)/(u_fRef - u_a),    U1' = m1' (u_a + u_f)/2
 *
 * which reads, on a FALL, as the part of the profile above the new
 * saturation flashing out of the section (carrying its own profile mean -
 * the leftovers ARE totals minus slug, so that accounting is automatic);
 * and on a RISE as boiling-section liquid at the old saturation joining and
 * being warmed to fill the newly-subcooled span, the latent heat for which
 * comes from the vapour condensing beside it (again automatic). Identity at
 * u_f = u_fRef, continuous through it, and exactly reversible.
 *
 * The rise is capped by `joinCap` - the liquid the leftovers can actually
 * give up (slugJoinCap): past what they hold there is nothing to join, and
 * pulling more would leave a sliver carrying all the remaining energy, which
 * the partition's sentinel reads as "pressure far too low" and the root find
 * then chases upward. A capped join keeps the cold end and thins the
 * profile instead.
 *
 * The MASS-ledger predecessor needed a different rule per direction, and its
 * rise had to over-join to undo its own repricing (its denominator was
 * (u_fRef - u_a) - (u_f - u_fRef), so it grew faster than the profile does);
 * with the energy carried there is nothing to undo.
 */
export function reconcileSlug(
  m1: number, U1: number, uFRef: number, uF: number, massTotal: number,
  joinCap = Infinity,
): { m1: number; U1: number } {
  if (!(m1 > 0)) return { m1: 0, U1: 0 };
  // With no usable reference (the first evaluation, or a pair whose mean has
  // already reached the reference) the profile is simply read at the CURRENT
  // saturation, which makes the expression below the exact identity.
  let ref = Number.isFinite(uFRef) ? uFRef : uF;
  let uA = 2 * U1 / m1 - ref;
  if (!(ref - uA > 0)) { ref = uF; uA = 2 * U1 / m1 - ref; }
  // The whole profile is at or above saturation - the section has boiled
  // away. This is where a slug dying under a hot wall ENDS: its mass and its
  // subcooling go to zero together (m1 stays proportional to the span,
  // because the duty carries the section's own area), and whichever of the
  // two crosses first, the sliver that is left is not subcooled water and
  // its energy belongs to the leftovers, which is where subtracting it puts
  // it. No floor, and nothing to switch.
  const span = uF - uA;
  if (!(span > 0)) return { m1: 0, U1: 0 };
  let m1New = m1 * span / (ref - uA);
  if (uF > ref) m1New = m1 + Math.min(m1New - m1, Math.max(0, joinCap));
  m1New = Math.min(m1New, massTotal);
  return { m1: m1New, U1: m1New * 0.5 * (uA + uF) };
}

/**
 * Liquid the leftovers (mR, UR) can give to the economizer when the
 * pressure rises: joining removes mass at `uJoin` - the mean energy the
 * joining water leaves with, saturated liquid at the old pressure warmed to
 * fill the newly-subcooled span - and must leave the remainder no hotter
 * than saturated vapor at the new pressure, the most a two-phase remainder
 * can be drained of liquid. Zero when the leftovers are already dry (or
 * empty).
 */
export function slugJoinCap(mR: number, UR: number, uJoin: number, uG: number): number {
  if (!(mR > 0)) return 0;
  const uBar = UR / mR;
  if (!(uBar < uG) || !(uG > uJoin)) return 0;
  return mR * (uG - uBar) / (uG - uJoin);
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
  /** K - the bundle's tube-metal zone temperatures, feed end to steam end
   *  (equal lengths). The superheat section's wall is whatever stretch of
   *  them it covers - see zoneMeanTemp. A single entry is a uniform wall. */
  zoneTemps: number[];
  hA3Full: number;  // W/K - steam-film conductance if section 3 owned the whole bundle
  WSteam: number;   // kg/s - the steam draw crossing the superheat section
  /** The tube's nozzles as the steam pass sees them (marchSteamStreams):
   *  where steam leaves and where it arrives, so the section's stream runs
   *  the way the flows actually go. Absent = the ordinary once-through case,
   *  one draw of WSteam at the steam end. */
  steamNozzles?: SteamNozzle[];
}

/** The pin's steam nozzles, or the once-through default when it names none. */
export function pinSteamNozzles(pin: OtsgWallPin): SteamNozzle[] {
  return pin.steamNozzles
    ?? [{ zone: pin.zoneTemps.length - 1, W: -Math.max(0, pin.WSteam), h: 0 }];
}

/** Default number of fixed tube-metal zones per moving-boundary bundle
 *  (a heat exchanger can override it with `tubeMetalZones`). The zone that
 *  a section boundary sits in carries a blend of both sections' walls, so
 *  this sets how sharply the wall's temperature profile is resolved.
 *  Convergence on the steady Xe-100 (2026-11-01): 20 and 40 zones agree to
 *  ~5 K on steam temperature and a point on section lengths; 10 drifts
 *  (boiling length 14% -> 7%) and 5 wanders (0-35%) because a ~12% boiling
 *  section then shares a zone with its neighbours. Cost is negligible next
 *  to the partition solve (40 zones ran as fast as the old 3 nodes), so the
 *  default sits at 40 for headroom on designs whose boiling section is
 *  shorter than the Xe-100's. */
export const OTSG_METAL_ZONES = 40;

/**
 * Length of each section inside each metal zone. The tube metal is fixed in
 * space as `nZones` equal zones from the feed end (s = 0) to the steam end
 * (s = 1); the water sections lie end to end over it in flow order and their
 * boundaries move. Entry [k][i] is the fraction of the WHOLE tube where zone k
 * and section i coincide, so each zone's row sums to 1/nZones and each
 * section's column to its length fraction. A boundary jittering inside a zone
 * only slides this split - no metal changes hands, so nothing is mixed.
 */
export function otsgZoneOverlaps(
  lengthFracs: readonly [number, number, number], nZones: number,
): Array<[number, number, number]> {
  const b1 = lengthFracs[0], b2 = lengthFracs[0] + lengthFracs[1];
  const edges = [0, b1, b2, 1];
  const out: Array<[number, number, number]> = [];
  for (let k = 0; k < nZones; k++) {
    const z0 = k / nZones, z1 = (k + 1) / nZones;
    const row: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      row[i] = Math.max(0, Math.min(z1, edges[i + 1]) - Math.max(z0, edges[i]));
    }
    out.push(row);
  }
  return out;
}

/**
 * Length-weighted mean temperature of the metal zones over [s0, s1] of the
 * tube (zones equal, feed end at 0). As the span closes it tends to the zone
 * at that point, so a vanishing section reads the metal it is about to grow
 * over - continuous, no special case.
 */
export function zoneMeanTemp(zoneTemps: readonly number[], s0: number, s1: number): number {
  const n = zoneTemps.length;
  if (!(n > 0) || zoneTemps.some(T => !Number.isFinite(T))) {
    throw new Error(`[OTSG] tube metal zone temperatures are not usable: [${zoneTemps.join(', ')}]`);
  }
  if (!(s1 - s0 > 1e-12)) {
    return zoneTemps[Math.min(n - 1, Math.max(0, Math.floor(s0 * n)))];
  }
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const ov = Math.min((k + 1) / n, s1) - Math.max(k / n, s0);
    if (ov > 0) sum += ov * zoneTemps[k];
  }
  return sum / (s1 - s0);
}

/**
 * Steam along one isobar, saturated vapour upward: the temperature, energy,
 * volume and enthalpy of the stream that crosses the superheat section, read
 * off the property surface. Everything that asks "how hot is steam carrying
 * this much heat" - the outlet, the section's mean pin, the wall duty - reads
 * this one table, so they describe one stream. (They used to share a constant
 * cp of 3000 J/kg-K, or a secant through the section mean. Steam leaving the
 * dome at boiler pressure has several times that, falling steeply over the
 * first tens of kelvin, so a constant overstated how fast the stream closes
 * on its wall.)
 *
 * Between nodes h, u and v are linear in T - cp is constant on a segment, so
 * the film approach across a piece of isothermal wall is exact segment by
 * segment (marchSteamOverMetal). Below the first node and above the last the
 * end segments continue: steam meeting metal colder than saturation is priced
 * as sensible cooling at the dome-edge cp (condensation on a cold superheater
 * wall is not modelled), and metal that warmed past the table since it was
 * built reads the last slope.
 */
export interface SteamIsobar {
  P: number;
  T: number[];
  u: number[];
  v: number[];
  h: number[];
}

/** Node spacing of the isobar table, in specific energy: the first step off
 *  the dome, and the growth of each step over the last. cp changes fastest
 *  at the dome and flattens above it, so the nodes crowd there. Resolution,
 *  not physics. */
const ISOBAR_FIRST_STEP = 20e3;
const ISOBAR_STEP_GROWTH = 1.3;

/** Build the isobar from saturation up to (at least) TTop. */
export function buildSteamIsobar(
  P: number, sat: SaturationProps, TTop: number,
  probe: (u: number, v: number, what: string) => { temperature: number } =
    (u, v) => calculateState(1, u, v),
): SteamIsobar {
  const iso: SteamIsobar = { P, T: [sat.T], u: [sat.u_g], v: [sat.v_g], h: [sat.h_g] };
  let du = ISOBAR_FIRST_STEP;
  let vHint: number | undefined;
  for (;;) {
    const i = iso.T.length - 1;
    const u = iso.u[i] + du;
    if (u > U3_CEILING) {
      throw new Error(`[OTSG] tube metal at ${(TTop - 273.15).toFixed(0)} C asks for steam at ` +
        `${(P / 1e5).toFixed(1)} bar past the ${(U3_CEILING / 1e6).toFixed(1)} MJ/kg where the ` +
        `steam tables end (they reach ${(iso.T[i] - 273.15).toFixed(0)} C on this isobar). ` +
        `That is not a wall temperature a boiler tube survives.`);
    }
    const v = superheatedV(u, P, 1e-6, vHint, sat);
    vHint = v;
    const T = probe(u, v, 'steam isobar').temperature;
    const h = u + P * v;
    if (!(T > iso.T[i]) || !(h > iso.h[i])) {
      throw new Error(`[OTSG] steam isobar at ${(P / 1e5).toFixed(2)} bar is not rising: ` +
        `${(iso.u[i] / 1e3).toFixed(1)} kJ/kg reads ${iso.T[i].toFixed(3)} K, h=${(iso.h[i] / 1e3).toFixed(1)} kJ/kg; ` +
        `${(u / 1e3).toFixed(1)} kJ/kg reads ${T.toFixed(3)} K, h=${(h / 1e3).toFixed(1)} kJ/kg. ` +
        `The property surface is not monotone along this isobar.`);
    }
    iso.T.push(T); iso.u.push(u); iso.v.push(v); iso.h.push(h);
    if (T >= TTop) return iso;
    du *= ISOBAR_STEP_GROWTH;
  }
}

/** One of the isobar's columns at temperature T (end segments continue). */
export function isobarAt(iso: SteamIsobar, col: 'u' | 'v' | 'h', T: number): number {
  const n = iso.T.length;
  let j = 0;
  while (j < n - 2 && T >= iso.T[j + 1]) j++;
  const y = iso[col];
  return y[j] + (y[j + 1] - y[j]) * (T - iso.T[j]) / (iso.T[j + 1] - iso.T[j]);
}

/** Temperature on the isobar at specific energy u (end segments continue). */
export function isobarTempAtU(iso: SteamIsobar, u: number): number {
  const n = iso.T.length;
  let j = 0;
  while (j < n - 2 && u >= iso.u[j + 1]) j++;
  return iso.T[j] + (iso.T[j + 1] - iso.T[j]) * (u - iso.u[j]) / (iso.u[j + 1] - iso.u[j]);
}

/** Temperature on the isobar at enthalpy h (end segments continue). */
export function isobarTempAtH(iso: SteamIsobar, h: number): number {
  const n = iso.T.length;
  let j = 0;
  while (j < n - 2 && h >= iso.h[j + 1]) j++;
  return iso.T[j] + (iso.T[j + 1] - iso.T[j]) * (h - iso.h[j]) / (iso.h[j + 1] - iso.h[j]);
}

/** Points traced per metal zone along the superheat section (see
 *  marchSteamOverMetal's `trace`). Resolution of the drawn curve between the
 *  zone boundaries, not physics: every point is exact, and a nozzle between
 *  two of them reads the chord. */
const TRACE_STEPS = 4;

/**
 * A stream of W kg/s at temperature T crossing a piece of film (conductance
 * hA, W/K) on a wall at TWall: the temperature it leaves at. On a segment of
 * the isobar cp is constant and the approach is the exponential
 *     T <- TWall - (TWall - T) e^(-hA / W cp),
 * so the piece is walked segment by segment, each spending the conductance it
 * takes to reach its far node. Every move is toward the wall and stops short
 * of it; a stream that does not flow (W = 0) is at its wall.
 */
function approachWall(iso: SteamIsobar, T: number, TWall: number, hA: number, W: number): number {
  if (!(hA > 0) || TWall === T) return T;
  if (!(W > 0)) return TWall;
  const n = iso.T.length;
  const heating = TWall > T;
  let budget = hA / W;                       // J/kg-K still to spend
  for (;;) {
    // The segment the stream is about to move through.
    let j = 0;
    if (heating) { while (j < n - 2 && T >= iso.T[j + 1]) j++; }
    else { while (j < n - 2 && T > iso.T[j + 1]) j++; }
    const cp = (iso.h[j + 1] - iso.h[j]) / (iso.T[j + 1] - iso.T[j]);
    // Its far node in the direction of travel - unless the stream is already
    // past the table's end that way, where the end segment simply continues.
    const TNode = heating ? iso.T[j + 1] : iso.T[j];
    const open = heating ? T >= iso.T[n - 1] : T <= iso.T[0];
    const nodeFirst = !open && (heating ? TNode < TWall : TNode > TWall);
    if (nodeFirst) {
      const need = cp * Math.log((TWall - T) / (TWall - TNode));
      if (budget > need) { budget -= need; T = TNode; continue; }
    }
    return TWall - (TWall - T) * Math.exp(-budget / cp);
  }
}

// ---------------------------------------------------------------------------
// Streams along the tube: any direction, any point of entry
// ---------------------------------------------------------------------------

/** A stream entering a run of zones through a nozzle: the zone it opens
 *  into, its flow (kg/s) and the temperature it arrives at. */
export interface ZoneSource { zone: number; W: number; T: number }

export interface CellMarch {
  /** kg/s flowing into each cell (0 for a stagnant one, or one outside the run) */
  W: number[];
  /** K - the mixed stream entering each cell, and the stream leaving it */
  TIn: number[];
  TOut: number[];
  /** W - heat each cell's stream takes from its wall */
  Q: number[];
}

/**
 * The march of a quasi-steady stream over a run of metal zones, when the
 * stream may run EITHER way along the tube, enter or leave part-way, or not
 * flow at all.
 *
 * A boiler tube's feed normally comes in at the bottom and its steam leaves
 * at the top, and a march that hard-codes that order is right until the day
 * a header backs up, a tube tears part-way along, or the shell gas turns
 * round - when it goes on heating a stream that is no longer there, in the
 * direction it is no longer going. So the march takes the flows as they are:
 *
 *  - `up[k]` (k = 0..n) is the mass flow, kg/s, crossing the LOWER edge of
 *    zone k upward (negative = downward); up[n] is the top end of the tube.
 *  - `sources` are the streams entering through nozzles.
 *
 * Each zone the run covers (kLo..kHi) is a cell. What flows into a cell -
 * from the cell below when up[k] > 0, from the one above when up[k+1] < 0,
 * through its own nozzles - mixes at the cell's inlet, crosses the cell's
 * film (`cross`: the caller's law for W kg/s arriving at T against zone k,
 * returning the temperature it leaves at; the heat it took is its enthalpy
 * rise, by `hOf`), and leaves at that outlet state to wherever the flows
 * carry it. A cell is only ever
 * downstream of a neighbour across an edge the flow crosses TOWARD it, so
 * the dependencies cannot loop and two sweeps resolve them: upward for every
 * cell that takes nothing from above, then downward for the rest.
 *
 * The lowest cell takes what crosses the run's lower boundary at `TBelow`,
 * the highest what crosses its upper boundary at `TAbove` - the state of
 * whatever lies beyond the run there. A cell with nothing flowing into it is
 * stagnant: no transit heat, standing at `stagnantT(k)`.
 *
 * With one stream entering at the bottom and flowing up this is the plain
 * forward march, operation for operation.
 */
export function marchCells(
  nZones: number, kLo: number, kHi: number,
  up: readonly number[],
  sources: readonly ZoneSource[],
  TBelow: number, TAbove: number,
  cross: (k: number, T: number, W: number) => number,
  hOf: (T: number) => number,
  TOfH: (h: number) => number,
  stagnantT: (k: number) => number,
): CellMarch {
  if (up.length !== nZones + 1) {
    throw new Error(`[OTSG] stream march over ${nZones} zones was handed ${up.length} edge flows ` +
      `(it needs ${nZones + 1}).`);
  }
  const W = new Array<number>(nZones).fill(0);
  const TIn = new Array<number>(nZones).fill(NaN);
  const TOut = new Array<number>(nZones).fill(NaN);
  const Q = new Array<number>(nZones).fill(0);
  const done = new Array<boolean>(nZones).fill(false);
  const nSources = sources.length;
  // Two sweeps: up, then down. (Written flat - this runs for every zone of
  // every stream on every evaluation, and closures here were a measurable
  // share of the plant's run time.)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = kLo; i <= kHi; i++) {
      const k = pass === 0 ? i : kHi + kLo - i;
      if (done[k]) continue;
      const fromBelow = up[k] > 0, fromAbove = up[k + 1] < 0;
      if (fromBelow && k > kLo && !done[k - 1]) continue;
      if (fromAbove && k < kHi && (pass === 0 || !done[k + 1])) continue;
      // Everything flowing into the cell. A single contributor passes its
      // temperature through untouched; several mix by enthalpy.
      let wSum = 0, hSum = 0, count = 0, TOne = NaN;
      if (fromBelow) {
        TOne = k > kLo ? TOut[k - 1] : TBelow;
        wSum = up[k]; count = 1;
      }
      if (fromAbove) {
        const w = -up[k + 1], T = k < kHi ? TOut[k + 1] : TAbove;
        if (count === 0) TOne = T; else hSum = wSum * hOf(TOne) + w * hOf(T);
        wSum += w; count++;
      }
      for (let j = 0; j < nSources; j++) {
        const s = sources[j];
        if (s.zone !== k || !(s.W > 0)) continue;
        if (count === 0) TOne = s.T;
        else if (count === 1) hSum = wSum * hOf(TOne) + s.W * hOf(s.T);
        else hSum += s.W * hOf(s.T);
        wSum += s.W; count++;
      }
      if (count === 0) {
        TIn[k] = TOut[k] = stagnantT(k);
      } else {
        const T = count === 1 ? TOne : TOfH(hSum / wSum);
        if (!Number.isFinite(T)) {
          throw new Error(`[OTSG] stream march: ${wSum.toFixed(3)} kg/s enters zone ${k + 1} of ` +
            `${nZones} at a temperature that is not a number (${T}).`);
        }
        const TNext = cross(k, T, wSum);
        W[k] = wSum; TIn[k] = T; TOut[k] = TNext;
        Q[k] = wSum * (hOf(TNext) - hOf(T));
      }
      done[k] = true;
    }
  }
  for (let k = kLo; k <= kHi; k++) {
    if (!done[k]) {
      throw new Error(`[OTSG] stream march could not order its cells: zone ${k + 1} of ${nZones} ` +
        `waits on a neighbour that waits on it (edge flows ${up.map(x => x.toFixed(3)).join(', ')}).`);
    }
  }
  return { W, TIn, TOut, Q };
}

/**
 * A nozzle on the tube as the steam pass sees it: the metal zone it opens
 * into and the flow through it that is NOT economizer water - positive into
 * the tube, arriving at specific enthalpy `h`; negative out of it.
 */
export interface SteamNozzle { zone: number; W: number; h: number }

/**
 * The steam crossing the superheat section, whichever way it is going.
 *
 * The section's stream is whatever its nozzles and its boundary with the
 * boiling section make it. Counted from the tube's steam end downward, the
 * flow crossing any height is what the nozzles above it take out (or put
 * in): steam drawn from the top outlet comes up through the whole section
 * from the boiling boundary, entering saturated; steam pushed IN at the top
 * (a header backing up into a tube that has lost its feed) runs down through
 * it, entering at its own temperature; a nozzle part-way up takes or adds
 * only below itself. marchCells walks that, and with one draw at the top it
 * is the ordinary once-through march (marchSteamOverMetal).
 *
 * What an inflow contributes to the steam STREAM is its vapour: superheated
 * steam arrives whole, at the temperature its enthalpy has on this isobar;
 * wet steam as its vapour fraction, at saturation; and water below
 * saturation as nothing - it is not a stream of steam. It quenches the
 * section through the node's totals, which is where its mass and enthalpy
 * already are.
 *
 * Returns the steam at the section's TOP edge (what a thermocouple in the
 * steam nozzle reads, leaving or arriving), its length-mean temperature, and
 * the heat each zone gives it - see marchSteamOverMetal for what each is for.
 */
export function marchSteamStreams(
  iso: SteamIsobar,
  sat: { T: number; h_f: number; h_g: number },
  zoneTemps: readonly number[],
  overlap: readonly number[],
  hAFull: number,
  nozzles: readonly SteamNozzle[],
  trace?: { s: number[]; T: number[] },
): { TOut: number; TMean: number; transit: number[] } {
  const n = zoneTemps.length;
  let kLo = -1, kHi = -1;
  for (let k = 0; k < n; k++) {
    if (overlap[k] > 0) { if (kLo < 0) kLo = k; kHi = k; }
  }
  if (trace) { trace.s.length = 0; trace.T.length = 0; }
  if (kLo < 0) {
    // A section of no length: inlet and outlet are the same point.
    if (trace) { trace.s.push(0); trace.T.push(sat.T); }
    return { TOut: sat.T, TMean: sat.T, transit: new Array<number>(n).fill(0) };
  }
  // Edge flows counted from the steam end down, and the vapour each inflow
  // brings.
  const into = new Array<number>(n).fill(0);
  const sources: ZoneSource[] = [];
  for (const z of nozzles) {
    if (!(z.zone >= 0 && z.zone < n) || !Number.isFinite(z.W)) {
      throw new Error(`[OTSG] a steam nozzle in zone ${z.zone} of ${n} carrying ${z.W} kg/s is ` +
        `not a nozzle on this tube.`);
    }
    if (z.W > 0) {
      const dry = z.h >= sat.h_g;
      const Wv = dry ? z.W : z.W * Math.max(0, (z.h - sat.h_f) / (sat.h_g - sat.h_f));
      if (!(Wv > 0)) continue;
      into[z.zone] += Wv;
      sources.push({ zone: z.zone, W: Wv, T: dry ? isobarTempAtH(iso, z.h) : sat.T });
    } else {
      into[z.zone] += z.W;
    }
  }
  const up = new Array<number>(n + 1).fill(0);
  for (let k = n - 1; k >= 0; k--) up[k] = up[k + 1] - into[k];

  const sub: number[][] | undefined = trace ? [] : undefined;
  const march = marchCells(n, kLo, kHi, up, sources, sat.T, sat.T,
    (k, T, W) => {
      const hA = hAFull * overlap[k];
      let TNext = T;
      if (sub) {
        const pts: number[] = [];
        for (let i = 1; i <= TRACE_STEPS; i++) {
          TNext = approachWall(iso, TNext, zoneTemps[k], hA / TRACE_STEPS, W);
          pts.push(TNext);
        }
        sub[k] = pts;
      } else {
        TNext = approachWall(iso, T, zoneTemps[k], hA, W);
      }
      return TNext;
    },
    T => isobarAt(iso, 'h', T),
    h => isobarTempAtH(iso, h),
    k => zoneTemps[k]);

  let L = 0, wallSum = 0, taken = 0;
  for (let k = kLo; k <= kHi; k++) {
    L += overlap[k];
    wallSum += overlap[k] * zoneTemps[k];
    taken += march.Q[k];
  }
  // Which way the stream runs through a cell decides which of its edges its
  // inlet state sits at. A cell fed from both ends reads upward.
  if (trace) {
    const lowDown = march.W[kLo] > 0 && up[kLo] + up[kLo + 1] < 0;
    trace.s.push(0);
    trace.T.push(lowDown ? march.TOut[kLo] : march.W[kLo] > 0 ? march.TIn[kLo] : sat.T);
    let behind = 0;
    for (let k = kLo; k <= kHi; k++) {
      const pts = sub![k];
      const down = march.W[k] > 0 && up[k] + up[k + 1] < 0;
      for (let i = 1; i <= TRACE_STEPS; i++) {
        trace.s.push((behind + overlap[k] * i / TRACE_STEPS) / L);
        // Stagnant: at its wall. Upward: the i-th point of its walk. Downward:
        // the same walk read from its far end, arriving at the top edge.
        trace.T.push(!pts ? zoneTemps[k]
          : !down ? pts[i - 1]
          : i === TRACE_STEPS ? march.TIn[k] : pts[TRACE_STEPS - 1 - i]);
      }
      behind += overlap[k];
    }
  }
  const topDown = march.W[kHi] > 0 && up[kHi] + up[kHi + 1] < 0;
  const TOut = topDown ? march.TIn[kHi] : march.TOut[kHi];
  const TMean = hAFull > 0 ? wallSum / L - taken / (hAFull * L) : sat.T;
  return { TOut, TMean, transit: march.Q };
}

/**
 * The steam crossing the superheat section: the stream that enters at TIn
 * (saturation), marched in flow order across the metal zones the section
 * covers, approaching each one across its own piece of film (approachWall).
 * `overlap[k]` is the fraction of the whole tube where zone k and the section
 * coincide (otsgZoneOverlaps), `hAFull` the steam film's conductance if the
 * section owned the whole bundle.
 *
 * This is the ordinary once-through case of marchSteamStreams - one draw of
 * W at the steam end, fed from the boiling boundary - kept under its own
 * name because it is the case every design point is built around.
 *
 * One march answers three questions, which is the point:
 *  - TOut, the steam LEAVING. Every step moves the stream toward a zone's
 *    metal and never past it, so it cannot leave hotter than the hottest
 *    metal it crossed: the bound a tube wall imposes on the fluid inside it.
 *    The gas does not appear - the helium heats the METAL, and the metal's
 *    own energy balance decides how close to the gas inlet its steam end
 *    gets. (An effectiveness formula against the gas inlet, which this
 *    replaced, offered the Xe-100's turbine 630 C steam off a bundle whose
 *    hottest zone stood at 540 C.)
 *  - transit[k], the heat the stream takes from zone k: W times its enthalpy
 *    rise across that piece. They sum to W (h(TOut) - h(TIn)) exactly.
 *  - TMean, the stream's length-mean temperature. A piece of film carries
 *    hA_piece (T_zone - T_mean,piece), so over the section
 *        TMean = TWall - (heat taken) / hA_section
 *    with TWall the mean metal under it: the wall's mean, less the film drop
 *    it takes to carry the duty. No draw, no drop.
 *
 * The limits are the march's own: a vanishing draw soaks every piece to its
 * metal, a strong draw barely leaves saturation, a section of no length
 * returns its inlet, and metal colder than the stream cools it.
 *
 * `trace`, when given, receives the stream's temperature ALONG the section:
 * `s` the fraction of the section's length behind each point (0 at the
 * inlet, 1 at the outlet) and `T` the stream there. The approach to a wall
 * composes exactly (two half-pieces of film leave the stream where the whole
 * piece does), so each zone's piece is walked in TRACE_STEPS equal parts and
 * every traced point lies on the same curve TOut ends - the nozzle part-way
 * up the superheater draws the steam the outlet's own march has there.
 */
export function marchSteamOverMetal(
  iso: SteamIsobar,
  zoneTemps: readonly number[],
  overlap: readonly number[],
  hAFull: number,
  W: number,
  TIn: number,
  trace?: { s: number[]; T: number[] },
): { TOut: number; TMean: number; transit: number[] } {
  return marchSteamStreams(iso, { T: TIn, h_f: NaN, h_g: iso.h[0] }, zoneTemps, overlap, hAFull,
    [{ zone: zoneTemps.length - 1, W: -Math.max(0, W), h: 0 }], trace);
}

/** Fraction of the whole tube where each metal zone lies under a superheat
 *  section of length fraction L3 (the steam end). */
export function superheatOverlaps(nZones: number, L3: number): number[] {
  const s0 = 1 - L3;
  return Array.from({ length: nZones }, (_, k) =>
    Math.max(0, (k + 1) / nZones - Math.max(k / nZones, s0)));
}

/** The partition at ONE trial pressure - the closed form the pressure root
 *  find is solving. Exported so a probe or a test can read the volume
 *  residual and both sides of a regime seam directly, at the same (P, du3)
 *  the closure itself uses: the seams are supposed to join where the two
 *  descriptions coincide, and that is only checkable branch against branch. */
export interface OtsgAtP {
  sat: SaturationProps;
  m1: number; u1: number; v1: number;
  m2: number; x2Bar: number; v2: number;
  m3: number; u3: number; v3: number;
  /** sum(m_i v_i) - the volume this partition needs at this pressure. The
   *  pressure solve is the root of Vsum - V_tube. */
  Vsum: number;
  regime: OtsgEval['regime'];
  /** True when v3 came from a superheatedV inversion, so a caller iterating
   *  nearby pressures can carry it as the next warm start. */
  v3Solved: boolean;
}

export interface OtsgAtPArgs {
  massTotal: number;
  UTotal: number;
  /** The economizer's integrated (mass, energy) pair and the saturation it
   *  was last reconciled to - see OtsgSlug and reconcileSlug. */
  slug: OtsgSlug;
  /** The wall pin as an energy offset above saturated vapour, u3 - u_g. */
  du3: number;
  /** Warm start for the superheated-volume inversion. */
  v3Hint?: number;
}

/**
 * The partition at one pressure. Mass and energy split the leftovers in
 * every regime; which arm applies is decided by the SIGN of a solved mass,
 * and the arms are supposed to agree where they meet:
 *
 *  - m3 <= 0 (flooded): no dry steam. The boiling section's mean quality is
 *    the energy's to set; below zero quality the leftovers are simply liquid
 *    cooler than saturation, which subcooledLiquidV continues.
 *  - 0 < m3 < mR (dryout/superheat): the pin sets u3, the energy sets m3,
 *    the rest boils.
 *  - m3 >= mR: the totals carry more energy than pinned steam can hold at
 *    this pressure, so u3 unpins upward and the leftovers are one
 *    superheated region.
 *
 * The m3 = 0 seam coincides because the boiling section's mean quality there
 * IS the full-profile mean x2BarFull (m3 = 0 means UR = mR*u2Full), and the
 * log-mean identity v_f + x2BarFull*(v_g - v_f) = vBarFull makes the two
 * arms' v2 the same number; the m2 = 0 seam coincides because m3 = mR means
 * UR/mR is exactly the pinned u3. Verified branch-against-branch by
 * test-suite's OTSG seam-continuity cases.
 */
export function otsgPartitionAtP(P: number, a: OtsgAtPArgs): OtsgAtP {
  const { massTotal, UTotal, slug, du3 } = a;
  const uFRef = slug.uFRef;
  const sat = saturationAtP(P);
  // The economizer carries its own (mass, energy), and the boundary moves
  // with pressure from that pair: the part of the profile above the new
  // saturation flashes out on the way down, boiling-section liquid joins on
  // the way up (reconcileSlug). Nothing here is priced from the feed - the
  // slug's mean IS its own state, so a pressure move no longer reprices the
  // water standing in the tube and a feed-temperature move no longer
  // reprices it either.
  const raw = capSlug(slug.m1, slug.U1, massTotal);
  // How much liquid the leftovers can give the slug on a pressure rise,
  // judged with the slug at the energy it actually holds (no repricing to
  // undo, which is what let the root find talk itself up to 220 bar).
  let joinCap = 0;
  if (uFRef !== undefined && sat.u_f > uFRef) {
    joinCap = slugJoinCap(massTotal - raw.m1, UTotal - raw.U1,
      0.5 * (uFRef + sat.u_f), sat.u_g);
  }
  const rec = reconcileSlug(raw.m1, raw.U1, uFRef ?? NaN, sat.u_f, massTotal, joinCap);
  const m1 = rec.m1;
  const u1 = m1 > 0 ? rec.U1 / m1 : sat.u_f;
  const v1 = subcooledLiquidV(Math.max(1e4, Math.min(u1, sat.u_f)));
  const mR = massTotal - m1;
  const UR = UTotal - rec.U1;
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
      return { sat, m1, u1, v1, m2: 0, x2Bar: x2BarFull, v2: vBarFull, m3: mR, u3: U3_CEILING, v3: 1e6, Vsum: 1e6, regime: 'superheat', v3Solved: false };
    }
    return { sat, m1, u1, v1, m2: 0, x2Bar: 0, v2: sat.v_f, m3: 0, u3: sat.u_g, v3: sat.v_g, Vsum: m1 * v1, regime: 'flooded', v3Solved: false };
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
    return { sat, m1, u1, v1, m2: mR, x2Bar, v2, m3: 0, u3: sat.u_g, v3: sat.v_g, Vsum: m1 * v1 + mR * v2, regime: 'flooded', v3Solved: false };
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
      return { sat, m1, u1, v1, m2: 0, x2Bar: x2BarFull, v2: vBarFull, m3: mR, u3: U3_CEILING, v3: 1e6, Vsum: 1e6, regime: 'superheat', v3Solved: false };
    }
    const solve3 = u3Free > sat.u_g + 1e3;
    const v3 = solve3 ? superheatedV(u3Free, P, 1e-6, a.v3Hint, sat) : sat.v_g;
    return { sat, m1, u1, v1, m2: 0, x2Bar: x2BarFull, v2: vBarFull, m3: mR, u3: u3Free, v3, Vsum: m1 * v1 + mR * v3, regime: 'superheat', v3Solved: solve3 };
  }
  const solve3 = du3 > 1e-9;
  const v3 = solve3 ? superheatedV(u3, P, 1e-6, a.v3Hint, sat) : sat.v_g;
  const m2 = mR - m3;
  return {
    sat, m1, u1, v1, m2, x2Bar: x2BarFull, v2: vBarFull, m3, u3, v3,
    Vsum: m1 * v1 + m2 * vBarFull + m3 * v3,
    regime: solve3 ? 'superheat' : 'dryout',
    v3Solved: solve3,
  };
}

export function evaluateOtsgPartition(
  massTotal: number,
  UTotal: number,
  // The economizer's integrated (mass, energy) pair and the saturation it
  // was last reconciled to (see OtsgSlug); the boundary moves with pressure
  // relative to that reference in reconcileSlug.
  slug: OtsgSlug,
  geom: OtsgGeometry,
  pin: OtsgWallPin,
  PStart?: number,
  // Ask for the pressure tangent (see OtsgEval.tangent); hFeed prices the
  // mass perturbation the way feed arrives.
  tangentSpec?: { hFeed: number },
): OtsgEval {
  const m1Ledger = slug.m1;
  if (!Number.isFinite(m1Ledger) || m1Ledger < 0) {
    throw new Error(`[OTSG] economizer ledger is not a physical mass: m1=${m1Ledger} kg`);
  }
  if (!Number.isFinite(slug.U1) || slug.U1 < 0 || (slug.U1 > 0 && !(m1Ledger > 0))) {
    throw new Error(`[OTSG] economizer ledger is not a physical (mass, energy) pair: ` +
      `m1=${m1Ledger} kg carrying U1=${slug.U1} J. An empty section holds no energy.`);
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

  // The steam isobar at a solved pressure, up to the hottest tube metal. The
  // pin refresh and finish() ask at the same pressure, so the last one built
  // is kept.
  const TMetalTop = Math.max(...pin.zoneTemps);
  let isoKept: SteamIsobar | undefined;
  const isobarFor = (P: number, sat: SaturationProps): SteamIsobar => {
    if (!isoKept || isoKept.P !== P) isoKept = buildSteamIsobar(P, sat, TMetalTop, probe);
    return isoKept;
  };
  // Above the dome there is one fluid and no saturated inlet to build an
  // isobar from; the wall duty still needs the stream's cp. It is the
  // fluid's own (dh/dT)_P at its state, from the surface's local
  // derivatives: along the isobar dv = -(P_u / P_v) du.
  const localIsobar = (P: number, u: number, v: number, T: number, h: number): SteamIsobar => {
    const du = 1e-3 * u, dv = 1e-3 * v;
    const s0 = probe(u, v, 'supercritical state');
    const sU = probe(u + du, v, 'supercritical state');
    const sV = probe(u, v + dv, 'supercritical state');
    const Pu = (sU.pressure - s0.pressure) / du, Pv = (sV.pressure - s0.pressure) / dv;
    const Tu = (sU.temperature - s0.temperature) / du, Tv = (sV.temperature - s0.temperature) / dv;
    const dvdu = -Pu / Pv;
    const dTdu = Tu + Tv * dvdu;
    const cp = (1 + P * dvdu) / dTdu;
    if (!(cp > 0) || !Number.isFinite(cp)) {
      throw new Error(`[OTSG] supercritical tube at ${(P / 1e5).toFixed(1)} bar, ` +
        `${(u / 1e3).toFixed(0)} kJ/kg, ${v.toFixed(5)} m3/kg: the property surface gives no ` +
        `usable (dh/dT)_P there (cp=${cp}).`);
    }
    return { P, T: [T, T + 1], u: [u, u + 1 / dTdu], v: [v, v + dvdu / dTdu], h: [h, h + cp] };
  };

  // Assemble the final evaluation from a solved configuration.
  const finish = (
    P: number, sat: SaturationProps,
    m1: number, u1: number, v1: number,
    m2: number, x2Bar: number, v2: number,
    m3: number, u3: number, v3: number,
    regime: OtsgEval['regime'],
    // The specific energy the wall pin asked of the steam section. u3 is
    // above it only when the pin could not hold (see otsgPartitionAtP).
    u3Pin: number = u3,
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
    // The draw leaves from the section's OUTLET, which is a heat-transfer
    // result, not a profile reconstruction: the saturated stream marched
    // across the metal zones this section covers (superheatOutletTemp), the
    // same march that prices Q3. It cannot leave hotter than the hottest
    // metal it crossed. Two earlier forms could: the linear inversion
    // 2 h_bar - h_g (unbounded - at weak draw its theta tends to 2), and an
    // effectiveness formula against the gas inlet, which bounded the outlet
    // by the helium but not by the tube, and ran 90 K above the steam-end
    // metal at the Xe-100's design point.
    //
    // The outlet's temperature becomes an enthalpy on the same isobar the
    // march was run on (isobarFor) - the real property surface, NOT a
    // cp-linear extension: the section's own near-dome slope stretched over
    // hundreds of kelvin once over-priced the outlet by ~400 kJ/kg, a
    // correctly bounded TEMPERATURE arriving downstream as an unbounded
    // enthalpy.
    //
    // The march says what SHAPE the steam has along the section - how far
    // each point stands from the section's mean. Where the mean itself
    // stands is the stored energy's to say. While the wall pin holds they
    // are one statement (the pin sets u3 to the march's own mean). When it
    // cannot - the leftovers carry more energy than pinned steam can hold,
    // so there is no boiling section and u3 has floated above the pin - the
    // steam is hotter than the march's by that excess everywhere along it:
    // the march's curve, raised bodily until its mean is the section's.
    // Zero excess at the seam where the pin lets go, so nothing steps there,
    // and no scale of its own. (This used to be a blend from the marched
    // outlet toward the section mean, weighted by the boiling section's
    // mass over its last kilogram.) A supercritical pass has no saturated
    // inlet at all and stays uniform at its mean.
    let hSteamOut: number;
    let vSteamOut: number;
    let steamIsobar: SteamIsobar | undefined;
    let steamProfile: OtsgSteamProfile | undefined;
    let TSteamOut = sat.T;
    if (m3 <= 0) {
      hSteamOut = sat.h_g;
      vSteamOut = sat.v_g;
    } else if (regime === 'supercritical') {
      hSteamOut = h3Bar;
      vSteamOut = v3;
      TSteamOut = T3;
      steamIsobar = localIsobar(P, u3, v3, T3, h3Bar);
      steamProfile = { s: [0, 1], h: [h3Bar, h3Bar], v: [v3, v3] };
    } else {
      const iso = steamIsobar = isobarFor(P, sat);
      const trace = { s: [] as number[], T: [] as number[] };
      marchSteamStreams(iso, sat, pin.zoneTemps,
        superheatOverlaps(pin.zoneTemps.length, V3 / VT), pin.hA3Full, pinSteamNozzles(pin), trace);
      let dh = 0, dv = 0;
      if (u3 !== u3Pin) {
        const TPin = isobarTempAtU(iso, u3Pin);
        dh = h3Bar - isobarAt(iso, 'h', TPin);
        dv = v3 - isobarAt(iso, 'v', TPin);
      }
      // Metal colder than saturation cannot hand the draw less than
      // saturated vapour.
      steamProfile = {
        s: trace.s,
        h: trace.T.map(T => (T > sat.T ? isobarAt(iso, 'h', T) : sat.h_g) + dh),
        v: trace.T.map(T => (T > sat.T ? isobarAt(iso, 'v', T) : sat.v_g) + dv),
      };
      // A section too short to lie under any metal has no length to trace:
      // inlet and outlet are the same point.
      if (steamProfile.s.length === 1) {
        steamProfile.s.push(1); steamProfile.h.push(steamProfile.h[0]); steamProfile.v.push(steamProfile.v[0]);
      }
      const last = steamProfile.s.length - 1;
      hSteamOut = steamProfile.h[last];
      vSteamOut = steamProfile.v[last];
      if (hSteamOut > sat.h_g) TSteamOut = isobarTempAtH(iso, hSteamOut);
    }
    return {
      P, sat,
      sections: [
        mk(m1, v1, V1, h1Bar, T1),
        mk(m2, v2, V2, h2Bar, T2),
        mk(m3, v3, V3, h3Bar, T3),
      ],
      hSteamOut, vSteamOut, TSteamOut, u3, x2Out, regime, steamIsobar, steamProfile,
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
  // The partition at one pressure - closed form given the pin's u3
  // (otsgPartitionAtP, below).
  // ----------------------------------------------------------------
  type AtP = OtsgAtP;
  // The pin's exact placement needs the section's own conductance (theta
  // depends on L3) and a property inversion, both too heavy for the inner
  // pressure iterations - so the OUTER loop carries the pin as an energy
  // OFFSET above saturation (du3 = u3 - u_g) and a length fraction, and
  // refreshes both against the property surface after each pressure solve.
  let du3 = 0;
  let L3 = Math.max(0, Math.min(1, 1 - (massTotal * 0.0015) / V));
  let v3Carry: number | undefined;
  let v3CarryP: number | undefined;
  // The carried v3 was solved at a DIFFERENT pressure (solveP's previous
  // iterate) - that staleness is why the hint used to miss its own tight
  // bracket half the time. Vapor is near-ideal, so scale it: at fixed u an
  // ideal gas has v proportional to 1/P; steam's true exponent is a bit
  // smaller (dlnv/dlnP of -0.77 to -0.95), and 0.85 splits the range. The
  // hint only seeds a safeguarded Newton, so the exponent needs to be
  // roughly right, not exact.
  const carriedHint = (P: number): number | undefined =>
    v3Carry !== undefined && v3CarryP !== undefined && v3CarryP !== P
      ? v3Carry * Math.pow(v3CarryP / P, 0.85)
      : v3Carry;
  // The residual is a function of (P; totals, ledger). Solving takes the
  // node's own; the tangent below perturbs them at the solved pressure.
  const atPX = (P: number, massTotal: number, UTotal: number, m1L: number, U1L: number): AtP => {
    const r = otsgPartitionAtP(P, {
      massTotal, UTotal,
      slug: { m1: m1L, U1: U1L, uFRef: slug.uFRef },
      du3, v3Hint: carriedHint(P),
    });
    if (r.v3Solved) { v3Carry = r.v3; v3CarryP = P; }
    return r;
  };

  // ----------------------------------------------------------------
  // Pressure from the volume constraint: safeguarded root find on ln P,
  // warm-started from the node's last published pressure. V(P) falls with
  // P (every section shrinks), so the bracket is clean.
  // ----------------------------------------------------------------
  const atP = (P: number): AtP => atPX(P, massTotal, UTotal, slug.m1, slug.U1);

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
  // The pin offset the returned solve was made with (du3 itself moves on to
  // the refreshed value at the bottom of the loop).
  let du3Solved = 0;
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
    du3Solved = du3;
    const { P, fin } = solved;
    // Refresh the pin at the solved pressure.
    const L3New = Math.max(0, Math.min(1, (fin.m3 * fin.v3) / V));
    // The section's mean is the stream's own length-mean over the metal it
    // covers at this length: the wall's mean less the film drop that carries
    // the superheat duty (marchSteamOverMetal) - on the same isobar, with the
    // same draw, as the outlet and the wall duty. Its energy is read off
    // that isobar too.
    let du3New = 0;
    if (L3New > 0 && fin.m3 > 0) {
      const iso = isobarFor(P, fin.sat);
      const { TMean } = marchSteamStreams(iso, fin.sat, pin.zoneTemps,
        superheatOverlaps(pin.zoneTemps.length, L3New), pin.hA3Full, pinSteamNozzles(pin));
      // Metal colder than saturation leaves the section at saturated vapour.
      if (TMean > fin.sat.T) du3New = isobarAt(iso, 'u', TMean) - fin.sat.u_g;
    }
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
  const ev = finish(P, fin.sat, fin.m1, fin.u1, fin.v1, fin.m2, fin.x2Bar, fin.v2,
    fin.m3, fin.u3, v3, fin.regime, fin.sat.u_g + du3Solved);
  if (tangentSpec) {
    // Implicit-function tangent of the volume closure R(P; m, U, m1) = 0:
    // dP/dx = -(dR/dx)/(dR/dP), every derivative one residual evaluation
    // at the solved pressure with the pin held. The finite-difference
    // version this replaces re-solved the pressure three times per anchor
    // (each a root find of ~10-20 residual evaluations) and was ~3/4 of
    // the partition's whole cost. Same perturbation sizes as before so the
    // tangent means the same thing. A perturbation that lands on a regime
    // edge (a sentinel volume, a property failure) yields no tangent - the
    // consumer then solves exactly in that neighborhood, as it always did.
    try {
      const dm = Math.max(0.5, 2e-3 * massTotal);
      const dU = Math.max(1e5, 2e-3 * Math.abs(UTotal));
      const dP = 2e-3 * P;
      const R = (Pq: number, mT: number, UT: number, m1L: number, U1L: number): number => {
        const r = atPX(Pq, mT, UT, m1L, U1L).Vsum - V;
        if (!Number.isFinite(r) || Math.abs(r) > 1e3 * V) throw new Error('sentinel');
        return r;
      };
      const m1L = slug.m1, U1L = slug.U1;
      const R0 = R(P, massTotal, UTotal, m1L, U1L);
      const RP = (R(P + dP, massTotal, UTotal, m1L, U1L) - R0) / dP;
      if (!(RP < 0)) throw new Error('non-monotone residual');
      // Feed arrival moves all four together: mass, energy, and the slug's
      // own pair (the entering water lands in the economizer at its own
      // enthalpy).
      const dPdm = -((R(P, massTotal + dm, UTotal + dm * tangentSpec.hFeed,
        m1L + dm, U1L + dm * tangentSpec.hFeed) - R0) / dm) / RP;
      const dPdU = -((R(P, massTotal, UTotal + dU, m1L, U1L) - R0) / dU) / RP;
      const dPdm1 = -((R(P, massTotal, UTotal, m1L + dm, U1L) - R0) / dm) / RP;
      const dPdU1 = -((R(P, massTotal, UTotal, m1L, U1L + dU) - R0) / dU) / RP;
      if ([dPdm, dPdU, dPdm1, dPdU1].every(Number.isFinite)) {
        ev.tangent = { dPdm, dPdU, dPdm1, dPdU1 };
      }
    } catch {
      // no tangent in this neighborhood
    }
  }
  return ev;
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
  return { u, v: superheatedV(u, P, 1e-4, undefined, sat) };
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
    const v = superheatedV(u, P, 1e-4, vT, sat);
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
 * Section rates: the ends run their own open-system balances, and the
 * boiling section - whose energy is DERIVED from its profile - hands over
 * the interface flux that makes its balance close.
 *
 *   W12 = Q1 / (h_f - h_a) = Q1 / (2 (h_f - hBar1))
 *   W23 = (Q2 - W12 (hBar2 - h_f)) / (h_g - hBar2)
 *
 * W12 IS THE MASS CROSSING SATURATION, and with the slug carrying its own
 * energy that is all it is. The profile is uniform in enthalpy per unit
 * mass, dm/dh = m1/(h_f - h_a), and the wall pushes every kilogram up at
 * Q1/m1, so the flux across the saturation line is Q1/(h_f - h_a) - and the
 * cold end h_a = 2 hBar1 - h_f is the profile's own, not the feed's. Two
 * consequences the mass-ledger form could not express:
 *
 *  - a STANDING slug (W_in = 0) warms instead of only shortening. The old
 *    numerator was Q1 - W_in (hBar1 - h_in), which at W_in = 0 forced the
 *    whole duty into boundary motion: W12 = Q1/(h_f - hBar1), twice the
 *    batch rate, while the real slug's mean energy rose and the energy the
 *    pinned profile could not hold landed on the leftovers. Now
 *    dm1/dt = -Q1/(h_f - h_a) and dh_a/dt = Q1/m1 - the profile rises
 *    uniformly while its hot end boils off, with no switch between the
 *    regimes;
 *  - the boundary no longer moves for a flow that carries no heat. Cold feed
 *    with Q1 = 0 gives W12 = 0: the column shifts up bodily, the slug gets
 *    longer and colder on average, and nothing crosses saturation - which is
 *    the physics (the interface is a material one when there is no phase
 *    change). The pinned profile had to report W12 < 0 there, converting
 *    boiling-section mass to subcooled at h_f, because its mean was not
 *    allowed to move. A pressure RISE does still recruit boiling-section
 *    liquid, and that move is reconcileSlug's, where it belongs.
 *
 * Steady flow is exact either way: W12 = Q1/(2(h_f - hBar1)) with
 * Q1 = W (h_f - h_in) and hBar1 = (h_in + h_f)/2 gives W12 = W.
 *
 * hBar is taken from the EVALUATED section means (not an idealized
 * midpoint), and the boiling section's W23 closes ITS balance exactly - the
 * test checks the total to 1e-9.
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

  const m1 = ev.sections[0].mass;
  // Half the profile's span in enthalpy: h_f - hBar1 = (h_f - h_a)/2.
  const d1 = sat.h_f - hBar1;
  if (m1 > 0 && !(d1 > 0)) {
    throw new Error(`[OTSG] the subcooled section's mean enthalpy ${(hBar1 / 1e3).toFixed(0)} kJ/kg ` +
      `is at or above saturated liquid (${(sat.h_f / 1e3).toFixed(0)} kJ/kg at ` +
      `${(ev.P / 1e5).toFixed(1)} bar) while it still holds ${m1.toFixed(3)} kg. ` +
      `reconcileSlug is supposed to have flashed such a slug away entirely - ` +
      `the partition and the ledger disagree about where saturation is.`);
  }
  const d2 = sat.h_g - hBar2;

  // A section with no mass has no profile to push mass across: nothing
  // crosses until the first gram arrives (and then it arrives cold, so the
  // span it has to climb is the full one). The vanishing limit from the
  // other side is finite without any floor: Q1 carries the section's AREA,
  // which is proportional to its mass, so W12 = Q1/(2 d1) with both m1 and
  // d1 going to zero linearly together stays bounded - a slug boiling away
  // under a hot wall dies at a finite rate.
  const W12 = m1 > 0 ? Q1 / (2 * d1) : 0;
  const W23 = (Q2 - W12 * (hBar2 - sat.h_f)) / d2;

  // Subcooled section: the ordinary open-system balance. Feed enters at its
  // own enthalpy, mass leaves across the boundary at h_f, the wall adds Q1,
  // and the moving boundary does P dV work. Both the mass and the energy are
  // integrated, so every joule the slug reports came in through one of these
  // three terms and the leftovers cannot inherit energy the wall never
  // delivered. The feed enthalpy hIn prices only the mass entering NOW.
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

/**
 * The axial profile a solved partition implies, for pricing a draw from a
 * nozzle that is not at one of the tube's ends.
 *
 * The partition's closures already assume a profile in every section - they
 * only ever published its MEANS and its two ends:
 *
 *  - economizer: enthalpy linear in length up to the boundary state (the
 *    profile otsgRates crosses mass over: h_f - hBar1 is half its span);
 *  - boiling: quality linear in length from 0 to x2Out (boilingMeanVolume
 *    integrates exactly this);
 *  - superheat: the outlet's own march over the tube metal, point by point
 *    (ev.steamProfile) - saturated steam in, hSteamOut out, and in between
 *    the steam that march has at each height, so a nozzle part-way up draws
 *    what the metal below it has been charged for heating.
 *
 * A draw used to be priced by SECTION: every nozzle in the superheat section
 * took hSteamOut, the fully superheated outlet, and every nozzle in the
 * boiling section took the node's bulk. A leak nozzle part-way up the tube
 * therefore saw the enthalpy of its draw step by ~1,700 kJ/kg the instant
 * the top of the boiling section passed it, and since what it drew moved
 * that boundary back, the boundary parked on the nozzle and the draw flipped
 * every few steps - 20 MW in and out of a 10-litre valve body (Xe-100 tube
 * rupture, 12,000 rejected steps a minute). The profile is continuous
 * across both boundaries, so the draw now changes as the boundary sweeps
 * past instead of when.
 *
 * The economizer's profile is the one its own rate equations assume
 * (otsgRates: W12 = Q1 / (h_f - h_a) with h_a = 2 hBar - h_f): it reaches
 * saturated liquid at its top whenever the tube holds anything above it. A
 * tube that is one liquid (nothing above, no dome to partition across) has
 * no saturated boundary to climb to and is uniform at its mean. That is the
 * partition's own all-liquid seam, not a second one.
 */
export function otsgAxialProfile(ev: OtsgEval): OtsgAxialProfile {
  const { sat } = ev;
  const [s1, s2, s3] = ev.sections;
  // Boiling section. A flooded section that is subcooled on average
  // (hBar below h_f) does not boil at all: liquid at its mean.
  const boils = s2.hBar >= sat.h_f;
  const h2: [number, number] = boils
    ? [sat.h_f, sat.h_f + ev.x2Out * (sat.h_g - sat.h_f)]
    : [s2.hBar, s2.hBar];
  const v2: [number, number] = boils
    ? [sat.v_f, sat.v_f + ev.x2Out * (sat.v_g - sat.v_f)]
    : [s2.vBar, s2.vBar];
  // Economizer: symmetric about its mean, reaching the boundary state at
  // its top. The boundary state is the boiling section's inlet when there
  // is one, saturated liquid when the water flashes straight to steam.
  const partitioned = s2.mass + s3.mass > 0;
  const hTop = s2.mass > 0 ? h2[0] : sat.h_f;
  const vTop = s2.mass > 0 ? v2[0] : sat.v_f;
  const dh = partitioned ? hTop - s1.hBar : 0;
  // Specific volume log-linear between the same two states: positive
  // whatever the span, where the linear mirror 2 vBar - v_f goes negative
  // near the critical point.
  const dlnv = partitioned ? Math.log(vTop / s1.vBar) : 0;
  if (s1.mass > 0 && !Number.isFinite(dlnv)) {
    throw new Error(`[OTSG] economizer profile: specific volumes ${s1.vBar} (mean) and ` +
      `${vTop} (boundary) m3/kg give no profile at ${(ev.P / 1e5).toFixed(1)} bar.`);
  }
  const h1: [number, number] = s1.mass > 0 ? [s1.hBar - dh, s1.hBar + dh] : [hTop, hTop];
  const v1: [number, number] = s1.mass > 0
    ? [s1.vBar * Math.exp(-dlnv), s1.vBar * Math.exp(dlnv)] : [vTop, vTop];
  // Superheat: the march's own curve. With no superheat section the outlet
  // state stands in for a section of no length.
  const steam = ev.steamProfile
    ?? { s: [0, 1], h: [ev.hSteamOut, ev.hSteamOut], v: [ev.vSteamOut, ev.vSteamOut] };
  const n = steam.s.length - 1;
  return {
    h: [h1, h2, [steam.h[0], steam.h[n]]],
    v: [v1, v2, [steam.v[0], steam.v[n]]],
    steam,
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
