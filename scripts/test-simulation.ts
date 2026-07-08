/**
 * Headless simulation test runner
 *
 * Usage: npx tsx scripts/test-simulation.ts <plant-file.json> [ticks]
 *
 * Loads a plant configuration from JSON and runs the simulation for the specified
 * number of ticks (default 100), logging state at each step.
 */

import * as fs from 'fs';

// Import simulation modules - use same pattern as game loop
import {
  createSimulationFromPlant,
  setSimulationRandomSeed,
  RK45Solver,
  ConductionRateOperator,
  ConvectionRateOperator,
  CladdingOxidationRateOperator,
  HydrogenCombustionRateOperator,
  CoriumRelocationRateOperator,
  FissionProductReleaseOperator,
  meltFraction,
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
} from '../src/simulation';
import type { PlantState, PlantComponent, PlantConnection } from '../src/types';
import type { SimulationState } from '../src/simulation/types';

// Parse command line args
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log('Usage: npx tsx scripts/test-simulation.ts <plant-file.json> [ticks] [dt]');
  console.log('  plant-file.json: Path to plant configuration JSON file');
  console.log('  ticks: Number of simulation ticks to run (default 100)');
  console.log('  dt: Time step in seconds (default 0.01)');
  process.exit(1);
}

const plantFile = args[0];
const numTicks = parseInt(args[1] || '100', 10);
const dt = parseFloat(args[2] || '0.01');

// Load plant configuration
console.log(`Loading plant from: ${plantFile}`);
const plantJson = fs.readFileSync(plantFile, 'utf-8');
const plantData = JSON.parse(plantJson);

// Convert to PlantState
const plantState: PlantState = {
  components: new Map<string, PlantComponent>(),
  connections: [] as PlantConnection[],
};

if (plantData.components) {
  for (const [id, component] of plantData.components) {
    plantState.components.set(id, component);
  }
}

if (plantData.connections) {
  plantState.connections = plantData.connections;
}

console.log(`Loaded ${plantState.components.size} components, ${plantState.connections.length} connections`);

// Create simulation with deterministic random seed
console.log('\nCreating simulation...');
setSimulationRandomSeed(0);  // Use seed 0 for reproducibility
const simState = createSimulationFromPlant(plantState);

console.log(`Created simulation with ${simState.flowNodes.size} flow nodes, ${simState.flowConnections.length} flow connections`);

// Create solver with operators (same setup as game loop)
// Env overrides for accuracy-vs-speed experiments:
//   RELTOL            RK45 relative error tolerance
//   MAXDT             maximum timestep (s)
//   IMPLICIT_MOMENTUM 1|0 forces the implicit pressure-flow momentum solve on/off
const relTol = process.env.RELTOL ? parseFloat(process.env.RELTOL) : undefined;
const maxDt = process.env.MAXDT ? parseFloat(process.env.MAXDT) : undefined;
const implicitEnv = process.env.IMPLICIT_MOMENTUM;
const quietTolEnv = process.env.QUIET_TOL;
const solverConfig: ConstructorParameters<typeof RK45Solver>[0] = {};
if (relTol) solverConfig.relTol = relTol;
if (maxDt) solverConfig.maxDt = maxDt;
if (quietTolEnv !== undefined) solverConfig.quietPressureToleranceScale = parseFloat(quietTolEnv);
if (implicitEnv !== undefined) solverConfig.pressureSolver = { implicitMomentum: implicitEnv === '1' };
const solver = new RK45Solver(solverConfig);
if (relTol) console.log(`[test-simulation] RK45 relTol overridden to ${relTol}`);
if (maxDt) console.log(`[test-simulation] RK45 maxDt overridden to ${maxDt}s`);
if (implicitEnv !== undefined) console.log(`[test-simulation] implicit momentum forced ${implicitEnv === '1' ? 'ON' : 'OFF'}`);

