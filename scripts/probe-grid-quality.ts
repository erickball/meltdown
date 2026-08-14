/**
 * Map where the vapor (u,v) grid is trustworthy.
 *
 * At low pressure steam is very nearly an ideal gas (Z within a fraction of a
 * percent below ~1 bar), and its cv is ~1500-1900 J/kg-K. So two independent
 * checks flag bad data without needing a reference implementation:
 *
 *   Z   = P*v / (R*T)              should be ~1 at low P
 *   cv  = du / dT at fixed v       should be ~1400-2200 J/kg-K
 *
 * Anywhere the returned state violates both badly, the grid is inventing
 * numbers.
 */

import * as Water from '../src/simulation/water-properties-v4';

await Water.preloadWaterProperties();

const R_WATER = 461.5;

console.log('Z = P*v/(R*T)   (should be ~1 where P is low)   |   cv = du/dT at fixed v (J/kg-K)');
console.log('   v(m3/kg)   u(kJ/kg)      T(K)       P(Pa)        Z        cv     path');

const vList = [1, 2, 5, 10, 20, 50, 100, 200];
for (const v of vList) {
  console.log(`\n--- v = ${v} m³/kg ---`);
  let prevT: number | null = null, prevU = 0;
  let firstBad = NaN;
  for (let u = 2.5e6; u <= 3.6e6; u += 0.05e6) {
    let s;
    try {
      s = Water.calculateState(1.0, u, v);
    } catch {
      prevT = null;
      continue;
    }
    const path = Water.DEBUG_getLastCalculationPath();
    const Z = (s.pressure * v) / (R_WATER * s.temperature);
    const cv = prevT !== null && s.temperature !== prevT ? (u - prevU) / (s.temperature - prevT) : NaN;
    const bad = Math.abs(Z - 1) > 0.03 || (!isNaN(cv) && (cv < 1200 || cv > 2600));
    if (bad && isNaN(firstBad)) firstBad = u;
    console.log(
      `${v.toString().padStart(11)} ${(u / 1e3).toFixed(0).padStart(10)} ${s.temperature.toFixed(1).padStart(9)} ` +
      `${s.pressure.toExponential(3).padStart(11)} ${Z.toFixed(4).padStart(8)} ` +
      `${isNaN(cv) ? '     -' : cv.toFixed(0).padStart(9)}   ${path}${bad ? '   <-- SUSPECT' : ''}`
    );
    prevT = s.temperature; prevU = u;
  }
  if (!isNaN(firstBad)) console.log(`  first suspect u at v=${v}: ${(firstBad / 1e3).toFixed(0)} kJ/kg`);
}
