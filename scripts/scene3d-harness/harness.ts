/**
 * Dev harness for the 3D view: mounts View3D on hand-made fixture models that
 * exercise every part shape and option, and exposes `window.harness` so a
 * puppeteer script can move the camera, pick, highlight, recolour, swap the
 * model and dispose. Serve with Vite and open
 * /scripts/scene3d-harness/index.html.
 */
import { View3D } from '../../src/render/scene3d/view3d';
import type { Part3D, PartColor, Scene3DModel, Vec3 } from '../../src/render/scene3d/types';
import type { TerrainSpec } from '../../src/terrain-types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const UP = v(0, 0, 1);

function boundsOf(parts: Part3D[]): Scene3DModel['bounds'] {
  const min = v(Infinity, Infinity, Infinity), max = v(-Infinity, -Infinity, -Infinity);
  const add = (p: Vec3, r = 0) => {
    min.x = Math.min(min.x, p.x - r); min.y = Math.min(min.y, p.y - r); min.z = Math.min(min.z, p.z - r);
    max.x = Math.max(max.x, p.x + r); max.y = Math.max(max.y, p.y + r); max.z = Math.max(max.z, p.z + r);
  };
  for (const p of parts) {
    switch (p.shape) {
      case 'cylinder': {
        const r = Math.max(p.radius, p.radiusEnd ?? p.radius);
        const end = v(p.base.x + p.axis.x * p.length, p.base.y + p.axis.y * p.length, p.base.z + p.axis.z * p.length);
        add(p.base, r * 1.5); add(end, r * 1.5);
        break;
      }
      case 'box': add(p.center, Math.hypot(p.size.x, p.size.y, p.size.z) / 2); break;
      case 'tube': for (const q of p.path) add(q, p.radius); break;
      case 'surface': for (const q of p.outline) add(q); break;
    }
  }
  return { min, max };
}

function terrain(): TerrainSpec {
  const cols = 50, rows = 40, cellSize = 4;
  const origin = { x: -100, y: -80 };
  const heights: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = origin.x + i * cellSize, y = origin.y + j * cellSize;
      // A bench at 0 for the plant, a hill to the north-west, the sea floor dropping away to the south-east
      const hill = 16 * Math.exp(-(((x + 60) ** 2) + ((y - 55) ** 2)) / 900);
      const sea = -8 / (1 + Math.exp(-(x - y - 120) / 10));
      const bench = Math.hypot(x, y) < 50 ? 0 : 1;
      heights.push(bench * (hill + sea) + 0.6 * Math.sin(x * 0.11) * Math.cos(y * 0.07) * bench);
    }
  }
  return { origin, cellSize, cols, rows, heights, waters: [{ id: 'sea', seed: { x: 90, y: -75 }, surface: -2 }] };
}

