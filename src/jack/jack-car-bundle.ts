/**
 * Reproduction bundle for Jack's Corrective Action Reports.
 *
 * A bug report that only quotes numbers is a puzzle; one that carries the
 * plant design, the live simulation state and the rewind history is a
 * reproduction. This module packs those three into one gzipped, base64 blob
 * that rides along with the report (see fileCarReport in jack-tools-exec.ts)
 * and is unpacked on our side by scripts/car.ts + scripts/repro-car.ts.
 *
 * What goes in, and what gets left out when it doesn't fit:
 *   - the plant design (serializePlantDesign) and the sim state at the moment
 *     of the report - always, or there is no bundle at all;
 *   - the accepted-dt log, which together with a snapshot makes the recorded
 *     trajectory replayable step for step (see state-history.ts). Kept whole
 *     when it fits, otherwise trimmed from the OLD end so the span that
 *     remains is contiguous up to the head;
 *   - history snapshots: the 'initial' and every 'input' snapshot are kept
 *     (user inputs mutate state between solver steps and are recorded only
 *     as snapshots, so replay across one needs it), plus the latest; frame
 *     snapshots are just landing points and are thinned to whatever room is
 *     left, spread evenly over the replayable span.
 * The fit is a deterministic procedure (measure, plan, build, verify) with a
 * hard size budget, and the summary says exactly what was dropped so the
 * consent dialog and the reader both know.
 *
 * Wire format: JSON (Maps spelled by mapAwareReplacer, the three dt arrays
 * packed as base64 Float64) -> gzip -> base64. Works in the browser and in
 * Node 22 alike (Blob / CompressionStream / Response are global in both).
 */

import type { PlantState } from '../types';
import type { SimulationState } from '../simulation/types';
import type { StateSnapshot, SnapshotKind, FlowRatesContext, HistoryEpoch, HistoryEvent } from '../game/state-history';
import {
  SIM_STATE_VERSION,
  serializePlantDesign,
  mapAwareReplacer,
  mapAwareReviver,
} from '../simulation/serialization';

export const CAR_BUNDLE_VERSION = 1;

/**
 * Hard cap on the encoded bundle (base64 characters, i.e. bytes on the
 * wire). Sized to the delivery path: the cloud function stores it in
 * Firestore documents of at most ~1 MiB each (see functions/src/index.ts),
 * and the request body has to stay comfortably under the functions
 * framework's limit.
 */
export const CAR_BUNDLE_BUDGET = 6_000_000;

/** What StateHistory.exportForSave() hands out (by reference). */
export interface HistoryExport {
  snapshots: StateSnapshot[];
  dtLogStep: number[];
  dtLogTime: number[];
  dtLogDt: number[];
  /** Plant designs over time and the event log (absent in older histories). */
  epochs?: HistoryEpoch[];
  events?: HistoryEvent[];
}

/** Everything the app hands over to build a bundle (see JackHost). */
export interface CarBundleSource {
  /** Git commit of the running build ('unknown' outside a vite build). */
  build: string;
  mode: 'construction' | 'simulation';
  plant: PlantState;
  simState: SimulationState;
  history: HistoryExport | null;
}

export interface CarBundleSummary {
  /** Encoded size (base64 characters) - what actually goes over the wire. */
  bytes: number;
  componentCount: number;
  simTime: number;
  snapshotsTotal: number;
  snapshotsKept: number;
  inputSnapshotsKept: number;
  dtStepsTotal: number;
  dtStepsKept: number;
  /** Earliest sim time from which the kept dt log replays exactly to the head, or null. */
  replayFrom: number | null;
  /** Plain sentences about what was left out to fit the budget (empty = nothing). */
  trimmed: string[];
}

/** A history snapshot as it travels: same fields, minus the wall clock. */
export interface BundleSnapshot {
  simTime: number;
  stepNumber: number;
  kind: SnapshotKind;
  isSecondMarker: boolean;
  flowRates: FlowRatesContext;
  state: SimulationState;
  epoch: number;
  seq: number;
}

/** The decoded bundle. */
export interface CarBundle {
  version: number;
  simStateVersion: number;
  build: string;
  mode: 'construction' | 'simulation';
  createdAt: string;
  plant: Record<string, unknown>;
  simState: SimulationState;
  history: {
    snapshots: BundleSnapshot[];
    dtLogStep: number[];
    dtLogTime: number[];
    dtLogDt: number[];
    epochs: HistoryEpoch[];
    events: HistoryEvent[];
  } | null;
  summary: Omit<CarBundleSummary, 'bytes'>;
}

