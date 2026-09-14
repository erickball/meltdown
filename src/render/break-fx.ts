/**
 * Break effects: the crack a burst opens in a component, and the spray coming
 * out of it.
 *
 * ONE anchor for both views. `collectBreaks` resolves each break to a single
 * place on the component, and everything that draws a burst - the crack, the
 * spray, the warning label and the break's flow arrow - is handed that place.
 *
 * Where that place is depends only on what the view is showing:
 *   - a PLAN (the grid) has no height, but it has a direction, so the break
 *     sits on the wall it faces and the crack runs along that wall;
 *   - an ELEVATION (2.5D) has a height, so the crack stands on the side it
 *     faces and spans its own elevations - a tear with a tall opening is a
 *     long crack, a pinhole a short one;
 *   - a component a view draws as a SOLID in some projection (the grid's
 *     cut-away pool, see ObliqueFrame) has both: the crack stands on the wall
 *     it faces, at its own elevations, in that projection.
 * All come from the numbers the simulation stores on the break connection:
 * `breakDirection` (a plan bearing in WORLD coordinates, which each view
 * projects onto its own screen), `fromElevation` (the centre of the opening)
 * and `fromOpeningHeight`.
 *
 * The spray leaves from the part of the opening that is under water, as the
 * simulation's own draw composition has it: a tall crack in a draining pool
 * sprays from its wetted lower part, and the jet sinks with the level. It is
 * thrown at the discharge's real speed and falls under gravity, and the mass
 * it draws is proportional to the mass flow, so a trickle drips down the wall
 * and a stopped leak shows nothing.
 *
 * A scripted burst (a scenario action, e.g. an earthquake tearing a pool
 * liner) and a pressure burst are the same object here, because they are the
 * same object in the simulation: one BurstState and one break connection.
 */

import { PlantState, PlantComponent } from '../types';
import { SimulationState } from '../simulation';
import { drawCompositionAt } from '../simulation/operators/connection-hydraulics';

/** A component's drawn rectangle on screen. */
export interface ScreenBox {
  x: number; y: number; w: number; h: number;
  /** Perspective scale of the component's drawing (readout sizing). */
  scale?: number;
  /** Screen pixels per metre at the component: the spray is thrown to physical scale. */
  pxPerMeter: number;
}

/**
 * How a view draws a component that it shows as a solid rather than a flat
 * sprite (the grid's cut-away pool): (u, v, w) -> screen, with u 0..1 west to
 * east and v 0..1 north to south across the footprint, and w 0..1 from the
 * bottom of the node to its top.
 */
export type ObliqueFrame = (u: number, v: number, w: number) => { x: number; y: number };

/** Where a break is and which way what comes out of it goes. */
export interface BreakAnchor {
  /** Where the discharge leaves the component. */
  x: number;
  y: number;
  /** Direction the discharge leaves in (radians, screen coordinates). */
  angle: number;
  /** Characteristic size of the break in pixels; the crack's jaggedness scales off it. */
  span: number;
  /** The crack's two ends on screen. */
  crack: { x0: number; y0: number; x1: number; y1: number };
  /** Perspective scale of the component (1 when the view did not say). */
  scale: number;
  /** Screen pixels per metre at the break. */
  pxPerMeter: number;
}

/** One break, resolved to screen space. */
export interface BreakMark {
  /** Flow node that burst - the key everything else looks the break up by. */
  nodeId: string;
  box: ScreenBox;
  anchor: BreakAnchor;
  /** 0-1 of the node's flow area. */
  fraction: number;
  /** kg/s crossing the break right now (sign = out of the component). */
  flow: number;
  /** Mean speed of the discharge through the opening, m/s. */
  speed: number;
  /** Whether what is coming out is liquid (a jet) or gas (a plume). */
  liquid: boolean;
  seed: number;
}

/** The opening as fractions of the node's height: `lo`..`hi` the crack, `at` where the discharge leaves. */
type Band = { lo: number; hi: number; at: number };

/**
 * Sized by the break fraction but never smaller than a couple of pixels: a
 * 0.02% break in a 9 m pool is a hairline, and a hairline that passes
 * 140 kg/s still has to be visible.
 */
function breakSpan(box: ScreenBox, fraction: number): number {
  return Math.max(6, Math.min(box.w, box.h) * (0.12 + 0.55 * Math.sqrt(Math.max(0, fraction))));
}

/**
 * The one place a break is turned into a crack on a component.
 *
 * `band` is the opening as fractions of the node's height (0 = bottom,
 * 1 = top): `lo`..`hi` for the crack and `at` for where the discharge
 * leaves, or null when nothing said. In a plan the fractions only set how
 * much of the wall the crack runs along; in an elevation they are the
 * whole answer for the vertical.
 */
