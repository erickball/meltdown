/**
 * Generator for the Xe-100 preset (src/presets/xe100.json).
 *
 * X-energy Xe-100: 200 MWt helium-cooled pebble-bed module, 60 bar primary,
 * 260 C core inlet / 750 C core outlet, feeding a HELICAL ONCE-THROUGH steam
 * generator with WATER IN THE TUBES and HELIUM ON THE SHELL SIDE - the
 * opposite of our HTGR preset, and the arrangement that makes an SG tube leak
 * push steam INTO the primary coolant.
 *
 * Run: npx tsx scripts/gen-xe100.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Design point
// ---------------------------------------------------------------------------
const P_HE_BAR = 60;            // primary helium pressure (bar)
const T_CORE_IN = 533;          // K (260 C)
const T_CORE_OUT = 1023;        // K (750 C)
const T_SG_HE_OUT = T_CORE_IN;  // helium leaves the SG at core inlet temperature
const THERMAL_POWER = 200e6;    // W

const P_STEAM = 165e5;          // Pa - once-through SG outlet
const T_STEAM = 838;            // K (565 C) main steam
const T_FEED = 473;             // K (200 C) feedwater
const P_COND = 7000;            // Pa

// Trace steam pressure in the helium spaces. `fluid.pressure` on a gas node is
// the STEAM partial pressure; the helium is added on top of it from
// initialNcg (bar). Keep it small but nonzero - fluid.mass is water-only, so a
// helium node is "vapor at trace steam pressure + NCG".
const P_TRACE_STEAM = 700;      // Pa

const HE = { He: P_HE_BAR };

const components: Array<[string, any]> = [];
const connections: any[] = [];

function add(id: string, obj: Record<string, unknown>) {
  components.push([id, Object.assign({ id }, obj)]);
}

function ports(list: Array<[string, number, number, string?]>) {
  return list.map(([id, x, y, direction]) => ({
    id, position: { x, y }, direction: direction || 'both',
  }));
}

function connect(from: string, fromPort: string, to: string, toPort: string, opts: Record<string, number>) {
  connections.push(Object.assign({
    fromComponentId: from, fromPortId: fromPort,
    toComponentId: to, toPortId: toPort,
  }, opts));
}

// Helium fluid block for a primary-side component
function heFluid(T: number) {
  return { temperature: T, pressure: P_TRACE_STEAM, phase: 'vapor', quality: 1, flowRate: 0 };
}

// ---------------------------------------------------------------------------
// Containment / reactor building
// ---------------------------------------------------------------------------
add('bui-1', {
  type: 'building', label: 'Reactor Building',
  position: { x: 46, y: 78 }, rotation: 0, elevation: 0,
  shape: 'cylinder', height: 48, diameter: 30, wallThickness: 1.2,
  steelFraction: 0.05, pressureRating: 4, fillLevel: 0,
  ports: ports([['bui-1-north', 0, -15], ['bui-1-south', 0, 15]]),
  fluid: { temperature: 300, pressure: 101325, phase: 'vapor', quality: 1, flowRate: 0 },
  initialNcg: { N2: 0.78, O2: 0.21, Ar: 0.009 },
  nqa1: true,
});

// ---------------------------------------------------------------------------
// Reactor vessel + pebble core
// ---------------------------------------------------------------------------
add('rv-1', {
  type: 'reactorVessel', label: 'Xe-100 RPV',
  position: { x: 36, y: 78 }, rotation: 0, elevation: 0,
  innerDiameter: 4.6, wallThickness: 0.22, height: 20, pressureRating: 90,
  fillLevel: 0,
  barrelDiameter: 3.6, barrelThickness: 0.06, barrelBottomGap: 1.5, barrelTopGap: 1.5,
  coreBarrelId: 'cb-1',
  ports: ports([['rv-1-cold-leg', -2.3, 0], ['rv-1-core-in', 0, 2]]),
  fluid: heFluid(T_CORE_IN),
  nqa1: true, containedBy: 'bui-1', initialNcg: HE,
});

add('cb-1', {
  type: 'coreBarrel', label: 'Pebble Core',
  position: { x: 36, y: 78 }, rotation: 0, elevation: 1.5,
  innerDiameter: 2.4, thickness: 0.06, height: 11, bottomGap: 1.5, topGap: 1.5,
  fuelRodCount: 8, fuelTemperature: 900, fuelMeltingPoint: 2800,
  activeFuelHeight: 8.9, coreBottomElevation: 0.4,
  controlRodCount: 6, controlRodPosition: 0.85,
  initializeCritical: true, excessReactivity: 0.025,
  initialPower: THERMAL_POWER, controlRodWorth: 0.09,
  ports: ports([['cb-1-inlet', 0, 5.5], ['cb-1-outlet', 0, -5.5]]),
  fluid: heFluid(T_CORE_OUT),
  nqa1: true, containedBy: 'rv-1',
  // Xe-100 pebble: 60 mm graphite sphere, ~7 g heavy metal, 15.5% enriched
  fuelForm: 'pebbles', pebbleDiameter: 60, pebbleCount: 220000,
  heavyMetalPerPebble: 7, enrichment: 0.155,
  reflectorThickness: 1.0, thermalPower: THERMAL_POWER,
  initialNcg: HE,
});

// ---------------------------------------------------------------------------
// Steam generator: HELIUM IN THE SHELL, WATER IN THE TUBES
// ---------------------------------------------------------------------------
// The tube side runs from feedwater at the bottom to superheated steam at the
// top; the lumped node sits somewhere in between, so initialize it near the
// mean of the two. The shell side is the helium primary.
add('hx-1', {
  type: 'heatExchanger', label: 'Helical Once-Through SG',
  position: { x: 56, y: 74 }, rotation: 0, elevation: 0,
  width: 3.6, height: 14, hxType: 'helical', tubeCount: 2000,
  pressureRating: 90,          // shell (helium) design pressure
  tubePressureRating: 200,     // tube (water) design pressure
  shellPressureRating: 90,
  plenumLength: 1, tubeOD: 0.019,
  ports: ports([
    ['hx-1-tube-1', -0.6, 7],   // feedwater in (bottom)
    ['hx-1-tube-2', 0.6, -7],   // main steam out (top)
    ['hx-1-shell-1', -1.8, -6], // hot helium in (top)
    ['hx-1-shell-2', 1.8, 6],   // cold helium out (bottom)
    ['hx-1-leak', 1.8, 0],      // tube-side tap for the leak path
  ]),
  // Tube side = water/steam
  tubeFluid: {
    temperature: 640, pressure: P_STEAM, phase: 'vapor', quality: 1, flowRate: 0,
  },
  primaryFluid: {
    temperature: 640, pressure: P_STEAM, phase: 'vapor', quality: 1, flowRate: 0,
  },
  // Shell side = helium primary
  shellFluid: {
    temperature: (T_CORE_OUT + T_SG_HE_OUT) / 2,
    pressure: P_TRACE_STEAM, phase: 'vapor', quality: 1, flowRate: 0,
  },
  secondaryFluid: {
    temperature: (T_CORE_OUT + T_SG_HE_OUT) / 2,
    pressure: P_TRACE_STEAM, phase: 'vapor', quality: 1, flowRate: 0,
  },
  shellInitialNcg: HE,
  nqa1: true, containedBy: 'bui-1',
});

// ---------------------------------------------------------------------------
// Helium circulator (mounted on the cold return from the SG)
// ---------------------------------------------------------------------------
// Head is rho*g*H with the NCG density included, so a gas circulator needs a
// very large "head" in metres to make a modest pressure rise: helium at 60 bar
// / 533 K is only ~5.4 kg/m3, so 1.4 bar takes ~2600 m.
add('pump-1', {
  type: 'pump', label: 'He Circulator',
  position: { x: 47, y: 84 }, rotation: 0, elevation: 0,
  diameter: 0.9, running: true, speed: 1,
  ratedFlow: 80, ratedHead: 2600, orientation: 'left-right',
  ports: ports([['pump-1-inlet', -0.5, 0, 'in'], ['pump-1-outlet', 0.5, 0, 'out']]),
  fluid: heFluid(T_SG_HE_OUT),
  nqa1: true, containedBy: 'bui-1', initialNcg: HE, pressureRating: 200,
});

// ---------------------------------------------------------------------------
// SG tube leak path: tube side -> shell side, normally shut
// ---------------------------------------------------------------------------
// A real tube leak is a crack in a tube wall, so it connects the two SG nodes
// directly. Modelling it as a tiny normally-closed valve keeps it a generic
// building block: the scenario just drives `opening` to admit steam into the
// helium.
add('val-leak-1', {
  type: 'valve', label: 'SG Tube Leak',
  valveType: 'gate',
  position: { x: 60, y: 74 }, rotation: 0, elevation: 7,
  diameter: 0.02, opening: 0,
  ports: ports([['val-leak-1-in', -0.1, 0, 'in'], ['val-leak-1-out', 0.1, 0, 'out']]),
  fluid: { temperature: 640, pressure: P_STEAM, phase: 'vapor', quality: 1, flowRate: 0 },
  nqa1: true, containedBy: 'bui-1', pressureRating: 200,
});

// ---------------------------------------------------------------------------
// Secondary: turbine, condenser, condensate + feed pumps
// ---------------------------------------------------------------------------
add('turbine-1', {
  type: 'turbine-generator', label: 'Turbine-Generator',
  position: { x: 76, y: 74 }, rotation: 0, elevation: 0,
  width: 10, height: 3, orientation: 'left-right', stages: 1,
  running: true, power: 0,
  ratedPower: 80e6, ratedSteamFlow: 77, efficiency: 0.87,
  governorValve: 1, generatorEfficiency: 0.98,
  ports: ports([['inlet', -7, 0, 'in'], ['outlet', 7, 0, 'out']]),
  inletFluid: { temperature: T_STEAM, pressure: P_STEAM, phase: 'vapor', quality: 1, flowRate: 0 },
  nqa1: false,
});

add('condenser-1', {
  type: 'condenser', label: 'Condenser',
  position: { x: 76, y: 88 }, rotation: 0, elevation: 3,
  width: 6, height: 4,
  coolingWaterTemp: 293, coolingWaterFlow: 12000, coolingCapacity: 200e6,
  fillLevel: 0.25,
  ports: ports([['condenser-1-inlet', 0, -2], ['condenser-1-bottom', 0, 2]]),
  fluid: { temperature: 312, pressure: P_COND, phase: 'two-phase', quality: 0.5, flowRate: 0 },
  nqa1: false,
});

add('cond-pump-1', {
  type: 'pump', label: 'Condensate Pump',
  position: { x: 66, y: 92 }, rotation: 0, elevation: 0,
  diameter: 0.4, running: true, speed: 1,
  ratedFlow: 80, ratedHead: 200, orientation: 'right-left',
  ports: ports([['cond-pump-1-inlet', 0.3, 0, 'in'], ['cond-pump-1-outlet', -0.3, 0, 'out']]),
  fluid: { temperature: 312, pressure: P_COND, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: false, pressureRating: 40,
});

add('fw-pump-1', {
  type: 'pump', label: 'Feedwater Pump',
  position: { x: 60, y: 92 }, rotation: 0, elevation: 0,
  diameter: 0.4, running: true, speed: 1,
  ratedFlow: 80, ratedHead: 2100, orientation: 'right-left',
  ports: ports([['fw-pump-1-inlet', 0.3, 0, 'in'], ['fw-pump-1-outlet', -0.3, 0, 'out']]),
  fluid: { temperature: T_FEED, pressure: 2e6, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: false, pressureRating: 250,
});

add('val-fwcv-1', {
  type: 'valve', label: 'FW Check Valve',
  valveType: 'check',
  position: { x: 54, y: 92 }, rotation: 0, elevation: 0,
  diameter: 0.2, opening: 0, crackingPressure: 10000,
  ports: ports([['val-fwcv-1-in', 0.1, 0, 'in'], ['val-fwcv-1-out', -0.1, 0, 'out']]),
  fluid: { temperature: T_FEED, pressure: P_STEAM, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: true, pressureRating: 250,
});

// ---------------------------------------------------------------------------
// Pipes
// ---------------------------------------------------------------------------
function pipe(id: string, label: string, x: number, y: number, elevation: number,
              diameter: number, length: number, T: number, P: number,
              phase: string, ncg?: Record<string, number>) {
  const c: Record<string, unknown> = {
    type: 'pipe', label,
    position: { x, y }, rotation: 0, elevation,
    diameter, length,
    ports: ports([[`${id}-left`, -length / 2, 0], [`${id}-right`, length / 2, 0]]),
    fluid: { temperature: T, pressure: P, phase, quality: phase === 'liquid' ? 0 : 1, flowRate: 0 },
    nqa1: true, containedBy: 'bui-1', pressureRating: 200,
  };
  if (ncg) c.initialNcg = ncg;
  add(id, c);
}

// Hot gas duct: core outlet -> SG shell inlet
pipe('pipe-hotduct', 'Hot Gas Duct', 46, 70, 12, 1.2, 8, T_CORE_OUT, P_TRACE_STEAM, 'vapor', HE);
// Cold return: SG shell outlet -> circulator
pipe('pipe-coldleg', 'Cold Gas Duct', 52, 86, 1, 1.2, 5, T_SG_HE_OUT, P_TRACE_STEAM, 'vapor', HE);
// Circulator discharge -> vessel downcomer
pipe('pipe-pumpdisch', 'Circulator Discharge', 41, 84, 1, 1.1, 5, T_SG_HE_OUT, P_TRACE_STEAM, 'vapor', HE);
// Turbine exhaust -> condenser. Generously sized: at 0.07 bar the exhaust is
// ~2500x less dense than the main steam, so the same mass flow needs a huge
// duct (and enough residence time not to trip the throughput sanity check).
pipe('pipe-exhaust', 'Turbine Exhaust', 78, 82, 1, 2.6, 6, 312, P_COND, 'vapor');

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
// A once-through SG has no water level to hold, so the control pairing differs
// from the PWR preset: the turbine governor holds MAIN STEAM PRESSURE, and
// feedwater flow holds STEAM OUTLET TEMPERATURE (too little feed and the tube
// bundle runs away hot, too much and it floods toward saturation). Rods hold
// core outlet temperature.
function controller(id: string, label: string, x: number, y: number, pid: Record<string, unknown>) {
  add(id, {
    type: 'controller', controllerType: 'pid', label,
    position: { x, y }, rotation: 0, elevation: 0,
    width: 2.5, height: 2.5, ports: [], pid,
  });
}

controller('ctl-rods-1', 'Rod Control (Core Outlet T)', 20, 60, {
  sensor: { kind: 'node-temperature', targetId: 'cb-1' },
  setpoint: T_CORE_OUT,
  actuator: { kind: 'control-rods', targetId: '', min: 0, max: 1, rateLimit: 0.001 },
});

controller('ctl-msp-1', 'Main Steam Pressure (Governor)', 20, 67, {
  sensor: { kind: 'node-pressure', targetId: 'hx-1-tube' },
  setpoint: P_STEAM,
  invert: true,
  actuator: { kind: 'governor-valve', targetId: 'turbine-1', min: 0.02, max: 1, rateLimit: 0.05 },
});

controller('ctl-fw-1', 'Feedwater (Steam Temperature)', 20, 74, {
  sensor: { kind: 'node-temperature', targetId: 'hx-1-tube' },
  setpoint: 700,
  invert: true,
  actuator: { kind: 'pump-speed', targetId: 'fw-pump-1', min: 0.05, max: 1, rateLimit: 0.05 },
});

controller('ctl-hwl-1', 'Hotwell Level (Cond Pump)', 30, 60, {
  sensor: { kind: 'node-level', targetId: 'condenser-1' },
  setpoint: 0.8,
  invert: true,
  actuator: { kind: 'pump-speed', targetId: 'cond-pump-1', min: 0.05, max: 1, rateLimit: 0.1 },
});

// ---------------------------------------------------------------------------
// Primary loop connections (helium)
// ---------------------------------------------------------------------------
// Vessel downcomer -> core inlet (bottom), up through the pebble bed
connect('rv-1', 'rv-1-core-in', 'cb-1', 'cb-1-inlet',
  { fromElevation: 0.8, toElevation: 0, flowArea: 4.5, length: 1.5, resistanceCoeff: 3 });
// Core outlet (top) -> hot duct -> SG shell top
connect('cb-1', 'cb-1-outlet', 'pipe-hotduct', 'pipe-hotduct-left',
  { fromElevation: 11, toElevation: 0.6, flowArea: 1.1, length: 4, resistanceCoeff: 1.5 });
connect('pipe-hotduct', 'pipe-hotduct-right', 'hx-1', 'hx-1-shell-1',
  { fromElevation: 0.6, toElevation: 13, flowArea: 1.1, length: 4, resistanceCoeff: 1.5 });
// SG shell bottom -> cold duct -> circulator
connect('hx-1', 'hx-1-shell-2', 'pipe-coldleg', 'pipe-coldleg-left',
  { fromElevation: 1, toElevation: 0.6, flowArea: 1.1, length: 3, resistanceCoeff: 1.5 });
connect('pipe-coldleg', 'pipe-coldleg-right', 'pump-1', 'pump-1-inlet',
  { fromElevation: 0.6, toElevation: 0, flowArea: 1.1, length: 3, resistanceCoeff: 1.5 });
// Circulator -> vessel downcomer
connect('pump-1', 'pump-1-outlet', 'pipe-pumpdisch', 'pipe-pumpdisch-left',
  { fromElevation: 0, toElevation: 0.55, flowArea: 0.95, length: 3, resistanceCoeff: 1.5 });
connect('pipe-pumpdisch', 'pipe-pumpdisch-right', 'rv-1', 'rv-1-cold-leg',
  { fromElevation: 0.55, toElevation: 14, flowArea: 0.95, length: 3, resistanceCoeff: 1.5 });

// ---------------------------------------------------------------------------
// Secondary loop connections (water/steam)
// ---------------------------------------------------------------------------
// Feedwater into the tube bundle at the bottom
connect('val-fwcv-1', 'val-fwcv-1-out', 'hx-1', 'hx-1-tube-1',
  { fromElevation: 0, toElevation: 1, flowArea: 0.03, length: 8, resistanceCoeff: 2 });
// Main steam out of the top of the bundle to the turbine.
// In this model the turbine NODE floats near condenser pressure and the whole
// throttling drop is taken across its inlet connection, so this area is what
// sets rated steam flow - not `ratedSteamFlow`, which only caps work
// extraction. Sized for ~77 kg/s at the 165 bar design drop; a once-through
// bundle has no two-phase pool to pin its pressure, so an oversized inlet
// simply blows the tube side down to the condenser in seconds.
connect('hx-1', 'hx-1-tube-2', 'turbine-1', 'inlet',
  { fromElevation: 13, toElevation: 0, flowArea: 0.012, length: 25, resistanceCoeff: 2 });
connect('turbine-1', 'outlet', 'pipe-exhaust', 'pipe-exhaust-left',
  { fromElevation: 0, toElevation: 0.8, flowArea: 0.5, length: 3 });
connect('pipe-exhaust', 'pipe-exhaust-right', 'condenser-1', 'condenser-1-inlet',
  { fromElevation: 0.8, toElevation: 4, flowArea: 0.5, length: 3 });
connect('condenser-1', 'condenser-1-bottom', 'cond-pump-1', 'cond-pump-1-inlet',
  { fromElevation: 0.1, toElevation: 0, flowArea: 0.2, length: 4 });
connect('cond-pump-1', 'cond-pump-1-outlet', 'fw-pump-1', 'fw-pump-1-inlet',
  { fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 4 });
connect('fw-pump-1', 'fw-pump-1-outlet', 'val-fwcv-1', 'val-fwcv-1-in',
  { fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 4 });

// ---------------------------------------------------------------------------
// Leak path: SG tube side -> leak valve -> SG shell side
// ---------------------------------------------------------------------------
// Small flow area: a single severed 19 mm tube is ~2.3e-4 m2 of double-ended
// area; the valve is sized for that and throttled by `opening`.
connect('hx-1', 'hx-1-leak', 'val-leak-1', 'val-leak-1-in',
  { fromElevation: 7, toElevation: 0, flowArea: 3e-4, length: 0.5, resistanceCoeff: 2 });
connect('val-leak-1', 'val-leak-1-out', 'hx-1', 'hx-1-shell-1',
  { fromElevation: 0, toElevation: 7, flowArea: 3e-4, length: 0.5, resistanceCoeff: 2 });

// ---------------------------------------------------------------------------
const out = { components, connections };
const target = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${target}: ${components.length} components, ${connections.length} connections`);
