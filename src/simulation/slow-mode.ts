/**
 * Slow mode: projective integration for day-scale transients.
 *
 * See docs/slow-mode-design.md ("rate-based (quiescent) jumping"). The plant
 * always contains fast modes (acoustics, flow ringing, small near-empty
 * nodes) whose stability limits hold the integrator at tens of milliseconds,
 * even when everything that matters - decay heat, fuel and graphite
 * temperatures, inventories - is drifting over hours. Forcing a big dt
 * through an explicit integrator blows those modes up. Projective
 * integration (Gear & Kevrekidis) side-steps them instead:
 *
 *   1. RELAX: integrate normally for a short while, so whatever the last jump
 *      disturbed in the fast modes damps back onto the slow manifold.
 *   2. MEASURE: keep integrating normally, sampling every integrated state
 *      variable, and least-squares fit each one with a straight line: its
 *      slope is the drift rate at the middle of the window, and the fit's
 *      residual - fast ringing, a feed train sloshing - prices how uncertain
 *      that slope is.
 *   3. JUMP: consecutive windows give the curvature (change of slope between
 *      window centres, over a long baseline, so little noise) and, with a
 *      third window, the change of curvature. Every integrated variable is
 *      moved forward along the extrapolated drift in one go, the clock
 *      advances by J, and everything algebraic (pressure, temperature, phase,
 *      OTSG partition) is re-derived through the solver's own constraint
 *      chain. J is the largest jump whose predicted extrapolation error - rate
 *      uncertainty x J, curvature uncertainty x J^2/2, change of curvature x
 *      J^3/6 - stays inside each variable's tolerance, never so far that a
 *      non-negative inventory would be extrapolated through zero, never
 *      most of the way (reliefApproachFraction) from a shut relief valve's
 *      sensed pressure to its setpoint, and never past the next scripted
 *      scenario event. The first window after a reset
 *      only measures: one slope says nothing about curvature.
 *   4. VERIFY: the next window measures the slope again. If it moved by more
 *      than the last jump's error budget allowed, the jump ceiling halves; if
 *      it held, it doubles. A nonlinear event the curvature did not foresee
 *      is therefore caught one window late at worst.
 *
 * Every step of the jump is linear in the measured data, so any quantity that
 * the real dynamics conserve exactly (total water, energy and gas moles of a
 * closed system) is conserved exactly by the jump too: the fitted rates of a
 * conserved total sum to zero.
 *
 * What is NOT extrapolated: connection flows and pump speeds (fast states,
 * re-solved/relaxed within a step or two of the next window). Accepted-state
 * accumulators owned by post-accept operators (creep damage, controller
 * scans, actuator stroke, battery and diesel stores, relief-valve latches)
 * are advanced by running those operators once with dt = J on the jumped
 * state - exactly what they would do for one long accepted step.
 *
 * The tolerance weights below (heat capacities, significance floors) are
 * ERROR-NORM weights, not physics: they only decide how far a jump may go.
 */

import type { SimulationState } from './types';
import { ALL_GAS_SPECIES } from './gas-properties';
import { cloneSimulationState } from './solver';
import type { RK45Solver } from './rk45-solver';
import type { SolverMetrics } from './types';
import { nodeHeatCapacity } from './operators/rate-operators';
import { DECAY_HEAT_GROUPS } from './operators/neutronics';

/** One measurement window's straight-line fits (see tryJump) */
interface WindowFit {
  keys: string[];            // slot structure (identity = same structure)
  tc: number;                // window centre (s plant time)
  slope: Float64Array;       // fitted rate at tc
  seSlope: Float64Array;     // its standard error
  curv?: Float64Array;       // (slope - previous slope) / centre spacing
  seCurv?: Float64Array;
  J: number;                 // jump taken after this window (0 = none)
  quadratic: boolean;        // ... and whether it extrapolated quadratically
  tau?: Float64Array;        // ... per slot: > 0 = extrapolated as this exponential
  tol: Float64Array;         // tolerances used for that jump
  /** Observed (not integrated, not extrapolated) quantities: each relief
   *  valve's sensed pressure, fitted like a slot so a jump can be kept
   *  short of the setpoint (see RELIEF SETPOINTS in tryJump) */
  obs: Map<string, { slope: number; se: number }>;
}

/** A relief valve lifting, caught on the accepted substep it lifted on */
interface LiftEvent {
  valve: string;
  time: number;
  values: Float64Array;          // every integrated slot, in visit order
  obs: Float64Array;             // every relief valve's sensed pressure
  sig: string;                   // discreteSignature at that instant
  lifts: Map<string, number>;    // every relief valve's lift count
}

/**
 * A measurement window locked to one relief valve's lift cycle (see LIFT
 * CYCLES in advanceChunk): it opened on a lift of `valve`, and closes on a
 * later one at the same discrete configuration, so its ends sit at the same
 * point of the cycle.
 */
interface CycleLock {
  valve: string;
  sig: string;
  marks: { time: number; values: Float64Array; obs: Float64Array; lifts: Map<string, number> }[];
}

/** Sums over one run of consecutive samples of a window (SLOPE NOISE) */
interface SampleBlock {
  n: number; t: number; tt: number;      // sum 1, t, t^2
  sx: Float64Array; sxt: Float64Array;   // per slot: sum x, x t
  osx: Float64Array; osxt: Float64Array; // per observed relief pressure
}

/** Fewest blocks a full window's slope noise is estimated from */
const NOISE_BLOCKS = 8;

/** How much less certain a white-noise slope is from a window half as long:
 *  its standard error goes as (window length)^-1.5 */
const SHORTER_WINDOW_NOISE = Math.pow(2, 1.5);

export interface SlowModeConfig {
  /** Normal integration after each jump before measuring (s plant time) */
  relaxSeconds: number;
  /** Measurement window (s plant time). This is the shortest; it doubles
   *  (up to maxMeasureSeconds) while the variable limiting the jump is
   *  oscillating on a period the window cannot average over, and halves
   *  again after a jump taken with error room to spare. */
  measureSeconds: number;
  maxMeasureSeconds: number;
  /** Sampling interval inside the measurement window (s) */
  sampleSeconds: number;
  /** Relative tolerance per jump on inventories (mass, moles, fractions, power) */
  relTol: number;
  /** Temperature-equivalent tolerance per jump (K) on solid and fluid energies */
  tempTol: number;
  /** Absolute tolerance floor per jump on any one node's water, gas moles,
   *  solid mass or fission-product inventory, as a fraction of the plant's
   *  total of that kind. A small node (a valve body, a pump casing, one axial
   *  zone of tube metal) is a fast mode: its error is re-settled by the next
   *  relax phase and only matters through what it lends to or borrows from
   *  the plant, so it is judged against the plant, not against itself. */
  absTolFraction: number;
  /** Energy counterpart of absTolFraction, as a plant-average temperature:
   *  no one node's energy error need be smaller than the energy that warms
   *  the whole plant (fluid + solids) by this much */
  plantEnergyTolKelvin: number;
  /** Truncation error (the part of the extrapolation error that has the
   *  same sign jump after jump and so ADDS UP) is budgeted per this much
   *  skipped plant time: a variable's tolerance is the most it may drift
   *  systematically per accuracyHorizon of jumping. Measurement noise is
   *  random from window to window and keeps a per-jump budget. */
  accuracyHorizon: number;
  /** Confidence multiplier on the fitted rate/curvature standard errors */
  confidence: number;
  /** Jumps shorter than this multiple of one relaxSeconds + measureSeconds
   *  cycle are not worth taking. (Of the SHORTEST window, not the current
   *  one: a window that has lengthened to average an oscillation costs the
   *  same whether its jump is taken or not, and refusing a 230 s jump
   *  because the window was 640 s threw that window away.) */
  minJumpFactor: number;
  /** Starting jump ceiling (s); doubles per verified jump, halves per failed one */
  initialMaxJump: number;
  /** Absolute jump ceiling (s) */
  maxJump: number;
  /** Fraction of the gap between a shut relief valve's sensed pressure and
   *  its setpoint that one jump may close (rate taken at the top of its
   *  noise band). Successive jumps approach the setpoint geometrically and
   *  the last stretch, once a jump would be shorter than worth taking, is
   *  integrated normally: a larger fraction leaves less of it. At 0.8 the
   *  pressure must rise 25% faster than the upper edge of its measured rate
   *  to overshoot. */
  reliefApproachFraction: number;
  /** Record the tightest per-slot jump limits of every window (getLimits) */
  diagnose?: boolean;
  /** false turns off the post-jump settling test (for A/B runs only) */
  settleTest?: boolean;
}

