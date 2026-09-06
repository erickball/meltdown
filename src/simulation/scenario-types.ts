/**
 * Scenario: a list of timed events that act on the plant while it runs, so
 * an accident sequence can be shipped as a loadable preset instead of a
 * script. Plain data with no imports - shared by the plant description
 * (src/types.ts) and the simulation state (src/simulation/types.ts).
 *
 * Each event fires once, when simulation time first reaches `time`, and
 * applies its actions in order. Actions address the same simulation
 * components a user would operate by hand, so nothing here bypasses the
 * physics: a tripped pump coasts down on its own model, a shut governor
 * bottles the boiler on its own model.
 */

export type ScenarioAction =
  /** Trip or restart a pump; `speed` is the speed fraction it is set to. */
  | { kind: 'pump'; id: string; running: boolean; speed?: number }
  /** Set a valve position (0 shut .. 1 open). */
  | { kind: 'valve'; id: string; position: number }
  /** Put a controller in manual at a fixed output, or back to auto. */
  | { kind: 'controller'; id: string; mode: 'auto' | 'manual'; manualOutput?: number }
  /** Set a turbine node's governor valve directly (0 shut .. 1 open). */
  | { kind: 'turbine-governor'; id: string; value: number };

export interface ScenarioEvent {
  /** Simulation time (s) at which the event fires. */
  time: number;
  /** What happened, in the operator's words - shown as a notification. */
  message: string;
  actions: ScenarioAction[];
}

export interface ScenarioSpec {
  /** Short description of the whole sequence, for the preset catalog. */
  description?: string;
  events: ScenarioEvent[];
}
