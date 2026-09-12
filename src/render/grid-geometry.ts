/**
 * Grid-view geometry: the tile lattice, component footprints, connection
 * points on footprint edges, and orthogonal pipe routes.
 *
 * Everything here is pure (no canvas, no DOM) so it can be exercised
 * headlessly (scripts/test-grid-geometry.ts). World coordinates stay in
 * metres in the plan (x east, y south, as in the other views); the grid is a
 * TILE_M lattice on those same coordinates, so nothing about a plant changes
 * when it is viewed on the grid - only where new things snap to and how the
 * pipes between them are drawn.
 *
 * Conventions:
 *  - A cell (i, j) covers [i, i+1) x [j, j+1) tiles; its centre is
 *    (i + 0.5, j + 0.5). Pipe routes run through cell centres.
 *  - A footprint is w x d whole tiles; its centre is the component's
 *    `position`, so odd footprints centre on a cell and even ones on a
 *    lattice corner (snapCenter enforces this).
 *  - A port anchors on the midpoint of one footprint edge cell, facing one
 *    of the four grid sides. The route into or out of that port passes
 *    through the cell just outside that edge (the port's "out" cell).
 *  - Automatic routes are found by a search over cells that steers around
 *    the footprints of standing equipment (searchRoute); drawn routes are
 *    kept as drawn. Where several runs share a cell they are laid side by
 *    side for drawing (laneOffsetRoutes) - the stored geometry is unchanged.
 */
import { Point, PlantComponent, Port, Connection, PlantState, PipeComponent, waterBodyOf, connectionDrawElevation } from '../types';
import { getComponentSize, getDefaultComponentSize } from './component-size';

/** Tile edge length in metres. World coordinates are metres, so this is also the lattice pitch. */
export const TILE_M = 1;

export type Side = 'N' | 'E' | 'S' | 'W';

/** Footprint in whole tiles. */
export interface Footprint {
  w: number;
  d: number;
}

/** Axis-aligned plan rectangle in metres. */
export interface PlanRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PortAnchor {
  port: Port;
  /** Where the pipe meets the component: an edge-cell midpoint for footprint components, a route end for pipes. */
  point: Point;
  side: Side;
  /** Cell centre one tile outward from `point` (undefined for pipe ends, which routes meet directly). */
  out?: Point;
  /**
   * Set on a nozzle on the top or bottom of its component, for a connection
   * (verticalNozzle): `point` is then where the nozzle stands in plan, inside
   * the footprint, the pipe leaves it upward or downward rather than through
   * a side, and `side` only says which way its partner lies.
   */
  vertical?: 'up' | 'down';
}

const EPS = 1e-6;

export function sideVector(side: Side): Point {
  switch (side) {
    case 'N': return { x: 0, y: -1 };
    case 'S': return { x: 0, y: 1 };
    case 'E': return { x: 1, y: 0 };
    case 'W': return { x: -1, y: 0 };
  }
}

export function oppositeSide(side: Side): Side {
  return side === 'N' ? 'S' : side === 'S' ? 'N' : side === 'E' ? 'W' : 'E';
}

/** The grid side a plan direction vector mostly points to. */
export function sideOfVector(dx: number, dy: number): Side {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'E' : 'W';
  return dy >= 0 ? 'S' : 'N';
}

// ---------------------------------------------------------------------------
// Footprints
// ---------------------------------------------------------------------------

const CYLINDRICAL_UPRIGHT = new Set(['tank', 'vessel', 'reactorVessel', 'coreBarrel']);
const PLAN_NATIVE = new Set(['building', 'switchyard', 'warehouse']);
const ONE_TILE = new Set(['pump', 'valve', 'controller', 'breaker']);

function tiles(metres: number): number {
  return Math.max(1, Math.ceil(metres / TILE_M - EPS));
}

/**
 * Whole-tile footprint of a component. Front-view drawings (turbines,
 * condensers, horizontal heat exchangers, ...) have no plan depth of their
 * own; they get the smaller of their two drawn dimensions, which keeps a long
 * low condenser a long thin footprint and a boxy thing square.
 */
export function footprintFromSize(type: string, size: { width: number; height: number }): Footprint {
  if (ONE_TILE.has(type)) return { w: 1, d: 1 };
  if (PLAN_NATIVE.has(type)) return { w: tiles(size.width), d: tiles(size.height) };
  if (CYLINDRICAL_UPRIGHT.has(type) || type === 'pool') {
    // Cylinders and the (square) spent-fuel pool are as deep in plan as they
    // are wide; a pool's drawn `height` is its DEPTH, not a plan dimension.
    const w = tiles(size.width);
    return { w, d: w };
  }
  if (type === 'heatExchanger' && size.height > size.width) {
    // Vertical shell: a cylinder standing on end
    const w = tiles(size.width);
    return { w, d: w };
  }
  return { w: tiles(size.width), d: tiles(Math.min(size.width, size.height)) };
}

export function componentFootprint(component: PlantComponent): Footprint {
  return footprintFromSize(component.type, getComponentSize(component));
}

/**
 * Things that ARE the ground where they stand: a building's floor, a
 * switchyard's apron, a pool (a hole in it), a warehouse yard, and a tank
 * that is really a body of open water. They get no foundation pad; every
 * other component except a pipe stands on one, in both views.
 */
export function isGroundLayerComponent(component: PlantComponent): boolean {
  return component.type === 'building' || component.type === 'switchyard' ||
    component.type === 'pool' || component.type === 'warehouse' ||
    waterBodyOf(component as never) !== undefined;
}

// ---------------------------------------------------------------------------
// Cross-vessels
// ---------------------------------------------------------------------------

/** Whether a component is drawn standing (a sprite others can be drawn inside) rather than as a floor or a line. */
function isStandingSprite(c: PlantComponent): boolean {
  return c.type !== 'pipe' && !(c as any).isHydraulicOnly && !isGroundLayerComponent(c);
}

/** Whether a component is drawn inside another standing one (a vessel) rather than on the plan. */
function isInsideStandingSprite(c: PlantComponent, plantState: PlantState): boolean {
  const seen = new Set<string>([c.id]);
  let cur: PlantComponent | undefined = c;
  while (cur?.containedBy && !seen.has(cur.containedBy)) {
    seen.add(cur.containedBy);
    cur = plantState.components.get(cur.containedBy);
    if (cur && isStandingSprite(cur)) return true;
  }
  return false;
}

/**
 * The vessels a cross-vessel is welded to. A cross-vessel is a protrusion of
 * a vessel's pressure boundary laid wall to wall (types.ts), so each of its
 * two ends mates with the vessel it butts against: a component standing on
 * the plan whose footprint holds that end and whose drawn height spans the
 * duct's axis. Where several do (a vessel inside the ring of panels around
 * it), the end mates with the one whose side wall it is nearest.
 */
