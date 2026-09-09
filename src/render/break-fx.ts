/**
 * Break effects: the hole a burst opens in a component, and the spray coming
 * out of it.
 *
 * ONE anchor for both views. A burst used to be marked in three places that
 * did not agree - a lightning symbol on the component's centreline, a red
 * dashed line and arrow starting somewhere else, and (on the grid) a torn
 * gap on the wall the break faces - so the player saw the warning in one
 * place and the water leaving from another. `collectBreaks` now resolves the
 * break to a single point on the component, and everything that draws a
 * burst is handed that point: the tear, the spray, the lightning marker and
 * the discharge line.
 *
 * Where that point is depends only on what the view is showing:
 *   - a PLAN (the grid) has no height, but it has a direction, so the break
 *     sits on the wall the break faces;
 *   - an ELEVATION (2.5D) has a height, so the break sits at its own
 *     elevation on the side it faces.
 * Both come from the same two numbers the simulation stores on the break -
 * `breakDirection` and `fromElevation` - so the two views mark the same hole.
 *
 * A scripted burst (a scenario action, e.g. an earthquake tearing a pool
 * liner) and a pressure burst are the same object here, because they are the
 * same object in the simulation: one BurstState and one break connection.
 */

import { PlantState, PlantComponent } from '../types';
import { SimulationState } from '../simulation';

/** A component's drawn rectangle on screen. */
export interface ScreenBox {
  x: number; y: number; w: number; h: number;
}

/** Where a break is and which way what comes out of it goes. */
export interface BreakAnchor {
  x: number;
  y: number;
  /** Direction the discharge leaves in (radians, screen coordinates). */
  angle: number;
  /** Characteristic size of the tear in pixels; the spray scales off it. */
  span: number;
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
  /** Whether what is coming out is liquid (a jet) or gas (a plume). */
  liquid: boolean;
  seed: number;
}

/**
 * The one place a break is turned into a point on a component.
 *
 * `heightFraction` is where the break is up the node (0 = bottom, 1 = top),
 * or null when nothing said. In a plan that is meaningless and ignored; in
 * an elevation it is the whole answer for the vertical.
 */
export function breakAnchorOn(
  box: ScreenBox,
  angle: number,
  heightFraction: number | null,
  plan: boolean,
  fraction: number
): BreakAnchor {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = Math.cos(angle), dy = Math.sin(angle);

  let x: number, y: number;
  if (plan) {
    // Walk out from the centre until the ray leaves the footprint: the wall
    // the break faces, whatever shape of box it is.
    const scale = Math.min(
      Math.abs(dx) > 1e-6 ? (box.w / 2) / Math.abs(dx) : Infinity,
      Math.abs(dy) > 1e-6 ? (box.h / 2) / Math.abs(dy) : Infinity);
    x = cx + dx * scale;
    y = cy + dy * scale;
  } else {
    // Side-on: the lateral half is the wall it faces, the vertical half is
    // its own elevation. A break with no stated elevation falls back to the
    // direction, which is the best the geometry can say.
    x = cx + dx * (box.w / 2);
    y = heightFraction === null
      ? cy + dy * (box.h / 2)
      : box.y + (1 - Math.max(0, Math.min(1, heightFraction))) * box.h;
  }

  // Sized by the break fraction but never smaller than a couple of pixels: a
  // 0.02% break in a 9 m pool is a hairline, and a hairline that passes
  // 140 kg/s still has to be visible.
  const span = Math.max(6, Math.min(box.w, box.h) * (0.12 + 0.55 * Math.sqrt(Math.max(0, fraction))));
  return { x, y, angle, span };
}

/**
 * Collect every open break in the plant, in screen coordinates.
 *
 * `boundsFor` is the drawn rectangle of a component in whatever projection
 * the caller is in, and `plan` says whether that projection is a plan.
 * Returns an empty array when nothing has burst, so the caller can skip the
 * whole layer in the overwhelmingly common case.
 */
