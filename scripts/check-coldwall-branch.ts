/**
 * How much work is the cold-wall branch actually doing?
 *
 * `liquidWallHeatTransfer` adds a Thom-derived phase-change term whenever a
 * wall sits BELOW the saturation temperature of a two-phase node it touches.
 * That is a nucleate-boiling correlation applied to a surface that cannot
 * nucleate anything, and the open question is whether deleting it would cost
 * the model anything real. Nothing hit the branch in any of the four settled
 * states, so the answer has to come from transients.
 *
 * This samples every convection connection through a run and censuses the
 * branch: how often it fires, how deep the subcooling gets, and - the number
 * that decides it - what SHARE of the surface's total coefficient it is. A
 * branch that only ever contributes a few per cent can go without argument.
 *
 * Sampling from outside rather than instrumenting the operator: the probe
 * calls the same exported function the operator calls, so there is no
 * diagnostic scaffolding left in the hot path afterwards.
 *
 * Usage:
 *   npx tsx scripts/check-coldwall-branch.ts <preset> [seconds] [scenario]
 *   scenarios: steady (default) | turbine-trip | depressurize
 *   WALL_NODES=all to see where the branch WOULD matter under a richer wall
 *   policy than the default rpv-bui.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import { liquidWallHeatTransfer,
  getConvectionHeatRates } from '../src/simulation/operators/rate-operators';
import { saturatedLiquidDensity as satLiquidDensity,
  saturatedVaporDensity as satVaporDensity } from '../src/simulation/water-properties';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const preset = process.argv[2] ?? 'pwr';
const seconds = parseFloat(process.argv[3] ?? '300');
const scenario = process.argv[4] ?? 'steady';
const SAMPLE = 0.5;   // s of plant time between samples

const sim = buildSimFromFile(path.join(HERE, '..', 'src', 'presets', `${preset}.json`));
const st = () => sim.state;

interface Census {
  hits: number;
  samples: number;
  maxSubcooling: number;
  maxPhaseChange: number;
  firstHit: number;      // s
  // Everything below is snapshotted at the SAME sample - the one where this
  // surface was moving the most heat - so the columns compose. Mixing a peak
  // share with a latest-sample heat rate reads as a contradiction.
  peakQ: number;         // W, with the branch
  peakQFrozen: number;   // W, same instant, single-phase only
  peakShare: number;     // phaseChange / total at that instant
  peakSub: number;       // K at that instant
  peakHpc: number;       // W/m²-K at that instant
}
const census = new Map<string, Census>();

/**
 * The liquid-wetted share of a surface, mirroring the operator's own
 * effectiveSurfaceAreas for a two-phase node: by level where the connection
 * carries tube geometry, by liquid VOLUME fraction otherwise.
 */
function wettedArea(conn: any, node: any): number {
  const A = conn.surfaceArea ?? 1;
  const x = node.fluid.quality ?? 0;
  const rho_f = satLiquidDensity(node.fluid.temperature);
  const rho_g = satVaporDensity(node.fluid.temperature);
  const liquidVolFrac = ((1 - x) / rho_f) / ((1 - x) / rho_f + x / rho_g);
  return A * liquidVolFrac;
}

function sample() {
  for (const conn of st().convectionConnections) {
    const node = st().flowNodes.get(conn.flowNodeId);
    const wall = st().thermalNodes.get(conn.thermalNodeId);
    if (!node || !wall) continue;
    if (node.fluid.phase !== 'two-phase') continue;

    const c = census.get(conn.id) ?? {
      hits: 0, samples: 0, maxSubcooling: 0, firstHit: NaN,
      peakQ: 0, peakQFrozen: 0, peakShare: 0, peakSub: 0, peakHpc: 0,
    };
    c.samples++;

    const subcooling = node.fluid.temperature - wall.temperature;
    if (subcooling > 0) {
      const D = conn.characteristicDiameter ?? node.hydraulicDiameter;
      const h = liquidWallHeatTransfer(node, st(), conn, D);
      if (h.phaseChange > 0) {
        c.hits++;
        if (!Number.isFinite(c.firstHit)) c.firstHit = st().time;
        c.maxSubcooling = Math.max(c.maxSubcooling, subcooling);
        // Only the wetted share of the surface sees the liquid coefficient;
        // the vapor share is already carried by the condensation model.
        const wetted = wettedArea(conn, node);
        const q = h.total * wetted * subcooling;
        if (q > c.peakQ) {
          c.peakQ = q;
          c.peakQFrozen = h.singlePhase * wetted * subcooling;
          c.peakShare = h.total > 0 ? h.phaseChange / h.total : 0;
          c.peakSub = subcooling;
          c.peakHpc = h.phaseChange;
        }
      }
    }
    census.set(conn.id, c);
  }
}

