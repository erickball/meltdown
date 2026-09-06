/**
 * Grid-view geometry checks: footprints, snapping, port anchors, routing.
 * Run: npx tsx scripts/test-grid-geometry.ts
 */
import {
  TILE_M, componentFootprint, footprintForType, snapCenter, footprintRect, portAnchors,
  autoRoute, completeRoute, extendRoute, rubberBand, routeLength, simplifyRoute, reanchorRoute,
  connectionRoute, pipeRoute, cellCenter, distanceToPolyline, pointAlongRoute, portAnchorFacing,
} from '../src/render/grid-geometry';
import { PlantState, TankComponent, PumpComponent, PipeComponent, Connection, Point } from '../src/types';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;
const samePt = (a: Point, b: Point) => near(a.x, b.x) && near(a.y, b.y);
const fmt = (pts: Point[]) => pts.map(p => `(${p.x},${p.y})`).join(' ');

function tank(id: string, x: number, y: number, width = 2, height = 4): TankComponent {
  const halfW = width / 2, halfH = height / 2;
  return {
    id, type: 'tank', position: { x, y }, rotation: 0, width, height, wallThickness: 0.02, fillLevel: 0.5,
    ports: [
      { id: `${id}-top`, position: { x: 0, y: -halfH }, direction: 'both' },
      { id: `${id}-bottom`, position: { x: 0, y: halfH }, direction: 'both' },
      { id: `${id}-left`, position: { x: -halfW, y: 0 }, direction: 'both' },
      { id: `${id}-right`, position: { x: halfW, y: 0 }, direction: 'both' },
    ],
  };
}

function pump(id: string, x: number, y: number): PumpComponent {
  return {
    id, type: 'pump', position: { x, y }, rotation: 0, diameter: 0.3, running: false, speed: 1,
    ratedFlow: 100, ratedHead: 50,
    ports: [
      { id: `${id}-inlet`, position: { x: 0, y: 0.5 }, direction: 'in' },
      { id: `${id}-outlet`, position: { x: 0.4, y: -0.1 }, direction: 'out' },
    ],
  };
}

console.log('Footprints and snapping');
{
  const t = tank('t1', 0, 0, 2, 4);
  const fp = componentFootprint(t);
  check('2 m tank is a 2x2 footprint (cylinder: depth = width)', fp.w === 2 && fp.d === 2, JSON.stringify(fp));
  const t3 = tank('t3', 0, 0, 2.4, 6);
  check('2.4 m tank rounds up to 3x3', componentFootprint(t3).w === 3 && componentFootprint(t3).d === 3);
  check('pump is one tile', componentFootprint(pump('p', 0, 0)).w === 1);
  check('reactor-vessel palette footprint is 5x5', footprintForType('reactor-vessel').w === 5 && footprintForType('reactor-vessel').d === 5);
  check('valve palette footprint is 1x1', footprintForType('valve').w === 1 && footprintForType('valve').d === 1);

  const even = snapCenter({ x: 3.3, y: -1.2 }, { w: 2, d: 2 });
  check('even footprint snaps its centre to a lattice corner', near(even.x, 3) && near(even.y, -1), JSON.stringify(even));
  const odd = snapCenter({ x: 3.3, y: -1.2 }, { w: 1, d: 3 });
  check('odd footprint snaps its centre to a cell centre', near(odd.x, 3.5) && near(odd.y, -1.5), JSON.stringify(odd));
  const r = footprintRect(even, { w: 2, d: 2 });
  check('snapped footprint edges are whole tiles', near(r.x0, 2) && near(r.x1, 4) && near(r.y0, -2) && near(r.y1, 0));
  const cc = cellCenter({ x: -0.2, y: 4.9 });
  check('cell centre of a point', near(cc.x, -0.5) && near(cc.y, 4.5), JSON.stringify(cc));
}

