/**
 * The moving-boundary partition, solved from the node's own totals.
 *
 * This probe used to document the failure: with m3 integrated alongside the
 * totals, the Xe-100 bundle reached states like m1 = 16.5 t subcooled,
 * m3 = 5.0 t "superheated", m2 = 0.5 t boiling in a 20 m3 tube - and 5 t of
 * superheated steam at 165 bar needs at least 5000 * v_g = 49 m3, more than
 * twice the whole bundle. Nothing complained, because the reported section
 * LENGTHS are normalized over the sections' own summed volume.
 *
 * evaluateOtsgAtP now solves the boiling/superheat split from the node's
 * mass, energy and tube volume, so that partition can no longer be asked for:
 * the only thing handed in is the economizer's ENERGY, and what comes back
 * always fits. This probe shows the three regimes it lands in, checks the
 * closure on each, and ends on what is still soft about the economizer.
 *
 * Run: npx tsx scripts/probe-otsg-partition.ts
 */

import {
  evaluateOtsgAtP, otsgRates, saturationAtP, subcooledSectionMean,
} from '../src/simulation/otsg';
import { calculateState } from '../src/simulation/water-properties';

const P = 165e5;
const V_TUBE = 19.8;            // m3 - one Xe-100 bundle
const AREA = 1970;              // m2
const GEOM = { tubeVolume: V_TUBE, tubeLength: 1, heatArea: AREA };
const sat = saturationAtP(P);

console.log(`\nAt ${(P / 1e5).toFixed(0)} bar: T_sat=${(sat.T - 273.15).toFixed(0)} C, ` +
  `v_f=${sat.v_f.toFixed(5)}, v_g=${sat.v_g.toFixed(5)} m3/kg`);
console.log(`A ${V_TUBE} m3 bundle holds at most ${(V_TUBE / sat.v_g).toFixed(0)} kg of ` +
  `saturated steam and ${(V_TUBE / sat.v_f).toFixed(0)} kg of saturated liquid.\n`);

const uFeed = sat.u_f - 400e3;

/** The probe talks in economizer MASS; the state is its energy (m1 = U1/u1bar). */
const U1of = (m1: number) => m1 * subcooledSectionMean(uFeed, sat);

function show(label: string, m1: number, mass: number, U: number) {
  const ev = evaluateOtsgAtP(U1of(m1), mass, U, P, uFeed, GEOM);
  const V = ev.sections.map(s => s.volume);
  const sum = V[0] + V[1] + V[2];
  const uSections = ev.sections.reduce((s, x) => s + x.mass * (x.hBar - P * x.vBar), 0);
  console.log(
    `  ${label.padEnd(26)} ${ev.sections.map(s => s.mass.toFixed(0).padStart(6)).join(' ')} | ` +
    `${V.map(x => x.toFixed(1).padStart(5)).join(' ')} ${sum.toFixed(2).padStart(7)} ` +
    `${(sum / V_TUBE).toFixed(3).padStart(6)}x | ` +
    `${ev.x2Out.toFixed(2).padStart(4)} ${(ev.u3 / 1e3).toFixed(0).padStart(5)} ` +
    `${(ev.sections[2].T - 273.15).toFixed(0).padStart(5)} | ` +
    `${((uSections / U - 1) * 100).toFixed(2).padStart(6)}%`
  );
}

console.log('  state                          m1     m2     m3 |    V1    V2    V3   sum  vs tube ' +
  '| xOut    u3    T3 | dU');
// A flooded bundle: 11 t of near-saturated water. There is no room for dry
// steam, so the boiling section simply ends low on the dome.
for (const m1 of [0, 2000, 6000, 8500]) {
  show(`flooded, m1=${m1}`, m1, 11000, 11000 * sat.u_f * 0.98);
}
// The same bundle boiled down. The inventory and the tube volume fix the bulk
// quality between them, so these are genuine 165-bar states, not made-up ones:
// x = (V/m - v_f)/(v_g - v_f).
for (const mass of [4000, 3000, 2400]) {
  const x = (V_TUBE / mass - sat.v_f) / (sat.v_g - sat.v_f);
  const u = sat.u_f + x * (sat.u_g - sat.u_f);
  show(`boiled to x=${x.toFixed(2)}, ${mass} kg`, 500, mass, mass * u);
}
// Genuinely dry: the tube's own (u,v) is superheated steam, so the pressure
// comes from the property surface rather than from the saturation line.
{
  const mass = 1500;
  const v = V_TUBE / mass;
  const st = calculateState(1, sat.u_g + 350e3, v);
  console.log(`\n  (dry case bulk state: ${st.phase} at ${(st.pressure / 1e5).toFixed(0)} bar, ` +
    `${(st.temperature - 273.15).toFixed(0)} C - shown at ITS pressure)`);
  const evDry = evaluateOtsgAtP(0, mass, mass * (sat.u_g + 350e3), st.pressure, uFeed,
    GEOM);
  const sumDry = evDry.sections.reduce((s, x) => s + x.volume, 0);
  console.log(`  ${'dry, 1500 kg superheated'.padEnd(26)} ` +
    `${evDry.sections.map(s => s.mass.toFixed(0).padStart(6)).join(' ')} | ` +
    `${evDry.sections.map(s => s.volume.toFixed(1).padStart(5)).join(' ')} ` +
    `${sumDry.toFixed(2).padStart(7)} ${(sumDry / V_TUBE).toFixed(3).padStart(6)}x | ` +
    `${evDry.x2Out.toFixed(2).padStart(4)} ${(evDry.u3 / 1e3).toFixed(0).padStart(5)} ` +
    `${(evDry.sections[2].T - 273.15).toFixed(0).padStart(5)} |`);
}

