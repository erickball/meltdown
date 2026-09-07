/**
 * Live plant edit regression test: build the plant WHILE it runs.
 *
 * Exercises exactly the code path the UI uses (src/simulation/live-edit.ts +
 * ConstructionManager - no DOM anywhere) and asserts the contract:
 *
 *   - every component the edit did not touch keeps its live state, by OBJECT
 *     IDENTITY (not "close enough")
 *   - simulated time is unchanged across the rebuild
 *   - a new component starts from its factory initial conditions
 *   - a new connection starts at zero flow, existing ones keep their momentum
 *   - the rebuilt state integrates for another N seconds without throwing
 *   - deleting the added component (and its connection) does the same in
 *     reverse
 *
 * Usage: npx tsx scripts/test-live-edit.ts [plant.json] [runSeconds]
 */

import * as fs from 'fs';
import {
  createSimulationFromPlant, setSimulationRandomSeed, RK45Solver,
  ConductionRateOperator, ConvectionRateOperator, CladdingOxidationRateOperator,
  HydrogenCombustionRateOperator, CoriumRelocationRateOperator, McciRateOperator,
  FissionProductReleaseOperator, HeatGenerationRateOperator, NeutronicsRateOperator,
  FlowRateOperator, FlowMomentumRateOperator, TurbineCondenserRateOperator,
  FluidStateConstraintOperator, FlowDynamicsConstraintOperator, PumpSpeedRateOperator,
  SurfaceWaterRateOperator, SurfaceWaterConstraintOperator,
  BurstCheckOperator, ControlSystemOperator,
  applyLivePlantEdit,
} from '../src/simulation';
import type { SimulationState } from '../src/simulation/types';
import type { PlantState, PlantComponent, Connection } from '../src/types';
import { ConstructionManager } from '../src/construction/construction-manager';

const plantFile = process.argv[2] || 'scripts/test-plants/two-loop-pwr.json';
const runSeconds = parseFloat(process.argv[3] || '5');