export function collectBreaks(
  plantState: PlantState,
  simState: SimulationState | null,
  boundsFor: (component: PlantComponent) => ScreenBox | null,
  plan: boolean
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
    // Height above the node's floor, as a fraction of it. The break
    // connection's own `fromElevation` is the authority; a burst that has
    // not made its connection yet falls back to the absolute elevation the
    // burst state recorded.
    let heightFraction: number | null = null;
    if (node && node.height) {
      if (conn?.fromElevation !== undefined) heightFraction = conn.fromElevation / node.height;
      else if (bs.breakElevation !== undefined) {
        heightFraction = (bs.breakElevation - (node.elevation ?? 0)) / node.height;
      }
    }
    const angle = conn?.breakDirection ?? -Math.PI / 2;
    marks.push({
      nodeId,
      box,
      anchor: breakAnchorOn(box, angle, heightFraction, plan, bs.currentBreakFraction),
      fraction: bs.currentBreakFraction,
      flow: conn?.massFlowRate ?? 0,
      liquid: node ? node.fluid.phase !== 'vapor' : true,
      seed: bs.breakSizeSeed,
    });
  }
  return marks;
}

function hash(n: number): number {
  const x = Math.sin(n * 91.7 + 47.3) * 21374.1234;
  return x - Math.floor(x);
}

/** The torn gap itself: a jagged wedge across the wall the break faces. */
export function drawTear(ctx: CanvasRenderingContext2D, a: BreakAnchor, seed: number): void {
  const dx = Math.cos(a.angle), dy = Math.sin(a.angle);
  const nx = -dy, ny = dx;             // along the wall
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(a.x + nx * a.span / 2, a.y + ny * a.span / 2);
  const teeth = 5;
  for (let k = 1; k < teeth; k++) {
    const u = k / teeth;
    const jag = (hash(seed + k) - 0.5) * a.span * 0.5;
    ctx.lineTo(
      a.x + nx * a.span * (0.5 - u) - dx * jag,
      a.y + ny * a.span * (0.5 - u) - dy * jag);
  }
  ctx.lineTo(a.x - nx * a.span / 2, a.y - ny * a.span / 2);
  ctx.strokeStyle = 'rgba(20, 20, 20, 0.95)';
  ctx.lineWidth = Math.max(2, a.span * 0.22);
  ctx.lineJoin = 'miter';
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 90, 60, 0.9)';
  ctx.lineWidth = Math.max(1, a.span * 0.09);
  ctx.stroke();
  ctx.restore();
}

/**
 * The discharge leaving a break.
 *
 * Length and density follow the flow the simulation is actually passing, so
 * a break that has run itself dry stops spraying without anything switching
 * it off, and there is no separate "is it flowing" rule to get out of step
 * with the model. `timeMs` animates it; a paused plant holds still.
 */
export function drawSpray(
  ctx: CanvasRenderingContext2D,
  a: BreakAnchor,
  flow: number,
  liquid: boolean,
  seed: number,
  timeMs: number
): void {
  const q = Math.abs(flow);
  if (!(q > 0.01)) return;
  const t = timeMs / 1000;
  const dx = Math.cos(a.angle), dy = Math.sin(a.angle);
  const nx = -dy, ny = dx;
  const reach = Math.min(6 * a.span, a.span * (1.2 + 2.2 * Math.log10(1 + q)));
  const drops = Math.round(6 + 14 * Math.min(1, q / 100));
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  for (let k = 0; k < drops; k++) {
    const s = seed + 50 + k * 5.31;
    const age = ((t * (0.6 + 0.5 * hash(s))) + hash(s + 1)) % 1;
    const spread = (hash(s + 2) - 0.5) * 0.7;
    const px = a.x + dx * reach * age + nx * reach * spread * age;
    const py = a.y + dy * reach * age + ny * reach * spread * age;
    const r = Math.max(1, a.span * 0.12 * (1 + 1.5 * age));
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

/** Draw every break: the tear, then what is coming out of it. */
export function drawBreaks(
  ctx: CanvasRenderingContext2D,
  marks: BreakMark[],
  timeMs: number
): void {
  for (const m of marks) {
    drawTear(ctx, m.anchor, m.seed);
    drawSpray(ctx, m.anchor, m.flow, m.liquid, m.seed, timeMs);
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
