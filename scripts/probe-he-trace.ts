/**
 * Helium trace: moles of He, pressure and temperature in chosen nodes, and the
 * mass flow of every connection touching them, at a fixed interval of plain
 * integration from a snapshot.
 * Usage: npx tsx scripts/probe-he-trace.ts <preset.json> <snapIn> <seconds> <every> <out.csv> <nodePrefix,nodePrefix,...>
 */
import * as fs from 'fs';
import { buildSimFromFile } from './lib/sim-harness';
import { deserializeSimulationState } from '../src/simulation/serialization';

const [presetPath, snapIn, secArg, everyArg, outPath, prefArg] = process.argv.slice(2);
const sim = buildSimFromFile(presetPath);
sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(snapIn, 'utf-8')));
const prefixes = prefArg.split(',');
const nodes = [...sim.state.flowNodes.keys()].filter(id => prefixes.some(p => id.startsWith(p)));
const conns = sim.state.flowConnections.filter(c => nodes.includes(c.fromNodeId) || nodes.includes(c.toNodeId)).map(c => c.id);
console.log('nodes: ' + nodes.join(' '));
for (const c of sim.state.flowConnections.filter(c => conns.includes(c.id))) console.log(`conn ${c.id}: ${c.fromNodeId} -> ${c.toNodeId}`);
const rows = [['t', ...nodes.flatMap(n => [`${n}.He`, `${n}.P`, `${n}.T`]), ...conns.map(c => `${c}.mdot`)].join(',')];
const end = sim.state.time + parseFloat(secArg);
const every = parseFloat(everyArg);
let steps = 0;
while (sim.state.time < end - 1e-9) {
  const s = sim.state;
  const cols = [s.time.toFixed(3)];
  for (const id of nodes) {
    const f = s.flowNodes.get(id)!.fluid;
    cols.push(((f.ncg as unknown as Record<string, number> | undefined)?.He ?? 0).toPrecision(9), f.pressure.toPrecision(9), f.temperature.toPrecision(8));
  }
  for (const id of conns) cols.push((s.flowConnections.find(c => c.id === id)!.massFlowRate).toPrecision(6));
  rows.push(cols.join(','));
  const r = sim.solver.advance(sim.state, every);
  sim.state = r.state;
  sim.state.pendingEvents = [];
  steps++;
}
fs.writeFileSync(outPath, rows.join('\n'));
console.log('done', steps);
