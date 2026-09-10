/**
 * Generator for the Xe-100 PLANT-LAYOUT preset (src/presets/xe100-plant.json).
 *
 * The same 200 MWt helium pebble-bed module as scripts/gen-xe100.ts (which
 * stays the source of src/presets/xe100.json), rebuilt as the plant is
 * actually arranged:
 *
 *  - Everything above grade. The steam generator vessel stands on the ground
 *    floor of its own building and the reactor vessel is ELEVATED beside it,
 *    so the coaxial cross-vessel runs from low on the RPV (just under the
 *    core) into the TOP of the SG vessel.
 *  - Downward core flow. Cold helium enters the RPV at the duct elevation,
 *    climbs the downcomer to the top plenum, flows DOWN through the pebble
 *    bed and leaves the bottom of the core straight into the hot gas duct.
 *  - Two rectangular buildings sharing a wall, the cross-vessel passing
 *    through it, with a small gas path around the penetration.
 *  - Two circulators in parallel on top of the SG bundle, INSIDE the SG
 *    pressure vessel.
 *  - A steam and a feedwater isolation valve on each bundle, joining outboard
 *    common main-steam and feedwater pipes; the MSSV/dump on the steam pipe.
 *  - Feedwater-heater extraction bled from the TURBINE (an extraction port),
 *    not from the SG bundles.
 *
 * Design-point numbers, control philosophy and the safety systems are carried
 * over from gen-xe100.ts unchanged, and the long comments explaining them
 * live there - this file only explains what is DIFFERENT.
 *
 * Run: npx tsx scripts/gen-xe100-plant.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { heatExchangerPorts } from '../src/construction/construction-manager';
import { reactorBarrelExtent } from '../src/reactor-geometry';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Design point (see gen-xe100.ts)
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
const FEED_FLOW = 77;           // kg/s - design feedwater = design steam flow
const P_EXTRACTION = 25e5;      // Pa - HP heater bleed point in the turbine
const EXTRACTION_FLOW = 25;     // kg/s - what ~53 MW of heater duty costs

const P_TRACE_STEAM = 700;      // Pa - steam partial pressure in the helium spaces
const HE = { He: P_HE_BAR };
const AIR = { N2: 0.78, O2: 0.21, Ar: 0.009 };

// ---------------------------------------------------------------------------
// Elevations: the whole primary is above grade
// ---------------------------------------------------------------------------
// The SG vessel stands on the ground floor and the cross-vessel enters it
// near the top; the RPV is raised so that the same duct leaves it just under
// the core. The RCCS panels and tank keep their relative geometry from
// gen-xe100.ts (which the RCCS thermosyphon was verified with), lifted with
// the vessel.
const SG_VESSEL_HEIGHT = 18;
const SG_BUNDLE_BASE = 1.5;             // OTSG bundle stands on the vessel floor
const SG_BUNDLE_HEIGHT = 14;
const SG_BUNDLE_WIDTH = 2.8;
const SG_PLENUM = 0.8;                  // tube-side headers, below and above the bundle
const SG_BUNDLE_TOP = SG_BUNDLE_BASE + SG_BUNDLE_HEIGHT;   // 15.5 m
const DUCT_OD = 1.8;
const DUCT_CENTERLINE = SG_BUNDLE_TOP;  // hot gas enters the bundle at its top
const DUCT_BASE = DUCT_CENTERLINE - DUCT_OD / 2;           // 14.6 m
const CIRCULATOR_BASE = 16.0;           // above the bundle, under the vessel dome

// The reactor vessel and its core barrel. The barrel is placed by the SAME
// formula the vessel painter draws it with (reactor-geometry.ts): its gaps
// are measured from the inner dome surface at the barrel's radius, and a
// 4.4 m barrel in a 4.6 m vessel meets the heads 1.74 m up the curve. The
// top gap is whatever leaves an 11 m barrel, so the core-barrel component
// (whose height sets the core's volume) IS the barrel on screen and its top
// and bottom ports sit on the drawn ends.
const RPV_HEIGHT = 20;
const RPV_ID = 4.6, RPV_WALL = 0.22;
const BARREL_DIAMETER = 4.4, BARREL_THICKNESS = 0.06;
const BARREL_GAP = 1.5;                 // under the barrel
const CORE_BARREL_HEIGHT = 11;
const CORE_BOTTOM_IN_BARREL = 0.4;
const rpvGeometry = (barrelTopGap: number) => ({
  height: RPV_HEIGHT, wallThickness: RPV_WALL, innerDiameter: RPV_ID,
  barrelDiameter: BARREL_DIAMETER, barrelThickness: BARREL_THICKNESS,
  barrelBottomGap: BARREL_GAP, barrelTopGap,
});
const BARREL_TOP_GAP = reactorBarrelExtent(rpvGeometry(0)).height - CORE_BARREL_HEIGHT;
const BARREL = reactorBarrelExtent(rpvGeometry(BARREL_TOP_GAP));   // from the RPV base
// The downcomer node's volume, pinned at what the factory derived for the
// old 1.5 m / 1.5 m gaps (it takes height less both gaps when no volume is
// given), so re-seating the barrel changes the drawing and not the plant.
const RPV_DOWNCOMER_VOLUME =
  Math.PI * ((RPV_ID / 2) ** 2 - (BARREL_DIAMETER / 2 + BARREL_THICKNESS) ** 2) * (RPV_HEIGHT - 2 * 1.5);
// RPV base: raised so the duct centerline sits 0.4 m under the fuel
const RPV_LIFT = +(DUCT_CENTERLINE + 0.4 - CORE_BOTTOM_IN_BARREL - BARREL.bottom).toFixed(2);
// Sanity: the duct centerline must sit a little BELOW the core bottom
const CORE_BOTTOM_ABS = RPV_LIFT + BARREL.bottom + CORE_BOTTOM_IN_BARREL;   // ~15.9 m
if (!(DUCT_CENTERLINE < CORE_BOTTOM_ABS && DUCT_CENTERLINE > RPV_LIFT)) {
  throw new Error(`Duct centerline ${DUCT_CENTERLINE} m is not between the RPV base ${RPV_LIFT} and the core bottom ${CORE_BOTTOM_ABS}`);
}

// ---------------------------------------------------------------------------
// Plan layout (metres). The reactor building spans x 28-50, the SG building
// x 50-64; they share the wall at x = 50 and both run y 67-89.
// ---------------------------------------------------------------------------
const RX_BLDG = { x: 39, y: 78, width: 22, length: 22, height: 60 };
const SG_BLDG = { x: 57, y: 78, width: 14, length: 22, height: 26 };
const SHARED_WALL_X = RX_BLDG.x + RX_BLDG.width / 2;          // 50
if (SHARED_WALL_X !== SG_BLDG.x - SG_BLDG.width / 2) throw new Error('buildings do not share a wall');

const RPV_X = 44;
const SG_X = 55, SG_WIDTH = 4.2;
const RPV_OUTER_FACE = RPV_X + RPV_ID / 2 + RPV_WALL;          // 46.52
const SG_OUTER_FACE = SG_X - SG_WIDTH / 2;                     // 52.9
const DUCT_LENGTH = +(SG_OUTER_FACE - RPV_OUTER_FACE).toFixed(2);   // wall to wall, 6.38 m
const DUCT_X = +((RPV_OUTER_FACE + SG_OUTER_FACE) / 2).toFixed(2);
if (!(RPV_OUTER_FACE < SHARED_WALL_X && SG_OUTER_FACE > SHARED_WALL_X)) {
  throw new Error('the cross-vessel must pass through the shared wall');
}

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

function connect(from: string, fromPort: string, to: string, toPort: string, opts: Record<string, number | string>) {
  connections.push(Object.assign({
    fromComponentId: from, fromPortId: fromPort,
    toComponentId: to, toPortId: toPort,
  }, opts));
}

function heFluid(T: number) {
  return { temperature: T, pressure: P_TRACE_STEAM, phase: 'vapor', quality: 1, flowRate: 0 };
}

// ---------------------------------------------------------------------------
// Buildings: two rectangular halls sharing a wall
// ---------------------------------------------------------------------------
// A building's `fluid.pressure` is the TOTAL (the factory subtracts the air
// partials to get the steam partial) - the one component with that
// convention.
function building(id: string, label: string, b: { x: number; y: number; width: number; length: number; height: number },
                  portList: Array<[string, number, number, string?]>) {
  add(id, {
    type: 'building', label,
    position: { x: b.x, y: b.y }, rotation: 0, elevation: 0,
    shape: 'rectangle', width: b.width, length: b.length, height: b.height,
    wallThickness: 1.2, steelFraction: 0.05, pressureRating: 4, fillLevel: 0,
    ports: ports(portList),
    fluid: { temperature: 300, pressure: 101325, phase: 'vapor', quality: 1, flowRate: 0 },
    initialNcg: AIR,
    nqa1: true,
  });
}

building('bui-rx', 'Reactor Building', RX_BLDG, [
  ['bui-rx-east', RX_BLDG.width / 2, 0],       // the penetration in the shared wall
  ['bui-rx-vent-2', -8, -RX_BLDG.length / 2],  // RCCS tank relief discharge
]);
building('bui-sg', 'Steam Generator Building', SG_BLDG, [
  ['bui-sg-west', -SG_BLDG.width / 2, 0],
  ['bui-sg-vent-1', -2, -SG_BLDG.length / 2],  // primary safety valve discharge
]);

// ---------------------------------------------------------------------------
// Reactor vessel + pebble core (elevated)
// ---------------------------------------------------------------------------
// The RPV node lumps the downcomer with both plenums; the core is one
// well-mixed node. Neither carries an axial profile, so the flow direction
// through the core is set purely by how the connections below are wired.
add('rv-1', {
  type: 'reactorVessel', label: 'Xe-100 RPV',
  position: { x: RPV_X, y: 78 }, rotation: 0, elevation: RPV_LIFT,
  innerDiameter: RPV_ID, wallThickness: RPV_WALL, height: RPV_HEIGHT, pressureRating: 90,
  fillLevel: 0,
  barrelDiameter: BARREL_DIAMETER, barrelThickness: BARREL_THICKNESS,
  barrelBottomGap: BARREL_GAP, barrelTopGap: BARREL_TOP_GAP,
  volume: RPV_DOWNCOMER_VOLUME,
  coreBarrelId: 'cb-1',
  // Port y is measured down from the vessel's centre
  ports: ports([
    ['rv-1-cold-leg', -RPV_ID / 2, RPV_HEIGHT / 2 - (DUCT_CENTERLINE - RPV_LIFT)],   // annulus return, at the duct
    ['rv-1-core-in', 0, RPV_HEIGHT / 2 - (BARREL.top + BARREL_TOP_GAP / 2)],        // top plenum, over the barrel
  ]),
  fluid: heFluid(T_CORE_IN),
  nqa1: true, containedBy: 'bui-rx', initialNcg: HE,
});

add('cb-1', {
  type: 'coreBarrel', label: 'Pebble Core',
  position: { x: RPV_X, y: 78 }, rotation: 0, elevation: RPV_LIFT + BARREL.bottom,
  innerDiameter: 2.4, thickness: 0.06, height: CORE_BARREL_HEIGHT, bottomGap: BARREL_GAP, topGap: BARREL_TOP_GAP,
  fuelRodCount: 8, fuelTemperature: 900, fuelMeltingPoint: 2800,
  activeFuelHeight: 8.9, coreBottomElevation: CORE_BOTTOM_IN_BARREL,
  controlRodCount: 6, controlRodPosition: 0.85,
  initializeCritical: true, excessReactivity: 0.025,
  initialPower: THERMAL_POWER, controlRodWorth: 0.09,
  // On the barrel's ends. Helium enters the top and leaves the bottom
  // (downward core flow), but the ports are named for where they are.
  ports: ports([['cb-1-top', 0, -CORE_BARREL_HEIGHT / 2], ['cb-1-bottom', 0, CORE_BARREL_HEIGHT / 2]]),
  fluid: heFluid(T_CORE_OUT),
  nqa1: true, containedBy: 'rv-1',
  fuelForm: 'pebbles', pebbleDiameter: 60, pebbleCount: 220000,
  heavyMetalPerPebble: 7, enrichment: 0.155,
  reflectorThickness: 1.0, thermalPower: THERMAL_POWER,
  initialNcg: HE,
});

// ---------------------------------------------------------------------------
// Steam generator vessel on the ground floor, bundle inside, circulators on top
// ---------------------------------------------------------------------------
add('tank-sg-1', {
  type: 'tank', label: 'SG Vessel',
  position: { x: SG_X, y: 78 }, rotation: 0, elevation: 0,
  width: SG_WIDTH, height: SG_VESSEL_HEIGHT, wallThickness: 0.15, pressureRating: 90,
  fillLevel: 0,
  ports: ports([
    ['tank-sg-in', 1.8, 7.5],            // bundle discharge into the vessel space, low
    ['tank-sg-suction-a', -1.0, -7.5],   // circulator A suction, under the dome
    ['tank-sg-suction-b', 1.0, -7.5],    // circulator B suction
    ['tank-sg-top', 0, -SG_VESSEL_HEIGHT / 2],   // primary safety valve nozzle on the head
  ]),
  fluid: heFluid(T_CORE_IN),
  nqa1: true, containedBy: 'bui-sg', initialNcg: HE,
});

// Tube-side nozzles on the bundles' own plenums, where the construction
// manager puts them for any exchanger (heatExchangerPorts): each bundle has a
// header below (feedwater in) and above (steam out), centred on its slot.
// Port y runs down from the component's centre, so a nozzle's elevation above
// the bundle base is height/2 - y: below the base for the lower header.
const SG_TUBE_PORTS = heatExchangerPorts({
  id: 'hx-1', isVertical: true, hxType: 'helical',
  shellDiameter: SG_BUNDLE_WIDTH, shellLength: SG_BUNDLE_HEIGHT,
  plenumLength: SG_PLENUM, bundleCount: 2,
}).filter(p => p.id.includes('-tube-'));
const nozzleElevation = (portList: Array<{ id: string; position: { y: number } }>, height: number, id: string) => {
  const p = portList.find(q => q.id === id);
  if (!p) throw new Error(`no port ${id} in ${portList.map(q => q.id).join(', ')}`);
  return height / 2 - p.position.y;
};
const SG_FEED_NOZZLE = nozzleElevation(SG_TUBE_PORTS, SG_BUNDLE_HEIGHT, 'hx-1-tube-bottom');    // -0.8
const SG_STEAM_NOZZLE = nozzleElevation(SG_TUBE_PORTS, SG_BUNDLE_HEIGHT, 'hx-1-tube-top');      // 14.8

add('hx-1', {
  type: 'heatExchanger', label: 'Helical Once-Through SG',
  position: { x: SG_X, y: 78 }, rotation: 0, elevation: SG_BUNDLE_BASE,
  width: SG_BUNDLE_WIDTH, height: SG_BUNDLE_HEIGHT, hxType: 'helical', tubeCount: 300,
  tubeModel: 'moving-boundary', bundleCount: 2,
  initialSections: { pressureBar: 165, TFeedK: T_FEED, TSteamK: T_STEAM, L1: 0.25, L3: 0.35, flowKgs: FEED_FLOW / 2 },
  material: 'alloy-800h',
  pressureRating: 90, tubePressureRating: 200, shellPressureRating: 90,
  plenumLength: SG_PLENUM, tubeOD: 0.019,
  ports: [
    ...SG_TUBE_PORTS,               // hx-1-tube-bottom/-top (bundle 1), ...-b2 (bundle 2)
    ...ports([
      ['hx-1-shell-1', -1.8, -6],   // hot helium in (top, from the duct)
      ['hx-1-shell-2', 1.8, 6],     // cold helium out (bottom, to vessel space)
    ]),
  ],
  tubeFluid: { temperature: 624, pressure: P_STEAM, phase: 'two-phase', quality: 0.22, flowRate: 0 },
  primaryFluid: { temperature: 624, pressure: P_STEAM, phase: 'two-phase', quality: 0.22, flowRate: 0 },
  shellFluid: { temperature: (T_CORE_OUT + T_CORE_IN) / 2, pressure: P_TRACE_STEAM, phase: 'vapor', quality: 1, flowRate: 0 },
  secondaryFluid: { temperature: (T_CORE_OUT + T_CORE_IN) / 2, pressure: P_TRACE_STEAM, phase: 'vapor', quality: 1, flowRate: 0 },
  shellInitialNcg: HE,
  nqa1: true, containedBy: 'tank-sg-1',
});

// Two helium circulators in parallel, mounted above the bundle INSIDE the SG
// vessel: they draw from the vessel space under the dome and discharge into
// the cross-vessel annulus. Each carries half the design flow at the same
// 1.4 bar rise (2600 m of 5.4 kg/m3 helium). Each gets a discharge non-return
// flap, as parallel machines must: without one a tripped circulator is an
// open bypass through which its running twin short-circuits.
// containedBy the tank: the casings are gauged against, and would burst into,
// the vessel's own helium.
function circulator(id: string, label: string, x: number, orientation: string) {
  add(id, {
    type: 'pump', label,
    position: { x, y: 78 }, rotation: 0, elevation: CIRCULATOR_BASE,
    diameter: 0.9, running: true, speed: 1,
    ratedFlow: 40, ratedHead: 2600, orientation, dischargeCheck: true,
    ports: orientation === 'right-left'
      ? ports([[`${id}-inlet`, 0.5, 0, 'in'], [`${id}-outlet`, -0.5, 0, 'out']])
      : ports([[`${id}-inlet`, -0.5, 0, 'in'], [`${id}-outlet`, 0.5, 0, 'out']]),
    fluid: heFluid(T_SG_HE_OUT),
    nqa1: true, containedBy: 'tank-sg-1', initialNcg: HE, pressureRating: 200,
  });
}
// Both discharge toward the duct (lower x), so both face right-to-left
circulator('pump-1a', 'He Circulator A', SG_X - 0.9, 'right-left');
circulator('pump-1b', 'He Circulator B', SG_X + 0.9, 'right-left');

// ---------------------------------------------------------------------------
// Coaxial hot gas duct (cross-vessel) through the shared wall
// ---------------------------------------------------------------------------
// Sized wall to wall so it is drawn welded to both vessels. Inner pipe: hot
// leg, core bottom -> bundle top. Annulus: circulator discharge -> RPV cold
// leg. Contained by the reactor building: that is which atmosphere its
// outer shell sees and where the annulus would vent - the two halls are
// connected around the penetration anyway (below).
add('cv-1', {
  type: 'crossVessel', label: 'Coaxial Gas Duct',
  position: { x: DUCT_X, y: 78 }, rotation: 0, elevation: DUCT_BASE,
  outerDiameter: DUCT_OD, wallThickness: 0.06, length: DUCT_LENGTH,
  innerDiameter: 1.0, innerWallThickness: 0.02,
  pressureRating: 90,
  material: 'alloy-800h',
  targetComponentId: 'hx-1', orientation: 'horizontal',
  ports: ports([
    ['cv-1-inner-in', -DUCT_LENGTH / 2, 0],      // RPV end: hot gas in
    ['cv-1-inner-out', DUCT_LENGTH / 2, 0],      // SG end: hot gas out
    ['cv-1-annulus-1', -DUCT_LENGTH / 2, 0.65],  // RPV end: cold return out
    ['cv-1-annulus-2', DUCT_LENGTH / 2, 0.65],   // SG end: circulator discharge in
  ]),
  fluid: heFluid(T_CORE_OUT),
  annulusFluid: heFluid(T_SG_HE_OUT),
  initialNcg: HE,
  annulusInitialNcg: HE,
  nqa1: true, containedBy: 'bui-rx',
});

// ---------------------------------------------------------------------------
// Isolation valves, one steam and one feed per bundle, inside the SG building
// ---------------------------------------------------------------------------
// Ordinary gate valves, open. Steam bodies are 304H like the MSSV (they sit
// on 565 C superheat, past where the low-alloy default creeps). Explicit
// volumes: sub-litre valve nodes on flashing/superheated paths diverge the
// solver, and the factory only lumps half of each adjacent line into them.
function isolationValve(id: string, label: string, x: number, y: number, elevation: number,
                        steam: boolean) {
  add(id, {
    type: 'valve', label,
    valveType: 'gate',
    ...(steam ? { material: 'stainless-304' } : {}),
    position: { x, y }, rotation: 0, elevation,
    diameter: steam ? 0.2 : 0.15, opening: 1, volume: steam ? 0.15 : 0.1,
    ports: ports([[`${id}-in`, -0.1, 0, 'in'], [`${id}-out`, 0.1, 0, 'out']]),
    fluid: steam
      ? { temperature: T_STEAM, pressure: P_STEAM, phase: 'vapor', quality: 1, flowRate: 0 }
      : { temperature: T_FEED, pressure: 186e5, phase: 'liquid', quality: 0, flowRate: 0 },
    nqa1: true, containedBy: 'bui-sg', pressureRating: 250,
  });
}
// Steam isolation valves level with the bundle steam outlets (upper headers)
const STEAM_OUTLET_ABS = SG_BUNDLE_BASE + SG_STEAM_NOZZLE;   // 16.3 m
isolationValve('val-msiv-1', 'Main Steam Isolation Valve 1', 59, 73, STEAM_OUTLET_ABS, true);
isolationValve('val-msiv-2', 'Main Steam Isolation Valve 2', 62, 73, STEAM_OUTLET_ABS, true);
// Feed isolation valves level with the bundle feed nozzles (lower headers)
const FEED_INLET_ABS = SG_BUNDLE_BASE + SG_FEED_NOZZLE;      // 0.7 m
isolationValve('val-fwiv-1', 'Feedwater Isolation Valve 1', 57, 86, FEED_INLET_ABS, false);
isolationValve('val-fwiv-2', 'Feedwater Isolation Valve 2', 61, 86, FEED_INLET_ABS, false);

// ---------------------------------------------------------------------------
// Outboard pipes: common main steam and common feedwater
// ---------------------------------------------------------------------------
// A pipe's origin is its START end; the node sits at the mid-run elevation
// and both ports at local 0 (see the condensate-line note in
// pwr-condensate-line-regression). Length is the true run, drop included.
function pipe(id: string, label: string,
              start: { x: number; y: number; elevation: number },
              end: { x: number; y: number; elevation: number },
              diameter: number, fluid: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.elevation - start.elevation;
  const plan = Math.hypot(dx, dy);
  const length = +Math.hypot(plan, dz).toFixed(2);
  add(id, {
    type: 'pipe', label,
    position: { x: start.x, y: start.y }, rotation: Math.atan2(dy, dx), elevation: start.elevation,
    endPosition: { x: end.x, y: end.y }, endElevation: end.elevation,
    diameter, thickness: 0.03, length,
    ports: ports([[`${id}-left`, 0, 0], [`${id}-right`, plan, 0]]),
    fluid,
    nqa1: true, pressureRating: 250,
    ...extra,
  });
}

// Main steam header: from the SG building wall down to the turbine floor.
// 0.35 m bore - at 165 bar / 565 C that is ~1.2 m3 and ~55 kg of steam for
// 77 kg/s, a comfortable inventory for the throughput.
pipe('pipe-ms-1', 'Main Steam Line',
  { x: 64.5, y: 72, elevation: STEAM_OUTLET_ABS }, { x: 72.5, y: 72, elevation: 5 },
  0.35, { temperature: T_STEAM, pressure: P_STEAM, phase: 'vapor', quality: 1, flowRate: 0 },
  { material: 'stainless-304' });

// Feedwater header: from the FW check valve up to the feed isolation valves
pipe('pipe-fw-1', 'Feedwater Line',
  { x: 59, y: 101, elevation: 0 }, { x: 59, y: 90.5, elevation: FEED_INLET_ABS },
  0.25, { temperature: T_FEED, pressure: 186e5, phase: 'liquid', quality: 0, flowRate: 0 });

// ---------------------------------------------------------------------------
// Turbine stop valve: the header ends here, the machine starts here
// ---------------------------------------------------------------------------
// What sits between a real header and a real machine, and the trip lever
// for scenarios: shutting it isolates the turbine.
add('val-tsv-1', {
  type: 'valve', label: 'Turbine Stop Valve',
  valveType: 'gate',
  material: 'stainless-304',
  position: { x: 74.5, y: 72 }, rotation: 0, elevation: 4,
  diameter: 0.3, opening: 1, volume: 0.2,
  ports: ports([['val-tsv-1-in', -0.1, 0, 'in'], ['val-tsv-1-out', 0.1, 0, 'out']]),
  fluid: { temperature: T_STEAM, pressure: P_STEAM, phase: 'vapor', quality: 1, flowRate: 0 },
  nqa1: false, pressureRating: 250,
});

// ---------------------------------------------------------------------------
// Steam dump / MSSV, now off the main steam line
// ---------------------------------------------------------------------------
// Tapped off the header through a 0.003 m2 line (~60 kg/s choked, the
// capacity the two per-bundle taps used to give); the outlet matches it.
add('val-msv-1', {
  type: 'valve', label: 'Steam Dump / MSSV',
  valveType: 'relief',
  material: 'stainless-304',
  position: { x: 70, y: 66 }, rotation: 0, elevation: 12,
  diameter: 0.12, opening: 0, volume: 0.1,
  pressureRating: 250, setpoint: 175e5, blowdown: 0.03,
  ports: ports([['val-msv-1-in', -0.1, 0, 'in'], ['val-msv-1-out', 0.1, 0, 'out']]),
  fluid: { temperature: T_STEAM, pressure: P_STEAM, phase: 'vapor', quality: 1, flowRate: 0 },
  nqa1: false,
});

// ---------------------------------------------------------------------------
// Primary safety valve: SG vessel head -> SG building
// ---------------------------------------------------------------------------
// On the top of the steam generator vessel, the one big helium volume that
// is not the reactor, discharging into the SG hall.
const PREL_ELEVATION = SG_VESSEL_HEIGHT + 1;
add('val-prel-1', {
  type: 'valve', label: 'Primary Safety Valve',
  valveType: 'relief',
  position: { x: SG_X, y: 74 }, rotation: 0, elevation: PREL_ELEVATION,
  diameter: 0.1, opening: 0, volume: 0.1,
  pressureRating: 120, setpoint: 75e5, blowdown: 0.03,
  ports: ports([['val-prel-1-in', -0.1, 0, 'in'], ['val-prel-1-out', 0.1, 0, 'out']]),
  fluid: heFluid(T_SG_HE_OUT),
  nqa1: true, containedBy: 'bui-sg', initialNcg: HE,
});

// ---------------------------------------------------------------------------
// Reactor cavity cooling system (see gen-xe100.ts for the full rationale)
// ---------------------------------------------------------------------------
// Lifted with the vessel: panels face the raised RPV, the tank keeps its
// 26 m stand-off above the lower panel, so every pressure seed and the
// thermosyphon head are exactly those of the verified loop.
const RCCS_LIFT = RPV_LIFT;
const rccsPanel = (id: string, elevation: number, pressure: number, half: string) => add(id, {
  type: 'tank', label: `RCCS Cavity Panels (${half})`,
  // On the vessel's centre, so the ring of standpipes is drawn around it
  position: { x: RPV_X, y: 78 }, rotation: 0, elevation,
  width: 0.66, height: 10, wallThickness: 0.006,
  fillLevel: 1, pressureRating: 16,
  radiantSurface: {
    facesComponentId: 'rv-1',
    diameter: 6.0, height: 10,
    emissivity: 0.9, facingEmissivity: 0.8,
    thickness: 0.006, hydraulicDiameter: 0.06,
  },
  ports: ports([
    [`${id}-in`, -3.0, 5],
    [`${id}-out`, 3.0, 5],
  ]),
  fluid: { temperature: 318, pressure, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: true, containedBy: 'bui-rx',
});
rccsPanel('rccs-panel-1', RCCS_LIFT + 0, 4.72e5, 'lower');
rccsPanel('rccs-panel-2', RCCS_LIFT + 10, 3.75e5, 'upper');

add('rccs-tank-1', {
  type: 'tank', label: 'RCCS Water Tank',
  position: { x: 35, y: 70 }, rotation: 0, elevation: RCCS_LIFT + 26,
  width: 4, height: 16, wallThickness: 0.012,
  fillLevel: 0.85, pressureRating: 10,
  ports: ports([
    ['rccs-tank-1-draw', -2, 8],
    ['rccs-tank-1-return', 2, 8],
    ['rccs-tank-1-vent', 0, -8],
  ]),
  fluid: { temperature: 313, pressure: 7375, phase: 'liquid', quality: 0, flowRate: 0 },
  initialNcg: AIR,
  nqa1: true, containedBy: 'bui-rx',
});

add('val-rccs-1', {
  type: 'valve', label: 'RCCS Tank Relief',
  valveType: 'relief',
  position: { x: 31, y: 70 }, rotation: 0, elevation: RCCS_LIFT + 42,
  diameter: 0.1, opening: 0, volume: 0.1,
  pressureRating: 20, setpoint: 2e5, blowdown: 0.05,
  ports: ports([['val-rccs-1-in', -0.1, 0, 'in'], ['val-rccs-1-out', 0.1, 0, 'out']]),
  fluid: { temperature: 313, pressure: 7375, phase: 'vapor', quality: 1, flowRate: 0 },
  initialNcg: AIR,
  nqa1: true, containedBy: 'bui-rx',
});

// No tube-leak valve: a tube rupture is a scripted burst of a bundle's tube
// node (hx-1-tube or hx-1-tube-b2), which discharges into the shell the way
// any tube failure does.

// ---------------------------------------------------------------------------
// Secondary: turbine (with an extraction port), condenser, pumps, heater
// ---------------------------------------------------------------------------
// The turbine carries an extraction port, which makes it a two-stage
// machine: the header enters the first stage (the factory's
// `turbine-1-extraction-1` node, seeded at the 25 bar design interstage
// pressure and holding a second of rated flow), a fixed nozzle row sized
// for the design through-flow drops it to the exhaust node, and the heater
// bleed leaves the first stage sideways through the extraction port - so
// the extraction line comes off the turbine, at the stage's own outlet
// state, and its pressure droops with load as a real one does.
add('turbine-1', {
  type: 'turbine-generator', label: 'Turbine-Generator',
  position: { x: 78, y: 74 }, rotation: 0, elevation: 0,
  width: 10, height: 3, orientation: 'left-right', stages: 1,
  running: true, power: 0,
  ratedPower: 80e6, ratedSteamFlow: 77, efficiency: 0.87,
  governorValve: 0.25, generatorEfficiency: 0.98,
  extractionPorts: [{ id: 'extraction-1', pressure: P_EXTRACTION }],
  ports: ports([
    ['inlet', -5, 0, 'in'],
    ['extraction-1', -2.5, 1.5, 'out'],
    ['outlet', 5, 0, 'out'],
  ]),
  inletFluid: { temperature: 315, pressure: 9000, phase: 'vapor', quality: 1, flowRate: 0 },
  nqa1: false,
});

add('condenser-1', {
  type: 'condenser', label: 'Condenser',
  position: { x: 78, y: 88 }, rotation: 0, elevation: 3,
  width: 6, height: 4,
  coolingWaterTemp: 293, coolingWaterFlow: 12000, coolingCapacity: 200e6,
  fillLevel: 0.25,
  ports: ports([['condenser-1-inlet', 0, -2], ['condenser-1-bottom', 0, 2]]),
  fluid: { temperature: 312, pressure: P_COND, phase: 'two-phase', quality: 0.5, flowRate: 0 },
  nqa1: false,
});

add('cond-pump-1', {
  type: 'pump', label: 'Condensate Pump',
  position: { x: 72, y: 93 }, rotation: 0, elevation: 0,
  diameter: 0.4, running: true, speed: 1,
  ratedFlow: 80, ratedHead: 200, orientation: 'right-left',
  volume: 4,
  ports: ports([['cond-pump-1-inlet', 0.3, 0, 'in'], ['cond-pump-1-outlet', -0.3, 0, 'out']]),
  fluid: { temperature: 312, pressure: P_COND, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: false, pressureRating: 40,
});

add('val-cpcv-1', {
  type: 'valve', label: 'Condensate Pump Discharge Check',
  valveType: 'check',
  position: { x: 69, y: 93 }, rotation: 0, elevation: 0,
  diameter: 0.25, opening: 1, crackingPressure: 10000, volume: 0.3,
  ports: ports([['val-cpcv-1-in', 0.1, 0, 'in'], ['val-cpcv-1-out', -0.1, 0, 'out']]),
  fluid: { temperature: 312, pressure: 2e6, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: false, pressureRating: 40,
});

add('fw-pump-1', {
  type: 'pump', label: 'Feedwater Pump',
  position: { x: 66, y: 93 }, rotation: 0, elevation: 0,
  diameter: 0.4, running: true, speed: 0.665,
  ratedFlow: 80, ratedHead: 6000, orientation: 'right-left',
  volume: 2.5,
  ports: ports([['fw-pump-1-inlet', 0.3, 0, 'in'], ['fw-pump-1-outlet', -0.3, 0, 'out']]),
  fluid: { temperature: T_FEED, pressure: 2e6, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: false, pressureRating: 250,
});

add('val-fpcv-1', {
  type: 'valve', label: 'Feed Pump Discharge Check',
  valveType: 'check',
  position: { x: 66, y: 96.5 }, rotation: 90, elevation: 0,
  diameter: 0.2, opening: 1, crackingPressure: 10000, volume: 0.3,
  ports: ports([['val-fpcv-1-in', 0.1, 0, 'in'], ['val-fpcv-1-out', -0.1, 0, 'out']]),
  fluid: { temperature: T_FEED, pressure: 188e5, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: false, pressureRating: 250,
});

add('val-fwcv-1', {
  type: 'valve', label: 'FW Check Valve',
  valveType: 'check',
  position: { x: 62, y: 101 }, rotation: 0, elevation: 0,
  diameter: 0.2, opening: 1, crackingPressure: 10000, volume: 0.3,
  ports: ports([['val-fwcv-1-in', 0.1, 0, 'in'], ['val-fwcv-1-out', -0.1, 0, 'out']]),
  fluid: { temperature: T_FEED, pressure: 186e5, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: true, pressureRating: 250,
});

// HP feedwater heater. No `extractionSource` here: the bleed point is the
// turbine's own extraction node now.
// U-tube: both tube nozzles on the one header under the tube sheet
const FWH_HEIGHT = 7;
const FWH_TUBE_PORTS = heatExchangerPorts({
  id: 'fwh-1', isVertical: true, hxType: 'utube',
  shellDiameter: 1.8, shellLength: FWH_HEIGHT, plenumLength: 0.5, bundleCount: 1,
}).filter(p => p.id.includes('-tube-'));
const FWH_TUBE_NOZZLE = nozzleElevation(FWH_TUBE_PORTS, FWH_HEIGHT, 'fwh-1-tube-1');   // -0.48
add('fwh-1', {
  type: 'heatExchanger', label: 'HP Feedwater Heater',
  position: { x: 69, y: 101 }, rotation: 0, elevation: 0,
  width: 1.8, height: FWH_HEIGHT, hxType: 'utube', tubeCount: 900,
  tubeModel: 'lumped',
  material: 'low-alloy-steel',
  pressureRating: 40, tubePressureRating: 250, shellPressureRating: 40,
  plenumLength: 0.5, tubeOD: 0.019,
  tubeFluid: { temperature: 474, pressure: 188e5, phase: 'liquid', quality: 0, flowRate: 0 },
  primaryFluid: { temperature: 474, pressure: 188e5, phase: 'liquid', quality: 0, flowRate: 0 },
  shellFluid: { temperature: 477, pressure: 16.3e5, phase: 'two-phase', quality: 0.023, flowRate: 0 },
  secondaryFluid: { temperature: 477, pressure: 16.3e5, phase: 'two-phase', quality: 0.023, flowRate: 0 },
  fillLevel: 0.3,
  ports: [
    ...FWH_TUBE_PORTS,              // fwh-1-tube-1 (feed in), fwh-1-tube-2 (feed out)
    ...ports([
      ['fwh-1-shell-1', -1.1, -3],
      ['fwh-1-shell-2', 1.1, 3],
    ]),
  ],
  nqa1: false,
});

// Extraction valve: on the bleed line from the turbine's first stage to the
// heater shell. The body rides at the stage's ~25 bar, so the line is a
// real low-pressure extraction line (0.02 m2, a 16" pipe) and the valve
// starts well open: at 25 bar even a wide-open 0.02 m2 line only passes
// the ~25 kg/s the heater needs on the 8 bar it has to the shell. It is
// listed as the `from` end of its outlet connection last, so that is the
// connection it throttles.
add('val-bleed-1', {
  type: 'valve', label: 'FWH Extraction Valve',
  valveType: 'gate',
  material: 'stainless-304',
  position: { x: 74, y: 84 }, rotation: 0, elevation: 2,
  diameter: 0.16, opening: 0.6,
  volume: 0.3,
  ports: ports([['val-bleed-1-in', -0.1, 0], ['val-bleed-1-out', 0.1, 0]]),
  fluid: { temperature: 500, pressure: P_EXTRACTION, phase: 'vapor', quality: 1, flowRate: 0 },
  nqa1: false, pressureRating: 60,
});

add('val-fwhdr-1', {
  type: 'valve', label: 'FWH Drain Valve',
  valveType: 'gate',
  position: { x: 74, y: 105 }, rotation: 0, elevation: 0,
  diameter: 0.1, opening: 0.3,
  ports: ports([['val-fwhdr-1-in', -0.1, 0], ['val-fwhdr-1-out', 0.1, 0]]),
  fluid: { temperature: 497, pressure: 25e5, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: false, pressureRating: 60,
});

// ---------------------------------------------------------------------------
// Controls (unchanged philosophy; see gen-xe100.ts)
// ---------------------------------------------------------------------------
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

controller('ctl-msp-1', 'Steam Pressure (Governor)', 20, 67, {
  sensor: { kind: 'node-pressure', targetId: 'hx-1-tube' },
  setpoint: P_STEAM,
  invert: true,
  aggressiveness: 2.0,
  scanPeriod: 0.1,
  actuator: { kind: 'governor-valve', targetId: 'turbine-1', min: 0.05, max: 0.45, rateLimit: 0.25 },
});

controller('ctl-fwh-1', 'FW Heater Outlet Temp', 20, 74, {
  sensor: { kind: 'node-temperature', targetId: 'fwh-1-tube' },
  setpoint: T_FEED,
  aggressiveness: 1.0,
  actuator: { kind: 'valve-position', targetId: 'val-bleed-1', min: 0, max: 1.0, rateLimit: 0.02 },
});

controller('ctl-fwhlvl-1', 'FWH Shell Level', 20, 88, {
  sensor: { kind: 'node-level', targetId: 'fwh-1-shell' },
  setpoint: 2.0,
  invert: true,
  aggressiveness: 1.5,
  actuator: { kind: 'valve-position', targetId: 'val-fwhdr-1', min: 0.02, max: 1.0, rateLimit: 0.05 },
});

// Three-element feedwater: the steam-flow feedforward now reads the two
// bundle lines at their isolation valves (distinct component pairs, so the
// plain flow ids apply).
controller('ctl-fw-1', 'Feedwater (3-element)', 20, 81, {
  sensor: { kind: 'connection-flow', targetId: 'flow-fw-pump-1-val-fpcv-1' },
  setpoint: {
    op: 'sum',
    inputs: [
      {
        op: 'sum',
        inputs: [
          { kind: 'connection-flow', targetId: 'flow-hx-1-val-msiv-1' },
          { kind: 'connection-flow', targetId: 'flow-hx-1-val-msiv-2' },
        ],
      },
      {
        op: 'scale', factor: -1.0, offset: 4.0,
        input: { kind: 'node-level', targetId: 'hx-1-tube' },
      },
    ],
  },
  aggressiveness: 2.5,
  scanPeriod: 0.25,
  actuator: { kind: 'pump-speed', targetId: 'fw-pump-1', min: 0.40, max: 1.0, rateLimit: 0.05 },
});

// ---------------------------------------------------------------------------
// Primary loop connections (helium) - DOWNWARD core flow
// ---------------------------------------------------------------------------
const HE_FLOW_INIT = THERMAL_POWER / (5195 * (T_CORE_OUT - T_CORE_IN));
// Top plenum -> core top, then down through the bed. The pebble bed's Ergun
// resistance (K = 550 on the 1.76 m2 void free-area) rides on this
// connection, as it did on the upflow version.
connect('rv-1', 'rv-1-core-in', 'cb-1', 'cb-1-top',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: BARREL.top + BARREL_TOP_GAP / 2, toElevation: CORE_BARREL_HEIGHT,
    flowArea: 1.76, length: 8.9, resistanceCoeff: 550 });
// Core bottom -> hot gas duct inner pipe, at the duct centerline
connect('cb-1', 'cb-1-bottom', 'cv-1', 'cv-1-inner-in',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: 0, toElevation: DUCT_OD / 2, flowArea: 0.78, length: 3, resistanceCoeff: 1.5 });
// Duct inner pipe -> bundle shell top
connect('cv-1', 'cv-1-inner-out', 'hx-1', 'hx-1-shell-1',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: DUCT_OD / 2, toElevation: SG_BUNDLE_HEIGHT, flowArea: 0.78, length: 3, resistanceCoeff: 1.5 });
// Bundle shell bottom -> SG vessel space (low)
connect('hx-1', 'hx-1-shell-2', 'tank-sg-1', 'tank-sg-in',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: 1, toElevation: SG_BUNDLE_BASE + 1, flowArea: 2.0, length: 2, resistanceCoeff: 0.5 });
// Vessel space (under the dome) -> each circulator -> duct annulus
for (const [pump, suction] of [['pump-1a', 'tank-sg-suction-a'], ['pump-1b', 'tank-sg-suction-b']] as const) {
  connect('tank-sg-1', suction, pump, `${pump}-inlet`,
    { initialFlowRate: HE_FLOW_INIT / 2, fromElevation: CIRCULATOR_BASE, toElevation: 0, flowArea: 0.3, length: 2, resistanceCoeff: 1 });
  connect(pump, `${pump}-outlet`, 'cv-1', 'cv-1-annulus-2',
    { initialFlowRate: HE_FLOW_INIT / 2, fromElevation: 0, toElevation: DUCT_OD / 2 - 0.65, flowArea: 0.5, length: 2, resistanceCoeff: 1 });
}
// Duct annulus -> RPV cold leg, entering at the duct elevation just under the core
connect('cv-1', 'cv-1-annulus-1', 'rv-1', 'rv-1-cold-leg',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: DUCT_OD / 2 - 0.65, toElevation: DUCT_CENTERLINE - RPV_LIFT,
    flowArea: 1.0, length: 3, resistanceCoeff: 1.5 });

// ---------------------------------------------------------------------------
// The two halls breathe through the gap around the duct penetration
// ---------------------------------------------------------------------------
connect('bui-rx', 'bui-rx-east', 'bui-sg', 'bui-sg-west',
  { fromElevation: DUCT_CENTERLINE, toElevation: DUCT_CENTERLINE, flowArea: 0.05, length: 1.5, resistanceCoeff: 5 });

// ---------------------------------------------------------------------------
// Secondary: main steam
// ---------------------------------------------------------------------------
// Bundle steam outlets -> steam isolation valves -> main steam line. The
// bundle lines and valves are full-bore (0.03 m2); the THROTTLE that sets
// rated steam flow stays on the line into the turbine below, as before.
for (const [n, port] of [[1, 'hx-1-tube-top'], [2, 'hx-1-tube-top-b2']] as const) {
  connect('hx-1', port, `val-msiv-${n}`, `val-msiv-${n}-in`,
    { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW / 2, fromElevation: SG_STEAM_NOZZLE, toElevation: 0,
      flowArea: 0.03, length: 4, resistanceCoeff: 1, fromPhaseTolerance: 0 });
  connect(`val-msiv-${n}`, `val-msiv-${n}-out`, 'pipe-ms-1', 'pipe-ms-1-left',
    { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW / 2, fromElevation: 0, toElevation: 0,
      flowArea: 0.03, length: 3, resistanceCoeff: 1 });
}
// Main steam line -> stop valve (header bore, no area stated so it takes
// the pipe's) -> turbine first stage. ALL the steam enters here now, the
// bleed included, so the governed line is 0.02 m2: the single-header
// version passed ~52 kg/s through 2 x 0.006 to the turbine plus ~25 through
// 2 x 0.002 to the bleed, and this is that total, chosen so the design 77
// kg/s passes at the 165 bar design drop and the governor's 0.25 start.
connect('pipe-ms-1', 'pipe-ms-1-right', 'val-tsv-1', 'val-tsv-1-in',
  { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0,
    resistanceCoeff: 1 });
connect('val-tsv-1', 'val-tsv-1-out', 'turbine-1', 'inlet',
  { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0,
    flowArea: 0.02, length: 3, resistanceCoeff: 2 });
connect('turbine-1', 'outlet', 'condenser-1', 'condenser-1-inlet',
  { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW - EXTRACTION_FLOW, fromElevation: 0, toElevation: 4, flowArea: 0.5, length: 6 });

// Steam dump / MSSV off the main steam line (~60 kg/s choked, the capacity
// the two per-bundle taps gave)
connect('pipe-ms-1', 'pipe-ms-1-right', 'val-msv-1', 'val-msv-1-in',
  { fromElevation: 0, toElevation: 0, flowArea: 0.003, length: 4, resistanceCoeff: 2 });
connect('val-msv-1', 'val-msv-1-out', 'condenser-1', 'condenser-1-inlet',
  { fromElevation: 0, toElevation: 4, flowArea: 0.003, length: 10, resistanceCoeff: 2 });

// Heater extraction: turbine first stage -> extraction valve -> heater
// shell. The initial flow on the extraction port is what the factory sizes
// the stage nozzle around (rated flow less this bleed passes on to the
// exhaust). The valve meters on its outlet connection (listed last).
connect('turbine-1', 'extraction-1', 'val-bleed-1', 'val-bleed-1-in',
  { initialFlowPhase: 'vapor', initialFlowRate: EXTRACTION_FLOW, fromElevation: 0, toElevation: 0, flowArea: 0.02, length: 10, resistanceCoeff: 2 });
connect('val-bleed-1', 'val-bleed-1-out', 'fwh-1', 'fwh-1-shell-1',
  { initialFlowPhase: 'vapor', initialFlowRate: EXTRACTION_FLOW, fromElevation: 0, toElevation: 0, flowArea: 0.02, length: 12, resistanceCoeff: 2 });

// ---------------------------------------------------------------------------
// Secondary: condensate and feed train
// ---------------------------------------------------------------------------
connect('condenser-1', 'condenser-1-bottom', 'cond-pump-1', 'cond-pump-1-inlet',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0.1, toElevation: 0, flowArea: 0.2, length: 4 });
connect('cond-pump-1', 'cond-pump-1-outlet', 'val-cpcv-1', 'val-cpcv-1-in',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 2 });
connect('val-cpcv-1', 'val-cpcv-1-out', 'fw-pump-1', 'fw-pump-1-inlet',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 2 });
connect('fw-pump-1', 'fw-pump-1-outlet', 'val-fpcv-1', 'val-fpcv-1-in',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 2 });
connect('val-fpcv-1', 'val-fpcv-1-out', 'fwh-1', 'fwh-1-tube-1',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: FWH_TUBE_NOZZLE, flowArea: 0.05, length: 2 });
connect('fwh-1', 'fwh-1-tube-2', 'val-fwcv-1', 'val-fwcv-1-in',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: FWH_TUBE_NOZZLE, toElevation: 0, flowArea: 0.05, length: 4, resistanceCoeff: 2 });
// FW check valve -> feedwater line -> feed isolation valves -> bundle
// orifices (K = 600 each: the split between bundles is set by geometry,
// not by whichever bundle happens to be boiling less).
connect('val-fwcv-1', 'val-fwcv-1-out', 'pipe-fw-1', 'pipe-fw-1-left',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 3, resistanceCoeff: 1 });
for (const [n, port] of [[1, 'hx-1-tube-bottom'], [2, 'hx-1-tube-bottom-b2']] as const) {
  connect('pipe-fw-1', 'pipe-fw-1-right', `val-fwiv-${n}`, `val-fwiv-${n}-in`,
    { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW / 2, fromElevation: 0, toElevation: 0,
      flowArea: 0.03, length: 4, resistanceCoeff: 1 });
  connect(`val-fwiv-${n}`, `val-fwiv-${n}-out`, 'hx-1', port,
    { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW / 2, fromElevation: 0, toElevation: SG_FEED_NOZZLE,
      flowArea: 0.015, length: 6, resistanceCoeff: 600 });
}

// Heater shell drain cascades to the condenser
connect('fwh-1', 'fwh-1-shell-2', 'val-fwhdr-1', 'val-fwhdr-1-in',
  { initialFlowPhase: 'liquid', initialFlowRate: EXTRACTION_FLOW, fromElevation: 0, toElevation: 0.1, flowArea: 0.01, length: 8, resistanceCoeff: 4 });
connect('val-fwhdr-1', 'val-fwhdr-1-out', 'condenser-1', 'condenser-1-inlet',
  { initialFlowPhase: 'liquid', initialFlowRate: EXTRACTION_FLOW, fromElevation: 0.1, toElevation: 3, flowArea: 0.01, length: 8, resistanceCoeff: 8 });

// ---------------------------------------------------------------------------
// Primary safety valve: off the SG vessel head, discharging into the SG hall
// ---------------------------------------------------------------------------
connect('tank-sg-1', 'tank-sg-top', 'val-prel-1', 'val-prel-1-in',
  { fromElevation: SG_VESSEL_HEIGHT, toElevation: 0, flowArea: 0.008, length: 3, resistanceCoeff: 2 });
connect('val-prel-1', 'val-prel-1-out', 'bui-sg', 'bui-sg-vent-1',
  { fromElevation: 0, toElevation: PREL_ELEVATION, flowArea: 0.008, length: 6, resistanceCoeff: 2 });

// ---------------------------------------------------------------------------
// RCCS thermosyphon
// ---------------------------------------------------------------------------
connect('rccs-tank-1', 'rccs-tank-1-draw', 'rccs-panel-1', 'rccs-panel-1-in',
  { initialFlowPhase: 'liquid', initialFlowRate: 10, fromElevation: 0, toElevation: 0,
    flowArea: 0.0177, length: 32, resistanceCoeff: 8 });
connect('rccs-panel-1', 'rccs-panel-1-out', 'rccs-panel-2', 'rccs-panel-2-in',
  { initialFlowPhase: 'liquid', initialFlowRate: 10, fromElevation: 0, toElevation: 0,
    flowArea: 0.0177, length: 10, resistanceCoeff: 2 });
connect('rccs-panel-2', 'rccs-panel-2-out', 'rccs-tank-1', 'rccs-tank-1-return',
  { initialFlowPhase: 'liquid', initialFlowRate: 10, fromElevation: 0, toElevation: 0,
    flowArea: 0.0177, length: 18, resistanceCoeff: 6 });
connect('rccs-tank-1', 'rccs-tank-1-vent', 'val-rccs-1', 'val-rccs-1-in',
  { fromElevation: 16, toElevation: 0, flowArea: 0.008, length: 3, resistanceCoeff: 2 });
connect('val-rccs-1', 'val-rccs-1-out', 'bui-rx', 'bui-rx-vent-2',
  { fromElevation: 0, toElevation: RCCS_LIFT + 42, flowArea: 0.008, length: 6, resistanceCoeff: 2 });

// ---------------------------------------------------------------------------
const out = { components, connections };
const target = path.join(HERE, '..', 'src', 'presets', 'xe100-plant.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${target}: ${components.length} components, ${connections.length} connections`);
