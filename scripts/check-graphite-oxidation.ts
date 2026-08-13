/**
 * Sweep the graphite oxidation model across temperature and atmosphere.
 *
 *   npx tsx scripts/check-graphite-oxidation.ts [preset.json]
 *
 * Prints, for each graphite node, the carbon loss rate and the Thiele
 * effectiveness of each reaction. Watch for three things:
 *
 *  - eta falling from ~1 towards 0 as temperature rises. That is the shift
 *    from whole-volume attack (zone I) to a thin reacting skin (zone II),
 *    and it happens on its own - there is no regime switch in the code.
 *  - Air producing heat and steam consuming it. An air ingress is a fire; a
 *    steam ingress is a gasification the core has to pay for.
 *  - The pebbles losing carbon faster than the reflector at the same
 *    temperature, because they are smaller and finer-grained.
 */

import { buildSimFromFile } from './lib/sim-harness';
import {
  GraphiteOxidationRateOperator,
  getGraphiteOxidationDiagnostics,
} from '../src/simulation/operators/graphite-oxidation';
import { createGasComposition } from '../src/simulation/gas-properties';
import { coFraction } from '../src/simulation/graphite';

const presetPath = process.argv[2] ?? 'src/presets/htgr.json';
const sim = buildSimFromFile(presetPath);
const state = sim.state;

const graphiteNodes = [...state.thermalNodes.values()].filter(n => n.graphiteOxidation);
if (graphiteNodes.length === 0) {
  console.log(`No graphite nodes in ${presetPath}.`);
  process.exit(0);
}

console.log(`\nGraphite nodes: ${graphiteNodes.map(n =>
  `${n.id} (${n.graphiteOxidation!.grade}, ${(n.mass / 1000).toFixed(1)} t, ` +
  `L_c=${(n.graphiteOxidation!.characteristicLength * 1000).toFixed(1)} mm)`).join(', ')}`);

const operator = new GraphiteOxidationRateOperator();

// Atmospheres to test, at 1 bar in the core gas volume. Moles are set from
// the node volume so each case is a genuine 1-bar fill at 1000 K.
const ATMOSPHERES: Array<[string, (nMol: number) => ReturnType<typeof createGasComposition>, number]> = [
  ['air',       n => createGasComposition({ N2: 0.79 * n, O2: 0.21 * n }), 0],
  ['He + air',  n => createGasComposition({ He: 0.9 * n, N2: 0.079 * n, O2: 0.021 * n }), 0],
  ['steam',     n => createGasComposition({ He: 0.01 * n }), 1],
  ['CO2',       n => createGasComposition({ CO2: n }), 0],
];

for (const [label, makeComp, steamFrac] of ATMOSPHERES) {
  console.log(`\n=== ${label} at 1 bar ===`);
  console.log('    T (K)   ' + graphiteNodes.map(n =>
    `${n.id.replace(/^.*-/, '').padEnd(10)} eta      kg C/s     `).join(''));
  console.log('  ' + '-'.repeat(20 + graphiteNodes.length * 32));

  for (const T of [600, 800, 1000, 1200, 1400, 1600, 1800]) {
    const cells: string[] = [];
    for (const node of graphiteNodes) {
      const gas = state.flowNodes.get(node.graphiteOxidation!.associatedGasNode)!;
      // 1 bar of gas at T in this node's volume
      const nMol = (1e5 * gas.volume) / (8.31446 * T);
      gas.fluid.ncg = makeComp(nMol * (1 - steamFrac));
      gas.fluid.temperature = T;
      gas.fluid.pressure = 1e5;
      gas.fluid.phase = 'vapor';
      gas.fluid.quality = 1;
      gas.fluid.mass = steamFrac * nMol * 0.018015;
      node.temperature = T;

      operator.computeRates(state);
      const d = getGraphiteOxidationDiagnostics().get(node.id);
      const total = d ? Object.values(d.carbonRate).reduce((a, b) => a + b, 0) : 0;
      // Report the effectiveness of whichever reaction is actually running
      const dominant = d
        ? (Object.keys(d.carbonRate) as Array<keyof typeof d.carbonRate>)
            .reduce((a, b) => (d.carbonRate[a] >= d.carbonRate[b] ? a : b))
        : 'O2';
      const eta = d ? d.effectiveness[dominant] : 1;
      cells.push(`${eta.toFixed(3).padStart(8)}  ${total.toExponential(2).padStart(10)}  `);
    }
    console.log(`  ${T.toString().padStart(7)}   ${cells.join('')}`);
  }
}

console.log('\n=== CO/CO2 product split (Arthur) ===');
console.log('  Hot graphite keeps only a fraction of the heat at its surface;');
console.log('  the rest leaves as CO for the combustion operator to burn.');
console.log('\n    T (K)    CO fraction    surface heat (kJ/mol C)');
console.log('  ' + '-'.repeat(48));
for (const T of [600, 800, 1000, 1200, 1400, 1600, 1800]) {
  const f = coFraction(T);
  const q = f * 110.5 + (1 - f) * 393.5;
  console.log(`  ${T.toString().padStart(7)}   ${f.toFixed(3).padStart(10)}   ${q.toFixed(0).padStart(16)}`);
}
console.log();
