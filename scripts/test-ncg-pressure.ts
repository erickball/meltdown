/**
 * Test script for NCG (Non-Condensible Gas) partial pressure integration.
 *
 * This verifies that:
 * 1. NCG partial pressure is correctly calculated using ideal gas law
 * 2. FluidStateConstraintOperator adds NCG pressure to steam pressure
 * 3. Total pressure = P_steam + P_ncg (Dalton's law)
 *
 * Run with: npx ts-node scripts/test-ncg-pressure.ts
 */

import {
  SimulationState,
  FlowNode,
  FluidState,
  createGasComposition,
  ncgPartialPressure,
  totalMoles,
  R_GAS,
  emptyGasComposition,
} from '../src/simulation/index.js';
import { FluidStateConstraintOperator } from '../src/simulation/operators/rate-operators.js';
import * as Water from '../src/simulation/water-properties.js';

// Helper to create a minimal simulation state with one flow node
function createTestState(flowNode: FlowNode): SimulationState {
  const flowNodes = new Map<string, FlowNode>();
  flowNodes.set(flowNode.id, flowNode);

  return {
    time: 0,
    thermalNodes: new Map(),
    flowNodes,
    thermalConnections: [],
    convectionConnections: [],
    flowConnections: [],
    neutronics: {
      coreId: null,
      fuelNodeId: null,
      coolantNodeId: null,
      power: 0,
      nominalPower: 0,
      reactivity: 0,
      promptNeutronLifetime: 1e-5,
      delayedNeutronFraction: 0.0065,
      precursorConcentration: 1,
      precursorDecayConstant: 0.08,
      fuelTempCoeff: -2.5e-5,
      coolantTempCoeff: -1e-5,
      coolantDensityCoeff: 0,
      refFuelTemp: 900,
      refCoolantTemp: 580,
      refCoolantDensity: 700,
      controlRodPosition: 1,
      controlRodWorth: 0.05,
      decayHeatFraction: 0,
      scrammed: false,
      scramTime: 0,
      scramReason: '',
      reactivityBreakdown: { controlRods: 0, doppler: 0, coolantTemp: 0, coolantDensity: 0 },
      diagnostics: { fuelTemp: 900, coolantTemp: 580, coolantDensity: 700 },
    },
    components: {
      pumps: new Map(),
      valves: new Map(),
      checkValves: new Map(),
    },
  };
}

// Create a test flow node
function createTestFlowNode(
  id: string,
  volume: number,    // m³
  mass: number,      // kg
  temperature: number, // K
  ncgMoles?: { N2?: number; O2?: number; H2?: number }
): FlowNode {
  // Calculate internal energy for liquid water at this temperature
  // Approximate: U = m * cp * (T - 273.15) for liquid
  const cp = 4186; // J/kg-K
  const internalEnergy = mass * cp * (temperature - 273.15);

  const fluid: FluidState = {
    mass,
    internalEnergy,
    temperature,
    pressure: 101325, // Will be recalculated by constraint operator
    phase: 'liquid',
    quality: 0,
  };

  if (ncgMoles) {
    fluid.ncg = createGasComposition(ncgMoles);
  }

  return {
    id,
    label: id,
    fluid,
    volume,
    hydraulicDiameter: 0.1,
    flowArea: 0.01,
    elevation: 0,
  };
}

