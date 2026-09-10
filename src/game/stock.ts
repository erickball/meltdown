import type {
  ComponentType, Connection, PlantComponent, PlantState, PlantStock, StockLine,
  WarehouseComponent,
} from '../types';
import { getPresetById, getPipeSpecById } from '../construction/component-presets';

/**
 * THE parts-stock rules. Every path that places, connects, edits or deletes
 * anything goes through this module - the construction manager for components
 * and connections, main.ts for a connection whose length is edited - so there
 * is exactly one place that can spend or refund a part.
 *
 * The model:
 *  - A plant with NO warehouse has unlimited stock. Every existing design is
 *    that plant, and nothing about building in one changes.
 *  - A plant WITH a warehouse spends from `warehouse.stock`, which is a list
 *    of LINES. A line names a stored ComponentType and, optionally, an
 *    equipment DESIGN (a preset id): `2 x Low-Pressure Service Water Pump` is
 *    a different line from `2 x Reactor Coolant Pump`, and a line with no
 *    design is generic - any design of that type comes off it.
 *  - Placing from a design line produces exactly that design; the placement
 *    dialog offers no design choice, because the part is already built and
 *    standing in the yard.
 *  - A connection or a pipe component takes its own `length` from
 *    `pipeMeters`, and when the yard names a `pipeSpec` that is the ONE line
 *    size it hands out. Deleting refunds the same amount, editing a
 *    connection's length pays (or is repaid) the delta.
 *  - Nothing is clamped and nothing is silently trimmed: a charge that cannot
 *    be paid is REFUSED, with the shortfall in the message. Stock reaching a
 *    negative number is a bug in a caller that spent without checking, so
 *    `spend` throws rather than letting it happen.
 *  - What is already standing in the plant when the level opens is not
 *    counted against the stock. The stock is simply what is LEFT; there is no
 *    attempt to reconstruct how the plant got there.
 *
 * Deliberate consequence: deleting a component refunds one of its line even
 * if the warehouse never stocked it (the player salvaged it). That is the
 * same rule in both directions rather than a history the plant does not keep.
 * A part carrying a design goes back to that design's line; a part carrying
 * none goes back to the generic line for its type.
 */

// ---------------------------------------------------------------------------
// Finding the warehouse
// ---------------------------------------------------------------------------

export function findWarehouse(plant: PlantState): WarehouseComponent | undefined {
  for (const component of plant.components.values()) {
    if (component.type === 'warehouse') return component as WarehouseComponent;
  }
  return undefined;
}

/**
 * The stock this plant builds from, or null when it is unlimited (no
 * warehouse). Callers must treat null as "no rule applies", never as empty.
 */
export function getStock(plant: PlantState): PlantStock | null {
  const warehouse = findWarehouse(plant);
  if (!warehouse) return null;
  if (!warehouse.stock) {
    throw new Error(
      `[Stock] Warehouse '${warehouse.id}' has no stock block. A warehouse always ` +
      `carries { pipeMeters, components } - a missing one would silently read as ` +
      `an empty yard and refuse every build.`);
  }
  migrateStock(warehouse);
  return warehouse.stock;
}

/**
 * Yards saved before designs existed keyed `components` as an object of
 * type -> count. Those become generic lines, once, with a loud note: the
 * alternative is a plant that silently reads as an empty yard and refuses
 * every build.
 */
function migrateStock(warehouse: WarehouseComponent): void {
  const stock = warehouse.stock as PlantStock & { components: unknown };
  if (Array.isArray(stock.components)) return;
  if (!stock.components || typeof stock.components !== 'object') {
    throw new Error(
      `[Stock] Warehouse '${warehouse.id}' has a stock block whose 'components' is ` +
      `${JSON.stringify(stock.components)}. It must be an array of ` +
      `{ type, design?, count } lines.`);
  }
  const legacy = stock.components as Partial<Record<ComponentType, number>>;
  const lines: StockLine[] = [];
  for (const [type, count] of Object.entries(legacy)) {
    lines.push({ type: type as ComponentType, count: count ?? 0 });
  }
  console.warn(
    `[Stock] Warehouse '${warehouse.id}' was saved with the old type-keyed stock ` +
    `block; its ${lines.length} pile(s) have been read as GENERIC lines (no ` +
    `equipment design). Re-save the plant to store them in the new form.`);
  stock.components = lines;
}

