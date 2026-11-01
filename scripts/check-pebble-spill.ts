/**
 * Pebble spill through the real solver path.
 *
 *   npx tsx scripts/check-pebble-spill.ts [preset]
 *
 * Unit tests cover the Beverloo law and the heap geometry; this checks the
 * plumbing on a full pebble-bed plant (Xe-100):
 *
 *  1. A ~60 mm break under the bed (a nozzle, not a chute) spills nothing:
 *     the orifice is under 1.5 pebble diameters, so the bed jams.
 *  2. A 0.2 m hole in the vessel's bottom head (the chute severed) drains
 *     the bed at the Beverloo rate onto the heap in the room the break opens
 *     into, conserving kernel and matrix mass, and the core reads the fuel
 *     that left as relocated.
 *  3. A wide hole in the core barrel's side, three quarters of the way up
 *     the bed, drains only the pebbles above it: the spill stops near a
 *     quarter of the bed.
 *  4. Air in the hot core: the burn-off is distributed over the bed's layers
 *     (summing exactly to the lumped rate) and concentrated where the gas
 *     comes in.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, Sim } from './lib/sim-harness';
import { applyScriptedBurst } from '../src/simulation/operators/burst-operator';
import { beverlooMassFlow } from '../src/simulation/operators/pebble-spill';
import { relocatedFuelFraction } from '../src/simulation/operators/corium';
import { pieceFraction } from '../src/simulation/operators/rate-operators';
import { GraphiteOxidationRateOperator } from '../src/simulation/operators/graphite-oxidation';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = process.argv[2] ?? path.join(HERE, '..', 'src', 'presets', 'xe100.json');

let failures = 0;
function check(ok: boolean, msg: string) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
}

function advance(sim: Sim, secs: number, dt = 0.05) {
  for (let i = 0; i < Math.round(secs / dt); i++) {
    sim.state = sim.solver.advance(sim.state, dt).state;
    sim.state.pendingEvents = [];
  }
}

function build() {
  const sim = buildSimFromFile(PRESET);
  const entry = [...sim.state.thermalNodes].find(([, n]) => n.pebbleBed);
  if (!entry) throw new Error(`${PRESET} has no pebble bed`);
  const bedId = entry[0];
  const bed = entry[1].pebbleBed!;
  const coreId = bedId.slice(0, -'-clad'.length);
  return { sim, bedId, bed, coreId };
}

/** kernel and matrix mass over the bed and every heap */
function inventory(sim: Sim, bedId: string) {
  const bedNode = sim.state.thermalNodes.get(bedId)!;
  const bed = bedNode.pebbleBed!;
  let matrix = bedNode.mass;
  let kernels = sim.state.thermalNodes.get(bed.fuelNodeId)!.mass;
  for (const h of bed.heaps) {
    matrix += sim.state.thermalNodes.get(h.matrixNodeId)!.mass;
    kernels += sim.state.thermalNodes.get(h.fuelNodeId)!.mass;
  }
  return { matrix, kernels };
}

console.log(`Pebble spill check on ${path.basename(PRESET)}`);

// --- 1. A nozzle-sized break jams -------------------------------------------
{
  const { sim, bedId, bed } = build();
  const vessel = bed.boundaryNodeIds[1];
  // Kernel mass: the matrix also loses carbon to any oxidant in the gas
  const m0 = sim.state.thermalNodes.get(bed.fuelNodeId)!.mass;
  applyScriptedBurst(sim.state, vessel, { area: Math.PI * 0.03 * 0.03, elevation: 0 });
  advance(sim, 5);
  const m1 = sim.state.thermalNodes.get(bed.fuelNodeId)!.mass;
  check(m1 === m0, `60 mm break under the bed: kernel mass ${m0.toFixed(3)} -> ${m1.toFixed(3)} kg (jammed)`);
}

