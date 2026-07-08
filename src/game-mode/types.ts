/**
 * Career ("Game Mode") shared types.
 *
 * Career mode is a layer over the sandbox: it drives the existing
 * construction/simulation modes and prices changes with the existing
 * overnight-cost estimator. Nothing in here touches the physics.
 */

/** Where the player is in the level loop. */
export type GamePhase =
  | 'briefing'      // dialogue scene before construction
  | 'construction'  // designing, nothing purchased yet (or in an outage)
  | 'operation'     // built and simulating; revenue and events live
  | 'debrief'       // level complete dialogue
  | 'failed';       // bankruptcy / radiological release sequence

/** A single objective shown in the HUD with live progress. */
export type GoalDef =
  | { kind: 'energy'; mwh: number; label?: string }
  | { kind: 'power'; mwe: number; holdSeconds: number; label?: string }
  | { kind: 'cash'; dollars: number; label?: string };

/** Random / scripted event kinds the engine can fire during operation. */
export type GameEventKind =
  | 'pump-trip'       // a running pump loses power
  | 'small-loca'      // a pressurized component springs a leak
  | 'sgtr'            // steam generator (HX) tube rupture
  | 'turbine-trip'    // governor slams shut / its controller drops to manual
  | 'price-spike'     // electricity price x3 for a while
  | 'price-crash'     // electricity price x0.2 for a while
  | 'major-surprise'; // resolved at fire time to a random major casualty

export interface EventScheduleDef {
  /** No events before this much sim time (seconds). */
  warmupSeconds: number;
  /** Mean seconds between events after warmup (poisson). Infinity = scripted only. */
  meanIntervalSeconds: number;
  /** Weighted pool of random events. Empty = none. */
  pool: Array<{ kind: GameEventKind; weight: number }>;
  /**
   * Scripted one-shot events: fire at a uniformly random time inside the
   * window. Used for "the inspection" style guaranteed transients.
   */
  scripted?: Array<{ kind: GameEventKind; earliestSeconds: number; latestSeconds: number }>;
}

/** One line of a dialogue scene. */
export interface DialogueLine {
  /** Speaker id, must match a portrait in sprites.ts ('grubb' | 'inspector' | 'player'). */
  who: string;
  /** Expression key for the portrait (e.g. 'neutral' | 'happy' | 'angry' | 'panic'). */
  mood?: string;
  text: string;
}

export interface LevelDef {
  id: string;
  /** Display name, shown in the HUD and level select. */
  title: string;
  /** One-line pitch for the level select screen. */
  tagline: string;

  /** Stock plant JSON (preset-format). Components in it are free. Null = empty site. */
  stockPlant: unknown | null;

  /** Max loan for player-added equipment ($). */
  loanCap: number;
  /** Operating cash on hand at start ($). Interest and repairs eat this. */
  startingCash: number;
  /** Payout on completing all goals ($, flavor/score). */
  completionBonus: number;
  /** Base electricity price ($/MWh) before the day/night curve and events. */
  basePowerPrice: number;
  /** Annual interest rate on the construction loan (fraction, e.g. 0.07). */
  interestAPR: number;

  goals: GoalDef[];
  /** Level fails if the radiological release severity index reaches this. */
  maxRelease: number;

  events: EventScheduleDef;

  briefing: DialogueLine[];
  debrief: DialogueLine[];
  /** Optional construction-phase hints shown in the HUD. */
  hints?: string[];
}

/** Live progress for one goal (mirrors GoalDef order). */
export interface GoalProgress {
  def: GoalDef;
  /** 0-1 for the HUD progress bar. */
  fraction: number;
  done: boolean;
  /** Short live readout, e.g. "212 / 300 MWh". */
  readout: string;
}

/** Career save persisted to localStorage. */
export interface CareerSave {
  /** Highest unlocked level index. */
  unlocked: number;
  /** Best cash result per level id. */
  best: Record<string, number>;
  musicMuted?: boolean;
}

/** A fired event, kept for the HUD ticker and debrief. */
export interface FiredEvent {
  kind: GameEventKind;
  simTime: number;
  description: string;
}
