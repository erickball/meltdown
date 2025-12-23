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
// Solver Profiling
// ============================================================================

export interface SolverProfile {
  totalFrameTime: number;       // Total wall time for advance()
  operatorApplyTime: number;    // Time in operator.apply() calls
  captureStateTime: number;     // Time capturing pressures/flows/masses
  compareStateTime: number;     // Time computing changes
  maxStableDtTime: number;      // Time computing max stable dt
  sanitizeTime: number;         // Time in sanitizeState
  cloneStateTime: number;       // Time in cloneSimulationState
  otherTime: number;            // Unaccounted time
  frameCount: number;           // Number of frames profiled
}

let solverProfile: SolverProfile = {
  totalFrameTime: 0,
  operatorApplyTime: 0,
  captureStateTime: 0,
  compareStateTime: 0,
  maxStableDtTime: 0,
  sanitizeTime: 0,
  cloneStateTime: 0,
  otherTime: 0,
  frameCount: 0,
};

// Track clone time separately since it's called from operators
let cloneTimeAccumulator = 0;

export function getCloneTimeAccumulator(): number {
  return cloneTimeAccumulator;
}

export function addCloneTime(ms: number): void {
  cloneTimeAccumulator += ms;
}

export function getSolverProfile(): SolverProfile {
  return { ...solverProfile };
}

