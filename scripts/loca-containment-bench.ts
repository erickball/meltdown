/**
 * Bounded containment benchmark for the wall heat-transfer model.
 *
 * A cold-leg break on the four-loop PWR, run for a FIXED 120 s of plant time
 * past the break, reporting the one thing the condensation model actually
 * decides - how much of the blowdown the containment shell takes out of the
 * atmosphere - plus wall-clock and solver health so a change that buys
 * accuracy with stiffness shows up rather than hiding.
 *
 * Written to be run on both sides of a change: the numbers only mean
 * something as a pair.
 *
 * Usage: npx tsx scripts/loca-containment-bench.ts [seconds]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { getConvectionHeatRates } from '../src/simulation/operators/rate-operators';
import { triggerScram } from '../src/simulation/operators';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'w4loop.json');

const seconds = parseFloat(process.argv[2] ?? '120');
const sim = buildSimFromFile(PRESET);
const st = () => sim.state;

let minDt = Infinity;
let steps = 0;
let rejects = 0;
function advance(secs: number, dt = 0.02) {
  const ticks = Math.round(secs / dt);
  for (let i = 0; i < ticks; i++) {
    const r = sim.solver.advance(sim.state, dt);
    sim.state = r.state;
    sim.state.pendingEvents = [];
    const m = r.metrics as any;
    if (m) {
      steps += m.stepsAttempted ?? 0;
      rejects += m.stepsRejected ?? 0;
      if (Number.isFinite(m.minDtUsed)) minDt = Math.min(minDt, m.minDtUsed);
    }
  }
}

const P = (id: string) => (st().flowNodes.get(id)?.fluid.pressure ?? NaN) / 1e5;
const T = (id: string) => (st().flowNodes.get(id)?.fluid.temperature ?? NaN) - 273.15;

/** Heat the containment shell is pulling out of its atmosphere (W). */
function shellDuty(): number {
  let q = 0;
  for (const [id, rate] of getConvectionHeatRates()) {
    if (id === 'convection-bui-1-wall') q += rate;
  }
  return q;   // negative = into the wall
}

console.log('\n=== w4loop LOCA containment benchmark ===');
advance(60);
const brk = st().components.valves.get('val-break-1');
if (!brk) throw new Error('val-break-1 not found');
brk.position = 1.0;
sim.state = triggerScram(sim.state, 'LOCA');
for (const id of ['hpi-pump-1', 'lpi-pump-1']) {
  const p = st().components.pumps.get(id);
  if (p) { p.running = true; p.speed = 1.0; }
}
console.log(`--- break opened at t=${st().time.toFixed(0)} s ---`);
console.log('   t(s)  P_cont(bar)  T_cont(C)  T_wall(C)  shell(MW)  peak_P(bar)');

const t0 = Date.now();
let peakP = P('bui-1');
let rcps = false;
const step = Math.max(10, Math.round(seconds / 12));
for (let t = 0; t < seconds; t += step) {
  advance(step);
  if (!rcps && P('rv-1') < 100) {
    for (let i = 1; i <= 4; i++) {
      const p = st().components.pumps.get(`pump-${i}`);
      if (p) p.running = false;
    }
    rcps = true;
  }
  peakP = Math.max(peakP, P('bui-1'));
  const wall = st().thermalNodes.get('bui-1-wall');
  console.log(
    `${st().time.toFixed(0).padStart(7)} ` +
    `${P('bui-1').toFixed(3).padStart(12)} ` +
    `${T('bui-1').toFixed(1).padStart(10)} ` +
    `${(wall ? wall.temperature - 273.15 : NaN).toFixed(1).padStart(10)} ` +
    `${(shellDuty() / 1e6).toFixed(2).padStart(10)} ` +
    `${peakP.toFixed(3).padStart(12)}`);
}

const wall = st().thermalNodes.get('bui-1-wall');
console.log(`\npeak containment pressure: ${peakP.toFixed(3)} bar`);
console.log(`containment wall reached:  ${(wall ? wall.temperature - 273.15 : NaN).toFixed(1)} C`);
console.log(`solver: ${steps} steps, ${rejects} rejected ` +
  `(${steps > 0 ? (100 * rejects / steps).toFixed(0) : '-'}%), min dt ${(minDt * 1000).toFixed(2)} ms`);
console.log(`wall clock: ${((Date.now() - t0) / 1000).toFixed(1)} s for ${seconds} s of plant time`);
