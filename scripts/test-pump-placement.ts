/**
 * Pumps as things you put somewhere (2026-09-09):
 *
 *   1. A pump with a line missing has its open nozzle facing the air: it is
 *      built STOPPED whatever its design says, and started from its panel it
 *      pours onto the ground under it, where the water stands as a puddle.
 *   2. A pump delivered DRY holds air and cannot draw water up to itself;
 *      standing below its source's surface it floods, vents the air up its
 *      discharge and primes.
 *   3. A running wave takes what it closes over - by the MOTOR for a pump,
 *      by the base for anything else, never a water body, a pool or a yard,
 *      and never a puddle.
 *   4. The history's epoch designs are copies: emptying the yard after the
 *      design was recorded leaves the recorded design full (this is what
 *      lets "back to t=0" put the parts back on the shelf).
 *
 *   npx tsx scripts/test-pump-placement.ts
 */

import { test, assert, report, buildSimFromPlantJson, run, flowRate } from './lib/sim-harness';
import { saturationPressure } from '../src/simulation/water-properties';
import { cellAt } from '../src/simulation/terrain';
import { nodeLiquidLevelFraction } from '../src/simulation';
import { waveCasualties, washAwayElevation } from '../src/simulation/wave-casualties';
import { serializePlantDesign, deserializePlantDesign } from '../src/simulation/serialization';
import { getStock, spend, chargeForComponent } from '../src/game/stock';
import type { PlantComponent, PlantState, Connection, PumpComponent } from '../src/types';
import { ConstructionManager } from '../src/construction/construction-manager';

// ---------------------------------------------------------------------------
// A little coast: 6 x 3 cells of 10 m, ground rising from a -3 m sea floor
// on the east to +6 m on the west, the sea's surface at 0.
// ---------------------------------------------------------------------------

const CELL = 10;
const COLS = 6, ROWS = 3;
const heights: number[] = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) heights.push([6, 4, 2, 0.5, -1.5, -3][c]);
}
const terrain = {
  origin: { x: 0, y: 0 }, cellSize: CELL, cols: COLS, rows: ROWS, heights,
  infiltration: 1e-5,
  waters: [{ id: 'sea', seed: { x: 50, y: 10 }, surface: 0 }],
};

function tank(id: string, x: number, level: number, elevation = 0): [string, PlantComponent] {
  const T = 288.15;
  return [id, {
    id, type: 'tank', label: id,
    position: { x, y: 10 }, rotation: 0,
    elevation, height: 6, width: 4, fillLevel: level, pressureRating: 2,
    fluid: { temperature: T, pressure: saturationPressure(T), phase: 'two-phase', quality: 1e-4, flowRate: 0 },
    initialNcg: { N2: 0.79, O2: 0.21 },
    ports: [{ id: `${id}-bottom`, position: { x: 0, y: 3 }, direction: 'both' }],
  } as unknown as PlantComponent];
}

function pump(id: string, x: number, extra: Record<string, unknown> = {}): [string, PlantComponent] {
  return [id, {
    id, type: 'pump', label: id,
    position: { x, y: 10 }, rotation: 0, elevation: 0,
    diameter: 0.34, orientation: 'left-right',
    running: true, speed: 1, ratedFlow: 100, ratedHead: 15, pumpType: 'centrifugal',
    pressureRating: 16,
    ports: [
      { id: `${id}-inlet`, position: { x: 0, y: 0.55 }, direction: 'in' },
      { id: `${id}-outlet`, position: { x: 0.5, y: 0.12 }, direction: 'out' },
    ],
    fluid: { temperature: 288.15, pressure: 101325, phase: 'liquid', quality: 0, flowRate: 0 },
    ...extra,
  } as unknown as PlantComponent];
}

function line(from: string, fromPort: string, to: string, toPort: string, fromElev: number, toElev: number, length: number): Connection {
  return { fromComponentId: from, fromPortId: fromPort, toComponentId: to, toPortId: toPort,
    fromElevation: fromElev, toElevation: toElev, flowArea: 0.03, length } as Connection;
}

// The pinned nozzle heights of the pump above (height/2 - port.y on the
// drawn machine, diameter 0.34 -> visual height 0.972)
const H = 0.34 * 1.3 * 2.2;
const INLET = H / 2 - 0.55;
const OUTLET = H / 2 - 0.12;

// ---------------------------------------------------------------------------
// 1. Open ports: a pump with only a suction line pours onto the ground
// ---------------------------------------------------------------------------

