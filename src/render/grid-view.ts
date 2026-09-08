/**
 * Grid view: a top-down tile map in the style of factory-building games.
 *
 * The world plan is drawn straight down (screen = (world - camera) * ppm),
 * components snap to whole tiles and stand on a foundation pad as 3/4-view
 * sprites (the same front-view drawings the other views use, rising north
 * from the south edge of their footprint), and every connection is a pipe
 * laid along the grid through cell centres. PlantCanvas delegates to this
 * class for projection, hit testing, and the frame's ground/plant layers,
 * then draws the shared overlays (gauges, flow arrows, ...) on top.
 */
import { Point, PlantState, PlantComponent, Connection, Fluid, Port, PipeComponent, BuildingComponent, ViewState, ControllerComponent, SwitchyardComponent, PoolComponent, WarehouseComponent, PlantStock } from '../types';
import { stockedComponentTypes, typeDisplayName, PIPE_METRES_PER_STICK } from '../game/stock';
import { SimulationState } from '../simulation';
import { renderComponent, getComponentVisualHeight, ConnectionScreenEndpoints, flowConnectionIdForPlantConnection, formatGaugeValue, renderFluidWithNcg, getLiquidFraction, poolRackGlow } from './components';
import { getFluidColor, COLORS } from './colors';
import { getComponentSize } from './component-size';
import { readoutScale } from './readout-scale';
import {
  TILE_M, Footprint, PlanRect, PortAnchor, Side,
  componentFootprint, footprintForType, footprintRect, snapCenter, rectsOverlap, cellCenter,
  portAnchors, portAnchor, connectionRoute, pipeRoute, routeLength, completeRoute, rubberBand,
  extendRoute, pointAlongRoute, distanceToPolyline, sideVector, samePoint,
  routeObstacles, obstaclesKey, laneOffsetRoutes, RouteRun,
} from './grid-geometry';
import { GridArt } from './grid-art';
import { TerrainSpec } from '../terrain-types';
import { TerrainModel, buildTerrainModel, surfaceAtVolume } from '../simulation/terrain';

export interface GridCamera {
  /** World point (metres) at the canvas centre. */
  x: number;
  y: number;
  /** Pixels per metre. */
  ppm: number;
}

/** Everything the frame needs from the owning canvas. */
export interface GridFrameState {
  width: number;
  height: number;
  plantState: PlantState;
  simState: SimulationState | null;
  selectedComponentId: string | null;
  /** A pipe run the user clicked (see connectionAt). */
  selectedConnection: Connection | null;
  hoveredComponentId: string | null;
  showPorts: boolean;
  highlightedPort: { componentId: string; portId: string } | null;
  constructionMode: boolean;
  /** The player may place/connect right now (true in both modes since live edits). */
  buildMode: boolean;
  placementPreview: { componentType: string; position: Point } | null;
  connectionFluid: (conn: Connection, from: PlantComponent) => Fluid | undefined;
}

export interface PortHit {
  component: PlantComponent;
  port: Port;
  anchor: PortAnchor;
}

/** A pipe being laid from a port. */
export interface RoutingState {
  from: PortHit;
  /** Vertices laid so far (cell centres); the last one is the loose end. */
  waypoints: Point[];
  cursorCell: Point | null;
  /** Port under the cursor that the route would finish into. */
  target: PortHit | null;
  /** True while the pointer is held down and sweeping cells. */
  dragging: boolean;
  /** Screen point of the press that started the current sweep (a release near it is a click, not a drag). */
  pressScreen: Point | null;
  /** The source component's footprint: a sweep never lays pipe back through it. */
  sourceRect: PlanRect | null;
}

/** A pipe component or a plant connection: the things drawn as runs. */
type Run = Connection | PipeComponent;

/**
 * Where every run goes this frame. `routes` are the geometric polylines
 * (what a connection's length and hit test refer to); `display` are the
 * same runs laid side by side where they share a corridor.
 */
interface RouteLayout {
  routes: Map<Run, Point[]>;
  display: Map<Run, Point[]>;
}

function isConnection(run: Run): run is Connection {
  return 'fromPortId' in run;
}

/** Screen layout of a standing sprite. */
interface SpriteLayout {
  fp: Footprint;
  rect: PlanRect;
  zoom: number;
  centerX: number;
  /** Screen y of the sprite's bottom edge (the south footprint edge). */
  baseY: number;
  halfHpx: number;
  halfWpx: number;
}

/** Small fittings are drawn no smaller than this many tiles across, so a valve is visible. */
const MIN_SPRITE_TILES = 0.8;
const MIN_CLICK_TARGET_PX = 24;

export class GridView {
  static readonly DEFAULT_PPM = 24;
  static readonly MIN_PPM = 5;
  static readonly MAX_PPM = 160;

  cam: GridCamera = { x: 0, y: 0, ppm: GridView.DEFAULT_PPM };
  routing: RoutingState | null = null;
  private art = new GridArt();
  private size = { width: 800, height: 600 };
  /** Automatic routes are a search; keep them until their inputs change. */
  private routeCache = new Map<Run, { key: string; pts: Point[] }>();
  private layout: RouteLayout | null = null;
  /** Basins of the plant's terrain, rebuilt when the height field object changes. */
  private terrainModel: { spec: TerrainSpec; model: TerrainModel } | null = null;

  private terrainFor(spec: TerrainSpec | undefined): TerrainModel | null {
    if (!spec) return null;
    if (!this.terrainModel || this.terrainModel.spec !== spec) {
      this.terrainModel = { spec, model: buildTerrainModel(spec) };
    }
    return this.terrainModel.model;
  }

  // ---------------------------------------------------------------------
  // Route layout
  // ---------------------------------------------------------------------

  /**
   * Routes for every run in the plant, laned for drawing. Rebuilt each
   * frame from cached routes: a route is recomputed only when its ends or
   * the obstacle set have moved, since the obstacle-avoiding search is the
   * one expensive step.
   */
  private buildLayout(plantState: PlantState): RouteLayout {
    const obstacles = routeObstacles(plantState);
    const obsKey = obstaclesKey(obstacles);
    const routes = new Map<Run, Point[]>();
    const runs: RouteRun[] = [];
    const seen = new Set<Run>();

    for (const c of plantState.components.values()) {
      if (c.type !== 'pipe' || (c as any).isHydraulicOnly) continue;
      const pipe = c as PipeComponent;
      const pts = pipeRoute(pipe);
      routes.set(pipe, pts);
      runs.push({ key: pipe, pts, width: this.lineWidthForDiameter(pipe.diameter || 0.3) / this.cam.ppm });
    }
    for (const conn of plantState.connections) {
      const from = plantState.components.get(conn.fromComponentId);
      const to = plantState.components.get(conn.toComponentId);
      if (!from || !to || this.isContainmentPair(from, to)) continue;
      const endsKey = JSON.stringify([
        from.position, to.position, conn.fromPortId, conn.toPortId, conn.route ?? null,
        from.type === 'pipe' ? pipeRoute(from as PipeComponent) : null,
        to.type === 'pipe' ? pipeRoute(to as PipeComponent) : null,
      ]);
      const key = `${obsKey}|${endsKey}`;
      seen.add(conn);
      let cached = this.routeCache.get(conn);
      if (!cached || cached.key !== key) {
        const pts = connectionRoute(conn, plantState, obstacles);
        if (!pts) continue;
        cached = { key, pts };
        this.routeCache.set(conn, cached);
      }
      if (routeLength(cached.pts) < 1e-6) continue;
      routes.set(conn, cached.pts);
      runs.push({ key: conn, pts: cached.pts, width: this.lineWidthForArea(conn.flowArea) / this.cam.ppm });
    }
    for (const k of this.routeCache.keys()) {
      if (!seen.has(k)) this.routeCache.delete(k);
    }
    return { routes, display: laneOffsetRoutes(runs) as Map<Run, Point[]> };
  }

  /** The last frame's layout (built now if there is none yet). */
  private currentLayout(plantState: PlantState): RouteLayout {
    if (!this.layout) this.layout = this.buildLayout(plantState);
    return this.layout;
  }

  // ---------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------

  setViewportSize(width: number, height: number): void {
    this.size = { width, height };
  }

  worldToScreen(p: Point): Point {
    return {
      x: (p.x - this.cam.x) * this.cam.ppm + this.size.width / 2,
      y: (p.y - this.cam.y) * this.cam.ppm + this.size.height / 2,
    };
  }

