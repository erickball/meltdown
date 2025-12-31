import { ViewState, Point, PlantState, PlantComponent } from '../types';
import { SimulationState } from '../simulation';
import { renderComponent, renderGrid, renderConnection, screenToWorld, worldToScreen, renderFlowConnectionArrows, renderPressureGauge } from './components';
import {
  IsometricConfig,
  DEFAULT_ISOMETRIC,
  renderIsometricGround,
  renderElevationLabel,
  getComponentElevation,
  renderDebugGrid,
} from './isometric';

export class PlantCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private view: ViewState;
  private plantState: PlantState;
  private simState: SimulationState | null = null;
  private showPorts: boolean = false;
  private highlightedPort: { componentId: string; portId: string } | null = null;
  private isometric: IsometricConfig = { ...DEFAULT_ISOMETRIC };

  // Camera depth for forward/backward movement in isometric view
  // Separate from view.offsetY which controls elevation
  private cameraDepth: number = 0;


  // Interaction state
  private isDragging: boolean = false;
  private dragStart: Point = { x: 0, y: 0 };
  private selectedComponentId: string | null = null;
  private hoveredComponentId: string | null = null;
  private moveMode: boolean = false;
  private isMovingComponent: boolean = false;

  // Construction mode - shows grid and component outlines at ground level
  private constructionMode: boolean = true;

  // Callbacks
  public onMouseMove?: (worldPos: Point) => void;
  public onComponentSelect?: (componentId: string | null) => void;
  public onComponentMove?: (componentId: string, newPosition: Point) => void;

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
    // Mouse events
    this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
    this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
    this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
    this.canvas.addEventListener('mouseleave', this.handleMouseUp.bind(this));
    this.canvas.addEventListener('wheel', this.handleWheel.bind(this));

    // Touch events for mobile
    this.canvas.addEventListener('touchstart', this.handleTouchStart.bind(this));
    this.canvas.addEventListener('touchmove', this.handleTouchMove.bind(this));
    this.canvas.addEventListener('touchend', this.handleTouchEnd.bind(this));

    // Keyboard events for arrow key elevation control
    window.addEventListener('keydown', this.handleKeyDown.bind(this));

    // Resize
    window.addEventListener('resize', this.resize.bind(this));
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Only handle arrow keys in isometric mode for elevation control
    if (!this.isometric.enabled) return;

    const elevationStep = 20; // Pixels per key press

    switch (e.key) {
      case 'ArrowUp':
        this.view.offsetY -= elevationStep;
        this.clampView();
        e.preventDefault();
        break;
      case 'ArrowDown':
        this.view.offsetY += elevationStep;
        this.clampView();
        e.preventDefault();
        break;
    }
  }

  private handleMouseDown(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

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
      if (clickedComponent) {
        this.selectedComponentId = clickedComponent.id;
        this.onComponentSelect?.(clickedComponent.id);

        // In move mode, start dragging the component
        if (this.moveMode) {
          this.isMovingComponent = true;
          this.dragStart = { x, y };
        }
      } else {
        // Start panning (only if not in move mode, or nothing selected)
        this.isDragging = true;
        this.dragStart = { x, y };
        if (!this.moveMode) {
          this.selectedComponentId = null;
          this.onComponentSelect?.(null);
        }
      }
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Update world position callback
    const worldPos = screenToWorld({ x, y }, this.view);
    this.onMouseMove?.(worldPos);

    // Update hover state
    const hovered = this.getComponentAtScreen({ x, y });
    this.hoveredComponentId = hovered?.id ?? null;

    if (this.isMovingComponent && this.selectedComponentId) {
      // Move the selected component
      const component = this.plantState.components.get(this.selectedComponentId);
      if (component) {
        if (this.isometric.enabled) {
          // In perspective mode, convert screen positions to world positions
          const currentWorld = this.screenToWorldPerspective({ x, y });
          const prevWorld = this.screenToWorldPerspective(this.dragStart);
          const dx = currentWorld.x - prevWorld.x;
          const dy = currentWorld.y - prevWorld.y;
          component.position.x += dx;
          component.position.y += dy;
        } else {
          // In 2D mode, use simple screen-to-world conversion
          const dx = (x - this.dragStart.x) / this.view.zoom;
          const dy = (y - this.dragStart.y) / this.view.zoom;
          component.position.x += dx;
          component.position.y += dy;
        }
        this.dragStart = { x, y };
        this.onComponentMove?.(this.selectedComponentId, component.position);
      }
    } else if (this.isDragging) {
      // Pan the view
      const dx = x - this.dragStart.x;
      const dy = y - this.dragStart.y;

      if (this.isometric.enabled) {
        // In isometric mode:
        // - Drag left/right moves laterally (offsetX)
        // - Drag up/down moves forward/backward (cameraDepth)
        // Drag down = move forward (negative dy = forward)
        this.view.offsetX += dx;
        this.cameraDepth -= dy; // Negate: drag down = move forward
      } else {
        // In normal 2D mode, drag moves view offset directly
        this.view.offsetX += dx;
        this.view.offsetY += dy;
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

  private handleMouseUp(_e: MouseEvent): void {
    this.isDragging = false;
    this.isMovingComponent = false;
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();

    if (this.isometric.enabled) {
      // In isometric mode, scroll wheel changes view angle
      // Scroll up = look more from above (increase angle), scroll down = look more forward (decrease angle)
      const angleStep = 5;
      this.viewAngle += e.deltaY > 0 ? angleStep : -angleStep;
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
      // In 2D mode, scroll wheel zooms
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Zoom toward mouse position
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(10, Math.min(200, this.view.zoom * zoomFactor));

      // Adjust offset to zoom toward mouse
      const worldX = (mouseX - this.view.offsetX) / this.view.zoom;
      const worldY = (mouseY - this.view.offsetY) / this.view.zoom;

      this.view.zoom = newZoom;
      this.view.offsetX = mouseX - worldX * newZoom;
      this.view.offsetY = mouseY - worldY * newZoom;
      this.clampView();
    }
  }

  // Touch handling
  private lastTouchDist: number = 0;
  private lastTouchCenter: Point = { x: 0, y: 0 };

  private handleTouchStart(e: TouchEvent): void {
    e.preventDefault();
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const rect = this.canvas.getBoundingClientRect();
      this.isDragging = true;
      this.dragStart = {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      };
    } else if (e.touches.length === 2) {
      // Pinch zoom start
      const rect = this.canvas.getBoundingClientRect();
      const t1 = { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
      const t2 = { x: e.touches[1].clientX - rect.left, y: e.touches[1].clientY - rect.top };
      this.lastTouchDist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
      this.lastTouchCenter = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 };
    }
  }

  private handleTouchMove(e: TouchEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();

    if (e.touches.length === 1 && this.isDragging) {
      const touch = e.touches[0];
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      const dx = x - this.dragStart.x;
      const dy = y - this.dragStart.y;

      if (this.isometric.enabled) {
        this.view.offsetX += dx;
        this.cameraDepth -= dy; // Negate: drag down = move forward
      } else {
        this.view.offsetX += dx;
        this.view.offsetY += dy;
      }

      this.clampView();
      this.dragStart = { x, y };
    } else if (e.touches.length === 2) {
      // Pinch zoom
      const t1 = { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
      const t2 = { x: e.touches[1].clientX - rect.left, y: e.touches[1].clientY - rect.top };
      const dist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
      const center = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 };

      if (this.lastTouchDist > 0) {
        const zoomFactor = dist / this.lastTouchDist;
        const newZoom = Math.max(10, Math.min(200, this.view.zoom * zoomFactor));

        // Zoom toward center
        const worldX = (center.x - this.view.offsetX) / this.view.zoom;
        const worldY = (center.y - this.view.offsetY) / this.view.zoom;

        this.view.zoom = newZoom;
        this.view.offsetX = center.x - worldX * newZoom;
        this.view.offsetY = center.y - worldY * newZoom;
      }

      // Also pan
      this.view.offsetX += center.x - this.lastTouchCenter.x;
      this.view.offsetY += center.y - this.lastTouchCenter.y;
      this.clampView();

      this.lastTouchDist = dist;
      this.lastTouchCenter = center;
    }
  }

  private handleTouchEnd(e: TouchEvent): void {
    if (e.touches.length === 0) {
      this.isDragging = false;
      this.lastTouchDist = 0;
    }
  }

  public getComponentAtScreen(screenPos: Point): PlantComponent | null {
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

      // Second priority: depth sorting
      if (this.isometric.enabled) {
        return a.position.y - b.position.y;
      }
      return 0;
    });

    for (const component of components) {
      if (this.isometric.enabled) {
        // In isometric mode, check against projected screen bounds
        if (this.isPointInProjectedComponent(screenPos, component)) {
          return component;
        }
      } else {
        // In 2D mode, use world coordinate check
        const worldPos = this.getWorldPositionFromScreen(screenPos);
        if (this.isPointInComponent(worldPos, component)) {
          return component;
        }
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

    // For pipes, local coords go from (0, -halfH) to (length, halfH)
    // For others, centered: (-halfW, -halfH) to (halfW, halfH)
    let localLeft = -halfW;
    let localRight = halfW;
    if (component.type === 'pipe') {
      localLeft = 0;
      localRight = size.width;
    }

    // Define 4 corners in local space (ground footprint)
    const localCorners = [
      { x: localLeft, y: -halfH },   // front-left
      { x: localRight, y: -halfH },  // front-right
      { x: localRight, y: halfH },   // back-right
      { x: localLeft, y: halfH },    // back-left
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

    const frontLeft = screenCorners[0].pos;
    const frontRight = screenCorners[1].pos;
    const backRight = screenCorners[2].pos;
    const backLeft = screenCorners[3].pos;

    // Calculate the visual bounds - must match the rendering translation logic
    const frontWidth = Math.hypot(frontRight.x - frontLeft.x, frontRight.y - frontLeft.y);
    const projectedZoom = frontWidth / size.width;
    const visualHalfH = halfH * projectedZoom;

    let visualQuad: Point[];

    if (component.type === 'pipe') {
      // For pipes with endpoint data, use projected endpoints for hit testing
      const pipe = component as import('../types').PipeComponent;
      if (pipe.endPosition && pipe.endElevation !== undefined) {
        // Project both endpoints
        const startScreen = this.worldToScreenPerspective(
          { x: pipe.position.x, y: pipe.position.y },
          pipe.elevation ?? 0
        );
        const endScreen = this.worldToScreenPerspective(
          pipe.endPosition,
          pipe.endElevation
        );

        if (startScreen.scale > 0 && endScreen.scale > 0) {
          // Calculate pipe visual thickness
          const avgScale = (startScreen.scale + endScreen.scale) / 2;
          const visualThickness = halfH * avgScale * 50; // Match rendering zoom

          // Calculate perpendicular offset for pipe width
          const dx = endScreen.pos.x - startScreen.pos.x;
          const dy = endScreen.pos.y - startScreen.pos.y;
          const len = Math.hypot(dx, dy);
          const perpX = -dy / len * visualThickness;
          const perpY = dx / len * visualThickness;

          // Quad corners: start-left, start-right, end-right, end-left
          visualQuad = [
            { x: startScreen.pos.x + perpX, y: startScreen.pos.y + perpY },
            { x: startScreen.pos.x - perpX, y: startScreen.pos.y - perpY },
            { x: endScreen.pos.x - perpX, y: endScreen.pos.y - perpY },
            { x: endScreen.pos.x + perpX, y: endScreen.pos.y + perpY },
          ];
          return this.isPointInQuad(screenPos, visualQuad);
        }
      }

      // Fallback for pipes without endpoint data
      const visualTop = backLeft.y - 2 * visualHalfH;
      const visualBottom = backLeft.y;
      visualQuad = [
        { x: backLeft.x, y: visualTop },      // top-left
        { x: backRight.x, y: visualTop },     // top-right
        { x: backRight.x, y: visualBottom },  // bottom-right
        { x: backLeft.x, y: visualBottom },   // bottom-left
      ];
    } else {
      // Other components: translateX = frontCenterX, translateY = frontCenterY - visualHalfH
      // Visual center is at (frontCenterX, frontCenterY - visualHalfH)
      // Visual spans from center ± visualHalfW/H
      const frontCenterX = (frontLeft.x + frontRight.x) / 2;
      const frontCenterY = (frontLeft.y + frontRight.y) / 2;
      const visualHalfW = halfW * projectedZoom;
      const visualCenterY = frontCenterY - visualHalfH;
      visualQuad = [
        { x: frontCenterX - visualHalfW, y: visualCenterY - visualHalfH },  // top-left
        { x: frontCenterX + visualHalfW, y: visualCenterY - visualHalfH },  // top-right
        { x: frontCenterX + visualHalfW, y: visualCenterY + visualHalfH },  // bottom-right
        { x: frontCenterX - visualHalfW, y: visualCenterY + visualHalfH },  // bottom-left
      ];
    }

    return this.isPointInQuad(screenPos, visualQuad);
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
    // Check all components for nearby ports
    // Sort so contained components are checked first (they're rendered on top)
    const components = Array.from(this.plantState.components.values()).sort((a, b) => {
      // Contained components should be checked first
      if (a.containedBy && !b.containedBy) return -1;
      if (!a.containedBy && b.containedBy) return 1;
      return 0;
    });

    for (const component of components) {
      if (!component.ports) continue;

      for (const port of component.ports) {
        const portWorldPos = this.getPortWorldPosition(component, port);

        if (this.isometric.enabled) {
          // In isometric mode, check against screen position
          const portScreenPos = this.getPortScreenPosition(component, port);
          if (!portScreenPos) continue;

          const distance = Math.hypot(
            screenPos.x - portScreenPos.x,
            screenPos.y - portScreenPos.y
          );

          // Use a screen-space radius for detection
          const detectionRadius = Math.max(15, portScreenPos.radius * 1.5);
          if (distance <= detectionRadius) {
            return { component, port, worldPos: portWorldPos };
          }
        } else {
          // In 2D mode, use world coordinate check
          const worldPos = screenToWorld(screenPos, this.view);
          const portRadius = 0.3; // Detection radius in meters
          const distance = Math.hypot(
            worldPos.x - portWorldPos.x,
            worldPos.y - portWorldPos.y
          );

          if (distance <= portRadius) {
            return { component, port, worldPos: portWorldPos };
          }
        }
      }
    }

    return null;
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
    const halfW = size.width / 2;
    const halfH = size.height / 2;

    const centerX = component.position.x;
    const centerY = component.position.y;
    const cos = Math.cos(component.rotation);
    const sin = Math.sin(component.rotation);

    // For pipes without endpoint data, use old method
    let localLeft = -halfW;
    if (component.type === 'pipe') {
      localLeft = 0;
    }

    // Project corners to get the visual bounds (same as component rendering)
    const localCorners = [
      { x: localLeft, y: -halfH },   // front-left
      { x: localLeft + size.width, y: -halfH },  // front-right
      { x: localLeft + size.width, y: halfH },   // back-right
      { x: localLeft, y: halfH },    // back-left
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

    // Calculate the translation point (same as component rendering)
    let translateX: number;
    let translateY: number;

    if (component.type === 'pipe') {
      translateX = backLeft.x;
      translateY = backLeft.y - visualHalfH;
    } else {
      const frontCenterX = (frontLeft.x + frontRight.x) / 2;
      const frontCenterY = (frontLeft.y + frontRight.y) / 2;
      translateX = frontCenterX;
      translateY = frontCenterY - visualHalfH;
    }

    // Transform port's local position to screen space
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

  private isPointInComponent(worldPos: Point, component: PlantComponent): boolean {
    // Transform point to component local coordinates
    const dx = worldPos.x - component.position.x;
    const dy = worldPos.y - component.position.y;
    const cos = Math.cos(-component.rotation);
    const sin = Math.sin(-component.rotation);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;

    // Check bounds based on component type
    switch (component.type) {
      case 'tank':
        return Math.abs(localX) <= component.width / 2 &&
               Math.abs(localY) <= component.height / 2;
      case 'pipe':
        return localX >= 0 && localX <= component.length &&
               Math.abs(localY) <= component.diameter / 2;
      case 'pump':
        return Math.hypot(localX, localY) <= component.diameter / 2;
      case 'vessel':
        const r = component.innerDiameter / 2 + component.wallThickness;
        return Math.abs(localX) <= r && Math.abs(localY) <= component.height / 2;
      case 'reactorVessel':
        const rv = component as import('../types').ReactorVesselComponent;
        const rvR = rv.innerDiameter / 2 + rv.wallThickness;
        return Math.abs(localX) <= rvR && Math.abs(localY) <= rv.height / 2;
      case 'valve':
        const vr = component.diameter;
        return Math.abs(localX) <= vr && Math.abs(localY) <= vr;
      case 'heatExchanger':
        return Math.abs(localX) <= component.width / 2 &&
               Math.abs(localY) <= component.height / 2;
      default:
        return false;
    }
  }

  public resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;

    this.ctx.scale(dpr, dpr);
  }

  // Perspective projection constants
  private readonly CAMERA_HEIGHT = 50;
  private readonly PERSPECTIVE_X_SCALE = 50;
  private readonly ELEVATION_SCALE = 50;

  // View angle in degrees from horizontal (20 = looking forward, 70 = looking down)
  // Controls both zoom (higher = further away) and vertical compression (higher = more top-down)
  private viewAngle: number = 30;

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
    // Higher offset = near and far objects appear more similar in size
    const effectiveRelY = relY + perspectiveOffset;

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
    const screenY = baseScreenY - elevationOffset;

    return { pos: { x: screenX, y: screenY }, scale: finalScale };
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

    // Reverse the stretch transformation first
    const stretchFactor = 1 + perspectiveOffset * 0.01;
    const screenCenterY = horizonY + groundHeight * 0.4;
    const rawScreenY = screenCenterY + (screenPos.y - screenCenterY) / stretchFactor;

    // Now reverse the perspective projection
    const screenYFromHorizon = rawScreenY - horizonY;
    if (screenYFromHorizon <= 0) {
      return { x: cameraWorldX, y: cameraWorldY + 1000 };
    }

    const relY = groundHeight * this.CAMERA_HEIGHT / screenYFromHorizon;

    if (relY < 1) {
      return { x: cameraWorldX, y: cameraWorldY + 1 };
    }

    // Reverse X projection using effective distance for scale
    const effectiveRelY = relY + perspectiveOffset;
    const perspectiveScale = this.CAMERA_HEIGHT / effectiveRelY;
    const cappedScale = Math.min(perspectiveScale, 3);
    const finalScale = cappedScale * overallScale;

    const relX = (screenPos.x - centerX) / (finalScale * this.PERSPECTIVE_X_SCALE);

    return {
      x: relX + cameraWorldX,
      y: relY + cameraWorldY
    };
  }

  // Public method to convert screen to world coordinates
  // Uses perspective projection when in isometric mode
  public getWorldPositionFromScreen(screenPos: Point): Point {
    if (this.isometric.enabled) {
      return this.screenToWorldPerspective(screenPos);
    } else {
      // Use standard 2D conversion
      return {
        x: (screenPos.x - this.view.offsetX) / this.view.zoom,
        y: (screenPos.y - this.view.offsetY) / this.view.zoom
      };
    }
  }

  // Get camera depth for external use (e.g., shrub rendering)
  public getCameraDepth(): number {
    return this.cameraDepth;
  }

  // Clamp view offset to keep content visible
  // In isometric mode, limit panning to a reasonable range
  private clampView(): void {
    const rect = this.canvas.getBoundingClientRect();

    if (this.isometric.enabled) {
      // Limit elevation (view.offsetY) - controlled by arrow keys
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
    // No clamping in normal 2D mode - allow free panning
  }

  public render(): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();

    // Clear
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Draw background - either grid or isometric ground
    if (this.isometric.enabled) {
      renderIsometricGround(ctx, this.view, rect.width, rect.height, this.isometric, this.cameraDepth, this.viewAngle);

      // Draw construction grid on ground plane in construction mode
      if (this.constructionMode) {
        renderDebugGrid(ctx, this.view, rect.width, rect.height, this.cameraDepth,
          (pos, elev) => this.worldToScreenPerspective(pos, elev));
      }
    } else {
      renderGrid(ctx, this.view, rect.width, rect.height);
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

      // Second priority: depth sorting in isometric mode
      if (!this.isometric.enabled) return 0;
      return (b.position.y - a.position.y);
    });

    // Draw shadows first (if isometric)
    // Shadows are computed in world space using 3D ray-plane intersection
    if (this.isometric.enabled) {
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

          const size = this.getComponentSize(component);
          const worldWidth = size.width || 1;
          const worldHeight = size.height || 1;

          // Get component's elevation (z coordinate)
          const elevation = getComponentElevation(component);

          // Component center in world space
          // For most components, position IS the center
          // For pipes, position is at one end, so we need to offset to find the center
          let centerX = component.position.x;
          let centerY = component.position.y;
          // Note: pipe offset handled below by adjusting local corners

          // Component corners in local 3D space
          const halfW = worldWidth / 2;
          const halfH = worldHeight / 2;
          const cos = Math.cos(component.rotation);
          const sin = Math.sin(component.rotation);

          // For pipes, position is at one end, not center
          // Local coordinates: pipes go from (0, -halfH) to (length, halfH), not centered
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

          // Base front corners
          const baseFrontLeft = { x: localLeft, y: -halfH, z: baseElevation };
          const baseFrontRight = { x: localRight, y: -halfH, z: baseElevation };

          // Top front corners
          const topFrontLeft = { x: localLeft, y: -halfH, z: topZ };
          const topFrontRight = { x: localRight, y: -halfH, z: topZ };

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

          ctx.restore();
        } catch (e) {
          console.error('Shadow rendering error:', e);
        }
      }

      // Draw ground-level outlines in construction mode
      if (this.constructionMode) {
        for (const component of sortedComponents) {
          this.renderGroundOutline(ctx, component);
        }
      }
    }

    // Draw connections (behind components)
    for (const connection of this.plantState.connections) {
      const fromComponent = this.plantState.components.get(connection.fromComponentId);
      const toComponent = this.plantState.components.get(connection.toComponentId);

      if (fromComponent && toComponent) {
        const fromPort = fromComponent.ports.find(p => p.id === connection.fromPortId);
        const toPort = toComponent.ports.find(p => p.id === connection.toPortId);

        if (fromPort && toPort) {
          if (this.isometric.enabled) {
            // Use perspective-aware connection rendering
            this.renderConnectionPerspective(ctx, fromComponent, fromPort, toComponent, toPort);
          } else {
            // Calculate world positions of ports
            const fromWorld = this.getPortWorldPosition(fromComponent, fromPort);
            const toWorld = this.getPortWorldPosition(toComponent, toPort);
            renderConnection(ctx, fromWorld, toWorld, fromComponent.fluid, this.view);
          }
        }
      }
    }

    // Draw components with perspective projection
    // Project all 4 corners individually for proper ground-plane alignment
    for (const component of sortedComponents) {
      ctx.save();

      // Apply perspective projection if in isometric mode
      if (this.isometric.enabled) {
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

        // Get the projected corner positions
        const frontLeft = screenCorners[0].pos;
        const frontRight = screenCorners[1].pos;
        const backLeft = screenCorners[3].pos;

        // Use front edge width for zoom
        const frontWidth = Math.hypot(frontRight.x - frontLeft.x, frontRight.y - frontLeft.y);
        const projectedZoom = frontWidth / size.width;

        // Get vertical scale first - needed for translation calculation
        const { verticalScale } = this.getViewTransform();

        // Position the component based on how renderComponent draws it:
        // - For pipes: draws from (0,0) to (length,0), so translate to front-left
        // - For others: draws centered at (0,0), so translate to front-center, offset up by halfH
        // IMPORTANT: Account for verticalScale so the base of the component stays on the ground
        // after the vertical compression is applied
        let translateX: number;
        let translateY: number;

        if (component.type === 'pipe') {
          // For pipes with endpoint data, project both endpoints and draw between them
          const pipe = component as import('../types').PipeComponent;
          if (pipe.endPosition && pipe.endElevation !== undefined) {
            // Project start point (position, elevation)
            const startScreen = this.worldToScreenPerspective(
              { x: pipe.position.x, y: pipe.position.y },
              pipe.elevation ?? 0
            );
            // Project end point
            const endScreen = this.worldToScreenPerspective(
              pipe.endPosition,
              pipe.endElevation
            );

            if (startScreen.scale > 0 && endScreen.scale > 0) {
              // Calculate screen-space length and rotation
              const screenDx = endScreen.pos.x - startScreen.pos.x;
              const screenDy = endScreen.pos.y - startScreen.pos.y;
              const screenLength = Math.hypot(screenDx, screenDy);
              const screenRotation = Math.atan2(screenDy, screenDx);

              // Use average scale for pipe thickness
              const avgScale = (startScreen.scale + endScreen.scale) / 2;
              const pipeZoom = avgScale * 50; // Base zoom factor

              // Position at start point, rotate toward end point
              ctx.translate(startScreen.pos.x, startScreen.pos.y);
              ctx.rotate(screenRotation);

              // Create a modified view for rendering with screen-space dimensions
              const pipeView: ViewState = { ...this.view, zoom: pipeZoom };

              // Temporarily modify pipe length to match screen length
              const originalLength = pipe.length;
              (pipe as any).length = screenLength / pipeZoom;

              const isSelected = component.id === this.selectedComponentId;
              renderComponent(ctx, pipe, pipeView, isSelected, true, this.plantState.connections);

              // Restore original length
              (pipe as any).length = originalLength;

              ctx.restore();
              continue; // Skip the normal rendering path
            }
          }

          // Fallback for pipes without endpoint data
          const visualHalfH = halfH * projectedZoom;
          translateX = backLeft.x;
          translateY = backLeft.y - visualHalfH;
        } else {
          // Other components draw centered, so position at front-center, offset up
          // After vertical scaling, the bottom of the component (at local +halfH) will be at
          // translateY + visualHalfH * verticalScale. We want this to equal frontCenterY.
          const frontCenterX = (frontLeft.x + frontRight.x) / 2;
          const frontCenterY = (frontLeft.y + frontRight.y) / 2;
          const visualHalfH = halfH * projectedZoom * verticalScale; // Account for compression
          translateX = frontCenterX;
          translateY = frontCenterY - visualHalfH;
        }

        ctx.translate(translateX, translateY);
        ctx.rotate(component.rotation);

        // Apply vertical compression based on view angle (looking from above = compressed)
        // Skip for pipes since they're thin horizontal elements and compression looks wrong
        if (component.type !== 'pipe') {
          ctx.scale(1, verticalScale);
        }

        const isometricView: ViewState = { ...this.view, zoom: projectedZoom };
        const isSelected = component.id === this.selectedComponentId;
        renderComponent(ctx, component, isometricView, isSelected, true, this.plantState.connections);

        // Render elevation label (reset scale first so text isn't squished)
        if (component.type !== 'pipe') {
          ctx.scale(1, 1 / verticalScale);
        }
        renderElevationLabel(ctx, component, isometricView, this.isometric);
      } else {
        const screenPos = worldToScreen(component.position, this.view);
        ctx.translate(screenPos.x, screenPos.y);
        ctx.rotate(component.rotation);

        // Render the component
        const isSelected = component.id === this.selectedComponentId;
        renderComponent(ctx, component, this.view, isSelected, false, this.plantState.connections);
      }

      ctx.restore();
    }

    // Draw port indicators if enabled
    if (this.showPorts) {
      this.renderPortIndicators(ctx);
    }

    // Draw flow connection arrows from simulation state (on top of components)
    if (this.simState) {
      renderFlowConnectionArrows(ctx, this.simState, this.plantState, this.view);
    }

    // Draw pressure gauges on flow nodes
    if (this.simState) {
      renderPressureGauge(ctx, this.simState, this.plantState, this.view);
    }

    // Schedule next frame
    requestAnimationFrame(() => this.render());
  }

  private getPortWorldPosition(component: PlantComponent, port: { position: Point }): Point {
    const cos = Math.cos(component.rotation);
    const sin = Math.sin(component.rotation);
    return {
      x: component.position.x + port.position.x * cos - port.position.y * sin,
      y: component.position.y + port.position.x * sin + port.position.y * cos,
    };
  }

  // Get component size in world units (meters) for shadow rendering
  private getComponentSize(component: PlantComponent): { width: number; height: number } {
    switch (component.type) {
      case 'tank':
        return { width: (component as any).width, height: (component as any).height };
      case 'pipe':
        return { width: (component as any).length, height: (component as any).diameter };
      case 'pump':
        const pumpD = (component as any).diameter || 0.3;
        return { width: pumpD, height: pumpD };
      case 'vessel':
        const vesselR = (component as any).innerDiameter / 2 + (component as any).wallThickness;
        return { width: vesselR * 2, height: (component as any).height };
      case 'reactorVessel':
        const rvR2 = (component as any).innerDiameter / 2 + (component as any).wallThickness;
        return { width: rvR2 * 2, height: (component as any).height };
      case 'valve':
        const valveD = (component as any).diameter || 0.2;
        return { width: valveD * 2, height: valveD * 2 };
      case 'heatExchanger':
        return { width: (component as any).width, height: (component as any).height };
      case 'turbine-generator':
        return { width: (component as any).width || 1.5, height: (component as any).height || 1.2 };
      case 'turbine-driven-pump':
        return { width: (component as any).width || 1, height: (component as any).height || 0.6 };
      case 'condenser':
        return { width: (component as any).width || 2, height: (component as any).height || 1 };
      default:
        return { width: 1, height: 1 };
    }
  }

  private renderPortIndicators(ctx: CanvasRenderingContext2D): void {
    for (const component of this.plantState.components.values()) {
      if (!component.ports) continue;

      for (const port of component.ports) {
        let screenPos: Point;
        let portRadius: number;
        let lineWidth: number;

        if (this.isometric.enabled) {
          // Use the same positioning as click detection
          const portScreenPos = this.getPortScreenPosition(component, port);
          if (!portScreenPos) continue;

          screenPos = { x: portScreenPos.x, y: portScreenPos.y };
          portRadius = portScreenPos.radius;
          lineWidth = Math.max(1, portRadius * 0.25);
        } else {
          const worldPos = this.getPortWorldPosition(component, port);
          screenPos = worldToScreen(worldPos, this.view);
          portRadius = 8;
          lineWidth = 2;
        }

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
  private renderConnectionPerspective(
    ctx: CanvasRenderingContext2D,
    fromComponent: PlantComponent,
    fromPort: { position: Point },
    toComponent: PlantComponent,
    toPort: { position: Point }
  ): void {
    // Get screen positions for both ports
    const fromScreenPos = this.getPortScreenPosition(fromComponent, fromPort);
    const toScreenPos = this.getPortScreenPosition(toComponent, toPort);

    if (!fromScreenPos || !toScreenPos) return;

    // Get fluid color from the source component
    const fluid = (fromComponent as any).fluid;
    ctx.strokeStyle = fluid ? this.getFluidColorForConnection(fluid) : '#667788';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(fromScreenPos.x, fromScreenPos.y);

    // Simple curved connection in screen space
    const midX = (fromScreenPos.x + toScreenPos.x) / 2;
    const midY = (fromScreenPos.y + toScreenPos.y) / 2;
    ctx.quadraticCurveTo(midX, fromScreenPos.y, midX, midY);
    ctx.quadraticCurveTo(midX, toScreenPos.y, toScreenPos.x, toScreenPos.y);

    ctx.stroke();
  }

  // Get fluid color for connection rendering
  private getFluidColorForConnection(fluid: any): string {
    if (!fluid) return '#667788';

    // Map temperature/phase to color
    if (fluid.phase === 'vapor') {
      return 'rgba(200, 200, 255, 0.8)';
    } else if (fluid.phase === 'two-phase') {
      return 'rgba(150, 180, 220, 0.8)';
    } else {
      // Liquid - color based on temperature
      const temp = fluid.temperature || 300;
      if (temp > 500) return 'rgba(255, 100, 100, 0.8)';
      if (temp > 400) return 'rgba(255, 150, 100, 0.8)';
      if (temp > 350) return 'rgba(200, 150, 100, 0.8)';
      return 'rgba(100, 150, 200, 0.8)';
    }
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

  // Public API
  public setPlantState(state: PlantState): void {
    this.plantState = state;
  }

  public setShowPorts(show: boolean): void {
    this.showPorts = show;
    if (!show) {
      this.highlightedPort = null;  // Clear highlight when hiding ports
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
  }

  public getView(): ViewState {
    return { ...this.view };
  }

  public setIsometric(enabled: boolean): void {
    const wasEnabled = this.isometric.enabled;
    this.isometric.enabled = enabled;

    // Adjust view when switching modes to keep components visible
    if (wasEnabled !== enabled) {
      const rect = this.canvas.getBoundingClientRect();

      if (!enabled) {
        // Switching from 2.5D to 2D: center view on components
        const components = Array.from(this.plantState.components.values());
        if (components.length > 0) {
          // Find bounding box of all components
          let minX = Infinity, maxX = -Infinity;
          let minY = Infinity, maxY = -Infinity;
          for (const comp of components) {
            minX = Math.min(minX, comp.position.x);
            maxX = Math.max(maxX, comp.position.x);
            minY = Math.min(minY, comp.position.y);
            maxY = Math.max(maxY, comp.position.y);
          }
          const centerX = (minX + maxX) / 2;
          const centerY = (minY + maxY) / 2;

          // Use zoom=1 and center on components
          this.view.zoom = 10;
          this.view.offsetX = rect.width / 2 - centerX * this.view.zoom;
          this.view.offsetY = rect.height / 2 - centerY * this.view.zoom;
        }
      } else {
        // Switching from 2D to 2.5D: reset camera depth
        this.cameraDepth = 0;
      }
    }
  }

  public toggleIsometric(): void {
    this.setIsometric(!this.isometric.enabled);
  }

  public getIsometric(): boolean {
    return this.isometric.enabled;
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

  public setConstructionMode(enabled: boolean): void {
    this.constructionMode = enabled;
  }

  public setView(view: Partial<ViewState>): void {
    Object.assign(this.view, view);
  }

  public zoomIn(): void {
    this.view.zoom = Math.min(200, this.view.zoom * 1.2);
  }

  public zoomOut(): void {
    this.view.zoom = Math.max(10, this.view.zoom / 1.2);
  }

  public resetView(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.view = {
      offsetX: rect.width / 2 - 150,
      offsetY: rect.height / 2 + 100,
      zoom: 50,
    };
  }

  public getSelectedComponentId(): string | null {
    return this.selectedComponentId;
  }

  public clearSelection(): void {
    this.selectedComponentId = null;
    this.onComponentSelect?.(null);
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
}
