/**
 * Headless career-level validation.
 *
 * For each level with a construction task, merge the stock site JSON with a
 * reference "player solution" fragment and run the simulation long enough to
 * confirm the level's win condition is reachable (turbine output crosses the
 * goal and holds). Levels that hand the player a complete preset are covered
 * by the existing preset validation, but can be run here too.
 *
 * Usage:
 *   npx tsx scripts/test-game-levels.ts <level|all> [simSeconds]
 *
 * Levels:
 *   1: level1-site.json + level1-reactor-solution.json (the in-game reference
 *      solution) with a scripted operator easing the rods out, expect >=150 MWe
 *   2: pwr.json (the stock plant IS the solution), expect it self-starts
 *   3: pwr.json as the reference build for the empty site, expect >=250 MWe
 *   4: two-loop.json (stock = solution), expect steady generation
 */

import * as fs from 'fs';
import * as path from 'path';

import { buildSimFromPlantJson, run, flowRate } from './lib/sim-harness';
import {
  getPresetById, getPipeSpecById, pipeSpecFlowArea,
} from '../src/construction/component-presets';
import { nodeLiquidLevel, nodeLiquidLevelFraction, cellAt } from '../src/simulation';
import { waveCasualties } from '../src/simulation/wave-casualties';
import type { PlantState } from '../src/types';
import { getCladdingOxidationPower } from '../src/simulation/operators/rate-operators';
import {
  createSimulationFromPlant,
  setSimulationRandomSeed,
  RK45Solver,
  ConductionRateOperator,
  ConvectionRateOperator,
  CladdingOxidationRateOperator,
  FissionProductReleaseOperator,
  HeatGenerationRateOperator,
  NeutronicsRateOperator,
  FlowRateOperator,
  FlowMomentumRateOperator,
  TurbineCondenserRateOperator,
  FluidStateConstraintOperator,
  FlowDynamicsConstraintOperator,
  PumpSpeedRateOperator,
  SurfaceWaterRateOperator,
  SurfaceWaterConstraintOperator,
  BurstCheckOperator,
  ControlSystemOperator,
  getTurbineCondenserState,
} from '../src/simulation';
import type { PlantState, PlantComponent, PlantConnection } from '../src/types';
import { LEVELS } from '../src/game-mode/levels';
import { ConstructionManager } from '../src/construction/construction-manager';
import { createsPipe } from '../src/construction/pipe-rules';
import { getStock } from '../src/game/stock';

interface PlantJson {
  components?: Array<[string, PlantComponent]>;
  connections?: PlantConnection[];
}

