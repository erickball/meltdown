import { ViewState, Point, PlantState, PlantComponent, ControllerComponent, SwitchyardComponent, TurbineGeneratorComponent, Connection } from '../types';
import { SimulationState } from '../simulation';
import { renderComponent, renderGrid, renderConnection, screenToWorld, worldToScreen, renderFlowConnectionArrows, renderPressureGauge, getComponentBounds, ConnectionScreenEndpoints } from './components';
import {
  IsometricConfig,
  DEFAULT_ISOMETRIC,
  renderIsometricGround,
  renderElevationLabel,
  getComponentElevation,
  renderDebugGrid,
} from './isometric';
import { getFluidColor, COLORS, renderColorLegend } from './colors';

export class PlantCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private view: ViewState;
  private plantState: PlantState;
  private simState: SimulationState | null = null;
  private _simStateWarningLogged: boolean = false;
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

  /**
   * Get the screen bounding box for a component.
   * Returns the top-center position and scale, suitable for attaching gauges.
   * This uses the same calculation as isPointInProjectedComponent for consistency.
   */
  public getComponentScreenBounds(component: PlantComponent): { topCenter: Point; scale: number } | null {
    if (!this.isometric.enabled) {
      // In 2D mode, use simple world-to-screen conversion
      const bounds = getComponentBounds(component, this.view);
      const screenCenter = worldToScreen(component.position, this.view);
      const topY = screenCenter.y + bounds.y;
      return {
        topCenter: { x: screenCenter.x, y: topY },
        scale: 1
      };
    }

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

        if (startScreen.scale > 0 && endScreen.scale > 0) {
          const avgScale = (startScreen.scale + endScreen.scale) / 2;
          const visualThickness = halfH * avgScale * 50;
          const midX = (startScreen.pos.x + endScreen.pos.x) / 2;
          const midY = (startScreen.pos.y + endScreen.pos.y) / 2;
          // Top of pipe is at midY - visualThickness
          return {
            topCenter: { x: midX, y: midY - visualThickness },
            scale: avgScale
          };
        }
      }
      // Fallback
      const frontCenterX = (frontLeft.x + frontRight.x) / 2;
      const frontCenterY = (frontLeft.y + frontRight.y) / 2;
      return {
        topCenter: { x: frontCenterX, y: frontCenterY - 2 * visualHalfH },
        scale: perspectiveScale
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
      return {
        topCenter: { x: centerScreen.pos.x, y: topY },
        scale: centerScreen.scale
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
      case 'coreBarrel':
        const cb = component as import('../types').CoreBarrelComponent;
        const cbR = cb.innerDiameter / 2 + cb.thickness;
        return Math.abs(localX) <= cbR && Math.abs(localY) <= cb.height / 2;
      case 'valve':
        const vr = component.diameter;
        return Math.abs(localX) <= vr && Math.abs(localY) <= vr;
      case 'heatExchanger':
        return Math.abs(localX) <= component.width / 2 &&
               Math.abs(localY) <= component.height / 2;
      case 'turbine-generator':
        return Math.abs(localX) <= component.width / 2 &&
               Math.abs(localY) <= component.height / 2;
      case 'turbine-driven-pump':
        return Math.abs(localX) <= component.width / 2 &&
               Math.abs(localY) <= component.height / 2;
      case 'condenser':
        return Math.abs(localX) <= component.width / 2 &&
               Math.abs(localY) <= component.height / 2;
      case 'controller':
        return Math.abs(localX) <= component.width / 2 &&
               Math.abs(localY) <= component.height / 2;
      case 'switchyard':
        const sw = component as import('../types').SwitchyardComponent;
        return Math.abs(localX) <= sw.width / 2 &&
               Math.abs(localY) <= sw.height / 2;
      default:
        return false;
    }
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

  // Public method to convert world coordinates to screen coordinates
  // Uses perspective projection when in isometric mode
  public getScreenPositionFromWorld(worldPos: Point, elevation: number = 0): Point {
    if (this.isometric.enabled) {
      return this.worldToScreenPerspective(worldPos, elevation).pos;
    } else {
      return worldToScreen(worldPos, this.view);
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

          // Skip shadows for switchyard (it has its own individual equipment shadows)
          if (component.type === 'switchyard') continue;

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

            if (this.isometric.enabled) {
              const controllerElev = controller.elevation ?? 0;
              const coreElev = (core as any).elevation ?? 0;
              const controllerProj = this.worldToScreenPerspective(controller.position, controllerElev);
              const coreProj = this.worldToScreenPerspective(core.position, coreElev);
              controllerScreen = controllerProj.pos;
              coreScreen = coreProj.pos;
            } else {
              controllerScreen = worldToScreen(controller.position, this.view);
              coreScreen = worldToScreen(core.position, this.view);
            }

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

            if (this.isometric.enabled) {
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
            } else {
              switchyardScreen = worldToScreen(switchyard.position, this.view);
              // Simple 2D case - generator at turbine position
              generatorScreen = worldToScreen(generator.position, this.view);
            }

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

              // Calculate perspective-scaled diameters at each end
              // The raw perspective is subtle due to perspectiveOffset flattening,
              // so we exaggerate the taper ratio to make it more visually apparent.
              // taperExaggeration of 2.0 means: if far end would be 90% of near end,
              // it becomes 80% instead (difference doubled).
              const taperExaggeration = 2.0;
              const avgScale = (startScreen.scale + endScreen.scale) / 2;
              const rawRatio = endScreen.scale / startScreen.scale;
              const exaggeratedRatio = 1 - (1 - rawRatio) * taperExaggeration;
              // Clamp to reasonable range (don't let it go negative or too extreme)
              const clampedRatio = Math.max(0.3, Math.min(1.5, exaggeratedRatio));

              const startZoom = avgScale * 50;
              const endZoom = startZoom * clampedRatio;

              // Wall thickness (use pressure rating if available)
              const wallThickness = pipe.thickness;
              const startOuterD = (pipe.diameter + wallThickness * 2) * startZoom;
              const startInnerD = pipe.diameter * startZoom;
              const endOuterD = (pipe.diameter + wallThickness * 2) * endZoom;
              const endInnerD = pipe.diameter * endZoom;

              // Position at start point, rotate toward end point
              ctx.translate(startScreen.pos.x, startScreen.pos.y);
              ctx.rotate(screenRotation);

              // Draw tapered pipe (trapezoid) - outer wall
              ctx.fillStyle = COLORS.steel;
              ctx.beginPath();
              ctx.moveTo(0, -startOuterD / 2);           // top-left (start)
              ctx.lineTo(screenLength, -endOuterD / 2);  // top-right (end)
              ctx.lineTo(screenLength, endOuterD / 2);   // bottom-right (end)
              ctx.lineTo(0, startOuterD / 2);            // bottom-left (start)
              ctx.closePath();
              ctx.fill();

              // Draw tapered inner pipe (fluid space)
              if (pipe.fluid) {
                ctx.fillStyle = getFluidColor(pipe.fluid);
              } else {
                ctx.fillStyle = '#111';
              }
              ctx.beginPath();
              ctx.moveTo(0, -startInnerD / 2);
              ctx.lineTo(screenLength, -endInnerD / 2);
              ctx.lineTo(screenLength, endInnerD / 2);
              ctx.lineTo(0, startInnerD / 2);
              ctx.closePath();
              ctx.fill();

              // Draw pipe edges (top and bottom lines)
              ctx.strokeStyle = COLORS.steelHighlight;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(0, -startOuterD / 2);
              ctx.lineTo(screenLength, -endOuterD / 2);
              ctx.moveTo(0, startOuterD / 2);
              ctx.lineTo(screenLength, endOuterD / 2);
              ctx.stroke();

              // Selection highlight
              const isSelected = component.id === this.selectedComponentId;
              if (isSelected) {
                ctx.strokeStyle = 'rgba(100, 150, 255, 0.8)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(-2, -startOuterD / 2 - 2);
                ctx.lineTo(screenLength + 2, -endOuterD / 2 - 2);
                ctx.lineTo(screenLength + 2, endOuterD / 2 + 2);
                ctx.lineTo(-2, startOuterD / 2 + 2);
                ctx.closePath();
                ctx.stroke();
              }

              ctx.restore();
              continue; // Skip the normal rendering path
            }
          }

          // Fallback for pipes without endpoint data
          const visualHalfH = halfH * projectedZoom;
          translateX = backLeft.x;
          translateY = backLeft.y - visualHalfH;
        } else {
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
          translateX = centerScreen.pos.x;
          translateY = centerScreen.pos.y - visualHalfH;

          // Override projectedZoom with center-based zoom for this component
          projectedZoom = centerZoom;
        }

        ctx.translate(translateX, translateY);
        // Skip rotation for pumps - they handle orientation internally via mirroring
        if (component.type !== 'pump') {
          ctx.rotate(component.rotation);
        }

        // Apply vertical compression based on view angle (looking from above = compressed)
        // Skip for pipes since they're thin horizontal elements and compression looks wrong
        if (component.type !== 'pipe') {
          ctx.scale(1, verticalScale);
        }

        const isometricView: ViewState = { ...this.view, zoom: projectedZoom };
        const isSelected = component.id === this.selectedComponentId;
        // Create projection function for components that need world-to-screen mapping
        // Returns both screen position and scale factor for proper perspective rendering
        const worldToScreenFn = (pos: Point, elev: number = 0) => this.worldToScreenPerspective(pos, elev);
        renderComponent(ctx, component, isometricView, isSelected, true, this.plantState.connections, !this.constructionMode, this.plantState, worldToScreenFn);

        // Render elevation label (reset scale first so text isn't squished)
        if (component.type !== 'pipe') {
          ctx.scale(1, 1 / verticalScale);
        }
        renderElevationLabel(ctx, component, isometricView, this.isometric);
      } else {
        const screenPos = worldToScreen(component.position, this.view);
        ctx.translate(screenPos.x, screenPos.y);
        // Skip rotation for pumps - they handle orientation internally via mirroring
        if (component.type !== 'pump') {
          ctx.rotate(component.rotation);
        }

        // Render the component
        const isSelected = component.id === this.selectedComponentId;
        renderComponent(ctx, component, this.view, isSelected, false, this.plantState.connections, !this.constructionMode, this.plantState);
      }

      ctx.restore();
    }

    // Draw connections (on top of components so labels are visible)
    for (const connection of this.plantState.connections) {
      const fromComponent = this.plantState.components.get(connection.fromComponentId);
      const toComponent = this.plantState.components.get(connection.toComponentId);

      if (fromComponent && toComponent) {
        const fromPort = fromComponent.ports.find(p => p.id === connection.fromPortId);
        const toPort = toComponent.ports.find(p => p.id === connection.toPortId);

        if (fromPort && toPort) {
          if (this.isometric.enabled) {
            // Use perspective-aware connection rendering with actual connection elevations
            this.renderConnectionPerspective(ctx, fromComponent, fromPort, toComponent, toPort, connection);
          } else {
            // Calculate world positions of ports
            const fromWorld = this.getPortWorldPosition(fromComponent, fromPort);
            const toWorld = this.getPortWorldPosition(toComponent, toPort);
            renderConnection(ctx, fromWorld, toWorld, fromComponent.fluid, this.view);
          }
        }
      }
    }

    // Draw port indicators if enabled
    if (this.showPorts) {
      this.renderPortIndicators(ctx);
    }

    // Draw flow connection arrows from simulation state (on top of components)
    if (this.simState) {
      // Pass port screen position getter for proper positioning in isometric mode
      const getPortScreenPos = this.isometric.enabled
        ? (comp: PlantComponent, port: { position: Point }) => this.getPortScreenPosition(comp, port)
        : undefined;
      // Pass connection endpoint getter that accounts for elevation offsets
      const getConnScreenPos = this.isometric.enabled
        ? (fromComp: PlantComponent, toComp: PlantComponent, conn: Connection) => this.getConnectionScreenEndpoints(fromComp, toComp, conn)
        : undefined;
      renderFlowConnectionArrows(ctx, this.simState, this.plantState, this.view, getPortScreenPos, getConnScreenPos);
    } else {
      // Debug: log once if simState is not set
      if (!this._simStateWarningLogged) {
        console.log('[Canvas] simState is null, skipping flow arrows');
        this._simStateWarningLogged = true;
      }
    }

    // Draw pressure gauges on flow nodes
    if (this.simState) {
      // Pass screen bounds getter function for proper gauge positioning
      const getScreenBounds = (comp: PlantComponent) => this.getComponentScreenBounds(comp);
      renderPressureGauge(ctx, this.simState, this.plantState, this.view, getScreenBounds);
    }

    // Draw color legend at bottom of canvas
    renderColorLegend(ctx, rect.width, rect.height);

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
        // Pump is drawn much larger than its diameter
        // Scale factor is diameter * 1.3, total height is scale * 2.2 (motor + coupling + casing + nozzle + inlet)
        // Width includes volute bulge and outlet pipe
        const pumpD = (component as any).diameter || 0.3;
        const pumpScale = pumpD * 1.3;
        const pumpHeight = pumpScale * 2.2;  // Full height including inlet pipe
        const pumpWidth = pumpScale * 1.5;   // Casing + volute + outlet
        return { width: pumpWidth, height: pumpHeight };
      case 'vessel':
        const vesselR = (component as any).innerDiameter / 2 + (component as any).wallThickness;
        return { width: vesselR * 2, height: (component as any).height };
      case 'reactorVessel':
        const rvR2 = (component as any).innerDiameter / 2 + (component as any).wallThickness;
        return { width: rvR2 * 2, height: (component as any).height };
      case 'coreBarrel':
        // Core barrel is the cylindrical region inside a reactor vessel
        const cbR = (component as any).innerDiameter / 2 + (component as any).thickness;
        return { width: cbR * 2, height: (component as any).height };
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
      case 'controller':
        return { width: (component as any).width || 1, height: (component as any).height || 1 };
      case 'switchyard':
        return { width: (component as any).width || 15, height: (component as any).height || 12 };
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
    connection: Connection
  ): void {
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

    // Check for internal connections (one component contained by the other, or siblings in the same container)
    // For these, we want the outer endpoint to stop partway inside, not at the edge
    const fromContainedBy = (fromComponent as any).containedBy;
    const toContainedBy = (toComponent as any).containedBy;

    let adjustedFromScreen = fromScreen.pos;
    let adjustedToScreen = toScreen.pos;

    // If fromComponent is contained by toComponent, adjust the "to" endpoint
    // to stop partway between the inner (from) edge and the outer (to) edge
    if (fromContainedBy === toComponent.id) {
      // Move the "to" endpoint only 10% of the way from "from" to "to"
      // This places it just barely past the inner component edge
      const t = 0.1;
      adjustedToScreen = {
        x: fromScreen.pos.x + t * (toScreen.pos.x - fromScreen.pos.x),
        y: fromScreen.pos.y + t * (toScreen.pos.y - fromScreen.pos.y)
      };
    }
    // If toComponent is contained by fromComponent, adjust the "from" endpoint
    else if (toContainedBy === fromComponent.id) {
      // Move the "from" endpoint only 10% of the way from "to" to "from"
      const t = 0.1;
      adjustedFromScreen = {
        x: toScreen.pos.x + t * (fromScreen.pos.x - toScreen.pos.x),
        y: toScreen.pos.y + t * (fromScreen.pos.y - toScreen.pos.y)
      };
    }
    // If both components are contained by the same parent (siblings inside a reactor vessel, etc.)
    // Draw a short connection between them - adjust both endpoints toward the midpoint
    else if (fromContainedBy && fromContainedBy === toContainedBy) {
      // Both are inside the same container - draw connection mostly in the middle
      // Move each endpoint 40% toward the midpoint
      const t = 0.4;
      const midX = (fromScreen.pos.x + toScreen.pos.x) / 2;
      const midY = (fromScreen.pos.y + toScreen.pos.y) / 2;
      adjustedFromScreen = {
        x: fromScreen.pos.x + t * (midX - fromScreen.pos.x),
        y: fromScreen.pos.y + t * (midY - fromScreen.pos.y)
      };
      adjustedToScreen = {
        x: toScreen.pos.x + t * (midX - toScreen.pos.x),
        y: toScreen.pos.y + t * (midY - toScreen.pos.y)
      };
    }

    // Get fluid color from the source component
    const fluid = (fromComponent as any).fluid;
    ctx.strokeStyle = fluid ? this.getFluidColorForConnection(fluid) : '#667788';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(adjustedFromScreen.x, adjustedFromScreen.y);

    // Simple curved connection in screen space
    const midX = (adjustedFromScreen.x + adjustedToScreen.x) / 2;
    const midY = (adjustedFromScreen.y + adjustedToScreen.y) / 2;
    ctx.quadraticCurveTo(midX, adjustedFromScreen.y, midX, midY);
    ctx.quadraticCurveTo(midX, adjustedToScreen.y, adjustedToScreen.x, adjustedToScreen.y);

    ctx.stroke();
  }

  // Get fluid color for connection rendering - uses same coloring as fluid nodes
  private getFluidColorForConnection(fluid: any): string {
    if (!fluid) return '#667788';

    // Use the standard fluid color function for consistency with node rendering
    // This ensures connections match the color of their source fluid
    return getFluidColor(fluid);
  }

  // Calculate connection screen endpoints accounting for elevation offsets
  // This matches the logic in renderConnectionPerspective for consistency
  private getConnectionScreenEndpoints(
    fromComponent: PlantComponent,
    toComponent: PlantComponent,
    connection: Connection
  ): ConnectionScreenEndpoints | null {
    // Find ports
    const fromPort = fromComponent.ports?.find(p => p.id === connection.fromPortId);
    const toPort = toComponent.ports?.find(p => p.id === connection.toPortId);
    if (!fromPort || !toPort) return null;

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
    const fromContainedBy = (fromComponent as any).containedBy;
    const toContainedBy = (toComponent as any).containedBy;

    if (fromContainedBy === toComponent.id) {
      const t = 0.1;
      toScreen = {
        x: fromScreen.x + t * (toScreen.x - fromScreen.x),
        y: fromScreen.y + t * (toScreen.y - fromScreen.y)
      };
    } else if (toContainedBy === fromComponent.id) {
      const t = 0.1;
      fromScreen = {
        x: toScreen.x + t * (fromScreen.x - toScreen.x),
        y: toScreen.y + t * (fromScreen.y - toScreen.y)
      };
    } else if (fromContainedBy && fromContainedBy === toContainedBy) {
      const t = 0.4;
      const midX = (fromScreen.x + toScreen.x) / 2;
      const midY = (fromScreen.y + toScreen.y) / 2;
      fromScreen = {
        x: fromScreen.x + t * (midX - fromScreen.x),
        y: fromScreen.y + t * (midY - fromScreen.y)
      };
      toScreen = {
        x: toScreen.x + t * (midX - toScreen.x),
        y: toScreen.y + t * (midY - toScreen.y)
      };
    }

    // Average scale for arrow sizing
    // The flow arrow code expects scale ~1.0 at normal viewing distance
    // For pipes, fromScale/toScale are raw projection scales (~1.0)
    // For non-pipes, they're projection scale * 50, so we need to normalize
    const fromNormalized = fromComponent.type === 'pipe' ? fromScale : fromScale / 50;
    const toNormalized = toComponent.type === 'pipe' ? toScale : toScale / 50;
    const avgScale = (fromNormalized + toNormalized) / 2;

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
    this._simStateWarningLogged = false; // Reset warning flag when state is set
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
