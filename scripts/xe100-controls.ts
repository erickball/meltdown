/**
 * Xe-100 control-loop trace.
 *
 * The plant cycles rather than settling, and the interesting question is
 * WHICH loop is driving it. This prints, once a second, everything the three
 * control loops see and do plus the inventory they are all really fighting
 * over - where the secondary's water actually is.
 *
 * Usage: npx tsx scripts/xe100-controls.ts [seconds]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import { nodeLiquidLevel } from '../src/simulation';
import type { SimulationState } from '../src/simulation/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const seconds = parseFloat(process.argv[2] || '400');
const sim = buildSimFromFile(path.join(HERE, '..', 'src', 'presets', 'xe100.json'));

const node = (id: string) => sim.state.flowNodes.get(id);
const flowOut = (state: SimulationState, from: string) => state.flowConnections
  .filter(c => c.fromNodeId === from).reduce((s, c) => s + c.massFlowRate, 0);

/** Every kilogram of water on the secondary side, by where it is sitting. */
function inventory(state: SimulationState) {
  let boiler = 0, hotwell = 0, elsewhere = 0;
  for (const [id, n] of state.flowNodes) {
    if (n.fluid.ncg || n.isBoundary) continue;   // helium spaces and atmosphere
    if (/^hx-1-tube/.test(id)) boiler += n.fluid.mass;
    else if (id === 'condenser-1') hotwell += n.fluid.mass;
    else elsewhere += n.fluid.mass;
  }
  return { boiler, hotwell, elsewhere, total: boiler + hotwell + elsewhere };
}

console.log(
  '   t(s)  hotwell  lvl  fwP-suction   fwSpd    feed  boiler(t)  P_stm   gov   ' +
  'steam  T_stm  sh%   inv(t)');

for (let t = 0; t <= seconds; t++) {
  if (t > 0) {
    try { run(sim, 1, 0.05); } catch (e: any) {
      console.log(`THREW at t=${sim.state.time.toFixed(1)}: ${e.message}`); break;
    }
  }
  if (t % 10) continue;
  const s = sim.state;
  const cond = node('condenser-1')!;
  const fwSuction = node('fw-pump-1')!;
  const inv = inventory(s);
  const tube = node('hx-1-tube')!;
  console.log(
    `${s.time.toFixed(0).padStart(7)} ` +
    `${(cond.fluid.mass / 1000).toFixed(1).padStart(7)}t ` +
    `${nodeLiquidLevel(cond).toFixed(2).padStart(5)} ` +
    `${(fwSuction.fluid.pressure / 1e5).toFixed(2).padStart(7)}b ` +
    `${fwSuction.fluid.phase.padEnd(9)} ` +
    `${(s.components.pumps.get('fw-pump-1')?.speed ?? NaN).toFixed(2).padStart(5)} ` +
    `${flowOut(s, 'val-fwcv-1').toFixed(1).padStart(6)} ` +
    `${(inv.boiler / 1000).toFixed(1).padStart(9)} ` +
    `${(tube.fluid.pressure / 1e5).toFixed(0).padStart(6)} ` +
    `${(node('turbine-1')?.governorValve ?? 1).toFixed(3).padStart(5)} ` +
    `${flowOut(s, 'hx-1-tube').toFixed(1).padStart(6)} ` +
    `${(tube.fluid.temperature - 273.15).toFixed(0).padStart(6)} ` +
    `${((tube.otsg?.lastEval?.lengthFracs[2] ?? NaN) * 100).toFixed(0).padStart(4)} ` +
    `${(inv.total / 1000).toFixed(1).padStart(7)}`
  );
}

const inv = inventory(sim.state);
console.log(`\nSecondary water: boiler ${(inv.boiler / 1000).toFixed(1)} t, ` +
  `hotwell ${(inv.hotwell / 1000).toFixed(1)} t, ` +
  `rest of the loop ${(inv.elsewhere / 1000).toFixed(1)} t, ` +
  `total ${(inv.total / 1000).toFixed(1)} t`);
const cond = node('condenser-1')!;
console.log(`Condenser: ${cond.volume.toFixed(0)} m3 shell, level ${nodeLiquidLevel(cond).toFixed(3)}; ` +
  `filling it to the 0.80 setpoint would take ` +
  `${(0.8 * cond.volume * 1000 / 1000).toFixed(0)} t of water.`);