function loadJson(rel: string): PlantJson {
  const p = path.resolve(process.cwd(), rel);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function mergePlants(...parts: PlantJson[]): PlantState {
  const plantState: PlantState = {
    components: new Map<string, PlantComponent>(),
    connections: [],
  } as PlantState;
  for (const part of parts) {
    for (const [id, comp] of part.components ?? []) {
      if (plantState.components.has(id)) {
        throw new Error(`Duplicate component id '${id}' merging level plant`);
      }
      plantState.components.set(id, comp);
    }
    plantState.connections.push(...(part.connections ?? []));
  }
  return plantState;
}

function makeSolver(): RK45Solver {
  const solver = new RK45Solver({});
  solver.addRateOperator(new FlowRateOperator());
  solver.addRateOperator(new FlowMomentumRateOperator());
  solver.addRateOperator(new ConductionRateOperator());
  solver.addRateOperator(new ConvectionRateOperator());
  solver.addRateOperator(new CladdingOxidationRateOperator());
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

interface LevelCheck {
  name: string;
  parts: string[];
  /** MWe the plant must reach and hold at the end of the run */
  targetMWe: number;
  simSeconds: number;
  /** optional per-run tweak of the merged plant before simulation */
  prepare?: (plant: PlantState) => void;
  /** optional scripted operator, called once per accepted frame */
  operate?: (state: ReturnType<typeof createSimulationFromPlant>, dt: number) => void;
}

/**
 * Scripted operator for manually-rodded cores (level 1): ease the rods out
 * toward a target core power the way the briefing tells the player to.
 * Movement is rate-limited and pauses whenever reactivity is already
 * meaningfully positive, so the approach is a slow, stable power ascension.
 */
function rodOperator(targetMWt: number) {
  return (state: ReturnType<typeof createSimulationFromPlant>, dt: number) => {
    const nn = state.neutronics;
    if (!nn || nn.scrammed) return;
    const err = (targetMWt * 1e6 - nn.power) / (targetMWt * 1e6);
    let step = 0.0005 * dt * Math.max(-1, Math.min(1, err * 5));
    if (step > 0 && nn.reactivity > 50e-5) step = 0; // already rising - wait
    nn.controlRodPosition = Math.max(0, Math.min(1, nn.controlRodPosition + step));
  };
}

const CHECKS: Record<string, LevelCheck> = {
  '1': {
    name: 'Level 1: FIRST LIGHT (stock site + reference player reactor)',
    parts: [
      'src/game-mode/levels/level1-site.json',
      'src/game-mode/levels/level1-reactor-solution.json',
    ],
    targetMWe: 150,
    simSeconds: 900,
    operate: rodOperator(700),
  },
  '2': {
    name: 'Level 2: SHAKEDOWN (stock pwr preset self-starts)',
    parts: ['src/presets/pwr.json'],
    targetMWe: 100,
    simSeconds: 900,
  },
  '3': {
    name: 'Level 3: GOING CONCERN (reference build = pwr preset on the empty site)',
    parts: ['src/presets/pwr.json'],
    targetMWe: 250,
    simSeconds: 900,
  },
  '4': {
    name: 'Level 4: THE INSPECTION (stock two-loop preset)',
    parts: ['src/presets/two-loop.json'],
    targetMWe: 300,
    simSeconds: 900,
  },
};

async function runCheck(key: string, check: LevelCheck, simSecondsOverride?: number): Promise<boolean> {
  const simSeconds = simSecondsOverride ?? check.simSeconds;
  console.log(`\n=== ${check.name} ===`);
  const plant = mergePlants(...check.parts.map(loadJson));
  check.prepare?.(plant);
  console.log(`Merged plant: ${plant.components.size} components, ${plant.connections.length} connections`);

  setSimulationRandomSeed(0);
  let state = createSimulationFromPlant(plant);
  const solver = makeSolver();

  const frameDt = 0.5;
  let lastLog = -60;
  let peakMWe = 0;
  const wallStart = performance.now();

  while (state.time < simSeconds) {
    const result = solver.advance(state, frameDt);
    state = result.state;
    check.operate?.(state, frameDt);
    const tc = getTurbineCondenserState();
    const mwe = tc.turbinePower / 1e6;
    peakMWe = Math.max(peakMWe, mwe);

    if (state.time - lastLog >= 60) {
      lastLog = state.time;
      const nn = state.neutronics;
      const pct = nn.nominalPower > 0 ? (100 * nn.power / nn.nominalPower).toFixed(1) : '-';
      console.log(
        `t=${state.time.toFixed(0).padStart(5)}s  ` +
        `core=${(nn.power / 1e6).toFixed(0).padStart(5)} MWt (${pct}%)  ` +
        `rho=${(nn.reactivity * 1e5).toFixed(0).padStart(6)} pcm  ` +
        `rods=${(nn.controlRodPosition * 100).toFixed(0)}%wd  ` +
        `gen=${mwe.toFixed(1).padStart(6)} MWe  ` +
        `scram=${nn.scrammed ? 'YES' : 'no'}`
      );
    }
    if (state.pendingEvents && state.pendingEvents.length > 0) {
      for (const ev of state.pendingEvents) {
        console.log(`  [EVENT] ${ev.type}: ${ev.message}`);
      }
      state.pendingEvents = [];
    }
  }

  const wall = (performance.now() - wallStart) / 1000;
  const finalMWe = getTurbineCondenserState().turbinePower / 1e6;
  const pass = finalMWe >= check.targetMWe;
  console.log(`\n[${key}] final=${finalMWe.toFixed(1)} MWe, peak=${peakMWe.toFixed(1)} MWe, ` +
    `target=${check.targetMWe} MWe -> ${pass ? 'PASS' : 'FAIL'} ` +
    `(${(state.time / wall).toFixed(1)}x realtime)`);
  return pass;
}


// ===========================================================================
// LEVEL 1: HOT AND DRY (spent fuel pool)
// ===========================================================================
//
// This level is not judged on megawatts, so it gets its own checks: what has
// to be true is that the crisis is real, that the level's two obstacles bite
// the way the design says they do, and that a plant which answers them holds
// the fuel covered for the full eight hours.
//
//   1. NOBODY HOME. Nothing is built. The tear must uncover the racks well
//      inside the level, and the accident must then RUN: the pool boils dry,
//      the cladding oxidises, and the radiological release passes the level's
//      limit before the clock runs out. Uncovery itself is no longer a loss -
//      the run continues so the player can watch (and still fix) it.
//   2. THE SUCTION-LIFT TRAP. A pump standing on the pool bench, 13 m above
//      the sea, must NOT deliver: the atmosphere cannot push water that high
//      and its intake flashes.
//   3. THE SHORE PUMP. The same pump moved down to the shore must deliver
//      real flow UP to the pool.
//   4. SIX HOURS. Tank make-up through the flood, the shore pump before and
//      after it, and the pool stays over the racks for the whole level -
//      with the tsunami drowning the shore pump in the middle and it
//      restarting on its own when the water goes.
//
// Check 4 is the level's answer key expressed as a static plant driven by
// scenario actions rather than as live edits; the in-game reference design
// (LevelDef.reference) is still to be built.

const SFP_LEVEL = 'src/game-mode/levels/spent-fuel-pool.json';
/** Rack top: the level the pool must stay above (rackBottom + rackHeight). */
const SFP_RACK_TOP = 4.16;
/** Grace the level allows below the rack top before it is a loss. */
const SFP_GRACE = 1200;
/** The level's clock (LevelDef goal `survive`). */
const SFP_CLOCK = 28800;
/** The level's release limit (LevelDef.maxRelease). */
const SFP_MAX_RELEASE = 1.0;
/**
 * How long the player sits and watches before the liner goes, in WALL
 * seconds. The scenario is written in simulated seconds, so the number in
 * gen-spent-fuel-pool.ts is this times the level's simSpeed.
 */
const SFP_QUAKE_WALL_S = 20;
/**
 * The gap between the aftershock and the wave, and between the warning and
 * the water. Fifty-four minutes is what the two site tanks have to cover on
 * their own: the shore is unusable until the sea has been and gone, so the
 * gravity feed is the whole of the make-up until then.
 */
const SFP_WAVE_AFTER_QUAKE_S = 54 * 60;
const SFP_WARN_BEFORE_WAVE_S = 15 * 60;
/** How far the answer opens the tank valve once the sea pump carries its share (SFP_THROTTLE=x to tune). */
const SFP_ANSWER_TANK_THROTTLE = process.env.SFP_THROTTLE ? parseFloat(process.env.SFP_THROTTLE) : 0.3;

type PlantJsonRW = {
  components: Array<[string, Record<string, unknown>]>;
  connections: Array<Record<string, unknown>>;
  scenario?: { description?: string; events: Array<Record<string, unknown>> };
  terrain?: unknown;
};

function sfpPlant(): PlantJsonRW {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), SFP_LEVEL), 'utf-8'));
}

