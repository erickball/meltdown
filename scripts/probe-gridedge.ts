/**
 * Probe the vapor grid's low-density edge: is T(u) at fixed v monotone and
 * continuous there? The mixture energy split needs it to be, since it solves
 * f(u) = m*u + n*Cv*T(u) - U_total = 0 by bracketing.
 */

import * as Water from '../src/simulation/water-properties-v4';

await Water.preloadWaterProperties();

for (const v of [112.47, 150, 180, 205, 210, 90, 60]) {
  console.log(`\n=== v = ${v} m3/kg ===`);
  console.log('    u(kJ/kg)       T(K)        P(Pa)      dT/du    phase');
  let prevT: number | null = null, prevU = 0;
  for (let u = 2.40e6; u <= 3.60e6; u += 0.02e6) {
    let s;
    try {
      s = Water.calculateState(1.0, u, v);
    } catch (e: any) {
      console.log(`${(u / 1e3).toFixed(1).padStart(12)}   THROWS: ${String(e.message).slice(0, 80)}`);
      prevT = null;
      continue;
    }
    const slope = prevT !== null ? (s.temperature - prevT) / ((u - prevU) / 1e3) : NaN;
    const flag = prevT !== null && (slope < -1e-9 || slope > 2) ? '  <-- NON-MONOTONE/JUMP' : '';
    console.log(
      `${(u / 1e3).toFixed(1).padStart(12)} ${s.temperature.toFixed(2).padStart(10)} ` +
      `${s.pressure.toExponential(4).padStart(12)} ${isNaN(slope) ? '     -' : slope.toFixed(4).padStart(10)}   ${s.phase}${flag}`
    );
    prevT = s.temperature; prevU = u;
  }
}
