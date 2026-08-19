/**
 * Jack's history analysis tools: a generic, matplotlib-flavored data layer
 * over the simulation's snapshot history.
 *
 * Any numeric (or boolean) value reachable in SimulationState is addressable
 * by a dot-path — e.g. `flowNodes.hx-1-tube.fluid.pressure`,
 * `neutronics.power`, `flowConnections.flow-tan-2-tan-3.massFlowRate` — and
 * can be explored (list_state_paths), sampled (query_history), or drawn for
 * the user (plot_history, rendered by jack-plot.ts). Values are RAW SI; the
 * plot tool takes per-series scale/offset so any linear unit conversion
 * works without a unit table.
 */

import type { SimulationState } from '../simulation/types';
import { showPlotPanel, type RenderSeries, type PlotPanelSpec } from './jack-plot';

export interface HistorySample {
  time: number;
  state: SimulationState;
}

const err = (message: string) => ({ ok: false as const, error: message });

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Walk a dot-path through nested objects, Maps, and arrays. Array segments
 * accept either an index or an element's `id` (flowConnections carry ids,
 * not stable indices). Returns undefined when any segment is missing.
 */
export function resolveStatePath(root: unknown, path: string): unknown {
  if (!path) return root;
  let node: unknown = root;
  for (const seg of path.split('.')) {
    if (node === null || node === undefined) return undefined;
    if (node instanceof Map) {
      node = node.get(seg);
    } else if (Array.isArray(node)) {
      const idx = Number(seg);
      if (Number.isInteger(idx) && idx >= 0 && idx < node.length) {
        node = node[idx];
      } else {
        node = node.find((el) => el && typeof el === 'object' && (el as { id?: unknown }).id === seg);
      }
    } else if (typeof node === 'object') {
      node = (node as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return node;
}

function kindOf(v: unknown): string {
  if (v === null || v === undefined) return 'empty';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'string';
  if (v instanceof Map) return `map(${v.size})`;
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') return 'object';
  return typeof v;
}

/** Child keys of a container, for discovery and for helpful errors. */
function childKeys(v: unknown): string[] {
  if (v instanceof Map) return [...v.keys()].map(String);
  if (Array.isArray(v)) {
    return v.map((el, i) =>
      el && typeof el === 'object' && typeof (el as { id?: unknown }).id === 'string'
        ? (el as { id: string }).id
        : String(i)
    );
  }
  if (v && typeof v === 'object') {
    return Object.keys(v).filter((k) => typeof (v as Record<string, unknown>)[k] !== 'function');
  }
  return [];
}

/** Numeric view of a leaf: numbers pass through, booleans become 0/1. */
function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

const round6 = (v: number) => Number(v.toPrecision(6));

/**
 * Diagnose a path against a state: how far it resolves and what is
 * available at the point of failure. Powers loud, useful tool errors.
 */
function diagnosePath(state: SimulationState, path: string): string {
  const segs = path.split('.');
  let node: unknown = state;
  for (let i = 0; i < segs.length; i++) {
    const next = resolveStatePath(node, segs[i]);
    if (next === undefined) {
      const keys = childKeys(node);
      const shown = keys.slice(0, 40).join(', ') + (keys.length > 40 ? `, … ${keys.length - 40} more` : '');
      const at = i === 0 ? 'top level' : `"${segs.slice(0, i).join('.')}"`;
      return `"${segs[i]}" not found at ${at}. Available keys there: ${shown || '(none - value is a ' + kindOf(node) + ')'}`;
    }
    node = next;
  }
  return `path resolves to a ${kindOf(node)}, not a number`;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** Evenly decimate to at most maxPoints samples, always keeping endpoints. */
function decimate(samples: HistorySample[], maxPoints: number): HistorySample[] {
  if (samples.length <= maxPoints) return samples;
  const out: HistorySample[] = [];
  const step = (samples.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    out.push(samples[Math.round(i * step)]);
  }
  return out;
}

export interface SampledSeries {
  path: string;
  values: (number | null)[];
  finiteCount: number;
  min: number | null;
  max: number | null;
  first: number | null;
  last: number | null;
}

/** Extract one numeric series per path from the (decimated) samples. */
function extractSeries(samples: HistorySample[], paths: string[]): SampledSeries[] {
  return paths.map((path) => {
    const values: (number | null)[] = [];
    let min: number | null = null;
    let max: number | null = null;
    let first: number | null = null;
    let last: number | null = null;
    let finiteCount = 0;
    for (const s of samples) {
      const v = asNumber(resolveStatePath(s.state, path));
      values.push(v);
      if (v !== null) {
        finiteCount++;
        if (min === null || v < min) min = v;
        if (max === null || v > max) max = v;
        if (first === null) first = v;
        last = v;
      }
    }
    return { path, values, finiteCount, min, max, first, last };
  });
}

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

/** list_state_paths: explore the current state tree one level at a time. */
export function execListStatePaths(
  input: Record<string, unknown>,
  sim: SimulationState
): unknown {
  const path = typeof input.path === 'string' ? input.path : '';
  const node = resolveStatePath(sim, path);
  if (node === undefined) {
    return err(`Path "${path}" does not resolve: ${diagnosePath(sim, path)}`);
  }
  const keys = childKeys(node);
  if (keys.length === 0) {
    const v = asNumber(node);
    return {
      path,
      kind: kindOf(node),
      value: v !== null ? round6(v) : typeof node === 'string' ? node : undefined,
      note: 'Leaf value (raw SI units). Numeric leaves can be plotted with plot_history.',
    };
  }
  const MAX = 80;
  const children = keys.slice(0, MAX).map((k) => {
    const child = resolveStatePath(node, k);
    const v = asNumber(child);
    return {
      key: k,
      kind: kindOf(child),
      ...(v !== null ? { value: round6(v) } : {}),
      ...(typeof child === 'string' ? { value: child } : {}),
    };
  });
  return {
    path: path || '(state root)',
    kind: kindOf(node),
    children,
    ...(keys.length > MAX ? { note: `${keys.length - MAX} more keys not shown` } : {}),
  };
}

function parseRange(input: Record<string, unknown>): { tMin: number; tMax: number } {
  const tMin = typeof input.tMinS === 'number' ? input.tMinS : -Infinity;
  const tMax = typeof input.tMaxS === 'number' ? input.tMaxS : Infinity;
  return { tMin, tMax };
}

/** query_history: sampled numeric time series for Jack's own analysis. */
export function execQueryHistory(
  input: Record<string, unknown>,
  getHistory: (tMin: number, tMax: number) => HistorySample[]
): unknown {
  const paths = Array.isArray(input.paths) ? (input.paths as unknown[]).map(String) : [];
  if (paths.length === 0) return err('paths is required (array of dot-paths into the state)');
  if (paths.length > 8) return err('At most 8 paths per query - call again for more.');
  const { tMin, tMax } = parseRange(input);
  const all = getHistory(tMin, tMax);
  if (all.length < 2) {
    return err('Not enough recorded history in that range - run the simulation first.');
  }
  const maxPoints = Math.min(Math.max(Number(input.maxPoints) || 40, 2), 200);
  const samples = decimate(all, maxPoints);
  const series = extractSeries(samples, paths);

  const dead = series.filter((s) => s.finiteCount === 0);
  if (dead.length === paths.length) {
    return err(
      `No numeric data at any of these paths. ${dead
        .map((s) => `${s.path}: ${diagnosePath(samples[samples.length - 1].state, s.path)}`)
        .join('; ')}`
    );
  }

  return {
    note: 'Values are raw SI (Pa, K, kg, W, kg/s). null = value absent at that time.',
    historyExtentS: [round6(all[0].time), round6(all[all.length - 1].time)],
    points: samples.length,
    tS: samples.map((s) => round6(s.time)),
    series: Object.fromEntries(
      series.map((s) => [
        s.path,
        s.finiteCount === 0
          ? { error: diagnosePath(samples[samples.length - 1].state, s.path) }
          : {
              values: s.values.map((v) => (v === null ? null : round6(v))),
              min: round6(s.min!),
              max: round6(s.max!),
              first: round6(s.first!),
              last: round6(s.last!),
            },
      ])
    ),
  };
}

const SERIES_COLORS = [
  '#4e9de0', '#f28e2b', '#59a14b', '#e15759', '#b07aa1',
  '#76b7b2', '#edc948', '#ff9da7', '#9c755f', '#bab0ac',
];

/** plot_history: render a chart panel for the user; returns a summary. */
export function execPlotHistory(
  input: Record<string, unknown>,
  getHistory: (tMin: number, tMax: number) => HistorySample[],
  record: (description: string) => void
): unknown {
  const rawSeries = Array.isArray(input.series) ? (input.series as Record<string, unknown>[]) : [];
  if (rawSeries.length === 0) {
    return err('series is required: an array of { path, label?, axis?, scale?, offset? }');
  }
  if (rawSeries.length > 10) return err('At most 10 series per plot.');
  const { tMin, tMax } = parseRange(input);
  const all = getHistory(tMin, tMax);
  if (all.length < 2) {
    return err('Not enough recorded history in that range - run the simulation first.');
  }
  const maxPoints = Math.min(Math.max(Number(input.maxPoints) || 400, 10), 2000);
  const samples = decimate(all, maxPoints);
  const sampled = extractSeries(samples, rawSeries.map((s) => String(s.path ?? '')));

  const dead: string[] = [];
  const render: RenderSeries[] = [];
  const summary: Array<Record<string, unknown>> = [];
  for (let i = 0; i < sampled.length; i++) {
    const s = sampled[i];
    const spec = rawSeries[i];
    if (s.finiteCount === 0) {
      dead.push(`${s.path}: ${diagnosePath(samples[samples.length - 1].state, s.path)}`);
      continue;
    }
    const scale = typeof spec.scale === 'number' ? spec.scale : 1;
    const offset = typeof spec.offset === 'number' ? spec.offset : 0;
    const axis = spec.axis === 'right' ? 'right' as const : 'left' as const;
    const label = typeof spec.label === 'string' && spec.label ? spec.label : s.path;
    const ys = s.values.map((v) => (v === null ? null : v * scale + offset));
    const finite = ys.filter((v): v is number => v !== null);
    render.push({
      label,
      color: SERIES_COLORS[render.length % SERIES_COLORS.length],
      axis,
      xs: samples.map((sm) => sm.time),
      ys,
    });
    summary.push({
      path: s.path,
      label,
      axis,
      min: round6(Math.min(...finite)),
      max: round6(Math.max(...finite)),
      last: round6(finite[finite.length - 1]),
    });
  }
  if (render.length === 0) {
    return err(`No numeric data to plot. ${dead.join('; ')}`);
  }

  const annotations = Array.isArray(input.annotations)
    ? (input.annotations as Record<string, unknown>[])
        .filter((a) => typeof a.timeS === 'number')
        .map((a) => ({ time: Number(a.timeS), label: String(a.label ?? '') }))
        .slice(0, 12)
    : [];

  const figureId = typeof input.figureId === 'string' && input.figureId ? input.figureId : 'jack-plot';
  const title = typeof input.title === 'string' && input.title ? input.title : 'Plant history';
  const spec: PlotPanelSpec = {
    figureId,
    title,
    xLabel: 'Time (s)',
    yLabelLeft: typeof input.yLabel === 'string' ? input.yLabel : undefined,
    yLabelRight: typeof input.y2Label === 'string' ? input.y2Label : undefined,
    logLeft: input.logY === true,
    logRight: input.logY2 === true,
    series: render,
    annotations,
  };
  showPlotPanel(spec);
  record(`Jack plotted "${title}" (${render.length} series, ${samples.length} points)`);

  return {
    ok: true,
    figureId,
    note: 'Chart is now displayed to the user. Same figureId replaces the panel; a new figureId opens another.',
    pointsPlotted: samples.length,
    timeRangeS: [round6(samples[0].time), round6(samples[samples.length - 1].time)],
    series: summary,
    ...(dead.length > 0 ? { skipped: dead } : {}),
  };
}