export function crossVesselMates(cv: PlantComponent, plantState: PlantState): PlantComponent[] {
  const size = getComponentSize(cv);
  const axisZ = (cv.elevation ?? 0) + size.height / 2;
  const y = cv.position.y;
  const mates: PlantComponent[] = [];
  for (const endX of [cv.position.x - size.width / 2, cv.position.x + size.width / 2]) {
    let best: PlantComponent | null = null;
    let bestGap = Infinity;
    for (const c of plantState.components.values()) {
      if (c === cv || c.type === 'crossVessel' || !isStandingSprite(c) || isInsideStandingSprite(c, plantState)) continue;
      const base = c.elevation ?? 0;
      const width = getComponentSize(c).width;
      if (axisZ < base || axisZ > base + getComponentSize(c).height) continue;
      const r = footprintRect(c.position, componentFootprint(c));
      if (endX < r.x0 - EPS || endX > r.x1 + EPS || y < r.y0 - EPS || y > r.y1 + EPS) continue;
      const face = c.position.x + Math.sign(endX - c.position.x) * width / 2;
      const gap = Math.abs(endX - face);
      if (gap < bestGap) { best = c; bestGap = gap; }
    }
    if (best && !mates.includes(best)) mates.push(best);
  }
  return mates;
}

/**
 * How a connection to a cross-vessel meets it, when the other end is at a
 * vessel the duct is welded to (crossVesselMates):
 *  - 'flush': the other end IS that vessel. The two nozzles meet at the weld
 *    and there is no line between them to draw.
 *  - 'inside': the other end is held (at any depth) inside that vessel. The
 *    line runs inside the vessel, to the wall the duct enters by, and no
 *    further.
 * Null for any other connection - including one to a duct's
 * `targetComponentId` when the duct is not drawn touching it (the 2.5D view
 * keeps its own convention for that; the grid routes such a line as usual).
 */
export interface CrossVesselJoint {
  crossVessel: PlantComponent;
  crossVesselPortId: string;
  other: PlantComponent;
  otherPortId: string;
  mate: PlantComponent;
  kind: 'flush' | 'inside';
  /** Where the line is drawn meeting the duct, above its bottom (connectionDrawElevation: an annulus line on the side facing its partner). */
  crossVesselDrawElevation: number;
}

export function crossVesselJoint(conn: Connection, plantState: PlantState): CrossVesselJoint | null {
  const from = plantState.components.get(conn.fromComponentId);
  const to = plantState.components.get(conn.toComponentId);
  if (!from || !to) return null;
  const cvIsFrom = from.type === 'crossVessel';
  if (!cvIsFrom && to.type !== 'crossVessel') return null;
  const cv = cvIsFrom ? from : to;
  const other = cvIsFrom ? to : from;
  const joint = (mate: PlantComponent, kind: 'flush' | 'inside'): CrossVesselJoint => ({
    crossVessel: cv, crossVesselPortId: cvIsFrom ? conn.fromPortId : conn.toPortId,
    other, otherPortId: cvIsFrom ? conn.toPortId : conn.fromPortId, mate, kind,
    crossVesselDrawElevation: connectionDrawElevation(conn, cvIsFrom ? 'from' : 'to', plantState.components),
  });
  const mates = crossVesselMates(cv, plantState);
  const seen = new Set<string>();
  let cur: PlantComponent | undefined = other;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (mates.includes(cur)) return joint(cur, cur === other ? 'flush' : 'inside');
    cur = cur.containedBy ? plantState.components.get(cur.containedBy) : undefined;
  }
  return null;
}

/** Footprint for a palette type (placement preview, before the component exists). */
export function footprintForType(componentType: string): Footprint {
  const size = getDefaultComponentSize(componentType);
  const storedType: Record<string, string> = {
    'reactor-vessel': 'reactorVessel', 'pressurizer': 'tank', 'core': 'coreBarrel',
    'heat-exchanger': 'heatExchanger', 'check-valve': 'valve', 'relief-valve': 'valve',
    'porv': 'valve', 'scram-controller': 'controller', 'pid-controller': 'controller',
    'cross-vessel': 'crossVessel',
    'pool': 'pool',
  };
  return footprintFromSize(storedType[componentType] ?? componentType, size);
}

/** Snap a footprint centre so the footprint lands on whole tiles. */
export function snapCenter(pos: Point, fp: Footprint): Point {
  const halfW = fp.w * TILE_M / 2;
  const halfD = fp.d * TILE_M / 2;
  return {
    x: Math.round((pos.x - halfW) / TILE_M) * TILE_M + halfW,
    y: Math.round((pos.y - halfD) / TILE_M) * TILE_M + halfD,
  };
}

export function footprintRect(center: Point, fp: Footprint): PlanRect {
  const halfW = fp.w * TILE_M / 2;
  const halfD = fp.d * TILE_M / 2;
  return { x0: center.x - halfW, y0: center.y - halfD, x1: center.x + halfW, y1: center.y + halfD };
}

export function rectsOverlap(a: PlanRect, b: PlanRect): boolean {
  return a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;
}

/** Centre of the cell containing a plan point. */
export function cellCenter(p: Point): Point {
  return {
    x: (Math.floor(p.x / TILE_M) + 0.5) * TILE_M,
    y: (Math.floor(p.y / TILE_M) + 0.5) * TILE_M,
  };
}

export function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
}

// ---------------------------------------------------------------------------
// Port anchors
// ---------------------------------------------------------------------------

/**
 * Which footprint side a port faces, from its position in the component's
 * front-view frame (x lateral, y vertical, negative up). Lateral ports go
 * east/west; a port on top of the drawing leaves from the back (north) of
 * the footprint and one on the bottom from the front (south) - the same
 * reading the 3/4-view sprite gives, whose top is drawn up-screen.
 */
export function portSide(port: Port, size: { width: number; height: number }): Side {
  // A nozzle that points at or away from the viewer projects onto the
  // centreline, so its front-view position cannot say which side it is on.
  // Those nozzles declare their side (see Port.planSide).
  if (port.planSide) return port.planSide;
  const nx = size.width > 0 ? port.position.x / (size.width / 2) : 0;
  const ny = size.height > 0 ? port.position.y / (size.height / 2) : 0;
  if (Math.abs(nx) < EPS && Math.abs(ny) < EPS) return 'S';
  if (Math.abs(nx) >= Math.abs(ny)) return nx < 0 ? 'W' : 'E';
  return ny < 0 ? 'N' : 'S';
}

function edgeCellIndex(normalized: number, count: number): number {
  const t = Math.max(-1, Math.min(1, normalized));
  return Math.max(0, Math.min(count - 1, Math.round(((t + 1) / 2) * (count - 1))));
}

/**
 * Anchors for every port of a footprint component. Two ports that land on
 * the same edge cell are spread along that edge (in port order), so every
 * connection point is its own cell and can be clicked and piped separately.
 */
