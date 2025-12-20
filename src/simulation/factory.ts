/**
 * Simulation State Factory
 *
 * Creates initial simulation states for different reactor configurations.
 * This bridges the gap between the visual plant layout and the simulation model.
 */

import {
  SimulationState,
  ThermalNode,
  FlowNode,
  NeutronicsState,
} from './types';
import { createFluidState } from './operators';

/**
 * Create an empty simulation state
 */
export function createSimulationState(): SimulationState {
  return {
    time: 0,
    thermalNodes: new Map(),
    flowNodes: new Map(),
    thermalConnections: [],
    convectionConnections: [],
    flowConnections: [],
    neutronics: createDefaultNeutronics(),
    components: {
      pumps: new Map(),
      valves: new Map(),
    },
  };
}

/**
 * Create default neutronics state for a typical LWR
 */
function createDefaultNeutronics(): NeutronicsState {
  return {
    power: 0,
    nominalPower: 1000e6, // 1000 MW thermal

    reactivity: 0,
    promptNeutronLifetime: 1e-4, // 100 microseconds
    delayedNeutronFraction: 0.0065, // β for U-235

    precursorConcentration: 800.0,
    precursorDecayConstant: 0.08, // Effective λ

    // Reactivity feedback coefficients (typical LWR values)
    // Note: these are in Δρ per unit change
    fuelTempCoeff: -2.5e-5,      // -2.5 pcm/K (Doppler) - negative is good!
    coolantTempCoeff: -1e-5,      // -1 pcm/K - can be positive in some designs
    coolantDensityCoeff: 0.001,  // Large negative void coefficient

    refFuelTemp: 887,     // K - reference temperature
    refCoolantTemp: 520,  // K
    refCoolantDensity: 750, // kg/m³ at operating conditions

    controlRodPosition: 0.8, // Mostly withdrawn
    controlRodWorth: 0.05,   // 5000 pcm total worth

    decayHeatFraction: 0,
    scrammed: false,
    scramTime: -1,
    reactivityBreakdown: {
      controlRods: 0,
      doppler: 0,
      coolantTemp: 0,
      coolantDensity: 0,
    },
    diagnostics: {
      fuelTemp: 887,
      coolantTemp: 520,
      coolantDensity: 850,
    },
  };
}

/**
 * Create a demonstration reactor with realistic-ish parameters
 * This is a simplified PWR model
 */
