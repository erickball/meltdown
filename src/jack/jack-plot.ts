/**
 * Chart panel renderer for Jack's plot_history tool.
 *
 * Plain canvas 2D line charts in a draggable floating panel - no chart
 * library. Generic on purpose: N series on left/right y axes, linear or log
 * scale per axis, gaps for missing data, vertical annotation lines. All
 * data arrives pre-scaled (unit conversion happens in jack-history.ts via
 * per-series scale/offset).
 */

export interface RenderSeries {
  label: string;
  color: string;
  axis: 'left' | 'right';
  xs: number[];
  ys: (number | null)[];
}

export interface PlotPanelSpec {
  figureId: string;
  title: string;
  xLabel: string;
  yLabelLeft?: string;
  yLabelRight?: string;
  logLeft?: boolean;
  logRight?: boolean;
  series: RenderSeries[];
  annotations: Array<{ time: number; label: string }>;
  /**
   * Current sim position. When it sits before the end of the plotted range
   * (the user rewound), a "now" marker is drawn there - the chart keeps
   * showing the full recorded history instead of truncating to the past.
   */
  nowTime?: number;
  /** Called when the user closes the panel (× button or closeAllPlots) */
  onClose?: () => void;
}

const PANEL_W = 640;
const PANEL_H = 396; // header + legend + default chart area

let panelCascade = 0;

// Last spec per open panel, so a resize can redraw without re-sampling
const panelSpecs = new Map<string, PlotPanelSpec>();
const panelObservers = new Map<string, ResizeObserver>();

/** Is a figure's panel currently open (and not just minimized)? */
export function isPlotOpen(figureId: string): boolean {
  return document.getElementById(`jack-plot-${figureId}`) !== null;
}

/** Is the panel minimized? Live refresh skips redrawing collapsed charts. */
export function isPlotMinimized(figureId: string): boolean {
  const panel = document.getElementById(`jack-plot-${figureId}`);
  return !!panel && panel.dataset.minimized === '1';
}

/** Close every open plot panel (fires each panel's onClose). */
export function closeAllPlots(): void {
  for (const figureId of [...panelSpecs.keys()]) {
    closePanel(figureId);
  }
}

function closePanel(figureId: string): void {
  const panel = document.getElementById(`jack-plot-${figureId}`);
  panelObservers.get(figureId)?.disconnect();
  panelObservers.delete(figureId);
  const spec = panelSpecs.get(figureId);
  panelSpecs.delete(figureId);
  panel?.remove();
  spec?.onClose?.();
}

