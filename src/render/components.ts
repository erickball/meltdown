import {
  PlantComponent,
  TankComponent,
  PipeComponent,
  PumpComponent,
  VesselComponent,
  ValveComponent,
  HeatExchangerComponent,
  TurbineComponent,
  CondenserComponent,
  ViewState,
  Fluid,
  Point,
  PlantState,
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
  skipPorts: boolean = false
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
    case 'turbine':
      renderTurbine(ctx, component, view);
      break;
    case 'condenser':
      renderCondenser(ctx, component, view);
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
  const d = pump.diameter * view.zoom;
  const r = d / 2;

  // Pump body (circle)
  ctx.fillStyle = pump.running ? COLORS.steel : COLORS.steelDark;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  // Pump internals - impeller representation
  ctx.strokeStyle = pump.running ? '#aabbcc' : '#556677';
  ctx.lineWidth = 2;
  const bladeCount = 4;
  for (let i = 0; i < bladeCount; i++) {
    const angle = (i / bladeCount) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(angle) * r * 0.7, Math.sin(angle) * r * 0.7);
    ctx.stroke();
  }

  // Center hub
  ctx.fillStyle = COLORS.steelDark;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.2, 0, Math.PI * 2);
  ctx.fill();

  // Running indicator
  if (pump.running) {
    ctx.strokeStyle = COLORS.safe;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r + 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Outer rim
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
}