// --- 2. Severed chute ---------------------------------------------------------
{
  const { sim, bedId, bed, coreId } = build();
  const vessel = bed.boundaryNodeIds[1];
  const inv0 = inventory(sim, bedId);
  const m0 = sim.state.thermalNodes.get(bedId)!.mass + sim.state.thermalNodes.get(bed.fuelNodeId)!.mass;
  const area = Math.PI * 0.1 * 0.1;
  applyScriptedBurst(sim.state, vessel, { area, elevation: 0 });
  const target = sim.state.flowConnections.find(c => c.id === `break-${vessel}`)!.toNodeId;
  const heapKernelSeed = sim.state.thermalNodes.get(bed.heaps.find(h => h.regionNodeId === target)!.fuelNodeId)!.mass;
  const kernels0 = sim.state.thermalNodes.get(bed.fuelNodeId)!.mass;
  const secs = 20;
  advance(sim, secs);
  const m1 = sim.state.thermalNodes.get(bedId)!.mass + sim.state.thermalNodes.get(bed.fuelNodeId)!.mass;
  const W = (m0 - m1) / secs;
  const W0 = beverlooMassFlow(bed.bulkDensity, 0.2, bed.pebbleDiameter);
  console.log(`  chute severed (0.2 m): ${W.toFixed(2)} kg/s out of the bed, Beverloo ${W0.toFixed(2)} kg/s`);
  check(Math.abs(W / W0 - 1) < 0.02, 'the bed drains at the Beverloo rate');
  const heap = bed.heaps.find(h => h.regionNodeId === target)!;
  // Kernels: the heap's matrix starts burning in the room's air at once
  const heapKernels = sim.state.thermalNodes.get(heap.fuelNodeId)!.mass - heapKernelSeed;
  const bedKernelsLost = kernels0 - sim.state.thermalNodes.get(bed.fuelNodeId)!.mass;
  check(Math.abs(heapKernels - bedKernelsLost) < 1e-9 * kernels0,
    `pebbles land on the heap in '${target}' (${heapKernels.toFixed(3)} kg of kernels)`);
  const inv1 = inventory(sim, bedId);
  check(Math.abs(inv1.matrix - inv0.matrix) < 1e-6 * inv0.matrix &&
    Math.abs(inv1.kernels - inv0.kernels) < 1e-6 * inv0.kernels,
    `kernel and matrix mass conserved (matrix ${(inv1.matrix - inv0.matrix).toExponential(2)} kg, ` +
    `kernels ${(inv1.kernels - inv0.kernels).toExponential(2)} kg)`);
  const reloc = relocatedFuelFraction(sim.state, coreId);
  check(reloc > 0 && Math.abs(reloc - (m0 - m1) / m0) < 1e-3,
    `the core reads the spilled fuel as relocated (${(reloc * 100).toFixed(3)}%)`);
  const heapT = sim.state.thermalNodes.get(heap.matrixNodeId)!.temperature;
  const roomT = sim.state.flowNodes.get(target)!.fluid.temperature;
  check(heapT > roomT + 100, `hot pebbles warm their heap (${(heapT - 273.15).toFixed(0)} C ` +
    `in a ${(roomT - 273.15).toFixed(0)} C room)`);
}

// --- 3. Side hole in the barrel ----------------------------------------------
{
  const { sim, bedId, bed } = build();
  const barrel = bed.boundaryNodeIds[0];
  const barrelNode = sim.state.flowNodes.get(barrel)!;
  const holeAbs = bed.bedBottomElevation + 0.75 * bed.bedHeight;
  applyScriptedBurst(sim.state, barrel, { area: 0.5, elevation: holeAbs - barrelNode.elevation });
  advance(sim, 40);
  const bedNode = sim.state.thermalNodes.get(bedId)!;
  const spilled = 1 - pieceFraction(bedNode);
  console.log(`  side hole at 75% of bed height: ${(spilled * 100).toFixed(2)}% of the bed spilled`);
  check(spilled > 0.24 && spilled < 0.2501, 'only the pebbles above the hole run out');
}

// --- 4. Burn front --------------------------------------------------------------
// Put air in the hot core and evaluate the oxidation operator once: the layer
// rates must add up to the lumped burn-off rate exactly, and a hot bed must
// burn where the gas comes in, not evenly.
{
  const { sim, bedId } = build();
  const bedNode = sim.state.thermalNodes.get(bedId)!;
  const gox = bedNode.graphiteOxidation!;
  const gas = sim.state.flowNodes.get(gox.associatedGasNode)!;
  const he = gas.fluid.ncg!.He;
  gas.fluid.ncg!.O2 = 0.21 * he;
  gas.fluid.ncg!.N2 = 0.79 * he;
  gas.fluid.ncg!.He = 0;
  const op = new GraphiteOxidationRateOperator();
  const profile = (label: string) => {
    const r = op.computeRates(sim.state).thermalNodes.get(bedId)!;
    const layers = r.dLayerBurnoff!;
    const mean = layers.reduce((a, b) => a + b, 0) / layers.length;
    console.log(`  air in the core at ${(bedNode.temperature - 273.15).toFixed(0)} C, ${label}: burn-off ` +
      `rate by layer (bottom first) ${layers.map(x => (x / mean).toFixed(2)).join(' ')} x mean`);
    check(Math.abs(mean / r.dGraphiteBurnoff! - 1) < 1e-12,
      'layer rates add up to the lumped burn-off rate');
    return layers.map(x => x / mean);
  };
  // Forced flow sweeps the oxidant through the bed: burning spreads out
  const forced = profile('forced flow');
  check(Math.max(...forced) < 3, 'forced flow spreads the burning along the bed');
  // Stagnant (every blower dead, a DLOFC with air ingress): oxygen goes
  // only as deep as it diffuses before it reacts
  for (const c of sim.state.flowConnections) {
    if (c.fromNodeId === gas.id || c.toNodeId === gas.id) c.massFlowRate = 0;
  }
  const stagnant = profile('stagnant');
  check(Math.max(...stagnant) > 3, 'a stagnant hot bed burns where the gas gets in, not evenly');
}

if (failures) {
  console.log(`\n${failures} pebble spill check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll pebble spill checks passed');
