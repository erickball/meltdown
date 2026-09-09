/**
 * Build-queue regression test.
 *
 * Drives the same objects main.ts drives - ConstructionManager for the plant
 * change, src/game/stock.ts for the yard, BuildQueue for the clock, and the
 * factory for what the simulation is actually built out of - with no DOM
 * anywhere, and asserts the contract in docs/build-queue.md:
 *
 *   - the rate is the one stated: 6 simulated seconds per metre of the
 *     level's service-water line (0.1 s of the player's own time at the 60x
 *     the level runs at), and everything else follows from mass
 *   - stock is charged ONCE, at the start of a build
 *   - a part under construction is in the plant but NOT in the simulation
 *   - the part joins the simulation exactly once, when the timer completes,
 *     and the completion callback runs exactly once
 *   - ticking past the end does not run it again
 *   - cancelling refunds immediately and takes the part back out
 *   - a return keeps the part running until its timer completes, and refunds
 *     at the end
 *   - the queue moves on SIMULATED time: it is told an absolute clock, so
 *     rewinding the run past a job's start abandons and refunds it
 *
 * Usage: npx tsx scripts/test-build-queue.ts
 */

import { ConstructionManager } from '../src/construction/construction-manager';
import { componentsRemaining, pipeMetersRemaining, findWarehouse } from '../src/game/stock';
import {
  BuildQueue, Buildable, componentBuildMassKg, connectionBuildMassKg,
  SIM_SECONDS_PER_KG,
} from '../src/game/build-queue';
import { pipeSteelMassPerMetre } from '../src/construction/cost-estimation';
import { createSimulationFromPlant } from '../src/simulation/factory';
import type { PlantState, PlantComponent, Connection } from '../src/types';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

function emptyPlant(): PlantState {
  return {
    components: new Map<string, PlantComponent>(), connections: [],
    simTime: 0, simSpeed: 1, isPaused: true,
  } as PlantState;
}

/** A minimal plant that builds: one tank of water, and a yard. */
function plantWithYard(): { plant: PlantState; cm: ConstructionManager } {
  const plant = emptyPlant();
  const cm = new ConstructionManager(plant);
  cm.createComponent({
    type: 'tank', name: 'Tank A', position: { x: 0, y: 0 },
    properties: {
      name: 'Tank A', volume: 200, height: 6, initialLevel: 60,
      initialTemperature: 25, initialPressure: 1, elevation: 0, pressureRating: 10,
    },
  });
  cm.createComponent({
    type: 'tank', name: 'Tank B', position: { x: 40, y: 0 },
    properties: {
      name: 'Tank B', volume: 200, height: 6, initialLevel: 20,
      initialTemperature: 25, initialPressure: 1, elevation: 0, pressureRating: 10,
    },
  });
  cm.createComponent({
    type: 'warehouse', name: 'Yard', position: { x: 20, y: 30 },
    properties: {
      name: 'Yard', width: 6, depth: 4,
      stockPipeMeters: 300,
      stockLines: [{ type: 'pump', count: 2 }],
    },
  });
  return { plant, cm };
}

const PUMP_PROPS = { name: 'Pump', ratedFlow: 200, ratedHead: 60, elevation: 0 };

console.log('\n=== Build queue ===\n');

// ---------------------------------------------------------------------------
// 1. The rate is the stated one
// ---------------------------------------------------------------------------
console.log('--- The law: 6 simulated seconds per metre of the service-water line ---');
{
  const kgPerM = pipeSteelMassPerMetre(0.3, 16);
  check('12" service-water pipe weighs ~27 kg/m', kgPerM > 26 && kgPerM < 28,
    `${kgPerM.toFixed(2)} kg/m`);
  check('one metre of it takes 6 simulated seconds',
    near(kgPerM * SIM_SECONDS_PER_KG, 6, 1e-12),
    `${(kgPerM * SIM_SECONDS_PER_KG).toFixed(6)} s`);
  check('which is 0.1 s of the player\'s own time at the level\'s 60x',
    near(kgPerM * SIM_SECONDS_PER_KG / 60, 0.1, 1e-12),
    `${(kgPerM * SIM_SECONDS_PER_KG / 60).toFixed(6)} s`);
  check('the rate is 0.223 s/kg (4.48 kg a simulated second)',
    near(SIM_SECONDS_PER_KG, 0.2230, 1e-4),
    `${SIM_SECONDS_PER_KG.toFixed(5)} s/kg`);

  // A yard pump lands in the seconds, not the minutes: the whole point of
  // deriving from mass rather than from cost.
  const { plant, cm } = plantWithYard();
  const id = cm.createComponent({
    type: 'pump', name: 'P', position: { x: 20, y: 0 }, properties: { ...PUMP_PROPS },
  })!;
  const mass = componentBuildMassKg(plant.components.get(id)!);
  const secs = mass * SIM_SECONDS_PER_KG;
  check('a 200 kg/s, 60 m service pump is 2-4 t', mass > 2000 && mass < 4000,
    `${Math.round(mass)} kg`);
  check('so it takes 5-20 minutes of plant time to install',
    secs > 300 && secs < 1200, `${(secs / 60).toFixed(1)} min`);
}

