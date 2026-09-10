/**
 * Regression suite for CAR BZ1bOwQ0oLXY0q8jG1hU (a service-water pump that
 * drained a spent fuel pool into the sea and then froze):
 *
 *   1. A pump connection drawn from the pump's INLET port is oriented by its
 *      ports (inlet on the to-side), the route reversed, and the factory
 *      refuses a plant that still runs against its pump.
 *   2. Built that way, the pump moves water from the tank on its inlet to the
 *      tank on its outlet - whichever end the user started the pipe at.
 *   3. Draw pricing: an air-blanketed tank draining through an opening that
 *      straddles its interface hands each kilogram over at the enthalpy of
 *      the water actually leaving. The upstream tank's temperature must not
 *      run away (it fell 5 K/s in the report).
 *
 *   npx tsx scripts/test-pump-line.ts
 */

import { test, assert, report, buildSim, run, nodeMass } from './lib/sim-harness';
import {
  orientConnectionByPumpPorts,
  runsAgainstPump,
  pumpPortRole,
} from '../src/construction/connection-orientation';
import { createSimulationFromPlant } from '../src/simulation';
import { saturationPressure } from '../src/simulation/water-properties';
import type { PlantComponent, PlantState, Connection } from '../src/types';

// ---------------------------------------------------------------------------
// A small plant: two atmospheric tanks at the same elevation, a pump between
// them, drawn the "wrong way" (suction line started at the pump).
// ---------------------------------------------------------------------------

function tank(id: string, x: number, level: number, T: number): [string, PlantComponent] {
  // Same conventions as the level/preset JSON: a square tank `width` on a
  // side, `fillLevel`, fluid.pressure = the STEAM partial (saturation at T)
  // with the air blanket given as partial pressures in bar
  return [id, {
    id, type: 'tank', label: id,
    position: { x, y: 0 }, rotation: 0,
    elevation: 0, height: 6, width: 4, fillLevel: level, pressureRating: 2,
    fluid: { temperature: T, pressure: saturationPressure(T), phase: 'two-phase', quality: 1e-4, flowRate: 0 },
    initialNcg: { N2: 0.79, O2: 0.21 },
    ports: [
      { id: `${id}-bottom`, position: { x: 0, y: 0 }, direction: 'both' },
      { id: `${id}-side`, position: { x: 2, y: 3 }, direction: 'both' },
    ],
  } as unknown as PlantComponent];
}

function pump(id: string, x: number): [string, PlantComponent] {
  return [id, {
    id, type: 'pump', label: id,
    position: { x, y: 0 }, rotation: 0,
    elevation: 0, diameter: 0.4, orientation: 'bottom-top',
    running: true, speed: 1, ratedFlow: 50, ratedHead: 20, pumpType: 'centrifugal',
    ports: [
      { id: `${id}-inlet`, position: { x: 0, y: 0 }, direction: 'in' },
      { id: `${id}-outlet`, position: { x: 0, y: 0.4 }, direction: 'out' },
    ],
  } as unknown as PlantComponent];
}

function backwardsPlant(): { components: Array<[string, PlantComponent]>; connections: Connection[] } {
  const components: Array<[string, PlantComponent]> = [
    tank('src', 0, 0.8, 300), pump('pum', 10), tank('dst', 20, 0.2, 300),
  ];
  const connections: Connection[] = [
    // Suction line drawn FROM the pump's inlet TO the source tank
    { fromComponentId: 'pum', fromPortId: 'pum-inlet', toComponentId: 'src', toPortId: 'src-bottom',
      fromElevation: 0, toElevation: 0, flowArea: 0.05, length: 10, route: [{ x: 10, y: 0 }, { x: 0, y: 0 }] },
    // Discharge drawn FROM the destination tank TO the pump's outlet
    { fromComponentId: 'dst', fromPortId: 'dst-bottom', toComponentId: 'pum', toPortId: 'pum-outlet',
      fromElevation: 0, toElevation: 0.4, flowArea: 0.05, length: 10 },
  ];
  return { components, connections };
}

// ---------------------------------------------------------------------------
// 1. Orientation
// ---------------------------------------------------------------------------

test('a pump connection drawn from the inlet is reversed, ports and route included', () => {
  const { components, connections } = backwardsPlant();
  const comps = new Map(components);
  assert(pumpPortRole(comps.get('pum'), 'pum-inlet') === 'inlet', 'inlet role');
  assert(pumpPortRole(comps.get('pum'), 'pum-outlet') === 'outlet', 'outlet role');
  assert(pumpPortRole(comps.get('src'), 'src-bottom') === null, 'tank ports have no pump role');
  assert(runsAgainstPump(connections[0], comps) && runsAgainstPump(connections[1], comps), 'both drawn against the pump');

  assert(orientConnectionByPumpPorts(connections[0], comps), 'suction line reversed');
  assert(connections[0].fromComponentId === 'src' && connections[0].toComponentId === 'pum', 'suction now src -> pump');
  assert(connections[0].toPortId === 'pum-inlet' && connections[0].fromPortId === 'src-bottom', 'ports swapped with the ends');
  assert(connections[0].route![0].x === 0 && connections[0].route![1].x === 10, 'route reversed');
  assert(orientConnectionByPumpPorts(connections[1], comps), 'discharge line reversed');
  assert(connections[1].fromComponentId === 'pum' && connections[1].fromElevation === 0.4 && connections[1].toElevation === 0,
    'elevations travelled with their ends');
  assert(!orientConnectionByPumpPorts(connections[0], comps) && !orientConnectionByPumpPorts(connections[1], comps),
    'already-oriented connections are left alone');
  assert(!runsAgainstPump(connections[0], comps) && !runsAgainstPump(connections[1], comps), 'nothing runs against the pump now');
});

