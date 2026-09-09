/**
 * Start-up jitter probe for the SPENT FUEL POOL level: run the stock plant
 * from t=0 with nobody at the controls and print, at fine resolution, every
 * quantity the level readout is built from - liquid level, mass, quality,
 * node pressure, and the vent connection's flow.
 *
 *   npx tsx scripts/probe-sfp-jitter.ts [simSeconds] [dt] [reportEvery]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import { nodeLiquidLevel } from '../src/simulation';
import { massQualityToVolumeFraction } from '../src/render/colors';

const FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'game-mode', 'levels', 'spent-fuel-pool.json');

const seconds = process.argv[2] ? parseFloat(process.argv[2]) : 60;
const dt = process.argv[3] ? parseFloat(process.argv[3]) : 0.25;
const every = process.argv[4] ? parseFloat(process.argv[4]) : dt;
const from = process.argv[5] ? parseFloat(process.argv[5]) : 0;

const sim = buildSimFromFile(FILE);
const pool = () => sim.state.flowNodes.get('pool')!;
const vent = () => sim.state.flowConnections.find(c => c.id === 'flow-pool-atmosphere')!;

console.log('      t/s          level/m      drawn/m        mass/kg      quality        P/Pa    vent/kg/s');
let next = 0;
const levels: number[] = [];
const drawn: number[] = [];
const drawnLevel = (n: any) => {
  const f = { ...n.fluid, volume: n.volume };
  return (1 - massQualityToVolumeFraction(f.quality ?? 0, f.pressure, f as any)) * (n.height ?? 1);
};
while (sim.state.time < seconds - 1e-9) {
  run(sim, Math.min(every, seconds - sim.state.time), dt);
  const n = pool();
  levels.push(nodeLiquidLevel(n));
  drawn.push(drawnLevel(n));
  if (sim.state.time >= next && sim.state.time >= from) {
    next = sim.state.time + every;
    console.log(
      `${sim.state.time.toFixed(2).padStart(9)} ${nodeLiquidLevel(n).toFixed(6).padStart(16)} ` +
      `${drawnLevel(n).toFixed(4).padStart(11)} ` +
      `${n.fluid.mass.toFixed(1).padStart(14)} ${(n.fluid.quality ?? 0).toExponential(4).padStart(12)} ` +
      `${n.fluid.pressure.toFixed(1).padStart(11)} ${vent().massFlowRate.toFixed(4).padStart(12)}`);
  }
  sim.state.pendingEvents = [];
}

// Peak-to-peak of the step-to-step change: the jitter the eye sees.
let maxJump = 0;
for (let i = 1; i < levels.length; i++) {
  maxJump = Math.max(maxJump, Math.abs(levels[i] - levels[i - 1]));
}
console.log(`\nlevel samples ${levels.length}, largest step-to-step change ${(maxJump * 1000).toFixed(3)} mm`);
