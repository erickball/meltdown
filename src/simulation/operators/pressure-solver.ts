/**
 * Semi-Implicit Pressure-Flow Solver
 *
 * For compressed liquid, the bulk modulus K is extremely high (~2200 MPa at low T),
 * meaning tiny density changes cause huge pressure swings. Explicitly integrating
 * the resulting acoustic (water-hammer) mode forces timesteps near the acoustic
 * period, sqrt(rho*V*L / (K*A)) ~ milliseconds for small liquid nodes.
 *
 * This solver removes that mode by solving, once per constraint application, the
 * linearized implicit coupling between node pressure response and connection flow
 * response:
 *
 *   Node compliance:      c_i = rho_i * V_i / (K_i * dt)
 *     (net inflow in kg/s that raises node pressure by 1 Pa over this timestep)
 *
 *   Flow conductance:     D_j = dt * A_j / (rho_j * L_j) / (1 + friction damping)
 *     (flow change in kg/s produced by 1 Pa of extra driving pressure over dt,
 *      from the same momentum equation FlowMomentumRateOperator integrates)
 *
 *   Mass balance:  for each node, net inflow after correction equals c_i * dP_i:
 *
 *     (diag(c) + L(D)) * dP = dm_net
 *
 *   where L(D) is the weighted graph Laplacian of the flow network. The system is
 *   symmetric positive definite, so a direct solve always succeeds - no iteration,
 *   no relaxation factor, no convergence failure.
 *
 * The virtual pressure corrections dP are never written to node state; they only
 * adjust conn.massFlowRate via dm_j = D_j * (dP_from - dP_to). Node pressures stay
 * thermodynamically consistent, computed from (m, U, V) by the constraint operators.
 *
 * This formulation is continuously stiffness-adaptive with no thresholds:
 * - Vapor / two-phase / large nodes have large compliance c, so dP and the flow
 *   corrections are negligible - their physics stays fully explicit.
 * - Small liquid nodes have tiny compliance, so mass balance is enforced and the
 *   acoustic timescale is collapsed to its quasi-steady limit.
 * - Real pressure still evolves: the residual net inflow c_i*dP_i deposits exactly
 *   the mass that raises the true pressure by dP_i over the step, so deadheaded
 *   pumps, overfilled tanks, etc. still pressurize (and can still burst) - just
 *   monotonically at the timestep scale instead of oscillating at the acoustic one.
 */

import {
  SimulationState,
  FlowNode,
  FlowConnection,
  PressureSolverConfig,
  DEFAULT_PRESSURE_SOLVER_CONFIG,
} from '../types';
import {
  numericalBulkModulus,
  saturationPressure,
  distanceToSaturationLine,
} from '../water-properties';
import { totalMass as ncgTotalMass } from '../gas-properties';
import { pumpHeadSlopeMagnitude } from './pump-curve';
import {
  computeConnectionHydraulics,
  computeChokeLimit,
  ConnectionHydraulics,
  ChokeLimit,
  CLOSED_FLOW_DECAY_TAU,
} from './connection-hydraulics';

/** Status of the last pressure solve */
export interface PressureSolverStatus {
  /** Whether the solver ran this timestep */
  ran: boolean;
  /** Number of iterations performed (always 1 - direct solve) */
  iterations: number;
  /** Whether the solver converged (always true - direct solve) */
  converged: boolean;
  /** Whether the solver stagnated (always false - direct solve) */
  stagnated: boolean;
  /** Maximum residual mass imbalance after correction (kg/s) */
  maxImbalance: number;
  /** Current K_max setting (Pa), or undefined if using physical K */
  K_max: number | undefined;
}

interface ConnEntry {
  conn: FlowConnection;
  D: number;      // conductance (kg/s per Pa)
  iFrom: number;  // matrix index of from-node, -1 if boundary/absent
  iTo: number;    // matrix index of to-node, -1 if boundary/absent
}

/**
 * Semi-Implicit Pressure-Flow Solver
 */
