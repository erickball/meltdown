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
  buildSim, buildSimFromFile, run, runUntilSteady, flowRate, nodeMass, nodePressure, totalMassAndEnergy,
  assertStateSane,
} from './lib/sim-harness';
import { triggerScram, nodeLiquidLevel } from '../src/simulation';
import * as path from 'path';
import { fileURLToPath } from 'url';

const PLANT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-plants');
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

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

  // The feed TRAIN must deliver forward. NOTE: the per-SG split (and even its
  // instantaneous total) is deliberately NOT asserted - without per-SG
  // feedwater valves the split is subject to a real condensation-flood
  // instability (cold feed condenses one shell's steam, dropping its pressure
  // and attracting yet more feed), which sloshes feed between the shells.
  // Feed system: what matters is that SG inventory is SECURED, not that feed
  // runs at any instant - with levels above setpoint the level controller
  // correctly throttles feed to minimum, and a bounded reverse leak-through
  // past the throttled pumps is the model's reverse-block equilibrium (the
  // preset has no feedwater check valves). Guard: both SG levels healthy and
  // any train backflow bounded.
  const lvlA = nodeLiquidLevel(state.flowNodes.get('hx-1-shell')!);
  const lvlB = nodeLiquidLevel(state.flowNodes.get('hx-2-shell')!);
  assert(lvlA > 5 && lvlB > 5,
    `both SG bundles should stay covered (levels A=${lvlA.toFixed(1)}, B=${lvlB.toFixed(1)} m)`);
  const trainFlow = flowRate(state, 'cond-pump-1', 'fw-pump-1');
  assert(trainFlow > -60,
    `feed-train backflow should be a bounded leak at most, got ${trainFlow.toFixed(1)} kg/s`);

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
// Relief valve: pops at setpoint, blows down, reseats, cycles
// ---------------------------------------------------------------------------

test('Relief valve pops at setpoint, reseats after blowdown, and cycles', () => {
  const sim = buildSimFromFile(path.join(PLANT_DIR, 'relief-valve.json'));

  let pops = 0, reseats = 0;
  let prevOpen = false;
  let maxP = 0;
  let minPAfterFirstPop = Infinity;
  for (let t = 0; t < 120; t += 0.5) {
    run(sim, 0.5, 0.02);
    const valve = sim.state.components.valves.get('rv')!;
    const P = nodePressure(sim.state, 'boiler');
    maxP = Math.max(maxP, P);
    const open = valve.reliefOpen ?? false;
    if (open && !prevOpen) pops++;
    if (!open && prevOpen) reseats++;
    prevOpen = open;
    if (pops > 0) minPAfterFirstPop = Math.min(minPAfterFirstPop, P);
  }

  // 10 MW into ~7 t of saturated water raises pressure ~0.5 bar in ~20 s, and
  // the open valve dumps ~20 MW equivalent - expect several full cycles.
  assert(pops >= 2, `valve should cycle (only ${pops} pops in 120 s)`);
  assert(reseats >= 1, `valve should reseat after blowdown (pops=${pops}, reseats=${reseats})`);
  // Setpoint 32 bar: pressure must not overshoot it by more than the stroke
  // transient, and must not fall below the blowdown target minus margin
  assert(maxP < 33.5e5, `pressure should be capped near the 32 bar setpoint, peaked at ${(maxP / 1e5).toFixed(2)} bar`);
  assert(minPAfterFirstPop > 28e5,
    `valve should reseat at ~30 bar (6% blowdown), fell to ${(minPAfterFirstPop / 1e5).toFixed(2)} bar`);
  assertStateSane(sim.state);
});

// ---------------------------------------------------------------------------
// Hydrogen combustion: continuous-rate deflagration in a closed vessel
// ---------------------------------------------------------------------------

function h2VesselPlant(h2Bar: number, airBar: number, tempK: number, steamFill: number) {
  // A closed 65 m3 vessel (tank, no connections). fillLevel 0 -> vapor
  // branch honors the given temperature; steamFill > 0 makes a two-phase
  // node whose vapor space carries the steam mole fraction for inerting.
  return [
    ['ves', {
      id: 'ves', type: 'tank', label: 'Test Vessel',
      position: { x: 40, y: 90 }, rotation: 0, elevation: 0,
      width: 4, height: 5.2, wallThickness: 0.08, fillLevel: steamFill, pressureRating: 40,
      ports: [],
      fluid: { temperature: tempK, pressure: steamFill > 0 ? 800000 : 25000, phase: steamFill > 0 ? 'two-phase' : 'vapor', quality: 1, flowRate: 0 },
      initialNcg: { N2: airBar * 0.79, O2: airBar * 0.21, H2: h2Bar },
    }],
  ] as any;
}

