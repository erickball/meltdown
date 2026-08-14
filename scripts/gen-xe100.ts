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
const FEED_FLOW = 77;           // kg/s - design feedwater = design steam flow

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
  // Barrel wraps the SIDE REFLECTOR (core 2.4 m + 2 x 1.0 m graphite), not the
  // bare bed - the downcomer is the 10 cm annulus between barrel and vessel.
  barrelDiameter: 4.4, barrelThickness: 0.06, barrelBottomGap: 1.5, barrelTopGap: 1.5,
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
// Steam generator vessel and bundle: the real HTGR arrangement
// ---------------------------------------------------------------------------
// The OTSG bundle sits INSIDE its own pressure vessel (a tank), which is what
// makes the creep story honest without any special casing: the 750 C helium
// enters the bundle shell through the coaxial duct's inner pipe, flows DOWN
// the tube bundle giving up its heat, and exits the shell bottom at ~260 C
// into the surrounding vessel space - so the SG pressure boundary (the tank
// wall) only ever touches cold gas, exactly like the real design. The
// circulator sits on the vessel dome, draws from the vessel space, and
// discharges into the coaxial duct's ANNULUS back to the RPV - no exposed
// cold piping at all, matching HTR-PM/Xe-100 (and removing the two
// scaffolding pipes the old layout needed).
//
// Elevations: the SG vessel sits in a below-grade cavity (top at +6 m)
// beside the 20 m RPV, so the cross-duct runs horizontally from low on the
// RPV to the TOP of the SG vessel, and the whole heat sink sits below the
// core - which is also why LOFC natural circulation is weak and conduction/
// radiation carry the decay heat, as in the real plant.
add('tank-sg-1', {
  type: 'tank', label: 'SG Vessel',
  position: { x: 56, y: 74 }, rotation: 0, elevation: -10,
  width: 4.2, height: 16, wallThickness: 0.15, pressureRating: 90,
  fillLevel: 0,
  ports: ports([
    ['tank-sg-top', 0, -8],     // circulator suction (dome)
    ['tank-sg-in', 1.8, 6],     // bundle discharge into the vessel space
  ]),
  fluid: heFluid(T_CORE_IN),
  nqa1: true, containedBy: 'bui-1', initialNcg: HE,
});

// ONE helical once-through SG with the moving-boundary tube model
// (docs/otsg-moving-boundary-design.md): subcooled / boiling / superheat
// sections whose boundaries track the phase boundaries.
//
// Tubes are Alloy 800H: at 60 bar and SG temperatures low-alloy steel would
// creep-rupture, and 800H is what real helical HTGR steam generators use.
add('hx-1', {
  type: 'heatExchanger', label: 'Helical Once-Through SG',
  position: { x: 56, y: 74 }, rotation: 0, elevation: -9,
  width: 2.8, height: 14, hxType: 'helical', tubeCount: 5000,
  tubeModel: 'moving-boundary',
  material: 'alloy-800h',
  pressureRating: 90, tubePressureRating: 200, shellPressureRating: 90,
  plenumLength: 0.8, tubeOD: 0.019,
  ports: ports([
    ['hx-1-tube-1', -0.6, 7],    // feedwater in (bottom)
    ['hx-1-tube-2', 0.6, -7],    // main steam out (top)
    ['hx-1-shell-1', -1.8, -6],  // hot helium in (top, from the duct)
    ['hx-1-shell-2', 1.8, 6],    // cold helium out (bottom, to vessel space)
    ['hx-1-leak', 1.8, 0],       // tube-side tap for the leak path
  ]),
  tubeFluid: { temperature: 624, pressure: P_STEAM, phase: 'two-phase', quality: 0.22, flowRate: 0 },
  primaryFluid: { temperature: 624, pressure: P_STEAM, phase: 'two-phase', quality: 0.22, flowRate: 0 },
  shellFluid: { temperature: (T_CORE_OUT + T_CORE_IN) / 2, pressure: P_TRACE_STEAM, phase: 'vapor', quality: 1, flowRate: 0 },
  secondaryFluid: { temperature: (T_CORE_OUT + T_CORE_IN) / 2, pressure: P_TRACE_STEAM, phase: 'vapor', quality: 1, flowRate: 0 },
  shellInitialNcg: HE,
  nqa1: true, containedBy: 'tank-sg-1',
});

