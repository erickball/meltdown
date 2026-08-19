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
  totalMass as ncgTotalMass,
  ncgSoundSpeed,
  steamNcgSoundSpeed,
  ncgCriticalFluxFactor,
  steamNcgCriticalFluxFactor,
  R_GAS,
} from '../gas-properties';
import {
  soundSpeed, criticalPressureRatio, WaterState,
  saturatedLiquidDensity, saturatedVaporDensity, surfaceTension,
} from '../water-properties';
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
  // A node with explicitly zero height has no vertical extent to stratify
  // over - a geometric statement, not a component-type exemption. (The old
  // id-prefix list - pumps, pipes, valves always mixed - is gone: a small,
  // hard-driven volume comes out mixed below because its residence time is
  // short, and a STAGNANT vertical pipe genuinely does stratify.)
  if (node.height === 0) return 0;
  const nodeHeight = node.height ?? Math.cbrt(node.volume);

  // Interface physics at the node's (saturation) temperature. Both the
  // density difference and the surface tension vanish at the critical
  // point, taking the drift velocity - and so the separation - smoothly to
  // zero: near-critical fluid does not stratify, with no special case.
  const T = node.fluid.temperature;
  const sigma = surfaceTension(T);
  const rho_f = saturatedLiquidDensity(T);
  const rho_g = saturatedVaporDensity(T);
  const delta_rho = rho_f - rho_g;
  if (!(sigma > 0) || !(delta_rho > 0)) return 0;

  // Churn-turbulent drift velocity (Harmathy 1960): in the distorted-bubble
  // regime the terminal rise speed is INDEPENDENT of bubble size -
  //   u_inf = 1.53 (sigma g delta_rho / rho_f^2)^(1/4)
  // - which is what lets the model exist without inventing a diameter (the
  // previous Stokes form hung everything on a made-up 5 mm bubble).
  const g = 9.81;
  const u_inf = 1.53 * Math.pow(sigma * g * delta_rho / (rho_f * rho_f), 0.25);

  // Segregation reached within one residence time: a parcel dwells
  // tau = M/mdot while its phases drift apart at u_inf, so the fraction of
  // the height they clear is L/(L + h) with L = u_inf tau - smoothly 0 for
  // a flow-through blender, 1 for a still tank, no clamp anywhere.
  const mdot = Math.abs(massFlowRate);
  const sepTime = mdot > 0
    ? (() => { const L = u_inf * node.fluid.mass / mdot; return L / (L + nodeHeight); })()
    : 1;

  // Carryover re-mixing: vapor percolating up through the interface faster
  // than the Kutateladze flooding velocity (Ku = 3.2) entrains droplets and
  // churns the column. Superficial velocity over the vessel's own
  // cross-section V/h. (No liquid-velocity term: liquid throughput limits
  // how much of the PASSING liquid degasses, which is exactly what the
  // residence-time factor above already expresses - counting it again here
  // would call every vessel with strong recirculation fully mixed, the same
  // failure shape the old turbulence heuristic had.)
  const A = node.volume / nodeHeight;
  const x = Math.max(0, Math.min(1, node.fluid.quality ?? 0));
  const j_g = x * mdot / (rho_g * A);
  const u_flood = 3.2 * Math.pow(sigma * g * delta_rho / (rho_g * rho_g), 0.25);
  const r = j_g / u_flood;
  const separation = sepTime / (1 + r * r);

  if (separationDebugEnabled && node.id.toLowerCase().startsWith('con-')) {
    const now = Date.now();
    if (now - separationDebugLastLog > 1000) {
      separationDebugLastLog = now;
      console.log(`[Sep] ${node.id}: h=${nodeHeight.toFixed(2)}m A=${A.toFixed(2)}m2 ` +
        `x=${(x * 100).toFixed(1)}% mdot=${mdot.toFixed(1)}kg/s | sigma=${(sigma * 1e3).toFixed(1)}mN/m ` +
        `u_inf=${u_inf.toFixed(3)}m/s u_flood=${u_flood.toFixed(2)}m/s | ` +
        `j_g=${j_g.toFixed(3)} sepTime=${sepTime.toFixed(2)} ` +
        `r=${r.toFixed(2)} sep=${(separation * 100).toFixed(0)}%`);
    }
  }
  return separation;
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
 * Total node density including non-condensible gas mass. fluid.mass is
 * WATER only (NCG is tracked in moles alongside), so any density used for
 * momentum, inertia, or pump head on a gas-bearing node must add the NCG
 * mass back or a helium-filled node reads as near-vacuum.
 */
