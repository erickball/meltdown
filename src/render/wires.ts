/**
 * Power wiring: where the cables run in plan and how they are drawn.
 *
 * A wire is one supply link (a component's `powerSupplyId`, or a bus's
 * backup). It runs along the ground on the 1 m lattice, steering round
 * standing equipment with the same search pipes use, from the middle of its
 * supply to the middle of the component it feeds - the component drawn on
 * top hides the last metre, so it reads as a cable coming up underneath.
 *
 * Drawn as a hair-thin twisted pair: two strands crossing every
 * TWIST_PITCH_M. When the twist is too small to see it is drawn as what the
 * eye sees from there, a two-tone dotted line. Wires cost nothing and carry
 * no physics - this is the picture of the wiring, nothing more.
 */

import type { PlantState, Point } from '../types';
import { wireLinks } from '../construction/electrical-wiring';
import { routeObstacles, obstaclesKey, searchRoute, laneOffsetRoutes } from './grid-geometry';

/** Length of one full twist of the pair (m). */
export const TWIST_PITCH_M = 0.3;
/** Drawn cable width for lane spacing (m): cables in a shared run sit side by side. */
const CABLE_WIDTH_M = 0.12;

export interface WireRun {
  key: string;
  fromId: string;
  toId: string;
  /** Plan polyline (m), supply end first. */
  pts: Point[];
}

let cache: { sig: string; runs: WireRun[] } | null = null;

/** The routed wires of the plant (cached until equipment or wiring changes). */
export function wireRuns(plant: PlantState): WireRun[] {
  const links = wireLinks(plant);
  if (links.length === 0) return [];
  const obstacles = routeObstacles(plant);
  const at = (id: string) => plant.components.get(id)!.position;
  const sig = obstaclesKey(obstacles) + '|' +
    links.map(l => `${l.key}@${at(l.fromId).x},${at(l.fromId).y},${at(l.toId).x},${at(l.toId).y}`).join(';');
  if (cache && cache.sig === sig) return cache.runs;

  const raw = links.map(l => {
    // The two ends' own footprints are not in the way of their own cable
    const others = obstacles.filter(o => o.id !== l.fromId && o.id !== l.toId);
    return { ...l, pts: searchRoute(at(l.fromId), at(l.toId), others) };
  });
  const laned = laneOffsetRoutes(raw.map(r => ({ key: r.key, pts: r.pts, width: CABLE_WIDTH_M })));
  const runs = raw.map(r => ({ ...r, pts: (laned.get(r.key) as Point[] | undefined) ?? r.pts }));
  cache = { sig, runs };
  return runs;
}

/**
 * Stroke a twisted pair along a screen-space polyline.
 *
 * `pitchPx` is one twist in pixels at this zoom; `energized` picks the
 * colours (true: live copper, false: dead grey, null: no running plant).
 */
export function drawTwistedPair(
  ctx: CanvasRenderingContext2D, pts: Point[], pitchPx: number, energized: boolean | null
): void {
  if (pts.length < 2) return;
  const [a, b] = energized === true ? ['#f0b040', '#9a6010']
    : energized === false ? ['#8a8a8a', '#4a4a4a']
    : ['#c89050', '#6a4418'];
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1;

  if (pitchPx < 5) {
    // Too fine to resolve: the pair reads as alternating dots of its two colours
    const dot = Math.max(1, pitchPx / 2);
    ctx.setLineDash([dot, dot]);
    for (const [color, offset] of [[a, 0], [b, dot]] as const) {
      ctx.strokeStyle = color;
      ctx.lineDashOffset = offset;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  // Two strands in antiphase about the centreline, continuous in arc length
  // across the polyline's corners so the twist does not restart at each bend
  const amp = Math.min(1.6, pitchPx * 0.15);
  const step = pitchPx / 12;
  for (const [color, sign] of [[a, 1], [b, -1]] as const) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    let s0 = 0;
    let first = true;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < 1e-6) continue;
      const ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = first ? 0 : 1; k <= n; k++) {
        const d = (k / n) * len;
        const w = sign * amp * Math.sin((2 * Math.PI * (s0 + d)) / pitchPx);
        const x = p.x + ux * d - uy * w;
        const y = p.y + uy * d + ux * w;
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      }
      s0 += len;
    }
    ctx.stroke();
  }
  ctx.restore();
}
