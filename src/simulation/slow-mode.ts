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
 *      variable, and least-squares fit each one with a quadratic in time.
 *      The fit gives the drift rate at the end of the window, the curvature,
 *      and - from the residuals - how uncertain both are (fast ringing shows
 *      up as residual, not as rate).
 *   3. JUMP: move every integrated variable forward by rate x J in one go,
 *      advance the clock by J, and re-derive everything algebraic (pressure,
 *      temperature, phase, OTSG partition) through the solver's own
 *      constraint chain. J is the largest jump whose predicted extrapolation
 *      error - the rate uncertainty times J plus the neglected curvature
 *      times J^2/2 - stays inside each variable's tolerance, never so far that
 *      a non-negative inventory would be extrapolated through zero, and
 *      never past the next scripted scenario event.
 *   4. VERIFY: the next window measures the rates again. If they moved by
 *      more than the last jump's error budget allowed, the jump ceiling
 *      halves; if they held, it doubles. A nonlinear event the curvature did
 *      not foresee is therefore caught one window late at worst.
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

export interface SlowModeConfig {
  /** Normal integration after each jump before measuring (s plant time) */
  relaxSeconds: number;
  /** Measurement window (s plant time) */
  measureSeconds: number;
  /** Sampling interval inside the measurement window (s) */
  sampleSeconds: number;
  /** Relative tolerance per jump on inventories (mass, moles, fractions, power) */
  relTol: number;
  /** Temperature-equivalent tolerance per jump (K) on solid and fluid energies */
  tempTol: number;
  /** Absolute tolerance floor per jump on any one node's water / gas moles,
   *  as a fraction of the plant's total. A small node (a valve body, a pump
   *  casing) is a fast mode: its error is re-settled by the next relax phase
   *  and only matters through what it lends to or borrows from the plant, so
   *  it is judged against the plant, not against its own few kilograms. */
  absTolFraction: number;
  /** Energy counterpart of absTolFraction: the energy to warm that floor's
   *  worth of the plant's heat capacity by this many kelvin */
  energyFloorKelvin: number;
  /** Confidence multiplier on the fitted rate/curvature standard errors */
  confidence: number;
  /** Jumps shorter than this multiple of one relax+measure cycle are not worth taking */
  minJumpFactor: number;
  /** Starting jump ceiling (s); doubles per verified jump, halves per failed one */
  initialMaxJump: number;
  /** Absolute jump ceiling (s) */
  maxJump: number;
}

export const DEFAULT_SLOW_MODE_CONFIG: SlowModeConfig = {
  relaxSeconds: 20,
  measureSeconds: 40,
  sampleSeconds: 0.5,
  relTol: 1e-3,
  tempTol: 0.5,
  absTolFraction: 1e-4,
  energyFloorKelvin: 10,
  confidence: 2,
  minJumpFactor: 0.5,
  initialMaxJump: 120,
  maxJump: 3600,
};

// Tolerance kinds (see tolerances())
const K_MASS = 0, K_ENERGY = 1, K_MOL = 2, K_TEMP = 3, K_SOLID_MASS = 4,
  K_FRACTION = 5, K_INVENTORY = 6, K_POWER = 7, K_PRECURSOR = 8, K_PASSIVE = 9,
  K_PART_MASS = 10, K_PART_ENERGY = 11;

/**
 * Kinds that may be HELD during a jump once they sit within their tolerance
 * of a bound they are heading for (a decaying precursor population, an
 * emptying OTSG economizer slug, burn-off reaching 1). The true value lies
 * between where it is and the bound, so holding it costs at most the
 * tolerance - whereas the halfway-to-the-bound rule would cap every jump at
 * half the decay time of something already negligible. Conserved node
 * totals (water, energy, gas moles) are never held: that would create or
 * destroy inventory.
 */
