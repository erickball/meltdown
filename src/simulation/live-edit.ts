/**
 * Live plant edits: change the plant WHILE the simulation is running.
 *
 * This is the same machinery as the construction/simulation mode round trip
 * (see resume.ts) with the pause taken out. One edit is:
 *
 *   1. beginLivePlantEdit  - write the live simulation state back into the
 *      components' initial-condition fields, then capture a ResumeSnapshot.
 *      This MUST happen before the plant is touched and before any edit
 *      dialog is populated: the dialog reads those same IC fields, so the
 *      write-back is what makes it show CURRENT conditions, and the snapshot
 *      taken straight afterwards is what makes "nothing changed" mean
 *      "nothing changed" (capture it before the write-back and every single
 *      component reads as edited).
 *   2. the caller mutates the plant (place, delete, connect, edit properties)
 *   3. commitLivePlantEdit - rebuild the simulation from the edited plant and
 *      transplant the live state of every component that did not change.
 *      New components start from their factory initial conditions; new
 *      connections start at zero flow; simulated time is unchanged.
 *
 * There is deliberately no second transplant path - beginning/committing here
 * calls the same writeSimulationStateToPlant / captureResumeSnapshot /
 * transplantSimulationState that setMode uses.
 *
 * The rebuild can throw (the factory refuses designs it cannot wire). Because
 * the plant has already been mutated by then, a snapshot also carries a deep
 * copy of the plant so the caller can put it back exactly as it was rather
 * than leave a running simulation that no longer describes the plant on
 * screen. That is what revertLivePlantEdit does.
 */

import { SimulationState } from './types';
import { PlantState } from '../types';
import { createSimulationFromPlant } from './factory';
import {
  ResumeSnapshot,
  writeSimulationStateToPlant,
  captureResumeSnapshot,
  transplantSimulationState,
} from './resume';

/** A live edit in progress: the resume snapshot plus the pre-edit plant. */
export interface LiveEditSnapshot {
  resume: ResumeSnapshot;
  /** Deep copy of the plant as it was before the write-back and the edit. */
  plantBackup: PlantState;
}

export interface LiveEditResult {
  /** The rebuilt simulation, with unedited components' live state in place. */
  state: SimulationState;
  /** Human-readable notes from the transplant (what resumed, what did not). */
  notes: string[];
}

/** Structured deep copy of a plant, for undoing an edit whose rebuild threw. */
function clonePlant(plant: PlantState): PlantState {
  return {
    ...structuredClone({ ...plant, components: undefined }),
    components: new Map(structuredClone([...plant.components])),
  } as PlantState;
}

/**
 * Step 1: freeze the live state into the plant's initial conditions and
 * remember what the plant looked like. Call this BEFORE opening an edit
 * dialog or touching the plant.
 */
export function beginLivePlantEdit(live: SimulationState, plant: PlantState): LiveEditSnapshot {
  const plantBackup = clonePlant(plant);
  writeSimulationStateToPlant(live, plant);
  return { resume: captureResumeSnapshot(live, plant), plantBackup };
}

/**
 * Step 3: rebuild from the edited plant and carry the live state across.
 * Throws whatever the factory throws; the caller should revert the plant
 * (revertLivePlantEdit) and keep running the state it already had.
 */
export function commitLivePlantEdit(plant: PlantState, snapshot: LiveEditSnapshot): LiveEditResult {
  const state = createSimulationFromPlant(plant);
  const notes = transplantSimulationState(state, snapshot.resume, plant);
  return { state, notes };
}

/**
 * Put the plant back the way it was at beginLivePlantEdit, in place (the
 * PlantState object itself is held by the canvas, the construction manager
 * and the dialogs, so it must not be replaced).
 */
export function revertLivePlantEdit(plant: PlantState, snapshot: LiveEditSnapshot): void {
  const backup = snapshot.plantBackup;
  plant.components.clear();
  for (const [id, component] of backup.components) plant.components.set(id, component);
  // A fresh array, not the same one refilled: render-side caches key off the
  // connection array's identity, and the point here is that everything
  // downstream sees the plant change back
  plant.connections = backup.connections;
  if (backup.scenario === undefined) delete (plant as { scenario?: unknown }).scenario;
  else (plant as { scenario?: unknown }).scenario = backup.scenario;
  if (backup.terrain === undefined) delete (plant as { terrain?: unknown }).terrain;
  else (plant as { terrain?: unknown }).terrain = backup.terrain;
  if (backup.electrical === undefined) delete (plant as { electrical?: unknown }).electrical;
  else (plant as { electrical?: unknown }).electrical = backup.electrical;
}

/**
 * The whole sequence for a synchronous edit (no dialog in the middle).
 * `edit` mutates the plant; on a throw the plant is reverted and the throw
 * propagates.
 */
export function applyLivePlantEdit(
  live: SimulationState, plant: PlantState, edit: () => void
): LiveEditResult {
  const snapshot = beginLivePlantEdit(live, plant);
  try {
    edit();
    return commitLivePlantEdit(plant, snapshot);
  } catch (error) {
    revertLivePlantEdit(plant, snapshot);
    throw error;
  }
}
