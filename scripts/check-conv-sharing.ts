/**
 * How many convection connections share a flow node?
 *
 * Everything the coefficient needs from the FLUID - the property blend, the
 * density, the Prandtl number, the throughput - is a property of the node,
 * not of the surface. Only the area, the characteristic lengths and the wall
 * temperature differ per connection. So any node carrying several surfaces is
 * paying for the same property work several times over.
 *
 * Usage: npx tsx scripts/check-conv-sharing.ts [preset]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const preset = process.argv[2] ?? 'w4loop';
const sim = buildSimFromFile(path.join(HERE, '..', 'src', 'presets', `${preset}.json`));

const perNode = new Map<string, number>();
for (const c of sim.state.convectionConnections) {
  perNode.set(c.flowNodeId, (perNode.get(c.flowNodeId) ?? 0) + 1);
}
const total = sim.state.convectionConnections.length;
console.log(`\n=== ${preset}: ${total} convection connections over ${perNode.size} flow nodes ===`);
const ranked = [...perNode].sort((a, b) => b[1] - a[1]);
for (const [id, n] of ranked.slice(0, 8)) {
  console.log(`  ${id.padEnd(30)} ${n.toString().padStart(4)} connections` +
    `${n > 1 ? `  (${n - 1} redundant property evaluations)` : ''}`);
}
const redundant = [...perNode.values()].reduce((s, n) => s + (n - 1), 0);
console.log(`\n  distinct property evaluations needed: ${perNode.size} of ${total}` +
  `  (${(100 * redundant / total).toFixed(0)}% redundant)`);
