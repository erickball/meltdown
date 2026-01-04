/**
 * RK45 Solver with Embedded Error Estimation
 *
 * Implements the Dormand-Prince method (DOPRI5) which is a 5th order
 * Runge-Kutta method with embedded 4th order error estimation.
 *
 * Key advantages over forward Euler:
 * - Automatic timestep control based on local error
 * - Higher order accuracy (5th vs 1st)
 * - No need for heuristic stability limits
 *
 * Architecture:
 * - RateOperators compute derivatives (dm/dt, dU/dt, dT/dt, etc.)
 * - ConstraintOperators enforce algebraic constraints (thermodynamic consistency)
 * - Solver combines rates using RK45 and adjusts timestep based on error
 */

import { SimulationState, SolverMetrics, ErrorContributor, PressureSolverConfig, DEFAULT_PRESSURE_SOLVER_CONFIG } from './types';
import { cloneSimulationState } from './solver';
import { PressureSolver } from './operators/pressure-solver';

// ============================================================================
// State Rates - Derivatives for all state variables
// ============================================================================

export interface FlowNodeRates {
  dMass: number;      // kg/s - rate of mass change
  dEnergy: number;    // W - rate of internal energy change
}

export interface FlowConnectionRates {
  dMassFlowRate: number;  // kg/s² - rate of change of mass flow rate (momentum equation)
}

export interface ThermalNodeRates {
  dTemperature: number;  // K/s - rate of temperature change (for solids)
}

export interface NeutronicsRates {
  dPower: number;                    // W/s - rate of power change
  dPrecursorConcentration: number;   // 1/s - rate of precursor change
}

export interface PumpRates {
  dEffectiveSpeed: number;  // 1/s - rate of change of effective speed
}

export interface StateRates {
  flowNodes: Map<string, FlowNodeRates>;
  flowConnections: Map<string, FlowConnectionRates>;  // flow momentum
  thermalNodes: Map<string, ThermalNodeRates>;
  neutronics: NeutronicsRates;
  pumps: Map<string, PumpRates>;  // pump speed dynamics
}

// ============================================================================
// Operator Interfaces
// ============================================================================

export interface RateOperator {
  /** Human-readable name for profiling */
  name: string;

  /**
   * Compute the rates of change for this physics domain.
   * Does NOT modify the input state.
   */
  computeRates(state: SimulationState): StateRates;
}

export interface ConstraintOperator {
  /** Human-readable name for profiling */
  name: string;

  /**
   * Apply algebraic constraints to the state (e.g., thermodynamic consistency).
   * Returns a new state with constraints satisfied.
   */
  applyConstraints(state: SimulationState): SimulationState;
}

// ============================================================================
// Rate Utilities
// ============================================================================

export function createZeroRates(): StateRates {
  return {
    flowNodes: new Map(),
    flowConnections: new Map(),
    thermalNodes: new Map(),
    neutronics: { dPower: 0, dPrecursorConcentration: 0 },
    pumps: new Map(),
  };
}

export function addRates(a: StateRates, b: StateRates): StateRates {
  const result = createZeroRates();

  // Combine flow node rates
  const allFlowNodeIds = new Set([...a.flowNodes.keys(), ...b.flowNodes.keys()]);
  for (const id of allFlowNodeIds) {
    const aRates = a.flowNodes.get(id) || { dMass: 0, dEnergy: 0 };
    const bRates = b.flowNodes.get(id) || { dMass: 0, dEnergy: 0 };
    result.flowNodes.set(id, {
      dMass: aRates.dMass + bRates.dMass,
      dEnergy: aRates.dEnergy + bRates.dEnergy,
    });
  }

  // Combine flow connection rates (momentum)
  const allConnIds = new Set([...a.flowConnections.keys(), ...b.flowConnections.keys()]);
  for (const id of allConnIds) {
    const aRates = a.flowConnections.get(id) || { dMassFlowRate: 0 };
    const bRates = b.flowConnections.get(id) || { dMassFlowRate: 0 };
    result.flowConnections.set(id, {
      dMassFlowRate: aRates.dMassFlowRate + bRates.dMassFlowRate,
    });
  }

  // Combine thermal node rates
  const allThermalNodeIds = new Set([...a.thermalNodes.keys(), ...b.thermalNodes.keys()]);
  for (const id of allThermalNodeIds) {
    const aRates = a.thermalNodes.get(id) || { dTemperature: 0 };
    const bRates = b.thermalNodes.get(id) || { dTemperature: 0 };
    result.thermalNodes.set(id, {
      dTemperature: aRates.dTemperature + bRates.dTemperature,
    });
  }

  // Combine neutronics rates
  result.neutronics = {
    dPower: a.neutronics.dPower + b.neutronics.dPower,
    dPrecursorConcentration: a.neutronics.dPrecursorConcentration + b.neutronics.dPrecursorConcentration,
  };

  // Combine pump rates
  const allPumpIds = new Set([...a.pumps.keys(), ...b.pumps.keys()]);
  for (const id of allPumpIds) {
    const aRates = a.pumps.get(id) || { dEffectiveSpeed: 0 };
    const bRates = b.pumps.get(id) || { dEffectiveSpeed: 0 };
    result.pumps.set(id, {
      dEffectiveSpeed: aRates.dEffectiveSpeed + bRates.dEffectiveSpeed,
    });
  }

  return result;
}

