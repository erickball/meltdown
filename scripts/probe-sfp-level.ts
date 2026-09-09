/**
 * Tuning probe for the SPENT FUEL POOL level: run the level's stock plant with
 * nobody at the controls and print the drain / heat-up trajectory, so the
 * crack size, rack power and timeline can be set against numbers.
 *
 *   npx tsx scripts/probe-sfp-level.ts [simSeconds] [dt]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import { nodeLiquidLevel } from '../src/simulation';
import { terrainHeightAt } from '../src/simulation/terrain';

const FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'game-mode', 'levels', 'spent-fuel-pool.json');

const seconds = process.argv[2] ? parseFloat(process.argv[2]) : 21600;
const dt = process.argv[3] ? parseFloat(process.argv[3]) : 0.25;

const sim = buildSimFromFile(FILE);
const pool = () => sim.state.flowNodes.get('pool')!;
const clad = () => sim.state.thermalNodes.get('pool-clad')!;
const spec = sim.state.terrain!.spec;

console.log(`pool ground ${terrainHeightAt(spec, pool().position!).toFixed(2)} m, ` +
  `floor ${pool().elevation.toFixed(2)} m, node height ${pool().height?.toFixed(2)} m, ` +
  `volume ${pool().volume.toFixed(0)} m3`);
console.log(`sea tank ground ${terrainHeightAt(spec, sim.state.flowNodes.get('sea')!.position!).toFixed(2)} m, ` +
  `base ${sim.state.flowNodes.get('sea')!.elevation.toFixed(2)} m`);
console.log(`initial water ${(pool().fluid.mass / 1000).toFixed(0)} t at ` +
  `${(pool().fluid.temperature - 273.15).toFixed(1)} C, level ${nodeLiquidLevel(pool()).toFixed(2)} m`);
console.log(`tanks: A ${(sim.state.flowNodes.get('tank-a')!.fluid.mass / 1000).toFixed(0)} t, ` +
  `B ${(sim.state.flowNodes.get('tank-b')!.fluid.mass / 1000).toFixed(0)} t`);
console.log('');
console.log('      t/s   level/m   leak/kg/s    Twater/C     Tclad/C   pad puddle/m3');

const wall0 = performance.now();
let next = 0;
const step = 300;
while (sim.state.time < seconds) {
  run(sim, Math.min(step, seconds - sim.state.time), dt);
  if (sim.state.time >= next) {
    next = sim.state.time + 600;
    const leakConn = sim.state.flowConnections.find(c => c.id === 'break-pool');
    const puddle = Array.from(sim.state.surfaceWater!.volumes.values()).reduce((s, v) => s + v, 0);
    console.log(
      `${sim.state.time.toFixed(0).padStart(9)}  ${nodeLiquidLevel(pool()).toFixed(2).padStart(8)}  ` +
      `${(leakConn?.massFlowRate ?? 0).toFixed(1).padStart(10)}  ${(pool().fluid.temperature - 273.15).toFixed(1).padStart(10)}  ` +
      `${(clad().temperature - 273.15).toFixed(1).padStart(10)}  ${puddle.toFixed(1).padStart(14)}`);
  }
  sim.state.pendingEvents = [];
}
const wall = (performance.now() - wall0) / 1000;
console.log(`\n${(sim.state.time / wall).toFixed(1)}x realtime (${wall.toFixed(1)} s wall for ${sim.state.time.toFixed(0)} s sim)`);