test('A pump with a line missing is built stopped, and started it pours onto the ground', () => {
  // Tank on the +6 m hilltop at x=0, pump on the +2 m shelf at x=20: the
  // tank's water (surface 6 + 3 = 9 m) floods the pump's casing by gravity
  const sim = buildSimFromPlantJson({
    components: [tank('src', 0, 0.5), pump('pmp', 20)],
    connections: [line('src', 'src-bottom', 'pmp', 'pmp-inlet', 0, INLET, 25)],
    terrain,
  });
  const p = sim.state.components.pumps.get('pmp')!;
  assert(p.running === false, 'a pump with no discharge line is built stopped');
  assert(p.openOutlet === true && !p.openInlet, 'its discharge is open to the air, its suction is not');
  assert(p.connectedFlowPath.length > 0, 'the open discharge is the path the pump drives');
  const openLine = sim.state.flowConnections.find(c => c.id === p.connectedFlowPath)!;
  assert(openLine.toNodeId === 'atmosphere', `the open discharge runs to the atmosphere, not '${openLine.toNodeId}'`);

  run(sim, 30, 0.02);
  const basin = sim.state.terrain!.basinOf[cellAt(sim.state.terrain!.spec, { x: 20, y: 10 })];
  const puddleBefore = sim.state.surfaceWater!.volumes.get(basin) ?? 0;

  // Start it from its "panel"
  sim.state.components.pumps.get('pmp')!.running = true;
  run(sim, 60, 0.02);
  const q = flowRate(sim.state, 'pmp', 'atmosphere');
  const puddle = sim.state.surfaceWater!.volumes.get(basin) ?? 0;
  console.log(`    open discharge: ${q.toFixed(1)} kg/s onto the ground, puddle ${puddleBefore.toFixed(2)} -> ${puddle.toFixed(2)} m3`);
  assert(q > 10, `a started pump with an open discharge should pour water out, got ${q.toFixed(1)} kg/s`);
  assert(puddle > puddleBefore + 0.5, `the water should stand as a puddle under the pump, got ${puddle.toFixed(2)} m3`);
});

// ---------------------------------------------------------------------------
// 2. Dry pumps: no self-priming, but a flooded suction fills the casing
// ---------------------------------------------------------------------------

test('A dry pump above its source stays air-bound; below the surface it floods and primes', () => {
  // Same tank-on-the-hill (surface at 9 m), a second tank at the far end to
  // pump into, and the pump either on the +6 m hilltop next to the tank
  // (its nozzle above the tank's water? no - test the other way round: put
  // the SOURCE low and the pump high) ...
  // Source on the +0.5 m shelf (surface 3.5 m); pump on the +4 m step at
  // x=10: its inlet (4 + INLET) is above the source's surface -> no flood.
  const above = buildSimFromPlantJson({
    components: [tank('src', 30, 0.5), pump('pmp', 10, { initialFill: 'dry' }), tank('dst', 0, 0.2)],
    connections: [
      line('src', 'src-bottom', 'pmp', 'pmp-inlet', 0, INLET, 25),
      line('pmp', 'pmp-outlet', 'dst', 'dst-bottom', OUTLET, 0, 15),
    ],
    terrain,
  });
  assert(above.state.flowNodes.get('pmp')!.fluid.phase === 'vapor', 'a dry pump is built full of air');
  run(above, 90, 0.02);
  const qAbove = flowRate(above.state, 'pmp', 'dst');
  const casingAbove = above.state.flowNodes.get('pmp')!;
  console.log(`    dry pump above its source: ${qAbove.toFixed(2)} kg/s, casing ${casingAbove.fluid.phase}`);
  assert(Math.abs(qAbove) < 1, `a dry pump above its source cannot prime, delivered ${qAbove.toFixed(2)} kg/s`);
  assert(casingAbove.fluid.phase !== 'liquid', 'its casing should still hold air');

  // Pump on the -1.5 m sea floor at x=40, source on the +0.5 m shelf at
  // x=30 (surface 3.5 m, 5 m above the pump's inlet): the casing floods,
  // the air goes up the discharge, the pump primes and delivers. Its motor
  // is on a 4 m column - on the sea floor with the default half-metre motor
  // it would be drowned before it started (which is the point of the column).
  const below = buildSimFromPlantJson({
    components: [tank('src', 30, 0.5), pump('pmp', 40, { initialFill: 'dry', motorElevation: 4 }), tank('dst', 20, 0.2)],
    connections: [
      line('src', 'src-bottom', 'pmp', 'pmp-inlet', 0, INLET, 15),
      line('pmp', 'pmp-outlet', 'dst', 'dst-bottom', OUTLET, 0, 25),
    ],
    terrain,
  });
  run(below, 90, 0.02);
  const qBelow = flowRate(below.state, 'pmp', 'dst');
  const casingBelow = below.state.flowNodes.get('pmp')!;
  const filled = nodeLiquidLevelFraction(casingBelow);
  console.log(`    dry pump below its source: ${qBelow.toFixed(1)} kg/s, casing ${casingBelow.fluid.phase} (${(100 * filled).toFixed(0)}% liquid)`);
  assert(filled > 0.9, `a flooded dry pump should prime, casing is ${casingBelow.fluid.phase} at ${(100 * filled).toFixed(0)}% liquid`);
  assert(qBelow > 20, `a primed pump should deliver, got ${qBelow.toFixed(1)} kg/s`);
});

