/**
 * Grid-view geometry checks: footprints, snapping, port anchors, routing.
 * Run: npx tsx scripts/test-grid-geometry.ts
 */
import {
  TILE_M, componentFootprint, footprintForType, snapCenter, footprintRect, portAnchors,
  autoRoute, completeRoute, extendRoute, rubberBand, routeLength, simplifyRoute, reanchorRoute,
  connectionRoute, pipeRoute, cellCenter, distanceToPolyline, pointAlongRoute, portAnchorFacing,
  searchRoute, routeObstacles, laneOffsetRoutes, Obstacle,
  pipePieceRoute, groundRunRoute, pipeFreeEnds, joinForFreeEnd, findFreeEndJoins,
  oppositeOrientation, PipeOrientation, snapPlacementCenter, crossVesselMates, crossVesselJoint,
  verticalNozzle, turnedValveSides,
} from '../src/render/grid-geometry';
import { liftRoute } from '../src/render/pipe-run-3d';
import { PlantState, TankComponent, PumpComponent, PipeComponent, Connection, Point, annulusNozzleDrawElevation, connectionDrawElevation } from '../src/types';

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
  const top = portAnchorFacing(t, 't-top', { x: 50, y: 0 })!;
  check('a top nozzle is not on a side: it stands at its plan position, facing the partner',
    top.vertical === 'up' && samePt(top.point, t.position) && top.side === 'E' && top.out === undefined, JSON.stringify(top));
}

console.log('Vertical nozzles, turned valves, plain runs');
{
  const isOrtho = (r: Point[]) => r.every((p, i) => i === 0 || near(p.x, r[i - 1].x) || near(p.y, r[i - 1].y));
  const fmt3 = (pts: { x: number; y: number; z: number }[]) => pts.map(p => `(${p.x},${p.y},${p.z})`).join(' ');
  // The Xe-100 plant layout's SG vessel head and primary safety valve: a
  // 5x5 vessel centred on whole metres, and a one-tile valve 4 m north of
  // its centre, 1 m above the head
  const sg = tank('sg', 55, 78, 4.6, 19.5);
  const valve: any = {
    id: 'v', type: 'valve', position: { x: 55, y: 74 }, rotation: 0, diameter: 0.1, opening: 0,
    ports: [
      { id: 'v-in', position: { x: -0.1, y: 0 }, direction: 'in' },
      { id: 'v-out', position: { x: 0.1, y: 0 }, direction: 'out' },
    ],
  };
  const conn: Connection = { fromComponentId: 'sg', fromPortId: 'sg-top', toComponentId: 'v', toPortId: 'v-in' };
  const plant: PlantState = {
    components: new Map<string, any>([[sg.id, sg], [valve.id, valve]]),
    connections: [conn], simTime: 0, simSpeed: 1, isPaused: true,
  };
  check('a head nozzle is vertical, pointing up', verticalNozzle(sg, 'sg-top') === 'up');
  check('a bottom-head nozzle points down', verticalNozzle(sg, 'sg-bottom') === 'down');
  check('a side nozzle is not vertical', verticalNozzle(sg, 'sg-left') === null);

  const sides = turnedValveSides(valve, id => id === 'v-in' ? sg.position : null)!;
  check('a valve turns its inlet to face the vessel south of it', sides.get('v-in') === 'S' && sides.get('v-out') === 'N',
    JSON.stringify([...sides]));
  const drawn = turnedValveSides(valve, () => null)!;
  check('an unpiped valve keeps its drawn sides', drawn.get('v-in') === 'W' && drawn.get('v-out') === 'E');

  const r = connectionRoute(conn, plant)!;
  check('head to valve: one straight run from the nozzle to the valve face',
    r.length === 2 && samePt(r[0], { x: 55, y: 78 }) && samePt(r[1], { x: 55, y: 74.5 }), fmt(r));
  // Lifted into 3D: straight up out of the head to the valve's height, then across into it
  const lifted = liftRoute({ x: 55, y: 78, z: 19.5 }, 'y', r, { x: 55, y: 74.1, z: 20.5 }, 'y', 'up', null);
  check('lifted: a riser at the head nozzle, then one level run into the valve',
    lifted.length === 3 && near(lifted[1].x, 55) && near(lifted[1].y, 78) && near(lifted[1].z, 20.5), fmt3(lifted));
  const sideRun = liftRoute({ x: 0, y: 0, z: 0 }, 'x', [{ x: 1, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3 }], { x: 6, y: 3, z: 4 }, 'x');
  check('side nozzles: the run keeps to the lower elevation and rises one vertex in from the higher end',
    sideRun.length === 5 && near(sideRun[1].z, 0) && near(sideRun[2].x, 5) && near(sideRun[2].y, 0) && near(sideRun[2].z, 4), fmt3(sideRun));

  // Off the old half-metre lattice: the search lattice is laid from the start
  const aligned = searchRoute({ x: 55, y: 75 }, { x: 57.5, y: 72 }, [], { x: 0, y: -1 }, { x: 1, y: 0 });
  check('a start on a whole metre leaves on its own line (no diagonal)',
    isOrtho(aligned) && samePt(aligned[0], { x: 55, y: 75 }) && samePt(aligned[aligned.length - 1], { x: 57.5, y: 72 }), fmt(aligned));
  const offset = searchRoute({ x: 55, y: 75 }, { x: 57.5, y: 72.5 }, [], { x: 0, y: -1 }, { x: 1, y: 0 });
  const monotone = (k: 'x' | 'y', sign: number) => offset.every((p, i) => i === 0 || (p[k] - offset[i - 1][k]) * sign >= -1e-9);
  check('an end half a tile off the lattice is joined square', isOrtho(offset) &&
    samePt(offset[offset.length - 1], { x: 57.5, y: 72.5 }), fmt(offset));
  check('the join arrives along the approach and never doubles back',
    near(offset[offset.length - 2].y, 72.5) && monotone('x', 1) && monotone('y', -1), fmt(offset));
}

