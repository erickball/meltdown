/**
 * State History Manager
 *
 * Stores simulation states for rewind/seek functionality.
 *
 * Capture policy (snapshots + dt log = full replayability):
 * - A full-state SNAPSHOT is recorded at every frame boundary (after the
 *   game loop's post-advance mutations: neutronics sync, auto-scram, event
 *   processing) and immediately after every user input that mutates state.
 *   Between two consecutive snapshots the trajectory is pure solver steps,
 *   so any intermediate step is reachable by replaying logged dts from the
 *   preceding snapshot (see the dt-log comment below).
 * - Snapshots are NOT taken per solver substep - the dt log covers those.
 * - Keep one snapshot per full second of sim time (coarse long-term
 *   history), maximum 1000 total; when over limit, thin old ones.
 */

import { SimulationState } from '../simulation/types';
import { cloneSimulationState } from '../simulation/solver';

/** What triggered a snapshot - 'input' snapshots supersede the frame
 *  snapshot at the same step as the replay base (they carry the mutation).
 *  A 'rebuild' snapshot is the first state of a new plant design (see
 *  HistoryEpoch): it is the only replay base for the steps that follow it,
 *  so it is never thinned. */
export type SnapshotKind = 'initial' | 'frame' | 'input' | 'rebuild';

/** The solver's cross-step memory: last accepted flow rates feed the next
 *  step's implicit pressure solve, so exact replay must restore them. */
export type FlowRatesContext = Map<string, { dMass: number; dEnergy: number }> | undefined;

export interface StateSnapshot {
  state: SimulationState;
  simTime: number;           // Simulation time in seconds
  wallTime: number;          // Wall clock time when captured (performance.now())
  stepNumber: number;        // Total step count when captured
  isSecondMarker: boolean;   // True if this is a per-second snapshot
  kind: SnapshotKind;
  flowRates: FlowRatesContext; // Solver context for bit-identical replay
  /** Which plant design this state belongs to (index into the epoch list). */
  epoch: number;
  /** Recording order. Strictly increasing over the whole history, never
   *  reused after thinning or branching - what places events between
   *  snapshots (see HistoryEvent.seq). */
  seq: number;
}

/**
 * One plant design's stretch of the timeline.
 *
 * The state vector's shape is the plant's: a rebuild (returning from
 * construction with edits, a live edit while running) produces a state the
 * previous snapshots cannot be replayed into, and vice versa. Rather than
 * throw the history away at every edit, each design gets an epoch starting
 * at the step the rebuild happened. Seeking into an earlier epoch hands its
 * design back to the caller (GameLoop.onEpochChange) so the plant on screen
 * is again the one the restored state describes; recording anything while
 * positioned there branches, which discards the later designs along with
 * the later states - exactly as if the edit had never been made.
 */
export interface HistoryEpoch {
  id: number;
  startStep: number;
  simTime: number;
  label: string;
  /** Serialized plant design (opaque here; main.ts knows how to restore it).
   *  null when the caller had none to give - a seek into such an epoch from
   *  another one cannot restore the plant and says so. */
  design: unknown;
  /** seq of the snapshot that opened the epoch. */
  startSeq: number;
}

/**
 * A notable thing that happened (a rupture, a scram, a scenario event, a
 * plant rebuild), placed between snapshots by `seq`: the event happened
 * after the snapshot whose seq equals `seq` and before the next one - i.e.
 * the earlier snapshot does not contain it and the later one does.
 */
export interface HistoryEvent {
  seq: number;
  step: number;       // head step when emitted (the frame it happened in ends here)
  simTime: number;
  type: string;
  message: string;
}

/** A resolved seek: restore `base`, then re-integrate `dts` in order.
 *  `dts === null` means the dt log for that span has aged out of the cap -
 *  the caller lands on `base` and reports the approximation loudly. */
export interface SeekPlan {
  base: StateSnapshot;
  baseIndex: number;
  targetStep: number;
  dts: Array<{ step: number; dt: number; simTime: number }> | null;
}

export class StateHistory {
  private snapshots: StateSnapshot[] = [];
  private readonly maxRecentSteps = 100;
  private readonly maxTotalSnapshots = 1000;

  // Track which full seconds we have snapshots for
  private secondMarkers = new Set<number>();