function footprintPortAnchors(component: PlantComponent): PortAnchor[] {
  const size = getComponentSize(component);
  const fp = componentFootprint(component);
  const rect = footprintRect(component.position, fp);
  const taken = new Map<string, Set<number>>();
  const anchors: PortAnchor[] = [];

  for (const port of component.ports) {
    const side = portSide(port, size);
    const alongCount = side === 'N' || side === 'S' ? fp.w : fp.d;
    const normalized = side === 'N' || side === 'S'
      ? (size.width > 0 ? port.position.x / (size.width / 2) : 0)
      : (size.height > 0 ? port.position.y / (size.height / 2) : 0);
    let k = edgeCellIndex(normalized, alongCount);

    // Spread ports that collide on one edge cell to the nearest free cell
    let used = taken.get(side);
    if (!used) { used = new Set(); taken.set(side, used); }
    if (used.has(k)) {
      let found = -1;
      for (let step = 1; step < alongCount && found < 0; step++) {
        if (k + step < alongCount && !used.has(k + step)) found = k + step;
        else if (k - step >= 0 && !used.has(k - step)) found = k - step;
      }
      if (found >= 0) k = found; // else the edge is full: share the cell
    }
    used.add(k);

    let point: Point;
    switch (side) {
      case 'N': point = { x: rect.x0 + (k + 0.5) * TILE_M, y: rect.y0 }; break;
      case 'S': point = { x: rect.x0 + (k + 0.5) * TILE_M, y: rect.y1 }; break;
      case 'W': point = { x: rect.x0, y: rect.y0 + (k + 0.5) * TILE_M }; break;
      case 'E': point = { x: rect.x1, y: rect.y0 + (k + 0.5) * TILE_M }; break;
    }
    const v = sideVector(side);
    const out = { x: point.x + v.x * TILE_M / 2, y: point.y + v.y * TILE_M / 2 };
    anchors.push({ port, point, side, out });
  }
  return anchors;
}

/** The plan polyline a pipe component is drawn along. */
export function pipeRoute(pipe: PipeComponent): Point[] {
  if (pipe.route && pipe.route.length >= 2) return pipe.route;
  const start = { x: pipe.position.x, y: pipe.position.y };
  if (pipe.endPosition) {
    const end = { x: pipe.endPosition.x, y: pipe.endPosition.y };
    if (samePoint(start, end)) return [start, end];
    return manhattanPath(start, end, 'x');
  }
  // Legacy pipe without endpoint data: its rotation is a plan angle
  const end = {
    x: pipe.position.x + pipe.length * Math.cos(pipe.rotation),
    y: pipe.position.y + pipe.length * Math.sin(pipe.rotation),
  };
  return manhattanPath(start, end, 'x');
}

function pipePortAnchors(pipe: PipeComponent): PortAnchor[] {
  const route = pipeRoute(pipe);
  const first = route[0];
  const last = route[route.length - 1];
  // Side = the direction the pipe end points away from the pipe body
  const seg = (a: Point, b: Point): Side => {
    const dx = a.x - b.x, dy = a.y - b.y;
    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return 'E';
    return sideOfVector(dx, dy);
  };
  return pipe.ports.map(port => {
    const atEnd = port.position.x > pipe.length / 2;
    return atEnd
      ? { port, point: last, side: seg(last, route[route.length - 2]) }
      : { port, point: first, side: seg(first, route[1]) };
  });
}

export function portAnchors(component: PlantComponent): PortAnchor[] {
  if (component.type === 'pipe') return pipePortAnchors(component as PipeComponent);
  return footprintPortAnchors(component);
}

export function portAnchor(component: PlantComponent, portId: string): PortAnchor | null {
  return portAnchors(component).find(a => a.port.id === portId) ?? null;
}

/** Upright cylinders whose side nozzles are drawn on whichever side faces the partner (as the 2.5D view does). */
const MIRRORS_LATERAL_PORTS = new Set(['tank', 'vessel', 'reactorVessel', 'coreBarrel']);

/**
 * Whether a port is a vertical nozzle - on the top or bottom of a standing
 * component's drawing (a vessel head, a turbine's steam inlet, a pump's
 * suction) - and which way it points. Such a nozzle is not on any side of
 * the footprint: the pipe leaves it upward or downward from where it stands
 * over the plan, and can head from there whichever way its partner lies.
 * A nozzle that declares a plan side is a side nozzle; floors (buildings,
 * pools) and pipes have no drawn top or bottom.
 */
export function verticalNozzle(component: PlantComponent, portId: string): 'up' | 'down' | null {
  if (!isStandingSprite(component)) return null;
  const port = component.ports?.find(p => p.id === portId);
  if (!port || port.planSide) return null;
  const size = getComponentSize(component);
  const nx = size.width > 0 ? port.position.x / (size.width / 2) : 0;
  const ny = size.height > 0 ? port.position.y / (size.height / 2) : 0;
  // The same reading portSide makes: lateral wins a tie
  if (Math.abs(ny) <= Math.abs(nx)) return null;
  return ny < 0 ? 'up' : 'down';
}

const SIDES: Side[] = ['N', 'E', 'S', 'W'];
const turnSide = (side: Side, quarterTurns: number): Side => SIDES[(SIDES.indexOf(side) + quarterTurns) % 4];

/**
 * The plan sides of an inline valve's two nozzles, with the valve turned to
 * suit its piping. The nozzles are opposite each other, but which pair of
 * footprint sides they stand on is how the valve was installed, not
 * something the front-view drawing can say: of the four ways round, the one
 * whose nozzles point most directly at what each connects to (the sum of
 * the cosines, over the nozzles `refOf` gives a partner for). The drawn
 * arrangement wins a tie, so a valve with nothing connected, or piped
 * straight through as drawn, stays as it is. Null for anything that is not
 * a two-nozzle valve with opposite nozzles.
 */
export function turnedValveSides(valve: PlantComponent, refOf: (portId: string) => Point | null): Map<string, Side> | null {
  if (valve.type !== 'valve' || valve.ports?.length !== 2) return null;
  const size = getComponentSize(valve);
  const drawn = valve.ports.map(p => portSide(p, size));
  if (drawn[0] !== oppositeSide(drawn[1])) return null;
  const toward = valve.ports.map(p => {
    const ref = refOf(p.id);
    if (!ref) return null;
    const dx = ref.x - valve.position.x, dy = ref.y - valve.position.y;
    const len = Math.hypot(dx, dy);
    return len > EPS ? { x: dx / len, y: dy / len } : null;
  });
  let best = 0;
  let bestScore = -Infinity;
  for (let k = 0; k < 4; k++) {
    let score = 0;
    for (let i = 0; i < 2; i++) {
      const u = toward[i];
      if (!u) continue;
      const v = sideVector(turnSide(drawn[i], k));
      score += v.x * u.x + v.y * u.y;
    }
    if (score > bestScore + EPS) { best = k; bestScore = score; }
  }
  return new Map(valve.ports.map((p, i) => [p.id, turnSide(drawn[i], best)]));
}

/** The far end of the connection on a port: the partner component and its port (null when unconnected or open to the air). */
export function portPartner(plantState: PlantState, component: PlantComponent, portId: string): { partner: PlantComponent; partnerPortId: string } | null {
  for (const k of plantState.connections) {
    if (k.fromComponentId === component.id && k.fromPortId === portId) {
      const partner = plantState.components.get(k.toComponentId);
      return partner ? { partner, partnerPortId: k.toPortId } : null;
    }
    if (k.toComponentId === component.id && k.toPortId === portId) {
      const partner = plantState.components.get(k.fromComponentId);
      return partner ? { partner, partnerPortId: k.fromPortId } : null;
    }
  }
  return null;
}

/**
 * The obstacles a run steers round: a vertical nozzle's own footprint is not
 * in its way, since the pipe leaves over the top of it (or under the bottom).
 */
export function obstaclesForRun(obstacles: Obstacle[], ends: Array<{ id: string; anchor: PortAnchor } | null>): Obstacle[] {
  const own = new Set(ends.filter(e => e?.anchor.vertical).map(e => e!.id));
  return own.size > 0 ? obstacles.filter(o => !own.has(o.id)) : obstacles;
}

