/**
 * Main Solver with Adaptive Timestep and Operator Splitting
 *
 * The solver advances the simulation state through time using explicit
 * integration with operator splitting. Each physics domain (neutronics,
 * heat transfer, fluid flow) is handled by a separate operator.
 *
 * Adaptive timestep ensures stability while performance monitoring
 * warns if we can't keep up with real time.
 */

import { SimulationState, SolverMetrics } from './types';

// ============================================================================
// Physics Operator Interface
// ============================================================================

export interface PhysicsOperator {
  /** Human-readable name for profiling */
  name: string;

  /**
   * Apply this physics operator to advance the state by dt.
   * Returns the updated state (should not mutate input).
   */
  apply(state: SimulationState, dt: number): SimulationState;

  /**
   * Estimate the maximum stable timestep for this operator.
   * Returns Infinity if no constraint.
   */
  getMaxStableDt(state: SimulationState): number;

  /**
   * Optional: number of subcycles to use within this operator.
   * Default is 1 (no subcycling).
   */
  getSubcycleCount?(state: SimulationState, dt: number): number;
}

// ============================================================================
// Solver Configuration
// ============================================================================

export interface SolverConfig {
  // Timestep bounds
  minDt: number;              // s - absolute minimum timestep
  maxDt: number;              // s - maximum timestep
  targetDt: number;           // s - preferred timestep when stable

  // Adaptive timestep parameters
  safetyFactor: number;       // Multiply max stable dt by this (e.g., 0.9)
  dtGrowthRate: number;       // Max factor to increase dt per step (e.g., 1.2)
  dtShrinkRate: number;       // Factor to decrease dt on instability (e.g., 0.5)

  // Pressure-based adaptive timestep (PI controller style)
  pressureChangeTarget: number;  // Target max relative pressure change per step (e.g., 0.05 = 5%)
  pressureChangeMax: number;     // Reject step if pressure change exceeds this (e.g., 0.15 = 15%)

  // Flow rate change limits (absolute change relative to a reference flow)
  // For flow rates, we use absolute change since flows can be near zero
  flowChangeTarget: number;      // Target max flow change per step (kg/s)
  flowChangeMax: number;         // Reject step if flow change exceeds this (kg/s)

  // Mass change limits (relative change in node mass)
  // This catches cases where flows are accumulating mass imbalance
  massChangeTarget: number;      // Target max relative mass change per step (e.g., 0.02 = 2%)
  massChangeMax: number;         // Reject step if mass change exceeds this (e.g., 0.05 = 5%)

  maxRetries: number;            // Max retries per step before accepting anyway

  // Performance monitoring
  realTimeWarningThreshold: number;  // Warn if ratio falls below this (e.g., 0.9)
  metricsWindowSize: number;         // Number of steps to average over

  // Safeguards
  maxSubcyclesPerFrame: number;      // Prevent infinite subcycling
  maxWallTimePerFrame: number;       // ms - bail out if taking too long
}

const DEFAULT_CONFIG: SolverConfig = {
  minDt: 1e-6,                // 1 microsecond
  maxDt: 0.1,                 // 100 ms
  targetDt: 0.01,             // 10 ms

  safetyFactor: 0.8,
  dtGrowthRate: 1.1,
  dtShrinkRate: 0.5,

  // Pressure-based adaptive timestep
  // Target 5% pressure change - this gives headroom before we hit problems
  // Reject at 15% - this catches instabilities before they cascade
  pressureChangeTarget: 0.05,
  pressureChangeMax: 0.15,

  // Flow rate change limits
  // For a typical PWR with ~5000 kg/s flow, we want to limit changes per step
  // Target 500 kg/s change, reject at 1500 kg/s
  flowChangeTarget: 500,
  flowChangeMax: 1500,

  // Mass change limits
  // These catch the cumulative effect of flow imbalances
  // Target 2% mass change per step, reject at 5%
  massChangeTarget: 0.02,
  massChangeMax: 0.05,

  maxRetries: 3,

  realTimeWarningThreshold: 0.95,
  metricsWindowSize: 60,

  maxSubcyclesPerFrame: 500,  // Don't let subcycles run away
  maxWallTimePerFrame: 100,   // Bail out after 100ms
};

// ============================================================================
// Main Solver Class
// ============================================================================

export class Solver {
  private operators: PhysicsOperator[] = [];
  private config: SolverConfig;
  private metrics: SolverMetrics;

