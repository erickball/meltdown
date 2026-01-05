import {
  PlantComponent,
  TankComponent,
  PipeComponent,
  PumpComponent,
  VesselComponent,
  ReactorVesselComponent,
  CoreBarrelComponent,
  ValveComponent,
  HeatExchangerComponent,
  TurbineGeneratorComponent,
  TurbineDrivenPumpComponent,
  CondenserComponent,
  ControllerComponent,
  SwitchyardComponent,
  ViewState,
  Fluid,
  Point,
  PlantState,
  Connection,
} from '../types';
import { SimulationState, getTurbineCondenserState } from '../simulation';
import { getFluidColor, getTwoPhaseColors, getFuelColor, rgbToString, COLORS, massQualityToVolumeFraction, getSaturationTemp } from './colors';

/**
 * Calculate wall thickness from pressure rating using ASME pressure vessel formula.
 * t = P*R / (S*E - 0.6*P)
 * where:
 *   P = design pressure (Pa)
 *   R = inner radius (m)
 *   S = allowable stress (Pa) - using SA-533 Grade B Class 1 at ~320°C = 172 MPa
 *   E = joint efficiency (1.0 for full radiograph)
 *
 * Returns minimum 2mm wall thickness.
 */
export function calculateWallThicknessFromPressure(pressureBar: number, innerDiameterM: number): number {
  const P = pressureBar * 1e5; // bar to Pa
  const R = innerDiameterM / 2; // radius in meters
  const S = 172e6; // Pa - SA-533 Grade B Class 1 allowable stress
  const E = 1.0; // Joint efficiency

  // ASME formula for cylindrical shells
  const thickness = P * R / (S * E - 0.6 * P);

  // Minimum 2mm wall thickness
  return Math.max(0.002, thickness);
}

/**
 * Calculate pipe wall thickness from pressure rating.
 * Uses Barlow's formula: t = P*D / (2*S*E)
 * For pipes, we use a lower allowable stress (carbon steel SA-106)
 */
export function calculatePipeThicknessFromPressure(pressureBar: number, outerDiameterM: number): number {
  const P = pressureBar * 1e5; // bar to Pa
  const D = outerDiameterM; // outer diameter in meters
  const S = 138e6; // Pa - SA-106 Grade B allowable stress at elevated temp
  const E = 1.0; // Joint efficiency

  // Barlow's formula
  const thickness = P * D / (2 * S * E);

  // Minimum 2mm wall thickness
  return Math.max(0.002, thickness);
}

// Convert world coordinates (meters) to screen coordinates (pixels)
export function worldToScreen(point: Point, view: ViewState): Point {
  return {
    x: point.x * view.zoom + view.offsetX,
    y: point.y * view.zoom + view.offsetY,
  };
}

// Seeded random for consistent pixelation pattern
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

// Time seed that updates every second for animated two-phase effect
function getTimeSeed(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Render two-phase fluid with pixelated droplet/bubble effect
 * Creates a pattern where liquid and vapor pixels are distributed based on quality
 * Pattern re-randomizes every second for animation effect
 */
function renderTwoPhaseFluid(
  ctx: CanvasRenderingContext2D,
  fluid: Fluid,
  x: number,
  y: number,
  width: number,
  height: number,
  pixelSize: number = 4
): void {
  if (fluid.phase !== 'two-phase') {
    ctx.fillStyle = getFluidColor(fluid);
    ctx.fillRect(x, y, width, height);
    return;
  }

  const { liquid, vapor, quality } = getTwoPhaseColors(fluid);
  const timeSeed = getTimeSeed();

  // Calculate grid dimensions
  const cols = Math.ceil(width / pixelSize);
  const rows = Math.ceil(height / pixelSize);

  // Render each pixel
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const px = x + col * pixelSize;
      const py = y + row * pixelSize;
      const pw = Math.min(pixelSize, x + width - px);
      const ph = Math.min(pixelSize, y + height - py);

      // Use seeded random based on position + time for animated pattern
      const seed = row * 1000 + col + Math.floor(quality * 100) * 10000 + timeSeed * 7919;
      const rand = seededRandom(seed);

      // Higher quality = more vapor pixels
      const isVapor = rand < quality;

      ctx.fillStyle = isVapor
        ? rgbToString(vapor, 0.85)
        : rgbToString(liquid, 0.9);
      ctx.fillRect(px, py, pw, ph);
    }
  }
}

/**
 * Calculate liquid volume fraction for stratified two-phase display.
 * In construction mode, uses stored fillLevel directly.
 * In simulation mode, derives from mass quality using density ratio.
 *
 * @param component - Component with optional fillLevel property
 * @param fluid - Fluid state with quality and pressure
 * @param isSimulating - Whether simulation is running
 * @returns Liquid volume fraction (0-1), where 1 = fully liquid
 */
function getLiquidFraction(component: any, fluid: Fluid, isSimulating: boolean): number {
  // In construction mode, use stored fillLevel if available
  if (!isSimulating && component.fillLevel !== undefined) {
    return component.fillLevel;
  }
  // In simulation mode or if no fillLevel, derive from mass quality
  const massQuality = fluid.quality ?? 0.5;
  const vaporVolumeFraction = massQualityToVolumeFraction(massQuality, fluid.pressure);
  return 1 - vaporVolumeFraction;
}

/**
 * Render stratified two-phase fluid with vapor on top, liquid on bottom.
 * Used for tanks, pressurizers, vessels, HX shell sides, condensers.
 *
 * When separation < 1, each zone is shown as a mixture with pixelated rendering:
 * - Liquid zone has effective quality = (1 - separation) × actual_quality
 * - Vapor zone has effective quality = separation + (1 - separation) × actual_quality
 *
 * @param ctx - Canvas context
 * @param fluid - Fluid state (must be two-phase)
 * @param x - Left edge of render area
 * @param y - Top edge of render area (vapor starts here)
 * @param width - Width of render area
 * @param height - Total height of render area
 * @param liquidFraction - Volume fraction of liquid (0-1)
 * @param separation - Phase separation factor (0 = fully mixed, 1 = fully separated)
 */
function renderStratifiedTwoPhase(
  ctx: CanvasRenderingContext2D,
  fluid: Fluid,
  x: number,
  y: number,
  width: number,
  height: number,
  liquidFraction: number,
  separation: number = 1
): void {
  const liquidHeight = height * liquidFraction;
  const vaporHeight = height - liquidHeight;

  // Get actual mass quality and convert to volume fraction for visual rendering
  // Volume fraction represents what fraction of SPACE is occupied by vapor
  const massQuality = fluid.quality ?? 0.5;
  const volumeFraction = massQualityToVolumeFraction(massQuality, fluid.pressure);

  // Saturation temperature for coloring
  const T_sat = getSaturationTemp(fluid.pressure);

  // Get base colors at saturation
  const { liquid: liquidColor, vapor: vaporColor } = getTwoPhaseColors(fluid);

  // Draw vapor space (top)
  if (vaporHeight > 0) {
    // Vapor zone effective quality: pure vapor at separation=1, mixture at separation=0
    // Use volume fraction so visual pixel distribution matches spatial distribution
    const vaporZoneQuality = separation + (1 - separation) * volumeFraction;

    if (separation >= 0.99) {
      // Nearly fully separated: draw as pure vapor
      const vaporFluid: Fluid = {
        temperature: T_sat,
        pressure: fluid.pressure,
        phase: 'vapor',
        flowRate: 0,
      };
      ctx.fillStyle = getFluidColor(vaporFluid);
      ctx.fillRect(x, y, width, vaporHeight);
    } else {
      // Partial separation: draw pixelated mixture
      renderZoneWithQuality(ctx, x, y, width, vaporHeight, liquidColor, vaporColor, vaporZoneQuality);
    }
  }

  // Draw liquid zone (bottom)
  if (liquidHeight > 0) {
    // Liquid zone effective quality: pure liquid at separation=1, mixture at separation=0
    // Use volume fraction so visual pixel distribution matches spatial distribution
    const liquidZoneQuality = (1 - separation) * volumeFraction;

    if (separation >= 0.99) {
      // Nearly fully separated: draw as pure liquid
      const liquidFluid: Fluid = {
        temperature: T_sat,
        pressure: fluid.pressure,
        phase: 'liquid',
        flowRate: 0,
      };
      ctx.fillStyle = getFluidColor(liquidFluid);
      ctx.fillRect(x, y + vaporHeight, width, liquidHeight);
    } else {
      // Partial separation: draw pixelated mixture
      renderZoneWithQuality(ctx, x, y + vaporHeight, width, liquidHeight, liquidColor, vaporColor, liquidZoneQuality);
    }
  }
}

/**
 * Render a zone with pixelated liquid/vapor based on effective quality.
 * Similar to renderTwoPhaseFluid but for a specific zone.
 */
function renderZoneWithQuality(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  liquidColor: { r: number; g: number; b: number },
  vaporColor: { r: number; g: number; b: number },
  quality: number,
  pixelSize: number = 4
): void {
  const timeSeed = getTimeSeed();

  // Calculate grid dimensions
  const cols = Math.ceil(width / pixelSize);
  const rows = Math.ceil(height / pixelSize);

  // Render each pixel
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const px = x + col * pixelSize;
      const py = y + row * pixelSize;
      const pw = Math.min(pixelSize, x + width - px);
      const ph = Math.min(pixelSize, y + height - py);

      // Use seeded random based on position + time for animated pattern
      const seed = row * 1000 + col + Math.floor(quality * 100) * 10000 + timeSeed * 7919;
      const rand = seededRandom(seed);

      // Higher quality = more vapor pixels
      const isVapor = rand < quality;

      ctx.fillStyle = isVapor
        ? rgbToString(vaporColor, 0.85)
        : rgbToString(liquidColor, 0.9);
      ctx.fillRect(px, py, pw, ph);
    }
  }
}

export function screenToWorld(point: Point, view: ViewState): Point {
  return {
    x: (point.x - view.offsetX) / view.zoom,
    y: (point.y - view.offsetY) / view.zoom,
  };
}

/** Result of world-to-screen projection with scale factor for perspective */
export interface WorldToScreenResult {
  pos: Point;
  scale: number;
}

/** Function type for world-to-screen projection with elevation */
export type WorldToScreenFn = (pos: Point, elevation?: number) => WorldToScreenResult;

// Main component renderer - dispatches to specific renderers
export function renderComponent(
  ctx: CanvasRenderingContext2D,
  component: PlantComponent,
  view: ViewState,
  isSelected: boolean = false,
  skipPorts: boolean = false,
  connections?: Connection[],
  isSimulating: boolean = false,
  plantState?: PlantState,
  worldToScreenFn?: WorldToScreenFn
): void {
  // Note: Context is already transformed to component position by caller
  // We no longer transform here to support isometric projection

  // Dispatch to specific renderer
  switch (component.type) {
    case 'tank':
      renderTank(ctx, component, view, isSimulating);
      break;
    case 'pipe':
      renderPipe(ctx, component, view);
      break;
    case 'pump':
      renderPump(ctx, component, view);
      break;
    case 'vessel':
      renderVessel(ctx, component, view, isSimulating);
      break;
    case 'valve':
      renderValve(ctx, component, view);
      break;
    case 'heatExchanger':
      renderHeatExchanger(ctx, component, view);
      break;
    case 'turbine-generator':
      renderTurbineGenerator(ctx, component, view);
      break;
    case 'turbine-driven-pump':
      renderTurbineDrivenPump(ctx, component, view);
      break;
    case 'condenser':
      renderCondenser(ctx, component, view);
      break;
    case 'reactorVessel':
      renderReactorVessel(ctx, component as ReactorVesselComponent, view, connections, isSimulating, plantState);
      break;
    case 'controller':
      renderController(ctx, component as ControllerComponent, view);
      break;
    case 'switchyard':
      renderSwitchyard(ctx, component as SwitchyardComponent, view, plantState, worldToScreenFn);
      break;
  }

  // Draw selection highlight
  if (isSelected) {
    ctx.strokeStyle = COLORS.selectionHighlight;
    ctx.lineWidth = 3;
    const bounds = getComponentBounds(component, view);
    ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }

  // Draw ports (skip in isometric mode where they're rendered separately)
  if (!skipPorts) {
    renderPorts(ctx, component, view);
  }
}

function renderTank(ctx: CanvasRenderingContext2D, tank: TankComponent, view: ViewState, isSimulating: boolean = false): void {
  const w = tank.width * view.zoom;
  const h = tank.height * view.zoom;

  // Calculate wall thickness from pressure rating if available, otherwise use stored value
  let wallThickness = tank.wallThickness;
  if (tank.pressureRating !== undefined && tank.pressureRating > 0) {
    wallThickness = calculateWallThicknessFromPressure(tank.pressureRating, tank.width);
  }
  const wallPx = Math.max(2, wallThickness * view.zoom);

  // Outer wall
  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(-w / 2, -h / 2, w, h);

  // Inner area (show fluid if present)
  const innerW = w - wallPx * 2;
  const innerH = h - wallPx * 2;

  if (tank.fluid) {
    if (tank.fluid.phase === 'two-phase') {
      // Stratified display: vapor on top, liquid on bottom
      const liquidFraction = getLiquidFraction(tank, tank.fluid, isSimulating);
      const separation = tank.fluid.separation ?? 1;
      renderStratifiedTwoPhase(ctx, tank.fluid, -innerW / 2, -innerH / 2, innerW, innerH, liquidFraction, separation);
    } else {
      // Single phase fluid fills the entire tank
      ctx.fillStyle = getFluidColor(tank.fluid);
      ctx.fillRect(-innerW / 2, -innerH / 2, innerW, innerH);
    }
  } else {
    // Empty - dark interior
    ctx.fillStyle = '#111';
    ctx.fillRect(-innerW / 2, -innerH / 2, innerW, innerH);
  }

  // Highlight edges
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 1;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
}

function renderPipe(ctx: CanvasRenderingContext2D, pipe: PipeComponent, view: ViewState): void {
  const length = pipe.length * view.zoom;

  // Calculate wall thickness from pressure rating if available, otherwise use stored value
  let wallThickness = pipe.thickness;
  if (pipe.pressureRating !== undefined && pipe.pressureRating > 0) {
    // For pipes, outer diameter = inner diameter + 2*thickness
    // We calculate thickness based on what outer diameter would be
    const estimatedOuterD = pipe.diameter + 2 * pipe.thickness;
    wallThickness = calculatePipeThicknessFromPressure(pipe.pressureRating, estimatedOuterD);
  }

  const outerD = (pipe.diameter + wallThickness * 2) * view.zoom;
  const innerD = pipe.diameter * view.zoom;

  // Outer pipe (wall)
  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(0, -outerD / 2, length, outerD);

  // Inner pipe (fluid space)
  if (pipe.fluid) {
    if (pipe.fluid.phase === 'two-phase') {
      renderTwoPhaseFluid(ctx, pipe.fluid, 0, -innerD / 2, length, innerD, 3);
    } else {
      ctx.fillStyle = getFluidColor(pipe.fluid);
      ctx.fillRect(0, -innerD / 2, length, innerD);
    }
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, -innerD / 2, length, innerD);
  }

  // Flow arrows if fluid is flowing
  if (pipe.fluid && Math.abs(pipe.fluid.flowRate) > 0.01) {
    renderFlowArrows(ctx, pipe, view);
  }

  // Pipe edges
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -outerD / 2);
  ctx.lineTo(length, -outerD / 2);
  ctx.moveTo(0, outerD / 2);
  ctx.lineTo(length, outerD / 2);
  ctx.stroke();
}

function renderFlowArrows(ctx: CanvasRenderingContext2D, pipe: PipeComponent, view: ViewState): void {
  if (!pipe.fluid) return;

  const length = pipe.length * view.zoom;
  const innerD = (pipe.diameter - pipe.thickness * 2) * view.zoom;
  const flowRate = pipe.fluid.flowRate;

  // Arrow properties based on flow rate
  const arrowCount = Math.min(5, Math.max(1, Math.ceil(length / 50)));
  const arrowSize = Math.min(innerD * 0.6, 10);
  const direction = flowRate > 0 ? 1 : -1;

  // Animate arrows based on time (we'll add animation later)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';

  for (let i = 0; i < arrowCount; i++) {
    const x = (length / (arrowCount + 1)) * (i + 1);
    ctx.save();
    ctx.translate(x, 0);
    if (direction < 0) ctx.rotate(Math.PI);

    // Draw arrow
    ctx.beginPath();
    ctx.moveTo(arrowSize / 2, 0);
    ctx.lineTo(-arrowSize / 2, -arrowSize / 2);
    ctx.lineTo(-arrowSize / 4, 0);
    ctx.lineTo(-arrowSize / 2, arrowSize / 2);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }
}