console.log('Obstacle avoidance');
{
  const isOrtho = (r: Point[]) => r.every((p, i) => i === 0 || near(p.x, r[i - 1].x) || near(p.y, r[i - 1].y));
  const crosses = (r: Point[], o: Obstacle) => {
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1], b = r[i];
      const steps = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 0.25));
      for (let k = 0; k <= steps; k++) {
        const x = a.x + (b.x - a.x) * k / steps, y = a.y + (b.y - a.y) * k / steps;
        if (x > o.x0 + 1e-6 && x < o.x1 - 1e-6 && y > o.y0 + 1e-6 && y < o.y1 - 1e-6) return true;
      }
    }
    return false;
  };
  const wall: Obstacle = { id: 'wall', x0: 5, y0: -3, x1: 7, y1: 4 }; // between x=0 and x=12 on row 0.5
  const r = searchRoute({ x: 0.5, y: 0.5 }, { x: 12.5, y: 0.5 }, [wall], { x: 1, y: 0 });
  check('search route is orthogonal', isOrtho(r), fmt(r));
  check('search route goes round the obstacle', !crosses(r, wall), fmt(r));
  check('search route ends where asked', samePt(r[0], { x: 0.5, y: 0.5 }) && samePt(r[r.length - 1], { x: 12.5, y: 0.5 }), fmt(r));
  check('search route is the shortest way round (12 + 2 x 4 detour)', near(routeLength(r), 12 + 2 * 4), `${routeLength(r)}`);
  const free = searchRoute({ x: 0.5, y: 0.5 }, { x: 12.5, y: 0.5 }, [], { x: 1, y: 0 });
  check('no obstacle: a straight run', free.length === 2 && near(routeLength(free), 12), fmt(free));
  const bend = searchRoute({ x: 0.5, y: 0.5 }, { x: 6.5, y: 4.5 }, [], { x: 1, y: 0 });
  check('no obstacle, offset target: one bend, leaving straight first', bend.length === 3 && near(bend[1].y, 0.5), fmt(bend));
  const boxed = searchRoute({ x: 3.5, y: 3.5 }, { x: 10.5, y: 3.5 }, [{ id: 'around', x0: 2, y0: 2, x1: 5, y1: 5 }], { x: 1, y: 0 });
  check('a start inside a footprint still gets out', samePt(boxed[boxed.length - 1], { x: 10.5, y: 3.5 }) && isOrtho(boxed), fmt(boxed));

  // Through the plant: a tank in the way of two others
  const a = tank('a', 1, 1, 2, 4);      // x 0..2
  const b = tank('b', 15, 1, 2, 4);     // x 14..16
  const mid = tank('mid', 8, 1, 4, 8);  // x 6..10, y -1..3: right on the straight line
  const plant: PlantState = {
    components: new Map<string, any>([[a.id, a], [b.id, b], [mid.id, mid]]),
    connections: [], simTime: 0, simSpeed: 1, isPaused: true,
  };
  const obs = routeObstacles(plant);
  check('every tank is an obstacle', obs.length === 3);
  const route = connectionRoute({ fromComponentId: 'a', fromPortId: 'a-right', toComponentId: 'b', toPortId: 'b-left' }, plant)!;
  const midRect = obs.find(o => o.id === 'mid')!;
  check('auto route between tanks avoids the tank between them', !crosses(route, midRect), fmt(route));
  check('auto route still starts and ends on the anchors', near(route[0].x, 2) && near(route[route.length - 1].x, 14), fmt(route));
  const building = { id: 'bldg', type: 'building', position: { x: 8, y: 1 }, rotation: 0, shape: 'rectangle', width: 30, length: 30, height: 20, wallThickness: 1, steelFraction: 0.1, pressureRating: 1, ports: [] };
  plant.components.set('bldg', building as any);
  check('buildings are not obstacles', routeObstacles(plant).length === 3);
}