function fixtureA(): Scene3DModel {
  const parts: Part3D[] = [
    // Containment building: open-bottomed concrete shell with a domed roof, see-through, with a wall
    { id: 'cont', shape: 'cylinder', componentId: 'containment', material: 'concrete', opacity: 0.25,
      base: v(0, 0, 0), axis: UP, length: 22, radius: 14, capBase: 'open', capEnd: 'dome', wall: 0.8 },
    // Reactor vessel inside it: vertical, both heads domed, see-through
    { id: 'rpv', shape: 'cylinder', componentId: 'rpv', material: 'steel', opacity: 0.35,
      base: v(0, 0, 3), axis: UP, length: 10, radius: 2.5, capBase: 'dome', capEnd: 'dome', color: { kind: 'flowNode', nodeId: 'rpv' } },
    // Core inside the vessel
    { id: 'core', shape: 'cylinder', componentId: 'rpv', material: 'fuel',
      base: v(0, 0, 4), axis: UP, length: 4, radius: 1.6, color: { kind: 'fuel', componentId: 'rpv' } },
    // Steam generator inside containment: frustum with domed top
    { id: 'sg', shape: 'cylinder', componentId: 'sg', material: 'steel',
      base: v(8, 3, 1), axis: UP, length: 12, radius: 1.6, radiusEnd: 2.3, capBase: 'dome', capEnd: 'dome' },
    // Horizontal tank, domed both ends
    { id: 'tank', shape: 'cylinder', componentId: 'tank', material: 'steel',
      base: v(22, -10, 2.5), axis: v(1, 0, 0), length: 12, radius: 2, capBase: 'dome', capEnd: 'dome' },
    // Tilted cone (frustum, flat caps), arbitrary axis
    { id: 'cone', shape: 'cylinder', componentId: 'cone', material: 'machinery',
      base: v(30, 12, 0), axis: v(0.3, 0.2, 0.93), length: 8, radius: 3, radiusEnd: 1.2 },
    // Open pipe stub without a wall (a bare sheet, double-sided)
    { id: 'stub', shape: 'cylinder', componentId: 'stub', material: 'steel',
      base: v(22, 4, 1), axis: v(0, 1, 0), length: 4, radius: 0.8, capBase: 'open', capEnd: 'open' },
    // Open-topped tank with a wall and a flat floor
    { id: 'cup', shape: 'cylinder', componentId: 'cup', material: 'steel',
      base: v(-20, -20, 0), axis: UP, length: 5, radius: 3, capBase: 'flat', capEnd: 'open', wall: 0.3 },
    // Pool: walls-only concrete box with a water surface
    { id: 'pool', shape: 'box', componentId: 'pool', material: 'concrete',
      center: v(-30, 15, 3), size: v(16, 10, 6), wall: 0.6 },
    { id: 'pool-water', shape: 'surface', componentId: 'pool', material: 'water', color: { kind: 'flowNode', nodeId: 'pool' },
      outline: [v(-37.4, 10.6, 4.8), v(-22.6, 10.6, 4.8), v(-22.6, 19.4, 4.8), v(-37.4, 19.4, 4.8)] },
    // Yawed transformer box and a scaffold box
    { id: 'xfmr', shape: 'box', componentId: 'xfmr', material: 'electrical',
      center: v(35, -25, 2), size: v(8, 4, 4), yaw: 0.6 },
    { id: 'pad', shape: 'box', componentId: 'tank', material: 'concrete',
      center: v(28, -10, 0.25), size: v(16, 6, 0.5) },
    { id: 'scaffold', shape: 'box', componentId: 'sg', material: 'structure',
      center: v(8, 3, 0.5), size: v(5, 5, 1) },
    // Pipe run: multi-bend with vertical legs and a duplicated point, through the containment wall to the tank
    { id: 'pipe1', shape: 'tube', connectionKey: 'rpv:out>tank:in', material: 'steel', radius: 0.4,
      color: { kind: 'connection', connectionId: 'c1' },
      path: [v(2.5, 0, 9), v(5, 0, 9), v(5, 0, 9), v(5, 0, 16), v(5, -10, 16), v(18, -10, 16), v(18, -10, 2.5), v(20, -10, 2.5)] },
    // A run with an oblique bend and short legs (falls back to ball joints)
    { id: 'pipe2', shape: 'tube', connectionKey: 'tank:out>xfmr:in', material: 'steel', radius: 0.3,
      path: [v(34, -10, 2.5), v(38, -14, 2.5), v(38, -14, 3), v(38.4, -14, 3), v(40, -20, 6)] },
    // A degenerate run (all points coincide): must draw nothing, not NaN
    { id: 'pipe0', shape: 'tube', connectionKey: 'x:a>y:b', material: 'steel', radius: 0.3, path: [v(1, 1, 1), v(1, 1, 1)] },
    // Sea surface over the terrain's low ground
    { id: 'sea', shape: 'surface', material: 'water',
      outline: [v(30, -500, -2), v(600, -500, -2), v(600, 100, -2), v(30, 100, -2)] },
  ];
  const bounds = boundsOf(parts.filter(p => p.id !== 'sea'));
  return { parts, ground: { terrain: terrain() }, bounds };
}

