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
 * @param elevation - Height in meters
 * @param config - Isometric configuration
 */
export function getShadowOffset(elevation: number, config: IsometricConfig): Point {
  if (!config.enabled || elevation <= 0) {
    return { x: 0, y: 0 };
  }

  // Shadow cast down and to the right
  const shadowAngle = 45 * Math.PI / 180;
  const shadowLength = elevation * config.elevationScale * 0.3; // Shadow length proportional to height

  return {
    x: Math.cos(shadowAngle) * shadowLength,
    y: Math.sin(shadowAngle) * shadowLength + elevation * config.elevationScale * Math.sin(config.angleX)
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
  config: IsometricConfig
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

  // Draw scattered shrubs/cacti
  const shrubPositions = generateShrubPositions(view, width, height);

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

// Generate consistent shrub positions based on view
function generateShrubPositions(view: ViewState, width: number, height: number): any[] {
  const shrubs = [];
  const seed = Math.floor(view.offsetX / 100) * 1000 + Math.floor(view.offsetY / 100);
  const random = (n: number) => {
    const x = Math.sin(seed + n * 137.5) * 10000;
    return x - Math.floor(x);
  };

  // Generate 10-20 shrubs
  const numShrubs = 10 + Math.floor(random(0) * 10);

  for (let i = 0; i < numShrubs; i++) {
    const x = random(i * 2) * width;
    const y = height * 0.4 + random(i * 2 + 1) * height * 0.6;
    const size = 10 + random(i * 3) * 20;
    const type = random(i * 4) > 0.5 ? 'cactus' : 'shrub';

    shrubs.push({ x, y, size, type });
  }

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
 * Render component shadow
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

  ctx.save();

  // Move to shadow position
  ctx.translate(shadowOffset.x * view.zoom, shadowOffset.y * view.zoom);

  // Make shadow semi-transparent and dark
  ctx.globalAlpha = 0.3 * Math.min(1, elevation / 10); // Fade with distance
  ctx.fillStyle = '#000000';

  // Draw shadow shape based on component type
  switch (component.type) {
    case 'tank': {
      const tank = component as any;
      const w = tank.width * view.zoom;
      const h = tank.height * view.zoom;
      ctx.fillRect(-w/2, -h/2, w, h);
      break;
    }
    case 'pipe': {
      const pipe = component as any;
      const length = pipe.length * view.zoom;
      const diameter = pipe.diameter * view.zoom;
      ctx.fillRect(0, -diameter/2, length, diameter);
      break;
    }
    case 'pump': {
      const pump = component as any;
      const r = pump.diameter * view.zoom / 2;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'vessel': {
      const vessel = component as any;
      const r = (vessel.innerDiameter / 2 + vessel.wallThickness) * view.zoom;
      const h = vessel.height * view.zoom;
      ctx.fillRect(-r, -h/2, r*2, h);
      break;
    }
    // Add more component types as needed
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