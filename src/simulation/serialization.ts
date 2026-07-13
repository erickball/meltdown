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
  } as unknown as SimulationState;
  delete (state as unknown as Record<string, unknown>).version;
  return state;
}
