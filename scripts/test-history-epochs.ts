/**
 * Rewind history across plant rebuilds (epochs), the event log, the t=0
 * seek, and the grouped timeline model behind the history dialog.
 *
 * Drives a real GameLoop headless on the two-loop PWR, edits the plant
 * while it runs (the same live-edit path the UI uses), and checks:
 *
 *   - a rebuild CONTINUES the history (no truncation): the pre-edit states
 *     stay seekable as an earlier epoch, step numbering keeps counting
 *   - seeking across the edit hands the old/new plant design back through
 *     onEpochChange, and the restored state has the matching node set
 *   - replay inside the new epoch is bit-identical; replay never crosses
 *     the rebuild (the rebuild snapshot is the base for the steps after it)
 *   - events (scram, rebuild) are logged and placed between the right
 *     snapshots
 *   - branching while positioned before the edit drops the later epoch
 *   - the t=0 seek lands on the run's initial state and design
 *   - export/import keeps epochs and events
 *   - pinned snapshots survive thinning
 *   - the timeline grouping stays within its row budgets
 *
 *   npx tsx scripts/test-history-epochs.ts [plant.json]
 */

import * as fs from 'fs';
import { test, assert, report } from './lib/sim-harness';
import { GameLoop } from '../src/game/loop';
import { StateHistory, HistoryEpoch } from '../src/game/state-history';
import { buildTimeline, chooseSpan, TimelineGroup, TimelineSnapshot } from '../src/game/history-timeline';
import { createSimulationFromPlant, setSimulationRandomSeed, applyLivePlantEdit } from '../src/simulation';
import { serializePlantDesign, deserializePlantDesign } from '../src/simulation/serialization';
import { cloneSimulationState } from '../src/simulation/solver';
import type { SimulationState } from '../src/simulation/types';
import type { PlantState, PlantComponent } from '../src/types';
import { ConstructionManager } from '../src/construction/construction-manager';

const plantFile = process.argv[2] || 'scripts/test-plants/two-loop-pwr.json';

