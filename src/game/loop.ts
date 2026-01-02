/**
 * Game Loop
 *
 * Integrates the physics simulation with the rendering and UI.
 * Handles the main update cycle, simulation speed control, and
 * automatic slowdown during rapid transients.
 *
 * Supports two integration methods:
 * - 'euler': Traditional forward Euler with operator splitting 
 * - 'rk45': Dormand-Prince RK45 with embedded error estimation
 */

import {
  SimulationState,
  SolverMetrics,
  checkScramConditions,
  triggerScram,
  resetScram,
  // RK45 solver and operators
  RK45Solver,
  ConductionRateOperator,
  ConvectionRateOperator,
  HeatGenerationRateOperator,
  NeutronicsRateOperator,
  FlowRateOperator,
  FlowMomentumRateOperator,
  TurbineCondenserRateOperator,
  FluidStateConstraintOperator,
  FlowDynamicsConstraintOperator,
  PumpSpeedRateOperator,
} from '../simulation';
import type { ScramSetpoints } from '../simulation/operators/neutronics';
export type { ScramSetpoints } from '../simulation/operators/neutronics';

export type IntegrationMethod = 'euler' | 'rk45';

export interface GameLoopConfig {
  // Simulation speed (1.0 = real time)
  initialSimSpeed: number;
  maxSimSpeed: number;
  minSimSpeed: number;

  // Auto-slowdown during transients
  autoSlowdownEnabled: boolean;
  autoSlowdownThreshold: number; // Rate of change that triggers slowdown

  // Performance
  targetFrameRate: number;
  maxTimestep: number; // Maximum timestep in seconds

  // Integration method
  integrationMethod: IntegrationMethod;
}

const DEFAULT_CONFIG: GameLoopConfig = {
  initialSimSpeed: 1.0,
  maxSimSpeed: 100.0,
  minSimSpeed: 0.01,  // Allow 100x slower than real time

  autoSlowdownEnabled: true,
  autoSlowdownThreshold: 0.1, // 10% change per second triggers slowdown

  targetFrameRate: 60,
  maxTimestep: 0.5, // 500ms default as requested

  integrationMethod: 'rk45', // Default to 'rk45' to test
};

export type GameEventType =
  | 'scram'
  | 'scram-reset'
  | 'high-temperature'
  | 'low-flow'
  | 'phase-change'
  | 'falling-behind'
  | 'auto-slowdown';

export interface GameEvent {
  type: GameEventType;
  time: number;
  message: string;
  data?: Record<string, unknown>;
}

export class GameLoop {
  private rk45Solver: RK45Solver | null = null;
  private state: SimulationState;
  private config: GameLoopConfig;

  // Timing
  private lastFrameTime: number = 0;
  private simSpeed: number;
  private isPaused: boolean = false;
  private targetSimSpeed: number; // Speed before auto-slowdown

  // State tracking for auto-slowdown
  private previousPower: number = 0;
  private previousMaxTemp: number = 0;
  private cumulativePowerChange: number = 0;  // Accumulated change over measurement window
  private cumulativeTempChange: number = 0;
  private changeWindowTime: number = 0;       // Time accumulated in current window
  private readonly CHANGE_WINDOW: number = 1.0; // Measure changes over 1 second

  // Event system
  private eventListeners: Map<GameEventType, ((event: GameEvent) => void)[]> = new Map();
  private recentEvents: GameEvent[] = [];

  // Scram controller setpoints (undefined = manual scram only)
  private scramSetpoints: ScramSetpoints | undefined = undefined;

  // Callbacks
  public onStateUpdate?: (state: SimulationState, metrics: SolverMetrics) => void;
  public onEvent?: (event: GameEvent) => void;

