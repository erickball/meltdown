/**
 * Pipe contents tracker (src/render/display-flow.ts)
 *
 * The renderer colours a line with its donor node's fluid. Picking the donor
 * from the instantaneous flow sign strobes any line that sloshes about zero
 * net flow - the Xe-100 steam generator's stub up to its shut tube-leak
 * valve reversed ~38 times a second. The tracker instead follows which end's
 * fluid the pipe is actually full of. These tests pin that behaviour and
 * then measure the real preset.
 *
 * Usage: npx tsx scripts/test-display-flow.ts [--preset]
 *   --preset  also runs the Xe-100 preset (slow, ~40s) and reports how often
 *             each line's displayed donor changes, tracked vs unfiltered.
 */

import { test, assert, report, buildSimFromFile, run } from './lib/sim-harness';
import { PipeContentsTracker } from '../src/render/display-flow';
import { drawCompositionAt } from '../src/simulation/operators/connection-hydraulics';
import type { SimulationState, FlowConnection, FlowNode } from '../src/simulation/types';

const PIPE_AREA = 0.01;    // m²
const PIPE_LENGTH = 5;     // m  -> 0.05 m³ of pipe
const RHO = 500;           // kg/m³ node inventory (mass/volume)
/** Mass that fills the test pipe end to end. Not PIPE_AREA*LENGTH*RHO: the
 *  tracker moves the interface at the DRAW density from the water tables,
 *  which is the density of the liquid it is actually pushing, not the
 *  node's mass/volume inventory. */
const PIPE_MASS = PIPE_AREA * PIPE_LENGTH * 500;

function node(id: string): FlowNode {
  return {
    id,
    volume: 1,
    fluid: { mass: RHO, temperature: 400, pressure: 1e6, phase: 'liquid', quality: 0 },
  } as unknown as FlowNode;
}

/** One connection between two single-phase liquid nodes, at `massFlowRate`. */
function fakeState(time: number, massFlowRate: number): SimulationState {
  const conn = {
    id: 'c', fromNodeId: 'a', toNodeId: 'b', massFlowRate,
    flowArea: PIPE_AREA, length: PIPE_LENGTH, fromElevation: 0, toElevation: 0,
  } as unknown as FlowConnection;
  return {
    time,
    flowConnections: [conn],
    flowNodes: new Map([['a', node('a')], ['b', node('b')]]),
  } as unknown as SimulationState;
}

/** Feed a flow signal sampled every `dt`; return the donor-end history. */
function ends(signal: (t: number) => number, duration: number, dt: number): string[] {
  const tracker = new PipeContentsTracker();
  const out: string[] = [];
  for (let t = 0; t <= duration + 1e-9; t += dt) {
    const state = fakeState(t, signal(t));
    tracker.update(state);
    out.push(tracker.donorEnd(state.flowConnections[0]));
  }
  return out;
}

function changes(s: string[]): number {
  let n = 0;
  for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1]) n++;
  return n;
}

test('sloshing that never flushes the line leaves the colour fixed', () => {
  // +-1 kg/s reversing at 5 Hz sweeps 0.1 kg per half cycle, well under the
  // 25 kg the pipe holds: exactly the dead-leg case that used to strobe
  const s = ends(t => (Math.floor(t * 10) % 2 === 0 ? 1 : -1), 60, 0.02);
  assert(changes(s) === 0, `displayed donor changed ${changes(s)} times`);
});

test('a zero-mean slosh BIGGER than the line does flush it both ways', () => {
  // 5000 kg/s for 0.1 s each way moves 500 kg through a 25 kg line: the line
  // really is being replaced twice a cycle and the colour should say so
  const s = ends(t => (Math.floor(t * 5) % 2 === 0 ? 5000 : -5000), 10, 0.02);
  assert(changes(s) > 5, 'a line that is genuinely flushed both ways never changed');
});

test('a real reversal changes the colour after one pipe volume', () => {
  const dt = 0.02;
  const w = PIPE_MASS;   // kg/s, reversing at t=20
  const rho = drawCompositionAt(node('a'), 0, w).rho;
  const sweepTime = (PIPE_AREA * PIPE_LENGTH) / (w / rho);
  const s = ends(t => (t < 20 ? w : -w), 30, dt);
  const flipped = s.findIndex((v, i) => i * dt >= 20 && v === 'to') * dt;
  assert(Math.abs(flipped - (20 + sweepTime)) < 3 * dt,
    `reversal read at ${flipped.toFixed(2)}s, expected ${(20 + sweepTime).toFixed(2)}s ` +
    `(one ${(PIPE_AREA * PIPE_LENGTH).toFixed(3)}m³ pipe volume at rho=${rho.toFixed(0)})`);
});