export function scaleRates(rates: StateRates, factor: number): StateRates {
  const result = createZeroRates();

  for (const [id, r] of rates.flowNodes) {
    result.flowNodes.set(id, {
      dMass: r.dMass * factor,
      dEnergy: r.dEnergy * factor,
    });
  }

  for (const [id, r] of rates.flowConnections) {
    result.flowConnections.set(id, {
      dMassFlowRate: r.dMassFlowRate * factor,
    });
  }

  for (const [id, r] of rates.thermalNodes) {
    result.thermalNodes.set(id, {
      dTemperature: r.dTemperature * factor,
    });
  }

  result.neutronics = {
    dPower: rates.neutronics.dPower * factor,
    dPrecursorConcentration: rates.neutronics.dPrecursorConcentration * factor,
  };

  for (const [id, r] of rates.pumps) {
    result.pumps.set(id, {
      dEffectiveSpeed: r.dEffectiveSpeed * factor,
    });
  }

  return result;
}

/**
 * Apply rates to state to get new state: state + rates * dt
 */
export function applyRatesToState(state: SimulationState, rates: StateRates, dt: number): SimulationState {
  const newState = cloneSimulationState(state);

  // Apply flow node rates
  for (const [id, nodeRates] of rates.flowNodes) {
    const node = newState.flowNodes.get(id);
    if (node) {
      node.fluid.mass += nodeRates.dMass * dt;
      node.fluid.internalEnergy += nodeRates.dEnergy * dt;
    }
  }

  // Apply flow connection rates (momentum - integrate mass flow rate)
  for (const [id, connRates] of rates.flowConnections) {
    const conn = newState.flowConnections.find(c => c.id === id);
    if (conn) {
      conn.massFlowRate += connRates.dMassFlowRate * dt;
    }
  }

  // Apply thermal node rates
  for (const [id, nodeRates] of rates.thermalNodes) {
    const node = newState.thermalNodes.get(id);
    if (node) {
      node.temperature += nodeRates.dTemperature * dt;
    }
  }

  // Apply neutronics rates
  newState.neutronics.power += rates.neutronics.dPower * dt;
  newState.neutronics.precursorConcentration += rates.neutronics.dPrecursorConcentration * dt;

  // Apply pump rates
  for (const [id, pumpRates] of rates.pumps) {
    const pump = newState.components.pumps.get(id);
    if (pump) {
      pump.effectiveSpeed += pumpRates.dEffectiveSpeed * dt;
      // Clamp to [0, targetSpeed] to prevent overshoot
      pump.effectiveSpeed = Math.max(0, Math.min(pump.speed, pump.effectiveSpeed));
    }
  }

  return newState;
}

/**
 * Compute the L2 norm of rates for error estimation.
 * Also considers flow magnitude relative to node mass (throughput ratio)
 * to handle stiffness from high flow through small volumes.
 */