function stable(state: SimulationState): string {
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

// ============================================================================
// Setup: plant + loop, as main.ts wires them
// ============================================================================

const plant: PlantState = {
  components: new Map<string, PlantComponent>(), connections: [],
  simTime: 0, simSpeed: 1, isPaused: true,
} as PlantState;
const construction = new ConstructionManager(plant);
{
  const data = JSON.parse(fs.readFileSync(plantFile, 'utf-8'));
  for (const [id, component] of data.components) plant.components.set(id, component);
  plant.connections.push(...(data.connections ?? []));
}

/** What main.ts does on an epoch change: put that design back on the plant. */
const epochChanges: Array<{ id: number; from: number }> = [];
function applyDesign(epoch: HistoryEpoch, previousEpochId: number): void {
  epochChanges.push({ id: epoch.id, from: previousEpochId });
  if (epoch.design == null) throw new Error(`epoch ${epoch.id} has no design`);
  const design = deserializePlantDesign(epoch.design as Record<string, unknown>);
  plant.components.clear();
  for (const [id, c] of design.components) plant.components.set(id, c);
  plant.connections = design.connections;
}

setSimulationRandomSeed(0);
const initial = createSimulationFromPlant(plant);
const loop = new GameLoop(initial, { autoSlowdownEnabled: false });
loop.setSimulationState(initial, serializePlantDesign(plant));
loop.onEpochChange = applyDesign;
const initialStable = stable(cloneSimulationState(initial));
const nodesAtStart = initial.flowNodes.size;

const FRAME = 0.05;
for (let i = 0; i < 12; i++) loop.step(FRAME);
loop.triggerScram('history test');
for (let i = 0; i < 8; i++) loop.step(FRAME);

const stepBeforeEdit = loop.getPositionStep();
const timeBeforeEdit = loop.getState().time;
const countBeforeEdit = loop.getHistoryInfo().count;
const preEditStable = stable(loop.getState());

// ============================================================================
// Live edit: add a tank while running, then continue
// ============================================================================

let newTankId: string | null = null;
setSimulationRandomSeed(0);
const edit = applyLivePlantEdit(loop.getState(), plant, () => {
  newTankId = construction.createComponent({
    type: 'tank', name: 'History Tank', position: { x: 60, y: 60 },
    properties: {
      name: 'History Tank', volume: 10, height: 3, initialLevel: 50,
      initialTemperature: 25, initialPressure: 1, elevation: 0, pressureRating: 10,
    },
  });
  if (!newTankId) throw new Error('createComponent returned null');
  if (!construction.createConnection(`${newTankId}-bottom`, 'bui-1-north', undefined, undefined, 0.002, 5)) {
    throw new Error('createConnection failed');
  }
});
loop.rebuildSimulationState(edit.state, serializePlantDesign(plant), 'Added a tank');
const tankNodeId = newTankId!;

// Per-substep references inside the new epoch for the bit-identity check
const solver = (loop as any).rk45Solver;
const refs = new Map<number, string>();
const origCallback = solver.onSubstepComplete;
solver.onSubstepComplete = (state: SimulationState, stepNumber: number, dt: number) => {
  origCallback(state, stepNumber, dt);
  if (stepNumber % 3 === 0) refs.set(stepNumber, stable(state));
};
for (let i = 0; i < 10; i++) loop.step(FRAME);
const headStep = loop.getPositionStep();
const headStable = stable(loop.getState());

// ============================================================================
// Tests
// ============================================================================

test('a rebuild continues the history instead of clearing it', () => {
  const info = loop.getHistoryInfo();
  assert(info.count > countBeforeEdit, `history count ${info.count} did not grow past ${countBeforeEdit}`);
  assert(info.epochCount === 2, `expected 2 epochs, got ${info.epochCount}`);
  assert(info.oldestTime === 0, `oldest snapshot at t=${info.oldestTime}, the start of the run was lost`);
  assert(headStep > stepBeforeEdit, `step numbering did not continue (${headStep} <= ${stepBeforeEdit})`);
  const epochs = loop.getHistoryEpochs();
  assert(epochs[1].startStep === stepBeforeEdit, `epoch 1 starts at step ${epochs[1].startStep}, edit was at ${stepBeforeEdit}`);
  assert(epochs[1].label === 'Added a tank', `epoch label '${epochs[1].label}'`);
  assert(epochs.every(e => e.hasDesign), 'an epoch has no design');
});

test('rebuild time must match the position (loud otherwise)', () => {
  const wrong = cloneSimulationState(loop.getState());
  wrong.time += 1;
  let threw = false;
  try { loop.rebuildSimulationState(wrong, null, 'bad'); } catch { threw = true; }
  assert(threw, 'a rebuild at a different time was accepted silently');
});

test('events are logged: the scram and the rebuild, in order', () => {
  const events = loop.getHistoryEvents();
  const types = events.map(e => e.type);
  assert(types.includes('scram'), `no scram event in ${JSON.stringify(types)}`);
  assert(types.includes('rebuild'), `no rebuild event in ${JSON.stringify(types)}`);
  assert(types.indexOf('scram') < types.indexOf('rebuild'), 'events out of order');
  const rebuild = events.find(e => e.type === 'rebuild')!;
  assert(rebuild.step === stepBeforeEdit, `rebuild event at step ${rebuild.step}, expected ${stepBeforeEdit}`);
  assert(Math.abs(rebuild.simTime - timeBeforeEdit) < 1e-9, 'rebuild event time');
});

test('events sit between the right snapshots in the timeline', () => {
  const root = buildTimeline(loop.getSnapshotList(), loop.getHistoryEvents(), { leafMax: 1_000_000 });
  assert(root !== null && root.items !== null, 'expected a single leaf with a huge leafMax');
  const items = root!.items!;
  const at = items.findIndex(it => it.kind === 'event' && it.event.type === 'rebuild');
  assert(at > 0 && at < items.length - 1, 'rebuild event not bracketed by snapshots');
  const before = items[at - 1], after = items[at + 1];
  assert(before.kind === 'snapshot' && before.snapshot.epoch === 0, 'snapshot before the rebuild is not epoch 0');
  assert(after.kind === 'snapshot' && after.snapshot.epoch === 1 && after.snapshot.kind === 'rebuild',
    'snapshot after the rebuild event is not the rebuild snapshot');
  const scramAt = items.findIndex(it => it.kind === 'event' && it.event.type === 'scram');
  const scramNext = items[scramAt + 1];
  assert(scramNext.kind === 'snapshot' && scramNext.snapshot.kind === 'input',
    'the snapshot after the scram event is not the input snapshot that carries it');
  const scramPrev = items[scramAt - 1];
  assert(scramPrev.kind === 'snapshot' && !scramPrev.snapshot.kind.startsWith('input'),
    'the snapshot before the scram event already carries an input');
});

test('seek within the new epoch replays bit-identically', () => {
  const steps = [...refs.keys()].filter(s => s > stepBeforeEdit).sort((a, b) => a - b);
  assert(steps.length > 0, 'no reference steps captured after the edit');
  const target = steps[Math.floor(steps.length / 2)];
  const landed = loop.seekToStep(target);
  assert(landed !== null, `seekToStep(${target}) found no history`);
  assert(stable(loop.getState()) === refs.get(target), `replay differs at step ${target}`);
  assert(loop.getState().flowNodes.has(tankNodeId), 'the new tank is missing from an epoch-1 state');
  assert(epochChanges.length === 0, 'seeking within the epoch fired an epoch change');
});

test('seeking before the edit restores the old plant design and node set', () => {
  const landed = loop.seekToStep(stepBeforeEdit - 2);
  assert(landed !== null, 'seek before the edit found no history');
  assert(epochChanges.length === 1 && epochChanges[0].id === 0 && epochChanges[0].from === 1,
    `epoch change calls: ${JSON.stringify(epochChanges)}`);
  assert(!loop.getState().flowNodes.has(tankNodeId), 'an epoch-0 state has the tank node');
  assert(loop.getState().flowNodes.size === nodesAtStart, 'epoch-0 node count changed');
  assert(!plant.components.has(tankNodeId), 'the design handed back still has the tank');
  assert(loop.getHistoryInfo().currentEpoch === 0, 'history does not report epoch 0');
});

test('seeking to the rebuild step lands on the rebuilt state, one step earlier on the old one', () => {
  loop.seekToStep(stepBeforeEdit);
  assert(loop.getState().flowNodes.has(tankNodeId), 'the rebuild step did not land on the rebuilt plant');
  assert(epochChanges[epochChanges.length - 1].id === 1, 'no epoch change back to 1');
  assert(plant.components.has(tankNodeId), 'the design handed back lacks the tank');
  loop.seekToStep(stepBeforeEdit - 1);
  assert(!loop.getState().flowNodes.has(tankNodeId), 'the step before the rebuild has the tank');
  // and forward again by adjacent step: the rebuild snapshot, not a replay across it
  const next = loop.adjacentStep(loop.getPositionStep(), 1);
  assert(next === stepBeforeEdit, `adjacent step after ${stepBeforeEdit - 1} is ${next}`);
  loop.seekToStep(next!);
  assert(loop.getState().flowNodes.has(tankNodeId), 'stepping forward across the edit did not switch plants');
});

test('seek back to the head reproduces it exactly, with the new design', () => {
  const landed = loop.seekToStep(headStep);
  assert(landed !== null, 'seek to head failed');
  assert(stable(loop.getState()) === headStable, 'head state not reproduced');
  assert(plant.components.has(tankNodeId), 'the head design lacks the tank');
});

test('the pre-edit state is exactly what it was', () => {
  // The last epoch-0 snapshot at the edit step is the old plant's state at
  // that very step; reach it through the snapshot list (the step seek
  // resolves to the rebuild that superseded it)
  const list = loop.getSnapshotList();
  const idx = list.filter(s => s.epoch === 0).map(s => s.index).pop()!;
  assert(list[idx].stepNumber === stepBeforeEdit, 'last epoch-0 snapshot is not at the edit step');
  loop.navigateToHistoryIndex(idx);
  assert(stable(loop.getState()) === preEditStable, 'pre-edit state changed');
  assert(!plant.components.has(tankNodeId), 'design at the pre-edit snapshot has the tank');
});

test('export/import keeps epochs, events and designs', () => {
  const exported = loop.exportHistory();
  assert(exported.epochs.length === 2 && exported.events.length >= 2, 'export lacks epochs/events');
  loop.seekToStep(headStep);
  const other = new GameLoop(cloneSimulationState(loop.getState()), { autoSlowdownEnabled: false });
  other.setSimulationState(cloneSimulationState(loop.getState()), serializePlantDesign(plant));
  other.importHistory(exported);
  assert(other.getHistoryInfo().epochCount === 2, 'imported history lost an epoch');
  assert(other.getHistoryEvents().some(e => e.type === 'rebuild'), 'imported history lost the rebuild event');
  let got: HistoryEpoch | null = null;
  other.onEpochChange = (e) => { got = e; };
  other.seekToStep(stepBeforeEdit - 2);
  assert(got !== null && got!.id === 0 && got!.design != null, 'imported epoch 0 did not come back with a design');
  assert(!other.getState().flowNodes.has(tankNodeId), 'imported epoch-0 state has the tank');
});

test('t=0 lands on the run\'s initial state and design', () => {
  loop.seekToStep(headStep);
  const landed = loop.seekToStart();
  assert(landed !== null && landed.exact, 'seekToStart was not exact');
  assert(landed!.time === 0, `landed at t=${landed!.time}`);
  assert(stable(loop.getState()) === initialStable, 'initial state not reproduced');
  assert(!plant.components.has(tankNodeId), 'the start design has the tank');
  assert(loop.getHistoryInfo().currentEpoch === 0, 'not in epoch 0 at the start');
});

test('branching before the edit drops the later epoch and its events', () => {
  loop.seekToStep(stepBeforeEdit - 2);
  const branchStep = loop.getPositionStep();
  loop.triggerScram('branch');   // an input while rewound branches the timeline
  const info = loop.getHistoryInfo();
  assert(info.epochCount === 1, `expected 1 epoch after branching, got ${info.epochCount}`);
  assert(!loop.getHistoryEvents().some(e => e.type === 'rebuild'), 'the rebuild event survived the branch');
  assert(loop.getHistoryEvents().filter(e => e.type === 'scram').length === 2,
    `expected the original scram plus the new one, got ${loop.getHistoryEvents().filter(e => e.type === 'scram').length}`);
  assert(loop.getPositionStep() === branchStep, 'head moved on branching');
  for (let i = 0; i < 4; i++) loop.step(FRAME);
  assert(loop.getPositionStep() > branchStep, 'no new steps after branching');
  assert(!loop.getState().flowNodes.has(tankNodeId), 'the branched timeline has the tank');
  // A fresh edit on the branched (old) design works and opens epoch 1 again
  setSimulationRandomSeed(0);
  const edit2 = applyLivePlantEdit(loop.getState(), plant, () => {
    const id = construction.createComponent({
      type: 'tank', name: 'Second Tank', position: { x: 70, y: 70 },
      properties: {
        name: 'Second Tank', volume: 5, height: 2, initialLevel: 50,
        initialTemperature: 25, initialPressure: 1, elevation: 0, pressureRating: 10,
      },
    });
    if (!id) throw new Error('createComponent returned null');
  });
  loop.rebuildSimulationState(edit2.state, serializePlantDesign(plant), 'Second tank');
  assert(loop.getHistoryInfo().epochCount === 2, 'second rebuild did not open epoch 1');
  for (let i = 0; i < 3; i++) loop.step(FRAME);
  assert(loop.seekToStep(stepBeforeEdit - 4) !== null, 'seek into epoch 0 after the second rebuild failed');
  assert(loop.getHistoryInfo().currentEpoch === 0, 'not in epoch 0');
});

test('thinning never drops the initial or a rebuild snapshot', () => {
  const h = new StateHistory();
  const s = cloneSimulationState(initial);
  h.recordSnapshot(s, 0, 'initial', undefined, { d: 0 });
  let step = 0;
  for (let i = 1; i <= 1300; i++) {
    // A rebuild happens at the position (same time, same step) before the
    // next frame runs
    if (i === 400) { h.recordRebuild(s, step, { d: 1 }, 'edit'); }
    step += 3;
    s.time = i * 0.5;
    for (let k = 2; k >= 0; k--) h.recordDt(step - k, s.time - k * 0.1, 0.1);
    h.recordSnapshot(s, step, 'frame', undefined);
  }
  const list = h.getSnapshotList();
  assert(list.length <= 1000, `limit not enforced (${list.length})`);
  assert(list[0].kind === 'initial', 'initial snapshot was thinned away');
  const rebuild = list.find(x => x.kind === 'rebuild');
  assert(rebuild !== undefined, 'rebuild snapshot was thinned away');
  // The first step after the rebuild replays from the rebuild snapshot
  const plan = h.planSeek(rebuild!.stepNumber + 1);
  assert(plan !== null && plan.base.kind === 'rebuild', 'seek just after the rebuild does not base on it');
  assert(plan!.dts !== null && plan!.dts.length === 1, 'wrong replay span after the rebuild');
});

test('planSeek refuses to replay across a rebuild whose snapshot is gone', () => {
  const h = new StateHistory();
  const s = cloneSimulationState(initial);
  h.recordSnapshot(s, 0, 'initial', undefined, null);
  for (let i = 1; i <= 3; i++) { h.recordDt(i, i * 0.1, 0.1); }
  s.time = 0.3;
  h.recordSnapshot(s, 3, 'frame', undefined);
  h.recordRebuild(s, 3, null, 'edit');
  for (let i = 4; i <= 6; i++) { h.recordDt(i, i * 0.1, 0.1); }
  s.time = 0.6;
  h.recordSnapshot(s, 6, 'frame', undefined);
  // Simulate the loss of the rebuild snapshot
  (h as any).snapshots.splice(2, 1);
  let threw = false;
  try { h.planSeek(5); } catch { threw = true; }
  assert(threw, 'a seek that would replay across the missing rebuild snapshot was planned silently');
});

test('timeline grouping stays within its row budgets', () => {
  const snaps: TimelineSnapshot[] = [];
  const N = 5000;
  for (let i = 0; i < N; i++) {
    snaps.push({ index: i, simTime: i * 12.34, stepNumber: i * 7, kind: i === 0 ? 'initial' : 'frame', epoch: 0, seq: i + 1 });
  }
  const events = [
    { seq: 1000, step: 7000, simTime: 999 * 12.34 + 5, type: 'component-burst', message: 'boom' },
    { seq: 3000, step: 21000, simTime: 2999 * 12.34 + 5, type: 'scram', message: 'scram' },
  ];
  const root = buildTimeline(snaps, events, { maxGroups: 10, leafMax: 12, currentIndex: 2500 });
  assert(root !== null && root.children !== null, 'no groups');
  const walk = (g: TimelineGroup, depth: number): void => {
    if (g.children) {
      assert(g.children.length <= 10, `${g.children.length} groups at depth ${depth}`);
      assert(g.children.reduce((n, c) => n + c.snapshotCount, 0) === g.snapshotCount, 'snapshot counts do not add up');
      assert(g.children.reduce((n, c) => n + c.events.length, 0) === g.events.length, 'event counts do not add up');
      assert(g.children.filter(c => c.containsCurrent).length === (g.containsCurrent ? 1 : 0), 'current-path marking wrong');
      for (const c of g.children) walk(c, depth + 1);
    } else {
      assert(g.items!.filter(it => it.kind === 'snapshot').length <= 12, `leaf with ${g.items!.length} rows`);
    }
  };
  walk(root!, 0);
  assert(root!.events.length === 2, 'events lost');
  assert(root!.containsCurrent, 'root does not contain the current position');
  // Spans are round and cover the range in <= n bands
  assert(chooseSpan(0, 61717, 10) === 7200, `chooseSpan(0, 61717, 10) = ${chooseSpan(0, 61717, 10)}`);
  assert(chooseSpan(0, 9.5, 10) === 1, `chooseSpan(0, 9.5, 10) = ${chooseSpan(0, 9.5, 10)}`);
  // Dense snapshots inside one interval do not recurse forever
  const dense: TimelineSnapshot[] = [];
  for (let i = 0; i < 100; i++) dense.push({ index: i, simTime: 5 + i * 1e-6, stepNumber: i, kind: 'frame', epoch: 0, seq: i + 1 });
  const denseRoot = buildTimeline(dense, [], {});
  assert(denseRoot !== null, 'dense timeline failed');
});

report('History Epochs Suite');
