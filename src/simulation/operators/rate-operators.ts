/**
 * Rate-Based Physics Operators for RK45 Integration
 *
 * These operators compute derivatives (rates of change) rather than
 * applying changes directly. This allows the RK45 solver to combine
 * them properly for higher-order accuracy.
 *
 * Each operator returns StateRates describing dm/dt, dU/dt, dT/dt, etc.
 */

import { SimulationState, FlowNode } from '../types';
import {
  RateOperator,
  ConstraintOperator,
  StateRates,
  createZeroRates,
} from '../rk45-solver';
import { cloneSimulationState } from '../solver';
import * as Water from '../water-properties';
import { simulationConfig } from '../types';

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
// Debug Tracking for Pump-5
// ============================================================================

interface DebugSnapshot {
  time: number;
  mass: number;
  internalEnergy: number;
  volume: number;
  temperature: number;
  pressure: number;
  phase: string;
  quality: number;
  u_specific: number;  // kJ/kg
  v_specific: number;  // mL/kg
  flowsIn: Array<{ from: string; massFlow: number; energyFlow: number; h_specific: number; flowPhase: string }>;
  flowsOut: Array<{ to: string; massFlow: number; energyFlow: number; h_specific: number; flowPhase: string }>;
  dMass: number;
  dEnergy: number;
}

const DEBUG_NODE_ID = 'pum-6';
const debugHistory: DebugSnapshot[] = [];
const MAX_DEBUG_HISTORY = 20;

function logDebugSnapshot(snapshot: DebugSnapshot): void {
  debugHistory.push(snapshot);
  if (debugHistory.length > MAX_DEBUG_HISTORY) {
    debugHistory.shift();
  }
}

export function dumpDebugHistory(): void {
  console.log(`\n========== DEBUG HISTORY FOR ${DEBUG_NODE_ID} ==========`);
  for (const snap of debugHistory) {
    console.log(`\n--- t=${snap.time.toFixed(3)}s ---`);
    console.log(`  State: m=${snap.mass.toFixed(1)}kg, U=${(snap.internalEnergy/1000).toFixed(1)}kJ, V=${(snap.volume*1000).toFixed(1)}L`);
    console.log(`  Specific: u=${snap.u_specific.toFixed(2)} kJ/kg, v=${snap.v_specific.toFixed(2)} mL/kg`);
    console.log(`  T=${(snap.temperature-273.15).toFixed(2)}°C, P=${(snap.pressure/1e5).toFixed(4)}bar, phase=${snap.phase}, x=${(snap.quality*100).toFixed(1)}%`);
    console.log(`  Rates: dM=${snap.dMass.toFixed(2)} kg/s, dU=${(snap.dEnergy/1000).toFixed(2)} kJ/s`);
    if (snap.flowsIn.length > 0) {
      console.log(`  Flows IN:`);
      for (const f of snap.flowsIn) {
        console.log(`    from ${f.from}: ${f.massFlow.toFixed(2)} kg/s, ${(f.energyFlow/1000).toFixed(2)} kJ/s (h=${(f.h_specific/1000).toFixed(2)} kJ/kg, phase=${f.flowPhase})`);
      }
    }
    if (snap.flowsOut.length > 0) {
      console.log(`  Flows OUT:`);
      for (const f of snap.flowsOut) {
        console.log(`    to ${f.to}: ${f.massFlow.toFixed(2)} kg/s, ${(f.energyFlow/1000).toFixed(2)} kJ/s (h=${(f.h_specific/1000).toFixed(2)} kJ/kg, phase=${f.flowPhase})`);
      }
    }
  }
  console.log(`\n========== END DEBUG HISTORY ==========\n`);
}

// ============================================================================
// Conduction Rate Operator
// ============================================================================

export class ConductionRateOperator implements RateOperator {
  name = 'Conduction';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    // For each thermal connection, compute heat flow rate
    for (const conn of state.thermalConnections) {
      const node1 = state.thermalNodes.get(conn.fromNodeId);
      const node2 = state.thermalNodes.get(conn.toNodeId);

      if (!node1 || !node2) continue;

      // Heat flow from node1 to node2 (W)
      const Q = conn.conductance * (node1.temperature - node2.temperature);

      // Temperature rate: dT/dt = Q / (m * cp)
      const dT1 = -Q / (node1.mass * node1.specificHeat);
      const dT2 = Q / (node2.mass * node2.specificHeat);

      // Accumulate rates
      const existing1 = rates.thermalNodes.get(conn.fromNodeId) || { dTemperature: 0 };
      rates.thermalNodes.set(conn.fromNodeId, { dTemperature: existing1.dTemperature + dT1 });

      const existing2 = rates.thermalNodes.get(conn.toNodeId) || { dTemperature: 0 };
      rates.thermalNodes.set(conn.toNodeId, { dTemperature: existing2.dTemperature + dT2 });
    }

    return rates;
  }
}

// ============================================================================
// Convection Rate Operator
// ============================================================================

export class ConvectionRateOperator implements RateOperator {
  name = 'Convection';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const conn of state.convectionConnections) {
      const thermalNode = state.thermalNodes.get(conn.thermalNodeId);
      const flowNode = state.flowNodes.get(conn.flowNodeId);

      if (!thermalNode || !flowNode) continue;

      // Heat transfer coefficient
      const h = this.computeHeatTransferCoeff(flowNode, state);
      const Q = h * conn.surfaceArea * (thermalNode.temperature - flowNode.fluid.temperature);

      // Solid temperature rate
      const dT_solid = -Q / (thermalNode.mass * thermalNode.specificHeat);

      // Fluid energy rate (positive Q means heat INTO fluid)
      const dU_fluid = Q;

      // Accumulate rates
      const existingThermal = rates.thermalNodes.get(conn.thermalNodeId) || { dTemperature: 0 };
      rates.thermalNodes.set(conn.thermalNodeId, {
        dTemperature: existingThermal.dTemperature + dT_solid,
      });

      const existingFlow = rates.flowNodes.get(conn.flowNodeId) || { dMass: 0, dEnergy: 0 };
      rates.flowNodes.set(conn.flowNodeId, {
        dMass: existingFlow.dMass,
        dEnergy: existingFlow.dEnergy + dU_fluid,
      });
    }

    return rates;
  }

  private computeHeatTransferCoeff(flowNode: FlowNode, state: SimulationState): number {
    const fluid = flowNode.fluid;

    // Get flow rate through this node
    let totalMassFlow = 0;
    for (const conn of state.flowConnections) {
      if (conn.fromNodeId === flowNode.id || conn.toNodeId === flowNode.id) {
        totalMassFlow += Math.abs(conn.massFlowRate);
      }
    }

    // Fluid properties
    const rho = fluid.mass / flowNode.volume;
    const mu = fluid.phase === 'liquid' ? 0.0003 : 0.00002; // Pa·s
    const k = fluid.phase === 'liquid' ? 0.6 : 0.03; // W/m-K
    const Pr = fluid.phase === 'liquid' ? 2.0 : 1.0;

    const D = flowNode.hydraulicDiameter;
    const A = flowNode.flowArea;

    // Velocity from mass flow
    const velocity = totalMassFlow / (rho * A);

    // Reynolds number
    const Re = rho * velocity * D / mu;

    // Minimum h for natural convection
    const h_natural = 500; // W/m²-K

    if (Re < 2300) {
      return h_natural;
    }

    // Turbulent: Dittus-Boelter correlation
    const Nu = 0.023 * Math.pow(Re, 0.8) * Math.pow(Pr, 0.4);
    const h_forced = Nu * k / D;

    return Math.max(h_natural, h_forced);
  }
}

// ============================================================================
// Heat Generation Rate Operator (for reactor cores)
// ============================================================================

export class HeatGenerationRateOperator implements RateOperator {
  name = 'HeatGeneration';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    // Add heat generation to thermal nodes
    for (const [id, node] of state.thermalNodes) {
      if (node.heatGeneration > 0) {
        // For fuel nodes linked to neutronics, use reactor power
        if (id === state.neutronics.fuelNodeId || id.includes('fuel')) {
          const power = state.neutronics.power;
          const dT = power / (node.mass * node.specificHeat);
          rates.thermalNodes.set(id, { dTemperature: dT });
        } else {
          // Other heat-generating nodes use their fixed rate
          const dT = node.heatGeneration / (node.mass * node.specificHeat);
          rates.thermalNodes.set(id, { dTemperature: dT });
        }
      }
    }

    return rates;
  }
}

// ============================================================================
// Neutronics Rate Operator
// ============================================================================

export class NeutronicsRateOperator implements RateOperator {
  name = 'Neutronics';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();
    const n = state.neutronics;

