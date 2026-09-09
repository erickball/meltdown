/** Dump t=0 flow-node state for a preset, one line per node, for before/after diffing. */
import { buildSimFromFile } from './lib/sim-harness';
const preset = process.argv[2] || 'src/presets/xe100.json';
const sim = buildSimFromFile(preset);
const ids = [...sim.state.flowNodes.keys()].sort();
for (const id of ids) {
  const n = sim.state.flowNodes.get(id)!;
  console.log(`IC ${id} m=${n.fluid.mass.toPrecision(17)} U=${n.fluid.internalEnergy.toPrecision(17)} V=${n.volume.toPrecision(17)}`);
}
