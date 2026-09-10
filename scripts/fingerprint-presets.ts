/**
 * Bit-identity fingerprint for preset plants.
 *
 * Runs each preset headless for a short time and prints a hash of every flow
 * node's (mass, energy, pressure) plus every connection's flow, so a change
 * that is meant to leave a plant untouched can be proven to. Compare two runs
 * by diffing the output.
 *
 * Usage: npx tsx scripts/fingerprint-presets.ts [seconds] [preset.json ...]
 */

import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const seconds = parseFloat(args[0] || '20');
const presets = args.length > 1 ? args.slice(1)
  : ['pwr.json', 'bwr.json', 'htgr.json', 'two-loop.json', 'w4loop.json', 'sbo.json', 'prompt-crit.json'];

const origLog = console.log, origWarn = console.warn;
for (const file of presets) {
  const sim = buildSimFromFile(path.join(HERE, '..', 'src', 'presets', file));
  console.log = () => {}; console.warn = () => {};
  let threw = '';
  try { run(sim, seconds, 0.05); } catch (e: any) { threw = e.message; }
  console.log = origLog; console.warn = origWarn;
  const h = crypto.createHash('sha256');
  for (const [id, n] of sim.state.flowNodes) {
    h.update(`${id}|${n.fluid.mass}|${n.fluid.internalEnergy}|${n.fluid.pressure}|${n.fluid.temperature}\n`);
  }
  for (const c of sim.state.flowConnections) h.update(`${c.id}|${c.massFlowRate}\n`);
  const m = sim.solver.getMetrics();
  console.log(`${file.padEnd(18)} t=${sim.state.time.toFixed(2)} steps=${m.totalSteps} rejected=${m.rejectedSteps} sha=${h.digest('hex').slice(0, 16)}${threw ? ' THREW: ' + threw : ''}`);
}
