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
 * The map, west to east, is a base profile in x that a seeded noise field
 * then bends (see `heightAt`):
 *   x <=  100 m   the pool bench, a flat pad cut 1 m into the plateau at
 *                 +13 m, holding the pool, its liner-crack line, the two
 *                 storage tanks and the supply yard. The pad is a CLOSED
 *                 depression, so water leaving the pool lands on the pad and
 *                 soaks into the ground there instead of running to the sea.
 *   100..110 m    plateau rim, +14 m (the pad's lip)
 *   110..176 m    the hillside, +14 m down to +2 m
 *   176..218 m    the shore bench, +2.0 m down to +1.4 m
 *   218..234 m    the beach face, +1.4 m down to -2 m
 *   x >=  234 m   the sea floor, falling away offshore from -2 m to -9 m at
 *                 the map's edge, declared as the water body `sea` with its
 *                 surface at 0 m. How deep the water is depends on how far
 *                 out you go, which is the whole question of where to stand
 *                 the intake pump.
 *
 * The obstacles the level is built around fall straight out of that and out
 * of the yard's pump (a vertical wet-pit machine delivered DRY, its motor on
 * a 6 m column - see `pump-service-water-lp` in component-presets.ts):
 *   - a pump standing on the pad is ~13 m above the sea surface, well past
 *     what an atmosphere can push up an intake (~10.3 m before NPSH), so its
 *     suction line flashes and it delivers nothing;
 *   - a pump standing on the shore is full of air and cannot prime itself,
 *     so it delivers nothing either. It has to stand IN the sea, deep enough
 *     for the water to flood its bowl and shallow enough that its motor is
 *     still above the surface: somewhere on the first few tens of metres of
 *     sea floor;
 *   - the scripted tsunami takes the sea to +12.6 m, a few tens of centimetres
 *     under the pad itself, so anything built anywhere but the bench is under
 *     water until it drains back - and a wave that closes over a component
 *     TAKES it (src/simulation/wave-casualties.ts): a pump built in the sea
 *     before the wave is a pump the yard no longer has.
 *
 * THE NOISE (added 2026-09-08) exists to stop the site reading as a ramp
 * between two shelves, and it is applied in the two ways that cannot damage
 * any of those numbers:
 *   - a LATERAL warp (the profile is read at x + shift(y)), which bends the
 *     coastline and the contours without changing what heights exist. The
 *     profile is monotone in x on the beach face and the warp's own gradient
 *     is far smaller than 1, so the warped face is monotone too: there are no
 *     closed hollows below sea level to strand dry water.
 *   - a VERTICAL fractal-noise term that fades out below the shore bench
 *     (nothing at or under +2.2 m moves at all) and beside the cut bench, so
 *     the bench stays flat, its lip stays above it, and the shore bench stays
 *     inside the +1.4..+2.0 m band the suction-lift check is measured on.
 * Every one of those invariants is ASSERTED below - if a seed change breaks
 * one, this script throws instead of writing a quietly broken level.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildTerrainModel, terrainHeightAt } from '../src/simulation/terrain';

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'game-mode', 'levels', 'spent-fuel-pool.json');

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

const CELL = 10;
const COLS = 30;
const ROWS = 16;
/**
 * y is a NORTHING (+y north, up the grid's screen, away from the 2.5D
 * camera). The map was first laid out when the grid drew +y DOWN the screen;
 * when that was turned the right way up (2026-09-12) the level was mirrored
 * about y = 75 m, the line the pool, the sea and every pump test stand on, so
 * it still looks as it did. The noise field is sampled at the mirrored
 * northing (MAP_N - y) so the landscape is the same one, cell for cell.
 */
const MAP_N = (ROWS - 1) * CELL;

