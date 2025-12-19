/**
 * Simulation Unit Tests
 *
 * Simple scenarios to verify physics behavior in isolation.
 * Run with: npx ts-node src/simulation/tests.ts
 */

import { SimulationState, FlowNode, FlowConnection } from './types';
import { Solver } from './solver';
import {
  FlowOperator,
  FluidStateUpdateOperator,
  ConvectionOperator,
  ConductionOperator,
  HeatGenerationOperator,
  createFluidState,
} from './operators';
import { createSimulationState, createDemoReactor } from './factory';
import { calculateState, setWaterPropsDebug, getBisectionStats } from './water-properties';

// ============================================================================
// Test Utilities
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  details?: string[];
}

function runTest(name: string, testFn: () => { passed: boolean; message: string; details?: string[] }): TestResult {
  try {
    const result = testFn();
    return { name, ...result };
  } catch (error) {
    return {
      name,
      passed: false,
      message: `Exception: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function assertClose(actual: number, expected: number, tolerance: number, label: string): { ok: boolean; msg: string } {
  const diff = Math.abs(actual - expected);
  const ok = diff <= tolerance;
  const msg = ok
    ? `${label}: ${actual.toFixed(4)} ≈ ${expected.toFixed(4)} ✓`
    : `${label}: ${actual.toFixed(4)} ≠ ${expected.toFixed(4)} (diff=${diff.toFixed(4)}, tol=${tolerance}) ✗`;
  return { ok, msg };
}

function formatState(node: FlowNode): string {
  const f = node.fluid;
  return `${node.id}: m=${f.mass.toFixed(1)}kg, U=${(f.internalEnergy/1e6).toFixed(3)}MJ, T=${(f.temperature-273).toFixed(1)}C, P=${(f.pressure/1e5).toFixed(2)}bar, ${f.phase}${f.phase === 'two-phase' ? ` x=${(f.quality*100).toFixed(1)}%` : ''}`;
}

// ============================================================================
// Test 1: Isolated Node - Conservation
// ============================================================================

function testIsolatedNodeConservation(): TestResult {
  return runTest('Isolated Node Conservation', () => {
    // Create a single node with no connections
    const state = createSimulationState();

    const volume = 10; // m³
    const node: FlowNode = {
      id: 'isolated-tank',
      label: 'Isolated Tank',
      fluid: createFluidState(400, 1e6, 'liquid', 0, volume), // 127°C liquid at 10 bar
      volume,
      hydraulicDiameter: 1,
      flowArea: 1,
      elevation: 0,
    };
    state.flowNodes.set(node.id, node);

    // No flow connections

    // Create solver with flow operator and fluid state update
    const solver = new Solver({
      minDt: 0.001,
      maxDt: 0.1,
    });
    solver.addOperator(new FlowOperator());
    solver.addOperator(new FluidStateUpdateOperator());

    // Record initial state
    const initialMass = node.fluid.mass;
    const initialEnergy = node.fluid.internalEnergy;

    const details: string[] = [];
    details.push(`Initial: ${formatState(node)}`);

    // Run for 10 seconds
    let currentState = state;
    for (let i = 0; i < 100; i++) {
      currentState = solver.advance(currentState, 0.1).state;
    }

    const finalNode = currentState.flowNodes.get('isolated-tank')!;
    details.push(`Final:   ${formatState(finalNode)}`);

    // Check conservation
    const massCheck = assertClose(finalNode.fluid.mass, initialMass, 0.01, 'Mass');
    const energyCheck = assertClose(finalNode.fluid.internalEnergy, initialEnergy, 1000, 'Energy');

    details.push(massCheck.msg);
    details.push(energyCheck.msg);

    const passed = massCheck.ok && energyCheck.ok;
    return {
      passed,
      message: passed ? 'Mass and energy conserved in isolated node' : 'Conservation violated!',
      details,
    };
  });
}

// ============================================================================
// Test 2: Two Connected Nodes - Mass Redistribution
// ============================================================================

function testTwoNodeMassRedistribution(): TestResult {
  return runTest('Two Node Mass Redistribution', () => {
    const state = createSimulationState();

    // Two tanks at same temperature but different pressures
    const volume = 10; // m³ each

    // High pressure tank
    const tank1: FlowNode = {
      id: 'tank-high',
      label: 'High Pressure Tank',
      fluid: createFluidState(400, 20e6, 'liquid', 0, volume), // 127°C, 200 bar
      volume,
      hydraulicDiameter: 1,
      flowArea: 1,
      elevation: 0,
    };

    // Low pressure tank
    const tank2: FlowNode = {
      id: 'tank-low',
      label: 'Low Pressure Tank',
      fluid: createFluidState(400, 5e6, 'liquid', 0, volume), // 127°C, 50 bar
      volume,
      hydraulicDiameter: 1,
      flowArea: 1,
      elevation: 0,
    };

    state.flowNodes.set(tank1.id, tank1);
    state.flowNodes.set(tank2.id, tank2);

    // Connect them with a pipe
    const pipe: FlowConnection = {
      id: 'pipe-1',
      fromNodeId: 'tank-high',
      toNodeId: 'tank-low',
      flowArea: 0.01, // 10 cm² pipe
      hydraulicDiameter: 0.1,
      length: 1,
      elevation: 0,
      resistanceCoeff: 10,
      massFlowRate: 0,
    };
    state.flowConnections.push(pipe);

    // We use FluidStateUpdateOperator to recalculate pressure from mass/energy/volume.
    // This allows pressure to change as mass redistributes, eventually reaching equilibrium.
    // We don't use PressureOperator as it uses a different pressure model (mass ratio based).
    const solver = new Solver({
      minDt: 0.001,
      maxDt: 0.1,
    });
    solver.addOperator(new FlowOperator());
    solver.addOperator(new FluidStateUpdateOperator());

    // Record initial totals
    const initialTotalMass = tank1.fluid.mass + tank2.fluid.mass;
    const initialTotalEnergy = tank1.fluid.internalEnergy + tank2.fluid.internalEnergy;

    const details: string[] = [];
    details.push('Initial state:');
    details.push(`  ${formatState(tank1)}`);
    details.push(`  ${formatState(tank2)}`);
    details.push(`  Total mass: ${initialTotalMass.toFixed(1)} kg`);
    details.push(`  Total energy: ${(initialTotalEnergy/1e6).toFixed(3)} MJ`);

    // Run for 60 seconds
    let currentState = state;
    for (let i = 0; i < 600; i++) {
      currentState = solver.advance(currentState, 0.1).state;

    }

    const finalTank1 = currentState.flowNodes.get('tank-high')!;
    const finalTank2 = currentState.flowNodes.get('tank-low')!;
    const finalTotalMass = finalTank1.fluid.mass + finalTank2.fluid.mass;
    const finalTotalEnergy = finalTank1.fluid.internalEnergy + finalTank2.fluid.internalEnergy;

    details.push('');
    details.push('Final state (after 60s):');
    details.push(`  ${formatState(finalTank1)}`);
    details.push(`  ${formatState(finalTank2)}`);
    details.push(`  Total mass: ${finalTotalMass.toFixed(1)} kg`);
    details.push(`  Total energy: ${(finalTotalEnergy/1e6).toFixed(3)} MJ`);

    // Check conservation
    const massCheck = assertClose(finalTotalMass, initialTotalMass, 1, 'Total Mass');
    const energyCheck = assertClose(finalTotalEnergy, initialTotalEnergy, 100000, 'Total Energy');

    // Check that pressures have equalized somewhat
    const pressureDiff = Math.abs(finalTank1.fluid.pressure - finalTank2.fluid.pressure);
    const initialPressureDiff = Math.abs(tank1.fluid.pressure - tank2.fluid.pressure);
    const pressureEqualized = pressureDiff < initialPressureDiff * 0.5;

    details.push('');
    details.push(massCheck.msg);
    details.push(energyCheck.msg);
    details.push(`Pressure diff: ${(initialPressureDiff/1e5).toFixed(1)} bar → ${(pressureDiff/1e5).toFixed(1)} bar ${pressureEqualized ? '✓' : '✗'}`);

    const passed = massCheck.ok && energyCheck.ok && pressureEqualized;
    return {
      passed,
      message: passed ? 'Mass/energy conserved, pressures equilibrating' : 'Test failed',
      details,
    };
  });
}

// ============================================================================
// Test 3: Water Properties - Phase Detection
// ============================================================================

function testWaterPropertiesPhases(): TestResult {
  return runTest('Water Properties Phase Detection', () => {
    const details: string[] = [];
    let allPassed = true;

    // Test cases: (mass, internalEnergy, volume) -> expected phase
    // Based on our simplified water model:
    // - u_f(T) = 4000 * (T - 273.15) J/kg
    // - u_g(T) = u_f + u_fg, where u_fg ≈ 2.1e6 * (1 - (T-373)/(647-373))
    // - ρ_f(T) ≈ 1000 - 2.5*(T - 373) kg/m³
    //
    // At 373K (100°C): u_f=400kJ/kg, u_g=2500kJ/kg, ρ_f=1000
    // At 453K (180°C): u_f=720kJ/kg, u_g=2260kJ/kg, ρ_f=800
    // At 533K (260°C): u_f=1040kJ/kg, u_g=2020kJ/kg, ρ_f=600

    // Test cases based on steam table data:
    // At 0.1 MPa (1 bar), T_sat = 99.6°C:
    //   v_f = 0.001043 m³/kg (ρ_f = 958 kg/m³), u_f = 417.4 kJ/kg
    //   v_g = 1.694 m³/kg (ρ_g = 0.59 kg/m³), u_g = 2506 kJ/kg
    const testCases = [
      // Subcooled liquid: high density, low specific energy
      { m: 1000, U: 350e6, V: 1, expectedPhase: 'liquid', desc: 'Subcooled liquid (ρ=1000, u=350kJ/kg < u_f)' },

      // Hot liquid at higher temperature: ρ ~ 800 kg/m³, u ~ 650 kJ/kg
      { m: 800, U: 520e6, V: 1, expectedPhase: 'liquid', desc: 'Hot liquid (ρ=800, u=650kJ/kg)' },

      // Two-phase at 1 bar with x=50%:
      // v = 0.5*0.001043 + 0.5*1.694 = 0.8475 m³/kg → ρ = 1.18 kg/m³
      // u = 0.5*417.4 + 0.5*2506 = 1461.7 kJ/kg
      { m: 1.18, U: 1.725e6, V: 1, expectedPhase: 'two-phase', desc: 'Two-phase x=50% at 1 bar (ρ=1.18, u=1462kJ/kg)' },

      // Low density vapor: ρ=5, energy above saturation
      { m: 5, U: 13.5e6, V: 1, expectedPhase: 'vapor', desc: 'Steam (ρ=5, u=2700kJ/kg)' },
    ];

    for (const tc of testCases) {
      const state = calculateState(tc.m, tc.U, tc.V);
      // For "liquid" expected, also accept "two-phase x=0%" since that's saturated liquid
      // For "vapor" expected, also accept "two-phase x=100%" since that's saturated vapor
      let passed = state.phase === tc.expectedPhase;
      if (!passed && tc.expectedPhase === 'liquid' && state.phase === 'two-phase' && state.quality < 0.01) {
        passed = true; // saturated liquid (x ≈ 0) is effectively liquid
      }
      if (!passed && tc.expectedPhase === 'vapor' && state.phase === 'two-phase' && state.quality > 0.99) {
        passed = true; // saturated vapor (x ≈ 1) is effectively vapor
      }
      allPassed = allPassed && passed;

      const specificEnergy = tc.U / tc.m;
      details.push(`${tc.desc}:`);
      details.push(`  Input: m=${tc.m}kg, U=${(tc.U/1e6).toFixed(1)}MJ, V=${tc.V}m³ → ρ=${(tc.m/tc.V).toFixed(0)}, u=${(specificEnergy/1000).toFixed(0)}kJ/kg`);
      details.push(`  Output: T=${(state.temperature-273).toFixed(0)}°C, P=${(state.pressure/1e5).toFixed(1)}bar, phase=${state.phase}${state.phase === 'two-phase' ? `, x=${(state.quality*100).toFixed(0)}%` : ''}`);
      details.push(`  Expected phase: ${tc.expectedPhase} ${passed ? '✓' : '✗'}`);
      details.push('');
    }

    return {
      passed: allPassed,
      message: allPassed ? 'All phase detections correct' : 'Some phase detections failed',
      details,
    };
  });
}

// ============================================================================
// Test 4: Heat Addition to Liquid
// ============================================================================

function testHeatAdditionToLiquid(): TestResult {
  return runTest('Heat Addition to Liquid', () => {
    const state = createSimulationState();

    // Small tank of cold water (100 kg instead of ~1000 kg)
    const volume = 0.1; // m³ (100 liters)
    const tank: FlowNode = {
      id: 'heated-tank',
      label: 'Heated Tank',
      fluid: createFluidState(320, 1e5, 'liquid', 0, volume), // 47°C liquid at 1 bar
      volume,
      hydraulicDiameter: 0.5,
      flowArea: 0.2,
      elevation: 0,
    };
    state.flowNodes.set(tank.id, tank);

    // No flow connections - isolated tank

    const details: string[] = [];
    details.push(`Initial: ${formatState(tank)}`);

    // Manually add heat to the tank (simulating a heater)
    // 1 MW heater for 100 seconds = 100 MJ total
    // For ~100 kg water: ΔT = 100e6 / (100 * 4000) = 250°C rise
    // Should easily reach boiling (100°C) starting from 47°C
    const heatRate = 1e6; // W (1 MW)
    const dt = 1.0; // s
    const numSteps = 100;

    let currentNode = tank;
    const snapshots: string[] = [];

    for (let i = 0; i < numSteps; i++) {
      // Add heat
      const newEnergy = currentNode.fluid.internalEnergy + heatRate * dt;

      // Recalculate state
      const newWaterState = calculateState(
        currentNode.fluid.mass,
        newEnergy,
        currentNode.volume
      );

      // Update node
      currentNode = {
        ...currentNode,
        fluid: {
          mass: currentNode.fluid.mass,
          internalEnergy: newEnergy,
          temperature: newWaterState.temperature,
          pressure: newWaterState.pressure,
          phase: newWaterState.phase,
          quality: newWaterState.quality,
        },
      };

      // Record snapshots at key points
      if (i === 0 || i === 24 || i === 49 || i === 74 || i === 99) {
        snapshots.push(`t=${i+1}s: ${formatState(currentNode)}`);
      }
    }

    details.push('');
    details.push('Heating 100 kW for 100 seconds:');
    for (const snap of snapshots) {
      details.push(`  ${snap}`);
    }

    // Check that:
    // 1. Temperature increased
    // 2. Eventually reached two-phase (boiling)
    // 3. Mass stayed constant

    const tempIncreased = currentNode.fluid.temperature > tank.fluid.temperature + 50;
    const reachedBoiling = currentNode.fluid.phase === 'two-phase' || currentNode.fluid.temperature > 373;
    const massConserved = Math.abs(currentNode.fluid.mass - tank.fluid.mass) < 0.1;

    details.push('');
    details.push(`Temperature increased: ${tempIncreased ? '✓' : '✗'}`);
    details.push(`Reached boiling/two-phase: ${reachedBoiling ? '✓' : '✗'}`);
    details.push(`Mass conserved: ${massConserved ? '✓' : '✗'}`);

    const passed = tempIncreased && reachedBoiling && massConserved;
    return {
      passed,
      message: passed ? 'Heat addition behaves correctly' : 'Heat addition test failed',
      details,
    };
  });
}

// ============================================================================
// Test 5: Energy Conservation with Flow
// ============================================================================

function testEnergyConservationWithFlow(): TestResult {
  return runTest('Energy Conservation with Flow', () => {
    const state = createSimulationState();

    // Two tanks at different temperatures, same pressure
    const volume = 10; // m³ each

    // Hot tank
    const hotTank: FlowNode = {
      id: 'hot-tank',
      label: 'Hot Tank',
      fluid: createFluidState(450, 10e6, 'liquid', 0, volume), // 177°C
      volume,
      hydraulicDiameter: 1,
      flowArea: 1,
      elevation: 0,
    };

    // Cold tank
    const coldTank: FlowNode = {
      id: 'cold-tank',
      label: 'Cold Tank',
      fluid: createFluidState(350, 10e6, 'liquid', 0, volume), // 77°C
      volume,
      hydraulicDiameter: 1,
      flowArea: 1,
      elevation: 0,
    };

    state.flowNodes.set(hotTank.id, hotTank);
    state.flowNodes.set(coldTank.id, coldTank);

    // Connect with pipe - slight elevation difference to drive flow
    const pipe: FlowConnection = {
      id: 'pipe-1',
      fromNodeId: 'hot-tank',
      toNodeId: 'cold-tank',
      flowArea: 0.01,
      hydraulicDiameter: 0.1,
      length: 1,
      elevation: 0.1, // Hot tank slightly higher
      resistanceCoeff: 5,
      massFlowRate: 0,
    };
    state.flowConnections.push(pipe);

    const solver = new Solver({
      minDt: 0.001,
      maxDt: 0.05,
    });
    solver.addOperator(new FlowOperator());
    solver.addOperator(new FluidStateUpdateOperator());

    const initialTotalMass = hotTank.fluid.mass + coldTank.fluid.mass;
    const initialTotalEnergy = hotTank.fluid.internalEnergy + coldTank.fluid.internalEnergy;

    const details: string[] = [];
    details.push('Initial state:');
    details.push(`  ${formatState(hotTank)}`);
    details.push(`  ${formatState(coldTank)}`);
    details.push(`  Total mass: ${initialTotalMass.toFixed(1)} kg`);
    details.push(`  Total energy: ${(initialTotalEnergy/1e9).toFixed(4)} GJ`);

    // Run simulation
    let currentState = state;
    const energyHistory: number[] = [initialTotalEnergy];
    const massHistory: number[] = [initialTotalMass];

    for (let i = 0; i < 200; i++) {
      currentState = solver.advance(currentState, 0.1).state;

      const hot = currentState.flowNodes.get('hot-tank')!;
      const cold = currentState.flowNodes.get('cold-tank')!;
      const totalMass = hot.fluid.mass + cold.fluid.mass;
      const totalEnergy = hot.fluid.internalEnergy + cold.fluid.internalEnergy;

      massHistory.push(totalMass);
      energyHistory.push(totalEnergy);
    }

    const finalHot = currentState.flowNodes.get('hot-tank')!;
    const finalCold = currentState.flowNodes.get('cold-tank')!;
    const finalTotalMass = finalHot.fluid.mass + finalCold.fluid.mass;
    const finalTotalEnergy = finalHot.fluid.internalEnergy + finalCold.fluid.internalEnergy;

    details.push('');
    details.push('Final state (after 20s):');
    details.push(`  ${formatState(finalHot)}`);
    details.push(`  ${formatState(finalCold)}`);
    details.push(`  Total mass: ${finalTotalMass.toFixed(1)} kg`);
    details.push(`  Total energy: ${(finalTotalEnergy/1e9).toFixed(4)} GJ`);

    // Check for drifts
    const maxMass = Math.max(...massHistory);
    const minMass = Math.min(...massHistory);
    const maxEnergy = Math.max(...energyHistory);
    const minEnergy = Math.min(...energyHistory);

    const massDrift = (maxMass - minMass) / initialTotalMass * 100;
    const energyDrift = (maxEnergy - minEnergy) / initialTotalEnergy * 100;

    details.push('');
    details.push(`Mass drift: ${massDrift.toFixed(3)}%`);
    details.push(`Energy drift: ${energyDrift.toFixed(3)}%`);

    const massOk = massDrift < 1; // Less than 1% drift
    const energyOk = energyDrift < 5; // Less than 5% drift (allow some numerical error)

    details.push(`Mass conservation: ${massOk ? '✓' : '✗'}`);
    details.push(`Energy conservation: ${energyOk ? '✓' : '✗'}`);

    const passed = massOk && energyOk;
    return {
      passed,
      message: passed ? 'Energy and mass conserved during flow' : 'Conservation violated during flow',
      details,
    };
  });
}

// ============================================================================
// Main Test Runner
// ============================================================================

function runAllTests(): void {
  console.log('='.repeat(70));
  console.log('MELTDOWN SIMULATION UNIT TESTS');
  console.log('='.repeat(70));
  console.log('');

  const tests = [
    testIsolatedNodeConservation,
    testTwoNodeMassRedistribution,
    testWaterPropertiesPhases,
    testHeatAdditionToLiquid,
    testEnergyConservationWithFlow,
  ];

  const results: TestResult[] = [];

  for (const test of tests) {
    const result = test();
    results.push(result);

    const status = result.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`[${status}] ${result.name}`);
    console.log(`         ${result.message}`);

    if (result.details) {
      console.log('');
      for (const line of result.details) {
        console.log(`         ${line}`);
      }
    }
    console.log('');
    console.log('-'.repeat(70));
    console.log('');
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  console.log('='.repeat(70));
  console.log(`SUMMARY: ${passed}/${total} tests passed`);
  console.log('='.repeat(70));

  if (passed < total) {
    process.exit(1);
  }
}

// ============================================================================
// Test 6: Pressurizer Initialization (Two-Phase at High Pressure)
// ============================================================================

function testPressurizerInitialization(): TestResult {
  return runTest('Pressurizer Initialization', () => {
    const details: string[] = [];

    // Pressurizer conditions: 618K (345°C), 155 bar, 50% quality, 30 m³
    const T = 618;
    const P = 15.5e6;
    const quality = 0.5;
    const volume = 30;

    details.push(`Initial conditions: T=${T}K, P=${(P/1e5).toFixed(0)}bar, x=${quality*100}%, V=${volume}m³`);

    // Create the initial state
    const state = createSimulationState();
    const przNode: FlowNode = {
      id: 'test-przr',
      label: 'Test Pressurizer',
      fluid: createFluidState(T, P, 'two-phase', quality, volume),
      volume,
      hydraulicDiameter: 2,
      flowArea: 3,
      elevation: 10,
    };
    state.flowNodes.set(przNode.id, przNode);

    const initialFluid = przNode.fluid;
    details.push('');
    details.push('After createFluidState:');
    details.push(`  mass: ${initialFluid.mass.toFixed(1)} kg`);
    details.push(`  internalEnergy: ${(initialFluid.internalEnergy/1e6).toFixed(3)} MJ`);
    details.push(`  temperature: ${(initialFluid.temperature-273).toFixed(1)} C`);
    details.push(`  pressure: ${(initialFluid.pressure/1e5).toFixed(2)} bar`);
    details.push(`  phase: ${initialFluid.phase}`);
    details.push(`  quality: ${(initialFluid.quality*100).toFixed(1)}%`);
    details.push(`  density: ${(initialFluid.mass/volume).toFixed(1)} kg/m³`);
    details.push(`  specific energy: ${(initialFluid.internalEnergy/initialFluid.mass/1000).toFixed(1)} kJ/kg`);

    // Now run FluidStateUpdateOperator to see what happens
    const solver = new Solver({
      minDt: 0.001,
      maxDt: 0.1,
    });
    solver.addOperator(new FluidStateUpdateOperator());

    const afterState = solver.advance(state, 0.001).state;
    const afterNode = afterState.flowNodes.get('test-przr')!;
    const afterFluid = afterNode.fluid;

    details.push('');
    details.push('After FluidStateUpdateOperator:');
    details.push(`  mass: ${afterFluid.mass.toFixed(1)} kg (unchanged: ${Math.abs(afterFluid.mass - initialFluid.mass) < 0.1 ? '✓' : '✗'})`);
    details.push(`  internalEnergy: ${(afterFluid.internalEnergy/1e6).toFixed(3)} MJ (unchanged: ${Math.abs(afterFluid.internalEnergy - initialFluid.internalEnergy) < 1000 ? '✓' : '✗'})`);
    details.push(`  temperature: ${(afterFluid.temperature-273).toFixed(1)} C`);
    details.push(`  pressure: ${(afterFluid.pressure/1e5).toFixed(2)} bar`);
    details.push(`  phase: ${afterFluid.phase}`);
    details.push(`  quality: ${afterFluid.phase === 'two-phase' ? (afterFluid.quality*100).toFixed(1) + '%' : 'N/A'}`);
    details.push(`  density: ${(afterFluid.mass/volume).toFixed(1)} kg/m³`);
    details.push(`  specific energy: ${(afterFluid.internalEnergy/afterFluid.mass/1000).toFixed(1)} kJ/kg`);

    // Check if phase changed unexpectedly
    const phaseOk = afterFluid.phase === 'two-phase';
    const qualityOk = afterFluid.phase !== 'two-phase' || (afterFluid.quality > 0.1 && afterFluid.quality < 0.9);

    details.push('');
    details.push(`Phase maintained as two-phase: ${phaseOk ? '✓' : '✗'}`);
    details.push(`Quality reasonable (10-90%): ${qualityOk ? '✓' : '✗'}`);

    const passed = phaseOk && qualityOk;
    return {
      passed,
      message: passed ? 'Pressurizer initializes correctly' : 'Pressurizer phase/quality issue detected',
      details,
    };
  });
}

// ============================================================================
// Test 7: Pressure Divergence in Multi-Node Loop
// ============================================================================

function testPressureDivergence(): TestResult {
  return runTest('Pressure Divergence in Multi-Node Loop', () => {
    const details: string[] = [];

    // Create a simple 3-node loop to test pressure dynamics
    // This mimics the core-coolant -> hot-leg -> sg-primary path
    const state = createSimulationState();

    const volume1 = 4.0; // Core volume
    const volume2 = 2.0; // Hot leg volume
    const volume3 = 8.0; // SG primary volume

    // All start at same T, P, as liquid
    const initialT = 580; // K (~307°C)
    const initialP = 15.5e6; // Pa (155 bar)

    const node1: FlowNode = {
      id: 'test-node1',
      label: 'Node 1 (like core)',
      fluid: createFluidState(initialT, initialP, 'liquid', 0, volume1),
      volume: volume1,
      hydraulicDiameter: 0.5,
      flowArea: 0.2,
      elevation: 0,
    };

    const node2: FlowNode = {
      id: 'test-node2',
      label: 'Node 2 (like hot-leg)',
      fluid: createFluidState(initialT, initialP, 'liquid', 0, volume2),
      volume: volume2,
      hydraulicDiameter: 0.3,
      flowArea: 0.07,
      elevation: 2,
    };

    const node3: FlowNode = {
      id: 'test-node3',
      label: 'Node 3 (like SG)',
      fluid: createFluidState(initialT, initialP, 'liquid', 0, volume3),
      volume: volume3,
      hydraulicDiameter: 0.5,
      flowArea: 0.2,
      elevation: 5,
    };

    state.flowNodes.set(node1.id, node1);
    state.flowNodes.set(node2.id, node2);
    state.flowNodes.set(node3.id, node3);

    // Connect in series: node1 -> node2 -> node3 -> node1 (closed loop)
    const conn1: FlowConnection = {
      id: 'conn-1-2',
      fromNodeId: 'test-node1',
      toNodeId: 'test-node2',
      flowArea: 0.05,
      hydraulicDiameter: 0.25,
      length: 3,
      elevation: 1,
      resistanceCoeff: 5,
      massFlowRate: 0,
    };

    const conn2: FlowConnection = {
      id: 'conn-2-3',
      fromNodeId: 'test-node2',
      toNodeId: 'test-node3',
      flowArea: 0.05,
      hydraulicDiameter: 0.25,
      length: 5,
      elevation: 1.5,
      resistanceCoeff: 5,
      massFlowRate: 0,
    };

    const conn3: FlowConnection = {
      id: 'conn-3-1',
      fromNodeId: 'test-node3',
      toNodeId: 'test-node1',
      flowArea: 0.05,
      hydraulicDiameter: 0.25,
      length: 8,
      elevation: -2.5,
      resistanceCoeff: 5,
      massFlowRate: 0,
    };

    state.flowConnections.push(conn1, conn2, conn3);

    // Add a pump to drive flow (otherwise natural circulation only)
    state.components.pumps.set('test-pump', {
      running: true,
      speed: 1.0,
      ratedFlow: 1000, // kg/s
      ratedHead: 30, // m
      connectedFlowPath: 'conn-3-1',
    });

    details.push('Initial state:');
    details.push(`  Node1: m=${node1.fluid.mass.toFixed(0)}kg, P=${(node1.fluid.pressure/1e5).toFixed(1)}bar, T=${(node1.fluid.temperature-273).toFixed(0)}°C, ${node1.fluid.phase}`);
    details.push(`  Node2: m=${node2.fluid.mass.toFixed(0)}kg, P=${(node2.fluid.pressure/1e5).toFixed(1)}bar, T=${(node2.fluid.temperature-273).toFixed(0)}°C, ${node2.fluid.phase}`);
    details.push(`  Node3: m=${node3.fluid.mass.toFixed(0)}kg, P=${(node3.fluid.pressure/1e5).toFixed(1)}bar, T=${(node3.fluid.temperature-273).toFixed(0)}°C, ${node3.fluid.phase}`);

    const initialTotalMass = node1.fluid.mass + node2.fluid.mass + node3.fluid.mass;
    const initialTotalEnergy = node1.fluid.internalEnergy + node2.fluid.internalEnergy + node3.fluid.internalEnergy;
    details.push(`  Total mass: ${initialTotalMass.toFixed(0)} kg`);
    details.push(`  Total energy: ${(initialTotalEnergy/1e9).toFixed(4)} GJ`);

    // Create solver
    const solver = new Solver({
      minDt: 0.001,
      maxDt: 0.05,
    });
    solver.addOperator(new FlowOperator());
    solver.addOperator(new FluidStateUpdateOperator());

    // Run simulation and track pressure evolution
    let currentState = state;
    const pressureHistory: { t: number; p1: number; p2: number; p3: number; m1: number; m2: number; m3: number }[] = [];

    // First, let's trace through a few small timesteps to see what happens
    details.push('');
    details.push('=== DETAILED TRACE OF FIRST 5 SMALL STEPS (dt=0.01s) ===');

    // Calculate what the pump head should be
    const pumpRatedHead = 30; // m
    const pumpRatedFlow = 1000; // kg/s
    const rho = 750; // kg/m³ approx
    const g = 9.81;
    const fullHeadPressure = rho * g * pumpRatedHead;
    details.push(`Pump analysis: ratedHead=${pumpRatedHead}m, ratedFlow=${pumpRatedFlow}kg/s`);
    details.push(`  Full head ΔP = ${(fullHeadPressure/1e5).toFixed(2)} bar at zero flow`);

    for (let microStep = 0; microStep < 5; microStep++) {
      // Check flows BEFORE advancing
      const c1_pre = currentState.flowConnections.find(c => c.id === 'conn-1-2')!;
      const c2_pre = currentState.flowConnections.find(c => c.id === 'conn-2-3')!;
      const c3_pre = currentState.flowConnections.find(c => c.id === 'conn-3-1')!;
      const n1_pre = currentState.flowNodes.get('test-node1')!;
      const n2_pre = currentState.flowNodes.get('test-node2')!;
      const n3_pre = currentState.flowNodes.get('test-node3')!;

      // Calculate what the pump driving pressure is given current flow
      const Q = Math.abs(c3_pre.massFlowRate) / rho;
      const Q_rated = pumpRatedFlow / rho;
      const headRatio = 1 - 0.5 * Math.pow(Q / Q_rated, 2);
      const dP_pump = pumpRatedHead * headRatio * rho * g;
      // Back pressure against pump = P1 - P3
      const backPressure = n1_pre.fluid.pressure - n3_pre.fluid.pressure;

      details.push(`Step ${microStep}: BEFORE`);
      details.push(`  Pressures: P1=${(n1_pre.fluid.pressure/1e5).toFixed(1)}, P2=${(n2_pre.fluid.pressure/1e5).toFixed(1)}, P3=${(n3_pre.fluid.pressure/1e5).toFixed(1)} bar`);
      details.push(`  Masses: m1=${n1_pre.fluid.mass.toFixed(1)}, m2=${n2_pre.fluid.mass.toFixed(1)}, m3=${n3_pre.fluid.mass.toFixed(1)} kg`);
      details.push(`  Flows: 1->2=${c1_pre.massFlowRate.toFixed(1)}, 2->3=${c2_pre.massFlowRate.toFixed(1)}, 3->1=${c3_pre.massFlowRate.toFixed(1)} kg/s`);
      details.push(`  Pump: dP_pump=${(dP_pump/1e5).toFixed(2)}bar (headRatio=${headRatio.toFixed(3)}), backPressure=${(backPressure/1e5).toFixed(2)}bar`);

      currentState = solver.advance(currentState, 0.01).state;

      const c1_post = currentState.flowConnections.find(c => c.id === 'conn-1-2')!;
      const c2_post = currentState.flowConnections.find(c => c.id === 'conn-2-3')!;
      const c3_post = currentState.flowConnections.find(c => c.id === 'conn-3-1')!;
      const n1_post = currentState.flowNodes.get('test-node1')!;
      const n2_post = currentState.flowNodes.get('test-node2')!;
      const n3_post = currentState.flowNodes.get('test-node3')!;

      details.push(`Step ${microStep}: AFTER`);
      details.push(`  Pressures: P1=${(n1_post.fluid.pressure/1e5).toFixed(1)}, P2=${(n2_post.fluid.pressure/1e5).toFixed(1)}, P3=${(n3_post.fluid.pressure/1e5).toFixed(1)} bar`);
      details.push(`  Masses: m1=${n1_post.fluid.mass.toFixed(1)}, m2=${n2_post.fluid.mass.toFixed(1)}, m3=${n3_post.fluid.mass.toFixed(1)} kg`);
      details.push(`  Flows: 1->2=${c1_post.massFlowRate.toFixed(1)}, 2->3=${c2_post.massFlowRate.toFixed(1)}, 3->1=${c3_post.massFlowRate.toFixed(1)} kg/s`);
      details.push(`  Mass changes: Δm1=${(n1_post.fluid.mass - n1_pre.fluid.mass).toFixed(2)}, Δm2=${(n2_post.fluid.mass - n2_pre.fluid.mass).toFixed(2)}, Δm3=${(n3_post.fluid.mass - n3_pre.fluid.mass).toFixed(2)} kg`);
      details.push('');
    }
    details.push('=== END DETAILED TRACE ===');
    details.push('');

    const totalTime = 30; // seconds
    const dt = 0.1;
    const steps = Math.floor(totalTime / dt);

    let maxPressure = 0;
    let minPressure = Infinity;
    let maxPressureDiff = 0;

    for (let i = 0; i < steps; i++) {
      currentState = solver.advance(currentState, dt).state;

      const n1 = currentState.flowNodes.get('test-node1')!;
      const n2 = currentState.flowNodes.get('test-node2')!;
      const n3 = currentState.flowNodes.get('test-node3')!;

      const p1 = n1.fluid.pressure;
      const p2 = n2.fluid.pressure;
      const p3 = n3.fluid.pressure;

      const pMax = Math.max(p1, p2, p3);
      const pMin = Math.min(p1, p2, p3);
      const pDiff = pMax - pMin;

      if (pMax > maxPressure) maxPressure = pMax;
      if (pMin < minPressure) minPressure = pMin;
      if (pDiff > maxPressureDiff) maxPressureDiff = pDiff;

      // Record every 1 second
      if ((i + 1) % 10 === 0) {
        pressureHistory.push({
          t: (i + 1) * dt,
          p1, p2, p3,
          m1: n1.fluid.mass,
          m2: n2.fluid.mass,
          m3: n3.fluid.mass,
        });
      }

      // Early exit if pressure goes crazy
      if (pMax > 300e5 || pMin < 50e5) {
        details.push('');
        details.push(`!!! PRESSURE DIVERGENCE at t=${((i+1)*dt).toFixed(1)}s !!!`);
        details.push(`  Node1: P=${(p1/1e5).toFixed(1)}bar, m=${n1.fluid.mass.toFixed(0)}kg, ${n1.fluid.phase}`);
        details.push(`  Node2: P=${(p2/1e5).toFixed(1)}bar, m=${n2.fluid.mass.toFixed(0)}kg, ${n2.fluid.phase}`);
        details.push(`  Node3: P=${(p3/1e5).toFixed(1)}bar, m=${n3.fluid.mass.toFixed(0)}kg, ${n3.fluid.phase}`);

        // Check flow rates
        const c1 = currentState.flowConnections.find(c => c.id === 'conn-1-2')!;
        const c2 = currentState.flowConnections.find(c => c.id === 'conn-2-3')!;
        const c3 = currentState.flowConnections.find(c => c.id === 'conn-3-1')!;
        details.push(`  Flows: 1->2: ${c1.massFlowRate.toFixed(0)}kg/s, 2->3: ${c2.massFlowRate.toFixed(0)}kg/s, 3->1: ${c3.massFlowRate.toFixed(0)}kg/s`);

        // Calculate specific energy for each node
        const u1 = n1.fluid.internalEnergy / n1.fluid.mass;
        const u2 = n2.fluid.internalEnergy / n2.fluid.mass;
        const u3 = n3.fluid.internalEnergy / n3.fluid.mass;
        details.push(`  Specific energy: u1=${(u1/1000).toFixed(1)}kJ/kg, u2=${(u2/1000).toFixed(1)}kJ/kg, u3=${(u3/1000).toFixed(1)}kJ/kg`);

        // Calculate specific volume
        const v1 = n1.volume / n1.fluid.mass;
        const v2 = n2.volume / n2.fluid.mass;
        const v3 = n3.volume / n3.fluid.mass;
        details.push(`  Specific volume: v1=${v1.toFixed(6)}m³/kg, v2=${v2.toFixed(6)}m³/kg, v3=${v3.toFixed(6)}m³/kg`);

        break;
      }
    }

    // Final state
    const final1 = currentState.flowNodes.get('test-node1')!;
    const final2 = currentState.flowNodes.get('test-node2')!;
    const final3 = currentState.flowNodes.get('test-node3')!;
    const finalTotalMass = final1.fluid.mass + final2.fluid.mass + final3.fluid.mass;
    const finalTotalEnergy = final1.fluid.internalEnergy + final2.fluid.internalEnergy + final3.fluid.internalEnergy;

    details.push('');
    details.push('Pressure history (sampled every 1s):');
    for (const h of pressureHistory.slice(0, 10)) {
      details.push(`  t=${h.t.toFixed(0)}s: P1=${(h.p1/1e5).toFixed(1)}bar, P2=${(h.p2/1e5).toFixed(1)}bar, P3=${(h.p3/1e5).toFixed(1)}bar | m1=${h.m1.toFixed(0)}, m2=${h.m2.toFixed(0)}, m3=${h.m3.toFixed(0)}kg`);
    }

    details.push('');
    details.push('Final state:');
    details.push(`  Node1: m=${final1.fluid.mass.toFixed(0)}kg, P=${(final1.fluid.pressure/1e5).toFixed(1)}bar, T=${(final1.fluid.temperature-273).toFixed(0)}°C, ${final1.fluid.phase}`);
    details.push(`  Node2: m=${final2.fluid.mass.toFixed(0)}kg, P=${(final2.fluid.pressure/1e5).toFixed(1)}bar, T=${(final2.fluid.temperature-273).toFixed(0)}°C, ${final2.fluid.phase}`);
    details.push(`  Node3: m=${final3.fluid.mass.toFixed(0)}kg, P=${(final3.fluid.pressure/1e5).toFixed(1)}bar, T=${(final3.fluid.temperature-273).toFixed(0)}°C, ${final3.fluid.phase}`);
    details.push(`  Total mass: ${finalTotalMass.toFixed(0)} kg`);
    details.push(`  Total energy: ${(finalTotalEnergy/1e9).toFixed(4)} GJ`);

    details.push('');
    details.push(`Max pressure seen: ${(maxPressure/1e5).toFixed(1)} bar`);
    details.push(`Min pressure seen: ${(minPressure/1e5).toFixed(1)} bar`);
    details.push(`Max pressure difference: ${(maxPressureDiff/1e5).toFixed(1)} bar`);

    const massDrift = Math.abs(finalTotalMass - initialTotalMass) / initialTotalMass * 100;
    const energyDrift = Math.abs(finalTotalEnergy - initialTotalEnergy) / initialTotalEnergy * 100;
    details.push(`Mass drift: ${massDrift.toFixed(3)}%`);
    details.push(`Energy drift: ${energyDrift.toFixed(3)}%`);

    // Passing criteria:
    // - No extreme pressure divergence (stay between 50 and 300 bar)
    // - Mass conserved within 1%
    // - Pressure difference between nodes stays reasonable (< 100 bar)
    const pressureOk = maxPressure < 300e5 && minPressure > 50e5;
    const massOk = massDrift < 1;
    const diffOk = maxPressureDiff < 100e5;

    const passed = pressureOk && massOk && diffOk;
    return {
      passed,
      message: passed
        ? 'Pressure remains stable in multi-node loop'
        : `Pressure divergence detected: max=${(maxPressure/1e5).toFixed(0)}bar, min=${(minPressure/1e5).toFixed(0)}bar, diff=${(maxPressureDiff/1e5).toFixed(0)}bar`,
      details,
    };
  });
}

// Run tests
runAllTests();

// Run pressure divergence test
console.log('');
console.log('='.repeat(70));
console.log('PRESSURE DIVERGENCE TEST');
console.log('='.repeat(70));
const pressureResult = testPressureDivergence();
console.log(`[${pressureResult.passed ? '✓ PASS' : '✗ FAIL'}] ${pressureResult.name}`);
console.log(`         ${pressureResult.message}`);
if (pressureResult.details) {
  for (const line of pressureResult.details) {
    console.log(`         ${line}`);
  }
}

// Also run the pressurizer test separately
console.log('');
console.log('='.repeat(70));
console.log('PRESSURIZER SPECIFIC TEST');
console.log('='.repeat(70));
const przResult = testPressurizerInitialization();
console.log(`[${przResult.passed ? '✓ PASS' : '✗ FAIL'}] ${przResult.name}`);
console.log(`         ${przResult.message}`);
if (przResult.details) {
  for (const line of przResult.details) {
    console.log(`         ${line}`);
  }
}

// ============================================================================
// Test 7: Full Plant Core Coolant Tracking
// ============================================================================
console.log('');
console.log('='.repeat(70));
console.log('FULL PLANT CORE COOLANT TRACKING');
console.log('='.repeat(70));

const plantState = createDemoReactor();
const plantSolver = new Solver({ minDt: 0.001, maxDt: 0.1 });
plantSolver.addOperator(new FlowOperator());
plantSolver.addOperator(new ConductionOperator());
plantSolver.addOperator(new ConvectionOperator());
plantSolver.addOperator(new HeatGenerationOperator());
plantSolver.addOperator(new FluidStateUpdateOperator());

let currentPlantState = plantState;

// Helper to print full loop state
function printLoopState(st: SimulationState, label: string) {
  const core = st.flowNodes.get('core-coolant')!;
  const hotLeg = st.flowNodes.get('hot-leg')!;
  const sgPri = st.flowNodes.get('sg-primary')!;
  const coldLeg = st.flowNodes.get('cold-leg')!;
  const przr = st.flowNodes.get('pressurizer')!;

  const f1 = st.flowConnections.find(c => c.id === 'flow-core-hotleg')!;
  const f2 = st.flowConnections.find(c => c.id === 'flow-hotleg-sg')!;
  const f3 = st.flowConnections.find(c => c.id === 'flow-sg-coldleg')!;
  const f4 = st.flowConnections.find(c => c.id === 'flow-coldleg-core')!;
  const fPrzr = st.flowConnections.find(c => c.id === 'flow-przr-surge')!;

  console.log(`\n${label}`);
  console.log(`  Masses:    Core=${core.fluid.mass.toFixed(0)}kg, HotLeg=${hotLeg.fluid.mass.toFixed(0)}kg, SG=${sgPri.fluid.mass.toFixed(0)}kg, ColdLeg=${coldLeg.fluid.mass.toFixed(0)}kg`);
  console.log(`  Pressures: Core=${(core.fluid.pressure/1e5).toFixed(1)}bar, HotLeg=${(hotLeg.fluid.pressure/1e5).toFixed(1)}bar, SG=${(sgPri.fluid.pressure/1e5).toFixed(1)}bar, ColdLeg=${(coldLeg.fluid.pressure/1e5).toFixed(1)}bar`);
  console.log(`  Przr:      m=${przr.fluid.mass.toFixed(0)}kg, P=${(przr.fluid.pressure/1e5).toFixed(1)}bar, T=${(przr.fluid.temperature-273).toFixed(0)}°C, ${przr.fluid.phase}, x=${((przr.fluid.quality || 0)*100).toFixed(0)}%, HL->Przr=${fPrzr.massFlowRate.toFixed(0)}kg/s`);
  console.log(`  Flows:     Core->HL=${f1.massFlowRate.toFixed(0)}, HL->SG=${f2.massFlowRate.toFixed(0)}, SG->CL=${f3.massFlowRate.toFixed(0)}, CL->Core=${f4.massFlowRate.toFixed(0)} kg/s`);

  // Check mass balance: net flow into each node
  const coreNetIn = f4.massFlowRate - f1.massFlowRate;
  const hlNetIn = f1.massFlowRate - f2.massFlowRate;
  const sgNetIn = f2.massFlowRate - f3.massFlowRate;
  const clNetIn = f3.massFlowRate - f4.massFlowRate;
  console.log(`  Net inflows: Core=${coreNetIn.toFixed(0)}, HL=${hlNetIn.toFixed(0)}, SG=${sgNetIn.toFixed(0)}, CL=${clNetIn.toFixed(0)} kg/s`);
}

printLoopState(currentPlantState, 'Initial state (t=0):');

// Run with small timesteps to see what's happening
for (let step = 0; step < 20; step++) {
  currentPlantState = plantSolver.advance(currentPlantState, 0.1).state;

  // Print every 0.1s for first second, then every 1s
  if (step < 10 || step % 10 === 9) {
    printLoopState(currentPlantState, `After ${((step + 1) * 0.1).toFixed(1)}s:`);
  }
}

// ============================================================================
// COLD LEG PRESSURE JUMP DIAGNOSTIC
// ============================================================================
console.log('\n' + '='.repeat(70));
console.log('COLD LEG PRESSURE JUMP DIAGNOSTIC');
console.log('='.repeat(70));
console.log('\nInvestigating pressure discontinuity at cold-leg conditions:');
console.log('T=291°C, P~150bar, ρ=739-740 kg/m³, u=1285 kJ/kg\n');

// The reported conditions
const coldLegT = 291 + 273.15; // K
const coldLegRho = 739; // kg/m³
const coldLegU = 1285e3; // J/kg

// Calculate v from rho
const coldLegV = 1 / coldLegRho; // m³/kg

console.log('Input conditions:');
console.log(`  T = ${(coldLegT - 273.15).toFixed(1)}°C = ${coldLegT.toFixed(1)}K`);
console.log(`  ρ = ${coldLegRho} kg/m³`);
console.log(`  v = ${coldLegV.toFixed(6)} m³/kg`);
console.log(`  u = ${(coldLegU/1000).toFixed(1)} kJ/kg`);

// Test phase detection at this exact point
console.log('\n--- Phase Detection Test ---');
const testMass = 1; // 1 kg for easy math
const testVolume = coldLegV; // m³
const testU = coldLegU; // J

const state1 = calculateState(testMass, testU, testVolume);
console.log(`calculateState(m=1kg, U=${(testU/1e3).toFixed(1)}kJ, V=${testVolume.toFixed(6)}m³):`);
console.log(`  Result: T=${(state1.temperature-273.15).toFixed(1)}°C, P=${(state1.pressure/1e5).toFixed(2)}bar, phase=${state1.phase}`);

// Now test small perturbations in density to see if there's a discontinuity
console.log('\n--- Density Sensitivity Test ---');
console.log('Testing small density variations around ρ=739 kg/m³:');
console.log('(Looking for pressure jumps that indicate hitting a boundary)\n');

const testDensities = [735, 736, 737, 738, 739, 740, 741, 742, 743, 744, 745];
let prevP = 0;
for (const rho of testDensities) {
  const v = 1 / rho;
  const state = calculateState(1, testU, v);
  const dP = prevP > 0 ? state.pressure - prevP : 0;
  const jumpFlag = Math.abs(dP) > 1e6 ? ' <-- JUMP!' : '';
  console.log(`  ρ=${rho}: v=${v.toFixed(6)}, T=${(state.temperature-273.15).toFixed(1)}°C, P=${(state.pressure/1e5).toFixed(2)}bar, phase=${state.phase}${jumpFlag}`);
  prevP = state.pressure;
}

// Test energy sensitivity too
console.log('\n--- Energy Sensitivity Test ---');
console.log('Testing small energy variations around u=1285 kJ/kg at ρ=739:');

const testEnergies = [1275, 1280, 1283, 1284, 1285, 1286, 1287, 1290, 1295];
prevP = 0;
for (const u_kJ of testEnergies) {
  const u = u_kJ * 1000;
  const state = calculateState(1, u, coldLegV);
  const dP = prevP > 0 ? state.pressure - prevP : 0;
  const jumpFlag = Math.abs(dP) > 1e6 ? ' <-- JUMP!' : '';
  console.log(`  u=${u_kJ}: T=${(state.temperature-273.15).toFixed(1)}°C, P=${(state.pressure/1e5).toFixed(2)}bar, phase=${state.phase}${jumpFlag}`);
  prevP = state.pressure;
}

// Check what the saturation dome looks like at this v
console.log('\n--- Saturation Dome Check ---');
console.log(`At v=${coldLegV.toFixed(6)} m³/kg, what is u_sat?`);

// We need to check if this v falls within or outside the dome
const stats = getBisectionStats();
console.log(`\nBisection stats: ${stats.total} total, ${stats.failures} failures (${(stats.failureRate*100).toFixed(2)}%)`);

// Test if we're outside the dome v range
console.log('\n--- Dome Boundary Check ---');
console.log('Checking if v=0.001353 is within saturation dome v range...');

// For liquid at 291°C (564K), what's the saturation density?
// saturationPressure at 564K should give us P_sat, then we can check v_f
// At 564K (~291°C), P_sat ≈ 75 bar, and saturated liquid v_f ≈ 0.00133 m³/kg

// The issue might be: we have ρ=739 (v=0.00135) but at T=291°C,
// the saturated liquid would have ρ_sat ≈ 750 (v_f ≈ 0.00133)
// So we're LESS dense than saturated liquid at this T - this is strange!
// It means the fluid has expanded beyond what's normal for liquid at this T.

console.log('\nPhysical interpretation:');
console.log(`  At 291°C, saturated liquid has ρ_f ≈ 750 kg/m³, v_f ≈ 0.00133 m³/kg`);
console.log(`  Our cold leg has ρ = 739 kg/m³, v = 0.00135 m³/kg`);
console.log(`  This means v > v_f, so we're "more expanded" than saturated liquid!`);
console.log(`  This could push us into the two-phase region or cause phase detection issues.`);

// Check if small changes in v cross the v_f boundary
console.log('\n--- v_f Boundary Crossing Test ---');
console.log('Testing states near the saturated liquid density at ~291°C:');

const testVs = [0.00130, 0.00131, 0.00132, 0.00133, 0.00134, 0.00135, 0.00136, 0.00137, 0.00138];
prevP = 0;
for (const v of testVs) {
  const state = calculateState(1, testU, v);
  const dP = prevP > 0 ? state.pressure - prevP : 0;
  const jumpFlag = Math.abs(dP) > 1e6 ? ' <-- JUMP!' : '';
  const rho = 1/v;
  console.log(`  v=${v.toFixed(5)} (ρ=${rho.toFixed(0)}): T=${(state.temperature-273.15).toFixed(1)}°C, P=${(state.pressure/1e5).toFixed(2)}bar, phase=${state.phase}${state.phase === 'two-phase' ? `, x=${(state.quality*100).toFixed(1)}%` : ''}${jumpFlag}`);
  prevP = state.pressure;
}

// ============================================================================
// EXTENDED SIMULATION WITH FLUID STATE DEBUG
// ============================================================================
console.log('\n' + '='.repeat(70));
console.log('EXTENDED SIMULATION - Capturing BFS pressure propagation');
console.log('='.repeat(70));
console.log('\nRunning for 150 steps (15 seconds) to look for pressure jumps...\n');

// Create a fresh reactor state
const debugState = createDemoReactor();
const debugSolver = new Solver([
  new FlowOperator(),
  new ConvectionOperator(),
  new ConductionOperator(),
  new HeatGenerationOperator(),
  new FluidStateUpdateOperator(),
]);

let debugPlantState = debugState;
let lastColdLegP = 0;

for (let step = 0; step < 150; step++) {
  debugPlantState = debugSolver.advance(debugPlantState, 0.1).state;

  // Get cold leg pressure
  const coldLeg = debugPlantState.flowNodes.get('cold-leg');
  const hotLeg = debugPlantState.flowNodes.get('hot-leg');
  const przr = debugPlantState.flowNodes.get('pressurizer');

  if (coldLeg && hotLeg && przr) {
    const coldLegP = coldLeg.fluid.pressure;
    const dP = lastColdLegP > 0 ? coldLegP - lastColdLegP : 0;

    // Log steps with significant pressure changes or around the expected jump
    if (Math.abs(dP) > 5e5 || step >= 143 && step <= 146) {
      console.log(`Step ${step}: cold-leg P=${(coldLegP/1e5).toFixed(2)}bar (Δ=${(dP/1e5).toFixed(2)}bar), hot-leg P=${(hotLeg.fluid.pressure/1e5).toFixed(2)}bar, przr P=${(przr.fluid.pressure/1e5).toFixed(2)}bar`);
    }

    lastColdLegP = coldLegP;
  }
}

console.log('\nExtended simulation complete.')

// ============================================================================
// GRID TEST: Explore (u, v) space around cold-leg conditions
// ============================================================================
console.log('\n' + '='.repeat(70));
console.log('GRID TEST: Exploring (u,v) space around cold-leg conditions');
console.log('='.repeat(70));
console.log('\nUser-provided cold-leg state at step 144:');
console.log('  mass: 2958.04 kg');
console.log('  U: 3799.67 MJ');
console.log('  V: 4 m³');
console.log('  Calculated: ρ = 739.5 kg/m³, v = 0.001352 m³/kg, u = 1284.5 kJ/kg');
console.log('\nGenerating grid around this point to look for cliff effects...\n');

// Reference point from user data
const refMass = 2958.038738442967;
const refU = 3799672370.647095; // J
const refV = 4; // m³

// Derived values
const ref_rho = refMass / refV;
const ref_v = refV / refMass;
const ref_u = refU / refMass;

console.log(`Reference point: v=${ref_v.toFixed(6)} m³/kg, u=${(ref_u/1000).toFixed(2)} kJ/kg`);
console.log('');

// Grid parameters: ±2% around reference in 21 steps (fine grid)
const gridSteps = 21;
const vRange = 0.02; // ±2%
const uRange = 0.02; // ±2%

// Calculate grid bounds
const vMin = ref_v * (1 - vRange);
const vMax = ref_v * (1 + vRange);
const uMin = ref_u * (1 - uRange);
const uMax = ref_u * (1 + uRange);

const vStep = (vMax - vMin) / (gridSteps - 1);
const uStep = (uMax - uMin) / (gridSteps - 1);

console.log(`Grid bounds: v=[${vMin.toFixed(6)}, ${vMax.toFixed(6)}] m³/kg`);
console.log(`             u=[${(uMin/1000).toFixed(2)}, ${(uMax/1000).toFixed(2)}] kJ/kg`);
console.log(`Grid size: ${gridSteps}x${gridSteps} = ${gridSteps * gridSteps} points`);
console.log('');

// Store results for analysis
interface GridResult {
  v: number;
  u: number;
  T: number;
  P: number;
  phase: string;
  quality: number;
}

const gridResults: GridResult[][] = [];
let maxT = -Infinity, minT = Infinity;
let maxP = -Infinity, minP = Infinity;
let maxTJump = 0, maxPJump = 0;
let jumpLocation_T = { i: 0, j: 0 };
let jumpLocation_P = { i: 0, j: 0 };

// Run the grid
for (let i = 0; i < gridSteps; i++) {
  const row: GridResult[] = [];
  for (let j = 0; j < gridSteps; j++) {
    const v = vMin + i * vStep;
    const u = uMin + j * uStep;

    // Convert to calculateState inputs: mass, internalEnergy, volume
    // Use a reference volume of 1 m³, so mass = 1/v and U = u (for 1 kg)
    const testMass = 1; // 1 kg
    const testU = u;    // u is already J/kg, so for 1 kg this is total U in J
    const testV = v;    // v is m³/kg, so for 1 kg this is total V in m³

    const state = calculateState(testMass, testU, testV);

    const result: GridResult = {
      v,
      u,
      T: state.temperature - 273.15, // Convert to Celsius
      P: state.pressure / 1e5,       // Convert to bar
      phase: state.phase,
      quality: state.quality,
    };
    row.push(result);

    // Track extremes
    if (result.T > maxT) maxT = result.T;
    if (result.T < minT) minT = result.T;
    if (result.P > maxP) maxP = result.P;
    if (result.P < minP) minP = result.P;

    // Track jumps between adjacent cells
    if (i > 0) {
      const prevRow = gridResults[i - 1];
      const dT = Math.abs(result.T - prevRow[j].T);
      const dP = Math.abs(result.P - prevRow[j].P);
      if (dT > maxTJump) {
        maxTJump = dT;
        jumpLocation_T = { i, j };
      }
      if (dP > maxPJump) {
        maxPJump = dP;
        jumpLocation_P = { i, j };
      }
    }
    if (j > 0) {
      const dT = Math.abs(result.T - row[j - 1].T);
      const dP = Math.abs(result.P - row[j - 1].P);
      if (dT > maxTJump) {
        maxTJump = dT;
        jumpLocation_T = { i, j };
      }
      if (dP > maxPJump) {
        maxPJump = dP;
        jumpLocation_P = { i, j };
      }
    }
  }
  gridResults.push(row);
}

// Report summary
console.log('=== GRID RESULTS SUMMARY ===');
console.log(`Temperature range: ${minT.toFixed(1)}°C to ${maxT.toFixed(1)}°C (span: ${(maxT - minT).toFixed(1)}°C)`);
console.log(`Pressure range: ${minP.toFixed(1)} bar to ${maxP.toFixed(1)} bar (span: ${(maxP - minP).toFixed(1)} bar)`);
console.log('');
console.log(`Max T jump between adjacent cells: ${maxTJump.toFixed(2)}°C at grid[${jumpLocation_T.i}][${jumpLocation_T.j}]`);
console.log(`Max P jump between adjacent cells: ${maxPJump.toFixed(2)} bar at grid[${jumpLocation_P.i}][${jumpLocation_P.j}]`);

// Look for phase transitions
let phaseTransitions = 0;
let twoPhaseCount = 0;
for (let i = 0; i < gridSteps; i++) {
  for (let j = 0; j < gridSteps; j++) {
    if (gridResults[i][j].phase === 'two-phase') twoPhaseCount++;
    if (i > 0 && gridResults[i][j].phase !== gridResults[i - 1][j].phase) phaseTransitions++;
    if (j > 0 && gridResults[i][j].phase !== gridResults[i][j - 1].phase) phaseTransitions++;
  }
}
console.log(`Phase transitions in grid: ${phaseTransitions}`);
console.log(`Two-phase points: ${twoPhaseCount}/${gridSteps * gridSteps}`);
console.log('');

// Print detailed output for the center row (constant v near reference)
const centerI = Math.floor(gridSteps / 2);
console.log(`=== SLICE AT CONSTANT v = ${(vMin + centerI * vStep).toFixed(6)} m³/kg (near reference v) ===`);
console.log('u (kJ/kg)  |  T (°C)   |  P (bar)  |  Phase      |  Quality');
console.log('-'.repeat(70));
for (let j = 0; j < gridSteps; j++) {
  const r = gridResults[centerI][j];
  const qualityStr = r.phase === 'two-phase' ? `${(r.quality * 100).toFixed(1)}%` : 'N/A';
  console.log(`${(r.u / 1000).toFixed(2).padStart(9)} | ${r.T.toFixed(2).padStart(9)} | ${r.P.toFixed(2).padStart(9)} | ${r.phase.padEnd(11)} | ${qualityStr}`);
}

console.log('');

// Print detailed output for the center column (constant u near reference)
const centerJ = Math.floor(gridSteps / 2);
console.log(`=== SLICE AT CONSTANT u = ${((uMin + centerJ * uStep) / 1000).toFixed(2)} kJ/kg (near reference u) ===`);
console.log('v (m³/kg)   |  T (°C)   |  P (bar)  |  Phase      |  Quality');
console.log('-'.repeat(70));
for (let i = 0; i < gridSteps; i++) {
  const r = gridResults[i][centerJ];
  const qualityStr = r.phase === 'two-phase' ? `${(r.quality * 100).toFixed(1)}%` : 'N/A';
  console.log(`${r.v.toFixed(7).padStart(11)} | ${r.T.toFixed(2).padStart(9)} | ${r.P.toFixed(2).padStart(9)} | ${r.phase.padEnd(11)} | ${qualityStr}`);
}

console.log('');

// Check for cliff effects: where T or P jumps by more than 5% of their range
const TThreshold = (maxT - minT) * 0.05;
const PThreshold = (maxP - minP) * 0.05;

console.log('=== CLIFF EFFECT ANALYSIS ===');
console.log(`Looking for T jumps > ${TThreshold.toFixed(2)}°C or P jumps > ${PThreshold.toFixed(2)} bar...`);

let cliffCount = 0;
for (let i = 0; i < gridSteps; i++) {
  for (let j = 0; j < gridSteps; j++) {
    const curr = gridResults[i][j];

    // Check vertical neighbor
    if (i > 0) {
      const prev = gridResults[i - 1][j];
      const dT = Math.abs(curr.T - prev.T);
      const dP = Math.abs(curr.P - prev.P);

      if (dT > TThreshold || dP > PThreshold) {
        cliffCount++;
        if (cliffCount <= 10) { // Limit output
          console.log(`  CLIFF at grid[${i}][${j}] (vertical):`);
          console.log(`    From: v=${prev.v.toFixed(6)}, u=${(prev.u/1000).toFixed(2)} -> T=${prev.T.toFixed(1)}°C, P=${prev.P.toFixed(1)}bar, ${prev.phase}`);
          console.log(`    To:   v=${curr.v.toFixed(6)}, u=${(curr.u/1000).toFixed(2)} -> T=${curr.T.toFixed(1)}°C, P=${curr.P.toFixed(1)}bar, ${curr.phase}`);
          console.log(`    Jump: ΔT=${dT.toFixed(2)}°C, ΔP=${dP.toFixed(2)}bar`);
        }
      }
    }

    // Check horizontal neighbor
    if (j > 0) {
      const prev = gridResults[i][j - 1];
      const dT = Math.abs(curr.T - prev.T);
      const dP = Math.abs(curr.P - prev.P);

      if (dT > TThreshold || dP > PThreshold) {
        cliffCount++;
        if (cliffCount <= 10) { // Limit output
          console.log(`  CLIFF at grid[${i}][${j}] (horizontal):`);
          console.log(`    From: v=${prev.v.toFixed(6)}, u=${(prev.u/1000).toFixed(2)} -> T=${prev.T.toFixed(1)}°C, P=${prev.P.toFixed(1)}bar, ${prev.phase}`);
          console.log(`    To:   v=${curr.v.toFixed(6)}, u=${(curr.u/1000).toFixed(2)} -> T=${curr.T.toFixed(1)}°C, P=${curr.P.toFixed(1)}bar, ${curr.phase}`);
          console.log(`    Jump: ΔT=${dT.toFixed(2)}°C, ΔP=${dP.toFixed(2)}bar`);
        }
      }
    }
  }
}

if (cliffCount === 0) {
  console.log('  No significant cliff effects found in the grid.');
} else if (cliffCount > 10) {
  console.log(`  ... and ${cliffCount - 10} more cliff locations.`);
}

console.log('');
console.log(`Total cliff locations: ${cliffCount}`);

// Check the exact user point
console.log('');
console.log('=== EXACT USER POINT CHECK ===');
const userState = calculateState(refMass, refU, refV);
console.log(`calculateState(m=${refMass.toFixed(2)}, U=${(refU/1e6).toFixed(3)}MJ, V=${refV}m³):`);
console.log(`  T = ${(userState.temperature - 273.15).toFixed(2)}°C`);
console.log(`  P = ${(userState.pressure / 1e5).toFixed(2)} bar`);
console.log(`  ρ = ${userState.density.toFixed(2)} kg/m³`);
console.log(`  phase = ${userState.phase}`);
console.log(`  quality = ${userState.phase === 'two-phase' ? (userState.quality * 100).toFixed(1) + '%' : 'N/A'}`);
console.log(`  User reported: T=${(563.95 - 273.15).toFixed(1)}°C, P=${(14651947.45 / 1e5).toFixed(2)}bar`);

// Compare with small perturbations around exact point
console.log('');
console.log('=== PERTURBATION TEST AROUND USER POINT ===');
const perturbations = [-0.01, -0.005, -0.001, 0, 0.001, 0.005, 0.01];
console.log('Testing ±1%, ±0.5%, ±0.1% perturbations in mass (which changes v):');
console.log('Δm(%)    |  v (m³/kg)   |  T (°C)   |  P (bar)  |  ΔT     |  ΔP');
console.log('-'.repeat(75));

let baseT = 0, baseP = 0;
for (const pct of perturbations) {
  const testMass = refMass * (1 + pct);
  const testState = calculateState(testMass, refU, refV);
  const T = testState.temperature - 273.15;
  const P = testState.pressure / 1e5;
  const v = refV / testMass;

  if (pct === 0) {
    baseT = T;
    baseP = P;
  }

  const dT = T - baseT;
  const dP = P - baseP;

  console.log(`${(pct * 100).toFixed(1).padStart(6)}%  | ${v.toFixed(8).padStart(12)} | ${T.toFixed(2).padStart(9)} | ${P.toFixed(2).padStart(9)} | ${dT.toFixed(2).padStart(7)} | ${dP.toFixed(2)}`);
}

console.log('');
console.log('Testing ±1%, ±0.5%, ±0.1% perturbations in internal energy (which changes u):');
console.log('ΔU(%)    |  u (kJ/kg)   |  T (°C)   |  P (bar)  |  ΔT     |  ΔP');
console.log('-'.repeat(75));

for (const pct of perturbations) {
  const testU = refU * (1 + pct);
  const testState = calculateState(refMass, testU, refV);
  const T = testState.temperature - 273.15;
  const P = testState.pressure / 1e5;
  const u = testU / refMass / 1000;

  if (pct === 0) {
    baseT = T;
    baseP = P;
  }

  const dT = T - baseT;
  const dP = P - baseP;

  console.log(`${(pct * 100).toFixed(1).padStart(6)}%  | ${u.toFixed(4).padStart(12)} | ${T.toFixed(2).padStart(9)} | ${P.toFixed(2).padStart(9)} | ${dT.toFixed(2).padStart(7)} | ${dP.toFixed(2)}`);
}

console.log('');
console.log('Grid test complete.')
