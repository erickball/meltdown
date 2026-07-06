/**
 * Shared per-connection hydraulics model.
 *
 * ONE model, TWO callers: FlowMomentumRateOperator (explicit dṁ/dt for RK45)
 * and PressureSolver (semi-implicit / fully implicit momentum update). Both
 * must see exactly the same driving pressures, densities, resistances, and
 * choking limits, or the implicit solve would relax flows toward a different
 * equilibrium than the explicit physics defines.
 *
 * The momentum equation both callers discretize:
 *
 *   dṁ/dt = (A / (ρ_flow · L)) · (ΔP_driving + ΔP_friction(ṁ))
 *
 *   ΔP_driving  = ΔP_pressure (hydrostatic-corrected) + ΔP_gravity + ΔP_pump
 *   ΔP_friction = -K_eff · ½ · ρ_flow · v·|v|
 *
 * This module is deliberately free of imports from rate-operators.ts /
 * pressure-solver.ts so both can import it without cycles.
 */

import { SimulationState, FlowNode, FlowConnection } from '../types';
import {
  totalMoles,
  ncgSoundSpeed,
  steamNcgSoundSpeed,
  R_GAS,
} from '../gas-properties';
import { soundSpeed, criticalPressureRatio, WaterState } from '../water-properties-v4';
import { pumpHeadPressure, pumpHeadSlopeMagnitude } from './pump-curve';

// ============================================================================
// Phase Separation Calculation (shared utility)
// ============================================================================

/**
 * Calculate phase separation factor for a two-phase node.
 * separation = 0 means fully mixed (homogeneous)
 * separation = 1 means fully separated (distinct liquid and vapor regions)
 *
 * This is used by both rendering (to show pixelation) and flow calculations
 * (to determine what phase flows out of connections at different elevations).
 */
// Debug flag for separation calculation
let separationDebugEnabled = false;
let separationDebugLastLog = 0;

export function setSeparationDebug(enabled: boolean): void {
  separationDebugEnabled = enabled;
}