// ---------------------------------------------------------------------------
// 2. A build: charged once, invisible to the simulation, lands exactly once
// ---------------------------------------------------------------------------
console.log('\n--- A build is charged at the start and lands at the end ---');
{
  const { plant, cm } = plantWithYard();
  const queue = new BuildQueue();

  const nodesBefore = createSimulationFromPlant(plant).flowNodes.size;
  check('the yard holds two pumps', componentsRemaining(plant, 'pump') === 2);

  // What main.ts does: create (which charges), then hold it as a ghost.
  const before = new Set(plant.components.keys());
  const pumpId = cm.createComponent({
    type: 'pump', name: 'Make-up Pump', position: { x: 20, y: 0 },
    properties: { ...PUMP_PROPS },
  })!;
  const pump = plant.components.get(pumpId)!;
  const isNew = [...plant.components.keys()].filter(k => !before.has(k));
  check('exactly one component was created', isNew.length === 1, `${isNew.length}`);
  check('the yard was charged once', componentsRemaining(plant, 'pump') === 1,
    `${componentsRemaining(plant, 'pump')} left`);

  let finished = 0;
  let abandoned = 0;
  const job = queue.enqueue({
    kind: 'build',
    label: 'Make-up Pump',
    massKg: componentBuildMassKg(pump),
    targets: [pump as Buildable],
    finish: (apply) => { apply(); finished++; },
    abandon: (apply) => { apply(); abandoned++; },
  });
  check('the job has a positive duration', job.simSeconds > 0, `${job.simSeconds}`);
  check('and it was ordered at the queue\'s current sim time', job.startedAt === 0,
    `${job.startedAt}`);
  check('the pump is marked under construction',
    (pump as Buildable).underConstruction === true);
  check('the pump is in the PLANT', plant.components.has(pumpId));
  check('the pump is NOT in the simulation',
    createSimulationFromPlant(plant).flowNodes.size === nodesBefore,
    `${createSimulationFromPlant(plant).flowNodes.size} vs ${nodesBefore}`);

  queue.tick(job.simSeconds * 0.4);
  check('progress tracks the simulated clock',
    near((pump as Buildable).buildProgress ?? -1, 0.4, 1e-9),
    `${(pump as Buildable).buildProgress}`);
  check('nothing has landed yet', finished === 0);
  check('still out of the simulation halfway through',
    createSimulationFromPlant(plant).flowNodes.size === nodesBefore);

  queue.tick(job.simSeconds + 1e-9);
  check('the build finished exactly once', finished === 1, `${finished}`);
  check('and was never abandoned', abandoned === 0);
  check('the ghost marks are gone',
    (pump as Buildable).underConstruction === undefined &&
    (pump as Buildable).buildProgress === undefined);

  const after = createSimulationFromPlant(plant);
  check('the pump is in the simulation now', after.components.pumps.has(pumpId));
  check('it appears exactly once', after.flowNodes.size === nodesBefore + 1,
    `${after.flowNodes.size} vs ${nodesBefore + 1}`);
  check('the yard was not charged again', componentsRemaining(plant, 'pump') === 1);

  queue.tick(job.simSeconds + 1000);
  check('ticking past the end does not run it again', finished === 1, `${finished}`);
  check('the queue is empty', queue.jobs.length === 0);
}

