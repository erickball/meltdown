/**
 * Summarize a V8 .cpuprofile: self time by function and by file.
 *
 * The operator timings printed by scripts/perf-xe100.ts say WHICH operator is
 * expensive; this says which FUNCTION is, which is what tells you whether the
 * cost is the physics or the plumbing around it. Capture a profile with:
 *
 *   npx tsx --cpu-prof --cpu-prof-dir=prof scripts/perf-xe100.ts 60 0.1
 *   npx tsx scripts/lib/prof-summary.ts prof/<file>.cpuprofile
 *
 * Note that a tsx run attributes a few percent to esbuild's `__name` helper
 * and to module loading; neither exists in the vite-built game bundle.
 */

import * as fs from 'fs';

interface CallFrame { functionName: string; url: string; lineNumber: number }
interface ProfileNode { id: number; callFrame: CallFrame }
interface CpuProfile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }

const file = process.argv[2];
if (!file) {
  console.log('Usage: npx tsx scripts/lib/prof-summary.ts <file.cpuprofile>');
  process.exit(1);
}

const prof: CpuProfile = JSON.parse(fs.readFileSync(file, 'utf-8'));
const byId = new Map(prof.nodes.map(n => [n.id, n]));
const self = new Map<string, number>();
let total = 0;

// timeDeltas[i] is the time elapsed before samples[i] was taken.
for (let i = 0; i < prof.samples.length; i++) {
  const dt = prof.timeDeltas[i] || 0;
  const n = byId.get(prof.samples[i]);
  if (!n) continue;
  const cf = n.callFrame;
  const shortUrl = (cf.url || '').replace(/^.*[\\/]/, '');
  const key = `${cf.functionName || '(anon)'} @ ${shortUrl}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + dt);
  total += dt;
}

const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
console.log(`total sampled: ${(total / 1e6).toFixed(2)}s\n`);
console.log('self time by function:');
for (const [k, v] of rows.slice(0, 30)) {
  if (v / 1e6 < 0.05) break;
  console.log(`  ${(v / 1e6).toFixed(2)}s  ${(100 * v / total).toFixed(1)}%  ${k}`);
}

const byFile = new Map<string, number>();
for (const [k, v] of rows) {
  const f = k.split(' @ ')[1].split(':')[0] || '(native)';
  byFile.set(f, (byFile.get(f) || 0) + v);
}
console.log('\nself time by file:');
for (const [k, v] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${(v / 1e6).toFixed(2)}s  ${(100 * v / total).toFixed(1)}%  ${k}`);
}
