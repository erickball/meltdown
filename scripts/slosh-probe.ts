/**
 * Characterize the dried-core "slosh": what are the flows through the
 * breached core region actually doing step to step - oscillating (acoustic
 * standing wave), sustained (real circulation), or solver-artifact churn?
 *
 *   npx tsx scripts/slosh-probe.ts [t_start] [t_probe_seconds]
 *
 * Runs scripts/melt-test.json quietly to t_start, then logs every accepted
 * substep: dt and each cb-1 connection's mass flow, plus cb-1 inventory.
 */
import { buildSimFromFile, run } from './lib/sim-harness';
import { totalMass as ncgTotalMass } from '../src/simulation';

const T_START = parseFloat(process.argv[2] || '188');
const T_PROBE = parseFloat(process.argv[3] || '1.0');

const sim = buildSimFromFile('scripts/melt-test.json');

console.log(`advancing quietly to t=${T_START}s (this crawls through dryout)...`);
const quiet = console.log;
// Silence the storm during the approach, keep our own output
const noop = () => {};
console.log = noop as typeof console.log;
console.warn = noop as typeof console.warn;
console.error = noop as typeof console.error;
run(sim, T_START, 0.05);
console.log = quiet;

const connIds = sim.state.flowConnections
  .filter(c => c.fromNodeId === 'cb-1' || c.toNodeId === 'cb-1')
  .map(c => c.id);
console.log(`t=${sim.state.time.toFixed(2)}s; cb-1 connections: ${connIds.join(', ')}`);
console.log(`step, t, dt_ms, waterMass, gasMass, ` + connIds.join(', '));

console.warn = noop as typeof console.warn;
console.error = noop as typeof console.error;
let lastT = sim.state.time;
sim.solver.onSubstepComplete = (state, stepNumber, dtAcc) => {
  const cb = state.flowNodes.get('cb-1')!;
  const flows = state.flowConnections
    .filter(c => connIds.includes(c.id))
    .map(c => c.massFlowRate.toFixed(1));
  quiet(`${stepNumber}, ${state.time.toFixed(4)}, ${(dtAcc * 1000).toFixed(2)}, ` +
    `${cb.fluid.mass.toFixed(3)}, ${(cb.fluid.ncg ? ncgTotalMass(cb.fluid.ncg) : 0).toFixed(2)}, ` +
    flows.join(', '));
  lastT = state.time;
};
run(sim, T_PROBE, 0.05);
void lastT;
