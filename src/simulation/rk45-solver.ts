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

import { SimulationState, SolverMetrics, ErrorContributor, PressureSolverConfig, DEFAULT_PRESSURE_SOLVER_CONFIG, SANITY_PRESSURE_TOLERANCE, SANITY_PRESSURE_SCALE_FLOOR } from './types';
import { cloneSimulationState } from './solver';
import { PressureSolver } from './operators/pressure-solver';
import { type GasComposition, ALL_GAS_SPECIES, emptyGasComposition, totalMass as ncgTotalMass } from './gas-properties';

// ============================================================================
// State Rates - Derivatives for all state variables
// ============================================================================

export interface FlowNodeRates {
  dMass: number;      // kg/s - rate of mass change
  dEnergy: number;    // W - rate of internal energy change
  dNcg?: GasComposition;  // mol/s - rate of NCG moles change (optional, only if NCG present)
  dOtsgM1?: number;       // kg/s - OTSG subcooled-section mass rate (its partition state)
  dDepositedCsI?: number; // mol/s - CsI aerosol plating out onto this node's surfaces
}

export interface FlowConnectionRates {
  dMassFlowRate: number;  // kg/s² - rate of change of mass flow rate (momentum equation)
}

export interface ThermalNodeRates {
  dTemperature: number;  // K/s - rate of temperature change (for solids)
  dMass?: number;        // kg/s - mass relocation between solid nodes (corium)
  dOxidizedFraction?: number;  // 1/s - rate of cladding oxidation (for cladding nodes only)
  dGraphiteBurnoff?: number;   // 1/s - rate of graphite consumption by oxidation
  dFpNobleGas?: number;   // mol/s - fission-product noble gas leaving the fuel (negative)
  dFpVolatile?: number;   // mol/s - volatile fission products leaving the fuel (negative)
  dMetalZr?: number;      // kg/s - unoxidized Zr inventory change (corium/debris nodes)
  dMetalFe?: number;      // kg/s - unoxidized Fe inventory change (corium/debris nodes)
  dSlag?: number;         // kg/s - concrete-slag inventory change (MCCI debris)
}

export interface NeutronicsRates {
  dPower: number;                    // W/s - rate of power change
  dPrecursorConcentration: number;   // 1/s - rate of precursor change
  dDecayHeatPools?: number[];        // W/s - rate of change per decay-heat group
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
  // mol/s of NCG leaving the modeled system through boundary nodes
  // (accumulates into state.environmentalRelease - the radiological source term)
  environmentalRelease?: GasComposition;
}

// ============================================================================
// Operator Interfaces
// ============================================================================

export interface RateOperator {
  /** Human-readable name for profiling */
  name: string;

  /**
   * Marks the operator that produces explicit flow-momentum rates (dṁ/dt).
   * When the semi-implicit pressure solver owns the momentum update
   * (implicitMomentum mode), the solver skips operators with this flag -
   * connection flows are then set by the implicit solve during constraint
   * application instead of being integrated by RK45.
   */
  providesFlowMomentum?: boolean;

  /**
   * Compute the rates of change for this physics domain.
   * Does NOT modify the input state.
   */
  computeRates(state: SimulationState): StateRates;

  /**
   * Optional hard stability ceiling on the integration step for this
   * operator's stiffest mode. RK45's error controller catches modes whose
   * per-step error grows, but a mode sitting just outside the explicit
   * stability region (dt*lambda below about -3.3 on the real axis) diverges
   * slowly with SMALL per-step error - the controller accepts every step
   * while the mode drifts to nonsense (observed: the neutronics prompt-jump
   * relaxation, tau 50 ms, oscillating fission power negative at dt=0.2 s
   * and draining the decay-heat pools). Operators with such a mode must
   * declare it.
   */
  getMaxStableDt?(state: SimulationState): number;
}

export interface ConstraintOperator {
  /** Human-readable name for profiling */
  name: string;

  /**
   * Only apply this operator to end-of-step candidate states, not to
   * intermediate RK stages. NOTE: a "final" application still happens BEFORE
   * the accept/reject decision - the candidate can be discarded afterward.
   *
   * That makes this the wrong home for anything that CARRIES STATE ACROSS
   * STEPS. A controller here is stepped on candidates that are then thrown
   * away, so its integral is repeatedly rewound and its velocity-form
   * increment is measured against a lastError from a discarded branch: in a
   * plant rejecting most of its steps, the loop cannot accumulate at all.
   * Stateful samplers and anything with irreversible side effects belong in
   * postAcceptOnly. What is left for this flag is stateless per-step
   * derivation (display fields, steady-state bookkeeping).
   */
  finalOnly?: boolean;

  /**
   * Only apply this operator to states that have been ACCEPTED (passed the
   * error controller and the sanity check). Use for irreversible outcomes
   * (bursting a component): candidate states routinely overshoot into
   * transient garbage pressures before being rejected, and permanent
   * decisions must never be made from a state that is then discarded.
   */
  postAcceptOnly?: boolean;

  /**
   * Apply algebraic constraints to the state (e.g., thermodynamic consistency).
   * Returns a new state with constraints satisfied.
   *
   * @param dt - The timestep of the step this application belongs to.
   *   Provided by applyAllConstraints; sampled-control operators (the
   *   control system) use it, purely algebraic operators ignore it.
   */
  applyConstraints(state: SimulationState, dt?: number): SimulationState;

  /**
   * OPTIONAL in-place variant: the caller guarantees exclusive ownership of
   * `state` (a solver-private stage or candidate that nothing else holds a
   * reference to); the operator may mutate it and return it, skipping the
   * defensive clone that applyConstraints performs. Semantics MUST be
   * identical to applyConstraints - implement by extracting the body into a
   * shared impl and giving applyConstraints a clone-then-impl wrapper.
   *
   * Every state the RK45 solver passes into a constraint chain is the fresh
   * output of applyRatesToState (or the once-per-step pressure-solve clone),
   * so cloning again inside each chained constraint was pure overhead - it
   * was ~25% of total wall time on preset plants (full-state clones ran ~24x
   * per step: 3 per stage x 7 stages plus once-per-step users).
   */
  applyConstraintsMutating?(state: SimulationState, dt?: number): SimulationState;
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
    const combined: FlowNodeRates = {
      dMass: aRates.dMass + bRates.dMass,
      dEnergy: aRates.dEnergy + bRates.dEnergy,
    };
    // Combine NCG rates if either has them
    if (aRates.dOtsgM1 !== undefined || bRates.dOtsgM1 !== undefined) {
      combined.dOtsgM1 = (aRates.dOtsgM1 ?? 0) + (bRates.dOtsgM1 ?? 0);
    }
    if (aRates.dNcg || bRates.dNcg) {
      combined.dNcg = emptyGasComposition();
      for (const species of ALL_GAS_SPECIES) {
        combined.dNcg[species] = (aRates.dNcg?.[species] ?? 0) + (bRates.dNcg?.[species] ?? 0);
      }
    }
    if (aRates.dDepositedCsI !== undefined || bRates.dDepositedCsI !== undefined) {
      combined.dDepositedCsI = (aRates.dDepositedCsI ?? 0) + (bRates.dDepositedCsI ?? 0);
    }
    result.flowNodes.set(id, combined);
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
    const combined: ThermalNodeRates = {
      dTemperature: aRates.dTemperature + bRates.dTemperature,
    };
    if (aRates.dMass !== undefined || bRates.dMass !== undefined) {
      combined.dMass = (aRates.dMass ?? 0) + (bRates.dMass ?? 0);
    }
    // Combine oxidation rates if either has them
    if (aRates.dOxidizedFraction !== undefined || bRates.dOxidizedFraction !== undefined) {
      combined.dOxidizedFraction = (aRates.dOxidizedFraction ?? 0) + (bRates.dOxidizedFraction ?? 0);
    }
    if (aRates.dGraphiteBurnoff !== undefined || bRates.dGraphiteBurnoff !== undefined) {
      combined.dGraphiteBurnoff = (aRates.dGraphiteBurnoff ?? 0) + (bRates.dGraphiteBurnoff ?? 0);
    }
    // Combine fission-product release rates if either has them
    if (aRates.dFpNobleGas !== undefined || bRates.dFpNobleGas !== undefined) {
      combined.dFpNobleGas = (aRates.dFpNobleGas ?? 0) + (bRates.dFpNobleGas ?? 0);
    }
    if (aRates.dFpVolatile !== undefined || bRates.dFpVolatile !== undefined) {
      combined.dFpVolatile = (aRates.dFpVolatile ?? 0) + (bRates.dFpVolatile ?? 0);
    }
    if (aRates.dMetalZr !== undefined || bRates.dMetalZr !== undefined) {
      combined.dMetalZr = (aRates.dMetalZr ?? 0) + (bRates.dMetalZr ?? 0);
    }
    if (aRates.dMetalFe !== undefined || bRates.dMetalFe !== undefined) {
      combined.dMetalFe = (aRates.dMetalFe ?? 0) + (bRates.dMetalFe ?? 0);
    }
    if (aRates.dSlag !== undefined || bRates.dSlag !== undefined) {
      combined.dSlag = (aRates.dSlag ?? 0) + (bRates.dSlag ?? 0);
    }
    result.thermalNodes.set(id, combined);
  }

  // Combine neutronics rates
  result.neutronics = {
    dPower: a.neutronics.dPower + b.neutronics.dPower,
    dPrecursorConcentration: a.neutronics.dPrecursorConcentration + b.neutronics.dPrecursorConcentration,
  };
  if (a.neutronics.dDecayHeatPools || b.neutronics.dDecayHeatPools) {
    const aPools = a.neutronics.dDecayHeatPools ?? [];
    const bPools = b.neutronics.dDecayHeatPools ?? [];
    const n = Math.max(aPools.length, bPools.length);
    result.neutronics.dDecayHeatPools = Array.from(
      { length: n },
      (_, i) => (aPools[i] ?? 0) + (bPools[i] ?? 0)
    );
  }

  // Combine pump rates
  const allPumpIds = new Set([...a.pumps.keys(), ...b.pumps.keys()]);
  for (const id of allPumpIds) {
    const aRates = a.pumps.get(id) || { dEffectiveSpeed: 0 };
    const bRates = b.pumps.get(id) || { dEffectiveSpeed: 0 };
    result.pumps.set(id, {
      dEffectiveSpeed: aRates.dEffectiveSpeed + bRates.dEffectiveSpeed,
    });
  }

  // Combine environmental release rates
  if (a.environmentalRelease || b.environmentalRelease) {
    result.environmentalRelease = emptyGasComposition();
    for (const species of ALL_GAS_SPECIES) {
      result.environmentalRelease[species] =
        (a.environmentalRelease?.[species] ?? 0) + (b.environmentalRelease?.[species] ?? 0);
    }
  }

  return result;
}

