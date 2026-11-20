/**
 * The 3D view: turns a Scene3DModel (types.ts) into three.js meshes and owns
 * the camera, lights, ground and sky.
 *
 * This is the only file that imports three.js; the app loads it lazily
 * (`await import('./scene3d/view3d')`) so the library stays out of the main
 * bundle.
 *
 * AXES. The model is x east, y north, z up (metres). three.js is y up. The one
 * place the change happens is `toThree` / `setThree`: model (x, y, z) ->
 * three (x, z, -y). That map is a proper rotation, so windings and normals
 * built in model terms keep their sense.
 *
 * MESHES. One mesh (two for a translucent part) and one material per part,
 * so `setColors` only writes colours into materials it already has. A
 * translucent part is drawn as a back-face mesh and a front-face mesh with
 * depth writes off: back faces of large shells first, then everything
 * smaller, then the large shells' front faces last, so whatever stands
 * inside a shell is seen through it whatever the nesting.
 *
 * DEPTH. A site runs to a ground ring thousands of metres out while a valve
 * can be inspected from a metre away, so the renderer uses a logarithmic
 * depth buffer and sets near/far every frame from the camera's distance to
 * its target.
 *
 * KEYS. While the view is visible, held arrow keys pan the orbit target
 * along the ground relative to the camera's heading (Up = away from the
 * camera), at a rate proportional to the camera's distance, integrated in
 * render() with the real frame time. Keys aimed at a form control, or
 * pressed while something (a dialog) covers the middle of the view, are
 * left alone.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type {
  BoxPart, CylinderPart, Ground3D, Material3D, Part3D, PartColor, Scene3DModel,
  SurfacePart, TubePart, Vec3,
} from './types';
import type { TerrainSpec } from '../../terrain-types';

export interface Pick3D { partId: string; componentId?: string; connectionKey?: string }

// ---------------------------------------------------------------------------
// Palette: chosen to sit with the 2.5D view (colors.ts steel, the desert
// ground and sky of isometric.ts, terrain-3d.ts's height tint and water).

interface MaterialLook { color: string; roughness: number; metalness: number }

// Metalness kept low: with no environment map a metallic surface only
// darkens, and most steel parts carry a live fluid colour that has to read
// as the same colour the 2.5D view paints
const MATERIAL_LOOKS: Record<Material3D, MaterialLook> = {
  steel: { color: '#8a9aab', roughness: 0.5, metalness: 0.08 },
  machinery: { color: '#6f8291', roughness: 0.55, metalness: 0.08 },
  concrete: { color: '#bdb6a8', roughness: 0.9, metalness: 0 },
  structure: { color: '#b08d4f', roughness: 0.7, metalness: 0.2 },
  electrical: { color: '#62756a', roughness: 0.6, metalness: 0.15 },
  fuel: { color: '#c47a3a', roughness: 0.6, metalness: 0.1 },
  water: { color: '#265e96', roughness: 0.15, metalness: 0 },
};

/** Sky at the zenith and at the horizon (isometric.ts sky gradient); the horizon colour is also the haze. */
const SKY_TOP = '#a8c8e8';
const SKY_HORIZON = '#d8e8f0';
/** Flat desert ground (isometric.ts mid sand). */
const SAND = '#d9c590';
/** Highlight: an emissive tint added to the selected parts, and their edge lines. */
const HIGHLIGHT_TINT = new THREE.Color('#0f6a8a');
const HIGHLIGHT_EDGE = '#20e0ff';

/** Toward the sun, model axes: high in the south-east, so shadows fall north-west and the default (south-west) view sees lit faces. */
const TO_SUN_MODEL: Vec3 = (() => {
  const elevation = 50 * Math.PI / 180;
  const azimuth = 140 * Math.PI / 180; // from north, clockwise
  return {
    x: Math.sin(azimuth) * Math.cos(elevation),
    y: Math.cos(azimuth) * Math.cos(elevation),
    z: Math.sin(elevation),
  };
})();

/** Default viewing direction (from target toward camera), model axes: from the south-south-west, about 28 degrees up. */
const VIEW_FROM_MODEL: Vec3 = { x: -0.4, y: -1, z: 0.57 };
/** frameAll leaves this much room round the plant (a factor on the fitting distance). */
const FRAME_MARGIN = 1.06;

/** The ground runs out to at least this far from the plant (m), so it meets the haze rather than ending. */
const GROUND_MIN_REACH = 5000;
/** ...or this many plant radii, whichever is further. */
const GROUND_REACH_RADII = 30;
/** Haze starts and becomes total at these multiples of the plant radius (the radius taken as at least HAZE_MIN_RADIUS). */
const HAZE_NEAR_RADII = 3;
const HAZE_FAR_RADII = 28;
const HAZE_MIN_RADIUS = 60;
/** Shadow map texels; a 300 m plant gets ~10 cm texels. */
const SHADOW_MAP_SIZE = 4096;
/** Camera never closer to its target than this (m): a small valve still fills the screen. */
const MIN_ORBIT_DISTANCE = 0.05;
/** The camera's eye is kept this far above the ground under it (m). */
const EYE_CLEARANCE = 0.05;
/** Held arrow keys pan the orbit target this many camera-to-target distances per second. */
const KEY_PAN_RATE = 0.8;
/** Longest frame gap a held-key pan integrates over (s), so a stalled tab does not jump the camera. */
const KEY_PAN_MAX_DT = 0.1;
/** Arrow key -> pan direction: x screen-right, y away from the camera. */
const KEY_PAN_DIRS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: 1 }, ArrowDown: { x: 0, y: -1 },
};

const CYL_SEGMENTS = 48;
const DOME_STEPS = 12;
const TUBE_SEGMENTS = 16;
/** Bend radius of a pipe elbow in pipe radii (a long-radius elbow is 1.5 diameters = 3 radii; this reads better at plant scale). */
const ELBOW_BEND_RADII = 1.5;

// ---------------------------------------------------------------------------
// Axes

function toThree(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.z, -v.y);
}

