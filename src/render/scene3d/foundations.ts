/**
 * What every standing component rests on - the 2.5D view's rule
 * (canvas.ts foundationsFor), restated without a camera so the 3D scene
 * model can lay the same pads. Kept a line-for-line port: if the 2.5D rule
 * changes, change this with it.
 *
 * A component rests on the highest top, among the other standing components
 * whose footprint holds its centre, that is no higher than its own base - or
 * on grade if there is none (or that top is at or below grade). Buildings,
 * yards, pools and water are the ground itself; pipes carry no foundation;
 * anything inside a vessel is carried by the vessel. A small piped fitting,
 * a cross-vessel, or anything whose footprint reaches into a building's wall
 * is carried by its piping / its vessels / the wall when it is up in the air.
 */
import type { BuildingComponent, PlantComponent, PlantState } from '../../types';
import { PlanRect, componentFootprint, footprintRect, isGroundLayerComponent } from '../grid-geometry';
import { getComponentElevation } from '../isometric';
import { getComponentVisualHeight } from '../components';

export interface Foundation {
  rect: PlanRect;
  /** Elevation (above local ground) of what it stands on. */
  base: number;
  /** The component's own base elevation. */
  top: number;
  onGround: boolean;
}

/** Thickness of a concrete pad, m (canvas.ts PAD_THICKNESS_M). */
export const PAD_THICKNESS_M = 0.2;

/** How far a pad stands out past its footprint, m (canvas.ts renderPads). */
export function padMargin(r: PlanRect): number {
  return Math.min(1.5, Math.min(r.x1 - r.x0, r.y1 - r.y0) * 0.09);
}

export function foundationsFor(plantState: PlantState, components: PlantComponent[]): Map<string, Foundation> {
  const piped = new Set<string>();
  for (const conn of plantState.connections) {
    piped.add(conn.fromComponentId);
    piped.add(conn.toComponentId);
  }
  const buildings = components.filter(c => c.type === 'building') as BuildingComponent[];
  const inWall = (r: PlanRect, base: number): boolean => buildings.some(b => {
    if (base > b.height) return false;
    const t = b.wallThickness;
    if (b.shape === 'cylinder') {
      const R = (b.diameter || 40) / 2;
      const { x: cx, y: cy } = b.position;
      const nearest = Math.hypot(Math.max(r.x0 - cx, 0, cx - r.x1), Math.max(r.y0 - cy, 0, cy - r.y1));
      const farthest = Math.hypot(Math.max(Math.abs(r.x0 - cx), Math.abs(r.x1 - cx)), Math.max(Math.abs(r.y0 - cy), Math.abs(r.y1 - cy)));
      return nearest <= R && farthest >= R - t;
    }
    const hw = (b.width || 40) / 2, hl = (b.length || 40) / 2;
    const o = { x0: b.position.x - hw, x1: b.position.x + hw, y0: b.position.y - hl, y1: b.position.y + hl };
    const overlapsOuter = r.x0 <= o.x1 && r.x1 >= o.x0 && r.y0 <= o.y1 && r.y1 >= o.y0;
    const insideInner = r.x0 > o.x0 + t && r.x1 < o.x1 - t && r.y0 > o.y0 + t && r.y1 < o.y1 - t;
    return overlapsOuter && !insideInner;
  });
  const standing = components
    .filter(c => c.type !== 'pipe' && !isGroundLayerComponent(c))
    .filter(c => {
      const container = c.containedBy ? plantState.components.get(c.containedBy) : undefined;
      return !container || container.type === 'building';
    })
    .map(c => {
      const base = getComponentElevation(c);
      const fp = componentFootprint(c);
      return {
        c, rect: footprintRect(c.position, fp), base, top: base + getComponentVisualHeight(c),
        hangs: fp.w === 1 && fp.d === 1 && piped.has(c.id),
      };
    });
  const out = new Map<string, Foundation>();
  for (const s of standing) {
    const { x, y } = s.c.position;
    let support = -Infinity;
    for (const o of standing) {
      if (o === s || o.top > s.base || o.top <= support) continue;
      if (x >= o.rect.x0 && x <= o.rect.x1 && y >= o.rect.y0 && y <= o.rect.y1) support = o.top;
    }
    const onGround = !(support > 0);
    const base = onGround ? 0 : support;
    if (s.base > base && (s.hangs || s.c.type === 'crossVessel' || inWall(s.rect, s.base))) continue;
    out.set(s.c.id, { rect: s.rect, base, top: s.base, onGround });
  }
  return out;
}