function renderVessel(ctx: CanvasRenderingContext2D, vessel: VesselComponent, view: ViewState): void {
  const innerR = (vessel.innerDiameter / 2) * view.zoom;
  const outerR = innerR + vessel.wallThickness * view.zoom;
  const h = vessel.height * view.zoom;
  const cylinderH = h - (vessel.hasDome ? outerR : 0) - (vessel.hasBottom ? outerR : 0);

  ctx.fillStyle = COLORS.steel;

  // Main cylinder
  const cylinderTop = vessel.hasDome ? -h / 2 + outerR : -h / 2;
  ctx.fillRect(-outerR, cylinderTop, outerR * 2, cylinderH);

  // Top dome
  if (vessel.hasDome) {
    ctx.beginPath();
    ctx.arc(0, -h / 2 + outerR, outerR, Math.PI, 0);
    ctx.fill();
  }

  // Bottom dome
  if (vessel.hasBottom) {
    ctx.beginPath();
    ctx.arc(0, h / 2 - outerR, outerR, 0, Math.PI);
    ctx.fill();
  }

  // Inner cavity with fluid
  const innerCylinderH = cylinderH - vessel.wallThickness * view.zoom * 2;
  const innerTop = cylinderTop + vessel.wallThickness * view.zoom;

  if (vessel.fluid) {
    // Use pixelated rendering for two-phase
    if (vessel.fluid.phase === 'two-phase') {
      renderTwoPhaseFluid(ctx, vessel.fluid, -innerR, innerTop, innerR * 2, innerCylinderH, 5);
    } else {
      ctx.fillStyle = getFluidColor(vessel.fluid);
      ctx.fillRect(-innerR, innerTop, innerR * 2, innerCylinderH);
    }
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(-innerR, innerTop, innerR * 2, innerCylinderH);
  }

  // Inner domes - also use two-phase if applicable
  if (vessel.hasDome) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, -h / 2 + outerR, innerR, Math.PI, 0);
    ctx.clip();
    if (vessel.fluid) {
      if (vessel.fluid.phase === 'two-phase') {
        renderTwoPhaseFluid(ctx, vessel.fluid, -innerR, -h / 2, innerR * 2, outerR, 5);
      } else {
        ctx.fillStyle = getFluidColor(vessel.fluid);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = '#111';
      ctx.fill();
    }
    ctx.restore();
  }
  if (vessel.hasBottom) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, h / 2 - outerR, innerR, 0, Math.PI);
    ctx.clip();
    if (vessel.fluid) {
      if (vessel.fluid.phase === 'two-phase') {
        renderTwoPhaseFluid(ctx, vessel.fluid, -innerR, h / 2 - outerR, innerR * 2, outerR, 5);
      } else {
        ctx.fillStyle = getFluidColor(vessel.fluid);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = '#111';
      ctx.fill();
    }
    ctx.restore();
  }

  // Fuel rods and control rods (if this is a reactor vessel with fuel)
  if (vessel.fuelRodCount && vessel.fuelRodCount > 0) {
    const fuelTemp = vessel.fuelTemperature ?? 600; // Default to warm if not set
    const meltPoint = vessel.fuelMeltingPoint ?? 2800;
    const fuelColor = getFuelColor(fuelTemp, meltPoint);

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
    const controlRodCount = vessel.controlRodCount ?? 0;
    if (controlRodCount > 0) {
      const controlRodPosition = vessel.controlRodPosition ?? 0.5;
      // 0 = fully inserted (full length visible), 1 = fully withdrawn (not visible in core)
      const insertionDepth = 1 - controlRodPosition; // How far into the core
      const controlRodLength = coreHeight * insertionDepth;

      // Control rods are positioned between fuel rods
      // With 8 fuel rods and 3 control rod banks, place them at positions 2, 4, 6
      // (i.e., between fuel rods 1-2, 3-4, 5-6)
      const controlRodWidth = rodWidth * 0.8;
      const fuelRodPositions: number[] = [];
      for (let i = 0; i < rodCount; i++) {
        fuelRodPositions.push(-coreWidth / 2 + rodSpacing * (i + 1));
      }

      // Place control rods evenly distributed between fuel rods
      for (let i = 0; i < controlRodCount; i++) {
        // Calculate position between fuel rods
        const fuelIndex = Math.floor((i + 1) * (rodCount - 1) / (controlRodCount + 1));
        const crX = (fuelRodPositions[fuelIndex] + fuelRodPositions[fuelIndex + 1]) / 2;

        // Draw control rod from top of core down
        if (controlRodLength > 0) {
          // Control rod guide tube (thin gray outline)
          ctx.fillStyle = '#333';
          ctx.fillRect(crX - controlRodWidth / 2 - 1, coreTop, controlRodWidth + 2, controlRodLength);

          // Control rod absorber (black)
          ctx.fillStyle = '#111';
          ctx.fillRect(crX - controlRodWidth / 2, coreTop + 1, controlRodWidth, controlRodLength - 2);
        }
      }
    }
  }

  // Vessel outline
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (vessel.hasDome) {
    ctx.arc(0, -h / 2 + outerR, outerR, Math.PI, 0);
  } else {
    ctx.moveTo(-outerR, -h / 2);
    ctx.lineTo(outerR, -h / 2);
  }
  ctx.lineTo(outerR, h / 2 - (vessel.hasBottom ? outerR : 0));
  if (vessel.hasBottom) {
    ctx.arc(0, h / 2 - outerR, outerR, 0, Math.PI);
  } else {
    ctx.lineTo(-outerR, h / 2);
  }
  ctx.closePath();
  ctx.stroke();
}

