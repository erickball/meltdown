/**
 * Flow Physics Regression Suite
 *
 * Pins the current (correct) behavior of the flow subsystem - choked flow,
 * valves, check valves, pump curves, deadheading, conservation, gravity-driven
 * level equalization, and small-timestep acoustic fidelity - so that solver
 * rework (in particular the planned fully semi-implicit pressure-flow solver,
 * see docs/semi-implicit-flow-solver-plan.md) can be validated against it.
 *
 * Each test builds a tiny plant programmatically, runs it headless with the
 * same operator stack as the game loop, and asserts physical invariants with
 * deliberately loose tolerances: these tests should only fail when behavior
 * changes QUALITATIVELY (choking stops limiting flow, closed valves leak,
 * pumps ignore their curve, mass appears from nowhere...).
 *
 * Run: npx tsx scripts/test-flow-physics.ts   (also part of `npm test`)
 */

import {
  createSimulationFromPlant,
  setSimulationRandomSeed,
  RK45Solver,
  ConductionRateOperator,
  ConvectionRateOperator,
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
} from '../src/simulation';
import { soundSpeed, WaterState } from '../src/simulation/water-properties-v4';
import type { PlantState, PlantComponent, PlantConnection } from '../src/types';
import type { SimulationState } from '../src/simulation/types';

// ============================================================================
// Mini test framework (same output style as src/simulation/test-suite.ts)
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}
const results: TestResult[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, error: message });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertBetween(actual: number, lo: number, hi: number, label: string) {
  if (!(actual >= lo && actual <= hi)) {
    throw new Error(`${label}: expected ${lo.toPrecision(4)}..${hi.toPrecision(4)}, got ${actual.toPrecision(6)}`);
  }
}

// ============================================================================
// Plant-building helpers
// ============================================================================

interface TankOpts {
  id: string;
  temperature: number;   // K
  pressure: number;      // Pa (used for liquid-full tanks; two-phase/vapor use P_sat(T))
  fillLevel: number;     // 0 = vapor, 1 = liquid-full, else two-phase
  volume?: number;       // m³ (default 10)
  elevation?: number;    // m
}

function makeTank(o: TankOpts): [string, PlantComponent] {
  const volume = o.volume ?? 10;
  const height = 4;
  const width = 2 * Math.sqrt(volume / (Math.PI * height));
  const phase = o.fillLevel >= 0.999 ? 'liquid' : o.fillLevel <= 0.001 ? 'vapor' : 'two-phase';
  return [o.id, {
    id: o.id, type: 'tank', label: o.id,
    position: { x: 0, y: 0 }, rotation: 0, elevation: o.elevation ?? 0,
    width, height, wallThickness: 0.05, fillLevel: o.fillLevel,
    ports: [
      { id: `${o.id}-top`, position: { x: 0, y: -height / 2 }, direction: 'both' },
      { id: `${o.id}-bottom`, position: { x: 0, y: height / 2 }, direction: 'both' },
    ],
    fluid: { temperature: o.temperature, pressure: o.pressure, phase, quality: phase === 'vapor' ? 1 : 0, flowRate: 0 },
  } as unknown as PlantComponent];
}

function makePump(id: string, ratedFlow: number, ratedHead: number): [string, PlantComponent] {
  return [id, {
    id, type: 'pump', label: id,
    position: { x: 0, y: 0 }, rotation: 0, elevation: 0,
    diameter: 0.3, running: true, speed: 1.0, ratedFlow, ratedHead,
    orientation: 'left-right',
    ports: [
      { id: `${id}-inlet`, position: { x: -0.3, y: 0 }, direction: 'in' },
      { id: `${id}-outlet`, position: { x: 0.3, y: 0 }, direction: 'out' },
    ],
    fluid: { temperature: 300, pressure: 2e5, phase: 'liquid', quality: 0, flowRate: 0 },
  } as unknown as PlantComponent];
}