    // If no core is linked, no neutronics rates
    if (!n.coreId) {
      return rates;
    }

    const rho = this.computeTotalReactivity(n, state);
    const beta = n.delayedNeutronFraction;
    const Lambda = n.promptNeutronLifetime;
    const lambda = n.precursorDecayConstant;

    // Normalized power
    const N = n.power / n.nominalPower;
    const C = n.precursorConcentration;

    // Use prompt jump approximation when deeply subcritical.
    // When ρ < β, the prompt neutron population is stable and responds
    // essentially instantaneously to changes in precursor concentration.
    // Instead of solving the stiff full equations, we assume:
    //   N_equilibrium = λ * Λ * C / (β - ρ)
    // and only integrate precursor decay.
    //
    // This eliminates the fast timescale (Λ ~ 10⁻⁵ s) and leaves only
    // the slow precursor decay timescale (1/λ ~ 10 s).

    const subcriticalMargin = beta - rho;
    const usePromptJump = subcriticalMargin > 0.001; // Use when ρ < β - 0.1%

    let dN_dt: number;
    let dC_dt: number;

    if (usePromptJump) {
      // Prompt jump approximation: power tracks precursor concentration
      // N_eq = λ * Λ * C / (β - ρ)
      // dN/dt = d/dt[λ * Λ * C / (β - ρ)]
      //       ≈ λ * Λ / (β - ρ) * dC/dt  (ignoring dρ/dt for now)
      //
      // The precursor equation remains:
      // dC/dt = β / Λ * N - λ * C
      //
      // Substituting N_eq:
      // dC/dt = β / Λ * (λ * Λ * C / (β - ρ)) - λ * C
      //       = β * λ * C / (β - ρ) - λ * C
      //       = λ * C * (β / (β - ρ) - 1)
      //       = λ * C * (β - (β - ρ)) / (β - ρ)
      //       = λ * C * ρ / (β - ρ)
      //
      // For shutdown (ρ < 0): dC/dt < 0 (precursors decay)
      // For critical (ρ = 0): dC/dt = 0 (equilibrium)
      // For subcritical (0 < ρ < β): dC/dt > 0 (precursors build up)

      dC_dt = lambda * C * rho / subcriticalMargin;

      // Power follows equilibrium with precursors
      const N_eq = lambda * Lambda * C / subcriticalMargin;

      // Rate of power change = rate of approach to equilibrium
      // Use a relaxation timescale based on precursor decay
      // This gives smooth behavior without the stiff prompt response
      const tau_relax = 1.0 / lambda; // ~10 seconds, same as precursor timescale
      dN_dt = (N_eq - N) / tau_relax;
    } else {
      // Near critical or supercritical: use analytical solution
      // This eliminates the stiff prompt neutron timescale (Λ ~ 10⁻⁵ s)
      // by solving the 2x2 linear system exactly over an arbitrary timestep.
      //
      // System: d/dt [N]   [a  b] [N]     where a = (ρ-β)/Λ, b = λ
      //              [C] = [c  d] [C]           c = β/Λ,     d = -λ
      //
      // Solution: [N(t)]   exp(At) [N(0)]
      //           [C(t)] =        [C(0)]
      //
      // The eigenvalues of A are: λ₁,₂ = (tr ± sqrt(D)) / 2
      //   tr = a + d = (ρ-β)/Λ - λ
      //   det = ad - bc = -(ρ-β)λ/Λ - βλ/Λ = -ρλ/Λ
      //   D = tr² - 4*det
      //
      // For the effective rate, we compute N(dt) and C(dt), then:
      //   dN/dt_eff = (N(dt) - N(0)) / dt
      //   dC/dt_eff = (C(dt) - C(0)) / dt
      //
      // The dt cancels when dividing, so we can use any convenient dt.

      const result = this.analyticalPointKinetics(N, C, rho, beta, Lambda, lambda);
      dN_dt = result.dN_dt;
      dC_dt = result.dC_dt;
    }

    // Convert back to absolute power rate
    rates.neutronics.dPower = dN_dt * n.nominalPower;
    rates.neutronics.dPrecursorConcentration = dC_dt;

    return rates;
  }

  /**
   * Analytical solution to point kinetics equations for near-critical reactivity.
   *
   * Solves the 2x2 linear system:
   *   dN/dt = a*N + b*C    where a = (ρ-β)/Λ, b = λ
   *   dC/dt = c*N + d*C          c = β/Λ,     d = -λ
   *
   * Uses matrix exponential via eigenvalue decomposition.
   * Returns effective rates (change per unit time).
   *
   * @param N - Normalized power (N = P / P_nominal)
   * @param C - Precursor concentration
   * @param rho - Reactivity
   * @param beta - Delayed neutron fraction
   * @param Lambda - Prompt neutron lifetime (s)
   * @param lambda - Precursor decay constant (1/s)
   */
  private analyticalPointKinetics(
    N: number,
    C: number,
    rho: number,
    beta: number,
    Lambda: number,
    lambda: number
  ): { dN_dt: number; dC_dt: number } {
    // Matrix coefficients
    const a = (rho - beta) / Lambda;
    const b = lambda;
    const c = beta / Lambda;
    const d = -lambda;

    // Eigenvalue computation
    // λ₁,₂ = (tr ± sqrt(D)) / 2
    // tr = a + d = (ρ-β)/Λ - λ
    // det = ad - bc = -λ(ρ-β)/Λ - λβ/Λ = -λρ/Λ
    // D = tr² - 4*det = tr² + 4λρ/Λ

    const tr = a + d;
    const det = a * d - b * c; // = -lambda * rho / Lambda
    const D = tr * tr - 4 * det;

    // Use an arbitrary timestep - the choice doesn't matter since we divide by it
    // Use a value on the order of the precursor timescale for numerical stability
    const dt = 0.1; // 100 ms - large enough to capture dynamics, small enough to be accurate

    let N_new: number;
    let C_new: number;

    if (D > 1e-20) {
      // Two distinct real eigenvalues (typical case)
      const sqrtD = Math.sqrt(D);
      const lambda1 = (tr + sqrtD) / 2;
      const lambda2 = (tr - sqrtD) / 2;

      // Eigenvectors: For eigenvalue λᵢ, eigenvector is [b, λᵢ - a]ᵀ (or [λᵢ - d, c]ᵀ)
      // Using [b, λᵢ - a]ᵀ form:
      const v1_N = b;
      const v1_C = lambda1 - a;
      const v2_N = b;
      const v2_C = lambda2 - a;

      // Solve for coefficients: [N, C]ᵀ = c1 * v1 + c2 * v2
      // | v1_N  v2_N | |c1|   |N|
      // | v1_C  v2_C | |c2| = |C|
      //
      // det(V) = v1_N * v2_C - v2_N * v1_C = b*(λ2-a) - b*(λ1-a) = b*(λ2-λ1) = -b*sqrtD
      const detV = -b * sqrtD;

      if (Math.abs(detV) < 1e-30) {
        // Degenerate case - fall back to explicit rates
        return {
          dN_dt: a * N + b * C,
          dC_dt: c * N + d * C,
        };
      }

      const c1 = (v2_C * N - v2_N * C) / detV;
      const c2 = (-v1_C * N + v1_N * C) / detV;

      // Solution at time dt
      const exp1 = Math.exp(lambda1 * dt);
      const exp2 = Math.exp(lambda2 * dt);

      N_new = c1 * v1_N * exp1 + c2 * v2_N * exp2;
      C_new = c1 * v1_C * exp1 + c2 * v2_C * exp2;
    } else if (D < -1e-20) {
      // Complex eigenvalues (rare for typical reactor parameters)
      // λ = α ± iω where α = tr/2, ω = sqrt(-D)/2
      const alpha = tr / 2;
      const omega = Math.sqrt(-D) / 2;

      // Solution uses: exp(αt) * [cos(ωt) + i*sin(ωt)]
      // Real solution involves rotation matrix
      const expAlpha = Math.exp(alpha * dt);
      const cosOmega = Math.cos(omega * dt);
      const sinOmega = Math.sin(omega * dt);

      // For complex eigenvalues, use the matrix exponential directly:
      // exp(At) = exp(αt) * [cos(ωt)*I + sin(ωt)/ω * (A - αI)]
      // where A - αI = [[a-α, b], [c, d-α]] = [[(a-d)/2, b], [c, (d-a)/2]]

      const halfDiff = (a - d) / 2;

      // Matrix (A - αI) / ω  (the rotation generator, normalized)
      // Note: This is the matrix whose sin(ωt) coefficient gives the rotation
      const m11 = halfDiff / omega;
      const m12 = b / omega;
      const m21 = c / omega;
      const m22 = -halfDiff / omega;

      // exp(At) = exp(αt) * [cos(ωt)*I + sin(ωt)*M]
      // [N_new]   [cos + m11*sin   m12*sin   ] [N]
      // [C_new] = [m21*sin    cos + m22*sin  ] [C] * exp(αt)

      N_new = expAlpha * ((cosOmega + m11 * sinOmega) * N + m12 * sinOmega * C);
      C_new = expAlpha * (m21 * sinOmega * N + (cosOmega + m22 * sinOmega) * C);
    } else {
      // Repeated eigenvalue (D ≈ 0) - near-critical degeneracy
      // λ = tr/2 (repeated)
      // exp(At) = exp(λt) * (I + t*(A - λI))

      const lambdaRep = tr / 2;
      const expLambda = Math.exp(lambdaRep * dt);

      // A - λI = [[a - λ, b], [c, d - λ]]
      const a_adj = a - lambdaRep;
      const d_adj = d - lambdaRep;

      // exp(At) = exp(λt) * [[1 + t*a_adj, t*b], [t*c, 1 + t*d_adj]]
      N_new = expLambda * ((1 + dt * a_adj) * N + dt * b * C);
      C_new = expLambda * (dt * c * N + (1 + dt * d_adj) * C);
    }

    // Return effective rates
    return {
      dN_dt: (N_new - N) / dt,
      dC_dt: (C_new - C) / dt,
    };
  }

  private computeTotalReactivity(n: any, state: SimulationState): number {
    // Control rod contribution
    const rhoRods = -n.controlRodWorth * (1 - n.controlRodPosition);

    // Fuel temperature feedback (Doppler)
    const fuelTemp = this.getAverageFuelTemperature(state, n);
    const dT_fuel = fuelTemp - n.refFuelTemp;
    const rhoDoppler = n.fuelTempCoeff * dT_fuel;

    // Coolant temperature feedback
    const coolantTemp = this.getAverageCoolantTemperature(state, n);
    const dT_coolant = coolantTemp - n.refCoolantTemp;
    const rhoCoolantTemp = n.coolantTempCoeff * dT_coolant;

    // Coolant density feedback
    const coolantDensity = this.getAverageCoolantDensity(state, n);
    const dRho_coolant = coolantDensity - n.refCoolantDensity;
    const rhoCoolantDensity = n.coolantDensityCoeff * dRho_coolant;

    return rhoRods + rhoDoppler + rhoCoolantTemp + rhoCoolantDensity;
  }

  private getAverageFuelTemperature(state: SimulationState, n: any): number {
    if (n.fuelNodeId) {
      const fuelNode = state.thermalNodes.get(n.fuelNodeId);
      if (fuelNode) return fuelNode.temperature;
    }
    for (const [, node] of state.thermalNodes) {
      if (node.label.toLowerCase().includes('fuel')) {
        return node.temperature;
      }
    }
    return n.refFuelTemp;
  }

  private getAverageCoolantTemperature(state: SimulationState, n: any): number {
    if (n.coolantNodeId) {
      const coolantNode = state.flowNodes.get(n.coolantNodeId);
      if (coolantNode) return coolantNode.fluid.temperature;
    }
    for (const [, node] of state.flowNodes) {
      if (node.label.toLowerCase().includes('coolant') || node.label.toLowerCase().includes('core')) {
        return node.fluid.temperature;
      }
    }
    return n.refCoolantTemp;
  }

  private getAverageCoolantDensity(state: SimulationState, n: any): number {
    if (n.coolantNodeId) {
      const coolantNode = state.flowNodes.get(n.coolantNodeId);
      if (coolantNode) return coolantNode.fluid.mass / coolantNode.volume;
    }
    for (const [, node] of state.flowNodes) {
      if (node.label.toLowerCase().includes('coolant') || node.label.toLowerCase().includes('core')) {
        return node.fluid.mass / node.volume;
      }
    }
    return n.refCoolantDensity;
  }
}

