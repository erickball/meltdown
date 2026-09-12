/**
 * The ground in the 2.5D view: the plant's height field drawn as a lit
 * surface, and the water standing on it (the sea, lakes, puddles from a
 * leak) drawn as a level sheet cut off at its own shoreline.
 *
 * HEIGHTS. The view draws every point at its ground height plus its
 * elevation - a component's `elevation` is above the LOCAL ground, exactly as
 * the simulation reads it (factory.ts absoluteBase) - less one constant, the
 * view datum. The perspective projection has no free camera height: a plane a
 * dozen metres above the one it was built around already lies along the
 * horizon. So the ground the plant stands on has to be that plane, and the
 * datum is the median ground height under the plant's components (see
 * viewDatum). The caller fixes it once per height field, so the picture does
 * not bob as parts are built.
 *
 * MESH. Vertices at the cell centres, where the heights are, plus a ring
 * carried far out past the field at the edge heights - the same "held at the
 * edges" rule terrainHeightAt uses - so land and sea run on to the horizon
 * instead of stopping at the edge of the map. Painted a row at a time from
 * the far edge in: for a height field seen from the south that is the
 * painter's order. Every polygon is clipped to what can be on screen (the
 * near line and the two sides) before it is projected, so the far ring never
 * becomes a million-pixel coordinate.
 *
 * WATER. Each mesh quad is two triangles, and the ground is linear on a
 * triangle, so the part of one below the water surface is a polygon whose
 * cut edge IS the waterline: the shore follows the contours instead of
 * stepping cell by cell, and a rising sea climbs the beach smoothly. Colour
 * goes by depth band - open water, then the shallows - each band cut between
 * two depth contours the same way, so no triangle edge ever shows.
 */

import type { Point } from '../types';
import type { TerrainSpec } from '../terrain-types';
import type { SurfaceWaterState } from '../simulation/operators/surface-water';
import { TerrainModel, buildTerrainModel, cellAt, surfaceAtVolume, terrainHeightAt } from '../simulation/terrain';

/** How far past the height field its edge ring is carried, m: beyond the horizon at any zoom. */
const FAR_M = 1e6;

/**
 * The light the ground is shaded by: the same sun the 2.5D shadows are cast
 * from (canvas.ts: 45 degrees up, 10 degrees round, behind the plant), as the
 * unit vector pointing TOWARD it.
 */
