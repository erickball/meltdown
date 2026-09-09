/**
 * GameModeManager: the career-mode state machine.
 *
 * Owns the title screen, level lifecycle (briefing -> construction ->
 * operation -> debrief/failure), the ledger, the event engine, the HUD, the
 * dialogue overlay, and the operator-actions panel. Talks to the rest of the
 * app only through the GameHost interface implemented in main.ts - the
 * sandbox works exactly as before when career mode is off.
 */

import { PlantState } from '../types';
import { SimulationState, getTurbineCondenserState, nodeLiquidLevel } from '../simulation';
import { GameLoop, GameEvent } from '../game';
import {
  LevelDef, GamePhase, GoalProgress, CareerSave, GameEventKind, FiredEvent, DialogueLine, HazardDef,
} from './types';
import { Ledger } from './economy';
import { assessRelease, formatActivity } from './consequences';
import { RandomEventEngine } from './events';
import { LEVELS, MAJOR_SURPRISES } from './levels';
import { DialogueOverlay } from './dialogue';
import { GameHud } from './hud';
import { OperatorActionsPanel } from './operator-actions';
import { ChipTunes } from './music';
import { formatCost } from '../construction/cost-estimation';

const SAVE_KEY = 'meltdown_career';

export interface GameHost {
  plantState: PlantState;
  gameLoop: GameLoop;
  /** Switch the app's construction/simulation mode (the career-aware wrapper in main.ts). */
  setMode(mode: 'construction' | 'simulation'): void;
  /** Load a plant JSON (preset format) into the plant state, refreshing panels. */
  loadPlantData(data: unknown): void;
  /** Empty the plant. */
  clearPlant(): void;
  showNotification(message: string, type: 'info' | 'warning' | 'error'): void;
  /** Re-sync the sim toolbar (e.g. pause/resume button) with the game loop's actual run state. */
  refreshSimControls?(): void;
  /**
   * Focus the construction palette on the given component types (with a
   * SHOW ALL toggle); null restores the full catalog.
   */
  setPaletteFilter?(types: string[] | null): void;
  /** Set the simulation speed and refresh the toolbar readout. */
  setSimSpeed?(speed: number): void;
  /**
   * Switch the plant view. The 2D tile grid is the only view that draws
   * terrain, so a level whose ground matters asks for 'grid'.
   */
  setViewMode?(mode: 'grid' | 'perspective'): void;
  /**
   * Whether the CONSTRUCTION mode button is usable, and why not when it is
   * not (shown as its tooltip). A live-build level has no outage.
   */
  setConstructionAvailable?(available: boolean, reason: string): void;
}

/**
 * Why a live-build level refuses to go back to construction mode. Shown both
 * as the notification when the button is pressed and as its tooltip.
 */
const NO_OUTAGE_REASON =
  'No outage on this job - the fuel keeps heating whether you are building or not. ' +
  'Place equipment and run pipe with the plant live.';

/**
 * A duration in plain words: "2h 15m", "48 min", "90 s". Used wherever the
 * player is told how long something has left (or has been wrong for).
 */
function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Event kinds that count as equipment casualties for 'events' goals. */
const CASUALTY_KINDS: ReadonlySet<GameEventKind> =
  new Set(['pump-trip', 'turbine-trip', 'small-loca', 'sgtr']);

export class GameModeManager {
  private phase: GamePhase | null = null;
  private level: LevelDef | null = null;
  private levelIndex = -1;
  private ledger: Ledger | null = null;
  private eventEngine: RandomEventEngine | null = null;
  private builtOnce = false;

  private tunes: ChipTunes;
  private dialogue: DialogueOverlay;
  private hud: GameHud;
  private operatorPanel: OperatorActionsPanel;

  private save: CareerSave;

  // operation-run bookkeeping
  private runHighWater = 0;          // sim-time high-water mark of the current run
  private operatedSeconds = 0;       // total operated sim time this level (price clock)
  private powerHoldStart: number | null = null;
  private powerHoldDone = false;
  private burstThisRun: Array<{ id: string; label: string }> = [];
  private firedEvents: FiredEvent[] = [];
  private firedKinds = new Set<GameEventKind>();
  private lastHudUpdate = 0;
  private titleEl: HTMLDivElement | null = null;

  // 'events' goal: casualties waiting for the plant to recover, and the count
  // already ridden through. A casualty is survived once power is back above
  // the goal's threshold at least 30 s (operated time) after it fired.
  private pendingCasualties: number[] = []; // firedAt (operatedSeconds)
  private survivedCasualties = 0;
  // one-shot "you can speed the sim up" hint once the plant runs steady:
  // every major parameter (thermal power, grid power, and user inputs like
  // rod position, pump setpoints, valve positions) within 10% over a rolling
  // 10 s window. Samples are (operatedSeconds, flattened parameter map).
  private speedHintShown = false;
  private steadySamples: Array<{ t: number; params: Map<string, number> }> = [];
  // pristine design captured at each run start; restored when an outage
  // begins so runs don't inherit the previous run's final state
  private designSnapshot: Map<string, unknown> | null = null;

  // Post-mortem material: the design as built (so a failed level can be
  // retried from the same design instead of the stock plant) plus run peaks
  // for the diagnostics summary.
  private capturedDesign: unknown | null = null;
  private runPeakFuelTemp = 0;
  private runPeakMWe = 0;
  // Once a release trips the limit we let the plant keep running for ~15 s
  // (the player watches it unfold) before the boss steps in. This guards
  // against re-arming and against other end conditions preempting it.
  private releaseArmed = false;
  /**
   * The player pressed KEEP GOING on a result screen. The verdict stands (the
   * unlock and the best score were recorded when it arrived) but the plant is
   * theirs to keep running, so all goal and failure bookkeeping is frozen and
   * the same screen can never come back.
   */
  private continuing: 'complete' | 'failed' | null = null;
  // Hazards (physical limits that end the level). A 'level' hazard is only a
  // failure once it has stood breached for its grace period, so the moment
  // each breach began is kept here, keyed by hazard, and cleared the instant
  // the plant recovers.
  private hazardBreachStart = new Map<string, number>();
  private hazardWarned = new Set<string>();

  constructor(private host: GameHost) {
    this.save = this.loadSave();
    this.tunes = new ChipTunes(this.save.musicMuted ?? false);
    this.dialogue = new DialogueOverlay(this.tunes);
    this.hud = new GameHud({
      onPrimary: () => this.onPrimaryAction(),
      onAbandon: () => this.confirmAbandon(),
      onToggleMusic: () => {
        this.tunes.setMuted(!this.tunes.muted);
        this.save.musicMuted = this.tunes.muted;
        this.persistSave();
        if (!this.tunes.muted) this.tunes.play('briefing');
        return this.tunes.muted;
      },
    });
    this.operatorPanel = new OperatorActionsPanel({
      applyToSim: (mutate) => this.host.gameLoop.updateState(s => { mutate(s); return s; }),
      getSimState: () => this.host.gameLoop.getState(),
      tunes: this.tunes,
      notify: (m) => this.host.showNotification(m, 'info'),
    });
  }

