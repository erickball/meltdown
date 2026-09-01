/**
 * Where does the wall-node policy's cost actually go?
 *
 * Going from 'rpv-bui' to 'all' cost 1.84x on w4loop. That was attributed to
 * the node count without checking, which is not good enough: thermal nodes
 * are one-line ODEs, and the flow solve with its pressure iteration and
 * property calls is supposed to be what dominates a step.
 *
 * So this counts what each policy actually builds, and times the pieces:
 * total step time, and the convection pass in isolation (which is where the
 * new walls all land - each wall is TWO convection connections, and each of
 * those now runs the temperature-dependent property set).
 *
 * Usage: npx tsx scripts/wall-cost-bench.ts [preset] [seconds]
 *        WALL_NODES=rpv-bui|thick|all to pick the tier
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import { ConvectionRateOperator } from '../src/simulation/operators/rate-operators';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const preset = process.argv[2] ?? 'w4loop';
const seconds = parseFloat(process.argv[3] ?? '20');

const sim = buildSimFromFile(path.join(HERE, '..', 'src', 'presets', `${preset}.json`));
const s = sim.state;

const policy = process.env.WALL_NODES ?? 'all (default)';
console.log(`\n=== ${preset}, WALL_NODES=${policy} ===`);
console.log(`  flow nodes             ${s.flowNodes.size}`);
console.log(`  thermal nodes          ${s.thermalNodes.size}`);
console.log(`  flow connections       ${s.flowConnections.length}`);
console.log(`  convection connections ${s.convectionConnections.length}`);
console.log(`  thermal connections    ${s.thermalConnections.length}`);

// How much of a step is the convection pass? Time it standalone against the
// settled state - same state, many repeats, so the comparison is clean.
run(sim, 5, 0.02);
const conv = new ConvectionRateOperator();
const REPS = 2000;
let t0 = performance.now();
for (let i = 0; i < REPS; i++) conv.computeRates(sim.state);
const convMs = (performance.now() - t0) / REPS;
console.log(`\n  convection pass        ${(convMs * 1000).toFixed(1)} us/call ` +
  `(${s.convectionConnections.length} connections)`);

// Wall clock on this machine swings ~30% run to run, so the headline number
// is the DETERMINISTIC one: how many integration steps the policy costs.
// Multiply by the measured per-call convection cost above to get the share
// that is convection rather than solver bookkeeping.
let steps = 0, rejects = 0;
t0 = performance.now();
const ticks = Math.round(seconds / 0.02);
for (let i = 0; i < ticks; i++) {
  const r = sim.solver.advance(sim.state, 0.02);
  sim.state = r.state;
  sim.state.pendingEvents = [];
  const m = r.metrics as any;
  steps += m.subcycleCount ?? 0;
  rejects += m.retriesThisFrame ?? 0;
}
const wall = (performance.now() - t0) / 1000;
console.log(`  integration steps      ${steps} (${rejects} rejected)`);
console.log(`  convection share       ${(steps * 7 * convMs / 1000).toFixed(1)} s ` +
  `of ${wall.toFixed(1)} s wall clock (7 stages/step)`);
