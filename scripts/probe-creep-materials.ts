/**
 * Creep-rupture life by material. The point of Alloy 800H is that it turns
 * "minutes" into "years" at gas-reactor temperatures.
 */

import { creepRuptureTime } from '../src/simulation/operators/burst-operator';
import { MATERIALS, type StructuralMaterial } from '../src/simulation/materials';

const mats = Object.keys(MATERIALS) as StructuralMaterial[];

function fmt(t: number): string {
  if (!isFinite(t)) return 'never';
  if (t > 3.15e9) return '>100 yr';
  if (t > 3.15e7) return `${(t / 3.15e7).toFixed(0)} yr`;
  if (t > 86400) return `${(t / 86400).toFixed(1)} d`;
  if (t > 3600) return `${(t / 3600).toFixed(1)} h`;
  if (t > 60) return `${(t / 60).toFixed(1)} min`;
  return `${t.toFixed(1)} s`;
}

console.log('Creep rupture life at stress ratio s = P_gauge / P_burst\n');
for (const s of [0.2, 0.3, 0.5]) {
  console.log(`=== s = ${s} ===`);
  console.log('   T(K)   T(C)   ' + mats.map(m => MATERIALS[m].label.padStart(24)).join(''));
  for (const T of [700, 800, 900, 1023, 1100, 1173]) {
    const cells = mats.map(m => fmt(creepRuptureTime(s, T, m)).padStart(24)).join('');
    console.log(`${T.toString().padStart(7)} ${(T - 273).toFixed(0).padStart(6)}   ${cells}`);
  }
  console.log('');
}

console.log('Xe-100 hot gas duct: 750 C helium, 60 bar in a 90 bar-rated duct');
const s_duct = 60 / 90;
for (const m of mats) {
  console.log(`  ${MATERIALS[m].label.padEnd(26)} ${fmt(creepRuptureTime(s_duct, 1023, m))}`);
}
console.log('\n  ...and with the coaxial duct holding the pressure wall at core inlet (533 K):');
for (const m of mats) {
  console.log(`  ${MATERIALS[m].label.padEnd(26)} ${fmt(creepRuptureTime(s_duct, 533, m))}`);
}
