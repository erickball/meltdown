import type { ScenarioSpec } from './simulation/scenario-types';
import type { TerrainSpec } from './terrain-types';
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

// Import GasComposition type for NCG support
import type { GasComposition } from './simulation/gas-properties';

export interface Fluid {
  temperature: number;  // Kelvin
  pressure: number;     // Pascals
  phase: 'liquid' | 'vapor' | 'two-phase';
  quality?: number;     // For two-phase: 0 = all liquid, 1 = all vapor
  flowRate: number;     // kg/s (positive = forward direction)
  separation?: number;  // Phase separation factor: 0 = fully mixed, 1 = fully separated
  // NCG (non-condensible gases) - for rendering simulation state
  ncg?: GasComposition; // mol - moles of each NCG species
  mass?: number;        // kg - total fluid mass
  volume?: number;      // m³ - the node's volume
  /**
   * The node's vapour space, m³ (simulation `FluidState.gasVolume`): the room
   * the stamped NCG moles are priced over. Absent on a construction-mode
   * fluid, whose moles were stamped over `volume` by the display fill and
   * read back over the same (colors.ts ncgPartialPressure).
   */
  gasVolume?: number;
  /**
   * Fraction of the component's height standing in liquid (0-1), copied
   * straight from the simulation node's own liquid level. The renderer
   * used to re-derive this from (quality, pressure) through the steam
   * tables, which multiplies any wobble in the mass quality by v_g/v_f -
   * ~15000 at pool conditions - so a part-in-1e5 ripple in a node's
   * specific energy showed up as a 10 cm wobble in a level readout that
   * the physics does not have. Written by syncSimulationToVisuals; absent
   * in construction mode, where fillLevel is the level.
   */
  liquidLevelFraction?: number;
  /**
   * Steam partial pressure (Pa) - the pressure the steam tables are to be
   * evaluated at for this fluid.
   *
   * It exists because `pressure` means two different things depending on who
   * wrote the object. The per-frame sync writes the simulation node's TOTAL
   * pressure (steam + NCG, Dalton); the construction-mode write-back and the
   * gas-fill display helper write the STEAM partial pressure, because that is
   * the initial-condition convention the factory reads back. With NCG moles
   * sitting on the fluid there is nothing to tell the two apart, and a
   * renderer that subtracts the NCG partial from a pressure that never
   * included it gets a negative steam pressure: a water tank holding 17 mbar
   * of steam under a bar of air read as -0.98 bar and threw out of the steam
   * tables, which killed the canvas animation loop for the rest of the
   * session.
   *
   * So every producer now states it. Renderers use this for saturation
   * lookups and `steamPressure + P_ncg` when they need the total. Absent on
   * hand-built fluids and on anything the sync has not reached, where
   * `pressure` is the only thing there is.
   */
  steamPressure?: number;
}

export type ComponentType =
  | 'tank'
  | 'pipe'
  | 'pump'
  | 'vessel'
  | 'reactorVessel'
  | 'coreBarrel'
  | 'valve'
  | 'heatExchanger'
  | 'turbine'
  | 'turbine-generator'
  | 'turbine-driven-pump'
  | 'condenser'
  | 'fuelAssembly'
  | 'controller'
  | 'switchyard'
  | 'building'
  | 'crossVessel'
  | 'pool'
  | 'warehouse'
  // Electrical distribution (only built/used when PlantState.electrical is on)
  | 'bus'
  | 'transformer'
  | 'breaker'
  | 'diesel-generator'
  | 'battery';

export interface Port {
  id: string;
  position: Point;      // Relative to component origin
  direction: 'in' | 'out' | 'both';
  connectedTo?: string; // Port ID of connected component
  /**
   * Which side of the plan footprint this nozzle stands on, when the
   * front-view position cannot say.
   *
   * `position` is a point in the component's FRONT elevation (x lateral, y
   * vertical), and the grid view normally reads the side off it: a nozzle
   * left of centre is west, one above centre is north. A nozzle pointing at
   * or away from the viewer projects onto the centreline, so its front-view
   * position is (0, y) and the reading is ambiguous - which is exactly the
   * case for the north and south side nozzles of an upright vessel or a
   * pool. Those declare their side here.
   *
   * Purely a drawing/routing statement: the physics never reads it, and the
   * stored connection elevation still follows the one convention
   * (`height/2 - port.position.y`), so a declared-side nozzle sits at the
   * same height as the east/west nozzle beside it.
   */
  planSide?: 'N' | 'E' | 'S' | 'W';
}

/**
 * A cylindrical metal surface that trades thermal radiation with another
 * component's wall across an open gas gap.
 *
 * This is the generic building block behind a reactor cavity cooling system:
 * water-filled standpipes ringing a hot vessel, taking its heat by radiation
 * with no pump, no valve and no signal in the path. It is not specific to
 * that use - anything with a wall can face anything else with a wall (a
 * shield tank around a hot pipe, a cooled liner around a furnace) - so the
 * geometry is declared here rather than inferred from the component's own
 * shape. The component's own dimensions still set its FLUID inventory; this
 * block sets the METAL that sees the other component.
 *
 * The pair is treated as concentric gray cylinders, which is the standard
 * closed-form enclosure: one surface wraps the other, and the gas between
 * them is transparent. Whichever of the two is narrower is the emitter.
 */
