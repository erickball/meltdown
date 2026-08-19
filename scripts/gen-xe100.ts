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
// TWO tube bundles share the shell, as in the real machine: a Xe-100 SG is
// built from helical bundle assemblies stacked around the central riser, each
// with its own feedwater inlet header and its own steam outlet header, and
// they see one common helium stream. `bundleCount` gives each bundle its own
// flow path, tube metal and moving partition; tubeCount stays the SG total
// and is split between them, so the shell holds the same 5000 tubes either
// way. A tube leak (the SGTR scenario) is a defect in ONE bundle, which the
// split now represents honestly - the leak tap stays on bundle 1.
//
// Tubes are Alloy 800H: at 60 bar and SG temperatures low-alloy steel would
// creep-rupture, and 800H is what real helical HTGR steam generators use.
add('hx-1', {
  type: 'heatExchanger', label: 'Helical Once-Through SG',
  position: { x: 56, y: 74 }, rotation: 0, elevation: -9,
  // 300 tubes, not 5000: helical coil length now comes from bundle packing
  // (hx-bundles.ts), so tube count sets coil length as well as area - 5000
  // tubes packed into this shell made each coil absurdly short.
  width: 2.8, height: 14, hxType: 'helical', tubeCount: 300,
  tubeModel: 'moving-boundary', bundleCount: 2,
  // Start AT the operating point: 165 bar with the economizer holding the
  // bottom quarter, boiling the middle, and the superheater running
  // saturation -> 565 C in the top 35%. The factory builds the node totals,
  // slug ledger and metal temperatures this partition implies - a plant
  // initialized at its design state should simply STAY there instead of
  // boiling through the whole startup transient every session.
  initialSections: { pressureBar: 165, TFeedK: T_FEED, TSteamK: T_STEAM, L1: 0.25, L3: 0.35, flowKgs: FEED_FLOW / 2 },
  material: 'alloy-800h',
  pressureRating: 90, tubePressureRating: 200, shellPressureRating: 90,
  plenumLength: 0.8, tubeOD: 0.019,
  ports: ports([
    ['hx-1-tube-1', -0.6, 7],       // bundle 1 feedwater in (bottom)
    ['hx-1-tube-2', 0.6, -7],       // bundle 1 main steam out (top)
    ['hx-1-tube-1-b2', -0.2, 7],    // bundle 2 feedwater in (bottom)
    ['hx-1-tube-2-b2', 0.2, -7],    // bundle 2 main steam out (top)
    ['hx-1-shell-1', -1.8, -6],     // hot helium in (top, from the duct)
    ['hx-1-shell-2', 1.8, 6],       // cold helium out (bottom, to vessel space)
    ['hx-1-leak', 1.8, 0],          // bundle 1 tube-side tap for the leak path
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
  // Inside the 30 m reactor building at (46, 78) - containedBy only records
  // containment, it does not move anything, so the plan position has to be
  // within the footprint or the circulator draws outside the building
  position: { x: 56, y: 68 }, rotation: 0, elevation: 6.3,
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
  // Beside the RPV and inside the reactor building footprint (see pump-1)
  position: { x: 35, y: 70 }, rotation: 0, elevation: 18,
  diameter: 0.1, opening: 0, volume: 0.1,
  pressureRating: 120, setpoint: 75e5, blowdown: 0.03,
  ports: ports([['val-prel-1-in', -0.1, 0, 'in'], ['val-prel-1-out', 0.1, 0, 'out']]),
  fluid: heFluid(T_CORE_IN),
  nqa1: true, containedBy: 'bui-1', initialNcg: HE,
});

// ---------------------------------------------------------------------------
// SG tube leak valve: the SGTR scenario's fault injector
// ---------------------------------------------------------------------------
// Normally shut; scripts/xe100-scenarios.ts sgtr opens it to rupture a tube
// from the bundle-1 tap into the helium shell. It is a component, not just a
// pair of connections: the SG-vessel rebuild (75ee0cb) dropped the valve but
// kept the two connections that reference it, so the factory silently
// discarded both as dangling and the SGTR scenario has been unable to run
// since - it threw 'val-leak-1 not found' before it could inject anything.
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
  // Governor starts at 25%, not closed and not full. Starting fully open
  // was the shock that wrecked the old lumped closure's control schemes
  // (full draw quenched the superheater 250 K in a second); starting at 2%
  // was its overcorrection, and under the partition's honest pressure it
  // bottles ~150 MW of boil-off behind a 40 kg/s dump valve while the
  // turbine takes 40 s to roll - the boiler compresses toward water-solid
  // by t=7. 25% draws ~20 kg/s from the first second, and the pressure
  // loop rolls it up from there.
  // 0.25 when initializing at the design point: the turbine passes the
  // CONDENSER share of the steam - 77 generated minus ~25 of heater
  // extraction = ~52 kg/s. MEASURED at 165 bar: 0.22 passed 23 kg/s per
  // line (46 total), a 4 kg/s-per-line shortfall = ~15 MW of surplus duty
  // that climbed the boiler 30 bar/s, reversed the feed dP, and lit the
  // draw-starvation spiral. The hold needs the t=0 draw within a few
  // percent of generation; the pressure loop (0.01/s slew) trims the rest.
  governorValve: 0.25, generatorEfficiency: 0.98,
  ports: ports([['inlet', -7, 0, 'in'], ['outlet', 7, 0, 'out']]),
  // EXHAUST conditions, not main-steam: the turbine's internal node sits
  // DOWNSTREAM of the governor - it is the LP end, a breath above the
  // condenser. Seeding it at 165 bar parked a high-pressure pocket behind
  // an unthrottled exhaust duct, and the instant the governor was not
  // closed it discharged into the 0.07-bar condenser at ~7000 kg/s and
  // shockwaved the whole secondary - the real mechanism behind the old
  // 'starting the governor open wrecks every control scheme' rule.
  inletFluid: { temperature: 315, pressure: 9000, phase: 'vapor', quality: 1, flowRate: 0 },
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
  // 0.46 INITIAL, not the 0.57 operating point: 0.57's shutoff head beats
  // the boiler's honest 165 bar with every loop flow still zero, so the
  // pump slammed 70 kg/s of cold feed into the tubes in the first second,
  // the partition pressure dipped as the slug swallowed the vapor space,
  // and the deeper dip drew harder - 530 kg in the boiler by t=6 and a
  // 200-bar recovery that takes 40 s. 0.46 starts the pump AT the deadhead
  // cliff for 165 bar (shutoff crosses it at ~0.47): essentially no flow at
  // t=0, but the loop has gradient from the first scan as the governor
  // rolls the turbine. Starting far below the cliff (0.30 was tried)
  // starves the boiler to 40 kg while the turbine drains the tubes; starting
  // exactly AT it (0.46) leaves the boiler feedless for the first ~12 s of
  // full primary heat, and the 211-bar spike that builds sets the governor
  // and the relief cycling hard enough to ring the whole secondary. 0.50
  // delivers a trickle (~10-15 kg/s) from the first second - enough to keep
  // the boil-off fed without the old 70 kg/s slam.
  // 0.665 when initializing at the design point: the pump must hold the TOP
  // of the feed-train ladder, ~188 bar (boiler 165 + bundle orifices ~20 +
  // piping), at 77 kg/s: 1.25 s^2 = 0.3194 + 0.25 (77/80)^2. Matching the
  // boiler pressure instead (0.64) starves the ladder; 0.68 over-delivers
  // 10 kg/s and packs the boiler off its point.
  diameter: 0.4, running: true, speed: 0.665,
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
  // Starts OPEN: design feed flows through it from t=0. Starting closed
  // made the pump wind the feed line to 287 bar cracking it open.
  diameter: 0.2, opening: 1, crackingPressure: 10000,
  ports: ports([['val-fwcv-1-in', 0.1, 0, 'in'], ['val-fwcv-1-out', -0.1, 0, 'out']]),
  // On the ladder: boiler + orifice drop (see fwh-1 tube comment)
  fluid: { temperature: T_FEED, pressure: 186e5, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: true, pressureRating: 250,
});

// ---------------------------------------------------------------------------
// HP feedwater heater
// ---------------------------------------------------------------------------
// The plant ran without one for a long time, which meant the OTSG got 40 C
// condensate and had to do the whole enthalpy rise itself. A real Rankine
// plant bleeds the turbine to preheat: extraction steam at 25 bar condenses
// on the shell side and brings the feed up to T_FEED before the SG sees it.
// U-tube (not once-through): the shell holds a condensing pool with a level
// to control, which is what the drain valve and ctl-fwhlvl-1 below are for.
add('fwh-1', {
  type: 'heatExchanger', label: 'HP Feedwater Heater',
  position: { x: 63, y: 99 }, rotation: 0, elevation: 0,
  width: 1.8, height: 7, hxType: 'utube', tubeCount: 900,
  tubeModel: 'lumped',
  material: 'low-alloy-steel',
  pressureRating: 40, tubePressureRating: 250, shellPressureRating: 40,
  plenumLength: 0.5, tubeOD: 0.019,
  // Names the turbine stage the bleed is tapped from, so the extraction
  // enthalpy follows the real expansion line rather than throttled inlet steam
  extractionSource: { turbineId: 'turbine-1', pressure: 25e5 },
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
  shellFluid: { temperature: 477, pressure: 16.3e5, phase: 'two-phase', quality: 0.25, flowRate: 0 },
  secondaryFluid: { temperature: 477, pressure: 16.3e5, phase: 'two-phase', quality: 0.25, flowRate: 0 },
  fillLevel: 0.3,
  ports: ports([
    ['fwh-1-tube-1', -0.5, 3.5],   // feed in (from the FW pump)
    ['fwh-1-tube-2', 0.5, -3.5],   // heated feed out (to the check valve)
    ['fwh-1-shell-1', -1.1, -3],   // extraction steam in
    ['fwh-1-shell-2', 1.1, 3],     // condensed drain out (bottom)
  ]),
  nqa1: false,
});

add('val-bleed-1', {
  type: 'valve', label: 'FWH Extraction Valve',
  valveType: 'gate',
  position: { x: 70, y: 99 }, rotation: 0, elevation: 0,
  // Open at the operating throttle, and the body rides at TUBE pressure:
  // the valve sits on its OUTLET connection, so a closed valve with the
  // body seeded at shell pressure is a 0.1 m3 vacuum bolted to a 165-bar
  // boiler - it swallowed ~30 kg/s until it went liquid-solid and hammered
  // the feed train to 274 bar.
  // 0.1: measured ~46 kg/s at 0.2 through the twin taps - this meters the
  // ~25 the heater duty needs.
  diameter: 0.1, opening: 0.1,
  ports: ports([['val-bleed-1-in', -0.1, 0], ['val-bleed-1-out', 0.1, 0]]),
  fluid: { temperature: 700, pressure: 165e5, phase: 'vapor', quality: 1, flowRate: 0 },
  nqa1: false, pressureRating: 200,
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
  // EHC-grade authority, not the old 0.5/0.01 startup-roll gentleness: at
  // 165 bar the plant sits 55 bar under the critical point, and a +40 bar
  // excursion collapses the dome - the boiling section (the boiler's own
  // negative feedback) vanishes geometrically and the pressure runs away.
  // The governor must kill excursions in the first seconds; real electro-
  // hydraulic governors act in tenths of a second for exactly this reason.
  aggressiveness: 2.0,
  // 0.1-s scans and a 2-s full stroke: a once-through boiler carries ~4 s
  // of thermal inertia, so its open-loop pressure drifts ~6 bar per MW-
  // second of mismatch - real Benson-class plants hold their point with
  // exactly this grade of electro-hydraulic governor, and nothing slower
  // can.
  scanPeriod: 0.1,
  actuator: { kind: 'governor-valve', targetId: 'turbine-1', min: 0.05, max: 0.45, rateLimit: 0.25 },
});

// Feedwater heater outlet temperature, trimmed by the extraction valve. The
// setpoint IS T_FEED - this loop is what makes the design feedwater
// temperature real instead of an initial condition. Bounded to 0.3 open and
// slewed at 0.02/s because extraction steal comes straight off turbine work.
controller('ctl-fwh-1', 'FW Heater Outlet Temp', 20, 74, {
  sensor: { kind: 'node-temperature', targetId: 'fwh-1-tube' },
  setpoint: T_FEED,
  aggressiveness: 1.0,
  actuator: { kind: 'valve-position', targetId: 'val-bleed-1', min: 0, max: 0.8, rateLimit: 0.02 },
});

// Drain valve for the heater's condensing shell, cascading to the condenser.
add('val-fwhdr-1', {
  type: 'valve', label: 'FWH Drain Valve',
  valveType: 'gate',
  position: { x: 68, y: 103 }, rotation: 0, elevation: 0,
  diameter: 0.1, opening: 0.3,
  ports: ports([['val-fwhdr-1-in', -0.1, 0], ['val-fwhdr-1-out', 0.1, 0]]),
  fluid: { temperature: 497, pressure: 25e5, phase: 'liquid', quality: 0, flowRate: 0 },
  nqa1: false, pressureRating: 60,
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

// Three-element feedwater control, replacing the passive-pump-only scheme.
// The comment block this supersedes argued that every ACTIVE feed loop had
// failed - and every SINGLE-element one had: pressure trim has positive
// feedback when flooded (more feed cools the boiler, pressure falls, it
// demands more feed); temperature trim winds up against a two-phase node
// pinned at T_sat; bare level trim fights shrink-swell. Three-element evades
// all three because the dominant term is FEEDFORWARD - match the steam
// leaving, summed over both bundles - and level only trims around it
// (-1 kg/s per metre off the 4 m target: the node is 14 m tall, and the
// first trim - scaled 5x for a level that could never span 14 m - opened at
// -8 kg/s and later railed at +16 of standing overfeed; metres, not
// fractions, THIRD bite). Aggressiveness 4: the auto-tune lambda of 30 s
// gave Ti = 120 s, and against 40 kg/s errors the loop moved ~0.001/s -
// what looked reverse-signed was merely glacial. The pump curve's droop is
// still underneath as the fallback if the loop saturates.
controller('ctl-fw-1', 'Feedwater (3-element)', 20, 81, {
  sensor: { kind: 'connection-flow', targetId: 'flow-fw-pump-1-fwh-1' },
  setpoint: {
    op: 'sum',
    inputs: [
      {
        op: 'sum',
        inputs: [
          { kind: 'connection-flow', targetId: 'flow-hx-1-turbine-1' },
          { kind: 'connection-flow', targetId: 'flow-hx-1-turbine-1-hx-1-tube-2-b2-inlet' },
        ],
      },
      {
        op: 'scale', factor: -1.0, offset: 4.0,
        input: { kind: 'node-level', targetId: 'hx-1-tube' },
      },
    ],
  },
  // 2.5, not the 4.0 the bench retune used: against the startup's
  // governor/relief cycling the hotter loop swung feed 0 -> 40 kg/s and the
  // swings themselves cornered the boiler's books. 2.5 still turns the old
  // 120 s integral time into ~50 s, without chasing every relief pop.
  aggressiveness: 2.5,
  scanPeriod: 0.25,   // feedwater control on the same fast-plant footing
  // min 0.40, not 0.05: below the ~0.47 deadhead the pump moves no water at
  // boiler pressure, so everything under the cliff is one dead actuator
  // band - and a loop that dives into it needs seconds of ramp just to get
  // its gradient back while the boiler drains. 0.40 keeps the low end just
  // under the cliff: still nearly zero flow, never out of authority.
  actuator: { kind: 'pump-speed', targetId: 'fw-pump-1', min: 0.40, max: 1.0, rateLimit: 0.05 },
});

// NO hotwell level controller - it was starving the plant. Its 0.80 setpoint
// needed 115 t of water in a 144 m3 condenser shell when the whole secondary
// only holds 51 t, so it was unreachable by construction, and the loop
// answered by driving the condensate pump to its 0.05 minimum. That collapsed
// the FEED PUMP's suction from 16 bar to 0.02 bar and flashed it two-phase -
// the feed pump was pumping steam - after which feed delivery went erratic,
// the boiler flooded to 23 t, steam pressure sagged, and the governor railed
// shut trying to raise it. Every symptom of the oscillation traced back here.
//
// The condensate pump now runs at fixed speed and its own curve regulates,
// which is the same passive argument the feed pump's design rests on: it
// cannot wind up, cannot rail, and cannot starve what is downstream of it.




// ---------------------------------------------------------------------------
// Primary loop connections (helium)
// ---------------------------------------------------------------------------
// Vessel downcomer -> core inlet (bottom), up through the pebble bed.
// The pebble bed IS the loop's dominant flow resistance (Ergun ~0.5-1 bar
// through 8.9 m of 60 mm spheres at design flow; K = 550 on the void
// free-area ~1.76 m2 reproduces it).

// Design-point loop flows, seeded onto the connections so an at-the-design-
// point start does not begin from rest: with every flow at zero the feed
// pump momentarily rams its shutoff head into the feed train (287 bar was
// accepted into fwh-1-tube before the solve caught up) and the governor's
// draw arrives as a step. 78.6 kg/s of helium carries 200 MWt across the
// 490 K core rise; 77 kg/s of water is the design steam/feed flow.
const HE_FLOW_INIT = THERMAL_POWER / (5195 * (T_CORE_OUT - T_CORE_IN));
connect('rv-1', 'rv-1-core-in', 'cb-1', 'cb-1-inlet',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: 0.8, toElevation: 0, flowArea: 1.76, length: 8.9, resistanceCoeff: 550 });
// Core outlet (top of barrel) -> down the outlet plenum -> coaxial duct
// INNER pipe (low on the RPV) -> SG bundle shell top
connect('cb-1', 'cb-1-outlet', 'cv-1', 'cv-1-inner-in',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: 11, toElevation: 0.9, flowArea: 0.78, length: 8, resistanceCoeff: 1.5 });
connect('cv-1', 'cv-1-inner-out', 'hx-1', 'hx-1-shell-1',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: 0.9, toElevation: 13, flowArea: 0.78, length: 3, resistanceCoeff: 1.5 });
// Bundle shell bottom -> SG vessel space: an open internal discharge, so the
// pressure vessel only ever holds ~260 C gas
connect('hx-1', 'hx-1-shell-2', 'tank-sg-1', 'tank-sg-in',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: 1, toElevation: 2, flowArea: 2.0, length: 2, resistanceCoeff: 0.5 });
// Vessel space -> circulator (dome suction) -> coaxial duct ANNULUS -> RPV
// downcomer, entering LOW on the vessel (the duct elevation). The annulus is
// now DOWNSTREAM of the circulator, as in the real plant.
connect('tank-sg-1', 'tank-sg-top', 'pump-1', 'pump-1-inlet',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: 15.5, toElevation: 0, flowArea: 0.6, length: 2, resistanceCoeff: 1 });
connect('pump-1', 'pump-1-outlet', 'cv-1', 'cv-1-annulus-2',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: 0, toElevation: 0.25, flowArea: 1.0, length: 2, resistanceCoeff: 1 });
connect('cv-1', 'cv-1-annulus-1', 'rv-1', 'rv-1-cold-leg',
  { initialFlowRate: HE_FLOW_INIT, fromElevation: 0.25, toElevation: 5, flowArea: 1.0, length: 3, resistanceCoeff: 1.5 });