const HOLDABLE = new Set([K_PART_MASS, K_PART_ENERGY, K_SOLID_MASS, K_FRACTION, K_INVENTORY, K_POWER, K_PRECURSOR]);

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
    visit(`${id}.T`, K_TEMP, t.temperature, 0, Infinity, v => { t.temperature = v; }, '');
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
        visit(`${id}.triso`, K_INVENTORY, fp.trisoDamage, 0, Infinity, v => { fp.trisoDamage = v; }, '');
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
  private st = [0, 0, 0, 0, 0];   // sum t^k, k = 0..4
  private x0: Float64Array = new Float64Array(0);
  private sx: Float64Array = new Float64Array(0);
  private sxt: Float64Array = new Float64Array(0);
  private sxt2: Float64Array = new Float64Array(0);
  private sxx: Float64Array = new Float64Array(0);
  private jmax: number;
  // Verification of the previous jump against the next window's rates
  private prevWindow: {
    tEnd: number; keys: string[]; rates: Float64Array; curv: Float64Array; seA: Float64Array;
    tol: Float64Array; J: number; quadratic: boolean;
  } | null = null;
  private status: SlowModeStatus;

  constructor(config: Partial<SlowModeConfig> = {}) {
    this.config = { ...DEFAULT_SLOW_MODE_CONFIG, ...config };
    this.jmax = this.config.initialMaxJump;
    this.status = { phase: 'relax', jumps: 0, jumpedSeconds: 0, maxJump: this.jmax, lastHold: '' };
  }

  getStatus(): SlowModeStatus {
    return { ...this.status, phase: this.phase, maxJump: this.jmax };
  }

  /** Forget the current window (the plant was edited, rewound, ...). */
  reset(): void {
    this.phase = 'relax';
    this.phaseStart = NaN;
    this.prevWindow = null;
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
      this.prevWindow = null;
      this.startRelax(s.time);
      return out;
    }
    if (s.time >= this.nextSample - 1e-9) {
      if (!this.sample(s)) {
        this.status.lastHold = 'state structure changed in window';
        this.prevWindow = null;
        this.startRelax(s.time);
        return out;
      }
      this.nextSample += this.config.sampleSeconds;
    }
    if (s.time < this.phaseStart + this.config.measureSeconds - 1e-9) return out;

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
    this.sxt2 = new Float64Array(N);
    this.sxx = new Float64Array(N);
    this.n = 0;
    this.st = [0, 0, 0, 0, 0];
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
      this.sxt2[i] += x * t * t;
      this.sxx[i] += x * x;
      i++;
    });
    if (!ok || i !== N) return false;
    this.n++;
    let tk = 1;
    for (let k = 0; k < 5; k++) { this.st[k] += tk; tk *= t; }
    return true;
  }

  /** Per-slot tolerances from the current state (see SlowModeConfig). */
  private tolerances(s: SimulationState): Float64Array {
    const c = this.config;
    let totalWater = 0, totalMol = 0, totalHeatCap = 0;
    const heatCap = new Map<string, number>();
    for (const [id, node] of s.flowNodes) {
      if (node.isBoundary) continue;
      let mol = 0;
      if (node.fluid.ncg) {
        const g = node.fluid.ncg as unknown as Record<string, number>;
        for (const sp of ALL_GAS_SPECIES) mol += g[sp] ?? 0;
      }
      const C = node.fluid.mass * WATER_CP_WEIGHT + mol * GAS_CV_WEIGHT;
      heatCap.set(id, C);
      totalWater += node.fluid.mass;
      totalMol += mol;
      totalHeatCap += C;
    }
    const massFloor = c.absTolFraction * totalWater;
    const molFloor = Math.max(1e-9, c.absTolFraction * totalMol);
    const energyFloor = c.absTolFraction * totalHeatCap * c.energyFloorKelvin;
    const n = s.neutronics;
    const powerFloor = 1e-4 * Math.max(n.nominalPower, 1);
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
        case K_ENERGY: case K_PART_ENERGY: t = Math.max(c.tempTol * (heatCap.get(owner) ?? 0), energyFloor, 1); break;
        case K_MOL: t = Math.max(c.relTol * a, molFloor); break;
        case K_TEMP: t = c.tempTol; break;
        case K_SOLID_MASS: t = c.relTol * Math.max(a, 1); break;
        case K_FRACTION: t = c.relTol * Math.max(a, 1e-4); break;
        case K_INVENTORY: t = c.relTol * Math.max(a, 1e-12); break;
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
    const te = s.time - this.phaseStart;
    if (nS < 6) {
      this.status.lastHold = `too few samples (${nS})`;
      this.prevWindow = null;
      return { state: s };
    }
    // Normal matrix of the quadratic fit and its inverse
    const [s0, s1, s2, s3, s4] = this.st;
    const M = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]];
    const Minv = invert3(M);
    // End-of-window rate R = b1 + 2 b2 te is the linear functional g.b
    const g = [0, 1, 2 * te];
    const Mg = mul3(Minv, g);
    const varRCoef = g[0] * Mg[0] + g[1] * Mg[1] + g[2] * Mg[2];
    const varACoef = 4 * Minv[2][2];

    const tol = this.tolerances(s);
    const rates = new Float64Array(N);
    const curv = new Float64Array(N);
    const seAs = new Float64Array(N);
    const seRs = new Float64Array(N);
    const values = new Float64Array(N);
    const lo = new Float64Array(N);
    const hi = new Float64Array(N);
    {
      let i = 0;
      visitIntegratedState(s, (_k, _kind, value, l, h) => { values[i] = value; lo[i] = l; hi[i] = h; i++; });
    }
    for (let i = 0; i < N; i++) {
      const rhs = [this.sx[i], this.sxt[i], this.sxt2[i]];
      const b = mul3(Minv, rhs);
      rates[i] = b[1] + 2 * b[2] * te;
      curv[i] = 2 * b[2];
      // Residual variance of the fit -> standard errors of R and a
      const rss = Math.max(0, this.sxx[i] - (b[0] * rhs[0] + b[1] * rhs[1] + b[2] * rhs[2]));
      const sigma2 = rss / (nS - 3);
      seAs[i] = Math.sqrt(sigma2 * varACoef);
      seRs[i] = Math.sqrt(sigma2 * varRCoef);
    }

    // The previous window (same structure, no discrete change since) gives
    // the third derivative - the change in curvature between the two fits -
    // and, if a jump followed it, the yardstick to verify that jump against.
    const prev = this.prevWindow && this.prevWindow.keys === this.keys ? this.prevWindow : null;
    const dtWin = prev ? s.time - prev.tEnd : 0;

    // VERIFY the previous jump: the rates now should match what its fit
    // predicted for now. A rate mismatch m that grew over dtWin means the
    // jump's position error was about m J^2 / (2 dtWin) if it extrapolated
    // linearly, m J^3 / (3 dtWin^2) if quadratically.
    if (prev && prev.J > 0) {
      let worst = 0, worstKey = '';
      for (let i = 0; i < N; i++) {
        if (this.kinds[i] === K_PASSIVE) continue;
        const predicted = prev.rates[i] + (prev.quadratic ? prev.curv[i] * dtWin : 0);
        const m = Math.abs(rates[i] - predicted);
        const e = (prev.quadratic ? m * prev.J ** 3 / (3 * dtWin * dtWin) : m * prev.J ** 2 / (2 * dtWin)) / prev.tol[i];
        if (e > worst) { worst = e; worstKey = this.keys[i]; }
      }
      if (worst > 2) {
        this.jmax = Math.max(c.minJumpFactor * (c.relaxSeconds + c.measureSeconds), 0.5 * prev.J);
        console.warn(`[SlowMode] t=${s.time.toFixed(0)}: previous ${prev.J.toFixed(0)} s jump overshot its error ` +
          `budget ${worst.toFixed(1)}x on ${worstKey}; jump ceiling -> ${this.jmax.toFixed(0)} s`);
      } else {
        this.jmax = Math.min(c.maxJump, Math.max(this.jmax, 2 * prev.J));
      }
    }

    let J = Math.min(this.jmax, c.maxJump);
    let limitedBy = 'jump ceiling';
    let limiterDetail = '';
    const nextEvent = s.scenario && s.scenario.fired < s.scenario.events.length
      ? s.scenario.events[s.scenario.fired].time - s.time : Infinity;
    if (nextEvent < J) { J = nextEvent; limitedBy = 'next scenario event'; }

    // Quadratic extrapolation needs a third-derivative estimate to price its
    // error; the first window after a reset extrapolates linearly instead.
    const quadratic = prev !== null;
    const k = c.confidence;
    const held = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (this.kinds[i] === K_PASSIVE) continue;
      const R = rates[i], a = curv[i], seA = seAs[i], seR = seRs[i];
      const T = tol[i];
      if (HOLDABLE.has(this.kinds[i]) &&
          ((R < 0 && values[i] - lo[i] <= T) || (R > 0 && hi[i] - values[i] <= T))) {
        held[i] = 1;
        continue;
      }
      // Predicted extrapolation error e(J) = c3 J^3 + c2 J^2 + c1 J
      let c3 = 0, c2: number;
      const c1 = k * seR;
      if (quadratic) {
        const d3 = (Math.abs(a - prev!.curv[i]) + k * Math.hypot(seA, prev!.seA[i])) / dtWin;
        c3 = d3 / 6;
        c2 = 0.5 * k * seA;
      } else {
        c2 = 0.5 * (Math.abs(a) + k * seA);
      }
      const Ji = largestRoot(c3, c2, c1, T, J);
      if (Ji < J) {
        J = Ji; limitedBy = this.keys[i];
        limiterDetail = `x=${values[i].toPrecision(6)} R=${R.toExponential(2)} a=${a.toExponential(2)} ` +
          `seR=${seR.toExponential(2)} seA=${seA.toExponential(2)} tol=${T.toExponential(2)}` +
          (quadratic ? ` a_prev=${prev!.curv[i].toExponential(2)} dtWin=${dtWin.toFixed(0)}` : '');
      }
      // A bounded inventory is never extrapolated more than halfway to its
      // bound at any point of the jump
      const qa = quadratic ? 0.5 * a : 0;
      if (Number.isFinite(lo[i])) {
        const Jb = firstCrossing(qa, R, 0.5 * (values[i] - lo[i]));
        if (Jb < J) { J = Jb; limitedBy = `${this.keys[i]} (bound)`; limiterDetail = ''; }
      }
      if (Number.isFinite(hi[i])) {
        const Jb = firstCrossing(-qa, -R, 0.5 * (hi[i] - values[i]));
        if (Jb < J) { J = Jb; limitedBy = `${this.keys[i]} (bound)`; limiterDetail = ''; }
      }
    }

    this.prevWindow = { tEnd: s.time, keys: this.keys, rates, curv, seA: seAs, tol, J: 0, quadratic };

    const minJump = c.minJumpFactor * (c.relaxSeconds + c.measureSeconds);
    if (!(J >= minJump)) {
      this.status.lastHold = `jump ${J.toFixed(1)} s < ${minJump.toFixed(0)} s, limited by ${limitedBy}` +
        (limiterDetail ? ` (${limiterDetail})` : '');
      return { state: s };
    }

    // Jump a private clone, then let the solver re-derive it
    const jumped = cloneSimulationState(s);
    {
      let i = 0;
      const half = quadratic ? 0.5 * J * J : 0;
      visitIntegratedState(jumped, (_k, _kind, value, _l, _h, set) => {
        if (!held[i]) set(value + rates[i] * J + curv[i] * half);
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
      this.prevWindow = null;
      console.warn(`[SlowMode] t=${s.time.toFixed(0)}: ${J.toFixed(0)} s jump rejected ` +
        `(${message}); jump ceiling -> ${this.jmax.toFixed(0)} s`);
      this.status.lastHold = `jump rejected: ${message}`;
      return { state: s };
    }
    this.prevWindow.J = J;
    const jump: SlowModeJump = { time: s.time, jump: J, limitedBy, detail: limiterDetail };
    this.status.jumps++;
    this.status.jumpedSeconds += J;
    this.status.last = jump;
    this.status.lastHold = '';
    return { state: reconciled, jump };
  }
}

function invert3(m: number[][]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 0)) throw new Error('[SlowMode] singular least-squares normal matrix');
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

function mul3(m: number[][], v: number[]): number[] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
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