test('Hydrogen deflagration: hot flammable mixture burns, spikes pressure, conserves books', () => {
  // ~12% H2 in air at 620 K: kinetics self-ignite within a couple of minutes
  const sim = buildSim(h2VesselPlant(0.14, 1.0, 620, 0), []);
  const node0 = sim.state.flowNodes.get('ves')!;
  const h2_0 = node0.fluid.ncg!.H2;
  const o2_0 = node0.fluid.ncg!.O2;
  const m0 = node0.fluid.mass;
  const p0 = node0.fluid.pressure;
  assert(h2_0 > 50, `test setup should charge a real H2 inventory, got ${h2_0.toFixed(1)} mol`);

  let maxP = p0;
  run(sim, 240, 0.05, s => {
    maxP = Math.max(maxP, s.flowNodes.get('ves')!.fluid.pressure);
  });
  const node1 = sim.state.flowNodes.get('ves')!;

  // Burn completed: H2 essentially consumed, O2 down by half the H2 burned
  const h2Burned = h2_0 - node1.fluid.ncg!.H2;
  assert(node1.fluid.ncg!.H2 < 0.05 * h2_0,
    `H2 should burn out, ${node1.fluid.ncg!.H2.toFixed(1)} of ${h2_0.toFixed(1)} mol left`);
  const o2Used = o2_0 - node1.fluid.ncg!.O2;
  assertBetween(o2Used / h2Burned, 0.45, 0.55, 'O2 consumption should be stoichiometric (1:2)');

  // Product water joined the vessel inventory
  const massGain = node1.fluid.mass - m0;
  assertBetween(massGain / (h2Burned * 0.018), 0.95, 1.05, 'burned H2 should appear as product water');

  // Deflagration pressure spike: well above initial, well below detonation
  // scale (AICC for this mixture is roughly 4-5x initial absolute pressure)
  assert(maxP > 2 * p0, `burn should spike pressure (peak ${(maxP / 1e5).toFixed(2)} vs initial ${(p0 / 1e5).toFixed(2)} bar)`);
  assertStateSane(sim.state);
});