  // Rolling window for performance averaging
  private wallTimeHistory: number[] = [];
  private simTimeHistory: number[] = [];

  // Adaptive timestep state
  private adaptiveDt: number;
  private consecutiveSuccesses: number = 0;

  constructor(config: Partial<SolverConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.adaptiveDt = this.config.targetDt;

    this.metrics = {
      lastStepWallTime: 0,
      avgStepWallTime: 0,
      currentDt: this.config.targetDt,
      minDtUsed: this.config.targetDt,
      subcycleCount: 0,
      totalSteps: 0,
      retriesThisFrame: 0,
      maxPressureChange: 0,
      maxFlowChange: 0,
      maxMassChange: 0,
      consecutiveSuccesses: 0,
      realTimeRatio: 1.0,
      isFallingBehind: false,
      fallingBehindSince: -1,
      operatorTimes: new Map(),
    };
  }

  /**
   * Register a physics operator. Order matters - operators are applied
   * in the order they're added.
   */
  addOperator(operator: PhysicsOperator): void {
    this.operators.push(operator);
    this.metrics.operatorTimes.set(operator.name, 0);
  }

  /**
   * Advance the simulation by the requested time interval.
   * Uses adaptive timestep with pressure-based retry logic.
   *
   * @param state Current simulation state
   * @param requestedDt Time to advance (s) - typically frame time * sim speed
   * @returns New simulation state and metrics
   */
  advance(state: SimulationState, requestedDt: number): {
    state: SimulationState;
    metrics: SolverMetrics;
  } {
    const frameStartWall = performance.now();

    let currentState = state;
    let remainingTime = requestedDt;
    let totalSubcycles = 0;
    let totalRetries = 0;
    let maxPressureChangeThisFrame = 0;
    let maxFlowChangeThisFrame = 0;
    let maxMassChangeThisFrame = 0;

    // Reset per-frame operator timing
    for (const op of this.operators) {
      this.metrics.operatorTimes.set(op.name, 0);
    }

    let bailedOut = false;

    // Take steps until we've covered the requested time
    while (remainingTime > 1e-10) {
      // SAFEGUARD: Check if we've exceeded time/subcycle limits
      const elapsedWall = performance.now() - frameStartWall;
      if (elapsedWall > this.config.maxWallTimePerFrame) {
        bailedOut = true;
        break;
      }
      if (totalSubcycles > this.config.maxSubcyclesPerFrame) {
        bailedOut = true;
        break;
      }

      // Use adaptive timestep, bounded by remaining time and config limits
      const maxStableDt = this.computeMaxStableDt(currentState);
      let stepDt = Math.min(
        this.adaptiveDt,
        remainingTime,
        this.config.maxDt,
        maxStableDt * this.config.safetyFactor
      );
      stepDt = Math.max(stepDt, this.config.minDt);

      // Try-reject-retry loop for this step
      let stepAccepted = false;
      let retriesThisStep = 0;

      while (!stepAccepted && retriesThisStep <= this.config.maxRetries) {
        // Capture pre-step state for comparison
        const prePressures = this.capturePressures(currentState);
        const preFlows = this.captureFlows(currentState);
        const preMasses = this.captureMasses(currentState);

        // Apply all operators to get trial state
        let trialState = currentState;
        for (const op of this.operators) {
          const opStart = performance.now();

          let subcycles = op.getSubcycleCount?.(trialState, stepDt) ?? 1;
          subcycles = Math.min(subcycles, 100);
          const subDt = stepDt / subcycles;

          for (let i = 0; i < subcycles; i++) {
            trialState = op.apply(trialState, subDt);
            totalSubcycles++;
          }

          const opTime = performance.now() - opStart;
          this.metrics.operatorTimes.set(
            op.name,
            (this.metrics.operatorTimes.get(op.name) ?? 0) + opTime
          );
        }

        // Check pressure, flow, and mass changes
        const pressureChange = this.computeMaxPressureChange(prePressures, trialState);
        const flowChange = this.computeMaxFlowChange(preFlows, trialState);
        const massChange = this.computeMaxMassChange(preMasses, trialState);

        // Compute normalized change factors (how far over target are we?)
        const pressureOvershoot = pressureChange / this.config.pressureChangeMax;
        const flowOvershoot = flowChange / this.config.flowChangeMax;
        const massOvershoot = massChange / this.config.massChangeMax;

        // Reject if any limit exceeded
        const shouldReject = (pressureOvershoot > 1 || flowOvershoot > 1 || massOvershoot > 1) && retriesThisStep < this.config.maxRetries;

        if (shouldReject) {
          // Reject step - state changed too much
          // Shrink timestep and retry
          retriesThisStep++;
          totalRetries++;

          // PI-style control: shrink proportionally to the worst overshoot
          const worstOvershoot = Math.max(pressureOvershoot, flowOvershoot, massOvershoot);
          const shrinkFactor = Math.max(
            this.config.dtShrinkRate,
            1 / worstOvershoot  // Shrink to get us back near the limit
          );
          stepDt *= shrinkFactor;
          stepDt = Math.max(stepDt, this.config.minDt);

          // Also update adaptive dt for future steps
          this.adaptiveDt = stepDt;
          this.consecutiveSuccesses = 0;

          // Don't count the subcycles from rejected step
          // (they were wasted computation)
        } else {
          // Accept step
          stepAccepted = true;
          currentState = trialState;
          currentState.time += stepDt;
          remainingTime -= stepDt;
          this.metrics.totalSteps++;

          maxPressureChangeThisFrame = Math.max(maxPressureChangeThisFrame, pressureChange);
          maxFlowChangeThisFrame = Math.max(maxFlowChangeThisFrame, flowChange);
          maxMassChangeThisFrame = Math.max(maxMassChangeThisFrame, massChange);

          // Adaptive dt growth logic - based on worst of pressure, flow, or mass
          const pressureMargin = pressureChange / this.config.pressureChangeTarget;
          const flowMargin = flowChange / this.config.flowChangeTarget;
          const massMargin = massChange / this.config.massChangeTarget;
          const worstMargin = Math.max(pressureMargin, flowMargin, massMargin);

          if (worstMargin < 0.5) {
            // Very stable step - we can grow dt faster
            this.consecutiveSuccesses++;

            // Grow dt after several consecutive successes
            if (this.consecutiveSuccesses >= 5) {
              const growthFactor = Math.min(
                this.config.dtGrowthRate,
                0.5 / Math.max(worstMargin, 0.01)  // Target 50% of limit
              );
              this.adaptiveDt = Math.min(
                this.adaptiveDt * growthFactor,
                this.config.maxDt
              );
            }
          } else if (worstMargin < 1.0) {
            // Good step - modest growth
            this.consecutiveSuccesses++;
            if (this.consecutiveSuccesses >= 10) {
              this.adaptiveDt = Math.min(
                this.adaptiveDt * 1.05,
                this.config.maxDt
              );
            }
          } else {
            // Step was accepted but changes were high
            // Don't grow dt, but don't shrink either (we accepted it)
            this.consecutiveSuccesses = 0;
          }
        }
      }

      // Sanitize state after each accepted step
      currentState = this.sanitizeState(currentState);
    }

    // If we bailed out, log what was happening (rate-limited)
    if (bailedOut && Math.random() < 0.01) {
      console.warn(`[Solver] Incomplete frame: covered ${((requestedDt - remainingTime) / requestedDt * 100).toFixed(1)}% of requested time`);
    }

    // Update timing metrics
    const frameWallTime = performance.now() - frameStartWall;
    this.metrics.retriesThisFrame = totalRetries;
    this.metrics.maxPressureChange = maxPressureChangeThisFrame;
    this.metrics.maxFlowChange = maxFlowChangeThisFrame;
    this.metrics.maxMassChange = maxMassChangeThisFrame;
    this.metrics.consecutiveSuccesses = this.consecutiveSuccesses;
    this.updateMetrics(frameWallTime, requestedDt - remainingTime, this.adaptiveDt, totalSubcycles, currentState.time);

    return {
      state: currentState,
      metrics: { ...this.metrics },
    };
  }

