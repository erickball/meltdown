import { ViewState, Point, PlantState, PlantComponent } from '../types';
import { SimulationState } from '../simulation';
import { renderComponent, renderGrid, renderConnection, screenToWorld, worldToScreen, renderFlowConnectionArrows, renderPressureGauge } from './components';
import {
  IsometricConfig,
  DEFAULT_ISOMETRIC,
  projectIsometric,
  renderIsometricGround,
  renderComponentShadow,
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

    // Resize
    window.addEventListener('resize', this.resize.bind(this));
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
      this.view.offsetX += dx;
      this.view.offsetY += dy;
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
      this.view.offsetX += dx;
      this.view.offsetY += dy;
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
    const worldPos = screenToWorld(screenPos, this.view);

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

  public render(): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();

    // Clear
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Draw background - either grid or isometric ground
    if (this.isometric.enabled) {
      renderIsometricGround(ctx, this.view, rect.width, rect.height, this.isometric);
    } else {
      renderGrid(ctx, this.view, rect.width, rect.height);
    }

    // Sort components by elevation for proper layering in isometric view
    const sortedComponents = Array.from(this.plantState.components.values()).sort((a, b) => {
      if (!this.isometric.enabled) return 0;
      const elevA = getComponentElevation(a);
      const elevB = getComponentElevation(b);
      // Also consider Y position for depth sorting
      return (a.position.y - b.position.y) + (elevA - elevB) * 0.1;
    });

    // Draw shadows first (if isometric)
    if (this.isometric.enabled) {
      for (const component of sortedComponents) {
        ctx.save();
        const pos3D = {
          x: component.position.x,
          y: component.position.y,
          z: getComponentElevation(component)
        };
        const projectedPos = projectIsometric(pos3D, this.isometric);
        const screenPos = worldToScreen(projectedPos, this.view);
        ctx.translate(screenPos.x, screenPos.y);
        ctx.rotate(component.rotation);
        renderComponentShadow(ctx, component, this.view, this.isometric);
        ctx.restore();
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

    // Draw components with isometric projection
    for (const component of sortedComponents) {
      ctx.save();

      // Apply isometric projection if enabled
      if (this.isometric.enabled) {
        const pos3D = {
          x: component.position.x,
          y: component.position.y,
          z: getComponentElevation(component)
        };
        const projectedPos = projectIsometric(pos3D, this.isometric);
        const screenPos = worldToScreen(projectedPos, this.view);
        ctx.translate(screenPos.x, screenPos.y);
      } else {
        const screenPos = worldToScreen(component.position, this.view);
        ctx.translate(screenPos.x, screenPos.y);
      }

      ctx.rotate(component.rotation);

      // Render the component
      const isSelected = component.id === this.selectedComponentId;
      renderComponent(ctx, component, this.view, isSelected);

      // Render elevation label if in isometric mode
      if (this.isometric.enabled) {
        renderElevationLabel(ctx, component, this.view, this.isometric);
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

  private renderPortIndicators(ctx: CanvasRenderingContext2D): void {
    for (const component of this.plantState.components.values()) {
      if (!component.ports) continue;

      for (const port of component.ports) {
        const worldPos = this.getPortWorldPosition(component, port);
        const screenPos = worldToScreen(worldPos, this.view);

        // Check if this port is highlighted
        const isHighlighted = this.highlightedPort &&
          this.highlightedPort.componentId === component.id &&
          this.highlightedPort.portId === port.id;

        // Draw port circle
        ctx.beginPath();
        ctx.arc(screenPos.x, screenPos.y, isHighlighted ? 12 : 8, 0, Math.PI * 2);

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
        ctx.lineWidth = isHighlighted ? 3 : 2;
        ctx.stroke();

        // Add pulsing effect for highlighted port
        if (isHighlighted) {
          ctx.beginPath();
          ctx.arc(screenPos.x, screenPos.y, 16 + Math.sin(Date.now() * 0.003) * 3, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 100, 0.5)';
          ctx.lineWidth = 2;
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
    this.isometric.enabled = enabled;
  }

  public toggleIsometric(): void {
    this.isometric.enabled = !this.isometric.enabled;
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