/**
 * target += source * factor, IN PLACE.
 *
 * Arithmetically identical to `addRates(target, scaleRates(source, factor))`,
 * which is what every accumulation site used to call. That pair allocated two
 * complete StateRates - four Maps, an object per node, per connection and per
 * pump - plus three Sets for the key unions, and it did so ~140 times per
 * step (once per rate operator per stage, plus the Butcher-tableau sums). The
 * i-th entry was rebuilt (N-i) times on the way to the total. Accumulating in
 * place allocates each entry once and then adds into it: on the Xe-100 that
 * was ~9% of wall in addRates itself plus the GC it fed.
 *
 * The addition ORDER is unchanged - ((0 + k0*a) + k1*b) + ... - so results
 * stay bit-identical, which the replay-seek suite checks directly.
 *
 * `source` is only ever read, and nothing it owns is aliased into `target`:
 * the Butcher sums accumulate over the stage derivatives k[], which later
 * stages read again.
 */
export function accumulateRates(target: StateRates, source: StateRates, factor = 1): void {
  for (const [id, r] of source.flowNodes) {
    let t = target.flowNodes.get(id);
    if (!t) {
      t = { dMass: 0, dEnergy: 0 };
      target.flowNodes.set(id, t);
    }
    t.dMass += r.dMass * factor;
    t.dEnergy += r.dEnergy * factor;
    if (r.dOtsgM1 !== undefined) t.dOtsgM1 = (t.dOtsgM1 ?? 0) + r.dOtsgM1 * factor;
    if (r.dDepositedCsI !== undefined) {
      t.dDepositedCsI = (t.dDepositedCsI ?? 0) + r.dDepositedCsI * factor;
    }
    if (r.dNcg) {
      if (!t.dNcg) t.dNcg = emptyGasComposition();
      for (const species of ALL_GAS_SPECIES) {
        t.dNcg[species] += r.dNcg[species] * factor;
      }
    }
  }

  for (const [id, r] of source.flowConnections) {
    const t = target.flowConnections.get(id);
    if (t) t.dMassFlowRate += r.dMassFlowRate * factor;
    else target.flowConnections.set(id, { dMassFlowRate: r.dMassFlowRate * factor });
  }

  for (const [id, r] of source.thermalNodes) {
    let t = target.thermalNodes.get(id);
    if (!t) {
      t = { dTemperature: 0 };
      target.thermalNodes.set(id, t);
    }
    t.dTemperature += r.dTemperature * factor;
    if (r.dMass !== undefined) t.dMass = (t.dMass ?? 0) + r.dMass * factor;
    if (r.dOxidizedFraction !== undefined) {
      t.dOxidizedFraction = (t.dOxidizedFraction ?? 0) + r.dOxidizedFraction * factor;
    }
    if (r.dGraphiteBurnoff !== undefined) {
      t.dGraphiteBurnoff = (t.dGraphiteBurnoff ?? 0) + r.dGraphiteBurnoff * factor;
    }
    if (r.dFpNobleGas !== undefined) t.dFpNobleGas = (t.dFpNobleGas ?? 0) + r.dFpNobleGas * factor;
    if (r.dFpVolatile !== undefined) t.dFpVolatile = (t.dFpVolatile ?? 0) + r.dFpVolatile * factor;
    if (r.dMetalZr !== undefined) t.dMetalZr = (t.dMetalZr ?? 0) + r.dMetalZr * factor;
    if (r.dMetalFe !== undefined) t.dMetalFe = (t.dMetalFe ?? 0) + r.dMetalFe * factor;
    if (r.dSlag !== undefined) t.dSlag = (t.dSlag ?? 0) + r.dSlag * factor;
  }

  target.neutronics.dPower += source.neutronics.dPower * factor;
  target.neutronics.dPrecursorConcentration +=
    source.neutronics.dPrecursorConcentration * factor;
  if (source.neutronics.dDecayHeatPools) {
    const src = source.neutronics.dDecayHeatPools;
    let pools = target.neutronics.dDecayHeatPools;
    if (!pools) {
      pools = [];
      target.neutronics.dDecayHeatPools = pools;
    }
    for (let i = 0; i < src.length; i++) pools[i] = (pools[i] ?? 0) + src[i] * factor;
  }

  for (const [id, r] of source.pumps) {
    const t = target.pumps.get(id);
    if (t) t.dEffectiveSpeed += r.dEffectiveSpeed * factor;
    else target.pumps.set(id, { dEffectiveSpeed: r.dEffectiveSpeed * factor });
  }

  if (source.environmentalRelease) {
    if (!target.environmentalRelease) target.environmentalRelease = emptyGasComposition();
    for (const species of ALL_GAS_SPECIES) {
      target.environmentalRelease[species] +=
        (source.environmentalRelease[species] ?? 0) * factor;
    }
  }
}

export function scaleRates(rates: StateRates, factor: number): StateRates {
  const result = createZeroRates();

  for (const [id, r] of rates.flowNodes) {
    const scaled: FlowNodeRates = {
      dMass: r.dMass * factor,
      dEnergy: r.dEnergy * factor,
    };
    // Scale NCG rates if present
    if (r.dOtsgM1 !== undefined) scaled.dOtsgM1 = r.dOtsgM1 * factor;
    if (r.dNcg) {
      scaled.dNcg = emptyGasComposition();
      for (const species of ALL_GAS_SPECIES) {
        scaled.dNcg[species] = r.dNcg[species] * factor;
      }
    }
    if (r.dDepositedCsI !== undefined) {
      scaled.dDepositedCsI = r.dDepositedCsI * factor;
    }
    result.flowNodes.set(id, scaled);
  }

  for (const [id, r] of rates.flowConnections) {
    result.flowConnections.set(id, {
      dMassFlowRate: r.dMassFlowRate * factor,
    });
  }

  for (const [id, r] of rates.thermalNodes) {
    const scaled: ThermalNodeRates = {
      dTemperature: r.dTemperature * factor,
    };
    if (r.dMass !== undefined) {
      scaled.dMass = r.dMass * factor;
    }
    // Scale oxidation rate if present
    if (r.dOxidizedFraction !== undefined) {
      scaled.dOxidizedFraction = r.dOxidizedFraction * factor;
    }
    if (r.dGraphiteBurnoff !== undefined) {
      scaled.dGraphiteBurnoff = r.dGraphiteBurnoff * factor;
    }
    if (r.dFpNobleGas !== undefined) {
      scaled.dFpNobleGas = r.dFpNobleGas * factor;
    }
    if (r.dFpVolatile !== undefined) {
      scaled.dFpVolatile = r.dFpVolatile * factor;
    }
    if (r.dMetalZr !== undefined) {
      scaled.dMetalZr = r.dMetalZr * factor;
    }
    if (r.dMetalFe !== undefined) {
      scaled.dMetalFe = r.dMetalFe * factor;
    }
    if (r.dSlag !== undefined) {
      scaled.dSlag = r.dSlag * factor;
    }
    result.thermalNodes.set(id, scaled);
  }

  result.neutronics = {
    dPower: rates.neutronics.dPower * factor,
    dPrecursorConcentration: rates.neutronics.dPrecursorConcentration * factor,
  };
  if (rates.neutronics.dDecayHeatPools) {
    result.neutronics.dDecayHeatPools = rates.neutronics.dDecayHeatPools.map(r => r * factor);
  }

  for (const [id, r] of rates.pumps) {
    result.pumps.set(id, {
      dEffectiveSpeed: r.dEffectiveSpeed * factor,
    });
  }

  if (rates.environmentalRelease) {
    result.environmentalRelease = emptyGasComposition();
    for (const species of ALL_GAS_SPECIES) {
      result.environmentalRelease[species] = (rates.environmentalRelease[species] ?? 0) * factor;
    }
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
      // Skip boundary nodes - their state is fixed
      if (node.isBoundary) continue;

      node.fluid.mass += nodeRates.dMass * dt;
      // Water export is proportional to the donor's water content, so the
      // true solution decays exponentially and never crosses zero - but the
      // stage arithmetic of an explicit method can land a hair below.
      // Rounding-scale negatives snap to exactly zero (approved: this is
      // integration noise, not physics - the microgram bound is far below
      // any node's meaningful inventory). Larger negatives are left in
      // place: FluidState evaluates them as a dry gas node so the ERROR
      // CONTROLLER can judge the step, and checkStateSanity rejects any
      // CANDIDATE still owing more than rounding scale - loudly.
      if (node.fluid.mass < 0 && node.fluid.mass > -WATER_MASS_ROUNDOFF) {
        node.fluid.mass = 0;
      }
      node.fluid.internalEnergy += nodeRates.dEnergy * dt;

      // OTSG partition: the subcooled section's mass lives inside the
      // node's ordinary conserved totals, so moving it can never create or
      // lose anything - it only moves the internal boundary. The floor
      // absorbs float residue (the rate is constructed to vanish as the
      // section empties); the ceiling is the physical statement that one
      // section cannot hold more water than the whole node does.
      if (node.otsg && nodeRates.dOtsgM1 !== undefined) {
        node.otsg.m1 = Math.min(
          Math.max(0, node.fluid.mass),
          Math.max(0, node.otsg.m1 + nodeRates.dOtsgM1 * dt),
        );
      }

      if (nodeRates.dNcg) {
        // Initialize NCG on node if not present
        if (!node.fluid.ncg) {
          node.fluid.ncg = emptyGasComposition();
        }

        // Get original NCG to enforce conservation
        const originalNode = state.flowNodes.get(id);
        const originalNcg = originalNode?.fluid.ncg;

        // Apply rate for each gas species
        for (const species of ALL_GAS_SPECIES) {
          // Clamp removal rate to not exceed what's in the ORIGINAL state
          // This prevents RK45 intermediate stages from computing removal rates
          // based on NCG that was only temporarily deposited during the step
          let effectiveRate = nodeRates.dNcg[species];
          if (effectiveRate < 0 && originalNcg) {
            const originalAmount = originalNcg[species] ?? 0;
            const maxRemovalRate = originalAmount / dt;
            effectiveRate = Math.max(effectiveRate, -maxRemovalRate);
          }

          node.fluid.ncg[species] += effectiveRate * dt;

          // Clamp tiny negative values from floating point error
          if (node.fluid.ncg[species] < 0) {
            node.fluid.ncg[species] = 0;
          }
        }
      }

      // Accumulate plated-out CsI (its removal from the gas is in dNcg)
      if (nodeRates.dDepositedCsI !== undefined) {
        node.depositedCsI = Math.max(0, (node.depositedCsI ?? 0) + nodeRates.dDepositedCsI * dt);
      }
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
      // Mass relocation between solid nodes (corium): rates are proportional
      // to remaining mass, so this stays positive at any stable dt
      if (nodeRates.dMass !== undefined) {
        node.mass += nodeRates.dMass * dt;
      }
      // Apply oxidation rate if present
      if (nodeRates.dOxidizedFraction !== undefined && node.oxidation) {
        node.oxidation.oxidizedFraction += nodeRates.dOxidizedFraction * dt;
        // Clamp to [0, 1]
        node.oxidation.oxidizedFraction = Math.max(0, Math.min(1, node.oxidation.oxidizedFraction));
      }
      // Graphite burn-off. The rate is proportional to the remaining
      // internal surface, which goes to zero as burnoff -> 1, so 1 is an
      // asymptotically approached fixed point rather than a wall the
      // integrator can hit. The bound below only absorbs the float residue
      // of a step that lands exactly on it - without it, log(1 - burnoff)
      // in the random pore model would go to -Infinity.
      if (nodeRates.dGraphiteBurnoff !== undefined && node.graphiteOxidation) {
        const g = node.graphiteOxidation;
        g.burnoff = Math.max(0, Math.min(1, g.burnoff + nodeRates.dGraphiteBurnoff * dt));
        // Node mass follows burn-off exactly - carbon that left as CO/CO2
        // is no longer there to hold heat.
        node.mass = g.initialCarbonMass * (1 - g.burnoff);
      }
      // Apply fission-product release (inventory can only fall, floor at 0)
      if (node.fissionProducts) {
        if (nodeRates.dFpNobleGas !== undefined) {
          node.fissionProducts.nobleGas =
            Math.max(0, node.fissionProducts.nobleGas + nodeRates.dFpNobleGas * dt);
        }
        if (nodeRates.dFpVolatile !== undefined) {
          node.fissionProducts.volatile =
            Math.max(0, node.fissionProducts.volatile + nodeRates.dFpVolatile * dt);
        }
      }
      // Corium composition inventories: sources are relocation flows
      // (proportional to remaining source mass) and MCCI consumption
      // (proportional to remaining inventory), so like node.mass these
      // stay non-negative at any stable dt; the floor only absorbs
      // floating-point residue.
      if (nodeRates.dMetalZr !== undefined || nodeRates.dMetalFe !== undefined) {
        if (!node.metal) node.metal = { zr: 0, fe: 0 };
        node.metal.zr = Math.max(0, node.metal.zr + (nodeRates.dMetalZr ?? 0) * dt);
        node.metal.fe = Math.max(0, node.metal.fe + (nodeRates.dMetalFe ?? 0) * dt);
      }
      if (nodeRates.dSlag !== undefined) {
        node.slagMass = Math.max(0, (node.slagMass ?? 0) + nodeRates.dSlag * dt);
      }
    }
  }

  // Accumulate NCG vented through boundary nodes (radiological source term)
  if (rates.environmentalRelease) {
    if (!newState.environmentalRelease) {
      newState.environmentalRelease = emptyGasComposition();
    }
    for (const species of ALL_GAS_SPECIES) {
      newState.environmentalRelease[species] = (newState.environmentalRelease[species] ?? 0) +
        (rates.environmentalRelease[species] ?? 0) * dt;
    }
  }

  // Apply neutronics rates
  newState.neutronics.power += rates.neutronics.dPower * dt;
  newState.neutronics.precursorConcentration += rates.neutronics.dPrecursorConcentration * dt;
  if (rates.neutronics.dDecayHeatPools) {
    const pools = newState.neutronics.decayHeatPools ?? [];
    rates.neutronics.dDecayHeatPools.forEach((r, i) => {
      pools[i] = (pools[i] ?? 0) + r * dt;
    });
    newState.neutronics.decayHeatPools = pools;
  }

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
 * Locate the first non-finite entry in a rates structure, for diagnosis when
 * the error norm comes out NaN/Inf. Fail-loudly support: a NaN rate always
 * has a specific physical source and should be named, not swallowed.
 */
