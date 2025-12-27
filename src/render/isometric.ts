import { Point, ViewState, PlantComponent } from '../types';

// Isometric configuration
export interface IsometricConfig {
  enabled: boolean;
  angleX: number; // Rotation around X axis (tilt), typically 30-35 degrees
  angleZ: number; // Rotation around Z axis (pan), typically 45 degrees
  elevationScale: number; // How much to scale elevation visually
}

// Default isometric view settings
export const DEFAULT_ISOMETRIC: IsometricConfig = {
  enabled: false,  // Start with normal view
  angleX: 30 * Math.PI / 180, // 30 degrees tilt
  angleZ: 0, // No rotation for now, keeping X as horizontal
  elevationScale: 1.0
};

/**
 * Convert 3D world coordinates to 2D isometric screen projection
 * @param point3D - Point with x, y (horizontal), z (elevation)
 * @param config - Isometric projection settings
 */
export function projectIsometric(point3D: Point & { z?: number }, config: IsometricConfig): Point {
  if (!config.enabled) {
    return { x: point3D.x, y: point3D.y };
  }

  const z = (point3D.z || 0) * config.elevationScale;

  // Simple isometric projection
  // Keep X as horizontal, Y as depth (going into screen), Z as vertical
  // The view is tilted down by angleX degrees
  const screenX = point3D.x;
  const screenY = point3D.y * Math.cos(config.angleX) - z * Math.sin(config.angleX);

  return { x: screenX, y: screenY };
}

/**
 * Calculate shadow offset based on elevation
 * The shadow is cast from a sun position (upper-left), so shadows go down-right
 * @param elevation - Height in meters
 * @param config - Isometric configuration
 * @returns offset in world units (meters)
 */
export function getShadowOffset(elevation: number, config: IsometricConfig): Point {
  if (!config.enabled || elevation <= 0) {
    return { x: 0, y: 0 };
  }

  // Sun angle from upper-left: shadows extend to lower-right
  // Shadow length is proportional to elevation (taller = longer shadow)
  const shadowLengthFactor = 0.8; // How long shadows are relative to height
  const shadowLength = elevation * shadowLengthFactor;

  // Shadow goes to the right (+X) and "into the screen" (+Y in our coordinate system)
  return {
    x: shadowLength * 0.7,  // Right
    y: shadowLength * 0.5   // Forward (into screen/ground plane)
  };
}

/**
 * Get component elevation from its properties
 */
export function getComponentElevation(component: PlantComponent): number {
  // Check for explicit elevation property
  if ('elevation' in component && typeof component.elevation === 'number') {
    return component.elevation;
  }

  // Default elevations by type
  switch (component.type) {
    case 'pump':
      return 0; // Pumps typically at ground level
    case 'condenser':
      return -2; // Condensers often below grade
    case 'turbine':
      return 2; // Turbines on elevated deck
    case 'vessel':
      return 0; // Reactor vessel at grade
    default:
      return 0;
  }
}

/**
 * Render desert landscape ground for isometric view
 */