function renderPump(ctx: CanvasRenderingContext2D, pump: PumpComponent, view: ViewState): void {
  // Upright motor-driven pump in profile view (like an RCP)
  // Suction nozzle on bottom, discharge on side, motor on top
  const d = pump.diameter * view.zoom;
  const scale = d * 1.3; // 30% bigger overall

  // Handle orientation:
  // - left-right: vertical pump, inlet bottom, outlet right (default)
  // - right-left: vertical pump, inlet bottom, outlet left (mirror horizontally)
  // - bottom-top: horizontal pump, inlet left, outlet right (rotate -90°)
  // - top-bottom: horizontal pump, inlet right, outlet left (rotate +90°)
  const orientation = (pump as any).orientation || 'left-right';

  ctx.save();

  // Apply transform based on orientation
  if (orientation === 'right-left') {
    ctx.scale(-1, 1);  // Mirror horizontally
  } else if (orientation === 'bottom-top') {
    ctx.rotate(-Math.PI / 2);  // Rotate -90° (motor on right)
  } else if (orientation === 'top-bottom') {
    ctx.rotate(Math.PI / 2);  // Rotate +90° (motor on left)
  }
  // left-right: no transform needed

  // Component dimensions (all relative to scale)
  const motorWidth = scale * 0.5;
  const motorHeight = scale * 0.9;
  const couplingHeight = scale * 0.15;
  const pumpCasingWidth = scale * 0.75;
  const pumpCasingHeight = scale * 0.5;
  const suctionNozzleHeight = scale * 0.35; // Tapered section below casing
  const pipeSize = scale * 0.22;
  const inletPipeSize = scale * 0.28; // Slightly larger suction pipe

  // Calculate total height and vertical positions
  // Layout from top to bottom: motor, coupling, pump casing, suction nozzle, inlet pipe
  const totalHeight = motorHeight + couplingHeight + pumpCasingHeight + suctionNozzleHeight;
  const motorTop = -totalHeight / 2;
  const motorBottom = motorTop + motorHeight;
  const couplingBottom = motorBottom + couplingHeight;
  const casingBottom = couplingBottom + pumpCasingHeight;
  const nozzleBottom = casingBottom + suctionNozzleHeight;

  const steelColor = pump.running ? COLORS.steel : COLORS.steelDark;
  const highlightColor = pump.running ? COLORS.steelHighlight : COLORS.steel;

  // === INLET PIPE (vertical, from bottom of suction nozzle) ===
  const inletLength = scale * 0.3;
  ctx.fillStyle = steelColor;
  ctx.fillRect(-inletPipeSize / 2, nozzleBottom, inletPipeSize, inletLength);
  // Flange at inlet end
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(-inletPipeSize * 0.7, nozzleBottom + inletLength - scale * 0.05, inletPipeSize * 1.4, scale * 0.05);

  // === SUCTION NOZZLE (tapered from casing to inlet pipe) ===
  ctx.fillStyle = steelColor;
  ctx.beginPath();
  // Start at bottom of casing (wider)
  ctx.moveTo(-pumpCasingWidth / 2, casingBottom);
  // Taper down to inlet pipe width
  ctx.lineTo(-inletPipeSize / 2, nozzleBottom);
  ctx.lineTo(inletPipeSize / 2, nozzleBottom);
  ctx.lineTo(pumpCasingWidth / 2, casingBottom);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = highlightColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Nozzle detail lines (taper rings)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    const y = casingBottom + suctionNozzleHeight * t;
    const w = pumpCasingWidth / 2 * (1 - t) + inletPipeSize / 2 * t;
    ctx.beginPath();
    ctx.moveTo(-w, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // === OUTLET PIPE (horizontal, from right side of casing) ===
  const outletY = couplingBottom + pumpCasingHeight * 0.35;
  const outletLength = scale * 0.45;
  // Volute bulge width for outlet position
  const voluteBulge = scale * 0.18;
  ctx.fillStyle = steelColor;
  ctx.fillRect(pumpCasingWidth / 2 + voluteBulge - pipeSize / 4, outletY - pipeSize / 2, outletLength, pipeSize);
  // Flange at outlet end
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(pumpCasingWidth / 2 + voluteBulge + outletLength - scale * 0.05, outletY - pipeSize * 0.7, scale * 0.05, pipeSize * 1.4);

  // === PUMP CASING (volute shape with pronounced bulge) ===
  ctx.fillStyle = steelColor;
  ctx.beginPath();
  const casingR = pumpCasingHeight * 0.15;

  // Start at top-left, go clockwise
  ctx.moveTo(-pumpCasingWidth / 2 + casingR, couplingBottom);
  ctx.lineTo(pumpCasingWidth / 2 - casingR, couplingBottom);
  ctx.arc(pumpCasingWidth / 2 - casingR, couplingBottom + casingR, casingR, -Math.PI / 2, 0);

  // Right side with pronounced volute bulge (spiral collector)
  ctx.lineTo(pumpCasingWidth / 2, couplingBottom + pumpCasingHeight * 0.15);
  // Bulge out for volute - more pronounced curve
  ctx.bezierCurveTo(
    pumpCasingWidth / 2 + voluteBulge * 0.5, couplingBottom + pumpCasingHeight * 0.2,
    pumpCasingWidth / 2 + voluteBulge, couplingBottom + pumpCasingHeight * 0.35,
    pumpCasingWidth / 2 + voluteBulge, outletY
  );
  // Continue bulge down and back
  ctx.bezierCurveTo(
    pumpCasingWidth / 2 + voluteBulge, couplingBottom + pumpCasingHeight * 0.6,
    pumpCasingWidth / 2 + voluteBulge * 0.3, couplingBottom + pumpCasingHeight * 0.85,
    pumpCasingWidth / 2, casingBottom - casingR
  );

  ctx.arc(pumpCasingWidth / 2 - casingR, casingBottom - casingR, casingR, 0, Math.PI / 2);
  ctx.lineTo(-pumpCasingWidth / 2 + casingR, casingBottom);
  ctx.arc(-pumpCasingWidth / 2 + casingR, casingBottom - casingR, casingR, Math.PI / 2, Math.PI);
  ctx.lineTo(-pumpCasingWidth / 2, couplingBottom + casingR);
  ctx.arc(-pumpCasingWidth / 2 + casingR, couplingBottom + casingR, casingR, Math.PI, Math.PI * 1.5);
  ctx.closePath();
  ctx.fill();

  // Casing outline
  ctx.strokeStyle = highlightColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Casing detail - impeller eye suggestion (circle in center)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, couplingBottom + pumpCasingHeight * 0.5, pumpCasingHeight * 0.25, 0, Math.PI * 2);
  ctx.stroke();

  // === COUPLING HOUSING ===
  ctx.fillStyle = COLORS.steelDark;
  const couplingWidth = motorWidth * 0.7;
  ctx.fillRect(-couplingWidth / 2, motorBottom, couplingWidth, couplingHeight);
  ctx.strokeStyle = highlightColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(-couplingWidth / 2, motorBottom, couplingWidth, couplingHeight);

  // === MOTOR ===
  // Motor body (cylindrical, shown as rectangle in profile)
  ctx.fillStyle = steelColor;
  ctx.fillRect(-motorWidth / 2, motorTop, motorWidth, motorHeight);

  // Motor outline
  ctx.strokeStyle = highlightColor;
  ctx.lineWidth = 2;
  ctx.strokeRect(-motorWidth / 2, motorTop, motorWidth, motorHeight);

  // Motor cooling fins (horizontal lines on the sides)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = 1;
  const finSpacing = motorHeight / 12;
  for (let i = 1; i < 12; i++) {
    const finY = motorTop + i * finSpacing;
    // Left side fins
    ctx.beginPath();
    ctx.moveTo(-motorWidth / 2, finY);
    ctx.lineTo(-motorWidth / 2 - scale * 0.04, finY);
    ctx.stroke();
    // Right side fins
    ctx.beginPath();
    ctx.moveTo(motorWidth / 2, finY);
    ctx.lineTo(motorWidth / 2 + scale * 0.04, finY);
    ctx.stroke();
  }

  // Motor end cap (top)
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(-motorWidth / 2, motorTop, motorWidth, scale * 0.06);
  ctx.strokeStyle = highlightColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(-motorWidth / 2, motorTop, motorWidth, scale * 0.06);

  // Motor nameplate/label area
  ctx.fillStyle = 'rgba(40, 50, 60, 0.8)';
  const labelWidth = motorWidth * 0.6;
  const labelHeight = motorHeight * 0.15;
  const labelY = motorTop + motorHeight * 0.35;
  ctx.fillRect(-labelWidth / 2, labelY, labelWidth, labelHeight);

  // === RUNNING INDICATOR ===
  if (pump.running) {
    // Green glow around the motor
    ctx.strokeStyle = COLORS.safe;
    ctx.lineWidth = 3;
    ctx.strokeRect(-motorWidth / 2 - 3, motorTop - 3, motorWidth + 6, motorHeight + couplingHeight + 6);

    // Animated-looking motion lines near coupling
    ctx.strokeStyle = 'rgba(100, 220, 100, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, motorBottom + couplingHeight / 2, couplingWidth / 2 + 5, 0, Math.PI, true);
    ctx.stroke();
  }

  // === FLOW DIRECTION ARROW ===
  // Arrow shows flow from bottom inlet, up through pump, out the side
  const arrowStartY = nozzleBottom + inletLength * 0.7;
  const arrowEndX = pumpCasingWidth / 2 + voluteBulge + outletLength * 0.8;
  const arrowWidth = scale * 0.1;
  const arrowHeadLen = scale * 0.12;

  // Arrow color
  if (pump.running) {
    ctx.fillStyle = 'rgba(100, 220, 100, 0.9)';
    ctx.strokeStyle = 'rgba(50, 150, 50, 1)';
  } else {
    ctx.fillStyle = 'rgba(150, 150, 150, 0.5)';
    ctx.strokeStyle = 'rgba(100, 100, 100, 0.6)';
  }

  // Draw curved arrow following flow path (up and out)
  ctx.lineWidth = arrowWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Arrow shaft (curved path: up from inlet, curve to outlet)
  ctx.beginPath();
  ctx.moveTo(0, arrowStartY);
  ctx.lineTo(0, couplingBottom + pumpCasingHeight * 0.5);
  // Curve toward outlet
  ctx.quadraticCurveTo(
    pumpCasingWidth * 0.3, couplingBottom + pumpCasingHeight * 0.4,
    arrowEndX - arrowHeadLen, outletY
  );
  ctx.stroke();

  // Arrow head
  ctx.beginPath();
  ctx.moveTo(arrowEndX, outletY);
  ctx.lineTo(arrowEndX - arrowHeadLen, outletY - arrowWidth * 1.2);
  ctx.lineTo(arrowEndX - arrowHeadLen * 0.6, outletY);
  ctx.lineTo(arrowEndX - arrowHeadLen, outletY + arrowWidth * 1.2);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();  // Restore from horizontal mirror transform
}

function renderVessel(ctx: CanvasRenderingContext2D, vessel: VesselComponent, view: ViewState, isSimulating: boolean = false): void {
  const innerR = (vessel.innerDiameter / 2) * view.zoom;

  // Calculate wall thickness from pressure rating if available, otherwise use stored value
  let wallThickness = vessel.wallThickness;
  if (vessel.pressureRating !== undefined && vessel.pressureRating > 0) {
    wallThickness = calculateWallThicknessFromPressure(vessel.pressureRating, vessel.innerDiameter);
  }

  const outerR = innerR + wallThickness * view.zoom;
  const h = vessel.height * view.zoom;

  // Draw the vessel shell as a single continuous path (no dome transition lines)
  ctx.fillStyle = COLORS.steel;
  ctx.beginPath();

  if (vessel.hasDome && vessel.hasBottom) {
    // Full vessel with both domes - draw as single continuous path
    ctx.moveTo(-outerR, h / 2 - outerR);
    ctx.lineTo(-outerR, -h / 2 + outerR);
    ctx.arc(0, -h / 2 + outerR, outerR, Math.PI, 0, false);
    ctx.lineTo(outerR, h / 2 - outerR);
    ctx.arc(0, h / 2 - outerR, outerR, 0, Math.PI, false);
    ctx.closePath();
  } else if (vessel.hasDome) {
    // Dome on top only
    ctx.moveTo(-outerR, h / 2);
    ctx.lineTo(-outerR, -h / 2 + outerR);
    ctx.arc(0, -h / 2 + outerR, outerR, Math.PI, 0, false);
    ctx.lineTo(outerR, h / 2);
    ctx.closePath();
  } else if (vessel.hasBottom) {
    // Dome on bottom only
    ctx.moveTo(-outerR, -h / 2);
    ctx.lineTo(-outerR, h / 2 - outerR);
    ctx.arc(0, h / 2 - outerR, outerR, 0, Math.PI, false);
    ctx.lineTo(outerR, -h / 2);
    ctx.closePath();
  } else {
    // No domes - just a cylinder
    ctx.rect(-outerR, -h / 2, outerR * 2, h);
  }
  ctx.fill();

  // Inner cavity with fluid - also as single path
  ctx.save();
  ctx.beginPath();

  if (vessel.hasDome && vessel.hasBottom) {
    ctx.moveTo(-innerR, h / 2 - outerR);
    ctx.lineTo(-innerR, -h / 2 + outerR);
    ctx.arc(0, -h / 2 + outerR, innerR, Math.PI, 0, false);
    ctx.lineTo(innerR, h / 2 - outerR);
    ctx.arc(0, h / 2 - outerR, innerR, 0, Math.PI, false);
    ctx.closePath();
  } else if (vessel.hasDome) {
    const wallT = wallThickness * view.zoom;
    ctx.moveTo(-innerR, h / 2 - wallT);
    ctx.lineTo(-innerR, -h / 2 + outerR);
    ctx.arc(0, -h / 2 + outerR, innerR, Math.PI, 0, false);
    ctx.lineTo(innerR, h / 2 - wallT);
    ctx.closePath();
  } else if (vessel.hasBottom) {
    const wallT = wallThickness * view.zoom;
    ctx.moveTo(-innerR, -h / 2 + wallT);
    ctx.lineTo(-innerR, h / 2 - outerR);
    ctx.arc(0, h / 2 - outerR, innerR, 0, Math.PI, false);
    ctx.lineTo(innerR, -h / 2 + wallT);
    ctx.closePath();
  } else {
    const wallT = wallThickness * view.zoom;
    ctx.rect(-innerR, -h / 2 + wallT, innerR * 2, h - wallT * 2);
  }
  ctx.clip();

  // Fill with fluid color - stratified for two-phase (like pressurizers)
  if (vessel.fluid) {
    if (vessel.fluid.phase === 'two-phase') {
      const liquidFraction = getLiquidFraction(vessel, vessel.fluid, isSimulating);
      const separation = vessel.fluid.separation ?? 1;
      renderStratifiedTwoPhase(ctx, vessel.fluid, -innerR, -h / 2, innerR * 2, h, liquidFraction, separation);
    } else {
      ctx.fillStyle = getFluidColor(vessel.fluid);
      ctx.fillRect(-innerR, -h / 2, innerR * 2, h);
    }
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(-innerR, -h / 2, innerR * 2, h);
  }

  ctx.restore();

  // Fuel rods and control rods (if this is a reactor vessel with fuel)
  if (vessel.fuelRodCount && vessel.fuelRodCount > 0) {
    const fuelTemp = vessel.fuelTemperature ?? 600; // Default to warm if not set
    const meltPoint = vessel.fuelMeltingPoint ?? 2800;
    const fuelColor = getFuelColor(fuelTemp, meltPoint);

    // Calculate inner cavity dimensions
    const domeOffset = vessel.hasDome ? outerR : 0;
    const bottomOffset = vessel.hasBottom ? outerR : 0;
    const innerCylinderH = h - domeOffset - bottomOffset - vessel.wallThickness * view.zoom * 2;
    const innerTop = -h / 2 + domeOffset + vessel.wallThickness * view.zoom;

    // Fuel rods are in the lower portion of the vessel (core region)
    const coreHeight = innerCylinderH * 0.6; // Core is 60% of inner height
    const coreTop = innerTop + innerCylinderH * 0.2; // Start 20% from top
    const coreWidth = innerR * 1.6; // Core width is 80% of inner diameter

    const rodCount = vessel.fuelRodCount;
    const rodSpacing = coreWidth / (rodCount + 1);
    const rodWidth = Math.max(2, Math.min(rodSpacing * 0.6, 6)); // 2-6 pixels wide

    // Draw each fuel rod as a vertical bar
    for (let i = 0; i < rodCount; i++) {
      const rodX = -coreWidth / 2 + rodSpacing * (i + 1);

      // Fuel rod cladding (thin outline)
      ctx.fillStyle = COLORS.steelDark;
      ctx.fillRect(rodX - rodWidth / 2 - 1, coreTop, rodWidth + 2, coreHeight);

      // Fuel pellet (colored by temperature)
      ctx.fillStyle = fuelColor;
      ctx.fillRect(rodX - rodWidth / 2, coreTop + 1, rodWidth, coreHeight - 2);
    }

    // Draw control rods (black bars between fuel rods)
    // Control rods are always full length, and extend above the core when withdrawn
    const controlRodCount = vessel.controlRodCount ?? 0;
    if (controlRodCount > 0) {
      const controlRodPosition = vessel.controlRodPosition ?? 0.5;
      // 0 = fully inserted (rod inside core), 1 = fully withdrawn (rod above core)
      // Control rod length is always the same as core height
      const controlRodLength = coreHeight;
      // The top of the rod moves up as it's withdrawn
      const rodTopOffset = coreHeight * controlRodPosition;
      const rodTop = coreTop - rodTopOffset;

      // Control rods are positioned between fuel rods
      const controlRodWidth = rodWidth * 0.8;
      const fuelRodPositions: number[] = [];
      for (let i = 0; i < rodCount; i++) {
        fuelRodPositions.push(-coreWidth / 2 + rodSpacing * (i + 1));
      }

      // Place control rods evenly distributed between fuel rods
      for (let i = 0; i < controlRodCount; i++) {
        const fuelIndex = Math.floor((i + 1) * (rodCount - 1) / (controlRodCount + 1));
        const crX = (fuelRodPositions[fuelIndex] + fuelRodPositions[fuelIndex + 1]) / 2;

        ctx.fillStyle = '#333';
        ctx.fillRect(crX - controlRodWidth / 2 - 1, rodTop, controlRodWidth + 2, controlRodLength);
        ctx.fillStyle = '#111';
        ctx.fillRect(crX - controlRodWidth / 2, rodTop + 1, controlRodWidth, controlRodLength - 2);
      }
    }
  }

  // Vessel outline - single continuous path (no dome transition lines)
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 2;
  ctx.beginPath();

  if (vessel.hasDome && vessel.hasBottom) {
    ctx.moveTo(-outerR, h / 2 - outerR);
    ctx.lineTo(-outerR, -h / 2 + outerR);
    ctx.arc(0, -h / 2 + outerR, outerR, Math.PI, 0, false);
    ctx.lineTo(outerR, h / 2 - outerR);
    ctx.arc(0, h / 2 - outerR, outerR, 0, Math.PI, false);
  } else if (vessel.hasDome) {
    ctx.moveTo(-outerR, h / 2);
    ctx.lineTo(-outerR, -h / 2 + outerR);
    ctx.arc(0, -h / 2 + outerR, outerR, Math.PI, 0, false);
    ctx.lineTo(outerR, h / 2);
  } else if (vessel.hasBottom) {
    ctx.moveTo(-outerR, -h / 2);
    ctx.lineTo(-outerR, h / 2 - outerR);
    ctx.arc(0, h / 2 - outerR, outerR, 0, Math.PI, false);
    ctx.lineTo(outerR, -h / 2);
  } else {
    ctx.rect(-outerR, -h / 2, outerR * 2, h);
  }

  ctx.closePath();
  ctx.stroke();
}

