/**
 * Replay-seek regression suite.
 *
 * Drives a real GameLoop headless (no rAF - step() is called directly) on
 * the tankburst scenario, which covers both smooth dynamics and an
 * irreversible burst event. Verifies the history system's core promise:
 * restoring the nearest snapshot and re-integrating the logged dts lands
 * BIT-IDENTICALLY on any recorded step, including across a burst, and
 * user inputs snapshot/branch correctly.
 *
 *   npx tsx scripts/test-replay-seek.ts
 */

import * as fs from 'fs';
import { test, assert, report } from './lib/sim-harness';
import { GameLoop } from '../src/game/loop';
import { createSimulationFromPlant, setSimulationRandomSeed } from '../src/simulation';
import { cloneSimulationState } from '../src/simulation/solver';
import type { SimulationState } from '../src/simulation/types';
import type { PlantState, PlantComponent } from '../src/types';

// Stable serialization (from bitcheck.ts): Maps become sorted-key objects,
// NaN serializes distinctly. pendingEvents is stripped - a seek clears
// already-emitted events by design.
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

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return `at byte ${i}: A=...${a.slice(Math.max(0, i - 60), i + 60)}... B=...${b.slice(Math.max(0, i - 60), i + 60)}...`;
}

// ============================================================================
// Build the loop and run the reference trajectory
// ============================================================================

const data = JSON.parse(fs.readFileSync('scripts/tankburst.json', 'utf-8'));
const plantState: PlantState = {
  components: new Map<string, PlantComponent>(data.components),
  connections: data.connections ?? [],
};
setSimulationRandomSeed(0);
const initial = createSimulationFromPlant(plantState);

const loop = new GameLoop(initial, { autoSlowdownEnabled: false });
loop.setSimulationState(initial);

// Capture per-substep references by wrapping the dt-log callback: these are
// states the OLD per-substep snapshot system would have stored, and exactly
// what seekToStep must reproduce.
const solver = (loop as any).rk45Solver;
const refs = new Map<number, { state: SimulationState; time: number }>();
const origCallback = solver.onSubstepComplete;
solver.onSubstepComplete = (state: SimulationState, stepNumber: number, dt: number) => {
  origCallback(state, stepNumber, dt);
  if (stepNumber % 5 === 0) {
    refs.set(stepNumber, { state: cloneSimulationState(state), time: state.time });
  }
};

// 3 sim-seconds in 0.05 s frames - the 20-bar tank bursts along the way
const FRAMES = 60;
for (let i = 0; i < FRAMES; i++) {
  loop.step(0.05);
}

const headStep = loop.getPositionStep();
const headTime = loop.getState().time;
const headStable = stable(loop.getState());
const historyInfo = loop.getHistoryInfo();

const burstSteps = [...refs.keys()].filter(s => {
  const st = refs.get(s)!.state;
  return st.burstStates && [...st.burstStates.values()].some(b => b.isBurst);
});
const preBurstSteps = [...refs.keys()].filter(s => !burstSteps.includes(s)).sort((a, b) => a - b);
const postBurstSteps = burstSteps.sort((a, b) => a - b);

// ============================================================================
// Tests
// ============================================================================

test('scenario produced a burst and a healthy dt log', () => {
  assert(postBurstSteps.length > 0, 'tank never burst - scenario no longer exercises the burst path');
  assert(preBurstSteps.length > 0, 'no pre-burst reference steps captured');
  assert(headStep > FRAMES / 2, `suspiciously few solver steps (${headStep})`);
});

test('snapshot capture is per-frame, not per-substep', () => {
  // Frame snapshots + initial; far fewer than solver steps when steps/frame > 1
  assert(historyInfo.count <= FRAMES + 2,
    `${historyInfo.count} snapshots for ${FRAMES} frames - input/frame capture policy broken`);
});

