/**
 * Round-trip consistency: createFluidState(T, P, ...) builds (mass, energy)
 * from a temperature; FluidStateConstraintOperator derives temperature back
 * from (mass, energy, volume). Those two must agree, or every plant starts
 * with a step change it never asked for - the state jumps on the first
 * evaluation and the solver has to absorb it.
 *
 * Covers water-only, gas-only and mixed nodes across the range presets use.
 *
 * Usage: npx tsx scripts/probe-ncg-roundtrip.ts
 */

import { FluidStateConstraintOperator } from '../src/simulation/operators/rate-operators';
import { preloadWaterProperties } from '../src/simulation/water-properties-v4';
import { createFluidState } from '../src/simulation/operators/heat-transfer';
import type { SimulationState, FlowNode } from '../src/simulation/types';

await preloadWaterProperties();

const op = new FluidStateConstraintOperator();

function roundTrip(
  label: string,
  T: number, P: number,
  phase: 'liquid' | 'two-phase' | 'vapor', quality: number,
  volume: number,
  ncg?: Record<string, number>
): number {
  const fluid = createFluidState(T, P, phase, quality, volume, ncg as any);
  const node: FlowNode = {
    id: 'n', label: 'n', fluid,
    volume, hydraulicDiameter: 0.1, flowArea: 1, height: 2, elevation: 0,
  };
  const state: SimulationState = {
    time: 0, thermalNodes: new Map(), flowNodes: new Map([['n', node]]),
    thermalConnections: [], convectionConnections: [], flowConnections: [],
    neutronics: {} as any,
    components: { pumps: new Map(), valves: new Map(), checkValves: new Map(), controllers: new Map() },
  };
  op.applyConstraintsMutating(state);
  const out = state.flowNodes.get('n')!.fluid;
  const dT = out.temperature - T;
  const flag = Math.abs(dT) > 0.5 ? `  <-- ${dT > 0 ? '+' : ''}${dT.toFixed(1)} K` : '';
  console.log(
    `${label.padEnd(42)} T_in=${T.toFixed(1).padStart(7)}K  T_out=${out.temperature.toFixed(1).padStart(7)}K  ` +
    `dT=${dT.toFixed(2).padStart(8)}K  P_out=${(out.pressure / 1e5).toFixed(3).padStart(9)}bar  ` +
    `phase=${out.phase}${flag}`
  );
  return Math.abs(dT);
}

console.log('=== Water only (no NCG) ===');
let worst = 0;
worst = Math.max(worst, roundTrip('subcooled liquid 15.5 MPa', 560, 15.5e6, 'liquid', 0, 10));
worst = Math.max(worst, roundTrip('saturated mix 7 MPa x=0.3', 559, 7e6, 'two-phase', 0.3, 50));
worst = Math.max(worst, roundTrip('superheated steam 6 MPa', 700, 6e6, 'vapor', 1, 20));
worst = Math.max(worst, roundTrip('condenser vacuum two-phase', 312, 7000, 'two-phase', 0.5, 100));

console.log('\n=== Air + steam (containment-like) ===');
worst = Math.max(worst, roundTrip('containment air, 25 kPa steam, 620 K', 620, 25000, 'vapor', 1, 65,
  { N2: 0.79, O2: 0.21, H2: 0.02 }));
worst = Math.max(worst, roundTrip('cold containment air 300 K', 300, 3000, 'vapor', 1, 50000,
  { N2: 0.78, O2: 0.21, Ar: 0.009 }));

console.log('\n=== Helium primary (gas-dominated, trace steam) ===');
worst = Math.max(worst, roundTrip('He 60 bar, 533 K, SG shell', 533, 700, 'vapor', 1, 113, { He: 60 }));
worst = Math.max(worst, roundTrip('He 60 bar, 1023 K, core', 1023, 700, 'vapor', 1, 50, { He: 60 }));
worst = Math.max(worst, roundTrip('He 70 bar, 973 K (HTGR core)', 973, 700, 'vapor', 1, 75, { He: 70 }));

console.log('\n=== Mixed: helium with a real slug of steam ===');
for (const steamBar of [0.01, 0.1, 1, 5, 20]) {
  worst = Math.max(worst, roundTrip(`He 60 bar + ${steamBar} bar steam @ 750 K`, 750, steamBar * 1e5, 'vapor', 1, 20,
    { He: 60 }));
}

console.log(`\nworst |dT| = ${worst.toFixed(3)} K`);
if (worst > 0.5) {
  console.log('FAIL: a node does not read back the temperature it was built at.');
  process.exitCode = 1;
} else {
  console.log('OK: all nodes round-trip within 0.5 K.');
}