test('the factory refuses a plant whose connection still runs against its pump', () => {
  const { components, connections } = backwardsPlant();
  const plant: PlantState = { components: new Map(components), connections } as PlantState;
  let message = '';
  try {
    createSimulationFromPlant(plant);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message.includes('runs against its pump'), `expected the orientation error, got: ${message || 'no error'}`);
});

// ---------------------------------------------------------------------------
// 2. The pump pumps inlet -> outlet once oriented
// ---------------------------------------------------------------------------

test('once oriented, the pump moves water from its inlet tank to its outlet tank', () => {
  const { components, connections } = backwardsPlant();
  const comps = new Map(components);
  for (const c of connections) orientConnectionByPumpPorts(c, comps);
  const sim = buildSim(components, connections);
  const src0 = nodeMass(sim.state, 'src');
  const dst0 = nodeMass(sim.state, 'dst');
  const state = run(sim, 20, 0.02);
  const moved = nodeMass(state, 'dst') - dst0;
  const lost = src0 - nodeMass(state, 'src');
  const flows = state.flowConnections.map(c => `${c.id}=${c.massFlowRate.toFixed(1)}`).join(' ');
  assert(moved > 200, `destination tank gained water: ${moved.toFixed(1)} kg in 20 s (${flows})`);
  assert(Math.abs(moved - lost) < 0.05 * moved, `water conserved between the tanks (moved ${moved.toFixed(1)}, lost ${lost.toFixed(1)})`);
  const pumpState = state.components.pumps.get('pum')!;
  assert(pumpState.connectedFlowPath === 'flow-pum-dst', `head drives the discharge line, got ${pumpState.connectedFlowPath}`);
});

// ---------------------------------------------------------------------------
// 3. Draw pricing across an air-blanketed interface
// ---------------------------------------------------------------------------

test('a mostly-air pump pot draining its water does not chill', () => {
  // The report's node: a zero-height pump pot (7 m3 of casing + piping
  // inventory) holding a few hundred kg of warm water under 94% air by
  // volume. With no height to stratify over, the froth model draws a
  // liquid/gas PAIR split by the void - about 2% gas by mass - and that gas
  // is 95% air. The old pricing billed the gas share of the draw at the
  // steam enthalpy for its whole mass: ~45 kJ per kg of water leaving on
  // top of what the water held, 5 K/s of cooling until the pot froze.
  const components: Array<[string, PlantComponent]> = [
    pump('pot', 0),
    tank('low', 20, 0.10, 290),
    tank('air', -20, 0.10, 320),   // the pool's gas space in the report: keeps the pot fed with air
  ];
  Object.assign(components[0][1] as unknown as Record<string, unknown>, {
    running: false, volume: 7,
    fluid: { temperature: 320, pressure: saturationPressure(320), phase: 'liquid', quality: 0, flowRate: 0 },
    initialNcg: { N2: 0.79, O2: 0.21 },
  });
  (components[1][1] as unknown as { elevation: number }).elevation = -8;
  const connections: Connection[] = [
    { fromComponentId: 'pot', fromPortId: 'pot-outlet', toComponentId: 'low', toPortId: 'low-side',
      fromElevation: 0, toElevation: 3.0, flowArea: 0.02, length: 12 },
    { fromComponentId: 'air', fromPortId: 'air-side', toComponentId: 'pot', toPortId: 'pot-inlet',
      fromElevation: 3.0, toElevation: 0, flowArea: 0.02, length: 12 },
  ];
  const sim = buildSim(components, connections);

  // The factory fills a pump pot with liquid; set the reported inventory
  // directly: 450 kg of 320 K water and 7 m3 of air at ~1 bar, energy books
  // consistent (u_f(320 K) for the water, Cv*T for the gas)
  const pot = sim.state.flowNodes.get('pot')!;
  const nAir = 101325 * 7 / (8.314 * 320);
  pot.fluid.mass = 450;
  pot.fluid.ncg = { ...pot.fluid.ncg!, N2: 0.79 * nAir, O2: 0.21 * nAir };
  pot.fluid.internalEnergy = 450 * 196.4e3 + nAir * 20.8 * 320;
  pot.fluid.phase = 'two-phase';
  pot.fluid.quality = 1e-3;

  const m0 = pot.fluid.mass;
  let T0 = 0;
  let minT = Infinity;
  const state = run(sim, 20, 0.02, (s) => {
    const T = s.flowNodes.get('pot')!.fluid.temperature;
    if (T0 === 0) T0 = T;  // after the first constraint pass has priced the edited inventory
    minT = Math.min(minT, T);
  });
  const end = state.flowNodes.get('pot')!;
  const drainedFraction = 1 - end.fluid.mass / m0;
  const story = `${(drainedFraction * 100).toFixed(1)}% of ${m0.toFixed(0)} kg left in 20 s; T fell ` +
    `${(T0 - minT).toFixed(3)} K from ${(T0 - 273.15).toFixed(2)} C, now ${(end.fluid.temperature - 273.15).toFixed(2)} C`;
  assert(drainedFraction > 0.2, `the pot drained (${story})`);
  // What a draining pot legitimately loses: the steam its gas space holds
  // (Dalton: ~0.5 kg over 6.5 m3 at 320 K, priced properly since the gas
  // was moved to the vapour space on 2026-09-10) leaves with the froth at
  // its latent heat - about a megajoule, most of it off the last of the
  // water, a couple of kelvin. The report's 5 K/s, 45 kJ per kg, is what
  // must not come back.
  assert(T0 - minT < 3, `pot stayed near its temperature (${story})`);
});

report('Pump line (CAR BZ1bOwQ0oLXY0q8jG1hU)');
