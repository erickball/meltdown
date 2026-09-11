/**
 * The plant side of the electrical model: which pieces may feed a
 * component, which of them is the sensible default, wiring everything that
 * is not yet wired, and the list of wires to draw.
 *
 * Every rule about what may feed what comes from simulation/electrical-rules
 * (the same rules the solve applies), so a supply the dialog offers as
 * compatible is one the simulation will power from.
 */

import type { PlantState, PlantComponent, Point } from '../types';
import {
  supplyRequirementFor, feederTypesFor, acceptsSupply, formatVoltage,
} from '../simulation/electrical-rules';

/** The two supply fields a component can carry. */
function feedsOf(c: PlantComponent): string[] {
  const any = c as unknown as { powerSupplyId?: string; backupPowerSupplyId?: string };
  return [any.powerSupplyId, any.backupPowerSupplyId].filter((f): f is string => !!f);
}

/**
 * What a network piece in the plant delivers: a breaker passes on whatever
 * feeds it. Null for something that delivers nothing (not a network piece,
 * or a breaker fed from nothing).
 */
export function plantOutputVoltage(
  plant: PlantState, id: string, seen: Set<string> = new Set()
): { voltage: number; dc: boolean } | null {
  const c = plant.components.get(id) as Record<string, any> | undefined;
  if (!c || seen.has(id)) return null;
  seen.add(id);
  switch (c.type) {
    case 'switchyard': return { voltage: (c.transmissionVoltage ?? 345) * 1000, dc: false };
    case 'bus': return { voltage: c.voltage, dc: !!c.dc };
    case 'transformer': return { voltage: c.secondaryVoltage, dc: false };
    case 'diesel-generator': return { voltage: c.voltage, dc: false };
    case 'turbine-generator': return { voltage: c.terminalVoltage ?? 22000, dc: false };
    case 'battery': return { voltage: c.voltage, dc: true };
    case 'breaker': return c.powerSupplyId ? plantOutputVoltage(plant, c.powerSupplyId, seen) : null;
    default: return null;
  }
}

/** Every component fed, directly or through others, from `id` (it cannot feed `id` back). */
export function downstreamOf(plant: PlantState, id: string): Set<string> {
  const fedBy = new Map<string, string[]>();
  for (const c of plant.components.values()) {
    for (const f of feedsOf(c)) {
      const list = fedBy.get(f) ?? [];
      list.push(c.id);
      fedBy.set(f, list);
    }
  }
  const out = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    for (const next of fedBy.get(stack.pop()!) ?? []) {
      if (!out.has(next)) { out.add(next); stack.push(next); }
    }
  }
  return out;
}

export interface SupplyChoice {
  id: string;
  label: string;
  /** At a voltage this component accepts. Incompatible ones are listed, marked, after. */
  compatible: boolean;
}

/**
 * The pieces that could feed `target` - the component as it stands, or as it
 * will be built (its type, the fields that set what it accepts, and where it
 * goes). Compatible supplies first, nearest first; a supply fed from
 * `target` itself is never offered, so the dialog cannot close a loop.
 */
export function powerSupplyChoices(plant: PlantState, target: Record<string, any>): SupplyChoice[] {
  const req = supplyRequirementFor(target);
  if (!req) return [];
  const allowed = feederTypesFor(target.type);
  const excluded = target.id ? downstreamOf(plant, target.id) : new Set<string>();
  if (target.id) excluded.add(target.id);
  const pos: Point = target.position ?? { x: 0, y: 0 };
  const rows: Array<SupplyChoice & { d: number }> = [];
  for (const c of plant.components.values()) {
    if (!allowed.has(c.type) || excluded.has(c.id)) continue;
    const v = plantOutputVoltage(plant, c.id);
    const compatible = !!v && acceptsSupply(req, v.voltage, v.dc);
    const volts = v ? formatVoltage(v.voltage, v.dc) : 'not fed from anything';
    rows.push({
      id: c.id,
      label: `${c.label || c.id} (${volts})${compatible ? '' : ' - wrong voltage'}`,
      compatible,
      d: Math.hypot(c.position.x - pos.x, c.position.y - pos.y),
    });
  }
  rows.sort((a, b) => (a.compatible === b.compatible ? a.d - b.d : a.compatible ? -1 : 1));
  return rows.map(({ id, label, compatible }) => ({ id, label, compatible }));
}

/** The nearest supply `target` could run from, if there is one. */
export function nearestCompatibleSupply(plant: PlantState, target: Record<string, any>): string | undefined {
  return powerSupplyChoices(plant, target).find(c => c.compatible)?.id;
}

/**
 * Give every component that needs a supply and has none the nearest
 * compatible one. The network's own pieces go first (a breaker only has a
 * voltage once it is fed), repeated until nothing more can be wired.
 * Returns the ids wired.
 */
export function autoWirePlant(plant: PlantState): string[] {
  const wired: string[] = [];
  for (;;) {
    let changed = false;
    const pending = [...plant.components.values()]
      .filter(c => !(c as { powerSupplyId?: string }).powerSupplyId && supplyRequirementFor(c as never))
      // network pieces before loads; nearer the grid first is not knowable
      // here, so pieces are simply retried until the wiring settles
      .sort((a, b) => Number(!isNetworkPiece(a)) - Number(!isNetworkPiece(b)));
    for (const c of pending) {
      const supply = nearestCompatibleSupply(plant, c as never);
      if (supply) {
        (c as { powerSupplyId?: string }).powerSupplyId = supply;
        wired.push(c.id);
        changed = true;
      }
    }
    if (!changed) return wired;
  }
}

function isNetworkPiece(c: PlantComponent): boolean {
  return c.type === 'bus' || c.type === 'transformer' || c.type === 'breaker' || c.type === 'battery';
}

/** One wire: power runs from `fromId` to `toId`. */
export interface WireLink {
  key: string;
  fromId: string;
  toId: string;
}

/** The wires the plant's supply fields describe (none with the model off). */
export function wireLinks(plant: PlantState): WireLink[] {
  if (!plant.electrical?.enabled) return [];
  const links: WireLink[] = [];
  for (const c of plant.components.values()) {
    for (const f of feedsOf(c)) {
      if (plant.components.has(f)) links.push({ key: `${f}>${c.id}`, fromId: f, toId: c.id });
    }
  }
  return links;
}

/** Drop every supply reference to a removed component (its wires go with it). */
export function clearPowerReferences(plant: PlantState, removed: Set<string>): void {
  for (const c of plant.components.values()) {
    const any = c as unknown as { powerSupplyId?: string; backupPowerSupplyId?: string };
    if (any.powerSupplyId && removed.has(any.powerSupplyId)) delete any.powerSupplyId;
    if (any.backupPowerSupplyId && removed.has(any.backupPowerSupplyId)) delete any.backupPowerSupplyId;
  }
}
