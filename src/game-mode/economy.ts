/**
 * Career-mode economy: the ledger.
 *
 * - Construction: stock (level-provided) components are free. Player
 *   additions are priced by the overnight-cost estimator. BUILD takes out a
 *   loan for the whole player-added cost.
 * - Lock-in: after BUILD, changes are priced against the recorded paid
 *   prices - new component costs 110% (10% work fee), an edit pays
 *   max(0, newCost - paid) + 10% fee, a deletion refunds 75% of what was
 *   paid. Downgrades refund nothing (the todo-list rules).
 * - Operation: revenue = generator power x price x time; interest accrues
 *   continuously on the loan principal; burst components are charged a 25%
 *   repair fee when the player comes back for an outage.
 *
 * All rates are per SIM time - running the plant at 100x earns (and owes
 * interest) 100x faster per wall-clock second. That is the game: time is
 * only dangerous when the plant is.
 */

import { estimatePlantComponentCost } from '../construction/cost-estimation';

const WORK_FEE = 0.10;          // installer's margin on post-BUILD changes
const DELETE_REFUND = 0.75;     // salvage value of removed equipment
const REPAIR_FRACTION = 0.25;   // fixing a burst component vs buying new

const HOURS_PER_YEAR = 8760;

/**
 * Fiscal compression: one sim-minute books one fiscal day of revenue and
 * interest. Real plant economics run on decades; levels run on minutes.
 * Objectives (MWh delivered, MWe held) stay in TRUE simulation units - only
 * the dollars are compressed, uniformly, so "does this plant make money?"
 * has the same answer it would at 1:1. The boss puts it differently:
 * "around here, a minute's a day."
 */
export const FISCAL_COMPRESSION = 1440;

/** Price one plant component (0 for barrel-type children priced with parent). */
export function componentPrice(component: Record<string, any>): number {
  const est = estimatePlantComponentCost(component);
  return est ? est.total : 0;
}

export interface LedgerSnapshot {
  cash: number;
  loan: number;
  revenue: number;        // lifetime revenue this level
  interestPaid: number;   // lifetime interest this level
  repairsPaid: number;
  energyMWh: number;      // lifetime energy delivered
  price: number;          // current $/MWh
}

export class Ledger {
  cash: number;
  loan = 0;
  revenue = 0;
  interestPaid = 0;
  repairsPaid = 0;
  energyMWh = 0;

  private apr: number;
  private basePrice: number;
  /** price multiplier from events (spike/crash), decays back to 1 */
  private priceEventFactor = 1;
  private priceEventUntil = 0; // sim time when the factor expires

  /** component id -> price actually paid (stock components are 0) */
  paidPrices = new Map<string, number>();
  /** ids provided free by the level */
  stockIds = new Set<string>();
  /** ids already charged a repair fee this outage cycle */
  private repairedIds = new Set<string>();

  constructor(startingCash: number, apr: number, basePowerPrice: number) {
    this.cash = startingCash;
    this.apr = apr;
    this.basePrice = basePowerPrice;
  }

  /** Electricity price at a sim time: day/night sine +-25%, plus event factor. */
  priceAt(simTime: number): number {
    // Peak demand mid-fiscal-afternoon, trough pre-dawn. With fiscal
    // compression, one demand day passes per sim hour.
    const dayFraction = (simTime / 3600) % 1;
    const daily = 1 + 0.25 * Math.sin((dayFraction - 0.25) * 2 * Math.PI);
    const factor = simTime < this.priceEventUntil ? this.priceEventFactor : 1;
    return this.basePrice * daily * factor;
  }

  applyPriceEvent(simTime: number, factor: number, durationSeconds: number): void {
    this.priceEventFactor = factor;
    this.priceEventUntil = simTime + durationSeconds;
  }

  /**
   * Advance the books by dt sim-seconds: revenue from the generator, interest
   * on the loan. Call once per accepted sim update with electric watts.
   */
  accrue(simTime: number, dt: number, electricWatts: number): void {
    if (dt <= 0) return;
    const mwh = Math.max(0, electricWatts) * dt / 3.6e9; // W*s -> MWh (true sim energy)
    const sale = mwh * this.priceAt(simTime) * FISCAL_COMPRESSION;
    this.revenue += sale;
    this.energyMWh += mwh;
    this.cash += sale;

    const fiscalHours = dt * FISCAL_COMPRESSION / 3600;
    const interest = this.loan * this.apr * fiscalHours / HOURS_PER_YEAR;
    this.interestPaid += interest;
    this.cash -= interest;
  }