export const DEFAULT_SLOW_MODE_CONFIG: SlowModeConfig = {
  relaxSeconds: 20,
  measureSeconds: 40,
  maxMeasureSeconds: 640,
  sampleSeconds: 0.5,
  relTol: 1e-3,
  tempTol: 0.5,
  absTolFraction: 1e-4,
  plantEnergyTolKelvin: 0.01,
  accuracyHorizon: 3600,
  confidence: 2,
  minJumpFactor: 0.5,
  initialMaxJump: 120,
  maxJump: 3600,
  reliefApproachFraction: 0.8,
};

// Tolerance kinds (see tolerances())
const K_MASS = 0, K_ENERGY = 1, K_MOL = 2, K_TEMP = 3, K_SOLID_MASS = 4,
  K_FRACTION = 5, K_INVENTORY = 6, K_POWER = 7, K_PRECURSOR = 8, K_PASSIVE = 9,
  K_PART_MASS = 10, K_PART_ENERGY = 11, K_DAMAGE = 12,
  // Decay-heat pools: not fitted - their equation is known (see DECAY POOLS)
  K_DECAY_POOL = 13;

/**
 * HOLDING: a variable that sits within its tolerance of a bound it is heading
 * for (trace oxygen being eaten as fast as it arrives, an emptying OTSG
 * economizer slug, burn-off reaching 1) is held where it is during the jump.
 * The true value lies between where it is and the bound, so holding costs at
 * most the tolerance - for a conserved inventory, at most that much created
 * or destroyed, which is what the tolerance allows by definition - whereas
 * the halfway-to-the-bound rule would cap every jump at half the decay time
 * of something already negligible. A water-dominated node whose water is
 * held keeps its energy (and OTSG partition) with it, so the node stays a
 * state the equation of state recognises.
 */

/** Kinds integrated by linear first-order kinetics with no conservation
 *  constraint (fission power, precursors, decay-heat groups): when the data
 *  say one is relaxing, it is extrapolated as the exponential it is, which a
 *  polynomial cannot follow past a fraction of its time constant. */
const EXPONENTIAL = new Set([K_POWER, K_PRECURSOR]);

/** Oxidation fractions (graphite burn-off, cladding oxide) are judged by the
 *  heat of the oxidation an error stands for, against the same plant-level
 *  energy floor as everything else: C -> CO releases ~9-10 MJ/kg (32.8 to
 *  CO2), Zr -> ZrO2 ~6.5 MJ/kg. Error-norm weights, not physics. */
const CARBON_OXIDATION_WEIGHT = 1e7;   // J per kg of carbon burned
const ZR_OXIDATION_WEIGHT = 6.5e6;     // J per kg of Zr oxidized
/** TRISO damage integral: failures go as Phi(ln D / s), negligible below this */
const DAMAGE_FLOOR = 1e-4;

/** Error-norm heat-capacity weights (J/kg/K for water, J/mol/K for gas) */
const WATER_CP_WEIGHT = 4186;
const GAS_CV_WEIGHT = 20.8;

/**
 * Visit every integrated state variable in a fixed order. `owner` is the
 * flow-node id an energy/mass slot belongs to (for the energy weights), or ''.
 * `set` is only called on the private clone being jumped.
 */
type Visitor = (key: string, kind: number, value: number, lo: number, hi: number,
  set: (v: number) => void, owner: string) => void;

function visitIntegratedState(state: SimulationState, visit: Visitor): void {
  for (const [id, node] of state.flowNodes) {
    if (node.isBoundary) continue;
    const f = node.fluid;
    visit(`${id}.m`, K_MASS, f.mass, 0, Infinity, v => { f.mass = v; }, id);
    visit(`${id}.U`, K_ENERGY, f.internalEnergy, -Infinity, Infinity, v => { f.internalEnergy = v; }, id);
    if (f.ncg) {
      const g = f.ncg as unknown as Record<string, number>;
      for (const sp of ALL_GAS_SPECIES) {
        visit(`${id}.${sp}`, K_MOL, g[sp] ?? 0, 0, Infinity, v => { g[sp] = v; }, id);
      }
    }
    const o = node.otsg;
    if (o) {
      visit(`${id}.m1`, K_PART_MASS, o.m1, 0, Infinity, v => { o.m1 = v; }, id);
      visit(`${id}.U1`, K_PART_ENERGY, o.U1, 0, Infinity, v => { o.U1 = v; }, id);
    }
    if (node.depositedCsI !== undefined) {
      visit(`${id}.CsIdep`, K_INVENTORY, node.depositedCsI, 0, Infinity, v => { node.depositedCsI = v; }, '');
    }
  }
  for (const [id, t] of state.thermalNodes) {
    visit(`${id}.T`, K_TEMP, t.temperature, 0, Infinity, v => { t.temperature = v; }, id);
    visit(`${id}.mass`, K_SOLID_MASS, t.mass, 0, Infinity, v => { t.mass = v; }, '');
    const ox = t.oxidation;
    if (ox) visit(`${id}.ox`, K_FRACTION, ox.oxidizedFraction, 0, 1, v => { ox.oxidizedFraction = v; }, `ox:${id}`);
    const go = t.graphiteOxidation;
    if (go) {
      // Node mass follows burn-off unless the node integrates its own pieces
      // (applyRatesToState); both are extrapolated linearly from the same fit,
      // so they stay consistent to the fit's linearity.
      visit(`${id}.burn`, K_FRACTION, go.burnoff, 0, 1, v => { go.burnoff = v; }, `burn:${id}`);
      const layers = go.layers?.burnoff;
      if (layers) {
        for (let i = 0; i < layers.length; i++) {
          visit(`${id}.layer${i}`, K_FRACTION, layers[i], 0, 1, v => { layers[i] = v; }, `layer:${id}`);
        }
      }
    }
    const fp = t.fissionProducts;
    if (fp) {
      visit(`${id}.fpNoble`, K_INVENTORY, fp.nobleGas, 0, Infinity, v => { fp.nobleGas = v; }, '');
      visit(`${id}.fpVol`, K_INVENTORY, fp.volatile, 0, Infinity, v => { fp.volatile = v; }, '');
      if (fp.trisoDamage !== undefined) {
        visit(`${id}.triso`, K_DAMAGE, fp.trisoDamage, 0, Infinity, v => { fp.trisoDamage = v; }, '');
      }
    }
    const metal = t.metal;
    if (metal) {
      visit(`${id}.zr`, K_SOLID_MASS, metal.zr, 0, Infinity, v => { metal.zr = v; }, '');
      visit(`${id}.fe`, K_SOLID_MASS, metal.fe, 0, Infinity, v => { metal.fe = v; }, '');
    }
    if (t.slagMass !== undefined) {
      visit(`${id}.slag`, K_SOLID_MASS, t.slagMass, 0, Infinity, v => { t.slagMass = v; }, '');
    }
  }
  const n = state.neutronics;
  visit('neutronics.power', K_POWER, n.power, 0, Infinity, v => { n.power = v; }, '');
  visit('neutronics.C', K_PRECURSOR, n.precursorConcentration, 0, Infinity, v => { n.precursorConcentration = v; }, '');
  const pools = n.decayHeatPools;
  if (pools) {
    for (let i = 0; i < pools.length; i++) {
      visit(`neutronics.pool${i}`, K_DECAY_POOL, pools[i], 0, Infinity, v => { pools[i] = v; }, '');
    }
  }
  // Pure accumulators of boundary releases: extrapolated with everything
  // else, never a reason to shorten a jump
  const rel = state.environmentalRelease as unknown as Record<string, number> | undefined;
  if (rel) {
    for (const sp of ALL_GAS_SPECIES) {
      visit(`release.${sp}`, K_PASSIVE, rel[sp] ?? 0, -Infinity, Infinity, v => { rel[sp] = v; }, '');
    }
  }
  const sw = state.surfaceWater?.volumes;
  if (sw) {
    for (const [basin, vol] of sw) {
      visit(`surface.${basin}`, K_PASSIVE, vol, -Infinity, Infinity, v => { sw.set(basin, v); }, '');
    }
  }
}

/**
 * Discrete configuration that, if it changes inside a window, makes the
 * window's fit meaningless (a burst opened a new path, a scenario event
 * fired, a relief valve popped, a pump was switched).
 */
function discreteSignature(state: SimulationState): string {
  const parts: string[] = [];
  parts.push(`c${state.flowConnections.length}`);
  parts.push(`s${state.scenario?.fired ?? 0}`);
  if (state.burstStates) {
    for (const [id, b] of state.burstStates) if (b.isBurst) parts.push(`b:${id}`);
  }
  for (const [id, v] of state.components.valves) if (v.reliefOpen) parts.push(`r:${id}`);
  for (const [id, p] of state.components.pumps) if (p.running) parts.push(`p:${id}`);
  return parts.join('|');
}

export interface SlowModeJump {
  time: number;          // plant time the jump started from (s)
  jump: number;          // s of plant time skipped
  limitedBy: string;     // slot (or rule) that set the length
  detail?: string;       // the limiting slot's fit (diagnostics)
}