export function resetSolverProfile(): void {
  solverProfile = {
    totalFrameTime: 0,
    operatorApplyTime: 0,
    captureStateTime: 0,
    compareStateTime: 0,
    maxStableDtTime: 0,
    sanitizeTime: 0,
    cloneStateTime: 0,
    otherTime: 0,
    frameCount: 0,
  };
  cloneTimeAccumulator = 0;
}

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
  maxDt: 0.025,               // 25 ms - pressure-flow coupling needs smaller steps
  targetDt: 0.0005,           // 0.5 ms - start small and grow if stable

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

  // Cache for maxStableDt - recomputed once per frame or on rejection
  private cachedMaxStableDt: number = Infinity;
  private maxStableDtValid: boolean = false;

  // Rate limiting for diagnostic messages
  private lastDiagnosticTime: number = 0;

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

    // Profiling accumulators for this frame
    let captureTime = 0;
    let compareTime = 0;
    let maxDtTime = 0;
    let sanitizeTime = 0;
    let operatorTime = 0;

    // Reset clone time accumulator at start of frame
    cloneTimeAccumulator = 0;

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

    // Invalidate maxStableDt cache at start of frame - will recompute on first use
    this.maxStableDtValid = false;

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

      // Use cached maxStableDt - only recompute once per frame or after rejection
      let maxStableDt: number;
      if (this.maxStableDtValid) {
        maxStableDt = this.cachedMaxStableDt;
      } else {
        const t0 = performance.now();
        maxStableDt = this.computeMaxStableDt(currentState);
        maxDtTime += performance.now() - t0;
        this.cachedMaxStableDt = maxStableDt;
        this.maxStableDtValid = true;
      }

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
        const t1 = performance.now();
        const prePressures = this.capturePressures(currentState);
        const preFlows = this.captureFlows(currentState);
        const preMasses = this.captureMasses(currentState);
        captureTime += performance.now() - t1;

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
          operatorTime += opTime;
          this.metrics.operatorTimes.set(
            op.name,
            (this.metrics.operatorTimes.get(op.name) ?? 0) + opTime
          );
        }

        // Check pressure, flow, and mass changes
        const t2 = performance.now();
        const pressureChange = this.computeMaxPressureChange(prePressures, trialState);
        const flowChange = this.computeMaxFlowChange(preFlows, trialState);
        const massChange = this.computeMaxMassChange(preMasses, trialState);
        compareTime += performance.now() - t2;

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

          // Log when we shrink to very small timesteps
          if (stepDt < 0.00002) { // < 0.02ms
            console.warn(`[Solver] Step REJECTED - shrinking timestep to ${(stepDt * 1000).toFixed(3)}ms`);
            console.warn(`  Pressure change: ${(pressureChange * 100).toFixed(1)}% (limit: ${(this.config.pressureChangeMax * 100).toFixed(0)}%)`);

            // Show which node had the pressure problem
            const pressureInfo = (this as any).lastWorstPressureNode;
            if (pressureInfo && pressureInfo.nodeId) {
              const preBar = pressureInfo.prePressure / 1e5;
              const postBar = pressureInfo.postPressure / 1e5;
              console.warn(`    Node: ${pressureInfo.nodeId} - ${preBar.toFixed(1)}bar → ${postBar.toFixed(1)}bar`);
            }

            console.warn(`  Flow change: ${flowChange.toFixed(0)} kg/s (limit: ${this.config.flowChangeMax})`);

            // Show which connection had the flow problem
            const flowInfo = (this as any).lastWorstFlowConn;
            if (flowInfo && flowInfo.connId) {
              console.warn(`    Connection: ${flowInfo.connId} - ${flowInfo.preFlow.toFixed(0)} → ${flowInfo.postFlow.toFixed(0)} kg/s`);
            }

            console.warn(`  Mass change: ${(massChange * 100).toFixed(1)}% (limit: ${(this.config.massChangeMax * 100).toFixed(0)}%)`);
            console.warn(`  Worst overshoot: ${worstOvershoot.toFixed(2)}x limit`);
          }

          // Invalidate maxStableDt cache - state has changed significantly
          this.maxStableDtValid = false;

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
      const t3 = performance.now();
      currentState = this.sanitizeState(currentState);
      sanitizeTime += performance.now() - t3;
    }

    // If we bailed out, log what was happening (rate-limited)
    if (bailedOut && Math.random() < 0.01) {
      console.warn(`[Solver] Incomplete frame: covered ${((requestedDt - remainingTime) / requestedDt * 100).toFixed(1)}% of requested time`);
    }

    // Update timing metrics
    const frameWallTime = performance.now() - frameStartWall;

    // Update solver profile
    solverProfile.totalFrameTime += frameWallTime;
    solverProfile.operatorApplyTime += operatorTime;
    solverProfile.captureStateTime += captureTime;
    solverProfile.compareStateTime += compareTime;
    solverProfile.maxStableDtTime += maxDtTime;
    solverProfile.sanitizeTime += sanitizeTime;
    solverProfile.cloneStateTime += cloneTimeAccumulator;
    // Other time is what's not accounted for
    const accountedTime = operatorTime + captureTime + compareTime + maxDtTime + sanitizeTime;
    solverProfile.otherTime += (frameWallTime - accountedTime);
    solverProfile.frameCount++;
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
    let worstNodeId = '';
    let worstPrePressure = 0;
    let worstPostPressure = 0;

    for (const [id, node] of postState.flowNodes) {
      const prePressure = prePressures.get(id);
      if (prePressure === undefined || prePressure === 0) continue;

      const postPressure = node.fluid.pressure;
      const relativeChange = Math.abs(postPressure - prePressure) / prePressure;

      if (relativeChange > maxChange) {
        maxChange = relativeChange;
        worstNodeId = id;
        worstPrePressure = prePressure;
        worstPostPressure = postPressure;
      }
    }

    // Store for diagnostic use
    (this as any).lastWorstPressureNode = {
      nodeId: worstNodeId,
      prePressure: worstPrePressure,
      postPressure: worstPostPressure,
      change: maxChange
    };

    return maxChange;
  }

  /**
   * Capture current flow rates from all flow connections for comparison.
   * Captures both actual flow and target flow (if available).
   */
  private captureFlows(state: SimulationState): Map<string, { actual: number; target: number }> {
    const flows = new Map<string, { actual: number; target: number }>();
    for (const conn of state.flowConnections) {
      flows.set(conn.id, {
        actual: conn.massFlowRate,
        target: conn.targetFlowRate ?? conn.massFlowRate,
      });
    }
    return flows;
  }

  /**
   * Compute the maximum flow rate change across all flow connections.
   * Checks both actual flow change AND target flow change.
   * Target flow oscillation is a leading indicator of pressure-flow instability.
   * Returns 0 if there are no connections.
   */
  private computeMaxFlowChange(
    preFlows: Map<string, { actual: number; target: number }>,
    postState: SimulationState
  ): number {
    let maxChange = 0;
    let worstConnId = '';
    let worstPreFlow = 0;
    let worstPostFlow = 0;

    for (const conn of postState.flowConnections) {
      const pre = preFlows.get(conn.id);
      if (pre === undefined) continue;

      // Check actual flow change
      const postActual = conn.massFlowRate;
      const actualChange = Math.abs(postActual - pre.actual);

      // Check target flow change - this catches instability before it manifests
      // in actual flow (due to relaxation damping)
      const postTarget = conn.targetFlowRate ?? conn.massFlowRate;
      const targetChange = Math.abs(postTarget - pre.target);

      // Use the larger of the two as the "effective" flow change
      // Target changes are weighted at 10% since they're damped by relaxation
      // but still indicate potential instability
      const effectiveChange = Math.max(actualChange, targetChange * 0.1);

      if (effectiveChange > maxChange) {
        maxChange = effectiveChange;
        worstConnId = conn.id;
        worstPreFlow = pre.actual;
        worstPostFlow = postActual;
      }
    }

    // Store for diagnostic use
    (this as any).lastWorstFlowConn = {
      connId: worstConnId,
      preFlow: worstPreFlow,
      postFlow: worstPostFlow,
      change: maxChange
    };

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
    let limitingOperator = '';

    for (const op of this.operators) {
      const opMaxDt = op.getMaxStableDt(state);
      if (opMaxDt < minDt) {
        minDt = opMaxDt;
        limitingOperator = op.name;
      }
    }

    // Diagnostics for very small timesteps (rate-limited to once per second)
    if (minDt < 0.00002) { // < 0.02 ms
      const now = Date.now();
      if (now - this.lastDiagnosticTime > 1000) { // Only show once per second
        this.lastDiagnosticTime = now;

        console.warn(`\n${'='.repeat(50)}`);
        console.warn(`SMALL TIMESTEP DETECTED!`);
        console.warn(`${'='.repeat(50)}`);
        console.warn(`Timestep: ${(minDt * 1000).toFixed(3)}ms`);
        console.warn(`Limited by: ${limitingOperator}`);
        console.warn(`${'='.repeat(50)}`);

        // Get details from the limiting operator
        for (const op of this.operators) {
          if (op.name === limitingOperator) {
            // Add operator-specific diagnostics
            if (op.name === 'FluidFlow') {
              this.diagnoseFlowTimestep(state, minDt);
            } else if (op.name === 'Neutronics') {
              this.diagnoseNeutronicsTimestep(state, minDt);
            } else if (op.name === 'Conduction') {
              this.diagnoseConductionTimestep(state, minDt);
            }
            break;
          }
        }
      } // Close rate-limiting if
    }

    return minDt === Infinity ? this.config.maxDt : minDt;
  }

  /**
   * Diagnose what's causing small timesteps in flow operator
   */
  private diagnoseFlowTimestep(state: SimulationState, minDt: number): void {
    // Find the node with highest flow rate relative to mass
    let worstNode = '';
    let worstRatio = 0;
    let worstFlow = 0;

    for (const [nodeId, node] of state.flowNodes) {
      let totalInflow = 0;
      let totalOutflow = 0;

      for (const conn of state.flowConnections) {
        if (conn.fromNodeId === nodeId) {
          totalOutflow += Math.max(0, conn.massFlowRate);
        }
        if (conn.toNodeId === nodeId) {
          totalInflow += Math.max(0, conn.massFlowRate);
        }
        // Handle reverse flows
        if (conn.fromNodeId === nodeId && conn.massFlowRate < 0) {
          totalInflow += Math.abs(conn.massFlowRate);
        }
        if (conn.toNodeId === nodeId && conn.massFlowRate < 0) {
          totalOutflow += Math.abs(conn.massFlowRate);
        }
      }

      const totalFlow = Math.max(totalInflow, totalOutflow);
      const ratio = totalFlow / node.fluid.mass;

      if (ratio > worstRatio) {
        worstRatio = ratio;
        worstNode = nodeId;
        worstFlow = totalFlow;
      }
    }

    const worstNodeData = state.flowNodes.get(worstNode);
    if (worstNodeData) {
      console.log(`  FluidFlow limited by: ${worstNode}`);
      console.log(`    Mass: ${worstNodeData.fluid.mass.toFixed(1)}kg`);
      console.log(`    Flow: ${worstFlow.toFixed(1)}kg/s`);
      console.log(`    Residence time: ${(worstNodeData.fluid.mass / worstFlow).toFixed(4)}s`);
      console.log(`    Required dt: ${minDt.toFixed(6)}s`);
    }
  }

  /**
   * Diagnose what's causing small timesteps in neutronics
   */
  private diagnoseNeutronicsTimestep(state: SimulationState, minDt: number): void {
    const n = state.neutronics;
    const rho = n.reactivity;
    const beta = n.delayedNeutronFraction;
    const Lambda = n.promptNeutronLifetime;

    console.log(`  Neutronics limited by reactivity:`);
    console.log(`    Reactivity: ${(rho * 100000).toFixed(2)} pcm`);
    console.log(`    Beta: ${beta.toFixed(5)}`);
    console.log(`    Lambda: ${Lambda.toFixed(6)}s`);
    console.log(`    |ρ - β|: ${Math.abs(rho - beta).toFixed(6)}`);

    if (Math.abs(rho - beta) > 0.0001) {
      const promptPeriod = Lambda / Math.abs(rho - beta);
      console.log(`    Prompt period: ${promptPeriod.toFixed(6)}s`);
    }
    console.log(`    Required dt: ${minDt.toFixed(6)}s`);
  }

  /**
   * Diagnose what's causing small timesteps in heat conduction
   */
  private diagnoseConductionTimestep(state: SimulationState, minDt: number): void {
    // Find node with highest conductance to thermal capacitance ratio
    const conductanceMap = new Map<string, number>();

    for (const conn of state.thermalConnections) {
      conductanceMap.set(
        conn.fromNodeId,
        (conductanceMap.get(conn.fromNodeId) ?? 0) + conn.conductance
      );
      conductanceMap.set(
        conn.toNodeId,
        (conductanceMap.get(conn.toNodeId) ?? 0) + conn.conductance
      );
    }

    let worstNode = '';
    let worstRatio = 0;

    for (const [nodeId, totalCond] of conductanceMap) {
      const node = state.thermalNodes.get(nodeId);
      if (node && totalCond > 0) {
        const thermalCapacity = node.mass * node.specificHeat;
        const ratio = totalCond / thermalCapacity;

        if (ratio > worstRatio) {
          worstRatio = ratio;
          worstNode = nodeId;
        }
      }
    }

    const node = state.thermalNodes.get(worstNode);
    if (node) {
      console.log(`  Conduction limited by: ${worstNode}`);
      console.log(`    Temperature: ${(node.temperature - 273.15).toFixed(1)}°C`);
      console.log(`    Total conductance: ${conductanceMap.get(worstNode)?.toFixed(0)} W/K`);
      console.log(`    Thermal capacity: ${(node.mass * node.specificHeat).toFixed(0)} J/K`);
      console.log(`    Time constant: ${(1 / worstRatio).toFixed(6)}s`);
      console.log(`    Required dt: ${minDt.toFixed(6)}s`);
    }
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
  const t0 = performance.now();

  // Clone thermal nodes - use forEach instead of Array.from().map()
  const thermalNodes = new Map<string, typeof state.thermalNodes extends Map<string, infer V> ? V : never>();
  state.thermalNodes.forEach((v, k) => {
    thermalNodes.set(k, { ...v });
  });

  // Clone flow nodes with nested fluid object
  const flowNodes = new Map<string, typeof state.flowNodes extends Map<string, infer V> ? V : never>();
  state.flowNodes.forEach((v, k) => {
    flowNodes.set(k, { ...v, fluid: { ...v.fluid } });
  });

  // Clone arrays - preallocate for performance
  const thermalConnections = new Array(state.thermalConnections.length);
  for (let i = 0; i < state.thermalConnections.length; i++) {
    thermalConnections[i] = { ...state.thermalConnections[i] };
  }

  const convectionConnections = new Array(state.convectionConnections.length);
  for (let i = 0; i < state.convectionConnections.length; i++) {
    convectionConnections[i] = { ...state.convectionConnections[i] };
  }

  const flowConnections = new Array(state.flowConnections.length);
  for (let i = 0; i < state.flowConnections.length; i++) {
    flowConnections[i] = { ...state.flowConnections[i] };
  }

  // Clone component maps
  const pumps = new Map<string, typeof state.components.pumps extends Map<string, infer V> ? V : never>();
  state.components.pumps.forEach((v, k) => {
    pumps.set(k, { ...v });
  });

  const valves = new Map<string, typeof state.components.valves extends Map<string, infer V> ? V : never>();
  state.components.valves.forEach((v, k) => {
    valves.set(k, { ...v });
  });

  const checkValves = new Map<string, typeof state.components.checkValves extends Map<string, infer V> ? V : never>();
  if (state.components.checkValves) {
    state.components.checkValves.forEach((v, k) => {
      checkValves.set(k, { ...v });
    });
  }

  const result = {
    time: state.time,
    thermalNodes,
    flowNodes,
    thermalConnections,
    convectionConnections,
    flowConnections,
    neutronics: { ...state.neutronics },
    components: { pumps, valves, checkValves },
    // Clone energy diagnostics if present
    energyDiagnostics: state.energyDiagnostics ? {
      ...state.energyDiagnostics,
      heatTransferRates: new Map(state.energyDiagnostics.heatTransferRates),
    } : undefined,
    // Clone liquid base pressures (for debug display)
    liquidBasePressures: state.liquidBasePressures ? new Map(state.liquidBasePressures) : undefined,
  };

  addCloneTime(performance.now() - t0);
  return result;
}
