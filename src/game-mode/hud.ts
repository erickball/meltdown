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

/**
 * The app's own panels the HUD must not sit on top of. Measured live (they
 * come and go with selection and with the debug panel's toggle), and the
 * HUD slides along the top edge to the widest clear span.
 */
const HUD_OBSTACLE_SELECTORS = [
  '#toolbar', '#debug-panel', '#component-detail',
  '#construction-cost-panel', '#mw-to-grid-panel', '.gm-operator-panel',
];

export class GameHud {
  private root: HTMLDivElement | null = null;
  private collapsed = false;
  private tickerTimeout: number | null = null;
  private layoutTimer: number | null = null;
  private lastLayoutKey = '';

  constructor(private actions: HudActions) {}

  show(): void {
    if (this.root) return;
    const el = document.createElement('div');
    el.className = 'gm-hud';
    el.innerHTML = `
      <div class="gm-hud-row1">
        <span class="gm-hud-level"></span>
        <span class="gm-hud-clock"></span>
        <span class="gm-hud-phase"></span>
        <span class="gm-hud-cash" title="Operating cash. Revenue in, interest and repairs out. Zero means bankruptcy."></span>
        <span class="gm-hud-loan" title="Outstanding construction loan. You pay interest on this every fiscal day (= 1 sim minute)."></span>
        <span class="gm-hud-price" title="Live electricity price. Day/night cycle plus market moods. Sell high."></span>
        <span class="gm-hud-mw" title="Current generator output."></span>
        <button class="gm-hud-btn gm-hud-primary"></button>
        <button class="gm-hud-btn gm-hud-music" title="Toggle chiptunes">&#9835;</button>
        <button class="gm-hud-btn gm-hud-abandon" title="Abandon this level and return to the title screen">QUIT</button>
        <button class="gm-hud-btn gm-hud-hide" title="Collapse the HUD to one line (it can cover other panels)">&#9650; HIDE</button>
      </div>
      <div class="gm-hud-goals"></div>
      <div class="gm-hud-ticker"></div>
      <div class="gm-hud-events" title="Major events this run. Entries stay until you dismiss them."></div>
      <div class="gm-hud-hints"></div>
    `;
    document.body.appendChild(el);
    this.root = el;

    // Collapsed state: the HUD shrinks to one line that keeps the essentials
    // (level, money, primary action) visible without covering other panels.
    el.querySelector('.gm-hud-hide')?.addEventListener('click', () => this.setCollapsed(!this.collapsed));

    el.querySelector('.gm-hud-primary')?.addEventListener('click', () => this.actions.onPrimary());
    el.querySelector('.gm-hud-abandon')?.addEventListener('click', () => this.actions.onAbandon());
    el.querySelector('.gm-hud-music')?.addEventListener('click', (e) => {
      const muted = this.actions.onToggleMusic();
      (e.target as HTMLButtonElement).style.opacity = muted ? '0.4' : '1';
    });

    // Keep clear of the app's panels: measured every quarter second (they
    // appear and vanish with the selection) and on resize
    this.layout();
    this.layoutTimer = window.setInterval(() => this.layout(), 250);
    window.addEventListener('resize', this.onResize);
  }

  private onResize = (): void => { this.lastLayoutKey = ''; this.layout(); };