/**
 * A port's anchor for a connection to a partner at `partnerRef`. A vessel's
 * side nozzle is not on a fixed side of the tank in this model - the drawing
 * puts it on the side facing whatever it connects to - so an east/west port
 * of an upright cylinder is mirrored to the edge facing the partner. A
 * vertical nozzle (verticalNozzle) has no side: its anchor is where it stands
 * over the plan. Other components keep their stored side.
 */
export function portAnchorFacing(component: PlantComponent, portId: string, partnerRef: Point): PortAnchor | null {
  const vertical = verticalNozzle(component, portId);
  if (vertical) {
    const port = component.ports.find(p => p.id === portId)!;
    const point = { x: component.position.x + port.position.x, y: component.position.y };
    return { port, point, side: sideOfVector(partnerRef.x - point.x, partnerRef.y - point.y), vertical };
  }
  const a = portAnchor(component, portId);
  // A nozzle that names its own side stays on it - the whole point of
  // declaring a side is that the drawing does not get to move it.
  if (!a || a.port.planSide || !MIRRORS_LATERAL_PORTS.has(component.type)) return a;
  if (a.side !== 'E' && a.side !== 'W') return a;
  const dx = partnerRef.x - component.position.x;
  if (Math.abs(dx) < EPS) return a;
  const wantSide: Side = dx > 0 ? 'E' : 'W';
  if (a.side === wantSide) return a;
  const rect = footprintRect(component.position, componentFootprint(component));
  const point = { x: wantSide === 'E' ? rect.x1 : rect.x0, y: a.point.y };
  const v = sideVector(wantSide);
  return { port: a.port, point, side: wantSide, out: { x: point.x + v.x * TILE_M / 2, y: point.y } };
}

/** The point a partner's route comes from: a pipe's end, otherwise the component centre. */
export function partnerReference(component: PlantComponent, portId: string): Point {
  if (component.type === 'pipe') {
    const a = portAnchor(component, portId);
    if (a) return a.point;
  }
  return component.position;
}

/** The footprint side of `container` that faces a plan point (east on a tie). */
export function sideFacing(container: PlantComponent, ref: Point): Side {
  return sideOfVector(ref.x - container.position.x, ref.y - container.position.y);
}

/**
 * Where a line to something INSIDE a container meets the container's wall in
 * plan: the edge cell on `side` nearest `along`. A contained component's own
 * port is drawn on its container's sprite (the section view), so the plan
 * lattice only ever sees the container's wall; the penetration is put on the
 * side facing the partner, the same rule a vessel's mirrored side nozzles
 * follow (portAnchorFacing).
 */
export function wallAnchor(container: PlantComponent, port: Port, side: Side, along: Point): PortAnchor {
  const fp = componentFootprint(container);
  const rect = footprintRect(container.position, fp);
  const clampIndex = (raw: number, count: number) => Math.max(0, Math.min(count - 1, Math.floor(raw)));
  let point: Point;
  if (side === 'E' || side === 'W') {
    const k = clampIndex((along.y - rect.y0) / TILE_M, fp.d);
    point = { x: side === 'E' ? rect.x1 : rect.x0, y: rect.y0 + (k + 0.5) * TILE_M };
  } else {
    const k = clampIndex((along.x - rect.x0) / TILE_M, fp.w);
    point = { x: rect.x0 + (k + 0.5) * TILE_M, y: side === 'N' ? rect.y0 : rect.y1 };
  }
  const v = sideVector(side);
  return { port, point, side, out: { x: point.x + v.x * TILE_M / 2, y: point.y + v.y * TILE_M / 2 } };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Straight or single-bend orthogonal path from a to b (inclusive of both). */
export function manhattanPath(from: Point, to: Point, firstAxis: 'x' | 'y' = 'x'): Point[] {
  if (Math.abs(from.x - to.x) < EPS || Math.abs(from.y - to.y) < EPS) return [from, to];
  const corner = firstAxis === 'x' ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
  return [from, corner, to];
}

/** Drop repeated points and interior collinear vertices. */
export function simplifyRoute(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    if (out.length > 0 && samePoint(out[out.length - 1], p)) continue;
    out.push(p);
  }
  let changed = true;
  while (changed && out.length >= 3) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1], b = out[i], c = out[i + 1];
      const abx = b.x - a.x, aby = b.y - a.y, bcx = c.x - b.x, bcy = c.y - b.y;
      const collinear = Math.abs(abx * bcy - aby * bcx) < EPS;
      if (collinear) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

