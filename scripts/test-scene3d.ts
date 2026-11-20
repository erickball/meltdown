/**
 * The 3D view's scene model (src/render/scene3d/scene-model.ts) and its live
 * colours (scene-colors.ts), checked headlessly on the shipped presets and
 * the spent-fuel-pool level (terrain, a sunken pool, a sea that is a tank).
 *
 *  - every drawn component yields parts; every number is finite; cylinder
 *    axes are unit vectors; every size is positive; part ids are unique
 *  - every connection the 2.5D view lays as a routed run (a grid plan route,
 *    or a duct's inner pipe carried on inside the vessel it is welded to)
 *    is a tube whose two ends stand on the surfaces of the components it
 *    joins (a probe a few cm either side of the end is inside / outside)
 *  - the bounds hold every part
 *  - sceneSignature is stable, and changes when a component moves
 *  - with a simulation built from the plant, every part with a colour
 *    source gets a colour, in range
 *
 * Run: npx tsx scripts/test-scene3d.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { deserializePlantDesign } from '../src/simulation/serialization';
import { createSimulationFromPlant } from '../src/simulation';
import { GridView } from '../src/render/grid-view';
import { crossVesselJoint } from '../src/render/grid-geometry';
import { terrainHeightAt } from '../src/simulation/terrain';
import { buildScene3D, sceneSignature, connectionKey, perpendiculars } from '../src/render/scene3d/scene-model';
import { partColors } from '../src/render/scene3d/scene-colors';
import type { Part3D, Vec3, Scene3DModel } from '../src/render/scene3d/types';
import type { Connection, PlantComponent, PlantState } from '../src/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}
const fmt = (p: Vec3) => `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`;

// ---------------------------------------------------------------------------
// Geometry the test checks against, written independently of the model's
// ray casting: is a point inside a part (taken as solid)?
// ---------------------------------------------------------------------------

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

function inside(part: Part3D, p: Vec3): boolean {
  switch (part.shape) {
    case 'cylinder': {
      const [e1, e2] = perpendiculars(part.axis);
      const q = sub(p, part.base);
      const s = dot(q, part.axis);
      const rr = Math.hypot(dot(q, e1), dot(q, e2));
      const r0 = part.radius, r1 = part.radiusEnd ?? part.radius;
      if (s >= 0 && s <= part.length) return rr <= r0 + (r1 - r0) * s / part.length;
      if (s < 0 && part.capBase === 'dome') return (rr / r0) ** 2 + (s / (r0 / 2)) ** 2 <= 1;
      if (s > part.length && part.capEnd === 'dome') return (rr / r1) ** 2 + ((s - part.length) / (r1 / 2)) ** 2 <= 1;
      return false;
    }
    case 'box': {
      const yaw = part.yaw ?? 0;
      const dx = p.x - part.center.x, dy = p.y - part.center.y;
      const lx = Math.cos(-yaw) * dx - Math.sin(-yaw) * dy;
      const ly = Math.sin(-yaw) * dx + Math.cos(-yaw) * dy;
      return Math.abs(lx) <= part.size.x / 2 && Math.abs(ly) <= part.size.y / 2 && Math.abs(p.z - part.center.z) <= part.size.z / 2;
    }
    case 'tube': {
      // Inside a straight leg's cylinder (not the round end beyond a leg's end)
      for (let i = 1; i < part.path.length; i++) {
        const a = part.path[i - 1], b = part.path[i];
        const ab = sub(b, a);
        const L2 = dot(ab, ab);
        const t = dot(sub(p, a), ab) / L2;
        if (t < 0 || t > 1) continue;
        const c = { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t };
        if (Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) <= part.radius) return true;
      }
      return false;
    }
    case 'surface':
      return false;
  }
}

/** Probe directions: the six axes and the eight diagonals. */
const PROBES: Vec3[] = [];
for (const v of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) PROBES.push({ x: v[0], y: v[1], z: v[2] });
for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
  const n = Math.sqrt(3);
  PROBES.push({ x: sx / n, y: sy / n, z: sz / n });
}

/** Within `delta` of the surface of the parts: some probe that far away is inside them and some is outside. */
function onSurface(parts: Part3D[], p: Vec3, delta: number): boolean {
  let anyIn = false, anyOut = false;
  for (const d of PROBES) {
    const q = { x: p.x + d.x * delta, y: p.y + d.y * delta, z: p.z + d.z * delta };
    if (parts.some(part => inside(part, q))) anyIn = true; else anyOut = true;
  }
  return anyIn && anyOut;
}

