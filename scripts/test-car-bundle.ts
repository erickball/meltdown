/**
 * CAR reproduction bundle regression suite.
 *
 * Drives a real GameLoop headless on the tankburst scenario (with a user
 * input part-way), packs the plant + state + history into a bundle the way
 * Jack's file_car tool does, and checks the bundle's promises:
 *   - a generous budget carries everything, and it round-trips exactly;
 *   - replaying the decoded history lands bit-identically on the head state;
 *   - a tight budget keeps the must-haves (initial + input + latest
 *     snapshots), keeps the step log contiguous to the head, stays under
 *     the cap, says what it dropped, and still replays exactly from the
 *     time it claims;
 *   - a budget too small for the design + state fails loudly.
 *
 *   npx tsx scripts/test-car-bundle.ts
 */

import * as fs from 'fs';
import { test, assert, report } from './lib/sim-harness';
import { GameLoop } from '../src/game/loop';
import { createSimulationFromPlant, setSimulationRandomSeed } from '../src/simulation';
import { serializePlantDesign, deserializePlantDesign } from '../src/simulation/serialization';
import {
  buildCarBundle,
  decodeCarBundle,
  chooseFrameSnapshots,
  mustKeepIndices,
  type CarBundleSource,
} from '../src/jack/jack-car-bundle';
import { replayBundle, stableState, firstDifference } from './lib/car-replay';
import type { PlantState, PlantComponent } from '../src/types';

// ============================================================================
// Reference run
// ============================================================================

const data = JSON.parse(fs.readFileSync('scripts/tankburst.json', 'utf-8'));
const plant: PlantState = {
  components: new Map<string, PlantComponent>(data.components),
  connections: data.connections ?? [],
} as PlantState;
setSimulationRandomSeed(0);
const initial = createSimulationFromPlant(plant);
const loop = new GameLoop(initial, { autoSlowdownEnabled: false });
loop.setSimulationState(initial);

const FRAMES = 40;
for (let i = 0; i < FRAMES; i++) {
  if (i === 15) {
    // A user input between frames: nudge the first valve (or any node's
    // governor) so the trajectory really depends on the input snapshot
    loop.updateState((s) => {
      const first = s.components.valves.values().next().value;
      if (first && typeof (first as { position?: number }).position === 'number') {
        (first as { position: number }).position *= 0.5;
      }
      return s;
    });
  }
  loop.step(0.05);
}

const source: CarBundleSource = {
  build: 'test',
  mode: 'simulation',
  plant,
  simState: loop.getState(),
  history: loop.exportHistory(),
};
const head = stableState(source.simState);
const history = source.history!;
const kinds = history.snapshots.map(s => s.kind);
console.log(`Reference: ${history.snapshots.length} snapshots (${kinds.filter(k => k === 'input').length} input), ` +
  `${history.dtLogStep.length} logged steps, t = ${source.simState.time.toFixed(3)} s`);

// ============================================================================
// 1. Generous budget: everything travels, and round-trips exactly
// ============================================================================

const full = await buildCarBundle(source, 200_000_000);
const fullDecoded = await decodeCarBundle(full.base64);

test('full bundle carries plant, state and whole history', () => {
  assert(full.summary.bytes === full.base64.length, 'summary.bytes is the encoded length');
  assert(full.summary.trimmed.length === 0, `nothing trimmed, got: ${full.summary.trimmed.join(' / ')}`);
  assert(full.summary.snapshotsKept === history.snapshots.length, 'all snapshots kept');
  assert(full.summary.dtStepsKept === history.dtLogStep.length, 'whole dt log kept');
  assert(fullDecoded.build === 'test' && fullDecoded.mode === 'simulation', 'build/mode round-trip');

  const plantBack = serializePlantDesign(deserializePlantDesign(fullDecoded.plant));
  assert(JSON.stringify(plantBack) === JSON.stringify(serializePlantDesign(plant)), 'plant design round-trips');

  const stateBack = stableState(fullDecoded.simState);
  assert(stateBack === head, `sim state round-trips: ${firstDifference(stateBack, head)}`);

  const h = fullDecoded.history!;
  assert(h.snapshots.length === history.snapshots.length, 'snapshot count');
  for (let i = 0; i < h.snapshots.length; i++) {
    const a = h.snapshots[i], b = history.snapshots[i];
    assert(a.stepNumber === b.stepNumber && a.kind === b.kind && a.simTime === b.simTime, `snapshot ${i} metadata`);
    assert(stableState(a.state) === stableState(b.state), `snapshot ${i} state`);
    const fa = a.flowRates ? [...a.flowRates.entries()] : null;
    const fb = b.flowRates ? [...b.flowRates.entries()] : null;
    assert(JSON.stringify(fa) === JSON.stringify(fb), `snapshot ${i} flow-rate context`);
  }
  for (const key of ['dtLogStep', 'dtLogTime', 'dtLogDt'] as const) {
    const a = h[key], b = history[key];
    assert(a.length === b.length, `${key} length`);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) throw new Error(`${key}[${i}] ${a[i]} !== ${b[i]}`);
    }
  }
});