console.log('Lanes');
{
  const isOrtho = (r: Point[]) => r.every((p, i) => i === 0 || near(p.x, r[i - 1].x) || near(p.y, r[i - 1].y));
  // Two runs sharing a horizontal corridor on row y=2.5 from x=1 to x=9
  const r1 = [{ x: 0, y: 2.5 }, { x: 10, y: 2.5 }];
  const r2 = [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 2.5 }, { x: 9.5, y: 2.5 }, { x: 9.5, y: 6.5 }];
  const lanes = laneOffsetRoutes([
    { key: 'r1', pts: r1, width: 0.3 },
    { key: 'r2', pts: r2, width: 0.3 },
  ]);
  const d1 = lanes.get('r1')!, d2 = lanes.get('r2')!;
  check('displayed runs stay orthogonal', isOrtho(d1) && isOrtho(d2), fmt(d1) + ' | ' + fmt(d2));
  check('run ends stay on their anchors', samePt(d1[0], r1[0]) && samePt(d1[d1.length - 1], r1[1]) && samePt(d2[0], r2[0]) && samePt(d2[d2.length - 1], r2[3]));
  // y of a run where it crosses x = 5 (the middle of the shared corridor)
  const yOf = (pts: Point[]) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (near(a.y, b.y) && Math.min(a.x, b.x) <= 5 && Math.max(a.x, b.x) >= 5) return a.y;
    }
    return NaN;
  };
  const y1 = yOf(d1), y2 = yOf(d2);
  check('the two runs sit on different lanes in the shared corridor', Math.abs(y1 - y2) > 0.2, `${y1} vs ${y2}`);
  check('lanes are centred on the corridor', near(y1 + y2, 5, 1e-6), `${y1} + ${y2}`);
  check('lanes stay within the tile', Math.abs(y1 - 2.5) < 0.5 && Math.abs(y2 - 2.5) < 0.5);
  // A lone run is untouched
  const alone = laneOffsetRoutes([{ key: 'r1', pts: r1, width: 0.3 }]);
  check('a run with no neighbours keeps its geometry', alone.get('r1') === r1);
  // Five wide runs: compressed to fit the tile
  const many = Array.from({ length: 5 }, (_, i) => ({ key: `m${i}`, pts: [{ x: 0, y: 4.5 }, { x: 10, y: 4.5 }], width: 0.5 }));
  const packed = laneOffsetRoutes(many);
  const ys = many.map(m => yOf(packed.get(m.key)!)).sort((p, q) => p - q);
  check('a full corridor compresses its lanes into the tile', ys[4] - ys[0] <= 1 + 1e-9 && ys[1] - ys[0] > 0.1, ys.join(','));
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

