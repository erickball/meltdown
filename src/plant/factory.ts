
import {
  TankComponent,
  PipeComponent,
  PumpComponent,
  VesselComponent,
  ValveComponent,
  HeatExchangerComponent,
  TurbineComponent,
  Fluid,
  Point,
} from '../types';

let idCounter = 0;
function generateId(prefix: string): string {
  return `${prefix}-${++idCounter}`;
}

// Default fluids at various conditions
export const COLD_WATER: Fluid = {
  temperature: 293, // 20°C
  pressure: 101325, // 1 atm
  phase: 'liquid',
  flowRate: 0,
};

export const HOT_WATER: Fluid = {
  temperature: 350, // 77°C
  pressure: 101325,
  phase: 'liquid',
  flowRate: 5,
};

export const BOILING_WATER: Fluid = {
  temperature: 373, // 100°C
  pressure: 101325,
  phase: 'two-phase',
  quality: 0.3,
  flowRate: 2,
};

export const STEAM: Fluid = {
  temperature: 450, // 177°C
  pressure: 500000, // 5 bar
  phase: 'vapor',
  flowRate: 3,
};

export const SUPERHEATED_STEAM: Fluid = {
  temperature: 600, // 327°C
  pressure: 1500000, // 15 bar
  phase: 'vapor',
  flowRate: 5,
};

export const PWR_COOLANT: Fluid = {
  temperature: 580, // 307°C - typical PWR hot leg
  pressure: 15500000, // 155 bar
  phase: 'liquid', // Subcooled at this pressure
  flowRate: 100,
};

export const PWR_COOLANT_COLD: Fluid = {
  temperature: 565, // 292°C - typical PWR cold leg
  pressure: 15500000,
  phase: 'liquid',
  flowRate: 100,
};

// Component factories
export function createTank(
  position: Point,
  width: number,
  height: number,
  options: Partial<TankComponent> = {}
): TankComponent {
  return {
    id: generateId('tank'),
    type: 'tank',
    position,
    rotation: 0,
    width,
    height,
    wallThickness: 0.05, // 5cm
    fillLevel: 0.8,
    ports: [
      { id: 'inlet', position: { x: 0, y: -height / 2 }, direction: 'in' },
      { id: 'outlet', position: { x: 0, y: height / 2 }, direction: 'out' },
    ],
    fluid: COLD_WATER,
    ...options,
  };
}

export function createPipe(
  position: Point,
  length: number,
  rotation: number = 0,
  options: Partial<PipeComponent> = {}
): PipeComponent {
  return {
    id: generateId('pipe'),
    type: 'pipe',
    position,
    rotation,
    diameter: 0.3, // 30cm
    thickness: 0.02, // 2cm wall
    length,
    ports: [
      { id: 'inlet', position: { x: 0, y: 0 }, direction: 'in' },
      { id: 'outlet', position: { x: length, y: 0 }, direction: 'out' },
    ],
    ...options,
  };
}

export function createPump(
  position: Point,
  options: Partial<PumpComponent> = {}
): PumpComponent {
  return {
    id: generateId('pump'),
    type: 'pump',
    position,
    rotation: 0,
    diameter: 0.8, // 80cm diameter pump
    running: true,
    speed: 1.0,
    ratedFlow: 100, // kg/s
    ratedHead: 50, // meters
    ports: [
      { id: 'suction', position: { x: -0.4, y: 0 }, direction: 'in' },
      { id: 'discharge', position: { x: 0.4, y: 0 }, direction: 'out' },
    ],
    ...options,
  };
}

export function createVessel(
  position: Point,
  innerDiameter: number,
  height: number,
  options: Partial<VesselComponent> = {}
): VesselComponent {
  const r = innerDiameter / 2;
  return {
    id: generateId('vessel'),
    type: 'vessel',
    position,
    rotation: 0,
    innerDiameter,
    wallThickness: 0.2, // 20cm thick walls (pressure vessel!)
    height,
    hasDome: true,
    hasBottom: true,
    ports: [
      { id: 'inlet', position: { x: -r - 0.2, y: -height / 4 }, direction: 'in' },
      { id: 'outlet', position: { x: r + 0.2, y: -height / 4 }, direction: 'out' },
      { id: 'bottom', position: { x: 0, y: height / 2 }, direction: 'both' },
    ],
    ...options,
  };
}

export function createValve(
  position: Point,
  rotation: number = 0,
  options: Partial<ValveComponent> = {}
): ValveComponent {
  return {
    id: generateId('valve'),
    type: 'valve',
    position,
    rotation,
    diameter: 0.3, // 30cm
    opening: 1.0, // Fully open
    valveType: 'gate',
    ports: [
      { id: 'inlet', position: { x: -0.3, y: 0 }, direction: 'in' },
      { id: 'outlet', position: { x: 0.3, y: 0 }, direction: 'out' },
    ],
    ...options,
  };
}