/** Pad (flat bench) extent in CELL INDICES, so its edges land on cell centres. */
const PAD_C0 = 2, PAD_C1 = 10;    // x = 20 .. 100 m
const PAD_R0 = 3, PAD_R1 = 11;    // y = 30 .. 110 m
const PAD_HEIGHT = 13.0;
/**
 * The pad is a shallow DISH, not a plane: PAD_DISH metres lower at the pool
 * than at its edges, falling off as the square of the distance from the pool
 * out to PAD_DISH_RADIUS. Water leaving the pool collects around the pool
 * instead of spreading one centimetre deep over the whole pad (a perfectly
 * flat pad is one basin, and any puddle on it wets all 8100 m2 at once).
 * The tanks and the yard stand outside the dish, on the flat 13.0 m rim, so
 * their datums are untouched; only the pool's ground is lower, and the wave
 * (12.6 m) still stops short of the pool's rim.
 */
const PAD_DISH = 0.3;
const PAD_DISH_RADIUS = 40;
const POOL_X = 50, POOL_Y = 75;
/**
 * The sea floor: a shelf that shelves gently from the water's edge, then
 * drops away. The sea gets deeper the farther out you go: an intake pump's
 * bowl has to be under water and its motor above it, so where it can stand
 * is a band of the sea floor, not a point. The shelf is kept under ~3.5 m so
 * that anywhere on it a dry pump floods gently enough to prime without
 * slamming its casing (a casing that fills through a 12" line with more
 * than ~0.4 bar behind it hits liquid-solid hard - see the level doc); off
 * the shelf's edge the water is over the motor anyway.
 */
const SEA_FLOOR_EDGE = -2.0;
const SEA_SHELF_DEPTH = -3.5;
const SEA_SHELF_RUN = 28;      // m of gentle shelf past the beach face (x = 234..262)
const SEA_FLOOR_DEEP = -9.0;
const SEA_FLOOR_RUN = 56;      // m from the shelf start to the map's deep water (x = 234..290)
/** The sea tank's base, absolute: half full and 8 m tall puts its surface at 0. */
const SEA_BASE = -4.0;

/** One number that makes the whole landscape repeatable. */
const SEED = 20260908;

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function clamp01(t: number): number { return t < 0 ? 0 : t > 1 ? 1 : t; }
function smoothstep(t: number): number { return t * t * (3 - 2 * t); }

/** Integer hash -> [0, 1). Deterministic across platforms (32-bit integer maths only). */
function hash2(i: number, j: number, salt: number): number {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul((salt + SEED) | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise on a lattice of `period` metres, in [-1, 1]. */
function valueNoise(x: number, y: number, period: number, salt: number): number {
  const fx = x / period, fy = y / period;
  const i = Math.floor(fx), j = Math.floor(fy);
  const tx = smoothstep(fx - i), ty = smoothstep(fy - j);
  const a = hash2(i, j, salt), b = hash2(i + 1, j, salt);
  const c = hash2(i, j + 1, salt), d = hash2(i + 1, j + 1, salt);
  return 2 * (lerp(lerp(a, b, tx), lerp(c, d, tx), ty)) - 1;
}

/** Fractal (several octaves of) value noise, in [-1, 1]. */
function fbm(x: number, y: number, period: number, salt: number, octaves: number): number {
  let sum = 0, amp = 1, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x, y, p, salt + 31 * o);
    norm += amp;
    amp *= 0.5;
    p *= 0.5;
  }
  return sum / norm;
}

/** The base cross-section: piecewise-linear in x, the level's numbers. */
function profile(x: number): number {
  if (x <= 110) return 14.0;
  if (x <= 176) return lerp(14.0, 2.0, (x - 110) / 66);
  if (x <= 218) return lerp(2.0, 1.4, (x - 176) / 42);
  if (x <= 234) return lerp(1.4, SEA_FLOOR_EDGE, (x - 218) / 16);
  if (x <= 234 + SEA_SHELF_RUN) return lerp(SEA_FLOOR_EDGE, SEA_SHELF_DEPTH, (x - 234) / SEA_SHELF_RUN);
  return lerp(SEA_SHELF_DEPTH, SEA_FLOOR_DEEP, clamp01((x - 234 - SEA_SHELF_RUN) / (SEA_FLOOR_RUN - SEA_SHELF_RUN)));
}

/** Distance from the flat bench, in cells (0 inside it). */
function padDistance(col: number, row: number): number {
  const dx = Math.max(PAD_C0 - col, col - PAD_C1, 0);
  const dy = Math.max(PAD_R0 - row, row - PAD_R1, 0);
  return Math.hypot(dx, dy);
}

