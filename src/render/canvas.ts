import { ViewState, Point, PlantState, PlantComponent, ControllerComponent, SwitchyardComponent, TurbineGeneratorComponent, Connection, Fluid, Port, PipeComponent, waterBodyOf, paintDepthY } from '../types';
import { SimulationState, getReactorPowerState, getTurbineCondenserState } from '../simulation';
import { ComponentSpriteCache, LayerCache, quantizedKey, keyAnimates } from './sprite-cache';
import { renderComponent, getTimeSeed, formatCorePowerLabel, worldToScreen, renderFlowConnectionArrows, renderPressureGauge, renderThermometers, ConnectionScreenEndpoints, renderBurstOverlays, renderBreakConnections, renderBuildingFloor, renderBuildingFrontEdge, projectCircleToEllipse, flowConnectionIdForPlantConnection, openingArrowEndpoints, getComponentVisualHeight } from './components';
import { connectionLabelLines, drawConnectionLabel } from './connection-label';
import {
  IsometricConfig,
  DEFAULT_ISOMETRIC,
  renderIsometricGround,
  renderElevationLabel,
  getComponentElevation,
  renderDebugGrid,
} from './isometric';
import { getFluidColor, renderColorLegend } from './colors';
import { flowPhaseAt } from '../simulation/operators/connection-hydraulics';
import { PipeContentsTracker } from './display-flow';
import { getComponentSize, getDefaultComponentSize } from './component-size';
import { GridView, PortHit } from './grid-view';
import { PipeOrientation, oppositeOrientation, PlanRect, componentFootprint, footprintRect, isGroundLayerComponent, pipeRoute } from './grid-geometry';
import { Point3, RunVertex, liftRoute, slopeRoute, drawPipeRun, screenMidpoint } from './pipe-run-3d';
import { drawFires, collectCladdingFires } from './fire-fx';
import { drawBreaks, collectBreaks, breakAnchorLookup, ScreenBox } from './break-fx';
import { buildGhost, drawBuildProgress } from '../game/build-queue';
import { getCladdingOxidationPower } from '../simulation/operators/rate-operators';
import { CameraShake } from './camera-shake';
import { wireRuns, drawTwistedPair, TWIST_PITCH_M } from './wires';

/** Which projection draws the plant: the 2.5D perspective or the tile grid (shown as "2D"). */
export type ViewMode = 'perspective' | 'grid';

/** How faint a part that is not built yet (or is going away) is drawn. */
const GHOST_ALPHA = 0.42;

/** How far a foundation pad stands proud of grade, m. */
const PAD_THICKNESS_M = 0.2;
/** Height of one braced bay of a support scaffold, m (bays are shared out evenly). */
const SCAFFOLD_BAY_M = 3;

/**
 * What a standing component rests on in the 2.5D view: its footprint (the
 * grid view's, so the two views found things on the same slab), the height
 * it is carried up from, and the height of its own base. `onGround` means
 * it rests on grade and gets a concrete pad; `top > base` means there is a
 * gap to bridge with a steel scaffold.
 */
interface Foundation {
  rect: PlanRect;
  base: number;
  top: number;
  onGround: boolean;
}

