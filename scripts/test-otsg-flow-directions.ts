/**
 * Once-through boiler: flows the design never intended.
 *
 * A moving-boundary bundle is drawn for one arrangement - feed in at the
 * bottom, steam out at the top, hot gas down over the tubes - and the model
 * used to assume it: the feed marched up from the bottom, the steam from the
 * boiling boundary, the gas from the steam end, whatever the flows were
 * actually doing. This suite runs the bundle in the arrangements nobody
 * designs for, because a plant gets into them by accident:
 *
 *  - the shell gas running feed end to steam end;
 *  - steam driven BACKWARDS through the tube (a header hotter and at higher
 *    pressure than the tube, the feed end open to something lower);
 *  - cold water backing in at the TOP of a steaming tube;
 *  - a tube side HOTTER than the gas, heating it;
 *  - nothing flowing anywhere.
 *
 * The rig is a bundle between four big tanks (two helium, two water), so
 * each side's flow goes whichever way its tanks' pressures send it. No
 * controllers, no pumps: nothing to mask a direction error.
 *
 * What is checked is direction and conservation, not numbers: that heat goes
 * from hot to cold, that a stream is heated starting from the end it enters
 * by, that the economizer's book never claims more than the tube holds, and
 * that nothing throws or complains.
 *
 * Usage: npx tsx scripts/test-otsg-flow-directions.ts      (VERBOSE=1 for the states)
 */

import { buildSim, run, test, assert, report, Sim } from './lib/sim-harness';
import {
  evaluateOtsgSections, otsgMetalZones, otsgWaterSideDuties, otsgGasDuties, otsgGasInletTemp,
} from '../src/simulation/operators/otsg-operator';
import { saturationPressure } from '../src/simulation/water-properties';
import type { PlantComponent, PlantConnection } from '../src/types';
import type { SimulationState, FlowNode } from '../src/simulation/types';

const P_TRACE_STEAM = 700;   // Pa - gas nodes carry only a trace of water
const HX_HEIGHT = 14;        // m
const TANK_HEIGHT = 6;       // m
const TUBE = 'hx-tube';
const SHELL = 'hx-shell';
/** m - the rig tanks are tens of metres across; a wall this thick holds them */
const WALL = 5;

interface Gas { T: number; bar: number }
/** A water tank: steam at (T, P), or liquid at T under a nitrogen cushion
 *  that holds it at P - a liquid-full tank is no pressure source at all, it
 *  gives up its pressure with its first few hundred kilograms. */
interface Water { T: number; P: number; phase: 'liquid' | 'vapor' }

function tankPorts(id: string) {
  return [
    { id: `${id}-top`, position: { x: 0, y: -TANK_HEIGHT / 2 }, direction: 'both' },
    { id: `${id}-bottom`, position: { x: 0, y: TANK_HEIGHT / 2 }, direction: 'both' },
  ];
}

function heTank(id: string, g: Gas): [string, PlantComponent] {
  const volume = 4000;
  return [id, {
    id, type: 'tank', label: id,
    position: { x: 0, y: 0 }, rotation: 0, elevation: 0,
    pressureRating: 500, width: 2 * Math.sqrt(volume / (Math.PI * TANK_HEIGHT)), height: TANK_HEIGHT,
    wallThickness: WALL, fillLevel: 0,
    initialNcg: { He: g.bar },
    ports: tankPorts(id),
    fluid: { temperature: g.T, pressure: P_TRACE_STEAM, phase: 'vapor', quality: 1, flowRate: 0 },
  } as unknown as PlantComponent];
}

function waterTank(id: string, w: Water): [string, PlantComponent] {
  const volume = w.phase === 'liquid' ? 600 : 3000;
  const base = {
    id, type: 'tank', label: id,
    position: { x: 0, y: 0 }, rotation: 0, elevation: 0,
    pressureRating: 500, width: 2 * Math.sqrt(volume / (Math.PI * TANK_HEIGHT)), height: TANK_HEIGHT,
    wallThickness: WALL,
    ports: tankPorts(id),
  };
  if (w.phase === 'vapor') {
    return [id, {
      ...base, fillLevel: 0,
      fluid: { temperature: w.T, pressure: w.P, phase: 'vapor', quality: 1, flowRate: 0 },
    } as unknown as PlantComponent];
  }
  // Half full of water at its own saturation pressure, nitrogen making up
  // the rest of the pressure above it.
  const PSat = saturationPressure(w.T);
  if (!(w.P > PSat)) throw new Error(`${id}: ${w.T} K water needs more than ${PSat} Pa to stay liquid`);
  return [id, {
    ...base, fillLevel: 0.5,
    initialNcg: { N2: (w.P - PSat) / 1e5 },
    fluid: { temperature: w.T, pressure: PSat, phase: 'two-phase', quality: 0, flowRate: 0 },
  } as unknown as PlantComponent];
}