/** The parts a nozzle of this component may stand on: its own, less pads and surfaces. */
function standingParts(model: Scene3DModel, id: string): Part3D[] {
  return model.parts.filter(p => p.componentId === id && !p.id.startsWith('pad:') && p.shape !== 'surface');
}

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------

function allNumbersFinite(v: unknown, at: string, bad: string[]): void {
  if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(`${at}=${v}`); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => allNumbersFinite(x, `${at}[${i}]`, bad)); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) allNumbersFinite(x, `${at}.${k}`, bad);
}

function sizeProblems(part: Part3D): string | null {
  switch (part.shape) {
    case 'cylinder': {
      const n = Math.hypot(part.axis.x, part.axis.y, part.axis.z);
      if (Math.abs(n - 1) > 1e-9) return `axis length ${n}`;
      if (!(part.radius > 0) || !(part.length > 0)) return `radius ${part.radius} length ${part.length}`;
      if (part.radiusEnd !== undefined && !(part.radiusEnd > 0)) return `radiusEnd ${part.radiusEnd}`;
      if (part.wall !== undefined && !(part.wall > 0)) return `wall ${part.wall}`;
      return null;
    }
    case 'box':
      if (!(part.size.x > 0 && part.size.y > 0 && part.size.z > 0)) return `size ${fmt(part.size)}`;
      if (part.wall !== undefined && !(part.wall > 0)) return `wall ${part.wall}`;
      return null;
    case 'tube':
      if (!(part.radius > 0)) return `radius ${part.radius}`;
      if (part.path.length < 2) return `${part.path.length} path points`;
      return null;
    case 'surface':
      return part.outline.length >= 3 ? null : `${part.outline.length} outline points`;
  }
}

/** Points a part reaches (conservative), to test the bounds against. */
function extremePoints(part: Part3D): Vec3[] {
  switch (part.shape) {
    case 'cylinder': {
      const [e1, e2] = perpendiculars(part.axis);
      const out: Vec3[] = [];
      const before = part.capBase === 'dome' ? part.radius / 2 : 0;
      const after = part.capEnd === 'dome' ? (part.radiusEnd ?? part.radius) / 2 : 0;
      for (const [s, r] of [[-before, part.radius], [0, part.radius], [part.length, part.radiusEnd ?? part.radius], [part.length + after, part.radiusEnd ?? part.radius]]) {
        const rr = (s === -before && before > 0) || (s === part.length + after && after > 0) ? 0 : r;
        for (let k = 0; k < 8; k++) {
          const a = (2 * Math.PI * k) / 8;
          out.push({
            x: part.base.x + part.axis.x * s + rr * (Math.cos(a) * e1.x + Math.sin(a) * e2.x),
            y: part.base.y + part.axis.y * s + rr * (Math.cos(a) * e1.y + Math.sin(a) * e2.y),
            z: part.base.z + part.axis.z * s + rr * (Math.cos(a) * e1.z + Math.sin(a) * e2.z),
          });
        }
      }
      return out;
    }
    case 'box': {
      const out: Vec3[] = [];
      const yaw = part.yaw ?? 0;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const lx = sx * part.size.x / 2, ly = sy * part.size.y / 2;
        out.push({
          x: part.center.x + Math.cos(yaw) * lx - Math.sin(yaw) * ly,
          y: part.center.y + Math.sin(yaw) * lx + Math.cos(yaw) * ly,
          z: part.center.z + sz * part.size.z / 2,
        });
      }
      return out;
    }
    case 'tube':
      return part.path.flatMap(q => PROBES.map(d => ({ x: q.x + d.x * part.radius, y: q.y + d.y * part.radius, z: q.z + d.z * part.radius })));
    case 'surface':
      return part.outline;
  }
}