// ---------------------------------------------------------------------------
// 3. The wave rule
// ---------------------------------------------------------------------------

test('A running wave takes what it closes over: pumps by the motor, the rest by the base', () => {
  const components: Array<[string, PlantComponent]> = [
    // a tank on the +2 m shelf, a pump on the +0.5 m step with its motor
    // 4 m up, a valve on the +4 m step, and the sea itself (a water body)
    tank('shelf-tank', 20, 0.5),
    pump('wet-pump', 30, { motorElevation: 4 }),
    ['gate', {
      id: 'gate', type: 'valve', label: 'gate', valveType: 'gate', position: { x: 10, y: 10 }, rotation: 0,
      elevation: 0, diameter: 0.2, opening: 1, ports: [
        { id: 'gate-in', position: { x: -0.2, y: 0 }, direction: 'in' },
        { id: 'gate-out', position: { x: 0.2, y: 0 }, direction: 'out' },
      ],
    } as unknown as PlantComponent],
    ['sea', { ...tank('sea', 50, 0.5)[1], waterBody: 'sea' } as PlantComponent],
  ];
  const sim = buildSimFromPlantJson({ components, connections: [], terrain });
  const plant = {
    components: new Map(components), connections: [], terrain,
  } as unknown as PlantState;

  assert(washAwayElevation(plant, plant.components.get('wet-pump')!)! > 4.4 &&
    washAwayElevation(plant, plant.components.get('wet-pump')!)! < 4.6,
    'a pump is taken by its motor: ground 0.5 + 4 m column');
  assert(Math.abs(washAwayElevation(plant, plant.components.get('shelf-tank')!)! - 2) < 1e-9, 'a tank is taken by its base');
  assert(washAwayElevation(plant, plant.components.get('sea')!) === null, 'the sea is never taken');

  const body = sim.state.surfaceWater!.bodies.get('sea')!;
  const names = () => waveCasualties(plant, sim.state).map(c => c.id).sort().join(',');
  assert(names() === '', `at its own level the sea takes nothing, got '${names()}'`);
  body.surface = 0.4;
  assert(names() === '', `a tide 0.4 m up is not a wave (trigger 0.5 m), got '${names()}'`);
  body.surface = 3;
  assert(names() === 'shelf-tank', `at +3 m the wave has the +2 m tank but not the pump's 4.5 m motor, got '${names()}'`);
  body.surface = 5;
  assert(names() === 'gate,shelf-tank,wet-pump', `at +5 m it has everything on the coast, got '${names()}'`);
  body.surface = 0;

  // A puddle is not a wave, however deep
  const padBasin = sim.state.terrain!.basinOf[cellAt(sim.state.terrain!.spec, { x: 0, y: 10 })];
  sim.state.surfaceWater!.volumes.set(padBasin, 1e6);
  assert(names() === '', `standing water takes nothing, got '${names()}'`);
});

// ---------------------------------------------------------------------------
// 4. Recorded designs are copies
// ---------------------------------------------------------------------------

test('A recorded plant design does not follow the yard as it empties', () => {
  const yard = {
    id: 'yard', type: 'warehouse', label: 'yard', position: { x: 0, y: 0 }, rotation: 0, elevation: 0,
    width: 6, depth: 4, ports: [],
    stock: { pipeMeters: 100, components: [{ type: 'pump', count: 2 }] },
  } as unknown as PlantComponent;
  const plant = { components: new Map([['yard', yard]]), connections: [] } as unknown as PlantState;
  const recorded = serializePlantDesign(plant);
  // The player places a pump: the yard is charged in place
  spend(plant, chargeForComponent('pump', undefined));
  assert(getStock(plant)!.components.find(l => l.type === 'pump')!.count === 1, 'the live yard is down to one pump');
  const restored = deserializePlantDesign(recorded);
  const line = getStock(restored)!.components.find(l => l.type === 'pump')!;
  assert(line.count === 2, `the recorded design must still hold both pumps, has ${line.count}`);
  // And the other way: editing the restored plant leaves the record alone
  spend(restored, chargeForComponent('pump', undefined));
  const again = deserializePlantDesign(recorded);
  assert(getStock(again)!.components.find(l => l.type === 'pump')!.count === 2, 'a restore is a fresh copy every time');
});

