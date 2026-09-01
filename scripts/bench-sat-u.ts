// Microbenchmark for the dome-boundary lookup (findSaturationU), which real
// runs call ~107k times per simulated second. Short repeated reps and a
// minimum statistic, because wall-clock on the full sim is swamped by other
// sessions' load.
import { preloadWaterProperties, DEBUG_findSaturationU } from '../src/simulation/water-properties-v4.ts';

async function main() {
  await preloadWaterProperties();

  const N = 1 << 16;

  // Three query streams: log-uniform over the whole curve, a liquid-heavy
  // cluster (where a PWR/SG plant actually sits, and where the curve's points
  // crowd tightest), and a vapour-side cluster.
  const streams: Record<string, Float64Array> = {
    'log-uniform': new Float64Array(N),
    'liquid-heavy': new Float64Array(N),
    'vapour-side': new Float64Array(N),
  };
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < N; i++) {
    streams['log-uniform'][i] = Math.pow(10, -3 + rnd() * 5.29);
    streams['liquid-heavy'][i] = 0.001005 + rnd() * 0.0006;
    streams['vapour-side'][i] = Math.pow(10, -2 + rnd() * 2.5);
  }

  const REPS = 12;
  for (const [name, vs] of Object.entries(streams)) {
    // warm up JIT on this stream
    let sink = 0;
    for (let w = 0; w < 3; w++) for (let i = 0; i < N; i++) sink += DEBUG_findSaturationU(vs[i]) ?? 0;

    let best = Infinity;
    for (let r = 0; r < REPS; r++) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) sink += DEBUG_findSaturationU(vs[i]) ?? 0;
      const dt = Number(process.hrtime.bigint() - t0) / 1e6;
      if (dt < best) best = dt;
    }
    const nsPerCall = (best * 1e6) / N;
    console.log(`${name.padEnd(13)} best ${best.toFixed(2)} ms / ${N} calls = ${nsPerCall.toFixed(1)} ns/call   (sink ${sink.toExponential(3)})`);
  }
}

void main();