/**
 * THE pump the supply yard hands out for this level, read from the equipment
 * design itself rather than from numbers copied here - so if the design is
 * retuned, these checks measure the retuned design. Same for the yard's line
 * size: the runs below are made of the pipe the yard stocks.
 */
const SFP_YARD_PUMP_DESIGN = 'pump-service-water-lp';
const SFP_YARD_PIPE_SPEC = 'spec-12in-service';
const SFP_PUMP = (() => {
  const preset = getPresetById(SFP_YARD_PUMP_DESIGN);
  if (!preset) throw new Error(`[sfp] no equipment design '${SFP_YARD_PUMP_DESIGN}'`);
  return preset.properties as Record<string, number>;
})();
const SFP_PIPE_AREA = (() => {
  const spec = getPipeSpecById(SFP_YARD_PIPE_SPEC);
  if (!spec) throw new Error(`[sfp] no pipe spec '${SFP_YARD_PIPE_SPEC}'`);
  return pipeSpecFlowArea(spec);
})();

/**
 * A make-up pump as the yard hands it over, at a plan position: on the
 * local ground (elevation 0 - the sea floor when the spot is in the sea),
 * with the design's motor column and casing fill (DRY: it holds air until
 * its suction floods it).
 */
function sfpPump(id: string, label: string, x: number, y: number) {
  const ratedFlow = SFP_PUMP.ratedFlow;
  return [id, {
    id, type: 'pump', label, design: SFP_YARD_PUMP_DESIGN,
    position: { x, y }, rotation: 0, elevation: 0,
    diameter: 0.2 + Math.sqrt(ratedFlow / 1000) * 0.4,
    running: false, speed: 1,
    ratedFlow, ratedHead: SFP_PUMP.ratedHead, orientation: 'left-right',
    npshRequired: SFP_PUMP.npshRequired,
    motorElevation: SFP_PUMP.motorElevation,
    initialFill: (SFP_PUMP as Record<string, unknown>).initialFill,
    dischargeCheck: (SFP_PUMP as Record<string, unknown>).dischargeCheck,
    ports: [
      { id: `${id}-inlet`, position: { x: -0.5, y: 0 }, direction: 'in' },
      { id: `${id}-outlet`, position: { x: 0.5, y: 0 }, direction: 'out' },
    ],
    fluid: { temperature: 288.15, pressure: 101325, phase: 'liquid', quality: 0, flowRate: 0 },
    pressureRating: SFP_PUMP.pressureRating,
  }] as [string, Record<string, unknown>];
}

/**
 * Where a line meets the yard pump: the app pins a pump's connection
 * elevations to its drawn nozzles (height/2 - port.y, see
 * hasPinnedPortElevations), and with the ports at y = 0 both nozzles are at
 * the casing top - which is where a casing vents its air as it primes.
 */
function sfpPumpNozzle(): number {
  const diameter = 0.2 + Math.sqrt(SFP_PUMP.ratedFlow / 1000) * 0.4;
  return diameter * 1.3 * 2.2 / 2;
}

/** The sea's intake: its one port, at the depth the level puts it. */
function sfpSeaIntakeElevation(): number {
  const sea = sfpPlant().components.find(c => c[0] === 'sea')![1] as { height: number; ports: Array<{ position: { y: number } }> };
  return sea.height / 2 - sea.ports[0].position.y;
}

/**
 * Where a line into the pool lands: the connection dialog's default for the
 * named port (depth/2 - port.y above the pool floor), which is what a player
 * who accepts the dialog gets.
 */
function sfpPoolPortElevation(portId: string): number {
  const pool = sfpPlant().components.find(c => c[0] === 'pool')![1] as { depth: number; ports: Array<{ id: string; position: { y: number } }> };
  const port = pool.ports.find(p => p.id === portId);
  if (!port) throw new Error(`[sfp] the pool has no port '${portId}'`);
  return pool.depth / 2 - port.position.y;
}

interface SfpRun {
  fromComponentId: string; fromPortId: string; toComponentId: string; toPortId: string;
  fromElevation: number; toElevation: number; length: number; flowArea: number;
}

function sfpLine(
  fromComponentId: string, fromPortId: string, toComponentId: string, toPortId: string,
  fromElevation: number, toElevation: number, length: number, flowArea: number
): SfpRun {
  return { fromComponentId, fromPortId, toComponentId, toPortId, fromElevation, toElevation, length, flowArea };
}

