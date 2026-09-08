/**
 * Generator for the SPENT FUEL POOL career level's plant JSON.
 *
 * This script is the SOURCE OF TRUTH for
 * `src/game-mode/levels/spent-fuel-pool.json`: the terrain is a 30 x 16 height
 * field (480 numbers) that nobody should be editing by hand, and the site's
 * elevations only work because every structure stands on a deliberately FLAT
 * bench. Change the map here and re-run:
 *
 *   npx tsx scripts/gen-spent-fuel-pool.ts
 *
 * The map, west to east:
 *   x <=  100 m   the pool bench, a flat pad cut 1 m into the plateau at
 *                 +13 m, holding the pool, its liner-crack line, the two
 *                 storage tanks and the supply yard. The pad is a CLOSED
 *                 depression, so water leaving the pool lands on the pad and
 *                 soaks into the ground there instead of running to the sea.
 *   100..110 m    plateau rim, +14 m (the pad's lip)
 *   110..185 m    the hillside, +14 m down to +2 m
 *   185..215 m    the shore bench, +2.0 m down to +1.4 m
 *   215..232 m    the beach face, +1.4 m down to -4 m
 *   x >=  232 m   the sea shelf, flat -4 m, declared as the water body `sea`
 *                 with its surface at 0 m (so 4 m of water over the shelf).
 *
 * The two obstacles the level is built around fall straight out of that:
 *   - a pump standing on the pad is ~13 m above the sea surface, well past
 *     what an atmosphere can push up an intake (~10.3 m before NPSH), so its
 *     suction line flashes and it delivers nothing;
 *   - the scripted tsunami takes the sea to +5 m, which is above the whole
 *     shore bench, so anything built down there is under water until it
 *     recedes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'game-mode', 'levels', 'spent-fuel-pool.json');

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

const CELL = 10;
const COLS = 30;
const ROWS = 16;

/** Pad (flat bench) extent in CELL INDICES, so its edges land on cell centres. */
const PAD_C0 = 2, PAD_C1 = 10;    // x = 20 .. 100 m
const PAD_R0 = 4, PAD_R1 = 12;    // y = 40 .. 120 m
const PAD_HEIGHT = 13.0;

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Ground height (m) at a cell centre. Piecewise-linear in x; flat in y. */
function heightAt(col: number, row: number): number {
  const x = col * CELL;
  let h: number;
  if (x <= 110) h = 14.0;
  else if (x <= 185) h = lerp(14.0, 2.0, (x - 110) / 75);
  else if (x <= 215) h = lerp(2.0, 1.4, (x - 185) / 30);
  else if (x <= 232) h = lerp(1.4, -4.0, (x - 215) / 17);
  else h = -4.0;
  if (col >= PAD_C0 && col <= PAD_C1 && row >= PAD_R0 && row <= PAD_R1) h = PAD_HEIGHT;
  return Number(h.toFixed(3));
}

const heights: number[] = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) heights.push(heightAt(c, r));
}

// ---------------------------------------------------------------------------
// The site
// ---------------------------------------------------------------------------

/** Pool geometry. The rack top (0.5 + 3.66 m) is the level the fuel needs. */
const POOL_SIDE = 9;
const POOL_DEPTH = 10.5;
const RACK_BOTTOM = 0.5;
const RACK_HEIGHT = 3.66;

/** Vapour pressures (Pa) at the initial temperatures, IAPWS to 4 figures. */
const PSAT_45C = 9593;
const PSAT_15C = 1706;
const PSAT_12C = 1403;

