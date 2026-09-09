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
  buildSim, buildSimFromFile, buildSimFromPlantJson, run, runUntilSteady, flowRate, nodeMass, nodePressure, totalMassAndEnergy,
  assertStateSane,
} from './lib/sim-harness';
import { triggerScram, nodeLiquidLevel } from '../src/simulation';
import { getCladdingOxidationPower } from '../src/simulation/operators/rate-operators';
import { terrainHeightAt } from '../src/simulation/terrain';
import * as fs from 'fs';
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
// Suction lift: atmosphere can only push water up so far
// ---------------------------------------------------------------------------

test('Suction lift: a pump 8 m above the water draws it, 14 m above it runs its intake dry', () => {
  // Open reservoir (air over 20 C water, surface at -5 m), a suction pipe up
  // to a pump, and a discharge to an open pool at +15 m. The pump is rated
  // 100 kg/s at 30 m head - plenty for the discharge; what limits it is
  // what the atmosphere can push up the intake (~10 m of water minus
  // friction and the pump's NPSH).
  const ok = buildSimFromFile(path.join(PLANT_DIR, 'suction-lift-8m.json'));
  run(ok, 30.0, 0.01);
  const q8 = flowRate(ok.state, 'pump-1', 'pool');
  assert(q8 > 20, `8 m lift should deliver (cavitating, suction-limited), got ${q8.toFixed(1)} kg/s`);
  assert(q8 < 150, `8 m lift must be suction-limited well below the pump's runout, got ${q8.toFixed(1)} kg/s`);
  assertStateSane(ok.state);

  const dry = buildSimFromFile(path.join(PLANT_DIR, 'suction-lift-14m.json'));
  run(dry, 30.0, 0.01);
  const q14 = flowRate(dry.state, 'pump-1', 'pool');
  assert(Math.abs(q14) < 2, `14 m lift cannot deliver, got ${q14.toFixed(2)} kg/s`);
  // The intake pipe has flashed and emptied: two-phase at the vapor pressure
  const sp = dry.state.flowNodes.get('sp')!;
  assert(sp.fluid.phase === 'two-phase' && sp.fluid.pressure < 0.1e5,
    `intake should have run dry (two-phase near vapor pressure), got ${sp.fluid.phase} at ${(sp.fluid.pressure / 1e5).toFixed(3)} bar`);
  assertStateSane(dry.state);
});

// ---------------------------------------------------------------------------
// Terrain: a shore pump is drowned by a tsunami and recovers when it recedes
// ---------------------------------------------------------------------------