const SUN_ELEVATION = 45 * Math.PI / 180;
const SUN_AZIMUTH = 10 * Math.PI / 180;
const TO_SUN = {
  x: -Math.sin(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
  y: Math.cos(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
  z: Math.sin(SUN_ELEVATION),
};
/** Share of a slope's light that does not depend on which way it faces (sky light). */
const AMBIENT = 0.55;

/** The shallows over open water, each out to a depth contour: the bed showing through as the water thins (a tint laid over the water above it at that opacity). */
const SHALLOWS: Array<{ depth: number; tint: number[]; alpha: number }> = [
  { depth: 2.5, tint: [110, 180, 200], alpha: 0.35 },
  { depth: 0.8, tint: [175, 218, 222], alpha: 0.4 },
];

/** A mesh point: plan position, ground height (m above the terrain's datum) and the cell it takes its basin from. */
export interface GroundVertex {
  x: number;
  y: number;
  h: number;
  cell: number;
}

export interface TerrainScene {
  spec: TerrainSpec;
  model: TerrainModel;
  /** Ground height drawn at the view's grade (see the file comment). */
  datum: number;
  /** Vertex lattice, (cols + 2) x (rows + 2), row-major from the south-west corner. */
  nx: number;
  ny: number;
  verts: GroundVertex[];
  /** Colour of each quad of the lattice, (nx - 1) x (ny - 1): fixed by the ground's shape, so worked out once. */
  quadColours: string[];
}

/** A half-plane of the plan, a*x + b*y + c >= 0. */
export type HalfPlane = [number, number, number];

/** What renderTerrain3D needs of the camera. */
export interface TerrainView {
  /** Screen point of a plan point at height z above the view datum. Only called on points inside `bounds`. */
  project(x: number, y: number, z: number): Point;
  /** Everything that can be on screen lies inside all of these (the near line and the two sides). */
  bounds: HalfPlane[];
  /** Screen y of the horizon, and the viewport, for the haze. */
  horizonY: number;
  width: number;
  height: number;
}

/**
 * The ground height the view draws at grade: the median of the ground under
 * the given plan points (the plant's components), or of the whole field when
 * there are none. A median so that one pump down on the beach does not drop
 * the camera for a plant that stands on a bench.
 */
export function viewDatum(spec: TerrainSpec, standing: Point[]): number {
  const hs = standing.length > 0 ? standing.map(p => terrainHeightAt(spec, p)) : [...spec.heights];
  hs.sort((a, b) => a - b);
  const m = hs.length >> 1;
  return hs.length % 2 === 1 ? hs[m] : (hs[m - 1] + hs[m]) / 2;
}

export function buildTerrainScene(spec: TerrainSpec, datum: number): TerrainScene {
  const { origin, cellSize, cols, rows, heights } = spec;
  const nx = cols + 2, ny = rows + 2;
  // Lattice lines: the cell centres, and one more each side far out
  const line = (o: number, n: number) => {
    const out = [o - FAR_M];
    for (let k = 0; k < n; k++) out.push(o + k * cellSize);
    out.push(o + (n - 1) * cellSize + FAR_M);
    return out;
  };
  const xs = line(origin.x, cols), ys = line(origin.y, rows);
  const verts: GroundVertex[] = [];
  for (let j = 0; j < ny; j++) {
    const cj = Math.max(0, Math.min(rows - 1, j - 1));
    for (let i = 0; i < nx; i++) {
      const ci = Math.max(0, Math.min(cols - 1, i - 1));
      const cell = cj * cols + ci;
      verts.push({ x: xs[i], y: ys[j], h: heights[cell], cell });
    }
  }
  let hMin = Infinity, hMax = -Infinity;
  for (const h of heights) { if (h < hMin) hMin = h; if (h > hMax) hMax = h; }
  const span = Math.max(1, hMax - hMin);
  const quadColours: string[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const v = (di: number, dj: number) => verts[(j + dj) * nx + i + di];
      quadColours.push(groundColour([v(0, 0), v(1, 0), v(1, 1), v(0, 1)], hMin, span));
    }
  }
  return { spec, model: buildTerrainModel(spec), datum, nx, ny, verts, quadColours };
}

/**
 * The water standing in each basin: scripted bodies at their live surface
 * (their declared one before a simulation has run), stored puddles at the
 * surface their volume fills to. Shared by both views.
 */
export function basinSurfaces(model: TerrainModel, surfaceWater: SurfaceWaterState | undefined): Map<number, number> {
  const out = new Map<number, number>();
  for (const b of model.basins) {
    if (b.water) {
      const live = surfaceWater?.bodies.get(b.water.id);
      out.set(b.id, live ? live.surface : b.water.surface);
    } else {
      const v = surfaceWater?.volumes.get(b.id) ?? 0;
      if (v > 0) out.set(b.id, surfaceAtVolume(model, b, v));
    }
  }
  return out;
}

/** The height of what the eye meets at a plan point: the water surface where the ground is under water, else the ground. */
export function visibleSurfaceAt(scene: TerrainScene, surfaces: Map<number, number>, p: Point): number {
  const ground = terrainHeightAt(scene.spec, p);
  const s = surfaces.get(scene.model.basinOf[cellAt(scene.spec, p)]);
  return s !== undefined && s > ground ? s : ground;
}

/** The water body (by id) standing at a plan point, if any. Past the field's edge the edge cells carry on, as they are drawn. */
export function waterBodyAt(scene: TerrainScene, surfaces: Map<number, number>, p: Point): string | undefined {
  const cell = cellAt(scene.spec, p);
  const basinId = scene.model.basinOf[cell];
  const basin = scene.model.basins[basinId];
  const s = surfaces.get(basinId);
  if (!basin?.water || s === undefined) return undefined;
  return terrainHeightAt(scene.spec, p) < s ? basin.water.id : undefined;
}

/**
 * The plan point the eye meets under a screen point. `rayAt(d)` is the plan
 * point at plan distance d ahead of the camera on that line of sight, and
 * `screenYAt(p)` the screen y of the visible surface there. March out from
 * `near` in geometric steps to the first place that surface projects at or
 * above the cursor - the first thing the line of sight hits, so a hill hides
 * what is behind it - then bisect. Null when the line of sight meets nothing
 * short of `far` (the cursor is in the sky).
 */
export function pickGround(
  near: number, far: number, screenY: number,
  rayAt: (d: number) => Point, screenYAt: (p: Point) => number,
): Point | null {
  const STEPS = 400;
  const ratio = Math.pow(far / near, 1 / STEPS);
  let lo = near;
  if (screenYAt(rayAt(lo)) <= screenY) return rayAt(lo);
  for (let k = 1; k <= STEPS; k++) {
    const hi = near * Math.pow(ratio, k);
    if (screenYAt(rayAt(hi)) <= screenY) {
      let a = lo, b = hi;
      for (let n = 0; n < 40; n++) {
        const m = (a + b) / 2;
        if (screenYAt(rayAt(m)) <= screenY) b = m; else a = m;
      }
      return rayAt(b);
    }
    lo = hi;
  }
  return null;
}

/**
 * Sutherland-Hodgman against one side, `f(p) >= 0` kept, carrying the
 * height along the cut. Points the cut makes are also pushed on `cut`.
 */
export function clipPolygon(poly: GroundVertex[], f: (p: GroundVertex) => number, cut?: GroundVertex[]): GroundVertex[] {
  const out: GroundVertex[] = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, h: a.h + (b.h - a.h) * t, cell: a.cell };
      out.push(p);
      cut?.push(p);
    }
  }
  return out;
}