/**
 * Lay an answer's runs the way a player's connection dialog does: through
 * the ConstructionManager, as a real pipe or a direct connection by the same
 * rule the dialog applies (src/construction/pipe-rules.ts). A long run built
 * as a bare connection would lump its whole inventory into the pump at the
 * pump's elevation - a plant no player can build, with physics of its own.
 *
 * The level is loaded the way main.ts loads it (the manager clears the plant
 * it is handed, so the components go in afterwards, then normalizeLoadedPlant).
 * The yard's pipe is measured, not enforced: the runs are laid from a
 * bottomless rack so the physics is still checked, and the caller compares
 * `metres` with `stockMetres`.
 *
 * `lastHop[i]` is the node that feeds run i's far end (its pipe, or its own
 * from-component when it stayed direct), for flowRate(state, lastHop[i], to).
 */
function sfpBuild(plant: PlantJsonRW, runs: SfpRun[]): {
  plant: PlantJsonRW; metres: number; stockMetres: number; lastHop: string[];
} {
  const ps = {
    components: new Map(), connections: [], terrain: plant.terrain, scenario: plant.scenario,
  } as unknown as PlantState;
  const cm = new ConstructionManager(ps);
  for (const [id, c] of plant.components) ps.components.set(id, c as unknown as PlantComponent);
  ps.connections = plant.connections as unknown as PlantConnection[];
  cm.normalizeLoadedPlant();

  const stock = getStock(ps);
  const stockMetres = stock ? stock.pipeMeters : Infinity;
  const RACK = 1e9;
  if (stock) stock.pipeMeters = RACK;
  const lastHop: string[] = [];
  for (const r of runs) {
    const before = new Set(ps.components.keys());
    const ok = createsPipe(r.flowArea, r.length)
      ? cm.createConnectionWithPipe(r.fromPortId, r.toPortId, r.flowArea, r.length, r.fromElevation, r.toElevation)
      : cm.createConnection(r.fromPortId, r.toPortId, r.fromElevation, r.toElevation, r.flowArea, r.length);
    if (!ok) {
      throw new Error(`[sfp] the connection dialog could not lay ${r.fromComponentId} -> ${r.toComponentId}: ` +
        `${cm.takeStockRefusal() ?? 'refused (see the log above)'}`);
    }
    const pipe = [...ps.components.keys()].find(id => !before.has(id));
    lastHop.push(pipe ?? r.fromComponentId);
  }
  const metres = stock ? RACK - stock.pipeMeters : 0;
  if (stock) stock.pipeMeters = stockMetres;
  return {
    plant: {
      ...plant,
      components: [...ps.components] as unknown as PlantJsonRW['components'],
      connections: ps.connections as unknown as PlantJsonRW['connections'],
    },
    metres, stockMetres, lastHop,
  };
}

/** Pool water level (m above the pool floor). */
function sfpLevel(state: ReturnType<typeof createSimulationFromPlant>): number {
  return nodeLiquidLevel(state.flowNodes.get('pool')!);
}

function sfpCladC(state: ReturnType<typeof createSimulationFromPlant>): number {
  return state.thermalNodes.get('pool-clad')!.temperature - 273.15;
}