function renderReactorVessel(ctx: CanvasRenderingContext2D, vessel: ReactorVesselComponent, view: ViewState, connections?: Connection[], isSimulating: boolean = false, plantState?: PlantState): void {
  const innerR = (vessel.innerDiameter / 2) * view.zoom;
  const outerR = innerR + vessel.wallThickness * view.zoom;
  const h = vessel.height * view.zoom;

  // Barrel dimensions
  const barrelOuterR = (vessel.barrelDiameter / 2 + vessel.barrelThickness / 2) * view.zoom;
  const barrelInnerR = (vessel.barrelDiameter / 2) * view.zoom;

  // Calculate dome intrusion at barrel radius
  // The dome is hemispherical with radius = innerDiameter/2
  // At the barrel's outer radius, the dome surface is at:
  // z = R - sqrt(R² - r²) from the end of the cylinder
  const vesselR = vessel.innerDiameter / 2;  // world units
  const barrelOuterRWorld = vessel.barrelDiameter / 2 + vessel.barrelThickness / 2;
  const domeIntrusion = vesselR - Math.sqrt(vesselR * vesselR - barrelOuterRWorld * barrelOuterRWorld);

  // Barrel position relative to inner dome surface
  // The inner dome center is at Y = -H/2 + outerR (top) or H/2 - outerR (bottom)
  // Inner dome radius = vesselR, so at barrel outer radius, dome surface is at:
  // Y = domeCenterY -/+ sqrt(vesselR² - barrelR²)
  // The gap is measured from this dome surface to the barrel end
  const effectiveBottomY = vessel.height / 2 - vessel.wallThickness - domeIntrusion - vessel.barrelBottomGap;
  const effectiveTopY = -vessel.height / 2 + vessel.wallThickness + domeIntrusion + vessel.barrelTopGap;
  const barrelBottomY = effectiveBottomY * view.zoom;
  const barrelTopY = effectiveTopY * view.zoom;
  const barrelHeight = barrelBottomY - barrelTopY;

  // Draw the vessel shell as a single continuous path (no dome transition lines)
  ctx.fillStyle = COLORS.steel;
  ctx.beginPath();

  // Start at bottom-left of cylinder, draw outer path clockwise
  const domeR = outerR; // Dome radius equals outer radius (hemispherical)

  // Left side going up
  ctx.moveTo(-outerR, h / 2 - domeR);
  ctx.lineTo(-outerR, -h / 2 + domeR);

  // Top dome (arc from left to right)
  ctx.arc(0, -h / 2 + domeR, domeR, Math.PI, 0, false);

  // Right side going down
  ctx.lineTo(outerR, h / 2 - domeR);

  // Bottom dome (arc from right to left)
  ctx.arc(0, h / 2 - domeR, domeR, 0, Math.PI, false);

  ctx.closePath();
  ctx.fill();

  // Now draw the inner cavity (hollow it out)
  // Inner cavity with fluid - drawn as a single path
  const innerDomeR = innerR;
  const cavityTop = -h / 2 + domeR + vessel.wallThickness * view.zoom;
  const cavityBottom = h / 2 - domeR - vessel.wallThickness * view.zoom;

  // Draw fluid in cavity (outside the barrel - downcomer region)
  ctx.save();

  // Create clipping path for the inner cavity (excludes barrel region)
  ctx.beginPath();

  // Outer boundary of cavity (inside vessel wall)
  ctx.moveTo(-innerR, cavityBottom);
  ctx.lineTo(-innerR, cavityTop);
  ctx.arc(0, -h / 2 + domeR, innerDomeR, Math.PI, 0, false);
  ctx.lineTo(innerR, cavityBottom);
  ctx.arc(0, h / 2 - domeR, innerDomeR, 0, Math.PI, false);
  ctx.closePath();

  // Cut out the barrel region (counterclockwise to subtract)
  ctx.moveTo(barrelOuterR, barrelTopY);
  ctx.lineTo(-barrelOuterR, barrelTopY);
  ctx.lineTo(-barrelOuterR, barrelBottomY);
  ctx.lineTo(barrelOuterR, barrelBottomY);
  ctx.closePath();

  ctx.clip('evenodd');

  // Fill with fluid color (downcomer region)
  // New architecture: vessel.fluid IS the downcomer
  // Legacy: outsideBarrelFluid was the downcomer (fallback to vessel.fluid)
  const downcomerFluid = (vessel as any).outsideBarrelFluid ?? vessel.fluid;
  if (downcomerFluid) {
    if (downcomerFluid.phase === 'two-phase') {
      const liquidFraction = getLiquidFraction(vessel, downcomerFluid, isSimulating);
      const separation = downcomerFluid.separation ?? 1;
      renderStratifiedTwoPhase(ctx, downcomerFluid, -innerR, -h / 2, innerR * 2, h, liquidFraction, separation);
    } else {
      ctx.fillStyle = getFluidColor(downcomerFluid);
      ctx.fillRect(-innerR, -h / 2, innerR * 2, h);
    }
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(-innerR, -h / 2, innerR * 2, h);
  }

  ctx.restore();

  // Draw the core barrel
  ctx.fillStyle = COLORS.steelDark;

  // Left barrel wall
  ctx.fillRect(-barrelOuterR, barrelTopY, vessel.barrelThickness * view.zoom, barrelHeight);

  // Right barrel wall
  ctx.fillRect(barrelInnerR, barrelTopY, vessel.barrelThickness * view.zoom, barrelHeight);

  // Draw fluid inside barrel - stratified if two-phase
  // Look up core barrel for fluid (new architecture) or fall back to vessel.fluid (legacy)
  let coreBarrel: CoreBarrelComponent | undefined;
  if (vessel.coreBarrelId && plantState) {
    coreBarrel = plantState.components.get(vessel.coreBarrelId) as CoreBarrelComponent;
  }
  const coreFluid = coreBarrel?.fluid ?? vessel.fluid;

  ctx.save();
  ctx.beginPath();
  ctx.rect(-barrelInnerR, barrelTopY, barrelInnerR * 2, barrelHeight);
  ctx.clip();

  if (coreFluid) {
    if (coreFluid.phase === 'two-phase') {
      const liquidFraction = getLiquidFraction(vessel, coreFluid, isSimulating);
      const separation = coreFluid.separation ?? 1;
      renderStratifiedTwoPhase(ctx, coreFluid, -barrelInnerR, barrelTopY, barrelInnerR * 2, barrelHeight, liquidFraction, separation);
    } else {
      ctx.fillStyle = getFluidColor(coreFluid);
      ctx.fillRect(-barrelInnerR, barrelTopY, barrelInnerR * 2, barrelHeight);
    }
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(-barrelInnerR, barrelTopY, barrelInnerR * 2, barrelHeight);
  }

  ctx.restore();

  // Draw fuel rods inside the barrel (if this reactor vessel has a core)
  // Fuel properties are on core barrel (new) or vessel (legacy)
  const fuelRodCount = coreBarrel?.fuelRodCount ?? (vessel as any).fuelRodCount;
  if (fuelRodCount && fuelRodCount > 0) {
    const fuelTemp = coreBarrel?.fuelTemperature ?? (vessel as any).fuelTemperature ?? 600;
    const meltPoint = coreBarrel?.fuelMeltingPoint ?? (vessel as any).fuelMeltingPoint ?? 2800;
    const fuelColor = getFuelColor(fuelTemp, meltPoint);

    // Core dimensions - use stored coreDiameter or default to barrel inner diameter
    // barrelDiameter is center-line, so inner = barrelDiameter - barrelThickness/2
    const coreDiameterWorld = (vessel as any).coreDiameter ?? (vessel.barrelDiameter - vessel.barrelThickness / 2);
    const coreRadiusPx = (coreDiameterWorld / 2) * view.zoom;

    // Core height - use stored coreHeight or default to barrel height
    const coreHeightWorld = (vessel as any).coreHeight ?? barrelHeight / view.zoom;
    const coreHeightPx = coreHeightWorld * view.zoom;

    // Position core closer to the bottom of the barrel (more realistic)
    // Leave a small gap (10% of barrel height) at the bottom for lower plenum
    const bottomGap = barrelHeight * 0.1;
    const coreTop = barrelBottomY - bottomGap - coreHeightPx;

    // Calculate grid dimensions based on rod pitch
    const rodPitchMm = (vessel as any).rodPitch ?? 12.6;
    const rodPitchWorld = rodPitchMm / 1000; // Convert mm to m
    const rodPitchPx = rodPitchWorld * view.zoom;

    // Rod diameter (typically ~9.5mm for PWR fuel rods)
    const rodDiameterMm = (vessel as any).rodDiameter ?? 9.5;
    const rodDiameterWorld = rodDiameterMm / 1000;

    // Calculate the ratio of rod diameter to pitch (typically ~0.75)
    const rodToPitchRatio = rodDiameterWorld / rodPitchWorld;

    // For visibility: rods need to be at least 4px wide with at least 2px gap between them
    const minRodWidthPx = 4;
    const minGapPx = 2;
    const minPitchPx = minRodWidthPx + minGapPx;

    // Calculate skip factor to ensure minimum pitch
    let skipFactor = 1;
    if (rodPitchPx < minPitchPx) {
      skipFactor = Math.ceil(minPitchPx / rodPitchPx);
    }

    // Effective display pitch (in pixels)
    const displayPitchPx = rodPitchPx * skipFactor;

    // Rod width maintains the ratio to pitch, but ensure minimum gap
    // Gap = pitch - rod width, so rod width = pitch * ratio
    // But we also need gap >= minGapPx, so rod width <= pitch - minGapPx
    const proportionalRodWidth = displayPitchPx * rodToPitchRatio;
    const maxRodWidthForGap = displayPitchPx - minGapPx;
    const rodWidthPx = Math.min(proportionalRodWidth, maxRodWidthForGap);

    // How many rods we'll actually display across the diameter
    const displayPitchWorld = rodPitchWorld * skipFactor;
    const displayRodsAcross = Math.floor(coreDiameterWorld / displayPitchWorld);

    // Generate symmetrical rod positions within circular boundary
    const rodPositions: number[] = [];
    const halfGrid = displayRodsAcross / 2;

    for (let col = 0; col < displayRodsAcross; col++) {
      // X position in pixels (centered)
      const xOffset = (col - halfGrid + 0.5) * displayPitchPx;

      // Check if this position is within the circular core boundary
      const xWorld = (col - halfGrid + 0.5) * displayPitchWorld;
      const distFromCenter = Math.abs(xWorld);

      if (distFromCenter < coreDiameterWorld / 2 - displayPitchWorld * 0.3) {
        rodPositions.push(xOffset);
      }
    }

    // Draw each fuel rod as a vertical bar
    for (const rodX of rodPositions) {
      // Fuel rod cladding
      ctx.fillStyle = COLORS.steelDark;
      ctx.fillRect(rodX - rodWidthPx / 2 - 1, coreTop, rodWidthPx + 2, coreHeightPx);

      // Fuel pellet
      ctx.fillStyle = fuelColor;
      ctx.fillRect(rodX - rodWidthPx / 2, coreTop + 1, rodWidthPx, coreHeightPx - 2);
    }

    // Draw control rods (always full length, extend above core when withdrawn)
    // Control rod properties are on core barrel (new) or vessel (legacy)
    const controlRodCount = coreBarrel?.controlRodCount ?? (vessel as any).controlRodCount ?? 0;
    if (controlRodCount > 0) {
      const controlRodPosition = coreBarrel?.controlRodPosition ?? (vessel as any).controlRodPosition ?? 0.5;
      // 0 = fully inserted (rod inside core), 1 = fully withdrawn (rod above core)
      // Control rod length is always the same as core height
      const controlRodLength = coreHeightPx;
      // The top of the rod moves up as it's withdrawn
      const rodTopOffset = coreHeightPx * controlRodPosition;
      const rodTop = coreTop - rodTopOffset;
      const controlRodWidth = rodWidthPx * 1.2; // Control rods slightly wider than fuel rods

      // Place control rods evenly across the core width
      // Use symmetrical positions
      const controlRodSpacing = (coreRadiusPx * 2 * 0.8) / (controlRodCount + 1);

      for (let i = 0; i < controlRodCount; i++) {
        const crX = -coreRadiusPx * 0.8 + controlRodSpacing * (i + 1);

        ctx.fillStyle = '#333';
        ctx.fillRect(crX - controlRodWidth / 2 - 1, rodTop, controlRodWidth + 2, controlRodLength);
        ctx.fillStyle = '#111';
        ctx.fillRect(crX - controlRodWidth / 2, rodTop + 1, controlRodWidth, controlRodLength - 2);
      }
    }
  }

  // Draw barrel top and bottom plates with holes for connections
  ctx.fillStyle = COLORS.steelDark;
  const plateThickness = 3;

  // Find connections between vessel (downcomer) and core barrel regions
  let bottomConnectionFlowArea = 0;
  let topConnectionFlowArea = 0;

  // New architecture: connections between vessel and coreBarrel
  const coreBarrelId = vessel.coreBarrelId;
  // Legacy architecture: connections between insideBarrel and outsideBarrel
  const legacyInsideId = (vessel as any).insideBarrelId;
  const legacyOutsideId = (vessel as any).outsideBarrelId;

  if (connections) {
    for (const conn of connections) {
      // New architecture: vessel <-> coreBarrel connections
      if (coreBarrelId) {
        const connectsVessel = conn.fromComponentId === vessel.id || conn.toComponentId === vessel.id;
        const connectsCoreBarrel = conn.fromComponentId === coreBarrelId || conn.toComponentId === coreBarrelId;

        if (connectsVessel && connectsCoreBarrel && conn.flowArea) {
          const portId = conn.fromComponentId === coreBarrelId ? conn.fromPortId : conn.toPortId;
          if (portId.includes('bottom')) {
            bottomConnectionFlowArea += conn.flowArea;
          } else if (portId.includes('top')) {
            topConnectionFlowArea += conn.flowArea;
          }
        }
      }
      // Legacy architecture: insideBarrel <-> outsideBarrel connections
      else if (legacyInsideId && legacyOutsideId) {
        const connectsInside = conn.fromComponentId === legacyInsideId || conn.toComponentId === legacyInsideId;
        const connectsOutside = conn.fromComponentId === legacyOutsideId || conn.toComponentId === legacyOutsideId;

        if (connectsInside && connectsOutside && conn.flowArea) {
          const portId = conn.fromComponentId === legacyInsideId ? conn.fromPortId : conn.toPortId;
          if (portId.includes('bottom')) {
            bottomConnectionFlowArea += conn.flowArea;
          } else if (portId.includes('top')) {
            topConnectionFlowArea += conn.flowArea;
          }
        }
      }
    }
  }

  // Bottom plate - draw if there's a gap (space between barrel and vessel bottom)
  if (vessel.barrelBottomGap > 0.1) {
    if (bottomConnectionFlowArea > 0) {
      // Calculate hole size from flow area (A = π*r²)
      const holeRadius = Math.sqrt(bottomConnectionFlowArea / Math.PI) * view.zoom;
      // Cap at barrel outer radius (hole can't be bigger than barrel)
      const holeRadiusClamped = Math.min(holeRadius, barrelOuterR);

      if (holeRadiusClamped >= barrelOuterR - 1) {
        // Hole is full width - don't draw plate at all (open gap)
      } else if (holeRadiusClamped > 2) {
        // Draw plate with hole
        ctx.fillRect(-barrelOuterR, barrelBottomY - plateThickness, barrelOuterR - holeRadiusClamped, plateThickness);
        ctx.fillRect(holeRadiusClamped, barrelBottomY - plateThickness, barrelOuterR - holeRadiusClamped, plateThickness);
      } else {
        // Hole too small to see, draw solid plate
        ctx.fillRect(-barrelOuterR, barrelBottomY - plateThickness, barrelOuterR * 2, plateThickness);
      }
    } else {
      // No connection - draw solid plate
      ctx.fillRect(-barrelOuterR, barrelBottomY - plateThickness, barrelOuterR * 2, plateThickness);
    }
  }

  // Top plate - draw if there's a gap
  if (vessel.barrelTopGap > 0.1) {
    if (topConnectionFlowArea > 0) {
      const holeRadius = Math.sqrt(topConnectionFlowArea / Math.PI) * view.zoom;
      const holeRadiusClamped = Math.min(holeRadius, barrelOuterR);

      if (holeRadiusClamped >= barrelOuterR - 1) {
        // Hole is full width - don't draw plate
      } else if (holeRadiusClamped > 2) {
        ctx.fillRect(-barrelOuterR, barrelTopY, barrelOuterR - holeRadiusClamped, plateThickness);
        ctx.fillRect(holeRadiusClamped, barrelTopY, barrelOuterR - holeRadiusClamped, plateThickness);
      } else {
        ctx.fillRect(-barrelOuterR, barrelTopY, barrelOuterR * 2, plateThickness);
      }
    } else {
      ctx.fillRect(-barrelOuterR, barrelTopY, barrelOuterR * 2, plateThickness);
    }
  }

  // Vessel outline - single continuous path (no dome transition lines!)
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 2;
  ctx.beginPath();

  // Left side going up
  ctx.moveTo(-outerR, h / 2 - domeR);
  ctx.lineTo(-outerR, -h / 2 + domeR);

  // Top dome
  ctx.arc(0, -h / 2 + domeR, outerR, Math.PI, 0, false);

  // Right side going down
  ctx.lineTo(outerR, h / 2 - domeR);

  // Bottom dome
  ctx.arc(0, h / 2 - domeR, outerR, 0, Math.PI, false);

  ctx.closePath();
  ctx.stroke();

  // Core barrel outline - only draw edges where barrel doesn't meet dome
  ctx.strokeStyle = COLORS.steel;
  ctx.lineWidth = 1;
  ctx.beginPath();

  // Left vertical edge
  ctx.moveTo(-barrelOuterR, barrelTopY);
  ctx.lineTo(-barrelOuterR, barrelBottomY);

  // Bottom edge (only if there's a gap)
  if (vessel.barrelBottomGap > 0.05) {
    ctx.lineTo(barrelOuterR, barrelBottomY);
  } else {
    ctx.moveTo(barrelOuterR, barrelBottomY);
  }

  // Right vertical edge
  ctx.lineTo(barrelOuterR, barrelTopY);

  // Top edge (only if there's a gap)
  if (vessel.barrelTopGap > 0.05) {
    ctx.lineTo(-barrelOuterR, barrelTopY);
  }

  ctx.stroke();
}

function renderValve(ctx: CanvasRenderingContext2D, valve: ValveComponent, view: ViewState): void {
  const d = valve.diameter * view.zoom;

  // Different rendering based on valve type with different size multipliers
  if (valve.valveType === 'check') {
    // Check valves: 30% larger
    const bodySize = d * 1.5 * 1.3;
    renderCheckValve(ctx, valve, view, d * 1.3, bodySize);
  } else if (valve.valveType === 'relief' || valve.valveType === 'porv') {
    // Relief valves and PORVs: 30% larger
    const bodySize = d * 1.5 * 1.3;
    renderReliefValve(ctx, valve, view, d * 1.3, bodySize);
  } else {
    // Standard valve (gate, globe, ball, butterfly): 15% larger
    const bodySize = d * 1.5 * 1.15;
    renderStandardValve(ctx, valve, view, d * 1.15, bodySize);
  }
}