  // Plant designs over time (see HistoryEpoch) and the event log
  private epochs: HistoryEpoch[] = [];
  private events: HistoryEvent[] = [];
  private seqCounter = 0;

  // Current position in history (for forward/back navigation without deletion)
  // -1 means we're at the end (most recent state)
  private currentIndex = -1;

  // Step-granular position after a seek. null = at the live head. Unlike
  // currentIndex this can point BETWEEN snapshots; recording anything new
  // while positioned in the past truncates everything beyond it (branching).
  private positionStep: number | null = null;
  private positionTime = 0;
  // The snapshot the position was restored/replayed from. Branching keeps
  // this snapshot and everything recorded before it; a step number alone
  // cannot say that when several snapshots share a step (an input or a
  // rebuild at the same step as a frame).
  private positionIndex: number | null = null;

  // ==========================================================================
  // Accepted-timestep log
  //
  // One entry per accepted solver substep, kept even where snapshots get
  // thinned. Snapshots + this log make the history REPLAYABLE: restore the
  // nearest earlier snapshot, then re-integrate using exactly these dt values
  // (bypassing the adaptive controller) to land bit-identically on any
  // intermediate step - the physics operators are deterministic functions of
  // (state, dt), and the wall-clock-influenced adaptive dt choice is the only
  // thing a live run does that a replay can't reproduce on its own.
  //
  // stepNumber is the solver's monotonically increasing totalSteps counter
  // (it does NOT reset on rewind), so a snapshot's stepNumber uniquely
  // locates its place in this log even across rewind-and-branch histories.
  //
  // NOTE: user inputs mutate state BETWEEN steps and are not logged here;
  // exact replay across an input additionally needs a snapshot taken at the
  // input (future GameLoop hook). Parallel plain-number arrays keep the log
  // compact (~24 B/step -> a few MB per gameplay hour).
  // ==========================================================================
  private dtLogStep: number[] = [];
  private dtLogTime: number[] = [];  // sim time AFTER the step
  private dtLogDt: number[] = [];
  private static readonly DT_LOG_CAP = 400_000;

  /**
   * Log one accepted solver step's dt. Called per accepted substep - this is
   * the cheap per-step record (three numbers), NOT a snapshot. Recording a
   * new step while positioned in the past branches: everything beyond the
   * position is discarded first.
   */
  recordDt(stepNumber: number, simTimeAfter: number, dt: number): void {
    if (!(dt > 0)) return;
    this.branchIfPositioned();
    this.dtLogStep.push(stepNumber);
    this.dtLogTime.push(simTimeAfter);
    this.dtLogDt.push(dt);
    if (this.dtLogStep.length > StateHistory.DT_LOG_CAP) {
      const drop = StateHistory.DT_LOG_CAP / 4;
      this.dtLogStep.splice(0, drop);
      this.dtLogTime.splice(0, drop);
      this.dtLogDt.splice(0, drop);
    }
  }

  /**
   * Record a full-state snapshot (frame boundary, user input, or initial
   * state). Consecutive input snapshots at the same step collapse into the
   * latest one, so a slider drag doesn't append sixty snapshots per second.
   */
  recordSnapshot(
    state: SimulationState,
    stepNumber: number,
    kind: SnapshotKind,
    flowRates: FlowRatesContext,
    design: unknown = null
  ): void {
    this.branchIfPositioned();
    this.currentIndex = -1;

    const simTime = state.time;
    const last = this.snapshots[this.snapshots.length - 1];

    // Collapse a burst of inputs between steps: replace rather than append.
    if (kind === 'input' && last && last.kind === 'input' && last.stepNumber === stepNumber) {
      last.state = cloneSimulationState(state);
      last.flowRates = flowRates;
      last.wallTime = performance.now();
      return;
    }

    const seq = ++this.seqCounter;

    // The first snapshot of a run opens epoch 0 with the design it was built
    // from; a rebuild opens the next one. Anything else joins the newest.
    if (kind === 'initial' || kind === 'rebuild' || this.epochs.length === 0) {
      if (kind === 'frame' || kind === 'input') {
        throw new Error(
          `[StateHistory] A '${kind}' snapshot was recorded before any initial snapshot - ` +
          `the history has no epoch to put it in`);
      }
      this.epochs.push({
        id: this.epochs.length,
        startStep: stepNumber,
        simTime,
        label: kind === 'initial' ? 'Simulation started' : 'Plant rebuilt',
        design,
        startSeq: seq,
      });
    }
    const epoch = this.epochs[this.epochs.length - 1].id;

    const currentSecond = Math.floor(simTime);
    const isSecondMarker = !this.secondMarkers.has(currentSecond);

    this.snapshots.push({
      state: cloneSimulationState(state),
      simTime,
      wallTime: performance.now(),
      stepNumber,
      isSecondMarker,
      kind,
      flowRates,
      epoch,
      seq,
    });

    if (isSecondMarker) {
      this.secondMarkers.add(currentSecond);
    }

    this.enforceLimit();
  }