export function nodeBulkDensity(node: FlowNode): number {
  const gasMass = node.fluid.ncg ? ncgTotalMass(node.fluid.ncg) : 0;
  return (node.fluid.mass + gasMass) / node.volume;
}

/**
 * Get approximate vapor-space density at node conditions: ideal-gas steam at
 * its partial pressure plus the NCG mixture at its own. For a pure-steam
 * node this is the old PM/(RT); for a helium-filled node it is the helium
 * density (0.018 kg/mol water would overestimate helium ~4.5x). Two-phase
 * nodes use the whole node volume for the NCG share - consistent with the
 * FluidState solver's vapor-space approximation.
 */
export function approxVaporDensity(node: FlowNode): number {
  const T = node.fluid.temperature;
  const R = 8.314; // J/mol-K
  let P_ncg = 0;
  let rho_ncg = 0;
  if (node.fluid.ncg && node.volume > 0) {
    const n = totalMoles(node.fluid.ncg);
    if (n > 0) {
      P_ncg = (n * R * T) / node.volume;
      rho_ncg = ncgTotalMass(node.fluid.ncg) / node.volume;
    }
  }
  const P_steam = Math.max(0, node.fluid.pressure - P_ncg);
  const M = 0.018; // kg/mol for water
  return Math.max(0.1, (P_steam * M) / (R * T) + rho_ncg);
}

/**
 * What a connection draws from a node, as a composition rather than a bare
 * label. The node's vertical phase profile has three zones (clarified pool /
 * froth / clear vapor for tanks; economizer / boiling / superheat for OTSG
 * partitions); the offtake samples them either at a point (openingHeight
 * unset or 0) or averaged over its opening [elev - h/2, elev + h/2]. All
 * strips of the opening share one velocity, so zone AREA fractions weight
 * densities directly and MASS-flow weights are rho-weighted area fractions -
 * a level sweeping past a finite opening crossfades the drawn density and
 * enthalpy instead of stepping.
 *
 * One shared answer for the momentum operators, the pressure solver's
 * choking pass and the rate operator's draw pricing (they used to carry
 * diverging copies).
 */
export interface DrawComposition {
  /** Pure label when the whole opening sits in one zone, else 'mixture'. */
  phase: 'liquid' | 'vapor' | 'mixture';
  /** Opening-area fractions per zone, sum to 1. */
  fLiquid: number; fMixture: number; fVapor: number;
  /** Mass-flow weights per zone (rho-weighted area fractions), sum to 1. */
  wLiquid: number; wMixture: number; wVapor: number;
  /** Opening-mean density of what is flowing (momentum/choking density). */
  rho: number;
}

