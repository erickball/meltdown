/**
 * Rate-Based Physics Operators for RK45 Integration
 *
 * These operators compute derivatives (rates of change) rather than
 * applying changes directly. This allows the RK45 solver to combine
 * them properly for higher-order accuracy.
 *
 * Each operator returns StateRates describing dm/dt, dU/dt, dT/dt, etc.
 */

import { SimulationState, FlowNode, FlowConnection, ConvectionConnection } from '../types';
import {
  RateOperator,
  ConstraintOperator,
  StateRates,
  createZeroRates,
} from '../rk45-solver';
import { cloneSimulationState } from '../solver';
import { computeReactivityComponents, getRelocatedFuelFraction } from './neutronics';
import * as Water from '../water-properties';
import { simulationConfig } from '../types';
import {
  ncgPartialPressure,
  totalMoles,
  totalMass as ncgTotalMass,
  emptyGasComposition,
  ALL_GAS_SPECIES,
  mixtureCv,
  mixtureCp,
  mixtureThermalConductivity,
  mixtureViscosity,
  averageMolecularWeight,
  ncgSoundSpeed,
  steamNcgSoundSpeed,
  R_GAS,
} from '../gas-properties';
import { soundSpeed, criticalPressureRatio, WaterState } from '../water-properties-v4';
import {
  calculateSeparation,
  calculateLiquidLevelWithObstructions,
  findCheckValveForConnection,
  computeConnectionHydraulics,
  computeChokeLimit,
  approxVaporDensity,
  CLOSED_FLOW_DECAY_TAU,
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
  meltingPoint?: number; latentHeatFusion?: number;
}): number {
  let C = node.mass * node.specificHeat;
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

      // Heat flow from node1 to node2 (W)
      const Q = conn.conductance * (node1.temperature - node2.temperature);

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

export class ConvectionRateOperator implements RateOperator {
  name = 'Convection';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const conn of state.convectionConnections) {
      const thermalNode = state.thermalNodes.get(conn.thermalNodeId);
      const flowNode = state.flowNodes.get(conn.flowNodeId);

      if (!thermalNode || !flowNode) continue;

      // Split the surface into liquid-wetted and vapor-exposed portions by
      // the node's liquid level (tubes above the water line barely transfer).
      const { liquidArea, vaporArea } = this.effectiveSurfaceAreas(conn, flowNode);

      const dT = thermalNode.temperature - flowNode.fluid.temperature;
      const D = conn.characteristicDiameter ?? flowNode.hydraulicDiameter;

      const h_liquid = this.liquidHeatTransferCoeff(flowNode, state, conn, D);
      const h_vapor = this.vaporHeatTransferCoeff(flowNode, state, D);
      const Q = h_liquid * liquidArea * dT + h_vapor * vaporArea * dT;

      lastConvectionHeatRates.set(conn.id, Q);

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
  private effectiveSurfaceAreas(
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

  /**
   * Wetted-surface heat transfer coefficient: single-phase forced convection
   * (Dittus-Boelter at the connection's characteristic diameter) plus, for a
   * saturated (two-phase) node, a phase-change term.
   *
   * Cold walls (condensation): Thom's nucleate-boiling correlation with a
   * Zuber critical-heat-flux saturation, added to the convective term
   * (Rohsenow superposition) - condensation has no boiling crisis, so the
   * saturated-Thom form applies at any subcooling.
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
    D: number
  ): number {
    const fluid = flowNode.fluid;

    // Get flow rate through this node
    let totalMassFlow = 0;
    for (const fc of state.flowConnections) {
      if (fc.fromNodeId === flowNode.id || fc.toNodeId === flowNode.id) {
        totalMassFlow += Math.abs(fc.massFlowRate);
      }
    }

    // Liquid-phase properties (representative values)
    const rho = fluid.phase === 'two-phase'
      ? Water.saturatedLiquidDensity(fluid.temperature)
      : fluid.mass / flowNode.volume;
    const mu = 0.0003; // Pa·s
    const k = 0.6;     // W/m-K
    const Pr = 2.0;

    const velocity = totalMassFlow / (rho * flowNode.flowArea);
    const Re = (rho * velocity * D) / mu;

    const h_natural = 500; // W/m²-K floor (natural convection)
    let h = h_natural;
    if (Re >= 2300) {
      const Nu = 0.023 * Math.pow(Re, 0.8) * Math.pow(Pr, 0.4);
      h = Math.max(h_natural, (Nu * k) / D);
    }

    // Phase-change enhancement on saturated nodes
    if (fluid.phase === 'two-phase') {
      const thermalNode = state.thermalNodes.get(conn.thermalNodeId);
      if (thermalNode) {
        const dTsigned = thermalNode.temperature - fluid.temperature;
        const P = fluid.pressure;
        if (dTsigned < 0) {
          // Cold wall: condensation - no vapor blanketing, so the saturated-
          // Thom enhancement applies at any subcooling.
          // Thom: dT_sat = 22.65 * q[MW/m²]^0.5 * exp(-P/8.7 MPa)
          //   =>  q = (dT * exp(P/8.7e6) / 22.65)^2 * 1e6  [W/m²]
          // Zuber saturation q = qThom / (1 + qThom/qCHF) keeps the flux from
          // running to absurd values at large subcooling.
          const dT = -dTsigned;
          const qThom = Math.pow((dT * Math.exp(P / 8.7e6)) / 22.65, 2) * 1e6;
          const qCHF = zuberCriticalHeatFlux(fluid.temperature);
          if (qCHF > 0) h += qThom / (1 + qThom / qCHF);
        } else if (dTsigned > 0) {
          // Hot wall: full boiling curve with post-CHF collapse.
          // Convection and nucleate boiling act only on the wetted fraction;
          // the vapor film replaces (not augments) them on the rest of the
          // surface - this IS the h collapse.
          const { wettedFraction, h_phaseChange } = boilingCurve(
            fluid.temperature, P, thermalNode.temperature, D
          );
          h = wettedFraction * h + h_phaseChange;
        }
      }
    }

    return h;
  }

  /**
   * Vapor-exposed surface: Dittus-Boelter with the ACTUAL gas mixture's
   * properties - steam blended with any NCG by vapor-space mole fraction.
   * Pure steam keeps its low conductivity (tubes above the water line
   * transfer little - dryout); a helium loop gets helium's ~5x better
   * conductivity, which is what makes gas-cooled cores coolable at all.
   */
  private vaporHeatTransferCoeff(flowNode: FlowNode, state: SimulationState, D: number): number {
    let totalMassFlow = 0;
    for (const fc of state.flowConnections) {
      if (fc.fromNodeId === flowNode.id || fc.toNodeId === flowNode.id) {
        totalMassFlow += Math.abs(fc.massFlowRate);
      }
    }

    const T = flowNode.fluid.temperature;
    const ncg = flowNode.fluid.ncg;
    const nNcg = ncg ? totalMoles(ncg) : 0;

    // Steam sharing the vapor space (all water for a vapor node, the vapor
    // fraction for a two-phase node)
    const steamVaporMass = flowNode.fluid.phase === 'two-phase'
      ? flowNode.fluid.mass * (flowNode.fluid.quality ?? 0)
      : flowNode.fluid.mass;
    const nSteam = steamVaporMass / 0.018;
    const xNcg = nNcg > 0 ? nNcg / (nNcg + nSteam) : 0;

    // Mole-fraction blend of steam and NCG transport properties
    const k_steam = 0.03, mu_steam = 2e-5, cpMolar_steam = 37, M_steam = 0.018;
    let k = k_steam, mu = mu_steam, cpMolar = cpMolar_steam, M = M_steam;
    if (xNcg > 0 && ncg) {
      k = (1 - xNcg) * k_steam + xNcg * mixtureThermalConductivity(ncg, T);
      mu = (1 - xNcg) * mu_steam + xNcg * mixtureViscosity(ncg, T);
      cpMolar = (1 - xNcg) * cpMolar_steam + xNcg * mixtureCp(ncg);
      M = (1 - xNcg) * M_steam + xNcg * averageMolecularWeight(ncg);
    }
    const Pr = (cpMolar / M) * mu / k;

    // Vapor-space density: ideal-gas steam at its partial pressure plus the
    // NCG mixture (valid above the water critical point, unlike the
    // saturated-vapor table this replaced)
    const rho_g = approxVaporDensity(flowNode);

    const velocity = totalMassFlow > 0 ? totalMassFlow / (rho_g * flowNode.flowArea) : 0;
    const Re = (rho_g * velocity * D) / mu;

    const h_natural = 50; // W/m²-K
    if (Re < 2300) return h_natural;

    const Nu = 0.023 * Math.pow(Re, 0.8) * Math.pow(Pr, 0.4);
    return Math.max(h_natural, (Nu * k) / D);
  }
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
        for (const suffix of ['-corium', '-corium-ex']) {
          const melt = state.thermalNodes.get(id.replace(/-fuel$/, suffix));
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
    for (const [id, node] of state.flowNodes) {
      if (node.isBoundary) continue;
      const q = node.heaterPower ?? 0;
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

/**
 * Fission-product decay heat groups: a coarse 4-group fit to ANS-5.1 decay
 * power after long operation. Each group builds toward fraction*P_fission
 * with time constant 1/lambda and releases its inventory after shutdown:
 * ~5% of prior power at 10 s, ~3% at 100 s, ~1.5% at 1000 s.
 */
export const DECAY_HEAT_GROUPS: ReadonlyArray<{ fraction: number; lambda: number }> = [
  { fraction: 0.026, lambda: 0.1 },   // short-lived products, tau ~10 s
  { fraction: 0.020, lambda: 0.01 },  // tau ~100 s
  { fraction: 0.012, lambda: 1e-3 },  // tau ~17 min
  { fraction: 0.012, lambda: 1e-4 },  // tau ~2.8 h
];

/** Fraction of fission energy that is delayed (deposited via the pools) */
export const DECAY_HEAT_TOTAL_FRACTION = DECAY_HEAT_GROUPS.reduce((s, g) => s + g.fraction, 0);

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

      const result = this.analyticalPointKinetics(N, C, rho, beta, Lambda, lambda);
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
      // This prevents unrealistic phase separation when flow exceeds what the
      // interface can supply. (Approved fallback - discussed with user)
      //
      // Conservative limit: 10x per second max drain rate for a single phase.
      // This is deliberately a last-resort backstop, not a physical model -
      // real volumes can drain fast, and phase replenishment (boiling,
      // flashing) is already part of the energy bookkeeping.
      // If drain rate exceeds this, switch to mixture mode which draws from
      // the whole mass proportionally.
      if (upstreamNode.fluid.phase === 'two-phase' && flowPhase !== 'mixture') {
        const quality = upstreamNode.fluid.quality ?? 0;
        const totalMass = upstreamNode.fluid.mass;
        const maxDrainRate = 10; // per second - can drain the phase 10x per second max

        if (flowPhase === 'vapor') {
          const vaporMass = totalMass * quality;
          // If trying to drain vapor faster than limit, use mixture
          if (vaporMass < 1e-6 || absMassFlow > maxDrainRate * vaporMass) {
            flowPhase = 'mixture';
          }
        } else if (flowPhase === 'liquid') {
          const liquidMass = totalMass * (1 - quality);
          // If trying to drain liquid faster than limit, use mixture
          if (liquidMass < 1e-6 || absMassFlow > maxDrainRate * liquidMass) {
            flowPhase = 'mixture';
          }
        }
      }

      // Get specific enthalpy based on what's actually flowing
      const h_up = this.getSpecificEnthalpy(upstreamNode, flowPhase);

      // The connection's mass flow is TOTAL mixture flow (the momentum
      // solvers use bulk density including NCG), so when the flowing phase
      // carries gas, the flow must be SPLIT between water and NCG by the
      // mass composition of what is actually flowing. Liquid draws leave the
      // NCG behind in the vapor space (waterShare = 1). A helium-filled node
      // (~no water) transports ~pure gas; a steam node transports ~pure
      // water; both fall out of the same split with no special cases.
      const upNcg = upstreamNode.fluid.ncg;
      let waterShare = 1;
      let gasMassInSpace = 0;
      if (upNcg && totalMoles(upNcg) > 0 && (flowPhase === 'vapor' || flowPhase === 'mixture')) {
        gasMassInSpace = ncgTotalMass(upNcg);
        // Steam sharing the flowing space with the gas: the vapor space's
        // steam for vapor draws from a two-phase node, all water otherwise
        const steamMassInSpace =
          flowPhase === 'vapor' && upstreamNode.fluid.phase === 'two-phase'
            ? upstreamNode.fluid.mass * (upstreamNode.fluid.quality ?? 0)
            : upstreamNode.fluid.mass;
        const totalInSpace = gasMassInSpace + steamMassInSpace;
        waterShare = totalInSpace > 0 ? steamMassInSpace / totalInSpace : 1;
      }

      // Water portion: mass flow * specific enthalpy of the flowing phase
      const waterFlow = absMassFlow * waterShare;
      const energyFlow = waterFlow * h_up;

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
      console.error(`[ncgEffectiveT] ${node.id}: effective T=${T.toFixed(1)}K - energy accounting broken ` +
        `(totalU=${(node.fluid.internalEnergy / 1e6).toFixed(4)}MJ, ncg=${n.toFixed(1)}mol, ` +
        `m=${node.fluid.mass.toFixed(3)}kg, phase=${node.fluid.phase}, x=${quality.toFixed(3)})`);
      return 50;
    }
    return T;
  }

  private getSpecificEnthalpy(node: FlowNode, flowPhase: 'liquid' | 'vapor' | 'mixture'): number {
    const P = node.fluid.pressure;
    const T = node.fluid.temperature;
    const T_C = T - 273.15;

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

          if (waterEnergy < 0) {
            console.error(`[getSpecificEnthalpy] ${node.id}: Negative water energy!`);
            console.error(`  totalU=${(totalU/1e6).toFixed(4)}MJ, ncgEnergy=${(ncgEnergy/1e6).toFixed(4)}MJ`);
            console.error(`  T_eff=${T_eff.toFixed(1)}K, stored T=${T.toFixed(1)}K`);
            console.error(`  ncgMoles=${ncgMoles.toFixed(1)}, waterMass=${node.fluid.mass.toFixed(3)}kg`);
            waterEnergy = 0;
          }

          // NCG volume from ideal gas: V_ncg = n * R * T / P
          const R_GAS = 8.314;  // J/(mol·K)
          const ncgVolume = ncgMoles * R_GAS * T_eff / P;
          waterVolume = Math.max(0.001, waterVolume - ncgVolume);
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

    // Find turbines dynamically by looking for nodes that have "turbine-generator" in the ID
    // Skip extraction nodes (they have parentTurbineId set)
    for (const [turbineNodeId, turbineNode] of state.flowNodes) {
      // Check if this is a main turbine node (not an extraction node)
      const isTurbine = turbineNodeId.includes('turbine-generator') ||
                        (turbineNode.label?.toLowerCase().includes('turbine') &&
                         !turbineNode.parentTurbineId);

      if (!isTurbine) continue;
      if (turbineNode.parentTurbineId) continue; // Skip extraction nodes

      // Find flow INTO the turbine
      let inletMassFlow = 0;
      let outletNodeId: string | null = null;

      for (const conn of state.flowConnections) {
        // Flow into turbine
        if (conn.toNodeId === turbineNodeId && conn.massFlowRate > 0) {
          inletMassFlow += conn.massFlowRate;
        }
        // Flow out of turbine main outlet (to condenser)
        if (conn.fromNodeId === turbineNodeId && conn.massFlowRate > 0) {
          outletNodeId = conn.toNodeId;
        }
      }

      if (inletMassFlow < 1 || !outletNodeId) continue;

      const outletNode = state.flowNodes.get(outletNodeId);
      if (!outletNode) continue;

      // Skip if inlet is liquid
      if (turbineNode.fluid.phase === 'liquid') continue;

      const P_in = turbineNode.fluid.pressure;
      const P_out = outletNode.fluid.pressure;

      if (P_in <= P_out) continue;

      // Compute inlet enthalpy
      const u_in = turbineNode.fluid.internalEnergy / turbineNode.fluid.mass;
      const v_in = turbineNode.volume / turbineNode.fluid.mass;
      const h_in = u_in + P_in * v_in;

      // Find all extraction nodes belonging to this turbine
      const extractionNodes: Array<{
        nodeId: string;
        node: typeof turbineNode;
        pressure: number;
        extractionFlow: number;
      }> = [];

      for (const [nodeId, node] of state.flowNodes) {
        if (node.parentTurbineId === turbineNodeId && node.extractionPressure) {
          // Find extraction flow (flow leaving this extraction node)
          let extractionFlow = 0;
          for (const conn of state.flowConnections) {
            if (conn.fromNodeId === nodeId && conn.massFlowRate > 0) {
              extractionFlow += conn.massFlowRate;
            }
          }
          // Check valve behavior: extraction flow cannot be negative
          extractionFlow = Math.max(0, extractionFlow);

          extractionNodes.push({
            nodeId,
            node,
            pressure: node.extractionPressure,
            extractionFlow,
          });
        }
      }

      // Sort extraction nodes by pressure (high to low) - expansion order
      extractionNodes.sort((a, b) => b.pressure - a.pressure);

      // Calculate staged expansion with extraction
      let remainingFlow = inletMassFlow;
      let h_current = h_in;
      let P_current = P_in;
      let turbinePower = 0;

      // Process each extraction stage
      for (const extraction of extractionNodes) {
        const P_ext = extraction.pressure;

        // Skip if extraction pressure is higher than current pressure
        if (P_ext >= P_current) continue;

        // Isentropic expansion to extraction pressure
        const pressureRatio = P_ext / P_current;
        const h_ext_ideal = h_current * Math.pow(pressureRatio, 0.3);
        const h_ext = h_current - this.turbineEfficiency * (h_current - h_ext_ideal);

        // Power from this expansion segment (all flow expands through this stage)
        const segmentPower = remainingFlow * (h_current - h_ext);
        turbinePower += segmentPower;

        // Update extraction node energy rate
        // The extraction flow exits at h_ext enthalpy
        // We need to ensure the extraction node has the right energy content
        const extRates = rates.flowNodes.get(extraction.nodeId);
        if (extRates && extraction.extractionFlow > 0) {
          // Energy carried by extraction flow
          // This is handled by flow advection, but we need to ensure
          // the extraction node reflects the correct enthalpy
          // The extraction node's fluid state should equilibrate to h_ext
        }

        // Reduce remaining flow by extraction amount
        remainingFlow -= extraction.extractionFlow;
        remainingFlow = Math.max(0, remainingFlow);

        // Update state for next stage
        h_current = h_ext;
        P_current = P_ext;
      }

      // Final expansion to exhaust pressure
      if (remainingFlow > 0 && P_out < P_current) {
        const pressureRatio = P_out / P_current;
        const h_out_ideal = h_current * Math.pow(pressureRatio, 0.3);
        const h_out = h_current - this.turbineEfficiency * (h_current - h_out_ideal);
        const exhaustPower = remainingFlow * (h_current - h_out);
        turbinePower += exhaustPower;
      }

      totalTurbinePower += turbinePower;

      // Remove energy from the TURBINE node (where work is extracted)
      // The flow operator will then advect the reduced-enthalpy steam downstream
      const turbineRates = rates.flowNodes.get(turbineNodeId);
      if (turbineRates) {
        turbineRates.dEnergy -= turbinePower;
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

      // Calculate steam energy by subtracting NCG energy
      // NCG energy = n * Cv * T - but we need to iterate to find T
      // because T depends on steam energy which depends on NCG energy which depends on T
      let steamEnergy = flowNode.fluid.internalEnergy;
      const ncgMoles = flowNode.fluid.ncg ? totalMoles(flowNode.fluid.ncg) : 0;
      const steamMass = flowNode.fluid.mass;

      // Handle pure NCG case (no water at all)
      if (steamMass === 0 && ncgMoles > 0) {
        const Cv_ncg = mixtureCv(flowNode.fluid.ncg!);
        const totalU = flowNode.fluid.internalEnergy;
        const T_estimate = Math.max(273, Math.min(4000, totalU / (ncgMoles * Cv_ncg)));

        flowNode.fluid.temperature = T_estimate;
        flowNode.fluid.phase = 'vapor';
        flowNode.fluid.quality = 1.0;

        // Pressure from ideal gas law for NCG only
        const R_GAS = 8.314; // J/(mol·K)
        flowNode.fluid.pressure = ncgMoles * R_GAS * T_estimate / flowNode.volume;
        continue;
      }

      // When NCG is present, we need to find the equilibrium state where:
      // 1. NCG and steam are at the same temperature (thermal equilibrium)
      // 2. Total energy = NCG energy + water energy
      // 3. For two-phase water: steam partial pressure = P_sat(T)
      // 4. Total pressure = P_steam + P_ncg (Dalton's law)
      //
      // The vapor space contains NCG + steam, while liquid pools at the bottom.
      // Volume partition:
      //   V_total = V_liquid + V_vapor_space
      //   V_vapor_space contains both steam (at P_sat) and NCG (at P_ncg)
      //   Both gases occupy the full V_vapor_space at their partial pressures
      let effectiveWaterVolume = flowNode.volume;

      if (ncgMoles > 0) {
        const Cv_ncg = mixtureCv(flowNode.fluid.ncg!);
        const totalU = flowNode.fluid.internalEnergy;
        const R_WATER = 461.5;  // J/(kg·K) for water vapor

        // Iterate to find equilibrium temperature
        // At each T, we compute:
        // - P_sat(T) = steam partial pressure
        // - Vapor space volume (assuming liquid takes minimal space)
        // - Steam mass in vapor = P_sat * V_vapor / (R_water * T)
        // - Liquid mass = total mass - vapor mass
        // - Energy of each phase

        // Start from NCG temperature estimate when water mass is small
        // This provides a better initial guess and faster convergence
        const ncgThermalMass = ncgMoles * Cv_ncg;  // J/K
        const waterThermalMass = steamMass * 4186;  // Approximate using liquid Cp
        let T_estimate: number;
        if (ncgThermalMass > waterThermalMass * 10) {
          // NCG dominates - use NCG temperature as starting point
          // T_ncg ≈ U_ncg / (n * Cv) but we don't know U_ncg yet
          // Approximate: assume most energy is in NCG
          T_estimate = Math.max(273, Math.min(3000, totalU / ncgThermalMass));
        } else {
          T_estimate = flowNode.fluid.temperature;
        }

        // Iterate to find consistent T. The water inventory can be fully
        // evaporated (gas-dominated node above the dew point, e.g. a helium
        // loop with trace steam): m_vapor saturates at the total water mass
        // and T is then free to rise well past the water critical point -
        // the old 647 K clamp silently pinned hot gas loops to T_crit.
        let finalEnergyError = 0;
        let iterCount = 0;
        const T_initial = T_estimate;
        const T_MAX = 4000; // generous; solver sanity throws at 5000 K

        for (let iter = 0; iter < 20; iter++) {
          iterCount = iter + 1;

          // Saturation pressure caps at the critical point: above T_crit all
          // water is gas and the saturation concept no longer binds anything
          const T_sat_eval = Math.min(T_estimate, 646.5);
          const P_sat = Water.saturationPressure(T_sat_eval);

          // For two-phase equilibrium with NCG:
          // The vapor space contains steam at P_sat and NCG at P_ncg
          // Total pressure = P_sat + P_ncg
          //
          // Liquid volume is small compared to vapor space for low-pressure systems
          // Approximate: vapor space ≈ total volume
          const V_vapor = flowNode.volume;  // Approximation: liquid volume << total

          // Steam mass in vapor phase, capped at the water actually present:
          // when saturation would hold more steam than exists, the node is
          // superheated - all water is vapor and none is left to evaporate
          const m_vapor_sat = P_sat * V_vapor / (R_WATER * T_estimate);
          const allVapor = m_vapor_sat >= steamMass;
          const m_vapor = allVapor ? steamMass : m_vapor_sat;

          // Liquid mass (rest of the water)
          const m_liquid = Math.max(0, steamMass - m_vapor);

          // Energy calculation:
          // Liquid: u_f ≈ 4186 * (T - 273.15) J/kg
          // Vapor:  u_g ≈ 2.375e6 + 1900*(T - 273) J/kg (better fit for low T)
          // NCG:    u = Cv * T
          const u_f = 4186 * Math.max(0, T_estimate - 273.15);
          const u_g = 2375000 + 1900 * (T_estimate - 273);

          const waterEnergy = m_liquid * u_f + m_vapor * u_g;
          const ncgEnergy = ncgMoles * Cv_ncg * T_estimate;
          const totalEnergyAtT = waterEnergy + ncgEnergy;

          // Energy error
          const energyError = totalU - totalEnergyAtT;
          finalEnergyError = energyError;

          // Derivative of total energy with respect to T
          // d(waterEnergy)/dT ≈ m_liquid * 4186 + m_vapor * 1900
          //                   + (dm_vapor/dT) * (u_g - u_f)
          // dm_vapor/dT = (dP_sat/dT) * V / (R_water * T) - m_vapor / T
          //             ≈ m_vapor * (dP_sat/dT) / P_sat - m_vapor / T
          // Using Clausius-Clapeyron: dP_sat/dT ≈ P_sat * L / (R * T^2)
          // where L ≈ 2.4e6 J/kg latent heat
          // In the all-vapor regime m_vapor is pinned at steamMass: no
          // evaporation term, only sensible heating.
          const L_vap = 2.4e6;
          const dPsat_dT = P_sat * L_vap / (R_WATER * T_sat_eval * T_sat_eval);
          const dm_vapor_dT = allVapor
            ? 0
            : (dPsat_dT * V_vapor / (R_WATER * T_estimate)) - m_vapor / T_estimate;

          const dWaterEnergy_dT = m_liquid * 4186 + m_vapor * 1900 + dm_vapor_dT * (u_g - u_f);
          const dNcgEnergy_dT = ncgThermalMass;
          const dTotalEnergy_dT = dWaterEnergy_dT + dNcgEnergy_dT;

          // Newton step with damping
          const dT = energyError / Math.max(dTotalEnergy_dT, 1000);
          const T_new = T_estimate + 0.5 * dT;

          // Check if we're hitting the bounds
          if (T_new < 273.16 || T_new > T_MAX) {
            console.error(`[NCG+Water T iteration] ${nodeId}: T would go to ${T_new.toFixed(1)}K (out of bounds)`);
            console.error(`  iter=${iter}, T=${T_estimate.toFixed(1)}K, dT=${dT.toFixed(1)}K`);
            console.error(`  totalU=${(totalU/1e6).toFixed(4)}MJ, waterEnergy=${(waterEnergy/1e6).toFixed(4)}MJ, ncgEnergy=${(ncgEnergy/1e6).toFixed(4)}MJ`);
            console.error(`  energyError=${(energyError/1e6).toFixed(4)}MJ, dE/dT=${dTotalEnergy_dT.toFixed(0)}J/K`);
            console.error(`  m_vapor=${m_vapor.toFixed(3)}kg, m_liquid=${m_liquid.toFixed(3)}kg, steamMass=${steamMass.toFixed(3)}kg`);
            console.error(`  ncgMoles=${ncgMoles.toFixed(1)}, P_sat=${(P_sat/1e5).toFixed(4)}bar`);
          }

          T_estimate = Math.max(273.16, Math.min(T_MAX, T_new));

          if (Math.abs(dT) < 0.05) break;
        }

        // Compute steam energy from ACTUAL energy balance, not from T
        // steamEnergy = totalU - ncgEnergy
        const ncgEnergyFinal = ncgMoles * Cv_ncg * T_estimate;
        steamEnergy = totalU - ncgEnergyFinal;

        // Sanity check: did we converge? Is steam energy physically reasonable?
        const u_steam_specific = steamEnergy / steamMass;
        const u_g_at_T = 2375000 + 1900 * (T_estimate - 273);

        // Check for convergence issues
        if (Math.abs(finalEnergyError) > totalU * 0.01) {
          console.error(`[NCG+Water T iteration] ${nodeId}: Failed to converge after ${iterCount} iterations`);
          console.error(`  T_initial=${T_initial.toFixed(1)}K -> T_final=${T_estimate.toFixed(1)}K`);
          console.error(`  totalU=${(totalU/1e6).toFixed(4)}MJ, ncgEnergy=${(ncgEnergyFinal/1e6).toFixed(4)}MJ, steamEnergy=${(steamEnergy/1e6).toFixed(4)}MJ`);
          console.error(`  energyError=${(finalEnergyError/1e6).toFixed(4)}MJ (${(100*finalEnergyError/totalU).toFixed(1)}%)`);
          console.error(`  u_steam=${(u_steam_specific/1e3).toFixed(2)}kJ/kg, expected u_g=${(u_g_at_T/1e3).toFixed(2)}kJ/kg at T=${T_estimate.toFixed(1)}K`);
          console.error(`  steamMass=${steamMass.toFixed(3)}kg, ncgMoles=${ncgMoles.toFixed(1)}, V=${flowNode.volume.toFixed(2)}m³`);
        }

        // Check if steam energy is physically impossible (negative or way too low for vapor)
        if (steamEnergy < 0) {
          console.error(`[NCG+Water] ${nodeId}: NEGATIVE steam energy! steamEnergy=${(steamEnergy/1e6).toFixed(4)}MJ`);
          console.error(`  totalU=${(totalU/1e6).toFixed(4)}MJ, ncgEnergy=${(ncgEnergyFinal/1e6).toFixed(4)}MJ`);
          console.error(`  This means NCG energy > total energy - energy accounting is broken!`);
          console.error(`  ncgMoles=${ncgMoles.toFixed(1)}, T=${T_estimate.toFixed(1)}K, Cv_ncg=${Cv_ncg.toFixed(1)}J/mol-K`);
          steamEnergy = 0; // Can't be negative, but this is a band-aid
        }

        // For the water properties calculation, we need to pass the state correctly
        // The water "sees" the full volume (vapor shares with NCG, liquid pools below)
        // But we pass steam-only energy, not total energy
        effectiveWaterVolume = flowNode.volume;

        // Also update the node's fluid temperature to the equilibrium value
        // This ensures consistency for next timestep
        flowNode.fluid.temperature = T_estimate;
      }

      // Skip water property lookup only if there's truly zero water mass
      if (steamMass === 0) {
        continue;
      }

      // Check for very low density steam (ideal gas regime)
      // The steam tables don't cover v > ~100 m³/kg reliably
      // For such low densities, steam behaves as ideal gas
      // IMPORTANT: Use effective water volume when NCG is present
      const v_specific_m3_kg = effectiveWaterVolume / steamMass;
      const u_specific_steam = steamEnergy / steamMass;

      // IMPORTANT: Only use ideal gas approximation if BOTH conditions are met:
      // 1. Very low density (v > 10 m³/kg)
      // 2. Energy is vapor-like (u > 2.3 MJ/kg, roughly saturated vapor at low pressure)
      //    OR NCG dominates (steamEnergy is small because most energy is in NCG)
      // Two-phase water can also have low density if partial pressure is low,
      // but its energy will be much lower (mixture of liquid and vapor).
      const U_VAPOR_THRESHOLD = 2.3e6; // J/kg - approximate saturated vapor energy at low pressure

      // For NCG-dominated nodes, the steam is in thermal equilibrium with NCG at ~vapor conditions
      // Even if u_specific_steam is low (because steamEnergy came from subtracting large NCG energy),
      // the steam is actually superheated vapor at the NCG temperature
      //
      // IMPORTANT: When NCG is present, we MUST use ideal gas for high-v conditions.
      // The steam tables can't handle the apparent v that results from NCG+steam
      // sharing a volume. The steam partial pressure is much lower than what
      // the tables would compute from (mass, energy, total_volume).
      const ncgDominates = ncgMoles > 0 && steamEnergy < steamMass * U_VAPOR_THRESHOLD * 0.1;

      // Use ideal gas if: (1) v > 10 m³/kg AND (2) energy is vapor-like OR NCG dominates OR NCG is present
      // The third condition ensures we don't try to use steam tables when NCG+steam share a volume
      if (v_specific_m3_kg > 10 && (u_specific_steam > U_VAPOR_THRESHOLD || ncgDominates || ncgMoles > 0)) {
        // Very low density steam - use ideal gas approximation
        // T from energy: u = u_ref + Cv*(T - T_ref)
        // Using u_ref = 2.375e6 J/kg at T_ref = 273K, Cv ≈ 1400 J/kg-K for steam
        const Cv_steam = 1400; // J/kg-K
        const u_ref = 2.375e6; // J/kg at 273K
        const T_ref = 273; // K

        let T_steam = T_ref + (u_specific_steam - u_ref) / Cv_steam;
        T_steam = Math.max(273, Math.min(4000, T_steam));

        // For mixed NCG+steam, use the iterated temperature if we have NCG
        if (ncgMoles > 0) {
          // The NCG iteration already found a consistent temperature
          // Use that for pressure calculation
          const Cv_ncg = mixtureCv(flowNode.fluid.ncg!);
          const totalU = flowNode.fluid.internalEnergy;
          const ncgEnergy = totalU - steamEnergy;
          const T_from_ncg = ncgEnergy / (ncgMoles * Cv_ncg);
          T_steam = Math.max(273, Math.min(4000, T_from_ncg));
        }

        flowNode.fluid.temperature = T_steam;
        flowNode.fluid.phase = 'vapor';
        flowNode.fluid.quality = 1.0;

        // Pressure from ideal gas: P = (m/M) * R * T / V
        const R_GAS = 8.314; // J/(mol·K)
        const M_water = 0.018; // kg/mol
        const steamMoles = steamMass / M_water;
        const P_steam = steamMoles * R_GAS * T_steam / flowNode.volume;

        if (ncgMoles > 0) {
          const P_ncg = ncgMoles * R_GAS * T_steam / flowNode.volume;
          flowNode.fluid.pressure = P_ncg + P_steam;
        } else {
          flowNode.fluid.pressure = P_steam;
        }
        continue;
      }

      let waterState: Water.WaterState;
      try {
        // Use effective water volume (full volume minus NCG volume)
        // This is crucial for correct phase detection when NCG is present
        waterState = Water.calculateState(
          flowNode.fluid.mass,
          steamEnergy,
          effectiveWaterVolume
        );
      } catch (e) {
        // Add extra context to the error for debugging
        const mass = flowNode.fluid.mass;
        const U = flowNode.fluid.internalEnergy;
        const vol = flowNode.volume;
        const v_water = effectiveWaterVolume / mass;
        const storedT = flowNode.fluid.temperature;
        const storedP = flowNode.fluid.pressure;
        const storedPhase = flowNode.fluid.phase;
        const storedQuality = flowNode.fluid.quality;
        console.error(`[FluidState] Error in ${nodeId}:`);
        console.error(`  STORED STATE: T=${(storedT - 273.15).toFixed(1)}C, P=${(storedP/1e5).toFixed(2)}bar, phase=${storedPhase}, quality=${(storedQuality ?? 0).toFixed(3)}`);
        console.error(`  mass=${mass.toFixed(1)}kg, U=${(U/1e6).toFixed(3)}MJ, V_total=${(vol*1e3).toFixed(1)}L, V_water=${(effectiveWaterVolume*1e3).toFixed(1)}L`);
        console.error(`  u_total=${(U/mass/1e3).toFixed(2)}kJ/kg, u_steam=${(steamEnergy/mass/1e3).toFixed(2)}kJ/kg`);
        console.error(`  v_total=${(vol/mass*1e6).toFixed(2)}mL/kg, v_water=${(v_water*1e6).toFixed(2)}mL/kg`);
        console.error(`  ncgMoles=${ncgMoles.toFixed(1)}, steamEnergy=${(steamEnergy/1e6).toFixed(3)}MJ`);
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

      // Add NCG partial pressure using Dalton's law: P_total = P_steam + P_ncg
      // NCGs occupy the vapor space, so we use the full node volume for the calculation.
      // For two-phase or vapor nodes, NCGs mix with steam; for liquid-filled nodes,
      // any NCG present would form a bubble at the top (simplified: still add to pressure).
      if (flowNode.fluid.ncg && totalMoles(flowNode.fluid.ncg) > 0) {
        const P_ncg = ncgPartialPressure(
          flowNode.fluid.ncg,
          flowNode.fluid.temperature,
          flowNode.volume
        );
        flowNode.fluid.pressure += P_ncg;
      }

      // Sanity checks - log warnings but do NOT clamp values
      // Clamping hides problems; we need to see what's causing invalid states
      if (!isFinite(flowNode.fluid.temperature) || flowNode.fluid.temperature < 200 || flowNode.fluid.temperature > 4500) {
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

      // Determine flow phase for display
      const upstreamNode = conn.massFlowRate >= 0 ? fromNode : toNode;
      conn.currentFlowPhase = this.getFlowPhase(upstreamNode, conn.massFlowRate >= 0 ? conn.fromElevation : conn.toElevation);

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

  /**
   * Determine what phase of fluid is flowing based on connection elevation
   * relative to liquid level in a two-phase node.
   */
  private getFlowPhase(node: FlowNode, connectionElevation?: number): 'liquid' | 'vapor' | 'mixture' {
    // Single-phase nodes flow their phase
    if (node.fluid.phase === 'liquid') return 'liquid';
    if (node.fluid.phase === 'vapor') return 'vapor';

    // Two-phase: determine based on connection elevation vs liquid level
    const quality = node.fluid.quality ?? 0;
    const T_C = node.fluid.temperature - 273.15;

    // Approximate densities
    const rho_liquid = T_C < 100 ? 1000 - 0.08 * T_C :
                       T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                       700 - 2.5 * (T_C - 300);
    const rho_vapor = node.fluid.pressure * 0.018 / (8.314 * node.fluid.temperature);

    // Void fraction (vapor volume / total volume)
    const voidFraction = quality > 0 && rho_vapor > 0
      ? (quality * rho_liquid) / (quality * rho_liquid + (1 - quality) * rho_vapor)
      : 0;

    // Estimate node height from volume (assume cylindrical)
    const nodeHeight = Math.sqrt(node.volume / (Math.PI * 0.25));
    const liquidLevel = nodeHeight * (1 - voidFraction);

    // Default to mid-height if not specified
    const connElevation = connectionElevation ?? nodeHeight / 2;

    // Tolerance zone around interface
    const tolerance = nodeHeight * 0.1;

    if (connElevation < liquidLevel - tolerance) {
      return 'liquid';
    } else if (connElevation > liquidLevel + tolerance) {
      return 'vapor';
    } else {
      return 'mixture';
    }
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

      const choke = computeChokeLimit(conn, h.upstreamNode, h.downstreamNode, h.flowPhase, h.rho_flow);
      if (choke) {
        const m_dot_choked = choke.m_dot_choked;

        if (choke.chokedByRatio) {
          isChoked = true;
          machNumber = 1.0;

          // Limit current flow to choked value
          const currentFlowSign = currentFlow >= 0 ? 1 : -1;
          const targetFlow = currentFlowSign * m_dot_choked;

          if (Math.abs(currentFlow) >= m_dot_choked) {
            // At or above choked - bring flow back to choked value
            const tau = 0.05; // Fast response (50ms)
            dMassFlowRate = (targetFlow - currentFlow) / tau;
          } else if (dMassFlowRate * currentFlowSign > 0) {
            // Accelerating toward choked - limit acceleration to not exceed choked
            const dt_estimate = 0.01; // 10ms estimate
            const futureFlow = currentFlow + dMassFlowRate * dt_estimate;
            if (Math.abs(futureFlow) > m_dot_choked) {
              // Would exceed choked - limit to reach choked exactly
              dMassFlowRate = (targetFlow - currentFlow) / dt_estimate;
            }
          }
        } else {
          // Not choked by pressure ratio - calculate Mach number
          machNumber = Math.abs(h.v) / choke.soundSpeed;

          // Even if not choked by pressure ratio, don't let flow exceed sonic
          if (Math.abs(currentFlow) > m_dot_choked * 0.95) {
            // Approaching sonic - apply soft limiting
            const currentFlowSign = currentFlow >= 0 ? 1 : -1;
            const targetFlow = currentFlowSign * m_dot_choked * 0.95;
            const tau = 0.1;
            const limitingRate = (targetFlow - currentFlow) / tau;

            // Only apply if it would reduce magnitude of acceleration
            if (dMassFlowRate * currentFlowSign > limitingRate * currentFlowSign) {
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

      // Determine upstream node based on current flow direction
      const currentFlow = conn.massFlowRate;
      const upstreamNode = currentFlow >= 0 ? fromNode : toNode;
      const downstreamNode = currentFlow >= 0 ? toNode : fromNode;

      // Determine flow phase
      const flowPhase = this.getFlowPhase(upstreamNode, conn, currentFlow >= 0);

      // Skip liquid - doesn't choke
      if (flowPhase === 'liquid') {
        conn.isChoked = false;
        conn.machNumber = 0;
        continue;
      }

      // Get flow properties
      const rho_flow = flowPhase === 'vapor'
        ? this.getVaporDensity(upstreamNode)
        : upstreamNode.fluid.mass / upstreamNode.volume;
      const A = conn.flowArea || 0.1;
      const v = Math.abs(currentFlow) / (rho_flow * A);

      // Calculate sound speed
      const c = this.getSoundSpeed(upstreamNode, flowPhase);

      // Calculate Mach number
      conn.machNumber = v / c;

      // Check pressure ratio for choked flow
      const critRatio = this.getCriticalPressureRatio(upstreamNode, flowPhase);
      const P_up = upstreamNode.fluid.pressure;
      const P_down = downstreamNode.fluid.pressure;
      const actualRatio = P_down / P_up;

      conn.isChoked = critRatio > 0 && actualRatio < critRatio;
    }

    return state;
  }

  private getFlowPhase(node: FlowNode, conn: FlowConnection, isFromNode: boolean): 'liquid' | 'vapor' | 'mixture' {
    if (node.fluid.phase !== 'two-phase') {
      return node.fluid.phase === 'vapor' ? 'vapor' : 'liquid';
    }

    // For two-phase, check connection elevation
    const connElev = isFromNode ? conn.fromElevation : conn.toElevation;
    const nodeHeight = node.height ?? Math.sqrt(node.volume / (Math.PI * 0.25));

    if (connElev === undefined) {
      return 'mixture';
    }

    // Calculate liquid level
    const quality = node.fluid.quality ?? 0;
    const rho_liquid = this.getLiquidDensity(node);
    const liquidMass = node.fluid.mass * (1 - quality);
    const liquidVolume = liquidMass / rho_liquid;
    const liquidLevel = liquidVolume / (node.volume / nodeHeight);

    if (connElev < liquidLevel - 0.1) return 'liquid';
    if (connElev > liquidLevel + 0.1) return 'vapor';
    return 'mixture';
  }

  private getLiquidDensity(node: FlowNode): number {
    const T_C = node.fluid.temperature - 273.15;
    if (T_C < 100) return 1000 - 0.08 * T_C;
    if (T_C < 300) return 958 - 1.3 * (T_C - 100);
    return Math.max(400, 700 - 2.5 * (T_C - 300));
  }

  private getVaporDensity(node: FlowNode): number {
    const P = node.fluid.pressure;
    const T = node.fluid.temperature;
    return Math.max(0.1, P * 0.018 / (8.314 * T));
  }

  private getSoundSpeed(node: FlowNode, flowPhase: 'liquid' | 'vapor' | 'mixture'): number {
    if (flowPhase === 'liquid') return 1500;

    const fluid = node.fluid;
    const T = fluid.temperature;
    const ncgMoles = fluid.ncg ? totalMoles(fluid.ncg) : 0;

    if (ncgMoles > 0 && node.volume > 0) {
      const P_ncg = ncgMoles * R_GAS * T / node.volume;
      const P_steam = Math.max(0, fluid.pressure - P_ncg);
      const steamMoles = P_steam * node.volume / (R_GAS * T);

      if (steamMoles < ncgMoles * 0.02) {
        return ncgSoundSpeed(fluid.ncg!, T);
      }
      return steamNcgSoundSpeed(fluid.ncg!, steamMoles, T);
    }

    // Pure steam
    const quality = fluid.phase === 'two-phase' ? (fluid.quality ?? 0.5) : (flowPhase === 'vapor' ? 1 : 0);
    const rho = flowPhase === 'vapor'
      ? this.getVaporDensity(node)
      : fluid.mass / node.volume;

    const waterState: WaterState = {
      temperature: T,
      pressure: fluid.pressure,
      density: rho,
      phase: flowPhase === 'mixture' ? 'two-phase' : flowPhase,
      quality,
      specificEnergy: fluid.internalEnergy / fluid.mass,
    };

    return soundSpeed(waterState);
  }

  private getCriticalPressureRatio(node: FlowNode, flowPhase: 'liquid' | 'vapor' | 'mixture'): number {
    if (flowPhase === 'liquid') return 0;

    const ncgMoles = node.fluid.ncg ? totalMoles(node.fluid.ncg) : 0;
    if (ncgMoles > 0) return 0.53;

    const quality = node.fluid.phase === 'two-phase' ? (node.fluid.quality ?? 0.5) : (flowPhase === 'vapor' ? 1 : 0);
    const rho = flowPhase === 'vapor'
      ? this.getVaporDensity(node)
      : node.fluid.mass / node.volume;

    const waterState: WaterState = {
      temperature: node.fluid.temperature,
      pressure: node.fluid.pressure,
      density: rho,
      phase: flowPhase === 'mixture' ? 'two-phase' : flowPhase,
      quality,
      specificEnergy: node.fluid.internalEnergy / node.fluid.mass,
    };

    return criticalPressureRatio(waterState);
  }

  reset(): void {}
}

// ============================================================================
// Cladding Oxidation Rate Operator
// ============================================================================

/**
 * Cladding Oxidation Rate Operator
 *
 * Models high-temperature zirconium oxidation by steam:
 *   Zr + 2H₂O → ZrO₂ + 2H₂ + heat (586 kJ/mol Zr)
 *
 * This reaction becomes significant above ~1200K and accelerates dramatically
 * at higher temperatures (runaway oxidation above ~1500K).
 *
 * The Baker-Just correlation is used for oxidation rate:
 *   dW²/dt = A × exp(-Q/RT)
 * where W is oxide thickness, A = 33.3 cm²/s, Q = 45,500 cal/mol
 *
 * Physics included:
 * 1. Temperature-dependent Arrhenius kinetics
 * 2. Steam availability (oxidation limited by steam partial pressure)
 * 3. Exothermic heat addition to cladding
 * 4. H₂ generation added to coolant NCG inventory
 * 5. Oxidation progress tracking (0-100% of cladding consumed)
 *
 * References:
 * - Baker, L., Just, L.C. (1962) - Baker-Just correlation
 * - Cathcart-Pawel correlation (alternative, similar results)
 */
export class CladdingOxidationRateOperator implements RateOperator {
  name = 'CladdingOxidation';

  // Physical constants
  private static readonly ZR_MOLAR_MASS = 0.09122; // kg/mol (91.22 g/mol)
  private static readonly H2O_MOLAR_MASS = 0.01802; // kg/mol

  // Baker-Just correlation constants (parabolic rate law)
  // dW²/dt = A × exp(-Q/RT) where W is oxide thickness
  // A = 33.3 cm²/s = 3.33e-3 m²/s
  // Q = 45500 cal/mol = 190370 J/mol
  private static readonly A_BAKER_JUST = 3.33e-3; // m²/s
  private static readonly Q_ACTIVATION = 190370;  // J/mol
  private static readonly R_GAS = 8.314;          // J/mol-K

  // Reaction enthalpy: Zr + 2H₂O → ZrO₂ + 2H₂ releases 586 kJ/mol Zr
  private static readonly OXIDATION_ENTHALPY = 586000; // J/mol Zr

  // Temperature threshold below which oxidation is negligible
  private static readonly T_THRESHOLD = 1100; // K (~827°C)

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    // Find all cladding nodes with oxidation tracking
    for (const [id, node] of state.thermalNodes) {
      if (!node.oxidation) continue;

      const ox = node.oxidation;

      // Skip if already fully oxidized
      if (ox.oxidizedFraction >= 0.9999) continue;

      // Get cladding temperature
      const T = node.temperature;

      // Skip if below threshold temperature
      if (T < CladdingOxidationRateOperator.T_THRESHOLD) continue;

      // Get associated coolant node for steam availability and H₂ release
      const coolantNode = state.flowNodes.get(ox.associatedCoolantNode);
      if (!coolantNode) continue;

      // Check steam availability
      // For two-phase or vapor, steam is available
      // For liquid, very little steam (use saturation pressure at surface, but much reduced)
      let P_steam: number;
      let steamFactor: number;
      if (coolantNode.fluid.phase === 'liquid') {
        // Limited steam from liquid surface evaporation
        // Use saturation pressure at coolant temperature, but reduce significantly
        // because steam must diffuse from liquid surface to hot cladding
        const P_sat = Water.saturationPressure(coolantNode.fluid.temperature);
        // Effective steam pressure is much lower than saturation due to diffusion limits
        // Use a factor of 0.01 to represent this mass transfer limitation
        P_steam = P_sat * 0.01;
        // Steam factor based on 1 bar reference for full reaction rate
        steamFactor = Math.min(1, P_steam / 1e5);
      } else {
        // Vapor or two-phase: steam pressure is total - NCG
        const P_ncg = coolantNode.fluid.ncg && coolantNode.volume > 0
          ? ncgPartialPressure(coolantNode.fluid.ncg, coolantNode.fluid.temperature, coolantNode.volume)
          : 0;
        P_steam = Math.max(0, coolantNode.fluid.pressure - P_ncg);
        // Steam factor: full rate at 1 bar, reduced below
        steamFactor = Math.min(1, P_steam / 1e5);
      }

      if (steamFactor < 0.01) continue; // No steam, no reaction

      // Baker-Just parabolic rate law: dW²/dt = A × exp(-Q/RT)
      // where W is oxide layer thickness
      // For mass-based calculation: dm_oxide/dt ~ (surface area) × rate
      const A = CladdingOxidationRateOperator.A_BAKER_JUST;
      const Q = CladdingOxidationRateOperator.Q_ACTIVATION;
      const R = CladdingOxidationRateOperator.R_GAS;

      // Arrhenius rate constant (m²/s)
      const k_rate = A * Math.exp(-Q / (R * T));

      // Current oxide thickness fraction determines remaining Zr surface
      // As oxidation progresses, rate slows due to diffusion through oxide layer
      // Parabolic law already accounts for this: rate ∝ 1/W
      const W_fraction = ox.oxidizedFraction;
      const remaining_factor = Math.sqrt(1 - W_fraction);

      // Mass oxidation rate (kg Zr/s)
      // Surface area is proportional to node.surfaceArea
      // Convert from parabolic thickness rate to mass rate:
      // dm/dt = ρ_Zr × surfaceArea × dW/dt
      // where dW/dt = k_rate / (2W) for parabolic law
      // For simplicity, use empirical rate scaled by surface area
      const ZR_DENSITY = 6500; // kg/m³
      const characteristic_thickness = node.characteristicLength; // clad thickness ~0.6mm

      // Rate of oxide thickness growth (m/s)
      // From parabolic law: W × dW/dt = k_rate/2, so dW/dt = k_rate/(2W)
      // At W→0, we cap the rate to avoid singularity
      const W_current = Math.max(characteristic_thickness * W_fraction, 1e-6);
      const dW_dt = k_rate / (2 * W_current);

      // Cap the rate to prevent numerical issues (max ~1 mm/s at extreme T)
      const dW_dt_capped = Math.min(dW_dt, 1e-3);

      // Mass of Zr oxidized per second (kg/s)
      // dm_Zr/dt = ρ_Zr × surfaceArea × dW/dt × steam_availability
      const dm_Zr_dt = ZR_DENSITY * node.surfaceArea * dW_dt_capped * steamFactor * remaining_factor;

      // Convert to oxidation fraction rate
      // dFraction/dt = dm_Zr_dt / total_Zr_mass
      const dOxidizedFraction_dt = dm_Zr_dt / ox.totalZrMass;

      // Store oxidation rate for this thermal node
      const existingRates = rates.thermalNodes.get(id) || { dTemperature: 0 };
      existingRates.dOxidizedFraction = dOxidizedFraction_dt;

      // Calculate heat release (exothermic reaction)
      // Moles of Zr oxidized per second
      const mol_Zr_dt = dm_Zr_dt / CladdingOxidationRateOperator.ZR_MOLAR_MASS;
      const Q_release = mol_Zr_dt * CladdingOxidationRateOperator.OXIDATION_ENTHALPY; // W

      // Add heat to cladding (increases temperature; latent plateau applies)
      existingRates.dTemperature += Q_release / nodeHeatCapacity(node);
      rates.thermalNodes.set(id, existingRates);

      // Calculate H₂ production rate
      // Stoichiometry: 1 mol Zr → 2 mol H₂
      const mol_H2_dt = 2 * mol_Zr_dt;

      // Add H₂ to coolant NCG inventory
      const coolantRates = rates.flowNodes.get(ox.associatedCoolantNode) || { dMass: 0, dEnergy: 0 };
      if (!coolantRates.dNcg) {
        coolantRates.dNcg = emptyGasComposition();
      }
      coolantRates.dNcg.H2 += mol_H2_dt;
      rates.flowNodes.set(ox.associatedCoolantNode, coolantRates);

      // Steam consumption: 2 mol H₂O per mol Zr
      // This removes mass and energy from coolant
      const mol_H2O_dt = 2 * mol_Zr_dt;
      const dm_steam = mol_H2O_dt * CladdingOxidationRateOperator.H2O_MOLAR_MASS; // kg/s consumed

      // For now, we don't explicitly track steam mass removal
      // (The steam tables will naturally reduce pressure as mass drops)
      // But we should add this for mass conservation
      coolantRates.dMass -= dm_steam;

      // Energy for steam consumption (latent heat of vaporization ~2.26 MJ/kg at 100°C)
      // At high temperature it's less, but use conservative estimate
      const h_fg = 2.0e6; // J/kg (approximate at high T)
      coolantRates.dEnergy -= dm_steam * h_fg;
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
      const corium = state.thermalNodes.get(id.replace(/-fuel$/, '-corium'));
      if (corium && corium.mass > 2) {
        locations.push({
          T: corium.temperature,
          oxide: fuelOxideMass(corium),
          target: fp.associatedCoolantNode,
        });
      }
      const debris = state.thermalNodes.get(id.replace(/-fuel$/, '-corium-ex'));
      if (debris && debris.mass > 2 && debris.associatedVesselNode) {
        locations.push({
          T: debris.temperature,
          oxide: fuelOxideMass(debris),
          target: debris.associatedVesselNode,
        });
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