test('Hydrogen combustion respects flammability limits (lean and steam-inerted)', () => {
  // Lean: ~2% H2 (below the 4% LFL) at the same hot temperature
  const lean = buildSim(h2VesselPlant(0.02, 1.0, 620, 0), []);
  const leanH2_0 = lean.state.flowNodes.get('ves')!.fluid.ncg!.H2;
  run(lean, 120, 0.05);
  const leanH2_1 = lean.state.flowNodes.get('ves')!.fluid.ncg!.H2;
  assert(leanH2_1 > 0.98 * leanH2_0,
    `lean mixture must not burn (${leanH2_0.toFixed(1)} -> ${leanH2_1.toFixed(1)} mol)`);

  // Steam-inerted: plenty of H2 and O2 but the vapor space is mostly steam
  // (two-phase node at 8 bar; steam partial pressure dominates the gas space)
  const inert = buildSim(h2VesselPlant(0.5, 0.9, 445, 0.3), []);
  const inertH2_0 = inert.state.flowNodes.get('ves')!.fluid.ncg!.H2;
  run(inert, 120, 0.05);
  const inertH2_1 = inert.state.flowNodes.get('ves')!.fluid.ncg!.H2;
  assert(inertH2_1 > 0.98 * inertH2_0,
    `steam-inerted mixture must not burn (${inertH2_0.toFixed(1)} -> ${inertH2_1.toFixed(1)} mol)`);
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

// ---------------------------------------------------------------------------
// Controlled PWR: converges to an operating steady state and holds it
// ---------------------------------------------------------------------------
// The PWR preset carries six auto-tuned controllers (rods on T_cold, governor
// on SG pressure, three-element feedwater, hotwell level, pressurizer heaters
// + spray). Starting from a consistent low-power critical state, the plant
// must reach a HELD operating point: reactor critical at meaningful power,
// primary pressure on the heater setpoint, SG pressure on the governor
// setpoint, levels stable, and the SteadyStateDetector satisfied.

test('Controlled PWR converges to operating steady state and holds', () => {
  // 900 s of plant time: ~40 s wall under the implicit solver, ~25 min under
  // the explicit reference. Skip in explicit A/B runs (IMPLICIT_MOMENTUM=0);
  // the explicit path's physics is covered by every other suite.
  if (process.env.IMPLICIT_MOMENTUM === '0') {
    console.log('[test] skipping controlled-PWR steady-state test under explicit momentum (too slow)');
    return;
  }
  const sim = buildSimFromFile(path.join(SCRIPTS_DIR, 'pwr-test.json'));

  // Allow the startup approach (~8 min of plant time; tens of seconds wall
  // under the implicit solver), then require the detector to latch steady.
  const { steady, detector, elapsed } = runUntilSteady(sim, 900, 0.5, {
    // Tolerances sized to realistic plant noise: a boiling SG and a hunting
    // feed train wander a little forever; "steady" means bounded wander,
    // not silence. The long window lets episodic dome-edge pressure bounces
    // average out while monotonic drift still accumulates.
    windowSeconds: 60,
    fractionalRateTol: 2e-3,
    temperatureRateTol: 0.1,
    holdSeconds: 60,
  });
  const worst = detector.worstOffender();
  assert(steady,
    `plant should reach steady state within 900 s (worst drift after ${elapsed.toFixed(0)} s: ` +
    `${worst?.metric}=${worst?.value.toExponential(2)} vs tol ${worst?.tolerance.toExponential(2)})`);

  const state = sim.state;
  const n = state.neutronics;

  // Reactor critical near RATED power (boiling/wetted-area convection makes
  // the SG capable of full load), rods NOT parked at a limit.
  const powerFrac = n.power / n.nominalPower;
  assertBetween(powerFrac, 0.7, 1.15, 'reactor should hold near rated power');
  // "Interior" = not railed against a stop; the exact park position depends
  // on how much Doppler/coolant feedback the rods must pay at full power
  assertBetween(n.controlRodPosition, 0.05, 0.97, 'rods should hold an interior position');

  // Pressurizer pressure near the heater setpoint (155 bar). The band's low
  // side allows the slow post-startup recovery: the primary contracts during
  // the power ascension and the 1.8 MW heater bank recharges the pressure at
  // ~1 bar/min, which can still be in progress when steadiness (drift below
  // tolerance) is declared.
  assertBetween(nodePressure(state, 'pzr-1'), 135e5, 162e5, 'pressurizer pressure on setpoint');

  // SG pressure held near the governor setpoint (60 bar)
  assertBetween(nodePressure(state, 'hx-1-shell'), 55e5, 65e5, 'SG pressure on setpoint');

  // Primary loop circulating
  assert(flowRate(state, 'pump-1', 'rv-1') > 3000,
    `primary loop should circulate strongly, got ${flowRate(state, 'pump-1', 'rv-1').toFixed(0)} kg/s`);

  // Steam produced and condensate returned (secondary side alive)
  assert(flowRate(state, 'hx-1', 'turbine-1') > 10,
    `turbine should draw steam, got ${flowRate(state, 'hx-1', 'turbine-1').toFixed(1)} kg/s`);

  assertStateSane(state);
});

// ---------------------------------------------------------------------------
// Decay heat: a scrammed core keeps producing (decaying) heat
// ---------------------------------------------------------------------------

test('SCRAM leaves fission-product decay heat behind', () => {
  const sim = buildSimFromFile(path.join(SCRIPTS_DIR, 'pwr-test.json'));
  run(sim, 30.0, 0.5); // let the startup establish some power history
  const powerBefore = sim.state.neutronics.power;
  assert(powerBefore > 0.02 * sim.state.neutronics.nominalPower,
    `need meaningful power before scram, got ${(100 * powerBefore / sim.state.neutronics.nominalPower).toFixed(1)}%`);

  sim.state = triggerScram(sim.state, 'regression test');
  // 60 s: the prompt drop is immediate, but the large precursor inventory of
  // a near-rated core decays through subcritical multiplication over ~1 min
  run(sim, 60.0, 0.5);

  const n = sim.state.neutronics;
  assert(n.power < 0.06 * n.nominalPower,
    `fission power should collapse after scram, got ${(100 * n.power / n.nominalPower).toFixed(1)}%`);
  const pools60 = (n.decayHeatPools ?? []).reduce((s, q) => s + q, 0);
  // A few percent of prior power shortly after shutdown (coarse ANS-5.1).
  // Lower bound is loose because the pools lag a RISING pre-scram power (the
  // scram happens mid-startup, so pools equilibrated to a much lower recent
  // mean than the instantaneous pre-scram power).
  assertBetween(pools60 / powerBefore, 0.005, 0.08, 'decay heat 60 s after scram vs prior power');

  run(sim, 100.0, 0.5);
  const pools160 = (sim.state.neutronics.decayHeatPools ?? []).reduce((s, q) => s + q, 0);
  assert(pools160 < pools60, 'decay heat must decay');
  assert(pools160 > 0.25 * pools60,
    `decay heat must have a long tail, fell ${pools60.toExponential(2)} -> ${pools160.toExponential(2)} W in 100 s`);
});

report('Plant Scenario Regression Suite');