console.log(`\n=== ${preset} / ${scenario} / ${seconds} s ` +
  `(WALL_NODES=${process.env.WALL_NODES ?? 'rpv-bui'}) ===`);

// Settle, then inject.
const SETTLE = Math.min(60, seconds / 4);
let t = 0;
for (; t < SETTLE; t += SAMPLE) { run(sim, SAMPLE, 0.02); sample(); }

if (scenario === 'turbine-trip') {
  // Shut the steam path. The secondary bottles up and its saturation
  // temperature climbs fast while the thick shell metal lags behind it -
  // which is the classic way to put a wall BELOW the fluid it touches.
  const turb = st().flowNodes.get('turbine-1');
  if (turb) turb.governorValve = 0.02;
  for (const [, v] of st().components.valves) {
    if (v.id?.includes('msv') || v.id?.includes('steam')) v.position = 0;
  }
  console.log(`--- turbine tripped at t=${st().time.toFixed(0)} s ---`);
} else if (scenario === 'depressurize') {
  // The mirror case, for contrast: dropping the pressure drops T_sat below
  // the metal, which should put every wall on the HOT branch instead.
  for (const [, v] of st().components.valves) {
    if (v.relief) { v.position = 1; v.relief.senseNodeId = v.relief.senseNodeId; }
  }
  const psv = st().components.valves.get('val-psv-1');
  if (psv) psv.position = 1;
  console.log(`--- relief paths forced open at t=${st().time.toFixed(0)} s ---`);
}

for (; t < seconds; t += SAMPLE) {
  try {
    run(sim, SAMPLE, 0.02);
  } catch (e: any) {
    console.log(`  (threw at t=${st().time.toFixed(1)}: ${e.message.split('\n')[0]})`);
    break;
  }
  sample();
}

// Q_frozen is what this surface would move at the SAME subcooling with the
// branch gone. It is NOT the counterfactual steady state - deleting the term
// lets the wall drift until the heat balance closes again, and on a surface
// whose other side is the limiting resistance that means the temperature
// moves and the heat barely does. Answering that needs an actual A/B run;
// this column only sizes the instantaneous step.
console.log('\n  connection                            samples   hits  max_sub(K)   max_h_pc  share' +
  '     Q_now(kW)   Q_frozen(kW)');
console.log('  ' + '-'.repeat(112));
let anyHit = false;
for (const [id, c] of [...census].sort((a, b) => b[1].peakQ - a[1].peakQ)) {
  if (c.hits > 0) anyHit = true;
  console.log(
    `  ${id.slice(0, 36).padEnd(36)} ${c.samples.toString().padStart(7)} ` +
    `${c.hits.toString().padStart(6)} ` +
    `${c.peakSub.toFixed(2).padStart(7)} ` +
    `${c.peakHpc.toExponential(1).padStart(8)} ` +
    `${(100 * c.peakShare).toFixed(0).padStart(5)}% ` +
    `${(c.peakQ / 1e3).toFixed(1).padStart(9)} ` +
    `${(c.peakQFrozen / 1e3).toFixed(1).padStart(13)} ` +
    `${(c.peakQFrozen > 0 ? (c.peakQ / c.peakQFrozen).toFixed(1) + 'x' : '-').padStart(7)}`);
}
if (!census.size) console.log('  (no two-phase convection connections in this plant)');
else if (!anyHit) console.log('\n  the cold-wall branch never fired.');

// The state it actually SETTLED at, which is the number that decides whether
// the branch matters. On a casing wall whose far side is a gas, the gas side
// is the limiting resistance: the branch then sets how close the wall sits to
// the fluid and NOT how much heat crosses it. Run this on both sides of a
// deletion and compare the last two columns, not the peaks above.
console.log('\n  settled state at t=' + st().time.toFixed(0) + ' s');
console.log('  connection                            T_fluid(C)  T_wall(C)   sub(K)   Q_conn(kW)');
console.log('  ' + '-'.repeat(88));
const rates = getConvectionHeatRates();
for (const conn of st().convectionConnections) {
  const node = st().flowNodes.get(conn.flowNodeId);
  const wall = st().thermalNodes.get(conn.thermalNodeId);
  if (!node || !wall || node.fluid.phase !== 'two-phase') continue;
  console.log(
    `  ${conn.id.slice(0, 36).padEnd(36)} ` +
    `${(node.fluid.temperature - 273.15).toFixed(2).padStart(10)} ` +
    `${(wall.temperature - 273.15).toFixed(2).padStart(10)} ` +
    `${(node.fluid.temperature - wall.temperature).toFixed(3).padStart(8)} ` +
    `${((rates.get(conn.id) ?? NaN) / 1e3).toFixed(1).padStart(12)}`);
}
