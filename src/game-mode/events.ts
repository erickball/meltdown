/**
 * RandomEventEngine: decides WHEN trouble happens; the manager decides WHAT
 * that means physically (it owns the simulation hooks).
 *
 * Random events are poisson-timed after a warmup. Scripted events fire once,
 * at a uniformly random time inside their window. Timing is in sim time of
 * the current operation run (each outage resets the run clock, and scripted
 * events that already fired stay fired for the level).
 */

import { EventScheduleDef, GameEventKind } from './types';

export class RandomEventEngine {
  private nextRandomAt = Infinity;
  private scriptedAt: Array<{ kind: GameEventKind; at: number; fired: boolean }> = [];
  private armed = false;

  constructor(private schedule: EventScheduleDef, private rng: () => number = Math.random) {}

  /** Called at the start of an operation run (sim clock starts at ~0). */
  arm(alreadyFired: Set<GameEventKind>): void {
    this.armed = true;
    this.scheduleNextRandom(this.schedule.warmupSeconds);
    this.scriptedAt = (this.schedule.scripted ?? [])
      .filter(s => !alreadyFired.has(s.kind))
      .map(s => ({
        kind: s.kind,
        at: s.earliestSeconds + this.rng() * (s.latestSeconds - s.earliestSeconds),
        fired: false,
      }));
  }

  disarm(): void {
    this.armed = false;
  }

  /**
   * A scripted event fired but couldn't be applied (e.g. a pump-trip with no
   * running pumps). Put it back on the schedule a little later instead of
   * consuming its one shot - scripted events are guarantees, not attempts.
   */
  defer(kind: GameEventKind, simTime: number, delaySeconds = 60): void {
    const slot = this.scriptedAt.find(s => s.kind === kind && s.fired);
    if (slot) {
      slot.fired = false;
      slot.at = simTime + delaySeconds;
    }
  }

  /**
   * Poll for due events. Returns the kinds that should fire now (usually 0-1).
   * `generating` gates random events: nothing randomly breaks while the plant
   * is shut down and dark - misery needs an audience.
   */
  poll(simTime: number, generating: boolean): GameEventKind[] {
    if (!this.armed) return [];
    const due: GameEventKind[] = [];

    for (const s of this.scriptedAt) {
      if (!s.fired && simTime >= s.at) {
        s.fired = true;
        due.push(s.kind);
      }
    }

    if (simTime >= this.nextRandomAt) {
      if (generating && this.schedule.pool.length > 0) {
        due.push(this.pickWeighted());
      }
      this.scheduleNextRandom(simTime);
    }

    return due;
  }

  private scheduleNextRandom(fromTime: number): void {
    const mean = this.schedule.meanIntervalSeconds;
    if (!isFinite(mean) || !isFinite(fromTime)) {
      this.nextRandomAt = Infinity;
      return;
    }
    // exponential inter-arrival
    this.nextRandomAt = fromTime + -Math.log(1 - this.rng()) * mean;
  }

  private pickWeighted(): GameEventKind {
    const total = this.schedule.pool.reduce((s, e) => s + e.weight, 0);
    let r = this.rng() * total;
    for (const e of this.schedule.pool) {
      r -= e.weight;
      if (r <= 0) return e.kind;
    }
    return this.schedule.pool[this.schedule.pool.length - 1].kind;
  }
}