export function breakAnchorOn(
  box: ScreenBox,
  angle: number,
  band: Band | null,
  plan: boolean,
  fraction: number
): BreakAnchor {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const scale = box.scale ?? 1;
  const pxPerMeter = box.pxPerMeter;
  const span = breakSpan(box, fraction);

  if (plan) {
    // Walk out from the centre until the ray leaves the footprint: the wall
    // the break faces, whatever shape of box it is.
    const sx = Math.abs(dx) > 1e-6 ? (box.w / 2) / Math.abs(dx) : Infinity;
    const sy = Math.abs(dy) > 1e-6 ? (box.h / 2) / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    const x = cx + dx * s, y = cy + dy * s;
    // The crack runs along that wall, as much of it as the opening is tall
    // relative to the node (a tear from floor to rim is most of the wall)
    const wall = sx < sy ? box.h : box.w;
    const length = Math.max(span, band ? (band.hi - band.lo) * wall : 0);
    const nx = -dy, ny = dx;
    return {
      x, y, angle, span, scale, pxPerMeter,
      crack: { x0: x - nx * length / 2, y0: y - ny * length / 2, x1: x + nx * length / 2, y1: y + ny * length / 2 },
    };
  }

  // Side-on: the lateral half is the wall it faces, the vertical half is
  // its own elevation. A break with no stated elevation falls back to the
  // component's mid-height.
  const x = cx + dx * (box.w / 2);
  const yAt = (f: number) => box.y + (1 - Math.max(0, Math.min(1, f))) * box.h;
  if (!band) {
    return { x, y: cy, angle, span, scale, pxPerMeter, crack: { x0: x, y0: cy - span / 2, x1: x, y1: cy + span / 2 } };
  }
  let y0 = yAt(band.hi), y1 = yAt(band.lo);
  // A hole with no height is still a visible crack, centred on the hole
  if (y1 - y0 < span) {
    const mid = (y0 + y1) / 2;
    y0 = mid - span / 2;
    y1 = mid + span / 2;
  }
  return { x, y: yAt(band.at), angle, span, scale, pxPerMeter, crack: { x0: x, y0, x1: x, y1 } };
}

/**
 * A break on a component drawn as a solid (see ObliqueFrame). The plan
 * bearing picks the point on the wall the break faces, and the band its
 * elevations on that wall, so the crack stands on the wall from the bottom of
 * the opening to its top, in the same projection as the rest of the drawing.
 */
export function breakAnchorInFrame(
  frame: ObliqueFrame,
  box: ScreenBox,
  angle: number,
  bearing: number,
  band: Band | null,
  fraction: number
): BreakAnchor {
  // Walk from the plan centre along the bearing to the wall. The bearing is
  // counter-clockwise from east with +y north; v runs north to south.
  const bx = Math.cos(bearing), by = Math.sin(bearing);
  const m = Math.max(Math.abs(bx), Math.abs(by));
  const u = 0.5 + 0.5 * bx / m, v = 0.5 - 0.5 * by / m;
  const span = breakSpan(box, fraction);
  const b = band ?? { lo: 0.5, hi: 0.5, at: 0.5 };
  const top = frame(u, v, b.hi), bottom = frame(u, v, b.lo), at = frame(u, v, b.at);
  let crack = { x0: top.x, y0: top.y, x1: bottom.x, y1: bottom.y };
  // A hole with no height is still a visible crack, centred on the hole
  if (Math.hypot(bottom.x - top.x, bottom.y - top.y) < span) {
    const mx = (top.x + bottom.x) / 2, my = (top.y + bottom.y) / 2;
    crack = { x0: mx, y0: my - span / 2, x1: mx, y1: my + span / 2 };
  }
  return { x: at.x, y: at.y, angle, span, scale: box.scale ?? 1, pxPerMeter: box.pxPerMeter, crack };
}

/**
 * Collect every open break in the plant, in screen coordinates.
 *
 * `boundsFor` is the drawn rectangle of a component in whatever projection
 * the caller is in, `plan` says whether that projection is a plan, and
 * `screenAngle` projects a world plan bearing (radians, 0 = east, π/2 =
 * north) at the component onto a direction on the caller's screen.
 * `frameFor` hands over the projection of a component the view draws as a
 * solid, which then decides where the crack stands instead of the box.
 * Returns an empty array when nothing has burst, so the caller can skip the
 * whole layer in the overwhelmingly common case.
 */