export class PressureSolver {
  public config: PressureSolverConfig;

  private lastStatus: PressureSolverStatus = {
    ran: false,
    iterations: 0,
    converged: false,
    stagnated: false,
    maxImbalance: 0,
    K_max: undefined,
  };

  constructor(config?: Partial<PressureSolverConfig>) {
    this.config = { ...DEFAULT_PRESSURE_SOLVER_CONFIG, ...config };
  }

  /** Get the status of the last pressure solve */
  getLastStatus(): PressureSolverStatus {
    return { ...this.lastStatus, K_max: this.config.K_max };
  }

  /**
   * Correct connection flow rates toward mass balance, weighted by node stiffness.
   *
   * Modifies conn.massFlowRate in place. Does NOT modify node pressures.
   *
   * @param state - Simulation state (flow rates modified in place)
   * @param dt - Timestep in seconds
   */
  solve(state: SimulationState, dt: number): void {
    if (state.flowNodes.size === 0 || !(dt > 0)) return;

    // Index the non-boundary nodes. Boundary nodes are fixed-state reservoirs:
    // their virtual pressure correction is 0 by definition, but their connections
    // still appear in neighbors' equations (they anchor the system).
    const index = new Map<string, number>();
    const nodeList: FlowNode[] = [];
    for (const [id, node] of state.flowNodes) {
      if (node.isBoundary) continue;
      index.set(id, nodeList.length);
      nodeList.push(node);
    }
    const n = nodeList.length;
    if (n === 0) return;

    // Node compliances c_i = rho*V/(K*dt): net inflow (kg/s) per Pa of pressure
    // rise over this timestep. Total mass includes NCG - for gas-filled nodes the
    // whole inventory responds to pressure, not just the steam fraction.
    const c = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const node = nodeList[i];
      const ncgMass = node.fluid.ncg ? ncgTotalMass(node.fluid.ncg) : 0;
      const totalMass = node.fluid.mass + ncgMass;
      const rho = totalMass / node.volume;
      const K = this.getEffectiveBulkModulus(node, rho);
      if (!isFinite(K) || K <= 0 || !isFinite(rho) || rho <= 0) {
        throw new Error(
          `[PressureSolver] Invalid compliance inputs for '${node.id}': ` +
          `K=${K} Pa, rho=${rho} kg/m³ (m=${totalMass} kg, V=${node.volume} m³, ` +
          `phase=${node.fluid.phase}, P=${node.fluid.pressure} Pa)`
        );
      }
      c[i] = (rho * node.volume) / (K * dt);
    }

    if (this.config.implicitMomentum) {
      this.solveImplicit(state, dt, index, nodeList, c, n);
      return;
    }

