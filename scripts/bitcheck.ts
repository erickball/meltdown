/**
 * Bit-identity A/B checker for solver optimizations.
 *
 * Runs the same plant twice with a solver-config difference that is claimed
 * to be PURELY mechanical (same arithmetic, fewer copies) and asserts the
 * final states are bit-for-bit identical. Any divergence means the
 * "optimization" changed physics and must not ship.
 *
 *   npx tsx scripts/bitcheck.ts [plant.json] [seconds]
 *
 * Currently checks: inPlaceConstraints on/off (clone reduction).
 */

import { buildSimFromFile, run } from './lib/sim-harness';
import type { SimulationState } from '../src/simulation/types';
import { RK45Solver } from '../src/simulation';

const plant = process.argv[2] || 'src/presets/pwr.json';
const seconds = parseFloat(process.argv[3] || '60');

/** Stable serialization: Maps become sorted-key objects so key insertion
 *  order can't mask or fake a difference. NaN serializes distinctly. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v instanceof Map) {
      const obj: Record<string, unknown> = {};
      for (const key of [...v.keys()].sort()) obj[String(key)] = v.get(key);
      return obj;
    }
    if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
    return v;
  });
}

function runOnce(inPlace: boolean): SimulationState {
  const sim = buildSimFromFile(plant, { inPlaceConstraints: inPlace });
  return run(sim, seconds, 0.1);
}

console.log(`bitcheck: ${plant}, ${seconds}s, inPlaceConstraints true vs false`);
const a = runOnce(true);
const b = runOnce(false);

const sa = stable(a);
const sb = stable(b);

if (sa === sb) {
  console.log(`\x1b[32m✓ bit-identical\x1b[0m (${sa.length} serialized bytes, t=${a.time.toFixed(3)}s)`);
  process.exit(0);
}

// Locate the first difference for diagnosis
let i = 0;
while (i < Math.min(sa.length, sb.length) && sa[i] === sb[i]) i++;
console.error(`\x1b[31m✗ states differ\x1b[0m at serialized byte ${i}:`);
console.error(`  A: ...${sa.slice(Math.max(0, i - 80), i + 80)}...`);
console.error(`  B: ...${sb.slice(Math.max(0, i - 80), i + 80)}...`);
console.error(`  simTime A=${a.time} B=${b.time}`);
void RK45Solver; // keep import for future per-step comparisons
process.exit(1);