function unitThree(v: Vec3, what: string): THREE.Vector3 {
  const t = toThree(v);
  const len = t.length();
  if (!(len > 0) || !Number.isFinite(len)) throw new Error(`View3D: ${what} has no direction (${JSON.stringify(v)})`);
  return t.divideScalar(len);
}

function checkFinite(v: Vec3, what: string): void {
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
    throw new Error(`View3D: ${what} is not a finite point (${JSON.stringify(v)})`);
  }
}

// ---------------------------------------------------------------------------
// Geometry builders. Each returns a geometry in three's axes, world placed.

/** A point of a revolved profile: radius, height along the axis, and the outward normal in the (r, h) plane. */
interface ProfilePoint { r: number; h: number; nr: number; nh: number }

/**
 * Revolve profile strips about local +Y. Normals are smooth within a strip
 * and sharp between strips. A strip walked so that its normal is to the
 * right of the direction of travel in (r, h) - (dh, -dr) - faces outward,
 * the LatheGeometry convention whose winding this copies.
 */
function revolve(strips: ProfilePoint[][], segments: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const strip of strips) {
    if (strip.length < 2) continue;
    const n = strip.length;
    const start = positions.length / 3;
    for (let i = 0; i <= segments; i++) {
      const phi = (i / segments) * Math.PI * 2;
      const s = Math.sin(phi), c = Math.cos(phi);
      for (let j = 0; j < n; j++) {
        const p = strip[j];
        positions.push(p.r * s, p.h, p.r * c);
        const len = Math.hypot(p.nr, p.nh);
        normals.push((p.nr / len) * s, p.nh / len, (p.nr / len) * c);
        uvs.push(i / segments, j / (n - 1));
      }
    }
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < n - 1; j++) {
        const a = start + j + i * n;
        const b = a + n;
        const c = b + 1;
        const d = a + 1;
        indices.push(a, b, d, c, d, b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(indices);
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

/**
 * Quarter of a 2:1 ellipsoidal head of base radius R on the plane h = h0,
 * bulging toward `sign` (+1 up, -1 down), scaled by `depthRadius/2` in h. Walked
 * from the rim to the pole when `rimFirst`, else pole to rim. `outward`
 * flips the normal for an inner (concave) surface.
 */
function domeStrip(R: number, depthRadius: number, h0: number, sign: number, rimFirst: boolean, outward: boolean): ProfilePoint[] {
  const pts: ProfilePoint[] = [];
  const depth = depthRadius / 2;
  for (let k = 0; k <= DOME_STEPS; k++) {
    const t = (k / DOME_STEPS) * (Math.PI / 2);
    const cos = Math.cos(t), sin = Math.sin(t);
    // Gradient of (r/R)^2 + (h/depth)^2: (r/R^2, h/depth^2) ~ (cos/R, sin/depth)
    const nr = cos / R, nh = (sign * sin) / depth;
    pts.push({ r: R * cos, h: h0 + sign * depth * sin, nr: outward ? nr : -nr, nh: outward ? nh : -nh });
  }
  if (!rimFirst) pts.reverse();
  return pts;
}

function line(r0: number, h0: number, r1: number, h1: number, flip: boolean): ProfilePoint[] {
  // Normal to the right of travel (dh, -dr); `flip` for a segment walked the other way round
  let nr = h1 - h0, nh = -(r1 - r0);
  if (flip) { nr = -nr; nh = -nh; }
  return [{ r: r0, h: h0, nr, nh }, { r: r1, h: h1, nr, nh }];
}

function cylinderGeometry(p: CylinderPart): { geometry: THREE.BufferGeometry; open: boolean } {
  checkFinite(p.base, `cylinder ${p.id} base`);
  const R0 = p.radius;
  const R1 = p.radiusEnd ?? p.radius;
  const L = p.length;
  if (!(R0 >= 0) || !(R1 >= 0) || !(L >= 0) || !(R0 > 0 || R1 > 0)) {
    throw new Error(`View3D: cylinder ${p.id} has bad size (radius ${R0}, radiusEnd ${R1}, length ${L})`);
  }
  const capBase = p.capBase ?? 'flat';
  const capEnd = p.capEnd ?? 'flat';
  const open = capBase === 'open' || capEnd === 'open';
  const hollow = open && p.wall !== undefined && p.wall > 0;

  // Outer surface, walked base -> end (normals outward)
  const strips: ProfilePoint[][] = [];
  if (capBase === 'flat') strips.push(line(0, 0, R0, 0, false));
  else if (capBase === 'dome') strips.push(domeStrip(R0, R0, 0, -1, false, true));
  strips.push(line(R0, 0, R1, L, false));
  if (capEnd === 'flat') strips.push(line(R1, L, 0, L, false));
  else if (capEnd === 'dome') strips.push(domeStrip(R1, R1, L, 1, true, true));

  if (hollow) {
    const w = p.wall!;
    const r0 = R0 - w, r1 = R1 - w;
    if (!(r0 > 0) || !(r1 > 0)) {
      throw new Error(`View3D: cylinder ${p.id} wall ${w} m is not less than its radius (${R0}, ${R1})`);
    }
    if ((capBase === 'dome' && !(R0 > 2 * w)) || (capEnd === 'dome' && !(R1 > 2 * w))) {
      throw new Error(`View3D: cylinder ${p.id} wall ${w} m is too thick for its domed head (radius ${R0}, ${R1})`);
    }
    // Inner surface, walked end -> base (normals inward = toward the axis)
    // with a rim across each open end. A closed end of a hollow shell gets
    // an inner floor (flat) or inner head (dome) set in by the wall.
    const rAt = (h: number) => r0 + (r1 - r0) * (L > 0 ? h / L : 0);
    let hTop = L, hBottom = 0;
    if (capEnd === 'open') strips.push(line(R1, L, r1, L, false));
    else if (capEnd === 'flat') hTop = L - w;
    if (capBase === 'flat') hBottom = w;
    if (!(hTop > hBottom)) throw new Error(`View3D: cylinder ${p.id} wall ${w} m leaves no inside (length ${L})`);
    if (capEnd === 'flat') strips.push(line(0, hTop, rAt(hTop), hTop, false));
    else if (capEnd === 'dome') strips.push(domeStrip(r1, R1 - 2 * w, L, 1, false, false));
    strips.push(line(rAt(hTop), hTop, rAt(hBottom), hBottom, false));
    if (capBase === 'flat') strips.push(line(rAt(hBottom), hBottom, 0, hBottom, false));
    else if (capBase === 'dome') strips.push(domeStrip(r0, R0 - 2 * w, 0, -1, true, false));
    if (capBase === 'open') strips.push(line(r0, 0, R0, 0, false));
  }

  const g = revolve(strips, CYL_SEGMENTS);
  const axis = unitThree(p.axis, `cylinder ${p.id} axis`);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis));
  g.translate(...toThree(p.base).toArray());
  return { geometry: g, open: open && !hollow };
}

