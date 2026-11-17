/**
 * Test runner: the one list of what `npm test` runs, run several at a time.
 *
 *   npx tsx scripts/run-tests.ts            every test (npm test)
 *   npx tsx scripts/run-tests.ts --fast     the quick subset (npm run test:fast)
 *   npx tsx scripts/run-tests.ts --jobs 4   at most 4 at once (default: cores - 2, at most 12)
 *   npx tsx scripts/run-tests.ts flow pump  only tests whose file name contains one of these words
 *
 * Each test is its own process, so they cannot share state; none writes
 * files. A test's output is printed only if it fails (the last 60 lines),
 * so a run reads as one line per test with its wall time. The exit code is
 * non-zero if any test failed.
 *
 * FAST set (--fast): everything but the six long tests listed at TESTS -
 * about a minute of wall time. Use it for minor changes; run the full set
 * before merging. Re-time when the list drifts: a full run prints every
 * test's wall time.
 */
import { spawn } from 'child_process';
import * as os from 'os';

interface TestDef { file: string; fast: boolean }

// `fast: false` marks the six long ones (wall time with the whole list running
// 8 at a time, 2026-11-16): check-triso-release 296 s, check-pebble-spill
// 278 s, test-pump-placement 170 s, test-otsg-flow-directions 112 s,
// test-slow-mode 74 s, test-electrical-plant 72 s. Every other test took
// 12-46 s. When a change is in one of those areas, run the fast set plus
// that test by name (e.g. `--fast` then `slow-mode`).
const TESTS: TestDef[] = [
  { file: 'src/simulation/test-suite.ts', fast: true },
  { file: 'scripts/check-accumulate-rates.ts', fast: true },
  { file: 'scripts/test-flow-physics.ts', fast: true },
  { file: 'scripts/test-replay-seek.ts', fast: true },
  { file: 'scripts/test-history-epochs.ts', fast: true },
  { file: 'scripts/test-display-flow.ts', fast: true },
  { file: 'scripts/test-display-fluid.ts', fast: true },
  { file: 'scripts/test-grid-geometry.ts', fast: true },
  { file: 'scripts/test-grid-sections.ts', fast: true },
  { file: 'scripts/test-stock.ts', fast: true },
  { file: 'scripts/test-electrical.ts', fast: true },
  { file: 'scripts/test-electrical-plant.ts', fast: false },
  { file: 'scripts/test-build-queue.ts', fast: true },
  { file: 'scripts/test-terrain.ts', fast: true },
  { file: 'scripts/test-terrain-3d.ts', fast: true },
  { file: 'scripts/test-mode-roundtrip.ts', fast: true },
  { file: 'scripts/test-live-edit.ts', fast: true },
  { file: 'scripts/test-car-bundle.ts', fast: true },
  { file: 'scripts/test-pump-line.ts', fast: true },
  { file: 'scripts/test-pump-placement.ts', fast: false },
  { file: 'scripts/test-pipe-fill.ts', fast: true },
  { file: 'scripts/test-pipe-endpoints.ts', fast: true },
  { file: 'scripts/test-pool-melt.ts', fast: true },
  { file: 'scripts/check-triso-release.ts', fast: false },
  { file: 'scripts/check-pebble-spill.ts', fast: false },
  { file: 'scripts/check-core-barrel.ts', fast: true },
  { file: 'scripts/check-exchange-flow.ts', fast: true },
  { file: 'scripts/test-slow-mode.ts', fast: false },
  { file: 'scripts/test-otsg-flow-directions.ts', fast: false },
];

const args = process.argv.slice(2);
const fast = args.includes('--fast');
const ji = args.indexOf('--jobs');
const jobs = ji >= 0 ? parseInt(args[ji + 1], 10) : Math.max(1, Math.min(12, os.cpus().length - 2));
const words = args.filter((a, i) => !a.startsWith('--') && !(ji >= 0 && i === ji + 1));
const selected = TESTS.filter(t => (!fast || t.fast) && (words.length === 0 || words.some(w => t.file.includes(w))));
if (selected.length === 0) throw new Error(`no test matches ${words.join(' ')}`);

interface Result { file: string; ok: boolean; seconds: number; tail: string }

function run(t: TestDef): Promise<Result> {
  return new Promise(resolve => {
    const t0 = performance.now();
    // shell: true so `npx` resolves on Windows (npx.cmd)
    const child = spawn('npx', ['tsx', t.file], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    const keep = (buf: Buffer) => {
      for (const l of buf.toString().split(/\r?\n/)) { lines.push(l); if (lines.length > 60) lines.shift(); }
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', code => {
      const seconds = (performance.now() - t0) / 1000;
      const ok = code === 0;
      console.log(`${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${seconds.toFixed(0).padStart(5)} s  ${t.file}`);
      resolve({ file: t.file, ok, seconds, tail: lines.join('\n') });
    });
  });
}

async function main() {
  const wall0 = performance.now();
  console.log(`${selected.length} test${selected.length > 1 ? 's' : ''}${fast ? ' (fast set)' : ''}, ${jobs} at a time`);
  // the long tests first, so the run is not left waiting on one at the end
  const queue = [...selected.filter(t => !t.fast), ...selected.filter(t => t.fast)];
  const results: Result[] = [];
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) results.push(await run(t));
  }));
  const failed = results.filter(r => !r.ok);
  for (const r of failed) console.log(`\n===== ${r.file} (last 60 lines) =====\n${r.tail}`);
  const wall = (performance.now() - wall0) / 1000;
  console.log(`\n${failed.length === 0 ? '\x1b[32mall passed\x1b[0m' : `\x1b[31m${failed.length} FAILED\x1b[0m: ${failed.map(f => f.file).join(', ')}`}` +
    ` - ${wall.toFixed(0)} s wall`);
  process.exit(failed.length === 0 ? 0 : 1);
}
main();