  /**
   * The plant was rebuilt around an edit at the current position: open a new
   * epoch holding the new design, log the rebuild as an event (placed after
   * the last snapshot of the old design), and record the rebuilt state as
   * the epoch's first snapshot. The rebuilt state must sit at the same
   * simulated time as the position it replaces - a rebuild that moved the
   * clock is a new run, not an edit, and belongs in a fresh history.
   */
  recordRebuild(state: SimulationState, stepNumber: number, design: unknown, label: string): void {
    const t = this.getPositionTime();
    if (this.snapshots.length > 0 && Math.abs(state.time - t) > 1e-6) {
      throw new Error(
        `[StateHistory] Rebuild at t=${state.time} does not continue the history positioned at ` +
        `t=${t}: a rebuild must keep the simulated time. Start a fresh history instead.`);
    }
    this.branchIfPositioned();
    this.recordEvent(stepNumber, state.time, 'rebuild', label);
    this.recordSnapshot(state, stepNumber, 'rebuild', undefined, design);
    this.epochs[this.epochs.length - 1].label = label;
  }

  /**
   * Log a notable event at the current head. Its `seq` is the newest
   * snapshot's, so it sits after that snapshot and before the next one -
   * the frame snapshot that will carry its consequences.
   */
  recordEvent(step: number, simTime: number, type: string, message: string): void {
    this.branchIfPositioned();
    this.events.push({ seq: this.seqCounter, step, simTime, type, message });
  }

  /**
   * Recording anything while positioned in the past means the timeline
   * branches: snapshots, dt-log entries, events AND epochs beyond the
   * position are gone. (Without the dt-log truncation the log would go
   * non-monotonic in time across the branch point and time-based seeks
   * would break; without the epoch truncation a later design would claim
   * steps the branched timeline is about to record.)
   */
  private branchIfPositioned(): void {
    if (this.positionStep === null) return;
    const keepIndex = this.positionIndex ?? this.latestSnapshotIndexAtOrBefore(this.positionStep);
    this.truncateAfter(keepIndex, this.positionStep);
    this.positionStep = null;
    this.positionIndex = null;
  }

  /**
   * Drop everything recorded after snapshot `keepIndex` / step `step`:
   * later snapshots, dt-log entries beyond the step, events emitted after
   * the kept snapshot, and the epochs those snapshots opened.
   */
  private truncateAfter(keepIndex: number, step: number): void {
    const removed = this.snapshots.splice(keepIndex + 1);
    for (const s of removed) {
      if (s.isSecondMarker) {
        const second = Math.floor(s.simTime);
        const stillHasSecond = this.snapshots.some(
          snap => Math.floor(snap.simTime) === second
        );
        if (!stillHasSecond) {
          this.secondMarkers.delete(second);
        }
      }
    }
    while (this.dtLogStep.length > 0 && this.dtLogStep[this.dtLogStep.length - 1] > step) {
      this.dtLogStep.pop();
      this.dtLogTime.pop();
      this.dtLogDt.pop();
    }
    const keepSeq = keepIndex >= 0 && keepIndex < this.snapshots.length
      ? this.snapshots[keepIndex].seq
      : -1;
    // An event with seq == keepSeq was emitted AFTER the kept snapshot
    this.events = this.events.filter(e => e.seq < keepSeq || (keepSeq < 0 && e.step <= step));
    this.epochs = this.epochs.filter(e => e.startSeq <= keepSeq || keepSeq < 0);
    this.currentIndex = -1;
  }