  /**
   * Capture current pressures from all flow nodes for comparison.
   */
  private capturePressures(state: SimulationState): Map<string, number> {
    const pressures = new Map<string, number>();
    for (const [id, node] of state.flowNodes) {
      pressures.set(id, node.fluid.pressure);
    }
    return pressures;
  }

  /**
   * Compute the maximum relative pressure change across all flow nodes.
   * Returns 0 if there are no flow nodes.
   */
  private computeMaxPressureChange(
    prePressures: Map<string, number>,
    postState: SimulationState
  ): number {
    let maxChange = 0;

    for (const [id, node] of postState.flowNodes) {
      const prePressure = prePressures.get(id);
      if (prePressure === undefined || prePressure === 0) continue;

      const postPressure = node.fluid.pressure;
      const relativeChange = Math.abs(postPressure - prePressure) / prePressure;

      if (relativeChange > maxChange) {
        maxChange = relativeChange;
      }
    }

    return maxChange;
  }

  /**
   * Capture current flow rates from all flow connections for comparison.
   */
  private captureFlows(state: SimulationState): Map<string, number> {
    const flows = new Map<string, number>();
    for (const conn of state.flowConnections) {
      flows.set(conn.id, conn.massFlowRate);
    }
    return flows;
  }

  /**
   * Compute the maximum absolute flow rate change across all flow connections.
   * Returns 0 if there are no connections.
   */
  private computeMaxFlowChange(
    preFlows: Map<string, number>,
    postState: SimulationState
  ): number {
    let maxChange = 0;

    for (const conn of postState.flowConnections) {
      const preFlow = preFlows.get(conn.id);
      if (preFlow === undefined) continue;

      const postFlow = conn.massFlowRate;
      const absoluteChange = Math.abs(postFlow - preFlow);

      if (absoluteChange > maxChange) {
        maxChange = absoluteChange;
      }
    }

    return maxChange;
  }

