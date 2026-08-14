/**
 * Xe-100 convergence probe.
 *
 * Runs the preset headless and prints the design-point quantities that matter
 * (helium flow and core dT, steam flow and conditions, SG duty, primary
 * pressure) plus solver health, so the preset can be tuned quickly.
 *
 * Usage: npx tsx scripts/xe100-probe.ts [seconds] [--leak <t_open> <opening>]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import type { SimulationState } from '../src/simulation/types';
import { totalMoles } from '../src/simulation/gas-properties';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100.json');

const args = process.argv.slice(2);
const seconds = parseFloat(args[0] || '60');
const leakIdx = args.indexOf('--leak');
const leakTime = leakIdx >= 0 ? parseFloat(args[leakIdx + 1]) : Infinity;
const leakOpening = leakIdx >= 0 ? parseFloat(args[leakIdx + 2] ?? '1') : 0;

const sim = buildSimFromFile(PRESET);

function flow(state: SimulationState, from: string, to: string): number {
  const c = state.flowConnections.find(x => x.id === `flow-${from}-${to}`);
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

function header() {
  console.log(
    '    t(s)  He(kg/s)  Tcore_in  Tcore_out   P_he(bar)  ' +
    'stm(kg/s)  T_stm(C)  P_stm(bar)  m_tube(kg)  m1/m3+T3(C)             Pwr(MW)    gv  fwspd  ' +
    'Tev_sh(C)  Tinner  Tannul  T_sgvessel'
  );
}

function line(state: SimulationState) {
  const shell = state.flowNodes.get('hx-1-shell')!;
  console.log(
    `${state.time.toFixed(1).padStart(8)} ` +
    `${flow(state, "cv-1", "rv-1").toFixed(1).padStart(9)} ` +
    `${T(state, 'rv-1').toFixed(1).padStart(9)} ` +
    `${T(state, 'cb-1').toFixed(1).padStart(10)} ` +
    `${P(state, 'cb-1').toFixed(2).padStart(11)} ` +
    `${flow(state, 'hx-1', 'turbine-1').toFixed(1).padStart(10)} ` +
    `${T(state, 'hx-1-tube').toFixed(1).padStart(9)} ` +
    `${P(state, 'hx-1-tube').toFixed(1).padStart(11)} ` +
    `${m(state, 'hx-1-tube').toFixed(0).padStart(11)} ` +
    `${(() => { const o = (state.flowNodes.get('hx-1-tube') as any)?.otsg; if (!o) return '-'; const t = o.lastEval ? ' T3=' + (o.lastEval.T3 - 273.15).toFixed(0) : ''; return o.m1.toFixed(0) + '/' + o.m3.toFixed(1) + t; })().padStart(22)} ` +
    `${(state.neutronics.power / 1e6).toFixed(1).padStart(9)} ` +
    `${(state.flowNodes.get('turbine-1')?.governorValve ?? 1).toFixed(3).padStart(5)} ` +
    `${(state.components.pumps.get('fw-pump-1')?.speed ?? NaN).toFixed(3).padStart(6)} ` +
    `${(shell.fluid.temperature - 273.15).toFixed(1).padStart(9)} ` +
    `${T(state, 'cv-1-inner').toFixed(0).padStart(7)} ` +
    `${T(state, 'cv-1-annulus').toFixed(0).padStart(7)} ` +
    `${T(state, 'tank-sg-1').toFixed(0).padStart(9)}`
  );
}

header();
line(sim.state);

const reportEvery = Math.max(1, Math.round(seconds / 30));
let leakDone = false;
for (let t = 0; t < seconds; t += 1) {
  if (!leakDone && sim.state.time >= leakTime) {
    const v = sim.state.components.valves.get('val-leak-1');
    if (v) {
      v.position = leakOpening;
      console.log(`--- SG tube leak opened to ${leakOpening} at t=${sim.state.time.toFixed(1)}s ---`);
    } else {
      console.log('!!! val-leak-1 valve state not found');
    }
    leakDone = true;
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

// Where did the helium go?
console.log('\nHelium inventory by node (mol):');
let heTotal = 0;
for (const [id, n] of sim.state.flowNodes) {
  const he = n.fluid.ncg?.He ?? 0;
  if (he > 1e-6) {
    console.log(`  ${id.padEnd(18)} ${he.toFixed(1).padStart(12)}  ` +
      `P=${(n.fluid.pressure / 1e5).toFixed(3).padStart(9)}bar  T=${(n.fluid.temperature - 273.15).toFixed(1)}C` +
      (n.isBoundary ? '   [BOUNDARY]' : ''));
  }
  if (!n.isBoundary) heTotal += he;
}
console.log(`  total (non-boundary): ${heTotal.toFixed(1)} mol`);
const env = sim.state.environmentalRelease;
if (env) console.log(`  environmentalRelease He: ${(env.He ?? 0).toFixed(1)} mol`);

console.log('\nFlows (kg/s):');
for (const c of sim.state.flowConnections) {
  if (Math.abs(c.massFlowRate) > 1e-9) {
    console.log(`  ${c.id.padEnd(38)} ${c.massFlowRate.toFixed(4).padStart(12)}`);
  }
}

console.log('\nBurst states:');
for (const [id, b] of sim.state.burstStates ?? []) {
  if (b.isBurst) console.log(`  BURST: ${id} (${b.componentLabel}) at ${(b.burstPressure / 1e5).toFixed(1)} bar, frac=${b.currentBreakFraction.toFixed(3)}`);
}

// Solver health
const stats = sim.solver.getMetrics();
console.log(`\nsteps=${stats.totalSteps} rejected=${stats.rejectedSteps} ` +
  `(${(100 * stats.rejectedSteps / Math.max(1, stats.totalSteps)).toFixed(0)}%) dt=${(stats.currentDt * 1e3).toFixed(2)}ms`);

// Helium inventory check
const shell = sim.state.flowNodes.get('hx-1-shell')!;
console.log(`\nSG shell: ${shell.fluid.mass.toFixed(4)} kg water, ` +
  `${totalMoles(shell.fluid.ncg ?? {} as any).toFixed(0)} mol NCG, ` +
  `T=${(shell.fluid.temperature - 273.15).toFixed(1)}C, P=${(shell.fluid.pressure / 1e5).toFixed(3)} bar, ` +
  `phase=${shell.fluid.phase}`);