    // Build the linear system M * dP = b where
    //   M = diag(c) + weighted graph Laplacian of connection conductances
    //   b = current net mass inflow per node (kg/s)
    const M = new Float64Array(n * n);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) M[i * n + i] = c[i];

    const entries: ConnEntry[] = [];
    for (const conn of state.flowConnections) {
      const fromNode = state.flowNodes.get(conn.fromNodeId);
      const toNode = state.flowNodes.get(conn.toNodeId);
      if (!fromNode || !toNode) continue;

      const iFrom = index.get(conn.fromNodeId) ?? -1;
      const iTo = index.get(conn.toNodeId) ?? -1;
      if (iFrom < 0 && iTo < 0) continue;

      // Current imbalance contributions
      if (iFrom >= 0) b[iFrom] -= conn.massFlowRate;
      if (iTo >= 0) b[iTo] += conn.massFlowRate;

      const D = this.flowConductance(state, conn, fromNode, toNode, dt);
      if (!isFinite(D)) {
        throw new Error(`[PressureSolver] Non-finite conductance for connection '${conn.id}'`);
      }
      if (D <= 0) continue; // closed valve / held check valve - no flow response

      if (iFrom >= 0) {
        M[iFrom * n + iFrom] += D;
        if (iTo >= 0) M[iFrom * n + iTo] -= D;
      }
      if (iTo >= 0) {
        M[iTo * n + iTo] += D;
        if (iFrom >= 0) M[iTo * n + iFrom] -= D;
      }
      entries.push({ conn, D, iFrom, iTo });
    }

    // Direct solve (Gaussian elimination with partial pivoting). The matrix is
    // SPD (positive compliances + Laplacian), so this cannot legitimately fail;
    // if it does, the state itself is broken - fail loudly.
    const dP = solveLinearSystem(M, b, n);

    // Apply flow corrections: dm_j = D_j * (dP_from - dP_to)
    for (const { conn, D, iFrom, iTo } of entries) {
      const pFrom = iFrom >= 0 ? dP[iFrom] : 0;
      const pTo = iTo >= 0 ? dP[iTo] : 0;
      conn.massFlowRate += D * (pFrom - pTo);
    }

    // Residual imbalance is c_i * dP_i by construction - this is the (intended)
    // remaining net inflow that produces the real pressure change dP_i over dt.
    let maxResidual = 0;
    for (let i = 0; i < n; i++) {
      maxResidual = Math.max(maxResidual, Math.abs(c[i] * dP[i]));
    }

    this.lastStatus = {
      ran: true,
      iterations: 1,
      converged: true,
      stagnated: false,
      maxImbalance: maxResidual,
      K_max: this.config.K_max,
    };
  }

  /**
   * Fully implicit (backward-Euler) pressure-flow solve, RELAP-style.
   *
   * Replaces explicit momentum integration entirely: connection flows are set
   * to their end-of-step values ṁ¹, solved simultaneously with the virtual
   * node pressure corrections δP.
   *
   * Momentum per connection (friction/pump-curve linearized at ṁ⁰; note
   * dṁ/dt = (A/L)·ΔP since ṁ = ρAv and dv/dt = ΔP/(ρL) - density cancels):
   *
   *   ṁ¹ = ṁ⁰ + dt·(A/L)·[ ΔP⁰_net + (δP_from − δP_to) − R'·(ṁ¹ − ṁ⁰) ]
   *
   * which with D = (dt·A/L) / (1 + dt·A·R'/L) rearranges to
   *
   *   ṁ¹ = ṁ* + D·(δP_from − δP_to),   ṁ* = ṁ⁰ + D·ΔP⁰_net
   *
   * where ΔP⁰_net = ΔP_driving(ṁ⁰) + ΔP_friction(ṁ⁰) is the full explicit
   * driving pressure from the SAME model the explicit momentum operator uses
   * (connection-hydraulics.ts). Substituting into the node mass/compliance
   * closure Σ±ṁ¹ = c_i·δP_i gives the same SPD compliance+Laplacian system as
   * the correction-only path, just with ṁ* on the right-hand side instead of
   * ṁ⁰.
   *
   * Backward Euler damps every acoustic mode unconditionally (|amplification|
   * < 1 at all dt) yet D → dt·A/L as dt → 0, recovering explicit physics
   * (water hammer) when the user caps the timestep.
   *
   * Choked flow is a post-solve cap: capped connections become fixed-flow
   * sources (conductance dropped from the Laplacian) and the system is
   * re-solved once so neighbors see the capped flow (one RELAP-style outer
   * iteration).
   */
  private solveImplicit(
    state: SimulationState,
    dt: number,
    index: Map<string, number>,
    nodeList: FlowNode[],
    c: Float64Array,
    n: number
  ): void {
    interface ImplicitEntry {
      conn: FlowConnection;
      h: ConnectionHydraulics;
      D: number;       // conductance (kg/s per Pa)
      m0: number;      // start-of-step flow (kg/s)
      mStar: number;   // BE-predicted flow before pressure correction (kg/s)
      iFrom: number;
      iTo: number;
      choke: ChokeLimit | null;
      capped: boolean;
      cappedFlow: number;
    }

    // Fixed b contributions from connections that don't participate in the
    // solve (closed valves / held check valves, whose flows decay to zero).
    const bFixed = new Float64Array(n);
    const entries: ImplicitEntry[] = [];

    for (const conn of state.flowConnections) {
      const fromNode = state.flowNodes.get(conn.fromNodeId);
      const toNode = state.flowNodes.get(conn.toNodeId);
      if (!fromNode || !toNode) continue;

      const iFrom = index.get(conn.fromNodeId) ?? -1;
      const iTo = index.get(conn.toNodeId) ?? -1;

      const h = computeConnectionHydraulics(state, conn, fromNode, toNode);

      // Closed valve, closed governor, or check valve without cracking
      // pressure: no conductance, and the flow decays to zero (implicit form
      // of the explicit operator's dṁ/dt = -ṁ/τ).
      const closed =
        h.valveClosed ||
        h.governorClosed ||
        (h.checkValve !== undefined && h.dP_driving < h.crackingPressure);
      if (closed) {
        const mNew = conn.massFlowRate / (1 + dt / CLOSED_FLOW_DECAY_TAU);
        conn.massFlowRate = mNew;
        conn.isChoked = false;
        conn.machNumber = 0;
        if (iFrom >= 0) bFixed[iFrom] -= mNew;
        if (iTo >= 0) bFixed[iTo] += mNew;
        continue;
      }

      const m0 = conn.massFlowRate;
      // Momentum in mass-flow form: dṁ/dt = (A/L)·ΔP (ṁ = ρAv, the density
      // cancels), so the flow produced by 1 Pa over dt is G0 = dt·A/L.
      const G0 = (dt * h.A) / h.L;

      // Backward-Euler predictor with FULL quadratic resistance (pipe friction
      // plus the pump curve's quadratic falloff). Linearizing friction at ṁ⁰
      // is catastrophically wrong when |ṁ| grows in one step (friction ≈ 0 at
      // low flow lets the prediction overshoot the friction equilibrium by
      // multiples, then slam back - divergence in small nodes). The quadratic
      // BE has a closed form, is monotone in dt, and is bounded by the
      // friction-equilibrium flow √(ΔP/C) as dt → ∞:
      //
      //   ṁ* = ṁ⁰ + G0·(ΔP_nf − C·ṁ*|ṁ*|)
      //   ⇒ sign(ṁ*) = sign(b),  b = ṁ⁰ + G0·ΔP_nf
      //   ⇒ |ṁ*| = (√(1 + 4·G0·C·|b|) − 1) / (2·G0·C)
      //
      // ΔP_nf collects the non-quadratic driving terms (node pressures,
      // gravity, pump shutoff head); C is branch-dependent: forward flow sees
      // pipe friction + pump-curve quadratic, reverse flow sees pipe friction
      // + the reverse-block resistance of running pumps.
      const dP_nf = h.dP_pressure + h.dP_gravity + h.pumpShutoff;
      const b = m0 + G0 * dP_nf;
      const C = b >= 0
        ? h.frictionQuadForward + h.pumpQuad
        : h.frictionQuadReverse;
      const gC = G0 * C;
      let mStar: number;
      if (gC * Math.abs(b) < 1e-9) {
        // Resistance negligible over this step - linear limit (also avoids
        // 0/0 and floating-point cancellation in the closed form)
        mStar = b;
      } else {
        mStar = Math.sign(b) * (Math.sqrt(1 + 4 * gC * Math.abs(b)) - 1) / (2 * gC);
      }

      // Conductance for the δP coupling, linearized at the END-of-step flow
      // (resistance slope d(C·ṁ²)/dṁ = 2·C·|ṁ*|) - consistent with the
      // predictor instead of the stale start-of-step flow.
      const D = G0 / (1 + 2 * gC * Math.abs(mStar));
      if (!isFinite(D) || D < 0 || !isFinite(mStar)) {
        throw new Error(
          `[PressureSolver] Invalid implicit momentum for connection '${conn.id}': ` +
          `D=${D} kg/s/Pa, mStar=${mStar} kg/s (m0=${m0}, rho_flow=${h.rho_flow}, ` +
          `C=${C}, dP_nf=${dP_nf})`
        );
      }

      const choke = computeChokeLimit(conn, h.upstreamNode, h.downstreamNode, h.flowPhase, h.rho_flow);
      entries.push({ conn, h, D, m0, mStar, iFrom, iTo, choke, capped: false, cappedFlow: 0 });
    }

    // Assemble and solve (diag(c) + Laplacian(D)) δP = net predicted inflow.
    // Capped connections contribute as fixed flows with zero conductance.
    const solveNetwork = (): Float64Array => {
      const M = new Float64Array(n * n);
      const b = Float64Array.from(bFixed);
      for (let i = 0; i < n; i++) M[i * n + i] = c[i];
      for (const e of entries) {
        const flowFixed = e.capped;
        const flow = flowFixed ? e.cappedFlow : e.mStar;
        if (e.iFrom >= 0) b[e.iFrom] -= flow;
        if (e.iTo >= 0) b[e.iTo] += flow;
        if (flowFixed) continue;
        if (e.iFrom >= 0) {
          M[e.iFrom * n + e.iFrom] += e.D;
          if (e.iTo >= 0) M[e.iFrom * n + e.iTo] -= e.D;
        }
        if (e.iTo >= 0) {
          M[e.iTo * n + e.iTo] += e.D;
          if (e.iFrom >= 0) M[e.iTo * n + e.iFrom] -= e.D;
        }
      }
      return solveLinearSystem(M, b, n);
    };

    let dP = solveNetwork();
    const flowOf = (e: ImplicitEntry): number => {
      if (e.capped) return e.cappedFlow;
      const pFrom = e.iFrom >= 0 ? dP[e.iFrom] : 0;
      const pTo = e.iTo >= 0 ? dP[e.iTo] : 0;
      return e.mStar + e.D * (pFrom - pTo);
    };

    // Post-solve choked-flow capping. The sonic bound uses the same discharge
    // coefficients and 0.95 near-sonic margin as the explicit operator.
    let anyCapped = false;
    for (const e of entries) {
      if (!e.choke) continue;
      const capMag = e.choke.chokedByRatio
        ? e.choke.m_dot_choked
        : 0.95 * e.choke.m_dot_choked;
      const m1 = flowOf(e);
      if (Math.abs(m1) > capMag) {
        e.capped = true;
        e.cappedFlow = (m1 >= 0 ? 1 : -1) * capMag;
        anyCapped = true;
      }
    }

    // Secant compliance correction for saturation-dome-edge crossings.
    //
    // The compliance c_i is linearized at the start-of-step state, with the
    // bulk modulus blended across the dome edge to stay continuous. For a
    // node that the predicted inflow carries ONTO or ACROSS the liquid
    // boundary within this step (a hotwell pump body full of saturated
    // condensate is the canonical case), that linearization understates the
    // true stiffness by orders of magnitude: the solve then permits residual
    // inflow that the real EOS answers with a bar-scale pressure spike, which
    // the step controller must reject. Replace c_i with the secant compliance
    // of the true EOS response over this step - the absorbed mass divided by
    // the pressure rise the liquid branch actually produces - and re-solve.
    // This is one Newton-style iteration on the genuine nonlinearity; no
    // tuning constants beyond the physics already in the tables.
    let anyStiffened = false;
    for (let i = 0; i < n; i++) {
      const node = nodeList[i];
      const dm = c[i] * dP[i] * dt; // predicted absorbed mass this step (kg)
      if (!(dm > 0)) continue;      // only inflow compression spikes
      // NCG provides a real gas cushion - the liquid branch never applies
      const ncgMass = node.fluid.ncg ? ncgTotalMass(node.fluid.ncg) : 0;
      if (ncgMass > 1e-6 * node.fluid.mass) continue;

      const u = node.fluid.internalEnergy / node.fluid.mass;
      const v = node.volume / node.fluid.mass;
      const sat = distanceToSaturationLine(u, v);
      const v_f = sat.v_f_closest * 1e-6; // m³/kg
      if (!(v_f > 0)) continue;
      // Mass the node can still absorb before it is liquid-full at v_f
      // (≤ 0 means it is already on the liquid side of the edge)
      const mEdge = node.volume / v_f - node.fluid.mass;

      const K_liq = numericalBulkModulus(node.fluid.temperature - 273.15, this.config.K_max);
      let cSecant: number | null = null;
      if (mEdge <= 0) {
        // Already liquid: the true stiffness is the full liquid bulk modulus
        // (the dome-edge blend may have softened c_i by orders of magnitude)
        cSecant = node.fluid.mass / (K_liq * dt);
      } else if (dm > mEdge) {
        // Crossing into liquid this step: pressure response of the true EOS
        // is ~zero until the edge, then liquid compression beyond it
        const dP_true = (K_liq * (dm - mEdge)) / node.fluid.mass;
        cSecant = dm / (dP_true * dt);
      }
      // Only intervene when the true response is materially stiffer than the
      // linearization (avoid churn from tiny corrections)
      if (cSecant !== null && cSecant < 0.5 * c[i]) {
        c[i] = cSecant;
        anyStiffened = true;
      }
    }

    if (anyCapped || anyStiffened) {
      dP = solveNetwork();
    }

    // Apply end-of-step flows and refresh per-connection display state.
    for (const e of entries) {
      const m1 = flowOf(e);
      e.conn.massFlowRate = m1;
      const isChoked = e.choke !== null && e.choke.chokedByRatio;
      e.conn.isChoked = isChoked;
      e.conn.machNumber = e.choke
        ? (isChoked ? 1.0 : Math.min(1, Math.abs(m1 / (e.h.rho_flow * e.h.A)) / e.choke.soundSpeed))
        : 0;
      e.conn.debug = {
        flowPhase: e.h.flowPhase,
        rho_flow: e.h.rho_flow,
        dP_driving: e.h.dP_driving,
        dP_friction: e.h.dP_friction,
        dP_net: e.h.dP_driving + e.h.dP_friction,
        dMassFlowRate: (m1 - e.m0) / dt,
        isChoked,
        machNumber: e.conn.machNumber,
      };
    }

    // Residual imbalance c_i * dP_i is the intended remaining net inflow that
    // produces the real pressure change dP_i over dt (identical closure to the
    // correction-only path).
    let maxResidual = 0;
    for (let i = 0; i < n; i++) {
      maxResidual = Math.max(maxResidual, Math.abs(c[i] * dP[i]));
    }

    this.lastStatus = {
      ran: true,
      iterations: anyCapped ? 2 : 1,
      converged: true,
      stagnated: false,
      maxImbalance: maxResidual,
      K_max: this.config.K_max,
    };
  }

  /**
   * Get phase-appropriate effective bulk modulus for a node.
   *
   * The bulk modulus K = rho * (dP/drho) determines how pressure responds to
   * density changes.
   *
   * For liquid: temperature-dependent bulk modulus from steam tables
   * For two-phase: P_sat as scale (phase change absorbs density changes)
   * For vapor: gamma*P (ideal gas; also correct for NCG-dominated nodes since
   *   node pressure includes NCG partial pressure)
   *
   * Transitions near the saturation dome blend smoothly to avoid discontinuities.
   */
  private getEffectiveBulkModulus(node: FlowNode, _rho: number): number {
    const phase = node.fluid.phase;
    const T_K = node.fluid.temperature;
    const P = node.fluid.pressure;

    // Heat capacity ratio for steam (used for vapor)
    const gamma = 1.3;

    if (phase !== 'liquid' && phase !== 'two-phase') {
      // Vapor (including NCG-dominated nodes): ideal gas K = gamma*P
      return gamma * P;
    }

    // Liquid and two-phase share one continuous treatment across the liquid
    // saturation line. K spans ~6 orders of magnitude between compressed liquid
    // (~2.2 GPa) and low-pressure two-phase (~P_sat), so the transition must be:
    // - wide enough that a node can't cross it in one timestep's worth of mass
    //   flow (a hair-thin blend lets mass flood into a "soft" barely-two-phase
    //   node, which then punches out into stiff liquid with an MPa-scale jump)
    // - geometric (log-space): a linear blend of values 6 decades apart stays
    //   pinned at the large value for almost the whole zone.
    //
    // BLEND_DISTANCE = 10 mL/kg is ~1% of v_f. In quality terms it covers only
    // x < ~0.001 at typical pressures, so genuinely two-phase nodes (condensers,
    // pressurizers, boiling SG shells) are untouched.
    const P_sat = saturationPressure(T_K);
    const K_liquid = numericalBulkModulus(T_K - 273.15, this.config.K_max);

    const u = node.fluid.internalEnergy / node.fluid.mass;
    const v = node.volume / node.fluid.mass;
    // distance > 0: liquid side (v < v_f); distance < 0: inside the dome
    const satDist = distanceToSaturationLine(u, v);

    const BLEND_DISTANCE = 10; // mL/kg
    // blend = 0 -> pure liquid K, blend = 1 -> pure two-phase K (P_sat)
    const blend = Math.min(1, Math.max(0, (BLEND_DISTANCE - satDist.distance) / (2 * BLEND_DISTANCE)));
    if (blend <= 0) return K_liquid;
    if (blend >= 1) return P_sat;
    return Math.exp((1 - blend) * Math.log(K_liquid) + blend * Math.log(P_sat));
  }

  /**
   * Flow response of a connection to virtual pressure corrections (kg/s per Pa),
   * from the same momentum equation FlowMomentumRateOperator integrates:
   *
   *   d(mdot)/dt = (A / (rho*L)) * (dP_driving + dP_friction(mdot))
   *
   * Implicit over dt with friction linearized around the current flow:
   *
   *   D = dt*A/(rho*L) / (1 + dt * K_eff * |v| / (rho*L))
   *
   * Returns 0 for connections that cannot respond (closed valves, held check
   * valves) so they drop out of the correction network entirely.
   */
  private flowConductance(
    state: SimulationState,
    conn: FlowConnection,
    fromNode: FlowNode,
    toNode: FlowNode,
    dt: number
  ): number {
    // Closed valve: no flow response
    const valve = this.findValveOnConnection(state, conn.id);
    if (valve && valve.position < 0.01) return 0;

    // Check valve currently holding (no forward flow): treat as closed.
    // FlowDynamicsConstraintOperator zeroes reverse flow through check valves,
    // so a non-positive flow means the valve is shut.
    // Check valves are keyed by component id with connectedFlowPath naming the
    // guarded connection (matching findCheckValveForConnection in rate-operators).
    let checkValve: { crackingPressure: number } | undefined;
    if (state.components.checkValves) {
      for (const [, cv] of state.components.checkValves) {
        if (cv.connectedFlowPath === conn.id) { checkValve = cv; break; }
      }
      checkValve = checkValve ?? state.components.checkValves.get(conn.id);
    }
    if (checkValve && conn.massFlowRate <= 0) return 0;

    // Governor valve on turbine inlet (mirrors FlowMomentumRateOperator)
    const governorValve = toNode.governorValve;
    if (governorValve !== undefined && governorValve < 0.01) return 0;

    const A = conn.flowArea || 0.1;
    const L = conn.length && conn.length > 0 ? conn.length : 10;

    // Upstream density by current flow direction (total mass including NCG)
    const upstream = conn.massFlowRate >= 0 ? fromNode : toNode;
    const ncgMass = upstream.fluid.ncg ? ncgTotalMass(upstream.fluid.ncg) : 0;
    const rho = (upstream.fluid.mass + ncgMass) / upstream.volume;
    if (!isFinite(rho) || rho <= 0) return 0;

    // Effective resistance for friction linearization (mirrors momentum operator)
    const K_base = conn.resistanceCoeff || 10;
    let K_eff = K_base;
    if (valve) {
      K_eff = K_eff / Math.pow(Math.max(0.01, valve.position), 2);
    }
    if (governorValve !== undefined && governorValve < 1.0) {
      K_eff = K_eff / Math.pow(Math.max(0.01, governorValve), 2);
    }

    // Running pumps block reverse flow with very high friction
    const pumpOnOutlet = this.findPumpOnConnection(state, conn.id);
    if (pumpOnOutlet && pumpOnOutlet.running && conn.massFlowRate < 0) {
      K_eff += 10000 * K_base;
    }
    const pumpOnInlet = state.components.pumps.get(conn.toNodeId);
    if (pumpOnInlet && pumpOnInlet.running && conn.massFlowRate < 0) {
      K_eff += 10000 * K_base;
    }

    const v = conn.massFlowRate / (rho * A);
    const G0 = (dt * A) / (rho * L);

    // Damping from resistances that grow with flow: friction slope K_eff*|v|/A,
    // plus the falling pump head curve (both in Pa per (kg/s))
    let resistanceSlope = (K_eff * Math.abs(v)) / A;
    if (pumpOnOutlet && pumpOnOutlet.running) {
      resistanceSlope += pumpHeadSlopeMagnitude(pumpOnOutlet, conn.massFlowRate, rho);
    }
    const damping = 1 + (dt * A * resistanceSlope) / (rho * L);

    return G0 / damping;
  }

  /**
   * Find a valve connected to the given flow path.
   */
  private findValveOnConnection(
    state: SimulationState,
    connId: string
  ): { position: number } | undefined {
    for (const [, valve] of state.components.valves) {
      if (valve.connectedFlowPath === connId) {
        return valve;
      }
    }
    return undefined;
  }

  /**
   * Find a pump whose outlet is the given flow path.
   */
  private findPumpOnConnection(
    state: SimulationState,
    connId: string
  ): { running: boolean; effectiveSpeed: number; ratedHead: number; ratedFlow: number } | undefined {
    for (const [, pump] of state.components.pumps) {
      if (pump.connectedFlowPath === connId) {
        return pump;
      }
    }
    return undefined;
  }
}

