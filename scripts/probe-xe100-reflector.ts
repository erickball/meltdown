/**
 * Reflector and vessel-side temperatures of an Xe-100 preset, at build and
 * after a settle: is the graphite started near where the plant holds it?
 *
 * Usage: npx tsx scripts/probe-xe100-reflector.ts <preset.json> [seconds] [printEvery]
 */
import { buildSimFromFile } from './lib/sim-harness';
import { nodeHeatCapacity } from '../src/simulation';

const [presetPath, secArg, everyArg] = process.argv.slice(2);
const seconds = parseFloat(secArg ?? '0');
const every = parseFloat(everyArg ?? '600');
const sim = buildSimFromFile(presetPath);
const C = (K: number | undefined) => ((K ?? NaN) - 273.15).toFixed(1);

function report(): void {
  const s = sim.state;
  const solids = ['cb-1-reflector', 'cb-1-clad', 'cb-1-fuel', 'rv-1-wall'].map(id => {
    const n = s.thermalNodes.get(id);
    return n ? `${id} ${C(n.temperature)} C (${(nodeHeatCapacity(n) / 1e6).toFixed(0)} MJ/K)` : `${id} -`;
  });
  const gas = ['cb-1', 'rv-1', 'cv-1-inner', 'cv-1-annulus', 'hx-1-shell']
    .map(id => `${id} ${C(s.flowNodes.get(id)?.fluid.temperature)}`);
  console.log(`t=${s.time.toFixed(0)}  power ${(s.neutronics.power / 1e6).toFixed(1)} MW | ${solids.join(', ')} | gas: ${gas.join(', ')}`);
}

report();
let next = sim.state.time + every;
const end = sim.state.time + seconds;
while (sim.state.time < end) {
  sim.state = sim.solver.advance(sim.state, 0.05).state;
  sim.state.pendingEvents = [];
  if (sim.state.time < next) continue;
  next += every;
  report();
}
