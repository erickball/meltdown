/**
 * Rate-Based Physics Operators for RK45 Integration
 *
 * These operators compute derivatives (rates of change) rather than
 * applying changes directly. This allows the RK45 solver to combine
 * them properly for higher-order accuracy.
 *
 * Each operator returns StateRates describing dm/dt, dU/dt, dT/dt, etc.
 */

import { SimulationState, FlowNode, ConvectionConnection } from '../types';
import {
  RateOperator,
  ConstraintOperator,
  StateRates,
  createZeroRates,
} from '../rk45-solver';
import { cloneSimulationState } from '../solver';
import {
  computeReactivityComponents, getRelocatedFuelFraction, normalizedNeutronSource,
  DECAY_HEAT_GROUPS, DECAY_HEAT_TOTAL_FRACTION,
} from './neutronics';
import * as Water from '../water-properties';
import { solveMixtureState, nodeGasVolume, type MixtureState } from '../mixture-properties';
import { simulationConfig } from '../types';
import {
  totalMoles,
  totalMass as ncgTotalMass,
  emptyGasComposition,
  ALL_GAS_SPECIES,
  mixtureCv,
  mixtureCp,
  mixtureThermalConductivity,
  mixtureViscosity,
  averageMolecularWeight,
  diffusivityInMixture,
} from '../gas-properties';
import {
  graphiteSpecificHeat,
  graphiteThermalConductivity,
  bedEffectiveConductivity,
  SIGMA_SB,
  NBG_18,
} from '../graphite';
import {
  calculateSeparation,
  calculateLiquidLevelWithObstructions,
  findCheckValveForConnection,
  computeConnectionHydraulics,
  computeChokeLimit,
  connectionRestriction,
  drawCompositionAt,
  DrawComposition,
  approxVaporDensity,
  CLOSED_FLOW_DECAY_TAU,
  pressureAtConnection,
  zoneWaterShare,
} from './connection-hydraulics';

// Shared per-connection hydraulics now live in connection-hydraulics.ts (one
// model consumed by both this file's explicit momentum operator and the
// semi-implicit PressureSolver). Re-export the utilities that other modules
// historically imported from here.
export {
  calculateSeparation,
  setSeparationDebug,
  calculateLiquidLevelWithObstructions,
  calculateVolumeAtElevation,
  findCheckValveForConnection,
} from './connection-hydraulics';


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

const DEBUG_NODE_ID = '';
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
// Melting (apparent heat capacity)
// ============================================================================

// Width of the smoothed melting transition (K). Real irradiated fuel has a
// solidus-liquidus spread of this order; numerically it keeps the latent
// plateau RK45-friendly.
const MELT_WIDTH = 25;

/**
 * Melt fraction of a thermal node, derived purely from its temperature:
 * a logistic ramp centered on meltingPoint with width ~MELT_WIDTH. 0 for
 * nodes without melting data.
 */
export function meltFraction(node: { temperature: number; meltingPoint?: number; latentHeatFusion?: number }): number {
  if (!node.meltingPoint || !node.latentHeatFusion) return 0;
  const z = (node.temperature - node.meltingPoint) / MELT_WIDTH;
  return 1 / (1 + Math.exp(-1.7 * z));
}

/**
 * Effective heat capacity (J/K) of a thermal node: m*cp plus, for nodes
 * with melting data, a smooth latent-heat bump (the derivative of
 * meltFraction times m*L). Crossing the melting range therefore absorbs
 * exactly m*L of energy while the temperature plateaus - the apparent-
 * heat-capacity method. Every operator that turns watts into dT/dt must
 * use this, not m*cp directly, or melting nodes will skip their plateau.
 */
/**
 * Fuel-oxide content (kg) of a corium/debris node: total mass minus the
 * unoxidized-metal and concrete-slag inventories. DERIVED, never integrated
 * separately, so composition cannot drift from the total; the floor only
 * absorbs floating-point residue from the inventory integrations.
 * Decay heat and fission-product inventory follow this, not raw mass.
 */
export function fuelOxideMass(node: {
  mass: number; metal?: { zr: number; fe: number }; slagMass?: number;
}): number {
  return Math.max(0,
    node.mass - (node.metal?.zr ?? 0) - (node.metal?.fe ?? 0) - (node.slagMass ?? 0));
}

