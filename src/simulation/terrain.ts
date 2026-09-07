/**
 * Terrain: ground heights and where water goes when it is on the ground.
 *
 * A plant may carry a height field (metres above datum, on a regular grid
 * of cells in the plan). Everything is derived from it:
 *
 *  - The ground height under any plan point (bilinear between cell
 *    centres, held at the edge outside the field). A component's absolute
 *    base is the ground under it plus its own `elevation`, so "elevation"
 *    means "above local ground" - a tank on a hill has its head for free.
 *  - Basins: every cell drains downhill (steepest descent over its 8
 *    neighbours) to a local minimum; the cells sharing a minimum are one
 *    basin. Each basin has a stage-storage curve (surface height as a
 *    function of stored volume, from its cells sorted by height) and a spill
 *    height - the lowest cell at which water would cross into a neighbouring
 *    basin - with that neighbour.
 *  - Water bodies: a basin may be declared a sea or lake, whose surface is a
 *    boundary condition (scripted, e.g. a tsunami) rather than a stored
 *    volume. Every other basin holds whatever falls into it and loses it by
 *    infiltration through the wetted area, so a leak makes a puddle that
 *    spreads until the ground drinks as fast as the leak runs.
 *
 * Pure geometry and bookkeeping; no simulation imports.
 */
import type { TerrainSpec, WaterBodySpec, TerrainPoint as Point } from '../terrain-types';
export type { TerrainSpec, WaterBodySpec } from '../terrain-types';

/** Default infiltration: 0.1 mm/s = 360 mm/h, a sandy gravel. */
export const DEFAULT_INFILTRATION = 1e-4;

export interface Basin {
  id: number;
  /** Cell index (row * cols + col) of the sink. */
  sink: number;
  sinkHeight: number;
  /** Cells of the basin sorted by height (ascending): the stage-storage curve. */
  cells: Int32Array;
  cellHeights: Float64Array;
  /** Lowest cell height at which water leaves this basin, and into which basin. */
  spillHeight: number;
  spillTo: number;
  /** Water body this basin is, if declared one. */
  water?: WaterBodySpec;
}

export interface TerrainModel {
  spec: TerrainSpec;
  /** Basin id per cell. */
  basinOf: Int32Array;
  basins: Basin[];
}

const NEIGHBOURS: Array<[number, number]> = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];

/** Ground height at a plan point, bilinear between cell centres, held at the edges. No terrain = 0. */
export function terrainHeightAt(spec: TerrainSpec | undefined, p: Point): number {
  if (!spec) return 0;
  const { origin, cellSize, cols, rows, heights } = spec;
  const fx = (p.x - origin.x) / cellSize;
  const fy = (p.y - origin.y) / cellSize;
  const cx = Math.max(0, Math.min(cols - 1, fx));
  const cy = Math.max(0, Math.min(rows - 1, fy));
  const i0 = Math.floor(cx), j0 = Math.floor(cy);
  const i1 = Math.min(cols - 1, i0 + 1), j1 = Math.min(rows - 1, j0 + 1);
  const tx = cx - i0, ty = cy - j0;
  const h = (i: number, j: number) => heights[j * cols + i];
  return (1 - ty) * ((1 - tx) * h(i0, j0) + tx * h(i1, j0)) + ty * ((1 - tx) * h(i0, j1) + tx * h(i1, j1));
}

/** The cell containing a plan point (clamped to the field), or -1 without terrain. */
export function cellAt(spec: TerrainSpec | undefined, p: Point): number {
  if (!spec) return -1;
  const i = Math.max(0, Math.min(spec.cols - 1, Math.round((p.x - spec.origin.x) / spec.cellSize)));
  const j = Math.max(0, Math.min(spec.rows - 1, Math.round((p.y - spec.origin.y) / spec.cellSize)));
  return j * spec.cols + i;
}

/** Plan position of a cell's centre. */
export function cellCenter(spec: TerrainSpec, cell: number): Point {
  const i = cell % spec.cols, j = Math.floor(cell / spec.cols);
  return { x: spec.origin.x + i * spec.cellSize, y: spec.origin.y + j * spec.cellSize };
}

/**
 * Drainage: which basin each cell belongs to, and the basins themselves.
 * Steepest descent with path compression; a cell with no lower neighbour is
 * a sink. Flat ties resolve to the first lower-or-equal neighbour found
 * along a fixed order, which is enough for a game map (a perfectly flat
 * plateau becomes one basin at its first cell).
 */