// ============================================================================
// Flow Rate Operator - Mass and Energy Transport
// ============================================================================

export class FlowRateOperator implements RateOperator {
  name = 'FluidFlow';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    // Initialize all flow nodes with zero rates
    for (const [id] of state.flowNodes) {
      rates.flowNodes.set(id, { dMass: 0, dEnergy: 0 });
    }

    // Debug tracking for pump-5
    const debugFlowsIn: Array<{ from: string; massFlow: number; energyFlow: number; h_specific: number; flowPhase: string }> = [];
    const debugFlowsOut: Array<{ to: string; massFlow: number; energyFlow: number; h_specific: number; flowPhase: string }> = [];

    // For each flow connection, compute mass and energy transfer rates
    for (const conn of state.flowConnections) {
      const fromNode = state.flowNodes.get(conn.fromNodeId);
      const toNode = state.flowNodes.get(conn.toNodeId);

      if (!fromNode || !toNode) continue;

      // Use current flow rate (computed by flow dynamics)
      const massFlow = conn.massFlowRate; // kg/s

      // Determine which node is upstream based on flow direction
      let upstreamNode: FlowNode;
      let upstreamId: string;
      let downstreamId: string;
      let upstreamElevation: number | undefined;
      let upstreamPhaseTolerance: number | undefined;

      if (massFlow >= 0) {
        upstreamNode = fromNode;
        upstreamId = conn.fromNodeId;
        downstreamId = conn.toNodeId;
        upstreamElevation = conn.fromElevation;
        upstreamPhaseTolerance = conn.fromPhaseTolerance;
      } else {
        upstreamNode = toNode;
        upstreamId = conn.toNodeId;
        downstreamId = conn.fromNodeId;
        upstreamElevation = conn.toElevation;
        upstreamPhaseTolerance = conn.toPhaseTolerance;
      }

      const absMassFlow = Math.abs(massFlow);

      // Determine what phase is actually flowing based on connection elevation
      // For two-phase nodes, we need to use phase-specific enthalpy
      // Pass mass flow rate so separation calculation can account for turbulence
      let flowPhase = this.getFlowPhase(upstreamNode, upstreamElevation, absMassFlow, upstreamPhaseTolerance);

      // Check if we're trying to draw more of a phase than is available.
      // If the flow rate would drain the phase too quickly, use mixture instead.
      // Limit: 1% of available phase mass per millisecond = 10x per second.
      // This prevents unrealistic phase separation when flow exceeds what the
      // interface can supply. (Approved fallback - discussed with user)
      //
      // IMPORTANT: This limit assumes timesteps <= 100ms. At larger timesteps,
      // we could drain >100% of a phase in one step without triggering this.
      // If timesteps ever exceed 100ms, this logic needs to be revisited.
      // See the warning check below that fires if we'd drain >50% at dt=100ms.
      if (upstreamNode.fluid.phase === 'two-phase' && flowPhase !== 'mixture') {
        const quality = upstreamNode.fluid.quality ?? 0;
        const totalMass = upstreamNode.fluid.mass;
        const maxDrainRate = 10; // 1/s - can drain the phase 10x per second max

        if (flowPhase === 'vapor') {
          const vaporMass = totalMass * quality;
          // If trying to drain vapor faster than 10x/second, use mixture
          if (vaporMass < 1e-6 || absMassFlow > maxDrainRate * vaporMass) {
            flowPhase = 'mixture';
          } else if (absMassFlow > 5 * vaporMass) {
            // Warning: at dt=100ms, this would drain >50% of vapor
            // This shouldn't happen often, but if it does we need to revisit
            console.warn(`[FlowRate] High vapor drain rate in ${upstreamId}: ` +
              `${absMassFlow.toFixed(1)} kg/s from ${vaporMass.toFixed(1)} kg vapor ` +
              `(would drain ${(absMassFlow / vaporMass * 100).toFixed(0)}%/s)`);
          }
        } else if (flowPhase === 'liquid') {
          const liquidMass = totalMass * (1 - quality);
          // If trying to drain liquid faster than 10x/second, use mixture
          if (liquidMass < 1e-6 || absMassFlow > maxDrainRate * liquidMass) {
            flowPhase = 'mixture';
          } else if (absMassFlow > 5 * liquidMass) {
            // Warning: at dt=100ms, this would drain >50% of liquid
            console.warn(`[FlowRate] High liquid drain rate in ${upstreamId}: ` +
              `${absMassFlow.toFixed(1)} kg/s from ${liquidMass.toFixed(1)} kg liquid ` +
              `(would drain ${(absMassFlow / liquidMass * 100).toFixed(0)}%/s)`);
          }
        }
      }

      // Get specific enthalpy based on what's actually flowing
      const h_up = this.getSpecificEnthalpy(upstreamNode, flowPhase);

      // Energy flow rate = mass flow * specific enthalpy
      const energyFlow = absMassFlow * h_up;

      // Update rates: upstream loses mass/energy, downstream gains
      const upRates = rates.flowNodes.get(upstreamId)!;
      const downRates = rates.flowNodes.get(downstreamId)!;

      upRates.dMass -= absMassFlow;
      upRates.dEnergy -= energyFlow;

      downRates.dMass += absMassFlow;
      downRates.dEnergy += energyFlow;

      // Track flows for debug node
      if (downstreamId === DEBUG_NODE_ID) {
        debugFlowsIn.push({ from: upstreamId, massFlow: absMassFlow, energyFlow, h_specific: h_up, flowPhase });
      }
      if (upstreamId === DEBUG_NODE_ID) {
        debugFlowsOut.push({ to: downstreamId, massFlow: absMassFlow, energyFlow, h_specific: h_up, flowPhase });
      }
    }

