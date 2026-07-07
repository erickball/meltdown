/**
 * Shared harness for headless simulation test scripts.
 *
 * Builds simulations with the same operator stack as the game loop, runs them
 * deterministically, and provides a mini test framework with the same console
 * output style as src/simulation/test-suite.ts.
 */

import * as fs from 'fs';
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
  ChokedFlowDisplayOperator,
  PumpSpeedRateOperator,
  BurstCheckOperator,
  ControlSystemOperator,
  SteadyStateDetector,
} from '../../src/simulation';
import type { PlantState, PlantComponent, PlantConnection } from '../../src/types';
import type { SimulationState } from '../../src/simulation/types';

// ============================================================================
// Test framework
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

export function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, error: message });
  }
}

export function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function assertBetween(actual: number, lo: number, hi: number, label: string) {
  if (!(actual >= lo && actual <= hi)) {
    throw new Error(`${label}: expected ${lo.toPrecision(4)}..${hi.toPrecision(4)}, got ${actual.toPrecision(6)}`);
  }
}

/** Print results and exit with the appropriate code. */
export function report(suiteName: string): never {
  console.log(`\nRunning ${suiteName}...\n`);
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed);

  for (const r of results) {
    const symbol = r.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`${symbol} ${r.name}`);
    if (!r.passed) console.log(`    ${r.error}`);
  }

  console.log('\n' + '='.repeat(60));
  if (failed.length === 0) {
    console.log(`\x1b[32m✓ All ${passed} ${suiteName} tests passed!\x1b[0m`);
    process.exit(0);
  } else {
    console.log(`\x1b[31m✗ ${failed.length} of ${results.length} ${suiteName} tests failed\x1b[0m`);
    process.exit(1);
  }
}

// ============================================================================
// Simulation construction and execution
// ============================================================================

export interface Sim {
  state: SimulationState;
  solver: RK45Solver;
}

export function buildSim(
  components: Array<[string, PlantComponent]>,
  connections: PlantConnection[],
  solverConfig: ConstructorParameters<typeof RK45Solver>[0] = {}
): Sim {
  setSimulationRandomSeed(0);
  const plantState: PlantState = {
    components: new Map<string, PlantComponent>(components),
    connections,
  };
  return { state: createSimulationFromPlant(plantState), solver: makeSolver(solverConfig) };
}

export function buildSimFromFile(
  path: string,
  solverConfig: ConstructorParameters<typeof RK45Solver>[0] = {}
): Sim {
  const data = JSON.parse(fs.readFileSync(path, 'utf-8'));
  const plantState: PlantState = {
    components: new Map<string, PlantComponent>(data.components),
    connections: data.connections ?? [],
  };
  setSimulationRandomSeed(0);
  return { state: createSimulationFromPlant(plantState), solver: makeSolver(solverConfig) };
}

function makeSolver(config: ConstructorParameters<typeof RK45Solver>[0]): RK45Solver {
  // A/B override for the implicit momentum solve (semi-implicit-flow-solver
  // plan): IMPLICIT_MOMENTUM=1 forces it on, =0 forces it off, unset uses the
  // shipping default. Lets every suite in scripts/ run against both schemes.
  const env = process.env.IMPLICIT_MOMENTUM;
  if (env !== undefined && config.pressureSolver !== false) {
    config = {
      ...config,
      pressureSolver: {
        ...(typeof config.pressureSolver === 'object' ? config.pressureSolver : {}),
        implicitMomentum: env === '1',
      },
    };
  }
  const solver = new RK45Solver(config);
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
  solver.addConstraintOperator(new ChokedFlowDisplayOperator());
  // Sampled process controllers act last, on the accepted state (finalOnly)
  solver.addConstraintOperator(new ControlSystemOperator());
  return solver;
}

/** Advance the sim to the given time; optional callback per outer tick. */
export function run(
  sim: Sim,
  seconds: number,
  dt = 0.02,
  onTick?: (state: SimulationState) => void
): SimulationState {
  let state = sim.state;
  const ticks = Math.round(seconds / dt);
  for (let i = 0; i < ticks; i++) {
    state = sim.solver.advance(state, dt).state;
    state.pendingEvents = [];
    onTick?.(state);
  }
  sim.state = state;
  return state;
}

// ============================================================================
// State inspection helpers
// ============================================================================

export function flowRate(state: SimulationState, from: string, to: string): number {
  const conn = state.flowConnections.find(c => c.id === `flow-${from}-${to}`);
  if (!conn) throw new Error(`connection flow-${from}-${to} not found`);
  return conn.massFlowRate;
}

export function nodeMass(state: SimulationState, id: string): number {
  const node = state.flowNodes.get(id);
  if (!node) throw new Error(`node ${id} not found`);
  return node.fluid.mass;
}

export function nodePressure(state: SimulationState, id: string): number {
  const node = state.flowNodes.get(id);
  if (!node) throw new Error(`node ${id} not found`);
  return node.fluid.pressure;
}

/**
 * Run the sim until the SteadyStateDetector declares steady, or maxSeconds
 * elapses. Returns whether steady was reached plus the detector for
 * diagnostics. tickDt is the outer advance() granularity.
 */
export function runUntilSteady(
  sim: Sim,
  maxSeconds: number,
  tickDt = 0.5,
  detectorConfig: ConstructorParameters<typeof SteadyStateDetector>[0] = {}
): { steady: boolean; detector: SteadyStateDetector; elapsed: number } {
  const detector = new SteadyStateDetector(detectorConfig);
  detector.update(sim.state);
  const start = sim.state.time;
  while (sim.state.time - start < maxSeconds) {
    run(sim, tickDt, tickDt);
    detector.update(sim.state);
    if (detector.isSteady()) {
      return { steady: true, detector, elapsed: sim.state.time - start };
    }
  }
  return { steady: false, detector, elapsed: sim.state.time - start };
}

export function totalMassAndEnergy(state: SimulationState): { mass: number; energy: number } {
  let mass = 0, energy = 0;
  for (const [, node] of state.flowNodes) {
    if (node.isBoundary) continue;
    mass += node.fluid.mass;
    energy += node.fluid.internalEnergy;
  }
  return { mass, energy };
}

/**
 * Assert every non-boundary node is in a physically sane state and that no
 * component has burst (unless its id is listed in allowedBursts).
 */
export function assertStateSane(state: SimulationState, allowedBursts: string[] = []): void {
  for (const [id, node] of state.flowNodes) {
    if (node.isBoundary) continue;
    const P = node.fluid.pressure;
    const T = node.fluid.temperature;
    const m = node.fluid.mass;
    assert(isFinite(P) && P > 700 && P < 30e6,
      `${id}: pressure ${(P / 1e5).toFixed(3)} bar outside sane range`);
    assert(isFinite(T) && T > 273 && T < 2500, `${id}: temperature ${T.toFixed(1)} K outside sane range`);
    assert(isFinite(m) && m > 0, `${id}: mass ${m} invalid`);
  }
  if (state.burstStates) {
    for (const [nodeId, burst] of state.burstStates) {
      if (burst.isBurst && !allowedBursts.includes(nodeId)) {
        throw new Error(`unexpected burst: ${burst.componentLabel} (${nodeId}) at t=${burst.burstTime?.toFixed(2)}s`);
      }
    }
  }
}