// ---------------------------------------------------------------------------
// Helium circulator: on the SG vessel dome, per the real arrangement
// ---------------------------------------------------------------------------
// Head is rho*g*H with the NCG density included, so a gas circulator needs a
// very large "head" in metres to make a modest pressure rise: helium at 60
// bar / 533 K is only ~5.4 kg/m3, so 1.4 bar takes ~2600 m.
add('pump-1', {
  type: 'pump', label: 'He Circulator',
  position: { x: 56, y: 66 }, rotation: 0, elevation: 6.3,
  diameter: 0.9, running: true, speed: 1,
  ratedFlow: 80, ratedHead: 2600, orientation: 'left-right',
  ports: ports([['pump-1-inlet', -0.5, 0, 'in'], ['pump-1-outlet', 0.5, 0, 'out']]),
  fluid: heFluid(T_SG_HE_OUT),
  nqa1: true, containedBy: 'bui-1', initialNcg: HE, pressureRating: 200,
});

// ---------------------------------------------------------------------------
// Steam dump valve: main steam -> condenser (turbine bypass duty)
// ---------------------------------------------------------------------------
// With the governor shut the boiler is bottled while the helium keeps
// delivering heat, so main-steam pressure climbs. Lifts at 175 bar: it must
// catch the boil-off spike well before ~190, where superheated-steam
// property evaluation approaches the (u,v) grid's dome-top fringe. Sized
// ~40 kg/s choked (~70% of generation) - a real dump capacity; the original
// 0.01 m2 line passed 210 kg/s and every lift was a blowdown spiral.
add('val-msv-1', {
  type: 'valve', label: 'Steam Dump / MSSV',
  valveType: 'relief',
  position: { x: 66, y: 68 }, rotation: 0, elevation: 12,
  diameter: 0.12, opening: 0, volume: 0.1,
  pressureRating: 250, setpoint: 175e5, blowdown: 0.03,
  ports: ports([['val-msv-1-in', -0.1, 0, 'in'], ['val-msv-1-out', 0.1, 0, 'out']]),
  fluid: { temperature: T_STEAM, pressure: P_STEAM, phase: 'vapor', quality: 1, flowRate: 0 },
  nqa1: false,
});