// ---------------------------------------------------------------------------
// Stock lines
// ---------------------------------------------------------------------------

/**
 * The identity of a line, for DOM ids, badge signatures and lookups. A design
 * line and the generic line of the same type are different piles, so they get
 * different keys.
 */
export function stockLineKey(type: ComponentType, design?: string): string {
  return design ? `${type}:${design}` : type;
}

/** The line for exactly this (type, design) pair, or undefined. */
export function findStockLine(
  stock: PlantStock, type: ComponentType, design?: string
): StockLine | undefined {
  return stock.components.find(l => l.type === type && (l.design ?? undefined) === (design ?? undefined));
}

/** Units of this exact (type, design) line left, or null when unlimited. */
export function componentsRemaining(
  plant: PlantState, type: ComponentType, design?: string
): number | null {
  const stock = getStock(plant);
  if (!stock) return null;
  return findStockLine(stock, type, design)?.count ?? 0;
}

/** Metres of pipe left, or null when unlimited. */
export function pipeMetersRemaining(plant: PlantState): number | null {
  return getStock(plant)?.pipeMeters ?? null;
}

/**
 * The one line size the yard hands out, or null when the plant is unlimited
 * or the yard's pipe is unspecified. The connection dialog shows this fixed
 * and lets only the route and length vary.
 */
export function stockedPipeSpecId(plant: PlantState): string | null {
  return getStock(plant)?.pipeSpec ?? null;
}

/** Lines with something left on them, in a stable display order. */
export function stockedLines(stock: PlantStock): StockLine[] {
  return stock.components
    .filter(l => l.count > 0)
    .slice()
    .sort((a, b) => (b.count - a.count) || stockLineKey(a.type, a.design).localeCompare(stockLineKey(b.type, b.design)));
}

// ---------------------------------------------------------------------------
// Palette keys -> stored component types
// ---------------------------------------------------------------------------

/**
 * The construction palette speaks in button keys ('check-valve', 'reactor-vessel')
 * while the plant stores ComponentTypes ('valve', 'reactorVessel'). Stock is
 * keyed by the STORED type, so the four valve buttons share one pile of valves
 * and a pressurizer spends a vessel.
 *
 * A key that is not here has no stored type this module can charge, and
 * `storedTypeForPaletteKey` says so loudly rather than guessing.
 */
const PALETTE_TO_STORED: Record<string, ComponentType> = {
  'tank': 'tank',
  'pressurizer': 'tank',      // a pressurizer IS a tank in the model

  'reactor-vessel': 'reactorVessel',
  'cross-vessel': 'crossVessel',
  'building': 'building',
  'pool': 'pool',
  'warehouse': 'warehouse',
  'pipe': 'pipe',
  'valve': 'valve',
  'check-valve': 'valve',
  'relief-valve': 'valve',
  'porv': 'valve',
  'pump': 'pump',
  'turbine-driven-pump': 'turbine-driven-pump',
  'heat-exchanger': 'heatExchanger',
  'condenser': 'condenser',
  'core': 'vessel',            // a standalone core is stored as a fuelled vessel
  'switchyard': 'switchyard',
  'turbine-generator': 'turbine-generator',
  'generator': 'tank',         // legacy: drawn differently, stored as a tank
  'scram-controller': 'controller',
  'pid-controller': 'controller',
  'bus': 'bus',
  'transformer': 'transformer',
  'breaker': 'breaker',
  'diesel-generator': 'diesel-generator',
  'battery': 'battery',
};

