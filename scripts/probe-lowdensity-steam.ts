/**
 * Probe: how far does the (u,v) water-property grid reach toward low density,
 * and how does calculateState behave there? Also compares the steam-table
 * caloric equation against the linear u_g = 2.375e6 + 1900*(T-273) fit used
 * by the NCG mixture solve.
 */

import * as Water from '../src/simulation/water-properties-v4';

await Water.preloadWaterProperties();

console.log('=== Linear fit vs steam tables: saturated vapor energy u_g(T) ===');
console.log('   T(K)    u_g table(kJ/kg)   u_g linear(kJ/kg)     err(kJ/kg)    err(%)');
for (const T of [300, 350, 400, 450, 500, 550, 600, 620, 640]) {
  const tbl = Water.saturatedVaporEnergy(T);
  const lin = 2375000 + 1900 * (T - 273);
  console.log(
    `${T.toFixed(0).padStart(7)} ${(tbl / 1e3).toFixed(1).padStart(18)} ${(lin / 1e3).toFixed(1).padStart(19)} ` +
    `${((lin - tbl) / 1e3).toFixed(1).padStart(14)} ${((lin - tbl) / tbl * 100).toFixed(2).padStart(9)}`
  );
}

console.log('\n=== Linear fit vs steam tables: saturated liquid energy u_f(T) ===');
console.log('   T(K)    u_f table(kJ/kg)   u_f linear(kJ/kg)     err(kJ/kg)    err(%)');
for (const T of [300, 350, 400, 450, 500, 550, 600, 620, 640]) {
  const tbl = Water.saturatedLiquidEnergy(T);
  const lin = 4186 * (T - 273.15);
  console.log(
    `${T.toFixed(0).padStart(7)} ${(tbl / 1e3).toFixed(1).padStart(18)} ${(lin / 1e3).toFixed(1).padStart(19)} ` +
    `${((lin - tbl) / 1e3).toFixed(1).padStart(14)} ${((lin - tbl) / tbl * 100).toFixed(2).padStart(9)}`
  );
}

console.log('\n=== calculateState at low density: superheated steam, u = 2.9 MJ/kg ===');
console.log('   v(m3/kg)        T(K)       P(Pa)        phase       note');
for (const v of [0.1, 1, 5, 10, 20, 50, 100, 150, 206, 300, 500, 1e3, 1e4, 1e6]) {
  try {
    const s = Water.calculateState(1.0, 2.9e6, v);
    // Ideal-gas comparison
    const P_ideal = (1 / 0.018) * 8.31446 * s.temperature / v;
    console.log(
      `${v.toExponential(2).padStart(11)} ${s.temperature.toFixed(2).padStart(11)} ${s.pressure.toExponential(4).padStart(12)}` +
      `   ${s.phase.padEnd(11)} P_ideal(T)=${P_ideal.toExponential(4)}`
    );
  } catch (e: any) {
    console.log(`${v.toExponential(2).padStart(11)}   THROWS: ${String(e.message).slice(0, 120)}`);
  }
}

console.log('\n=== calculateState: T(u) at fixed large v (is it invertible/smooth?) ===');
const vFix = 20;
console.log(`  v = ${vFix} m3/kg`);
console.log('   u(MJ/kg)      T(K)        P(Pa)       phase');
for (let u = 2.0e6; u <= 4.0e6; u += 0.2e6) {
  try {
    const s = Water.calculateState(1.0, u, vFix);
    console.log(`${(u / 1e6).toFixed(2).padStart(11)} ${s.temperature.toFixed(2).padStart(9)} ${s.pressure.toExponential(4).padStart(12)}   ${s.phase}`);
  } catch (e: any) {
    console.log(`${(u / 1e6).toFixed(2).padStart(11)}   THROWS: ${String(e.message).slice(0, 100)}`);
  }
}

console.log('\n=== Saturated vapor specific volume near the triple point ===');
for (const T of [273.16, 280, 300, 320, 350]) {
  console.log(`  T=${T}K  v_g=${(1 / Water.saturatedVaporDensity(T)).toFixed(2)} m3/kg  P_sat=${Water.saturationPressure(T).toFixed(1)} Pa`);
}
