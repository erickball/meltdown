/**
 * Slow-mode trace: a time series of chosen nodes' water mass and pressure,
 * every relief valve's sensed pressure and the fuel temperature, with each
 * jump marked - for plotting what a jump does against a fully resolved run
 * from the same snapshot.
 *
 * Usage: npx tsx scripts/probe-slow-trace.ts <preset.json> <snapIn|-> <seconds> <slow|ref> <out.csv> <node,node,...> [every]
 *   seconds = how long to run from the starting state; every = output interval (s, default 2).
 *   A jump writes one row before it and one after, flagged in the `jump` column (its length, s).
 */
import * as fs from 'fs';
import { buildSimFromFile } from './lib/sim-harness';
import { deserializeSimulationState } from '../src/simulation/serialization';
import { SlowModeController } from '../src/simulation/slow-mode';
import type { SimulationState } from '../src/simulation/types';

const [presetPath, snapIn, secArg, mode, outPath, nodeArg, everyArg] = process.argv.slice(2);
const sim = buildSimFromFile(presetPath);
if (snapIn && snapIn !== '-') sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(snapIn, 'utf-8')));
const end = sim.state.time + parseFloat(secArg);
const every = parseFloat(everyArg ?? '2');
const nodes = nodeArg.split(',');
for (const id of nodes) if (!sim.state.flowNodes.has(id)) throw new Error(`no flow node '${id}'`);
const reliefs = [...sim.state.components.valves].filter(([, v]) => v.relief).map(([id]) => id);
const fuelId = [...sim.state.thermalNodes.keys()].find(id => id.endsWith('-fuel'));
const slow = mode === 'slow' ? new SlowModeController({}) : null;

const rows: string[] = [['t', 'jump', 'window', 'Tfuel', ...nodes.flatMap(n => [`${n}.m`, `${n}.P`]), ...reliefs.map(r => `${r}.Psense`)].join(',')];
const row = (s: SimulationState, jump: number) => {
  const cols = [s.time.toFixed(3), jump.toFixed(3), slow ? slow.getStatus().phase : '',
    fuelId ? (s.thermalNodes.get(fuelId)!.temperature - 273.15).toFixed(4) : ''];
  for (const id of nodes) {
    const f = s.flowNodes.get(id)!.fluid;
    cols.push(f.mass.toPrecision(8), f.pressure.toPrecision(8));
  }
  for (const id of reliefs) {
    const v = s.components.valves.get(id)!;
    cols.push((s.flowNodes.get(v.relief!.senseNodeId)?.fluid.pressure ?? NaN).toPrecision(8));
  }
  rows.push(cols.join(','));
};

const wall0 = performance.now();
let next = sim.state.time;
let prev = sim.state;
while (sim.state.time < end) {
  if (sim.state.time >= next - 1e-9) { row(sim.state, 0); next += every; }
  prev = sim.state;
  const r = slow ? slow.advance(sim.solver, sim.state, 0.5) : sim.solver.advance(sim.state, 0.5);
  sim.state = r.state;
  sim.state.pendingEvents = [];
  if ('jump' in r && r.jump) {
    console.log(`JUMP t=${r.jump.time.toFixed(0)} +${r.jump.jump.toFixed(0)}s limited by ${r.jump.limitedBy} ${r.jump.detail ?? ''}`);
    // the state the jump left from is not available here (advance integrates
    // up to it and jumps in one call): the row before is the last tick's
    row(prev, 0);
    row(sim.state, r.jump.jump);
    next = sim.state.time + every;
  }
}
row(sim.state, 0);
fs.writeFileSync(outPath, rows.join('\n'));
const st = slow?.getStatus();
console.log(`done: t=${sim.state.time.toFixed(0)} wall=${((performance.now() - wall0) / 1000).toFixed(0)}s` +
  (st ? ` jumps=${st.jumps} skipped=${st.jumpedSeconds.toFixed(0)}s` : ''));