test('a line seen for the first time takes its flow direction', () => {
  const tracker = new PipeContentsTracker();
  const reverse = fakeState(0, -10);
  tracker.update(reverse);
  assert(tracker.donorEnd(reverse.flowConnections[0]) === 'to', 'reverse-flowing line started wrong');
  const forward = fakeState(0, 10);
  assert(new PipeContentsTracker().donorEnd(forward.flowConnections[0]) === 'from',
    'untracked line ignored its flow direction');
});

test('a paused sim and a backwards seek hold the ledger', () => {
  const tracker = new PipeContentsTracker();
  tracker.update(fakeState(0, PIPE_MASS));        // starts full from 'a'
  tracker.update(fakeState(1, PIPE_MASS));
  const held = tracker.fromFraction(fakeState(1, 0).flowConnections[0]);
  tracker.update(fakeState(1, -PIPE_MASS * 100)); // paused: dt = 0
  assert(tracker.fromFraction(fakeState(1, 0).flowConnections[0]) === held, 'paused frame moved the ledger');
  tracker.update(fakeState(0.5, -PIPE_MASS * 100)); // scrubbed back: dt < 0
  assert(tracker.fromFraction(fakeState(1, 0).flowConnections[0]) === held, 'backwards seek moved the ledger');
});

test('the interface saturates at both pipe ends', () => {
  const tracker = new PipeContentsTracker();
  for (let t = 0; t <= 100; t += 1) tracker.update(fakeState(t, PIPE_MASS));
  const conn = fakeState(0, 0).flowConnections[0];
  assert(tracker.fromFraction(conn) === 1, 'interface ran past the far end');
  for (let t = 101; t <= 200; t += 1) tracker.update(fakeState(t, -PIPE_MASS));
  assert(tracker.fromFraction(conn) === 0, 'interface ran past the near end');
});

test('retired connection ids are dropped', () => {
  const tracker = new PipeContentsTracker();
  const two = fakeState(0, 1);
  const extra = { ...two.flowConnections[0], id: 'gone' } as FlowConnection;
  two.flowConnections.push(extra);
  tracker.update(two);
  tracker.update(fakeState(1, 1));
  assert(Number.isNaN(tracker.fromFraction(extra)), 'stale connection id survived a plant rebuild');
});

// ---------------------------------------------------------------------------
// Optional: the real preset the complaint came from
// ---------------------------------------------------------------------------

if (process.argv.includes('--preset')) {
  test('Xe-100 lines stop strobing between donor nodes', () => {
    const sim = buildSimFromFile('src/presets/xe100.json');
    const tracker = new PipeContentsTracker();
    const prevRaw = new Map<string, string>();
    const prevShown = new Map<string, string>();
    const rawFlips = new Map<string, number>();
    const shownFlips = new Map<string, number>();
    const settle = 20;
    const total = 60;

    run(sim, total, 0.02, (state: SimulationState) => {
      tracker.update(state);
      if (state.time < settle) return;
      for (const c of state.flowConnections) {
        const raw = c.massFlowRate >= 0 ? c.fromNodeId : c.toNodeId;
        const shown = tracker.donorEnd(c) === 'from' ? c.fromNodeId : c.toNodeId;
        if (prevRaw.get(c.id) !== undefined && prevRaw.get(c.id) !== raw)
          rawFlips.set(c.id, (rawFlips.get(c.id) ?? 0) + 1);
        if (prevShown.get(c.id) !== undefined && prevShown.get(c.id) !== shown)
          shownFlips.set(c.id, (shownFlips.get(c.id) ?? 0) + 1);
        prevRaw.set(c.id, raw);
        prevShown.set(c.id, shown);
      }
    });

    const window = total - settle;
    const worstRaw = [...rawFlips.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\n  donor changes per second over ${window}s:`);
    for (const [id, n] of worstRaw.slice(0, 5)) {
      console.log(`    raw ${(n / window).toFixed(2)}/s -> displayed ` +
        `${((shownFlips.get(id) ?? 0) / window).toFixed(2)}/s  ${id}`);
    }
    const leak = 'flow-hx-1-val-leak-1';
    assert((rawFlips.get(leak) ?? 0) / window > 5,
      'the tube-leak stub no longer strobes unfiltered - retune this test');
    for (const [id, n] of shownFlips) {
      assert(n / window < 0.5, `${id} still changes donor ${(n / window).toFixed(2)} times/s`);
    }
  });
}

report('pipe contents tracker tests');