/** Connections the 2.5D view lays as a routed run, with the plant's grid routes (canvas.ts computeConnectionRun). */
function routedConnections(plant: PlantState): Connection[] {
  const grid = new GridView();
  const runs = grid.planRuns(plant);
  const out: Connection[] = [];
  for (const conn of plant.connections) {
    const from = plant.components.get(conn.fromComponentId);
    const to = plant.components.get(conn.toComponentId);
    if (!from || !to) continue;
    if (!from.ports.some(p => p.id === conn.fromPortId) || !to.ports.some(p => p.id === conn.toPortId)) continue;
    const joint = crossVesselJoint(conn, plant);
    if (joint) {
      if (joint.kind === 'inside' && !joint.crossVesselPortId.includes('annulus')) out.push(conn);
      continue;
    }
    const cv = from.type === 'crossVessel' ? from : to.type === 'crossVessel' ? to : undefined;
    const mate = cv ? (cv as { targetComponentId?: string }).targetComponentId : undefined;
    if (mate && (mate === from.id || mate === to.id)) continue;
    const plan = runs.get(conn);
    if (plan && plan.length >= 2) out.push(conn);
  }
  return out;
}

function loadPlant(rel: string): PlantState {
  return deserializePlantDesign(JSON.parse(fs.readFileSync(path.join(HERE, rel), 'utf8')));
}

function checkPlant(name: string, rel: string, withSim: boolean, edit?: (plant: PlantState) => void): void {
  console.log(`\n${name} (${rel})`);
  const plant = loadPlant(rel);
  edit?.(plant);
  const model = buildScene3D(plant);

  const drawn = Array.from(plant.components.values()).filter(c => !(c as { isHydraulicOnly?: boolean }).isHydraulicOnly);
  const partless = drawn.filter(c => !model.parts.some(p => p.componentId === c.id)).map(c => `${c.id} (${c.type})`);
  check(`every drawn component yields parts (${drawn.length} components, ${model.parts.length} parts)`, partless.length === 0, partless.join(', '));

  const bad: string[] = [];
  allNumbersFinite(model, 'model', bad);
  check('every number is finite', bad.length === 0, bad.slice(0, 5).join(', '));

  const sizes = model.parts.map(p => [p.id, sizeProblems(p)] as const).filter(([, s]) => s !== null);
  check('unit axes, positive sizes', sizes.length === 0, sizes.slice(0, 5).map(([id, s]) => `${id}: ${s}`).join('; '));

  const ids = new Set<string>();
  const dup = model.parts.filter(p => (ids.has(p.id) ? true : (ids.add(p.id), false))).map(p => p.id);
  check('part ids are unique', dup.length === 0, dup.slice(0, 5).join(', '));

  const routed = routedConnections(plant);
  const tubes = new Map<string, Part3D>();
  for (const p of model.parts) if (p.shape === 'tube' && p.connectionKey) tubes.set(p.connectionKey, p);
  const noTube: string[] = [];
  const offSurface: string[] = [];
  for (const conn of routed) {
    const key = connectionKey(conn);
    const tube = tubes.get(key);
    if (!tube || tube.shape !== 'tube') { noTube.push(key); continue; }
    for (const [end, compId] of [[tube.path[0], conn.fromComponentId], [tube.path[tube.path.length - 1], conn.toComponentId]] as const) {
      const comp = plant.components.get(compId) as PlantComponent;
      // A tank that is a terrain water body has nothing solid: its nozzle is the plan anchor
      if (comp.type === 'tank' && (comp as { waterBody?: string }).waterBody) continue;
      if (comp.type === 'pipe') {
        // A pipe's nozzle is its run's end (a connection elevation is measured
        // from the pipe's bottom, so it may sit off the centreline, inside the bore)
        const run = standingParts(model, compId).find(p => p.shape === 'tube');
        const ok = !!run && run.shape === 'tube' && [run.path[0], run.path[run.path.length - 1]].some(q =>
          Math.hypot(q.x - end.x, q.y - end.y, q.z - end.z) <= run.radius + 0.05);
        if (!ok) offSurface.push(`${key} at pipe ${compId} ${fmt(end)}`);
        continue;
      }
      if (!onSurface(standingParts(model, compId), end, 0.05)) offSurface.push(`${key} at ${compId} ${fmt(end)}`);
    }
  }
  check(`each of ${routed.length} routed connections is a tube`, noTube.length === 0, noTube.slice(0, 5).join('; '));
  check('every routed tube ends on the surfaces of the components it joins', offSurface.length === 0,
    `${offSurface.length} ends off: ${offSurface.slice(0, 6).join('; ')}`);

  const eps = 1e-6;
  const outside: string[] = [];
  for (const p of model.parts) {
    for (const q of extremePoints(p)) {
      if (q.x < model.bounds.min.x - eps || q.y < model.bounds.min.y - eps || q.z < model.bounds.min.z - eps ||
          q.x > model.bounds.max.x + eps || q.y > model.bounds.max.y + eps || q.z > model.bounds.max.z + eps) {
        outside.push(`${p.id} ${fmt(q)}`);
        break;
      }
    }
  }
  check('the bounds hold every part', outside.length === 0, outside.slice(0, 5).join('; '));
  check('ground: terrain when the plant has one, else a flat plane round the plant',
    plant.terrain ? model.ground.terrain === plant.terrain && !model.ground.flat
      : !!model.ground.flat && model.ground.flat.x0 < model.bounds.min.x && model.ground.flat.x1 > model.bounds.max.x &&
        model.ground.flat.y0 < model.bounds.min.y && model.ground.flat.y1 > model.bounds.max.y);

  // Signature
  const sig = sceneSignature(plant);
  check('sceneSignature is stable', sig === sceneSignature(plant));
  const mover = drawn.find(c => c.type !== 'pipe')!;
  const was = mover.position;
  mover.position = { x: was.x + 3, y: was.y };
  const moved = sceneSignature(plant);
  mover.position = was;
  check(`sceneSignature changes when ${mover.id} moves`, moved !== sig);
  check('...and is back when it returns', sceneSignature(plant) === sig);
  const conn0 = plant.connections[0];
  if (conn0) {
    const savedRoute = conn0.route;
    conn0.route = [{ x: 0, y: 0 }, { x: 5, y: 0 }];
    check('sceneSignature changes when a connection is re-routed', sceneSignature(plant) !== sig);
    conn0.route = savedRoute;
  }
  {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) sceneSignature(plant);
    const sigMs = (performance.now() - t0) / 50;
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) buildScene3D(plant);
    const buildMs = (performance.now() - t1) / 5;
    check(`signature (${sigMs.toFixed(3)} ms) is cheaper than a rebuild (${buildMs.toFixed(2)} ms, routes cached)`, sigMs < buildMs);
  }

  // Colours
  const sources = model.parts.filter(p => p.color);
  const nullColours = partColors(model, plant, null);
  check(`partColors without a simulation runs (${nullColours.size} of ${sources.length} coloured from display fluids)`, true);
  if (withSim) {
    const sim = createSimulationFromPlant(plant);
    const colours = partColors(model, plant, sim);
    const missing = sources.filter(p => !colours.has(p.id)).map(p => `${p.id} <- ${JSON.stringify(p.color)}`);
    check(`partColors gives every one of ${sources.length} coloured parts a colour`, missing.length === 0, missing.slice(0, 6).join('; '));
    const outOfRange = Array.from(colours.entries()).filter(([, c]) =>
      ![c.r, c.g, c.b, c.glow].every(v => Number.isFinite(v) && v >= 0 && v <= 1)).map(([id, c]) => `${id} ${JSON.stringify(c)}`);
    check('every colour is in 0..1', outOfRange.length === 0, outOfRange.slice(0, 5).join('; '));
    // Building the simulation names every component's node: the model is
    // rebuilt once for that, and the rebuilt model colours just the same
    const rebuilt = buildScene3D(plant);
    const colours2 = partColors(rebuilt, plant, sim);
    check('a model rebuilt after the simulation exists is coloured fully too',
      rebuilt.parts.filter(p => p.color).every(p => colours2.has(p.id)));
  }
}