function renderStandardValve(ctx: CanvasRenderingContext2D, valve: ValveComponent, _view: ViewState, d: number, bodySize: number): void {
  // Valve body - bowtie shape for gate valve
  ctx.fillStyle = COLORS.steel;
  ctx.beginPath();
  ctx.moveTo(-bodySize / 2, -d / 2);
  ctx.lineTo(0, 0);
  ctx.lineTo(-bodySize / 2, d / 2);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(bodySize / 2, -d / 2);
  ctx.lineTo(0, 0);
  ctx.lineTo(bodySize / 2, d / 2);
  ctx.closePath();
  ctx.fill();

  // Flow path visualization based on opening
  if (valve.opening > 0 && valve.fluid) {
    const openingWidth = d * valve.opening * 0.8;
    ctx.fillStyle = getFluidColor(valve.fluid);
    ctx.fillRect(-bodySize / 2, -openingWidth / 2, bodySize, openingWidth);
  }

  // Valve stem
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(-3, -d / 2 - 15, 6, 15);

  // Handwheel
  ctx.strokeStyle = valve.opening > 0 ? COLORS.safe : COLORS.warning;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, -d / 2 - 20, 10, 0, Math.PI * 2);
  ctx.stroke();

  // Opening indicator text
  ctx.fillStyle = '#fff';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.round(valve.opening * 100)}%`, 0, -d / 2 - 35);
}

function renderCheckValve(ctx: CanvasRenderingContext2D, valve: ValveComponent, _view: ViewState, d: number, bodySize: number): void {
  // Check valve body - bowtie shape like standard valve
  ctx.fillStyle = COLORS.steel;
  ctx.beginPath();
  ctx.moveTo(-bodySize / 2, -d / 2);
  ctx.lineTo(0, 0);
  ctx.lineTo(-bodySize / 2, d / 2);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(bodySize / 2, -d / 2);
  ctx.lineTo(0, 0);
  ctx.lineTo(bodySize / 2, d / 2);
  ctx.closePath();
  ctx.fill();

  // Flow path visualization based on opening
  if (valve.opening > 0 && valve.fluid) {
    const openingWidth = d * valve.opening * 0.8;
    ctx.fillStyle = getFluidColor(valve.fluid);
    ctx.fillRect(-bodySize / 2, -openingWidth / 2, bodySize, openingWidth);
  }

  // Check valve flapper/disc with hinge animation
  // When closed: diagonal at ~45 degrees (blocking flow)
  // When open: swings to nearly horizontal (~10 degrees from horizontal)
  const arrowLen = bodySize * 1.2;  // 25% longer arrow
  const hingeX = -arrowLen / 3;     // Move hinge more toward center
  const hingeY = arrowLen / 4;      // Move hinge upward (smaller Y = higher)

  // Angle: closed = 45 degrees (blocking), open = ~80 degrees (nearly horizontal)
  // The flapper rotates around the hinge point
  const closedAngle = -Math.PI / 4;  // 45 degrees up-right
  const openAngle = -Math.PI / 10;   // Nearly horizontal (still slightly angled)
  const currentAngle = closedAngle + (openAngle - closedAngle) * valve.opening;

  // Calculate end point of flapper based on angle
  const flapperLen = arrowLen * 1.0;  // Full length flapper
  const flapperEndX = hingeX + Math.cos(currentAngle) * flapperLen;
  const flapperEndY = hingeY + Math.sin(currentAngle) * flapperLen;

  // Draw hinge circle at base
  ctx.fillStyle = COLORS.steelDark;
  ctx.beginPath();
  ctx.arc(hingeX, hingeY, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Draw flapper line
  ctx.strokeStyle = valve.opening > 0 ? COLORS.safe : '#222';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hingeX, hingeY);
  ctx.lineTo(flapperEndX, flapperEndY);
  ctx.stroke();

  // Arrow head at end of flapper
  const headSize = arrowLen * 0.25;
  const headAngle = currentAngle;
  // Arrow head perpendicular to flapper direction
  ctx.beginPath();
  ctx.moveTo(flapperEndX, flapperEndY);
  ctx.lineTo(
    flapperEndX - headSize * Math.cos(headAngle) - headSize * 0.5 * Math.sin(headAngle),
    flapperEndY - headSize * Math.sin(headAngle) + headSize * 0.5 * Math.cos(headAngle)
  );
  ctx.moveTo(flapperEndX, flapperEndY);
  ctx.lineTo(
    flapperEndX - headSize * Math.cos(headAngle) + headSize * 0.5 * Math.sin(headAngle),
    flapperEndY - headSize * Math.sin(headAngle) - headSize * 0.5 * Math.cos(headAngle)
  );
  ctx.stroke();

  // Label
  ctx.fillStyle = '#fff';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('CHK', 0, d / 2 + 12);
}

function renderReliefValve(ctx: CanvasRenderingContext2D, valve: ValveComponent, _view: ViewState, d: number, bodySize: number): void {
  // Relief valve / PORV: inlet from bottom, outlet to side, spring on top
  const bodyWidth = bodySize * 0.8;
  const bodyHeight = bodySize * 1.2;

  // Main valve body (vertical rectangular shape)
  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(-bodyWidth / 2, -bodyHeight / 2, bodyWidth, bodyHeight);

  // Inlet pipe from bottom
  const pipeWidth = d * 0.6;
  const pipeLength = d * 0.5;
  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(-pipeWidth / 2, bodyHeight / 2, pipeWidth, pipeLength);

  // Flow path in inlet (if open)
  if (valve.fluid) {
    const fluidColor = getFluidColor(valve.fluid);
    if (valve.opening > 0) {
      // Show fluid flowing up through inlet
      ctx.fillStyle = fluidColor;
      ctx.fillRect(-pipeWidth / 2 + 2, bodyHeight / 2, pipeWidth - 4, pipeLength);
    }
  }

  // Outlet pipe to the right side
  const outletY = -bodyHeight / 4;
  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(bodyWidth / 2, outletY - pipeWidth / 2, pipeLength, pipeWidth);

  // Flow path in outlet (if open)
  if (valve.opening > 0 && valve.fluid) {
    ctx.fillStyle = getFluidColor(valve.fluid);
    ctx.fillRect(bodyWidth / 2, outletY - pipeWidth / 2 + 2, pipeLength, pipeWidth - 4);
  }

  // Internal chamber (darker)
  const chamberInset = 3;
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(-bodyWidth / 2 + chamberInset, -bodyHeight / 2 + chamberInset,
               bodyWidth - chamberInset * 2, bodyHeight - chamberInset * 2);

  // Stopper/disc (moves based on opening)
  const stopperHeight = bodyHeight * 0.15;
  const stopperY = -bodyHeight / 2 + chamberInset + (bodyHeight * 0.3) * (1 - valve.opening);
  ctx.fillStyle = valve.opening > 0 ? COLORS.warning : COLORS.steel;
  ctx.fillRect(-bodyWidth / 2 + chamberInset + 2, stopperY,
               bodyWidth - chamberInset * 2 - 4, stopperHeight);

  // Spring coil above stopper (pushing down)
  const springTop = -bodyHeight / 2 + chamberInset + 2;
  const springBottom = stopperY;
  const springCoils = 5;
  const springWidth = bodyWidth * 0.4;

  ctx.strokeStyle = '#aaa';
  ctx.lineWidth = 2;
  ctx.beginPath();

  for (let i = 0; i <= springCoils; i++) {
    const y = springTop + (springBottom - springTop) * (i / springCoils);
    const x = (i % 2 === 0) ? -springWidth / 2 : springWidth / 2;
    if (i === 0) {
      ctx.moveTo(0, y);
      ctx.lineTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.lineTo(0, springBottom);
  ctx.stroke();

  // Spring cap on top
  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(-bodyWidth / 3, -bodyHeight / 2 - 5, bodyWidth * 2 / 3, 8);

  // Adjustment bolt on top (for setpoint)
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(-4, -bodyHeight / 2 - 12, 8, 10);

  // Hex head
  ctx.beginPath();
  ctx.arc(0, -bodyHeight / 2 - 15, 6, 0, Math.PI * 2);
  ctx.fill();

  // Label with setpoint or state
  ctx.fillStyle = '#fff';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';

  if (valve.valveType === 'porv') {
    const state = valve.opening > 0 ? 'OPEN' : 'SHUT';
    ctx.fillText(`PORV ${state}`, 0, bodyHeight / 2 + pipeLength + 12);
  } else {
    const setpointBar = valve.setpoint ? (valve.setpoint / 1e5).toFixed(0) : '???';
    ctx.fillText(`RV ${setpointBar}bar`, 0, bodyHeight / 2 + pipeLength + 12);
  }
}

function renderHeatExchanger(ctx: CanvasRenderingContext2D, hx: HeatExchangerComponent, view: ViewState): void {
  // Defensive: ensure valid dimensions
  const w = Math.max((hx.width || 2) * view.zoom, 20);
  const h = Math.max((hx.height || 4) * view.zoom, 20);

  // Calculate wall thickness from pressure rating if available
  // Use the smaller dimension as the "diameter" for cylindrical approximation
  const shellDiameter = Math.min(hx.width || 2, hx.height || 4);
  const wallThicknessM = hx.pressureRating
    ? calculateWallThicknessFromPressure(hx.pressureRating, shellDiameter)
    : 0.01; // Default 10mm wall
  const wallPx = Math.max(wallThicknessM * view.zoom, 2);

  // Detect orientation: horizontal when width > height, vertical when height > width
  const isHorizontal = w > h;

  // Shell
  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(-w / 2, -h / 2, w, h);

  // Shell-side fluid (secondary) - stratified if two-phase
  const innerW = Math.max(w - wallPx * 2, 10);
  const innerH = Math.max(h - wallPx * 2, 10);
  const innerLeft = -w / 2 + wallPx;
  const innerTop = -h / 2 + wallPx;

  if (hx.secondaryFluid) {
    if (hx.secondaryFluid.phase === 'two-phase') {
      // Stratified: vapor on top, liquid on bottom
      // HX shell side always uses quality-based calculation (no stored fillLevel)
      const liquidFraction = getLiquidFraction(hx, hx.secondaryFluid, true);
      const separation = hx.secondaryFluid.separation ?? 1;
      renderStratifiedTwoPhase(ctx, hx.secondaryFluid, innerLeft, innerTop, innerW, innerH, liquidFraction, separation);
    } else {
      ctx.fillStyle = getFluidColor(hx.secondaryFluid);
      ctx.fillRect(innerLeft, innerTop, innerW, innerH);
    }
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(innerLeft, innerTop, innerW, innerH);
  }

  // Tubes (primary side) - rendering depends on hxType and orientation
  // Use a small visual tube count (cap at 10 for rendering)
  const visualTubeCount = Math.min(Math.max(hx.tubeCount || 5, 1), 10);
  const hxType = hx.hxType || 'utube';
  const tubeWall = 1;
  const tubeSheetThickness = 5;

  // Primary fluid color
  const primaryColor = hx.primaryFluid ? getFluidColor(hx.primaryFluid) : '#111';

  if (isHorizontal) {
    // HORIZONTAL ORIENTATION: tubes run left-to-right
    const tubeSpacing = innerH / (visualTubeCount + 1);
    const tubeRadius = Math.max(Math.min(tubeSpacing * 0.25, 6), 2);

    for (let i = 0; i < visualTubeCount; i++) {
      const y = innerTop + tubeSpacing * (i + 1);

      if (hxType === 'straight') {
        // Straight tubes - go all the way through horizontally
        ctx.fillStyle = COLORS.steel;
        ctx.fillRect(innerLeft + tubeSheetThickness, y - tubeRadius - tubeWall, innerW - tubeSheetThickness * 2, (tubeRadius + tubeWall) * 2);

        ctx.fillStyle = primaryColor;
        ctx.fillRect(innerLeft + tubeSheetThickness + tubeWall, y - tubeRadius, innerW - tubeSheetThickness * 2 - tubeWall * 2, tubeRadius * 2);
      } else if (hxType === 'helical') {
        // Helical coil - draw as a wavy/zigzag pattern horizontally
        ctx.strokeStyle = COLORS.steel;
        ctx.lineWidth = (tubeRadius + tubeWall) * 2;
        ctx.beginPath();
        const waveAmplitude = tubeSpacing * 0.3;
        const waveFreq = 8;
        for (let j = 0; j <= waveFreq; j++) {
          const xPos = innerLeft + tubeSheetThickness + (innerW - tubeSheetThickness - 10) * (j / waveFreq);
          const yOffset = (j % 2 === 0) ? -waveAmplitude : waveAmplitude;
          if (j === 0) {
            ctx.moveTo(xPos, y + yOffset);
          } else {
            ctx.lineTo(xPos, y + yOffset);
          }
        }
        ctx.stroke();

        // Inner helical (primary fluid)
        ctx.strokeStyle = primaryColor;
        ctx.lineWidth = tubeRadius * 2;
        ctx.beginPath();
        for (let j = 0; j <= waveFreq; j++) {
          const xPos = innerLeft + tubeSheetThickness + (innerW - tubeSheetThickness - 10) * (j / waveFreq);
          const yOffset = (j % 2 === 0) ? -waveAmplitude : waveAmplitude;
          if (j === 0) {
            ctx.moveTo(xPos, y + yOffset);
          } else {
            ctx.lineTo(xPos, y + yOffset);
          }
        }
        ctx.stroke();
      } else {
        // U-tube - tubes with U-bends at the right end
        ctx.fillStyle = COLORS.steel;
        ctx.fillRect(innerLeft + tubeSheetThickness, y - tubeRadius - tubeWall, innerW - tubeSheetThickness - 10, (tubeRadius + tubeWall) * 2);

        ctx.fillStyle = primaryColor;
        ctx.fillRect(innerLeft + tubeSheetThickness + tubeWall, y - tubeRadius, innerW - tubeSheetThickness - 10 - tubeWall * 2, tubeRadius * 2);

        // Tube header at left (inlet/outlet plenum)
        ctx.fillStyle = COLORS.steel;
        ctx.beginPath();
        ctx.arc(innerLeft + tubeSheetThickness, y, tubeRadius + tubeWall, Math.PI / 2, -Math.PI / 2);
        ctx.fill();

        ctx.fillStyle = primaryColor;
        ctx.beginPath();
        ctx.arc(innerLeft + tubeSheetThickness, y, tubeRadius, Math.PI / 2, -Math.PI / 2);
        ctx.fill();

        // U-bend at right
        ctx.fillStyle = COLORS.steel;
        ctx.beginPath();
        ctx.arc(innerLeft + innerW - 10, y, tubeRadius + tubeWall, -Math.PI / 2, Math.PI / 2);
        ctx.fill();

        ctx.fillStyle = primaryColor;
        ctx.beginPath();
        ctx.arc(innerLeft + innerW - 10, y, tubeRadius, -Math.PI / 2, Math.PI / 2);
        ctx.fill();
      }
    }

    // Draw tube sheet(s) - vertical for horizontal orientation
    ctx.fillStyle = COLORS.steelDark;
    ctx.fillRect(innerLeft, innerTop, tubeSheetThickness, innerH);
    if (hxType === 'straight') {
      ctx.fillRect(innerLeft + innerW - tubeSheetThickness, innerTop, tubeSheetThickness, innerH);
    }
  } else {
    // VERTICAL ORIENTATION: tubes run bottom-to-top
    const tubeSpacing = innerW / (visualTubeCount + 1);
    const tubeRadius = Math.max(Math.min(tubeSpacing * 0.25, 6), 2);

    for (let i = 0; i < visualTubeCount; i++) {
      const x = innerLeft + tubeSpacing * (i + 1);

      if (hxType === 'straight') {
        // Straight tubes - go all the way through vertically with tube sheets at both ends
        ctx.fillStyle = COLORS.steel;
        ctx.fillRect(x - tubeRadius - tubeWall, innerTop + tubeSheetThickness, (tubeRadius + tubeWall) * 2, innerH - tubeSheetThickness * 2);

        ctx.fillStyle = primaryColor;
        ctx.fillRect(x - tubeRadius, innerTop + tubeSheetThickness + tubeWall, tubeRadius * 2, innerH - tubeSheetThickness * 2 - tubeWall * 2);
      } else if (hxType === 'helical') {
        // Helical coil - draw as a wavy/zigzag pattern to suggest coiled tubes
        ctx.strokeStyle = COLORS.steel;
        ctx.lineWidth = (tubeRadius + tubeWall) * 2;
        ctx.beginPath();
        const waveAmplitude = tubeSpacing * 0.3;
        const waveFreq = 8; // Number of waves along the height
        for (let j = 0; j <= waveFreq; j++) {
          const yPos = innerTop + tubeSheetThickness + (innerH - tubeSheetThickness - 10) * (j / waveFreq);
          const xOffset = (j % 2 === 0) ? -waveAmplitude : waveAmplitude;
          if (j === 0) {
            ctx.moveTo(x + xOffset, yPos);
          } else {
            ctx.lineTo(x + xOffset, yPos);
          }
        }
        ctx.stroke();

        // Inner helical (primary fluid)
        ctx.strokeStyle = primaryColor;
        ctx.lineWidth = tubeRadius * 2;
        ctx.beginPath();
        for (let j = 0; j <= waveFreq; j++) {
          const yPos = innerTop + tubeSheetThickness + (innerH - tubeSheetThickness - 10) * (j / waveFreq);
          const xOffset = (j % 2 === 0) ? -waveAmplitude : waveAmplitude;
          if (j === 0) {
            ctx.moveTo(x + xOffset, yPos);
          } else {
            ctx.lineTo(x + xOffset, yPos);
          }
        }
        ctx.stroke();
      } else {
        // U-tube - tubes with tube sheet at BOTTOM and U-bends at TOP (standard SG configuration)
        ctx.fillStyle = COLORS.steel;
        ctx.fillRect(x - tubeRadius - tubeWall, innerTop + 10, (tubeRadius + tubeWall) * 2, innerH - tubeSheetThickness - 10);

        ctx.fillStyle = primaryColor;
        ctx.fillRect(x - tubeRadius, innerTop + 10 + tubeWall, tubeRadius * 2, innerH - tubeSheetThickness - 10 - tubeWall * 2);

        // U-bend at TOP
        ctx.fillStyle = COLORS.steel;
        ctx.beginPath();
        ctx.arc(x, innerTop + 10, tubeRadius + tubeWall, Math.PI, 0);
        ctx.fill();

        ctx.fillStyle = primaryColor;
        ctx.beginPath();
        ctx.arc(x, innerTop + 10, tubeRadius, Math.PI, 0);
        ctx.fill();

        // Tube header at bottom (inlet/outlet plenum)
        ctx.fillStyle = COLORS.steel;
        ctx.beginPath();
        ctx.arc(x, innerTop + innerH - tubeSheetThickness, tubeRadius + tubeWall, 0, Math.PI);
        ctx.fill();

        ctx.fillStyle = primaryColor;
        ctx.beginPath();
        ctx.arc(x, innerTop + innerH - tubeSheetThickness, tubeRadius, 0, Math.PI);
        ctx.fill();
      }
    }

    // Draw tube sheet(s) - horizontal for vertical orientation
    ctx.fillStyle = COLORS.steelDark;
    if (hxType === 'straight') {
      // Straight tubes have tube sheets at both ends
      ctx.fillRect(innerLeft, innerTop, innerW, tubeSheetThickness);
      ctx.fillRect(innerLeft, innerTop + innerH - tubeSheetThickness, innerW, tubeSheetThickness);
    } else if (hxType === 'utube') {
      // U-tube has tube sheet at bottom only
      ctx.fillRect(innerLeft, innerTop + innerH - tubeSheetThickness, innerW, tubeSheetThickness);
    } else {
      // Helical has tube sheet at bottom
      ctx.fillRect(innerLeft, innerTop + innerH - tubeSheetThickness, innerW, tubeSheetThickness);
    }
  }

  // Outline
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 2;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
}

function renderTurbineGenerator(ctx: CanvasRenderingContext2D, turbine: TurbineGeneratorComponent, view: ViewState): void {
  const w = turbine.width * view.zoom;
  const h = turbine.height * view.zoom;

  // Determine inlet/exhaust sides based on orientation
  // orientation 'left-right' means inlet on left (small), exhaust on right (large)
  // orientation 'right-left' means inlet on right (small), exhaust on left (large)
  const isLeftRight = turbine.orientation !== 'right-left';

  // Inlet (HP) side is smaller, exhaust (LP) side is larger
  const inletH = h * 0.4;   // HP end is ~40% of exhaust diameter
  const exhaustH = h;        // LP end is full diameter

  // Turbine casing - trapezoidal shape (small at inlet, large at exhaust)
  ctx.fillStyle = COLORS.steel;
  ctx.beginPath();
  if (isLeftRight) {
    // Inlet left, exhaust right
    ctx.moveTo(-w / 2, -inletH / 2);      // Top left (inlet - small)
    ctx.lineTo(w / 2, -exhaustH / 2);     // Top right (exhaust - large)
    ctx.lineTo(w / 2, exhaustH / 2);      // Bottom right
    ctx.lineTo(-w / 2, inletH / 2);       // Bottom left (inlet - small)
  } else {
    // Inlet right, exhaust left
    ctx.moveTo(-w / 2, -exhaustH / 2);    // Top left (exhaust - large)
    ctx.lineTo(w / 2, -inletH / 2);       // Top right (inlet - small)
    ctx.lineTo(w / 2, inletH / 2);        // Bottom right
    ctx.lineTo(-w / 2, exhaustH / 2);     // Bottom left (exhaust - large)
  }
  ctx.closePath();
  ctx.fill();

  // Steam path visualization (if running)
  if (turbine.running && turbine.inletFluid) {
    ctx.fillStyle = getFluidColor(turbine.inletFluid);
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    if (isLeftRight) {
      ctx.moveTo(-w / 2 + 5, -inletH / 2 + 5);
      ctx.lineTo(w / 2 - 5, -exhaustH / 2 + 5);
      ctx.lineTo(w / 2 - 5, exhaustH / 2 - 5);
      ctx.lineTo(-w / 2 + 5, inletH / 2 - 5);
    } else {
      ctx.moveTo(-w / 2 + 5, -exhaustH / 2 + 5);
      ctx.lineTo(w / 2 - 5, -inletH / 2 + 5);
      ctx.lineTo(w / 2 - 5, inletH / 2 - 5);
      ctx.lineTo(-w / 2 + 5, exhaustH / 2 - 5);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }

  // Rotor shaft (horizontal line through center)
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(-w / 2 - 10, -3, w + 20, 6);

  // Blades representation (vertical lines inside the casing)
  // Number of blade rows scales with turbine stages
  ctx.strokeStyle = turbine.running ? '#aabbcc' : '#556677';
  ctx.lineWidth = 2;
  const bladeCount = Math.max(4, (turbine.stages || 3) * 2);
  for (let i = 0; i < bladeCount; i++) {
    const x = -w / 2 + (w / (bladeCount + 1)) * (i + 1);
    // Blade height increases from inlet to exhaust
    const progress = (i + 1) / (bladeCount + 1);
    const bladeProgress = isLeftRight ? progress : (1 - progress);
    const bladeH = inletH / 2 + (exhaustH - inletH) / 2 * bladeProgress;
    ctx.beginPath();
    ctx.moveTo(x, -bladeH + 3);
    ctx.lineTo(x, bladeH - 3);
    ctx.stroke();
  }

  // Generator at the exhaust end
  const genR = exhaustH / 3;
  const genX = isLeftRight ? (w / 2 + genR + 5) : (-w / 2 - genR - 5);
  ctx.fillStyle = COLORS.steel;
  ctx.beginPath();
  ctx.arc(genX, 0, genR, 0, Math.PI * 2);
  ctx.fill();

  // Generator outline
  ctx.strokeStyle = turbine.running ? COLORS.safe : '#666';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(genX, 0, genR, 0, Math.PI * 2);
  ctx.stroke();

  // Power indicator - get actual power from simulation state
  const turbineStats = getTurbineCondenserState();
  const powerMW = turbineStats.turbinePower / 1e6;
  if (powerMW > 0 || turbine.running) {
    const fontSize = Math.max(8, 10 * view.zoom / 60); // Scale with zoom, min 8px
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.fillStyle = '#1a1a1a'; // Dark text for readability
    ctx.textAlign = 'center';
    ctx.fillText(`${powerMW.toFixed(0)} MW`, genX, genR + 15);
  }

  // Turbine outline
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (isLeftRight) {
    ctx.moveTo(-w / 2, -inletH / 2);
    ctx.lineTo(w / 2, -exhaustH / 2);
    ctx.lineTo(w / 2, exhaustH / 2);
    ctx.lineTo(-w / 2, inletH / 2);
  } else {
    ctx.moveTo(-w / 2, -exhaustH / 2);
    ctx.lineTo(w / 2, -inletH / 2);
    ctx.lineTo(w / 2, inletH / 2);
    ctx.lineTo(-w / 2, exhaustH / 2);
  }
  ctx.closePath();
  ctx.stroke();
}

function renderTurbineDrivenPump(ctx: CanvasRenderingContext2D, tdPump: TurbineDrivenPumpComponent, view: ViewState): void {
  // Turbine-driven pump with trapezoidal turbine and centrifugal pump volute
  const w = tdPump.width * view.zoom;
  const h = tdPump.height * view.zoom;

  const isLeftRight = tdPump.orientation !== 'right-left';

  // Layout: turbine on one side, shaft, pump on other side
  const turbineW = w * 0.38;
  const pumpW = w * 0.5;

  // Turbine dimensions - FLIPPED: large end (inlet) away from pump, small end (exhaust) toward pump
  const turbineInletH = h * 0.7;   // Large end (away from pump)
  const turbineExhaustH = h * 0.4; // Small end (toward pump)
  const turbineX = isLeftRight ? -w / 2 + turbineW / 2 : w / 2 - turbineW / 2;

  // Pump dimensions
  const pumpR = Math.min(pumpW, h) * 0.4;
  const pumpX = isLeftRight ? w / 2 - pumpW / 2 : -w / 2 + pumpW / 2;

  // ===== TURBINE (trapezoidal, large end away from pump) =====
  ctx.fillStyle = COLORS.steel;
  ctx.beginPath();
  if (isLeftRight) {
    // Large end on left (inlet), small end on right (exhaust toward pump)
    ctx.moveTo(turbineX - turbineW / 2, -turbineInletH / 2);   // Top left (large)
    ctx.lineTo(turbineX + turbineW / 2, -turbineExhaustH / 2); // Top right (small)
    ctx.lineTo(turbineX + turbineW / 2, turbineExhaustH / 2);  // Bottom right (small)
    ctx.lineTo(turbineX - turbineW / 2, turbineInletH / 2);    // Bottom left (large)
  } else {
    // Large end on right (inlet), small end on left (exhaust toward pump)
    ctx.moveTo(turbineX - turbineW / 2, -turbineExhaustH / 2); // Top left (small)
    ctx.lineTo(turbineX + turbineW / 2, -turbineInletH / 2);   // Top right (large)
    ctx.lineTo(turbineX + turbineW / 2, turbineInletH / 2);    // Bottom right (large)
    ctx.lineTo(turbineX - turbineW / 2, turbineExhaustH / 2);  // Bottom left (small)
  }
  ctx.closePath();
  ctx.fill();

  // Steam flow visualization inside turbine
  if (tdPump.running && tdPump.inletFluid) {
    ctx.fillStyle = getFluidColor(tdPump.inletFluid);
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    if (isLeftRight) {
      ctx.moveTo(turbineX - turbineW / 2 + 3, -turbineInletH / 2 + 3);
      ctx.lineTo(turbineX + turbineW / 2 - 3, -turbineExhaustH / 2 + 3);
      ctx.lineTo(turbineX + turbineW / 2 - 3, turbineExhaustH / 2 - 3);
      ctx.lineTo(turbineX - turbineW / 2 + 3, turbineInletH / 2 - 3);
    } else {
      ctx.moveTo(turbineX - turbineW / 2 + 3, -turbineExhaustH / 2 + 3);
      ctx.lineTo(turbineX + turbineW / 2 - 3, -turbineInletH / 2 + 3);
      ctx.lineTo(turbineX + turbineW / 2 - 3, turbineInletH / 2 - 3);
      ctx.lineTo(turbineX - turbineW / 2 + 3, turbineExhaustH / 2 - 3);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }

  // Turbine blade rows - darker and thicker for visibility
  ctx.strokeStyle = tdPump.running ? '#556677' : '#3a4455';
  ctx.lineWidth = 3;
  const bladeCount = Math.max(4, (tdPump.stages || 2) * 2);
  for (let i = 0; i < bladeCount; i++) {
    const x = turbineX - turbineW / 2 + (turbineW / (bladeCount + 1)) * (i + 1);
    const progress = (i + 1) / (bladeCount + 1);
    // Blades shrink from inlet (large) to exhaust (small)
    const bladeProgress = isLeftRight ? progress : (1 - progress);
    const bladeH = turbineInletH / 2 - (turbineInletH - turbineExhaustH) / 2 * bladeProgress;
    ctx.beginPath();
    ctx.moveTo(x, -bladeH + 4);
    ctx.lineTo(x, bladeH - 4);
    ctx.stroke();
  }

  // Turbine outline
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (isLeftRight) {
    ctx.moveTo(turbineX - turbineW / 2, -turbineInletH / 2);
    ctx.lineTo(turbineX + turbineW / 2, -turbineExhaustH / 2);
    ctx.lineTo(turbineX + turbineW / 2, turbineExhaustH / 2);
    ctx.lineTo(turbineX - turbineW / 2, turbineInletH / 2);
  } else {
    ctx.moveTo(turbineX - turbineW / 2, -turbineExhaustH / 2);
    ctx.lineTo(turbineX + turbineW / 2, -turbineInletH / 2);
    ctx.lineTo(turbineX + turbineW / 2, turbineInletH / 2);
    ctx.lineTo(turbineX - turbineW / 2, turbineExhaustH / 2);
  }
  ctx.closePath();
  ctx.stroke();

  // ===== SHAFT connecting turbine exhaust to pump center =====
  const shaftY = 0;
  const shaftH = 8;
  ctx.fillStyle = COLORS.steelDark;
  const shaftStart = isLeftRight ? turbineX + turbineW / 2 : pumpX;
  const shaftEnd = isLeftRight ? pumpX : turbineX - turbineW / 2;
  ctx.fillRect(Math.min(shaftStart, shaftEnd), shaftY - shaftH / 2, Math.abs(shaftEnd - shaftStart), shaftH);

  // Coupling flange
  const couplingX = (turbineX + pumpX) / 2;
  ctx.fillStyle = COLORS.steelDark;
  ctx.beginPath();
  ctx.arc(couplingX, shaftY, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 1;
  ctx.stroke();

  // ===== PUMP (centrifugal volute - ~300 deg spiral with outlet up, inlet below) =====
  // The volute is a circle that bulges out on one side into a tangential discharge nozzle

  // Main pump casing (base circle)
  ctx.fillStyle = COLORS.steel;
  ctx.beginPath();
  ctx.arc(pumpX, 0, pumpR, 0, Math.PI * 2);
  ctx.fill();

  // Volute bulge - extends from the base circle toward the discharge
  // The bulge is on the side opposite to where the shaft enters
  const bulgeDir = isLeftRight ? 1 : -1; // Bulge away from turbine
  const bulgeAngleStart = -Math.PI * 0.6;
  const bulgeAngleEnd = -Math.PI * 0.15;

  ctx.fillStyle = COLORS.steel;
  ctx.beginPath();
  const bulgeSteps = 20;
  for (let i = 0; i <= bulgeSteps; i++) {
    const t = i / bulgeSteps;
    const angle = bulgeAngleStart + t * (bulgeAngleEnd - bulgeAngleStart);
    const bulgeFactor = Math.sin(t * Math.PI) * 0.35;
    const r = pumpR * (1 + bulgeFactor);
    const x = pumpX + Math.cos(angle) * r * bulgeDir;
    const y = Math.sin(angle) * r;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.fill();

  // Discharge nozzle pointing UP (tangent to the spiral)
  const nozzleWidth = pumpR * 0.35;
  const nozzleLength = pumpR * 0.6;
  const nozzleX = pumpX + bulgeDir * pumpR * 0.5;
  const nozzleTop = -pumpR - nozzleLength;

  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(nozzleX - nozzleWidth / 2, nozzleTop, nozzleWidth, nozzleLength + pumpR * 0.3);

  // Nozzle flange at top
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(nozzleX - nozzleWidth * 0.7, nozzleTop - 4, nozzleWidth * 1.4, 6);

  // Inlet nozzle from BELOW (suction - center of pump)
  const inletWidth = pumpR * 0.4;
  const inletLength = pumpR * 0.5;

  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(pumpX - inletWidth / 2, pumpR - 2, inletWidth, inletLength);

  // Inlet flange at bottom
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(pumpX - inletWidth * 0.65, pumpR + inletLength - 2, inletWidth * 1.3, 5);

  // Pump casing outline
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(pumpX, 0, pumpR, 0, Math.PI * 2);
  ctx.stroke();

  // Draw volute bulge outline
  ctx.beginPath();
  for (let i = 0; i <= bulgeSteps; i++) {
    const t = i / bulgeSteps;
    const angle = bulgeAngleStart + t * (bulgeAngleEnd - bulgeAngleStart);
    const bulgeFactor = Math.sin(t * Math.PI) * 0.35;
    const r = pumpR * (1 + bulgeFactor);
    const x = pumpX + Math.cos(angle) * r * bulgeDir;
    const y = Math.sin(angle) * r;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  // Discharge nozzle outline
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(nozzleX - nozzleWidth / 2, nozzleTop, nozzleWidth, nozzleLength + pumpR * 0.3);

  // Inlet nozzle outline
  ctx.strokeRect(pumpX - inletWidth / 2, pumpR - 2, inletWidth, inletLength + 2);

  // Shaft end visible at pump center
  ctx.fillStyle = COLORS.steelDark;
  ctx.beginPath();
  ctx.arc(pumpX, 0, pumpR * 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Flow indicator if running
  if (tdPump.running && tdPump.pumpFlow > 0) {
    ctx.font = '9px monospace';
    ctx.fillStyle = '#8cf';
    ctx.textAlign = 'center';
    ctx.fillText(`${tdPump.pumpFlow.toFixed(0)} kg/s`, pumpX, pumpR + inletLength + 18);
  }
}

function renderCondenser(ctx: CanvasRenderingContext2D, condenser: CondenserComponent, view: ViewState): void {
  const w = condenser.width * view.zoom;
  const h = condenser.height * view.zoom;
  const wallPx = 4;

  // Shell (outer rectangle)
  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(-w / 2, -h / 2, w, h);

  // Inner cavity - filled with low-pressure steam/condensate
  const innerW = w - wallPx * 2;
  const innerH = h - wallPx * 2;
  const innerLeft = -w / 2 + wallPx;
  const innerTop = -h / 2 + wallPx;

  if (condenser.fluid) {
    if (condenser.fluid.phase === 'two-phase') {
      // Stratified: condensate at bottom, steam at top
      // Condenser always uses quality-based calculation (no stored fillLevel)
      const liquidFraction = getLiquidFraction(condenser, condenser.fluid, true);
      const separation = condenser.fluid.separation ?? 1;
      renderStratifiedTwoPhase(ctx, condenser.fluid, innerLeft, innerTop, innerW, innerH, liquidFraction, separation);
    } else {
      ctx.fillStyle = getFluidColor(condenser.fluid);
      ctx.fillRect(innerLeft, innerTop, innerW, innerH);
    }
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(innerLeft, innerTop, innerW, innerH);
  }

  // Cooling water tubes (horizontal, showing cross-section as circles)
  // Limit visual tube count for rendering performance (actual tubeCount used for heat transfer)
  const visualTubeRows = Math.min(condenser.tubeCount, 8);
  const tubeSpacing = innerH / (visualTubeRows + 1);
  const tubeRadius = Math.min(tubeSpacing * 0.3, 4);

  // Draw tube bank as a grid of circles
  const tubeCols = Math.min(Math.floor(innerW / (tubeRadius * 4)), 12);
  for (let row = 0; row < visualTubeRows; row++) {
    const y = innerTop + tubeSpacing * (row + 1);
    for (let col = 0; col < tubeCols; col++) {
      const x = innerLeft + (innerW / (tubeCols + 1)) * (col + 1);

      // Tube wall
      ctx.fillStyle = COLORS.steel;
      ctx.beginPath();
      ctx.arc(x, y, tubeRadius + 1, 0, Math.PI * 2);
      ctx.fill();

      // Cooling water inside (blue for cold water)
      ctx.fillStyle = '#4488cc';
      ctx.beginPath();
      ctx.arc(x, y, tubeRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Heat rejection indicator - get actual heat rejection from simulation state
  const condenserStats = getTurbineCondenserState();
  const heatMW = condenserStats.condenserHeatRejection / 1e6;
  const fontSize = Math.max(8, 10 * view.zoom / 60); // Scale with zoom, min 8px
  const smallFontSize = Math.max(6, 8 * view.zoom / 60);
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.fillStyle = '#1a1a1a'; // Dark text for readability
  ctx.textAlign = 'center';
  ctx.fillText(`${heatMW.toFixed(0)} MW`, 0, h / 2 + 15);
  ctx.font = `${smallFontSize}px monospace`;
  ctx.fillStyle = '#333';
  ctx.fillText('rejected', 0, h / 2 + 25);

  // Hotwell at bottom (condensate collection)
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(-w / 2, h / 2 - 5, w, 5);

  // Outline
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 2;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
}

function renderController(ctx: CanvasRenderingContext2D, controller: ControllerComponent, view: ViewState): void {
  const w = controller.width * view.zoom;
  const h = controller.height * view.zoom;

  // Cabinet body - dark gray metal
  ctx.fillStyle = '#3a3a4a';
  ctx.fillRect(-w / 2, -h / 2, w, h);

  // Darker border/frame
  ctx.strokeStyle = '#2a2a3a';
  ctx.lineWidth = Math.max(1, w * 0.02);
  ctx.strokeRect(-w / 2, -h / 2, w, h);

  // Warning stripes at very top (yellow/black diagonal stripes)
  const stripeHeight = h * 0.05;
  ctx.save();
  ctx.beginPath();
  ctx.rect(-w / 2 + 2, -h / 2 + 2, w - 4, stripeHeight);
  ctx.clip();

  const stripeWidth = stripeHeight;
  ctx.fillStyle = '#ffaa00';
  ctx.fillRect(-w / 2, -h / 2, w, stripeHeight + 2);
  ctx.fillStyle = '#222';
  for (let i = -5; i < 15; i++) {
    ctx.beginPath();
    ctx.moveTo(-w / 2 + i * stripeWidth, -h / 2);
    ctx.lineTo(-w / 2 + i * stripeWidth + stripeWidth / 2, -h / 2);
    ctx.lineTo(-w / 2 + i * stripeWidth + stripeWidth / 2 + stripeHeight, -h / 2 + stripeHeight);
    ctx.lineTo(-w / 2 + i * stripeWidth + stripeHeight, -h / 2 + stripeHeight);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // SCRAM label - positioned below stripes with more space
  ctx.font = `bold ${h * 0.16}px monospace`;
  ctx.fillStyle = '#ff4444';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SCRAM', 0, -h / 2 + stripeHeight + h * 0.14);

  // Status panel area (darker inset) - positioned below SCRAM label
  const panelTop = -h / 2 + stripeHeight + h * 0.24;
  const panelHeight = h * 0.22;
  ctx.fillStyle = '#1a1a2a';
  ctx.fillRect(-w / 2 + w * 0.08, panelTop, w * 0.84, panelHeight);
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(-w / 2 + w * 0.08, panelTop, w * 0.84, panelHeight);

  // Status text - simplified: just "STATUS: CONNECTED" or "STATUS: NO CORE"
  const isConnected = controller.connectedCoreId !== undefined && controller.connectedCoreId !== '';
  ctx.font = `${h * 0.09}px monospace`;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#6f6';
  ctx.fillText('STATUS:', -w / 2 + w * 0.12, panelTop + panelHeight * 0.4);
  ctx.fillStyle = isConnected ? '#6f6' : '#f66';
  ctx.fillText(isConnected ? 'CONNECTED' : 'NO CORE', -w / 2 + w * 0.12, panelTop + panelHeight * 0.7);

  // Indicator lights row
  const lightsY = panelTop + panelHeight + h * 0.07;
  const lightRadius = w * 0.05;
  const lightSpacing = w * 0.22;

  // Light 1 - Power (green if connected)
  ctx.beginPath();
  ctx.arc(-lightSpacing, lightsY, lightRadius, 0, Math.PI * 2);
  ctx.fillStyle = isConnected ? '#0f0' : '#030';
  ctx.fill();
  ctx.strokeStyle = '#333';
  ctx.lineWidth = Math.max(1, w * 0.015);
  ctx.stroke();

  // Light 2 - Status (amber)
  ctx.beginPath();
  ctx.arc(0, lightsY, lightRadius, 0, Math.PI * 2);
  ctx.fillStyle = isConnected ? '#fa0' : '#330';
  ctx.fill();
  ctx.stroke();

  // Light 3 - Alarm (red, normally off)
  ctx.beginPath();
  ctx.arc(lightSpacing, lightsY, lightRadius, 0, Math.PI * 2);
  ctx.fillStyle = '#300';
  ctx.fill();
  ctx.stroke();

  // Bottom section - buttons/switches
  const buttonY = lightsY + h * 0.12;
  const buttonSize = w * 0.08;

  // Manual SCRAM button (red)
  ctx.beginPath();
  ctx.arc(0, buttonY, buttonSize, 0, Math.PI * 2);
  ctx.fillStyle = '#c00';
  ctx.fill();
  ctx.strokeStyle = '#600';
  ctx.lineWidth = Math.max(1, w * 0.015);
  ctx.stroke();

  // Button highlight
  ctx.beginPath();
  ctx.arc(-buttonSize * 0.2, buttonY - buttonSize * 0.2, buttonSize * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,100,100,0.4)';
  ctx.fill();

  // Setpoint display at bottom
  ctx.font = `${h * 0.07}px monospace`;
  ctx.fillStyle = '#888';
  ctx.textAlign = 'center';
  const setpointY = buttonY + buttonSize + h * 0.08;
  ctx.fillText(`Hi:${controller.setpoints.highPower}%  Lo:${controller.setpoints.lowPower}%`, 0, setpointY);
  ctx.fillText(`Temp:${Math.round(controller.setpoints.highFuelTemp * 100)}%  Flow:${controller.setpoints.lowCoolantFlow}`, 0, setpointY + h * 0.09);

  // Outer highlight
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.strokeRect(-w / 2 + 1, -h / 2 + 1, w - 2, h - 2);
}

/**
 * Render a switchyard component
 * Shows transformers, equipment, power line towers, and connection to grid
 * No bounding box - outdoor equipment layout
 *
 * When worldToScreenFn is provided (isometric mode), elements are rendered at their
 * world positions with perspective projection for proper 3D appearance.
 */
function renderSwitchyard(
  ctx: CanvasRenderingContext2D,
  switchyard: SwitchyardComponent,
  view: ViewState,
  plantState?: PlantState,
  worldToScreenFn?: WorldToScreenFn
): void {
  // Get MW to grid for display
  let mwToGrid = 0;
  if (plantState && switchyard.connectedGeneratorId) {
    const generator = plantState.components.get(switchyard.connectedGeneratorId);
    if (generator && generator.type === 'turbine-generator') {
      const tg = generator as TurbineGeneratorComponent;
      mwToGrid = (tg.power || 0) / 1e6;
    }
  }

  // In isometric mode with perspective projection, render elements individually
  // at their world positions for proper 3D depth effect
  if (worldToScreenFn) {
    renderSwitchyardPerspective(ctx, switchyard, worldToScreenFn, mwToGrid);
    return;
  }

  // Non-isometric (2D) mode - use original local-coordinate rendering
  const w = switchyard.width * view.zoom;
  const h = switchyard.height * view.zoom;

  // Shadow offset for grounded appearance
  const shadowOffsetX = 3;
  const shadowOffsetY = 3;
  const shadowColor = 'rgba(0, 0, 0, 0.3)';

  // Helper: draw a shadow ellipse under equipment
  const drawShadow = (x: number, y: number, width: number, height: number) => {
    ctx.fillStyle = shadowColor;
    ctx.beginPath();
    ctx.ellipse(x + shadowOffsetX, y + height / 2 + shadowOffsetY, width / 2 * 1.1, height * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();
  };

  // Helper: draw a small transformer with shadow
  const drawTransformer = (x: number, y: number, scale: number) => {
    const tw = w * 0.08 * scale;
    const th = h * 0.15 * scale;

    // Shadow
    drawShadow(x, y, tw * 1.4, th);

    // Tank
    ctx.fillStyle = '#4a5a6a';
    ctx.fillRect(x - tw / 2, y - th / 2, tw, th);
    ctx.strokeStyle = '#3a4a5a';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - tw / 2, y - th / 2, tw, th);
    // Cooling fins
    ctx.fillStyle = '#5a6a7a';
    ctx.fillRect(x - tw / 2 - tw * 0.15, y - th * 0.3, tw * 0.12, th * 0.6);
    ctx.fillRect(x + tw / 2 + tw * 0.03, y - th * 0.3, tw * 0.12, th * 0.6);
    // Bushings on top
    ctx.fillStyle = '#c9b896';
    for (let i = 0; i < 3; i++) {
      const bx = x - tw * 0.25 + i * tw * 0.25;
      ctx.fillRect(bx - w * 0.008, y - th / 2 - h * 0.04, w * 0.016, h * 0.04);
    }
  };

  // Helper: draw a small equipment box (breaker, disconnect, etc.) with shadow
  const drawEquipment = (x: number, y: number, type: 'breaker' | 'disconnect' | 'box') => {
    const size = w * 0.025;

    // Shadow
    const eqHeight = type === 'disconnect' ? size * 1.2 : size * 2;
    drawShadow(x, y, size, eqHeight * 0.5);

    if (type === 'breaker') {
      ctx.fillStyle = '#5a6a7a';
      ctx.fillRect(x - size / 2, y - size, size, size * 2);
      // Status light
      ctx.beginPath();
      ctx.arc(x, y - size * 0.5, size * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = '#0f0';
      ctx.fill();
    } else if (type === 'disconnect') {
      ctx.fillStyle = '#c9b896';
      ctx.fillRect(x - size * 0.3, y - size * 1.2, size * 0.6, size * 1.2);
    } else {
      ctx.fillStyle = '#6a7a8a';
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }
  };

  // Helper: draw a transmission tower with shadow
  const drawTower = (x: number, y: number, scale: number = 1) => {
    const tw = w * 0.04 * scale;
    const th = h * 0.18 * scale;

    // Shadow at base
    ctx.fillStyle = shadowColor;
    ctx.beginPath();
    ctx.ellipse(x + shadowOffsetX, y + th * 0.5 + shadowOffsetY, tw * 0.8, th * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#444';
    // Tower legs (tapered)
    ctx.beginPath();
    ctx.moveTo(x - tw * 0.6, y + th * 0.5);
    ctx.lineTo(x + tw * 0.6, y + th * 0.5);
    ctx.lineTo(x + tw * 0.2, y - th * 0.5);
    ctx.lineTo(x - tw * 0.2, y - th * 0.5);
    ctx.closePath();
    ctx.fill();
    // Cross arms
    ctx.fillStyle = '#555';
    ctx.fillRect(x - tw, y - th * 0.4, tw * 2, th * 0.06);
    ctx.fillRect(x - tw * 0.8, y - th * 0.2, tw * 1.6, th * 0.05);
    // Insulators
    ctx.fillStyle = '#c9b896';
    for (let i = -1; i <= 1; i++) {
      ctx.fillRect(x + i * tw * 0.6 - w * 0.006, y - th * 0.4 - h * 0.02, w * 0.012, h * 0.025);
    }
  };

  // No background box - switchyard is outdoors
  // Equipment is drawn directly on the ground with shadows

  // Row 1: Transformers (left side)
  const txY1 = -h * 0.25;
  const txY2 = h * 0.15;
  drawTransformer(-w * 0.35, txY1, 1.2);  // Main transformer
  drawTransformer(-w * 0.35, txY2, 0.9);  // Aux transformer
  drawTransformer(-w * 0.15, txY1, 0.8);
  drawTransformer(-w * 0.15, txY2, 0.8);

  // Equipment in between
  drawEquipment(-w * 0.25, txY1, 'breaker');
  drawEquipment(-w * 0.25, txY2, 'breaker');
  drawEquipment(-w * 0.05, txY1, 'disconnect');
  drawEquipment(-w * 0.05, txY2, 'disconnect');
  drawEquipment(-w * 0.05, 0, 'box');
  drawEquipment(w * 0.02, txY1, 'breaker');
  drawEquipment(w * 0.02, txY2, 'breaker');

  // Bus bars (horizontal conductors)
  ctx.strokeStyle = '#808080';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-w * 0.4, txY1 - h * 0.12);
  ctx.lineTo(w * 0.1, txY1 - h * 0.12);
  ctx.moveTo(-w * 0.4, txY2 + h * 0.12);
  ctx.lineTo(w * 0.1, txY2 + h * 0.12);
  ctx.stroke();

  // Transmission towers in a row going to the right
  const towerCount = Math.max(switchyard.offsiteLines, 2);
  const towerSpacing = h * 0.25;
  const towerStartY = -((towerCount - 1) * towerSpacing) / 2;

  for (let i = 0; i < towerCount; i++) {
    const ty = towerStartY + i * towerSpacing;
    drawTower(w * 0.15, ty, 0.9);
    drawTower(w * 0.28, ty, 1.0);
  }

  // Lines connecting to towers
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < towerCount; i++) {
    const ty = towerStartY + i * towerSpacing;
    ctx.beginPath();
    ctx.moveTo(w * 0.1, i < towerCount / 2 ? txY1 - h * 0.12 : txY2 + h * 0.12);
    ctx.lineTo(w * 0.15, ty - h * 0.07);
    ctx.lineTo(w * 0.28, ty - h * 0.08);
    ctx.lineTo(w * 0.42, ty);
    ctx.stroke();
  }

  // Grid label on the right
  ctx.font = `bold ${h * 0.09}px sans-serif`;
  ctx.fillStyle = '#666';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Grid`, w * 0.35, -h * 0.4);
  ctx.font = `${h * 0.07}px sans-serif`;
  ctx.fillStyle = '#555';
  ctx.fillText(`(${switchyard.transmissionVoltage} kV)`, w * 0.35, -h * 0.28);

  // Arrow pointing to grid
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w * 0.42, 0);
  ctx.lineTo(w * 0.48, 0);
  ctx.stroke();
  // Arrowhead
  ctx.beginPath();
  ctx.moveTo(w * 0.48, 0);
  ctx.lineTo(w * 0.45, -h * 0.03);
  ctx.lineTo(w * 0.45, h * 0.03);
  ctx.closePath();
  ctx.fillStyle = '#555';
  ctx.fill();

  // Display MW prominently
  ctx.font = `bold ${h * 0.14}px sans-serif`;
  ctx.fillStyle = mwToGrid > 0 ? '#4f4' : '#666';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${mwToGrid.toFixed(0)} MW`, -w * 0.25, h * 0.42);

  // Reliability indicator (positioned to the right of MW display)
  const reliabilityColors: Record<string, string> = {
    'standard': '#777',
    'enhanced': '#8a8',
    'highly-reliable': '#4a4'
  };
  ctx.fillStyle = reliabilityColors[switchyard.reliabilityClass] || '#777';
  ctx.font = `${h * 0.05}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(switchyard.reliabilityClass.toUpperCase(), w * 0.05, h * 0.42);

  // Note: The dashed electrical connection to the generator is drawn in canvas.ts
  // using absolute screen coordinates (similar to controller wires)
}

