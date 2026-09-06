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
 */
import { Point, PlantComponent, Port, Connection, PlantState, PipeComponent } from '../types';
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

function oppositeSide(side: Side): Side {
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
const PLAN_NATIVE = new Set(['building', 'switchyard']);
const ONE_TILE = new Set(['pump', 'valve', 'controller']);

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
  if (CYLINDRICAL_UPRIGHT.has(type)) {
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

/** Footprint for a palette type (placement preview, before the component exists). */
export function footprintForType(componentType: string): Footprint {
  const size = getDefaultComponentSize(componentType);
  const storedType: Record<string, string> = {
    'reactor-vessel': 'reactorVessel', 'pressurizer': 'tank', 'core': 'coreBarrel',
    'heat-exchanger': 'heatExchanger', 'check-valve': 'valve', 'relief-valve': 'valve',
    'porv': 'valve', 'scram-controller': 'controller', 'pid-controller': 'controller',
    'cross-vessel': 'crossVessel',
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
function portSide(port: Port, size: { width: number; height: number }): Side {
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
 * A port's anchor for a connection to a partner at `partnerRef`. A vessel's
 * side nozzle is not on a fixed side of the tank in this model - the drawing
 * puts it on the side facing whatever it connects to - so an east/west port
 * of an upright cylinder is mirrored to the edge facing the partner. Other
 * components keep their stored side.
 */
export function portAnchorFacing(component: PlantComponent, portId: string, partnerRef: Point): PortAnchor | null {
  const a = portAnchor(component, portId);
  if (!a || !MIRRORS_LATERAL_PORTS.has(component.type)) return a;
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
function partnerReference(component: PlantComponent, portId: string): Point {
  if (component.type === 'pipe') {
    const a = portAnchor(component, portId);
    if (a) return a.point;
  }
  return component.position;
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
 * first port, one bend at most between the two out-cells, into the second.
 */
export function autoRoute(a: PortAnchor, b: PortAnchor): Point[] {
  const pts: Point[] = [a.point];
  if (a.out) pts.push(a.out);
  const start = pts[pts.length - 1];
  const end = b.out ?? b.point;
  pts.push(...pathPreferringAxis(start, end, leaveAxis(a.side)).slice(1));
  if (b.out) pts.push(b.point);
  return simplifyRoute(pts);
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
 * route (re-anchored if its ends have moved), else an automatic one.
 * Null when either end cannot be resolved.
 */
export function connectionRoute(conn: Connection, plantState: PlantState): Point[] | null {
  const fromComponent = plantState.components.get(conn.fromComponentId);
  const toComponent = plantState.components.get(conn.toComponentId);
  if (!fromComponent || !toComponent) return null;
  const a = portAnchorFacing(fromComponent, conn.fromPortId, partnerReference(toComponent, conn.toPortId));
  const b = portAnchorFacing(toComponent, conn.toPortId, partnerReference(fromComponent, conn.fromPortId));
  if (!a || !b) return null;
  if (conn.route && conn.route.length >= 2) return reanchorRoute(conn.route, a, b);
  return autoRoute(a, b);
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

export function translateRoute(pts: Point[], dx: number, dy: number): Point[] {
  return pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
}
