/**
 * Wall-fluid exchange the explicit stages cannot integrate at this step.
 *
 * A wall and the fluid against it relax toward each other at
 *   1/tau = g (1/C_wall + 1/C_fluid),
 * g the pair's conductance. Cladding against boiling coolant has tau ~ 30 ms,
 * a drained steam line against its hot pipe a few ms, and an explicit stage
 * cannot step past a few tau - the error controller answers by driving the
 * whole plant's step down to it. Pairs with dt > tau (the resolution
 * boundary itself, not a tuned number: below it the stages are the better
 * integrator, above it they cannot integrate the pair at all) are taken out
 * of the stages for the attempt and given a CONSTANT duty that integrates
 * them exactly over the step. A constant across the stages integrates to
 * exactly duty*dt in the 5th-order solution, cancels out of the embedded
 * error estimate (the E weights sum to zero), and sits in the step's rates,
 * so everything that reads those - the pressure solve's measured heat source
 * - sees the heat. (The same booking as the OTSG's stiff tubes, see
 * stampStiffOtsgTubes; this is that scheme for ordinary walls.)
 *
 * What is integrated is the linearization of the whole neighbourhood at the
 * step's start, not the pair alone:
 *
 *  - DRIFT. Everything else each node receives - conduction from the fuel
 *    into the cladding, flow carrying heat out of the coolant, the pairs
 *    left explicit - is read from the first stage's rates and held for the
 *    step. Without it the pair relaxes toward equal temperatures, the fixed
 *    point of a sealed, unheated pair. Cladding at power sits tens of
 *    kelvin above its coolant in steady state because the fuel keeps
 *    feeding it; relaxing that to zero and then meeting the real duty again
 *    on the next explicit step is what made every switch between the two
 *    treatments a rejected step. With the drift, a pair in steady state is
 *    handed back exactly its own duty.
 *  - TANGENT. The conductance is dq/dT_wall at the start state, by a
 *    centred difference of the live correlations, not q/dT. Boiling goes as
 *    a power of the superheat (Thom: q ~ dT^2), so q/dT is half the slope;
 *    frozen at the start it overshoots the balance point from above, the
 *    next step starts with a small dT and a small q/dT and overshoots from
 *    below - a period-2 flip. The tangent is a Newton step on the same
 *    balance and approaches it from one side. A pair whose duty FALLS with
 *    wall temperature (transition boiling) has no relaxation to resolve and
 *    stays with the stages.
 *  - COUPLING. A wall between two fluids (a heat-exchanger tube), or a fluid
 *    against several walls, is one linear system: the stiff pairs are the
 *    edges of a graph, and each connected piece is solved together,
 *       C x' = F + J x,   x = temperature change since the step's start,
 *    with C the heat capacities, F each node's total heating at the start
 *    (stiff duties included) and J the weighted graph Laplacian of the
 *    tangent conductances. C^-1 J is similar to a symmetric negative
 *    semi-definite matrix, so the step-mean is exact through its
 *    eigenvectors:  mean(x) = dt * phi2(dt C^-1 J) C^-1 F, with
 *    phi2(z) = (e^z - 1 - z)/z^2, and each pair's duty for the step is
 *    q0 + g (mean x_wall - mean x_fluid). For one pair without drift this is
 *    the two-body relaxation dT C_eq (1 - e^{-dt/tau}) / dt.
 *
 * The fluid's temperature answers its energy, its water mass and its gas
 * through the state function itself: (dT/dU) and (dT/dm) at fixed volume are
 * differenced from the same mixture solve the fluid-state constraint uses,
 * so a two-phase node, a steam space and a gas-filled one need no formula of
 * their own. Gas arriving at fixed energy cools the node by its own heat
 * capacity (the gas's energy is n Cv T by the mixture model's convention).
 *
 * The wall gives up exactly what the fluid receives.
 */

import { SimulationState, ConvectionConnection, FlowNode } from '../types';
import { solveMixtureState } from '../mixture-properties';
import { ALL_GAS_SPECIES, GAS_PROPERTIES, totalMass as ncgTotalMass } from '../gas-properties';
import type { StateRates } from '../rk45-solver';
import {
  convectionPairHeat, makeConvectionNodeProps, getConvectionHeatRates,
  recordConvectionHeatRate, fluidHeatCapacity, nodeHeatCapacity,
} from './rate-operators';