/**
 * How much of the noise this cell gets: none on or right beside the bench
 * (its lip has to stay above it), full two cells out.
 */
function padTaper(col: number, row: number): number {
  return clamp01((padDistance(col, row) - 1.2) / 2.0);
}

/** Peak lateral wander of the profile, in metres. */
const WARP_AMP = 16;
/** Peak vertical relief added to the open hillside and plateau, in metres. */
const VERT_AMP = 3.0;

/**
 * The warp dies out to seaward as well, so the deep shelf the sea tank stands
 * on is the flat -4 m the level's water surface is measured from.
 */
function warpTaper(x: number): number {
  return 1 - clamp01((x - 218) / 30);
}

/** The pad's dish: how far below PAD_HEIGHT the ground is at (x, y). */
function padDip(x: number, y: number): number {
  const r = Math.hypot(x - POOL_X, y - POOL_Y) / PAD_DISH_RADIUS;
  return r >= 1 ? 0 : PAD_DISH * (1 - r * r);
}

/** Ground height (m) at a cell centre. */
function heightAt(col: number, row: number): number {
  const x = col * CELL, y = row * CELL;
  if (col >= PAD_C0 && col <= PAD_C1 && row >= PAD_R0 && row <= PAD_R1) {
    return Number((PAD_HEIGHT - padDip(x, y)).toFixed(3));
  }

  const damp = padTaper(col, row);
  const yNoise = MAP_N - y;   // see MAP_N
  // Lateral wander: bends the coastline and every contour with it
  const shift = WARP_AMP * fbm(x * 0.35, yNoise, 95, 3, 2) * warpTaper(x) * damp;
  const base = profile(x + shift);
  // Vertical relief: only above the shore bench, so nothing the level's
  // numbers depend on moves
  const amp = VERT_AMP * clamp01((base - 2.2) / 3.0) * damp;
  const h = base + amp * fbm(x, yNoise, 90, 11, 4);
  return Number(h.toFixed(3));
}

const heights: number[] = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) heights.push(heightAt(c, r));
}

const terrain = {
  origin: { x: 0, y: 0 },
  cellSize: CELL,
  cols: COLS,
  rows: ROWS,
  heights,
  // How fast standing water soaks into the ground, m/s. The model's default
  // (1e-4) drinks 810 kg/s off the pad, more than the crack ever passes, so
  // no puddle ever stood. At 3e-5 the leak keeps ~4800 m2 of the dish wet:
  // a puddle a few tens of centimetres deep around the pool that grows over
  // the first hours and shrinks as the leak falls off. A pump standing in it
  // is fine - its motor is half a metre up.
  infiltration: 3e-5,
  waters: [{ id: 'sea', seed: { x: 270, y: 75 }, surface: 0 }],
};

