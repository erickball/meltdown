/**
 * Simulation State Types
 *
 * The simulation uses a node-based approach where the plant is discretized
 * into thermal nodes (solid materials) and flow nodes (fluid volumes).
 * These are connected via heat transfer and flow connections.
 */

// ============================================================================
// Fluid Properties
// ============================================================================

export interface FluidState {
  // CONSERVED QUANTITIES (primary state variables)
  mass: number;           // kg - total fluid mass in this node
  internalEnergy: number; // J - total internal energy in this node

  // DERIVED QUANTITIES (computed from mass, energy, and volume)
  temperature: number;    // K
  pressure: number;       // Pa
  phase: 'liquid' | 'vapor' | 'two-phase';
  quality: number;        // Vapor mass fraction (0-1), only meaningful for two-phase
}

// ============================================================================
// Thermal Nodes - Solid materials that conduct heat
// ============================================================================

export interface ThermalNode {
  id: string;
  label: string;                    // Human-readable name

  // Thermal state
  temperature: number;              // K

  // Material properties
  mass: number;                     // kg
  specificHeat: number;             // J/kg-K (can be temperature-dependent later)
  thermalConductivity: number;      // W/m-K

  // Geometry (for conduction calculations)
  characteristicLength: number;     // m - typical dimension for conduction
  surfaceArea: number;              // m² - for convection to fluid

  // Heat sources
  heatGeneration: number;           // W - internal heat generation (fission, decay)

  // Limits for damage modeling
  maxTemperature: number;           // K - failure/damage threshold
}

// ============================================================================
// Flow Nodes - Fluid volumes that exchange mass and energy
// ============================================================================

export interface FlowNode {
  id: string;
  label: string;

  // Fluid state
  fluid: FluidState;

  // Geometry
  volume: number;                   // m³
  hydraulicDiameter: number;        // m - for heat transfer correlations
  flowArea: number;                 // m² - cross-sectional flow area
  height?: number;                  // m - vertical height (for phase separation)

  // Elevation for natural circulation
  elevation: number;                // m - height relative to reference

  // Optional: Condenser properties (only for condenser nodes)
  heatSinkTemp?: number;            // K - cooling water inlet temperature
  coolingWaterFlow?: number;        // kg/s - cooling water mass flow rate
  condenserUA?: number;             // W/K - overall heat transfer coefficient × area

  // Ice/freezing latent heat buffer
  // When temperature would drop below 273.15K, energy goes into latent heat instead
  // iceFraction = 0 means no ice, iceFraction = 1 means fully frozen
  // Latent heat of fusion for water: 334 kJ/kg
  iceFraction?: number;             // 0-1, fraction of mass that is frozen

  // Phase separation factor (calculated by FlowRateOperator)
  // 0 = fully mixed (uniform quality throughout)
  // 1 = fully separated (pure liquid at bottom, pure vapor at top)
  // Used by renderer to show appropriate pixelation in each zone
  separation?: number;              // 0-1, degree of phase separation
}

// ============================================================================
// Connections between nodes
// ============================================================================

export interface ThermalConnection {
  id: string;
  fromNodeId: string;               // Thermal node ID
  toNodeId: string;                 // Thermal node ID

  // Conduction parameters
  conductance: number;              // W/K - k*A/L for this connection
}

export interface ConvectionConnection {
  id: string;
  thermalNodeId: string;            // Solid node
  flowNodeId: string;               // Fluid node

  // Heat transfer parameters
  surfaceArea: number;              // m² - wetted surface area
  // Heat transfer coefficient computed dynamically based on flow
}

export interface FlowConnection {
  id: string;
  fromNodeId: string;               // Upstream flow node
  toNodeId: string;                 // Downstream flow node

  // Flow parameters
  flowArea: number;                 // m² - pipe cross-section
  hydraulicDiameter: number;        // m
  length: number;                   // m - for pressure drop
  elevation: number;               // m - elevation change (+ = upward)

  // Connection point elevations (relative to node bottom)
  // If not specified, assumes mid-height of node
  fromElevation?: number;           // m - height of connection at from node
  toElevation?: number;             // m - height of connection at to node

  // Flow resistance (K-factor for pressure drop)
  resistanceCoeff: number;          // ΔP = K * 0.5 * ρ * v²