// ---------------------------------------------------------------------------
// Secondary loop connections (water/steam)
// ---------------------------------------------------------------------------
// Feedwater into the tube bundles at the bottom. The feed header splits to
// both bundles, each line carrying half the flow area so the SG sees the same
// total feed resistance as it did with one bundle.
// K = 600, not 2: these are the bundle ORIFICES. Two bundles fed from one
// header with no resistance of their own share flow by whichever happens to
// be boiling less, which is unstable - one bundle floods while the other
// dries. A real once-through SG orifices each inlet hard so the split is set
// by geometry instead of by the boiling state.
connect('val-fwcv-1', 'val-fwcv-1-out', 'hx-1', 'hx-1-tube-1',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW / 2, fromElevation: 0, toElevation: 1, flowArea: 0.015, length: 8, resistanceCoeff: 600 });
connect('val-fwcv-1', 'val-fwcv-1-out', 'hx-1', 'hx-1-tube-1-b2',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW / 2, fromElevation: 0, toElevation: 1, flowArea: 0.015, length: 8, resistanceCoeff: 600 });
// Main steam out of the top of the bundle to the turbine.
// In this model the turbine NODE floats near condenser pressure and the whole
// throttling drop is taken across its inlet connection, so this area is what
// sets rated steam flow - not `ratedSteamFlow`, which only caps work
// extraction. Sized for ~77 kg/s at the 165 bar design drop; a once-through
// bundle has no two-phase pool to pin its pressure, so an oversized inlet
// simply blows the tube side down to the condenser in seconds.
// Main steam off the very top of the bundle - the elevated takeoff draws
// VAPOR, and the OTSG model hands it the superheat section's enthalpy.
// Both bundles discharge into the same main steam line, each through half the
// area, so the two in parallel present the throttle the single bundle did.
connect('hx-1', 'hx-1-tube-2', 'turbine-1', 'inlet',
  { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW / 2, fromElevation: 13.5, toElevation: 0, flowArea: 0.006, length: 25, resistanceCoeff: 2,
    fromPhaseTolerance: 0 });
