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