    // Log debug snapshot for pump-5
    const debugNode = state.flowNodes.get(DEBUG_NODE_ID);
    const debugRates = rates.flowNodes.get(DEBUG_NODE_ID);
    if (debugNode && debugRates) {
      logDebugSnapshot({
        time: state.time,
        mass: debugNode.fluid.mass,
        internalEnergy: debugNode.fluid.internalEnergy,
        volume: debugNode.volume,
        temperature: debugNode.fluid.temperature,
        pressure: debugNode.fluid.pressure,
        phase: debugNode.fluid.phase,
        quality: debugNode.fluid.quality ?? 0,
        u_specific: (debugNode.fluid.internalEnergy / debugNode.fluid.mass) / 1000,
        v_specific: (debugNode.volume / debugNode.fluid.mass) * 1e6,
        flowsIn: debugFlowsIn,
        flowsOut: debugFlowsOut,
        dMass: debugRates.dMass,
        dEnergy: debugRates.dEnergy,
      });
    }

    return rates;
  }

  /**
   * Determine what phase of fluid is flowing based on connection elevation
   * relative to liquid level in a two-phase node.
   *
   * Uses physics-based separation model: only nodes with sufficient residence
   * time and low turbulence will have separated phases. The separation factor
   * determines how much of the flow is phase-specific vs mixture.
   *
   * @param node The upstream flow node
   * @param connectionElevation Height of connection relative to node bottom (m)
   * @param massFlowRate Mass flow rate through the connection (kg/s)
   * @param phaseTolerance Tolerance zone around interface (m). 0 = no tolerance, undefined = use default.
   * @returns The phase of fluid flowing ('liquid', 'vapor', or 'mixture')
   */
  private getFlowPhase(
    node: FlowNode,
    connectionElevation?: number,
    massFlowRate: number = 0,
    phaseTolerance?: number
  ): 'liquid' | 'vapor' | 'mixture' {
    // Single phase nodes always flow their phase
    if (node.fluid.phase !== 'two-phase') {
      return node.fluid.phase === 'vapor' ? 'vapor' : 'liquid';
    }

    // Calculate separation factor (0 = fully mixed, 1 = fully separated)
    const separation = calculateSeparation(node, massFlowRate);

    // If separation is low, return mixture regardless of elevation
    if (separation < 0.1) {
      return 'mixture';
    }

    // Get node height - use stored value or estimate
    const nodeHeight = node.height ?? Math.cbrt(node.volume);

    // If no elevation specified, assume mid-height connection (mixture)
    if (connectionElevation === undefined) {
      connectionElevation = nodeHeight / 2;
    }

    // Calculate liquid level from quality and density
    // For separated two-phase: liquid mass settles at the bottom
    // liquid_volume = liquid_mass / rho_liquid
    // liquid_level = calculated from volume accounting for internal obstructions
    const quality = node.fluid.quality ?? 0.5;
    const T_C = node.fluid.temperature - 273.15;

    const rho_liquid = T_C < 100 ? 1000 - 0.08 * T_C :
                       T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                       Math.max(400, 700 - 2.5 * (T_C - 300));

    // Calculate liquid mass and volume
    const liquidMass = node.fluid.mass * (1 - quality);
    const liquidVolume = liquidMass / rho_liquid;

    // Calculate liquid level accounting for internal obstructions
    const liquidLevel = calculateLiquidLevelWithObstructions(node, liquidVolume);

    // Tolerance zone around the interface
    // If phaseTolerance is specified (including 0), use it directly
    // Otherwise use default: wider when separation is low
    const interfaceTolerance = phaseTolerance !== undefined
      ? phaseTolerance
      : 0.1 + (1 - separation) * nodeHeight * 0.4;

    // Connection well below liquid level: draw liquid
    if (connectionElevation < liquidLevel - interfaceTolerance) {
      return 'liquid';
    }

    // Connection well above liquid level: draw vapor
    if (connectionElevation > liquidLevel + interfaceTolerance) {
      return 'vapor';
    }

    // Connection near interface: draw mixture
    return 'mixture';
  }

  /**
   * Get specific enthalpy of the flowing phase.
   * h = u + Pv for the phase actually being drawn from the node.
   */
  private getSpecificEnthalpy(node: FlowNode, flowPhase: 'liquid' | 'vapor' | 'mixture'): number {
    const P = node.fluid.pressure;
    const T = node.fluid.temperature;
    const T_C = T - 273.15;

    // For single-phase or mixture, use bulk average
    if (node.fluid.phase !== 'two-phase' || flowPhase === 'mixture') {
      const u = node.fluid.internalEnergy / node.fluid.mass;
      const v = node.volume / node.fluid.mass;
      return u + P * v;
    }

    // For two-phase node drawing from specific phase, use phase-specific properties
    if (flowPhase === 'liquid') {
      // Saturated liquid specific internal energy
      // u_f ≈ c_p * (T - T_ref) where c_p ≈ 4186 J/kg/K for water
      const u_f = 4186 * T_C; // J/kg relative to 0°C

      // Saturated liquid specific volume (approximate)
      const rho_f = T_C < 100 ? 1000 - 0.08 * T_C :
                    T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                    700 - 2.5 * (T_C - 300);
      const v_f = 1 / rho_f;

      // Specific enthalpy h_f = u_f + P*v_f
      return u_f + P * v_f;
    } else {
      // Saturated vapor specific internal energy
      // u_g = u_f + u_fg where u_fg ≈ h_fg - P*(v_g - v_f) ≈ h_fg - P*v_g
      // h_fg varies from ~2257 kJ/kg at 100°C to ~1000 kJ/kg near critical
      const u_f = 4186 * T_C;

      // Approximate h_fg (latent heat)
      const P_bar = P / 1e5;
      const h_fg = P_bar < 10 ? 2200e3 :
                   P_bar < 100 ? 2200e3 - (P_bar - 10) * 10e3 :
                   1300e3 - (P_bar - 100) * 10e3;

      // Saturated vapor specific volume
      const rho_g = P * 0.018 / (8.314 * T);
      const v_g = 1 / rho_g;

      // u_g ≈ u_f + h_fg - P*v_g (from h = u + Pv and h_g = h_f + h_fg)
      const u_g = u_f + h_fg - P * v_g;

      // Specific enthalpy h_g = u_g + P*v_g = u_f + h_fg
      return u_g + P * v_g;
    }
  }
}

// ============================================================================
// Turbine/Condenser Rate Operator
// ============================================================================

import { updateTurbineCondenserState } from './turbine-condenser';

export class TurbineCondenserRateOperator implements RateOperator {
  name = 'TurbineCondenser';

  private turbineEfficiency = 0.87;
  private loggedOnce = false;
  private c_p_water = 4186; // J/kg-K for cooling water

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    // Initialize
    for (const [id] of state.flowNodes) {
      rates.flowNodes.set(id, { dMass: 0, dEnergy: 0 });
    }

    // Debug: Log all flow node IDs once
    if (!this.loggedOnce) {
      console.log('[TurbineCondenser] All flow node IDs:', Array.from(state.flowNodes.keys()));
      this.loggedOnce = true;
    }

    let totalTurbinePower = 0;
    let totalCondenserHeat = 0;