export function collectBreaks(
  plantState: PlantState,
  simState: SimulationState | null,
  boundsFor: (component: PlantComponent) => ScreenBox | null,
  plan: boolean,
  screenAngle: (component: PlantComponent, bearing: number) => number,
  frameFor?: (component: PlantComponent) => ObliqueFrame | null
): BreakMark[] {
  if (!simState || !simState.burstStates || simState.burstStates.size === 0) return [];
  const marks: BreakMark[] = [];
  for (const [nodeId, bs] of simState.burstStates) {
    if (!bs.isBurst) continue;
    const component = plantState.components.get(bs.componentId);
    if (!component) continue;
    const box = boundsFor(component);
    if (!box || !(box.w > 0) || !(box.h > 0)) continue;

    const conn = simState.flowConnections.find(c => c.id === `break-${nodeId}`);
    const node = simState.flowNodes.get(nodeId);
    const flow = conn?.massFlowRate ?? 0;

    // What the break is drawing, zone by zone up the opening (liquid at the
    // bottom, froth, gas at the top): a jet if liquid carries the mass, a
    // plume otherwise. Its density over the opening's area turns the mass
    // flow into the speed the discharge leaves at.
    const draw = conn && node
      ? drawCompositionAt(node, conn.fromElevation, flow, conn.fromPhaseTolerance, conn.fromOpeningHeight)
      : null;
    const liquid = draw ? draw.wLiquid + draw.wMixture >= 0.5 : node ? node.fluid.phase !== 'vapor' : true;
    const speed = draw && conn && draw.rho > 0 && conn.flowArea > 0
      ? Math.abs(flow) / (draw.rho * conn.flowArea)
      : 0;

    // The opening as fractions of the node's height. The break connection's
    // own `fromElevation` (the opening's centre) is the authority; a burst
    // that has not made its connection yet falls back to the absolute
    // elevation the burst state recorded.
    let band: Band | null = null;
    if (node && node.height) {
      const H = node.height;
      const centre = conn?.fromElevation !== undefined ? conn.fromElevation
        : bs.breakElevation !== undefined ? bs.breakElevation - (node.elevation ?? 0)
        : undefined;
      if (centre !== undefined) {
        const opening = conn?.fromOpeningHeight ?? bs.breakOpeningHeight ?? 0;
        const lo = Math.max(0, Math.min(H, centre - opening / 2));
        const hi = Math.max(0, Math.min(H, centre + opening / 2));
        let at = (lo + hi) / 2;
        if (draw) {
          // The jet leaves from the wetted part, a plume from the dry part
          const wet = (draw.fLiquid + draw.fMixture) * (hi - lo);
          at = liquid ? lo + wet / 2 : lo + wet + (hi - lo - wet) / 2;
        }
        band = { lo: lo / H, hi: hi / H, at: at / H };
      }
    }
    const bearing = conn?.breakDirection ?? 0;
    const angle = screenAngle(component, bearing);
    const frame = frameFor?.(component) ?? null;
    marks.push({
      nodeId,
      box,
      anchor: frame
        ? breakAnchorInFrame(frame, box, angle, bearing, band, bs.currentBreakFraction)
        : breakAnchorOn(box, angle, band, plan, bs.currentBreakFraction),
      fraction: bs.currentBreakFraction,
      flow,
      speed,
      liquid,
      seed: bs.breakSizeSeed,
    });
  }
  return marks;
}

function hash(n: number): number {
  const x = Math.sin(n * 91.7 + 47.3) * 21374.1234;
  return x - Math.floor(x);
}

/**
 * The crack itself: a jagged dark line from one end of the opening to the
 * other, with a couple of short branches, over a faint pale edge so it reads
 * against dark concrete and bright water alike.
 */
export function drawCrack(ctx: CanvasRenderingContext2D, a: BreakAnchor, seed: number): void {
  const { x0, y0, x1, y1 } = a.crack;
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (!(len > 0)) return;
  const ux = (x1 - x0) / len, uy = (y1 - y0) / len;   // along the crack
  const nx = -uy, ny = ux;                            // across it
  const segments = Math.max(4, Math.round(len / 7));
  const jag = Math.min(6, Math.max(1.5, a.span * 0.18));

  const pts: Array<{ x: number; y: number }> = [{ x: x0, y: y0 }];
  for (let k = 1; k < segments; k++) {
    const t = k / segments;
    const off = (hash(seed + k * 1.37) - 0.5) * 2 * jag;
    pts.push({ x: x0 + ux * len * t + nx * off, y: y0 + uy * len * t + ny * off });
  }
  pts.push({ x: x1, y: y1 });

  // Branches: short forks off a few of the vertices, alternating sides
  const branches: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
  const forks = Math.max(1, Math.floor(segments / 5));
  for (let b = 0; b < forks; b++) {
    const i = 1 + Math.floor(hash(seed + 300 + b) * (pts.length - 2));
    const p = pts[i];
    const side = b % 2 === 0 ? 1 : -1;
    const reach = jag * (1.5 + 1.5 * hash(seed + 400 + b));
    const lean = (hash(seed + 500 + b) - 0.5) * reach;
    branches.push([p, { x: p.x + nx * side * reach + ux * lean, y: p.y + ny * side * reach + uy * lean }]);
  }

  const width = Math.min(3.5, Math.max(1.5, a.span * 0.1));
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    for (const [p, q] of branches) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
  };
  ctx.save();
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'round';
  path();
  ctx.strokeStyle = 'rgba(235, 228, 215, 0.45)';
  ctx.lineWidth = width + 2;
  ctx.stroke();
  path();
  ctx.strokeStyle = 'rgba(18, 14, 12, 0.95)';
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