export interface RadiantSurface {
  /** Component whose wall node this surface exchanges radiation with. */
  facesComponentId: string;
  /** Diameter of this cylindrical surface (m). */
  diameter: number;
  /** Vertical extent of the exchange (m). */
  height: number;
  /** Emissivity of this surface (0-1). Painted/oxidised steel is ~0.9. */
  emissivity: number;
  /** Emissivity of the facing wall (0-1). Oxidised carbon steel is ~0.8. */
  facingEmissivity: number;
  /** Metal thickness (m) - sets this surface's thermal mass. */
  thickness: number;
  /**
   * Hydraulic diameter for the surface-to-fluid convection (m). A panel of
   * standpipes is lumped into one flow node, so its tube bore has to be
   * stated: the lumped node's own diameter is not a flow passage.
   * Defaults to the surface diameter.
   */
  hydraulicDiameter?: number;
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
  // Structural material of the pressure boundary. Drives creep-rupture life:
  // 'low-alloy-steel' (default), 'stainless-304', 'alloy-800h'. A hot gas duct
  // or helical SG tube bundle in a gas reactor wants 'alloy-800h' - the same
  // part in low-alloy steel ruptures in minutes at core-outlet temperature.
  // See src/simulation/materials.ts.
  material?: string;
  // A cylindrical metal surface that exchanges thermal radiation with another
  // component's wall across an open gap. See RadiantSurface.
  radiantSurface?: RadiantSurface;
  // The equipment design (component-presets.ts preset id) this part was built
  // to, when it was built from one. Set by the create dialog and by a
  // warehouse stock line; it is what makes a refund go back to the line the
  // part came out of, and what the info panel names.
  design?: string;
  /**
   * The electrical element this part is fed from: a bus or breaker for a
   * load (pump motor, motor-operated valve, controller cabinet, heaters, rod
   * drives), or the upstream element for a piece of the distribution network
   * itself (a transformer's primary, a battery's charger). Only read when
   * the plant has the electrical model on (PlantState.electrical); the wire
   * is drawn from it. See simulation/electrical.ts.
   */
  powerSupplyId?: string;
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
  pressureRating?: number;  // Design pressure (bar) - used to calculate rendered wall thickness
  /**
   * Id of a terrain water body (`PlantState.terrain.waters`) that this tank
   * IS. A sea or a lake a pump takes suction on is an ordinary tank node -
   * finite inventory, a real water surface, a nozzle to pipe to - but drawing
   * it as a steel cylinder standing on the beach is a lie. With this set, the
   * views draw no vessel at all: the blue area the terrain already paints for
   * that body is the component's picture, its nozzle is drawn at the water's
   * edge, and selecting it lights up the whole body. Nothing about the
   * physics changes.
   */
  waterBody?: string;
}

/**
 * A spent-fuel pool: a square, open, SUNKEN basin of water with racks of
 * spent fuel standing in it.
 *
 * Sunken is not a special case - `elevation` means "base above the local
 * ground" everywhere in the model, so a pool of depth D placed at grade has
 * elevation -D and its rim lands at 0. Open to the sky is not a special case
 * either: it is a vent CONNECTION from the pool's top to the environment.
 *
 * The racks are an ordinary heat structure (a ThermalNode with a fixed
 * heatGeneration and a ConvectionConnection to the pool water), so a falling
 * level uncovers them through exactly the same wetted-fraction model a
 * reactor core uses.
 */
export interface PoolComponent extends ComponentBase {
  type: 'pool';
  side: number;             // m - plan side length (square)
  depth: number;            // m - floor to rim
  wallThickness: number;    // m - concrete/liner wall
  fillLevel: number;        // 0-1 liquid VOLUME fraction (same IC convention as tanks)
  /** Total heat generated by the stored fuel (W). Constant - no decay. */
  fuelPower: number;
  assemblyCount: number;    // stored assemblies
  rodsPerAssembly: number;
  rodDiameter: number;      // mm
  cladThickness: number;    // mm
  rackHeight: number;       // m - active fuel length of a stored assembly
  rackBottomElevation: number; // m - bottom of the active fuel above the pool floor
  /** Initial rack metal temperature (K). Defaults to the water temperature. */
  rackTemperature?: number;
  /**
   * How long the stored fuel has been out of the reactor (days). Nothing in
   * the thermal model uses it - `fuelPower` is the heat, stated directly -
   * but the RADIOLOGICAL inventory has to come from somewhere, and decay
   * heat plus an age is enough to say what reactor power this fuel came off
   * and therefore how much caesium and xenon is standing in the racks.
   * Defaults to 30 days: a freshly offloaded core, which is both the worst
   * case and the reason a pool ever gets into trouble.
   */
  fuelAgeDays?: number;
  pressureRating?: number;  // bar - liner/wall rating
}