checkPlant('Xe-100', '../src/presets/xe100.json', true);
checkPlant('PWR', '../src/presets/pwr.json', true);
checkPlant('4-loop PWR', '../src/presets/w4loop.json', true);
// The level ships unpiped: lay the lines a player would (sea -> tank B, tank
// A -> pool), so runs across sloping terrain and to a sea are exercised
checkPlant('Spent-fuel pool level, piped (terrain, sunken pool, sea tank)', '../src/game-mode/levels/spent-fuel-pool.json', true, plant => {
  plant.connections.push(
    { fromComponentId: 'sea', fromPortId: 'sea-out', toComponentId: 'tank-b', toPortId: 'tank-b-out', fromElevation: 0.5, toElevation: 0.5, flowArea: 0.05, length: 170 },
    { fromComponentId: 'tank-a', fromPortId: 'tank-a-out', toComponentId: 'pool', toPortId: 'pool-makeup-e', fromElevation: 0.5, toElevation: 10, flowArea: 0.05, length: 50 },
  );
});
{
  console.log('\nTerrain placement');
  const plant = loadPlant('../src/game-mode/levels/spent-fuel-pool.json');
  const model = buildScene3D(plant);
  const tank = plant.components.get('tank-a')!;
  const shell = model.parts.find(p => p.id === 'tank-a:shell');
  const ground = terrainHeightAt(plant.terrain, tank.position);
  check('a tank stands at its local ground plus its elevation', !!shell && shell.shape === 'cylinder' &&
    Math.abs(shell.base.z - (ground + (tank.elevation ?? 0))) < 1e-9, shell && shell.shape === 'cylinder' ? `base ${shell.base.z} ground ${ground}` : 'no shell');
  const pool = plant.components.get('pool') as PlantComponent & { depth: number };
  const walls = model.parts.find(p => p.id === 'pool:walls');
  const poolGround = terrainHeightAt(plant.terrain, pool.position);
  check('a pool sunk by its depth has its rim at grade', !!walls && walls.shape === 'box' &&
    Math.abs(walls.center.z + walls.size.z / 2 - (poolGround + (pool.elevation ?? 0) + pool.depth)) < 1e-9);
  const sea = model.parts.find(p => p.id === 'water:sea');
  check('the sea is a water surface coloured from the tank that is it', !!sea && sea.shape === 'surface' &&
    sea.componentId === 'sea' && sea.color?.kind === 'flowNode' && sea.waterBody === 'sea');
  const half = ((pool as { side?: number }).side || 12) / 2;
  check('the ground is cut away over the sunken pool', !!model.ground.holes?.some(h =>
    Math.abs(h.x0 - (pool.position.x - half)) < 1e-9 && Math.abs(h.y1 - (pool.position.y + half)) < 1e-9));
  // Live heights: the pool's water at its node's level across its depth, the sea at its body's surface
  const sim = createSimulationFromPlant(plant);
  const colours = partColors(model, plant, sim);
  const water = model.parts.find(p => p.id === 'pool:water');
  const wc = colours.get('pool:water');
  check('the pool water stands between its floor and rim', !!water && water.shape === 'surface' && !!water.levelRange &&
    wc?.surfaceZ !== undefined && wc.surfaceZ >= water.levelRange.bottom && wc.surfaceZ <= water.levelRange.top,
    `z ${wc?.surfaceZ}`);
  const seaBody = sim.surfaceWater?.bodies.get('sea');
  check('the sea surface follows its body', !!seaBody && colours.get('water:sea')?.surfaceZ === seaBody.surface);
}
{
  console.log('\nBuildings and levels');
  const plant = loadPlant('../src/presets/w4loop.json');
  const model = buildScene3D(plant);
  const shells = model.parts.filter(p => p.componentId && plant.components.get(p.componentId)?.type === 'building');
  check(`every building shell is see-through and roofed (${shells.length})`, shells.length > 0 && shells.every(p =>
    p.opacity !== undefined && p.opacity < 1 &&
    (p.shape === 'box' ? p.roof === true : p.shape === 'cylinder' && p.capEnd === 'flat' && p.capBase === 'open')));
  const sim = createSimulationFromPlant(plant);
  const colours = partColors(buildScene3D(plant), plant, sim);
  const pzr = colours.get('pzr-1:shell');
  check('the pressurizer shell shows its level', !!pzr?.liquid && pzr.liquid.fraction > 0 && pzr.liquid.fraction < 1,
    JSON.stringify(pzr?.liquid));
  const flagged = model.parts.filter(p => p.showsLevel).map(p => p.id);
  check('vessel shells show levels, pipe runs do not', flagged.includes('pzr-1:shell') &&
    !model.parts.some(p => p.showsLevel && p.shape === 'tube'));
}
for (const f of fs.readdirSync(path.join(HERE, '../src/presets')).filter(f => f.endsWith('.json'))) {
  if (['xe100.json', 'pwr.json', 'w4loop.json'].includes(f)) continue;
  checkPlant(f, `../src/presets/${f}`, false);
}

{
  console.log('\nAn unknown component type throws');
  const plant = loadPlant('../src/presets/pwr.json');
  const c = Array.from(plant.components.values()).find(k => k.type === 'tank') as PlantComponent;
  (c as { type: string }).type = 'flux-capacitor';
  plant.components = new Map([[c.id, c]]);
  plant.connections = [];
  let threw = false;
  try { buildScene3D(plant); } catch { threw = true; }
  check('buildScene3D throws on a component type it has no shape for', threw);
}

console.log(failures === 0 ? '\nAll scene3d checks passed' : `\n${failures} scene3d check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
