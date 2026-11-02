/**
 * Slow mode (src/simulation/slow-mode.ts) against a fully resolved run.
 *
 * The level-1 spent fuel pool is a real slow transient with curvature: the
 * liner cracks at t=120 s, the pool drains at a falling rate while decay
 * heat warms it and air enters through the vent. Runs it twice - plain
 * solver and slow mode - and checks that slow mode actually skips time, never
 * jumps past the scripted event, and lands on the reference trajectory.
 *
 *   npx tsx scripts/test-slow-mode.ts
 */
import { buildSimFromFile, test, assert, report } from './lib/sim-harness';
import { SlowModeController } from '../src/simulation/slow-mode';
import type { SimulationState } from '../src/simulation/types';

const PLANT = 'scripts/test-plants/pool-level1.json';
const END = 1500;
const TICK = 0.5;

interface Obs { t: number; poolMass: number; poolT: number; pelletT: number; ar: number }
function observe(s: SimulationState): Obs {
  const pool = s.flowNodes.get('pool')!;
  return {
    t: s.time,
    poolMass: pool.fluid.mass,
    poolT: pool.fluid.temperature,
    pelletT: s.thermalNodes.get('pool-pellets')!.temperature,
    ar: pool.fluid.ncg?.Ar ?? 0,
  };
}

// Reference: plain solver, sampled every tick
const ref: Obs[] = [];
{
  const sim = buildSimFromFile(PLANT);
  ref.push(observe(sim.state));
  while (sim.state.time < END + 600) {
    sim.state = sim.solver.advance(sim.state, TICK).state;
    sim.state.pendingEvents = [];
    ref.push(observe(sim.state));
  }
}
function refAt(t: number): Obs {
  let i = 1;
  while (i < ref.length - 1 && ref[i].t < t) i++;
  const a = ref[i - 1], b = ref[i];
  const f = (t - a.t) / (b.t - a.t);
  const lerp = (x: number, y: number) => x + f * (y - x);
  return { t, poolMass: lerp(a.poolMass, b.poolMass), poolT: lerp(a.poolT, b.poolT),
    pelletT: lerp(a.pelletT, b.pelletT), ar: lerp(a.ar, b.ar) };
}

// Slow mode
const slow = new SlowModeController();
const sim = buildSimFromFile(PLANT);
const jumps: { from: number; to: number }[] = [];
let crossedEvent = false;
while (sim.state.time < END) {
  const r = slow.advance(sim.solver, sim.state, TICK);
  if (r.jump) {
    jumps.push({ from: r.jump.time, to: r.state.time });
    if (r.jump.time < 120 && r.state.time > 120) crossedEvent = true;
  }
  sim.state = r.state;
  sim.state.pendingEvents = [];
}
// Compare on the slow manifold: a jump leaves the fast modes (pellet-to-pool
// film, small nodes) briefly unsettled, and the run may have ended on one
for (let t = 0; t < 30; t += TICK) {
  sim.state = sim.solver.advance(sim.state, TICK).state;
  sim.state.pendingEvents = [];
}
const got = observe(sim.state);
const want = refAt(got.t);
const status = slow.getStatus();
console.log(`slow mode: t=${got.t.toFixed(0)} jumps=${status.jumps} skipped=${status.jumpedSeconds.toFixed(0)} s`);
console.log(`  pool mass ${got.poolMass.toFixed(0)} vs ${want.poolMass.toFixed(0)} kg, ` +
  `pool T ${(got.poolT - 273.15).toFixed(3)} vs ${(want.poolT - 273.15).toFixed(3)} C, ` +
  `pellets ${(got.pelletT - 273.15).toFixed(3)} vs ${(want.pelletT - 273.15).toFixed(3)} C, ` +
  `Ar ${got.ar.toFixed(2)} vs ${want.ar.toFixed(2)} mol`);

test('slow mode skips a meaningful share of the transient', () => {
  assert(status.jumps >= 5, `only ${status.jumps} jumps`);
  assert(status.jumpedSeconds > 0.3 * got.t, `skipped ${status.jumpedSeconds.toFixed(0)} s of ${got.t.toFixed(0)} s`);
});

test('no jump crosses the scripted liner crack', () => {
  assert(!crossedEvent, 'a jump skipped over the t=120 s scenario event');
});

test('slow mode lands on the reference trajectory', () => {
  const dm = Math.abs(got.poolMass - want.poolMass) / want.poolMass;
  assert(dm < 2e-3, `pool mass off by ${(dm * 100).toFixed(3)}%`);
  assert(Math.abs(got.poolT - want.poolT) < 0.2, `pool temperature off by ${(got.poolT - want.poolT).toFixed(3)} K`);
  assert(Math.abs(got.pelletT - want.pelletT) < 0.2, `pellet temperature off by ${(got.pelletT - want.pelletT).toFixed(3)} K`);
  const dar = Math.abs(got.ar - want.ar) / want.ar;
  assert(dar < 1e-2, `pool argon off by ${(dar * 100).toFixed(2)}%`);
});

report('slow mode');
