/**
 * Terrain checks: height sampling, basins, stage-storage, spill.
 * Run: npx tsx scripts/test-terrain.ts
 */
import {
  TerrainSpec, buildTerrainModel, terrainHeightAt, cellAt, surfaceAtVolume, volumeAtSurface, wettedArea, flatTerrain,
} from '../src/simulation/terrain';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

// A 10 x 6 map, 10 m cells: a slope from +20 m on the west down to the sea
// (0 m) on the east, with a bowl (pond) in the middle
function slopeWithBowl(): TerrainSpec {
  const cols = 10, rows = 6;
  const heights: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let h = 20 - i * 2.5;          // 20 .. -2.5 (sea at the east edge, below 0)
      if (i >= 3 && i <= 5 && j >= 2 && j <= 3) h -= 4;  // a 2x3-cell bowl
      heights.push(h);
    }
  }
  return {
    origin: { x: 0, y: 0 }, cellSize: 10, cols, rows, heights,
    waters: [{ id: 'sea', seed: { x: 90, y: 20 }, surface: 0 }],
  };
}

console.log('Height sampling');
{
  const t = flatTerrain({ x: 0, y: 0 }, 5, 4, 4, 7);
  check('flat terrain returns its height', near(terrainHeightAt(t, { x: 3, y: 9 }), 7));
  check('no terrain is height 0', terrainHeightAt(undefined, { x: 3, y: 9 }) === 0);
  const s = slopeWithBowl();
  check('height at a cell centre is the cell height', near(terrainHeightAt(s, { x: 20, y: 0 }), 15));
  check('height between centres interpolates', near(terrainHeightAt(s, { x: 25, y: 0 }), 13.75));
  check('outside the field the edge value holds', near(terrainHeightAt(s, { x: -100, y: 0 }), 20));
  check('cellAt rounds to the nearest centre', cellAt(s, { x: 24, y: 11 }) === 1 * 10 + 2);
}

console.log('Basins');
{
  const s = slopeWithBowl();
  const m = buildTerrainModel(s);
  const seaBasin = m.basins.find(b => b.water?.id === 'sea');
  check('the sea is a basin', !!seaBasin);
  const bowlCell = cellAt(s, { x: 40, y: 25 });
  const bowl = m.basins[m.basinOf[bowlCell]];
  check('the bowl is its own basin', bowl !== seaBasin && bowl.sinkHeight < terrainHeightAt(s, { x: 40, y: 10 }));
  check('the bowl spills toward the sea side', bowl.spillTo >= 0 && bowl.spillHeight > bowl.sinkHeight, `spill ${bowl.spillHeight} -> ${bowl.spillTo}`);
  // The hilltop cell far from the bowl drains to the sea
  const top = cellAt(s, { x: 0, y: 0 });
  check('open slope drains to the sea', m.basinOf[top] === seaBasin!.id);
  check('every cell has a basin', Array.from(m.basinOf).every(b => b >= 0));
}

console.log('Stage-storage');
{
  const s = slopeWithBowl();
  const m = buildTerrainModel(s);
  const bowl = m.basins[m.basinOf[cellAt(s, { x: 40, y: 25 })]];
  check('empty bowl surface is its sink height', near(surfaceAtVolume(m, bowl, 0), bowl.sinkHeight));
  for (const v of [50, 400, 2000]) {
    const surf = surfaceAtVolume(m, bowl, v);
    check(`volume round-trips through the surface (${v} m3)`, near(volumeAtSurface(m, bowl, surf), v, 1e-6), `${volumeAtSurface(m, bowl, surf)}`);
  }
  check('surface rises with volume', surfaceAtVolume(m, bowl, 400) > surfaceAtVolume(m, bowl, 50));
  const a1 = wettedArea(m, bowl, surfaceAtVolume(m, bowl, 50));
  const a2 = wettedArea(m, bowl, surfaceAtVolume(m, bowl, 2000));
  check('wetted area grows with volume', a2 > a1 && a1 >= 100, `${a1} -> ${a2}`);
}

if (failures > 0) {
  console.error(`\n${failures} terrain check(s) failed`);
  process.exit(1);
}
console.log('\nAll terrain checks passed');