  // Check valve - allows flow only in forward direction (from -> to)
  hasCheckValve?: boolean;          // If true, prevents reverse flow

  // LOCA (Loss of Coolant Accident) - pipe break
  breakFraction?: number;           // 0-1, fraction of flow area that is broken (0 = no break)
  breakDischargeCoeff?: number;     // Discharge coefficient for break flow (default 0.6)

  // Current flow state (computed by solver)
  massFlowRate: number;             // kg/s (positive = from -> to)

  // Target flow rate (computed from pressure balance, for debugging)
  targetFlowRate?: number;          // kg/s - what flow would be at equilibrium

  // Steady-state flow (what flow would be without momentum effects)
  steadyStateFlow?: number;         // kg/s - instantaneous flow from pressure balance

  // Flow momentum (for inertial effects)
  inertance?: number;               // m⁻¹ - L/A ratio (length/area)
  // Note: inertance = length / flowArea
  // The momentum equation: ρ * inertance * d(flow)/dt = ΔP
}

// ============================================================================
// Neutronics State (simplified point kinetics)
// ============================================================================

export interface NeutronicsState {
  // Link to the core this neutronics state belongs to
  // If null/undefined, neutronics is disabled (no core present)
  coreId: string | null;            // ID of the vessel/core component
  fuelNodeId: string | null;        // ID of the thermal node for fuel
  coolantNodeId: string | null;     // ID of the flow node for coolant

  // Reactor power
  power: number;                    // W - current fission power
  nominalPower: number;             // W - 100% rated power

  // Reactivity (dimensionless, often expressed in $ or pcm)
  reactivity: number;               // Δk/k

  // Point kinetics parameters
  promptNeutronLifetime: number;    // s (Λ) - typically ~1e-5 to 1e-4 for LWRs
  delayedNeutronFraction: number;   // β - typically ~0.0065 for U-235

  // Delayed neutron precursor groups (simplified to 1 group for now)
  precursorConcentration: number;   // Relative units
  precursorDecayConstant: number;   // 1/s (λ) - effective value ~0.08

  // Reactivity feedback coefficients
  fuelTempCoeff: number;            // Δρ/ΔT_fuel (Doppler), typically negative
  coolantTempCoeff: number;         // Δρ/ΔT_coolant, sign varies
  coolantDensityCoeff: number;      // Δρ/Δρ_coolant (void coefficient)

  // Reference conditions for feedback
  refFuelTemp: number;              // K
  refCoolantTemp: number;           // K
  refCoolantDensity: number;        // kg/m³

  // Control rod worth
  controlRodPosition: number;       // 0-1 (0 = fully inserted, 1 = fully withdrawn)
  controlRodWorth: number;          // Total reactivity worth when fully inserted

  // Decay heat (fraction of nominal power)
  decayHeatFraction: number;        // Computed from operating history

  // SCRAM state
  scrammed: boolean;
  scramTime: number;                // Simulation time when SCRAM occurred
  scramReason: string;              // Reason for the SCRAM

  // Reactivity breakdown (for debugging)
  reactivityBreakdown: {
    controlRods: number;            // Reactivity from control rods
    doppler: number;                // Fuel temperature feedback
    coolantTemp: number;            // Coolant temperature feedback
    coolantDensity: number;         // Coolant density feedback
  };

  // Diagnostic values (for debugging feedback calculations)
  diagnostics: {
    fuelTemp: number;               // Current average fuel temperature (K)
    coolantTemp: number;            // Current average coolant temperature (K)
    coolantDensity: number;         // Current average coolant density (kg/m³)
  };
}

// ============================================================================
// Energy Balance Diagnostics
// ============================================================================

export interface EnergyDiagnostics {
  // Total energy in system
  totalFluidEnergy: number;         // J - sum of all flow node internal energies
  totalSolidEnergy: number;         // J - sum of all thermal node energies (m*cp*T)

  // Heat transfer rates (W)
  heatTransferRates: Map<string, number>;  // Connection ID -> heat rate (W)

  // Key flows for display
  fuelToCoreCoolant: number;        // W - heat from fuel to core coolant
  coreCoolantToSG: number;          // W - heat from SG primary to secondary
  sgToSecondary: number;            // W - heat from SG tubes to secondary side

