/**
 * Why does the Xe-100's closed steam-dump valve node keep failing the
 * flow-solve closure check?
 *
 *   save:  npx tsx scripts/probe-msv-closure.ts save <preset.json> <seconds> <out.json>
 *   watch: npx tsx scripts/probe-msv-closure.ts watch <preset.json> <state.json> <seconds> [node]
 *
 * `save` runs the preset and writes the simulation state; `watch` resumes it
 * and prints the node and its connections on every step the solver rejects
 * for that node, plus a summary of its state at accepted steps.
 */
import * as fs from 'fs';
import { buildSimFromFile } from './lib/sim-harness';
import { serializeSimulationState, deserializeSimulationState } from '../src/simulation/serialization';
import type { SimulationState } from '../src/simulation/types';

const [mode, presetPath, a3, a4, a5] = process.argv.slice(2);
const TICK = 0.05;

if (mode === 'save') {
  const sim = buildSimFromFile(presetPath);
  const end = parseFloat(a3);
  while (sim.state.time < end) {
    sim.state = sim.solver.advance(sim.state, TICK).state;
    sim.state.pendingEvents = [];
  }
  fs.writeFileSync(a4, JSON.stringify(serializeSimulationState(sim.state)));
  const m = sim.solver.getMetrics();
  console.log(`saved t=${sim.state.time.toFixed(1)} to ${a4}; steps ${m.totalSteps} rejected ${m.rejectedSteps}`);
  process.exit(0);
}

const sim = buildSimFromFile(presetPath);
sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(a3, 'utf-8')));
const seconds = parseFloat(a4);
const nodeId = a5 ?? 'val-msv-1';

const describe = (s: SimulationState): string => {
  const n = s.flowNodes.get(nodeId)!;
  const f = n.fluid;
  const conns = s.flowConnections.filter(c => c.fromNodeId === nodeId || c.toNodeId === nodeId);
  const flows = conns.map(c => {
    const sign = c.toNodeId === nodeId ? 1 : -1;
    const other = c.toNodeId === nodeId ? c.fromNodeId : c.toNodeId;
    return `${other} ${(sign * c.massFlowRate).toExponential(2)}`;
  }).join(', ');
  return `m ${f.mass.toExponential(4)} kg, T ${(f.temperature - 273.15).toFixed(2)} C, ` +
    `P ${(f.pressure / 1e5).toFixed(3)} bar, ${f.phase}${f.phase === 'two-phase' ? ` x=${(f.quality ?? 0).toFixed(4)}` : ''}, ` +
    `u ${(f.internalEnergy / f.mass / 1e3).toFixed(2)} kJ/kg | in-flows ${flows}`;
};

let rejects = 0, printed = 0;
sim.solver.onStepRejected = (from, cand, dt, reason) => {
  if (!reason.startsWith(nodeId)) return;
  rejects++;
  if (printed++ >= 25) return;
  const d = sim.solver.lastClosureDetail;
  console.log(`REJECT t=${from.time.toFixed(3)} dt=${(dt * 1e3).toFixed(2)} ms: ${reason}`);
  if (d) console.log(`   detail predicted ${d.predicted.toExponential(3)} mismatch ${d.mismatch.toExponential(3)} ` +
    `response ${d.response.toExponential(3)} c ${d.c.toExponential(3)} mass ${d.mass.toExponential(3)}`);
  console.log(`   from: ${describe(from)}`);
  console.log(`   cand: ${describe(cand)}`);
};

const t0 = sim.state.time;
let next = t0;
while (sim.state.time < t0 + seconds) {
  sim.state = sim.solver.advance(sim.state, TICK).state;
  sim.state.pendingEvents = [];
  if (sim.state.time >= next) {
    console.log(`t=${sim.state.time.toFixed(1)} ${describe(sim.state)} | rejects so far ${rejects}`);
    next += seconds / 10;
  }
}
const m = sim.solver.getMetrics();
console.log(`done: steps ${m.totalSteps}, rejected ${m.rejectedSteps}, by ${nodeId}: ${rejects}`);
