/**
 * Save/restore a RUNNING simulation as plain JSON.
 *
 * SimulationState is Map-heavy but otherwise plain data: no typed arrays, no
 * object cycles (nodes reference each other by string id), and no live RNG
 * (the burst randomness is drawn at creation and stored in BurstState). So a
 * faithful snapshot is exactly cloneSimulationState() with every Map spelled
 * as an entries array — and restore is the inverse.
 *
 * The snapshot must travel WITH the plant design that produced it: loading
 * rebuilds the solver/operators from the design, then swaps this state in.
 */

import { SimulationState } from './types';
import type { PlantState, PlantComponent } from '../types';
import { cloneSimulationState } from './solver';

export const SIM_STATE_VERSION = 1;

export function serializeSimulationState(state: SimulationState): unknown {
  // Deep-clone first so we serialize a detached snapshot (cloneSimulationState
  // already walks every nested mutable object).
  const s = cloneSimulationState(state);
  return {
    version: SIM_STATE_VERSION,
    ...s,
    thermalNodes: Array.from(s.thermalNodes.entries()),
    flowNodes: Array.from(s.flowNodes.entries()),
    components: {
      pumps: Array.from(s.components.pumps.entries()),
      valves: Array.from(s.components.valves.entries()),
      checkValves: Array.from(s.components.checkValves.entries()),
      controllers: Array.from(s.components.controllers.entries()),
    },
    energyDiagnostics: s.energyDiagnostics
      ? {
          ...s.energyDiagnostics,
          heatTransferRates: Array.from(s.energyDiagnostics.heatTransferRates.entries()),
        }
      : undefined,
    liquidBasePressures: s.liquidBasePressures
      ? Array.from(s.liquidBasePressures.entries())
      : undefined,
    burstStates: s.burstStates ? Array.from(s.burstStates.entries()) : undefined,
    // transient, consumed each step - not worth persisting
    pendingEvents: undefined,
    scenario: s.scenario ? { events: s.scenario.events, fired: s.scenario.fired } : undefined,
  };
}

export function deserializeSimulationState(data: Record<string, unknown>): SimulationState {
  const version = data.version;
  if (version !== SIM_STATE_VERSION) {
    throw new Error(
      `Saved simulation state has version ${String(version)}; this build reads version ${SIM_STATE_VERSION}. ` +
      'Refusing to guess at a migration - re-save the simulation with the current build.'
    );
  }
  const d = data as Record<string, any>;
  const state = {
    ...d,
    thermalNodes: new Map(d.thermalNodes),
    flowNodes: new Map(d.flowNodes),
    components: {
      pumps: new Map(d.components.pumps),
      valves: new Map(d.components.valves),
      checkValves: new Map(d.components.checkValves),
      controllers: new Map(d.components.controllers),
    },
    energyDiagnostics: d.energyDiagnostics
      ? {
          ...d.energyDiagnostics,
          heatTransferRates: new Map(d.energyDiagnostics.heatTransferRates),
        }
      : undefined,
    liquidBasePressures: d.liquidBasePressures ? new Map(d.liquidBasePressures) : undefined,
    burstStates: d.burstStates ? new Map(d.burstStates) : undefined,
    pendingEvents: [],
    scenario: d.scenario ? { events: (d.scenario as any).events, fired: (d.scenario as any).fired } : undefined,
  } as unknown as SimulationState;
  delete (state as unknown as Record<string, unknown>).version;
  return state;
}

// ---------------------------------------------------------------------------
// Plant design + generic Map-aware JSON
//
// A running-sim snapshot only means something next to the design that built
// it, so both the in-app save and Jack's bug-report bundle carry the design
// in this one shape (component entries, connections, optional scenario and
// terrain).
// ---------------------------------------------------------------------------

/** The plant design as plain JSON: what a save file / preset / import holds. */
export function serializePlantDesign(plant: PlantState): Record<string, unknown> {
  // A DEEP copy, not a view. The history keeps one of these per epoch and
  // restores it when the player rewinds past an edit; a design that shared
  // its component objects with the live plant would be rewritten by every
  // later edit - the supply yard's `stock` is mutated in place on each
  // placement, so "back to t=0" used to put back a warehouse that had
  // already been emptied.
  return JSON.parse(JSON.stringify({
    components: Array.from(plant.components.entries()),
    connections: plant.connections,
    ...(plant.scenario ? { scenario: plant.scenario } : {}),
    ...(plant.terrain ? { terrain: plant.terrain } : {}),
    ...(plant.electrical ? { electrical: plant.electrical } : {}),
  }));
}

/** Inverse of serializePlantDesign (a fresh PlantState; nothing shared). */
export function deserializePlantDesign(input: Record<string, unknown>): PlantState {
  if (!Array.isArray(input.components)) {
    throw new Error('[serialization] Plant design has no components array');
  }
  // Copy on the way out too: the caller installs these objects as the live
  // plant, and the history's epoch must not follow the plant's later edits
  const data = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  const plant = {
    components: new Map(data.components as Array<[string, PlantComponent]>),
    connections: Array.isArray(data.connections) ? data.connections : [],
  } as unknown as PlantState;
  if (data.scenario) plant.scenario = data.scenario as PlantState['scenario'];
  if (data.terrain) plant.terrain = data.terrain as PlantState['terrain'];
  if (data.electrical) plant.electrical = data.electrical as PlantState['electrical'];
  return plant;
}

/**
 * JSON replacer/reviver pair that spells every Map as {"__map": [entries]}.
 * Lets a whole nest of sim states, history snapshots and solver contexts be
 * stringified in one pass without cloning each state first (the history's
 * snapshots are already detached copies, and JSON.stringify never mutates).
 * The revived object has real Maps back, so a sim state that went through
 * this pair is usable directly - no per-field conversion list to keep in
 * sync with SimulationState.
 */
export function mapAwareReplacer(this: unknown, _key: string, value: unknown): unknown {
  if (value instanceof Map) return { __map: Array.from(value.entries()) };
  return value;
}

export function mapAwareReviver(_key: string, value: unknown): unknown {
  if (
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Array.isArray((value as { __map?: unknown }).__map) &&
    Object.keys(value as object).length === 1
  ) {
    return new Map((value as { __map: Array<[unknown, unknown]> }).__map);
  }
  return value;
}