  /**
   * Capture current masses from all flow nodes for comparison.
   */
  private captureMasses(state: SimulationState): Map<string, number> {
    const masses = new Map<string, number>();
    for (const [id, node] of state.flowNodes) {
      masses.set(id, node.fluid.mass);
    }
    return masses;
  }

  /**
   * Compute the maximum relative mass change across all flow nodes.
   * Returns 0 if there are no flow nodes.
   */
  private computeMaxMassChange(
    preMasses: Map<string, number>,
    postState: SimulationState
  ): number {
    let maxChange = 0;

    for (const [id, node] of postState.flowNodes) {
      const preMass = preMasses.get(id);
      if (preMass === undefined || preMass === 0) continue;

      const postMass = node.fluid.mass;
      const relativeChange = Math.abs(postMass - preMass) / preMass;

      if (relativeChange > maxChange) {
        maxChange = relativeChange;
      }
    }

    return maxChange;
  }

  /**
   * Sanitize state to prevent NaN/Infinity from propagating
   */
  private sanitizeState(state: SimulationState): SimulationState {
    // Check and fix thermal nodes
    for (const [id, node] of state.thermalNodes) {
      if (!isFinite(node.temperature) || node.temperature < 0) {
        console.warn(`[Solver] Fixing invalid temperature in '${id}': ${node.temperature}`);
        node.temperature = 300;
      }
      node.temperature = Math.max(200, Math.min(node.temperature, 5000));
    }

    // Check and fix flow nodes
    for (const [id, node] of state.flowNodes) {
      if (!isFinite(node.fluid.temperature) || node.fluid.temperature < 0) {
        console.warn(`[Solver] Fixing invalid temperature in '${id}': ${node.fluid.temperature}`);
        node.fluid.temperature = 300;
      }
      if (!isFinite(node.fluid.mass) || node.fluid.mass <= 0) {
        console.warn(`[Solver] Fixing invalid mass in '${id}': ${node.fluid.mass}`);
        node.fluid.mass = 1000;
      }
      if (!isFinite(node.fluid.pressure) || node.fluid.pressure <= 0) {
        console.warn(`[Solver] Fixing invalid pressure in '${id}': ${node.fluid.pressure}`);
        node.fluid.pressure = 101325;
      }

      if (node.fluid.phase === 'two-phase') {
        node.fluid.quality = Math.max(0, Math.min(1, node.fluid.quality));
      }

      node.fluid.temperature = Math.max(250, Math.min(node.fluid.temperature, 2000));
      node.fluid.pressure = Math.max(1000, Math.min(node.fluid.pressure, 50e6));
      node.fluid.mass = Math.max(1, Math.min(node.fluid.mass, 1e8));
    }

    // Check and fix flow connections
    for (const conn of state.flowConnections) {
      if (!isFinite(conn.massFlowRate)) {
        console.warn(`[Solver] Fixing invalid flow rate in '${conn.id}': ${conn.massFlowRate}`);
        conn.massFlowRate = 0;
      }
      conn.massFlowRate = Math.max(-1e5, Math.min(conn.massFlowRate, 1e5));
    }

    // Check neutronics
    if (!isFinite(state.neutronics.power) || state.neutronics.power < 0) {
      console.warn(`[Solver] Fixing invalid power: ${state.neutronics.power}`);
      state.neutronics.power = 0;
    }
    if (!isFinite(state.neutronics.precursorConcentration) || state.neutronics.precursorConcentration < 0) {
      state.neutronics.precursorConcentration = 0.01;
    }

    return state;
  }

