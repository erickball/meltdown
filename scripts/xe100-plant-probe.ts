/**
 * Xe-100 plant-layout preset probe (src/presets/xe100-plant.json).
 *
 * Runs the preset headless and prints the design-point quantities: helium
 * flow split across the two circulators, core temperatures, primary pressure,
 * steam flow through each isolation valve, header conditions, the OTSG
 * partition, extraction flow and the building pressures, plus solver health.
 *
 * Usage: npx tsx scripts/xe100-plant-probe.ts [seconds] [--trip <t>]
 *   --trip <t>  stop both circulators at t seconds (loss of forced cooling)
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import type { SimulationState } from '../src/simulation/types';
import { evaluateOtsgSections } from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = process.env.PRESET ?? path.join(HERE, '..', 'src', 'presets', 'xe100-plant.json');

const args = process.argv.slice(2);
const seconds = parseFloat(args[0] || '60');
const tripIdx = args.indexOf('--trip');
const tripTime = tripIdx >= 0 ? parseFloat(args[tripIdx + 1]) : Infinity;

const sim = buildSimFromFile(PRESET);

function flow(state: SimulationState, id: string): number {
  const c = state.flowConnections.find(x => x.id === id);
  return c ? c.massFlowRate : NaN;
}
function T(state: SimulationState, id: string): number {
  return (state.flowNodes.get(id)?.fluid.temperature ?? NaN) - 273.15;
}
function P(state: SimulationState, id: string): number {
  return (state.flowNodes.get(id)?.fluid.pressure ?? NaN) / 1e5;
}
function m(state: SimulationState, id: string): number {
  return state.flowNodes.get(id)?.fluid.mass ?? NaN;
}
function otsgSections(state: SimulationState, id: string): string {
  const node = state.flowNodes.get(id);
  if (!node || !node.otsg) return '-';
  const { ev } = evaluateOtsgSections(state, id, node);
  const L = ev.sections.map(s => (100 * s.lengthFrac).toFixed(0)).join('/');
  return `${ev.sections[0].mass.toFixed(0)} ${L} T3=${(ev.sections[2].T - 273.15).toFixed(0)}`;
}

function header() {
  console.log(
    '    t(s)  HeA(kg/s) HeB(kg/s)  Tcore_in  Tcore_out  P_he(bar)  ' +
    'stm1  stm2  T_hdr(C)  P_hdr(bar)  m_tube(kg)  m1 L1/L2/L3 T3(C)        Pwr(MW)    gv  fwspd  ' +
    'extr(kg/s) T_fwh_out  P_rx(bar) P_sg(bar)  T_sgvessel'
  );
}

function line(state: SimulationState) {
  console.log(
    `${state.time.toFixed(1).padStart(8)} ` +
    `${flow(state, 'flow-tank-sg-1-pump-1a').toFixed(1).padStart(9)} ` +
    `${flow(state, 'flow-tank-sg-1-pump-1b').toFixed(1).padStart(9)} ` +
    `${T(state, 'rv-1').toFixed(1).padStart(9)} ` +
    `${T(state, 'cb-1').toFixed(1).padStart(10)} ` +
    `${P(state, 'cb-1').toFixed(2).padStart(10)} ` +
    `${flow(state, 'flow-hx-1-val-msiv-1').toFixed(1).padStart(5)} ` +
    `${flow(state, 'flow-hx-1-val-msiv-2').toFixed(1).padStart(5)} ` +
    `${T(state, 'pipe-ms-1').toFixed(1).padStart(9)} ` +
    `${P(state, 'pipe-ms-1').toFixed(1).padStart(11)} ` +
    `${m(state, 'hx-1-tube').toFixed(0).padStart(11)} ` +
    `${otsgSections(state, 'hx-1-tube').padStart(26)} ` +
    `${(state.neutronics.power / 1e6).toFixed(1).padStart(9)} ` +
    `${(state.flowNodes.get('turbine-1')?.governorValve ?? 1).toFixed(3).padStart(5)} ` +
    `${(state.components.pumps.get('fw-pump-1')?.speed ?? NaN).toFixed(3).padStart(6)} ` +
    `${flow(state, 'flow-val-bleed-1-turbine-1').toFixed(1).padStart(10)} ` +
    `${T(state, 'fwh-1-tube').toFixed(1).padStart(9)} ` +
    `${P(state, 'bui-rx').toFixed(3).padStart(10)} ` +
    `${P(state, 'bui-sg').toFixed(3).padStart(9)} ` +
    `${T(state, 'tank-sg-1').toFixed(0).padStart(10)}`
  );
}

header();
line(sim.state);

const reportEvery = Math.max(1, Math.round(seconds / 30));
let tripped = false;
for (let t = 0; t < seconds; t += 1) {
  if (!tripped && sim.state.time >= tripTime) {
    for (const id of ['pump-1a', 'pump-1b']) {
      const p = sim.state.components.pumps.get(id);
      if (p) { p.running = false; p.speed = 0; }
    }
    console.log(`--- both circulators tripped at t=${sim.state.time.toFixed(1)}s ---`);
    tripped = true;
  }
  try {
    run(sim, 1, 0.05);
  } catch (e: any) {
    console.log(`\n!!! THREW at t=${sim.state.time.toFixed(2)}s: ${e.message}`);
    break;
  }
  if (Math.round(t) % reportEvery === 0) line(sim.state);
}
line(sim.state);

console.log('\nFlows (kg/s):');
for (const c of sim.state.flowConnections) {
  if (Math.abs(c.massFlowRate) > 1e-9) {
    console.log(`  ${c.id.padEnd(44)} ${c.massFlowRate.toFixed(4).padStart(12)}`);
  }
}

console.log('\nBurst states:');
for (const [id, b] of sim.state.burstStates ?? []) {
  if (b.isBurst) console.log(`  BURST: ${id} (${b.componentLabel}) at ${(b.burstPressure / 1e5).toFixed(1)} bar, frac=${b.currentBreakFraction.toFixed(3)}`);
}

const stats = sim.solver.getMetrics();
console.log(`\nsteps=${stats.totalSteps} rejected=${stats.rejectedSteps} ` +
  `(${(100 * stats.rejectedSteps / Math.max(1, stats.totalSteps)).toFixed(0)}%) dt=${(stats.currentDt * 1e3).toFixed(2)}ms`);