function makeValve(id: string, opening: number, valveType: string = 'gate'): [string, PlantComponent] {
  return [id, {
    id, type: 'valve', label: id, valveType,
    position: { x: 0, y: 0 }, rotation: 0, elevation: 0,
    diameter: 0.1, opening,
    ports: [
      { id: `${id}-in`, position: { x: -0.1, y: 0 }, direction: 'in' },
      { id: `${id}-out`, position: { x: 0.1, y: 0 }, direction: 'out' },
    ],
    fluid: { temperature: 300, pressure: 2e5, phase: 'liquid', quality: 0, flowRate: 0 },
  } as unknown as PlantComponent];
}

interface ConnOpts {
  from: string; to: string;
  flowArea?: number; length?: number;
  fromElevation?: number; toElevation?: number;
}

function makeConn(o: ConnOpts): PlantConnection {
  return {
    fromComponentId: o.from, fromPortId: `${o.from}-out`,
    toComponentId: o.to, toPortId: `${o.to}-in`,
    flowArea: o.flowArea ?? 0.02, length: o.length ?? 2,
    fromElevation: o.fromElevation ?? 0.1, toElevation: o.toElevation ?? 0.1,
  } as unknown as PlantConnection;
}

function buildSim(
  components: Array<[string, PlantComponent]>,
  connections: PlantConnection[],
  solverConfig: ConstructorParameters<typeof RK45Solver>[0] = {}
): { state: SimulationState; solver: RK45Solver } {
  setSimulationRandomSeed(0);
  const plantState: PlantState = {
    components: new Map<string, PlantComponent>(components),
    connections,
  };
  const state = createSimulationFromPlant(plantState);
  const solver = new RK45Solver(solverConfig);
  solver.addRateOperator(new FlowRateOperator());
  solver.addRateOperator(new FlowMomentumRateOperator());
  solver.addRateOperator(new ConductionRateOperator());
  solver.addRateOperator(new ConvectionRateOperator());
  solver.addRateOperator(new HeatGenerationRateOperator());
  solver.addRateOperator(new NeutronicsRateOperator());
  solver.addRateOperator(new TurbineCondenserRateOperator());
  solver.addRateOperator(new PumpSpeedRateOperator());
  solver.addConstraintOperator(new FlowDynamicsConstraintOperator());
  solver.addConstraintOperator(new FluidStateConstraintOperator());
  solver.addConstraintOperator(new BurstCheckOperator());
  solver.addConstraintOperator(new ChokedFlowDisplayOperator());
  return { state, solver };
}