  constructor(
    initialState: SimulationState,
    config: Partial<GameLoopConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = initialState;
    this.simSpeed = this.config.initialSimSpeed;
    this.targetSimSpeed = this.simSpeed;

    if (this.config.integrationMethod === 'rk45') {
      // Initialize RK45 solver with rate-based operators
      console.log('[GameLoop] Using RK45 integration method');
      this.rk45Solver = new RK45Solver({
        minDt: 1e-6,
        maxDt: this.config.maxTimestep,
        initialDt: 0.001,
        relTol: 1e-3,
        absTol: 1e-6,
      });

      // Add rate operators (compute derivatives)
      this.rk45Solver.addRateOperator(new FlowMomentumRateOperator()); // Flow momentum (dṁ/dt)
      this.rk45Solver.addRateOperator(new FlowRateOperator());          // Mass/energy transport
      this.rk45Solver.addRateOperator(new NeutronicsRateOperator());
      this.rk45Solver.addRateOperator(new HeatGenerationRateOperator());
      this.rk45Solver.addRateOperator(new ConductionRateOperator());
      this.rk45Solver.addRateOperator(new ConvectionRateOperator());
      this.rk45Solver.addRateOperator(new TurbineCondenserRateOperator());

      // Add pump speed rate operator (integrates pump ramp-up/coast-down)
      this.rk45Solver.addRateOperator(new PumpSpeedRateOperator());

      // Add constraint operators (enforce thermodynamic consistency)
      this.rk45Solver.addConstraintOperator(new FluidStateConstraintOperator());
      this.rk45Solver.addConstraintOperator(new FlowDynamicsConstraintOperator()); // Only computes steady-state for display
    }

    // OBSOLETE: Euler solver code - no longer used, RK45 is the only integration method
    // } else {
    //   // Initialize Euler solver with traditional operators
    //   console.log('[GameLoop] Using Euler integration method');
    //   this.solver = new Solver({
    //     minDt: 1e-5,
    //     maxDt: this.config.maxTimestep,
    //     targetDt: 0.0005,  // Start at 0.5ms for stability, will grow if stable
    //   });
    //
    //   // Add operators in physics order:
    //   //
    //   // Key insight: FlowOperator needs pressures computed by FluidStateUpdateOperator.
    //   // By putting FlowOperator FIRST, it uses the pressures computed at the END of the
    //   // previous timestep, which are fresh and consistent. Then heat transfer operators
    //   // modify energy, and FluidStateUpdateOperator recomputes pressures for next step.
    //   //
    //   // 1. Fluid flow (uses pressures from end of last step, transfers mass/energy)
    //   this.solver.addOperator(new FlowOperator());
    //
    //   // 2. Neutronics (power generation) - may need subcycling
    //   this.solver.addOperator(new NeutronicsOperator());
    //
    //   // 3. Heat generation (distribute power to fuel)
    //   this.solver.addOperator(new HeatGenerationOperator());
    //
    //   // 4. Conduction (heat spreads through solids)
    //   this.solver.addOperator(new ConductionOperator());
    //
    //   // 5. Convection (heat transfer solid→fluid, modifies fluid energy)
    //   this.solver.addOperator(new ConvectionOperator());
    //
    //   // 6. Fluid state update (computes T, P, phase from conserved quantities)
    //   // This sets pressures that FlowOperator will use in the NEXT timestep
    //   this.solver.addOperator(new FluidStateUpdateOperator());
    //
    //   // 7. Turbine and condenser (work extraction, heat rejection to external sink)
    //   // Use dynamic config from plant components if available, otherwise fall back to default
    //   const turbineCondenserConfig = this.plantState
    //     ? createTurbineCondenserConfigFromPlant(this.plantState.components)
    //     : createDefaultTurbineCondenserConfig();
    //   this.solver.addOperator(new TurbineCondenserOperator(turbineCondenserConfig));
    // }

    // Initialize tracking
    this.previousPower = initialState.neutronics.power;
    this.previousMaxTemp = this.getMaxFuelTemperature();
  }

  /**
   * Reset simulation to a new state
   */
  resetState(newState: SimulationState): void {
    this.state = newState;
    this.previousPower = newState.neutronics?.power ?? 0;
    this.previousMaxTemp = this.getMaxFuelTemperature();
    this.cumulativePowerChange = 0;
    this.cumulativeTempChange = 0;
    this.changeWindowTime = 0;
    this.recentEvents = [];

    // Reset solver state (timestep, counters, etc.)
    if (this.rk45Solver) {
      this.rk45Solver.reset();
    }

    console.log('[GameLoop] Simulation state reset');
  }

  // Flag to skip physics on the very first tick (no real frame time yet)
  private firstTick: boolean = true;

  /**
   * Start the game loop
   */
  start(): void {
    this.firstTick = true;
    this.lastFrameTime = performance.now();
    this.tick();
  }