export function renderIsometricGround(
  ctx: CanvasRenderingContext2D,
  view: ViewState,
  width: number,
  height: number,
  config: IsometricConfig,
  cameraDepth: number = 0
): void {
  if (!config.enabled) {
    return;
  }

  // Desert sand gradient - warm sandy colors
  const gradient = ctx.createLinearGradient(0, height * 0.2, 0, height);
  gradient.addColorStop(0, '#e8d4a0');  // Light sand far away
  gradient.addColorStop(0.3, '#d9c590');  // Mid sand
  gradient.addColorStop(0.6, '#c9b580');  // Darker sand
  gradient.addColorStop(1, '#b9a570');  // Closest sand

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Add subtle sand dune shading
  const duneGradient = ctx.createRadialGradient(
    width * 0.7, height * 0.8, 50,
    width * 0.7, height * 0.8, 300
  );
  duneGradient.addColorStop(0, 'rgba(180, 150, 100, 0.2)');
  duneGradient.addColorStop(1, 'rgba(180, 150, 100, 0)');
  ctx.fillStyle = duneGradient;
  ctx.fillRect(0, 0, width, height);

  // Draw scattered shrubs/cacti with isometric projection
  const shrubPositions = generateShrubPositions(view, width, height, config, cameraDepth);

  for (const shrub of shrubPositions) {
    drawDesertShrub(ctx, shrub.x, shrub.y, shrub.size, shrub.type);
  }

  // Add distant mountains on horizon
  const horizonY = height * 0.25;
  ctx.fillStyle = 'rgba(150, 140, 120, 0.3)';
  ctx.beginPath();
  ctx.moveTo(0, horizonY);

  // Create jagged mountain silhouette
  const mountainPoints = [
    { x: width * 0.1, y: horizonY - 40 },
    { x: width * 0.15, y: horizonY - 60 },
    { x: width * 0.2, y: horizonY - 45 },
    { x: width * 0.3, y: horizonY - 70 },
    { x: width * 0.35, y: horizonY - 55 },
    { x: width * 0.5, y: horizonY - 80 },
    { x: width * 0.6, y: horizonY - 50 },
    { x: width * 0.7, y: horizonY - 65 },
    { x: width * 0.8, y: horizonY - 40 },
    { x: width * 0.9, y: horizonY - 55 },
    { x: width, y: horizonY - 30 }
  ];

  for (const point of mountainPoints) {
    ctx.lineTo(point.x, point.y);
  }
  ctx.lineTo(width, horizonY);
  ctx.closePath();
  ctx.fill();

  // Sky gradient
  const skyGradient = ctx.createLinearGradient(0, 0, 0, horizonY);
  skyGradient.addColorStop(0, '#a8c8e8');  // Light blue sky
  skyGradient.addColorStop(1, '#d8e8f0');  // Fade to white at horizon
  ctx.fillStyle = skyGradient;
  ctx.fillRect(0, 0, width, horizonY);
}