  /**
   * Put the HUD along the top edge where nothing else is. The app's panels
   * (toolbar, cost readout, component detail, debug panel) all hang from the
   * top; the HUD takes the widest horizontal span left between the ones
   * that are up, right-aligned in it. If no span is wide enough it drops
   * below them instead. Only writes the DOM when the answer changes.
   */
  private layout(): void {
    const root = this.root;
    if (!root) return;
    const vw = window.innerWidth;
    const GAP = 10;
    const hudH = root.offsetHeight || 60;
    const band = { top: 0, bottom: GAP + hudH };
    const blocks: Array<{ left: number; right: number; bottom: number }> = [];
    for (const sel of HUD_OBSTACLE_SELECTORS) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        if (el === root || !el.isConnected) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.bottom <= band.top || r.top >= band.bottom) continue;   // not in the top band
        blocks.push({ left: r.left, right: r.right, bottom: r.bottom });
      }
    }
    blocks.sort((a, b) => a.left - b.left);
    // Widest clear span across the top band
    let best = { start: 0, end: vw };
    let cursor = 0;
    let bestWidth = -1;
    const consider = (start: number, end: number) => {
      if (end - start > bestWidth) { bestWidth = end - start; best = { start, end }; }
    };
    for (const b of blocks) {
      if (b.left > cursor) consider(cursor, b.left);
      cursor = Math.max(cursor, b.right);
    }
    consider(cursor, vw);
    // Narrower than this and the HUD would fold into a tall sliver; it goes
    // under the panels instead
    const MIN_SPAN = 480;
    let top = GAP;
    let right: number;
    let maxWidth: number;
    if (bestWidth >= MIN_SPAN) {
      right = vw - best.end + GAP;
      maxWidth = bestWidth - 2 * GAP;
    } else {
      // Nowhere along the top: go under whatever hangs lowest
      top = Math.max(GAP, ...blocks.map(b => b.bottom + GAP));
      right = GAP;
      maxWidth = vw - 2 * GAP;
    }
    const key = `${top}|${right}|${Math.round(maxWidth)}`;
    if (key === this.lastLayoutKey) return;
    this.lastLayoutKey = key;
    root.style.top = `${top}px`;
    root.style.right = `${right}px`;
    root.style.left = 'auto';
    root.style.maxWidth = `${Math.round(maxWidth)}px`;
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.root?.classList.toggle('gm-hud-collapsed', collapsed);
    this.refreshHideButton();
    this.lastLayoutKey = '';
    this.layout();
  }

  /** The HIDE/SHOW toggle, which carries the count of folded-away events. */
  private refreshHideButton(): void {
    const btn = this.root?.querySelector('.gm-hud-hide') as HTMLButtonElement | null;
    if (!btn) return;
    const events = this.root?.querySelector('.gm-hud-events')?.children.length ?? 0;
    if (this.collapsed) {
      btn.innerHTML = events > 0 ? `&#9660; SHOW (${events})` : '&#9660; SHOW';
      btn.title = events > 0
        ? `Show the full HUD (${events} event${events === 1 ? '' : 's'} folded away)`
        : 'Show the full HUD';
    } else {
      btn.innerHTML = '&#9650; HIDE';
      btn.title = 'Fold the HUD down to its title line - the level, its clock, and the main button. Events keep collecting behind the SHOW button.';
    }
  }

  hide(): void {
    if (this.tickerTimeout !== null) clearTimeout(this.tickerTimeout);
    if (this.layoutTimer !== null) { clearInterval(this.layoutTimer); this.layoutTimer = null; }
    window.removeEventListener('resize', this.onResize);
    this.root?.remove();
    this.root = null;
    this.lastLayoutKey = '';
  }

  /** The level's clock, on the title line (visible collapsed or not). */
  setClock(clock: { text: string; title: string } | null): void {
    const el = this.root?.querySelector('.gm-hud-clock') as HTMLElement | null;
    if (!el) return;
    el.textContent = clock ? `\u23F1 ${clock.text}` : '';
    el.title = clock?.title ?? '';
  }

  setLevel(title: string): void {
    this.set('.gm-hud-level', title);
  }

  /**
   * Show or hide the money readouts. A level with no economy (LevelDef
   * `economy: 'none'`) has no cash, loan, price or generation to report, and
   * four permanently-blank fields read as a bug rather than as a design.
   */
  setEconomyVisible(visible: boolean): void {
    for (const sel of ['.gm-hud-cash', '.gm-hud-loan', '.gm-hud-price', '.gm-hud-mw']) {
      const el = this.root?.querySelector(sel) as HTMLElement | null;
      if (el) el.style.display = visible ? '' : 'none';
    }
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

  /**
   * Append a line to the persistent major-events log. Unlike the ticker,
   * entries stay until the player dismisses them (x) - the running record of
   * bursts, trips, and casualties for the current run.
   */
  addEvent(message: string, simTime?: number, alarm = false): void {
    const el = this.root?.querySelector('.gm-hud-events') as HTMLDivElement | null;
    if (!el) return;
    const row = document.createElement('div');
    row.className = 'gm-event' + (alarm ? ' gm-event-alarm' : '');
    const stamp = simTime !== undefined
      ? `<span class="gm-event-time">t=${Math.floor(simTime / 60)}:${String(Math.floor(simTime % 60)).padStart(2, '0')}</span> `
      : '';
    row.innerHTML = `${stamp}<span class="gm-event-text"></span><button class="gm-event-x" title="Dismiss">&times;</button>`;
    (row.querySelector('.gm-event-text') as HTMLElement).textContent = message;
    row.querySelector('.gm-event-x')?.addEventListener('click', () => { row.remove(); this.refreshHideButton(); });
    el.prepend(row);
    // keep the list from swallowing the screen; old entries scroll away
    while (el.children.length > 8) el.lastElementChild?.remove();
    this.refreshHideButton();
  }

  /** Clear the major-events log (new run / new level). */
  clearEvents(): void {
    const el = this.root?.querySelector('.gm-hud-events') as HTMLDivElement | null;
    if (el) el.innerHTML = '';
    this.refreshHideButton();
  }

  private set(selector: string, text: string): void {
    const el = this.root?.querySelector(selector) as HTMLElement | null;
    if (el) el.textContent = text;
  }
}