// ---------------------------------------------------------------------------
// 3. Cancelling refunds immediately
// ---------------------------------------------------------------------------
console.log('\n--- Cancelling a build in progress refunds at once ---');
{
  const { plant, cm } = plantWithYard();
  const queue = new BuildQueue();
  const nodesBefore = createSimulationFromPlant(plant).flowNodes.size;

  const pumpId = cm.createComponent({
    type: 'pump', name: 'Doomed Pump', position: { x: 20, y: 0 },
    properties: { ...PUMP_PROPS },
  })!;
  const pump = plant.components.get(pumpId)!;
  check('charged on placement', componentsRemaining(plant, 'pump') === 1);

  let finished = 0;
  const job = queue.enqueue({
    kind: 'build',
    label: 'Doomed Pump',
    massKg: componentBuildMassKg(pump),
    targets: [pump as Buildable],
    finish: (apply) => { apply(); finished++; },
    abandon: (apply) => { apply(); cm.deleteComponent(pumpId); },
  });
  queue.tick(job.simSeconds * 0.5);
  check('the cancel is accepted', queue.cancel(job.id));
  check('the part is out of the plant', !plant.components.has(pumpId));
  check('the yard has it back', componentsRemaining(plant, 'pump') === 2,
    `${componentsRemaining(plant, 'pump')}`);
  check('it never landed', finished === 0);
  check('the simulation is as it was',
    createSimulationFromPlant(plant).flowNodes.size === nodesBefore);
  queue.tick(1000);
  check('a cancelled job never completes later', finished === 0);
}

// ---------------------------------------------------------------------------
// 4. A connection is held the same way, and costs its pipe
// ---------------------------------------------------------------------------
console.log('\n--- A run of pipe is held as a ghost, and so is its node count ---');
{
  const { plant, cm } = plantWithYard();
  const queue = new BuildQueue();
  const nodesBefore = createSimulationFromPlant(plant).flowNodes.size;
  const connsBefore = createSimulationFromPlant(plant).flowConnections.length;

  const from = [...plant.components.values()].find(c => c.label === 'Tank A')!;
  const to = [...plant.components.values()].find(c => c.label === 'Tank B')!;
  const pipeBefore = pipeMetersRemaining(plant)!;
  const ok = cm.createConnection(
    `${from.id}-right`, `${to.id}-left`, 3, 3, 0.0707, 40);
  check('the run is created', ok);
  const conn = plant.connections[plant.connections.length - 1] as Connection;
  check('40 m of pipe was charged once', near(pipeMetersRemaining(plant)!, pipeBefore - 40),
    `${pipeMetersRemaining(plant)} left of ${pipeBefore}`);

  const massKg = connectionBuildMassKg(conn);
  check('a 40 m run of 0.3 m pipe weighs ~1.1 t', massKg > 900 && massKg < 1300,
    `${Math.round(massKg)} kg`);

  let finished = 0;
  const job = queue.enqueue({
    kind: 'build', label: 'the run', massKg,
    targets: [conn as unknown as Buildable],
    finish: (apply) => { apply(); finished++; },
    abandon: (apply) => apply(),
  });
  check('a 40 m run takes ~4 minutes of plant time',
    job.simSeconds > 180 && job.simSeconds < 300, `${job.simSeconds.toFixed(1)} s`);
  const ghosted = createSimulationFromPlant(plant);
  check('the ghost run carries nothing',
    ghosted.flowConnections.length === connsBefore &&
    ghosted.flowNodes.size === nodesBefore);
  queue.tick(job.simSeconds);
  check('it lands once', finished === 1);
  check('and the simulation has it',
    createSimulationFromPlant(plant).flowConnections.length === connsBefore + 1);
}

// ---------------------------------------------------------------------------
// 5. A return keeps running until its timer is up, then refunds
// ---------------------------------------------------------------------------
console.log('\n--- A return runs until it is out, then refunds ---');
{
  const { plant, cm } = plantWithYard();
  const queue = new BuildQueue();
  const pumpId = cm.createComponent({
    type: 'pump', name: 'Returned Pump', position: { x: 20, y: 0 },
    properties: { ...PUMP_PROPS },
  })!;
  const pump = plant.components.get(pumpId)!;
  check('charged when it was built', componentsRemaining(plant, 'pump') === 1);
  const withPump = createSimulationFromPlant(plant).flowNodes.size;

  let done = 0;
  const job = queue.enqueue({
    kind: 'return',
    label: 'Returned Pump',
    massKg: componentBuildMassKg(pump),
    targets: [pump as Buildable],
    finish: (apply) => { apply(); cm.deleteComponent(pumpId); done++; },
    abandon: (apply) => apply(),
  });
  check('it is marked for removal', (pump as Buildable).pendingRemoval === true);
  queue.tick(job.simSeconds * 0.5);
  check('it is still in the simulation while it comes out',
    createSimulationFromPlant(plant).flowNodes.size === withPump);
  check('and the yard has not been credited yet',
    componentsRemaining(plant, 'pump') === 1);
  queue.tick(job.simSeconds + 1e-9);
  check('the removal happened once', done === 1, `${done}`);
  check('the part is gone', !plant.components.has(pumpId));
  check('the yard was refunded at the end', componentsRemaining(plant, 'pump') === 2);
  check('a return takes the same time as the build',
    near(job.simSeconds, componentBuildMassKg(pump) * SIM_SECONDS_PER_KG, 1e-9));
}