export interface SlowModeStatus {
  phase: 'relax' | 'measure';
  jumps: number;
  jumpedSeconds: number;
  maxJump: number;
  last?: SlowModeJump;
  /** Why the last completed window did not jump (empty if it did) */
  lastHold: string;
}

/**
 * Wraps a solver's advance(). Normal integration in between jumps is the
 * solver's own; this only samples, fits, and jumps.
 */
export class SlowModeController {
  private config: SlowModeConfig;
  private phase: 'relax' | 'measure' = 'relax';
  private phaseStart = NaN;
  private signature = '';
  private keys: string[] = [];
  private kinds: number[] = [];
  private nextSample = NaN;
  // Least-squares accumulators. Time is measured from the window start;
  // values are offsets from the first sample (no cancellation in sum x^2).
  private n = 0;
  private st = [0, 0, 0];   // sum t^k, k = 0..2
  private x0: Float64Array = new Float64Array(0);
  private sx: Float64Array = new Float64Array(0);
  private sxt: Float64Array = new Float64Array(0);
  private sxx: Float64Array = new Float64Array(0);
  // The same accumulators for the observed relief-valve pressures (valve id
  // -> index), offsets from their first sample
  private obsIds: string[] = [];
  private ox0: Float64Array = new Float64Array(0);
  private osx: Float64Array = new Float64Array(0);
  private osxt: Float64Array = new Float64Array(0);
  private osxx: Float64Array = new Float64Array(0);
  // The same sums kept per consecutive block of samples (see SLOPE NOISE in
  // tryJump). Blocks hold blockSize samples each; when 2 x NOISE_BLOCKS of
  // them are full they are merged in pairs, so a window of any length ends
  // with NOISE_BLOCKS..2 x NOISE_BLOCKS blocks.
  private blocks: SampleBlock[] = [];
  private blockSize = 1;
  private jmax: number;
  private measure: number;
  private lock: CycleLock | null = null;
  private lastLift = new Map<string, number>();
  // Fits of the most recent windows (newest first), all with the same slot
  // structure and no discrete change between them
  private windows: WindowFit[] = [];
  /** Jump limit the last window's SETTLING test gave, if it held for it (0: it did not) */
  private lastSettleLimit = 0;
  private status: SlowModeStatus;

  constructor(config: Partial<SlowModeConfig> = {}) {
    this.config = { ...DEFAULT_SLOW_MODE_CONFIG, ...config };
    this.jmax = this.config.initialMaxJump;
    this.measure = this.config.measureSeconds;
    this.status = { phase: 'relax', jumps: 0, jumpedSeconds: 0, maxJump: this.jmax, lastHold: '' };
  }

  private lastLimits: { key: string; J: number; detail: string }[] = [];
  /** With config.diagnose: the ten tightest error-budget jump limits of the last window */
  getLimits(): { key: string; J: number; detail: string }[] {
    return this.lastLimits;
  }

  getStatus(): SlowModeStatus {
    return { ...this.status, phase: this.phase, maxJump: this.jmax };
  }

  /** Forget the current window (the plant was edited, rewound, ...). */
  reset(): void {
    this.phase = 'relax';
    this.phaseStart = NaN;
    this.windows = [];
    this.lock = null;
    this.lastLift.clear();
  }

  /**
   * Advance by requestedDt of normal integration, plus whatever jump falls
   * due at the end of a measurement window inside it.
   */
  advance(solver: RK45Solver, state: SimulationState, requestedDt: number, wallFrameTimeMs?: number): {
    state: SimulationState; metrics: SolverMetrics; jump?: SlowModeJump;
  } {
    let s = state;
    let remaining = requestedDt;
    let metrics: SolverMetrics | undefined;
    let steps = 0, retries = 0;
    const merged = (): SolverMetrics => ({ ...metrics!, subcycleCount: steps, retriesThisFrame: retries });
    // Returns after a jump, so the caller can treat the jumped state like an
    // input (history snapshot) before anything else integrates from it
    // (1e-9 s is the tolerance every window boundary below is tested with:
    // a remainder smaller than that is rounding, not time left to integrate)
    while (remaining > 1e-9) {
      const r = this.advanceChunk(solver, s, remaining, wallFrameTimeMs);
      const covered = r.covered;
      s = r.state;
      metrics = r.metrics;
      steps += r.metrics.subcycleCount;
      retries += r.metrics.retriesThisFrame;
      remaining -= covered;
      if (r.jump) return { state: s, metrics: merged(), jump: r.jump };
      // The interactive solver yields on its wall-clock budget
      if (r.yielded) break;
    }
    if (!metrics) metrics = solver.advance(s, 0).metrics;
    return { state: s, metrics: merged() };
  }

  /** One solver.advance up to the next window boundary, then the bookkeeping. */
  private advanceChunk(solver: RK45Solver, state: SimulationState, requestedDt: number, wallFrameTimeMs?: number): {
    state: SimulationState; metrics: SolverMetrics; covered: number; yielded: boolean; jump?: SlowModeJump;
  } {
    if (!Number.isFinite(this.phaseStart)) this.startRelax(state.time);
    // Sample on the measurement grid: never step past the next sample time
    // - but a boundary that coincides with the end of the request to within
    // rounding does not split it. (The sample grid and the caller's ticks
    // both advance in steps of sampleSeconds from a time that, after a jump,
    // is not a round number, and drift apart by ~1e-10 s. Splitting there
    // sent the solver a 1e-10 s advance every tick, whose one tiny step reset
    // its step size: 12 steps per half second instead of 5, in every window
    // after the first jump.)
    let dt = requestedDt;
    const boundary = this.phase === 'measure' ? this.nextSample : this.phaseStart + this.config.relaxSeconds;
    if (boundary - state.time < dt - 1e-9) dt = Math.max(boundary - state.time, 1e-6);
    // Catch relief-valve lifts on the accepted substep they happen on (the
    // chunk can end up to a sample interval later, and in that time a lift
    // discharges kilograms): chained onto whatever the caller records with
    let lift: LiftEvent | undefined;
    const prevCb = solver.onSubstepComplete;
    solver.onSubstepComplete = (st, n, adt) => {
      prevCb?.(st, n, adt);
      for (const [id, v] of st.components.valves) {
        if (!v.relief) continue;
        const count = v.liftCount ?? 0;
        const before = this.lastLift.get(id);
        this.lastLift.set(id, count);
        if (before !== undefined && count > before && this.phase === 'measure') {
          lift = { valve: id, time: st.time, values: snapshotValues(st), obs: reliefPressures(st),
            sig: discreteSignature(st), lifts: liftCounts(st) };
        }
      }
    };
    let r: ReturnType<RK45Solver['advance']>;
    try {
      r = solver.advance(state, dt, wallFrameTimeMs);
    } finally {
      solver.onSubstepComplete = prevCb;
    }
    const s = r.state;
    const covered = s.time - state.time;
    const out = { state: s, metrics: r.metrics, covered, yielded: covered < dt * (1 - 1e-9) };

    if (this.phase === 'relax') {
      if (s.time >= this.phaseStart + this.config.relaxSeconds - 1e-9) this.startMeasure(s);
      return out;
    }

    // LIFT CYCLES. A relief valve lifting inside a window used to discard
    // it, so a valve cycling every few tens of seconds never let the plant
    // jump at all. Now the lift ANCHORS the window instead: it restarts on
    // that lift, locked to that valve, and closes on a later lift of the same
    // valve once it has run its length - provided every other valve is in
    // the same open/shut state as at the opening lift. Both ends then sit at
    // the same point of the cycle, so the change between them divided by the
    // time between them is the cycle-AVERAGE drift of every slot, with the
    // sawtooth cancelled out exactly; the spread of the per-cycle drifts
    // prices its noise. The lift rate is measured the same way and the lift
    // counters advance with it over the jump (fractionally - every lift the
    // jump skipped still counts). A valve whose cycle is longer than the
    // window does not close one: once the window has run its length with no
    // second lift it becomes an ordinary window on the ramp, which is jumped
    // short of the setpoint (RELIEF SETPOINTS in tryJump).
    const sig = discreteSignature(s);
    const otherChange = withoutRelief(sig) !== withoutRelief(this.signature);
    if (otherChange || (!this.lock && !lift && sig !== this.signature)) {
      this.status.lastHold = 'discrete change in window';
      this.windows = [];
      this.lock = null;
      this.startRelax(s.time);
      return out;
    }
    if (!this.lock && lift) {
      if (!this.startLocked(s, lift)) {
        this.status.lastHold = 'state structure changed in window';
        this.windows = [];
        this.lock = null;
        this.startRelax(s.time);
      }
      return out;
    }
    if (s.time >= this.nextSample - 1e-9) {
      if (!this.sample(s)) {
        this.status.lastHold = 'state structure changed in window';
        this.windows = [];
        this.lock = null;
        this.startRelax(s.time);
        return out;
      }
      this.nextSample += this.config.sampleSeconds;
    }

    if (this.lock) {
      const lock = this.lock;
      if (lift && lift.valve === lock.valve && lift.sig === lock.sig) {
        lock.marks.push({ time: lift.time, values: lift.values, obs: lift.obs, lifts: lift.lifts });
        if (lift.time - this.phaseStart >= this.measure - 1e-9) {
          const jumped = this.tryJump(solver, s, lock);
          this.lock = null;
          this.startRelax(jumped.state.time);
          return { ...out, state: jumped.state, jump: jumped.jump };
        }
      }
      // A full window gone by without a second lift: this cycle is longer
      // than the window. Whether to average over it or jump along it is
      // decided by what a jump along it could cover: the window so far IS a
      // measurement of the ramp (it began on the lift), and a jump may take
      // the valve's sensed pressure reliefApproachFraction of the way to the
      // setpoint, which at the measured rate of rise is that fraction of the
      // time left to the next lift.
      //  - If that is as long as a jump may be anyway (the jump ceiling),
      //    there is nothing to gain by waiting: the window is closed here as
      //    an ordinary one and jumps along the ramp. (Waiting for the second
      //    lift regardless held every jump off for as long as the valve
      //    stayed shut.)
      //  - If not, the next lift is nearer than a jump is long: the window
      //    stays locked and closes on it as one whole cycle, whose jump the
      //    setpoint does not limit. (Starting a fresh window on the ramp
      //    here instead left a dead zone: a valve lifting every 1.3-2.5
      //    windows - xe100-sbo's steam safety valve at ~450 s against a 320 s
      //    window - always lifted again before the fresh window finished, and
      //    the plant never jumped at all.)
      // Asked again at every sample, so a pressure that levels off short of
      // the setpoint ends up on the first branch by itself.
      if (lock.marks.length === 1 && s.time - this.phaseStart >= this.measure - 1e-9 && this.n >= 6) {
        const j = this.obsIds.indexOf(lock.valve);
        const [s0, s1, s2] = this.st;
        const tcRel = s1 / s0;
        const rise = (this.osxt[j] - this.osx[j] * tcRel) / (s2 - s0 * tcRel * tcRel);
        const valve = s.components.valves.get(lock.valve)!;
        const gap = valve.relief!.setpoint - reliefSensedPressure(s, lock.valve);
        const rampJump = rise > 0 ? this.config.reliefApproachFraction * gap / rise : Infinity;
        if (!valve.reliefOpen && rampJump >= this.jmax) {
          this.lock = null;
          this.signature = sig;
          const jumped = this.tryJump(solver, s);
          this.startRelax(jumped.state.time);
          return { ...out, state: jumped.state, jump: jumped.jump };
        }
        this.status.lastHold = lock.valve + ' next lift too close to jump the ramp: averaging the whole cycle';
      }
      return out;
    }
    if (s.time < this.phaseStart + this.measure - 1e-9) return out;

    const jumped = this.tryJump(solver, s);
    this.startRelax(jumped.state.time);
    return { ...out, state: jumped.state, jump: jumped.jump };
  }