  private truncateBeyond(step: number): void {
    this.truncateAfter(this.latestSnapshotIndexAtOrBefore(step), step);
  }

  /**
   * Everything needed to persist the rewind history with a saved game.
   * Returned by reference - the caller hands it to IndexedDB, which
   * structured-clones it (Maps included), so no JSON round trip is needed.
   */
  exportForSave(): {
    snapshots: StateSnapshot[];
    dtLogStep: number[];
    dtLogTime: number[];
    dtLogDt: number[];
    epochs: HistoryEpoch[];
    events: HistoryEvent[];
  } {
    return {
      snapshots: this.snapshots,
      dtLogStep: this.dtLogStep,
      dtLogTime: this.dtLogTime,
      dtLogDt: this.dtLogDt,
      epochs: this.epochs,
      events: this.events,
    };
  }

  /**
   * Replace this history with a previously exported one (loading a save).
   * Rebuilds the second-marker index; position resets to the live head.
   * Histories saved before epochs existed get a single epoch with no
   * design (a seek within it never needs one).
   */
  importFromSave(data: {
    snapshots: StateSnapshot[];
    dtLogStep: number[];
    dtLogTime: number[];
    dtLogDt: number[];
    epochs?: HistoryEpoch[];
    events?: HistoryEvent[];
  }): void {
    if (!Array.isArray(data.snapshots) || !Array.isArray(data.dtLogStep)) {
      throw new Error('[StateHistory] Malformed saved history - refusing to import');
    }
    this.snapshots = data.snapshots;
    this.dtLogStep = data.dtLogStep;
    this.dtLogTime = data.dtLogTime;
    this.dtLogDt = data.dtLogDt;
    this.secondMarkers.clear();
    for (const s of this.snapshots) {
      if (s.isSecondMarker) this.secondMarkers.add(Math.floor(s.simTime));
    }
    this.seqCounter = 0;
    this.snapshots.forEach((s, i) => {
      if (typeof s.seq !== 'number') s.seq = i + 1;
      if (typeof s.epoch !== 'number') s.epoch = 0;
      this.seqCounter = Math.max(this.seqCounter, s.seq);
    });
    if (Array.isArray(data.epochs) && data.epochs.length > 0) {
      this.epochs = data.epochs;
    } else if (this.snapshots.length > 0) {
      console.warn('[StateHistory] Loaded a history saved without plant epochs - it gets one epoch with no design.');
      const first = this.snapshots[0];
      this.epochs = [{
        id: 0, startStep: first.stepNumber, simTime: first.simTime,
        label: 'Simulation started', design: null, startSeq: first.seq,
      }];
    } else {
      this.epochs = [];
    }
    this.events = Array.isArray(data.events) ? data.events : [];
    this.currentIndex = -1;
    this.positionStep = null;
    this.positionIndex = null;
    this.positionTime = this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1].simTime : 0;
  }

  /** The epoch (plant design) of the current position. */
  currentEpoch(): HistoryEpoch | null {
    if (this.epochs.length === 0) return null;
    if (this.positionStep !== null && this.positionIndex !== null) {
      const id = this.snapshots[this.positionIndex].epoch;
      return this.epochs.find(e => e.id === id) ?? null;
    }
    return this.epochs[this.epochs.length - 1];
  }

  epochById(id: number): HistoryEpoch | null {
    return this.epochs.find(e => e.id === id) ?? null;
  }

  /** The very first recorded state - the start of the run, if it survived. */
  firstSnapshot(): { index: number; kind: SnapshotKind; simTime: number } | null {
    if (this.snapshots.length === 0) return null;
    const s = this.snapshots[0];
    return { index: 0, kind: s.kind, simTime: s.simTime };
  }

  private getPositionTime(): number {
    if (this.positionStep !== null) return this.positionTime;
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1].simTime : 0;
  }

  /**
   * Read-only view of stored snapshot states within a time range, oldest
   * first - the data source for plotting/analysis tools. When several
   * snapshots share a time (frame + input at the same step), the last one
   * recorded wins. The returned states are the LIVE history objects:
   * callers must not mutate them.
   */
  statesInRange(tMin = -Infinity, tMax = Infinity): Array<{ time: number; state: SimulationState }> {
    const out: Array<{ time: number; state: SimulationState }> = [];
    for (const s of this.snapshots) {
      if (s.simTime < tMin - 1e-9 || s.simTime > tMax + 1e-9) continue;
      if (out.length > 0 && Math.abs(out[out.length - 1].time - s.simTime) < 1e-9) {
        out[out.length - 1] = { time: s.simTime, state: s.state };
      } else {
        out.push({ time: s.simTime, state: s.state });
      }
    }
    return out;
  }

  /**
   * Roll the recorded head back to `step`. Used when a frame aborted after
   * logging accepted steps whose states were lost (the solver threw before
   * the frame's result was adopted) - the log must not claim steps we
   * cannot hand back.
   */
  discardStepsBeyond(step: number): void {
    this.truncateBeyond(step);
  }

  /** The newest recorded step number (live head). */
  headStep(): number {
    const lastLogged = this.dtLogStep.length > 0 ? this.dtLogStep[this.dtLogStep.length - 1] : -1;
    const lastSnap = this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1].stepNumber : -1;
    return Math.max(lastLogged, lastSnap, 0);
  }

  /** Current step position: the seek position if set, else the live head. */
  getPositionStep(): number {
    return this.positionStep ?? this.headStep();
  }

  /** Set the step-granular position after a seek (null-equivalent at head).
   *  `baseIndex` is the snapshot the seek restored/replayed from. */
  setPosition(step: number, simTime: number, baseIndex?: number): void {
    const idx = baseIndex ?? this.latestSnapshotIndexAtOrBefore(step);
    const atHead = step >= this.headStep() && idx === this.snapshots.length - 1;
    if (atHead) {
      this.positionStep = null;
      this.positionIndex = null;
      this.currentIndex = -1;
    } else {
      this.positionStep = step;
      this.positionIndex = idx >= 0 ? idx : null;
      // Keep the snapshot-index cursor in sync for the history dialog
      if (idx >= 0) this.currentIndex = idx;
    }
    this.positionTime = simTime;
  }

  private latestSnapshotIndexAtOrBefore(step: number): number {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].stepNumber <= step) return i;
    }
    return -1;
  }

  /**
   * Resolve a seek to `targetStep`: the latest snapshot at or before the
   * target plus the dts to replay from it. Null if the target precedes all
   * retained history. `dts: null` means the log span aged out - land on the
   * base and say so.
   */
  planSeek(targetStep: number): SeekPlan | null {
    const clamped = Math.min(targetStep, this.headStep());
    const baseIndex = this.latestSnapshotIndexAtOrBefore(clamped);
    if (baseIndex < 0) return null;
    const base = this.snapshots[baseIndex];
    // Replay never crosses a rebuild: the steps after an epoch's start can
    // only be replayed from that epoch's own first snapshot, which is pinned
    // against thinning. If a later epoch claims a step at or before the
    // target, that snapshot is gone and the base would step the wrong plant.
    for (const e of this.epochs) {
      if (e.id > base.epoch && e.startStep <= clamped) {
        throw new Error(
          `[StateHistory] Seek to step ${clamped} would replay the epoch-${base.epoch} state ` +
          `across the rebuild that opened epoch ${e.id} at step ${e.startStep} (${e.label}); ` +
          `its first snapshot is missing from the history.`);
      }
    }
    const dts = base.stepNumber === clamped ? [] : this.getDtsBetween(base.stepNumber, clamped);
    return { base, baseIndex, targetStep: clamped, dts };
  }

  /**
   * The step to land on for a time-based seek: the first logged step whose
   * post-step time reaches `targetTime` (i.e. the step that crossed the
   * boundary), clamped to the retained range.
   */
  stepForTime(targetTime: number): number {
    const n = this.dtLogTime.length;
    if (n === 0 || targetTime <= this.dtLogTime[0]) {
      // Before (or without) any logged step: earliest retained snapshot
      return this.snapshots.length > 0 ? this.snapshots[0].stepNumber : 0;
    }
    if (targetTime > this.dtLogTime[n - 1]) return this.headStep();
    // Binary search: first index with time >= target (times are monotonic -
    // branch truncation keeps the log to the current timeline only)
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.dtLogTime[mid] < targetTime - 1e-9) lo = mid + 1; else hi = mid;
    }
    return this.dtLogStep[lo];
  }

  /** The logged step (or snapshot) immediately before `step`, or null. */
  prevStep(step: number): number | null {
    let best: number | null = null;
    for (let i = this.dtLogStep.length - 1; i >= 0; i--) {
      if (this.dtLogStep[i] < step) { best = this.dtLogStep[i]; break; }
    }
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].stepNumber < step) {
        best = best === null ? this.snapshots[i].stepNumber : Math.max(best, this.snapshots[i].stepNumber);
        break;
      }
    }
    return best;
  }

  /** The logged step immediately after `step`, or null if at the head. */
  nextStep(step: number): number | null {
    // Binary search the dt log for the first entry > step
    let lo = 0, hi = this.dtLogStep.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.dtLogStep[mid] <= step) lo = mid + 1; else hi = mid;
    }
    if (lo < this.dtLogStep.length) return this.dtLogStep[lo];
    return null;
  }

  /**
   * Navigate back one step in history.
   * Does NOT delete future states - they remain available for forward navigation.
   * Returns the snapshot to restore to, or null if already at the beginning.
   */
  navigateBack(): StateSnapshot | null {
    if (this.snapshots.length === 0) {
      return null;
    }

    // Determine current effective position
    const effectiveIndex = this.currentIndex >= 0
      ? this.currentIndex
      : this.snapshots.length - 1;

    // Can't go back past the first snapshot
    if (effectiveIndex <= 0) {
      return null;
    }

    // Move back one position
    this.currentIndex = effectiveIndex - 1;
    const snap = this.snapshots[this.currentIndex];
    this.positionStep = snap.stepNumber;
    this.positionIndex = this.currentIndex;
    this.positionTime = snap.simTime;
    return snap;
  }

  /**
   * Navigate forward one step in history.
   * Returns the snapshot to restore to, or null if already at the end.
   */
  navigateForward(): StateSnapshot | null {
    if (this.snapshots.length === 0 || this.currentIndex < 0) {
      return null; // Already at end
    }

    if (this.currentIndex >= this.snapshots.length - 1) {
      return null; // Already at end
    }

    this.currentIndex++;

    // If we've reached the end, reset to -1
    if (this.currentIndex >= this.snapshots.length - 1) {
      this.currentIndex = -1;
    }

    const snap = this.snapshots[this.currentIndex >= 0 ? this.currentIndex : this.snapshots.length - 1];
    this.positionStep = this.currentIndex >= 0 ? snap.stepNumber : null;
    this.positionIndex = this.currentIndex >= 0 ? this.currentIndex : null;
    this.positionTime = snap.simTime;
    return snap;
  }

  /**
   * Navigate to a specific snapshot by index.
   * Returns the snapshot, or null if index is invalid.
   */
  navigateToIndex(index: number): StateSnapshot | null {
    if (index < 0 || index >= this.snapshots.length) {
      return null;
    }

    this.currentIndex = index === this.snapshots.length - 1 ? -1 : index;
    const snap = this.snapshots[index];
    this.positionStep = this.currentIndex >= 0 ? snap.stepNumber : null;
    this.positionIndex = this.currentIndex >= 0 ? index : null;
    this.positionTime = snap.simTime;
    return snap;
  }

  /**
   * Find the snapshot closest to a given simulation time.
   * Returns null if no snapshots exist.
   */
  findClosestToTime(targetTime: number): StateSnapshot | null {
    if (this.snapshots.length === 0) {
      return null;
    }

    let closest = this.snapshots[0];
    let closestDiff = Math.abs(closest.simTime - targetTime);

    for (const snapshot of this.snapshots) {
      const diff = Math.abs(snapshot.simTime - targetTime);
      if (diff < closestDiff) {
        closest = snapshot;
        closestDiff = diff;
      }
    }

    return closest;
  }

  /**
   * Navigate to a specific snapshot (by time).
   * Does NOT remove future snapshots - they remain available.
   * Returns the snapshot state, or null if not found.
   */
  restoreToTime(targetTime: number): SimulationState | null {
    const snapshot = this.findClosestToTime(targetTime);
    if (!snapshot) {
      return null;
    }

    const targetIndex = this.snapshots.indexOf(snapshot);
    this.currentIndex = targetIndex === this.snapshots.length - 1 ? -1 : targetIndex;
    this.positionStep = this.currentIndex >= 0 ? snapshot.stepNumber : null;
    this.positionIndex = this.currentIndex >= 0 ? targetIndex : null;
    this.positionTime = snapshot.simTime;

    return cloneSimulationState(snapshot.state);
  }

  /** The snapshot the current index points at (for restoring solver context). */
  snapshotAtCurrentIndex(): StateSnapshot | null {
    if (this.snapshots.length === 0) return null;
    const idx = this.currentIndex >= 0 ? this.currentIndex : this.snapshots.length - 1;
    return this.snapshots[idx];
  }

  /**
   * Get available snapshot count, time range, and current position.
   */
  getInfo(): {
    count: number;
    oldestTime: number;
    newestTime: number;
    currentIndex: number;  // -1 means at end
    currentTime: number;
    currentStepNumber: number;
    currentEpoch: number;
    epochCount: number;
    eventCount: number;
  } {
    if (this.snapshots.length === 0) {
      return {
        count: 0, oldestTime: 0, newestTime: 0, currentIndex: -1, currentTime: 0, currentStepNumber: 0,
        currentEpoch: 0, epochCount: 0, eventCount: 0,
      };
    }

    const effectiveIndex = this.currentIndex >= 0
      ? this.currentIndex
      : this.snapshots.length - 1;

    return {
      count: this.snapshots.length,
      oldestTime: this.snapshots[0].simTime,
      newestTime: this.snapshots[this.snapshots.length - 1].simTime,
      currentIndex: this.currentIndex,
      // A step-granular seek can sit between snapshots - report its exact
      // position rather than the nearest snapshot's
      currentTime: this.positionStep !== null ? this.positionTime : this.snapshots[effectiveIndex].simTime,
      currentStepNumber: this.positionStep !== null ? this.positionStep : this.snapshots[effectiveIndex].stepNumber,
      currentEpoch: this.currentEpoch()?.id ?? 0,
      epochCount: this.epochs.length,
      eventCount: this.events.length,
    };
  }

  /**
   * Get a list of all snapshots for UI display.
   * Returns lightweight info (not the full state).
   */
  getSnapshotList(): Array<{
    index: number; simTime: number; stepNumber: number; isSecondMarker: boolean;
    kind: SnapshotKind; epoch: number; seq: number;
  }> {
    return this.snapshots.map((s, index) => ({
      index,
      simTime: s.simTime,
      stepNumber: s.stepNumber,
      isSecondMarker: s.isSecondMarker,
      kind: s.kind,
      epoch: s.epoch,
      seq: s.seq,
    }));
  }

  /** The event log (copies) and the epochs without their designs, for display. */
  getEvents(): HistoryEvent[] {
    return this.events.map(e => ({ ...e }));
  }

  getEpochSummaries(): Array<{ id: number; startStep: number; simTime: number; label: string; hasDesign: boolean }> {
    return this.epochs.map(e => ({
      id: e.id, startStep: e.startStep, simTime: e.simTime, label: e.label, hasDesign: e.design != null,
    }));
  }

  /**
   * Clear all history (call on simulation reset).
   */
  clear(): void {
    this.snapshots = [];
    this.secondMarkers.clear();
    this.epochs = [];
    this.events = [];
    this.seqCounter = 0;
    this.currentIndex = -1;
    this.positionStep = null;
    this.positionIndex = null;
    this.positionTime = 0;
    this.dtLogStep = [];
    this.dtLogTime = [];
    this.dtLogDt = [];
  }

  /**
   * The accepted timesteps in (fromStep, toStep], for replaying the segment
   * between two recorded points (see the dt-log comment above). Returns
   * null if the requested range has aged out of the capped log - the caller
   * must then fall back to the nearest retained snapshot.
   */
  getDtsBetween(fromStep: number, toStep: number): Array<{ step: number; dt: number; simTime: number }> | null {
    if (this.dtLogStep.length === 0) return fromStep >= toStep ? [] : null;
    if (fromStep + 1 < this.dtLogStep[0]) return null; // aged out
    // dtLogStep is monotonic: binary search for the first entry > fromStep
    let lo = 0, hi = this.dtLogStep.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.dtLogStep[mid] <= fromStep) lo = mid + 1; else hi = mid;
    }
    const out: Array<{ step: number; dt: number; simTime: number }> = [];
    for (let i = lo; i < this.dtLogStep.length && this.dtLogStep[i] <= toStep; i++) {
      out.push({ step: this.dtLogStep[i], dt: this.dtLogDt[i], simTime: this.dtLogTime[i] });
    }
    return out;
  }

  /**
   * Enforce the maximum snapshot limit using progressive thinning.
   *
   * Strategy:
   * 1. Always keep the most recent maxRecentSteps snapshots (fine-grained)
   * 2. For older snapshots, keep one per N seconds where N increases with age:
   *    - 0-100s from current time: keep every 1 second
   *    - 100-1000s ago: keep every 2 seconds
   *    - 1000-10000s ago: keep every 10 seconds
   *    - 10000s+ ago: keep every 60 seconds
   * 3. Non-marker snapshots are removed first, then markers that don't meet
   *    the spacing requirement for their age.
   */
  private enforceLimit(): void {
    if (this.snapshots.length <= this.maxTotalSnapshots) {
      return;
    }

    // How many we need to remove
    const excess = this.snapshots.length - this.maxTotalSnapshots;

    // Identify the "old" region (everything before the recent 100)
    const recentStart = Math.max(0, this.snapshots.length - this.maxRecentSteps);

    // Get current simulation time (newest snapshot)
    const currentTime = this.snapshots.length > 0
      ? this.snapshots[this.snapshots.length - 1].simTime
      : 0;

    // Determine required spacing based on age (time before current)
    const getRequiredSpacing = (simTime: number): number => {
      const age = currentTime - simTime;
      if (age < 100) return 1;       // Every second for recent history
      if (age < 1000) return 2;      // Every 2 seconds for 100-1000s ago
      if (age < 10000) return 10;    // Every 10 seconds for 1000-10000s ago
      return 60;                      // Every minute for very old history
    };

    // Pinned: the run's first state (the t=0 button lands on it) and every
    // epoch's first state (the only replay base for the steps after a
    // rebuild - see planSeek)
    const pinned = (i: number): boolean =>
      this.snapshots[i].kind === 'initial' || this.snapshots[i].kind === 'rebuild';

    // First pass: remove all non-markers in old region
    const toRemove = new Set<number>();
    for (let i = 0; i < recentStart && toRemove.size < excess; i++) {
      if (!this.snapshots[i].isSecondMarker && !pinned(i)) {
        toRemove.add(i);
      }
    }

    // Second pass: thin markers that don't meet spacing requirements
    if (toRemove.size < excess) {
      // Group remaining markers by their required spacing bucket
      // and keep only one per spacing interval
      const keptMarkerTimes = new Map<number, number>(); // spacing -> last kept time

      for (let i = 0; i < recentStart && toRemove.size < excess; i++) {
        if (toRemove.has(i) || pinned(i)) continue;

        const snapshot = this.snapshots[i];
        const spacing = getRequiredSpacing(snapshot.simTime);

        // Calculate which interval this snapshot belongs to
        const intervalStart = Math.floor(snapshot.simTime / spacing) * spacing;

        // Check if we already have a snapshot for this interval
        const key = intervalStart * 1000 + spacing; // unique key per interval+spacing
        if (keptMarkerTimes.has(key)) {
          // We already kept one for this interval, remove this one
          toRemove.add(i);
        } else {
          // Keep this one (first snapshot in this interval)
          keptMarkerTimes.set(key, snapshot.simTime);
        }
      }
    }

    // Perform the removal (in reverse order to preserve indices)
    const indicesToRemove = Array.from(toRemove).sort((a, b) => b - a);
    for (const idx of indicesToRemove) {
      const removed = this.snapshots.splice(idx, 1)[0];
      if (removed.isSecondMarker) {
        const second = Math.floor(removed.simTime);
        const stillHasSecond = this.snapshots.some(
          s => Math.floor(s.simTime) === second
        );
        if (!stillHasSecond) {
          this.secondMarkers.delete(second);
        }
      }
    }
  }
}
