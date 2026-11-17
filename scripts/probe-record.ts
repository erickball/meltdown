/**
 * Recorded run: integrate a plant (plain or slow mode) and keep everything a
 * later question might need, so a run is asked about afterwards instead of
 * repeated with a different print statement.
 *
 * Usage:
 *   npx tsx scripts/probe-record.ts <preset.json> <outDir> [options]
 *     --from <snap.json>    start from a saved state (a snapshot this tool or
 *                           another probe wrote) instead of the preset's IC
 *     --for <s>             plant seconds to run from the starting time (default 600)
 *     --until <t>           ...or run to this absolute plant time
 *     --slow                slow mode (projective jumping); SLOW_CFG='{"relaxSeconds":60}' overrides its config
 *     --every <s>           series interval (default 10 s). Every jump adds a row before and after.
 *     --snap-every <s>      full-state snapshot interval (default 1800 s); one is also written at the end
 *     --snap-at <t,t,...>   extra snapshots at these absolute times
 *     --progress <s>        progress-line interval (default 300 s)
 *
 * Writes into outDir (created; an existing run there is replaced):
 *   series.csv    one row per --every: time, wall, solver dt/steps/rejections,
 *                 neutronics, and for EVERY flow node m, P, T, quality, gas
 *                 moles; every thermal node T; every connection's mass flow;
 *                 every valve position.
 *   events.log    time-stamped: simulation events (bursts, scrams, scenario
 *                 events), valve moves and relief lifts/reseats, node phase
 *                 changes, flow reversals, slow-mode jumps/holds, and every
 *                 console warning/error the simulation printed. A message
 *                 repeating with only its numbers changed is logged 10 times,
 *                 then counted (the count is logged with each progress line).
 *   progress.log  one line per --progress (also printed): speed, steps, rejections, hottest node.
 *   snaps/        t<time>.json, loadable with --from here or by any probe that
 *                 reads snapshots (deserializeSimulationState). If the run
 *                 throws, the last state before the throw is saved as
 *                 snaps/before-error.json and the error goes to events.log.
 *
 * Every file is written synchronously as it goes, so a run can be read while
 * it is still going. Read it with scripts/probe-record-query.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildSimFromFile } from './lib/sim-harness';
import { serializeSimulationState, deserializeSimulationState } from '../src/simulation/serialization';
import { SlowModeController } from '../src/simulation/slow-mode';
import type { SimulationState } from '../src/simulation/types';

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const [presetPath, outDir] = argv;
if (!presetPath || !outDir || presetPath.startsWith('--')) {
  console.error('usage: probe-record.ts <preset.json> <outDir> [--from snap] [--for s | --until t] [--slow] [--every s] [--snap-every s] [--snap-at t,..] [--progress s]');
  process.exit(2);
}
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (name: string, dflt: number): number => {
  const v = opt(name);
  if (v === undefined) return dflt;
  const x = parseFloat(v);
  if (!Number.isFinite(x)) throw new Error(`${name} ${v}: not a number`);
  return x;
};
const every = num('--every', 10);
const snapEvery = num('--snap-every', 1800);
const progressEvery = num('--progress', 300);
const snapAt = (opt('--snap-at') ?? '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
const slowMode = argv.includes('--slow');

// ---------------------------------------------------------------- setup
const sim = buildSimFromFile(presetPath);
const from = opt('--from');
if (from) sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(from, 'utf-8')));
const t0 = sim.state.time;
const end = opt('--until') !== undefined ? num('--until', NaN) : t0 + num('--for', 600);
if (!(end > t0)) throw new Error(`end time ${end} is not after the starting time ${t0}`);
const slow = slowMode ? new SlowModeController(process.env.SLOW_CFG ? JSON.parse(process.env.SLOW_CFG) : {}) : null;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'snaps'), { recursive: true });
const open = (name: string) => fs.openSync(path.join(outDir, name), 'w');
const fdSeries = open('series.csv');
const fdEvents = open('events.log');
const fdProgress = open('progress.log');
const write = (fd: number, line: string) => fs.writeSync(fd, line + '\n');

const wall0 = performance.now();
const wall = () => (performance.now() - wall0) / 1000;
const tStr = (t: number) => t.toFixed(3);

// ---------------------------------------------------------------- events
// The simulation's own console output is part of the record: capture it,
// stamp it with the plant time, and rate-limit messages that repeat with
// only their numbers changed.
const seen = new Map<string, number>();
const suppressed = new Map<string, number>();
const REPEATS = 10;
function event(kind: string, message: string, t = sim.state.time): void {
  const sig = kind + ' ' + message.replace(/[-+]?\d+(\.\d+)?(e[-+]?\d+)?/gi, '#');
  const n = (seen.get(sig) ?? 0) + 1;
  seen.set(sig, n);
  if (n <= REPEATS) {
    write(fdEvents, `${tStr(t)} ${kind}: ${message}${n === REPEATS ? '  [further repeats counted, not logged]' : ''}`);
  } else {
    suppressed.set(sig, (suppressed.get(sig) ?? 0) + 1);
  }
}
const original = { log: console.log, warn: console.warn, error: console.error };
const fmt = (a: unknown[]) => a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
console.log = (...a: unknown[]) => event('log', fmt(a));
console.warn = (...a: unknown[]) => event('warn', fmt(a));
console.error = (...a: unknown[]) => event('error', fmt(a));
const say = (line: string) => { fs.writeSync(1, line + '\n'); write(fdProgress, line); };

// ---------------------------------------------------------------- series columns
type Col = [string, (s: SimulationState) => number];
const cols: Col[] = [];
let stepsTotal = 0, rejTotal = 0, lastDt = NaN;
cols.push(['wall', () => wall()], ['dt', () => lastDt], ['steps', () => stepsTotal], ['rejections', () => rejTotal]);
cols.push(['neutronics.power', s => s.neutronics.power]);
cols.push(['neutronics.decayHeat', s => (s.neutronics.decayHeatPools ?? []).reduce((a, b) => a + b, 0)]);
cols.push(['neutronics.rods', s => s.neutronics.controlRodPosition]);
const molOf = (s: SimulationState, id: string) => {
  const g = s.flowNodes.get(id)?.fluid.ncg as unknown as Record<string, number> | undefined;
  return g ? Object.values(g).reduce((a, b) => a + b, 0) : 0;
};
for (const [id, n] of sim.state.flowNodes) {
  if (n.isBoundary) continue;
  const f = (s: SimulationState) => s.flowNodes.get(id)!.fluid;
  cols.push([`${id}.m`, s => f(s).mass], [`${id}.P`, s => f(s).pressure], [`${id}.T`, s => f(s).temperature],
    [`${id}.x`, s => f(s).quality], [`${id}.mol`, s => molOf(s, id)]);
}
for (const id of sim.state.thermalNodes.keys()) cols.push([`${id}.T`, s => s.thermalNodes.get(id)?.temperature ?? NaN]);
// connections by id: the array is rebuilt between steps, so look up each time
const connIndex = (s: SimulationState) => new Map(s.flowConnections.map(c => [c.id, c]));
let connCache: { state: SimulationState; map: Map<string, SimulationState['flowConnections'][number]> } | null = null;
const conn = (s: SimulationState, id: string) => {
  if (!connCache || connCache.state !== s) connCache = { state: s, map: connIndex(s) };
  return connCache.map.get(id);
};
for (const c of sim.state.flowConnections) cols.push([`${c.id}.mdot`, s => conn(s, c.id)?.massFlowRate ?? NaN]);
for (const id of sim.state.components.valves.keys()) cols.push([`${id}.pos`, s => s.components.valves.get(id)?.position ?? NaN]);
write(fdSeries, ['t', 'jump', ...cols.map(c => c[0])].join(','));
let lastRowAt = NaN;
const row = (s: SimulationState, jump = 0) => {
  lastRowAt = s.time;
  write(fdSeries, [tStr(s.time), jump.toFixed(3), ...cols.map(c => {
    const v = c[1](s);
    return Number.isFinite(v) ? v.toPrecision(7) : String(v);
  })].join(','));
};

// ---------------------------------------------------------------- discrete-change watch
interface Watch { valvePos: Map<string, number>; relief: Map<string, boolean>; powered: Map<string, boolean | undefined>;
  phase: Map<string, string>; flowSign: Map<string, number>; fired: number; hold: string }
const watch: Watch = { valvePos: new Map(), relief: new Map(), powered: new Map(), phase: new Map(), flowSign: new Map(),
  fired: sim.state.scenario?.fired ?? 0, hold: '' };
// a flow reversal is logged only for a flow that was more than this fraction
// of the connection's largest flow so far (a stagnant line's sign is noise)
const peakFlow = new Map<string, number>();
function observe(s: SimulationState): void {
  for (const e of s.pendingEvents ?? []) event(`sim ${e.type}`, e.message);
  s.pendingEvents = [];
  const fired = s.scenario?.fired ?? 0;
  for (let k = watch.fired; k < fired; k++) event('scenario', JSON.stringify(s.scenario!.events[k]));
  watch.fired = fired;
  for (const [id, v] of s.components.valves) {
    const p0 = watch.valvePos.get(id);
    if (p0 === undefined || Math.abs(v.position - p0) >= 0.02 || (v.position === 0) !== (p0 === 0)) {
      if (p0 !== undefined) event('valve', `${id} position ${p0.toFixed(3)} -> ${v.position.toFixed(3)}`);
      watch.valvePos.set(id, v.position);
    }
    const r0 = watch.relief.get(id);
    if (v.relief && r0 !== undefined && r0 !== !!v.reliefOpen) {
      const sense = s.flowNodes.get(v.relief.senseNodeId)?.fluid.pressure ?? NaN;
      event('relief', `${id} ${v.reliefOpen ? 'LIFTS' : 'reseats'} at ${(sense / 1e5).toFixed(3)} bar (setpoint ${(v.relief.setpoint / 1e5).toFixed(3)})`);
    }
    if (v.relief) watch.relief.set(id, !!v.reliefOpen);
    if (watch.powered.has(id) && watch.powered.get(id) !== v.powered) event('valve', `${id} powered ${watch.powered.get(id)} -> ${v.powered}`);
    watch.powered.set(id, v.powered);
  }
  for (const [id, n] of s.flowNodes) {
    if (n.isBoundary) continue;
    const ph = n.fluid.phase;
    const p0 = watch.phase.get(id);
    if (p0 !== undefined && p0 !== ph) event('phase', `${id} ${p0} -> ${ph} (m=${n.fluid.mass.toPrecision(4)} kg, P=${(n.fluid.pressure / 1e5).toFixed(3)} bar)`);
    watch.phase.set(id, ph);
  }
  for (const c of s.flowConnections) {
    const q = c.massFlowRate;
    const peak = Math.max(peakFlow.get(c.id) ?? 0, Math.abs(q));
    peakFlow.set(c.id, peak);
    if (Math.abs(q) < 0.05 * peak) continue;
    const sg = Math.sign(q);
    const s0 = watch.flowSign.get(c.id);
    if (s0 !== undefined && s0 !== sg) event('flow', `${c.id} reverses to ${q.toPrecision(3)} kg/s (peak so far ${peak.toPrecision(3)})`);
    watch.flowSign.set(c.id, sg);
  }
  if (slow) {
    const h = slow.getStatus().lastHold;
    if (h && h !== watch.hold) event('slow hold', h);
    watch.hold = h;
  }
}

// ---------------------------------------------------------------- snapshots
const snap = (s: SimulationState, name: string) =>
  fs.writeFileSync(path.join(outDir, 'snaps', name), JSON.stringify(serializeSimulationState(s)));
const snapName = (t: number) => `t${t.toFixed(0)}.json`;

let lastProgressAt = NaN;
function progress(s: SimulationState): void {
  lastProgressAt = s.time;
  let Tmax = -Infinity, TmaxId = '';
  for (const [id, t] of s.thermalNodes) if (t.temperature > Tmax) { Tmax = t.temperature; TmaxId = id; }
  const w = wall();
  const st = slow?.getStatus();
  say(`t=${s.time.toFixed(0)} wall=${w.toFixed(0)}s x${((s.time - t0) / Math.max(w, 1e-3)).toFixed(1)} steps=${stepsTotal} ` +
    `rej=${rejTotal} Tmax=${(Tmax - 273.15).toFixed(1)}C(${TmaxId}) decay=${((s.neutronics.decayHeatPools ?? []).reduce((a, b) => a + b, 0) / 1e6).toFixed(3)}MW` +
    (st ? ` jumps=${st.jumps} skipped=${st.jumpedSeconds.toFixed(0)}s ceil=${st.maxJump.toFixed(0)}` : ''));
  if (suppressed.size) {
    const parts = [...suppressed].map(([sig, n]) => `${n}x ${sig.slice(0, 120)}`);
    write(fdEvents, `${tStr(s.time)} repeats since last progress line: ${parts.join(' | ')}`);
    suppressed.clear();
  }
}

// ---------------------------------------------------------------- run
say(`recording ${presetPath}${from ? ' from ' + from : ''} t=${t0.toFixed(1)} -> ${end.toFixed(1)}${slow ? ' (slow mode)' : ''}; ` +
  `${cols.length} columns every ${every} s -> ${outDir}`);
observe(sim.state);
row(sim.state);
let nextRow = t0 + every, nextSnap = t0 + snapEvery, nextProgress = t0 + progressEvery;
let snapIdx = snapAt.findIndex(t => t > t0);
if (snapIdx < 0) snapIdx = snapAt.length;
let prev = sim.state;
try {
  while (end - sim.state.time > 1e-6) {
    // land exactly on the next row / snapshot / end, never a sliver short of it
    const target = Math.min(nextRow, end, snapIdx < snapAt.length ? snapAt[snapIdx] : Infinity);
    const tick = Math.min(0.5, target - sim.state.time);
    prev = sim.state;
    const r = slow ? slow.advance(sim.solver, sim.state, tick) : sim.solver.advance(sim.state, tick);
    if (!(r.state.time > prev.time)) throw new Error(`no progress: advance(${tick}) from t=${prev.time} returned t=${r.state.time}`);
    sim.state = r.state;
    stepsTotal += r.metrics?.subcycleCount ?? 0;
    rejTotal += r.metrics?.retriesThisFrame ?? 0;
    lastDt = r.metrics?.actualDt ?? NaN;
    const s = sim.state;
    if ('jump' in r && r.jump) {
      event('slow jump', `+${r.jump.jump.toFixed(1)} s limited by ${r.jump.limitedBy}${r.jump.detail ? ' (' + r.jump.detail + ')' : ''}`, r.jump.time);
      row(prev);
      row(s, r.jump.jump);
      nextRow = s.time + every;
    }
    observe(s);
    if (s.time >= nextRow - 1e-6) { row(s); while (nextRow <= s.time + 1e-6) nextRow += every; }
    while (snapIdx < snapAt.length && s.time >= snapAt[snapIdx] - 1e-6) { snap(s, snapName(snapAt[snapIdx])); snapIdx++; }
    if (s.time >= nextSnap - 1e-6) { snap(s, snapName(s.time)); nextSnap += snapEvery; }
    if (s.time >= nextProgress - 1e-6) { progress(s); nextProgress += progressEvery; }
  }
} catch (e) {
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
  event('THROW', msg, prev.time);
  snap(prev, 'before-error.json');
  say(`THREW at t=${sim.state.time.toFixed(3)}: ${e instanceof Error ? e.message : e} - state before it in snaps/before-error.json`);
  process.exitCode = 1;
}
if (lastRowAt !== sim.state.time) row(sim.state);
snap(sim.state, snapName(sim.state.time));
if (lastProgressAt !== sim.state.time) progress(sim.state);
say(`done: t=${sim.state.time.toFixed(1)} wall=${wall().toFixed(0)}s`);
Object.assign(console, original);