  /** Player-added overnight cost of the current design (pre-BUILD pricing). */
  designCost(components: Map<string, Record<string, any>>): number {
    let total = 0;
    for (const [id, comp] of components) {
      if (this.stockIds.has(id)) continue;
      total += componentPrice(comp);
    }
    return total;
  }

  /** First BUILD: take the loan for everything the player added. */
  build(components: Map<string, Record<string, any>>): number {
    const cost = this.designCost(components);
    this.loan += cost;
    this.paidPrices.clear();
    for (const [id, comp] of components) {
      this.paidPrices.set(id, this.stockIds.has(id) ? 0 : componentPrice(comp));
    }
    return cost;
  }

  /**
   * Price the pending outage changes without applying them.
   * Also lists them for the confirmation UI.
   */
  outageQuote(components: Map<string, Record<string, any>>): {
    total: number;
    items: Array<{ label: string; amount: number }>;
  } {
    const items: Array<{ label: string; amount: number }> = [];
    let total = 0;

    for (const [id, comp] of components) {
      const paid = this.paidPrices.get(id);
      const nowPrice = componentPrice(comp);
      if (paid === undefined) {
        // brand new during outage: full price + work fee
        const amount = nowPrice * (1 + WORK_FEE);
        if (amount > 0) {
          items.push({ label: `Install ${comp.label || id}`, amount });
          total += amount;
        }
      } else if (nowPrice > paid + 1) {
        // upgraded: pay the difference + work fee (stock upgrades pay from $0 base)
        const amount = (nowPrice - paid) * (1 + WORK_FEE);
        items.push({ label: `Upgrade ${comp.label || id}`, amount });
        total += amount;
      }
      // downgrades: no refund, and the paid price stays (rules are rules)
    }

    for (const [id, paid] of this.paidPrices) {
      if (!components.has(id) && paid > 0) {
        const refund = paid * DELETE_REFUND;
        items.push({ label: `Salvage (75%)`, amount: -refund });
        total -= refund;
      }
    }

    return { total, items };
  }

  /** Apply the outage changes: adjust loan, rebuild the paid-price book. */
  applyOutage(components: Map<string, Record<string, any>>): number {
    const { total } = this.outageQuote(components);
    this.loan += total;
    if (this.loan < 0) this.loan = 0;
    const newPaid = new Map<string, number>();
    for (const [id, comp] of components) {
      const prev = this.paidPrices.get(id);
      const nowPrice = componentPrice(comp);
      if (prev === undefined) {
        newPaid.set(id, nowPrice);
      } else {
        // paid price ratchets up on upgrades, never down
        newPaid.set(id, Math.max(prev, nowPrice));
      }
    }
    this.paidPrices = newPaid;
    this.repairedIds.clear();
    return total;
  }

  /**
   * Charge repairs for components that burst during the last run. Idempotent
   * per outage (a component is only billed once until the next BUILD).
   * Returns the itemized charges for the UI.
   */
  chargeRepairs(
    burstComponents: Array<{ id: string; label: string }>,
    components: Map<string, Record<string, any>>
  ): Array<{ label: string; amount: number }> {
    const items: Array<{ label: string; amount: number }> = [];
    for (const { id, label } of burstComponents) {
      if (this.repairedIds.has(id)) continue;
      const comp = components.get(id);
      if (!comp) continue; // deleted - salvage rules already applied
      this.repairedIds.add(id);
      const amount = componentPrice(comp) * REPAIR_FRACTION;
      if (amount > 0) {
        items.push({ label: `Repair ${label}`, amount });
        this.cash -= amount;
        this.repairsPaid += amount;
      }
    }
    return items;
  }

  snapshot(simTime: number): LedgerSnapshot {
    return {
      cash: this.cash,
      loan: this.loan,
      revenue: this.revenue,
      interestPaid: this.interestPaid,
      repairsPaid: this.repairsPaid,
      energyMWh: this.energyMWh,
      price: this.priceAt(simTime),
    };
  }
}