interface TubeStart { T: number; P: number; phase: 'liquid' | 'two-phase' | 'vapor'; quality?: number }

function otsg(tube: TubeStart, shell: Gas): [string, PlantComponent] {
  const halfW = 1.4, halfH = HX_HEIGHT / 2, plenum = 0.8;
  const tubeState = { temperature: tube.T, pressure: tube.P, phase: tube.phase, quality: tube.quality ?? 0, flowRate: 0 };
  const shellState = { temperature: shell.T, pressure: P_TRACE_STEAM, phase: 'vapor', quality: 1, flowRate: 0 };
  return ['hx', {
    id: 'hx', type: 'heatExchanger', label: 'OTSG',
    position: { x: 0, y: 0 }, rotation: 0, elevation: 0,
    width: 2 * halfW, height: 2 * halfH,
    hxType: 'helical', tubeCount: 300, tubeModel: 'moving-boundary',
    material: 'alloy-800h',
    pressureRating: 90, tubePressureRating: 200, shellPressureRating: 90,
    plenumLength: plenum, tubeOD: 0.019,
    ports: [
      { id: 'hx-tube-bottom', position: { x: 0, y: halfH + plenum }, direction: 'both' },
      { id: 'hx-tube-top', position: { x: 0, y: -halfH - plenum }, direction: 'both' },
      { id: 'hx-shell-top', position: { x: -halfW, y: -halfH * 0.8 }, direction: 'both' },
      { id: 'hx-shell-bottom', position: { x: halfW, y: halfH * 0.8 }, direction: 'both' },
    ],
    tubeFluid: tubeState, primaryFluid: tubeState,
    shellFluid: shellState, secondaryFluid: shellState,
    shellInitialNcg: { He: shell.bar },
  } as unknown as PlantComponent];
}

/** A line from a tank (off its floor for water, its roof for gas and steam)
 *  to a bundle nozzle `hxElev` metres up the bundle. */
function line(tank: string, low: boolean, hxPort: string, hxElev: number, area: number): PlantConnection {
  return {
    fromComponentId: tank, fromPortId: `${tank}-${low ? 'bottom' : 'top'}`,
    toComponentId: 'hx', toPortId: hxPort,
    flowArea: area, length: 3, resistanceCoeff: 2,
    fromElevation: low ? 0.2 : TANK_HEIGHT - 0.2, toElevation: hxElev,
  } as unknown as PlantConnection;
}

interface RigSpec {
  /** helium tank on the shell's TOP nozzle (the steam end) and on its bottom one */
  gasTop: Gas; gasBottom: Gas;
  /** water tank on the tube's BOTTOM nozzle (the feed end) and on its top one */
  waterBottom: Water; waterTop: Water;
  tube: TubeStart;
  /** the shell's own starting gas; default midway between its tanks */
  shell?: Gas;
  /** m2 - line areas; small, so a tank lasts the run */
  gasLine?: number; bottomLine?: number; topLine?: number;
}

function rig(spec: RigSpec): Sim {
  const shell = spec.shell ?? {
    T: 0.5 * (spec.gasTop.T + spec.gasBottom.T),
    bar: 0.5 * (spec.gasTop.bar + spec.gasBottom.bar),
  };
  return buildSim([
    heTank('gas-top', spec.gasTop),
    heTank('gas-bottom', spec.gasBottom),
    waterTank('water-bottom', spec.waterBottom),
    waterTank('water-top', spec.waterTop),
    otsg(spec.tube, shell),
  ], [
    line('gas-top', false, 'hx-shell-top', HX_HEIGHT - 1, spec.gasLine ?? 0.012),
    line('gas-bottom', false, 'hx-shell-bottom', 1, spec.gasLine ?? 0.012),
    line('water-bottom', spec.waterBottom.phase === 'liquid', 'hx-tube-bottom', 0, spec.bottomLine ?? 0.0006),
    line('water-top', spec.waterTop.phase === 'liquid', 'hx-tube-top', HX_HEIGHT, spec.topLine ?? 0.004),
  ]);
}