const components: Array<[string, Record<string, unknown>]> = [
  ['pool', {
    id: 'pool', type: 'pool', label: 'Spent Fuel Pool',
    position: { x: 50, y: 75 }, rotation: 0,
    elevation: -POOL_DEPTH,          // sunk to grade: the rim is at pad level
    side: POOL_SIDE, depth: POOL_DEPTH, wallThickness: 1.2,
    fillLevel: 0.8,                  // 8.4 m of water over a 10.5 m basin
    fuelPower: 8.0e6,
    assemblyCount: 250, rodsPerAssembly: 264,
    rodDiameter: 9.5, cladThickness: 0.6,
    rackHeight: RACK_HEIGHT, rackBottomElevation: RACK_BOTTOM,
    pressureRating: 2,
    ports: [
      { id: 'pool-vent', position: { x: 0, y: -4.5 }, direction: 'both' },
      { id: 'pool-crack', position: { x: 0, y: 4.5 }, direction: 'both' },
      { id: 'pool-makeup-w', position: { x: -4.5, y: 0 }, direction: 'both' },
      { id: 'pool-makeup-e', position: { x: 4.5, y: 0 }, direction: 'both' },
    ],
    fluid: { temperature: 318.15, pressure: PSAT_45C, phase: 'two-phase', quality: 0.0001, flowRate: 0 },
    initialNcg: { N2: 0.712, O2: 0.190 },
  }],

  // The liner crack: a shut valve at the pool floor whose far side is open
  // air. The earthquake opens it (scenario, below).
  ['crack', {
    id: 'crack', type: 'valve', label: 'Liner Crack',
    position: { x: 50, y: 92 }, rotation: 0,
    elevation: -(POOL_DEPTH - 0.1),  // its node sits level with the pool floor
    diameter: 0.3, volume: 2.0,      // a hole, not a pressure part: give it room
    valveType: 'gate', opening: 0,
    ports: [
      { id: 'crack-in', position: { x: -0.5, y: 0 }, direction: 'both' },
      { id: 'crack-out', position: { x: 0.5, y: 0 }, direction: 'both' },
    ],
    fluid: { temperature: 318.15, pressure: 101325, phase: 'liquid', quality: 0, flowRate: 0 },
    pressureRating: 100,
  }],

  ['tank-a', {
    id: 'tank-a', type: 'tank', label: 'Demineralised Water Tank',
    position: { x: 85, y: 55 }, rotation: 0, elevation: 0,
    width: 14, height: 7, wallThickness: 0.05,
    fillLevel: 0.78,                 // 841 m3 of a 1078 m3 tank
    pressureRating: 2,
    ports: [{ id: 'tank-a-out', position: { x: 7, y: 0 }, direction: 'both' }],
    fluid: { temperature: 288.15, pressure: PSAT_15C, phase: 'two-phase', quality: 0.0001, flowRate: 0 },
    initialNcg: { N2: 0.786, O2: 0.210 },
  }],
  ['tank-b', {
    id: 'tank-b', type: 'tank', label: 'Fire Water Tank',
    position: { x: 85, y: 100 }, rotation: 0, elevation: 0,
    width: 10, height: 6, wallThickness: 0.05,
    fillLevel: 0.80,                 // 377 m3 of a 471 m3 tank
    pressureRating: 2,
    ports: [{ id: 'tank-b-out', position: { x: 5, y: 0 }, direction: 'both' }],
    fluid: { temperature: 288.15, pressure: PSAT_15C, phase: 'two-phase', quality: 0.0001, flowRate: 0 },
    initialNcg: { N2: 0.786, O2: 0.210 },
  }],

  // The sea, as a component a pump can actually take suction on. The terrain
  // water body of the same name is the FLOODING surface (nothing draws from
  // it); this tank is the inventory. It stands on the -4 m shelf, 8 m tall
  // and half full, so its water surface is at 0 m - the sea's own level.
  ['sea', {
    id: 'sea', type: 'tank', label: 'The Sea',
    position: { x: 245, y: 75 }, rotation: 0, elevation: 0,
    width: 34, height: 8, wallThickness: 0.05,
    fillLevel: 0.5,
    pressureRating: 2,
    ports: [{ id: 'sea-out', position: { x: -17, y: 0 }, direction: 'both' }],
    fluid: { temperature: 285.15, pressure: PSAT_12C, phase: 'two-phase', quality: 0.0001, flowRate: 0 },
    initialNcg: { N2: 0.786, O2: 0.210 },
  }],

  ['yard', {
    id: 'yard', type: 'warehouse', label: 'Supply Yard',
    position: { x: 60, y: 115 }, rotation: 0, elevation: 0,
    width: 12, depth: 8,
    stock: { pipeMeters: 300, components: { pump: 2, valve: 2 } },
    ports: [],
  }],
];