/** Create or update the floating panel for a figure and draw the chart. */
export function showPlotPanel(spec: PlotPanelSpec): void {
  const panelId = `jack-plot-${spec.figureId}`;
  let panel = document.getElementById(panelId) as HTMLDivElement | null;
  if (!panel) {
    panel = document.createElement('div');
    panel.id = panelId;
    const offset = (panelCascade++ % 5) * 28;
    panel.style.cssText = `
      position: fixed; right: ${80 + offset}px; bottom: ${90 + offset}px;
      width: ${PANEL_W}px; height: ${PANEL_H}px; z-index: 900;
      background: #1a1e24; border: 1px solid #445566; border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5); color: #d0d8e0;
      font-family: 'Consolas', monospace; user-select: none;
      display: flex; flex-direction: column;
      resize: both; overflow: hidden;
      min-width: 320px; min-height: 160px;
    `;

    const header = document.createElement('div');
    header.className = 'jack-plot-header';
    header.title =
      'Plotted from the simulation history (about one point per frame recently, ' +
      'sparser further back). Drag to move; resize from the bottom-right corner; ' +
      '– to minimize; × to close.';
    header.style.cssText = `
      display: flex; justify-content: space-between; align-items: center;
      padding: 6px 10px; cursor: move; border-bottom: 1px solid #334455;
      flex: 0 0 auto;
    `;
    const titleEl = document.createElement('span');
    titleEl.className = 'jack-plot-title';
    titleEl.style.cssText = 'font-size: 12px; color: #7af; font-weight: bold;';
    const buttons = document.createElement('span');
    buttons.style.cssText = 'display: inline-flex; gap: 6px;';
    const btnCss = `
      background: none; border: none; color: #99aacc; cursor: pointer;
      font-size: 16px; line-height: 1; padding: 0 2px;
    `;
    const minBtn = document.createElement('button');
    minBtn.className = 'jack-plot-min';
    minBtn.textContent = '–';
    minBtn.title = 'Minimize to the title bar (chart keeps updating in the background)';
    minBtn.style.cssText = btnCss;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.title = 'Close this chart';
    closeBtn.style.cssText = btnCss;
    closeBtn.addEventListener('click', () => closePanel(spec.figureId));
    buttons.appendChild(minBtn);
    buttons.appendChild(closeBtn);
    header.appendChild(titleEl);
    header.appendChild(buttons);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'jack-plot-body';
    body.style.cssText = 'display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0;';

    const legend = document.createElement('div');
    legend.className = 'jack-plot-legend';
    legend.style.cssText = `
      display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 5px 10px 0 10px;
      font-size: 11px; flex: 0 0 auto;
    `;
    body.appendChild(legend);

    const canvasBox = document.createElement('div');
    canvasBox.className = 'jack-plot-canvas-box';
    canvasBox.style.cssText = 'flex: 1 1 auto; min-height: 0; padding: 2px 4px 4px 4px;';
    const canvas = document.createElement('canvas');
    canvas.className = 'jack-plot-canvas';
    canvas.style.cssText = 'display: block; width: 100%; height: 100%;';
    canvasBox.appendChild(canvas);
    body.appendChild(canvasBox);
    panel.appendChild(body);

    // Minimize: collapse to the title bar, remember the expanded size
    minBtn.addEventListener('click', () => {
      const p = panel!;
      if (p.dataset.minimized === '1') {
        delete p.dataset.minimized;
        body.style.display = 'flex';
        p.style.height = p.dataset.expandedHeight || `${PANEL_H}px`;
        p.style.minHeight = '160px';
        p.style.resize = 'both';
        minBtn.textContent = '–';
        minBtn.title = 'Minimize to the title bar (chart keeps updating in the background)';
        const s = panelSpecs.get(spec.figureId);
        if (s) drawChart(canvas, s);
      } else {
        p.dataset.expandedHeight = p.style.height;
        p.dataset.minimized = '1';
        body.style.display = 'none';
        p.style.height = 'auto';
        p.style.minHeight = '0'; // the expanded min-height would hold it open
        p.style.resize = 'none';
        minBtn.textContent = '+';
        minBtn.title = 'Restore the chart';
      }
    });

    // Drag by the header
    let dragFrom: { x: number; y: number; left: number; top: number } | null = null;
    header.addEventListener('pointerdown', (e) => {
      if (e.target === closeBtn || e.target === minBtn) return;
      const rect = panel!.getBoundingClientRect();
      // Switch from right/bottom to left/top anchoring on first drag
      panel!.style.left = `${rect.left}px`;
      panel!.style.top = `${rect.top}px`;
      panel!.style.right = 'auto';
      panel!.style.bottom = 'auto';
      dragFrom = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragFrom) return;
      panel!.style.left = `${dragFrom.left + e.clientX - dragFrom.x}px`;
      panel!.style.top = `${dragFrom.top + e.clientY - dragFrom.y}px`;
    });
    header.addEventListener('pointerup', () => { dragFrom = null; });

    // Redraw at the new size when the user resizes the panel (coalesced to
    // one draw per animation frame)
    let resizeQueued = false;
    const observer = new ResizeObserver(() => {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(() => {
        resizeQueued = false;
        const s = panelSpecs.get(spec.figureId);
        if (s && panel!.dataset.minimized !== '1') drawChart(canvas, s);
      });
    });
    observer.observe(canvasBox);
    panelObservers.set(spec.figureId, observer);

    document.body.appendChild(panel);
  }

  panelSpecs.set(spec.figureId, spec);
  (panel.querySelector('.jack-plot-title') as HTMLSpanElement).textContent = spec.title;

  const legend = panel.querySelector('.jack-plot-legend') as HTMLDivElement;
  legend.innerHTML = '';
  for (const s of spec.series) {
    const item = document.createElement('span');
    item.style.cssText = 'display: inline-flex; align-items: center; gap: 5px;';
    const chip = document.createElement('span');
    chip.style.cssText = `width: 14px; height: 3px; background: ${s.color}; display: inline-block;`;
    const txt = document.createElement('span');
    txt.textContent = s.label + (s.axis === 'right' ? ' (R)' : '');
    item.appendChild(chip);
    item.appendChild(txt);
    legend.appendChild(item);
  }

  if (panel.dataset.minimized !== '1') {
    drawChart(panel.querySelector('.jack-plot-canvas') as HTMLCanvasElement, spec);
  }
}

// ---------------------------------------------------------------------------
// Chart drawing
// ---------------------------------------------------------------------------

