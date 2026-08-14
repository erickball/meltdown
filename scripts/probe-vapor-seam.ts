/**
 * Probe: continuity of the low-density vapor property seams.
 *
 * Sweeps v at fixed u across the grid -> superheat-extrapolation ->
 * ideal-gas transitions and reports any jump in T or P. For an ideal gas at
 * fixed u, T should be nearly constant and P should fall as 1/v.
 */

import * as Water from '../src/simulation/water-properties-v4';

await Water.preloadWaterProperties();

for (const u of [2.6e6, 2.9e6, 3.3e6]) {
  console.log(`\n=== u = ${(u / 1e6).toFixed(2)} MJ/kg ===`);
  console.log('    v(m3/kg)        T(K)        P(Pa)      P*v (should be ~R*T=const)   T jump   P ratio vs 1/v');
  let prev: { v: number; T: number; P: number } | null = null;
  for (let e = 0; e <= 6.001; e += 0.05) {
    const v = Math.pow(10, e);
    let s;
    try {
      s = Water.calculateState(1.0, u, v);
    } catch (err: any) {
      console.log(`${v.toExponential(3).padStart(12)}   THROWS: ${String(err.message).slice(0, 90)}`);
      prev = null;
      continue;
    }
    const Pv = s.pressure * v;
    let flag = '';
    if (prev) {
      const dT = s.T ?? s.temperature;
      const tJump = Math.abs(s.temperature - prev.T);
      // For ideal gas at fixed u, P should scale as v_prev/v
      const expectedP = prev.P * (prev.v / v);
      const ratio = s.pressure / expectedP;
      if (tJump > 2 || ratio < 0.95 || ratio > 1.05) {
        flag = `   <-- dT=${tJump.toFixed(1)}K  P/P_expected=${ratio.toFixed(3)}`;
      }
      void dT;
    }
    console.log(
      `${v.toExponential(3).padStart(12)} ${s.temperature.toFixed(2).padStart(11)} ${s.pressure.toExponential(4).padStart(13)} ` +
      `${Pv.toExponential(4).padStart(18)} (R*T=${(461.5 * s.temperature).toExponential(4)})${flag}`
    );
    prev = { v, T: s.temperature, P: s.pressure };
  }
}
