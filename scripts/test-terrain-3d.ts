/**
 * The 2.5D terrain's pure geometry: the mesh and its far ring, the view
 * datum, water bodies past the field's edge, the waterline cut, and picking
 * the ground under the cursor (including a hill hiding what is behind it).
 * Run: npx tsx scripts/test-terrain-3d.ts
 */
import { TerrainSpec, terrainHeightAt } from '../src/simulation/terrain';
import { buildTerrainScene, viewDatum, basinSurfaces, waterBodyAt, clipPolygon, pickGround, GroundVertex } from '../src/render/terrain-3d';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

// 5 x 4 cells of 10 m, falling 4 m a column from +10 on the west to -6 on
// the east, where the sea (surface 0) stands
function beach(): TerrainSpec {
  const cols = 5, rows = 4;
  const heights: number[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) heights.push(10 - 4 * i);
  return { origin: { x: 0, y: 0 }, cellSize: 10, cols, rows, heights, waters: [{ id: 'sea', seed: { x: 40, y: 10 }, surface: 0 }] };
}

console.log('Mesh');
{
  const spec = beach();
  const scene = buildTerrainScene(spec, 0);
  check('lattice is the cells plus a far ring', scene.nx === 7 && scene.ny === 6 && scene.verts.length === 42);
  const sw = scene.verts[0], ne = scene.verts[scene.verts.length - 1];
  check('far ring carries the edge heights (south-west)', sw.h === 10 && sw.x < -1e5 && sw.y < -1e5);
  check('far ring carries the edge heights (north-east)', ne.h === -6 && ne.x > 1e5 && ne.y > 1e5);
  const inner = scene.verts[1 * scene.nx + 3];
  check('interior vertices sit on the cell centres', inner.x === 20 && inner.y === 0 && inner.h === 2);
}

console.log('View datum');
{
  const spec = beach();
  check('median of the ground under the components', viewDatum(spec, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 40, y: 0 }]) === 6);
  check('a lone component on the beach does not move a plant on the hill',
    viewDatum(spec, [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 40, y: 0 }]) === 10);
  check('no components: median of the field', viewDatum(spec, []) === 2);
}

console.log('Water');
{
  const spec = beach();
  const scene = buildTerrainScene(spec, 0);
  const surfaces = basinSurfaces(scene.model, undefined);
  check('the sea stands at its declared surface before any simulation',
    [...surfaces.values()].includes(0));
  check('a point in the sea is in the sea', waterBodyAt(scene, surfaces, { x: 40, y: 10 }) === 'sea');
  check('a point on the hill is dry', waterBodyAt(scene, surfaces, { x: 0, y: 10 }) === undefined);
  check('the sea runs on past the field edge, as drawn', waterBodyAt(scene, surfaces, { x: 500, y: 10 }) === 'sea');
  check('the waterline is where the ground crosses the surface', waterBodyAt(scene, surfaces, { x: 24, y: 10 }) === undefined &&
    waterBodyAt(scene, surfaces, { x: 26, y: 10 }) === 'sea');
}

console.log('Waterline cut');
{
  const v = (x: number, y: number, h: number): GroundVertex => ({ x, y, h, cell: 0 });
  const cut: GroundVertex[] = [];
  const wet = clipPolygon([v(0, 0, -2), v(10, 0, 2), v(0, 10, -2)], p => 0 - p.h, cut);
  let area = 0;
  for (let k = 0; k < wet.length; k++) {
    const a = wet[k], b = wet[(k + 1) % wet.length];
    area += a.x * b.y - b.x * a.y;
  }
  check('the wet part of a half-drowned triangle', near(Math.abs(area) / 2, 37.5), `area ${Math.abs(area) / 2}`);
  check('the cut is one waterline segment at the surface', cut.length === 2 && cut.every(p => near(p.h, 0)));
  check('...between the right points', near(cut[0].x, 5) && near(cut[0].y, 0) && near(cut[1].x, 5) && near(cut[1].y, 5));
}

console.log('Picking the ground');
{
  // Flat at 0 with a ridge 8 m high at y = 50, seen by a pinhole eye 10 m up
  // at y = 0: a point projects 1000 (eye - z) / distance below the horizon
  const cols = 2, rows = 20;
  const heights: number[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) heights.push(j === 5 ? 8 : 0);
  const spec: TerrainSpec = { origin: { x: 0, y: 0 }, cellSize: 10, cols, rows, heights };
  const EYE = 10, HORIZON = 300;
  const screenY = (p: { x: number; y: number }, z: number) => HORIZON + 1000 * (EYE - z) / p.y;
  const rayAt = (d: number) => ({ x: 5, y: d });
  const surfaceY = (p: { x: number; y: number }) => screenY(p, terrainHeightAt(spec, p));
  const pick = (sy: number) => pickGround(1, 1e4, sy, rayAt, surfaceY);

  const front = pick(screenY({ x: 5, y: 30 }, 0));
  check('open ground in front of the ridge picks itself', front !== null && near(front.y, 30, 1e-6), `got ${front?.y}`);
  const hidden = pick(screenY({ x: 5, y: 120 }, 0));
  check('ground hidden behind the ridge picks the ridge', hidden !== null && hidden.y > 40 && hidden.y < 50, `got ${hidden?.y}`);
  const beyond = pick(screenY({ x: 5, y: 60 }, 8) - 20);
  check('ground seen over the ridge picks the far side', beyond !== null && beyond.y > 60, `got ${beyond?.y}`);
  check('the sky picks nothing', pick(HORIZON - 50) === null);
}

if (failures > 0) {
  console.log(`\n${failures} terrain-3d check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll terrain-3d checks passed');