/**
 * Solve M*x = b via Gaussian elimination with partial pivoting.
 * M is n x n row-major and is destroyed in the process; b is destroyed too.
 */
function solveLinearSystem(M: Float64Array, b: Float64Array, n: number): Float64Array {
  for (let col = 0; col < n; col++) {
    // Partial pivot
    let pivotRow = col;
    let pivotMag = Math.abs(M[col * n + col]);
    for (let row = col + 1; row < n; row++) {
      const mag = Math.abs(M[row * n + col]);
      if (mag > pivotMag) {
        pivotMag = mag;
        pivotRow = row;
      }
    }
    if (pivotMag === 0 || !isFinite(pivotMag)) {
      throw new Error(
        `[PressureSolver] Singular or non-finite system at column ${col} - ` +
        `flow network state is inconsistent`
      );
    }
    if (pivotRow !== col) {
      for (let k = col; k < n; k++) {
        const tmp = M[col * n + k];
        M[col * n + k] = M[pivotRow * n + k];
        M[pivotRow * n + k] = tmp;
      }
      const tmpB = b[col];
      b[col] = b[pivotRow];
      b[pivotRow] = tmpB;
    }

    // Eliminate below
    const pivot = M[col * n + col];
    for (let row = col + 1; row < n; row++) {
      const factor = M[row * n + col] / pivot;
      if (factor === 0) continue;
      M[row * n + col] = 0;
      for (let k = col + 1; k < n; k++) {
        M[row * n + k] -= factor * M[col * n + k];
      }
      b[row] -= factor * b[col];
    }
  }

  // Back substitution
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row];
    for (let k = row + 1; k < n; k++) {
      sum -= M[row * n + k] * x[k];
    }
    x[row] = sum / M[row * n + row];
  }
  return x;
}
