/**
 * Game Loop
 *
 * Integrates the physics simulation with the rendering and UI.
 * Handles the main update cycle, simulation speed control, and
 * automatic slowdown during rapid transients.
 */

import {
  Solver,
  SimulationState,
  SolverMetrics,
  ConductionOperator,
  ConvectionOperator,
  HeatGenerationOperator,
  FlowOperator,
  NeutronicsOperator,
  FluidStateUpdateOperator,
  checkScramConditions,
  triggerScram,
} from '../simulation';

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
}

const DEFAULT_CONFIG: GameLoopConfig = {
  initialSimSpeed: 1.0,
  maxSimSpeed: 100.0,
  minSimSpeed: 0.01,  // Allow 100x slower than real time

  autoSlowdownEnabled: true,
  autoSlowdownThreshold: 0.1, // 10% change per second triggers slowdown

  targetFrameRate: 60,
};

export type GameEventType =
  | 'scram'
  | 'high-temperature'
  | 'low-flow'
  | 'phase-change'
  | 'falling-behind';

export interface GameEvent {
  type: GameEventType;
  time: number;
  message: string;
  data?: Record<string, unknown>;
}

export class GameLoop {
  private solver: Solver;
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

  // Event system
  private eventListeners: Map<GameEventType, ((event: GameEvent) => void)[]> = new Map();
  private recentEvents: GameEvent[] = [];

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

    // Initialize solver with operators in correct order
    this.solver = new Solver({
      minDt: 1e-5,
      maxDt: 0.05,
      targetDt: 0.01,
    });

    // Add operators in physics order:
    // 1. Neutronics (power generation) - may need subcycling
    this.solver.addOperator(new NeutronicsOperator());

    // 2. Heat generation (distribute power to fuel)
    this.solver.addOperator(new HeatGenerationOperator());

    // 3. Conduction (heat spreads through solids)
    this.solver.addOperator(new ConductionOperator());

    // 4. Convection (heat transfer to coolant)
    this.solver.addOperator(new ConvectionOperator());

    // 5. Fluid flow (coolant circulation, energy transport)
    this.solver.addOperator(new FlowOperator());

    // 6. Fluid state update (ensures T, P, phase are consistent with conserved quantities)
    // This calculates pressure from thermodynamics (density, energy, volume)
    this.solver.addOperator(new FluidStateUpdateOperator());

    // Initialize tracking
    this.previousPower = initialState.neutronics.power;
    this.previousMaxTemp = this.getMaxFuelTemperature();
  }

  /**
   * Start the game loop
   */
  start(): void {
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

    if (!this.isPaused && frameDt > 0) {
      // Calculate simulation time to advance
      const simDt = frameDt * this.simSpeed;

      // Advance physics
      const result = this.solver.advance(this.state, simDt);
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
   */
  private checkScramConditions(): void {
    const result = checkScramConditions(this.state);
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
   * Check if we should auto-slowdown due to rapid changes
   */
  private checkAutoSlowdown(frameDt: number): void {
    const currentPower = this.state.neutronics.power;
    const currentMaxTemp = this.getMaxFuelTemperature();

    // Calculate rates of change
    const powerChangeRate = Math.abs(currentPower - this.previousPower) /
                           (this.previousPower || 1) / frameDt;
    const tempChangeRate = Math.abs(currentMaxTemp - this.previousMaxTemp) /
                          (this.previousMaxTemp || 1) / frameDt;

    const maxChangeRate = Math.max(powerChangeRate, tempChangeRate);

    if (maxChangeRate > this.config.autoSlowdownThreshold) {
      // Something interesting is happening - slow down
      if (this.simSpeed > 1.0) {
        this.targetSimSpeed = this.simSpeed;
        this.simSpeed = 1.0;
        console.log(`[GameLoop] Auto-slowing to real time (change rate: ${(maxChangeRate * 100).toFixed(1)}%/s)`);
      }
    } else if (this.simSpeed < this.targetSimSpeed && maxChangeRate < this.config.autoSlowdownThreshold * 0.5) {
      // Things have calmed down - gradually speed back up
      this.simSpeed = Math.min(this.simSpeed * 1.1, this.targetSimSpeed);
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
    const result = this.solver.advance(this.state, dt);
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
    const result = this.solver.singleStep(this.state);
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
   * Get solver metrics
   */
  getSolverMetrics(): SolverMetrics {
    return this.solver.getMetrics();
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
