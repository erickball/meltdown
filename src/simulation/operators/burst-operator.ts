/**
 * Burst Check Operator
 *
 * Checks all pressurized components for overpressure conditions and initiates/updates bursts.
 * Components burst when gauge pressure (relative to container) exceeds their burst threshold.
 *
 * Key mechanics:
 * - Burst pressure = design rating + random 0-40% margin (calculated at sim start)
 * - Break size scales with overpressure: 1% at burst, ~20% at 1.5x burst, cap at 100%
 * - Breaks can only grow, not shrink
 * - Break connections are bidirectional to container (or atmosphere if no container)
 * - HX tubes burst based on pressure differential vs shell side
 */

import {
  SimulationState,
  FlowNode,
  BurstState,
  BurstConfig,
  DEFAULT_BURST_CONFIG,
} from '../types';
import { ConstraintOperator } from '../rk45-solver';
import { cloneSimulationState } from '../solver';

/**
 * Deterministic pseudo-random number generator.
 * Returns a value between 0 and 1 based on the seed.
 */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Calculate break fraction based on overpressure ratio.
 *
 * Uses quadratic interpolation from minBreak at burst pressure
 * to maxBreak at (1 + fullBreakOverpressure) * burstPressure.
 * Includes deterministic random variation based on seed.
 *
 * The quadratic curve gives:
 * - Slow initial growth right at burst pressure
 * - Accelerating growth as overpressure increases
 */
function calculateBreakFraction(
  currentPressure: number,
  burstPressure: number,
  config: BurstConfig,
  randomSeed: number
): number {
  if (currentPressure <= burstPressure) return 0;

  // Overpressure ratio: 0 at burst, fullBreakOverpressure at design max
  const ratio = (currentPressure - burstPressure) / burstPressure;
  const t = Math.min(1, ratio / config.fullBreakOverpressure);

  // Quadratic growth: slow start, accelerates with overpressure
  const baseFraction = config.minBreakFraction +
    (config.maxBreakFraction - config.minBreakFraction) * t * t;

  // Apply deterministic random variation
  // The seed varies slightly with ratio to give different random factors at different pressures
  const randomFactor = 1 + (seededRandom(randomSeed + ratio * 1000) - 0.5) * 2 * config.breakSizeRandomness;

  return Math.min(config.maxBreakFraction, Math.max(0, baseFraction * randomFactor));
}

/**
 * Checks all pressurized components for burst conditions.
 * Creates/updates break connections when components burst.
 */
export class BurstCheckOperator implements ConstraintOperator {
  name = 'BurstCheck';

  applyConstraints(state: SimulationState): SimulationState {
    // If no burst states are configured, nothing to do
    if (!state.burstStates || state.burstStates.size === 0) {
      return state;
    }

    const newState = cloneSimulationState(state);
    const config = newState.burstConfig ?? DEFAULT_BURST_CONFIG;

    // Safety check after clone (burstStates should be preserved)
    if (!newState.burstStates) {
      return newState;
    }

    for (const [nodeId, burstState] of newState.burstStates) {
      const node = newState.flowNodes.get(nodeId);
      if (!node) continue;

      // Calculate effective (gauge) pressure relative to container
      const effectivePressure = this.getEffectivePressure(node, burstState, newState);

      // Check for new burst
      if (!burstState.isBurst && effectivePressure > burstState.burstPressure) {
        this.initiateBurst(burstState, effectivePressure, newState, config);
      }

      // Update break size for existing bursts (can grow with increasing pressure)
      if (burstState.isBurst) {
        this.updateBreakSize(burstState, effectivePressure, newState, config);
      }
    }

    return newState;
  }

  /**
   * Calculate effective pressure for burst comparison.
   * Always uses gauge pressure relative to the container.
   *
   * For HX tube side: compare to shell pressure
   * For all other components: compare to container pressure (or atmosphere if no container)
   */
  private getEffectivePressure(
    node: FlowNode,
    burstState: BurstState,
    state: SimulationState
  ): number {
    const absolutePressure = node.fluid.pressure;

    // For HX tube side, compare to shell pressure (tube is "inside" the shell)
    if (burstState.isTubeSide && burstState.shellNodeId) {
      const shell = state.flowNodes.get(burstState.shellNodeId);
      if (shell) {
        // Tubes can burst in either direction if pressure differential exceeds rating
        return Math.abs(absolutePressure - shell.fluid.pressure);
      }
    }

    // For all other components, use gauge pressure relative to container
    if (node.containerId) {
      const container = state.flowNodes.get(node.containerId);
      if (container) {
        return absolutePressure - container.fluid.pressure;
      }
    }

    // If no container, gauge pressure vs atmosphere (1 atm)
    return absolutePressure - 101325;
  }

