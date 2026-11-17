/**
 * Ask questions of a run recorded by scripts/probe-record.ts, without rerunning it.
 *
 *   npx tsx scripts/probe-record-query.ts <dir> cols [regex]
 *       column names (matching regex), with min / max / first / last
 *   npx tsx scripts/probe-record-query.ts <dir> series <regex> [t0] [t1] [stride]
 *       the matching columns over [t0, t1], every stride-th row (default: about 40 rows)
 *   npx tsx scripts/probe-record-query.ts <dir> at <t> [regex]
 *       every matching column at the row nearest t
 *   npx tsx scripts/probe-record-query.ts <dir> change <t0> <t1> [regex] [n]
 *       the n (default 25) matching columns that changed most between t0 and t1,
 *       relative to their own range over the run
 *   npx tsx scripts/probe-record-query.ts <dir> events [regex] [t0] [t1]
 *       events.log lines matching regex in [t0, t1]
 *   npx tsx scripts/probe-record-query.ts <dir> diff <dir2> <t> [regex] [n]
 *       the n (default 25) matching columns that differ most between two runs
 *       at time t (each run's row nearest t), relative to the column's range
 *       in the first run
 *
 * Regexes match column names, e.g. 'hx-1-tube.*\.(m|P)$' or '\.T$'.
 * Works on a run that is still going (reads what has been written so far).
 */
import * as fs from 'fs';
import * as path from 'path';

interface Series { names: string[]; t: Float64Array; data: Float64Array[] }

function load(dir: string): Series {
  const text = fs.readFileSync(path.join(dir, 'series.csv'), 'utf-8');
  const lines = text.split('\n').filter(l => l.length > 0);
  const header = lines[0].split(',');
  // a run still being written may end on a partial row
  const rows = lines.slice(1).map(l => l.split(',')).filter(r => r.length === header.length);
  const data = header.map((_, j) => Float64Array.from(rows, r => parseFloat(r[j])));
  return { names: header, t: data[0], data };
}
const nearest = (s: Series, t: number) => {
  let best = 0;
  for (let i = 1; i < s.t.length; i++) if (Math.abs(s.t[i] - t) < Math.abs(s.t[best] - t)) best = i;
  return best;
};
const matching = (s: Series, re: string | undefined) => {
  const r = new RegExp(re ?? '.');
  return s.names.map((n, j) => j).filter(j => j > 0 && r.test(s.names[j]));
};
const range = (a: Float64Array) => {
  let lo = Infinity, hi = -Infinity;
  for (const v of a) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return [lo, hi];
};
const g = (v: number) => Number.isFinite(v) ? v.toPrecision(6) : String(v);
const num = (v: string | undefined, d: number) => v === undefined ? d : parseFloat(v);

const [dir, cmd, ...rest] = process.argv.slice(2);
if (!dir || !cmd) {
  console.error('usage: probe-record-query.ts <dir> cols|series|at|change|events|diff ... (see the file header)');
  process.exit(2);
}

switch (cmd) {
  case 'cols': {
    const s = load(dir);
    const js = matching(s, rest[0]);
    console.log(`${s.t.length} rows, t=${g(s.t[0])} .. ${g(s.t[s.t.length - 1])}; ${js.length} of ${s.names.length - 1} columns`);
    for (const j of js) {
      const [lo, hi] = range(s.data[j]);
      console.log(`${s.names[j].padEnd(48)} min=${g(lo)} max=${g(hi)} first=${g(s.data[j][0])} last=${g(s.data[j][s.t.length - 1])}`);
    }
    break;
  }
  case 'series': {
    const s = load(dir);
    const js = matching(s, rest[0]);
    const t0 = num(rest[1], -Infinity), t1 = num(rest[2], Infinity);
    const idx = [...s.t.keys()].filter(i => s.t[i] >= t0 && s.t[i] <= t1);
    const stride = rest[3] ? parseInt(rest[3], 10) : Math.max(1, Math.ceil(idx.length / 40));
    const jumpCol = s.names.indexOf('jump');
    console.log(['t', 'jump', ...js.map(j => s.names[j])].join(','));
    // rows on a jump are always shown: they are where the interesting things happen
    idx.forEach((i, k) => {
      if (k % stride === 0 || k === idx.length - 1 || s.data[jumpCol][i] > 0)
        console.log([g(s.t[i]), g(s.data[jumpCol][i]), ...js.map(j => g(s.data[j][i]))].join(','));
    });
    break;
  }
  case 'at': {
    const s = load(dir);
    const i = nearest(s, num(rest[0], NaN));
    console.log(`row at t=${g(s.t[i])}`);
    for (const j of matching(s, rest[1])) console.log(`${s.names[j].padEnd(48)} ${g(s.data[j][i])}`);
    break;
  }
  case 'change': {
    const s = load(dir);
    const i0 = nearest(s, num(rest[0], NaN)), i1 = nearest(s, num(rest[1], NaN));
    const n = rest[3] ? parseInt(rest[3], 10) : 25;
    const out = matching(s, rest[2]).filter(j => s.names[j] !== 'wall').map(j => {
      const [lo, hi] = range(s.data[j]);
      const d = s.data[j][i1] - s.data[j][i0];
      return { j, d, rel: hi > lo ? Math.abs(d) / (hi - lo) : 0 };
    }).sort((a, b) => b.rel - a.rel).slice(0, n);
    console.log(`t=${g(s.t[i0])} -> ${g(s.t[i1])}  (fraction of the column's range over the run)`);
    for (const o of out) console.log(`${s.names[o.j].padEnd(48)} ${g(s.data[o.j][i0])} -> ${g(s.data[o.j][i1])}  d=${g(o.d)}  ${(100 * o.rel).toFixed(1)}%`);
    break;
  }
  case 'events': {
    const re = new RegExp(rest[0] ?? '.');
    const t0 = num(rest[1], -Infinity), t1 = num(rest[2], Infinity);
    for (const l of fs.readFileSync(path.join(dir, 'events.log'), 'utf-8').split('\n')) {
      const t = parseFloat(l);
      if (l && t >= t0 && t <= t1 && re.test(l)) console.log(l);
    }
    break;
  }
  case 'diff': {
    const a = load(dir), b = load(rest[0]);
    const t = num(rest[1], NaN);
    const ia = nearest(a, t), ib = nearest(b, t);
    const n = rest[3] ? parseInt(rest[3], 10) : 25;
    const bIdx = new Map(b.names.map((name, j) => [name, j]));
    const out = matching(a, rest[2]).filter(j => a.names[j] !== 'wall' && bIdx.has(a.names[j])).map(j => {
      const [lo, hi] = range(a.data[j]);
      const d = b.data[bIdx.get(a.names[j])!][ib] - a.data[j][ia];
      return { j, d, rel: hi > lo ? Math.abs(d) / (hi - lo) : (d !== 0 ? Infinity : 0) };
    }).sort((x, y) => y.rel - x.rel).slice(0, n);
    console.log(`${dir} t=${g(a.t[ia])}  vs  ${rest[0]} t=${g(b.t[ib])}  (difference as a fraction of the column's range in the first run)`);
    for (const o of out) {
      const vb = b.data[bIdx.get(a.names[o.j])!][ib];
      console.log(`${a.names[o.j].padEnd(48)} ${g(a.data[o.j][ia])} vs ${g(vb)}  d=${g(o.d)}  ${Number.isFinite(o.rel) ? (100 * o.rel).toFixed(1) + '%' : 'const'}`);
    }
    break;
  }
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(2);
}
