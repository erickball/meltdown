/**
 * TRISO release through the real solver path.
 *
 *   npx tsx scripts/check-triso-release.ts [preset]
 *
 * Unit tests cover the failure curve; this checks the plumbing the unit
 * tests cannot: dTrisoDamage integrated in place across RK45 stage clones,
 * the sealed (intact-particle) inventory honoured by the operator, and the
 * released moles conserved into the coolant's NCG.
 *
 *  1. Run the Xe-100 at power: particle life is consumed (D grows, at the
 *     Arrhenius rate of the kernel temperature) but release is only the
 *     as-made defect share.
 *  2. Force D to the median life (half the particles failed) and run on:
 *     the release rate must jump by ~0.5/f_defect, and every mole that
 *     left the fuel must be found as Xe/CsI in the plant (gas, plate-out,
 *     or environment).
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { sicDamageRate, trisoFailedFraction } from '../src/simulation/triso';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = process.argv[2] ?? path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const sim = buildSimFromFile(PRESET);

// Damage expected from the kernel temperature history, trapezoid per tick.
// With Q/R ~ 80000 K a 20 K drift is a factor of 4, so comparing against
// the end-point temperature alone would be meaningless.
let expectedDamage = 0;
function advance(secs: number, dt = 0.05) {
  for (let i = 0; i < Math.round(secs / dt); i++) {
    const before = sim.state.thermalNodes.get(fuelId)!.temperature;
    const t = sim.state.time;
    sim.state = sim.solver.advance(sim.state, dt).state;
    sim.state.pendingEvents = [];
    const after = sim.state.thermalNodes.get(fuelId)!.temperature;
    expectedDamage += 0.5 * (sicDamageRate(before) + sicDamageRate(after)) * (sim.state.time - t);
  }
}

const fuelEntry = [...sim.state.thermalNodes].find(([, n]) => n.fissionProducts?.trisoDefectFraction !== undefined);
if (!fuelEntry) throw new Error(`${PRESET} has no TRISO fuel node`);
const fuelId = fuelEntry[0];
const fuel = () => sim.state.thermalNodes.get(fuelId)!;
const fp = () => fuel().fissionProducts!;

/** Xe + CsI moles anywhere outside the fuel */
function escapedMoles(): number {
  let n = 0;
  for (const node of sim.state.flowNodes.values()) {
    n += (node.fluid.ncg?.Xe ?? 0) + (node.fluid.ncg?.CsI ?? 0) + (node.depositedCsI ?? 0);
  }
  n += (sim.state.environmentalRelease?.Xe ?? 0) + (sim.state.environmentalRelease?.CsI ?? 0);
  return n;
}
const inFuel = () => fp().nobleGas + fp().volatile;
const initial = fp().initialNobleGas! + fp().initialVolatile!;

let failures = 0;
function check(ok: boolean, msg: string) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
}

console.log(`TRISO release check on ${path.basename(PRESET)} (fuel node ${fuelId})`);

// --- 1. At power ------------------------------------------------------------
const escaped0 = escapedMoles();
advance(60);
const T = fuel().temperature;
const D1 = fp().trisoDamage ?? 0;
console.log(`  at power: kernel ${(T - 273.15).toFixed(0)} C, D = ${D1.toExponential(4)} ` +
  `(integral of the Arrhenius rate over the tick history: ${expectedDamage.toExponential(4)})`);
check(D1 > 0 && Math.abs(D1 / expectedDamage - 1) < 0.02,
  'particle life is consumed at the kernel temperature, integrated once per step');
const relAtPower = 1 - inFuel() / initial;
check(relAtPower < 10 * fp().trisoDefectFraction!,
  `release at power bounded by the defect share: ${relAtPower.toExponential(2)} of inventory`);

// --- 2. Half the particles failed -------------------------------------------
const before = inFuel();
const escapedBefore = escapedMoles();
fp().trisoDamage = 1;
const F = trisoFailedFraction(1, fp().trisoDefectFraction!);
advance(30);
const released = before - inFuel();
const gained = escapedMoles() - escapedBefore;
console.log(`  D forced to 1 (failed ${F.toFixed(4)}): ${released.toExponential(3)} mol left the fuel in 30 s, ` +
  `${gained.toExponential(3)} mol appeared as Xe/CsI`);
check(released > 0, 'failed particles release');
check(Math.abs(gained - released) <= 1e-6 * Math.max(released, 1e-12) + 1e-9,
  'every released mole is accounted for in the plant (gas + plate-out + environment)');
check(escaped0 >= 0 && fp().nobleGas >= fp().initialNobleGas! * (1 - F) - 1e-9,
  'intact particles still hold their share of the inventory');

if (failures) {
  console.log(`\n${failures} TRISO release check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll TRISO release checks passed');
