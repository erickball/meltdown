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
 *      non-negative inventory would be extrapolated through zero, and never
 *      past the next scripted scenario event. The first window after a reset
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
}

export interface SlowModeConfig {
  /** Normal integration after each jump before measuring (s plant time) */
  relaxSeconds: number;
  /** Measurement window (s plant time). This is the shortest; it doubles
   *  (up to maxMeasureSeconds) while the variable limiting the jump is
   *  oscillating on a period the window cannot average over, and comes back
   *  down once jumps run into the ceiling instead. */
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
  /** Jumps shorter than this multiple of one relax+measure cycle are not worth taking */
  minJumpFactor: number;
  /** Starting jump ceiling (s); doubles per verified jump, halves per failed one */
  initialMaxJump: number;
  /** Absolute jump ceiling (s) */
  maxJump: number;
  /** Record the tightest per-slot jump limits of every window (getLimits) */
  diagnose?: boolean;
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
};

// Tolerance kinds (see tolerances())
const K_MASS = 0, K_ENERGY = 1, K_MOL = 2, K_TEMP = 3, K_SOLID_MASS = 4,
  K_FRACTION = 5, K_INVENTORY = 6, K_POWER = 7, K_PRECURSOR = 8, K_PASSIVE = 9,
  K_PART_MASS = 10, K_PART_ENERGY = 11, K_DAMAGE = 12;

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

/** Burn-off / oxidation fractions are judged relative to at least this much:
 *  an absolute 1e-3 (per jump, or per accuracyHorizon of systematic drift) is
 *  far below anything they decide - a pebble shell burns through near 0.4 */