    // Find turbines dynamically by looking for nodes that have "turbine" in the label
    // and are connected to condensers
    for (const [turbineNodeId, turbineNode] of state.flowNodes) {
      // Check if this is a turbine node (by label or id pattern)
      const isTurbine = turbineNode.label?.toLowerCase().includes('turbine') ||
                        turbineNodeId.includes('turbine-generator');

      if (!isTurbine) continue;

      // Find flow INTO the turbine
      let massFlowRate = 0;
      let outletNodeId: string | null = null;

      for (const conn of state.flowConnections) {
        // Flow into turbine
        if (conn.toNodeId === turbineNodeId && conn.massFlowRate > 0) {
          massFlowRate += conn.massFlowRate;
        }
        // Flow out of turbine - find the outlet (likely condenser)
        if (conn.fromNodeId === turbineNodeId && conn.massFlowRate > 0) {
          outletNodeId = conn.toNodeId;
        }
      }

      if (massFlowRate < 1 || !outletNodeId) continue;

      const outletNode = state.flowNodes.get(outletNodeId);
      if (!outletNode) continue;

      // Skip if inlet is liquid
      if (turbineNode.fluid.phase === 'liquid') continue;

      const P_in = turbineNode.fluid.pressure;
      const P_out = outletNode.fluid.pressure;

      if (P_in <= P_out) continue;

      // Compute enthalpy at turbine
      const u_in = turbineNode.fluid.internalEnergy / turbineNode.fluid.mass;
      const v_in = turbineNode.volume / turbineNode.fluid.mass;
      const h_in = u_in + P_in * v_in;

      // Approximate isentropic expansion
      const pressureRatio = P_out / P_in;
      const h_out_ideal = h_in * Math.pow(pressureRatio, 0.3);
      const deltaH = this.turbineEfficiency * (h_in - h_out_ideal);

      // Power extracted
      const power = massFlowRate * deltaH;
      totalTurbinePower += power;

      // Remove energy from the TURBINE node (where work is extracted)
      // The flow operator will then advect the reduced-enthalpy steam to the condenser
      const turbineRates = rates.flowNodes.get(turbineNodeId);
      if (turbineRates) {
        turbineRates.dEnergy -= power;
      }
    }

    // Find condensers dynamically
    for (const [condenserNodeId, condenserNode] of state.flowNodes) {
      // Check if this is a condenser node
      const isCondenser = condenserNode.label?.toLowerCase().includes('condenser') ||
                          condenserNodeId.includes('condenser');

      if (!isCondenser) continue;

      // Steam temperature (saturation temp for condensing steam)
      const T_steam = condenserNode.fluid.temperature;

      // Get condenser properties from flow node
      if (condenserNode.heatSinkTemp === undefined) {
        throw new Error(`[TurbineCondenser] Condenser node '${condenserNodeId}' missing heatSinkTemp property`);
      }
      const T_cw_in = condenserNode.heatSinkTemp;
      const m_cw = condenserNode.coolingWaterFlow ?? 50000; // kg/s default
      const UA = condenserNode.condenserUA ?? 100e6; // W/K default

      // Calculate heat removal using LMTD method
      // For a condenser: steam at T_steam, cooling water from T_cw_in to T_cw_out
      // Q = UA × LMTD = m_cw × c_p × (T_cw_out - T_cw_in)

      // Maximum possible heat removal (limited by cooling water heat capacity)
      // If all steam energy went to cooling water: T_cw_out would approach T_steam
      // But LMTD goes to zero as T_cw_out -> T_steam, so there's a balance point

      // Iterative solution: find Q such that Q = UA × LMTD(Q)
      // For efficiency, use a simplified approach:
      // Assume T_cw_out based on current heat rate, then compute LMTD

      // Start with a guess based on simple ΔT
      const dT_simple = T_steam - T_cw_in;
      if (dT_simple <= 0) {
        // Steam is colder than cooling water - no heat removal
        continue;
      }

      // Use effectiveness-NTU method for more accurate calculation
      // NTU = UA / (m_cw × c_p)
      // For condenser (C_min/C_max = 0): effectiveness ε = 1 - exp(-NTU)
      // Q = ε × (m_cw × c_p) × (T_steam - T_cw_in)
      const C_cw = m_cw * this.c_p_water; // W/K - cooling water heat capacity rate
      const NTU = UA / C_cw;
      const effectiveness = 1 - Math.exp(-NTU);

      // Heat removal rate
      const heatRate = effectiveness * C_cw * dT_simple;

      totalCondenserHeat += heatRate;

      const condRates = rates.flowNodes.get(condenserNodeId);
      if (condRates) {
        condRates.dEnergy -= heatRate;
      }
    }

    // Update shared state for display (accessed via getTurbineCondenserState)
    updateTurbineCondenserState(totalTurbinePower, totalCondenserHeat);

    return rates;
  }
}

// ============================================================================
// Fluid State Constraint Operator
// ============================================================================

export class FluidStateConstraintOperator implements ConstraintOperator {
  name = 'FluidState';

  // Latent heat of fusion for water: 334 kJ/kg
  private static readonly LATENT_HEAT_FUSION = 334000; // J/kg
  // Freezing point
  private static readonly T_FREEZE = 273.15; // K
  // Specific heat of liquid water near freezing
  private static readonly CP_WATER = 4186; // J/kg-K
  // Maximum allowed ice fraction before throwing error
  private static readonly MAX_ICE_FRACTION = 0.5;

