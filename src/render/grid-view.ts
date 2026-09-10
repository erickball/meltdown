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
import { Point, PlantState, PlantComponent, Connection, Fluid, Port, PipeComponent, BuildingComponent, ViewState, ControllerComponent, SwitchyardComponent, PoolComponent, WarehouseComponent, PlantStock, waterBodyOf } from '../types';
import {
  stockedLines, stockLineDisplayName, typeDisplayName, pipeSpecDisplayName,
  PIPE_METRES_PER_STICK,
} from '../game/stock';
import { SimulationState } from '../simulation';
import { renderComponent, getComponentVisualHeight, ConnectionScreenEndpoints, flowConnectionIdForPlantConnection, formatGaugeValue, renderFluidWithNcg, getLiquidFraction, poolRackGlow } from './components';
import { poolReadout, poolStateLabel } from './pool-readout';
import { buildGhost, drawBuildProgress } from '../game/build-queue';
import { getFluidColor, COLORS } from './colors';
import { getComponentSize } from './component-size';
import { readoutScale } from './readout-scale';
import {
  TILE_M, Footprint, PlanRect, PortAnchor, Side,
  componentFootprint, footprintForType, footprintRect, snapCenter, rectsOverlap, cellCenter,
  portAnchors, portAnchor, portAnchorFacing, pipeRoute, routeLength, completeRoute, rubberBand,
  extendRoute, pointAlongRoute, distanceToPolyline, sideVector, samePoint,
  routeObstacles, obstaclesKey, laneOffsetRoutes, RouteRun,
  PipeOrientation, pipePieceRoute, groundRunRoute, findFreeEndJoins, snapPlacementCenter,
  partnerReference, sideFacing, wallAnchor, autoRoute, reanchorRoute, portSide, simplifyRoute,
  ENVIRONMENT_ID, Obstacle,
} from './grid-geometry';
import { GridArt } from './grid-art';
import { TerrainSpec } from '../terrain-types';
import { TerrainModel, buildTerrainModel, surfaceAtVolume, terrainHeightAt, cellAt as terrainCellAt } from '../simulation/terrain';
import { contourPolylines, ContourSet } from './terrain-contours';
import { renderFloodDebris } from './debris-fx';

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
  /** Which way the pipe tool is holding a ground pipe piece (see pipePieceRoute). */
  pipeOrientation: PipeOrientation;
  connectionFluid: (conn: Connection, from: PlantComponent) => Fluid | undefined;
}

/** How faint a part that is not built yet (or is going away) is drawn. */
const GHOST_ALPHA = 0.42;

export interface PortHit {
  component: PlantComponent;
  port: Port;
  /**
   * Where a route to or from this port meets the plan lattice. For a port on
   * something drawn inside a container's section view this is the
   * container's wall, not the port itself (see sectionRootOf).
   */
  anchor: PortAnchor;
  /** The outermost container whose section view the port is drawn in, if any. */
  frameRoot?: PlantComponent;
}

/**
 * A pipe being laid. It starts either from a PORT (the run becomes a plant
 * connection between two ports, through the connection dialog) or from open
 * GROUND (`from` is null: the run becomes a standalone pipe component whose
 * loose ends join whatever they land on).
 */
export interface RoutingState {
  from: PortHit | null;
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
  /** Ground runs only: which way a single-cell piece lies when the sweep never left its cell. */
  orientation: PipeOrientation;
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
  /**
   * The parts of connections drawn inside a container's section view, in
   * SCREEN pixels (they live on the container's sprite, which is a picture,
   * not a place on the plan), grouped by the container so they can be drawn
   * right after its sprite and under the sprites of what it holds.
   */
  sections: Map<string, SectionRun[]>;
  /** The same runs by connection, for hit tests, labels and flow arrows. */
  sectionParts: Map<Connection, Point[][]>;
}

/** One drawn run inside a section view: a screen polyline and the connection it belongs to. */
interface SectionRun {
  conn: Connection;
  pts: Point[];
}

/**
 * One end of a connection as the plan lattice sees it. A port on the lattice
 * is its own anchor; a port drawn inside a container's section view reaches
 * the lattice at the container's wall, and `internal` is the run from the
 * port to that wall (screen pixels, see RouteLayout.sections).
 */
interface LatticeEnd {
  anchor: PortAnchor;
  root: PlantComponent | null;
  internal: Point[] | null;
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
  /**
   * Screen y of the sprite's bottom edge: the south footprint edge for a
   * sprite standing on the plan, or the component's elevation on its
   * container's sprite for one drawn inside a section view.
   */
  baseY: number;
  halfHpx: number;
  halfWpx: number;
  /** The container whose section view this sprite is drawn in, if any. */
  frame: PlantComponent | null;
}

/** Small fittings are drawn no smaller than this many tiles across, so a valve is visible. */
const MIN_SPRITE_TILES = 0.8;
const MIN_CLICK_TARGET_PX = 24;

export class GridView {
  static readonly DEFAULT_PPM = 24;
  static readonly MIN_PPM = 5;
  static readonly MAX_PPM = 160;

  cam: GridCamera = { x: 0, y: 0, ppm: GridView.DEFAULT_PPM };

  /**
   * Pixels of the canvas that other UI stands on top of (the toolbar down the
   * left, the career HUD across the top, the legend along the bottom). The
   * canvas fills the window and those panels float over it, so fit-to-plant
   * has to aim at what is left rather than at the canvas, or a plant that
   * technically fits ends up half of it behind the toolbar. Set by main.ts,
   * which owns the DOM; zero here so nothing depends on it being set.
   */
  insets = { left: 0, top: 0, right: 0, bottom: 0 };
  routing: RoutingState | null = null;
  private art = new GridArt();
  private size = { width: 800, height: 600 };
  /** Automatic routes are a search; keep them until their inputs change. */
  private routeCache = new Map<Run, { key: string; pts: Point[] }>();
  private layout: RouteLayout | null = null;
  /**
   * The plant the last frame was drawn from. Sprite layout needs to walk a
   * component's containment chain, and some callers (screen boxes, port
   * positions) hand over only the component, so the plant is remembered
   * here; every entry point that receives one refreshes it.
   */
  private plant: PlantState | null = null;
  /** Section frame per component id, for the plant above; cleared with it. */
  private frameCache = new Map<string, PlantComponent | null>();
  /**
   * Everything derived from the plant's height field, rebuilt when the field
   * object changes: the basins, the contour polylines (world coordinates, so
   * they survive every camera move), and the world rectangle the camera is
   * kept inside.
   */
  private terrainCache: {
    spec: TerrainSpec;
    model: TerrainModel;
    contours: ContourSet[];
    extent: PlanRect;
  } | null = null;