/**
 * Render switchyard with perspective projection for isometric mode.
 * Elements at different world-Y positions get different scales for depth effect.
 */
function renderSwitchyardPerspective(
  ctx: CanvasRenderingContext2D,
  switchyard: SwitchyardComponent,
  worldToScreenFn: WorldToScreenFn,
  mwToGrid: number
): void {
  // Reset canvas transform to DPR-scaled identity
  // The canvas uses devicePixelRatio scaling (see CanvasRenderer.resize()),
  // so we need to preserve that scale while removing component transforms
  ctx.save();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const worldW = switchyard.width;
  const worldH = switchyard.height;

  // Project at ground level (elevation 0) to match the footprint outline
  // The footprint is axis-aligned (no rotation) via renderGroundOutline
  const centerProj = worldToScreenFn(switchyard.position, 0);
  const baseZoom = centerProj.scale * 50;

  // Convert local coordinates to world coordinates (axis-aligned, no rotation)
  // This matches how renderGroundOutline calculates footprint corners
  const project = (localX: number, localY: number): WorldToScreenResult => {
    const worldPos = {
      x: switchyard.position.x + localX,
      y: switchyard.position.y + localY,
    };
    return worldToScreenFn(worldPos, 0);
  };

  const shadowColor = 'rgba(0, 0, 0, 0.3)';

  // Debug markers removed - we'll compute corners using WORLD coordinates directly
  // matching exactly how renderGroundOutline does it

  // Helper: draw a transformer at a world position
  const drawTransformer = (localX: number, localY: number, sizeScale: number) => {
    const proj = project(localX, localY);
    const zoom = proj.scale * 50;
    const tw = worldW * 0.08 * sizeScale * zoom;
    const th = worldH * 0.15 * sizeScale * zoom;

    // Shadow
    ctx.fillStyle = shadowColor;
    ctx.beginPath();
    ctx.ellipse(proj.pos.x + 3, proj.pos.y + 3, tw * 0.7 * 1.1, th * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();

    // Tank
    ctx.fillStyle = '#4a5a6a';
    ctx.fillRect(proj.pos.x - tw / 2, proj.pos.y - th / 2, tw, th);
    ctx.strokeStyle = '#3a4a5a';
    ctx.lineWidth = 1;
    ctx.strokeRect(proj.pos.x - tw / 2, proj.pos.y - th / 2, tw, th);
    // Cooling fins
    ctx.fillStyle = '#5a6a7a';
    ctx.fillRect(proj.pos.x - tw / 2 - tw * 0.15, proj.pos.y - th * 0.3, tw * 0.12, th * 0.6);
    ctx.fillRect(proj.pos.x + tw / 2 + tw * 0.03, proj.pos.y - th * 0.3, tw * 0.12, th * 0.6);
    // Bushings on top
    ctx.fillStyle = '#c9b896';
    const bushingW = worldW * 0.008 * zoom;
    const bushingH = worldH * 0.04 * zoom;
    for (let i = 0; i < 3; i++) {
      const bx = proj.pos.x - tw * 0.25 + i * tw * 0.25;
      ctx.fillRect(bx - bushingW, proj.pos.y - th / 2 - bushingH, bushingW * 2, bushingH);
    }
  };

  // Helper: draw equipment at a world position
  const drawEquipment = (localX: number, localY: number, type: 'breaker' | 'disconnect' | 'box') => {
    const proj = project(localX, localY);
    const zoom = proj.scale * 50;
    const size = worldW * 0.025 * zoom;

    // Shadow
    const eqHeight = type === 'disconnect' ? size * 1.2 : size * 2;
    ctx.fillStyle = shadowColor;
    ctx.beginPath();
    ctx.ellipse(proj.pos.x + 3, proj.pos.y + eqHeight * 0.25 + 3, size * 0.55, eqHeight * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();

    if (type === 'breaker') {
      ctx.fillStyle = '#5a6a7a';
      ctx.fillRect(proj.pos.x - size / 2, proj.pos.y - size, size, size * 2);
      // Status light
      ctx.beginPath();
      ctx.arc(proj.pos.x, proj.pos.y - size * 0.5, size * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = '#0f0';
      ctx.fill();
    } else if (type === 'disconnect') {
      ctx.fillStyle = '#c9b896';
      ctx.fillRect(proj.pos.x - size * 0.3, proj.pos.y - size * 1.2, size * 0.6, size * 1.2);
    } else {
      ctx.fillStyle = '#6a7a8a';
      ctx.fillRect(proj.pos.x - size / 2, proj.pos.y - size / 2, size, size);
    }
  };

  // Helper: draw a transmission tower at a world position
  const drawTower = (localX: number, localY: number, sizeScale: number = 1) => {
    const proj = project(localX, localY);
    const zoom = proj.scale * 50;
    const tw = worldW * 0.04 * sizeScale * zoom;
    const th = worldH * 0.18 * sizeScale * zoom;

    // Shadow at base
    ctx.fillStyle = shadowColor;
    ctx.beginPath();
    ctx.ellipse(proj.pos.x + 3, proj.pos.y + th * 0.5 + 3, tw * 0.8, th * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#444';
    // Tower legs (tapered)
    ctx.beginPath();
    ctx.moveTo(proj.pos.x - tw * 0.6, proj.pos.y + th * 0.5);
    ctx.lineTo(proj.pos.x + tw * 0.6, proj.pos.y + th * 0.5);
    ctx.lineTo(proj.pos.x + tw * 0.2, proj.pos.y - th * 0.5);
    ctx.lineTo(proj.pos.x - tw * 0.2, proj.pos.y - th * 0.5);
    ctx.closePath();
    ctx.fill();
    // Cross arms
    ctx.fillStyle = '#555';
    ctx.fillRect(proj.pos.x - tw, proj.pos.y - th * 0.4, tw * 2, th * 0.06);
    ctx.fillRect(proj.pos.x - tw * 0.8, proj.pos.y - th * 0.2, tw * 1.6, th * 0.05);
    // Insulators
    ctx.fillStyle = '#c9b896';
    const insW = worldW * 0.006 * zoom;
    const insH = worldH * 0.025 * zoom;
    for (let i = -1; i <= 1; i++) {
      ctx.fillRect(proj.pos.x + i * tw * 0.6 - insW, proj.pos.y - th * 0.4 - insH, insW * 2, insH);
    }
  };

  // Collect all elements with their depth (localY) for back-to-front sorting
  interface DrawCommand {
    depth: number;  // localY - higher = farther back
    draw: () => void;
  }
  const drawCommands: DrawCommand[] = [];

  // Row positions (in local/world coordinates, as fractions of height)
  const rowY1 = -worldH * 0.25;  // Back row
  const rowY2 = worldH * 0.15;   // Front row

  // Transformers
  drawCommands.push({ depth: rowY1, draw: () => drawTransformer(-worldW * 0.35, rowY1, 1.2) });
  drawCommands.push({ depth: rowY2, draw: () => drawTransformer(-worldW * 0.35, rowY2, 0.9) });
  drawCommands.push({ depth: rowY1, draw: () => drawTransformer(-worldW * 0.15, rowY1, 0.8) });
  drawCommands.push({ depth: rowY2, draw: () => drawTransformer(-worldW * 0.15, rowY2, 0.8) });

  // Equipment
  drawCommands.push({ depth: rowY1, draw: () => drawEquipment(-worldW * 0.25, rowY1, 'breaker') });
  drawCommands.push({ depth: rowY2, draw: () => drawEquipment(-worldW * 0.25, rowY2, 'breaker') });
  drawCommands.push({ depth: rowY1, draw: () => drawEquipment(-worldW * 0.05, rowY1, 'disconnect') });
  drawCommands.push({ depth: rowY2, draw: () => drawEquipment(-worldW * 0.05, rowY2, 'disconnect') });
  drawCommands.push({ depth: 0, draw: () => drawEquipment(-worldW * 0.05, 0, 'box') });
  drawCommands.push({ depth: rowY1, draw: () => drawEquipment(worldW * 0.02, rowY1, 'breaker') });
  drawCommands.push({ depth: rowY2, draw: () => drawEquipment(worldW * 0.02, rowY2, 'breaker') });

  // Transmission towers
  const towerCount = Math.max(switchyard.offsiteLines, 2);
  const towerSpacing = worldH * 0.25;
  const towerStartY = -((towerCount - 1) * towerSpacing) / 2;

  for (let i = 0; i < towerCount; i++) {
    const ty = towerStartY + i * towerSpacing;
    drawCommands.push({ depth: ty, draw: () => drawTower(worldW * 0.15, ty, 0.9) });
    drawCommands.push({ depth: ty, draw: () => drawTower(worldW * 0.28, ty, 1.0) });
  }

  // Sort back-to-front (smaller Y = farther back = draw first)
  drawCommands.sort((a, b) => a.depth - b.depth);

  // Draw all elements
  for (const cmd of drawCommands) {
    cmd.draw();
  }

  // Bus bars (horizontal conductors) - draw after sorting since they span multiple depths
  ctx.strokeStyle = '#808080';
  ctx.lineWidth = 2;
  // Back bus bar
  const busBackLeft = project(-worldW * 0.4, rowY1 - worldH * 0.12);
  const busBackRight = project(worldW * 0.1, rowY1 - worldH * 0.12);
  ctx.beginPath();
  ctx.moveTo(busBackLeft.pos.x, busBackLeft.pos.y);
  ctx.lineTo(busBackRight.pos.x, busBackRight.pos.y);
  ctx.stroke();
  // Front bus bar
  const busFrontLeft = project(-worldW * 0.4, rowY2 + worldH * 0.12);
  const busFrontRight = project(worldW * 0.1, rowY2 + worldH * 0.12);
  ctx.beginPath();
  ctx.moveTo(busFrontLeft.pos.x, busFrontLeft.pos.y);
  ctx.lineTo(busFrontRight.pos.x, busFrontRight.pos.y);
  ctx.stroke();

  // Lines connecting to towers
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < towerCount; i++) {
    const ty = towerStartY + i * towerSpacing;
    const startY = i < towerCount / 2 ? rowY1 - worldH * 0.12 : rowY2 + worldH * 0.12;
    const p1 = project(worldW * 0.1, startY);
    const p2 = project(worldW * 0.15, ty - worldH * 0.07);
    const p3 = project(worldW * 0.28, ty - worldH * 0.08);
    const p4 = project(worldW * 0.42, ty);
    ctx.beginPath();
    ctx.moveTo(p1.pos.x, p1.pos.y);
    ctx.lineTo(p2.pos.x, p2.pos.y);
    ctx.lineTo(p3.pos.x, p3.pos.y);
    ctx.lineTo(p4.pos.x, p4.pos.y);
    ctx.stroke();
  }

  // Grid label on the right (use back-row y for placement)
  const labelPos = project(worldW * 0.35, rowY1);
  const labelZoom = labelPos.scale * 50;
  ctx.font = `bold ${worldH * 0.09 * labelZoom}px sans-serif`;
  ctx.fillStyle = '#666';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Grid`, labelPos.pos.x, labelPos.pos.y);
  const voltPos = project(worldW * 0.35, rowY1 + worldH * 0.12);
  ctx.font = `${worldH * 0.07 * labelZoom}px sans-serif`;
  ctx.fillStyle = '#555';
  ctx.fillText(`(${switchyard.transmissionVoltage} kV)`, voltPos.pos.x, voltPos.pos.y);

  // Arrow pointing to grid (at center depth)
  const arrowStart = project(worldW * 0.42, 0);
  const arrowEnd = project(worldW * 0.48, 0);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(arrowStart.pos.x, arrowStart.pos.y);
  ctx.lineTo(arrowEnd.pos.x, arrowEnd.pos.y);
  ctx.stroke();
  // Arrowhead
  const arrowH = worldH * 0.03 * baseZoom;
  ctx.beginPath();
  ctx.moveTo(arrowEnd.pos.x, arrowEnd.pos.y);
  ctx.lineTo(arrowEnd.pos.x - arrowH, arrowEnd.pos.y - arrowH);
  ctx.lineTo(arrowEnd.pos.x - arrowH, arrowEnd.pos.y + arrowH);
  ctx.closePath();
  ctx.fillStyle = '#555';
  ctx.fill();

  // Display MW prominently (at front-center)
  const mwPos = project(-worldW * 0.25, rowY2 + worldH * 0.27);
  const mwZoom = mwPos.scale * 50;
  ctx.font = `bold ${worldH * 0.14 * mwZoom}px sans-serif`;
  ctx.fillStyle = mwToGrid > 0 ? '#4f4' : '#666';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${mwToGrid.toFixed(0)} MW`, mwPos.pos.x, mwPos.pos.y);

  // Reliability indicator (positioned to the right of MW display)
  const reliabilityColors: Record<string, string> = {
    'standard': '#777',
    'enhanced': '#8a8',
    'highly-reliable': '#4a4'
  };
  const relPos = project(worldW * 0.05, rowY2 + worldH * 0.27);
  const relZoom = relPos.scale * 50;
  ctx.fillStyle = reliabilityColors[switchyard.reliabilityClass] || '#777';
  ctx.font = `${worldH * 0.05 * relZoom}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(switchyard.reliabilityClass.toUpperCase(), relPos.pos.x, relPos.pos.y);

  // Restore the canvas transform
  ctx.restore();
}

function renderPorts(ctx: CanvasRenderingContext2D, component: PlantComponent, view: ViewState): void {
  // Small port indicators on components (larger interactive ports are in renderPortIndicators)
  for (const port of component.ports) {
    const px = port.position.x * view.zoom;
    const py = port.position.y * view.zoom;

    // Use direction-based colors: green for inlet, red for outlet, blue for bidirectional
    // Connected ports become gray
    let portColor: string;
    if (port.connectedTo) {
      portColor = COLORS.portConnected;
    } else if (port.direction === 'in') {
      portColor = COLORS.portInlet;
    } else if (port.direction === 'out') {
      portColor = COLORS.portOutlet;
    } else {
      portColor = COLORS.portBidirectional;
    }

    // Small port circles (arrows are drawn in renderPortIndicators for connect mode)
    const portRadius = 4;

    ctx.fillStyle = portColor;
    ctx.beginPath();
    ctx.arc(px, py, portRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function getComponentBounds(component: PlantComponent, view: ViewState): { x: number; y: number; width: number; height: number } {
  // Return bounding box in local coordinates (pre-rotation)
  switch (component.type) {
    case 'tank':
      return {
        x: -component.width * view.zoom / 2 - 5,
        y: -component.height * view.zoom / 2 - 5,
        width: component.width * view.zoom + 10,
        height: component.height * view.zoom + 10,
      };
    case 'pipe':
      return {
        x: -5,
        y: -component.diameter * view.zoom / 2 - 5,
        width: component.length * view.zoom + 10,
        height: component.diameter * view.zoom + 10,
      };
    case 'pump':
      // Upright RCP-style pump bounds
      // Layout: motor + coupling + casing + suction nozzle + inlet pipe
      const pumpScale = component.diameter * view.zoom * 1.3; // 30% bigger
      const pumpBodyHeight = pumpScale * (0.9 + 0.15 + 0.5 + 0.35); // motor + coupling + casing + nozzle = 1.9
      const pumpInletPipe = pumpScale * 0.3; // inlet pipe below nozzle
      const pumpTotalHeight = pumpBodyHeight + pumpInletPipe; // = 2.2 * scale
      const pumpBodyWidth = pumpScale * 0.75; // casing width
      const pumpVoluteBulge = pumpScale * 0.18;
      const pumpOutletPipe = pumpScale * 0.45;
      // Account for orientation
      const pumpOrientation = (component as any).orientation || 'left-right';
      const isHorizontal = pumpOrientation === 'bottom-top' || pumpOrientation === 'top-bottom';

      if (isHorizontal) {
        // For horizontal orientations, swap width and height
        const hWidth = pumpTotalHeight;  // vertical height becomes horizontal width
        const hHeight = pumpBodyWidth + pumpVoluteBulge + pumpOutletPipe;  // horizontal extent becomes height
        return {
          x: -hWidth / 2 - 5,
          y: -hHeight / 2 - 5,
          width: hWidth + 10,
          height: hHeight + 10,
        };
      } else {
        // Vertical orientations (left-right, right-left)
        // The pump is drawn centered on pumpBodyHeight, with inlet pipe extending below
        // So top is at -pumpBodyHeight/2, bottom is at pumpBodyHeight/2 + pumpInletPipe
        const pumpOutletOnLeft = pumpOrientation === 'right-left';
        const topY = -pumpBodyHeight / 2;
        const bottomY = pumpBodyHeight / 2 + pumpInletPipe;
        return {
          x: pumpOutletOnLeft
            ? -(pumpBodyWidth / 2 + pumpVoluteBulge + pumpOutletPipe) - 5
            : -pumpBodyWidth / 2 - 5,
          y: topY - 5,
          width: pumpBodyWidth + pumpVoluteBulge + pumpOutletPipe + 10,
          height: (bottomY - topY) + 10,
        };
      }
    case 'vessel':
      const r = (component.innerDiameter / 2 + component.wallThickness) * view.zoom;
      return {
        x: -r - 5,
        y: -component.height * view.zoom / 2 - 5,
        width: r * 2 + 10,
        height: component.height * view.zoom + 10,
      };
    case 'reactorVessel':
      const rvComp = component as ReactorVesselComponent;
      const rvR = (rvComp.innerDiameter / 2 + rvComp.wallThickness) * view.zoom;
      return {
        x: -rvR - 5,
        y: -rvComp.height * view.zoom / 2 - 5,
        width: rvR * 2 + 10,
        height: rvComp.height * view.zoom + 10,
      };
    case 'valve':
      const vd = component.diameter * view.zoom * 1.5;
      return {
        x: -vd / 2 - 5,
        y: -vd / 2 - 40,
        width: vd + 10,
        height: vd + 50,
      };
    case 'heatExchanger':
      return {
        x: -component.width * view.zoom / 2 - 5,
        y: -component.height * view.zoom / 2 - 5,
        width: component.width * view.zoom + 10,
        height: component.height * view.zoom + 10,
      };
    case 'turbine-generator':
      // Include generator on the right side
      const genR = component.height * view.zoom / 3;
      return {
        x: -component.width * view.zoom / 2 - 15,
        y: -component.height * view.zoom / 2 - 5,
        width: component.width * view.zoom + genR * 2 + 25,
        height: component.height * view.zoom + 10,
      };
    case 'turbine-driven-pump':
      return {
        x: -component.width * view.zoom / 2 - 5,
        y: -component.height * view.zoom / 2 - 5,
        width: component.width * view.zoom + 10,
        height: component.height * view.zoom + 20, // Extra for flow label
      };
    case 'condenser':
      return {
        x: -component.width * view.zoom / 2 - 5,
        y: -component.height * view.zoom / 2 - 5,
        width: component.width * view.zoom + 10,
        height: component.height * view.zoom + 35, // Extra for heat rejection label
      };
    case 'controller':
      return {
        x: -component.width * view.zoom / 2 - 5,
        y: -component.height * view.zoom / 2 - 5,
        width: component.width * view.zoom + 10,
        height: component.height * view.zoom + 10,
      };
    case 'switchyard':
      const sw = component as SwitchyardComponent;
      return {
        x: -sw.width * view.zoom / 2 - 5,
        y: -sw.height * view.zoom / 2 - 5,
        width: sw.width * view.zoom + 10,
        height: sw.height * view.zoom + 10,
      };
    default:
      return { x: -20, y: -20, width: 40, height: 40 };
  }
}

// Draw connection lines between ports
export function renderConnection(
  ctx: CanvasRenderingContext2D,
  fromPos: Point,
  toPos: Point,
  fluid: Fluid | undefined,
  view: ViewState
): void {
  const from = worldToScreen(fromPos, view);
  const to = worldToScreen(toPos, view);

  ctx.strokeStyle = fluid ? getFluidColor(fluid) : COLORS.steel;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);

  // Simple curved connection
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  ctx.quadraticCurveTo(midX, from.y, midX, midY);
  ctx.quadraticCurveTo(midX, to.y, to.x, to.y);

  ctx.stroke();
}

// Draw background grid
export function renderGrid(ctx: CanvasRenderingContext2D, view: ViewState, canvasWidth: number, canvasHeight: number): void {
  const gridSize = 1; // 1 meter grid
  const gridPx = gridSize * view.zoom;

  // Only draw if grid is visible enough
  if (gridPx < 10) return;

  // Calculate visible range
  const startX = Math.floor(-view.offsetX / gridPx) * gridPx;
  const startY = Math.floor(-view.offsetY / gridPx) * gridPx;
  const endX = canvasWidth - view.offsetX;
  const endY = canvasHeight - view.offsetY;

  ctx.beginPath();

  // Vertical lines
  for (let x = startX; x < endX; x += gridPx) {
    const screenX = x + view.offsetX;
    const isMajor = Math.abs(Math.round(x / gridPx) % 5) < 0.1;
    ctx.strokeStyle = isMajor ? COLORS.gridLineMajor : COLORS.gridLine;
    ctx.beginPath();
    ctx.moveTo(screenX, 0);
    ctx.lineTo(screenX, canvasHeight);
    ctx.stroke();
  }

  // Horizontal lines
  for (let y = startY; y < endY; y += gridPx) {
    const screenY = y + view.offsetY;
    const isMajor = Math.abs(Math.round(y / gridPx) % 5) < 0.1;
    ctx.strokeStyle = isMajor ? COLORS.gridLineMajor : COLORS.gridLine;
    ctx.beginPath();
    ctx.moveTo(0, screenY);
    ctx.lineTo(canvasWidth, screenY);
    ctx.stroke();
  }
}

// ============================================================================
// Flow Connection Arrows
// ============================================================================

/**
 * Get position for a flow connection arrow based on the flow connection and plant connections.
 * Returns the world position where an arrow should be drawn.
 * Uses actual port positions from plant connections for accurate positioning.
 */
function getFlowConnectionPosition(
  conn: { id?: string; fromNodeId: string; toNodeId: string; fromElevation?: number; toElevation?: number },
  nodeId: string,
  plantState: PlantState
): { position: Point; angle: number } | null {
  // Try to find the corresponding plant connection from the flow connection ID
  // Flow connection IDs are in the format "flow-{fromComponentId}-{toComponentId}"
  let plantConnection: Connection | undefined;
  let fromComponent: PlantComponent | undefined;
  let toComponent: PlantComponent | undefined;

  if (conn.id && conn.id.startsWith('flow-')) {
    // Try to find a matching plant connection
    // Handle component IDs that may contain dashes by checking all connections
    for (const pc of plantState.connections) {
      if (conn.id === `flow-${pc.fromComponentId}-${pc.toComponentId}`) {
        plantConnection = pc;
        fromComponent = plantState.components.get(pc.fromComponentId);
        toComponent = plantState.components.get(pc.toComponentId);
        break;
      }
    }
  }

  // Determine if we're looking for the "from" or "to" end of the connection
  const isFrom = conn.fromNodeId === nodeId;

  // If we found the plant connection, use the actual port positions
  if (plantConnection && fromComponent && toComponent) {
    const component = isFrom ? fromComponent : toComponent;
    const portId = isFrom ? plantConnection.fromPortId : plantConnection.toPortId;

    // Find the port on the component
    if (component.ports) {
      const port = component.ports.find(p => p.id === portId);
      if (port) {
        // Calculate world position of the port
        const cos = Math.cos(component.rotation);
        const sin = Math.sin(component.rotation);
        const portWorldPos = {
          x: component.position.x + port.position.x * cos - port.position.y * sin,
          y: component.position.y + port.position.x * sin + port.position.y * cos,
        };

        // Determine arrow angle based on port direction or connection direction
        // Arrow should point in the direction of flow (from -> to)
        let angle = 0;
        if (port.direction === 'out') {
          // Outlet port - arrow points outward from component
          angle = Math.atan2(port.position.y, port.position.x) + component.rotation;
        } else if (port.direction === 'in') {
          // Inlet port - arrow points into component
          angle = Math.atan2(port.position.y, port.position.x) + component.rotation + Math.PI;
        } else {
          // Bidirectional - determine angle based on connection direction
          const otherComponent = isFrom ? toComponent : fromComponent;
          const dx = otherComponent.position.x - component.position.x;
          const dy = otherComponent.position.y - component.position.y;
          angle = Math.atan2(dy, dx);
          if (!isFrom) angle += Math.PI; // Reverse for "to" end
        }

        return { position: portWorldPos, angle };
      }
    }
  }

  // Fallback: find the component that corresponds to this flow node
  let component: PlantComponent | undefined;
  for (const [compId, comp] of plantState.components) {
    const simNodeId = (comp as { simNodeId?: string }).simNodeId;
    // Exact simNodeId match
    if (simNodeId === nodeId) {
      component = comp;
      break;
    }
    // For heat exchangers: node ID is "{componentId}-tube" or "{componentId}-shell"
    if (nodeId.startsWith(compId + '-') && (nodeId.endsWith('-tube') || nodeId.endsWith('-shell'))) {
      component = comp;
      break;
    }
    // Direct component ID match (for user-constructed plants where simNodeId may equal component ID)
    if (compId === nodeId) {
      component = comp;
      break;
    }
    // Note: If none of the above match, component remains null and we return null below
    // This is intentional - if we can't find the component, we shouldn't guess
  }

  if (!component) return null;

  // Get the elevation for this end of the connection (if specified)
  const elevation = isFrom ? conn.fromElevation : conn.toElevation;

  // Get component center and determine arrow position based on component type
  const center = component.position;
  let offset: Point = { x: 0, y: 0 };
  let angle = 0;

  // Component-type-specific fallback positioning
  if (component.type === 'pipe') {
    const pipe = component as PipeComponent;
    const cos = Math.cos(pipe.rotation);
    const sin = Math.sin(pipe.rotation);

    if (elevation !== undefined && Math.abs(sin) < 0.1) {
      const lengthPosition = pipe.length * 0.7;
      offset = { x: cos * lengthPosition, y: -20 };
      angle = -Math.PI / 2;
    } else if (isFrom) {
      offset = { x: cos * pipe.length, y: sin * pipe.length };
      angle = pipe.rotation;
    } else {
      offset = { x: 0, y: 0 };
      angle = pipe.rotation + Math.PI;
    }
  } else if (component.type === 'tank') {
    const tank = component as TankComponent;
    if (elevation !== undefined) {
      const normalizedElev = elevation / 10.0;
      const yOffset = tank.height * (0.5 - normalizedElev);
      offset = { x: 0, y: -yOffset };
      angle = isFrom ? Math.PI / 2 : -Math.PI / 2;
    } else {
      offset = { x: 0, y: -tank.height / 2 - 0.5 };
      angle = isFrom ? Math.PI / 2 : -Math.PI / 2;
    }
  } else if (component.type === 'vessel') {
    const vessel = component as VesselComponent;
    const r = vessel.innerDiameter / 2 + vessel.wallThickness + 0.5;
    offset = isFrom ? { x: r, y: -vessel.height / 4 } : { x: -r, y: -vessel.height / 4 };
    angle = isFrom ? 0 : Math.PI;
  } else if (component.type === 'heatExchanger') {
    const hx = component as HeatExchangerComponent;
    offset = isFrom ? { x: -hx.width / 2 - 0.5, y: hx.height / 3 } : { x: -hx.width / 2 - 0.5, y: -hx.height / 3 };
    angle = Math.PI;
  } else if (component.type === 'pump') {
    const pump = component as any;
    const r = (pump.diameter || 1) / 2 + 0.3;
    const orientation = pump.orientation || 'left-right';
    // Account for pump orientation:
    // left-right: inlet bottom, outlet right
    // right-left: inlet bottom, outlet left (mirrored)
    // bottom-top: inlet left, outlet right (rotated -90°)
    // top-bottom: inlet right, outlet left (rotated +90°)
    if (orientation === 'right-left') {
      // Vertical pump, outlet on left
      offset = isFrom ? { x: -r, y: 0 } : { x: 0, y: r };  // from=outlet(left), to=inlet(bottom)
      angle = isFrom ? Math.PI : Math.PI / 2;
    } else if (orientation === 'bottom-top') {
      // Horizontal pump, inlet on left, outlet on right
      offset = isFrom ? { x: 0, y: -r } : { x: 0, y: r };  // from=outlet(top), to=inlet(bottom)
      angle = isFrom ? -Math.PI / 2 : Math.PI / 2;
    } else if (orientation === 'top-bottom') {
      // Horizontal pump, inlet on right, outlet on left
      offset = isFrom ? { x: 0, y: r } : { x: 0, y: -r };  // from=outlet(bottom), to=inlet(top)
      angle = isFrom ? Math.PI / 2 : -Math.PI / 2;
    } else {
      // left-right: vertical pump, outlet on right
      offset = isFrom ? { x: r, y: 0 } : { x: 0, y: r };  // from=outlet(right), to=inlet(bottom)
      angle = isFrom ? 0 : Math.PI / 2;
    }
  } else if (component.type === 'valve') {
    const valve = component as any;
    const r = (valve.diameter || 0.5) / 2 + 0.3;
    offset = isFrom ? { x: r, y: 0 } : { x: -r, y: 0 };
    angle = isFrom ? 0 : Math.PI;
  } else if (component.type === 'condenser') {
    const cond = component as any;
    const w = (cond.width || 5) / 2 + 0.5;
    const h = (cond.height || 3) / 2;
    offset = isFrom ? { x: w, y: h * 0.5 } : { x: -w, y: -h * 0.5 };
    angle = isFrom ? 0 : Math.PI;
  } else if (component.type === 'turbine-generator' || component.type === 'turbine-driven-pump') {
    const turb = component as any;
    const length = turb.length || 10;
    offset = isFrom ? { x: length / 2 + 0.5, y: 0 } : { x: -length / 2 - 0.5, y: 0 };
    angle = isFrom ? 0 : Math.PI;
  }

  return {
    position: { x: center.x + offset.x, y: center.y + offset.y },
    angle,
  };
}

/**
 * Get world position of a port on a component.
 * Returns null if port not found.
 */
function getPortWorldPosition(component: PlantComponent, portId: string): Point | null {
  const port = component.ports?.find(p => p.id === portId);
  if (!port) return null;

  const cos = Math.cos(component.rotation);
  const sin = Math.sin(component.rotation);
  return {
    x: component.position.x + port.position.x * cos - port.position.y * sin,
    y: component.position.y + port.position.x * sin + port.position.y * cos,
  };
}

/**
 * Connection endpoint info returned by getConnectionScreenPos callback
 */
export interface ConnectionScreenEndpoints {
  fromPos: Point;
  toPos: Point;
  scale: number;  // Average scale factor for arrow sizing
}

/**
 * Render flow connection arrows showing actual mass flow rates from simulation.
 * Arrows are drawn at the midpoint of each connection in screen space,
 * pointing from the source port to the destination port.
 *
 * @param getConnectionScreenPos Optional callback to get adjusted connection endpoints
 *        accounting for elevation offsets (used in isometric mode)
 */
export function renderFlowConnectionArrows(
  ctx: CanvasRenderingContext2D,
  simState: SimulationState,
  plantState: PlantState,
  view: ViewState,
  getPortScreenPos?: (component: PlantComponent, port: { position: Point }) => { x: number; y: number; radius: number } | null,
  getConnectionScreenPos?: (fromComp: PlantComponent, toComp: PlantComponent, plantConn: Connection) => ConnectionScreenEndpoints | null
): void {
  for (const conn of simState.flowConnections) {
    const fromNode = simState.flowNodes.get(conn.fromNodeId);
    const toNode = simState.flowNodes.get(conn.toNodeId);
    if (!fromNode || !toNode) continue;

    // Skip tiny flows
    if (Math.abs(conn.massFlowRate) < 1) continue;

    // Find the plant connection to get port positions
    let fromScreenPos: Point | null = null;
    let toScreenPos: Point | null = null;
    let arrowScale = 1;

    if (conn.id && conn.id.startsWith('flow-')) {
      for (const pc of plantState.connections) {
        if (conn.id === `flow-${pc.fromComponentId}-${pc.toComponentId}`) {
          const fromComponent = plantState.components.get(pc.fromComponentId);
          const toComponent = plantState.components.get(pc.toComponentId);

          if (fromComponent && toComponent) {
            // Try to use the connection screen position callback first (accounts for elevations)
            if (getConnectionScreenPos) {
              const endpoints = getConnectionScreenPos(fromComponent, toComponent, pc);
              if (endpoints) {
                fromScreenPos = endpoints.fromPos;
                toScreenPos = endpoints.toPos;
                arrowScale = endpoints.scale;
              }
            }

            // Fall back to port positions if callback not provided or failed
            if (!fromScreenPos || !toScreenPos) {
              const fromPort = fromComponent.ports?.find(p => p.id === pc.fromPortId);
              const toPort = toComponent.ports?.find(p => p.id === pc.toPortId);

              if (fromPort && toPort) {
                if (getPortScreenPos) {
                  // Use the canvas's port screen position calculation (isometric mode)
                  const fromPortScreen = getPortScreenPos(fromComponent, fromPort);
                  const toPortScreen = getPortScreenPos(toComponent, toPort);
                  if (fromPortScreen && toPortScreen) {
                    fromScreenPos = { x: fromPortScreen.x, y: fromPortScreen.y };
                    toScreenPos = { x: toPortScreen.x, y: toPortScreen.y };
                    // Port radius is Math.max(6, scale * 25), so radius/25 ≈ perspective scale
                    // Average the two port scales for the arrow
                    arrowScale = (fromPortScreen.radius + toPortScreen.radius) / 2 / 25;
                  }
                } else {
                  // Standard 2D mode - use world to screen conversion
                  const fromWorldPos = getPortWorldPosition(fromComponent, pc.fromPortId);
                  const toWorldPos = getPortWorldPosition(toComponent, pc.toPortId);
                  if (fromWorldPos && toWorldPos) {
                    fromScreenPos = worldToScreen(fromWorldPos, view);
                    toScreenPos = worldToScreen(toWorldPos, view);
                  }
                }
              }
            }
          }
          break;
        }
      }
    }

    // If we couldn't find port positions, fall back to old method
    if (!fromScreenPos || !toScreenPos) {
      const arrowInfo = getFlowConnectionPosition(conn, conn.fromNodeId, plantState);
      if (!arrowInfo) continue;

      // In fallback mode, just use world to screen (no perspective)
      fromScreenPos = worldToScreen(arrowInfo.position, view);
      toScreenPos = fromScreenPos;
    }

    // Calculate midpoint in screen space
    const screenPos: Point = {
      x: (fromScreenPos.x + toScreenPos.x) / 2,
      y: (fromScreenPos.y + toScreenPos.y) / 2,
    };

    // Calculate angle from "from" to "to" in screen space
    const dx = toScreenPos.x - fromScreenPos.x;
    const dy = toScreenPos.y - fromScreenPos.y;
    let angle = Math.atan2(dy, dx);

    // Reverse direction for negative flow
    if (conn.massFlowRate < 0) {
      angle += Math.PI;
    }

    // Calculate arrow size based on mass flow rate
    // Scale: 0 kg/s -> 8px, 1000 kg/s -> 45px
    const massFlow = Math.abs(conn.massFlowRate);
    const baseArrowSize = Math.min(45, Math.max(8, 8 + massFlow * 0.037));
    const perspectiveMultiplier = getPortScreenPos ? Math.max(0.3, Math.min(2.5, arrowScale)) : 1;
    const arrowSize = baseArrowSize * perspectiveMultiplier;

    // Draw arrow
    ctx.save();
    ctx.translate(screenPos.x, screenPos.y);
    ctx.rotate(angle);

    // Arrow color: green for positive flow, red for negative flow
    if (conn.massFlowRate >= 0) {
      ctx.fillStyle = 'rgba(100, 255, 100, 0.9)';
    } else {
      ctx.fillStyle = 'rgba(255, 100, 100, 0.9)';
    }

    // Draw arrow shape
    ctx.beginPath();
    ctx.moveTo(arrowSize, 0);
    ctx.lineTo(-arrowSize / 2, -arrowSize / 2);
    ctx.lineTo(-arrowSize / 4, 0);
    ctx.lineTo(-arrowSize / 2, arrowSize / 2);
    ctx.closePath();
    ctx.fill();

    // Draw outline
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();

    // Draw flow rate label
    ctx.save();
    const fontSize = Math.max(8, Math.min(14, 10 * perspectiveMultiplier));
    ctx.font = `${fontSize}px monospace`;
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.textAlign = 'center';
    const label = `${conn.massFlowRate.toFixed(0)} kg/s`;
    // Position label above or below the arrow based on angle
    const labelOffset = arrowSize + 8 * perspectiveMultiplier;
    const labelX = screenPos.x;
    const labelY = screenPos.y - labelOffset;
    ctx.strokeText(label, labelX, labelY);
    ctx.fillText(label, labelX, labelY);
    ctx.restore();
  }
}

// ============================================================================
// Pressure Gauges
// ============================================================================

/**
 * Render pressure dial gauges on flow nodes
 * Each gauge is attached to the top-center of its component with a thin black stem
 */
export function renderPressureGauge(
  ctx: CanvasRenderingContext2D,
  simState: SimulationState,
  plantState: PlantState,
  view: ViewState,
  getScreenBounds?: (component: PlantComponent) => { topCenter: Point; scale: number } | null
): void {
  // Draw a pressure gauge for each flow node that has a corresponding visual component
  for (const [nodeId, node] of simState.flowNodes) {
    // Find the component that corresponds to this flow node
    let component: PlantComponent | undefined;
    for (const [, comp] of plantState.components) {
      const simNodeId = (comp as { simNodeId?: string }).simNodeId;
      if (simNodeId === nodeId) {
        component = comp;
        break;
      }
    }

    if (!component) continue;

    // Check if this component is contained by a reactor vessel - if so, use the parent vessel's geometry
    const containedBy = (component as { containedBy?: string }).containedBy;
    let parentVessel: PlantComponent | undefined;
    if (containedBy) {
      parentVessel = plantState.components.get(containedBy);
    }

    // Determine which component to get bounds from
    const boundsComponent = (parentVessel && parentVessel.type === 'reactorVessel') ? parentVessel : component;

    // Get screen position from the canvas's screen bounds calculator
    let stemBottomPos: Point;
    let gaugePos: Point;
    let gaugeScale = 1;
    const stemLengthPx = 25; // Fixed stem length in pixels

    if (getScreenBounds) {
      // Use the screen bounds from canvas (works correctly in both 2D and perspective modes)
      const screenBounds = getScreenBounds(boundsComponent);
      if (!screenBounds) continue;

      gaugeScale = Math.max(0.3, Math.min(2.5, screenBounds.scale));
      let gaugeX = screenBounds.topCenter.x;
      let topY = screenBounds.topCenter.y;

      // For reactor vessel sub-components, offset the X position to separate the two gauges
      if (parentVessel && parentVessel.type === 'reactorVessel') {
        const rv = parentVessel as ReactorVesselComponent;
        const isInsideBarrel = component.id.includes('-inside');
        const gaugeOffsetX = rv.innerDiameter * view.zoom * gaugeScale * (isInsideBarrel ? -0.15 : 0.15);
        gaugeX = screenBounds.topCenter.x + gaugeOffsetX;
        // Also offset the core gauge down slightly
        if (isInsideBarrel) {
          topY = screenBounds.topCenter.y + 10 * gaugeScale;
        }
      }

      stemBottomPos = { x: gaugeX, y: topY };
      gaugePos = { x: gaugeX, y: topY - stemLengthPx * gaugeScale };
    } else {
      // Fallback: use simple world-to-screen conversion (2D mode without callback)
      const bounds = getComponentBounds(boundsComponent, view);
      const screenCenter = worldToScreen(boundsComponent.position, view);
      const topY = screenCenter.y + bounds.y;
      const gaugeX = screenCenter.x;
      stemBottomPos = { x: gaugeX, y: topY };
      gaugePos = { x: gaugeX, y: topY - stemLengthPx };
    }

    // Gauge parameters - scale with perspective
    const baseGaugeRadius = 20;
    const gaugeRadius = baseGaugeRadius * gaugeScale;
    const maxPressure = 220e5; // 220 bar in Pa
    const pressureBar = node.fluid.pressure / 1e5; // Convert to bar

    // Calculate the angle for the current pressure (arc goes from -135° to +135°, i.e., 270° total)
    const startAngle = -Math.PI * 0.75; // -135°
    const totalArcAngle = Math.PI * 1.5; // 270°
    const pressureFraction = Math.min(1, Math.max(0, node.fluid.pressure / maxPressure));
    const currentAngle = startAngle + pressureFraction * totalArcAngle;

    // Draw stem from top of component to gauge
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(stemBottomPos.x, stemBottomPos.y);
    ctx.lineTo(gaugePos.x, gaugePos.y + gaugeRadius); // Connect to bottom of gauge
    ctx.strokeStyle = '#111';
    ctx.lineWidth = Math.max(2, 3 * gaugeScale);
    ctx.stroke();
    ctx.restore();

    // Draw the gauge
    ctx.save();
    ctx.translate(gaugePos.x, gaugePos.y);

    // Draw gauge background
    ctx.beginPath();
    ctx.arc(0, 0, gaugeRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20, 22, 28, 0.95)';
    ctx.fill();
    ctx.strokeStyle = '#555';
    ctx.lineWidth = Math.max(1, 1.5 * gaugeScale);
    ctx.stroke();

    // Draw background arc (dark gray track)
    const arcWidth = Math.max(2, 4 * gaugeScale);
    ctx.beginPath();
    ctx.arc(0, 0, gaugeRadius - arcWidth / 2 - 1, startAngle, startAngle + totalArcAngle);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = arcWidth;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Draw colored arc up to current pressure
    // Color transitions based on typical reactor pressure ranges:
    // Red (<1 bar) - vacuum/loss of pressure
    // Green (1-40 bar) - normal low pressure range
    // Yellow (40-80 bar) - BWR/secondary pressures
    // White (80-160 bar) - normal PWR primary range
    // Orange (160+ bar) - high pressure
    if (pressureFraction > 0) {
      // Determine color based on pressure
      let arcColor: string;
      if (pressureBar < 1) {
        arcColor = '#c44'; // Red - vacuum/low
      } else if (pressureBar < 40) {
        arcColor = '#4c4'; // Green - normal low
      } else if (pressureBar < 80) {
        arcColor = '#cc4'; // Yellow - BWR/secondary
      } else if (pressureBar < 160) {
        arcColor = '#ddd'; // White - normal PWR primary
      } else {
        arcColor = '#c84'; // Orange - high
      }

      ctx.beginPath();
      ctx.arc(0, 0, gaugeRadius - arcWidth / 2 - 1, startAngle, currentAngle);
      ctx.strokeStyle = arcColor;
      ctx.lineWidth = arcWidth;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Draw pressure value in center - with 1 decimal place
    // Use larger font with text outline for better readability at small sizes
    const valueFontSize = Math.max(9, Math.round(12 * gaugeScale));
    ctx.font = `bold ${valueFontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Draw text outline for crispness
    ctx.strokeStyle = 'rgba(20, 22, 28, 0.8)';
    ctx.lineWidth = 2;
    ctx.strokeText(`${pressureBar.toFixed(1)}`, 0, -1 * gaugeScale);
    ctx.fillStyle = '#fff';
    ctx.fillText(`${pressureBar.toFixed(1)}`, 0, -1 * gaugeScale);

    // Draw "bar" unit below the value
    const unitFontSize = Math.max(6, Math.round(7 * gaugeScale));
    ctx.font = `${unitFontSize}px monospace`;
    ctx.fillStyle = '#999';
    ctx.fillText('bar', 0, 7 * gaugeScale);

    ctx.restore();
  }
}