  screenToWorld(s: Point): Point {
    return {
      x: (s.x - this.size.width / 2) / this.cam.ppm + this.cam.x,
      y: (s.y - this.size.height / 2) / this.cam.ppm + this.cam.y,
    };
  }

  panByPixels(dx: number, dy: number): void {
    this.cam.x -= dx / this.cam.ppm;
    this.cam.y -= dy / this.cam.ppm;
  }

  /** Zoom by a factor keeping the world point under `screen` fixed. */
  zoomAt(screen: Point, factor: number): void {
    const before = this.screenToWorld(screen);
    this.cam.ppm = Math.max(GridView.MIN_PPM, Math.min(GridView.MAX_PPM, this.cam.ppm * factor));
    const after = this.screenToWorld(screen);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
  }

  /** Zoom relative to the default scale (1 = DEFAULT_PPM), about the canvas centre. */
  get zoomFactor(): number {
    return this.cam.ppm / GridView.DEFAULT_PPM;
  }

  setZoomFactor(z: number): void {
    this.cam.ppm = Math.max(GridView.MIN_PPM, Math.min(GridView.MAX_PPM, z * GridView.DEFAULT_PPM));
  }

  /**
   * Centre the camera on the plant and zoom so all of it is in view (never
   * closer than the default scale). With no plant, look at the origin.
   */
  centerOn(plantState: PlantState): void {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of plantState.components.values()) {
      if ((c as any).isHydraulicOnly) continue;
      const rect = c.type === 'pipe'
        ? (() => {
            const pts = pipeRoute(c as PipeComponent);
            return { x0: Math.min(...pts.map(p => p.x)), x1: Math.max(...pts.map(p => p.x)),
                     y0: Math.min(...pts.map(p => p.y)), y1: Math.max(...pts.map(p => p.y)) };
          })()
        : footprintRect(c.position, componentFootprint(c));
      minX = Math.min(minX, rect.x0); maxX = Math.max(maxX, rect.x1);
      minY = Math.min(minY, rect.y0); maxY = Math.max(maxY, rect.y1);
    }
    if (!Number.isFinite(minX)) {
      this.cam.x = 0; this.cam.y = 0;
      this.cam.ppm = GridView.DEFAULT_PPM;
      return;
    }
    this.cam.x = (minX + maxX) / 2;
    this.cam.y = (minY + maxY) / 2;
    const margin = 4 * TILE_M;
    const fitPpm = Math.min(
      this.size.width / (maxX - minX + 2 * margin),
      this.size.height / (maxY - minY + 2 * margin));
    this.cam.ppm = Math.max(GridView.MIN_PPM, Math.min(GridView.DEFAULT_PPM, fitPpm));
  }

  // ---------------------------------------------------------------------
  // Snapping
  // ---------------------------------------------------------------------

  snapPlacement(componentType: string, pos: Point): Point {
    return snapCenter(pos, footprintForType(componentType));
  }

  snapComponent(component: PlantComponent, pos: Point): Point {
    if (component.type === 'pipe') {
      // Pipe ends live on cell edges/centres already; keep them on the half-tile lattice
      return { x: Math.round(pos.x * 2 / TILE_M) * TILE_M / 2, y: Math.round(pos.y * 2 / TILE_M) * TILE_M / 2 };
    }
    return snapCenter(pos, componentFootprint(component));
  }

  // ---------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------

  private isGroundLayer(component: PlantComponent): boolean {
    // Things that ARE the ground where they stand: a building's floor, a
    // switchyard's apron, and a pool, which is a hole in it.
    return component.type === 'building' || component.type === 'switchyard' ||
      component.type === 'pool' || component.type === 'warehouse';
  }

  private spriteLayout(component: PlantComponent): SpriteLayout {
    const size = getComponentSize(component);
    const fp = componentFootprint(component);
    const rect = footprintRect(component.position, fp);
    const visualH = getComponentVisualHeight(component);
    const largest = Math.max(size.width, visualH);
    const spriteScale = largest > 0 && largest < MIN_SPRITE_TILES * TILE_M ? (MIN_SPRITE_TILES * TILE_M) / largest : 1;
    const zoom = this.cam.ppm * spriteScale;
    // Everything sits on its pad regardless of elevation (the elevation is
    // labelled instead): a raised duct floating above the pipes that meet it
    // reads as detached, not as high
    const south = this.worldToScreen({ x: component.position.x, y: rect.y1 });
    return {
      fp, rect, zoom,
      centerX: south.x,
      baseY: south.y,
      halfHpx: (size.height / 2) * zoom,
      halfWpx: (size.width / 2) * zoom,
    };
  }

  /** Screen box of a sprite (or of a ground-layer footprint), for gauges and hit tests. */
  spriteScreenBox(component: PlantComponent): { left: number; right: number; top: number; bottom: number } | null {
    if (component.type === 'pipe') {
      const pts = pipeRoute(component as PipeComponent).map(p => this.worldToScreen(p));
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const pad = Math.max(4, ((component as PipeComponent).diameter || 0.3) * this.cam.ppm);
      return { left: Math.min(...xs) - pad, right: Math.max(...xs) + pad, top: Math.min(...ys) - pad, bottom: Math.max(...ys) + pad };
    }
    if (this.isGroundLayer(component)) {
      const rect = footprintRect(component.position, componentFootprint(component));
      const a = this.worldToScreen({ x: rect.x0, y: rect.y0 });
      const b = this.worldToScreen({ x: rect.x1, y: rect.y1 });
      return { left: a.x, right: b.x, top: a.y, bottom: b.y };
    }
    const L = this.spriteLayout(component);
    return {
      left: L.centerX - L.halfWpx,
      right: L.centerX + L.halfWpx,
      top: L.baseY - 2 * L.halfHpx,
      bottom: L.baseY,
    };
  }

  componentScreenBounds(component: PlantComponent): { topCenter: Point; scale: number; width: number; height: number } | null {
    const box = this.spriteScreenBox(component);
    if (!box) return null;
    return {
      topCenter: { x: (box.left + box.right) / 2, y: box.top },
      scale: this.cam.ppm / 50,
      width: box.right - box.left,
      height: box.bottom - box.top,
    };
  }

  portScreenPosition(component: PlantComponent, portId: string): { x: number; y: number; radius: number } | null {
    const a = portAnchor(component, portId);
    if (!a) return null;
    const s = this.worldToScreen(a.point);
    return { x: s.x, y: s.y, radius: this.portRadius() };
  }

  private portRadius(): number {
    return Math.max(5, Math.min(14, this.cam.ppm * 0.22));
  }

  /** Where a flow arrow for a connection belongs: the middle of its route, along it. */
  connectionScreenEndpoints(conn: Connection, plantState: PlantState): ConnectionScreenEndpoints | null {
    const layout = this.currentLayout(plantState);
    const pts = layout.display.get(conn) ?? connectionRoute(conn, plantState);
    if (!pts) return null;
    const len = routeLength(pts);
    const scale = this.cam.ppm / 50;
    if (len < 1e-6) {
      // Zero-length stub (a pipe laid in grid view starts exactly at the
      // port): point the arrow along the pipe it feeds
      const fromComponent = plantState.components.get(conn.fromComponentId);
      const toComponent = plantState.components.get(conn.toComponentId);
      const pipe = [fromComponent, toComponent].find(c => c?.type === 'pipe') as PipeComponent | undefined;
      if (pipe) {
        const pr = pipeRoute(pipe);
        const atStart = samePoint(pr[0], pts[0]);
        // Downstream direction of the stub's from->to sense: into the pipe at
        // its start (the stub feeds it), out of the pipe at its end
        const a = atStart ? pr[0] : pr[pr.length - 1];
        const b = atStart ? pr[1] : pr[pr.length - 2];
        const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const ux = (atStart ? 1 : -1) * (b.x - a.x) / d;
        const uy = (atStart ? 1 : -1) * (b.y - a.y) / d;
        const half = TILE_M * 0.5;
        return {
          fromPos: this.worldToScreen({ x: a.x - ux * half, y: a.y - uy * half }),
          toPos: this.worldToScreen({ x: a.x + ux * half, y: a.y + uy * half }),
          scale,
        };
      }
      const s = this.worldToScreen(pts[0]);
      return { fromPos: s, toPos: s, scale };
    }
    const mid = pointAlongRoute(pts, 0.5);
    const half = Math.min(TILE_M * 0.5, len / 4);
    return {
      fromPos: this.worldToScreen({ x: mid.point.x - mid.dir.x * half, y: mid.point.y - mid.dir.y * half }),
      toPos: this.worldToScreen({ x: mid.point.x + mid.dir.x * half, y: mid.point.y + mid.dir.y * half }),
      scale,
    };
  }

  // ---------------------------------------------------------------------
  // Hit testing
  // ---------------------------------------------------------------------

  private drawOrder(plantState: PlantState): PlantComponent[] {
    const comps = Array.from(plantState.components.values()).filter(c => !(c as any).isHydraulicOnly);
    const depth = new Map<string, number>();
    const depthOf = (c: PlantComponent): number => {
      const cached = depth.get(c.id);
      if (cached !== undefined) return cached;
      let d = 0;
      const seen = new Set<string>();
      let cur: PlantComponent | undefined = c;
      while (cur?.containedBy && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = plantState.components.get(cur.containedBy);
        d++;
      }
      depth.set(c.id, d);
      return d;
    };
    const southEdge = (c: PlantComponent): number => {
      if (c.type === 'pipe') return Math.max(...pipeRoute(c as PipeComponent).map(p => p.y));
      return footprintRect(c.position, componentFootprint(c)).y1;
    };
    return comps.sort((a, b) => {
      // Ground-layer things first, then by containment depth, then by south edge
      const ga = this.isGroundLayer(a) ? 0 : 1, gb = this.isGroundLayer(b) ? 0 : 1;
      if (ga !== gb) return ga - gb;
      const da = depthOf(a), db = depthOf(b);
      if (da !== db) return da - db;
      return southEdge(a) - southEdge(b);
    });
  }

  componentAt(screen: Point, plantState: PlantState): PlantComponent | null {
    const world = this.screenToWorld(screen);
    const order = this.drawOrder(plantState);
    for (let i = order.length - 1; i >= 0; i--) {
      const c = order[i];
      if (c.type === 'pipe') {
        const pipe = c as PipeComponent;
        const half = Math.max((pipe.diameter || 0.3) / 2, MIN_CLICK_TARGET_PX / 2 / this.cam.ppm);
        const pts = this.currentLayout(plantState).display.get(pipe) ?? pipeRoute(pipe);
        if (distanceToPolyline(world, pts) <= half) return c;
        continue;
      }
      if (c.type === 'pool' || c.type === 'warehouse') {
        const rect = footprintRect(c.position, componentFootprint(c));
        if (world.x >= rect.x0 && world.x <= rect.x1 && world.y >= rect.y0 && world.y <= rect.y1) return c;
        continue;
      }
      if (c.type === 'building') {
        // The wall ring only - clicks on the floor fall through to what is inside
        const rect = footprintRect(c.position, componentFootprint(c));
        const inset = Math.max(0.6, 8 / this.cam.ppm);
        const inOuter = world.x >= rect.x0 && world.x <= rect.x1 && world.y >= rect.y0 && world.y <= rect.y1;
        const inInner = world.x >= rect.x0 + inset && world.x <= rect.x1 - inset && world.y >= rect.y0 + inset && world.y <= rect.y1 - inset;
        if (inOuter && !inInner) return c;
        continue;
      }
      const box = this.spriteScreenBox(c);
      if (!box) continue;
      const padX = Math.max(0, (MIN_CLICK_TARGET_PX - (box.right - box.left)) / 2);
      const padY = Math.max(0, (MIN_CLICK_TARGET_PX - (box.bottom - box.top)) / 2);
      if (screen.x >= box.left - padX && screen.x <= box.right + padX && screen.y >= box.top - padY && screen.y <= box.bottom + padY) {
        return c;
      }
    }
    return null;
  }

  /**
   * The port under a screen point. Where two ports coincide (a pipe's end
   * sits exactly on the nozzle it was laid to), the free one wins, then the
   * nearer one.
   */
  /**
   * The connection whose drawn run is under a screen point (nearest wins).
   * Openings between a component and its container are not drawn, so they
   * cannot be hit.
   */
  connectionAt(screen: Point, plantState: PlantState): Connection | null {
    const world = this.screenToWorld(screen);
    let best: Connection | null = null;
    let bestD = Infinity;
    for (const [run, pts] of this.currentLayout(plantState).display) {
      if (!isConnection(run)) continue;
      const halfWidth = Math.max(this.lineWidthForArea(run.flowArea) / 2, 6) / this.cam.ppm;
      const d = distanceToPolyline(world, pts);
      if (d <= halfWidth && d < bestD) {
        bestD = d;
        best = run;
      }
    }
    return best;
  }

  portAt(screen: Point, plantState: PlantState, exclude?: string): PortHit | null {
    const r = this.portRadius() + 3;
    let best: PortHit | null = null;
    let bestKey = Infinity;
    for (const component of plantState.components.values()) {
      if (!component.ports || (component as any).isHydraulicOnly) continue;
      if (exclude && component.id === exclude) continue;
      for (const anchor of portAnchors(component)) {
        const s = this.worldToScreen(anchor.point);
        const d = Math.hypot(screen.x - s.x, screen.y - s.y);
        if (d > r) continue;
        const key = d + (anchor.port.connectedTo ? 1000 : 0);
        if (key < bestKey) {
          bestKey = key;
          best = { component, port: anchor.port, anchor };
        }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------
  // Routing interaction
  // ---------------------------------------------------------------------

  startRouting(from: PortHit): void {
    this.routing = {
      from,
      waypoints: [from.anchor.out ?? from.anchor.point],
      cursorCell: null,
      target: null,
      dragging: false,
      pressScreen: null,
      sourceRect: from.component.type === 'pipe' ? null
        : footprintRect(from.component.position, componentFootprint(from.component)),
    };
  }

  /** Track the cursor: which cell it is over and whether it rests on a finishing port. */
  updateRoutingCursor(screen: Point, plantState: PlantState): void {
    if (!this.routing) return;
    const world = this.screenToWorld(screen);
    this.routing.cursorCell = cellCenter(world);
    this.routing.target = this.portAt(screen, plantState, this.routing.from.component.id);
    if (this.routing.dragging && !this.insideSource(this.routing.cursorCell)) {
      this.routing.waypoints = extendRoute(this.routing.waypoints, this.routing.cursorCell);
    }
  }

  private insideSource(cell: Point): boolean {
    const r = this.routing?.sourceRect;
    if (!r) return false;
    return cell.x > r.x0 && cell.x < r.x1 && cell.y > r.y0 && cell.y < r.y1;
  }

  /** Commit the rubber band as laid pipe (a click on open ground while routing). */
  fixWaypoint(): void {
    if (!this.routing || !this.routing.cursorCell || this.insideSource(this.routing.cursorCell)) return;
    this.routing.waypoints = extendRoute(this.routing.waypoints, this.routing.cursorCell);
  }

  /** The finished route into a target port, and its plan length. */
  finishRouting(target: PortHit): { route: Point[]; length: number } {
    const r = this.routing!;
    const route = completeRoute([r.from.anchor.point, ...r.waypoints], target.anchor);
    this.routing = null;
    return { route, length: routeLength(route) };
  }

  cancelRouting(): void {
    this.routing = null;
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  render(ctx: CanvasRenderingContext2D, f: GridFrameState): void {
    this.size = { width: f.width, height: f.height };
    this.layout = this.buildLayout(f.plantState);
    const order = this.drawOrder(f.plantState);

    this.renderGround(ctx, f);
    this.renderTerrain(ctx, f);

    // Ground layer: building floors and switchyards, in plan
    for (const c of order) {
      if (c.type === 'building') this.renderBuilding(ctx, c as BuildingComponent, f);
      else if (c.type === 'switchyard') this.renderSwitchyard(ctx, c as SwitchyardComponent, f);
      else if (c.type === 'pool') this.renderPool(ctx, c as PoolComponent, f);
      else if (c.type === 'warehouse') this.renderWarehouse(ctx, c as WarehouseComponent, f);
    }

    // Foundation pads under every standing component
    for (const c of order) {
      if (this.isGroundLayer(c) || c.type === 'pipe') continue;
      this.renderPad(ctx, c, f);
    }

    this.renderRoutes(ctx, f);

    // Standing sprites, back to front
    for (const c of order) {
      if (this.isGroundLayer(c) || c.type === 'pipe') continue;
      this.renderSprite(ctx, c, f);
    }

    this.renderSignalLines(ctx, f);

    if (f.selectedConnection) this.renderConnectionLabel(ctx, f, f.selectedConnection);
    if (f.showPorts) this.renderPorts(ctx, f);
    if (this.routing) this.renderRouting(ctx, f);
    if (f.placementPreview && f.buildMode) this.renderPlacementPreview(ctx, f);
  }

  private renderGround(ctx: CanvasRenderingContext2D, f: GridFrameState): void {
    const origin = this.worldToScreen({ x: 0, y: 0 });
    ctx.fillStyle = this.art.pattern(ctx, 'ground', this.cam.ppm, origin);
    ctx.fillRect(0, 0, f.width, f.height);

    // Tile lines: clear while building, all but gone while the plant runs
    const ppm = this.cam.ppm;
    if (ppm >= 10) {
      const building = f.constructionMode ||
        (f.buildMode && (f.placementPreview !== null || f.showPorts));
      const alpha = building ? 0.16 : 0.02;
      const tl = this.screenToWorld({ x: 0, y: 0 });
      const br = this.screenToWorld({ x: f.width, y: f.height });
      const x0 = Math.floor(tl.x / TILE_M), x1 = Math.ceil(br.x / TILE_M);
      const y0 = Math.floor(tl.y / TILE_M), y1 = Math.ceil(br.y / TILE_M);
      ctx.lineWidth = 1;
      for (const major of [false, true]) {
        ctx.strokeStyle = major ? `rgba(40, 40, 30, ${alpha * 1.8})` : `rgba(40, 40, 30, ${alpha})`;
        ctx.beginPath();
        for (let i = x0; i <= x1; i++) {
          if ((i % 5 === 0) !== major) continue;
          const sx = Math.round(this.worldToScreen({ x: i * TILE_M, y: 0 }).x) + 0.5;
          ctx.moveTo(sx, 0); ctx.lineTo(sx, f.height);
        }
        for (let j = y0; j <= y1; j++) {
          if ((j % 5 === 0) !== major) continue;
          const sy = Math.round(this.worldToScreen({ x: 0, y: j * TILE_M }).y) + 0.5;
          ctx.moveTo(0, sy); ctx.lineTo(f.width, sy);
        }
        ctx.stroke();
      }
    }
  }

  /**
   * The lie of the land: a height tint over the ground texture (low ground
   * greener and darker, high ground paler and browner), contour lines every
   * metre with a heavier one every five, and the water standing in each
   * basin - the sea and lakes at their surface, puddles where a leak has
   * pooled - as translucent blue over every cell below the surface.
   */
  private renderTerrain(ctx: CanvasRenderingContext2D, f: GridFrameState): void {
    const spec = f.plantState.terrain;
    const model = this.terrainFor(spec);
    if (!spec || !model) return;
    const { origin, cellSize, cols, rows, heights } = spec;
    const half = cellSize / 2;

    // Visible cell range
    const tl = this.screenToWorld({ x: 0, y: 0 });
    const br = this.screenToWorld({ x: f.width, y: f.height });
    const i0 = Math.max(0, Math.floor((tl.x - origin.x) / cellSize - 1));
    const i1 = Math.min(cols - 1, Math.ceil((br.x - origin.x) / cellSize + 1));
    const j0 = Math.max(0, Math.floor((tl.y - origin.y) / cellSize - 1));
    const j1 = Math.min(rows - 1, Math.ceil((br.y - origin.y) / cellSize + 1));
    if (i1 < i0 || j1 < j0) return;

    let hMin = Infinity, hMax = -Infinity;
    for (const h of heights) { if (h < hMin) hMin = h; if (h > hMax) hMax = h; }
    const span = Math.max(1, hMax - hMin);

    // Water surface per basin: scripted bodies and stored puddles from the
    // simulation; before one exists, the bodies at their declared surfaces
    const surfaceOf = new Map<number, number>();
    const sim = f.simState;
    for (const b of model.basins) {
      if (b.water) {
        const live = sim?.surfaceWater?.bodies.get(b.water.id);
        surfaceOf.set(b.id, live ? live.surface : b.water.surface);
      } else {
        const v = sim?.surfaceWater?.volumes.get(b.id) ?? 0;
        if (v > 0) surfaceOf.set(b.id, surfaceAtVolume(model, b, v));
      }
    }

    const px = cellSize * this.cam.ppm;
    ctx.save();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * cols + i;
        const h = heights[c];
        const s = this.worldToScreen({ x: origin.x + i * cellSize - half, y: origin.y + j * cellSize - half });
        // Height tint: valley green to hilltop tan
        const t = (h - hMin) / span;
        const r = Math.round(70 + 140 * t), g = Math.round(125 + 45 * t), bl = Math.round(55 + 55 * t);
        ctx.fillStyle = `rgba(${r}, ${g}, ${bl}, 0.5)`;
        ctx.fillRect(s.x, s.y, px + 0.5, px + 0.5);
        // Standing water
        const surface = surfaceOf.get(model.basinOf[c]);
        if (surface !== undefined && surface > h) {
          const depth = surface - h;
          const a = Math.min(0.85, 0.35 + depth * 0.08);
          ctx.fillStyle = `rgba(40, 90, 170, ${a.toFixed(3)})`;
          ctx.fillRect(s.x, s.y, px + 0.5, px + 0.5);
        }
      }
    }

    // Contours: an edge between two cells whose heights straddle a level.
    // The minor interval follows the map's relief (about twelve steps over
    // its span, rounded to 1/2/5); minor lines are skipped when the cells
    // are so coarse that nearly every edge would carry one.
    let meanStep = 0, edges = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i + 1 < cols; i++) { meanStep += Math.abs(heights[j * cols + i + 1] - heights[j * cols + i]); edges++; }
    }
    meanStep = edges > 0 ? meanStep / edges : 0;
    const raw = span / 12;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
    const minor = [1, 2, 5, 10].map(m => m * mag).find(v => v >= raw) ?? 10 * mag;
    const major = minor * 5;
    const levels: Array<readonly [number, string, number]> = [[major, 'rgba(60, 45, 20, 0.65)', 1.5]];
    if (meanStep < minor) levels.unshift([minor, 'rgba(60, 45, 20, 0.3)', 1]);
    if (px >= 3) {
      for (const [interval, style, width] of levels) {
        ctx.strokeStyle = style;
        ctx.lineWidth = width;
        ctx.beginPath();
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const c = j * cols + i;
            const hc = Math.floor(heights[c] / interval);
            const s = this.worldToScreen({ x: origin.x + i * cellSize - half, y: origin.y + j * cellSize - half });
            if (i + 1 < cols && Math.floor(heights[c + 1] / interval) !== hc) {
              ctx.moveTo(s.x + px, s.y); ctx.lineTo(s.x + px, s.y + px);
            }
            if (j + 1 < rows && Math.floor(heights[c + cols] / interval) !== hc) {
              ctx.moveTo(s.x, s.y + px); ctx.lineTo(s.x + px, s.y + px);
            }
          }
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private wallColor(building: BuildingComponent): { wall: string; light: string } {
    const steelFrac = building.steelFraction || 0.1;
    const r = Math.round(100 * steelFrac + 180 * (1 - steelFrac));
    const g = Math.round(105 * steelFrac + 175 * (1 - steelFrac));
    const b = Math.round(115 * steelFrac + 165 * (1 - steelFrac));
    return { wall: `rgb(${r}, ${g}, ${b})`, light: `rgb(${Math.min(255, r + 30)}, ${Math.min(255, g + 30)}, ${Math.min(255, b + 30)})` };
  }

  /** A building in plan: concrete floor inside a thick wall, labelled. */
  private renderBuilding(ctx: CanvasRenderingContext2D, b: BuildingComponent, f: GridFrameState): void {
    const rect = footprintRect(b.position, componentFootprint(b));
    const tl = this.worldToScreen({ x: rect.x0, y: rect.y0 });
    const br = this.worldToScreen({ x: rect.x1, y: rect.y1 });
    const w = br.x - tl.x, h = br.y - tl.y;
    const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2;
    const wallPx = Math.max(3, Math.min(w, h) * 0.035, (b.wallThickness || 1) * this.cam.ppm);
    const { wall, light } = this.wallColor(b);
    const isSelected = b.id === f.selectedComponentId;
    const origin = this.worldToScreen({ x: 0, y: 0 });

    const shape = () => {
      ctx.beginPath();
      if (b.shape === 'cylinder') ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(tl.x, tl.y, w, h);
    };

    // Shadow to the south-east so the wall reads as raised
    ctx.save();
    ctx.translate(wallPx * 0.6, wallPx * 0.8);
    shape();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.fill();
    ctx.restore();

    shape();
    ctx.fillStyle = this.art.pattern(ctx, 'concrete', this.cam.ppm, origin);
    ctx.fill();

    // The atmosphere inside, as a translucent tint over the floor: the same
    // fluid/NCG colouring the 2.5D shell shows (steam, hydrogen, a flooded
    // sump), clipped to the floor so the outline stays the plan shape
    if (b.fluid) {
      ctx.save();
      shape();
      ctx.clip();
      ctx.globalAlpha = 0.55;
      const liquidFraction = getLiquidFraction(b, b.fluid, !f.constructionMode);
      renderFluidWithNcg(ctx, b.fluid, tl.x, tl.y, w, h, liquidFraction, b.fluid.separation ?? 1, 6);
      ctx.restore();
    }

    // Wall: outer dark edge, body, inner highlight
    ctx.lineWidth = wallPx;
    ctx.strokeStyle = wall;
    shape();
    ctx.stroke();
    ctx.lineWidth = Math.max(1, wallPx * 0.25);
    ctx.strokeStyle = light;
    ctx.save();
    ctx.translate(-wallPx * 0.3, -wallPx * 0.3);
    shape();
    ctx.stroke();
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.save();
    ctx.translate(wallPx * 0.5, wallPx * 0.5);
    shape();
    ctx.stroke();
    ctx.restore();

    if (isSelected) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLORS.selectionHighlight;
      shape();
      ctx.stroke();
    }

    // Label in the near corner
    const fontPx = Math.max(9, Math.min(18, this.cam.ppm * 0.5));
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(30, 30, 30, 0.75)';
    const label = b.label || b.id;
    const lx = b.shape === 'cylinder' ? cx - ctx.measureText(label).width / 2 : tl.x + wallPx + 4;
    const ly = b.shape === 'cylinder' ? tl.y + h * 0.18 : tl.y + wallPx + 3;
    ctx.fillText(label, lx, ly);
  }

  /**
   * A spent-fuel pool in plan: a square hole with a concrete coping, the
   * water seen from above (deeper water is darker and bluer), the racks as a
   * grid of assembly cells under it, and the level read off the rim as both
   * a bar and a number.
   *
   * The level is the one thing the player has to watch, so it is drawn twice
   * - as depth of colour over the whole basin and as a gauge on the rim -
   * and the racks stop being blue and start glowing the moment the water
   * stops covering them, which is exactly when the physics stops cooling
   * them with liquid.
   */
  private renderPool(ctx: CanvasRenderingContext2D, pool: PoolComponent, f: GridFrameState): void {
    const rect = footprintRect(pool.position, componentFootprint(pool));
    const tl = this.worldToScreen({ x: rect.x0, y: rect.y0 });
    const br = this.worldToScreen({ x: rect.x1, y: rect.y1 });
    const w = br.x - tl.x, h = br.y - tl.y;
    const copingPx = Math.max(3, Math.min(w, h) * 0.05, (pool.wallThickness || 1.5) * this.cam.ppm);
    const depth = pool.depth || 12;
    const origin = this.worldToScreen({ x: 0, y: 0 });

    // Concrete coping around the opening
    ctx.fillStyle = this.art.pattern(ctx, 'concrete', this.cam.ppm, origin);
    ctx.fillRect(tl.x - copingPx, tl.y - copingPx, w + 2 * copingPx, h + 2 * copingPx);
    ctx.strokeStyle = 'rgba(50, 50, 50, 0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(tl.x - copingPx, tl.y - copingPx, w + 2 * copingPx, h + 2 * copingPx);

    // The basin itself, and the water standing in it. `level` is the
    // liquid's height above the floor, from the same volume fraction the
    // simulation keeps.
    const liquidFraction = getLiquidFraction(pool, pool.fluid ?? ({} as Fluid), !f.constructionMode);
    const level = liquidFraction * depth;
    ctx.fillStyle = '#2b2f31';                       // dry liner
    ctx.fillRect(tl.x, tl.y, w, h);

    // Racks, drawn under the water
    const cells = Math.max(2, Math.min(14, Math.round(Math.sqrt(pool.assemblyCount || 800) / 2)));
    const rackInset = Math.min(w, h) * 0.12;
    const rackX = tl.x + rackInset, rackY = tl.y + rackInset;
    const rackW = w - 2 * rackInset, rackH = h - 2 * rackInset;
    const rackTop = (pool.rackBottomElevation ?? 0.5) + (pool.rackHeight || 3.66);
    const covered = level >= rackTop;
    const glow = poolRackGlow((pool as { rackTemperature?: number }).rackTemperature
      ?? pool.fluid?.temperature ?? 300);
    if (rackW > 2 && rackH > 2) {
      ctx.fillStyle = glow > 0.02
        ? `rgb(${Math.round(90 + 165 * glow)}, ${Math.round(95 + 60 * glow)}, ${Math.round(105 - 60 * glow)})`
        : '#4a5257';
      ctx.fillRect(rackX, rackY, rackW, rackH);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < cells; i++) {
        const x = rackX + (rackW * i) / cells;
        const y = rackY + (rackH * i) / cells;
        ctx.moveTo(x, rackY); ctx.lineTo(x, rackY + rackH);
        ctx.moveTo(rackX, y); ctx.lineTo(rackX + rackW, y);
      }
      ctx.stroke();
    }

    // Water over the whole basin: opacity grows with how much stands there,
    // so a full pool reads deep blue and a drained one reads bare liner
    if (level > 0) {
      const shade = Math.min(0.82, 0.25 + 0.6 * (level / Math.max(depth, 1e-6)));
      const hot = (pool.fluid?.temperature ?? 300) > 368;   // near boiling
      ctx.fillStyle = hot
        ? `rgba(150, 190, 205, ${shade.toFixed(3)})`
        : `rgba(30, 95, 150, ${shade.toFixed(3)})`;
      ctx.fillRect(tl.x, tl.y, w, h);
    }
    ctx.strokeStyle = covered ? 'rgba(180, 210, 230, 0.8)' : 'rgba(230, 140, 60, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(tl.x, tl.y, w, h);

    // Level gauge on the rim (west edge), reading up from the floor
    const gaugeW = Math.max(4, Math.min(12, copingPx * 0.8));
    const gx = tl.x - copingPx + 1;
    ctx.fillStyle = 'rgba(20, 20, 20, 0.55)';
    ctx.fillRect(gx, tl.y, gaugeW, h);
    const fillPx = h * Math.max(0, Math.min(1, level / Math.max(depth, 1e-6)));
    ctx.fillStyle = covered ? '#4ea3e0' : '#e08a3c';
    ctx.fillRect(gx, tl.y + h - fillPx, gaugeW, fillPx);
    // Where the top of the fuel is: below this line the racks are uncovering
    const rackLinePx = h * Math.max(0, Math.min(1, rackTop / Math.max(depth, 1e-6)));
    ctx.strokeStyle = 'rgba(255, 90, 60, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(gx, tl.y + h - rackLinePx);
    ctx.lineTo(gx + gaugeW, tl.y + h - rackLinePx);
    ctx.stroke();

    // Label and numeric level
    const fontPx = Math.max(9, Math.min(16, this.cam.ppm * 0.45));
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(20, 20, 20, 0.8)';
    ctx.fillText(pool.label || pool.id, tl.x + 3, tl.y - copingPx + 2);
    ctx.font = `${fontPx}px monospace`;
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = covered ? 'rgba(235, 240, 245, 0.95)' : 'rgba(255, 170, 90, 0.98)';
    const over = level - rackTop;
    ctx.fillText(
      `${formatGaugeValue(level)} m  (${over >= 0 ? '+' : ''}${formatGaugeValue(over)} m over fuel)`,
      tl.x + 3, tl.y + h - 3);

    if (pool.id === f.selectedComponentId) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLORS.selectionHighlight;
      ctx.strokeRect(tl.x - copingPx, tl.y - copingPx, w + 2 * copingPx, h + 2 * copingPx);
    }
  }

  /**
   * The supply yard in plan: an open-sided shed on a concrete apron with the
   * stock stacked in it - racks of pipe on the left, crates of equipment on
   * the right, and the numbers over the top.
   *
   * The stacks are the point. One drawn stick is PIPE_METRES_PER_STICK metres
   * and one crate is one part, so the piles visibly shrink as the player
   * builds and an empty yard reads as empty racks rather than as a number
   * that happens to say zero. The numeric labels carry the exact figures, so
   * a yard holding more sticks than the racks can draw still reads correctly
   * (the drawing fills, the label keeps counting).
   */
  private renderWarehouse(ctx: CanvasRenderingContext2D, wh: WarehouseComponent, f: GridFrameState): void {
    const rect = footprintRect(wh.position, componentFootprint(wh));
    const tl = this.worldToScreen({ x: rect.x0, y: rect.y0 });
    const br = this.worldToScreen({ x: rect.x1, y: rect.y1 });
    const w = br.x - tl.x, h = br.y - tl.y;
    const origin = this.worldToScreen({ x: 0, y: 0 });
    const stock = wh.stock ?? { pipeMeters: 0, components: {} };

    // Apron
    ctx.fillStyle = this.art.pattern(ctx, 'pad', this.cam.ppm, origin);
    ctx.fillRect(tl.x, tl.y, w, h);

    // The shed: a roof band along the north edge, open to the south. Drawn as
    // a solid roof strip plus the two side walls, so the yard reads as a
    // three-sided structure you can walk parts out of.
    const wallPx = Math.max(2, Math.min(w, h) * 0.055);
    ctx.fillStyle = 'rgba(96, 104, 112, 0.95)';
    ctx.fillRect(tl.x, tl.y, w, wallPx * 2);                      // back wall + roof edge
    ctx.fillRect(tl.x, tl.y, wallPx, h);                           // west wall
    ctx.fillRect(br.x - wallPx, tl.y, wallPx, h);                  // east wall
    ctx.strokeStyle = 'rgba(35, 38, 42, 0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(tl.x + 0.5, tl.y + 0.5, w - 1, h - 1);
    // Open south side: a dashed threshold rather than a wall
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(210, 180, 90, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tl.x + wallPx, br.y - 1);
    ctx.lineTo(br.x - wallPx, br.y - 1);
    ctx.stroke();
    ctx.setLineDash([]);

    // Interior: pipe racks on the west, crates on the east. Both stack from
    // the BACK of the shed forward, so a pile that is being drawn down
    // visibly retreats toward the wall instead of thinning out evenly.
    const inX = tl.x + wallPx + 2;
    const inY = tl.y + wallPx * 2 + 2;
    const inW = w - 2 * wallPx - 4;
    const inH = h - wallPx * 2 - 6;
    // Zoomed too far out to draw the contents - the label and the numbers
    // below still go on, because that is what a distant yard is read by
    const roomForStock = inW >= 8 && inH >= 8;

    if (roomForStock) this.renderYardStock(ctx, stock, inX, inY, inW, inH);

    // --- labels ------------------------------------------------------------
    const fontPx = Math.max(8, Math.min(15, this.cam.ppm * 0.42));
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(25, 25, 25, 0.85)';
    ctx.fillText(wh.label || wh.id, tl.x + 2, tl.y - 2);

    ctx.font = `${fontPx}px monospace`;
    ctx.textBaseline = 'top';
    const summary = [`${formatGaugeValue(stock.pipeMeters)} m`]
      .concat(stockedComponentTypes(stock)
        .map(([type, count]) => `${count}x ${typeDisplayName(type, count !== 1)}`))
      .join('  ');
    // Dark plate behind the readout so it survives the gravel pattern
    const textW = ctx.measureText(summary).width;
    ctx.fillStyle = 'rgba(15, 18, 20, 0.6)';
    ctx.fillRect(tl.x + 1, br.y + 1, textW + 6, fontPx + 4);
    ctx.fillStyle = 'rgba(235, 240, 245, 0.95)';
    ctx.fillText(summary, tl.x + 4, br.y + 3);

    if (wh.id === f.selectedComponentId) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLORS.selectionHighlight;
      ctx.strokeRect(tl.x, tl.y, w, h);
    }
  }

  /**
   * What is standing in the yard: the pipe racks on the west, crates on the
   * east. Split out of renderWarehouse so a yard drawn too small to hold
   * anything readable simply skips it and still gets its label.
   */
  private renderYardStock(
    ctx: CanvasRenderingContext2D, stock: PlantStock,
    inX: number, inY: number, inW: number, inH: number
  ): void {
    const pipeW = inW * 0.6;
    const crateX = inX + pipeW + 3;
    const crateW = inW - pipeW - 3;

    // --- pipe sticks -------------------------------------------------------
    // A fixed number of sticks across a rack row, so the stack reads as a
    // stack at any zoom and any yard size.
    const PIPE_COLS = 6;
    const sticks = Math.ceil(Math.max(0, stock.pipeMeters) / PIPE_METRES_PER_STICK);
    const stickW = pipeW / PIPE_COLS;
    const rowH = Math.max(2.5, Math.min(inH / 5, stickW * 0.85));
    const rows = Math.max(1, Math.floor(inH / rowH));
    const drawn = Math.min(sticks, rows * PIPE_COLS);
    for (let i = 0; i < drawn; i++) {
      const row = Math.floor(i / PIPE_COLS);
      const col = i % PIPE_COLS;
      const x = inX + col * stickW;
      const y = inY + row * rowH;
      // A stick of pipe seen from above: a bright body with a dark seam
      ctx.fillStyle = '#9fb0bd';
      ctx.fillRect(x + 0.5, y + 0.5, Math.max(1.5, stickW - 1.5), Math.max(1.5, rowH - 1.5));
      ctx.fillStyle = 'rgba(28, 32, 36, 0.6)';
      ctx.fillRect(x + 0.5, y + rowH - 2, Math.max(1.5, stickW - 1.5), 1);
      ctx.strokeStyle = 'rgba(20, 24, 28, 0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1.5, stickW - 1.5), Math.max(1.5, rowH - 1.5));
    }
    // Bare rails below the stack, so the space keeps reading as pipe storage
    // even when it is empty
    ctx.strokeStyle = 'rgba(140, 140, 140, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let r = Math.ceil(drawn / PIPE_COLS); r < rows; r++) {
      const y = inY + r * rowH + rowH / 2;
      ctx.moveTo(inX, y); ctx.lineTo(inX + pipeW, y);
    }
    ctx.stroke();

    // --- crates ------------------------------------------------------------
    const items = stockedComponentTypes(stock);
    const CRATE_COLS = 2;
    const crateSize = Math.max(4, Math.min(crateW / CRATE_COLS - 2, inH / 4));
    let slot = 0;
    for (const [type, count] of items) {
      for (let n = 0; n < count; n++) {
        const row = Math.floor(slot / CRATE_COLS);
        const col = slot % CRATE_COLS;
        const x = crateX + col * (crateSize + 2);
        const y = inY + row * (crateSize + 2);
        if (y + crateSize > inY + inH) { slot = -1; break; }
        this.drawStockCrate(ctx, x, y, crateSize, type);
        slot++;
      }
      if (slot < 0) break;
    }
  }

  /**
   * One item of stock in the yard: a pump gets its own silhouette (a volute
   * and a motor) because pumps are the part the early levels are counted in;
   * everything else is a crate stencilled with the first letters of its type.
   */
  private drawStockCrate(
    ctx: CanvasRenderingContext2D, x: number, y: number, size: number, type: string
  ): void {
    if (type === 'pump') {
      ctx.fillStyle = '#3f7f6a';
      ctx.beginPath();
      ctx.arc(x + size * 0.45, y + size * 0.55, size * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2c5c4d';
      ctx.fillRect(x + size * 0.7, y + size * 0.3, size * 0.3, size * 0.5);
      ctx.strokeStyle = 'rgba(15, 20, 18, 0.8)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
      return;
    }
    ctx.fillStyle = '#8a6b3f';
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = 'rgba(40, 30, 15, 0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + size, y + size);
    ctx.moveTo(x + size, y); ctx.lineTo(x, y + size);
    ctx.stroke();
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    if (size >= 9) {
      ctx.fillStyle = 'rgba(255, 245, 225, 0.9)';
      ctx.font = `bold ${Math.floor(size * 0.5)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(typeDisplayName(type as never).slice(0, 2).toUpperCase(),
        x + size / 2, y + size / 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }
  }

  private renderSwitchyard(ctx: CanvasRenderingContext2D, s: SwitchyardComponent, f: GridFrameState): void {
    const rect = footprintRect(s.position, componentFootprint(s));
    const tl = this.worldToScreen({ x: rect.x0, y: rect.y0 });
    const br = this.worldToScreen({ x: rect.x1, y: rect.y1 });
    const origin = this.worldToScreen({ x: 0, y: 0 });
    // Gravel yard on a concrete apron with a fence line
    ctx.fillStyle = this.art.pattern(ctx, 'pad', this.cam.ppm, origin);
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.strokeStyle = 'rgba(60, 60, 60, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(tl.x + 1, tl.y + 1, br.x - tl.x - 2, br.y - tl.y - 2);
    ctx.setLineDash([]);

    const center = this.worldToScreen(s.position);
    ctx.save();
    ctx.translate(center.x, center.y);
    const view: ViewState = { offsetX: 0, offsetY: 0, zoom: this.cam.ppm };
    renderComponent(ctx, s, view, s.id === f.selectedComponentId, true, f.plantState.connections, !f.constructionMode, f.plantState);
    ctx.restore();
  }

  /** Concrete foundation with a soft shadow, sized to the footprint. */
  private renderPad(ctx: CanvasRenderingContext2D, c: PlantComponent, f: GridFrameState): void {
    const rect = footprintRect(c.position, componentFootprint(c));
    const tl = this.worldToScreen({ x: rect.x0, y: rect.y0 });
    const br = this.worldToScreen({ x: rect.x1, y: rect.y1 });
    const w = br.x - tl.x, h = br.y - tl.y;
    const origin = this.worldToScreen({ x: 0, y: 0 });
    const inset = Math.min(w, h) * 0.06;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(tl.x + inset + 2, tl.y + inset + 3, w - 2 * inset, h - 2 * inset);
    ctx.fillStyle = this.art.pattern(ctx, 'pad', this.cam.ppm, origin);
    ctx.fillRect(tl.x + inset, tl.y + inset, w - 2 * inset, h - 2 * inset);
    // Bevel: light top/left, dark bottom/right
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath();
    ctx.moveTo(tl.x + inset, br.y - inset); ctx.lineTo(tl.x + inset, tl.y + inset); ctx.lineTo(br.x - inset, tl.y + inset);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.moveTo(br.x - inset, tl.y + inset); ctx.lineTo(br.x - inset, br.y - inset); ctx.lineTo(tl.x + inset, br.y - inset);
    ctx.stroke();

    if (c.id === f.hoveredComponentId && f.buildMode) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(tl.x, tl.y, w, h);
    }
  }

  /** The component's front-view drawing standing on its pad. */
  private renderSprite(ctx: CanvasRenderingContext2D, c: PlantComponent, f: GridFrameState): void {
    const L = this.spriteLayout(c);
    if (L.centerX + L.halfWpx < -50 || L.centerX - L.halfWpx > f.width + 50 ||
        L.baseY < -50 || L.baseY - 2 * L.halfHpx > f.height + 50) return;

    ctx.save();
    ctx.translate(L.centerX, L.baseY - L.halfHpx);
    const view: ViewState = { offsetX: 0, offsetY: 0, zoom: L.zoom };
    const isSelected = c.id === f.selectedComponentId;
    renderComponent(ctx, c, view, isSelected, true, f.plantState.connections, !f.constructionMode, f.plantState);
    ctx.restore();

    const elevation = c.elevation ?? 0;
    if (elevation !== 0) {
      ctx.font = `${Math.round(10 * readoutScale(this.cam.ppm / 50))}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#000';
      ctx.fillText(`${elevation.toFixed(1)} m`, L.centerX, L.baseY + 2);
    }
  }

  private lineWidthForArea(flowArea: number | undefined): number {
    const d = flowArea && flowArea > 0 ? Math.sqrt(4 * flowArea / Math.PI) : 0.3;
    return this.lineWidthForDiameter(d);
  }

  private lineWidthForDiameter(d: number): number {
    return Math.max(4, Math.min(this.cam.ppm * 0.6, d * this.cam.ppm));
  }

  private isContainmentPair(a: PlantComponent, b: PlantComponent): boolean {
    return a.containedBy === b.id || b.containedBy === a.id;
  }

  private renderRoutes(ctx: CanvasRenderingContext2D, f: GridFrameState): void {
    const { plantState } = f;
    const layout = this.currentLayout(plantState);
    // Pipe components first (they are the long runs), then the connections.
    // Openings between a component and its container are internal and are
    // not in the layout.
    for (const [run, pts] of layout.display) {
      if (isConnection(run)) continue;
      const pipe = run;
      const color = pipe.fluid ? getFluidColor(pipe.fluid) : COLORS.steel;
      this.drawPipe(ctx, pts.map(p => this.worldToScreen(p)), color, this.lineWidthForDiameter(pipe.diameter || 0.3), pipe.id === f.selectedComponentId);
    }
    for (const [run, pts] of layout.display) {
      if (!isConnection(run)) continue;
      const conn = run;
      const from = plantState.components.get(conn.fromComponentId);
      if (!from) continue;
      const fluid = f.connectionFluid(conn, from);
      const color = fluid ? getFluidColor(fluid) : '#667788';
      const touchesSelection = conn === f.selectedConnection || (f.selectedComponentId !== null &&
        (conn.fromComponentId === f.selectedComponentId || conn.toComponentId === f.selectedComponentId));
      this.drawPipe(ctx, pts.map(p => this.worldToScreen(p)), color, this.lineWidthForArea(conn.flowArea), touchesSelection);
    }
  }

  /** A pipe run: shadow, dark wall, fluid-coloured body, a sheen, elbows at bends, flanges at the ends. */
  private drawPipe(ctx: CanvasRenderingContext2D, pts: Point[], color: string, w: number, highlight: boolean): void {
    if (pts.length < 2) return;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    };
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (highlight) {
      ctx.strokeStyle = 'rgba(255, 255, 120, 0.85)';
      ctx.lineWidth = w + 8;
      path(); ctx.stroke();
    }

    ctx.save();
    ctx.translate(w * 0.25, w * 0.4);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.lineWidth = w + 1;
    path(); ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = '#2a2e33';
    ctx.lineWidth = w + 2;
    path(); ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    path(); ctx.stroke();

    // Cylinder sheen along the upper-left of the run
    ctx.save();
    ctx.translate(-w * 0.18, -w * 0.18);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = Math.max(1, w * 0.22);
    path(); ctx.stroke();
    ctx.restore();

    // Elbows
    ctx.fillStyle = '#3a3f45';
    ctx.strokeStyle = '#1c1f23';
    ctx.lineWidth = 1;
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, w * 0.62, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }

    // Flanges at the ends, perpendicular to the last segment
    ctx.fillStyle = '#4a5058';
    for (const [a, b] of [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]]) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const nx = -dy / d, ny = dx / d;
      const half = w * 0.75;
      const thick = Math.max(2, w * 0.28);
      ctx.beginPath();
      ctx.moveTo(a.x + nx * half, a.y + ny * half);
      ctx.lineTo(a.x - nx * half, a.y - ny * half);
      ctx.lineTo(a.x - nx * half + dx / d * thick, a.y - ny * half + dy / d * thick);
      ctx.lineTo(a.x + nx * half + dx / d * thick, a.y + ny * half + dy / d * thick);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * What a selected pipe run is: its ends, its bore and length, and while
   * the plant runs, what is flowing through it.
   */
  private renderConnectionLabel(ctx: CanvasRenderingContext2D, f: GridFrameState, conn: Connection): void {
    const { plantState, simState } = f;
    const from = plantState.components.get(conn.fromComponentId);
    const to = plantState.components.get(conn.toComponentId);
    // One end may be the environment, which is not a component
    if (!from && !to) return;
    const route = this.currentLayout(plantState).display.get(conn);
    if (!route) return;
    const mid = pointAlongRoute(route, 0.5).point;
    const s = this.worldToScreen(mid);

    const name = (c: PlantComponent | undefined) => c ? (c.label || c.id) : 'Open air';
    const lines: string[] = [`${name(from)} \u2192 ${name(to)}`];
    const bore = conn.flowArea && conn.flowArea > 0 ? Math.sqrt(4 * conn.flowArea / Math.PI) : undefined;
    const geometry: string[] = [];
    if (bore !== undefined) geometry.push(`\u2300 ${formatGaugeValue(bore)} m`);
    if (conn.length !== undefined) geometry.push(`L ${formatGaugeValue(conn.length)} m`);
    if (geometry.length > 0) lines.push(geometry.join('  \u00b7  '));
    if (simState) {
      const flowId = flowConnectionIdForPlantConnection(conn, plantState);
      const flow = flowId ? simState.flowConnections.find(fc => fc.id === flowId) : undefined;
      if (flow) {
        const fluid = f.connectionFluid(conn, (from ?? to)!);
        const phase = fluid ? fluid.phase : '';
        lines.push(`${formatGaugeValue(flow.massFlowRate)} kg/s${phase ? `  \u00b7  ${phase}` : ''}`);
      }
    }
    if (f.buildMode) lines.push('click again to edit');

    ctx.save();
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const pad = 6;
    const lineH = 15;
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2;
    const h = lines.length * lineH + pad * 2 - 3;
    let x = s.x + 14;
    let y = s.y - h / 2;
    if (x + w > f.width - 4) x = s.x - 14 - w;
    y = Math.max(4, Math.min(f.height - h - 4, y));
    ctx.fillStyle = 'rgba(20, 24, 30, 0.9)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255, 255, 120, 0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? '#fff' : '#cfd6e0';
      ctx.font = i === 0 ? 'bold 12px sans-serif' : '12px sans-serif';
      ctx.fillText(l, x + pad, y + pad + i * lineH);
    });
    // Leader from the run to the box
    ctx.strokeStyle = 'rgba(255, 255, 120, 0.85)';
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(x < s.x ? x + w : x, s.y);
    ctx.stroke();
    ctx.restore();
  }

  /** Controller wires and switchyard-to-generator lines. */
  private renderSignalLines(ctx: CanvasRenderingContext2D, f: GridFrameState): void {
    const { plantState } = f;
    ctx.save();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2;
    for (const c of plantState.components.values()) {
      let other: PlantComponent | undefined;
      let dash: number[];
      if (c.type === 'controller') {
        const id = (c as ControllerComponent).connectedCoreId;
        other = id ? plantState.components.get(id) : undefined;
        dash = [6, 4];
      } else if (c.type === 'switchyard') {
        const id = (c as SwitchyardComponent).connectedGeneratorId;
        other = id ? plantState.components.get(id) : undefined;
        dash = [8, 4];
      } else continue;
      if (!other) continue;
      const a = this.worldToScreen(c.position);
      const b = this.worldToScreen(other.position);
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private portFill(port: Port, highlighted: boolean): string {
    if (port.direction === 'in') return highlighted ? 'rgba(100, 255, 100, 0.95)' : 'rgba(100, 200, 100, 0.85)';
    if (port.direction === 'out') return highlighted ? 'rgba(255, 100, 100, 0.95)' : 'rgba(200, 100, 100, 0.85)';
    return highlighted ? 'rgba(100, 200, 255, 0.95)' : 'rgba(100, 150, 200, 0.85)';
  }

  private drawPortMarker(ctx: CanvasRenderingContext2D, s: Point, side: Side, port: Port, radius: number, highlighted: boolean): void {
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = this.portFill(port, highlighted);
    ctx.fill();
    ctx.strokeStyle = highlighted ? '#fff' : 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = highlighted ? 2.5 : 1.5;
    ctx.stroke();

    if (port.direction === 'in' || port.direction === 'out') {
      // Arrow along the side normal: into the component for inlets, out for outlets
      const v = sideVector(side);
      const sign = port.direction === 'out' ? 1 : -1;
      const dirX = v.x * sign, dirY = v.y * sign;
      const len = radius * 0.55, head = radius * 0.35;
      const sx = s.x - dirX * len, sy = s.y - dirY * len;
      const ex = s.x + dirX * len, ey = s.y + dirY * len;
      const ang = Math.atan2(dirY, dirX);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, radius * 0.2);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
      ctx.moveTo(ex + head * Math.cos(ang + Math.PI - Math.PI / 5), ey + head * Math.sin(ang + Math.PI - Math.PI / 5));
      ctx.lineTo(ex, ey);
      ctx.lineTo(ex + head * Math.cos(ang + Math.PI + Math.PI / 5), ey + head * Math.sin(ang + Math.PI + Math.PI / 5));
      ctx.stroke();
    }
  }

  private renderPorts(ctx: CanvasRenderingContext2D, f: GridFrameState): void {
    const radius = this.portRadius();
    for (const component of f.plantState.components.values()) {
      if (!component.ports || (component as any).isHydraulicOnly) continue;
      for (const anchor of portAnchors(component)) {
        const s = this.worldToScreen(anchor.point);
        if (s.x < -20 || s.x > f.width + 20 || s.y < -20 || s.y > f.height + 20) continue;
        const highlighted = !!f.highlightedPort &&
          f.highlightedPort.componentId === component.id && f.highlightedPort.portId === anchor.port.id;
        const isTarget = !!this.routing?.target &&
          this.routing.target.component.id === component.id && this.routing.target.port.id === anchor.port.id;
        const r = highlighted || isTarget ? radius * 1.4 : radius;
        this.drawPortMarker(ctx, s, anchor.side, anchor.port, r, highlighted || isTarget);
        if (highlighted || isTarget) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, r * 1.3 + Math.sin(Date.now() * 0.004) * radius * 0.3, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 100, 0.6)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }
  }

  /** The pipe being laid: solid where committed, dashed to the cursor, with a running length. */
  private renderRouting(ctx: CanvasRenderingContext2D, _f: GridFrameState): void {
    const r = this.routing!;
    const w = Math.max(4, this.cam.ppm * 0.3);
    const laid = [r.from.anchor.point, ...r.waypoints];
    let preview: Point[] = [];
    if (r.target) {
      preview = completeRoute(laid, r.target.anchor).slice(laid.length - 1);
    } else if (r.cursorCell) {
      preview = rubberBand(r.waypoints, r.cursorCell);
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const stroke = (pts: Point[], dashed: boolean) => {
      if (pts.length < 2) return;
      ctx.setLineDash(dashed ? [w, w * 0.8] : []);
      ctx.beginPath();
      const s0 = this.worldToScreen(pts[0]);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < pts.length; i++) {
        const s = this.worldToScreen(pts[i]);
        ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
    };
    ctx.strokeStyle = 'rgba(20, 24, 30, 0.6)';
    ctx.lineWidth = w + 3;
    stroke(laid, false);
    ctx.strokeStyle = r.target ? 'rgba(120, 230, 140, 0.95)' : 'rgba(140, 190, 255, 0.95)';
    ctx.lineWidth = w;
    stroke(laid, false);
    ctx.strokeStyle = r.target ? 'rgba(120, 230, 140, 0.8)' : 'rgba(140, 190, 255, 0.7)';
    stroke(preview, true);
    ctx.setLineDash([]);

    // Running length at the loose end
    const tail = preview.length > 0 ? preview[preview.length - 1] : laid[laid.length - 1];
    const total = routeLength(laid) + routeLength(preview);
    const label = `${total.toFixed(1)} m`;
    const s = this.worldToScreen(tail);
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(20, 24, 30, 0.8)';
    ctx.fillRect(s.x + 10, s.y - 26, tw + 10, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, s.x + 15, s.y - 10);
    ctx.restore();
  }

  private renderPlacementPreview(ctx: CanvasRenderingContext2D, f: GridFrameState): void {
    const { componentType, position } = f.placementPreview!;
    const fp = footprintForType(componentType);
    const center = snapCenter(position, fp);
    const rect = footprintRect(center, fp);
    let clash = false;
    for (const c of f.plantState.components.values()) {
      if ((c as any).isHydraulicOnly || c.type === 'pipe' || c.type === 'building') continue;
      if (rectsOverlap(rect, footprintRect(c.position, componentFootprint(c)))) { clash = true; break; }
    }
    const tl = this.worldToScreen({ x: rect.x0, y: rect.y0 });
    const br = this.worldToScreen({ x: rect.x1, y: rect.y1 });
    ctx.save();
    ctx.fillStyle = clash ? 'rgba(255, 170, 60, 0.28)' : 'rgba(90, 220, 130, 0.28)';
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.strokeStyle = clash ? 'rgba(255, 170, 60, 0.95)' : 'rgba(90, 220, 130, 0.95)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.setLineDash([]);
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(20, 24, 30, 0.85)';
    ctx.fillText(`${fp.w} × ${fp.d} tiles${clash ? ' (overlaps)' : ''}`, (tl.x + br.x) / 2, tl.y - 4);
    ctx.restore();
  }
}