/**
 * One line of the yard's equipment list: a COUNT of one fully specified part.
 *
 * `design` is the id of a preset in src/construction/component-presets.ts.
 * A line WITH a design hands out exactly that equipment design - the player
 * gets no design choice when placing from it, because the part is already
 * built and standing in the yard. A line with NO design is generic: any
 * design of that stored type comes off it, which is what every yard held
 * before designs existed.
 *
 * The stored ComponentType is still what identifies the pile's kind, so all
 * four valve palette buttons draw on a 'valve' line and a pressurizer draws
 * on a 'tank' line.
 */
export interface StockLine {
  type: ComponentType;
  design?: string;
  count: number;
}

/**
 * What is left on the shelf. `pipeMeters` is metres of pipe (every connection
 * and every pipe component is charged its own `length`) and `pipeSpec`, when
 * set, is the ONE standardized line size that pipe is: the connection dialog
 * shows it fixed and only the route and length are the player's.
 *
 * A line that is ABSENT is out of stock, exactly as a line with 0 is - the
 * distinction would be a special case with no meaning to the player.
 */
export interface PlantStock {
  pipeMeters: number;
  /** PipeSpec id (PIPE_SPECS in component-presets.ts); absent = any size. */
  pipeSpec?: string;
  components: StockLine[];
}

/**
 * The supply yard. Non-hydraulic (no ports, no flow node, no thermal node) -
 * it exists so a level can hand the player a FINITE parts list and so that
 * list is visible on the map instead of hidden in a menu.
 *
 * A plant with no warehouse has unlimited stock: that is what every existing
 * design is, and nothing about building in one changes. See src/game/stock.ts,
 * which owns every rule about spending and refunding.
 */
export interface WarehouseComponent extends ComponentBase {
  type: 'warehouse';
  width: number;        // m - plan width (across the screen)
  depth: number;        // m - plan depth
  stock: PlantStock;
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
  // Plan polyline the pipe is drawn along in grid view (metres, grid-aligned,
  // inlet end first). Absent for pipes laid in the other views, which the
  // grid view auto-routes between position and endPosition.
  route?: Point[];
}

export interface PumpComponent extends ComponentBase {
  type: 'pump';
  diameter: number;
  running: boolean;
  speed: number;        // 0-1 (fraction of rated) - the SETPOINT, not the motor's RPM
  ratedFlow: number;    // kg/s at full speed
  ratedHead: number;    // meters of head
  /**
   * The motor's speed at 100%, RPM. Informational: `speed` is a fraction of
   * this. (Older plants stored the dialog's RPM as `speed = rpm / 3600`, so
   * an 1800 RPM pump ran at half speed and 31% of its head; the dialog now
   * keeps the two apart.)
   */
  ratedRpm?: number;
  /**
   * Height of the motor above the pump's base, m. The part of the machine
   * that drowns: standing water above it stops the pump, and a wave above it
   * carries the pump away. A horizontal pump keeps its motor at shaft height
   * (the default, DEFAULT_PUMP_MOTOR_ELEVATION); a vertical wet-pit intake
   * pump stands it on a column several metres above the bowl, which is what
   * lets the bowl sit under water.
   */
  motorElevation?: number;
  /**
   * What the casing holds when the pump is built. 'primed' (the default):
   * full of the liquid it pumps, as a commissioned plant's pumps are. 'dry':
   * air at ambient - a pump delivered from the yard and set down; it fills
   * only if its suction is flooded (a source standing higher than the
   * nozzle, or a pressurised one), and a centrifugal pump full of air can
   * neither draw water up to itself nor push it anywhere.
   */
  initialFill?: 'primed' | 'dry';
  /**
   * A non-return flap on the discharge nozzle, as vertical wet-pit pumps and
   * most service pumps carry. Without one a stopped pump is an open pipe:
   * a line from a tank standing above the pump siphons back through it (a
   * 12" line from a pool ten metres up drains ~400 kg/s through an idle
   * pump). Modelled as a check valve on the discharge line.
   */
  dischargeCheck?: boolean;
  // Which side the discharge nozzle faces. Suction is always below and the
  // motor always on top - the pump is never laid on its side. (Legacy saves
  // may carry 'bottom-top'/'top-bottom'; normalizeLoadedPlant folds those
  // into the two upright orientations on load.)
  orientation?: 'left-right' | 'right-left';  // default: left-right
  pressureRating?: number;  // Casing design pressure (bar) - sets burst point and cost
}