function boxGeometry(p: BoxPart): THREE.BufferGeometry {
  checkFinite(p.center, `box ${p.id} center`);
  const sx = p.size.x, sy = p.size.y, sz = p.size.z;
  if (!(sx > 0) || !(sy > 0) || !(sz > 0)) throw new Error(`View3D: box ${p.id} has bad size ${JSON.stringify(p.size)}`);
  let g: THREE.BufferGeometry;
  if (p.wall !== undefined) {
    const w = p.wall;
    const slabs = p.roof ? 2 : 1;
    if (!(w > 0) || 2 * w >= sx || 2 * w >= sy || slabs * w >= sz) {
      throw new Error(`View3D: box ${p.id} wall ${w} m does not fit its size ${JSON.stringify(p.size)}`);
    }
    // Floor slab (and roof slab), two full-length walls along x, two inset walls along y, the walls
    // standing between the slabs. Built in model (x, y, z) about the centre.
    const wallH = sz - slabs * w;
    const wallZ = p.roof ? 0 : w / 2;
    const pieces: Array<[number, number, number, number, number, number]> = [
      [0, 0, -sz / 2 + w / 2, sx, sy, w],
      [0, sy / 2 - w / 2, wallZ, sx, w, wallH],
      [0, -sy / 2 + w / 2, wallZ, sx, w, wallH],
      [sx / 2 - w / 2, 0, wallZ, w, sy - 2 * w, wallH],
      [-sx / 2 + w / 2, 0, wallZ, w, sy - 2 * w, wallH],
    ];
    if (p.roof) pieces.push([0, 0, sz / 2 - w / 2, sx, sy, w]);
    const geoms = pieces.map(([cx, cy, cz, bx, by, bz]) => {
      const b = new THREE.BoxGeometry(bx, bz, by);
      b.translate(cx, cz, -cy);
      return b;
    });
    g = merge(geoms, `box ${p.id}`);
  } else {
    g = new THREE.BoxGeometry(sx, sz, sy);
  }
  g.rotateY(p.yaw ?? 0);
  g.translate(...toThree(p.center).toArray());
  return g;
}

function tubeGeometry(p: TubePart): THREE.BufferGeometry | null {
  const r = p.radius;
  if (!(r > 0)) throw new Error(`View3D: tube ${p.id} has bad radius ${r}`);
  // Drop repeated points: a zero-length leg has no direction
  const pts: THREE.Vector3[] = [];
  for (const v of p.path) {
    checkFinite(v, `tube ${p.id} path point`);
    const t = toThree(v);
    if (pts.length === 0 || t.distanceTo(pts[pts.length - 1]) > r * 1e-6) pts.push(t);
  }
  if (pts.length < 2) return null;

  const n = pts.length;
  const dirs: THREE.Vector3[] = [];
  const lens: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    const d = pts[k + 1].clone().sub(pts[k]);
    lens.push(d.length());
    dirs.push(d.normalize());
  }
  // Elbow at each interior point: a torus arc of bend radius ELBOW_BEND_RADII * r,
  // trimmed back from the corner along both legs. Where a leg is too short to
  // give the trim (both its ends share its length) the bend is tightened, and
  // below a bend radius of one pipe radius (where the torus would fold through
  // itself) the corner is a sphere instead.
  const trimStart: number[] = new Array(n - 1).fill(0);
  const trimEnd: number[] = new Array(n - 1).fill(0);
  const pieces: THREE.BufferGeometry[] = [];
  const joints: Array<{ k: number; theta: number; tanHalf: number }> = [];
  for (let k = 1; k < n - 1; k++) {
    const a = dirs[k - 1], b = dirs[k];
    const theta = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
    joints.push({ k, theta, tanHalf: Math.tan(theta / 2) });
  }
  const bends = new Map<number, number>(); // joint index -> bend radius
  for (const j of joints) {
    if (j.theta < 1e-4) continue; // straight through: legs meet flush
    // Each leg gives at most half its length to each of its two ends
    const avail = Math.min(lens[j.k - 1], lens[j.k]) / 2;
    const want = ELBOW_BEND_RADII * r;
    const R = j.theta < Math.PI - 1e-3 ? Math.min(want, avail / j.tanHalf) : 0;
    if (R > r) {
      bends.set(j.k, R);
      trimEnd[j.k - 1] = R * j.tanHalf;
      trimStart[j.k] = R * j.tanHalf;
    } else {
      const s = new THREE.SphereGeometry(r, TUBE_SEGMENTS, Math.max(8, TUBE_SEGMENTS / 2));
      s.translate(pts[j.k].x, pts[j.k].y, pts[j.k].z);
      pieces.push(s);
    }
  }
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < n - 1; k++) {
    const L = lens[k] - trimStart[k] - trimEnd[k];
    if (!(L > 0)) continue;
    const c = new THREE.CylinderGeometry(r, r, L, TUBE_SEGMENTS, 1, k !== 0 && k !== n - 2);
    c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dirs[k]));
    const mid = pts[k].clone().addScaledVector(dirs[k], trimStart[k] + L / 2);
    c.translate(mid.x, mid.y, mid.z);
    pieces.push(c);
  }
  for (const [k, R] of bends) {
    const a = dirs[k - 1], b = dirs[k];
    const theta = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
    const t = R * Math.tan(theta / 2);
    const P = pts[k];
    const S = P.clone().addScaledVector(a, -t);
    const inward = b.clone().sub(a).normalize();
    const C = P.clone().addScaledVector(inward, R / Math.cos(theta / 2));
    // Torus local frame: arc starts at +X (radius from centre), runs toward +Y (the incoming direction)
    const X = S.clone().sub(C).normalize();
    const Y = a.clone();
    const Z = new THREE.Vector3().crossVectors(X, Y);
    const tor = new THREE.TorusGeometry(R, r, TUBE_SEGMENTS, Math.max(4, Math.ceil(theta / (Math.PI / 2) * 8)), theta);
    const m = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(C);
    tor.applyMatrix4(m);
    pieces.push(tor);
  }
  if (pieces.length === 0) return null;
  // Torus, sphere and cylinder all carry an index and position/normal/uv, so they merge
  return merge(pieces, `tube ${p.id}`);
}

