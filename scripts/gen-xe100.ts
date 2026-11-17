/**
 * Generator for the Xe-100 preset family: src/presets/xe100.json and its
 * four scenario presets, xe100-sbo / -dlofc / -chute / -sgtr.json (the same
 * plant with a timed accident sequence attached).
 *
 * X-energy Xe-100: 200 MWt helium-cooled pebble-bed module, 60 bar primary,
 * 260 C core inlet / 750 C core outlet, feeding a HELICAL ONCE-THROUGH steam
 * generator with WATER IN THE TUBES and HELIUM ON THE SHELL SIDE - the
 * opposite of our HTGR preset, and the arrangement that makes an SG tube leak
 * push steam INTO the primary coolant.
 *
 * Built as the plant is actually arranged:
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
 *    not from the SG bundles or the main steam line.
 *
 * The comments below explain the design point, each component, each
 * connection and the control philosophy, including the tuning history that
 * produced the numbers.
 *
 * Run: npx tsx scripts/gen-xe100.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { heatExchangerPorts } from '../src/construction/construction-manager';
import { designWallThickness, crossVesselWalls } from '../src/simulation/wall-sizing';
import { reactorBarrelExtent } from '../src/reactor-geometry';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Design point
// ---------------------------------------------------------------------------
const P_HE_BAR = 60;            // primary helium pressure (bar)
// Design pressure of the primary helium boundary - the rating every primary
// wall is sized from (ASME Section III, wall-sizing.ts), ~17% over the
// operating helium. It used to be 90 with a hand-set 0.22 m RPV wall: 2.6x
// the code minimum, a 450-bar vessel holding 60 bar.
const P_DESIGN_BAR = 70;
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
// A single HP heater lifting 77 kg/s of feed from condensate temperature to
// 200 C needs ~53 MW = ~25 kg/s of extraction steam - a THIRD of the steam
// flow, which is what doing five heaters' work in one costs.
const EXTRACTION_FLOW = 25;     // kg/s - what ~53 MW of heater duty costs

// Trace steam pressure in the helium spaces. `fluid.pressure` on a gas node is
// the STEAM partial pressure; the helium is added on top of it from
// initialNcg (bar). Keep it small but nonzero - fluid.mass is water-only, so a
// helium node is "vapor at trace steam pressure + NCG".
const P_TRACE_STEAM = 700;      // Pa - steam partial pressure in the helium spaces
const HE = { He: P_HE_BAR };

// Primary walls from the design pressure (ASME Section III Class 1, SA-533B
// unless the component names its own material) - the same sizing the
// factory and the construction dialogs use, so the preset's walls are what
// a player would get building the same vessel.
const primaryWall = (innerDiameter: number, material?: string) => designWallThickness({
  pressureBar: P_DESIGN_BAR, diameter: innerDiameter, measuredOn: 'inner',
  form: 'welded', nqa1: true, material,
});
// The duct's outer shell (Alloy 800H, sized on its OD). The inner pipe is an
// insulated liner across a ~1 bar differential, not a pressure wall, so it
// keeps its own 20 mm.
const ductShellWall = (outerDiameter: number, innerDiameter: number) =>
  crossVesselWalls(P_DESIGN_BAR, outerDiameter, innerDiameter, true, 'alloy-800h').outerWallThickness;
const AIR = { N2: 0.78, O2: 0.21, Ar: 0.009 };

// ---------------------------------------------------------------------------
// Elevations: the whole primary is above grade
// ---------------------------------------------------------------------------
// The SG vessel stands on the ground floor and the cross-vessel enters it
// near the top; the RPV is raised so that the same duct leaves it just under
// the core. The duct centerline is the bundle top, so the whole heat sink
// sits below the core - which is also why LOFC natural circulation is weak
// and conduction/radiation carry the decay heat, as in the real plant. The
// RCCS panels and tank keep the geometry relative to the vessel that the
// thermosyphon was verified with (panels from the RPV base up, tank 26 m
// above the lower panel), lifted with the vessel.
const SG_VESSEL_HEIGHT = 19.5;          // head room over the circulators
const SG_BUNDLE_BASE = 1.5;             // OTSG bundle stands on the vessel floor
const SG_BUNDLE_HEIGHT = 14;
const SG_BUNDLE_WIDTH = 2.8;
const SG_PLENUM = 0.8;                  // tube-side headers, below and above the bundle
const SG_BUNDLE_TOP = SG_BUNDLE_BASE + SG_BUNDLE_HEIGHT;   // 15.5 m
const DUCT_OD = 1.8;
const DUCT_CENTERLINE = SG_BUNDLE_TOP;  // hot gas enters the bundle at its top
const DUCT_BASE = DUCT_CENTERLINE - DUCT_OD / 2;           // 14.6 m
// The annulus lines meet the duct at its axis (the connection elevation,
// DUCT_OD / 2); their nozzles are only DRAWN this far off the axis, on the
// side facing the other end of the line, clear of the inner pipe's nozzle.
// Port local y = 0 is the duct centerline (the inner pipe); the annulus band
// starts at the inner pipe's outer wall, 0.52 from the centerline, and runs
// out to the shell's inner wall, so 0.65 lands inside the band.
const ANNULUS_NOZZLE_DROP = 0.65;
const CIRCULATOR_BASE = 16.0;           // above the bundle, under the vessel dome
// Nozzle heights on the SG vessel, above its floor
const SG_IN_ELEVATION = 1.5;            // bundle discharge into the vessel space, low
const SG_SUCTION_ELEVATION = 16.5;      // circulator suctions, beside the circulators

// The reactor vessel and its core barrel. The barrel is placed by the SAME
// formula the vessel painter draws it with (reactor-geometry.ts): its gaps
// are measured from the inner dome surface at the barrel's radius, and a
// 4.4 m barrel in a 4.6 m vessel meets the heads 1.74 m up the curve. The
// top gap is whatever leaves an 11 m barrel, so the core-barrel component
// (whose height sets the core's volume) IS the barrel on screen and its top
// and bottom ports sit on the drawn ends.
const RPV_HEIGHT = 20;
const RPV_ID = 4.6, RPV_WALL = primaryWall(RPV_ID);   // ~90 mm at 70 bar
// The barrel wraps the SIDE REFLECTOR (core 2.4 m + 2 x 1.0 m graphite), not
// the bare bed - the downcomer is the narrow annulus between barrel and
// vessel.
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
// Not rounded: the barrel bottom (the core outlet) must sit exactly on the
// duct's axis, so the hot duct runs straight into it
const RPV_LIFT = DUCT_CENTERLINE + 0.4 - CORE_BOTTOM_IN_BARREL - BARREL.bottom;
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

// Helium fluid block for a primary-side component
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
  innerDiameter: RPV_ID, wallThickness: RPV_WALL, height: RPV_HEIGHT, pressureRating: P_DESIGN_BAR,
  fillLevel: 0,
  barrelDiameter: BARREL_DIAMETER, barrelThickness: BARREL_THICKNESS,
  barrelBottomGap: BARREL_GAP, barrelTopGap: BARREL_TOP_GAP,
  volume: RPV_DOWNCOMER_VOLUME,
  coreBarrelId: 'cb-1',
  // Port y is measured down from the vessel's centre
  ports: ports([
    // annulus return: at the duct's axis, where the annulus line meets the duct welded to the wall here
    ['rv-1-cold-leg', -RPV_ID / 2, RPV_HEIGHT / 2 - (DUCT_CENTERLINE - RPV_LIFT)],
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
  // Xe-100 pebble: 60 mm graphite sphere, ~7 g heavy metal, 15.5% enriched
  fuelForm: 'pebbles', pebbleDiameter: 60, pebbleCount: 220000,
  heavyMetalPerPebble: 7, enrichment: 0.155,
  reflectorThickness: 1.0, thermalPower: THERMAL_POWER,
  initialNcg: HE,
});

// ---------------------------------------------------------------------------
// Steam generator vessel on the ground floor, bundle inside, circulators on top
// ---------------------------------------------------------------------------
// The OTSG bundle sits INSIDE its own pressure vessel (a tank), which is what
// makes the creep story honest without any special casing: the 750 C helium
// enters the bundle shell through the coaxial duct's inner pipe, flows DOWN
// the tube bundle giving up its heat, and exits the shell bottom at ~260 C
// into the surrounding vessel space - so the SG pressure boundary (the tank
// wall) only ever touches cold gas, exactly like the real design. The
// circulators sit above the bundle inside the same vessel, draw from the
// vessel space, and discharge into the coaxial duct's ANNULUS back to the
// RPV - no exposed cold piping at all, matching HTR-PM/Xe-100.
add('tank-sg-1', {
  type: 'tank', label: 'SG Vessel',
  position: { x: SG_X, y: 78 }, rotation: 0, elevation: 0,
  width: SG_WIDTH, height: SG_VESSEL_HEIGHT, wallThickness: primaryWall(SG_WIDTH), pressureRating: P_DESIGN_BAR,
  fillLevel: 0,
  ports: ports([
    ['tank-sg-in', 1.8, SG_VESSEL_HEIGHT / 2 - SG_IN_ELEVATION],               // bundle discharge, low
    ['tank-sg-suction-a', -1.0, SG_VESSEL_HEIGHT / 2 - SG_SUCTION_ELEVATION],  // circulator A suction
    ['tank-sg-suction-b', 1.0, SG_VESSEL_HEIGHT / 2 - SG_SUCTION_ELEVATION],   // circulator B suction
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

// ONE helical once-through SG with the moving-boundary tube model
// (docs/otsg-moving-boundary-design.md): subcooled / boiling / superheat
// sections whose boundaries track the phase boundaries.
//
// TWO tube bundles share the shell, as in the real machine: a Xe-100 SG is
// built from helical bundle assemblies stacked around the central riser, each
// with its own feedwater inlet header and its own steam outlet header, and
// they see one common helium stream. `bundleCount` gives each bundle its own
// flow path, tube metal and moving partition; tubeCount stays the SG total
// and is split between them, so the shell holds the same number of tubes
// either way. A tube leak (the SGTR scenario) is a defect in ONE bundle,
// which the split represents honestly - the scenario bursts bundle 1's tube
// node, hx-1-tube.
//
// Tubes are Alloy 800H: at 60 bar and SG temperatures low-alloy steel would
// creep-rupture, and 800H is what real helical HTGR steam generators use.
add('hx-1', {
  type: 'heatExchanger', label: 'Helical Once-Through SG',
  position: { x: SG_X, y: 78 }, rotation: 0, elevation: SG_BUNDLE_BASE,
  // 300 tubes, not 5000: helical coil length comes from bundle packing
  // (hx-bundles.ts), so tube count sets coil length as well as area - 5000
  // tubes packed into this shell made each coil absurdly short.
  width: SG_BUNDLE_WIDTH, height: SG_BUNDLE_HEIGHT, hxType: 'helical', tubeCount: 300,
  tubeModel: 'moving-boundary', bundleCount: 2,
  // Start AT the operating point: 165 bar with the economizer holding the
  // bottom quarter, boiling the middle, and the superheater running
  // saturation -> 565 C in the top 35%. The factory builds the node totals,
  // slug ledger and metal temperatures this partition implies - a plant
  // initialized at its design state should simply STAY there instead of
  // boiling through the whole startup transient every session.
  initialSections: { pressureBar: 165, TFeedK: T_FEED, TSteamK: T_STEAM, L1: 0.25, L3: 0.35, flowKgs: FEED_FLOW / 2 },
  material: 'alloy-800h',
  pressureRating: P_DESIGN_BAR, tubePressureRating: 200, shellPressureRating: P_DESIGN_BAR,
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
// 1.4 bar rise. Head is rho*g*H with the NCG density included, so a gas
// circulator needs a very large "head" in metres to make a modest pressure
// rise: helium at 60 bar / 533 K is only ~5.4 kg/m3, so 1.4 bar takes
// ~2600 m. Each gets a discharge non-return
// flap, as parallel machines must: without one a tripped circulator is an
// open bypass through which its running twin short-circuits.
// containedBy the tank: the casings are gauged against, and would burst into,
// the vessel's own helium. containedBy only records containment, it does not
// move anything, so the plan positions below have to be inside the vessel's
// footprint themselves or the circulators draw outside it.
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
    nqa1: true, containedBy: 'tank-sg-1', initialNcg: HE, pressureRating: P_DESIGN_BAR,
  });
}
// Both discharge toward the duct (lower x), so both face right-to-left
circulator('pump-1a', 'He Circulator A', SG_X - 0.9, 'right-left');
circulator('pump-1b', 'He Circulator B', SG_X + 0.9, 'right-left');

// ---------------------------------------------------------------------------
// Coaxial hot gas duct (cross-vessel) through the shared wall
// ---------------------------------------------------------------------------
// This is NOT cosmetic. A bare steel duct carrying 750 C helium at 60 bar
// creep-ruptures in about a minute in this model (creepRuptureTime at 1023 K
// gives ~109 s even at a stress ratio of 0.2) - and that is correct: real
// HTGRs never expose the pressure boundary to core-outlet temperature. Hot
// helium runs down the insulated INNER pipe while the cold return fills the
// ANNULUS, so the outer wall - the actual pressure boundary - sits at core
// inlet temperature. Exactly the HTR-PM / Xe-100 arrangement.
//
// Sized wall to wall so it is drawn welded to both vessels. Inner pipe: hot
// leg, core bottom -> bundle top. Annulus: circulator discharge -> RPV cold
// leg. Contained by the reactor building: that is which atmosphere its
// outer shell sees and where the annulus would vent - the two halls are
// connected around the penetration anyway (below).
add('cv-1', {
  type: 'crossVessel', label: 'Coaxial Gas Duct',
  position: { x: DUCT_X, y: 78 }, rotation: 0, elevation: DUCT_BASE,
  outerDiameter: DUCT_OD, wallThickness: ductShellWall(DUCT_OD, 1.0), length: DUCT_LENGTH,
  innerDiameter: 1.0, innerWallThickness: 0.02,
  // Hot-duct lining: 50 mm of fibre insulation in helium (~0.3 W/m-K) inside
  // the inner pipe. A bare liner leaks ~3.3 MW from the hot leg into the cold
  // annulus; lined, ~70 kW (scripts/check-hot-duct-leak.ts).
  innerInsulationThickness: 0.05, innerInsulationConductivity: 0.3,
  pressureRating: P_DESIGN_BAR,
  // Alloy 800H. Even with the cold return in the annulus keeping the pressure
  // boundary near core-inlet temperature, the inner liner sees 750 C - and the
  // outer wall still runs ~460 C, where low-alloy steel is marginal.
  material: 'alloy-800h',
  targetComponentId: 'hx-1', orientation: 'horizontal',
  ports: ports([
    ['cv-1-inner-in', -DUCT_LENGTH / 2, 0],      // RPV end: hot gas in
    ['cv-1-inner-out', DUCT_LENGTH / 2, 0],      // SG end: hot gas out
    ['cv-1-annulus-1', -DUCT_LENGTH / 2, ANNULUS_NOZZLE_DROP],  // RPV end: cold return out
    ['cv-1-annulus-2', DUCT_LENGTH / 2, ANNULUS_NOZZLE_DROP],   // SG end: circulator discharge in
  ]),
  fluid: heFluid(T_CORE_OUT),          // inner pipe: hot leg
  annulusFluid: heFluid(T_SG_HE_OUT),  // annulus: cold return
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
// Both bundles discharge into it through their isolation valves, and the
// turbine (through its stop valve) and the steam dump both draw from it -
// the arrangement of a real main steam line.
// Without a header - each bundle running its own line straight to the
// turbine - the only thing tying the two bundles together at steam pressure
// is the 0.1 m3 body of the closed dump valve. Whenever the bundles' outlet
// pressures drifted a few tenths of a bar apart, up to 5 kg/s of steam
// crossed between them through that ~5 kg valve body, and the flow solve
// could not predict its pressure: ~1.5% of steps rejected and ~50% more
// steps at design helium flow.
// 0.35 m bore - at 165 bar / 565 C that is ~1.2 m3 and ~55 kg of steam for
// 77 kg/s, a comfortable inventory for the throughput. Stainless for the
// same creep reason as the valves on it (see val-msv-1).
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
// Steam dump / MSSV: main steam line -> condenser (turbine bypass duty)
// ---------------------------------------------------------------------------
// With the governor shut the boiler is bottled while the helium keeps
// delivering heat, so main-steam pressure climbs. Lifts at 175 bar: it must
// catch the boil-off spike well before ~190, where superheated-steam
// property evaluation approaches the (u,v) grid's dome-top fringe.
// Tapped off the header through a 0.005 m2 line; the outlet matches it. That
// is the full design steam flow at the lift pressure, which is what a
// turbine trip at power asks of it: the heater extraction is bled from the
// turbine, so a trip takes the bleed away with the machine and ALL 77 kg/s
// has to leave through the dump. Sizing history: the original 0.01 m2 line
// passed ~210 kg/s, four times generation, and every lift became a blowdown
// spiral - pressure crashed, the pump flooded the boiler 10 t past design,
// and recovery took half an hour of simulated time. 0.002 m2 (~40 kg/s) was
// too little: a bottled boiler's boil-off is real steam that has to leave
// through SOMETHING. 0.003 m2 was enough only while the extraction tapped
// the steam header and kept drawing 25 kg/s through a trip; with the bleed
// on the turbine it measured ~52 kg/s against ~75 kg/s of generation and a
// full-load trip compressed the boiler past 200 bar in fifteen seconds.
add('val-msv-1', {
  type: 'valve', label: 'Steam Dump / MSSV',
  valveType: 'relief',
  // Stainless 304H, not the low-alloy default. This body sits on the
  // superheated main steam header, and SA-533B "loses strength fast above
  // ~700 K" by the material table's own note - at the 565 C design outlet it
  // is already past that, and the wall-node change (which gave valves real
  // metal instead of a slow lag of their fluid) turned that from an
  // unmodelled assumption into a creep rupture in under three minutes. Real
  // superheater-outlet valves are alloy or austenitic for exactly this
  // reason.
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
// The primary pressure boundary needs overpressure protection like any other:
// a stalled SG with the reactor at temperature ran the helium from 60 to 91
// bar in tuning and burst the vessel. Real HTGRs carry safety valves venting
// to the building around them. This one is on the top of the steam generator
// vessel, the one big helium volume that is not the reactor, discharging
// into the SG hall. Set at 75 bar (operating 60) with a tight 3% blowdown -
// helium is expensive, so reseat promptly. 75, not 70: off its design point
// the helium runs 64-67 bar hot, and a 70-bar setpoint sat inside the
// ordinary transient band - the valve lifted during normal operation and
// quietly vented helium to the building. Safety valves belong above the
// operating excursion band. (The setpoint dates from when the boundary was
// rated 90 bar; it is now ABOVE the 70 bar P_DESIGN_BAR the walls are sized
// from.)
const PREL_ELEVATION = SG_VESSEL_HEIGHT + 1;
add('val-prel-1', {
  type: 'valve', label: 'Primary Safety Valve',
  valveType: 'relief',
  position: { x: SG_X, y: 74 }, rotation: 0, elevation: PREL_ELEVATION,
  diameter: 0.1, opening: 0, volume: 0.1,
  pressureRating: P_DESIGN_BAR, setpoint: 75e5, blowdown: 0.03,
  ports: ports([['val-prel-1-in', -0.1, 0, 'in'], ['val-prel-1-out', 0.1, 0, 'out']]),
  fluid: heFluid(T_SG_HE_OUT),
  nqa1: true, containedBy: 'bui-sg', initialNcg: HE,
});

// ---------------------------------------------------------------------------
// Reactor cavity cooling system (RCCS)
// ---------------------------------------------------------------------------
// The ultimate heat sink an HTGR actually relies on, and the reason it can be
// walked away from. A ring of water-filled standpipes lines the concrete
// cavity around the RPV and takes the vessel's heat by THERMAL RADIATION
// across the air gap - no pump, no valve, no signal, nothing to fail. The
// water rises by its own buoyancy into a large elevated tank and returns cold
// down the outside, a thermosyphon that runs on the temperature difference it
// is trying to remove.
//
// The physics is all in the T^4: at the 260 C the vessel runs on load the
// panels take about 1 MW - a real and correctly-sized parasitic loss, 0.5% of
// core power - while at the 400-500 C the vessel reaches with the circulators
// dead the same panels take 3-4 MW without anything being switched on. Decay
// heat one hour after trip is about 2 MW, so the system self-selects: it is
// weak when the plant is healthy and strong exactly when it is not.
//
// PANEL. 120 standpipes on a 6.0 m circle around the ~4.8 m OD vessel,
// 60 mm bore, 6 mm wall, the full 20 m of vessel height. Split into two 10 m
// sections in series, which is what makes the thermosyphon honest: this model
// puts a node's fluid at its component's BASE elevation and charges the
// column between bases to the connections, so a single 20 m lump would drive
// the whole loop with its hot outlet density. Two sections give the riser a
// real axial profile and let each face its own 10 m of vessel.
//
// Drawn as the lumped standpipe it hydraulically is - 0.66 m by 10 m holds
// the bank's 3.4 m3 a section (120 * pi/4 * 0.06^2 * 10) as an honest
// cylinder. The RING is described in radiantSurface below, which is the right
// place for it: that block is the panel's METAL, and it is deliberately
// independent of the component's shape. Carrying the ring as the drawn
// diameter and pinning the water with an explicit `volume` was the other
// option, and it is a trap - the dialog drops a stored volume the moment
// anyone edits the geometry, and the bank would silently become 283 m3 of
// water.
//
// The panels stand on the vessel's own centre: the views draw a radiant tank
// as its ring of standpipes around its position, so this is what puts the
// ring around the RPV.
//
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
  // The metal that sees the vessel. Emissivities: 0.9 for the painted panel
  // face (they are deliberately blackened for exactly this reason), 0.8 for
  // the oxidised carbon-steel RPV - the same value the reflector-to-vessel
  // path uses. hydraulicDiameter is the TUBE bore: the lump has no passage of
  // its own, and using the 6 m ring diameter for the water-side convection
  // would price it as a plenum instead of a tube.
  radiantSurface: {
    facesComponentId: 'rv-1',
    diameter: 6.0, height: 10,
    emissivity: 0.9, facingEmissivity: 0.8,
    thickness: 0.006, hydraulicDiameter: 0.06,
  },
  ports: ports([
    [`${id}-in`, -3.0, 5],    // bottom: up from the section below (or the downcomer)
    [`${id}-out`, 3.0, -5],   // top: on up the riser
  ]),
  // Seeded on the static ladder under a water surface 39.6 m above the lower
  // panel's base. A rung out here is a standing wave in a loop with no pump
  // to absorb it.
  fluid: { temperature: 318, pressure, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: true, containedBy: 'bui-rx',
});
rccsPanel('rccs-panel-1', RCCS_LIFT + 0, 4.72e5, 'lower');
rccsPanel('rccs-panel-2', RCCS_LIFT + 10, 3.75e5, 'upper');

// TANK. 201 m3 high in the reactor building, 85% full: 171 t of water. That
// inventory IS the grace period - 2 MW of decay heat spends about six hours
// just warming it to boiling and another two days boiling it off, which is
// where the "72 hours with no operator action" claim in these designs comes
// from. It is also the loop's cold leg and its expansion space: the air
// cushion over the water takes the thermal expansion of the whole loop, so
// nothing has to be vented while the water is still subcooled.
//
// 4 x 16 m and not a squat 6 x 8 of the same volume: the hydrostatic model
// derives a node's height from its VOLUME (h = sqrt(V/(pi/4))), so a drawn
// shape that does not satisfy width = sqrt(height) reports a liquid column it
// does not have. At 4 x 16 the two agree and its 13.6 m of water is 13.6 m
// of head.
//
// Two-phase at the saturation pressure of 40 C water with an atmosphere of
// air on top - a vented tank of cold water, which is what it is. Filling it
// as "1 bar, 40 C" instead makes it saturated at 100 C: a partly-filled tank
// takes its temperature from its pressure, not from the number typed here.
add('rccs-tank-1', {
  type: 'tank', label: 'RCCS Water Tank',
  position: { x: 35, y: 70 }, rotation: 0, elevation: RCCS_LIFT + 26,
  width: 4, height: 16, wallThickness: 0.012,
  fillLevel: 0.85, pressureRating: 10,
  ports: ports([
    ['rccs-tank-1-draw', -2, 8],     // downcomer to the panels
    ['rccs-tank-1-return', 2, 8],    // riser return
    ['rccs-tank-1-vent', 0, -8],     // relief on the dome
    ['rccs-tank-1-vb', 1, -8],       // vacuum breaker on the dome
  ]),
  fluid: { temperature: 313, pressure: 7375, phase: 'liquid', quality: 0, flowRate: 0 },
  initialNcg: AIR,
  nqa1: true, containedBy: 'bui-rx',
});

// Overpressure protection for the closed loop. An open pool would boil at
// atmospheric pressure and vent outdoors through a stack; this loop is closed
// and slightly pressurised, so once the tank reaches saturation at 2 bar the
// steam goes to the reactor building. Without it the tank is a sealed vessel
// with a boiler under it and the only ending is a rupture.
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

// Vacuum breaker: the tank is a closed vessel inside the reactor building,
// and its 12 mm shell is built for 10 bar from INSIDE - against outside
// pressure it buckles at ~0.64 bar. A primary break that pressurises the
// building to 1.5 bar crushed it (depressurized cooldown, t = 887 s) and tore
// it open under water. A check valve from the building into the dome lets
// building gas in whenever the outside leads by its 3 kPa cracking pressure,
// the usual setting for a tank vacuum breaker.
add('val-rccs-vb-1', {
  type: 'valve', label: 'RCCS Tank Vacuum Breaker',
  valveType: 'check',
  position: { x: 33, y: 70 }, rotation: 0, elevation: RCCS_LIFT + 42,
  diameter: 0.15, opening: 0, crackingPressure: 3000, volume: 0.1,
  pressureRating: 20,
  ports: ports([['val-rccs-vb-1-in', -0.1, 0, 'in'], ['val-rccs-vb-1-out', 0.1, 0, 'out']]),
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
  // Governor starts at 25%, not closed and not full: the plant initializes
  // at its design point, and the governed inlet line (0.02 m2, below) is
  // sized so the design 77 kg/s passes at exactly this opening. The hold
  // needs the t=0 draw within a few percent of generation; the pressure loop
  // trims the rest. What the other starts did:
  //  - fully open was a shock: full draw quenched the superheater 250 K in a
  //    second;
  //  - 2% was the overcorrection: it bottles ~150 MW of boil-off behind the
  //    dump valve while the turbine takes 40 s to roll, and the boiler
  //    compresses toward water-solid by t=7;
  //  - a start only ~10% short of generation (MEASURED at 165 bar) left
  //    ~15 MW of surplus duty that climbed the boiler 30 bar/s, reversed the
  //    feed dP, and lit a draw-starvation spiral.
  governorValve: 0.25, generatorEfficiency: 0.98,
  extractionPorts: [{ id: 'extraction-1', pressure: P_EXTRACTION }],
  ports: ports([
    ['inlet', -5, 0, 'in'],
    ['extraction-1', -2.5, 1.5, 'out'],
    ['outlet', 5, 0, 'out'],
  ]),
  // EXHAUST conditions, not main-steam: this seeds the turbine's exhaust
  // node, which sits DOWNSTREAM of the governor and the stage nozzles - it
  // is the LP end, a breath above the condenser. (The first stage is seeded
  // separately, from the extraction port's pressure.) Seeding it at 165 bar
  // parked a high-pressure pocket behind an unthrottled exhaust duct, and
  // the instant the governor was not closed it discharged into the 0.07-bar
  // condenser at ~7000 kg/s and shockwaved the whole secondary - the real
  // mechanism behind the old 'starting the governor open wrecks every
  // control scheme' rule.
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
  // The suction run from the hotwell and the discharge header to the feed
  // pump - 0.4 m bore, ~30 m of it. The rating-derived default is 0.32 m3,
  // which is the bare casing and nothing else, and on a station blackout
  // this line VOIDS: the node drained to 0.2 kg of flashed steam passing 16
  // kg/s, turned over its whole inventory every step, and collapsed the
  // timestep to the floor. Real condensate piping absorbs that.
  volume: 4,
  ports: ports([['cond-pump-1-inlet', 0.3, 0, 'in'], ['cond-pump-1-outlet', -0.3, 0, 'out']]),
  fluid: { temperature: 312, pressure: P_COND, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: false, pressureRating: 40,
});

// Pump-discharge check valves. A windmilling centrifugal pump does not block
// reverse flow (the impeller block applies only while it runs), and without
// these a station blackout let the 170 C feed line flash and blow ~560 kg/s
// BACKWARDS through both tripped pumps into the condenser, emptying the
// heater tube and both pump bodies in six seconds. Every real feed train has
// them, one per pump discharge. Volume is the discharge spool, not a bare
// disc: sub-litre valve nodes on flashing paths diverge the solver.
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
  // 0.665 when initializing at the design point: the pump must hold the TOP
  // of the feed-train ladder, ~188 bar (boiler 165 + bundle orifices ~20 +
  // piping), at 77 kg/s: 1.25 s^2 = 0.3194 + 0.25 (77/80)^2. Matching the
  // boiler pressure instead (0.64) starves the ladder; 0.68 over-delivers
  // 10 kg/s and packs the boiler off its point. From there ctl-fw-1 drives
  // the speed.
  //
  // How the speed got here, because each step says something about the
  // boiler. Speed picks the pump-curve balance pressure: a passive feed
  // equilibrium sits where delivery(P) = generation(P), and delivery follows
  // the head curve (1.25 s^2 - 0.25 q^2 = P/(rho g H_rated)). Speed is also
  // the INVENTORY knob: with the governor pinning 165 bar, delivery-at-165
  // sets where the evaporator froth level settles, and too much kept the
  // superheater flooded with wet carryover (saturated 350 C steam forever).
  // With the moving-boundary OTSG that saturated-vs-superheated dichotomy is
  // gone - lower delivery just grows the superheat section continuously
  // instead of flipping a whole lump dry.
  // Cold starts (every loop flow zero) had their own trap: a speed whose
  // shutoff head beats the boiler's 165 bar slammed 70 kg/s of cold feed
  // into the tubes in the first second, the partition pressure dipped as the
  // slug swallowed the vapor space, and the deeper dip drew harder - 530 kg
  // in the boiler by t=6 and a 200-bar recovery that takes 40 s. The
  // deadhead cliff for 165 bar is at ~0.47: starting far below it (0.30)
  // starved the boiler to 40 kg while the turbine drained the tubes;
  // starting exactly at it (0.46) left the boiler feedless for the first
  // ~12 s of full primary heat, and the 211-bar spike that built set the
  // governor and the relief cycling hard enough to ring the whole secondary.
  diameter: 0.4, running: true, speed: 0.665,
  // High rated head + low speed = a STEEP operating curve: delivery varies
  // only ~60% between 165 and 60 bar of back-pressure instead of 2.3x. The
  // flat curve was a flood machine - any pressure sag made the pump
  // over-deliver, cold feed swelled the subcooled section, boiling area
  // collapsed, generation fell, and the sag deepened.
  ratedFlow: 80, ratedHead: 6000, orientation: 'right-left',
  // Suction header from the condensate pump plus the pump's own casing (see
  // cond-pump-1 for why the 0.32 m3 default is not survivable when the line
  // voids). Smaller than the condensate side: this run is short and the
  // long haul to the heater sits downstream of the check valve.
  volume: 2.5,
  ports: ports([['fw-pump-1-inlet', 0.3, 0, 'in'], ['fw-pump-1-outlet', -0.3, 0, 'out']]),
  fluid: { temperature: T_FEED, pressure: 2e6, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: false, pressureRating: 250,
});

// Feed pump discharge check (see val-cpcv-1). Sits on the ladder at the
// pump's delivery pressure, ~188 bar at design flow.
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
  // Starts OPEN: design feed flows through it from t=0. Starting closed
  // made the pump wind the feed line to 287 bar cracking it open.
  diameter: 0.2, opening: 1, crackingPressure: 10000, volume: 0.3,
  ports: ports([['val-fwcv-1-in', 0.1, 0, 'in'], ['val-fwcv-1-out', -0.1, 0, 'out']]),
  // On the ladder: boiler + orifice drop (see fwh-1 tube comment)
  fluid: { temperature: T_FEED, pressure: 186e5, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: true, pressureRating: 250,
});

// HP feedwater heater. Without one the OTSG gets 40 C condensate and has to
// do the whole enthalpy rise itself. A real Rankine plant bleeds the turbine
// to preheat: extraction steam at 25 bar condenses on the shell side and
// brings the feed up to T_FEED before the SG sees it.
// No `extractionSource` here: the bleed point is the turbine's own
// extraction node, reached through val-bleed-1. (That tag makes a heater
// shell the turbine's first stage; on an earlier arrangement it turned the
// bleed into the machine's inlet and the main steam did no work.)
// U-tube (not once-through): the shell holds a condensing pool with a level
// to control, which is what the drain valve and ctl-fwhlvl-1 below are for.
// Both tube nozzles on the one header under the tube sheet
const FWH_HEIGHT = 7;
const FWH_TUBE_PORTS = heatExchangerPorts({
  id: 'fwh-1', isVertical: true, hxType: 'utube',
  shellDiameter: 1.8, shellLength: FWH_HEIGHT, plenumLength: 0.5, bundleCount: 1,
}).filter(p => p.id.includes('-tube-'));
const FWH_TUBE_NOZZLE = nozzleElevation(FWH_TUBE_PORTS, FWH_HEIGHT, 'fwh-1-tube-1');   // -0.48
add('fwh-1', {
  type: 'heatExchanger', label: 'HP Feedwater Heater',
  // Raised by its header's depth so the header stands on the ground
  position: { x: 69, y: 101 }, rotation: 0, elevation: 0.5,
  width: 1.8, height: FWH_HEIGHT, hxType: 'utube', tubeCount: 900,
  tubeModel: 'lumped',
  material: 'low-alloy-steel',
  pressureRating: 40, tubePressureRating: 250, shellPressureRating: 40,
  plenumLength: 0.5, tubeOD: 0.019,
  // 188 bar, not 170: the feed-train pressure LADDER at design flow is
  // boiler 165 + bundle orifices ~20 + piping ~2. Nodes seeded a rung low
  // let the pump hammer the line while the solve re-finds the ladder.
  tubeFluid: { temperature: 474, pressure: 188e5, phase: 'liquid', quality: 0, flowRate: 0 },
  primaryFluid: { temperature: 474, pressure: 188e5, phase: 'liquid', quality: 0, flowRate: 0 },
  // 16.3 bar saturated (204 C): this heater's measured UA is ~17 MW/K -
  // 3000 kg of tube-side water under square metres of condensing surface -
  // so it makes its ~55 MW duty at a ~3 K approach over the 200 C feed,
  // and the shell settles a breath above it. Seeding the shell hotter is
  // not conservative: at 36 bar the UA drove 435 MW into the tube side's
  // stiff liquid and its thermal expansion hit 268 bar in half a second.
  //
  // QUALITY 0.023, NOT 0.25. This is the level the drain controller below is
  // asking for. Quality is a MASS fraction: 0.25 of a 13.4 m3 shell at 16
  // bar is 0.4 m3 of water - a 0.15 m level under a controller holding out
  // for 2 m. Seeded that way the drain slams to its 2% stop and stays
  // there. 0.023 is 3.8 m3 of water in 13.4, i.e. 2 m of level in a 7 m
  // shell, and the loop starts inside its own control band.
  // (When the bleed was a tap off the 165 bar main steam header, that
  // mis-seed was fatal: 25 kg/s of extraction went in and 4 went out, the
  // shell walked from 16 bar to 53 and burst at 64 s, and raising the
  // shell's rating just moved the rupture to the drain valve at 65 bar.
  // Bled from the turbine, the 25 bar stage is the most the shell can see.)
  shellFluid: { temperature: 477, pressure: 16.3e5, phase: 'two-phase', quality: 0.023, flowRate: 0 },
  secondaryFluid: { temperature: 477, pressure: 16.3e5, phase: 'two-phase', quality: 0.023, flowRate: 0 },
  fillLevel: 0.3,
  ports: [
    ...FWH_TUBE_PORTS,              // fwh-1-tube-1 (feed in), fwh-1-tube-2 (feed out)
    ...ports([
      ['fwh-1-shell-1', -1.1, -3],   // extraction steam in
      ['fwh-1-shell-2', 1.1, 3],     // condensed drain out (bottom)
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
  // Stainless 304H rather than the low-alloy default: kept from when this
  // valve hung off the 565 C main steam header, where a low-alloy body
  // creep-ruptured in minutes (see val-msv-1). On the extraction line it
  // sees the first stage's outlet steam instead.
  material: 'stainless-304',
  position: { x: 74, y: 84 }, rotation: 0, elevation: 2,
  diameter: 0.16, opening: 0.6,
  // The extraction LINE's inventory. This valve is the only node that
  // represents that line, and the factory's lumping pass credits a small
  // node only HALF of each adjacent connection - the other halves go to the
  // big nodes at the far ends. Left at the factory floor for a valve body
  // (0.01 m3 was the floor for a 0.1 m valve) the node passes tens of kg/s
  // of steam through almost no inventory: it turned over a quarter of
  // itself per step, and the throughput sanity guard rejected 22k steps over
  // a 300 s run - 78% of ALL rejections in the preset.
  volume: 0.3,
  ports: ports([['val-bleed-1-in', -0.1, 0], ['val-bleed-1-out', 0.1, 0]]),
  fluid: { temperature: 500, pressure: P_EXTRACTION, phase: 'vapor', quality: 1, flowRate: 0 },
  nqa1: false, pressureRating: 60,
});

// Drain valve for the heater's condensing shell, cascading to the condenser.
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
// Controls
// ---------------------------------------------------------------------------
// A once-through SG has no water level to hold, so the control pairing differs
// from the PWR preset: the turbine governor holds MAIN STEAM PRESSURE, and
// feedwater flow follows the steam leaving, trimmed on STEAM OUTLET
// TEMPERATURE (too little feed and the tube bundle runs away hot, too much
// and it floods toward saturation). Rods hold core outlet temperature.
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

// SG control philosophy, learned the hard way: the design point is OPEN-LOOP
// STABLE with both actuators parked at their design values. If pressure dips,
// the feed pump delivers more against the lower head while the turbine passes
// less - both restoring. If inventory creeps up, generation rises, pressure
// rises, the pump backs down. The controllers are therefore AUTHORITY-BOUNDED
// trims around those design positions (governor 0.05-0.45, feed pump speed
// 0.40-1.0). Every unbounded or mis-paired scheme tried in tuning found a way
// to rail an actuator on an unreachable setpoint and carry the plant out of
// the stable basin:
//   - governor-on-pressure choked a drying boiler into hot stagnation and
//     burst the vessel at 91 bar (low steam pressure means low GENERATION;
//     strangling the outflow is the wrong answer - see ctl-msp-1 for what
//     made this pairing work in the end);
//   - feed-on-temperature and governor-on-temperature both wound up against
//     a two-phase node whose T is pinned to T_sat < 374 C, far below the
//     565 C setpoint - monotone windup into flooding or freeze-up;
//   - an unbounded flow-holding governor railed wide open chasing 77 kg/s
//     from a flooded boiler that could only generate 65, collapsing the
//     secondary to 27 bar saturated.
controller('ctl-msp-1', 'Steam Pressure (Governor)', 20, 67, {
  // Pressure-holding governor, take two. The original attempt at this
  // pairing died in a dry-side death spiral: at low pressure it closed, and
  // a DRY boiler could not raise pressure no matter how bottled, so the
  // primary lost its heat sink and burst. What broke the spiral is the
  // feed pump's curve: at low pressure the pump over-delivers strongly (head
  // margin), refloods the boiler, and generation resumes - so "close and let
  // pressure build" now always works. High pressure -> open (invert), low ->
  // close; the steam dump and primary safety valve guard the corners.
  sensor: { kind: 'node-pressure', targetId: 'hx-1-tube' },
  setpoint: P_STEAM,
  invert: true,
  // EHC-grade authority, not startup-roll gentleness: at 165 bar the plant
  // sits 55 bar under the critical point, and a +40 bar excursion collapses
  // the dome - the boiling section (the boiler's own negative feedback)
  // vanishes geometrically and the pressure runs away. The governor must
  // kill excursions in the first seconds; real electro-hydraulic governors
  // act in tenths of a second for exactly this reason.
  aggressiveness: 2.0,
  // 0.1-s scans and a 2-s stroke across the band: a once-through boiler
  // carries ~4 s of thermal inertia, so its open-loop pressure drifts ~6 bar
  // per MW-second of mismatch - real Benson-class plants hold their point
  // with exactly this grade of electro-hydraulic governor, and nothing
  // slower can.
  scanPeriod: 0.1,
  actuator: { kind: 'governor-valve', targetId: 'turbine-1', min: 0.05, max: 0.45, rateLimit: 0.25 },
});

// Feedwater heater outlet temperature, trimmed by the extraction valve. The
// setpoint IS T_FEED - this loop is what makes the design feedwater
// temperature real instead of an initial condition. Slewed at 0.02/s because
// extraction steal comes straight off turbine work; the full stroke is
// allowed because at the stage's 25 bar even a wide-open line only passes
// about what the heater needs (see val-bleed-1).
controller('ctl-fwh-1', 'FW Heater Outlet Temp', 20, 74, {
  sensor: { kind: 'node-temperature', targetId: 'fwh-1-tube' },
  setpoint: T_FEED,
  aggressiveness: 1.0,
  actuator: { kind: 'valve-position', targetId: 'val-bleed-1', min: 0, max: 1.0, rateLimit: 0.02 },
});

// Shell level: high level -> open the drain (hence invert). A minimum 0.02
// opening keeps the drain from latching shut and flooding the tube bundle,
// which would kill the heater's duty and take the feed temperature with it.
controller('ctl-fwhlvl-1', 'FWH Shell Level', 20, 88, {
  sensor: { kind: 'node-level', targetId: 'fwh-1-shell' },
  setpoint: 2.0,
  invert: true,
  aggressiveness: 1.5,
  actuator: { kind: 'valve-position', targetId: 'val-fwhdr-1', min: 0.02, max: 1.0, rateLimit: 0.05 },
});

// Three-element feedwater control. Every SINGLE-element active feed loop
// failed: pressure trim has positive feedback when flooded (more feed cools
// the boiler, pressure falls, it demands more feed); temperature trim winds
// up against a two-phase node pinned at T_sat; bare level trim fights
// shrink-swell. Three-element evades all three because the dominant term is
// FEEDFORWARD - match the steam leaving, summed over both bundles - and the
// third element only trims around it. The pump curve's droop is still
// underneath as the fallback if the loop saturates.
//
// The steam-flow feedforward reads the two bundle lines at their isolation
// valves (distinct component pairs, so the plain flow ids apply). That is
// upstream of everything that takes steam: the turbine, the heater
// extraction bled from it, and the dump. A real three-element loop meters
// total steam flow upstream of every extraction, and it matters: an earlier
// feedforward that missed the ~15-25 kg/s heater bleed ran the feed short by
// that much, the boiler drained (tube mass 450 -> 250 kg over 900 s), the
// superheat section grew to ~3/4 of the tube, and the steam leaving
// approached the helium inlet: ~710 C at 165 bar instead of the design 565.
// The 304H extraction valve then creep-ruptured at t~900 s of a run with no
// fault in it - honestly, at that temperature. (Dump flow is counted too,
// since the MSSV is downstream of these meters; a relief pop chased with
// feed is the swing the aggressiveness note below is about.)
//
// The trim is on OUTLET STEAM TEMPERATURE. Matching steam flow only holds
// the inventory wherever it happens to be, and in a once-through boiler that
// inventory IS the steam temperature: the outlet runs toward the helium
// inlet as the superheat section lengthens. Level was the wrong handle on
// it - a 1 kg/s-per-metre level trim never stopped the slow dry-out even
// with the bleed metered (steam 600-680 C and climbing at 1500 s, valve
// creep life ~2 h). Hotter -> drier -> more feed.
//
// It was on superheat FRACTION (0.35) for a while, as a stand-in for the
// temperature before the boiler reported one. But the fraction that makes
// 565 C is a property of the heat transfer, not of the plant's design: by
// the time the loop actually held 0.35 the steam it made was 527 C, and
// 565 C wanted 0.40. The temperature is what the turbine and the creep life
// of every valve downstream are designed to, so it is what the loop holds.
// The gain is small because the boiler does the integrating: any feed over
// the steam drawn accumulates as inventory and cools the outlet, so the
// loop rests only where feed equals draw AND the outlet is at T_STEAM.
const T_STEAM_TRIM_GAIN = 0.1;   // kg/s of feed per kelvin of outlet steam over T_STEAM
controller('ctl-fw-1', 'Feedwater (3-element)', 20, 81, {
  sensor: { kind: 'connection-flow', targetId: 'flow-fw-pump-1-val-fpcv-1' },
  setpoint: {
    op: 'sum',
    inputs: [
      {
        op: 'sum',
        inputs: [
          // Steam leaving the two bundles (through their isolation valves)
          { kind: 'connection-flow', targetId: 'flow-hx-1-val-msiv-1' },
          { kind: 'connection-flow', targetId: 'flow-hx-1-val-msiv-2' },
        ],
      },
      // Temperature trim: +T_STEAM_TRIM_GAIN kg/s per kelvin of outlet
      // steam over T_STEAM, averaged over the two bundles (a once-through
      // boiler has no level to trim on).
      ...['hx-1-tube', 'hx-1-tube-b2'].map(targetId => ({
        op: 'scale' as const, factor: T_STEAM_TRIM_GAIN / 2, offset: -T_STEAM_TRIM_GAIN / 2 * T_STEAM,
        input: { kind: 'otsg-outlet-temperature' as const, targetId },
      })),
    ],
  },
  // 2.5, not the 4.0 a bench retune used: against governor/relief cycling
  // the hotter loop swung feed 0 -> 40 kg/s and the swings themselves
  // cornered the boiler's books. 2.5 still turns the auto-tune's 120 s
  // integral time (glacial against 40 kg/s errors) into ~50 s, without
  // chasing every relief pop.
  aggressiveness: 2.5,
  scanPeriod: 0.25,   // feedwater control on the same fast-plant footing
  // min 0.40, not 0.05: below the ~0.47 deadhead the pump moves no water at
  // boiler pressure, so everything under the cliff is one dead actuator
  // band - and a loop that dives into it needs seconds of ramp just to get
  // its gradient back while the boiler drains. 0.40 keeps the low end just
  // under the cliff: still nearly zero flow, never out of authority.
  actuator: { kind: 'pump-speed', targetId: 'fw-pump-1', min: 0.40, max: 1.0, rateLimit: 0.05 },
});

// NO hotwell level controller - one was starving the plant. Its 0.80 setpoint
// needed 115 t of water in a 144 m3 condenser shell when the whole secondary
// only holds 51 t, so it was unreachable by construction, and the loop
// answered by driving the condensate pump to its 0.05 minimum. That collapsed
// the FEED PUMP's suction from 16 bar to 0.02 bar and flashed it two-phase -
// the feed pump was pumping steam - after which feed delivery went erratic,
// the boiler flooded to 23 t, steam pressure sagged, and the governor railed
// shut trying to raise it. Every symptom of the oscillation traced back here.
//
// The condensate pump runs at fixed speed and its own curve regulates: it
// cannot wind up, cannot rail, and cannot starve what is downstream of it.

// ---------------------------------------------------------------------------
// Primary loop connections (helium) - DOWNWARD core flow
// ---------------------------------------------------------------------------
// Design-point loop flows, seeded onto the connections so an at-the-design-
// point start does not begin from rest: with every flow at zero the feed
// pump momentarily rams its shutoff head into the feed train (287 bar was
// accepted into fwh-1-tube before the solve caught up) and the governor's
// draw arrives as a step. 78.6 kg/s of helium carries 200 MWt across the
// 490 K core rise; 77 kg/s of water is the design steam/feed flow.
const HE_FLOW_INIT = THERMAL_POWER / (5195 * (T_CORE_OUT - T_CORE_IN));
// Top plenum -> core top, then down through the bed. The pebble bed IS the
// loop's dominant flow resistance (Ergun ~0.5-1 bar through 8.9 m of 60 mm
// spheres at design flow); K = 550 on the 1.76 m2 void free-area reproduces
// it, and it rides on this connection.
connect('rv-1', 'rv-1-core-in', 'cb-1', 'cb-1-top',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: BARREL.top + BARREL_TOP_GAP / 2, toElevation: CORE_BARREL_HEIGHT,
    flowArea: 1.76, length: 8.9, resistanceCoeff: 550 });
// Core bottom -> hot gas duct inner pipe, at the duct centerline
connect('cb-1', 'cb-1-bottom', 'cv-1', 'cv-1-inner-in',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: 0, toElevation: DUCT_OD / 2, flowArea: 0.78, length: 3, resistanceCoeff: 1.5 });
// Duct inner pipe -> bundle shell top
connect('cv-1', 'cv-1-inner-out', 'hx-1', 'hx-1-shell-1',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: DUCT_OD / 2, toElevation: SG_BUNDLE_HEIGHT, flowArea: 0.78, length: 3, resistanceCoeff: 1.5 });
// Bundle shell bottom -> SG vessel space (low): an open internal discharge,
// so the pressure vessel only ever holds ~260 C gas
connect('hx-1', 'hx-1-shell-2', 'tank-sg-1', 'tank-sg-in',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: 1, toElevation: SG_BUNDLE_BASE + 1, flowArea: 2.0, length: 2, resistanceCoeff: 0.5 });
// Vessel space (under the dome) -> each circulator -> duct annulus -> RPV
// downcomer, entering LOW on the vessel (the duct elevation). The annulus is
// DOWNSTREAM of the circulators, as in the real plant.
for (const [pump, suction] of [['pump-1a', 'tank-sg-suction-a'], ['pump-1b', 'tank-sg-suction-b']] as const) {
  connect('tank-sg-1', suction, pump, `${pump}-inlet`,
    { initialFlowRate: HE_FLOW_INIT / 2, fromElevation: CIRCULATOR_BASE, toElevation: 0, flowArea: 0.3, length: 2, resistanceCoeff: 1 });
  // Into the annulus at the duct's axis. It is DRAWN on the top side, the
  // side facing the circulators (annulusNozzleDrawElevation)
  connect(pump, `${pump}-outlet`, 'cv-1', 'cv-1-annulus-2',
    { initialFlowRate: HE_FLOW_INIT / 2, fromElevation: 0, toElevation: DUCT_OD / 2, flowArea: 0.5, length: 2, resistanceCoeff: 1 });
}
// Helium flow control: each circulator holds its half of the design mass
// flow by varying its speed, as a variable-speed circulator does (the plant
// infers the flow from differential pressure; the sensor here reads it
// directly). At a fixed speed the flow is whatever the loop's density makes
// it - a colder cold leg packs more helium through the same head - and with
// the rods limited to 100% power any flow over design comes out of the
// core's temperature rise (82 kg/s through the loop instead of 78.6 gave
// 713 C at the outlet instead of 750). Rated speed is the top of the band:
// the circulators are sized with a few percent in hand at design, and have
// no overspeed to offer.
([['pump-1a', 'A', 95], ['pump-1b', 'B', 102]] as const).forEach(([pump, tag, y]) => {
  controller(`ctl-circ-${tag.toLowerCase()}`, `He Flow (Circulator ${tag} Speed)`, 20, y, {
    sensor: { kind: 'connection-flow', targetId: `flow-${pump}-cv-1` },
    setpoint: HE_FLOW_INIT / 2,
    actuator: { kind: 'pump-speed', targetId: pump, min: 0.2, max: 1.0, rateLimit: 0.02 },
  });
});
// Duct annulus -> RPV cold leg, just under the core. The duct is welded to
// the vessel, so both nozzles are the one opening, at the duct's axis.
connect('cv-1', 'cv-1-annulus-1', 'rv-1', 'rv-1-cold-leg',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: DUCT_OD / 2, toElevation: DUCT_CENTERLINE - RPV_LIFT,
    flowArea: 1.0, length: 3, resistanceCoeff: 1.5 });

// ---------------------------------------------------------------------------
// The two halls breathe through the gap around the duct penetration
// ---------------------------------------------------------------------------
connect('bui-rx', 'bui-rx-east', 'bui-sg', 'bui-sg-west',
  { fromElevation: DUCT_CENTERLINE, toElevation: DUCT_CENTERLINE, flowArea: 0.05, length: 1.5, resistanceCoeff: 5 });

// ---------------------------------------------------------------------------
// Secondary: main steam
// ---------------------------------------------------------------------------
// Bundle steam outlets -> steam isolation valves -> main steam line. Steam
// comes off the upper header at the very top of each bundle - the elevated
// takeoff draws VAPOR, and the OTSG model hands it the superheat section's
// enthalpy. The bundle lines and valves are full-bore (0.03 m2); the
// THROTTLE that sets rated steam flow is on the line into the turbine below.
for (const [n, port] of [[1, 'hx-1-tube-top'], [2, 'hx-1-tube-top-b2']] as const) {
  connect('hx-1', port, `val-msiv-${n}`, `val-msiv-${n}-in`,
    { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW / 2, fromElevation: SG_STEAM_NOZZLE, toElevation: 0,
      flowArea: 0.03, length: 4, resistanceCoeff: 1, fromPhaseTolerance: 0 });
  connect(`val-msiv-${n}`, `val-msiv-${n}-out`, 'pipe-ms-1', 'pipe-ms-1-left',
    { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW / 2, fromElevation: 0, toElevation: 0,
      flowArea: 0.03, length: 3, resistanceCoeff: 1 });
}
// Main steam line -> stop valve (header bore, no area stated so it takes
// the pipe's) -> turbine first stage. ALL the steam enters here, the bleed
// included, so the governed line is 0.02 m2, chosen so the design 77 kg/s
// passes at the design drop and the governor's 0.25 start. The throttling
// drop from the header is taken across this governed inlet connection, so
// its area is what sets the steam flow at a given governor opening. A
// once-through bundle has no two-phase pool to pin its pressure, so an
// oversized inlet simply blows the tube side down in seconds.
connect('pipe-ms-1', 'pipe-ms-1-right', 'val-tsv-1', 'val-tsv-1-in',
  { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0,
    resistanceCoeff: 1 });
connect('val-tsv-1', 'val-tsv-1-out', 'turbine-1', 'inlet',
  { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0,
    flowArea: 0.02, length: 3, resistanceCoeff: 2 });
// NO turbine-exhaust pipe: at 0.07 bar a duct of any plausible size holds
// only a few kg of vapor while the whole exhaust flow passes through it, so
// it pins the plant's timestep via the throughput sanity check (it was the
// single biggest step-rejector in the 900 s tuning runs, 99% of rejections).
// The turbine exhausts directly into the condenser, which is large and
// partly flooded - exactly the neck-mounted arrangement of a real LP turbine
// anyway.
connect('turbine-1', 'outlet', 'condenser-1', 'condenser-1-inlet',
  { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW - EXTRACTION_FLOW, fromElevation: 0, toElevation: 4, flowArea: 0.5, length: 6 });

// Steam dump / MSSV off the main steam line, which both bundles relieve
// through, discharging into the condenser (full design steam flow at the
// lift pressure; see val-msv-1 for the sizing)
connect('pipe-ms-1', 'pipe-ms-1-right', 'val-msv-1', 'val-msv-1-in',
  { fromElevation: 0, toElevation: 0, flowArea: 0.005, length: 4, resistanceCoeff: 2 });
connect('val-msv-1', 'val-msv-1-out', 'condenser-1', 'condenser-1-inlet',
  { fromElevation: 0, toElevation: 4, flowArea: 0.005, length: 10, resistanceCoeff: 2 });

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
// Condensate pump -> discharge check -> feed pump
connect('cond-pump-1', 'cond-pump-1-outlet', 'val-cpcv-1', 'val-cpcv-1-in',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 2 });
connect('val-cpcv-1', 'val-cpcv-1-out', 'fw-pump-1', 'fw-pump-1-inlet',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 2 });
// Feed train: pump -> discharge check -> HP heater tubes -> check valve
connect('fw-pump-1', 'fw-pump-1-outlet', 'val-fpcv-1', 'val-fpcv-1-in',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 2 });
connect('val-fpcv-1', 'val-fpcv-1-out', 'fwh-1', 'fwh-1-tube-1',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: FWH_TUBE_NOZZLE, flowArea: 0.05, length: 2 });
connect('fwh-1', 'fwh-1-tube-2', 'val-fwcv-1', 'val-fwcv-1-in',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: FWH_TUBE_NOZZLE, toElevation: 0, flowArea: 0.05, length: 4, resistanceCoeff: 2 });
// FW check valve -> feedwater line -> feed isolation valves -> bundle
// orifices, into the lower header at the bottom of each bundle. The header
// splits to both bundles, each line carrying half the flow area.
// K = 600, not 2: these are the bundle ORIFICES. Two bundles fed from one
// header with no resistance of their own share flow by whichever happens to
// be boiling less, which is unstable - one bundle floods while the other
// dries. A real once-through SG orifices each inlet hard so the split is set
// by geometry instead of by the boiling state.
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

// Heater shell drain cascades to the condenser. Valve-side elevations are
// pinned to the valve port (0.1 m for a 0.1 m valve) - an earlier toElevation
// of 3 claimed a 3 m attachment on a 0.2 m-tall valve, which drew the
// connection line in midair and put a phantom 3 m gravity head across the
// valve. The lift into the elevated condenser belongs on the condenser side
// (its inlet sits 3 m up the shell, 6 m absolute).
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
// RCCS thermosyphon: tank -> down the outside -> panels -> up -> tank
// ---------------------------------------------------------------------------
// Nothing drives this but density. Cold water falls 26 m from the tank to the
// bottom of the panels and the warmed water climbs the same 26 m back, so the
// head is g times the difference between those two columns - a couple of kPa,
// nothing, and it is enough because there is almost nothing to push against.
// The LINES set the flow, not the tubes: 120 parallel 60 mm bores are
// hydraulically invisible (~10 Pa at design) while the 0.15 m headers at K~8
// take the whole head. Lands ~10 kg/s and ~25 K of rise at the ~1 MW on-load
// duty, which is what these systems are built to do.
// Each panel's outlet is at its TOP (10 m up): steam made in a panel has to
// be able to leave it. With both nozzles at the bottom the steam was trapped
// under the panel's roof, pushed all 3 t of water out into the tank, blew
// down and reflooded - every few minutes, for hours (xe100-sbo, 2026-11-15).
connect('rccs-tank-1', 'rccs-tank-1-draw', 'rccs-panel-1', 'rccs-panel-1-in',
  { initialFlowPhase: 'liquid', initialFlowRate: 10, fromElevation: 0, toElevation: 0,
    flowArea: 0.0177, length: 32, resistanceCoeff: 8 });
connect('rccs-panel-1', 'rccs-panel-1-out', 'rccs-panel-2', 'rccs-panel-2-in',
  { initialFlowPhase: 'liquid', initialFlowRate: 10, fromElevation: 10, toElevation: 0,
    flowArea: 0.0177, length: 10, resistanceCoeff: 2 });
connect('rccs-panel-2', 'rccs-panel-2-out', 'rccs-tank-1', 'rccs-tank-1-return',
  { initialFlowPhase: 'liquid', initialFlowRate: 10, fromElevation: 10, toElevation: 0,
    flowArea: 0.0177, length: 18, resistanceCoeff: 6 });
connect('rccs-tank-1', 'rccs-tank-1-vent', 'val-rccs-1', 'val-rccs-1-in',
  { fromElevation: 16, toElevation: 0, flowArea: 0.008, length: 3, resistanceCoeff: 2 });
connect('val-rccs-1', 'val-rccs-1-out', 'bui-rx', 'bui-rx-vent-2',
  { fromElevation: 0, toElevation: RCCS_LIFT + 42, flowArea: 0.008, length: 6, resistanceCoeff: 2 });
connect('bui-rx', 'bui-rx-vent-2', 'val-rccs-vb-1', 'val-rccs-vb-1-in',
  { fromElevation: RCCS_LIFT + 42, toElevation: 0, flowArea: 0.0177, length: 1, resistanceCoeff: 2 });
connect('val-rccs-vb-1', 'val-rccs-vb-1-out', 'rccs-tank-1', 'rccs-tank-1-vb',
  { fromElevation: 0, toElevation: 16, flowArea: 0.0177, length: 1, resistanceCoeff: 2 });

// ---------------------------------------------------------------------------
const out = { components, connections };
const target = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${target}: ${components.length} components, ${connections.length} connections`);

// ---------------------------------------------------------------------------
// Scenario presets: the same plant with a timed accident sequence attached
// (src/simulation/scenario-types.ts). The events act on the plant exactly as
// an operator would, after a settling period from the design-point start.
// scripts/xe100-scenarios.ts runs these same files headless.
// ---------------------------------------------------------------------------
const SETTLE = 400; // s at the design point before the fault

const stationBlackout = {
  description: 'Station blackout at t=400 s: circulators, feed and condensate pumps trip, ' +
    'turbine shut, rods drop on loss of power. The pebble bed rides it out on decay heat and ' +
    'the reflector-to-cavity heat path alone.',
  events: [{
    time: SETTLE,
    message: 'Station blackout - circulators, feed and condensate pumps tripped, turbine shut, rods dropped',
    actions: [
      // Loss of ALL forced cooling, the design-basis event this plant is
      // built around - not just the helium circulators. A station blackout
      // takes the feed and condensate pumps with it and shuts the turbine.
      { kind: 'pump', id: 'pump-1a', running: false, speed: 0 },
      { kind: 'pump', id: 'pump-1b', running: false, speed: 0 },
      { kind: 'pump', id: 'fw-pump-1', running: false, speed: 0 },
      { kind: 'pump', id: 'cond-pump-1', running: false, speed: 0 },
      // Speed controllers off with the machines they drive, or they wind up
      // commanding a dead machine and slam the speed back the moment anything
      // returns.
      { kind: 'controller', id: 'ctl-circ-a', mode: 'manual', manualOutput: 0 },
      { kind: 'controller', id: 'ctl-circ-b', mode: 'manual', manualOutput: 0 },
      { kind: 'controller', id: 'ctl-fw-1', mode: 'manual', manualOutput: 0 },
      // Governor shut with the turbine: fully, a blackout trips it. (It was
      // 0.02 only because the governor actuator once bottomed out there; the
      // leak blew the SG down to the condenser through every blackout.)
      { kind: 'controller', id: 'ctl-msp-1', mode: 'manual', manualOutput: 0 },
      { kind: 'turbine-governor', id: 'turbine-1', value: 0 },
      // The extraction line feeds a heater with no drain pumps left; shut it
      // with the plant.
      { kind: 'valve', id: 'val-bleed-1', position: 0 },
      { kind: 'controller', id: 'ctl-fwh-1', mode: 'manual', manualOutput: 0 },
      // The rod drives hold the rods on power: losing it drops them. (Holding
      // them through a blackout is an extra failure - a scenario that wants
      // it leaves this out and puts ctl-rods-1 in manual.)
      { kind: 'scram', reason: 'loss of power to the control rod drives - rods released' },
    ],
  }],
};

// Depressurized loss of forced cooling: the HTGR design-basis heat-up. The
// blackout of stationBlackout plus a break in the primary pressure boundary,
// so the bed loses its helium as well as its circulators - convection inside
// the vessel collapses and decay heat must leave by conduction and
// radiation alone (bed -> reflector -> vessel wall -> RCCS). Fuel peaks a
// day or two later; the TRISO barrier is what keeps the source term at the
// as-manufactured defect level. The break is a ~60 mm opening high on the
// RPV (an instrument or relief nozzle shearing off), the size range DLOFC
// analyses use: it blows the primary down in minutes rather than seconds.
const depressurizedCooldown = {
  description: 'Depressurized loss of forced cooling at t=400 s: station blackout plus a ' +
    '~60 mm break high on the RPV into the reactor building; the rods drop. Helium blows down, ' +
    'in-vessel convection collapses, and decay heat leaves by conduction and radiation ' +
    'through the reflector to the vessel wall and the RCCS.',
  events: [{
    time: SETTLE,
    message: 'Primary boundary breached (~60 mm, top of RPV) with station blackout, rods dropped',
    actions: [
      ...stationBlackout.events[0].actions,
      {
        kind: 'burst', id: 'rv-1', area: 0.003, elevation: 18,
        breachMessage: 'RPV nozzle sheared - primary helium blowing down into the reactor building',
      },
    ],
  }],
};

// Defuel chute break: the pebble discharge line under the core shears off
// where it leaves the RPV's bottom head. The 0.2 m opening (a few pebble
// diameters) both blows the primary down and lets the bed drain through it
// at the Beverloo rate - ~8 kg/s, the whole core in an hour and a half -
// onto the reactor building floor, where the hot pebbles pile up in air
// (PebbleSpillRateOperator). Station blackout as in the DLOFC.
const chuteBreak = {
  description: 'Defuel chute break at t=400 s: the pebble discharge line shears off at the ' +
    'RPV bottom head with station blackout; the rods drop. Helium blows down through the 0.2 m ' +
    'opening and the pebble bed drains out through it onto the reactor building floor, ' +
    'where the spilled pebbles heat up under their own decay heat and burn in the air.',
  events: [{
    time: SETTLE,
    message: 'Defuel chute sheared at the RPV bottom head with station blackout, rods dropped',
    actions: [
      ...stationBlackout.events[0].actions,
      {
        kind: 'burst', id: 'rv-1', area: Math.PI * 0.1 * 0.1, elevation: 0,
        breachMessage: 'Defuel chute sheared at the bottom head - helium and pebbles pouring into the reactor building',
      },
    ],
  }],
};

// SG tube rupture. There is no leak valve in this plant: the rupture is a
// scripted burst of one bundle's tube node, which discharges into the shell
// the way any tube failure does. 3e-4 m2 is a single severed 19 mm tube,
// double-ended (~2.3e-4 m2) with a little margin, 5 m up the bundle.
const tubeRupture = {
  description: 'Turbine trip at t=400 s bottles the boiler toward the dump setpoint, then at ' +
    't=550 s an SG tube ruptures: 165-bar steam into 60-bar helium, carried to the hot ' +
    'graphite where it gasifies to H2 and CO.',
  events: [
    {
      time: SETTLE,
      message: 'Turbine tripped - boiler bottling up',
      // Trip first: at the settled state the tube side runs NEAR primary
      // pressure, so an at-power rupture would mostly just swap a little
      // gas. Trip-then-rupture is the sequence that drives real water
      // ingress, and it is a bona fide compound accident.
      actions: [
        { kind: 'controller', id: 'ctl-msp-1', mode: 'manual', manualOutput: 0.02 },
        { kind: 'turbine-governor', id: 'turbine-1', value: 0.02 },
      ],
    },
    {
      time: SETTLE + 150,
      message: 'SG tube ruptured (full 3e-4 m2 double-ended)',
      actions: [{
        kind: 'burst', id: 'hx-1-tube', area: 3e-4, elevation: 5,
        breachMessage: 'SG tube severed - boiler water and steam blowing into the primary helium',
      }],
    },
  ],
};

for (const [file, scenario] of [
  ['xe100-sbo.json', stationBlackout],
  ['xe100-dlofc.json', depressurizedCooldown],
  ['xe100-chute.json', chuteBreak],
  ['xe100-sgtr.json', tubeRupture],
] as const) {
  const t = path.join(HERE, '..', 'src', 'presets', file);
  fs.writeFileSync(t, JSON.stringify({ ...out, scenario }, null, 2) + '\n');
  console.log(`Wrote ${t}: ${scenario.events.length} scenario event(s)`);
}
