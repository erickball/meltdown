/**
 * Pipe runs in the 2.5D view.
 *
 * A run is laid the way the grid view lays it: along the grid's plan route
 * (the same A* route, laned the same way, so the two views show the same
 * piping), with square turns. What the grid cannot show is height, so the
 * plan route is lifted into 3D here: the run leaves each nozzle along the
 * direction the route leaves that footprint in, travels at the LOWER of its
 * two nozzle elevations, and rises (or drops) plumb to the higher nozzle
 * one cell out from that component - the way a line comes down off a tall
 * vessel to run along grade rather than crossing the plant in mid-air.
 *
 * Everything here is pure geometry and canvas drawing; the projection is
 * the caller's.
 */
import { Point } from '../types';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** A projected vertex of a run: screen position and the pipe's drawn width there (px). */
export interface RunVertex {
  x: number;
  y: number;
  w: number;
}

const EPS = 1e-6;

/**
 * The 3D polyline of a run from nozzle `a` to nozzle `b` along a plan route.
 *
 * `plan` starts on a's footprint edge and ends on b's (grid anchors); the
 * nozzles themselves sit on the component drawings, so each end gets a
 * square jog between the nozzle and the route: out along `aAxis` first,
 * and into b along `bAxis` last (the axis of the footprint side the route
 * leaves by). A route shorter than two points is replaced by a plain
 * dog-leg between the nozzles.
 */
export function liftRoute(a: Point3, aAxis: 'x' | 'y', plan: Point[], b: Point3, bAxis: 'x' | 'y'): Point3[] {
  const route = plan.length >= 2 ? plan : [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  const n = route.length - 1;
  const zRun = Math.min(a.z, b.z);
  // Where the plumb legs stand: one route vertex in from each end (the cell
  // just outside the footprint), or the middle of a two-point route
  const i1 = Math.min(1, n);
  const i2 = Math.max(n - 1, i1);

  const out: Point3[] = [a];
  const first = route[0];
  out.push(aAxis === 'x' ? { x: first.x, y: a.y, z: a.z } : { x: a.x, y: first.y, z: a.z });
  for (let i = 0; i <= n; i++) {
    const p = route[i];
    const zIn = i <= i1 ? a.z : i <= i2 ? zRun : b.z;
    const zOut = i < i1 ? a.z : i < i2 ? zRun : b.z;
    out.push({ x: p.x, y: p.y, z: zIn });
    if (Math.abs(zOut - zIn) > EPS) out.push({ x: p.x, y: p.y, z: zOut });
  }
  const last = route[n];
  out.push(bAxis === 'x' ? { x: last.x, y: b.y, z: b.z } : { x: b.x, y: last.y, z: b.z });
  out.push(b);
  return simplify3(out);
}

/**
 * A pipe component's run: its plan route with the height carried linearly
 * along the plan length from its start elevation to its end elevation, so a
 * sloping line still reads as sloping.
 */
export function slopeRoute(plan: Point[], startZ: number, endZ: number): Point3[] {
  let total = 0;
  for (let i = 1; i < plan.length; i++) total += Math.hypot(plan[i].x - plan[i - 1].x, plan[i].y - plan[i - 1].y);
  let s = 0;
  const out: Point3[] = [];
  for (let i = 0; i < plan.length; i++) {
    if (i > 0) s += Math.hypot(plan[i].x - plan[i - 1].x, plan[i].y - plan[i - 1].y);
    const t = total > EPS ? s / total : 0;
    out.push({ x: plan[i].x, y: plan[i].y, z: startZ + (endZ - startZ) * t });
  }
  return simplify3(out);
}

/** Drop repeated vertices and the middle of straight runs (they would draw as elbows). */
function simplify3(pts: Point3[]): Point3[] {
  const dedup: Point3[] = [];
  for (const p of pts) {
    const q = dedup[dedup.length - 1];
    if (q && Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS && Math.abs(p.z - q.z) < EPS) continue;
    dedup.push(p);
  }
  if (dedup.length < 3) return dedup;
  const out: Point3[] = [dedup[0]];
  for (let i = 1; i < dedup.length - 1; i++) {
    const p = out[out.length - 1], q = dedup[i], r = dedup[i + 1];
    const u = { x: q.x - p.x, y: q.y - p.y, z: q.z - p.z };
    const v = { x: r.x - q.x, y: r.y - q.y, z: r.z - q.z };
    const cross = Math.hypot(u.y * v.z - u.z * v.y, u.z * v.x - u.x * v.z, u.x * v.y - u.y * v.x);
    const dot = u.x * v.x + u.y * v.y + u.z * v.z;
    const scale = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z);
    if (cross <= EPS * Math.max(1, scale) && dot > 0) continue;
    out.push(q);
  }
  out.push(dedup[dedup.length - 1]);
  return out;
}