/**
 * The stored types a yard can hold a line of, in palette order. A warehouse
 * is not stockable (putting one up costs nothing) and pipe is measured in
 * metres rather than counted, so neither appears.
 */
export const STOCKABLE_TYPES: ComponentType[] = Array.from(
  new Set(Object.values(PALETTE_TO_STORED))
).filter(t => t !== 'warehouse' && t !== 'pipe');

export function storedTypeForPaletteKey(paletteKey: string): ComponentType {
  const stored = PALETTE_TO_STORED[paletteKey];
  if (!stored) {
    throw new Error(
      `[Stock] No stored component type is known for palette key '${paletteKey}'. ` +
      `Add it to PALETTE_TO_STORED in src/game/stock.ts - without it the warehouse ` +
      `cannot tell which pile the part comes out of.`);
  }
  return stored;
}

/**
 * The palette button (and componentDefinitions key) a line's parts are built
 * through. A design line follows its preset's own type, which is how a stock
 * line of check valves opens the check-valve form rather than the gate-valve
 * one; a generic line falls back to the first palette key that stores as this
 * type.
 *
 * Throws on a design id nothing knows: a level that names a design that has
 * been renamed must fail at the yard, not build a generic part quietly.
 */
export function paletteKeyForStockLine(line: StockLine): string {
  if (line.design) {
    const preset = getPresetById(line.design);
    if (!preset) {
      throw new Error(
        `[Stock] Warehouse line '${stockLineKey(line.type, line.design)}' names an ` +
        `equipment design '${line.design}' that does not exist in ` +
        `src/construction/component-presets.ts (or the saved custom designs).`);
    }
    const stored = storedTypeForPaletteKey(preset.type);
    if (stored !== line.type) {
      throw new Error(
        `[Stock] Warehouse line says type '${line.type}' but its design ` +
        `'${line.design}' builds a '${preset.type}' (stored as '${stored}'). ` +
        `The line and its design must agree, or the refund would go to another pile.`);
    }
    return preset.type;
  }
  for (const [paletteKey, stored] of Object.entries(PALETTE_TO_STORED)) {
    if (stored === line.type) return paletteKey;
  }
  throw new Error(
    `[Stock] No palette button builds a '${line.type}'. Add it to ` +
    `PALETTE_TO_STORED in src/game/stock.ts.`);
}

/** Human name for a type, for the refusal messages and the badges. */
export function typeDisplayName(type: ComponentType, plural = false): string {
  const names: Partial<Record<ComponentType, [string, string]>> = {
    'tank': ['tank', 'tanks'],   // pressurizers are stored as tanks too
    'pipe': ['pipe', 'pipe'],
    'pump': ['pump', 'pumps'],
    'vessel': ['vessel', 'vessels'],
    'reactorVessel': ['reactor vessel', 'reactor vessels'],
    'coreBarrel': ['core barrel', 'core barrels'],
    'valve': ['valve', 'valves'],
    'heatExchanger': ['heat exchanger', 'heat exchangers'],
    'turbine': ['turbine', 'turbines'],
    'turbine-generator': ['turbine-generator', 'turbine-generators'],
    'turbine-driven-pump': ['turbine-driven pump', 'turbine-driven pumps'],
    'condenser': ['condenser', 'condensers'],
    'fuelAssembly': ['fuel assembly', 'fuel assemblies'],
    'controller': ['controller', 'controllers'],
    'switchyard': ['switchyard', 'switchyards'],
    'building': ['building', 'buildings'],
    'crossVessel': ['cross-vessel', 'cross-vessels'],
    'pool': ['pool', 'pools'],
    'warehouse': ['warehouse', 'warehouses'],
    'bus': ['bus', 'buses'],
    'transformer': ['transformer', 'transformers'],
    'breaker': ['breaker', 'breakers'],
    'diesel-generator': ['diesel generator', 'diesel generators'],
    'battery': ['battery', 'batteries'],
  };
  const pair = names[type];
  return pair ? pair[plural ? 1 : 0] : type;
}