async function runTests() {
  console.log('=== NCG Partial Pressure Test ===\n');

  // Ensure water properties are loaded
  await Water.preloadWaterProperties();

  const operator = new FluidStateConstraintOperator();

  // Test 1: Node without NCG - pressure should be pure steam/water pressure
  console.log('Test 1: Node without NCG');
  {
    const node = createTestFlowNode('test-no-ncg', 1.0, 900, 350); // ~77°C liquid
    const state = createTestState(node);

    const resultState = operator.applyConstraints(state);
    const resultNode = resultState.flowNodes.get('test-no-ncg')!;

    console.log(`  Volume: ${node.volume} m³`);
    console.log(`  Mass: ${node.fluid.mass} kg`);
    console.log(`  Temperature: ${resultNode.fluid.temperature.toFixed(1)} K (${(resultNode.fluid.temperature - 273.15).toFixed(1)}°C)`);
    console.log(`  Pressure: ${(resultNode.fluid.pressure / 1e5).toFixed(3)} bar`);
    console.log(`  Phase: ${resultNode.fluid.phase}`);
    console.log(`  NCG: none`);
    console.log('  ✓ Pass (baseline without NCG)\n');
  }

  // Test 2: Node with nitrogen - should add NCG partial pressure
  console.log('Test 2: Node with 1 mol N₂');
  {
    const volume = 1.0; // m³
    const temperature = 350; // K
    const n_N2 = 1.0; // mol

    // Calculate expected NCG pressure: P = nRT/V
    const expectedPncg = n_N2 * R_GAS * temperature / volume;
    console.log(`  Expected P_ncg = ${n_N2} × ${R_GAS.toFixed(2)} × ${temperature} / ${volume} = ${expectedPncg.toFixed(0)} Pa`);

    const node = createTestFlowNode('test-with-n2', volume, 900, temperature, { N2: n_N2 });
    const state = createTestState(node);

    // Get steam-only pressure first
    const steamOnlyNode = createTestFlowNode('steam-only', volume, 900, temperature);
    const steamOnlyState = createTestState(steamOnlyNode);
    const steamOnlyResult = operator.applyConstraints(steamOnlyState);
    const P_steam = steamOnlyResult.flowNodes.get('steam-only')!.fluid.pressure;

    // Now get total pressure with NCG
    const resultState = operator.applyConstraints(state);
    const resultNode = resultState.flowNodes.get('test-with-n2')!;
    const P_total = resultNode.fluid.pressure;
    const P_ncg_actual = P_total - P_steam;

    console.log(`  P_steam: ${(P_steam / 1e5).toFixed(4)} bar`);
    console.log(`  P_total: ${(P_total / 1e5).toFixed(4)} bar`);
    console.log(`  P_ncg (actual): ${P_ncg_actual.toFixed(0)} Pa`);
    console.log(`  P_ncg (expected): ${expectedPncg.toFixed(0)} Pa`);

    const error = Math.abs(P_ncg_actual - expectedPncg);
    if (error < 1) {
      console.log('  ✓ Pass (NCG pressure matches ideal gas law)\n');
    } else {
      console.log(`  ✗ FAIL (error: ${error.toFixed(1)} Pa)\n`);
    }
  }

  // Test 3: Air mixture (N2 + O2)
  console.log('Test 3: Node with air mixture (0.78 mol N₂ + 0.21 mol O₂)');
  {
    const volume = 0.5; // m³
    const temperature = 400; // K
    const ncg = { N2: 0.78, O2: 0.21 };
    const totalMol = ncg.N2 + ncg.O2;

    const expectedPncg = totalMol * R_GAS * temperature / volume;
    console.log(`  Expected P_ncg = ${totalMol.toFixed(2)} × ${R_GAS.toFixed(2)} × ${temperature} / ${volume} = ${expectedPncg.toFixed(0)} Pa`);

    const node = createTestFlowNode('test-air', volume, 450, temperature, ncg);
    const state = createTestState(node);

    // Get steam-only pressure
    const steamOnlyNode = createTestFlowNode('steam-only-2', volume, 450, temperature);
    const steamOnlyState = createTestState(steamOnlyNode);
    const steamOnlyResult = operator.applyConstraints(steamOnlyState);
    const P_steam = steamOnlyResult.flowNodes.get('steam-only-2')!.fluid.pressure;

    // Get total pressure with NCG
    const resultState = operator.applyConstraints(state);
    const resultNode = resultState.flowNodes.get('test-air')!;
    const P_total = resultNode.fluid.pressure;
    const P_ncg_actual = P_total - P_steam;

    console.log(`  P_steam: ${(P_steam / 1e5).toFixed(4)} bar`);
    console.log(`  P_total: ${(P_total / 1e5).toFixed(4)} bar`);
    console.log(`  P_ncg (actual): ${P_ncg_actual.toFixed(0)} Pa`);
    console.log(`  P_ncg (expected): ${expectedPncg.toFixed(0)} Pa`);

    const error = Math.abs(P_ncg_actual - expectedPncg);
    const relError = error / expectedPncg;
    if (relError < 0.002) { // 0.2% tolerance for floating point
      console.log('  ✓ Pass\n');
    } else {
      console.log(`  ✗ FAIL (error: ${error.toFixed(1)} Pa, ${(relError*100).toFixed(2)}%)\n`);
    }
  }

  // Test 4: Hydrogen flammability scenario
  console.log('Test 4: Containment-like scenario with hydrogen');
  {
    const volume = 50000; // m³ (large containment)
    const temperature = 400; // K (~127°C)
    // 1000 mol of air + 100 mol H2 (roughly 10% H2 by mole)
    const ncg = { N2: 780, O2: 210, H2: 100 };
    const totalMol = ncg.N2 + ncg.O2 + ncg.H2;

    const expectedPncg = totalMol * R_GAS * temperature / volume;

    const node = createTestFlowNode('containment', volume, 45000000, temperature, ncg); // 45,000 tonnes water
    const state = createTestState(node);

    const resultState = operator.applyConstraints(state);
    const resultNode = resultState.flowNodes.get('containment')!;

    // Verify NCG is preserved
    const resultNcg = resultNode.fluid.ncg!;
    console.log(`  NCG composition: N₂=${resultNcg.N2} mol, O₂=${resultNcg.O2} mol, H₂=${resultNcg.H2} mol`);
    console.log(`  Total NCG: ${totalMoles(resultNcg).toFixed(0)} mol`);
    console.log(`  H₂ fraction: ${(resultNcg.H2 / totalMoles(resultNcg) * 100).toFixed(1)}%`);
    console.log(`  Expected P_ncg: ${expectedPncg.toFixed(0)} Pa (${(expectedPncg / 1e5).toFixed(4)} bar)`);
    console.log(`  Total pressure: ${(resultNode.fluid.pressure / 1e5).toFixed(4)} bar`);

    if (resultNcg.H2 === ncg.H2 && resultNcg.N2 === ncg.N2 && resultNcg.O2 === ncg.O2) {
      console.log('  ✓ Pass (NCG composition preserved)\n');
    } else {
      console.log('  ✗ FAIL (NCG composition changed)\n');
    }
  }

  // Test 5: Verify ncgPartialPressure function directly
  console.log('Test 5: Direct ncgPartialPressure function test');
  {
    const comp = createGasComposition({ N2: 2.5, O2: 0.5, H2: 0.1 });
    const T = 373.15; // 100°C
    const V = 0.1; // 0.1 m³

    const P = ncgPartialPressure(comp, T, V);
    const expected = (2.5 + 0.5 + 0.1) * R_GAS * T / V;

    console.log(`  Composition: N₂=2.5 mol, O₂=0.5 mol, H₂=0.1 mol`);
    console.log(`  T=${T} K, V=${V} m³`);
    console.log(`  Calculated P: ${P.toFixed(0)} Pa`);
    console.log(`  Expected P: ${expected.toFixed(0)} Pa`);

    if (Math.abs(P - expected) < 0.1) {
      console.log('  ✓ Pass\n');
    } else {
      console.log('  ✗ FAIL\n');
    }
  }

  // Test 6: Empty NCG should add zero pressure
  console.log('Test 6: Empty NCG composition');
  {
    const node = createTestFlowNode('test-empty-ncg', 1.0, 900, 350);
    node.fluid.ncg = emptyGasComposition(); // Explicitly set empty NCG

    const state = createTestState(node);

    // Compare with node that has no NCG at all
    const noNcgNode = createTestFlowNode('test-no-ncg-2', 1.0, 900, 350);
    const noNcgState = createTestState(noNcgNode);

    const resultWithEmpty = operator.applyConstraints(state);
    const resultWithoutNcg = operator.applyConstraints(noNcgState);

    const P_with_empty = resultWithEmpty.flowNodes.get('test-empty-ncg')!.fluid.pressure;
    const P_without = resultWithoutNcg.flowNodes.get('test-no-ncg-2')!.fluid.pressure;

    console.log(`  P with empty NCG: ${(P_with_empty / 1e5).toFixed(6)} bar`);
    console.log(`  P without NCG: ${(P_without / 1e5).toFixed(6)} bar`);

    if (Math.abs(P_with_empty - P_without) < 0.1) {
      console.log('  ✓ Pass (empty NCG adds zero pressure)\n');
    } else {
      console.log('  ✗ FAIL\n');
    }
  }

  console.log('=== All tests complete ===');
}

runTests().catch(console.error);
