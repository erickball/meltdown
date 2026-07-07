/**
 * Career HUD: the strip along the top with the numbers that matter -
 * cash (green when growing, red when the interest is winning), loan,
 * live electricity price, generation, objectives with progress bars,
 * the current phase's one big action button, and an event ticker.
 */

import { GoalProgress } from './types';
import { LedgerSnapshot } from './economy';
import { formatCost } from '../construction/cost-estimation';

export interface HudActions {
  onPrimary(): void;      // BUILD IT / OUTAGE etc.
  onAbandon(): void;      // give up / back to title
  onToggleMusic(): boolean; // returns new muted state
}

export class GameHud {
  private root: HTMLDivElement | null = null;
  private tickerTimeout: number | null = null;

  constructor(private actions: HudActions) {}

  show(): void {
    if (this.root) return;
    const el = document.createElement('div');
    el.className = 'gm-hud';
    el.innerHTML = `
      <div class="gm-hud-row1">
        <span class="gm-hud-level"></span>
        <span class="gm-hud-phase"></span>
        <span class="gm-hud-cash" title="Operating cash. Revenue in, interest and repairs out. Zero means bankruptcy."></span>
        <span class="gm-hud-loan" title="Outstanding construction loan. You pay interest on this every fiscal day (= 1 sim minute)."></span>
        <span class="gm-hud-price" title="Live electricity price. Day/night cycle plus market moods. Sell high."></span>
        <span class="gm-hud-mw" title="Current generator output."></span>
        <button class="gm-hud-btn gm-hud-primary"></button>
        <button class="gm-hud-btn gm-hud-music" title="Toggle chiptunes">&#9835;</button>
        <button class="gm-hud-btn gm-hud-abandon" title="Abandon this level and return to the title screen">QUIT</button>
      </div>
      <div class="gm-hud-goals"></div>
      <div class="gm-hud-ticker"></div>
      <div class="gm-hud-hints"></div>
    `;
    document.body.appendChild(el);
    this.root = el;

    el.querySelector('.gm-hud-primary')?.addEventListener('click', () => this.actions.onPrimary());
    el.querySelector('.gm-hud-abandon')?.addEventListener('click', () => this.actions.onAbandon());
    el.querySelector('.gm-hud-music')?.addEventListener('click', (e) => {
      const muted = this.actions.onToggleMusic();
      (e.target as HTMLButtonElement).style.opacity = muted ? '0.4' : '1';
    });
  }

  hide(): void {
    if (this.tickerTimeout !== null) clearTimeout(this.tickerTimeout);
    this.root?.remove();
    this.root = null;
  }

  setLevel(title: string): void {
    this.set('.gm-hud-level', title);
  }

  setPhase(phase: string, primaryLabel: string | null): void {
    this.set('.gm-hud-phase', phase);
    const btn = this.root?.querySelector('.gm-hud-primary') as HTMLButtonElement | null;
    if (btn) {
      btn.style.display = primaryLabel ? 'inline-block' : 'none';
      if (primaryLabel) btn.textContent = primaryLabel;
    }
  }

  setPrimaryEnabled(enabled: boolean, tooltip?: string): void {
    const btn = this.root?.querySelector('.gm-hud-primary') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = !enabled;
      btn.title = tooltip ?? '';
    }
  }

  setMoney(ledger: LedgerSnapshot, mwe: number): void {
    const cashEl = this.root?.querySelector('.gm-hud-cash') as HTMLSpanElement | null;
    if (cashEl) {
      cashEl.textContent = `CASH ${formatCost(Math.abs(ledger.cash))}${ledger.cash < 0 ? ' (!)' : ''}`;
      cashEl.style.color = ledger.cash >= 0 ? '#5f5' : '#f55';
    }
    this.set('.gm-hud-loan', ledger.loan > 0 ? `LOAN ${formatCost(ledger.loan)}` : 'NO DEBT');
    this.set('.gm-hud-price', `$${ledger.price.toFixed(0)}/MWh`);
    this.set('.gm-hud-mw', `${mwe.toFixed(0)} MWe`);
  }

  /** Construction phase variant: show design cost against the loan cap. */
  setBudget(designCost: number, loanCap: number): void {
    const el = this.root?.querySelector('.gm-hud-price') as HTMLSpanElement | null;
    if (el) {
      el.textContent = `BUDGET ${formatCost(designCost)} / ${formatCost(loanCap)}`;
      el.style.color = designCost <= loanCap ? '#8cf' : '#f55';
    }
    this.set('.gm-hud-mw', '');
  }

  setGoals(goals: GoalProgress[]): void {
    const el = this.root?.querySelector('.gm-hud-goals') as HTMLDivElement | null;
    if (!el) return;
    el.innerHTML = goals.map(g => `
      <span class="gm-goal ${g.done ? 'gm-goal-done' : ''}">
        <span class="gm-goal-check">${g.done ? '&#9745;' : '&#9744;'}</span>
        ${g.def.label ?? ''} <span class="gm-goal-readout">${g.readout}</span>
        <span class="gm-goal-bar"><span class="gm-goal-fill" style="width:${(g.fraction * 100).toFixed(0)}%"></span></span>
      </span>`).join('');
  }

  setHints(hints: string[] | undefined): void {
    const el = this.root?.querySelector('.gm-hud-hints') as HTMLDivElement | null;
    if (!el) return;
    el.innerHTML = hints?.length
      ? hints.map(h => `<div class="gm-hint">&#9656; ${h}</div>`).join('')
      : '';
  }

  /** Push a line onto the ticker for ~8 seconds. */
  ticker(message: string, alarm = false): void {
    const el = this.root?.querySelector('.gm-hud-ticker') as HTMLDivElement | null;
    if (!el) return;
    el.textContent = message;
    el.className = 'gm-hud-ticker' + (alarm ? ' gm-hud-ticker-alarm' : '');
    if (this.tickerTimeout !== null) clearTimeout(this.tickerTimeout);
    this.tickerTimeout = window.setTimeout(() => { el.textContent = ''; }, 8000);
  }

  private set(selector: string, text: string): void {
    const el = this.root?.querySelector(selector) as HTMLElement | null;
    if (el) el.textContent = text;
  }
}
