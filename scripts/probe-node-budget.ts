/**
 * Mass budget of one flow node over time: its water mass, energy, pressure
 * and temperature, every connection's flow into it, and the state of any
 * valves on those connections, sampled at a fixed interval to CSV. Written to
 * find what drives a slow inventory oscillation (xe100-dlofc bui-1).
 *
 * SLOW=1 runs under slow mode; each jump is printed and marked in the CSV.
 *
 * Usage: npx tsx scripts/probe-node-budget.ts <preset.json> <seconds> <nodeId> <csvOut>
 *          [snapIn] [every=1] [extraNodeIds,comma,separated]
 */
import * as fs from 'fs';
import { buildSimFromFile } from './lib/sim-harness';
import { deserializeSimulationState } from '../src/simulation/serialization';
import { SlowModeController } from '../src/simulation/slow-mode';

const [presetPath, secArg, nodeId, csvOut, snapIn, everyArg, extraArg] = process.argv.slice(2);
const sim = buildSimFromFile(presetPath);
if (snapIn && snapIn !== '-') sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(snapIn, 'utf-8')));
const every = parseFloat(everyArg ?? '1');
const extras = (extraArg ?? '').split(',').filter(Boolean);
const end = sim.state.time + parseFloat(secArg);

const conns = [...sim.state.flowConnections].filter(c => c.fromNodeId === nodeId || c.toNodeId === nodeId);
const valveOn = (connId: string) => [...sim.state.components.valves.values()].find(v => v.connectedFlowPath === connId);
const slow = process.env.SLOW === '1' ? new SlowModeController({}) : null;
let jumped = '';
const header = ['t', 'jump', 'm', 'u_kJkg', 'P_bar', 'T_C', 'ncg_kg'];
for (const c of conns) header.push(`W_in:${c.fromNodeId === nodeId ? c.toNodeId : c.fromNodeId}`);
for (const x of extras) header.push(`${x}.m`, `${x}.P_bar`, `${x}.T_C`, `${x}.ncg_mol`);
const traceConn = process.env.TRACE_CONN;
if (traceConn) header.push('drive_Pa', 'fric_Pa', 'flowPhase', 'rho_flow');
for (const v of sim.state.components.valves.values()) if (v.relief) header.push(`${v.id}.pos`, `${v.id}.lifts`);
const rows: string[] = [header.join(',')];

function sample() {
  const s = sim.state;
  const n = s.flowNodes.get(nodeId)!;
  const ncg = n.fluid.ncg ? Object.values(n.fluid.ncg).reduce((a: number, b: any) => a + (typeof b === 'number' ? b : 0), 0) : 0;
  const r: (string | number)[] = [s.time.toFixed(2), jumped, n.fluid.mass.toFixed(3),
    (n.fluid.internalEnergy / n.fluid.mass / 1e3).toFixed(2), (n.fluid.pressure / 1e5).toFixed(5),
    (n.fluid.temperature - 273.15).toFixed(3), ncg.toFixed(3)];
  for (const c of s.flowConnections) {
    if (!(c.fromNodeId === nodeId || c.toNodeId === nodeId)) continue;
    r.push((c.toNodeId === nodeId ? c.massFlowRate : -c.massFlowRate).toFixed(5));
  }
  for (const x of extras) {
    const e = s.flowNodes.get(x)!;
    const nm = e.fluid.ncg ? Object.values(e.fluid.ncg).reduce((a: number, b: any) => a + (typeof b === 'number' ? b : 0), 0) : 0;
    r.push(e.fluid.mass.toFixed(3), (e.fluid.pressure / 1e5).toFixed(5), (e.fluid.temperature - 273.15).toFixed(3), nm.toFixed(4));
  }
  if (traceConn) {
    const c: any = s.flowConnections.find(x => x.id === traceConn);
    const d = c?.debug ?? {};
    r.push(d.dP_driving?.toFixed?.(2) ?? '', d.dP_friction?.toFixed?.(2) ?? '', d.flowPhase ?? '', d.rho_flow?.toFixed?.(2) ?? '');
  }
  for (const v of s.components.valves.values()) if (v.relief) r.push(v.position.toFixed(4), String(v.liftCount ?? 0));
  rows.push(r.join(','));
  jumped = '';
}

sample();
let next = sim.state.time + every;
const wall0 = performance.now();
while (sim.state.time < end) {
  const tick = Math.min(every, end - sim.state.time);
  const res = slow ? slow.advance(sim.solver, sim.state, tick) : sim.solver.advance(sim.state, tick);
  sim.state = res.state;
  if (slow && 'jump' in res && (res as any).jump) {
    const j = (res as any).jump;
    jumped = j.jump.toFixed(1);
    console.log(`jump t=${j.time.toFixed(1)} +${j.jump.toFixed(1)}s limited by ${j.limitedBy} ${j.detail ?? ''}`);
    next = sim.state.time;
  }
  sim.state.pendingEvents = [];
  if (sim.state.time >= next - 1e-9) { sample(); next += every; }
}
fs.writeFileSync(csvOut, rows.join('\n'));
console.log(`done t=${sim.state.time.toFixed(0)} wall=${((performance.now() - wall0) / 1000).toFixed(0)}s rows=${rows.length}`);
console.log('connections:', conns.map(c => `${c.id} (${c.fromNodeId}->${c.toNodeId})`).join('; '));