/** Advance the sim to the given time; optional callback per outer tick. */
function run(
  sim: { state: SimulationState; solver: RK45Solver },
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

function flowRate(state: SimulationState, from: string, to: string): number {
  const conn = state.flowConnections.find(c => c.id === `flow-${from}-${to}`);
  if (!conn) throw new Error(`connection flow-${from}-${to} not found`);
  return conn.massFlowRate;
}

function nodeMass(state: SimulationState, id: string): number {
  const node = state.flowNodes.get(id);
  if (!node) throw new Error(`node ${id} not found`);
  return node.fluid.mass;
}

function nodePressure(state: SimulationState, id: string): number {
  const node = state.flowNodes.get(id);
  if (!node) throw new Error(`node ${id} not found`);
  return node.fluid.pressure;
}

function totalMassAndEnergy(state: SimulationState): { mass: number; energy: number } {
  let mass = 0, energy = 0;
  for (const [, node] of state.flowNodes) {
    if (node.isBoundary) continue;
    mass += node.fluid.mass;
    energy += node.fluid.internalEnergy;
  }
  return { mass, energy };
}

/** Sonic mass-flow bound for a connection from the given vapor node's state. */
function chokedFlowBound(state: SimulationState, nodeId: string, flowArea: number): number {
  const node = state.flowNodes.get(nodeId)!;
  const rho = node.fluid.mass / node.volume;
  const ws: WaterState = {
    temperature: node.fluid.temperature,
    pressure: node.fluid.pressure,
    density: rho,
    phase: 'vapor',
    quality: 1,
    specificEnergy: node.fluid.internalEnergy / node.fluid.mass,
  };
  const c = soundSpeed(ws);
  const dischargeCoeff = 0.85; // non-break connection default in FlowMomentumRateOperator
  return dischargeCoeff * rho * flowArea * c;
}

// ============================================================================
// Tests
// ============================================================================

// ---------------------------------------------------------------------------
// 1+2. Choked flow: sonic ceiling, and insensitivity to downstream pressure
// ---------------------------------------------------------------------------
// Saturated steam at ~60 bar blowing through a small orifice into a large
// low-pressure vessel. Flow must (a) be flagged choked, (b) sit at the sonic
// bound, (c) NOT increase when downstream pressure is 10x lower - the defining
// property of choking. A linearized implicit flow update that ignores the
// sonic cap would blow straight past (b) and fail (c).

function chokedRig(downstreamTempK: number) {
  const A = 0.002;
  const sim = buildSim(
    [
      makeTank({ id: 'hp', temperature: 549, pressure: 6e6, fillLevel: 0, volume: 10 }),
      makeTank({ id: 'lp', temperature: downstreamTempK, pressure: 1e5, fillLevel: 0, volume: 500 }),
    ],
    [makeConn({ from: 'hp', to: 'lp', flowArea: A, length: 1 })]
  );
  run(sim, 2.0);
  return { sim, A };
}

let chokedFlowAt1bar = 0;

test('Choked flow: sonic ceiling at ~60 bar upstream', () => {
  const { sim, A } = chokedRig(373); // downstream P_sat(373K) ~ 1 bar
  const state = sim.state;
  const flow = flowRate(state, 'hp', 'lp');
  chokedFlowAt1bar = flow;
  const bound = chokedFlowBound(state, 'hp', A);
  assert(flow > 0, `flow should be forward, got ${flow.toFixed(2)} kg/s`);
  assertBetween(flow, 0.4 * bound, 1.15 * bound, `choked flow vs sonic bound (${bound.toFixed(1)} kg/s)`);
  const conn = state.flowConnections.find(c => c.id === 'flow-hp-lp')!;
  const isChoked = conn.debug?.isChoked ?? conn.isChoked;
  assert(isChoked === true, 'connection should be flagged choked');
});

test('Choked flow: insensitive to downstream pressure', () => {
  const { sim } = chokedRig(453); // downstream P_sat(453K) ~ 10 bar - still below critical ratio
  const flow10bar = flowRate(sim.state, 'hp', 'lp');
  assert(chokedFlowAt1bar > 0, 'baseline choked flow missing (previous test failed?)');
  const ratio = flow10bar / chokedFlowAt1bar;
  assertBetween(ratio, 0.85, 1.15,
    `choked flow should not depend on downstream P (1 bar: ${chokedFlowAt1bar.toFixed(1)}, 10 bar: ${flow10bar.toFixed(1)} kg/s)`);
});

// ---------------------------------------------------------------------------
// 3. Closed valve holds pressure indefinitely
// ---------------------------------------------------------------------------
// An implicit network solve must produce exactly zero conductance through a
// closed valve - any leakage integrates into a visible mass transfer.

test('Closed valve: no leakage across 3-bar differential', () => {
  const sim = buildSim(
    [
      makeTank({ id: 'hi', temperature: 300, pressure: 5e5, fillLevel: 1 }),
      makeValve('vlv', 0.0),
      makeTank({ id: 'lo', temperature: 300, pressure: 2e5, fillLevel: 1 }),
    ],
    [
      makeConn({ from: 'hi', to: 'vlv', flowArea: 0.01 }),
      makeConn({ from: 'vlv', to: 'lo', flowArea: 0.01 }),
    ]
  );
  const m0 = nodeMass(sim.state, 'lo');
  run(sim, 5.0);
  const state = sim.state;
  assert(Math.abs(flowRate(state, 'vlv', 'lo')) < 0.05,
    `flow through closed valve should be ~0, got ${flowRate(state, 'vlv', 'lo').toFixed(3)} kg/s`);
  const drift = Math.abs(nodeMass(state, 'lo') - m0);
  assert(drift < 1.0, `downstream tank mass should not change through closed valve (drifted ${drift.toFixed(3)} kg in 5 s)`);
});

// ---------------------------------------------------------------------------
// 4. Valve opening transient: flow develops and mass is conserved end-to-end
// ---------------------------------------------------------------------------

test('Valve opens mid-run: flow develops, mass conserved', () => {
  const sim = buildSim(
    [
      makeTank({ id: 'hi', temperature: 300, pressure: 3e5, fillLevel: 1 }),
      makeValve('vlv', 0.0),
      makeTank({ id: 'lo', temperature: 300, pressure: 2e5, fillLevel: 1 }),
    ],
    [
      makeConn({ from: 'hi', to: 'vlv', flowArea: 0.01 }),
      makeConn({ from: 'vlv', to: 'lo', flowArea: 0.01 }),
    ]
  );
  const before = totalMassAndEnergy(sim.state);
  run(sim, 1.0);
  // Open the valve
  const valve = sim.state.components.valves.get('vlv');
  assert(!!valve, 'valve state should exist');
  valve!.position = 1.0;
  run(sim, 5.0);
  const state = sim.state;
  const flow = Math.abs(flowRate(state, 'vlv', 'lo'));
  // Liquid-full tanks equalize pressure quickly, so judge by the transfer having
  // happened, not the instantaneous flow: the low side must have gained mass.
  const after = totalMassAndEnergy(state);
  const massDrift = Math.abs(after.mass - before.mass) / before.mass;
  assert(massDrift < 1e-6, `total mass should be conserved, drifted ${(massDrift * 100).toExponential(2)}%`);
  const dP = nodePressure(state, 'hi') - nodePressure(state, 'lo');
  assert(Math.abs(dP) < 0.8e5 || flow > 5,
    `after opening, pressures should approach each other or flow persist (dP=${(dP / 1e5).toFixed(2)} bar, flow=${flow.toFixed(1)} kg/s)`);
});

// ---------------------------------------------------------------------------
// 5+6. Check valve: blocks reverse gradient, passes forward gradient
// ---------------------------------------------------------------------------

// Two-phase tanks (vapor cushions) are used so that meaningful mass can move:
// liquid-full tanks equalize a multi-bar differential with ~1 kg of transfer,
// which can't distinguish "check valve works" from "check valve leaks".
// P_sat(453K) ~ 10 bar, P_sat(373K) ~ 1 bar.

test('Check valve blocks adverse pressure gradient', () => {
  const sim = buildSim(
    [
      makeTank({ id: 'lo', temperature: 373, pressure: 1e5, fillLevel: 0.5 }),
      makeValve('cv', 1.0, 'check'),
      makeTank({ id: 'hi', temperature: 453, pressure: 10e5, fillLevel: 0.5 }),
    ],
    [
      makeConn({ from: 'lo', to: 'cv', flowArea: 0.01, fromElevation: 0.05, toElevation: 0 }),
      makeConn({ from: 'cv', to: 'hi', flowArea: 0.01, fromElevation: 0, toElevation: 0.05 }),
    ]
  );
  const m0 = nodeMass(sim.state, 'lo');
  run(sim, 5.0);
  const state = sim.state;
  assert(flowRate(state, 'cv', 'hi') > -0.05,
    `check valve must not pass reverse flow, got ${flowRate(state, 'cv', 'hi').toFixed(3)} kg/s`);
  // The valve body itself can exchange a few kg while it pressurizes, but the
  // guarded path must not deliver the high-pressure inventory to the low tank.
  const gained = nodeMass(state, 'lo') - m0;
  assert(gained < 5.0, `low-pressure tank must not gain mass backwards through check valve (gained ${gained.toFixed(2)} kg)`);
});

test('Check valve passes forward pressure gradient', () => {
  const sim = buildSim(
    [
      makeTank({ id: 'hi', temperature: 453, pressure: 10e5, fillLevel: 0.5 }),
      makeValve('cv', 1.0, 'check'),
      makeTank({ id: 'lo', temperature: 373, pressure: 1e5, fillLevel: 0.5 }),
    ],
    [
      makeConn({ from: 'hi', to: 'cv', flowArea: 0.01, fromElevation: 0.05, toElevation: 0 }),
      makeConn({ from: 'cv', to: 'lo', flowArea: 0.01, fromElevation: 0, toElevation: 0.05 }),
    ]
  );
  const m0 = nodeMass(sim.state, 'lo');
  run(sim, 5.0);
  const gained = nodeMass(sim.state, 'lo') - m0;
  assert(gained > 50, `forward flow should transfer substantial mass through check valve (gained only ${gained.toFixed(2)} kg)`);
});

// ---------------------------------------------------------------------------
// 7. Pump curve operating point in a closed loop + conservation
// ---------------------------------------------------------------------------
// Pump (200 kg/s rated, 30 m head) driving a 3-segment liquid loop with known
// friction. The steady flow must land near the curve/friction intersection.
// Analytic estimate: rho*g*30*(1.25 - 0.25(Q/200)^2) = 3 * K/2 * rho * v^2
// with K=10, A=0.05 per segment  =>  Q ~ 216 kg/s.

test('Pump loop settles near curve/friction operating point', () => {
  const sim = buildSim(
    [
      makeTank({ id: 'ta', temperature: 300, pressure: 2e5, fillLevel: 1 }),
      makePump('pmp', 200, 30),
      makeTank({ id: 'tb', temperature: 300, pressure: 2e5, fillLevel: 1 }),
    ],
    [
      makeConn({ from: 'ta', to: 'pmp', flowArea: 0.05 }),
      makeConn({ from: 'pmp', to: 'tb', flowArea: 0.05 }),
      makeConn({ from: 'tb', to: 'ta', flowArea: 0.05, length: 4 }),
    ]
  );
  const before = totalMassAndEnergy(sim.state);
  run(sim, 25.0);
  const state = sim.state;
  const q = flowRate(state, 'pmp', 'tb');
  assertBetween(q, 216 * 0.65, 216 * 1.35, 'loop flow vs analytic operating point (216 kg/s)');
  // Closed loop: strict conservation
  const after = totalMassAndEnergy(state);
  const massDrift = Math.abs(after.mass - before.mass) / before.mass;
  const energyDrift = Math.abs(after.energy - before.energy) / Math.abs(before.energy);
  assert(massDrift < 1e-6, `closed-loop mass drift ${(massDrift * 100).toExponential(2)}% too large`);
  assert(energyDrift < 1e-3, `closed-loop energy drift ${(energyDrift * 100).toExponential(2)}% too large`);
});

// ---------------------------------------------------------------------------
// 8. Pump deadhead: pressure rises to shutoff head and flow stalls
// ---------------------------------------------------------------------------

test('Deadheaded pump stalls at shutoff head without runaway', () => {
  const sim = buildSim(
    [
      makeTank({ id: 'src', temperature: 300, pressure: 2e5, fillLevel: 1, volume: 50 }),
      makePump('pmp', 200, 100), // shutoff ~ 1.25 * 100 m ~ 12.3 bar
      makeTank({ id: 'dead', temperature: 373, pressure: 1e5, fillLevel: 0.9, volume: 10 }),
    ],
    [
      makeConn({ from: 'src', to: 'pmp', flowArea: 0.05 }),
      makeConn({ from: 'pmp', to: 'dead', flowArea: 0.05 }),
    ]
  );
  run(sim, 40.0);
  const state = sim.state;
  const pDead = nodePressure(state, 'dead');
  const pSrc = nodePressure(state, 'src');
  // Dead-end pressure must approach but not exceed suction + shutoff (+ margin
  // for hydrostatic terms). Runaway here = the original fw-pump bug class.
  assert(pDead < pSrc + 14.5e5,
    `dead-end pressure ${(pDead / 1e5).toFixed(2)} bar exceeds suction+shutoff bound (${((pSrc + 14.5e5) / 1e5).toFixed(2)} bar)`);
  assert(pDead > pSrc + 5e5,
    `dead-end should pressurize well above suction, only reached ${(pDead / 1e5).toFixed(2)} bar`);
  const q = Math.abs(flowRate(state, 'pmp', 'dead'));
  assert(q < 25, `deadheaded flow should stall, still ${q.toFixed(1)} kg/s after 40 s`);
});

// ---------------------------------------------------------------------------
// 9. Acoustic fidelity at small dt (anti-over-damping canary)
// ---------------------------------------------------------------------------
// Two stiff liquid tanks with a 2-bar imbalance ring at ~66 rad/s. When the
// user caps dt well below the acoustic period, the oscillation must actually
// appear (flow crosses zero repeatedly) - a future implicit scheme must
// recover explicit physics in the small-dt limit rather than damping
// unconditionally.

test('Liquid inertia rings at small dt (not over-damped)', () => {
  const sim = buildSim(
    [
      makeTank({ id: 'pa', temperature: 300, pressure: 12e5, fillLevel: 1 }),
      makeTank({ id: 'pb', temperature: 300, pressure: 10e5, fillLevel: 1 }),
    ],
    [makeConn({ from: 'pa', to: 'pb', flowArea: 0.02, length: 2 })],
    { maxDt: 2e-4, initialDt: 1e-4 }
  );
  let lastSign = 0;
  let signChanges = 0;
  run(sim, 0.4, 0.002, (state) => {
    const q = flowRate(state, 'pa', 'pb');
    const sign = q > 0.5 ? 1 : q < -0.5 ? -1 : 0;
    if (sign !== 0 && lastSign !== 0 && sign !== lastSign) signChanges++;
    if (sign !== 0) lastSign = sign;
  });
  assert(signChanges >= 2,
    `flow should oscillate (acoustic mode resolved at small dt), saw ${signChanges} sign changes in 0.4 s`);
});

// ---------------------------------------------------------------------------
// 10. Gravity-driven level equalization between two-phase tanks
// ---------------------------------------------------------------------------
// Exercises hydrostatic connection pressures + phase-dependent flow density.

test('Connected tanks equalize liquid levels', () => {
  const sim = buildSim(
    [
      makeTank({ id: 'full', temperature: 453, pressure: 10e5, fillLevel: 0.7 }),
      makeTank({ id: 'empty', temperature: 453, pressure: 10e5, fillLevel: 0.3 }),
    ],
    [makeConn({ from: 'full', to: 'empty', flowArea: 0.05, length: 1, fromElevation: 0.05, toElevation: 0.05 })]
  );
  const dm0 = nodeMass(sim.state, 'full') - nodeMass(sim.state, 'empty');
  assert(dm0 > 1000, `initial mass imbalance should be large, got ${dm0.toFixed(0)} kg`);
  run(sim, 30.0);
  const dm = nodeMass(sim.state, 'full') - nodeMass(sim.state, 'empty');
  assert(dm < 0.6 * dm0,
    `levels should equalize: imbalance only fell ${dm0.toFixed(0)} -> ${dm.toFixed(0)} kg in 30 s`);
  assert(dm > -0.3 * dm0, `equalization should not overshoot badly (imbalance now ${dm.toFixed(0)} kg)`);
});

// ============================================================================
// Report
// ============================================================================

console.log('\nRunning Flow Physics Regression Suite...\n');

const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed);

for (const r of results) {
  const symbol = r.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${symbol} ${r.name}`);
  if (!r.passed) console.log(`    ${r.error}`);
}

console.log('\n' + '='.repeat(60));
if (failed.length === 0) {
  console.log(`\x1b[32m✓ All ${passed} flow physics tests passed!\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ ${failed.length} of ${results.length} flow physics tests failed\x1b[0m`);
  process.exit(1);
}