  /**
   * Main tick function - called each frame
   */
  private tick = (): void => {
    const now = performance.now();
    const frameDt = (now - this.lastFrameTime) / 1000; // Convert to seconds
    this.lastFrameTime = now;

    // Skip physics on the very first tick - there's no real frame time yet,
    // just the tiny delay between setting lastFrameTime and calling tick()
    if (this.firstTick) {
      this.firstTick = false;
      requestAnimationFrame(this.tick);
      return;
    }

    if (!this.isPaused && frameDt > 0) {
      // Calculate simulation time to advance
      const simDt = frameDt * this.simSpeed;

      // Advance physics using the configured solver
      if (!this.rk45Solver) {
        throw new Error('[GameLoop] No solver configured');
      }
      const result = this.rk45Solver.advance(this.state, simDt);
      this.state = result.state;

      // Update fuel heat generation from neutronics
      this.syncNeutronicsToThermal();

      // Check for automatic SCRAM conditions
      this.checkScramConditions();

      // Check for auto-slowdown conditions
      if (this.config.autoSlowdownEnabled) {
        this.checkAutoSlowdown(frameDt);
      }

      // Check for performance warnings
      if (result.metrics.isFallingBehind) {
        this.emitEvent({
          type: 'falling-behind',
          time: this.state.time,
          message: `Simulation falling behind real time (ratio: ${result.metrics.realTimeRatio.toFixed(2)})`,
          data: { ratio: result.metrics.realTimeRatio },
        });
      }

      // Notify listeners
      this.onStateUpdate?.(this.state, result.metrics);
    }

    // Schedule next frame
    requestAnimationFrame(this.tick);
  };

  /**
   * Sync neutronics power to thermal node heat generation
   */
  private syncNeutronicsToThermal(): void {
    const fuelNode = this.state.thermalNodes.get('fuel');
    if (fuelNode) {
      fuelNode.heatGeneration = this.state.neutronics.power;
    }
  }

  /**
   * Check automatic SCRAM conditions
   * Only triggers automatic scram if a scram controller is connected (scramSetpoints is set)
   */
  private checkScramConditions(): void {
    const result = checkScramConditions(this.state, this.scramSetpoints);
    if (result.shouldScram) {
      this.state = triggerScram(this.state, result.reason);
      this.emitEvent({
        type: 'scram',
        time: this.state.time,
        message: `SCRAM: ${result.reason}`,
      });
    }
  }

  /**
   * Set scram controller setpoints
   * Pass undefined to disable automatic scram (manual only mode)
   */
  public setScramSetpoints(setpoints: ScramSetpoints | undefined): void {
    this.scramSetpoints = setpoints;
  }

  /**
   * Get current scram setpoints (undefined = manual only mode)
   */
  public getScramSetpoints(): ScramSetpoints | undefined {
    return this.scramSetpoints;
  }

  /**
   * Check if we should auto-slowdown due to rapid changes.
   *
   * Uses cumulative change over a 1-second window rather than instantaneous
   * rate, which prevents false triggers from frame-to-frame noise.
   */
  private checkAutoSlowdown(frameDt: number): void {
    // Skip auto-slowdown during first 2 seconds to let simulation stabilize
    if (this.state.time < 2.0) {
      this.previousPower = this.state.neutronics.power;
      this.previousMaxTemp = this.getMaxFuelTemperature();
      return;
    }

    const currentPower = this.state.neutronics.power;
    const currentMaxTemp = this.getMaxFuelTemperature();

    // Accumulate changes over the measurement window
    const powerChange = currentPower - this.previousPower;
    const tempChange = currentMaxTemp - this.previousMaxTemp;
    this.cumulativePowerChange += powerChange;
    this.cumulativeTempChange += tempChange;
    this.changeWindowTime += frameDt;

    // Check if we've accumulated a full window
    if (this.changeWindowTime >= this.CHANGE_WINDOW) {
      // Calculate change as fraction of initial value over the window
      const basePower = currentPower - this.cumulativePowerChange;
      const baseTemp = currentMaxTemp - this.cumulativeTempChange;

      const powerChangeFraction = Math.abs(this.cumulativePowerChange) / (basePower || 1);
      const tempChangeFraction = Math.abs(this.cumulativeTempChange) / (baseTemp || 1);

      const maxChangeFraction = Math.max(powerChangeFraction, tempChangeFraction);

      if (maxChangeFraction > this.config.autoSlowdownThreshold) {
        // Something interesting is happening - slow down
        if (this.simSpeed > 1.0) {
          const previousSpeed = this.simSpeed;
          this.targetSimSpeed = this.simSpeed;
          this.simSpeed = 1.0;

          // Determine which quantity caused the slowdown and format message
          let cause: string;
          let changeValue: string;
          if (powerChangeFraction >= tempChangeFraction) {
            const direction = this.cumulativePowerChange > 0 ? '↑' : '↓';
            const powerMW = Math.abs(this.cumulativePowerChange) / 1e6;
            cause = 'Power';
            changeValue = `${direction}${powerMW.toFixed(1)} MW (${(powerChangeFraction * 100).toFixed(0)}% in ${this.changeWindowTime.toFixed(1)}s)`;
          } else {
            const direction = this.cumulativeTempChange > 0 ? '↑' : '↓';
            cause = 'Fuel temp';
            changeValue = `${direction}${Math.abs(this.cumulativeTempChange).toFixed(1)} K (${(tempChangeFraction * 100).toFixed(0)}% in ${this.changeWindowTime.toFixed(1)}s)`;
          }

          console.log(`[GameLoop] Auto-slowing: ${previousSpeed.toFixed(1)}x → 1x | ${cause}: ${changeValue}`);

          // Emit event so UI can update
          this.emitEvent({
            type: 'auto-slowdown',
            time: this.state.time,
            message: `Auto-slowed to 1x: ${cause} ${changeValue}`,
            data: {
              previousSpeed,
              newSpeed: 1.0,
              cause,
              powerChangeFraction,
              tempChangeFraction,
            },
          });
        }
      } else if (this.simSpeed < this.targetSimSpeed && maxChangeFraction < this.config.autoSlowdownThreshold * 0.3) {
        // Things have calmed down - speed back up more aggressively
        this.simSpeed = Math.min(this.simSpeed * 1.5, this.targetSimSpeed);
      }

      // Reset accumulators for next window
      this.cumulativePowerChange = 0;
      this.cumulativeTempChange = 0;
      this.changeWindowTime = 0;
    }

    this.previousPower = currentPower;
    this.previousMaxTemp = currentMaxTemp;
  }