test('seek to a mid-frame step is bit-identical (pre-burst)', () => {
  const target = preBurstSteps[Math.floor(preBurstSteps.length / 2)];
  const landed = loop.seekToStep(target);
  assert(landed !== null, `seekToStep(${target}) found no history`);
  const got = stable(loop.getState());
  const want = stable(refs.get(target)!.state);
  assert(got === want, `replayed state differs from live state at step ${target}: ${firstDiff(got, want)}`);
});

test('seek forward across the burst is bit-identical', () => {
  const target = postBurstSteps[postBurstSteps.length - 1];
  const landed = loop.seekToStep(target);
  assert(landed !== null, `seekToStep(${target}) found no history`);
  const got = loop.getState();
  assert(got.burstStates && [...got.burstStates.values()].some(b => b.isBurst),
    'burst state missing after replay across the burst');
  const want = stable(refs.get(target)!.state);
  const gotS = stable(got);
  assert(gotS === want, `replayed state differs at post-burst step ${target}: ${firstDiff(gotS, want)}`);
});

test('seek back to the head reproduces it exactly', () => {
  const landed = loop.seekToStep(headStep);
  assert(landed !== null, 'seek to head failed');
  assert(Math.abs(landed - headTime) < 1e-9, `head time ${headTime} vs landed ${landed}`);
  const got = stable(loop.getState());
  assert(got === headStable, `head state not reproduced: ${firstDiff(got, headStable)}`);
});

test('seekToTime lands on the step crossing the round second', () => {
  const landed = loop.seekToTime(1.0);
  assert(landed !== null, 'seekToTime(1.0) found no history');
  assert(landed >= 1.0 - 1e-9, `landed at ${landed}, before the requested second`);
  assert(landed < 1.0 + 0.51, `landed at ${landed}, far past the requested second (dt cap is 0.5s)`);
});

test('single-step navigation walks adjacent recorded steps', () => {
  loop.seekToStep(preBurstSteps[1]);
  const pos = loop.getPositionStep();
  const prev = loop.adjacentStep(pos, -1);
  const next = loop.adjacentStep(pos, 1);
  assert(prev !== null && prev < pos, `prevStep(${pos}) = ${prev}`);
  assert(next !== null && next > pos, `nextStep(${pos}) = ${next}`);
  const tHere = loop.getState().time;
  const tPrev = loop.seekToStep(prev!);
  assert(tPrev !== null && tPrev < tHere, `stepping back did not move time back (${tPrev} vs ${tHere})`);
  const tBack = loop.seekToStep(pos);
  assert(tBack !== null && Math.abs(tBack - tHere) < 1e-9, 'stepping back and forward did not return');
});

test('input while rewound snapshots and branches the timeline', () => {
  const branchPoint = preBurstSteps[0];
  loop.seekToStep(branchPoint);
  // A manual scram is a legitimate user input that mutates state
  loop.triggerScram('replay-branch test');
  assert(loop.getPositionStep() === branchPoint,
    `branch truncation failed: head is ${loop.getPositionStep()}, expected ${branchPoint}`);
  assert(loop.adjacentStep(branchPoint, 1) === null, 'stale future steps survived the branch');
  // The new timeline advances from the branched state
  for (let i = 0; i < 5; i++) loop.step(0.05);
  const newHead = loop.getPositionStep();
  assert(newHead > branchPoint, 'no new steps recorded after branching');
  assert(loop.getState().neutronics.scrammed, 'input mutation lost after branch + advance');
  // And the new timeline replays exactly too
  const midRef = cloneSimulationState(loop.getState());
  const midStep = newHead;
  for (let i = 0; i < 5; i++) loop.step(0.05);
  const landed = loop.seekToStep(midStep);
  assert(landed !== null, 'seek into the branched timeline failed');
  const got = stable(loop.getState());
  const want = stable(midRef);
  assert(got === want, `branched timeline replay differs: ${firstDiff(got, want)}`);
});

report('Replay Seek Suite');
