/**
 * History timeline grouping - the model behind the "Navigate to State"
 * dialog.
 *
 * A long run has hundreds of snapshots; listing them flat means scrolling
 * past everything to find anything. Instead the recorded range is cut into
 * at most `maxGroups` time bands on a round interval (1 s, 5 s, 1 min, 10
 * min, ...), each band expandable; a band with more than `leafMax` snapshots
 * is cut again on the next finer interval, recursively, so every level of
 * the tree shows the full extent of what it covers in a handful of rows and
 * the leaves list the snapshots themselves.
 *
 * Events (ruptures, scrams, scenario events, plant rebuilds) are placed
 * between the snapshots they fall between - after the last snapshot whose
 * seq <= the event's seq and before the next one - so the list says which
 * state is the last one without the event and which is the first with it.
 * Group headers carry the events that fall inside them.
 *
 * Pure: no DOM, no game loop - testable headless.
 */

export interface TimelineSnapshot {
  index: number;
  simTime: number;
  stepNumber: number;
  kind: string;
  epoch: number;
  seq: number;
  isSecondMarker?: boolean;
}

export interface TimelineEvent {
  seq: number;
  step: number;
  simTime: number;
  type: string;
  message: string;
}

/** A leaf row: one snapshot, or an event sitting between two snapshots. */
export type TimelineItem =
  | { kind: 'snapshot'; snapshot: TimelineSnapshot }
  | { kind: 'event'; event: TimelineEvent };

export interface TimelineGroup {
  /** Time band covered, [tStart, tEnd) - tEnd is exclusive except at the top. */
  tStart: number;
  tEnd: number;
  /** Interval the band was cut on (seconds), for labelling. */
  span: number;
  snapshotCount: number;
  events: TimelineEvent[];
  /** Either finer groups or the rows themselves, in time order. */
  children: TimelineGroup[] | null;
  items: TimelineItem[] | null;
  /** True when the current position (a snapshot index or a time) lies inside. */
  containsCurrent: boolean;
}

/** Round intervals to cut on, seconds. Extended by doubling past the end. */
const NICE_SPANS = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800,
  3600, 7200, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400,
];

/** The smallest round interval that covers [t0, t1] in at most n bands. */
export function chooseSpan(t0: number, t1: number, n: number): number {
  const range = Math.max(0, t1 - t0);
  for (const s of NICE_SPANS) {
    if (Math.floor(t1 / s) - Math.floor(t0 / s) + 1 <= n) return s;
  }
  let s = NICE_SPANS[NICE_SPANS.length - 1];
  while (Math.floor(t1 / s) - Math.floor(t0 / s) + 1 > n) s *= 2;
  return range === 0 ? NICE_SPANS[0] : s;
}

/**
 * Interleave events between snapshots. Both lists must be in recording
 * order (snapshots by seq ascending; events by seq then recording order).
 */
export function interleave(snapshots: TimelineSnapshot[], events: TimelineEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let e = 0;
  for (const s of snapshots) {
    // Events emitted after an earlier snapshot and before this one
    while (e < events.length && events[e].seq < s.seq) {
      items.push({ kind: 'event', event: events[e++] });
    }
    items.push({ kind: 'snapshot', snapshot: s });
  }
  while (e < events.length) items.push({ kind: 'event', event: events[e++] });
  return items;
}

export interface BuildTimelineOptions {
  maxGroups?: number;   // default 10
  leafMax?: number;     // a band with at most this many snapshots lists them (default 12)
  /** Where the position is, for expanding the path to it: a snapshot index
   *  when the position sits on a snapshot, else a time. */
  currentIndex?: number;
  currentTime?: number;
}

/**
 * Build the grouped timeline over all snapshots and events. The returned
 * root covers the whole recorded range; its children are the top-level
 * bands. Returns null with no snapshots.
 */