function surfaceGeometry(p: SurfacePart): THREE.BufferGeometry {
  if (p.outline.length < 3) throw new Error(`View3D: surface ${p.id} outline has ${p.outline.length} points`);
  for (const v of p.outline) checkFinite(v, `surface ${p.id} outline point`);
  const z = p.outline[0].z;
  const shape = new THREE.Shape(p.outline.map(v => new THREE.Vector2(v.x, v.y)));
  const g = new THREE.ShapeGeometry(shape);
  // Shape lies in the model plan (x east, y north) with normal +z: rotate it into three's axes, then lift
  g.rotateX(-Math.PI / 2);
  g.translate(0, z, 0);
  return g;
}

function merge(geoms: THREE.BufferGeometry[], what: string): THREE.BufferGeometry {
  if (geoms.length === 1) return geoms[0];
  const merged = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose();
  if (!merged) throw new Error(`View3D: could not merge the pieces of ${what}`);
  return merged;
}

// ---------------------------------------------------------------------------
// Ground

/** Ground height (model z) at a plan point: bilinear between cell centres, held at the edges (terrainHeightAt's rule). */
function terrainHeight(spec: TerrainSpec, x: number, y: number): number {
  const fx = (x - spec.origin.x) / spec.cellSize;
  const fy = (y - spec.origin.y) / spec.cellSize;
  const ix = Math.min(spec.cols - 1, Math.max(0, fx));
  const iy = Math.min(spec.rows - 1, Math.max(0, fy));
  const i0 = Math.floor(ix), j0 = Math.floor(iy);
  const i1 = Math.min(spec.cols - 1, i0 + 1), j1 = Math.min(spec.rows - 1, j0 + 1);
  const tx = ix - i0, ty = iy - j0;
  const h = (i: number, j: number) => spec.heights[j * spec.cols + i];
  return (h(i0, j0) * (1 - tx) + h(i1, j0) * tx) * (1 - ty) + (h(i0, j1) * (1 - tx) + h(i1, j1) * tx) * ty;
}