  /** Restart the window on a lift, locked to that valve's cycle. */
  private startLocked(s: SimulationState, lift: LiftEvent): boolean {
    this.startMeasure(s);
    if (lift.values.length !== this.keys.length || lift.obs.length !== this.obsIds.length) return false;
    const N = this.keys.length, M = this.obsIds.length;
    this.phaseStart = lift.time;
    this.signature = lift.sig;
    this.x0 = Float64Array.from(lift.values);
    this.ox0 = Float64Array.from(lift.obs);
    this.sx = new Float64Array(N); this.sxt = new Float64Array(N); this.sxx = new Float64Array(N);
    this.osx = new Float64Array(M); this.osxt = new Float64Array(M); this.osxx = new Float64Array(M);
    this.n = 0;
    this.st = [0, 0, 0];
    this.blocks = [];
    this.blockSize = 1;
    if (!this.sample(s)) return false;
    this.nextSample = s.time + this.config.sampleSeconds;
    this.lock = { valve: lift.valve, sig: lift.sig,
      marks: [{ time: lift.time, values: lift.values, obs: lift.obs, lifts: lift.lifts }] };
    this.status.lastHold = 'window locked to ' + lift.valve + ' lift cycle';
    return true;
  }

  /** Double the measurement window (an oscillation it cannot average) */
  private lengthenWindow(t: number, why: string): void {
    this.measure = Math.min(this.config.maxMeasureSeconds, 2 * this.measure);
    this.windows = [];
    console.warn(`[SlowMode] t=${t.toFixed(0)}: ${why} oscillates on a period the window cannot ` +
      `average; measurement window -> ${this.measure.toFixed(0)} s`);
  }

  private startRelax(t: number): void {
    this.phase = 'relax';
    this.phaseStart = t;
  }

  private startMeasure(s: SimulationState): void {
    this.phase = 'measure';
    this.phaseStart = s.time;
    this.signature = discreteSignature(s);
    const keys: string[] = [];
    const kinds: number[] = [];
    visitIntegratedState(s, (key, kind) => { keys.push(key); kinds.push(kind); });
    // Same structure as the last window: keep the same array, which is how
    // the previous window's fit is recognised as comparable
    const same = keys.length === this.keys.length && keys.every((k, i) => k === this.keys[i]);
    if (!same) {
      this.keys = keys;
      this.kinds = kinds;
    }
    const N = keys.length;
    this.x0 = new Float64Array(N);
    this.sx = new Float64Array(N);
    this.sxt = new Float64Array(N);
    this.sxx = new Float64Array(N);
    this.n = 0;
    this.st = [0, 0, 0];
    let i = 0;
    visitIntegratedState(s, (_k, _kind, value) => { this.x0[i++] = value; });
    this.obsIds = [];
    for (const [id, v] of s.components.valves) if (v.relief) this.obsIds.push(id);
    const M = this.obsIds.length;
    this.ox0 = new Float64Array(M);
    this.osx = new Float64Array(M);
    this.osxt = new Float64Array(M);
    this.osxx = new Float64Array(M);
    this.blocks = [];
    this.blockSize = 1;
    this.obsIds.forEach((id, j) => { this.ox0[j] = reliefSensedPressure(s, id); });
    this.nextSample = s.time;
    this.sample(s);
    this.nextSample += this.config.sampleSeconds;
  }

  private sample(s: SimulationState): boolean {
    const t = s.time - this.phaseStart;
    let i = 0;
    let ok = true;
    const N = this.keys.length;
    const M = this.obsIds.length;
    let blk = this.blocks[this.blocks.length - 1];
    if (!blk || blk.n >= this.blockSize) {
      if (this.blocks.length >= 2 * NOISE_BLOCKS) {
        // every block is full: merge them in pairs and fill twice as many
        // samples into each from here on
        const merged: SampleBlock[] = [];
        for (let b = 0; b < this.blocks.length; b += 2) {
          const p = this.blocks[b], q = this.blocks[b + 1];
          p.n += q.n; p.t += q.t; p.tt += q.tt;
          for (let k = 0; k < N; k++) { p.sx[k] += q.sx[k]; p.sxt[k] += q.sxt[k]; }
          for (let k = 0; k < M; k++) { p.osx[k] += q.osx[k]; p.osxt[k] += q.osxt[k]; }
          merged.push(p);
        }
        this.blocks = merged;
        this.blockSize *= 2;
      }
      blk = { n: 0, t: 0, tt: 0, sx: new Float64Array(N), sxt: new Float64Array(N),
        osx: new Float64Array(M), osxt: new Float64Array(M) };
      this.blocks.push(blk);
    }
    const bsx = blk.sx, bsxt = blk.sxt;
    visitIntegratedState(s, (key, _kind, value) => {
      if (i >= N || key !== this.keys[i]) { ok = false; i++; return; }
      const x = value - this.x0[i];
      this.sx[i] += x;
      this.sxt[i] += x * t;
      this.sxx[i] += x * x;
      bsx[i] += x;
      bsxt[i] += x * t;
      i++;
    });
    if (!ok || i !== N) return false;
    for (let j = 0; j < M; j++) {
      const x = reliefSensedPressure(s, this.obsIds[j]) - this.ox0[j];
      this.osx[j] += x;
      this.osxt[j] += x * t;
      this.osxx[j] += x * x;
      blk.osx[j] += x;
      blk.osxt[j] += x * t;
    }
    blk.n++; blk.t += t; blk.tt += t * t;
    this.n++;
    let tk = 1;
    for (let k = 0; k < 3; k++) { this.st[k] += tk; tk *= t; }
    return true;
  }