console.log('Port anchors');
{
  const t = tank('t1', 3, 1, 2, 4); // footprint x 2..4, y 0..2
  const anchors = portAnchors(t);
  const by = (id: string) => anchors.find(a => a.port.id === id)!;
  check('top port faces north on the north edge', by('t1-top').side === 'N' && near(by('t1-top').point.y, 0), JSON.stringify(by('t1-top')));
  check('bottom port faces south on the south edge', by('t1-bottom').side === 'S' && near(by('t1-bottom').point.y, 2));
  check('left port faces west on the west edge', by('t1-left').side === 'W' && near(by('t1-left').point.x, 2));
  check('right port faces east on the east edge', by('t1-right').side === 'E' && near(by('t1-right').point.x, 4));
  check('anchors sit on edge-cell midpoints', anchors.every(a =>
    (a.side === 'N' || a.side === 'S') ? near((a.point.x - 2) % 1, 0.5) : near((a.point.y - 0) % 1, 0.5)));
  check('out cell is half a tile outward', anchors.every(a => a.out !== undefined &&
    near(Math.hypot(a.out.x - a.point.x, a.out.y - a.point.y), TILE_M / 2)));

  // Two ports on the same edge cell spread apart
  const t2 = tank('t2', 0, 0, 3, 6);
  t2.ports.push({ id: 't2-top2', position: { x: 0, y: -3 }, direction: 'both' });
  const a2 = portAnchors(t2);
  const tops = a2.filter(a => a.side === 'N');
  check('two top ports get different edge cells', tops.length === 2 && !samePt(tops[0].point, tops[1].point), fmt(tops.map(a => a.point)));

  const p = pump('p1', 0.5, 0.5);
  const pa = portAnchors(p);
  check('pump inlet (below centre) faces south', pa[0].side === 'S');
  check('pump outlet (to the right) faces east', pa[1].side === 'E');
}

console.log('Routing');
{
  const a = tank('a', 1, 1, 2, 4);   // x 0..2, y 0..2
  const b = tank('b', 9, 5, 2, 4);   // x 8..10, y 4..6
  const aRight = portAnchors(a).find(x => x.port.id === 'a-right')!;
  const bLeft = portAnchors(b).find(x => x.port.id === 'b-left')!;
  const route = autoRoute(aRight, bLeft);
  check('auto route starts and ends on the anchors', samePt(route[0], aRight.point) && samePt(route[route.length - 1], bLeft.point), fmt(route));
  check('auto route is orthogonal', route.every((p, i) => i === 0 || near(p.x, route[i - 1].x) || near(p.y, route[i - 1].y)), fmt(route));
  check('auto route leaves the port straight out', near(route[1].y, route[0].y) && route[1].x > route[0].x, fmt(route));
  const expectedLen = Math.abs(bLeft.point.x - aRight.point.x) + Math.abs(bLeft.point.y - aRight.point.y);
  check('single-bend route length is the manhattan distance', near(routeLength(route), expectedLen), `${routeLength(route)} vs ${expectedLen}`);

  // Interactive laying: sweep east then south, finish into b
  let wp = [aRight.out!];
  for (let x = 3.5; x <= 7.5; x += 1) wp = extendRoute(wp, { x, y: aRight.out!.y });
  check('sweeping along a line keeps a single segment', wp.length === 2, fmt(wp));
  wp = extendRoute(wp, { x: 7.5, y: 3.5 });
  check('turning adds a vertex', wp.length === 3, fmt(wp));
  wp = extendRoute(wp, { x: 7.5, y: 2.5 });
  check('dragging back along the last leg shortens it', wp.length === 3 && near(wp[2].y, 2.5), fmt(wp));
  wp = extendRoute(wp, { x: 7.5, y: 1.5 });
  check('dragging back to the corner removes the leg', wp.length === 2 && near(wp[1].x, 7.5), fmt(wp));
  const done = completeRoute([aRight.point, ...wp], bLeft);
  check('completed route ends on the target anchor', samePt(done[done.length - 1], bLeft.point), fmt(done));
  check('completed route is orthogonal', done.every((p, i) => i === 0 || near(p.x, done[i - 1].x) || near(p.y, done[i - 1].y)), fmt(done));
  check('completed route enters the target through its out cell', samePt(done[done.length - 2], bLeft.out!), fmt(done));

  const band = rubberBand([{ x: 2.5, y: 1.5 }, { x: 5.5, y: 1.5 }], { x: 7.5, y: 4.5 });
  check('rubber band continues straight before bending', band.length === 3 && near(band[1].y, 1.5) && near(band[1].x, 7.5), fmt(band));

  const s = simplifyRoute([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 3 }]);
  check('simplify removes collinear and duplicate vertices', s.length === 3, fmt(s));

  // Re-anchoring after the target moved keeps the drawn interior
  const bMoved = tank('b', 9, 8, 2, 4);
  const bLeftMoved = portAnchors(bMoved).find(x => x.port.id === 'b-left')!;
  const re = reanchorRoute(done, aRight, bLeftMoved);
  check('re-anchored route reaches the moved port', samePt(re[re.length - 1], bLeftMoved.point) && samePt(re[0], aRight.point), fmt(re));
  check('re-anchored route stays orthogonal', re.every((p, i) => i === 0 || near(p.x, re[i - 1].x) || near(p.y, re[i - 1].y)), fmt(re));
  check('unchanged anchors return the stored route untouched', reanchorRoute(done, aRight, bLeft) === done);

  // Through the plant-state API
  const plant: PlantState = {
    components: new Map<string, any>([[a.id, a], [b.id, b]]),
    connections: [], simTime: 0, simSpeed: 1, isPaused: true,
  };
  const conn: Connection = { fromComponentId: 'a', fromPortId: 'a-right', toComponentId: 'b', toPortId: 'b-left', route: done };
  const cr = connectionRoute(conn, plant)!;
  check('connectionRoute uses the stored route', cr === done);
  const auto = connectionRoute({ ...conn, route: undefined }, plant)!;
  check('connectionRoute auto-routes without one', samePt(auto[0], aRight.point) && samePt(auto[auto.length - 1], bLeft.point));

  const mid = pointAlongRoute(done, 0.5);
  check('midpoint lies on the route', distanceToPolyline(mid.point, done) < 1e-9);
  check('direction is a unit vector', near(Math.hypot(mid.dir.x, mid.dir.y), 1));
}

