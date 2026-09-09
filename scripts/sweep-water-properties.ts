/**
 * Bit-exact sweep of the (u, v) property surface.
 *
 * Hashes calculateState over a dense sweep spanning compressed liquid, the
 * two-phase dome and superheated vapour, so a change to the grid LOOKUP path
 * can be proven to leave every returned value untouched. Water properties
 * carry no wall-clock dependence, so this hash is stable run to run - unlike a
 * whole-plant trajectory (see the wall-clock substep budget in advance()).
 *
 * Usage: npx tsx scripts/sweep-water-properties.ts
 */

import * as crypto from 'crypto';
import { calculateState, saturatedLiquidDensity, saturatedVaporDensity,
  saturatedLiquidEnergy, saturatedVaporEnergy } from '../src/simulation/water-properties-v4';

const h = crypto.createHash('sha256');
// A SECOND hash over only the points at or above the triple line - the bottom
// edge of the liquid-vapour dome, u_bottom(v). Below that line the model
// deliberately changed (the ice-vapour region used to be a flat throw and is
// now a real two-phase branch), so the all-points hash above MUST move when
// that lands. This one must not: it is the proof that extending the surface
// downward left every state at or above the triple point bit-identical.
const hAbove = crypto.createHash('sha256');
let ok = 0, threw = 0, above = 0;
const samples: string[] = [];

// The triple-point row, via the public accessors (same numbers the dome test
// uses). Note this must be read AFTER a first calculateState call so the
// tables are loaded.
calculateState(1, 2.0e6, 1.0);
const T_TRIPLE = 273.16;
const V_F_TRIPLE = 1 / saturatedLiquidDensity(T_TRIPLE);
const V_G_TRIPLE = 1 / saturatedVaporDensity(T_TRIPLE);
const U_F_TRIPLE = saturatedLiquidEnergy(T_TRIPLE);
const U_G_TRIPLE = saturatedVaporEnergy(T_TRIPLE);
/** The dome's bottom edge: linear in v between the triple point's liquid and
 *  vapour states, exactly as isInsideTwoPhaseDome computes it. */
const uBottom = (v: number) =>
  U_F_TRIPLE + ((v - V_F_TRIPLE) / (V_G_TRIPLE - V_F_TRIPLE)) * (U_G_TRIPLE - U_F_TRIPLE);

// v from 1e-3 to 1e2 m3/kg (log), u from 20 to 3400 kJ/kg.
for (let i = 0; i <= 400; i++) {
  const logV = -3 + (5 * i) / 400;
  const v = Math.pow(10, logV);
  for (let j = 0; j <= 400; j++) {
    const u = (20 + (3380 * j) / 400) * 1000; // J/kg
    const mass = 1;
    try {
      const st = calculateState(mass, u * mass, v * mass);
      const line = `${st.temperature} ${st.pressure} ${st.phase} ${st.quality} ${st.density}`;
      h.update(line);
      if (u >= uBottom(v)) { hAbove.update(line); above++; }
      ok++;
      if (samples.length < 6 && j % 137 === 0 && i % 97 === 0) samples.push(`v=${v.toExponential(3)} u=${(u / 1e3).toFixed(0)} -> ${line}`);
    } catch (e) {
      const msg = `THREW:${e instanceof Error ? e.message : String(e)}`;
      h.update(msg);
      if (u >= uBottom(v)) { hAbove.update(msg); above++; }
      threw++;
    }
  }
}

console.log(`states=${ok} threw=${threw} aboveTripleLine=${above}`);
console.log(`SWEEPHASH ${h.digest('hex')}`);
console.log(`ABOVETRIPLEHASH ${hAbove.digest('hex')}`);
for (const s of samples) console.log(`  ${s}`);
