/**
 * Hot-duct heat leak on a coaxial cross-vessel, through the real solver.
 *
 *   npx tsx scripts/check-hot-duct-leak.ts [preset] [seconds]
 *
 * Runs the plant at power and reports the heat crossing the inner liner
 * from the hot gas to the cold annulus, against core power, with the liner
 * and gas temperatures. A coaxial duct with its internal insulation should
 * leak a small fraction of a percent; a bare liner leaks percents.
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { getConvectionHeatRates } from '../src/simulation/operators/rate-operators';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = process.argv[2] ?? path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const SECS = Number(process.argv[3] ?? 300);
const sim = buildSimFromFile(PRESET);

const cvId = [...sim.state.flowNodes.keys()].find(k => k.endsWith('-annulus'))?.replace(/-annulus$/, '');
if (!cvId) throw new Error(`${PRESET} has no cross-vessel`);

const C = (k: number) => (k - 273.15).toFixed(1);
const report = () => {
  const q = getConvectionHeatRates();
  const toLiner = -(q.get(`convection-${cvId}-inner`) ?? NaN);   // Q is wall -> fluid
  const toAnnulus = q.get(`convection-${cvId}-annulus`) ?? NaN;
  const P = sim.state.neutronics.power;
  const inner = sim.state.flowNodes.get(`${cvId}-inner`)!.fluid.temperature;
  const ann = sim.state.flowNodes.get(`${cvId}-annulus`)!.fluid.temperature;
  const liner = sim.state.thermalNodes.get(`${cvId}-wall`)!.temperature;
  console.log(`  t=${sim.state.time.toFixed(0)} s  hot gas ${C(inner)} C, liner ${C(liner)} C, annulus ${C(ann)} C | ` +
    `gas->liner ${(toLiner / 1e6).toFixed(3)} MW, liner->annulus ${(toAnnulus / 1e6).toFixed(3)} MW ` +
    `(${(100 * toAnnulus / P).toFixed(2)}% of ${(P / 1e6).toFixed(1)} MW core)`);
};

console.log(`Hot-duct leak on ${path.basename(PRESET)} (${cvId})`);
const dt = 0.05;
for (let t = 0; t < SECS; t += 60) {
  for (let i = 0; i < Math.round(Math.min(60, SECS - t) / dt); i++) {
    sim.state = sim.solver.advance(sim.state, dt).state;
    sim.state.pendingEvents = [];
  }
  report();
}