console.log(`\n"sum vs tube" is 1.000x everywhere - the volume constraint is what SETS the`);
console.log(`partition now, so it cannot be violated. dU is the energy the section states`);
console.log(`fail to account for: zero once there is dry steam (both constraints are`);
console.log(`enforced), and non-zero only for a flooded bundle, where the boiling section's`);
console.log(`outlet quality is the single remaining freedom and the volume claims it.\n`);

// A quasi-static dry-down at 165 bar. Each row is a genuine tube state: the
// inventory and the tube volume fix v, and u comes from the property surface
// at that v and pressure - the chord inside the dome, the isobar outside it.
// Nothing here is integrated except m1, so the boundaries are wherever the
// tube's own contents put them.
function uAtPv(v: number): number {
  if (v <= sat.v_g) return sat.u_f + (v - sat.v_f) / (sat.v_g - sat.v_f) * (sat.u_g - sat.u_f);
  let lo = sat.u_g, hi = 4.0e6;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (calculateState(1, mid, v).pressure > P) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

console.log('A quasi-static dry-down at 165 bar, economizer holding a fifth of the water.');
console.log('Only the economizer energy is integrated; every other boundary is read');
console.log('off the tube itself:\n');
console.log('   inventory     m1     m2     m3 | lengths L1/L2/L3 | xOut  T3(C) |    W12    W23');
for (const mass of [11000, 9000, 7000, 5000, 4000, 3000, 2400]) {
  const m1 = 0.2 * mass;
  const u = uAtPv(V_TUBE / mass);
  const ev = evaluateOtsgAtP(U1of(m1), mass, mass * u, P, uFeed, GEOM);
  // A fixed 67 MW duty split the way the sections' areas split it
  const Q = 67e6;
  const [a1, a2, a3] = ev.sections.map(s => s.area / AREA);
  const r = otsgRates(ev, 48, uFeed + P * sat.v_f, 48, Q * a1, Q * a2, Q * a3);
  console.log(
    `  ${mass.toString().padStart(9)} ${ev.sections.map(s => s.mass.toFixed(0).padStart(6)).join(' ')} | ` +
    `${ev.sections.map(s => (100 * s.lengthFrac).toFixed(0).padStart(5) + '%').join(' ')} | ` +
    `${ev.x2Out.toFixed(2).padStart(4)} ${(ev.sections[2].T - 273.15).toFixed(0).padStart(6)} | ` +
    `${r.W12.toFixed(1).padStart(6)} ${r.W23.toFixed(1).padStart(6)}`
  );
}

// What is left over. The economizer's energy is integrated from real flows -
// feed in, boil-off at h_f, wall heat - so no pressure change can re-value it
// and hand the difference to the vapour. But nothing ties it to the TOTALS,
// so an economizer that outlives the water it describes still reads as an
// absurd superheat temperature: the energy it claims comes off the node, and
// whatever is left has to be somewhere.
{
  const mass = 1800, m1 = 400;              // a dry tube still claiming 400 kg of liquid
  const ev = evaluateOtsgAtP(U1of(m1), mass, mass * uAtPv(V_TUBE / mass), P, uFeed, GEOM);
  console.log(`\n  stale economizer: ${m1} kg of "liquid" in a tube holding ${mass} kg of ` +
    `dry steam -> T3 = ${(ev.sections[2].T - 273.15).toFixed(0)} C`);
  const rStale = otsgRates(ev, 0, uFeed + P * sat.v_f, 48,
    67e6 * ev.sections[0].area / AREA, 67e6 * ev.sections[1].area / AREA,
    67e6 * ev.sections[2].area / AREA);
  console.log(`  (the interface flux W12 = ${rStale.W12.toFixed(0)} kg/s drains it in ` +
    `${(m1 / Math.max(1e-9, rStale.W12)).toFixed(0)} s - the dynamics do fix it, but ` +
    `nothing bounds it within a step)`);
}

console.log(`\nThe superheater appears because the tube's own inventory and energy leave room`);
console.log(`for it, not because W23 pushed mass into it. W23 still says where the dry-steam`);
console.log(`boundary is TRYING to move - it drives nothing now, and nothing can accumulate`);
console.log(`into a section that has nowhere to be.\n`);