/** Point and unit direction half way along a screen polyline. */
export function screenMidpoint(pts: Point[]): { point: Point; dir: Point } {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let target = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > EPS && (target <= len || i === pts.length - 1)) {
      const t = Math.min(1, target / len);
      return {
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        dir: { x: (b.x - a.x) / len, y: (b.y - a.y) / len },
      };
    }
    target -= len;
  }
  return { point: pts[0] ?? { x: 0, y: 0 }, dir: { x: 1, y: 0 } };
}

/**
 * Draw a run the way the grid draws one - dark wall, fluid-coloured body, a
 * sheen along its upper side, collars at the bends, flanges at the ends -
 * with the width following the perspective from vertex to vertex. `halo`,
 * when given, is the colour of a selection halo laid under the whole run.
 */
export function drawPipeRun(ctx: CanvasRenderingContext2D, pts: RunVertex[], color: string, halo: string | null): void {
  if (pts.length < 2) return;

  // Consecutive legs drawn (nearly) the same width share one path, so a run
  // across the plant is a few strokes per pass rather than one per leg
  const groups: Array<{ from: number; to: number; w: number }> = [];
  for (let i = 1; i < pts.length; i++) {
    const w = (pts[i - 1].w + pts[i].w) / 2;
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.w - w) < 0.5) g.to = i;
    else groups.push({ from: i - 1, to: i, w });
  }
  const pass = (widthOf: (w: number) => number) => {
    for (const g of groups) {
      ctx.lineWidth = widthOf(g.w);
      ctx.beginPath();
      ctx.moveTo(pts[g.from].x, pts[g.from].y);
      for (let i = g.from + 1; i <= g.to; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (halo) {
    ctx.strokeStyle = halo;
    pass(w => w + 8);
  }
  ctx.strokeStyle = '#2a2e33';
  pass(w => w + 2);
  ctx.strokeStyle = color;
  pass(w => w);

  // The detailing below is a pixel or less on a small-bore line - invisible,
  // and more strokes each - so it is drawn only where it can be seen
  if (Math.max(...pts.map(p => p.w)) < 5) { ctx.restore(); return; }

  // Sheen on the side of each leg that faces up (left on a plumb leg)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const w = (a.w + b.w) / 2;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    if (ny > 0 || (Math.abs(ny) < EPS && nx > 0)) { nx = -nx; ny = -ny; }
    ctx.lineWidth = Math.max(1, w * 0.22);
    ctx.beginPath();
    ctx.moveTo(a.x + nx * w * 0.22, a.y + ny * w * 0.22);
    ctx.lineTo(b.x + nx * w * 0.22, b.y + ny * w * 0.22);
    ctx.stroke();
  }

  // Elbows: a weld collar round the bend. Only a ring - a filled disc the
  // size of a big duct's bore reads as a blob, not a fitting.
  ctx.strokeStyle = 'rgba(28, 31, 35, 0.75)';
  for (let i = 1; i < pts.length - 1; i++) {
    ctx.lineWidth = Math.max(1, pts[i].w * 0.12);
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, pts[i].w * 0.5 + 1, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Flanges at the nozzles, across the leg that meets them
  ctx.fillStyle = '#4a5058';
  ctx.strokeStyle = '#1c1f23';
  ctx.lineWidth = 1;
  for (const [a, b] of [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]]) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const nx = -dy / d, ny = dx / d;
    const half = a.w * 0.75;
    const thick = Math.max(2, a.w * 0.28);
    ctx.beginPath();
    ctx.moveTo(a.x + nx * half, a.y + ny * half);
    ctx.lineTo(a.x - nx * half, a.y - ny * half);
    ctx.lineTo(a.x - nx * half + dx / d * thick, a.y - ny * half + dy / d * thick);
    ctx.lineTo(a.x + nx * half + dx / d * thick, a.y + ny * half + dy / d * thick);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