export function routeLength(pts: Point[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

/** Axis to leave a point along so the first segment continues out of the port. */
function leaveAxis(side: Side): 'x' | 'y' {
  return side === 'E' || side === 'W' ? 'x' : 'y';
}

/**
 * Path from a point that was reached travelling along `prevDir` (or from a
 * port facing `side`) to a target. Prefers to keep going straight before
 * bending, which is what a person laying pipe along a grid expects.
 */
function pathPreferringAxis(from: Point, to: Point, axis: 'x' | 'y'): Point[] {
  return manhattanPath(from, to, axis);
}

/**
 * The full route between two ports when nobody has drawn one: out of the
 * first port, then between the two out-cells - steering around other
 * equipment when the obstacles are given, a single bend otherwise - and
 * into the second.
 */
export function autoRoute(a: PortAnchor, b: PortAnchor, obstacles?: Obstacle[]): Point[] {
  if (obstacles) {
    const direct = directRoute(a, b, obstacles);
    if (direct) return direct;
  }
  const pts: Point[] = [a.point];
  if (a.out) pts.push(a.out);
  const start = pts[pts.length - 1];
  const end = b.out ?? b.point;
  const middle = obstacles
    ? searchRoute(start, end, obstacles, sideVector(a.side), b.out ? sideVector(oppositeSide(b.side)) : undefined)
    : pathPreferringAxis(start, end, leaveAxis(a.side));
  pts.push(...middle.slice(1));
  if (b.out) pts.push(b.point);
  return simplifyRoute(pts);
}

/**
 * The plain way between two nozzles, when there is one: a straight run, or
 * one bend, that leaves the first through its face and enters the second
 * through its face without crossing any equipment. It needs no lattice, so
 * two nozzles that line up are joined by a line that lines up, whatever
 * cells their footprints happen to sit on. A vertical nozzle has no face and
 * may be left or entered in any direction. Null when no such path is clear.
 */
function directRoute(a: PortAnchor, b: PortAnchor, obstacles: Obstacle[]): Point[] | null {
  const along = (d: Point, v: Point) => Math.abs(d.x - v.x) < EPS && Math.abs(d.y - v.y) < EPS;
  const leaves = (d: Point) => a.vertical !== undefined || along(d, sideVector(a.side));
  const enters = (d: Point) => b.vertical !== undefined || along(d, sideVector(oppositeSide(b.side)));
  const p = a.point, q = b.point;
  const candidates: Point[][] = [];
  if (Math.abs(p.x - q.x) < EPS || Math.abs(p.y - q.y) < EPS) {
    candidates.push([p, q]);
  } else {
    const xFirst = [p, { x: q.x, y: p.y }, q];
    const yFirst = [p, { x: p.x, y: q.y }, q];
    candidates.push(...(a.vertical === undefined && leaveAxis(a.side) === 'y' ? [yFirst, xFirst] : [xFirst, yFirst]));
  }
  for (const path of candidates) {
    let clear = true;
    for (let i = 1; i < path.length && clear; i++) {
      const len = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
      const d = len > EPS ? { x: (path[i].x - path[i - 1].x) / len, y: (path[i].y - path[i - 1].y) / len } : { x: 0, y: 0 };
      if (i === 1 && !leaves(d)) clear = false;
      if (i === path.length - 1 && !enters(d)) clear = false;
      if (clear && segmentCrossesObstacle(path[i - 1], path[i], obstacles)) clear = false;
    }
    if (clear) return path;
  }
  return null;
}

/** Whether an axis-aligned segment passes through the inside of any obstacle (running along an edge does not). */
function segmentCrossesObstacle(p: Point, q: Point, obstacles: Obstacle[]): boolean {
  const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x, q.x);
  const y0 = Math.min(p.y, q.y), y1 = Math.max(p.y, q.y);
  return obstacles.some(o => x1 > o.x0 + EPS && x0 < o.x1 - EPS && y1 > o.y0 + EPS && y0 < o.y1 - EPS);
}

// ---------------------------------------------------------------------------
// Obstacle-avoiding search
// ---------------------------------------------------------------------------

/** A footprint an automatic route should not cut through. */
export interface Obstacle extends PlanRect {
  id: string;
}

/**
 * What an automatic route steers around: the footprints of standing
 * equipment. Pipes are runs, not obstacles, and a building is a floor
 * others stand on, so pipes run through it freely.
 */
export function routeObstacles(plantState: PlantState): Obstacle[] {
  const out: Obstacle[] = [];
  for (const c of plantState.components.values()) {
    // Open water is not standing equipment: a pipe crosses it, it does not
    // have to go round the sea.
    if ((c as any).isHydraulicOnly || c.type === 'pipe' || c.type === 'building' ||
        waterBodyOf(c as never)) continue;
    out.push({ id: c.id, ...footprintRect(c.position, componentFootprint(c)) });
  }
  return out;
}

/** A string that changes whenever the obstacle set does (route cache key). */
export function obstaclesKey(obstacles: Obstacle[]): string {
  return obstacles.map(o => `${o.id}:${o.x0},${o.y0},${o.x1},${o.y1}`).join(';');
}

/** Extra cost per cell of cutting through equipment. Finite, so a route from a port inside a footprint still exists. */
const OBSTACLE_PENALTY = 12;
/** Extra cost per bend, so a route runs straight where it can. */
const BEND_PENALTY = 1.5;
/** Cells of slack around the endpoints' bounding box the search may use to go round things. */
const SEARCH_MARGIN = 8;

function cellPenalty(cx: number, cy: number, obstacles: Obstacle[]): number {
  for (const o of obstacles) {
    if (cx > o.x0 && cx < o.x1 && cy > o.y0 && cy < o.y1) return OBSTACLE_PENALTY;
  }
  return 0;
}

class MinHeap<T> {
  private items: Array<{ k: number; v: T }> = [];
  get size(): number { return this.items.length; }
  push(k: number, v: T): void {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): T {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.v;
  }
}

const DIRS: Point[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

/**
 * Orthogonal path between two points over a cell lattice (A* with a bend
 * penalty), avoiding obstacle footprints where it can.
 *
 * The lattice is laid from `start`: its cells are centred on the start
 * point, so the run leaves it on a lattice line whatever cells the
 * footprints sit on (a component centred on a whole metre with an odd-sized
 * footprint has its edge cells centred on whole metres; one centred on a
 * half metre, on halves). The end need not be on that lattice. The search
 * stops at the last cell short of it and a square join finishes the run:
 * across onto the end's line, then in along `endDir` (the direction the run
 * must arrive travelling in, which the search also arrives on) - so the join
 * never doubles back. Without an `endDir` the join carries straight on where
 * it can. Never fails: obstacles only cost, so a port inside a footprint
 * still gets a route - out through the wall.
 */
export function searchRoute(start: Point, end: Point, obstacles: Obstacle[], startDir?: Point, endDir?: Point): Point[] {
  const at = (i: number, j: number): Point => ({ x: start.x + i * TILE_M, y: start.y + j * TILE_M });
  const fx = (end.x - start.x) / TILE_M, fy = (end.y - start.y) / TILE_M;
  // The goal cell: along the arrival direction, the last lattice line short
  // of the end; across it (or with no arrival direction), the nearest
  const shortOf = (f: number, d: number) => d > EPS ? Math.floor(f + EPS) : d < -EPS ? Math.ceil(f - EPS) : Math.round(f);
  const ei = endDir ? shortOf(fx, endDir.x) : Math.round(fx);
  const ej = endDir ? shortOf(fy, endDir.y) : Math.round(fy);
  const x0 = Math.min(0, ei) - SEARCH_MARGIN, x1 = Math.max(0, ei) + SEARCH_MARGIN;
  const y0 = Math.min(0, ej) - SEARCH_MARGIN, y1 = Math.max(0, ej) + SEARCH_MARGIN;
  const W = x1 - x0 + 1, H = y1 - y0 + 1;
  const idx = (i: number, j: number, d: number) => ((j - y0) * W + (i - x0)) * 4 + d;

  const best = new Float64Array(W * H * 4).fill(Infinity);
  const from = new Int32Array(W * H * 4).fill(-1);
  const heap = new MinHeap<number>();
  const h = (i: number, j: number) => Math.abs(i - ei) + Math.abs(j - ej);
  const dirIndex = (v?: Point) => v ? DIRS.findIndex(d => d.x === Math.sign(v.x) && d.y === Math.sign(v.y)) : -1;
  const startD = dirIndex(startDir);
  const endD = dirIndex(endDir);

  // Start with every heading (a start direction, if given, is free; the rest pay a bend)
  for (let d = 0; d < 4; d++) {
    const g = startD < 0 || d === startD ? 0 : BEND_PENALTY;
    best[idx(0, 0, d)] = g;
    heap.push(g + h(0, 0), idx(0, 0, d));
  }

  let goal = -1;
  while (heap.size > 0) {
    const cur = heap.pop();
    const d = cur % 4;
    const cellIndex = (cur - d) / 4;
    const i = (cellIndex % W) + x0;
    const j = Math.floor(cellIndex / W) + y0;
    const g = best[cur];
    if (i === ei && j === ej) {
      if (endD < 0 || d === endD) { goal = cur; break; }
      // Arrived on the wrong heading: turn onto the arrival direction here,
      // a bend like any other
      const turned = idx(i, j, endD);
      if (g + BEND_PENALTY < best[turned] - EPS) {
        best[turned] = g + BEND_PENALTY;
        from[turned] = cur;
        heap.push(g + BEND_PENALTY, turned);
      }
    }
    for (let nd = 0; nd < 4; nd++) {
      const ni = i + DIRS[nd].x, nj = j + DIRS[nd].y;
      if (ni < x0 || ni > x1 || nj < y0 || nj > y1) continue;
      const c = at(ni, nj);
      const cost = g + 1 + (nd === d ? 0 : BEND_PENALTY) + cellPenalty(c.x, c.y, obstacles);
      const ni_ = idx(ni, nj, nd);
      if (cost < best[ni_] - EPS) {
        best[ni_] = cost;
        from[ni_] = cur;
        heap.push(cost + h(ni, nj), ni_);
      }
    }
  }

  if (goal < 0) {
    // Out of the search box (cannot happen while both ends are inside it); one bend
    return manhattanPath(start, end, 'x');
  }
  const pts: Point[] = [];
  for (let cur = goal; cur >= 0; cur = from[cur]) {
    const d = cur % 4;
    const cellIndex = (cur - d) / 4;
    pts.push(at((cellIndex % W) + x0, Math.floor(cellIndex / W) + y0));
    if (from[cur] < 0) break;
  }
  pts.reverse();

  // The square join from the goal cell to the end
  const g = pts[pts.length - 1];
  if (!samePoint(g, end)) {
    if (endDir) {
      pts.push(Math.abs(endDir.x) > EPS ? { x: g.x, y: end.y } : { x: end.x, y: g.y }, end);
    } else {
      const prev = pts.length >= 2 ? pts[pts.length - 2] : null;
      let axis: 'x' | 'y' = 'x';
      if (prev) {
        const legAxis: 'x' | 'y' = Math.abs(g.x - prev.x) > EPS ? 'x' : 'y';
        const leg = legAxis === 'x' ? g.x - prev.x : g.y - prev.y;
        const ahead = legAxis === 'x' ? end.x - g.x : end.y - g.y;
        // Straight on if the end is ahead (or level); otherwise turn first
        axis = leg * ahead >= -EPS ? legAxis : (legAxis === 'x' ? 'y' : 'x');
      }
      pts.push(...manhattanPath(g, end, axis).slice(1));
    }
  }
  return simplifyRoute(pts);
}

// ---------------------------------------------------------------------------
// Lanes: runs that share a cell are drawn side by side
// ---------------------------------------------------------------------------

export interface RouteRun {
  key: unknown;
  pts: Point[];
  /** Drawn width in metres, for spacing. */
  width: number;
}

interface LaneSegment {
  run: RouteRun;
  index: number;      // segment index within the run
  line: number;       // the y of a horizontal segment, the x of a vertical one
  lo: number;
  hi: number;
  offset: number;
  /** A short stub at a run's end stays on its anchor. */
  pinned: boolean;
}

/**
 * Perpendicular offsets so runs sharing a corridor sit next to each other
 * rather than on top of one another. Each straight segment is atomic: it
 * gets one lane along its whole length, so a run does not wobble from cell
 * to cell. Segments overlapping on the same line form a group; lanes are
 * spread across the tile and compress to fit when the corridor is full.
 * Segment ends on ports stay put (a short jog joins them to the lane).
 */
export function laneOffsetRoutes(runs: RouteRun[]): Map<unknown, Point[]> {
  const segments: LaneSegment[] = [];
  const byLine = new Map<string, LaneSegment[]>();
  for (const run of runs) {
    const n = run.pts.length;
    for (let i = 0; i < n - 1; i++) {
      const a = run.pts[i], b = run.pts[i + 1];
      const horizontal = Math.abs(a.y - b.y) < EPS;
      const vertical = Math.abs(a.x - b.x) < EPS;
      if (!horizontal && !vertical) continue; // diagonal legs (pipe ends off-lattice) are drawn as they are
      const len = Math.abs(horizontal ? b.x - a.x : b.y - a.y);
      const seg: LaneSegment = {
        run, index: i,
        line: horizontal ? a.y : a.x,
        lo: horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y),
        hi: horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y),
        offset: 0,
        pinned: (i === 0 || i === n - 2) && len < TILE_M - EPS,
      };
      segments.push(seg);
      const k = `${horizontal ? 'h' : 'v'}:${Math.round(seg.line * 1e4)}`;
      let list = byLine.get(k);
      if (!list) { list = []; byLine.set(k, list); }
      list.push(seg);
    }
  }

  // Lane assignment per line: interval-graph colouring over overlap groups
  for (const list of byLine.values()) {
    const active = list.filter(s => !s.pinned).sort((a, b) => a.lo - b.lo);
    let groupStart = 0;
    while (groupStart < active.length) {
      // Extend the group while segments keep overlapping the running extent
      let groupEnd = groupStart;
      let extent = active[groupStart].hi;
      while (groupEnd + 1 < active.length && active[groupEnd + 1].lo < extent - EPS) {
        groupEnd++;
        extent = Math.max(extent, active[groupEnd].hi);
      }
      const group = active.slice(groupStart, groupEnd + 1);
      if (group.length > 1) {
        const lanes = new Map<LaneSegment, number>();
        for (const seg of group) {
          const used = new Set<number>();
          for (const [other, lane] of lanes) {
            if (other.lo < seg.hi - EPS && seg.lo < other.hi - EPS) used.add(lane);
          }
          let lane = 0;
          while (used.has(lane)) lane++;
          lanes.set(seg, lane);
        }
        const count = Math.max(...lanes.values()) + 1;
        const widest = Math.max(...group.map(s => s.run.width));
        const spacing = Math.min(TILE_M / count, widest + 0.12 * TILE_M);
        for (const [seg, lane] of lanes) seg.offset = (lane - (count - 1) / 2) * spacing;
      }
      groupStart = groupEnd + 1;
    }
  }

  // Rebuild each run's polyline from its offset segments
  const out = new Map<unknown, Point[]>();
  const segsOf = new Map<RouteRun, Map<number, LaneSegment>>();
  for (const seg of segments) {
    let m = segsOf.get(seg.run);
    if (!m) { m = new Map(); segsOf.set(seg.run, m); }
    m.set(seg.index, seg);
  }
  for (const run of runs) {
    const m = segsOf.get(run);
    const pts = run.pts;
    if (!m || pts.length < 2 || [...m.values()].every(s => s.offset === 0)) {
      out.set(run.key, pts);
      continue;
    }
    const n = pts.length;
    const isH = (i: number) => Math.abs(pts[i].y - pts[i + 1].y) < EPS;
    const off = (i: number) => m.get(i)?.offset ?? 0;
    // Position of segment i's offset line and the shifted copy of a point on it
    const shifted = (i: number, p: Point): Point => isH(i) ? { x: p.x, y: p.y + off(i) } : { x: p.x + off(i), y: p.y };
    const result: Point[] = [];
    // Start: on the anchor, with a jog onto the first lane if it is offset
    if (off(0) !== 0) {
      const d = isH(0) ? { x: Math.sign(pts[1].x - pts[0].x), y: 0 } : { x: 0, y: Math.sign(pts[1].y - pts[0].y) };
      const jog = { x: pts[0].x + d.x * TILE_M / 2, y: pts[0].y + d.y * TILE_M / 2 };
      result.push(pts[0], jog, shifted(0, jog));
    } else {
      result.push(pts[0]);
    }
    for (let k = 1; k < n - 1; k++) {
      const prev = k - 1, next = k;
      const a = shifted(prev, pts[k]), b = shifted(next, pts[k]);
      if (isH(prev) === isH(next)) {
        // Collinear neighbours (a lane change along one line): step across
        result.push(a, b);
      } else {
        // Corner: the vertical segment fixes x, the horizontal one fixes y
        result.push(isH(prev) ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
      }
    }
    if (off(n - 2) !== 0) {
      const d = isH(n - 2) ? { x: Math.sign(pts[n - 2].x - pts[n - 1].x), y: 0 } : { x: 0, y: Math.sign(pts[n - 2].y - pts[n - 1].y) };
      const jog = { x: pts[n - 1].x + d.x * TILE_M / 2, y: pts[n - 1].y + d.y * TILE_M / 2 };
      result.push(shifted(n - 2, jog), jog, pts[n - 1]);
    } else {
      result.push(pts[n - 1]);
    }
    out.set(run.key, simplifyRoute(result));
  }
  return out;
}

/**
 * Finish a partially drawn route (waypoints already laid, last one being the
 * current pipe end) into a target port.
 */
export function completeRoute(waypoints: Point[], b: PortAnchor): Point[] {
  if (waypoints.length === 0) return [];
  const last = waypoints[waypoints.length - 1];
  const axis: 'x' | 'y' = waypoints.length >= 2
    ? (Math.abs(last.x - waypoints[waypoints.length - 2].x) > EPS ? 'x' : 'y')
    : leaveAxis(oppositeSide(b.side));
  const end = b.out ?? b.point;
  const pts = [...waypoints, ...pathPreferringAxis(last, end, axis).slice(1)];
  if (b.out) pts.push(b.point);
  return simplifyRoute(pts);
}

/**
 * The dashed rubber-band from the drawn end of a route to the cursor cell:
 * straight on first, then one bend.
 */
export function rubberBand(waypoints: Point[], cursorCell: Point): Point[] {
  if (waypoints.length === 0) return [];
  const last = waypoints[waypoints.length - 1];
  const axis: 'x' | 'y' = waypoints.length >= 2
    ? (Math.abs(last.x - waypoints[waypoints.length - 2].x) > EPS ? 'x' : 'y')
    : 'x';
  return pathPreferringAxis(last, cursorCell, axis);
}

function pointOnSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > EPS) return false;
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  return dot >= -EPS && dot <= len2 + EPS;
}