function loadPlant(): PlantState {
  const data = JSON.parse(fs.readFileSync(plantFile, 'utf-8'));
  const plant: PlantState = {
    components: new Map<string, PlantComponent>(),
    connections: (data.connections || []) as Connection[],
    simTime: 0, simSpeed: 1, isPaused: true,
  } as PlantState;
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
  solver.addRateOperator(new SurfaceWaterRateOperator());
  solver.addConstraintOperator(new FlowDynamicsConstraintOperator());
  solver.addConstraintOperator(new FluidStateConstraintOperator());
  solver.addConstraintOperator(new BurstCheckOperator());
  solver.addConstraintOperator(new ControlSystemOperator());
  solver.addConstraintOperator(new SurfaceWaterConstraintOperator());
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

/**
 * Every node/thermal node/controller present BEFORE the edit and still owned
 * by an untouched component must be the very same object afterwards.
 */
function checkUntouchedCarriedOver(
  before: SimulationState, after: SimulationState, ignoreOwners: string[]
): void {
  const owned = (id: string) => ignoreOwners.some(o => id === o || id.startsWith(o + '-'));

  let nodes = 0, nodeFails = 0;
  for (const [id, node] of before.flowNodes) {
    if (owned(id)) continue;
    nodes++;
    const now = after.flowNodes.get(id);
    if (now !== node) {
      nodeFails++;
      if (nodeFails <= 5) {
        console.error(`    node '${id}' ${now ? 'was re-initialized' : 'disappeared'}`);
      }
    }
  }
  check(`all ${nodes} untouched flow nodes are the same objects`, nodeFails === 0,
    `${nodeFails} differ`);

  let thermal = 0, thermalFails = 0;
  for (const [id, node] of before.thermalNodes) {
    if (owned(id)) continue;
    thermal++;
    if (after.thermalNodes.get(id) !== node) thermalFails++;
  }
  check(`all ${thermal} untouched thermal nodes are the same objects`, thermalFails === 0,
    `${thermalFails} differ`);

  check('neutronics carried over', after.neutronics === before.neutronics);

  let flows = 0, flowFails = 0;
  for (const conn of before.flowConnections) {
    if (owned(conn.fromNodeId) || owned(conn.toNodeId)) continue;
    const now = after.flowConnections.find(c => c.id === conn.id);
    if (!now) continue;
    flows++;
    if (now.massFlowRate !== conn.massFlowRate) {
      flowFails++;
      if (flowFails <= 5) {
        console.error(`    connection '${conn.id}' flow ${now.massFlowRate} vs ${conn.massFlowRate}`);
      }
    }
  }
  check(`all ${flows} untouched connection flows carried over`, flowFails === 0,
    `${flowFails} differ`);
}

console.log(`\n=== Live plant edit test: ${plantFile}, ${runSeconds}s per leg ===\n`);

// ConstructionManager clears the plant it is handed (main.ts builds it before
// any design is loaded), so it has to exist before the plant is filled in.
const plant: PlantState = {
  components: new Map<string, PlantComponent>(), connections: [],
  simTime: 0, simSpeed: 1, isPaused: true,
} as PlantState;
const construction = new ConstructionManager(plant);
const loaded = loadPlant();
for (const [id, component] of loaded.components) plant.components.set(id, component);
plant.connections.push(...loaded.connections);

// --- Run the plant for a while -------------------------------------------
setSimulationRandomSeed(0);
let live = createSimulationFromPlant(plant);
live = advance(live, runSeconds);
const timeAtFirstEdit = live.time;
console.log(`[Setup] running at t=${timeAtFirstEdit.toFixed(3)} s with ` +
  `${live.flowNodes.size} flow nodes\n`);

// Pick an existing component with a free-ish port to hang the new tank off.
// The containment building is the quietest neighbour: same pressure scale, no
// pipe-inventory lumping, and nothing else uses its ports.
const anchorPortId = 'bui-1-north';
const anchorExists = [...plant.components.values()]
  .some(c => c.ports?.some(p => p.id === anchorPortId));
check(`anchor port '${anchorPortId}' exists in this plant`, anchorExists);
if (!anchorExists) process.exit(1);

// --- Edit 1: place a tank and pipe it to a node that is already running ---
console.log('\n--- Edit 1: add a tank + a connection while the plant runs ---');
let newTankId: string | null = null;
const before1 = live;

setSimulationRandomSeed(0);
const edit1 = applyLivePlantEdit(live, plant, () => {
  newTankId = construction.createComponent({
    type: 'tank',
    name: 'Live Tank',
    position: { x: 60, y: 60 },
    properties: {
      name: 'Live Tank',
      volume: 10,
      height: 3,
      initialLevel: 50,          // %
      initialTemperature: 25,    // degC
      initialPressure: 1,        // bar
      elevation: 0,
      pressureRating: 10,
    },
  });
  if (!newTankId) throw new Error('createComponent returned null');
  const ok = construction.createConnection(
    `${newTankId}-bottom`, anchorPortId,
    undefined, undefined,
    0.002,  // m^2 - a small drain line
    5);     // m
  if (!ok) throw new Error('createConnection failed');
});
console.log(`[Notes] ${edit1.notes.join('; ')}`);

const afterAdd = edit1.state;
check('simulated time unchanged by the rebuild',
  afterAdd.time === timeAtFirstEdit, `${afterAdd.time} vs ${timeAtFirstEdit}`);
checkUntouchedCarriedOver(before1, afterAdd, [newTankId!]);

const tankNode = afterAdd.flowNodes.get(newTankId!);
check(`new node '${newTankId}' exists`, tankNode !== undefined);

// Factory initial conditions: identical to what a from-scratch build of this
// same plant produces for the new tank
setSimulationRandomSeed(0);
const referenceBuild = createSimulationFromPlant(plant);
const refTank = referenceBuild.flowNodes.get(newTankId!);
if (tankNode && refTank) {
  check('new node carries factory initial conditions (mass)',
    tankNode.fluid.mass === refTank.fluid.mass,
    `${tankNode.fluid.mass} vs ${refTank.fluid.mass}`);
  check('new node carries factory initial conditions (internal energy)',
    tankNode.fluid.internalEnergy === refTank.fluid.internalEnergy,
    `${tankNode.fluid.internalEnergy} vs ${refTank.fluid.internalEnergy}`);
  check('new node carries factory initial conditions (volume)',
    tankNode.volume === refTank.volume, `${tankNode.volume} vs ${refTank.volume}`);
}

const newConns = afterAdd.flowConnections.filter(
  c => c.fromNodeId === newTankId || c.toNodeId === newTankId);
check('the new connection is in the rebuilt simulation', newConns.length === 1,
  `found ${newConns.length}`);
check('the new connection starts at zero flow',
  newConns.every(c => c.massFlowRate === 0),
  newConns.map(c => `${c.id}=${c.massFlowRate}`).join(', '));

let afterAddRun: SimulationState = afterAdd;
try {
  afterAddRun = advance(afterAdd, runSeconds);
  check(`edited plant integrates another ${runSeconds} s`,
    afterAddRun.time >= timeAtFirstEdit + runSeconds);
} catch (e) {
  check(`edited plant integrates another ${runSeconds} s`, false, String(e));
}

// --- Edit 2: delete the tank again ---------------------------------------
console.log('\n--- Edit 2: delete that tank while the plant runs ---');
const timeAtSecondEdit = afterAddRun.time;
const before2 = afterAddRun;

setSimulationRandomSeed(0);
const edit2 = applyLivePlantEdit(afterAddRun, plant, () => {
  if (!construction.deleteComponent(newTankId!)) {
    throw new Error(`deleteComponent('${newTankId}') returned false`);
  }
});
console.log(`[Notes] ${edit2.notes.join('; ')}`);

const afterDelete = edit2.state;
check('simulated time unchanged by the second rebuild',
  afterDelete.time === timeAtSecondEdit, `${afterDelete.time} vs ${timeAtSecondEdit}`);
check('the deleted tank is gone from the simulation',
  !afterDelete.flowNodes.has(newTankId!));
check('the deleted tank\'s connection is gone',
  !afterDelete.flowConnections.some(c => c.fromNodeId === newTankId || c.toNodeId === newTankId));
check('the deleted tank is gone from the plant', !plant.components.has(newTankId!));
checkUntouchedCarriedOver(before2, afterDelete, [newTankId!]);

try {
  const finalState = advance(afterDelete, runSeconds);
  check(`plant integrates another ${runSeconds} s after the deletion`,
    finalState.time >= timeAtSecondEdit + runSeconds);
} catch (e) {
  check(`plant integrates another ${runSeconds} s after the deletion`, false, String(e));
}

// --- A failed edit must leave the plant exactly as it was ----------------
// (main.ts keeps running the pre-edit simulation when this happens, so the
// plant on screen must go back to describing it.)
console.log('\n--- A rebuild that throws reverts the plant ---');
const controllerId = [...plant.components.keys()].find(
  id => (plant.components.get(id) as Record<string, any>).pid?.actuator?.targetId);
check('found a PID controller to break', controllerId !== undefined);
const componentsBefore = plant.components.size;
const connectionsBefore = plant.connections.length;
const targetBefore = controllerId
  ? (plant.components.get(controllerId) as Record<string, any>).pid.actuator.targetId
  : null;
let threw = false;
if (controllerId) {
  try {
    applyLivePlantEdit(afterDelete, plant, () => {
      // Point the controller at an actuator that does not exist: the factory
      // refuses to wire the plant and throws
      (plant.components.get(controllerId) as Record<string, any>)
        .pid.actuator.targetId = 'no-such-pump';
    });
  } catch {
    threw = true;
  }
}
check('a rebuild that cannot be built throws', threw);
check('the plant is back to its pre-edit component count',
  plant.components.size === componentsBefore,
  `${plant.components.size} vs ${componentsBefore}`);
check('the plant is back to its pre-edit connection count',
  plant.connections.length === connectionsBefore,
  `${plant.connections.length} vs ${connectionsBefore}`);
check('the broken edit was undone in the plant',
  controllerId !== undefined &&
  (plant.components.get(controllerId) as Record<string, any>).pid.actuator.targetId === targetBefore,
  `${controllerId ? (plant.components.get(controllerId) as Record<string, any>).pid.actuator.targetId : '?'} vs ${targetBefore}`);
check('the reverted plant still builds',
  (() => { try { createSimulationFromPlant(plant); return true; } catch { return false; } })());

console.log(failures === 0
  ? '\n=== ALL PASS ===\n'
  : `\n=== ${failures} FAILURE(S) ===\n`);
process.exit(failures === 0 ? 0 : 1);