console.log('Ground pipe: preview and placement coincide');
{
  // The pipe tool previews the piece with pipePieceRoute and the placement
  // builds from the very same call, so this checks the OTHER half of the
  // coincidence: that the point the click is snapped to is the point the
  // preview was drawn about, for both rotations. (The bug this replaces:
  // a pipe's `position` is its inlet END, but placement snapped it as if it
  // were a 10 x 1 footprint's CENTRE, so the piece landed half a length
  // east of its preview box.)
  for (const raw of [{ x: 4.2, y: -0.9 }, { x: 0.0, y: 0.0 }, { x: -3.7, y: 12.49 }]) {
    const snapped = snapPlacementCenter('pipe', raw);
    const cell = cellCenter(raw);
    check(`pipe placement snaps to the cell centre (${raw.x}, ${raw.y})`,
      samePt(snapped, cell), `${fmt([snapped])} vs ${fmt([cell])}`);
    for (const o of ['EW', 'NS'] as PipeOrientation[]) {
      const previewed = pipePieceRoute(raw, o);       // drawn about the raw cursor
      const placed = pipePieceRoute(snapped, o);      // built from the snapped point
      check(`preview and placed piece coincide, ${o} at (${raw.x}, ${raw.y})`,
        previewed.length === placed.length && previewed.every((p, i) => samePt(p, placed[i])),
        `${fmt(previewed)} vs ${fmt(placed)}`);
    }
  }

  const ew = pipePieceRoute({ x: 4.2, y: -0.9 }, 'EW');
  check('an east-west piece fills its tile along x',
    ew.length === 2 && near(ew[0].y, -0.5) && near(ew[1].y, -0.5) && near(ew[0].x, 4) && near(ew[1].x, 5), fmt(ew));
  const ns = pipePieceRoute({ x: 4.2, y: -0.9 }, 'NS');
  check('a north-south piece fills its tile along y',
    ns.length === 2 && near(ns[0].x, 4.5) && near(ns[1].x, 4.5) && near(ns[0].y, -1) && near(ns[1].y, 0), fmt(ns));
  check('both rotations are one tile long', near(routeLength(ew), TILE_M) && near(routeLength(ns), TILE_M));
  check('rotation is an involution', oppositeOrientation(oppositeOrientation('EW')) === 'EW');

  // A swept run: ends carried out to the tile boundary, interior on centres
  const run = groundRunRoute([{ x: 0.5, y: 0.5 }, { x: 1.5, y: 0.5 }, { x: 2.5, y: 0.5 }, { x: 2.5, y: 1.5 }], 'EW');
  check('a swept run starts on the first tile boundary', near(run[0].x, 0) && near(run[0].y, 0.5), fmt(run));
  check('a swept run ends on the last tile boundary', near(run[run.length - 1].x, 2.5) && near(run[run.length - 1].y, 2), fmt(run));
  check('a swept run is orthogonal', run.every((p, i) => i === 0 || near(p.x, run[i - 1].x) || near(p.y, run[i - 1].y)), fmt(run));
  check('a swept run costs its drawn length', near(routeLength(run), 4), String(routeLength(run)));
  const single = groundRunRoute([{ x: 4.2, y: -0.9 }], 'NS');
  check('a sweep that never left its cell is one piece in the tool rotation',
    single.length === 2 && samePt(single[0], ns[0]) && samePt(single[1], ns[1]), fmt(single));
}