export interface VesselComponent extends ComponentBase {
  type: 'vessel';
  innerDiameter: number;
  wallThickness: number;
  height: number;
  hasDome: boolean;     // Hemispherical top
  hasBottom: boolean;   // Hemispherical bottom
  pressureRating?: number;  // Design pressure (bar) - used to calculate rendered wall thickness
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
  pressureRating?: number;    // Body design pressure (bar) - sets burst point and cost
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

// Reactor vessel - the outer pressure boundary containing the downcomer/annulus region
// The vessel's fluid property represents the downcomer (cold leg inlet, hot leg outlet)
// A CoreBarrel component placed inside contains the core region
export interface ReactorVesselComponent extends ComponentBase {
  type: 'reactorVessel';
  innerDiameter: number;    // Vessel inner diameter (m)
  wallThickness: number;    // Vessel wall thickness (m) - calculated from pressure
  height: number;           // Vessel height (m)
  pressureRating: number;   // Design pressure (bar)
  fillLevel?: number;       // 0-1, fraction of vessel filled with liquid
  // Core barrel geometry (for rendering - actual barrel is a separate component)
  barrelDiameter: number;   // Core barrel inner diameter (m)
  barrelThickness: number;  // Core barrel wall thickness (m)
  barrelBottomGap: number;  // Gap from lower head to barrel bottom (m)
  barrelTopGap: number;     // Gap from upper head to barrel top (m)
  // Reference to contained core barrel component
  coreBarrelId?: string;    // ID of CoreBarrel component inside this vessel
  // Legacy fields for save file migration (will be removed after migration)
  insideBarrelId?: string;  // DEPRECATED - use coreBarrelId
  outsideBarrelId?: string; // DEPRECATED - vessel itself is the downcomer now
  outsideBarrelFluid?: Fluid; // DEPRECATED - vessel.fluid is the downcomer
}

// Core barrel - placed inside a reactor vessel, contains the core region
// Flow enters from bottom (from downcomer), exits from top (to downcomer)
export interface CoreBarrelComponent extends ComponentBase {
  type: 'coreBarrel';
  innerDiameter: number;    // Barrel inner diameter (m)
  thickness: number;        // Barrel wall thickness (m)
  height: number;           // Barrel height (m)
  bottomGap: number;        // Gap from vessel bottom to barrel bottom (m)
  topGap: number;           // Gap from vessel top to barrel top (m)
  // Fuel design (drives lattice-derived reactivity coefficients when set;
  // see simulation/lattice.ts). Default 5 w/o UO2.
  enrichment?: number;      // U-235 weight fraction (e.g. 0.05)
  fuelMaterial?: 'UO2' | 'metal';
  rodDiameter?: number;     // Fuel rod diameter (mm - construction UI unit)
  cladThickness?: number;   // Cladding thickness (mm), default 0.6
  // Pebble-bed fuel (graphite-moderated, gas-cooled). When fuelForm is
  // 'pebbles', the rod fields above are ignored and the core is a packed bed
  // of graphite spheres with dispersed TRISO fuel kernels.
  fuelForm?: 'rods' | 'pebbles';
  pebbleDiameter?: number;      // Pebble diameter (mm), default 60
  pebbleCount?: number;         // Number of pebbles in the core
  heavyMetalPerPebble?: number; // Uranium loading per pebble (g), default 7
  reflectorThickness?: number;  // Graphite reflector thickness (m), default 0
  // Fuel properties
  fuelRodCount?: number;        // Number of fuel rods to display (visual, typically 8-12)
  actualFuelRodCount?: number;  // Actual number of fuel rods for simulation
  fuelTemperature?: number;     // Current fuel temperature in Kelvin
  fuelMeltingPoint?: number;    // Fuel melting point in Kelvin (default 2800)
  activeFuelHeight?: number;    // Height of active fuel region (m)
  coreBottomElevation?: number; // Elevation of core bottom above barrel bottom (m)
  // Control rod properties
  controlRodCount?: number;     // Number of control rod banks to display
  controlRodPosition?: number;  // 0 = fully inserted, 1 = fully withdrawn
  /** Installed startup neutron source, neutrons/s (0 = none). This is what a
   *  subcritical core multiplies, so it sets the shutdown power level and
   *  therefore how long a restart takes; see operators/neutronics.ts.
   *  Absent = the default installed source. */
  startupSourceNps?: number;
}

export interface HeatExchangerComponent extends ComponentBase {
  type: 'heatExchanger';
  width: number;
  height: number;
  hxType?: 'utube' | 'straight' | 'helical';  // Heat exchanger tube configuration
  tubeModel?: 'lumped' | 'moving-boundary';   // Tube-side model (see docs/otsg-moving-boundary-design.md)
  /** Number of independent tube bundles sharing this shell (default 1). Each
   *  bundle is its own flow path with its own pair of ports, its own tube
   *  metal, and - for moving-boundary tubes - its own moving partition; they
   *  share the shell-side fluid and split the shell flow between them. */
  bundleCount?: number;
  primaryFluid?: Fluid;
  secondaryFluid?: Fluid;
  /** Per-bundle tube-side fluid for rendering, index 0 = bundle 1. Present
   *  only when bundleCount > 1; primaryFluid stays the first bundle. */
  bundleFluids?: Fluid[];
  /**
   * Per-bundle moving-boundary tube partition, for painting each tube run in
   * its subcooled / boiling / superheated bands instead of one averaged
   * colour. Display-only, resynced from the simulation every frame; absent
   * for lumped tubes. `fluids` are in flow order from the inlet, and
   * `lengthFracs` sum to 1 (a section that does not exist has fraction 0).
   */
  tubeSections?: Array<{
    lengthFracs: [number, number, number];
    fluids: [Fluid, Fluid, Fluid];
  }>;
  /**
   * Marks this exchanger's SHELL as a turbine bleed point: a feedwater
   * heater. Steam piped into the shell is treated as having expanded through
   * the turbine's stages down to the shell's pressure, so it arrives with
   * the work already taken out of it (partly-expanded steam, not throttled
   * live steam) and that work counts toward the machine's output.
   *
   * `pressure` is the design bleed pressure - the shell's initial condition
   * and the sanity check; the work actually credited follows the shell's own
   * pressure, so the accounting can never disagree with the physics.
   */
  extractionSource?: { turbineId: string; pressure: number };
  tubeCount: number;
  pressureRating?: number;       // Shell-side design pressure (bar) - used to calculate shell wall thickness
  tubePressureRating?: number;   // Tube-side design pressure (bar) - used to calculate tube wall thickness
  shellPressureRating?: number;  // Shell-side design pressure (bar)
  plenumLength?: number;         // Length of tube-side plenums (semi-ellipsoid) in meters
  tubeOD?: number;               // Tube outer diameter in meters
  // Initial non-condensible fill, partial pressures in bar. `initialNcg` fills
  // the TUBE side, `shellInitialNcg` the SHELL side - a gas-cooled plant can
  // put its coolant on either side (helium in the tubes with water in the
  // shell, as in the HTGR preset, or water in the tubes with helium in the
  // shell, as in a Xe-100-style helical once-through SG).
  initialNcg?: { [species: string]: number };
  shellInitialNcg?: { [species: string]: number };
}

export interface ExtractionPort {
  id: string;              // e.g., 'extraction-1'
  pressure: number;        // Target extraction pressure in Pa
  maxFlow?: number;        // Optional max extraction flow kg/s
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
  // Sticky design point for the swallowing bound (Stodola). Stamped at
  // placement from the dialog's inlet pressure; the factory freezes it from
  // inletFluid only as a legacy fallback when absent/0.
  designInletPressure?: number; // Pa
  inletFluid?: Fluid;     // The CASING's fluid state (live; resume writes back here)
  outletFluid?: Fluid;    // Exhaust conditions
  extractionPorts?: ExtractionPort[];  // Extraction points for feedwater heating, ordered high to low pressure
  // --- Generator and rotor, read only with the electrical model on (see
  // --- simulation/electrical.ts). Absent fields take the defaults noted.
  terminalVoltage?: number;   // V - generator terminals (default 22000)
  inertiaH?: number;          // s - rotor inertia constant (default 4)
  speedGovernor?: boolean;    // default true
  speedDroop?: number;        // % - governor droop (default 5)
  overspeedTrip?: number;     // % speed - turbine trip (default 110)
  // Initial conditions (the running plant's are sim state; resume writes back)
  rotorSpeed?: number;        // fraction of rated (default 1)
  generatorOnline?: boolean;  // output breaker closed (default true)
  turbineTripped?: boolean;   // stop valves shut (default false)
  governorReset?: number;     // speed governor's reset term, valve fraction (default 0)
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
  pressureRating?: number; // Casing design pressure (bar) - sets burst point and cost
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
  fillLevel?: number;      // 0-1, fraction of shell volume filled with hotwell liquid (default 0.05)
}

// Scram setpoint configuration
export interface ScramSetpoints {
  highPower: number;      // % of nominal power (default 125)
  lowPower: number;       // % of nominal power (default 12)
  highFuelTemp: number;   // Fraction of melting point (default 0.95)
  lowCoolantFlow: number; // kg/s (default 10)
}

// Auto-tuned PID process controller configuration.
// The user states an intent (sensor, actuator, setpoint); gains are derived
// from the plant physics unless overridden. See ControllerState in
// simulation/types.ts and docs/controllers-steady-state-plan.md.
export interface PidControllerConfig {
  sensor: {
    kind: 'node-level' | 'node-pressure' | 'node-temperature' | 'connection-flow' | 'reactor-power';
    targetId: string;     // sim flow node id / connection id / '' for reactor-power
  };
  setpoint: number;       // SI units; reactor-power in fraction of nominal
  feedforward?: {
    kind: 'connection-flow';
    targetId: string;     // e.g. steam-line connection for three-element FW control
  };
  actuator: {
    kind: 'valve-position' | 'pump-speed' | 'governor-valve' | 'heater-power' | 'control-rods';
    targetId: string;     // valve/pump id, flow node id, or '' for rods
    min?: number;         // default 0
    max?: number;         // default 1 (set explicitly for heater-power, in W)
    rateLimit?: number;   // output units per second (default 0.1)
  };
  aggressiveness?: number;      // closed-loop speed knob, default 1
  powerLimit?: number;          // rod controllers: withdrawal permissive (fraction of nominal, default 1)
  invert?: boolean;             // reverse-acting loop (spray, steam relief)
  gains?: { kp: number; ki: number };  // manual override (advanced)
  mode?: 'auto' | 'manual';
  manualOutput?: number;
}

export interface ControllerComponent extends ComponentBase {
  type: 'controller';
  controllerType: 'scram' | 'pid';
  width: number;
  height: number;
  connectedCoreId?: string;  // ID of the core/reactor vessel this controller monitors (scram)
  setpoints?: ScramSetpoints; // scram controllers
  pid?: PidControllerConfig;  // pid controllers
}

// Reliability class affects likelihood of LOOP events and recovery time
export type SwitchyardReliabilityClass = 'standard' | 'enhanced' | 'highly-reliable';

export interface SwitchyardComponent extends ComponentBase {
  type: 'switchyard';
  width: number;
  height: number;
  // Transmission voltage is cosmetic - fixed at 345 kV
  transmissionVoltage: number;  // kV (display only, always 345)
  // Number of independent offsite power lines (affects LOOP probability)
  offsiteLines: number;  // 1-4, more lines = lower LOOP probability
  // Main power transformer rating - should match or exceed generator output
  transformerRating: number;  // MW
  // Reliability class affects maintenance quality, redundancy, protection schemes
  reliabilityClass: SwitchyardReliabilityClass;
  // Connected generator(s) - required for MW to grid calculation
  connectedGeneratorId?: string;  // ID of turbine-generator this feeds
  /**
   * The grid is there to draw from (electrical model only). Absent = true.
   * False is a loss of offsite power: the switchyard stops feeding the
   * plant's transformers. The generator's output is exported, not used for
   * house loads - a real unit trips its turbine on a load rejection rather
   * than islanding onto its own auxiliaries.
   */
  offsiteAvailable?: boolean;