/** "Nice" tick positions covering [lo, hi] with about n steps. */
function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!(hi > lo)) return [lo];
  const rawStep = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1.5 ? 1 : norm <= 3.5 ? 2 : norm <= 7.5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks;
}

/** Decade ticks for a log axis. */
function logTicks(lo: number, hi: number): number[] {
  const ticks: number[] = [];
  const d0 = Math.floor(Math.log10(lo));
  const d1 = Math.ceil(Math.log10(hi));
  for (let d = d0; d <= d1; d++) {
    const v = Math.pow(10, d);
    if (v >= lo / 1.0001 && v <= hi * 1.0001) ticks.push(v);
  }
  return ticks.length >= 2 ? ticks : [lo, hi];
}

/**
 * Format a tick value with enough digits to distinguish neighboring ticks -
 * precision comes from the tick STEP, not the magnitude (a 344.2..345.0
 * axis must not label every tick "344").
 */
function fmtTick(v: number, step: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  const s = Math.abs(step) || a || 1;
  if (a >= 1e6 || a < 1e-3) {
    const digits = Math.max(1, Math.min(4, Math.ceil(Math.log10(a / s))));
    return v.toExponential(digits).replace('e+', 'e');
  }
  const decimals = s >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(s) - 1e-9));
  return v.toFixed(decimals);
}

/** The spacing between ticks, for format precision (0 for a single tick). */
function tickStep(ticks: number[]): number {
  return ticks.length >= 2 ? ticks[1] - ticks[0] : 0;
}

interface AxisScale {
  min: number;
  max: number;
  log: boolean;
  toY: (v: number) => number;
  ticks: number[];
}

function buildAxis(
  values: number[],
  log: boolean,
  plotTop: number,
  plotBot: number
): AxisScale | null {
  const usable = log ? values.filter((v) => v > 0) : values;
  if (usable.length === 0) return null;
  let min = Math.min(...usable);
  let max = Math.max(...usable);
  if (log) {
    if (min === max) { min /= 2; max *= 2; }
    const lmin = Math.log10(min);
    const lmax = Math.log10(max);
    const pad = Math.max((lmax - lmin) * 0.05, 0.02);
    const plo = Math.pow(10, lmin - pad);
    const phi = Math.pow(10, lmax + pad);
    return {
      min: plo, max: phi, log,
      toY: (v) => plotBot - ((Math.log10(v) - Math.log10(plo)) / (Math.log10(phi) - Math.log10(plo))) * (plotBot - plotTop),
      ticks: logTicks(min, max),
    };
  }
  if (min === max) {
    const pad = Math.abs(min) > 1e-12 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  } else {
    const pad = (max - min) * 0.05;
    min -= pad;
    max += pad;
  }
  return {
    min, max, log,
    toY: (v) => plotBot - ((v - min) / (max - min)) * (plotBot - plotTop),
    ticks: niceTicks(min, max),
  };
}

