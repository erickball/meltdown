/**
 * Air-ingress transient: does a graphite fire behave, and does it stay
 * numerically well behaved while it burns?
 *
 *   npx tsx scripts/graphite-fire-test.ts [seconds] [preset.json]
 *
 * Runs the gas-cooled core to a settled state, then replaces the helium in
 * the core with air at the same pressure - the endpoint of a depressurised
 * air-ingress accident - and follows what happens.
 *
 * What to look for:
 *  - Carbon consumption ramping as the graphite heats, then FALLING as the
 *    oxygen is used up. Nothing imposes that turnover; the reaction is
 *    first order in the oxygen actually present.
 *  - CO appearing in quantity once the graphite is hot (Arthur's split),
 *    which is fuel for the combustion operator downstream.
 *  - The timestep. A fire is genuinely fast physics, but the transport
 *    resistance ceiling should keep it from going stiff enough to stall.
 */

import { buildSimFromFile } from './lib/sim-harness';
import type { SimulationState } from '../src/simulation/types';
import { getGraphiteOxidationDiagnostics } from '../src/simulation/operators/graphite-oxidation';
import { createGasComposition, totalMoles } from '../src/simulation/gas-properties';

const seconds = Number(process.argv[2] ?? 600);
const presetPath = process.argv[3] ?? 'src/presets/htgr.json';

const sim = buildSimFromFile(presetPath);

const graphite0 = [...sim.state.thermalNodes.values()].filter(n => n.graphiteOxidation);
if (graphite0.length === 0) {
  console.log(`No graphite nodes in ${presetPath}.`);
  process.exit(0);
}
const coreGasId = graphite0[0].graphiteOxidation!.associatedGasNode;

// The solver returns a NEW state object each step, so nothing may be cached
// across a run - every lookup below goes through the live state.
let simTime = 0;
let minDt = Infinity;
function advance(secs: number, dt = 0.02) {
  const ticks = Math.round(secs / dt);
  for (let i = 0; i < ticks; i++) {
    const r = sim.solver.advance(sim.state, dt);
    sim.state = r.state;
    sim.state.pendingEvents = [];
    const used = r.metrics?.minDtUsed;
    if (Number.isFinite(used)) minDt = Math.min(minDt, used);
    simTime += dt;
  }
}
const gas = (st: SimulationState) => st.flowNodes.get(coreGasId)!;
const node = (st: SimulationState, suffix: string) =>
  [...st.thermalNodes.values()].find(n => n.graphiteOxidation && n.id.endsWith(suffix));

console.log(`\nSettling ${presetPath} for 60 s...`);
advance(60);

const g0 = gas(sim.state);
const P0 = g0.fluid.pressure;
const T0 = g0.fluid.temperature;
const nBefore = totalMoles(g0.fluid.ncg!);

// Replace the core atmosphere with air at the same total moles. This is the
// end state of an air-ingress accident, imposed directly so the chemistry is
// exercised without waiting on a whole depressurisation sequence.
g0.fluid.ncg = createGasComposition({ N2: 0.79 * nBefore, O2: 0.21 * nBefore });
console.log(`\nAir ingress at t=60 s: ${nBefore.toFixed(0)} mol of core gas replaced with air ` +
  `(${(0.21 * nBefore).toFixed(0)} mol O2) at ${(P0 / 1e5).toFixed(1)} bar, ${T0.toFixed(0)} K\n`);

console.log('    t (s)   T_peb (K)  T_refl (K)   burnoff %     kg C/s     O2 (mol)   ' +
  'CO (mol)  CO2 (mol)  min dt (ms)');
console.log('  ' + '-'.repeat(112));

function report() {
  const st = sim.state;
  const peb = node(st, '-clad')!;
  const refl = node(st, '-reflector');
  const ncg = gas(st).fluid.ncg!;
  const d = getGraphiteOxidationDiagnostics().get(peb.id);
  const carbon = d ? Object.values(d.carbonRate).reduce((a, b) => a + b, 0) : 0;
  console.log(
    `  ${simTime.toFixed(0).padStart(7)}  ` +
    `${peb.temperature.toFixed(0).padStart(9)}  ` +
    `${(refl ? refl.temperature.toFixed(0) : '-').padStart(10)}  ` +
    `${(peb.graphiteOxidation!.burnoff * 100).toFixed(4).padStart(10)}  ` +
    `${carbon.toExponential(2).padStart(10)}  ` +
    `${(ncg.O2 ?? 0).toFixed(0).padStart(10)}  ` +
    `${(ncg.CO ?? 0).toFixed(0).padStart(9)}  ` +
    `${(ncg.CO2 ?? 0).toFixed(0).padStart(9)}  ` +
    `${(minDt * 1000).toFixed(3).padStart(10)}`);
}

report();
const step = Math.max(10, seconds / 20);
for (let t = 0; t < seconds; t += step) {
  advance(step);
  report();
}

const peb = node(sim.state, '-clad')!;
const burned = peb.graphiteOxidation!.burnoff * peb.graphiteOxidation!.initialCarbonMass;
console.log(`\nPebble graphite consumed: ${burned.toFixed(1)} kg of ` +
  `${peb.graphiteOxidation!.initialCarbonMass.toFixed(0)} kg ` +
  `(${(peb.graphiteOxidation!.burnoff * 100).toFixed(4)}%)`);
console.log(`Smallest timestep seen: ${(minDt * 1000).toFixed(3)} ms`);
console.log();
