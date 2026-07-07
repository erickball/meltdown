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
 *   1: level1-site.json + level1-player-reactor.json, expect >=150 MWe
 */

import * as fs from 'fs';
import * as path from 'path';

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
  BurstCheckOperator,
  ControlSystemOperator,
  getTurbineCondenserState,
} from '../src/simulation';
import type { PlantState, PlantComponent, PlantConnection } from '../src/types';

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
  solver.addConstraintOperator(new FlowDynamicsConstraintOperator());
  solver.addConstraintOperator(new FluidStateConstraintOperator());
  solver.addConstraintOperator(new BurstCheckOperator());
  solver.addConstraintOperator(new ControlSystemOperator());
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
}

const CHECKS: Record<string, LevelCheck> = {
  '1': {
    name: 'Level 1: FIRST LIGHT (stock site + reference player reactor)',
    parts: [
      'src/game-mode/levels/level1-site.json',
      'scripts/game-level-solutions/level1-player-reactor.json',
    ],
    targetMWe: 150,
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

async function main() {
  const which = process.argv[2] ?? 'all';
  const simSeconds = process.argv[3] ? parseFloat(process.argv[3]) : undefined;
  const keys = which === 'all' ? Object.keys(CHECKS) : [which];
  let allPass = true;
  for (const key of keys) {
    const check = CHECKS[key];
    if (!check) {
      console.error(`Unknown level check '${key}'. Available: ${Object.keys(CHECKS).join(', ')}`);
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
