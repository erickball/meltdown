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
  CladdingOxidationRateOperator,
  GraphiteOxidationRateOperator,
  OtsgRateOperator,
  OtsgLedgerCheckOperator,
  OtsgPartitionConstraintOperator,
  HydrogenCombustionRateOperator,
  CoriumRelocationRateOperator,
  McciRateOperator,
  FissionProductReleaseOperator,
  HeatGenerationRateOperator,
  NeutronicsRateOperator,
  FlowRateOperator,
  FlowMomentumRateOperator,
  TurbineCondenserRateOperator,
  FluidStateConstraintOperator,
  FlowDynamicsConstraintOperator,
  PumpSpeedRateOperator,
  BurstCheckOperator,
  ChokedFlowDisplayOperator,
  ControlSystemOperator,
} from '../simulation';
import type { ScramSetpoints } from '../simulation/operators/neutronics';
export type { ScramSetpoints } from '../simulation/operators/neutronics';
import { StateHistory, StateSnapshot } from './state-history';
import { cloneSimulationState } from '../simulation/solver';

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
  // 50% change per second: auto-slow is meant for big events (power
  // excursions, ruptures), not routine maneuvering - keep in sync with the
  // #slowdown-threshold slider default in index.html
  autoSlowdownThreshold: 0.5,

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
  | 'auto-slowdown'
  | 'simulation-error'
  | 'component-burst';

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

  // Wall-clock accounting for the status bar. Accumulates only while the loop
  // is actually running, so it reads as "how long this run has been going",
  // not how long the page has been open.
  private runningWallTime: number = 0;
  // Rolling (wall, sim) pairs behind the achieved-speed readout. One frame's
  // ratio is not a speed: a frame can integrate a whole second of simulation
  // or almost none, so the instantaneous number jumps around far too much to
  // read. Averaging over a window of wall time gives the figure a person can
  // actually compare against the speed they asked for.
  private speedSamples: { wall: number; sim: number }[] = [];
  private readonly ACHIEVED_SPEED_WINDOW: number = 2.0; // seconds of wall time

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

  // State history for "back up" functionality
  private stateHistory: StateHistory = new StateHistory();

  // Step number of the last frame-boundary snapshot, to skip frames where
  // no physics ran (paused, zero-dt frames)
  private lastSnapshotStep = -1;

  // Last solver metrics (stored for getSolverMetrics)
  private lastMetrics: SolverMetrics | null = null;

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
        // Disable deterministic mode in game loop for UI responsiveness
        // This allows the solver to bail out early if taking too long
        deterministicMode: false,
      });

      // Add rate operators (compute derivatives)
      this.rk45Solver.addRateOperator(new FlowMomentumRateOperator()); // Flow momentum (dṁ/dt)
      this.rk45Solver.addRateOperator(new OtsgRateOperator()); // moving-boundary OTSG - MUST precede FlowRate (draw-enthalpy cache)
      this.rk45Solver.addRateOperator(new FlowRateOperator());          // Mass/energy transport
      this.rk45Solver.addRateOperator(new NeutronicsRateOperator());
      this.rk45Solver.addRateOperator(new HeatGenerationRateOperator());
      this.rk45Solver.addRateOperator(new ConductionRateOperator());
      this.rk45Solver.addRateOperator(new ConvectionRateOperator());
      this.rk45Solver.addRateOperator(new CladdingOxidationRateOperator()); // Zr-steam oxidation + H2 generation
      this.rk45Solver.addRateOperator(new GraphiteOxidationRateOperator()); // graphite air/steam attack -> CO, H2, heat
      this.rk45Solver.addRateOperator(new HydrogenCombustionRateOperator()); // H2 deflagration when flammable + ignited
      this.rk45Solver.addRateOperator(new CoriumRelocationRateOperator()); // molten fuel/clad slumps to the lower head
      this.rk45Solver.addRateOperator(new McciRateOperator()); // ex-vessel corium attacks the concrete basemat
      this.rk45Solver.addRateOperator(new FissionProductReleaseOperator()); // Overheated fuel releases Xe/CsI
      this.rk45Solver.addRateOperator(new TurbineCondenserRateOperator());

      // Add pump speed rate operator (integrates pump ramp-up/coast-down)
      this.rk45Solver.addRateOperator(new PumpSpeedRateOperator());

      // Add constraint operators (enforce thermodynamic consistency)
      this.rk45Solver.addConstraintOperator(new FluidStateConstraintOperator());
      this.rk45Solver.addConstraintOperator(new OtsgPartitionConstraintOperator()); // boiler tubes: partition-owned pressure overwrites the uniform read
      this.rk45Solver.addConstraintOperator(new BurstCheckOperator()); // Check for component ruptures
      this.rk45Solver.addConstraintOperator(new FlowDynamicsConstraintOperator()); // Only computes steady-state for display
      this.rk45Solver.addConstraintOperator(new ChokedFlowDisplayOperator()); // Sets conn.isChoked for debug display
      this.rk45Solver.addConstraintOperator(new ControlSystemOperator()); // Auto-tuned process controllers (finalOnly)
      this.rk45Solver.addConstraintOperator(new OtsgLedgerCheckOperator()); // OTSG economizer ledger vs the wall (finalOnly)

      // Per accepted substep, log only the dt (three numbers) - full-state
      // snapshots are taken once per frame and on user inputs (see
      // recordFrameSnapshot / recordInputSnapshot). Snapshots + this dt log
      // make any intermediate step reachable by deterministic replay.
      this.rk45Solver.onSubstepComplete = (state, stepNumber, acceptedDt) => {
        this.stateHistory.recordDt(stepNumber, state.time, acceptedDt);
      };
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
    this.runningWallTime = 0;
    this.speedSamples = [];

    // Reset solver state (timestep, counters, etc.) BEFORE recording the
    // initial snapshot so it carries no stale flow-rates context
    if (this.rk45Solver) {
      this.rk45Solver.reset();
    }

    // Clear state history on reset and record initial state (step 0)
    this.stateHistory.clear();
    this.stateHistory.recordSnapshot(this.state, 0, 'initial', undefined);
    this.lastSnapshotStep = 0;

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
      // Simulation time to advance. In deterministic mode the frame interval is
      // capped first; on the interactive path it is used as measured.
      //
      // THE CAP IS WHAT KEEPS THIS LOOP FROM DRIVING ITSELF. requestAnimationFrame
      // cannot fire the next frame until tick() returns, so an uncapped frameDt is
      // *this frame's own compute time*: the loop asks frame n+1 for exactly as
      // much simulation time as serving frame n cost in wall time. Below 1x
      // realtime that is positive feedback - each request bigger than the last,
      // geometrically. Measured on the Xe-100 at 1x: the request climbed 0.67 ->
      // 3.9 -> 11.2 -> 15.5 s of simulation per frame, one frame blocking the tab
      // for ~10 s, before settling at the fixed point where a frame's compute
      // equals a frame's simulation. Above 1x there is no fixed point and it
      // diverges until the tab stops answering.
      //
      // ONLY DETERMINISTIC MODE NEEDS THE CAP. The interactive path already has a
      // governor: advance() yields at maxWallTimeMs, so what a frame COSTS is
      // bounded however much it was asked for, and the excess request is dropped
      // rather than fed back. Capping its request too was measurably worse - the
      // solver returned with budget unspent, so the frame's fixed render/UI cost
      // bought less simulation (PWR: 0.53x at 22 fps became 0.43x at 27 fps).
      // Deterministic mode takes no such break, by design, which leaves the
      // feedback with nothing damping it.
      //
      // The cap is that same budget: one frame's worth of work, as this solver
      // defines it. Time the cap drops is dropped, not re-requested - so the
      // simulation runs slow rather than running away, which is reported below.
      const deterministic = this.rk45Solver?.getDeterministicMode() ?? false;
      const frameBudget = this.rk45Solver
        ? this.rk45Solver.getMaxWallTimeMs() / 1000
        : 1 / this.config.targetFrameRate;
      const servedDt = deterministic ? Math.min(frameDt, frameBudget) : frameDt;
      const simDt = servedDt * this.simSpeed;

      // Count the REAL interval, not the capped one: this is wall time the
      // user sat through, and dividing simulated time by it is what makes the
      // achieved-speed readout mean what it says.
      this.runningWallTime += frameDt;

      try {
        // Advance physics using the configured solver
        if (!this.rk45Solver) {
          throw new Error('[GameLoop] No solver configured');
        }
        const result = this.rk45Solver.advance(this.state, simDt, frameDt * 1000);
        this.state = result.state;
        this.recordSpeedSample();

        // Time the cap threw away is time we fell behind, and the solver cannot
        // see it: in deterministic mode it finished everything we asked for, so
        // its own falling-behind test (unserved remainder) reads clean. Without
        // this correction a plant at 0.07x would look on-schedule while the ratio
        // beside it said 0.07x. Same 10% slack the solver's test uses, so a frame
        // that lands a hair over the budget is not an alarm. Nothing is dropped on
        // the interactive path, where servedDt is the measured interval, so this
        // is inert there.
        const droppedDt = frameDt - servedDt;
        if (droppedDt > servedDt * 0.1) {
          result.metrics.isFallingBehind = true;
        }

        this.lastMetrics = result.metrics;
        // Note: State history recording happens via onSubstepComplete callback

        // Update fuel heat generation from neutronics
        this.syncNeutronicsToThermal();

        // Check for automatic SCRAM conditions
        this.checkScramConditions();

        // Process pending events from constraint operators (e.g., burst events)
        this.processPendingEvents();

        // Check for auto-slowdown conditions
        if (this.config.autoSlowdownEnabled) {
          this.checkAutoSlowdown(frameDt);
        }

        // Check for performance warnings
        if (result.metrics.isFallingBehind) {
          this.emitEvent({
            type: 'falling-behind',
            time: this.state.time,
            message: `Simulation running slower than the requested ${this.simSpeed}x speed (actual: ${result.metrics.realTimeRatio.toFixed(2)}x)`,
            data: { ratio: result.metrics.realTimeRatio },
          });
        }

        // Frame-boundary snapshot AFTER the mutations above - between two of
        // these the trajectory is pure solver steps, which is what makes the
        // dt-log replay exact
        this.recordFrameSnapshot();

        // Notify listeners
        this.onStateUpdate?.(this.state, result.metrics);
      } catch (error) {
        // Simulation error - pause and notify user
        this.isPaused = true;
        // The aborted frame may have logged accepted steps whose states were
        // lost with the throw - roll the history head back to the state we
        // actually still hold, so seeks and input snapshots stay consistent
        this.stateHistory.discardStepsBeyond(Math.max(0, this.lastSnapshotStep));
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[GameLoop] Simulation error:', errorMessage);

        this.emitEvent({
          type: 'simulation-error',
          time: this.state.time,
          message: errorMessage,
          data: { error },
        });

        // Still notify listeners so UI can update (show paused state, etc.)
        this.onStateUpdate?.(this.state, this.getSolverMetrics());
      }
    }

    // Schedule next frame
    requestAnimationFrame(this.tick);
  };

  /**
   * Sync neutronics power to thermal node heat generation.
   *
   * LEGACY: only the hand-built demo ever had a node literally named
   * 'fuel'; factory cores are `${coreId}-fuel` and receive reactor power
   * through HeatGenerationRateOperator (via neutronics.fuelNodeId), so for
   * every factory plant this is a no-op. Left in place for old saved
   * states; do not extend it.
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
   * Process any pending events queued by constraint operators.
   * This allows operators like BurstCheckOperator to emit events
   * without having direct access to the event system.
   */
  private processPendingEvents(): void {
    if (!this.state.pendingEvents || this.state.pendingEvents.length === 0) {
      return;
    }

    for (const event of this.state.pendingEvents) {
      this.emitEvent({
        type: event.type as GameEventType,
        time: this.state.time,
        message: event.message,
        data: event.data,
      });

      // Auto-slowdown on burst events for visibility
      if (event.type === 'component-burst' && this.simSpeed > 1) {
        this.simSpeed = 1;
        this.emitEvent({
          type: 'auto-slowdown',
          time: this.state.time,
          message: 'Slowed to 1x due to component rupture',
        });
      }
    }

    // Clear the pending events
    this.state.pendingEvents = [];
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
      // Calculate change as fraction of initial value over the window.
      // The power base is floored at 5% of NOMINAL power: during a startup
      // from low power, fission power rises exponentially through decades,
      // so a purely relative criterion (dP/P) trips every window and pins
      // the game at 1x for the whole climb. Below a few % of rated power
      // nothing thermally interesting is happening yet - the flux can
      // multiply tenfold without moving a fuel temperature - so changes
      // are measured against a floor of plant-significant scale instead.
      const basePower = currentPower - this.cumulativePowerChange;
      const baseTemp = currentMaxTemp - this.cumulativeTempChange;
      const nominal = this.state.neutronics.nominalPower ?? 0;
      const powerBase = Math.max(basePower, 0.05 * nominal, 1);

      const powerChangeFraction = Math.abs(this.cumulativePowerChange) / powerBase;
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
   * Get the maximum fuel temperature for monitoring.
   *
   * Resolves the neutronics-linked fuel node (factory cores are
   * `${coreId}-fuel`); the literal 'fuel' id is the legacy hand-built demo
   * name and matched NOTHING for factory plants, which silently disabled
   * the fuel-temperature half of auto-slowdown.
   */
  private getMaxFuelTemperature(): number {
    const fuelId = this.state.neutronics.fuelNodeId ?? 'fuel';
    const fuelNode = this.state.thermalNodes.get(fuelId);
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

    // A different plant is a different run: its wall clock starts at zero and
    // the old plant's speed samples say nothing about this one. (A simulation
    // resumed after a construction visit keeps its simulated time but starts a
    // fresh wall clock - the tooltip on the readout says so.)
    this.runningWallTime = 0;
    this.speedSamples = [];

    // Clear recent events (prevents stale events from blocking new ones due to time comparison)
    this.recentEvents = [];

    // Reset the solver so step numbering restarts with the new history and
    // no stale flow-rates context leaks into the new plant's first step
    if (this.rk45Solver) {
      this.rk45Solver.reset();
    }

    // Clear state history and record initial state (step 0)
    this.stateHistory.clear();
    this.stateHistory.recordSnapshot(this.state, 0, 'initial', undefined);
    this.lastSnapshotStep = 0;

    console.log(`[GameLoop] Simulation state updated with ${newState.flowNodes.size} flow nodes`);
  }

  /**
   * Record a (wall, sim) pair and retire the samples that have aged out of
   * the averaging window. The sample that has just passed the far edge is
   * KEPT, as the baseline to measure against - drop it and the window
   * collapses toward a single frame, which is the noise this exists to avoid.
   */
  private recordSpeedSample(): void {
    this.speedSamples.push({ wall: this.runningWallTime, sim: this.state.time });
    while (this.speedSamples.length > 2 &&
           this.runningWallTime - this.speedSamples[1].wall >= this.ACHIEVED_SPEED_WINDOW) {
      this.speedSamples.shift();
    }
  }

  /**
   * Wall-clock seconds this run has spent actually running (paused time is
   * not counted). Reset whenever the simulation state is replaced or reset.
   */
  getRunningWallTime(): number {
    return this.runningWallTime;
  }

  /**
   * Simulated seconds per wall second, averaged over the last
   * ACHIEVED_SPEED_WINDOW of running wall time. Null until two samples exist
   * (nothing has run yet) - callers should show the requested speed instead
   * rather than inventing a number.
   */
  getAchievedSpeed(): number | null {
    if (this.speedSamples.length < 2) return null;
    const oldest = this.speedSamples[0];
    const newest = this.speedSamples[this.speedSamples.length - 1];
    const wallSpan = newest.wall - oldest.wall;
    if (wallSpan <= 0) return null;
    return (newest.sim - oldest.sim) / wallSpan;
  }

  /**
   * Get current simulation speed
   */
  getSimSpeed(): number {
    return this.simSpeed;
  }

  /**
   * Get the user-requested speed (differs from getSimSpeed while
   * auto-slowdown holds the effective speed below it)
   */
  getTargetSimSpeed(): number {
    return this.targetSimSpeed;
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
   * Set minimum timestep (prevents adaptive dt from going too small)
   * @param minDt - minimum timestep in seconds (e.g., 1e-6 for 1µs)
   */
  setMinTimestep(minDt: number): void {
    const clampedMinDt = Math.max(1e-6, Math.min(0.1, minDt)); // Clamp between 1µs and 100ms
    if (this.rk45Solver) {
      const oldMinDt = (this.rk45Solver as any).config.minDt;
      const oldCurrentDt = (this.rk45Solver as any).currentDt;
      (this.rk45Solver as any).config.minDt = clampedMinDt;
      // Also clamp currentDt upward if it's now below the new minimum
      if ((this.rk45Solver as any).currentDt < clampedMinDt) {
        (this.rk45Solver as any).currentDt = clampedMinDt;
        console.log(`[GameLoop] Clamped currentDt from ${(oldCurrentDt * 1000).toFixed(3)}ms to ${(clampedMinDt * 1000).toFixed(3)}ms`);
      }
      console.log(`[GameLoop] minDt: ${(oldMinDt * 1000).toFixed(3)}ms → ${(clampedMinDt * 1000).toFixed(3)}ms`);
    }
  }

  getMinTimestep(): number {
    if (this.rk45Solver) {
      return (this.rk45Solver as any).config.minDt;
    }
    return 1e-6;
  }

  /**
   * Set K_max for the pressure solver (numerical bulk modulus cap)
   * @param kMax - maximum bulk modulus in Pa (e.g., 200e6 for 200 MPa)
   */
  setKMax(kMax: number | undefined): void {
    if (this.rk45Solver && (this.rk45Solver as any).pressureSolver) {
      (this.rk45Solver as any).pressureSolver.config.K_max = kMax;
    }
  }

  getKMax(): number | undefined {
    if (this.rk45Solver && (this.rk45Solver as any).pressureSolver) {
      return (this.rk45Solver as any).pressureSolver.config.K_max;
    }
    return undefined;
  }

  /**
   * Enable or disable the pressure solver
   */
  setPressureSolverEnabled(enabled: boolean): void {
    if (this.rk45Solver) {
      (this.rk45Solver as any).pressureSolverEnabled = enabled;
    }
  }

  getPressureSolverEnabled(): boolean {
    if (this.rk45Solver) {
      return (this.rk45Solver as any).pressureSolverEnabled ?? true;
    }
    return false;
  }

  /**
   * Enable or disable the fully implicit momentum solve (backward-Euler
   * pressure-flow coupling). When disabled, flow momentum is integrated
   * explicitly by RK45 (reference scheme, resolves water hammer, much slower
   * on liquid loops).
   */
  setImplicitMomentumEnabled(enabled: boolean): void {
    if (this.rk45Solver && (this.rk45Solver as any).pressureSolver) {
      (this.rk45Solver as any).pressureSolver.config.implicitMomentum = enabled;
    }
  }

  getImplicitMomentumEnabled(): boolean {
    if (this.rk45Solver && (this.rk45Solver as any).pressureSolver) {
      return !!(this.rk45Solver as any).pressureSolver.config.implicitMomentum;
    }
    return false;
  }

  setDeterministicMode(enabled: boolean): void {
    if (this.rk45Solver) {
      this.rk45Solver.setDeterministicMode(enabled);
    }
  }

  getDeterministicMode(): boolean {
    if (this.rk45Solver) {
      return this.rk45Solver.getDeterministicMode();
    }
    return false;
  }

  /**
   * Get pressure solver status (for debug panel display)
   */
  getPressureSolverStatus(): { enabled: boolean; status: { ran: boolean; iterations: number; converged: boolean; stagnated: boolean; maxImbalance: number; K_max: number | undefined } | null } {
    if (this.rk45Solver) {
      return this.rk45Solver.getPressureSolverStatus();
    }
    return { enabled: false, status: null };
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
    this.lastMetrics = result.metrics;
    // Note: dt-log recording happens via onSubstepComplete callback

    // Update fuel heat generation from neutronics
    this.syncNeutronicsToThermal();

    // Check for automatic SCRAM conditions
    this.checkScramConditions();

    // Process pending events from constraint operators (e.g., burst events)
    this.processPendingEvents();

    // Boundary snapshot after the mutations above (see tick())
    this.recordFrameSnapshot();

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
    this.lastMetrics = result.metrics;
    // Note: dt-log recording happens via onSubstepComplete callback

    // Update fuel heat generation from neutronics
    this.syncNeutronicsToThermal();

    // Check for automatic SCRAM conditions
    this.checkScramConditions();

    // Process pending events from constraint operators (e.g., burst events)
    this.processPendingEvents();

    // Boundary snapshot after the mutations above (see tick())
    this.recordFrameSnapshot();

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
    // A manual scram is a user input: snapshot it so replay stays exact
    this.recordInputSnapshot();
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
      this.recordInputSnapshot();
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
    // Return last stored metrics if available
    if (this.lastMetrics) {
      return this.lastMetrics;
    }

    // Otherwise return defaults with real step count from solver
    const solverMetrics = this.rk45Solver?.getMetrics();
    return {
      currentDt: solverMetrics?.currentDt ?? 0,
      actualDt: 0,
      maxStableDt: Infinity,
      dtLimitedBy: 'RK45',
      stabilityLimitedBy: 'none',
      minDtUsed: 0,
      subcycleCount: 0,
      totalSteps: solverMetrics?.totalSteps ?? 0,
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
      lastSimTime: this.state?.time ?? 0,
    };
  }

  /**
   * Get recent events
   */
  getRecentEvents(): GameEvent[] {
    return [...this.recentEvents];
  }

  /**
   * Update state directly (for UI interactions like valve changes).
   * Every mutation through here gets an input snapshot: replay re-integrates
   * pure solver steps between snapshots, so anything that changes state
   * outside the solver must leave a snapshot behind it.
   */
  updateState(updater: (state: SimulationState) => SimulationState): void {
    this.state = updater(this.state);
    this.recordInputSnapshot();
  }

  // ============================================================================
  // State History (for "back up" functionality)
  // ============================================================================

  /**
   * Frame-boundary snapshot, taken after the post-advance mutations
   * (neutronics sync, auto-scram, event processing). Skipped when no
   * physics ran since the last one.
   */
  private recordFrameSnapshot(): void {
    if (!this.rk45Solver) return;
    const step = this.rk45Solver.getMetrics().totalSteps;
    if (step === this.lastSnapshotStep) return;
    this.lastSnapshotStep = step;
    this.stateHistory.recordSnapshot(this.state, step, 'frame', this.rk45Solver.getFlowRatesContext());
  }

  /** Snapshot after a user input mutated state between solver steps. */
  private recordInputSnapshot(): void {
    if (!this.rk45Solver) return;
    this.stateHistory.recordSnapshot(
      this.state,
      this.stateHistory.getPositionStep(),
      'input',
      this.rk45Solver.getFlowRatesContext()
    );
  }

  /**
   * Adopt a restored snapshot as the live state: CLONE it (the live state
   * gets mutated in place by inputs - handing out the stored object would
   * corrupt history), restore the solver's cross-step flow-rates context,
   * and reset the adaptive timestep to a safe value.
   */
  private adoptSnapshot(snapshot: StateSnapshot): void {
    this.state = cloneSimulationState(snapshot.state);
    if (this.rk45Solver) {
      this.rk45Solver.setFlowRatesContext(snapshot.flowRates);
      (this.rk45Solver as any).currentDt = Math.min(
        0.001,
        (this.rk45Solver as any).config.maxDt
      );
    }
  }

  /**
   * Navigate back one snapshot in history.
   * Does NOT delete future states - they remain available.
   * Returns true if successful, false if already at the beginning.
   */
  stepBack(): boolean {
    const snapshot = this.stateHistory.navigateBack();
    if (!snapshot) {
      console.log('[GameLoop] No history to step back to');
      return false;
    }
    this.adoptSnapshot(snapshot);
    console.log(`[GameLoop] Navigated back to t=${snapshot.simTime.toFixed(3)}s (step ${snapshot.stepNumber})`);
    return true;
  }

  /**
   * Navigate forward one snapshot in history.
   * Returns true if successful, false if already at the end.
   */
  stepForward(): boolean {
    const snapshot = this.stateHistory.navigateForward();
    if (!snapshot) {
      console.log('[GameLoop] Already at end of history');
      return false;
    }
    this.adoptSnapshot(snapshot);
    console.log(`[GameLoop] Navigated forward to t=${snapshot.simTime.toFixed(3)}s (step ${snapshot.stepNumber})`);
    return true;
  }

  /**
   * Navigate to a specific snapshot by index.
   * Returns the actual time navigated to, or null if invalid index.
   */
  navigateToHistoryIndex(index: number): number | null {
    const snapshot = this.stateHistory.navigateToIndex(index);
    if (!snapshot) {
      console.log('[GameLoop] Invalid history index');
      return null;
    }
    this.adoptSnapshot(snapshot);
    console.log(`[GameLoop] Navigated to t=${snapshot.simTime.toFixed(3)}s (step ${snapshot.stepNumber})`);
    return snapshot.simTime;
  }

  /**
   * Restore to the snapshot closest to a given simulation time (no replay -
   * see seekToTime for the step-exact version).
   * Returns the actual time restored to, or null if no history.
   */
  restoreToTime(targetTime: number): number | null {
    const restoredState = this.stateHistory.restoreToTime(targetTime);
    if (!restoredState) {
      console.log('[GameLoop] No history to restore from');
      return null;
    }

    this.state = restoredState;  // already a clone
    const snapshot = this.stateHistory.snapshotAtCurrentIndex();
    if (this.rk45Solver) {
      this.rk45Solver.setFlowRatesContext(snapshot?.flowRates);
      (this.rk45Solver as any).currentDt = Math.min(
        0.001,
        (this.rk45Solver as any).config.maxDt
      );
    }
    console.log(`[GameLoop] Navigated to t=${restoredState.time.toFixed(3)}s (requested ${targetTime.toFixed(3)}s)`);
    return restoredState.time;
  }

  // ============================================================================
  // Replay-seek: step-exact navigation
  //
  // Restores the latest snapshot at or before the target step, then
  // re-integrates the logged dts to land exactly on the target. Snapshots
  // are taken at every frame boundary and user input, so the replayed span
  // is pure solver steps and the result is bit-identical to the live run.
  // ============================================================================

  /**
   * Seek to an exact solver step. Returns the sim time landed on, or null
   * if the step precedes all retained history. Throws (loudly) if replay
   * diverges from the recorded trajectory - that is a determinism bug.
   */
  seekToStep(targetStep: number): number | null {
    if (!this.rk45Solver) return null;
    const plan = this.stateHistory.planSeek(targetStep);
    if (!plan) return null;

    let state = cloneSimulationState(plan.base.state);
    this.rk45Solver.setFlowRatesContext(plan.base.flowRates);

    let landedStep = plan.base.stepNumber;
    if (plan.dts === null) {
      // The dt log for this span aged out of its cap - land on the snapshot
      // and say so instead of silently pretending it was exact
      console.warn(
        `[GameLoop] Seek to step ${plan.targetStep}: dt log aged out; ` +
        `landing on nearest snapshot at t=${plan.base.simTime.toFixed(3)}s (step ${plan.base.stepNumber})`
      );
    } else {
      for (const entry of plan.dts) {
        state = this.rk45Solver.replayStep(state, entry.dt);
        if (Math.abs(state.time - entry.simTime) > 1e-6) {
          throw new Error(
            `[GameLoop] Replay drift at step ${entry.step}: replayed t=${state.time}, ` +
            `recorded t=${entry.simTime}. The physics is not reproducing the recorded ` +
            `trajectory - this is a determinism bug that must be fixed.`
          );
        }
        landedStep = entry.step;
      }
    }

    // Events queued by replayed burst checks were already emitted when they
    // happened live - drop them instead of re-notifying
    state.pendingEvents = [];

    this.state = state;
    this.stateHistory.setPosition(landedStep, state.time);
    (this.rk45Solver as any).currentDt = Math.min(
      0.001,
      (this.rk45Solver as any).config.maxDt
    );
    return state.time;
  }

  /**
   * Seek to the step whose post-step time first reaches targetTime
   * (clamped to retained history). Returns the sim time landed on.
   */
  seekToTime(targetTime: number): number | null {
    return this.seekToStep(this.stateHistory.stepForTime(targetTime));
  }

  /** Current step-granular position (seek position, or the live head). */
  getPositionStep(): number {
    return this.stateHistory.getPositionStep();
  }

  /** Rewind history in persistable form (see StateHistory.exportForSave). */
  exportHistory(): ReturnType<StateHistory['exportForSave']> {
    return this.stateHistory.exportForSave();
  }

  /**
   * Restore a saved rewind history after the saved sim state has been
   * adopted (setSimulationState resets the solver and clears history, so
   * this must run after it). Realigns the solver's step counter past the
   * imported head - step numbers order the history and must never repeat -
   * and, if the save was made while rewound, re-establishes that position.
   */
  importHistory(data: ReturnType<StateHistory['exportForSave']>): void {
    this.stateHistory.importFromSave(data);
    const head = this.stateHistory.headStep();
    this.rk45Solver?.resumeStepCounter(head);
    this.lastSnapshotStep = head;
    const headStates = this.stateHistory.statesInRange();
    const headTime = headStates.length > 0 ? headStates[headStates.length - 1].time : 0;
    if (Math.abs(headTime - this.state.time) > 1e-6) {
      // Saved while positioned in the past: the live state sits mid-history
      const step = this.stateHistory.stepForTime(this.state.time);
      this.stateHistory.setPosition(step, this.state.time);
    }
  }

  /**
   * Read-only history states for plotting/analysis (Jack's tools), oldest
   * first, with the live state appended when it is newer than the last
   * snapshot. Callers must NOT mutate the returned states.
   */
  getHistoryStates(tMin = -Infinity, tMax = Infinity): Array<{ time: number; state: SimulationState }> {
    const out = this.stateHistory.statesInRange(tMin, tMax);
    const t = this.state.time;
    if (t >= tMin && t <= tMax && (out.length === 0 || t > out[out.length - 1].time + 1e-9)) {
      out.push({ time: t, state: this.state });
    }
    return out;
  }

  /** The recorded step just before/after `step`, for single-step buttons. */
  adjacentStep(step: number, direction: -1 | 1): number | null {
    return direction < 0 ? this.stateHistory.prevStep(step) : this.stateHistory.nextStep(step);
  }

  /**
   * Get information about available state history.
   */
  getHistoryInfo(): {
    count: number;
    oldestTime: number;
    newestTime: number;
    currentIndex: number;
    currentTime: number;
    currentStepNumber: number;
  } {
    return this.stateHistory.getInfo();
  }

  /**
   * Get list of all snapshots for UI display.
   */
  getSnapshotList(): Array<{ index: number; simTime: number; stepNumber: number; isSecondMarker: boolean }> {
    return this.stateHistory.getSnapshotList();
  }

  /**
   * Find the closest available snapshot time to a target time.
   * Returns null if no history.
   */
  findClosestHistoryTime(targetTime: number): number | null {
    const snapshot = this.stateHistory.findClosestToTime(targetTime);
    return snapshot ? snapshot.simTime : null;
  }
}