/**
 * Extend a route being dragged to the cell the cursor is now over. Dragging
 * back along the last segment shortens it instead of doubling back, so the
 * pipe follows the cursor rather than recording every wobble.
 */
export function extendRoute(waypoints: Point[], cell: Point): Point[] {
  if (waypoints.length === 0) return [cell];
  const last = waypoints[waypoints.length - 1];
  if (samePoint(last, cell)) return waypoints;
  if (waypoints.length >= 2) {
    const prev = waypoints[waypoints.length - 2];
    if (pointOnSegment(cell, prev, last)) {
      const out = waypoints.slice(0, -1);
      if (!samePoint(prev, cell)) out.push(cell);
      return out;
    }
  }
  const path = rubberBand(waypoints, cell);
  return simplifyRoute([...waypoints, ...path.slice(1)]);
}

/**
 * Keep a drawn route attached to ports whose anchors have moved (the
 * component was nudged, its size edited, a pump re-oriented). The interior
 * of the drawing is kept; only the legs into each port are re-laid.
 */
export function reanchorRoute(route: Point[], a: PortAnchor, b: PortAnchor): Point[] {
  if (route.length >= 2 && samePoint(route[0], a.point) && samePoint(route[route.length - 1], b.point)) {
    return route;
  }
  const interior = route.slice(1, -1);
  if (interior.length === 0) return autoRoute(a, b);
  const head: Point[] = [a.point];
  if (a.out) head.push(a.out);
  head.push(...pathPreferringAxis(head[head.length - 1], interior[0], leaveAxis(a.side)).slice(1));
  const body = interior.slice(1);
  const tailStart = interior[interior.length - 1];
  const tailEnd = b.out ?? b.point;
  const tail = pathPreferringAxis(tailStart, tailEnd, leaveAxis(oppositeSide(b.side))).slice(1);
  const pts = [...head, ...body, ...tail];
  if (b.out) pts.push(b.point);
  return simplifyRoute(pts);
}