function terrainMesh(spec: TerrainSpec, reach: number): THREE.Mesh {
  const { origin, cellSize, cols, rows, heights } = spec;
  if (heights.length !== cols * rows) {
    throw new Error(`View3D: terrain has ${heights.length} heights for ${cols} x ${rows} cells`);
  }
  // Vertices at the cell centres plus a ring carried far out at the edge heights (terrain-3d.ts's mesh)
  const lineOf = (o: number, n: number) => {
    const out = [o - reach];
    for (let k = 0; k < n; k++) out.push(o + k * cellSize);
    out.push(o + (n - 1) * cellSize + reach);
    return out;
  };
  const xs = lineOf(origin.x, cols), ys = lineOf(origin.y, rows);
  const nx = cols + 2, ny = rows + 2;
  let hMin = Infinity, hMax = -Infinity;
  for (const h of heights) { if (h < hMin) hMin = h; if (h > hMax) hMax = h; }
  const span = Math.max(1, hMax - hMin);
  const positions: number[] = [];
  const colours: number[] = [];
  const c = new THREE.Color();
  for (let j = 0; j < ny; j++) {
    const cj = Math.max(0, Math.min(rows - 1, j - 1));
    for (let i = 0; i < nx; i++) {
      const ci = Math.max(0, Math.min(cols - 1, i - 1));
      const h = heights[cj * cols + ci];
      positions.push(xs[i], h, -ys[j]);
      // terrain-3d.ts groundColour's height tint (valley green to hilltop tan) over sand; the light does the slope shading
      const t = (h - hMin) / span;
      c.setRGB(
        ((70 + 140 * t) * 0.5 + 217 * 0.5) / 255,
        ((125 + 45 * t) * 0.5 + 197 * 0.5) / 255,
        ((55 + 55 * t) * 0.5 + 144 * 0.5) / 255,
        THREE.SRGBColorSpace,
      );
      colours.push(c.r, c.g, c.b);
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const v00 = j * nx + i, v10 = v00 + 1, v01 = v00 + nx, v11 = v01 + 1;
      // Counter-clockwise seen from above in the plan: faces up
      indices.push(v00, v10, v11, v00, v11, v01);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(indices);
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  g.computeVertexNormals();
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Cut plan rectangles out of the ground (model axes): fragments over them
 * are discarded, so a pool sunk into the ground is open to the sky with
 * exactly its own outline, whatever the terrain's cell size.
 */
function installHoleShader(mat: THREE.Material, holes: Array<{ x0: number; y0: number; x1: number; y1: number }>): void {
  // In three's axes a plan rectangle is x in [x0, x1], z in [-y1, -y0]
  const rects = holes.map(h => {
    if (![h.x0, h.y0, h.x1, h.y1].every(Number.isFinite) || !(h.x1 > h.x0) || !(h.y1 > h.y0)) {
      throw new Error(`View3D: bad ground hole ${JSON.stringify(h)}`);
    }
    return new THREE.Vector4(h.x0, -h.y1, h.x1, -h.y0);
  });
  const n = rects.length;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uHoles = { value: rects };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vHolePlan;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvHolePlan = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec4 uHoles[${n}];\nvarying vec2 vHolePlan;`)
      .replace('void main() {', `void main() {\n  for (int i = 0; i < ${n}; i++) {\n    vec4 h = uHoles[i];\n    if (vHolePlan.x > h.x && vHolePlan.x < h.z && vHolePlan.y > h.y && vHolePlan.y < h.w) discard;\n  }`);
  };
  mat.customProgramCacheKey = () => `scene3d-holes-${n}`;
}

// ---------------------------------------------------------------------------

interface PartRecord {
  part: Part3D;
  meshes: THREE.Mesh[];
  materials: THREE.MeshStandardMaterial[];
  rest: THREE.Color;
  translucent: boolean;
  /** A part that shows a liquid level: the level's world height and colour (shader uniforms), and the part's height span. */
  level?: { uniforms: LevelUniforms; minY: number; maxY: number };
}

interface LevelUniforms { uLevelY: { value: number }; uLiquid: { value: THREE.Color } }

/** World height that puts the level under everything: no liquid shown. */
const NO_LEVEL = -1e30;

/**
 * Paint everything below a world-space horizontal plane in the liquid's
 * colour: the stratified level the 2.5D view draws, on any shell shape and
 * orientation, seen through a translucent shell or on an opaque one.
 */
function installLevelShader(mat: THREE.MeshStandardMaterial, u: LevelUniforms): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLevelY = u.uLevelY;
    shader.uniforms.uLiquid = u.uLiquid;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLevelWorldY;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvLevelWorldY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uLevelY;\nuniform vec3 uLiquid;\nvarying float vLevelWorldY;')
      .replace('#include <color_fragment>', '#include <color_fragment>\nif (vLevelWorldY < uLevelY) diffuseColor.rgb = uLiquid;');
  };
  mat.customProgramCacheKey = () => 'scene3d-level';
}

export class View3D {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sky: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();

  /** Everything built from the current model (parts and ground); replaced wholesale by setModel. */
  private modelGroup = new THREE.Group();
  private parts = new Map<string, PartRecord>();
  private pickables: THREE.Mesh[] = [];
  private model: Scene3DModel | null = null;
  private groundAt: (x: number, y: number) => number = () => 0;
  /** Plant radius and how far out the ground runs, for the camera's far plane. */
  private radius = 1;
  private reach = GROUND_MIN_REACH;

  private insets = { left: 0, top: 0, right: 0, bottom: 0 };
  private lastColors: Map<string, PartColor> | null = null;
  private highlighted = new Set<string>();
  private highlightLines: THREE.LineSegments[] = [];
  private readonly highlightLineMaterial = new THREE.LineBasicMaterial({ color: HIGHLIGHT_EDGE });
  private visible = true;
  private disposed = false;
  private readonly scratch = new THREE.Color();
  private readonly scratchEmissive = new THREE.Color();
  /** Arrow keys held down (pan while held), and the time of the last render for the pan's step. */
  private readonly keysHeld = new Set<string>();
  private lastRenderTime: number | null = null;
  private readonly onKeyDown = (e: KeyboardEvent) => this.keyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent) => { this.keysHeld.delete(e.key); };
  private readonly onBlur = () => { this.keysHeld.clear(); };

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', display: 'block', touchAction: 'none',
    });
    const probe = this.canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
    if (!probe) {
      throw new Error('3D view: this browser could not create a WebGL2 context (WebGL disabled, unsupported, or the GPU is blocklisted).');
    }
    container.appendChild(this.canvas);
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, context: probe, antialias: true, logarithmicDepthBuffer: true,
      });
    } catch (e) {
      this.canvas.remove();
      throw new Error(`3D view: could not start WebGL: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // r187: PCFSoftShadowMap is gone; PCF is filtered (soft) already
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = false; // pan along the ground
    this.controls.minDistance = MIN_ORBIT_DISTANCE;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02; // never look up from below the target
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    this.hemi = new THREE.HemisphereLight(SKY_HORIZON, '#b9a570', 1.6);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff6e8', 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Sky: a gradient sphere that follows the eye, horizon colour to zenith colour
    const skyGeo = new THREE.SphereGeometry(1, 32, 16);
    const top = new THREE.Color(SKY_TOP), horizon = new THREE.Color(SKY_HORIZON);
    const skyCol: number[] = [];
    const pos = skyGeo.getAttribute('position');
    for (let k = 0; k < pos.count; k++) {
      const y = pos.getY(k);
      const t = Math.pow(Math.max(0, y), 0.6);
      const col = horizon.clone().lerp(top, t);
      skyCol.push(col.r, col.g, col.b);
    }
    skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(skyCol, 3));
    this.sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
    }));
    this.sky.renderOrder = -1e9;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.scene.background = new THREE.Color(SKY_HORIZON);
    this.scene.fog = new THREE.Fog(SKY_HORIZON, 100, 1000);
    this.scene.add(this.modelGroup);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    this.resize();
  }

  setModel(model: Scene3DModel): void {
    this.assertLive();
    const first = this.model === null;
    // Build the new scene completely before dropping the old one, so a bad model leaves the old picture standing
    const group = new THREE.Group();
    const parts = new Map<string, PartRecord>();
    const pickables: THREE.Mesh[] = [];
    try {
      for (const part of model.parts) {
        if (parts.has(part.id)) throw new Error(`View3D: duplicate part id "${part.id}"`);
        const rec = this.buildPart(part);
        if (!rec) continue;
        parts.set(part.id, rec);
        for (const m of rec.meshes) { group.add(m); pickables.push(m); }
      }
      this.buildGround(model.ground, model, group);
    } catch (e) {
      disposeObject(group);
      throw e;
    }

    this.clearHighlightLines();
    this.scene.remove(this.modelGroup);
    disposeObject(this.modelGroup);
    this.modelGroup = group;
    this.parts = parts;
    this.pickables = pickables;
    this.model = model;
    this.scene.add(group);

    this.fitLightsAndHaze();
    // Keep the selection where its parts still exist
    if (this.highlighted.size > 0) this.rebuildHighlightLines();
    this.applyColors();
    if (first) this.frameAll();
  }

  setColors(colors: Map<string, PartColor>): void {
    this.lastColors = colors;
    this.applyColors();
  }

  setHighlight(target: { componentId?: string; connectionKey?: string } | null): void {
    this.highlighted.clear();
    if (target && (target.componentId !== undefined || target.connectionKey !== undefined)) {
      for (const [id, rec] of this.parts) {
        const p = rec.part;
        if ((target.componentId !== undefined && p.componentId === target.componentId)
          || (target.connectionKey !== undefined && p.connectionKey === target.connectionKey)) {
          this.highlighted.add(id);
        }
      }
    }
    this.rebuildHighlightLines();
    this.applyColors();
  }

  /**
   * Look at the whole model from the default direction, from just far
   * enough that every corner of its bounding box is inside the part of the
   * view the insets leave open.
   */
  frameAll(): void {
    if (!this.model) return;
    const { center, corners } = this.framingBox(this.model);
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const ins = this.usableInsets(w, h);
    const tanHalf = Math.tan((this.camera.fov * Math.PI) / 360);
    const tanV = tanHalf * (h > 0 ? (h - ins.top - ins.bottom) / h : 1);
    const tanH = tanHalf * this.camera.aspect * (w > 0 ? (w - ins.left - ins.right) / w : 1);
    const dir = unitThree(VIEW_FROM_MODEL, 'view direction');
    const forward = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward);
    let dist = MIN_ORBIT_DISTANCE * 4;
    for (const p of corners) {
      const q = p.clone().sub(center);
      const along = q.dot(dir);
      dist = Math.max(dist, along + Math.abs(q.dot(right)) / tanH, along + Math.abs(q.dot(up)) / tanV);
    }
    dist *= FRAME_MARGIN;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.maxDistance = Math.max(dist * 4, this.radius * 10);
    this.keepAboveGround();
    this.controls.update();
  }

  /**
   * Screen edges (px) covered by the page's own panels. The picture is
   * centred in what they leave open (a shifted projection, so orbiting and
   * picking stay consistent), and frameAll fits the plant into it.
   */
  setInsets(insets: { left?: number; top?: number; right?: number; bottom?: number }): void {
    this.insets = { left: insets.left ?? 0, top: insets.top ?? 0, right: insets.right ?? 0, bottom: insets.bottom ?? 0 };
    for (const v of Object.values(this.insets)) {
      if (!(v >= 0) || !Number.isFinite(v)) throw new Error(`View3D: bad inset ${JSON.stringify(insets)}`);
    }
    this.resize();
  }

  resize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    if (w > 0 && h > 0) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      const ins = this.usableInsets(w, h);
      if (ins.left || ins.right || ins.top || ins.bottom) {
        this.camera.setViewOffset(w, h, (ins.right - ins.left) / 2, (ins.bottom - ins.top) / 2, w, h);
      } else {
        this.camera.clearViewOffset();
      }
      this.camera.updateProjectionMatrix();
    }
  }

  /** The insets, or none when they would leave no view at all (a tiny window). */
  private usableInsets(w: number, h: number): { left: number; top: number; right: number; bottom: number } {
    const i = this.insets;
    return i.left + i.right < w / 2 && i.top + i.bottom < h / 2 ? i : { left: 0, top: 0, right: 0, bottom: 0 };
  }

  render(): void {
    if (!this.visible || this.disposed) return;
    this.applyKeyPan();
    this.controls.update();
    this.keepAboveGround();
    // Near/far from how far the eye is from what it looks at; the log depth buffer keeps the range usable
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = dist * 1e-3;
    this.camera.far = this.reach * 1.5 + dist * 2;
    this.camera.updateProjectionMatrix();
    this.sky.position.copy(this.camera.position);
    this.sky.scale.setScalar(this.camera.far * 0.9);
    this.renderer.render(this.scene, this.camera);
  }

  pick(point: { x: number; y: number }): Pick3D | null {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!(w > 0 && h > 0) || this.pickables.length === 0) return null;
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2((point.x / w) * 2 - 1, -(point.y / h) * 2 + 1), this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    if (hits.length === 0) return null;
    const rec = this.chooseHit(hits, Infinity, new Set());
    if (!rec) return null;
    const out: Pick3D = { partId: rec.part.id };
    if (rec.part.componentId !== undefined) out.componentId = rec.part.componentId;
    if (rec.part.connectionKey !== undefined) out.connectionKey = rec.part.connectionKey;
    return out;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.canvas.style.display = visible ? 'block' : 'none';
    this.controls.enabled = visible;
    if (!visible) this.keysHeld.clear();
    this.lastRenderTime = null;
  }

  /** Move the eye toward (factor > 1) or away from (factor < 1) the orbit target. */
  zoomBy(factor: number): void {
    if (!(factor > 0) || !Number.isFinite(factor)) throw new Error(`View3D: zoom factor ${factor}`);
    const t = this.controls.target;
    const offset = this.camera.position.clone().sub(t).divideScalar(factor);
    const len = offset.length();
    const lo = this.controls.minDistance, hi = this.controls.maxDistance;
    if (len < lo) offset.setLength(lo);
    else if (len > hi) offset.setLength(hi);
    this.camera.position.copy(t).add(offset);
    this.keepAboveGround();
    this.controls.update();
  }

  /** Eye and orbit target, model axes (x east, y north, z up). */
  getCamera(): { eye: Vec3; target: Vec3 } {
    const fromThree = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: -v.z, z: v.y });
    return { eye: fromThree(this.camera.position), target: fromThree(this.controls.target) };
  }

  /** Put the eye at `eye` looking at `target`, model axes. */
  setCamera(eye: Vec3, target: Vec3): void {
    checkFinite(eye, 'camera eye');
    checkFinite(target, 'camera target');
    this.camera.position.copy(toThree(eye));
    this.controls.target.copy(toThree(target));
    this.keepAboveGround();
    this.controls.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.keysHeld.clear();
    this.controls.dispose();
    this.clearHighlightLines();
    this.highlightLineMaterial.dispose();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.parts.clear();
    this.pickables = [];
    this.model = null;
  }

  // -------------------------------------------------------------------------

  private assertLive(): void {
    if (this.disposed) throw new Error('View3D: used after dispose()');
  }

  private buildPart(part: Part3D): PartRecord | null {
    let geometry: THREE.BufferGeometry | null;
    let open = false;
    switch (part.shape) {
      case 'cylinder': {
        const r = cylinderGeometry(part);
        geometry = r.geometry;
        open = r.open;
        break;
      }
      case 'box': geometry = boxGeometry(part); break;
      case 'tube': geometry = tubeGeometry(part); break;
      case 'surface': geometry = surfaceGeometry(part); open = true; break;
      default:
        throw new Error(`View3D: unknown part shape "${(part as { shape: unknown }).shape}" (part ${(part as { id: unknown }).id})`);
    }
    if (!geometry) return null; // a tube with no length: nothing to draw
    const look = MATERIAL_LOOKS[part.material];
    if (!look) throw new Error(`View3D: unknown material "${part.material}" (part ${part.id})`);
    const rest = new THREE.Color(look.color);
    const opacity = part.opacity ?? 1;
    if (!(opacity > 0 && opacity <= 1)) throw new Error(`View3D: part ${part.id} has opacity ${opacity}`);
    const translucent = opacity < 1;
    let level: PartRecord['level'];
    if (part.showsLevel) {
      geometry.computeBoundingBox();
      const bb = geometry.boundingBox!;
      level = {
        uniforms: { uLevelY: { value: NO_LEVEL }, uLiquid: { value: new THREE.Color() } },
        minY: bb.min.y, maxY: bb.max.y,
      };
    }
    const makeMat = (side: THREE.Side) => {
      const m = new THREE.MeshStandardMaterial({
        color: rest, roughness: look.roughness, metalness: look.metalness, side,
        transparent: translucent, opacity, depthWrite: !translucent,
      });
      if (level) installLevelShader(m, level.uniforms);
      return m;
    };
    const meshes: THREE.Mesh[] = [];
    const materials: THREE.MeshStandardMaterial[] = [];
    if (translucent) {
      // Back faces before everything smaller, front faces after it (see the file comment)
      geometry.computeBoundingSphere();
      const size = geometry.boundingSphere!.radius;
      for (const [side, order] of [[THREE.BackSide, -size], [THREE.FrontSide, size]] as const) {
        const mat = makeMat(side);
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.renderOrder = order;
        mesh.castShadow = false; // a see-through shell must not darken what it holds
        mesh.receiveShadow = true;
        mesh.userData.partId = part.id;
        meshes.push(mesh);
        materials.push(mat);
      }
    } else {
      const mat = makeMat(open ? THREE.DoubleSide : THREE.FrontSide);
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.castShadow = part.material !== 'water';
      mesh.receiveShadow = true;
      mesh.userData.partId = part.id;
      meshes.push(mesh);
      materials.push(mat);
    }
    return { part, meshes, materials, rest, translucent, level };
  }

  private buildGround(ground: Ground3D, model: Scene3DModel, group: THREE.Group): void {
    const sphere = this.framingSphere(model);
    this.radius = sphere.radius;
    this.reach = Math.max(GROUND_MIN_REACH, GROUND_REACH_RADII * sphere.radius);
    let mesh: THREE.Mesh;
    if (ground.terrain) {
      const spec = ground.terrain;
      mesh = terrainMesh(spec, this.reach);
      group.add(mesh);
      this.groundAt = (x, y) => terrainHeight(spec, x, y);
    } else if (ground.flat) {
      const f = ground.flat;
      const cx = (f.x0 + f.x1) / 2, cy = (f.y0 + f.y1) / 2;
      const span = Math.max(Math.abs(f.x1 - f.x0), Math.abs(f.y1 - f.y0)) + 2 * this.reach;
      const g = new THREE.PlaneGeometry(span, span);
      g.rotateX(-Math.PI / 2);
      g.translate(cx, f.z, -cy);
      mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: SAND }));
      mesh.receiveShadow = true;
      group.add(mesh);
      const z = f.z;
      this.groundAt = () => z;
    } else {
      throw new Error('View3D: model.ground has neither terrain nor flat');
    }
    if (ground.holes && ground.holes.length > 0) installHoleShader(mesh.material as THREE.Material, ground.holes);
  }

  /** The box the camera frames (three axes): its centre and eight corners. */
  private framingBox(model: Scene3DModel): { center: THREE.Vector3; corners: THREE.Vector3[] } {
    const { min, max } = this.framingBounds(model);
    const corners: THREE.Vector3[] = [];
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) corners.push(toThree({ x, y, z }));
    return { center: toThree(min).add(toThree(max)).multiplyScalar(0.5), corners };
  }

  /** The sphere round the framed box (lights, haze, far plane). */
  private framingSphere(model: Scene3DModel): { center: THREE.Vector3; radius: number } {
    const { min, max } = this.framingBounds(model);
    const a = toThree(min), b = toThree(max);
    const center = a.clone().add(b).multiplyScalar(0.5);
    // A model of one point still needs a size to frame
    const radius = Math.max(a.distanceTo(b) / 2, MIN_ORBIT_DISTANCE * 4);
    return { center, radius };
  }

  /** What the camera frames: the model's bounds, or with no parts, the ground's extent (model axes). */
  private framingBounds(model: Scene3DModel): { min: Vec3; max: Vec3 } {
    let min = model.bounds.min, max = model.bounds.max;
    const finite = [min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite) && model.parts.length > 0;
    if (!finite) {
      const g = model.ground;
      if (g.flat) {
        min = { x: g.flat.x0, y: g.flat.y0, z: g.flat.z };
        max = { x: g.flat.x1, y: g.flat.y1, z: g.flat.z };
      } else if (g.terrain) {
        const t = g.terrain;
        const hs = t.heights;
        let lo = Infinity, hi = -Infinity;
        for (const h of hs) { if (h < lo) lo = h; if (h > hi) hi = h; }
        min = { x: t.origin.x, y: t.origin.y, z: lo };
        max = { x: t.origin.x + (t.cols - 1) * t.cellSize, y: t.origin.y + (t.rows - 1) * t.cellSize, z: hi };
      } else {
        throw new Error('View3D: model has no finite bounds and no ground to frame');
      }
    }
    return { min, max };
  }

  private fitLightsAndHaze(): void {
    if (!this.model) return;
    const { center, radius } = this.framingSphere(this.model);
    const toSun = unitThree(TO_SUN_MODEL, 'sun direction');
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(toSun, radius * 2);
    const cam = this.sun.shadow.camera;
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
    cam.near = radius * 0.5;
    cam.far = radius * 3.5;
    cam.updateProjectionMatrix();
    const texel = (2 * radius) / SHADOW_MAP_SIZE;
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = texel * 1.5;
    this.sun.shadow.radius = 3;
    this.sun.shadow.needsUpdate = true;
    const hazeR = Math.max(radius, HAZE_MIN_RADIUS);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = hazeR * HAZE_NEAR_RADII;
    fog.far = hazeR * HAZE_FAR_RADII;
  }

  private applyColors(): void {
    const colors = this.lastColors;
    for (const [id, rec] of this.parts) {
      const c = colors?.get(id);
      const col = this.scratch, em = this.scratchEmissive;
      if (c) {
        col.setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace);
        em.copy(col).multiplyScalar(c.glow);
      } else {
        col.copy(rec.rest);
        em.setRGB(0, 0, 0);
      }
      if (this.highlighted.has(id)) em.add(HIGHLIGHT_TINT);
      for (const m of rec.materials) {
        m.color.copy(col);
        m.emissive.copy(em);
      }
      if (rec.part.shape === 'surface') {
        // A pool's or a sea's water standing at its live height
        const z = c?.surfaceZ;
        if (z !== undefined && !Number.isFinite(z)) throw new Error(`View3D: part ${id} surface height ${z}`);
        const lift = z === undefined ? 0 : z - rec.part.outline[0].z;
        for (const m of rec.meshes) m.position.y = lift;
      }
      if (rec.level) {
        const liq = c?.liquid;
        const u = rec.level.uniforms;
        if (liq) {
          if (!(liq.fraction >= 0 && liq.fraction <= 1)) throw new Error(`View3D: part ${id} liquid fraction ${liq.fraction}`);
          u.uLevelY.value = rec.level.minY + liq.fraction * (rec.level.maxY - rec.level.minY);
          u.uLiquid.value.setRGB(liq.r, liq.g, liq.b, THREE.SRGBColorSpace);
        } else {
          u.uLevelY.value = NO_LEVEL;
        }
      }
    }
  }

  private clearHighlightLines(): void {
    for (const l of this.highlightLines) {
      l.parent?.remove(l);
      l.geometry.dispose();
    }
    this.highlightLines = [];
  }

  private rebuildHighlightLines(): void {
    this.clearHighlightLines();
    for (const id of this.highlighted) {
      const rec = this.parts.get(id);
      if (!rec) { this.highlighted.delete(id); continue; }
      const edges = new THREE.EdgesGeometry(rec.meshes[0].geometry, 25);
      const lines = new THREE.LineSegments(edges, this.highlightLineMaterial);
      lines.renderOrder = 1e9;
      lines.userData.highlight = true;
      this.modelGroup.add(lines);
      this.highlightLines.push(lines);
    }
  }

  /**
   * Nearest part along the ray, except that a translucent shell does not hide
   * what it holds: a hit on anything else before the ray leaves the shell
   * (its last hit) wins, nested shells resolved the same way.
   */
  private chooseHit(hits: THREE.Intersection[], before: number, skip: Set<string>): PartRecord | null {
    for (const hit of hits) {
      if (hit.distance >= before) break;
      const id = hit.object.userData.partId as string;
      if (skip.has(id)) continue;
      const rec = this.parts.get(id);
      if (!rec) continue;
      if (!rec.translucent) return rec;
      let exit = hit.distance;
      for (const h of hits) if (h.object.userData.partId === id && h.distance > exit) exit = h.distance;
      skip.add(id);
      return this.chooseHit(hits, Math.min(exit, before), skip) ?? rec;
    }
    return null;
  }

  private keyDown(e: KeyboardEvent): void {
    if (!(e.key in KEY_PAN_DIRS) || !this.visible || this.disposed) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.keysBlocked(e)) return;
    this.keysHeld.add(e.key);
    e.preventDefault();   // no page scroll
  }

  /**
   * Arrow keys belong to whatever has them otherwise: a text field or other
   * form control with focus, or anything standing over the middle of the
   * view (a modal dialog and its backdrop).
   */
  private keysBlocked(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return true;
    const r = this.canvas.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return true;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    // An overlay that lets the pointer through (pointer-events: none, as the app's 2D legend canvas) is
    // never returned by elementFromPoint, so it does not count
    return top !== null && top !== this.canvas && !this.container.contains(top);
  }

  /** Pan the orbit target (and the eye with it) along the ground while arrow keys are held. */
  private applyKeyPan(): void {
    const now = performance.now();
    const dt = this.lastRenderTime === null ? 0 : Math.min(KEY_PAN_MAX_DT, (now - this.lastRenderTime) / 1000);
    this.lastRenderTime = now;
    if (this.keysHeld.size === 0 || dt === 0) return;
    let sx = 0, sy = 0;
    for (const k of this.keysHeld) { sx += KEY_PAN_DIRS[k].x; sy += KEY_PAN_DIRS[k].y; }
    const n = Math.hypot(sx, sy);
    if (n === 0) return;   // opposite keys cancel
    // Away from the camera along the ground; looking straight down, the screen's up instead
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) {
      forward.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      forward.y = 0;
    }
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    const dist = this.camera.position.distanceTo(this.controls.target);
    const step = KEY_PAN_RATE * dist * dt / n;
    const move = forward.multiplyScalar(sy * step).addScaledVector(right, sx * step);
    this.controls.target.add(move);
    this.camera.position.add(move);
  }

  /** Keep the orbit target on or above the ground, and the eye above the ground under it. */
  private keepAboveGround(): void {
    const t = this.controls.target;
    const gt = this.groundAt(t.x, -t.z);
    if (t.y < gt) t.y = gt;
    const c = this.camera.position;
    const gc = this.groundAt(c.x, -c.z) + EYE_CLEARANCE;
    if (c.y < gc) c.y = gc;
  }
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse(obj => {
    const m = obj as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(x => x.dispose());
    else if (mat && !(obj as THREE.LineSegments).userData.highlight) mat.dispose();
  });
}