  private terrainDataFor(spec: TerrainSpec | undefined) {
    if (!spec) return null;
    if (!this.terrainCache || this.terrainCache.spec !== spec) {
      const half = spec.cellSize / 2;
      this.terrainCache = {
        spec,
        model: buildTerrainModel(spec),
        contours: contourPolylines(spec),
        extent: {
          x0: spec.origin.x - half,
          y0: spec.origin.y - half,
          x1: spec.origin.x + (spec.cols - 1) * spec.cellSize + half,
          y1: spec.origin.y + (spec.rows - 1) * spec.cellSize + half,
        },
      };
    }
    return this.terrainCache;
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
    this.setPlant(plantState);
    const obstacles = routeObstacles(plantState);
    const obsKey = obstaclesKey(obstacles);
    const routes = new Map<Run, Point[]>();
    const sections = new Map<string, SectionRun[]>();
    const sectionParts = new Map<Connection, Point[][]>();
    const runs: RouteRun[] = [];
    const seen = new Set<Run>();
    const addSection = (root: PlantComponent, conn: Connection, pts: Point[]) => {
      if (pts.length < 2) return;
      let list = sections.get(root.id);
      if (!list) { list = []; sections.set(root.id, list); }
      list.push({ conn, pts });
      let parts = sectionParts.get(conn);
      if (!parts) { parts = []; sectionParts.set(conn, parts); }
      parts.push(pts);
    };

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
      if (!from && !to) continue;

      // An opening between a component and a container that is not drawn as
      // a sprite (a building, a pool) has nowhere to be drawn
      if (from && to && this.isContainmentPair(from, to)) {
        const container = from.containedBy === to.id ? to : from;
        if (!this.isSectionFrame(container)) continue;
      }

      // Both ends drawn in the same section view: the whole run lives there
      if (from && to) {
        const spaceA = this.sectionRootOf(from) ?? from;
        const spaceB = this.sectionRootOf(to) ?? to;
        if (spaceA === spaceB && this.isSectionFrame(spaceA)) {
          const a = this.spritePortPosition(from, conn.fromPortId);
          const b = this.spritePortPosition(to, conn.toPortId);
          if (a && b) addSection(spaceA, conn, simplifyRoute([a, { x: a.x, y: b.y }, b]));
          continue;
        }
      }

      // Otherwise each end reaches the lattice (at its own port, or at its
      // container's wall) and the lattice route runs between them
      let endA: LatticeEnd | null;
      let endB: LatticeEnd | null;
      if (from && to) {
        endA = this.latticeEnd(from, conn.fromPortId, to, conn.toPortId);
        endB = this.latticeEnd(to, conn.toPortId, from, conn.fromPortId);
      } else if (from && conn.toComponentId === ENVIRONMENT_ID) {
        endA = this.latticeEnd(from, conn.fromPortId);
        endB = null;
      } else if (to && conn.fromComponentId === ENVIRONMENT_ID) {
        endA = null;
        endB = this.latticeEnd(to, conn.toPortId);
      } else {
        continue;
      }
      if ((from && !endA) || (to && !endB)) continue;
      for (const end of [endA, endB]) {
        if (end?.root && end.internal) addSection(end.root, conn, end.internal);
      }

      const endsKey = JSON.stringify([
        endA?.anchor.point ?? null, endA?.anchor.side ?? null, endB?.anchor.point ?? null, endB?.anchor.side ?? null,
        conn.route ?? null,
      ]);
      const key = `${obsKey}|${endsKey}`;
      seen.add(conn);
      let cached = this.routeCache.get(conn);
      if (!cached || cached.key !== key) {
        const pts = this.latticeRoute(endA?.anchor ?? null, endB?.anchor ?? null, conn, obstacles);
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
    return { routes, display: laneOffsetRoutes(runs) as Map<Run, Point[]>, sections, sectionParts };
  }

  /** The plan polyline between two lattice anchors (a missing one is the open air: a short stub). */
  private latticeRoute(a: PortAnchor | null, b: PortAnchor | null, conn: Connection, obstacles: Obstacle[]): Point[] | null {
    const stub = (anchor: PortAnchor): Point[] | null => {
      if (!anchor.out) return null;
      const v = sideVector(anchor.side);
      return [anchor.point, anchor.out, { x: anchor.out.x + v.x * TILE_M, y: anchor.out.y + v.y * TILE_M }];
    };
    if (a && !b) return stub(a);
    if (b && !a) return stub(b);
    if (!a || !b) return null;
    if (conn.route && conn.route.length >= 2) return reanchorRoute(conn.route, a, b);
    return autoRoute(a, b, obstacles);
  }

  // ---------------------------------------------------------------------
  // Section views
  //
  // A standing sprite is the component's front elevation drawn on its plan
  // footprint, so within that drawing screen-y is height. A component
  // contained by such a sprite is therefore drawn ON it, at its real
  // elevation and lateral offset - the container's sprite is a section view
  // - and a connection between two things in the same section view is drawn
  // there too. A connection that leaves the container is split at the wall:
  // inside, a run from the port to the penetration at the outside end's
  // elevation; outside, an ordinary lattice route from the wall onward.
  // Buildings, pools and the other ground-layer things are floors, not
  // frames: what they hold stands on the plan as before.
  // ---------------------------------------------------------------------

  private setPlant(plantState: PlantState): void {
    if (this.plant !== plantState) this.frameCache.clear();
    this.plant = plantState;
  }

  /** Whether a component is drawn as a standing sprite that others can be drawn inside. */
  private isSectionFrame(c: PlantComponent): boolean {
    return c.type !== 'pipe' && !(c as any).isHydraulicOnly && !this.isGroundLayer(c);
  }

  /** The nearest container drawn as a sprite, whose section view the component is drawn in. */
  private sectionFrameOf(c: PlantComponent): PlantComponent | null {
    if (!c.containedBy || !this.plant) return null;
    const cached = this.frameCache.get(c.id);
    if (cached !== undefined) return cached;
    let frame: PlantComponent | null = null;
    const seen = new Set<string>([c.id]);
    let cur: PlantComponent | undefined = c;
    while (cur?.containedBy && !seen.has(cur.containedBy)) {
      seen.add(cur.containedBy);
      cur = this.plant.components.get(cur.containedBy);
      if (cur && this.isSectionFrame(cur)) { frame = cur; break; }
    }
    this.frameCache.set(c.id, frame);
    return frame;
  }

  /** The outermost container whose section view the component is drawn in, or null if it stands on the plan. */
  private sectionRootOf(c: PlantComponent): PlantComponent | null {
    let root: PlantComponent | null = null;
    let frame = this.sectionFrameOf(c);
    while (frame) {
      root = frame;
      frame = this.sectionFrameOf(frame);
    }
    return root;
  }

  /** A port's screen position on the sprite it is drawn on (a sprite's own ports, or those of what it holds). */
  private spritePortPosition(c: PlantComponent, portId: string): Point | null {
    const port = c.ports?.find(p => p.id === portId);
    if (!port || !this.isSectionFrame(c)) return null;
    const L = this.spriteLayout(c);
    return { x: L.centerX + port.position.x * L.zoom, y: L.baseY - L.halfHpx + port.position.y * L.zoom };
  }

  /** Height above grade of a port: the component's elevation plus the port's rise above the drawn bottom. */
  private portElevation(c: PlantComponent, portId: string): number {
    const base = c.elevation ?? 0;
    if (c.type === 'pipe') {
      const pipe = c as PipeComponent;
      const port = pipe.ports.find(p => p.id === portId);
      const atEnd = port ? port.position.x > pipe.length / 2 : false;
      return atEnd ? (pipe.endElevation ?? base) : base;
    }
    const port = c.ports?.find(p => p.id === portId);
    if (!port) return base;
    return base + getComponentSize(c).height / 2 - port.position.y;
  }

  /**
   * One end of a connection as the lattice sees it. Given the partner, the
   * wall penetration faces the partner and sits at the partner's own port
   * height (a pipe meets the vessel where the pipe is); with no partner (a
   * vent to the open air, or a route being drawn) it takes the side the port
   * itself faces and the port's own height.
   */
  private latticeEnd(c: PlantComponent, portId: string, partner?: PlantComponent, partnerPortId?: string): LatticeEnd | null {
    const port = c.ports?.find(p => p.id === portId);
    if (!port) return null;
    const root = this.sectionRootOf(c);
    if (!root) {
      // A vessel's side nozzle faces its partner - or the wall of the
      // container the partner is drawn inside
      const anchor = partner && partnerPortId !== undefined
        ? portAnchorFacing(c, portId, this.sectionRootOf(partner)?.position ?? partnerReference(partner, partnerPortId))
        : portAnchor(c, portId);
      return anchor ? { anchor, root: null, internal: null } : null;
    }
    const partnerRoot = partner ? this.sectionRootOf(partner) : null;
    const along = partner && partnerPortId !== undefined
      ? (partnerRoot ? partnerRoot.position : partnerReference(partner, partnerPortId))
      : c.position;
    const side = partner ? sideFacing(root, along) : portSide(port, getComponentSize(c));
    const anchor = wallAnchor(root, port, side, along);
    // Penetration height: the outside end's port, unless that end is inside
    // a section view of its own (then each end keeps its own height)
    const z = partner && partnerPortId !== undefined && !partnerRoot
      ? this.portElevation(partner, partnerPortId)
      : this.portElevation(c, portId);
    const internal = this.internalRun(c, portId, root, anchor, z);
    return internal ? { anchor, root, internal } : null;
  }

  /**
   * The run inside a section view from a port to the wall: down (or up) from
   * the port to the penetration height, across to the wall, then down the
   * wall to where the lattice route picks it up on the plan.
   */
  private internalRun(c: PlantComponent, portId: string, root: PlantComponent, wall: PortAnchor, z: number): Point[] | null {
    const p = this.spritePortPosition(c, portId);
    if (!p) return null;
    const RL = this.spriteLayout(root);
    const yWall = RL.baseY - (z - (root.elevation ?? 0)) * RL.zoom;
    const plan = this.worldToScreen(wall.point);
    const xWall = wall.side === 'E' ? RL.centerX + RL.halfWpx
      : wall.side === 'W' ? RL.centerX - RL.halfWpx
      : plan.x;
    return simplifyRoute([p, { x: p.x, y: yWall }, { x: xWall, y: yWall }, { x: xWall, y: plan.y }, plan]);
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
    this.clampToTerrain();
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
    this.clampToTerrain();
  }

  /** Zoom by a factor keeping the world point under `screen` fixed. */
  zoomAt(screen: Point, factor: number): void {
    const before = this.screenToWorld(screen);
    this.cam.ppm = this.clampPpm(this.cam.ppm * factor);
    const after = this.screenToWorld(screen);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clampToTerrain();
  }

  /** Zoom relative to the default scale (1 = DEFAULT_PPM), about the canvas centre. */
  get zoomFactor(): number {
    return this.cam.ppm / GridView.DEFAULT_PPM;
  }

  setZoomFactor(z: number): void {
    this.cam.ppm = this.clampPpm(z * GridView.DEFAULT_PPM);
    this.clampToTerrain();
  }

  /**
   * The world rectangle the camera may look at: the height field plus a
   * cell of shoulder. A plant with no terrain has no edge to fall off, so
   * it gets none of this and pans as far as the player likes.
   */
  private cameraBounds(): PlanRect | null {
    const t = this.terrainCache;
    if (!t) return null;
    const m = t.spec.cellSize;
    return { x0: t.extent.x0 - m, y0: t.extent.y0 - m, x1: t.extent.x1 + m, y1: t.extent.y1 + m };
  }

  /**
   * Zoom limits. On a plant with terrain the far end is "the whole map on
   * screen": zooming out past that would only add empty space beyond the
   * edge of the world.
   */
  private clampPpm(ppm: number): number {
    const b = this.cameraBounds();
    let min = GridView.MIN_PPM;
    if (b) {
      const fit = Math.min(this.size.width / (b.x1 - b.x0), this.size.height / (b.y1 - b.y0));
      min = Math.max(min, Math.min(GridView.MAX_PPM, fit));
    }
    return Math.max(min, Math.min(GridView.MAX_PPM, ppm));
  }

  /**
   * Keep the view inside the map. Along an axis where the map is smaller
   * than the viewport the camera is centred on it instead - there is nowhere
   * to pan to, so drifting would only slide the map about.
   */
  private clampToTerrain(): void {
    const b = this.cameraBounds();
    if (!b) return;
    this.cam.ppm = this.clampPpm(this.cam.ppm);
    const halfW = this.size.width / 2 / this.cam.ppm;
    const halfH = this.size.height / 2 / this.cam.ppm;
    this.cam.x = b.x1 - b.x0 <= 2 * halfW
      ? (b.x0 + b.x1) / 2
      : Math.min(Math.max(this.cam.x, b.x0 + halfW), b.x1 - halfW);
    this.cam.y = b.y1 - b.y0 <= 2 * halfH
      ? (b.y0 + b.y1) / 2
      : Math.min(Math.max(this.cam.y, b.y0 + halfH), b.y1 - halfH);
  }

  /**
   * Centre the camera on the plant and zoom so all of it is in view (never
   * closer than the default scale). With no plant, look at the origin.
   */
  centerOn(plantState: PlantState): void {
    this.setPlant(plantState);
    this.terrainDataFor(plantState.terrain);
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
      this.cam.ppm = this.clampPpm(GridView.DEFAULT_PPM);
      this.clampToTerrain();
      return;
    }
    // Fit into the part of the canvas nothing is standing on...
    const free = {
      w: Math.max(80, this.size.width - this.insets.left - this.insets.right),
      h: Math.max(80, this.size.height - this.insets.top - this.insets.bottom),
    };
    const margin = 4 * TILE_M;
    const fitPpm = Math.min(
      free.w / (maxX - minX + 2 * margin),
      free.h / (maxY - minY + 2 * margin));
    this.cam.ppm = this.clampPpm(Math.min(GridView.DEFAULT_PPM, fitPpm));
    // ...and put the plant's middle in the middle of THAT, not of the canvas:
    // the camera sits at the canvas centre, so offset it by however far the
    // free area's centre is from there.
    const freeCentre = {
      x: this.insets.left + free.w / 2,
      y: this.insets.top + free.h / 2,
    };
    this.cam.x = (minX + maxX) / 2 - (freeCentre.x - this.size.width / 2) / this.cam.ppm;
    this.cam.y = (minY + maxY) / 2 - (freeCentre.y - this.size.height / 2) / this.cam.ppm;
    this.clampToTerrain();
  }