export function calculateSeparation(node: FlowNode, massFlowRate: number): number {
  // Pumps, pipes, valves, turbines are always well-mixed (small volume, high turbulence)
  // Condensers CAN separate - they have a hotwell where liquid collects
  const id = node.id.toLowerCase();
  if (id.startsWith('pum-') || id.startsWith('pip-') || id.startsWith('val-') ||
      id.startsWith('tur-') || id.startsWith('tdp-')) {
    return 0;  // No separation
  }

  // If height is explicitly 0, the node is well-mixed
  if (node.height === 0) {
    if (separationDebugEnabled && id.startsWith('con-')) {
      console.log(`[Sep] ${node.id}: height=0, returning 0`);
    }
    return 0;
  }

  // Get node height - use stored value or estimate from volume
  const nodeHeight = node.height ?? Math.cbrt(node.volume);  // Assume cube if no height
  if (nodeHeight < 0.1) {
    if (separationDebugEnabled && id.startsWith('con-')) {
      console.log(`[Sep] ${node.id}: nodeHeight=${nodeHeight.toFixed(3)}m < 0.1m, returning 0`);
    }
    return 0;  // Too small for meaningful separation
  }

  // Get flow properties
  const quality = node.fluid.quality ?? 0;
  const T_C = node.fluid.temperature - 273.15;
  const P = node.fluid.pressure;

  // Approximate saturated liquid/vapor densities
  const rho_liquid = T_C < 100 ? 1000 - 0.08 * T_C :
                     T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                     Math.max(400, 700 - 2.5 * (T_C - 300));
  const rho_vapor = Math.max(0.1, P * 0.018 / (8.314 * node.fluid.temperature));
  const rho_mixture = rho_liquid * (1 - quality) + rho_vapor * quality;

  // Density difference drives separation
  const delta_rho = rho_liquid - rho_vapor;

  // Characteristic bubble/droplet size (m)
  // Smaller at higher pressure due to surface tension effects
  const d_bubble = 0.005 * Math.sqrt(1e5 / Math.max(P, 1e5));  // ~5mm at 1 bar, smaller at high P

  // Terminal settling velocity (simplified Stokes drag)
  // v_settle = (Δρ × g × d²) / (18 × μ)
  // For water at typical conditions, μ ≈ 0.0003 Pa·s
  const g = 9.81;
  const mu = 0.0003;
  const v_settle = (delta_rho * g * d_bubble * d_bubble) / (18 * mu);

  // Flow velocity through the node
  // Use the node's internal flow area, not the connection flow area
  const v_flow = Math.abs(massFlowRate) / (rho_mixture * Math.max(node.flowArea, 0.01));

  // Residence time
  const tau = node.volume * rho_mixture / Math.max(Math.abs(massFlowRate), 0.01);

  // Separation height achievable during residence time
  const h_sep = v_settle * tau;

  // Separation factor based on how much of the height can be settled
  let separation = Math.min(1, h_sep / nodeHeight);

  // Reduce separation if flow velocity is high relative to settling velocity
  // High turbulence from flow re-mixes the phases
  const turbulence_factor = v_flow > 0.01 ? Math.exp(-v_flow / v_settle) : 1;
  if (v_flow > 0.01) {
    separation *= turbulence_factor;
  }

  // Debug logging for condensers
  if (separationDebugEnabled && id.startsWith('con-')) {
    const now = Date.now();
    if (now - separationDebugLastLog > 1000) {  // Log at most once per second
      separationDebugLastLog = now;
      console.log(`[Sep] ${node.id}: height=${node.height}, nodeHeight=${nodeHeight.toFixed(2)}m, ` +
        `vol=${node.volume.toFixed(1)}m³, flowArea=${node.flowArea.toFixed(3)}m², ` +
        `x=${(quality*100).toFixed(1)}%, mdot=${massFlowRate.toFixed(1)}kg/s`);
      console.log(`      ρ_liq=${rho_liquid.toFixed(0)}, ρ_vap=${rho_vapor.toFixed(3)}, ρ_mix=${rho_mixture.toFixed(1)}, ` +
        `Δρ=${delta_rho.toFixed(0)}, d_bub=${(d_bubble*1000).toFixed(1)}mm`);
      console.log(`      v_settle=${v_settle.toFixed(3)}m/s, v_flow=${v_flow.toFixed(3)}m/s, ` +
        `τ=${tau.toFixed(1)}s, h_sep=${h_sep.toFixed(2)}m`);
      console.log(`      h_sep/H=${(h_sep/nodeHeight).toFixed(2)}, turb_factor=${turbulence_factor.toFixed(3)}, ` +
        `sep=${(separation*100).toFixed(1)}%`);
    }
  }

  // Clamp to valid range
  return Math.max(0, Math.min(1, separation));
}

// ============================================================================
// Liquid Level Calculation with Internal Obstructions
// ============================================================================

/**
 * Calculate liquid level in a node that may contain internal obstructions.
 *
 * For nodes with internal components (e.g., reactor vessel with core barrel),
 * the available cross-sectional area varies with elevation. This function
 * computes the liquid level accounting for this variation.
 *
 * Given liquid volume V_liq, we need to find height h such that:
 *   V_liq = ∫₀ʰ A(z) dz
 *
 * where A(z) = A_outer - Σ A_obstruction(z) for obstructions present at elevation z.
 *
 * @param node The flow node
 * @param liquidVolume Volume of liquid to fill (m³)
 * @returns Liquid level height from node bottom (m)
 */
