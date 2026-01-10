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
  HeatGenerationRateOperator,
  NeutronicsRateOperator,
  FlowRateOperator,
  FlowMomentumRateOperator,
  TurbineCondenserRateOperator,
  FluidStateConstraintOperator,
  FlowDynamicsConstraintOperator,
  PumpSpeedRateOperator,
  BurstCheckOperator,
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
const solver = new RK45Solver();

// Add rate operators (order matters!)
solver.addRateOperator(new FlowRateOperator());
solver.addRateOperator(new FlowMomentumRateOperator());
solver.addRateOperator(new ConductionRateOperator());
solver.addRateOperator(new ConvectionRateOperator());
solver.addRateOperator(new HeatGenerationRateOperator());
solver.addRateOperator(new NeutronicsRateOperator());
solver.addRateOperator(new TurbineCondenserRateOperator());
solver.addRateOperator(new PumpSpeedRateOperator());

// Add constraint operators
solver.addConstraintOperator(new FlowDynamicsConstraintOperator());
solver.addConstraintOperator(new FluidStateConstraintOperator());
solver.addConstraintOperator(new BurstCheckOperator());

// Log initial state
console.log('\n=== Initial State ===');
logSimState(simState);

// Run simulation
console.log(`\n=== Running ${numTicks} ticks (dt=${dt}s) ===\n`);

let state = simState;
let lastLogTime = 0;
const logInterval = 1.0; // Log every 1 second of sim time

try {
  for (let tick = 0; tick < numTicks; tick++) {
    const result = solver.advance(state, dt);
    state = result.state;

    // Log periodically
    if (state.time - lastLogTime >= logInterval || tick === numTicks - 1) {
      console.log(`\n--- t = ${state.time.toFixed(2)}s (tick ${tick + 1}) ---`);
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

// Helper function to log simulation state
function logSimState(state: SimulationState): void {
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

  // Log flows
  if (state.flowConnections.length > 0) {
    console.log('\nFlows:');
    for (const conn of state.flowConnections) {
      if (Math.abs(conn.massFlowRate) > 0.001) {
        console.log(`  ${conn.fromNodeId} -> ${conn.toNodeId}: ${conn.massFlowRate.toFixed(3)} kg/s`);
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