function fixtureB(): Scene3DModel {
  const parts: Part3D[] = [
    { id: 'b-vessel', shape: 'cylinder', componentId: 'b1', material: 'steel', base: v(0, 0, 0), axis: UP, length: 6, radius: 1.5, capEnd: 'dome' },
    { id: 'b-pump', shape: 'cylinder', componentId: 'b2', material: 'machinery', base: v(6, 0, 0), axis: UP, length: 1.2, radius: 0.6 },
    { id: 'b-pipe', shape: 'tube', connectionKey: 'b1:o>b2:i', material: 'steel', radius: 0.2, path: [v(1.5, 0, 0.5), v(6, 0, 0.5)] },
    { id: 'b-valve', shape: 'box', componentId: 'b3', material: 'steel', center: v(3.5, 0, 0.5), size: v(0.3, 0.6, 0.6) },
  ];
  return { parts, ground: { flat: { z: 0, x0: -10, y0: -10, x1: 10, y1: 10 } }, bounds: boundsOf(parts) };
}

const container = document.getElementById('view')!;
const info = document.getElementById('info')!;
const errors: string[] = [];
window.addEventListener('error', e => errors.push(String(e.message)));

const view = new View3D(container);
let model = fixtureA();
view.setModel(model);

let colors = new Map<string, PartColor>();
let running = true;
function loop() {
  if (!running) return;
  view.setColors(colors);
  view.render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
window.addEventListener('resize', () => view.resize());

container.addEventListener('click', e => {
  const r = container.getBoundingClientRect();
  const hit = view.pick({ x: e.clientX - r.left, y: e.clientY - r.top });
  info.textContent = hit ? JSON.stringify(hit) : 'nothing';
  view.setHighlight(hit ? { componentId: hit.componentId, connectionKey: hit.connectionKey } : null);
});

type Internals = { camera: { position: { set(x: number, y: number, z: number): void } }; controls: { target: { set(x: number, y: number, z: number): void }; update(): void } };

const harness = {
  errors,
  /** Put the eye at `from` looking at `to`, both in model axes (x east, y north, z up). */
  setCam(from: Vec3, to: Vec3) {
    const i = view as unknown as Internals;
    i.camera.position.set(from.x, from.z, -from.y);
    i.controls.target.set(to.x, to.z, -to.y);
    i.controls.update();
  },
  frameAll: () => view.frameAll(),
  pick: (x: number, y: number) => view.pick({ x, y }),
  highlight: (t: { componentId?: string; connectionKey?: string } | null) => view.setHighlight(t),
  hot() {
    colors = new Map([
      ['core', { r: 1, g: 0.55, b: 0.15, glow: 0.9 }],
      ['rpv', { r: 0.35, g: 0.6, b: 0.95, glow: 0 }],
      ['pipe1', { r: 0.95, g: 0.3, b: 0.25, glow: 0 }],
      ['pool-water', { r: 0.2, g: 0.75, b: 0.8, glow: 0 }],
      ['tank', { r: 0.9, g: 0.85, b: 0.2, glow: 0.3 }],
    ]);
  },
  rest() { colors = new Map(); },
  modelB() { model = fixtureB(); view.setModel(model); },
  modelA() { model = fixtureA(); view.setModel(model); },
  hide: () => view.setVisible(false),
  show: () => view.setVisible(true),
  dispose() { running = false; view.dispose(); return container.querySelectorAll('canvas').length; },
  badShape() {
    try {
      view.setModel({ ...model, parts: [{ id: 'q', shape: 'pyramid', material: 'steel' } as unknown as Part3D] });
      return 'no error';
    } catch (e) { return String(e); }
  },
};
(window as unknown as { harness: typeof harness }).harness = harness;