  /**
   * Initiate a new burst event.
   */
  private initiateBurst(
    burstState: BurstState,
    pressure: number,
    state: SimulationState,
    config: BurstConfig
  ): void {
    burstState.isBurst = true;
    burstState.burstTime = state.time;

    // For pipes, assign random break location along the length
    if (burstState.breakLocation === undefined) {
      burstState.breakLocation = Math.random();
    }

    // Calculate initial break fraction
    burstState.currentBreakFraction = calculateBreakFraction(
      pressure,
      burstState.burstPressure,
      config,
      burstState.breakSizeSeed
    );

    // Create break flow connection
    this.createBreakConnection(burstState, state, config);

    // Queue event for GameLoop to emit
    if (!state.pendingEvents) state.pendingEvents = [];
    state.pendingEvents.push({
      type: 'component-burst',
      message: `LOCA: ${burstState.componentLabel} ruptured at ${(pressure / 1e5).toFixed(1)} bar gauge (burst threshold: ${(burstState.burstPressure / 1e5).toFixed(1)} bar)`,
      data: {
        nodeId: burstState.nodeId,
        componentId: burstState.componentId,
        pressure: pressure,
        burstPressure: burstState.burstPressure,
        breakFraction: burstState.currentBreakFraction,
      },
    });

    console.log(
      `[BurstCheck] BURST: ${burstState.componentLabel} at t=${state.time.toFixed(2)}s, ` +
      `P=${(pressure / 1e5).toFixed(1)} bar gauge, break=${(burstState.currentBreakFraction * 100).toFixed(1)}%`
    );
  }

  /**
   * Create a break flow connection from the burst node to its container.
   */
  private createBreakConnection(
    burstState: BurstState,
    state: SimulationState,
    config: BurstConfig
  ): void {
    const node = state.flowNodes.get(burstState.nodeId);
    if (!node) return;

    // Determine discharge target - always the container
    let targetNodeId: string;
    if (burstState.isTubeSide && burstState.shellNodeId) {
      // Tube rupture goes to shell side (the "container" for tubes)
      targetNodeId = burstState.shellNodeId;
    } else if (node.containerId) {
      // Contained component breaks to container
      targetNodeId = node.containerId;
    } else {
      // Uncontained component breaks to atmosphere
      targetNodeId = 'atmosphere';
    }

    const breakConnId = `break-${burstState.nodeId}`;

    // Check if break connection already exists (shouldn't happen on first burst)
    let breakConn = state.flowConnections.find(c => c.id === breakConnId);

    if (!breakConn) {
      // Calculate break area based on node's flow area
      const breakArea = node.flowArea * burstState.currentBreakFraction;

      breakConn = {
        id: breakConnId,
        fromNodeId: burstState.nodeId,
        toNodeId: targetNodeId,
        flowArea: breakArea,
        hydraulicDiameter: Math.sqrt(4 * breakArea / Math.PI),
        length: 0.1,                         // Short path for break
        elevation: 0,                        // Assumes break is at node midpoint
        resistanceCoeff: 2.0,                // Sharp-edged orifice
        massFlowRate: 0,
        isBreakConnection: true,
        burstSourceNodeId: burstState.nodeId,
        breakFraction: burstState.currentBreakFraction,
        breakDischargeCoeff: config.breakDischargeCoeff,
      };
      state.flowConnections.push(breakConn);
    }
  }

  /**
   * Update break size for an already-burst component.
   * Breaks can grow if pressure continues to increase, but cannot shrink.
   */
  private updateBreakSize(
    burstState: BurstState,
    pressure: number,
    state: SimulationState,
    config: BurstConfig
  ): void {
    const newBreakFraction = calculateBreakFraction(
      pressure,
      burstState.burstPressure,
      config,
      burstState.breakSizeSeed
    );

    // Break can only grow, not shrink
    if (newBreakFraction > burstState.currentBreakFraction) {
      const oldFraction = burstState.currentBreakFraction;
      burstState.currentBreakFraction = newBreakFraction;

      // Update break connection flow area
      const breakConnId = `break-${burstState.nodeId}`;
      const breakConn = state.flowConnections.find(c => c.id === breakConnId);
      if (breakConn) {
        const node = state.flowNodes.get(burstState.nodeId);
        if (node) {
          const breakArea = node.flowArea * burstState.currentBreakFraction;
          breakConn.flowArea = breakArea;
          breakConn.hydraulicDiameter = Math.sqrt(4 * breakArea / Math.PI);
          breakConn.breakFraction = burstState.currentBreakFraction;
        }
      }

      // Log significant break growth
      if (newBreakFraction - oldFraction > 0.05) {
        console.log(
          `[BurstCheck] Break grew: ${burstState.componentLabel} ` +
          `${(oldFraction * 100).toFixed(1)}% → ${(newBreakFraction * 100).toFixed(1)}%`
        );
      }
    }
  }
}
