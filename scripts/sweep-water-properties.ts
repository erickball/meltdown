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
import { calculateState } from '../src/simulation/water-properties-v4';

const h = crypto.createHash('sha256');
let ok = 0, threw = 0;
const samples: string[] = [];

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
      ok++;
      if (samples.length < 6 && j % 137 === 0 && i % 97 === 0) samples.push(`v=${v.toExponential(3)} u=${(u / 1e3).toFixed(0)} -> ${line}`);
    } catch (e) {
      h.update(`THREW:${e instanceof Error ? e.message : String(e)}`);
      threw++;
    }
  }
}

console.log(`states=${ok} threw=${threw}`);
console.log(`SWEEPHASH ${h.digest('hex')}`);
for (const s of samples) console.log(`  ${s}`);