test('Terrain: the sea rising over a shore pump drowns it, and it restarts when the water is gone', () => {
  // Ground slopes from +12 m down to the sea; the reservoir and pump stand on
  // the shore at ground +2 m and lift water to a pool on the hill (ground
  // +10 m). The scenario raises the sea 5 m at t=20 s and drops it at t=60 s.
  const sim = buildSimFromFile(path.join(PLANT_DIR, 'terrain-shore.json'));
  const spec = sim.state.terrain!.spec;
  const groundUnder = (id: string) => terrainHeightAt(spec, sim.state.flowNodes.get(id)!.position!);
  const pumpNode = sim.state.flowNodes.get('pump-1')!;
  const pumpGround = groundUnder('pump-1');
  assert(pumpGround > 0.5 && pumpGround < 2.5, `fixture: the pump should stand low on the shore, ground ${pumpGround.toFixed(2)} m`);
  assert(Math.abs(pumpNode.elevation - pumpGround) < 1e-6, `pump base should be the ground under it (${pumpGround.toFixed(2)} m), got ${pumpNode.elevation.toFixed(2)}`);
  const poolNode = sim.state.flowNodes.get('pool')!;
  const poolGround = groundUnder('pool');
  assert(Math.abs(poolNode.elevation - poolGround) < 1e-6, `pool base should be its hillside ground (${poolGround.toFixed(2)} m), got ${poolNode.elevation.toFixed(2)}`);
  // Gravity along the discharge runs from the pump nozzle (0.3 m up its base)
  // to the pool inlet (3 m up the pool's base): the port elevations count
  const lift = sim.state.flowConnections.find(c => c.id === 'flow-pump-1-pool')!;
  const expectedLift = (poolGround + 3) - (pumpGround + 0.3);
  assert(Math.abs(lift.elevation - expectedLift) < 1e-6, `discharge climb should be ${expectedLift.toFixed(2)} m, got ${lift.elevation.toFixed(2)} m`);

  run(sim, 15.0, 0.02);
  const q0 = flowRate(sim.state, 'pump-1', 'pool');
  assert(q0 > 10, `shore pump should be lifting to the hill, got ${q0.toFixed(1)} kg/s`);
  assert(!sim.state.components.pumps.get('pump-1')!.flooded, 'pump must not be flooded at sea level 0');

  run(sim, 30.0, 0.02);   // t = 45 s: the sea has stood at +5 m for 5 s
  const sea = sim.state.surfaceWater!.bodies.get('sea')!;
  assert(Math.abs(sea.surface - 5) < 1e-6, `sea should have risen to +5 m, got ${sea.surface}`);
  const pump = sim.state.components.pumps.get('pump-1')!;
  assert(pump.flooded, 'pump standing at +2 m must be flooded under a +5 m sea');
  assert(pump.effectiveSpeed < 0.5, `flooded pump must be coasting down, speed ${pump.effectiveSpeed.toFixed(2)}`);

  run(sim, 60.0, 0.02);   // t = 105 s: the sea has been back at 0 since t=90
  // (re-read: every accepted step is a new state object)
  const seaAfter = sim.state.surfaceWater!.bodies.get('sea')!;
  assert(Math.abs(seaAfter.surface) < 1e-6, `sea should be back at 0, got ${seaAfter.surface}`);
  assert(!sim.state.components.pumps.get('pump-1')!.flooded, 'pump must be dry again');
  assert(sim.state.components.pumps.get('pump-1')!.effectiveSpeed > 0.9, 'pump restarts once the water is gone');
  assertStateSane(sim.state);
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
  // ~12% H2 in air, above the second explosion limit so it autoignites.
  //
  // This case used to run at 620 K, on the premise that "kinetics self-ignite
  // within a couple of minutes". They don't, and shouldn't: hydrogen's
  // autoignition temperature in air is ~773-853 K, and the chain-branching
  // criterion now in HydrogenCombustionRateOperator puts the crossover at
  // 854 K in dry air at 1 atm (measured value) - rising to ~950 K for the ~20%
  // steam this vessel carries. A 620 K mixture is genuinely inert until
  // something lights it, which is precisely why containments are fitted with
  // igniters and recombiners. Ignition sources are modelled separately (hot
  // surfaces, the running-pump placeholder); this test is about what a real
  // deflagration DOES once started, so run it over the threshold.
  const sim = buildSim(h2VesselPlant(0.14, 1.0, 1020, 0), []);
  const node0 = sim.state.flowNodes.get('ves')!;
  const h2_0 = node0.fluid.ncg!.H2;
  const o2_0 = node0.fluid.ncg!.O2;
  const m0 = node0.fluid.mass;
  const p0 = node0.fluid.pressure;
  assert(h2_0 > 50, `test setup should charge a real H2 inventory, got ${h2_0.toFixed(1)} mol`);

  const t0 = node0.fluid.temperature;
  let maxP = p0;
  let maxT = t0;
  run(sim, 240, 0.05, s => {
    const n = s.flowNodes.get('ves')!;
    maxP = Math.max(maxP, n.fluid.pressure);
    maxT = Math.max(maxT, n.fluid.temperature);
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

  // Deflagration signature. Temperature rise is the direct measure and it is
  // unambiguous: ~+840 K here, versus a fraction of a kelvin for the lean case
  // below. Pressure rise is asserted too but at a lower ratio than the 2x this
  // used when the case started at 620 K - the SAME energy release rides on a
  // higher base temperature, so P/P0 is inherently smaller from a hot start
  // (measured 1.73x from 1020 K, against roughly 2.4x from 620 K). Nothing
  // about the burn got weaker; the yardstick moved.
  assert(maxT - t0 > 500,
    `deflagration should spike temperature (peak ${maxT.toFixed(0)} K vs initial ${t0.toFixed(0)} K)`);
  assert(maxP > 1.5 * p0,
    `burn should spike pressure (peak ${(maxP / 1e5).toFixed(2)} vs initial ${(p0 / 1e5).toFixed(2)} bar)`);
  assertStateSane(sim.state);
});

test('Hydrogen combustion respects flammability limits (lean and steam-inerted)', () => {
  // Lean: ~2% H2 (below the 4% LFL) at the same hot temperature.
  //
  // What must NOT happen is a DEFLAGRATION - the runaway the operator models
  // as thermal feedback (see the test above: H2 essentially gone, pressure
  // spiked past 2x). The model has no hard LFL cutoff by design; its
  // flammability envelope is a smooth composition factor, so a sub-limit
  // mixture at 620 K still oxidises slowly, and asserting a fixed inventory
  // bound measures that slow rate rather than the runaway.
  //
  // With the chain-branching criterion this is now inert for a reason that is
  // not about the LFL at all: 620 K is far below the second explosion limit
  // (854 K dry, ~950 K at this vessel's steam fraction), so every H atom is
  // quenched by H + O2 + M -> HO2 + M in microseconds and the radical pool
  // cannot grow. Zero burn, on any timescale - not "slow".
  //
  // Assert both the inventory and the absence of a pressure spike, so the test
  // distinguishes "did not deflagrate" from "deflagrated slowly".
  const lean = buildSim(h2VesselPlant(0.02, 1.0, 620, 0), []);
  const leanH2_0 = lean.state.flowNodes.get('ves')!.fluid.ncg!.H2;
  const leanP0 = lean.state.flowNodes.get('ves')!.fluid.pressure;
  let leanMaxP = leanP0;
  run(lean, 120, 0.05, s => {
    leanMaxP = Math.max(leanMaxP, s.flowNodes.get('ves')!.fluid.pressure);
  });
  const leanH2_1 = lean.state.flowNodes.get('ves')!.fluid.ncg!.H2;
  assert(leanH2_1 > 0.99 * leanH2_0,
    `lean mixture must not burn (${leanH2_0.toFixed(1)} -> ${leanH2_1.toFixed(1)} mol)`);
  assert(leanMaxP < 1.2 * leanP0,
    `lean mixture must not spike pressure (peak ${(leanMaxP / 1e5).toFixed(3)} vs ` +
    `initial ${(leanP0 / 1e5).toFixed(3)} bar)`);

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

  // The pumped loop must circulate through the pipe component. Averaged
  // over 20-30 s rather than sampled at an instant: the cool tank's 430 K
  // water condensing into the 483 K two-phase hot tank depressurizes the
  // whole loop (19 -> 13 bar in 40 s), the liquid arriving at the pump pot
  // flashes on the way down, and a centrifugal pump in a 40-60% void pot
  // develops a fifth of its head - so the loop sloshes between ~40 and
  // ~120 kg/s (mean ~65) instead of the 150 kg/s it carried when a voided
  // pot was still priced at liquid density. A single sample at 20 s sat in
  // a trough at 28 kg/s.
  let qPumpSum = 0, qPipeSum = 0, samples = 0;
  const state = run(sim, 10.0, 0.02, s => {
    qPumpSum += flowRate(s, 'circ-1', 'cool-1');
    qPipeSum += flowRate(s, 'pipe-1', 'circ-1');
    samples++;
  });
  const qPump = qPumpSum / samples;
  assert(qPump > 30, `pump loop should circulate, got ${qPump.toFixed(1)} kg/s mean over 20-30 s`);
  const qPipe = qPipeSum / samples;
  assert(qPipe > 30, `flow should pass through the pipe component, got ${qPipe.toFixed(1)} kg/s mean over 20-30 s`);

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

// ---------------------------------------------------------------------------
// Spent-fuel pool: constant rack heat, a cracked liner, and make-up water
// ---------------------------------------------------------------------------

test('Spent fuel pool: warms at its rack power, drains through a cracked liner into the ground, and refills', () => {
  // 12 x 12 x 12 m pool sunk to grade (elevation -12 on ground at +4.5 m),
  // ~1000 t of 30 C water over 800 assemblies making a constant 5 MW, open
  // to the sky through a vent connection to the atmosphere. The scenario
  // tears the liner at t = 120 s with a scripted BURST - the same break
  // machinery a pressure rupture uses, on a component whose rating was
  // never exceeded - 0.4 m up the pool wall with a 0.8 m opening, so what
  // drives it is the water standing above it and the leak crossfades to
  // vapour as the level sweeps down through the tear.
  const sim = buildSimFromFile(path.join(PLANT_DIR, 'pool-level1.json'));
  const pool = () => sim.state.flowNodes.get('pool')!;
  const clad = () => sim.state.thermalNodes.get('pool-clad')!;
  const level = () => nodeLiquidLevel(pool());
  const spec = sim.state.terrain!.spec;

  // Geometry: the floor is 12 m below the ground under it, the rim at grade
  const ground = terrainHeightAt(spec, pool().position!);
  assert(Math.abs(pool().elevation - (ground - 12)) < 1e-6,
    `pool floor should sit 12 m below its ground (${ground.toFixed(2)} m), got ${pool().elevation.toFixed(2)}`);
  assert(Math.abs((pool().height ?? 0) - 12) < 1e-6, 'pool node height should be its depth');

  // The vent must carry no standing head: an open rim faces open air at the
  // same point, so nothing drives it but the pool's own pressure.
  const vent = sim.state.flowConnections.find(c => c.id === 'flow-pool-atmosphere')!;
  assert(!!vent && sim.state.flowNodes.get(vent.toNodeId)!.isBoundary,
    'the pool vent should run to the atmosphere boundary node');
  assert(Math.abs(vent.elevation) < 1e-9, `vent should have no elevation change, got ${vent.elevation}`);

  // ---- Phase 1: heat-up before the earthquake -----------------------------
  // The first ~20 s go into establishing the fuel-to-water temperature
  // gradient (the 543 t of fuel and cladding start at the water temperature
  // and have to climb ~0.5 K before they can pass 5 MW across the film), so
  // the heating RATE is measured after that, where the fuel stores nothing
  // more and the whole rack power lands in the water.
  run(sim, 30.0, 0.05);
  const T0 = pool().fluid.temperature;
  const m0 = pool().fluid.mass;
  run(sim, 90.0, 0.05);         // t = 120 s, the moment the liner tears
  const breakFlow = () =>
    sim.state.flowConnections.find(c => c.id === 'break-pool')?.massFlowRate ?? 0;
  assert(!sim.state.flowConnections.some(c => c.id === 'break-pool'),
    'there must be no break at all before the earthquake');
  assert(!sim.state.burstStates!.get('pool')!.isBurst,
    'the pool must not be burst before the earthquake');
  const dT = pool().fluid.temperature - T0;
  const expected = 5e6 * 90.0 / (m0 * 4180);
  assert(Math.abs(dT / expected - 1) < 0.06,
    `pool should warm ${(expected * 1000).toFixed(1)} mK in 90 s at 5 MW into ` +
    `${(m0 / 1000).toFixed(0)} t, got ${(dT * 1000).toFixed(1)} mK`);
  assert(Math.abs(pool().fluid.pressure - 101325) < 2000,
    `an open pool must sit at atmospheric pressure, got ${(pool().fluid.pressure / 1e5).toFixed(4)} bar`);
  assertStateSane(sim.state, ['pool']);

  // ---- Phase 2: the crack drains it ---------------------------------------
  run(sim, 200.0, 0.05);        // t = 320 s, 200 s of leaking
  const levelHigh = level();
  const leakHigh = breakFlow();
  const bs = sim.state.burstStates!.get('pool')!;
  assert(bs.isBurst && bs.isScripted, 'the scripted burst should have opened the pool');
  assert(Math.abs((bs.breakElevation ?? 0) - (pool().elevation + 0.4)) < 1e-6,
    `the tear should sit 0.4 m up the pool wall, got ${bs.breakElevation}`);
  assert(leakHigh > 200, `a cracked liner under ~6.7 m of water should run hard, got ${leakHigh.toFixed(0)} kg/s`);
  assertBetween(levelHigh, 6.3, 7.0, 'pool level 200 s after the crack opens (m)');

  run(sim, 3800.0, 0.05);       // t = 4120 s
  const levelLow = level();
  const leakLow = breakFlow();
  assert(levelLow < 1.0, `the pool should be nearly drained by t=4000 s, level ${levelLow.toFixed(2)} m`);
  // Head above a low crack, and the crack's tall opening drawing part vapour:
  // the leak falls away steeply rather than running at full bore to the last drop
  assert(leakLow < 0.25 * leakHigh,
    `leak should collapse as the level drops: ${leakHigh.toFixed(0)} -> ${leakLow.toFixed(0)} kg/s`);
  assert(leakLow > 1, `the crack should still be running, got ${leakLow.toFixed(2)} kg/s`);

  // The racks are uncovering, so they are running hotter than the water
  assert(clad().temperature > pool().fluid.temperature,
    'uncovering racks must run above the water they no longer sit in');
  assertStateSane(sim.state, ['pool']);

  // ---- Phase 3: where the water went --------------------------------------
  // It left through a boundary connection, so it is on the ground under the
  // crack, in that cell's basin, and the ground has been drinking it.
  const leaked = m0 - pool().fluid.mass;    // kg (the vent's net is ~0)
  const stored = Array.from(sim.state.surfaceWater!.volumes.values()).reduce((s, v) => s + v, 0);
  assert(stored > 100, `the leak should have made a real puddle, got ${stored.toFixed(1)} m3`);
  assert(stored < 0.8 * (leaked / 1000),
    `open ground must have soaked up a good share of ${(leaked / 1000).toFixed(0)} m3, ` +
    `but ${stored.toFixed(0)} m3 is still standing`);

  // ---- Phase 4: make-up water ---------------------------------------------
  const levelBeforeMakeup = level();
  const mu = sim.state.components.pumps.get('mu-pump')!;
  mu.running = true;
  run(sim, 300.0, 0.05);
  assert(flowRate(sim.state, 'mu-pump', 'pool') > 10,
    `the make-up pump should deliver, got ${flowRate(sim.state, 'mu-pump', 'pool').toFixed(1)} kg/s`);
  assert(level() > levelBeforeMakeup,
    `make-up should raise the level: ${levelBeforeMakeup.toFixed(3)} -> ${level().toFixed(3)} m`);
  assertStateSane(sim.state, ['pool']);
});

test('Zircaloy fire: dry racks burn faster in air, and the fire eats its own oxygen', () => {
  // The same pool, drained before the run starts and left standing with the
  // racks already hot - the state a spent fuel pool reaches some hours after
  // it boils dry. Nothing in the model is told this is a fire; there is no
  // ignition temperature anywhere in it. The measurement is the DIFFERENCE
  // between filling that space with air and filling it with nitrogen: same
  // pool, same racks, same residual steam, so what separates them is the
  // Zr + O2 reaction and nothing else.
  //
  // Both cases burn, because a pool open to the sky is never dry of steam -
  // it draws humid air back in through its own vent as the reaction consumes
  // moles, and the boundary atmosphere is an infinite reservoir of it. That
  // is a limit of a one-node pool with one opening (see
  // docs/zircaloy-air-oxidation.md) and it does not affect what is measured
  // here, which is what the oxygen adds on top of that.
  const dryPool = (o2Bar: number, n2Bar: number) => {
    const plant = JSON.parse(fs.readFileSync(
      path.join(PLANT_DIR, 'pool-level1.json'), 'utf-8')) as {
        components: Array<[string, Record<string, unknown>]>;
        scenario?: unknown;
      };
    const pool = plant.components.find(c => c[0] === 'pool')![1];
    pool.fillLevel = 0;                  // dry: no water at all, only gas
    pool.rackTemperature = 1023.15;      // 750 C - hot, and nowhere near melting
    pool.initialNcg = { N2: n2Bar, O2: o2Bar };
    (pool.fluid as Record<string, unknown>).temperature = 373.15;
    plant.scenario = undefined;          // no earthquake; this is about the gas
    return buildSimFromPlantJson(plant as never);
  };

  const measure = (sim: ReturnType<typeof buildSimFromPlantJson>) => {
    const clad = () => sim.state.thermalNodes.get('pool-clad')!;
    const node = () => sim.state.flowNodes.get('pool')!;
    const o2Start = node().fluid.ncg!.O2;
    let peakOxPower = 0, peakClad = clad().temperature, o2Min = o2Start;
    for (let i = 0; i < 300; i++) {
      run(sim, 1, 0.02);
      sim.state.pendingEvents = [];
      peakOxPower = Math.max(peakOxPower, getCladdingOxidationPower().get('pool-clad') ?? 0);
      peakClad = Math.max(peakClad, clad().temperature);
      o2Min = Math.min(o2Min, node().fluid.ncg!.O2);
    }
    return {
      o2Start, o2Min, peakOxPower, peakClad,
      endClad: clad().temperature,
      burned: clad().oxidation!.oxidizedFraction,
      endOxPower: getCladdingOxidationPower().get('pool-clad') ?? 0,
      decay: sim.state.thermalNodes.get('pool-pellets')!.heatGeneration,
    };
  };

  const air = measure(dryPool(0.21, 0.78));
  const inert = measure(dryPool(0, 0.99));

  console.log(`      [Zr-air]   air: peak clad ${(air.peakClad - 273.15).toFixed(0)} C, ` +
    `peak oxidation ${(air.peakOxPower / 1e6).toFixed(1)} MW vs ${(air.decay / 1e6).toFixed(1)} MW decay, ` +
    `O2 ${air.o2Start.toFixed(0)} -> ${air.o2Min.toFixed(0)} mol, ` +
    `${(air.burned * 100).toFixed(2)}% of the cladding consumed`);
  console.log(`      [Zr-air] inert: peak clad ${(inert.peakClad - 273.15).toFixed(0)} C, ` +
    `peak oxidation ${(inert.peakOxPower / 1e6).toFixed(3)} MW, ` +
    `${(inert.burned * 100).toFixed(4)}% consumed`);

  assert(air.o2Start > 100, `the air case should start full of air, got ${air.o2Start.toFixed(1)} mol O2`);
  assert(air.peakOxPower > air.decay,
    `the fire must outrun the decay heat: ${(air.peakOxPower / 1e6).toFixed(2)} MW vs ` +
    `${(air.decay / 1e6).toFixed(2)} MW`);
  assert(air.o2Min < 0.5 * air.o2Start,
    `the fire must eat the oxygen it burns: ${air.o2Start.toFixed(0)} -> ${air.o2Min.toFixed(0)} mol`);
  assert(air.burned > 1.25 * Math.max(inert.burned, 1e-12),
    `air must consume measurably more cladding than an inerted pool does: ` +
    `${(air.burned * 100).toFixed(3)}% vs ${(inert.burned * 100).toFixed(4)}%`);
  // The racks run only a few K hotter than the inert case, and that is
  // correct rather than disappointing: a pool open to the sky loses the
  // reaction heat up its own vent almost as fast as it is made (23,000 m2 of
  // rod against the gas), so what the extra chemistry buys is metal
  // consumed, not degrees. Degrees come later, when the gas has been driven
  // out and there is nothing left to carry the heat away.
  assert(air.peakClad > inert.peakClad + 3,
    `the air reaction must heat the racks: ${(air.peakClad - 273.15).toFixed(1)} C vs ` +
    `${(inert.peakClad - 273.15).toFixed(1)} C inerted`);
  // The fire is its own extinguisher: once the oxygen in the pool is spent
  // the rate follows it down, with no rule anywhere saying so.
  assert(air.endOxPower < 0.5 * air.peakOxPower,
    `oxygen starvation should take the fire back down from its peak ` +
    `(${(air.peakOxPower / 1e6).toFixed(2)} MW), still at ${(air.endOxPower / 1e6).toFixed(2)} MW`);
});

report('Plant Scenario Regression Suite');
