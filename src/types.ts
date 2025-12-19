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
  | 'valve'
  | 'heatExchanger'
  | 'turbine'
  | 'condenser'
  | 'fuelAssembly';

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
  ports: Port[];
  fluid?: Fluid;        // Current fluid state inside
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
  // Pipes are drawn from position along rotation direction
}

export interface PumpComponent extends ComponentBase {
  type: 'pump';
  diameter: number;
  running: boolean;
  speed: number;        // 0-1 (fraction of rated)
  ratedFlow: number;    // kg/s at full speed
  ratedHead: number;    // meters of head
}

export interface VesselComponent extends ComponentBase {
  type: 'vessel';
  innerDiameter: number;
  wallThickness: number;
  height: number;
  hasDome: boolean;     // Hemispherical top
  hasBottom: boolean;   // Hemispherical bottom
  // Fuel properties (for reactor vessels)
  fuelRodCount?: number;      // Number of fuel rods to display
  fuelTemperature?: number;   // Current fuel temperature in Kelvin
  fuelMeltingPoint?: number;  // Fuel melting point in Kelvin (default 2800)
  // Control rod properties
  controlRodCount?: number;   // Number of control rod banks to display
  controlRodPosition?: number; // 0 = fully inserted, 1 = fully withdrawn
}

export interface ValveComponent extends ComponentBase {
  type: 'valve';
  diameter: number;
  opening: number;      // 0 = closed, 1 = fully open
  valveType: 'gate' | 'globe' | 'check' | 'relief';
}

export interface HeatExchangerComponent extends ComponentBase {
  type: 'heatExchanger';
  width: number;
  height: number;
  primaryFluid?: Fluid;
  secondaryFluid?: Fluid;
  tubeCount: number;
}

export type PlantComponent =
  | TankComponent
  | PipeComponent
  | PumpComponent
  | VesselComponent
  | ValveComponent
  | HeatExchangerComponent;

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
}

// View/camera state
export interface ViewState {
  offsetX: number;
  offsetY: number;
  zoom: number;         // pixels per meter
}