connect('hx-1', 'hx-1-tube-2-b2', 'turbine-1', 'inlet',
  { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW / 2, fromElevation: 13.5, toElevation: 0, flowArea: 0.006, length: 25, resistanceCoeff: 2,
    fromPhaseTolerance: 0 });
connect('turbine-1', 'outlet', 'condenser-1', 'condenser-1-inlet',
  { initialFlowPhase: 'vapor', initialFlowRate: FEED_FLOW - 25, fromElevation: 0, toElevation: 4, flowArea: 0.5, length: 6 });
connect('condenser-1', 'condenser-1-bottom', 'cond-pump-1', 'cond-pump-1-inlet',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0.1, toElevation: 0, flowArea: 0.2, length: 4 });
connect('cond-pump-1', 'cond-pump-1-outlet', 'fw-pump-1', 'fw-pump-1-inlet',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 4 });
// Feed train: pump -> HP heater tubes -> check valve -> SG bundles
connect('fw-pump-1', 'fw-pump-1-outlet', 'fwh-1', 'fwh-1-tube-1',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 4 });

// Steam dump: off the main steam line, discharging into the condenser
// Dump capacity ~40 kg/s at the setpoint (choked) - about 70% of full
// steam generation. The 0.01 m2 line passed ~210 kg/s, four times
// generation, and every lift became a blowdown spiral: P crashed, the
// pump flooded the boiler 10 t past design, and recovery took half an
// hour of simulated time.
// One dump valve on the common header, but a tap off EACH bundle: the tube
// side is a pressure boundary per bundle, and with the governor shut a bundle
// whose only outlet is the throttled turbine line has no relief path at all.
// 0.0015 m2 per tap (~60 kg/s total choked), up from 0.001 (~40): with the
// partition publishing honest pressures the startup boil-off is real steam
// that has to leave through SOMETHING while the turbine rolls, and 40 kg/s
// of dump against ~150 MW of duty let the boiler compress to the dome top.
connect('hx-1', 'hx-1-tube-2', 'val-msv-1', 'val-msv-1-in',
  { fromElevation: 13.5, toElevation: 0, flowArea: 0.0015, length: 4, resistanceCoeff: 2,
    fromPhaseTolerance: 0 });