  applyConstraints(state: SimulationState): SimulationState {
    const newState = cloneSimulationState(state);

    // Update fluid properties (T, P, phase) from (m, U, V)
    for (const [nodeId, flowNode] of newState.flowNodes) {
      // Check for physically impossible density (mass accumulation bug)
      // Maximum water density is ~1000 kg/m³ at normal conditions, ~1100 kg/m³ at high pressure
      // Anything above 1500 kg/m³ indicates a mass balance error
      const density = flowNode.fluid.mass / flowNode.volume;
      if (density > 1500) {
        // Find what's flowing in/out of this node
        const flowsIn: string[] = [];
        const flowsOut: string[] = [];
        for (const conn of state.flowConnections) {
          if (conn.toNodeId === nodeId && conn.massFlowRate > 0) {
            flowsIn.push(`${conn.fromNodeId}: ${conn.massFlowRate.toFixed(1)} kg/s`);
          }
          if (conn.fromNodeId === nodeId && conn.massFlowRate > 0) {
            flowsOut.push(`${conn.toNodeId}: ${conn.massFlowRate.toFixed(1)} kg/s`);
          }
          if (conn.toNodeId === nodeId && conn.massFlowRate < 0) {
            flowsOut.push(`${conn.fromNodeId}: ${(-conn.massFlowRate).toFixed(1)} kg/s (reverse)`);
          }
          if (conn.fromNodeId === nodeId && conn.massFlowRate < 0) {
            flowsIn.push(`${conn.toNodeId}: ${(-conn.massFlowRate).toFixed(1)} kg/s (reverse)`);
          }
        }

        console.error(`[FluidState] MASS ACCUMULATION ERROR in ${nodeId}:`);
        console.error(`  Density: ${density.toFixed(1)} kg/m³ (max physical: ~1100 kg/m³)`);
        console.error(`  Mass: ${flowNode.fluid.mass.toFixed(1)} kg, Volume: ${(flowNode.volume * 1000).toFixed(1)} L`);
        console.error(`  Flows IN: ${flowsIn.length > 0 ? flowsIn.join(', ') : 'none'}`);
        console.error(`  Flows OUT: ${flowsOut.length > 0 ? flowsOut.join(', ') : 'none'}`);
        console.error(`  This usually means a pump can't push against downstream pressure.`);

        throw new Error(`[FluidState] Node '${nodeId}' has physically impossible density ${density.toFixed(0)} kg/m³. Mass is accumulating faster than it can leave.`);
      }

      // Initialize ice fraction if not present
      if (flowNode.iceFraction === undefined) {
        flowNode.iceFraction = 0;
      }

      // First, calculate what the water state would be with current internal energy
      let effectiveEnergy = flowNode.fluid.internalEnergy;

      // If we have ice, we need to account for the latent heat locked in the ice
      // The internal energy stored in the FluidState doesn't include the latent heat buffer
      // So we add it back when calculating the effective temperature
      if (flowNode.iceFraction > 0) {
        // Ice is present - we're at the freezing point
        // Any energy added/removed goes into melting/freezing, not temperature change
        const iceEnergy = flowNode.iceFraction * flowNode.fluid.mass * FluidStateConstraintOperator.LATENT_HEAT_FUSION;

        // Calculate what temperature would be if all the ice melted
        const energyIfMelted = effectiveEnergy + iceEnergy;
        const waterStateIfMelted = Water.calculateState(
          flowNode.fluid.mass,
          energyIfMelted,
          flowNode.volume
        );

        if (waterStateIfMelted.temperature >= FluidStateConstraintOperator.T_FREEZE) {
          // Enough energy to melt all ice - calculate how much ice actually melts
          // Energy available for melting = U - U_at_0C
          const U_at_0C = flowNode.fluid.mass * FluidStateConstraintOperator.CP_WATER * (FluidStateConstraintOperator.T_FREEZE - 273.15);
          // This is approximate - we use the current stored energy to figure out how much to melt
          const energyAboveFreezing = flowNode.fluid.internalEnergy - U_at_0C;

          if (energyAboveFreezing > 0) {
            // Melt some ice
            const energyToMelt = Math.min(iceEnergy, energyAboveFreezing);
            const iceMelted = energyToMelt / FluidStateConstraintOperator.LATENT_HEAT_FUSION / flowNode.fluid.mass;
            flowNode.iceFraction = Math.max(0, flowNode.iceFraction - iceMelted);

            // If all ice melted, proceed with normal calculation
            if (flowNode.iceFraction <= 0) {
              flowNode.iceFraction = 0;
              // Continue with normal water state calculation below
            } else {
              // Still have ice - stay at freezing point
              flowNode.fluid.temperature = FluidStateConstraintOperator.T_FREEZE;
              flowNode.fluid.phase = 'liquid';
              flowNode.fluid.quality = 0;
              flowNode.fluid.pressure = Water.saturationPressure(FluidStateConstraintOperator.T_FREEZE);
              continue; // Skip to next node
            }
          } else {
            // Not enough energy to melt ice - stay at 0°C with current ice fraction
            flowNode.fluid.temperature = FluidStateConstraintOperator.T_FREEZE;
            flowNode.fluid.phase = 'liquid';
            flowNode.fluid.quality = 0;
            flowNode.fluid.pressure = Water.saturationPressure(FluidStateConstraintOperator.T_FREEZE);
            continue;
          }
        } else {
          // Even melting all ice wouldn't get above 0°C - freeze more
          // This shouldn't happen if we're maintaining proper energy balance
          console.warn(`[FluidState] ${nodeId}: Temperature would be ${waterStateIfMelted.temperature.toFixed(1)}K even after melting all ice`);
          flowNode.fluid.temperature = FluidStateConstraintOperator.T_FREEZE;
          flowNode.fluid.phase = 'liquid';
          flowNode.fluid.quality = 0;
          flowNode.fluid.pressure = Water.saturationPressure(FluidStateConstraintOperator.T_FREEZE);
          continue;
        }
      }

      // Calculate water state normally
      // DEBUG: Track pressure jumps for specific nodes
      const debugNodes = ['pum-6'];
      if (debugNodes.includes(nodeId)) {
        Water.setDebugNodeId(nodeId);
      }
      let waterState: Water.WaterState;
      try {
        waterState = Water.calculateState(
          flowNode.fluid.mass,
          flowNode.fluid.internalEnergy,
          flowNode.volume
        );
      } catch (e) {
        // Add extra context to the error for debugging
        const mass = flowNode.fluid.mass;
        const U = flowNode.fluid.internalEnergy;
        const vol = flowNode.volume;
        console.error(`[FluidState] Error in ${nodeId}:`);
        console.error(`  mass=${mass.toFixed(1)}kg, U=${(U/1e6).toFixed(3)}MJ, V=${(vol*1e3).toFixed(1)}L`);
        console.error(`  u=${(U/mass/1e3).toFixed(2)}kJ/kg, v=${(vol/mass*1e6).toFixed(2)}mL/kg, ρ=${(mass/vol).toFixed(1)}kg/m³`);
        // Dump debug history before re-throwing
        if (nodeId === DEBUG_NODE_ID) {
          dumpDebugHistory();
        }
        throw e;
      }
      if (debugNodes.includes(nodeId)) {
        Water.setDebugNodeId(null);
      }

      // Check if temperature would go below freezing
      if (waterState.temperature < FluidStateConstraintOperator.T_FREEZE) {
        // Calculate energy deficit below freezing
        // Energy at 0°C (approximately) = mass * cp * (0°C - some reference)
        // We want to know how much energy below 0°C we are
        const dT_below_freezing = FluidStateConstraintOperator.T_FREEZE - waterState.temperature;
        const energyDeficit = flowNode.fluid.mass * FluidStateConstraintOperator.CP_WATER * dT_below_freezing;

        // Convert energy deficit to ice fraction
        const additionalIceFraction = energyDeficit / (flowNode.fluid.mass * FluidStateConstraintOperator.LATENT_HEAT_FUSION);
        flowNode.iceFraction = Math.min(1, flowNode.iceFraction + additionalIceFraction);

        // Check if we've frozen too much
        if (flowNode.iceFraction > FluidStateConstraintOperator.MAX_ICE_FRACTION) {
          console.error(`[FluidState] FREEZING ERROR in ${nodeId}: Ice fraction ${(flowNode.iceFraction * 100).toFixed(1)}% exceeds ${FluidStateConstraintOperator.MAX_ICE_FRACTION * 100}% limit! ` +
            `T_calc=${waterState.temperature.toFixed(1)}K, mass=${flowNode.fluid.mass.toFixed(1)}kg`);
          // Still set values so we can see what's happening
        }

        // Clamp temperature at freezing point
        flowNode.fluid.temperature = FluidStateConstraintOperator.T_FREEZE;
        flowNode.fluid.phase = 'liquid';
        flowNode.fluid.quality = 0;
        flowNode.fluid.pressure = Water.saturationPressure(FluidStateConstraintOperator.T_FREEZE);

        // Adjust internal energy to match 0°C (the deficit is now in the ice fraction)
        // This keeps the energy balance consistent
        flowNode.fluid.internalEnergy += energyDeficit;
      } else {
        // Normal operation - update temperature and phase
        flowNode.fluid.temperature = waterState.temperature;
        flowNode.fluid.phase = waterState.phase;
        flowNode.fluid.quality = waterState.quality;

        // Determine pressure based on phase
        if (waterState.phase === 'two-phase' || waterState.phase === 'vapor') {
          flowNode.fluid.pressure = waterState.pressure;
        } else {
          // Liquid: use pressure model
          // NOTE: The 'hybrid' pressure model is OBSOLETE and should not be used.
          // It was never properly implemented here - the original code had rho_base = rho_current
          // which made dP always zero. Use pure-triangulation for accurate physics.
          if (simulationConfig.pressureModel === 'pure-triangulation') {
            flowNode.fluid.pressure = waterState.pressure;
          } else {
            // OBSOLETE hybrid model - kept for backwards compatibility but does nothing useful
            const P_base = newState.liquidBasePressures?.get(nodeId) ?? waterState.pressure;
            const rho_current = flowNode.fluid.mass / flowNode.volume;
            const v_specific = flowNode.volume / flowNode.fluid.mass;
            const rho_base = 1 / v_specific;  // Note: This equals rho_current, so dP = 0
            const K = Water.bulkModulus(waterState.temperature - 273.15);
            const dP = K * (rho_current - rho_base) / rho_base;
            flowNode.fluid.pressure = P_base + dP;
          }
        }
      }

      // Sanity checks - log warnings but do NOT clamp values
      // Clamping hides problems; we need to see what's causing invalid states
      if (!isFinite(flowNode.fluid.temperature) || flowNode.fluid.temperature < 200 || flowNode.fluid.temperature > 2000) {
        console.warn(`[FluidState] Invalid temperature in ${nodeId}: ${flowNode.fluid.temperature}K, mass=${flowNode.fluid.mass.toFixed(1)}kg, U=${(flowNode.fluid.internalEnergy/1e6).toFixed(2)}MJ`);
      }
      // Triple point pressure is 611.657 Pa - warn if we get close to or below it
      if (!isFinite(flowNode.fluid.pressure) || flowNode.fluid.pressure < 650 || flowNode.fluid.pressure > 50e6) {
        console.warn(`[FluidState] Invalid pressure in ${nodeId}: ${flowNode.fluid.pressure}Pa, mass=${flowNode.fluid.mass.toFixed(1)}kg, vol=${flowNode.volume.toFixed(3)}m³, ρ=${(flowNode.fluid.mass/flowNode.volume).toFixed(1)}kg/m³`);
      }
    }

    // Calculate phase separation for all two-phase nodes
    // This must be done after phase is determined, and needs flow connection data
    const nodeMassFlows = new Map<string, number>();
    for (const conn of newState.flowConnections) {
      const absFlow = Math.abs(conn.massFlowRate);
      nodeMassFlows.set(conn.fromNodeId, (nodeMassFlows.get(conn.fromNodeId) ?? 0) + absFlow);
      nodeMassFlows.set(conn.toNodeId, (nodeMassFlows.get(conn.toNodeId) ?? 0) + absFlow);
    }

    for (const [nodeId, flowNode] of newState.flowNodes) {
      if (flowNode.fluid.phase === 'two-phase') {
        const totalFlow = nodeMassFlows.get(nodeId) ?? 0;
        flowNode.separation = calculateSeparation(flowNode, totalFlow);
      } else {
        flowNode.separation = undefined;  // Only meaningful for two-phase
      }
    }

    return newState;
  }
}

