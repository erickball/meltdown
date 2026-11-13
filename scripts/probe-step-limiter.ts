/**
 * What sets the step size: runs a preset (optionally from a snapshot) and,
 * every report interval, prints the steps taken, mean dt, the rejection
 * causes, and the nodes that most often topped the error estimate of the
 * accepted steps.
 *
 * Usage: npx tsx scripts/probe-step-limiter.ts <preset.json> <seconds> [every] [snapIn] [snapOut] [snapAt]
 *   snapAt: plant time at which to write snapOut (default: the end).
 */
import * as fs from 'fs';
import { buildSimFromFile } from './lib/sim-harness';
import { serializeSimulationState, deserializeSimulationState } from '../src/simulation/serialization';

const [presetPath, secArg, everyArg, snapIn, snapOut, snapAtArg] = process.argv.slice(2);
const seconds = parseFloat(secArg ?? '600');
const every = parseFloat(everyArg ?? '60');
const sim = buildSimFromFile(presetPath);
if (snapIn && snapIn !== '-') sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(snapIn, 'utf-8')));
const snapAt = snapAtArg ? parseFloat(snapAtArg) : Infinity;
let snapped = false;

const t0 = sim.state.time;
const end = t0 + seconds;
const wall0 = performance.now();
let next = t0 + every;
let steps = 0, rej = 0, wallLast = wall0, tLast = t0, tubesLast = 0;
const tops = new Map<string, number>();

function report() {
  const s = sim.state;
  const now = performance.now();
  const span = s.time - tLast;
  const causes = [...sim.solver.rejectionStats].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `${k}=${v}`).join(' ');
  const top = [...tops].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`t=${s.time.toFixed(0)} wall=${((now - wall0) / 1000).toFixed(0)}s x${(span / ((now - wallLast) / 1000)).toFixed(2)} ` +
    `steps=${steps} rej=${rej} meanDt=${(1000 * span / Math.max(steps, 1)).toFixed(2)}ms ` +
    `implicitTubes=${sim.solver.stiffOtsgTubeSteps - tubesLast}\n  rejections: ${causes}\n  top error: ${top}`);
  sim.solver.rejectionStats.clear();
  tops.clear();
  steps = 0; rej = 0; wallLast = now; tLast = s.time; tubesLast = sim.solver.stiffOtsgTubeSteps;
}

while (sim.state.time < end) {
  const r = sim.solver.advance(sim.state, Math.min(0.5, end - sim.state.time));
  sim.state = r.state;
  sim.state.pendingEvents = [];
  steps += r.metrics.subcycleCount ?? 0;
  rej += r.metrics.retriesThisFrame ?? 0;
  const c = r.metrics.topErrorContributors?.[0];
  if (c) { const k = `${c.nodeId}.${c.type}`; tops.set(k, (tops.get(k) ?? 0) + 1); }
  if (sim.state.time >= next) { report(); next += every; }
  if (!snapped && snapOut && sim.state.time >= snapAt) {
    fs.writeFileSync(snapOut, JSON.stringify(serializeSimulationState(sim.state)));
    snapped = true;
    console.log(`  snapshot -> ${snapOut} at t=${sim.state.time.toFixed(1)}`);
  }
}
report();
if (!snapped && snapOut && snapOut !== '-') fs.writeFileSync(snapOut, JSON.stringify(serializeSimulationState(sim.state)));