/** Where the water's edge is on a given northing, to the metre. */
function shorelineX(y: number): number {
  let lo = 180, hi = 260;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (terrainHeightAt(terrain, { x: mid, y }) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
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

/**
 * Dry air (bar of each species) filling a partial pressure of `pa` pascals,
 * on the same renormalised N2/O2/Ar split the environment node uses. A gas
 * space that is open to the air has to START at the air's pressure, or the
 * line joining them carries a real transient that nobody asked for.
 */
function AIR_TO(pa: number): Record<string, number> {
  const N2 = 0.7808, O2 = 0.2095, AR = 0.0093, SUM = N2 + O2 + AR;
  const bar = pa / 1e5;
  return {
    N2: Number((bar * N2 / SUM).toFixed(5)),
    O2: Number((bar * O2 / SUM).toFixed(5)),
    Ar: Number((bar * AR / SUM).toFixed(5)),
  };
}

/**
 * The sea component stands ON the shelf but is DRAWN as the terrain water
 * body (see `waterBody` below), so its west nozzle is the thing the player
 * sees and drags a pipe to: put that nozzle a couple of metres off the
 * water's edge, and the body of the tank out over the flat shelf where its
 * base is the -4 m the half-full 8 m tank needs to sit at sea level.
 */
const SEA_WIDTH = 34;
const SEA_PORT_X = Math.round(shorelineX(75) + 3);
const SEA_X = SEA_PORT_X + SEA_WIDTH / 2;
/**
 * The sea floor slopes, so the tank's `elevation` (above LOCAL ground, like
 * every component's) is whatever puts its base at SEA_BASE.
 */
const SEA_ELEVATION = Number((SEA_BASE - terrainHeightAt(terrain, { x: SEA_X, y: 75 })).toFixed(3));
/**
 * Where the intake is: 2 m under the surface. A nozzle AT the surface (the
 * old y: 0, mid-height of a half-full tank) drew half air across the
 * interface; the sea's water is drawn from below it.
 */
const SEA_INTAKE_DEPTH = 2;

const components: Array<[string, Record<string, unknown>]> = [
  ['pool', {
    id: 'pool', type: 'pool', label: 'Spent Fuel Pool',
    position: { x: POOL_X, y: POOL_Y }, rotation: 0,
    elevation: -POOL_DEPTH,          // sunk to grade: the rim is at pad level
    side: POOL_SIDE, depth: POOL_DEPTH, wallThickness: 1.2,
    fillLevel: 0.8,                  // 8.4 m of water over a 10.5 m basin
    // 10 MW of decay heat: 170 t of fuel and clad is 5.2e7 J/K, so a dry
    // rack climbs ~190 K per 1000 s. (Was 8 MW; raised 2026-09-09 to put more
    // urgency behind an uncovered rack.)
    fuelPower: 10.0e6,
    assemblyCount: 250, rodsPerAssembly: 264,
    rodDiameter: 9.5, cladThickness: 0.6,
    rackHeight: RACK_HEIGHT, rackBottomElevation: RACK_BOTTOM,
    pressureRating: 2,
    // The make-up nozzles are AT THE RIM, above the water, as a real pool's
    // make-up lines discharge (anti-siphon): a line into the water would be a
    // siphon the moment its pump stopped - a 12" line from a pool ten metres
    // above the sea drains it at ~440 kg/s through an idle pump, which is
    // the very thing that happened in one of Jack's bug reports. Discharging
    // above the water also means a pump has to lift to the rim whatever the
    // level is, so its delivery does not grow as the pool empties.
    ports: [
      { id: 'pool-vent', position: { x: 0, y: -4.5 }, direction: 'both' },
      { id: 'pool-makeup-w', position: { x: -4.5, y: -POOL_DEPTH / 2 }, direction: 'both' },
      { id: 'pool-makeup-e', position: { x: 4.5, y: -POOL_DEPTH / 2 }, direction: 'both' },
    ],
    fluid: { temperature: 318.15, pressure: PSAT_45C, phase: 'two-phase', quality: 0.0001, flowRate: 0 },
    // The pool is open to the sky, so its gas is air at ambient pressure LESS
    // its own vapour partial: N2/O2/Ar summing to 101325 - PSAT_45C. Getting
    // this wrong by even 1.5 kPa leaves the pool 1.5 kPa under the atmosphere
    // it is vented to, and the vent rings like a Helmholtz resonator (+-8 kg/s
    // at t=0, still audible ten minutes later) on the way to equilibrium.
    initialNcg: AIR_TO(101325 - PSAT_45C),
  }],


  ['tank-a', {
    id: 'tank-a', type: 'tank', label: 'Demineralised Water Tank',
    position: { x: 85, y: 95 }, rotation: 0, elevation: 0,
    width: 14, height: 7, wallThickness: 0.05,
    fillLevel: 0.78,                 // 841 m3 of a 1078 m3 tank
    pressureRating: 2,
    ports: [
      { id: 'tank-a-out', position: { x: 7, y: 0 }, direction: 'both' },
      { id: 'tank-a-vent', position: { x: 0, y: -3.5 }, direction: 'both' },
    ],
    fluid: { temperature: 288.15, pressure: PSAT_15C, phase: 'two-phase', quality: 0.0001, flowRate: 0 },
    initialNcg: { N2: 0.786, O2: 0.210 },
  }],
  ['tank-b', {
    id: 'tank-b', type: 'tank', label: 'Fire Water Tank',
    position: { x: 85, y: 50 }, rotation: 0, elevation: 0,
    width: 10, height: 6, wallThickness: 0.05,
    fillLevel: 0.80,                 // 377 m3 of a 471 m3 tank
    pressureRating: 2,
    ports: [
      { id: 'tank-b-out', position: { x: 5, y: 0 }, direction: 'both' },
      { id: 'tank-b-vent', position: { x: 0, y: -3 }, direction: 'both' },
    ],
    fluid: { temperature: 288.15, pressure: PSAT_15C, phase: 'two-phase', quality: 0.0001, flowRate: 0 },
    initialNcg: { N2: 0.786, O2: 0.210 },
  }],

  // The sea, as a component a pump can actually take suction on. It stands on
  // the -4 m shelf, 8 m tall and half full, so its water surface is at 0 m -
  // the sea's own level - and it holds a finite ~7000 t.
  //
  // `waterBody: 'sea'` says its PICTURE is the terrain water body of that
  // name: the views draw no tank, the blue area already painted for the body
  // is the component, and only its nozzle is drawn, at the water's edge. The
  // physics is untouched - this is still an ordinary tank node.
  ['sea', {
    id: 'sea', type: 'tank', label: 'The Sea',
    position: { x: SEA_X, y: 75 }, rotation: 0, elevation: SEA_ELEVATION,
    width: SEA_WIDTH, height: 8, wallThickness: 0.05,
    // The sea is not a 3,600 tonne pond. `volume` overrides the drawn
    // cylinder's own capacity, so the picture stays the size the map has
    // room for while the water in it is effectively unlimited: a 350 kg/s
    // pump running for the whole level draws 10,000 t and takes the surface
    // down 40 cm. Before this it emptied in under three hours, and the pool
    // that depended on it started falling again with nothing on screen to
    // say why.
    volume: 200000,
    fillLevel: 0.5,
    waterBody: 'sea',
    pressureRating: 2,
    ports: [{ id: 'sea-out', position: { x: -SEA_WIDTH / 2, y: SEA_INTAKE_DEPTH }, direction: 'both' }],
    fluid: { temperature: 285.15, pressure: PSAT_12C, phase: 'two-phase', quality: 0.0001, flowRate: 0 },
    initialNcg: { N2: 0.786, O2: 0.210 },
  }],

  ['yard', {
    id: 'yard', type: 'warehouse', label: 'Supply Yard',
    position: { x: 60, y: 35 }, rotation: 0, elevation: 0,
    width: 12, depth: 8,
    // Fully specified: the yard hands out ONE pump design and ONE line size,
    // so placing from it asks the player where the part goes, not what it is.
    // The pump is the wet-pit service water machine (120 kg/s at 12 m, dry,
    // motor on a 6 m column): it only works standing in the sea, and from
    // there it lifts ~65 kg/s to the pool's rim (12.7 m up: above its rated
    // head, so it runs well down its curve) - less than the tear passes, so
    // the tanks have to carry the difference for the whole watch.
    stock: {
      pipeMeters: 300,
      pipeSpec: 'spec-12in-service',
      components: [
        { type: 'pump', design: 'pump-service-water-lp', count: 2 },
        { type: 'valve', design: 'valve-service-water', count: 2 },
      ],
    },
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
  // The liner crack itself is not a component: the earthquake opens it as a
  // scripted BURST on the pool (see the scenario below), which is the same
  // break machinery a pressure rupture uses.
  //
  // The storage tanks BREATHE. Atmospheric tanks have a vent on the roof, and
  // without one a tank that drains pulls a vacuum over its own water until
  // the gravity feed stops: with the gas priced over the vapour space (as it
  // is since 2026-09-10) an unvented 1000 t tank gave up 250 t and quit.
  {
    fromComponentId: 'tank-a', fromPortId: 'tank-a-vent',
    toComponentId: 'atmosphere', toPortId: 'environment',
    fromElevation: 7,
    flowArea: 0.05, length: 3, resistanceCoeff: 2,
  },
  {
    fromComponentId: 'tank-b', fromPortId: 'tank-b-vent',
    toComponentId: 'atmosphere', toPortId: 'environment',
    fromElevation: 6,
    flowArea: 0.05, length: 3, resistanceCoeff: 2,
  },
];

// ---------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------

// The night's earthquake is history by the time the player arrives (it is
// what took the power out); what happens ON WATCH is the aftershock that
// opens the liner, and it happens early - there is nothing to learn from
// watching an intact pool sit there.
//
// TWENTY SECONDS OF WALL TIME, at the level's own 60x: the player gets long
// enough to look at the plant and find the controls before the liner goes,
// and that is measured in the seconds they actually sit through, not in the
// plant's clock. This number is in SIMULATED seconds, so it is 20 x the
// level's simSpeed. Change `simSpeed` in the LevelDef and this wants
// changing with it.
const QUAKE = 1200;          // s - the aftershock cracks the liner (20 s of wall time at 60x)

/**
 * The tear the aftershock leaves. 0.4 m up the pool wall with a 0.8 m
 * opening, so it spans the floor to knee height: while the pool is deep it
 * runs full of water, and as the level sweeps down through the opening the
 * draw crossfades to vapour and the leak dies away on its own - no
 * threshold, no valve, no special case. CRACK_AREA is set so the leak is
 * ~144 kg/s when the liner goes.
 */
const CRACK_AREA = 0.0170;   // m2
const CRACK_ELEVATION = 0.4; // m above the pool floor
const CRACK_OPENING = 0.8;   // m of tear height
// Everything after the quake is written as an offset from it rather than as
// an absolute time, so moving QUAKE moves the whole sequence with it.
//
// FIFTY-FOUR MINUTES between the aftershock and the wave. That is the gap the
// player has to cover with the two site tanks, and it is what makes them a
// real decision rather than a formality: the tsunami is on its way while the
// pool drains, the shore is a death trap until it has been and gone, and a
// pump built down there before it lands is a pump that will be under water
// when it is needed. The warning comes a quarter of an hour before the water
// does - long enough to get off the beach, not long enough to finish
// something down there.
const WAVE_IN = QUAKE + 54 * 60;     // s - the sea starts climbing
const TSUNAMI_WARN = WAVE_IN - 900;  // s - the warning, no physics
/**
 * How high the wave runs, and how fast it comes and goes.
 *
 * +12.6 m is just under the +13 m bench: the water climbs the whole hillside
 * and stops a few tens of centimetres short of the pad, so ANY pump not on
 * the bench goes under - and the only dry ground left is the one place a pump
 * cannot lift the sea from. A tsunami is a long wave, minutes rather than the
 * hour and a half this used to take, so it stands at the peak briefly and
 * then drains back to sea level inside six minutes. The draining is also what
 * strands the debris it carried up the hillside.
 */
const WAVE_PEAK = 12.6;      // m - just below the +13 m bench
const WAVE_RISE = 180;       // s - sea level to the peak
const WAVE_HOLD = 120;       // s - held at the peak
const WAVE_FALL = 240;       // s - peak back to sea level
const WAVE_OUT = WAVE_IN + WAVE_RISE + WAVE_HOLD;  // s - it starts falling back
// 8 sim hours. Long enough that a pool nobody feeds does not merely uncover
// its racks inside the level - with the tear now opening at 20 s it boils dry
// at 4.4 h, the cladding starts to burn at 5.5 h and the release limit goes at
// 6.0 h. A six-hour clock let a do-nothing run WIN, with the fuel dry and on
// fire, before the consequence arrived.
const LEVEL_END = 28800;     // s - 8 sim hours

const scenario = {
  description:
    'An earthquake cracks the spent fuel pool liner; the tsunami behind it runs most of the ' +
    'way up the hill and drains back inside ten minutes. Keep the fuel covered for eight hours.',
  events: [
    {
      time: QUAKE,
      message: 'AFTERSHOCK. The pool liner has cracked - level is falling.',
      actions: [
        { kind: 'shake', seconds: 3, amplitude: 16 },
        {
          kind: 'burst', id: 'pool',
          area: CRACK_AREA, elevation: CRACK_ELEVATION, openingHeight: CRACK_OPENING,
          breachMessage: 'AFTERSHOCK: the pool liner has split at the floor. ' +
            'Water is running out onto the pad.',
        },
      ],
    },
    {
      time: TSUNAMI_WARN,
      message: 'Tsunami warning: get off the shore. The wave is about fifteen minutes out.',
      actions: [],
    },
    {
      time: WAVE_IN,
      message: 'THE WAVE IS COMING IN. It is running right up the hill - everything below ' +
        'the bench goes under.',
      actions: [{ kind: 'water-level', id: 'sea', surface: WAVE_PEAK, over: WAVE_RISE }],
    },
    {
      time: WAVE_OUT,
      message: 'The sea is draining back down the hill, and taking half the beach with it.',
      actions: [{ kind: 'water-level', id: 'sea', surface: 0, over: WAVE_FALL }],
    },
  ],
};

// ---------------------------------------------------------------------------
// What the level cannot survive being broken (a bad seed must not ship)
// ---------------------------------------------------------------------------

const problems: string[] = [];
const at = (x: number, y: number) => terrainHeightAt(terrain, { x, y });
const cell = (c: number, r: number) => heights[r * COLS + c];

for (let r = PAD_R0; r <= PAD_R1; r++) {
  for (let c = PAD_C0; c <= PAD_C1; c++) {
    const h = cell(c, r);
    if (!(h <= PAD_HEIGHT && h >= PAD_HEIGHT - PAD_DISH)) {
      problems.push(`bench cell ${c},${r} is ${h} m, outside the dish ${PAD_HEIGHT - PAD_DISH}..${PAD_HEIGHT}`);
    }
  }
}
// The dish must stay above the wave, or the tsunami fills the pool from above
if (!(PAD_HEIGHT - PAD_DISH > 12.6)) problems.push(`the dish bottom ${PAD_HEIGHT - PAD_DISH} m is not above the 12.6 m wave`);
// The tanks and the yard stand on the rim of the dish, within a few
// centimetres of the pad's datum (the bilinear ground between cells lets
// the dish's edge reach them faintly; that is the ground they stand on, and
// the factory reads it, so there is no phantom head - just a datum a
// hand's breadth off the nominal 13.0)
for (const [what, x, y] of [['tank-a', 85, 95], ['tank-b', 85, 50], ['the yard', 60, 35]] as const) {
  if (!(at(x, y) <= PAD_HEIGHT && at(x, y) >= PAD_HEIGHT - 0.05)) {
    problems.push(`${what} stands on ${at(x, y).toFixed(3)} m, not the ${PAD_HEIGHT} m rim`);
  }
}
// The pool sits in the bottom of the dish
if (Math.abs(at(POOL_X, POOL_Y) - (PAD_HEIGHT - PAD_DISH)) > 0.02) {
  problems.push(`the pool's ground is ${at(POOL_X, POOL_Y).toFixed(3)} m, not the dish bottom ${PAD_HEIGHT - PAD_DISH}`);
}
// The bench is a closed depression: every cell touching it must stand above it
for (let r = PAD_R0 - 1; r <= PAD_R1 + 1; r++) {
  for (let c = PAD_C0 - 1; c <= PAD_C1 + 1; c++) {
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
    if (c >= PAD_C0 && c <= PAD_C1 && r >= PAD_R0 && r <= PAD_R1) continue;
    if (!(cell(c, r) >= PAD_HEIGHT + 0.5)) {
      problems.push(`bench lip ${c},${r} is ${cell(c, r)} m, not clear of the ${PAD_HEIGHT} m bench`);
    }
  }
}
// The shore bench, where the answer's pump stands, and the bench the trapped
// pump stands on (test-game-levels.ts checks 2 and 3)
if (at(95, 75) !== PAD_HEIGHT) problems.push(`the trapped pump's ground is ${at(95, 75)} m, not ${PAD_HEIGHT}`);
const shoreH = at(200, 75);
if (!(shoreH >= 1.4 && shoreH <= 2.0)) problems.push(`the shore pump's ground is ${shoreH.toFixed(2)} m, outside 1.4..2.0`);
// The sea tank's base: its half-full 8 m body puts the water at 0 m only if
// the base is at SEA_BASE, wherever the sloping floor under it happens to be
const seaGround = at(SEA_X, 75);
if (Math.abs(seaGround + SEA_ELEVATION - SEA_BASE) > 1e-3) {
  problems.push(`the sea tank's base is at ${(seaGround + SEA_ELEVATION).toFixed(3)} m, not ${SEA_BASE}`);
}
// The sea floor falls away offshore: a wet-pit pump needs a band of it
// between "bowl under water" and "motor under water" (6 m column)
if (!(at(236, 75) > -3 && at(236, 75) < 0)) problems.push(`the water's edge shelf is ${at(236, 75).toFixed(2)} m, not the shallows`);
for (let x = 234; x <= 234 + SEA_SHELF_RUN; x += 2) {
  if (!(at(x, 75) > -3.8)) problems.push(`the shelf at x=${x} is ${at(x, 75).toFixed(2)} m deep - a dry pump slams filling in more than ~3.7 m`);
}
if (!(at(280, 75) < -6)) problems.push(`the sea at x=280 is only ${at(280, 75).toFixed(2)} m deep - the map should get too deep for the pump`);

// Nothing below sea level may drain anywhere but the sea, or it would render
// as a dry hole in the water (and hold a puddle the player cannot reach).
const model = buildTerrainModel(terrain);
const seaBasin = model.basins.find(b => b.water?.id === 'sea');
if (!seaBasin) problems.push('the terrain has no basin carrying the water body `sea`');
else {
  for (let c = 0; c < heights.length; c++) {
    if (heights[c] < 0 && model.basinOf[c] !== seaBasin.id) {
      problems.push(`cell ${c % COLS},${Math.floor(c / COLS)} at ${heights[c]} m is below sea level but not in the sea`);
    }
  }
}
if (problems.length > 0) {
  console.error(`\n[gen-spent-fuel-pool] the generated map breaks the level:`);
  for (const p of problems) console.error(`  - ${p}`);
  throw new Error(`${problems.length} terrain invariant(s) violated - fix the profile/noise, do not edit the JSON`);
}

// ---------------------------------------------------------------------------

const plant = { components, connections, terrain, scenario };

fs.writeFileSync(OUT, JSON.stringify(plant, null, 1).replace(/\n/g, '\r\n') + '\r\n');
const hMin = Math.min(...heights), hMax = Math.max(...heights);
console.log(`Wrote ${OUT}`);
console.log(`  terrain ${COLS} x ${ROWS} cells of ${CELL} m; relief ${hMin.toFixed(1)} .. ${hMax.toFixed(1)} m ` +
  `(seed ${SEED}, warp ${WARP_AMP} m, relief noise ${VERT_AMP} m)`);
console.log(`  bench ${PAD_HEIGHT} m (dish ${PAD_DISH} m deep at the pool), shore at (200,75) ${shoreH.toFixed(2)} m, ` +
  `sea floor ${at(236, 75).toFixed(1)} m at the edge, ${at(290, 75).toFixed(1)} m at the map's edge`);
console.log(`  shoreline at y=75 is x=${shorelineX(75).toFixed(1)} m; sea nozzle at x=${SEA_PORT_X} ` +
  `(${SEA_INTAKE_DEPTH} m down), body at x=${SEA_X} on ${seaGround.toFixed(2)} m (elevation ${SEA_ELEVATION})`);
console.log(`  rack top at ${(RACK_BOTTOM + RACK_HEIGHT).toFixed(2)} m above the pool floor`);
console.log(`  timeline: quake ${QUAKE} s (3 s of shake), tsunami warning ${TSUNAMI_WARN} s, ` +
  `wave in ${WAVE_IN} s rising to ${WAVE_PEAK} m by ${WAVE_IN + WAVE_RISE} s, ` +
  `falling from ${WAVE_OUT} s, back to sea level ${WAVE_OUT + WAVE_FALL} s, end ${LEVEL_END} s`);