console.log('Ground pipe: free ends that touch');
{
  const plant: PlantState = { components: new Map(), connections: [] } as unknown as PlantState;
  const groundPipe = (id: string, route: Point[]): PipeComponent => {
    const length = routeLength(route);
    const p: PipeComponent = {
      id, type: 'pipe', position: { ...route[0] }, endPosition: { ...route[route.length - 1] },
      rotation: 0, diameter: 0.3, thickness: 0.01, length, route, elevation: 0, endElevation: 0,
      ports: [
        { id: `${id}-left`, position: { x: 0, y: 0 }, direction: 'both' },
        { id: `${id}-right`, position: { x: length, y: 0 }, direction: 'both' },
      ],
    };
    plant.components.set(id, p);
    return p;
  };

  const a = groundPipe('pa', pipePieceRoute({ x: 10.5, y: 10.5 }, 'EW'));   // x 10..11
  check('a fresh piece has two free ends', pipeFreeEnds(a).length === 2);
  const ends = pipeFreeEnds(a);
  check('its ends face out along the pipe',
    ends.some(e => e.side === 'W' && near(e.point.x, 10)) && ends.some(e => e.side === 'E' && near(e.point.x, 11)),
    ends.map(e => `${e.side}@${e.point.x}`).join(' '));
  check('a lone piece touches nothing', findFreeEndJoins(plant, a).length === 0);

  // The next tile east, same rotation: the two ends are the same point
  const b = groundPipe('pb', pipePieceRoute({ x: 11.5, y: 10.5 }, 'EW'));
  const joins = findFreeEndJoins(plant, b);
  check('a piece laid end-on to another finds exactly one join', joins.length === 1,
    joins.map(j => j.join.port.id).join(','));
  check('and it is the neighbour end it touches', joins[0]?.join.port.id === 'pa-right', joins[0]?.join.port.id);

  // A piece one tile NORTH of A only shares a corner, not an end
  const c = groundPipe('pc', pipePieceRoute({ x: 11.5, y: 9.5 }, 'NS'));
  check('a piece round the corner does not join (its ends are elsewhere)',
    findFreeEndJoins(plant, c).every(j => j.join.port.id !== 'pa-right'),
    findFreeEndJoins(plant, c).map(j => j.join.port.id).join(','));
  plant.components.delete('pc');

  // A pump's east nozzle: a piece in the tile just outside it lands on the
  // very point the nozzle anchors to, and joins it.
  const pmp = pump('pump-1', 12.5, 10.5);   // 1 x 1 footprint, x 12..13
  plant.components.set(pmp.id, pmp);
  const outlet = portAnchors(pmp).find(x => x.port.id === 'pump-1-outlet')!;
  check('the pump outlet anchors on the middle of its east edge',
    outlet.side === 'E' && near(outlet.point.x, 13) && near(outlet.point.y, 10.5),
    `${outlet.side}@${outlet.point.x},${outlet.point.y}`);

  const d = groundPipe('pd', pipePieceRoute({ x: 13.5, y: 10.5 }, 'EW'));   // x 13..14
  const dWest = pipeFreeEnds(d).find(e => e.side === 'W')!;
  check('a piece whose end lands on a facing nozzle joins it',
    joinForFreeEnd(plant, dWest)?.port.id === 'pump-1-outlet',
    String(joinForFreeEnd(plant, dWest)?.port.id));
  check('and findFreeEndJoins reports exactly that one end',
    findFreeEndJoins(plant, d).length === 1 &&
    findFreeEndJoins(plant, d)[0].join.port.id === 'pump-1-outlet');

  // A port already in use is not grabbed
  pmp.ports.find(p => p.id === 'pump-1-outlet')!.connectedTo = 'somewhere';
  check('a nozzle that is already piped is not joined', joinForFreeEnd(plant, dWest) === null);
  pmp.ports.find(p => p.id === 'pump-1-outlet')!.connectedTo = undefined;

  // Facing matters: an end pointing the same way as the nozzle is not a join
  const wrongWay = { component: d, port: d.ports[0], point: { ...outlet.point }, side: 'E' as const };
  check('an end facing the same way as the nozzle is not a join', joinForFreeEnd(plant, wrongWay) === null);

  // A pipe two tiles away shares nothing
  const far = groundPipe('pf', pipePieceRoute({ x: 20.5, y: 20.5 }, 'EW'));
  check('a piece nowhere near anything joins nothing', findFreeEndJoins(plant, far).length === 0);
}

