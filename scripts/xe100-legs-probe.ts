/**
 * Xe-100 primary-loop leg report: flows, node pressures, and the pressure the
 * momentum equation actually sees at each end of every primary connection.
 * Run before/after the gas-column change to see what the helium columns did.
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import { pressureAtConnection, nodeBulkDensity } from '../src/simulation/operators/connection-hydraulics';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const seconds = parseFloat(process.argv[2] || '600');

const sim = buildSimFromFile(PRESET);
run(sim, seconds, 0.1);
const s = sim.state;

console.log(`\n=== XE100 LEGS at t=${s.time.toFixed(0)} s ===`);
console.log('connection                                        flow kg/s     P_from bar     P_to bar' +
  '   Pconn_from     Pconn_to      dz m   rho_from');   // rho = bulk, NCG included
const rows: string[] = [];
for (const c of s.flowConnections) {
  const f = s.flowNodes.get(c.fromNodeId), t = s.flowNodes.get(c.toNodeId);
  if (!f || !t) continue;
  const pf = pressureAtConnection(f, c.fromElevation);
  const pt = pressureAtConnection(t, c.toElevation);
  rows.push(
    `${c.id.padEnd(48)} ${c.massFlowRate.toFixed(3).padStart(11)} ` +
    `${(f.fluid.pressure / 1e5).toFixed(4).padStart(14)} ${(t.fluid.pressure / 1e5).toFixed(4).padStart(12)} ` +
    `${(pf / 1e5).toFixed(4).padStart(12)} ${(pt / 1e5).toFixed(4).padStart(12)} ` +
    `${(c.elevation ?? 0).toFixed(2).padStart(9)} ` +
    `${nodeBulkDensity(f).toFixed(4).padStart(10)}`);
}
console.log(rows.join('\n'));

console.log('\nnode                          T C        P bar    elev m   height m   phase');
for (const [id, n] of s.flowNodes) {
  if (n.isBoundary) continue;
  console.log(`${id.padEnd(28)} ${(n.fluid.temperature - 273.15).toFixed(1).padStart(8)} ` +
    `${(n.fluid.pressure / 1e5).toFixed(4).padStart(12)} ${n.elevation.toFixed(2).padStart(9)} ` +
    `${(n.height ?? NaN).toFixed(2).padStart(10)}   ${n.fluid.phase}`);
}