/** Relative size of every differencing step here (wall temperature, fluid
 *  energy, fluid mass). A numerical-differentiation step, not a physical
 *  tolerance: large against the state function's own convergence noise, small
 *  against the curvature of anything it differences. */
const DIFF_STEP = 1e-4;

/** phi2(z) = (e^z - 1 - z) / z^2, for z <= 0. The closed form loses every
 *  digit as z -> 0 (it subtracts 1 + z from e^z), so the series takes over
 *  where it is the more accurate of the two. */
export function phi2(z: number): number {
  if (Math.abs(z) < 1e-3) return 0.5 + z / 6 + (z * z) / 24;
  return (Math.expm1(z) - z) / (z * z);
}

/**
 * Eigen-decomposition of a small symmetric matrix by cyclic Jacobi
 * rotations. Returns eigenvalues and the eigenvectors as columns of `vectors`
 * (vectors[i][k] = component i of eigenvector k). Throws if the sweeps do
 * not converge - they always do for a symmetric matrix, so that is a NaN.
 */
export function symmetricEigen(a: number[][]): { values: number[]; vectors: number[][] } {
  const n = a.length;
  const m = a.map(row => row.slice());
  const v: number[][] = [];
  for (let i = 0; i < n; i++) { v.push(new Array<number>(n).fill(0)); v[i][i] = 1; }
  let scale = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) scale += m[i][j] * m[i][j];
  if (!Number.isFinite(scale)) {
    throw new Error('[StiffConvection] non-finite matrix handed to the eigen-solve');
  }
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += m[i][j] * m[i][j];
    // Converged when the off-diagonal part is below rounding of the whole
    if (off <= 1e-30 * scale) {
      return { values: m.map((row, i) => row[i]), vectors: v };
    }
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (m[p][q] === 0) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const mkp = m[k][p], mkq = m[k][q];
          m[k][p] = c * mkp - s * mkq;
          m[k][q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < n; k++) {
          const mpk = m[p][k], mqk = m[q][k];
          m[p][k] = c * mpk - s * mqk;
          m[q][k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  throw new Error('[StiffConvection] Jacobi eigen-solve did not converge');
}

/**
 * Step-mean duty of each edge of one coupled piece.
 *
 * `capacity[i]` (J/K) and `heating[i]` (W, total at the step's start with
 * the edges' own duties included) describe node i; each edge runs from a wall
 * node to a fluid node with tangent conductance g (W/K) and start duty q0
 * (W, wall to fluid). Pure linear algebra - exported for the tests.
 */
export function coupledMeanDuties(
  capacity: number[], heating: number[],
  edges: Array<{ wall: number; fluid: number; g: number; q0: number }>,
  dt: number,
): number[] {
  const n = capacity.length;
  const d = capacity.map(c => 1 / Math.sqrt(c));
  // S = D L D, L the conductance-weighted graph Laplacian (so C^-1 J = -D S D^-1)
  const S: number[][] = [];
  for (let i = 0; i < n; i++) S.push(new Array<number>(n).fill(0));
  for (const e of edges) {
    S[e.wall][e.wall] += e.g * d[e.wall] * d[e.wall];
    S[e.fluid][e.fluid] += e.g * d[e.fluid] * d[e.fluid];
    S[e.wall][e.fluid] -= e.g * d[e.wall] * d[e.fluid];
    S[e.fluid][e.wall] -= e.g * d[e.wall] * d[e.fluid];
  }
  const { values, vectors } = symmetricEigen(S);
  // mean(x) = dt * D V phi2(-lambda dt) V^T D F
  const proj = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += vectors[i][k] * d[i] * heating[i];
    proj[k] = s * phi2(-values[k] * dt);
  }
  const xMean = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < n; k++) s += vectors[i][k] * proj[k];
    xMean[i] = dt * d[i] * s;
  }
  return edges.map(e => e.q0 + e.g * (xMean[e.wall] - xMean[e.fluid]));
}