  get active(): boolean { return this.level !== null; }

  /**
   * True while a level that is built DURING the run is in progress. main.ts
   * asks this to decide whether the palette works in simulation mode.
   */
  get liveBuild(): boolean { return this.level?.liveBuild === true; }

  /** The level being played, or null. */
  get currentLevel(): LevelDef | null { return this.level; }

  /**
   * True when the level being played has no money model at all (LevelDef
   * `economy: 'none'`). main.ts asks so it can leave the overnight-cost
   * panel down: a build cost is meaningless where nothing is bought.
   */
  get moneyHidden(): boolean { return this.economyOff; }

  /** True when this level has no money model at all (see LevelDef.economy). */
  private get economyOff(): boolean { return this.level?.economy === 'none'; }

  // ==========================================================================
  // Title screen
  // ==========================================================================

  showTitle(): void {
    this.teardownLevel();
    const el = document.createElement('div');
    el.className = 'gm-title gm-scanlines';
    const levelButtons = LEVELS.map((lv, i) => {
      const locked = i > this.save.unlocked;
      const best = this.save.best[lv.id];
      return `<button class="gm-title-level ${locked ? 'gm-locked' : ''}" data-level="${i}" ${locked ? 'disabled' : ''}>
        ${locked ? '&#128274; ' : ''}${lv.title}
        <span class="gm-title-tagline">${locked ? '????????' : lv.tagline}</span>
        ${best !== undefined ? `<span class="gm-title-best">BEST: ${formatCost(best)}</span>` : ''}
      </button>`;
    }).join('');

    el.innerHTML = `
      <div class="gm-title-inner">
        <div class="gm-title-logo">&#9762; MELTDOWN</div>
        <div class="gm-title-sub">A NUCLEAR CAREER</div>
        <div class="gm-title-menu">
          <div class="gm-title-section">CAREER</div>
          ${levelButtons}
          <div class="gm-title-section">OR</div>
          <button class="gm-title-level gm-title-sandbox" data-sandbox="1">SANDBOX MODE
            <span class="gm-title-tagline">Infinite money. No boss. No consequences. (The classic.)</span>
          </button>
        </div>
        <div class="gm-title-footer">GIGAWATT POWER &amp; LIGHT - "SAFETY THIRD, VALUE FIRST" - EST. 1962</div>
      </div>
    `;
    document.body.appendChild(el);
    this.titleEl = el;

    el.addEventListener('mousedown', () => this.tunes.unlock(), { once: true });
    el.querySelectorAll<HTMLButtonElement>('[data-level]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.tunes.unlock();
        const idx = parseInt(btn.dataset.level!, 10);
        this.closeTitle();
        this.startLevel(idx);
      });
    });
    el.querySelector('[data-sandbox]')?.addEventListener('click', () => {
      this.closeTitle();
      this.tunes.stop();
    });
    this.tunes.play('title');
  }

  private closeTitle(): void {
    this.titleEl?.remove();
    this.titleEl = null;
  }

  // ==========================================================================
  // Level lifecycle
  // ==========================================================================

  startLevel(index: number, opts?: {
    /** Load this plant instead of the stock one (retry-with-design, answer key). */
    design?: unknown;
    /** Replace the level's HUD hints (the answer key ships operating notes). */
    hints?: string[];
    /** Skip the briefing scene (the answer key's scolding already played). */
    skipBriefing?: boolean;
  }): void {
    const level = LEVELS[index];
    if (!level) return;
    this.teardownLevel();

    this.level = level;
    this.levelIndex = index;
    this.ledger = new Ledger(level.startingCash, level.interestAPR, level.basePowerPrice);
    this.eventEngine = new RandomEventEngine(level.events);
    this.builtOnce = false;
    this.operatedSeconds = 0;
    this.powerHoldStart = null;
    this.powerHoldDone = false;
    this.burstThisRun = [];
    this.firedEvents = [];
    this.firedKinds = new Set();
    this.capturedDesign = null;
    this.runPeakFuelTemp = 0;
    this.runPeakMWe = 0;
    this.releaseArmed = false;
    this.continuing = null;
    this.pendingCasualties = [];
    this.survivedCasualties = 0;
    this.speedHintShown = false;
    this.steadySamples = [];
    this.designSnapshot = null;
    this.hazardBreachStart = new Map();
    this.hazardWarned = new Set();
    this.host.setPaletteFilter?.(level.palette ?? null);
    if (level.view) this.host.setViewMode?.(level.view);

    // The HUD goes up BEFORE the plant is loaded: loading it fits the grid
    // camera to the plant, and that fit measures the panels standing on the
    // canvas - a HUD that appears afterwards would have covered the top of a
    // plant already centred without it.
    this.hud.show();

    // Load the starting plant. A design override carries the player's own
    // failed layout (retry) or the reference solution (answer key); otherwise
    // the level's free stock plant (or an empty site).
    if (opts?.design) {
      this.host.loadPlantData(JSON.parse(JSON.stringify(opts.design)));
    } else if (level.stockPlant) {
      this.host.loadPlantData(JSON.parse(JSON.stringify(level.stockPlant)));
    } else {
      this.host.clearPlant();
    }
    // Stock components (free) are identified by the level's stock plant ids,
    // whether we loaded the stock plant or the player's design on top of it.
    const stockIds = new Set<string>();
    if (level.stockPlant) {
      for (const [id] of (level.stockPlant as { components: Array<[string, unknown]> }).components) {
        stockIds.add(id);
      }
    }
    for (const id of stockIds) this.ledger.stockIds.add(id);

    this.hud.show();
    this.hud.setEconomyVisible(!this.economyOff);
    this.hud.setLevel(level.title);
    this.hud.setHints(opts?.hints ?? level.hints);
    this.hud.clearEvents();
    this.tunes.play('briefing');
    if (opts?.skipBriefing) {
      this.setPhase('construction');
      this.host.setMode('construction');
    } else {
      this.setPhase('briefing');
      // A level with nothing to buy and nothing to shut down has no
      // construction STAGE to stop at: the briefing's last line carries the
      // button that starts the watch, and pressing it puts the player straight
      // on the running plant. Every other level still lands in construction,
      // where the design (and the loan) come first.
      const straightToWatch = !!level.liveBuild && this.economyOff;
      this.dialogue.show(level.briefing, () => {
        this.setPhase('construction');
        this.host.setMode('construction');
        // Same task, no frame in between: there is no intermediate screen.
        if (straightToWatch) this.onPrimaryAction();
      }, straightToWatch ? 'TAKE THE WATCH' : undefined);
    }
  }

  private teardownLevel(): void {
    this.dialogue.dismiss();
    this.hud.hide();
    this.operatorPanel.hide();
    this.closeTitle();
    this.host.setPaletteFilter?.(null);
    this.host.setConstructionAvailable?.(true, '');
    this.level = null;
    this.ledger = null;
    this.eventEngine = null;
    this.phase = null;
  }

  private setPhase(phase: GamePhase): void {
    this.phase = phase;
    switch (phase) {
      case 'briefing':
        this.hud.setPhase('BRIEFING', null);
        break;
      case 'construction':
        // A live-build level never comes back here: the one press starts the
        // job, and everything after that is built with the plant running.
        this.hud.setPhase(
          this.builtOnce ? 'OUTAGE' : (this.level?.liveBuild ? 'STANDING BY' : 'CONSTRUCTION'),
          this.primaryActionLabel());
        this.operatorPanel.hide();
        this.refreshConstructionHud();
        break;
      case 'operation':
        // No outage button where there is no outage. A run continued past its
        // own verdict says so, so the player is never left wondering whether
        // the result counted.
        this.hud.setPhase(
          this.continuing === 'complete' ? 'OPERATING (LEVEL COMPLETE)'
            : this.continuing === 'failed' ? 'OPERATING (LEVEL FAILED)'
            : 'OPERATING',
          this.level?.liveBuild ? null : 'OUTAGE');
        if (!this.level?.liveBuild) this.hud.setPrimaryEnabled(true);
        break;
      case 'debrief':
      case 'failed':
        this.hud.setPhase(phase === 'debrief' ? 'COMPLETE' : 'FAILED', null);
        break;
    }
  }

  // ==========================================================================
  // Mode-switch interception (called by main.ts setMode wrapper)
  // ==========================================================================

  /** Returns false to veto the switch. */
  beforeModeSwitch(mode: 'construction' | 'simulation'): boolean {
    if (!this.active || !this.ledger || !this.level) return true;

    if (mode === 'simulation') {
      if (this.phase !== 'operation') {
        // Name the button that is actually on the HUD: on a live-build level
        // it says TAKE THE WATCH, and telling the player to press BUILD IT
        // sent them looking for a button that is not there.
        this.host.showNotification(
          `Press ${this.primaryActionLabel()} to start the job.`, 'warning');
        return false;
      }
      return true;
    }

    // -> construction
    if (this.phase === 'operation') {
      // A live-build level has no outage to bill: construction mode is
      // simply not available while it runs.
      if (this.level.liveBuild) {
        this.host.showNotification(NO_OUTAGE_REASON, 'warning');
        return false;
      }
      this.beginOutage();
    }
    return true;
  }

  private beginOutage(): void {
    if (!this.ledger) return;
    // bill repairs for anything that burst during the run
    const repairs = this.ledger.chargeRepairs(this.burstThisRun, this.host.plantState.components as any);
    if (repairs.length > 0) {
      const total = repairs.reduce((s, r) => s + r.amount, 0);
      this.host.showNotification(`Outage repairs: ${formatCost(total)} (${repairs.map(r => r.label).join(', ')})`, 'warning');
      this.tunes.sfx('thud');
    }
    this.burstThisRun = [];
    this.eventEngine?.disarm();
    // An outage is weeks of plant time: restore the design's initial
    // conditions so the next run doesn't inherit the last run's final state
    // (tripped pumps, withdrawn rods, hot depressurized fluid...). The
    // player's outage edits happen on top of the restored design.
    this.restoreDesignSnapshot();
    this.setPhase('construction');
  }

  /**
   * Copy the dynamic (sim-written) fields of the design snapshot back onto
   * the live plant components. Structure (added/removed components, geometry)
   * is left alone - only the state the per-frame sim sync overwrites.
   */
  private restoreDesignSnapshot(): void {
    if (!this.designSnapshot) return;
    const DYNAMIC_FIELDS = [
      'fluid', 'primaryFluid', 'secondaryFluid', 'inletFluid', 'outletFluid',
      'running', 'speed', 'opening', 'governorValve', 'controlRodPosition',
      'fillLevel', 'power',
    ];
    for (const [id, snapRaw] of this.designSnapshot) {
      const comp = this.host.plantState.components.get(id) as Record<string, unknown> | undefined;
      const snap = snapRaw as Record<string, unknown>;
      if (!comp) continue;
      for (const field of DYNAMIC_FIELDS) {
        if (field in snap) {
          comp[field] = JSON.parse(JSON.stringify(snap[field]));
        }
      }
    }
  }

  // ==========================================================================
  // Primary action button
  // ==========================================================================

  /** What the HUD's primary button says right now - and what to call it in a message. */
  private primaryActionLabel(): string {
    if (this.builtOnce) return 'RESUME OPERATION';
    return this.level?.liveBuild ? 'TAKE THE WATCH' : 'BUILD IT';
  }

  private onPrimaryAction(): void {
    if (!this.level || !this.ledger) return;

    if (this.phase === 'construction' && !this.builtOnce) {
      // No money model: nothing to borrow, nothing to price. Taking the
      // watch just starts the clock.
      if (this.economyOff) {
        this.builtOnce = true;
        this.startOperation();
        return;
      }
      const cost = this.ledger.designCost(this.host.plantState.components as any);
      if (cost > this.level.loanCap) {
        this.host.showNotification(
          `Design costs ${formatCost(cost)} - the bank's limit is ${formatCost(this.level.loanCap)}.`, 'error');
        this.tunes.sfx('thud');
        return;
      }
      const loan = this.ledger.build(this.host.plantState.components as any);
      this.builtOnce = true;
      this.host.showNotification(`Loan drawn: ${formatCost(loan)}. Interest clock is running.`, 'info');
      this.tunes.sfx('cash');
      this.startOperation();

    } else if (this.phase === 'construction' && this.builtOnce) {
      const { total, items } = this.ledger.outageQuote(this.host.plantState.components as any);
      this.ledger.applyOutage(this.host.plantState.components as any);
      if (items.length > 0) {
        this.host.showNotification(
          `Outage changes: ${total >= 0 ? '+' : ''}${formatCost(Math.abs(total))} ${total >= 0 ? 'added to' : 'off'} the loan.`, 'info');
      }
      this.startOperation();

    } else if (this.phase === 'operation') {
      this.host.setMode('construction'); // beforeModeSwitch runs the outage bookkeeping
    }
  }

  private startOperation(): void {
    this.setPhase('operation');
    this.runHighWater = 0;
    this.burstThisRun = [];
    // capture the design as it stands at run start (post-outage edits
    // included) so the NEXT outage can restore these initial conditions
    this.designSnapshot = new Map(
      Array.from(this.host.plantState.components.entries())
        .map(([id, c]) => [id, JSON.parse(JSON.stringify(c))])
    );
    this.eventEngine?.arm(this.firedKinds);
    this.host.setMode('simulation');
    this.validateHazards();
    this.host.setConstructionAvailable?.(!this.level!.liveBuild, NO_OUTAGE_REASON);
    this.host.gameLoop.resume();
    if (this.level!.simSpeed !== undefined) this.host.setSimSpeed?.(this.level!.simSpeed);
    // setMode synced the pause button to the (paused) state BEFORE this resume,
    // so refresh it now that the loop is actually running.
    this.host.refreshSimControls?.();
    this.tunes.stop();
    this.hud.ticker(this.economyOff
      ? 'You have the watch. The clock is running.'
      : 'Plant online. The meter is running - so is the interest.');
  }

  /**
   * A level's hazards name simulation nodes. Check they exist the moment the
   * plant goes on line rather than discovering a typo at the instant the
   * level was supposed to end.
   */
  private validateHazards(): void {
    const state = this.host.gameLoop.getState();
    if (!state || !this.level?.hazards) return;
    for (const h of this.level.hazards) {
      const found = h.kind === 'temperature'
        ? state.thermalNodes.has(h.nodeId)
        : state.flowNodes.has(h.nodeId);
      if (!found) {
        throw new Error(
          `[Career] Level '${this.level.id}' watches ${h.kind} node '${h.nodeId}', ` +
          `which the plant it just built does not have. Fix the level's hazards ` +
          `or its stock plant - a limit on a node that does not exist can never fire.`);
      }
    }
  }

  // ==========================================================================
  // Per-frame hooks from main.ts
  // ==========================================================================

  /**
   * The sim state was rebuilt at t=0 (scram reset). Rebase the revenue
   * high-water mark so accrual continues; history rewinds do NOT come
   * through here, so replaying the past still can't double-book.
   */
  onSimReset(): void {
    this.runHighWater = 0;
    this.burstThisRun = [];
    this.eventEngine?.arm(this.firedKinds);
  }

  onComponentSelect(componentId: string | null): void {
    if (this.active && this.phase === 'operation') {
      this.operatorPanel.select(componentId);
    }
  }

  onGameEvent(event: GameEvent): void {
    if (!this.active) return;
    const simTime = this.host.gameLoop.getState()?.time;
    if (event.type === 'component-burst') {
      const componentId = (event.data?.componentId as string) ?? '';
      const comp = this.host.plantState.components.get(componentId);
      this.burstThisRun.push({ id: componentId, label: comp?.label ?? componentId });
      this.hud.ticker(event.message, true);
      this.hud.addEvent(event.message, simTime, true);
      this.tunes.sfx('alarm');
    } else if (event.type === 'scram') {
      this.hud.ticker(event.message, true);
      this.hud.addEvent(event.message, simTime, true);
    } else if (event.type === 'scenario') {
      // The plant's own scripted sequence (an earthquake, a tsunami) acting
      // on the level: it belongs in the same log as everything else that
      // happens to the player.
      this.hud.ticker(event.message, true);
      this.hud.addEvent(event.message, simTime, true);
      this.tunes.sfx('alarm');
    }
  }

  onSimUpdate(state: SimulationState): void {
    if (!this.active || this.phase !== 'operation' || !this.ledger || !this.level) return;

    // Accrue only past the run's high-water mark: history rewinds and
    // replays neither refund nor double-book.
    const dt = state.time - this.runHighWater;
    if (dt > 0) {
      this.runHighWater = state.time;
      this.operatedSeconds += dt;
      const electricWatts = getTurbineCondenserState().turbinePower;
      if (!this.economyOff) this.ledger.accrue(this.operatedSeconds, dt, electricWatts);

      // random / scripted trouble
      const due = this.eventEngine?.poll(state.time, electricWatts > 1e6) ?? [];
      for (const kind of due) {
        if (!this.fireEvent(kind, state)) {
          // a scripted guarantee that couldn't bite (e.g. no running pumps):
          // reschedule instead of consuming its one shot
          this.eventEngine?.defer(kind, state.time);
        }
      }

      this.updateGoalTracking(electricWatts, state);
      this.operatorPanel.tick(state);

      // Track run peaks for the post-mortem diagnostics summary
      this.runPeakMWe = Math.max(this.runPeakMWe, electricWatts / 1e6);
      const fuelId = state.neutronics.fuelNodeId;
      const fuelNode = fuelId ? state.thermalNodes.get(fuelId) : undefined;
      if (fuelNode) this.runPeakFuelTemp = Math.max(this.runPeakFuelTemp, fuelNode.temperature);
    }

    // throttle HUD DOM updates
    const now = performance.now();
    if (now - this.lastHudUpdate > 250) {
      this.lastHudUpdate = now;
      const mwe = getTurbineCondenserState().turbinePower / 1e6;
      if (!this.economyOff) this.hud.setMoney(this.ledger.snapshot(this.operatedSeconds), mwe);
      this.hud.setGoals(this.goalProgress());
      this.checkEndConditions(state);
    }
  }

  /** Construction-phase HUD refresh (called on plant changes from main.ts). */
  refreshConstructionHud(): void {
    if (!this.active || !this.ledger || !this.level) return;
    if (this.phase !== 'construction') return;
    if (this.economyOff) {
      this.hud.setGoals(this.goalProgress());
      this.hud.setPrimaryEnabled(true, 'Start the clock. From here you build with the plant running.');
      return;
    }
    const cost = this.ledger.designCost(this.host.plantState.components as any);
    this.hud.setBudget(cost, this.level.loanCap);
    this.hud.setGoals(this.goalProgress());
    if (!this.builtOnce) {
      this.hud.setPrimaryEnabled(cost <= this.level.loanCap,
        cost > this.level.loanCap ? 'Over budget - the bank says no.' : 'Take the loan and build it.');
    }
  }

  // ==========================================================================
  // Goals
  // ==========================================================================

  private updateGoalTracking(electricWatts: number, state: SimulationState): void {
    if (!this.level) return;
    const mwe = electricWatts / 1e6;
    const powerGoal = this.level.goals.find(g => g.kind === 'power');
    if (powerGoal && powerGoal.kind === 'power' && !this.powerHoldDone) {
      if (mwe >= powerGoal.mwe) {
        if (this.powerHoldStart === null) this.powerHoldStart = this.operatedSeconds;
        if (this.operatedSeconds - this.powerHoldStart >= powerGoal.holdSeconds) {
          this.powerHoldDone = true;
          this.hud.ticker(`Objective met: ${powerGoal.label ?? 'power held'}`);
          this.tunes.sfx('cash');
        }
      } else {
        this.powerHoldStart = null;
      }
    }

    // 'events' goal: a casualty is ridden through once the plant is back
    // above the recovery threshold, at least 30 s after it fired (so an
    // event the plant shrugs off entirely still requires demonstrating
    // continued generation, not a same-frame checkmark).
    const eventsGoal = this.level.goals.find(g => g.kind === 'events');
    if (eventsGoal && eventsGoal.kind === 'events' && this.pendingCasualties.length > 0) {
      const threshold = eventsGoal.recoverMwe ?? 150;
      if (mwe >= threshold) {
        const recovered = this.pendingCasualties.filter(t => this.operatedSeconds >= t + 30);
        if (recovered.length > 0) {
          this.pendingCasualties = this.pendingCasualties.filter(t => this.operatedSeconds < t + 30);
          this.survivedCasualties += recovered.length;
          this.hud.ticker(`Casualty ridden through (${this.survivedCasualties}/${eventsGoal.count}). Back on the line.`);
          this.hud.addEvent(`Recovered: back above ${threshold} MWe (${this.survivedCasualties}/${eventsGoal.count} casualties handled)`, undefined, false);
          this.tunes.sfx('cash');
        }
      }
    }

    // One-shot hint: once the plant is genuinely steady - >150 MWe with every
    // major parameter (thermal power, grid power, rod position, pump
    // setpoints, valve positions) within 10% over a rolling 10 s window at 1x
    // or slower - point at the sim-speed controls.
    if (!this.speedHintShown) {
      if (mwe > 150) {
        this.recordSteadySample(state, mwe);
        const speed = this.host.gameLoop.getTargetSimSpeed();
        if (speed <= 1.01 && this.steadyWindowSettled()) {
          this.speedHintShown = true;
          this.host.showNotification(
            'The plant is running steady. You can fast-forward with the speed controls in the top toolbar (10x / 100x) - objectives count sim time, not wall time.',
            'info');
          this.hud.ticker('Tip: plant is steady - crank the sim speed (top toolbar) to deliver MWh faster.');
        }
      } else {
        this.steadySamples = [];
      }
    }
  }

  /** Window (s) and per-parameter tolerance for the speed-hint steadiness check. */
  private static readonly STEADY_WINDOW_S = 10;
  private static readonly STEADY_TOL = 0.10;

  /**
   * Sample the parameters the speed-hint steadiness check watches (throttled
   * to 4 Hz of operated time). Powers are compared relative to their window
   * maximum; 0-1 user inputs (rods, pump speed setpoints, valve positions)
   * are compared as fractions of full travel.
   */
  private recordSteadySample(state: SimulationState, mwe: number): void {
    const t = this.operatedSeconds;
    const last = this.steadySamples[this.steadySamples.length - 1];
    if (last && t - last.t < 0.25) return;

    const params = new Map<string, number>();
    params.set('thermal', state.neutronics.power);
    params.set('mwe', mwe);
    params.set('rod', state.neutronics.controlRodPosition);
    for (const [id, pump] of state.components.pumps) {
      params.set(`pump:${id}`, pump.running ? pump.speed : 0);
    }
    for (const [id, valve] of state.components.valves) {
      params.set(`valve:${id}`, valve.position);
    }
    this.steadySamples.push({ t, params });

    // Keep exactly one sample at/before the window edge so the span check
    // knows the window has full coverage.
    const cutoff = t - GameModeManager.STEADY_WINDOW_S;
    while (this.steadySamples.length >= 2 && this.steadySamples[1].t <= cutoff) {
      this.steadySamples.shift();
    }
  }

  /** True once every watched parameter stayed within 10% over the last 10 s. */
  private steadyWindowSettled(): boolean {
    const samples = this.steadySamples;
    if (samples.length < 2) return false;
    const now = samples[samples.length - 1].t;
    if (now - samples[0].t < GameModeManager.STEADY_WINDOW_S) return false;

    const keys = new Set<string>();
    for (const s of samples) for (const k of s.params.keys()) keys.add(k);
    for (const key of keys) {
      let min = Infinity;
      let max = -Infinity;
      for (const s of samples) {
        const v = s.params.get(key);
        // A component appeared or disappeared mid-window (build/burst) -
        // that is itself a change, so not steady.
        if (v === undefined) return false;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const span = max - min;
      const scale = key === 'thermal' || key === 'mwe' ? Math.abs(max) : 1;
      if (span > GameModeManager.STEADY_TOL * scale) return false;
    }
    return true;
  }

  private goalProgress(): GoalProgress[] {
    if (!this.level || !this.ledger) return [];
    const mwe = getTurbineCondenserState().turbinePower / 1e6;
    return this.level.goals.map((def): GoalProgress => {
      switch (def.kind) {
        case 'energy': {
          const frac = Math.min(1, this.ledger!.energyMWh / def.mwh);
          return { def, fraction: frac, done: frac >= 1, readout: `${this.ledger!.energyMWh.toFixed(1)} / ${def.mwh} MWh` };
        }
        case 'power': {
          if (this.powerHoldDone) {
            return { def, fraction: 1, done: true, readout: `${def.mwe} MWe held` };
          }
          const holding = this.powerHoldStart !== null
            ? this.operatedSeconds - this.powerHoldStart : 0;
          const frac = mwe >= def.mwe
            ? Math.min(1, holding / def.holdSeconds)
            : Math.min(0.99, mwe / def.mwe) * 0.5;
          const readout = mwe >= def.mwe
            ? `holding ${holding.toFixed(0)} / ${def.holdSeconds}s`
            : `${mwe.toFixed(0)} / ${def.mwe} MWe`;
          return { def, fraction: frac, done: false, readout };
        }
        case 'cash': {
          const frac = Math.max(0, Math.min(1, this.ledger!.cash / def.dollars));
          return { def, fraction: frac, done: this.ledger!.cash >= def.dollars, readout: `${formatCost(this.ledger!.cash)} / ${formatCost(def.dollars)}` };
        }
        case 'events': {
          const frac = Math.min(1, this.survivedCasualties / def.count);
          return { def, fraction: frac, done: this.survivedCasualties >= def.count, readout: `${this.survivedCasualties} / ${def.count} handled` };
        }
        case 'survive': {
          const frac = Math.min(1, this.operatedSeconds / def.seconds);
          const left = Math.max(0, def.seconds - this.operatedSeconds);
          return {
            def, fraction: frac, done: this.operatedSeconds >= def.seconds,
            readout: frac >= 1 ? 'watch complete' : `${formatDuration(left)} to go`,
          };
        }
      }
    });
  }

  // ==========================================================================
  // Random events
  // ==========================================================================

  /** Returns false if the event couldn't be applied (nothing to break). */
  private fireEvent(kind: GameEventKind, state: SimulationState): boolean {
    const scheduledKind = kind;
    if (kind === 'major-surprise') {
      kind = MAJOR_SURPRISES[Math.floor(Math.random() * MAJOR_SURPRISES.length)];
    }

    let description = '';
    switch (kind) {
      case 'pump-trip': {
        const running = [...state.components.pumps.values()].filter(p => p.running && p.effectiveSpeed > 0.05);
        if (running.length === 0) return false;
        const victim = running[Math.floor(Math.random() * running.length)];
        this.host.gameLoop.updateState(s => {
          const p = s.components.pumps.get(victim.id);
          if (p) { p.running = false; p.speed = 0; }
          return s;
        });
        description = `${victim.id} tripped - breaker opened. Someone has to walk out and reset it.`;
        break;
      }
      case 'turbine-trip': {
        let found = false;
        this.host.gameLoop.updateState(s => {
          for (const [, ctl] of s.components.controllers ?? new Map()) {
            if (ctl.actuator.kind === 'governor-valve') {
              ctl.mode = 'manual';
              ctl.manualOutput = ctl.actuator.min ?? 0.02;
              found = true;
            }
          }
          if (!found) {
            for (const [, node] of s.flowNodes) {
              if (node.governorValve !== undefined && node.governorValve > 0.05) {
                node.governorValve = 0.02;
                found = true;
              }
            }
          }
          return s;
        });
        if (!found) return false;
        description = 'Turbine trip! Governor slammed shut. Restore it from the controller (or ride the transient).';
        break;
      }
      case 'small-loca': {
        const candidates = [...(state.burstStates ?? new Map()).values()].filter(b => {
          if (b.isBurst || b.isTubeSide) return false;
          const node = state.flowNodes.get(b.nodeId);
          return !!node && node.fluid.pressure > 15e5 && !node.isBoundary;
        });
        if (candidates.length === 0) return false;
        const victim = candidates[Math.floor(Math.random() * candidates.length)];
        this.host.gameLoop.updateState(s => {
          const b = s.burstStates?.get(victim.nodeId);
          const node = s.flowNodes.get(victim.nodeId);
          if (b && node) {
            // weld flaw: the component's actual strength turns out to be a
            // hair under today's operating pressure; the burst operator does
            // the rest with real break physics
            const container = node.containerId ? s.flowNodes.get(node.containerId) : undefined;
            const gauge = node.fluid.pressure - (container?.fluid.pressure ?? 101325);
            if (gauge > 1e5) b.burstPressure = gauge * 0.97;
          }
          return s;
        });
        description = `Weld inspection missed one: ${victim.componentLabel} is about to let go.`;
        break;
      }
      case 'sgtr': {
        const tubes = [...(state.burstStates ?? new Map()).values()].filter(b => b.isTubeSide && !b.isBurst);
        if (tubes.length === 0) { return this.fireEvent('small-loca', state); }
        const victim = tubes[Math.floor(Math.random() * tubes.length)];
        this.host.gameLoop.updateState(s => {
          const b = s.burstStates?.get(victim.nodeId);
          const node = s.flowNodes.get(victim.nodeId);
          const shell = b?.shellNodeId ? s.flowNodes.get(b.shellNodeId) : undefined;
          if (b && node && shell) {
            const dP = node.fluid.pressure - shell.fluid.pressure;
            if (dP > 1e5) b.burstPressure = dP * 0.97;
          }
          return s;
        });
        description = `Steam generator tube rupture in ${victim.componentLabel}! Primary coolant is heading for the steam side.`;
        break;
      }
      case 'price-spike':
        this.ledger?.applyPriceEvent(this.operatedSeconds, 3, 900);
        description = 'Heat wave! Electricity prices tripled. Every megawatt is money.';
        break;
      case 'price-crash':
        this.ledger?.applyPriceEvent(this.operatedSeconds, 0.2, 900);
        description = 'Market crash: power is nearly worthless for a while. A fine time for maintenance.';
        break;
      default:
        return false;
    }

    // only a successfully-applied event burns its scripted slot
    this.firedKinds.add(scheduledKind);
    this.firedKinds.add(kind);
    if (CASUALTY_KINDS.has(kind)) {
      this.pendingCasualties.push(this.operatedSeconds);
    }
    this.firedEvents.push({ kind, simTime: state.time, description });
    this.hud.ticker(description, true);
    this.hud.addEvent(description, state.time, true);
    this.tunes.sfx('alarm');
    this.host.showNotification(description, 'warning');
    return true;
  }

  // ==========================================================================
  // Win / lose
  // ==========================================================================

  private checkEndConditions(state: SimulationState): void {
    if (!this.level || !this.ledger || this.phase !== 'operation') return;
    if (this.continuing) return;   // the verdict is in; the plant is just running now
    if (this.releaseArmed) return; // release failure is already counting down

    // radiological release
    const release = assessRelease(state.environmentalRelease as any);
    if (release.severity >= this.level.maxRelease) {
      this.armReleaseFailure();
      return;
    }

    // physical limits (fuel damage, uncovered fuel, ...)
    const breach = this.checkHazards(state);
    if (breach) {
      this.safetyFailure(breach.hazard, breach.detail);
      return;
    }

    // bankruptcy
    if (!this.economyOff && this.ledger.cash < 0) {
      this.bankruptcyFailure();
      return;
    }

    // victory
    const goals = this.goalProgress();
    if (goals.length > 0 && goals.every(g => g.done)) {
      this.completeLevel();
    }
  }

  /**
   * The first hazard the plant is outside, or null. A temperature limit bites
   * the moment it is crossed; a level limit only after its grace period of
   * CONTINUOUS breach, so make-up that catches up in time is not punished.
   *
   * A watched node that has disappeared (the player deleted the component) is
   * a breach, not an error: the thing that was supposed to be protected is
   * gone.
   */
  private checkHazards(state: SimulationState): { hazard: HazardDef; detail: string } | null {
    if (!this.level?.hazards) return null;
    for (const h of this.level.hazards) {
      const key = `${h.kind}:${h.nodeId}`;
      if (h.kind === 'temperature') {
        const node = state.thermalNodes.get(h.nodeId);
        if (!node) return { hazard: h, detail: `${h.label} is no longer part of the plant.` };
        const c = node.temperature - 273.15;
        if (c >= h.limitC) {
          return { hazard: h, detail: `${h.label} reached ${c.toFixed(0)} °C - the limit is ${h.limitC} °C.` };
        }
        if (c >= h.limitC - 100 && !this.hazardWarned.has(key)) {
          this.hazardWarned.add(key);
          this.hud.ticker(`${h.label} is at ${c.toFixed(0)} °C and climbing (limit ${h.limitC} °C).`, true);
        }
      } else {
        const node = state.flowNodes.get(h.nodeId);
        if (!node) return { hazard: h, detail: `${h.label} is no longer part of the plant.` };
        const level = nodeLiquidLevel(node);
        if (level >= h.minMetres) {
          this.hazardBreachStart.delete(key);
          this.hazardWarned.delete(key);
          continue;
        }
        const since = this.hazardBreachStart.get(key);
        if (since === undefined) {
          this.hazardBreachStart.set(key, this.operatedSeconds);
          if (!this.hazardWarned.has(key)) {
            this.hazardWarned.add(key);
            this.hud.ticker(
              `${h.label}: ${level.toFixed(2)} m, below the ${h.minMetres.toFixed(2)} m it needs. ` +
              `${formatDuration(h.graceSeconds)} to put it right.`, true);
          }
          continue;
        }
        const held = this.operatedSeconds - since;
        if (held >= h.graceSeconds) {
          return {
            hazard: h,
            detail: `${h.label} stood below ${h.minMetres.toFixed(2)} m for ${formatDuration(held)}.`,
          };
        }
      }
    }
    return null;
  }

  /**
   * A physical limit was breached: the plant is stopped and the boss arrives.
   * Unlike a release, there is nothing left to watch unfold - the damage is
   * the end of the level.
   */
  private safetyFailure(hazard: HazardDef, detail: string): void {
    if (!this.level) return;
    this.host.gameLoop.pause();
    this.setPhase('failed');
    this.eventEngine?.disarm();
    this.tunes.play('disaster');
    this.failureChoices(
      'SAFETY LIMIT EXCEEDED',
      [detail, hazard.consequence],
      [
        { who: 'grubb', mood: 'panic', text: 'Stop. STOP. Whatever you are doing, it is not working, and the readouts are the colour I dread.' },
        { who: 'grubb', mood: 'angry', text: detail },
        { who: 'grubb', mood: 'neutral', text: hazard.consequence },
        { who: 'grubb', mood: 'angry', text: 'Go back and do it again, and this time do it before the number gets there, not after.' },
      ]
    );
  }

  private completeLevel(): void {
    if (!this.level || !this.ledger) return;
    this.host.gameLoop.pause();
    this.setPhase('debrief');
    if (!this.economyOff) {
      this.ledger.cash += this.level.completionBonus;
      const best = this.save.best[this.level.id];
      if (best === undefined || this.ledger.cash > best) {
        this.save.best[this.level.id] = this.ledger.cash;
      }
    }
    this.tunes.play('victory');

    this.save.unlocked = Math.max(this.save.unlocked, this.levelIndex + 1);
    this.persistSave();

    const summary = this.economyOff
      ? [`Time on watch: ${formatDuration(this.operatedSeconds)} of simulated plant time.`]
      : [
        `Bonus paid: ${formatCost(this.level!.completionBonus)}`,
        `Final account: ${formatCost(this.ledger!.cash)}`,
        `Energy delivered: ${this.ledger!.energyMWh.toFixed(1)} MWh`,
        `Interest paid: ${formatCost(this.ledger!.interestPaid)}`,
      ];
    this.dialogue.show(this.level.debrief, () => {
      this.choiceOverlay('LEVEL COMPLETE', summary, [
        ...(this.levelIndex + 1 < LEVELS.length
          ? [{ label: 'NEXT ASSIGNMENT', action: () => this.startLevel(this.levelIndex + 1) }] : []),
        this.keepGoingChoice('complete'),
        { label: 'TITLE SCREEN', action: () => this.showTitle() },
      ]);
    });
  }

  /**
   * KEEP GOING: hand the plant back with the result standing.
   *
   * The career bookkeeping already happened when the result arrived - the
   * unlock, the best score, the save - and none of it changes here. What
   * changes is that the goals and the failure checks are frozen, so the same
   * screen cannot arrive twice, and the simulation carries on from exactly
   * where it stopped: same simulated time, same state, same speed, and on a
   * live-build level still buildable.
   */
  private keepGoing(verdict: 'complete' | 'failed'): void {
    if (!this.level) return;
    this.continuing = verdict;
    this.eventEngine?.disarm();   // no new scripted trouble after the verdict
    this.setPhase('operation');
    this.host.setConstructionAvailable?.(!this.level.liveBuild, NO_OUTAGE_REASON);
    this.host.gameLoop.resume();
    this.host.showNotification(
      verdict === 'complete'
        ? 'Level complete - the result is recorded. The plant is yours to keep running.'
        : 'Level failed - the result is recorded. The plant is yours to keep running.',
      'info');
  }

  /** The KEEP GOING choice, offered on every result screen, won or lost. */
  private keepGoingChoice(verdict: 'complete' | 'failed'): { label: string; action: () => void; tooltip: string } {
    return {
      label: 'KEEP GOING',
      tooltip: 'Close this and carry on running the plant as it stands. The result above is ' +
        'already recorded and does not change, and this screen will not come back.',
      action: () => this.keepGoing(verdict),
    };
  }

  /** Snapshot the plant as built so a failed level can be retried from it. */
  private captureDesign(): unknown {
    return {
      components: Array.from(this.host.plantState.components.entries())
        .map(([id, c]) => [id, JSON.parse(JSON.stringify(c))]),
      connections: JSON.parse(JSON.stringify(this.host.plantState.connections)),
    };
  }

  /** Post-mortem summary lines for the failure screen. */
  private runDiagnostics(headline: string[]): string[] {
    const l = this.ledger!;
    const d = [...headline];
    d.push(`Time on line: ${(this.operatedSeconds / 60).toFixed(1)} sim-min`);
    if (!this.economyOff) {
      d.push(`Energy delivered: ${l.energyMWh.toFixed(1)} MWh`);
      d.push(`Peak generation: ${this.runPeakMWe.toFixed(0)} MWe`);
    }
    if (this.runPeakFuelTemp > 0) {
      d.push(`Peak fuel temperature: ${(this.runPeakFuelTemp - 273.15).toFixed(0)} °C`);
    }
    if (!this.economyOff) {
      d.push(`Revenue ${formatCost(l.revenue)} – interest ${formatCost(l.interestPaid)} – repairs ${formatCost(l.repairsPaid)}`);
    }
    if (this.burstThisRun.length) {
      d.push(`Ruptured: ${this.burstThisRun.map(b => b.label).join(', ')}`);
    }
    if (this.firedEvents.length) {
      d.push(`Initiating events: ${this.firedEvents.map(e => e.kind).join(', ')}`);
    }
    return d;
  }

  /** Common tail for both failure modes: dialogue, then the choice screen. */
  private failureChoices(title: string, headline: string[], lines: DialogueLine[]): void {
    this.capturedDesign = this.captureDesign();
    const diagnostics = this.runDiagnostics(headline);
    this.dialogue.show(lines, () => {
      this.choiceOverlay(title, [], [
        ...(this.builtOnce
          ? [{ label: 'RETRY WITH THIS DESIGN', action: () => this.startLevel(this.levelIndex, { design: this.capturedDesign ?? undefined }) }]
          : []),
        { label: 'START OVER', action: () => this.startLevel(this.levelIndex) },
        ...(this.level?.reference
          ? [{
              label: 'SHOW ME THE ANSWER',
              tooltip: 'Restart with a known-good design and the boss\'s operating notes. He will have opinions.',
              action: () => this.startReference(),
            }]
          : []),
        this.keepGoingChoice('failed'),
        { label: 'TITLE SCREEN', action: () => this.showTitle() },
      ], diagnostics);
    });
  }

  /**
   * The player asked for the answer key: Grubb hands over the reference
   * design (meanly), then the level restarts with it loaded and the
   * reference's operating notes in place of the usual hints. The briefing
   * is skipped - the scolding was the briefing.
   */
  private startReference(): void {
    const ref = this.level?.reference;
    if (!ref) return;
    const index = this.levelIndex;
    this.dialogue.show(ref.scolding, () => {
      this.startLevel(index, { design: ref.design, hints: ref.notes, skipBriefing: true });
    });
  }

  /**
   * A release has crossed the level's limit. Let the plant KEEP RUNNING for
   * ~15 s (real time) so the player watches it unfold, showing an alarm
   * banner, then the boss steps in with the final tally.
   */
  private armReleaseFailure(): void {
    if (this.releaseArmed) return;
    this.releaseArmed = true;
    this.eventEngine?.disarm();
    this.tunes.sfx('alarm');
    this.hud.ticker('☢ RADIOLOGICAL RELEASE IN PROGRESS - containment breached', true);

    const banner = this.showPersistentBanner(
      '☢ RADIOLOGICAL RELEASE',
      'Containment is breached and venting. The plant is still running...'
    );
    window.setTimeout(() => {
      banner.remove();
      this.radiologicalFailure();
    }, 15000);
  }

  private radiologicalFailure(): void {
    if (!this.level) return;
    this.host.gameLoop.pause();
    this.setPhase('failed');
    this.tunes.play('disaster');

    // Re-assess at trip time: the release kept growing during the 15 s.
    const release = assessRelease(this.host.gameLoop.getState().environmentalRelease as any);
    this.failureChoices(
      'RADIOLOGICAL RELEASE',
      [
        release.verdict,
        `Released to the environment: ${release.csiMoles.toFixed(1)} mol aerosol + ` +
          `${release.xenonMoles.toFixed(0)} mol noble gas (~${formatActivity(release.becquerels)}).`,
      ],
      [
        { who: 'grubb', mood: 'panic', text: 'The phones. The PHONES. Every line is a reporter, a lawyer, or my mother. WHAT DID YOU DO?' },
        { who: 'inspector', mood: 'alarmed', text: `Preliminary source term: ${formatActivity(release.becquerels)} to the environment.` },
        { who: 'grubb', mood: 'furious', text: 'Do you know what the interest does while we\'re shut down "out for repairs"? It COMPOUNDS. Millions a day, compounding, while you hose down the parking lot!' },
        { who: 'grubb', mood: 'angry', text: 'The board is calling it a "career development opportunity." For your replacement. Unless you want to try that level again and get it RIGHT.' },
      ]
    );
  }

  private bankruptcyFailure(): void {
    this.host.gameLoop.pause();
    this.setPhase('failed');
    this.eventEngine?.disarm();
    this.tunes.sfx('alarm');

    this.delayThenFailure(
      '$ INSOLVENT',
      'The account has hit zero. Interest is still running.',
      8,
      () => {
        this.tunes.play('disaster');
        this.failureChoices(
          'BANKRUPTCY',
          ['The account hit zero with the interest clock still running.'],
          [
            { who: 'grubb', mood: 'furious', text: 'ZERO. The account says ZERO. It said ZERO to the payroll department, and now it\'s saying ZERO to me.' },
            { who: 'grubb', mood: 'angry', text: 'You know who visits when a nuclear plant misses an interest payment? Everyone. The bank, the NRC, and a man from the state who staples things.' },
            { who: 'grubb', mood: 'neutral', text: 'I talked them into one more chance. I had to give them my boat. Get back in there, and this time, GENERATE.' },
          ]
        );
      }
    );
  }

  /**
   * Freeze on a terse alarm banner (plant still visible behind it) for a few
   * seconds so the player can register what broke, then proceed. A CONTINUE
   * button skips the wait.
   */
  private delayThenFailure(title: string, sub: string, seconds: number, proceed: () => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'gm-accident-banner';
    let remaining = seconds;
    overlay.innerHTML = `
      <div class="gm-accident-title">${title}</div>
      <div class="gm-accident-sub">${sub}</div>
      <button class="gm-hud-btn gm-accident-continue">CONTINUE <span class="gm-accident-count">(${remaining})</span></button>
    `;
    document.body.appendChild(overlay);
    const countEl = overlay.querySelector('.gm-accident-count') as HTMLElement | null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      overlay.remove();
      proceed();
    };
    const timer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) { finish(); return; }
      if (countEl) countEl.textContent = `(${remaining})`;
    }, 1000);
    overlay.querySelector('.gm-accident-continue')?.addEventListener('click', finish);
  }

  /**
   * A persistent alarm banner shown while the plant KEEPS running (used for a
   * release, which the player watches unfold before the boss arrives).
   * Returns the element so the caller can remove it. No countdown, no pause.
   */
  private showPersistentBanner(title: string, sub: string): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.className = 'gm-accident-banner';
    overlay.innerHTML = `
      <div class="gm-accident-title">${title}</div>
      <div class="gm-accident-sub">${sub}</div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  private confirmAbandon(): void {
    this.choiceOverlay('WALK AWAY?', [
      'Abandon this level and return to the title screen?',
    ], [
      { label: 'KEEP WORKING', action: () => { /* stay */ } },
      { label: 'WALK AWAY', action: () => { this.host.gameLoop.pause(); this.showTitle(); } },
    ]);
  }

  /** Small retro modal with stats and big chunky buttons. */
  private choiceOverlay(
    title: string,
    lines: string[],
    choices: Array<{ label: string; action: () => void; tooltip?: string }>,
    diagnostics?: string[]
  ): void {
    const overlay = document.createElement('div');
    overlay.className = 'gm-dialogue-overlay gm-scanlines';
    const diagBlock = diagnostics && diagnostics.length
      ? `<div class="gm-choice-diag" data-open="1">
           <button class="gm-choice-diag-toggle">&#9660; RUN DIAGNOSTICS</button>
           <div class="gm-choice-diag-body">
             ${diagnostics.map(d => `<div class="gm-choice-diag-line">${d}</div>`).join('')}
           </div>
         </div>`
      : '';
    overlay.innerHTML = `
      <div class="gm-choice-box">
        <div class="gm-choice-title">${title}</div>
        ${lines.map(l => `<div class="gm-choice-line">${l}</div>`).join('')}
        ${diagBlock}
        <div class="gm-choice-buttons">
          ${choices.map((c, i) => `<button class="gm-hud-btn gm-choice-btn" data-choice="${i}"${c.tooltip ? ` title="${c.tooltip}"` : ''}>${c.label}</button>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Diagnostics start expanded; the toggle collapses/expands them.
    const diag = overlay.querySelector('.gm-choice-diag') as HTMLElement | null;
    overlay.querySelector('.gm-choice-diag-toggle')?.addEventListener('click', () => {
      if (!diag) return;
      const open = diag.getAttribute('data-open') === '1';
      diag.setAttribute('data-open', open ? '0' : '1');
      const toggle = diag.querySelector('.gm-choice-diag-toggle') as HTMLElement;
      toggle.innerHTML = (open ? '&#9654;' : '&#9660;') + ' RUN DIAGNOSTICS';
    });

    overlay.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.tunes.sfx('click');
        overlay.remove();
        choices[parseInt(btn.dataset.choice!, 10)].action();
      });
    });
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================

  private loadSave(): CareerSave {
    try {
      const json = localStorage.getItem(SAVE_KEY);
      if (json) return { unlocked: 0, best: {}, ...JSON.parse(json) };
    } catch { /* fresh save */ }
    return { unlocked: 0, best: {} };
  }

  private persistSave(): void {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.save));
    } catch { /* storage full or blocked; the career is memento mori */ }
  }
}
