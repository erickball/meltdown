/**
 * Probe the hot side of the steam table: superheated steam from 600 C up to
 * the table's limit (2273.15 K, 50 MPa) and across the hot edge into the
 * anchored extension beyond it.
 *
 * The (u, v) grid used to stop at u = 3300 kJ/kg (590-650 C); it was extended
 * to IAPWS-IF97's own limits by scripts/build-uv-grid-v13-hot-patch.py. This
 * checks the three things that extension has to get right:
 *
 *  1. ACCURACY - states computed forward from IF97 (T, P -> u, v) must come
 *     back out of calculateState at the T and P they were made from.
 *  2. NO HOLES - a fine sweep of (u, v) must not throw anywhere under the
 *     pressure ceiling. The top of the grid is sloped where it ends on the
 *     50 MPa isobar, and a state between two columns of different height
 *     with data on one side only is refused by the interpolator.
 *  3. ONE SURFACE - T must rise with u at fixed v, at a steam-like rate
 *     (1/cv is 0.4-0.6 K per kJ/kg up here), across the whole sweep
 *     including the seam where the extension takes over. A plateau, a step
 *     or a dip there breaks anything solving through the surface (the
 *     water/NCG energy split brackets a root in u).
 *
 * Usage: npx tsx scripts/probe-hot-steam-grid.ts
 * Exits non-zero if any check fails.
 */

import * as Water from '../src/simulation/water-properties-v4';

await Water.preloadWaterProperties();

// Count the extension's notices instead of printing them: the sweep crosses
// the hot edge on purpose, thousands of times.
let notices = 0;
const warn = console.warn;
console.warn = (...a: unknown[]) => {
  if (String(a[0]).includes('beyond steam-table grid')) notices++;
  else warn(...a);
};

let failed = false;

// ---------------------------------------------------------------------------
// 1. Reference states, forward from IAPWS-IF97 (iapws 1.5.4):
//    [T C, P bar, u kJ/kg, v m3/kg]
// ---------------------------------------------------------------------------
const REFERENCE: [number, number, number, number][] = [
  [650, 180, 3293.273675, 0.0220638362],   // just under the OLD edge
  [700, 180, 3395.440931, 0.0236279443],   // isolated OTSG tube at its safety-valve pressure
  [750, 180, 3496.819126, 0.0251418045],   // ... at helium core-outlet temperature
  [800, 250, 3570.945015, 0.0189223935],
  [1000, 100, 4029.763417, 0.0583894275],
  [1000, 1, 4054.981042, 5.87554008],
  [743, 0.04, 3559.304058, 117.243795],    // near-empty tube under hot metal
  [1200, 400, 4396.802015, 0.0169766074],  // close under the 50 MPa edge
  [1500, 50, 5129.485396, 0.163897111],
  [1900, 10, 6081.714699, 1.00339212],
  [1990, 0.05, 6303.182510, 208.900971],   // hot, dilute corner of the grid
];
const TOL_T = 0.5;     // K
const TOL_P = 1e-3;    // relative

console.log('1. Reference states (IAPWS-IF97)');
console.log('     T(C)  P(bar)    T err (K)   P err (%)   path');
for (const [TC, Pbar, u_kJ, v] of REFERENCE) {
  const s = Water.calculateState(1, u_kJ * 1e3, v);
  const dT = s.temperature - (TC + 273.15);
  const dP = s.pressure / (Pbar * 1e5) - 1;
  const bad = Math.abs(dT) > TOL_T || Math.abs(dP) > TOL_P;
  if (bad) failed = true;
  console.log(
    `  ${String(TC).padStart(7)} ${String(Pbar).padStart(7)} ${dT.toFixed(3).padStart(12)} ` +
    `${(dP * 100).toFixed(4).padStart(11)}   ${Water.DEBUG_getLastCalculationPath()}${bad ? '   <-- OUT OF TOLERANCE' : ''}`
  );
}

// ---------------------------------------------------------------------------
// 2 + 3. Fine sweep: every v from 0.003 to 210 m3/kg, u from 3100 kJ/kg
// (2600 for the dense columns, whose tops are lower) to 6600 - past the
// table's top everywhere, so every column crosses the seam.
// ---------------------------------------------------------------------------
const DU = 10e3;
const SLOPE_MIN = 0.25, SLOPE_MAX = 0.75;   // K per kJ/kg
let states = 0, ceiling = 0;
const paths = new Map<string, number>();
const problems: string[] = [];

for (let logV = -2.5; logV <= 2.32; logV += 0.01) {
  const v = Math.pow(10, logV);
  let prevT: number | null = null, prevPath = '';
  for (let u = logV < -2.0 ? 2.6e6 : 3.1e6; u <= 6.6e6; u += DU) {
    states++;
    let T: number, P: number;
    try {
      const s = Water.calculateState(1, u, v);
      T = s.temperature; P = s.pressure;
    } catch (e) {
      const msg = String((e as Error).message);
      // The model's own ceiling (10x critical pressure, ~2200 bar): dense
      // AND very hot. Expected, and not what this probe is about.
      if (msg.includes('Pressure out of range')) ceiling++;
      else problems.push(`THROW v=${v.toPrecision(4)} u=${u / 1e3}: ${msg.slice(0, 110)}`);
      prevT = null;
      continue;
    }
    const path = Water.DEBUG_getLastCalculationPath();
    paths.set(path, (paths.get(path) ?? 0) + 1);
    if (prevT !== null) {
      const slope = (T - prevT) / (DU / 1e3);
      if (!(slope >= SLOPE_MIN && slope <= SLOPE_MAX)) {
        problems.push(
          `${slope <= 0 ? 'NOT RISING' : 'ODD SLOPE'} ${slope.toFixed(3)} K per kJ/kg at v=${v.toPrecision(4)} ` +
          `u=${u / 1e3}: T ${prevT.toFixed(2)} -> ${T.toFixed(2)} K, P=${(P / 1e5).toFixed(0)} bar, ${prevPath} -> ${path}`
        );
      }
    }
    prevT = T; prevPath = path;
  }
}

console.log(`\n2/3. Sweep: ${states} states, ${ceiling} above the pressure ceiling (expected), ` +
  `${notices} extension notices suppressed`);
for (const [p, n] of paths) console.log(`     ${p}: ${n}`);
if (problems.length > 0) {
  failed = true;
  console.log(`  ${problems.length} PROBLEMS:`);
  for (const p of problems.slice(0, 40)) console.log(`    ${p}`);
  if (problems.length > 40) console.log(`    ... and ${problems.length - 40} more`);
} else {
  console.log('  no holes; T rises with u at a steam-like rate everywhere, including across the hot edge');
}

console.log(failed ? '\nFAILED' : '\nOK');
process.exit(failed ? 1 : 0);