// ---------------------------------------------------------------------------
// Reading the rig
// ---------------------------------------------------------------------------

const C = (T: number) => (T - 273.15).toFixed(0);

/** kg/s INTO the bundle side `nodeId` from tank `tankId` (negative = out to it). */
function flowFrom(state: SimulationState, tankId: string, nodeId: string): number {
  let w = 0;
  for (const c of state.flowConnections) {
    if (c.fromNodeId === tankId && c.toNodeId === nodeId) w += c.massFlowRate;
    else if (c.toNodeId === tankId && c.fromNodeId === nodeId) w -= c.massFlowRate;
  }
  return w;
}

function tubeNode(state: SimulationState): FlowNode {
  const node = state.flowNodes.get(TUBE);
  if (!node?.otsg) throw new Error('the rig built no moving-boundary tube node');
  return node;
}

const zoneTemps = (state: SimulationState) => otsgMetalZones(state, tubeNode(state)).map(z => z.temperature);

/** Heat the gas gives each metal zone, W. */
function gasDuties(state: SimulationState): number[] {
  const node = tubeNode(state);
  return otsgGasDuties(state, state.flowNodes.get(SHELL)!, zoneTemps(state), node.otsg!.heatArea, node.otsg!.gasShare ?? 1);
}

function waterDuties(state: SimulationState) {
  const node = tubeNode(state);
  const { ev, flows } = evaluateOtsgSections(state, TUBE, node, { exact: true });
  return { ev, flows, d: otsgWaterSideDuties(ev, flows, zoneTemps(state), node.otsg!.heatArea) };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Run, checking as it goes that the tube stays a describable boiler: the
 * partition solves, its sections hold the node's mass and fill the tube, the
 * economizer's book never claims more than the node holds, and the metal
 * stays at a temperature metal can have. Anything the boiler model reports
 * on console.error counts as a failure too. `onTick` sees every tick.
 */
function runChecked(
  sim: Sim, seconds: number, label: string, onTick?: (state: SimulationState) => void,
): SimulationState {
  const complaints: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.includes('[OTSG]')) complaints.push(text.slice(0, 300));
  };
  let tick = 0;
  try {
    run(sim, seconds, 0.05, state => {
      onTick?.(state);
      if (tick++ % 5 !== 0) return;
      const node = tubeNode(state);
      if (!(node.fluid.mass > 0)) return;
      const at = `${label}, t=${state.time.toFixed(2)}`;
      const { ev } = evaluateOtsgSections(state, TUBE, node, { exact: true });
      const m = ev.sections.reduce((a, s) => a + s.mass, 0);
      const V = ev.sections.reduce((a, s) => a + s.volume, 0);
      assert(Math.abs(m - node.fluid.mass) < 1e-6 * node.fluid.mass,
        `${at}: sections hold ${m} kg of the node's ${node.fluid.mass}`);
      assert(ev.regime === 'supercritical' || Math.abs(V - node.volume) < 2e-3 * node.volume,
        `${at}: sections fill ${V} m3 of a ${node.volume} m3 tube`);
      assert(node.otsg!.m1 >= 0 && node.otsg!.m1 <= node.fluid.mass * (1 + 1e-9),
        `${at}: economizer ledger ${node.otsg!.m1} kg against ${node.fluid.mass} kg in the tube`);
      for (const T of zoneTemps(state)) {
        assert(T > 250 && T < 1500, `${at}: tube metal at ${T} K`);
      }
    });
  } catch (e) {
    console.error = origError;
    if (process.env.OTSG_STACK) console.error((e as Error).stack);
    throw new Error(`${label} failed at t=${sim.state.time.toFixed(2)} s: ${(e as Error).message.slice(0, 400)}`);
  }
  console.error = origError;
  assert(complaints.length === 0,
    `${label}: the boiler model complained ${complaints.length} time(s), first: ${complaints[0]}`);
  return sim.state;
}

