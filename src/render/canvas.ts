import { ViewState, Point, PlantState, PlantComponent } from '../types';
import { SimulationState } from '../simulation';
import { renderComponent, renderGrid, renderConnection, screenToWorld, worldToScreen, renderFlowConnectionArrows, renderPressureGauge } from './components';
import {
  IsometricConfig,
  DEFAULT_ISOMETRIC,
  renderIsometricGround,
  renderElevationLabel,
  getComponentElevation
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

  // Debug logging throttle and camera tracking
  private lastDebugLog: number = 0;
  private lastCameraX: number = 0;
  private lastCameraY: number = 0;
  private lastCameraDepth: number = 0;
  private loggedComponentIds: Set<string> = new Set();

  // Interaction state
  private isDragging: boolean = false;
  private dragStart: Point = { x: 0, y: 0 };
  private selectedComponentId: string | null = null;
  private hoveredComponentId: string | null = null;
  private moveMode: boolean = false;
  private isMovingComponent: boolean = false;

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
        const dx = (x - this.dragStart.x) / this.view.zoom;
        const dy = (y - this.dragStart.y) / this.view.zoom;
        component.position.x += dx;
        component.position.y += dy;
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
      // In isometric mode, scroll wheel moves camera forward/backward
      // Scroll up = move forward (decrease cameraDepth), scroll down = move backward
      const depthStep = 30;
      this.cameraDepth += e.deltaY > 0 ? depthStep : -depthStep;
      this.clampView();
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
    // Use perspective-aware conversion in isometric mode
    const worldPos = this.getWorldPositionFromScreen(screenPos);

    // Check components in reverse order (top-most first)
    const components = Array.from(this.plantState.components.values()).reverse();

    for (const component of components) {
      if (this.isPointInComponent(worldPos, component)) {
        return component;
      }
    }
    return null;
  }

  public getPortAtScreen(screenPos: Point): { component: PlantComponent, port: any, worldPos: Point } | null {
    const worldPos = screenToWorld(screenPos, this.view);

    // Check all components for nearby ports
    const components = Array.from(this.plantState.components.values());
    const portRadius = 0.3; // Detection radius in meters

    for (const component of components) {
      if (!component.ports) continue;

      for (const port of component.ports) {
        // Get port world position
        const portWorldPos = this.getPortWorldPosition(component, port);
        const distance = Math.hypot(
          worldPos.x - portWorldPos.x,
          worldPos.y - portWorldPos.y
        );

        if (distance <= portRadius) {
          return { component, port, worldPos: portWorldPos };
        }
      }
    }

    return null;
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

  // Perspective projection constants - must match shrub generation in isometric.ts
  private readonly CAMERA_HEIGHT = 50;
  private readonly PERSPECTIVE_X_SCALE = 50; // Controls both X position and size scaling
  private readonly ELEVATION_SCALE = 50; // Must match PERSPECTIVE_X_SCALE for consistent visual scale

  // Calculate screen position using same perspective projection as shrubs
  // worldPos: component's world position
  // elevation: component's height above ground (0 for ground-level objects)
  private worldToScreenPerspective(worldPos: Point, elevation: number = 0): { pos: Point, scale: number } {
    const rect = this.canvas.getBoundingClientRect();
    const horizonY = rect.height * 0.25;
    const groundHeight = rect.height - horizonY;
    const centerX = rect.width / 2;

    // Camera world position derived from view offsets (same as shrubs)
    const cameraWorldX = -(this.view.offsetX - centerX) / 10;
    const cameraWorldY = -this.cameraDepth / 10;

    // Position relative to camera
    const relX = worldPos.x - cameraWorldX;
    const relY = worldPos.y - cameraWorldY;

    // If behind camera or too close, return off-screen position
    if (relY < 1) {
      return { pos: { x: -1000, y: -1000 }, scale: 0 };
    }

    // Perspective projection (same formula as shrubs)
    const perspectiveScale = this.CAMERA_HEIGHT / relY;
    // Cap scale to match component rendering (prevents sliding when camera is very close)
    const cappedScale = Math.min(perspectiveScale, 3);
    const screenX = centerX + relX * cappedScale * this.PERSPECTIVE_X_SCALE;

    // Screen Y for ground level
    const groundScreenY = horizonY + groundHeight * this.CAMERA_HEIGHT / relY;

    // Elevation moves objects up on screen (subtract because Y increases downward)
    // Scale the elevation effect by perspective
    const elevationOffset = elevation * perspectiveScale * this.ELEVATION_SCALE;
    const screenY = groundScreenY - elevationOffset;

    return { pos: { x: screenX, y: screenY }, scale: perspectiveScale };
  }

  // Inverse perspective projection: convert screen coordinates to world coordinates
  // Used for component placement in isometric mode
  private screenToWorldPerspective(screenPos: Point): Point {
    const rect = this.canvas.getBoundingClientRect();
    const horizonY = rect.height * 0.25;
    const groundHeight = rect.height - horizonY;
    const centerX = rect.width / 2;

    // Camera world position
    const cameraWorldX = -(this.view.offsetX - centerX) / 10;
    const cameraWorldY = -this.cameraDepth / 10;

    // Inverse of: screenY = horizonY + groundHeight * cameraHeight / relY
    // Solve for relY: relY = groundHeight * cameraHeight / (screenY - horizonY)
    const screenYFromHorizon = screenPos.y - horizonY;
    if (screenYFromHorizon <= 0) {
      // Click is at or above horizon - place far away
      return { x: cameraWorldX, y: cameraWorldY + 1000 };
    }

    const relY = groundHeight * this.CAMERA_HEIGHT / screenYFromHorizon;

    // Now we know relY, we can find perspectiveScale and solve for relX
    const perspectiveScale = this.CAMERA_HEIGHT / relY;
    // Inverse of: screenX = centerX + relX * perspectiveScale * PERSPECTIVE_X_SCALE
    const relX = (screenPos.x - centerX) / (perspectiveScale * this.PERSPECTIVE_X_SCALE);

    // Convert from camera-relative to world coordinates
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
      renderIsometricGround(ctx, this.view, rect.width, rect.height, this.isometric, this.cameraDepth);
    } else {
      renderGrid(ctx, this.view, rect.width, rect.height);
    }

    // Sort components by depth for proper layering in isometric view
    // Larger Y = further from camera = draw first (behind)
    // Smaller Y = closer to camera = draw last (in front)
    const sortedComponents = Array.from(this.plantState.components.values()).sort((a, b) => {
      if (!this.isometric.enabled) return 0;
      // Sort by Y descending (further objects first), then by elevation
      return (b.position.y - a.position.y);
    });

    // Draw shadows first (if isometric)
    // Shadow corners are calculated in world space and projected to screen
    // This ensures shadows follow the ground plane correctly with perspective
    if (this.isometric.enabled) {
      // Debug: find a reference shrub position for comparison
      const rect = this.canvas.getBoundingClientRect();
      const horizonY = rect.height * 0.25;
      const groundHeight = rect.height - horizonY;
      const centerX = rect.width / 2;
      const cameraWorldX = -(this.view.offsetX - centerX) / 10;
      const cameraWorldY = -this.cameraDepth / 10;

      // Reference shrub at a fixed world position for debugging
      const refShrubWorld = { x: 0, y: 100 }; // Fixed world position
      const refShrubRelX = refShrubWorld.x - cameraWorldX;
      const refShrubRelY = refShrubWorld.y - cameraWorldY;
      let refShrubScreen = { x: 0, y: 0 };
      if (refShrubRelY > 1) {
        const shrubPerspectiveScale = this.CAMERA_HEIGHT / refShrubRelY;
        const shrubCappedScale = Math.min(shrubPerspectiveScale, 3);
        refShrubScreen = {
          x: centerX + refShrubRelX * shrubCappedScale * this.PERSPECTIVE_X_SCALE,
          y: horizonY + groundHeight * this.CAMERA_HEIGHT / refShrubRelY
        };
      }

      for (const component of sortedComponents) {
        try {
          const size = this.getComponentSize(component);
          const worldWidth = size.width || 1;
          const worldHeight = size.height || 1;

          // Calculate component center in world coordinates
          // Most components are centered on their position, but pipes start at position
          let centerWorldX = component.position.x;
          let centerWorldY = component.position.y;
          if (component.type === 'pipe') {
            const halfLength = (component as any).length / 2;
            centerWorldX += halfLength * Math.cos(component.rotation);
            centerWorldY += halfLength * Math.sin(component.rotation);
          }

          // Shadow extent in world units (45-degree sun angle, sun behind-left)
          // Shadow extends toward camera (-Y) and to the right (+X)
          const shadowExtent = worldHeight;

          // Calculate shadow corners in world coordinates
          const halfWidth = worldWidth / 2;

          // Shadow starts at component's front edge (toward camera, lower Y)
          // and extends further toward camera
          const frontEdgeY = centerWorldY - halfWidth;

          // Top edge (at component's front edge)
          const topLeftWorld = { x: centerWorldX - halfWidth, y: frontEdgeY };
          const topRightWorld = { x: centerWorldX + halfWidth, y: frontEdgeY };

          // Bottom edge (shadow extends forward toward camera and right)
          const bottomLeftWorld = { x: centerWorldX - halfWidth + shadowExtent, y: frontEdgeY - shadowExtent };
          const bottomRightWorld = { x: centerWorldX + halfWidth + shadowExtent, y: frontEdgeY - shadowExtent };

          // Project all four corners to screen space (on ground, elevation 0)
          const topLeft = this.worldToScreenPerspective(topLeftWorld, 0);
          const topRight = this.worldToScreenPerspective(topRightWorld, 0);
          const bottomLeft = this.worldToScreenPerspective(bottomLeftWorld, 0);
          const bottomRight = this.worldToScreenPerspective(bottomRightWorld, 0);

          // Skip if any corner is behind camera
          if (topLeft.scale <= 0 || topRight.scale <= 0 ||
              bottomLeft.scale <= 0 || bottomRight.scale <= 0) continue;

          // Debug logging: on component creation or camera move (throttled)
          const now = Date.now();
          const isNewComponent = !this.loggedComponentIds.has(component.id);
          const cameraMoved = Math.abs(cameraWorldX - this.lastCameraX) > 0.1 ||
                              Math.abs(cameraWorldY - this.lastCameraY) > 0.1 ||
                              Math.abs(this.cameraDepth - this.lastCameraDepth) > 0.1;
          const canLog = now - this.lastDebugLog > 1000;

          if (isNewComponent || (cameraMoved && canLog)) {
            if (isNewComponent) {
              this.loggedComponentIds.add(component.id);
              console.log('=== NEW COMPONENT CREATED ===');
            } else {
              console.log('=== CAMERA MOVED ===');
            }
            this.lastDebugLog = now;
            this.lastCameraX = cameraWorldX;
            this.lastCameraY = cameraWorldY;
            this.lastCameraDepth = this.cameraDepth;

            const elevation = getComponentElevation(component);
            const compScreen = this.worldToScreenPerspective(component.position, elevation);
            console.log(`Component ${component.type} (${component.id}): world(${component.position.x.toFixed(1)}, ${component.position.y.toFixed(1)}, z=${elevation})`);
            console.log(`  Component screen: (${compScreen.pos.x.toFixed(1)}, ${compScreen.pos.y.toFixed(1)}), scale=${compScreen.scale.toFixed(3)}`);
            console.log(`Shadow corners (world):`);
            console.log(`  topLeft: (${topLeftWorld.x.toFixed(1)}, ${topLeftWorld.y.toFixed(1)})`);
            console.log(`  topRight: (${topRightWorld.x.toFixed(1)}, ${topRightWorld.y.toFixed(1)})`);
            console.log(`Shadow corners (screen):`);
            console.log(`  topLeft: (${topLeft.pos.x.toFixed(1)}, ${topLeft.pos.y.toFixed(1)})`);
            console.log(`  topRight: (${topRight.pos.x.toFixed(1)}, ${topRight.pos.y.toFixed(1)})`);
            console.log(`Reference shrub at world(${refShrubWorld.x}, ${refShrubWorld.y}):`);
            console.log(`  screen: (${refShrubScreen.x.toFixed(1)}, ${refShrubScreen.y.toFixed(1)})`);
            console.log(`Camera: worldX=${cameraWorldX.toFixed(1)}, worldY=${cameraWorldY.toFixed(1)}, depth=${this.cameraDepth}`);
          }

          ctx.save();

          // Draw shadow as parallelogram
          ctx.globalAlpha = 0.4;
          ctx.fillStyle = 'rgba(20, 15, 10, 1)';
          ctx.beginPath();
          ctx.moveTo(topLeft.pos.x, topLeft.pos.y);
          ctx.lineTo(topRight.pos.x, topRight.pos.y);
          ctx.lineTo(bottomRight.pos.x, bottomRight.pos.y);
          ctx.lineTo(bottomLeft.pos.x, bottomLeft.pos.y);
          ctx.closePath();
          ctx.fill();

          ctx.restore();
        } catch (e) {
          console.error('Shadow rendering error:', e);
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
          // Calculate world positions of ports
          const fromWorld = this.getPortWorldPosition(fromComponent, fromPort);
          const toWorld = this.getPortWorldPosition(toComponent, toPort);
          renderConnection(ctx, fromWorld, toWorld, fromComponent.fluid, this.view);
        }
      }
    }

    // Draw components with perspective projection
    // Use same perspective scale for both position and size to ensure components
    // are fixed to the ground plane like shrubs
    for (const component of sortedComponents) {
      ctx.save();

      // Apply perspective projection if in isometric mode
      if (this.isometric.enabled) {
        const elevation = getComponentElevation(component);
        const { pos: screenPos, scale } = this.worldToScreenPerspective(component.position, elevation);

        // Skip if behind camera or too small
        if (scale <= 0 || scale < 0.05) {
          ctx.restore();
          continue;
        }

        // Cap scale to prevent huge components when camera is very close
        const cappedScale = Math.min(scale, 3);

        // Use PERSPECTIVE_X_SCALE for both position and size for consistent ground plane
        // Pass the scale through view.zoom so line widths stay proportional
        const componentZoom = cappedScale * this.PERSPECTIVE_X_SCALE;

        ctx.translate(screenPos.x, screenPos.y);
        ctx.rotate(component.rotation);

        // Render with calculated zoom - this scales component dimensions while keeping
        // line widths in reasonable pixel sizes (since we're not using ctx.scale)
        // Skip ports here - they're rendered separately with proper perspective scaling
        const isometricView: ViewState = { ...this.view, zoom: componentZoom };
        const isSelected = component.id === this.selectedComponentId;
        renderComponent(ctx, component, isometricView, isSelected, true);

        // Render elevation label
        renderElevationLabel(ctx, component, isometricView, this.isometric);
      } else {
        const screenPos = worldToScreen(component.position, this.view);
        ctx.translate(screenPos.x, screenPos.y);
        ctx.rotate(component.rotation);

        // Render the component
        const isSelected = component.id === this.selectedComponentId;
        renderComponent(ctx, component, this.view, isSelected);
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
      case 'valve':
        const valveD = (component as any).diameter || 0.2;
        return { width: valveD * 2, height: valveD * 2 };
      case 'heatExchanger':
        return { width: (component as any).width, height: (component as any).height };
      case 'turbine':
        return { width: (component as any).width || 1.5, height: (component as any).height || 1.2 };
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
          // Calculate port position using same method as component rendering
          const elevation = getComponentElevation(component);
          const { pos: compScreenPos, scale } = this.worldToScreenPerspective(component.position, elevation);
          if (scale <= 0) continue;

          const cappedScale = Math.min(scale, 3);
          const componentZoom = cappedScale * this.PERSPECTIVE_X_SCALE;

          // Transform port's local position to screen space
          // (same as component rendering: translate to compScreenPos, rotate, scale by zoom)
          const cos = Math.cos(component.rotation);
          const sin = Math.sin(component.rotation);
          const localX = port.position.x * componentZoom;
          const localY = port.position.y * componentZoom;
          const rotatedX = localX * cos - localY * sin;
          const rotatedY = localX * sin + localY * cos;

          screenPos = {
            x: compScreenPos.x + rotatedX,
            y: compScreenPos.y + rotatedY
          };

          // Port radius ~0.4 meters (40cm) in world units
          portRadius = Math.max(4, 0.4 * componentZoom);
          lineWidth = Math.max(1, 0.1 * componentZoom);
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