function inside(poly: GroundVertex[], bounds: HalfPlane[]): GroundVertex[] | null {
  let p = poly;
  if (p.length < 3) return null;
  // Most polygons are wholly on screen: nothing to cut
  if (bounds.every(([a, b, c]) => poly.every(v => a * v.x + b * v.y + c >= 0))) return poly;
  for (const [a, b, c] of bounds) {
    p = clipPolygon(p, v => a * v.x + b * v.y + c);
    if (p.length < 3) return null;
  }
  return p;
}

function segmentInside(p: GroundVertex, q: GroundVertex, bounds: HalfPlane[]): [GroundVertex, GroundVertex] | null {
  let t0 = 0, t1 = 1;
  for (const [a, b, c] of bounds) {
    const fp = a * p.x + b * p.y + c, fq = a * q.x + b * q.y + c;
    if (fp < 0 && fq < 0) return null;
    if (fp < 0) t0 = Math.max(t0, fp / (fp - fq));
    else if (fq < 0) t1 = Math.min(t1, fp / (fp - fq));
  }
  if (t0 >= t1) return null;
  const at = (t: number) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, h: p.h + (q.h - p.h) * t, cell: p.cell });
  return [at(t0), at(t1)];
}

const mix = (a: number[], b: number[], t: number) => a.map((v, k) => v + (b[k] - v) * t);
const rgb = (c: number[]) => `rgb(${Math.round(Math.min(255, c[0]))}, ${Math.round(Math.min(255, c[1]))}, ${Math.round(Math.min(255, c[2]))})`;