// ---------------------------------------------------------------------------
// 6. Entering construction mode finishes the outstanding work
// ---------------------------------------------------------------------------
console.log('\n--- Stopping the plant finishes what is outstanding ---');
{
  const { plant, cm } = plantWithYard();
  const queue = new BuildQueue();
  const ids = ['A', 'B'].map((n, i) => cm.createComponent({
    type: 'pump', name: `Pump ${n}`, position: { x: 20 + 5 * i, y: 0 },
    properties: { ...PUMP_PROPS },
  })!);
  let finished = 0;
  for (const id of ids) {
    const c = plant.components.get(id)!;
    queue.enqueue({
      kind: 'build', label: id, massKg: componentBuildMassKg(c),
      targets: [c as Buildable],
      finish: (apply) => { apply(); finished++; },
      abandon: (apply) => apply(),
    });
  }
  check('two jobs are outstanding', queue.jobs.length === 2);
  queue.finishAll();
  check('both finished', finished === 2, `${finished}`);
  check('the queue is empty', queue.jobs.length === 0);
  check('both are in the simulation',
    ids.every(id => createSimulationFromPlant(plant).components.pumps.has(id)));
}

// ---------------------------------------------------------------------------
// 7. The clock is the PLANT's, and it can run backwards
// ---------------------------------------------------------------------------
console.log('\n--- The queue runs on simulated time, and a rewind undoes it ---');
{
  const { plant, cm } = plantWithYard();
  const queue = new BuildQueue();

  // The plant has been running a while before anything is ordered.
  queue.tick(5000);
  check('the queue holds the plant clock', near(queue.time, 5000));

  const pumpId = cm.createComponent({
    type: 'pump', name: 'Late Pump', position: { x: 20, y: 0 },
    properties: { ...PUMP_PROPS },
  })!;
  const pump = plant.components.get(pumpId)!;
  let finished = 0, abandoned = 0;
  const job = queue.enqueue({
    kind: 'build', label: 'Late Pump', massKg: componentBuildMassKg(pump),
    targets: [pump as Buildable],
    finish: (apply) => { apply(); finished++; },
    abandon: (apply) => { apply(); cm.deleteComponent(pumpId); abandoned++; },
  });
  check('the job starts at the plant clock, not at zero', near(job.startedAt, 5000),
    `${job.startedAt}`);
  check('the yard was charged', componentsRemaining(plant, 'pump') === 1);

  // A tick with no time in it is not progress: the plant paused.
  queue.tick(5000);
  check('a paused plant makes no progress',
    near((pump as Buildable).buildProgress ?? -1, 0), `${(pump as Buildable).buildProgress}`);

  queue.tick(5000 + job.simSeconds * 0.75);
  check('progress is simTime - startedAt',
    near((pump as Buildable).buildProgress ?? -1, 0.75, 1e-9),
    `${(pump as Buildable).buildProgress}`);

  // Seek back inside the job: the ring runs backwards, the job stands.
  queue.tick(5000 + job.simSeconds * 0.25);
  check('a seek back inside the job rewinds the ring',
    near((pump as Buildable).buildProgress ?? -1, 0.25, 1e-9),
    `${(pump as Buildable).buildProgress}`);
  check('and does not finish or abandon it', finished === 0 && abandoned === 0);
  check('the job is still outstanding', queue.jobs.length === 1);

  // Seek back BEFORE it was ordered: at that point in the run nobody had
  // asked for it, so it is abandoned and the yard gets it back.
  queue.tick(4000);
  check('seeking past the start abandons the job', abandoned === 1, `${abandoned}`);
  check('it never landed', finished === 0);
  check('the part is out of the plant', !plant.components.has(pumpId));
  check('and the yard has it back', componentsRemaining(plant, 'pump') === 2,
    `${componentsRemaining(plant, 'pump')}`);
  check('the queue is empty', queue.jobs.length === 0);

  // Running forward again does not resurrect it.
  queue.tick(9000);
  check('running forward again does not resurrect it',
    finished === 0 && !plant.components.has(pumpId));
}

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.error(`\n=== ${failures} FAILURE(S) ===\n`);
  process.exit(1);
}
console.log('=== ALL PASS ===\n');
void findWarehouse;
