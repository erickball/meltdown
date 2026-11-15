/**
 * Where the Xe-100's reactor power goes while the plant is still settling.
 *
 * The steam side levels off in minutes; the reactor side takes hours, because
 * the difference is being stored - in the graphite, the vessel, the RCCS
 * water. Every PRINT_EVERY seconds this prints reactor power against what the
 * helium carries away, the stored heat of each group of thermal nodes and of
 * the RCCS water with its rate of change over the interval, and the RCCS
 * temperatures.
 *
 * Usage: npx tsx scripts/probe-xe100-heat-ledger.ts <preset.json> <seconds> [printEvery]
 */
import { buildSimFromFile } from './lib/sim-harness';
import { nodeHeatCapacity } from '../src/simulation';

const [presetPath, secArg, everyArg] = process.argv.slice(2);
const seconds = parseFloat(secArg ?? '3600');
const every = parseFloat(everyArg ?? '600');
const sim = buildSimFromFile(presetPath);

const CP_HE = 5193; // J/kg-K
const C = (K: number) => (K - 273.15).toFixed(1);
const flowBetween = (a: string, b: string) => {
  let w = 0;
  for (const c of sim.state.flowConnections) {
    if (c.fromNodeId === a && c.toNodeId === b) w += c.massFlowRate;
    else if (c.fromNodeId === b && c.toNodeId === a) w -= c.massFlowRate;
  }
  return w;
};

const groupOf = (id: string) => id.replace(/(-\d+)+$/, '').replace(/-(z|zone|seg|layer)\d+.*$/, '');
/** Every thermal node's temperature, to difference over the interval. */
function solidTemps(): Map<string, number> {
  return new Map([...sim.state.thermalNodes].map(([id, n]) => [id, n.temperature]));
}
const rccsIds = () => [...sim.state.flowNodes.keys()].filter(id => /rccs/.test(id));
const rccsEnergy = () => rccsIds().reduce((s, id) => s + sim.state.flowNodes.get(id)!.fluid.internalEnergy, 0);

let last = { t: sim.state.time, temps: solidTemps(), rccs: rccsEnergy() };
let next = sim.state.time + every;
let accT = 0, accQ = 0, accHe = 0;
const end = sim.state.time + seconds;
while (sim.state.time < end) {
  sim.state = sim.solver.advance(sim.state, 0.05).state;
  sim.state.pendingEvents = [];
  const s = sim.state;
  const TIn = s.flowNodes.get('rv-1')!.fluid.temperature;
  const TOut = s.flowNodes.get('cb-1')!.fluid.temperature;
  accT += 0.05;
  accQ += 0.05 * s.neutronics.power;
  accHe += 0.05 * flowBetween('cv-1-annulus', 'rv-1') * CP_HE * (TOut - TIn);
  if (s.time < next) continue;
  next += every;
  const now = { t: s.time, temps: solidTemps(), rccs: rccsEnergy() };
  const dt = now.t - last.t;
  // Heat taken up = heat capacity (at the present temperature) x rise
  const byGroup = new Map<string, number>();
  for (const [id, n] of s.thermalNodes) {
    const rise = n.temperature - (last.temps.get(id) ?? n.temperature);
    byGroup.set(groupOf(id), (byGroup.get(groupOf(id)) ?? 0) + nodeHeatCapacity(n) * rise / dt);
  }
  const rates = [...byGroup].filter(([, r]) => Math.abs(r) > 2e4)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  console.log(`t=${s.time.toFixed(0)}  reactor ${(accQ / accT / 1e6).toFixed(1)} MW  helium pickup ${(accHe / accT / 1e6).toFixed(1)} MW ` +
    `(core ${C(s.flowNodes.get('rv-1')!.fluid.temperature)} -> ${C(s.flowNodes.get('cb-1')!.fluid.temperature)} C)`);
  console.log(`   RCCS water: ${((now.rccs - last.rccs) / dt / 1e6).toFixed(2)} MW into it; ` +
    rccsIds().map(id => `${id} ${C(s.flowNodes.get(id)!.fluid.temperature)} C ${(s.flowNodes.get(id)!.fluid.pressure / 1e5).toFixed(2)} bar`).join(', '));
  console.log(`   solids gaining heat (MW): ` + rates.map(([g, r]) => `${g} ${(r / 1e6).toFixed(2)}`).join(', '));
  last = now;
  accT = 0; accQ = 0; accHe = 0;
}