// ---------------------------------------------------------------------------
// Primary safety valve: vessel -> reactor building
// ---------------------------------------------------------------------------
// The primary pressure boundary needs overpressure protection like any other:
// a stalled SG with the reactor at temperature ran the helium from 60 to 91
// bar in tuning and burst the vessel. Real HTGRs carry safety valves venting
// to the reactor building. Set at 75 bar (design 60, vessel rating 90) with
// a tight 3% blowdown - helium is expensive, so reseat promptly. 75, not
// 70: at the current off-design operating point the helium runs 64-67 bar
// hot, and a 70-bar setpoint sat inside the ordinary transient band - the
// valve lifted during normal operation and quietly vented helium to the
// building. Safety valves belong above the operating excursion band and at
// or below the boundary rating.
add('val-prel-1', {
  type: 'valve', label: 'Primary Safety Valve',
  valveType: 'relief',
  position: { x: 30, y: 66 }, rotation: 0, elevation: 18,
  diameter: 0.1, opening: 0, volume: 0.1,
  pressureRating: 120, setpoint: 75e5, blowdown: 0.03,
  ports: ports([['val-prel-1-in', -0.1, 0, 'in'], ['val-prel-1-out', 0.1, 0, 'out']]),
  fluid: heFluid(T_CORE_IN),
  nqa1: true, containedBy: 'bui-1', initialNcg: HE,
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
  // Governor starts CLOSED and the slew-limited flow controller runs the
  // turbine up over ~40 s. Starting open is the shock that wrecked every
  // control scheme in tuning: at t=0 the loop flows are all zero, so the
  // superheater sees its full steam draw before its helium heat input has
  // developed, quenches 250 K in the first second, and the whole secondary
  // falls into a flooded recovery it takes hundreds of seconds to escape.
  // Real plants roll turbines gradually for the same class of reason.
  governorValve: 0.02, generatorEfficiency: 0.98,
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
  // Speed picks the pump-curve balance pressure: the passive-feed equilibrium
  // sits where delivery(P) = generation(P), and delivery follows the head
  // curve. 0.96 balanced at 56 bar; 0.90 puts the same balance at ~165 bar
  // for ~70 kg/s of generation (1.25 s^2 - 0.25 q^2 = P/(rho g H_rated)).
  // 0.88, not 0.90: speed is also the INVENTORY knob. With the governor
  // pinning 165 bar, delivery-at-165 sets where the evaporator froth level
  // settles; at 0.90 it sat just above the steam takeoff and wet carryover
  // kept the superheater flooded (saturated 350 C steam forever). 0.88
  // delivers ~75 kg/s at 165 bar - still design flow - with the froth below
  // the takeoff so the superheater can dry out and superheat.
  // 0.84: with the moving-boundary OTSG the old saturated-vs-superheated
  // branch dichotomy is gone - lower delivery just grows the superheat
  // section continuously instead of flipping a whole lump dry. Delivery at
  // 165 bar is ~55-60 kg/s, which is the design-duty steam flow at full
  // superheat enthalpy rise.
  diameter: 0.4, running: true, speed: 0.57,
  // High rated head + low speed = a STEEP operating curve: delivery varies
  // only ~60% between 165 and 60 bar of back-pressure instead of 2.3x. The
  // flat curve was a flood machine - any pressure sag made the pump
  // over-deliver, cold feed swelled the subcooled section, boiling area
  // collapsed, generation fell, and the sag deepened.
  ratedFlow: 80, ratedHead: 6000, orientation: 'right-left',
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

// NO turbine-exhaust pipe: at 0.07 bar a duct of any plausible size holds
// only a few kg of vapor while 77 kg/s pass through it, so it pins the whole
// plant's timestep via the throughput sanity check (it was the single biggest
// step-rejector in the 900 s tuning runs, 99% of rejections). The turbine
// exhausts directly into the condenser, which is large and partly flooded -
// exactly the neck-mounted arrangement of a real LP turbine anyway.

// ---------------------------------------------------------------------------
// Coaxial hot gas duct (cross-vessel)
// ---------------------------------------------------------------------------
// This is NOT cosmetic. A bare steel duct carrying 750 C helium at 60 bar
// creep-ruptures in about a minute in this model (creepRuptureTime at 1023 K
// gives ~109 s even at a stress ratio of 0.2) - and that is correct: real
// HTGRs never expose the pressure boundary to core-outlet temperature. Hot
// helium runs down the insulated INNER pipe while the cold return fills the
// ANNULUS, so the outer wall - the actual pressure boundary - sits at core
// inlet temperature. Exactly the HTR-PM / Xe-100 arrangement.
add('cv-1', {
  type: 'crossVessel', label: 'Coaxial Gas Duct',
  position: { x: 46, y: 80 }, rotation: 0, elevation: 5,
  outerDiameter: 1.8, wallThickness: 0.06, length: 7,
  innerDiameter: 1.0, innerWallThickness: 0.02,
  pressureRating: 90,
  // Alloy 800H. Even with the cold return in the annulus keeping the pressure
  // boundary near core-inlet temperature, the inner liner sees 750 C - and the
  // outer wall still runs ~460 C, where low-alloy steel is marginal.
  material: 'alloy-800h',
  targetComponentId: 'hx-1', orientation: 'horizontal',
  // Port local y: 0 is the duct centerline (inner pipe); the annulus band
  // spans 0.52-0.84 from the centerline (inner pipe outer wall to shell inner
  // wall), so 0.65 puts the annulus nozzles mid-band. Connection elevations
  // below follow the renderer's convention (height above component bottom =
  // outerDiameter/2 - port y) so the drawn lines anchor on these nozzles.
  ports: ports([
    ['cv-1-inner-in', -3.5, 0],
    ['cv-1-inner-out', 3.5, 0],
    ['cv-1-annulus-1', -3.5, 0.65],
    ['cv-1-annulus-2', 3.5, 0.65],
  ]),
  fluid: heFluid(T_CORE_OUT),          // inner pipe: hot leg
  annulusFluid: heFluid(T_SG_HE_OUT),  // annulus: cold return
  initialNcg: HE,
  annulusInitialNcg: HE,
  nqa1: true, containedBy: 'bui-1',
});

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

// SG control philosophy, learned the hard way: the design point is OPEN-LOOP
// STABLE with both actuators parked at their design values. If pressure dips,
// the feed pump delivers more against the lower head while the turbine passes
// less - both restoring. If inventory creeps up, generation rises, pressure
// rises, the pump backs down. The controllers therefore exist only as SLOW,
// AUTHORITY-BOUNDED trims around those design positions. Every aggressive
// scheme tried in tuning found a way to rail an actuator on an unreachable
// setpoint and carry the plant out of the stable basin:
//   - governor-on-pressure choked a drying boiler into hot stagnation and
//     burst the vessel at 91 bar (low steam pressure means low GENERATION;
//     strangling the outflow is the wrong answer);
//   - feed-on-temperature and governor-on-temperature both wound up against
//     a two-phase node whose T is pinned to T_sat < 374 C, far below the
//     565 C setpoint - monotone windup into flooding or freeze-up;
//   - an unbounded flow-holding governor railed wide open chasing 77 kg/s
//     from a flooded boiler that could only generate 65, collapsing the
//     secondary to 27 bar saturated.
// Bounded authority (gv 0.15-0.7, feed speed 0.3-1.0) plus 0.01/s slew means
// neither loop can do any of that faster than the physics can push back.
controller('ctl-msp-1', 'Steam Pressure (Governor)', 20, 67, {
  // Pressure-holding governor, take two. The original attempt at this
  // pairing died in a dry-side death spiral: at low pressure it closed, and
  // a DRY boiler could not raise pressure no matter how bottled, so the
  // primary lost its heat sink and burst. What broke the spiral is the
  // PASSIVE feed pump: at low pressure the pump over-delivers strongly (head
  // margin), refloods the boiler, and generation resumes - so "close and let
  // pressure build" now always works. High pressure -> open (invert), low ->
  // close; the steam dump and primary safety valve guard the corners.
  sensor: { kind: 'node-pressure', targetId: 'hx-1-tube' },
  setpoint: P_STEAM,
  invert: true,
  aggressiveness: 0.5,
  actuator: { kind: 'governor-valve', targetId: 'turbine-1', min: 0.05, max: 0.45, rateLimit: 0.01 },
});

// Feed holds the evaporator LEVEL (plus steam-flow feedforward for the fast
// mass balance). Level is the one feed-controlled variable whose sign is
// unconditionally right and whose setpoint is always reachable: high level
// -> cut feed, low level -> add feed, no state where either is wrong. The
// pressure trim that replaced it had hidden POSITIVE feedback on the flooded
// side - excess feed cools the boiler, which LOWERS pressure, which demands
// more feed - and flooded the plant three separate ways in tuning. With
// level pinned and flow pinned, pressure and steam temperature settle where
// the exchanger sizing puts them - which the sizing now makes the design
// point.
// NO feedwater controller - deliberately. The feed pump runs at its design
// speed and its own curve does the regulating: boiler pressure low (drying,
// under-generating) -> more head margin -> delivers more; pressure high
// (flooding, over-generating) -> starves. That is a proportional pressure
// regulator with droop, with no integrator to wind up, no unreachable
// setpoint, and no sign error in any regime - which distinguishes it from
// every ACTIVE feed scheme tried in tuning (pressure trim: positive feedback
// on the flooded side, three floods; temperature trim: setpoint unreachable
// in two-phase, windup; froth-level trim: shrink-swell inverse response,
// slow oscillation and drain-out). Inventory is the slow state that settles
// wherever generation balances the draw, and every path around the loop is
// negative feedback through the pump curve.

controller('ctl-hwl-1', 'Hotwell Level (Cond Pump)', 30, 60, {
  sensor: { kind: 'node-level', targetId: 'condenser-1' },
  setpoint: 0.8,
  invert: true,
  actuator: { kind: 'pump-speed', targetId: 'cond-pump-1', min: 0.05, max: 1, rateLimit: 0.1 },
});

// ---------------------------------------------------------------------------
// Primary loop connections (helium)
// ---------------------------------------------------------------------------
// Vessel downcomer -> core inlet (bottom), up through the pebble bed.
// The pebble bed IS the loop's dominant flow resistance (Ergun ~0.5-1 bar
// through 8.9 m of 60 mm spheres at design flow; K = 550 on the void
// free-area ~1.76 m2 reproduces it).
connect('rv-1', 'rv-1-core-in', 'cb-1', 'cb-1-inlet',
  { fromElevation: 0.8, toElevation: 0, flowArea: 1.76, length: 8.9, resistanceCoeff: 550 });
// Core outlet (top of barrel) -> down the outlet plenum -> coaxial duct
// INNER pipe (low on the RPV) -> SG bundle shell top
connect('cb-1', 'cb-1-outlet', 'cv-1', 'cv-1-inner-in',
  { fromElevation: 11, toElevation: 0.9, flowArea: 0.78, length: 8, resistanceCoeff: 1.5 });
connect('cv-1', 'cv-1-inner-out', 'hx-1', 'hx-1-shell-1',
  { fromElevation: 0.9, toElevation: 13, flowArea: 0.78, length: 3, resistanceCoeff: 1.5 });
// Bundle shell bottom -> SG vessel space: an open internal discharge, so the
// pressure vessel only ever holds ~260 C gas
connect('hx-1', 'hx-1-shell-2', 'tank-sg-1', 'tank-sg-in',
  { fromElevation: 1, toElevation: 2, flowArea: 2.0, length: 2, resistanceCoeff: 0.5 });
// Vessel space -> circulator (dome suction) -> coaxial duct ANNULUS -> RPV
// downcomer, entering LOW on the vessel (the duct elevation). The annulus is
// now DOWNSTREAM of the circulator, as in the real plant.
connect('tank-sg-1', 'tank-sg-top', 'pump-1', 'pump-1-inlet',
  { fromElevation: 15.5, toElevation: 0, flowArea: 0.6, length: 2, resistanceCoeff: 1 });
connect('pump-1', 'pump-1-outlet', 'cv-1', 'cv-1-annulus-2',
  { fromElevation: 0, toElevation: 0.25, flowArea: 1.0, length: 2, resistanceCoeff: 1 });
connect('cv-1', 'cv-1-annulus-1', 'rv-1', 'rv-1-cold-leg',
  { fromElevation: 0.25, toElevation: 5, flowArea: 1.0, length: 3, resistanceCoeff: 1.5 });

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
// Main steam off the very top of the bundle - the elevated takeoff draws
// VAPOR, and the OTSG model hands it the superheat section's enthalpy.
connect('hx-1', 'hx-1-tube-2', 'turbine-1', 'inlet',
  { fromElevation: 13.5, toElevation: 0, flowArea: 0.012, length: 25, resistanceCoeff: 2,
    fromPhaseTolerance: 0 });
connect('turbine-1', 'outlet', 'condenser-1', 'condenser-1-inlet',
  { fromElevation: 0, toElevation: 4, flowArea: 0.5, length: 6 });
connect('condenser-1', 'condenser-1-bottom', 'cond-pump-1', 'cond-pump-1-inlet',
  { fromElevation: 0.1, toElevation: 0, flowArea: 0.2, length: 4 });
connect('cond-pump-1', 'cond-pump-1-outlet', 'fw-pump-1', 'fw-pump-1-inlet',
  { fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 4 });
connect('fw-pump-1', 'fw-pump-1-outlet', 'val-fwcv-1', 'val-fwcv-1-in',
  { fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 4 });

// Steam dump: off the main steam line, discharging into the condenser
// Dump capacity ~40 kg/s at the setpoint (choked) - about 70% of full
// steam generation. The 0.01 m2 line passed ~210 kg/s, four times
// generation, and every lift became a blowdown spiral: P crashed, the
// pump flooded the boiler 10 t past design, and recovery took half an
// hour of simulated time.
connect('hx-1', 'hx-1-tube-2', 'val-msv-1', 'val-msv-1-in',
  { fromElevation: 13.5, toElevation: 0, flowArea: 0.002, length: 4, resistanceCoeff: 2,
    fromPhaseTolerance: 0 });
connect('val-msv-1', 'val-msv-1-out', 'condenser-1', 'condenser-1-inlet',
  { fromElevation: 0, toElevation: 4, flowArea: 0.002, length: 10, resistanceCoeff: 2 });

// Primary safety valve: off the vessel dome, discharging into the building
connect('rv-1', 'rv-1-cold-leg', 'val-prel-1', 'val-prel-1-in',
  { fromElevation: 19, toElevation: 0, flowArea: 0.008, length: 3, resistanceCoeff: 2 });
connect('val-prel-1', 'val-prel-1-out', 'bui-1', 'bui-1-north',
  { fromElevation: 0, toElevation: 30, flowArea: 0.008, length: 6, resistanceCoeff: 2 });

// ---------------------------------------------------------------------------
// Leak path: SG tube side -> leak valve -> SG shell side
// ---------------------------------------------------------------------------
// Small flow area: a single severed 19 mm tube is ~2.3e-4 m2 of double-ended
// area; the valve is sized for that and throttled by `opening`.
connect('hx-1', 'hx-1-leak', 'val-leak-1', 'val-leak-1-in',
  { fromElevation: 5, toElevation: 0, flowArea: 3e-4, length: 0.5, resistanceCoeff: 2 });
connect('val-leak-1', 'val-leak-1-out', 'hx-1', 'hx-1-shell-1',
  { fromElevation: 0, toElevation: 5, flowArea: 3e-4, length: 0.5, resistanceCoeff: 2 });

// ---------------------------------------------------------------------------
const out = { components, connections };
const target = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${target}: ${components.length} components, ${connections.length} connections`);
