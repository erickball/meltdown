/**
 * The "no power" badge: a lightning bolt in a no-symbol, drawn over any part
 * that needs electrical power and has none (electrical model only).
 *
 * Running, that is what the solve says - every load left unpowered and every
 * piece of the distribution network that is dead. Building (or before there
 * is a running network), it is the design: every part whose wiring cannot
 * reach a source at a voltage it accepts (supplyStatus).
 */

import type { PlantState } from '../types';
import type { SimulationState } from '../simulation/types';
import { supplyStatus } from '../construction/electrical-wiring';

/** Badge radius in screen pixels: a status marker, the same size at any zoom. */
export const NO_POWER_BADGE_RADIUS = 9;

/** The ids of the parts to badge. */
export function unpoweredParts(plant: PlantState, sim: SimulationState | null, construction: boolean): string[] {
  if (!plant.electrical?.enabled) return [];
  const E = construction ? undefined : sim?.electrical;
  const out: string[] = [];
  if (E) {
    for (const l of Object.values(E.loads)) if (!l.powered) out.push(l.id);
    for (const id of E.order) {
      const e = E.elements[id];
      const fed = e.kind === 'bus' || e.kind === 'transformer' || e.kind === 'breaker' || e.kind === 'battery';
      if (fed && !e.energized) out.push(id);
    }
    return out;
  }
  for (const c of plant.components.values()) {
    if (supplyStatus(plant, c as never)?.problem) out.push(c.id);
  }
  return out;
}

/** Draw the badge centred at (x, y), radius r (px). */
export function drawNoPowerBadge(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.save();
  // Dark disc so it reads against any sprite
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(18, 20, 24, 0.88)';
  ctx.fill();
  // Lightning bolt
  const s = r / 10;
  ctx.beginPath();
  ctx.moveTo(x + 1.5 * s, y - 7.5 * s);
  ctx.lineTo(x - 4.5 * s, y + 1.0 * s);
  ctx.lineTo(x - 0.5 * s, y + 1.0 * s);
  ctx.lineTo(x - 2.0 * s, y + 7.5 * s);
  ctx.lineTo(x + 4.5 * s, y - 1.5 * s);
  ctx.lineTo(x + 0.5 * s, y - 1.5 * s);
  ctx.closePath();
  ctx.fillStyle = '#ffd23a';
  ctx.fill();
  // No-symbol: ring and slash
  const ring = r * 0.86;
  ctx.lineWidth = Math.max(1.5, r * 0.2);
  ctx.strokeStyle = '#e8322a';
  ctx.beginPath();
  ctx.arc(x, y, ring, 0, Math.PI * 2);
  ctx.stroke();
  const d = ring * Math.SQRT1_2;
  ctx.beginPath();
  ctx.moveTo(x - d, y - d);
  ctx.lineTo(x + d, y + d);
  ctx.stroke();
  ctx.restore();
}
