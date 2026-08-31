/**
 * Why does the steam inside the Xe-100 MSSV get hotter than the reactor?
 *
 * Reported from play: val-msv-1 creep-ruptures around 600 s with its steam at
 * 821 C, well above the 750 C core outlet. Nothing downstream of a 750 C
 * primary should be hotter than it, so either energy is being created or it
 * is being concentrated into too little mass.
 *
 * This traces the valve against what feeds it: its own temperature, pressure
 * and INVENTORY, the specific internal energy that implies, and the state of
 * the boiler tube it taps. The inventory column is the one to watch - a
 * dead-ended body that keeps its energy while losing its mass will heat up
 * without anything having heated it.
 *
 * Usage: npx tsx scripts/xe100-msv-probe.ts [seconds]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import { evaluateOtsgSections } from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const seconds = parseFloat(process.argv[2] ?? '700');

const sim = buildSimFromFile(PRESET);
const st = () => sim.state;
const T = (id: string) => (st().flowNodes.get(id)?.fluid.temperature ?? NaN) - 273.15;
const P = (id: string) => (st().flowNodes.get(id)?.fluid.pressure ?? NaN) / 1e5;
const m = (id: string) => st().flowNodes.get(id)?.fluid.mass ?? NaN;
const flow = (id: string) => st().flowConnections.find(c => c.id === id)?.massFlowRate ?? 0;

/** Specific internal energy of a node (kJ/kg) - the thing that sets T. */
function u(id: string): number {
  const n = st().flowNodes.get(id);
  if (!n) return NaN;
  const U = (n.fluid as any).internalEnergy;
  return Number.isFinite(U) && n.fluid.mass > 0 ? U / n.fluid.mass / 1e3 : NaN;
}

/** The superheat section the MSSV taps, per the OTSG's own evaluation. */
function t3(): number {
  const node = st().flowNodes.get('hx-1-tube');
  if (!node?.otsg) return NaN;
  try {
    const { ev } = evaluateOtsgSections(st(), 'hx-1-tube', node);
    return ev.sections[2].T - 273.15;
  } catch { return NaN; }
}

console.log('\n=== Xe-100 MSSV thermal trace ===');
console.log('   t(s)  MSV_T(C)  MSV_P(bar)  MSV_m(kg)  u_msv(kJ/kg)  ' +
  'tube_T(C)  tube_P(bar)   T3(C)   in(kg/s)  out(kg/s)  wallT(C)');

function line() {
  const burst = st().burstStates?.get('val-msv-1') as any;
  const inflow = flow('flow-hx-1-val-msv-1') +
    flow('flow-hx-1-val-msv-1-hx-1-tube-2-b2-val-msv-1-in');
  console.log(
    `${st().time.toFixed(0).padStart(7)} ` +
    `${T('val-msv-1').toFixed(1).padStart(9)} ` +
    `${P('val-msv-1').toFixed(1).padStart(11)} ` +
    `${m('val-msv-1').toFixed(3).padStart(10)} ` +
    `${u('val-msv-1').toFixed(0).padStart(13)} ` +
    `${T('hx-1-tube').toFixed(1).padStart(10)} ` +
    `${P('hx-1-tube').toFixed(1).padStart(11)} ` +
    `${t3().toFixed(0).padStart(7)} ` +
    `${inflow.toFixed(3).padStart(10)} ` +
    `${flow('flow-val-msv-1-condenser-1').toFixed(3).padStart(10)} ` +
    `${((burst?.wallTemperature ?? NaN) - 273.15).toFixed(0).padStart(9)}`);
}

line();
const every = Math.max(1, Math.round(seconds / 40));
for (let t = 0; t < seconds; t++) {
  try {
    run(sim, 1, 0.05);
  } catch (e: any) {
    console.log(`\n!!! THREW at t=${st().time.toFixed(1)}: ${e.message.split('\n')[0]}`);
    break;
  }
  if (t % every === 0) line();
}
line();

for (const [id, b] of st().burstStates ?? []) {
  const bb = b as any;
  if (bb.isBurst) console.log(`BURST: ${id}`);
  if (bb.creepDamage > 0.01) {
    console.log(`  creep ${id}: damage=${bb.creepDamage.toFixed(3)} ` +
      `wallT=${(bb.wallTemperature - 273.15).toFixed(0)} C`);
  }
}