// ============================================================================
// Flow Dynamics Constraint Operator
// ============================================================================
//
// NOTE: With inertial flow dynamics (FlowMomentumRateOperator), this operator
// should NOT set massFlowRate. Flow rate is now a state variable that gets
// integrated via the momentum equation. This operator only computes the
// steady-state target flow for debugging display purposes.

export class FlowDynamicsConstraintOperator implements ConstraintOperator {
  name = 'FlowDynamics';

  /**
   * Calculate pressure at a specific connection elevation within a node,
   * accounting for hydrostatic head within the node.
   */
  private getPressureAtConnection(node: FlowNode, connectionElevation?: number): number {
    const g = 9.81;
    const baseP = node.fluid.pressure;
    const nodeHeight = Math.sqrt(node.volume / (Math.PI * 0.25));

    if (connectionElevation === undefined) {
      connectionElevation = nodeHeight / 2;
    }

    if (node.fluid.phase === 'two-phase') {
      const quality = node.fluid.quality || 0;
      const T_C = node.fluid.temperature - 273.15;
      const rho_liquid = T_C < 100 ? 1000 - 0.08 * T_C :
                         T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                         700 - 2.5 * (T_C - 300);
      const rho_vapor = node.fluid.pressure * 0.018 / (8.314 * node.fluid.temperature);
      const voidFraction = (quality * rho_liquid) / (quality * rho_liquid + (1 - quality) * rho_vapor);
      const liquidLevel = nodeHeight * (1 - voidFraction);

      if (connectionElevation < liquidLevel) {
        return baseP + rho_liquid * g * (liquidLevel - connectionElevation);
      }
      return baseP;
    } else if (node.fluid.phase === 'liquid') {
      // Liquid nodes: base pressure is at top, add hydrostatic head below
      const rho = node.fluid.mass / node.volume;
      const liquidHead = nodeHeight - connectionElevation;
      return baseP + rho * g * liquidHead;
    }
    return baseP;
  }

  applyConstraints(state: SimulationState): SimulationState {
    const newState = cloneSimulationState(state);

    for (const conn of newState.flowConnections) {
      const fromNode = newState.flowNodes.get(conn.fromNodeId);
      const toNode = newState.flowNodes.get(conn.toNodeId);

      if (!fromNode || !toNode) continue;

      // Compute what the steady-state flow would be (for debugging/display)
      const targetFlow = this.computeSteadyStateFlow(conn, fromNode, toNode, newState);
      conn.targetFlowRate = targetFlow;
      conn.steadyStateFlow = targetFlow;

      // === PHYSICAL CONSTRAINTS ON FLOW ===

      // Note: Running pumps resist reverse flow via high friction in the rate equation,
      // not hard clamping here. This provides smoother dynamics.

      // Check valves prevent reverse flow
      const checkValve = newState.components.checkValves?.get(conn.id);
      if (checkValve && conn.massFlowRate < 0) {
        conn.massFlowRate = 0;
      }
    }

    return newState;
  }

  private computeSteadyStateFlow(
    conn: any,
    fromNode: FlowNode,
    toNode: FlowNode,
    state: SimulationState
  ): number {
    // Pressure difference with hydrostatic adjustment at connection points
    const P_from = this.getPressureAtConnection(fromNode, conn.fromElevation);
    const P_to = this.getPressureAtConnection(toNode, conn.toElevation);
    const dP_pressure = P_from - P_to;

    // Gravity head
    const rho_avg = (fromNode.fluid.mass / fromNode.volume + toNode.fluid.mass / toNode.volume) / 2;
    const dz = conn.elevation || 0;
    const dP_gravity = -rho_avg * 9.81 * dz;

    // Pump head
    let dP_pump = 0;
    for (const [, pump] of state.components.pumps) {
      if (pump.connectedFlowPath === conn.id && pump.running && pump.effectiveSpeed > 0) {
        dP_pump = pump.effectiveSpeed * pump.ratedHead * rho_avg * 9.81;
      }
    }

    // Valve position
    let valveOpenFraction = 1.0;
    for (const [, valve] of state.components.valves) {
      if (valve.connectedFlowPath === conn.id) {
        valveOpenFraction = valve.position;
      }
    }

    if (valveOpenFraction < 0.01) {
      return 0; // Valve closed
    }

    // Total driving pressure
    const dP_total = dP_pressure + dP_gravity + dP_pump;

    // Flow from steady-state momentum: dP = K * (1/2) * rho * v²
    const K = (conn.resistanceCoeff || 10) / Math.pow(valveOpenFraction, 2);
    const A = conn.flowArea || 0.1;

    const sign = dP_total >= 0 ? 1 : -1;
    const v = sign * Math.sqrt(2 * Math.abs(dP_total) / (K * rho_avg));
    const massFlow = rho_avg * A * v;

    return massFlow;
  }
}

// ============================================================================
// Pump Speed Rate Operator
// ============================================================================

/**
 * Computes the rate of change of pump effectiveSpeed based on ramp-up/coast-down
 * dynamics. This integrates properly with the RK45 solver.
 *
 * When pump is running: dEffectiveSpeed/dt = targetSpeed / rampUpTime
 * When pump is stopped: dEffectiveSpeed/dt = -effectiveSpeed / coastDownTime
 */
export class PumpSpeedRateOperator implements RateOperator {
  name = 'PumpSpeed';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const [id, pump] of state.components.pumps) {
      let dEffectiveSpeed = 0;

      if (pump.running) {
        const targetSpeed = pump.speed;
        if (pump.effectiveSpeed < targetSpeed) {
          // Ramp up: constant rate to reach target in rampUpTime
          dEffectiveSpeed = targetSpeed / pump.rampUpTime;
        } else if (pump.effectiveSpeed > targetSpeed) {
          // Speed reduced: coast down to new target
          dEffectiveSpeed = -1.0 / pump.coastDownTime;
        }
        // else: at target, no change needed
      } else {
        // Pump stopped: coast down to zero
        if (pump.effectiveSpeed > 0) {
          dEffectiveSpeed = -1.0 / pump.coastDownTime;
        }
      }

      if (dEffectiveSpeed !== 0) {
        rates.pumps.set(id, { dEffectiveSpeed });
      }
    }

    return rates;
  }
}

// ============================================================================
// Pump Speed Constraint Operator (DEPRECATED - kept for backwards compatibility)
// ============================================================================

/**
 * @deprecated Use PumpSpeedRateOperator instead. This constraint-based approach
 * doesn't work well with RK45 because constraint operators don't receive dt.
 */
export class PumpSpeedConstraintOperator implements ConstraintOperator {
  name = 'PumpSpeed';

  applyConstraints(state: SimulationState): SimulationState {
    // This operator is deprecated - pump speeds are now handled by PumpSpeedRateOperator
    // Just return the state unchanged
    return state;
  }

  reset(): void {
    // No-op
  }
}

// ============================================================================
// Flow Momentum Rate Operator
// ============================================================================

/**
 * Computes the rate of change of mass flow rate for each flow connection
 * using the momentum equation:
 *
 *   ρ * (L/A) * dv/dt = ΔP - friction
 *
 * where:
 *   - L/A is the inertance (length / flow area)
 *   - ΔP is the net driving pressure (pressure diff + gravity + pump)
 *   - friction = K * 0.5 * ρ * v²
 *
 * Converting to mass flow rate ṁ = ρ * A * v:
 *   dṁ/dt = A * (ΔP - friction) / inertance
 */
export class FlowMomentumRateOperator implements RateOperator {
  name = 'FlowMomentum';