const connections = [
  // The pool is open to the sky: a flow path from the rim to the air, at the
  // same physical point, so it carries no standing head.
  {
    fromComponentId: 'pool', fromPortId: 'pool-vent',
    toComponentId: 'atmosphere', toPortId: 'environment',
    fromElevation: POOL_DEPTH,
    flowArea: 1.0, length: 10, resistanceCoeff: 2,
  },
  // The crack: 0.4 m up the pool wall with a 0.8 m opening, so the draw
  // crossfades liquid -> vapour as the level sweeps past it and the leak
  // dies away on its own.
  {
    fromComponentId: 'pool', fromPortId: 'pool-crack',
    toComponentId: 'crack', toPortId: 'crack-in',
    fromElevation: 0.4, fromOpeningHeight: 0.8, toElevation: 0.3,
    flowArea: 0.024, length: 1, resistanceCoeff: 2,
  },
  {
    fromComponentId: 'crack', fromPortId: 'crack-out',
    toComponentId: 'atmosphere', toPortId: 'environment',
    fromElevation: 0.3,
    flowArea: 0.024, length: 1, resistanceCoeff: 2,
  },
];

// ---------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------

const QUAKE = 2400;          // s - the liner cracks
const TSUNAMI_WARN = 2700;   // s - the warning, no physics
const WAVE_IN = 3600;        // s - the sea starts climbing
const WAVE_OUT = 8400;       // s - it starts falling back
const LEVEL_END = 21600;     // s - 6 sim hours

const scenario = {
  description:
    'An earthquake cracks the spent fuel pool liner; the tsunami behind it floods the shore ' +
    'for about 80 minutes. Keep the fuel covered for six hours.',
  events: [
    {
      time: QUAKE,
      message: 'EARTHQUAKE. The pool liner has cracked - level is falling.',
      actions: [{ kind: 'valve', id: 'crack', position: 1 }],
    },
    {
      time: TSUNAMI_WARN,
      message: 'Tsunami warning: get off the shore. The wave is about fifteen minutes out.',
      actions: [],
    },
    {
      time: WAVE_IN,
      message: 'The wave is coming in - the shore is going under.',
      actions: [{ kind: 'water-level', id: 'sea', surface: 5, over: 300 }],
    },
    {
      time: WAVE_OUT,
      message: 'The sea is falling back. The shore will be workable again shortly.',
      actions: [{ kind: 'water-level', id: 'sea', surface: 0, over: 400 }],
    },
  ],
};

// ---------------------------------------------------------------------------

const plant = {
  components,
  connections,
  terrain: {
    origin: { x: 0, y: 0 },
    cellSize: CELL,
    cols: COLS,
    rows: ROWS,
    heights,
    waters: [{ id: 'sea', seed: { x: 270, y: 75 }, surface: 0 }],
  },
  scenario,
};

fs.writeFileSync(OUT, JSON.stringify(plant, null, 1).replace(/\n/g, '\r\n') + '\r\n');
console.log(`Wrote ${OUT}`);
console.log(`  terrain ${COLS} x ${ROWS} cells of ${CELL} m; pad ${PAD_HEIGHT} m, sea shelf -4 m`);
console.log(`  rack top at ${(RACK_BOTTOM + RACK_HEIGHT).toFixed(2)} m above the pool floor`);
console.log(`  timeline: quake ${QUAKE} s, wave in ${WAVE_IN} s, out ${WAVE_OUT} s, end ${LEVEL_END} s`);
