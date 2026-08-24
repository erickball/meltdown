/**
 * HP feedwater heater diagnostic for the Xe-100 preset.
 *
 * The shell was bursting inside the first minute of every run, so this walks
 * the heater's own balance second by second: what the extraction valve lets
 * in, what the drain valve lets out, where the level and the shell pressure
 * go, and what the two controllers driving those valves are asking for.
 *
 * Usage: npx tsx scripts/xe100-fwh-probe.ts [seconds]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100.json');

const seconds = parseFloat(process.argv[2] || '120');
const sim = buildSimFromFile(PRESET);

const st = () => sim.state;
const P = (id: string) => (st().flowNodes.get(id)?.fluid.pressure ?? NaN) / 1e5;
const T = (id: string) => (st().flowNodes.get(id)?.fluid.temperature ?? NaN) - 273.15;
const m = (id: string) => st().flowNodes.get(id)?.fluid.mass ?? NaN;
const x = (id: string) => st().flowNodes.get(id)?.fluid.quality ?? NaN;
const flow = (id: string) => {
  const c = st().flowConnections.find(c2 => c2.id === id);
  return c ? c.massFlowRate : NaN;
};
const vpos = (id: string) => st().components.valves.get(id)?.position ?? NaN;

console.log(
  '   t(s)  P_shell  P_tube  T_tube_out  m_shell  x_shell  ' +
  'bleed(kg/s)  drain(kg/s)  v_bleed  v_drain  P_turb_in  stm_turb');
console.log('-'.repeat(120));

function line() {
  const bleed = flow('flow-val-bleed-1-fwh-1');
  const drain = flow('flow-fwh-1-val-fwhdr-1');
  const toTurb = flow('flow-hx-1-turbine-1') +
    flow('flow-hx-1-turbine-1-hx-1-tube-2-b2-inlet');
  console.log(
    `${st().time.toFixed(0).padStart(7)} ` +
    `${P('fwh-1-shell').toFixed(2).padStart(8)} ` +
    `${P('fwh-1-tube').toFixed(1).padStart(7)} ` +
    `${T('fwh-1-tube').toFixed(1).padStart(11)} ` +
    `${m('fwh-1-shell').toFixed(0).padStart(8)} ` +
    `${x('fwh-1-shell').toFixed(3).padStart(8)} ` +
    `${bleed.toFixed(2).padStart(12)} ` +
    `${drain.toFixed(2).padStart(12)} ` +
    `${vpos('val-bleed-1').toFixed(3).padStart(8)} ` +
    `${vpos('val-fwhdr-1').toFixed(3).padStart(8)} ` +
    `${P('turbine-1').toFixed(2).padStart(10)} ` +
    `${toTurb.toFixed(1).padStart(9)}`);
}

line();
for (let t = 0; t < seconds; t++) {
  try {
    run(sim, 1, 0.05);
  } catch (e: any) {
    console.log(`\n!!! THREW at t=${st().time.toFixed(2)}s: ${e.message}`);
    break;
  }
  if (t % 5 === 0) line();
}
line();

for (const [id, b] of st().burstStates ?? []) {
  if ((b as any).isBurst) console.log(`BURST: ${id}`);
}