// ---------------------------------------------------------------------------
// 5. A pump put INSIDE something starts with, and opens into, what is there
// ---------------------------------------------------------------------------

test('A pump placed in the sea is primed with sea water and its open nozzles are in the sea', () => {
  // The sea as a water-body tank on the -3 m floor at x=50, half full of its
  // 6 m: surface at 0. One pump on the -1.5 m step at x=45 (under water),
  // one on the +2 m shelf at x=25 (above it), both built dry and contained
  // by the sea, through the same ConstructionManager path the UI uses.
  const plant = { components: new Map(), connections: [], terrain } as unknown as PlantState;
  const cm = new ConstructionManager(plant);   // (starts by clearing the plant)
  plant.components.set('sea', { ...tank('sea', 50, 0.5)[1], waterBody: 'sea' } as PlantComponent);
  const place = (x: number) => cm.createComponent({
    type: 'pump', name: `P${x}`, position: { x, y: 10 }, containedBy: 'sea',
    properties: { name: `P${x}`, ratedFlow: 100, ratedHead: 15, elevation: 0, initialFill: 'dry' },
  })!;
  const wetId = place(45);
  const highId = place(25);
  const wet = plant.components.get(wetId) as PumpComponent;
  const high = plant.components.get(highId) as PumpComponent;

  const overWater = saturationPressure(288.15) + 1e5;   // steam + the 1 bar of air on the sea
  console.log(`    pump in the water: ${wet.initialFill}, ${wet.fluid?.phase} at ` +
    `${((wet.fluid?.pressure ?? 0) / 1e5).toFixed(3)} bar; pump above it: ${high.initialFill}`);
  assert(wet.initialFill === 'primed' && wet.fluid?.phase === 'liquid',
    `a pump standing under the surface is primed with the liquid, got ${wet.initialFill} / ${wet.fluid?.phase}`);
  assert(wet.fluid!.pressure > overWater && wet.fluid!.pressure < overWater + 0.2e5,
    `it starts at the pressure of its depth (a metre or so of water over 1 atm), got ${wet.fluid!.pressure} Pa`);
  assert(high.initialFill === 'dry', 'a pump above the surface keeps its dry casing');

  const sim = buildSimFromPlantJson({ components: Array.from(plant.components.entries()), connections: [], terrain });
  const p = sim.state.components.pumps.get(wetId)!;
  assert(p.openInlet === true && p.openOutlet === true && p.openInto === 'sea',
    'with no lines, both its nozzles are open inside the sea');
  const openLines = sim.state.flowConnections.filter(c => c.fromNodeId === wetId || c.toNodeId === wetId);
  assert(openLines.length === 2 && openLines.every(c => c.fromNodeId === 'sea' || c.toNodeId === 'sea'),
    `its open nozzles run to the sea node, not the air: ${openLines.map(c => `${c.fromNodeId}->${c.toNodeId}`).join(', ')}`);
  assert(sim.state.flowNodes.get(wetId)!.fluid.phase === 'liquid', 'its casing is built full of liquid');

  // Started from its panel it draws the sea and pumps it straight back
  sim.state.components.pumps.get(wetId)!.running = true;
  run(sim, 30, 0.02);
  const casing = sim.state.flowNodes.get(wetId)!;
  const q = flowRate(sim.state, 'sea', wetId);
  console.log(`    started in the sea: ${q.toFixed(1)} kg/s drawn, casing ${casing.fluid.phase}`);
  assert(casing.fluid.phase === 'liquid', `a primed pump under water stays full of it, got ${casing.fluid.phase}`);
  assert(q > 10, `it should draw from the sea it stands in, got ${q.toFixed(1)} kg/s`);

  // The one on the shelf has its nozzles in the air over the sea: it stays
  // an air-filled casing at about an atmosphere, neither flooded nor pumped
  // up. (Until the steam draw off a two-phase node was priced from the steam
  // tables, this casing was flushed with steam 266 kJ/kg short, cooled below
  // both gases, went supersaturated and rang 0.85-1.3 bar at the dew point -
  // scripts/probe-dry-pump-dewpoint.ts.)
  const dry = sim.state.flowNodes.get(highId)!;
  console.log(`    above the sea after 30 s: casing ${dry.fluid.phase}, ` +
    `${(dry.fluid.pressure / 1e5).toFixed(3)} bar, ${(dry.fluid.temperature - 273.15).toFixed(2)} C, ` +
    `${(100 * nodeLiquidLevelFraction(dry)).toFixed(1)}% liquid`);
  assert(nodeLiquidLevelFraction(dry) < 0.05,
    `a pump above the surface must not flood, casing ${(100 * nodeLiquidLevelFraction(dry)).toFixed(1)}% liquid`);
  assert(dry.fluid.pressure > 1.0e5 && dry.fluid.pressure < 1.03e5,
    `its casing should sit at the air's pressure over the sea, got ${(dry.fluid.pressure / 1e5).toFixed(4)} bar`);
  assert(dry.fluid.temperature > 288.15 - 0.05,
    `mixing 20 C casing air with 15 C sea air cannot end below 15 C, got ${(dry.fluid.temperature - 273.15).toFixed(3)} C`);
});