// Deterministic random from seed
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// Generate shrubs on a perspective ground plane with infinite tiling
// Shrubs are placed at fixed world positions and move with parallax when camera moves
function generateShrubPositions(view: ViewState, width: number, height: number, _config: IsometricConfig, cameraDepth: number): any[] {
  const shrubs: { x: number; y: number; size: number; type: string }[] = [];

  // Screen geometry
  const horizonY = height * 0.25;
  const groundHeight = height - horizonY;
  const centerX = width / 2;

  // World-space cell size for shrub placement
  const cellSize = 80;

  // Camera world position derived from view offsets
  const cameraWorldX = -(view.offsetX - centerX) / 10;
  const cameraWorldY = -cameraDepth / 10;

  // Camera height above ground (affects how close objects pass "under" us)
  // Higher value = objects pass under camera sooner
  const cameraHeight = 50;

  // Visible range - use different ranges for X and Y for performance
  const visibleRangeX = 400;
  const visibleRangeY = 1500; // Further in Y direction to fill to horizon

  const startCellX = Math.floor((cameraWorldX - visibleRangeX) / cellSize);
  const endCellX = Math.ceil((cameraWorldX + visibleRangeX) / cellSize);
  const startCellY = Math.floor(cameraWorldY / cellSize); // Only ahead of camera
  const endCellY = Math.ceil((cameraWorldY + visibleRangeY) / cellSize);

  for (let cellX = startCellX; cellX <= endCellX; cellX++) {
    for (let cellY = startCellY; cellY <= endCellY; cellY++) {
      // Deterministic seed from cell position
      const cellSeed = Math.abs(cellX * 73856093 + cellY * 19349663);

      // Only ~30% of cells have a shrub
      if (seededRandom(cellSeed) > 0.30) continue;

      // World position of this shrub (fixed)
      const worldX = cellX * cellSize + seededRandom(cellSeed + 1) * cellSize * 0.8;
      const worldY = cellY * cellSize + seededRandom(cellSeed + 2) * cellSize * 0.8;

      // Position relative to camera
      const relX = worldX - cameraWorldX;
      const relY = worldY - cameraWorldY;

      // Skip if behind camera or too far
      if (relY < 1 || relY > visibleRangeY) continue;

      // Perspective projection with camera height
      // PERSPECTIVE_X_SCALE = 50 (must match canvas.ts)
      const perspectiveScale = cameraHeight / relY;
      // Cap scale to match component rendering (prevents sliding when camera is very close)
      const cappedScale = Math.min(perspectiveScale, 3);
      const screenX = centerX + relX * cappedScale * 50;

      // Screen Y: objects at distance = cameraHeight are at bottom of screen
      // Objects closer than cameraHeight pass off the bottom (under camera)
      // Objects further away approach the horizon
      const screenY = horizonY + groundHeight * cameraHeight / relY;

      // Skip if off-screen
      if (screenX < -50 || screenX > width + 50) continue;
      if (screenY < horizonY - 10 || screenY > height + 100) continue;

      // Size based on distance (perspective)
      // Use same capped scale as X position for consistent ground plane
      // baseSize in world units (meters): 0.3 to 0.8 meters for desert shrubs
      const baseSize = 0.3 + seededRandom(cellSeed + 3) * 0.5;
      const size = baseSize * cappedScale * 50;

      // Skip shrubs that are too tiny to see
      if (size < 1.5) continue;

      const type = seededRandom(cellSeed + 4) > 0.5 ? 'cactus' : 'shrub';

      shrubs.push({ x: screenX, y: screenY, size, type });
    }
  }

  // Sort by Y position so distant shrubs are drawn first
  shrubs.sort((a, b) => a.y - b.y);

  return shrubs;
}

