/**
 * Probe the DILUTE side of the steam table: water vapour thinner than the
 * (u, v) grid's last column (v = 210 m3/kg). This is where trace moisture in
 * a helium or air node lives - grams of steam in a 60 bar gas loop sit at
 * v = 1e3..1e8 m3/kg - and calculateState prices it on its 'vapor_ideal_gas'
 * path, not from the grid.
 *
 * Out here steam IS an ideal gas (Z differs from 1 by 2.5e-4 at v = 210 and
 * 315 K, less everywhere hotter or thinner), so the truth is simple: T is a
 * function of u alone, and P = R T / v. The reference is the ideal-gas part
 * of IAPWS-95 (Wagner & Pruss 2002, Table 6.1), implemented below; checked
 * against the python `iapws` package (IAPWS95(T=, rho=)), it reproduces the
 * full equation to 0.008 kJ/kg at v = 1e4 and to 0.46 kJ/kg (0.33 K) at the
 * worst corner it is used at here, v = 210 at the triple-point temperature.
 *
 * Checks:
 *  1. ACCURACY - (T, v) -> reference u -> calculateState must return T and
 *     P = R T / v, from the triple point to the table's hot limit (2000 C),
 *     for v = 211 .. 1e8 m3/kg. Below the triple point the model carries a
 *     flat cv (cvVaporCold: the slope of the chord just above the triple
 *     point, shared with the vapour-over-ice line so the two meet exactly);
 *     it is 1% above the ideal-gas value, which adds up to 1.7 K by 180 K.
 *  2. SEAM - T and P*v at fixed u, either side of the grid's last column.
 *  3. ONE SURFACE - T rises with u at fixed v at a steam-like rate, from the
 *     coldest vapour to past the table's hot limit, including the hand-over
 *     to the hot-edge extension (v up to ~264 m3/kg above 2000 C).
 *  4. FROST LINE - just above the vapour-over-ice line the vapour must come
 *     out at the line's own T and P_sub(T).
 *  5. CENSUS - which (u, v) reach the dilute path at all, in particular
 *     whether anything INSIDE the grid's v range (v < 210) still does.
 *  6. IC ROUND TRIP - (T, P) -> (u, v) by superheatedFromTP -> T, P.
 *
 * Usage: npx tsx scripts/probe-dilute-steam.ts
 * Exits non-zero if any check is out of tolerance.
 */

import * as Water from '../src/simulation/water-properties-v4';
import { superheatedFromTP } from '../src/simulation/water-inverse';

await Water.preloadWaterProperties();

// The sweeps cross the table's hot limit on purpose; count the notices
// instead of printing them.
let notices = 0;
const warn = console.warn;
console.warn = (...a: unknown[]) => {
  if (/beyond (the )?steam-table/.test(String(a[0]))) notices++;
  else warn(...a);
};

let failed = false;
const fail = (msg: string) => { failed = true; console.log(`  FAIL: ${msg}`); };

// ---------------------------------------------------------------------------
// Reference: ideal-gas part of IAPWS-95. u0/(R T) = tau * dphi0/dtau.
// ---------------------------------------------------------------------------
const R95 = 461.51805, TC95 = 647.096;
const N2 = 6.6832105268, N3 = 3.00632;
const NI = [0.012436, 0.97315, 1.27950, 0.96956, 0.24873];
const GI = [1.28728967, 3.53734222, 7.74073708, 9.24437796, 27.5075105];
function u0(T: number): number {
  const tau = TC95 / T;
  let s = N2 * tau + N3;
  for (let i = 0; i < 5; i++) s += NI[i] * GI[i] * tau * (1 / (1 - Math.exp(-GI[i] * tau)) - 1);
  return R95 * T * s;
}
function cv0(T: number): number {
  const tau = TC95 / T;
  let s = N3;
  for (let i = 0; i < 5; i++) {
    const x = GI[i] * tau, e = Math.exp(-x);
    s += NI[i] * x * x * e / ((1 - e) * (1 - e));
  }
  return R95 * s;
}
const T_TRIPLE = 273.16;
const equilibriumPressure = (T: number) =>
  T < T_TRIPLE ? Water.sublimationPressure(T) : Water.saturationPressure(T);

const state = (u: number, v: number) => {
  const s = Water.calculateState(1, u, v);
  return { T: s.temperature, P: s.pressure, phase: s.phase, ice: s.iceFraction, path: Water.DEBUG_getLastCalculationPath() };
};

// ---------------------------------------------------------------------------
// 1. Accuracy
// ---------------------------------------------------------------------------
console.log('1. Accuracy against the IAPWS-95 ideal gas (worst over v = 211 .. 1e8 m3/kg)');
console.log('     T(K)    T(C)   cv0(J/kg-K)   T err (K)    P err (%)   states');
const VS = [211, 300, 1e3, 1e4, 1e6, 1e8];
const TS = [160, 180, 200, 220, 240, 260, 273.2, 280, 300, 315, 350, 400, 500, 600, 700, 800,
  923.15, 1023.15, 1123.15, 1203.15, 1400, 1600, 1800, 2000, 2200, 2273];