  /**
   * Get the maximum fuel temperature for monitoring
   */
  private getMaxFuelTemperature(): number {
    const fuelNode = this.state.thermalNodes.get('fuel');
    return fuelNode?.temperature ?? 0;
  }

  /**
   * Emit a game event
   */
  private emitEvent(event: GameEvent): void {
    // Prevent duplicate events in quick succession
    const recentSimilar = this.recentEvents.find(
      e => e.type === event.type && this.state.time - e.time < 1.0
    );
    if (recentSimilar) return;

    this.recentEvents.push(event);
    if (this.recentEvents.length > 100) {
      this.recentEvents.shift();
    }

    // Notify listeners
    this.onEvent?.(event);
    const listeners = this.eventListeners.get(event.type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Get current simulation state
   */
  getState(): SimulationState {
    return this.state;
  }

  /**
   * Set/replace the simulation state
   * Used when switching from construction mode with a new plant configuration
   */
  setSimulationState(newState: SimulationState): void {
    this.state = newState;
    // Reset tracking variables
    this.previousPower = newState.neutronics?.power ?? 0;
    this.previousMaxTemp = this.getMaxFuelTemperature();
    console.log(`[GameLoop] Simulation state updated with ${newState.flowNodes.size} flow nodes`);
  }

  /**
   * Get current simulation speed
   */
  getSimSpeed(): number {
    return this.simSpeed;
  }

  /**
   * Set simulation speed
   */
  setSimSpeed(speed: number): void {
    this.simSpeed = Math.max(
      this.config.minSimSpeed,
      Math.min(this.config.maxSimSpeed, speed)
    );
    this.targetSimSpeed = this.simSpeed;
  }

  setMaxTimestep(maxDt: number): void {
    // Update config
    this.config.maxTimestep = Math.max(0.001, Math.min(1.0, maxDt)); // Clamp between 1ms and 1s

    // Update solver config dynamically
    if (this.rk45Solver) {
      (this.rk45Solver as any).config.maxDt = this.config.maxTimestep;
    }
  }

  getMaxTimestep(): number {
    return this.config.maxTimestep;
  }

  /**
   * Get auto-slowdown threshold (rate of change that triggers slowdown)
   * Returns value as fraction per second (e.g., 0.1 = 10%/s)
   */
  getAutoSlowdownThreshold(): number {
    return this.config.autoSlowdownThreshold;
  }

  /**
   * Set auto-slowdown threshold
   * @param threshold - Cumulative change as fraction over 1 second (e.g., 0.1 = 10%)
   */
  setAutoSlowdownThreshold(threshold: number): void {
    this.config.autoSlowdownThreshold = Math.max(0.05, Math.min(4.0, threshold));
  }

  /**
   * Get whether auto-slowdown is enabled
   */
  getAutoSlowdownEnabled(): boolean {
    return this.config.autoSlowdownEnabled;
  }

  /**
   * Set whether auto-slowdown is enabled
   */
  setAutoSlowdownEnabled(enabled: boolean): void {
    this.config.autoSlowdownEnabled = enabled;
  }

  /**
   * Pause simulation
   */
  pause(): void {
    this.isPaused = true;
  }

  /**
   * Resume simulation
   */
  resume(): void {
    this.isPaused = false;
    this.lastFrameTime = performance.now(); // Reset to prevent time jump
  }

  /**
   * Toggle pause
   */
  togglePause(): boolean {
    if (this.isPaused) {
      this.resume();
    } else {
      this.pause();
    }
    return this.isPaused;
  }

  /**
   * Check if paused
   */
  getIsPaused(): boolean {
    return this.isPaused;
  }

  /**
   * Execute a single timestep (for debugging)
   * Uses a small fixed dt regardless of real time
   */
  step(dt: number = 0.001): void {
    // Advance physics by the specified amount
    if (!this.rk45Solver) {
      throw new Error('[GameLoop] No solver configured');
    }
    const result = this.rk45Solver.advance(this.state, dt);
    this.state = result.state;

    // Update fuel heat generation from neutronics
    this.syncNeutronicsToThermal();

    // Check for automatic SCRAM conditions
    this.checkScramConditions();

    // Notify listeners
    this.onStateUpdate?.(this.state, result.metrics);
  }

  /**
   * Execute exactly one internal physics step (for debugging).
   * This uses the solver's current adaptive dt rather than a fixed dt,
   * so you advance by the smallest stable increment. Returns the dt that was used.
   */
  singleStep(): number {
    // Execute exactly one solver substep
    if (!this.rk45Solver) {
      throw new Error('[GameLoop] No solver configured');
    }
    const rk45Result = this.rk45Solver.singleStep(this.state);
    const result = { state: rk45Result.state, dt: rk45Result.dt, metrics: rk45Result.metrics };
    this.state = result.state;

    // Update fuel heat generation from neutronics
    this.syncNeutronicsToThermal();

    // Check for automatic SCRAM conditions
    this.checkScramConditions();

    // Notify listeners
    this.onStateUpdate?.(this.state, result.metrics);

    return result.dt;
  }

  /**
   * Add event listener
   */
  addEventListener(type: GameEventType, callback: (event: GameEvent) => void): void {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, []);
    }
    this.eventListeners.get(type)!.push(callback);
  }

