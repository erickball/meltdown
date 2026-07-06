/**
 * Simulation State Types
 *
 * The simulation uses a node-based approach where the plant is discretized
 * into thermal nodes (solid materials) and flow nodes (fluid volumes).
 * These are connected via heat transfer and flow connections.
 */

import type { GasComposition } from './gas-properties';

// ============================================================================
// Fluid Properties
// ============================================================================

export interface FluidState {
  // CONSERVED QUANTITIES (primary state variables)
  mass: number;           // kg - total fluid mass in this node
  internalEnergy: number; // J - total internal energy in this node

  // DERIVED QUANTITIES (computed from mass, energy, and volume)
  temperature: number;    // K
  pressure: number;       // Pa - total pressure (steam + NCG partial pressures)
  phase: 'liquid' | 'vapor' | 'two-phase';
  quality: number;        // Vapor mass fraction (0-1), only meaningful for two-phase

  // NON-CONDENSIBLE GASES (optional)
  // When present, total pressure = steam partial pressure + NCG partial pressure
  // Steam partial pressure is computed from steam tables as before
  // NCG partial pressure = n_ncg * R * T / V_vapor (Dalton's law)
  ncg?: GasComposition;   // mol - moles of each NCG species in this node
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

  // Cladding oxidation state (only for cladding nodes)
  // Zr + 2H₂O → ZrO₂ + 2H₂ (exothermic: 586 kJ/mol Zr)
  // Tracks oxidation progress and H₂ generation
  oxidation?: {
    oxidizedFraction: number;       // 0-1 - fraction of cladding that has oxidized
    totalZrMass: number;            // kg - total Zr mass available for oxidation
    associatedCoolantNode: string;  // FlowNode ID where H₂ is released
  };
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

  // Containment hierarchy
  // Every flow node must be "inside" something else - either another node or atmosphere
  // If containerId is undefined/null, this node is exposed to atmosphere
  // When a node ruptures, fluid escapes to its container (or atmosphere)
  // Air ingress can occur through connections to atmospheric nodes
  containerId?: string;             // ID of containing FlowNode (undefined = atmosphere)

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

  // Governor valve for turbines (0-1)
  // 0 = fully closed, 1 = fully open
  // Affects flow resistance into the turbine
  governorValve?: number;

  // Electric heater power currently deposited into this node's fluid (W).
  // Generic - any tank can have heaters (pressurizer heaters being the
  // canonical use). Set by a heater-power controller actuator (or the user);
  // deposited as dEnergy by HeatGenerationRateOperator.
  heaterPower?: number;
  // Installed heater capacity (W) - upper bound for heater actuators.
  heaterCapacity?: number;

  // Internal obstructions that reduce available cross-sectional area at certain elevations
  // Used for accurate liquid level calculation when components are inside this node
  // (e.g., a core barrel inside a reactor vessel annulus)
  internalObstructions?: Array<{
    bottomElevation: number;        // m - elevation of bottom of obstruction (relative to node bottom)
    topElevation: number;           // m - elevation of top of obstruction
    crossSectionalArea: number;     // m² - area occupied by the obstruction
  }>;

  // Boundary condition flag
  // If true, this node's fluid state is fixed and should not be updated by physics operators
  // Used for atmosphere and other infinite reservoirs
  isBoundary?: boolean;

  // Turbine extraction port properties (only for extraction nodes)
  extractionPressure?: number;        // Pa - target extraction pressure for this port
  parentTurbineId?: string;           // ID of the parent turbine component
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
  surfaceArea: number;              // m² - total wetted surface area (when fully submerged)
  // Heat transfer coefficient computed dynamically based on flow

  // Tube/rod geometry for liquid-level-dependent heat transfer
  // If specified, effective surface area scales with liquid level
  // Surface area is assumed uniformly distributed over the height
  tubeBottomElevation?: number;     // m - bottom of tubes/rods relative to flow node bottom
  tubeHeight?: number;              // m - vertical extent of tubes/rods
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

  // Phase drawing tolerance for two-phase nodes (meters)
  // Controls the tolerance zone around the liquid-vapor interface.
  // A connection within this distance of the interface draws mixture.
  // Set to 0 for connections at the very bottom or top of a vessel that should
  // always draw pure liquid or vapor regardless of calculated interface position.
  // If not specified, uses default tolerance based on separation factor.
  fromPhaseTolerance?: number;      // m - tolerance at fromNode connection
  toPhaseTolerance?: number;        // m - tolerance at toNode connection

  // Flow resistance (K-factor for pressure drop)
  resistanceCoeff: number;          // ΔP = K * 0.5 * ρ * v²