// ---------------------------------------------------------------------------
// Planning: which snapshots and which dt entries to keep
// ---------------------------------------------------------------------------

export interface BundlePlan {
  /** Indices into history.snapshots, ascending. */
  snapshotIndices: number[];
  /** dt entries [dtStart, dtCount) are kept; dtStart === dtCount means none. */
  dtStart: number;
}

/** Snapshots that must travel: initial, every input, and the latest. */
export function mustKeepIndices(snapshots: ReadonlyArray<Pick<StateSnapshot, 'kind'>>): number[] {
  const out: number[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const k = snapshots[i].kind;
    if (k === 'initial' || k === 'input' || k === 'rebuild' || i === snapshots.length - 1) {
      out.push(i);
    }
  }
  return out;
}

/**
 * Pick `count` frame snapshots evenly spread in sim time, preferring those
 * inside the replayable span (stepNumber >= firstReplayableStep) and only
 * then reaching further back. Pure and deterministic.
 */
export function chooseFrameSnapshots(
  snapshots: ReadonlyArray<Pick<StateSnapshot, 'kind' | 'simTime' | 'stepNumber'>>,
  count: number,
  firstReplayableStep: number,
): number[] {
  if (count <= 0) return [];
  const inSpan: number[] = [];
  const before: number[] = [];
  for (let i = 0; i < snapshots.length - 1; i++) {  // last one is a must-keep
    if (snapshots[i].kind !== 'frame') continue;
    (snapshots[i].stepNumber >= firstReplayableStep ? inSpan : before).push(i);
  }
  const evenly = (pool: number[], n: number): number[] => {
    if (n >= pool.length) return pool.slice();
    if (n <= 0) return [];
    // Even spacing in time: walk the pool and take the snapshot nearest each
    // of n target times between the pool's first and last.
    const t0 = snapshots[pool[0]].simTime;
    const t1 = snapshots[pool[pool.length - 1]].simTime;
    const picked: number[] = [];
    let j = 0;
    for (let k = 0; k < n; k++) {
      const target = n === 1 ? t1 : t0 + ((t1 - t0) * k) / (n - 1);
      while (j < pool.length - 1 && snapshots[pool[j + 1]].simTime <= target) j++;
      if (picked.length === 0 || picked[picked.length - 1] !== pool[j]) picked.push(pool[j]);
    }
    return picked;
  };
  const chosen = evenly(inSpan, count);
  if (chosen.length < count) chosen.push(...evenly(before, count - chosen.length));
  return chosen.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Byte helpers (browser + Node)
// ---------------------------------------------------------------------------

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

type NodeBuffer = { from: (x: unknown, enc?: string) => Uint8Array & { toString: (enc: string) => string } };
const nodeBuffer = (globalThis as { Buffer?: NodeBuffer }).Buffer;

export function bytesToBase64(bytes: Uint8Array): string {
  if (nodeBuffer) return nodeBuffer.from(bytes).toString('base64');
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  // Always a fresh, zero-offset buffer: Node's Buffer.from may hand back a
  // slice of a shared pool, which a Float64Array view would misread.
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function packF64(values: number[]): string {
  return bytesToBase64(new Uint8Array(Float64Array.from(values).buffer));
}

function unpackF64(b64: string): number[] {
  const bytes = base64ToBytes(b64);
  if (bytes.byteLength % 8 !== 0) {
    throw new Error(`[car-bundle] Packed Float64 block has ${bytes.byteLength} bytes, not a multiple of 8`);
  }
  return Array.from(new Float64Array(bytes.buffer, 0, bytes.byteLength / 8));
}

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

interface WireDtLog {
  firstStep: number;
  count: number;
  /** null when steps are firstStep, firstStep+1, ... (the normal case). */
  steps: string | null;
  times: string;
  dts: string;
}

interface WireBundle {
  version: number;
  simStateVersion: number;
  build: string;
  mode: 'construction' | 'simulation';
  createdAt: string;
  plant: Record<string, unknown>;
  simState: SimulationState;
  history: { snapshots: BundleSnapshot[]; dtLog: WireDtLog; epochs?: HistoryEpoch[]; events?: HistoryEvent[] } | null;
  summary: Omit<CarBundleSummary, 'bytes'>;
}

function packDtLog(h: HistoryExport, dtStart: number): WireDtLog {
  const steps = h.dtLogStep.slice(dtStart);
  const count = steps.length;
  const firstStep = count > 0 ? steps[0] : 0;
  let contiguous = true;
  for (let i = 0; i < count; i++) {
    if (steps[i] !== firstStep + i) { contiguous = false; break; }
  }
  return {
    firstStep,
    count,
    steps: contiguous ? null : packF64(steps),
    times: packF64(h.dtLogTime.slice(dtStart)),
    dts: packF64(h.dtLogDt.slice(dtStart)),
  };
}

function unpackDtLog(w: WireDtLog): { dtLogStep: number[]; dtLogTime: number[]; dtLogDt: number[] } {
  const dtLogTime = unpackF64(w.times);
  const dtLogDt = unpackF64(w.dts);
  const dtLogStep = w.steps === null
    ? Array.from({ length: w.count }, (_, i) => w.firstStep + i)
    : unpackF64(w.steps);
  if (dtLogStep.length !== w.count || dtLogTime.length !== w.count || dtLogDt.length !== w.count) {
    throw new Error(
      `[car-bundle] dt log block lengths disagree: count=${w.count}, steps=${dtLogStep.length}, ` +
      `times=${dtLogTime.length}, dts=${dtLogDt.length}`
    );
  }
  return { dtLogStep, dtLogTime, dtLogDt };
}

function toBundleSnapshot(s: StateSnapshot): BundleSnapshot {
  return {
    simTime: s.simTime,
    stepNumber: s.stepNumber,
    kind: s.kind,
    isSecondMarker: s.isSecondMarker,
    flowRates: s.flowRates,
    state: s.state,
    epoch: s.epoch,
    seq: s.seq,
  };
}

async function encodeWire(wire: WireBundle): Promise<string> {
  return bytesToBase64(await gzip(JSON.stringify(wire, mapAwareReplacer)));
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Earliest kept snapshot that can replay exactly to the head, or null. */
function replayFromTime(h: HistoryExport, plan: BundlePlan): number | null {
  if (plan.dtStart >= h.dtLogStep.length) return null;
  // A snapshot at step p replays forward through entries p+1, p+2, ...; it
  // needs the kept log to start at or before p+1.
  const firstKeptStep = h.dtLogStep[plan.dtStart];
  let earliest: number | null = null;
  for (const i of plan.snapshotIndices) {
    const s = h.snapshots[i];
    if (s.stepNumber + 1 >= firstKeptStep && (earliest === null || s.simTime < earliest)) {
      earliest = s.simTime;
    }
  }
  return earliest;
}

function describeTrim(h: HistoryExport, plan: BundlePlan, replayFrom: number | null): string[] {
  const out: string[] = [];
  const dtTotal = h.dtLogStep.length;
  if (plan.dtStart >= dtTotal && dtTotal > 0) {
    out.push('the solver step log was left out entirely, so the history cannot be replayed exactly');
  } else if (plan.dtStart > 0) {
    const from = h.dtLogTime[plan.dtStart];
    out.push(
      `the solver step log was trimmed to the last ${(h.dtLogTime[dtTotal - 1] - from).toFixed(0)} s ` +
      `(${dtTotal - plan.dtStart} of ${dtTotal} steps); exact replay starts at t = ` +
      `${replayFrom === null ? 'nowhere' : replayFrom.toFixed(1) + ' s'}`
    );
  }
  const dropped = h.snapshots.length - plan.snapshotIndices.length;
  if (dropped > 0) {
    out.push(`${dropped} of ${h.snapshots.length} history snapshots were thinned out (the step log covers the gaps)`);
  }
  return out;
}

/**
 * Build the bundle for `source` under `budget` encoded bytes.
 *
 * Returns the base64 text plus a summary describing what it holds. Throws
 * if even the design + live state alone will not fit - that is a report
 * we cannot attach, and the caller says so rather than sending a fragment.
 */
export async function buildCarBundle(
  source: CarBundleSource,
  budget: number = CAR_BUNDLE_BUDGET,
): Promise<{ base64: string; summary: CarBundleSummary }> {
  const createdAt = new Date().toISOString();
  const plant = serializePlantDesign(source.plant);
  const h = source.history;
  const componentCount = source.plant.components.size;
  const simTime = source.simState.time;

  const assemble = (plan: BundlePlan | null): WireBundle => {
    const history = h && plan
      ? {
          snapshots: plan.snapshotIndices.map(i => toBundleSnapshot(h.snapshots[i])),
          dtLog: packDtLog(h, plan.dtStart),
          epochs: h.epochs ?? [],
          events: h.events ?? [],
        }
      : null;
    const replayFrom = h && plan ? replayFromTime(h, plan) : null;
    const trimmed = h && plan
      ? describeTrim(h, plan, replayFrom)
      : h ? ['the rewind history was left out entirely to fit the size budget'] : [];
    const inputs = h && plan ? plan.snapshotIndices.filter(i => h.snapshots[i].kind === 'input').length : 0;
    return {
      version: CAR_BUNDLE_VERSION,
      simStateVersion: SIM_STATE_VERSION,
      build: source.build,
      mode: source.mode,
      createdAt,
      plant,
      simState: source.simState,
      history,
      summary: {
        componentCount,
        simTime,
        snapshotsTotal: h ? h.snapshots.length : 0,
        snapshotsKept: h && plan ? plan.snapshotIndices.length : 0,
        inputSnapshotsKept: inputs,
        dtStepsTotal: h ? h.dtLogStep.length : 0,
        dtStepsKept: h && plan ? h.dtLogStep.length - plan.dtStart : 0,
        replayFrom,
        trimmed,
      },
    };
  };

  const finish = (wire: WireBundle, base64: string) => ({
    base64,
    summary: { ...wire.summary, bytes: base64.length },
  });

  // No history (sim never ran, or none recorded): design + state only.
  if (!h || h.snapshots.length === 0) {
    const wire = assemble(null);
    const base64 = await encodeWire(wire);
    if (base64.length > budget) {
      throw new Error(
        `[car-bundle] Plant design + simulation state alone encode to ${base64.length} bytes, ` +
        `over the ${budget}-byte budget; nothing can be attached`
      );
    }
    return finish(wire, base64);
  }

  // --- measure the pieces that decide the plan ---------------------------
  const must = mustKeepIndices(h.snapshots);
  const dtCount = h.dtLogStep.length;

  // Base = everything that is not negotiable except the dt log.
  const baseWire = assemble({ snapshotIndices: must, dtStart: dtCount });
  const baseSize = (await encodeWire(baseWire)).length;

  // Per-entry cost of the dt log, measured on the real block (it is nearly
  // incompressible doubles, so the standalone figure is representative).
  const dtBlock = dtCount > 0 ? await encodeWire({ ...baseWire, plant: {}, simState: {} as SimulationState,
    history: { snapshots: [], dtLog: packDtLog(h, 0) } }) : '';
  const perDt = dtCount > 0 ? Math.max(1, dtBlock.length - 200) / dtCount : 0;

  // Per-snapshot cost: the latest snapshot on its own. Gzip's window is far
  // smaller than a state, so snapshots do not compress against each other
  // and the standalone figure is what each one costs inside the bundle.
  const lastIdx = h.snapshots.length - 1;
  const oneSnapshot = await encodeWire({ ...baseWire, plant: {}, simState: {} as SimulationState,
    history: { snapshots: [toBundleSnapshot(h.snapshots[lastIdx])], dtLog: packDtLog(h, dtCount) } });
  const perSnapshot = Math.max(1, oneSnapshot.length - 200);

  // --- plan ----------------------------------------------------------------
  let dtStart = 0;
  let snapshotIndices = must;
  if (baseSize > budget) {
    // Even the must-keeps do not fit: shed input snapshots oldest-first
    // (the initial snapshot and the latest stay), then give up on history.
    const inputs = must.filter(i => h.snapshots[i].kind === 'input');
    let keepInputs = Math.max(0, Math.floor((budget - (baseSize - inputs.length * perSnapshot)) / perSnapshot));
    dtStart = dtCount;
    snapshotIndices = must.filter(i => h.snapshots[i].kind !== 'input').concat(inputs.slice(inputs.length - keepInputs)).sort((a, b) => a - b);
    let wire = assemble({ snapshotIndices, dtStart });
    let base64 = await encodeWire(wire);
    while (base64.length > budget && keepInputs > 0) {
      keepInputs = Math.floor(keepInputs * 0.7);
      snapshotIndices = must.filter(i => h.snapshots[i].kind !== 'input').concat(inputs.slice(inputs.length - keepInputs)).sort((a, b) => a - b);
      wire = assemble({ snapshotIndices, dtStart });
      base64 = await encodeWire(wire);
    }
    if (base64.length > budget) {
      wire = assemble(null);
      base64 = await encodeWire(wire);
      if (base64.length > budget) {
        throw new Error(
          `[car-bundle] Plant design + simulation state alone encode to ${base64.length} bytes, ` +
          `over the ${budget}-byte budget; nothing can be attached`
        );
      }
    }
    return finish(wire, base64);
  }

  // dt log: whole if it fits, else the newest entries that do.
  const roomForDt = budget - baseSize;
  if (perDt * dtCount > roomForDt) {
    dtStart = dtCount - Math.max(0, Math.floor(roomForDt / perDt));
  }

  // Frame snapshots fill what is left, spread over the replayable span.
  const room = budget - baseSize - perDt * (dtCount - dtStart);
  let frameCount = Math.max(0, Math.floor((room / perSnapshot) * 0.9));
  const firstReplayableStep = dtStart < dtCount ? h.dtLogStep[dtStart] - 1 : Number.POSITIVE_INFINITY;

  // --- build and verify, shrinking if the estimate was optimistic ---------
  for (;;) {
    const frames = chooseFrameSnapshots(h.snapshots, frameCount, firstReplayableStep);
    snapshotIndices = Array.from(new Set([...must, ...frames])).sort((a, b) => a - b);
    const wire = assemble({ snapshotIndices, dtStart });
    const base64 = await encodeWire(wire);
    if (base64.length <= budget) return finish(wire, base64);
    if (frameCount > 0) {
      frameCount = Math.floor(frameCount * 0.7);
    } else if (dtStart < dtCount) {
      // Estimates were off with no frames left: trim the log further.
      const keep = Math.floor((dtCount - dtStart) * 0.7);
      dtStart = dtCount - keep;
    } else {
      throw new Error(
        `[car-bundle] Bundle with no frames and no step log is ${base64.length} bytes, over the ` +
        `${budget}-byte budget even though its parts measured ${baseSize}; refusing to guess further`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Decode (scripts/car.ts, scripts/repro-car.ts, tests)
// ---------------------------------------------------------------------------

export async function decodeCarBundle(base64: string): Promise<CarBundle> {
  const text = await gunzip(base64ToBytes(base64));
  const wire = JSON.parse(text, mapAwareReviver) as WireBundle;
  if (wire.version !== CAR_BUNDLE_VERSION) {
    throw new Error(`[car-bundle] Bundle version ${String(wire.version)}; this build reads ${CAR_BUNDLE_VERSION}`);
  }
  if (wire.simStateVersion !== SIM_STATE_VERSION) {
    throw new Error(
      `[car-bundle] Bundle carries sim-state version ${String(wire.simStateVersion)}; this build reads ` +
      `${SIM_STATE_VERSION}. Check out the build it names (${wire.build}) to reproduce it.`
    );
  }
  return {
    version: wire.version,
    simStateVersion: wire.simStateVersion,
    build: wire.build,
    mode: wire.mode,
    createdAt: wire.createdAt,
    plant: wire.plant,
    simState: wire.simState,
    history: wire.history
      ? {
          snapshots: wire.history.snapshots,
          ...unpackDtLog(wire.history.dtLog),
          epochs: wire.history.epochs ?? [],
          events: wire.history.events ?? [],
        }
      : null,
    summary: wire.summary,
  };
}

/** Short human lines for the consent dialog / tool result. */
export function describeBundle(s: CarBundleSummary): string[] {
  const lines = [
    `Plant design: ${s.componentCount} components`,
    `Simulation state at t = ${s.simTime.toFixed(1)} s`,
  ];
  if (s.snapshotsTotal > 0) {
    lines.push(
      `Rewind history: ${s.snapshotsKept} of ${s.snapshotsTotal} snapshots ` +
      `(${s.inputSnapshotsKept} at your inputs), ${s.dtStepsKept} of ${s.dtStepsTotal} solver steps` +
      (s.replayFrom !== null ? `, exact replay from t = ${s.replayFrom.toFixed(1)} s` : '')
    );
  } else {
    lines.push('Rewind history: none recorded');
  }
  for (const t of s.trimmed) lines.push(`Left out: ${t}`);
  lines.push(`Size: ${(s.bytes / 1e6).toFixed(2)} MB compressed`);
  return lines;
}
