/**
 * Achieved speed under the BROWSER's solver regime, headless.
 *
 * The game loop does not run the solver the way the script harness does: it
 * asks for one frame's worth of simulation per animation frame (frameDt x
 * requested speed), with relTol 1e-3, maxDt 0.5 s, non-deterministic mode
 * and a 30 ms wall budget per advance() - the solver yields at the budget
 * and the unserved remainder is dropped. So a preset that runs 7x in the
 * harness can still sit at 1x in the tab. This probe reproduces that
 * regime (minus rendering) so solver-side causes can be separated from
 * UI-side ones.
 *
 * Usage: npx tsx scripts/probe-ui-regime.ts [preset] [speed] [wallSeconds] [fps]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const preset = args[0] || path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const speed = parseFloat(args[1] || '4');
const wallSeconds = parseFloat(args[2] || '20');
const fps = parseFloat(args[3] || '60');

// Same numbers the game loop constructs its solver with (src/game/loop.ts)
const sim = buildSimFromFile(preset, {
  minDt: 1e-6, maxDt: 0.5, initialDt: 0.001, relTol: 1e-3, absTol: 1e-6,
  deterministicMode: false,
});

const frameDt = 1 / fps;
const t0 = performance.now();
let frames = 0, budgetHits = 0;
let lastReport = t0;
const simStart = sim.state.time;
let simAtReport = simStart;
while (performance.now() - t0 < wallSeconds * 1000) {
  const r = sim.solver.advance(sim.state, frameDt * speed, frameDt * 1000);
  sim.state = r.state;
  sim.state.pendingEvents = [];
  frames++;
  if (r.metrics.isFallingBehind) budgetHits++;
  const now = performance.now();
  if (now - lastReport > 5000) {
    const achieved = (sim.state.time - simAtReport) / ((now - lastReport) / 1000);
    console.log(`wall ${((now - t0) / 1000).toFixed(0)} s: achieved ${achieved.toFixed(2)}x of requested ${speed}x, ` +
      `sim t=${sim.state.time.toFixed(1)} s, dt=${(r.metrics.currentDt * 1e3).toFixed(1)} ms, ` +
      `power ${(sim.state.neutronics.power / 1e6).toFixed(1)} MW`);
    lastReport = now; simAtReport = sim.state.time;
  }
}
const wall = (performance.now() - t0) / 1000;
const m = sim.solver.getMetrics();
console.log(`requested ${speed}x: achieved ${((sim.state.time - simStart) / wall).toFixed(2)}x over ${wall.toFixed(0)} s wall, ` +
  `${frames} frames, ${budgetHits} frames fell behind, steps=${m.totalSteps} rejected=${m.rejectedSteps}`);