  // Check valve - allows flow only in forward direction (from -> to)
  hasCheckValve?: boolean;          // If true, prevents reverse flow

  // LOCA (Loss of Coolant Accident) - pipe break
  breakFraction?: number;           // 0-1, fraction of flow area that is broken (0 = no break)
  breakDischargeCoeff?: number;     // Discharge coefficient for break flow (default 0.6)

  // Break connection metadata (set when component bursts)
  isBreakConnection?: boolean;      // True if this is a burst-created connection
  burstSourceNodeId?: string;       // Which node burst to create this connection
  breakDirection?: number;          // Radians - direction of break for rendering (0 = right, π/2 = down)

  // Current flow state (computed by solver)
  massFlowRate: number;             // kg/s (positive = from -> to)
  currentFlowPhase?: 'liquid' | 'vapor' | 'mixture';  // What phase is currently flowing

  // Target flow rate (computed from pressure balance, for debugging)
  targetFlowRate?: number;          // kg/s - what flow would be at equilibrium

  // Steady-state flow (what flow would be without momentum effects)
  steadyStateFlow?: number;         // kg/s - instantaneous flow from pressure balance

  // Flow momentum (for inertial effects)
  inertance?: number;               // m⁻¹ - L/A ratio (length/area)
  // Note: inertance = length / flowArea
  // The momentum equation: ρ * inertance * d(flow)/dt = ΔP

  // Choked flow state (computed by flow operator)
  isChoked?: boolean;               // True if flow is limited by sonic velocity
  machNumber?: number;              // Mach number (velocity / sound speed)

  // === Debug fields (populated by momentum operator for display) ===
  // These are for debugging only and may not always be present
  debug?: {
    flowPhase: 'liquid' | 'vapor' | 'mixture';  // What phase is flowing
    rho_flow: number;               // kg/m³ - density of flowing phase
    dP_driving: number;             // Pa - total driving pressure (pressure + gravity + pump)
    dP_friction: number;            // Pa - friction pressure drop (always opposes flow)
    dP_net: number;                 // Pa - net accelerating pressure
    dMassFlowRate: number;          // kg/s² - acceleration rate
    isChoked?: boolean;             // True if flow is choked (sonic velocity)
    machNumber?: number;            // Mach number (v/c)
  };
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

  // Built-in positive reactivity margin (enrichment excess) so criticality
  // sits at partial rod insertion. Without it, rods-fully-withdrawn is
  // exactly critical at reference conditions and a rod controller has no
  // authority to raise power. Default 0 preserves legacy behavior.
  excessReactivity?: number;        // Δk/k, >= 0

  // Decay heat (fraction of nominal power)
  decayHeatFraction: number;        // Computed from operating history

  // Fission-product decay heat pools (W per group). Each group g builds up
  // toward f_g * P_fission with time constant 1/lambda_g and releases its
  // power into the fuel alongside prompt fission heat:
  //   dQ_g/dt = lambda_g * (f_g * P_fission - Q_g)
  // Thermal power deposited = (1 - sum f_g) * P_fission + sum Q_g, which
  // equals P_fission at equilibrium and ~5%/3%/1.5% of prior power at
  // 10 s / 100 s / 1000 s after shutdown (coarse ANS-5.1 fit).
  decayHeatPools?: number[];

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

  // Component burst tracking
  burstStates?: Map<string, BurstState>;
  burstConfig?: BurstConfig;
  atmosphereRelease?: AtmosphereRelease;

  // Pending events for GameLoop to emit (set by constraint operators like BurstCheckOperator)
  pendingEvents?: Array<{ type: string; message: string; data?: Record<string, unknown> }>;
}

export interface ComponentStates {
  pumps: Map<string, PumpState>;
  valves: Map<string, ValveState>;
  checkValves: Map<string, CheckValveState>;
  controllers: Map<string, ControllerState>;
}

// ============================================================================
// Process Controllers (auto-tuned PI loops)
// ============================================================================

export type ControllerSensorKind =
  | 'node-level'        // liquid level in a flow node (m from node bottom)
  | 'node-pressure'     // flow node pressure (Pa)
  | 'node-temperature'  // flow node temperature (K)
  | 'connection-flow'   // mass flow rate of a flow connection (kg/s)
  | 'reactor-power';    // neutronics power as fraction of nominal (0-1+)

export type ControllerActuatorKind =
  | 'valve-position'    // ValveState.position (0-1)
  | 'pump-speed'        // PumpState.speed target (0-1)
  | 'governor-valve'    // FlowNode.governorValve on a turbine node (0-1)
  | 'heater-power'      // FlowNode.heaterPower (W)
  | 'control-rods';     // NeutronicsState.controlRodPosition (0-1)