/**
 * What a line is called on a button, in the yard drawing and in a refusal:
 * the design's own name when it has one ("Low-Pressure Service Water Pump"),
 * the generic type name otherwise. A design that has gone missing is named
 * loudly rather than silently reading as generic.
 */
export function stockLineDisplayName(
  type: ComponentType, design?: string, plural = false
): string {
  if (!design) return typeDisplayName(type, plural);
  const preset = getPresetById(design);
  if (!preset) return `${typeDisplayName(type, plural)} [UNKNOWN DESIGN '${design}']`;
  return preset.name;
}

/** The line size the yard hands out, named for a label or a tooltip. */
export function pipeSpecDisplayName(specId: string): string {
  return getPipeSpecById(specId)?.label ?? `UNKNOWN PIPE SPEC '${specId}'`;
}

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

/** What a build costs the warehouse. `none` is a warehouse itself. */
export type StockCharge =
  | { kind: 'none' }
  | { kind: 'component'; type: ComponentType; design?: string }
  | { kind: 'pipe'; metres: number };

export type StockResult = { ok: true } | { ok: false; reason: string };

const OK: StockResult = { ok: true };

/**
 * The charge for placing a component of this stored type and design with this
 * length. Pipe is measured, not counted - a pipe component and a connection
 * are the same commodity - and a warehouse costs nothing to put up (otherwise
 * the first thing a level hands the player would have to be a warehouse).
 */
export function chargeForComponent(
  type: ComponentType, design?: string, lengthM?: number
): StockCharge {
  if (type === 'warehouse') return { kind: 'none' };
  if (type === 'pipe') return { kind: 'pipe', metres: lengthM ?? 0 };
  return design ? { kind: 'component', type, design } : { kind: 'component', type };
}

/** The charge for a run of pipe of this length (a connection, or an auto-pipe). */
export function chargeForPipe(metres: number): StockCharge {
  return { kind: 'pipe', metres };
}

/**
 * Would this charge be paid? Unlimited stock always yes. Never mutates.
 */
export function checkCharge(plant: PlantState, charge: StockCharge): StockResult {
  const stock = getStock(plant);
  if (!stock || charge.kind === 'none') return OK;

  if (charge.kind === 'component') {
    const have = findStockLine(stock, charge.type, charge.design)?.count ?? 0;
    if (have >= 1) return OK;
    return {
      ok: false,
      reason: `Warehouse has no more ${stockLineDisplayName(charge.type, charge.design, true)}.`,
    };
  }

  // Pipe: a refund (negative metres) always goes through
  if (charge.metres <= 0) return OK;
  if (stock.pipeMeters >= charge.metres) return OK;
  const short = charge.metres - stock.pipeMeters;
  return {
    ok: false,
    reason: `Warehouse is ${formatMetres(short)} m short of pipe: ` +
      `${formatMetres(charge.metres)} m needed, ${formatMetres(stock.pipeMeters)} m in stock.`,
  };
}

/**
 * Spend a charge. Throws if it cannot be paid - `checkCharge` is the way to
 * ask; getting here with an unpayable charge means a caller skipped the check,
 * and a warehouse that has gone negative is worse than a loud stop.
 */
export function spend(plant: PlantState, charge: StockCharge): void {
  const stock = getStock(plant);
  if (!stock || charge.kind === 'none') return;
  const check = checkCharge(plant, charge);
  if (!check.ok) {
    throw new Error(
      `[Stock] Refused charge was spent anyway: ${check.reason} ` +
      `Check with checkCharge() before spending.`);
  }
  if (charge.kind === 'component') {
    findStockLine(stock, charge.type, charge.design)!.count -= 1;
  } else {
    stock.pipeMeters -= charge.metres;
  }
  assertNonNegative(plant);
}

/**
 * Put a charge back on the shelf (a deletion, or an edit that shortens a run).
 * A line the yard never stocked is created by the refund - the player
 * salvaged the part, and the plant keeps no history of where it came from.
 */
