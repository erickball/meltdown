/**
 * Regression suite for CAR MhFtwLXlBhoEqGkOtiu3: an empty pipe joined to a
 * full fire-water tank ruptured three seconds later at 20.9 bar differential
 * (burst threshold 19.5 bar), fed by barely half a bar of static head.
 *
 * Replayed bit-identically on the build that recorded it (149412c): the pipe
 * still held its ~30 mol of air when the water reached 706 kg - its whole
 * volume - because that build priced a node's gas over the WHOLE node, so
 * the air took up no room, never pushed back, and was never driven out. The
 * 4 m/s column arriving at 300 kg/s then met a liquid-full node whose outlet
 * leg was still carrying ~10 kg/s: a lumped water hammer, 3 -> 22 bar in 3 ms.
 *
 * 059ad70 (the gas lives in the vapour space) is the fix: the air is priced
 * over the room the liquid leaves it, so it compresses ahead of the water,
 * slows the fill, and holds a pocket open. This suite pins that on a
 * DEAD-ENDED air-filled pipe: the only way out for the air is back up the
 * line it is being filled through, so what stays behind has to be squeezed.
 * On 149412c the same run ends with 706 kg of water - the pipe's whole
 * volume - AND all 29.5 mol of air still inside it, which is the state the
 * report's pipe hammered from.
 *
 *   npx tsx scripts/test-pipe-fill.ts
 */

import { test, assert, report, buildSim, run } from './lib/sim-harness';
import { saturationPressure } from '../src/simulation/water-properties';
import type { PlantComponent, Connection } from '../src/types';

const T_WATER = 288;  // K - a cold outdoor tank, as in the report

// A fire-water tank like the report's: 10 m wide, 6 m tall, 80% full, air
// above the water. Tank IC convention: fluid.pressure is the STEAM partial.
function tank(): [string, PlantComponent] {
  return ['tnk', {
    id: 'tnk', type: 'tank', label: 'Fire Water Tank',
    position: { x: 0, y: 0 }, rotation: 0,
    elevation: 0, height: 6, width: 10, fillLevel: 0.8, pressureRating: 2,
    fluid: { temperature: T_WATER, pressure: saturationPressure(T_WATER), phase: 'two-phase', quality: 1e-5, flowRate: 0 },
    initialNcg: { N2: 0.79, O2: 0.21 },
    ports: [{ id: 'tnk-low', position: { x: 5, y: 0 }, direction: 'both' }],
  } as unknown as PlantComponent];
}

// The report's pipe: 10 m of 0.3 m line at grade, full of air at 1 atm.
function emptyPipe(): [string, PlantComponent] {
  return ['pip', {
    id: 'pip', type: 'pipe', label: 'Pipe',
    position: { x: 5, y: 0 }, endPosition: { x: 15, y: 0 }, rotation: 0,
    elevation: 0, endElevation: 0, length: 10, diameter: 0.3, thickness: 0.01, pressureRating: 16,
    fluid: { temperature: T_WATER, pressure: saturationPressure(T_WATER), phase: 'vapor', quality: 1, flowRate: 0 },
    initialNcg: { N2: 0.79, O2: 0.21 },
    ports: [
      { id: 'pip-left', position: { x: 0, y: 0 }, direction: 'both' },
      { id: 'pip-right', position: { x: 10, y: 0 }, direction: 'both' },
    ],
  } as unknown as PlantComponent];
}

// Joined low on the tank (1 m up its side, so under ~3.8 m of water) and
// dead-ended at the far end: the pipe's other port connects to nothing.
const connections: Connection[] = [
  { fromComponentId: 'pip', fromPortId: 'pip-left', toComponentId: 'tnk', toPortId: 'tnk-low',
    fromElevation: 0.15, toElevation: 1, flowArea: Math.PI * 0.15 * 0.15, length: 1 } as Connection,
];

test('Joining an air-filled pipe to a full tank fills it against its air, without a hammer', () => {
  const sim = buildSim([tank(), emptyPipe()], connections);
  const pipe0 = sim.state.flowNodes.get('pip')!;
  const air0 = Object.values(pipe0.fluid.ncg ?? {}).reduce((a, b) => a + b, 0);
  assert(air0 > 20, `the pipe should start full of air (~29 mol at 1 atm), got ${air0.toFixed(1)} mol`);
  assert(pipe0.fluid.mass < 1, `the pipe should start empty of water, got ${pipe0.fluid.mass.toFixed(2)} kg`);

  let peak = 0;
  let peakAt = 0;
  run(sim, 30, 0.02, (st) => {
    const P = st.flowNodes.get('pip')!.fluid.pressure;
    if (P > peak) { peak = P; peakAt = st.time; }
  });

  const pipe = sim.state.flowNodes.get('pip')!;
  const air = Object.values(pipe.fluid.ncg ?? {}).reduce((a, b) => a + b, 0);
  const burst = sim.state.burstStates?.get('pip');
  console.log(`    pipe after 30 s: ${pipe.fluid.mass.toFixed(1)} kg of water, ${air.toFixed(1)} mol of air, ` +
    `${(pipe.fluid.pressure / 1e5).toFixed(3)} bar; peak ${(peak / 1e5).toFixed(3)} bar at t=${peakAt.toFixed(2)} s`);

  // It really did fill: the tank's head pushed water in against the air
  assert(pipe.fluid.mass > 100, `the pipe should have taken on water, holds ${pipe.fluid.mass.toFixed(1)} kg`);
  // Whatever air is left takes up room. Some of it burps back up the line
  // into the tank (the only opening, physically a counter-current of
  // bubbles), but what stays is squeezed into the space the water leaves:
  // V_liquid + n R T / P_gas = V. On 149412c the air "lived" in the whole
  // volume, so the water filled straight through it and this read 100% water
  // plus 0.47 m3 of air in a 0.71 m3 pipe.
  const R = 8.31446;
  const T = pipe.fluid.temperature;
  const P_gas = pipe.fluid.pressure - saturationPressure(T);
  const V_liquid = pipe.fluid.mass / 999;
  const V_air = air * R * T / P_gas;
  console.log(`    water ${V_liquid.toFixed(3)} m3 + air ${V_air.toFixed(3)} m3 (${air.toFixed(1)} mol at ` +
    `${(P_gas / 1e5).toFixed(3)} bar) in a ${pipe.volume.toFixed(3)} m3 pipe`);
  assert(air > 1, `some air should be left in the dead end (${air.toFixed(2)} mol)`);
  assert(Math.abs(V_liquid + V_air - pipe.volume) < 0.02 * pipe.volume,
    `water (${V_liquid.toFixed(3)} m3) and air (${V_air.toFixed(3)} m3) should share the ` +
    `${pipe.volume.toFixed(3)} m3 pipe - the gas has to live in the room the liquid leaves it`);
  // The head is ~0.5 bar, so a cushioned fill ends near 1.5 bar absolute.
  // Overshoot of the column on its air spring is physical; tens of bar is
  // the liquid-solid hammer the report hit.
  assert(peak < 3e5, `peak pipe pressure ${(peak / 1e5).toFixed(2)} bar - the fill hammered the pipe`);
  assert(!burst?.isBurst, `the pipe burst (${burst?.componentLabel}) at t=${burst?.burstTime?.toFixed(2)} s`);
});

report('Pipe fill (CAR MhFtwLXlBhoEqGkOtiu3)');
