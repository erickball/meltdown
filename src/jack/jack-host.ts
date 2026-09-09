import type { PlantState } from '../types';
import type { ConstructionManager } from '../construction/construction-manager';
import type { SimulationState } from '../simulation/types';
import type { CarBundleSource } from './jack-car-bundle';

/**
 * Everything Jack needs from the rest of the app, gathered in one object
 * (same pattern as GameHost). main.ts constructs this inside init() so the
 * closures can reach its local state.
 */
export interface JackHost {
  plantState: PlantState;
  constructionManager: ConstructionManager;
  /** Latest simulation state, or null if the sim hasn't been built yet */
  getSimState: () => SimulationState | null;
  /**
   * Recorded history states in a sim-time range, oldest first (for Jack's
   * query/plot tools). READ-ONLY: these are the live history snapshots.
   */
  getHistoryStates: (tMin: number, tMax: number) => Array<{ time: number; state: SimulationState }>;
  getMode: () => 'construction' | 'simulation';
  getSelectedComponentId: () => string | null;
  /** Refresh the construction cost panel after Jack edits the plant */
  refreshCostPanel: () => void;
  /**
   * The plant design, live sim state and rewind history for a bug report's
   * reproduction bundle (jack-car-bundle.ts), or null when no simulation
   * has been built yet. The history is handed out BY REFERENCE and must
   * only be read.
   */
  captureReproSource: () => CarBundleSource | null;
}

/** One entry in the recent-edits journal shown to Jack as context. */
export interface PlantChange {
  source: 'user' | 'jack';
  description: string;
  simTime: number;
}