  /** Per-slot tolerances from the current state (see SlowModeConfig). */
  private tolerances(s: SimulationState): Float64Array {
    const c = this.config;
    let totalWater = 0, totalMol = 0, plantHeatCap = 0, totalSolid = 0, totalFp = 0;
    const contents = new Map<string, { m: number; mol: number; U: number }>();
    for (const [id, node] of s.flowNodes) {
      if (node.isBoundary) continue;
      let mol = 0;
      if (node.fluid.ncg) {
        const g = node.fluid.ncg as unknown as Record<string, number>;
        for (const sp of ALL_GAS_SPECIES) mol += g[sp] ?? 0;
      }
      contents.set(id, { m: node.fluid.mass, mol, U: node.fluid.internalEnergy });
      totalWater += node.fluid.mass;
      totalMol += mol;
      plantHeatCap += node.fluid.mass * WATER_CP_WEIGHT + mol * GAS_CV_WEIGHT;
      totalFp += node.depositedCsI ?? 0;
    }
    const solidHeatCap = new Map<string, number>();
    for (const [id, t] of s.thermalNodes) {
      const C = nodeHeatCapacity(t);
      solidHeatCap.set(id, C);
      plantHeatCap += C;
      totalSolid += t.mass;
      if (t.fissionProducts) totalFp += t.fissionProducts.nobleGas + t.fissionProducts.volatile;
    }
    const massFloor = c.absTolFraction * totalWater;
    const molFloor = Math.max(1e-9, c.absTolFraction * totalMol);
    const solidFloor = Math.max(1e-6, c.absTolFraction * totalSolid);
    const fpFloor = Math.max(1e-30, c.absTolFraction * totalFp);
    const energyFloor = Math.max(1, plantHeatCap * c.plantEnergyTolKelvin);
    // A node's energy tolerance is the larger of a temperature-equivalent
    // error on its whole contents, the plant-level floor, and the energy its
    // mass and mole tolerances CARRY: an error of massTol kilograms moves
    // massTol x u of energy with it, so holding the energy tighter than the
    // mass is meaningless. Weighted by heat capacity, and never more material
    // than the node actually holds.
    const energyTol = (id: string): number => {
      const n = contents.get(id);
      if (!n) return energyFloor;
      const C = n.m * WATER_CP_WEIGHT + n.mol * GAS_CV_WEIGHT;
      const mTol = Math.max(c.relTol * n.m, massFloor);
      const nTol = Math.max(c.relTol * n.mol, molFloor);
      const Ctol = Math.min(mTol, n.m) * WATER_CP_WEIGHT + Math.min(nTol, n.mol) * GAS_CV_WEIGHT;
      const carried = C > 0 ? Math.abs(n.U) * Ctol / C : 0;
      return Math.max(c.tempTol * C, carried, energyFloor);
    };
    // Fission power and every decay-heat group are judged against the core's
    // total heat output (a decaying group is significant only as part of it)
    const n = s.neutronics;
    const corePower = n.power + (n.decayHeatPools ?? []).reduce((x, y) => x + y, 0);
    const powerFloor = Math.max(1e-4 * Math.max(n.nominalPower, 1), corePower);
    // Precursor level that would hold powerFloor through the prompt jump
    const precursorFloor = powerFloor / Math.max(n.nominalPower, 1) *
      n.delayedNeutronFraction / (n.precursorDecayConstant * n.promptNeutronLifetime);

    const tol = new Float64Array(this.keys.length);
    let i = 0;
    visitIntegratedState(s, (_key, kind, value, _lo, _hi, _set, owner) => {
      const a = Math.abs(value);
      let t: number;
      switch (kind) {
        case K_MASS: case K_PART_MASS: t = Math.max(c.relTol * a, massFloor, 1e-6); break;
        case K_ENERGY: case K_PART_ENERGY: t = energyTol(owner); break;
        case K_MOL: t = Math.max(c.relTol * a, molFloor); break;
        // A light solid (one zone of tube metal) is a fast mode like a small
        // fluid node: its temperature error is worth the plant-level energy
        case K_TEMP: t = Math.max(c.tempTol, energyFloor / (solidHeatCap.get(owner) ?? Infinity)); break;
        case K_SOLID_MASS: t = Math.max(c.relTol * a, solidFloor); break;
        case K_FRACTION: {
          // kg of material one unit of this fraction stands for, x heat weight
          const [what, nodeId] = owner.split(':');
          const t0 = s.thermalNodes.get(nodeId);
          const go = t0?.graphiteOxidation;
          const joulesPerUnit = what === 'ox'
            ? (t0?.mass ?? 0) * ZR_OXIDATION_WEIGHT
            : (go?.fullMass ?? go?.initialCarbonMass ?? 0) * CARBON_OXIDATION_WEIGHT /
              (what === 'layer' ? (go?.layers?.burnoff.length ?? 1) : 1);
          t = Math.max(c.relTol * a, joulesPerUnit > 0 ? energyFloor / joulesPerUnit : c.relTol);
          break;
        }
        case K_INVENTORY: t = Math.max(c.relTol * a, fpFloor); break;
        case K_DAMAGE: t = c.relTol * Math.max(a, DAMAGE_FLOOR); break;
        case K_POWER: t = c.relTol * Math.max(a, powerFloor); break;
        case K_PRECURSOR: t = c.relTol * Math.max(a, precursorFloor); break;
        default: t = Infinity;
      }
      tol[i++] = t;
    });
    return tol;
  }

  private tryJump(solver: RK45Solver, s: SimulationState, lock?: CycleLock): { state: SimulationState; jump?: SlowModeJump } {
    const c = this.config;
    const N = this.keys.length;
    const nS = this.n;
    if (nS < 6) {
      this.status.lastHold = `too few samples (${nS})`;
      this.windows = [];
      return { state: s };
    }
    // Straight-line fit of every slot: slope at the window centre, and its
    // standard error.
    //
    // SLOPE NOISE. The textbook standard error, sqrt(rss / (n - 2) / Stt),
    // takes every sample's residual as independent of its neighbours'. Plant
    // noise is not: a stagnant gas loop's flow chatter, or a tank breathing
    // through a cycling valve, pushes an inventory one way for tens of
    // seconds - dozens of samples - at a time. The slope of such a window is
    // far less certain than its sample-to-sample scatter says, and with the
    // textbook figure the next window's (honestly different) slope read as a
    // trend the fits had missed, which cut the jump ceiling on noise that was
    // a fraction of a percent of the inventory and going nowhere.
    //
    // So the noise is measured over blocks of consecutive samples instead.
    // The slope's error is sum((t - tc) e) / Stt; each block's share of that
    // sum, g_b = sum over the block of (t - tc) x residual, is one draw of it
    // that already contains whatever correlation there is inside a block,
    // and var(slope) = B / (B - 1) x sum(g_b^2) / Stt^2 (the cluster-robust
    // estimate, with blocks as clusters). For independent residuals this
    // reproduces the textbook figure on average; it is taken no smaller than
    // that figure, since with 8-16 blocks it is itself a noisy estimate and
    // chatter never makes a slope MORE certain than white noise would.
    // Correlation longer than a block is still underestimated - that is what
    // the lengthening of the window on a slope reversal is for.
    const [s0, s1, s2] = this.st;
    const tcRel = s1 / s0;
    const Stt = s2 - s0 * tcRel * tcRel;
    let tc = this.phaseStart + tcRel;
    const slope = new Float64Array(N);
    const seSlope = new Float64Array(N);
    const blocks = this.blocks;
    const B = blocks.length;
    // each block's sum of (t - tc) and (t - tc)^2
    const bc1 = blocks.map(b => b.t - tcRel * b.n);
    const bc2 = blocks.map(b => b.tt - 2 * tcRel * b.t + tcRel * tcRel * b.n);
    const blockSe = (b: number, xbar: number, sx: (blk: SampleBlock) => number, sxt: (blk: SampleBlock) => number): number => {
      let g2 = 0;
      for (let q = 0; q < B; q++) {
        const g = (sxt(blocks[q]) - tcRel * sx(blocks[q])) - xbar * bc1[q] - b * bc2[q];
        g2 += g * g;
      }
      return Math.sqrt(B / (B - 1) * g2) / Stt;
    };
    for (let i = 0; i < N; i++) {
      const Sxt = this.sxt[i] - this.sx[i] * tcRel;
      const Sxx = this.sxx[i] - this.sx[i] * this.sx[i] / s0;
      const b = Sxt / Stt;
      slope[i] = b;
      const rss = Math.max(0, Sxx - b * Sxt);
      seSlope[i] = Math.max(Math.sqrt(rss / (nS - 2) / Stt),
        blockSe(b, this.sx[i] / s0, blk => blk.sx[i], blk => blk.sxt[i]));
    }
    const tol = this.tolerances(s);
    const values = new Float64Array(N);
    const lo = new Float64Array(N);
    const hi = new Float64Array(N);
    {
      let i = 0;
      visitIntegratedState(s, (_k, _kind, value, l, h) => { values[i] = value; lo[i] = l; hi[i] = h; i++; });
    }

    // Earlier windows are comparable only with the same slot structure
    const hist = this.windows.filter(w => w.keys === this.keys);
    const w1 = hist[0];
    const w2 = hist[1];
    const obs = new Map<string, { slope: number; se: number }>();
    for (let j = 0; j < this.obsIds.length; j++) {
      const Sxt = this.osxt[j] - this.osx[j] * tcRel;
      const Sxx = this.osxx[j] - this.osx[j] * this.osx[j] / s0;
      const b = Sxt / Stt;
      obs.set(this.obsIds[j], { slope: b, se: Math.max(Math.sqrt(Math.max(0, Sxx - b * Sxt) / (nS - 2) / Stt),
        blockSe(b, this.osx[j] / s0, blk => blk.osx[j], blk => blk.osxt[j])) });
    }
    // A window locked to a lift cycle: drift = change between same-phase
    // lifts / time between them (the least-squares line through a sawtooth
    // is biased by the sawtooth); noise = spread of the per-cycle drifts,
    // or the fit's residual if there is only one cycle
    let liftRates: Map<string, number> | undefined;
    if (lock) {
      const m = lock.marks;
      const nc = m.length - 1;
      const span = m[nc].time - m[0].time;
      tc = 0.5 * (m[0].time + m[nc].time);
      const secant = (get: (k: number) => number, se: number): [number, number] => {
        const b = (get(nc) - get(0)) / span;
        if (nc < 2) return [b, se];
        let v = 0;
        for (let k = 1; k <= nc; k++) {
          const sk = (get(k) - get(k - 1)) / (m[k].time - m[k - 1].time);
          v += (sk - b) * (sk - b);
        }
        return [b, Math.sqrt(v / (nc - 1) / nc)];
      };
      for (let i = 0; i < N; i++) [slope[i], seSlope[i]] = secant(k => m[k].values[i], seSlope[i]);
      this.obsIds.forEach((id, j) => {
        const o = obs.get(id)!;
        const [b, se] = secant(k => m[k].obs[j], o.se);
        obs.set(id, { slope: b, se });
      });
      liftRates = new Map();
      for (const [id, n1] of m[nc].lifts) liftRates.set(id, (n1 - (m[0].lifts.get(id) ?? n1)) / span);
    }
    const win: WindowFit = { keys: this.keys, tc, slope, seSlope, J: 0, quadratic: false, tol, obs };
    const k = c.confidence;

    const measureBefore = this.measure;
    // Curvature from this window and the previous one, centred between them
    if (w1) {
      const d1 = tc - w1.tc;
      win.curv = new Float64Array(N);
      win.seCurv = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        win.curv[i] = (slope[i] - w1.slope[i]) / d1;
        win.seCurv[i] = Math.hypot(seSlope[i], w1.seSlope[i]) / d1;
      }
    }