export function drawCompositionAt(
  node: FlowNode,
  connectionElevation?: number,
  massFlowRate: number = 0,
  phaseTolerance?: number,
  openingHeight?: number,
  out?: DrawComposition,
  needRho: boolean = true,
): DrawComposition {
  // Hot-path notes: callers that consume the result within their own loop
  // iteration pass a reusable `out` scratch (the rate operator prices every
  // connection on every RK stage); callers that retain the result across
  // other work (the momentum path stores it on ConnectionHydraulics for the
  // pressure solver) omit it and get a fresh object. Enthalpy pricers only
  // consume the label and mass weights and pass needRho = false, so a pure
  // draw (the overwhelming majority) costs no density evaluation at all,
  // exactly like the old label-only model. The helpers live at module level
  // - closures here would allocate twice per call on the hottest loop.

  // Single phase nodes always flow their phase
  if (node.fluid.phase !== 'two-phase' && !node.otsg?.lastEval) {
    return fillPure(node, node.fluid.phase === 'vapor' ? 'vapor' : 'liquid', out, needRho);
  }

  const nodeHeight = node.height ?? Math.cbrt(node.volume);
  // Connection elevations come from the component's drawing frame and can
  // sit outside the node's own vertical extent (a zero-height valve pot
  // with a port drawn 3 m up); the draw still physically comes from
  // somewhere inside the node.
  const elev = connectionElevation === undefined
    ? nodeHeight / 2
    : Math.max(0, Math.min(nodeHeight, connectionElevation));

  // Zone boundaries b1 (top of liquid zone) and b2 (bottom of vapor zone),
  // and for tanks the froth's void profile between them (see below).
  let b1: number, b2: number;
  let isOtsg = false;
  let alphaBar = 0;
  if (node.otsg?.lastEval) {
    isOtsg = true;
    // A moving-boundary boiler tube is axially stratified BY CONSTRUCTION -
    // economizer / boiling / superheat is the entire sectioned model - so an
    // OTSG node answers from its partition's own boundaries (sharp: the
    // partition's boundaries carry no interface waves).
    const fr = node.otsg.lastEval.lengthFracs;
    b1 = fr[0] * nodeHeight;
    b2 = (fr[0] + fr[1]) * nodeHeight;
  } else {
    const separation = calculateSeparation(node, massFlowRate);
    // Partial separation LAYERS the node rather than smearing it: the
    // separated share of the liquid has clarified into a pool at the bottom
    // (sep * V_liq), the separated share of the vapor into a clear space at
    // the top (sep * V_vap), and everything else is froth in between. At
    // sep = 1 this is a sharp interface, at sep = 0 all froth - continuously.
    const quality = Math.max(0, Math.min(1, node.fluid.quality ?? 0));
    const liquidVolume = Math.min(node.volume,
      node.fluid.mass * (1 - quality) / approxLiquidDensity(node));
    const vaporVolume = node.volume - liquidVolume;
    const zLiquid = calculateLiquidLevelWithObstructions(node, separation * liquidVolume);
    const zVapor = calculateLiquidLevelWithObstructions(node, node.volume - separation * vaporVolume);
    // Interface smear: waves and slosh blur the zone boundaries by ~10 cm; a
    // connection's explicit phaseTolerance overrides.
    const tolerance = phaseTolerance !== undefined ? phaseTolerance : 0.1;
    b1 = zLiquid - tolerance;
    b2 = zVapor + tolerance;
    // The froth's mean void equals the node's bulk void: the froth holds the
    // same (1 - sep) share of each phase, so sep cancels.
    alphaBar = Math.max(0, Math.min(1, vaporVolume / node.volume));
  }

  // Opening-area fraction in each zone.
  const a = openingHeight ?? 0;
  const lo = Math.max(0, elev - a / 2);
  const hi = Math.min(nodeHeight, elev + a / 2);
  let fLiquid: number, fVapor: number;
  if (hi - lo > 0) {
    fLiquid = Math.max(0, Math.min(hi, b1) - lo) / (hi - lo);
    fVapor = Math.max(0, hi - Math.max(lo, b2)) / (hi - lo);
  } else {
    // Point sample - the openingHeight-unset limit, preserving the exact
    // comparison semantics the point model always had.
    fLiquid = elev < b1 ? 1 : 0;
    fVapor = elev > b2 ? 1 : 0;
  }
  const fMixture = Math.max(0, 1 - fLiquid - fVapor);

  // Pure draws skip straight to the label.
  if (fMixture === 0 && fVapor === 0) return fillPure(node, 'liquid', out, needRho);
  if (fMixture === 0 && fLiquid === 0) return fillPure(node, 'vapor', out, needRho);

  if (isOtsg) {
    // The boiling section is a real zone with its own mean state - the
    // partition already resolves the axial profile, so its draws price at
    // the section state ('mixture' falls through to the bulk/section path).
    if (fLiquid === 0 && fVapor === 0) {
      return fillComp(out, 'mixture', 0, 1, 0, 0, 1, 0, needRho ? nodeBulkDensity(node) : 0);
    }
    const rhoL = fLiquid > 0 ? approxLiquidDensity(node) : 0;
    const rhoV = fVapor > 0 ? approxVaporDensity(node) : 0;
    const rhoM = nodeBulkDensity(node);
    const rho = fLiquid * rhoL + fMixture * rhoM + fVapor * rhoV;
    const wLiquid = fLiquid * rhoL / rho;
    const wVapor = fVapor * rhoV / rho;
    const wMixture = Math.max(0, 1 - wLiquid - wVapor);
    return fillComp(out, 'mixture', fLiquid, fMixture, fVapor, wLiquid, wMixture, wVapor, rho);
  }

  // Tank froth: void fraction ramps across the physical froth span
  // [zL, zV] as alpha(zeta) = zeta^n with n = 1/alphaBar - 1 - zero at the
  // pool boundary, one at the clear-vapor boundary, and integrating exactly
  // to the froth's mean void alphaBar. A froth draw is therefore a
  // liquid/vapor PAIR of streams split by the local (or opening-averaged)
  // void, not a flat bulk sample: the drawn density and enthalpy vary
  // continuously with elevation through the whole node, and the froth's
  // weight lands on the liquid/vapor prices whose endpoint draws it
  // matches at the zone boundaries.
  // The ramp spans the LABEL boundaries [b1, b2] - the physical froth
  // padded by the interface smear - so a settled tank's tolerance band
  // reads as the wave-averaged crossfade it represents, and the profile
  // meets the pure zones exactly where the labels switch. (tol = 0 with a
  // sharp interface leaves a genuine step: that is what declaring zero
  // tolerance means.)
  let alphaAp: number;
  const span = b2 - b1;
  if (span > 0) {
    const sLo = Math.max(lo, Math.min(hi, b1));
    const sHi = Math.min(hi, Math.max(lo, b2));
    let zetaA: number, zetaB: number;
    if (hi - lo > 0 && sHi > sLo) {
      zetaA = (sLo - b1) / span;
      zetaB = (sHi - b1) / span;
    } else {
      zetaA = zetaB = Math.max(0, Math.min(1, (elev - b1) / span));
    }
    if (alphaBar <= 0) alphaAp = 0;
    else if (alphaBar >= 1) alphaAp = 1;
    else if (zetaB > zetaA) {
      // Mean of zeta^n over [zetaA, zetaB]: alphaBar (zetaB^(1/alphaBar) -
      // zetaA^(1/alphaBar)) / (zetaB - zetaA)  [n + 1 = 1/alphaBar]
      const inv = 1 / alphaBar;
      alphaAp = alphaBar * (Math.pow(zetaB, inv) - Math.pow(zetaA, inv)) / (zetaB - zetaA);
    } else {
      alphaAp = Math.pow(zetaA, (1 - alphaBar) / alphaBar);
    }
  } else {
    alphaAp = elev > b1 ? 1 : 0;
  }

  const rhoL = approxLiquidDensity(node);
  const rhoV = approxVaporDensity(node);
  const rhoFroth = alphaAp * rhoV + (1 - alphaAp) * rhoL;
  const rho = fLiquid * rhoL + fMixture * rhoFroth + fVapor * rhoV;
  const wLiquid = (fLiquid * rhoL + fMixture * (1 - alphaAp) * rhoL) / rho;
  const wVapor = Math.max(0, 1 - wLiquid);
  const phase = fMixture > 0 ? 'mixture' : (fVapor > 0 && fLiquid > 0 ? 'mixture' : (fVapor > 0 ? 'vapor' : 'liquid'));
  return fillComp(out, phase, fLiquid, fMixture, fVapor, wLiquid, 0, wVapor, rho);
}

