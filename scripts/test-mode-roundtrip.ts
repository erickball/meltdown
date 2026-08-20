/**
 * Mode-switch resume regression test.
 *
 * Replicates the construction <-> simulation round trip main.ts performs:
 *   1. build sim from plant, run it for a few seconds
 *   2. enter construction mode: writeSimulationStateToPlant + captureResumeSnapshot
 *   3. re-enter simulation mode: createSimulationFromPlant + transplantSimulationState
 * and asserts:
 *   - with NO edits, every flow node / thermal node / controller resumes as
 *     the exact saved object, time carries over, flows carry over
 *   - with an edit, the edited component re-initializes and everything else
 *     still resumes exactly
 *   - the resumed state integrates (1 s advance, no throw)
 *
 * Usage: npx tsx scripts/test-mode-roundtrip.ts [plant.json] [runSeconds]
 */

import * as fs from 'fs';
import {
  createSimulationFromPlant, setSimulationRandomSeed, RK45Solver,
  ConductionRateOperator, ConvectionRateOperator, CladdingOxidationRateOperator,
  HydrogenCombustionRateOperator, CoriumRelocationRateOperator, McciRateOperator,
  FissionProductReleaseOperator, HeatGenerationRateOperator, NeutronicsRateOperator,
  FlowRateOperator, FlowMomentumRateOperator, TurbineCondenserRateOperator,
  FluidStateConstraintOperator, FlowDynamicsConstraintOperator, PumpSpeedRateOperator,
  BurstCheckOperator, ControlSystemOperator,
  writeSimulationStateToPlant, captureResumeSnapshot, transplantSimulationState,
} from '../src/simulation';
import type { SimulationState } from '../src/simulation/types';
import type { PlantState, PlantComponent, PlantConnection } from '../src/types';

const plantFile = process.argv[2] || 'scripts/pwr-test.json';
const runSeconds = parseFloat(process.argv[3] || '5');

function loadPlant(): PlantState {
  const data = JSON.parse(fs.readFileSync(plantFile, 'utf-8'));
  const plant: PlantState = {
    components: new Map<string, PlantComponent>(),
    connections: (data.connections || []) as PlantConnection[],
  };
  for (const [id, component] of data.components) plant.components.set(id, component);
  return plant;
}

function makeSolver(): RK45Solver {
  const solver = new RK45Solver({});
  solver.addRateOperator(new FlowRateOperator());
  solver.addRateOperator(new FlowMomentumRateOperator());
  solver.addRateOperator(new ConductionRateOperator());
  solver.addRateOperator(new ConvectionRateOperator());
  solver.addRateOperator(new CladdingOxidationRateOperator());
  solver.addRateOperator(new HydrogenCombustionRateOperator());
  solver.addRateOperator(new CoriumRelocationRateOperator());
  solver.addRateOperator(new McciRateOperator());
  solver.addRateOperator(new FissionProductReleaseOperator());
  solver.addRateOperator(new HeatGenerationRateOperator());
  solver.addRateOperator(new NeutronicsRateOperator());
  solver.addRateOperator(new TurbineCondenserRateOperator());
  solver.addRateOperator(new PumpSpeedRateOperator());
  solver.addConstraintOperator(new FlowDynamicsConstraintOperator());
  solver.addConstraintOperator(new FluidStateConstraintOperator());
  solver.addConstraintOperator(new BurstCheckOperator());
  solver.addConstraintOperator(new ControlSystemOperator());
  return solver;
}

