/**
 * Slow-mode event log: every relief-valve lift, every change of the reason a
 * window did not jump, every jump, and the solver's step count per interval -
 * for finding out why a plant is not being fast-forwarded.
 *
 * Usage: npx tsx scripts/probe-slow-holds.ts <preset.json> <seconds> <slow|ref> [every] [snapIn] [snapOut] [snapAt]
 */
import * as fs from 'fs';
import { buildSimFromFile } from './lib/sim-harness';
import { serializeSimulationState, deserializeSimulationState } from '../src/simulation/serialization';
import { SlowModeController } from '../src/simulation/slow-mode';

const [presetPath, secArg, mode, everyArg, snapIn, snapOut, snapAtArg] = process.argv.slice(2);
const sim = buildSimFromFile(presetPath);
if (snapIn && snapIn !== '-') sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(snapIn, 'utf-8')));
const end = parseFloat(secArg);
const every = parseFloat(everyArg ?? '300');
const snapAt = snapAtArg ? parseFloat(snapAtArg) : end;
const slow = mode === 'slow' ? new SlowModeController(process.env.SLOW_CFG ? JSON.parse(process.env.SLOW_CFG) : {}) : null;

const wall0 = performance.now();
let steps = 0, stepsAt = 0, next = sim.state.time + every, lastHold = '', snapped = false;
const lifts = new Map<string, number>();
const liftsInInterval = new Map<string, number>();
const lastLiftTime = new Map<string, number>();
const sense = (id: string) => {
  const v = sim.state.components.valves.get(id)!;
  const nodeId = (v.relief as any)?.senseNodeId ?? (v as any).flowNodeId ?? id;
  return (sim.state.flowNodes.get(nodeId)?.fluid.pressure ?? NaN) / 1e5;
};
while (sim.state.time < end) {
  const r = slow ? slow.advance(sim.solver, sim.state, 0.5) : sim.solver.advance(sim.state, 0.5);
  sim.state = r.state;
  sim.state.pendingEvents = [];
  steps += r.metrics?.subcycleCount ?? 0;
  const t = sim.state.time;
  if ('jump' in r && r.jump) console.log(`JUMP t=${r.jump.time.toFixed(0)} +${r.jump.jump.toFixed(0)}s limited by ${r.jump.limitedBy}`);
  for (const [id, v] of sim.state.components.valves) {
    if (!v.relief) continue;
    const c = v.liftCount ?? 0;
    const b = lifts.get(id);
    lifts.set(id, c);
    if (b !== undefined && c > b + 0.5) {
      const gap = t - (lastLiftTime.get(id) ?? NaN);
      lastLiftTime.set(id, t);
      liftsInInterval.set(id, (liftsInInterval.get(id) ?? 0) + 1);
      if (process.env.LIFTS === '1') console.log(`LIFT t=${t.toFixed(1)} ${id} gap=${gap.toFixed(1)}s P=${sense(id).toFixed(2)}bar`);
    }
  }
  const st = slow?.getStatus();
  if (st && st.lastHold !== lastHold) {
    lastHold = st.lastHold;
    if (lastHold) console.log(`HOLD t=${t.toFixed(0)} ceil=${st.maxJump.toFixed(0)} ${lastHold.slice(0, 230)}`);
  }
  if (t >= next) {
    const wall = (performance.now() - wall0) / 1000;
    console.log(`STAT t=${t.toFixed(0)} wall=${wall.toFixed(0)}s steps/s=${((steps - stepsAt) / every).toFixed(1)} lifts: ` +
      ([...liftsInInterval].map(([id, n]) => `${id}=${n}`).join(' ') || 'none') +
      (st ? ` jumps=${st.jumps} skipped=${st.jumpedSeconds.toFixed(0)}` : ''));
    stepsAt = steps; next += every; liftsInInterval.clear();
  }
  if (!snapped && snapOut && snapOut !== '-' && t >= snapAt) {
    fs.writeFileSync(snapOut, JSON.stringify(serializeSimulationState(sim.state)));
    snapped = true;
  }
}