/**
 * A generic auto-tuned process controller: one sensor, one actuator, a
 * setpoint. Gains are derived each step from the plant's own physics
 * (see ControlSystemOperator) unless manually overridden. Controllers are
 * DEVICES, not physics: they may saturate, rate-limit, and dead-band.
 */
export interface ControllerState {
  id: string;
  label: string;
  /** 'auto' = closed loop; 'manual' = hold manualOutput (bumpless transfer back) */
  mode: 'auto' | 'manual';

  sensor: {
    kind: ControllerSensorKind;
    /** flow node id, connection id, or '' for reactor-power */
    targetId: string;
  };
  /** Setpoint in the sensor's SI units (reactor-power: fraction of nominal) */
  setpoint: number;

  /** Optional feedforward measurement (three-element control): commanded
   *  flow starts from this measured flow, PI only trims the residual.
   *  The canonical use is feedwater = steam flow + level trim. */
  feedforward?: {
    kind: 'connection-flow';
    targetId: string;
  };

  actuator: {
    kind: ControllerActuatorKind;
    /** valve id / pump id / flow node id (governor, heater) / '' for rods */
    targetId: string;
    min: number;          // output lower limit (0-1 or W)
    max: number;          // output upper limit
    rateLimit: number;    // max |d(output)/dt| in output units per second
  };

  /** Scales the closed-loop time constant: >1 faster, <1 gentler. Default 1. */
  aggressiveness: number;
  /** Reverse-acting loop (more output DECREASES the sensor reading, e.g.
   *  spray valve on pressure, steam valve on upstream pressure). */
  invert?: boolean;
  /** Manual gain override (advanced): Kp in output-units per sensor-unit,
   *  Ki in output-units per sensor-unit-second. Undefined = auto-derive. */
  gains?: { kp: number; ki: number };
  /** Output to hold in manual mode */
  manualOutput?: number;

  // ---- runtime state (updated once per accepted solver step) ----
  lastOutput: number;
  lastError: number;
  /** previous feedforward measurement (velocity-form feedforward) */
  lastFeedforward?: number;
  /** auxiliary memory (rod controller: previous reactor power for the
   *  withdrawal-inhibit period estimate) */
  lastAux?: number;
  /** most recent auto-derived gains, for display/debugging */
  lastAutoGains?: { kp: number; ki: number };
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
  npshRequired: number;             // m - NPSH required by pump (NPSHr)
  pumpType: 'centrifugal' | 'positive';  // Type affects cavitation behavior
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
  // Pure triangulation interpolates pressure directly from steam tables in (u,v) space.
  // The 'hybrid' model is OBSOLETE - it was an attempt to use bulk modulus for pressure
  // feedback but the implementation in FluidStateConstraintOperator was broken and never
  // properly matched FluidStateUpdateOperator. Use pure-triangulation for accurate physics.
  pressureModel: 'pure-triangulation'
};

// ============================================================================
// Semi-Implicit Pressure Solver Configuration
// ============================================================================

/**
 * Configuration for the semi-implicit pressure-flow solver.
 *
 * The pressure solver removes acoustic (water-hammer) stiffness from liquid nodes
 * by directly solving the linearized pressure-flow coupling once per constraint
 * application and correcting connection flow rates toward mass balance. The
 * correction strength scales continuously with node stiffness (bulk modulus /
 * volume), so non-stiff nodes are left to the explicit RK45 physics.
 */
export interface PressureSolverConfig {
  /** Maximum numerical bulk modulus in Pa (undefined = use physical value).
   *  Setting this caps how stiff the pressure response can be. At K_max = 200 MPa,
   *  a 0.01% density error causes ~20 bar pressure change instead of ~220 bar. */
  K_max?: number;
  /** Fully implicit momentum (RELAP-style semi-implicit pressure-flow solve).
   *
   *  When true, the pressure solver performs the complete backward-Euler
   *  momentum update: end-of-step connection flows are solved simultaneously
   *  with the virtual pressure corrections, with the explicit driving
   *  pressures (hydrostatic heads, gravity, pump curve, friction at the
   *  current flow) on the right-hand side. The explicit
   *  FlowMomentumRateOperator is skipped and flow momentum drops out of the
   *  RK45 error estimate, so the timestep is limited by thermal/neutronic/
   *  phase-change accuracy instead of the marginally-damped acoustic modes of
   *  liquid loops. Backward Euler's damping vanishes as dt -> 0, so capping
   *  maxDt still recovers water-hammer physics.
   *
   *  When false, the solver only corrects flows toward mass balance (the
   *  momentum leg stays explicit in RK45) - the legacy half-implicit scheme. */
  implicitMomentum?: boolean;
}