/** Unstamp every pair: the next rate evaluation sees the live correlations. */
export function clearStiffConvection(state: SimulationState): void {
  for (const conn of state.convectionConnections) {
    conn.implicitThisStep = false;
    conn.implicitDuty = undefined;
  }
}

/** How a fluid node's temperature answers its inventory at fixed volume. */
interface FluidResponse {
  /** 1 / (dT/dU) at fixed mass and gas, J/K */
  capacity: number;
  /** capacity * (dT/dm_water) at fixed energy, J/kg */
  perKgWater: number;
}

function fluidResponse(node: FlowNode, capacityEstimate: number): FluidResponse {
  const f = node.fluid;
  const solveT = (mass: number, energy: number): number =>
    solveMixtureState(mass, energy, node.volume, f.ncg, f.temperature).temperature;
  const dU = capacityEstimate * DIFF_STEP * f.temperature;
  const dm = DIFF_STEP * (f.mass + (f.ncg ? ncgTotalMass(f.ncg) : 0));
  let T0: number, TU: number, Tm: number;
  try {
    T0 = solveT(f.mass, f.internalEnergy);
    TU = solveT(f.mass, f.internalEnergy + dU);
    Tm = solveT(f.mass + dm, f.internalEnergy);
  } catch (e) {
    throw new Error(`[StiffConvection] cannot difference the state of '${node.id}' ` +
      `(m=${f.mass} kg, U=${f.internalEnergy} J, T=${f.temperature} K, ${f.phase}): ` +
      `${e instanceof Error ? e.message : String(e)}`);
  }
  const dTdU = (TU - T0) / dU;
  if (!(dTdU > 0) || !Number.isFinite(dTdU)) {
    throw new Error(`[StiffConvection] '${node.id}' does not warm when heated: ` +
      `dT/dU=${dTdU} K/J (T=${T0} K, +${dU} J gave ${TU} K; m=${f.mass} kg, ${f.phase})`);
  }
  const capacity = 1 / dTdU;
  return { capacity, perKgWater: capacity * (Tm - T0) / dm };
}

/**
 * After the first stage: find the pairs this step cannot resolve, solve each
 * connected piece of them, stamp the pairs with their constant duty for the
 * remaining stages, and correct k0 (which was evaluated with every pair
 * live) to carry the same duty. `advection` is transport applied outside the
 * stage rates, if the step has any. Returns the number of pairs stamped.
 */