/** Ground colour: the grid's height tint (valley green to hilltop tan) laid over sand, lit by the slope's face to the sun. */
function groundColour(q: GroundVertex[], hMin: number, span: number): string {
  const [v00, v10, v11, v01] = q;
  const hm = (v00.h + v10.h + v11.h + v01.h) / 4;
  const t = (hm - hMin) / span;
  const base = mix([70 + 140 * t, 125 + 45 * t, 55 + 55 * t], [217, 197, 144], 0.5);
  // Normal from the diagonals (counter-clockwise from above, so it points up)
  const d1 = { x: v11.x - v00.x, y: v11.y - v00.y, z: v11.h - v00.h };
  const d2 = { x: v01.x - v10.x, y: v01.y - v10.y, z: v01.h - v10.h };
  const n = { x: d1.y * d2.z - d1.z * d2.y, y: d1.z * d2.x - d1.x * d2.z, z: d1.x * d2.y - d1.y * d2.x };
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  const facing = (n.x * TO_SUN.x + n.y * TO_SUN.y + n.z * TO_SUN.z) / len;
  // Level ground takes the light it always had; slopes turned to the sun are brighter, turned away darker
  const shade = AMBIENT + (1 - AMBIENT) * Math.max(0, facing) / TO_SUN.z;
  return rgb(base.map(v => v * shade));
}

/**
 * Water seen from above: open water (layer 0) or the band of SHALLOWS[layer
 * - 1], composited over the layers under it - so every layer is opaque and
 * can be edged in its own colour without leaving a seam. A body the player
 * has picked out is tinted.
 */
function waterColour(lit: 'selected' | 'hovered' | null, layer: number): string {
  let c = [38, 94, 150];
  if (lit === 'selected') c = mix(c, [120, 200, 255], 0.35);
  else if (lit === 'hovered') c = mix(c, [255, 255, 255], 0.18);
  for (let k = 0; k < layer; k++) c = mix(c, SHALLOWS[k].tint, SHALLOWS[k].alpha);
  return rgb(c);
}

/**
 * Paint the ground and its water. `lit` is the water body to pick out (a
 * tank that IS that body is selected or hovered - the water is all there is
 * of it to see).
 */