/** Default configuration for pressure solver */
export const DEFAULT_PRESSURE_SOLVER_CONFIG: PressureSolverConfig = {
  K_max: undefined,  // Physical K - the direct solve doesn't need a cap for stability
  // Fully implicit momentum is the default (18-38x realtime on the reactor
  // presets vs <1x explicit, with end states matching the explicit reference
  // to ~0.1-1%). The explicit path stays selectable in the UI and via
  // IMPLICIT_MOMENTUM=0 in the test harnesses for water-hammer studies and as
  // the reference implementation. See docs/semi-implicit-flow-solver-plan.md.
  implicitMomentum: true,
};

// ============================================================================
// Solver Performance Metrics
// ============================================================================

/** Describes what's contributing most to timestep-limiting error */
export interface ErrorContributor {
  nodeId: string;           // Component/node ID
  type: 'mass' | 'energy' | 'throughput' | 'momentum' | 'temperature' | 'power' | 'precursor';
  contribution: number;     // Relative contribution to total error (0-1)
  description: string;      // Human-readable description
}

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

  // Error contributors - top sources of RK45 error
  topErrorContributors: ErrorContributor[];

  // Performance ratio
  realTimeRatio: number;            // sim_time / wall_time (< 1 means falling behind)

  // Warnings
  isFallingBehind: boolean;         // True if can't keep up with real time
  fallingBehindSince: number;       // Simulation time when we started falling behind

  // Per-operator timing (for profiling)
  operatorTimes: Map<string, number>;

  // Last simulation time when metrics were computed (for detecting historical state viewing)
  lastSimTime: number;              // s - simulation time when these metrics were captured
}

// ============================================================================
// Component Burst State
// ============================================================================

/**
 * Tracks burst status for a pressurized component.
 * Burst pressure = design rating + random 0-40% margin.
 * Collapse pressure = calculated from geometry (buckling under external pressure).
 * Break size scales with overpressure: 1% at burst, ~20% at 1.5x, cap at 100%.
 */
export interface BurstState {
  nodeId: string;                    // FlowNode ID
  componentId: string;               // Plant component ID (for rendering/events)
  componentLabel: string;            // Human-readable name

  // Calculated at simulation start
  designPressure: number;            // Pa - component's pressure rating (internal)
  burstPressure: number;             // Pa - actual burst pressure (design + random margin)
  collapsePressure: number;          // Pa - external pressure differential to cause buckling
  randomMargin: number;              // 0-0.4 - the random factor applied

  // Runtime state
  isBurst: boolean;                  // Has this component ruptured?
  isCollapse?: boolean;              // True if failure was due to external pressure (collapse)
  burstTime?: number;                // Simulation time when burst occurred
  currentBreakFraction: number;      // 0-1 current break size

  // For pipes: fractional position along length (0-1)
  breakLocation?: number;

  // Elevation of break relative to component bottom (m)
  // Calculated at burst time based on component height and seed
  breakElevation?: number;

  // For HX tube-side: track shell node for differential pressure
  isTubeSide?: boolean;
  shellNodeId?: string;

  // Random seed for deterministic break size variation
  breakSizeSeed: number;
}

/**
 * Configuration for burst mechanics.
 */
export interface BurstConfig {
  minBreakFraction: number;          // Break size at burst pressure (default 0.01 = 1%)
  maxBreakFraction: number;          // Maximum break size (default 1.0 = 100%)
  fullBreakOverpressure: number;     // Overpressure ratio for max break (default 0.5 = 1.5x)
  breakSizeRandomness: number;       // Random variation factor (default 0.3 = ±30%)
  breakDischargeCoeff: number;       // Discharge coefficient (default 0.62)
}

export const DEFAULT_BURST_CONFIG: BurstConfig = {
  minBreakFraction: 0.01,            // 1% at burst pressure
  maxBreakFraction: 1.0,             // Can reach full guillotine break
  fullBreakOverpressure: 0.5,        // 100% break at 1.5x burst pressure
  breakSizeRandomness: 0.3,          // ±30% random variation
  breakDischargeCoeff: 0.62,         // Sharp-edged orifice
};

/**
 * Tracks mass/energy released to atmosphere from LOCAs.
 */
export interface AtmosphereRelease {
  totalMass: number;                 // kg released
  totalEnergy: number;               // J released
  steamMass: number;                 // kg of steam released
  liquidMass: number;                // kg of liquid released
}