function describe(state: SimulationState): string {
  const node = tubeNode(state);
  const { ev, flows } = evaluateOtsgSections(state, TUBE, node, { exact: true });
  const zT = zoneTemps(state);
  const shell = state.flowNodes.get(SHELL)!;
  return `tube ${(ev.P / 1e5).toFixed(1)} bar '${ev.regime}' L=${ev.sections.map(s => (100 * s.lengthFrac).toFixed(0)).join('/')}% ` +
    `m=${node.fluid.mass.toFixed(0)} kg, steam end ${C(ev.TSteamOut)} C; ` +
    `water in: bottom ${flowFrom(state, 'water-bottom', TUBE).toFixed(2)}, top ${flowFrom(state, 'water-top', TUBE).toFixed(2)} kg/s ` +
    `(economizer takes ${flows.WFeed.toFixed(2)}); metal ${C(zT[0])}..${C(zT[zT.length - 1])} C (feed..steam end); ` +
    `gas in: top ${flowFrom(state, 'gas-top', SHELL).toFixed(1)}, bottom ${flowFrom(state, 'gas-bottom', SHELL).toFixed(1)} kg/s, ` +
    `arriving ${C(otsgGasInletTemp(state, shell))} C, shell ${C(shell.fluid.temperature)} C`;
}

const verbose = !!process.env.VERBOSE;
const note = (label: string, state: SimulationState) => {
  if (verbose) console.log(`  [${label}] ${describe(state)}`);
};

// ---------------------------------------------------------------------------
// The arrangements
// ---------------------------------------------------------------------------

const HOT_GAS: Gas = { T: 1023, bar: 70 };
const GAS_SINK: Gas = { T: 533, bar: 50 };
const STILL_GAS: Gas = { T: 620, bar: 60 };
const FEED: Water = { T: 450, P: 110e5, phase: 'liquid' };
const STEAM_SINK: Water = { T: 560, P: 30e5, phase: 'vapor' };
const BOILING_TUBE: TubeStart = { T: 543, P: 55e5, phase: 'two-phase', quality: 0.05 };

test('Design arrangement: feed up, gas down, hot end at the steam end', () => {
  const state = runChecked(rig({
    gasTop: HOT_GAS, gasBottom: GAS_SINK,
    waterBottom: FEED, waterTop: STEAM_SINK,
    tube: BOILING_TUBE,
  }), 25, 'forward');
  note('forward', state);
  const { ev, flows } = waterDuties(state);
  assert(flowFrom(state, 'water-bottom', TUBE) > 0.5, 'feed flows in at the bottom');
  assert(flowFrom(state, 'water-top', TUBE) < -0.5, 'steam flows out at the top');
  assert(flowFrom(state, 'gas-top', SHELL) > 2, 'gas flows in at the top');
  assert(flows.WFeed > 0.5, `the economizer takes the feed (${flows.WFeed.toFixed(2)} kg/s)`);
  assert(ev.TSteamOut > ev.sat.T + 20,
    `steam leaves superheated: ${C(ev.TSteamOut)} C against saturation at ${C(ev.sat.T)} C`);
  const q = gasDuties(state);
  const n = q.length;
  assert(mean(q.slice(n - 5)) > 0 && mean(q.slice(n - 5)) > mean(q.slice(0, 5)),
    `the gas gives up most where it enters, at the steam end: ${(mean(q.slice(n - 5)) / 1e3).toFixed(0)} kW/zone ` +
    `there against ${(mean(q.slice(0, 5)) / 1e3).toFixed(0)} at the feed end`);
});

test('Shell gas reversed: it is cooled from the end it enters by', () => {
  // Same bundle, the helium tanks swapped: hot gas in at the BOTTOM nozzle.
  // The march used to run steam end to feed end regardless, so it cooled the
  // gas from the end it leaves by.
  const state = runChecked(rig({
    gasTop: GAS_SINK, gasBottom: HOT_GAS,
    waterBottom: FEED, waterTop: STEAM_SINK,
    tube: BOILING_TUBE,
  }), 25, 'gas reversed');
  note('gas reversed', state);
  assert(flowFrom(state, 'gas-bottom', SHELL) > 2, 'gas flows in at the bottom');
  assert(flowFrom(state, 'gas-top', SHELL) < -2, 'and out at the top');
  const q = gasDuties(state);
  const n = q.length;
  assert(mean(q.slice(0, 5)) > 0 && mean(q.slice(0, 5)) > mean(q.slice(n - 5)),
    `the gas gives up most where it enters, at the feed end: ${(mean(q.slice(0, 5)) / 1e3).toFixed(0)} kW/zone ` +
    `there against ${(mean(q.slice(n - 5)) / 1e3).toFixed(0)} at the steam end`);
  const shell = state.flowNodes.get(SHELL)!;
  assert(shell.fluid.temperature < otsgGasInletTemp(state, shell) - 50,
    `the gas leaves colder than it arrived: shell ${C(shell.fluid.temperature)} C, arriving ${C(otsgGasInletTemp(state, shell))} C`);
});

