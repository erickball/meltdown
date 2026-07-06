/**
 * Plant Scenario Regression Suite
 *
 * Runs structurally diverse plants (scripts/test-plants/*.json) headless and
 * asserts qualitative physics on each. The point is breadth: the shipping
 * presets (PWR, BWR) are two specific single-loop topologies, and a solver
 * tuned only against them could quietly break parallel loops, natural
 * circulation, safety injection, dead legs, or pipe components. These plants
 * exercise those shapes; the assertions are loose enough to pass across
 * solver rework but tight enough to catch qualitative regressions.
 *
 * Run: npx tsx scripts/test-plant-scenarios.ts   (also part of `npm test`)
 */

import {
  test, assert, assertBetween, report,
  buildSimFromFile, run, flowRate, nodeMass, nodePressure, totalMassAndEnergy,
  assertStateSane,
} from './lib/sim-harness';
import * as path from 'path';
import { fileURLToPath } from 'url';

const PLANT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-plants');

// ---------------------------------------------------------------------------
// Two-loop PWR: parallel primary loops, merged steam lines, split feed train
// ---------------------------------------------------------------------------

test('Two-loop PWR: parallel loops share load symmetrically', () => {
  const sim = buildSimFromFile(path.join(PLANT_DIR, 'two-loop-pwr.json'));
  const before = totalMassAndEnergy(sim.state);
  run(sim, 15.0, 0.01);
  const state = sim.state;

  // Both primary loops must circulate forward with comparable flow
  const q1 = flowRate(state, 'pump-1', 'rv-1');
  const q2 = flowRate(state, 'pump-2', 'rv-1');
  assert(q1 > 1000, `loop A should circulate strongly, got ${q1.toFixed(0)} kg/s`);
  assert(q2 > 1000, `loop B should circulate strongly, got ${q2.toFixed(0)} kg/s`);
  const asym = Math.abs(q1 - q2) / Math.max(q1, q2);
  assert(asym < 0.3, `symmetric loops should carry similar flow: A=${q1.toFixed(0)}, B=${q2.toFixed(0)} kg/s (${(asym * 100).toFixed(0)}% asymmetry)`);

  // Both steam generators must send steam toward the turbine
  const s1 = flowRate(state, 'hx-1', 'turbine-1');
  const s2 = flowRate(state, 'hx-2', 'turbine-1');
  assert(s1 > 3 && s2 > 3, `both SGs should supply steam (A=${s1.toFixed(1)}, B=${s2.toFixed(1)} kg/s)`);

  // Total feed must run forward. NOTE: the per-SG split is deliberately NOT
  // asserted symmetric - without per-SG feedwater control valves the split is
  // subject to a real condensation-flood instability (cold feed condenses one
  // shell's steam, dropping its pressure and attracting yet more feed), so a
  // symmetric split is not a physical invariant of this uncontrolled plant.
  const f1 = flowRate(state, 'fw-pump-1', 'hx-1');
  const f2 = flowRate(state, 'fw-pump-1', 'hx-2');
  assert(f1 + f2 > 0, `total feed flow should be forward (A=${f1.toFixed(1)}, B=${f2.toFixed(1)} kg/s)`);

  assertStateSane(state);
  const after = totalMassAndEnergy(state);
  const massDrift = Math.abs(after.mass - before.mass) / before.mass;
  assert(massDrift < 1e-6, `closed system mass drift ${(massDrift * 100).toExponential(2)}%`);
});

// ---------------------------------------------------------------------------
// Natural circulation: buoyancy/condensation-driven loop with no pumps
// ---------------------------------------------------------------------------

test('Natural circulation: condensing loop circulates without pumps', () => {
  const sim = buildSimFromFile(path.join(PLANT_DIR, 'nat-circ.json'));
  const e0 = totalMassAndEnergy(sim.state);
  run(sim, 30.0);
  const state = sim.state;

  // Steam must rise to the condenser and condensate must return - forward
  // flow on both legs with zero pump work anywhere in the system.
  const steamUp = flowRate(state, 'hot-1', 'ic-1');
  const drainBack = flowRate(state, 'ic-1', 'hot-1');
  assert(steamUp > 0.2, `steam should flow up to the condenser, got ${steamUp.toFixed(3)} kg/s`);
  assert(drainBack > 0.05, `condensate should drain back by gravity, got ${drainBack.toFixed(3)} kg/s`);

  // The condenser must actually be removing energy from the system
  const e1 = totalMassAndEnergy(state);
  assert(e1.energy < e0.energy, 'condenser should remove net energy from the loop');
  const massDrift = Math.abs(e1.mass - e0.mass) / e0.mass;
  assert(massDrift < 1e-6, `closed loop mass drift ${(massDrift * 100).toExponential(2)}%`);
  assertStateSane(state);
});

