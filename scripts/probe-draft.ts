/**
 * The natural-draft scenario from test-plant-scenarios, with the tear and
 * vent flows printed second by second over the last stretch, to see whether
 * a "mean air in" is a steady draft or an oscillation between two openings.
 *
 *   npx tsx scripts/probe-draft.ts [tearElevation=0.4] [seconds=300]
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildSimFromPlantJson, run } from './lib/sim-harness';
import { getCladdingOxidationPower } from '../src/simulation/operators/rate-operators';

const tearElevation = parseFloat(process.argv[2] || '0.4');
const seconds = parseFloat(process.argv[3] || '300');
const plant = JSON.parse(fs.readFileSync(path.join('scripts', 'test-plants', 'pool-level1.json'), 'utf-8'));
const pool = plant.components.find((c: [string, unknown]) => c[0] === 'pool')[1];
pool.fillLevel = 0;
pool.rackTemperature = 1023.15;
pool.initialNcg = { N2: 0.78, O2: 0.21 };
pool.fluid.temperature = 373.15;
plant.scenario = { description: 'tear', events: [{ time: 1, message: 'tear', actions: [{ kind: 'burst', id: 'pool', area: 0.0496, elevation: tearElevation, openingHeight: 0.8 }] }] };
const sim = buildSimFromPlantJson(plant);
const origLog = console.log;
console.log = () => {};
console.warn = () => {};
let airIn = 0, n = 0, netIn = 0, ventOut = 0;
for (let i = 0; i < seconds; i++) {
  run(sim, 1, process.env.DT ? parseFloat(process.env.DT) : 0.02);
  sim.state.pendingEvents = [];
  const tear = sim.state.flowConnections.find(c => c.id === 'break-pool');
  const vent = sim.state.flowConnections.find(c => c.fromNodeId === 'pool' && c.toNodeId === 'atmosphere' && !c.isBreakConnection)!;
  const node = sim.state.flowNodes.get('pool')!;
  if (i >= seconds - 100) { airIn += tear ? Math.max(0, -tear.massFlowRate) : 0; netIn += tear ? -tear.massFlowRate : 0; ventOut += vent.massFlowRate; n++; }
  if (i % 10 === 0 || i >= seconds - 12) {
    const moles = Object.values(node.fluid.ncg!).reduce((s, v) => s + (v as number), 0);
    origLog(`t=${String(i + 1).padStart(4)}  tear ${tear ? tear.massFlowRate.toFixed(3).padStart(7) : '   n/a'}  vent ${vent.massFlowRate.toFixed(3).padStart(7)}  ` +
      `P ${(node.fluid.pressure / 1e5).toFixed(4)}  T ${(node.fluid.temperature - 273.15).toFixed(0)} C  ${node.fluid.phase}  ` +
      `mass ${node.fluid.mass.toFixed(2)} kg  gasV ${(node.fluid.gasVolume ?? -1).toFixed(1)}  moles ${moles.toFixed(0)}  ` +
      `O2 ${(100 * node.fluid.ncg!.O2 / moles).toFixed(2)}%  ox ${((getCladdingOxidationPower().get('pool-clad') ?? 0) / 1e6).toFixed(2)} MW`);
  }
}
origLog(`mean air in over the last 100 s: ${(airIn / n).toFixed(3)} kg/s; NET in through the tear ${(netIn / n).toFixed(3)} kg/s; mean vent out ${(ventOut / n).toFixed(3)} kg/s`);
