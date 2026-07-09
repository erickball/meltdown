import type { PlantState } from '../types';
import type { ConstructionManager } from '../construction/construction-manager';
import type { SimulationState } from '../simulation/types';

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
  getMode: () => 'construction' | 'simulation';
  getSelectedComponentId: () => string | null;
  /** Refresh the construction cost panel after Jack edits the plant */
  refreshCostPanel: () => void;
}

/** One entry in the recent-edits journal shown to Jack as context. */
export interface PlantChange {
  source: 'user' | 'jack';
  description: string;
  simTime: number;
}