export function createHeatExchanger(
  position: Point,
  width: number,
  height: number,
  options: Partial<HeatExchangerComponent> = {}
): HeatExchangerComponent {
  return {
    id: generateId('hx'),
    type: 'heatExchanger',
    position,
    rotation: 0,
    width,
    height,
    tubeCount: 5,
    ports: [
      // Primary (tube side)
      { id: 'primary-in', position: { x: -width / 2, y: -height / 3 }, direction: 'in' },
      { id: 'primary-out', position: { x: -width / 2, y: height / 3 }, direction: 'out' },
      // Secondary (shell side)
      { id: 'secondary-in', position: { x: width / 2, y: height / 3 }, direction: 'in' },
      { id: 'secondary-out', position: { x: width / 2, y: -height / 3 }, direction: 'out' },
    ],
    ...options,
  };
}

export function createTurbine(
  position: Point,
  width: number,
  height: number,
  options: Partial<TurbineComponent> = {}
): TurbineComponent {
  return {
    id: generateId('turbine'),
    type: 'turbine',
    position,
    rotation: 0,
    width,
    height,
    running: true,
    power: 0,
    ratedPower: 333e6, // ~1/3 of 1000 MW thermal
    ports: [
      { id: 'inlet', position: { x: -width / 2, y: 0 }, direction: 'in' },
      { id: 'outlet', position: { x: width / 2, y: 0 }, direction: 'out' },
    ],
    ...options,
  };
}

/**
 * Create a demo plant layout that matches the simulation flow nodes exactly.
 *
 * Simulation Flow Nodes:
 * - core-coolant: Core coolant channel (inside reactor vessel)
 * - hot-leg: Hot leg pipe from core to SG
 * - sg-primary: Steam generator primary (tube) side
 * - cold-leg: Cold leg pipe from SG back to core (includes pump)
 * - pressurizer: Pressurizer (connected via surge line to hot leg)
 * - sg-secondary: Steam generator secondary (shell) side
 *
 * Flow Path: core-coolant → hot-leg → sg-primary → cold-leg → core-coolant
 *            hot-leg ↔ pressurizer (surge line)
 */
