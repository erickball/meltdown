/**
 * Replay a CAR reproduction bundle's recorded trajectory, headless.
 *
 * The bundle carries history snapshots and the accepted-dt log (see
 * src/game/state-history.ts for the capture model): between two snapshots
 * the trajectory is pure solver steps, and a user input is recorded only as
 * an 'input' snapshot taken after the mutation. So an exact replay from a
 * base snapshot re-integrates the logged dts in order, and whenever an input
 * snapshot sits at the step it is about to leave, adopts that snapshot's
 * state (and solver flow-rate context) before continuing. Shared by
 * scripts/repro-car.ts and scripts/test-car-bundle.ts.
 */

import type { GameLoop } from '../../src/game/loop';
import type { SimulationState } from '../../src/simulation/types';
import type { CarBundle, BundleSnapshot } from '../../src/jack/jack-car-bundle';
import { cloneSimulationState } from '../../src/simulation/solver';

export interface ReplayOptions {
  /** Start from the latest replayable snapshot at or before this sim time (null = earliest). */
  fromTime: number | null;
  /** Call `log` about this often in sim seconds (0 = never). */
  every: number;
  log?: (state: SimulationState, note: string) => void;
  /**
   * Compare the replayed state against every kept snapshot it passes and
   * report the drift (see compareStates) - shows whether a mismatch at the
   * head is floating-point noise that grows smoothly (a different JS engine
   * or build) or a jump at one step (a determinism bug).
   */
  onSnapshotDrift?: (snapshot: BundleSnapshot, drift: StateDrift) => void;
}

export interface ReplayResult {
  state: SimulationState;
  base: BundleSnapshot;
  stepsReplayed: number;
  inputsAdopted: number;
}

/** How far two states are apart, over every numeric leaf. */
export interface StateDrift {
  /** Largest |a-b| / max(|a|,|b|,1e-300) over all numbers that differ. */
  maxRel: number;
  /** Dot-path of the leaf with the largest relative difference. */
  at: string;
  /** Numbers that differ / numbers compared. */
  differing: number;
  compared: number;
  /** Non-numeric leaves (strings, booleans, structure) that differ. */
  structural: number;
}

export function compareStates(a: SimulationState, b: SimulationState): StateDrift {
  const drift: StateDrift = { maxRel: 0, at: '', differing: 0, compared: 0, structural: 0 };
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (typeof x === 'number' && typeof y === 'number') {
      drift.compared++;
      if (x === y || (Number.isNaN(x) && Number.isNaN(y))) return;
      drift.differing++;
      const rel = Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y), 1e-300);
      if (rel > drift.maxRel) { drift.maxRel = rel; drift.at = path; }
      return;
    }
    if (x instanceof Map || y instanceof Map) {
      if (!(x instanceof Map && y instanceof Map)) { drift.structural++; return; }
      const keys = new Set([...x.keys(), ...y.keys()]);
      for (const k of keys) {
        if (!x.has(k) || !y.has(k)) { drift.structural++; continue; }
        walk(x.get(k), y.get(k), `${path}.${String(k)}`);
      }
      return;
    }
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!(Array.isArray(x) && Array.isArray(y)) || x.length !== y.length) { drift.structural++; return; }
      for (let i = 0; i < x.length; i++) walk(x[i], y[i], `${path}[${i}]`);
      return;
    }
    if (x !== null && y !== null && typeof x === 'object' && typeof y === 'object') {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of keys) {
        if (k === 'pendingEvents') continue;
        walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    if (x !== y) drift.structural++;
  };
  walk(a, b, '');
  return drift;
}

export function describeDrift(d: StateDrift): string {
  if (d.differing === 0 && d.structural === 0) return 'identical';
  return `${d.differing} of ${d.compared} numbers differ, max relative ${d.maxRel.toExponential(2)} at ${d.at}` +
    (d.structural > 0 ? `, ${d.structural} structural difference(s)` : '');
}