  /**
   * Query all operators for their stability constraints and return
   * the most restrictive one.
   */
  private computeMaxStableDt(state: SimulationState): number {
    let minDt = Infinity;

    for (const op of this.operators) {
      const opMaxDt = op.getMaxStableDt(state);
      if (opMaxDt < minDt) {
        minDt = opMaxDt;
      }
    }

    return minDt === Infinity ? this.config.maxDt : minDt;
  }

  /**
   * Update performance metrics and check for falling behind.
   */
  private updateMetrics(
    wallTimeMs: number,
    simTimeDelta: number,
    physicsDt: number,
    subcycles: number,
    currentSimTime: number
  ): void {
    this.metrics.lastStepWallTime = wallTimeMs;
    this.metrics.currentDt = physicsDt;
    this.metrics.subcycleCount = subcycles;

    // Track minimum dt used (indicator of stiffness)
    this.metrics.minDtUsed = Math.min(this.metrics.minDtUsed, physicsDt);

    // Update rolling averages
    this.wallTimeHistory.push(wallTimeMs);
    this.simTimeHistory.push(simTimeDelta);

    if (this.wallTimeHistory.length > this.config.metricsWindowSize) {
      this.wallTimeHistory.shift();
      this.simTimeHistory.shift();
    }

    // Compute average wall time
    const totalWall = this.wallTimeHistory.reduce((a, b) => a + b, 0);
    const totalSim = this.simTimeHistory.reduce((a, b) => a + b, 0);
    this.metrics.avgStepWallTime = totalWall / this.wallTimeHistory.length;

    // Real-time ratio: how many seconds of sim time per second of wall time
    // > 1 means we're faster than real time
    // < 1 means we're falling behind
    this.metrics.realTimeRatio = (totalSim * 1000) / totalWall;

    // Check if we're falling behind
    const wasFallingBehind = this.metrics.isFallingBehind;
    this.metrics.isFallingBehind = this.metrics.realTimeRatio < this.config.realTimeWarningThreshold;

    if (this.metrics.isFallingBehind && !wasFallingBehind) {
      // Just started falling behind
      this.metrics.fallingBehindSince = currentSimTime;
      console.warn(
        `[Solver] Falling behind real time! Ratio: ${this.metrics.realTimeRatio.toFixed(3)}, ` +
        `Avg step: ${this.metrics.avgStepWallTime.toFixed(2)}ms, ` +
        `Physics dt: ${(physicsDt * 1000).toFixed(3)}ms`
      );
      this.logOperatorBreakdown();
    } else if (!this.metrics.isFallingBehind && wasFallingBehind) {
      // Recovered
      this.metrics.fallingBehindSince = -1;
      console.log('[Solver] Recovered real-time performance');
    }
  }

  /**
   * Log breakdown of time spent in each operator (for debugging).
   */
  logOperatorBreakdown(): void {
    console.log('[Solver] Operator timing breakdown:');
    for (const [name, time] of this.metrics.operatorTimes) {
      console.log(`  ${name}: ${time.toFixed(2)}ms`);
    }
  }

  /**
   * Get current metrics (for UI display).
   */
  getMetrics(): SolverMetrics {
    return { ...this.metrics };
  }

