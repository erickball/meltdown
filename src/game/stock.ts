import type {
  ComponentType, Connection, PlantComponent, PlantState, PlantStock, WarehouseComponent,
} from '../types';

/**
 * THE parts-stock rules. Every path that places, connects, edits or deletes
 * anything goes through this module - the construction manager for components
 * and connections, main.ts for a connection whose length is edited - so there
 * is exactly one place that can spend or refund a part.
 *
 * The model:
 *  - A plant with NO warehouse has unlimited stock. Every existing design is
 *    that plant, and nothing about building in one changes.
 *  - A plant WITH a warehouse spends from `warehouse.stock`. Placing a
 *    component of type T takes 1 from `components[T]`; a connection or a pipe
 *    component takes its own `length` from `pipeMeters`. Deleting refunds the
 *    same amount, editing a connection's length pays (or is repaid) the delta.
 *  - Nothing is clamped and nothing is silently trimmed: a charge that cannot
 *    be paid is REFUSED, with the shortfall in the message. Stock reaching a
 *    negative number is a bug in a caller that spent without checking, so
 *    `spend` throws rather than letting it happen.
 *  - What is already standing in the plant when the level opens is not
 *    counted against the stock. The stock is simply what is LEFT; there is no
 *    attempt to reconstruct how the plant got there.
 *
 * Deliberate consequence: deleting a component refunds one of its type even
 * if the warehouse never stocked that type (the player salvaged it). That is
 * the same rule in both directions rather than a history the plant does not
 * keep.
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
  return warehouse.stock;
}

/** Metres of pipe left, or null when unlimited. */
export function pipeMetersRemaining(plant: PlantState): number | null {
  return getStock(plant)?.pipeMeters ?? null;
}

/** Units of `type` left, or null when unlimited. */
export function componentsRemaining(plant: PlantState, type: ComponentType): number | null {
  const stock = getStock(plant);
  if (!stock) return null;
  return stock.components[type] ?? 0;
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
};

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
  };
  const pair = names[type];
  return pair ? pair[plural ? 1 : 0] : type;
}

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

/** What a build costs the warehouse. `free` is a warehouse itself. */
export type StockCharge =
  | { kind: 'none' }
  | { kind: 'component'; type: ComponentType }
  | { kind: 'pipe'; metres: number };

export type StockResult = { ok: true } | { ok: false; reason: string };

const OK: StockResult = { ok: true };

/**
 * The charge for placing a component of this stored type with this length.
 * Pipe is measured, not counted - a pipe component and a connection are the
 * same commodity - and a warehouse costs nothing to put up (otherwise the
 * first thing a level hands the player would have to be a warehouse).
 */
export function chargeForComponent(type: ComponentType, lengthM?: number): StockCharge {
  if (type === 'warehouse') return { kind: 'none' };
  if (type === 'pipe') return { kind: 'pipe', metres: lengthM ?? 0 };
  return { kind: 'component', type };
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
    const have = stock.components[charge.type] ?? 0;
    if (have >= 1) return OK;
    return {
      ok: false,
      reason: `Warehouse has no more ${typeDisplayName(charge.type, true)}.`,
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
    stock.components[charge.type] = (stock.components[charge.type] ?? 0) - 1;
  } else {
    stock.pipeMeters -= charge.metres;
  }
  assertNonNegative(plant);
}

/** Put a charge back on the shelf (a deletion, or an edit that shortens a run). */
export function refund(plant: PlantState, charge: StockCharge): void {
  const stock = getStock(plant);
  if (!stock || charge.kind === 'none') return;
  if (charge.kind === 'component') {
    stock.components[charge.type] = (stock.components[charge.type] ?? 0) + 1;
  } else {
    stock.pipeMeters += charge.metres;
  }
  assertNonNegative(plant);
}

/** No pile is ever allowed to go below zero. */
function assertNonNegative(plant: PlantState): void {
  const stock = getStock(plant);
  if (!stock) return;
  if (!(stock.pipeMeters >= 0)) {
    throw new Error(`[Stock] Pipe stock went to ${stock.pipeMeters} m. ` +
      `A charge was spent without being checked first.`);
  }
  for (const [type, count] of Object.entries(stock.components)) {
    if (!(count! >= 0)) {
      throw new Error(`[Stock] ${type} stock went to ${count}. ` +
        `A charge was spent without being checked first.`);
    }
  }
}

// ---------------------------------------------------------------------------
// The two composite operations the UI needs
// ---------------------------------------------------------------------------

/**
 * Everything a component deletion puts back: the component itself (a pipe by
 * its length, anything else by one of its type), plus every connection that
 * goes away with it. Sub-components that came free with the parent (a reactor
 * vessel's core barrel) are not refunded - they were never charged.
 */
export function refundDeletedComponent(
  plant: PlantState,
  component: PlantComponent,
  removedConnections: Connection[]
): void {
  if (!getStock(plant)) return;
  refund(plant, chargeForComponent(
    component.type,
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

/** Stocked types with a count above zero, in a stable display order. */
export function stockedComponentTypes(stock: PlantStock): Array<[ComponentType, number]> {
  return (Object.entries(stock.components) as Array<[ComponentType, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
}

/** One-line summary for the info panel / label: "412 m pipe, 2 pumps, 1 valve". */
export function describeStock(stock: PlantStock): string {
  const parts = [`${formatMetres(stock.pipeMeters)} m pipe`];
  for (const [type, count] of stockedComponentTypes(stock)) {
    parts.push(`${count} ${typeDisplayName(type, count !== 1)}`);
  }
  return parts.join(', ');
}
