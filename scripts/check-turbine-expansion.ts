/**
 * Sanity check for the turbine expansion model against steam-table values.
 *
 * The numbers on the right are textbook (Rankine cycle worked examples): an
 * ideal expansion's end state and its available work. We are not chasing
 * table precision - the point is that the model lands in the right place
 * (right order of magnitude for the work, right wetness at the exhaust) and
 * that nothing throws in the corners a plant actually visits.
 *
 * Run: npx tsx scripts/check-turbine-expansion.ts
 */

import { stateAtPh, expandStage } from '../src/simulation/turbine-expansion';
import { saturatedVaporEnthalpy, saturationTemperature } from '../src/simulation/water-properties';

const bar = (p: number) => p * 1e5;

function show(label: string, P1: number, h1: number, P2: number, eta: number) {
  const inlet = stateAtPh(P1, h1);
  const r = expandStage(inlet, P2, eta);
  const o = r.outlet;
  console.log(
    `${label.padEnd(34)} ${(P1 / 1e5).toFixed(2).padStart(7)} -> ${(P2 / 1e5).toFixed(3).padStart(6)} bar  ` +
    `` +
    `h ${(h1 / 1e3).toFixed(0)} -> ${(o.h / 1e3).toFixed(0)} kJ/kg  ` +
    `w=${(r.work / 1e3).toFixed(0).padStart(4)} kJ/kg  ` +
    `w_ideal=${((h1 - r.hIdeal) / 1e3).toFixed(0).padStart(4)}  ` +
    `out ${(o.T - 273.15).toFixed(0)} C ${o.phase}` +
    (o.phase === 'two-phase' ? ` x=${o.quality.toFixed(3)}` : '')
  );
}

console.log('\nIdeal (eta=1) expansions - compare w_ideal against the steam tables:\n');

// Textbook: 165 bar / 565 C superheated, h ~ 3465 kJ/kg, expanded to 0.05 bar
// isentropically gives ~1350 kJ/kg with an exhaust quality around 0.75.
show('165 bar 565 C -> condenser', bar(165), 3465e3, bar(0.05), 1.0);
// Saturated steam at 165 bar (h_g ~ 2580) - the state this plant actually
// makes when the boiler floods. Much less available work, wetter exhaust.
show('165 bar saturated -> condenser', bar(165), saturatedVaporEnthalpy(bar(165)), bar(0.05), 1.0);
// A single extraction stage: 165 bar down to a 25 bar heater
show('165 bar 565 C -> 25 bar bleed', bar(165), 3465e3, bar(25), 1.0);
// And the rest of the way from there
show('25 bar bleed -> condenser', bar(25), 2900e3, bar(0.05), 1.0);
// Low-pressure end, wet the whole way
show('3 bar wet -> condenser', bar(3), 2500e3, bar(0.05), 1.0);

console.log('\nWith a real machine efficiency (eta=0.87):\n');
show('165 bar 565 C -> condenser', bar(165), 3465e3, bar(0.05), 0.87);
show('165 bar 565 C -> 25 bar bleed', bar(165), 3465e3, bar(25), 0.87);
show('60 bar 400 C -> 6 bar bleed', bar(60), 3180e3, bar(6), 0.87);

console.log('\nExtraction-steam states a feedwater heater would see:\n');
for (const Pext of [40, 25, 12, 6, 3, 1.5]) {
  const inlet = stateAtPh(bar(165), 3465e3);
  const r = expandStage(inlet, bar(Pext), 0.87);
  const tsat = saturationTemperature(bar(Pext)) - 273.15;
  console.log(`  bleed at ${Pext.toFixed(1).padStart(5)} bar: ` +
    `steam ${(r.outlet.T - 273.15).toFixed(0).padStart(4)} C ` +
    `(sat ${tsat.toFixed(0)} C), h=${(r.outlet.h / 1e3).toFixed(0)} kJ/kg, ` +
    `work so far ${(r.work / 1e3).toFixed(0)} kJ/kg` +
    (r.outlet.phase === 'two-phase' ? `, x=${r.outlet.quality.toFixed(3)}` : ''));
}

console.log('\nCorners:\n');
// Tiny pressure ratio, and a stage that cannot expand at all
show('165 bar -> 164 bar (tiny ratio)', bar(165), 3465e3, bar(164), 0.87);
show('no expansion (P2 above inlet)', bar(10), 2800e3, bar(20), 0.87);
console.log();