  // ---------------------------------------------------------------------
  // Snapping
  // ---------------------------------------------------------------------

  snapPlacement(componentType: string, pos: Point): Point {
    return snapPlacementCenter(componentType, pos);
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
    // switchyard's apron, a pool (a hole in it), and a tank that is really a
    // body of open water - the terrain has already painted that one, so it
    // gets no pad and no sprite, only its nozzle.
    return component.type === 'building' || component.type === 'switchyard' ||
      component.type === 'pool' || component.type === 'warehouse' ||
      waterBodyOf(component as never) !== undefined;
  }

  /**
   * Whether a world point is standing in a given terrain water body. This is
   * what makes the sea clickable: the component has no drawn body, so the
   * water IS its hit area.
   */
  private onWaterBody(plantState: PlantState, bodyId: string, world: Point): boolean {
    const t = this.terrainDataFor(plantState.terrain);
    if (!t) return false;
    if (world.x < t.extent.x0 || world.x > t.extent.x1 ||
        world.y < t.extent.y0 || world.y > t.extent.y1) return false;
    const cell = terrainCellAt(t.spec, world);
    if (cell < 0) return false;
    const basin = t.model.basins[t.model.basinOf[cell]];
    return basin?.water?.id === bodyId && t.spec.heights[cell] < basin.water.surface;
  }

