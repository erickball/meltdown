/**
 * Xe-100 performance probe.
 *
 * Runs the preset headless with no per-tick printing and reports the numbers a
 * perf pass needs: speed vs realtime, per-operator wall time, solver step /
 * rejection health, and which nodes drive the error controller.
 *
 * Usage: npx tsx scripts/perf-xe100.ts [seconds] [tickDt] [preset]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const seconds = parseFloat(args[0] || '300');
const tickDt = parseFloat(args[1] || '0.1');
const preset = args[2] || path.join(HERE, '..', 'src', 'presets', 'xe100.json');

const sim = buildSimFromFile(preset);
console.log(`preset=${path.basename(preset)} nodes=${sim.state.flowNodes.size} ` +
  `conns=${sim.state.flowConnections.length} thermal=${sim.state.thermalNodes.size}`);

const operatorTotals = new Map<string, number>();
const contributorTotals = new Map<string, number>();
const ticks = Math.round(seconds / tickDt);
const wallStart = performance.now();

for (let i = 0; i < ticks; i++) {
  const result = sim.solver.advance(sim.state, tickDt);
  sim.state = result.state;
  sim.state.pendingEvents = [];
  for (const [name, ms] of result.metrics.operatorTimes) {
    operatorTotals.set(name, (operatorTotals.get(name) || 0) + ms);
  }
  for (const c of result.metrics.topErrorContributors) {
    const key = `${c.nodeId}[${c.type}]`;
    contributorTotals.set(key, (contributorTotals.get(key) || 0) + c.contribution);
  }
}

const wallSec = (performance.now() - wallStart) / 1000;
const stats = sim.solver.getMetrics();
console.log(`\nsimulated ${sim.state.time.toFixed(1)}s in ${wallSec.toFixed(2)}s wall ` +
  `= ${(sim.state.time / wallSec).toFixed(3)}x realtime`);
console.log(`steps=${stats.totalSteps} rejected=${stats.rejectedSteps} ` +
  `(${(100 * stats.rejectedSteps / Math.max(1, stats.totalSteps)).toFixed(0)}%) ` +
  `final dt=${(stats.currentDt * 1e3).toFixed(2)}ms ` +
  `wall/step=${(1e3 * wallSec / Math.max(1, stats.totalSteps)).toFixed(3)}ms`);
console.log(`power=${(sim.state.neutronics.power / 1e6).toFixed(1)}MW`);

console.log('\noperator wall time:');
const opSorted = [...operatorTotals.entries()].sort((a, b) => b[1] - a[1]);
const opTotal = opSorted.reduce((a, [, ms]) => a + ms, 0);
for (const [name, ms] of opSorted) {
  if (ms / 1000 < 0.01) continue;
  console.log(`  ${name.padEnd(34)} ${(ms / 1000).toFixed(2)}s  ` +
    `${(100 * ms / 1000 / wallSec).toFixed(1)}% of wall`);
}
console.log(`  ${'(operator total)'.padEnd(34)} ${(opTotal / 1000).toFixed(2)}s  ` +
  `${(100 * opTotal / 1000 / wallSec).toFixed(1)}% of wall`);

console.log('\nrejection causes:');
for (const [cause, n] of [...sim.solver.rejectionStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${cause.padEnd(50)} ${n}`);
}

console.log('\ntop error contributors (summed share):');
for (const [key, share] of [...contributorTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${key.padEnd(40)} ${(100 * share / ticks).toFixed(1)}%`);
}