// Add rate operators (order matters!)
solver.addRateOperator(new FlowRateOperator());
solver.addRateOperator(new FlowMomentumRateOperator());
solver.addRateOperator(new ConductionRateOperator());
solver.addRateOperator(new ConvectionRateOperator());
solver.addRateOperator(new CladdingOxidationRateOperator());
solver.addRateOperator(new HydrogenCombustionRateOperator());
solver.addRateOperator(new CoriumRelocationRateOperator());
solver.addRateOperator(new FissionProductReleaseOperator());
solver.addRateOperator(new HeatGenerationRateOperator());
solver.addRateOperator(new NeutronicsRateOperator());
solver.addRateOperator(new TurbineCondenserRateOperator());
solver.addRateOperator(new PumpSpeedRateOperator());

// Add constraint operators
solver.addConstraintOperator(new FlowDynamicsConstraintOperator());
solver.addConstraintOperator(new FluidStateConstraintOperator());
solver.addConstraintOperator(new BurstCheckOperator());
solver.addConstraintOperator(new ControlSystemOperator());

// Log initial state
console.log('\n=== Initial State ===');
logSimState(simState);

// Run simulation
console.log(`\n=== Running ${numTicks} ticks (dt=${dt}s) ===\n`);

let state = simState;
let lastLogTime = 0;
const logInterval = 1.0; // Log every 1 second of sim time
const wallStart = performance.now();
const operatorTotals = new Map<string, number>();
let lastMetrics: ReturnType<typeof solver.advance>['metrics'] | null = null;

try {
  for (let tick = 0; tick < numTicks; tick++) {
    const result = solver.advance(state, dt);
    state = result.state;
    lastMetrics = result.metrics;
    for (const [name, ms] of result.metrics.operatorTimes) {
      operatorTotals.set(name, (operatorTotals.get(name) || 0) + ms);
    }

    // Log periodically
    if (state.time - lastLogTime >= logInterval || tick === numTicks - 1) {
      const wallSec = (performance.now() - wallStart) / 1000;
      console.log(`\n--- t = ${state.time.toFixed(2)}s (tick ${tick + 1}) ---`);
      console.log(`[perf] wall=${wallSec.toFixed(1)}s speed=${(state.time / wallSec).toFixed(2)}x realtime, ` +
        `steps=${result.metrics.totalSteps}, dt=${(result.metrics.currentDt * 1000).toFixed(2)}ms, ` +
        `rejects this frame=${result.metrics.retriesThisFrame}`);
      const contributors = result.metrics.topErrorContributors
        .map(c => `${c.nodeId}[${c.type}] ${(c.contribution * 100).toFixed(0)}% (${c.description})`)
        .join(', ');
      if (contributors) console.log(`[perf] error contributors: ${contributors}`);
      logSimState(state);
      lastLogTime = state.time;
    }

    // Check for pending events
    if (state.pendingEvents && state.pendingEvents.length > 0) {
      for (const event of state.pendingEvents) {
        console.log(`\n[EVENT] ${event.type}: ${event.message}`);
      }
      state.pendingEvents = [];
    }
  }
} catch (error) {
  console.error('\n[ERROR] Simulation failed:');
  console.error(error);
  console.log('\n=== Final State Before Error ===');
  if (state) {
    logSimState(state);
  }
  process.exit(1);
}

console.log('\n=== Simulation Complete ===');
{
  const wallSec = (performance.now() - wallStart) / 1000;
  const solverMetrics = solver.getMetrics();
  console.log(`Simulated ${state.time.toFixed(2)}s in ${wallSec.toFixed(1)}s wall time ` +
    `(${(state.time / wallSec).toFixed(2)}x realtime)`);
  console.log(`Total steps: ${solverMetrics.totalSteps}, rejected: ${solverMetrics.rejectedSteps}, ` +
    `final dt: ${(solverMetrics.currentDt * 1000).toFixed(2)}ms`);
  if (solver.rejectionStats.size > 0) {
    console.log('Rejection causes:');
    const sortedRejects = [...solver.rejectionStats.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cause, count] of sortedRejects.slice(0, 12)) {
      console.log(`  ${cause}: ${count}`);
    }
  }
  if (lastMetrics) {
    console.log('Operator wall time totals:');
    const sorted = [...operatorTotals.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, ms] of sorted) {
      console.log(`  ${name}: ${(ms / 1000).toFixed(2)}s`);
    }
  }
}