export function createDemoPlant() {
  const components = new Map();

  // =========================================================================
  // PRIMARY LOOP COMPONENTS
  // =========================================================================

  // Reactor vessel (center) - contains core-coolant flow node
  const vessel = createVessel({ x: 0, y: 0 }, 3, 8, {
    id: 'vessel-1',
    label: 'Reactor Vessel',
    fluid: { ...PWR_COOLANT },
    simNodeId: 'core-coolant',
    fuelRodCount: 8,
    fuelTemperature: 900,
    fuelMeltingPoint: 2800,
    controlRodCount: 3,
    controlRodPosition: 0.97,
  });
  components.set(vessel.id, vessel);

  // Hot leg pipe (core outlet to SG inlet)
  const hotLeg = createPipe({ x: 1.7, y: -2 }, 4.0, 0, {
    id: 'hot-leg-pipe',
    label: 'Hot Leg',
    fluid: { ...PWR_COOLANT },
    diameter: 0.7,
    thickness: 0.05,
    simNodeId: 'hot-leg',
  });
  components.set(hotLeg.id, hotLeg);

  // Steam generator (right side) - primary side is sg-primary
  const steamGen = createHeatExchanger({ x: 8, y: -2 }, 2.5, 6, {
    id: 'sg-1',
    label: 'Steam Generator',
    primaryFluid: { ...PWR_COOLANT },
    secondaryFluid: { ...STEAM },
    simNodeId: 'sg-primary',
  });
  components.set(steamGen.id, steamGen);

  // Cold leg pipe (SG outlet through pump back to core inlet)
  // This is a single simulation node that includes the pump
  const coldLeg = createPipe({ x: 8, y: 2 }, 6.3, Math.PI, {
    id: 'cold-leg-pipe',
    label: 'Cold Leg',
    fluid: { ...PWR_COOLANT_COLD },
    diameter: 0.7,
    thickness: 0.05,
    simNodeId: 'cold-leg',
  });
  components.set(coldLeg.id, coldLeg);

  // Reactor Coolant Pump (on cold leg, near reactor inlet)
  // Pump is on flow-coldleg-core: sucks from cold-leg, pushes into core
  const pump = createPump({ x: 1.5, y: 2 }, {
    id: 'pump-1',
    label: 'RCP',
    fluid: { ...PWR_COOLANT_COLD },
    simNodeId: 'cold-leg', // Pump is on cold leg, display its fluid state
    simPumpId: 'rcp-1',
  });
  components.set(pump.id, pump);

  // Pressurizer (connected to hot leg via surge line)
  const pressurizer = createTank({ x: 4, y: -5 }, 1.5, 3, {
    id: 'pressurizer-1',
    label: 'Pressurizer',
    fluid: {
      ...PWR_COOLANT,
      phase: 'two-phase',
      quality: 0.5,
    },
    fillLevel: 0.6,
    simNodeId: 'pressurizer',
  });
  components.set(pressurizer.id, pressurizer);

  // =========================================================================
  // SECONDARY SIDE
  // =========================================================================

  // SG Secondary side (shell side where steam is generated)
  // Represented as a tank connected to the steam generator
  const sgSecondary = createTank({ x: 11, y: -2 }, 1.5, 4, {
    id: 'sg-secondary-1',
    label: 'SG Secondary',
    fluid: {
      ...STEAM,
      phase: 'two-phase',
      quality: 0.3,
    },
    fillLevel: 0.7,
    simNodeId: 'sg-secondary',
  });
  components.set(sgSecondary.id, sgSecondary);

  // Main turbine - receives steam from SG secondary
  const turbine = createTurbine({ x: 15, y: -2 }, 3, 2, {
    id: 'turbine-1',
    label: 'Main Turbine',
    inletFluid: { ...STEAM },
    outletFluid: {
      ...STEAM,
      pressure: 500000, // 5 bar after expansion
      phase: 'two-phase',
      quality: 0.95,
    },
    simNodeId: 'turbine-inlet',
  });
  components.set(turbine.id, turbine);

  // Turbine outlet tank (simplified - represents exhaust before condenser)
  const turbineOutlet = createTank({ x: 19, y: -2 }, 1.5, 2.5, {
    id: 'turbine-outlet-1',
    label: 'Turbine Exhaust',
    fluid: {
      ...STEAM,
      pressure: 500000,
      phase: 'two-phase',
      quality: 0.95,
    },
    fillLevel: 0.5,
    simNodeId: 'turbine-outlet',
  });
  components.set(turbineOutlet.id, turbineOutlet);

  // Condenser - shell-and-tube heat exchanger where steam condenses
  const condenser = createTank({ x: 23, y: -2 }, 2.5, 2, {
    id: 'condenser-1',
    label: 'Main Condenser',
    fluid: {
      ...COLD_WATER,
      pressure: 100000, // 1 bar
      phase: 'two-phase',
      quality: 0.1,
    },
    fillLevel: 0.8,
    simNodeId: 'condenser',
  });
  components.set(condenser.id, condenser);

  // Feedwater - subcooled liquid returning to SG
  // Positioned below and to the left of condenser, heading back to SG
  const feedwater = createTank({ x: 20, y: 2 }, 1.5, 1.5, {
    id: 'feedwater-1',
    label: 'Feedwater',
    fluid: {
      ...HOT_WATER,
      temperature: 450,
      pressure: 5500000, // 55 bar
      phase: 'liquid',
    },
    fillLevel: 0.9,
    simNodeId: 'feedwater',
  });
  components.set(feedwater.id, feedwater);

  // Feedwater pump (positioned between condenser and feedwater tank)
  const fwPump = createPump({ x: 23, y: 2 }, {
    id: 'fw-pump-1',
    label: 'FW Pump',
    fluid: { ...HOT_WATER, temperature: 373, pressure: 100000 },
    simNodeId: 'feedwater',
    simPumpId: 'fw-pump',
  });
  components.set(fwPump.id, fwPump);

  // =========================================================================
  // VISUAL CONNECTIONS (showing flow paths)
  // These don't affect simulation - just for visual clarity
  // =========================================================================

  const connections = [
    // Primary loop
    { fromComponentId: 'vessel-1', fromPortId: 'outlet', toComponentId: 'hot-leg-pipe', toPortId: 'inlet' },
    { fromComponentId: 'hot-leg-pipe', fromPortId: 'outlet', toComponentId: 'sg-1', toPortId: 'primary-in' },
    { fromComponentId: 'sg-1', fromPortId: 'primary-out', toComponentId: 'cold-leg-pipe', toPortId: 'inlet' },
    { fromComponentId: 'cold-leg-pipe', fromPortId: 'outlet', toComponentId: 'vessel-1', toPortId: 'inlet' },
    // Pressurizer surge line
    { fromComponentId: 'hot-leg-pipe', fromPortId: 'outlet', toComponentId: 'pressurizer-1', toPortId: 'outlet' },
    // Secondary side - steam path (closed loop)
    { fromComponentId: 'sg-1', fromPortId: 'secondary-out', toComponentId: 'sg-secondary-1', toPortId: 'inlet' },
    { fromComponentId: 'sg-secondary-1', fromPortId: 'outlet', toComponentId: 'turbine-1', toPortId: 'inlet' },
    { fromComponentId: 'turbine-1', fromPortId: 'outlet', toComponentId: 'turbine-outlet-1', toPortId: 'inlet' },
    { fromComponentId: 'turbine-outlet-1', fromPortId: 'outlet', toComponentId: 'condenser-1', toPortId: 'inlet' },
    { fromComponentId: 'condenser-1', fromPortId: 'outlet', toComponentId: 'fw-pump-1', toPortId: 'suction' },
    { fromComponentId: 'fw-pump-1', fromPortId: 'discharge', toComponentId: 'feedwater-1', toPortId: 'inlet' },
    { fromComponentId: 'feedwater-1', fromPortId: 'outlet', toComponentId: 'sg-1', toPortId: 'secondary-in' },
  ];

  return {
    components,
    connections,
    simTime: 0,
    simSpeed: 1,
    isPaused: false,
  };
}