/**
 * The polyline a plant connection is drawn along in grid view: the stored
 * route (re-anchored if its ends have moved), else an automatic one that
 * steers around the given obstacles (computed from the plant when not
 * given). Null when either end cannot be resolved.
 */
/**
 * The reserved endpoint id meaning "the outside air" (see ENVIRONMENT_NODE_ID
 * in simulation/factory.ts). It is not a component, so a line to it is drawn
 * as a short stub leaving its port rather than a run to somewhere.
 */
export const ENVIRONMENT_ID = 'atmosphere';

/** Two tiles of pipe out of a port, for a line that vents to open air. */
export function environmentStub(component: PlantComponent, portId: string): Point[] | null {
  const anchor = portAnchor(component, portId);
  if (!anchor || !anchor.out) return null;
  const v = sideVector(anchor.side);
  return [anchor.point, anchor.out, { x: anchor.out.x + v.x * TILE_M, y: anchor.out.y + v.y * TILE_M }];
}

export function connectionRoute(conn: Connection, plantState: PlantState, obstacles?: Obstacle[]): Point[] | null {
  const fromComponent = plantState.components.get(conn.fromComponentId);
  const toComponent = plantState.components.get(conn.toComponentId);
  if (!fromComponent && conn.fromComponentId === ENVIRONMENT_ID && toComponent) {
    return environmentStub(toComponent, conn.toPortId);
  }
  if (!toComponent && conn.toComponentId === ENVIRONMENT_ID && fromComponent) {
    return environmentStub(fromComponent, conn.fromPortId);
  }
  if (!fromComponent || !toComponent) return null;
  const a = connectionAnchor(plantState, fromComponent, conn.fromPortId, toComponent, conn.toPortId);
  const b = connectionAnchor(plantState, toComponent, conn.toPortId, fromComponent, conn.fromPortId);
  if (!a || !b) return null;
  if (conn.route && conn.route.length >= 2) return reanchorRoute(conn.route, a, b);
  return autoRoute(a, b, obstaclesForRun(obstacles ?? routeObstacles(plantState),
    [{ id: fromComponent.id, anchor: a }, { id: toComponent.id, anchor: b }]));
}

/**
 * Where a connection meets a component on the plan: a valve's nozzle on the
 * side its turned valve puts it (turnedValveSides), anything else facing its
 * partner (portAnchorFacing).
 */
function connectionAnchor(
  plantState: PlantState, c: PlantComponent, portId: string, partner: PlantComponent, partnerPortId: string,
): PortAnchor | null {
  const sides = turnedValveSides(c, id => {
    const far = portPartner(plantState, c, id);
    // An opening into the valve's own container is not piped
    if (!far || far.partner.containedBy === c.id || c.containedBy === far.partner.id) return null;
    return partnerReference(far.partner, far.partnerPortId);
  });
  const side = sides?.get(portId);
  const port = c.ports.find(p => p.id === portId);
  if (side && port) return wallAnchor(c, port, side, c.position);
  return portAnchorFacing(c, portId, partnerReference(partner, partnerPortId));
}

