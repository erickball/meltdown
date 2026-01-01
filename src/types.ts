// Physical units (all SI)
// Temperature: Kelvin (display as Celsius)
// Pressure: Pascals
// Length: meters
// Flow: kg/s
// Power: Watts

export interface Point {
  x: number;
  y: number;
}

export interface Fluid {
  temperature: number;  // Kelvin
  pressure: number;     // Pascals
  phase: 'liquid' | 'vapor' | 'two-phase';
  quality?: number;     // For two-phase: 0 = all liquid, 1 = all vapor
  flowRate: number;     // kg/s (positive = forward direction)
}

export type ComponentType =
  | 'tank'
  | 'pipe'
  | 'pump'
  | 'vessel'
  | 'reactorVessel'
  | 'valve'
  | 'heatExchanger'
  | 'turbine'
  | 'turbine-generator'
  | 'turbine-driven-pump'
  | 'condenser'
  | 'fuelAssembly'
  | 'controller';

export interface Port {
  id: string;
  position: Point;      // Relative to component origin
  direction: 'in' | 'out' | 'both';
  connectedTo?: string; // Port ID of connected component
}

export interface ComponentBase {
  id: string;
  type: ComponentType;
  label?: string;       // Human-readable name for display
  position: Point;      // World position (meters, but we'll scale for display)
  rotation: number;     // Radians
  elevation?: number;   // Height above ground in meters
  ports: Port[];
  fluid?: Fluid;        // Current fluid state inside
  // Containment - ID of component that contains this one (e.g., tank, containment building)
  // Used for: heat transfer (outer surface connects to container fluid),
  // burst location (rupture connects to container instead of atmosphere),
  // volume reduction (component displaces container fluid)
  // NOTE: When implementing burst pressure, use GAUGE pressure relative to container!
  // A component inside another only bursts when (inner pressure - container pressure) > burst rating.
  // This means a pipe inside a pressurized containment can withstand higher absolute pressure.
  containedBy?: string;
  // Simulation linkage
  simNodeId?: string;   // Links to simulation FlowNode
  simPumpId?: string;   // Links to simulation PumpState
  simValveId?: string;  // Links to simulation ValveState
}

export interface TankComponent extends ComponentBase {
  type: 'tank';
  width: number;        // meters
  height: number;       // meters
  wallThickness: number;
  fillLevel: number;    // 0-1
}

export interface PipeComponent extends ComponentBase {
  type: 'pipe';
  diameter: number;     // meters (inner)
  thickness: number;    // wall thickness
  length: number;       // meters
  pressureRating?: number;  // Design pressure (bar) - for rupture calculations
  // Endpoint positions for 3D rendering
  // Start point uses position (x, y) and elevation from ComponentBase
  // End point has its own position and elevation
  endPosition?: Point;      // World position of pipe outlet end
  endElevation?: number;    // Elevation of pipe outlet end (meters)
}

export interface PumpComponent extends ComponentBase {
  type: 'pump';
  diameter: number;
  running: boolean;
  speed: number;        // 0-1 (fraction of rated)
  ratedFlow: number;    // kg/s at full speed
  ratedHead: number;    // meters of head
  orientation?: 'left-right' | 'right-left';  // Outlet direction (default: left-right)
}

export interface VesselComponent extends ComponentBase {
  type: 'vessel';
  innerDiameter: number;
  wallThickness: number;
  height: number;
  hasDome: boolean;     // Hemispherical top
  hasBottom: boolean;   // Hemispherical bottom
  // Fuel properties (for reactor vessels)
  fuelRodCount?: number;        // Number of fuel rods to display (visual, typically 8-12)
  actualFuelRodCount?: number;  // Actual number of fuel rods for simulation
  fuelTemperature?: number;     // Current fuel temperature in Kelvin
  fuelMeltingPoint?: number;    // Fuel melting point in Kelvin (default 2800)
  // Control rod properties
  controlRodCount?: number;   // Number of control rod banks to display
  controlRodPosition?: number; // 0 = fully inserted, 1 = fully withdrawn
}

export interface ValveComponent extends ComponentBase {
  type: 'valve';
  diameter: number;
  opening: number;      // 0 = closed, 1 = fully open
  valveType: 'gate' | 'globe' | 'ball' | 'butterfly' | 'check' | 'relief' | 'porv';
  // Check valve properties
  crackingPressure?: number;  // Pa - minimum ΔP to open (check valves)
  // Relief valve / PORV properties
  setpoint?: number;          // Pa - pressure at which valve opens
  blowdown?: number;          // fraction - pressure drop before reseating (e.g., 0.05 = 5%)
  capacity?: number;          // kg/s - maximum flow at rated pressure
  // PORV-specific properties
  controlMode?: 'auto' | 'open' | 'closed';  // Manual override mode
  hasBlockValve?: boolean;    // Has upstream isolation valve
}