const TOL_T_HOT = 0.5, TOL_P_HOT = 1e-3;      // at and above the triple point
const TOL_T_COLD = 2.5, TOL_P_COLD = 0.015;   // below it: the flat-cv frost model
let worstHotT = 0, worstHotP = 0, worstColdT = 0, worstColdP = 0;
for (const T of TS) {
  let wT = 0, wP = 0, n = 0;
  for (const v of VS) {
    const P_ref = R95 * T / v;
    if (P_ref >= equilibriumPressure(T)) continue;   // condensed at this (T, v): not a vapour
    let s;
    try { s = state(u0(T), v); } catch (e) {
      fail(`THROW at T=${T} K, v=${v}: ${String((e as Error).message).slice(0, 140)}`);
      continue;
    }
    if (s.phase !== 'vapor' || s.ice > 0) {
      // The model's own equilibrium line is slightly off the reference's
      // below the triple point (flat cv); a state it calls frost is not a
      // dilute-vapour accuracy sample.
      continue;
    }
    n++;
    const dT = s.T - T, dP = s.P / P_ref - 1;
    if (Math.abs(dT) > Math.abs(wT)) wT = dT;
    if (Math.abs(dP) > Math.abs(wP)) wP = dP;
  }
  if (n === 0) continue;
  const cold = T < T_TRIPLE;
  if (cold) { worstColdT = Math.max(worstColdT, Math.abs(wT)); worstColdP = Math.max(worstColdP, Math.abs(wP)); }
  else { worstHotT = Math.max(worstHotT, Math.abs(wT)); worstHotP = Math.max(worstHotP, Math.abs(wP)); }
  const bad = Math.abs(wT) > (cold ? TOL_T_COLD : TOL_T_HOT) || Math.abs(wP) > (cold ? TOL_P_COLD : TOL_P_HOT);
  if (bad) failed = true;
  console.log(
    `  ${T.toFixed(2).padStart(8)} ${(T - 273.15).toFixed(0).padStart(6)} ${cv0(T).toFixed(0).padStart(10)} ` +
    `${wT.toFixed(3).padStart(13)} ${(wP * 100).toFixed(4).padStart(12)} ${String(n).padStart(6)}` +
    `${bad ? '   <-- OUT OF TOLERANCE' : ''}`
  );
}
console.log(`  worst at/above the triple point: ${worstHotT.toFixed(3)} K, ${(worstHotP * 100).toFixed(4)} %` +
  `   (tolerance ${TOL_T_HOT} K, ${TOL_P_HOT * 100} %)`);
console.log(`  worst below the triple point:    ${worstColdT.toFixed(3)} K, ${(worstColdP * 100).toFixed(4)} %` +
  `   (tolerance ${TOL_T_COLD} K, ${TOL_P_COLD * 100} %)`);

// ---------------------------------------------------------------------------
// 2. Seam at the grid's last column
// ---------------------------------------------------------------------------
console.log('\n2. Seam at the grid\'s dilute edge: fixed u, v = 209.9 (grid) vs 210.1 (dilute path)');
console.log('   u(kJ/kg)   T grid(K)   T dilute(K)    jump T(K)   jump P*v (%)   paths');
// What is left is the grid's local fit against the column's chords: 0.02 K
// and 0.1% in P*v, worst in the 20 kJ/kg under the column's first row, where
// the grid is extrapolating toward the triple point. (Before
// build-uv-grid-v13-dilute-patch.py restored the column's absent rows the
// grid side rippled by +-0.25% in P below u = 2700 kJ/kg.)
const TOL_SEAM_T = 0.05, TOL_SEAM_PV = 1.5e-3;
let worstSeamT = 0, worstSeamPv = 0, worstSeamU = 0, floorRefusals = 0;
const seamRows: string[] = [];
for (let u = 2376e3; u <= 6600e3; u += 5e3) {
  let a, b;
  try { a = state(u, 209.9); } catch (e) {
    // Known hole, not this probe's subject: between the triple-point vapour
    // (v = 206) and the last column (v = 210), vapour colder than ~278 K has
    // P < 611.657 Pa, and the grid path's pressure floor refuses it.
    if (String((e as Error).message).includes('Pressure out of range')) floorRefusals++;
    else fail(`THROW on the grid side, u=${u / 1e3}: ${String((e as Error).message).slice(0, 140)}`);
    continue;
  }
  try { b = state(u, 210.1); } catch (e) {
    fail(`THROW on the dilute side, u=${u / 1e3}: ${String((e as Error).message).slice(0, 140)}`);
    continue;
  }
  const dT = b.T - a.T;
  const dPv = (b.P * 210.1) / (a.P * 209.9) - 1;
  if (Math.abs(dT) > worstSeamT) { worstSeamT = Math.abs(dT); worstSeamU = u; }
  worstSeamPv = Math.max(worstSeamPv, Math.abs(dPv));
  if ((u / 1e3 - 2376) % 400 === 0 || (u < 2700e3 && (u / 1e3 - 2376) % 50 === 0)) {
    seamRows.push(
      `  ${(u / 1e3).toFixed(0).padStart(8)} ${a.T.toFixed(2).padStart(11)} ${b.T.toFixed(2).padStart(13)} ` +
      `${dT.toFixed(3).padStart(12)} ${(dPv * 100).toFixed(4).padStart(13)}   ${a.path} | ${b.path}`
    );
  }
}
seamRows.forEach(r => console.log(r));
console.log(`  worst jump: ${worstSeamT.toFixed(3)} K (at u=${(worstSeamU / 1e3).toFixed(0)} kJ/kg), ` +
  `${(worstSeamPv * 100).toFixed(4)} % in P*v   (tolerance ${TOL_SEAM_T} K, ${TOL_SEAM_PV * 100} %)`);