async function runSpentFuelPoolChecks(): Promise<boolean> {
  console.log(`\n=== Level 1: HOT AND DRY (spent fuel pool) ===`);
  let pass = true;
  const fail = (m: string) => { console.log(`  FAIL: ${m}`); pass = false; };
  // SFP_ONLY=1|23|4 runs one sub-check while tuning the level.
  const only = process.env.SFP_ONLY;
  const wants = (n: string) => !only || only.includes(n);

  // -- 0. The yard hands out the very design these checks measure -----------
  {
    const yard = (sfpPlant().components.find(c => c[0] === 'yard')![1] as
      { stock: { pipeSpec?: string; components: Array<{ type: string; design?: string; count: number }> } }).stock;
    const pumpLine = yard.components.find(l => l.type === 'pump');
    if (!pumpLine || pumpLine.design !== SFP_YARD_PUMP_DESIGN) {
      fail(`the yard should stock '${SFP_YARD_PUMP_DESIGN}' pumps, holds ` +
        `${JSON.stringify(pumpLine)}`);
    }
    if (yard.pipeSpec !== SFP_YARD_PIPE_SPEC) {
      fail(`the yard should stock '${SFP_YARD_PIPE_SPEC}' pipe, holds '${yard.pipeSpec}'`);
    }
    const valveLine = yard.components.find(l => l.type === 'valve');
    if (!valveLine || !valveLine.design) {
      fail(`the yard's valves should name a design, holds ${JSON.stringify(valveLine)}`);
    }
    console.log(`  [0] yard: ${yard.components.map(l => `${l.count}x ${l.design ?? l.type}`).join(', ')}` +
      `, pipe ${yard.pipeSpec}`);
  }

  // -- 0b. The clock the player actually sits through ----------------------
  // The aftershock is timed in WALL seconds, not simulated ones: 20 s at the
  // level's own 60x. Long enough to look at the plant and find the controls,
  // and short enough that nothing is learnt from watching an intact pool. It
  // read as instantaneous when the sim time was the number that got set.
  {
    const level = LEVELS.find(l => l.id === 'spent-fuel-pool');
    if (!level) fail('no level with id spent-fuel-pool');
    const speed = level?.simSpeed ?? 1;
    const events = (sfpPlant() as unknown as { scenario?: { events: Array<{ time: number; message: string; actions: Array<{ kind: string }> }> } }).scenario?.events ?? [];
    const quake = events[0];
    if (!quake) fail('the level ships no scenario events');
    else {
      const wall = quake.time / speed;
      const kinds = quake.actions.map(a => a.kind).sort().join('+');
      console.log(`  [0b] aftershock t=${quake.time} s = ${wall.toFixed(0)} s of wall time at ${speed}x (${kinds})`);
      if (Math.abs(wall - SFP_QUAKE_WALL_S) > 0.5) {
        fail(`the aftershock should land ${SFP_QUAKE_WALL_S} s of wall time in, it lands at ${wall.toFixed(1)} s`);
      }
      if (kinds !== 'burst+shake') fail(`the aftershock should shake the view and burst the pool, it does ${kinds}`);
      if (!(events.every(e => e.time > 0))) fail('no scenario event may be due at t=0 - it would fire on the first step');
      for (let i = 1; i < events.length; i++) {
        if (!(events[i].time > events[i - 1].time)) fail(`event ${i} is not after the one before it`);
      }
      // The rest of the sequence is written as offsets from the quake, so
      // moving it moves them: the wave 54 minutes after the aftershock, and
      // the warning a quarter of an hour before the water. The 54 minutes is
      // the gap the two site tanks have to cover on their own.
      if (events[2] && events[2].time - quake.time !== SFP_WAVE_AFTER_QUAKE_S) {
        fail(`the wave should arrive ${SFP_WAVE_AFTER_QUAKE_S} s after the quake, ` +
          `it is ${events[2].time - quake.time} s`);
      }
      if (events[1] && events[2] && events[2].time - events[1].time !== SFP_WARN_BEFORE_WAVE_S) {
        fail(`the tsunami warning should be ${SFP_WARN_BEFORE_WAVE_S} s before the wave, ` +
          `it is ${events[2].time - events[1].time} s`);
      }
      console.log(`  [0b] wave t=${events[2]?.time} s (${((events[2].time - quake.time) / 60).toFixed(0)} ` +
        `min after the aftershock), warning t=${events[1]?.time} s ` +
        `(${((events[2].time - events[1].time) / 60).toFixed(0)} min before the water)`);
    }
  }

  // -- 1. Nobody home: the tear alone must lose the level ------------------
  // The loss is no longer "the water went below the racks". It is what a real
  // one is judged on: the pool boils dry, the cladding burns, and activity
  // reaches the environment. The level's maxRelease is the line.
  if (wants('1')) {
    const sim = buildSimFromPlantJson(sfpPlant() as never);
    const level0 = sfpLevel(sim.state);
    const clad = () => sim.state.thermalNodes.get('pool-clad')!;
    let firstUncovered = -1;
    let dryAt = -1;
    let ignitedAt = -1;        // clad past 900 C, where an air fire sustains
    let lostAt = -1;
    let peakOx = 0;
    while (sim.state.time < SFP_CLOCK && lostAt < 0) {
      run(sim, 20, 0.5);
      sim.state.pendingEvents = [];
      const lvl = sfpLevel(sim.state);
      if (lvl < SFP_RACK_TOP && firstUncovered < 0) firstUncovered = sim.state.time;
      if (lvl <= 0.01 && dryAt < 0) dryAt = sim.state.time;
      if (sfpCladC(sim.state) > 900 && ignitedAt < 0) ignitedAt = sim.state.time;
      peakOx = Math.max(peakOx, getCladdingOxidationPower().get('pool-clad') ?? 0);
      const rel = sim.state.environmentalRelease as Record<string, number> | undefined;
      const severity = 60 * (rel?.CsI ?? 0) + 0.02 * (rel?.Xe ?? 0);
      if (severity >= SFP_MAX_RELEASE) lostAt = sim.state.time;
    }
    const rel = sim.state.environmentalRelease as Record<string, number> | undefined;
    console.log(`  [1] unfed: level ${level0.toFixed(2)} m -> ${sfpLevel(sim.state).toFixed(2)} m; ` +
      `racks uncovered t=${firstUncovered.toFixed(0)} s, boiled dry t=${dryAt.toFixed(0)} s, ` +
      `clad past 900 C t=${ignitedAt.toFixed(0)} s (peak oxidation ${(peakOx / 1e6).toFixed(1)} MW), ` +
      `release limit t=${lostAt.toFixed(0)} s; clad ${sfpCladC(sim.state).toFixed(0)} C, ` +
      `${((clad().oxidation?.oxidizedFraction ?? 0) * 100).toFixed(2)}% of the cladding gone, ` +
      `${(rel?.CsI ?? 0).toExponential(2)} mol CsI out`);
    if (firstUncovered < 0) fail('an unfed pool must uncover its racks inside the level');
    if (dryAt < 0) fail('an unfed pool must BOIL DRY inside the level, not just uncover');
    if (ignitedAt < 0) fail('dry racks must heat past 900 C inside the level');
    if (!(peakOx > 1e6)) fail(`cladding oxidation must become a real heat source, peaked at ${(peakOx / 1e6).toFixed(2)} MW`);
    if (lostAt < 0) fail('an unfed pool must pass the release limit before the clock runs out');
    if (lostAt > 0 && dryAt > 0 && !(lostAt > dryAt)) fail('the release must follow the dry-out, not precede it');
  }

  // -- 2 & 3. Where the pump can stand ------------------------------------
  // The same pump, same pipe, same pool: only the ground under it differs.
  // The yard's pump is a wet-pit machine delivered DRY (a casing full of
  // air): on the bench or on the shore the sea cannot reach up into it and
  // it pumps nothing; standing in the sea it floods, primes and delivers;
  // too far out and the sea is over its motor before it starts.
  const seaIntake = sfpSeaIntakeElevation();
  for (const spot of (wants('2') ? [
    { name: 'pool bench (+13 m)', id: 'trap', x: 95, y: 75, suction: 150, discharge: 45, deliver: false, drowned: false },
    { name: 'shore (+1.7 m)', id: 'shore', x: 200, y: 75, suction: 30, discharge: 170, deliver: false, drowned: false },
    { name: 'in the sea (x=236, ~2 m of water)', id: 'wet', x: 236, y: 75, suction: 12, discharge: 200, deliver: true, drowned: false },
    { name: 'too far out (x=282, ~7 m of water)', id: 'deep', x: 282, y: 75, suction: 60, discharge: 250, deliver: false, drowned: true },
  ] : [])) {
    const plant = sfpPlant();
    plant.components.push(sfpPump(spot.id, `Sea pump (${spot.name})`, spot.x, spot.y));
    (plant.components.find(c => c[0] === spot.id)![1] as Record<string, unknown>).running = true;
    plant.scenario = undefined;   // no earthquake: this is about the pump alone
    const built = sfpBuild(plant, [
      sfpLine('sea', 'sea-out', spot.id, `${spot.id}-inlet`, seaIntake, sfpPumpNozzle(), spot.suction, SFP_PIPE_AREA),
      sfpLine(spot.id, `${spot.id}-outlet`, 'pool', 'pool-makeup-e', sfpPumpNozzle(), sfpPoolPortElevation('pool-makeup-e'), spot.discharge, SFP_PIPE_AREA)]);
    if (built.metres > built.stockMetres) {
      console.log(`      (these runs take ${built.metres.toFixed(0)} m of pipe; the yard holds ${built.stockMetres.toFixed(0)} m)`);
    }
    const sim = buildSimFromPlantJson(built.plant as never);
    // Five minutes, not two: the runs are real pipes, laid DRY with the dry
    // pump, and a 200 m discharge line holds 14 m3 of air that the sea has to
    // push out before any water reaches the pool. The first water arrives
    // after ~90 s and delivery climbs to ~70 kg/s by ~240 s (the casing and
    // its suction fill first, then the line) - at 120 s it is mid-fill.
    run(sim, 300, 0.02);
    const q = flowRate(sim.state, built.lastHop[1], 'pool');
    const casing = sim.state.flowNodes.get(spot.id)!;
    const pump = sim.state.components.pumps.get(spot.id)!;
    // Wherever it stands, a pump that fills while it runs must not burst its
    // own casing (a slam here once went unnoticed: the pump delivered its
    // flow through a ruptured casing leaking 42 kg/s)
    if (sim.state.burstStates?.get(spot.id)?.isBurst) {
      fail(`the pump at the ${spot.name} burst its casing`);
    }
    const ground = casing.groundHeight ?? 0;
    console.log(`  [${spot.deliver ? 3 : 2}] ${spot.name}: ${q.toFixed(1)} kg/s to the pool, ` +
      `casing ${casing.fluid.phase} at ${(casing.fluid.pressure / 1e5).toFixed(3)} bar, ground ${ground.toFixed(2)} m, ` +
      `motor at ${pump.motorElevation.toFixed(2)} m${pump.flooded ? ' DROWNED' : ''}, speed ${pump.effectiveSpeed.toFixed(2)} ` +
      `(${getPresetById(SFP_YARD_PUMP_DESIGN)!.name}, ${SFP_PUMP.ratedFlow} kg/s at ` +
      `${SFP_PUMP.ratedHead} m, on ${getPipeSpecById(SFP_YARD_PIPE_SPEC)!.label})`);
    if (spot.deliver) {
      if (!(q > 40)) fail(`a pump standing in the sea should push water up to the pool, got ${q.toFixed(1)} kg/s`);
      if (!(q < 90)) fail(`the pump is meant to be modest - well under the tear's ~105 kg/s at the racks, got ${q.toFixed(1)} kg/s`);
      // Primed = full of water. A casing can keep a bubble of its air (a
      // fraction of a percent of it) and still read 'two-phase'; what the
      // impeller cares about is the liquid it stands in.
      const filled = nodeLiquidLevelFraction(casing);
      if (!(filled > 0.98)) fail(`a pump standing in the sea should have primed, casing is ${casing.fluid.phase} at ${(100 * filled).toFixed(1)}% liquid`);
      if (pump.flooded) fail('a pump in 2 m of water has its motor 4 m above the sea - it must not be drowned');
    } else {
      // Nothing DELIVERED. A little may run the other way: the pool stands
      // ten metres above the sea, and a pump - running or not - is an open
      // path between them (the impeller's reverse resistance is all that
      // slows it). That is real: the yard's gate valves are the answer.
      if (!(q < 2)) fail(`the pump at the ${spot.name} should deliver nothing, got ${q.toFixed(1)} kg/s`);
      if (q < -0.5) console.log(`      (${(-q).toFixed(1)} kg/s runs BACK from the pool through the idle pump to the sea)`);
      if (spot.drowned) {
        if (!pump.flooded) fail('a pump standing in 7 m of water has its motor under the surface - it must be drowned');
        if (!(pump.effectiveSpeed < 0.05)) fail(`a drowned pump must coast down, speed ${pump.effectiveSpeed.toFixed(2)}`);
      } else if (casing.fluid.phase === 'liquid') {
        fail(`a dry pump on dry ground cannot prime itself - its casing should still hold air, got ${casing.fluid.phase}`);
      }
    }
  }

  // -- 4. Eight hours: sea pump either side of the wave, tanks through it ---
  if (wants('4')) {
    const plant = sfpPlant();
    plant.components.push(
      // Standing in the sea (there is nowhere else it works), stopped until
      // the wave has been and gone. It is there from the start so that the
      // wave rule can be checked against it (a pump the wave closes over is
      // one the app removes: src/simulation/wave-casualties.ts decides, and
      // this test asks it), but it is only started afterwards - the answer
      // a player gives is to BUILD it afterwards, which comes to the same.
      sfpPump('shore-pump', 'Sea Pump', 236, 75),
      // The tank line needs no pump: both tanks stand on the bench with the
      // pool sunk 10.5 m below their feet, so they feed it by gravity. What
      // it needs is a valve, because 1200 t of gravity feed left open runs
      // out long before the wave does.
      ['tank-valve', {
        id: 'tank-valve', type: 'valve', label: 'Tank Make-up Valve',
        position: { x: 78, y: 88 }, rotation: 0, elevation: 0,
        diameter: 0.2, volume: 0.3, valveType: 'gate', opening: 0,
        ports: [
          { id: 'tank-valve-in', position: { x: -0.5, y: 0 }, direction: 'both' },
          { id: 'tank-valve-out', position: { x: 0.5, y: 0 }, direction: 'both' },
        ],
        fluid: { temperature: 288.15, pressure: 101325, phase: 'liquid', quality: 0, flowRate: 0 },
        pressureRating: 20,
      }] as [string, Record<string, unknown>]);
    const built = sfpBuild(plant, [
      sfpLine('sea', 'sea-out', 'shore-pump', 'shore-pump-inlet', seaIntake, sfpPumpNozzle(), 12, SFP_PIPE_AREA),
      sfpLine('shore-pump', 'shore-pump-outlet', 'pool', 'pool-makeup-e', sfpPumpNozzle(), sfpPoolPortElevation('pool-makeup-e'), 200, SFP_PIPE_AREA),
      sfpLine('tank-a', 'tank-a-out', 'tank-valve', 'tank-valve-in', 0.4, 0.3, 20, 0.03),
      sfpLine('tank-b', 'tank-b-out', 'tank-valve', 'tank-valve-in', 0.4, 0.3, 45, 0.03),
      sfpLine('tank-valve', 'tank-valve-out', 'pool', 'pool-makeup-w', 0.3, 10.5, 30, 0.03)]);
    const seaFeed = built.lastHop[1];
    const tankFeed = built.lastHop[4];
    console.log(`      (the answer takes ${built.metres.toFixed(0)} m of pipe; the yard holds ${built.stockMetres.toFixed(0)} m)`);
    if (built.metres > built.stockMetres) {
      fail(`the answer needs ${built.metres.toFixed(0)} m of pipe and the yard holds ${built.stockMetres.toFixed(0)} m - a player could not build it`);
    }
    // The operator's actions, as scenario events instead of live edits, and
    // in the order the fifty-four-minute gap forces: the TANK LINE FIRST,
    // because it is the only make-up there is while the tsunami is on its way,
    // and the SEA PUMP ONLY AFTER THE WATER HAS GONE BACK DOWN, because
    // anything running on the shore before that is drowned by it. The tanks
    // therefore have to carry the leak on their own from the tear to the far
    // side of the wave - which is the point of the gap. Times track the
    // level's own clock (scripts/gen-spent-fuel-pool.ts): aftershock 1200 s,
    // wave in 4440 s, back to sea level 4980 s.
    // The sea pump cannot beat the tear on its own (it is rated for a few
    // tens of kg/s against a full pool, ~90 against an empty one, and the
    // tear passes ~105 kg/s at the rack top), so the tanks are not a bridge
    // to the pump - they are the other half of the make-up for the whole
    // watch, and the play is to THROTTLE them to the shortfall so that 1200
    // tonnes lasts eight hours. Times track the level's own clock
    // (scripts/gen-spent-fuel-pool.ts): aftershock 1200 s, wave in 4440 s,
    // back to sea level 4980 s.
    plant.scenario!.events.push(
      { time: 1260, message: 'Liner is gone: opening the tank make-up', actions: [
        { kind: 'valve', id: 'tank-valve', position: 1 },
      ] },
      { time: 5100, message: 'The sea is back down: sea pump on the line', actions: [
        { kind: 'pump', id: 'shore-pump', running: true, speed: 1 },
      ] },
      { time: 5700, message: 'Sea pump has what it can carry; throttling the tank line to the shortfall', actions: [
        { kind: 'valve', id: 'tank-valve', position: SFP_ANSWER_TANK_THROTTLE },
      ] });
    const sim = buildSimFromPlantJson(built.plant as never);
    const tankMass = () => sim.state.flowNodes.get('tank-a')!.fluid.mass +
      sim.state.flowNodes.get('tank-b')!.fluid.mass;
    const tanks0 = tankMass();
    let minTanks = tanks0;
    let minLevel = Infinity;
    let maxClad = -Infinity;
    let uncoveredSince = -1;
    let worstUncovered = 0;
    let floodedAt = -1;
    let recoveredAt = -1;
    let takenAt = -1;
    let lastLog = 0;
    const plantForWave = {
      components: new Map(built.plant.components as Array<[string, never]>),
      connections: built.plant.connections, terrain: plant.terrain, scenario: plant.scenario,
    } as unknown as PlantState;
    let maxPuddle = 0;
    while (sim.state.time < 28800) {
      run(sim, 20, 0.5);
      sim.state.pendingEvents = [];
      const lvl = sfpLevel(sim.state);
      minLevel = Math.min(minLevel, lvl);
      minTanks = Math.min(minTanks, tankMass());
      maxClad = Math.max(maxClad, sfpCladC(sim.state));
      if (lvl < SFP_RACK_TOP) {
        if (uncoveredSince < 0) uncoveredSince = sim.state.time;
        worstUncovered = Math.max(worstUncovered, sim.state.time - uncoveredSince);
      } else {
        uncoveredSince = -1;
      }
      const shore = sim.state.components.pumps.get('shore-pump')!;
      if (shore.flooded && floodedAt < 0) floodedAt = sim.state.time;
      if (floodedAt > 0 && !shore.flooded && recoveredAt < 0) recoveredAt = sim.state.time;
      if (takenAt < 0 && waveCasualties(plantForWave, sim.state).some(c => c.id === 'shore-pump')) takenAt = sim.state.time;
      // The leak's puddle on the pad (the basin under the pool)
      const padBasin = sim.state.terrain!.basinOf[cellAt(sim.state.terrain!.spec, { x: 50, y: 75 })];
      maxPuddle = Math.max(maxPuddle, sim.state.surfaceWater!.volumes.get(padBasin) ?? 0);
      if (sim.state.time - lastLog >= 1800) {
        lastLog = sim.state.time;
        console.log(`      t=${sim.state.time.toFixed(0).padStart(5)}s  pool ${lvl.toFixed(2)} m  ` +
          `clad ${sfpCladC(sim.state).toFixed(0)} C  ` +
          `tanks ${(tankMass() / 1000).toFixed(0)} t (${flowRate(sim.state, tankFeed, 'pool').toFixed(0)} kg/s)  ` +
          `sea pump ${shore.flooded ? 'DROWNED' : 'clear'} (${shore.effectiveSpeed.toFixed(2)}, ${flowRate(sim.state, seaFeed, 'pool').toFixed(0)} kg/s, ` +
          `casing ${(() => {
            const c = sim.state.flowNodes.get('shore-pump')!;
            return `${c.fluid.phase} ${(100 * (c.fluid.gasVolume ?? 0) / c.volume).toFixed(1)}% gas ${(c.fluid.pressure / 1e5).toFixed(3)} bar`;
          })()})  ` +
          `puddle ${(sim.state.surfaceWater!.volumes.get(padBasin) ?? 0).toFixed(0)} m3`);
      }
    }
    console.log(`  [4] eight hours: min pool level ${minLevel.toFixed(2)} m (racks at ${SFP_RACK_TOP} m), ` +
      `peak clad ${maxClad.toFixed(0)} C, longest uncovery ${worstUncovered.toFixed(0)} s, ` +
      `sea pump drowned at t=${floodedAt.toFixed(0)} s (the wave would take it at t=${takenAt.toFixed(0)} s) ` +
      `and clear again at t=${recoveredAt.toFixed(0)} s; ` +
      `tanks ${(tanks0 / 1000).toFixed(0)} t -> ${(minTanks / 1000).toFixed(0)} t ` +
      `(${((tanks0 - minTanks) / 1000).toFixed(0)} t drawn, ` +
      `${(100 * minTanks / tanks0).toFixed(0)}% left); the leak's puddle peaked at ${maxPuddle.toFixed(0)} m3`);
    if (!(takenAt > 0)) fail('the wave must close over a pump standing in the sea (its motor is 6 m up)');
    if (!(maxPuddle > 50)) fail(`the leak should stand as a puddle on the pad, it peaked at ${maxPuddle.toFixed(0)} m3`);
    if (!(minTanks > 0.05 * tanks0)) {
      fail(`the tanks must still hold a margin at the end, they fell to ` +
        `${(minTanks / 1000).toFixed(0)} t of ${(tanks0 / 1000).toFixed(0)} t`);
    }
    if (!(worstUncovered < SFP_GRACE)) fail(`the answer must keep the racks covered, uncovered for ${worstUncovered.toFixed(0)} s`);
    if (!(maxClad < 600)) fail(`cladding must stay below the 600 C limit, peaked at ${maxClad.toFixed(0)} C`);
    if (!(floodedAt > 0)) fail('the tsunami must drown a pump standing in the sea');
    if (!(recoveredAt > floodedAt)) fail('the sea pump must clear once the sea has gone back down');
  }

  console.log(`\n[sfp] -> ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

async function main() {
  const which = process.argv[2] ?? 'all';
  const simSeconds = process.argv[3] ? parseFloat(process.argv[3]) : undefined;
  const keys = which === 'all' ? ['sfp', ...Object.keys(CHECKS)] : [which];
  let allPass = true;
  for (const key of keys) {
    if (key === 'sfp') {
      try {
        allPass = (await runSpentFuelPoolChecks()) && allPass;
      } catch (err) {
        console.error('[sfp] simulation threw:', err);
        allPass = false;
      }
      continue;
    }
    const check = CHECKS[key];
    if (!check) {
      console.error(`Unknown level check '${key}'. Available: sfp, ${Object.keys(CHECKS).join(', ')}`);
      process.exit(1);
    }
    try {
      const ok = await runCheck(key, check, simSeconds);
      allPass = allPass && ok;
    } catch (err) {
      console.error(`[${key}] simulation threw:`, err);
      allPass = false;
    }
  }
  process.exit(allPass ? 0 : 1);
}

main();
