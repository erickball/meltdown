/**
 * Contour lines for the grid view's height field.
 *
 * The ground is stored as heights at cell CENTRES and read anywhere by
 * bilinear interpolation (`terrainHeightAt`), so that interpolated surface -
 * not the blocky cells - is what a contour should follow. This walks
 * marching squares over a refined lattice sampled from it and chains the
 * segments into polylines, which the view then draws through their midpoints
 * as quadratic curves. The result curves and closes the way a real contour
 * does, instead of running along cell edges as a staircase.
 *
 * Everything here is in WORLD coordinates and depends only on the height
 * field, so a plant's contours are computed once and survive every camera
 * move. Pure geometry: no canvas, no camera.
 */
import type { TerrainSpec, TerrainPoint as Point } from '../terrain-types';
import { terrainHeightAt } from '../simulation/terrain';

export interface ContourSet {
  /** Contour interval (m). */
  interval: number;
  /** True for the heavier index contours. */
  major: boolean;
  /** Polylines in world metres; a closed line repeats its first point. */
  lines: Point[][];
}

/** Sub-samples per cell. Three keeps a 10 m cell's contour smooth for pennies. */
const SUBDIVISION = 3;
/** Points closer than this are the same point when chaining segments. */
const WELD = 1e-3;

/**
 * The intervals a map of this relief should carry: a minor interval of about
 * a twelfth of the total relief rounded to 1/2/5, and an index contour every
 * fifth one. Minor lines are dropped when the ground steps by more than the
 * interval from cell to cell, which is the case where every cell edge would
 * carry a line and the map would read as noise. (Same rule the cell-edge
 * contours used before; it is a property of the field, not of the drawing.)
 */
export function contourIntervals(spec: TerrainSpec): { minor: number; major: number; drawMinor: boolean } {
  const { heights, cols, rows } = spec;
  let hMin = Infinity, hMax = -Infinity;
  for (const h of heights) { if (h < hMin) hMin = h; if (h > hMax) hMax = h; }
  const span = Math.max(1, hMax - hMin);
  const raw = span / 12;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const minor = [1, 2, 5, 10].map(m => m * mag).find(v => v >= raw) ?? 10 * mag;

  let step = 0, edges = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i + 1 < cols; i++) {
      step += Math.abs(heights[j * cols + i + 1] - heights[j * cols + i]);
      edges++;
    }
  }
  return { minor, major: minor * 5, drawMinor: edges > 0 && step / edges < minor };
}

/** Every contour of a height field, minor and major, as world-space polylines. */
export function contourPolylines(spec: TerrainSpec): ContourSet[] {
  const { minor, major, drawMinor } = contourIntervals(spec);
  const field = sampleField(spec);
  const out: ContourSet[] = [];
  if (drawMinor) {
    // Skip the levels the index contours will draw anyway, so a major line
    // is not drawn twice (the thin one would fringe the thick one)
    out.push({ interval: minor, major: false, lines: linesAt(field, minor, level => Math.abs(level % major) > minor * 0.01) });
  }
  out.push({ interval: major, major: true, lines: linesAt(field, major, () => true) });
  return out;
}

interface Field {
  values: Float64Array;
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  step: number;
  min: number;
  max: number;
}