export function applyStiffConvection(
  state: SimulationState, k0: StateRates, dt: number, advection?: StateRates,
): number {
  const conns = state.convectionConnections;
  if (conns.length === 0) return 0;
  const cache = makeConvectionNodeProps(state);
  const liveQ = getConvectionHeatRates();

  // --- Which pairs are stiff at this step -------------------------------
  interface Stiff { conn: ConvectionConnection; g: number; q0: number; wall: number; fluid: number }
  const stiff: Stiff[] = [];
  const index = new Map<string, number>();
  const kinds: Array<{ wallId?: string; fluidId?: string }> = [];
  const nodeIndex = (key: string, kind: { wallId?: string; fluidId?: string }): number => {
    let i = index.get(key);
    if (i === undefined) { i = kinds.length; index.set(key, i); kinds.push(kind); }
    return i;
  };
  for (const conn of conns) {
    const fluid = state.flowNodes.get(conn.flowNodeId);
    const wall = state.thermalNodes.get(conn.thermalNodeId);
    if (!fluid || !wall || fluid.isBoundary) continue;
    const Cw = nodeHeatCapacity(wall);
    const Cf = fluidHeatCapacity(fluid);
    if (!(Cw > 0) || !(Cf > 0)) continue;
    // Tangent conductance: the live correlations, differenced in the wall
    // temperature about the start state
    const T = wall.temperature;
    const h = DIFF_STEP * T;
    wall.temperature = T + h;
    const qUp = convectionPairHeat(state, conn, cache);
    wall.temperature = T - h;
    const qDown = convectionPairHeat(state, conn, cache);
    wall.temperature = T;
    const g = (qUp - qDown) / (2 * h);
    if (!Number.isFinite(g)) {
      throw new Error(`[StiffConvection] pair '${conn.id}' has a non-finite conductance ` +
        `(q(${T + h} K)=${qUp} W, q(${T - h} K)=${qDown} W)`);
    }
    if (!(dt * g * (1 / Cw + 1 / Cf) > 1)) continue;
    const q0 = liveQ.get(conn.id);
    if (q0 === undefined) {
      throw new Error(`[StiffConvection] pair '${conn.id}' has no duty from the first stage - ` +
        `the convection operator must have evaluated this state`);
    }
    stiff.push({
      conn, g, q0,
      wall: nodeIndex('w:' + conn.thermalNodeId, { wallId: conn.thermalNodeId }),
      fluid: nodeIndex('f:' + conn.flowNodeId, { fluidId: conn.flowNodeId }),
    });
  }
  if (stiff.length === 0) return 0;

  // --- Each node's capacity and total heating at the start --------------
  const n = kinds.length;
  const capacity = new Array<number>(n);
  const heating = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const kind = kinds[i];
    if (kind.wallId !== undefined) {
      const wall = state.thermalNodes.get(kind.wallId)!;
      capacity[i] = nodeHeatCapacity(wall);
      heating[i] = capacity[i] * (k0.thermalNodes.get(kind.wallId)?.dTemperature ?? 0);
    } else {
      const id = kind.fluidId!;
      const node = state.flowNodes.get(id)!;
      const resp = fluidResponse(node, fluidHeatCapacity(node));
      capacity[i] = resp.capacity;
      let dEnergy = 0, dMass = 0, gasCooling = 0;
      for (const rates of [k0, advection]) {
        const r = rates?.flowNodes.get(id);
        if (!r) continue;
        dEnergy += r.dEnergy;
        dMass += r.dMass;
        if (r.dNcg) {
          for (const s of ALL_GAS_SPECIES) gasCooling += (r.dNcg[s] ?? 0) * GAS_PROPERTIES[s].cv;
        }
      }
      heating[i] = dEnergy + resp.perKgWater * dMass - node.fluid.temperature * gasCooling;
    }
    if (!Number.isFinite(heating[i]) || !(capacity[i] > 0)) {
      throw new Error(`[StiffConvection] node '${kind.wallId ?? kind.fluidId}' has heating ` +
        `${heating[i]} W on capacity ${capacity[i]} J/K`);
    }
  }

  // --- Connected pieces, each solved on its own --------------------------
  const parent = kinds.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (const s of stiff) parent[find(s.wall)] = find(s.fluid);
  const pieces = new Map<number, Stiff[]>();
  for (const s of stiff) {
    const root = find(s.wall);
    const list = pieces.get(root);
    if (list) list.push(s); else pieces.set(root, [s]);
  }

  for (const edges of pieces.values()) {
    const local = new Map<number, number>();
    const cap: number[] = [], heat: number[] = [];
    const at = (i: number): number => {
      let j = local.get(i);
      if (j === undefined) { j = cap.length; local.set(i, j); cap.push(capacity[i]); heat.push(heating[i]); }
      return j;
    };
    const localEdges = edges.map(e => ({ wall: at(e.wall), fluid: at(e.fluid), g: e.g, q0: e.q0 }));
    const duties = coupledMeanDuties(cap, heat, localEdges, dt);
    edges.forEach((e, j) => {
      const duty = duties[j];
      if (!Number.isFinite(duty)) {
        throw new Error(`[StiffConvection] pair '${e.conn.id}' got a non-finite duty ` +
          `(g=${e.g} W/K, q0=${e.q0} W, dt=${dt} s)`);
      }
      e.conn.implicitThisStep = true;
      e.conn.implicitDuty = duty;
      recordConvectionHeatRate(e.conn.id, duty);
      // k0 holds this pair at q0; the step holds it at the duty
      const change = duty - e.q0;
      const wallId = e.conn.thermalNodeId, fluidId = e.conn.flowNodeId;
      const wr = k0.thermalNodes.get(wallId) ?? { dTemperature: 0 };
      wr.dTemperature -= change / nodeHeatCapacity(state.thermalNodes.get(wallId)!);
      k0.thermalNodes.set(wallId, wr);
      const fr = k0.flowNodes.get(fluidId) ?? { dMass: 0, dEnergy: 0 };
      fr.dEnergy += change;
      k0.flowNodes.set(fluidId, fr);
    });
  }
  return stiff.length;
}