  /**
   * Execute exactly one internal physics step using the current adaptive dt.
   * This is useful for debugging - it advances by the smallest stable increment
   * so you can watch the simulation evolve one tiny step at a time.
   *
   * @param state Current simulation state
   * @returns New simulation state, the dt that was used, and metrics
   */
  singleStep(state: SimulationState): {
    state: SimulationState;
    dt: number;
    metrics: SolverMetrics;
  } {
    const frameStartWall = performance.now();

    // Reset per-frame operator timing
    for (const op of this.operators) {
      this.metrics.operatorTimes.set(op.name, 0);
    }

    // Compute the timestep we'll use (same logic as advance())
    const maxStableDt = this.computeMaxStableDt(state);
    let stepDt = Math.min(
      this.adaptiveDt,
      this.config.maxDt,
      maxStableDt * this.config.safetyFactor
    );
    stepDt = Math.max(stepDt, this.config.minDt);

    // Capture pre-step state for comparison
    const prePressures = this.capturePressures(state);
    const preFlows = this.captureFlows(state);
    const preMasses = this.captureMasses(state);

    // Apply all operators (no subcycling - we want exactly one step)
    let newState = state;
    for (const op of this.operators) {
      const opStart = performance.now();
      newState = op.apply(newState, stepDt);
      const opTime = performance.now() - opStart;
      this.metrics.operatorTimes.set(
        op.name,
        (this.metrics.operatorTimes.get(op.name) ?? 0) + opTime
      );
    }

    // Advance time
    newState.time += stepDt;
    this.metrics.totalSteps++;

    // Compute changes for diagnostics
    const pressureChange = this.computeMaxPressureChange(prePressures, newState);
    const flowChange = this.computeMaxFlowChange(preFlows, newState);
    const massChange = this.computeMaxMassChange(preMasses, newState);

    // Update adaptive dt based on changes (same logic as advance())
    const pressureOvershoot = pressureChange / this.config.pressureChangeMax;
    const flowOvershoot = flowChange / this.config.flowChangeMax;
    const massOvershoot = massChange / this.config.massChangeMax;
    const worstOvershoot = Math.max(pressureOvershoot, flowOvershoot, massOvershoot);

    if (worstOvershoot > 1) {
      // Step was too big - shrink for next time
      const shrinkFactor = Math.max(
        this.config.dtShrinkRate,
        1 / worstOvershoot
      );
      this.adaptiveDt = Math.max(stepDt * shrinkFactor, this.config.minDt);
      this.consecutiveSuccesses = 0;
    } else if (worstOvershoot < 0.5) {
      // Step was very stable - can grow dt
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= 5) {
        this.adaptiveDt = Math.min(this.adaptiveDt * this.config.dtGrowthRate, this.config.maxDt);
      }
    }

    // Sanitize state
    newState = this.sanitizeState(newState);

    // Update metrics
    const frameWallTime = performance.now() - frameStartWall;
    this.metrics.lastStepWallTime = frameWallTime;
    this.metrics.currentDt = stepDt;
    this.metrics.subcycleCount = 1;
    this.metrics.maxPressureChange = pressureChange;
    this.metrics.maxFlowChange = flowChange;
    this.metrics.maxMassChange = massChange;
    this.metrics.consecutiveSuccesses = this.consecutiveSuccesses;
    this.metrics.retriesThisFrame = 0;

    return {
      state: newState,
      dt: stepDt,
      metrics: { ...this.metrics },
    };
  }

  /**
   * Reset the minimum dt tracker (call after major state changes).
   */
  resetMinDtTracking(): void {
    this.metrics.minDtUsed = this.config.targetDt;
  }
}

// ============================================================================
// Helper: Deep clone simulation state
// ============================================================================

export function cloneSimulationState(state: SimulationState): SimulationState {
  return {
    time: state.time,

    thermalNodes: new Map(
      Array.from(state.thermalNodes.entries()).map(([k, v]) => [k, { ...v }])
    ),

    flowNodes: new Map(
      Array.from(state.flowNodes.entries()).map(([k, v]) => [
        k,
        { ...v, fluid: { ...v.fluid } },
      ])
    ),

    thermalConnections: state.thermalConnections.map(c => ({ ...c })),
    convectionConnections: state.convectionConnections.map(c => ({ ...c })),
    flowConnections: state.flowConnections.map(c => ({ ...c })),

    neutronics: { ...state.neutronics },

    components: {
      pumps: new Map(
        Array.from(state.components.pumps.entries()).map(([k, v]) => [k, { ...v }])
      ),
      valves: new Map(
        Array.from(state.components.valves.entries()).map(([k, v]) => [k, { ...v }])
      ),
    },

    // Clone energy diagnostics if present
    energyDiagnostics: state.energyDiagnostics ? {
      ...state.energyDiagnostics,
      heatTransferRates: new Map(state.energyDiagnostics.heatTransferRates),
    } : undefined,
  };
}
