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
  FlowConnection,
  FluidState,
  NeutronicsState,
  PumpState,
  ValveState,
} from './types';
import { createFluidState } from './operators';
import { saturationTemperature } from './water-properties';
import * as Water from './water-properties';
import { PlantState, PlantComponent, Connection } from '../types';

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
      checkValves: new Map(),
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
  // HYDROSTATIC EQUILIBRIUM:
  // For zero initial ΔPfb, the pressure at each liquid node must equal
  // P_base, which is derived from the pressurizer via hydrostatic adjustment.
  // The pressurizer sets the system pressure (two-phase at saturation).
  //
  // P_base(node) = P_prz - ρ * g * (elevation_node - elevation_prz)
  //
  // Note: Since pressurizer is higher than most nodes, and ρ*g*Δh is positive
  // when Δh is negative (going down), nodes below the pressurizer have
  // HIGHER P_base than the pressurizer.
  //
  // Temperatures are chosen to give a typical temperature profile:
  // - Core outlet (hot leg): ~325°C (highest)
  // - Core inlet (cold leg): ~290°C
  // - SG outlet (cold leg side): similar to cold leg

  // Pressurizer sets the system pressure reference
  const P_prz = 15.0e6; // Pa (150 bar) - saturation at ~342°C
  const elev_prz = 10; // m
  const g = 9.81;
  // Use approximate liquid density for hydrostatic calculation (~700 kg/m³ at these temps)
  const rho_hydro = 700;

  // Calculate P_base for each node based on hydrostatic equilibrium
  const elevations = {
    'core-coolant': 0,
    'hot-leg': 2,
    'sg-primary': 5,
    'cold-leg': 2,
  };

  function P_base_at(elevation: number): number {
    // P = P_prz + ρ*g*(elev_prz - elevation)
    // Going down (lower elevation) increases pressure
    return P_prz + rho_hydro * g * (elev_prz - elevation);
  }

  // Core coolant - at elevation 0, so P_base ≈ 150 + 0.69 ≈ 150.7 bar
  const coreVolume = 25; // m³
  const P_core = P_base_at(elevations['core-coolant']);
  const coreCoolant: FlowNode = {
    id: 'core-coolant',
    label: 'Core Coolant Channel',
    fluid: createFluidState(590, P_core, 'liquid', 0, coreVolume),
    volume: coreVolume,
    hydraulicDiameter: 0.012, // m
    flowArea: 4, // m²
    elevation: elevations['core-coolant'],
  };
  state.flowNodes.set(coreCoolant.id, coreCoolant);

  // Hot leg - at elevation 2m, P_base ≈ 150 + 0.55 ≈ 150.5 bar
  const hotLegVolume = 4; // m³
  const P_hotleg = P_base_at(elevations['hot-leg']);
  const hotLeg: FlowNode = {
    id: 'hot-leg',
    label: 'Hot Leg',
    fluid: createFluidState(598, P_hotleg, 'liquid', 0, hotLegVolume),
    volume: hotLegVolume,
    hydraulicDiameter: 0.7, // m - large pipe
    flowArea: 0.4, // m²
    elevation: elevations['hot-leg'],
  };
  state.flowNodes.set(hotLeg.id, hotLeg);

  // Steam generator primary side - at elevation 5m, P_base ≈ 150 + 0.34 ≈ 150.3 bar
  const sgPrimaryVolume = 15; // m³
  const P_sg = P_base_at(elevations['sg-primary']);
  const sgPrimary: FlowNode = {
    id: 'sg-primary',
    label: 'SG Primary Side',
    fluid: createFluidState(575, P_sg, 'liquid', 0, sgPrimaryVolume),
    volume: sgPrimaryVolume,
    hydraulicDiameter: 0.02, // m - tube ID
    flowArea: 2, // m²
    elevation: elevations['sg-primary'],
  };
  state.flowNodes.set(sgPrimary.id, sgPrimary);

  // Cold leg - at elevation 2m, same P_base as hot leg
  const coldLegVolume = 4; // m³
  const P_coldleg = P_base_at(elevations['cold-leg']);
  const coldLeg: FlowNode = {
    id: 'cold-leg',
    label: 'Cold Leg',
    fluid: createFluidState(565, P_coldleg, 'liquid', 0, coldLegVolume),
    volume: coldLegVolume,
    hydraulicDiameter: 0.7, // m
    flowArea: 0.4, // m²
    elevation: elevations['cold-leg'],
  };
  state.flowNodes.set(coldLeg.id, coldLeg);

  // Pressurizer - two-phase at saturation
  // Use exact saturation temperature from steam tables for consistency
  const T_prz = saturationTemperature(P_prz);
  const przVolume = 30; // m³
  const pressurizer: FlowNode = {
    id: 'pressurizer',
    label: 'Pressurizer',
    fluid: createFluidState(T_prz, P_prz, 'two-phase', 0.5, przVolume),
    volume: przVolume,
    hydraulicDiameter: 2, // m
    flowArea: 3, // m²
    elevation: elev_prz,
  };
  state.flowNodes.set(pressurizer.id, pressurizer);

  // =========================================================================
  // SECONDARY SIDE FLOW NODES
  // =========================================================================
  // Steam generator secondary side (boiling at ~55 bar)
  // This is where steam is generated for the turbine
  const P_sg_sec = 5.5e6; // Pa - 55 bar
  const T_sg_sec = saturationTemperature(P_sg_sec);
  const sgSecVolume = 50; // m³
  const sgSecondary: FlowNode = {
    id: 'sg-secondary',
    label: 'SG Secondary Side',
    fluid: createFluidState(T_sg_sec, P_sg_sec, 'two-phase', 0.03, sgSecVolume),
    volume: sgSecVolume,
    hydraulicDiameter: 0.1, // m
    flowArea: 5, // m²
    elevation: 5, // m
  };
  state.flowNodes.set(sgSecondary.id, sgSecondary);

  // Turbine inlet - superheated/saturated steam from SG
  // Steam leaves SG at ~55 bar, enters turbine (use same T as SG secondary)
  const turbineInletVolume = 10; // m³
  const turbineInlet: FlowNode = {
    id: 'turbine-inlet',
    label: 'Turbine Inlet',
    fluid: createFluidState(T_sg_sec, P_sg_sec, 'vapor', 0, turbineInletVolume),
    volume: turbineInletVolume,
    hydraulicDiameter: 0.5, // m - large steam pipe
    flowArea: 0.2, // m²
    elevation: 5, // m - same level as SG top
  };
  state.flowNodes.set(turbineInlet.id, turbineInlet);

  // Turbine outlet - wet steam exhausting to condenser
  // At lower pressure after expansion (~1 bar for now, not full vacuum)
  const P_condenser = 1e5; // Pa - 1 bar
  const T_condenser = saturationTemperature(P_condenser);
  const turbineOutletVolume = 50; // m³ - large due to low density
  const turbineOutlet: FlowNode = {
    id: 'turbine-outlet',
    label: 'Turbine Outlet',
    fluid: createFluidState(T_condenser, P_condenser, 'two-phase', 0.9, turbineOutletVolume),
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
    // Low pressure two-phase, mostly liquid (use same T/P as turbine outlet)
    fluid: createFluidState(T_condenser, P_condenser, 'two-phase', 0.1, condenserVolume),
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

  // Initialize with zero flow - pump will ramp up over first 5 seconds
  // This allows initial conditions to stabilize before flow starts

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
    massFlowRate: 0, // Start at zero, pump ramps up
    inertance: 2 / 0.4, // length / flowArea = 5 m⁻¹
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
    massFlowRate: 0, // Start at zero, pump ramps up
    inertance: 5 / 0.4, // length / flowArea = 12.5 m⁻¹
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
    massFlowRate: 0, // Start at zero, pump ramps up
    inertance: 5 / 0.4, // length / flowArea = 12.5 m⁻¹
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
    massFlowRate: 0, // Start at zero, pump ramps up
    inertance: 3 / 0.4, // length / flowArea = 7.5 m⁻¹
  });

  // Pressurizer surge line (small connection to hot leg)
  // Connected at top of hot leg to draw vapor during insurge
  // and bottom of pressurizer to draw liquid during outsurge
  state.flowConnections.push({
    id: 'flow-przr-surge',
    fromNodeId: 'hot-leg',
    toNodeId: 'pressurizer',
    flowArea: 0.05,
    hydraulicDiameter: 0.25,
    length: 8,
    elevation: -8, // Negative = going UP = gravity opposes flow
    fromElevation: 0.7, // Near top of hot leg (assumes ~0.8m diameter)
    toElevation: 0.1,   // Near bottom of pressurizer
    resistanceCoeff: 10,
    massFlowRate: 0, // Normally no flow
    inertance: 8 / 0.05, // length / flowArea = 160 m⁻¹ (high inertance, small pipe)
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
    inertance: 10 / 0.2, // length / flowArea = 50 m⁻¹
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
    inertance: 5 / 0.2, // length / flowArea = 25 m⁻¹
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
    inertance: 5 / 0.5, // length / flowArea = 10 m⁻¹
  });

  // Condenser to feedwater (condensate extraction)
  // Condensate pump takes liquid from condenser hotwell (bottom)
  state.flowConnections.push({
    id: 'flow-condenser-feedwater',
    fromNodeId: 'condenser',
    toNodeId: 'feedwater',
    flowArea: 0.07,
    hydraulicDiameter: 0.3,
    length: 20,
    elevation: -2, // Going up from basement
    fromElevation: 0.1, // Draw from hotwell at bottom of condenser
    toElevation: 0.5,   // Discharge to middle of feedwater tank
    resistanceCoeff: 10,
    massFlowRate: secondaryFlow,
    inertance: 20 / 0.07, // length / flowArea = 286 m⁻¹
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
    inertance: 30 / 0.07, // length / flowArea = 429 m⁻¹
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
    effectiveSpeed: 0, // Starts at 0, ramps up over rampUpTime
    ratedHead: 150, // m - sized to overcome loop resistance at design flow
    ratedFlow: 5000, // kg/s
    efficiency: 0.85, // Typical large centrifugal pump efficiency
    connectedFlowPath: 'flow-coldleg-core',
    rampUpTime: 5.0, // seconds
    coastDownTime: 30.0, // seconds - large pump has significant inertia
  });

  // Main isolation valve (normally open)
  state.components.valves.set('msiv', {
    id: 'msiv',
    position: 1.0,
    failPosition: 0, // Closes on failure
    connectedFlowPath: 'flow-hotleg-sg',
  });

  // Condensate pump - lifts water from condenser hotwell to feedwater system
  // Head needed: overcome 2m elevation + friction + raise pressure slightly
  // Condenser at ~1 bar, feedwater system inlet at maybe 5-10 bar
  // H = dP / (rho * g) = 1e6 / (1000 * 9.81) = ~100 m for 10 bar rise
  // Plus 2m elevation = ~100m total
  state.components.pumps.set('condensate-pump', {
    id: 'condensate-pump',
    running: true,
    speed: 1.0,
    effectiveSpeed: 0, // Starts at 0, ramps up over rampUpTime
    ratedHead: 100, // m - sized to lift condensate from hotwell
    ratedFlow: 500, // kg/s
    efficiency: 0.85, // Typical condensate pump efficiency
    connectedFlowPath: 'flow-condenser-feedwater',
    rampUpTime: 5.0, // seconds
    coastDownTime: 15.0, // seconds
  });

  // Check valve on condensate line - prevents backflow from feedwater to condenser
  state.components.checkValves.set('condensate-check', {
    id: 'condensate-check',
    connectedFlowPath: 'flow-condenser-feedwater',
    crackingPressure: 10000, // 0.1 bar - typical check valve cracking pressure
  });

  // Feedwater pump - pressurizes condensate from condenser pressure to SG pressure
  // Head: ~55 bar - 1 bar = 54 bar = 5.4 MPa
  // For water at ~400K: rho ~940 kg/m³
  // H = dP / (rho * g) = 5.4e6 / (940 * 9.81) = 585 m
  state.components.pumps.set('fw-pump', {
    id: 'fw-pump',
    running: true,
    speed: 1.0,
    effectiveSpeed: 0, // Starts at 0, ramps up over rampUpTime
    ratedHead: 600, // m - sized for ~55 bar rise
    ratedFlow: 500, // kg/s
    efficiency: 0.85, // Typical feedwater pump efficiency
    connectedFlowPath: 'flow-feedwater-sg',
    rampUpTime: 5.0, // seconds
    coastDownTime: 20.0, // seconds
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

/**
 * Create a simulation state from a user-constructed plant
 * Converts visual plant components to simulation nodes and connections
 */
export function createSimulationFromPlant(plantState: PlantState): SimulationState {
  const state = createSimulationState();

  // Track which components have been processed
  const processedComponents = new Set<string>();

  // First pass: Create flow nodes for each volume-containing component
  for (const [id, component] of plantState.components) {
    const flowNode = createFlowNodeFromComponent(component);
    if (flowNode) {
      state.flowNodes.set(flowNode.id, flowNode);
      processedComponents.add(id);
    }

    // Create pump state if this is a pump
    if (component.type === 'pump') {
      const pumpState = createPumpStateFromComponent(component);
      if (pumpState) {
        state.components.pumps.set(pumpState.id, pumpState);
      }
    }

    // Create valve state if this is a valve
    if (component.type === 'valve') {
      const valveState = createValveStateFromComponent(component);
      if (valveState) {
        state.components.valves.set(valveState.id, valveState);
      }
    }

    // Create thermal nodes for heat-generating components (vessels with fuel)
    if (component.type === 'vessel' && (component as any).fuelRodCount > 0) {
      const thermalNodes = createThermalNodesFromCore(component);
      for (const node of thermalNodes) {
        state.thermalNodes.set(node.id, node);
      }

      // Set up neutronics
      state.neutronics = createNeutronicsFromCore(component);

      // Create convection connection from fuel to coolant
      state.convectionConnections.push({
        id: `convection-${id}`,
        thermalNodeId: `${id}-fuel`,
        flowNodeId: id,
        surfaceArea: 5000, // Approximate fuel surface area
      });
    }

    // Create thermal nodes and secondary flow node for heat exchangers
    if (component.type === 'heatExchanger') {
      const hxThermalNode = createHeatExchangerThermalNode(component);
      state.thermalNodes.set(hxThermalNode.id, hxThermalNode);

      // Create secondary flow node for heat exchanger
      const secondaryNode = createHeatExchangerSecondaryNode(component);
      state.flowNodes.set(secondaryNode.id, secondaryNode);

      // Create convection connections for primary and secondary sides
      // The HX creates two flow nodes: id-primary and id-secondary
      state.convectionConnections.push({
        id: `convection-${id}-primary`,
        thermalNodeId: `${id}-tubes`,
        flowNodeId: `${id}-primary`,
        surfaceArea: (component as any).tubeCount * 0.5, // Approximate
      });
      state.convectionConnections.push({
        id: `convection-${id}-secondary`,
        thermalNodeId: `${id}-tubes`,
        flowNodeId: `${id}-secondary`,
        surfaceArea: (component as any).tubeCount * 0.6, // Outer surface slightly larger
      });
    }
  }

  // Second pass: Create flow connections from plant connections
  for (const connection of plantState.connections) {
    const flowConnection = createFlowConnectionFromPlantConnection(connection, plantState);
    if (flowConnection) {
      state.flowConnections.push(flowConnection);

      // Link pump to its flow connection if the pump is on this path
      const fromComponent = plantState.components.get(connection.fromComponentId);
      const toComponent = plantState.components.get(connection.toComponentId);

      if (fromComponent?.type === 'pump') {
        const pumpState = state.components.pumps.get(fromComponent.id);
        if (pumpState) {
          pumpState.connectedFlowPath = flowConnection.id;
        }
      }
      if (toComponent?.type === 'pump') {
        const pumpState = state.components.pumps.get(toComponent.id);
        if (pumpState) {
          pumpState.connectedFlowPath = flowConnection.id;
        }
      }

      // Link valve to its flow connection
      if (fromComponent?.type === 'valve') {
        const valveState = state.components.valves.get(fromComponent.id);
        if (valveState) {
          valveState.connectedFlowPath = flowConnection.id;
        }
      }
      if (toComponent?.type === 'valve') {
        const valveState = state.components.valves.get(toComponent.id);
        if (valveState) {
          valveState.connectedFlowPath = flowConnection.id;
        }
      }
    }
  }

  console.log(`[Simulation] Created simulation with ${state.flowNodes.size} flow nodes, ${state.flowConnections.length} connections, ${state.thermalNodes.size} thermal nodes`);

  return state;
}

/**
 * Create a flow node from a plant component
 */
function createFlowNodeFromComponent(component: PlantComponent): FlowNode | null {
  const elevation = (component as any).elevation || 0;

  switch (component.type) {
    case 'tank': {
      const tank = component as any;
      const volume = tank.width * tank.height * (tank.width || 1); // Approximate volume
      const temp = tank.fluid?.temperature || 350; // Default 350K

      // Use fillLevel to determine the liquid/vapor split
      // fillLevel is 0-1, default to 1.0 (full) if not specified
      const fillLevel = tank.fillLevel !== undefined ? tank.fillLevel : 1.0;

      let fluid: FluidState;

      if (fillLevel >= 0.999) {
        // Fully liquid - use specified pressure
        const pressure = tank.fluid?.pressure || 1e6;
        fluid = createFluidState(temp, pressure, 'liquid', 0, volume);
      } else if (fillLevel <= 0.001) {
        // Fully vapor - can use specified pressure (no liquid to constrain it)
        const pressure = tank.fluid?.pressure || Water.saturationPressure(temp);
        fluid = createFluidState(temp, pressure, 'vapor', 1, volume);
      } else {
        // Partially filled - two-phase mixture
        // Pressure is saturation pressure (ignoring user-specified pressure)
        const pressure = Water.saturationPressure(temp);

        // Calculate quality from fill level (volume fraction to mass fraction)
        // V_liquid = fillLevel * V, V_vapor = (1 - fillLevel) * V
        // m_liquid = rho_f * V_liquid, m_vapor = rho_g * V_vapor
        // quality = m_vapor / (m_liquid + m_vapor)
        const rho_f = Water.saturatedLiquidDensity(temp);
        const rho_g = Water.saturatedVaporDensity(temp);
        const m_liquid = rho_f * fillLevel * volume;
        const m_vapor = rho_g * (1 - fillLevel) * volume;
        const totalMass = m_liquid + m_vapor;
        const quality = m_vapor / totalMass;

        // Create fluid state with calculated quality
        fluid = createFluidState(temp, pressure, 'two-phase', quality, volume);
      }

      return {
        id: component.id,
        label: component.label || 'Tank',
        fluid,
        volume,
        hydraulicDiameter: Math.min(tank.width, tank.height),
        flowArea: tank.width * (tank.width || 1),
        elevation,
      };
    }

    case 'pipe': {
      const pipe = component as any;
      const radius = pipe.diameter / 2;
      const volume = Math.PI * radius * radius * pipe.length;
      const temp = pipe.fluid?.temperature || 350;
      const pressure = pipe.fluid?.pressure || 1e6;

      return {
        id: component.id,
        label: component.label || 'Pipe',
        fluid: createFluidState(temp, pressure, 'liquid', 0, volume),
        volume,
        hydraulicDiameter: pipe.diameter,
        flowArea: Math.PI * radius * radius,
        elevation,
      };
    }

    case 'pump': {
      const pump = component as any;
      const volume = 0.1; // Small volume for pump
      const temp = pump.fluid?.temperature || 350;
      const pressure = pump.fluid?.pressure || 1e6;

      return {
        id: component.id,
        label: component.label || 'Pump',
        fluid: createFluidState(temp, pressure, 'liquid', 0, volume),
        volume,
        hydraulicDiameter: pump.diameter || 0.3,
        flowArea: Math.PI * Math.pow((pump.diameter || 0.3) / 2, 2),
        elevation,
      };
    }

    case 'valve': {
      const valve = component as any;
      const volume = 0.05; // Small volume for valve
      const temp = valve.fluid?.temperature || 350;
      const pressure = valve.fluid?.pressure || 1e6;

      return {
        id: component.id,
        label: component.label || 'Valve',
        fluid: createFluidState(temp, pressure, 'liquid', 0, volume),
        volume,
        hydraulicDiameter: valve.diameter || 0.2,
        flowArea: Math.PI * Math.pow((valve.diameter || 0.2) / 2, 2),
        elevation,
      };
    }

    case 'vessel': {
      const vessel = component as any;
      const radius = vessel.innerDiameter / 2;
      const volume = Math.PI * radius * radius * vessel.height;
      const temp = vessel.fluid?.temperature || 580; // Higher default for reactor vessel
      const pressure = vessel.fluid?.pressure || 15e6; // 150 bar typical PWR

      return {
        id: component.id,
        label: component.label || 'Vessel',
        fluid: createFluidState(temp, pressure, 'liquid', 0, volume),
        volume,
        hydraulicDiameter: 0.012, // Typical fuel channel
        flowArea: Math.PI * radius * radius * 0.5, // Account for internals
        elevation,
      };
    }

    case 'heatExchanger': {
      const hx = component as any;
      // Heat exchangers create TWO flow nodes - primary and secondary sides
      const primaryVolume = 10; // Approximate
      const secondaryVolume = 30;
      const primaryTemp = hx.primaryFluid?.temperature || 570;
      const primaryPressure = hx.primaryFluid?.pressure || 15e6;
      const secondaryTemp = hx.secondaryFluid?.temperature || saturationTemperature(5.5e6);
      const secondaryPressure = hx.secondaryFluid?.pressure || 5.5e6;

      // Return primary node, secondary is created separately
      return {
        id: `${component.id}-primary`,
        label: `${component.label || 'HX'} Primary`,
        fluid: createFluidState(primaryTemp, primaryPressure, 'liquid', 0, primaryVolume),
        volume: primaryVolume,
        hydraulicDiameter: 0.02,
        flowArea: 2,
        elevation,
      };
    }

    case 'turbine': {
      const turbine = component as any;
      const volume = 10;
      const temp = turbine.inletFluid?.temperature || saturationTemperature(5.5e6);
      const pressure = turbine.inletFluid?.pressure || 5.5e6;

      return {
        id: component.id,
        label: component.label || 'Turbine',
        fluid: createFluidState(temp, pressure, 'vapor', 0, volume),
        volume,
        hydraulicDiameter: 0.5,
        flowArea: 0.2,
        elevation,
      };
    }

    case 'condenser': {
      const condenser = component as any;
      const volume = 50;
      const pressure = condenser.fluid?.pressure || 1e5; // 1 bar
      const temp = saturationTemperature(pressure);

      return {
        id: component.id,
        label: component.label || 'Condenser',
        fluid: createFluidState(temp, pressure, 'two-phase', 0.1, volume),
        volume,
        hydraulicDiameter: 0.02,
        flowArea: 2,
        elevation,
      };
    }

    default:
      console.warn(`[Simulation] Unknown component type: ${(component as any).type}`);
      return null;
  }
}

/**
 * Create pump state from a pump component
 */
function createPumpStateFromComponent(component: PlantComponent): PumpState | null {
  const pump = component as any;

  return {
    id: component.id,
    running: pump.running ?? true,
    speed: pump.running ? 1.0 : 0,
    effectiveSpeed: 0, // Start at 0, ramp up
    ratedHead: pump.ratedHead || 150,
    ratedFlow: pump.ratedFlow || 1000,
    efficiency: 0.85,
    connectedFlowPath: '', // Set later when connections are processed
    rampUpTime: 5.0,
    coastDownTime: 30.0,
  };
}

/**
 * Create valve state from a valve component
 */
function createValveStateFromComponent(component: PlantComponent): ValveState | null {
  const valve = component as any;

  return {
    id: component.id,
    position: valve.opening ?? 1.0,
    failPosition: 0,
    connectedFlowPath: '', // Set later when connections are processed
  };
}

/**
 * Create thermal nodes for a reactor core
 */
function createThermalNodesFromCore(component: PlantComponent): ThermalNode[] {
  const vessel = component as any;
  const nodes: ThermalNode[] = [];

  // Fuel node
  nodes.push({
    id: `${component.id}-fuel`,
    label: `${component.label || 'Core'} Fuel`,
    temperature: vessel.fuelTemperature || 900,
    mass: 80000,
    specificHeat: 300,
    thermalConductivity: 3,
    characteristicLength: 0.005,
    surfaceArea: 5000,
    heatGeneration: 0, // Set by neutronics
    maxTemperature: vessel.fuelMeltingPoint || 2800,
  });

  // Cladding node
  nodes.push({
    id: `${component.id}-clad`,
    label: `${component.label || 'Core'} Cladding`,
    temperature: 620,
    mass: 25000,
    specificHeat: 330,
    thermalConductivity: 16,
    characteristicLength: 0.0006,
    surfaceArea: 5000,
    heatGeneration: 0,
    maxTemperature: 1500,
  });

  return nodes;
}

/**
 * Create neutronics state from a core component
 */
function createNeutronicsFromCore(component: PlantComponent): NeutronicsState {
  const vessel = component as any;
  const rodPosition = vessel.controlRodPosition ?? 0.8;

  return {
    power: 1000e6, // Start at full power
    nominalPower: 1000e6,
    reactivity: 0,
    promptNeutronLifetime: 1e-4,
    delayedNeutronFraction: 0.0065,
    precursorConcentration: 800.0,
    precursorDecayConstant: 0.08,
    fuelTempCoeff: -2.5e-5,
    coolantTempCoeff: -1e-5,
    coolantDensityCoeff: 0.001,
    refFuelTemp: 887,
    refCoolantTemp: 520,
    refCoolantDensity: 750,
    controlRodPosition: rodPosition,
    controlRodWorth: 0.05,
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
 * Create thermal node for heat exchanger tubes
 */
function createHeatExchangerThermalNode(component: PlantComponent): ThermalNode {
  const hx = component as any;

  return {
    id: `${component.id}-tubes`,
    label: `${component.label || 'HX'} Tubes`,
    temperature: 570,
    mass: 50000,
    specificHeat: 500,
    thermalConductivity: 20,
    characteristicLength: 0.001,
    surfaceArea: (hx.tubeCount || 1000) * 0.5,
    heatGeneration: 0,
    maxTemperature: 900,
  };
}

/**
 * Create secondary flow node for heat exchanger
 */
function createHeatExchangerSecondaryNode(component: PlantComponent): FlowNode {
  const hx = component as any;
  const elevation = hx.elevation || 0;
  const secondaryVolume = 30;
  const secondaryTemp = hx.secondaryFluid?.temperature || saturationTemperature(5.5e6);
  const secondaryPressure = hx.secondaryFluid?.pressure || 5.5e6;
  const phase = hx.secondaryFluid?.phase || 'two-phase';
  const quality = hx.secondaryFluid?.quality || 0.5;

  return {
    id: `${component.id}-secondary`,
    label: `${component.label || 'HX'} Secondary`,
    fluid: createFluidState(secondaryTemp, secondaryPressure, phase, quality, secondaryVolume),
    volume: secondaryVolume,
    hydraulicDiameter: 0.1,
    flowArea: 5,
    elevation,
  };
}

/**
 * Create a flow connection from a plant connection
 */
function createFlowConnectionFromPlantConnection(
  connection: Connection,
  plantState: PlantState
): FlowConnection | null {
  const fromComponent = plantState.components.get(connection.fromComponentId);
  const toComponent = plantState.components.get(connection.toComponentId);

  if (!fromComponent || !toComponent) {
    console.warn(`[Simulation] Connection references missing component`);
    return null;
  }

  // Determine flow node IDs (heat exchangers have -primary/-secondary suffixes)
  let fromNodeId = connection.fromComponentId;
  let toNodeId = connection.toComponentId;

  // Handle heat exchanger port mappings
  if (fromComponent.type === 'heatExchanger') {
    if (connection.fromPortId.includes('primary')) {
      fromNodeId = `${connection.fromComponentId}-primary`;
    } else if (connection.fromPortId.includes('secondary')) {
      fromNodeId = `${connection.fromComponentId}-secondary`;
    }
  }
  if (toComponent.type === 'heatExchanger') {
    if (connection.toPortId.includes('primary')) {
      toNodeId = `${connection.toComponentId}-primary`;
    } else if (connection.toPortId.includes('secondary')) {
      toNodeId = `${connection.toComponentId}-secondary`;
    }
  }

  // Get port positions for elevation calculation
  const fromPort = fromComponent.ports?.find(p => p.id === connection.fromPortId);
  const toPort = toComponent.ports?.find(p => p.id === connection.toPortId);

  const fromElevation = (fromComponent as any).elevation || 0;
  const toElevation = (toComponent as any).elevation || 0;
  const elevationChange = toElevation - fromElevation;

  // Estimate flow area from component diameters
  let flowArea = 0.1; // Default
  let hydraulicDiameter = 0.3;
  let length = 1;

  // Use pipe dimensions if connecting through pipes
  if (fromComponent.type === 'pipe') {
    const pipe = fromComponent as any;
    flowArea = Math.PI * Math.pow(pipe.diameter / 2, 2);
    hydraulicDiameter = pipe.diameter;
    length = pipe.length;
  } else if (toComponent.type === 'pipe') {
    const pipe = toComponent as any;
    flowArea = Math.PI * Math.pow(pipe.diameter / 2, 2);
    hydraulicDiameter = pipe.diameter;
    length = pipe.length;
  }

  return {
    id: `flow-${connection.fromComponentId}-${connection.toComponentId}`,
    fromNodeId,
    toNodeId,
    flowArea,
    hydraulicDiameter,
    length,
    elevation: elevationChange,
    resistanceCoeff: 5, // Default resistance
    massFlowRate: 0, // Start at zero
    inertance: length / flowArea,
  };
}