  /**
   * Calculate pressure at a specific connection elevation within a node,
   * accounting for hydrostatic head within the node.
   */
  private getPressureAtConnection(node: FlowNode, connectionElevation?: number): number {
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
  private getLiquidDensity(node: FlowNode): number {
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
  private getVaporDensity(node: FlowNode): number {
    // Ideal gas approximation: ρ = PM/(RT)
    const P = node.fluid.pressure;
    const T = node.fluid.temperature;
    const M = 0.018; // kg/mol for water
    const R = 8.314; // J/mol-K
    return Math.max(0.1, P * M / (R * T));
  }

  /**
   * Determine what phase is flowing based on connection elevation and liquid level.
   * @param node The upstream flow node
   * @param connectionElevation Height of connection relative to node bottom (m)
   * @param phaseTolerance Tolerance zone around interface (m). 0 = no tolerance, undefined = use default.
   */
  private getFlowPhase(node: FlowNode, connectionElevation?: number, phaseTolerance?: number): 'liquid' | 'vapor' | 'mixture' {
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
    // liquid_volume = liquid_mass / rho_liquid
    // liquid_level = calculated from volume accounting for internal obstructions
    //
    // Quality x = vapor_mass / total_mass, so liquid_mass = total_mass * (1 - x)
    const quality = node.fluid.quality ?? 0;
    const rho_liquid = this.getLiquidDensity(node);

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

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const conn of state.flowConnections) {
      const fromNode = state.flowNodes.get(conn.fromNodeId);
      const toNode = state.flowNodes.get(conn.toNodeId);

      if (!fromNode || !toNode) continue;

      // Get pipe length L for momentum equation
      // Standard inertance I = ρL/A, and ΔP = I * dQ/dt where Q = v*A
      // This gives: ΔP = ρL/A * A * dv/dt = ρL * dv/dt
      // So: dv/dt = ΔP / (ρ * L)
      // We store just L here; density is applied separately
      let L = conn.length;
      if (!L || L <= 0) {
        L = 10; // Default 10m pipe length
      }

      // Current flow state
      const currentFlow = conn.massFlowRate;
      const A = conn.flowArea || 0.1;

      // Densities for momentum calculations
      const rho_from = fromNode.fluid.mass / fromNode.volume;
      const rho_to = toNode.fluid.mass / toNode.volume;

      // For momentum/inertia, use upstream density - that's the fluid actually moving
      // For positive flow (from->to), upstream is fromNode
      // For negative flow (to->from), upstream is toNode
      const upstreamNode = currentFlow >= 0 ? fromNode : toNode;
      const upstreamElevation = currentFlow >= 0 ? conn.fromElevation : conn.toElevation;
      const upstreamPhaseTolerance = currentFlow >= 0 ? conn.fromPhaseTolerance : conn.toPhaseTolerance;
      const rho_upstream = currentFlow >= 0 ? rho_from : rho_to;

      // Determine what phase is flowing based on connection elevation at upstream node
      const flowPhase = this.getFlowPhase(upstreamNode, upstreamElevation, upstreamPhaseTolerance);

      // Get density for the flowing phase
      let rho_flow: number;
      if (flowPhase === 'liquid') {
        rho_flow = this.getLiquidDensity(upstreamNode);
      } else if (flowPhase === 'vapor') {
        rho_flow = this.getVaporDensity(upstreamNode);
      } else {
        rho_flow = rho_upstream; // mixture - use actual density
      }

      // Current velocity - use flow density since that's what's actually moving
      const v = currentFlow / (rho_flow * A);

      // === Driving pressures ===

      // Pressure difference at connection points, with hydrostatic adjustment
      // This accounts for liquid head within each node based on connection elevation
      const P_from = this.getPressureAtConnection(fromNode, conn.fromElevation);
      const P_to = this.getPressureAtConnection(toNode, conn.toElevation);
      const dP_pressure = P_from - P_to;

      // Gravity head (positive = downward flow is favored)
      // IMPORTANT: Use the density of the fluid filling the pipe between nodes.
      // If liquid is flowing from upstream (e.g., from bottom of condenser),
      // the pipe is filled with liquid, so use liquid density for gravity.
      const g = 9.81;
      const dz = conn.elevation || 0; // positive = upward
      const dP_gravity = -rho_flow * g * dz; // negative if going up, uses flowing phase density

      // Pump head - need to determine correct density for pump suction
      let dP_pump = 0;
      for (const [, pump] of state.components.pumps) {
        if (pump.connectedFlowPath === conn.id && pump.running && pump.effectiveSpeed > 0) {
          // For two-phase suction, pumps draw from the bottom (liquid) if available
          const upstreamNode = currentFlow >= 0 ? fromNode : toNode;
          let pumpRho = rho_upstream; // Default to upstream density

          if (upstreamNode.fluid.phase === 'two-phase' && upstreamNode.fluid.quality !== undefined) {
            // Check if there's enough liquid to draw from
            const liquidFraction = 1 - upstreamNode.fluid.quality;
            const liquidMass = upstreamNode.fluid.mass * liquidFraction;

            // If there's significant liquid (more than 10kg), use liquid density
            if (liquidMass > 10) {
              // Approximate saturated liquid density
              const T_C = upstreamNode.fluid.temperature - 273.15;
              pumpRho = T_C < 100 ? 1000 - 0.08 * T_C :
                        T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                        700 - 2.5 * (T_C - 300);
            }
            // Otherwise use mixture density (pump is cavitating)
          }

          dP_pump = pump.effectiveSpeed * pump.ratedHead * pumpRho * g;
        }
      }

      // === Resistances ===

      // Valve position affects resistance
      let valveOpenFraction = 1.0;
      for (const [, valve] of state.components.valves) {
        if (valve.connectedFlowPath === conn.id) {
          valveOpenFraction = valve.position;
        }
      }

      // If valve is closed, flow rate should decay to zero
      if (valveOpenFraction < 0.01) {
        // Apply strong damping to bring flow to zero
        // dṁ/dt = -ṁ / τ where τ is a short time constant
        const tau = 0.1; // 100ms decay time
        rates.flowConnections.set(conn.id, { dMassFlowRate: -currentFlow / tau });
        continue;
      }

      // === Total driving pressure (computed early for pump/valve checks) ===
      const dP_driving = dP_pressure + dP_gravity + dP_pump;

      // Check valve - prevents reverse flow and requires cracking pressure to open
      const checkValve = state.components.checkValves?.get(conn.id);
      if (checkValve) {
        const crackingPressure = checkValve.crackingPressure ?? 0;
        // Check valve remains closed if:
        // 1. Driving pressure is below cracking pressure (not enough to open)
        // 2. OR driving pressure is negative (trying to reverse)
        if (dP_driving < crackingPressure) {
          // Check valve is closed - decay flow to zero
          const tau = 0.1;
          rates.flowConnections.set(conn.id, { dMassFlowRate: -currentFlow / tau });
          continue;
        }
      }

      // Check if there's a running pump on this connection
      // A pump affects flow on BOTH its inlet and outlet connections:
      // - Outlet connection: pump.connectedFlowPath matches conn.id
      // - Inlet connection: pump is the toNode of this connection
      let pumpOnOutlet: { running: boolean; effectiveSpeed: number } | undefined;
      let pumpOnInlet: { running: boolean; effectiveSpeed: number } | undefined;

      for (const [pumpId, pump] of state.components.pumps) {
        if (pump.connectedFlowPath === conn.id) {
          // This is the pump's outlet connection (pump is fromNode)
          pumpOnOutlet = pump;
        }
        if (conn.toNodeId === pumpId) {
          // This is the pump's inlet connection (pump is toNode)
          pumpOnInlet = pump;
        }
      }

      // Resistance coefficient (K-factor)
      const K_base = conn.resistanceCoeff || 10;
      // Valve increases resistance as it closes: K_eff = K_base / position²
      let K_eff = K_base / Math.pow(valveOpenFraction, 2);

      // Running pumps have very high resistance to reverse flow through the pump
      // The pump impeller physically blocks backflow - model this as extremely high friction
      //
      // For outlet connection (pump is fromNode):
      //   - Positive flow = normal (pump pushes out)
      //   - Negative flow = reverse (downstream pushes back through pump) → block
      //
      // For inlet connection (pump is toNode):
      //   - Positive flow = normal (upstream flows into pump)
      //   - Negative flow = reverse (pump pushes back through its inlet) → block
      //
      // Note: Both cases involve currentFlow < 0, which means flow going from toNode to fromNode
      if (pumpOnOutlet && pumpOnOutlet.running && currentFlow < 0) {
        K_eff += 10000 * K_base;
      }
      if (pumpOnInlet && pumpOnInlet.running && currentFlow < 0) {
        K_eff += 10000 * K_base;
      }

      // === Momentum equation ===

      // Friction pressure drop (always opposes flow direction)
      // dP_friction = -K * 0.5 * ρ * v * |v|  (negative when flow is positive)
      // Uses upstream density since that's the fluid experiencing the friction
      const dP_friction = -K_eff * 0.5 * rho_upstream * v * Math.abs(v);

      // Net accelerating pressure
      const dP_net = dP_driving + dP_friction;

      // Momentum equation: ΔP = ρ * L * dv/dt  (from inertance I = ρL/A, ΔP = I * dQ/dt where Q = v*A)
      // dv/dt = ΔP / (ρ * L)
      // Uses upstream density - that's the fluid being accelerated
      const dv_dt = dP_net / (rho_upstream * L);

      // Convert velocity rate to mass flow rate:
      // ṁ = ρ * A * v
      // dṁ/dt = ρ * A * dv/dt  (assuming ρ changes slowly)
      // Uses upstream density since that's what's flowing
      const dMassFlowRate = rho_upstream * A * dv_dt;

      rates.flowConnections.set(conn.id, { dMassFlowRate });
    }

    return rates;
  }
}
