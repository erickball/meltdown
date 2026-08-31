/**
 * Attribute a .cpuprofile's time inside one file to the CALLERS outside it.
 *
 * prof-summary says water-properties-v4 is ~58% of self time. This says who is
 * asking for it: for every sample whose leaf frame is in the target file, walk
 * up the call tree to the first frame that is NOT in that file, and bill the
 * sample to that frame. That is the list to attack if the goal is to make
 * fewer property queries rather than cheaper ones.
 *
 * Usage: npx tsx scripts/lib/prof-callers.ts <file.cpuprofile> [targetFile]
 */

import * as fs from 'fs';

interface CallFrame { functionName: string; url: string; lineNumber: number }
interface ProfileNode { id: number; callFrame: CallFrame; children?: number[] }
interface CpuProfile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }

const file = process.argv[2];
const target = process.argv[3] || 'water-properties-v4.ts';
if (!file) {
  console.log('Usage: npx tsx scripts/lib/prof-callers.ts <file.cpuprofile> [targetFile]');
  process.exit(1);
}

const prof: CpuProfile = JSON.parse(fs.readFileSync(file, 'utf-8'));
const byId = new Map(prof.nodes.map(n => [n.id, n]));
const parent = new Map<number, number>();
for (const n of prof.nodes) {
  for (const c of n.children || []) parent.set(c, n.id);
}

const short = (cf: CallFrame) => (cf.url || '').replace(/^.*[\\/]/, '');
const inTarget = (n: ProfileNode) => short(n.callFrame) === target;

const byCaller = new Map<string, number>();
let targetTotal = 0;
let grandTotal = 0;

for (let i = 0; i < prof.samples.length; i++) {
  const dt = prof.timeDeltas[i] || 0;
  grandTotal += dt;
  let n = byId.get(prof.samples[i]);
  if (!n || !inTarget(n)) continue;
  targetTotal += dt;
  // Walk up to the first frame outside the target file.
  let cur: ProfileNode | undefined = n;
  while (cur && inTarget(cur)) {
    const p = parent.get(cur.id);
    cur = p === undefined ? undefined : byId.get(p);
  }
  // The first outside frame is often an anonymous closure (atP, resid, TOf
  // ...), which lumps distinct call paths together. Keep walking to the first
  // NAMED frame and report both: "named-owner <- immediate-caller".
  const imm = cur;
  let named = cur;
  while (named && !named.callFrame.functionName) {
    const p = parent.get(named.id);
    named = p === undefined ? undefined : byId.get(p);
  }
  const immStr = imm
    ? `${imm.callFrame.functionName || '(anon)'} @ ${short(imm.callFrame)}`
    : '(root)';
  const key = named && named !== imm
    ? `${named.callFrame.functionName} <- ${immStr}`
    : immStr + (imm ? `:${imm.callFrame.lineNumber + 1}` : '');
  byCaller.set(key, (byCaller.get(key) || 0) + dt);
}

console.log(`total sampled ${(grandTotal / 1e6).toFixed(2)}s; ` +
  `${(targetTotal / 1e6).toFixed(2)}s (${(100 * targetTotal / grandTotal).toFixed(1)}%) self time inside ${target}\n`);
console.log(`who asks for it (first frame outside ${target}):`);
for (const [k, v] of [...byCaller.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  if (v / 1e6 < 0.02) break;
  console.log(`  ${(v / 1e6).toFixed(2)}s  ${(100 * v / targetTotal).toFixed(1)}% of target  ` +
    `${(100 * v / grandTotal).toFixed(1)}% of all  ${k}`);
}
