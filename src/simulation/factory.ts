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
  BurstState,
  DEFAULT_BURST_CONFIG,
} from './types';
import { createFluidState, NcgPartialPressures } from './operators';
import { saturationTemperature, saturationPressure } from './water-properties';
import * as Water from './water-properties';
import { PlantState, PlantComponent, Connection, ReactorVesselComponent, CoreBarrelComponent } from '../types';

// Minimum steam pressure to keep water above freezing (at 1°C = 274.15 K)
const MIN_STEAM_PRESSURE_PA = saturationPressure(274.15); // ~657 Pa

/**
 * Simple seeded pseudo-random number generator (mulberry32).
 * Returns a function that generates deterministic random numbers in [0, 1).
 */
function createSeededRandom(seed: number): () => number {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Global random function - can be seeded for deterministic mode
let simulationRandom: () => number = Math.random;

/**
 * Set deterministic mode for simulation creation.
 * When seed is provided, all random values will be deterministic.
 * When seed is undefined, uses Math.random (non-deterministic).
 */
export function setSimulationRandomSeed(seed?: number): void {
  if (seed !== undefined) {
    simulationRandom = createSeededRandom(seed);
  } else {
    simulationRandom = Math.random;
  }
}

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
      controllers: new Map(),
    },
  };
}

/**
 * Create default neutronics state - disabled (no core)
 */
function createDefaultNeutronics(): NeutronicsState {
  return {
    // No core linked - neutronics disabled
    coreId: null,
    fuelNodeId: null,
    coolantNodeId: null,

    power: 0,
    nominalPower: 0, // No nominal power without a core

    reactivity: 0,
    promptNeutronLifetime: 1e-4, // 100 microseconds
    delayedNeutronFraction: 0.0065, // β for U-235

    precursorConcentration: 0,
    precursorDecayConstant: 0.08, // Effective λ

    // Reactivity feedback coefficients (typical LWR values)
    fuelTempCoeff: -2.5e-5,      // -2.5 pcm/K (Doppler)
    coolantTempCoeff: -1e-5,      // -1 pcm/K
    coolantDensityCoeff: 0.001,  // Void coefficient

    refFuelTemp: 600,     // K - reference temperature
    refCoolantTemp: 520,  // K
    refCoolantDensity: 750, // kg/m³

    controlRodPosition: 0, // Fully inserted (safe default)
    controlRodWorth: 0.05,   // 5000 pcm total worth

    decayHeatFraction: 0,
    scrammed: false,
    scramTime: -1,
    scramReason: '',
    reactivityBreakdown: {
      controlRods: 0,
      doppler: 0,
      coolantTemp: 0,
      coolantDensity: 0,
    },
    diagnostics: {
      fuelTemp: 600,
      coolantTemp: 520,
      coolantDensity: 750,
    },
  };
}

/**
 * OBSOLETE: Demo reactor with hardcoded node IDs.
 * Use createSimulationFromPlant() with user-constructed plants instead.
 */