    // SETTLING. A jump lands every variable on its own extrapolated value,
    // and the fast modes that tie them together (gas pressure against wall
    // temperature, flow against head) then take a while to agree again. The
    // fixed relaxSeconds is too short for that after a long jump: xe100-sbo
    // needs ~90 s after a 60 s one, and a window measured through the tail
    // fitted the decaying transient as rate and curvature, which the next
    // jump extrapolated - every jump then missed its budget on helium
    // inventories that, integrated normally, do not oscillate at all, and
    // the ceiling never left 50-85 s.
    //
    // So the window is asked whether it is settled. Its two halves each give
    // a rate; the fits about to be used for the jump say how much the rate
    // should change between them (curvature x the time between the halves'
    // centres). A change beyond that and beyond the halves' noise is
    // curvature the fits do not explain, cu; left in, it costs cu J^2 / 2
    // over a jump, judged like any other truncation error (tol J / horizon),
    // which limits the jump to 2 tol / (horizon cu).
    //  - If that is shorter than the jump otherwise allowed and LONGER than
    //    the same figure from the window before (or there was none), the
    //    plant is settling: this window is not used at all - not for the
    //    jump, not to verify the last one, not as history - and another is
    //    measured.
    //  - If it is no longer than last time, it is not a transient dying
    //    away but something the window does not average (an oscillation):
    //    it is passed on as an ordinary limit, flagged as oscillating, which
    //    lengthens the window if no jump comes of it.
    // A window locked to a lift cycle is not asked: its halves sit at
    // different points of the sawtooth.
    let settleLimit = Infinity, settleKey = '', settleDetail = '';
    const hB = B >> 1;
    if (w1 && !lock && hB >= 2 && c.settleTest !== false) {
      const d1 = tc - w1.tc;
      const quadraticFit = w2 !== undefined && w1.curv !== undefined;
      let nA = 0, tA = 0, ttA = 0, nB = 0, tB = 0, ttB = 0;
      for (let q = 0; q < B; q++) {
        const b = blocks[q];
        if (q < hB) { nA += b.n; tA += b.t; ttA += b.tt; } else { nB += b.n; tB += b.t; ttB += b.tt; }
      }
      const SttA = ttA - tA * tA / nA, SttB = ttB - tB * tB / nB;
      const between = tB / nB - tA / nA;   // time between the halves' centres
      // white-noise standard error of a half's rate from the whole window's
      const seHalfA = Math.sqrt(Stt / SttA), seHalfB = Math.sqrt(Stt / SttB);
      for (let i = 0; i < N; i++) {
        if (this.kinds[i] === K_PASSIVE || this.kinds[i] === K_DECAY_POOL) continue;
        let xA = 0, xtA = 0, xB = 0, xtB = 0;
        for (let q = 0; q < B; q++) {
          const b = blocks[q];
          if (q < hB) { xA += b.sx[i]; xtA += b.sxt[i]; } else { xB += b.sx[i]; xtB += b.sxt[i]; }
        }
        const rateA = (xtA - xA * tA / nA) / SttA;
        const rateB = (xtB - xB * tB / nB) / SttB;
        // curvature the jump would use, brought from where it was measured
        // (midway between the two windows' centres) to this window's centre
        const a = win.curv![i];
        const aHere = quadraticFit ? a + (a - w1.curv![i]) / (0.5 * (tc - w2!.tc)) * 0.5 * d1 : a;
        const noise = k * seSlope[i] * Math.hypot(seHalfA, seHalfB);
        const m = Math.abs(rateB - rateA - aHere * between) - noise;
        if (!(m > 0)) continue;
        const cu = m / between;
        const Js = 2 * tol[i] / (c.accuracyHorizon * cu);
        if (Js < settleLimit) {
          settleLimit = Js; settleKey = this.keys[i];
          settleDetail = `rate ${rateA.toExponential(2)} -> ${rateB.toExponential(2)} across the window, ` +
            `fits explain ${(aHere * between).toExponential(2)}, tol=${tol[i].toExponential(2)}`;
        }
      }
      const allowed = Math.min(Math.max(this.jmax, c.minJumpFactor * (c.relaxSeconds + this.measure)), c.maxJump);
      if (settleLimit < allowed && settleLimit > this.lastSettleLimit) {
        this.lastSettleLimit = settleLimit;
        this.status.lastHold = `still settling after the last jump: ${settleKey} would limit a jump to ` +
          `${settleLimit.toFixed(0)} s (${settleDetail})`;
        return { state: s };
      }
    }
    this.lastSettleLimit = 0;

    // VERIFY the previous jump: the slope now should be what the previous
    // fits predicted for now (beyond their own noise). A slope mismatch m
    // that built up over d1 means the jump's position error was about
    // m J^2 / (2 d1) for a linear extrapolation (rate error growing linearly)
    // and m J^3 / (3 d1^2) for a quadratic one (growing quadratically).
    // What is left after the noise allowance is systematic, so it is judged
    // against the truncation budget for a jump of that length.
    if (w1 && w1.J > 0) {
      const d1 = tc - w1.tc;
      let worst = 0, worstKey = '', worstFlipped = false;
      for (let i = 0; i < N; i++) {
        if (this.kinds[i] === K_PASSIVE) continue;
        const t1 = w1.tau ? w1.tau[i] : 0;
        const predicted = t1 > 0 ? w1.slope[i] * Math.exp(-d1 / t1)
          : w1.slope[i] + (w1.curv ? w1.curv[i] * d1 : 0);
        const noise = k * Math.hypot(seSlope[i], w1.seSlope[i], w1.seCurv ? w1.seCurv[i] * d1 : 0);
        const m = Math.max(0, Math.abs(slope[i] - predicted) - noise);
        const err = t1 > 0 ? 0.5 * m * Math.min(w1.J, t1)
          : w1.quadratic ? m * w1.J ** 3 / (3 * d1 * d1) : m * w1.J * w1.J / (2 * d1);
        const e = err / (w1.tol[i] * w1.J / c.accuracyHorizon);
        if (e > worst) { worst = e; worstKey = this.keys[i]; worstFlipped = slope[i] * w1.slope[i] < 0; }
      }
      // Step-size control on the realized error, which goes as J^2: the
      // usual safety factor 0.9 and growth between halving and doubling
      const factor = Math.min(2, Math.max(0.5, 0.9 / Math.sqrt(Math.max(worst, 1e-12))));
      this.jmax = Math.min(c.maxJump, Math.max(c.minJumpFactor * (c.relaxSeconds + this.measure), factor * w1.J));
      if (worst > 2) {
        console.warn(`[SlowMode] t=${s.time.toFixed(0)}: previous ${w1.J.toFixed(0)} s jump overshot its error ` +
          `budget ${worst.toFixed(1)}x on ${worstKey}; jump ceiling -> ${this.jmax.toFixed(0)} s`);
        // A slope that changed sign is an oscillation the window did not
        // average over, not a curvature the fits missed
        if (worstFlipped && this.measure < c.maxMeasureSeconds) this.lengthenWindow(s.time, worstKey);
      }
    }
    if (this.measure !== measureBefore) {
      // the window was lengthened: fits of the old length start over
      this.status.lastHold = 'measurement window lengthened';
      return { state: s };
    }
    this.windows = [win, ...hist].slice(0, 3);

