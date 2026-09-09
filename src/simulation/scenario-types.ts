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
  | { kind: 'turbine-governor'; id: string; value: number }
  /** Move a water body's surface (m above datum) to a level, over `over` seconds (a tsunami). */
  | { kind: 'water-level'; id: string; surface: number; over?: number }
  /**
   * Tear a hole in a component, whatever its pressure is doing.
   *
   * This is the SAME break a pressure burst opens - the same break
   * connection, discharging to the containing building or, for an
   * uncontained component, to the open air and onto the ground - so a
   * scripted failure looks and behaves like a real one. What the script
   * supplies is only what the pressure check would otherwise work out for
   * itself: how big the hole is and where it sits. An earthquake cracking
   * a fuel-pool liner is not an overpressure event, and nothing should have
   * to pretend it is.
   */
  | {
      kind: 'burst'; id: string;
      /** Break area (m2). Give exactly one of `area` or `fraction`. */
      area?: number;
      /** Break area as a fraction of the component's own flow area. */
      fraction?: number;
      /** Height of the break above the component's base (m). Default 0 - the floor. */
      elevation?: number;
      /**
       * Vertical extent of the opening (m). A tall tear draws a blend of
       * what stands across it, so the leak crossfades from water to vapour
       * and dies away as the level sweeps past, with no threshold anywhere.
       */
      openingHeight?: number;
      /** Banner text, in place of the generic breach wording. */
      breachMessage?: string;
    };

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
