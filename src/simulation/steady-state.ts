/**
 * SteadyStateDetector - decides whether the plant has converged to a steady
 * operating state.
 *
 * Fed with accepted simulation states (any cadence), it tracks smoothed
 * SIGNED normalized drift rates:
 *   - per flow node:   dm/dt / m          (1/s)
 *   - per flow node:   dT/dt              (K/s)
 *   - per flow node:   dP/dt / max(P, 1 bar)  (1/s)
 *   - reactor power:   dP/dt / P_nominal  (1/s)
 *
 * Rates are smoothed SIGNED with an exponential moving average (time
 * constant `windowSeconds`): bounded oscillation (a dome-edge pump body's
 * pressure flicker, boiling chugging, controller dither) averages to ~zero,
 * while genuine monotonic drift does not. The plant is "steady" once every
 * smoothed rate magnitude has stayed below its tolerance for `holdSeconds`.
 *
 * Used by regression tests (assert a preset converges), and intended for the
 * future "wait for a random initiating event once steady" and "test design
 * before build" features.
 */

import { SimulationState } from './types';

export interface SteadyStateConfig {
  /** EWMA smoothing time constant (s) */
  windowSeconds: number;
  /** Tolerance for fractional rates: mass, pressure, power (1/s) */
  fractionalRateTol: number;
  /** Tolerance for temperature drift (K/s) */
  temperatureRateTol: number;
  /** How long all rates must stay in tolerance before declaring steady (s) */
  holdSeconds: number;
}

export const DEFAULT_STEADY_STATE_CONFIG: SteadyStateConfig = {
  windowSeconds: 20,
  fractionalRateTol: 1e-3,   // 0.1%/s
  temperatureRateTol: 0.05,  // K/s
  holdSeconds: 60,
};

interface NodeSnapshot {
  mass: number;
  temperature: number;
  pressure: number;
}

export class SteadyStateDetector {
  private config: SteadyStateConfig;

  private lastTime: number | null = null;
  private lastNodes = new Map<string, NodeSnapshot>();
  private lastPower: number | null = null;

  /** Smoothed normalized rates, keyed by metric name */
  private smoothed = new Map<string, number>();
  /** Sim time since which all smoothed rates have been within tolerance */
  private steadySince: number | null = null;
  private currentTime = 0;

  constructor(config: Partial<SteadyStateConfig> = {}) {
    this.config = { ...DEFAULT_STEADY_STATE_CONFIG, ...config };
  }

  reset(): void {
    this.lastTime = null;
    this.lastNodes.clear();
    this.lastPower = null;
    this.smoothed.clear();
    this.steadySince = null;
  }

  /** Feed an accepted simulation state. Call with monotonically increasing time. */
  update(state: SimulationState): void {
    this.currentTime = state.time;
    const dt = this.lastTime === null ? 0 : state.time - this.lastTime;

    if (dt > 0) {
      const alpha = Math.min(1, dt / this.config.windowSeconds);
      const ewma = (key: string, value: number) => {
        const prev = this.smoothed.get(key);
        this.smoothed.set(key, prev === undefined ? value : prev + alpha * (value - prev));
      };

      let maxVolume = 0;
      for (const [, node] of state.flowNodes) {
        if (!node.isBoundary) maxVolume = Math.max(maxVolume, node.volume);
      }

      for (const [id, node] of state.flowNodes) {
        if (node.isBoundary) continue;
        const prev = this.lastNodes.get(id);
        if (!prev) continue;
        ewma(`${id}.mass`, (node.fluid.mass - prev.mass) / (Math.max(node.fluid.mass, 1) * dt));
        ewma(`${id}.temp`, (node.fluid.temperature - prev.temperature) / dt);
        // Pressure drift, volume-weighted. Per-node inventory drift is
        // already covered by the mass/temperature metrics; what pressure
        // drift adds is STORED-ENERGY drift, which scales with node volume.
        // Without the weighting, tiny saturated pump bodies - whose pressure
        // is pinned to P_sat and hops across the dome edge forever - would
        // read as perpetual "drift" that says nothing about the plant.
        const volumeWeight = maxVolume > 0 ? node.volume / maxVolume : 1;
        ewma(`${id}.pressure`,
          (volumeWeight * (node.fluid.pressure - prev.pressure)) /
          (Math.max(node.fluid.pressure, 1e6) * dt));
      }

      if (state.neutronics.nominalPower > 0 && this.lastPower !== null) {
        ewma('reactor.power',
          (state.neutronics.power - this.lastPower) / (state.neutronics.nominalPower * dt));
      }

      // Verdict for this instant
      if (this.allWithinTolerance()) {
        if (this.steadySince === null) this.steadySince = state.time;
      } else {
        this.steadySince = null;
      }
    }

    // Snapshot for next update
    this.lastTime = state.time;
    this.lastPower = state.neutronics.nominalPower > 0 ? state.neutronics.power : null;
    for (const [id, node] of state.flowNodes) {
      if (node.isBoundary) continue;
      this.lastNodes.set(id, {
        mass: node.fluid.mass,
        temperature: node.fluid.temperature,
        pressure: node.fluid.pressure,
      });
    }
  }

  private tolFor(key: string): number {
    return key.endsWith('.temp') ? this.config.temperatureRateTol : this.config.fractionalRateTol;
  }

  private allWithinTolerance(): boolean {
    for (const [key, value] of this.smoothed) {
      if (Math.abs(value) > this.tolFor(key)) return false;
    }
    return this.smoothed.size > 0;
  }

  /** True once every smoothed drift rate has been in tolerance for holdSeconds. */
  isSteady(): boolean {
    return this.steadySince !== null && this.currentTime - this.steadySince >= this.config.holdSeconds;
  }

  /** Worst offender relative to its tolerance - the "why not steady yet" answer. */
  worstOffender(): { metric: string; value: number; tolerance: number } | null {
    let worst: { metric: string; value: number; tolerance: number } | null = null;
    let worstRatio = 0;
    for (const [key, value] of this.smoothed) {
      const tol = this.tolFor(key);
      const ratio = Math.abs(value) / tol;
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worst = { metric: key, value, tolerance: tol };
      }
    }
    return worst;
  }
}