  /**
   * Manual SCRAM trigger
   */
  triggerScram(reason: string = 'Manual'): void {
    this.state = triggerScram(this.state, reason);
    this.emitEvent({
      type: 'scram',
      time: this.state.time,
      message: `SCRAM: ${reason}`,
    });
  }

  /**
   * Reset SCRAM - allows reactor restart
   */
  resetScram(): void {
    const wasScrammed = this.state.neutronics.scrammed;
    this.state = resetScram(this.state);
    if (wasScrammed && !this.state.neutronics.scrammed) {
      this.emitEvent({
        type: 'scram-reset',
        time: this.state.time,
        message: 'SCRAM reset - manual rod control enabled',
      });
    }
  }

  /**
   * Check if reactor is currently scrammed
   */
  isScramActive(): boolean {
    return this.state.neutronics.scrammed;
  }

  /**
   * Get solver metrics
   */
  getSolverMetrics(): SolverMetrics {
    // Return default metrics (actual metrics are returned per-advance call)
    return {
      currentDt: 0,
      actualDt: 0,
      maxStableDt: Infinity,
      dtLimitedBy: 'RK45',
      stabilityLimitedBy: 'none',
      minDtUsed: 0,
      subcycleCount: 0,
      totalSteps: 0,
      lastStepWallTime: 0,
      avgStepWallTime: 0,
      retriesThisFrame: 0,
      maxPressureChange: 0,
      maxFlowChange: 0,
      maxMassChange: 0,
      consecutiveSuccesses: 0,
      topErrorContributors: [],
      realTimeRatio: 1,
      isFallingBehind: false,
      fallingBehindSince: 0,
      operatorTimes: new Map(),
    };
  }

  /**
   * Get recent events
   */
  getRecentEvents(): GameEvent[] {
    return [...this.recentEvents];
  }

  /**
   * Update state directly (for UI interactions like valve changes)
   */
  updateState(updater: (state: SimulationState) => SimulationState): void {
    this.state = updater(this.state);
  }
}
