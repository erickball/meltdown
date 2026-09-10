/**
 * What a wave takes with it.
 *
 * Standing water is one thing: a pump whose motor is under it stops
 * (surface-water.ts, `flooded`) and runs again when the water is gone.
 * A WAVE is another. When a terrain water body stands well above its own
 * declared surface - a tsunami running up the hill - the water is moving, and
 * anything it closes over is carried off: the component is gone from the
 * plant and a wreck floats away in the debris.
 *
 * This module only DECIDES; it is pure. The app (main.ts) removes the
 * components through the same live-edit machinery a player's delete uses,
 * so the history records it and a rewind brings them back.
 *
 * The rule, per component:
 *   - the water body's surface must be more than WAVE_TRIGGER above its
 *     baseline (the same threshold that seeds the flood debris - one notion
 *     of "a wave is running"), and
 *   - that surface must be above the component's wash-away elevation: its
 *     base (ground + elevation) for most things, its MOTOR for a pump, which
 *     is what lets a wet-pit intake pump stand in the sea with its bowl under
 *     water and its motor on a column above it.
 * Puddles (basins with no water body) never carry anything away, however
 * deep: they are still water.
 *
 * What is never taken: the water bodies themselves (a tank drawn as the sea),
 * pools and warehouses (sunk into or laid on the ground), buildings and
 * switchyards (the map's fixed structures), and anything inside a container
 * (its container's fate decides).
 */

import { PlantState, PlantComponent, PumpComponent, pumpMotorElevation, waterBodyOf } from '../types';
import { SimulationState } from './types';
import { terrainHeightAt, cellAt } from './terrain';

/** How far above its declared surface a body has to stand for it to count as a wave running, m. */
export const WAVE_TRIGGER = 0.5;

export interface WaveCasualty {
  id: string;
  label: string;
  /** The terrain water body that took it. */
  bodyId: string;
  /** The body's surface at the time, absolute m. */
  surface: number;
  /** The elevation the water had to pass, absolute m. */
  washAwayElevation: number;
  /** Where it stood (plan), for the wreck. */
  position: { x: number; y: number };
}

/**
 * The absolute elevation above which water carries this component away, or
 * null for a component a wave never takes.
 */
export function washAwayElevation(plant: PlantState, component: PlantComponent): number | null {
  if (waterBodyOf(component as { type: string; waterBody?: string })) return null;
  switch (component.type) {
    case 'pool':
    case 'warehouse':
    case 'building':
    case 'switchyard':
      return null;
  }
  if (component.containedBy) return null;
  const base = terrainHeightAt(plant.terrain, component.position) + (component.elevation ?? 0);
  return component.type === 'pump' ? base + pumpMotorElevation(component as PumpComponent) : base;
}

/** Every component a running wave has closed over right now. */
export function waveCasualties(plant: PlantState, state: SimulationState): WaveCasualty[] {
  const model = state.terrain;
  const sw = state.surfaceWater;
  if (!model || !sw) return [];

  // The bodies with a wave running, by basin
  const running = new Map<number, { id: string; surface: number }>();
  for (const [id, body] of sw.bodies) {
    const baseline = model.basins[body.basin]?.water?.surface;
    if (baseline === undefined) continue;
    if (body.surface > baseline + WAVE_TRIGGER) running.set(body.basin, { id, surface: body.surface });
  }
  if (running.size === 0) return [];

  const out: WaveCasualty[] = [];
  for (const [id, component] of plant.components) {
    const limit = washAwayElevation(plant, component);
    if (limit === null) continue;
    const basin = model.basinOf[cellAt(model.spec, component.position)];
    const wave = running.get(basin);
    if (!wave || !(wave.surface > limit)) continue;
    out.push({
      id,
      label: component.label || id,
      bodyId: wave.id,
      surface: wave.surface,
      washAwayElevation: limit,
      position: { x: component.position.x, y: component.position.y },
    });
  }
  return out;
}