/** Point and unit direction at a fraction (0..1) of the route's length. */
export function pointAlongRoute(pts: Point[], fraction: number): { point: Point; dir: Point } {
  const total = routeLength(pts);
  if (pts.length < 2 || total < EPS) {
    return { point: pts[0] ?? { x: 0, y: 0 }, dir: { x: 1, y: 0 } };
  }
  let target = Math.max(0, Math.min(1, fraction)) * total;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (target <= segLen || i === pts.length - 1) {
      const t = segLen < EPS ? 0 : target / segLen;
      return {
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        dir: segLen < EPS ? { x: 1, y: 0 } : { x: (b.x - a.x) / segLen, y: (b.y - a.y) / segLen },
      };
    }
    target -= segLen;
  }
  return { point: pts[pts.length - 1], dir: { x: 1, y: 0 } };
}

/** The part of a route between two fractions (0..1) of its length. */
export function sliceRoute(pts: Point[], from: number, to: number): Point[] {
  const total = routeLength(pts);
  if (pts.length < 2 || total < EPS) return [pts[0], pts[pts.length - 1]].map(p => ({ ...p }));
  const a = from * total, b = to * total;
  const out: Point[] = [pointAlongRoute(pts, from).point];
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (s > a + EPS && s < b - EPS) out.push({ ...pts[i] });
  }
  out.push(pointAlongRoute(pts, to).point);
  const simple = simplifyRoute(out);
  return simple.length >= 2 ? simple : [out[0], out[out.length - 1]];
}

export function distanceToPolyline(p: Point, pts: Point[]): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
    const d = Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Ground pipe: runs laid on open ground, and the loose ends that meet
// ---------------------------------------------------------------------------

/** Which way a single ground pipe piece lies. */
export type PipeOrientation = 'EW' | 'NS';

export function oppositeOrientation(o: PipeOrientation): PipeOrientation {
  return o === 'EW' ? 'NS' : 'EW';
}

/** Half a tile from `from`, directly away from `toward`. */
function carryOut(from: Point, toward: Point): Point {
  const dx = from.x - toward.x, dy = from.y - toward.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return { x: from.x, y: from.y };
  return { x: from.x + (dx / len) * TILE_M / 2, y: from.y + (dy / len) * TILE_M / 2 };
}

/**
 * The route a run drawn through these cells occupies.
 *
 * The interior follows cell centres, as every other route on the grid does,
 * but the two ENDS are carried half a tile past the terminal centres, out to
 * the cell boundary. That is deliberate, and it is what makes ground pipe
 * connectable: a piece FILLS its tile, so its loose end lands on exactly the
 * point the neighbouring tile's piece ends on, and on exactly the point a
 * component's port anchors to on that footprint edge. Ends meet by being the
 * same point, with no tolerance to tune.
 *
 * A single cell has no direction of its own, so it takes the orientation the
 * pipe tool is holding.
 */
export function groundRunRoute(cells: Point[], orientation: PipeOrientation): Point[] {
  const centres = simplifyRoute(cells.map(cellCenter));
  if (centres.length === 0) return [];
  if (centres.length === 1) {
    const c = centres[0];
    const h = TILE_M / 2;
    return orientation === 'EW'
      ? [{ x: c.x - h, y: c.y }, { x: c.x + h, y: c.y }]
      : [{ x: c.x, y: c.y - h }, { x: c.x, y: c.y + h }];
  }
  const head = carryOut(centres[0], centres[1]);
  const tail = carryOut(centres[centres.length - 1], centres[centres.length - 2]);
  return simplifyRoute([head, ...centres, tail]);
}

/**
 * The route of a run swept out of a pipe's loose end and released on open
 * ground. `waypoints` starts AT the end (a tile boundary, where the old
 * pipe stops) and continues through cell centres; the new loose end is
 * carried out to the far boundary of the last cell, as groundRunRoute does,
 * so the next piece can meet it. Empty when the sweep never left the end.
 */
export function runFromEndRoute(waypoints: Point[]): Point[] {
  const pts = simplifyRoute(waypoints);
  if (pts.length < 2) return [];
  const tail = carryOut(pts[pts.length - 1], pts[pts.length - 2]);
  return simplifyRoute([...pts, tail]);
}

/**
 * Where a component of this PALETTE type lands when it is placed at a plan
 * point. A ground pipe piece is placed BY CELL - its route fills the tile the
 * cursor is over - while everything else centres its footprint on whole
 * tiles. A pipe's `position` is its inlet END, not the middle of a footprint,
 * so snapping one as a footprint centre put the placed piece half its length
 * east of the preview box (the default pipe footprint is 10 x 1 tiles).
 */
export function snapPlacementCenter(componentType: string, pos: Point): Point {
  if (componentType === 'pipe') return cellCenter(pos);
  return snapCenter(pos, footprintForType(componentType));
}

/**
 * The route a single ground pipe piece placed over a plan point occupies.
 * The placement preview and the placement itself both call this, so what is
 * drawn and what is built are the same polyline by construction.
 */
export function pipePieceRoute(pos: Point, orientation: PipeOrientation): Point[] {
  return groundRunRoute([pos], orientation);
}

/** A pipe end with nothing on it, at the point where it could meet something. */
export interface FreeEnd {
  component: PipeComponent;
  port: Port;
  point: Point;
  /** The way the end faces, pointing away from the pipe body. */
  side: Side;
}

/** Every unconnected end of a pipe component. */
export function pipeFreeEnds(pipe: PipeComponent): FreeEnd[] {
  return portAnchors(pipe)
    .filter(a => !a.port.connectedTo)
    .map(a => ({ component: pipe, port: a.port, point: a.point, side: a.side }));
}

/** Where a loose end would be joined: a port on some other component. */
export interface EndJoin {
  component: PlantComponent;
  port: Port;
}

/**
 * What a loose pipe end touches: another pipe's loose end at exactly the same
 * point facing back at it, or a component's free port anchored on that point
 * with its face turned towards it.
 *
 * Exact coincidence, deliberately. The ends of ground pipe land on tile
 * boundaries and so do port anchors, so two things meant to meet meet
 * exactly. A tolerance here would let a run grab a nozzle it merely passes
 * near, which is worse than having to lay one more tile.
 */
export function joinForFreeEnd(plantState: PlantState, end: FreeEnd): EndJoin | null {
  const facing = oppositeSide(end.side);
  for (const component of plantState.components.values()) {
    if (component.id === end.component.id) continue;
    if (!component.ports || (component as any).isHydraulicOnly) continue;
    for (const anchor of portAnchors(component)) {
      if (anchor.port.connectedTo) continue;
      if (!samePoint(anchor.point, end.point)) continue;
      if (anchor.side !== facing) continue;
      return { component, port: anchor.port };
    }
  }
  return null;
}

/** A loose end of a pipe and what it touches. */
export interface FreeEndJoin {
  end: FreeEnd;
  join: EndJoin;
}

/**
 * Every join a newly laid pipe's loose ends make. At most one per end, and
 * never twice into the same port (a one-tile piece dropped across a single
 * nozzle must not try to connect both of its ends to it).
 */
export function findFreeEndJoins(plantState: PlantState, pipe: PipeComponent): FreeEndJoin[] {
  const out: FreeEndJoin[] = [];
  const taken = new Set<string>();
  for (const end of pipeFreeEnds(pipe)) {
    const join = joinForFreeEnd(plantState, end);
    if (!join || taken.has(join.port.id)) continue;
    taken.add(join.port.id);
    out.push({ end, join });
  }
  return out;
}

export function translateRoute(pts: Point[], dx: number, dy: number): Point[] {
  return pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
}