export function nodeHeatCapacity(node: {
  mass: number; specificHeat: number; temperature: number;
  specificHeatModel?: 'graphite';
  meltingPoint?: number; latentHeatFusion?: number;
}): number {
  // A named cp model replaces the constant: graphite's cp nearly triples
  // between cold and 2000 K, and a lumped graphite node exists precisely
  // for its heat capacity.
  const cp = node.specificHeatModel === 'graphite'
    ? graphiteSpecificHeat(node.temperature)
    : node.specificHeat;
  let C = node.mass * cp;
  if (node.meltingPoint && node.latentHeatFusion) {
    const z = (node.temperature - node.meltingPoint) / MELT_WIDTH;
    const s = 1 / (1 + Math.exp(-1.7 * z));
    C += node.mass * node.latentHeatFusion * (1.7 / MELT_WIDTH) * s * (1 - s);
  }
  return C;
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

      // Solid conduction, plus (optionally) a packed bed whose effective
      // conductivity is recomputed from the live gas and temperature, plus
      // gray-body radiation across a gap. All three are parallel paths
      // between the same pair of nodes and simply add.
      let conductance = conn.conductance;

      if (conn.packedBed) {
        const bed = conn.packedBed;
        const gasNode = state.flowNodes.get(bed.gasNodeId);
        // A packed bed's conduction depends on what fills its voids, so
        // there is no defensible default here. Guessing air would quietly
        // set the wrong conductivity on the one heat path that decides
        // whether a gas reactor survives a loss of flow.
        if (!gasNode) {
          throw new Error(
            `[Conduction] Packed-bed connection '${conn.id}' names gas node ` +
            `'${bed.gasNodeId}', which does not exist. The bed's effective ` +
            `conductivity depends on the gas filling its voids and cannot be ` +
            `evaluated without it.`
          );
        }
        if (!gasNode.fluid.ncg) {
          throw new Error(
            `[Conduction] Packed-bed connection '${conn.id}': flow node ` +
            `'${bed.gasNodeId}' carries no non-condensable gas inventory, so the ` +
            `bed's void conductivity is undefined. A packed bed is only wired for ` +
            `gas-cooled cores - a water-filled bed would need the water ` +
            `conductivity path instead.`
          );
        }
        // Mean of the two node temperatures drives the bed's radiative and
        // solid conductivities - the bed physically spans between them.
        const T_bed = 0.5 * (node1.temperature + node2.temperature);
        const kGas = mixtureThermalConductivity(gasNode.fluid.ncg, T_bed);
        const kSolid = graphiteThermalConductivity(T_bed, {
          ...NBG_18, k300: bed.solidK300,
        });
        const kEff = bedEffectiveConductivity(
          kGas, kSolid, bed.voidFraction, T_bed,
          bed.particleDiameter, bed.emissivity,
        );
        // Bed resistance in series with the receiving structure's own
        // conduction path, if one was supplied.
        const seriesR = bed.seriesShapeFactor
          ? 1 / (graphiteThermalConductivity(T_bed, {
              ...NBG_18, k300: bed.seriesK300 ?? NBG_18.k300,
            }) * bed.seriesShapeFactor)
          : 0;
        conductance += 1 / (1 / (kEff * bed.shapeFactor) + seriesR);
      }

      if (conn.radiationCoeff) {
        // Linearise onto the same conductance so the sign and the
        // accumulation below stay shared. T1^4-T2^4 = (T1-T2)(T1+T2)(T1^2+T2^2),
        // so the (T1-T2) factor divides out exactly - no division by dT, and
        // no singularity when the two nodes are at the same temperature.
        const T1 = node1.temperature, T2 = node2.temperature;
        conductance += SIGMA_SB * conn.radiationCoeff *
          (T1 + T2) * (T1 * T1 + T2 * T2);
      }

      // Heat flow from node1 to node2 (W)
      const Q = conductance * (node1.temperature - node2.temperature);

      // Temperature rate: dT/dt = Q / C_eff (latent-heat plateau included)
      const dT1 = -Q / nodeHeatCapacity(node1);
      const dT2 = Q / nodeHeatCapacity(node2);

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

// Module-level display state for UI access (mirrors the
// getTurbineCondenserState pattern): the RK45 path never writes
// state.energyDiagnostics, so the panels read these instead.
const lastConvectionHeatRates = new Map<string, number>();
/** hA (W/K) of each convection pair at its last explicit evaluation - what
 *  the solver's stiff-pair split reads to size a pair's relaxation time. */
const lastConvectionConductance = new Map<string, number>();
export function getLastConvectionConductance(): Map<string, number> {
  return lastConvectionConductance;
}
export function recordConvectionHeatRate(connId: string, Q: number): void {
  lastConvectionHeatRates.set(connId, Q);
}

/**
 * A flow node's effective heat capacity (J/K) for wall exchange: water at
 * its effective specific heat (two-phase includes the evaporation buffer,
 * exactly as FluidStateUpdateOperator's stability estimate prices it) plus
 * the NCG at constant volume. Zero for an empty node.
 */
export function fluidHeatCapacity(node: FlowNode): number {
  let C = 0;
  if (node.fluid.ncg) {
    const n = totalMoles(node.fluid.ncg);
    if (n > 0) C += n * mixtureCv(node.fluid.ncg);
  }
  if (node.fluid.mass > 0) {
    // The water's effective specific heat needs only its PHASE and its
    // TEMPERATURE, and the accepted mixture solve has already written both
    // onto the node. It used to be re-derived by inverting the steam tables
    // on (U_total - n Cv T)/m - a subtraction of two nearly equal numbers
    // divided by a tiny mass, which is exactly the ill-conditioned form
    // mixture-properties.ts warns about. In a node that has boiled itself
    // down to grams of steam under thousands of moles of hydrogen it
    // produced specific volumes of 1e16 m3/kg and threw straight out of the
    // water tables, killing a run that was otherwise perfectly healthy.
    // Same quantity, no inversion, nothing to cancel.
    C += node.fluid.mass * Water.effectiveSpecificHeat({
      temperature: node.fluid.temperature,
      pressure: node.fluid.pressure,
      density: node.volume > 0 ? node.fluid.mass / node.volume : 0,
      phase: node.fluid.phase,
      quality: node.fluid.quality ?? 0,
      iceFraction: node.fluid.iceFraction ?? 0,
      specificEnergy: node.fluid.internalEnergy / node.fluid.mass,
    });
  }
  return C;
}

/** Last computed per-connection convective heat rate (W), keyed by connection id */
export function getConvectionHeatRates(): ReadonlyMap<string, number> {
  return lastConvectionHeatRates;
}

export interface ReactorPowerDisplayState {
  coreId: string | null;
  fissionPower: number;    // W - prompt fission power
  decayHeatPower: number;  // W - fission-product decay heat
  thermalPower: number;    // W - total heat deposited in the fuel
  nominalPower: number;    // W - 100% rated power
}

let lastReactorPower: ReactorPowerDisplayState = {
  coreId: null, fissionPower: 0, decayHeatPower: 0, thermalPower: 0, nominalPower: 0,
};

export function getReactorPowerState(): ReactorPowerDisplayState {
  return { ...lastReactorPower };
}

/**
 * Molar mass of water (kg/mol). One value for the whole wall-transfer path:
 * the steam inventory, the property blend and the condensing mass flux all
 * have to agree on it, or the dew point the convection side computes differs
 * in the last decimal from the one the condensation side does and a wall can
 * be condensing according to one and dry according to the other.
 */
const M_H2O = 0.018015;

/**
 * Mass flow passing THROUGH a node (kg/s), for the velocity the channel
 * correlations run on.
 *
 * Summing |mdot| over every connection touching the node counts the same
 * throughput twice - once arriving and once leaving - because mass is
 * conserved at the node. Halving it is exact for any topology in balance: a
 * pass-through with one inlet and one outlet, and a header splitting one
 * stream into three, both come out right. A dead-ended branch has no
 * through-flow to speak of and gets half of what it is exchanging, which is
 * as meaningful as a single number there can be.
 *
 * This ran 2x fast everywhere, which inflated Re by 2 and h by ~1.7 on every
 * forced-convection surface in every plant.
 */
function nodeThroughput(
  state: SimulationState, nodeId: string, table?: Map<string, number>,
): number {
  if (table) return table.get(nodeId) ?? 0;
  let sum = 0;
  for (const fc of state.flowConnections) {
    if (fc.fromNodeId === nodeId || fc.toNodeId === nodeId) {
      sum += Math.abs(fc.massFlowRate);
    }
  }
  return 0.5 * sum;
}

/**
 * Every node's throughput in one sweep of the connection list.
 *
 * Computing it per-consumer is O(connections) EACH, and the convection pass
 * asks twice per convection connection - on a four-loop plant that is 134
 * surfaces x 2 x 87 connections = 23000 iterations per stage to produce at
 * most 72 distinct numbers. One sweep is O(connections) total. Same
 * arithmetic, same result; it is the loop nesting that was the cost.
 */
export function nodeThroughputTable(state: SimulationState): Map<string, number> {
  const t = new Map<string, number>();
  for (const fc of state.flowConnections) {
    const m = Math.abs(fc.massFlowRate);
    t.set(fc.fromNodeId, (t.get(fc.fromNodeId) ?? 0) + m);
    t.set(fc.toNodeId, (t.get(fc.toNodeId) ?? 0) + m);
  }
  for (const [k, v] of t) t.set(k, 0.5 * v);
  return t;
}

/**
 * Everything a wall coefficient needs from the FLUID, which is a property of
 * the node and not of the surface touching it.
 *
 * Only the area, the two characteristic lengths and the wall temperature
 * differ between surfaces on the same node - so a node carrying several of
 * them was paying for the same property blend, density and Prandtl number
 * once per surface. On a four-loop plant that is 49% of the work: 36
 * surfaces face the containment atmosphere and 27 more face `atmosphere`,
 * which is a boundary node whose state never moves at all.
 *
 * Computed once per node per pass, memoised in maps the operator owns for
 * the duration. Nothing is carried between passes - this is not a staleness
 * cache and there is no band to get wrong, just the same arithmetic done
 * once instead of N times.
 */
export interface ConvectionNodeProps {
  liquid: Map<string, LiquidFluidProps>;
  vapor: Map<string, VaporFluidProps>;
  throughput: Map<string, number>;
}

interface LiquidFluidProps {
  rho: number; mu: number; k: number; cp: number; Pr: number; beta: number;
}
interface VaporFluidProps {
  k: number; mu: number; cpMass: number; M: number; Pr: number;
  rho_g: number; nSteam: number; nNcg: number;
}

export function makeConvectionNodeProps(state: SimulationState): ConvectionNodeProps {
  return { liquid: new Map(), vapor: new Map(), throughput: nodeThroughputTable(state) };
}

function liquidPropsFor(
  flowNode: FlowNode, cache?: ConvectionNodeProps,
): LiquidFluidProps {
  const hit = cache?.liquid.get(flowNode.id);
  if (hit) return hit;
  const fluid = flowNode.fluid;
  const T = fluid.temperature;
  // Liquid properties at the node's OWN temperature. These were mu = 3e-4,
  // k = 0.6, Pr = 2.0 - one set of roughly-150 C values applied to every
  // liquid in every plant. Water is not that: its viscosity falls by a
  // factor of twelve between 20 C and 330, its conductivity has a maximum
  // near 150 C, and its Prandtl number runs from 7 down to 0.8 and back up.
  const rho = fluid.phase === 'two-phase'
    ? Water.saturatedLiquidDensity(T)
    : fluid.mass / flowNode.volume;
  const mu = Water.liquidViscosity(T);
  const k = Water.liquidThermalConductivity(T);
  const cp = Water.liquidSpecificHeat(T);
  const out: LiquidFluidProps = {
    rho, mu, k, cp, Pr: (cp * mu) / k,
    beta: Water.liquidThermalExpansivity(T),
  };
  cache?.liquid.set(flowNode.id, out);
  return out;
}

function vaporPropsFor(
  flowNode: FlowNode, cache?: ConvectionNodeProps,
): VaporFluidProps {
  const hit = cache?.vapor.get(flowNode.id);
  if (hit) return hit;
  const T = flowNode.fluid.temperature;
  const ncg = flowNode.fluid.ncg;
  const nNcg = ncg ? totalMoles(ncg) : 0;
  // Steam sharing the vapor space (all water for a vapor node, the vapor
  // fraction for a two-phase node)
  const steamVaporMass = flowNode.fluid.phase === 'two-phase'
    ? flowNode.fluid.mass * (flowNode.fluid.quality ?? 0)
    : flowNode.fluid.mass;
  const nSteam = steamVaporMass / M_H2O;
  const xNcg = nNcg > 0 ? nNcg / (nNcg + nSteam) : 0;
  // Mole-fraction blend of steam and NCG transport properties
  const k_steam = 0.03, mu_steam = 2e-5, cpMolar_steam = 37, M_steam = M_H2O;
  let k = k_steam, mu = mu_steam, cpMolar = cpMolar_steam, M = M_steam;
  if (xNcg > 0 && ncg) {
    k = (1 - xNcg) * k_steam + xNcg * mixtureThermalConductivity(ncg, T);
    mu = (1 - xNcg) * mu_steam + xNcg * mixtureViscosity(ncg, T);
    cpMolar = (1 - xNcg) * cpMolar_steam + xNcg * mixtureCp(ncg);
    M = (1 - xNcg) * M_steam + xNcg * averageMolecularWeight(ncg);
  }
  const cpMass = cpMolar / M;
  const out: VaporFluidProps = {
    k, mu, cpMass, M, Pr: cpMass * mu / k,
    // Vapor-space density: ideal-gas steam at its partial pressure plus the
    // NCG mixture (valid above the water critical point, unlike the
    // saturated-vapor table this replaced)
    rho_g: approxVaporDensity(flowNode),
    nSteam, nNcg,
  };
  cache?.vapor.set(flowNode.id, out);
  return out;
}

export class ConvectionRateOperator implements RateOperator {
  name = 'Convection';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();
    const cache = makeConvectionNodeProps(state);

    for (const conn of state.convectionConnections) {
      const thermalNode = state.thermalNodes.get(conn.thermalNodeId);
      const flowNode = state.flowNodes.get(conn.flowNodeId);

      if (!thermalNode || !flowNode) continue;
      // Applied implicitly for this step by the solver (relaxation faster
      // than the step): nothing explicit to add, and the conductance stays
      // what the last explicit evaluation measured.
      if (conn.implicitThisStep) continue;

      // Split the surface into liquid-wetted and vapor-exposed portions by
      // the node's liquid level (tubes above the water line barely transfer).
      const { liquidArea, vaporArea } = effectiveSurfaceAreas(conn, flowNode);

      const dT = thermalNode.temperature - flowNode.fluid.temperature;
      // Two lengths, because the correlations want different ones. D_heater
      // is the rod or tube the heat comes off, which is what film boiling
      // blankets; D_flow is the passage the coolant runs in, which is what
      // the channel correlations are written against. They coincide for a
      // bare surface in a big volume and differ by ~2x in a rod bundle.
      const D_heater = conn.characteristicDiameter ?? flowNode.hydraulicDiameter;
      const D_flow = conn.flowHydraulicDiameter ?? D_heater;

      // Each coefficient is only ever used against its own area, and a
      // single-phase node has one of them at exactly zero - which is most
      // surfaces in most plants. Computing the other anyway was half the
      // convection pass multiplied by nothing: two correlation sets, a
      // mixture-property sweep over every gas species, and a saturation
      // lookup, to scale a zero.
      const h_liquid = liquidArea > 0
        ? this.liquidHeatTransferCoeff(
            flowNode, state, conn, D_flow, D_heater, cache)
        : 0;
      const h_vapor = vaporArea > 0
        ? this.vaporHeatTransferCoeff(
            flowNode, state, D_flow, thermalNode.temperature, conn, cache)
        : 0;
      const Q = h_liquid * liquidArea * dT + h_vapor * vaporArea * dT;

      lastConvectionHeatRates.set(conn.id, Q);
      lastConvectionConductance.set(conn.id, h_liquid * liquidArea + h_vapor * vaporArea);

      // Solid temperature rate (effective capacity includes latent heat)
      const dT_solid = -Q / nodeHeatCapacity(thermalNode);

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

  /**
   * Liquid-wetted surface split by node liquid level (same model the level-
   * dependent HX work introduced; previously only the obsolete Euler path
   * applied it).
   */
  /**
   * Wetted-surface heat transfer coefficient: single-phase convection -
   * Dittus-Boelter blended with Churchill-Chu on the liquid's own Rayleigh
   * number, both on properties read at the node's temperature - plus, for a
   * saturated (two-phase) node with a HOT wall, boiling.
   *
   * Cold walls get the single-phase term and nothing else. See the comment
   * at the branch itself for why there is no condensation term here: it is a
   * wall that cannot nucleate, the vapor-exposed share of the same surface
   * already carries condensation, and the latent heat is in the node's
   * (u,v) bookkeeping either way.
   *
   * Hot walls (boiling): the full boiling curve. Below the critical heat
   * flux the same saturated-Thom nucleate term applies. Past the boiling
   * crisis the wall progressively vapor-blankets: we model transition
   * boiling as partial surface wetting - a wetted fraction f that falls
   * smoothly (logistic in log-superheat) from ~0.9 at the CHF superheat
   * (Thom inverted at the Zuber flux) to ~0.1 at the minimum-film-boiling
   * superheat (homogeneous nucleation limit, Lienhard). The dry fraction
   * transfers by Bromley film boiling
   * plus radiation across the vapor film. The result is the classic
   * N-shaped q(dT) curve - nucleate rise, transition collapse, slow film-
   * boiling recovery - with no thresholds, no hysteresis, and every branch
   * evaluated from the same saturated-property tables.
   */
  private liquidHeatTransferCoeff(
    flowNode: FlowNode,
    state: SimulationState,
    conn: ConvectionConnection,
    D_flow: number,
    D_heater: number,
    cache: ConvectionNodeProps,
  ): number {
    return liquidWallHeatTransfer(
      flowNode, state, conn, D_flow, D_heater, cache).total;
  }


  /**
   * Vapor-exposed surface. Three mechanisms on the ACTUAL gas mixture's
   * properties - steam blended with any NCG by vapor-space mole fraction:
   * forced convection, natural convection, and condensation when the wall is
   * below the local dew point. See vaporWallHeatTransfer for the model; this
   * is the thin wrapper that keeps the operator's call site tidy.
   */
  private vaporHeatTransferCoeff(
    flowNode: FlowNode,
    state: SimulationState,
    D: number,
    T_wall: number,
    conn: ConvectionConnection | undefined,
    cache: ConvectionNodeProps,
  ): number {
    const { total } = vaporWallHeatTransfer(
      flowNode, state, D, T_wall, conn, cache);
    return total;
  }
}

/**
 * The liquid-side wall coefficient, broken into the mechanisms that make it
 * up (W/m²-K).
 *
 * Split out of the operator for the same reason the vapor side was: the
 * composed number is what the plant feels, and it is the composition - a
 * forced term, a floor, and a phase-change term that sometimes REPLACES part
 * of the others - that is easy to get wrong.
 */
export function liquidWallHeatTransfer(
  flowNode: FlowNode,
  state: SimulationState,
  conn: ConvectionConnection,
  D: number,
  D_heater: number = D,
  cache?: ConvectionNodeProps,
): {
  total: number; singlePhase: number; phaseChange: number;
  natural: number; forced: number; Re: number;
} {
    const fluid = flowNode.fluid;
    const T = fluid.temperature;

    const totalMassFlow = nodeThroughput(state, flowNode.id, cache?.throughput);
    const { rho, mu, k, cp, Pr, beta } = liquidPropsFor(flowNode, cache);

    // The passage washing THIS surface, which in a rod bundle is not the
    // node's bore: the rods take 36% of it.
    const flowArea = conn.flowPassageArea ?? flowNode.flowArea;
    const velocity = totalMassFlow / (rho * flowArea);
    const Re = (rho * velocity * D) / mu;

    // Forced convection. Dittus-Boelter is a turbulent correlation and the
    // laminar branch is not it, but the natural-convection term below is what
    // actually carries a quiescent surface, so the forced part is left to
    // fade out with Re rather than being switched off at 2300.
    const h_forced = Re > 0
      ? (0.023 * Math.pow(Re, 0.8) * Math.pow(Pr, 0.4) * k) / D
      : 0;

    // Natural convection, replacing a flat 500 W/m²-K floor. Churchill-Chu on
    // the liquid's own Rayleigh number - and beta here is a REAL property,
    // not the ideal gas's 1/T: water's expansivity is ten times smaller than
    // 1/T at room temperature, passes through zero at its 4 C density
    // maximum, and diverges at the critical point, which is why near-critical
    // natural circulation is so vigorous.
    const thermalNode = state.thermalNodes.get(conn.thermalNodeId);
    const dTwall = thermalNode ? Math.abs(thermalNode.temperature - T) : 0;
    const h_natural = naturalConvectionCoeff(
      Math.abs(beta) * dTwall, rho, mu, k, cp, D);

    // Same cubic blend the vapor side uses: smooth everywhere, and it reduces
    // to whichever mechanism is doing the work.
    let h = Math.cbrt(
      h_natural * h_natural * h_natural + h_forced * h_forced * h_forced);
    const singlePhase = h;
    let phaseChange = 0;

    // Boiling on a HOT wall in a saturated node. There is deliberately no
    // matching branch for a cold one.
    //
    // Nucleate boiling is a wall process: vapor is generated AT the surface,
    // out of cavities that only nucleate when the wall is superheated, and
    // the correlation is really a statement about how many of those sites are
    // active. A subcooled wall nucleates nothing, so there is no
    // wall-anchored condensation phenomenon for an inverted boiling
    // correlation to describe - which is what used to sit here, Thom run
    // backwards on the wetted fraction of a cold wall.
    //
    // What condensation there is happens on the VAPOR-exposed share of the
    // surface, and effectiveSurfaceAreas already splits it off and hands it
    // to the condensation model on the vapor side. Adding a phase-change term
    // to the wetted share on top of that describes the same vapor twice.
    //
    // Nor is any latent heat lost by dropping it: phase comes from (u,v), so
    // energy taken out of a two-phase node condenses vapor inside the node as
    // a matter of bookkeeping. `h` only ever set the RATE.
    //
    // Measured before removing it, because it was not dead code - it fired on
    // 60-80% of samples on every outer casing wall in every water preset, and
    // was 93-95% of those surfaces' coefficient. It made no difference
    // anyway: on all of them the far side is a gas, and a 7 W/m²-K gas film
    // against a 17000 W/m²-K liquid one IS the resistance. Settled pwr, with
    // against without: 360.4 vs 364.2 kW across the wall, SG duty 1040903 vs
    // 1039918 kW, the wall sitting 0.338 vs 0.526 K under the fluid. What it
    // did change is how fast the wall gets there - about 20x - so casing
    // metal now takes minutes rather than seconds to find its offset.
    if (fluid.phase === 'two-phase') {
      const thermalNode = state.thermalNodes.get(conn.thermalNodeId);
      if (thermalNode && thermalNode.temperature > fluid.temperature) {
        // Full boiling curve with post-CHF collapse. Convection and nucleate
        // boiling act only on the wetted fraction; the vapor film replaces
        // (not augments) them on the rest of the surface - this IS the h
        // collapse.
        // D_heater, not D_flow: Bromley film boiling is about the cylinder
        // the vapor film is wrapped around.
        const { wettedFraction, h_phaseChange } = boilingCurve(
          fluid.temperature, fluid.pressure, thermalNode.temperature, D_heater
        );
        h = wettedFraction * h + h_phaseChange;
        phaseChange = h_phaseChange;
      }
    }

    return { total: h, singlePhase, phaseChange, natural: h_natural, forced: h_forced, Re };
}

/**
 * The vapor-side wall coefficient, broken into the mechanisms that make it
 * up (W/m²-K, all referred to |T_bulk - T_wall|).
 *
 * Split out of the operator so the composed path - not just its pieces - can
 * be tested directly: it is the interaction between the sensible layer and
 * the mass transfer riding on it that is easy to get wrong.
 */
export function vaporWallHeatTransfer(
  flowNode: FlowNode,
  state: SimulationState,
  D: number,
  T_wall: number,
  conn?: ConvectionConnection,
  cache?: ConvectionNodeProps,
): { total: number; sensible: number; condensation: number; natural: number; forced: number } {
  const totalMassFlow = nodeThroughput(state, flowNode.id, cache?.throughput);
  const T = flowNode.fluid.temperature;
  const { k, mu, cpMass, M, Pr, rho_g, nSteam, nNcg } = vaporPropsFor(flowNode, cache);

  const flowArea = conn?.flowPassageArea ?? flowNode.flowArea;
  const velocity = totalMassFlow > 0 ? totalMassFlow / (rho_g * flowArea) : 0;
  const Re = (rho_g * velocity * D) / mu;

  // --- Sensible heat: forced and natural convection, blended -------------
  // Dittus-Boelter for the forced part. Below the transition it does not
  // apply, and the churn that IS there is what the natural-convection term
  // describes, so the forced contribution simply fades out with Re instead
  // of being switched off at 2300.
  const h_forced = Re > 0
    ? (0.023 * Math.pow(Re, 0.8) * Math.pow(Pr, 0.4) * k) / D
    : 0;

  // What the gas looks like right at the wall. On a condensing wall that
  // is NOT just cooler gas - steam has been removed from it, so it is
  // heavier by composition as well as by temperature, and on a steam/air
  // wall the composition term is the bigger of the two by a factor of
  // three. That is the buoyancy actually driving the boundary layer.
  const iface = wallAdjacentGas(flowNode, T, T_wall, nSteam, nNcg, M);
  const h_natural = naturalConvectionCoeff(
    iface.relativeDensityDifference, rho_g, mu, k, cpMass, D);

  // Churchill's cubic blend of the two limits: smooth everywhere, and it
  // reduces to whichever mechanism is actually doing the work. The old
  // code took max(50, forced), which both hid the natural-convection
  // physics behind a constant and put a hard corner at Re = 2300.
  const h_sensible = Math.cbrt(
    h_natural * h_natural * h_natural + h_forced * h_forced * h_forced);

  // --- Latent heat: condensation on a wall below the local dew point ----
  const h_cond = condensationCoeff(
    flowNode, T, T_wall, nSteam, nNcg, h_sensible, Pr, D,
    { rho: rho_g, mu, k }, iface);

  // The sensible and latent paths act on the same surface at once, so they
  // add. Both are referred to the SAME (T_bulk - T_wall) the caller
  // multiplies by, which is what makes that legitimate.
  return {
    total: h_sensible + h_cond,
    sensible: h_sensible,
    condensation: h_cond,
    natural: h_natural,
    forced: h_forced,
  };
}

/**
 * The state of the gas immediately against the wall, and how much heavier or
 * lighter it is than the bulk.
 *
 * On a dry wall this is just "the same gas, at the wall temperature", and the
 * relative density difference reduces to |dT|/T - the ordinary ideal-gas
 * thermal buoyancy. On a CONDENSING wall it is a different gas: steam has
 * been taken out of it, leaving the non-condensables behind at the interface
 * partial pressure, so it is heavier by composition as well as by
 * temperature. In a steam/air containment that composition term is about
 * three times the thermal one, and leaving it out under-predicts the
 * boundary layer by half.
 *
 * One expression covers both cases, which is the point: there is no
 * condensing-mode branch in the convection correlation, only a density.
 */
interface WallAdjacentGas {
  /** True when the wall is below the local dew point. */
  condensing: boolean;
  /** Dew point of the bulk's steam partial pressure (K). */
  dewPoint: number;
  /** Steam mole fraction in the bulk, and at the interface. */
  yBulk: number;
  yInterface: number;
  /** |rho_wall - rho_bulk| / mean, the buoyancy driving the layer. */
  relativeDensityDifference: number;
}

function wallAdjacentGas(
  flowNode: FlowNode,
  T_bulk: number,
  T_wall: number,
  nSteam: number,
  nNcg: number,
  M_bulk: number,      // bulk mean molecular weight (kg/mol)
): WallAdjacentGas {
  const thermalOnly = T_bulk > 0 ? Math.abs(T_wall - T_bulk) / T_bulk : 0;
  const dry: WallAdjacentGas = {
    condensing: false, dewPoint: 0, yBulk: 0, yInterface: 0,
    relativeDensityDifference: thermalOnly,
  };

  const P = flowNode.fluid.pressure;
  if (!(P > 0) || !(nSteam > 0) || !(T_wall > 0) || !(T_bulk > 0)) return dry;

  // A wall at or above the bulk temperature cannot be below the dew point:
  // the bulk is never colder than its own dew point (they are equal for a
  // saturated node, and the bulk is hotter for a superheated one). Exact, not
  // a tolerance - and it is what keeps the steam-table lookups below off the
  // hot-wall connections, which are most of them in a running plant. Worth
  // ~20% of a four-loop step.
  if (T_wall >= T_bulk) return dry;

  // Dew point above the triple point; FROST POINT below it. Both come out of
  // the same accessor now that the equilibrium line continues onto the
  // sublimation curve, so there is no cold-wall branch here - which matters,
  // because the previous behaviour was worse than missing: saturationPressure
  // clamped to the table's first row, so a wall at 217 K was reported as
  // sitting in equilibrium with 611 Pa of vapour instead of 1.8 Pa, and a
  // trace-moisture gas loop's walls therefore never deposited at all.
  const yBulk = nSteam / (nSteam + nNcg);
  const dewPoint = Water.saturationTemperature(yBulk * P);
  if (T_wall >= dewPoint) return dry;

  const yInterface = Math.min(Water.saturationPressure(T_wall) / P, 1);
  // Mean molecular weight of each side. The non-condensables' own mean is
  // whatever is left once steam is accounted for, and it is the same gas on
  // both sides - only its share changes.
  const M_ncg = nNcg > 0
    ? (M_bulk - yBulk * M_H2O) / Math.max(1 - yBulk, 1e-12)
    : M_H2O;
  const M_interface = yInterface * M_H2O + (1 - yInterface) * M_ncg;
  // Ideal gas at the same total pressure: rho ~ M/T.
  const rhoBulk = M_bulk / T_bulk;
  const rhoInterface = M_interface / T_wall;
  const mean = 0.5 * (rhoBulk + rhoInterface);
  return {
    condensing: true,
    dewPoint,
    yBulk,
    yInterface,
    relativeDensityDifference: mean > 0
      ? Math.abs(rhoInterface - rhoBulk) / mean
      : thermalOnly,
  };
}

/**
 * Natural convection off a vertical surface (W/m²-K), Churchill-Chu:
 *
 *   Nu = { 0.825 + 0.387 Ra^(1/6) / [1 + (0.492/Pr)^(9/16)]^(8/27) }²
 *
 * valid over the whole Rayleigh range - laminar through turbulent - with no
 * regime switch, which is why it is the right shape for a model that must
 * not step. Ra = g (drho/rho) L^3 rho^2 cp / (mu k).
 *
 * The buoyancy comes in as a relative DENSITY difference rather than as
 * beta*dT, because on a condensing wall the density difference is mostly
 * compositional (see wallAdjacentGas). For a dry gas the two are identical -
 * drho/rho = dT/T for an ideal gas at fixed composition - so nothing is
 * special-cased to get the ordinary case back.
 *
 * This replaces a hard-coded 50 W/m²-K. That constant was an order of
 * magnitude too big for a large surface in quiescent gas: it had the Xe-100
 * reactor vessel shedding 3.75 MW into the building air, four times what its
 * cavity cooling panels take, from a coefficient that should be about 7.7.
 * The number now comes out of the fluid's own properties and the buoyancy
 * actually driving it, so a helium space, an air cavity and a steam
 * containment each get their own answer instead of sharing one.
 *
 * Serves the liquid side too, which is the reason the driving term is a
 * relative density difference and not beta*dT with an assumed beta: a gas's
 * expansivity is 1/T, a liquid's is a property with a zero in it (water's, at
 * its 4 C density maximum) and a pole at the critical point. Each caller
 * passes what its own fluid actually does.
 *
 * Exported for direct testing of the correlation.
 */
export function naturalConvectionCoeff(
  relativeDensityDifference: number,  // drho/rho: beta*dT for a liquid, dT/T for a gas
  rho: number,       // gas density (kg/m³)
  mu: number,        // dynamic viscosity (Pa s)
  k: number,         // thermal conductivity (W/m-K)
  cp: number,        // specific heat (J/kg-K)
  L: number,         // characteristic length (m)
): number {
  const drho = Math.abs(relativeDensityDifference);
  if (!(drho > 0) || !(rho > 0) || !(L > 0) || !(mu > 0) || !(k > 0)) return 0;
  const Pr = (cp * mu) / k;
  const Ra = (9.81 * drho * L * L * L * rho * rho * cp) / (mu * k);
  const f = Math.pow(1 + Math.pow(0.492 / Pr, 9 / 16), 8 / 27);
  const Nu = Math.pow(0.825 + (0.387 * Math.pow(Ra, 1 / 6)) / f, 2);
  return (Nu * k) / L;
}

/**
 * Condensation on a wall colder than the local dew point (W/m²-K, referred
 * to the bulk-to-wall temperature difference).
 *
 * TWO resistances in series, which is the whole model - there is no regime
 * switch and no correlation selected by hand:
 *
 *  1. DIFFUSION of steam through the non-condensable gas to the interface.
 *     Non-condensables do not condense, so they pile up at the wall and the
 *     arriving steam has to diffuse through them. Stefan flow through a
 *     stagnant species:
 *         N" = c k_m ln[(1 - y_i)/(1 - y_b)]     [mol/m²s]
 *     with y the steam mole fraction at the interface (i) and in the bulk
 *     (b), c = P/RT, and the mass-transfer coefficient k_m from the
 *     Chilton-Colburn analogy against the sensible-heat correlation already
 *     computed: Sh = Nu (Sc/Pr)^(1/3), k_m = Sh D_AB / L. The diffusivity is
 *     Fuller's, through the actual mixture - so helium, air and CO2 each
 *     hinder condensation by their own transport properties rather than by
 *     a tabulated containment number.
 *
 *  2. CONDUCTION through the condensate film, Nusselt's vertical-plate
 *     result:
 *         h_film = 0.943 [rho_f (rho_f - rho_g) g h_fg k_f^3 /
 *                         (mu_f L (T_sat - T_wall))]^(1/4)
 *
 * Series is what makes the limits come out right without asserting them.
 * Strip the non-condensables and the diffusion resistance vanishes (the log
 * diverges) leaving pure Nusselt - thousands of W/m²-K, the textbook
 * pure-steam answer. Add a per cent of air and the diffusion term collapses
 * onto the tens-to-hundreds that containment experiments actually measure.
 * The old single constant of 50 sat in the middle of that range and could
 * not tell the two cases apart.
 *
 * A wall ABOVE the dew point returns zero: there is no film on it, and this
 * model does not track wall liquid, so there is nothing available to
 * evaporate. The value is continuous through that crossing (it goes to zero
 * there) - the same one-sided shape boilingCurve already has.
 *
 * Exported for direct testing.
 */
export function condensationCoeff(
  flowNode: FlowNode,
  T_bulk: number,
  T_wall: number,
  nSteam: number,     // mol of steam in the vapor space
  nNcg: number,       // mol of non-condensables sharing it
  h_sensible: number, // the sensible-side coefficient, for the analogy
  Pr: number,
  L: number,
  // The SAME blended mixture properties the sensible side used. Handing this
  // the non-condensables' own numbers instead quietly puts the analogy on a
  // different boundary layer than the one it is an analogy TO, which for a
  // helium space (k is ten times air's) is not a small error.
  gas: { rho: number; mu: number; k: number },
  // The interface state, already solved once for the buoyancy the sensible
  // side needed. Shared rather than recomputed so the two cannot disagree
  // about whether this wall is condensing.
  iface: WallAdjacentGas,
): number {
  const dT = T_bulk - T_wall;
  if (!(dT > 0) || !(nSteam > 0) || !(L > 0)) return 0;
  if (!iface.condensing) return 0;        // dry wall: nothing to condense onto

  const P_total = flowNode.fluid.pressure;
  if (!(P_total > 0)) return 0;

  const { yBulk, yInterface, dewPoint: T_dew } = iface;

  const h_fg = Water.latentHeat(T_dew);
  const rho_f = Water.saturatedLiquidDensity(T_dew);
  const rho_g = Water.saturatedVaporDensity(T_dew);
  const mu_f = Water.liquidViscosity(T_dew);
  const k_f = Water.liquidThermalConductivity(T_dew);

  // Film conduction (Nusselt). The film's own temperature drop is dew point
  // to wall, which is not the bulk-to-wall difference the caller works in -
  // a superheated bulk sits above its own dew point. Refer it to the
  // caller's difference so the two resistances can be added.
  const dTfilm = Math.max(T_dew - T_wall, 1e-6);
  const h_film = 0.943 * Math.pow(
    (rho_f * Math.max(rho_f - rho_g, 1) * 9.81 * h_fg * k_f * k_f * k_f) /
    (mu_f * L * dTfilm), 0.25);
  const h_film_ref = h_film * (dTfilm / dT);

  // Diffusion through the non-condensables. With none present the log
  // diverges and the series reduces to the film alone, which is the correct
  // pure-steam limit rather than a special case.
  let h_diffusion = Infinity;
  if (nNcg > 0 && yInterface < 1) {
    const ncg = flowNode.fluid.ncg ?? emptyGasComposition();
    const D_AB = diffusivityInMixture('H2O', ncg, nSteam, T_bulk, P_total);
    const Sc = gas.mu / (gas.rho * D_AB);
    // Chilton-Colburn: the same boundary layer transports heat and mass, so
    // the mass-transfer coefficient rides on the heat-transfer one already
    // computed rather than needing its own correlation.
    const Nu = (h_sensible * L) / Math.max(gas.k, 1e-6);
    const Sh = Nu * Math.cbrt(Sc / Math.max(Pr, 1e-6));
    const k_m = (Sh * D_AB) / L;                  // m/s
    const c = P_total / (8.31446 * T_bulk);       // mol/m³
    // ln[(1 - y_i)/(1 - y_b)] > 0 exactly when the interface is drier than
    // the bulk, i.e. when steam is actually moving toward the wall.
    const logDriving = Math.log((1 - yInterface) / Math.max(1 - yBulk, 1e-12));
    if (!(logDriving > 0)) return 0;
    const molarFlux = c * k_m * logDriving;       // mol/m²s
    const q = molarFlux * M_H2O * h_fg;           // W/m²
    h_diffusion = q / dT;
  }

  // Both terms now speak in the caller's units, so they add as resistances.
  return 1 / (1 / h_diffusion + 1 / Math.max(h_film_ref, 1e-9));
}

/**
 * Zuber pool-boiling critical heat flux (W/m²):
 *   q_CHF = 0.131 * h_fg * rho_g^0.5 * [sigma * g * (rho_f - rho_g)]^0.25
 * Surface tension from the standard IAPWS-shaped fit
 * sigma = 0.2358*(1 - T/647.096)^1.256*(1 - 0.625*(1 - T/647.096)).
 * ~1.1 MW/m² at 1 bar, peaking ~3.9 MW/m² near 70 bar, falling toward zero
 * at the critical point - all from the same saturated-property tables.
 */
function zuberCriticalHeatFlux(T: number): number {
  const Tr = Math.max(0, 1 - T / 647.096);
  const sigma = 0.2358 * Math.pow(Tr, 1.256) * (1 - 0.625 * Tr);
  const rho_f = Water.saturatedLiquidDensity(T);
  const rho_g = Water.saturatedVaporDensity(T);
  const h_fg = Math.max(1e4, Water.latentHeat(T));
  const g = 9.81;
  return 0.131 * h_fg * Math.sqrt(rho_g) * Math.pow(sigma * g * Math.max(0, rho_f - rho_g), 0.25);
}

/**
 * Hot-wall boiling curve for a wetted surface at saturation temperature
 * T_sat and pressure P facing a wall at T_wall (> T_sat), with characteristic
 * diameter D. Returns:
 *  - wettedFraction f: the surface fraction still in liquid contact, falling
 *    smoothly (logistic in log-superheat) from ~0.9 at the CHF superheat
 *    (Thom inverted at the Zuber flux) to ~0.1 at the minimum-film-boiling
 *    superheat (homogeneous nucleation limit, Lienhard's correlation).
 *    Transition boiling is physically patchy wetting, so
 *    blending by surface fraction is the mechanism, not just an
 *    interpolation trick. The caller scales its single-phase convective h by
 *    f, since dry patches see no liquid convection either.
 *  - h_phaseChange: f * (saturated-Thom nucleate h) + (1-f) * (Bromley film
 *    boiling + radiation).
 * Together these produce the classic N-shaped q(dT) curve: nucleate rise,
 * transition collapse, slow film-boiling recovery.
 *
 * Near the critical point dT_MFB and dT_CHF both -> 0 and can cross; the
 * half-width floor (0.1 in ln-space) only sets how sharply the degenerate
 * curve rolls over, never the pre- or post-CHF values.
 *
 * Exported for direct testing of the curve shape.
 */
export function boilingCurve(
  T_sat: number, P: number, T_wall: number, D: number
): { wettedFraction: number; h_phaseChange: number } {
  const dT = T_wall - T_sat;
  const qCHF = zuberCriticalHeatFlux(T_sat);
  if (!(dT > 0) || !(qCHF > 0)) return { wettedFraction: 1, h_phaseChange: 0 };

  const qThom = Math.pow((dT * Math.exp(P / 8.7e6)) / 22.65, 2) * 1e6;
  const qNb = qThom / (1 + qThom / qCHF);

  // Superheat where nucleate boiling reaches the Zuber flux (Thom inverted
  // at qCHF), and where the film first becomes stable (Berenson).
  const dT_CHF = 22.65 * Math.sqrt(qCHF / 1e6) * Math.exp(-P / 8.7e6);
  const dT_MFB = minFilmBoilingSuperheat(T_sat);

  const lnHi = Math.log(Math.max(dT_MFB, dT_CHF));
  const lnLo = Math.log(dT_CHF);
  const lnMid = 0.5 * (lnHi + lnLo);
  // Half-width floor (ln-space): only active in the near-critical degenerate
  // regime where dT_MFB collapses onto dT_CHF; it spreads the f rolloff over
  // ~a factor of 2 in superheat so the curve stays integrator-friendly. It
  // never changes the fully-wetted or fully-filmed levels.
  const lnHalfWidth = Math.max(0.5 * (lnHi - lnLo), 0.35);
  const z = ((Math.log(dT) - lnMid) / lnHalfWidth) * Math.log(9);
  const f = 1 / (1 + Math.exp(z));

  const h_film = filmBoilingCoeff(T_sat, T_wall, D);
  return { wettedFraction: f, h_phaseChange: f * (qNb / dT) + (1 - f) * h_film };
}

/**
 * Minimum-film-boiling superheat (K) - the wall superheat above which a
 * stable vapor film cannot be rewetted, taken as the homogeneous-nucleation
 * (liquid superheat) limit via Lienhard's correlation:
 *   T_hn / T_c = 0.905 + 0.095 * (T_sat/T_c)^8
 * Liquid physically cannot contact a wall hotter than its superheat limit,
 * so this is the thermodynamic Leidenfrost point. Surface-condition
 * correlations (Berenson) extrapolate absurdly above a few bar; this form is
 * what severe-accident codes fall back on, is smooth in T_sat alone, and is
 * exactly T_c at the critical point. ~210 K superheat at 1 bar, ~45 K at
 * 70 bar, -> 0 at the critical point.
 */
function minFilmBoilingSuperheat(T_sat: number): number {
  const T_c = 647.096;
  const T_hn = T_c * (0.905 + 0.095 * Math.pow(T_sat / T_c, 8));
  return Math.max(0, T_hn - T_sat);
}

/**
 * Film-boiling heat transfer coefficient (W/m²-K) for a dry (vapor-
 * blanketed) patch: Bromley's correlation for film boiling on a cylinder of
 * diameter D, with vapor conductivity/viscosity evaluated at the film
 * temperature (linear fits to steam data, 400-1100 K), latent heat augmented
 * for vapor superheating, plus Bromley's standard 0.75-weighted radiation
 * term (emissivity 0.8, oxidized cladding/steel). ~150-300 W/m²-K for water
 * near atmospheric pressure - the collapsed post-CHF coefficient that lets
 * fuel run away thermally.
 */
function filmBoilingCoeff(T_sat: number, T_wall: number, D: number): number {
  const dT = T_wall - T_sat;
  const T_film = 0.5 * (T_wall + T_sat);

  // Superheated-steam transport properties at the film temperature
  const k_g = Math.max(0.02, 1.06e-4 * T_film - 0.016);  // W/m-K
  const mu_g = Math.max(1e-5, 3.7e-8 * T_film - 5e-7);   // Pa·s
  const cp_g = 2100;                                      // J/kg-K

  const rho_f = Water.saturatedLiquidDensity(T_sat);
  const rho_g = Water.saturatedVaporDensity(T_sat);
  const h_fg = Math.max(1e4, Water.latentHeat(T_sat));
  const dRho = Math.max(1e-6, rho_f - rho_g);
  const g = 9.81;

  // Bromley, with the effective latent heat h'_fg = h_fg (1 + 0.4 cp dT/h_fg)
  const h_fg_eff = h_fg * (1 + (0.4 * cp_g * dT) / h_fg);
  const h_conv = 0.62 * Math.pow(
    (Math.pow(k_g, 3) * rho_g * dRho * g * h_fg_eff) / (mu_g * D * dT),
    0.25
  );

  // Radiation across the film (linearized coefficient)
  const eps = 0.8;
  const sigmaSB = 5.67e-8;
  const h_rad = (eps * sigmaSB * (Math.pow(T_wall, 4) - Math.pow(T_sat, 4))) / dT;

  return h_conv + 0.75 * h_rad;
}

// ============================================================================
// Heat Generation Rate Operator (for reactor cores)
// ============================================================================

// Share of total decay power carried by the volatile fission products
// (noble gases + iodine/cesium class) - the species our release model
// tracks. Roughly 30% at accident timescales; the balance is non-volatile
// FPs that stay with the fuel.
const VOLATILE_DECAY_SHARE = 0.30;

export class HeatGenerationRateOperator implements RateOperator {
  name = 'HeatGeneration';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    // Publish reactor power for the UI (thermal deposit = prompt fission
    // fraction + decay heat, same formula as the fuel-node deposit below)
    {
      const n = state.neutronics;
      const fission = n.coreId ? n.power : 0;
      let decayPower = 0;
      if (n.decayHeatPools) {
        for (const q of n.decayHeatPools) decayPower += q;
      }
      const thermalPower = n.decayHeatPools && n.decayHeatPools.length > 0
        ? (1 - DECAY_HEAT_TOTAL_FRACTION) * fission + decayPower
        : fission;
      lastReactorPower = {
        coreId: n.coreId ?? null,
        fissionPower: fission,
        decayHeatPower: decayPower,
        thermalPower,
        nominalPower: n.nominalPower,
      };
    }

    // Add heat generation to thermal nodes
    for (const [id, node] of state.thermalNodes) {
      // Fuel nodes linked to neutronics receive the reactor power. This must
      // NOT be gated on the static heatGeneration field: factory-built cores
      // create their fuel node with heatGeneration = 0 ("set by neutronics"),
      // and gating on it silently disconnected reactor power from the thermal
      // system entirely - no fuel heatup, and therefore no Doppler feedback
      // to quench reactivity excursions.
      const isNeutronicsFuel = state.neutronics.fuelNodeId
        ? id === state.neutronics.fuelNodeId
        : id.includes('fuel'); // legacy fallback when no explicit linkage exists
      if (state.neutronics.coreId && isNeutronicsFuel) {
        // Thermal deposit = prompt fission fraction + fission-product decay
        // heat. Equals P_fission at equilibrium; after shutdown the pools
        // keep ~5% of prior power flowing (decaying), so a scrammed core
        // still needs cooling - the thing the old model got wrong.
        const fission = state.neutronics.power;
        const pools = state.neutronics.decayHeatPools;
        let deposit = fission;
        if (pools && pools.length > 0) {
          let decayPower = 0;
          for (const q of pools) decayPower += q;
          deposit = (1 - DECAY_HEAT_TOTAL_FRACTION) * fission + decayPower;

          // Decay heat follows the fission products. The volatile species
          // (noble gases, iodine/cesium class) carry roughly 30% of decay
          // power; whatever fraction of them has escaped the fuel takes its
          // share of the decay heat along - deposited wherever the Xe/CsI
          // actually is (including plate-out), or lost with the moles that
          // reached the environment.
          const fp = node.fissionProducts;
          const initialFp = (fp?.initialNobleGas ?? 0) + (fp?.initialVolatile ?? 0);
          if (fp && initialFp > 0) {
            const releasedFrac = Math.max(0, 1 - (fp.nobleGas + fp.volatile) / initialFp);
            const escapedPower = decayPower * VOLATILE_DECAY_SHARE * releasedFrac;
            if (escapedPower > 0) {
              // Weigh by where the escaped moles actually are
              let totalEscapedMoles = 0;
              const nodeMoles: Array<[string, number]> = [];
              for (const [fnId, fn] of state.flowNodes) {
                const moles = (fn.fluid.ncg?.Xe ?? 0) + (fn.fluid.ncg?.CsI ?? 0) + (fn.depositedCsI ?? 0);
                if (moles > 0 && !fn.isBoundary) nodeMoles.push([fnId, moles]);
                if (moles > 0) totalEscapedMoles += moles;
              }
              // Environment share simply leaves the plant energy balance
              totalEscapedMoles += (state.environmentalRelease?.Xe ?? 0) +
                (state.environmentalRelease?.CsI ?? 0);

              if (totalEscapedMoles > 0) {
                deposit -= escapedPower;
                for (const [fnId, moles] of nodeMoles) {
                  const q = escapedPower * (moles / totalEscapedMoles);
                  const existing = rates.flowNodes.get(fnId);
                  if (existing) {
                    existing.dEnergy += q;
                  } else {
                    rates.flowNodes.set(fnId, { dMass: 0, dEnergy: q });
                  }
                }
              }
            }
          }
        }
        // Relocated melt keeps its decay heat: split the fuel deposit by
        // FUEL-OXIDE mass over the in-core fuel node, its corium pool, and
        // the ex-vessel debris bed (seed masses ~1 kg make the split a
        // no-op until relocation happens). Unoxidized metal and concrete
        // slag stirred into a melt carry no fission products, so they get
        // no share - a slag-diluted MCCI pool has a lower specific decay
        // power, as it should.
        let oxideTotal = node.mass; // in-core fuel is pure fuel oxide
        const meltNodes: Array<{ melt: (typeof node); oxide: number }> = [];
        for (const loc of node.meltLocations ?? []) {
          const melt = state.thermalNodes.get(loc.nodeId);
          if (melt && melt.mass > 2) {
            const oxide = fuelOxideMass(melt);
            if (oxide > 0) {
              meltNodes.push({ melt, oxide });
              oxideTotal += oxide;
            }
          }
        }
        for (const { melt, oxide } of meltNodes) {
          const q = deposit * (oxide / oxideTotal);
          const mRates = rates.thermalNodes.get(melt.id) || { dTemperature: 0 };
          mRates.dTemperature += q / nodeHeatCapacity(melt);
          rates.thermalNodes.set(melt.id, mRates);
        }
        deposit *= node.mass / oxideTotal;
        const dT = deposit / nodeHeatCapacity(node);
        const fuelRates = rates.thermalNodes.get(id) || { dTemperature: 0 };
        fuelRates.dTemperature += dT;
        rates.thermalNodes.set(id, fuelRates);
      } else if (node.heatGeneration > 0) {
        // Other heat-generating nodes use their fixed rate
        const dT = node.heatGeneration / nodeHeatCapacity(node);
        rates.thermalNodes.set(id, { dTemperature: dT });
      }
    }

    // Electric heaters immersed in flow nodes (pressurizer heaters etc.):
    // heaterPower is set by a heater-power controller actuator or the user.
    // Heaters on a dead bus heat nothing (electrical.ts; absent = powered).
    for (const [id, node] of state.flowNodes) {
      if (node.isBoundary) continue;
      const q = node.heaterPowered === false ? 0 : (node.heaterPower ?? 0);
      if (q > 0) {
        const existing = rates.flowNodes.get(id);
        if (existing) {
          existing.dEnergy += q;
        } else {
          rates.flowNodes.set(id, { dMass: 0, dEnergy: q });
        }
      }
    }

    return rates;
  }
}

// ============================================================================
// Neutronics Rate Operator
// ============================================================================

// The decay-heat group fit lives with the rest of the neutronics parameters
// (the neutron source model reads the pool inventory too); re-exported here
// because this is where the pools are integrated and where callers look.
export { DECAY_HEAT_GROUPS, DECAY_HEAT_TOTAL_FRACTION } from './neutronics';

export class NeutronicsRateOperator implements RateOperator {
  name = 'Neutronics';

  /**
   * Stability ceiling: the prompt-jump branch relaxes N toward equilibrium
   * with tau capped at 50 ms (see computeRates). That linear mode has
   * eigenvalue -20/s; explicit RK45 is stable only to dt*lambda ~ -3.3, so
   * steps beyond ~0.16 s diverge SLOWLY (small per-step error, accepted by
   * the error controller) - observed as fission power oscillating negative
   * and draining the decay-heat pools at dt=0.2 s. Cap with margin.
   */
  getMaxStableDt(state: SimulationState): number {
    return state.neutronics.coreId ? 0.12 : Infinity;
  }

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
    // Neutron source in normalized units (fraction of nominal fission power
    // per second) - see neutronics.ts. This is what gives the subcritical
    // equations a positive steady state N_ss = S*Lambda/(-rho) instead of
    // decaying toward zero, so a shut-down core sits at a physical
    // source-driven level and a restart takes the real amount of time.
    const S = normalizedNeutronSource(n);

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
      //
      // With the neutron source S the prompt equilibrium is
      //   N_eq = (λ*C + S) * Λ / (β - ρ)
      // and substituting it into the precursor equation gives
      //   dC/dt = (λ*C*ρ + β*S) / (β - ρ)
      // whose zero is C_ss = β*S/(λ*(-ρ)) - the source-driven precursor
      // level a shut-down core relaxes onto, with N_ss = S*Λ/(-ρ).

      dC_dt = (lambda * C * rho + beta * S) / subcriticalMargin;

      // Power follows equilibrium with precursors (and the source)
      const N_eq = (lambda * C + S) * Lambda / subcriticalMargin;

      // Rate of power change = rate of approach to equilibrium. Physically
      // this IS the prompt jump - timescale Λ/(β-ρ), sub-millisecond - so N
      // should snap to N_eq essentially instantly. Cap the relaxation at
      // 50 ms so the adaptive step controller can resolve it instead of
      // integrating a stiff sub-ms mode. Do NOT slow this to the precursor
      // timescale (1/λ ~ 12 s): a quenched power excursion would then
      // "coast" at GW-scale fission power for tens of seconds, releasing
      // orders of magnitude more energy than the physics allows.
      const tau_prompt = Lambda / subcriticalMargin;
      const tau_relax = Math.max(0.05, tau_prompt);
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

      const result = this.analyticalPointKinetics(N, C, rho, beta, Lambda, lambda, S);
      dN_dt = result.dN_dt;
      dC_dt = result.dC_dt;
    }

    // Convert back to absolute power rate
    rates.neutronics.dPower = dN_dt * n.nominalPower;
    rates.neutronics.dPrecursorConcentration = dC_dt;

    // Fission-product decay heat pools: dQ_g/dt = lambda_g*(f_g*P - Q_g).
    // States without pools (pre-upgrade snapshots) simply don't get them -
    // the factory initializes pools at equilibrium for every real sim.
    const pools = n.decayHeatPools;
    if (pools) {
      if (pools.length !== DECAY_HEAT_GROUPS.length) {
        throw new Error(
          `[Neutronics] decayHeatPools has ${pools.length} groups, expected ${DECAY_HEAT_GROUPS.length}`
        );
      }
      rates.neutronics.dDecayHeatPools = DECAY_HEAT_GROUPS.map(
        (g, i) => g.lambda * (g.fraction * n.power - pools[i])
      );
    }

    return rates;
  }

  /**
   * Analytical solution to point kinetics equations for near-critical reactivity.
   *
   * Solves the 2x2 affine system:
   *   dN/dt = a*N + b*C + S  where a = (ρ-β)/Λ, b = λ
   *   dC/dt = c*N + d*C            c = β/Λ,     d = -λ
   *
   * Uses matrix exponential via eigenvalue decomposition, with the source
   * carried by the particular solution x_src(t) = Σ_i b_i v_i (e^(λ_i t)-1)/λ_i
   * (the eigen-decomposition of ∫exp(As)ds·[S,0]ᵀ; that form stays finite as
   * an eigenvalue passes through zero, unlike the -A⁻¹[S,0]ᵀ fixed point,
   * which diverges at ρ = 0).
   * Returns effective rates (change per unit time).
   *
   * @param N - Normalized power (N = P / P_nominal)
   * @param C - Precursor concentration
   * @param rho - Reactivity
   * @param beta - Delayed neutron fraction
   * @param Lambda - Prompt neutron lifetime (s)
   * @param lambda - Precursor decay constant (1/s)
   * @param S - Neutron source in normalized units (1/s)
   */
  private analyticalPointKinetics(
    N: number,
    C: number,
    rho: number,
    beta: number,
    Lambda: number,
    lambda: number,
    S: number
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

    // Secant window for the effective rate. Nominally 100 ms (precursor
    // scale, long enough that the fast NEGATIVE prompt eigenvalue fully
    // relaxes - that is the point of the analytic solution). But a POSITIVE
    // eigenvalue grows: for a prompt-supercritical core λ₁ ≈ (ρ-β)/Λ can
    // reach 10³-10⁴ 1/s, and exp(λ₁·0.1) overflows double precision, turning
    // the power rate into Inf-Inf = NaN. Worse, any exponent cap much above
    // O(1) yields secant slopes of e^cap·N that make force-accepted minimum-dt
    // steps jump power by astronomical factors before Doppler feedback can
    // respond. Capping the POSITIVE exponent at 3 keeps the secant slope
    // within ~7x of the true tangent λ₁N, so the excursion integrates like
    // explicit dynamics: the step controller resolves it, fuel heats, and
    // Doppler quenches it physically. Negative eigenvalues are left alone
    // (exp underflows harmlessly to 0).
    const growthEigenvalue = D >= 0
      ? (tr + Math.sqrt(Math.max(0, D))) / 2
      : tr / 2;
    const dt = growthEigenvalue > 30 ? 3 / growthEigenvalue : 0.1;

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
          dN_dt: a * N + b * C + S,
          dC_dt: c * N + d * C,
        };
      }

      const c1 = (v2_C * N - v2_N * C) / detV;
      const c2 = (-v1_C * N + v1_N * C) / detV;

      // Source vector [S, 0]ᵀ in the same eigenbasis
      const s1 = v2_C * S / detV;
      const s2 = -v1_C * S / detV;

      // Solution at time dt
      const exp1 = Math.exp(lambda1 * dt);
      const exp2 = Math.exp(lambda2 * dt);

      // (e^(λ dt) - 1)/λ, the time integral of e^(λ t) over the window;
      // expm1 keeps it accurate, and the λ→0 limit is the window itself.
      const g1 = Math.abs(lambda1 * dt) < 1e-12 ? dt : Math.expm1(lambda1 * dt) / lambda1;
      const g2 = Math.abs(lambda2 * dt) < 1e-12 ? dt : Math.expm1(lambda2 * dt) / lambda2;

      N_new = c1 * v1_N * exp1 + c2 * v2_N * exp2 + s1 * v1_N * g1 + s2 * v2_N * g2;
      C_new = c1 * v1_C * exp1 + c2 * v2_C * exp2 + s1 * v1_C * g1 + s2 * v2_C * g2;
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
      // Source over the window, to first order. Complex eigenvalues need
      // D = tr² + 4λρ/Λ < 0 and hence ρ < 0, which this branch is never
      // entered with (the caller uses it only for ρ > β - 0.001), so the
      // exact particular solution would be dead code.
      N_new += S * dt;
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
      // Source over the window, to first order - as above, a repeated
      // eigenvalue needs 4λρ/Λ = -tr² <= 0 and so ρ <= 0, unreachable from
      // this method's only caller.
      N_new += S * dt;
    }

    // Return effective rates
    return {
      dN_dt: (N_new - N) / dt,
      dC_dt: (C_new - C) / dt,
    };
  }

  private computeTotalReactivity(n: any, state: SimulationState): number {
    const fuelTemp = this.getAverageFuelTemperature(state, n);
    const coolantTemp = this.getAverageCoolantTemperature(state, n);
    const coolantDensity = this.getAverageCoolantDensity(state, n);

    const { total, breakdown } = computeReactivityComponents(n, {
      fuelTemp,
      coolantTemp,
      coolantDensity,
      relocatedFuelFraction: getRelocatedFuelFraction(n, state),
    });

    // Store diagnostics on the evaluated state so displays and logs see the
    // live reactivity (rate operators otherwise never write state, and
    // n.reactivity would stay frozen at its initial value forever).
    n.reactivity = total;
    n.reactivityBreakdown = breakdown;
    n.diagnostics = { fuelTemp, coolantTemp, coolantDensity };

    return total;
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

// Rate limiter for the getSpecificEnthalpy diagnostic dump (wall-clock ms).
// Without it, a persistently-suspicious node logs 8 lines on every rate
// evaluation (7+ per RK45 step) and console I/O dominates the frame time.
let lastEnthalpyDebugLog = 0;

export class FlowRateOperator implements RateOperator {
  // Reusable scratch for drawCompositionAt on the per-stage pricing loop -
  // consumed within each iteration, never retained (see the `out` param).
  private drawScratch: DrawComposition = {
    phase: 'mixture', fLiquid: 0, fMixture: 1, fVapor: 0,
    wLiquid: 0, wMixture: 1, wVapor: 0, rho: 0,
  };

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
      // Nearly-implicit advection owns this connection's transport for this
      // step (stamped by the once-per-step pass; see FlowConnection type).
      if (conn.implicitAdvection) continue;
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
      let upstreamOpeningHeight: number | undefined;

      if (massFlow >= 0) {
        upstreamNode = fromNode;
        upstreamId = conn.fromNodeId;
        downstreamId = conn.toNodeId;
        upstreamElevation = conn.fromElevation;
        upstreamPhaseTolerance = conn.fromPhaseTolerance;
        upstreamOpeningHeight = conn.fromOpeningHeight;
      } else {
        upstreamNode = toNode;
        upstreamId = conn.toNodeId;
        downstreamId = conn.fromNodeId;
        upstreamElevation = conn.toElevation;
        upstreamPhaseTolerance = conn.toPhaseTolerance;
        upstreamOpeningHeight = conn.toOpeningHeight;
      }

      const absMassFlow = Math.abs(massFlow);

      // Determine what phase is actually flowing based on connection elevation
      // For two-phase nodes, we need to use phase-specific enthalpy
      // Pass mass flow rate so separation calculation can account for turbulence
      let comp = drawCompositionAt(
        upstreamNode, upstreamElevation, absMassFlow, upstreamPhaseTolerance, upstreamOpeningHeight,
        this.drawScratch, false);
      let flowPhase = comp.phase;

      // Check if we're trying to draw more of a phase than is available.
      // If the flow rate would drain the phase too quickly, use mixture instead.
      // This prevents unrealistic phase separation when flow exceeds what the
      // interface can supply. (Approved fallback - discussed with user)
      //
      // A pure draw that its zone cannot supply (drained more than ten times
      // a second, or empty) has already come back as the mixture from
      // drawCompositionAt - the same answer the momentum solve priced the
      // line with. It used to be decided here, after the solve, and the two
      // disagreed (see zoneCanSupply in connection-hydraulics.ts).

      // The connection's mass flow is TOTAL mixture flow (the momentum
      // solvers use bulk density including NCG), so when the flowing phase
      // carries gas, the flow must be SPLIT between water and NCG by the
      // mass composition of what is actually flowing. Liquid draws leave the
      // NCG behind in the vapor space (water share 1). A helium-filled node
      // (~no water) transports ~pure gas; a steam node transports ~pure
      // water; both fall out of the same split with no special cases.
      const upNcg = upstreamNode.fluid.ncg;
      let gasMassInSpace = 0;
      let shareOf = (_zone: 'liquid' | 'vapor' | 'mixture'): number => 1;
      if (upNcg && totalMoles(upNcg) > 0 && (comp.wVapor > 0 || comp.wMixture > 0)) {
        gasMassInSpace = ncgTotalMass(upNcg);
        // Steam sharing the flowing space with the gas (zoneWaterShare - the
        // pressure solver weights the same split, so the two agree on how
        // much gas a line carries).
        shareOf = (zone) => zoneWaterShare(upstreamNode, zone);
      }

      // Per zone: the zone's share of the total flow (mass weight), the
      // water fraction of what that zone carries, and the water's specific
      // enthalpy there. The water leaving through the opening is the sum
      // over zones of (weight x water share), and its energy the sum of
      // (weight x water share x enthalpy) - each zone's water priced at
      // that zone's enthalpy. (Until 2026-09-09 the enthalpies were blended
      // by the bare zone weights and multiplied by the summed water share,
      // which priced a gas zone's WHOLE mass at the steam enthalpy while
      // only its steam share left as water: an air-blanketed node drawing
      // across its interface lost ~45 kJ per kg more than it held and cooled
      // 5 K/s until it froze - the pump node of CAR BZ1bOwQ0oLXY0q8jG1hU.)
      let waterShare = 0;
      let waterEnthalpyFlux = 0;  // per kg of total flow
      const zones: Array<['liquid' | 'mixture' | 'vapor', number]> = [
        ['liquid', comp.wLiquid], ['mixture', comp.wMixture], ['vapor', comp.wVapor],
      ];
      for (const [zone, weight] of zones) {
        if (!(weight > 0)) continue;
        const zoneWater = weight * shareOf(zone);
        waterShare += zoneWater;
        waterEnthalpyFlux += zoneWater * this.getSpecificEnthalpy(upstreamNode, zone);
      }
      const h_up = waterShare > 0 ? waterEnthalpyFlux / waterShare : 0;

      // Water portion: mass flow * specific enthalpy of the flowing water
      const waterFlow = absMassFlow * waterShare;
      const energyFlow = absMassFlow * waterEnthalpyFlux;

      // Store flow phase on connection for debug display
      conn.currentFlowPhase = flowPhase;

      // Update rates: upstream loses mass/energy, downstream gains
      const upRates = rates.flowNodes.get(upstreamId)!;
      const downRates = rates.flowNodes.get(downstreamId)!;

      upRates.dMass -= waterFlow;
      upRates.dEnergy -= energyFlow;

      downRates.dMass += waterFlow;
      downRates.dEnergy += energyFlow;

      // NCG portion: the rest of the mixture flow, distributed across
      // species by their share of the gas mass, transported with ENTHALPY
      // (Cp - internal energy plus flow work, like the water above).
      const gasFlow = absMassFlow - waterFlow;
      if (gasFlow > 0 && gasMassInSpace > 0 && upNcg) {
        if (!upRates.dNcg) {
          upRates.dNcg = emptyGasComposition();
        }
        if (!downRates.dNcg) {
          downRates.dNcg = emptyGasComposition();
        }

        // moles per kg of gas mixture, per species
        let totalMolesTransferred = 0;
        for (const species of ALL_GAS_SPECIES) {
          const molesTransferred = (gasFlow * upNcg[species]) / gasMassInSpace;
          upRates.dNcg[species] -= molesTransferred;
          downRates.dNcg[species] += molesTransferred;
          totalMolesTransferred += molesTransferred;
        }

        // Bill the gas at the node's effective mixture temperature (phase-
        // aware energy-balance inversion; see ncgEffectiveT). Enthalpy (Cp),
        // not internal energy: the gas carries its flow work with it.
        const Cp_ncg = mixtureCp(upNcg);
        const effectiveT = this.ncgEffectiveT(upstreamNode);

        const ncgEnergyFlow = totalMolesTransferred * Cp_ncg * effectiveT;
        upRates.dEnergy -= ncgEnergyFlow;
        downRates.dEnergy += ncgEnergyFlow;

        // Gas crossing into a boundary node (atmosphere) leaves the modeled
        // system: accumulate it as the environmental release source term
        // (the boundary node itself never integrates rates)
        const downstreamNode = state.flowNodes.get(downstreamId);
        if (downstreamNode?.isBoundary) {
          if (!rates.environmentalRelease) {
            rates.environmentalRelease = emptyGasComposition();
          }
          for (const species of ALL_GAS_SPECIES) {
            rates.environmentalRelease[species] +=
              (gasFlow * (upNcg[species] ?? 0)) / gasMassInSpace;
          }
        }
      }

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
   * Get specific enthalpy of the flowing phase.
   * h = u + Pv for the phase actually being drawn from the node.
   */
  /**
   * Effective mixture temperature of a node holding water + NCG, from the
   * energy balance with the water's ACTUAL phase split:
   *   totalU = n*Cv_ncg*T + m_vap*(u_ref + Cv_vap*(T-273)) + m_liq*c_f*(T-273.15)
   *
   * The previous version assumed ALL water was vapor, which floored the
   * inversion to 273 K for liquid-dominated nodes (e.g. an accumulator's N2
   * cushion over 28 t of water reads as T=273 instead of ~306 K). NCG leaving
   * such nodes was then billed ~30 K too cold, and the receiving node
   * accumulated an energy deficit that drove it below the water-property
   * floor (LOCA accumulator nitrogen breakthrough froze the injection line
   * nodes and crashed the run).
   *
   * No 273 K floor here: if the books say the gas is cold, billing it cold is
   * what keeps the energy accounting conservative. A very low result means
   * the accounting is already broken - fail loudly.
   */
  private ncgEffectiveT(node: FlowNode): number {
    const ncg = node.fluid.ncg!;
    const n = totalMoles(ncg);
    const Cv_ncg = mixtureCv(ncg);
    const quality = node.fluid.phase === 'vapor' ? 1
      : node.fluid.phase === 'liquid' ? 0
      : (node.fluid.quality ?? 0);
    const mVap = node.fluid.mass * quality;
    const mLiq = node.fluid.mass - mVap;
    const C_F = 4186;      // J/kg-K liquid water
    const CV_VAP = 1900;   // J/kg-K water vapor
    const U_REF = 2.375e6; // J/kg vapor internal energy at 273 K
    const coeff = n * Cv_ncg + mVap * CV_VAP + mLiq * C_F;
    const constant = mVap * (U_REF - 273 * CV_VAP) - mLiq * C_F * 273.15;
    const T = (node.fluid.internalEnergy - constant) / Math.max(coeff, 1e-9);
    if (!(T > 50)) {
      // No substitute value: billing the gas at a made-up 50 K let a node
      // whose books were already broken keep trading energy for thousands
      // of seconds (the frozen pump of CAR BZ1bOwQ0oLXY0q8jG1hU sat at the
      // 150 K floor for 2000 s). Stop here so the cause is still in view.
      throw new Error(
        `[ncgEffectiveT] ${node.id}: effective mixture temperature ${T.toFixed(1)} K - the node's ` +
        `energy accounting is broken (totalU=${(node.fluid.internalEnergy / 1e6).toFixed(4)} MJ, ` +
        `ncg=${n.toFixed(1)} mol, m=${node.fluid.mass.toFixed(3)} kg, phase=${node.fluid.phase}, ` +
        `x=${quality.toFixed(3)}). Something removed more energy from this node than it held.`
      );
    }
    return T;
  }

  private getSpecificEnthalpy(node: FlowNode, flowPhase: 'liquid' | 'vapor' | 'mixture'): number {
    // Moving-boundary OTSG nodes: the sectioned model knows what actually
    // sits at each end of the bundle. A vapor draw comes from the superheat
    // section (carrying its superheat - the entire point of the model; the
    // bulk state would hand back saturated h_g), a liquid draw from the
    // subcooled section. Mixture draws fall through to the bulk path.
    if (node.otsg?.lastEval) {
      if (flowPhase === 'vapor') return node.otsg.lastEval.hSteamOut;
      if (flowPhase === 'liquid') return node.otsg.lastEval.hLiquidOut;
    }

    const P = node.fluid.pressure;
    const T = node.fluid.temperature;

    // For single-phase or mixture, use bulk average
    // IMPORTANT: Must subtract NCG energy and volume when computing water-specific properties!
    // NCG shares the volume and contributes energy, but we only transport water here.
    if (node.fluid.phase !== 'two-phase' || flowPhase === 'mixture') {
      let waterEnergy = node.fluid.internalEnergy;
      let waterVolume = node.volume;

      // Subtract NCG contribution if present
      if (node.fluid.ncg) {
        const ncgMoles = totalMoles(node.fluid.ncg);
        if (ncgMoles > 0) {
          const Cv_ncg = mixtureCv(node.fluid.ncg);

          // Effective temperature from the phase-aware energy-balance
          // inversion (see ncgEffectiveT - the old all-vapor assumption
          // floored liquid-dominated nodes to 273 K)
          const totalU = node.fluid.internalEnergy;
          const T_eff = this.ncgEffectiveT(node);

          // NCG energy at effective temperature
          const ncgEnergy = ncgMoles * Cv_ncg * T_eff;
          waterEnergy = totalU - ncgEnergy;

          // Water energy below the reference is real for ice (the
          // ice-vapour states below the triple line carry u < 0), so it is
          // priced as it is. This used to clamp negative water energy to
          // zero, which billed a draw from a frozen node at MORE energy per
          // kg than the node held and drove it further down; a node whose
          // books are actually broken is caught by ncgEffectiveT above,
          // which throws instead of substituting a temperature.

          // The water keeps the WHOLE volume: the gas shares the vapour
          // space with the steam (Dalton), it does not take a slice of the
          // node for itself. (This used to subtract an ideal-gas "NCG
          // volume" at the total pressure - an Amagat split the mixture
          // solve never used - so a draw's enthalpy was priced at a water
          // state the node was not in.)
        }
      }

      const waterMass = node.fluid.mass;
      if (waterMass <= 0) {
        // No water - return 0 (should not happen in normal flow)
        return 0;
      }

      const u = waterEnergy / waterMass;
      const v = waterVolume / waterMass;

      // CRITICAL: Don't blindly trust stored P - it may be stale!
      // The enthalpy h = u + Pv must use a pressure consistent with the current (u, v).
      // If stored P is inconsistent, we'd remove more energy per mass than actually exists.
      //
      // Compute P from ideal gas at energy-consistent temperature:
      //   For steam: u ≈ u_ref + Cv*(T - T_ref), so T = T_ref + (u - u_ref)/Cv
      //   Then P_ideal = (R/M) * T / v
      //
      // Blend between stored P and ideal gas P based on specific volume:
      //   - At v < 0.001 (liquid): use stored P (Pv term is tiny anyway)
      //   - At v > 0.1 (vapor): use ideal gas P
      //   - In between: smooth blend to avoid discontinuities
      const R_over_M = 8.314 / 0.018;  // ~462 J/kg-K for water
      const Cv_steam = 1400;           // J/kg-K
      const u_ref = 2.375e6;           // J/kg at 273K
      const T_ref = 273;               // K

      // Estimate T from energy: u = u_ref + Cv*(T - T_ref)
      const T_from_energy = T_ref + (u - u_ref) / Cv_steam;

      let P_ideal: number;
      if (T_from_energy > 10) {
        P_ideal = (1 / v) * R_over_M * T_from_energy;
      } else {
        // Extremely low energy - use minimal T to get minimal P
        // This prevents runaway energy extraction from unphysical states
        P_ideal = (1 / v) * R_over_M * 10;
      }

      // Blend factor: 0 at v<=0.001, 1 at v>=0.1, smooth in between
      // Using log scale for smooth transition across density range
      let blendFactor: number;
      if (v <= 0.001) {
        blendFactor = 0;  // Pure liquid - use stored P
      } else if (v >= 0.1) {
        blendFactor = 1;  // Pure vapor - use ideal gas P
      } else {
        // Log-linear blend from v=0.001 to v=0.1 (factor of 100)
        blendFactor = Math.log10(v / 0.001) / 2;  // 0 at 0.001, 1 at 0.1
      }

      const effectiveP = (1 - blendFactor) * P + blendFactor * P_ideal;
      const h = u + effectiveP * v;

      // DEBUG: Log enthalpy calculation details for problem diagnosis
      // Enable for nodes with suspicious energy states or significant P mismatch
      const h_stored_P = u + P * v;
      const h_ideal_P = u + P_ideal * v;
      const pMismatchRatio = Math.abs(P - P_ideal) / Math.max(P, P_ideal, 1);

      // Log if:
      // 1. There's >50% difference between stored and ideal P for vapor-like densities
      // 2. Or energy implies T < 100K for vapor (anomalously cold)
      // 3. Or specific energy is very low for vapor (<500 kJ/kg at v>0.01)
      // Boundary nodes are excluded - their synthetic reservoir states (e.g. the
      // atmosphere) trip these conditions by construction, and logging them every
      // rate evaluation floods the console badly enough to slow the simulation.
      const shouldLog = !node.isBoundary &&
                        ((pMismatchRatio > 0.5 && v > 0.01) ||
                         (T_from_energy < 100 && v > 0.01) ||
                         (u < 500e3 && v > 0.01));

      if (shouldLog && performance.now() - lastEnthalpyDebugLog > 1000) {
        lastEnthalpyDebugLog = performance.now();
        console.warn(`[getSpecificEnthalpy DEBUG] ${node.id}:`);
        console.warn(`  State: mass=${waterMass.toFixed(3)}kg, U=${(waterEnergy/1e6).toFixed(4)}MJ, V=${(waterVolume*1e3).toFixed(1)}L`);
        console.warn(`  Specific: u=${(u/1e3).toFixed(2)}kJ/kg, v=${(v*1e3).toFixed(2)}L/kg`);
        console.warn(`  Stored: T=${(T-273.15).toFixed(1)}C, P=${(P/1e5).toFixed(3)}bar, phase=${node.fluid.phase}`);
        console.warn(`  Computed: T_from_u=${(T_from_energy-273.15).toFixed(1)}C, P_ideal=${(P_ideal/1e5).toFixed(3)}bar`);
        console.warn(`  Blend: factor=${blendFactor.toFixed(3)}, P_eff=${(effectiveP/1e5).toFixed(3)}bar`);
        console.warn(`  Enthalpy: h_stored_P=${(h_stored_P/1e3).toFixed(1)}kJ/kg, h_ideal_P=${(h_ideal_P/1e3).toFixed(1)}kJ/kg, h_used=${(h/1e3).toFixed(1)}kJ/kg`);
        console.warn(`  Pv work: stored=${(P*v/1e3).toFixed(1)}kJ/kg, ideal=${(P_ideal*v/1e3).toFixed(1)}kJ/kg, eff=${(effectiveP*v/1e3).toFixed(1)}kJ/kg`);
      }

      return h;
    }

    // A two-phase node drawing ONE phase hands over that saturated phase, at
    // the node's temperature - two-phase means saturated, and T is the
    // saturation temperature of the water's own (steam partial) pressure.
    // Both from the steam tables.
    //
    // This used to be a pair of fits: h_f = 4186*T_C and h_g = u_f + a latent
    // heat held at 2200 kJ/kg below 10 bar. They are -266 kJ/kg on steam at
    // 15 C (h_g is 2529, the fit said 2263), -57 at 100 C and +190 at 200 C.
    // Every vapour draw off a cool two-phase node lost that on each kg: a
    // dry pump casing breathing the saturated air over a tank was flushed
    // with steam 266 kJ/kg short of what the tank gave up, cooled below both
    // gases it was mixing, went supersaturated and rang at the dew point
    // (scripts/probe-dry-pump-dewpoint.ts).
    if (flowPhase === 'liquid') {
      // The liquid carries its internal energy plus the flow work of the
      // pressure that pushes it out (the node's total, gas included)
      return Water.saturatedLiquidEnergy(T) + P / Water.saturatedLiquidDensity(T);
    }
    // The steam carries its internal energy plus its OWN flow work: Dalton -
    // it is at its partial (saturation) pressure over its own specific
    // volume, and the gas beside it carries the rest (n*Cp*T above). That
    // is exactly the tables' h_g(T).
    return Water.saturatedVaporEnergy(T) + Water.saturationPressure(T) / Water.saturatedVaporDensity(T);
  }
}

// ============================================================================
// Turbine/Condenser Rate Operator
// ============================================================================

import { updateTurbineCondenserState } from './turbine-condenser';
import { stateAtPh, expandStage } from '../turbine-expansion';

/** Isentropic efficiency of every stage of every steam turbine. */
export const TURBINE_ISENTROPIC_EFFICIENCY = 0.87;

/**
 * Specific enthalpy of the steam a donor node hands to the turbine.
 *
 * A moving-boundary boiler knows what is actually at its steam takeoff -
 * the superheat section's state, not the bundle's (much colder) bulk
 * average - and that is the enthalpy the flow machinery advects down the
 * connection, so the expansion has to start from the same number or the
 * turbine's energy books and the boiler's disagree.
 */
function donorSteamEnthalpy(donor: FlowNode, flowPhase?: string): number {
  if (donor.otsg?.lastEval && flowPhase !== 'liquid') {
    return donor.otsg.lastEval.hSteamOut;
  }
  const u = donor.fluid.internalEnergy / Math.max(1e-9, donor.fluid.mass);
  const v = donor.volume / Math.max(1e-9, donor.fluid.mass);
  return u + donor.fluid.pressure * v;
}

/** One steam turbine's expansion: its shaft power and what each stage node gives up for it. */
export interface TurbineExpansion {
  /** The machine's exhaust node id (the turbine-generator component's id). */
  machineId: string;
  /** Shaft power (W): the sum of the stage work. */
  power: number;
  /** [stage node id, work taken out of that node's steam (W)], in chain order. */
  stageWork: Array<[string, number]>;
}

/**
 * The staged expansion of every steam turbine in the plant, from the state
 * as it stands. The rate operator takes each stage's work out of the steam;
 * the electrical solve reads the shaft power to spin the generator's rotor.
 * One function, so the two can never disagree about how much work there is.
 */
export function expandTurbines(state: SimulationState): TurbineExpansion[] {
  const out: TurbineExpansion[] = [];
  for (const [turbineNodeId, turbineNode] of state.flowNodes) {
    // A machine is the node the factory stamped as its exhaust; its stage
    // (extraction) nodes carry parentTurbineId and are handled as part of
    // it below. Never match on the label: a "Turbine Stop Valve" upstream
    // of the machine used to be expanded as a turbine of its own, from
    // header pressure down to the real turbine's exhaust, and it sat at
    // saturation for the whole run.
    if (!turbineNode.steamTurbine) continue;
    if (turbineNode.parentTurbineId) continue; // Skip extraction nodes

    // The stage chain: extraction nodes in falling pressure order, then
    // the exhaust node. Steam enters the first of them from outside (the
    // header), passes each nozzle row into the next, and the exhaust node
    // discharges to the condenser. A bleed leaves its stage node sideways
    // carrying that stage's outlet state, so it needs no accounting of its
    // own here - the stage's books already hold it at the right state.
    const stages: FlowNode[] = [];
    for (const [, node] of state.flowNodes) {
      if (node.parentTurbineId === turbineNodeId && node.extractionPressure) stages.push(node);
    }
    stages.sort((a, b) => (b.extractionPressure ?? 0) - (a.extractionPressure ?? 0));
    const chain = [...stages, turbineNode];
    const inMachine = (id: string) => id === turbineNodeId || stages.some(s => s.id === id);
    const firstId = chain[0].id;

    // Find flow INTO the machine, and the steam header it comes from.
    //
    // The expansion has to start from the state of the steam ENTERING the
    // machine - the header upstream of the throttle - not from the turbine
    // node's own state. The turbine node sits at exhaust conditions by
    // construction (it receives header enthalpy and has its work taken out
    // of it), so expanding "from" it threw away the entire pressure drop
    // the machine is there to use: in the Xe-100 preset the node sat at
    // 0.109 bar against a 165 bar boiler.
    let inletMassFlow = 0;
    let inletP = 0;
    let inletEnthalpyNum = 0;
    let outletNodeId: string | null = null;

    for (const conn of state.flowConnections) {
      // Flow into the machine's first node from outside it
      if (conn.toNodeId === firstId && conn.massFlowRate > 0 && !inMachine(conn.fromNodeId)) {
        inletMassFlow += conn.massFlowRate;
        const donor = state.flowNodes.get(conn.fromNodeId);
        if (donor) {
          // Same enthalpy the flow machinery advects down this connection,
          // so a moving-boundary boiler hands over its superheat instead of
          // its (much colder) bulk state
          inletEnthalpyNum += conn.massFlowRate *
            donorSteamEnthalpy(donor, conn.currentFlowPhase);
          inletP = Math.max(inletP, donor.fluid.pressure);
        }
      }
      // Flow out of the machine's exhaust to something outside it
      if (conn.fromNodeId === turbineNodeId && conn.massFlowRate > 0) {
        const sink = state.flowNodes.get(conn.toNodeId);
        if (sink && !inMachine(conn.toNodeId)) outletNodeId = conn.toNodeId;
      }
    }

    if (inletMassFlow < 1 || !outletNodeId) continue;

    const outletNode = state.flowNodes.get(outletNodeId);
    if (!outletNode) continue;

    // Skip if inlet is liquid
    if (turbineNode.fluid.phase === 'liquid') continue;

    const P_in = inletP;
    const P_out = outletNode.fluid.pressure;

    if (P_in <= P_out) continue;

    const h_in = inletEnthalpyNum / inletMassFlow;

    // The steam arriving at each chain node from the stage above it (the
    // header for the first): what that stage's blading worked on, and
    // therefore what the node is charged the stage work for.
    const arriving = chain.map((node, k) => {
      if (k === 0) return inletMassFlow;
      let flow = 0;
      for (const conn of state.flowConnections) {
        if (conn.toNodeId === node.id && conn.fromNodeId === chain[k - 1].id) flow += Math.max(0, conn.massFlowRate);
        else if (conn.fromNodeId === node.id && conn.toNodeId === chain[k - 1].id) flow += Math.max(0, -conn.massFlowRate);
      }
      return flow;
    });

    let inletState = stateAtPh(P_in, h_in);

    // A turbine is a fixed set of choked nozzles, and Stodola's cone law
    // says what they pass: proportional to inlet pressure, falling with the
    // square root of inlet temperature. Steam offered beyond that cannot
    // enter the blading, so it does no work - it passes through and lands
    // in the condenser carrying its own enthalpy.
    //
    // Without this bound the momentum solver's startup transients (which
    // briefly push thousands of kg/s through the inlet connection) came
    // back out of the expansion as 7-22 GW power readings. `swallowFrac` is
    // the share of every stream the machine can actually work on, and it is
    // applied to the power AND to each stream's energy debit, so the books
    // stay closed whichever way the flow solver behaves.
    let swallowFrac = 1;
    const offeredFlow = inletMassFlow;
    if (turbineNode.ratedSteamFlow && turbineNode.ratedSteamFlow > 0 && offeredFlow > 0) {
      const Pdesign = turbineNode.designInletPressure || P_in;
      const swallow = turbineNode.ratedSteamFlow * (P_in / Pdesign) *
        Math.sqrt(Water.saturationTemperature(Pdesign) / Math.max(1, inletState.T));
      swallowFrac = Math.min(1, swallow / offeredFlow);
    }

    // Staged expansion down the chain. A stage node expands to ITS OWN
    // pressure - the interstage pressure its downstream nozzle row sets,
    // which follows the flow - and the exhaust node to the condenser's.
    // Each node is charged the work of the stage it terminates, on the
    // steam that arrived through it; the steam reaching the next node has
    // already had that work taken out, so the chain's books close stage by
    // stage. A stage whose pressure sits above its inlet (a startup, a
    // backed-up bleed) has nothing to expand through and passes the state
    // on untouched.
    let turbinePower = 0;
    const stageWork: Array<[string, number]> = [];
    for (let k = 0; k < chain.length; k++) {
      const node = chain[k];
      const P_stage = k === chain.length - 1 ? P_out : node.fluid.pressure;
      if (!(P_stage < inletState.P)) continue;
      const result = expandStage(inletState, P_stage, TURBINE_ISENTROPIC_EFFICIENCY);
      const charged = arriving[k] * swallowFrac;
      turbinePower += charged * result.work;
      stageWork.push([node.id, charged * result.work]);
      inletState = result.outlet;
    }

    out.push({ machineId: turbineNodeId, power: turbinePower, stageWork });
  }
  return out;
}

export class TurbineCondenserRateOperator implements RateOperator {
  name = 'TurbineCondenser';

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

    // Steam turbines: the staged expansion (expandTurbines). Each stage node
    // is charged the work of the stage it terminates.
    for (const expansion of expandTurbines(state)) {
      for (const [nodeId, work] of expansion.stageWork) {
        const nodeRates = rates.flowNodes.get(nodeId);
        if (nodeRates) nodeRates.dEnergy -= work;
      }
      totalTurbinePower += expansion.power;
    }

    // Find condensers dynamically. A condenser is defined by carrying the
    // condenser properties (heatSinkTemp - set by the factory for condenser
    // components), NOT by its name: name matching would claim any node whose
    // label happens to mention "condenser" (e.g. "Pipe: Turbine to Condenser")
    // and then crash on the missing properties.
    for (const [condenserNodeId, condenserNode] of state.flowNodes) {
      if (condenserNode.heatSinkTemp === undefined) continue;

      // Steam temperature (saturation temp for condensing steam)
      const T_steam = condenserNode.fluid.temperature;

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

  // (No freezing constants here any more. This class used to carry its own
  // ice model - LATENT_HEAT_FUSION / T_FREEZE / CP_WATER / MAX_ICE_FRACTION -
  // which pinned any node heading below 273.15 K at exactly that temperature,
  // relabelled it 'liquid', and then ADDED the missing energy back into
  // fluid.internalEnergy so the books would close. Ice is real (u, v) physics
  // now: the water properties' sub-triple branch returns an ice-vapour state
  // with its own temperature, sublimation pressure and solid fraction, and the
  // mixture solve carries it through untouched.)

  applyConstraints(state: SimulationState): SimulationState {
    return this.applyImpl(cloneSimulationState(state));
  }

  /** In-place variant: caller owns `state` (see ConstraintOperator docs).
   *  This runs 7x per step on every stage/candidate - skipping the clone
   *  here is a large share of the clone-reduction win. */
  applyConstraintsMutating(state: SimulationState): SimulationState {
    return this.applyImpl(state);
  }

  private applyImpl(newState: SimulationState): SimulationState {
    // Update fluid properties (T, P, phase) from (m, U, V)
    for (const [nodeId, flowNode] of newState.flowNodes) {
      // Skip boundary nodes (like atmosphere) - their state is fixed
      if (flowNode.isBoundary) {
        continue;
      }

      // Check for physically impossible density (mass accumulation bug)
      // Maximum water density is ~1000 kg/m³ at normal conditions, ~1100 kg/m³ at high pressure
      // Anything above 1500 kg/m³ indicates a mass balance error
      const density = flowNode.fluid.mass / flowNode.volume;
      if (density > 1500) {
        // Find what's flowing in/out of this node
        const flowsIn: string[] = [];
        const flowsOut: string[] = [];
        for (const conn of newState.flowConnections) {
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

      // Calculate water state normally
      // DEBUG: Track pressure jumps for specific nodes
      const debugNodes = ['pum-6'];
      if (debugNodes.includes(nodeId)) {
        Water.setDebugNodeId(nodeId);
      }

      // ----------------------------------------------------------------
      // Water + non-condensible gas equilibrium - ONE table-consistent solve
      // ----------------------------------------------------------------
      // Everything below used to be a hand-rolled mixture model: a Newton
      // iteration on a linear caloric fit for water (u_g = 2.375e6 +
      // 1900*(T-273)), a separate "very low density" ideal-gas branch chosen
      // by a v > 10 m^3/kg test, and the steam tables for everything else.
      // The fit disagrees with the tables by 19% at 600 K and 35% at 640 K,
      // so the branch boundary was a STEP in the state function - crossing it
      // (which is exactly what a gas node does as steam leaks into it) jumped
      // T by ~110 K and P by ~10 bar. See mixture-properties.ts.
      const ncgMoles = flowNode.fluid.ncg ? totalMoles(flowNode.fluid.ncg) : 0;

      // No water AND no gas: nothing to evaluate (keep the last state; the
      // sanity check's total-inventory floor governs whether this node is
      // even allowed to get here)
      if (flowNode.fluid.mass <= 0 && ncgMoles <= 0) {
        continue;
      }

      let mix: MixtureState;
      try {
        mix = solveMixtureState(
          flowNode.fluid.mass,
          flowNode.fluid.internalEnergy,
          flowNode.volume,
          flowNode.fluid.ncg,
          flowNode.fluid.temperature
        );
      } catch (e) {
        // Add node context to whatever the solve or the steam tables threw
        const mass = flowNode.fluid.mass;
        const U = flowNode.fluid.internalEnergy;
        const vol = flowNode.volume;
        console.error(`[FluidState] Error in ${nodeId}:`);
        console.error(`  STORED STATE: T=${(flowNode.fluid.temperature - 273.15).toFixed(1)}C, ` +
          `P=${(flowNode.fluid.pressure / 1e5).toFixed(2)}bar, phase=${flowNode.fluid.phase}, ` +
          `quality=${(flowNode.fluid.quality ?? 0).toFixed(3)}`);
        console.error(`  mass=${mass.toExponential(4)}kg, U=${(U / 1e6).toFixed(3)}MJ, ` +
          `V=${(vol * 1e3).toFixed(1)}L, ncgMoles=${ncgMoles.toFixed(3)}`);
        console.error(`  u_total=${(U / mass / 1e3).toFixed(2)}kJ/kg, ` +
          `v=${(vol / mass).toExponential(4)}m³/kg`);
        throw e;
      }

      if (debugNodes.includes(nodeId)) {
        Water.setDebugNodeId(null);
      }

      // The mixture solve's answer is the answer. There is no freezing
      // override here any more: below the triple point the water properties
      // return a real ice-vapour (or triple-line) state with its own
      // temperature and sublimation pressure, and the solid fraction rides
      // along in fluid.iceFraction. What used to be here pinned T at 273.15 K,
      // called the result 'liquid', and then added the missing energy back
      // into fluid.internalEnergy so the books would close - a fabrication
      // that showed up as nodes stuck at 273.16 K with no way down.
      {
        flowNode.fluid.temperature = mix.temperature;
        flowNode.fluid.phase = mix.phase;
        flowNode.fluid.quality = mix.quality;
        flowNode.fluid.iceFraction = mix.iceFraction;
        flowNode.fluid.gasVolume = mix.gasVolume;

        // Determine pressure based on phase. mix.steamPressure is the water's
        // partial pressure; mix.gasPressure is the NCG's (Dalton).
        if (mix.phase === 'two-phase' || mix.phase === 'vapor') {
          flowNode.fluid.pressure = mix.steamPressure;
        } else {
          // Liquid: use pressure model
          // NOTE: The 'hybrid' pressure model is OBSOLETE and should not be used.
          // It was never properly implemented here - the original code had rho_base = rho_current
          // which made dP always zero. Use pure-triangulation for accurate physics.
          if (simulationConfig.pressureModel === 'pure-triangulation') {
            flowNode.fluid.pressure = mix.steamPressure;
          } else {
            // OBSOLETE hybrid model - kept for backwards compatibility but does nothing useful
            const P_base = newState.liquidBasePressures?.get(nodeId) ?? mix.steamPressure;
            const rho_current = flowNode.fluid.mass / flowNode.volume;
            const v_specific = flowNode.volume / flowNode.fluid.mass;
            const rho_base = 1 / v_specific;  // Note: This equals rho_current, so dP = 0
            const K = Water.bulkModulus(mix.temperature - 273.15);
            const dP = K * (rho_current - rho_base) / rho_base;
            flowNode.fluid.pressure = P_base + dP;
          }
        }

        // Add the NCG partial pressure (Dalton's law). The mixture solve
        // already computed it at the equilibrium temperature, so this cannot
        // drift from the temperature the phase split was taken at.
        flowNode.fluid.pressure += mix.gasPressure;
      }

      // Sanity checks - log warnings but do NOT clamp values
      // Clamping hides problems; we need to see what's causing invalid states
      // Floor is the water model's own lowest temperature, not 200 K: a gas
      // space that has blown down carries its moisture as frost well below
      // that (a helium loop from 70 to 2 bar lands near 217 K).
      if (!isFinite(flowNode.fluid.temperature) ||
          flowNode.fluid.temperature < Water.MODEL_MIN_TEMPERATURE ||
          flowNode.fluid.temperature > 4500) {
        console.warn(`[FluidState] Invalid temperature in ${nodeId}: ${flowNode.fluid.temperature}K, mass=${flowNode.fluid.mass.toFixed(1)}kg, U=${(flowNode.fluid.internalEnergy/1e6).toFixed(2)}MJ`);
      }
      // Pressure floor: ice at the model's lowest temperature. The old 650 Pa
      // was the triple point, which is only a floor for water in equilibrium
      // with LIQUID - a frost aerosol at 217 K sits at 1.8 Pa, and a trace of
      // steam in a gas loop lower still.
      if (!isFinite(flowNode.fluid.pressure) || flowNode.fluid.pressure < Water.modelMinPressure() || flowNode.fluid.pressure > 50e6) {
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

  /** Pressure at a connection point inside a node: the shared model (connection-hydraulics). */
  private getPressureAtConnection(node: FlowNode, connectionElevation?: number): number {
    return pressureAtConnection(node, connectionElevation);
  }

  applyConstraints(state: SimulationState): SimulationState {
    return this.applyImpl(cloneSimulationState(state));
  }

  /** In-place variant: caller owns `state` (see ConstraintOperator docs). */
  applyConstraintsMutating(state: SimulationState): SimulationState {
    return this.applyImpl(state);
  }

  private applyImpl(newState: SimulationState): SimulationState {
    for (const conn of newState.flowConnections) {
      const fromNode = newState.flowNodes.get(conn.fromNodeId);
      const toNode = newState.flowNodes.get(conn.toNodeId);

      if (!fromNode || !toNode) continue;

      // Compute what the steady-state flow would be (for debugging/display)
      const targetFlow = this.computeSteadyStateFlow(conn, fromNode, toNode, newState);
      conn.targetFlowRate = targetFlow;
      conn.steadyStateFlow = targetFlow;

      // Flow phase for display: the same draw the transport prices the line
      // with (drawCompositionAt). This used to be its own estimate - a node
      // height from sqrt(V / (pi/4)), a 10%-of-height interface band - and
      // labelled a vapour-space draw off a squat tank 'liquid' while the line
      // was carrying air.
      const forward = conn.massFlowRate >= 0;
      const upstreamNode = forward ? fromNode : toNode;
      conn.currentFlowPhase = drawCompositionAt(
        upstreamNode,
        forward ? conn.fromElevation : conn.toElevation,
        Math.abs(conn.massFlowRate),
        forward ? conn.fromPhaseTolerance : conn.toPhaseTolerance,
        forward ? conn.fromOpeningHeight : conn.toOpeningHeight,
        undefined, false).phase;

      // === PHYSICAL CONSTRAINTS ON FLOW ===

      // Note: Running pumps resist reverse flow via high friction in the rate equation,
      // not hard clamping here. This provides smoother dynamics.

      // Check valves prevent reverse flow
      const checkValve = findCheckValveForConnection(newState, conn.id);
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

    // Pump curve terms: dP_pump(Q) = dP_shutoff - a_pump * Q², so the pump's
    // falling curve enters the steady-state balance alongside friction.
    let a_pump = 0;      // Pa per (kg/s)²
    let dP_shutoff = 0;  // Pa
    for (const [, pump] of state.components.pumps) {
      if (pump.connectedFlowPath === conn.id && pump.running && pump.effectiveSpeed > 0) {
        const s = pump.effectiveSpeed;
        const gH = pump.ratedHead * rho_avg * 9.81;
        dP_shutoff = 1.25 * s * s * gH;
        if (pump.ratedFlow > 0) {
          a_pump = 0.25 * gH / (pump.ratedFlow * pump.ratedFlow);
        }
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

    // Static driving pressure (pump contribution at zero flow)
    const dP_static = dP_pressure + dP_gravity + dP_shutoff;

    // Steady-state momentum: dP_static - a_pump * Q² = K * (1/2) * rho * v²
    // => Q = sqrt(dP_static / (a_fric + a_pump)) with a_fric = K / (2 rho A²)
    const K = (conn.resistanceCoeff || 10) / Math.pow(valveOpenFraction, 2);
    const A = conn.flowArea || 0.1;
    const a_fric = K / (2 * rho_avg * A * A);

    if (dP_static >= 0) {
      return Math.sqrt(dP_static / (a_fric + a_pump));
    }
    // Reverse flow: pump curve doesn't assist (reverse sees shutoff head, already
    // counted in dP_static), only friction resists
    return -Math.sqrt(-dP_static / a_fric);
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

      if (pump.steamDriven) {
        // Turbine-driven pump: speed follows the steam flow through the drive
        // turbine (quasi-static torque balance). No motor and no trip - if
        // steam flows, the pump turns. Steam admission is throttled by the
        // governorValve on the steam node, so "stopping" the pump means
        // closing the governor (running=false also parks it, as a trip valve).
        let steamFlow = 0;
        for (const conn of state.flowConnections) {
          if (conn.toNodeId === pump.steamDriven.steamNodeId) {
            steamFlow += Math.max(0, conn.massFlowRate);
          }
          if (conn.fromNodeId === pump.steamDriven.steamNodeId) {
            steamFlow += Math.max(0, -conn.massFlowRate);
          }
        }
        const targetSpeed = pump.running
          ? Math.min(1, steamFlow / pump.steamDriven.ratedSteamFlow)
          : 0;
        // Deadband on coast-down so speed doesn't chatter against the noisy
        // steam-flow signal; ramp rates as for motor pumps.
        if (pump.effectiveSpeed < targetSpeed) {
          dEffectiveSpeed = 1.0 / pump.rampUpTime;
        } else if (pump.effectiveSpeed > targetSpeed + 0.02) {
          dEffectiveSpeed = -1.0 / pump.coastDownTime;
        }
        if (dEffectiveSpeed !== 0) {
          rates.pumps.set(id, { dEffectiveSpeed });
        }
        continue;
      }

      // A drowned motor cannot run: a flooded pump coasts down like a tripped
      // one, and stays down until the water is gone (surface-water.ts). A
      // motor whose bus is dead coasts the same way, and runs back up when
      // the power returns (electrical.ts; absent = powered).
      if (pump.running && !pump.flooded && pump.powered !== false) {
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
 * FlowMomentumRateOperator - ACTIVE flow momentum calculation for RK45 integration
 *
 * This is the PRIMARY operator that computes flow rate changes (dṁ/dt).
 * The result is integrated by RK45 to update conn.massFlowRate each timestep.
 *
 * NOTE: This replaces the old FlowOperator (in fluid-flow.ts) which is now OBSOLETE.
 *
 * The per-connection physics (driving pressures, phase-dependent flow density,
 * resistances, choking limits) lives in connection-hydraulics.ts and is SHARED
 * with the semi-implicit PressureSolver - one model, two callers. Flow-physics
 * changes belong there, not here. When the pressure solver owns the momentum
 * update (implicitMomentum mode), the RK45 solver skips this operator entirely
 * (see providesFlowMomentum).
 *
 * Momentum equation:
 *
 *   ρ_flow * (L/A) * dv/dt = ΔP_driving + ΔP_friction
 *
 * Converting to mass flow rate ṁ = ρ_flow * A * v:
 *   dṁ/dt = A * (ΔP_driving + ΔP_friction) / L
 */
export class FlowMomentumRateOperator implements RateOperator {
  name = 'FlowMomentum';
  /** Marks this operator as the explicit flow-momentum source, so the RK45
   *  solver can skip it when the implicit pressure-flow solve owns momentum. */
  providesFlowMomentum = true;

  // Debug flag - set to connection ID prefix to trace momentum calculation
  private debugConnection: string | null = null; // e.g., 'tan-2' to debug tan-2 connections

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const conn of state.flowConnections) {
      const fromNode = state.flowNodes.get(conn.fromNodeId);
      const toNode = state.flowNodes.get(conn.toNodeId);

      if (!fromNode || !toNode) continue;

      const currentFlow = conn.massFlowRate;
      const h = computeConnectionHydraulics(state, conn, fromNode, toNode);

      // Closed valve (or fully closed turbine governor): decay flow to zero
      // with a short time constant instead of integrating the momentum equation.
      if (h.valveClosed || h.governorClosed) {
        rates.flowConnections.set(conn.id, { dMassFlowRate: -currentFlow / CLOSED_FLOW_DECAY_TAU });
        continue;
      }

      // Check valve - prevents reverse flow and requires cracking pressure to open.
      // Closed if driving pressure is below cracking pressure (or negative).
      if (h.checkValve && h.dP_driving < h.crackingPressure) {
        rates.flowConnections.set(conn.id, { dMassFlowRate: -currentFlow / CLOSED_FLOW_DECAY_TAU });
        continue;
      }

      // === Momentum equation ===

      // Net accelerating pressure at the current flow
      const dP_net = h.dP_driving + h.dP_friction;

      // dv/dt = ΔP_net / (ρ_flow * L); dṁ/dt = ρ_flow * A * dv/dt.
      // rho_flow (the density of the phase actually in the pipe) must be used
      // consistently with the velocity - see connection-hydraulics.ts.
      const dv_dt = dP_net / (h.rho_flow * h.L);
      let dMassFlowRate = h.rho_flow * h.A * dv_dt;

      // === Choked flow limiting ===
      // For compressible flow (vapor/mixture), limit flow to sonic velocity.
      let isChoked = false;
      let machNumber = 0;

      const choke = computeChokeLimit(
        conn, h.upstreamNode, h.downstreamNode, h.flowPhase, h.rho_flow, h.throatArea);
      if (choke) {
        const m_dot_choked = choke.m_dot_choked;
        const currentFlowSign = currentFlow >= 0 ? 1 : -1;

        // Throat Mach as the fraction of critical flow - exactly 1 at the
        // sonic limit (see the note in pressure-solver.ts)
        machNumber = m_dot_choked > 0 ? Math.abs(currentFlow) / m_dot_choked : 0;

        if (choke.chokedByRatio) {
          // Limit current flow to choked value
          const targetFlow = currentFlowSign * m_dot_choked;

          if (Math.abs(currentFlow) >= m_dot_choked) {
            // At or above choked - bring flow back to choked value
            isChoked = true;
            const tau = 0.05; // Fast response (50ms)
            dMassFlowRate = (targetFlow - currentFlow) / tau;
          } else if (dMassFlowRate * currentFlowSign > 0) {
            // Accelerating toward choked - limit acceleration to not exceed choked
            const dt_estimate = 0.01; // 10ms estimate
            const futureFlow = currentFlow + dMassFlowRate * dt_estimate;
            if (Math.abs(futureFlow) > m_dot_choked) {
              // Would exceed choked - limit to reach choked exactly
              isChoked = true;
              dMassFlowRate = (targetFlow - currentFlow) / dt_estimate;
            }
          }
        } else {
          // Even if not choked by pressure ratio, don't let flow exceed sonic
          if (Math.abs(currentFlow) > m_dot_choked * 0.95) {
            // Approaching sonic - apply soft limiting
            const targetFlow = currentFlowSign * m_dot_choked * 0.95;
            const tau = 0.1;
            const limitingRate = (targetFlow - currentFlow) / tau;

            // Only apply if it would reduce magnitude of acceleration
            if (dMassFlowRate * currentFlowSign > limitingRate * currentFlowSign) {
              isChoked = true;
              dMassFlowRate = limitingRate;
            }
          }
        }
      }

      // Store choked flow status on connection for display
      conn.isChoked = isChoked;
      conn.machNumber = machNumber;

      // Debug logging for specific connections (console)
      if (this.debugConnection && (conn.fromNodeId.includes(this.debugConnection) || conn.toNodeId.includes(this.debugConnection))) {
        console.log(`[Momentum] ${conn.fromNodeId}→${conn.toNodeId}: ` +
          `ṁ=${currentFlow.toFixed(1)}kg/s, v=${h.v.toFixed(1)}m/s, ` +
          `ρ_flow=${h.rho_flow.toFixed(2)}kg/m³ (${h.flowPhase}), ` +
          `L=${h.L.toFixed(2)}m, A=${h.A.toFixed(3)}m², K=${h.K_eff.toFixed(1)}, ` +
          `dP_pressure=${(h.dP_pressure/1e5).toFixed(3)}bar, dP_gravity=${(h.dP_gravity/1e5).toFixed(3)}bar, ` +
          `dP_pump=${(h.dP_pump/1e5).toFixed(3)}bar, dP_driving=${(h.dP_driving/1e5).toFixed(3)}bar, ` +
          `dP_friction=${(h.dP_friction/1e5).toFixed(3)}bar, dP_net=${(dP_net/1e5).toFixed(3)}bar, ` +
          `dv/dt=${dv_dt.toFixed(1)}m/s², dṁ/dt=${dMassFlowRate.toFixed(1)}kg/s²`);
      }

      // Store debug info on connection for UI display
      // NOTE: isChoked and machNumber are stored here because rate operators
      // work on cloned state - direct conn.isChoked won't persist to original
      conn.debug = {
        flowPhase: h.flowPhase,
        rho_flow: h.rho_flow,
        dP_driving: h.dP_driving,
        dP_friction: h.dP_friction,
        dP_net,
        dMassFlowRate,
        isChoked,
        machNumber,
      };

      rates.flowConnections.set(conn.id, { dMassFlowRate });
    }

    return rates;
  }
}

// ============================================================================
// Choked Flow Display Constraint Operator
// ============================================================================

/**
 * ChokedFlowDisplayOperator - Updates display flags for choked flow
 *
 * This constraint operator runs AFTER rate operators and sets conn.isChoked
 * and conn.machNumber on the actual state (not a clone) so the debug panel
 * can display them.
 *
 * This is needed because FlowMomentumRateOperator works on cloned state,
 * so any properties it sets are lost when the clone is discarded.
 */
export class ChokedFlowDisplayOperator implements ConstraintOperator {
  name = 'ChokedFlowDisplay';

  applyConstraints(state: SimulationState): SimulationState {
    for (const conn of state.flowConnections) {
      const fromNode = state.flowNodes.get(conn.fromNodeId);
      const toNode = state.flowNodes.get(conn.toNodeId);
      if (!fromNode || !toNode) continue;

      // The momentum step that applied (or declined) the sonic cap is the
      // authority on choking: it judged the bound against the very state it
      // capped from. The implicit solver runs on the real state and leaves its
      // verdict in conn.debug, so adopt it. Re-deriving here instead compares a
      // start-of-step cap against an end-of-step bound and disagrees by a few
      // tenths of a percent - enough to blink the flag on and off every step on
      // a connection that is sitting exactly on its ceiling.
      if (conn.debug) {
        conn.isChoked = conn.debug.isChoked ?? false;
        conn.machNumber = conn.debug.machNumber ?? 0;
        continue;
      }

      // No verdict recorded (explicit momentum path - it runs on RK stage
      // clones that are discarded), so re-derive from the accepted state.
      const currentFlow = conn.massFlowRate;
      const upstreamNode = currentFlow >= 0 ? fromNode : toNode;
      const downstreamNode = currentFlow >= 0 ? toNode : fromNode;
      const upstreamElevation = currentFlow >= 0 ? conn.fromElevation : conn.toElevation;
      const upstreamTolerance = currentFlow >= 0 ? conn.fromPhaseTolerance : conn.toPhaseTolerance;

      // Phase and density come from the SAME helpers the momentum operators
      // use. This operator used to carry its own copies, which drifted: it
      // could report a vapor line choked while the momentum equation was
      // pushing liquid down it.
      const upstreamOpening = currentFlow >= 0 ? conn.fromOpeningHeight : conn.toOpeningHeight;
      const comp = drawCompositionAt(
        upstreamNode, upstreamElevation, currentFlow, upstreamTolerance, upstreamOpening);
      const flowPhase = comp.phase;
      if (flowPhase === 'liquid') {
        conn.isChoked = false;
        conn.machNumber = 0;
        continue;
      }
      const rho_flow = comp.rho;

      const { throatArea } = connectionRestriction(state, conn, toNode);
      const choke = computeChokeLimit(
        conn, upstreamNode, downstreamNode, flowPhase, rho_flow, throatArea);
      if (!choke) {
        conn.isChoked = false;
        conn.machNumber = 0;
        continue;
      }

      // Throat Mach as the fraction of critical flow (see pressure-solver.ts)
      conn.machNumber = choke.m_dot_choked > 0
        ? Math.abs(currentFlow) / choke.m_dot_choked
        : 0;

      // Choked means the sonic mass-flux bound is what the flow is up against.
      // A subcritical pressure ratio is necessary but NOT sufficient: judged on
      // the ratio alone, every turbine inlet reads choked forever (its
      // downstream node floats at condenser pressure) while passing Mach 0.05.
      const bound = choke.chokedByRatio ? choke.m_dot_choked : 0.95 * choke.m_dot_choked;
      conn.isChoked = Math.abs(currentFlow) >= bound;
    }

    return state;
  }

  reset(): void {}
}

/**
 * Split a rod or tube surface into the share standing in liquid and the
 * share standing in gas, from the flow node's own liquid level.
 *
 * Module level because the oxidation operator needs exactly the same split:
 * the part of a fuel rod under water reacts with water, the part above it
 * reacts with whatever gas is in the room. Two different answers to "how
 * much of this rod is wet" would be two different rods.
 */
export function effectiveSurfaceAreas(
  conn: ConvectionConnection,
  flowNode: FlowNode
): { liquidArea: number; vaporArea: number } {
  const phase = flowNode.fluid.phase;
  if (conn.tubeHeight === undefined || conn.tubeBottomElevation === undefined) {
    if (phase === 'liquid') return { liquidArea: conn.surfaceArea, vaporArea: 0 };
    if (phase === 'vapor') return { liquidArea: 0, vaporArea: conn.surfaceArea };
    // Two-phase without geometry: split by liquid volume fraction
    const quality = flowNode.fluid.quality ?? 0;
    const rho_f = Water.saturatedLiquidDensity(flowNode.fluid.temperature);
    const rho_g = Water.saturatedVaporDensity(flowNode.fluid.temperature);
    const liquidVolFrac =
      ((1 - quality) / rho_f) / ((1 - quality) / rho_f + quality / rho_g);
    return {
      liquidArea: conn.surfaceArea * liquidVolFrac,
      vaporArea: conn.surfaceArea * (1 - liquidVolFrac),
    };
  }

  if (phase === 'liquid') return { liquidArea: conn.surfaceArea, vaporArea: 0 };
  if (phase === 'vapor') return { liquidArea: 0, vaporArea: conn.surfaceArea };

  const quality = flowNode.fluid.quality ?? 0;
  const liquidMass = flowNode.fluid.mass * (1 - quality);
  const liquidVolume = liquidMass / Water.saturatedLiquidDensity(flowNode.fluid.temperature);
  const liquidLevel = calculateLiquidLevelWithObstructions(flowNode, liquidVolume);

  const tubeBottom = conn.tubeBottomElevation;
  let submergedFraction: number;
  if (liquidLevel <= tubeBottom) {
    submergedFraction = 0;
  } else if (liquidLevel >= tubeBottom + conn.tubeHeight) {
    submergedFraction = 1;
  } else {
    submergedFraction = (liquidLevel - tubeBottom) / conn.tubeHeight;
  }

  return {
    liquidArea: conn.surfaceArea * submergedFraction,
    vaporArea: conn.surfaceArea * (1 - submergedFraction),
  };
}

// ============================================================================
// Zirconium oxidation constants
// ============================================================================

const ZR_MOLAR_MASS = 0.09122;     // kg/mol
const ZR_DENSITY = 6500;           // kg/m3
const H2O_MOLAR_MASS = 0.018015;   // kg/mol
const R_GAS_J = 8.314;             // J/mol-K

/** Zr + 2 H2O -> ZrO2 + 2 H2, per mol Zr (J). */
const STEAM_REACTION_ENTHALPY = 586e3;
/**
 * Zr + O2 -> ZrO2, per mol Zr (J). 262 kcal/mol - Benjamin et al.,
 * NUREG/CR-0649 Section 3.2, and the same number as the standard enthalpy of
 * formation of zirconia. Nearly twice the steam reaction, which is the whole
 * reason a DRY rack is worse than a steaming one.
 */
const AIR_REACTION_ENTHALPY = 1096e3;

/** Specific enthalpy leaving with steam that the reaction consumed (J/kg). */
const STEAM_ENTHALPY_OUT = 2.0e6;

/**
 * Oxide already on the metal when a run starts, as METAL thickness consumed
 * (m). A parabolic law is singular at zero thickness and cladding is never
 * bare: spent fuel carries 15-20 um of waterside corrosion oxide out of the
 * reactor, and Benjamin et al. used 1.5 um as the conservative value for
 * their spent-fuel heat-up calculations. 1 um of metal is about 1.6 um of
 * oxide, so this is that conservative choice.
 */
const INITIAL_OXIDE_THICKNESS = 1e-6;

/**
 * Zr + steam parabolic constant, d(X^2)/dt in m2/s with X the metal
 * thickness consumed.
 *
 * Baker-Just (1962), the conservative licensing correlation:
 *   (m/A)^2 = 3.33e7 * t * exp(-45500/(R T)),  m/A in mg Zr/cm2, R cal/mol-K.
 * Converting mg Zr/cm2 to metres of metal (1.53846e-6 m per mg/cm2 at 6500
 * kg/m3) squares to 2.36686e-12, so A = 2.36686e-12 * 3.33e7 = 7.8817e-5.
 *
 * NOTE: the previous code carried 3.33e-3 m2/s here, having converted
 * "33.3 cm2/s" to m2/s by 1e-4. That is not what the correlation's constant
 * means - its units are (mg/cm2)^2/s - and it made this reaction 42x too
 * fast in k, i.e. 6.5x too fast in rate. Fixed together with the air
 * reaction below, because two rate laws that are meant to run in parallel
 * have to be on the same footing to be compared at all.
 */
function steamParabolicConstant(T: number): number {
  return 7.8817e-5 * Math.exp(-190372 / (R_GAS_J * T));
}

/**
 * Zr + air parabolic constant, same units.
 *
 * Benjamin et al., NUREG/CR-0649 (Sandia, 1979), Fig. 6: three fitted
 * branches of 2W dW/dt = K0 exp(-Ea/RT) with W in mg O2/cm2 and Ea in
 * cal/mol. One mg of O2 per cm2 corresponds to 4.3857e-6 m of metal
 * (M_Zr/M_O2 = 2.8507, over 6500 kg/m3), so d(X^2)/dt = 1.9235e-11 K0
 * exp(-Ea/RT), and Ea x 4.184 puts the exponent in J/mol.
 *
 * The two breakpoints are the source's, not ours, and it says what they
 * are: the alpha/beta change in the Zr-O solid solution at 920 C, and the
 * monoclinic-to-tetragonal change in ZrO2 at 1155 C. The first pair join
 * continuously (they agree to 0.1% at 1193 K, which is how the fit was
 * made); the third branch steps UP by about 5x at 1428 K. That step is the
 * correlation's own and is reproduced rather than smoothed away - but it is
 * nearly invisible in a fire, where above ~1100 C it is the oxygen supply
 * and not the kinetics that governs.
 */
function airParabolicConstant(T: number): number {
  if (T <= 1193.15) return 2.2120e-8 * Math.exp(-114391 / (R_GAS_J * T));   // <= 920 C
  if (T <= 1428.15) return 1.1079e-3 * Math.exp(-221710 / (R_GAS_J * T));   // <= 1155 C
  return 1.1926e-6 * Math.exp(-121658 / (R_GAS_J * T));                     // above
}

/**
 * Chemical power (W) released by each cladding node's oxidation, from the
 * last rate evaluation. For displays only - the flames the grid view draws
 * over a burning rack scale with it - never for physics.
 */
const lastOxidationPower = new Map<string, number>();

export function getCladdingOxidationPower(): ReadonlyMap<string, number> {
  return lastOxidationPower;
}

// ============================================================================
// Cladding Oxidation Rate Operator
// ============================================================================

/**
 * Cladding Oxidation Rate Operator
 *
 * Zirconium burns in anything that carries oxygen. Two reactions run in
 * PARALLEL on the same metal, each on its own oxidant's partial pressure -
 * there is no regime switch anywhere in here, because a rack half in steam
 * and half in air is doing both at once:
 *
 *   Zr + 2 H2O -> ZrO2 + 2 H2    586 kJ/mol Zr   (and hydrogen)
 *   Zr +   O2  -> ZrO2          1096 kJ/mol Zr   (and nothing to burn later)
 *
 * The air reaction releases nearly twice the heat per mole of metal and,
 * above ~900 C, runs faster as well. That combination is what makes a
 * DRAINED spent fuel pool - racks standing in open air with no water left to
 * boil - a worse place than a flooded one, and it is why this operator has
 * to see the node's gas composition rather than assume steam.
 *
 * ## Rate law
 *
 * Both reactions grow a protective oxide, so both are parabolic in the
 * thickness of metal already consumed, X:
 *
 *     d(X^2)/dt = k(T)      =>      dX/dt = k(T) / (2 X)
 *
 * X starts at a real pre-existing film rather than zero (spent cladding
 * carries 15-20 um of waterside corrosion oxide out of the reactor;
 * Benjamin et al. used 1.5 um as the conservative value, which is what
 * INITIAL_OXIDE_THICKNESS is). Without it the parabolic law is singular at
 * t = 0.
 *
 * ## Oxidant supply, in series with the kinetics
 *
 * Growing the oxide consumes oxidant, and the oxidant has to arrive through
 * the gas. Those are two resistances in series, so the flux is their
 * harmonic mean:
 *
 *     J = 1 / ( 1/J_kinetic + 1/J_transport ),   J_transport = h_m * C_bulk
 *
 * exactly as the graphite oxidation operator does it. Nothing switches:
 * when the gas is rich the kinetics govern, when the gas is thin the
 * boundary layer governs, and when the oxygen is gone C_bulk is zero and so
 * is the rate. OXYGEN STARVATION IS NOT A RULE HERE - it is what this
 * expression does on its own. So is ignition: nothing in this file knows
 * about an ignition temperature. A rack ignites when the heat this releases
 * outruns what the rack can lose, which is a property of the heat balance,
 * not of the rate law.
 *
 * Benjamin et al. did the same thing with a min() of the two rates and the
 * heat/mass-transfer analogy for the transport term; the harmonic mean is
 * the smooth version of that min.
 *
 * ## Where the surface is
 *
 * The submerged part of a rack sits against liquid water: unlimited steam
 * supply at the surface, so it is purely kinetics-limited, and no oxygen.
 * The emerged part sits in the node's gas and reacts with whatever is in
 * it. The split is the same liquid-level split the convection model uses.
 *
 * ## Constants and their sources
 *
 * STEAM - Baker-Just (1962), the conservative licensing correlation:
 *   (m/A)^2 = 3.33e7 t exp(-45500/RT), m/A in mg Zr/cm2, R in cal/mol-K.
 *
 * AIR - Benjamin et al., "Spent Fuel Heatup Following Loss of Water During
 * Storage", NUREG/CR-0649 (Sandia, 1979), Section 3.2 and Figure 6 - the
 * study this whole scenario comes from. Three fitted branches:
 *   2W dW/dt = K0 exp(-Ea/RT), W in mg O2/cm2, Ea in cal/mol,
 *   K0 = 1.15e3, Ea = 27340   (T <= 920 C)
 *   K0 = 5.76e7, Ea = 52990   (920 C < T <= 1155 C)
 *   K0 = 6.20e4, Ea = 29077   (T > 1155 C)
 *
 * Both are converted here to metal-recession form, d(X^2)/dt in m2/s. See
 * docs/zircaloy-air-oxidation.md for the arithmetic.
 *
 * NOT MODELLED: nitriding as a separate reaction. Benjamin's constants are
 * fitted to Zircaloy in AIR, so the nitrogen's effect on the oxide is inside
 * them; what is missing is the separate ZrN inventory and its re-oxidation,
 * and the breakaway transition that KIT's later work resolves.
 */
export class CladdingOxidationRateOperator implements RateOperator {
  name = 'CladdingOxidation';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const [id, node] of state.thermalNodes) {
      if (!node.oxidation) continue;
      const ox = node.oxidation;
      if (ox.oxidizedFraction >= 1 || ox.totalZrMass <= 0) continue;

      const T = node.temperature;
      const coolantNode = state.flowNodes.get(ox.associatedCoolantNode);
      if (!coolantNode) {
        throw new Error(
          `[CladdingOxidation] Node '${id}' names coolant node ` +
          `'${ox.associatedCoolantNode}', which does not exist. Both the oxidant ` +
          `supply and the hydrogen release depend on it; there is no default.`
        );
      }

      // --- Where the surface is -----------------------------------------
      // The convection connection carries the rod geometry and the same
      // liquid-level split the heat transfer uses.
      const conn = state.convectionConnections.find(c => c.thermalNodeId === id);
      if (!conn) {
        throw new Error(
          `[CladdingOxidation] Cladding node '${id}' has no convection connection, ` +
          `so there is no rod geometry and no liquid level to say which part of it ` +
          `stands in water. A clad node without one is a build error.`
        );
      }
      const { liquidArea, vaporArea } = effectiveSurfaceAreas(conn, coolantNode);
      const rodDiameter = conn.characteristicDiameter ?? coolantNode.hydraulicDiameter;

      // --- Oxide thickness already grown --------------------------------
      const X = Math.max(node.characteristicLength * ox.oxidizedFraction,
        INITIAL_OXIDE_THICKNESS);
      // Metal left to attack: the core shrinks as the oxide eats inward.
      const remaining = Math.sqrt(Math.max(0, 1 - ox.oxidizedFraction));
      if (remaining <= 0) continue;

      /** Oxide-limited metal recession velocity (m/s) for a rate constant. */
      const recession = (k: number) => (k * remaining) / (2 * X);

      // --- The gas at the surface ---------------------------------------
      const ncg = coolantNode.fluid.ncg ?? emptyGasComposition();
      const T_gas = coolantNode.fluid.temperature;
      const P = coolantNode.fluid.pressure;
      const volume = coolantNode.volume;
      const quality = coolantNode.fluid.quality ?? 0;
      const steamVaporMass = coolantNode.fluid.phase === 'two-phase'
        ? coolantNode.fluid.mass * quality
        : (coolantNode.fluid.phase === 'vapor' ? coolantNode.fluid.mass : 0);
      const steamMoles = Math.max(0, steamVaporMass / H2O_MOLAR_MASS);

      // Bulk concentrations of the two oxidants IN THE GAS SPACE, straight
      // from the inventory that is actually there. Taking them from the
      // node's pressure instead would let a node that has boiled itself down
      // to a few grams still supply steam at its last known pressure - the
      // reaction would consume steam the node does not have. Reading the
      // moles makes consumption first order in what is present, so depletion
      // is a smooth exponential run-down and starvation needs no rule
      // (the graphite oxidation operator does the same thing for the same
      // reason).
      // The gas space the mixture solve left (nodeGasVolume), the same room
      // every partial pressure is priced over - not the volume minus the
      // liquid's mass over a density fit
      const gasVolume = coolantNode.fluid.phase === 'vapor'
        ? volume
        : Math.max(0, Math.min(volume, nodeGasVolume(coolantNode)));
      const C_steam = gasVolume > 0 ? steamMoles / gasVolume : 0;
      const C_O2 = gasVolume > 0 ? Math.max(0, ncg.O2 ?? 0) / gasVolume : 0;

      // External mass transfer, the same Sherwood correlation the graphite
      // operator uses: Sh = 2 + 0.6 Re^0.5 Sc^(1/3). The leading 2 is the
      // stagnant limit, so oxidant still reaches a rod with every pump dead -
      // which is the condition a drained pool runs in.
      let totalMassFlow = 0;
      for (const fc of state.flowConnections) {
        if (fc.fromNodeId === coolantNode.id || fc.toNodeId === coolantNode.id) {
          totalMassFlow += Math.abs(fc.massFlowRate);
        }
      }
      const rho_g = approxVaporDensity(coolantNode);
      const mu_g = mixtureViscosity(ncg, T_gas);
      const passageArea = conn.flowPassageArea ?? coolantNode.flowArea;
      const velocity = passageArea > 0 && rho_g > 0 ? totalMassFlow / (rho_g * passageArea) : 0;
      const Re = mu_g > 0 && rodDiameter > 0 ? (rho_g * velocity * rodDiameter) / mu_g : 0;

      const massTransferCoeff = (species: 'H2O' | 'O2'): number => {
        if (!(rodDiameter > 0) || !(T_gas > 0) || !(P > 0)) return 0;
        const D = diffusivityInMixture(species, ncg, steamMoles, T_gas, P);
        const Sc = mu_g > 0 && rho_g > 0 ? mu_g / (rho_g * D) : 1;
        const Sh = 2 + 0.6 * Math.sqrt(Math.max(0, Re)) * Math.cbrt(Math.max(1e-6, Sc));
        return (Sh * D) / rodDiameter;   // m/s
      };

      /** Series (harmonic) combination of a kinetic and a transport flux. */
      const seriesFlux = (jKin: number, jTransport: number): number =>
        jKin > 0 && jTransport > 0 ? 1 / (1 / jKin + 1 / jTransport) : 0;

      // --- The two reactions ---------------------------------------------
      // mol Zr/s consumed by each, kept separate because their heats differ
      // by a factor of two.
      const molPerArea = (v: number) => (ZR_DENSITY * v) / ZR_MOLAR_MASS; // mol Zr/(m2 s)

      // Steam: on the wetted surface it is kinetics all the way (there is a
      // whole pool of water against it); on the dry surface it competes for
      // whatever steam shares the gas.
      const vSteam = recession(steamParabolicConstant(T));
      const jZrSteamKin = molPerArea(vSteam);
      const molZrSteam =
        jZrSteamKin * liquidArea +
        seriesFlux(2 * jZrSteamKin, massTransferCoeff('H2O') * C_steam) / 2 * vaporArea;

      // Air: only where the metal is actually in the gas.
      const vAir = recession(airParabolicConstant(T));
      const jZrAirKin = molPerArea(vAir);
      const molZrAir = seriesFlux(jZrAirKin, massTransferCoeff('O2') * C_O2) * vaporArea;

      const molZrTotal = molZrSteam + molZrAir;
      if (!(molZrTotal > 0) || !Number.isFinite(molZrTotal)) continue;

      const dm_Zr_dt = molZrTotal * ZR_MOLAR_MASS;   // kg/s

      // --- Book it ---------------------------------------------------------
      const nodeRates = rates.thermalNodes.get(id) || { dTemperature: 0 };
      nodeRates.dOxidizedFraction = dm_Zr_dt / ox.totalZrMass;

      const heat = molZrSteam * STEAM_REACTION_ENTHALPY + molZrAir * AIR_REACTION_ENTHALPY;
      nodeRates.dTemperature += heat / nodeHeatCapacity(node);
      rates.thermalNodes.set(id, nodeRates);
      lastOxidationPower.set(id, heat);

      const coolantRates = rates.flowNodes.get(ox.associatedCoolantNode)
        || { dMass: 0, dEnergy: 0 };
      if (!coolantRates.dNcg) coolantRates.dNcg = emptyGasComposition();

      // Steam side: 2 mol H2O in, 2 mol H2 out, per mol Zr. The water leaves
      // the node's mass with its specific enthalpy; the hydrogen joins the
      // non-condensables, where the combustion operator can find it.
      const molH2O = 2 * molZrSteam;
      coolantRates.dNcg.H2 += molH2O;
      const steamMassRate = molH2O * H2O_MOLAR_MASS;
      coolantRates.dMass -= steamMassRate;
      coolantRates.dEnergy -= steamMassRate * STEAM_ENTHALPY_OUT;

      // Air side: 1 mol O2 in per mol Zr, and nothing comes back out - the
      // oxide is a solid. The node loses moles, its pressure falls, and it
      // pulls more air in through whatever opening it has. That is the draft
      // a fire feeds on, and it is not written anywhere; it is just Dalton.
      coolantRates.dNcg.O2 -= molZrAir;

      rates.flowNodes.set(ox.associatedCoolantNode, coolantRates);
    }

    return rates;
  }
}

// ============================================================================
// Fission Product Release Rate Operator
// ============================================================================

/**
 * Fission Product Release Rate Operator ("meltdown!")
 *
 * Overheated fuel releases its fission-product inventory at CORSOR-style
 * Arrhenius fractional rates:
 *   dN/dt = -N * k0 * exp(-Q/(R*T_fuel))
 * Constants are fit so release is negligible below ~1300 K, ~1%/20 min at
 * 1600 K (failed cladding, hot fuel), and minutes-scale at fuel melting -
 * so the release curve tracks damage severity with no discrete "clad
 * failure" or "melt" events. Volatiles (CsI) come out ~3x slower than noble
 * gases at the same temperature.
 *
 * Released moles enter the associated coolant node's NCG as Xe (noble
 * gases) and CsI (volatile aerosol) and from there ride the ordinary NCG
 * transport - out breaks, through valves, into containment, to the
 * environment (tracked in state.environmentalRelease when they cross a
 * boundary node).
 */
export class FissionProductReleaseOperator implements RateOperator {
  name = 'FissionProductRelease';

  // Arrhenius constants (fit described above)
  private static readonly Q_OVER_R = 25800;  // K
  private static readonly K0_NOBLE = 100;    // 1/s
  private static readonly K0_VOLATILE = 33;  // 1/s

  // Aerosol settling velocity for agglomerated CsI (Stokes law):
  // v = rho_p d² g / (18 mu) with rho_p = 4510 kg/m³ (CsI), d ~ 3 µm
  // (aged/agglomerated aerosol), mu ~ 2e-5 Pa·s -> ~1 mm/s. In a
  // containment-sized volume (V/A ~ 10 m) that is a removal half-life of
  // a couple of hours, consistent with MELCOR-scale behavior.
  private static readonly CSI_SETTLING_VELOCITY = 1.1e-3; // m/s

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    // CsI aerosol deposition: first-order plate-out in every node carrying
    // airborne CsI. lambda = v_settle * A_floor / V (the fraction of the
    // volume swept clean per second); A_floor = V/height.
    for (const [id, node] of state.flowNodes) {
      const airborne = node.fluid.ncg?.CsI ?? 0;
      if (airborne <= 0) continue;
      if (node.isBoundary) continue; // atmosphere is tracked via environmentalRelease
      const height = node.height && node.height > 0 ? node.height : Math.cbrt(node.volume);
      const lambda = FissionProductReleaseOperator.CSI_SETTLING_VELOCITY / height; // 1/s
      const depositionRate = airborne * lambda; // mol/s

      const nodeRates = rates.flowNodes.get(id) || { dMass: 0, dEnergy: 0 };
      if (!nodeRates.dNcg) nodeRates.dNcg = emptyGasComposition();
      nodeRates.dNcg.CsI -= depositionRate;
      nodeRates.dDepositedCsI = (nodeRates.dDepositedCsI ?? 0) + depositionRate;
      rates.flowNodes.set(id, nodeRates);
    }

    for (const [id, node] of state.thermalNodes) {
      const fp = node.fissionProducts;
      if (!fp) continue;
      if (fp.nobleGas <= 0 && fp.volatile <= 0) continue;

      // FP inventory stays booked on the fuel node through relocation (so
      // per-node initial-inventory fractions keep meaning), but physically
      // it is distributed over the in-core fuel, the in-vessel corium pool,
      // and the ex-vessel debris bed in proportion to fuel-oxide mass. Each
      // location outgasses at ITS OWN temperature into the gas space it
      // actually sits in: fuel and pool into the core coolant, ex-vessel
      // debris straight into the containment atmosphere.
      const locations: Array<{ T: number; oxide: number; target: string }> = [
        { T: node.temperature, oxide: node.mass, target: fp.associatedCoolantNode },
      ];
      for (const loc of node.meltLocations ?? []) {
        const melt = state.thermalNodes.get(loc.nodeId);
        if (melt && melt.mass > 2) {
          locations.push({
            T: melt.temperature,
            oxide: fuelOxideMass(melt),
            target: loc.releaseTo ?? fp.associatedCoolantNode,
          });
        }
      }
      const oxideTotal = locations.reduce((s, l) => s + l.oxide, 0);
      if (oxideTotal <= 0) continue;

      let dNobleTotal = 0;
      let dVolatileTotal = 0;
      for (const loc of locations) {
        // Below ~1000 K the Arrhenius rate is < 1e-9/s (nothing in sim
        // lifetimes) - skip the map churn, not a behavioral threshold
        if (loc.T < 1000 || loc.oxide <= 0) continue;
        const targetNode = state.flowNodes.get(loc.target);
        if (!targetNode) continue;

        const share = loc.oxide / oxideTotal;
        const arrhenius = Math.exp(-FissionProductReleaseOperator.Q_OVER_R / loc.T);
        const dNoble = -fp.nobleGas * share * FissionProductReleaseOperator.K0_NOBLE * arrhenius;
        const dVolatile = -fp.volatile * share * FissionProductReleaseOperator.K0_VOLATILE * arrhenius;
        dNobleTotal += dNoble;
        dVolatileTotal += dVolatile;

        // Releases arrive carrying their thermal energy at the receiving
        // node's temperature (keeps the NCG energy balance consistent)
        const targetRates = rates.flowNodes.get(loc.target) || { dMass: 0, dEnergy: 0 };
        if (!targetRates.dNcg) targetRates.dNcg = emptyGasComposition();
        targetRates.dNcg.Xe += -dNoble;
        targetRates.dNcg.CsI += -dVolatile;
        const Cv_Xe = 12.47; // J/mol-K, monatomic
        targetRates.dEnergy += (-dNoble - dVolatile) * Cv_Xe * targetNode.fluid.temperature;
        rates.flowNodes.set(loc.target, targetRates);
      }

      if (dNobleTotal < 0 || dVolatileTotal < 0) {
        const thermalRates = rates.thermalNodes.get(id) || { dTemperature: 0 };
        thermalRates.dFpNobleGas = dNobleTotal;
        thermalRates.dFpVolatile = dVolatileTotal;
        rates.thermalNodes.set(id, thermalRates);
      }
    }

    return rates;
  }
}