/** The interpolated ground on a lattice SUBDIVISION times finer than the cells. */
function sampleField(spec: TerrainSpec): Field {
  const nx = (spec.cols - 1) * SUBDIVISION + 1;
  const ny = (spec.rows - 1) * SUBDIVISION + 1;
  const step = spec.cellSize / SUBDIVISION;
  const values = new Float64Array(nx * ny);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = terrainHeightAt(spec, { x: spec.origin.x + i * step, y: spec.origin.y + j * step });
      values[j * nx + i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { values, nx, ny, x0: spec.origin.x, y0: spec.origin.y, step, min, max };
}

function linesAt(field: Field, interval: number, wanted: (level: number) => boolean): Point[][] {
  const lines: Point[][] = [];
  const first = Math.ceil(field.min / interval);
  const last = Math.floor(field.max / interval);
  for (let k = first; k <= last; k++) {
    const level = k * interval;
    if (!wanted(level)) continue;
    for (const line of chain(marchingSquares(field, level))) lines.push(line);
  }
  return lines;
}

/**
 * Marching squares over the lattice: one or two segments per cell, cut where
 * the level crosses each edge. The two saddle cases are resolved the same way
 * every time (the two corners above the level are joined to their own nearest
 * edges), which can only ever pick the wrong pair of a saddle - never leave a
 * dangling end.
 */
function marchingSquares(field: Field, level: number): Array<[Point, Point]> {
  const { values, nx, ny, x0, y0, step } = field;
  const segs: Array<[Point, Point]> = [];
  const X = (i: number) => x0 + i * step;
  const Y = (j: number) => y0 + j * step;
  const cut = (a: number, b: number) => {
    const d = b - a;
    return Math.abs(d) < 1e-12 ? 0.5 : (level - a) / d;
  };
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const a = values[j * nx + i];             // north-west
      const b = values[j * nx + i + 1];         // north-east
      const c = values[(j + 1) * nx + i + 1];   // south-east
      const d = values[(j + 1) * nx + i];       // south-west
      const code = (a >= level ? 8 : 0) | (b >= level ? 4 : 0) | (c >= level ? 2 : 0) | (d >= level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const N = { x: X(i + cut(a, b)), y: Y(j) };
      const E = { x: X(i + 1), y: Y(j + cut(b, c)) };
      const S = { x: X(i + cut(d, c)), y: Y(j + 1) };
      const W = { x: X(i), y: Y(j + cut(a, d)) };
      switch (code) {
        case 1: case 14: segs.push([W, S]); break;
        case 2: case 13: segs.push([S, E]); break;
        case 3: case 12: segs.push([W, E]); break;
        case 4: case 11: segs.push([N, E]); break;
        case 6: case 9: segs.push([N, S]); break;
        case 7: case 8: segs.push([W, N]); break;
        case 5: segs.push([W, N]); segs.push([S, E]); break;
        case 10: segs.push([N, E]); segs.push([W, S]); break;
      }
    }
  }
  return segs;
}

function key(p: Point): string {
  return `${Math.round(p.x / WELD)},${Math.round(p.y / WELD)}`;
}

/**
 * Join segments that share an endpoint into polylines. Open lines (those
 * running off the edge of the field) come out as open polylines; closed ones
 * come back to their first point.
 */
function chain(segs: Array<[Point, Point]>): Point[][] {
  const ends = new Map<string, number[]>();
  segs.forEach((s, idx) => {
    for (const p of s) {
      const k = key(p);
      const list = ends.get(k);
      if (list) list.push(idx); else ends.set(k, [idx]);
    }
  });
  const used = new Array<boolean>(segs.length).fill(false);

  /** Walk from one end of a segment, consuming segments as it goes. */
  const walk = (from: Point, seedIdx: number): Point[] => {
    const pts: Point[] = [from];
    let at = from;
    let idx: number | undefined = seedIdx;
    while (idx !== undefined) {
      used[idx] = true;
      const seg: [Point, Point] = segs[idx];
      const next: Point = key(seg[0]) === key(at) ? seg[1] : seg[0];
      pts.push(next);
      at = next;
      idx = (ends.get(key(next)) ?? []).find(i => !used[i]);
    }
    return pts;
  };

  const lines: Point[][] = [];
  // Open lines first, seeded from the endpoints that only one segment touches
  for (const [k, list] of ends) {
    if (list.length !== 1 || used[list[0]]) continue;
    const seg = segs[list[0]];
    const start = key(seg[0]) === k ? seg[0] : seg[1];
    lines.push(walk(start, list[0]));
  }
  // Whatever is left is a loop
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    lines.push(walk(segs[i][0], i));
  }
  return lines.filter(l => l.length >= 2);
}
