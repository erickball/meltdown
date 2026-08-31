/**
 * What liquid-side heat transfer coefficient does each preset actually use?
 *
 * The liquid wall coefficient carries fuel-to-coolant in every water reactor,
 * so before changing it the honest first step is to look at where it lands
 * today, per connection, at each plant's own settled state. Run this on both
 * sides of a change: the point is the pair, not either column alone.
 *
 * Also prints the property error directly - what the correlation used for
 * mu/k/Pr against what water actually has at the temperature the node is at -
 * because that is the size of the thing being fixed.
 *
 * Usage: npx tsx scripts/check-liquid-htc.ts [preset ...]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import { liquidWallHeatTransfer } from '../src/simulation/operators/rate-operators';
import {
  liquidViscosity, liquidThermalConductivity, liquidSpecificHeat,
} from '../src/simulation/water-properties';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const presets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['pwr', 'two-loop', 'bwr', 'w4loop'];

// Seconds to settle before reading. Short on purpose: this is about where the
// coefficients sit, not about converging anybody's plant.
const SETTLE = 30;

for (const name of presets) {
  const file = path.join(HERE, '..', 'src', 'presets', `${name}.json`);
  let sim;
  try {
    sim = buildSimFromFile(file);
  } catch (e: any) {
    console.log(`\n=== ${name}: could not build (${e.message.split('\n')[0]}) ===`);
    continue;
  }
  try {
    run(sim, SETTLE, 0.02);
  } catch (e: any) {
    console.log(`  (settling threw at t=${sim.state.time.toFixed(1)}: ${e.message.split('\n')[0]})`);
  }

  console.log(`\n=== ${name} (t=${sim.state.time.toFixed(0)} s) ===`);
  console.log('  connection                              T_fl(C)  T_wall(C)  phase       ' +
    '  h_nat  h_forced  h_1phase     h_pc     h_tot   Re');

  const rows: Array<[string, number]> = [];
  for (const conn of sim.state.convectionConnections) {
    const node = sim.state.flowNodes.get(conn.flowNodeId);
    const wall = sim.state.thermalNodes.get(conn.thermalNodeId);
    if (!node || !wall) continue;
    // Only the connections whose surface is actually wetted matter here.
    if (node.fluid.phase === 'vapor') continue;

    const D = conn.characteristicDiameter ?? node.hydraulicDiameter;
    const h = liquidWallHeatTransfer(node, sim.state, conn, D);
    const T = node.fluid.temperature;

    console.log(
      `  ${conn.id.slice(0, 38).padEnd(38)} ` +
      `${(T - 273.15).toFixed(1).padStart(7)} ` +
      `${(wall.temperature - 273.15).toFixed(1).padStart(10)} ` +
      `${node.fluid.phase.padEnd(11)} ` +
      `${h.natural.toFixed(0).padStart(7)} ` +
      `${h.forced.toFixed(0).padStart(9)} ` +
      `${h.singlePhase.toFixed(0).padStart(9)} ` +
      `${h.phaseChange.toFixed(0).padStart(8)} ` +
      `${h.total.toFixed(0).padStart(9)} ` +
      `${h.Re.toExponential(1).padStart(9)}`);
    rows.push([conn.id, h.total]);
  }
  if (!rows.length) console.log('  (no wetted convection connections)');
}

// ---------------------------------------------------------------------------
console.log('\n=== The property error, by temperature ===');
console.log('  T(C)   mu_real     mu_used   k_real  k_used   Pr_real  Pr_used   ' +
  'h_forced ratio (real/used)');
for (const Tc of [20, 100, 150, 200, 250, 300, 330]) {
  const T = Tc + 273.15;
  const mu = liquidViscosity(T);
  const k = liquidThermalConductivity(T);
  // cp along the saturation line, from the density curve's own tables where
  // available; the nominal values below are close enough to show the trend.
  const cp = liquidSpecificHeat(T);
  const Pr = (cp * mu) / k;
  // h ~ Re^0.8 Pr^0.4 k, and Re ~ 1/mu, so the ratio is
  //   (mu_used/mu_real)^0.8 * (Pr_real/Pr_used)^0.4 * (k_real/k_used)
  const ratio = Math.pow(3e-4 / mu, 0.8) * Math.pow(Pr / 2.0, 0.4) * (k / 0.6);
  console.log(
    `  ${Tc.toString().padStart(4)} ` +
    `${mu.toExponential(2).padStart(10)} ${(3e-4).toExponential(2).padStart(10)} ` +
    `${k.toFixed(3).padStart(8)} ${(0.6).toFixed(3).padStart(7)} ` +
    `${Pr.toFixed(2).padStart(9)} ${(2.0).toFixed(2).padStart(8)}   ` +
    `${ratio.toFixed(2).padStart(6)}x`);
}
