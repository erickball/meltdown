/**
 * Trajectory fingerprint for the Xe-100 preset.
 *
 * Prints a hash of every flow node's (mass, energy, pressure) plus the
 * neutronics power at a fixed sim time, so a refactor that is supposed to be
 * arithmetically neutral can be proven so rather than asserted.
 *
 * Usage: npx tsx scripts/fingerprint-xe100.ts [seconds] [tickDt]
 */

import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100.json');

const seconds = parseFloat(process.argv[2] || '30');
const tickDt = parseFloat(process.argv[3] || '0.1');

const sim = buildSimFromFile(PRESET);
run(sim, seconds, tickDt);

const parts: string[] = [];
for (const [id, n] of [...sim.state.flowNodes].sort((a, b) => a[0].localeCompare(b[0]))) {
  parts.push(`${id}|${n.fluid.mass}|${n.fluid.internalEnergy}|${n.fluid.pressure}|${n.fluid.temperature}`);
}
for (const [id, t] of [...sim.state.thermalNodes].sort((a, b) => a[0].localeCompare(b[0]))) {
  parts.push(`${id}|${t.temperature}`);
}
for (const c of [...sim.state.flowConnections].sort((a, b) => a.id.localeCompare(b.id))) {
  parts.push(`${c.id}|${c.massFlowRate}`);
}
parts.push(`power|${sim.state.neutronics.power}`);

const stats = sim.solver.getMetrics();
console.log(`FINGERPRINT t=${sim.state.time} steps=${stats.totalSteps} rejected=${stats.rejectedSteps}`);
console.log(`HASH ${crypto.createHash('sha256').update(parts.join('\n')).digest('hex')}`);
console.log(`power=${sim.state.neutronics.power}`);