export function buildTerrainModel(spec: TerrainSpec): TerrainModel {
  const { cols, rows, heights } = spec;
  const n = cols * rows;
  if (heights.length !== n) {
    throw new Error(`[terrain] height field has ${heights.length} values for ${cols}x${rows} cells`);
  }
  // Downhill pointer per cell (-1 = sink)
  const down = new Int32Array(n).fill(-1);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = j * cols + i;
      let best = -1, bestDrop = 0;
      for (const [di, dj] of NEIGHBOURS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
        const nc = nj * cols + ni;
        const dist = di !== 0 && dj !== 0 ? Math.SQRT2 : 1;
        const drop = (heights[c] - heights[nc]) / dist;
        if (drop > bestDrop) { bestDrop = drop; best = nc; }
      }
      down[c] = best;
    }
  }
  // Sink of every cell, with path compression
  const sinkOf = new Int32Array(n).fill(-1);
  const resolve = (c: number): number => {
    if (sinkOf[c] >= 0) return sinkOf[c];
    const path: number[] = [];
    let cur = c;
    while (sinkOf[cur] < 0 && down[cur] >= 0) { path.push(cur); cur = down[cur]; }
    const sink = sinkOf[cur] >= 0 ? sinkOf[cur] : cur;
    sinkOf[cur] = sink;
    for (const p of path) sinkOf[p] = sink;
    return sink;
  };
  for (let c = 0; c < n; c++) resolve(c);

  // Flat ground: neighbouring sinks at the same height (a level shoreline,
  // a plateau, the whole sea) are one basin, not one per cell. Union the
  // sinks across level neighbours, then label by the root sink.
  const parent = new Int32Array(n);
  for (let c = 0; c < n; c++) parent[c] = c;
  const find = (c: number): number => {
    while (parent[c] !== c) { parent[c] = parent[parent[c]]; c = parent[c]; }
    return c;
  };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const LEVEL = 1e-9;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = j * cols + i;
      if (sinkOf[c] !== c) continue; // only sinks seed flats
      for (const [di, dj] of NEIGHBOURS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
        const nc = nj * cols + ni;
        if (Math.abs(heights[nc] - heights[c]) < LEVEL) union(sinkOf[nc], c);
      }
    }
  }

  const basinOf = new Int32Array(n);
  const idOfSink = new Map<number, number>();
  const basins: Basin[] = [];
  for (let c = 0; c < n; c++) {
    const sink = find(sinkOf[c]);
    let id = idOfSink.get(sink);
    if (id === undefined) {
      id = basins.length;
      idOfSink.set(sink, id);
      basins.push({ id, sink, sinkHeight: heights[sink], cells: new Int32Array(0), cellHeights: new Float64Array(0), spillHeight: Infinity, spillTo: -1 });
    }
    basinOf[c] = id;
  }
  // Cells per basin, sorted by height (stage-storage), and the spill
  const members: number[][] = basins.map(() => []);
  for (let c = 0; c < n; c++) members[basinOf[c]].push(c);
  for (const b of basins) {
    const cells = members[b.id].sort((p, q) => heights[p] - heights[q]);
    b.cells = Int32Array.from(cells);
    b.cellHeights = Float64Array.from(cells.map(c => heights[c]));
    // Spill: the lowest boundary crossing - a cell of this basin next to a
    // cell of another; water crosses at the higher of the two heights
    for (const c of cells) {
      const i = c % cols, j = Math.floor(c / cols);
      for (const [di, dj] of NEIGHBOURS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
        const nc = nj * cols + ni;
        if (basinOf[nc] === b.id) continue;
        const crossing = Math.max(heights[c], heights[nc]);
        if (crossing < b.spillHeight) { b.spillHeight = crossing; b.spillTo = basinOf[nc]; }
      }
    }
  }
  // Water bodies
  for (const w of spec.waters ?? []) {
    const c = cellAt(spec, w.seed);
    const b = basins[basinOf[c]];
    if (b.water) throw new Error(`[terrain] water bodies '${b.water.id}' and '${w.id}' share a basin`);
    b.water = w;
  }
  return { spec, basinOf, basins };
}

const EPS = 1e-9;

/** Volume (m³) stored in a basin when its surface stands at `surface`. */
export function volumeAtSurface(model: TerrainModel, basin: Basin, surface: number): number {
  const a = model.spec.cellSize * model.spec.cellSize;
  let v = 0;
  for (let k = 0; k < basin.cells.length; k++) {
    const h = basin.cellHeights[k];
    if (h >= surface) break;
    v += (surface - h) * a;
  }
  return v;
}

/** Surface height (m) of a basin holding `volume` m³ (its sink height when empty). */
export function surfaceAtVolume(model: TerrainModel, basin: Basin, volume: number): number {
  if (volume <= EPS) return basin.sinkHeight;
  const a = model.spec.cellSize * model.spec.cellSize;
  // Fill cell by cell: with k cells wetted, the surface s satisfies
  // sum_{m<k} (s - h_m) * a = volume, valid while s <= h_k
  let filled = 0;
  for (let k = 1; k <= basin.cells.length; k++) {
    filled += basin.cellHeights[k - 1];
    const s = (volume / a + filled) / k;
    if (k === basin.cells.length || s <= basin.cellHeights[k]) return s;
  }
  return basin.cellHeights[basin.cells.length - 1];
}

/** Plan area (m²) of the water surface in a basin at `surface`. */
export function wettedArea(model: TerrainModel, basin: Basin, surface: number): number {
  const a = model.spec.cellSize * model.spec.cellSize;
  let k = 0;
  while (k < basin.cellHeights.length && basin.cellHeights[k] < surface) k++;
  return k * a;
}

/** Ground height of a cell. */
export function cellHeight(spec: TerrainSpec, cell: number): number {
  return spec.heights[cell];
}

/** A flat height field (handy for tests and as an editor starting point). */
export function flatTerrain(origin: Point, cellSize: number, cols: number, rows: number, height = 0): TerrainSpec {
  return { origin, cellSize, cols, rows, heights: new Array(cols * rows).fill(height) };
}