// Helper function to log simulation state
function logSimState(state: SimulationState): void {
  const nn = state.neutronics;
  if (nn && nn.nominalPower > 0) {
    console.log(`neutronics: P=${(nn.power / 1e6).toFixed(3)}MW (${(100 * nn.power / nn.nominalPower).toFixed(1)}%) ` +
      `C=${nn.precursorConcentration.toExponential(3)} reactivity=${nn.reactivity?.toExponential(3) ?? '?'}`);
  }
  for (const [id, tn] of state.thermalNodes) {
    const melt = meltFraction(tn);
    const extras = [
      melt > 0.001 ? ` MELT=${(melt * 100).toFixed(1)}%` : '',
      tn.oxidation && tn.oxidation.oxidizedFraction > 0.001
        ? ` oxidized=${(tn.oxidation.oxidizedFraction * 100).toFixed(1)}%` : '',
      tn.fissionProducts
        ? ` FP=${tn.fissionProducts.nobleGas.toFixed(1)}/${tn.fissionProducts.volatile.toFixed(1)}mol` : '',
    ].join('');
    console.log(`thermal ${id}: T=${(tn.temperature - 273.15).toFixed(1)}C heatGen=${(tn.heatGeneration / 1e6).toFixed(1)}MW${extras}`);
  }
  if (state.environmentalRelease) {
    const rel = state.environmentalRelease;
    if ((rel.Xe ?? 0) > 0.001 || (rel.CsI ?? 0) > 0.001) {
      console.log(`RADIOLOGICAL RELEASE to environment: Xe=${(rel.Xe ?? 0).toFixed(2)}mol CsI=${(rel.CsI ?? 0).toFixed(3)}mol`);
    }
  }
  for (const [nodeId, node] of state.flowNodes) {
    const fluid = node.fluid;
    const ncgMoles = fluid.ncg ?
      Object.values(fluid.ncg).reduce((a, b) => a + b, 0) : 0;

    console.log(`${nodeId}: ${fluid.phase} ` +
      `T=${(fluid.temperature - 273.15).toFixed(1)}C ` +
      `P=${(fluid.pressure / 1e5).toFixed(2)}bar ` +
      `m=${fluid.mass.toFixed(1)}kg ` +
      `x=${fluid.quality.toFixed(3)} ` +
      (ncgMoles > 0 ? `ncg=${ncgMoles.toFixed(1)}mol` : '')
    );
  }

  // Log actuator positions (governor valves, pump speeds, controller outputs)
  for (const [nodeId, node] of state.flowNodes) {
    if (node.governorValve !== undefined) {
      console.log(`governor ${nodeId}: ${node.governorValve.toFixed(3)}`);
    }
  }
  if (state.components.pumps) {
    for (const [id, pump] of state.components.pumps) {
      console.log(`pump ${id}: speed=${pump.speed.toFixed(3)}`);
    }
  }
  if (state.components.controllers) {
    for (const [id, ctl] of state.components.controllers) {
      console.log(`controller ${id}: out=${ctl.lastOutput.toFixed(4)} err=${ctl.lastError.toExponential(2)}`);
    }
  }

  // Log flows
  if (state.flowConnections.length > 0) {
    console.log('\nFlows:');
    for (const conn of state.flowConnections) {
      if (Math.abs(conn.massFlowRate) > 0.001) {
        const phase = (conn as any).currentFlowPhase;
        console.log(`  ${conn.fromNodeId} -> ${conn.toNodeId}: ${conn.massFlowRate.toFixed(3)} kg/s${phase ? ` [${phase}]` : ''}`);
      }
    }
  }

  // Log burst states
  if (state.burstStates && state.burstStates.size > 0) {
    console.log('\nBurst states:');
    for (const [nodeId, burst] of state.burstStates) {
      const status = burst.isBurst ?
        `BURST at t=${burst.burstTime?.toFixed(2)}s, break=${(burst.currentBreakFraction * 100).toFixed(1)}%` :
        `OK (burst at ${(burst.burstPressure / 1e5).toFixed(1)} bar)`;
      console.log(`  ${burst.componentLabel}: ${status}`);
    }
  }
}
