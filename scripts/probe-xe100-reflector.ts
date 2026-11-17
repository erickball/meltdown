/**
 * Reflector, core barrel and vessel-side temperatures of an Xe-100 preset, at
 * build and after a settle: is the graphite started near where the plant
 * holds it, and what crosses each of its faces?
 *
 * Heat flows are the convection duties the solver last recorded (wall to
 * fluid positive), plus the reflector's own storage rate from its
 * temperature change over the print interval.
 *
 * Usage: npx tsx scripts/probe-xe100-reflector.ts <preset.json> [seconds] [printEvery]
 */
import { buildSimFromFile } from './lib/sim-harness';
import { nodeHeatCapacity } from '../src/simulation';
import { getConvectionHeatRates } from '../src/simulation/operators/rate-operators';

const [presetPath, secArg, everyArg] = process.argv.slice(2);
const seconds = parseFloat(secArg ?? '0');
const every = parseFloat(everyArg ?? '600');
const sim = buildSimFromFile(presetPath);
const C = (K: number | undefined) => ((K ?? NaN) - 273.15).toFixed(1);
const MW = (W: number | undefined) => W === undefined ? '-' : (W / 1e6).toFixed(2);

const SHELLS = ['cb-1-reflector', 'cb-1-reflector-outer'];
const shellTemps = () => SHELLS.map(id => sim.state.thermalNodes.get(id)?.temperature);
let lastShellT = shellTemps();
let lastTime = sim.state.time;

function report(): void {
  const s = sim.state;
  const solids = ['cb-1-reflector', 'cb-1-reflector-outer', 'cb-1-wall', 'cb-1-clad', 'cb-1-fuel', 'rv-1-wall'].map(id => {
    const n = s.thermalNodes.get(id);
    return n ? `${id} ${C(n.temperature)} C (${(nodeHeatCapacity(n) / 1e6).toFixed(0)} MJ/K)` : `${id} -`;
  });
  const gas = ['cb-1', 'rv-1', 'cv-1-inner', 'cv-1-annulus', 'hx-1-shell']
    .map(id => `${id} ${C(s.flowNodes.get(id)?.fluid.temperature)}`);
  console.log(`t=${s.time.toFixed(0)}  power ${(s.neutronics.power / 1e6).toFixed(1)} MW | ${solids.join(', ')} | gas: ${gas.join(', ')}`);

  const q = getConvectionHeatRates();
  // Storage rate of all the reflector graphite (one shell on older builds)
  let stored: number | undefined;
  if (s.time > lastTime) {
    stored = 0;
    SHELLS.forEach((id, i) => {
      const n = s.thermalNodes.get(id);
      if (n && lastShellT[i] !== undefined) {
        stored! += nodeHeatCapacity(n) * (n.temperature - lastShellT[i]!) / (s.time - lastTime);
      }
    });
  }
  console.log(
    `      MW to fluid: reflector inner -> core gas ${MW(q.get('convection-cb-1-reflector-inner'))}, ` +
    `reflector outer -> vessel gas ${MW(q.get('convection-cb-1-reflector-outer'))}, ` +
    `barrel -> vessel gas ${MW(q.get('convection-cb-1-wall-outer'))}, ` +
    `vessel wall -> vessel gas ${MW(q.get('convection-rv-1-wall'))} | reflector storing ${MW(stored)}`
  );
  lastShellT = shellTemps();
  lastTime = s.time;
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
