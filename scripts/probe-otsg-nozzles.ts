/**
 * Where do the nozzles of every moving-boundary bundle sit - tube side and
 * shell side - and what is flowing through them?
 *
 * The sectioned model reads a nozzle's elevation as its position along the
 * tube (and along the shell, for the gas march), so a preset whose ports are
 * drawn somewhere unexpected runs a different exchanger from the one its
 * author had in mind. This prints the geometry the model actually sees.
 *
 * Usage: npx tsx scripts/probe-otsg-nozzles.ts [preset.json ...]
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2);
if (files.length === 0) files.push('xe100.json');
for (const f of files) {
  const sim = buildSimFromFile(path.join(HERE, '..', 'src', 'presets', f));
  for (let i = 0; i < 20; i++) {
    sim.state = sim.solver.advance(sim.state, 0.1).state;
    sim.state.pendingEvents = [];
  }
  console.log(`== ${f}`);
  for (const [id, node] of sim.state.flowNodes) {
    if (!node.otsg) continue;
    for (const nid of [id, node.otsg.shellNodeId]) {
      const n = sim.state.flowNodes.get(nid)!;
      console.log(`  ${nid}: height=${n.height} vol=${n.volume.toFixed(2)} ` +
        `T=${(n.fluid.temperature - 273.15).toFixed(0)}C`);
      for (const c of sim.state.flowConnections) {
        const isFrom = c.fromNodeId === nid, isTo = c.toNodeId === nid;
        if (!isFrom && !isTo) continue;
        const w = isTo ? c.massFlowRate : -c.massFlowRate;
        const other = sim.state.flowNodes.get(isTo ? c.fromNodeId : c.toNodeId)!;
        console.log(`     ${c.id}: elev=${isTo ? c.toElevation : c.fromElevation} ` +
          `opening=${isTo ? c.toOpeningHeight : c.fromOpeningHeight} ` +
          `into=${w.toFixed(2)} kg/s other=${other.id} (${(other.fluid.temperature - 273.15).toFixed(0)}C)`);
      }
    }
  }
}