export function findNonFiniteRate(rates: StateRates): string {
  for (const [id, r] of rates.flowNodes) {
    if (!isFinite(r.dMass)) return `${id}.dMass=${r.dMass}`;
    if (!isFinite(r.dEnergy)) return `${id}.dEnergy=${r.dEnergy}`;
    if (r.dNcg) {
      for (const species of ALL_GAS_SPECIES) {
        if (!isFinite(r.dNcg[species])) return `${id}.dNcg.${species}=${r.dNcg[species]}`;
      }
    }
  }
  for (const [id, r] of rates.flowConnections) {
    if (!isFinite(r.dMassFlowRate)) return `${id}.dMassFlowRate=${r.dMassFlowRate}`;
  }
  for (const [id, r] of rates.thermalNodes) {
    if (!isFinite(r.dTemperature)) return `${id}.dTemperature=${r.dTemperature}`;
  }
  if (!isFinite(rates.neutronics.dPower)) return `neutronics.dPower=${rates.neutronics.dPower}`;
  if (!isFinite(rates.neutronics.dPrecursorConcentration)) return 'neutronics.dPrecursorConcentration';
  if (rates.neutronics.dDecayHeatPools) {
    for (let i = 0; i < rates.neutronics.dDecayHeatPools.length; i++) {
      if (!isFinite(rates.neutronics.dDecayHeatPools[i])) {
        return `neutronics.dDecayHeatPools[${i}]=${rates.neutronics.dDecayHeatPools[i]}`;
      }
    }
  }
  for (const [id, r] of rates.pumps) {
    if (!isFinite(r.dEffectiveSpeed)) return `pump ${id}.dEffectiveSpeed=${r.dEffectiveSpeed}`;
  }
  return 'no non-finite rate found (check state normalization denominators)';
}

// Rate limiter for the NaN-rate diagnostic log (wall-clock ms)
let lastRatesNormNaNLog = 0;
let lastStageRefusalLog = 0;