export function calculateLiquidLevelWithObstructions(node: FlowNode, liquidVolume: number): number {
  const nodeHeight = node.height ?? Math.cbrt(node.volume);
  if (nodeHeight <= 0) return 0;

  // Base cross-sectional area (total volume / height)
  const baseArea = node.volume / nodeHeight;

  // If no obstructions, simple calculation
  if (!node.internalObstructions || node.internalObstructions.length === 0) {
    return Math.min(nodeHeight, liquidVolume / baseArea);
  }

  // Build sorted list of elevation breakpoints where area changes
  const breakpoints = new Set<number>([0, nodeHeight]);
  for (const obs of node.internalObstructions) {
    if (obs.bottomElevation > 0 && obs.bottomElevation < nodeHeight) {
      breakpoints.add(obs.bottomElevation);
    }
    if (obs.topElevation > 0 && obs.topElevation < nodeHeight) {
      breakpoints.add(obs.topElevation);
    }
  }
  const sortedBreakpoints = Array.from(breakpoints).sort((a, b) => a - b);

  // Calculate area at a given elevation
  const getAreaAt = (z: number): number => {
    let area = baseArea;
    for (const obs of node.internalObstructions!) {
      if (z >= obs.bottomElevation && z < obs.topElevation) {
        area -= obs.crossSectionalArea;
      }
    }
    return Math.max(0, area); // Never negative
  };

  // Integrate piecewise to find liquid level
  let volumeAccumulated = 0;

  for (let i = 0; i < sortedBreakpoints.length - 1; i++) {
    const z_low = sortedBreakpoints[i];
    const z_high = sortedBreakpoints[i + 1];
    const sliceArea = getAreaAt((z_low + z_high) / 2); // Area is constant in this slice
    const sliceHeight = z_high - z_low;
    const sliceVolume = sliceArea * sliceHeight;

    if (volumeAccumulated + sliceVolume >= liquidVolume) {
      // Liquid level is within this slice
      const remainingVolume = liquidVolume - volumeAccumulated;
      const levelInSlice = sliceArea > 0 ? remainingVolume / sliceArea : 0;
      return z_low + levelInSlice;
    }

    volumeAccumulated += sliceVolume;
  }

  // Liquid volume exceeds node capacity - return max height
  return nodeHeight;
}

/**
 * Calculate the total available volume in a node up to a given elevation,
 * accounting for internal obstructions.
 *
 * This is the inverse operation of calculateLiquidLevelWithObstructions.
 *
 * @param node The flow node
 * @param elevation Height from node bottom (m)
 * @returns Volume available up to that elevation (m³)
 */
export function calculateVolumeAtElevation(node: FlowNode, elevation: number): number {
  const nodeHeight = node.height ?? Math.cbrt(node.volume);
  if (nodeHeight <= 0 || elevation <= 0) return 0;

  const clampedElevation = Math.min(elevation, nodeHeight);
  const baseArea = node.volume / nodeHeight;

  // If no obstructions, simple calculation
  if (!node.internalObstructions || node.internalObstructions.length === 0) {
    return baseArea * clampedElevation;
  }

  // Build sorted list of elevation breakpoints
  const breakpoints = new Set<number>([0, clampedElevation]);
  for (const obs of node.internalObstructions) {
    if (obs.bottomElevation > 0 && obs.bottomElevation < clampedElevation) {
      breakpoints.add(obs.bottomElevation);
    }
    if (obs.topElevation > 0 && obs.topElevation < clampedElevation) {
      breakpoints.add(obs.topElevation);
    }
  }
  const sortedBreakpoints = Array.from(breakpoints).sort((a, b) => a - b);

  // Calculate area at a given elevation
  const getAreaAt = (z: number): number => {
    let area = baseArea;
    for (const obs of node.internalObstructions!) {
      if (z >= obs.bottomElevation && z < obs.topElevation) {
        area -= obs.crossSectionalArea;
      }
    }
    return Math.max(0, area);
  };

  // Integrate piecewise
  let totalVolume = 0;
  for (let i = 0; i < sortedBreakpoints.length - 1; i++) {
    const z_low = sortedBreakpoints[i];
    const z_high = sortedBreakpoints[i + 1];
    const sliceArea = getAreaAt((z_low + z_high) / 2);
    totalVolume += sliceArea * (z_high - z_low);
  }

  return totalVolume;
}

// ============================================================================
// Check valve lookup
// ============================================================================

/**
 * Find the check valve guarding a flow connection.
 *
 * Check valves created from plant components are keyed by COMPONENT id with
 * the guarded connection recorded in connectedFlowPath, so a plain
 * checkValves.get(conn.id) never matches them (a long-standing silent bug -
 * user-built check valves did nothing). Match connectedFlowPath, with a
 * map-key fallback for any connection-keyed entries.
 */