// Reactor vessel with core barrel - creates two concentric hydraulic regions
export interface ReactorVesselComponent extends ComponentBase {
  type: 'reactorVessel';
  innerDiameter: number;    // Vessel inner diameter (m)
  wallThickness: number;    // Vessel wall thickness (m) - calculated from pressure
  height: number;           // Vessel height (m)
  pressureRating: number;   // Design pressure (bar)
  // Core barrel properties
  barrelDiameter: number;   // Core barrel inner diameter (m)
  barrelThickness: number;  // Core barrel wall thickness (m)
  barrelBottomGap: number;  // Gap from lower head to barrel bottom (m)
  barrelTopGap: number;     // Gap from upper head to barrel top (m)
  // Internal region IDs (created automatically)
  insideBarrelId?: string;  // ID of inside-barrel region (for flow connections)
  outsideBarrelId?: string; // ID of outside-barrel region (for flow connections)
  // Core component ID if one is placed inside
  coreId?: string;
  // Fuel properties (added when core is placed inside)
  fuelRodCount?: number;        // Number of fuel rods to display (visual, typically 8-12)
  actualFuelRodCount?: number;  // Actual number of fuel rods for simulation
  fuelTemperature?: number;     // Current fuel temperature in Kelvin
  fuelMeltingPoint?: number;    // Fuel melting point in Kelvin
  // Control rod properties (added when core is placed inside)
  controlRodCount?: number;     // Number of control rod banks to display
  controlRodPosition?: number;  // 0 = fully inserted, 1 = fully withdrawn
}

export interface HeatExchangerComponent extends ComponentBase {
  type: 'heatExchanger';
  width: number;
  height: number;
  hxType?: 'utube' | 'straight' | 'helical';  // Heat exchanger tube configuration
  primaryFluid?: Fluid;
  secondaryFluid?: Fluid;
  tubeCount: number;
}

export interface TurbineGeneratorComponent extends ComponentBase {
  type: 'turbine-generator';
  width: number;          // Length of turbine (inlet to exhaust) in meters
  height: number;         // Diameter at exhaust end in meters
  orientation: 'left-right' | 'right-left';  // Steam flow direction
  stages: number;         // Number of turbine stages
  running: boolean;
  power: number;          // Current power output in Watts
  ratedPower: number;     // Rated power output in Watts
  ratedSteamFlow: number; // Rated steam mass flow in kg/s
  efficiency: number;     // Isentropic efficiency (0-1)
  governorValve: number;  // Governor valve position (0-1)
  generatorEfficiency: number; // Generator efficiency (0-1), typically 0.98
  inletFluid?: Fluid;     // Steam inlet conditions
  outletFluid?: Fluid;    // Exhaust conditions
}

export interface TurbineDrivenPumpComponent extends ComponentBase {
  type: 'turbine-driven-pump';
  width: number;          // Length of turbine + pump assembly in meters
  height: number;         // Diameter at exhaust end in meters
  orientation: 'left-right' | 'right-left';  // Steam flow direction (pump on opposite side)
  stages: number;         // Number of turbine stages
  running: boolean;
  // Turbine properties
  ratedSteamFlow: number; // Rated steam mass flow in kg/s
  turbineEfficiency: number; // Isentropic efficiency (0-1)
  governorValve: number;  // Governor valve position (0-1)
  inletFluid?: Fluid;     // Steam inlet conditions
  outletFluid?: Fluid;    // Exhaust conditions
  // Pump properties
  pumpFlow: number;       // Current pump flow in kg/s
  ratedPumpFlow: number;  // Rated pump flow in kg/s
  ratedHead: number;      // Pump head in meters
  pumpEfficiency: number; // Pump efficiency (0-1)
}

export interface CondenserComponent extends ComponentBase {
  type: 'condenser';
  width: number;
  height: number;
  pressureRating?: number; // Design pressure in bar (condensers typically ~1.1 bar to withstand atmospheric)
  heatRejection: number;  // Current heat rejection in Watts
  coolingWaterTemp: number; // Cooling water inlet temp in K
  coolingWaterFlow: number; // Cooling water mass flow rate in kg/s
  coolingCapacity: number;  // Design heat rejection capacity in W
  tubeCount: number;
}

// Scram setpoint configuration
export interface ScramSetpoints {
  highPower: number;      // % of nominal power (default 125)
  lowPower: number;       // % of nominal power (default 12)
  highFuelTemp: number;   // Fraction of melting point (default 0.95)
  lowCoolantFlow: number; // kg/s (default 10)
}

export interface ControllerComponent extends ComponentBase {
  type: 'controller';
  controllerType: 'scram';  // For future controller types
  width: number;
  height: number;
  connectedCoreId?: string;  // ID of the core/reactor vessel this controller monitors
  setpoints: ScramSetpoints;
}

export type PlantComponent =
  | TankComponent
  | PipeComponent
  | PumpComponent
  | VesselComponent
  | ReactorVesselComponent
  | ValveComponent
  | HeatExchangerComponent
  | TurbineGeneratorComponent
  | TurbineDrivenPumpComponent
  | CondenserComponent
  | ControllerComponent;

export interface PlantState {
  components: Map<string, PlantComponent>;
  connections: Connection[];
  simTime: number;
  simSpeed: number;
  isPaused: boolean;
}

export interface Connection {
  fromComponentId: string;
  fromPortId: string;
  toComponentId: string;
  toPortId: string;
  // Connection elevations (relative to component bottom)
  fromElevation?: number;  // m - height of connection at from component
  toElevation?: number;    // m - height of connection at to component
  // Flow parameters (optional, used when creating simulation)
  flowArea?: number;       // m² - cross-sectional area
  length?: number;         // m - connection length
}

// View/camera state
export interface ViewState {
  offsetX: number;
  offsetY: number;
  zoom: number;         // pixels per meter
}