/** Mass flow one drawn drop stands for, kg/s. */
const KG_PER_S_PER_DROP = 2;
/**
 * Most drops drawn for one break. Past this the drops fatten instead of
 * multiplying, so the drawn mass stays proportional to the flow - a cap on
 * drawing cost, not on what is shown.
 */
const MAX_DROPS = 60;
/** How long a drop is followed after it leaves, s: a liquid jet's fall, a gas plume's dispersal. */
const LIQUID_FLIGHT_S = 0.6;
const GAS_FLIGHT_S = 0.25;
const G = 9.81;

/**
 * The discharge leaving a break.
 *
 * Everything in it is the flow the simulation is actually passing: the drawn
 * mass (drop count, then drop size) is proportional to the mass flow, and
 * each drop leaves at the discharge's speed and - a liquid one - falls
 * under gravity, both at the view's own metres-to-pixels. A full-bore jet
 * arcs out from the wall, a trickle runs down it, and a leak that has
 * stopped draws nothing, with no switch anywhere to get out of step with the
 * model. `timeMs` animates it.
 */
export function drawSpray(
  ctx: CanvasRenderingContext2D,
  a: BreakAnchor,
  flow: number,
  speed: number,
  liquid: boolean,
  seed: number,
  timeMs: number
): void {
  const q = Math.abs(flow);
  if (!(q > 0)) return;
  const t = timeMs / 1000;
  const dx = Math.cos(a.angle), dy = Math.sin(a.angle);
  const nx = -dy, ny = dx;
  const drops = Math.min(MAX_DROPS, Math.ceil(q / KG_PER_S_PER_DROP));
  // Drop AREA carries the mass each one stands for
  const r0 = a.span * 0.12 * Math.sqrt(q / drops / KG_PER_S_PER_DROP);
  const flight = liquid ? LIQUID_FLIGHT_S : GAS_FLIGHT_S;
  const ppm = a.pxPerMeter;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  for (let k = 0; k < drops; k++) {
    const s = seed + 50 + k * 5.31;
    const age = ((t / flight) * (0.8 + 0.4 * hash(s)) + hash(s + 1)) % 1;
    const tau = age * flight;
    const out = speed * tau * ppm;                          // along the jet
    const fall = liquid ? 0.5 * G * tau * tau * ppm : 0;    // down the screen
    const spread = (hash(s + 2) - 0.5) * 0.5;
    const px = a.x + dx * out + nx * out * spread;
    const py = a.y + dy * out + ny * out * spread + fall;
    const r = r0 * (1 + 1.5 * age);
    const alpha = (1 - age) * (liquid ? 0.55 : 0.35);
    ctx.fillStyle = liquid
      ? `rgba(120, 175, 220, ${alpha.toFixed(3)})`
      : `rgba(225, 225, 230, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Draw every break: the crack, then what is coming out of it. Only an
 * OUTFLOW sprays - a break drawing air in has nothing to show but its
 * arrow.
 */
export function drawBreaks(
  ctx: CanvasRenderingContext2D,
  marks: BreakMark[],
  timeMs: number
): void {
  for (const m of marks) {
    drawCrack(ctx, m.anchor, m.seed);
    if (m.flow > 0) drawSpray(ctx, m.anchor, m.flow, m.speed, m.liquid, m.seed, timeMs);
  }
}

/** Look a resolved break up by the node that burst. */
export function breakAnchorLookup(marks: BreakMark[]): (nodeId: string) => BreakAnchor | null {
  if (marks.length === 0) return () => null;
  const byNode = new Map(marks.map(m => [m.nodeId, m.anchor] as const));
  return (nodeId: string) => byNode.get(nodeId) ?? null;
}

/** A component with an open break, for callers that only need the flag. */
export function isBurst(simState: SimulationState | null, componentId: string): boolean {
  if (!simState?.burstStates) return false;
  for (const [, bs] of simState.burstStates) {
    if (bs.componentId === componentId && bs.isBurst) return true;
  }
  return false;
}