export function findCheckValveForConnection(
  state: SimulationState,
  connId: string
): { crackingPressure: number } | undefined {
  if (!state.components.checkValves) return undefined;
  for (const [, cv] of state.components.checkValves) {
    if (cv.connectedFlowPath === connId) return cv;
  }
  return state.components.checkValves.get(connId);
}

// ============================================================================
// Node-local property helpers (shared between explicit and implicit callers)
// ============================================================================

/**
 * Calculate pressure at a specific connection elevation within a node,
 * accounting for hydrostatic head within the node.
 */
export function pressureAtConnection(node: FlowNode, connectionElevation?: number): number {
  const g = 9.81;
  const baseP = node.fluid.pressure;

  // Estimate node height (assume cylindrical with height ≈ diameter)
  const nodeHeight = Math.sqrt(node.volume / (Math.PI * 0.25));

  if (connectionElevation === undefined) {
    connectionElevation = nodeHeight / 2;
  }

  if (node.fluid.phase === 'two-phase') {
    // Calculate liquid level from quality
    const quality = node.fluid.quality || 0;
    // Approximate liquid/vapor densities
    const T_C = node.fluid.temperature - 273.15;
    const rho_liquid = T_C < 100 ? 1000 - 0.08 * T_C :
                       T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                       700 - 2.5 * (T_C - 300);
    const rho_vapor = node.fluid.pressure * 0.018 / (8.314 * node.fluid.temperature);

    // Void fraction and liquid level
    const voidFraction = (quality * rho_liquid) / (quality * rho_liquid + (1 - quality) * rho_vapor);
    const liquidVolumeFraction = 1 - voidFraction;
    const liquidLevel = nodeHeight * liquidVolumeFraction;

    if (connectionElevation < liquidLevel) {
      // Below liquid: add hydrostatic head
      return baseP + rho_liquid * g * (liquidLevel - connectionElevation);
    }
    return baseP;  // In steam space
  } else if (node.fluid.phase === 'liquid') {
    // Liquid nodes: base pressure is at top, add hydrostatic head below
    const rho = node.fluid.mass / node.volume;
    const liquidHead = nodeHeight - connectionElevation;
    return baseP + rho * g * liquidHead;
  }

  return baseP;  // Vapor - no adjustment
}

/**
 * Get approximate saturated liquid density at node temperature
 */
export function approxLiquidDensity(node: FlowNode): number {
  const T_C = node.fluid.temperature - 273.15;
  if (T_C < 100) {
    return 1000 - 0.08 * T_C;
  } else if (T_C < 300) {
    return 958 - 1.3 * (T_C - 100);
  } else {
    return Math.max(400, 700 - 2.5 * (T_C - 300));
  }
}

/**
 * Get approximate saturated vapor density at node conditions
 */
export function approxVaporDensity(node: FlowNode): number {
  // Ideal gas approximation: ρ = PM/(RT)
  const P = node.fluid.pressure;
  const T = node.fluid.temperature;
  const M = 0.018; // kg/mol for water
  const R = 8.314; // J/mol-K
  return Math.max(0.1, P * M / (R * T));
}

/**
 * Determine what phase is flowing based on connection elevation and liquid level.
 * (Momentum-equation variant: separation evaluated at zero throughput.)
 * @param node The upstream flow node
 * @param connectionElevation Height of connection relative to node bottom (m)
 * @param phaseTolerance Tolerance zone around interface (m). 0 = no tolerance, undefined = use default.
 */