function drawChart(canvas: HTMLCanvasElement, spec: PlotPanelSpec): void {
  const cssW = canvas.clientWidth || PANEL_W - 8;
  const cssH = canvas.clientHeight || 320;
  if (cssW < 40 || cssH < 40) return; // collapsed mid-resize; observer will redraw
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const hasRight = spec.series.some((s) => s.axis === 'right');
  const mLeft = 64;
  const mRight = hasRight ? 64 : 14;
  const mTop = 10;
  const mBot = 36;
  const plotL = mLeft;
  const plotR = cssW - mRight;
  const plotT = mTop;
  const plotB = cssH - mBot;

  // Time extent across all series
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const s of spec.series) {
    if (s.xs.length > 0) {
      tMin = Math.min(tMin, s.xs[0]);
      tMax = Math.max(tMax, s.xs[s.xs.length - 1]);
    }
  }
  if (!(tMax > tMin)) { tMax = tMin + 1; }
  const toX = (t: number) => plotL + ((t - tMin) / (tMax - tMin)) * (plotR - plotL);

  const leftVals: number[] = [];
  const rightVals: number[] = [];
  for (const s of spec.series) {
    const bucket = s.axis === 'right' ? rightVals : leftVals;
    for (const v of s.ys) if (v !== null && Number.isFinite(v)) bucket.push(v);
  }
  const leftAxis = buildAxis(leftVals, !!spec.logLeft, plotT, plotB);
  const rightAxis = hasRight ? buildAxis(rightVals, !!spec.logRight, plotT, plotB) : null;

  ctx.font = '10px Consolas, monospace';

  // Frame + gridlines from the left axis
  ctx.strokeStyle = '#334455';
  ctx.lineWidth = 1;
  ctx.strokeRect(plotL, plotT, plotR - plotL, plotB - plotT);
  if (leftAxis) {
    const step = leftAxis.log ? 0 : tickStep(leftAxis.ticks);
    for (const tick of leftAxis.ticks) {
      const y = leftAxis.toY(tick);
      if (y < plotT - 0.5 || y > plotB + 0.5) continue;
      ctx.strokeStyle = 'rgba(68, 85, 102, 0.35)';
      ctx.beginPath();
      ctx.moveTo(plotL, y);
      ctx.lineTo(plotR, y);
      ctx.stroke();
      ctx.fillStyle = '#99aacc';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmtTick(tick, leftAxis.log ? tick / 2 : step), plotL - 5, y);
    }
  } else {
    ctx.fillStyle = '#e15759';
    ctx.textAlign = 'center';
    ctx.fillText(
      spec.logLeft ? 'no positive values for log left axis' : 'no data on left axis',
      (plotL + plotR) / 2, (plotT + plotB) / 2
    );
  }
  if (rightAxis) {
    const step = rightAxis.log ? 0 : tickStep(rightAxis.ticks);
    for (const tick of rightAxis.ticks) {
      const y = rightAxis.toY(tick);
      if (y < plotT - 0.5 || y > plotB + 0.5) continue;
      ctx.fillStyle = '#99aacc';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmtTick(tick, rightAxis.log ? tick / 2 : step), plotR + 5, y);
    }
  }

  // X ticks
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = niceTicks(tMin, tMax, 6);
  const xStep = tickStep(xTicks);
  for (const tick of xTicks) {
    const x = toX(tick);
    if (x < plotL - 0.5 || x > plotR + 0.5) continue;
    ctx.strokeStyle = 'rgba(68, 85, 102, 0.35)';
    ctx.beginPath();
    ctx.moveTo(x, plotT);
    ctx.lineTo(x, plotB);
    ctx.stroke();
    ctx.fillStyle = '#99aacc';
    ctx.fillText(fmtTick(tick, xStep), x, plotB + 4);
  }

  // Axis labels
  ctx.fillStyle = '#99aacc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(spec.xLabel, (plotL + plotR) / 2, cssH - 2);
  if (spec.yLabelLeft) {
    ctx.save();
    ctx.translate(11, (plotT + plotB) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.yLabelLeft, 0, 0);
    ctx.restore();
  }
  if (spec.yLabelRight && rightAxis) {
    ctx.save();
    ctx.translate(cssW - 8, (plotT + plotB) / 2);
    ctx.rotate(Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.yLabelRight, 0, 0);
    ctx.restore();
  }

  // "Now" marker: only when the position is meaningfully before the end of
  // the plotted range - at the live head it would just underline the right
  // edge. Distinct from annotations (solid, accent-colored, flagged "now").
  if (
    spec.nowTime !== undefined &&
    spec.nowTime >= tMin &&
    spec.nowTime < tMax - (tMax - tMin) * 0.002
  ) {
    const x = toX(spec.nowTime);
    ctx.strokeStyle = '#77aaff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, plotT);
    ctx.lineTo(x, plotB);
    ctx.stroke();
    ctx.fillStyle = '#77aaff';
    ctx.beginPath();
    ctx.moveTo(x - 5, plotT);
    ctx.lineTo(x + 5, plotT);
    ctx.lineTo(x, plotT + 7);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = x > (plotL + plotR) / 2 ? 'right' : 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('now', x + (x > (plotL + plotR) / 2 ? -8 : 8), plotT + 2);
  }

  // Annotation lines
  for (const ann of spec.annotations) {
    if (ann.time < tMin || ann.time > tMax) continue;
    const x = toX(ann.time);
    ctx.strokeStyle = '#8899aa';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, plotT);
    ctx.lineTo(x, plotB);
    ctx.stroke();
    ctx.setLineDash([]);
    if (ann.label) {
      ctx.fillStyle = '#aabbcc';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(ann.label, x + 3, plotT + 2);
    }
  }

  // Series lines (clipped to the plot area; nulls and non-positive-on-log
  // values break the line into segments instead of interpolating across)
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotL, plotT, plotR - plotL, plotB - plotT);
  ctx.clip();
  for (const s of spec.series) {
    const axis = s.axis === 'right' ? rightAxis : leftAxis;
    if (!axis) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < s.xs.length; i++) {
      const v = s.ys[i];
      if (v === null || !Number.isFinite(v) || (axis.log && v <= 0)) {
        pen = false;
        continue;
      }
      const x = toX(s.xs[i]);
      const y = axis.toY(v);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
  }
  ctx.restore();
}