  // Energy added/removed this timestep
  heatGenerationTotal: number;      // W - total fission + decay heat
  advectedEnergy: number;           // J - energy moved by flow this timestep
}

// ============================================================================
// Complete Simulation State
// ============================================================================

export interface SimulationState {
  time: number;                     // s - simulation time

  // Node collections
  thermalNodes: Map<string, ThermalNode>;
  flowNodes: Map<string, FlowNode>;

  // Connections
  thermalConnections: ThermalConnection[];
  convectionConnections: ConvectionConnection[];
  flowConnections: FlowConnection[];

  // Reactor physics
  neutronics: NeutronicsState;

  // Component states (valves, pumps, etc.)
  components: ComponentStates;

  // Energy balance diagnostics (populated by operators)
  energyDiagnostics?: EnergyDiagnostics;

  // Pressure model diagnostics (populated by FluidStateOperator)
  // Maps flow node ID to the base pressure used for pressure feedback calculation
  liquidBasePressures?: Map<string, number>;
}

export interface ComponentStates {
  pumps: Map<string, PumpState>;
  valves: Map<string, ValveState>;
  checkValves: Map<string, CheckValveState>;
}

export interface PumpState {
  id: string;
  running: boolean;
  speed: number;                    // 0-1 target speed (setpoint)
  effectiveSpeed: number;           // 0-1 actual current speed (after ramp/coast)
  ratedHead: number;                // m - head at rated conditions
  ratedFlow: number;                // kg/s - flow at rated conditions
  efficiency: number;               // 0-1 - pump efficiency for work calculation
  connectedFlowPath: string;        // Flow connection ID this pump drives
  rampUpTime: number;               // seconds - time to reach full speed from stopped
  coastDownTime: number;            // seconds - time to coast to stop when tripped
}

export interface ValveState {
  id: string;
  position: number;                 // 0 = closed, 1 = fully open
  failPosition: number;             // Position on loss of power/signal
  connectedFlowPath: string;        // Flow connection ID
}

export interface CheckValveState {
  id: string;
  connectedFlowPath: string;        // Flow connection ID
  crackingPressure: number;         // Pa - minimum forward ΔP to open (typically 5-50 kPa)
  // Check valves are passive - they open when forward pressure exceeds crackingPressure,
  // and close when flow reverses. No position tracking needed.
}

// ============================================================================
// Simulation Configuration
// ============================================================================

export interface SimulationConfig {
  // Pressure model for liquid phase
  pressureModel: 'hybrid' | 'pure-triangulation';
}

// Global simulation configuration (can be modified at runtime)
export const simulationConfig: SimulationConfig = {
  pressureModel: 'pure-triangulation'  // Default to pure triangulation
};

// ============================================================================
// Solver Performance Metrics
// ============================================================================

export interface SolverMetrics {
  // Timing
  lastStepWallTime: number;         // ms - wall clock time for last physics step
  avgStepWallTime: number;          // ms - rolling average

  // Timestep info
  currentDt: number;                // s - adaptive target timestep
  actualDt: number;                 // s - actual timestep used in last step
  dtLimitedBy: string;              // What's limiting dt: operator name, "adaptive", "remaining", or "config.maxDt"
  maxStableDt: number;              // s - stability limit from operators
  stabilityLimitedBy: string;       // Which operator is setting the stability limit
  minDtUsed: number;                // s - smallest dt used recently
  subcycleCount: number;            // Number of substeps in last frame
  totalSteps: number;               // Total simulation steps taken (cumulative)

  // Adaptive timestep info
  retriesThisFrame: number;         // Number of step retries due to state changes
  maxPressureChange: number;        // Maximum relative pressure change in last accepted step
  maxFlowChange: number;            // Maximum absolute flow rate change in last accepted step (kg/s)
  maxMassChange: number;            // Maximum relative mass change in last accepted step
  consecutiveSuccesses: number;     // Steps since last retry (for dt growth)

  // Performance ratio
  realTimeRatio: number;            // sim_time / wall_time (< 1 means falling behind)

  // Warnings
  isFallingBehind: boolean;         // True if can't keep up with real time
  fallingBehindSince: number;       // Simulation time when we started falling behind

  // Per-operator timing (for profiling)
  operatorTimes: Map<string, number>;
}
