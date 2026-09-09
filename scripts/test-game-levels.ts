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
import { nodeLiquidLevel } from '../src/simulation';
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

/** A make-up pump as the yard hands it over, at a plan position. */
function sfpPump(id: string, label: string, x: number, y: number) {
  const ratedFlow = SFP_PUMP.ratedFlow;
  return [id, {
    id, type: 'pump', label, design: SFP_YARD_PUMP_DESIGN,
    position: { x, y }, rotation: 0, elevation: 0,
    diameter: 0.2 + Math.sqrt(ratedFlow / 1000) * 0.4,
    running: false, speed: 1,
    ratedFlow, ratedHead: SFP_PUMP.ratedHead, orientation: 'left-right',
    npshRequired: SFP_PUMP.npshRequired,
    ports: [
      { id: `${id}-inlet`, position: { x: -0.5, y: 0 }, direction: 'in' },
      { id: `${id}-outlet`, position: { x: 0.5, y: 0 }, direction: 'out' },
    ],
    fluid: { temperature: 288.15, pressure: 101325, phase: 'liquid', quality: 0, flowRate: 0 },
    pressureRating: SFP_PUMP.pressureRating,
  }] as [string, Record<string, unknown>];
}

function sfpLine(
  fromComponentId: string, fromPortId: string, toComponentId: string, toPortId: string,
  fromElevation: number, toElevation: number, length: number, flowArea: number
) {
  return { fromComponentId, fromPortId, toComponentId, toPortId, fromElevation, toElevation, length, flowArea };
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

  // -- 2 & 3. The suction lift ---------------------------------------------
  // The same pump, same pipe, same pool: only the ground under it differs.
  for (const spot of (wants('2') ? [
    { name: 'pool bench (+13 m)', id: 'trap', x: 95, y: 75, suction: 150, discharge: 45, deliver: false },
    { name: 'shore (+1.7 m)', id: 'shore', x: 200, y: 75, suction: 45, discharge: 155, deliver: true },
  ] : [])) {
    const plant = sfpPlant();
    plant.components.push(sfpPump(spot.id, `Sea pump (${spot.name})`, spot.x, spot.y));
    (plant.components.find(c => c[0] === spot.id)![1] as Record<string, unknown>).running = true;
    plant.connections.push(
      sfpLine('sea', 'sea-out', spot.id, `${spot.id}-inlet`, 0.5, 0.3, spot.suction, SFP_PIPE_AREA),
      sfpLine(spot.id, `${spot.id}-outlet`, 'pool', 'pool-makeup-e', 0.3, 10.5, spot.discharge, SFP_PIPE_AREA));
    plant.scenario = undefined;   // no earthquake: this is about the pump alone
    const sim = buildSimFromPlantJson(plant as never);
    run(sim, 120, 0.02);
    const q = flowRate(sim.state, spot.id, 'pool');
    const suction = sim.state.flowNodes.get(spot.id)!;
    console.log(`  [${spot.deliver ? 3 : 2}] ${spot.name}: ${q.toFixed(1)} kg/s to the pool, ` +
      `pump node ${suction.fluid.phase} at ${(suction.fluid.pressure / 1e5).toFixed(3)} bar ` +
      `(${getPresetById(SFP_YARD_PUMP_DESIGN)!.name}, ${SFP_PUMP.ratedFlow} kg/s at ` +
      `${SFP_PUMP.ratedHead} m, on ${getPipeSpecById(SFP_YARD_PIPE_SPEC)!.label})`);
    if (spot.deliver && !(q > 40)) fail(`a shore pump should push water up to the pool, got ${q.toFixed(1)} kg/s`);
    if (!spot.deliver && !(Math.abs(q) < 2)) {
      fail(`a pump 13 m above the sea cannot draw it, got ${q.toFixed(1)} kg/s`);
    }
    if (!spot.deliver && !(suction.fluid.phase === 'two-phase' && suction.fluid.pressure < 0.3e5)) {
      fail(`the trapped pump's suction should have flashed, got ${suction.fluid.phase} at ` +
        `${(suction.fluid.pressure / 1e5).toFixed(3)} bar`);
    }
  }

  // -- 4. Eight hours: sea pump either side of the wave, tanks through it ---
  if (wants('4')) {
    const plant = sfpPlant();
    plant.components.push(
      sfpPump('shore-pump', 'Sea Pump', 200, 75),
      // The tank line needs no pump: both tanks stand on the bench with the
      // pool sunk 10.5 m below their feet, so they feed it by gravity. What
      // it needs is a valve, because 1200 t of gravity feed left open runs
      // out long before the wave does.
      ['tank-valve', {
        id: 'tank-valve', type: 'valve', label: 'Tank Make-up Valve',
        position: { x: 78, y: 62 }, rotation: 0, elevation: 0,
        diameter: 0.2, volume: 0.3, valveType: 'gate', opening: 0,
        ports: [
          { id: 'tank-valve-in', position: { x: -0.5, y: 0 }, direction: 'both' },
          { id: 'tank-valve-out', position: { x: 0.5, y: 0 }, direction: 'both' },
        ],
        fluid: { temperature: 288.15, pressure: 101325, phase: 'liquid', quality: 0, flowRate: 0 },
        pressureRating: 20,
      }] as [string, Record<string, unknown>]);
    plant.connections.push(
      sfpLine('sea', 'sea-out', 'shore-pump', 'shore-pump-inlet', 0.5, 0.3, 45, SFP_PIPE_AREA),
      sfpLine('shore-pump', 'shore-pump-outlet', 'pool', 'pool-makeup-e', 0.3, 10.5, 155, SFP_PIPE_AREA),
      sfpLine('tank-a', 'tank-a-out', 'tank-valve', 'tank-valve-in', 0.4, 0.3, 20, 0.03),
      sfpLine('tank-b', 'tank-b-out', 'tank-valve', 'tank-valve-in', 0.4, 0.3, 45, 0.03),
      sfpLine('tank-valve', 'tank-valve-out', 'pool', 'pool-makeup-w', 0.3, 10.5, 30, 0.03));
    // The operator's actions, as scenario events instead of live edits, and
    // in the order the fifty-four-minute gap forces: the TANK LINE FIRST,
    // because it is the only make-up there is while the tsunami is on its way,
    // and the SEA PUMP ONLY AFTER THE WATER HAS GONE BACK DOWN, because
    // anything running on the shore before that is drowned by it. The tanks
    // therefore have to carry the leak on their own from the tear to the far
    // side of the wave - which is the point of the gap. Times track the
    // level's own clock (scripts/gen-spent-fuel-pool.ts): aftershock 1200 s,
    // wave in 4440 s, back to sea level 4980 s.
    plant.scenario!.events.push(
      { time: 1260, message: 'Liner is gone: opening the tank make-up', actions: [
        { kind: 'valve', id: 'tank-valve', position: 1 },
      ] },
      { time: 5100, message: 'The sea is back down: sea pump on the line', actions: [
        { kind: 'pump', id: 'shore-pump', running: true, speed: 1 },
      ] },
      { time: 5700, message: 'Sea pump has the load; securing the tank line', actions: [
        { kind: 'valve', id: 'tank-valve', position: 0 },
      ] });
    const sim = buildSimFromPlantJson(plant as never);
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
    let lastLog = 0;
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
      if (sim.state.time - lastLog >= 1800) {
        lastLog = sim.state.time;
        console.log(`      t=${sim.state.time.toFixed(0).padStart(5)}s  pool ${lvl.toFixed(2)} m  ` +
          `clad ${sfpCladC(sim.state).toFixed(0)} C  ` +
          `tanks ${(tankMass() / 1000).toFixed(0)} t  ` +
          `shore ${shore.flooded ? 'FLOODED' : 'dry'} (${shore.effectiveSpeed.toFixed(2)})`);
      }
    }
    console.log(`  [4] eight hours: min pool level ${minLevel.toFixed(2)} m (racks at ${SFP_RACK_TOP} m), ` +
      `peak clad ${maxClad.toFixed(0)} C, longest uncovery ${worstUncovered.toFixed(0)} s, ` +
      `shore pump drowned at t=${floodedAt.toFixed(0)} s and restarted at t=${recoveredAt.toFixed(0)} s; ` +
      `tanks ${(tanks0 / 1000).toFixed(0)} t -> ${(minTanks / 1000).toFixed(0)} t ` +
      `(${((tanks0 - minTanks) / 1000).toFixed(0)} t drawn, ` +
      `${(100 * minTanks / tanks0).toFixed(0)}% left)`);
    if (!(minTanks > 0.05 * tanks0)) {
      fail(`the tanks must still hold a margin at the end, they fell to ` +
        `${(minTanks / 1000).toFixed(0)} t of ${(tanks0 / 1000).toFixed(0)} t`);
    }
    if (!(worstUncovered < SFP_GRACE)) fail(`the answer must keep the racks covered, uncovered for ${worstUncovered.toFixed(0)} s`);
    if (!(maxClad < 600)) fail(`cladding must stay below the 600 C limit, peaked at ${maxClad.toFixed(0)} C`);
    if (!(floodedAt > 0)) fail('the tsunami must drown a pump standing on the shore');
    if (!(recoveredAt > floodedAt)) fail('the shore pump must restart once the sea has gone back down');
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