connect('hx-1', 'hx-1-tube-2-b2', 'val-msv-1', 'val-msv-1-in',
  { fromElevation: 13.5, toElevation: 0, flowArea: 0.0015, length: 4, resistanceCoeff: 2,
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
// Feedwater heater: tube side in the feed train, shell side on turbine bleed
// ---------------------------------------------------------------------------
connect('fwh-1', 'fwh-1-tube-2', 'val-fwcv-1', 'val-fwcv-1-in',
  { initialFlowPhase: 'liquid', initialFlowRate: FEED_FLOW, fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 4, resistanceCoeff: 2 });
// Extraction tap off the main steam line. 0.004 m2, not 0.0008: a single HP
// heater lifting 77 kg/s of feed from condensate temperature to 200 C needs
// ~53 MW = ~25 kg/s of extraction steam - a THIRD of the steam flow, which
// is what doing five heaters' work in one costs. The 0.0008 line choked at
// ~4 kg/s and the heater could never make its duty at design flow.
// fromElevation 13.5 - the TOP of the tube, like the MSV taps. At 0 the
// tap sat at the bottom of the bundle, inside the subcooled slug, and the
// "extraction steam" line drew boiler WATER at whatever the line would
// pass (120 kg/s once it was sized for real extraction) - which is also
// why the feedwater heater could never make its duty: it was being fed
// its own feedwater.
// Tapped off BOTH bundles, like the MSV: a single-bundle tap carries the
// whole extraction from one side and Ledinegg-tilts the pair.
connect('hx-1', 'hx-1-tube-2', 'val-bleed-1', 'val-bleed-1-in',
  { initialFlowPhase: 'vapor', initialFlowRate: 12.5, fromElevation: 13.5, toElevation: 0, flowArea: 0.002, length: 20, resistanceCoeff: 6 });
connect('hx-1', 'hx-1-tube-2-b2', 'val-bleed-1', 'val-bleed-1-in',
  { initialFlowPhase: 'vapor', initialFlowRate: 12.5, fromElevation: 13.5, toElevation: 0, flowArea: 0.002, length: 20, resistanceCoeff: 6 });
connect('val-bleed-1', 'val-bleed-1-out', 'fwh-1', 'fwh-1-shell-1',
  { initialFlowPhase: 'vapor', initialFlowRate: 25, fromElevation: 0, toElevation: 0, flowArea: 0.004, length: 6, resistanceCoeff: 2 });
// Shell drain cascades to the condenser. Valve-side elevations are pinned
// to the valve port (0.1 m for a 0.1 m valve) - an earlier toElevation of 3
// claimed a 3 m attachment on a 0.2 m-tall valve, which drew the connection
// line in midair and put a phantom 3 m gravity head across the valve. The
// lift into the elevated condenser belongs on the condenser side (its inlet
// sits 3 m up the shell, 6 m absolute).
connect('fwh-1', 'fwh-1-shell-2', 'val-fwhdr-1', 'val-fwhdr-1-in',
  { initialFlowPhase: 'liquid', initialFlowRate: 25, fromElevation: 0, toElevation: 0.1, flowArea: 0.01, length: 8, resistanceCoeff: 4 });
connect('val-fwhdr-1', 'val-fwhdr-1-out', 'condenser-1', 'condenser-1-inlet',
  { initialFlowPhase: 'liquid', initialFlowRate: 25, fromElevation: 0.1, toElevation: 3, flowArea: 0.01, length: 8, resistanceCoeff: 8 });

// ---------------------------------------------------------------------------
const out = { components, connections };
const target = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${target}: ${components.length} components, ${connections.length} connections`);