export function momentumFlowPhase(
  node: FlowNode,
  connectionElevation?: number,
  phaseTolerance?: number
): 'liquid' | 'vapor' | 'mixture' {
  // Single phase nodes always flow their phase
  if (node.fluid.phase !== 'two-phase') {
    return node.fluid.phase === 'vapor' ? 'vapor' : 'liquid';
  }

  // Get node height
  const nodeHeight = node.height ?? Math.sqrt(node.volume / (Math.PI * 0.25));

  // Default to mid-height if not specified
  if (connectionElevation === undefined) {
    connectionElevation = nodeHeight / 2;
  }

  // Calculate separation factor - use the shared function
  // For simplicity here, assume good separation for condensers (high residence time)
  const separation = calculateSeparation(node, 0);

  // If separation is low, return mixture
  if (separation < 0.1) {
    return 'mixture';
  }

  // Calculate liquid level based on actual mass in the node
  // For separated two-phase: liquid mass settles at the bottom
  const quality = node.fluid.quality ?? 0;
  const rho_liquid = approxLiquidDensity(node);

  // Calculate liquid mass and volume
  const liquidMass = node.fluid.mass * (1 - quality);
  const liquidVolume = liquidMass / rho_liquid;

  // Calculate liquid level accounting for internal obstructions
  const liquidLevel = calculateLiquidLevelWithObstructions(node, liquidVolume);

  // Tolerance zone around the interface
  // If phaseTolerance is specified (including 0), use it directly
  // Otherwise use default: wider when separation is low
  const tolerance = phaseTolerance !== undefined
    ? phaseTolerance
    : 0.1 + (1 - separation) * nodeHeight * 0.3;

  if (connectionElevation < liquidLevel - tolerance) {
    return 'liquid';
  } else if (connectionElevation > liquidLevel + tolerance) {
    return 'vapor';
  }
  return 'mixture';
}

/**
 * Calculate sound speed for choked flow detection.
 * Accounts for NCG presence using mixture properties.
 */
export function nodeSoundSpeed(node: FlowNode, flowPhase: 'liquid' | 'vapor' | 'mixture'): number {
  // Liquid is essentially incompressible - very high sound speed
  if (flowPhase === 'liquid') {
    return 1500; // m/s - approximate for water
  }

  const fluid = node.fluid;
  const T = fluid.temperature;
  const P = fluid.pressure;
  const V = node.volume;

  // Check if NCG is present
  const ncg = fluid.ncg;
  const ncgMoles = ncg ? totalMoles(ncg) : 0;

  if (ncgMoles > 0 && V > 0) {
    // NCG is present - calculate mixture sound speed
    const P_ncg = ncgMoles * R_GAS * T / V;
    const P_steam = Math.max(0, P - P_ncg);
    const steamMoles = P_steam * V / (R_GAS * T);

    if (steamMoles < ncgMoles * 0.02) {
      // Negligible steam - use pure NCG sound speed
      return ncgSoundSpeed(ncg!, T);
    } else {
      // Steam + NCG mixture
      return steamNcgSoundSpeed(ncg!, steamMoles, T);
    }
  }

  // Pure steam - use water properties
  const quality = fluid.phase === 'two-phase' ? (fluid.quality ?? 0.5) : (flowPhase === 'vapor' ? 1 : 0);
  const rho = flowPhase === 'vapor'
    ? approxVaporDensity(node)
    : flowPhase === 'mixture'
      ? fluid.mass / V
      : approxLiquidDensity(node);

  const waterState: WaterState = {
    temperature: T,
    pressure: P,
    density: rho,
    phase: flowPhase === 'mixture' ? 'two-phase' : flowPhase,
    quality: quality,
    specificEnergy: fluid.internalEnergy / fluid.mass,
  };

  return soundSpeed(waterState);
}

/**
 * Get critical pressure ratio for choked flow detection.
 * Returns the P_downstream/P_upstream ratio below which flow is choked.
 */
export function nodeCriticalPressureRatio(node: FlowNode, flowPhase: 'liquid' | 'vapor' | 'mixture'): number {
  if (flowPhase === 'liquid') {
    return 0; // Liquid doesn't choke
  }

  const fluid = node.fluid;
  const ncg = fluid.ncg;
  const ncgMoles = ncg ? totalMoles(ncg) : 0;

  // NCG mixtures use air-like critical ratio
  if (ncgMoles > 0) {
    return 0.53; // gamma ≈ 1.4 for air
  }

  // Pure steam - use water properties
  const quality = fluid.phase === 'two-phase' ? (fluid.quality ?? 0.5) : (flowPhase === 'vapor' ? 1 : 0);
  const rho = flowPhase === 'vapor'
    ? approxVaporDensity(node)
    : fluid.mass / node.volume;

  const waterState: WaterState = {
    temperature: fluid.temperature,
    pressure: fluid.pressure,
    density: rho,
    phase: flowPhase === 'mixture' ? 'two-phase' : flowPhase,
    quality: quality,
    specificEnergy: fluid.internalEnergy / fluid.mass,
  };

  return criticalPressureRatio(waterState);
}

