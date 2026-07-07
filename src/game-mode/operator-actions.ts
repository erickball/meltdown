/**
 * Operator actions: the career-mode in-simulation control panel.
 *
 * Select a machine while operating and this panel offers what a real crew
 * could do to it: start/stop and re-speed pumps, stroke valves, flip process
 * controllers between AUTO and MANUAL. Control-room actions (controllers)
 * are instant; field actions (pumps, valves) take OPERATOR_WALK_SECONDS of
 * sim time - someone has to put on boots and walk out there - shown with a
 * progress bar, as demanded by tradition.
 */

import { SimulationState } from '../simulation';
import { ChipTunes } from './music';

const OPERATOR_WALK_SECONDS = 20;

interface PendingAction {
  componentId: string;
  description: string;
  readyAt: number;       // sim time
  issuedAt: number;
  apply: (state: SimulationState) => void;
}

export interface OperatorHost {
  applyToSim(mutate: (state: SimulationState) => void): void;
  getSimState(): SimulationState;
  tunes: ChipTunes;
  notify(message: string): void;
}

export class OperatorActionsPanel {
  private panel: HTMLDivElement | null = null;
  private selectedId: string | null = null;
  private pending: PendingAction[] = [];
  private lastRenderKey = '';

  constructor(private host: OperatorHost) {}

  /** Show/refresh for a selected component (null hides unless work is pending). */
  select(componentId: string | null): void {
    this.selectedId = componentId;
    this.lastRenderKey = '';
    this.render();
  }

  hide(): void {
    this.selectedId = null;
    this.pending = [];
    this.panel?.remove();
    this.panel = null;
  }

  /** Called every sim update: applies due actions, refreshes progress bars. */
  tick(state: SimulationState): void {
    let applied = false;
    for (const action of this.pending) {
      if (state.time >= action.readyAt) {
        this.host.applyToSim(action.apply);
        this.host.notify(`Operator: ${action.description} - done`);
        this.host.tunes.sfx('click');
        applied = true;
      }
    }
    if (applied) {
      this.pending = this.pending.filter(a => state.time < a.readyAt);
    }
    this.render();
  }

  private queueField(componentId: string, description: string, apply: (s: SimulationState) => void): void {
    const t = this.host.getSimState().time;
    // one field action per component at a time; a new order replaces the old
    this.pending = this.pending.filter(a => a.componentId !== componentId);
    this.pending.push({ componentId, description, issuedAt: t, readyAt: t + OPERATOR_WALK_SECONDS, apply });
    this.host.notify(`Operator dispatched: ${description} (~${OPERATOR_WALK_SECONDS}s)`);
    this.host.tunes.sfx('click');
    this.lastRenderKey = '';
    this.render();
  }

  private ensurePanel(): HTMLDivElement {
    if (this.panel) return this.panel;
    const p = document.createElement('div');
    p.className = 'gm-operator-panel';
    document.body.appendChild(p);
    this.panel = p;
    return p;
  }

  private render(): void {
    const state = this.host.getSimState();
    const id = this.selectedId;

    const pump = id ? state.components.pumps.get(id) : undefined;
    const valve = id ? state.components.valves.get(id) : undefined;
    const controller = id ? state.components.controllers?.get(id) : undefined;
    const hasContent = !!(pump || valve || controller) || this.pending.length > 0;

    if (!hasContent) {
      this.panel?.remove();
      this.panel = null;
      return;
    }

    // Re-render only when the shape of the content changes; sliders are
    // written by the user, not fought over by the refresh loop.
    const pendingKey = this.pending.map(a => a.componentId + a.readyAt.toFixed(1)).join('|');
    const renderKey = [
      id, !!pump, pump?.running, !!valve, valve?.relief?.controlMode,
      !!controller, controller?.mode, pendingKey,
    ].join(':');
    const needsRebuild = renderKey !== this.lastRenderKey;

    const panel = this.ensurePanel();
    if (needsRebuild) {
      this.lastRenderKey = renderKey;
      panel.innerHTML = this.buildHtml(id, { pump, valve, controller });
      this.wireHandlers(panel, id, { pump, valve, controller });
    }

    // progress bars every tick
    panel.querySelectorAll<HTMLDivElement>('.gm-op-progress-fill').forEach(el => {
      const cid = el.dataset.cid!;
      const action = this.pending.find(a => a.componentId === cid);
      if (action) {
        const frac = Math.min(1, (state.time - action.issuedAt) / (action.readyAt - action.issuedAt));
        el.style.width = `${(frac * 100).toFixed(0)}%`;
      }
    });
  }