export function createDemoReactor(): SimulationState {
  const state = createSimulationState();

  // =========================================================================
  // THERMAL NODES (Solid structures)
  // =========================================================================

  // Fuel (lumped as single node for simplicity)
  const fuel: ThermalNode = {
    id: 'fuel',
    label: 'Fuel (UO2)',
    temperature: 900, // K - typical centerline
    mass: 80000, // kg of UO2
    specificHeat: 300, // J/kg-K for UO2
    thermalConductivity: 3, // W/m-K (decreases with temp, but simplified)
    characteristicLength: 0.005, // m - pellet radius
    surfaceArea: 5000, // m² - total fuel surface area
    heatGeneration: 1000e6, // W - set by neutronics
    maxTemperature: 2800, // K - fuel melting point
  };
  state.thermalNodes.set(fuel.id, fuel);

  // Cladding
  const clad: ThermalNode = {
    id: 'clad',
    label: 'Cladding (Zircaloy)',
    temperature: 620, // K
    mass: 25000, // kg
    specificHeat: 330, // J/kg-K
    thermalConductivity: 16, // W/m-K
    characteristicLength: 0.0006, // m - clad thickness
    surfaceArea: 5000, // m²
    heatGeneration: 0,
    maxTemperature: 1500, // K - before significant oxidation
  };
  state.thermalNodes.set(clad.id, clad);

  // Reactor vessel wall (lower portion near core)
  const vesselWall: ThermalNode = {
    id: 'vessel-wall',
    label: 'Reactor Vessel Wall',
    temperature: 560, // K
    mass: 200000, // kg - massive steel structure
    specificHeat: 500, // J/kg-K for steel
    thermalConductivity: 40, // W/m-K
    characteristicLength: 0.2, // m - wall thickness
    surfaceArea: 100, // m²
    heatGeneration: 0,
    maxTemperature: 800, // K - creep limit
  };
  state.thermalNodes.set(vesselWall.id, vesselWall);

  // Steam generator tubes (primary side structure)
  const sgTubes: ThermalNode = {
    id: 'sg-tubes',
    label: 'Steam Generator Tubes',
    temperature: 570, // K
    mass: 50000, // kg
    specificHeat: 500, // J/kg-K
    thermalConductivity: 20, // W/m-K
    characteristicLength: 0.001, // m - tube wall thickness
    surfaceArea: 10000, // m² - lots of tubes!
    heatGeneration: 0,
    maxTemperature: 900, // K
  };
  state.thermalNodes.set(sgTubes.id, sgTubes);

  // =========================================================================
  // FLOW NODES (Fluid volumes)
  // =========================================================================

  // Using createFluidState to properly initialize mass and internalEnergy
  // from temperature, pressure, phase, quality, and volume.
  // This ensures thermodynamic consistency from the start.
  //
  // PRESSURE GRADIENT for steady-state circulation:
  // Pump provides ~3 bar head, which must be distributed around the loop
  // to overcome friction losses. The pressure drops as flow moves through
  // each leg, with the pump adding head in the cold leg to core section.
  //
  // Approximate steady-state pressure distribution:
  // - Cold leg (just before pump): lowest pressure in loop
  // - Core (just after pump): highest pressure in loop
  // - Hot leg: intermediate (pressure drop from core)
  // - SG: intermediate (pressure drop from hot leg)
  //
  // We use a small gradient (~1-2 bar around the loop) to match the
  // resistance coefficients and expected flow rate of ~5000 kg/s.

  // Core coolant channel - highest pressure (just got pump head)
  const coreVolume = 25; // m³
  const coreCoolant: FlowNode = {
    id: 'core-coolant',
    label: 'Core Coolant Channel',
    fluid: createFluidState(590, 15.6e6, 'liquid', 0, coreVolume), // 156 bar
    volume: coreVolume,
    hydraulicDiameter: 0.012, // m
    flowArea: 4, // m²
    elevation: 0, // Reference
  };
  state.flowNodes.set(coreCoolant.id, coreCoolant);

  // Hot leg - hottest primary coolant (slightly lower pressure, friction loss)
  const hotLegVolume = 4; // m³
  const hotLeg: FlowNode = {
    id: 'hot-leg',
    label: 'Hot Leg',
    fluid: createFluidState(598, 15.55e6, 'liquid', 0, hotLegVolume), // 155.5 bar
    volume: hotLegVolume,
    hydraulicDiameter: 0.7, // m - large pipe
    flowArea: 0.4, // m²
    elevation: 2, // m above core
  };
  state.flowNodes.set(hotLeg.id, hotLeg);

  // Steam generator primary side (further pressure drop)
  const sgPrimaryVolume = 15; // m³
  const sgPrimary: FlowNode = {
    id: 'sg-primary',
    label: 'SG Primary Side',
    fluid: createFluidState(575, 15.45e6, 'liquid', 0, sgPrimaryVolume), // 154.5 bar
    volume: sgPrimaryVolume,
    hydraulicDiameter: 0.02, // m - tube ID
    flowArea: 2, // m²
    elevation: 5, // m - SG is elevated
  };
  state.flowNodes.set(sgPrimary.id, sgPrimary);

  // Cold leg - coolest primary coolant (lowest pressure, before pump)
  const coldLegVolume = 4; // m³
  const coldLeg: FlowNode = {
    id: 'cold-leg',
    label: 'Cold Leg',
    fluid: createFluidState(565, 15.35e6, 'liquid', 0, coldLegVolume), // 153.5 bar
    volume: coldLegVolume,
    hydraulicDiameter: 0.7, // m
    flowArea: 0.4, // m²
    elevation: 2, // m
  };
  state.flowNodes.set(coldLeg.id, coldLeg);

  // Pressurizer - two-phase at saturation (~618K at 155 bar)
  const przVolume = 30; // m³
  const pressurizer: FlowNode = {
    id: 'pressurizer',
    label: 'Pressurizer',
    fluid: createFluidState(618, 15.5e6, 'two-phase', 0.5, przVolume),
    volume: przVolume,
    hydraulicDiameter: 2, // m
    flowArea: 3, // m²
    elevation: 10, // m - high up
  };
  state.flowNodes.set(pressurizer.id, pressurizer);

  // =========================================================================
  // SECONDARY SIDE FLOW NODES
  // =========================================================================
  // Steam generator secondary side (boiling at ~55 bar, ~545K saturation)
  // This is where steam is generated for the turbine

  const sgSecVolume = 50; // m³
  const sgSecondary: FlowNode = {
    id: 'sg-secondary',
    label: 'SG Secondary Side',
    fluid: createFluidState(545, 5.5e6, 'two-phase', 0.3, sgSecVolume),
    volume: sgSecVolume,
    hydraulicDiameter: 0.1, // m
    flowArea: 5, // m²
    elevation: 5, // m
  };
  state.flowNodes.set(sgSecondary.id, sgSecondary);

  // Turbine inlet - superheated/saturated steam from SG
  // Steam leaves SG at ~55 bar, enters turbine
  const turbineInletVolume = 10; // m³
  const turbineInlet: FlowNode = {
    id: 'turbine-inlet',
    label: 'Turbine Inlet',
    fluid: createFluidState(545, 5.5e6, 'vapor', 0, turbineInletVolume),
    volume: turbineInletVolume,
    hydraulicDiameter: 0.5, // m - large steam pipe
    flowArea: 0.2, // m²
    elevation: 5, // m - same level as SG top
  };
  state.flowNodes.set(turbineInlet.id, turbineInlet);

  // Turbine outlet - wet steam exhausting to condenser
  const turbineOutletVolume = 50; // m³ - large due to low density
  const turbineOutlet: FlowNode = {
    id: 'turbine-outlet',
    label: 'Turbine Outlet',
    // At lower pressure after expansion (~1 bar for now, not full vacuum)
    fluid: createFluidState(373, 1e5, 'two-phase', 0.9, turbineOutletVolume),
    volume: turbineOutletVolume,
    hydraulicDiameter: 2, // m - very large exhaust
    flowArea: 3, // m²
    elevation: 0, // m - ground level
  };
  state.flowNodes.set(turbineOutlet.id, turbineOutlet);

  // Condenser - steam condenses to saturated liquid
  // Using ~1 bar (not full vacuum) to avoid edge of steam table data
  const condenserVolume = 100; // m³ - large shell-and-tube HX
  const condenser: FlowNode = {
    id: 'condenser',
    label: 'Main Condenser',
    // Low pressure two-phase, mostly liquid
    fluid: createFluidState(373, 1e5, 'two-phase', 0.1, condenserVolume),
    volume: condenserVolume,
    hydraulicDiameter: 0.02, // m - tubes
    flowArea: 2, // m²
    elevation: -2, // m - below ground level (in basement)
  };
  state.flowNodes.set(condenser.id, condenser);

  // Feedwater - subcooled liquid pumped back to SG
  // Feedwater is heated slightly by condensate pumps and feedwater heaters
  // but still subcooled relative to SG pressure
  const feedwaterVolume = 20; // m³ - piping and small heaters
  const feedwater: FlowNode = {
    id: 'feedwater',
    label: 'Feedwater',
    // Subcooled liquid at SG pressure (~55 bar), temp ~450K (below saturation ~545K)
    fluid: createFluidState(450, 5.5e6, 'liquid', 0, feedwaterVolume),
    volume: feedwaterVolume,
    hydraulicDiameter: 0.3, // m - feedwater piping
    flowArea: 0.07, // m²
    elevation: 0, // m - ground level
  };
  state.flowNodes.set(feedwater.id, feedwater);

  // =========================================================================
  // THERMAL CONNECTIONS (Conduction between solids)
  // =========================================================================

  // Fuel to cladding (through gap)
  state.thermalConnections.push({
    id: 'fuel-clad',
    fromNodeId: 'fuel',
    toNodeId: 'clad',
    // Conductance = k * A / L
    // For 1 GW power and ~300K fuel-to-clad ΔT, need ~3e6 W/K
    // k_UO2 ≈ 3 W/m-K, A ≈ 5000 m², effective path ≈ 0.005m
    conductance: 3000000, // W/K - fuel to cladding
  });

  // =========================================================================
  // CONVECTION CONNECTIONS (Heat transfer to fluids)
  // =========================================================================

  // Cladding to core coolant
  state.convectionConnections.push({
    id: 'clad-coolant',
    thermalNodeId: 'clad',
    flowNodeId: 'core-coolant',
    surfaceArea: 5000, // m²
  });

  // SG tubes to primary coolant
  state.convectionConnections.push({
    id: 'sg-tube-primary',
    thermalNodeId: 'sg-tubes',
    flowNodeId: 'sg-primary',
    surfaceArea: 5000, // m² (tube inner surface)
  });

  // SG tubes to secondary (boiling) side
  state.convectionConnections.push({
    id: 'sg-tube-secondary',
    thermalNodeId: 'sg-tubes',
    flowNodeId: 'sg-secondary',
    surfaceArea: 5500, // m² (tube outer surface)
  });

  // Vessel wall to cold leg (simplified)
  state.convectionConnections.push({
    id: 'vessel-coolant',
    thermalNodeId: 'vessel-wall',
    flowNodeId: 'cold-leg',
    surfaceArea: 50, // m²
  });

  // =========================================================================
  // FLOW CONNECTIONS (Fluid paths)
  // =========================================================================

  // Initialize with steady-state flow rates (~5000 kg/s typical PWR loop flow)
  // This represents a reactor that's already running, not starting from cold
  const steadyStateFlow = 5000; // kg/s

  // Core to hot leg
  state.flowConnections.push({
    id: 'flow-core-hotleg',
    fromNodeId: 'core-coolant',
    toNodeId: 'hot-leg',
    flowArea: 0.4,
    hydraulicDiameter: 0.7,
    length: 2,
    elevation: -2, // Negative = going UP = gravity opposes forward flow
    resistanceCoeff: 2,
    massFlowRate: steadyStateFlow, // Start with established circulation
  });

  // Hot leg to SG
  state.flowConnections.push({
    id: 'flow-hotleg-sg',
    fromNodeId: 'hot-leg',
    toNodeId: 'sg-primary',
    flowArea: 0.4,
    hydraulicDiameter: 0.7,
    length: 5,
    elevation: -3, // Negative = going UP = gravity opposes forward flow
    resistanceCoeff: 3,
    massFlowRate: steadyStateFlow, // Start with established circulation
  });

  // SG to cold leg (SG at 5m, CL at 2m - going DOWN 3m, favors flow)
  state.flowConnections.push({
    id: 'flow-sg-coldleg',
    fromNodeId: 'sg-primary',
    toNodeId: 'cold-leg',
    flowArea: 0.4,
    hydraulicDiameter: 0.7,
    length: 5,
    elevation: 3, // Positive = going down = gravity favors forward flow
    resistanceCoeff: 3,
    massFlowRate: steadyStateFlow, // Start with established circulation
  });

  // Cold leg to core (through pump) (CL at 2m, Core at 0m - going DOWN 2m, favors flow)
  state.flowConnections.push({
    id: 'flow-coldleg-core',
    fromNodeId: 'cold-leg',
    toNodeId: 'core-coolant',
    flowArea: 0.4,
    hydraulicDiameter: 0.7,
    length: 3,
    elevation: 2, // Positive = going down = gravity favors forward flow
    resistanceCoeff: 5, // Includes core resistance
    massFlowRate: steadyStateFlow, // Start with established circulation
  });

  // Pressurizer surge line (small connection to hot leg)
  state.flowConnections.push({
    id: 'flow-przr-surge',
    fromNodeId: 'hot-leg',
    toNodeId: 'pressurizer',
    flowArea: 0.05,
    hydraulicDiameter: 0.25,
    length: 8,
    elevation: -8, // Negative = going UP = gravity opposes flow
    resistanceCoeff: 10,
    massFlowRate: 0, // Normally no flow
  });

  // =========================================================================
  // SECONDARY SIDE FLOW CONNECTIONS
  // =========================================================================

  // Secondary side flow rate: ~500 kg/s steam (at full power)
  // This is much lower than primary because we're moving steam, not liquid
  // Energy balance: Q = m_dot * h_fg ≈ 1000 MW = m_dot * 2000 kJ/kg => m_dot ≈ 500 kg/s
  const secondaryFlow = 500; // kg/s

  // SG to turbine inlet (steam leaves SG through steam dome)
  state.flowConnections.push({
    id: 'flow-sg-turbine',
    fromNodeId: 'sg-secondary',
    toNodeId: 'turbine-inlet',
    flowArea: 0.2,
    hydraulicDiameter: 0.5,
    length: 10,
    elevation: 0, // Same level
    resistanceCoeff: 5,
    massFlowRate: secondaryFlow,
  });

  // Turbine inlet to outlet (through turbine)
  state.flowConnections.push({
    id: 'flow-turbine',
    fromNodeId: 'turbine-inlet',
    toNodeId: 'turbine-outlet',
    flowArea: 0.2,
    hydraulicDiameter: 0.5,
    length: 5,
    elevation: 5, // Going down to ground level
    resistanceCoeff: 20, // High resistance through turbine stages
    massFlowRate: secondaryFlow,
  });

  // Turbine outlet to condenser (exhaust steam to condenser)
  state.flowConnections.push({
    id: 'flow-exhaust-condenser',
    fromNodeId: 'turbine-outlet',
    toNodeId: 'condenser',
    flowArea: 0.5,
    hydraulicDiameter: 0.8,
    length: 5,
    elevation: 2, // Going down to condenser basement
    resistanceCoeff: 5, // Moderate resistance
    massFlowRate: secondaryFlow,
  });

  // Condenser to feedwater (condensate extraction)
  // Condensate pump takes liquid from condenser hotwell
  state.flowConnections.push({
    id: 'flow-condenser-feedwater',
    fromNodeId: 'condenser',
    toNodeId: 'feedwater',
    flowArea: 0.07,
    hydraulicDiameter: 0.3,
    length: 20,
    elevation: -2, // Going up from basement
    resistanceCoeff: 10,
    massFlowRate: secondaryFlow,
  });

  // Feedwater to SG secondary (feedwater injection)
  // Feedwater pump delivers subcooled liquid to SG
  state.flowConnections.push({
    id: 'flow-feedwater-sg',
    fromNodeId: 'feedwater',
    toNodeId: 'sg-secondary',
    flowArea: 0.07,
    hydraulicDiameter: 0.3,
    length: 30,
    elevation: -5, // Going up to SG
    resistanceCoeff: 15,
    massFlowRate: secondaryFlow,
  });

  // =========================================================================
  // COMPONENTS
  // =========================================================================

  // Reactor coolant pump
  // Head calculation for ~5000 kg/s flow:
  // Total loop resistance needs ~12 bar to sustain 5000 kg/s
  // Pump head in meters: H = dP / (rho * g) = 12e5 / (850 * 9.81) = 144m
  // Using slightly higher to account for operating point on pump curve
  state.components.pumps.set('rcp-1', {
    id: 'rcp-1',
    running: true,
    speed: 1.0,
    ratedHead: 150, // m - sized to overcome loop resistance at design flow
    ratedFlow: 5000, // kg/s
    connectedFlowPath: 'flow-coldleg-core',
  });

  // Main isolation valve (normally open)
  state.components.valves.set('msiv', {
    id: 'msiv',
    position: 1.0,
    failPosition: 0, // Closes on failure
    connectedFlowPath: 'flow-hotleg-sg',
  });

  // Feedwater pump - pressurizes condensate from condenser pressure to SG pressure
  // Head: ~55 bar - 1 bar = 54 bar = 5.4 MPa
  // For water at ~400K: rho ~940 kg/m³
  // H = dP / (rho * g) = 5.4e6 / (940 * 9.81) = 585 m
  state.components.pumps.set('fw-pump', {
    id: 'fw-pump',
    running: true,
    speed: 1.0,
    ratedHead: 600, // m - sized for ~55 bar rise
    ratedFlow: 500, // kg/s
    connectedFlowPath: 'flow-feedwater-sg',
  });

  // Main steam isolation valve (MSIV on secondary side)
  state.components.valves.set('msiv-secondary', {
    id: 'msiv-secondary',
    position: 1.0,
    failPosition: 0, // Closes on failure
    connectedFlowPath: 'flow-sg-turbine',
  });

  // =========================================================================
  // NEUTRONICS INITIAL STATE
  // =========================================================================

  state.neutronics = {
    ...createDefaultNeutronics(),
    power: 1000e6, // Start at full power
    nominalPower: 1000e6,
    controlRodPosition: 0.97, // Partially withdrawn for criticality
  };

  // Set fuel heat generation to match power
  const fuelNode = state.thermalNodes.get('fuel');
  if (fuelNode) {
    fuelNode.heatGeneration = state.neutronics.power;
  }

  return state;
}
