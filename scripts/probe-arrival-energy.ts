/**
 * Arrival-energy probe: run a preset (optionally from a snapshot) and
 * report what the in-step arrival-energy closure cost - accepted steps,
 * rejections by cause, wall time, lag re-solves, and the nodes whose
 * arrivals were lagged most often. A/B with ARRIVAL_ENERGY=0.
 *
 *   npx tsx scripts/probe-arrival-energy.ts <preset> <snap|-> <seconds> [every] [tick]
 */
import * as fs from 'fs';
import { buildSimFromFile } from './lib/sim-harness';
import { deserializeSimulationState } from '../src/simulation/serialization';

const [preset, snap, secArg, everyArg, tickArg] = process.argv.slice(2);
const sim = buildSimFromFile(preset);
if (snap && snap !== '-') sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(snap, 'utf-8')));
const ps = (sim.solver as any).pressureSolver;
const seconds = parseFloat(secArg), every = parseFloat(everyArg ?? '10'), tick = parseFloat(tickArg ?? '0.1');


const t0 = sim.state.time, end = t0 + seconds;
const wall0 = performance.now();
let steps = 0, next = t0;
const report = (): void => {
  const s = sim.state;
  const fuel = [...s.thermalNodes.values()].filter(n => /fuel/.test(n.id));
  const tFuel = fuel.length ? Math.max(...fuel.map(n => n.temperature)) - 273.15 : NaN;
  const rej = [...sim.solver.rejectionStats.values()].reduce((a, b) => a + b, 0);
  const pNodes = [...s.flowNodes.values()].filter(n => /^(rv-1|cb-1)$/.test(n.id)).map(n => `${n.id}=${(n.fluid.pressure / 1e5).toFixed(3)}`);
  console.log(`t=${s.time.toFixed(1)} wall=${((performance.now() - wall0) / 1000).toFixed(1)}s steps=${steps} rej=${rej} ` +
    `repick=${ps?.donorRepickResolves ?? 0} Tfuel=${tFuel.toFixed(1)} ${pNodes.join(' ')}`);
};
while (sim.state.time < end - 1e-9) {
  if (sim.state.time >= next - 1e-9) { report(); next += every; }
  const r = sim.solver.advance(sim.state, Math.min(tick, end - sim.state.time));
  sim.state = r.state;
  steps += r.metrics?.subcycleCount ?? 0;
  sim.state.pendingEvents = [];
}
report();
const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}:${v}`).join(' ');
console.log('rejections: ' + top(sim.solver.rejectionStats));
