/**
 * How fast does the convection coefficient actually move?
 *
 * The proposal is to stop recomputing convection every step on the grounds
 * that it is a slow-timescale term. That is testable: sample h on every
 * connection once per solver step and look at the per-step relative change.
 * If it drifts by a hair, a lagged coefficient is nearly free; if it jumps,
 * lagging it would inject noise the error control cannot see.
 *
 * Reports the distribution, not the mean - a term that is quiet 99% of the
 * time and violent for the other 1% is exactly the case that punishes a
 * fixed refresh interval, and it is the boiling surfaces that do it.
 *
 * Usage: npx tsx scripts/check-h-drift.ts [preset] [seconds]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import {
  liquidWallHeatTransfer, vaporWallHeatTransfer,
} from '../src/simulation/operators/rate-operators';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const preset = process.argv[2] ?? 'w4loop';
const seconds = parseFloat(process.argv[3] ?? '20');

const sim = buildSimFromFile(path.join(HERE, '..', 'src', 'presets', `${preset}.json`));
const st = () => sim.state;

/** Total coefficient on a connection, as the operator would compute it. */
function hOf(conn: any): { h: number; twoPhase: boolean } {
  const node = st().flowNodes.get(conn.flowNodeId);
  const wall = st().thermalNodes.get(conn.thermalNodeId);
  if (!node || !wall) return { h: NaN, twoPhase: false };
  const D_heater = conn.characteristicDiameter ?? node.hydraulicDiameter;
  const D_flow = conn.flowHydraulicDiameter ?? D_heater;
  const twoPhase = node.fluid.phase === 'two-phase';
  const h = node.fluid.phase === 'vapor'
    ? vaporWallHeatTransfer(node, st(), D_flow, wall.temperature, conn).total
    : liquidWallHeatTransfer(node, st(), conn, D_flow, D_heater).total;
  return { h, twoPhase };
}

const prev = new Map<string, number>();
// Per-connection: the biggest single-step relative jump we ever see.
const worst = new Map<string, { max: number; twoPhase: boolean; at: number }>();
const allDeltas: number[] = [];

// Settle first - startup transients are not what a steady refresh interval
// would be sized against.
for (let i = 0; i < 250; i++) { const r = sim.solver.advance(sim.state, 0.02); sim.state = r.state; }
for (const c of st().convectionConnections) prev.set(c.id, hOf(c).h);

const ticks = Math.round(seconds / 0.02);
for (let i = 0; i < ticks; i++) {
  const r = sim.solver.advance(sim.state, 0.02);
  sim.state = r.state;
  sim.state.pendingEvents = [];
  for (const c of st().convectionConnections) {
    const { h, twoPhase } = hOf(c);
    const p = prev.get(c.id);
    if (p !== undefined && p > 0 && h > 0 && Number.isFinite(h)) {
      const d = Math.abs(h - p) / p;
      allDeltas.push(d);
      const w = worst.get(c.id);
      if (!w || d > w.max) worst.set(c.id, { max: d, twoPhase, at: st().time });
    }
    prev.set(c.id, h);
  }
}

allDeltas.sort((a, b) => a - b);
const q = (f: number) => allDeltas[Math.min(allDeltas.length - 1,
  Math.floor(f * allDeltas.length))];
console.log(`\n=== ${preset}: per-STEP relative change in h, ${allDeltas.length} samples ===`);
console.log(`  median   ${(100 * q(0.5)).toFixed(4)}%`);
console.log(`  p90      ${(100 * q(0.9)).toFixed(4)}%`);
console.log(`  p99      ${(100 * q(0.99)).toFixed(4)}%`);
console.log(`  p99.9    ${(100 * q(0.999)).toFixed(3)}%`);
console.log(`  max      ${(100 * q(1)).toFixed(1)}%`);

console.log('\n  worst connections (max single-step jump):');
const ranked = [...worst].sort((a, b) => b[1].max - a[1].max).slice(0, 10);
for (const [id, w] of ranked) {
  console.log(`    ${id.slice(0, 42).padEnd(42)} ${(100 * w.max).toFixed(1).padStart(8)}%` +
    `${w.twoPhase ? '   [two-phase]' : ''}`);
}
