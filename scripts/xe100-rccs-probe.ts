/**
 * Reactor cavity cooling system diagnostic for the Xe-100 preset.
 *
 * Walks the whole heat path the RCCS is supposed to carry - vessel metal ->
 * radiation -> panel metal -> water -> thermosyphon -> tank - and prints the
 * duty at each step, so it is visible where the heat actually lands rather
 * than only that it left the vessel.
 *
 * Usage: npx tsx scripts/xe100-rccs-probe.ts [seconds] [--lofc <t>]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import { getConvectionHeatRates } from '../src/simulation/operators/rate-operators';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100.json');

const args = process.argv.slice(2);
const seconds = parseFloat(args[0] || '600');
const lofcIdx = args.indexOf('--lofc');
const lofcTime = lofcIdx >= 0 ? parseFloat(args[lofcIdx + 1]) : Infinity;

const sim = buildSimFromFile(PRESET);
const st = () => sim.state;

const SIGMA_SB = 5.670374419e-8;
const tT = (id: string) => (st().thermalNodes.get(id)?.temperature ?? NaN) - 273.15;
const fT = (id: string) => (st().flowNodes.get(id)?.fluid.temperature ?? NaN) - 273.15;
const fP = (id: string) => (st().flowNodes.get(id)?.fluid.pressure ?? NaN) / 1e5;
const flow = (id: string) => {
  const c = st().flowConnections.find(c2 => c2.id === id);
  return c ? c.massFlowRate : NaN;
};

/** Radiation into the panels, the way the thermal operator computes it. */
function radDuty(): number {
  let q = 0;
  for (const c of st().thermalConnections) {
    if (!c.radiationCoeff || !c.toNodeId.startsWith('rccs-')) continue;
    const a = st().thermalNodes.get(c.fromNodeId);
    const b = st().thermalNodes.get(c.toNodeId);
    if (!a || !b) continue;
    q += SIGMA_SB * c.radiationCoeff * (a.temperature ** 4 - b.temperature ** 4);
  }
  return q;
}

/** What the water actually carries away: w * cp * (riser - downcomer). */
function waterDuty(): number {
  const w = flow('flow-rccs-panel-2-rccs-tank-1');
  const hot = st().flowNodes.get('rccs-panel-2');
  const cold = st().flowNodes.get('rccs-tank-1');
  if (!hot || !cold || !Number.isFinite(w)) return NaN;
  return w * 4185 * (hot.fluid.temperature - cold.fluid.temperature);
}

/** Convection off a set of connections, as the operator last computed it. */
function convDuty(match: (id: string) => boolean): number {
  let q = 0;
  for (const [id, rate] of getConvectionHeatRates()) {
    if (match(id)) q += rate;
  }
  return q;
}

console.log(
  '   t(s)  T_rpvwall  T_pnl_m1  T_pnl_m2  T_w1(C)  T_w2(C)  T_tank(C)  T_bui(C)  ' +
  'w(kg/s)  Q_rad(MW)  Q_water(MW)  Q_m>water  Q_pnl>air  Q_rpv>air  P_pnl1');
console.log('-'.repeat(158));

function line() {
  console.log(
    `${st().time.toFixed(0).padStart(7)} ` +
    `${tT('rv-1-wall').toFixed(1).padStart(10)} ` +
    `${tT('rccs-panel-1-wall').toFixed(1).padStart(9)} ` +
    `${tT('rccs-panel-2-wall').toFixed(1).padStart(9)} ` +
    `${fT('rccs-panel-1').toFixed(1).padStart(8)} ` +
    `${fT('rccs-panel-2').toFixed(1).padStart(8)} ` +
    `${fT('rccs-tank-1').toFixed(1).padStart(10)} ` +
    `${fT('bui-1').toFixed(1).padStart(9)} ` +
    `${flow('flow-rccs-panel-2-rccs-tank-1').toFixed(2).padStart(8)} ` +
    `${(radDuty() / 1e6).toFixed(3).padStart(10)} ` +
    `${(waterDuty() / 1e6).toFixed(3).padStart(12)} ` +
    `${(convDuty(id => /^convection-rccs-panel-\d-wall$/.test(id)) / 1e6).toFixed(3).padStart(10)} ` +
    `${(convDuty(id => id.startsWith('convection-rccs-') && id.endsWith('-outer')) / 1e6).toFixed(3).padStart(10)} ` +
    `${(convDuty(id => id === 'convection-rv-1-wall-outer') / 1e6).toFixed(3).padStart(10)} ` +
    `${fP('rccs-panel-1').toFixed(2).padStart(7)}`);
}

line();
let tripped = false;
const reportEvery = Math.max(1, Math.round(seconds / 30));
for (let t = 0; t < seconds; t++) {
  if (!tripped && st().time >= lofcTime) {
    const pump = st().components.pumps.get('pump-1');
    if (pump) pump.running = false;
    console.log(`--- Circulator tripped at t=${st().time.toFixed(0)} s ---`);
    tripped = true;
  }
  try {
    run(sim, 1, 0.05);
  } catch (e: any) {
    console.log(`\n!!! THREW at t=${st().time.toFixed(2)}s: ${e.message}`);
    break;
  }
  if (t % reportEvery === 0) line();
}
line();