export function createDemoReactor(): SimulationState {
  throw new Error('createDemoReactor is OBSOLETE. Use createSimulationFromPlant() instead.');
  /* Unreachable code - preserved for reference
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
  const coreHeight = 4; // m - active fuel height
  const P_core = P_base_at(elevations['core-coolant']);
  const coreCoolant: FlowNode = {
    id: 'core-coolant',
    label: 'Core Coolant Channel',
    fluid: createFluidState(590, P_core, 'liquid', 0, coreVolume),
    volume: coreVolume,
    hydraulicDiameter: 0.012, // m
    flowArea: 4, // m²
    elevation: elevations['core-coolant'],
    height: coreHeight, // m - vertical extent for liquid level calculation
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
  const sgSecondaryHeight = 10; // m - vertical height of SG secondary side
  const sgSecondary: FlowNode = {
    id: 'sg-secondary',
    label: 'SG Secondary Side',
    fluid: createFluidState(T_sg_sec, P_sg_sec, 'two-phase', 0.03, sgSecVolume),
    volume: sgSecVolume,
    hydraulicDiameter: 0.1, // m
    flowArea: 5, // m²
    elevation: 5, // m
    height: sgSecondaryHeight, // m - vertical extent for liquid level calculation
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
  // Fuel rods span the full core height
  state.convectionConnections.push({
    id: 'clad-coolant',
    thermalNodeId: 'clad',
    flowNodeId: 'core-coolant',
    surfaceArea: 5000, // m²
    tubeBottomElevation: 0, // m - rods start at bottom of coolant channel
    tubeHeight: coreHeight, // m - rods span full active height
  });

  // SG tubes to primary coolant
  state.convectionConnections.push({
    id: 'sg-tube-primary',
    thermalNodeId: 'sg-tubes',
    flowNodeId: 'sg-primary',
    surfaceArea: 5000, // m² (tube inner surface)
  });

  // SG tubes to secondary (boiling) side
  // Tubes extend through most of the SG height, starting just above the bottom
  state.convectionConnections.push({
    id: 'sg-tube-secondary',
    thermalNodeId: 'sg-tubes',
    flowNodeId: 'sg-secondary',
    surfaceArea: 5500, // m² (tube outer surface)
    tubeBottomElevation: 0.5, // m - tubes start slightly above bottom
    tubeHeight: sgSecondaryHeight - 1.5, // m - tubes extend to near top (leaving steam space)
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
    fromPhaseTolerance: 0, // Always draw liquid from bottom of hotwell
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
    // Link to the demo reactor's core nodes
    coreId: 'core',
    fuelNodeId: 'fuel',
    coolantNodeId: 'core-coolant',
    power: 1000e6, // Start at full power
    nominalPower: 1000e6,
    precursorConcentration: 800.0,
    decayHeatFraction: 0.07, // Steady-state decay heat
    controlRodPosition: 0.97, // Partially withdrawn for criticality
  };

  // Set fuel heat generation to match power
  const fuelNode = state.thermalNodes.get('fuel');
  if (fuelNode) {
    fuelNode.heatGeneration = state.neutronics.power;
  }

  return state;
  */
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

      // Set simNodeId on the plant component so arrow rendering can find it
      (component as any).simNodeId = flowNode.id;
    }

    // Create pump state if this is a pump
    if (component.type === 'pump') {
      const pumpState = createPumpStateFromComponent(component);
      if (pumpState) {
        state.components.pumps.set(pumpState.id, pumpState);
        // Link plant component to pump state for debug panel
        (component as any).simPumpId = pumpState.id;
      }
    }

    // Create valve state if this is a valve
    if (component.type === 'valve') {
      const valve = component as any;
      if (valve.valveType === 'check') {
        // Check valves go in the checkValves map
        state.components.checkValves.set(component.id, {
          id: component.id,
          connectedFlowPath: '', // Set later when connections are processed
          crackingPressure: valve.crackingPressure || 10000, // Default 0.1 bar
        });
        // Link plant component to check valve state for debug panel
        (component as any).simValveId = component.id;
      } else if (valve.valveType === 'relief' || valve.valveType === 'porv') {
        // Relief valves and PORVs - for now, treat as regular valves
        // TODO: Add proper relief valve logic with setpoint
        const valveState = createValveStateFromComponent(component);
        if (valveState) {
          state.components.valves.set(valveState.id, valveState);
          (component as any).simValveId = valveState.id;
        }
      } else {
        // Standard valves (gate, globe, ball, butterfly)
        const valveState = createValveStateFromComponent(component);
        if (valveState) {
          state.components.valves.set(valveState.id, valveState);
          (component as any).simValveId = valveState.id;
        }
      }
    }

    // Create thermal nodes for heat-generating components (vessels/core barrels with fuel)
    const hasFuel = (component as any).fuelRodCount > 0;
    const isReactorVessel = component.type === 'reactorVessel';
    const isCoreBarrel = component.type === 'coreBarrel';
    const isVesselWithFuel = component.type === 'vessel' && hasFuel;

    // New architecture: fuel is on core barrel, not reactor vessel
    // Legacy: fuel is on reactor vessel with insideBarrelId/outsideBarrelId
    if (isVesselWithFuel || (isReactorVessel && hasFuel) || (isCoreBarrel && hasFuel)) {
      const thermalNodes = createThermalNodesFromCore(component);
      for (const node of thermalNodes) {
        state.thermalNodes.set(node.id, node);
      }

      // Set up neutronics (thermal + flow nodes for this core exist by now)
      state.neutronics = createNeutronicsFromCore(component, state);

      // Create convection connection from fuel to coolant
      // For core barrels, the coolant is the core barrel's own flow node
      // For reactor vessels (legacy), the coolant is in the inside barrel
      let coolantFlowNodeId: string;
      if (isCoreBarrel) {
        // New architecture: core barrel IS the core region flow node
        coolantFlowNodeId = id;
      } else if (isReactorVessel) {
        const rv = component as ReactorVesselComponent;
        // Legacy architecture: insideBarrelId is the core coolant
        coolantFlowNodeId = (rv as any).insideBarrelId || id;
      } else {
        coolantFlowNodeId = id;
      }

      // Get fuel geometry for liquid-level-dependent heat transfer
      const coreComp = component as any;
      const activeFuelHeight = coreComp.activeFuelHeight ?? coreComp.height ?? 4; // Default 4m
      const coreBottomElevation = coreComp.coreBottomElevation ?? 0.5; // Default 0.5m above barrel bottom

      state.convectionConnections.push({
        id: `convection-${id}`,
        thermalNodeId: `${id}-fuel`,
        flowNodeId: coolantFlowNodeId,
        surfaceArea: 5000, // Approximate fuel surface area
        tubeBottomElevation: coreBottomElevation,
        tubeHeight: activeFuelHeight,
      });
    }

    // Create thermal nodes and shell-side flow node for heat exchangers
    if (component.type === 'heatExchanger') {
      const hxThermalNode = createHeatExchangerThermalNode(component);
      state.thermalNodes.set(hxThermalNode.id, hxThermalNode);

      // Create shell-side flow node for heat exchanger
      const shellNode = createHeatExchangerShellNode(component);
      state.flowNodes.set(shellNode.id, shellNode);

      // Create convection connections for tube and shell sides
      // The HX creates two flow nodes: id-tube and id-shell
      const hxComp = component as any;
      const hxHeight = hxComp.height || 5; // m - default HX height
      state.convectionConnections.push({
        id: `convection-${id}-tube`,
        thermalNodeId: `${id}-tubes`,
        flowNodeId: `${id}-tube`,
        surfaceArea: hxComp.tubeCount * 0.5, // Tube inner surface
        // Tube side is typically forced convection, geometry not critical
      });
      state.convectionConnections.push({
        id: `convection-${id}-shell`,
        thermalNodeId: `${id}-tubes`,
        flowNodeId: `${id}-shell`,
        surfaceArea: hxComp.tubeCount * 0.6, // Tube outer surface slightly larger
        tubeBottomElevation: 0.3, // m - tubes start slightly above shell bottom
        tubeHeight: hxHeight - 0.6, // m - tubes extend through most of shell height
      });
    }

    // Create thermal node, annulus flow node, and convection connections for cross-vessels
    // Like HX: inner pipe and annulus are separate flow nodes with thermal coupling
    if (component.type === 'crossVessel') {
      const cv = component as any;
      // Create annulus flow node (like HX shell)
      const annulusNode = createCrossVesselAnnulusNode(component);
      state.flowNodes.set(annulusNode.id, annulusNode);

      // Create thermal node for the inner pipe wall
      const innerRadius = cv.innerDiameter / 2;
      const outerRadius = innerRadius + cv.innerWallThickness;
      const innerSurfaceArea = 2 * Math.PI * innerRadius * cv.length;  // Inner surface
      const outerSurfaceArea = 2 * Math.PI * outerRadius * cv.length;  // Outer surface

      // Pipe wall thermal properties (steel)
      const steelDensity = 7800;  // kg/m³
      const steelCp = 500;  // J/kg-K
      const wallVolume = Math.PI * (outerRadius * outerRadius - innerRadius * innerRadius) * cv.length;
      const wallMass = wallVolume * steelDensity;

      // Initial wall temperature - average of hot and cold side
      const hotTemp = cv.fluid?.temperature || 593;  // Hot leg temp
      const coldTemp = cv.annulusFluid?.temperature || 565;  // Cold leg/annulus temp
      const wallTemp = (hotTemp + coldTemp) / 2;

      const cvThermalNode: ThermalNode = {
        id: `${id}-wall`,
        label: `${component.label || 'Cross-Vessel'} Wall`,
        temperature: wallTemp,
        mass: wallMass,
        specificHeat: steelCp,
        thermalConductivity: 50,  // W/m-K for steel
        characteristicLength: cv.innerWallThickness,
        surfaceArea: innerSurfaceArea + outerSurfaceArea,
        heatGeneration: 0,
        maxTemperature: 900,  // K - typical steel limit
      };
      state.thermalNodes.set(cvThermalNode.id, cvThermalNode);

      // Convection from inner hot flow to wall
      state.convectionConnections.push({
        id: `convection-${id}-inner`,
        thermalNodeId: `${id}-wall`,
        flowNodeId: `${id}-inner`,  // Inner pipe flow node
        surfaceArea: innerSurfaceArea,
      });

      // Convection from wall to annulus
      state.convectionConnections.push({
        id: `convection-${id}-annulus`,
        thermalNodeId: `${id}-wall`,
        flowNodeId: `${id}-annulus`,  // Annulus flow node
        surfaceArea: outerSurfaceArea,
      });

      console.log(`[Factory] CrossVessel ${id}: created inner pipe and annulus flow nodes with thermal coupling`);
    }

    // Create extraction flow nodes for turbine-generators with extraction ports
    if (component.type === 'turbine-generator') {
      const extractionNodes = createTurbineExtractionNodes(component);
      for (const extNode of extractionNodes) {
        state.flowNodes.set(extNode.id, extNode);
      }
      if (extractionNodes.length > 0) {
        console.log(`[Factory] Turbine ${id}: created ${extractionNodes.length} extraction flow nodes`);
      }
    }
  }

  // Second pass: Create flow connections from plant connections
  for (const connection of plantState.connections) {
    const flowConnection = createFlowConnectionFromPlantConnection(connection, plantState);
    if (flowConnection) {
      state.flowConnections.push(flowConnection);

      // Link pump to its OUTLET flow connection (where pump is the FROM component)
      // Pump head is added to flow going FROM the pump TO the downstream component
      // We only set connectedFlowPath when pump is the FROM component to ensure
      // pump head is applied in the correct direction
      const fromComponent = plantState.components.get(connection.fromComponentId);
      const toComponent = plantState.components.get(connection.toComponentId);

      if (fromComponent?.type === 'pump') {
        const pumpState = state.components.pumps.get(fromComponent.id);
        if (pumpState) {
          if (!pumpState.connectedFlowPath) {
            pumpState.connectedFlowPath = flowConnection.id;
          } else {
            // A pump drives exactly ONE discharge path. Additional outlet
            // connections (e.g. a small spray/bypass tap) are passive
            // branches fed by the pump node's pressure - letting a later
            // connection steal connectedFlowPath would silently move the
            // pump head onto the branch and kill the main loop.
            console.warn(
              `[Factory] Pump ${fromComponent.id} has multiple outlet connections: head drives ` +
              `'${pumpState.connectedFlowPath}'; '${flowConnection.id}' is a passive branch`
            );
          }
        }
      }
      // NOTE: We intentionally do NOT set connectedFlowPath when pump is the TO component
      // because pump head should only be applied on the outlet side

      // Link valve to its flow connection
      if (fromComponent?.type === 'valve') {
        const fromValve = fromComponent as any;
        if (fromValve.valveType === 'check') {
          const checkValveState = state.components.checkValves.get(fromComponent.id);
          if (checkValveState) {
            checkValveState.connectedFlowPath = flowConnection.id;
          }
        } else {
          const valveState = state.components.valves.get(fromComponent.id);
          if (valveState) {
            valveState.connectedFlowPath = flowConnection.id;
          }
        }
      }
      if (toComponent?.type === 'valve') {
        const toValve = toComponent as any;
        if (toValve.valveType === 'check') {
          const checkValveState = state.components.checkValves.get(toComponent.id);
          if (checkValveState) {
            checkValveState.connectedFlowPath = flowConnection.id;
          }
        } else {
          const valveState = state.components.valves.get(toComponent.id);
          if (valveState) {
            valveState.connectedFlowPath = flowConnection.id;
          }
        }
      }
    }
  }

  // Third pass: Update pumps/valves with matchUpstream=true to use upstream fluid conditions
  for (const [id, component] of plantState.components) {
    const matchUpstream = (component as any).matchUpstream;
    if (!matchUpstream) continue;
    if (component.type !== 'pump' && component.type !== 'valve') continue;

    // Find upstream component via connections
    // Look for connections where this component is the "to" side (downstream)
    const inletConnection = plantState.connections.find(
      conn => conn.toComponentId === id
    );

    if (inletConnection) {
      const upstreamComponent = plantState.components.get(inletConnection.fromComponentId);
      if (upstreamComponent && upstreamComponent.fluid) {
        const flowNode = state.flowNodes.get(id);
        if (flowNode) {
          const upstreamFluid = upstreamComponent.fluid;
          console.log(`[Factory] ${component.type} ${id}: matching upstream conditions from ${upstreamComponent.label || inletConnection.fromComponentId} ` +
            `(${(upstreamFluid.pressure / 1e5).toFixed(1)} bar, ${(upstreamFluid.temperature - 273.15).toFixed(0)}°C)`);

          // Recreate the fluid state with upstream conditions
          flowNode.fluid = createFluidState(
            upstreamFluid.temperature,
            upstreamFluid.pressure,
            upstreamFluid.phase || 'liquid',
            upstreamFluid.quality || 0,
            flowNode.volume
          );
        }
      }
    }
  }

  // Fourth pass: translate PID controller components. Done after connection
  // processing so actuator/sensor targets (including connection ids and
  // connectedFlowPath links) exist for validation and bumpless-start init.
  for (const [id, component] of plantState.components) {
    if (component.type !== 'controller') continue;
    const ctlComp = component as any;
    if (ctlComp.controllerType !== 'pid') continue; // scram handled at game level
    const pid = ctlComp.pid;
    if (!pid || !pid.sensor || !pid.actuator || pid.setpoint === undefined) {
      throw new Error(
        `[Factory] PID controller '${id}' is missing its pid config (sensor/actuator/setpoint)`
      );
    }

    // Initialize lastOutput from the actuator's actual initial state so the
    // controller starts bumplessly instead of slewing from 0.
    let initialOutput: number;
    switch (pid.actuator.kind) {
      case 'valve-position': {
        const v = state.components.valves.get(pid.actuator.targetId);
        if (!v) throw new Error(`[Factory] PID controller '${id}': valve '${pid.actuator.targetId}' not found`);
        initialOutput = v.position;
        break;
      }
      case 'pump-speed': {
        const p = state.components.pumps.get(pid.actuator.targetId);
        if (!p) throw new Error(`[Factory] PID controller '${id}': pump '${pid.actuator.targetId}' not found`);
        initialOutput = p.speed;
        break;
      }
      case 'governor-valve': {
        const n = state.flowNodes.get(pid.actuator.targetId);
        if (!n) throw new Error(`[Factory] PID controller '${id}': flow node '${pid.actuator.targetId}' not found`);
        initialOutput = n.governorValve ?? 1;
        break;
      }
      case 'heater-power': {
        const n = state.flowNodes.get(pid.actuator.targetId);
        if (!n) throw new Error(`[Factory] PID controller '${id}': flow node '${pid.actuator.targetId}' not found`);
        initialOutput = n.heaterPower ?? 0;
        break;
      }
      case 'control-rods': {
        initialOutput = state.neutronics.controlRodPosition;
        break;
      }
      default:
        throw new Error(`[Factory] PID controller '${id}': unknown actuator kind '${pid.actuator.kind}'`);
    }

    state.components.controllers.set(id, {
      id,
      label: component.label || id,
      mode: pid.mode ?? 'auto',
      sensor: { kind: pid.sensor.kind, targetId: pid.sensor.targetId },
      setpoint: pid.setpoint,
      feedforward: pid.feedforward
        ? { kind: pid.feedforward.kind, targetId: pid.feedforward.targetId }
        : undefined,
      actuator: {
        kind: pid.actuator.kind,
        targetId: pid.actuator.targetId,
        min: pid.actuator.min ?? 0,
        max: pid.actuator.max ?? 1,
        rateLimit: pid.actuator.rateLimit ?? 0.1,
      },
      aggressiveness: pid.aggressiveness ?? 1,
      invert: pid.invert,
      gains: pid.gains ? { ...pid.gains } : undefined,
      manualOutput: pid.manualOutput,
      lastOutput: initialOutput,
      lastError: 0,
    });
    console.log(`[Factory] PID controller '${id}': ${pid.sensor.kind}(${pid.sensor.targetId}) -> ` +
      `${pid.actuator.kind}(${pid.actuator.targetId}), setpoint=${pid.setpoint}`);
  }

  // Add atmosphere node for LOCA scenarios
  state.flowNodes.set('atmosphere', createAtmosphereNode());

  // Initialize burst states for pressurized components
  initializeBurstStates(plantState, state);

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
      // Use stored volume if available (e.g., for reactor vessel regions),
      // otherwise calculate from dimensions (cylindrical approximation)
      const volume = tank.volume !== undefined
        ? tank.volume
        : Math.PI * Math.pow(tank.width / 2, 2) * tank.height;

      // Use fillLevel to determine the liquid/vapor split
      // fillLevel is 0-1, default to 1.0 (full) if not specified
      const fillLevel = tank.fillLevel !== undefined ? tank.fillLevel : 1.0;

      // Get NCG initial conditions if specified (partial pressures in bar)
      const ncg: NcgPartialPressures | undefined = tank.initialNcg;

      let fluid: FluidState;

      if (fillLevel >= 0.999) {
        // Fully liquid - use specified pressure and temperature
        // Use ?? to allow 0 pressure (clamped to minimum), || would treat 0 as falsy
        const pressure = Math.max(tank.fluid?.pressure ?? 1e6, MIN_STEAM_PRESSURE_PA);
        const temp = tank.fluid?.temperature || 350;
        console.log(`[Factory] Tank ${component.id}: creating LIQUID state at ${pressure/1e5} bar, ${temp}K`);
        fluid = createFluidState(temp, pressure, 'liquid', 0, volume, ncg);
      } else if (fillLevel <= 0.001) {
        // Fully vapor - use specified pressure and temperature
        const pressure = Math.max(tank.fluid?.pressure ?? 1e5, MIN_STEAM_PRESSURE_PA);
        const temp = tank.fluid?.temperature || 400;
        console.log(`[Factory] Tank ${component.id}: creating VAPOR state at ${pressure/1e5} bar, ${temp}K`);
        fluid = createFluidState(temp, pressure, 'vapor', 1, volume, ncg);
      } else {
        // Partially filled - two-phase mixture
        // Use the user-specified pressure, derive saturation temperature from it
        const pressure = Math.max(tank.fluid?.pressure ?? 1e6, MIN_STEAM_PRESSURE_PA);
        const temp = Water.saturationTemperature(pressure);

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

        console.log(`[Factory] Tank ${component.id}: creating TWO-PHASE state: fillLevel=${fillLevel}, P=${(pressure/1e5).toFixed(1)} bar, T_sat=${temp.toFixed(0)}K, quality=${quality.toFixed(4)}`);

        // Create fluid state with calculated quality
        fluid = createFluidState(temp, pressure, 'two-phase', quality, volume, ncg);
      }

      return {
        id: component.id,
        label: component.label || 'Tank',
        fluid,
        volume,
        hydraulicDiameter: Math.min(tank.width, tank.height),
        flowArea: tank.width * (tank.width || 1),
        height: tank.height,
        elevation,
        // Immersion heaters (e.g. pressurizer): capacity bounds any
        // heater-power controller actuator targeting this node
        heaterCapacity: tank.heaterCapacity,
        heaterPower: tank.initialHeaterPower ?? 0,
      };
    }

    case 'pipe': {
      const pipe = component as any;
      const radius = pipe.diameter / 2;
      const volume = Math.PI * radius * radius * pipe.length;
      const pressure = Math.max(pipe.fluid?.pressure ?? 1e6, MIN_STEAM_PRESSURE_PA);
      const phase = pipe.fluid?.phase || 'liquid';
      const quality = pipe.fluid?.quality ?? 0;

      // For two-phase, use saturation temperature from pressure
      // For single-phase, use specified temperature
      const temp = phase === 'two-phase'
        ? Water.saturationTemperature(pressure)
        : (pipe.fluid?.temperature || 350);

      // Get NCG initial conditions if specified (partial pressures in bar)
      const ncg: NcgPartialPressures | undefined = pipe.initialNcg;

      console.log(`[Factory] Pipe ${component.id}: creating ${phase} state at ${(pressure/1e5).toFixed(1)} bar, ${temp.toFixed(0)}K, quality=${quality.toFixed(2)}`);

      // For pipes, "height" is the vertical component of the pipe length
      // This affects phase separation - horizontal pipes separate better than vertical
      // We'll set height = 0 for pipes since they're treated as well-mixed anyway
      return {
        id: component.id,
        label: component.label || 'Pipe',
        fluid: createFluidState(temp, pressure, phase, quality, volume, ncg),
        volume,
        hydraulicDiameter: pipe.diameter,
        flowArea: Math.PI * radius * radius,
        height: 0,  // Pipes are well-mixed, height doesn't affect separation
        elevation,
      };
    }

    case 'pump': {
      const pump = component as any;
      // Pump node volume = pump casing PLUS its associated piping run.
      // Flow connections in this model carry no volume of their own, so the
      // liquid sitting in the suction/discharge piping (several m³ for a large
      // pump: e.g. 10 m of 0.4 m pipe is 1.3 m³) must be lumped into the pump
      // node. Modeling only the bare casing (~0.1 m³) gives the node an
      // unrealistically high acoustic impedance Z = sqrt(K*L/(V*A)) - any kg/s
      // flow slam then produces tens of bar of water hammer that real piping
      // inventory would absorb.
      // Scale: volume ≈ 0.002 * ratedFlow (500 kg/s → 1 m³, 5000 kg/s → 10 m³,
      // consistent with casing + connected pipe inventory). Minimum 0.1 m³.
      const ratedFlow = pump.ratedFlow || 100;
      const volume = Math.max(0.1, 0.002 * ratedFlow);
      const temp = pump.fluid?.temperature || 350;
      const pressure = Math.max(pump.fluid?.pressure ?? 1e6, MIN_STEAM_PRESSURE_PA);

      return {
        id: component.id,
        label: component.label || 'Pump',
        fluid: createFluidState(temp, pressure, 'liquid', 0, volume),
        volume,
        hydraulicDiameter: pump.diameter || 0.3,
        flowArea: Math.PI * Math.pow((pump.diameter || 0.3) / 2, 2),
        height: 0,  // Pumps are well-mixed
        elevation,
      };
    }

    case 'valve': {
      const valve = component as any;
      // Valve volume scales with diameter
      // Approximate as a cylinder: V ≈ π * (D/2)² * 2D (body length ≈ 2x diameter)
      // For 0.2m valve: V ≈ 0.013 m³
      // Minimum 0.01 m³ to avoid numerical issues
      const diameter = valve.diameter || 0.2;
      const volume = Math.max(0.01, Math.PI * Math.pow(diameter / 2, 2) * diameter * 2);
      const temp = valve.fluid?.temperature || 350;
      const pressure = Math.max(valve.fluid?.pressure ?? 1e6, MIN_STEAM_PRESSURE_PA);

      return {
        id: component.id,
        label: component.label || 'Valve',
        fluid: createFluidState(temp, pressure, 'liquid', 0, volume),
        volume,
        hydraulicDiameter: valve.diameter || 0.2,
        flowArea: Math.PI * Math.pow((valve.diameter || 0.2) / 2, 2),
        height: 0,  // Valves are well-mixed
        elevation,
      };
    }

    case 'vessel': {
      const vessel = component as any;
      const radius = vessel.innerDiameter / 2;
      const volume = Math.PI * radius * radius * vessel.height;
      const temp = vessel.fluid?.temperature || 580; // Higher default for reactor vessel
      const pressure = Math.max(vessel.fluid?.pressure ?? 15e6, MIN_STEAM_PRESSURE_PA); // 150 bar typical PWR

      // Use fillLevel to determine the liquid/vapor split
      // fillLevel is 0-1, default to 1.0 (full) if not specified
      const fillLevel = vessel.fillLevel !== undefined ? vessel.fillLevel : 1.0;

      let fluid: FluidState;

      if (fillLevel >= 0.999) {
        // Fully liquid - use specified pressure
        fluid = createFluidState(temp, pressure, 'liquid', 0, volume);
      } else if (fillLevel <= 0.001) {
        // Fully vapor
        const satPressure = Water.saturationPressure(temp);
        fluid = createFluidState(temp, satPressure, 'vapor', 1, volume);
      } else {
        // Partially filled - two-phase mixture at saturation
        const satPressure = Water.saturationPressure(temp);

        // Calculate quality from fill level (volume fraction to mass fraction)
        const rho_f = Water.saturatedLiquidDensity(temp);
        const rho_g = Water.saturatedVaporDensity(temp);
        const m_liquid = rho_f * fillLevel * volume;
        const m_vapor = rho_g * (1 - fillLevel) * volume;
        const totalMass = m_liquid + m_vapor;
        const quality = m_vapor / totalMass;

        fluid = createFluidState(temp, satPressure, 'two-phase', quality, volume);
      }

      return {
        id: component.id,
        label: component.label || 'Vessel',
        fluid,
        volume,
        hydraulicDiameter: 0.012, // Typical fuel channel
        flowArea: Math.PI * radius * radius * 0.5, // Account for internals
        height: vessel.height,
        elevation,
      };
    }

    case 'heatExchanger': {
      const hx = component as any;
      // Heat exchangers create TWO flow nodes - tube side and shell side
      // Tube volume scales with tube count/size, not a fixed constant - otherwise a HX
      // sized for a small or large plant would have identical (and often unrealistically
      // tiny) primary-side inventory, which starves residence time and destabilizes the solver.
      const tubeOD = hx.tubeOD || 0.02;                 // m
      const tubeEffectiveLength = hx.hxType === 'straight' ? (hx.height || 10) : 2 * (hx.height || 10); // u-tube/helical go up and back down
      const tubeVolume = Math.max(1, hx.tubeCount * Math.PI * Math.pow(tubeOD / 2, 2) * tubeEffectiveLength);
      const tubeTemp = hx.tubeFluid?.temperature || hx.primaryFluid?.temperature || 570;
      const tubePressure = hx.tubeFluid?.pressure || hx.primaryFluid?.pressure || 15e6;

      // Return tube-side node, shell-side is created separately
      return {
        id: `${component.id}-tube`,
        label: `${component.label || 'HX'} Tube`,
        fluid: createFluidState(tubeTemp, tubePressure, 'liquid', 0, tubeVolume),
        volume: tubeVolume,
        hydraulicDiameter: 0.02,
        flowArea: 2,
        height: hx.height,
        elevation,
      };
    }

    case 'turbine-generator': {
      const turbineGen = component as any;
      // Approximate as a cylinder (length = width, diameter = height), scaled down for
      // internal blading/casing. A fixed volume regardless of turbine size gives unrealistically
      // short steam residence time for large machines, destabilizing the solver.
      const volume = Math.max(2, Math.PI * Math.pow((turbineGen.height || 4) / 2, 2) * (turbineGen.width || 10) * 0.6);
      const temp = turbineGen.inletFluid?.temperature || saturationTemperature(5.5e6);
      const pressure = turbineGen.inletFluid?.pressure || 5.5e6;
      // Governor valve position: 0 = closed, 1 = open
      const governorValve = turbineGen.governorValve ?? 1.0;

      return {
        id: component.id,
        label: component.label || 'Turbine-Generator',
        fluid: createFluidState(temp, pressure, 'vapor', 0, volume),
        volume,
        hydraulicDiameter: 0.5,
        flowArea: 0.2,
        height: 0,  // Turbines are well-mixed
        elevation,
        governorValve,
      };
    }

    case 'turbine-driven-pump': {
      const tdPump = component as any;
      const volume = 2;
      const temp = tdPump.inletFluid?.temperature || saturationTemperature(5.5e6);
      const pressure = tdPump.inletFluid?.pressure || 5.5e6;

      return {
        id: component.id,
        label: component.label || 'TD Pump',
        fluid: createFluidState(temp, pressure, 'vapor', 0, volume),
        volume,
        hydraulicDiameter: 0.2,
        flowArea: 0.05,
        height: 0,  // TD pumps are well-mixed
        elevation,
      };
    }

    case 'condenser': {
      const condenser = component as any;
      const volume = condenser.width * condenser.width * condenser.height || 50;
      const pressure = Math.max(condenser.fluid?.pressure ?? 5000, MIN_STEAM_PRESSURE_PA); // 0.05 bar = 5 kPa default
      const temp = saturationTemperature(pressure);

      // Get cooling water properties from component
      const heatSinkTemp = condenser.coolingWaterTemp || 293; // K
      const coolingWaterFlow = condenser.coolingWaterFlow || 50000; // kg/s
      const coolingCapacity = condenser.coolingCapacity || 2000e6; // W (default 2000 MW)

      // Calculate UA from design conditions using LMTD
      // At design: Q = UA × LMTD
      // Steam condenses at T_sat (design), cooling water rises from T_cw_in to T_cw_out
      const T_sat_design = temp; // Use current saturation temp as design point
      const c_p_water = 4186; // J/kg-K for cooling water
      const T_cw_in = heatSinkTemp;
      const T_cw_out = T_cw_in + coolingCapacity / (coolingWaterFlow * c_p_water);

      // LMTD for counter-flow condenser (steam at T_sat, water from T_in to T_out)
      const dT1 = T_sat_design - T_cw_in;  // Hot end: steam vs cold water in
      const dT2 = T_sat_design - T_cw_out; // Cold end: steam vs warm water out

      let LMTD_design: number;
      if (Math.abs(dT1 - dT2) < 0.1) {
        // Avoid division by zero when dT1 ≈ dT2
        LMTD_design = dT1;
      } else if (dT1 <= 0 || dT2 <= 0) {
        // Invalid design conditions - use simple approximation
        console.warn(`[Factory] Condenser ${component.id}: Invalid design temps, using fallback UA`);
        LMTD_design = Math.max(dT1, 1); // At least 1K difference
      } else {
        LMTD_design = (dT1 - dT2) / Math.log(dT1 / dT2);
      }

      const condenserUA = coolingCapacity / LMTD_design;
      console.log(`[Factory] Condenser ${component.id}: UA=${(condenserUA/1e6).toFixed(1)} MW/K, ` +
        `LMTD_design=${LMTD_design.toFixed(1)}K, T_sat=${(T_sat_design-273.15).toFixed(1)}°C, ` +
        `T_cw_in=${(T_cw_in-273.15).toFixed(1)}°C, T_cw_out=${(T_cw_out-273.15).toFixed(1)}°C`);

      // Condenser height - use actual component height so separation can occur
      // (liquid collects in hotwell at bottom, vapor in upper shell)
      const condenserHeight = condenser.height || 3;  // m

      // Get NCG initial conditions if specified (partial pressures in bar)
      // Condensers often have air ingress that needs to be evacuated
      const ncg: NcgPartialPressures | undefined = condenser.initialNcg;

      // Compute initial quality from fillLevel (volume fraction of hotwell liquid),
      // same approach as tank/vessel components. A hardcoded mass-fraction quality
      // is not physically meaningful here: at condenser pressure, vapor is ~4-5 orders
      // of magnitude less dense than liquid, so a small mass fraction of liquid still
      // corresponds to nearly the entire volume - and vice versa, a small mass fraction
      // of vapor (e.g. quality=0.1) corresponds to a nearly-empty hotwell.
      const fillLevel = condenser.fillLevel !== undefined ? condenser.fillLevel : 0.05;
      const rho_f = Water.saturatedLiquidDensity(temp);
      const rho_g = Water.saturatedVaporDensity(temp);
      const m_liquid = rho_f * fillLevel * volume;
      const m_vapor = rho_g * (1 - fillLevel) * volume;
      const quality = m_vapor / (m_liquid + m_vapor);

      return {
        id: component.id,
        label: component.label || 'Condenser',
        fluid: createFluidState(temp, pressure, 'two-phase', quality, volume, ncg),
        volume,
        hydraulicDiameter: 0.02,
        flowArea: 2,
        height: condenserHeight,  // Allow phase separation
        elevation,
        heatSinkTemp,
        coolingWaterFlow,
        condenserUA,
      };
    }

    case 'reactorVessel': {
      // Reactor vessel IS the downcomer region - creates its own flow node
      const rv = component as ReactorVesselComponent;

      // Use stored volume from construction manager (includes dome geometry)
      // Fallback to simplified calculation if not available
      const vesselInnerRadius = rv.innerDiameter / 2;
      const barrelOuterRadius = rv.barrelDiameter / 2 + rv.barrelThickness;
      const effectiveHeight = rv.height - rv.barrelBottomGap - rv.barrelTopGap;
      const calculatedVolume = Math.PI * (vesselInnerRadius * vesselInnerRadius - barrelOuterRadius * barrelOuterRadius) * effectiveHeight;
      const downcomerVolume = (rv as any).volume !== undefined ? (rv as any).volume : calculatedVolume;

      // Use fillLevel to determine the liquid/vapor split
      const fillLevel = rv.fillLevel !== undefined ? rv.fillLevel : 1.0;

      // Get NCG initial conditions if specified (partial pressures in bar)
      const ncg: NcgPartialPressures | undefined = (rv as any).initialNcg;

      let fluid: FluidState;
      const pressure = Math.max(rv.fluid?.pressure ?? 155e5, MIN_STEAM_PRESSURE_PA); // Default PWR pressure

      if (fillLevel >= 0.999) {
        const temp = rv.fluid?.temperature || 565; // ~292°C
        console.log(`[Factory] ReactorVessel ${component.id} (downcomer): creating LIQUID state at ${pressure/1e5} bar, ${temp}K`);
        fluid = createFluidState(temp, pressure, 'liquid', 0, downcomerVolume, ncg);
      } else if (fillLevel <= 0.001) {
        const temp = rv.fluid?.temperature || 620;
        console.log(`[Factory] ReactorVessel ${component.id} (downcomer): creating VAPOR state at ${pressure/1e5} bar, ${temp}K`);
        fluid = createFluidState(temp, pressure, 'vapor', 1, downcomerVolume, ncg);
      } else {
        const temp = Water.saturationTemperature(pressure);
        const rho_f = Water.saturatedLiquidDensity(temp);
        const rho_g = Water.saturatedVaporDensity(temp);
        const m_liquid = rho_f * fillLevel * downcomerVolume;
        const m_vapor = rho_g * (1 - fillLevel) * downcomerVolume;
        const totalMass = m_liquid + m_vapor;
        const quality = m_vapor / totalMass;
        console.log(`[Factory] ReactorVessel ${component.id} (downcomer): creating TWO-PHASE state: fillLevel=${fillLevel}, P=${(pressure/1e5).toFixed(1)} bar, quality=${quality.toFixed(4)}`);
        fluid = createFluidState(temp, pressure, 'two-phase', quality, downcomerVolume, ncg);
      }

      return {
        id: component.id,
        label: component.label || 'Reactor Vessel (Downcomer)',
        fluid,
        volume: downcomerVolume,
        hydraulicDiameter: rv.innerDiameter - rv.barrelDiameter - 2 * rv.barrelThickness, // Annular gap
        flowArea: Math.PI * (vesselInnerRadius * vesselInnerRadius - barrelOuterRadius * barrelOuterRadius),
        height: rv.height,
        elevation,
      };
    }

    case 'coreBarrel': {
      // Core barrel is the core region inside a reactor vessel
      const barrel = component as CoreBarrelComponent;

      // Use stored volume from construction manager (accounts for barrel geometry)
      // Fallback to simplified calculation if not available
      const coreRadius = barrel.innerDiameter / 2;
      const calculatedVolume = Math.PI * coreRadius * coreRadius * barrel.height;
      const coreVolume = (barrel as any).volume !== undefined ? (barrel as any).volume : calculatedVolume;

      // Use fluid from component or default to typical PWR conditions
      const pressure = Math.max(barrel.fluid?.pressure ?? 155e5, MIN_STEAM_PRESSURE_PA);
      const fillLevel = 1.0; // Core region is typically full

      let fluid: FluidState;

      if (fillLevel >= 0.999) {
        const temp = barrel.fluid?.temperature || 580; // Slightly hotter than inlet
        console.log(`[Factory] CoreBarrel ${component.id}: creating LIQUID state at ${pressure/1e5} bar, ${temp}K`);
        fluid = createFluidState(temp, pressure, 'liquid', 0, coreVolume);
      } else {
        const temp = Water.saturationTemperature(pressure);
        const rho_f = Water.saturatedLiquidDensity(temp);
        const rho_g = Water.saturatedVaporDensity(temp);
        const m_liquid = rho_f * fillLevel * coreVolume;
        const m_vapor = rho_g * (1 - fillLevel) * coreVolume;
        const totalMass = m_liquid + m_vapor;
        const quality = m_vapor / totalMass;
        console.log(`[Factory] CoreBarrel ${component.id}: creating TWO-PHASE state: P=${(pressure/1e5).toFixed(1)} bar, quality=${quality.toFixed(4)}`);
        fluid = createFluidState(temp, pressure, 'two-phase', quality, coreVolume);
      }

      return {
        id: component.id,
        label: component.label || 'Core Region',
        fluid,
        volume: coreVolume,
        hydraulicDiameter: barrel.innerDiameter,
        flowArea: Math.PI * coreRadius * coreRadius,
        height: barrel.height,
        elevation,
      };
    }

    case 'crossVessel': {
      // Cross-vessel - like a horizontal straight-tube HX with one tube
      // Two flow nodes: inner pipe (hot leg) and annulus (cold)
      // Return inner pipe node here; annulus is created separately like HX shell
      const cv = component as any;

      // Inner pipe volume and properties
      const innerRadius = cv.innerDiameter / 2;
      const innerVolume = (cv as any).innerVolume || Math.PI * innerRadius * innerRadius * cv.length;

      // Use fluid from component or default to typical hot leg conditions
      const pressure = Math.max(cv.fluid?.pressure ?? 155e5, MIN_STEAM_PRESSURE_PA);
      const temp = cv.fluid?.temperature || 593; // ~320°C typical hot leg

      let fluid: FluidState;
      console.log(`[Factory] CrossVessel ${component.id}: creating inner pipe LIQUID state at ${pressure/1e5} bar, ${temp}K`);
      fluid = createFluidState(temp, pressure, 'liquid', 0, innerVolume);

      // Return inner pipe node; annulus is created separately
      return {
        id: `${component.id}-inner`,
        label: `${component.label || 'Cross-Vessel'} Inner`,
        fluid,
        volume: innerVolume,
        hydraulicDiameter: cv.innerDiameter,
        flowArea: Math.PI * innerRadius * innerRadius,
        height: 0,  // Horizontal, well-mixed
        elevation,
      };
    }

    case 'building': {
      // Building/Containment - large structure, defaults to air at atmospheric pressure
      const building = component as any;

      // Calculate volume based on shape
      let volume: number;
      let footprintArea: number;
      let hydraulicDiameter: number;

      if (building.shape === 'cylinder') {
        const radius = (building.diameter || 40) / 2;
        volume = Math.PI * radius * radius * building.height;
        footprintArea = Math.PI * radius * radius;
        hydraulicDiameter = building.diameter || 40;
      } else {
        // Rectangle
        const width = building.width || 40;
        const length = building.length || 40;
        volume = width * length * building.height;
        footprintArea = width * length;
        hydraulicDiameter = Math.sqrt(width * length);  // Equivalent diameter
      }

      // Default to atmospheric pressure (1.01325 bar) and room temperature
      const fillLevel = building.fillLevel !== undefined ? building.fillLevel : 0;
      const temp = building.fluid?.temperature || 293;  // ~20°C

      // Default NCG is atmospheric air if not specified
      const ncg: NcgPartialPressures = building.initialNcg || {
        N2: 0.78,   // bar - nitrogen
        O2: 0.21,   // bar - oxygen
        Ar: 0.009,  // bar - argon
      };

      // Calculate total NCG pressure from partial pressures
      let ncgTotalPressure = 0;
      for (const species of ['N2', 'O2', 'Ar', 'H2', 'He', 'CO2', 'CO'] as const) {
        if (ncg[species]) {
          ncgTotalPressure += ncg[species] * 1e5; // bar to Pa
        }
      }

      // For buildings, the user-specified pressure is TOTAL pressure (steam + NCG)
      // We need to calculate steam pressure = total - NCG
      // Default total pressure is ~1 bar (atmospheric)
      const totalPressure = building.fluid?.pressure ?? 101325;
      // Steam pressure is total minus NCG, but must be at least MIN_STEAM_PRESSURE_PA
      const steamPressure = Math.max(totalPressure - ncgTotalPressure, MIN_STEAM_PRESSURE_PA);

      let fluid: FluidState;

      if (fillLevel >= 0.999) {
        // Fully liquid (unusual for a building but possible, e.g., flooded)
        console.log(`[Factory] Building ${component.id}: creating LIQUID state, P_total=${totalPressure/1e5} bar, P_steam=${steamPressure/1e5} bar, ${temp}K`);
        fluid = createFluidState(temp, steamPressure, 'liquid', 0, volume, ncg);
      } else if (fillLevel <= 0.001) {
        // Fully vapor/gas (normal case for containment)
        console.log(`[Factory] Building ${component.id}: creating VAPOR state, P_total=${totalPressure/1e5} bar, P_steam=${steamPressure/1e5} bar, ${temp}K with air`);
        fluid = createFluidState(temp, steamPressure, 'vapor', 1, volume, ncg);
      } else {
        // Partially filled - two-phase mixture
        const T_sat = Water.saturationTemperature(steamPressure);
        const rho_f = Water.saturatedLiquidDensity(T_sat);
        const rho_g = Water.saturatedVaporDensity(T_sat);
        const m_liquid = rho_f * fillLevel * volume;
        const m_vapor = rho_g * (1 - fillLevel) * volume;
        const totalMass = m_liquid + m_vapor;
        const quality = m_vapor / totalMass;

        console.log(`[Factory] Building ${component.id}: creating TWO-PHASE state: fillLevel=${fillLevel}, P_steam=${(steamPressure/1e5).toFixed(2)} bar, quality=${quality.toFixed(4)}`);
        fluid = createFluidState(T_sat, steamPressure, 'two-phase', quality, volume, ncg);
      }

      return {
        id: component.id,
        label: component.label || 'Building',
        fluid,
        volume,
        hydraulicDiameter,
        flowArea: footprintArea,
        height: building.height,
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
  const isRunning = pump.running ?? true;

  return {
    id: component.id,
    running: isRunning,
    speed: isRunning ? (pump.speed ?? 1.0) : 0,  // Target speed (fraction of rated)
    // Pumps marked running start AT speed: the plant is loaded "already
    // operating", and a reactor at full power with stagnant coolant boils its
    // core during the ramp (density feedback then crushes the power).
    // Starting at speed used to be a water-hammer risk when momentum was
    // integrated explicitly, but the implicit pressure-flow solve brings the
    // loop to its friction-limited equilibrium smoothly. Pumps toggled on
    // mid-simulation still ramp via PumpSpeedRateOperator.
    effectiveSpeed: isRunning ? (pump.speed ?? 1.0) : 0,
    ratedHead: pump.ratedHead || 150,
    ratedFlow: pump.ratedFlow || 1000,
    efficiency: 0.85,
    connectedFlowPath: '', // Set later when connections are processed
    rampUpTime: 5.0,
    coastDownTime: 30.0,
    npshRequired: pump.npshRequired || 5,  // Default 5m NPSHr
    pumpType: pump.type || 'centrifugal',
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
 * Create neutronics state from a core component.
 *
 * With `initializeCritical: true` on the core component, the reactor starts
 * AT its operating point: feedback references are anchored to the actual
 * initial fuel/coolant state (so feedback reactivity is exactly 0 at t=0),
 * rods are placed at the critical position 1 - excess/worth, power is at
 * nominal, and precursors are at equilibrium. A rod controller then only has
 * to hold the point, not find it.
 *
 * @param state - simulation state built so far (coolant flow node and fuel
 *   thermal node for this core must already exist)
 */
function createNeutronicsFromCore(component: PlantComponent, state?: SimulationState): NeutronicsState {
  const vessel = component as any;

  const nominalPower = vessel.nominalPower ?? 1000e6;
  const controlRodWorth = vessel.controlRodWorth ?? 0.05;
  // Built-in enrichment margin: >0 puts the critical rod position at partial
  // insertion so a rod controller has authority in both directions.
  const excessReactivity = vessel.excessReactivity ?? 0;

  // Actual initial conditions (for critical initialization)
  const coolantNode = state?.flowNodes.get(component.id);
  const fuelNode = state?.thermalNodes.get(`${component.id}-fuel`);

  let refFuelTemp = 887;
  let refCoolantTemp = 520;
  let refCoolantDensity = 750;
  let rodPosition = vessel.controlRodPosition ?? 0.8;
  let power = nominalPower;

  if (vessel.initializeCritical) {
    if (!coolantNode || !fuelNode) {
      throw new Error(
        `[Factory] Core '${component.id}' has initializeCritical but its coolant/fuel nodes ` +
        `were not created first - cannot anchor feedback references`
      );
    }
    // Anchor feedback references at the initial state: feedback rho = 0 now
    refFuelTemp = fuelNode.temperature;
    refCoolantTemp = coolantNode.fluid.temperature;
    refCoolantDensity = coolantNode.fluid.mass / coolantNode.volume;
    // Critical position: rho = excess - worth*(1 - pos) = 0
    rodPosition = 1 - excessReactivity / controlRodWorth;
    if (rodPosition < 0.05 || rodPosition > 0.95) {
      throw new Error(
        `[Factory] Core '${component.id}': critical rod position ${rodPosition.toFixed(3)} is ` +
        `outside [0.05, 0.95] - excessReactivity (${excessReactivity}) vs rod worth ` +
        `(${controlRodWorth}) leaves no control margin`
      );
    }
    power = vessel.initialPower ?? nominalPower;
    console.log(
      `[Factory] Core '${component.id}': initialized critical at rods=${(rodPosition * 100).toFixed(1)}%, ` +
      `P=${(power / 1e6).toFixed(0)} MW, refs T_fuel=${refFuelTemp.toFixed(0)}K ` +
      `T_cool=${refCoolantTemp.toFixed(0)}K rho_cool=${refCoolantDensity.toFixed(0)}kg/m³`
    );
  }

  const promptNeutronLifetime = 1e-4;
  const delayedNeutronFraction = 0.0065;
  const precursorDecayConstant = 0.08;
  // Precursor equilibrium for the initial power: dC/dt = 0 => C = beta*N/(lambda*Lambda)
  const precursorConcentration =
    (delayedNeutronFraction * (power / nominalPower)) /
    (precursorDecayConstant * promptNeutronLifetime);

  return {
    // Link to this specific core
    coreId: component.id,
    fuelNodeId: `${component.id}-fuel`,
    coolantNodeId: component.id, // The vessel's flow node

    power,
    nominalPower,
    reactivity: 0,
    promptNeutronLifetime,
    delayedNeutronFraction,
    precursorConcentration,
    precursorDecayConstant,
    fuelTempCoeff: vessel.fuelTempCoeff ?? -2.5e-5,
    coolantTempCoeff: vessel.coolantTempCoeff ?? -1e-5,
    coolantDensityCoeff: vessel.coolantDensityCoeff ?? 0.001,
    refFuelTemp,
    refCoolantTemp,
    refCoolantDensity,
    controlRodPosition: rodPosition,
    controlRodWorth,
    excessReactivity,
    decayHeatFraction: 0.07, // Start with steady-state decay heat
    scrammed: false,
    scramTime: -1,
    scramReason: '',
    reactivityBreakdown: {
      controlRods: 0,
      doppler: 0,
      coolantTemp: 0,
      coolantDensity: 0,
    },
    diagnostics: {
      fuelTemp: refFuelTemp,
      coolantTemp: refCoolantTemp,
      coolantDensity: refCoolantDensity,
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
 * Create shell-side flow node for heat exchanger
 */
function createHeatExchangerShellNode(component: PlantComponent): FlowNode {
  const hx = component as any;
  const elevation = hx.elevation || 0;
  // Approximate shell as a cylinder (diameter = width) minus tube bundle volume,
  // rather than a fixed constant - see tube-side volume comment above for why.
  const shellVolume = Math.max(2, Math.PI * Math.pow((hx.width || 3) / 2, 2) * (hx.height || 10) * 0.75);
  const shellTemp = hx.shellFluid?.temperature || hx.secondaryFluid?.temperature || saturationTemperature(5.5e6);
  const shellPressure = hx.shellFluid?.pressure || hx.secondaryFluid?.pressure || 5.5e6;
  const phase = hx.shellFluid?.phase || hx.secondaryFluid?.phase || 'two-phase';
  const quality = hx.shellFluid?.quality || hx.secondaryFluid?.quality || 0.5;

  return {
    id: `${component.id}-shell`,
    label: `${component.label || 'HX'} Shell`,
    fluid: createFluidState(shellTemp, shellPressure, phase, quality, shellVolume),
    volume: shellVolume,
    hydraulicDiameter: 0.1,
    flowArea: 5,
    height: hx.height,
    elevation,
  };
}

/**
 * Create annulus flow node for cross-vessel (like HX shell)
 */
function createCrossVesselAnnulusNode(component: PlantComponent): FlowNode {
  const cv = component as any;
  const elevation = cv.elevation || 0;

  // Calculate annulus volume
  const innerRadius = cv.innerDiameter / 2;
  const outerRadius = cv.outerDiameter / 2;
  const innerOuterRadius = innerRadius + cv.innerWallThickness;
  const outerInnerRadius = outerRadius - cv.wallThickness;
  const annulusVolume = cv.annulusVolume ||
    Math.PI * cv.length * (outerInnerRadius * outerInnerRadius - innerOuterRadius * innerOuterRadius);

  // Annulus fluid - cold primary coolant
  const annulusTemp = cv.annulusFluid?.temperature || 565; // ~292°C typical cold leg
  const annulusPressure = cv.annulusFluid?.pressure || cv.fluid?.pressure || 155e5;

  // Hydraulic diameter of annulus: D_h = D_outer - D_inner (for annular flow)
  const hydraulicDiameter = 2 * (outerInnerRadius - innerOuterRadius);
  const flowArea = Math.PI * (outerInnerRadius * outerInnerRadius - innerOuterRadius * innerOuterRadius);

  return {
    id: `${component.id}-annulus`,
    label: `${component.label || 'Cross-Vessel'} Annulus`,
    fluid: createFluidState(annulusTemp, annulusPressure, 'liquid', 0, annulusVolume),
    volume: annulusVolume,
    hydraulicDiameter,
    flowArea,
    height: 0,  // Horizontal, well-mixed
    elevation,
  };
}

/**
 * Create extraction flow nodes for turbine extraction ports.
 * Each extraction port gets its own flow node at the extraction pressure.
 */
function createTurbineExtractionNodes(component: PlantComponent): FlowNode[] {
  const turbine = component as any;
  const extractionPorts = turbine.extractionPorts || [];
  const elevation = turbine.elevation || 0;

  const nodes: FlowNode[] = [];

  for (const extraction of extractionPorts) {
    const extPressure = extraction.pressure;
    // Extraction steam is partially expanded - use saturation temp at extraction pressure
    // The actual enthalpy is computed dynamically in the rate operator
    const extTemp = saturationTemperature(extPressure);
    const volume = 2; // m³ - small volume for extraction line

    nodes.push({
      id: `${component.id}-${extraction.id}`,
      label: `${component.label || 'Turbine'} ${extraction.id}`,
      fluid: createFluidState(extTemp, extPressure, 'vapor', 0, volume),
      volume,
      hydraulicDiameter: 0.2,
      flowArea: 0.05,
      height: 0,  // Extraction ports are well-mixed
      elevation,
      // Store extraction pressure for rate operator reference
      extractionPressure: extPressure,
      parentTurbineId: component.id,
    });
  }

  return nodes;
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

  // Determine flow node IDs (heat exchangers have -tube/-shell suffixes)
  let fromNodeId = connection.fromComponentId;
  let toNodeId = connection.toComponentId;

  // Handle heat exchanger port mappings
  if (fromComponent.type === 'heatExchanger') {
    if (connection.fromPortId.includes('tube')) {
      fromNodeId = `${connection.fromComponentId}-tube`;
    } else if (connection.fromPortId.includes('shell')) {
      fromNodeId = `${connection.fromComponentId}-shell`;
    }
  }
  if (toComponent.type === 'heatExchanger') {
    if (connection.toPortId.includes('tube')) {
      toNodeId = `${connection.toComponentId}-tube`;
    } else if (connection.toPortId.includes('shell')) {
      toNodeId = `${connection.toComponentId}-shell`;
    }
  }

  // Handle cross-vessel port mappings (inner vs annulus)
  if (fromComponent.type === 'crossVessel') {
    if (connection.fromPortId.includes('inner')) {
      fromNodeId = `${connection.fromComponentId}-inner`;
    } else if (connection.fromPortId.includes('annulus')) {
      fromNodeId = `${connection.fromComponentId}-annulus`;
    }
  }
  if (toComponent.type === 'crossVessel') {
    if (connection.toPortId.includes('inner')) {
      toNodeId = `${connection.toComponentId}-inner`;
    } else if (connection.toPortId.includes('annulus')) {
      toNodeId = `${connection.toComponentId}-annulus`;
    }
  }

  // Handle turbine-generator extraction port mappings
  // Extraction ports connect as: turbine-id-extraction-id (e.g., turbine-gen-1-extraction-1)
  if (fromComponent.type === 'turbine-generator') {
    // Check if this is an extraction port (not inlet or outlet)
    if (connection.fromPortId !== 'inlet' && connection.fromPortId !== 'outlet') {
      fromNodeId = `${connection.fromComponentId}-${connection.fromPortId}`;
    }
  }
  if (toComponent.type === 'turbine-generator') {
    // Check if this is an extraction port (not inlet or outlet)
    if (connection.toPortId !== 'inlet' && connection.toPortId !== 'outlet') {
      toNodeId = `${connection.toComponentId}-${connection.toPortId}`;
    }
  }

  const fromElevation = (fromComponent as any).elevation || 0;
  const toElevation = (toComponent as any).elevation || 0;
  const elevationChange = toElevation - fromElevation;

  // Use flow area from plant connection if provided, otherwise estimate from components
  let flowArea = connection.flowArea ?? 0.1; // Use plant connection's flowArea if set
  let hydraulicDiameter = 0.3;
  let length = connection.length ?? 1;

  // Use pipe dimensions if connecting through pipes (overrides connection flowArea)
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

  // Get connection point elevations from plant connection (relative to component bottom)
  // These are physical elevations in meters
  const connFromElevation = connection.fromElevation;
  const connToElevation = connection.toElevation;

  // Auto-detect phase tolerance for condenser bottom connections
  // If fromPhaseTolerance isn't set, and this is a condenser with a low elevation connection,
  // set a small tolerance so it draws liquid when there's meaningful liquid present,
  // but switches to mixture/vapor when the hotwell is nearly empty.
  // Using 0.01m (1cm) as minimum liquid level for "pure liquid" draw.
  let fromPhaseTolerance = connection.fromPhaseTolerance;
  if (fromPhaseTolerance === undefined && fromComponent.type === 'condenser') {
    // Check if connection is at the bottom (fromElevation near 0 or undefined)
    const connElev = connFromElevation ?? 0;
    if (connElev < 0.2) {
      fromPhaseTolerance = 0.01; // Draw liquid if level > 1cm, otherwise mixture
    }
  }

  // Same for toNode (in case flow reverses)
  let toPhaseTolerance = connection.toPhaseTolerance;
  if (toPhaseTolerance === undefined && toComponent.type === 'condenser') {
    const connElev = connToElevation ?? 0;
    if (connElev < 0.2) {
      toPhaseTolerance = 0.01;
    }
  }

  return {
    id: `flow-${connection.fromComponentId}-${connection.toComponentId}`,
    fromNodeId,
    toNodeId,
    flowArea,
    hydraulicDiameter,
    length,
    elevation: elevationChange,
    fromElevation: connFromElevation,
    toElevation: connToElevation,
    fromPhaseTolerance,
    toPhaseTolerance,
    // Loss coefficient: user-specifiable per connection (loop hydraulics are
    // a real design lever - the default 5 costs a PWR primary loop ~30% of
    // its rated flow), default 5.
    resistanceCoeff: (connection as any).resistanceCoeff ?? 5,
    massFlowRate: 0, // Start at zero
    inertance: length / flowArea,
  };
}

// ============================================================================
// Burst/LOCA Support Functions
// ============================================================================

/**
 * Create the atmosphere boundary node.
 * Represents ambient conditions for LOCA scenarios where fluid escapes containment.
 */
function createAtmosphereNode(): FlowNode {
  return {
    id: 'atmosphere',
    label: 'Atmosphere',
    fluid: {
      mass: 1e12,                    // Effectively infinite
      internalEnergy: 1e12 * 293 * 1000, // ~20°C air
      temperature: 293,              // K (20°C)
      pressure: 101325,              // 1 atm
      phase: 'vapor',
      quality: 1,
    },
    volume: 1e12,                    // Effectively infinite
    hydraulicDiameter: 100,
    flowArea: 1e6,
    elevation: 0,
    isBoundary: true,                // Fixed boundary - state never updated by physics
  };
}

/**
 * Calculate collapse pressure from geometry using elastic buckling formula.
 *
 * For a thin-walled cylinder under external pressure, collapse occurs at:
 *   P_collapse = 2 * E * (t/D)³ / (1 - ν²)
 *
 * where:
 *   E = Young's modulus (~200 GPa for steel)
 *   ν = Poisson's ratio (~0.3 for steel)
 *   t = wall thickness
 *   D = diameter
 *
 * This assumes the same random margin as burst pressure for variability.
 * The ratio of collapse to burst pressure scales with (t/D)², so thin-walled
 * vessels are much more vulnerable to external pressure than internal.
 */
function calculateCollapsePressure(
  diameter: number,      // m - inner diameter
  thickness: number,     // m - wall thickness
  randomMargin: number   // same margin as burst (0-0.4)
): number {
  const E = 200e9;       // Pa - Young's modulus for steel
  const nu = 0.3;        // Poisson's ratio for steel

  const tOverD = thickness / diameter;
  const designCollapse = (2 * E * Math.pow(tOverD, 3)) / (1 - nu * nu);

  // Apply same random margin as burst pressure
  return designCollapse * (1 + randomMargin);
}

/**
 * Get geometry (diameter and wall thickness) from a component.
 * Uses explicit values when available, or calculates from pressure rating.
 * Returns null if geometry cannot be determined.
 */
function getComponentGeometry(
  component: PlantComponent,
  pressureRatingBar: number
): { diameter: number; thickness: number } | null {
  const comp = component as any;

  // Pipes have explicit diameter and thickness
  if (component.type === 'pipe' && comp.diameter && comp.thickness) {
    return { diameter: comp.diameter, thickness: comp.thickness };
  }

  // Vessels have explicit innerDiameter and wallThickness
  if (component.type === 'vessel' && comp.innerDiameter && comp.wallThickness) {
    return { diameter: comp.innerDiameter, thickness: comp.wallThickness };
  }

  // Tanks have explicit innerDiameter and wallThickness
  if (component.type === 'tank' && comp.innerDiameter && comp.wallThickness) {
    return { diameter: comp.innerDiameter, thickness: comp.wallThickness };
  }

  // Valves have diameter, calculate thickness from pressure rating
  if (component.type === 'valve' && comp.diameter) {
    const thickness = calculateThicknessFromPressure(pressureRatingBar, comp.diameter);
    return { diameter: comp.diameter, thickness };
  }

  // Pumps have diameter, calculate thickness from pressure rating
  if (component.type === 'pump' && comp.diameter) {
    const thickness = calculateThicknessFromPressure(pressureRatingBar, comp.diameter);
    return { diameter: comp.diameter, thickness };
  }

  // Reactor vessels have innerDiameter and wallThickness
  if (component.type === 'reactorVessel' && comp.innerDiameter && comp.wallThickness) {
    return { diameter: comp.innerDiameter, thickness: comp.wallThickness };
  }

  return null;
}

/**
 * Calculate wall thickness from pressure rating using simplified Barlow formula.
 * t = P * D / (2 * S) where S = 138 MPa (SA-106 Grade B)
 *
 * The minimum is diameter-proportional (D/50, floor 3mm) rather than a fixed
 * 2mm: this is used for cast bodies (pumps, valves, HX shells), which are far
 * thicker than the Barlow minimum for castability and rigidity. A fixed 2mm
 * wall on a 0.4m pump gives a buckling collapse pressure below 1 bar, which
 * would (unphysically) crush any pump pulling suction from a condenser vacuum.
 */
function calculateThicknessFromPressure(pressureBar: number, diameter: number): number {
  const P = pressureBar * 1e5;  // bar to Pa
  const S = 138e6;              // Pa - allowable stress
  const thickness = P * diameter / (2 * S);
  return Math.max(0.003, diameter / 50, thickness);
}

/**
 * Initialize burst states for all pressurized components.
 * Burst pressure = design rating + random 0-40% margin.
 * Collapse pressure = calculated from geometry (buckling under external pressure).
 */
function initializeBurstStates(
  plantState: PlantState,
  state: SimulationState
): void {
  state.burstStates = new Map();
  state.burstConfig = { ...DEFAULT_BURST_CONFIG };
  state.atmosphereRelease = { totalMass: 0, totalEnergy: 0, steamMass: 0, liquidMass: 0 };

  for (const [compId, component] of plantState.components) {
    // Get pressure rating if component has one
    const pressureRating = (component as any).pressureRating;
    if (!pressureRating || pressureRating <= 0) continue;

    const designPressure = pressureRating * 1e5;  // bar to Pa
    const randomMargin = simulationRandom() * 0.4;     // 0-40%
    const burstPressure = designPressure * (1 + randomMargin);

    // Special handling for heat exchangers (tube + shell sides)
    if (component.type === 'heatExchanger') {
      const hx = component as any;

      // Shell side burst state
      const shellNodeId = `${compId}-shell`;
      if (state.flowNodes.has(shellNodeId)) {
        const shellNode = state.flowNodes.get(shellNodeId)!;
        // For HX shell, estimate diameter from width/height (whichever is smaller is typically the diameter)
        const shellDiameter = Math.min(hx.width || 1, hx.height || 1);
        const shellThickness = calculateThicknessFromPressure(pressureRating, shellDiameter);
        const shellCollapsePressure = calculateCollapsePressure(shellDiameter, shellThickness, randomMargin);

        state.burstStates.set(shellNodeId, {
          nodeId: shellNodeId,
          componentId: compId,
          componentLabel: `${component.label || 'HX'} (shell)`,
          designPressure,
          burstPressure,
          collapsePressure: shellCollapsePressure,
          randomMargin,
          isBurst: false,
          currentBreakFraction: 0,
          breakSizeSeed: simulationRandom() * 10000,
        });
        // Set containerId on shell node if not set (breaks go to atmosphere)
        if (!shellNode.containerId) {
          shellNode.containerId = undefined; // Explicitly undefined = atmosphere
        }
      }

      // Tube side burst state (uses gauge pressure vs shell)
      const tubeNodeId = `${compId}-tube`;
      const tubePressureRating = hx.tubePressureRating || hx.pressureRating || pressureRating;
      const tubeDesignPressure = tubePressureRating * 1e5;
      const tubeRandomMargin = simulationRandom() * 0.4;
      const tubeBurstPressure = tubeDesignPressure * (1 + tubeRandomMargin);

      // For HX tubes, use tubeOD or default to 19mm (3/4" standard)
      const tubeOD = hx.tubeOD || 0.019;
      const tubeThickness = calculateThicknessFromPressure(tubePressureRating, tubeOD);
      const tubeCollapsePressure = calculateCollapsePressure(tubeOD, tubeThickness, tubeRandomMargin);

      if (state.flowNodes.has(tubeNodeId)) {
        state.burstStates.set(tubeNodeId, {
          nodeId: tubeNodeId,
          componentId: compId,
          componentLabel: `${component.label || 'HX'} (tubes)`,
          designPressure: tubeDesignPressure,
          burstPressure: tubeBurstPressure,
          collapsePressure: tubeCollapsePressure,
          randomMargin: tubeRandomMargin,
          isBurst: false,
          currentBreakFraction: 0,
          breakSizeSeed: simulationRandom() * 10000,
          isTubeSide: true,
          shellNodeId,  // Tube bursts go to shell (gauge pressure comparison)
        });
      }
      continue;
    }

    // Standard component with single node
    const simNodeId = (component as any).simNodeId || compId;
    if (state.flowNodes.has(simNodeId)) {
      const flowNode = state.flowNodes.get(simNodeId)!;

      // Calculate collapse pressure from geometry
      const geometry = getComponentGeometry(component, pressureRating);
      const collapsePressure = geometry
        ? calculateCollapsePressure(geometry.diameter, geometry.thickness, randomMargin)
        : burstPressure * 0.5;  // Default: assume thin-walled, collapse at half burst pressure

      const burstState: BurstState = {
        nodeId: simNodeId,
        componentId: compId,
        componentLabel: component.label || component.type,
        designPressure,
        burstPressure,
        collapsePressure,
        randomMargin,
        isBurst: false,
        currentBreakFraction: 0,
        breakSizeSeed: simulationRandom() * 10000,
      };

      // For pipes, breakLocation will be set on burst
      if (component.type === 'pipe') {
        burstState.breakLocation = undefined;
      }

      state.burstStates.set(simNodeId, burstState);

      // Ensure containerId is set for proper gauge pressure calculation
      // If component has containedBy, link the flow node to its container
      if (component.containedBy) {
        const containerComp = plantState.components.get(component.containedBy);
        if (containerComp) {
          const containerNodeId = (containerComp as any).simNodeId || component.containedBy;
          if (state.flowNodes.has(containerNodeId)) {
            flowNode.containerId = containerNodeId;
          }
        }
      }
    }
  }

  console.log(`[Factory] Initialized ${state.burstStates.size} burst states`);
}