    if (!w1) {
      this.status.lastHold = 'first window after a reset: measuring the drift';
      return { state: s };
    }

    // The ceiling never sits below the shortest jump worth taking: the
    // window may have lengthened since the ceiling was last set, and a
    // ceiling no jump can clear would never be revisited
    this.jmax = Math.max(this.jmax, c.minJumpFactor * (c.relaxSeconds + this.measure));
    let J = Math.min(this.jmax, c.maxJump);
    let limitedBy = 'jump ceiling';
    let limiterDetail = '';
    const nextEvent = s.scenario && s.scenario.fired < s.scenario.events.length
      ? s.scenario.events[s.scenario.fired].time - s.time : Infinity;
    if (nextEvent < J) { J = nextEvent; limitedBy = 'next scenario event'; }
    let settleBinds = false;
    if (settleLimit < J) {
      J = settleLimit; limitedBy = `${settleKey} (not settling)`; limiterDetail = settleDetail; settleBinds = true;
    }

    // Rate and curvature at the end of this window. With three windows the
    // change of curvature prices a quadratic extrapolation; with two, the
    // extrapolation is linear and the whole curvature is its error.
    const quadratic = w2 !== undefined && w1.curv !== undefined;
    const d1 = tc - w1.tc;
    const h = s.time - tc;
    const rates = new Float64Array(N);
    const curv = win.curv!;
    const held = new Uint8Array(N);
    const tau = new Float64Array(N);   // > 0: extrapolate as an exponential with this time constant
    const limits: { key: string; J: number; detail: string }[] = [];
    let limiterOscillating = settleBinds;
    let errorLimit = settleLimit;   // tightest slot limit, ignoring the ceiling
    const waterDominated = new Set<string>();
    for (const [id, node] of s.flowNodes) {
      let mol = 0;
      if (node.fluid.ncg) for (const v of Object.values(node.fluid.ncg as unknown as Record<string, number>)) mol += v;
      if (node.fluid.mass * WATER_CP_WEIGHT >= mol * GAS_CV_WEIGHT) waterDominated.add(id);
    }
    for (let i = 0; i < N; i++) {
      const a = curv[i];
      const R = slope[i] + a * h;
      rates[i] = R;
      if (this.kinds[i] === K_PASSIVE || this.kinds[i] === K_DECAY_POOL || held[i]) continue;
      const T = tol[i];
      if ((R < 0 && values[i] - lo[i] <= tol[i]) || (R > 0 && hi[i] - values[i] <= tol[i])) {
        held[i] = 1;
        const key = this.keys[i];
        if (this.kinds[i] === K_MASS && key.endsWith('.m') && waterDominated.has(key.slice(0, -2))) {
          const id = key.slice(0, -2);
          for (let j = i + 1; j < N && this.keys[j].startsWith(id + '.'); j++) {
            if (this.keys[j] === `${id}.U` || this.keys[j] === `${id}.m1` || this.keys[j] === `${id}.U1`) held[j] = 1;
          }
        }
        continue;
      }
      if (EXPONENTIAL.has(this.kinds[i]) && quadratic && R * a < 0 && w1.slope[i] * w1.curv![i] < 0) {
        // Relaxing: x -> x + R tau (1 - e^(-J/tau)). Systematic error = the
        // spread between this window's time constant and the previous one's;
        // noise saturates with the exponential.
        const t0 = -R / a;
        const t1 = -w1.slope[i] / w1.curv![i];
        tau[i] = t0;
        const grow = (J: number, t: number) => t * (1 - Math.exp(-J / t));
        const seR = Math.hypot(seSlope[i] * (1 + h / d1), w1.seSlope[i] * h / d1);
        const err = (J: number) => Math.abs(R) * Math.abs(grow(J, t0) - grow(J, t1)) + k * seR * grow(J, t0);
        const within = (cap: number) => {
          if (err(cap) <= T) return cap;
          let lo2 = 0, hi2 = cap;
          for (let it = 0; it < 60; it++) { const mid = 0.5 * (lo2 + hi2); if (err(mid) <= T) lo2 = mid; else hi2 = mid; }
          return lo2;
        };
        const Ji = within(J);
        if (Ji < J) errorLimit = Math.min(errorLimit, Ji);
        const detail = () => `x=${values[i].toPrecision(6)} R=${R.toExponential(2)} tau=${t0.toFixed(0)} tau_prev=${t1.toFixed(0)} ` +
          `seR=${seR.toExponential(2)} tol=${T.toExponential(2)} (exponential)`;
        if (c.diagnose) limits.push({ key: this.keys[i], J: within(1e7), detail: detail() });
        if (Ji < J) { J = Ji; limitedBy = this.keys[i]; limiterDetail = detail(); limiterOscillating = false; }
        continue;   // an exponential approach never crosses its asymptote
      }
      const seR = Math.hypot(seSlope[i] * (1 + h / d1), w1.seSlope[i] * h / d1);
      const seA = win.seCurv![i];
      // Predicted extrapolation error, split into its random part (fit
      // noise: n3 J^3 + n2 J^2 + n1 J <= T per jump) and its systematic part
      // (the neglected curvature, or change of curvature: <= T per
      // accuracyHorizon of skipped time, i.e. T J / horizon for this jump)
      let n3 = 0, trunc3 = 0, trunc2 = 0;
      const n1 = k * seR;
      const n2 = 0.5 * k * seA;
      if (quadratic) {
        // the two curvatures sit at the midpoints between window centres
        const span = 0.5 * (tc - w2!.tc);
        trunc3 = Math.abs(a - w1.curv![i]) / span / 6;
        n3 = k * Math.hypot(seA, w1.seCurv![i]) / span / 6;
      } else {
        trunc2 = 0.5 * Math.abs(a);
      }
      const H = c.accuracyHorizon;
      const jTrunc = (cap: number) => Math.min(cap,
        trunc3 > 0 ? Math.sqrt(T / (H * trunc3)) : Infinity,
        trunc2 > 0 ? T / (H * trunc2) : Infinity);
      const Ji = Math.min(largestRoot(n3, n2, n1, T, J), jTrunc(J));
      if (Ji < J) errorLimit = Math.min(errorLimit, Ji);
      const detail = () => `x=${values[i].toPrecision(6)} R=${R.toExponential(2)} a=${a.toExponential(2)} ` +
        `seR=${seR.toExponential(2)} seA=${seA.toExponential(2)} tol=${T.toExponential(2)}` +
        (quadratic ? ` a_prev=${w1.curv![i].toExponential(2)}` : ' (linear)');
      if (c.diagnose) limits.push({ key: this.keys[i], J: Math.min(largestRoot(n3, n2, n1, T, 1e9), jTrunc(1e9)), detail: detail() });
      if (Ji < J) {
        J = Ji; limitedBy = this.keys[i]; limiterDetail = detail();
        limiterOscillating = quadratic && a * w1.curv![i] < 0;
      }
      // A bounded inventory is never extrapolated more than halfway to its
      // bound at any point of the jump
      const qa = quadratic ? 0.5 * a : 0;
      if (Number.isFinite(lo[i])) {
        const Jb = firstCrossing(qa, R, 0.5 * (values[i] - lo[i]));
        if (Jb < J) { J = Jb; limitedBy = `${this.keys[i]} (bound)`; limiterDetail = detail(); limiterOscillating = false; }
      }
      if (Number.isFinite(hi[i])) {
        const Jb = firstCrossing(-qa, -R, 0.5 * (hi[i] - values[i]));
        if (Jb < J) { J = Jb; limitedBy = `${this.keys[i]} (bound)`; limiterDetail = detail(); limiterOscillating = false; }
      }
    }
    // RELIEF SETPOINTS. A shut relief valve's sensed pressure is a bound
    // like an inventory's zero: a jump never carries it more than
    // reliefApproachFraction of the way to the setpoint at any point of the
    // jump, so successive jumps approach the
    // pop geometrically and the pop, the blowdown and the reseat are always
    // integrated normally. (A jump that carried the pressure past the
    // setpoint would pop the valve from an overpressure the plant never
    // reached.) The rate is taken at the top of its noise band; curvature,
    // from the previous window's fit of the same valve, only when it bends
    // the pressure upward. A valve that is open, or not under its own
    // pressure control, is left alone - a lift inside the window already
    // discards it (discreteSignature).
    for (const [id, v] of s.components.valves) {
      const relief = v.relief;
      if (!relief || v.reliefOpen || relief.controlMode !== 'auto' || v.powered === false) continue;
      const o = obs.get(id);
      if (!o) continue;
      const gap = relief.setpoint - reliefSensedPressure(s, id);
      const o1 = w1.obs?.get(id);
      const aP = o1 ? (o.slope - o1.slope) / d1 : 0;
      const R = o.slope + aP * h + k * Math.hypot(o.se, o1 ? o1.se * h / d1 : 0);
      const Jb = firstCrossing(-0.5 * Math.max(0, aP), -R, c.reliefApproachFraction * gap);
      if (c.diagnose) limits.push({ key: `${id} (relief setpoint)`, J: Jb,
        detail: `P=${(reliefSensedPressure(s, id) / 1e5).toFixed(3)} bar setpoint=${(relief.setpoint / 1e5).toFixed(3)} ` +
          `rate=${(R / 1e5).toExponential(2)} bar/s curv=${(aP / 1e5).toExponential(2)}` });
      if (Jb < J) {
        J = Jb; limitedBy = `${id} (relief setpoint)`; limiterOscillating = false;
        limiterDetail = `P=${(reliefSensedPressure(s, id) / 1e5).toFixed(3)} bar, setpoint ${(relief.setpoint / 1e5).toFixed(3)} bar, ` +
          `rising ${(R / 1e5 * 3600).toFixed(2)} bar/h`;
      }
    }
    if (c.diagnose) this.lastLimits = limits.sort((x, y) => x.J - y.J).slice(0, 10);