  // === FUTURE FAILURE MODES (not yet implemented) ===
  // These comments document failure mechanisms for future implementation:
  //
  // LOOP (Loss of Offsite Power):
  //   - Grid disturbance causes all offsite lines to trip
  //   - Probability inversely related to offsiteLines count
  //   - Recovery time: 30 min to several hours
  //
  // Partial LOOP:
  //   - One or more (but not all) offsite lines trip
  //   - Plant can continue if remaining capacity sufficient
  //   - May require load reduction
  //
  // Transformer Fault:
  //   - Main power transformer failure (fire, winding fault, bushing failure)
  //   - Requires switchover to startup transformer or trip
  //   - Recovery time: days to weeks (major repair/replacement)
  //
  // Breaker Failure:
  //   - Circuit breaker fails to open on demand
  //   - Backup protection must clear fault
  //   - May cause wider outage
  //
  // Bus Fault:
  //   - Short circuit on switchyard bus
  //   - Requires fault isolation and repair
  //   - Recovery depends on fault location and damage
  //
  // Lightning Strike:
  //   - Direct strike to switchyard equipment
  //   - May cause transient trip or equipment damage
  //   - Enhanced reliability class includes better surge protection
  //
  // SBO (Station Blackout):
  //   - LOOP combined with failure of emergency diesel generators
  //   - Most severe loss of power event
  //   - Switchyard reliability affects LOOP frequency component
}

// Building/Containment - large structure that can contain other components
// Functionally similar to a tank but with different defaults and rendering
// Default: air inside, 0% fill level, low pressure rating
export interface BuildingComponent extends ComponentBase {
  type: 'building';
  // Shape and dimensions
  shape: 'cylinder' | 'rectangle';
  height: number;               // meters - total height
  // For cylinder shape
  diameter?: number;            // meters - diameter (cylindrical buildings)
  // For rectangle shape
  width?: number;               // meters - x dimension (rectangular buildings)
  length?: number;              // meters - y dimension (rectangular buildings)
  // Wall construction
  wallThickness: number;        // meters - total wall thickness
  steelFraction: number;        // 0-1 - fraction of wall that is steel (rest is concrete)
  // Pressure containment
  pressureRating: number;       // bar - design pressure (typically low, ~3-5 bar for containment)
  // Initial conditions - defaults to air at atmospheric pressure
  fillLevel: number;            // 0-1 - fraction filled with liquid (default 0)
  // NCG initial conditions (partial pressures in bar)
  // Default is atmospheric air: { N2: 0.78, O2: 0.21, Ar: 0.009 }
  initialNcg?: { [species: string]: number };
}

// Cross-vessel pipe - a structural extension of a vessel that allows a hot pipe to pass through
// The cross-vessel is a protrusion of the parent vessel's pressure boundary, containing an
// internal hot leg pipe. The space between the inner pipe and outer wall is continuous with
// the parent vessel's fluid (typically cold annulus coolant). This design keeps the pressure
// wall at cold temperature while allowing hot fluid to pass through.
// Used in SMR designs where the hot leg connects directly to an external steam generator.
export interface CrossVesselComponent extends ComponentBase {
  type: 'crossVessel';
  // Outer vessel (protrusion of parent vessel)
  outerDiameter: number;      // meters - outer diameter of the cross-vessel extension
  wallThickness: number;      // meters - wall thickness (same material as parent vessel)
  length: number;             // meters - length from parent vessel wall to target component
  // Inner hot leg pipe
  innerDiameter: number;      // meters - inner diameter of the hot leg pipe
  innerWallThickness: number; // meters - wall thickness of the inner pipe
  // Optional explicit hot-pipe length. By default the factory derives it as
  // `length` plus the radius of each vessel the inner pipe joins - the hot
  // pipe runs centerline to centerline (core outlet plenum to SG bundle
  // inlet) while the annulus spans only the wall-to-wall gap.
  innerLength?: number;       // meters
  pressureRating: number;     // bar - design pressure (should match parent vessel)
  // Connection info
  targetComponentId?: string; // ID of component this connects to (e.g., steam generator)
  // Rendering/orientation
  orientation: 'horizontal' | 'angled';  // How the cross-vessel extends from parent
  angle?: number;             // degrees from horizontal (for angled orientation)
  // Initial non-condensible fill, partial pressures in bar. A gas-cooled plant
  // runs this as a coaxial duct: hot gas down the inner pipe (`initialNcg`),
  // cold return in the annulus (`annulusInitialNcg`) keeping the pressure
  // boundary cold.
  initialNcg?: { [species: string]: number };
  annulusInitialNcg?: { [species: string]: number };
}

/**
 * Where a line meets a cross-vessel's annulus: its elevation above the
 * duct's bottom. The annulus wraps the inner pipe, so its nozzle can sit on
 * either side of the axis. The port's offset from the axis says how far off
 * (drawn under it until something is connected); the side is whichever faces
 * the line's other end - above the axis for a partner higher than the axis,
 * below otherwise.
 */
export function annulusNozzleElevation(cv: { elevation?: number; outerDiameter: number },
                                       port: { position: { y: number } }, partnerZ: number): number {
  const half = cv.outerDiameter / 2;
  const offset = Math.abs(port.position.y);
  return partnerZ > (cv.elevation ?? 0) + half ? half + offset : half - offset;
}

/**
 * The terrain water body a component is drawn as, if any (see
 * TankComponent.waterBody). One place to ask, so the renderers, the hit
 * tests and the route obstacles all agree.
 */
export function waterBodyOf(component: { type: string; waterBody?: string }): string | undefined {
  return component.type === 'tank' && component.waterBody ? component.waterBody : undefined;
}

/**
 * The ring of standpipes a tank is drawn as, if it is one: a tank that
 * declares a radiantSurface is a bank of tubes standing on a circle of that
 * surface's diameter around its own position (a reactor cavity cooling
 * panel wrapping the vessel it faces). The tank's own width only sets its
 * WATER inventory, so it is not the drawn width - see RadiantSurface.
 */
export function radiantRingOf(component: { type: string; waterBody?: string; radiantSurface?: RadiantSurface }): RadiantSurface | undefined {
  if (component.type !== 'tank' || waterBodyOf(component) !== undefined) return undefined;
  return component.radiantSurface;
}

/**
 * The plan depth (y) the painter's sort stands a component's drawing at.
 * Every drawing is a front view at its own position, except a standpipe
 * ring, which leaves out the tubes in front of the vessel it wraps: what is
 * drawn is the back half of the ring, whose tubes stand on average 2R/pi
 * behind the centre. That is what puts the ring behind a vessel at the same
 * position instead of in front of it.
 */
export function paintDepthY(component: { type: string; position: Point; waterBody?: string; radiantSurface?: RadiantSurface }): number {
  const ring = radiantRingOf(component);
  return component.position.y + (ring ? ring.diameter / Math.PI : 0);
}

/**
 * Where a pump's motor sits above its base when the pump does not say: shaft
 * height on a horizontal machine, about half a metre. See
 * PumpComponent.motorElevation for what the number does.
 */
export const DEFAULT_PUMP_MOTOR_ELEVATION = 0.5;

/** Height of a pump's motor above the pump's base, m. */
export function pumpMotorElevation(pump: { motorElevation?: number }): number {
  return pump.motorElevation ?? DEFAULT_PUMP_MOTOR_ELEVATION;
}

/**
 * The drawn height of a pump, m: the renderer's scale is diameter x 1.3 and
 * the drawing spans 2.2 scale units (motor 0.9 + coupling 0.15 + casing 0.5
 * + suction nozzle 0.35, centred at local y = 0, plus 0.3 of inlet pipe
 * below). Port elevations are pinned to this height (height/2 - port.y), so
 * the factory and the renderer both read it from here.
 */
export function pumpVisualHeight(pump: { diameter?: number }): number {
  return (pump.diameter || 0.3) * 1.3 * 2.2;
}

// ============================================================================
// Electrical distribution (see simulation/electrical.ts)
//
// None of these has ports, a flow node or a thermal node: they are wired to
// each other and to the loads by `powerSupplyId`, and the solve decides what
// is energized and how much each piece carries. Power is treated as real
// power only (no phases, no power factor - an MVA is an MW here).
// ============================================================================

/** A switchgear or motor-control-centre bus at one voltage. */
export interface BusComponent extends ComponentBase {
  type: 'bus';
  width: number;        // m - drawn lineup width
  height: number;       // m - cabinet height
  voltage: number;      // V nominal
  dc: boolean;          // a DC bus (battery-backed control power)
  /** A second feed (an emergency diesel, a bus tie). Both carry load when live. */
  backupPowerSupplyId?: string;
}

/** A step-down (or step-up) transformer, fed on its primary from `powerSupplyId`. */
export interface TransformerComponent extends ComponentBase {
  type: 'transformer';
  width: number;
  height: number;
  ratingMVA: number;
  primaryVoltage: number;   // V - must match what feeds it
  secondaryVoltage: number; // V - what it delivers
}

/** A circuit breaker: passes its feed through when closed; trips open on overload. */
export interface BreakerComponent extends ComponentBase {
  type: 'breaker';
  width: number;
  height: number;
  ratingKW: number;
  closed: boolean;          // initial position (the running plant's is sim state)
}

/** An emergency diesel generator: a source that needs a start and fuel. */
export interface DieselGeneratorComponent extends ComponentBase {
  type: 'diesel-generator';
  width: number;
  height: number;
  ratingKW: number;
  voltage: number;          // V - output (AC)
  startTime: number;        // s - start signal to carrying load
  fuelHours: number;        // h - day-tank + storage at rated load
  fuelFraction: number;     // 0-1 - fuel on hand at the start
  autoStart: boolean;       // starts by itself when a bus it feeds goes dead
  running: boolean;         // initial state
}

/** A station battery with its charger. DC out; the charger is fed from `powerSupplyId`. */
export interface BatteryComponent extends ComponentBase {
  type: 'battery';
  width: number;
  height: number;
  voltage: number;          // V - DC
  capacityKWh: number;
  dischargeKW: number;      // most the cells can deliver
  chargerKW: number;        // charger output
  chargeFraction: number;   // 0-1 - state of charge at the start
}

/**
 * Plant-wide switch for the electrical model. Off (or absent) is every plant
 * before it existed: every pump, valve and controller simply works.
 */
export interface ElectricalSettings {
  enabled: boolean;
}

export type PlantComponent =
  | TankComponent
  | PipeComponent
  | PumpComponent
  | VesselComponent
  | ReactorVesselComponent
  | CoreBarrelComponent
  | ValveComponent
  | HeatExchangerComponent
  | TurbineGeneratorComponent
  | TurbineDrivenPumpComponent
  | CondenserComponent
  | ControllerComponent
  | SwitchyardComponent
  | BuildingComponent
  | CrossVesselComponent
  | PoolComponent
  | WarehouseComponent
  | BusComponent
  | TransformerComponent
  | BreakerComponent
  | DieselGeneratorComponent
  | BatteryComponent;

export interface PlantState {
  components: Map<string, PlantComponent>;
  connections: Connection[];
  // Optional timed accident sequence shipped with a preset (see
  // simulation/scenario-types.ts); fired automatically while the plant runs.
  scenario?: ScenarioSpec;
  // Optional ground: a height field over the plan plus water bodies (see
  // terrain-types.ts). A component's `elevation` is above the local ground.
  terrain?: TerrainSpec;
  // Optional electrical power model. Off/absent = everything is powered.
  electrical?: ElectricalSettings;
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
  // Phase drawing tolerance (meters) - controls tolerance zone around liquid-vapor interface
  // Set to 0 for connections at the very bottom or top of a vessel that should
  // always draw pure liquid or vapor. If not specified, uses default based on separation.
  fromPhaseTolerance?: number;  // m - tolerance at from component connection
  toPhaseTolerance?: number;    // m - tolerance at to component connection
  // Vertical extent of the offtake opening (m) - draws average the phase
  // profile over the opening instead of sampling a point. 0/unset = point.
  fromOpeningHeight?: number;   // m - opening height at from component
  toOpeningHeight?: number;     // m - opening height at to component
  // Flow parameters (optional, used when creating simulation)
  flowArea?: number;       // m² - cross-sectional area
  length?: number;         // m - connection length
  // Plan polyline drawn by the user in grid view (metres, grid-aligned, from
  // the from-port to the to-port). Rendering only; `length` carries the
  // physical length. Absent = auto-routed on the grid.
  route?: Point[];
}

// View/camera state
export interface ViewState {
  offsetX: number;
  offsetY: number;
  zoom: number;         // pixels per meter
}