if (floorRefusals > 0) {
  console.log(`  (${floorRefusals} state(s) at v = 209.9 refused by the grid path's 611 Pa pressure floor - ` +
    `a known hole for v = 206..210 below ~278 K)`);
}
if (worstSeamT > TOL_SEAM_T || worstSeamPv > TOL_SEAM_PV) fail('seam out of tolerance');

// Second seam: above the table's hot limit the hot-edge extension owns
// v up to one grid cell past the last column (~264 m3/kg); beyond that the
// dilute path continues. Same u either side of the hand-over.
{
  let wT = 0, wPv = 0;
  for (let u = 6320e3; u <= 7000e3; u += 20e3) {
    for (const [vA, vB] of [[264.0, 264.8], [209.9, 210.1]]) {
      const a = state(u, vA), b = state(u, vB);
      wT = Math.max(wT, Math.abs(b.T - a.T));
      wPv = Math.max(wPv, Math.abs((b.P * vB) / (a.P * vA) - 1));
    }
  }
  console.log(`  above 2000 C (hot-edge extension | dilute path, v = 210 and ~264): worst jump ` +
    `${wT.toFixed(4)} K, ${(wPv * 100).toFixed(5)} % in P*v`);
  if (wT > TOL_SEAM_T || wPv > TOL_SEAM_PV) fail('hot hand-over out of tolerance');
}

// ---------------------------------------------------------------------------
// 3. One surface: T(u) rising, at a steam-like rate
// ---------------------------------------------------------------------------
console.log('\n3. T(u) at fixed v: from the coldest vapour to 7000 kJ/kg, step 2 kJ/kg');
console.log('    v(m3/kg)   states   min dT/du   max dT/du  (K per kJ/kg)   largest slope step');
// 1/cv: 0.72 at 1390 J/kg-K (cold) down to 0.39 at 2550 (2400 C).
const SLOPE_MIN = 0.37, SLOPE_MAX = 0.75;
const DU = 2e3;
for (const v of [210.5, 240, 264.5, 300, 1e3, 1e4, 1e6, 1e8]) {
  let prevT: number | null = null, prevSlope: number | null = null;
  let n = 0, sMin = Infinity, sMax = -Infinity, kink = 0, kinkU = 0;
  for (let u = 2150e3; u <= 7000e3; u += DU) {
    let s;
    try { s = state(u, v); } catch { prevT = null; prevSlope = null; continue; }   // below the frost line's reach
    if (s.phase !== 'vapor' || s.ice > 0) { prevT = null; prevSlope = null; continue; }
    n++;
    if (prevT !== null) {
      const slope = (s.T - prevT) / (DU / 1e3);
      sMin = Math.min(sMin, slope); sMax = Math.max(sMax, slope);
      if (prevSlope !== null && Math.abs(slope - prevSlope) > kink) { kink = Math.abs(slope - prevSlope); kinkU = u; }
      prevSlope = slope;
    }
    prevT = s.T;
  }
  const bad = !(sMin >= SLOPE_MIN && sMax <= SLOPE_MAX);
  if (bad) failed = true;
  console.log(
    `  ${v.toPrecision(4).padStart(10)} ${String(n).padStart(8)} ${sMin.toFixed(4).padStart(11)} ${sMax.toFixed(4).padStart(11)}` +
    `${' '.repeat(18)}${kink.toFixed(4)} at u=${(kinkU / 1e3).toFixed(0)}${bad ? '   <-- NOT STEAM-LIKE' : ''}`
  );
}