console.log('\nCross-vessel welds');
{
  // A duct laid wall to wall between vessel A (x -2..2) and vessel B (x 8..12);
  // A stands inside a wider ring of panels on the same centre, and B holds a
  // bundle. A second duct touching nothing names a pump as its target.
  const a = tank('ta', 0, 0, 4, 10);
  const ring = tank('ring', 0, 0, 8, 10);
  const b = tank('tb', 10, 0, 4, 10);
  const bundle: any = { ...tank('bundle', 10, 0, 2, 4), containedBy: 'tb', elevation: 3 };
  const p = pump('pp', 20, 0);
  const duct = (id: string, x: number, length: number, target?: string): any => ({
    id, type: 'crossVessel', position: { x, y: 0 }, rotation: 0, elevation: 4,
    length, outerDiameter: 1.5, wallThickness: 0.05, innerDiameter: 0.8, innerWallThickness: 0.02,
    pressureRating: 90, orientation: 'horizontal', targetComponentId: target,
    ports: [
      { id: `${id}-in`, position: { x: -length / 2, y: 0 }, direction: 'both' },
      { id: `${id}-out`, position: { x: length / 2, y: 0 }, direction: 'both' },
      { id: `${id}-annulus`, position: { x: length / 2, y: 0.5 }, direction: 'both' },
    ],
  });
  const cv = duct('cv', 5, 6, 'bundle');
  const cv2 = duct('cv2', 30, 2, 'pp');
  const plant: PlantState = {
    components: new Map<string, any>([[a.id, a], [ring.id, ring], [b.id, b], [bundle.id, bundle], [p.id, p], [cv.id, cv], [cv2.id, cv2]]),
    connections: [], simTime: 0, simSpeed: 1, isPaused: true,
  };
  const mates = crossVesselMates(cv, plant).map(c => c.id);
  check('a duct is welded to the vessel at each end', mates.length === 2 && mates.includes('ta') && mates.includes('tb'), mates.join(','));
  check('the end inside a ring of panels mates with the vessel, not the ring', !mates.includes('ring'));
  const flush = crossVesselJoint({ fromComponentId: 'cv', fromPortId: 'cv-in', toComponentId: 'ta', toPortId: 'ta-right' }, plant);
  check('a line to the vessel itself is flush at the weld', flush?.kind === 'flush' && flush.mate.id === 'ta');
  const inside = crossVesselJoint({ fromComponentId: 'bundle', fromPortId: 'bundle-top', toComponentId: 'cv', toPortId: 'cv-out' }, plant);
  check('a line from inside a welded vessel runs inside it (even to the named target)',
    inside?.kind === 'inside' && inside.mate.id === 'tb' && inside.crossVesselPortId === 'cv-out' && inside.otherPortId === 'bundle-top');
  check('a line to anything else is not a weld',
    crossVesselJoint({ fromComponentId: 'pp', fromPortId: 'pp-outlet', toComponentId: 'cv', toPortId: 'cv-annulus' }, plant) === null);
  check('a duct touching nothing is welded to nothing, not even its named target',
    crossVesselMates(cv2, plant).length === 0 &&
    crossVesselJoint({ fromComponentId: 'pp', fromPortId: 'pp-outlet', toComponentId: 'cv2', toPortId: 'cv2-in' }, plant) === null);
  // The annulus nozzle (0.5 m off the axis of a 1.5 m duct standing at 4 m,
  // axis at 4.75 m) is DRAWN on the side facing its partner
  const ann = cv.ports.find((p: any) => p.id === 'cv-annulus');
  check('an annulus nozzle is drawn on top for a partner above the axis', near(annulusNozzleDrawElevation(cv, ann, 6), 0.75 + 0.5));
  check('...and underneath for one below it', near(annulusNozzleDrawElevation(cv, ann, 3), 0.75 - 0.5));
  check('...whichever way the port was stored', near(annulusNozzleDrawElevation(cv, { position: { y: -0.5 } }, 3), 0.25));
  // ...while the line itself is stored (and simulated) at the axis
  // (the pump stands at grade; its end of the line is 6 m up, above the 4.75 m axis)
  const annLine: Connection = { fromComponentId: 'pp', fromPortId: 'pp-outlet', toComponentId: 'cv', toPortId: 'cv-annulus',
    fromElevation: 6, toElevation: 0.75 };
  check('a line stored at the annulus axis is drawn on the side facing its partner',
    near(connectionDrawElevation(annLine, 'to', plant.components), 1.25) && near(annLine.toElevation!, 0.75),
    `drawn at ${connectionDrawElevation(annLine, 'to', plant.components)}`);
  check('...and the other end of it is drawn where it is stored', near(connectionDrawElevation(annLine, 'from', plant.components), 6));
}

if (failures > 0) {
  console.error(`\n${failures} grid geometry check(s) failed`);
  process.exit(1);
}
console.log('\nAll grid geometry checks passed');
