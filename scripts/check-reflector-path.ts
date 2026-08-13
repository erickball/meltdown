/**
 * Print the passive decay-heat path out of a gas-cooled core.
 *
 *   npx tsx scripts/check-reflector-path.ts [preset.json]
 *
 * The chain a pebble bed relies on when every blower is dead is
 *
 *   fuel -> pebble graphite -> [packed bed] -> reflector -> [radiation]
 *        -> vessel wall -> containment
 *
 * and its capacity depends strongly on temperature: the bed's effective
 * conductivity and the reflector-to-wall radiation both climb steeply as the
 * core heats up. This script evaluates each link across a temperature sweep
 * so you can see where the bottleneck is and whether the path can carry
 * decay heat at all. Nothing here is a threshold - it is the same expression
 * at every temperature, just tabulated.
 */

import { buildSimFromFile } from './lib/sim-harness';
import {
  bedEffectiveConductivity,
  graphiteThermalConductivity,
  NBG_18,
  SIGMA_SB,
} from '../src/simulation/graphite';
import { mixtureThermalConductivity } from '../src/simulation/gas-properties';

const presetPath = process.argv[2] ?? 'src/presets/htgr.json';
const sim = buildSimFromFile(presetPath);
const state = sim.state;

const bedConns = state.thermalConnections.filter(c => c.packedBed);
const radConns = state.thermalConnections.filter(c => c.radiationCoeff);

if (bedConns.length === 0 && radConns.length === 0) {
  console.log(`No packed-bed or radiation heat paths in ${presetPath}.`);
  console.log('(A reflector needs reflectorThickness > 0 on a fuelled core.)');
  process.exit(0);
}

for (const conn of bedConns) {
  const bed = conn.packedBed!;
  const gasNode = state.flowNodes.get(bed.gasNodeId);
  const reflector = state.thermalNodes.get(conn.toNodeId);

  console.log(`\n=== ${conn.fromNodeId} -> ${conn.toNodeId} (packed bed) ===`);
  console.log(`  particles ${(bed.particleDiameter * 1000).toFixed(0)} mm, ` +
    `void fraction ${bed.voidFraction}, shape factor ${bed.shapeFactor.toFixed(1)} m`);
  if (reflector) {
    console.log(`  reflector: ${(reflector.mass / 1000).toFixed(1)} t`);
  }
  console.log('\n     T (K)   k_gas   k_bed    C_bed    C_series    C_total     Q @ 300 K dT');
  console.log('  ' + '-'.repeat(74));

  for (const T of [400, 600, 800, 1000, 1200, 1400, 1600, 1800]) {
    const kGas = gasNode?.fluid.ncg
      ? mixtureThermalConductivity(gasNode.fluid.ncg, T)
      : 0.03;
    const kSolid = graphiteThermalConductivity(T, { ...NBG_18, k300: bed.solidK300 });
    const kBed = bedEffectiveConductivity(
      kGas, kSolid, bed.voidFraction, T, bed.particleDiameter, bed.emissivity);
    const cBed = kBed * bed.shapeFactor;
    const cSeries = bed.seriesShapeFactor
      ? graphiteThermalConductivity(T, { ...NBG_18, k300: bed.seriesK300 ?? NBG_18.k300 }) *
        bed.seriesShapeFactor
      : Infinity;
    const cTotal = 1 / (1 / cBed + 1 / cSeries);
    console.log(
      `  ${T.toString().padStart(7)}  ` +
      `${kGas.toFixed(3).padStart(6)}  ` +
      `${kBed.toFixed(2).padStart(6)}  ` +
      `${cBed.toFixed(0).padStart(7)} W/K  ` +
      `${(Number.isFinite(cSeries) ? cSeries.toFixed(0) : 'inf').padStart(7)} W/K  ` +
      `${cTotal.toFixed(0).padStart(7)} W/K  ` +
      `${(cTotal * 300 / 1e6).toFixed(2).padStart(8)} MW`);
  }
}

for (const conn of radConns) {
  console.log(`\n=== ${conn.fromNodeId} -> ${conn.toNodeId} (radiation) ===`);
  console.log(`  effective exchange area ${conn.radiationCoeff!.toFixed(1)} m2`);
  console.log('\n     T_hot (K)   T_cold (K)      Q         equivalent C');
  console.log('  ' + '-'.repeat(58));
  for (const Th of [600, 800, 1000, 1200, 1400, 1600]) {
    const Tc = 550; // vessel wall held near its operating temperature
    const Q = SIGMA_SB * conn.radiationCoeff! * (Th ** 4 - Tc ** 4);
    const C = SIGMA_SB * conn.radiationCoeff! * (Th + Tc) * (Th * Th + Tc * Tc);
    console.log(
      `  ${Th.toString().padStart(10)}  ${Tc.toString().padStart(11)}  ` +
      `${(Q / 1e6).toFixed(2).padStart(8)} MW  ${C.toFixed(0).padStart(11)} W/K`);
  }
}

// Decay heat for context: the path has to carry roughly this much.
const core = [...state.thermalNodes.values()].find(n => n.id.endsWith('-fuel'));
const ratedPower = state.neutronics?.nominalPower ?? 0;
if (ratedPower > 0) {
  console.log(`\nFor context - rated ${(ratedPower / 1e6).toFixed(0)} MWt, so decay heat is`);
  console.log(`  ~${(ratedPower * 0.065 / 1e6).toFixed(1)} MW at 1 s, ` +
    `~${(ratedPower * 0.014 / 1e6).toFixed(1)} MW at 1 h, ` +
    `~${(ratedPower * 0.006 / 1e6).toFixed(1)} MW at 1 day.`);
  if (core) console.log(`  (fuel node '${core.id}' starts at ${core.temperature.toFixed(0)} K)`);
}
console.log();