function fillComp(
  out: DrawComposition | undefined,
  phase: DrawComposition['phase'],
  fLiquid: number, fMixture: number, fVapor: number,
  wLiquid: number, wMixture: number, wVapor: number,
  rho: number,
): DrawComposition {
  if (!out) return { phase, fLiquid, fMixture, fVapor, wLiquid, wMixture, wVapor, rho };
  out.phase = phase;
  out.fLiquid = fLiquid; out.fMixture = fMixture; out.fVapor = fVapor;
  out.wLiquid = wLiquid; out.wMixture = wMixture; out.wVapor = wVapor;
  out.rho = rho;
  return out;
}

function fillPure(
  node: FlowNode, phase: 'liquid' | 'vapor',
  out: DrawComposition | undefined, needRho: boolean,
): DrawComposition {
  const rho = !needRho ? 0
    : phase === 'liquid' ? approxLiquidDensity(node) : approxVaporDensity(node);
  return phase === 'liquid'
    ? fillComp(out, 'liquid', 1, 0, 0, 1, 0, 0, rho)
    : fillComp(out, 'vapor', 0, 0, 1, 0, 0, 1, rho);
}

/** Label-only view of drawCompositionAt, for callers that just branch. */
export function flowPhaseAt(
  node: FlowNode,
  connectionElevation?: number,
  massFlowRate: number = 0,
  phaseTolerance?: number,
): 'liquid' | 'vapor' | 'mixture' {
  return drawCompositionAt(node, connectionElevation, massFlowRate, phaseTolerance).phase;
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

/**
 * Isentropic critical mass flux at this node, as a fraction of rho times c
 * evaluated
 * at STAGNATION conditions - i.e. the correction that turns "upstream density
 * times upstream sound speed" into the flux a sonic throat actually passes
 * (~0.56-0.6). See criticalFluxFactorForGamma.
 */
export function nodeCriticalFluxFactor(
  node: FlowNode,
  flowPhase: 'liquid' | 'vapor' | 'mixture'
): number {
  if (flowPhase === 'liquid') return 1; // never used - liquid does not choke

  const fluid = node.fluid;
  const ncg = fluid.ncg;
  const ncgMoles = ncg ? totalMoles(ncg) : 0;

  if (ncgMoles > 0 && node.volume > 0) {
    const T = fluid.temperature;
    const P_ncg = (ncgMoles * R_GAS * T) / node.volume;
    const P_steam = Math.max(0, fluid.pressure - P_ncg);
    const steamMoles = (P_steam * node.volume) / (R_GAS * T);
    if (steamMoles < ncgMoles * 0.02) return ncgCriticalFluxFactor(ncg!);
    return steamNcgCriticalFluxFactor(ncg!, steamMoles, T);
  }

  // Pure steam/water: same effective gamma correlation the critical pressure
  // ratio uses, via the identity G_crit / (rho_0 c_0) = r * sqrt((g+1)/2).
  // Exact on the single-phase vapor branch, where r comes from that very
  // gamma. On the TWO-PHASE branch r is an empirical blend on quality rather
  // than an ideal-gas result, so the identity is only nominal there and can
  // read a couple percent above 1 for cold, low-quality mixtures - harmless,
  // because that same branch holds r near 0.95 and choking essentially never
  // engages. Genuine two-phase critical flow wants HEM/Moody, which this
  // model does not have.
  const r = nodeCriticalPressureRatio(node, flowPhase);
  if (!(r > 0)) return 1;
  const T_ratio = Math.min(1, Math.max(0, (fluid.temperature - 373) / (647 - 373)));
  const gamma = 1.33 - 0.20 * T_ratio;
  return r * Math.sqrt((gamma + 1) / 2);
}

// ============================================================================
// Full connection hydraulics
// ============================================================================

/** Default decay time constant for flow through a closed valve/check valve (s) */
export const CLOSED_FLOW_DECAY_TAU = 0.1;

export interface ConnectionHydraulics {
  A: number;                 // flow area (m²)
  /** A reduced by valve/governor position - the area choking sees (m²) */
  throatArea: number;
  L: number;                 // pipe length (m)
  flowPhase: 'liquid' | 'vapor' | 'mixture';
  /** Full draw composition behind flowPhase - enthalpy pricers blend on
   *  its mass weights so a finite opening crossfades instead of stepping. */
  drawComp: DrawComposition;
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

export interface ConnectionRestriction {
  valveOpenFraction: number;  // in-line valve position (1 = no valve)
  governorPosition: number;   // turbine governor position (1 = none/wide open)
  openFraction: number;       // valveOpenFraction · governorPosition, floored
  throatArea: number;         // geometric area reduced by openFraction (m²)
  valveClosed: boolean;
  governorClosed: boolean;
}

/**
 * Resolve how far a connection is throttled, and the throat area that follows.
 *
 * The throat area is NOT a second model bolted onto the friction one - it is
 * the area the friction model already implies. With K_eff = K_base/frac² the
 * steady momentum balance gives
 *     ṁ = A·√(2ρΔP/K_eff) = (A·frac)·√(2ρΔP/K_base),
 * i.e. a connection throttled to `frac` passes exactly what a full-bore one of
 * area A·frac would. Choking has to be evaluated on that same area: judging the
 * sonic bound on the full bore while friction acts on A·frac describes a throat
 * the rest of the momentum equation does not believe in, and the sonic limit
 * then sits a factor 1/frac too high - so a nearly shut valve, the one place
 * choking is physically certain, could never reach it.
 *
 * The 0.01 floor is the pre-existing one from the K-factor path, kept here so
 * both uses stay exactly consistent at the shut limit.
 */
export function connectionRestriction(
  state: SimulationState,
  conn: FlowConnection,
  toNode: FlowNode
): ConnectionRestriction {
  let valveOpenFraction = 1.0;
  for (const [, valve] of state.components.valves) {
    if (valve.connectedFlowPath === conn.id) {
      valveOpenFraction = valve.position;
    }
  }

  const governorValve = toNode.governorValve;
  const governorPosition = governorValve !== undefined && governorValve < 1.0
    ? governorValve
    : 1.0;

  const openFraction = Math.max(0.01, valveOpenFraction) * Math.max(0.01, governorPosition);
  const A = conn.flowArea || 0.1;

  return {
    valveOpenFraction,
    governorPosition,
    openFraction,
    throatArea: A * openFraction,
    valveClosed: valveOpenFraction < 0.01,
    governorClosed: governorValve !== undefined && governorValve < 0.01,
  };
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
 *
 * `throatArea` is the restricted area from connectionRestriction, not the bare
 * bore - a throttled valve chokes at its own throat.
 */
export function computeChokeLimit(
  conn: FlowConnection,
  upstreamNode: FlowNode,
  downstreamNode: FlowNode,
  flowPhase: 'liquid' | 'vapor' | 'mixture',
  rho_flow: number,
  throatArea: number
): ChokeLimit | null {
  if (flowPhase === 'liquid') return null;

  const c = nodeSoundSpeed(upstreamNode, flowPhase);
  // Critical mass flux at the THROAT, not at stagnation. The gas reaching
  // Mach 1 has already expanded and cooled, so it carries only ~0.56-0.60 of
  // rho_0*c_0; using rho_0*c_0 as the sonic bound overstates every choked
  // discharge by ~1.7x (measured 1.52x on the analytic helium blowdown, where
  // the exact factor is 0.5625). See scripts/test-blowdown.ts.
  const fluxFactor = nodeCriticalFluxFactor(upstreamNode, flowPhase);
  const m_dot_sonic = fluxFactor * rho_flow * throatArea * c;

  // Geometric discharge coefficient (vena contracta), now genuinely just
  // geometry: the compressibility that these numbers used to stand in for is
  // carried by fluxFactor above.
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

  // For momentum/inertia, use upstream density - that's the fluid actually
  // moving. Bulk density includes NCG mass (a helium loop is all NCG).
  const upstreamNode = currentFlow >= 0 ? fromNode : toNode;
  const downstreamNode = currentFlow >= 0 ? toNode : fromNode;
  const upstreamElevation = currentFlow >= 0 ? conn.fromElevation : conn.toElevation;
  const upstreamPhaseTolerance = currentFlow >= 0 ? conn.fromPhaseTolerance : conn.toPhaseTolerance;

  const upstreamOpeningHeight = currentFlow >= 0 ? conn.fromOpeningHeight : conn.toOpeningHeight;

  // What is flowing, from the shared draw composition (density crossfades
  // over a finite opening instead of stepping at the zone boundaries).
  const drawComp = drawCompositionAt(
    upstreamNode, upstreamElevation, currentFlow, upstreamPhaseTolerance, upstreamOpeningHeight);
  const flowPhase = drawComp.phase;
  const rho_flow = drawComp.rho;

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
      // Include NCG mass: a gas circulator develops rho*g*H head from the
      // gas it actually contains (a few % of a water pump's - physical for
      // the same impeller, so gas loops need high-head circulators).
      let pumpRho = nodeBulkDensity(pumpNode);

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

  const restriction = connectionRestriction(state, conn, toNode);
  const { valveClosed, governorClosed, throatArea } = restriction;

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
  // Throttling increases resistance as the throat shuts: K_eff = K_base/frac²
  // (see connectionRestriction - the same fraction defines the throat area)
  let K_common = K_base / (restriction.openFraction * restriction.openFraction);

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
    A, throatArea, L, flowPhase, drawComp, rho_flow, v,
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