const FRACTION_FLOOR = 1;
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
    if (ox) visit(`${id}.ox`, K_FRACTION, ox.oxidizedFraction, 0, 1, v => { ox.oxidizedFraction = v; }, '');
    const go = t.graphiteOxidation;
    if (go) {
      // Node mass follows burn-off unless the node integrates its own pieces
      // (applyRatesToState); both are extrapolated linearly from the same fit,
      // so they stay consistent to the fit's linearity.
      visit(`${id}.burn`, K_FRACTION, go.burnoff, 0, 1, v => { go.burnoff = v; }, '');
      const layers = go.layers?.burnoff;
      if (layers) {
        for (let i = 0; i < layers.length; i++) {
          visit(`${id}.layer${i}`, K_FRACTION, layers[i], 0, 1, v => { layers[i] = v; }, '');
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
      visit(`neutronics.pool${i}`, K_POWER, pools[i], 0, Infinity, v => { pools[i] = v; }, '');
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
  private jmax: number;
  private measure: number;
  // Fits of the most recent windows (newest first), all with the same slot
  // structure and no discrete change between them
  private windows: WindowFit[] = [];
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
    while (remaining > 1e-10) {
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
    let dt = requestedDt;
    if (this.phase === 'measure') dt = Math.min(dt, Math.max(this.nextSample - state.time, 1e-6));
    else dt = Math.min(dt, Math.max(this.phaseStart + this.config.relaxSeconds - state.time, 1e-6));
    const r = solver.advance(state, dt, wallFrameTimeMs);
    const s = r.state;
    const covered = s.time - state.time;
    const out = { state: s, metrics: r.metrics, covered, yielded: covered < dt * (1 - 1e-9) };

    if (this.phase === 'relax') {
      if (s.time >= this.phaseStart + this.config.relaxSeconds - 1e-9) this.startMeasure(s);
      return out;
    }

    if (discreteSignature(s) !== this.signature) {
      this.status.lastHold = 'discrete change in window';
      this.windows = [];
      this.startRelax(s.time);
      return out;
    }
    if (s.time >= this.nextSample - 1e-9) {
      if (!this.sample(s)) {
        this.status.lastHold = 'state structure changed in window';
        this.windows = [];
        this.startRelax(s.time);
        return out;
      }
      this.nextSample += this.config.sampleSeconds;
    }
    if (s.time < this.phaseStart + this.measure - 1e-9) return out;

    const jumped = this.tryJump(solver, s);
    this.startRelax(jumped.state.time);
    return { ...out, state: jumped.state, jump: jumped.jump };
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
    this.nextSample = s.time;
    this.sample(s);
    this.nextSample += this.config.sampleSeconds;
  }

  private sample(s: SimulationState): boolean {
    const t = s.time - this.phaseStart;
    let i = 0;
    let ok = true;
    const N = this.keys.length;
    visitIntegratedState(s, (key, _kind, value) => {
      if (i >= N || key !== this.keys[i]) { ok = false; i++; return; }
      const x = value - this.x0[i];
      this.sx[i] += x;
      this.sxt[i] += x * t;
      this.sxx[i] += x * x;
      i++;
    });
    if (!ok || i !== N) return false;
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
        case K_FRACTION: t = c.relTol * Math.max(a, FRACTION_FLOOR); break;
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

  private tryJump(solver: RK45Solver, s: SimulationState): { state: SimulationState; jump?: SlowModeJump } {
    const c = this.config;
    const N = this.keys.length;
    const nS = this.n;
    if (nS < 6) {
      this.status.lastHold = `too few samples (${nS})`;
      this.windows = [];
      return { state: s };
    }
    // Straight-line fit of every slot: slope at the window centre, and its
    // standard error from the residual
    const [s0, s1, s2] = this.st;
    const tcRel = s1 / s0;
    const Stt = s2 - s0 * tcRel * tcRel;
    const tc = this.phaseStart + tcRel;
    const slope = new Float64Array(N);
    const seSlope = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const Sxt = this.sxt[i] - this.sx[i] * tcRel;
      const Sxx = this.sxx[i] - this.sx[i] * this.sx[i] / s0;
      const b = Sxt / Stt;
      slope[i] = b;
      const rss = Math.max(0, Sxx - b * Sxt);
      seSlope[i] = Math.sqrt(rss / (nS - 2) / Stt);
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
    const win: WindowFit = { keys: this.keys, tc, slope, seSlope, J: 0, quadratic: false, tol };
    const k = c.confidence;

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

    // VERIFY the previous jump: the slope now should be what the previous
    // fits predicted for now (beyond their own noise). A slope mismatch m
    // that built up over d1 means the jump's position error was about
    // m J^2 / (2 d1) for a linear extrapolation (rate error growing linearly)
    // and m J^3 / (3 d1^2) for a quadratic one (growing quadratically).
    // What is left after the noise allowance is systematic, so it is judged
    // against the truncation budget for a jump of that length.
    if (w1 && w1.J > 0) {
      const d1 = tc - w1.tc;
      let worst = 0, worstKey = '';
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
        if (e > worst) { worst = e; worstKey = this.keys[i]; }
      }
      // Step-size control on the realized error, which goes as J^2: the
      // usual safety factor 0.9 and growth between halving and doubling
      const factor = Math.min(2, Math.max(0.5, 0.9 / Math.sqrt(Math.max(worst, 1e-12))));
      this.jmax = Math.min(c.maxJump, Math.max(c.minJumpFactor * (c.relaxSeconds + this.measure), factor * w1.J));
      if (worst > 2) {
        console.warn(`[SlowMode] t=${s.time.toFixed(0)}: previous ${w1.J.toFixed(0)} s jump overshot its error ` +
          `budget ${worst.toFixed(1)}x on ${worstKey}; jump ceiling -> ${this.jmax.toFixed(0)} s`);
      }
    }
    this.windows = [win, ...hist].slice(0, 3);

    if (!w1) {
      this.status.lastHold = 'first window after a reset: measuring the drift';
      return { state: s };
    }

    let J = Math.min(this.jmax, c.maxJump);
    let limitedBy = 'jump ceiling';
    let limiterDetail = '';
    const nextEvent = s.scenario && s.scenario.fired < s.scenario.events.length
      ? s.scenario.events[s.scenario.fired].time - s.time : Infinity;
    if (nextEvent < J) { J = nextEvent; limitedBy = 'next scenario event'; }

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
    let limiterOscillating = false;
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
      if (this.kinds[i] === K_PASSIVE || held[i]) continue;
      const T = tol[i];
      if ((R < 0 && values[i] - lo[i] <= T) || (R > 0 && hi[i] - values[i] <= T)) {
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
    if (c.diagnose) this.lastLimits = limits.sort((x, y) => x.J - y.J).slice(0, 10);

    const minJump = c.minJumpFactor * (c.relaxSeconds + this.measure);
    if (!(J >= minJump)) {
      this.status.lastHold = `jump ${J.toFixed(1)} s < ${minJump.toFixed(0)} s, limited by ${limitedBy}` +
        (limiterDetail ? ` (${limiterDetail})` : '');
      // An oscillation slower than the window aliases into slope and
      // curvature: lengthen the window until it averages over whole cycles
      if (limiterOscillating && this.measure < c.maxMeasureSeconds) {
        this.measure = Math.min(c.maxMeasureSeconds, 2 * this.measure);
        this.windows = [];
        console.warn(`[SlowMode] t=${s.time.toFixed(0)}: ${limitedBy} oscillates on a period the window cannot ` +
          `average; measurement window -> ${this.measure.toFixed(0)} s`);
      }
      return { state: s };
    }
    if (limitedBy === 'jump ceiling' && this.measure > c.measureSeconds) {
      this.measure = Math.max(c.measureSeconds, 0.5 * this.measure);
    }

    // Jump a private clone, then let the solver re-derive it
    const jumped = cloneSimulationState(s);
    {
      let i = 0;
      const half = quadratic ? 0.5 * J * J : 0;
      visitIntegratedState(jumped, (_k, _kind, value, _l, _h, set) => {
        if (held[i]) { /* held: see HOLDING */ }
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