// ---------------------------------------------------------------------------
// 4. Frost line: vapour just above the vapour-over-ice line
// ---------------------------------------------------------------------------
console.log('\n4. Vapour just above the frost line (bisected in u at fixed v) vs the line itself');
console.log('    v(m3/kg)    T(K)      P(Pa)       P_sub(T)(Pa)    P/P_sub - 1');
for (const v of [1e3, 1e4, 1e6, 1e8]) {
  // Lowest u that is still a single-phase vapour
  let lo = 2150e3, hi = 2380e3;
  const isVapour = (u: number) => {
    try { const s = state(u, v); return s.phase === 'vapor' && s.ice === 0; } catch { return false; }
  };
  if (!isVapour(hi) || isVapour(lo)) { fail(`cannot bracket the frost line at v=${v}`); continue; }
  for (let i = 0; i < 60; i++) { const m = 0.5 * (lo + hi); if (isVapour(m)) hi = m; else lo = m; }
  const s = state(hi, v);
  const rel = s.P / Water.sublimationPressure(s.T) - 1;
  // 1e-3: the frost classifier's own bisection leaves 2e-4 at v = 1e8.
  const bad = Math.abs(rel) > 1e-3;
  if (bad) failed = true;
  console.log(
    `  ${v.toExponential(0).padStart(9)} ${s.T.toFixed(3).padStart(9)} ${s.P.toExponential(5).padStart(13)} ` +
    `${Water.sublimationPressure(s.T).toExponential(5).padStart(14)} ${rel.toExponential(2).padStart(13)}` +
    `${bad ? '   <-- OFF THE LINE' : ''}`
  );
}

// ---------------------------------------------------------------------------
// 5. Census: who reaches the dilute path
// ---------------------------------------------------------------------------
console.log('\n5. Census of calculation paths, v = 100 .. 1e8 m3/kg, u = 2300 .. 6600 kJ/kg');
{
  const inside = new Map<string, number>();   // v < 210: inside the grid's v range
  const outside = new Map<string, number>();
  const insideDilute: string[] = [];
  let throws = 0;
  for (let logV = 2.0; logV <= 8.0; logV += 0.004) {
    const v = Math.pow(10, logV);
    for (let u = 2300e3; u <= 6600e3; u += 10e3) {
      let s;
      try { s = state(u, v); } catch { throws++; continue; }
      const key = s.phase === 'vapor' && s.ice === 0 ? s.path : `(${s.phase}${s.ice > 0 ? ', frost' : ''})`;
      const m = v < 210 ? inside : outside;
      m.set(key, (m.get(key) ?? 0) + 1);
      if (v < 210 && key === 'vapor_ideal_gas' && insideDilute.length < 8) {
        insideDilute.push(`v=${v.toFixed(2)} u=${u / 1e3} -> T=${s.T.toFixed(2)} K`);
      }
    }
  }
  const show = (m: Map<string, number>) => [...m.entries()].map(([k, n]) => `${k}: ${n}`).join(', ');
  console.log(`  v < 210 (grid's range):  ${show(inside)}`);
  console.log(`  v >= 210:                ${show(outside)}`);
  console.log(`  throws: ${throws}`);
  if (insideDilute.length > 0) {
    console.log(`  dilute path reached INSIDE the grid's v range, e.g.:`);
    insideDilute.forEach(l => console.log(`    ${l}`));
  }
}

// ---------------------------------------------------------------------------
// 6. Initial-condition round trip
// ---------------------------------------------------------------------------
console.log('\n6. IC round trip: (T, P) -> superheatedFromTP -> calculateState');
console.log('     T(K)      P(Pa)       v(m3/kg)     T err (K)     P err (%)');
for (const [T, P] of [
  [533, 700], [1023, 700], [973, 700], [1223, 700], [1223, 1], [1500, 100], [2200, 50],
  [300, 100], [280, 5], [750, 0.01], [1223, 0.001],
] as [number, number][]) {
  const pt = superheatedFromTP(T, P);
  if (!pt) { fail(`superheatedFromTP(${T}, ${P}) found no state`); continue; }
  const s = Water.calculateState(1, pt.specificEnergy, pt.specificVolume);
  const dT = s.temperature - T, dP = s.pressure / P - 1;
  const bad = Math.abs(dT) > 0.05 || Math.abs(dP) > 1e-3;
  if (bad) failed = true;
  console.log(
    `  ${T.toFixed(0).padStart(7)} ${P.toExponential(2).padStart(11)} ${pt.specificVolume.toExponential(4).padStart(14)} ` +
    `${dT.toExponential(2).padStart(13)} ${(dP * 100).toExponential(2).padStart(13)}${bad ? '   <-- DOES NOT ROUND-TRIP' : ''}`
  );
}

console.log(`\n(${notices} beyond-the-table notices suppressed)`);
console.log(failed ? '\nFAILED' : '\nOK');
process.exit(failed ? 1 : 0);