function renderValve(ctx: CanvasRenderingContext2D, valve: ValveComponent, view: ViewState): void {
  const d = valve.diameter * view.zoom;
  const bodySize = d * 1.5;

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

function renderHeatExchanger(ctx: CanvasRenderingContext2D, hx: HeatExchangerComponent, view: ViewState): void {
  const w = hx.width * view.zoom;
  const h = hx.height * view.zoom;
  const wallPx = 4;

  // Shell
  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(-w / 2, -h / 2, w, h);

  // Shell-side fluid (secondary) - stratified if two-phase
  const innerW = w - wallPx * 2;
  const innerH = h - wallPx * 2;
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

  // Tubes (primary side) - vertical U-tubes going down and back up
  const tubeSpacing = innerW / (hx.tubeCount + 1);
  const tubeRadius = Math.min(tubeSpacing * 0.25, 6);
  const tubeWall = 1;

  for (let i = 0; i < hx.tubeCount; i++) {
    const x = innerLeft + tubeSpacing * (i + 1);

    // Draw tube outer wall (steel)
    ctx.fillStyle = COLORS.steel;
    ctx.fillRect(x - tubeRadius - tubeWall, innerTop + 5, (tubeRadius + tubeWall) * 2, innerH - 15);

    // Draw tube inner (primary fluid)
    if (hx.primaryFluid) {
      ctx.fillStyle = getFluidColor(hx.primaryFluid);
    } else {
      ctx.fillStyle = '#111';
    }
    ctx.fillRect(x - tubeRadius, innerTop + 5 + tubeWall, tubeRadius * 2, innerH - 15 - tubeWall * 2);

    // Tube header at top (inlet/outlet plenum)
    ctx.fillStyle = COLORS.steel;
    ctx.beginPath();
    ctx.arc(x, innerTop + 5, tubeRadius + tubeWall, Math.PI, 0);
    ctx.fill();

    if (hx.primaryFluid) {
      ctx.fillStyle = getFluidColor(hx.primaryFluid);
    } else {
      ctx.fillStyle = '#111';
    }
    ctx.beginPath();
    ctx.arc(x, innerTop + 5, tubeRadius, Math.PI, 0);
    ctx.fill();

    // U-bend at bottom
    ctx.fillStyle = COLORS.steel;
    ctx.beginPath();
    ctx.arc(x, innerTop + innerH - 10, tubeRadius + tubeWall, 0, Math.PI);
    ctx.fill();

    if (hx.primaryFluid) {
      ctx.fillStyle = getFluidColor(hx.primaryFluid);
    } else {
      ctx.fillStyle = '#111';
    }
    ctx.beginPath();
    ctx.arc(x, innerTop + innerH - 10, tubeRadius, 0, Math.PI);
    ctx.fill();
  }

  // Draw tube sheet at top (separating primary and secondary)
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(innerLeft, innerTop, innerW, 5);

  // Outline
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 2;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
}

function renderTurbine(ctx: CanvasRenderingContext2D, turbine: TurbineComponent, view: ViewState): void {
  const w = turbine.width * view.zoom;
  const h = turbine.height * view.zoom;

  // Turbine casing - trapezoidal shape (larger at inlet, smaller at outlet)
  // Shows the expanding steam path
  ctx.fillStyle = COLORS.steel;
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h / 2);          // Top left (inlet side)
  ctx.lineTo(w / 2, -h / 3);           // Top right (outlet side - smaller)
  ctx.lineTo(w / 2, h / 3);            // Bottom right
  ctx.lineTo(-w / 2, h / 2);           // Bottom left (inlet side)
  ctx.closePath();
  ctx.fill();

  // Steam path visualization (if running)
  if (turbine.running && turbine.inletFluid) {
    ctx.fillStyle = getFluidColor(turbine.inletFluid);
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + 5, -h / 2 + 5);
    ctx.lineTo(w / 2 - 5, -h / 3 + 5);
    ctx.lineTo(w / 2 - 5, h / 3 - 5);
    ctx.lineTo(-w / 2 + 5, h / 2 - 5);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }

  // Rotor shaft (horizontal line through center)
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(-w / 2 - 10, -3, w + 20, 6);

  // Blades representation (vertical lines inside the casing)
  ctx.strokeStyle = turbine.running ? '#aabbcc' : '#556677';
  ctx.lineWidth = 2;
  const bladeCount = 6;
  for (let i = 0; i < bladeCount; i++) {
    const x = -w / 2 + (w / (bladeCount + 1)) * (i + 1);
    // Blade height decreases as we go from inlet to outlet
    const progress = (i + 1) / (bladeCount + 1);
    const bladeH = (h / 2) * (1 - progress * 0.3);
    ctx.beginPath();
    ctx.moveTo(x, -bladeH + 3);
    ctx.lineTo(x, bladeH - 3);
    ctx.stroke();
  }

  // Generator at the outlet end (right side)
  const genR = h / 3;
  ctx.fillStyle = COLORS.steel;
  ctx.beginPath();
  ctx.arc(w / 2 + genR + 5, 0, genR, 0, Math.PI * 2);
  ctx.fill();

  // Generator outline
  ctx.strokeStyle = turbine.running ? COLORS.safe : '#666';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(w / 2 + genR + 5, 0, genR, 0, Math.PI * 2);
  ctx.stroke();

  // Power indicator
  if (turbine.running) {
    ctx.font = '10px monospace';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    const powerMW = turbine.power / 1e6;
    ctx.fillText(`${powerMW.toFixed(0)} MW`, w / 2 + genR + 5, genR + 15);
  }

  // Turbine outline
  ctx.strokeStyle = COLORS.steelHighlight;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h / 2);
  ctx.lineTo(w / 2, -h / 3);
  ctx.lineTo(w / 2, h / 3);
  ctx.lineTo(-w / 2, h / 2);
  ctx.closePath();
  ctx.stroke();
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
  const tubeSpacing = innerH / (condenser.tubeCount + 1);
  const tubeRadius = Math.min(tubeSpacing * 0.3, 4);

  // Draw tube bank as a grid of circles
  const tubeCols = Math.floor(innerW / (tubeRadius * 4));
  for (let row = 0; row < condenser.tubeCount; row++) {
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

    ctx.fillStyle = port.connectedTo ? COLORS.portConnected : COLORS.portAvailable;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();

    // Direction indicator
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
      return {
        x: -component.diameter * view.zoom / 2 - 5,
        y: -component.diameter * view.zoom / 2 - 5,
        width: component.diameter * view.zoom + 10,
        height: component.diameter * view.zoom + 10,
      };
    case 'vessel':
      const r = (component.innerDiameter / 2 + component.wallThickness) * view.zoom;
      return {
        x: -r - 5,
        y: -component.height * view.zoom / 2 - 5,
        width: r * 2 + 10,
        height: component.height * view.zoom + 10,
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
    case 'turbine':
      // Include generator on the right side
      const genR = component.height * view.zoom / 3;
      return {
        x: -component.width * view.zoom / 2 - 15,
        y: -component.height * view.zoom / 2 - 5,
        width: component.width * view.zoom + genR * 2 + 25,
        height: component.height * view.zoom + 10,
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
  let component: PlantComponent | undefined;
  for (const [, comp] of plantState.components) {
    const simNodeId = (comp as { simNodeId?: string }).simNodeId;
    if (simNodeId === nodeId) {
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
  view: ViewState
): void {
  for (const conn of simState.flowConnections) {
    const fromNode = simState.flowNodes.get(conn.fromNodeId);
    const toNode = simState.flowNodes.get(conn.toNodeId);
    if (!fromNode || !toNode) continue;

    // Get arrow position - draw near the "from" node
    const arrowInfo = getFlowConnectionPosition(conn, conn.fromNodeId, plantState);
    if (!arrowInfo) continue;

    const screenPos = worldToScreen(arrowInfo.position, view);

    // Calculate arrow size based on flow velocity
    // velocity = massFlowRate / (density * area)
    const density = fromNode.fluid.mass / fromNode.volume;
    const velocity = Math.abs(conn.massFlowRate) / (density * conn.flowArea);

    // Scale arrow size: 0 m/s -> 5px, 10 m/s -> 30px
    const arrowSize = Math.min(30, Math.max(5, 5 + velocity * 2.5));

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

    // Arrow color based on flow magnitude
    const flowMagnitude = Math.abs(conn.massFlowRate);
    if (flowMagnitude > 10000) {
      ctx.fillStyle = 'rgba(255, 100, 100, 0.9)'; // Red for very high flow
    } else if (flowMagnitude > 5000) {
      ctx.fillStyle = 'rgba(255, 200, 100, 0.9)'; // Orange for high flow
    } else {
      ctx.fillStyle = 'rgba(100, 255, 100, 0.9)'; // Green for normal flow
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
    ctx.font = '10px monospace';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    const label = `${conn.massFlowRate.toFixed(0)} kg/s`;
    const labelX = screenPos.x + Math.cos(angle) * (arrowSize + 5);
    const labelY = screenPos.y + Math.sin(angle) * (arrowSize + 5) + 4;
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
  view: ViewState
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

    // Determine gauge position (offset from component)
    let gaugeOffset: Point = { x: 0, y: 0 };

    if (component.type === 'pipe') {
      const pipe = component as PipeComponent;
      // Place gauge above the middle of the pipe
      const midX = pipe.length / 2;
      const cos = Math.cos(pipe.rotation);
      const sin = Math.sin(pipe.rotation);
      gaugeOffset = {
        x: midX * cos - (pipe.diameter / 2 + 1) * sin,
        y: midX * sin + (pipe.diameter / 2 + 1) * cos,
      };
    } else if (component.type === 'tank') {
      const tank = component as TankComponent;
      gaugeOffset = { x: tank.width / 2 + 1, y: -tank.height / 4 };
    } else if (component.type === 'vessel') {
      const vessel = component as VesselComponent;
      gaugeOffset = { x: vessel.innerDiameter / 2 + vessel.wallThickness + 1.5, y: 0 };
    } else if (component.type === 'heatExchanger') {
      const hx = component as HeatExchangerComponent;
      gaugeOffset = { x: hx.width / 2 + 1, y: 0 };
    } else {
      continue; // Skip other component types
    }

    const worldPos = {
      x: component.position.x + gaugeOffset.x,
      y: component.position.y + gaugeOffset.y,
    };
    const screenPos = worldToScreen(worldPos, view);

    // Gauge parameters
    const gaugeRadius = 20;
    const maxPressure = 220e5; // 220 bar in Pa
    const pressureBar = node.fluid.pressure / 1e5; // Convert to bar
    const needleAngle = (node.fluid.pressure / maxPressure) * Math.PI * 1.5 - Math.PI * 0.75;

    ctx.save();
    ctx.translate(screenPos.x, screenPos.y);

    // Draw gauge background
    ctx.beginPath();
    ctx.arc(0, 0, gaugeRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(30, 30, 40, 0.9)';
    ctx.fill();
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw scale arc
    ctx.beginPath();
    ctx.arc(0, 0, gaugeRadius - 4, -Math.PI * 0.75, Math.PI * 0.75);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Draw colored zones on the arc
    // Green zone: 0-180 bar (normal operation)
    ctx.beginPath();
    ctx.arc(0, 0, gaugeRadius - 4, -Math.PI * 0.75, -Math.PI * 0.75 + (180 / 220) * Math.PI * 1.5);
    ctx.strokeStyle = '#4a4';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Yellow zone: 180-200 bar
    ctx.beginPath();
    ctx.arc(0, 0, gaugeRadius - 4, -Math.PI * 0.75 + (180 / 220) * Math.PI * 1.5, -Math.PI * 0.75 + (200 / 220) * Math.PI * 1.5);
    ctx.strokeStyle = '#aa4';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Red zone: 200-220 bar
    ctx.beginPath();
    ctx.arc(0, 0, gaugeRadius - 4, -Math.PI * 0.75 + (200 / 220) * Math.PI * 1.5, Math.PI * 0.75);
    ctx.strokeStyle = '#a44';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Draw needle
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(needleAngle) * (gaugeRadius - 6), Math.sin(needleAngle) * (gaugeRadius - 6));
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw center dot
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#888';
    ctx.fill();

    // Draw pressure value
    ctx.font = '9px monospace';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(`${pressureBar.toFixed(0)}`, 0, gaugeRadius - 10);
    ctx.font = '7px monospace';
    ctx.fillStyle = '#aaa';
    ctx.fillText('bar', 0, gaugeRadius - 3);

    ctx.restore();
  }
}