  private spriteLayout(component: PlantComponent): SpriteLayout {
    const size = getComponentSize(component);
    const fp = componentFootprint(component);
    const rect = footprintRect(component.position, fp);
    const visualH = getComponentVisualHeight(component);
    const largest = Math.max(size.width, visualH);
    const spriteScale = largest > 0 && largest < MIN_SPRITE_TILES * TILE_M ? (MIN_SPRITE_TILES * TILE_M) / largest : 1;
    const frame = this.sectionFrameOf(component);
    if (frame) {
      // Drawn inside the container's section view: at the container's
      // scale, offset laterally by the plan offset and vertically by the
      // difference in elevation (both stored above grade). No depth axis -
      // a section has none.
      const FL = this.spriteLayout(frame);
      return {
        fp, rect, zoom: FL.zoom, frame,
        centerX: FL.centerX + (component.position.x - frame.position.x) * FL.zoom,
        baseY: FL.baseY - ((component.elevation ?? 0) - (frame.elevation ?? 0)) * FL.zoom,
        halfHpx: (size.height / 2) * FL.zoom,
        halfWpx: (size.width / 2) * FL.zoom,
      };
    }
    const zoom = this.cam.ppm * spriteScale;
    // A sprite standing on the plan sits on its pad regardless of elevation
    // (the elevation is labelled instead): a raised duct floating above the
    // pipes that meet it reads as detached, not as high
    const south = this.worldToScreen({ x: component.position.x, y: rect.y1 });
    return {
      fp, rect, zoom, frame: null,
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
    if (waterBodyOf(component as never)) {
      // No drawn body: hang the gauges off the nozzle, which is where the
      // player's pipe meets the water and where they will be looking.
      const anchors = portAnchors(component);
      if (anchors.length === 0) return null;
      const pts = anchors.map(a => this.worldToScreen(a.point));
      const pad = this.portRadius() + 4;
      return {
        left: Math.min(...pts.map(p => p.x)) - pad,
        right: Math.max(...pts.map(p => p.x)) + pad,
        top: Math.min(...pts.map(p => p.y)) - pad,
        bottom: Math.max(...pts.map(p => p.y)) + pad,
      };
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
    if (this.sectionFrameOf(component)) {
      const s = this.spritePortPosition(component, portId);
      return s ? { x: s.x, y: s.y, radius: this.portRadius() } : null;
    }
    const a = portAnchor(component, portId);
    if (!a) return null;
    const s = this.worldToScreen(a.point);
    return { x: s.x, y: s.y, radius: this.portRadius() };
  }

  /**
   * Every port of a component with where it is drawn and which way its
   * marker faces: on the plan at the footprint edge, or on the container's
   * sprite for a component drawn inside a section view.
   */
  private drawnPorts(component: PlantComponent): Array<{ port: Port; screen: Point; side: Side }> {
    if (!this.sectionFrameOf(component)) {
      return portAnchors(component).map(a => ({ port: a.port, screen: this.worldToScreen(a.point), side: a.side }));
    }
    const size = getComponentSize(component);
    const out: Array<{ port: Port; screen: Point; side: Side }> = [];
    for (const port of component.ports ?? []) {
      const screen = this.spritePortPosition(component, port.id);
      if (screen) out.push({ port, screen, side: portSide(port, size) });
    }
    return out;
  }

  private portRadius(): number {
    return Math.max(5, Math.min(14, this.cam.ppm * 0.22));
  }

  /**
   * Everything drawn for one connection, as screen polylines: the lattice
   * route (if any) and the runs inside section views (test and assistant
   * hook; the renderer draws from the same layout).
   */
  connectionScreenPolylines(conn: Connection, plantState: PlantState): { lattice: Point[] | null; sections: Point[][] } {
    this.setPlant(plantState);
    const layout = this.currentLayout(plantState);
    const route = layout.display.get(conn);
    return {
      lattice: route ? route.map(p => this.worldToScreen(p)) : null,
      sections: layout.sectionParts.get(conn) ?? [],
    };
  }

  /** Where a flow arrow for a connection belongs: the middle of its route, along it. */
  connectionScreenEndpoints(conn: Connection, plantState: PlantState): ConnectionScreenEndpoints | null {
    this.setPlant(plantState);
    const layout = this.currentLayout(plantState);
    const scale = this.cam.ppm / 50;
    const pts = layout.display.get(conn);
    if (!pts) {
      // No lattice run: the whole connection is drawn inside a section view
      const parts = layout.sectionParts.get(conn);
      if (!parts || parts.length === 0) return null;
      const run = parts[0];
      const lenPx = routeLength(run);
      if (lenPx < 1e-6) return { fromPos: run[0], toPos: run[0], scale };
      const mid = pointAlongRoute(run, 0.5);
      const half = Math.min(TILE_M * 0.5 * this.cam.ppm, lenPx / 4);
      return {
        fromPos: { x: mid.point.x - mid.dir.x * half, y: mid.point.y - mid.dir.y * half },
        toPos: { x: mid.point.x + mid.dir.x * half, y: mid.point.y + mid.dir.y * half },
        scale,
      };
    }
    const len = routeLength(pts);
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
    this.setPlant(plantState);
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
      const body = waterBodyOf(c as never);
      if (body) {
        // The water is the picture, so the water is the hit area - plus the
        // nozzle itself, which may sit a step up the beach.
        if (this.onWaterBody(plantState, body, world)) return c;
        const reach = Math.max(1.5, this.portRadius() / this.cam.ppm);
        for (const a of portAnchors(c)) {
          if (Math.hypot(world.x - a.point.x, world.y - a.point.y) <= reach) return c;
        }
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
    this.setPlant(plantState);
    const world = this.screenToWorld(screen);
    let best: Connection | null = null;
    let bestD = Infinity;
    const layout = this.currentLayout(plantState);
    for (const [run, pts] of layout.display) {
      if (!isConnection(run)) continue;
      const halfWidth = Math.max(this.lineWidthForArea(run.flowArea) / 2, 6) / this.cam.ppm;
      const d = distanceToPolyline(world, pts);
      if (d <= halfWidth && d < bestD) {
        bestD = d;
        best = run;
      }
    }
    // Runs inside section views are screen polylines
    for (const [conn, parts] of layout.sectionParts) {
      const halfWidthPx = Math.max(this.lineWidthForArea(conn.flowArea) / 2, 6);
      for (const pts of parts) {
        const d = distanceToPolyline(screen, pts) / this.cam.ppm;
        if (d * this.cam.ppm <= halfWidthPx && d < bestD) {
          bestD = d;
          best = conn;
        }
      }
    }
    return best;
  }

  portAt(screen: Point, plantState: PlantState, exclude?: string): PortHit | null {
    this.setPlant(plantState);
    const r = this.portRadius() + 3;
    let best: PortHit | null = null;
    let bestKey = Infinity;
    for (const component of plantState.components.values()) {
      if (!component.ports || (component as any).isHydraulicOnly) continue;
      if (exclude && component.id === exclude) continue;
      for (const drawn of this.drawnPorts(component)) {
        const d = Math.hypot(screen.x - drawn.screen.x, screen.y - drawn.screen.y);
        if (d > r) continue;
        const key = d + (drawn.port.connectedTo ? 1000 : 0);
        if (key < bestKey) {
          const end = this.latticeEnd(component, drawn.port.id);
          if (!end) continue;
          bestKey = key;
          best = { component, port: drawn.port, anchor: end.anchor, frameRoot: end.root ?? undefined };
        }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------
  // Routing interaction
  // ---------------------------------------------------------------------

  startRouting(from: PortHit, orientation: PipeOrientation = 'EW'): void {
    this.routing = {
      from,
      waypoints: [from.anchor.out ?? from.anchor.point],
      cursorCell: null,
      target: null,
      dragging: false,
      pressScreen: null,
      // A run from a port drawn inside a container starts at the container's
      // wall, so it is the container's footprint the sweep keeps out of
      sourceRect: from.frameRoot ? footprintRect(from.frameRoot.position, componentFootprint(from.frameRoot))
        : from.component.type === 'pipe' ? null
        : footprintRect(from.component.position, componentFootprint(from.component)),
      orientation,
    };
  }

  /**
   * Start a run on open ground (the pipe tool pressed where there is no
   * port). There is no source component and no footprint to keep out of, so
   * the sweep is free to go anywhere; the run becomes a pipe component.
   */
  startGroundRouting(world: Point, orientation: PipeOrientation): void {
    this.routing = {
      from: null,
      waypoints: [cellCenter(world)],
      cursorCell: cellCenter(world),
      target: null,
      dragging: false,
      pressScreen: null,
      sourceRect: null,
      orientation,
    };
  }

  /** True while a run started on open ground rather than at a port. */
  get routingFromGround(): boolean {
    return this.routing !== null && this.routing.from === null;
  }

  /**
   * The route a ground run has swept, its ends carried out to the tile
   * boundaries so they can meet a neighbour (groundRunRoute). Clears the
   * routing state.
   */
  finishGroundRouting(): Point[] {
    const r = this.routing!;
    const route = groundRunRoute(r.waypoints, r.orientation);
    this.routing = null;
    return route;
  }

  /** The joins a pipe's loose ends make, for the caller that just laid it. */
  freeEndJoins(plantState: PlantState, pipe: PipeComponent) {
    return findFreeEndJoins(plantState, pipe);
  }

  /** Track the cursor: which cell it is over and whether it rests on a finishing port. */
  updateRoutingCursor(screen: Point, plantState: PlantState): void {
    if (!this.routing) return;
    const world = this.screenToWorld(screen);
    this.routing.cursorCell = cellCenter(world);
    this.routing.target = this.routing.from
      ? this.portAt(screen, plantState, this.routing.from.component.id)
      : null;
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

  /**
   * The finished route into a target port, and its plan length. Only a run
   * that started AT a port finishes this way; a ground run has no source
   * port to complete from (finishGroundRouting).
   */
  finishRouting(target: PortHit): { route: Point[]; length: number } {
    const r = this.routing!;
    if (!r.from) {
      throw new Error('[Grid] finishRouting was called on a run laid from open ground. ' +
        'A ground run becomes a pipe component through finishGroundRouting.');
    }
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
    // One place that guarantees the drawn frame is inside the map, whatever
    // moved the camera (a resize, a restored setting, a future caller)
    this.terrainDataFor(f.plantState.terrain);
    this.clampToTerrain();
    this.setPlant(f.plantState);
    this.frameCache.clear();
    this.layout = this.buildLayout(f.plantState);
    const order = this.drawOrder(f.plantState);

    this.renderGround(ctx, f);
    this.renderTerrain(ctx, f);

    // Ground layer: building floors and switchyards, in plan
    for (const c of order) {
      const ghost = buildGhost(c);
      if (ghost) ctx.globalAlpha = GHOST_ALPHA;
      if (c.type === 'building') this.renderBuilding(ctx, c as BuildingComponent, f);
      else if (c.type === 'switchyard') this.renderSwitchyard(ctx, c as SwitchyardComponent, f);
      else if (c.type === 'pool') this.renderPool(ctx, c as PoolComponent, f);
      else if (c.type === 'warehouse') this.renderWarehouse(ctx, c as WarehouseComponent, f);
      else if (waterBodyOf(c as never)) this.renderWaterIntake(ctx, c, f);
      if (ghost) ctx.globalAlpha = 1;
    }

    // Foundation pads under every component standing on the plan (one drawn
    // inside a container's section view stands on nothing)
    for (const c of order) {
      if (this.isGroundLayer(c) || c.type === 'pipe' || this.sectionFrameOf(c)) continue;
      const ghost = buildGhost(c);
      if (ghost) ctx.globalAlpha = GHOST_ALPHA;
      this.renderPad(ctx, c, f);
      if (ghost) ctx.globalAlpha = 1;
    }

    this.renderRoutes(ctx, f);

    // Standing sprites, back to front. The runs inside a container's section
    // view go on right after its sprite, under the sprites of what it holds
    // (which the draw order puts later: deeper containment draws later)
    for (const c of order) {
      if (this.isGroundLayer(c) || c.type === 'pipe') continue;
      const ghost = buildGhost(c);
      if (ghost) ctx.globalAlpha = GHOST_ALPHA;
      this.renderSprite(ctx, c, f);
      if (ghost) ctx.globalAlpha = 1;
      const inside = this.layout?.sections.get(c.id);
      if (inside) this.renderSectionRuns(ctx, f, inside);
    }

    this.renderBuildProgress(ctx, f);

    this.renderSignalLines(ctx, f);

    if (f.selectedConnection) this.renderConnectionLabel(ctx, f, f.selectedConnection);
    if (f.showPorts) this.renderPorts(ctx, f);
    if (this.routing) this.renderRouting(ctx, f);
    // While a run is being drawn, THAT is the preview - a pipe-tool section
    // preview under the cursor as well would just be two ghosts.
    if (f.placementPreview && f.buildMode && !this.routing) this.renderPlacementPreview(ctx, f);
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
    const terrain = this.terrainDataFor(spec);
    if (!spec || !terrain) return;
    const model = terrain.model;
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

    // A water body that IS a component (see TankComponent.waterBody) lights
    // up when that component is picked, because the water is all the player
    // can see of it - there is no vessel to put a selection box round.
    let litBody: string | undefined;
    let litSelected = false;
    for (const c of f.plantState.components.values()) {
      const body = waterBodyOf(c as never);
      if (!body) continue;
      if (c.id === f.selectedComponentId) { litBody = body; litSelected = true; break; }
      if (c.id === f.hoveredComponentId) { litBody = body; }
    }
    const waterIdOf = (cell: number): string | undefined =>
      model.basins[model.basinOf[cell]]?.water?.id;
    const isLit = (cell: number): boolean => {
      if (litBody === undefined) return false;
      if (waterIdOf(cell) !== litBody) return false;
      const surface = surfaceOf.get(model.basinOf[cell]);
      return surface !== undefined && surface > heights[cell];
    };

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
        if (isLit(c)) {
          ctx.fillStyle = litSelected ? 'rgba(120, 200, 255, 0.30)' : 'rgba(255, 255, 255, 0.16)';
          ctx.fillRect(s.x, s.y, px + 0.5, px + 0.5);
        }
      }
    }

    // ...and an outline round the whole lit body: the edges of lit cells that
    // face a cell which is not lit are its shore.
    if (litBody !== undefined) {
      ctx.strokeStyle = litSelected ? COLORS.selectionHighlight : 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = litSelected ? 3 : 2;
      ctx.beginPath();
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const c = j * cols + i;
          if (!isLit(c)) continue;
          const s = this.worldToScreen({ x: origin.x + i * cellSize - half, y: origin.y + j * cellSize - half });
          if (i === 0 || !isLit(c - 1)) { ctx.moveTo(s.x, s.y); ctx.lineTo(s.x, s.y + px); }
          if (i === cols - 1 || !isLit(c + 1)) { ctx.moveTo(s.x + px, s.y); ctx.lineTo(s.x + px, s.y + px); }
          if (j === 0 || !isLit(c - cols)) { ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + px, s.y); }
          if (j === rows - 1 || !isLit(c + cols)) { ctx.moveTo(s.x, s.y + px); ctx.lineTo(s.x + px, s.y + px); }
        }
      }
      ctx.stroke();
    }

    // Whatever the water has picked up and carried: floating while it is up,
    // left lying on the hillside once it drains away. All of it is in
    // debris-fx.ts - this is the only call site.
    for (const b of model.basins) {
      if (!b.water) continue;
      const surface = surfaceOf.get(b.id);
      if (surface === undefined) continue;
      const basinId = b.id;
      renderFloodDebris(ctx, {
        bodyId: b.water.id,
        baseline: b.water.surface,
        surface,
        simTime: sim?.time ?? 0,
        heightAt: (p) => terrainHeightAt(spec, p),
        wetCells: () => {
          const out: Point[] = [];
          for (let c = 0; c < heights.length; c++) {
            if (model.basinOf[c] !== basinId || heights[c] >= surface) continue;
            out.push({ x: origin.x + (c % cols) * cellSize, y: origin.y + Math.floor(c / cols) * cellSize });
          }
          return out;
        },
        toScreen: (p) => this.worldToScreen(p),
        ppm: this.cam.ppm,
      });
    }

    // Contours: polylines of the interpolated ground (terrain-contours.ts),
    // drawn through their own midpoints as quadratic curves so they bend the
    // way a surveyed contour does instead of stepping along cell edges. The
    // geometry is world-space and cached with the height field; only the
    // projection happens per frame.
    if (px >= 3) {
      for (const set of terrain.contours) {
        ctx.strokeStyle = set.major ? 'rgba(60, 45, 20, 0.65)' : 'rgba(60, 45, 20, 0.3)';
        ctx.lineWidth = set.major ? 1.5 : 1;
        ctx.beginPath();
        for (const line of set.lines) this.traceSmooth(ctx, line);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Add a world-space polyline to the current path as a smooth curve: each
   * vertex is the control point of a quadratic that runs between the
   * midpoints of the segments meeting there. Off-screen lines are skipped
   * whole - a contour is one long line and clipping it per segment would cost
   * more than letting the canvas reject it.
   */
  private traceSmooth(ctx: CanvasRenderingContext2D, line: Point[]): void {
    if (line.length < 2) return;
    const pts = line.map(p => this.worldToScreen(p));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (maxX < 0 || minX > this.size.width || maxY < 0 || minY > this.size.height) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i + 1 < pts.length; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
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
   * A spent-fuel pool as a cut-away three-quarter view.
   *
   * A pool is read as ONE question - is there water over the fuel - and a
   * flat plan square plus a separate bar answered it twice, badly: the plan
   * cannot show depth at all, so the level lived in a gauge on the rim while
   * the picture stayed the same colour. Here the basin is drawn as an open
   * box in oblique projection with the SOUTH and WEST walls sectioned away,
   * so the water is a solid with a top surface AND a visible depth against
   * the cut, and the racks stand on the floor inside it. The level is then
   * something you see rather than something you read off a scale beside the
   * picture (the number stays, next to it).
   *
   * The projection is a cabinet oblique confined to the component's own
   * footprint: nothing is drawn outside it but the coping, so ports, hit
   * testing and pipe routing are exactly as they were.
   *
   *   P(u, v, w) -> screen
   *     u  0..1  west  -> east   across the footprint
   *     v  0..1  north -> south  into the picture (toward the viewer)
   *     w  0..1  floor -> rim
   *
   * The viewer is above, south and west, so the visible interior faces are
   * the NORTH wall, the EAST wall and the floor - the two walls facing the
   * camera are the ones taken away.
   *
   * Nothing here decides anything: `poolReadout` is the single source the
   * selected-component panel reads too, so the picture and the numbers
   * cannot drift apart.
   */
  private renderPool(ctx: CanvasRenderingContext2D, pool: PoolComponent, f: GridFrameState): void {
    const rect = footprintRect(pool.position, componentFootprint(pool));
    const tl = this.worldToScreen({ x: rect.x0, y: rect.y0 });
    const br = this.worldToScreen({ x: rect.x1, y: rect.y1 });
    const W = br.x - tl.x, H = br.y - tl.y;
    if (!(W > 2 && H > 2)) return;
    // The coping is the real wall thickness, but a thick wall on a small
    // basin would swamp the picture, so it stops at a sixth of the opening.
    // The deck around the opening is the real wall thickness, as a fraction
    // of the pool's own plan side; a thick wall on a small basin would swamp
    // the picture, so it stops at a sixth of the opening.
    const cop = Math.min(0.16, Math.max(0.03,
      (pool.wallThickness || 1.5) / Math.max(pool.side || 12, 1e-6)));
    const copingPx = cop * (br.x - tl.x);
    const origin = this.worldToScreen({ x: 0, y: 0 });

    const r = poolReadout(pool, f.simState, !f.constructionMode);
    const lf = Math.max(0, Math.min(1, r.level / Math.max(r.depth, 1e-6)));

    // --- the oblique frame -------------------------------------------------
    // SH is how far the far edge slides west of the near edge, Hz the drawn
    // height of the wall and Dy what is left of the footprint for the floor.
    // Hz + Dy = H and the shear is taken out of W, so the whole box lands
    // inside the footprint whatever its aspect.
    const SH = W * 0.12;
    const Hz = H * 0.42;
    const Dy = H - Hz;
    const P = (u: number, v: number, w: number): Point => ({
      x: tl.x + u * (W - SH) + v * SH,
      y: tl.y + Hz + v * Dy - w * Hz,
    });
    const poly = (pts: Point[]) => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    };
    const fillPoly = (pts: Point[], style: string | CanvasGradient) => {
      ctx.fillStyle = style;
      poly(pts);
      ctx.fill();
    };

    // Rim corners (w = 1) and floor corners (w = 0)
    const rNW = P(0, 0, 1), rNE = P(1, 0, 1), rSE = P(1, 1, 1);
    const fNW = P(0, 0, 0), fNE = P(1, 0, 0), fSE = P(1, 1, 0), fSW = P(0, 1, 0);

    // --- coping on the two walls that are still standing -------------------
    // The deck is a slab in the SAME projection as the basin, so its width is
    // the wall thickness expressed as a fraction of the pool's side and then
    // pushed through the two axes - not a fixed number of screen pixels,
    // which would make the north deck and the east deck disagree about how
    // thick the same wall is.
    const nOut = { x: -cop * SH, y: -cop * Dy };
    const sOut = { x: cop * SH, y: cop * Dy };
    const eOut = { x: cop * (W - SH), y: 0 };
    const wOut = { x: -cop * (W - SH), y: 0 };
    const add = (p: Point, ...ds: Point[]) =>
      ds.reduce((a, d) => ({ x: a.x + d.x, y: a.y + d.y }), p);

    ctx.fillStyle = this.art.pattern(ctx, 'concrete', this.cam.ppm, origin);
    poly([add(rNW, nOut), add(rNE, nOut, eOut), add(rSE, eOut), rSE, rNE, rNW]);
    ctx.fill();
    ctx.strokeStyle = 'rgba(50, 50, 50, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // --- the two sectioned walls ------------------------------------------
    // Hatched concrete along the cut, the ordinary drawing convention for
    // "this has been sawn through so you can see inside".
    const cutBands: Point[][] = [
      [fSW, fSE, add(fSE, sOut), add(fSW, sOut)],
      [fNW, fSW, add(fSW, wOut), add(fNW, wOut)],
    ];
    for (const band of cutBands) {
      fillPoly(band, 'rgba(150, 146, 138, 0.95)');
      ctx.save();
      poly(band);
      ctx.clip();
      ctx.strokeStyle = 'rgba(70, 68, 64, 0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const step = Math.max(4, copingPx * 0.5);
      const x0 = Math.min(...band.map(p => p.x)) - H, x1 = Math.max(...band.map(p => p.x)) + H;
      const yA = Math.min(...band.map(p => p.y)), yB = Math.max(...band.map(p => p.y));
      for (let x = x0; x < x1; x += step) {
        ctx.moveTo(x, yB); ctx.lineTo(x + (yB - yA), yA);
      }
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(40, 40, 40, 0.8)';
      ctx.lineWidth = 1;
      poly(band);
      ctx.stroke();
    }

    // --- the empty basin: two inner walls and the floor --------------------
    fillPoly([rNW, rNE, fNE, fNW], '#3b4247');          // north wall, in shade
    fillPoly([rNE, rSE, fSE, fNE], '#4a5359');          // east wall, lit
    fillPoly([fNW, fNE, fSE, fSW], '#2b3033');          // floor
    // Liner seams, so the empty basin does not read as a flat grey hole
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 1; k < 4; k++) {
      const u = k / 4, v = k / 4;
      const a = P(u, 0, 1), b = P(u, 0, 0), c = P(u, 1, 0);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y);
      const d = P(0, v, 0), e = P(1, v, 0);
      ctx.moveTo(d.x, d.y); ctx.lineTo(e.x, e.y);
    }
    ctx.stroke();

    // --- racks -------------------------------------------------------------
    // The stored assemblies, standing on the floor between rackBottom and
    // rackTop. Each column is drawn twice: the part under water before the
    // water goes on (so it is seen THROUGH it) and the part standing out of
    // it afterwards, which is exactly where the heat-transfer model stops
    // wetting the rack surface.
    const wBot = Math.max(0, Math.min(1, r.rackBottom / Math.max(r.depth, 1e-6)));
    const wTop = Math.max(wBot, Math.min(1, r.rackTop / Math.max(r.depth, 1e-6)));
    const glow = poolRackGlow(r.cladK ?? r.waterK);
    const cells = Math.max(2, Math.min(8, Math.round(Math.sqrt(pool.assemblyCount || 800) / 4)));
    const inset = 0.10;
    const pitch = (1 - 2 * inset) / cells;
    const gap = pitch * 0.16;

    const rackShade = (base: number) => {
      // Steel grey, going orange-white with the cladding temperature. The
      // three faces differ only in how much light they get.
      const rC = Math.round((104 + 161 * glow) * base);
      const gC = Math.round((114 + 44 * glow) * base);
      const bC = Math.round((122 - 82 * glow) * base);
      return `rgb(${Math.max(0, Math.min(255, rC))}, ${Math.max(0, Math.min(255, gC))}, ` +
        `${Math.max(0, Math.min(255, bC))})`;
    };
    const drawRacks = (wLo: number, wHi: number) => {
      if (!(wHi > wLo) || pitch * Math.min(W, Dy) < 1.5) return;
      for (let j = 0; j < cells; j++) {            // north to south: painter order
        const v0 = inset + j * pitch + gap / 2, v1 = inset + (j + 1) * pitch - gap / 2;
        for (let i = cells - 1; i >= 0; i--) {     // east first: the lit face
          const u0 = inset + i * pitch + gap / 2, u1 = inset + (i + 1) * pitch - gap / 2;
          fillPoly([P(u0, v0, wHi), P(u1, v0, wHi), P(u1, v1, wHi), P(u0, v1, wHi)], rackShade(1.15));
          fillPoly([P(u0, v1, wHi), P(u1, v1, wHi), P(u1, v1, wLo), P(u0, v1, wLo)], rackShade(0.85));
          fillPoly([P(u1, v0, wHi), P(u1, v1, wHi), P(u1, v1, wLo), P(u1, v0, wLo)], rackShade(0.62));
        }
      }
    };
    drawRacks(wBot, Math.min(wTop, lf));

    // --- the water ---------------------------------------------------------
    // One solid: a top surface, and the two faces the section exposes. The
    // depth of the near face IS the level - that is the whole point of
    // cutting the wall away.
    if (lf > 1e-4) {
      const hot = r.waterK > 368;                  // steaming rather than still
      const surf = hot ? '150, 190, 205' : '58, 128, 178';
      const body = hot ? '120, 165, 185' : '24, 78, 128';
      const topQuad = [P(0, 0, lf), P(1, 0, lf), P(1, 1, lf), P(0, 1, lf)];
      fillPoly(topQuad, `rgba(${surf}, 0.34)`);
      // A brighter band along the far edge reads as the light on the surface
      const sheen = ctx.createLinearGradient(0, P(0, 0, lf).y, 0, P(0, 1, lf).y);
      sheen.addColorStop(0, `rgba(235, 245, 250, 0.28)`);
      sheen.addColorStop(0.45, 'rgba(235, 245, 250, 0.03)');
      sheen.addColorStop(1, 'rgba(235, 245, 250, 0.10)');
      fillPoly(topQuad, sheen);

      const cutFace = (pts: Point[], darken: number) => {
        const yTop = Math.min(...pts.map(p => p.y)), yBot = Math.max(...pts.map(p => p.y));
        const g = ctx.createLinearGradient(0, yTop, 0, yBot);
        g.addColorStop(0, `rgba(${body}, ${(0.46 * darken).toFixed(3)})`);
        g.addColorStop(1, `rgba(${body}, ${(0.74 * darken).toFixed(3)})`);
        fillPoly(pts, g);
      };
      cutFace([P(0, 1, lf), P(1, 1, lf), P(1, 1, 0), P(0, 1, 0)], 1.0);   // south cut
      cutFace([P(0, 0, lf), P(0, 1, lf), P(0, 1, 0), P(0, 0, 0)], 0.85);  // west cut
      // The free surface itself, drawn as a line all the way round the cut
      ctx.strokeStyle = 'rgba(215, 240, 250, 0.9)';
      ctx.lineWidth = Math.max(1, Math.min(2.5, H * 0.008));
      ctx.beginPath();
      const s0 = P(0, 0, lf), s1 = P(0, 1, lf), s2 = P(1, 1, lf);
      ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y);
      ctx.stroke();
    }

    drawRacks(Math.max(wBot, lf), wTop);

    // --- where the top of the fuel is --------------------------------------
    // The one line that matters, drawn on the section at the height of the
    // top of the active fuel: water above it means the racks are covered.
    if (H > 40) {
      // Round both cut faces, so it is visible whichever way the pool is
      // being looked at and whatever the level is doing.
      const t0 = P(0, 0, wTop), t1 = P(0, 1, wTop), t2 = P(1, 1, wTop);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(255, 105, 70, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(t0.x, t0.y); ctx.lineTo(t1.x, t1.y); ctx.lineTo(t2.x, t2.y);
      ctx.stroke();
      ctx.restore();
    }

    // --- a metre scale up the near cut -------------------------------------
    // The level is drawn, so what it needs beside it is a ruler, not a bar.
    if (Hz > 34) {
      const sx = P(1, 1, 0).x;
      ctx.strokeStyle = 'rgba(230, 235, 240, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const stepM = r.depth > 24 ? 5 : r.depth > 10 ? 2 : 1;
      for (let m = 0; m <= r.depth + 1e-6; m += stepM) {
        const p = P(1, 1, m / r.depth);
        ctx.moveTo(sx, p.y);
        ctx.lineTo(sx - Math.max(3, W * 0.03), p.y);
      }
      ctx.stroke();
    }

    // --- outline and selection --------------------------------------------
    ctx.strokeStyle = r.state === 'covered'
      ? 'rgba(180, 210, 230, 0.75)' : 'rgba(230, 140, 60, 0.95)';
    ctx.lineWidth = 2;
    poly([rNW, rNE, rSE, fSE, fSW, fNW]);
    ctx.stroke();

    // --- readouts ----------------------------------------------------------
    const fontPx = Math.max(9, Math.min(16, this.cam.ppm * 0.45));
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
    ctx.fillText(pool.label || pool.id, rNW.x + 2, rNW.y - 3);

    if (H > 60 && W > 70) {
      // BELOW the section, never on it: the depth of water drawn against the
      // cut IS the level readout, and a plate parked over it would hide the
      // one thing this drawing exists to show.
      const state = poolStateLabel(r.state);
      const lines: Array<{ text: string; color: string }> = [
        { text: `${formatGaugeValue(r.level)} m  (${r.overFuel >= 0 ? '+' : ''}` +
            `${formatGaugeValue(r.overFuel)} m over fuel)`, color: 'rgba(240, 245, 250, 0.97)' },
        { text: state.text + (r.cladK !== null
            ? `   rack ${(r.cladK - 273.15).toFixed(0)} °C` : ''), color: state.color },
      ];
      if (r.reacting) {
        lines.push({
          text: `oxidation ${(r.oxidationW / 1e6).toFixed(1)} MW  ` +
            `(${(r.oxidizedFraction * 100).toFixed(1)}% clad)`,
          color: '#ff9a4a',
        });
      }
      const lh = fontPx * 1.25;
      const plateH = lh * lines.length + 6;
      const px = tl.x + 2;
      const py = tl.y + H + copingPx + 3;
      let plateW = 0;
      ctx.font = `${fontPx}px monospace`;
      for (const l of lines) plateW = Math.max(plateW, ctx.measureText(l.text).width);
      ctx.fillStyle = 'rgba(12, 16, 20, 0.62)';
      ctx.fillRect(px - 3, py - 2, plateW + 8, plateH);
      ctx.textBaseline = 'top';
      lines.forEach((l, k) => {
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, px, py + 2 + k * lh);
      });
    }

    if (pool.id === f.selectedComponentId || pool.id === f.hoveredComponentId) {
      ctx.lineWidth = pool.id === f.selectedComponentId ? 3 : 2;
      ctx.strokeStyle = COLORS.selectionHighlight;
      poly([add(rNW, nOut), add(rNE, nOut, eOut), add(rSE, eOut),
            add(fSE, eOut, sOut), add(fSW, sOut, wOut), add(fNW, wOut)]);
      ctx.stroke();
    }
  }

  /**
   * A component that IS a body of water has no body to draw - the terrain
   * has already painted it. All that is left is the one thing the player
   * needs to find: where its nozzle meets the shore. A short jetty stub and
   * the name, nothing more, so the water still reads as water.
   */
  private renderWaterIntake(ctx: CanvasRenderingContext2D, c: PlantComponent, f: GridFrameState): void {
    const anchors = portAnchors(c);
    if (anchors.length === 0) return;
    const lit = c.id === f.selectedComponentId || c.id === f.hoveredComponentId;
    const r = Math.max(3, this.portRadius() * 0.7);
    for (const a of anchors) {
      const s = this.worldToScreen(a.point);
      const back = a.out ? this.worldToScreen(a.out) : s;
      // A stub from the water out to the anchor: the jetty the pipe lands on
      ctx.strokeStyle = lit ? COLORS.selectionHighlight : 'rgba(60, 60, 62, 0.85)';
      ctx.lineWidth = Math.max(2, r * 0.7);
      ctx.beginPath();
      ctx.moveTo(back.x, back.y);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(150, 158, 165, 0.95)';
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(25, 30, 34, 0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const s = this.worldToScreen(anchors[0].point);
    const fontPx = Math.max(8, Math.min(15, this.cam.ppm * 0.42));
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(225, 235, 245, 0.9)';
    ctx.fillText(c.label || c.id, s.x, s.y - r - 3);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
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

    // One line per stack, NAMED: a yard that hands out a specified design is
    // lying if it just says "2x pump". The pipe line names its size the same
    // way when the yard holds one standardized spec.
    ctx.font = `${fontPx}px monospace`;
    ctx.textBaseline = 'top';
    const rows = [stock.pipeSpec
      ? `${formatGaugeValue(stock.pipeMeters)} m  ${pipeSpecDisplayName(stock.pipeSpec)}`
      : `${formatGaugeValue(stock.pipeMeters)} m pipe`];
    for (const line of stockedLines(stock)) {
      rows.push(`${line.count}x ${stockLineDisplayName(line.type, line.design, line.count !== 1)}`);
    }
    // Dark plate behind the readout so it survives the gravel pattern
    const rowH = fontPx + 2;
    const textW = Math.max(...rows.map(r => ctx.measureText(r).width));
    ctx.fillStyle = 'rgba(15, 18, 20, 0.6)';
    ctx.fillRect(tl.x + 1, br.y + 1, textW + 6, rows.length * rowH + 4);
    ctx.fillStyle = 'rgba(235, 240, 245, 0.95)';
    rows.forEach((row, i) => ctx.fillText(row, tl.x + 4, br.y + 3 + i * rowH));

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
    const items = stockedLines(stock);
    const CRATE_COLS = 2;
    const crateSize = Math.max(4, Math.min(crateW / CRATE_COLS - 2, inH / 4));
    let slot = 0;
    for (const { type, count } of items) {
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

  /**
   * Concrete foundation with a soft shadow.
   *
   * The slab stands OUT past the footprint, the way the pool's coping does,
   * because a component's footprint is the thing itself: a round tank drawn
   * inside its own square footprint hid the pad completely and the tank read
   * as standing on bare gravel. A border of slab around it is what makes it
   * read as founded.
   */
  private renderPad(ctx: CanvasRenderingContext2D, c: PlantComponent, f: GridFrameState): void {
    const rect = footprintRect(c.position, componentFootprint(c));
    const tl = this.worldToScreen({ x: rect.x0, y: rect.y0 });
    const br = this.worldToScreen({ x: rect.x1, y: rect.y1 });
    const w = br.x - tl.x, h = br.y - tl.y;
    const origin = this.worldToScreen({ x: 0, y: 0 });
    // A margin of slab, in metres, so the border stays put as the view zooms
    const out = Math.max(2, Math.min(1.5, Math.min(w, h) / this.cam.ppm * 0.09) * this.cam.ppm);
    const x = tl.x - out, y = tl.y - out, pw = w + 2 * out, ph = h + 2 * out;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(x + 2, y + 3, pw, ph);
    ctx.fillStyle = this.art.pattern(ctx, 'pad', this.cam.ppm, origin);
    ctx.fillRect(x, y, pw, ph);
    // Bevel: light top/left, dark bottom/right
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath();
    ctx.moveTo(x, y + ph); ctx.lineTo(x, y); ctx.lineTo(x + pw, y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.moveTo(x + pw, y); ctx.lineTo(x + pw, y + ph); ctx.lineTo(x, y + ph);
    ctx.stroke();
    // A hairline on the footprint itself, so the slab reads as a border
    // around the thing rather than as a bigger thing
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.strokeRect(tl.x + 0.5, tl.y + 0.5, w - 1, h - 1);

    if (c.id === f.hoveredComponentId && f.buildMode) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, pw, ph);
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

    // A sprite drawn inside a section view is drawn AT its elevation, so
    // only a sprite standing on the plan needs the label
    const elevation = c.elevation ?? 0;
    if (elevation !== 0 && !L.frame) {
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

  /**
   * Rings over everything still being installed (or taken away).
   *
   * Drawn after the plant, before the overlays, so a ghost reads as
   * something that is going to be there rather than something that is
   * broken. The ring is the only moving part - the ghosting itself is a
   * flat alpha on the ordinary drawing, so a part looks like what it will
   * be, only fainter.
   */
  private renderBuildProgress(ctx: CanvasRenderingContext2D, f: GridFrameState): void {
    for (const c of f.plantState.components.values()) {
      const g = buildGhost(c);
      if (!g) continue;
      const b = this.componentScreenBounds(c);
      if (!b) continue;
      // Hoarding round the site: a dashed box on the tiles the part will
      // stand on, so a faint sprite still reads as work in progress.
      if (c.type !== 'pipe') {
        const rect = footprintRect(c.position, componentFootprint(c));
        const tl = this.worldToScreen({ x: rect.x0, y: rect.y0 });
        const br = this.worldToScreen({ x: rect.x1, y: rect.y1 });
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = g.kind === 'build'
          ? 'rgba(90, 200, 255, 0.8)' : 'rgba(255, 175, 70, 0.8)';
        ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        ctx.restore();
      }
      drawBuildProgress(ctx, b.topCenter.x, b.topCenter.y + b.height / 2,
        Math.min(b.width, b.height) * 0.36, g.progress, g.kind);
    }
    const layout = this.currentLayout(f.plantState);
    for (const [run, pts] of layout.display) {
      if (!isConnection(run)) continue;
      const g = buildGhost(run);
      if (!g || pts.length < 2) continue;
      const mid = pts[Math.floor(pts.length / 2)];
      const s = this.worldToScreen(mid);
      drawBuildProgress(ctx, s.x, s.y, Math.max(9, this.cam.ppm * 0.5), g.progress, g.kind);
    }
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
      const ghost = buildGhost(pipe);
      if (ghost) ctx.globalAlpha = GHOST_ALPHA;
      this.drawPipe(ctx, pts.map(p => this.worldToScreen(p)), color, this.lineWidthForDiameter(pipe.diameter || 0.3), pipe.id === f.selectedComponentId);
      if (ghost) ctx.globalAlpha = 1;
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
      const ghost = buildGhost(conn);
      if (ghost) ctx.globalAlpha = GHOST_ALPHA;
      this.drawPipe(ctx, pts.map(p => this.worldToScreen(p)), color, this.lineWidthForArea(conn.flowArea), touchesSelection);
      if (ghost) ctx.globalAlpha = 1;
    }
  }

  /** The runs inside one container's section view (screen polylines already). */
  private renderSectionRuns(ctx: CanvasRenderingContext2D, f: GridFrameState, runs: SectionRun[]): void {
    const { plantState } = f;
    for (const { conn, pts } of runs) {
      const from = plantState.components.get(conn.fromComponentId) ?? plantState.components.get(conn.toComponentId);
      if (!from) continue;
      const fluid = f.connectionFluid(conn, from);
      const color = fluid ? getFluidColor(fluid) : '#667788';
      const touchesSelection = conn === f.selectedConnection || (f.selectedComponentId !== null &&
        (conn.fromComponentId === f.selectedComponentId || conn.toComponentId === f.selectedComponentId));
      const ghost = buildGhost(conn);
      if (ghost) ctx.globalAlpha = GHOST_ALPHA;
      this.drawPipe(ctx, pts, color, this.lineWidthForArea(conn.flowArea), touchesSelection);
      if (ghost) ctx.globalAlpha = 1;
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
    const layout = this.currentLayout(plantState);
    const route = layout.display.get(conn);
    const inside = layout.sectionParts.get(conn);
    let s: Point;
    if (route) {
      s = this.worldToScreen(pointAlongRoute(route, 0.5).point);
    } else if (inside && inside.length > 0) {
      s = pointAlongRoute(inside[0], 0.5).point;   // already screen pixels
    } else {
      return;
    }

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
    if (f.buildMode) lines.push('click again to edit \u00b7 Delete removes it');

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
      for (const drawn of this.drawnPorts(component)) {
        const s = drawn.screen;
        if (s.x < -20 || s.x > f.width + 20 || s.y < -20 || s.y > f.height + 20) continue;
        const highlighted = !!f.highlightedPort &&
          f.highlightedPort.componentId === component.id && f.highlightedPort.portId === drawn.port.id;
        const isTarget = !!this.routing?.target &&
          this.routing.target.component.id === component.id && this.routing.target.port.id === drawn.port.id;
        const r = highlighted || isTarget ? radius * 1.4 : radius;
        this.drawPortMarker(ctx, s, drawn.side, drawn.port, r, highlighted || isTarget);
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
    const laid = r.from
      ? [r.from.anchor.point, ...r.waypoints]
      : groundRunRoute(r.waypoints, r.orientation);
    let preview: Point[] = [];
    if (r.target) {
      preview = completeRoute(laid, r.target.anchor).slice(laid.length - 1);
    } else if (r.cursorCell && r.from !== null) {
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
    if (componentType === 'pipe') {
      this.renderPipePiecePreview(ctx, f, position);
      return;
    }
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

  /**
   * The ground pipe piece about to be placed: the exact polyline
   * `pipePieceRoute` will hand the construction manager, over the tile it
   * fills, with a marker on each end that would join something. Preview and
   * placement read the same function, so they cannot drift apart.
   */
  private renderPipePiecePreview(ctx: CanvasRenderingContext2D, f: GridFrameState, position: Point): void {
    const route = pipePieceRoute(position, f.pipeOrientation);
    const a = this.worldToScreen(route[0]);
    const b = this.worldToScreen(route[route.length - 1]);
    const cell = cellCenter(position);
    const tl = this.worldToScreen({ x: cell.x - TILE_M / 2, y: cell.y - TILE_M / 2 });
    const br = this.worldToScreen({ x: cell.x + TILE_M / 2, y: cell.y + TILE_M / 2 });

    ctx.save();
    ctx.fillStyle = 'rgba(90, 220, 130, 0.18)';
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.strokeStyle = 'rgba(90, 220, 130, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.setLineDash([]);

    const w = Math.max(4, this.cam.ppm * 0.3);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(20, 24, 30, 0.55)';
    ctx.lineWidth = w + 3;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(150, 235, 175, 0.95)';
    ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();

    // Ends that would connect to something the moment the piece lands
    const ends: Array<[Point, Side]> = [
      [route[0], f.pipeOrientation === 'EW' ? 'W' : 'N'],
      [route[route.length - 1], f.pipeOrientation === 'EW' ? 'E' : 'S'],
    ];
    for (const [end, side] of ends) {
      if (!this.joinAt(f.plantState, end, side)) continue;
      const s = this.worldToScreen(end);
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(5, w * 0.7), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 235, 120, 0.9)';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * What a loose end at this point facing this way would join. The preview
   * asks this about a piece that does not exist yet; once it is placed the
   * caller asks `findFreeEndJoins` about the real pipe, which is the same
   * rule over real ports.
   */
  private joinAt(plantState: PlantState, point: Point, side: Side): { component: PlantComponent; port: Port } | null {
    const facing: Side = side === 'N' ? 'S' : side === 'S' ? 'N' : side === 'E' ? 'W' : 'E';
    for (const component of plantState.components.values()) {
      if (!component.ports || (component as any).isHydraulicOnly) continue;
      for (const anchor of portAnchors(component)) {
        if (anchor.port.connectedTo) continue;
        if (!samePoint(anchor.point, point)) continue;
        if (anchor.side !== facing) continue;
        return { component, port: anchor.port };
      }
    }
    return null;
  }
}