export function buildTimeline(
  snapshots: TimelineSnapshot[],
  events: TimelineEvent[],
  opts: BuildTimelineOptions = {}
): TimelineGroup | null {
  if (snapshots.length === 0) return null;
  const maxGroups = opts.maxGroups ?? 10;
  const leafMax = opts.leafMax ?? 12;
  const sorted = [...snapshots].sort((a, b) => a.seq - b.seq);
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);
  const items = interleave(sorted, sortedEvents);

  const currentIndex = opts.currentIndex ?? -1;
  const currentTime = opts.currentTime;
  const holdsCurrent = (rows: TimelineItem[], t0: number, t1: number, top: boolean): boolean => {
    if (currentIndex >= 0) {
      return rows.some(r => r.kind === 'snapshot' && r.snapshot.index === currentIndex);
    }
    if (currentTime === undefined) return false;
    return currentTime >= t0 && (top ? currentTime <= t1 : currentTime < t1);
  };

  const build = (rows: TimelineItem[], t0: number, t1: number, span: number, top: boolean): TimelineGroup => {
    const snaps = rows.filter(r => r.kind === 'snapshot');
    const evs = rows.filter((r): r is Extract<TimelineItem, { kind: 'event' }> => r.kind === 'event').map(r => r.event);
    const group: TimelineGroup = {
      tStart: t0, tEnd: t1, span,
      snapshotCount: snaps.length,
      events: evs,
      children: null, items: null,
      containsCurrent: holdsCurrent(rows, t0, t1, top),
    };
    if (snaps.length <= leafMax) {
      group.items = rows;
      return group;
    }
    // Cut on the finest round interval that fits maxGroups bands
    const times = snaps.map(r => (r as Extract<TimelineItem, { kind: 'snapshot' }>).snapshot.simTime);
    const lo = Math.min(...times);
    const hi = Math.max(...times);
    const childSpan = chooseSpan(lo, hi, maxGroups);
    // Bands must be finer than the parent's own cut, else recursion stalls
    // (all snapshots inside one interval - e.g. hundreds in the same 10 ms)
    if (!(childSpan < span) || hi - lo < 1e-9) {
      group.items = rows;
      return group;
    }
    // Assign rows to bands by the snapshot they belong to; an event goes
    // with the snapshot that follows it (the first state that has it)
    const bands = new Map<number, TimelineItem[]>();
    let pendingEvents: TimelineItem[] = [];
    for (const r of rows) {
      if (r.kind === 'event') { pendingEvents.push(r); continue; }
      const key = Math.floor(r.snapshot.simTime / childSpan + 1e-9);
      let band = bands.get(key);
      if (!band) { band = []; bands.set(key, band); }
      band.push(...pendingEvents, r);
      pendingEvents = [];
    }
    if (pendingEvents.length > 0) {
      // Events after the last snapshot: they belong to the last band
      const lastKey = Math.max(...bands.keys());
      bands.get(lastKey)!.push(...pendingEvents);
    }
    const keys = [...bands.keys()].sort((a, b) => a - b);
    group.children = keys.map(k => build(bands.get(k)!, k * childSpan, (k + 1) * childSpan, childSpan, false));
    return group;
  };

  const t0 = sorted[0].simTime;
  const t1 = sorted[sorted.length - 1].simTime;
  return build(items, t0, t1, Infinity, true);
}

/** Compact clock label for band boundaries: 12.5 s, 3:05, 1:02:33. */
export function formatBandTime(seconds: number, span: number): string {
  if (span < 1) {
    const decimals = span < 0.01 ? 3 : span < 0.1 ? 2 : 1;
    return `${seconds.toFixed(decimals)} s`;
  }
  if (seconds < 60 && span < 60) return `${Math.round(seconds)} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Icon per event type for headers and rows. */
export function eventIcon(type: string): string {
  switch (type) {
    case 'component-burst': return '💥';
    case 'scram': return '🛑';
    case 'scram-reset': return '🟢';
    case 'scenario': return '📜';
    case 'shake': return '🌍';
    case 'washed-away': return '🌊';
    case 'simulation-error': return '⚠️';
    case 'rebuild': return '🔧';
    default: return '•';
  }
}