export function computeRatesNorm(rates: StateRates, state: SimulationState): number {
  let sumSq = 0;
  let count = 0;

  // Flow nodes - normalize by current values to get relative error
  for (const [id, r] of rates.flowNodes) {
    const node = state.flowNodes.get(id);
    if (node) {
      // Relative mass rate (from net flow)
      // This is what matters for accuracy - if flows are unbalanced, mass changes.
      // Balanced high-throughput is fine because the net dMass will be small.
      if (node.fluid.mass > 0) {
        const relMassRate = r.dMass / node.fluid.mass;
        sumSq += relMassRate * relMassRate;
        count++;
      }
      // Relative energy rate
      if (Math.abs(node.fluid.internalEnergy) > 0) {
        const relEnergyRate = r.dEnergy / Math.abs(node.fluid.internalEnergy);
        sumSq += relEnergyRate * relEnergyRate;
        count++;
      }
    }
  }

  // Flow connections - track momentum (flow rate) changes
  for (const [id, r] of rates.flowConnections) {
    const conn = state.flowConnections.find(c => c.id === id);
    if (conn) {
      // Normalize by a reference flow rate (100 kg/s) to get relative scale
      // This captures how quickly flow is accelerating/decelerating
      const refFlowRate = Math.max(100, Math.abs(conn.massFlowRate));
      const relFlowRateChange = r.dMassFlowRate / refFlowRate;
      sumSq += relFlowRateChange * relFlowRateChange;
      count++;
    }
  }

  // Thermal nodes - use absolute temperature scale (relative to 1000K)
  for (const [id, r] of rates.thermalNodes) {
    const node = state.thermalNodes.get(id);
    if (node) {
      const relTempRate = r.dTemperature / 1000; // Normalize to 1000K scale
      sumSq += relTempRate * relTempRate;
      count++;
    }
  }

  // Neutronics - use nominal power as reference to avoid tiny timesteps at low power.
  // Point kinetics at low power with residual precursors can produce large error estimates
  // because the equations are stiff (positive eigenvalue from precursor source term).
  // Use 5% of nominal as minimum reference - errors below this level don't matter much.
  if (state.neutronics.nominalPower > 0) {
    const refPower = Math.max(state.neutronics.power, state.neutronics.nominalPower * 0.05);
    const relPowerRate = rates.neutronics.dPower / refPower;
    sumSq += relPowerRate * relPowerRate;
    count++;
  }
  if (state.neutronics.precursorConcentration > 0) {
    const relPrecRate = rates.neutronics.dPrecursorConcentration / state.neutronics.precursorConcentration;
    sumSq += relPrecRate * relPrecRate;
    count++;
  }

  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

/**
 * Compute per-component error contributions for debugging.
 * Returns the top N contributors to the total RK45 error.
 */
export function computeErrorContributors(rates: StateRates, state: SimulationState, topN: number = 3): ErrorContributor[] {
  const contributions: ErrorContributor[] = [];

  // Flow nodes - mass rate, energy rate, and density warnings
  // Note: Throughput (total flow through a node) is NOT included because balanced
  // high-throughput doesn't cause accuracy problems - only net mass imbalance does.
  for (const [id, r] of rates.flowNodes) {
    const node = state.flowNodes.get(id);
    if (node) {
      // Mass rate contribution (net flow imbalance)
      if (node.fluid.mass > 0) {
        const relMassRate = Math.abs(r.dMass / node.fluid.mass);
        // Use very low threshold - we want to show what's contributing even if small
        if (relMassRate > 1e-8) {
          const direction = r.dMass > 0 ? 'gaining' : 'losing';
          contributions.push({
            nodeId: id,
            type: 'mass',
            contribution: relMassRate,
            description: `${direction} ${Math.abs(r.dMass).toFixed(1)} kg/s`
          });
        }

        // Also check for dangerous density accumulation
        // This isn't an RK45 error term, but it's a critical warning
        // Water density should never exceed ~1100 kg/m³ (high pressure compressed liquid)
        const density = node.fluid.mass / node.volume;
        if (density > 950) {
          // Calculate how far above normal we are (950 kg/m³ is already compressed)
          // At 1100 it's dangerous, at 1500 we'll crash
          const dangerFactor = (density - 950) / (1500 - 950);
          if (dangerFactor > 0.1) {
            contributions.push({
              nodeId: id,
              type: 'mass',
              contribution: dangerFactor, // Will be normalized with others
              description: `⚠️ ρ=${density.toFixed(0)} kg/m³`
            });
          }
        }
      }

      // Energy rate contribution
      if (Math.abs(node.fluid.internalEnergy) > 0) {
        const relEnergyRate = Math.abs(r.dEnergy / node.fluid.internalEnergy);
        if (relEnergyRate > 1e-8) {
          const powerMW = r.dEnergy / 1e6;
          contributions.push({
            nodeId: id,
            type: 'energy',
            contribution: relEnergyRate,
            description: `${powerMW > 0 ? '+' : ''}${powerMW.toFixed(2)} MW`
          });
        }
      }
    }
  }

  // Flow connections - momentum (flow rate changes)
  for (const [id, r] of rates.flowConnections) {
    const conn = state.flowConnections.find(c => c.id === id);
    if (conn) {
      const refFlowRate = Math.max(100, Math.abs(conn.massFlowRate));
      const relFlowRateChange = Math.abs(r.dMassFlowRate / refFlowRate);
      if (relFlowRateChange > 1e-8) {
        // Extract node IDs from connection ID (format: "flow-fromId-toId")
        const fromNode = conn.fromNodeId;
        const toNode = conn.toNodeId;
        contributions.push({
          nodeId: `${fromNode}→${toNode}`,
          type: 'momentum',
          contribution: relFlowRateChange,
          description: `dṁ/dt=${r.dMassFlowRate.toFixed(1)} kg/s²`
        });
      }
    }
  }

  // Thermal nodes
  for (const [id, r] of rates.thermalNodes) {
    const relTempRate = Math.abs(r.dTemperature / 1000);
    if (relTempRate > 1e-8) {
      contributions.push({
        nodeId: id,
        type: 'temperature',
        contribution: relTempRate,
        description: `dT/dt=${r.dTemperature.toFixed(1)} K/s`
      });
    }
  }

  // Neutronics - use same reference power as computeRatesNorm for consistency
  if (state.neutronics.nominalPower > 0) {
    const refPower = Math.max(state.neutronics.power, state.neutronics.nominalPower * 0.05);
    const relPowerRate = Math.abs(rates.neutronics.dPower / refPower);
    if (relPowerRate > 1e-8) {
      // Note: rates.neutronics.dPower is the error in power RATE (W), not power itself.
      // It represents how much the 4th and 5th order solutions disagree on dP/dt.
      // The actual error in power per step is approximately dPower * dt.
      contributions.push({
        nodeId: 'neutronics',
        type: 'power',
        contribution: relPowerRate,
        description: `Δ(dP/dt)=${(rates.neutronics.dPower / 1e6).toFixed(1)} MW`
      });
    }
  }
  if (state.neutronics.precursorConcentration > 0) {
    const relPrecRate = Math.abs(rates.neutronics.dPrecursorConcentration / state.neutronics.precursorConcentration);
    if (relPrecRate > 1e-8) {
      contributions.push({
        nodeId: 'neutronics',
        type: 'precursor',
        contribution: relPrecRate,
        description: `precursor decay`
      });
    }
  }

  // Sort by contribution (highest first) and return top N
  contributions.sort((a, b) => b.contribution - a.contribution);

  // Normalize contributions to show relative importance
  const totalContribution = contributions.reduce((sum, c) => sum + c.contribution * c.contribution, 0);
  const totalNorm = Math.sqrt(totalContribution);

  return contributions.slice(0, topN).map(c => ({
    ...c,
    contribution: totalNorm > 0 ? (c.contribution * c.contribution) / totalContribution : 0
  }));
}

/**
 * Quick pre-constraint check for catastrophically bad states.
 * This runs BEFORE constraint operators to avoid crashing water properties.
 * Returns true if the state is safe enough to pass to constraint operators.
 */
export function checkPreConstraintSanity(state: SimulationState): { safe: boolean; reason?: string } {
  for (const [id, node] of state.flowNodes) {
    // Check for very low mass - would cause divide-by-zero or extreme specific volume
    if (node.fluid.mass < 0.1) {
      return { safe: false, reason: `${id}: Mass too low (${node.fluid.mass.toFixed(4)} kg)` };
    }

    // Check for non-finite values that would crash calculations
    if (!isFinite(node.fluid.mass) || !isFinite(node.fluid.internalEnergy)) {
      return { safe: false, reason: `${id}: Non-finite mass or energy` };
    }

    // Check for negative internal energy (impossible)
    if (node.fluid.internalEnergy < 0) {
      return { safe: false, reason: `${id}: Negative internal energy` };
    }

    // Check specific volume isn't astronomically high (indicates near-vacuum)
    // At 0.1 kg in 100 m³, v = 1,000,000 mL/kg which is far beyond any valid state
    const v_mLkg = (node.volume / node.fluid.mass) * 1e6; // m³/kg to mL/kg
    if (v_mLkg > 1e7) { // 10 million mL/kg is way beyond any physical state
      return { safe: false, reason: `${id}: Specific volume too high (${v_mLkg.toExponential(2)} mL/kg) - near vacuum` };
    }

    // Check specific volume isn't impossibly low (indicates mass accumulation bug)
    // Water at room temp: ~1000 mL/kg, compressed liquid minimum ~900 mL/kg
    // Anything below 800 mL/kg is physically impossible
    if (v_mLkg < 800) {
      const density = node.fluid.mass / node.volume;
      return { safe: false, reason: `${id}: Specific volume too low (${v_mLkg.toFixed(1)} mL/kg, ρ=${density.toFixed(0)} kg/m³) - mass accumulation` };
    }
  }
  return { safe: true };
}

/**
 * Check if a state has obviously bad physics that should cause step rejection.
 * Returns a score > 1 if the state is bad (larger = worse).
 */
export function checkStateSanity(oldState: SimulationState, newState: SimulationState, dt: number): number {
  let maxBadness = 0;

  // Build throughput map for new state
  const nodeThroughput = new Map<string, number>();
  for (const conn of newState.flowConnections) {
    const absFlow = Math.abs(conn.massFlowRate);
    nodeThroughput.set(conn.fromNodeId, (nodeThroughput.get(conn.fromNodeId) || 0) + absFlow);
    nodeThroughput.set(conn.toNodeId, (nodeThroughput.get(conn.toNodeId) || 0) + absFlow);
  }

  // Check each flow node for bad physics
  for (const [id, newNode] of newState.flowNodes) {
    const oldNode = oldState.flowNodes.get(id);
    if (!oldNode) continue;

    // Check for invalid pressure (below triple point ~611 Pa)
    if (!isFinite(newNode.fluid.pressure) || newNode.fluid.pressure < 600) {
      console.warn(`[RK45 Sanity] ${id}: Invalid pressure ${newNode.fluid.pressure}`);
      return 1000; // Definitely reject
    }

    // Check for large pressure change (more than 20% in one step)
    const pressureRatio = newNode.fluid.pressure / oldNode.fluid.pressure;
    if (pressureRatio > 1.2 || pressureRatio < 0.833) {
      // Scale badness: 20% change = badness 1, 50% change = badness ~4
      const badness = Math.abs(Math.log(pressureRatio)) / Math.log(1.2);
      maxBadness = Math.max(maxBadness, badness);
    }

    // Check for very low mass
    if (newNode.fluid.mass < 0.1) {
      console.warn(`[RK45 Sanity] ${id}: Mass too low ${newNode.fluid.mass}`);
      return 1000;
    }

    // Check for physically impossible density (mass accumulation bug)
    // Water density is ~1000 kg/m³, max ~1100 at high pressure
    // Anything above 1200 kg/m³ indicates runaway mass accumulation
    const density = newNode.fluid.mass / newNode.volume;
    if (density > 1200) {
      console.warn(`[RK45 Sanity] ${id}: Density ${density.toFixed(0)} kg/m³ exceeds physical limit`);
      return 1000; // Definitely reject
    }

    // Check for large mass change relative to node mass
    // If flow * dt > 20% of node mass, the timestep is probably too large
    const throughput = nodeThroughput.get(id) || 0;
    if (throughput > 0 && newNode.fluid.mass > 0) {
      const massMovedThisStep = throughput * 0.5 * dt; // 0.5 because we counted both ends
      const massFraction = massMovedThisStep / newNode.fluid.mass;
      if (massFraction > 0.2) {
        // More than 20% of mass moved in one step - too aggressive
        const badness = massFraction / 0.2; // 20% = 1, 40% = 2, etc.
        maxBadness = Math.max(maxBadness, badness);
      }
    }

    // Check for large net mass change (accumulation or depletion)
    // This catches cases where inflow >> outflow or vice versa
    const massChange = newNode.fluid.mass - oldNode.fluid.mass;
    const relMassChange = Math.abs(massChange) / Math.max(1, oldNode.fluid.mass);
    if (relMassChange > 0.5) {
      // More than 50% mass change in one step - suspicious
      const badness = relMassChange / 0.5;
      maxBadness = Math.max(maxBadness, badness);
    }

    // Check for invalid temperature (250K to 2500K covers most scenarios)
    if (!isFinite(newNode.fluid.temperature) ||
        newNode.fluid.temperature < 250 ||
        newNode.fluid.temperature > 2500) {
      console.warn(`[RK45 Sanity] ${id}: Invalid temperature ${newNode.fluid.temperature}`);
      return 1000;
    }
  }

  // Check flow connections for extreme accelerations
  for (const newConn of newState.flowConnections) {
    const oldConn = oldState.flowConnections.find(c => c.id === newConn.id);
    if (!oldConn) continue;

    // Check for flow reversal or huge change
    const flowChange = Math.abs(newConn.massFlowRate - oldConn.massFlowRate);
    const refFlow = Math.max(100, Math.abs(oldConn.massFlowRate), Math.abs(newConn.massFlowRate));
    const relChange = flowChange / refFlow;

    if (relChange > 1.0) {
      // Flow changed by more than 100% - suspicious
      maxBadness = Math.max(maxBadness, relChange);
    }
  }

  return maxBadness;
}

// ============================================================================
// RK45 Solver Configuration
// ============================================================================

export interface RK45Config {
  // Timestep bounds
  minDt: number;              // s - absolute minimum timestep
  maxDt: number;              // s - maximum timestep
  initialDt: number;          // s - initial timestep guess

  // Error tolerances
  relTol: number;             // Relative error tolerance (e.g., 1e-3)
  absTol: number;             // Absolute error tolerance (e.g., 1e-6)

  // Timestep control
  safetyFactor: number;       // Safety factor for dt adjustment (e.g., 0.9)
  minShrinkFactor: number;    // Never shrink dt by more than this (e.g., 0.1)
  maxGrowthFactor: number;    // Never grow dt by more than this (e.g., 5)

  // Performance limits
  maxStepsPerFrame: number;   // Maximum integration steps per frame
  maxWallTimeMs: number;      // Maximum wall time per advance() call

  // Semi-implicit pressure solver configuration
  // Set to false to disable (use pure explicit RK45 for all physics)
  pressureSolver?: Partial<PressureSolverConfig> | false;
}

const DEFAULT_RK45_CONFIG: RK45Config = {
  minDt: 1e-6,
  maxDt: 1.0,
  initialDt: 0.001,

  relTol: 1e-3,
  absTol: 1e-6,

  safetyFactor: 0.9,
  minShrinkFactor: 0.1,
  maxGrowthFactor: 5.0,

  maxStepsPerFrame: 1000,
  maxWallTimeMs: 100,
};

// ============================================================================
// Dormand-Prince (DOPRI5) Butcher Tableau
// ============================================================================

// DOPRI5 coefficients
const A = [
  [],
  [1/5],
  [3/40, 9/40],
  [44/45, -56/15, 32/9],
  [19372/6561, -25360/2187, 64448/6561, -212/729],
  [9017/3168, -355/33, 46732/5247, 49/176, -5103/18656],
  [35/384, 0, 500/1113, 125/192, -2187/6784, 11/84],
];

// 5th order solution weights
const B5 = [35/384, 0, 500/1113, 125/192, -2187/6784, 11/84, 0];

// 4th order solution weights (for error estimation)
const B4 = [5179/57600, 0, 7571/16695, 393/640, -92097/339200, 187/2100, 1/40];

// Error weights (B5 - B4)
const E = B5.map((b5, i) => b5 - B4[i]);

// ============================================================================
// RK45 Solver Class
// ============================================================================

export class RK45Solver {
  private rateOperators: RateOperator[] = [];
  private constraintOperators: ConstraintOperator[] = [];
  private config: RK45Config;
  private currentDt: number;

  // Semi-implicit pressure solver - runs BEFORE constraints to pre-condition flow rates
  private pressureSolver: PressureSolver | null = null;

  // Flag to dynamically enable/disable pressure solver at runtime
  public pressureSolverEnabled: boolean = false;  // Disabled by default

  // Metrics
  private totalSteps = 0;
  private rejectedSteps = 0;
  private operatorTimes = new Map<string, number>();

  // Rate limiting for log messages (wall time in ms)
  private lastWallTimeLimitLog = 0;

  // Optional callback invoked after each accepted substep (for state history recording)
  public onSubstepComplete?: (state: SimulationState, stepNumber: number) => void;

  constructor(config: Partial<RK45Config> = {}) {
    this.config = { ...DEFAULT_RK45_CONFIG, ...config };
    this.currentDt = this.config.initialDt;

    // Semi-implicit pressure solver for liquid compressibility
    // Runs BEFORE constraint operators to pre-condition flow rates
    if (config.pressureSolver !== false) {
      const pressureSolverConfig = typeof config.pressureSolver === 'object'
        ? { ...DEFAULT_PRESSURE_SOLVER_CONFIG, ...config.pressureSolver }
        : DEFAULT_PRESSURE_SOLVER_CONFIG;
      this.pressureSolver = new PressureSolver(pressureSolverConfig);
      this.operatorTimes.set('PressureSolver', 0);
    }
  }

  addRateOperator(op: RateOperator): void {
    this.rateOperators.push(op);
    this.operatorTimes.set(op.name, 0);
  }

  addConstraintOperator(op: ConstraintOperator): void {
    this.constraintOperators.push(op);
    this.operatorTimes.set(op.name, 0);
  }

  /**
   * Reset solver state (call when simulation is reset)
   */
  reset(): void {
    this.currentDt = this.config.initialDt;
    this.totalSteps = 0;
    this.rejectedSteps = 0;
    for (const name of this.operatorTimes.keys()) {
      this.operatorTimes.set(name, 0);
    }
  }

  /**
   * Get the status of the pressure solver
   */
  getPressureSolverStatus(): { enabled: boolean; status: ReturnType<PressureSolver['getLastStatus']> | null } {
    if (!this.pressureSolver) {
      return { enabled: false, status: null };
    }
    return {
      enabled: this.pressureSolverEnabled,
      status: this.pressureSolverEnabled ? this.pressureSolver.getLastStatus() : null,
    };
  }

  /**
   * Compute total rates from all rate operators
   *
   * IMPORTANT: We must apply constraints BEFORE computing rates to ensure
   * algebraic variables (flow rates, pressures) are consistent with the
   * current state. Otherwise intermediate RK stages use stale values.
   *
   * Returns null if the state is too bad to process (pre-constraint sanity failure).
   */
  private computeTotalRates(state: SimulationState): StateRates | null {
    // Quick sanity check before constraints to avoid crashing water properties
    const preCheck = checkPreConstraintSanity(state);
    if (!preCheck.safe) {
      console.warn(`[RK45 computeRates] Pre-constraint sanity failed: ${preCheck.reason}`);
      return null;
    }

    // First, ensure algebraic constraints are satisfied for this state
    // This updates flow rates based on current pressures, which is critical
    // for the DAE nature of this system
    let constrainedState = state;
    for (const op of this.constraintOperators) {
      constrainedState = op.applyConstraints(constrainedState);
    }

    // Now compute rates using the constrained state
    let totalRates = createZeroRates();

    for (const op of this.rateOperators) {
      const t0 = performance.now();
      const opRates = op.computeRates(constrainedState);
      this.operatorTimes.set(op.name, (this.operatorTimes.get(op.name) || 0) + (performance.now() - t0));
      totalRates = addRates(totalRates, opRates);
    }

    return totalRates;
  }

  /**
   * Apply all constraint operators
   */
  private applyAllConstraints(state: SimulationState): SimulationState {
    let result = state;

    // FIRST: Run semi-implicit pressure solver to pre-condition flow rates
    // This adjusts massFlowRate on connections to approximately satisfy mass
    // conservation at liquid nodes, BEFORE we compute pressures from steam tables.
    // This removes the acoustic timescale stiffness from compressed liquid.
    //
    // Note: The pressure solver does NOT modify node pressures - it only adjusts
    // flow rates. The actual pressures remain thermodynamically consistent as
    // computed by FluidStateConstraintOperator from (m, U, V).
    if (this.pressureSolver && this.pressureSolverEnabled) {
      const t0 = performance.now();
      this.pressureSolver.solve(result, this.currentDt);
      this.operatorTimes.set('PressureSolver', (this.operatorTimes.get('PressureSolver') || 0) + (performance.now() - t0));
    }

    // THEN: Apply standard constraint operators (thermodynamic consistency, etc.)
    for (const op of this.constraintOperators) {
      const t0 = performance.now();
      result = op.applyConstraints(result);
      this.operatorTimes.set(op.name, (this.operatorTimes.get(op.name) || 0) + (performance.now() - t0));
    }

    return result;
  }

  /**
   * Take a single RK45 step
   * Returns the new state, error estimate, and whether step was accepted
   */
  private step(state: SimulationState, dt: number): {
    newState: SimulationState;
    error: number;
    k: StateRates[];
    errorRates: StateRates;
  } {
    // Compute the 7 stages of DOPRI5
    const k: StateRates[] = [];

    // k1 = f(t, y)
    const k0 = this.computeTotalRates(state);
    if (k0 === null) {
      // Initial state is catastrophically bad - return failure
      return {
        newState: state,
        error: 1e10,
        k: [],
        errorRates: createZeroRates(),
      };
    }
    k[0] = k0;

    // k2 through k7
    for (let i = 1; i <= 6; i++) {
      // y_stage = y + dt * sum(A[i][j] * k[j])
      let stageRates = createZeroRates();
      for (let j = 0; j < i; j++) {
        stageRates = addRates(stageRates, scaleRates(k[j], A[i][j]));
      }
      const stageState = applyRatesToState(state, stageRates, dt);

      // Quick sanity check before constraints to avoid crashing water properties
      const preCheck = checkPreConstraintSanity(stageState);
      if (!preCheck.safe) {
        // Intermediate stage is catastrophically bad - return failure
        return {
          newState: state,
          error: 1e10,
          k,
          errorRates: createZeroRates(),
        };
      }

      // Apply constraints at intermediate stages for stability
      const constrainedStage = this.applyAllConstraints(stageState);

      // computeTotalRates also does sanity check but constrained state should be fine
      const ki = this.computeTotalRates(constrainedStage);
      if (ki === null) {
        // Constraint operators made state worse somehow - return failure
        return {
          newState: state,
          error: 1e10,
          k,
          errorRates: createZeroRates(),
        };
      }
      k[i] = ki;
    }

    // Compute 5th order solution: y5 = y + dt * sum(B5[i] * k[i])
    let solution5Rates = createZeroRates();
    for (let i = 0; i < 7; i++) {
      solution5Rates = addRates(solution5Rates, scaleRates(k[i], B5[i]));
    }
    const newState = applyRatesToState(state, solution5Rates, dt);

    // Sanity check final state before returning
    const finalCheck = checkPreConstraintSanity(newState);
    if (!finalCheck.safe) {
      // Final state is catastrophically bad
      console.warn(`[RK45] Final state sanity failed: ${finalCheck.reason}`);
      console.warn(`  dt=${(dt*1000).toFixed(4)}ms, state.time=${state.time.toFixed(4)}s`);
      // Log the rates that caused this
      for (const [id, r] of solution5Rates.flowNodes) {
        if (Math.abs(r.dMass) > 100) {
          console.warn(`  ${id}: dMass=${r.dMass.toFixed(1)} kg/s`);
        }
      }
      return {
        newState: state,
        error: 1e10,
        k,
        errorRates: solution5Rates,
      };
    }

    // Compute error estimate: err = dt * sum(E[i] * k[i])
    let errorRates = createZeroRates();
    for (let i = 0; i < 7; i++) {
      errorRates = addRates(errorRates, scaleRates(k[i], E[i]));
    }

    // Compute error norm
    const error = computeRatesNorm(errorRates, state) * dt;

    return { newState, error, k, errorRates };
  }

  /**
   * Compute optimal timestep from error estimate
   */
  private computeOptimalDt(error: number, dt: number): number {
    const tol = this.config.relTol; // Use relative tolerance

    if (error === 0) {
      return dt * this.config.maxGrowthFactor;
    }

    // Optimal dt factor: (tol / error)^(1/5) for 5th order method
    const factor = this.config.safetyFactor * Math.pow(tol / error, 0.2);

    // Clamp the factor
    const clampedFactor = Math.max(
      this.config.minShrinkFactor,
      Math.min(this.config.maxGrowthFactor, factor)
    );

    return Math.max(this.config.minDt, Math.min(this.config.maxDt, dt * clampedFactor));
  }

  /**
   * Advance the simulation by the requested time
   */
  advance(state: SimulationState, requestedDt: number): {
    state: SimulationState;
    metrics: SolverMetrics;
  } {
    const frameStart = performance.now();

    // Reset operator times for this frame
    for (const name of this.operatorTimes.keys()) {
      this.operatorTimes.set(name, 0);
    }

    let currentState = state;
    let remainingTime = requestedDt;
    let stepsThisFrame = 0;
    let rejectsThisFrame = 0;
    let minDtUsed = this.currentDt;
    let consecutiveRejectsAtMinDt = 0;
    const MAX_REJECTS_AT_MIN_DT = 50;
    let lastErrorRates: StateRates = createZeroRates();
    let lastAcceptedState: SimulationState = state;

    while (remainingTime > 1e-10) {
      // Check limits
      if (stepsThisFrame >= this.config.maxStepsPerFrame) {
        console.warn(`[RK45] Hit max steps per frame (${this.config.maxStepsPerFrame})`);
        break;
      }
      const now = performance.now();
      if (now - frameStart > this.config.maxWallTimeMs) {
        // Rate limit this warning to once per second
        if (now - this.lastWallTimeLimitLog > 1000) {
          console.warn(`[RK45] Hit wall time limit (${this.config.maxWallTimeMs}ms)`);
          this.lastWallTimeLimitLog = now;
        }
        break;
      }

      // Don't overshoot remaining time
      const stepDt = Math.min(this.currentDt, remainingTime);

      // Take a step
      const { newState, error, errorRates } = this.step(currentState, stepDt);

      // Quick sanity check BEFORE constraints to avoid crashing water properties
      const preCheck = checkPreConstraintSanity(newState);
      if (!preCheck.safe) {
        // Catastrophically bad state - reject immediately and shrink dt aggressively
        console.warn(`[RK45] Pre-constraint sanity failed: ${preCheck.reason}`);
        rejectsThisFrame++;
        this.rejectedSteps++;
        this.currentDt = Math.max(stepDt * 0.1, this.config.minDt);

        // Track consecutive rejects at minimum dt
        if (this.currentDt <= this.config.minDt * 1.01) {
          consecutiveRejectsAtMinDt++;
          if (consecutiveRejectsAtMinDt >= MAX_REJECTS_AT_MIN_DT) {
            throw new Error(
              `[RK45] Simulation stuck: ${consecutiveRejectsAtMinDt} consecutive step rejections at minimum dt. ` +
              `Pre-constraint sanity failed: ${preCheck.reason}. ` +
              `The physics is unstable and cannot be resolved by shrinking the timestep.`
            );
          }
        }
        continue;
      }

      // Apply constraints to get final state
      const constrainedState = this.applyAllConstraints(newState);

      // Check for obviously bad physics (in addition to RK45 error estimate)
      const sanityScore = checkStateSanity(currentState, constrainedState, stepDt);

      // Combine RK45 error with sanity check
      // Sanity score > 1 means something suspicious happened
      const effectiveError = Math.max(error, sanityScore * this.config.relTol);

      // Accept or reject based on combined error
      const tol = this.config.relTol;

      if (effectiveError <= tol || stepDt <= this.config.minDt) {
        // Accept step (possibly forced at minimum dt)
        if (stepDt <= this.config.minDt && effectiveError > tol) {
          // Forced acceptance at minimum dt with high error
          // This means we can't make the timestep small enough to get accurate results

          // Catastrophically high error means physics is completely broken
          // Don't continue with garbage - throw an error instead
          const CATASTROPHIC_ERROR = 1e6;
          if (effectiveError > CATASTROPHIC_ERROR) {
            throw new Error(
              `[RK45] Simulation unstable: error ${effectiveError.toExponential(2)} at minimum dt ` +
              `(${(stepDt * 1000).toFixed(3)}ms). The physics has diverged and cannot be recovered. ` +
              `This typically indicates a configuration problem or numerical instability.`
            );
          }

          // Log a warning but continue - the simulation may be unstable
          if (stepsThisFrame % 100 === 0) {
            console.warn(
              `[RK45] Force-accepting step at minimum dt (${(stepDt * 1000).toFixed(3)}ms) ` +
              `with high error (${effectiveError.toFixed(4)} > tol ${tol.toFixed(4)}). ` +
              `Simulation may be inaccurate.`
            );
          }
        }

        currentState = constrainedState;
        currentState.time += stepDt;
        remainingTime -= stepDt;
        stepsThisFrame++;
        this.totalSteps++;
        minDtUsed = Math.min(minDtUsed, stepDt);

        // Notify listener of accepted substep (for state history recording)
        this.onSubstepComplete?.(currentState, this.totalSteps);

        // Track error rates for contributor analysis (use the one that limited dt the most)
        lastErrorRates = errorRates;
        lastAcceptedState = constrainedState;

        // Reset consecutive reject counter on successful step
        consecutiveRejectsAtMinDt = 0;

        // Grow timestep for next step
        this.currentDt = this.computeOptimalDt(effectiveError, stepDt);
      } else {
        // Reject step - shrink timestep and retry
        rejectsThisFrame++;
        this.rejectedSteps++;

        if (sanityScore > 1) {
          // Sanity check failed - be more aggressive about shrinking
          this.currentDt = stepDt * 0.25;
          console.log(`[RK45] Sanity check failed (score=${sanityScore.toFixed(2)}), shrinking dt to ${(this.currentDt*1000).toFixed(3)}ms`);
        } else {
          this.currentDt = this.computeOptimalDt(effectiveError, stepDt);
        }

        // Don't let dt shrink below minimum
        this.currentDt = Math.max(this.currentDt, this.config.minDt);
      }
    }

    const frameTime = performance.now() - frameStart;

    // Compute top error contributors from the last accepted step
    const topErrorContributors = computeErrorContributors(lastErrorRates, lastAcceptedState, 3);

    // Build metrics
    const metrics: SolverMetrics = {
      currentDt: this.currentDt,
      actualDt: minDtUsed,
      maxStableDt: this.config.maxDt, // RK45 doesn't have stability limit in same way
      dtLimitedBy: 'RK45-error',
      stabilityLimitedBy: 'none',
      minDtUsed,
      subcycleCount: stepsThisFrame,
      totalSteps: this.totalSteps,
      lastStepWallTime: frameTime,
      avgStepWallTime: frameTime / Math.max(1, stepsThisFrame),
      retriesThisFrame: rejectsThisFrame,
      maxPressureChange: 0, // TODO: compute if needed
      maxFlowChange: 0,
      maxMassChange: 0,
      consecutiveSuccesses: stepsThisFrame - rejectsThisFrame,
      topErrorContributors,
      realTimeRatio: (requestedDt - remainingTime) / (frameTime / 1000),
      isFallingBehind: remainingTime > requestedDt * 0.1,
      fallingBehindSince: 0,
      operatorTimes: new Map(this.operatorTimes),
    };

    return { state: currentState, metrics };
  }

  /**
   * Take exactly one integration step (for debugging)
   */
  singleStep(state: SimulationState): {
    state: SimulationState;
    dt: number;
    error: number;
    metrics: SolverMetrics;
  } {
    const { newState, error, errorRates } = this.step(state, this.currentDt);

    // Quick sanity check BEFORE constraints to avoid crashing water properties
    const preCheck = checkPreConstraintSanity(newState);
    if (!preCheck.safe) {
      console.warn(`[RK45 singleStep] Pre-constraint sanity failed: ${preCheck.reason}`);
      // Return original state with error indicator
      this.rejectedSteps++;
      return {
        state,
        dt: this.currentDt,
        error: 1000, // Indicate failure
        metrics: {
          currentDt: this.currentDt,
          actualDt: 0,
          maxStableDt: this.config.maxDt,
          dtLimitedBy: 'pre-sanity-fail',
          stabilityLimitedBy: 'none',
          minDtUsed: this.currentDt,
          subcycleCount: 0,
          totalSteps: this.totalSteps,
          lastStepWallTime: 0,
          avgStepWallTime: 0,
          retriesThisFrame: 1,
          maxPressureChange: 0,
          maxFlowChange: 0,
          maxMassChange: 0,
          consecutiveSuccesses: 0,
          topErrorContributors: computeErrorContributors(errorRates, state, 3),
          realTimeRatio: 0,
          isFallingBehind: true,
          fallingBehindSince: 0,
          operatorTimes: new Map(),
        },
      };
    }

    const constrainedState = this.applyAllConstraints(newState);

    // Check sanity and log warning if needed
    const sanityScore = checkStateSanity(state, constrainedState, this.currentDt);
    if (sanityScore > 1) {
      console.warn(`[RK45 singleStep] Sanity check warning: score=${sanityScore.toFixed(2)}`);
    }

    constrainedState.time += this.currentDt;

    const effectiveError = Math.max(error, sanityScore * this.config.relTol);

    const metrics: SolverMetrics = {
      currentDt: this.currentDt,
      actualDt: this.currentDt,
      maxStableDt: this.config.maxDt,
      dtLimitedBy: 'RK45-error',
      stabilityLimitedBy: 'none',
      minDtUsed: this.currentDt,
      subcycleCount: 1,
      totalSteps: ++this.totalSteps,
      lastStepWallTime: 0,
      avgStepWallTime: 0,
      retriesThisFrame: 0,
      maxPressureChange: 0,
      maxFlowChange: 0,
      maxMassChange: 0,
      consecutiveSuccesses: 1,
      topErrorContributors: computeErrorContributors(errorRates, constrainedState, 3),
      realTimeRatio: 1,
      isFallingBehind: false,
      fallingBehindSince: 0,
      operatorTimes: new Map(this.operatorTimes),
    };

    // Adjust dt for next step based on combined error
    this.currentDt = this.computeOptimalDt(effectiveError, this.currentDt);

    // Notify listener of accepted substep (for state history recording)
    this.onSubstepComplete?.(constrainedState, this.totalSteps);

    return {
      state: constrainedState,
      dt: this.currentDt,
      error: effectiveError,
      metrics,
    };
  }

  getMetrics(): { totalSteps: number; rejectedSteps: number; currentDt: number } {
    return {
      totalSteps: this.totalSteps,
      rejectedSteps: this.rejectedSteps,
      currentDt: this.currentDt,
    };
  }
}
