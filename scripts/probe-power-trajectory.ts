/**
 * Power-trajectory probe for A/B comparisons.
 *
 * Runs a preset headless and prints reactor power, solver dt, and step /
 * rejection counts at a fixed sampling interval, so two solver configurations
 * can be compared as TRAJECTORIES rather than single endpoints (a scheme that
 * settles to the wrong operating point looks fine in an endpoint check).
 *
 * Usage: npx tsx scripts/probe-power-trajectory.ts [preset] [seconds] [sampleEvery] [tickDt]
 * Knobs: IMPLICIT_ADVECTION=1, ENERGY_COMPLIANCE=0, IMPLICIT_MOMENTUM=0 (see sim-harness);
 *        MAX_DT=<seconds> caps the solver dt (isolates dt-dependent splitting error
 *        from outright bugs: a consistent scheme must converge to the reference as dt->0)
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const preset = args[0] || path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const seconds = parseFloat(args[1] || '600');
const sampleEvery = parseFloat(args[2] || '60');
const tickDt = parseFloat(args[3] || '0.1');

const maxDtEnv = process.env.MAX_DT;
const sim = buildSimFromFile(preset, maxDtEnv ? { maxDt: parseFloat(maxDtEnv) } : {});
const ticksPerSample = Math.max(1, Math.round(sampleEvery / tickDt));
const totalTicks = Math.round(seconds / tickDt);

console.log(`preset=${path.basename(preset)} seconds=${seconds} tickDt=${tickDt}`);
console.log('t(s)\tpower(MW)\tdt(ms)\tsteps\trejected');

const wallStart = performance.now();
let lastSteps = 0;
let lastRejected = 0;
for (let i = 1; i <= totalTicks; i++) {
  const result = sim.solver.advance(sim.state, tickDt);
  sim.state = result.state;
  sim.state.pendingEvents = [];
  if (i % ticksPerSample === 0 || i === totalTicks) {
    const s = sim.solver.getMetrics();
    console.log(`${sim.state.time.toFixed(0)}\t${(sim.state.neutronics.power / 1e6).toFixed(1)}\t` +
      `${(s.currentDt * 1e3).toFixed(1)}\t${s.totalSteps - lastSteps}\t${s.rejectedSteps - lastRejected}`);
    lastSteps = s.totalSteps;
    lastRejected = s.rejectedSteps;
  }
}
const wallSec = (performance.now() - wallStart) / 1000;
console.log(`\nwall=${wallSec.toFixed(2)}s = ${(sim.state.time / wallSec).toFixed(2)}x realtime`);
console.log(`governor: predictive-swing rejections=${sim.solver.predictiveSwingRejections} ` +
  `explicit-fallback steps=${sim.solver.explicitFallbackSteps}`);
console.log('top rejection causes:');
for (const [cause, n] of [...sim.solver.rejectionStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${cause.padEnd(50)} ${n}`);
}
