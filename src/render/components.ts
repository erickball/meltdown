import {
  PlantComponent,
  TankComponent,
  PipeComponent,
  PumpComponent,
  VesselComponent,
  ReactorVesselComponent,
  ValveComponent,
  HeatExchangerComponent,
  TurbineGeneratorComponent,
  TurbineDrivenPumpComponent,
  CondenserComponent,
  ViewState,
  Fluid,
  Point,
  PlantState,
  Connection,
} from '../types';
import { SimulationState } from '../simulation';
import { getFluidColor, getTwoPhaseColors, getFuelColor, rgbToString, COLORS, massQualityToVolumeFraction, getSaturationTemp } from './colors';

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

export function screenToWorld(point: Point, view: ViewState): Point {
  return {
    x: (point.x - view.offsetX) / view.zoom,
    y: (point.y - view.offsetY) / view.zoom,
  };
}

// Main component renderer - dispatches to specific renderers
export function renderComponent(
  ctx: CanvasRenderingContext2D,
  component: PlantComponent,
  view: ViewState,
  isSelected: boolean = false,
  skipPorts: boolean = false,
  connections?: Connection[]
): void {
  // Note: Context is already transformed to component position by caller
  // We no longer transform here to support isometric projection

  // Dispatch to specific renderer
  switch (component.type) {
    case 'tank':
      renderTank(ctx, component, view);
      break;
    case 'pipe':
      renderPipe(ctx, component, view);
      break;
    case 'pump':
      renderPump(ctx, component, view);
      break;
    case 'vessel':
      renderVessel(ctx, component, view);
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
      renderReactorVessel(ctx, component as ReactorVesselComponent, view, connections);
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

function renderTank(ctx: CanvasRenderingContext2D, tank: TankComponent, view: ViewState): void {
  const w = tank.width * view.zoom;
  const h = tank.height * view.zoom;
  const wallPx = Math.max(2, tank.wallThickness * view.zoom);

  // Outer wall
  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(-w / 2, -h / 2, w, h);

  // Inner area (show fluid if present)
  const innerW = w - wallPx * 2;
  const innerH = h - wallPx * 2;

  if (tank.fluid) {
    // For two-phase in tanks, show stratified: liquid at bottom, vapor at top
    // Use volume fraction (not mass quality) for visual height split
    if (tank.fluid.phase === 'two-phase') {
      const massQuality = tank.fluid.quality ?? 0.5;
      // Convert mass quality to volume fraction for proper visual representation
      const vaporVolumeFraction = massQualityToVolumeFraction(massQuality, tank.fluid.pressure);
      // Liquid fills the bottom, vapor fills the top
      const liquidFraction = 1 - vaporVolumeFraction;
      const liquidHeight = innerH * liquidFraction;
      const vaporHeight = innerH - liquidHeight;

      // Saturation temperature for coloring (use consistent formula from colors.ts)
      const T_sat = getSaturationTemp(tank.fluid.pressure);

      // Draw vapor space (top) - use saturation temperature for proper coloring
      if (vaporHeight > 0) {
        const vaporFluid: Fluid = {
          temperature: T_sat,
          pressure: tank.fluid.pressure,
          phase: 'vapor',
          flowRate: 0,
        };
        ctx.fillStyle = getFluidColor(vaporFluid);
        ctx.fillRect(-innerW / 2, -innerH / 2, innerW, vaporHeight);
      }

      // Draw liquid (bottom) - use saturation temperature for proper coloring
      if (liquidHeight > 0) {
        const liquidFluid: Fluid = {
          temperature: T_sat,
          pressure: tank.fluid.pressure,
          phase: 'liquid',
          flowRate: 0,
        };
        ctx.fillStyle = getFluidColor(liquidFluid);
        ctx.fillRect(-innerW / 2, -innerH / 2 + vaporHeight, innerW, liquidHeight);
      }
    } else {
      // Single phase fluid - fills the entire tank
      // When phase is 'liquid', the tank is completely filled with compressed liquid
      // (no vapor space - the "pressurizer has gone solid")
      // When phase is 'vapor', the tank is completely filled with superheated vapor
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
  const outerD = pipe.diameter * view.zoom;
  const innerD = (pipe.diameter - pipe.thickness * 2) * view.zoom;

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
}

function renderVessel(ctx: CanvasRenderingContext2D, vessel: VesselComponent, view: ViewState): void {
  const innerR = (vessel.innerDiameter / 2) * view.zoom;
  const outerR = innerR + vessel.wallThickness * view.zoom;
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
    const wallT = vessel.wallThickness * view.zoom;
    ctx.moveTo(-innerR, h / 2 - wallT);
    ctx.lineTo(-innerR, -h / 2 + outerR);
    ctx.arc(0, -h / 2 + outerR, innerR, Math.PI, 0, false);
    ctx.lineTo(innerR, h / 2 - wallT);
    ctx.closePath();
  } else if (vessel.hasBottom) {
    const wallT = vessel.wallThickness * view.zoom;
    ctx.moveTo(-innerR, -h / 2 + wallT);
    ctx.lineTo(-innerR, h / 2 - outerR);
    ctx.arc(0, h / 2 - outerR, innerR, 0, Math.PI, false);
    ctx.lineTo(innerR, -h / 2 + wallT);
    ctx.closePath();
  } else {
    const wallT = vessel.wallThickness * view.zoom;
    ctx.rect(-innerR, -h / 2 + wallT, innerR * 2, h - wallT * 2);
  }
  ctx.clip();

  // Fill with fluid color
  if (vessel.fluid) {
    if (vessel.fluid.phase === 'two-phase') {
      renderTwoPhaseFluid(ctx, vessel.fluid, -innerR, -h / 2, innerR * 2, h, 5);
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

function renderReactorVessel(ctx: CanvasRenderingContext2D, vessel: ReactorVesselComponent, view: ViewState, connections?: Connection[]): void {
  const innerR = (vessel.innerDiameter / 2) * view.zoom;
  const outerR = innerR + vessel.wallThickness * view.zoom;
  const h = vessel.height * view.zoom;

  // Barrel dimensions
  const barrelOuterR = (vessel.barrelDiameter / 2 + vessel.barrelThickness) * view.zoom;
  const barrelInnerR = (vessel.barrelDiameter / 2) * view.zoom;

  // Calculate dome intrusion at barrel radius
  // The dome is hemispherical with radius = innerDiameter/2
  // At the barrel's outer radius, the dome surface is at:
  // z = R - sqrt(R² - r²) from the end of the cylinder
  const vesselR = vessel.innerDiameter / 2;  // world units
  const barrelOuterRWorld = vessel.barrelDiameter / 2 + vessel.barrelThickness;
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

  // Fill with fluid color (downcomer region) - stratified if two-phase
  if (vessel.fluid) {
    if (vessel.fluid.phase === 'two-phase') {
      // Draw stratified: vapor on top, liquid on bottom
      const massQuality = vessel.fluid.quality ?? 0.5;
      const vaporVolumeFraction = massQualityToVolumeFraction(massQuality, vessel.fluid.pressure);
      const liquidFraction = 1 - vaporVolumeFraction;
      const liquidHeight = h * liquidFraction;
      const vaporHeight = h - liquidHeight;

      const T_sat = getSaturationTemp(vessel.fluid.pressure);

      // Vapor (top)
      if (vaporHeight > 0) {
        const vaporFluid: Fluid = {
          temperature: T_sat,
          pressure: vessel.fluid.pressure,
          phase: 'vapor',
          flowRate: 0,
        };
        ctx.fillStyle = getFluidColor(vaporFluid);
        ctx.fillRect(-innerR, -h / 2, innerR * 2, vaporHeight);
      }

      // Liquid (bottom)
      if (liquidHeight > 0) {
        const liquidFluid: Fluid = {
          temperature: T_sat,
          pressure: vessel.fluid.pressure,
          phase: 'liquid',
          flowRate: 0,
        };
        ctx.fillStyle = getFluidColor(liquidFluid);
        ctx.fillRect(-innerR, -h / 2 + vaporHeight, innerR * 2, liquidHeight);
      }
    } else {
      ctx.fillStyle = getFluidColor(vessel.fluid);
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
  ctx.save();
  ctx.beginPath();
  ctx.rect(-barrelInnerR, barrelTopY, barrelInnerR * 2, barrelHeight);
  ctx.clip();

  if (vessel.fluid) {
    if (vessel.fluid.phase === 'two-phase') {
      // Draw stratified: vapor on top, liquid on bottom
      const massQuality = vessel.fluid.quality ?? 0.5;
      const vaporVolumeFraction = massQualityToVolumeFraction(massQuality, vessel.fluid.pressure);
      const liquidFraction = 1 - vaporVolumeFraction;
      const liquidHeightBarrel = barrelHeight * liquidFraction;
      const vaporHeightBarrel = barrelHeight - liquidHeightBarrel;

      const T_sat = getSaturationTemp(vessel.fluid.pressure);

      // Vapor (top)
      if (vaporHeightBarrel > 0) {
        const vaporFluid: Fluid = {
          temperature: T_sat,
          pressure: vessel.fluid.pressure,
          phase: 'vapor',
          flowRate: 0,
        };
        ctx.fillStyle = getFluidColor(vaporFluid);
        ctx.fillRect(-barrelInnerR, barrelTopY, barrelInnerR * 2, vaporHeightBarrel);
      }

      // Liquid (bottom)
      if (liquidHeightBarrel > 0) {
        const liquidFluid: Fluid = {
          temperature: T_sat,
          pressure: vessel.fluid.pressure,
          phase: 'liquid',
          flowRate: 0,
        };
        ctx.fillStyle = getFluidColor(liquidFluid);
        ctx.fillRect(-barrelInnerR, barrelTopY + vaporHeightBarrel, barrelInnerR * 2, liquidHeightBarrel);
      }
    } else {
      ctx.fillStyle = getFluidColor(vessel.fluid);
      ctx.fillRect(-barrelInnerR, barrelTopY, barrelInnerR * 2, barrelHeight);
    }
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(-barrelInnerR, barrelTopY, barrelInnerR * 2, barrelHeight);
  }

  ctx.restore();

  // Draw fuel rods inside the barrel (if this reactor vessel has a core)
  if ((vessel as any).fuelRodCount && (vessel as any).fuelRodCount > 0) {
    const fuelTemp = (vessel as any).fuelTemperature ?? 600;
    const meltPoint = (vessel as any).fuelMeltingPoint ?? 2800;
    const fuelColor = getFuelColor(fuelTemp, meltPoint);

    // Core dimensions - use stored coreDiameter or default to barrel inner diameter
    const coreDiameter = (vessel as any).coreDiameter ?? (vessel.barrelDiameter - vessel.barrelThickness * 2);
    const coreWidth = (coreDiameter / 2) * view.zoom * 1.6; // 80% of core diameter for rod placement

    // Core height - use stored coreHeight or default to barrel height
    const coreHeightWorld = (vessel as any).coreHeight ?? barrelHeight / view.zoom;
    const coreHeightPx = coreHeightWorld * view.zoom;

    // Position core closer to the bottom of the barrel (more realistic)
    // Leave a small gap (10% of barrel height) at the bottom for lower plenum
    const bottomGap = barrelHeight * 0.1;
    const coreTop = barrelBottomY - bottomGap - coreHeightPx;

    const rodCount = (vessel as any).fuelRodCount;
    const rodSpacing = coreWidth / (rodCount + 1);
    const rodWidth = Math.max(2, Math.min(rodSpacing * 0.6, 6));

    // Draw each fuel rod as a vertical bar
    for (let i = 0; i < rodCount; i++) {
      const rodX = -coreWidth / 2 + rodSpacing * (i + 1);

      // Fuel rod cladding
      ctx.fillStyle = COLORS.steelDark;
      ctx.fillRect(rodX - rodWidth / 2 - 1, coreTop, rodWidth + 2, coreHeightPx);

      // Fuel pellet
      ctx.fillStyle = fuelColor;
      ctx.fillRect(rodX - rodWidth / 2, coreTop + 1, rodWidth, coreHeightPx - 2);
    }

    // Draw control rods (always full length, extend above core when withdrawn)
    const controlRodCount = (vessel as any).controlRodCount ?? 0;
    if (controlRodCount > 0) {
      const controlRodPosition = (vessel as any).controlRodPosition ?? 0.5;
      // 0 = fully inserted (rod inside core), 1 = fully withdrawn (rod above core)
      // Control rod length is always the same as core height
      const controlRodLength = coreHeightPx;
      // The top of the rod moves up as it's withdrawn
      const rodTopOffset = coreHeightPx * controlRodPosition;
      const rodTop = coreTop - rodTopOffset;
      const controlRodWidth = rodWidth * 0.8;

      // Get fuel rod positions
      const fuelRodPositions: number[] = [];
      for (let i = 0; i < rodCount; i++) {
        fuelRodPositions.push(-coreWidth / 2 + rodSpacing * (i + 1));
      }

      // Place control rods between fuel rods
      for (let i = 0; i < controlRodCount && i < rodCount - 1; i++) {
        const fuelIndex = Math.floor((i + 1) * (rodCount - 1) / (controlRodCount + 1));
        if (fuelIndex + 1 < fuelRodPositions.length) {
          const crX = (fuelRodPositions[fuelIndex] + fuelRodPositions[fuelIndex + 1]) / 2;

          ctx.fillStyle = '#333';
          ctx.fillRect(crX - controlRodWidth / 2 - 1, rodTop, controlRodWidth + 2, controlRodLength);
          ctx.fillStyle = '#111';
          ctx.fillRect(crX - controlRodWidth / 2, rodTop + 1, controlRodWidth, controlRodLength - 2);
        }
      }
    }
  }

  // Draw barrel top and bottom plates with holes for connections
  ctx.fillStyle = COLORS.steelDark;
  const plateThickness = 3;

  // Find connections between inside and outside barrel regions
  let bottomConnectionFlowArea = 0;
  let topConnectionFlowArea = 0;

  if (connections && vessel.insideBarrelId && vessel.outsideBarrelId) {
    for (const conn of connections) {
      const connectsInside = conn.fromComponentId === vessel.insideBarrelId || conn.toComponentId === vessel.insideBarrelId;
      const connectsOutside = conn.fromComponentId === vessel.outsideBarrelId || conn.toComponentId === vessel.outsideBarrelId;

      if (connectsInside && connectsOutside && conn.flowArea) {
        // Determine if this is a top or bottom connection based on port names
        const portId = conn.fromComponentId === vessel.insideBarrelId ? conn.fromPortId : conn.toPortId;
        if (portId.includes('bottom')) {
          bottomConnectionFlowArea += conn.flowArea;
        } else if (portId.includes('top')) {
          topConnectionFlowArea += conn.flowArea;
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
  const wallPx = 4;

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
      // Use volume fraction (not mass quality) for visual height split
      const massQuality = hx.secondaryFluid.quality ?? 0.5;
      const vaporVolumeFraction = massQualityToVolumeFraction(massQuality, hx.secondaryFluid.pressure);
      const liquidFraction = 1 - vaporVolumeFraction;
      const liquidHeight = innerH * liquidFraction;
      const vaporHeight = innerH - liquidHeight;

      // Use consistent saturation temperature formula
      const T_sat = getSaturationTemp(hx.secondaryFluid.pressure);

      // Vapor (top) - with pressure-dependent color
      if (vaporHeight > 0) {
        const vaporFluid: Fluid = {
          temperature: T_sat,
          pressure: hx.secondaryFluid.pressure,
          phase: 'vapor',
          flowRate: 0,
        };
        ctx.fillStyle = getFluidColor(vaporFluid);
        ctx.fillRect(innerLeft, innerTop, innerW, vaporHeight);
      }

      // Liquid (bottom) - with pressure-dependent color
      if (liquidHeight > 0) {
        const liquidFluid: Fluid = {
          temperature: T_sat,
          pressure: hx.secondaryFluid.pressure,
          phase: 'liquid',
          flowRate: 0,
        };
        ctx.fillStyle = getFluidColor(liquidFluid);
        ctx.fillRect(innerLeft, innerTop + vaporHeight, innerW, liquidHeight);
      }
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

  // Power indicator
  if (turbine.running) {
    ctx.font = '10px monospace';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    const powerMW = turbine.power / 1e6;
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
      // Show stratified - condensate at bottom, steam at top
      const massQuality = condenser.fluid.quality ?? 0.5;
      const vaporVolumeFraction = massQualityToVolumeFraction(massQuality, condenser.fluid.pressure);
      const liquidFraction = 1 - vaporVolumeFraction;
      const liquidHeight = innerH * liquidFraction;
      const vaporHeight = innerH - liquidHeight;

      const T_sat = getSaturationTemp(condenser.fluid.pressure);

      // Vapor (top)
      if (vaporHeight > 0) {
        const vaporFluid: Fluid = {
          temperature: T_sat,
          pressure: condenser.fluid.pressure,
          phase: 'vapor',
          flowRate: 0,
        };
        ctx.fillStyle = getFluidColor(vaporFluid);
        ctx.fillRect(innerLeft, innerTop, innerW, vaporHeight);
      }

      // Liquid (bottom)
      if (liquidHeight > 0) {
        const liquidFluid: Fluid = {
          temperature: T_sat,
          pressure: condenser.fluid.pressure,
          phase: 'liquid',
          flowRate: 0,
        };
        ctx.fillStyle = getFluidColor(liquidFluid);
        ctx.fillRect(innerLeft, innerTop + vaporHeight, innerW, liquidHeight);
      }
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

  // Heat rejection indicator
  ctx.font = '10px monospace';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  const heatMW = condenser.heatRejection / 1e6;
  ctx.fillText(`${heatMW.toFixed(0)} MW`, 0, h / 2 + 15);
  ctx.font = '8px monospace';
  ctx.fillStyle = '#aaa';
  ctx.fillText('rejected', 0, h / 2 + 25);

  // Hotwell at bottom (condensate collection)
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(-w / 2, h / 2 - 5, w, 5);

  // Outline
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 2;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
}

function renderPorts(ctx: CanvasRenderingContext2D, component: PlantComponent, view: ViewState): void {
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

    ctx.fillStyle = portColor;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();

    // Direction indicator (white arrow inside the port)
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    if (port.direction === 'in') {
      ctx.beginPath();
      ctx.moveTo(px - 3, py);
      ctx.lineTo(px + 3, py);
      ctx.moveTo(px + 1, py - 2);
      ctx.lineTo(px + 3, py);
      ctx.lineTo(px + 1, py + 2);
      ctx.stroke();
    } else if (port.direction === 'out') {
      ctx.beginPath();
      ctx.moveTo(px + 3, py);
      ctx.lineTo(px - 3, py);
      ctx.moveTo(px - 1, py - 2);
      ctx.lineTo(px - 3, py);
      ctx.lineTo(px - 1, py + 2);
      ctx.stroke();
    }
  }
}

function getComponentBounds(component: PlantComponent, view: ViewState): { x: number; y: number; width: number; height: number } {
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
      const pumpBodyHeight = pumpScale * (0.9 + 0.15 + 0.5 + 0.35); // motor + coupling + casing + nozzle
      const pumpInletPipe = pumpScale * 0.3; // inlet pipe below nozzle
      const pumpTotalHeight = pumpBodyHeight + pumpInletPipe;
      const pumpBodyWidth = pumpScale * 0.75; // casing width
      const pumpVoluteBulge = pumpScale * 0.18;
      const pumpOutletPipe = pumpScale * 0.45;
      return {
        x: -pumpBodyWidth / 2 - 5,
        y: -pumpBodyHeight / 2 - 5,
        width: pumpBodyWidth + pumpVoluteBulge + pumpOutletPipe + 10,
        height: pumpTotalHeight + 10,
      };
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
 * Get position for a flow connection arrow based on the flow node and connection.
 * Returns the world position where an arrow should be drawn.
 * Now considers connection elevation to position arrows at actual connection points.
 */
function getFlowConnectionPosition(
  conn: { fromNodeId: string; toNodeId: string; fromElevation?: number; toElevation?: number },
  nodeId: string,
  plantState: PlantState
): { position: Point; angle: number } | null {
  // Map flow node IDs to plant component positions
  // Flow connections are between flow nodes (core-coolant, hot-leg, sg-primary, cold-leg, pressurizer)

  // Find the component that corresponds to this flow node
  // Priority: 1) exact simNodeId match, 2) simNodeId prefix match (for HX tube/shell),
  //           3) direct component ID match (user-constructed plants)
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
    // Direct component ID match (fallback for user-constructed plants)
    if (compId === nodeId) {
      component = comp;
      break;
    }
  }

  if (!component) return null;

  // Determine which side of the component this connection is on
  const isFrom = conn.fromNodeId === nodeId;

  // Get the elevation for this end of the connection (if specified)
  // Elevation is in meters, representing the height of the connection point
  const elevation = isFrom ? conn.fromElevation : conn.toElevation;

  // Get component center and determine arrow position based on component type
  const center = component.position;
  let offset: Point = { x: 0, y: 0 };
  let angle = 0;

  // For pipes, arrows go at the ends (or at elevation if specified)
  if (component.type === 'pipe') {
    const pipe = component as PipeComponent;
    const cos = Math.cos(pipe.rotation);
    const sin = Math.sin(pipe.rotation);

    // For horizontal pipes, elevation affects the position along the pipe
    // For the hot leg to pressurizer connection, elevation 0.7m means 70% up the diameter
    if (elevation !== undefined && Math.abs(sin) < 0.1) {
      // Horizontal pipe - use elevation to position along the length
      // Assume pipe diameter ~0.8m, so elevation 0.7 means near the top
      const lengthPosition = pipe.length * 0.7; // Position at 70% along the pipe for surge line
      offset = { x: cos * lengthPosition, y: -20 }; // Offset up from pipe center
      angle = -Math.PI / 2; // Point upward for surge line
    } else if (isFrom) {
      // Arrow at the outlet end of the pipe
      offset = { x: cos * pipe.length, y: sin * pipe.length };
      angle = pipe.rotation;
    } else {
      // Arrow at the inlet end of the pipe
      offset = { x: 0, y: 0 };
      angle = pipe.rotation + Math.PI;
    }
  } else if (component.type === 'tank') {
    // Pressurizer/tank - arrow points up/down
    const tank = component as TankComponent;

    // Use elevation to position arrow at actual connection height
    if (elevation !== undefined) {
      // Convert elevation (meters) to pixel offset
      // Assume tank is ~10m tall, so scale elevation proportionally
      const normalizedElev = elevation / 10.0; // 0.1 = 10% from bottom
      const yOffset = tank.height * (0.5 - normalizedElev); // Convert to offset from center

      if (isFrom) {
        offset = { x: 0, y: -yOffset }; // Negative because y increases downward
        angle = Math.PI / 2; // Down
      } else {
        offset = { x: 0, y: -yOffset };
        angle = -Math.PI / 2; // Up
      }
    } else {
      // Default: arrows at top of tank
      if (isFrom) {
        offset = { x: 0, y: -tank.height / 2 - 0.5 };
        angle = Math.PI / 2; // Down
      } else {
        offset = { x: 0, y: -tank.height / 2 - 0.5 };
        angle = -Math.PI / 2; // Up
      }
    }
  } else if (component.type === 'vessel') {
    // Reactor vessel - arrows on sides
    const vessel = component as VesselComponent;
    const r = vessel.innerDiameter / 2 + vessel.wallThickness + 0.5;
    if (isFrom) {
      offset = { x: r, y: -vessel.height / 4 };
      angle = 0; // Right
    } else {
      offset = { x: -r, y: -vessel.height / 4 };
      angle = Math.PI; // Left
    }
  } else if (component.type === 'heatExchanger') {
    // Steam generator - arrows on sides
    const hx = component as HeatExchangerComponent;
    if (isFrom) {
      offset = { x: -hx.width / 2 - 0.5, y: hx.height / 3 };
      angle = Math.PI; // Left (primary out)
    } else {
      offset = { x: -hx.width / 2 - 0.5, y: -hx.height / 3 };
      angle = Math.PI; // Left (primary in)
    }
  } else if (component.type === 'pump') {
    // Pump - arrows on sides
    const pump = component as any;
    const r = (pump.diameter || 1) / 2 + 0.3;
    if (isFrom) {
      offset = { x: r, y: 0 };
      angle = 0; // Right (outlet)
    } else {
      offset = { x: -r, y: 0 };
      angle = Math.PI; // Left (inlet)
    }
  } else if (component.type === 'valve') {
    // Valve - arrows on sides
    const valve = component as any;
    const r = (valve.diameter || 0.5) / 2 + 0.3;
    if (isFrom) {
      offset = { x: r, y: 0 };
      angle = 0; // Right (outlet)
    } else {
      offset = { x: -r, y: 0 };
      angle = Math.PI; // Left (inlet)
    }
  } else if (component.type === 'condenser') {
    // Condenser - arrows on sides (steam in top, condensate out bottom)
    const cond = component as any;
    const w = (cond.width || 5) / 2 + 0.5;
    const h = (cond.height || 3) / 2;
    if (isFrom) {
      offset = { x: w, y: h * 0.5 }; // Condensate out (lower right)
      angle = 0; // Right
    } else {
      offset = { x: -w, y: -h * 0.5 }; // Steam in (upper left)
      angle = Math.PI; // Left
    }
  } else if (component.type === 'turbine-generator' || component.type === 'turbine-driven-pump') {
    // Turbine components - horizontal flow through
    const turb = component as any;
    const length = turb.length || 10;
    if (isFrom) {
      offset = { x: length / 2 + 0.5, y: 0 }; // Exhaust end
      angle = 0; // Right
    } else {
      offset = { x: -length / 2 - 0.5, y: 0 }; // Inlet end
      angle = Math.PI; // Left
    }
  }

  return {
    position: { x: center.x + offset.x, y: center.y + offset.y },
    angle,
  };
}

/**
 * Render flow connection arrows showing actual mass flow rates from simulation
 */
export function renderFlowConnectionArrows(
  ctx: CanvasRenderingContext2D,
  simState: SimulationState,
  plantState: PlantState,
  view: ViewState,
  perspectiveProjector?: (pos: Point, elevation: number) => { pos: Point; scale: number }
): void {
  for (const conn of simState.flowConnections) {
    const fromNode = simState.flowNodes.get(conn.fromNodeId);
    const toNode = simState.flowNodes.get(conn.toNodeId);
    if (!fromNode || !toNode) continue;

    // Get arrow position - draw near the "from" node
    const arrowInfo = getFlowConnectionPosition(conn, conn.fromNodeId, plantState);
    if (!arrowInfo) continue;

    // Use perspective projection if available (isometric mode), otherwise standard 2D
    let screenPos: Point;
    let arrowScale = 1;
    if (perspectiveProjector) {
      const projected = perspectiveProjector(arrowInfo.position, 0);
      screenPos = projected.pos;
      arrowScale = projected.scale;
      // Skip if behind camera or off-screen
      if (arrowScale <= 0) continue;
    } else {
      screenPos = worldToScreen(arrowInfo.position, view);
    }

    // Calculate arrow size based on flow velocity
    // velocity = massFlowRate / (density * area)
    const density = fromNode.fluid.mass / fromNode.volume;
    const velocity = Math.abs(conn.massFlowRate) / (density * conn.flowArea);

    // Scale arrow size: 0 m/s -> 8px, 10 m/s -> 45px (50% larger than before)
    // Apply perspective scale for isometric mode
    const baseArrowSize = Math.min(45, Math.max(8, 8 + velocity * 3.7));
    // In perspective mode, scale proportionally to distance (closer = bigger)
    // arrowScale ranges from ~0.3 (far) to ~2.5 (near) - use it directly
    const perspectiveMultiplier = perspectiveProjector ? Math.max(0.3, Math.min(2.5, arrowScale)) : 1;
    const arrowSize = baseArrowSize * perspectiveMultiplier;

    // Determine arrow direction
    let angle = arrowInfo.angle;
    if (conn.massFlowRate < 0) {
      angle += Math.PI; // Reverse direction for negative flow
    }

    // Skip tiny flows
    if (Math.abs(conn.massFlowRate) < 1) continue;

    // Draw arrow
    ctx.save();
    ctx.translate(screenPos.x, screenPos.y);
    ctx.rotate(angle);

    // Arrow color: green for positive flow, red for negative flow
    if (conn.massFlowRate >= 0) {
      ctx.fillStyle = 'rgba(100, 255, 100, 0.9)'; // Green for positive flow
    } else {
      ctx.fillStyle = 'rgba(255, 100, 100, 0.9)'; // Red for negative/reverse flow
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
    const fontSize = Math.max(8, Math.min(14, 10 * perspectiveMultiplier)); // Scale font with perspective
    ctx.font = `${fontSize}px monospace`;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    const label = `${conn.massFlowRate.toFixed(0)} kg/s`;
    const labelOffset = arrowSize + 5 * perspectiveMultiplier;
    const labelX = screenPos.x + Math.cos(angle) * labelOffset;
    const labelY = screenPos.y + Math.sin(angle) * labelOffset + 4;
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
 */
export function renderPressureGauge(
  ctx: CanvasRenderingContext2D,
  simState: SimulationState,
  plantState: PlantState,
  view: ViewState,
  perspectiveProjector?: (pos: Point, elevation: number) => { pos: Point; scale: number }
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

    // Get component elevation for perspective projection
    const componentElevation = (component as { elevation?: number }).elevation ?? 0;

    // Determine gauge position - always at top of component
    let gaugeOffset: Point = { x: 0, y: 0 };
    let gaugeElevationOffset = 0; // Elevation at top of component
    let componentHeight = 0;

    if (component.type === 'pipe') {
      const pipe = component as PipeComponent;
      // Place gauge above the middle of the pipe
      const midX = pipe.length / 2;
      const cos = Math.cos(pipe.rotation);
      const sin = Math.sin(pipe.rotation);
      gaugeOffset = {
        x: midX * cos,
        y: midX * sin,
      };
      // Pipe elevation is at center, gauge goes above
      gaugeElevationOffset = pipe.diameter / 2 + 0.5;
      componentHeight = pipe.diameter;
    } else if (component.type === 'tank') {
      const tank = component as TankComponent;
      // Place gauge at top center of tank
      gaugeOffset = { x: 0, y: 0 };
      gaugeElevationOffset = tank.height + 0.5; // Just above top
      componentHeight = tank.height;
    } else if (component.type === 'vessel') {
      const vessel = component as VesselComponent;
      // Place gauge at top of vessel
      gaugeOffset = { x: 0, y: 0 };
      gaugeElevationOffset = vessel.height + 0.5; // Just above top
      componentHeight = vessel.height;
    } else if (component.type === 'heatExchanger') {
      const hx = component as HeatExchangerComponent;
      // Place gauge at top of heat exchanger
      gaugeOffset = { x: 0, y: 0 };
      gaugeElevationOffset = hx.height + 0.5; // Just above top
      componentHeight = hx.height;
    } else {
      continue; // Skip other component types
    }

    const worldPos = {
      x: component.position.x + gaugeOffset.x,
      y: component.position.y + gaugeOffset.y,
    };

    // Use perspective projection if available (isometric mode), otherwise standard 2D
    let screenPos: Point;
    let gaugeScale = 1;
    if (perspectiveProjector) {
      const gaugeElevation = componentElevation + gaugeElevationOffset;
      const projected = perspectiveProjector(worldPos, gaugeElevation);
      screenPos = projected.pos;
      // Skip if behind camera
      if (projected.scale <= 0) continue;
      // Scale gauge with perspective - projected.scale ranges from ~0.3 (far) to ~2.5 (near)
      // Use the scale directly, clamped to reasonable range
      gaugeScale = Math.max(0.3, Math.min(2.5, projected.scale));
    } else {
      // In 2D mode, offset upward from component center
      const basePos = worldToScreen(worldPos, view);
      // Move up by component height (in screen pixels)
      screenPos = {
        x: basePos.x,
        y: basePos.y - (componentHeight / 2 + 1.5) * view.zoom,
      };
    }

    // Gauge parameters - scale with perspective (10% larger base size)
    const baseGaugeRadius = 20;
    const gaugeRadius = baseGaugeRadius * gaugeScale;
    const maxPressure = 220e5; // 220 bar in Pa
    const pressureBar = node.fluid.pressure / 1e5; // Convert to bar

    // Calculate the angle for the current pressure (arc goes from -135° to +135°, i.e., 270° total)
    const startAngle = -Math.PI * 0.75; // -135°
    const totalArcAngle = Math.PI * 1.5; // 270°
    const pressureFraction = Math.min(1, Math.max(0, node.fluid.pressure / maxPressure));
    const currentAngle = startAngle + pressureFraction * totalArcAngle;

    ctx.save();
    ctx.translate(screenPos.x, screenPos.y);

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
    // Color transitions: green (0-150 bar) -> yellow (150-180 bar) -> orange (180-200 bar) -> red (200+ bar)
    if (pressureFraction > 0) {
      // Determine color based on pressure
      let arcColor: string;
      if (pressureBar < 150) {
        arcColor = '#4c4'; // Green
      } else if (pressureBar < 180) {
        arcColor = '#cc4'; // Yellow
      } else if (pressureBar < 200) {
        arcColor = '#c84'; // Orange
      } else {
        arcColor = '#c44'; // Red
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