  private buildHtml(
    id: string | null,
    sel: { pump?: any; valve?: any; controller?: any }
  ): string {
    let html = `<div class="gm-op-title">OPERATOR ACTIONS</div>`;

    if (id && sel.pump) {
      const p = sel.pump;
      html += `
        <div class="gm-op-row"><span class="gm-op-label">${id}</span>
          <span class="gm-op-status">${p.running ? 'RUNNING' : 'STOPPED'} @ ${(p.effectiveSpeed * 100).toFixed(0)}%</span></div>
        <div class="gm-op-row">
          <button class="gm-op-btn" data-op="pump-toggle">${p.running ? 'STOP PUMP' : 'START PUMP'}</button>
        </div>
        <div class="gm-op-row">
          <label>Speed <input type="range" class="gm-op-slider" data-op="pump-speed" min="10" max="100" value="${Math.round((p.speed || 1) * 100)}"></label>
        </div>`;
    }

    if (id && sel.valve) {
      const v = sel.valve;
      if (v.relief && v.relief.controlMode !== undefined) {
        html += `
          <div class="gm-op-row"><span class="gm-op-label">${id}</span>
            <span class="gm-op-status">PORV mode: ${v.relief.controlMode.toUpperCase()}</span></div>
          <div class="gm-op-row">
            <button class="gm-op-btn" data-op="porv-auto">AUTO</button>
            <button class="gm-op-btn" data-op="porv-open">OPEN</button>
            <button class="gm-op-btn" data-op="porv-closed">CLOSE</button>
          </div>`;
      } else {
        html += `
          <div class="gm-op-row"><span class="gm-op-label">${id}</span>
            <span class="gm-op-status">position ${(v.position * 100).toFixed(0)}%</span></div>
          <div class="gm-op-row">
            <label>Position <input type="range" class="gm-op-slider" data-op="valve-pos" min="0" max="100" value="${Math.round(v.position * 100)}"></label>
          </div>`;
      }
    }

    if (id && sel.controller) {
      const c = sel.controller;
      html += `
        <div class="gm-op-row"><span class="gm-op-label">${c.label || id}</span>
          <span class="gm-op-status">${c.mode.toUpperCase()}</span></div>
        <div class="gm-op-row">
          <button class="gm-op-btn" data-op="ctl-toggle">${c.mode === 'auto' ? 'TO MANUAL' : 'TO AUTO'}</button>
        </div>`;
      if (c.mode === 'manual') {
        const min = c.actuator.min ?? 0;
        const max = c.actuator.max ?? 1;
        const val = c.manualOutput ?? c.lastOutput ?? min;
        const pct = Math.round(((val - min) / (max - min || 1)) * 100);
        html += `
        <div class="gm-op-row">
          <label>Output <input type="range" class="gm-op-slider" data-op="ctl-output" min="0" max="100" value="${pct}"></label>
        </div>`;
      }
    }

    for (const action of this.pending) {
      html += `
        <div class="gm-op-pending">
          <div class="gm-op-pending-label">${action.description}</div>
          <div class="gm-op-progress"><div class="gm-op-progress-fill" data-cid="${action.componentId}"></div></div>
        </div>`;
    }

    return html;
  }

  private wireHandlers(
    panel: HTMLDivElement,
    id: string | null,
    sel: { pump?: any; valve?: any; controller?: any }
  ): void {
    if (!id) return;

    panel.querySelector('[data-op="pump-toggle"]')?.addEventListener('click', () => {
      const startIt = !sel.pump.running;
      this.queueField(id, `${startIt ? 'start' : 'stop'} ${id}`, (s) => {
        const p = s.components.pumps.get(id);
        if (!p) return;
        p.running = startIt;
        if (!startIt) p.speed = 0;
        else if (p.speed <= 0) p.speed = 1.0;
      });
    });

    panel.querySelector('[data-op="pump-speed"]')?.addEventListener('change', (e) => {
      const frac = parseInt((e.target as HTMLInputElement).value, 10) / 100;
      this.queueField(id, `set ${id} speed to ${(frac * 100).toFixed(0)}%`, (s) => {
        const p = s.components.pumps.get(id);
        if (!p) return;
        p.speed = frac;
        if (frac > 0) p.running = true;
      });
    });

    panel.querySelector('[data-op="valve-pos"]')?.addEventListener('change', (e) => {
      const frac = parseInt((e.target as HTMLInputElement).value, 10) / 100;
      this.queueField(id, `stroke ${id} to ${(frac * 100).toFixed(0)}%`, (s) => {
        const v = s.components.valves.get(id);
        if (v) v.position = frac;
      });
    });

    for (const mode of ['auto', 'open', 'closed'] as const) {
      panel.querySelector(`[data-op="porv-${mode}"]`)?.addEventListener('click', () => {
        // PORVs are solenoid-operated from the control room: instant
        this.host.applyToSim((s) => {
          const v = s.components.valves.get(id);
          if (v?.relief) v.relief = { ...v.relief, controlMode: mode };
        });
        this.host.tunes.sfx('click');
        this.lastRenderKey = '';
      });
    }

    panel.querySelector('[data-op="ctl-toggle"]')?.addEventListener('click', () => {
      // control room: instant, bumpless (velocity-form controllers)
      this.host.applyToSim((s) => {
        const c = s.components.controllers?.get(id);
        if (!c) return;
        c.mode = c.mode === 'auto' ? 'manual' : 'auto';
        c.manualOutput = c.mode === 'manual' ? c.lastOutput : undefined;
      });
      this.host.tunes.sfx('click');
      this.lastRenderKey = '';
    });

    panel.querySelector('[data-op="ctl-output"]')?.addEventListener('change', (e) => {
      const pct = parseInt((e.target as HTMLInputElement).value, 10) / 100;
      this.host.applyToSim((s) => {
        const c = s.components.controllers?.get(id);
        if (!c) return;
        const min = c.actuator.min ?? 0;
        const max = c.actuator.max ?? 1;
        c.manualOutput = min + pct * (max - min);
      });
    });
  }
}
