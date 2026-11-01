/**
 * DLOFC drained-tube probe: runs xe100-dlofc and logs the OTSG tube nodes
 * (totals, published state, partition) plus solver dt/rejections, saving a
 * state snapshot every SNAP seconds so a slow stretch can be resumed.
 *
 * Usage: npx tsx scripts/probe-dlofc-tubes.ts <seconds> [every] [snapshotIn] [snapshotOut]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { serializeSimulationState, deserializeSimulationState } from '../src/simulation/serialization';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100-dlofc.json');
const seconds = parseFloat(process.argv[2] ?? '3600');
const every = parseFloat(process.argv[3] ?? '60');
const snapIn = process.argv[4];
const snapOut = process.argv[5];

const sim = buildSimFromFile(PRESET);
if (snapIn && snapIn !== '-') sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(snapIn, 'utf-8')));
const IDS = ['hx-1-tube', 'hx-1-tube-b2'];
const wall0 = performance.now();
let steps = 0, rej = 0, minDt = Infinity;

function line() {
  const s = sim.state;
  const parts = IDS.map(id => {
    const n = s.flowNodes.get(id)!;
    const f = n.fluid;
    const ncgMol = Object.values((f.ncg ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
    const ot = n.otsg as any;
    return `${id.replace('hx-1-', '')}: m=${f.mass.toFixed(2)} U=${(f.internalEnergy / 1e6).toFixed(2)}MJ ` +
      `u=${(f.internalEnergy / f.mass / 1e3).toFixed(0)} P=${(f.pressure / 1e5).toFixed(2)} T=${(f.temperature - 273.15).toFixed(0)} ` +
      `${f.phase} q=${(f.quality ?? NaN).toFixed(3)} ncg=${ncgMol.toFixed(2)} m1=${ot?.m1?.toFixed?.(2) ?? '-'}`;
  });
  const flows = s.flowConnections
    .filter(c => (IDS.includes(c.fromNodeId) || IDS.includes(c.toNodeId)) && Math.abs(c.massFlowRate) > 0.01)
    .map(c => `${c.fromNodeId}->${c.toNodeId}:${c.massFlowRate.toFixed(2)}`).join(' ');
  const wall = (performance.now() - wall0) / 1000;
  console.log(`t=${s.time.toFixed(0)} wall=${wall.toFixed(0)}s steps=${steps} rej=${rej} minDt=${(minDt * 1e3).toFixed(3)}ms ` +
    `Tfuel=${((s.thermalNodes.get('cb-1-fuel')?.temperature ?? NaN) - 273.15).toFixed(0)}\n   ${parts.join('\n   ')}\n   flows: ${flows}`);
  minDt = Infinity;
}

const end = sim.state.time + seconds;
let next = sim.state.time;
while (sim.state.time < end) {
  if (sim.state.time >= next) { line(); next += every; }
  const r = sim.solver.advance(sim.state, 0.05);
  sim.state = r.state;
  sim.state.pendingEvents = [];
  steps += r.metrics?.subcycleCount ?? 0;
  rej += r.metrics?.retriesThisFrame ?? 0;
  const u = r.metrics?.minDtUsed;
  if (Number.isFinite(u)) minDt = Math.min(minDt, u);
}
line();
if (snapOut) fs.writeFileSync(snapOut, JSON.stringify(serializeSimulationState(sim.state)));
