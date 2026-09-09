/**
 * Break effects for the top-down grid view: the jagged hole a burst opens in
 * a component, and the spray coming out of it.
 *
 * The 2.5D view has drawn bursts since bursts existed (renderBurstOverlays /
 * renderBreakConnections in components.ts, which are side-on and know about
 * elevations). The grid view is a plan, so it needs its own small version:
 * plan has no elevation to draw a break AT, but it does have a direction -
 * `breakDirection` on the break connection, already used by the other view -
 * so the tear is put on the wall the break faces and the discharge is drawn
 * running away from it across the ground.
 *
 * A scripted burst (a scenario action, e.g. an earthquake tearing a pool
 * liner) and a pressure burst are the same object here, because they are the
 * same object in the simulation: one BurstState and one break connection.
 */

import { PlantState, Point } from '../types';
import { SimulationState } from '../simulation';
import { componentFootprint, footprintRect } from './grid-geometry';

/** One break, resolved to screen space. */
export interface BreakMark {
  /** The component's footprint on screen. */
  x: number; y: number; w: number; h: number;
  /** Direction the break faces (radians, screen coordinates). */
  angle: number;
  /** 0-1 of the node's flow area. */
  fraction: number;
  /** kg/s crossing the break right now (sign = out of the component). */
  flow: number;
  /** Whether what is coming out is liquid (a jet) or gas (a plume). */
  liquid: boolean;
  seed: number;
}

/**
 * Collect every open break in the plant, in screen coordinates.
 *
 * Returns an empty array when nothing has burst, so the caller can skip the
 * whole layer in the overwhelmingly common case.
 */
export function collectBreaks(
  plantState: PlantState,
  simState: SimulationState | null,
  worldToScreen: (p: Point) => Point,
  ppm: number
): BreakMark[] {
  if (!simState || !simState.burstStates || simState.burstStates.size === 0) return [];
  const marks: BreakMark[] = [];
  for (const [nodeId, bs] of simState.burstStates) {
    if (!bs.isBurst) continue;
    const component = plantState.components.get(bs.componentId);
    if (!component) continue;
    const rect = footprintRect(component.position, componentFootprint(component));
    const tl = worldToScreen({ x: rect.x0, y: rect.y0 });
    const br = worldToScreen({ x: rect.x1, y: rect.y1 });
    const conn = simState.flowConnections.find(c => c.id === `break-${nodeId}`);
    const node = simState.flowNodes.get(nodeId);
    marks.push({
      x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y,
      angle: conn?.breakDirection ?? -Math.PI / 2,
      fraction: bs.currentBreakFraction,
      flow: conn?.massFlowRate ?? 0,
      liquid: node ? node.fluid.phase !== 'vapor' : true,
      seed: bs.breakSizeSeed,
    });
  }
  void ppm;
  return marks;
}

function hash(n: number): number {
  const x = Math.sin(n * 91.7 + 47.3) * 21374.1234;
  return x - Math.floor(x);
}

/**
 * Draw the breaks: a torn gap on the wall the break faces, and the discharge
 * running out of it. `timeMs` animates the spray; a paused plant holds still.
 */
export function drawBreaks(
  ctx: CanvasRenderingContext2D,
  marks: BreakMark[],
  timeMs: number
): void {
  if (marks.length === 0) return;
  const t = timeMs / 1000;

  for (const m of marks) {
    // Where on the outline the tear sits: walk from the centre along the
    // break's direction until it leaves the footprint.
    const cx = m.x + m.w / 2;
    const cy = m.y + m.h / 2;
    const dx = Math.cos(m.angle), dy = Math.sin(m.angle);
    const scale = Math.min(
      Math.abs(dx) > 1e-6 ? (m.w / 2) / Math.abs(dx) : Infinity,
      Math.abs(dy) > 1e-6 ? (m.h / 2) / Math.abs(dy) : Infinity);
    const bx = cx + dx * scale;
    const by = cy + dy * scale;

    // The tear itself: a jagged wedge across the wall, sized by the break
    // fraction but never smaller than a couple of pixels (a 0.02% break in a
    // 9 m pool is a hairline, and a hairline that passes 140 kg/s still has
    // to be visible).
    const span = Math.max(6, Math.min(m.w, m.h) * (0.12 + 0.55 * Math.sqrt(m.fraction)));
    const nx = -dy, ny = dx;             // along the wall
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(bx + nx * span / 2, by + ny * span / 2);
    const teeth = 5;
    for (let k = 1; k < teeth; k++) {
      const u = k / teeth;
      const jag = (hash(m.seed + k) - 0.5) * span * 0.5;
      ctx.lineTo(
        bx + nx * span * (0.5 - u) - dx * jag,
        by + ny * span * (0.5 - u) - dy * jag);
    }
    ctx.lineTo(bx - nx * span / 2, by - ny * span / 2);
    ctx.strokeStyle = 'rgba(20, 20, 20, 0.95)';
    ctx.lineWidth = Math.max(2, span * 0.22);
    ctx.lineJoin = 'miter';
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 90, 60, 0.9)';
    ctx.lineWidth = Math.max(1, span * 0.09);
    ctx.stroke();

    // The discharge. Length follows the flow, so a break that has run itself
    // dry stops spraying without anything switching it off.
    const q = Math.abs(m.flow);
    if (q > 0.01) {
      const reach = Math.min(6 * span, span * (1.2 + 2.2 * Math.log10(1 + q)));
      const drops = Math.round(6 + 14 * Math.min(1, q / 100));
      ctx.globalCompositeOperation = 'source-over';
      for (let k = 0; k < drops; k++) {
        const s = m.seed + 50 + k * 5.31;
        const age = ((t * (0.6 + 0.5 * hash(s))) + hash(s + 1)) % 1;
        const spread = (hash(s + 2) - 0.5) * 0.7;
        const px = bx + dx * reach * age + nx * reach * spread * age;
        const py = by + dy * reach * age + ny * reach * spread * age;
        const r = Math.max(1, span * 0.12 * (1 + 1.5 * age));
        const a = (1 - age) * (m.liquid ? 0.55 : 0.35);
        ctx.fillStyle = m.liquid
          ? `rgba(120, 175, 220, ${a.toFixed(3)})`
          : `rgba(225, 225, 230, ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

/** A component with an open break, for callers that only need the flag. */
export function isBurst(simState: SimulationState | null, componentId: string): boolean {
  if (!simState?.burstStates) return false;
  for (const [, bs] of simState.burstStates) {
    if (bs.componentId === componentId && bs.isBurst) return true;
  }
  return false;
}