function advance(sim: SimulationState, seconds: number): SimulationState {
  const solver = makeSolver();
  const target = sim.time + seconds;
  let state = sim;
  while (state.time < target) {
    state = solver.advance(state, 0.02).state;
  }
  return state;
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

console.log(`\n=== Mode round-trip test: ${plantFile}, ${runSeconds}s run ===\n`);
const plant = loadPlant();

// 1. Enter simulation mode and run
setSimulationRandomSeed(0);
let live = createSimulationFromPlant(plant);
live = advance(live, runSeconds);

// 2. Enter construction mode
writeSimulationStateToPlant(live, plant);
setSimulationRandomSeed(0);
const snapshot = captureResumeSnapshot(live, plant);

// 3a. Re-enter simulation mode with NO edits
setSimulationRandomSeed(0);
const resumedNoEdit = createSimulationFromPlant(plant);
const notes = transplantSimulationState(resumedNoEdit, snapshot, plant);
console.log(`[Resume notes] ${notes.join('; ')}\n`);

console.log('--- No edits: exact resume ---');
check('time carried over', resumedNoEdit.time === live.time,
  `${resumedNoEdit.time} vs ${live.time}`);
let allNodesExact = true;
for (const [id, node] of resumedNoEdit.flowNodes) {
  if (node !== live.flowNodes.get(id)) {
    allNodesExact = false;
    console.error(`    node '${id}' was re-initialized instead of resumed`);
  }
}
check(`all ${resumedNoEdit.flowNodes.size} flow nodes resumed exactly`, allNodesExact);
let allThermalExact = true;
for (const [id, node] of resumedNoEdit.thermalNodes) {
  if (node !== live.thermalNodes.get(id)) {
    allThermalExact = false;
    console.error(`    thermal node '${id}' was re-initialized instead of resumed`);
  }
}
check(`all ${resumedNoEdit.thermalNodes.size} thermal nodes resumed exactly`, allThermalExact);
check('neutronics resumed exactly', resumedNoEdit.neutronics === live.neutronics);
let flowsExact = true;
for (const conn of resumedNoEdit.flowConnections) {
  const savedConn = live.flowConnections.find(c => c.id === conn.id);
  if (savedConn && conn.massFlowRate !== savedConn.massFlowRate) {
    flowsExact = false;
    console.error(`    connection '${conn.id}' flow ${conn.massFlowRate} vs saved ${savedConn.massFlowRate}`);
  }
}
check(`all ${resumedNoEdit.flowConnections.length} connection flows carried over`, flowsExact);

// The resumed state must actually integrate
try {
  const after = advance(resumedNoEdit, 1);
  check('resumed state integrates 1 s without error', after.time > live.time);
} catch (e) {
  check('resumed state integrates 1 s without error', false, String(e));
}

// 3b. Re-enter simulation mode WITH an edit: pick a tank (or any component
// with a fluid) and change its fill level / temperature
console.log('\n--- One edit: edited component re-initializes, rest resumes ---');
let editedId: string | null = null;
for (const [id, component] of plant.components) {
  const c = component as Record<string, any>;
  if (c.type === 'tank' && c.fillLevel !== undefined) {
    c.fillLevel = Math.max(0.05, Math.min(0.95, c.fillLevel * 0.8));
    editedId = id;
    break;
  }
}
if (!editedId) {
  for (const [id, component] of plant.components) {
    const c = component as Record<string, any>;
    if (c.fluid?.temperature !== undefined) {
      c.fluid.temperature += 5;
      editedId = id;
      break;
    }
  }
}
check('found a component to edit', editedId !== null);

if (editedId) {
  setSimulationRandomSeed(0);
  const resumedEdited = createSimulationFromPlant(plant);
  const notes2 = transplantSimulationState(resumedEdited, snapshot, plant);
  console.log(`[Resume notes] ${notes2.join('; ')}`);

  check(`edited '${editedId}' re-initialized`,
    resumedEdited.flowNodes.get(editedId!) !== live.flowNodes.get(editedId!));
  let othersExact = true;
  for (const [id, node] of resumedEdited.flowNodes) {
    if (id === editedId) continue;
    // Nodes owned by the edited component (e.g. its -shell) also re-init
    if (id.startsWith(editedId + '-')) continue;
    if (node !== live.flowNodes.get(id)) {
      othersExact = false;
      console.error(`    node '${id}' was re-initialized but '${editedId}' was the only edit`);
    }
  }
  check('all other nodes still resumed exactly', othersExact);

  try {
    const after = advance(resumedEdited, 1);
    check('edited-resume state integrates 1 s without error', after.time > live.time);
  } catch (e) {
    check('edited-resume state integrates 1 s without error', false, String(e));
  }
}

// 3c. Edit a turbine: its design point must survive (it is frozen at first
// sim start), and it must resume near the LIVE conditions the write-back
// stored in inletFluid - not as casing-full design-pressure steam
const turbineId = [...plant.components.entries()]
  .find(([, comp]) => (comp as Record<string, any>).type === 'turbine-generator')?.[0];
if (turbineId) {
  console.log('\n--- Turbine edit: design point sticky, state near-live ---');
  const tc = plant.components.get(turbineId) as Record<string, any>;
  tc.governorValve = Math.max(0, Math.min(1, (tc.governorValve ?? 1) * 0.9 - 0.01));

  setSimulationRandomSeed(0);
  const resumedTurbEdit = createSimulationFromPlant(plant);
  transplantSimulationState(resumedTurbEdit, snapshot, plant);

  const liveTurb = live.flowNodes.get(turbineId)!;
  const rebuiltTurb = resumedTurbEdit.flowNodes.get(turbineId)!;
  check('edited turbine re-initialized', rebuiltTurb !== liveTurb);
  check('design inlet pressure survived the live write-back',
    rebuiltTurb.designInletPressure === liveTurb.designInletPressure,
    `${rebuiltTurb.designInletPressure} vs ${liveTurb.designInletPressure}`);
  const dMass = Math.abs(rebuiltTurb.fluid.mass - liveTurb.fluid.mass) / liveTurb.fluid.mass;
  check('edited turbine resumes near live inventory (not design steam)', dMass < 0.02,
    `mass ${rebuiltTurb.fluid.mass.toFixed(1)} vs live ${liveTurb.fluid.mass.toFixed(1)} kg (${(dMass * 100).toFixed(1)}%)`);
} else {
  console.log('\n(no turbine-generator in this plant - design-point scenario skipped)');
}

console.log(failures === 0
  ? '\n=== ALL PASS ===\n'
  : `\n=== ${failures} FAILURE(S) ===\n`);
process.exit(failures === 0 ? 0 : 1);