// Rounding-scale bound for water inventory: stage arithmetic on a
// proportionally-decaying export can land a hair below zero; a microgram is
// integration noise on any node this simulation models, while anything
// beyond it in an ACCEPTED candidate is genuine overdraw (rejected loudly
// in checkStateSanity).
const WATER_MASS_ROUNDOFF = 1e-6; // kg

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
      // OTSG partition: the economizer's mass is integrated state like any
      // other, and until it was in here the step size was chosen without ever
      // asking how fast the phase boundary was moving. Measured against the
      // NODE's mass: a kilogram misplaced matters the same wherever it
      // lands, and the denominator cannot vanish as the section dies.
      if (r.dOtsgM1 !== undefined && node.fluid.mass > 0) {
        const relM1Rate = r.dOtsgM1 / node.fluid.mass;
        sumSq += relM1Rate * relM1Rate;
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

  if (!isFinite(sumSq)) {
    const now = performance.now();
    if (now - lastRatesNormNaNLog > 1000) {
      console.warn(`[RK45] Non-finite rate in error norm: ${findNonFiniteRate(rates)}`);
      lastRatesNormNaNLog = now;
    }
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

      // OTSG phase boundary (see computeRatesNorm) - named separately so a
      // step limited by a sprinting economizer says so
      if (r.dOtsgM1 !== undefined && node.fluid.mass > 0) {
        const relM1Rate = Math.abs(r.dOtsgM1 / node.fluid.mass);
        if (relM1Rate > 1e-8) {
          contributions.push({
            nodeId: id,
            type: 'mass',
            contribution: relM1Rate,
            description: `economizer ${r.dOtsgM1 > 0 ? '+' : ''}${r.dOtsgM1.toFixed(2)} kg/s`
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
  // Neutronics overflow (e.g. an unquenched prompt-critical excursion) must
  // be rejected before it poisons the state - a NaN/Inf power propagates into
  // heat generation and every error norm afterwards.
  if (!isFinite(state.neutronics.power) || !isFinite(state.neutronics.precursorConcentration)) {
    return {
      safe: false,
      reason: `neutronics: non-finite power (${state.neutronics.power}) or precursors (${state.neutronics.precursorConcentration})`,
    };
  }

  for (const [id, node] of state.flowNodes) {
    // Skip boundary nodes - their state is fixed and may not follow normal physics
    if (node.isBoundary) continue;

    // Check for very low TOTAL inventory (water + NCG) - would cause
    // divide-by-zero or extreme specific volume. A helium-filled node
    // legitimately carries ~zero water; its gas mass is what matters.
    const gasMass = node.fluid.ncg ? ncgTotalMass(node.fluid.ncg) : 0;
    if (node.fluid.mass + gasMass < 0.1) {
      return { safe: false, reason: `${id}: Mass too low (${node.fluid.mass.toFixed(4)} kg water + ${gasMass.toFixed(4)} kg gas)` };
    }

    // Check for non-finite values that would crash calculations
    if (!isFinite(node.fluid.mass) || !isFinite(node.fluid.internalEnergy)) {
      return { safe: false, reason: `${id}: Non-finite mass or energy` };
    }

    // Check for negative internal energy (impossible)
    if (node.fluid.internalEnergy < 0) {
      return { safe: false, reason: `${id}: Negative internal energy` };
    }

    // Check specific volume isn't astronomically high (indicates near-vacuum
    // divergence). The threshold must sit well ABOVE physically reachable
    // states: saturated vapor at the triple point is 206 m³/kg (2.06e8 mL/kg)
    // and a steam node blowing down to condenser vacuum routinely passes
    // 10-40 m³/kg - the low-density ideal-gas path resolves those fine.
    // For nodes with NCG (like buildings with air), use total mass (steam + NCG)
    const ncgMass = node.fluid.ncg ? ncgTotalMass(node.fluid.ncg) : 0;
    const totalMass = node.fluid.mass + ncgMass;
    const v_mLkg = (node.volume / totalMass) * 1e6; // m³/kg to mL/kg
    if (v_mLkg > 1e9) { // 1000 m³/kg - far beyond the triple-point vapor line
      return { safe: false, reason: `${id}: Specific volume too high (${v_mLkg.toExponential(2)} mL/kg) - near vacuum` };
    }

    // Check specific volume isn't impossibly low (indicates mass accumulation bug)
    // Water at room temp: ~1000 mL/kg, compressed liquid minimum ~900 mL/kg
    // Anything below 800 mL/kg is physically impossible
    // Skip this check for vapor-dominated nodes with NCG (gas density is much lower than liquid)
    if (v_mLkg < 800 && node.fluid.phase !== 'vapor') {
      const density = totalMass / node.volume;
      return { safe: false, reason: `${id}: Specific volume too low (${v_mLkg.toFixed(1)} mL/kg, ρ=${density.toFixed(0)} kg/m³) - mass accumulation` };
    }
  }
  return { safe: true };
}

/**
 * Check if a state has obviously bad physics that should cause step rejection.
 * Returns a score > 1 if the state is bad (larger = worse).
 */
// Tracks which node/check drove the most recent checkStateSanity() rejection,
// for diagnostics - the aggregate score alone doesn't say what actually happened.
export let lastSanityFailureReason = '';

export function checkStateSanity(
  oldState: SimulationState,
  newState: SimulationState,
  dt: number,
  implicitFlows = false,
  quietPressureToleranceScale = 1
): number {
  let maxBadness = 0;

  // Build throughput map for new state. Connections whose transport the
  // nearly-implicit advection pass applied are exempt - their donor-cell
  // update is unconditionally stable, so their throughput is not a per-step
  // accuracy hazard and must not bind dt (that exemption is the entire
  // payoff of the implicit scheme).
  const nodeThroughput = new Map<string, number>();
  for (const conn of newState.flowConnections) {
    if (conn.implicitAdvection) continue;
    const absFlow = Math.abs(conn.massFlowRate);
    nodeThroughput.set(conn.fromNodeId, (nodeThroughput.get(conn.fromNodeId) || 0) + absFlow);
    nodeThroughput.set(conn.toNodeId, (nodeThroughput.get(conn.toNodeId) || 0) + absFlow);
  }

  // Check each flow node for bad physics
  for (const [id, newNode] of newState.flowNodes) {
    // Skip boundary nodes - their state is fixed
    if (newNode.isBoundary) continue;

    const oldNode = oldState.flowNodes.get(id);
    if (!oldNode) continue;

    // Check for invalid pressure (below triple point ~611 Pa)
    if (!isFinite(newNode.fluid.pressure) || newNode.fluid.pressure < 600) {
      console.warn(`[RK45 Sanity] ${id}: Invalid pressure ${newNode.fluid.pressure}`);
      return 1000; // Definitely reject
    }

    // Negative water inventory beyond rounding scale: the step genuinely
    // overdrew the node (rounding-scale negatives were already snapped to
    // zero in applyRatesToState). Reject loudly - this must stay visible.
    if (newNode.fluid.mass < -WATER_MASS_ROUNDOFF) {
      console.warn(`[RK45 Sanity] ${id}: negative water mass ${newNode.fluid.mass.toExponential(2)} kg (overdraw)`);
      return 1000;
    }

    // Check for large pressure change (more than 20% in one step).
    // The change is measured against max(P_old, 2 bar): what destabilizes the
    // flow network is a pressure jump comparable to the driving pressures (~bar
    // scale), not relative noise at near-vacuum. Without the floor, a node
    // sitting at condenser vacuum (~7 kPa) rejects steps over ~1.5 kPa of
    // saturation-line jitter and grinds the whole simulation to sub-ms steps.
    // The floor must also admit the ~0.5 bar/step swings of small liquid nodes
    // ringing at the saturation boundary (cavitation surge): the semi-implicit
    // pressure solver damps that mode with strength ~(w*dt)^2, so rejecting the
    // larger steps traps the simulation on the wrong side of the stiffness
    // crossover and the ringing never decays. Sub-bar accuracy at low pressure
    // is still protected by the RK45 embedded error estimate.
    //
    // This guard stays active under the implicit momentum solve too: the
    // implicit scheme is unconditionally stable for the LINEARIZED
    // pressure-flow pair, but the linearization itself (compliance from the
    // local bulk modulus, conductance at the predicted flow) is only valid for
    // moderate pressure excursions. Steps that cross the saturation-dome edge
    // or swing a stiff liquid node by more than the driving-pressure scale
    // must still be resolved by shrinking dt, or the step-scale cavitation
    // slosh diverges.
    // Check for very low TOTAL inventory (water + NCG - a helium-filled
    // node legitimately carries ~zero water). Computed before the pressure
    // guard because the quiet-node relaxation below needs the inventory.
    const newGasMass = newNode.fluid.ncg ? ncgTotalMass(newNode.fluid.ncg) : 0;
    const newTotalMass = newNode.fluid.mass + newGasMass;
    if (newTotalMass < 0.1) {
      console.warn(`[RK45 Sanity] ${id}: Mass too low ${newNode.fluid.mass} water + ${newGasMass} gas`);
      return 1000;
    }

    {
      const pScale = Math.max(oldNode.fluid.pressure, SANITY_PRESSURE_SCALE_FLOOR);
      const pChange = Math.abs(newNode.fluid.pressure - oldNode.fluid.pressure) / pScale;

      // QUIET-NODE RELAXATION: what makes a large per-step pressure swing
      // dangerous is its transport consequence - advection integrated against
      // a badly wrong pressure moves the wrong mass into neighbors. A node
      // whose throughput moves almost none of its inventory this step (a
      // stagnant dead leg ringing acoustically: huge dP, tiny flows against
      // tiny compliance) has no such consequence, and the semi-implicit
      // pressure solve damps that mode with strength ~(w*dt)^2 - it needs the
      // LARGE steps this guard would otherwise reject. Rejecting them traps
      // dt on the wrong side of the stiffness crossover and the ringing never
      // decays (observed: 2/3 of all steps rejected on tripped-feedtrain
      // valve/pump bodies). Bounded relaxation, never across a phase change:
      // the implicit solve's linearization is only trusted for excursions
      // that stay on one side of the dome.
      const throughputHere = nodeThroughput.get(id) || 0;
      const inventoryFractionMoved = (throughputHere * 0.5 * dt) / newTotalMass;
      const quiet = inventoryFractionMoved < 0.01 &&
        oldNode.fluid.phase === newNode.fluid.phase;
      const pTol = SANITY_PRESSURE_TOLERANCE * (quiet ? Math.max(1, quietPressureToleranceScale) : 1);

      if (pChange > pTol) {
        // Scale badness: tolerance = badness 1, 2x tolerance = 2, etc.
        const badness = pChange / pTol;
        if (badness > maxBadness) lastSanityFailureReason = `${id}: pressure change ${(pChange * 100).toFixed(0)}% of scale (${oldNode.fluid.pressure.toFixed(0)}->${newNode.fluid.pressure.toFixed(0)} Pa)${quiet ? ' [quiet]' : ''}`;
        maxBadness = Math.max(maxBadness, badness);
      }
    }

    // Check for physically impossible density (mass accumulation bug)
    // Water density is ~1000 kg/m³, max ~1100 at high pressure
    // Anything above 1200 kg/m³ indicates runaway mass accumulation
    const density = newNode.fluid.mass / newNode.volume;
    if (density > 1200) {
      console.warn(`[RK45 Sanity] ${id}: Density ${density.toFixed(0)} kg/m³ exceeds physical limit`);
      return 1000; // Definitely reject
    }

    // Check for large mass change relative to node inventory (water + NCG)
    // If flow * dt > 20% of node mass, the timestep is probably too large
    const throughput = nodeThroughput.get(id) || 0;
    if (throughput > 0 && newTotalMass > 0) {
      const massMovedThisStep = throughput * 0.5 * dt; // 0.5 because we counted both ends
      const massFraction = massMovedThisStep / newTotalMass;
      if (massFraction > 0.2) {
        // More than 20% of mass moved in one step - too aggressive
        const badness = massFraction / 0.2; // 20% = 1, 40% = 2, etc.
        if (badness > maxBadness) lastSanityFailureReason = `${id}: massFraction=${(massFraction*100).toFixed(1)}% throughput=${throughput.toFixed(2)}kg/s mass=${newTotalMass.toFixed(2)}kg`;
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
      if (badness > maxBadness) lastSanityFailureReason = `${id}: relMassChange=${(relMassChange*100).toFixed(1)}% (${oldNode.fluid.mass.toFixed(2)}->${newNode.fluid.mass.toFixed(2)}kg)`;
      maxBadness = Math.max(maxBadness, badness);
    }

    // Check for specific energy below physically possible minimum
    // This catches energy depletion faster than mass depletion (enthalpy mismatch)
    // For water: minimum u at any specific volume is on the saturation dome boundary
    // At the triple point (v_g = 206 m³/kg): u ranges from 0 (liquid) to ~2375 kJ/kg (vapor)
    // For v > v_f, estimate quality x = (v - v_f) / (v_g - v_f), then u_min = x * u_g_triple
    const v_specific = newNode.volume / newNode.fluid.mass; // m³/kg
    const u_specific = newNode.fluid.internalEnergy / newNode.fluid.mass; // J/kg

    // Only check for vapor-like densities (v > 0.01 m³/kg = 10 L/kg)
    // Liquid water has v ≈ 0.001 m³/kg, so anything > 0.01 should have significant vapor energy
    if (v_specific > 0.01) {
      const V_F_TRIPLE = 0.001;    // m³/kg - saturated liquid at triple point
      const V_G_TRIPLE = 206;      // m³/kg - saturated vapor at triple point
      const U_G_TRIPLE = 2375000;  // J/kg - saturated vapor internal energy at triple point

      // Estimate quality at triple point for this specific volume
      const x_est = Math.min(1, Math.max(0, (v_specific - V_F_TRIPLE) / (V_G_TRIPLE - V_F_TRIPLE)));

      // Minimum u at this v (on the saturation dome at triple point temperature)
      const u_min = x_est * U_G_TRIPLE;

      if (u_specific < u_min * 0.9) {  // Allow 10% margin for numerical error
        const deficit = (u_min - u_specific) / u_min;
        console.warn(`[RK45 Sanity] ${id}: Energy too low for vapor density. ` +
          `u=${(u_specific/1e3).toFixed(1)} kJ/kg < u_min=${(u_min/1e3).toFixed(1)} kJ/kg ` +
          `(v=${(v_specific*1e3).toFixed(1)} L/kg, x_est=${(x_est*100).toFixed(1)}%)`);
        // Scale badness based on how far below minimum we are
        const badness = 1 + deficit * 10;  // 10% below = badness 2, 50% below = badness 6
        maxBadness = Math.max(maxBadness, badness);
      }
    }

    // Check for invalid temperature. The ceiling must admit severe-accident
    // states (steam in contact with molten fuel can approach fuel temperature,
    // ~3400K) - it exists to catch NaN/divergence, not physical extremes.
    if (!isFinite(newNode.fluid.temperature) ||
        newNode.fluid.temperature < 250 ||
        newNode.fluid.temperature > 5000) {
      console.warn(`[RK45 Sanity] ${id}: Invalid temperature ${newNode.fluid.temperature}`);
      return 1000;
    }
  }

  // Check flow connections for extreme accelerations. Skipped when the
  // implicit pressure-flow solve owns momentum: a backward-Euler solve
  // legitimately jumps flows straight to their new equilibrium in one step
  // (valve opening, pump start) - that is the point of the implicit scheme,
  // not an integration overshoot. Mass/pressure consequences of those jumps
  // are still guarded by the node checks above.
  if (!implicitFlows) {
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

  // Deterministic mode: disable wall time and step limits for reproducible results
  // When true, the solver will complete all steps regardless of wall time
  deterministicMode?: boolean;

  // Semi-implicit pressure solver configuration
  // Set to false to disable (use pure explicit RK45 for all physics)
  pressureSolver?: Partial<PressureSolverConfig> | false;

  // Quiet-node relaxation of the sanity check's per-step pressure-change
  // guard (see checkStateSanity): nodes moving <1% of their inventory this
  // step get their 20% tolerance scaled by this factor. 1 disables (strict
  // guard everywhere - the DEFAULT).
  //
  // EXPERIMENT RESULT (2026-07-07, the third falsified guard relaxation):
  // scale 4 looked excellent short-term (+30% speed, trajectories matching
  // strict to ~0.005% at 60 s) but over 1200 s the admitted 20-80%
  // same-phase swings on dead-leg nodes whose ringing path runs through a
  // BLOCKED connection (closed break valve, held check valves) compounded
  // instead of damping - the implicit solve cannot damp a node with no open
  // flow path - ending in negative node water masses and a 4000 K
  // divergence. Like the momentum-error de-weighting attempts before it,
  // the strict guard is load-bearing: rejecting those steps is what keeps
  // the marginally-damped modes small. Do not raise the default; re-test
  // only with a mechanism that excludes blocked-path nodes.
  quietPressureToleranceScale?: number;

  // Let constraint operators that provide applyConstraintsMutating run
  // without their defensive clone (the solver only hands them solver-private
  // states). Semantically identical by contract - bit-identical results
  // verified by scripts/bitcheck.ts - this exists as a config knob purely
  // for A/B verification (INPLACE_CONSTRAINTS=0 in the script harnesses).
  inPlaceConstraints?: boolean;
}

const DEFAULT_RK45_CONFIG: RK45Config = {
  minDt: 1e-6,
  maxDt: 1.0,
  initialDt: 0.001,

  // relTol was tuned empirically (2026-07, RELTOL sweeps on the PWR/BWR/
  // tankburst scenarios): total step attempts form a shallow bowl with the
  // minimum near 1e-4..2e-4. Counterintuitively, LOOSER tolerance is slower -
  // it lets the marginally-damped acoustic modes of liquid loops go
  // under-resolved, they amplify, and the sanity guard thrashes the timestep.
  // Tighter tolerance keeps those modes small: 2e-4 does ~16-21% less work
  // than 1e-3 on the reactor presets with 5x better accuracy, and is neutral
  // on scenarios without liquid loops.
  relTol: 2e-4,
  absTol: 1e-6,

  safetyFactor: 0.9,
  minShrinkFactor: 0.1,
  maxGrowthFactor: 5.0,

  maxStepsPerFrame: 1000,
  // Per-frame compute budget for the LIVE (non-deterministic) game loop.
  // This blocks the main thread, so it has to leave room in each ~16.7 ms
  // animation frame for rendering and queued input events - at the old
  // 100 ms, typing and slider drags starved whenever the plant ran heavy.
  // Falling behind the requested sim speed is handled honestly downstream
  // (auto-slowdown, the [LAGGING] marker); input latency is not.
  maxWallTimeMs: 30,

  // Default to deterministic mode for reproducibility
  // The game loop can override this if needed for UI responsiveness
  deterministicMode: true,

  quietPressureToleranceScale: 1,

  inPlaceConstraints: true,
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

// Stage times c_i (row sums of A). Used to place the frozen advection
// tendency into each stage STATE at the drift the stage's time implies.
const C = [0, 1/5, 3/10, 4/5, 8/9, 1, 1];

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

  // Per-flow-node total rates from the most recent step ATTEMPT (candidate)
  // and the most recent ACCEPTED step. The accepted rates feed the implicit
  // pressure solve's heat-source estimate: total dU/dt minus flow transport
  // is the wall-heat/work the closure cannot otherwise see.
  private candidateFlowRates?: Map<string, { dMass: number; dEnergy: number }>;
  // The implicit advection pass's per-node applied rates for the CURRENT
  // step attempt (see step()); merged into candidateFlowRates.
  private candidateAdvectionRates?: Map<string, { dMass: number; dEnergy: number }>;
  // Frozen advection tendency T0 for the CURRENT step attempt (mitigation B):
  // the solved flows' donor-cell rates at the step-start state, injected into
  // intermediate stage STATES (weight c_i) but never into the stage rates -
  // the final solution and the transport solve's books never see it.
  private candidateAdvectionTendency?: StateRates;
  // Step-start connection flows for the CURRENT attempt (outerResolve): the
  // corrector's backward-Euler momentum re-solve must integrate stamped
  // connections from the flows the step actually started with, not from the
  // predictor's output.
  private candidateStartFlows?: Map<string, number>;
  private lastOuterResolveLog = 0;
  // Scheme-governor introspection (stage 5): steps turned away before the
  // stages because the solve predicted an out-of-tolerance swing, and steps
  // run with explicit stage advection because the swing was too big but the
  // dt was inside the explicit Courant ceiling.
  public predictiveSwingRejections = 0;
  public explicitFallbackSteps = 0;
  private lastSwingRejectLog = 0;

  private lastAcceptedFlowRates?: Map<string, { dMass: number; dEnergy: number }>;

  // Flag to dynamically enable/disable pressure solver at runtime
  public pressureSolverEnabled: boolean = true;

  // Metrics
  private totalSteps = 0;
  private rejectedSteps = 0;
  private lastStageSanityWarn = 0;
  private operatorTimes = new Map<string, number>();

  // Rejection cause histogram (for performance diagnosis): maps a coarse
  // cause key ("rk45-error", "pre-sanity", "constraint-throw", or the
  // node+check that tripped the sanity guard) to a count.
  public rejectionStats = new Map<string, number>();

  /**
   * Largest dt the throughput guard in checkStateSanity would accept, with
   * margin. The guard rejects a completed step when a node's transit flow
   * moved more than 20% of its inventory (throughput/2 * dt > 0.2 * m) -
   * the material Courant limit that the semi-implicit pressure solve does
   * NOT remove (it collapses the acoustic mode; the fluid still physically
   * transits a node in m/W seconds, and the donor-based advection is only
   * accurate well inside that). This computes the same quantity from the
   * step-START state so the limit is anticipated instead of discovered.
   *
   * Counting mirrors the guard exactly: |flow| summed over both endpoints
   * (so a transit node's W counts once after the *0.5), inventory is water
   * plus NCG, boundary nodes are exempt. Nodes below the guard's own 0.1 kg
   * floor are skipped here too - the guard handles them its own way, and a
   * dying sliver must not drag the whole plant's dt to zero through this
   * ceiling. The 0.9 margin absorbs flow growth within the step; the guard
   * stays as the backstop for fast transients that outrun it.
   */
  private materialCourantDt(state: SimulationState): number {
    // Implicitly-advected connections (stamped by the once-per-step pass)
    // are unconditionally STABLE at any turnover, but not unconditionally
    // trustworthy: the flows they carry were solved against step-start
    // pressures, and a step that turns a node's contents over many times
    // swings its pressure far outside that linearization's trust region -
    // measured as cv-1-inner:pressure rejections replacing the throughput
    // rejections when this ceiling exempted them entirely (discover-by-
    // rejection all over again, one guard downstream). They contribute at
    // a relaxed weight instead: 1/K of their throughput, i.e. a ceiling K
    // times the explicit one - enough turnovers per step to bury the
    // material Courant limit, few enough to keep the pressure solve inside
    // its own trust region.
    const IMPLICIT_ADVECTION_CEILING_RELAXATION = 8;
    const throughput = new Map<string, number>();
    for (const conn of state.flowConnections) {
      let absFlow = Math.abs(conn.massFlowRate);
      if (absFlow === 0) continue;
      if (conn.implicitAdvection) absFlow /= IMPLICIT_ADVECTION_CEILING_RELAXATION;
      throughput.set(conn.fromNodeId, (throughput.get(conn.fromNodeId) || 0) + absFlow);
      throughput.set(conn.toNodeId, (throughput.get(conn.toNodeId) || 0) + absFlow);
    }
    let ceiling = Infinity;
    for (const [id, w] of throughput) {
      const node = state.flowNodes.get(id);
      if (!node || node.isBoundary) continue;
      const gasMass = node.fluid.ncg ? ncgTotalMass(node.fluid.ncg) : 0;
      const totalMass = node.fluid.mass + gasMass;
      if (totalMass < 0.1) continue;
      // guard threshold: w * 0.5 * dt / m = 0.2  ->  dt = 0.4 m / w
      const dtNode = 0.9 * 0.4 * totalMass / w;
      if (dtNode < ceiling) ceiling = dtNode;
    }
    return Math.max(ceiling, this.config.minDt);
  }

  private countRejection(cause: string): void {
    this.rejectionStats.set(cause, (this.rejectionStats.get(cause) || 0) + 1);
  }

  // Rate limiting for log messages (wall time in ms)
  private lastWallTimeLimitLog = 0;
  private lastSanityFailLog = 0;

  // Optional callback invoked after each accepted substep (for state history
  // recording). acceptedDt is the step size actually taken: recording the dt
  // sequence is what makes thinned history REPLAYABLE - the operators are
  // deterministic, so re-integrating from an earlier snapshot with the same
  // dt values reproduces the trajectory bit-for-bit (the adaptive controller
  // is the only wall-clock-influenced input, and the log pins it down).
  public onSubstepComplete?: (state: SimulationState, stepNumber: number, acceptedDt: number) => void;

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
    this.rejectionStats.clear();
    // A fresh simulation must not inherit the previous plant's cross-step
    // flow-rates context (it feeds the implicit pressure solve)
    this.lastAcceptedFlowRates = undefined;
    this.candidateFlowRates = undefined;
    this.candidateAdvectionRates = undefined;
    this.candidateAdvectionTendency = undefined;
    this.candidateStartFlows = undefined;
    this.predictiveSwingRejections = 0;
    this.explicitFallbackSteps = 0;
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
   * Enable or disable deterministic mode.
   * When enabled, the solver will complete all steps regardless of wall time.
   */
  setDeterministicMode(enabled: boolean): void {
    this.config.deterministicMode = enabled;
  }

  /**
   * Check if deterministic mode is enabled.
   */
  getDeterministicMode(): boolean {
    return this.config.deterministicMode ?? false;
  }

  /**
   * Wall-clock budget one advance() call allows itself before yielding, in ms.
   * Deterministic mode ignores it (that is the whole difference), but callers
   * still need the number: it is this solver's definition of "one frame's
   * worth of work", and the game loop sizes its deterministic-mode request
   * from it so the two cannot drift apart.
   */
  getMaxWallTimeMs(): number {
    return this.config.maxWallTimeMs;
  }

  /**
   * Compute total rates from all rate operators
   *
   * IMPORTANT: We must apply constraints BEFORE computing rates to ensure
   * algebraic variables (flow rates, pressures) are consistent with the
   * current state. Otherwise intermediate RK stages use stale values.
   *
   * Returns null if the state is too bad to process (pre-constraint sanity failure).
   *
   * Pass alreadyConstrained=true when the caller just ran applyAllConstraints on
   * this state - constraint operators are algebraic, so re-applying them would
   * only burn time (water-property lookups dominate the step cost).
   */
  private computeTotalRates(state: SimulationState, alreadyConstrained = false): StateRates | null {
    // Quick sanity check before constraints to avoid crashing water properties
    const preCheck = checkPreConstraintSanity(state);
    if (!preCheck.safe) {
      console.warn(`[RK45 computeRates] Pre-constraint sanity failed: ${preCheck.reason}`);
      return null;
    }

    // First, ensure algebraic constraints are satisfied for this state
    // This updates flow rates based on current pressures, which is critical
    // for the DAE nature of this system
    //
    // A state can pass checkPreConstraintSanity (finite, non-negative, plausible
    // specific volume) yet still be a (mass, energy, volume) combination that has
    // no valid pressure solution - e.g. an RK intermediate stage that overshoots
    // into a density/energy pair no real fluid state reaches at any pressure.
    // Water-properties throws loudly in that case (by design - see CLAUDE.md).
    // Treat that the same as a pre-constraint sanity failure: reject this stage
    // so the adaptive step controller can shrink dt and retry, instead of letting
    // the exception crash the whole simulation before BurstCheckOperator or the
    // error-based step rejection ever get a chance to run.
    let constrainedState = state;
    if (!alreadyConstrained) {
      try {
        for (const op of this.constraintOperators) {
          if (op.finalOnly) continue; // side-effecting ops run only on accepted states
          constrainedState = op.applyConstraints(constrainedState);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`[RK45 computeRates] Constraint operator threw, rejecting stage: ${message}`);
        return null;
      }
    }

    // Now compute rates using the constrained state
    let totalRates = createZeroRates();

    // The neutronics rate operator stores live diagnostics (reactivity and
    // its breakdown) on the state it evaluates. That is `constrainedState`,
    // a throwaway clone - copy the diagnostics back to the caller's state so
    // accepted states (and everything cloned from them) display live values.
    const carryNeutronicsDiagnostics = constrainedState !== state;

    const implicitMomentum = this.implicitMomentumActive();
    // A rate operator handed a TRIAL state may legitimately refuse it. RK
    // stages routinely reach out into states the plant never occupies -
    // that is what the error controller is for - and a model that checks its
    // own domain (the OTSG closure asking the steam tables about a sliver of
    // vapour carrying a whole node's energy) will say so. Refusing a trial
    // state means "this step was too big", not "the physics is broken", and
    // it is the same thing the constraint operators above are already allowed
    // to say: reject the stage, let dt shrink, try again. If the state is
    // genuinely broken rather than merely overshot, shrinking will not help
    // and the solver's stuck-at-minimum-dt check still fails the run - after
    // it has established that, rather than on the first trial evaluation.
    let failingOp = '';
    try {
      for (const op of this.rateOperators) {
        // The implicit pressure-flow solve owns connection momentum: skip the
        // explicit momentum operator entirely. Its absence also removes flow
        // momentum from the RK45 error estimate (no rates -> no contribution).
        if (op.providesFlowMomentum && implicitMomentum) continue;
        failingOp = op.name;
        const t0 = performance.now();
        const opRates = op.computeRates(constrainedState);
        this.operatorTimes.set(op.name, (this.operatorTimes.get(op.name) || 0) + (performance.now() - t0));
        accumulateRates(totalRates, opRates);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Throttled: a stage refusal is a normal part of finding the step size,
      // and a plant that hits one usually hits it on every retry until dt is
      // small enough. The first is the informative one.
      const now = performance.now();
      if (now - lastStageRefusalLog > 1000) {
        console.warn(`[RK45 computeRates] Rate operator '${failingOp}' refused this stage, ` +
          `rejecting it: ${message}`);
        lastStageRefusalLog = now;
      }
      return null;
    }

    if (carryNeutronicsDiagnostics) {
      state.neutronics.reactivity = constrainedState.neutronics.reactivity;
      state.neutronics.reactivityBreakdown = constrainedState.neutronics.reactivityBreakdown;
      state.neutronics.diagnostics = constrainedState.neutronics.diagnostics;
    }

    return totalRates;
  }

  /**
   * True when the semi-implicit pressure solver is active AND configured to
   * own the full momentum update (backward-Euler flows replace explicit RK45
   * momentum integration).
   */
  implicitMomentumActive(): boolean {
    return !!(
      this.pressureSolver &&
      this.pressureSolverEnabled &&
      this.pressureSolver.config.implicitMomentum
    );
  }

  /**
   * Apply all constraint operators
   *
   * @param dt - The timestep this constraint application belongs to. Used by the
   *   semi-implicit pressure solver to scale its flow corrections.
   * @param isFinal - True when this state is a step-acceptance candidate rather
   *   than an intermediate RK stage. Operators marked finalOnly (irreversible
   *   side effects like bursting components) run only when this is true.
   */
  private applyAllConstraints(state: SimulationState, dt: number, isFinal = false): SimulationState {
    let result = state;

    // FIRST: Run semi-implicit pressure solver to pre-condition flow rates
    // This adjusts massFlowRate on connections to approximately satisfy mass
    // conservation at liquid nodes, BEFORE we compute pressures from steam tables.
    // This removes the acoustic timescale stiffness from compressed liquid.
    //
    // Note: The pressure solver does NOT modify node pressures - it only adjusts
    // flow rates. The actual pressures remain thermodynamically consistent as
    // computed by FluidStateConstraintOperator from (m, U, V).
    //
    // In implicit momentum mode this is NOT done here: the backward-Euler
    // momentum solve runs exactly ONCE per step attempt (see step()), and the
    // resulting end-of-step flows are frozen through all RK stages so the
    // advected mass exactly matches the solve's mass-balance closure. Re-
    // solving per stage would give each stage slightly different flows, and
    // the 5th-order combination of those would deposit stage-averaged mass
    // that matches NO balance - a ppm-scale mass error that stiff liquid
    // nodes amplify into bar-scale pressure flicker.
    if (this.pressureSolver && this.pressureSolverEnabled && !this.implicitMomentumActive()) {
      const t0 = performance.now();
      this.pressureSolver.solve(result, dt);
      this.operatorTimes.set('PressureSolver', (this.operatorTimes.get('PressureSolver') || 0) + (performance.now() - t0));
    }

    // THEN: Apply standard constraint operators (thermodynamic consistency, etc.)
    // The incoming state is always solver-private here (fresh from
    // applyRatesToState or the implicit-momentum clone), so operators that
    // provide the in-place variant run without their defensive clone.
    for (const op of this.constraintOperators) {
      if (op.finalOnly && !isFinal) continue;
      if (op.postAcceptOnly) continue; // deferred until the step is ACCEPTED
      const t0 = performance.now();
      result = this.config.inPlaceConstraints && op.applyConstraintsMutating
        ? op.applyConstraintsMutating(result, dt)
        : op.applyConstraints(result, dt);
      this.operatorTimes.set(op.name, (this.operatorTimes.get(op.name) || 0) + (performance.now() - t0));
    }

    return result;
  }

  /**
   * Constraint operators that commit irreversible outcomes (bursting) run
   * only here, on a state that has already passed the error controller AND
   * the sanity check. Candidate states routinely overshoot into transient
   * garbage pressures before being rejected; deciding a burst there either
   * spams phantom events (state discarded) or, if the garbage slips past
   * the checks, permanently ruptures a component off a state that never
   * physically existed.
   */
  private applyPostAcceptConstraints(state: SimulationState, dt: number): SimulationState {
    let result = state;
    for (const op of this.constraintOperators) {
      if (!op.postAcceptOnly) continue;
      const t0 = performance.now();
      result = op.applyConstraints(result, dt);
      this.operatorTimes.set(op.name, (this.operatorTimes.get(op.name) || 0) + (performance.now() - t0));
    }
    return result;
  }

  /**
   * Outer re-solve (stage-3 corrector, docs/implicit-energy-advection-design.md).
   *
   * The predictor's flows were linearized at the step-START state; on stiff
   * small nodes (relief valves, near-empty pump inlets) the pressure the step
   * actually produces sits far outside that linearization, and the
   * inconsistent flows destabilize the plant at large dt. So: run the
   * predictor's transport once on a throwaway clone to SEE the end state,
   * then re-solve the pressure-flow system against it -
   *
   *  1. probe = clone of the post-stage state; apply the implicit transport
   *     and re-derive (T, P, phase). This is the end state the predictor's
   *     flows imply, including the valve/choke response to it.
   *  2. Re-solve in corrector mode: end-state compliances, conductances,
   *     and donor enthalpies; the step-start flows as the momentum initial
   *     condition; and the predictor's flows as the BANKED closure reference
   *     (the probe's pressures already contain their transport, so the
   *     compliance equation prices only the flow change - without that, the
   *     corrector double-books the step's pressure response and
   *     anti-damps the loops it is meant to steady). Unstamped connections
   *     are skipped: their stage-explicit transport is settled fact, and the
   *     corrector must not disturb the flow/transport identity it rests on.
   *  3. Adopt the corrected flows for stamped connections only. The caller
   *     then applies the implicit transport with THEM, so the books, the
   *     measured-q merge, and the momentum state all follow the flows that
   *     actually move the mass.
   *
   * One Picard sweep of the fully-coupled implicit step. The stages keep the
   * predictor-flow drift (an O(dt²) splitting residual - they are not
   * re-run). Throws propagate to the caller's try, rejecting the attempt.
   */
  private correctSolvedFlows(newState: SimulationState, dt: number): void {
    const solver = this.pressureSolver!;
    let probe = cloneSimulationState(newState);
    solver.applyImplicitAdvection(probe, dt);
    // Full constraint pass, not FluidState alone: nodes whose pressure is
    // co-determined by other constraint operators (condenser hotwell, flow
    // dynamics) otherwise show the corrector a phantom end pressure, and it
    // "corrects" against it with the same sign every step - measured as a
    // persistent +2 kg/s on the condensate train and a slow power drift
    // even at dt=20ms. Post-accept operators (relief latching, bursting)
    // are excluded by applyAllConstraints itself; the pressure solver is
    // skipped in implicit-momentum mode. The probe is throwaway either way.
    probe = this.applyAllConstraints(probe, dt, true);
    // The probe's connections still carry the PREDICTOR's flows - the solve
    // needs them as the banked reference for its closure; the step-start
    // flows go in as the momentum initial condition only.
    solver.solve(probe, dt, this.lastAcceptedFlowRates,
      { startFlows: this.candidateStartFlows! });

    const corrected = new Map<string, number>();
    for (const conn of probe.flowConnections) corrected.set(conn.id, conn.massFlowRate);
    const diag = solver.config.outerResolveDiag
      ? [] as Array<{ id: string; w1: number; w2: number }>
      : null;
    for (const conn of newState.flowConnections) {
      if (!conn.implicitAdvection) continue;
      const w2 = corrected.get(conn.id);
      if (w2 === undefined) continue;
      if (diag) diag.push({ id: conn.id, w1: conn.massFlowRate, w2 });
      conn.massFlowRate = w2;
    }

    if (diag) {
      const now = performance.now();
      if (now - this.lastOuterResolveLog > 1000) {
        this.lastOuterResolveLog = now;
        diag.sort((a, b) => Math.abs(b.w2 - b.w1) - Math.abs(a.w2 - a.w1));
        const lines = diag.slice(0, 3).map(d => {
          const c = newState.flowConnections.find(x => x.id === d.id)!;
          const p0f = newState.flowNodes.get(c.fromNodeId)?.fluid.pressure ?? NaN;
          const p1f = probe.flowNodes.get(c.fromNodeId)?.fluid.pressure ?? NaN;
          const p0t = newState.flowNodes.get(c.toNodeId)?.fluid.pressure ?? NaN;
          const p1t = probe.flowNodes.get(c.toNodeId)?.fluid.pressure ?? NaN;
          return `${d.id}: ${d.w1.toFixed(2)}->${d.w2.toFixed(2)} kg/s ` +
            `(from P ${(p0f / 1e5).toFixed(2)}->${(p1f / 1e5).toFixed(2)} bar, ` +
            `to P ${(p0t / 1e5).toFixed(2)}->${(p1t / 1e5).toFixed(2)} bar)`;
        });
        console.log(`[OuterResolve] t=${newState.time.toFixed(1)}s dt=${(dt * 1e3).toFixed(1)}ms ` +
          `largest corrections:\n  ${lines.join('\n  ')}`);
      }
    }
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
    // Implicit momentum: perform the backward-Euler pressure-flow solve ONCE
    // per step attempt, on a clone (the attempt may be rejected and retried
    // with a smaller dt, and the solve is dt-dependent). The solved end-of-
    // step flows ṁ¹ are frozen through all RK stages - transport integrates
    // against constant flows, so the mass each node receives is exactly the
    // net flow the solve balanced. applyAllConstraints() skips the solver in
    // this mode.
    this.candidateAdvectionRates = undefined;
    this.candidateAdvectionTendency = undefined;
    this.candidateStartFlows = undefined;
    if (this.implicitMomentumActive() && this.pressureSolver) {
      const t0 = performance.now();
      const solvedState = cloneSimulationState(state);
      if (this.pressureSolver.config.implicitAdvection && this.pressureSolver.config.outerResolve) {
        const w0 = new Map<string, number>();
        for (const conn of state.flowConnections) w0.set(conn.id, conn.massFlowRate);
        this.candidateStartFlows = w0;
      }
      try {
        this.pressureSolver.solve(solvedState, dt, this.lastAcceptedFlowRates);
        // Nearly-implicit advection, part 1 of 2: stamp the partition from
        // the step-start state so the stages' explicit advection operator,
        // the throughput guard, and the Courant ceiling all read one
        // consistent booking. The transport itself is applied after the
        // stages (physics-then-advection splitting - see
        // stampImplicitAdvection for why not before).
        //
        // SCHEME GOVERNOR (stage 5): the implicit split is only trustworthy
        // while the solve's linearization is - and the solve just PREDICTED
        // this step's pressure swing, before any stage work is spent. Three
        // deterministic outcomes of (state, dt), so the choice cannot
        // flip-flop:
        //   swing within the guard's tolerance -> implicit advection (stamp
        //     + frozen tendency), dt free to ride the relaxed ceiling;
        //   swing too big, dt within the explicit Courant ceiling -> run
        //     THIS step with explicit stage advection (the proven scheme is
        //     trusted exactly where its own ceiling says so);
        //   swing too big and dt beyond the explicit ceiling -> reject now,
        //     for the cost of one LU instead of a doomed six-stage attempt
        //     (the same predict-don't-discover trick as materialCourantDt).
        if (this.pressureSolver.config.implicitAdvection) {
          const swing = this.pressureSolver.getLastPredictedSwing();
          // 0.9: same headroom convention as the materialCourantDt ceiling -
          // the prediction is linear, the realized swing can grow a little.
          if (swing <= 0.9 * SANITY_PRESSURE_TOLERANCE) {
            const tendency = this.pressureSolver.stampImplicitAdvection(solvedState);
            if (tendency.size > 0) {
              const tendencyRates = createZeroRates();
              for (const [id, t] of tendency) tendencyRates.flowNodes.set(id, t);
              this.candidateAdvectionTendency = tendencyRates;
            }
          } else {
            // Stale stamps from the previous accepted step must not leak
            // into an explicit attempt (the advection operator and the
            // guards read them).
            for (const conn of solvedState.flowConnections) conn.implicitAdvection = false;
            const explicitCeiling = this.materialCourantDt(solvedState);
            if (dt > explicitCeiling) {
              this.predictiveSwingRejections++;
              const now = performance.now();
              if (now - this.lastSwingRejectLog > 1000) {
                this.lastSwingRejectLog = now;
                console.warn(`[RK45] Predicted pressure swing ${(swing * 100).toFixed(0)}% of scale ` +
                  `at dt=${(dt * 1e3).toFixed(1)}ms (explicit ceiling ${(explicitCeiling * 1e3).toFixed(1)}ms) - ` +
                  `rejecting before the stages`);
              }
              return { newState: state, error: 1e10, k: [], errorRates: createZeroRates() };
            }
            this.explicitFallbackSteps++;
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`[RK45] Implicit momentum solve failed, rejecting step: ${message}`);
        return { newState: state, error: 1e10, k: [], errorRates: createZeroRates() };
      }
      this.operatorTimes.set('PressureSolver', (this.operatorTimes.get('PressureSolver') || 0) + (performance.now() - t0));
      state = solvedState;
    }

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
      const stageRates = createZeroRates();
      for (let j = 0; j < i; j++) {
        accumulateRates(stageRates, k[j], A[i][j]);
      }
      // Frozen advection tendency, weight c_i: the stage EVALUATES against a
      // state that has received its share of the step's transport, but the
      // tendency never enters k[] - the 5th-order solution and the error
      // estimate stay physics-only, and the post-stage transport solve keeps
      // sole ownership of the advection books.
      if (this.candidateAdvectionTendency) {
        accumulateRates(stageRates, this.candidateAdvectionTendency, C[i]);
      }
      const stageState = applyRatesToState(state, stageRates, dt);

      // Quick sanity check before constraints to avoid crashing water properties
      const preCheck = checkPreConstraintSanity(stageState);
      if (!preCheck.safe) {
        // Intermediate stage is catastrophically bad - return failure.
        // Log (rate-limited) - this is the only stage-rejection path that
        // would otherwise be silent, and a simulation dying "at minimum dt"
        // with no message is undiagnosable.
        const now = performance.now();
        if (now - this.lastStageSanityWarn > 1000) {
          this.lastStageSanityWarn = now;
          console.warn(`[RK45] Intermediate stage failed pre-constraint sanity, rejecting: ${preCheck.reason}`);
        }
        return {
          newState: state,
          error: 1e10,
          k,
          errorRates: createZeroRates(),
        };
      }

      // Apply constraints at intermediate stages for stability.
      // Like the computeTotalRates() call below, this can throw if the stage
      // overshot into a state water-properties can't resolve - reject the
      // stage in that case rather than letting the exception propagate.
      let constrainedStage: SimulationState;
      try {
        constrainedStage = this.applyAllConstraints(stageState, dt);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`[RK45] Constraint operator threw on intermediate stage, rejecting: ${message}`);
        return {
          newState: state,
          error: 1e10,
          k,
          errorRates: createZeroRates(),
        };
      }

      // Stage was just constrained above - skip the redundant constraint pass
      const ki = this.computeTotalRates(constrainedStage, true);
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
    const solution5Rates = createZeroRates();
    for (let i = 0; i < 7; i++) {
      accumulateRates(solution5Rates, k[i], B5[i]);
    }
    const newState = applyRatesToState(state, solution5Rates, dt);

    // Nearly-implicit advection, part 2 of 2: apply the step's transport for
    // the stamped connection set against the solved (frozen) flows, using
    // the post-stage states as donors. The final constraint application
    // re-derives (T, P) from the mutated (m, U, ncg). A failed invariant
    // (a node drained dry, a non-physical composition) rejects the step the
    // same way a failed pressure solve does.
    if (this.implicitMomentumActive() && this.pressureSolver?.config.implicitAdvection) {
      try {
        if (this.pressureSolver.config.outerResolve && this.candidateStartFlows) {
          this.correctSolvedFlows(newState, dt);
        }
        this.candidateAdvectionRates =
          this.pressureSolver.applyImplicitAdvection(newState, dt);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`[RK45] Implicit advection failed, rejecting step: ${message}`);
        return { newState: state, error: 1e10, k, errorRates: solution5Rates };
      }
    }

    // Stash this attempt's per-flow-node total rates; promoted to
    // lastAcceptedFlowRates only if the step is ACCEPTED. The implicit
    // pressure solve uses them to estimate each node's non-flow heat source.
    // The measured-q convention is "total observed dU/dt minus modeled
    // transport at current flows", so transport the implicit advection pass
    // applied OUTSIDE the rates must be folded back in here - otherwise q
    // double-subtracts it for every implicitly-advected node.
    if (this.candidateAdvectionRates) {
      const merged = new Map<string, { dMass: number; dEnergy: number }>();
      for (const [id, r] of solution5Rates.flowNodes) {
        const adv = this.candidateAdvectionRates.get(id);
        merged.set(id, adv
          ? { dMass: r.dMass + adv.dMass, dEnergy: r.dEnergy + adv.dEnergy }
          : { dMass: r.dMass, dEnergy: r.dEnergy });
      }
      this.candidateFlowRates = merged;
    } else {
      this.candidateFlowRates = solution5Rates.flowNodes;
    }

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
    const errorRates = createZeroRates();
    for (let i = 0; i < 7; i++) {
      accumulateRates(errorRates, k[i], E[i]);
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

    // A non-finite error means some rate went NaN/Inf (a broken stage state).
    // Treat it like a maximal rejection: shrink hard. Letting NaN through
    // poisons currentDt permanently - Math.max(NaN, minDt) is NaN, every
    // subsequent comparison is false, and the solver spins forever without
    // even tripping the stuck-detector.
    if (!isFinite(error) || !isFinite(dt)) {
      return Math.max((isFinite(dt) ? dt : this.config.initialDt) * this.config.minShrinkFactor, this.config.minDt);
    }

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
   *
   * @param wallFrameTimeMs - actual wall-clock time between frames (ms). Used
   *   for the real-time ratio so it reflects achieved speed, not solver
   *   throughput capacity; without it the ratio divides by compute time only.
   */
  advance(state: SimulationState, requestedDt: number, wallFrameTimeMs?: number): {
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

    // DETERMINISTIC MODE TAKES NO WALL-CLOCK BREAK.
    //
    // It used to yield at 500 ms like the interactive path, and that quietly
    // made the mode a lie: a tick that could not be finished inside the budget
    // returned having advanced LESS than the dt it was asked for, so the
    // trajectory depended on how fast the machine was. Two runs of the same
    // headless preset on the same commit landed at t=29.92 s and t=30.00 s
    // with different states, and any optimization looked like a physics change
    // because it let more substeps fit in the budget. Reproducibility is the
    // entire point of the mode - replay, regression baselines and A/B
    // measurement all rest on it - so here the loop runs until the requested
    // time is covered, however long that takes.
    //
    // This cannot spin forever: a state that genuinely will not integrate
    // drives dt to minDt, and the consecutive-rejection guard below throws
    // after MAX_REJECTS_AT_MIN_DT. What it CAN do is take a long time on a
    // legitimately stiff tick, which is the honest outcome and is reported.
    const deterministic = this.config.deterministicMode;
    while (remainingTime > 1e-10) {
      // Interactive mode still yields, so the UI keeps its frame rate: there,
      // falling behind real time is the intended behavior.
      const maxSteps = deterministic ? Infinity : this.config.maxStepsPerFrame;

      if (stepsThisFrame >= maxSteps) {
        console.warn(`[RK45] Hit max steps per frame (${this.config.maxStepsPerFrame})`);
        break;
      }
      const now = performance.now();
      if (!deterministic && now - frameStart > this.config.maxWallTimeMs) {
        // Rate limit this warning to once per second
        if (now - this.lastWallTimeLimitLog > 1000) {
          console.warn(`[RK45] Hit wall time limit (${this.config.maxWallTimeMs}ms)`);
          this.lastWallTimeLimitLog = now;
        }
        break;
      }
      if (deterministic && now - frameStart > 10000 &&
          now - this.lastWallTimeLimitLog > 10000) {
        // Not a limit - just proof of life, so a stiff tick is visible rather
        // than looking like a hang.
        console.warn(`[RK45] Deterministic tick still running after ` +
          `${((now - frameStart) / 1000).toFixed(0)}s: ${stepsThisFrame} steps, ` +
          `${(remainingTime * 1e3).toFixed(3)}ms of ${(requestedDt * 1e3).toFixed(1)}ms left, ` +
          `dt=${(this.currentDt * 1e6).toFixed(2)}us`);
        this.lastWallTimeLimitLog = now;
      }

      // Don't overshoot remaining time, and honor any operator's declared
      // stability ceiling (see RateOperator.getMaxStableDt)
      let stepDt = Math.min(this.currentDt, remainingTime);
      for (const op of this.rateOperators) {
        if (op.getMaxStableDt) {
          stepDt = Math.min(stepDt, op.getMaxStableDt(currentState));
        }
      }
      // Material-Courant ceiling: never ATTEMPT a step the throughput guard
      // in checkStateSanity would reject. The RK45 error norm is deliberately
      // blind to balanced throughput (net rates are ~zero for a transit node
      // in steady flow), so without this the controller grows dt straight
      // past a small node's turnover time and discovers the limit by
      // slamming into the guard - a full six-stage attempt wasted per
      // discovery, in a reject/regrow cycle (measured: 1353 cv-1-inner
      // throughput rejections per 60 s of Xe-100, ~half of all rejections).
      // Same idea as an operator's getMaxStableDt: a mode the error
      // controller cannot see must be declared, not discovered.
      stepDt = Math.min(stepDt, this.materialCourantDt(currentState));

      // Take a step
      const { newState, error, errorRates } = this.step(currentState, stepDt);

      // Quick sanity check BEFORE constraints to avoid crashing water properties
      const preCheck = checkPreConstraintSanity(newState);
      if (!preCheck.safe) {
        // Catastrophically bad state - reject immediately and shrink dt aggressively
        console.warn(`[RK45] Pre-constraint sanity failed: ${preCheck.reason}`);
        rejectsThisFrame++;
        this.rejectedSteps++;
        this.countRejection(`pre-sanity:${(preCheck.reason ?? 'unknown').split(':')[0]}`);
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

      // Apply constraints to get final state.
      // This can throw if the accepted step overshot into a (mass, energy, volume)
      // combination water-properties can't resolve to a valid pressure. Treat that
      // exactly like the pre-constraint sanity failure above: reject the step and
      // shrink dt, rather than letting the exception crash the simulation before
      // BurstCheckOperator (which runs after acceptance, see
      // applyPostAcceptConstraints) ever gets a chance to open a relief path.
      let constrainedState: SimulationState;
      try {
        constrainedState = this.applyAllConstraints(newState, stepDt, true);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`[RK45] Constraint operator threw on accepted step, rejecting: ${message}`);
        rejectsThisFrame++;
        this.rejectedSteps++;
        this.countRejection('constraint-throw');
        this.currentDt = Math.max(stepDt * 0.1, this.config.minDt);

        if (this.currentDt <= this.config.minDt * 1.01) {
          consecutiveRejectsAtMinDt++;
          if (consecutiveRejectsAtMinDt >= MAX_REJECTS_AT_MIN_DT) {
            throw new Error(
              `[RK45] Simulation stuck: ${consecutiveRejectsAtMinDt} consecutive step rejections at minimum dt. ` +
              `Constraint operator threw: ${message}. ` +
              `The physics is unstable and cannot be resolved by shrinking the timestep.`
            );
          }
        }
        continue;
      }

      // Check for obviously bad physics (in addition to RK45 error estimate)
      const sanityScore = checkStateSanity(currentState, constrainedState, stepDt, this.implicitMomentumActive(),
        this.config.quietPressureToleranceScale ?? 1);

      // Combine RK45 error with sanity check
      // Sanity score > 1 means something suspicious happened
      const effectiveError = Math.max(error, sanityScore * this.config.relTol);

      // Accept or reject based on combined error. A non-finite error is never
      // acceptable - not even at minimum dt - because it means some rate went
      // NaN/Inf and the candidate state cannot be trusted.
      const tol = this.config.relTol;

      if (isFinite(effectiveError) && (effectiveError <= tol || stepDt <= this.config.minDt)) {
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
        this.lastAcceptedFlowRates = this.candidateFlowRates;
        // Irreversible-outcome operators (bursting) see only ACCEPTED states
        currentState = this.applyPostAcceptConstraints(currentState, stepDt);
        remainingTime -= stepDt;
        stepsThisFrame++;
        this.totalSteps++;
        minDtUsed = Math.min(minDtUsed, stepDt);

        // Notify listener of accepted substep (for state history recording)
        this.onSubstepComplete?.(currentState, this.totalSteps, stepDt);

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
          const reason = lastSanityFailureReason;
          const kind = reason.includes('pressure change') ? 'pressure'
            : reason.includes('massFraction') ? 'throughput'
            : reason.includes('relMassChange') ? 'massChange'
            : 'other';
          this.countRejection(`sanity:${reason.split(':')[0]}:${kind}`);
        } else if (!isFinite(effectiveError)) {
          // Broken stage produced NaN/Inf rates - reject loudly; the dt
          // controller shrinks hard (see computeOptimalDt).
          this.countRejection('nan-error');
          if (now - this.lastSanityFailLog > 1000) {
            console.warn(`[RK45] Non-finite error estimate at dt=${(stepDt * 1000).toFixed(3)}ms - rejecting step and shrinking`);
            this.lastSanityFailLog = now;
          }
          if (stepDt <= this.config.minDt * 1.01) {
            consecutiveRejectsAtMinDt++;
            if (consecutiveRejectsAtMinDt >= MAX_REJECTS_AT_MIN_DT) {
              throw new Error(
                `[RK45] Simulation stuck: ${consecutiveRejectsAtMinDt} consecutive non-finite error estimates at minimum dt. ` +
                `Some physics rate is producing NaN/Inf and cannot be resolved by shrinking the timestep.`
              );
            }
          }
        } else {
          this.countRejection(error >= 1e10 ? 'stage-failure' : 'rk45-error');
        }

        if (sanityScore > 1) {
          // Sanity check failed - be more aggressive about shrinking.
          // Rate-limit the log: transients can reject hundreds of steps per
          // second and per-rejection logging floods the console.
          this.currentDt = stepDt * 0.25;
          if (now - this.lastSanityFailLog > 1000) {
            console.log(`[RK45] Sanity check failed (score=${sanityScore.toFixed(2)}), shrinking dt to ${(this.currentDt*1000).toFixed(3)}ms - ${lastSanityFailureReason}`);
            this.lastSanityFailLog = now;
          }
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
      realTimeRatio: (requestedDt - remainingTime) / ((wallFrameTimeMs ?? frameTime) / 1000),
      isFallingBehind: remainingTime > requestedDt * 0.1,
      fallingBehindSince: 0,
      operatorTimes: new Map(this.operatorTimes),
      lastSimTime: currentState.time,
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
          lastSimTime: state.time,
        },
      };
    }

    let constrainedState: SimulationState;
    try {
      constrainedState = this.applyAllConstraints(newState, this.currentDt, true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[RK45 singleStep] Constraint operator threw, rejecting: ${message}`);
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
          lastSimTime: state.time,
        },
      };
    }

    // Check sanity and log warning if needed
    const sanityScore = checkStateSanity(state, constrainedState, this.currentDt, this.implicitMomentumActive(),
      this.config.quietPressureToleranceScale ?? 1);
    if (sanityScore > 1) {
      console.warn(`[RK45 singleStep] Sanity check warning: score=${sanityScore.toFixed(2)}`);
    }

    constrainedState.time += this.currentDt;
    this.lastAcceptedFlowRates = this.candidateFlowRates;
    // singleStep always accepts - run the irreversible-outcome operators too
    constrainedState = this.applyPostAcceptConstraints(constrainedState, this.currentDt);

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
      lastSimTime: constrainedState.time,
    };

    // Adjust dt for next step based on combined error
    const takenDt = this.currentDt; // the dt this step was actually taken with
    this.currentDt = this.computeOptimalDt(effectiveError, this.currentDt);

    // Notify listener of accepted substep (for state history recording)
    this.onSubstepComplete?.(constrainedState, this.totalSteps, takenDt);

    return {
      state: constrainedState,
      dt: this.currentDt,
      error: effectiveError,
      metrics,
    };
  }

  // ==========================================================================
  // Replay support (history seek)
  //
  // The dt log in StateHistory pins down the adaptive controller's choices;
  // everything else in a step is a deterministic function of (state, dt) -
  // EXCEPT lastAcceptedFlowRates, which feeds the next step's implicit
  // pressure solve from solver-instance memory. Snapshots therefore carry a
  // copy of it, and a seek restores it before replaying.
  // ==========================================================================

  /**
   * Fast-forward the step counter to at least `n`. Used after importing a
   * saved history whose step numbers must stay ahead of new live steps -
   * step numbers are the history's ordering key and must never repeat.
   */
  resumeStepCounter(n: number): void {
    this.totalSteps = Math.max(this.totalSteps, n);
  }

  /** Copy of the cross-step flow-rates context, for storing in a snapshot. */
  getFlowRatesContext(): Map<string, { dMass: number; dEnergy: number }> | undefined {
    if (!this.lastAcceptedFlowRates) return undefined;
    const copy = new Map<string, { dMass: number; dEnergy: number }>();
    for (const [k, v] of this.lastAcceptedFlowRates) copy.set(k, { ...v });
    return copy;
  }

  /** Restore the cross-step flow-rates context from a snapshot. */
  setFlowRatesContext(ctx: Map<string, { dMass: number; dEnergy: number }> | undefined): void {
    if (!ctx) {
      this.lastAcceptedFlowRates = undefined;
      return;
    }
    const copy = new Map<string, { dMass: number; dEnergy: number }>();
    for (const [k, v] of ctx) copy.set(k, { ...v });
    this.lastAcceptedFlowRates = copy;
  }

  /**
   * Re-integrate exactly one previously-accepted step with its logged dt.
   * Mirrors the accepted branch of advance() - stages, constraints, time
   * advance, flow-rates handoff, post-accept (burst) operators - but skips
   * everything adaptive: no error control, no dt update, no totalSteps, no
   * onSubstepComplete. The step was accepted live, so it is accepted here
   * unconditionally; a sanity failure means the replay diverged from the
   * recorded trajectory, which is a determinism bug we must not paper over.
   */
  replayStep(state: SimulationState, dt: number): SimulationState {
    const { newState } = this.step(state, dt);

    const preCheck = checkPreConstraintSanity(newState);
    if (!preCheck.safe) {
      throw new Error(
        `[RK45 replay] Pre-constraint sanity failed replaying an accepted step ` +
        `(t=${state.time.toFixed(6)}s, dt=${(dt * 1000).toFixed(3)}ms): ${preCheck.reason}. ` +
        `Replay diverged from the recorded trajectory - the physics is not ` +
        `deterministic in (state, dt) and this must be fixed, not tolerated.`
      );
    }

    let constrainedState = this.applyAllConstraints(newState, dt, true);
    constrainedState.time += dt;
    this.lastAcceptedFlowRates = this.candidateFlowRates;
    constrainedState = this.applyPostAcceptConstraints(constrainedState, dt);
    return constrainedState;
  }

  getMetrics(): { totalSteps: number; rejectedSteps: number; currentDt: number } {
    return {
      totalSteps: this.totalSteps,
      rejectedSteps: this.rejectedSteps,
      currentDt: this.currentDt,
    };
  }
}
