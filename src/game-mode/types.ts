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
  | { kind: 'cash'; dollars: number; label?: string }
  /**
   * Ride through `count` equipment casualties (pump/turbine trips, LOCAs,
   * SGTRs): each one counts once the plant is back above `recoverMwe`
   * (default 150) at least 30 s after it fired. Guarantees the level can't
   * be coasted before its scripted trouble arrives.
   */
  | { kind: 'events'; count: number; recoverMwe?: number; label?: string }
  /**
   * Still standing when the clock runs out: the goal completes once the
   * level has been OPERATED (not merely loaded) for `seconds` of simulation
   * time. The win condition for levels whose job is to survive rather than
   * to produce - there is nothing to sell in a spent fuel pool.
   */
  | { kind: 'survive'; seconds: number; label?: string };

/**
 * A physical limit the plant must stay inside. Unlike a goal, a hazard is a
 * way to LOSE: the manager checks each one against the live simulation and
 * ends the level the moment it is breached. They are addressed by simulation
 * node id, so a level defines them against the ids in its own stock plant.
 */
export type HazardDef =
  /**
   * A thermal node (fuel, cladding, a wall) that must stay below `limitC`.
   */
  | { kind: 'temperature'; nodeId: string; limitC: number; label: string; consequence: string }
  /**
   * A flow node whose liquid level must stay at or above `minMetres` (metres
   * above the node's own base). A dip is allowed for `graceSeconds` of
   * CONTINUOUS breach - the clock resets the moment the level recovers - so
   * a transient while make-up catches up is survivable and walking away is
   * not.
   */
  | { kind: 'level'; nodeId: string; minMetres: number; graceSeconds: number; label: string; consequence: string };

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
  /** Physical limits that end the level when breached (see HazardDef). */
  hazards?: HazardDef[];

  /**
   * Build while the plant RUNS (an RTS-style emergency) instead of stopping
   * it for an outage. With this set the level never returns to construction
   * mode: main.ts's liveBuildAllowed() lets the palette work in simulation
   * mode, the HUD offers no OUTAGE button, and a mode switch back to
   * construction is refused rather than billed as an outage.
   */
  liveBuild?: boolean;

  /**
   * 'loan' (the default) is the career economy: a construction loan, its
   * interest, revenue from the grid, and bankruptcy as a failure mode.
   * 'none' switches all of that off - no cash, no loan, no revenue, no
   * interest, no bankruptcy, and the HUD's money readouts are hidden. The
   * limit on what can be built is then the warehouse stock in the stock
   * plant, not money.
   */
  economy?: 'loan' | 'none';

  /**
   * Simulation speed to set when the level goes on line (e.g. 60 for a level
   * whose six sim-hours are meant to take six real minutes). Omit to leave
   * the player's current speed alone.
   */
  simSpeed?: number;

  /**
   * View the level opens in. The 2D tile grid is the only view that draws
   * terrain, so any level whose ground matters wants 'grid'. Omit to leave
   * the player's own choice alone.
   */
  view?: 'grid' | 'perspective';

  /**
   * Construction-palette focus for early levels: component types (the
   * data-component ids of the palette buttons) the player is expected to
   * need. When set, the palette shows only these plus a SHOW ALL toggle.
   * Omit for the full catalog.
   */
  palette?: string[];

  events: EventScheduleDef;

  briefing: DialogueLine[];
  debrief: DialogueLine[];
  /** Optional construction-phase hints shown in the HUD. */
  hints?: string[];

  /**
   * The answer key, offered after a failure: a complete plant design that
   * beats the level (validated headlessly in scripts/test-game-levels.ts)
   * plus the operating notes to run it. For levels whose stock plant already
   * IS the answer, design repeats the stock plant and the notes carry the
   * value. Grubb hands it over in the scolding scene; he is not gracious.
   */
  reference?: {
    /** Complete plant JSON (preset format) that satisfies the goals. */
    design: unknown;
    /** Operating instructions, shown as the HUD hints for the reference run. */
    notes: string[];
    /** Grubb handing over the answer, meanly. Plays before the restart. */
    scolding: DialogueLine[];
  };
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
