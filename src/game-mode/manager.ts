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
import { SimulationState, getTurbineCondenserState } from '../simulation';
import { GameLoop, GameEvent } from '../game';
import { LevelDef, GamePhase, GoalProgress, CareerSave, GameEventKind, FiredEvent, DialogueLine } from './types';
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
}

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
    this.hud.setLevel(level.title);
    this.hud.setHints(opts?.hints ?? level.hints);
    this.tunes.play('briefing');
    if (opts?.skipBriefing) {
      this.setPhase('construction');
      this.host.setMode('construction');
    } else {
      this.setPhase('briefing');
      this.dialogue.show(level.briefing, () => {
        this.setPhase('construction');
        this.host.setMode('construction');
      });
    }
  }

  private teardownLevel(): void {
    this.dialogue.dismiss();
    this.hud.hide();
    this.operatorPanel.hide();
    this.closeTitle();
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
        this.hud.setPhase(this.builtOnce ? 'OUTAGE' : 'CONSTRUCTION',
          this.builtOnce ? 'RESUME OPERATION' : 'BUILD IT');
        this.operatorPanel.hide();
        this.refreshConstructionHud();
        break;
      case 'operation':
        this.hud.setPhase('OPERATING', 'OUTAGE');
        this.hud.setPrimaryEnabled(true);
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
        this.host.showNotification(
          this.builtOnce ? 'Press RESUME OPERATION when the outage work is done.'
            : 'Press BUILD IT to take out the loan and build the plant first.', 'warning');
        return false;
      }
      return true;
    }

    // -> construction
    if (this.phase === 'operation') {
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
    this.setPhase('construction');
  }

  // ==========================================================================
  // Primary action button
  // ==========================================================================

  private onPrimaryAction(): void {
    if (!this.level || !this.ledger) return;

    if (this.phase === 'construction' && !this.builtOnce) {
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
    this.eventEngine?.arm(this.firedKinds);
    this.host.setMode('simulation');
    this.host.gameLoop.resume();
    // setMode synced the pause button to the (paused) state BEFORE this resume,
    // so refresh it now that the loop is actually running.
    this.host.refreshSimControls?.();
    this.tunes.stop();
    this.hud.ticker('Plant online. The meter is running - so is the interest.');
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
    if (event.type === 'component-burst') {
      const componentId = (event.data?.componentId as string) ?? '';
      const comp = this.host.plantState.components.get(componentId);
      this.burstThisRun.push({ id: componentId, label: comp?.label ?? componentId });
      this.hud.ticker(event.message, true);
      this.tunes.sfx('alarm');
    } else if (event.type === 'scram') {
      this.hud.ticker(event.message, true);
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
      this.ledger.accrue(this.operatedSeconds, dt, electricWatts);

      // random / scripted trouble
      const due = this.eventEngine?.poll(state.time, electricWatts > 1e6) ?? [];
      for (const kind of due) {
        this.fireEvent(kind, state);
      }

      this.updateGoalTracking(electricWatts);
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
      this.hud.setMoney(this.ledger.snapshot(this.operatedSeconds), mwe);
      this.hud.setGoals(this.goalProgress());
      this.checkEndConditions(state);
    }
  }

  /** Construction-phase HUD refresh (called on plant changes from main.ts). */
  refreshConstructionHud(): void {
    if (!this.active || !this.ledger || !this.level) return;
    if (this.phase !== 'construction') return;
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

  private updateGoalTracking(electricWatts: number): void {
    if (!this.level) return;
    const powerGoal = this.level.goals.find(g => g.kind === 'power');
    if (powerGoal && powerGoal.kind === 'power' && !this.powerHoldDone) {
      if (electricWatts / 1e6 >= powerGoal.mwe) {
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
      }
    });
  }

  // ==========================================================================
  // Random events
  // ==========================================================================

  private fireEvent(kind: GameEventKind, state: SimulationState): void {
    if (kind === 'major-surprise') {
      kind = MAJOR_SURPRISES[Math.floor(Math.random() * MAJOR_SURPRISES.length)];
    }
    this.firedKinds.add(kind);

    let description = '';
    switch (kind) {
      case 'pump-trip': {
        const running = [...state.components.pumps.values()].filter(p => p.running && p.effectiveSpeed > 0.05);
        if (running.length === 0) return;
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
        if (!found) return;
        description = 'Turbine trip! Governor slammed shut. Restore it from the controller (or ride the transient).';
        break;
      }
      case 'small-loca': {
        const candidates = [...(state.burstStates ?? new Map()).values()].filter(b => {
          if (b.isBurst || b.isTubeSide) return false;
          const node = state.flowNodes.get(b.nodeId);
          return !!node && node.fluid.pressure > 15e5 && !node.isBoundary;
        });
        if (candidates.length === 0) return;
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
        if (tubes.length === 0) { this.fireEvent('small-loca', state); return; }
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
        return;
    }

    this.firedEvents.push({ kind, simTime: state.time, description });
    this.hud.ticker(description, true);
    this.tunes.sfx('alarm');
    this.host.showNotification(description, 'warning');
  }

  // ==========================================================================
  // Win / lose
  // ==========================================================================

  private checkEndConditions(state: SimulationState): void {
    if (!this.level || !this.ledger || this.phase !== 'operation') return;
    if (this.releaseArmed) return; // release failure is already counting down

    // radiological release
    const release = assessRelease(state.environmentalRelease as any);
    if (release.severity >= this.level.maxRelease) {
      this.armReleaseFailure();
      return;
    }

    // bankruptcy
    if (this.ledger.cash < 0) {
      this.bankruptcyFailure();
      return;
    }

    // victory
    const goals = this.goalProgress();
    if (goals.length > 0 && goals.every(g => g.done)) {
      this.completeLevel();
    }
  }

  private completeLevel(): void {
    if (!this.level || !this.ledger) return;
    this.host.gameLoop.pause();
    this.setPhase('debrief');
    this.ledger.cash += this.level.completionBonus;
    this.tunes.play('victory');

    const best = this.save.best[this.level.id];
    if (best === undefined || this.ledger.cash > best) {
      this.save.best[this.level.id] = this.ledger.cash;
    }
    this.save.unlocked = Math.max(this.save.unlocked, this.levelIndex + 1);
    this.persistSave();

    this.dialogue.show(this.level.debrief, () => {
      this.choiceOverlay('LEVEL COMPLETE', [
        `Bonus paid: ${formatCost(this.level!.completionBonus)}`,
        `Final account: ${formatCost(this.ledger!.cash)}`,
        `Energy delivered: ${this.ledger!.energyMWh.toFixed(1)} MWh`,
        `Interest paid: ${formatCost(this.ledger!.interestPaid)}`,
      ], [
        ...(this.levelIndex + 1 < LEVELS.length
          ? [{ label: 'NEXT ASSIGNMENT', action: () => this.startLevel(this.levelIndex + 1) }] : []),
        { label: 'TITLE SCREEN', action: () => this.showTitle() },
      ]);
    });
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
    d.push(`Energy delivered: ${l.energyMWh.toFixed(1)} MWh`);
    d.push(`Peak generation: ${this.runPeakMWe.toFixed(0)} MWe`);
    if (this.runPeakFuelTemp > 0) {
      d.push(`Peak fuel temperature: ${(this.runPeakFuelTemp - 273.15).toFixed(0)} °C`);
    }
    d.push(`Revenue ${formatCost(l.revenue)} – interest ${formatCost(l.interestPaid)} – repairs ${formatCost(l.repairsPaid)}`);
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
