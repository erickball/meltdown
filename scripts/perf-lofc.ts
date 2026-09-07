/**
 * Loss-of-primary-flow performance probe.
 *
 * Runs the Xe-100 (or any preset) steady for a while, trips the helium
 * circulator, and reports the same numbers perf-xe100.ts does - but WINDOWED,
 * so the cost of the transient can be separated from the cost of the steady
 * plant: per-window speed, steps, rejections, dt, rejection causes and error
 * contributors, plus the plant diagnostics that say what the OTSG and the
 * sliver steam nodes off it are doing.
 *
 * Usage: npx tsx scripts/perf-lofc.ts [seconds] [tripTime] [tickDt] [preset]
 *
 * Env:
 *   TRIP=circulator (default) | sbo | none | scenario
 *     circulator - trip pump-1 only; every other control keeps acting
 *     sbo        - circulator + feed + condensate pumps, turbine shut (as
 *                  xe100-sbo.json does), applied by the same scenario actions
 *     scenario   - fire nothing here; the preset's own scenario block acts
 *     none       - no fault at all (steady baseline over the same window)
 *   FEED=off      - at the trip, put the feedwater controller in manual at 0
 *   WINDOW=10     - reporting window in seconds
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { applyScenarioAction } from '../src/simulation/scenario';
import type { ScenarioAction } from '../src/simulation/scenario-types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const seconds = parseFloat(args[0] || '180');
const tripTime = parseFloat(args[1] || '20');
const tickDt = parseFloat(args[2] || '0.1');
const preset = args[3] || path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const TRIP = (process.env.TRIP || 'circulator').toLowerCase();
const WINDOW = parseFloat(process.env.WINDOW || '10');

const sim = buildSimFromFile(preset);
console.log(`preset=${path.basename(preset)} trip=${TRIP}@${tripTime}s feed=${process.env.FEED || 'auto'} ` +
  `nodes=${sim.state.flowNodes.size} conns=${sim.state.flowConnections.length}`);

const TRIP_ACTIONS: Record<string, ScenarioAction[]> = {
  circulator: [{ kind: 'pump', id: 'pump-1', running: false, speed: 0 }],
  sbo: [
    { kind: 'pump', id: 'pump-1', running: false, speed: 0 },
    { kind: 'pump', id: 'fw-pump-1', running: false, speed: 0 },
    { kind: 'pump', id: 'cond-pump-1', running: false, speed: 0 },
    { kind: 'controller', id: 'ctl-fw-1', mode: 'manual', manualOutput: 0 },
    { kind: 'controller', id: 'ctl-msp-1', mode: 'manual', manualOutput: 0.02 },
    { kind: 'turbine-governor', id: 'turbine-1', value: 0.02 },
    { kind: 'valve', id: 'val-bleed-1', position: 0 },
    { kind: 'controller', id: 'ctl-fwh-1', mode: 'manual', manualOutput: 0 },
  ],
  none: [],
  scenario: [],
};
const actions = TRIP_ACTIONS[TRIP];
if (!actions) throw new Error(`unknown TRIP=${TRIP}`);
if (process.env.FEED === 'off' && TRIP !== 'sbo') {
  actions.push({ kind: 'controller', id: 'ctl-fw-1', mode: 'manual', manualOutput: 0 });
}

// --- accounting ------------------------------------------------------------
const opTotals = new Map<string, number>();
const opWindow = new Map<string, number>();
const contribWindow = new Map<string, number>();
const contribTotals = new Map<string, number>();
let rejSnapshot = new Map<string, number>();
let lastSteps = 0, lastRej = 0, windowTicks = 0, windowWallStart = performance.now();

function rejectionDelta(): Array<[string, number]> {
  const now = new Map(sim.solver.rejectionStats);
  const out: Array<[string, number]> = [];
  for (const [k, v] of now) {
    const d = v - (rejSnapshot.get(k) || 0);
    if (d > 0) out.push([k, d]);
  }
  rejSnapshot = now;
  return out.sort((a, b) => b[1] - a[1]);
}

const st = () => sim.state;
const P = (id: string) => (st().flowNodes.get(id)?.fluid.pressure ?? NaN) / 1e5;
const W = (id: string) => st().flowConnections.find(c => c.id === id)?.massFlowRate ?? NaN;
const heFlow = () => W('flow-cv-1-rv-1');
function otsg(id: string) {
  const n: any = st().flowNodes.get(id);
  const o = n?.otsg;
  const ev = o?.lastEval;
  return {
    m1: o?.m1 ?? NaN,
    mass: n?.fluid.mass ?? NaN,
    P: (ev?.P ?? n?.fluid.pressure ?? NaN) / 1e5,
    L: ev && ev.lengthFracs
      ? `${(100 * ev.lengthFracs[0]).toFixed(0)}/${(100 * ev.lengthFracs[1]).toFixed(0)}/${(100 * ev.lengthFracs[2]).toFixed(0)}`
      : '-',
    T3: ev?.T3 ? ev.T3 - 273.15 : NaN,
  };
}

function header() {
  console.log('\n  window       x-rt  steps  rej%  dt(ms)  He(kg/s)  Pwr(MW)  Ptube(bar)  Mtube(kg)  m1(kg)  L1/2/3     T3(C)  Wfeed  Wsteam  Pprel  Pleak   Pmsv');
}
function line(t0: number, t1: number) {
  const stats = sim.solver.getMetrics();
  const wallSec = (performance.now() - windowWallStart) / 1000;
  const steps = stats.totalSteps - lastSteps;
  const rej = stats.rejectedSteps - lastRej;
  const o = otsg('hx-1-tube');
  console.log(
    `  ${t0.toFixed(0).padStart(4)}-${t1.toFixed(0).padStart(4)} ` +
    `${((t1 - t0) / wallSec).toFixed(2).padStart(6)}x ` +
    `${steps.toString().padStart(6)} ` +
    `${(100 * rej / Math.max(1, steps)).toFixed(0).padStart(4)}% ` +
    `${(stats.currentDt * 1e3).toFixed(1).padStart(6)} ` +
    `${heFlow().toFixed(1).padStart(9)} ` +
    `${(st().neutronics.power / 1e6).toFixed(1).padStart(8)} ` +
    `${o.P.toFixed(1).padStart(11)} ` +
    `${o.mass.toFixed(0).padStart(10)} ` +
    `${o.m1.toFixed(0).padStart(7)} ` +
    `${o.L.padStart(9)} ` +
    `${o.T3.toFixed(0).padStart(9)} ` +
    `${W('flow-val-fwcv-1-hx-1').toFixed(1).padStart(6)} ` +
    `${W('flow-hx-1-turbine-1').toFixed(1).padStart(7)} ` +
    `${P('val-prel-1').toFixed(1).padStart(6)} ` +
    `${P('val-leak-1').toFixed(1).padStart(6)} ` +
    `${P('val-msv-1').toFixed(1).padStart(6)}`);
  const rd = rejectionDelta();
  if (rd.length) {
    console.log('      rej: ' + rd.slice(0, 5).map(([k, n]) => `${k}=${n}`).join('  '));
  }
  const cs = [...contribWindow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (cs.length) {
    console.log('      err: ' + cs.map(([k, v]) => `${k} ${(100 * v / Math.max(1, windowTicks)).toFixed(0)}%`).join('  '));
  }
  const ow = [...opWindow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (ow.length) {
    console.log('      op:  ' + ow.map(([k, v]) => `${k} ${(100 * v / 1000 / wallSec).toFixed(0)}%`).join('  '));
  }
  contribWindow.clear(); opWindow.clear();
  lastSteps = stats.totalSteps; lastRej = stats.rejectedSteps;
  windowTicks = 0; windowWallStart = performance.now();
}

// --- run -------------------------------------------------------------------
const wallStart = performance.now();
let tripped = false;
let nextReport = WINDOW;
let windowStart = 0;
let minDt = Infinity;
header();
const ticks = Math.round(seconds / tickDt);
for (let i = 0; i < ticks; i++) {
  if (!tripped && sim.state.time >= tripTime && TRIP !== 'scenario') {
    for (const a of actions) applyScenarioAction(sim.state, a);
    if (actions.length) console.log(`  --- t=${sim.state.time.toFixed(1)}: ${TRIP} trip applied ---`);
    tripped = true;
  }
  let result;
  try {
    result = sim.solver.advance(sim.state, tickDt);
  } catch (e) {
    console.log(`\n!! diverged at t=${sim.state.time.toFixed(2)}: ${(e as Error).message.slice(0, 400)}`);
    break;
  }
  sim.state = result.state;
  for (const ev of sim.state.pendingEvents ?? []) {
    if (ev.type === 'scenario' || ev.type === 'burst') console.log(`  --- ${ev.message} ---`);
  }
  sim.state.pendingEvents = [];
  windowTicks++;
  if (Number.isFinite(result.metrics?.minDtUsed)) minDt = Math.min(minDt, result.metrics.minDtUsed);
  for (const [name, ms] of result.metrics.operatorTimes) {
    opTotals.set(name, (opTotals.get(name) || 0) + ms);
    opWindow.set(name, (opWindow.get(name) || 0) + ms);
  }
  for (const c of result.metrics.topErrorContributors) {
    const key = `${c.nodeId}[${c.type}]`;
    contribTotals.set(key, (contribTotals.get(key) || 0) + c.contribution);
    contribWindow.set(key, (contribWindow.get(key) || 0) + c.contribution);
  }
  if (sim.state.time >= nextReport - 1e-9) {
    line(windowStart, sim.state.time);
    windowStart = sim.state.time;
    nextReport += WINDOW;
  }
}

const wallSec = (performance.now() - wallStart) / 1000;
const stats = sim.solver.getMetrics();
console.log(`\nsimulated ${sim.state.time.toFixed(1)}s in ${wallSec.toFixed(2)}s wall = ` +
  `${(sim.state.time / wallSec).toFixed(3)}x realtime`);
console.log(`steps=${stats.totalSteps} rejected=${stats.rejectedSteps} ` +
  `(${(100 * stats.rejectedSteps / Math.max(1, stats.totalSteps)).toFixed(0)}%) ` +
  `final dt=${(stats.currentDt * 1e3).toFixed(2)}ms min dt=${(minDt * 1e3).toFixed(3)}ms ` +
  `wall/step=${(1e3 * wallSec / Math.max(1, stats.totalSteps)).toFixed(3)}ms`);

console.log('\noperator wall time:');
for (const [name, ms] of [...opTotals.entries()].sort((a, b) => b[1] - a[1])) {
  if (ms / 1000 < 0.01) continue;
  console.log(`  ${name.padEnd(34)} ${(ms / 1000).toFixed(2)}s  ${(100 * ms / 1000 / wallSec).toFixed(1)}% of wall`);
}
console.log('\nrejection causes (whole run):');
for (const [cause, n] of [...sim.solver.rejectionStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)) {
  console.log(`  ${cause.padEnd(52)} ${n}`);
}
console.log('\ntop error contributors (summed share, whole run):');
const totalTicks = Math.max(1, Math.round(sim.state.time / tickDt));
for (const [key, share] of [...contribTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${key.padEnd(42)} ${(100 * share / totalTicks).toFixed(1)}%`);
}