console.log('Partner-facing nozzles');
{
  // A tank's left nozzle connected to something on its right is drawn on the right
  const t = tank('t', 2, 2, 2, 4);      // footprint x 1..3
  const u = tank('u', 12, 2, 2, 4);     // east of t
  const plant: PlantState = {
    components: new Map<string, any>([[t.id, t], [u.id, u]]),
    connections: [], simTime: 0, simSpeed: 1, isPaused: true,
  };
  const conn: Connection = { fromComponentId: 't', fromPortId: 't-left', toComponentId: 'u', toPortId: 'u-right' };
  const r = connectionRoute(conn, plant)!;
  check('tank left nozzle mirrors to the east edge when the partner is east', near(r[0].x, 3), fmt(r));
  check('partner right nozzle mirrors to its west edge', near(r[r.length - 1].x, 11), fmt(r));
  check('mirrored route is a straight run', r.length === 2, fmt(r));
  const p = pump('p', 20.5, 2.5);
  plant.components.set(p.id, p);
  const conn2: Connection = { fromComponentId: 'p', fromPortId: 'p-outlet', toComponentId: 'u', toPortId: 'u-left' };
  const r2 = connectionRoute(conn2, plant)!;
  check('pump ports keep their stored side', near(r2[0].x, 21), fmt(r2));
  check('top/bottom nozzles never mirror', portAnchorFacing(t, 't-top', { x: 50, y: 0 })!.side === 'N');
}

console.log('Pipes');
{
  const pipe: PipeComponent = {
    id: 'pipe-1', type: 'pipe', position: { x: 2, y: 0.5 }, rotation: 0, diameter: 0.3, thickness: 0.01, length: 6,
    endPosition: { x: 6, y: 3.5 }, endElevation: 0, elevation: 0,
    ports: [
      { id: 'pipe-1-left', position: { x: 0, y: 0 }, direction: 'both' },
      { id: 'pipe-1-right', position: { x: 6, y: 0 }, direction: 'both' },
    ],
  };
  const pr = pipeRoute(pipe);
  check('legacy pipe auto-routes as an L between its ends', pr.length === 3 && samePt(pr[0], pipe.position) && samePt(pr[2], pipe.endPosition!), fmt(pr));
  const pa = portAnchors(pipe);
  check('pipe port anchors are the route ends', samePt(pa[0].point, pr[0]) && samePt(pa[1].point, pr[2]));
  check('pipe end faces away from the body', pa[0].side === 'W' && pa[1].side === 'S', `${pa[0].side} ${pa[1].side}`);
  pipe.route = [{ x: 2, y: 0.5 }, { x: 2, y: 4.5 }, { x: 6, y: 4.5 }, { x: 6, y: 3.5 }];
  check('a drawn route wins over the endpoints', pipeRoute(pipe) === pipe.route);
  check('drawn route length', near(routeLength(pipe.route), 9));
}

if (failures > 0) {
  console.error(`\n${failures} grid geometry check(s) failed`);
  process.exit(1);
}
console.log('\nAll grid geometry checks passed');