test('Steam driven backwards: it is cooled from the steam end down', () => {
  // A header of hot, high-pressure steam on the top nozzle, the feed end open
  // to a low-pressure tank, no gas flow. Steam enters at the top hotter than
  // the metal and runs DOWN the tube. The steam pass used to see no stream at
  // all here (its transit was "what leaves by the top"), so the tube metal
  // was heated evenly by standing steam instead of hardest where the steam
  // comes in.
  const sim = rig({
    gasTop: STILL_GAS, gasBottom: STILL_GAS,
    waterBottom: { T: 400, P: 15e5, phase: 'liquid' },
    waterTop: { T: 800, P: 100e5, phase: 'vapor' },
    tube: { T: 620, P: 40e5, phase: 'vapor', quality: 1 },
    bottomLine: 0.002, topLine: 0.002,
  });
  let checked = false;
  const state = runChecked(sim, 12, 'steam reversed', s => {
    // Read it early, while the metal is still near its starting temperature
    // everywhere and the only thing that differs along the tube is the steam
    if (checked || s.time < 2) return;
    checked = true;
    note('steam reversed, t=2', s);
    assert(flowFrom(s, 'water-top', TUBE) > 0.5, 'steam flows IN at the top');
    assert(flowFrom(s, 'water-bottom', TUBE) < -0.2, 'and the tube empties out of the bottom');
    const { ev, d } = waterDuties(s);
    assert(ev.sections[2].lengthFrac > 0.5, `the tube is mostly steam (${(100 * ev.sections[2].lengthFrac).toFixed(0)}%)`);
    const n = d.zoneQ3.length;
    const top = mean(d.zoneQ3.slice(n - 4)), low = mean(d.zoneQ3.slice(n - 16, n - 12));
    assert(top < 0, `steam arriving hotter than the metal heats it: ${(top / 1e3).toFixed(1)} kW/zone at the steam end`);
    assert(top < 2 * low,
      `hardest where it arrives: ${(top / 1e3).toFixed(1)} kW/zone at the steam end against ${(low / 1e3).toFixed(1)} a third of the way down`);
    assert(ev.TSteamOut > ev.sections[2].T + 20,
      `the steam nozzle reads the steam arriving (${C(ev.TSteamOut)} C), hotter than the section's mean (${C(ev.sections[2].T)} C)`);
  });
  note('steam reversed', state);
  assert(checked, 'the run reached its early check');
  const zT = zoneTemps(state);
  assert(zT[zT.length - 1] > zT[Math.floor(zT.length / 2)] + 5,
    `the steam end's metal has warmed most: ${C(zT[zT.length - 1])} C against ${C(zT[Math.floor(zT.length / 2)])} C mid-tube`);
});

test('Cold water backing in at the top quenches the steam; it is not feed', () => {
  // A steaming tube whose top nozzle starts taking cold water (a flooded
  // steam line draining back) with its feed end open to a lower pressure.
  // That water lands in the steam and boiling sections and condenses them. It
  // used to be booked straight into the economizer - teleported to the bottom
  // of the tube - at the feed end's enthalpy rather than its own.
  const sim = rig({
    gasTop: STILL_GAS, gasBottom: STILL_GAS,
    waterBottom: { T: 400, P: 15e5, phase: 'liquid' },
    waterTop: { T: 330, P: 100e5, phase: 'liquid' },
    tube: { T: 543, P: 55e5, phase: 'two-phase', quality: 0.6 },
    bottomLine: 0.0003, topLine: 0.0003,
  });
  let checked = false;
  let steamAtCheck = NaN;
  const metalAtStart = mean(zoneTemps(sim.state));
  const state = runChecked(sim, 20, 'water in at the top', s => {
    if (checked || s.time < 1) return;
    checked = true;
    note('water in at the top, t=1', s);
    const { ev, flows } = evaluateOtsgSections(s, TUBE, tubeNode(s), { exact: true });
    steamAtCheck = ev.sections[2].lengthFrac;
    const wTop = flowFrom(s, 'water-top', TUBE);
    assert(wTop > 0.5, `cold water flows in at the top (${wTop.toFixed(2)} kg/s)`);
    assert(ev.sections[0].lengthFrac < 0.9, 'the tube is not yet solid water');
    assert(flows.WFeed < 0.2 * wTop,
      `water entering above the economizer is not booked to it: ${flows.WFeed.toFixed(2)} of ${wTop.toFixed(2)} kg/s`);
  });
  note('water in at the top', state);
  assert(checked, 'the run reached its early check');
  // The tube itself stays at saturation while there is hot metal to boil the
  // water on - what the cold water costs shows up as steam condensed and
  // metal cooled.
  const { ev } = evaluateOtsgSections(state, TUBE, tubeNode(state), { exact: true });
  assert(ev.sections[2].lengthFrac < steamAtCheck - 0.2,
    `the water has condensed steam: ${(100 * ev.sections[2].lengthFrac).toFixed(0)}% of the tube is steam, ` +
    `from ${(100 * steamAtCheck).toFixed(0)}%`);
  const metalNow = mean(zoneTemps(state));
  assert(metalNow < metalAtStart - 8,
    `and cooled the metal: ${C(metalNow)} C mean from ${C(metalAtStart)} C`);
});