export function renderTerrain3D(
  ctx: CanvasRenderingContext2D,
  scene: TerrainScene,
  view: TerrainView,
  surfaces: Map<number, number>,
  lit: { body: string; selected: boolean } | null,
): void {
  const { nx, ny, verts, model, datum } = scene;
  const addPath = (poly: GroundVertex[], z: (v: GroundVertex) => number) => {
    for (let k = 0; k < poly.length; k++) {
      const s = view.project(poly[k].x, poly[k].y, z(poly[k]));
      if (k === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();
  };
  type Sheet = { poly: GroundVertex[]; z: number };

  ctx.save();
  ctx.lineJoin = 'round';
  for (let j = ny - 2; j >= 0; j--) {
    // Water in this row by layer (open water, then each band of shallows)
    // and colour - one path each, so it has no seams - and the waterline
    const layers: Array<Map<string, Sheet[]>> = [new Map(), ...SHALLOWS.map(() => new Map<string, Sheet[]>())];
    const ground = new Map<string, GroundVertex[][]>();
    const shore: Array<{ a: GroundVertex; b: GroundVertex; z: number; lit: boolean }> = [];
    ctx.lineWidth = 1;
    for (let i = 0; i < nx - 1; i++) {
      const v00 = verts[j * nx + i], v10 = verts[j * nx + i + 1];
      const v01 = verts[(j + 1) * nx + i], v11 = verts[(j + 1) * nx + i + 1];
      const quad = inside([v00, v10, v11, v01], view.bounds);
      if (!quad) continue;
      const colour = scene.quadColours[j * (nx - 1) + i];
      let quads = ground.get(colour);
      if (!quads) ground.set(colour, quads = []);
      quads.push(quad);

      for (const tri of [[v00, v10, v11], [v00, v11, v01]]) {
        // The highest water any corner is under covers the triangle up to its waterline
        let surface = -Infinity, basinId = -1;
        for (const v of tri) {
          const b = model.basinOf[v.cell];
          const s = surfaces.get(b);
          if (s !== undefined && s > v.h && s > surface) { surface = s; basinId = b; }
        }
        if (basinId < 0) continue;
        const cut: GroundVertex[] = [];
        const under = clipPolygon(tri, v => surface - v.h, cut);
        const poly = inside(under, view.bounds);
        if (!poly) continue;
        const z = surface - datum;
        const body = model.basins[basinId].water?.id;
        const isLit = lit !== null && body === lit.body;
        const tone = isLit ? (lit!.selected ? 'selected' : 'hovered') : null;
        const put = (layer: number, sheet: GroundVertex[]) => {
          const colour = waterColour(tone, layer);
          let sheets = layers[layer].get(colour);
          if (!sheets) layers[layer].set(colour, sheets = []);
          sheets.push({ poly: sheet, z });
        };
        // The layers are disjoint depth ranges, each between two depth
        // contours - open water beyond the deepest band, then each band of
        // shallows - so a layer's edge only ever bleeds into the same layer
        // of the row beside it
        let dMin = Infinity, dMax = -Infinity;
        for (const v of under) {
          const d = surface - v.h;
          if (d < dMin) dMin = d;
          if (d > dMax) dMax = d;
        }
        for (let layer = 0; layer <= SHALLOWS.length; layer++) {
          const deeper = layer === 0 ? Infinity : SHALLOWS[layer - 1].depth;
          const shallower = layer < SHALLOWS.length ? SHALLOWS[layer].depth : 0;
          if (dMax <= shallower || dMin >= deeper) continue;
          let part = under;
          if (dMin < shallower) part = clipPolygon(part, v => (surface - v.h) - shallower);
          if (dMax > deeper) part = clipPolygon(part, v => deeper - (surface - v.h));
          const sheet = inside(part, view.bounds);
          if (sheet) put(layer, sheet);
        }
        if (cut.length === 2) shore.push({ a: cut[0], b: cut[1], z, lit: isLit });
      }
    }
    // The row's ground, then its water over it: one path per colour, filled
    // and edged in that colour so neighbouring pieces leave no seam
    for (const [colour, quads] of ground) {
      ctx.beginPath();
      for (const q of quads) addPath(q, v => v.h - datum);
      ctx.fillStyle = colour;
      ctx.strokeStyle = colour;
      ctx.fill();
      ctx.stroke();
    }
    for (const layer of layers) {
      for (const [colour, sheets] of layer) {
        ctx.beginPath();
        for (const s of sheets) addPath(s.poly, () => s.z);
        ctx.fillStyle = colour;
        ctx.strokeStyle = colour;
        ctx.fill();
        ctx.stroke();
      }
    }
    // The waterline: a pale line of broken water along every shore
    for (const s of shore) {
      const seg = segmentInside(s.a, s.b, view.bounds);
      if (!seg) continue;
      const a = view.project(seg[0].x, seg[0].y, s.z);
      const b = view.project(seg[1].x, seg[1].y, s.z);
      ctx.strokeStyle = s.lit ? (lit!.selected ? 'rgba(80, 220, 255, 0.95)' : 'rgba(255, 255, 255, 0.95)') : 'rgba(236, 244, 246, 0.8)';
      ctx.lineWidth = s.lit ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // Haze toward the horizon, so land and sea fade into distance instead of
  // ending in a hard line against the sky
  const hazeDepth = (view.height - view.horizonY) * 0.3;
  if (hazeDepth > 0) {
    const g = ctx.createLinearGradient(0, view.horizonY, 0, view.horizonY + hazeDepth);
    g.addColorStop(0, 'rgba(216, 232, 240, 0.6)');
    g.addColorStop(1, 'rgba(216, 232, 240, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, view.horizonY, view.width, hazeDepth);
  }
  ctx.restore();
}