export function refund(plant: PlantState, charge: StockCharge): void {
  const stock = getStock(plant);
  if (!stock || charge.kind === 'none') return;
  if (charge.kind === 'component') {
    const line = findStockLine(stock, charge.type, charge.design);
    if (line) line.count += 1;
    else stock.components.push(charge.design
      ? { type: charge.type, design: charge.design, count: 1 }
      : { type: charge.type, count: 1 });
  } else {
    stock.pipeMeters += charge.metres;
  }
  assertNonNegative(plant);
}

/** No line is ever allowed to go below zero. */
function assertNonNegative(plant: PlantState): void {
  const stock = getStock(plant);
  if (!stock) return;
  if (!(stock.pipeMeters >= 0)) {
    throw new Error(`[Stock] Pipe stock went to ${stock.pipeMeters} m. ` +
      `A charge was spent without being checked first.`);
  }
  for (const line of stock.components) {
    if (!(line.count >= 0)) {
      throw new Error(`[Stock] ${stockLineKey(line.type, line.design)} stock went to ` +
        `${line.count}. A charge was spent without being checked first.`);
    }
  }
}

// ---------------------------------------------------------------------------
// The two composite operations the UI needs
// ---------------------------------------------------------------------------

/**
 * Everything a component deletion puts back: the component itself (a pipe by
 * its length, anything else by one of its line), plus every connection that
 * goes away with it. Sub-components that came free with the parent (a reactor
 * vessel's core barrel) are not refunded - they were never charged.
 *
 * The line is chosen by the design the component CARRIES, so a part built
 * from a yard line goes back to that line and a hand-configured one goes back
 * to the generic pile for its type.
 */
export function refundDeletedComponent(
  plant: PlantState,
  component: PlantComponent,
  removedConnections: Connection[]
): void {
  if (!getStock(plant)) return;
  refund(plant, chargeForComponent(
    component.type,
    component.design,
    component.type === 'pipe' ? (component as { length?: number }).length : undefined));
  for (const conn of removedConnections) refund(plant, chargeForPipe(conn.length ?? 0));
}

/**
 * Change a connection's length, paying (or being repaid) the difference.
 * Both the edit dialog in main.ts and the headless test drive this, so the
 * "edit adjusts by the delta" rule exists exactly once.
 *
 * Refusal leaves the connection untouched.
 */
export function applyConnectionLengthEdit(
  plant: PlantState,
  connection: Connection,
  newLength: number
): StockResult {
  const delta = newLength - (connection.length ?? 0);
  if (delta > 0) {
    const charge = chargeForPipe(delta);
    const check = checkCharge(plant, charge);
    if (!check.ok) return check;
    spend(plant, charge);
  } else if (delta < 0) {
    refund(plant, chargeForPipe(-delta));
  }
  connection.length = newLength;
  return OK;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Metres of pipe one drawn stick in the warehouse stands for. Purely a
 * DRAWING scale - nothing in the rules is quantised to it - chosen so a
 * few-hundred-metre yard reads as a countable stack rather than a smear.
 */
export const PIPE_METRES_PER_STICK = 20;

/**
 * Metres, trimmed: 412, 61.5, 10, 0.25. Trailing zeros are dropped so a round
 * number reads as one - "40 m in stock", not "40.0 m in stock".
 */
export function formatMetres(m: number): string {
  if (!isFinite(m)) return String(m);
  const a = Math.abs(m);
  const decimals = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return String(Number(m.toFixed(decimals)));
}

/** One-line summary for the info panel / label. */
export function describeStock(stock: PlantStock): string {
  const parts = [`${formatMetres(stock.pipeMeters)} m pipe`];
  for (const line of stockedLines(stock)) {
    parts.push(`${line.count} ${stockLineDisplayName(line.type, line.design, line.count !== 1)}`);
  }
  return parts.join(', ');
}