    const minJump = c.minJumpFactor * (c.relaxSeconds + c.measureSeconds);
    if (!(J >= minJump)) {
      this.status.lastHold = `jump ${J.toFixed(1)} s < ${minJump.toFixed(0)} s, limited by ${limitedBy}` +
        (limiterDetail ? ` (${limiterDetail})` : '');
      // An oscillation slower than the window aliases into slope and
      // curvature: lengthen the window until it averages over whole cycles
      if (limiterOscillating && this.measure < c.maxMeasureSeconds) this.lengthenWindow(s.time, limitedBy);
      return { state: s };
    }
    // Back to a shorter window once a jump is taken with error room to spare
    // for it: the window is what a jump costs, and one lengthened to average
    // an oscillation during a transient long over (xe100-sbo's reached 640 s
    // in its first 40 minutes and stayed there) capped the speed-up near 2x
    // by itself. A window half as long measures a white-noise rate 2^1.5
    // times less certainly, so that is the room asked for: the tightest slot
    // limit must exceed the jump actually taken by that factor. (It used to
    // shorten only when jumps reached the ABSOLUTE ceiling, which a plant
    // with a cycling valve never does.) If the shorter window turns out not
    // to average something, the slope reversal lengthens it again.
    if (errorLimit > SHORTER_WINDOW_NOISE * J && this.measure > c.measureSeconds) {
      this.measure = Math.max(c.measureSeconds, 0.5 * this.measure);
    }

    // Jump a private clone, then let the solver re-derive it
    const jumped = cloneSimulationState(s);
    {
      let i = 0;
      const half = quadratic ? 0.5 * J * J : 0;
      // DECAY POOLS are not extrapolated from a fit: their equation is known,
      // dQ_g/dt = lambda_g (f_g P - Q_g), and over the jump it is solved
      // exactly for the fission power P running along its own fitted line
      // P0 + r t:  Q_g(J) = f_g (P0 + r J) - f_g r / lambda_g
      //                     + (Q_g0 - f_g P0 + f_g r / lambda_g) e^(-lambda_g J).
      // (Fitting each group's time constant from two windows a few minutes
      // apart missed a 2.8 h group by 4x its budget on every jump of
      // xe100-sbo and pinned the ceiling at its floor.)
      const iP = this.keys.indexOf('neutronics.power');
      const P0 = s.neutronics.power;
      const rP = iP >= 0 ? rates[iP] : 0;
      let pool = 0;
      visitIntegratedState(jumped, (_k, kind, value, _l, _h, set) => {
        if (kind === K_DECAY_POOL) {
          const g = DECAY_HEAT_GROUPS[pool++];
          const lag = g.fraction * rP / g.lambda;
          set(g.fraction * (P0 + rP * J) - lag + (value - g.fraction * P0 + lag) * Math.exp(-g.lambda * J));
        }
        else if (held[i]) { /* held: see HOLDING */ }
        else if (tau[i] > 0) set(value + rates[i] * tau[i] * (1 - Math.exp(-J / tau[i])));
        else set(value + rates[i] * J + curv[i] * half);
        i++;
      });
    }
    jumped.time = s.time + J;
    let reconciled: SimulationState;
    try {
      reconciled = solver.reconcileJumpedState(jumped, J);
    } catch (e) {
      // An outer step rejection, exactly like RK45 rejecting a candidate:
      // the jumped state is discarded and the ceiling comes down.
      const message = e instanceof Error ? e.message : String(e);
      this.jmax = Math.max(minJump, 0.5 * J);
      this.windows = [];
      console.warn(`[SlowMode] t=${s.time.toFixed(0)}: ${J.toFixed(0)} s jump rejected ` +
        `(${message}); jump ceiling -> ${this.jmax.toFixed(0)} s`);
      this.status.lastHold = `jump rejected: ${message}`;
      return { state: s };
    }
    // The lifts the jump skipped still happened: every relief valve's
    // counter advances at the rate its locked window measured (fractionally)
    if (liftRates) {
      for (const [id, rate] of liftRates) {
        const v = reconciled.components.valves.get(id);
        if (v && rate > 0) v.liftCount = (v.liftCount ?? 0) + rate * J;
      }
    }
    for (const [id, v] of reconciled.components.valves) if (v.relief) this.lastLift.set(id, v.liftCount ?? 0);
    win.J = J;
    win.quadratic = quadratic;
    win.tau = tau;
    const jump: SlowModeJump = { time: s.time, jump: J, limitedBy, detail: limiterDetail };
    this.status.jumps++;
    this.status.jumpedSeconds += J;
    this.status.last = jump;
    this.status.lastHold = '';
    return { state: reconciled, jump };
  }
}

function snapshotValues(s: SimulationState): Float64Array {
  const out: number[] = [];
  visitIntegratedState(s, (_k, _kind, value) => { out.push(value); });
  return Float64Array.from(out);
}

function reliefPressures(s: SimulationState): Float64Array {
  const out: number[] = [];
  for (const [id, v] of s.components.valves) if (v.relief) out.push(reliefSensedPressure(s, id));
  return Float64Array.from(out);
}

function liftCounts(s: SimulationState): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, v] of s.components.valves) if (v.relief) out.set(id, v.liftCount ?? 0);
  return out;
}

/** discreteSignature without the relief-valve latches */
function withoutRelief(sig: string): string {
  return sig.split('|').filter(p => !p.startsWith('r:')).join('|');
}

/** The pressure a relief valve acts on (its sense node's). */
function reliefSensedPressure(s: SimulationState, valveId: string): number {
  const v = s.components.valves.get(valveId)!;
  const node = s.flowNodes.get(v.relief!.senseNodeId);
  if (!node) throw new Error(`[SlowMode] relief valve '${valveId}' senses node '${v.relief!.senseNodeId}', which does not exist`);
  return node.fluid.pressure;
}

/** Largest J in [0, cap] with c3 J^3 + c2 J^2 + c1 J <= T (all coefficients >= 0). */
function largestRoot(c3: number, c2: number, c1: number, T: number, cap: number): number {
  const f = (J: number) => ((c3 * J + c2) * J + c1) * J;
  if (f(cap) <= T) return cap;
  let lo = 0, hi = cap;
  for (let it = 0; it < 60; it++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) <= T) lo = mid; else hi = mid;
  }
  return lo;
}

/** First J > 0 where a J^2 + b J reaches -d (d > 0), or Infinity if never. */
function firstCrossing(a: number, b: number, d: number): number {
  // Sitting on the bound: fine unless it is heading through it
  if (!(d > 0)) return b < 0 || (b === 0 && a < 0) ? 0 : Infinity;
  if (a === 0) return b < 0 ? d / -b : Infinity;
  const disc = b * b - 4 * a * d;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const roots = [(-b - sq) / (2 * a), (-b + sq) / (2 * a)].filter(r => r > 0);
  return roots.length ? Math.min(...roots) : Infinity;
}
