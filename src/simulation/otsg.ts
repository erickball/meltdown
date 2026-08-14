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
 * STATE (integrated by the caller): section masses m1, m2, m3 and the
 * superheat section energy U3. Everything else is DERIVED here:
 *  - the subcooled and two-phase section mean states come from linear
 *    profile assumptions (mean enthalpy midway between the section's inlet
 *    and its saturation boundary; mean quality 1/2) - the standard
 *    moving-boundary closure;
 *  - pressure comes from the volume constraint sum(m_i v_i) = V_tube;
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

export function saturationAtP(P: number): SaturationProps {
  const T = saturationTemperature(P);
  const u_f = saturatedLiquidEnergy(T);
  const u_g = saturatedVaporEnergy(T);
  const v_f = 1 / saturatedLiquidDensity(T);
  const v_g = 1 / saturatedVaporDensity(T);
  return { P, T, u_f, u_g, v_f, v_g, h_f: u_f + P * v_f, h_g: u_g + P * v_g };
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
    const v2 = 0.5 * (sat.v_f + sat.v_g);           // linear quality, x-bar = 1/2
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
  const h2Bar = 0.5 * (sat.h_f + sat.h_g);
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
  };
}

/**
 * Sectioned evaluation AT a given pressure, with the superheat energy
 * DERIVED from the node's conserved totals: U3 = U_total - m1 u1bar - m2
 * u2bar. This is the runtime form: the ordinary (u,v) machinery owns the
 * node's pressure dynamics (proven robust), and the sections are evaluated
 * at that pressure for heat transfer, draw enthalpy, and partition motion.
 * Section geometry normalizes over the sections' own summed volume, so the
 * small inconsistency between bulk pressure and the strict volume closure
 * shows up only as a few-percent length rescale, not as a failure mode.
 * (The strict closure - evaluateOtsg above - remains the reference form and
 * the v2 upgrade path; see design doc section 3.)
 */
export function evaluateOtsgAtP(
  m1: number,
  m3: number,
  massTotal: number,
  UTotal: number,
  P: number,
  uFeedIn: number,
  geom: OtsgGeometry,
): OtsgEval {
  if (!(m1 >= 0 && m3 >= 0)) {
    throw new Error(`[OTSG] negative partition mass: m1=${m1}, m3=${m3} kg`);
  }
  const m2 = massTotal - m1 - m3;
  if (m2 < -1e-9 * Math.max(1, massTotal)) {
    throw new Error(`[OTSG] partition exceeds inventory: m1=${m1.toFixed(2)} + m3=${m3.toFixed(2)} ` +
      `> total=${massTotal.toFixed(2)} kg. The partition rates have outrun the totals.`);
  }
  const m2c = Math.max(0, m2);

  const sat = saturationAtP(P);
  // The subcooled profile closure divides by (h_f - hBar1) in the interface
  // flux, so its parameter must stay inside the closure's valid domain: cap
  // the effective feed energy ~25 kJ/kg (~6 K) below saturation. This is a
  // width WITHIN an assumed profile shape - the same standing the melt
  // logistic's width has - not a clamp on any conserved quantity: when the
  // real feed runs hotter (a heat-soaked feed line during a pressure
  // transient), the section simply drains via the now-large W12, which is
  // the physically right outcome for saturated feed.
  const uFeedEff = Math.min(uFeedIn, sat.u_f - 25e3);
  const u1Bar = 0.5 * (uFeedEff + sat.u_f);
  const u2Bar = 0.5 * (sat.u_f + sat.u_g);
  const v1 = m1 > 0 ? subcooledLiquidV(u1Bar) : sat.v_f;
  const v2 = 0.5 * (sat.v_f + sat.v_g);

  // Superheat energy from the conserved totals. Numerically this is a small
  // difference of large numbers as m3 -> 0; the h_g floor below absorbs the
  // residue (a superheat section can never sit below saturated vapor).
  const U3 = UTotal - m1 * u1Bar - m2c * u2Bar;
  const u3 = m3 > 0 ? Math.max(U3 / m3, sat.u_g + 1e3) : sat.u_g;
  const v3 = m3 > 0 ? superheatedV(u3, P) : sat.v_g;

  const h1Bar = u1Bar + P * v1;
  const h2Bar = 0.5 * (sat.h_f + sat.h_g);
  const h3Bar = u3 + P * v3;

  const T1 = m1 > 0 ? tempOfSubcooledU(u1Bar) : sat.T;
  const T3 = m3 > 0 ? calculateState(1, u3, v3).temperature : sat.T;

  const V1 = m1 * v1, V2 = m2c * v2, V3 = m3 * v3;
  const VT = Math.max(1e-12, V1 + V2 + V3);
  const mk = (mass: number, vBar: number, V: number, hBar: number, T: number): OtsgSectionEval => ({
    mass, vBar, volume: V,
    lengthFrac: V / VT,
    area: geom.heatArea * (V / VT),
    hBar, T,
  });

  const w = m3 / (m3 + 1);
  const hSteamOut = w * h3Bar + (1 - w) * sat.h_g;

  return {
    P, sat,
    sections: [
      mk(m1, v1, V1, h1Bar, T1),
      mk(m2c, v2, V2, h2Bar, sat.T),
      mk(m3, v3, V3, h3Bar, T3),
    ],
    hSteamOut,
    u3,
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

  // Superheat section: free energy state, ordinary open-system balance.
  // Outflow leaves at the section's own enthalpy (or its h_g nascent state
  // when empty - ev.hSteamOut blends the two).
  const dm3 = W23 - WOut;
  const dU3 = W23 * sat.h_g - WOut * ev.hSteamOut + Q3
    - ev.P * (dm3 * ev.sections[2].vBar);

  return {
    dm1: WIn - W12,
    dm2: W12 - W23,
    dm3,
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
