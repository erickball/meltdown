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
export function superheatedV(u: number, P: number, tolLn = 1e-10): number {
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
 * Sectioned evaluation AT a given pressure, with the WHOLE partition solved
 * from the node's own conserved totals - mass, energy and the tube volume.
 * Nothing about the partition is integrated any more.
 *
 * WHY NOTHING IS INTEGRATED. The tube side carries four descriptors - the
 * subcooled section, the boiling section's outlet quality, m3 and u3 -
 * against three totals, so closing the model needs exactly ONE piece of
 * information beyond the totals. Every attempt to carry that piece as
 * integrated state has failed the same way: an integrated m3 accumulated
 * interface fluxes with no idea what volume it had to fit (sections claiming
 * 2.6x the tube), and an integrated U1 found its own flux equilibrium with no
 * channel back to the totals, so the mismatch landed on the one unbounded
 * descriptor - the vapor - as steam far hotter than anything heating it
 * (329-bar leftovers inside a 160-bar node, sustained for hundreds of
 * seconds, was the measured failure).
 *
 * THE WALL IS THE MISSING CLOSURE. Thermodynamics cannot supply the fourth
 * equation - a tube of cold slug plus hot steam and a tube of lukewarm mush
 * have identical totals - but heat transfer can: at the quasi-steady state
 * the sections describe, the superheat section's temperature is set by its
 * own approach to its own wall,
 *
 *     T3 = T_sat + theta_mean * (T_wall3 - T_sat),
 *     theta_mean = hA3 / (2 W cp + hA3)
 *
 * (the mean-stream form of the same theta = 2NTU/(2+NTU) machinery the duty
 * calculation uses; theta_mean -> 1 for a stagnant section, which is the
 * standing-branch equilibrium, and -> 0 for a vanishing one, which is
 * saturation - the dryout state - so both limits are already the right
 * physics). With u3 pinned there, the three section masses solve LINEARLY
 * from mass, volume and energy, and no bookkeeping exists that could drift:
 * steam cannot leave hotter than its own metal, and every kilogram and joule
 * the partition claims is a kilogram and joule the node actually holds.
 *
 * The boundary's dynamics are not lost - they moved into the metal, whose
 * thermal inertia is real integrated state. A cold wall pins T3 at
 * saturation; as the metal soaks, the pin rises and the partition follows.
 *
 * THE LATTICE. The pinned solve can return a negative mass, and each sign
 * says exactly which section the totals cannot support; the regimes join
 * continuously at the zero crossings:
 *
 *   m3 < 0 - flooded. No room for dry steam: m3 = 0 and the boiling
 *       section's outlet quality joins the solve instead of u3. Volume AND
 *       energy both enforced (the pair is linear in (m2, m2*x2bar)). If even
 *       a zero-quality boiling section is too hot for the totals, the tube
 *       is one lump of subcooled liquid and the sections say so.
 *   m1 < 0 - no economizer. The totals cannot host a feed-profile slug at
 *       all (hot feed, or a tube gone mostly steam). The whole inventory is
 *       shared between boiling and vapor by the volume-and-energy rules
 *       below - restSplit - which is the old closure's leftover logic with
 *       nothing subtracted from it.
 *   m2 < 0 - no boiling section: a subcooled slug directly under steam
 *       hotter than the wall pin allows. Real for a while after a sudden
 *       depressurization (the vapor flashes hot while the slug lags), so u3
 *       unpins and solves from the totals with the economizer point as
 *       anchor; Q3 then runs backwards (steam heating its own wall), which
 *       is the physical channel that relaxes the state back into the
 *       lattice's interior. Bounded by the totals - there is no ledger to
 *       hold the state there.
 *
 * restSplit keeps the old three cases (flooded / dryout / superheat walk)
 * for the no-economizer inventory, including the walk-down root choice - see
 * its comment for why the FIRST bracket from the dryout end is the physical
 * root.
 */

/** How the superheat section's wall pins its temperature - see
 *  evaluateOtsgAtP. Built by the operator (and every diagnostic) from the
 *  bundle's own metal and flows via otsgWallPin in otsg-operator.ts. */
export interface OtsgWallPin {
  TWall3: number;   // K   - the superheat section's metal temperature
  hA3Full: number;  // W/K - steam-film conductance if section 3 owned the whole bundle
  WCp3: number;     // W/K - steam draw's carrying capacity (W_steam * cp)
}

export function evaluateOtsgAtP(
  massTotal: number,
  UTotal: number,
  P: number,
  uFeedIn: number,
  geom: OtsgGeometry,
  pin: OtsgWallPin,
): OtsgEval {
  const sat = saturationAtP(P);
  /**
   * The property surface, asked with this closure's name on it.
   *
   * The states probed here are TRIALS - a partition being searched for, not
   * a plant state - and a node whose totals are extreme (an RK stage mid-
   * rejection, a tube flashing empty) can push them off the surface. Left
   * bare that arrives as "[WaterProps] Temperature out of range" with
   * nothing to say which bundle asked or what it was trying; it reads as the
   * plant diverging while every node sits at a sane temperature.
   */
  const probe = (u: number, v: number, what: string) => {
    try {
      return calculateState(1, u, v);
    } catch (e) {
      throw new Error(
        `[OTSG] the ${what} the partition needs is off the property surface: ` +
        `${(u / 1e6).toFixed(1)} MJ/kg at ${v.toFixed(4)} m3/kg, ` +
        `${(P / 1e5).toFixed(1)} bar. The node holds ${massTotal.toFixed(0)} kg with ` +
        `${(UTotal / 1e9).toFixed(2)} GJ in ${geom.tubeVolume.toFixed(1)} m3. ` +
        `(${e instanceof Error ? e.message : String(e)})`);
    }
  };

  const V = geom.tubeVolume;
  const finish = (
    m1: number, u1: number, v1: number,
    m2: number, x2Out: number,
    m3: number, u3: number, v3: number,
    regime: OtsgEval['regime'],
  ): OtsgEval => {
    // One mean quality sets the boiling section's volume, energy and
    // enthalpy together, so they cannot disagree with each other.
    const x2Bar = boilingMeanQuality(sat.v_f, sat.v_g, x2Out);
    const v2 = sat.v_f + x2Bar * (sat.v_g - sat.v_f);

    const h1Bar = u1 + P * v1;
    const h2Bar = sat.h_f + x2Bar * (sat.h_g - sat.h_f);
    const h3Bar = u3 + P * v3;

    const T1 = m1 > 0 ? tempOfSubcooledU(Math.min(u1, sat.u_f)) : sat.T;
    // A dry-saturated vapor region is at T_sat by definition; genuine
    // superheat - and any supercritical fluid, which has no saturation
    // temperature to fall back on - needs the property surface.
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

    // The draw leaves from the section's OUTLET, not its mean - but the
    // outlet only sits at 2 h_bar - h_g (linear profile from an h_g inlet)
    // when a boiling section actually FEEDS this one at saturation. A tube
    // that is all steam has no such inlet - its profile starts at the feed -
    // and near the critical point that difference is ~1 MJ/kg, so the inlet
    // assumption fades with the boiling section's own presence (the same
    // asymptotic birth every section uses). An emptying superheat section
    // vanishes through saturation, where the outlet IS h_g - continuous by
    // construction.
    const w2 = m2 / (m2 + 1);
    const hSteamOut = m3 <= 0 ? sat.h_g
      : regime === 'supercritical' ? h3Bar
      : Math.max(sat.h_g, h3Bar + w2 * (h3Bar - sat.h_g));

    return {
      P, sat,
      sections: [
        mk(m1, v1, V1, h1Bar, T1),
        mk(m2, v2, V2, h2Bar, sat.T),
        mk(m3, v3, V3, h3Bar, T3),
      ],
      hSteamOut, u3, x2Out, regime,
    };
  };

  // Empty tube: nothing to partition. The first gram entering restores the
  // sections; every area is zero so every rate is too.
  if (!(massTotal > 0)) {
    return finish(0, sat.u_f, sat.v_f, 0, 1, 0, sat.u_g, sat.v_g, 'dryout');
  }

  // SUPERCRITICAL: there is no dome, so there is no phase boundary to
  // partition across. The tube is ONE fluid at its own (u, v); it appears as
  // the hot section so the gas march sees a single ramping pass, and the
  // cold/hot structure a supercritical boiler does have lives in the wall
  // temperatures, not in a phase split that no longer exists.
  if (P >= P_CRITICAL) {
    return finish(0, sat.u_f, sat.v_f, 0, 1,
      massTotal, UTotal / massTotal, V / massTotal, 'supercritical');
  }

  const u1 = subcooledSectionMean(uFeedIn, sat);
  const v1 = subcooledLiquidV(Math.min(u1, sat.u_f));

  // The boiling section as it runs whenever there IS something downstream:
  // quality 0 -> 1, mass-averaged over its linear profile.
  const vBarFull = boilingMeanVolume(sat.v_f, sat.v_g, 1);
  const x2BarFull = (vBarFull - sat.v_f) / (sat.v_g - sat.v_f);
  const u2Full = sat.u_f + x2BarFull * (sat.u_g - sat.u_f);

  // ----------------------------------------------------------------
  // The wall pin: the superheat section's (u3, v3) at its approach
  // temperature. theta depends on the section's area, which depends on the
  // masses being solved, so the two iterate to a joint fixed point - theta
  // is a mild function of L3 (hA/(2Wcp+hA)) and this converges in a few
  // rounds from any start.
  // ----------------------------------------------------------------
  const u3AtT = (Tt: number, uGuess: number): { u3: number; v3: number } => {
    // Bisection on u3 over the section temperature, which rises
    // monotonically with u3 along the isobar, finished with one linear
    // interpolation so the pin varies SMOOTHLY with its target - a bisection
    // cut off at a fixed width would quantize u3, and that noise would land
    // straight in the section masses the RK error controller watches. The
    // volume tolerance is loose (1e-4 in ln v): the masses close the volume
    // EXACTLY over whatever v3 this returns, so the tolerance shapes the pin
    // by hundredths of a kelvin, not the books by anything.
    const TOf = (u: number) => probe(u, superheatedV(u, P, 1e-4), 'pinned steam state').temperature;
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
        `(${(pin.TWall3 - 273.15).toFixed(0)} C) is not one a boiler tube survives.`);
    }
    for (let i = 0; i < 20; i++) {
      if (uHi - uLo < 5e3) break;
      const um = 0.5 * (uLo + uHi);
      const Tm = TOf(um);
      if (Tm < Tt) { uLo = um; TLo = Tm; } else { uHi = um; THi = Tm; }
    }
    const u3 = THi > TLo ? uLo + (uHi - uLo) * (Tt - TLo) / (THi - TLo) : uLo;
    return { u3, v3: superheatedV(u3, P, 1e-4) };
  };

  const solve3 = (u3: number, v3: number): [number, number, number] => {
    // Cramer on [1 1 1; v1 v2F v3; u1 u2F u3] [m1 m2 m3]' = [m V U]'
    const det =
      (vBarFull * u3 - v3 * u2Full)
      - (v1 * u3 - v3 * u1)
      + (v1 * u2Full - vBarFull * u1);
    const d1 = massTotal * (vBarFull * u3 - v3 * u2Full) - (V * u3 - v3 * UTotal) + (V * u2Full - vBarFull * UTotal);
    const d2 = (V * u3 - v3 * UTotal) - massTotal * (v1 * u3 - v3 * u1) + (v1 * UTotal - V * u1);
    const d3 = (vBarFull * UTotal - V * u2Full) - (v1 * UTotal - V * u1) + massTotal * (v1 * u2Full - vBarFull * u1);
    const out: [number, number, number] = [d1 / det, d2 / det, d3 / det];
    if (!out.every(Number.isFinite)) {
      throw new Error(`[OTSG] the pinned partition solve is degenerate: section states ` +
        `(${(u1 / 1e3).toFixed(0)}, ${(u2Full / 1e3).toFixed(0)}, ${(u3 / 1e3).toFixed(0)}) kJ/kg ` +
        `at ${(P / 1e5).toFixed(2)} bar are collinear in (u, v). ` +
        `m=${massTotal.toFixed(1)} kg, V=${V.toFixed(3)} m3, U=${(UTotal / 1e9).toFixed(3)} GJ.`);
    }
    return out;
  };

  let u3 = sat.u_g, v3 = sat.v_g;
  let T3target = sat.T;
  let m1 = 0, m2 = 0, m3 = 0;
  let L3 = Math.max(0, Math.min(1, (V - massTotal * sat.v_f) / V));
  for (let iter = 0; iter < 6; iter++) {
    const hA3 = pin.hA3Full * L3;
    const thetaMean = hA3 > 0 ? hA3 / (2 * pin.WCp3 + hA3) : 0;
    T3target = sat.T + thetaMean * Math.max(0, pin.TWall3 - sat.T);
    if (T3target > sat.T + 0.1) {
      ({ u3, v3 } = u3AtT(T3target, u3 > sat.u_g ? u3 : sat.u_g + 2500 * (T3target - sat.T)));
    } else {
      u3 = sat.u_g; v3 = sat.v_g;
    }
    [m1, m2, m3] = solve3(u3, v3);
    const L3New = Math.max(0, Math.min(1, (m3 * v3) / V));
    const done = Math.abs(L3New - L3) < 1e-3;
    L3 = L3New;
    if (done) break;
  }

  if (m1 >= 0 && m2 >= 0 && m3 >= 0) {
    return finish(m1, u1, v1, m2, 1, m3, u3, v3,
      T3target > sat.T + 0.1 ? 'superheat' : 'dryout');
  }

  // ----------------------------------------------------------------
  // restSplit: share an inventory (mR, VR, UR) between a boiling section and
  // a vapor region with NO subcooled slug - the old closure's leftover
  // logic, applied to whatever the branches below hand it.
  // ----------------------------------------------------------------
  const restSplit = (mR: number, VR: number, UR: number): OtsgEval => {
    const vRest = VR / mR;
    if (vRest <= vBarFull) {
      // (A) Flooded: no room for dry steam; the boiling section is the whole
      // inventory and ends wherever the volume says it does. On a two-phase
      // node this is exact in energy too - the totals sit on the tie line.
      const x2Out = boilingOutletQuality(sat.v_f, sat.v_g, vRest);
      return finish(0, u1, v1, mR, x2Out, 0, sat.u_g, sat.v_g, 'flooded');
    }
    // Energy above an all-boiling description of this inventory pays for
    // vapor at (u_g - u2Full) a kilogram; the volume says how much vapor
    // there is room for.
    const E = UR - mR * u2Full;
    const m3Sat = Math.min(mR, Math.max(0, E / (sat.u_g - u2Full)));
    const m3Vol = (VR - mR * vBarFull) / (sat.v_g - vBarFull);
    const unrepresentable = (why: string) => new Error(
      `[OTSG] the inventory cannot be a boiling section plus dry steam at ` +
      `${(P / 1e5).toFixed(2)} bar: ${mR.toFixed(1)} kg carrying ` +
      `${(UR / mR / 1e3).toFixed(0)} kJ/kg in ${VR.toFixed(3)} m3 ` +
      `(v=${(VR / mR).toFixed(4)} m3/kg, needing ${m3Vol.toFixed(1)} kg of vapor to fill it). ` +
      `${why} The node's totals and its pressure disagree about what phase it is in.`);
    if (m3Vol <= m3Sat) {
      // (T) Dryout: the volume fills before the energy runs out; the vapor
      // region sits at saturation and its mass is the volume's to set.
      return finish(0, u1, v1, mR - m3Vol, 1, m3Vol, sat.u_g, sat.v_g, 'dryout');
    }
    if (!(E > 0)) {
      throw unrepresentable(`It carries less than the ${(u2Full / 1e3).toFixed(0)} kJ/kg a ` +
        `boiling section alone would hold, so no vapor region can be paid for.`);
    }
    // (B) Superheat with the boiling profile as anchor: m3 and u3 from
    // volume + energy, the state required to evaluate at P. Walk DOWN from
    // the dryout end and take the FIRST bracket: further down there is a
    // second, arithmetic root - a sliver of absurdly hot steam over boiling
    // water - that is not continuous with the dryout case next door.
    const res = walkSuperheat(mR, VR, UR, u2Full, vBarFull, m3Sat);
    return finish(0, u1, v1, mR - res.m3, 1, res.m3, res.u3, res.v3, 'superheat');
  };

  const walkSuperheat = (
    mR: number, VR: number, UR: number,
    uAnchor: number, vAnchor: number, m3Start: number,
  ): { m3: number; u3: number; v3: number } => {
    const residual = (mm: number) => {
      const uu = uAnchor + (UR - mR * uAnchor) / mm;
      const vv = (VR - (mR - mm) * vAnchor) / mm;
      return probe(uu, vv, 'dry-steam state').pressure - P;
    };
    // Property-surface noise scale: at the dryout join the root sits exactly
    // ON m3Start, where the residual is a difference of two evaluations of
    // the same state.
    const rTol = 1e-6 * P;
    let hi = m3Start;
    const rHi = residual(hi);
    if (rHi >= -rTol) {
      // The upper end IS the answer: the whole inventory is vapor (nothing
      // left to boil) or it sits on the dryout boundary.
      const m3 = m3Start;
      const u3w = uAnchor + (UR - mR * uAnchor) / m3;
      return { m3, u3: u3w, v3: (VR - (mR - m3) * vAnchor) / m3 };
    }
    const E = UR - mR * uAnchor;
    const m3Floor = E / (U3_CEILING - uAnchor);
    let lo = hi, rLo = rHi;
    while (rLo < 0 && lo > m3Floor) {
      hi = lo;
      lo = Math.max(m3Floor, 0.5 * lo);
      rLo = residual(lo);
    }
    if (!(rLo > 0)) {
      throw new Error(
        `[OTSG] the inventory cannot be vapor over its anchor at ${(P / 1e5).toFixed(2)} bar: ` +
        `${mR.toFixed(1)} kg carrying ${(UR / mR / 1e3).toFixed(0)} kJ/kg in ${VR.toFixed(3)} m3 - ` +
        `filling the volume would need steam beyond ${(U3_CEILING / 1e6).toFixed(1)} MJ/kg, ` +
        `which still lands at ${((rLo + P) / 1e5).toFixed(2)} bar. ` +
        `The node's totals and its pressure disagree about what phase it is in.`);
    }
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      if (residual(mid) > 0) lo = mid; else hi = mid;
      if (hi - lo < 1e-12 * m3Start) break;
    }
    const m3 = 0.5 * (lo + hi);
    return {
      m3,
      u3: uAnchor + (UR - mR * uAnchor) / m3,
      v3: (VR - (mR - m3) * vAnchor) / m3,
    };
  };

  if (m1 < 0) {
    // No economizer: the totals cannot host a feed-profile slug at all.
    return restSplit(massTotal, V, UTotal);
  }

  if (m3 < 0) {
    // Flooded, with the economizer in the solve: m3 = 0 and the boiling
    // section's outlet quality replaces u3 as the third unknown. Both
    // remaining equations are linear in (a, b) = (m2, m2 * x2bar):
    //   a (v_f - v1) + b (v_g - v_f) = V - m v1
    //   a (u_f - u1) + b (u_g - u_f) = U - m u1
    const a11 = sat.v_f - v1, a12 = sat.v_g - sat.v_f, r1 = V - massTotal * v1;
    const a21 = sat.u_f - u1, a22 = sat.u_g - sat.u_f, r2 = UTotal - massTotal * u1;
    const det = a11 * a22 - a12 * a21;
    const a = (r1 * a22 - a12 * r2) / det;
    const b = (a11 * r2 - r1 * a21) / det;
    if (a > massTotal) {
      // Even a zero-mass economizer leaves the tube too voluminous for its
      // energy as boiling water - the no-economizer split owns this.
      return restSplit(massTotal, V, UTotal);
    }
    if (b < 0 || a <= 0) {
      // Colder than a zero-quality boiling section could make it: the tube
      // is ONE lump of subcooled liquid, and the sections say exactly that -
      // its own (u, v), no profile claim. The property surface must agree it
      // IS liquid: totals that route here without being liquid are a
      // totals-vs-pressure disagreement, and inventing a liquid section from
      // them would hide it.
      const lump = probe(UTotal / massTotal, V / massTotal, 'all-liquid lump');
      if (lump.phase !== 'liquid') {
        throw new Error(`[OTSG] the inventory is colder than boiling water yet is not ` +
          `liquid: ${massTotal.toFixed(1)} kg carrying ` +
          `${(UTotal / massTotal / 1e3).toFixed(0)} kJ/kg in ${V.toFixed(3)} m3 reads as ` +
          `'${lump.phase}' at ${(lump.pressure / 1e5).toFixed(2)} bar, against the ` +
          `${(P / 1e5).toFixed(2)} bar it was partitioned at. ` +
          `The node's totals and its pressure disagree about what phase it is in.`);
      }
      return finish(massTotal, UTotal / massTotal, V / massTotal, 0, 0, 0, sat.u_g, sat.v_g, 'flooded');
    }
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error(`[OTSG] the flooded partition solve is degenerate at ` +
        `${(P / 1e5).toFixed(2)} bar: m=${massTotal.toFixed(1)} kg, V=${V.toFixed(3)} m3, ` +
        `U=${(UTotal / 1e9).toFixed(3)} GJ.`);
    }
    const x2Bar = b / a;
    const x2BarMax = boilingMeanQuality(sat.v_f, sat.v_g, 1);
    // The pinned solve said m3 < 0, so the flooded quality must land at or
    // below the full profile; the band above it is the seam's own numeric
    // width (the pin iterates to ~1e-3 in L3), anything past that is a hole.
    if (x2Bar > x2BarMax * (1 + 1e-3)) {
      throw new Error(`[OTSG] flooded solve wants mean quality ${x2Bar.toFixed(3)} beyond the ` +
        `full profile's ${x2BarMax.toFixed(3)} while the pinned solve refused a vapor region - ` +
        `these cannot both be true, so the closure's regime lattice has a hole. ` +
        `m=${massTotal.toFixed(1)} kg, V=${V.toFixed(3)} m3, U=${(UTotal / 1e9).toFixed(3)} GJ, ` +
        `P=${(P / 1e5).toFixed(2)} bar.`);
    }
    // Invert the mass-mean quality for the outlet quality (monotone, no
    // property calls).
    let xLo = 0, xHi = 1;
    for (let i = 0; i < 50; i++) {
      const xm = 0.5 * (xLo + xHi);
      if (boilingMeanQuality(sat.v_f, sat.v_g, xm) < x2Bar) xLo = xm; else xHi = xm;
      if (xHi - xLo < 1e-12) break;
    }
    return finish(massTotal - a, u1, v1, a, 0.5 * (xLo + xHi), 0, sat.u_g, sat.v_g, 'flooded');
  }

  // m2 < 0: a subcooled slug directly under steam hotter than the wall pin
  // allows - the post-depressurization transient. u3 unpins and solves from
  // the totals with the economizer point as anchor; the walk's domain edge
  // (all vapor, nothing subcooled) hands over to the no-economizer split.
  {
    const m3g = (UTotal - massTotal * u1) / (sat.u_g - u1);
    const m3Start = Math.min(massTotal, Math.max(0, m3g));
    if (!(m3Start > 0)) {
      // No energy for any vapor over a subcooled slug - the pinned solve's
      // m2 < 0 must then have been the flooded side's business.
      return restSplit(massTotal, V, UTotal);
    }
    const res = walkSuperheat(massTotal, V, UTotal, u1, v1, m3Start);
    return finish(massTotal - res.m3, u1, v1, 0, 1, res.m3, res.u3, res.v3, 'superheat');
  }
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