export class PlantCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private view: ViewState;
  private plantState: PlantState;
  private simState: SimulationState | null = null;
  /** 2.5D offscreen caches (see sprite-cache.ts); both can be switched off for A/B. */
  public renderCache = { sprites: true, ground: true };
  public readonly spriteCache = new ComponentSpriteCache();
  private readonly groundCache = new LayerCache();
  /** Wall time of the last 2.5D frame's drawing, ms, and its breakdown by section (for perf probes). */
  public lastFrameMs = 0;
  public frameProfile: Record<string, number> = {};
  private lastCameraKey = '';
  private _simStateWarningLogged: boolean = false;
  /** Which end's fluid each line is full of, so that lines which only slosh
   *  hold one endpoint's colour instead of strobing between the two. See
   *  display-flow.ts. */
  private pipeContents = new PipeContentsTracker();
  private showPorts: boolean = false;
  // Power wiring (electrical model only): drawn unless the player hides it
  private showWires: boolean = true;
  private highlightedPort: { componentId: string; portId: string } | null = null;
  private isometric: IsometricConfig = { ...DEFAULT_ISOMETRIC };
  // 'perspective' is the 2.5D view, drawn by this class; 'grid' delegates
  // projection, hit testing and the plant layers to GridView. (The flat 2D
  // plan view this class used to draw was retired in favour of the grid.)
  private viewMode: ViewMode = 'perspective';
  private grid = new GridView();
  /**
   * Every pipe run's plan route this frame (the grid view's laned layout),
   * which the 2.5D view lifts into 3D to draw its piping.
   */
  private planRuns: Map<Connection | PipeComponent, Point[]> = new Map();
  /** Each connection's screen run, worked out once per 2.5D frame (cleared with planRuns). */
  private runMemo = new Map<Connection, { pts: RunVertex[]; scale: number } | null>();
  /** Ground motion (a scenario `shake` action): a render-transform jolt, nothing more. */
  private shake = new CameraShake();

  // Camera depth for forward/backward movement in isometric view
  // Separate from view.offsetY which controls elevation
  private cameraDepth: number = 0;

  // Interaction state
  private isDragging: boolean = false;
  private dragStart: Point = { x: 0, y: 0 };
  private selectedComponentId: string | null = null;
  /** Grid view: the pipe run the user clicked (a connection has no id, so the object itself). */
  private selectedConnection: Connection | null = null;
  // What this frame drew, for picking a flow path out with a click: every
  // connection's run in the 2.5D view (screen polyline) and every flow arrow
  // in either view. Rebuilt each frame.
  private perspectiveRuns: Array<{ conn: Connection; pts: Point[]; halfWidth?: number }> = [];
  private flowArrowHits: Array<{ conn: Connection; x: number; y: number; size: number }> = [];
  /**
   * The pipe tool is armed: a press on a connection point starts a run to
   * another port (as Connect mode does), and a press anywhere else lays pipe
   * on the ground. Grid view only - the other views have no tile lattice to
   * lay ground pipe on.
   */
  private pipeTool: boolean = false;
  private pipeOrientation: PipeOrientation = 'EW';
  private hoveredComponentId: string | null = null;
  private moveMode: boolean = false;
  private isMovingComponent: boolean = false;

  // RTS-style edge-scroll panning (opt-in). When the cursor sits within
  // EDGE_PAN_MARGIN of a canvas edge, the camera pans that way each frame.
  // Panels are inset >=1px from the screen edge (see CSS), so the extreme edge
  // is always canvas and stays reachable even where a panel covers the margin.
  private edgePanEnabled: boolean = false;
  private mouseOverCanvas: boolean = false;
  private lastMouseScreen: Point = { x: 0, y: 0 };
  private lastFrameTime: number | null = null;
  // Per-edge insets (px) that pull the pan trigger boundary inward from the
  // canvas edge. Used for the bottom, where the full-width status bar covers the
  // edge: the trigger sits just ABOVE the bar (in visible canvas) instead of the
  // 1px strip beneath it.
  private edgePanInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private static readonly EDGE_PAN_MARGIN = 28; // px from edge that triggers panning
  private static readonly EDGE_PAN_SPEED = 900;  // px/second at the very edge

  // Construction mode - shows grid and component outlines at ground level
  private constructionMode: boolean = true;
  // Whether the player may place/connect right now. Separate from
  // constructionMode, which says how components are DRAWN (running plant vs
  // design drawing): building is allowed in simulation mode too, and the
  // placement/routing affordances have to follow the builder, not the
  // drawing style.
  private buildMode: boolean = true;

  // Elevation nudge arrows (move mode). `elevationArrowTargets` is rebuilt
  // every frame by the drawing pass, so hit testing can only ever hit an
  // arrow that is actually on screen where the player sees it.
  private showElevationArrows: boolean = false;
  private elevationArrowTargets: Array<{
    componentId: string; delta: number; x: number; y: number; radius: number;
  }> = [];
  /**
   * While the pointer rests on a component's arrows, its buttons hold the
   * position they had when the pointer arrived. Without this the buttons ride
   * the component they are moving: one click lifts it, the pair slides up
   * with it, and the second click at the same spot lands on the DOWN arrow
   * and undoes the first. The latch lets you click a stack of steps without
   * chasing the button, and releases the moment the pointer leaves.
   */
  private elevationArrowLatch: { componentId: string; x: number; y: number } | null = null;
  /** Metres one arrow click moves a component. */
  public static readonly ELEVATION_STEP_M = 0.5;

  // Placement preview state
  private placementPreview: {
    componentType: string;
    position: Point;
  } | null = null;

  // Callbacks
  public onMouseMove?: (worldPos: Point) => void;
  public onComponentSelect?: (componentId: string | null) => void;
  public onComponentMove?: (componentId: string, newPosition: Point) => void;
  /** Grid view: a pipe was laid from one port to another (plan length in metres). */
  public onRouteComplete?: (from: PortHit, to: PortHit, route: Point[], planLength: number) => void;
  /**
   * A run laid on open ground with the pipe tool: a plan polyline that
   * becomes a standalone pipe component (main.ts). A bare click hands over a
   * single tile's piece, a sweep hands over the whole swept path.
   */
  public onGroundPipe?: (route: Point[]) => void;
  /** Grid view: a pipe run was clicked (`again` = it was already the selected one). */
  public onConnectionSelect?: (connection: Connection | null, again: boolean) => void;

  constructor(canvas: HTMLCanvasElement, plantState: PlantState) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx = ctx;

    this.plantState = plantState;

    // Initialize view centered on canvas, shifted up and left to show reactor better
    this.view = {
      offsetX: canvas.width / 2 + 200, // Shift left to center on plant
      offsetY: canvas.height / 2 + 500, // Shift down (which moves view up)
      zoom: 50, // 50 pixels per meter
    };

    this.setupEventListeners();
    this.resize();

    // Start render loop
    this.render();
  }

  private setupEventListeners(): void {
    // Pointer events unify mouse, touch, and pen. A mouse produces the same
    // stream it always did (pointerType 'mouse'); touch gets tap-to-click,
    // one-finger drag, and two-finger pinch zoom. The canvas has
    // touch-action: none (style.css) so the browser hands us raw gestures
    // instead of scrolling/zooming the page.
    this.canvas.addEventListener('pointerdown', this.handlePointerDown.bind(this));
    this.canvas.addEventListener('pointermove', this.handlePointerMove.bind(this));
    this.canvas.addEventListener('pointerup', this.handlePointerUp.bind(this));
    this.canvas.addEventListener('pointercancel', this.handlePointerUp.bind(this));
    this.canvas.addEventListener('pointerleave', this.handlePointerUp.bind(this));
    this.canvas.addEventListener('wheel', this.handleWheel.bind(this));
    this.canvas.addEventListener('contextmenu', (e) => {
      // Right-click abandons a pipe being laid on the grid
      if (this.viewMode === 'grid' && this.grid.routing) {
        this.cancelRouting();
        e.preventDefault();
      }
    });

    // Track whether the cursor is over the open canvas (vs a UI panel, which
    // overlaps the canvas and steals the pointer) - gates edge-scroll panning.
    this.canvas.addEventListener('pointerenter', () => { this.mouseOverCanvas = true; });
    this.canvas.addEventListener('pointerleave', () => { this.mouseOverCanvas = false; });

    // Keyboard events for arrow-key panning
    window.addEventListener('keydown', this.handleKeyDown.bind(this));

    // Resize
    window.addEventListener('resize', this.resize.bind(this));
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Don't steal arrow keys from text fields (e.g. Jack's chat box) or
    // focused controls like the view sliders
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }

    // Arrow keys pan the view, in the same directions as pushing the mouse
    // to that screen edge would edge-scroll (key repeat gives continuous
    // motion). Screen-space step, so a press covers the same fraction of
    // the view at any zoom.
    if (e.key === 'Escape' && this.viewMode === 'grid' && this.grid.routing) {
      this.cancelRouting();
      e.preventDefault();
      return;
    }

    const step = 40; // Pixels per key press
    let panX = 0;
    let panY = 0;
    switch (e.key) {
      case 'ArrowLeft': panX = step; break;
      case 'ArrowRight': panX = -step; break;
      case 'ArrowUp': panY = step; break;
      case 'ArrowDown': panY = -step; break;
      default: return;
    }

    if (this.viewMode === 'grid') {
      this.grid.panByPixels(panX, panY);
    } else {
      // Match the drag/edge-pan mapping: horizontal -> offsetX, vertical ->
      // cameraDepth, divided by zoom so the apparent speed stays constant
      this.view.offsetX += panX / this.isoZoom;
      this.cameraDepth -= panY / this.isoZoom;
    }
    this.clampView();
    e.preventDefault();
  }

  // Active pointers currently pressed on the canvas, by pointerId.
  // Two simultaneous touch points = pinch zoom.
  private activePointers: Map<number, Point> = new Map();

  private handlePointerDown(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.activePointers.set(e.pointerId, { x, y });

    // Capture touch pointers so a drag keeps tracking when the finger crosses
    // an overlapping panel or the canvas edge. Mouse keeps its hover/leave
    // semantics (leaving the canvas ends the drag, as before).
    if (e.pointerType !== 'mouse') {
      this.canvas.setPointerCapture(e.pointerId);
    }

    if (this.activePointers.size === 2) {
      // Second finger down: this is a pinch, not a drag
      this.isDragging = false;
      this.isMovingComponent = false;
      const [t1, t2] = Array.from(this.activePointers.values());
      this.lastPinchDist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
      this.lastPinchCenter = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 };
      return;
    }
    if (this.activePointers.size > 2 || !e.isPrimary) return;

    // Grid view lays pipe from ports itself (drag or click-click)
    if (this.viewMode === 'grid' && this.handleGridPointerDown(e, x, y)) return;

    // If ports are shown (connect mode), check if clicking on a port first
    // If so, don't select the component - let the port click handler deal with it
    if (this.showPorts) {
      const portInfo = this.getPortAtScreen({ x, y });
      if (portInfo) {
        // Clicked on a port - don't select component or start panning
        return;
      }
    }

    // Check if clicking on a component
    const clickedComponent = this.getComponentAtScreen({ x, y });

    if (e.button === 0) { // Left click
      // A flow arrow is drawn over everything, so it wins over the component
      // beneath it: clicking one picks out the flow path it belongs to. In the
      // 2.5D view the connection curves are drawn over the components they
      // join too, so a click right on a drawn line picks the line; the
      // component's body anywhere else still picks the component.
      if (!this.moveMode && !this.placementPreview) {
        const arrowConn = this.arrowAt({ x, y }) ??
          (this.viewMode === 'grid' ? null : this.perspectiveRunAt({ x, y }));
        if (arrowConn) {
          const again = arrowConn === this.selectedConnection;
          this.selectedComponentId = null;
          this.onComponentSelect?.(null);
          this.selectConnection(arrowConn, again);
          return;
        }
      }
      if (clickedComponent) {
        // In move mode, mousedown is the start of a click-and-drag, not a
        // selection: the construction-mode move handler (main.ts) owns the
        // drag, and selection happens on mouseup if the mouse didn't move.
        if (this.moveMode) {
          return;
        }
        this.selectedComponentId = clickedComponent.id;
        this.selectConnection(null);
        this.onComponentSelect?.(clickedComponent.id);
      } else {
        // A click on a drawn run selects the connection, in either view (not
        // while placing a component, when the click is about to place it there)
        if (!this.moveMode && !this.placementPreview) {
          const conn = this.getConnectionAtScreen({ x, y });
          if (conn) {
            const again = conn === this.selectedConnection;
            this.selectedComponentId = null;
            this.onComponentSelect?.(null);
            this.selectConnection(conn, again);
            return;
          }
        }
        // Start panning (only if not in move mode, or nothing selected)
        this.isDragging = true;
        this.dragStart = { x, y };
        if (!this.moveMode) {
          this.selectedComponentId = null;
          this.selectConnection(null);
          this.onComponentSelect?.(null);
        }
      }
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x, y });
    }
    if (this.activePointers.size >= 2) {
      this.handlePinch();
      return;
    }
    if (!e.isPrimary) return;

    // Remember screen position (edge-scroll keeps panning while the cursor is
    // held still at the edge, when no further mousemove events fire)
    this.lastMouseScreen = { x, y };
    this.mouseOverCanvas = true;

    // Update world position callback
    const worldPos = this.getWorldPositionFromScreen({ x, y });
    this.onMouseMove?.(worldPos);

    // Update hover state
    const hovered = this.getComponentAtScreen({ x, y });
    this.hoveredComponentId = hovered?.id ?? null;

    if (this.viewMode === 'grid' && this.grid.routing) {
      this.grid.updateRoutingCursor({ x, y }, this.plantState);
      this.canvas.style.cursor = this.grid.routing.target ? 'pointer' : 'crosshair';
      return;
    }

    if (this.isMovingComponent && this.selectedComponentId) {
      // Move the selected component
      const component = this.plantState.components.get(this.selectedComponentId);
      if (component) {
        const currentWorld = this.getWorldPositionFromScreen({ x, y });
        const prevWorld = this.getWorldPositionFromScreen(this.dragStart);
        component.position.x += currentWorld.x - prevWorld.x;
        component.position.y += currentWorld.y - prevWorld.y;
        this.dragStart = { x, y };
        this.onComponentMove?.(this.selectedComponentId, component.position);
      }
    } else if (this.isDragging) {
      // Pan the view
      const dx = x - this.dragStart.x;
      const dy = y - this.dragStart.y;

      if (this.viewMode === 'grid') {
        this.grid.panByPixels(dx, dy);
      } else {
        // In perspective mode:
        // - Drag left/right moves laterally (offsetX)
        // - Drag up/down moves forward/backward (cameraDepth)
        // Drag down = move forward (negative dy = forward)
        // Divide by zoom so the ground tracks the cursor at the same rate
        // regardless of magnification
        this.view.offsetX += dx / this.isoZoom;
        this.cameraDepth -= dy / this.isoZoom; // Negate: drag down = move forward
      }

      this.clampView();
      this.dragStart = { x, y };
    }

    // Change cursor based on mode and hover
    if (this.moveMode) {
      this.canvas.style.cursor = this.hoveredComponentId ? 'move' : 'default';
    } else {
      this.canvas.style.cursor = this.hoveredComponentId ? 'pointer' : (this.isDragging ? 'grabbing' : 'grab');
    }
  }

  private handlePointerUp(e: PointerEvent): void {
    // Also serves pointercancel and pointerleave. For a mouse simply crossing
    // onto an overlapping panel (pointerleave, no press tracked), the deletes
    // are no-ops and the drag flags were already false.
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size < 2) {
      this.lastPinchDist = 0;
    }
    if (this.viewMode === 'grid' && this.grid.routing?.dragging && e.isPrimary) {
      // End of a sweep: released on a port finishes the pipe, released on
      // open ground leaves it waiting for a click on one. A release where
      // the press was is a click, which never finishes (two ports can share
      // a spot - a pipe end on the nozzle it feeds - and a click on one
      // must not land on the other).
      this.grid.routing.dragging = false;
      const rect = this.canvas.getBoundingClientRect();
      const up = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const press = this.grid.routing.pressScreen;
      const moved = !press || Math.hypot(up.x - press.x, up.y - press.y) > 6;
      const from = this.grid.routing.from;
      if (!from) {
        // Ground run: the release IS the placement. A press that never moved
        // leaves the single starting cell, which is one piece in the tool's
        // current rotation.
        const route = this.grid.finishGroundRouting();
        this.canvas.style.cursor = 'crosshair';
        if (route.length >= 2) this.onGroundPipe?.(route);
      } else {
        const hit = moved ? this.grid.portAt(up, this.plantState, from.component.id) : null;
        if (hit) this.completeRoute(hit);
      }
    }
    if (this.activePointers.size === 0) {
      this.isDragging = false;
      this.isMovingComponent = false;
    }
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();

    if (this.viewMode === 'grid') {
      // Zoom about the cursor, the way a map does
      const rect = this.canvas.getBoundingClientRect();
      this.grid.zoomAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, e.deltaY > 0 ? 0.9 : 1.1);
      this.syncIsoZoomUI();
      return;
    }

    if (e.shiftKey || e.ctrlKey) {
      // Shift/Ctrl + scroll changes view angle (the old plain-scroll behavior)
      // Scroll up = look more from above, scroll down = look more forward
      // With Shift held some mice report the wheel as deltaX, so fall back to it
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      const angleStep = 5;
      this.viewAngle += delta > 0 ? angleStep : -angleStep;
      this.viewAngle = Math.max(10, Math.min(50, this.viewAngle));

      // Update the view angle slider and display to match
      const slider = document.getElementById('view-elevation') as HTMLInputElement;
      const display = document.getElementById('view-elevation-value');
      if (slider) {
        slider.value = String(this.viewAngle);
      }
      if (display) {
        display.textContent = String(this.viewAngle);
      }
    } else {
      // Plain scroll zooms about the mid-screen anchor
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      this.applyIsoZoom(this.isoZoom * zoomFactor);
    }
  }

  // Pinch-zoom state (two active touch pointers)
  private lastPinchDist: number = 0;
  private lastPinchCenter: Point = { x: 0, y: 0 };

  private handlePinch(): void {
    const [t1, t2] = Array.from(this.activePointers.values());
    const dist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
    const center = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 };

    if (this.lastPinchDist > 0) {
      const zoomFactor = dist / this.lastPinchDist;

      if (this.viewMode === 'grid') {
        this.grid.zoomAt(center, zoomFactor);
        this.grid.panByPixels(center.x - this.lastPinchCenter.x, center.y - this.lastPinchCenter.y);
        this.syncIsoZoomUI();
      } else {
        // Pinch zooms the perspective view about the mid-screen anchor
        this.applyIsoZoom(this.isoZoom * zoomFactor);

        // Pan by the center's motion, matching the one-finger drag mapping
        // (horizontal -> offsetX, vertical -> cameraDepth), scaled by zoom
        this.view.offsetX += (center.x - this.lastPinchCenter.x) / this.isoZoom;
        this.cameraDepth -= (center.y - this.lastPinchCenter.y) / this.isoZoom;
        this.clampView();
      }
    }

    this.lastPinchDist = dist;
    this.lastPinchCenter = center;
  }

  public getComponentAtScreen(screenPos: Point): PlantComponent | null {
    if (this.viewMode === 'grid') return this.grid.componentAt(screenPos, this.plantState);
    // Check components in reverse order (top-most first, closest to camera)
    // Filter out hydraulic-only components (they're not rendered, so shouldn't be clickable)
    const components = Array.from(this.plantState.components.values())
      .filter(c => !(c as any).isHydraulicOnly);

    // Sort by depth: closer to camera (smaller Y) checked first
    // Also: contained components are on top, so check them first
    components.sort((a, b) => {
      // First priority: contained components are on top
      if (a.containedBy && !b.containedBy) return -1;
      if (!a.containedBy && b.containedBy) return 1;

      // Second priority: depth sorting (the same depth the painter uses)
      return paintDepthY(a) - paintDepthY(b);
    });

    for (const component of components) {
      // Check against projected screen bounds
      if (this.isPointInProjectedComponent(screenPos, component)) {
        return component;
      }
    }
    return null;
  }

  // Check if a screen point is inside a component's actual visual bounds on screen
  private isPointInProjectedComponent(screenPos: Point, component: PlantComponent): boolean {
    const elevation = getComponentElevation(component);
    const size = this.getComponentSize(component);
    const halfW = size.width / 2;
    const halfH = size.height / 2;

    const centerX = component.position.x;
    const centerY = component.position.y;
    const cos = Math.cos(component.rotation);
    const sin = Math.sin(component.rotation);

    // Switchyard uses ground-level footprint for hit testing (matches its perspective rendering)
    if (component.type === 'switchyard') {
      // Project the four corners at ground level (elevation 0)
      const corners = [
        { x: centerX - halfW, y: centerY - halfH },
        { x: centerX + halfW, y: centerY - halfH },
        { x: centerX + halfW, y: centerY + halfH },
        { x: centerX - halfW, y: centerY + halfH },
      ];
      const screenCorners = corners.map(c => this.worldToScreenPerspective(c, 0));
      if (screenCorners.some(c => c.scale <= 0)) return false;
      return this.isPointInQuad(screenPos, screenCorners.map(c => c.pos));
    }

    // Building uses back wall for hit testing (matches its visual rendering)
    if (component.type === 'building') {
      const bldg = component as import('../types').BuildingComponent;
      const bldgWidth = bldg.shape === 'cylinder' ? (bldg.diameter || 40) : (bldg.width || 40);
      const bldgDepth = bldg.shape === 'cylinder' ? (bldg.diameter || 40) : (bldg.length || 40);
      const bldgHeight = bldg.height || 50;
      const bldgHalfW = bldgWidth / 2;
      const bldgHalfD = bldgDepth / 2;

      // Cylindrical buildings: hit-test the rendered wall band (side walls +
      // roof), using the same projected-ellipse geometry as renderBuilding.
      // The floor (base ellipse interior) is NOT part of the hit region, so
      // clicks there fall through to components inside the building.
      if (bldg.shape === 'cylinder') {
        const centerProj = this.worldToScreenPerspective(component.position, 0);
        if (centerProj.scale <= 0) return false;

        const worldToScreenFn = (pos: Point, elev: number = 0) => this.worldToScreenPerspective(pos, elev);
        const base = projectCircleToEllipse(worldToScreenFn, component.position, bldgHalfW, 0);
        const top = projectCircleToEllipse(worldToScreenFn, component.position, bldgHalfW, bldgHeight);
        if (base.rx <= 0 || base.ry <= 0) return false;

        // A projected ellipse can degenerate to a flat line (ry clamped to 0
        // when the front rim projects above the back rim at close range);
        // renderBuilding draws it that way too, so treat it as zero-area.
        const inEllipse = (e: { cx: number; cy: number; rx: number; ry: number }): boolean => {
          if (e.rx <= 0 || e.ry <= 0) return false;
          const dx = (screenPos.x - e.cx) / e.rx;
          const dy = (screenPos.y - e.cy) / e.ry;
          return dx * dx + dy * dy <= 1;
        };

        // Roof: the top rim ellipse
        if (inEllipse(top)) return true;

        // Side walls: the quad between the two ellipses' horizontal diameters,
        // minus the upper half of the base ellipse (the shell path closes
        // along the base's back arc, leaving the floor exposed)
        const inWallQuad = this.isPointInQuad(screenPos, [
          { x: base.cx - base.rx, y: base.cy },
          { x: top.cx - top.rx, y: top.cy },
          { x: top.cx + top.rx, y: top.cy },
          { x: base.cx + base.rx, y: base.cy },
        ]);
        return inWallQuad && !inEllipse(base);
      }

      // Back wall is at position.y + halfD (farther from camera)
      const backY = component.position.y + bldgHalfD;

      // Project the four corners of the back wall (bottom-left, bottom-right, top-right, top-left)
      const backLeftBottom = this.worldToScreenPerspective(
        { x: component.position.x - bldgHalfW, y: backY }, 0
      );
      const backRightBottom = this.worldToScreenPerspective(
        { x: component.position.x + bldgHalfW, y: backY }, 0
      );
      const backRightTop = this.worldToScreenPerspective(
        { x: component.position.x + bldgHalfW, y: backY }, bldgHeight
      );
      const backLeftTop = this.worldToScreenPerspective(
        { x: component.position.x - bldgHalfW, y: backY }, bldgHeight
      );

      if (backLeftBottom.scale <= 0 || backRightBottom.scale <= 0 ||
          backLeftTop.scale <= 0 || backRightTop.scale <= 0) {
        return false;
      }

      // Test if point is in the back wall quad
      return this.isPointInQuad(screenPos, [
        backLeftTop.pos,
        backRightTop.pos,
        backRightBottom.pos,
        backLeftBottom.pos,
      ]);
    }

    // A pipe is its drawn run: a hit is within half its width (or the
    // minimum grab) of the polyline it is drawn along
    if (component.type === 'pipe') {
      const run = this.pipeComponentRun(component as PipeComponent);
      if (!run) return false;
      const halfWidth = Math.max(...run.map(v => v.w)) / 2;
      return distanceToPolylinePx(screenPos, run) <= Math.max(halfWidth, PlantCanvas.MIN_CLICK_TARGET_PX / 2);
    }

    // Define 4 corners in local space (ground footprint)
    const localCorners = [
      { x: -halfW, y: -halfH },  // front-left
      { x: halfW, y: -halfH },   // front-right
      { x: halfW, y: halfH },    // back-right
      { x: -halfW, y: halfH },   // back-left
    ];

    // Transform to world and project to screen
    const screenCorners = localCorners.map(local => {
      const worldX = centerX + local.x * cos - local.y * sin;
      const worldY = centerY + local.x * sin + local.y * cos;
      return this.worldToScreenPerspective({ x: worldX, y: worldY }, elevation);
    });

    // Skip if any corner is behind camera
    if (screenCorners.some(c => c.scale <= 0)) {
      return false;
    }

    let visualQuad: Point[];
    // Other components: mirror the draw path exactly (see the render loop):
    // project the component CENTER at its elevation, zoom from the center
    // scale, verticalScale on the height, visual center one half-height
    // above the projected point, then screen-space rotation (pumps mirror
    // instead of rotating).
    const centerScreen = this.worldToScreenPerspective(
      { x: component.position.x, y: component.position.y },
      elevation
    );
    if (centerScreen.scale <= 0) return false;
    const { verticalScale } = this.getViewTransform();
    const centerZoom = centerScreen.scale * 50;
    const visualHalfW = halfW * centerZoom;
    const centerVisualHalfH = halfH * centerZoom * verticalScale;
    const cx = centerScreen.pos.x;
    const cy = centerScreen.pos.y - centerVisualHalfH;
    const rot = component.type === 'pump' ? 0 : component.rotation;
    const rc = Math.cos(rot);
    const rs = Math.sin(rot);
    const corner = (sx: number, sy: number): Point => ({
      x: cx + sx * rc - sy * rs,
      y: cy + sx * rs + sy * rc,
    });
    // Grow the hit box - not the drawing - to a minimum target. A 0.1 m
    // relief valve projects to two or three pixels and was effectively
    // unclickable, and worse on a touchscreen.
    const minHalf = PlantCanvas.MIN_CLICK_TARGET_PX / 2;
    const hitHalfW = Math.max(visualHalfW, minHalf);
    const hitHalfH = Math.max(centerVisualHalfH, minHalf);
    visualQuad = [
      corner(-hitHalfW, -hitHalfH),  // top-left
      corner(hitHalfW, -hitHalfH),   // top-right
      corner(hitHalfW, hitHalfH),    // bottom-right
      corner(-hitHalfW, hitHalfH),   // bottom-left
    ];

    return this.isPointInQuad(screenPos, visualQuad);
  }

  /**
   * Get the screen bounding box for a component.
   * Returns the top-center position and scale, suitable for attaching gauges.
   * This uses the same calculation as isPointInProjectedComponent for consistency.
   */
  /**
   * Flames over any cladding that is oxidising hard enough to see.
   *
   * Both views use the same drawing and the same intensity - what differs is
   * only the rectangle the flames rise from, which each view answers with its
   * own component bounds. Nothing here decides whether something is burning;
   * `getCladdingOxidationPower()` is the chemical power the physics released.
   */
  private renderFires(
    ctx: CanvasRenderingContext2D,
    getScreenBounds: (comp: PlantComponent) => { topCenter: Point; scale: number; width?: number; height?: number } | null
  ): void {
    const powers = getCladdingOxidationPower();
    if (powers.size === 0) return;
    const sources = collectCladdingFires(
      this.plantState.components.keys(), powers,
      (componentId) => {
        const comp = this.plantState.components.get(componentId);
        if (!comp) return null;
        const b = getScreenBounds(comp);
        if (!b) return null;
        const w = b.width ?? 40;
        const h = b.height ?? 40;
        // A band across the middle of what is burning: in the side view that
        // is the upper half of the object, and in plan it is the middle of
        // its footprint - both of which read as "the whole thing is alight"
        // rather than "something is on fire behind it".
        return {
          x: b.topCenter.x - w / 2,
          y: b.topCenter.y + h * 0.2,
          w,
          h: Math.max(4, h * 0.5),
        };
      });
    drawFires(ctx, sources, performance.now());
  }

  /**
   * Every open break, resolved to the view that is on screen.
   *
   * The rectangle a break is placed on is the one the component is DRAWN in
   * (the same bounds the gauges hang off), and `plan` tells break-fx whether
   * the view has a height axis to put the break's elevation on. One call per
   * frame; the marker, the tear, the spray and the discharge line then all
   * read the same anchors.
   */
  private currentBreaks() {
    const boundsFor = (comp: PlantComponent): ScreenBox | null => {
      const b = this.getComponentScreenBounds(comp);
      if (!b || b.width === undefined || b.height === undefined) return null;
      return { x: b.topCenter.x - b.width / 2, y: b.topCenter.y, w: b.width, h: b.height };
    };
    return collectBreaks(this.plantState, this.simState, boundsFor, this.viewMode === 'grid');
  }

  public getComponentScreenBounds(component: PlantComponent): { topCenter: Point; scale: number; width?: number; height?: number } | null {
    if (this.viewMode === 'grid') return this.grid.componentScreenBounds(component);

    // Isometric/perspective mode - replicate the visual bounds calculation
    const elevation = getComponentElevation(component);
    const size = this.getComponentSize(component);
    const halfW = size.width / 2;
    const halfH = size.height / 2;

    const centerX = component.position.x;
    const centerY = component.position.y;
    const cos = Math.cos(component.rotation);
    const sin = Math.sin(component.rotation);

    // For pipes, local coords go from (0, -halfH) to (length, halfH)
    // For others, centered: (-halfW, -halfH) to (halfW, halfH)
    let localLeft = -halfW;
    let localRight = halfW;
    if (component.type === 'pipe') {
      localLeft = 0;
      localRight = size.width;
    }

    // Define front corners in local space
    const localCorners = [
      { x: localLeft, y: -halfH },   // front-left
      { x: localRight, y: -halfH },  // front-right
    ];

    // Transform to world and project to screen
    const screenCorners = localCorners.map(local => {
      const worldX = centerX + local.x * cos - local.y * sin;
      const worldY = centerY + local.x * sin + local.y * cos;
      return this.worldToScreenPerspective({ x: worldX, y: worldY }, elevation);
    });

    // Skip if any corner is behind camera
    if (screenCorners.some(c => c.scale <= 0)) {
      return null;
    }

    const frontLeft = screenCorners[0].pos;
    const frontRight = screenCorners[1].pos;
    // Use the actual perspective scale from the projection (average of both corners)
    const perspectiveScale = (screenCorners[0].scale + screenCorners[1].scale) / 2;

    // Calculate the visual bounds
    const frontWidth = Math.hypot(frontRight.x - frontLeft.x, frontRight.y - frontLeft.y);
    const projectedZoom = frontWidth / size.width;
    const visualHalfH = halfH * projectedZoom;

    if (component.type === 'pipe') {
      // For pipes, use the midpoint of the pipe at its visual top
      const pipe = component as import('../types').PipeComponent;
      if (pipe.endPosition && pipe.endElevation !== undefined) {
        const startScreen = this.worldToScreenPerspective(
          { x: pipe.position.x, y: pipe.position.y },
          pipe.elevation ?? 0
        );
        const endScreen = this.worldToScreenPerspective(
          pipe.endPosition,
          pipe.endElevation
        );

        const run = this.pipeComponentRun(pipe);
        if (startScreen.scale > 0 && endScreen.scale > 0 && run) {
          const avgScale = (startScreen.scale + endScreen.scale) / 2;
          const visualThickness = halfH * avgScale * 50;
          // The middle of the run as drawn - on a route that turns, not the
          // midpoint of its two ends
          const mid = screenMidpoint(run);
          const xs = run.map(v => v.x);
          // Top of pipe is at the midpoint less visualThickness
          return {
            topCenter: { x: mid.point.x, y: mid.point.y - visualThickness },
            scale: avgScale,
            width: Math.max(Math.max(...xs) - Math.min(...xs), visualThickness * 2),
            height: visualThickness * 2,
          };
        }
      }
      // Fallback for pipes without endpoint data (should not happen)
      console.error(`[getComponentScreenBounds] Pipe ${component.id} has no endpoint data`);
      const frontCenterX = (frontLeft.x + frontRight.x) / 2;
      const frontCenterY = (frontLeft.y + frontRight.y) / 2;
      return {
        topCenter: { x: frontCenterX, y: frontCenterY - 2 * visualHalfH },
        scale: perspectiveScale,
        width: frontWidth,
        height: visualHalfH * 4,
      };
    } else if (component.type === 'building') {
      // Buildings: gauge goes at the top of the back wall
      const bldg = component as import('../types').BuildingComponent;
      const bldgDepth = bldg.shape === 'cylinder' ? (bldg.diameter || 40) : (bldg.length || 40);
      const bldgHeight = bldg.height || 50;
      const bldgHalfD = bldgDepth / 2;

      // Back wall is at position.y + halfD (farther from camera)
      const backY = component.position.y + bldgHalfD;

      // Project the top-center of the back wall
      const backTopCenter = this.worldToScreenPerspective(
        { x: component.position.x, y: backY },
        bldgHeight
      );

      if (backTopCenter.scale <= 0) return null;

      // Calculate building screen dimensions
      const bldgWidth = bldg.shape === 'cylinder' ? (bldg.diameter || 40) : (bldg.width || 40);
      const bldgScreenWidth = bldgWidth * backTopCenter.scale * 50;
      const bldgScreenHeight = bldgHeight * backTopCenter.scale * 50;

      return {
        topCenter: backTopCenter.pos,
        scale: backTopCenter.scale,
        width: bldgScreenWidth,
        height: bldgScreenHeight,
      };
    } else {
      // Other components: use center-based positioning (matching component rendering)
      const centerScreen = this.worldToScreenPerspective(
        { x: component.position.x, y: component.position.y },
        elevation
      );

      if (centerScreen.scale <= 0) return null;

      // Use center-based zoom (same as component rendering)
      const { verticalScale } = this.getViewTransform();
      const centerZoom = centerScreen.scale * 50;
      const centerVisualHalfH = halfH * centerZoom * verticalScale;

      // Component center is at centerScreen.pos
      // Top of component is at centerScreen.pos.y - centerVisualHalfH * 2 (from translate + scaling)
      // Actually: draw origin is at (centerScreen.pos.x, centerScreen.pos.y - centerVisualHalfH)
      // Component is drawn with center at (0, centerVisualHalfH) in local coords
      // So the top is at centerScreen.pos.y - 2 * centerVisualHalfH
      const topY = centerScreen.pos.y - 2 * centerVisualHalfH;
      const centerVisualHalfW = halfW * centerZoom * verticalScale;
      return {
        topCenter: { x: centerScreen.pos.x, y: topY },
        scale: centerScreen.scale,
        width: centerVisualHalfW * 2,
        height: centerVisualHalfH * 2,  // Full height from top to bottom (halfH * 2 = full height)
      };
    }
  }

  // Check if a point is inside a quadrilateral using cross product method
  private isPointInQuad(point: Point, quad: Point[]): boolean {
    // For each edge, check which side of the line the point is on
    // If all same side (all positive or all negative cross products), point is inside
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      // Cross product of edge vector and point vector
      const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
      if (cross !== 0) {
        if (sign === 0) {
          sign = cross > 0 ? 1 : -1;
        } else if ((cross > 0 ? 1 : -1) !== sign) {
          return false;
        }
      }
    }
    return true;
  }

  public getPortAtScreen(screenPos: Point): { component: PlantComponent, port: any, worldPos: Point } | null {
    if (this.viewMode === 'grid') {
      const hit = this.grid.portAt(screenPos, this.plantState);
      return hit ? { component: hit.component, port: hit.port, worldPos: hit.anchor.point } : null;
    }
    // Collect all ports that match, then return the one visually in front
    const matches: Array<{ component: PlantComponent, port: any, worldPos: Point, worldY: number, localY: number }> = [];

    for (const component of this.plantState.components.values()) {
      if (!component.ports) continue;

      for (const port of component.ports) {
        const portWorldPos = this.getPortWorldPosition(component, port);

        // Check against screen position
        const portScreenPos = this.getPortScreenPosition(component, port);
        if (!portScreenPos) continue;

        const distance = Math.hypot(
          screenPos.x - portScreenPos.x,
          screenPos.y - portScreenPos.y
        );

        // Include the stroke width in detection radius (stroke is ~25% of radius, centered on edge)
        const strokeWidth = Math.max(1, portScreenPos.radius * 0.25);
        const detectionRadius = portScreenPos.radius + strokeWidth / 2;
        if (distance <= detectionRadius) {
          matches.push({ component, port, worldPos: portWorldPos, worldY: portWorldPos.y, localY: port.position.y });
        }
      }
    }

    if (matches.length === 0) return null;

    // Return the port that is visually in front
    matches.sort((a, b) => {
      // Contained components are rendered on top
      if (a.component.containedBy && !b.component.containedBy) return -1;
      if (!a.component.containedBy && b.component.containedBy) return 1;
      // For ports on the same component (like cross-vessel inner vs annulus ports),
      // higher local Y = lower on component = closer to camera in isometric view
      if (a.component === b.component) {
        return b.localY - a.localY;
      }
      // For different components, lower world Y = closer to camera
      return a.worldY - b.worldY;
    });

    const best = matches[0];
    return { component: best.component, port: best.port, worldPos: best.worldPos };
  }

  // Get port screen position in isometric mode, matching component visual rendering
  private getPortScreenPosition(component: PlantComponent, port: { position: Point }): { x: number, y: number, radius: number } | null {
    // For pipes with endpoint data, use the projected endpoints directly
    if (component.type === 'pipe') {
      const pipe = component as import('../types').PipeComponent;
      if (pipe.endPosition && pipe.endElevation !== undefined) {
        // Determine which endpoint this port is at based on port.position.x
        // Inlet (x=0) is at start, outlet (x=length) is at end
        const isAtEnd = port.position.x > pipe.length / 2;

        if (isAtEnd) {
          // Project end point
          const endScreen = this.worldToScreenPerspective(
            pipe.endPosition,
            pipe.endElevation
          );
          if (endScreen.scale <= 0) return null;
          return {
            x: endScreen.pos.x,
            y: endScreen.pos.y,
            radius: Math.max(6, endScreen.scale * 25)
          };
        } else {
          // Project start point
          const startScreen = this.worldToScreenPerspective(
            { x: pipe.position.x, y: pipe.position.y },
            pipe.elevation ?? 0
          );
          if (startScreen.scale <= 0) return null;
          return {
            x: startScreen.pos.x,
            y: startScreen.pos.y,
            radius: Math.max(6, startScreen.scale * 25)
          };
        }
      }
    }

    // Standard approach for non-pipe components
    const elevation = getComponentElevation(component);
    const size = this.getComponentSize(component);
    const halfH = size.height / 2;

    const cos = Math.cos(component.rotation);
    const sin = Math.sin(component.rotation);

    // For pipes without endpoint data, use corner-based projection (legacy)
    if (component.type === 'pipe') {
      const centerX = component.position.x;
      const centerY = component.position.y;

      const localCorners = [
        { x: 0, y: -halfH },           // front-left (start)
        { x: size.width, y: -halfH },  // front-right (end)
        { x: size.width, y: halfH },   // back-right
        { x: 0, y: halfH },            // back-left
      ];

      const screenCorners = localCorners.map(local => {
        const worldX = centerX + local.x * cos - local.y * sin;
        const worldY = centerY + local.x * sin + local.y * cos;
        return this.worldToScreenPerspective({ x: worldX, y: worldY }, elevation);
      });

      if (screenCorners.some(c => c.scale <= 0)) return null;

      const frontLeft = screenCorners[0].pos;
      const frontRight = screenCorners[1].pos;
      const backLeft = screenCorners[3].pos;

      const frontWidth = Math.hypot(frontRight.x - frontLeft.x, frontRight.y - frontLeft.y);
      const projectedZoom = frontWidth / size.width;
      const visualHalfH = halfH * projectedZoom;

      const translateX = backLeft.x;
      const translateY = backLeft.y - visualHalfH;

      const localX = port.position.x * projectedZoom;
      const localY = port.position.y * projectedZoom;
      const rotatedX = localX * cos - localY * sin;
      const rotatedY = localX * sin + localY * cos;

      return {
        x: translateX + rotatedX,
        y: translateY + rotatedY,
        radius: Math.max(4, 0.4 * projectedZoom)
      };
    }

    // Non-pipe components: use center-based positioning (matching component rendering)
    // Project the actual center point to screen space
    const centerScreen = this.worldToScreenPerspective(
      { x: component.position.x, y: component.position.y },
      elevation
    );

    if (centerScreen.scale <= 0) return null;

    // Use center-based zoom (same as component rendering)
    const { verticalScale } = this.getViewTransform();
    const centerZoom = centerScreen.scale * 50;

    // The component rendering applies transforms as: translate, rotate, scale(1, verticalScale)
    // Canvas transforms apply in reverse order to points, so for a local point (x, y):
    // 1. Scale: (x, y * verticalScale)
    // 2. Rotate: (x*cos - y*vs*sin, x*sin + y*vs*cos)
    // 3. Translate: add (tx, ty)
    //
    // The translation includes an offset: ty = centerScreen.pos.y - (halfH * centerZoom * verticalScale)
    // This offset positions the component so its visual center is at the projected point.

    const localX = port.position.x * centerZoom;
    const localY = port.position.y * centerZoom;

    // Apply vertical scale FIRST (before rotation), matching canvas transform order
    const scaledY = localY * verticalScale;

    // Then apply rotation
    const rotatedX = localX * cos - scaledY * sin;
    const rotatedY = localX * sin + scaledY * cos;

    // The rendering uses translateY = centerScreen.pos.y - visualHalfH
    // where visualHalfH = halfH * centerZoom * verticalScale
    // We need to match this offset for the port to align with the rendered component
    // (size and halfH are already computed above at the start of the function)
    const visualHalfH = halfH * centerZoom * verticalScale;
    const translateY = centerScreen.pos.y - visualHalfH;

    // Add to translated position (component center in local coords is at y=0,
    // which after transforms ends up at translateY + 0 = translateY)
    return {
      x: centerScreen.pos.x + rotatedX,
      y: translateY + rotatedY,
      radius: Math.max(4, 0.4 * centerZoom)
    };
  }

  public resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;

    // Reset transform before scaling (setting canvas.width already resets it,
    // but be explicit to avoid issues)
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.grid.setViewportSize(rect.width, rect.height);
  }

  // Perspective projection constants
  private readonly CAMERA_HEIGHT = 50;
  private readonly PERSPECTIVE_X_SCALE = 50;
  private readonly ELEVATION_SCALE = 50;

  /**
   * Smallest square (screen px) any component's hit box is allowed to be.
   * Valves, orifices and small-bore pipes are drawn at their real size, which
   * at plant scale is a few pixels; without a floor they are impossible to
   * click and hopeless to tap. Only hit testing grows - nothing is drawn any
   * larger. Kept modest so neighbouring fittings do not steal each other's
   * clicks; the depth/containment sort still decides ties.
   */
  private static readonly MIN_CLICK_TARGET_PX = 24;

  // View angle in degrees from horizontal (20 = looking forward, 70 = looking down)
  // Controls perspective flattening (higher = flatter, more top-down feel)
  private viewAngle: number = 30;

  // Magnification of the perspective view, independent of view angle.
  // A pure screen-space magnification about a fixed anchor (screen center X,
  // the projection's stretch reference Y, ~55% down the canvas). The camera
  // itself never moves when zooming, so zoom in/out always round-trips to
  // exactly the same view.
  private isoZoom: number = 1;
  private static readonly MIN_ISO_ZOOM = 0.2;
  private static readonly MAX_ISO_ZOOM = 5;

  // Get view transform parameters from view angle
  // Returns parameters that create a proper "elevated camera" effect:
  // - verticalScale: compress component heights when looking from above
  // - perspectiveOffset: added to distance to flatten perspective (near/far more similar)
  // - overallScale: everything smaller when camera is higher
  private getViewTransform(): { verticalScale: number, perspectiveOffset: number, overallScale: number } {
    // Vertical compression disabled - it was distorting positions
    // Previously: const verticalScale = Math.cos(viewAngle in radians);
    const verticalScale = 1.0;

    // Perspective offset - adding to distance flattens perspective
    // Higher offset = less difference between near and far objects
    // At 20°: offset = 0 (normal perspective)
    // At 70°: offset = 100 (very flat perspective)
    const perspectiveOffset = (this.viewAngle - 20) * 2;

    // Overall scale - everything smaller when camera is higher
    // At 20°: scale = 1.0, At 70°: scale = 0.5
    const overallScale = 1 / (1 + perspectiveOffset * 0.01);

    return { verticalScale, perspectiveOffset, overallScale };
  }

  // Calculate screen position using perspective projection
  // worldPos: component's world position
  // elevation: component's height above ground (0 for ground-level objects)
  private worldToScreenPerspective(worldPos: Point, elevation: number = 0): { pos: Point, scale: number } {
    const rect = this.canvas.getBoundingClientRect();
    const horizonY = rect.height * 0.25;
    const groundHeight = rect.height - horizonY;
    const centerX = rect.width / 2;

    const { verticalScale, perspectiveOffset, overallScale } = this.getViewTransform();

    // Camera world position (stays fixed, doesn't move with view angle)
    const cameraWorldX = -(this.view.offsetX - centerX) / 10;
    const cameraWorldY = -this.cameraDepth / 10;

    // Position relative to camera
    const relX = worldPos.x - cameraWorldX;
    const relY = worldPos.y - cameraWorldY;

    if (relY < 1) {
      return { pos: { x: -1000, y: -1000 }, scale: 0 };
    }

    // Effective distance - adding offset flattens perspective for SCALE only
    // Higher offset = near and far objects appear more similar in size.
    // At view angles below 20° the offset is negative, and geometry closer
    // than |offset| sits behind the effective focal plane; its projected
    // scale would flip sign, so cull it exactly like relY < 1
    const effectiveRelY = relY + perspectiveOffset;
    if (effectiveRelY < 1) {
      return { pos: { x: -1000, y: -1000 }, scale: 0 };
    }

    // Perspective scale using effective distance (flatter at high angles)
    const perspectiveScale = this.CAMERA_HEIGHT / effectiveRelY;
    const cappedScale = Math.min(perspectiveScale, 3);

    // Apply overall scale (everything smaller when camera is higher)
    const finalScale = cappedScale * overallScale;

    // Screen X position
    const screenX = centerX + relX * finalScale * this.PERSPECTIVE_X_SCALE;

    // Screen Y position - use ACTUAL distance for position, so objects stay in place
    // Then stretch result toward screen center to fill the view
    const rawScreenY = horizonY + groundHeight * this.CAMERA_HEIGHT / relY;

    // Stretch factor: at high angles, the flatter perspective would compress everything
    // toward horizon. We stretch it back toward the screen center to fill the view.
    // At 20°: stretch = 1.0, At 70°: stretch ≈ 1.5-2.0
    const stretchFactor = 1 + perspectiveOffset * 0.01;
    const screenCenterY = horizonY + groundHeight * 0.4; // Reference point to stretch from
    const baseScreenY = screenCenterY + (rawScreenY - screenCenterY) * stretchFactor;

    // Apply elevation offset (compressed by view angle for looking from above)
    const elevationOffset = elevation * cappedScale * this.ELEVATION_SCALE * verticalScale * overallScale;
    const unzoomedY = baseScreenY - elevationOffset;

    // Zoom: uniform screen-space magnification of the finished projection
    // about the fixed anchor (centerX, screenCenterY). The camera does not
    // move, so this is exactly invertible and cannot drift the view.
    const zoomedX = centerX + (screenX - centerX) * this.isoZoom;
    const zoomedY = screenCenterY + (unzoomedY - screenCenterY) * this.isoZoom;

    return { pos: { x: zoomedX, y: zoomedY }, scale: finalScale * this.isoZoom };
  }

  // Inverse perspective projection: convert screen coordinates to world coordinates
  // Used for component placement in isometric mode
  private screenToWorldPerspective(screenPos: Point): Point {
    const rect = this.canvas.getBoundingClientRect();
    const horizonY = rect.height * 0.25;
    const groundHeight = rect.height - horizonY;
    const centerX = rect.width / 2;

    const { perspectiveOffset, overallScale } = this.getViewTransform();

    // Camera world position (stays fixed)
    const cameraWorldX = -(this.view.offsetX - centerX) / 10;
    const cameraWorldY = -this.cameraDepth / 10;

    // Un-apply the zoom magnification about its fixed anchor, then reverse
    // the stretch transformation
    const stretchFactor = 1 + perspectiveOffset * 0.01;
    const screenCenterY = horizonY + groundHeight * 0.4;
    const unzoomedX = centerX + (screenPos.x - centerX) / this.isoZoom;
    const unzoomedY = screenCenterY + (screenPos.y - screenCenterY) / this.isoZoom;
    const rawScreenY = screenCenterY + (unzoomedY - screenCenterY) / stretchFactor;

    // Now reverse the perspective projection
    const screenYFromHorizon = rawScreenY - horizonY;
    if (screenYFromHorizon <= 0) {
      return { x: cameraWorldX, y: cameraWorldY + 1000 };
    }

    const relY = groundHeight * this.CAMERA_HEIGHT / screenYFromHorizon;

    if (relY < 1) {
      return { x: cameraWorldX, y: cameraWorldY + 1 };
    }

    // Reverse X projection using effective distance for scale. Geometry this
    // close is culled by the forward projection at low view angles (negative
    // offset), so answer with the same near sentinel it uses
    const effectiveRelY = relY + perspectiveOffset;
    if (effectiveRelY < 1) {
      return { x: cameraWorldX, y: cameraWorldY + 1 };
    }
    const perspectiveScale = this.CAMERA_HEIGHT / effectiveRelY;
    const cappedScale = Math.min(perspectiveScale, 3);
    const finalScale = cappedScale * overallScale;

    const relX = (unzoomedX - centerX) / (finalScale * this.PERSPECTIVE_X_SCALE);

    return {
      x: relX + cameraWorldX,
      y: relY + cameraWorldY
    };
  }

  /**
   * Change the isometric zoom. Deliberately does NOT move the camera to
   * chase a zoom-toward-cursor anchor: camera moves here are world-space
   * (lateral + dolly) and a dolly changes the perspective nonlinearly, so
   * any compensation fights the magnification and drifts the view. The zoom
   * is instead a fixed-anchor magnification applied inside the projection.
   */
  private applyIsoZoom(newZoom: number): void {
    if (this.viewMode === 'grid') {
      this.grid.setZoomFactor(newZoom);
      this.syncIsoZoomUI();
      return;
    }
    this.isoZoom = Math.max(PlantCanvas.MIN_ISO_ZOOM, Math.min(PlantCanvas.MAX_ISO_ZOOM, newZoom));
    this.syncIsoZoomUI();
  }

  // Keep the sidebar zoom slider and readout in step with this.isoZoom
  // (mirrors how the wheel handler updates the view-angle slider)
  private syncIsoZoomUI(): void {
    const slider = document.getElementById('view-zoom') as HTMLInputElement | null;
    const display = document.getElementById('view-zoom-value');
    const zoom = this.viewMode === 'grid' ? this.grid.zoomFactor : this.isoZoom;
    if (slider) {
      // Slider is logarithmic: value = 100 * log10(zoom)
      slider.value = String(Math.round(100 * Math.log10(zoom)));
    }
    if (display) {
      display.textContent = String(Math.round(zoom * 100));
    }
  }

  // Public method to convert screen to world coordinates
  // Uses perspective projection when in isometric mode
  public getWorldPositionFromScreen(screenPos: Point): Point {
    if (this.viewMode === 'grid') {
      return this.grid.screenToWorld(screenPos);
    }
    return this.screenToWorldPerspective(screenPos);
  }

  // Public method to convert world coordinates to screen coordinates
  // Uses perspective projection when in isometric mode
  public getScreenPositionFromWorld(worldPos: Point, elevation: number = 0): Point {
    if (this.viewMode === 'grid') {
      return this.grid.worldToScreen(worldPos);
    }
    return this.worldToScreenPerspective(worldPos, elevation).pos;
  }

  // Get the screen Y coordinate for ground level (elevation 0) at a given world position
  // Used for clamping break connections so they don't go below ground
  public getGroundY(worldPos: Point): number | null {
    if (this.viewMode === 'grid') {
      return this.grid.worldToScreen(worldPos).y;
    }
    const result = this.worldToScreenPerspective(worldPos, 0);
    if (result.scale <= 0) return null;
    return result.pos.y;
  }

  // Get camera depth for external use (e.g., shrub rendering)
  public getCameraDepth(): number {
    return this.cameraDepth;
  }

  // Clamp view offset to keep content visible
  // In isometric mode, limit panning to a reasonable range
  /** Enable/disable RTS-style edge-scroll panning. */
  public setEdgePanEnabled(enabled: boolean): void {
    this.edgePanEnabled = enabled;
  }

  /** Pull edge-pan trigger boundaries inward (px) - e.g. bottom above the status bar. */
  public setEdgePanInsets(insets: Partial<{ top: number; right: number; bottom: number; left: number }>): void {
    this.edgePanInsets = { ...this.edgePanInsets, ...insets };
  }

  /**
   * RTS edge-scroll: if enabled and the cursor is within EDGE_PAN_MARGIN of a
   * canvas edge (and not mid-drag/placement), pan the camera toward that edge.
   * Speed ramps from 0 at the margin boundary to full at the very edge, and is
   * scaled by real elapsed time so it's framerate-independent. dtSeconds is the
   * time since the previous frame.
   */
  private updateEdgePan(dtSeconds: number): void {
    if (!this.edgePanEnabled) return;
    if (!this.mouseOverCanvas) return;
    if (this.isDragging || this.isMovingComponent) return; // don't fight an active drag

    const rect = this.canvas.getBoundingClientRect();
    const { x, y } = this.lastMouseScreen;
    const margin = PlantCanvas.EDGE_PAN_MARGIN;
    const ins = this.edgePanInsets;

    // Effective play-area edges (inset inward where a panel covers the edge)
    const leftEdge = ins.left;
    const rightEdge = rect.width - ins.right;
    const topEdge = ins.top;
    const bottomEdge = rect.height - ins.bottom;

    // Signed intensity per axis: -1..1 scaled by proximity to the (effective)
    // edge. 0 in the interior, ramping to 1 at the edge.
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    let ix = 0, iy = 0;
    if (x <= leftEdge + margin) ix = -clamp01((leftEdge + margin - x) / margin);
    else if (x >= rightEdge - margin) ix = clamp01((x - (rightEdge - margin)) / margin);
    if (y <= topEdge + margin) iy = -clamp01((topEdge + margin - y) / margin);
    else if (y >= bottomEdge - margin) iy = clamp01((y - (bottomEdge - margin)) / margin);

    if (ix === 0 && iy === 0) return;

    // Screen-space pan amount this frame. Moving the camera toward an edge means
    // shifting the world the opposite way, i.e. decreasing the offset on that side.
    const step = PlantCanvas.EDGE_PAN_SPEED * dtSeconds;
    const panX = -ix * step;
    const panY = -iy * step;

    if (this.viewMode === 'grid') {
      this.grid.panByPixels(panX, panY);
    } else {
      // Match the drag mapping: horizontal -> offsetX, vertical -> cameraDepth
      // (divided by zoom so the apparent pan speed is magnification-independent)
      this.view.offsetX += panX / this.isoZoom;
      this.cameraDepth -= panY / this.isoZoom;
    }
    this.clampView();
  }

  private clampView(): void {
    const rect = this.canvas.getBoundingClientRect();

    // Limit view.offsetY (vestigial in this mode - the perspective
    // projection does not read it; arrow keys now pan offsetX/cameraDepth)
    const minOffsetY = rect.height * 0.2;
    const maxOffsetY = rect.height * 1.2;
    this.view.offsetY = Math.max(minOffsetY, Math.min(maxOffsetY, this.view.offsetY));

    // Limit lateral movement (view.offsetX)
    const maxOffsetX = rect.width * 3;
    const minOffsetX = -rect.width * 2;
    this.view.offsetX = Math.max(minOffsetX, Math.min(maxOffsetX, this.view.offsetX));

    // Limit forward/backward movement (cameraDepth)
    const maxDepth = rect.height * 2;
    const minDepth = -rect.height * 2;
    this.cameraDepth = Math.max(minDepth, Math.min(maxDepth, this.cameraDepth));
  }

  /**
   * One animation frame, and the arming of the next one.
   *
   * THE LOOP MUST NOT BE ABLE TO STOP. It used to re-arm itself with a
   * `requestAnimationFrame` written at the end of the drawing code, so the
   * first frame that threw was also the last one ever drawn: the canvas
   * froze on that image, in every mode, for the rest of the session, while
   * the simulation went on running behind it. The only sign was one line in
   * the console. That is the quietest possible failure of the loudest
   * possible thing, and it is what a cracked spent fuel pool looked like to
   * the player - a picture of a full pool that never changed.
   *
   * The throw is NOT swallowed: it propagates out of the frame exactly as
   * before, once per frame, so the console says what is wrong for as long as
   * it is wrong. What changes is that the next frame is armed first, and the
   * frame after a failure starts from a clean 2D context - an aborted frame
   * can leave save() calls unmatched on the state stack.
   */
  public render(): void {
    if (this.frameAborted) {
      this.frameAborted = false;
      (this.ctx as CanvasRenderingContext2D & { reset?: () => void }).reset?.();
    }
    this.frameAborted = true;
    try {
      this.renderFrame();
    } finally {
      requestAnimationFrame(() => this.render());
    }
  }

  /** True while a frame is in flight; cleared when one completes normally. */
  private frameAborted = false;

  private renderFrame(): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();

    // Framerate-independent edge-scroll panning (uses real elapsed time)
    const now = performance.now();
    const dtSeconds = this.lastFrameTime === null ? 0 : Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.updateEdgePan(dtSeconds);

    if (this.viewMode === 'grid') {
      this.renderGridFrame(ctx, rect.width, rect.height);
      this.frameAborted = false;
      return;
    }

    const frameStart = performance.now();
    const profile: Record<string, number> = {};
    let markTime = frameStart;
    const mark = (section: string) => {
      const t = performance.now();
      profile[section] = (profile[section] ?? 0) + (t - markTime);
      markTime = t;
    };
    const dpr = window.devicePixelRatio || 1;
    this.spriteCache.beginFrame();
    const cameraKey = `${rect.width},${rect.height},${this.view.offsetX},${this.view.offsetY},${this.view.zoom},${this.cameraDepth},${this.viewAngle},${this.isoZoom},${this.isometric.enabled}`;
    const cameraMoving = cameraKey !== this.lastCameraKey;
    this.lastCameraKey = cameraKey;

    // Clear
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Ground motion: everything after this is drawn from a jolted camera.
    // The legend at the bottom is deliberately outside it - it is a panel on
    // the glass, not part of the view.
    const shake = this.shake.offset(rect.width, rect.height);
    if (shake) CameraShake.apply(ctx, shake, rect.width, rect.height);

    // Draw the ground (cached until the camera or viewport moves)
    const paintGround = (c: CanvasRenderingContext2D) =>
      renderIsometricGround(c, this.view, rect.width, rect.height, this.isometric, this.cameraDepth, this.viewAngle, this.isoZoom);
    if (this.renderCache.ground) {
      this.groundCache.draw(ctx, cameraKey, rect.width, rect.height, dpr, paintGround);
    } else {
      paintGround(ctx);
    }
    mark('ground');

    // Draw the layout grid on the ground plane while building
    if (this.showsBuildOverlays()) {
      renderDebugGrid(ctx, this.view, rect.width, rect.height, this.cameraDepth,
        (pos, elev) => this.worldToScreenPerspective(pos, elev));
    }

    // Sort components by depth for proper layering in isometric view
    // Larger Y = further from camera = draw first (behind)
    // Smaller Y = closer to camera = draw last (in front)
    // Also: contained components must be drawn after their containers

    // Helper to check if 'a' is contained by 'b' (directly or indirectly)
    const isContainedBy = (a: PlantComponent, bId: string): boolean => {
      const visited = new Set<string>();
      let current = a;
      while (current.containedBy) {
        if (current.containedBy === bId) return true;
        if (visited.has(current.id)) break; // Prevent infinite loop on circular refs
        visited.add(current.id);
        const parent = this.plantState.components.get(current.containedBy);
        if (!parent) break;
        current = parent;
      }
      return false;
    };

    const sortedComponents = Array.from(this.plantState.components.values())
      .filter(c => !(c as any).isHydraulicOnly) // Skip hydraulic-only components (no visual)
      .sort((a, b) => {
      // First priority: contained components are drawn after their containers
      // Check containment chain (a inside intermediate inside b)
      if (isContainedBy(a, b.id)) return 1;  // a is inside b (directly or indirectly), draw a last
      if (isContainedBy(b, a.id)) return -1; // b is inside a (directly or indirectly), draw b last

      // Second priority: depth sorting
      return paintDepthY(b) - paintDepthY(a);
    });
    this.planRuns = this.grid.planRuns(this.plantState);
    this.runMemo.clear();
    const foundations = this.foundationsFor(sortedComponents);

    mark('sort');
    // Draw shadows first
    // Shadows are computed in world space using 3D ray-plane intersection
    // Building floors go first, directly on the ground: shadows,
    // construction footprint outlines, and components all draw on top
    for (const component of sortedComponents) {
      if (component.type === 'building') {
        renderBuildingFloor(
          ctx,
          component as import('../types').BuildingComponent,
          (pos, elev = 0) => this.worldToScreenPerspective(pos, elev)
        );
      }
    }

    // Foundation pads under everything standing on grade - the same slabs
    // the grid view draws - under the shadows, which fall across them. One
    // batch for the built plant; a part still going up gets its own, faint.
    const pads: PlanRect[] = [];
    for (const component of sortedComponents) {
      const foundation = foundations.get(component.id);
      if (!foundation?.onGround) continue;
      if (buildGhost(component)) {
        ctx.globalAlpha = GHOST_ALPHA;
        this.renderPads(ctx, [foundation.rect]);
        ctx.globalAlpha = 1;
      } else {
        pads.push(foundation.rect);
      }
    }
    this.renderPads(ctx, pads);

    // Sun direction vector (direction light travels, from sun toward ground)
    // Sun at 45 degrees elevation, behind objects and slightly to the left
    const sunElevation = 45 * Math.PI / 180; // 45 degrees above horizon
    const sunAzimuth = 10 * Math.PI / 180;   // 10 degrees to the left
    const sunDirX = Math.sin(sunAzimuth) * Math.cos(sunElevation);   // ~0.16 (light goes right)
    const sunDirY = -Math.cos(sunAzimuth) * Math.cos(sunElevation);  // ~-0.92 (light goes toward camera)
    const sunDirZ = -Math.sin(sunElevation);                          // ~-0.34 (light goes down)

    // Shadow offset per unit of elevation: where ray hits ground
    // For point at (x, y, z), ray is (x, y, z) + t*(sunDirX, sunDirY, sunDirZ)
    // Hits ground when z + t*sunDirZ = 0, so t = -z/sunDirZ
    // Ground intersection: x - z*sunDirX/sunDirZ, y - z*sunDirY/sunDirZ
    const shadowOffsetXPerZ = -sunDirX / sunDirZ;  // 0.1 (shadow goes right)
    const shadowOffsetYPerZ = -sunDirY / sunDirZ;  // -0.4 (shadow goes toward camera)

    for (const component of sortedComponents) {
      try {
        // Skip shadows for contained components (they're inside something)
        if (component.containedBy) continue;

        // Skip shadows for switchyard (it has its own individual equipment shadows)
        if (component.type === 'switchyard') continue;

        // A component that IS a body of water has no body to cast one
        if (waterBodyOf(component as never)) continue;

        const size = this.getComponentSize(component);
        const worldWidth = size.width || 1;
        const worldHeight = size.height || 1;

        // Get component's elevation (z coordinate)
        const elevation = getComponentElevation(component);

        // Component center in world space
        // For most components, position IS the center
        // For pipes, position is at one end, so we need to offset to find the center
        // For buildings, shadow should be at the front (toward camera) not center
        let centerX = component.position.x;
        let centerY = component.position.y;

        // For buildings, move shadow origin to front of the building (toward camera = -Y)
        if (component.type === 'building') {
          const bldg = component as any;
          const bldgDepth = bldg.shape === 'cylinder' ? (bldg.diameter || 40) : (bldg.length || 40);
          centerY -= bldgDepth / 2;  // Move to front edge
        }
        // Note: pipe offset handled below by adjusting local corners

        // Component corners in local 3D space
        const halfW = worldWidth / 2;
        const cos = Math.cos(component.rotation);
        const sin = Math.sin(component.rotation);

        // For pipes, position is at one end, not center
        // Local x: pipes go from 0 to length (not centered like other components)
        let localLeft = -halfW;
        let localRight = halfW;
        if (component.type === 'pipe') {
          // Pipe starts at position (local x=0) and extends to length
          localLeft = 0;
          localRight = worldWidth; // = length
        }

        // Shadow is cast by the TOP of the component projecting onto the ground
        const baseElevation = elevation;

        // For pipes, shadow height is the diameter, not the length
        const shadowHeight = component.type === 'pipe' ? (component as any).diameter : worldHeight;
        const topZ = baseElevation + shadowHeight;

        // Base center corners (y=0 since components are drawn at midpoint)
        const baseFrontLeft = { x: localLeft, y: 0, z: baseElevation };
        const baseFrontRight = { x: localRight, y: 0, z: baseElevation };

        // Top center corners
        const topFrontLeft = { x: localLeft, y: 0, z: topZ };
        const topFrontRight = { x: localRight, y: 0, z: topZ };

        // Project all 4 corners to ground plane
        const shadowCorners: Point[] = [];
        const corners3D = [topFrontLeft, topFrontRight, baseFrontRight, baseFrontLeft];

        for (const local of corners3D) {
          // Rotate to world space
          const worldX = centerX + local.x * cos - local.y * sin;
          const worldY = centerY + local.x * sin + local.y * cos;
          const worldZ = local.z;

          // Ray from this point in sun direction hits ground at:
          const groundX = worldX + worldZ * shadowOffsetXPerZ;
          const groundY = worldY + worldZ * shadowOffsetYPerZ;

          shadowCorners.push({ x: groundX, y: groundY });
        }

        // Project shadow corners from world space to screen space
        const screenCorners = shadowCorners.map(corner =>
          this.worldToScreenPerspective(corner, 0)
        );

        // Skip if any corner is behind camera
        if (screenCorners.some(c => c.scale <= 0)) continue;

        ctx.save();

        // Draw shadow as polygon
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = 'rgba(20, 15, 10, 1)';
        ctx.beginPath();
        ctx.moveTo(screenCorners[0].pos.x, screenCorners[0].pos.y);
        for (let i = 1; i < screenCorners.length; i++) {
          ctx.lineTo(screenCorners[i].pos.x, screenCorners[i].pos.y);
        }
        ctx.closePath();
        ctx.fill();

        // For HX, add additional shadow pieces for plenum and bulge
        if (component.type === 'heatExchanger') {
          const hx = component as import('../types').HeatExchangerComponent;
          const isVertical = (hx.height || 8) > (hx.width || 2.5);
          const hxType = hx.hxType || 'utube';
          const shellDiameter = isVertical ? (hx.width || 2.5) : (hx.height || 2.5);
          const plenumLen = hx.plenumLength || 0;

          // Draw plenum shadow (extends below shell bottom for vertical, or to left for horizontal)
          if (plenumLen > 0) {
            const plenumCorners: Point[] = [];
            if (isVertical) {
              // Plenum extends below shell (z from elevation-plenumLen to elevation)
              const plenumBottom = elevation - plenumLen;
              const plenumTop = elevation;
              const plenumHalfW = shellDiameter / 2;
              const plenumCorners3D = [
                { x: -plenumHalfW, y: 0, z: plenumTop },
                { x: plenumHalfW, y: 0, z: plenumTop },
                { x: plenumHalfW, y: 0, z: plenumBottom },
                { x: -plenumHalfW, y: 0, z: plenumBottom }
              ];
              for (const local of plenumCorners3D) {
                const worldX = centerX + local.x * cos - local.y * sin;
                const worldY = centerY + local.x * sin + local.y * cos;
                const groundX = worldX + local.z * shadowOffsetXPerZ;
                const groundY = worldY + local.z * shadowOffsetYPerZ;
                plenumCorners.push({ x: groundX, y: groundY });
              }
            } else {
              // Horizontal: plenum extends to left (negative x)
              const shellLeft = -worldWidth / 2;
              const plenumCorners3D = [
                { x: shellLeft, y: 0, z: elevation },
                { x: shellLeft, y: 0, z: elevation + shellDiameter },
                { x: shellLeft - plenumLen, y: 0, z: elevation + shellDiameter },
                { x: shellLeft - plenumLen, y: 0, z: elevation }
              ];
              for (const local of plenumCorners3D) {
                const worldX = centerX + local.x * cos - local.y * sin;
                const worldY = centerY + local.x * sin + local.y * cos;
                const groundX = worldX + local.z * shadowOffsetXPerZ;
                const groundY = worldY + local.z * shadowOffsetYPerZ;
                plenumCorners.push({ x: groundX, y: groundY });
              }
            }

            const plenumScreenCorners = plenumCorners.map(c => this.worldToScreenPerspective(c, 0));
            if (!plenumScreenCorners.some(c => c.scale <= 0)) {
              ctx.beginPath();
              ctx.moveTo(plenumScreenCorners[0].pos.x, plenumScreenCorners[0].pos.y);
              for (let i = 1; i < plenumScreenCorners.length; i++) {
                ctx.lineTo(plenumScreenCorners[i].pos.x, plenumScreenCorners[i].pos.y);
              }
              ctx.closePath();
              ctx.fill();
            }
          }

          // Draw bulge shadow for U-tube (extends above shell top for vertical, or to right for horizontal)
          if (hxType === 'utube') {
            const bulgeRadius = shellDiameter / 2;
            const bulgeCorners: Point[] = [];
            if (isVertical) {
              // Bulge extends above shell (z from topZ to topZ + bulgeRadius)
              const bulgeBottom = topZ;
              const bulgeTop = topZ + bulgeRadius;
              const bulgeHalfW = shellDiameter / 2;
              const bulgeCorners3D = [
                { x: -bulgeHalfW, y: 0, z: bulgeBottom },
                { x: bulgeHalfW, y: 0, z: bulgeBottom },
                { x: bulgeHalfW, y: 0, z: bulgeTop },
                { x: -bulgeHalfW, y: 0, z: bulgeTop }
              ];
              for (const local of bulgeCorners3D) {
                const worldX = centerX + local.x * cos - local.y * sin;
                const worldY = centerY + local.x * sin + local.y * cos;
                const groundX = worldX + local.z * shadowOffsetXPerZ;
                const groundY = worldY + local.z * shadowOffsetYPerZ;
                bulgeCorners.push({ x: groundX, y: groundY });
              }
            } else {
              // Horizontal: bulge extends to right
              const shellRight = worldWidth / 2;
              const bulgeCorners3D = [
                { x: shellRight, y: 0, z: elevation },
                { x: shellRight, y: 0, z: elevation + shellDiameter },
                { x: shellRight + bulgeRadius, y: 0, z: elevation + shellDiameter },
                { x: shellRight + bulgeRadius, y: 0, z: elevation }
              ];
              for (const local of bulgeCorners3D) {
                const worldX = centerX + local.x * cos - local.y * sin;
                const worldY = centerY + local.x * sin + local.y * cos;
                const groundX = worldX + local.z * shadowOffsetXPerZ;
                const groundY = worldY + local.z * shadowOffsetYPerZ;
                bulgeCorners.push({ x: groundX, y: groundY });
              }
            }

            const bulgeScreenCorners = bulgeCorners.map(c => this.worldToScreenPerspective(c, 0));
            if (!bulgeScreenCorners.some(c => c.scale <= 0)) {
              ctx.beginPath();
              ctx.moveTo(bulgeScreenCorners[0].pos.x, bulgeScreenCorners[0].pos.y);
              for (let i = 1; i < bulgeScreenCorners.length; i++) {
                ctx.lineTo(bulgeScreenCorners[i].pos.x, bulgeScreenCorners[i].pos.y);
              }
              ctx.closePath();
              ctx.fill();
            }
          }
        }

        ctx.restore();
      } catch (e) {
        console.error('Shadow rendering error:', e);
      }
    }

    // Ground-level outlines: always while designing, and while the plant is
    // running only when the player is actually placing something (they are a
    // drawing aid, not part of the operating view)
    if (this.showsBuildOverlays()) {
      for (const component of sortedComponents) {
        this.renderGroundOutline(ctx, component);
      }
    }

    // Draw placement preview (footprint following cursor)
    if (this.placementPreview && this.buildMode) {
      this.renderPlacementPreview(ctx);
    }

    // Draw controller wires (control signal connections to cores)
    for (const component of sortedComponents) {
      if (component.type === 'controller') {
        const controller = component as ControllerComponent;
        if (controller.connectedCoreId) {
          const core = this.plantState.components.get(controller.connectedCoreId);
          if (core) {
            // Get screen positions based on view mode
            let controllerScreen: Point;
            let coreScreen: Point;

            const controllerElev = controller.elevation ?? 0;
            const coreElev = (core as any).elevation ?? 0;
            const controllerProj = this.worldToScreenPerspective(controller.position, controllerElev);
            const coreProj = this.worldToScreenPerspective(core.position, coreElev);
            controllerScreen = controllerProj.pos;
            coreScreen = coreProj.pos;

            // Draw thin black wire from controller to core
            ctx.save();
            ctx.strokeStyle = '#222';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]); // Dashed line for control signal

            ctx.beginPath();
            ctx.moveTo(controllerScreen.x, controllerScreen.y);
            // Draw with a slight curve
            const midX = (controllerScreen.x + coreScreen.x) / 2;
            const midY = Math.min(controllerScreen.y, coreScreen.y) - 20;
            ctx.quadraticCurveTo(midX, midY, coreScreen.x, coreScreen.y);
            ctx.stroke();

            // Draw small circle at core end
            ctx.setLineDash([]);
            ctx.fillStyle = '#222';
            ctx.beginPath();
            ctx.arc(coreScreen.x, coreScreen.y, 4, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
          }
        }
      }

      // Draw switchyard-to-generator electrical connections
      if (component.type === 'switchyard') {
        const switchyard = component as SwitchyardComponent;
        if (switchyard.connectedGeneratorId) {
          const generator = this.plantState.components.get(switchyard.connectedGeneratorId);
          if (generator && generator.type === 'turbine-generator') {
            const tg = generator as TurbineGeneratorComponent;

            // Get screen positions
            let switchyardScreen: Point;
            let generatorScreen: Point;

            const tgElev = tg.elevation ?? 0;

            // Switchyard position - project to footprint center (ground level)
            // The switchyard is drawn centered on its footprint, so target ground projection
            const switchyardProj = this.worldToScreenPerspective(switchyard.position, 0);
            switchyardScreen = {
              x: switchyardProj.pos.x,
              y: switchyardProj.pos.y
            };

            // Generator circle position (at exhaust end of turbine)
            const tgW = tg.width;
            const tgH = tg.height;
            const genR = tgH / 3;
            const isLeftRight = tg.orientation !== 'right-left';
            const genLocalX = isLeftRight ? (tgW / 2 + genR) : (-tgW / 2 - genR);

            // Transform to world coords
            const cos = Math.cos(tg.rotation);
            const sin = Math.sin(tg.rotation);
            const genWorldX = tg.position.x + genLocalX * cos;
            const genWorldY = tg.position.y + genLocalX * sin;

            // Project the generator's world position to screen space
            // The generator circle is drawn at local Y=0, which is the vertical center of the turbine
            // In perspective rendering, components are drawn at:
            //   translateY = centerScreen.pos.y - visualHalfH (upward from ground projection)
            // So the center (local Y=0) is at centerScreen.pos.y - visualHalfH in screen space
            const genProj = this.worldToScreenPerspective({ x: genWorldX, y: genWorldY }, tgElev);
            const visualHalfH = (tg.height / 2) * genProj.scale * 50 * this.getViewTransform().verticalScale;
            generatorScreen = {
              x: genProj.pos.x,
              y: genProj.pos.y - visualHalfH  // Center of generator circle
            };

            // Draw dashed electrical connection
            ctx.save();
            ctx.strokeStyle = '#222';
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 4]);

            ctx.beginPath();
            ctx.moveTo(switchyardScreen.x, switchyardScreen.y);
            ctx.lineTo(generatorScreen.x, generatorScreen.y);
            ctx.stroke();

            ctx.setLineDash([]);
            ctx.restore();
          }
        }
      }
    }

    // Power wiring (electrical model only): hair-thin twisted pairs run along
    // the ground between each supply and what it feeds, drawn before the
    // equipment so each cable disappears under the part it enters. A short
    // riser at each end climbs to a raised component's base.
    if (this.showWires && this.plantState.electrical?.enabled) {
      const elec = this.simState?.electrical;
      for (const run of wireRuns(this.plantState)) {
        const from = this.plantState.components.get(run.fromId);
        const to = this.plantState.components.get(run.toId);
        if (!from || !to || run.pts.length < 2) continue;
        const pts: Point[] = [];
        let scaleSum = 0;
        let visible = true;
        const push = (p: Point, elevation: number) => {
          const s = this.worldToScreenPerspective(p, elevation);
          if (s.scale <= 0) visible = false;
          pts.push(s.pos);
          scaleSum += s.scale;
        };
        push(run.pts[0], from.elevation ?? 0);
        for (const p of run.pts) push(p, 0);
        push(run.pts[run.pts.length - 1], to.elevation ?? 0);
        if (!visible) continue;
        const pitchPx = (scaleSum / pts.length) * 50 * TWIST_PITCH_M;
        const energized = elec ? (elec.elements[run.fromId]?.energized ?? false) : null;
        drawTwistedPair(ctx, pts, pitchPx, energized);
      }
    }

    mark('floors+shadows');
    // Draw components with perspective projection
    // Project all 4 corners individually for proper ground-plane alignment
    for (const component of sortedComponents) {
      ctx.save();

      // A part still being installed (or being taken back to the yard) is
      // drawn as itself, faint: it is not in the simulation yet, and the
      // ring drawn over it afterwards says how long that will last.
      const ghost = buildGhost(component);
      if (ghost) ctx.globalAlpha = GHOST_ALPHA;

      const elevation = getComponentElevation(component);
      const size = this.getComponentSize(component);
      const halfW = size.width / 2;
      const halfH = size.height / 2;

      // Component position (for pipes, this is at one end; for others, it's the center)
      const centerX = component.position.x;
      const centerY = component.position.y;

      // Component corners in local space (before rotation)
      const cos = Math.cos(component.rotation);
      const sin = Math.sin(component.rotation);

      // For pipes, local coords go from (0, -halfH) to (length, halfH)
      // For others, centered: (-halfW, -halfH) to (halfW, halfH)
      let localLeft = -halfW;
      let localRight = halfW;
      if (component.type === 'pipe') {
        localLeft = 0;
        localRight = size.width; // = length
      }

      // Define 4 corners: front-left, front-right, back-right, back-left
      // Front = toward camera (-Y in world), Back = toward horizon (+Y)
      const localCorners = [
        { x: localLeft, y: -halfH },   // front-left
        { x: localRight, y: -halfH },  // front-right
        { x: localRight, y: halfH },   // back-right
        { x: localLeft, y: halfH },    // back-left
      ];

      // Transform corners to world space and project to screen
      const screenCorners = localCorners.map(local => {
        const worldX = centerX + local.x * cos - local.y * sin;
        const worldY = centerY + local.x * sin + local.y * cos;
        return this.worldToScreenPerspective({ x: worldX, y: worldY }, elevation);
      });

      // Skip if any corner is behind camera
      if (screenCorners.some(c => c.scale <= 0 || c.scale < 0.05)) {
        ctx.restore();
        continue;
      }

      // A pipe is drawn along its plan route, the way the grid lays it,
      // turning square, sloping from one end's elevation to the other's
      if (component.type === 'pipe') {
        const pipe = component as PipeComponent;
        const run = this.pipeComponentRun(pipe);
        if (run) {
          drawPipeRun(ctx, run, pipe.fluid ? getFluidColor(pipe.fluid) : '#111',
            component.id === this.selectedComponentId ? 'rgba(100, 150, 255, 0.8)' : null);
        }
        ctx.restore();
        this.renderBelowGradeOverlay(ctx, component);
        continue;
      }

      // A raised component stands on a scaffold from whatever is under it:
      // the far faces go behind the component, the near face in front
      const foundation = foundations.get(component.id);
      if (foundation && foundation.top > foundation.base) this.renderScaffold(ctx, foundation, 'back');

      // Get the projected corner positions
      const frontLeft = screenCorners[0].pos;
      const frontRight = screenCorners[1].pos;

      // Use front edge width for zoom (may be overridden for non-pipe components)
      const frontWidth = Math.hypot(frontRight.x - frontLeft.x, frontRight.y - frontLeft.y);
      let projectedZoom = frontWidth / size.width;

      // Get vertical scale first - needed for translation calculation
      const { verticalScale } = this.getViewTransform();

      // Position the component based on how renderComponent draws it:
      // - For pipes: draws from (0,0) to (length,0), so translate to front-left
      // - For others: draws centered at (0,0), so translate to front-center, offset up by halfH
      // IMPORTANT: Account for verticalScale so the base of the component stays on the ground
      // after the vertical compression is applied
      let translateX: number;
      let translateY: number;
      // Screen-pixel offset from the component's drawing origin down to its
      // visual base (used to anchor the elevation label at the base)
      let labelBaseOffsetY = 0;

      // Other components draw centered at their position
      // Project the actual center point (component.position) to screen space
      const centerScreen = this.worldToScreenPerspective(
        { x: component.position.x, y: component.position.y },
        elevation
      );

      // Use center-based zoom for consistent sizing
      const centerZoom = centerScreen.scale * 50;
      const visualHalfH = halfH * centerZoom * verticalScale;

      // Position so the component's center is at the projected center point
      // Snap the drawing origin to a device pixel: a cached sprite blits
      // 1:1 without resampling, and the vector path lands on the same grid
      translateX = Math.round(centerScreen.pos.x * dpr) / dpr;
      translateY = Math.round((centerScreen.pos.y - visualHalfH) * dpr) / dpr;
      labelBaseOffsetY = visualHalfH;

      // Override projectedZoom with center-based zoom for this component
      projectedZoom = centerZoom;

      ctx.translate(translateX, translateY);
      // Skip rotation for pumps - they handle orientation internally via mirroring
      if (component.type !== 'pump') {
        ctx.rotate(component.rotation);
      }

      // Vertical compression based on view angle (looking from above = compressed).
      // Pipes never get here: they are drawn as runs above
      const componentVerticalScale = verticalScale;
      const isSelected = component.id === this.selectedComponentId;
      const isSimulating = !this.constructionMode;
      // Create projection function for components that need world-to-screen mapping
      // Returns both screen position and scale factor for proper perspective rendering
      const worldToScreenFn = (pos: Point, elev: number = 0) => this.worldToScreenPerspective(pos, elev);

      const keyStart = performance.now();
      const spriteKey = this.renderCache.sprites ? this.spriteKeyFor(component, isSelected, isSimulating) : null;
      profile['keys'] = (profile['keys'] ?? 0) + (performance.now() - keyStart);
      if (spriteKey !== null) {
        // Painted once into an offscreen canvas, blitted until something
        // the painter reads changes (scaled from a nearby zoom during a pan)
        const spriteView: ViewState = { ...this.view, zoom: projectedZoom };
        const sprite = this.spriteCache.get(
          component.id, `${spriteKey}|${componentVerticalScale}|${dpr}`, projectedZoom, cameraMoving,
          halfW * projectedZoom, halfH * projectedZoom * componentVerticalScale, componentVerticalScale, dpr,
          (sctx) => renderComponent(sctx, component, spriteView, isSelected, true, this.plantState.connections, isSimulating, this.plantState)
        );
        ComponentSpriteCache.blit(ctx, sprite, projectedZoom);
      } else {
        const isometricView: ViewState = { ...this.view, zoom: projectedZoom };
        ctx.scale(1, componentVerticalScale);
        renderComponent(ctx, component, isometricView, isSelected, true, this.plantState.connections, isSimulating, this.plantState, worldToScreenFn);
        // Reset scale so the elevation label's text isn't squished
        ctx.scale(1, 1 / componentVerticalScale);
      }

      renderElevationLabel(ctx, component, labelBaseOffsetY, projectedZoom / 50);

      ctx.restore();

      if (foundation && foundation.top > foundation.base) {
        if (ghost) ctx.globalAlpha = GHOST_ALPHA;
        this.renderScaffold(ctx, foundation, 'front');
        if (ghost) ctx.globalAlpha = 1;
      }

      // Bury the part of this component that sits below grade. Done inside
      // the depth-sorted loop so a component nearer the camera still draws
      // over the soil of one behind it.
      this.renderBelowGradeOverlay(ctx, component);
    }

    // Progress rings, over every ghost, once the plant is drawn
    for (const component of sortedComponents) {
      const g = buildGhost(component);
      if (!g) continue;
      const b = this.getComponentScreenBounds(component);
      if (!b || b.width === undefined || b.height === undefined) continue;
      drawBuildProgress(ctx, b.topCenter.x, b.topCenter.y + b.height / 2,
        Math.max(9, Math.min(b.width, b.height) * 0.34), g.progress, g.kind);
    }

    mark('components');
    profile['components'] -= profile['keys'] ?? 0;
    // Draw connections (on top of components so labels are visible)
    this.perspectiveRuns = [];
    for (const connection of this.plantState.connections) {
      const fromComponent = this.plantState.components.get(connection.fromComponentId);
      const toComponent = this.plantState.components.get(connection.toComponentId);

      if (fromComponent && toComponent) {
        const fromPort = fromComponent.ports.find(p => p.id === connection.fromPortId);
        const toPort = toComponent.ports.find(p => p.id === connection.toPortId);

        if (fromPort && toPort) {
          const touchesSelection = this.selectedComponentId !== null &&
            (connection.fromComponentId === this.selectedComponentId ||
             connection.toComponentId === this.selectedComponentId);
          // A pipe along the grid's route, lifted to the nozzles' heights;
          // a line with no route (an opening into the component's own
          // container, a cross-vessel mating face) is the short stub it was
          const run = this.connectionRunScreen(connection, fromComponent, fromPort, toComponent, toPort);
          if (run) {
            const ghost = buildGhost(connection);
            if (ghost) ctx.globalAlpha = GHOST_ALPHA;
            const fluid = this.getConnectionFluid(connection, fromComponent);
            // The selected flow path gets a cyan halo end to end; a line
            // joining the selected component, a yellow one
            const selected = connection === this.selectedConnection;
            const halo = selected ? 'rgba(80, 220, 255, 0.9)' : touchesSelection ? 'rgba(255, 255, 120, 0.85)' : null;
            drawPipeRun(ctx, run.pts, fluid ? this.getFluidColorForConnection(fluid) : '#667788', halo);
            if (selected) {
              // ...and a ring on each nozzle it joins, so both ends are unmistakable
              ctx.save();
              ctx.strokeStyle = 'rgba(80, 220, 255, 0.95)';
              ctx.lineWidth = 2.5;
              for (const end of [run.pts[0], run.pts[run.pts.length - 1]]) {
                ctx.beginPath();
                ctx.arc(end.x, end.y, Math.max(7, end.w), 0, Math.PI * 2);
                ctx.stroke();
              }
              ctx.restore();
            }
            if (ghost) ctx.globalAlpha = 1;
            // Remember the drawn run, so a click on it can pick this flow path out
            this.perspectiveRuns.push({ conn: connection, pts: run.pts, halfWidth: Math.max(...run.pts.map(p => p.w)) / 2 });
          } else {
            this.renderConnectionPerspective(ctx, fromComponent, fromPort, toComponent, toPort, connection, touchesSelection);
          }
        }
      }
    }

    mark('connections');
    // Restore each building's near footprint wall on top of its contents, so
    // equipment inside a building reads as inside it (see the function's
    // comment) rather than standing in front of the shell.
    for (const component of sortedComponents) {
      if (component.type !== 'building') continue;
      renderBuildingFrontEdge(
        ctx,
        component as import('../types').BuildingComponent,
        (pos, elev = 0) => this.worldToScreenPerspective(pos, elev)
      );
    }

    // Elevation nudge arrows go above everything so they are never buried
    // under a component in front of the one they belong to
    this.renderElevationArrows(ctx, sortedComponents);

    // Draw port indicators if enabled
    if (this.showPorts) {
      this.renderPortIndicators(ctx);
    }

    mark('edges+arrows+ports');
    // Draw flow connection arrows from simulation state (on top of components)
    if (this.simState) {
      // Port screen positions and connection endpoints (accounting for
      // elevation offsets) come from the projection
      const getPortScreenPos = (comp: PlantComponent, port: { position: Point }) => this.getPortScreenPosition(comp, port);
      const getConnScreenPos = (fromComp: PlantComponent, toComp: PlantComponent, conn: Connection) => this.getConnectionScreenEndpoints(fromComp, toComp, conn);
      this.flowArrowHits = [];
      renderFlowConnectionArrows(ctx, this.simState, this.plantState, this.view, getPortScreenPos, getConnScreenPos,
        (conn, x, y, size) => this.flowArrowHits.push({ conn, x, y, size }));
    } else {
      // Debug: log once if simState is not set
      if (!this._simStateWarningLogged) {
        console.log('[Canvas] simState is null, skipping flow arrows');
        this._simStateWarningLogged = true;
      }
    }

    mark('flow arrows');
    // Draw pressure gauges on flow nodes
    if (this.simState) {
      // Pass screen bounds getter function for proper gauge positioning
      const getScreenBounds = (comp: PlantComponent) => this.getComponentScreenBounds(comp);
      renderPressureGauge(ctx, this.simState, this.plantState, this.view, getScreenBounds);

      // Draw thermometers on large hydraulic nodes
      renderThermometers(ctx, this.simState, this.plantState, this.view, getScreenBounds);

      // Every break, resolved once: the marker, the discharge line and the
      // spray all hang off the same anchor.
      const breaks = this.currentBreaks();
      const anchorFor = breakAnchorLookup(breaks);

      // Draw burst overlays (the warning border and the burst marker)
      renderBurstOverlays(ctx, this.simState, this.plantState, this.view, getScreenBounds, anchorFor);

      // Draw break connections (red dashed lines for LOCA flows)
      const getGroundY = (worldPos: Point) => this.getGroundY(worldPos);
      renderBreakConnections(ctx, this.simState, this.plantState, this.view, undefined, getScreenBounds, getGroundY, anchorFor);

      // The hole and what is coming out of it - the same drawing the grid
      // uses, on the same anchor, scaled by the break's own mass flow.
      drawBreaks(ctx, breaks, performance.now());

      // Cladding that is burning. The intensity is the chemical power the
      // oxidation operator released, so the flames rise as the reaction runs
      // away and die back as the metal or the oxygen is used up.
      this.renderFires(ctx, getScreenBounds);
    }

    // The selected flow path's label, over everything the plant draws
    this.drawSelectedArrowRing(ctx);
    this.drawSelectedFlowPathLabel(ctx, rect.width, rect.height);

    mark('gauges+overlays');
    this.lastFrameMs = performance.now() - frameStart;
    this.frameProfile = profile;

    if (shake) ctx.restore();

    // Draw color legend at bottom of canvas
    renderColorLegend(ctx, rect.width, rect.height);

    this.frameAborted = false;
  }

  private getPortWorldPosition(component: PlantComponent, port: { position: Point }): Point {
    const cos = Math.cos(component.rotation);
    const sin = Math.sin(component.rotation);
    return {
      x: component.position.x + port.position.x * cos - port.position.y * sin,
      y: component.position.y + port.position.x * sin + port.position.y * cos,
    };
  }

  // Component drawn size / default size live in component-size.ts so the
  // grid view shares one convention with this class
  /**
   * Everything the component's painter reads, as a string, or null when the
   * component is not sprite-cacheable (pipes are drawn inline as tapered
   * trapezoids; switchyards, buildings and cross vessels project their own
   * world points and so depend on the whole camera).
   */
  private spriteKeyFor(component: PlantComponent, isSelected: boolean, isSimulating: boolean): string | null {
    switch (component.type) {
      case 'tank': case 'pump': case 'vessel': case 'valve': case 'heatExchanger':
      case 'turbine-generator': case 'turbine-driven-pump': case 'condenser':
      case 'reactorVessel': case 'controller':
        break;
      default:
        return null;
    }
    let key = quantizedKey(component);
    if (component.type === 'reactorVessel') {
      // The vessel painter looks up its core barrel's fluid, the vessel/barrel
      // connections (for the plate holes) and the reactor power readout
      const barrelId = (component as import('../types').ReactorVesselComponent).coreBarrelId;
      const barrel = barrelId ? this.plantState.components.get(barrelId) : undefined;
      if (barrel) key += '|' + quantizedKey(barrel);
      for (const c of this.plantState.connections) {
        if (c.fromComponentId === component.id || c.toComponentId === component.id ||
            (barrelId && (c.fromComponentId === barrelId || c.toComponentId === barrelId))) {
          key += `|${c.fromComponentId}.${c.fromPortId}>${c.toComponentId}.${c.toPortId}`;
        }
      }
      // Readouts are keyed at the precision they are drawn with
      const rp = getReactorPowerState();
      key += `|${rp.coreId}|${formatCorePowerLabel(rp.thermalPower)}`;
    } else if (component.type === 'valve' && (component as import('../types').ValveComponent).valveType === 'check') {
      // The check-valve painter orients its flapper by the lines on the
      // valve (checkValveFlowSign), so re-plumbing it must repaint
      for (const c of this.plantState.connections) {
        if (c.fromComponentId === component.id || c.toComponentId === component.id) {
          key += `|${c.fromComponentId}.${c.fromPortId}>${c.toComponentId}.${c.toPortId}`;
        }
      }
    } else if (component.type === 'turbine-generator') {
      key += `|${Math.round(getTurbineCondenserState().turbinePower / 1e6)}`;
    } else if (component.type === 'condenser') {
      key += `|${Math.round(getTurbineCondenserState().condenserHeatRejection / 1e6)}`;
    }
    if (isSimulating && keyAnimates(key)) key += `|t${getTimeSeed()}`;
    return `${key}|${isSelected ? 1 : 0}|${isSimulating ? 1 : 0}`;
  }

  private getComponentSize(component: PlantComponent): { width: number; height: number } {
    return getComponentSize(component);
  }

  private getDefaultComponentSize(componentType: string): { width: number; height: number } {
    return getDefaultComponentSize(componentType);
  }

  // Set placement preview (for showing footprint when placing a component)
  public setPlacementPreview(componentType: string | null, position: Point | null): void {
    if (componentType && position) {
      this.placementPreview = { componentType, position };
    } else {
      this.placementPreview = null;
    }
  }

  private renderPortIndicators(ctx: CanvasRenderingContext2D): void {
    for (const component of this.plantState.components.values()) {
      if (!component.ports) continue;

      for (const port of component.ports) {
        let screenPos: Point;
        let portRadius: number;
        let lineWidth: number;

        // Use the same positioning as click detection
        const portScreenPos = this.getPortScreenPosition(component, port);
        if (!portScreenPos) continue;

        screenPos = { x: portScreenPos.x, y: portScreenPos.y };
        portRadius = portScreenPos.radius;
        lineWidth = Math.max(1, portRadius * 0.25);

        // Check if this port is highlighted
        const isHighlighted = this.highlightedPort &&
          this.highlightedPort.componentId === component.id &&
          this.highlightedPort.portId === port.id;

        const displayRadius = isHighlighted ? portRadius * 1.5 : portRadius;

        // Draw port circle
        ctx.beginPath();
        ctx.arc(screenPos.x, screenPos.y, displayRadius, 0, Math.PI * 2);

        // Color based on port direction
        if (port.direction === 'in') {
          ctx.fillStyle = isHighlighted ? 'rgba(100, 255, 100, 0.9)' : 'rgba(100, 200, 100, 0.7)';  // Green for inlet
        } else if (port.direction === 'out') {
          ctx.fillStyle = isHighlighted ? 'rgba(255, 100, 100, 0.9)' : 'rgba(200, 100, 100, 0.7)';  // Red for outlet
        } else {
          ctx.fillStyle = isHighlighted ? 'rgba(100, 200, 255, 0.9)' : 'rgba(100, 150, 200, 0.7)';  // Blue for bidirectional
        }

        ctx.fill();
        ctx.strokeStyle = isHighlighted ? 'rgba(255, 255, 255, 1)' : 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = isHighlighted ? lineWidth * 1.5 : lineWidth;
        ctx.stroke();

        // Draw direction arrow inside inlet/outlet ports
        if (port.direction === 'in' || port.direction === 'out') {
          // Calculate direction from port to component center
          const dx = -port.position.x;  // Direction toward center
          const dy = -port.position.y;
          const len = Math.sqrt(dx * dx + dy * dy);

          if (len > 0.01) {
            // Normalize direction vector
            let dirX = dx / len;
            let dirY = dy / len;

            // Flip direction for outlet ports (point away from center)
            if (port.direction === 'out') {
              dirX = -dirX;
              dirY = -dirY;
            }

            // Arrow parameters scale with port radius
            const arrowLen = displayRadius * 0.55;
            const headLen = displayRadius * 0.35;
            const headAngle = Math.PI / 5;

            // Arrow start and end points
            const startX = screenPos.x - dirX * arrowLen;
            const startY = screenPos.y - dirY * arrowLen;
            const endX = screenPos.x + dirX * arrowLen;
            const endY = screenPos.y + dirY * arrowLen;

            // Arrow head points
            const angle = Math.atan2(dirY, dirX);
            const head1X = endX + headLen * Math.cos(angle + Math.PI - headAngle);
            const head1Y = endY + headLen * Math.sin(angle + Math.PI - headAngle);
            const head2X = endX + headLen * Math.cos(angle + Math.PI + headAngle);
            const head2Y = endY + headLen * Math.sin(angle + Math.PI + headAngle);

            ctx.strokeStyle = '#fff';
            ctx.lineWidth = Math.max(1, displayRadius * 0.2);
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(endX, endY);
            ctx.moveTo(head1X, head1Y);
            ctx.lineTo(endX, endY);
            ctx.lineTo(head2X, head2Y);
            ctx.stroke();
          }
        }

        // Add pulsing effect for highlighted port
        if (isHighlighted) {
          ctx.beginPath();
          const pulseRadius = displayRadius * 1.3 + Math.sin(Date.now() * 0.003) * (portRadius * 0.3);
          ctx.arc(screenPos.x, screenPos.y, pulseRadius, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 100, 0.5)';
          ctx.lineWidth = lineWidth;
          ctx.stroke();
        }
      }
    }
  }

  // Render a connection between two ports with perspective projection
  // Uses actual connection elevations (fromElevation/toElevation) instead of port visual positions
  private renderConnectionPerspective(
    ctx: CanvasRenderingContext2D,
    fromComponent: PlantComponent,
    fromPort: { position: Point },
    toComponent: PlantComponent,
    toPort: { position: Point },
    connection: Connection,
    highlight: boolean = false
  ): void {
    // Vessel side ports draw on the edge facing the partner (mirroring
    // only changes the lateral offset, never the y the elevation math uses)
    fromPort = this.portForConnectionDrawing(fromComponent, fromPort, toComponent, toPort);
    toPort = this.portForConnectionDrawing(toComponent, toPort, fromComponent, fromPort);

    // Get port screen positions (these are visually consistent with component rendering)
    const fromPortScreen = this.getPortScreenPosition(fromComponent, fromPort);
    const toPortScreen = this.getPortScreenPosition(toComponent, toPort);

    if (!fromPortScreen || !toPortScreen) return;

    // Get component base elevations
    const fromCompElevation = getComponentElevation(fromComponent);
    const toCompElevation = getComponentElevation(toComponent);

    // Connection elevation is relative to component bottom
    const fromConnElevation = connection.fromElevation ?? 0;
    const toConnElevation = connection.toElevation ?? 0;

    // Calculate the port's visual elevation relative to component bottom
    // Port position.y is in local coordinates where Y=0 is component center
    // Negative Y is toward the top (front in world), positive Y is toward the bottom (back in world)
    // So port elevation from bottom = componentHeight/2 - port.position.y
    const fromSize = this.getComponentSize(fromComponent);
    const toSize = this.getComponentSize(toComponent);
    const fromPortVisualElev = fromSize.height / 2 - fromPort.position.y;
    const toPortVisualElev = toSize.height / 2 - toPort.position.y;

    // Calculate the DIFFERENCE between where the connection should be and where the port appears
    // Positive diff = connection is higher than port visual position
    const fromElevDiff = fromConnElevation - fromPortVisualElev;
    const toElevDiff = toConnElevation - toPortVisualElev;

    // Get the vertical transform for elevation changes
    const { verticalScale } = this.getViewTransform();

    // For non-pipe components, we need to use the center-based scale that getPortScreenPosition uses
    // For pipes, we use the port world position scale
    let fromScale: number;
    let toScale: number;

    if (fromComponent.type === 'pipe') {
      const fromPortWorld = this.getPortWorldPosition(fromComponent, fromPort);
      const fromProj = this.worldToScreenPerspective(fromPortWorld, fromCompElevation);
      if (fromProj.scale <= 0) return;
      fromScale = fromProj.scale;
    } else {
      const fromCenterProj = this.worldToScreenPerspective(
        { x: fromComponent.position.x, y: fromComponent.position.y },
        fromCompElevation
      );
      if (fromCenterProj.scale <= 0) return;
      fromScale = fromCenterProj.scale * 50; // Match centerZoom calculation
    }

    if (toComponent.type === 'pipe') {
      const toPortWorld = this.getPortWorldPosition(toComponent, toPort);
      const toProj = this.worldToScreenPerspective(toPortWorld, toCompElevation);
      if (toProj.scale <= 0) return;
      toScale = toProj.scale;
    } else {
      const toCenterProj = this.worldToScreenPerspective(
        { x: toComponent.position.x, y: toComponent.position.y },
        toCompElevation
      );
      if (toCenterProj.scale <= 0) return;
      toScale = toCenterProj.scale * 50; // Match centerZoom calculation
    }

    // Calculate elevation offset in screen pixels based on the DIFFERENCE
    // Since getPortScreenPosition uses centerZoom = scale * 50, we need to convert
    // elevation differences to pixels using the same scaling
    const fromElevationOffset = fromElevDiff * fromScale * this.ELEVATION_SCALE / 50 * verticalScale;
    const toElevationOffset = toElevDiff * toScale * this.ELEVATION_SCALE / 50 * verticalScale;

    // Apply elevation offset to port screen positions (negative because Y increases downward)
    const fromScreen = {
      pos: { x: fromPortScreen.x, y: fromPortScreen.y - fromElevationOffset },
      scale: fromScale
    };
    const toScreen = {
      pos: { x: toPortScreen.x, y: toPortScreen.y - toElevationOffset },
      scale: toScale
    };

    if (fromScreen.scale <= 0 || toScreen.scale <= 0) return;

    let adjustedFromScreen = fromScreen.pos;
    let adjustedToScreen = toScreen.pos;

    // Special handling for cross-vessel connections
    // Cross-vessels physically connect to their targets, so the connection should be very short
    // to avoid drawing a gap between them
    const isCrossVesselConnection = fromComponent.type === 'crossVessel' || toComponent.type === 'crossVessel';
    if (isCrossVesselConnection) {
      // For cross-vessel connections, make the connection line very short (5% of distance)
      // This creates a nearly seamless appearance
      const fromIsCrossVessel = fromComponent.type === 'crossVessel';
      const crossVessel = fromIsCrossVessel ? fromComponent : toComponent;
      const targetId = (crossVessel as any).targetComponentId;

      // If this connection is between cross-vessel and its designated target, minimize the line
      if (targetId && (targetId === fromComponent.id || targetId === toComponent.id)) {
        const t = 0.05;
        const midX = (fromScreen.pos.x + toScreen.pos.x) / 2;
        const midY = (fromScreen.pos.y + toScreen.pos.y) / 2;
        adjustedFromScreen = {
          x: fromScreen.pos.x + (1 - t) * (midX - fromScreen.pos.x) * 2,
          y: fromScreen.pos.y + (1 - t) * (midY - fromScreen.pos.y) * 2
        };
        adjustedToScreen = {
          x: toScreen.pos.x + (1 - t) * (midX - toScreen.pos.x) * 2,
          y: toScreen.pos.y + (1 - t) * (midY - toScreen.pos.y) * 2
        };
      }
    }
    else {
      const adjusted = this.adjustEndpointsForContainment(
        fromComponent, toComponent, fromScreen.pos, toScreen.pos);
      adjustedFromScreen = adjusted.from;
      adjustedToScreen = adjusted.to;
    }

    const fluid = this.getConnectionFluid(connection, fromComponent);
    const strokeConnection = () => {
      ctx.beginPath();
      ctx.moveTo(adjustedFromScreen.x, adjustedFromScreen.y);
      // Simple curved connection in screen space
      const midX = (adjustedFromScreen.x + adjustedToScreen.x) / 2;
      const midY = (adjustedFromScreen.y + adjustedToScreen.y) / 2;
      ctx.quadraticCurveTo(midX, adjustedFromScreen.y, midX, midY);
      ctx.quadraticCurveTo(midX, adjustedToScreen.y, adjustedToScreen.x, adjustedToScreen.y);
      ctx.stroke();
    };

    // Remember the drawn run, so a click on it can pick this flow path out
    this.perspectiveRuns.push({ conn: connection, pts: sampleConnectionCurve(adjustedFromScreen, adjustedToScreen) });

    ctx.lineCap = 'round';
    const selected = connection === this.selectedConnection;
    if (selected) {
      // Selected flow path: a wide cyan halo along its whole length
      ctx.strokeStyle = 'rgba(80, 220, 255, 0.9)';
      ctx.lineWidth = 11;
      strokeConnection();
    } else if (highlight) {
      // Selected component: draw a bright halo under the connection so every
      // attached line is unambiguous
      ctx.strokeStyle = 'rgba(255, 255, 120, 0.85)';
      ctx.lineWidth = 8;
      strokeConnection();
    }
    ctx.strokeStyle = fluid ? this.getFluidColorForConnection(fluid) : '#667788';
    ctx.lineWidth = 4;
    strokeConnection();
    if (selected) {
      // ...and a ring on each nozzle it joins, so both ends are unmistakable
      ctx.strokeStyle = 'rgba(80, 220, 255, 0.95)';
      ctx.lineWidth = 2.5;
      for (const end of [adjustedFromScreen, adjustedToScreen]) {
        ctx.beginPath();
        ctx.arc(end.x, end.y, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  /**
   * A connection's pipe run on screen: the grid view's plan route, lifted
   * into 3D between the two nozzles as drawn (liftRoute), projected, with
   * the pipe's bore giving its width at every vertex. Null when the line has
   * no route (an opening between a component and its container), when a
   * cross-vessel mates face to face with its target, or when any of it is
   * behind the camera.
   */
  private connectionRunScreen(
    connection: Connection,
    fromComponent: PlantComponent,
    storedFromPort: { position: Point },
    toComponent: PlantComponent,
    storedToPort: { position: Point }
  ): { pts: RunVertex[]; scale: number } | null {
    // Drawn and then asked again for its flow arrow in the same frame
    if (this.runMemo.has(connection)) return this.runMemo.get(connection)!;
    const run = this.computeConnectionRun(connection, fromComponent, storedFromPort, toComponent, storedToPort);
    this.runMemo.set(connection, run);
    return run;
  }

  private computeConnectionRun(
    connection: Connection,
    fromComponent: PlantComponent,
    storedFromPort: { position: Point },
    toComponent: PlantComponent,
    storedToPort: { position: Point }
  ): { pts: RunVertex[]; scale: number } | null {
    const crossVessel = fromComponent.type === 'crossVessel' ? fromComponent
      : toComponent.type === 'crossVessel' ? toComponent : undefined;
    const mateId = crossVessel ? (crossVessel as { targetComponentId?: string }).targetComponentId : undefined;
    if (mateId && (mateId === fromComponent.id || mateId === toComponent.id)) return null;
    const plan = this.planRuns.get(connection);
    if (!plan || plan.length < 2) return null;
    const fromPort = this.portForConnectionDrawing(fromComponent, storedFromPort, toComponent, storedToPort);
    const toPort = this.portForConnectionDrawing(toComponent, storedToPort, fromComponent, storedFromPort);
    const a = this.nozzle3D(fromComponent, fromPort, connection.fromElevation ?? 0);
    const b = this.nozzle3D(toComponent, toPort, connection.toElevation ?? 0);
    if (!a || !b) return null;
    const path = liftRoute(a, this.leaveAxis(fromComponent, plan[0]), plan,
      b, this.leaveAxis(toComponent, plan[plan.length - 1]));
    const bore = connection.flowArea && connection.flowArea > 0 ? Math.sqrt(4 * connection.flowArea / Math.PI) : 0.3;
    const pts = this.projectRun(path, bore);
    return pts ? { pts, scale: (a.scale + b.scale) / 2 } : null;
  }

  /**
   * Where a connection meets a component in 3D: the nozzle as the component
   * drawing places it (lateral offset on the drawing, at the component's own
   * plan depth) at the connection's stored elevation - so the projected
   * point is exactly where the drawn nozzle is. A pipe's nozzle is its end.
   */
  private nozzle3D(component: PlantComponent, port: { position: Point }, connElevation: number): (Point3 & { scale: number }) | null {
    if (component.type === 'pipe') {
      const pipe = component as PipeComponent;
      const atEnd = port.position.x > pipe.length / 2;
      const plan = atEnd && pipe.endPosition ? pipe.endPosition : pipe.position;
      const end = atEnd && pipe.endElevation !== undefined ? pipe.endElevation : (pipe.elevation ?? 0);
      // A connection elevation is measured from the component's bottom, and
      // a pipe's bottom is half a bore under its centreline
      const z = end + connElevation - (pipe.diameter || 0) / 2;
      const s = this.worldToScreenPerspective(plan, z);
      return s.scale > 0 ? { x: plan.x, y: plan.y, z, scale: s.scale } : null;
    }
    const elevation = getComponentElevation(component);
    const center = this.worldToScreenPerspective(component.position, elevation);
    const portScreen = this.getPortScreenPosition(component, port);
    if (center.scale <= 0 || !portScreen) return null;
    return {
      x: component.position.x + (portScreen.x - center.pos.x) / (center.scale * 50),
      y: component.position.y,
      z: elevation + connElevation,
      scale: center.scale,
    };
  }

  /** Which plan axis a route leaves a component's footprint along, from the edge its anchor is on. */
  private leaveAxis(component: PlantComponent, anchor: Point): 'x' | 'y' {
    if (component.type === 'pipe') return 'x';
    const r = footprintRect(component.position, componentFootprint(component));
    const nx = Math.abs(anchor.x - component.position.x) / ((r.x1 - r.x0) / 2);
    const ny = Math.abs(anchor.y - component.position.y) / ((r.y1 - r.y0) / 2);
    return nx >= ny ? 'x' : 'y';
  }

  /** A pipe component on screen: its plan route (as the grid lays it), sloping from one end's elevation to the other's. */
  private pipeComponentRun(pipe: PipeComponent): RunVertex[] | null {
    const plan = this.planRuns.get(pipe) ?? pipeRoute(pipe);
    const startZ = pipe.elevation ?? 0;
    const path = slopeRoute(plan, startZ, pipe.endElevation ?? startZ);
    return this.projectRun(path, pipe.diameter || 0.3);
  }

  /** Project a 3D run; its drawn width is the bore at each vertex's scale, never under 3 px. */
  private projectRun(path: Point3[], bore: number): RunVertex[] | null {
    const pts: RunVertex[] = [];
    for (const p of path) {
      const s = this.worldToScreenPerspective({ x: p.x, y: p.y }, p.z);
      if (s.scale <= 0) return null;
      pts.push({ x: s.pos.x, y: s.pos.y, w: Math.max(3, bore * s.scale * 50) });
    }
    return pts.length >= 2 ? pts : null;
  }

  /**
   * What every standing component rests on. A component rests on the
   * highest top, among the other standing components whose footprint holds
   * its centre, that is no higher than its own base - or on grade if there
   * is none (or that top is at or below grade). Buildings, yards, pools and
   * water are the ground itself; pipes carry no foundation; and anything
   * inside a vessel is carried by the vessel.
   *
   * Two things are carried without one. A small fitting on a line - one tile
   * of footprint, with a connection on it (a valve, an orifice, a small
   * pump) - hangs off its piping. And anything whose footprint reaches into
   * a building's wall, below the top of that wall (a duct passing through
   * it), is carried by the wall. A cross-vessel is a protrusion of its
   * parent vessel's pressure boundary, so the vessels it joins carry it. Up
   * in the air none of these gets scaffold or pad; standing on something it
   * keeps its pad like anything else.
   */
  private foundationsFor(components: PlantComponent[]): Map<string, Foundation> {
    const piped = new Set<string>();
    for (const conn of this.plantState.connections) {
      piped.add(conn.fromComponentId);
      piped.add(conn.toComponentId);
    }
    const buildings = components.filter(c => c.type === 'building') as import('../types').BuildingComponent[];
    const inWall = (r: PlanRect, base: number): boolean => buildings.some(b => {
      if (base > b.height) return false;
      const t = b.wallThickness;
      if (b.shape === 'cylinder') {
        const R = (b.diameter || 40) / 2;
        const { x: cx, y: cy } = b.position;
        const nearest = Math.hypot(Math.max(r.x0 - cx, 0, cx - r.x1), Math.max(r.y0 - cy, 0, cy - r.y1));
        const farthest = Math.hypot(Math.max(Math.abs(r.x0 - cx), Math.abs(r.x1 - cx)), Math.max(Math.abs(r.y0 - cy), Math.abs(r.y1 - cy)));
        return nearest <= R && farthest >= R - t;
      }
      const hw = (b.width || 40) / 2, hl = (b.length || 40) / 2;
      const o = { x0: b.position.x - hw, x1: b.position.x + hw, y0: b.position.y - hl, y1: b.position.y + hl };
      const overlapsOuter = r.x0 <= o.x1 && r.x1 >= o.x0 && r.y0 <= o.y1 && r.y1 >= o.y0;
      const insideInner = r.x0 > o.x0 + t && r.x1 < o.x1 - t && r.y0 > o.y0 + t && r.y1 < o.y1 - t;
      return overlapsOuter && !insideInner;
    });
    const standing = components
      .filter(c => c.type !== 'pipe' && !isGroundLayerComponent(c))
      .filter(c => {
        const container = c.containedBy ? this.plantState.components.get(c.containedBy) : undefined;
        return !container || container.type === 'building';
      })
      .map(c => {
        const base = getComponentElevation(c);
        const fp = componentFootprint(c);
        return {
          c, rect: footprintRect(c.position, fp), base, top: base + getComponentVisualHeight(c),
          hangs: fp.w === 1 && fp.d === 1 && piped.has(c.id),
        };
      });
    const out = new Map<string, Foundation>();
    for (const s of standing) {
      const { x, y } = s.c.position;
      let support = -Infinity;
      for (const o of standing) {
        if (o === s || o.top > s.base || o.top <= support) continue;
        if (x >= o.rect.x0 && x <= o.rect.x1 && y >= o.rect.y0 && y <= o.rect.y1) support = o.top;
      }
      const onGround = !(support > 0);
      const base = onGround ? 0 : support;
      if (s.base > base && (s.hangs || s.c.type === 'crossVessel' || inWall(s.rect, s.base))) continue;
      out.set(s.c.id, { rect: s.rect, base, top: s.base, onGround });
    }
    return out;
  }

  /**
   * Concrete slabs under components standing on grade - the 2.5D twin of
   * the grid's foundation pads: the same footprints, standing out past them
   * by the same margin, and a little proud of grade so the near edge reads.
   * Drawn as a batch, one path per face colour, since they are all concrete
   * lying on the same ground.
   */
  private renderPads(ctx: CanvasRenderingContext2D, rects: PlanRect[]): void {
    const t = PAD_THICKNESS_M;
    const P = (x: number, y: number, z: number) => this.worldToScreenPerspective({ x, y }, z).pos;
    const sides: Point[][] = [], nears: Point[][] = [], tops: Point[][] = [], footprints: Point[][] = [];
    for (const r of rects) {
      const out = Math.min(1.5, Math.min(r.x1 - r.x0, r.y1 - r.y0) * 0.09);
      const x0 = r.x0 - out, x1 = r.x1 + out, y0 = r.y0 - out, y1 = r.y1 + out;
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      const top = corners.map(([x, y]) => this.worldToScreenPerspective({ x, y }, t));
      const grade = corners.map(([x, y]) => this.worldToScreenPerspective({ x, y }, 0));
      if (top.some(p => p.scale <= 0) || grade.some(p => p.scale <= 0)) continue;
      // The side faces the camera can see: a face is toward the viewer when
      // its near end projects farther out than its far end
      if (grade[1].pos.x < grade[2].pos.x) sides.push([grade[1].pos, grade[2].pos, top[2].pos, top[1].pos]);
      if (grade[0].pos.x > grade[3].pos.x) sides.push([grade[0].pos, grade[3].pos, top[3].pos, top[0].pos]);
      nears.push([grade[0].pos, grade[1].pos, top[1].pos, top[0].pos]);
      tops.push(top.map(p => p.pos));
      // A hairline on the footprint itself, so the slab reads as a border
      // around the thing rather than as a bigger thing (as on the grid)
      footprints.push([P(r.x0, r.y0, t), P(r.x1, r.y0, t), P(r.x1, r.y1, t), P(r.x0, r.y1, t)]);
    }
    const path = (quads: Point[][]) => {
      ctx.beginPath();
      for (const q of quads) {
        ctx.moveTo(q[0].x, q[0].y);
        for (let i = 1; i < q.length; i++) ctx.lineTo(q[i].x, q[i].y);
        ctx.closePath();
      }
    };
    ctx.save();
    path(sides); ctx.fillStyle = '#8f918c'; ctx.fill();
    path(nears); ctx.fillStyle = '#7e807b'; ctx.fill();
    path(tops); ctx.fillStyle = '#a9aba6'; ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)'; ctx.stroke();
    path(footprints); ctx.strokeStyle = 'rgba(0, 0, 0, 0.16)'; ctx.stroke();
    ctx.restore();
  }

  /**
   * A thin steel scaffold carrying a raised component up from whatever is
   * under it: a column at each footprint corner, a ring of beams at every
   * bay, X-bracing in every panel and an open deck at the top. `back` draws
   * the deck, the far face and the far halves of the sides (before the
   * component); `front` the near face and near halves (after it).
   */
  private renderScaffold(ctx: CanvasRenderingContext2D, f: Foundation, part: 'back' | 'front'): void {
    const r = f.rect;
    const cy = (r.y0 + r.y1) / 2;
    const bays = Math.max(1, Math.round((f.top - f.base) / SCAFFOLD_BAY_M));
    const P = (p: Point, z: number) => this.worldToScreenPerspective(p, z);
    const mid = P({ x: (r.x0 + r.x1) / 2, y: cy }, f.base);
    if (mid.scale <= 0) return;
    const pxPerM = mid.scale * 50;
    const faces: Array<[Point, Point]> = part === 'back'
      ? [
        [{ x: r.x0, y: r.y1 }, { x: r.x1, y: r.y1 }],
        [{ x: r.x0, y: cy }, { x: r.x0, y: r.y1 }],
        [{ x: r.x1, y: cy }, { x: r.x1, y: r.y1 }],
      ]
      : [
        [{ x: r.x0, y: r.y0 }, { x: r.x0, y: cy }],
        [{ x: r.x1, y: r.y0 }, { x: r.x1, y: cy }],
        [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }],
      ];

    ctx.save();
    ctx.lineCap = 'round';
    if (part === 'back') {
      const deck = [P({ x: r.x0, y: r.y0 }, f.top), P({ x: r.x1, y: r.y0 }, f.top), P({ x: r.x1, y: r.y1 }, f.top), P({ x: r.x0, y: r.y1 }, f.top)];
      if (deck.every(p => p.scale > 0)) {
        ctx.beginPath();
        ctx.moveTo(deck[0].pos.x, deck[0].pos.y);
        for (let i = 1; i < 4; i++) ctx.lineTo(deck[i].pos.x, deck[i].pos.y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(70, 76, 82, 0.35)';
        ctx.fill();
      }
    }
    const braceW = Math.max(0.6, 0.05 * pxPerM);
    const columnW = Math.max(1, 0.15 * pxPerM);
    // Every face's members of one kind go in one path: three strokes a part
    const faceLevels: Array<Array<{ a: Point; b: Point }>> = [];
    for (const [a, b] of faces) {
      const levels: Array<{ a: Point; b: Point }> = [];
      for (let k = 0; k <= bays; k++) {
        const z = f.base + (f.top - f.base) * k / bays;
        const pa = P(a, z), pb = P(b, z);
        if (pa.scale <= 0 || pb.scale <= 0) { levels.length = 0; break; }
        levels.push({ a: pa.pos, b: pb.pos });
      }
      if (levels.length > 0) faceLevels.push(levels);
    }
    ctx.strokeStyle = '#8b9199';
    ctx.lineWidth = braceW;
    ctx.beginPath();
    for (const levels of faceLevels) {
      for (let k = 0; k < bays; k++) {
        ctx.moveTo(levels[k].a.x, levels[k].a.y); ctx.lineTo(levels[k + 1].b.x, levels[k + 1].b.y);
        ctx.moveTo(levels[k].b.x, levels[k].b.y); ctx.lineTo(levels[k + 1].a.x, levels[k + 1].a.y);
      }
    }
    ctx.stroke();
    ctx.strokeStyle = '#5d636a';
    ctx.lineWidth = braceW * 1.5;
    ctx.beginPath();
    for (const levels of faceLevels) {
      for (const l of levels) { ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); }
    }
    ctx.stroke();
    ctx.strokeStyle = '#4b5158';
    ctx.lineWidth = columnW;
    ctx.beginPath();
    for (const levels of faceLevels) {
      ctx.moveTo(levels[0].a.x, levels[0].a.y); ctx.lineTo(levels[bays].a.x, levels[bays].a.y);
      ctx.moveTo(levels[0].b.x, levels[0].b.y); ctx.lineTo(levels[bays].b.x, levels[bays].b.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Get fluid color for connection rendering - uses same coloring as fluid nodes
  private getFluidColorForConnection(fluid: any): string {
    if (!fluid) return '#667788';

    // Use the standard fluid color function for consistency with node rendering
    // This ensures connections match the color of their source fluid
    return getFluidColor(fluid);
  }

  /**
   * The fluid a connection is actually carrying, for line coloring.
   *
   * The obvious source - the "from" component's own `fluid` - is wrong for
   * every component that holds more than one fluid or none at all: a heat
   * exchanger keeps primaryFluid/secondaryFluid, a pump and a turbine keep
   * inlet/outlet fluids, and several components carry no display fluid at
   * all, which left their lines painted the "unknown fluid" slate gray even
   * when they were full of steam. Read the donor flow node of the matching
   * simulation connection instead, which is per-port and always populated.
   *
   * Falls back to the component fluid before the simulation exists (i.e. in
   * construction mode).
   */
  private getConnectionFluid(
    connection: Connection,
    fromComponent: PlantComponent
  ): Fluid | undefined {
    const componentFluid = (fromComponent as any).fluid as Fluid | undefined;
    if (!this.simState) return componentFluid;

    const flowId = flowConnectionIdForPlantConnection(connection, this.plantState);
    if (!flowId) return componentFluid;
    const flow = this.simState.flowConnections.find(f => f.id === flowId);
    if (!flow) return componentFluid;

    // Donor node: the end whose fluid the line is actually FULL of, which is
    // not the instantaneous flow direction on a line that only sloshes (see
    // display-flow.ts). Stagnant lines show the upstream node, matching the
    // drawn direction.
    const forward = this.pipeContents.donorEnd(flow) === 'from';
    const donorId = forward ? flow.fromNodeId : flow.toNodeId;
    const donor = this.simState.flowNodes.get(donorId);
    if (!donor) return componentFluid;

    // getFluidColor needs the node volume to recover NCG partial pressure
    const fluid: Fluid = {
      ...donor.fluid,
      volume: donor.volume,
      flowRate: flow.massFlowRate,
    };

    // A separated two-phase node feeds liquid from a bottom nozzle and vapor
    // from a top one. Paint the line that phase rather than the node's bulk
    // mixture color. `flow.currentFlowPhase` is the answer for the node the
    // INSTANTANEOUS sign picked, so it is the wrong end whenever the ledger
    // above disagrees; ask the same draw sampler the physics uses about the
    // donor we actually chose, at the port on that end.
    if (fluid.phase === 'two-phase') {
      const phase = flowPhaseAt(
        donor,
        forward ? flow.fromElevation : flow.toElevation,
        flow.massFlowRate
      );
      if (phase === 'liquid') {
        fluid.phase = 'liquid';
        fluid.quality = 0;
      } else if (phase === 'vapor') {
        fluid.phase = 'vapor';
        fluid.quality = 1;
      }
    }
    return fluid;
  }

  /**
   * Draw a stacked up/down arrow pair beside every movable component, and
   * record where they landed so clicks can find them.
   *
   * Elevation is otherwise only reachable through the component's edit
   * dialog, which is a poor fit for the thing you most often want to do while
   * arranging a plant: raise this by half a metre and look at it. Arrows are
   * sized in SCREEN pixels rather than world metres so they stay usable on a
   * small valve and at any zoom.
   *
   * Buildings and switchyards are skipped: both are drawn from the ground
   * plane up regardless of their elevation field, so an arrow would do
   * nothing visible.
   */
  private renderElevationArrows(ctx: CanvasRenderingContext2D, components: PlantComponent[]): void {
    this.elevationArrowTargets = [];
    if (!this.showElevationArrows) return;

    const R = 7;         // arrow button radius, px
    const GAP = 4;       // px between the component edge and the buttons
    const { verticalScale } = this.getViewTransform();
    // Read the canvas box ONCE - a getBoundingClientRect per component per
    // frame forces a layout on every one of them
    const rect = this.canvas.getBoundingClientRect();

    // The box the pointer must stay inside to keep a cluster latched. Slack
    // beyond the buttons themselves so a small wobble does not release it.
    const SLACK = 6;
    const pointerInCluster = (ax: number, ay: number): boolean =>
      Math.abs(this.lastMouseScreen.x - ax) <= R + SLACK &&
      Math.abs(this.lastMouseScreen.y - ay) <= 2 * R + 1 + SLACK;

    // Release a latch the pointer has wandered away from
    if (this.elevationArrowLatch &&
        !pointerInCluster(this.elevationArrowLatch.x, this.elevationArrowLatch.y)) {
      this.elevationArrowLatch = null;
    }

    for (const component of components) {
      if (component.type === 'building' || component.type === 'switchyard') continue;

      // Anchor: the right edge of the component at its visual mid-height -
      // the same projection hit testing uses, so arrows track the drawing
      let anchorX: number;
      let anchorY: number;
      if (this.viewMode === 'grid') {
        const box = this.grid.spriteScreenBox(component);
        if (!box) continue;
        anchorX = box.right;
        anchorY = (box.top + box.bottom) / 2;
      } else if (component.type === 'pipe') {
        const pipe = component as import('../types').PipeComponent;
        if (!pipe.endPosition) continue;
        const a = this.worldToScreenPerspective(pipe.position, pipe.elevation ?? 0);
        const b = this.worldToScreenPerspective(pipe.endPosition, pipe.endElevation ?? pipe.elevation ?? 0);
        if (a.scale <= 0 || b.scale <= 0) continue;
        anchorX = Math.max(a.pos.x, b.pos.x);
        anchorY = (a.pos.y + b.pos.y) / 2;
      } else {
        const elevation = getComponentElevation(component);
        const centerScreen = this.worldToScreenPerspective(component.position, elevation);
        if (centerScreen.scale <= 0) continue;
        const size = this.getComponentSize(component);
        const centerZoom = centerScreen.scale * 50;
        const halfW = Math.max((size.width / 2) * centerZoom, PlantCanvas.MIN_CLICK_TARGET_PX / 2);
        const halfH = (size.height / 2) * centerZoom * verticalScale;
        anchorX = centerScreen.pos.x + halfW;
        anchorY = centerScreen.pos.y - halfH;
      }

      // Off-screen components would pile their arrows on the border
      if (anchorX < -50 || anchorX > rect.width + 50 || anchorY < -50 || anchorY > rect.height + 50) {
        continue;
      }

      let x = anchorX + GAP + R;
      if (this.elevationArrowLatch?.componentId === component.id) {
        // Held still under the pointer (see elevationArrowLatch)
        x = this.elevationArrowLatch.x;
        anchorY = this.elevationArrowLatch.y;
      } else if (!this.elevationArrowLatch && pointerInCluster(anchorX + GAP + R, anchorY)) {
        this.elevationArrowLatch = { componentId: component.id, x, y: anchorY };
      }

      for (const [delta, cy] of [
        [PlantCanvas.ELEVATION_STEP_M, anchorY - R - 1],
        [-PlantCanvas.ELEVATION_STEP_M, anchorY + R + 1],
      ] as const) {
        this.elevationArrowTargets.push({
          componentId: component.id, delta, x, y: cy, radius: R,
        });

        ctx.save();
        ctx.beginPath();
        ctx.arc(x, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(28, 32, 38, 0.82)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(220, 228, 240, 0.85)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Triangle, pointing the way the click moves the component. Slightly
        // fatter relative to the button than a larger glyph would need, so it
        // still reads as an arrow at this size.
        const t = R * 0.55;
        const dir = delta > 0 ? -1 : 1;   // screen Y is inverted
        ctx.beginPath();
        ctx.moveTo(x, cy + dir * t);
        ctx.lineTo(x - t, cy - dir * t * 0.8);
        ctx.lineTo(x + t, cy - dir * t * 0.8);
        ctx.closePath();
        ctx.fillStyle = '#e8eef8';
        ctx.fill();
        ctx.restore();
      }
    }
  }

  /**
   * Shade the part of a component that sits below grade with translucent
   * soil, so a basement condenser or a buried sump reads as buried instead
   * of as floating in front of everything at ground level.
   *
   * The soil quad runs from the projected grade line down to the projected
   * bottom of the component, across its own screen width only - the shading
   * must not spill onto neighbours, whose grade line sits elsewhere on
   * screen (screen Y alone does not determine depth in this projection).
   */
  private renderBelowGradeOverlay(ctx: CanvasRenderingContext2D, component: PlantComponent): void {
    // Buildings and switchyards are drawn from the ground plane up regardless
    // of their elevation field, so there is nothing of them below grade
    if (component.type === 'building' || component.type === 'switchyard') return;

    // Corners of the soil quad, left edge first. Each is a screen X plus the
    // screen Y of grade and of the component's underside at that point.
    let corners: Array<{ x: number; groundY: number; bottomY: number }>;

    if (component.type === 'pipe') {
      // Pipes are drawn between their two projected endpoints, so each end
      // gets its own grade line - a pipe sloping into a basement is cut where
      // it actually crosses grade.
      const pipe = component as import('../types').PipeComponent;
      if (!pipe.endPosition) return;
      const halfD = pipe.diameter / 2;
      const ends: Array<{ world: Point; elev: number }> = [
        { world: pipe.position, elev: (pipe.elevation ?? 0) - halfD },
        { world: pipe.endPosition, elev: (pipe.endElevation ?? pipe.elevation ?? 0) - halfD },
      ];
      if (ends.every(e => e.elev >= 0)) return;

      const projected = ends.map(e => ({
        ground: this.worldToScreenPerspective(e.world, 0),
        bottom: this.worldToScreenPerspective(e.world, Math.min(0, e.elev)),
      }));
      if (projected.some(p => p.ground.scale <= 0 || p.bottom.scale <= 0)) return;

      // Widen by the pipe radius so the drawn barrel is fully buried
      const pad = halfD * projected[0].ground.scale * this.PERSPECTIVE_X_SCALE;
      const dir = Math.sign(projected[1].ground.pos.x - projected[0].ground.pos.x) || 1;
      corners = projected.map((p, i) => ({
        x: p.ground.pos.x + (i === 0 ? -dir : dir) * pad,
        groundY: p.ground.pos.y,
        bottomY: p.bottom.pos.y,
      }));
    } else {
      // Everything else is drawn centred on the projection of its own
      // position, bottom sitting at its elevation - so grade and the
      // underside must come from that same projection, not from the corners,
      // or the soil line lands somewhere the component was never drawn.
      const elevation = getComponentElevation(component);
      if (elevation >= 0) return;

      const ground = this.worldToScreenPerspective(component.position, 0);
      const bottom = this.worldToScreenPerspective(component.position, elevation);
      if (ground.scale <= 0 || bottom.scale <= 0) return;

      const size = this.getComponentSize(component);
      const centerZoom = bottom.scale * 50; // matches the render loop
      const halfWidthPx = (size.width / 2) * centerZoom + 4;
      corners = [
        { x: bottom.pos.x - halfWidthPx, groundY: ground.pos.y, bottomY: bottom.pos.y },
        { x: bottom.pos.x + halfWidthPx, groundY: ground.pos.y, bottomY: bottom.pos.y },
      ];
    }

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].groundY);
    ctx.lineTo(corners[1].x, corners[1].groundY);
    ctx.lineTo(corners[1].x, corners[1].bottomY);
    ctx.lineTo(corners[0].x, corners[0].bottomY);
    ctx.closePath();
    // Desert soil, matching the near end of the ground gradient but darker
    ctx.fillStyle = 'rgba(150, 130, 92, 0.72)';
    ctx.fill();

    // Grade line, where the soil cuts the component
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].groundY);
    ctx.lineTo(corners[1].x, corners[1].groundY);
    ctx.strokeStyle = 'rgba(110, 92, 60, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The port to draw a connection endpoint at. Side ports on wide vessels
   * are logical attachment points, not fixed nozzles: a vessel whose inlet
   * port is stored on the left still takes a line arriving from the right
   * on its right wall - drawing it to the far port makes the line cross
   * the whole vessel silhouette. Mirror the port's lateral offset when the
   * partner sits on the other side of the vessel.
   *
   * Only vessels/tanks mirror: pump nozzles and valve ports are physical
   * drawn features, heat-exchanger port sides distinguish tube from shell
   * plenums, and pipes carry exact endpoints.
   */
  private portForConnectionDrawing(
    component: PlantComponent,
    port: { position: Point },
    partner: PlantComponent,
    partnerPort: { position: Point }
  ): { position: Point } {
    if (component.type !== 'vessel' && component.type !== 'reactorVessel' && component.type !== 'tank') {
      return port;
    }
    if (port.position.x === 0) return port;

    const elevation = getComponentElevation(component);
    const centerScreen = this.worldToScreenPerspective(
      { x: component.position.x, y: component.position.y }, elevation);
    if (centerScreen.scale <= 0) return port;

    // Where the line comes from: the pipe's actual end for pipes, the
    // partner's center otherwise (a partner's own mirroring never looks
    // back at this port, so there is no circularity)
    let partnerX: number;
    if (partner.type === 'pipe') {
      const ps = this.getPortScreenPosition(partner, partnerPort);
      if (!ps) return port;
      partnerX = ps.x;
    } else {
      const pScreen = this.worldToScreenPerspective(
        { x: partner.position.x, y: partner.position.y }, getComponentElevation(partner));
      if (pScreen.scale <= 0) return port;
      partnerX = pScreen.pos.x;
    }

    // Screen-space lateral offsets of the stored and mirrored port under
    // the component's (screen-space) rotation
    const cos = Math.cos(component.rotation);
    const sin = Math.sin(component.rotation);
    const drawnDx = port.position.x * cos - port.position.y * sin;
    const mirroredDx = -port.position.x * cos - port.position.y * sin;
    const partnerDx = partnerX - centerScreen.pos.x;

    // Mirror only when the stored port faces away from the partner AND the
    // mirrored port actually faces toward it (a rotated component can have
    // both pointing the same way - leave those alone)
    if (partnerDx === 0 ||
        Math.sign(drawnDx) === Math.sign(partnerDx) ||
        Math.sign(mirroredDx) !== Math.sign(partnerDx)) {
      return port;
    }
    return { position: { x: -port.position.x, y: port.position.y } };
  }

  /**
   * Pull connection endpoints inward for connections that cross a
   * containment boundary, so internal plumbing reads as a short stub
   * instead of a full line through the container's wall:
   * - component connected to its own container: the container-side endpoint
   *   stops just past the inner component's edge
   * - siblings nested inside the same VESSEL (core barrel internals, etc.):
   *   both endpoints move toward the midpoint
   *
   * Siblings that merely share a BUILDING are exempt: a building is a room,
   * not a vessel - real piping runs between the components, so the line
   * must reach the ports. (The pull used to apply there too, which left
   * connection lines ending in midair near small components like valves.)
   */
  private adjustEndpointsForContainment(
    fromComponent: PlantComponent,
    toComponent: PlantComponent,
    fromScreen: Point,
    toScreen: Point
  ): { from: Point; to: Point } {
    const fromContainedBy = (fromComponent as any).containedBy;
    const toContainedBy = (toComponent as any).containedBy;

    if (fromContainedBy === toComponent.id) {
      const t = 0.1;
      return {
        from: fromScreen,
        to: {
          x: fromScreen.x + t * (toScreen.x - fromScreen.x),
          y: fromScreen.y + t * (toScreen.y - fromScreen.y)
        }
      };
    }
    if (toContainedBy === fromComponent.id) {
      const t = 0.1;
      return {
        from: {
          x: toScreen.x + t * (fromScreen.x - toScreen.x),
          y: toScreen.y + t * (fromScreen.y - toScreen.y)
        },
        to: toScreen
      };
    }
    if (fromContainedBy && fromContainedBy === toContainedBy) {
      const container = this.plantState.components.get(fromContainedBy);
      if (container && container.type !== 'building') {
        const t = 0.4;
        const midX = (fromScreen.x + toScreen.x) / 2;
        const midY = (fromScreen.y + toScreen.y) / 2;
        return {
          from: {
            x: fromScreen.x + t * (midX - fromScreen.x),
            y: fromScreen.y + t * (midY - fromScreen.y)
          },
          to: {
            x: toScreen.x + t * (midX - toScreen.x),
            y: toScreen.y + t * (midY - toScreen.y)
          }
        };
      }
    }
    return { from: fromScreen, to: toScreen };
  }

  // Calculate connection screen endpoints accounting for elevation offsets
  // This matches the logic in renderConnectionPerspective for consistency
  private getConnectionScreenEndpoints(
    fromComponent: PlantComponent,
    toComponent: PlantComponent,
    connection: Connection
  ): ConnectionScreenEndpoints | null {
    // Find ports
    const storedFromPort = fromComponent.ports?.find(p => p.id === connection.fromPortId);
    const storedToPort = toComponent.ports?.find(p => p.id === connection.toPortId);
    if (!storedFromPort || !storedToPort) return null;

    // A routed run: the arrow sits half way along the pipe as drawn,
    // pointing along the leg it lands on
    const run = this.connectionRunScreen(connection, fromComponent, storedFromPort, toComponent, storedToPort);
    if (run) {
      const mid = screenMidpoint(run.pts);
      const half = 4;
      return {
        fromPos: { x: mid.point.x - mid.dir.x * half, y: mid.point.y - mid.dir.y * half },
        toPos: { x: mid.point.x + mid.dir.x * half, y: mid.point.y + mid.dir.y * half },
        scale: run.scale,
      };
    }

    // Vessel side ports draw on the edge facing the partner, matching
    // renderConnectionPerspective
    const fromPort = this.portForConnectionDrawing(fromComponent, storedFromPort, toComponent, storedToPort);
    const toPort = this.portForConnectionDrawing(toComponent, storedToPort, fromComponent, storedFromPort);

    // Get port screen positions
    const fromPortScreen = this.getPortScreenPosition(fromComponent, fromPort);
    const toPortScreen = this.getPortScreenPosition(toComponent, toPort);
    if (!fromPortScreen || !toPortScreen) return null;

    // Get component base elevations
    const fromCompElevation = getComponentElevation(fromComponent);
    const toCompElevation = getComponentElevation(toComponent);

    // Connection elevation is relative to component bottom
    const fromConnElevation = connection.fromElevation ?? 0;
    const toConnElevation = connection.toElevation ?? 0;

    // Calculate the port's visual elevation relative to component bottom
    const fromSize = this.getComponentSize(fromComponent);
    const toSize = this.getComponentSize(toComponent);
    const fromPortVisualElev = fromSize.height / 2 - fromPort.position.y;
    const toPortVisualElev = toSize.height / 2 - toPort.position.y;

    // Calculate the DIFFERENCE between where the connection should be and where the port appears
    const fromElevDiff = fromConnElevation - fromPortVisualElev;
    const toElevDiff = toConnElevation - toPortVisualElev;

    // Get the vertical transform for elevation changes
    const { verticalScale } = this.getViewTransform();

    // For non-pipe components, we need to use the center-based scale that getPortScreenPosition uses
    // For pipes, we use the port world position scale
    let fromScale: number;
    let toScale: number;

    if (fromComponent.type === 'pipe') {
      const fromPortWorld = this.getPortWorldPosition(fromComponent, fromPort);
      const fromProj = this.worldToScreenPerspective(fromPortWorld, fromCompElevation);
      if (fromProj.scale <= 0) return null;
      fromScale = fromProj.scale;
    } else {
      const fromCenterProj = this.worldToScreenPerspective(
        { x: fromComponent.position.x, y: fromComponent.position.y },
        fromCompElevation
      );
      if (fromCenterProj.scale <= 0) return null;
      fromScale = fromCenterProj.scale * 50;
    }

    if (toComponent.type === 'pipe') {
      const toPortWorld = this.getPortWorldPosition(toComponent, toPort);
      const toProj = this.worldToScreenPerspective(toPortWorld, toCompElevation);
      if (toProj.scale <= 0) return null;
      toScale = toProj.scale;
    } else {
      const toCenterProj = this.worldToScreenPerspective(
        { x: toComponent.position.x, y: toComponent.position.y },
        toCompElevation
      );
      if (toCenterProj.scale <= 0) return null;
      toScale = toCenterProj.scale * 50;
    }

    // Calculate elevation offset in screen pixels
    const fromElevationOffset = fromElevDiff * fromScale * this.ELEVATION_SCALE / 50 * verticalScale;
    const toElevationOffset = toElevDiff * toScale * this.ELEVATION_SCALE / 50 * verticalScale;

    // Apply elevation offset to port screen positions (negative because Y increases downward)
    let fromScreen = { x: fromPortScreen.x, y: fromPortScreen.y - fromElevationOffset };
    let toScreen = { x: toPortScreen.x, y: toPortScreen.y - toElevationOffset };

    // Handle internal connections (one component contained by the other, or siblings)
    const adjusted = this.adjustEndpointsForContainment(fromComponent, toComponent, fromScreen, toScreen);
    fromScreen = adjusted.from;
    toScreen = adjusted.to;

    // Average scale for arrow sizing
    // The flow arrow code expects scale ~1.0 at normal viewing distance
    // For pipes, fromScale/toScale are raw projection scales (~1.0)
    // For non-pipes, they're projection scale * 50, so we need to normalize
    const fromNormalized = fromComponent.type === 'pipe' ? fromScale : fromScale / 50;
    const toNormalized = toComponent.type === 'pipe' ? toScale : toScale / 50;
    const avgScale = (fromNormalized + toNormalized) / 2;

    // An opening between a component and its own container whose two
    // nozzles land on one point: the arrow sits there, pointing out of the
    // inner component (see openingArrowEndpoints)
    if (Math.hypot(toScreen.x - fromScreen.x, toScreen.y - fromScreen.y) < 1 &&
        (fromComponent.containedBy === toComponent.id || toComponent.containedBy === fromComponent.id)) {
      const inner = fromComponent.containedBy === toComponent.id ? fromComponent : toComponent;
      const b = this.getComponentScreenBounds(inner);
      if (b && b.height !== undefined) {
        return openingArrowEndpoints(fromScreen, { x: b.topCenter.x, y: b.topCenter.y + b.height / 2 },
          inner === fromComponent, 12 * avgScale, avgScale);
      }
    }

    return {
      fromPos: fromScreen,
      toPos: toScreen,
      scale: avgScale
    };
  }

  // Render ground-level outline for a component in construction mode
  private renderGroundOutline(ctx: CanvasRenderingContext2D, component: PlantComponent): void {
    const size = this.getComponentSize(component);
    const halfW = size.width / 2;
    const halfH = size.height / 2;

    // Get component corners at ground level (elevation = 0)
    let corners: Point[];

    if (component.type === 'pipe') {
      // For pipes, use length along rotation
      const pipe = component as any;
      const len = pipe.length || 10;
      const cos = Math.cos(component.rotation);
      const sin = Math.sin(component.rotation);

      corners = [
        { x: component.position.x - halfH * sin, y: component.position.y + halfH * cos },
        { x: component.position.x + halfH * sin, y: component.position.y - halfH * cos },
        { x: component.position.x + len * cos + halfH * sin, y: component.position.y + len * sin - halfH * cos },
        { x: component.position.x + len * cos - halfH * sin, y: component.position.y + len * sin + halfH * cos },
      ];
    } else {
      // Standard rectangular footprint
      corners = [
        { x: component.position.x - halfW, y: component.position.y - halfH },
        { x: component.position.x + halfW, y: component.position.y - halfH },
        { x: component.position.x + halfW, y: component.position.y + halfH },
        { x: component.position.x - halfW, y: component.position.y + halfH },
      ];
    }

    // Project corners to screen at ground level
    const screenCorners = corners.map(c => this.worldToScreenPerspective(c, 0));

    // Skip if any corner is behind camera
    if (screenCorners.some(c => c.scale <= 0)) return;

    // Draw outline
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);

    ctx.beginPath();
    ctx.moveTo(screenCorners[0].pos.x, screenCorners[0].pos.y);
    for (let i = 1; i < screenCorners.length; i++) {
      ctx.lineTo(screenCorners[i].pos.x, screenCorners[i].pos.y);
    }
    ctx.closePath();
    ctx.stroke();

    ctx.setLineDash([]);
  }

  // Render placement preview footprint at cursor position
  private renderPlacementPreview(ctx: CanvasRenderingContext2D): void {
    if (!this.placementPreview) return;

    const { componentType, position } = this.placementPreview;
    const size = this.getDefaultComponentSize(componentType);
    const halfW = size.width / 2;
    const halfH = size.height / 2;

    // Get corners at ground level (elevation = 0)
    const corners: Point[] = [
      { x: position.x - halfW, y: position.y - halfH },
      { x: position.x + halfW, y: position.y - halfH },
      { x: position.x + halfW, y: position.y + halfH },
      { x: position.x - halfW, y: position.y + halfH },
    ];

    // Project corners to screen at ground level
    const screenCorners = corners.map(c => this.worldToScreenPerspective(c, 0));

    // Skip if any corner is behind camera
    if (screenCorners.some(c => c.scale <= 0)) return;

    // Draw preview outline - more visible than existing outlines
    ctx.strokeStyle = 'rgba(255, 60, 60, 0.9)';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 4]);

    ctx.beginPath();
    ctx.moveTo(screenCorners[0].pos.x, screenCorners[0].pos.y);
    for (let i = 1; i < screenCorners.length; i++) {
      ctx.lineTo(screenCorners[i].pos.x, screenCorners[i].pos.y);
    }
    ctx.closePath();
    ctx.stroke();

    // Add a semi-transparent fill
    ctx.fillStyle = 'rgba(255, 80, 80, 0.15)';
    ctx.fill();

    ctx.setLineDash([]);
  }

  // Public API
  public setPlantState(state: PlantState): void {
    this.plantState = state;
  }

  /** Show or hide the power wiring (only drawn when the plant uses the electrical model). */
  public setShowWires(show: boolean): void {
    this.showWires = show;
  }

  public setShowPorts(show: boolean): void {
    this.showPorts = show;
    if (!show) {
      this.highlightedPort = null;  // Clear highlight when hiding ports
      this.grid.cancelRouting();
    }
  }

  public setHighlightedPort(componentId: string | null, portId: string | null): void {
    if (componentId && portId) {
      this.highlightedPort = { componentId, portId };
    } else {
      this.highlightedPort = null;
    }
  }

  public setSimState(state: SimulationState): void {
    this.simState = state;
    this._simStateWarningLogged = false; // Reset warning flag when state is set
    this.pipeContents.update(state);
  }

  public getView(): ViewState {
    return { ...this.view };
  }

  public setViewMode(mode: ViewMode): void {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.cancelRouting();

    // Adjust view when switching modes to keep components visible
    const rect = this.canvas.getBoundingClientRect();
    if (mode === 'perspective') {
      // Switching to 2.5D: reset camera depth
      this.cameraDepth = 0;
    } else {
      this.grid.setViewportSize(rect.width, rect.height);
      this.grid.centerOn(this.plantState);
    }
    this.syncIsoZoomUI();
  }

  public getViewMode(): ViewMode {
    return this.viewMode;
  }

  public setViewElevation(sliderValue: number): void {
    // sliderValue: 10-50, maps directly to view angle in degrees
    // 10 = looking more forward (less compression)
    // 50 = looking more from above (more compression)
    this.viewAngle = Math.max(10, Math.min(50, sliderValue));
  }

  public getViewElevation(): number {
    return this.viewAngle;
  }

  // Set the isometric zoom directly (e.g. from the sidebar slider)
  public setIsoZoom(zoom: number): void {
    this.applyIsoZoom(zoom);
  }

  public getIsoZoom(): number {
    return this.isoZoom;
  }

  public setConstructionMode(enabled: boolean): void {
    this.constructionMode = enabled;
  }

  /**
   * Allow (or forbid) placement previews, port routing and the layout grid.
   * True in construction mode and, since live editing, in simulation mode as
   * well - the two flags are separate because constructionMode also selects
   * how components are drawn.
   */
  public setBuildMode(enabled: boolean): void {
    this.buildMode = enabled;
  }

  /**
   * Whether to draw the design overlays (coordinate grid, ground outlines):
   * always while designing, and while the plant is RUNNING only when the
   * player is actually placing something. They are drawing aids, not part of
   * the operating view.
   */
  private showsBuildOverlays(): boolean {
    return this.constructionMode || (this.buildMode && this.placementPreview !== null);
  }

  /**
   * Show the per-component elevation nudge arrows (move mode only). They are
   * drawn as a final overlay and hit-tested through
   * getElevationArrowAtScreen.
   */
  public setElevationArrowsVisible(visible: boolean): void {
    this.showElevationArrows = visible;
    if (!visible) {
      this.elevationArrowTargets = [];
      this.elevationArrowLatch = null;
    }
  }

  /**
   * The elevation arrow under a screen point, if any. Reads the targets the
   * last frame laid down, so the clickable spot is exactly the drawn one;
   * later entries are on top, so scan backwards.
   */
  public getElevationArrowAtScreen(screenPos: Point): { componentId: string; delta: number } | null {
    for (let i = this.elevationArrowTargets.length - 1; i >= 0; i--) {
      const t = this.elevationArrowTargets[i];
      if (Math.hypot(screenPos.x - t.x, screenPos.y - t.y) <= t.radius) {
        return { componentId: t.componentId, delta: t.delta };
      }
    }
    return null;
  }

  public setView(view: Partial<ViewState>): void {
    Object.assign(this.view, view);
  }

  /** The magnification the +/- buttons and slider act on in the current view. */
  private currentZoomFactor(): number {
    return this.viewMode === 'grid' ? this.grid.zoomFactor : this.isoZoom;
  }

  /**
   * Jolt the camera for `seconds` of real time (a scenario earthquake). Both
   * views honour it; nothing in the plant moves.
   */
  public startShake(seconds: number, amplitude?: number): void {
    this.shake.start(seconds, amplitude);
  }

  /** Grid view: bring the plant to the middle of the screen (after loading one, for instance). */
  public centerOnPlant(): void {
    if (this.viewMode === 'grid') this.grid.centerOn(this.plantState);
  }

  /**
   * Tell the grid view which edges of the canvas are covered by floating UI
   * (px), so fit-to-plant aims at the part the player can actually see. The
   * canvas fills the window and the toolbar/HUD/legend sit on top of it.
   */
  public setViewportInsets(insets: { left?: number; top?: number; right?: number; bottom?: number }): void {
    this.grid.insets = {
      left: insets.left ?? 0, top: insets.top ?? 0,
      right: insets.right ?? 0, bottom: insets.bottom ?? 0,
    };
  }

  public zoomIn(): void {
    this.applyIsoZoom(this.currentZoomFactor() * 1.2);
  }

  public zoomOut(): void {
    this.applyIsoZoom(this.currentZoomFactor() / 1.2);
  }

  public resetView(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.view = {
      offsetX: rect.width / 2 - 150,
      offsetY: rect.height / 2 + 100,
      zoom: 50,
    };
    this.cameraDepth = 0;
    this.isoZoom = 1;
    if (this.viewMode === 'grid') {
      this.grid.cam.ppm = GridView.DEFAULT_PPM;
      this.grid.centerOn(this.plantState);
    }
    this.syncIsoZoomUI();
  }

  public getSelectedComponentId(): string | null {
    return this.selectedComponentId;
  }

  public clearSelection(): void {
    this.selectedComponentId = null;
    this.selectConnection(null);
    this.onComponentSelect?.(null);
  }

  public selectComponent(id: string): void {
    this.selectedComponentId = id;
    this.selectConnection(null);
    this.onComponentSelect?.(id);
  }

  public getSelectedConnection(): Connection | null {
    return this.selectedConnection;
  }

  /**
   * The flow path under a screen point, in either view: a flow arrow first
   * (drawn on top), then the drawn run - the grid's lattice routes, or the
   * 2.5D view's curves as last drawn.
   */
  public getConnectionAtScreen(screenPos: Point): Connection | null {
    const arrow = this.arrowAt(screenPos);
    if (arrow) return arrow;
    if (this.viewMode === 'grid') return this.grid.connectionAt(screenPos, this.plantState);
    return this.perspectiveRunAt(screenPos);
  }

  /** The 2.5D view's drawn connection run under a screen point (nearest wins). */
  private perspectiveRunAt(screenPos: Point): Connection | null {
    let best: Connection | null = null;
    let bestD = Infinity;
    for (const run of this.perspectiveRuns) {
      const d = distanceToPolylinePx(screenPos, run.pts);
      // Within the line's own half width, and never less than 6 px of room
      // for the pointer (a stub is 4 px wide)
      if (d <= Math.max(6, run.halfWidth ?? 0) && d < bestD) { bestD = d; best = run.conn; }
    }
    return best;
  }

  /** The flow arrow under a screen point, if any (nearest wins). */
  private arrowAt(screenPos: Point): Connection | null {
    let best: Connection | null = null;
    let bestD = Infinity;
    for (const a of this.flowArrowHits) {
      const d = Math.hypot(screenPos.x - a.x, screenPos.y - a.y);
      if (d <= a.size + 4 && d < bestD) { bestD = d; best = a.conn; }
    }
    return best;
  }

  /** A ring round the selected flow path's arrow, where it has one. */
  private drawSelectedArrowRing(ctx: CanvasRenderingContext2D): void {
    const conn = this.selectedConnection;
    if (!conn) return;
    const hit = this.flowArrowHits.find(a => a.conn === conn);
    if (!hit) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(80, 220, 255, 0.95)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(hit.x, hit.y, hit.size + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** The selected flow path's label in the 2.5D view (the grid draws its own). */
  private drawSelectedFlowPathLabel(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const conn = this.selectedConnection;
    if (!conn || !this.plantState.connections.includes(conn)) return;
    const run = this.perspectiveRuns.find(r => r.conn === conn);
    const hit = this.flowArrowHits.find(a => a.conn === conn);
    const anchor = hit ? { x: hit.x, y: hit.y }
      : run && run.pts.length > 0 ? run.pts[Math.floor(run.pts.length / 2)] : null;
    if (!anchor) return;
    const lines = connectionLabelLines(conn, this.plantState, this.simState,
      (c, from) => this.getConnectionFluid(c, from), this.buildMode);
    if (lines) drawConnectionLabel(ctx, anchor, lines, width, height);
  }

  private selectConnection(conn: Connection | null, again: boolean = false): void {
    const changed = conn !== this.selectedConnection;
    this.selectedConnection = conn;
    if (changed || again) this.onConnectionSelect?.(conn, again);
  }

  public setMoveMode(enabled: boolean): void {
    this.moveMode = enabled;
    if (!enabled) {
      this.isMovingComponent = false;
    }
  }

  public isMoveMode(): boolean {
    return this.moveMode;
  }
  // ---------------------------------------------------------------------
  // Grid view
  // ---------------------------------------------------------------------

  /** Snap a placement point so the new component's footprint lands on whole tiles (grid view only). */
  public snapPlacementPosition(componentType: string, pos: Point): Point {
    return this.viewMode === 'grid' ? this.grid.snapPlacement(componentType, pos) : pos;
  }

  /** Snap a moved component's position to the tile lattice (grid view only). */
  public snapComponentPosition(component: PlantComponent, pos: Point): Point {
    return this.viewMode === 'grid' ? this.grid.snapComponent(component, pos) : pos;
  }

  /**
   * Forget the drawn pipe routes touching a component that was moved. A
   * route drawn for the old position would drag its interior along to the
   * new one; the automatic route is the honest starting point again.
   */
  public rerouteConnectionsOf(componentId: string): void {
    for (const conn of this.plantState.connections) {
      if (conn.fromComponentId === componentId || conn.toComponentId === componentId) {
        delete conn.route;
      }
    }
  }

  public isRouting(): boolean {
    return this.grid.routing !== null;
  }

  /**
   * Arm or disarm the pipe tool. Armed, a press on a connection point starts
   * a port-to-port run and a press on open ground lays pipe there; disarmed,
   * presses fall through to selection and panning as before.
   */
  public setPipeTool(active: boolean, orientation?: PipeOrientation): void {
    this.pipeTool = active;
    if (orientation) this.pipeOrientation = orientation;
    if (!active && this.grid.routingFromGround) this.cancelRouting();
  }

  public isPipeTool(): boolean {
    return this.pipeTool;
  }

  public getPipeOrientation(): PipeOrientation {
    return this.pipeOrientation;
  }

  /** Turn the piece being placed a quarter turn (N/S <-> E/W). */
  public setPipeOrientation(orientation: PipeOrientation): void {
    this.pipeOrientation = orientation;
    if (this.grid.routing && this.grid.routingFromGround) {
      this.grid.routing.orientation = orientation;
    }
  }

  public rotatePipeOrientation(): PipeOrientation {
    this.setPipeOrientation(oppositeOrientation(this.pipeOrientation));
    return this.pipeOrientation;
  }

  /** Every port's on-screen position in the current view (test and assistant hook). */
  public listPortScreenPositions(): Array<{ componentId: string; portId: string; x: number; y: number }> {
    const out: Array<{ componentId: string; portId: string; x: number; y: number }> = [];
    for (const component of this.plantState.components.values()) {
      if (!component.ports || (component as any).isHydraulicOnly) continue;
      for (const port of component.ports) {
        let pos: { x: number; y: number } | null;
        if (this.viewMode === 'grid') {
          pos = this.grid.portScreenPosition(component, port.id);
        } else if (this.viewMode === 'perspective') {
          pos = this.getPortScreenPosition(component, port);
        } else {
          pos = worldToScreen(this.getPortWorldPosition(component, port), this.view);
        }
        if (pos) out.push({ componentId: component.id, portId: port.id, x: pos.x, y: pos.y });
      }
    }
    return out;
  }

  public cancelRouting(): void {
    if (this.grid.routing) {
      this.grid.cancelRouting();
      this.highlightedPort = null;
    }
  }

  /**
   * Pipe laying in grid view. Returns true when the press was consumed.
   *
   * A press on a port starts a pipe; sweeping from there lays it cell by
   * cell (releasing on another port finishes it). A press on open ground
   * while a pipe is waiting fixes the rubber band as laid pipe and sweeps
   * on from there; a press on a port finishes it. Presses that are not
   * about pipes fall through to the normal select/pan handling.
   */
  private handleGridPointerDown(e: PointerEvent, x: number, y: number): boolean {
    if (e.button === 2) {
      if (this.grid.routing) {
        this.cancelRouting();
        return true;
      }
      return false;
    }
    if (e.button !== 0 || (!this.showPorts && !this.pipeTool) || !this.buildMode) return false;

    if (this.grid.routing) {
      const from = this.grid.routing.from;
      // A ground run is a single press-sweep-release gesture: it has no
      // waiting state for a second press to add to.
      if (!from) return true;
      const hit = this.grid.portAt({ x, y }, this.plantState, from.component.id);
      if (hit) {
        this.completeRoute(hit);
      } else {
        this.grid.updateRoutingCursor({ x, y }, this.plantState);
        this.grid.fixWaypoint();
        this.grid.routing.dragging = true;
        this.grid.routing.pressScreen = { x, y };
      }
      return true;
    }

    const hit = this.grid.portAt({ x, y }, this.plantState);
    if (!hit) {
      // Nothing to connect to here. With the pipe tool armed, this is where
      // ground pipe goes; otherwise the press is not about pipes at all.
      if (!this.pipeTool) return false;
      this.grid.startGroundRouting(this.grid.screenToWorld({ x, y }), this.pipeOrientation);
      this.grid.routing!.dragging = true;
      this.grid.routing!.pressScreen = { x, y };
      return true;
    }
    this.grid.startRouting(hit, this.pipeOrientation);
    this.grid.routing!.dragging = true;
    this.grid.routing!.pressScreen = { x, y };
    this.highlightedPort = { componentId: hit.component.id, portId: hit.port.id };
    return true;
  }

  private completeRoute(target: PortHit): void {
    const from = this.grid.routing!.from;
    if (!from) return;   // a ground run finishes in handlePointerUp, not here
    const { route, length } = this.grid.finishRouting(target);
    this.highlightedPort = null;
    this.onRouteComplete?.(from, target, route, length);
  }

  /** One grid-view frame: GridView draws the ground and plant, then the shared overlays go on top. */
  private renderGridFrame(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.clearRect(0, 0, width, height);
    const shake = this.shake.offset(width, height);
    if (shake) CameraShake.apply(ctx, shake, width, height);
    this.grid.render(ctx, {
      width,
      height,
      plantState: this.plantState,
      simState: this.simState,
      selectedComponentId: this.selectedComponentId,
      selectedConnection: this.selectedConnection && this.plantState.connections.includes(this.selectedConnection)
        ? this.selectedConnection : null,
      hoveredComponentId: this.hoveredComponentId,
      showPorts: this.showPorts,
      showWires: this.showWires,
      highlightedPort: this.highlightedPort,
      constructionMode: this.constructionMode,
      buildMode: this.buildMode,
      placementPreview: this.placementPreview,
      pipeOrientation: this.pipeOrientation,
      connectionFluid: (conn, from) => this.getConnectionFluid(conn, from),
    });

    const components = Array.from(this.plantState.components.values())
      .filter(c => !(c as any).isHydraulicOnly);
    this.renderElevationArrows(ctx, components);

    if (this.simState) {
      const getPortScreenPos = (comp: PlantComponent, port: { position: Point }) =>
        this.grid.portScreenPosition(comp, (port as Port).id);
      const getConnScreenPos = (_from: PlantComponent, _to: PlantComponent, conn: Connection) =>
        this.grid.connectionScreenEndpoints(conn, this.plantState);
      this.flowArrowHits = [];
      renderFlowConnectionArrows(ctx, this.simState, this.plantState, this.view, getPortScreenPos, getConnScreenPos,
        (conn, x, y, size) => this.flowArrowHits.push({ conn, x, y, size }));
      this.drawSelectedArrowRing(ctx);

      const getScreenBounds = (comp: PlantComponent) => this.getComponentScreenBounds(comp);
      renderPressureGauge(ctx, this.simState, this.plantState, this.view, getScreenBounds);
      renderThermometers(ctx, this.simState, this.plantState, this.view, getScreenBounds);
      const breaks = this.currentBreaks();
      const anchorFor = breakAnchorLookup(breaks);
      renderBurstOverlays(ctx, this.simState, this.plantState, this.view, getScreenBounds, anchorFor);
      const getGroundY = (worldPos: Point) => this.getGroundY(worldPos);
      renderBreakConnections(ctx, this.simState, this.plantState, this.view, undefined, getScreenBounds, getGroundY, anchorFor);

      // Plan-view break: a torn gap on the wall the break faces, with the
      // discharge running out across the ground (break-fx.ts).
      drawBreaks(ctx, breaks, performance.now());
      this.renderFires(ctx, getScreenBounds);
    }

    if (shake) ctx.restore();

    renderColorLegend(ctx, width, height);
  }
}

/**
 * Points along the curve renderConnectionPerspective strokes for a
 * connection (two quadratic segments through the midpoint), for hit testing.
 */
function sampleConnectionCurve(from: Point, to: Point): Point[] {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const segs: Array<[Point, Point, Point]> = [
    [from, { x: midX, y: from.y }, { x: midX, y: midY }],
    [{ x: midX, y: midY }, { x: midX, y: to.y }, to],
  ];
  const pts: Point[] = [];
  for (const [p0, c, p1] of segs) {
    for (let i = pts.length === 0 ? 0 : 1; i <= 10; i++) {
      const t = i / 10;
      const u = 1 - t;
      pts.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y });
    }
  }
  return pts;
}

/** Screen distance from a point to a polyline. */
function distanceToPolylinePx(p: Point, pts: Point[]): number {
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}
