/**
 * Test script for NCG (Non-Condensible Gas) transport.
 *
 * This verifies that:
 * 1. NCGs are transported with vapor/mixture flow
 * 2. NCGs stay in place during pure liquid flow
 * 3. NCG moles are conserved during transport
 *
 * Run with: npx tsx scripts/test-ncg-transport.ts
 */

import {
  SimulationState,
  FlowNode,
  FlowConnection,
  createGasComposition,
  totalMoles,
  emptyGasComposition,
  ALL_GAS_SPECIES,
} from '../src/simulation/index.js';
import { FlowRateOperator } from '../src/simulation/operators/rate-operators.js';
import { applyRatesToState } from '../src/simulation/rk45-solver.js';
import * as Water from '../src/simulation/water-properties.js';

// Helper to create a minimal simulation state with flow nodes and connections
function createTestState(
  flowNodes: FlowNode[],
  flowConnections: FlowConnection[]
): SimulationState {
  const nodeMap = new Map<string, FlowNode>();
  for (const node of flowNodes) {
    nodeMap.set(node.id, node);
  }

  return {
    time: 0,
    thermalNodes: new Map(),
    flowNodes: nodeMap,
    thermalConnections: [],
    convectionConnections: [],
    flowConnections,
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

async function runTests() {
  console.log('=== NCG Transport Test ===\n');

  // Ensure water properties are loaded
  await Water.preloadWaterProperties();

  const flowOperator = new FlowRateOperator();

  // Test 1: Vapor flow transports NCG
  console.log('Test 1: Vapor flow transports NCG from node A to node B');
  {
    // Two vapor nodes connected by a flow path
    const nodeA: FlowNode = {
      id: 'node-A',
      label: 'Node A',
      fluid: {
        mass: 10,  // kg of steam
        internalEnergy: 10 * 2600 * 1000, // ~2600 kJ/kg for steam
        temperature: 400,
        pressure: 200000,
        phase: 'vapor',
        quality: 1,
        ncg: createGasComposition({ N2: 10, O2: 2 }), // 12 mol NCG
      },
      volume: 10,
      hydraulicDiameter: 0.1,
      flowArea: 0.01,
      elevation: 0,
    };

    const nodeB: FlowNode = {
      id: 'node-B',
      label: 'Node B',
      fluid: {
        mass: 10,
        internalEnergy: 10 * 2600 * 1000,
        temperature: 400,
        pressure: 200000,
        phase: 'vapor',
        quality: 1,
        ncg: emptyGasComposition(),
      },
      volume: 10,
      hydraulicDiameter: 0.1,
      flowArea: 0.01,
      elevation: 0,
    };

    const conn: FlowConnection = {
      id: 'conn-AB',
      fromNodeId: 'node-A',
      toNodeId: 'node-B',
      flowArea: 0.01,
      hydraulicDiameter: 0.1,
      length: 1,
      elevation: 0,
      resistanceCoeff: 1,
      massFlowRate: 1, // 1 kg/s from A to B
    };

    const state = createTestState([nodeA, nodeB], [conn]);

    // Compute rates
    const rates = flowOperator.computeRates(state);

    // Check NCG rates
    const ratesA = rates.flowNodes.get('node-A');
    const ratesB = rates.flowNodes.get('node-B');

    console.log(`  Node A NCG: N₂=${nodeA.fluid.ncg!.N2} mol, O₂=${nodeA.fluid.ncg!.O2} mol`);
    console.log(`  Flow rate: ${conn.massFlowRate} kg/s (A → B)`);
    console.log(`  Node A mass: ${nodeA.fluid.mass} kg`);

    // With 1 kg/s flow and 10 kg total, 10% of NCG should transfer per second
    const expectedFraction = conn.massFlowRate / nodeA.fluid.mass; // 0.1
    const expectedN2Rate = nodeA.fluid.ncg!.N2 * expectedFraction; // 1 mol/s
    const expectedO2Rate = nodeA.fluid.ncg!.O2 * expectedFraction; // 0.2 mol/s

    console.log(`  Expected NCG transfer rate: ${expectedFraction * 100}% per second`);
    console.log(`  Expected dN₂/dt: -${expectedN2Rate.toFixed(2)} mol/s from A, +${expectedN2Rate.toFixed(2)} mol/s to B`);

    if (ratesA?.dNcg && ratesB?.dNcg) {
      console.log(`  Actual dN₂/dt for A: ${ratesA.dNcg.N2.toFixed(4)} mol/s`);
      console.log(`  Actual dN₂/dt for B: ${ratesB.dNcg.N2.toFixed(4)} mol/s`);

      const n2Error = Math.abs(ratesA.dNcg.N2 + expectedN2Rate);
      const conserved = Math.abs(ratesA.dNcg.N2 + ratesB.dNcg.N2) < 1e-10;

      if (n2Error < 0.001 && conserved) {
        console.log('  ✓ Pass (NCG transported correctly, conservation verified)\n');
      } else {
        console.log(`  ✗ FAIL (n2Error: ${n2Error}, conserved: ${conserved})\n`);
      }
    } else {
      console.log('  ✗ FAIL (no dNcg rates computed)\n');
    }
  }

  // Test 2: Apply rates over time step - verify NCG moves
  console.log('Test 2: Apply NCG transport over 1 second timestep');
  {
    const nodeA: FlowNode = {
      id: 'node-A2',
      label: 'Node A',
      fluid: {
        mass: 100,
        internalEnergy: 100 * 2600 * 1000,
        temperature: 400,
        pressure: 200000,
        phase: 'vapor',
        quality: 1,
        ncg: createGasComposition({ H2: 50 }), // 50 mol H₂
      },
      volume: 100,
      hydraulicDiameter: 0.5,
      flowArea: 0.2,
      elevation: 0,
    };

    const nodeB: FlowNode = {
      id: 'node-B2',
      label: 'Node B',
      fluid: {
        mass: 100,
        internalEnergy: 100 * 2600 * 1000,
        temperature: 400,
        pressure: 200000,
        phase: 'vapor',
        quality: 1,
        // No NCG initially
      },
      volume: 100,
      hydraulicDiameter: 0.5,
      flowArea: 0.2,
      elevation: 0,
    };

    const conn: FlowConnection = {
      id: 'conn-AB2',
      fromNodeId: 'node-A2',
      toNodeId: 'node-B2',
      flowArea: 0.1,
      hydraulicDiameter: 0.3,
      length: 5,
      elevation: 0,
      resistanceCoeff: 1,
      massFlowRate: 10, // 10 kg/s
    };

    const state = createTestState([nodeA, nodeB], [conn]);
    const initialH2_A = nodeA.fluid.ncg!.H2;
    const initialH2_B = 0;
    const initialTotal = initialH2_A + initialH2_B;

    console.log(`  Initial: A has ${initialH2_A} mol H₂, B has ${initialH2_B} mol H₂`);
    console.log(`  Flow: ${conn.massFlowRate} kg/s for 1 second`);

    // Compute rates and apply for 1 second
    const rates = flowOperator.computeRates(state);
    const newState = applyRatesToState(state, rates, 1.0);

    const finalA = newState.flowNodes.get('node-A2')!;
    const finalB = newState.flowNodes.get('node-B2')!;
    const finalH2_A = finalA.fluid.ncg?.H2 ?? 0;
    const finalH2_B = finalB.fluid.ncg?.H2 ?? 0;
    const finalTotal = finalH2_A + finalH2_B;

    console.log(`  After 1s: A has ${finalH2_A.toFixed(2)} mol H₂, B has ${finalH2_B.toFixed(2)} mol H₂`);
    console.log(`  Total H₂: ${finalTotal.toFixed(4)} mol (should be ${initialTotal})`);

    // 10 kg/s from 100 kg = 10% per second
    const expectedTransfer = initialH2_A * 0.1; // 5 mol
    const expectedA = initialH2_A - expectedTransfer; // 45 mol
    const expectedB = expectedTransfer; // 5 mol

    const errorA = Math.abs(finalH2_A - expectedA);
    const errorB = Math.abs(finalH2_B - expectedB);
    const conserved = Math.abs(finalTotal - initialTotal) < 1e-6;

    if (errorA < 0.01 && errorB < 0.01 && conserved) {
      console.log('  ✓ Pass (H₂ transported correctly, mass conserved)\n');
    } else {
      console.log(`  ✗ FAIL (errorA: ${errorA.toFixed(4)}, errorB: ${errorB.toFixed(4)}, conserved: ${conserved})\n`);
    }
  }

  // Test 3: Pure liquid flow should NOT transport NCG
  console.log('Test 3: Pure liquid flow should NOT transport NCG');
  {
    // Two liquid nodes - NCG should stay in place
    const nodeA: FlowNode = {
      id: 'node-A3',
      label: 'Node A (liquid)',
      fluid: {
        mass: 1000,
        internalEnergy: 1000 * 200 * 1000, // ~200 kJ/kg for liquid
        temperature: 320,
        pressure: 1000000,
        phase: 'liquid',
        quality: 0,
        ncg: createGasComposition({ N2: 5, Ar: 1 }), // NCG in vapor space above liquid
      },
      volume: 1,
      hydraulicDiameter: 0.5,
      flowArea: 0.2,
      elevation: 0,
    };

    const nodeB: FlowNode = {
      id: 'node-B3',
      label: 'Node B (liquid)',
      fluid: {
        mass: 1000,
        internalEnergy: 1000 * 200 * 1000,
        temperature: 320,
        pressure: 1000000,
        phase: 'liquid',
        quality: 0,
      },
      volume: 1,
      hydraulicDiameter: 0.5,
      flowArea: 0.2,
      elevation: 0,
    };

    const conn: FlowConnection = {
      id: 'conn-AB3',
      fromNodeId: 'node-A3',
      toNodeId: 'node-B3',
      flowArea: 0.05,
      hydraulicDiameter: 0.25,
      length: 2,
      elevation: 0,
      resistanceCoeff: 1,
      massFlowRate: 50, // 50 kg/s liquid flow
    };

    const state = createTestState([nodeA, nodeB], [conn]);

    const rates = flowOperator.computeRates(state);
    const ratesA = rates.flowNodes.get('node-A3');
    const ratesB = rates.flowNodes.get('node-B3');

    console.log(`  Node A: liquid phase with ${totalMoles(nodeA.fluid.ncg!).toFixed(1)} mol NCG`);
    console.log(`  Flow: ${conn.massFlowRate} kg/s liquid`);

    // For pure liquid flow, NCG should not be transported
    const hasNcgRates = (ratesA?.dNcg && totalMoles(ratesA.dNcg) !== 0) ||
                        (ratesB?.dNcg && totalMoles(ratesB.dNcg) !== 0);

    if (!hasNcgRates) {
      console.log('  ✓ Pass (no NCG transport with liquid flow)\n');
    } else {
      console.log(`  ✗ FAIL (NCG was transported with liquid flow)\n`);
      if (ratesA?.dNcg) console.log(`    dNcg A: N2=${ratesA.dNcg.N2}`);
      if (ratesB?.dNcg) console.log(`    dNcg B: N2=${ratesB.dNcg.N2}`);
    }
  }

  // Test 4: Conservation across multiple nodes
  console.log('Test 4: NCG conservation in a 3-node chain');
  {
    const createVaporNode = (id: string, ncg?: Record<string, number>): FlowNode => ({
      id,
      label: id,
      fluid: {
        mass: 50,
        internalEnergy: 50 * 2600 * 1000,
        temperature: 420,
        pressure: 300000,
        phase: 'vapor',
        quality: 1,
        ncg: ncg ? createGasComposition(ncg) : undefined,
      },
      volume: 50,
      hydraulicDiameter: 0.3,
      flowArea: 0.07,
      elevation: 0,
    });

    const nodeA = createVaporNode('chain-A', { He: 100 });
    const nodeB = createVaporNode('chain-B');
    const nodeC = createVaporNode('chain-C');

    const connAB: FlowConnection = {
      id: 'conn-chain-AB',
      fromNodeId: 'chain-A',
      toNodeId: 'chain-B',
      flowArea: 0.05,
      hydraulicDiameter: 0.25,
      length: 1,
      elevation: 0,
      resistanceCoeff: 1,
      massFlowRate: 5, // 5 kg/s A → B
    };

    const connBC: FlowConnection = {
      id: 'conn-chain-BC',
      fromNodeId: 'chain-B',
      toNodeId: 'chain-C',
      flowArea: 0.05,
      hydraulicDiameter: 0.25,
      length: 1,
      elevation: 0,
      resistanceCoeff: 1,
      massFlowRate: 5, // 5 kg/s B → C
    };

    const state = createTestState([nodeA, nodeB, nodeC], [connAB, connBC]);
    const initialTotal = totalMoles(nodeA.fluid.ncg!);

    console.log(`  Chain: A(100 mol He) → B → C with 5 kg/s flow`);
    console.log(`  Initial total He: ${initialTotal} mol`);

    // Run 10 steps of 0.5 seconds each
    let currentState = state;
    for (let i = 0; i < 10; i++) {
      const rates = flowOperator.computeRates(currentState);
      currentState = applyRatesToState(currentState, rates, 0.5);
    }

    const finalA = currentState.flowNodes.get('chain-A')!;
    const finalB = currentState.flowNodes.get('chain-B')!;
    const finalC = currentState.flowNodes.get('chain-C')!;

    const heA = finalA.fluid.ncg?.He ?? 0;
    const heB = finalB.fluid.ncg?.He ?? 0;
    const heC = finalC.fluid.ncg?.He ?? 0;
    const finalTotal = heA + heB + heC;

    console.log(`  After 5s: A=${heA.toFixed(2)}, B=${heB.toFixed(2)}, C=${heC.toFixed(2)} mol He`);
    console.log(`  Final total: ${finalTotal.toFixed(4)} mol`);

    const conserved = Math.abs(finalTotal - initialTotal) < 0.01;
    const heMovedToC = heC > 0;

    if (conserved && heMovedToC) {
      console.log('  ✓ Pass (He conserved and transported through chain)\n');
    } else {
      console.log(`  ✗ FAIL (conserved: ${conserved}, heInC: ${heMovedToC})\n`);
    }
  }

  console.log('=== All NCG transport tests complete ===');
}

runTests().catch(console.error);