// ============================================================================
// Full connection hydraulics
// ============================================================================

/** Default decay time constant for flow through a closed valve/check valve (s) */
export const CLOSED_FLOW_DECAY_TAU = 0.1;

export interface ConnectionHydraulics {
  A: number;                 // flow area (m²)
  L: number;                 // pipe length (m)
  flowPhase: 'liquid' | 'vapor' | 'mixture';
  rho_flow: number;          // density of the phase actually flowing (kg/m³)
  v: number;                 // velocity at current flow (m/s)
  dP_pressure: number;       // hydrostatic-corrected node pressure difference (Pa)
  dP_gravity: number;        // gravity head along the connection (Pa)
  dP_pump: number;           // pump head at current flow (Pa)
  dP_driving: number;        // dP_pressure + dP_gravity + dP_pump (Pa)
  dP_friction: number;       // friction at current flow, signed to oppose it (Pa)
  K_eff: number;             // effective resistance coefficient
  /** d(resisting pressure)/d(ṁ) ≥ 0: friction slope + falling pump-curve slope,
   *  in Pa per (kg/s). Used to linearize implicit/damped flow updates. */
  resistanceSlope: number;
  /** Quadratic friction coefficient C in dP_friction = -C·ṁ|ṁ|, i.e.
   *  C = K_eff/(2·ρ_flow·A²), in Pa/(kg/s)². Resolved for BOTH candidate flow
   *  directions so a fully implicit momentum step can pick the branch of the
   *  end-of-step flow sign (the reverse-block friction through running pumps
   *  is direction-structural, not a function of the current flow sign). */
  frictionQuadForward: number;
  frictionQuadReverse: number;
  /** Pump-curve decomposition dP_pump(ṁ) = pumpShutoff − pumpQuad·max(0,ṁ)²
   *  for a running pump driving this connection (both 0 when none). */
  pumpShutoff: number;       // Pa at current speed
  pumpQuad: number;          // Pa/(kg/s)²
  valveClosed: boolean;      // in-line valve at <1% open
  governorClosed: boolean;   // turbine governor valve at <1% open
  checkValve?: { crackingPressure: number };
  crackingPressure: number;  // 0 when no check valve present
  upstreamNode: FlowNode;
  downstreamNode: FlowNode;
}

export interface ChokeLimit {
  soundSpeed: number;     // m/s at upstream conditions
  m_dot_choked: number;   // kg/s sonic bound incl. discharge coefficient
  critRatio: number;      // critical P_down/P_up ratio (0 = never chokes)
  actualRatio: number;    // current P_down/P_up
  chokedByRatio: boolean; // pressure ratio is below critical
}

/**
 * Compute the choking limit for a connection, or null when the flowing phase
 * is liquid (which does not choke).
 */
export function computeChokeLimit(
  conn: FlowConnection,
  upstreamNode: FlowNode,
  downstreamNode: FlowNode,
  flowPhase: 'liquid' | 'vapor' | 'mixture',
  rho_flow: number
): ChokeLimit | null {
  if (flowPhase === 'liquid') return null;

  const A = conn.flowArea || 0.1;
  const c = nodeSoundSpeed(upstreamNode, flowPhase);
  const m_dot_sonic = rho_flow * A * c;

  // Apply discharge coefficient for restrictions
  const dischargeCoeff = conn.breakDischargeCoeff ?? (conn.isBreakConnection ? 0.62 : 0.85);
  const m_dot_choked = dischargeCoeff * m_dot_sonic;

  const critRatio = nodeCriticalPressureRatio(upstreamNode, flowPhase);
  const P_up = upstreamNode.fluid.pressure;
  const P_down = downstreamNode.fluid.pressure;
  const actualRatio = P_down / P_up;

  return {
    soundSpeed: c,
    m_dot_choked,
    critRatio,
    actualRatio,
    chokedByRatio: critRatio > 0 && actualRatio < critRatio,
  };
}