// ---------------------------------------------------------------------------
// 6. A dry pump on ordinary lines keeps its air at build
// ---------------------------------------------------------------------------

test('A dry pump piped to a tank starts dry: matchUpstream does not refill it from the tank', () => {
  // The construction UI builds every pump with matchUpstream on. The same
  // dry pump on the shelf, NOT contained, with two plain lines from the
  // sea's gas space. Before, the factory rebuilt its casing from the sea's
  // BULK fluid at build - 55 kg of liquid-heavy two-phase at 0.017 bar, the
  // air thrown away - and the casing then rang for as long as it ran.
  const plant = { components: new Map(), connections: [], terrain } as unknown as PlantState;
  const cm = new ConstructionManager(plant);
  plant.components.set('sea', { ...tank('sea', 50, 0.5)[1], waterBody: 'sea' } as PlantComponent);
  const id = cm.createComponent({
    type: 'pump', name: 'P', position: { x: 25, y: 10 },
    properties: { name: 'P', ratedFlow: 100, ratedHead: 15, elevation: 0, initialFill: 'dry' },
  })!;
  const p = plant.components.get(id) as PumpComponent;
  assert((p as unknown as { matchUpstream?: boolean }).matchUpstream === true,
    'the construction UI builds the pump with matchUpstream on (the case under test)');
  // Two lines from the sea's gas space to the pump's nozzles, 0.3 m of pipe each
  const [inlet, outlet] = p.ports;
  const seaSide = 5;   // m up the 6 m sea node: in its gas space (surface at 3 m)
  const lines = [
    { fromComponentId: 'sea', fromPortId: 'sea-bottom', toComponentId: id, toPortId: inlet.id,
      fromElevation: seaSide, flowArea: 0.03, length: 0.3 },
    { fromComponentId: id, fromPortId: outlet.id, toComponentId: 'sea', toPortId: 'sea-bottom',
      toElevation: seaSide, flowArea: 0.03, length: 0.3 },
  ] as Connection[];
  const sim = buildSimFromPlantJson({ components: Array.from(plant.components.entries()), connections: lines, terrain });
  const casing0 = sim.state.flowNodes.get(id)!;
  const air0 = casing0.fluid.ncg ? Object.values(casing0.fluid.ncg).reduce((s: number, x) => s + (x ?? 0), 0) : 0;
  console.log(`    built: casing ${casing0.fluid.phase}, ${(casing0.fluid.pressure / 1e5).toFixed(4)} bar, ` +
    `${(casing0.fluid.mass * 1000).toFixed(2)} g of water, ${air0.toFixed(2)} mol of air`);
  assert(casing0.fluid.phase === 'vapor' && air0 > 5 && casing0.fluid.mass < 0.05,
    `a dry pump starts full of air, got ${casing0.fluid.phase} with ${casing0.fluid.mass.toFixed(3)} kg of water and ${air0.toFixed(2)} mol of air`);
  run(sim, 30, 0.02);
  const casing = sim.state.flowNodes.get(id)!;
  console.log(`    after 30 s: casing ${casing.fluid.phase}, ${(casing.fluid.pressure / 1e5).toFixed(4)} bar, ` +
    `${(casing.fluid.temperature - 273.15).toFixed(2)} C`);
  assert(casing.fluid.pressure > 1.0e5 && casing.fluid.pressure < 1.03e5,
    `the piped dry casing should sit at the air's pressure over the sea, got ${(casing.fluid.pressure / 1e5).toFixed(4)} bar`);
});

report('Pump placement');