// ---------------------------------------------------------------------------
// Accumulator injection: check valve holds, then injects after blowdown
// ---------------------------------------------------------------------------

test('Accumulator holds at high vessel pressure, injects after blowdown', () => {
  const sim = buildSimFromFile(path.join(PLANT_DIR, 'accumulator.json'));

  // Phase 1: vessel at ~50 bar >> accumulator at ~10 bar. Check valve holds.
  const accMass0 = nodeMass(sim.state, 'acc-1');
  run(sim, 5.0);
  const accMassHeld = nodeMass(sim.state, 'acc-1');
  assert(Math.abs(accMassHeld - accMass0) < 5,
    `accumulator must hold behind check valve at high vessel pressure (moved ${(accMassHeld - accMass0).toFixed(2)} kg)`);

  // Phase 2: open the drain - vessel blows down into the dump tank.
  const drain = sim.state.components.valves.get('drain-1');
  assert(!!drain, 'drain valve state should exist');
  drain!.position = 1.0;
  run(sim, 40.0);
  const state = sim.state;

  const pVessel = nodePressure(state, 'vsl-1');
  assert(pVessel < 12e5, `vessel should blow down below accumulator pressure, still at ${(pVessel / 1e5).toFixed(1)} bar`);

  const accMass1 = nodeMass(state, 'acc-1');
  assert(accMass1 < accMass0 - 100,
    `accumulator should inject after blowdown (only delivered ${(accMass0 - accMass1).toFixed(1)} kg)`);
  assert(accMass1 <= accMassHeld + 5,
    `accumulator must never gain mass through its check valve (${accMassHeld.toFixed(1)} -> ${accMass1.toFixed(1)} kg)`);
  assertStateSane(state);
});

// ---------------------------------------------------------------------------
// Kitchen sink: awkward topology - parallel returns, pipe component,
// dead leg, half-open valve, NCG building
// ---------------------------------------------------------------------------

test('Kitchen sink: awkward topology runs clean', () => {
  const sim = buildSimFromFile(path.join(PLANT_DIR, 'kitchen-sink.json'));
  const before = totalMassAndEnergy(sim.state);
  const stubMass0 = nodeMass(sim.state, 'stub-1');
  run(sim, 20.0);
  const state = sim.state;

  // The pumped loop must circulate through the pipe component
  const qPump = flowRate(state, 'circ-1', 'cool-1');
  assert(qPump > 30, `pump loop should circulate, got ${qPump.toFixed(1)} kg/s`);
  const qPipe = flowRate(state, 'pipe-1', 'circ-1');
  assert(qPipe > 30, `flow should pass through the pipe component, got ${qPipe.toFixed(1)} kg/s`);

  // Both parallel return paths (direct + through the half-open bypass valve)
  // should carry forward flow
  const qDirect = flowRate(state, 'cool-1', 'hot-1');
  const qBypass = flowRate(state, 'byp-1', 'hot-1');
  assert(qDirect > 0, `direct return path should flow forward, got ${qDirect.toFixed(1)} kg/s`);
  assert(qBypass > 0, `bypass return path should flow forward, got ${qBypass.toFixed(1)} kg/s`);

  // The dead leg must neither drain nor fill appreciably
  const stubMass1 = nodeMass(state, 'stub-1');
  const stubChange = Math.abs(stubMass1 - stubMass0) / stubMass0;
  assert(stubChange < 0.2,
    `dead-leg inventory should stay put (changed ${(stubChange * 100).toFixed(1)}%: ${stubMass0.toFixed(0)} -> ${stubMass1.toFixed(0)} kg)`);

  assertStateSane(state);
  const after = totalMassAndEnergy(state);
  const massDrift = Math.abs(after.mass - before.mass) / before.mass;
  assert(massDrift < 1e-6, `closed system mass drift ${(massDrift * 100).toExponential(2)}%`);
});

report('Plant Scenario Regression Suite');