/**
 * Evaluate the shared momentum-equation ingredients for a connection at its
 * current flow rate. Pure evaluation - never mutates state.
 */
export function computeConnectionHydraulics(
  state: SimulationState,
  conn: FlowConnection,
  fromNode: FlowNode,
  toNode: FlowNode
): ConnectionHydraulics {
  let L = conn.length;
  if (!L || L <= 0) {
    L = 10; // Default 10m pipe length
  }
  const A = conn.flowArea || 0.1;
  const currentFlow = conn.massFlowRate;

  // For momentum/inertia, use upstream density - that's the fluid actually moving
  const rho_from = fromNode.fluid.mass / fromNode.volume;
  const rho_to = toNode.fluid.mass / toNode.volume;
  const upstreamNode = currentFlow >= 0 ? fromNode : toNode;
  const downstreamNode = currentFlow >= 0 ? toNode : fromNode;
  const upstreamElevation = currentFlow >= 0 ? conn.fromElevation : conn.toElevation;
  const upstreamPhaseTolerance = currentFlow >= 0 ? conn.fromPhaseTolerance : conn.toPhaseTolerance;
  const rho_upstream = currentFlow >= 0 ? rho_from : rho_to;

  // Determine what phase is flowing based on connection elevation at upstream node
  const flowPhase = momentumFlowPhase(upstreamNode, upstreamElevation, upstreamPhaseTolerance);

  // Get density for the flowing phase
  let rho_flow: number;
  if (flowPhase === 'liquid') {
    rho_flow = approxLiquidDensity(upstreamNode);
  } else if (flowPhase === 'vapor') {
    rho_flow = approxVaporDensity(upstreamNode);
  } else {
    rho_flow = rho_upstream; // mixture - use actual density
  }

  // Current velocity - use flow density since that's what's actually moving
  const v = currentFlow / (rho_flow * A);

  // === Driving pressures ===

  // Pressure difference at connection points, with hydrostatic adjustment
  const P_from = pressureAtConnection(fromNode, conn.fromElevation);
  const P_to = pressureAtConnection(toNode, conn.toElevation);
  const dP_pressure = P_from - P_to;

  // Gravity head (positive = downward flow is favored) - uses the density of
  // the fluid actually filling the pipe between the nodes.
  const g = 9.81;
  const dz = conn.elevation || 0; // positive = upward
  const dP_gravity = -rho_flow * g * dz;

  // Pump head - need to determine correct density for pump suction
  let dP_pump = 0;
  let pumpShutoff = 0;
  let pumpQuad = 0;
  let runningPumpOnOutlet: {
    running: boolean; effectiveSpeed: number; ratedHead: number; ratedFlow: number;
  } | undefined;
  for (const [, pump] of state.components.pumps) {
    if (pump.connectedFlowPath === conn.id && pump.running && pump.effectiveSpeed > 0) {
      runningPumpOnOutlet = pump;
      // The head an impeller develops scales with the density of the fluid IN
      // the pump - which is the from-node of its outlet connection (pump
      // components are their own flow nodes). For forward flow this is also
      // the flow-direction upstream node; for momentary reverse flow it must
      // STILL be the pump's own fluid: a liquid-filled pump keeps pushing with
      // full head against backflow, while a vapor-bound pump develops almost
      // nothing (gas-locked) regardless of what leaks backward through it.
      const pumpNode = fromNode;
      let pumpRho = pumpNode.fluid.mass / pumpNode.volume;

      if (pumpNode.fluid.phase === 'two-phase' && pumpNode.fluid.quality !== undefined) {
        // Pumps draw from the bottom (liquid) if there is enough of it
        const liquidFraction = 1 - pumpNode.fluid.quality;
        const liquidMass = pumpNode.fluid.mass * liquidFraction;

        // If there's significant liquid (more than 10kg), use liquid density
        if (liquidMass > 10) {
          pumpRho = approxLiquidDensity(pumpNode);
        }
        // Otherwise use mixture density (pump is cavitating)
      }

      // Head from the pump curve: falls off with flow, zero at runout.
      dP_pump = pumpHeadPressure(pump, currentFlow, pumpRho);

      // Decomposition for implicit momentum: the affinity-law curve is
      // dP(ṁ) = 1.25·s²·ρgH − 0.25·ρgH/Q_r²·max(0,ṁ)², i.e. a constant
      // shutoff term plus a quadratic that composes with pipe friction.
      const gH = pump.ratedHead * pumpRho * 9.81;
      const s = pump.effectiveSpeed;
      pumpShutoff = 1.25 * s * s * gH;
      if (pump.ratedFlow > 0) {
        pumpQuad = 0.25 * gH / (pump.ratedFlow * pump.ratedFlow);
      }
    }
  }

  const dP_driving = dP_pressure + dP_gravity + dP_pump;

  // === Resistances ===

  // Valve position affects resistance
  let valveOpenFraction = 1.0;
  for (const [, valve] of state.components.valves) {
    if (valve.connectedFlowPath === conn.id) {
      valveOpenFraction = valve.position;
    }
  }
  const valveClosed = valveOpenFraction < 0.01;

  // Check if there's a running pump on this connection (outlet or inlet side)
  let pumpOnOutlet: { running: boolean; effectiveSpeed: number } | undefined;
  let pumpOnInlet: { running: boolean; effectiveSpeed: number } | undefined;
  for (const [pumpId, pump] of state.components.pumps) {
    if (pump.connectedFlowPath === conn.id) {
      pumpOnOutlet = pump;
    }
    if (conn.toNodeId === pumpId) {
      pumpOnInlet = pump;
    }
  }

  // Resistance coefficient (K-factor)
  const K_base = conn.resistanceCoeff || 10;
  // Valve increases resistance as it closes: K_eff = K_base / position²
  let K_common = K_base / Math.pow(Math.max(0.01, valveOpenFraction), 2);

  // Governor valve on turbines affects inlet flow resistance
  const governorValve = toNode.governorValve;
  const governorClosed = governorValve !== undefined && governorValve < 0.01;
  if (governorValve !== undefined && governorValve < 1.0) {
    const gvPosition = Math.max(0.01, governorValve);
    K_common = K_common / Math.pow(gvPosition, 2);
  }

  // Running pumps have very high resistance to reverse flow through the pump -
  // the impeller physically blocks backflow. This term is structural per
  // direction (it applies to any reverse flow), so track it separately from
  // the direction-independent resistance.
  let K_reverseExtra = 0;
  if (pumpOnOutlet && pumpOnOutlet.running) {
    K_reverseExtra += 10000 * K_base;
  }
  if (pumpOnInlet && pumpOnInlet.running) {
    K_reverseExtra += 10000 * K_base;
  }
  const K_eff = K_common + (currentFlow < 0 ? K_reverseExtra : 0);

  // Friction pressure drop (always opposes flow direction)
  const dP_friction = -K_eff * 0.5 * rho_flow * v * Math.abs(v);

  // Slope of resisting pressure w.r.t. mass flow: friction slope K_eff*|v|/A,
  // plus the falling pump head curve (both in Pa per (kg/s))
  let resistanceSlope = (K_eff * Math.abs(v)) / A;
  if (runningPumpOnOutlet) {
    resistanceSlope += pumpHeadSlopeMagnitude(runningPumpOnOutlet, currentFlow, rho_flow);
  }

  const checkValve = findCheckValveForConnection(state, conn.id);

  // Quadratic friction coefficients dP = -C·ṁ|ṁ| per candidate direction
  const quadDenom = 2 * rho_flow * A * A;
  const frictionQuadForward = K_common / quadDenom;
  const frictionQuadReverse = (K_common + K_reverseExtra) / quadDenom;

  return {
    A, L, flowPhase, rho_flow, v,
    dP_pressure, dP_gravity, dP_pump, dP_driving, dP_friction,
    K_eff, resistanceSlope,
    frictionQuadForward, frictionQuadReverse,
    pumpShutoff, pumpQuad,
    valveClosed, governorClosed,
    checkValve,
    crackingPressure: checkValve?.crackingPressure ?? 0,
    upstreamNode, downstreamNode,
  };
}
