/**
 * Where the moving-boundary partition comes apart.
 *
 * The Xe-100 bundle reaches states like m1 = 16.5 t subcooled, m3 = 5.0 t
 * "superheated", m2 = 0.5 t boiling, in a 20 m3 tube volume. 5 t of
 * superheated steam at 165 bar needs at LEAST 5000 * v_g = 49 m3 - more than
 * twice the whole bundle - so that partition cannot exist. This probe shows
 * how the model gets there and why nothing complains.
 *
 * Run: npx tsx scripts/probe-otsg-partition.ts
 */

import { evaluateOtsgAtP, otsgRates } from '../src/simulation/otsg';
import {
  saturationTemperature, saturatedVaporDensity, saturatedLiquidDensity,
  saturatedLiquidEnergy, saturatedVaporEnergy,
} from '../src/simulation/water-properties';

const P = 165e5;
const V_TUBE = 19.8;            // m3 - one Xe-100 bundle
const AREA = 1970;              // m2
const T_sat = saturationTemperature(P);
const v_g = 1 / saturatedVaporDensity(T_sat);
const v_f = 1 / saturatedLiquidDensity(T_sat);
const u_f = saturatedLiquidEnergy(T_sat);
const u_g = saturatedVaporEnergy(T_sat);

console.log(`\nAt ${(P / 1e5).toFixed(0)} bar: T_sat=${(T_sat - 273.15).toFixed(0)} C, ` +
  `v_f=${v_f.toFixed(5)}, v_g=${v_g.toFixed(5)} m3/kg`);
console.log(`A ${V_TUBE} m3 bundle can hold at most ${(V_TUBE / v_g).toFixed(0)} kg of steam ` +
  `(saturated vapour, the densest superheat there is)`);
console.log(`...and at most ${(V_TUBE / v_f).toFixed(0)} kg of saturated liquid.\n`);

// Reproduce the plant's state: a flooded bundle with a large partition
const massTotal = 11000;        // kg - the measured per-bundle inventory
const uMean = u_f * 0.98;       // essentially saturated liquid
const UTotal = massTotal * uMean;
const uFeed = u_f - 100e3;

console.log(`Bundle holding ${massTotal} kg at ~saturated liquid:`);
console.log(`  as pure liquid that is ${(massTotal * v_f).toFixed(1)} m3 ` +
  `of the ${V_TUBE} m3 available\n`);

console.log('  m1(kg)   m3(kg) |    V1     V2     V3   sum(m3)  vs tube  | length fractions');
for (const [m1, m3] of [[2000, 50], [4000, 200], [6000, 800], [8000, 2000], [8500, 2500]]) {
  const ev = evaluateOtsgAtP(m1, m3, massTotal, UTotal, P, uFeed,
    { tubeVolume: V_TUBE, tubeLength: 1, heatArea: AREA });
  const V = ev.sections.map(s => s.volume);
  const sum = V[0] + V[1] + V[2];
  console.log(
    `  ${m1.toString().padStart(6)} ${m3.toString().padStart(8)} | ` +
    `${V[0].toFixed(1).padStart(5)} ${V[1].toFixed(1).padStart(6)} ${V[2].toFixed(1).padStart(6)} ` +
    `${sum.toFixed(1).padStart(9)} ${(sum / V_TUBE).toFixed(2).padStart(7)}x | ` +
    ev.sections.map(s => (100 * s.lengthFrac).toFixed(0).padStart(3) + '%').join(' ')
  );
}

console.log(`\nThe sections' volumes sum to several times the tube volume, and the length`);
console.log(`fractions still come out looking reasonable - evaluateOtsgAtP normalizes them`);
console.log(`over the sections' OWN summed volume, so an impossible partition is rescaled`);
console.log(`into a plausible-looking answer instead of being rejected.\n`);

// Now show the mechanism that drives m3 up there: a bottled boiler
console.log('A bottled boiler (heat in, no steam draw) - what the partition rates do:\n');
console.log('     t(s)     m1      m2      m3   |    W12    W23  | m3 vs the volume limit');
let m1 = 2000, m3 = 50;
const Q1 = 5e6, Q2 = 60e6, Q3 = 2e6;   // W - a bundle taking ~67 MW
const dt = 1;
for (let t = 0; t <= 600; t++) {
  const ev = evaluateOtsgAtP(m1, m3, massTotal, UTotal, P, uFeed,
    { tubeVolume: V_TUBE, tubeLength: 1, heatArea: AREA });
  // Feed matches nothing, draw is nearly shut - the railed-governor case
  const r = otsgRates(ev, 5, u_f - 100e3 + P * v_f, 0.5, Q1, Q2, Q3);
  if (t % 100 === 0) {
    const limit = V_TUBE / v_g;
    console.log(
      `  ${t.toString().padStart(7)} ${m1.toFixed(0).padStart(6)} ` +
      `${(massTotal - m1 - m3).toFixed(0).padStart(7)} ${m3.toFixed(0).padStart(7)} | ` +
      `${r.W12.toFixed(1).padStart(6)} ${r.W23.toFixed(1).padStart(6)} | ` +
      `${(m3 / limit).toFixed(2)}x of the ${limit.toFixed(0)} kg that fits`
    );
  }
  m1 = Math.max(0, m1 + r.dm1 * dt);
  m3 = Math.max(0, m3 + r.dm3 * dt);
  if (m1 + m3 > massTotal) {           // the solver's only guard
    const scale = massTotal / (m1 + m3);
    m1 *= scale; m3 *= scale;
  }
}
console.log(`\nThe only constraint the integrator applies is m1 + m3 <= total MASS`);
console.log(`(rk45-solver.ts). Nothing anywhere asks whether the sections fit in the`);
console.log(`tube's VOLUME, so with the steam draw shut the evaporator keeps converting`);
console.log(`inventory into a superheat section that has nowhere to be.\n`);