// Draw a desert plant
function drawDesertShrub(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, type: string): void {
  ctx.save();
  ctx.translate(x, y);

  if (type === 'cactus') {
    // Draw simple cactus
    ctx.fillStyle = '#5a7050';
    ctx.fillRect(-size/6, -size, size/3, size);
    ctx.fillRect(-size/2, -size/2, size/6, size/3);
    ctx.fillRect(size/3, -size/3, size/6, size/4);

    // Add cactus highlights
    ctx.fillStyle = '#6a8060';
    ctx.fillRect(-size/8, -size, size/12, size * 0.8);
  } else {
    // Draw desert shrub
    ctx.fillStyle = '#7a7050';
    ctx.beginPath();
    ctx.arc(0, 0, size/2, 0, Math.PI * 2);
    ctx.fill();

    // Add some texture
    ctx.fillStyle = '#8a8060';
    ctx.beginPath();
    ctx.arc(-size/4, -size/4, size/3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Add small shadow
  ctx.fillStyle = 'rgba(100, 80, 60, 0.3)';
  ctx.beginPath();
  ctx.ellipse(0, size/4, size/2, size/6, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/**
 * Render component shadow on the ground plane
 * This should be called with the canvas in its default state (not translated to component position)
 */
export function renderComponentShadow(
  ctx: CanvasRenderingContext2D,
  component: PlantComponent,
  view: ViewState,
  config: IsometricConfig
): void {
  if (!config.enabled) return;

  const elevation = getComponentElevation(component);
  if (elevation <= 0) return;

  const shadowOffset = getShadowOffset(elevation, config);

  // Calculate shadow position on the ground (z=0)
  // The shadow falls at the component's X,Y plus the shadow offset
  const shadowWorldPos = {
    x: component.position.x + shadowOffset.x,
    y: component.position.y + shadowOffset.y
  };

  // Project the ground-level shadow position to screen
  const groundPos = projectIsometric({ ...shadowWorldPos, z: 0 }, config);
  const screenPos = {
    x: groundPos.x * view.zoom + view.offsetX,
    y: groundPos.y * view.zoom + view.offsetY
  };

  ctx.save();
  ctx.translate(screenPos.x, screenPos.y);
  ctx.rotate(component.rotation);

  // Squash the shadow vertically to appear flat on the ground
  // The squash factor comes from the isometric angle
  const squashFactor = Math.cos(config.angleX);
  ctx.scale(1, squashFactor);

  // Make shadow semi-transparent - higher elevations cast more defined shadows
  ctx.globalAlpha = 0.25 + 0.1 * Math.min(1, elevation / 5);
  ctx.fillStyle = 'rgba(50, 40, 30, 1)'; // Brownish shadow for desert

  // Draw shadow shape based on component type
  switch (component.type) {
    case 'tank': {
      const tank = component as any;
      const w = tank.width * view.zoom;
      const h = tank.height * view.zoom;
      // Draw as ellipse for more natural ground shadow
      ctx.beginPath();
      ctx.ellipse(0, 0, w/2, h/2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'pipe': {
      const pipe = component as any;
      const length = pipe.length * view.zoom;
      const diameter = pipe.diameter * view.zoom;
      // Rounded rect shadow
      ctx.beginPath();
      ctx.ellipse(length/2, 0, length/2 + diameter/2, diameter, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'pump': {
      const pump = component as any;
      const r = pump.diameter * view.zoom / 2;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.1, 0, Math.PI * 2); // Slightly larger
      ctx.fill();
      break;
    }
    case 'vessel': {
      const vessel = component as any;
      const r = (vessel.innerDiameter / 2 + vessel.wallThickness) * view.zoom;
      const h = vessel.height * view.zoom;
      // Ellipse for vessel shadow
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.1, h/2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'heatExchanger': {
      const hx = component as any;
      const w = hx.width * view.zoom;
      const h = hx.height * view.zoom;
      ctx.beginPath();
      ctx.ellipse(0, 0, w/2, h/2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'turbine': {
      // Turbine is typically large
      const size = 3 * view.zoom; // Approximate size
      ctx.beginPath();
      ctx.ellipse(0, 0, size, size * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'condenser': {
      const size = 4 * view.zoom;
      ctx.beginPath();
      ctx.ellipse(0, 0, size, size * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    default: {
      // Generic small shadow
      const size = 1 * view.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

/**
 * Render elevation indicator label
 */
export function renderElevationLabel(
  ctx: CanvasRenderingContext2D,
  component: PlantComponent,
  _view: ViewState,
  _config: IsometricConfig
): void {
  const elevation = getComponentElevation(component);
  if (elevation === 0) return; // Don't show label for ground level

  // Position label above component
  const bounds = getComponentBounds(component);
  const labelX = 0;
  const labelY = -bounds.height / 2 - 20;

  ctx.save();

  // White text with dark outline for visibility
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  const elevText = elevation > 0 ? `+${elevation.toFixed(1)}m` : `${elevation.toFixed(1)}m`;

  // Draw outline
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  ctx.strokeText(elevText, labelX, labelY);

  // Draw text
  ctx.fillStyle = elevation > 0 ? '#8f8' : '#f88';
  ctx.fillText(elevText, labelX, labelY);

  ctx.restore();
}

// Helper to get component bounds for shadow/label positioning
function getComponentBounds(component: PlantComponent): { width: number, height: number } {
  switch (component.type) {
    case 'tank':
      return { width: (component as any).width, height: (component as any).height };
    case 'pipe':
      return { width: (component as any).length, height: (component as any).diameter };
    case 'pump':
      const d = (component as any).diameter;
      return { width: d, height: d };
    case 'vessel':
      const r = (component as any).innerDiameter / 2 + (component as any).wallThickness;
      return { width: r * 2, height: (component as any).height };
    default:
      return { width: 2, height: 2 };
  }
}