test('Tube side hotter than the gas: the water heats the gas', () => {
  // Cold helium over a bundle carrying hot pressurized water. Every wall
  // exchange has to run backwards, and the gas has to be marched in at ITS
  // temperature - it used to be marched in at the hottest thing in sight,
  // the shell's own bulk.
  const state = runChecked(rig({
    gasTop: { T: 350, bar: 70 }, gasBottom: { T: 350, bar: 50 },
    waterBottom: { T: 560, P: 130e5, phase: 'liquid' },
    waterTop: { T: 580, P: 80e5, phase: 'vapor' },
    tube: { T: 560, P: 100e5, phase: 'liquid' },
    shell: { T: 350, bar: 60 },
    bottomLine: 0.002, topLine: 0.002,
  }), 25, 'hot secondary');
  note('hot secondary', state);
  const shell = state.flowNodes.get(SHELL)!;
  const TArr = otsgGasInletTemp(state, shell);
  assert(flowFrom(state, 'gas-top', SHELL) > 2, 'gas flows in at the top');
  assert(TArr < 400, `the gas arrives cold (${C(TArr)} C)`);
  assert(shell.fluid.temperature > TArr + 50,
    `and leaves heated: shell ${C(shell.fluid.temperature)} C against ${C(TArr)} C arriving`);
  const q = gasDuties(state);
  assert(q.every(x => x <= 1e-6), `every zone's metal heats the gas (most positive ${(Math.max(...q) / 1e3).toFixed(2)} kW)`);
  const { d } = waterDuties(state);
  assert(d.Q1 + d.Q2 + d.Q3 < 0, `and the water heats the metal (${((d.Q1 + d.Q2 + d.Q3) / 1e6).toFixed(2)} MW into the water)`);
  const zT = zoneTemps(state);
  const TWater = tubeNode(state).fluid.temperature;
  assert(Math.min(...zT) > TArr - 1 && Math.max(...zT) < Math.max(TWater, 560) + 5,
    `the metal sits between its two fluids: ${C(Math.min(...zT))}..${C(Math.max(...zT))} C, gas arriving ${C(TArr)} C, water ${C(TWater)} C`);
});

test('Nothing driving any flow: the bundle settles and sits there', () => {
  // Every tank at the tube's own pressure, the gas tanks at the shell's. The
  // tube's water drains to the lower tank under its own weight and then
  // nothing moves; the model has to be content with no stream on either side.
  const still: Water = { T: 543, P: 55e5, phase: 'vapor' };
  const state = runChecked(rig({
    gasTop: STILL_GAS, gasBottom: STILL_GAS,
    waterBottom: still, waterTop: still,
    tube: BOILING_TUBE,
    shell: STILL_GAS,
  }), 10, 'stagnant');
  note('stagnant', state);
  assert(tubeNode(state).fluid.mass > 0, 'the tube still holds something');
  assert(Math.abs(flowFrom(state, 'water-bottom', TUBE)) < 2 && Math.abs(flowFrom(state, 'water-top', TUBE)) < 2,
    'and its lines have all but stopped');
  assert(Math.abs(flowFrom(state, 'gas-top', SHELL)) < 0.5, 'as has the gas');
});

report('OTSG Flow-Direction Suite');