/** The base snapshot a replay to the head can start from at or before `fromTime`. */
export function pickReplayBase(bundle: CarBundle, fromTime: number | null): BundleSnapshot {
  const h = bundle.history;
  if (!h || h.dtLogStep.length === 0) {
    throw new Error('[car-replay] The bundle has no solver step log, so nothing can be replayed');
  }
  const firstLoggedStep = h.dtLogStep[0];
  let base: BundleSnapshot | null = null;
  for (const s of h.snapshots) {
    if (s.stepNumber + 1 < firstLoggedStep) continue;          // log starts after it
    if (fromTime !== null && s.simTime > fromTime + 1e-9) continue;
    if (base === null || s.stepNumber >= base.stepNumber) base = s;  // latest qualifying
  }
  if (base === null) {
    // Asked for a time before the replayable span (e.g. --from 0 on a bundle
    // whose log starts late): start from the earliest replayable snapshot.
    for (const s of h.snapshots) {
      if (s.stepNumber + 1 < firstLoggedStep) continue;
      if (base === null || s.stepNumber < base.stepNumber) base = s;
    }
    if (base === null) {
      throw new Error(
        `[car-replay] No snapshot can replay through the kept step log (it starts at step ${firstLoggedStep})`
      );
    }
    if (fromTime !== null) {
      console.log(`[car-replay] No snapshot at or before t = ${fromTime}; starting from the earliest ` +
        `replayable one at t = ${base.simTime.toFixed(3)} s`);
    }
    return base;
  }
  if (fromTime === null) {
    // Earliest replayable, not latest
    for (const s of h.snapshots) {
      if (s.stepNumber + 1 >= firstLoggedStep && s.stepNumber < base.stepNumber) base = s;
    }
  }
  return base;
}

export function replayBundle(bundle: CarBundle, loop: GameLoop, opts: ReplayOptions): ReplayResult {
  const h = bundle.history;
  if (!h) throw new Error('[car-replay] The bundle has no history');
  const solver = (loop as unknown as { rk45Solver: {
    replayStep: (s: SimulationState, dt: number) => SimulationState;
    setFlowRatesContext: (c: BundleSnapshot['flowRates']) => void;
  } }).rk45Solver;

  const base = pickReplayBase(bundle, opts.fromTime);
  const inputsAtStep = new Map<number, BundleSnapshot>();
  const snapshotsAtStep = new Map<number, BundleSnapshot>();
  for (const s of h.snapshots) {
    if (s.kind === 'input') inputsAtStep.set(s.stepNumber, s);
    else snapshotsAtStep.set(s.stepNumber, s);   // frame/initial: a checkpoint to compare against
  }

  let state = cloneSimulationState(base.state);
  solver.setFlowRatesContext(base.flowRates);
  let nextLog = opts.every > 0 ? base.simTime + opts.every : Number.POSITIVE_INFINITY;
  let stepsReplayed = 0;
  let inputsAdopted = 0;
  opts.log?.(state, `replay base: ${base.kind} snapshot at t = ${base.simTime.toFixed(3)} s (step ${base.stepNumber})`);

  for (let i = 0; i < h.dtLogStep.length; i++) {
    const step = h.dtLogStep[i];
    if (step <= base.stepNumber) continue;
    const input = inputsAtStep.get(step - 1);
    if (input && input !== base) {
      state = cloneSimulationState(input.state);
      solver.setFlowRatesContext(input.flowRates);
      inputsAdopted++;
      opts.log?.(state, `adopted input snapshot at t = ${input.simTime.toFixed(3)} s (step ${input.stepNumber})`);
    }
    state = solver.replayStep(state, h.dtLogDt[i]);
    stepsReplayed++;
    if (Math.abs(state.time - h.dtLogTime[i]) > 1e-6) {
      throw new Error(
        `[car-replay] Replay drift at step ${step}: replayed t = ${state.time}, recorded t = ${h.dtLogTime[i]}. ` +
        'The physics is not reproducing the recorded trajectory - a determinism bug, or a different build.'
      );
    }
    if (opts.onSnapshotDrift) {
      const checkpoint = snapshotsAtStep.get(step);
      if (checkpoint) opts.onSnapshotDrift(checkpoint, compareStates(state, checkpoint.state));
    }
    if (state.time >= nextLog - 1e-9) {
      opts.log?.(state, `replayed to t = ${state.time.toFixed(3)} s (step ${step})`);
      nextLog += opts.every;
    }
  }
  return { state, base, stepsReplayed, inputsAdopted };
}

/**
 * Stable text form of a state for bit-identity comparison (from
 * test-replay-seek.ts): Maps become sorted-key objects, NaN is spelled out,
 * and pendingEvents is dropped (a replay does not re-emit past events).
 */
export function stableState(state: SimulationState): string {
  const { pendingEvents: _drop, ...rest } = state as SimulationState & { pendingEvents?: unknown };
  return JSON.stringify(rest, (_k, v) => {
    if (v instanceof Map) {
      const obj: Record<string, unknown> = {};
      for (const key of [...v.keys()].sort()) obj[String(key)] = v.get(key);
      return obj;
    }
    if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
    return v;
  });
}

export function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return 'identical';
  return `at byte ${i}: A=...${a.slice(Math.max(0, i - 60), i + 60)}... B=...${b.slice(Math.max(0, i - 60), i + 60)}...`;
}