test('full bundle replays bit-identically from its first snapshot to the head', () => {
  const result = replayBundle(fullDecoded, loop, { fromTime: 0, every: 0 });
  assert(result.base.kind === 'initial', `replay base is the initial snapshot, got ${result.base.kind}`);
  assert(result.inputsAdopted === kinds.filter(k => k === 'input').length, 'every input snapshot adopted');
  const landed = stableState(result.state);
  assert(landed === head, `replay lands on the head: ${firstDifference(landed, head)}`);
});

// ============================================================================
// 2. Tight budget: must-haves stay, the log stays contiguous, replay still exact
// ============================================================================

const tightBudget = Math.floor(full.summary.bytes * 0.35);
const tight = await buildCarBundle(source, tightBudget);
const tightDecoded = await decodeCarBundle(tight.base64);

test('tight bundle fits, keeps the must-have snapshots and a contiguous log', () => {
  assert(tight.summary.bytes <= tightBudget, `${tight.summary.bytes} <= ${tightBudget}`);
  assert(tight.summary.snapshotsKept < history.snapshots.length, 'something was thinned');
  assert(tight.summary.trimmed.length > 0, 'the summary says what was left out');

  const h = tightDecoded.history!;
  const keptSteps = new Set(h.snapshots.map(s => s.stepNumber));
  for (const i of mustKeepIndices(history.snapshots)) {
    assert(keptSteps.has(history.snapshots[i].stepNumber), `must-keep snapshot (${history.snapshots[i].kind}) at step ${history.snapshots[i].stepNumber} kept`);
  }
  const n = h.dtLogStep.length;
  assert(n > 0, 'some dt log kept');
  assert(h.dtLogStep[n - 1] === history.dtLogStep[history.dtLogStep.length - 1], 'dt log ends at the head step');
  for (let i = 1; i < n; i++) {
    if (h.dtLogStep[i] !== h.dtLogStep[i - 1] + 1) throw new Error(`dt log not contiguous at ${i}`);
  }
  assert(tight.summary.replayFrom !== null, 'a replay start time is reported');
});

test('tight bundle replays bit-identically from its reported replay start', () => {
  const result = replayBundle(tightDecoded, loop, { fromTime: 0, every: 0 });
  assert(Math.abs(result.base.simTime - tight.summary.replayFrom!) < 1e-9,
    `earliest replayable snapshot is at the reported replayFrom (${result.base.simTime} vs ${tight.summary.replayFrom})`);
  const landed = stableState(result.state);
  assert(landed === head, `replay lands on the head: ${firstDifference(landed, head)}`);
});

// ============================================================================
// 3. No room at all
// ============================================================================

// (the harness's test() is synchronous, so the async call runs first)
let tooSmallError = '';
try {
  await buildCarBundle(source, 500);
} catch (e) {
  tooSmallError = e instanceof Error ? e.message : String(e);
}
test('a budget too small for design + state fails loudly', () => {
  assert(tooSmallError.includes('nothing can be attached'), `got: ${tooSmallError || 'no error'}`);
});

// ============================================================================
// 4. Frame selection is even in time and prefers the replayable span
// ============================================================================

test('chooseFrameSnapshots spreads picks over the replayable span first', () => {
  const snaps = Array.from({ length: 11 }, (_, i) => ({
    kind: (i === 0 ? 'initial' : 'frame') as 'initial' | 'frame',
    simTime: i,
    stepNumber: i * 10,
  }));
  // Replayable from step 50 (t = 5); ask for 3 of the frames
  const picked = chooseFrameSnapshots(snaps, 3, 50);
  assert(picked.length === 3, `3 picked, got ${picked.length}`);
  assert(picked.every(i => snaps[i].stepNumber >= 50), `all inside the span: ${picked}`);
  assert(picked[0] === 5 && picked[picked.length - 1] === 9, `ends anchored (got ${picked}; index 10 is the latest, a must-keep)`);
  // More than the span holds: fills from before it
  const more = chooseFrameSnapshots(snaps, 8, 50);
  assert(more.length === 8, `8 picked, got ${more.length}`);
  assert(more.filter(i => snaps[i].stepNumber >= 50).length === 5, 'all 5 in-span frames taken first');
  assert(chooseFrameSnapshots(snaps, 0, 50).length === 0, 'zero picks');
});

report('CAR bundle');
