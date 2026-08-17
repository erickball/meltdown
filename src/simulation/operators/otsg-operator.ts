/**
 * Moving-boundary OTSG rate operator.
 *
 * For every flow node carrying `otsg` state, this operator replaces the
 * ordinary bulk-temperature convection path (which the factory suppresses
 * for these nodes) with the sectioned model of docs/otsg-moving-boundary-
 * design.md:
 *
 *   shell gas --[counterflow march, section by section]--> tube metal
 *   tube metal --[transit + standing branches, per section]--> water sections
 *
 * The node's ordinary (mass, energy) totals stay owned by the existing flow
 * machinery - this operator adds ONLY the wall heat, plus the matching energy
 * changes on the shell node and metal. The partition itself is not integrated
 * at all: it is solved from the totals on every evaluation, with the
 * superheat section pinned by its own metal (evaluateOtsgAtP), so no
 * bookkeeping here can disagree with conservation, with the room the tubes
 * actually have, or with the walls doing the heating.
 *
 * External flows and the partition: connection flows are classified by the
 * phase they are actually carrying (currentFlowPhase, set by the momentum
 * solve): liquid inflow is feed into section 1; every other flow - the steam
 * draw, vapor backflow, a mid-bundle mixture leak - moves only the totals,
 * and the solved partition follows. Liquid draws leave section 1 weighted by
 * m1/(m1+1), so an emptying subcooled section never steps its own rate.
 */

import { SimulationState, FlowNode } from '../types';
import { RateOperator, ConstraintOperator, StateRates, createZeroRates } from '../rk45-solver';
import {
  evaluateOtsgAtP,
  transitStandingQ,
  marchCounterflowGas,
  OtsgEval,
  OtsgWallPin,
} from '../otsg';
import { saturatedLiquidEnergy, saturatedLiquidDensity } from '../water-properties';
import { nodeHeatCapacity } from './rate-operators';
import {
  totalMoles,
  mixtureThermalConductivity,
  mixtureViscosity,
  mixtureCp,
  averageMolecularWeight,
} from '../gas-properties';
import { approxVaporDensity } from './connection-hydraulics';
import { solveMixtureState } from '../mixture-properties';

/** Tube-side film coefficients (W/m2-K). The gas shell is the limiting
 *  resistance by an order of magnitude, so correlation-grade constants are
 *  adequate here; each is the standard scale for its regime. */
const H_TUBE_LIQUID = 4000;
const H_TUBE_BOILING = 25000;
const H_TUBE_STEAM = 1200;
/** Natural-convection floor for the standing branch (W/m2-K) - what keeps a
 *  bottled boiler heating. */
const H_TUBE_NATURAL = 250;

/**
 * The WATER's own state inside a tube node: its partial pressure and its
 * share of the node's internal energy.
 *
 * A flow node's `fluid.pressure` is the TOTAL pressure and `internalEnergy`
 * the TOTAL energy - steam plus any non-condensible gas sharing the volume
 * (Dalton, see mixture-properties.ts). Handing those to the sectioned model
 * asks it to place saturation boundaries at a pressure the water is not at
 * and to account for energy the water does not hold: helium leaking into a
 * depressurized bundle would have the model looking for a dome at, say, 60
 * bar around water that is really at 5, and the closure would rightly report
 * that the totals and the pressure disagree about what phase the tube is in.
 *
 * The water sub-problem is exactly the pure-water problem at its own partial
 * pressure - that is the whole point of the Dalton split - so this hands the
 * sections the water's half of it. With no gas present the mixture solve
 * short-circuits to the stored state, so this costs nothing in the ordinary
 * case.
 *
 * The gas is treated as sharing the whole tube volume (mixture-properties'
 * standing simplification), so the section volumes still close over the full
 * tube: the two conventions match.
 */
export function tubeWaterState(node: FlowNode): { pressure: number; energy: number } {
  // An empty node has no state to solve - the closure handles it by having
  // nothing to partition.
  if (!(node.fluid.mass > 0)) {
    return { pressure: node.fluid.pressure, energy: node.fluid.internalEnergy };
  }
  // Solve the state FRESH rather than reading fluid.pressure. That field is
  // written by FluidStateConstraintOperator, which runs on accepted states
  // only, while mass and energy move on every RK stage - so mid-step the
  // stored pressure belongs to totals the node no longer has. The sections
  // are far more sensitive to that than a bulk node is: the closure places
  // saturation boundaries with it, and a pressure 7 bar stale against its own
  // (u,v) puts the state below the saturation TIE LINE, where no partition
  // exists and
  // the closure rightly refuses. That is what a feedwater heater's surge
  // first surfaced.
  const mix = solveMixtureState(
    node.fluid.mass, node.fluid.internalEnergy, node.volume,
    node.fluid.ncg, node.fluid.temperature);
  return { pressure: mix.steamPressure, energy: mix.waterEnergy };
}


/** What the attached connections are doing to a tube node, in the terms the
 *  sectioned model needs. Shared so the ledger check (which runs on ACCEPTED
 *  states) sees exactly what the rate operator saw. */
export interface OtsgFlows {
  WFeed: number;       // kg/s of liquid inflow routed to the subcooled section
  hFeed: number;       // J/kg - its mean enthalpy
  uFeed: number;       // J/kg - the same, as internal energy
  WSteamOut: number;   // kg/s vapor drawn from section 3
  WLiquidOut: number;  // kg/s liquid drawn from section 1
}

export function classifyOtsgFlows(
  state: SimulationState, id: string, node: FlowNode, waterPressure: number,
): OtsgFlows {
  let WFeed = 0, hFeedNum = 0;
  let WSteamOut = 0, WLiquidOut = 0;
  for (const conn of state.flowConnections) {
    const isFrom = conn.fromNodeId === id;
    const isTo = conn.toNodeId === id;
    if (!isFrom && !isTo) continue;
    // Signed flow INTO this node
    const w = isTo ? conn.massFlowRate : -conn.massFlowRate;
    const phase = conn.currentFlowPhase ?? 'liquid';
    if (w > 0) {
      // Vapor inflow (backflow from a steam header) needs no bookkeeping:
      // it lands in the node's totals and the solved partition picks it up as
      // vapor region on the next evaluation.
      if (phase !== 'vapor') {
        // Feed enthalpy from the donor node: subcooled liquid at its
        // temperature (u_f(T) + P v_f(T) - compressibility negligible)
        const donor = state.flowNodes.get(isTo ? conn.fromNodeId : conn.toNodeId);
        const Td = donor?.fluid.temperature ?? 473;
        const hIn = saturatedLiquidEnergy(Td) + waterPressure / saturatedLiquidDensity(Td);
        // Liquid inflow feeds the SUBCOOLED section only to the extent it is
        // actually subcooled: water within ~12 K of saturation flashes into
        // the boiling region essentially on entry, so it routes to section 2
        // (whose mass is derived - no bookkeeping). The 50 kJ/kg ramp is a
        // smoothing width, not a threshold: routing varies continuously with
        // subcooling, and a transiently near-saturated stream (leak backflow,
        // recirculation) can no longer poison the subcooled section's
        // mean-enthalpy closure - which is exactly how this line's absence
        // killed a run.
        const hfNow = saturatedLiquidEnergy(node.fluid.temperature) +
          waterPressure / saturatedLiquidDensity(node.fluid.temperature);
        const wSub = Math.min(1, Math.max(0, (hfNow - hIn) / 50e3));
        WFeed += w * wSub;
        hFeedNum += w * wSub * hIn;
      }
    } else if (w < 0) {
      if (phase === 'vapor') WSteamOut += -w;
      else if (phase === 'liquid') WLiquidOut += -w;
      // mixture draws come from section 2: derived mass, no bookkeeping
    }
  }
  const hFeed = WFeed > 0 ? hFeedNum / WFeed : saturatedLiquidEnergy(473);
  return {
    WFeed, hFeed,
    uFeed: hFeed - waterPressure * 0.0012,   // u = h - Pv, liquid v ~ 1.2 L/kg
    WSteamOut, WLiquidOut,
  };
}


/** cp scale for the wall pin's NTU (J/kg-K). The pin only needs the RATIO
 *  hA/(W cp) to know how closely a transiting stream approaches its wall, so
 *  a correlation-grade constant is the right fidelity - the same role the
 *  duty calculation's cpSteam default plays. */
const CP_STEAM_PIN = 3000;

/** The wall pin for a bundle's superheat section - the one piece of closure
 *  information the totals cannot supply (see evaluateOtsgAtP). Built from the
 *  bundle's own metal and its steam draw. */
export function otsgWallPin(
  state: SimulationState, node: FlowNode, flows: OtsgFlows,
): OtsgWallPin {
  const cfg = node.otsg!;
  const metal3 = state.thermalNodes.get(cfg.metalNodeIds[2]);
  if (!metal3) {
    throw new Error(`[OTSG] node '${node.id}': superheat metal node ` +
      `'${cfg.metalNodeIds[2]}' does not exist.`);
  }
  return {
    TWall3: metal3.temperature,
    hA3Full: H_TUBE_STEAM * cfg.heatArea,
    WCp3: Math.max(0, flows.WSteamOut) * CP_STEAM_PIN,
  };
}

/**
 * The one-stop sectioned evaluation of a bundle: water's own state, flows
 * classified by carried phase, wall pin from its own metal, partition from
 * the totals. EVERY consumer - the rate operator, sensors, checks, probes -
 * goes through here, because a diagnostic that re-derives any of these
 * ingredients differently will quietly disagree with the physics (the
 * section display once read far healthier than the operator by using the
 * feed-energy ceiling instead of the classified feed).
 */
export function evaluateOtsgSections(
  state: SimulationState, id: string, node: FlowNode,
): { ev: OtsgEval; flows: OtsgFlows; water: { pressure: number; energy: number } } {
  const cfg = node.otsg;
  if (!cfg) {
    throw new Error(`[OTSG] node '${id}' has no otsg state - it is not a ` +
      `moving-boundary boiler tube node.`);
  }
  const water = tubeWaterState(node);
  const flows = classifyOtsgFlows(state, id, node, water.pressure);
  const ev = evaluateOtsgAtP(
    node.fluid.mass, water.energy, water.pressure, flows.uFeed,
    { tubeVolume: node.volume, tubeLength: 1, heatArea: cfg.heatArea },
    otsgWallPin(state, node, flows),
  );
  return { ev, flows, water };
}

/**
 * Wall-to-water duty for each section (W into the water), by the parallel
 * transit + standing branches of design doc section 5. Exported so a probe
 * can ask what the operator is actually doing to a bundle without
 * re-deriving it - a re-derivation that drifts is how the section display
 * came to read far healthier than the physics.
 */
export function otsgWaterSideDuties(
  ev: OtsgEval, flows: OtsgFlows, metalTemps: [number, number, number],
): { Q1: number; Q2: number; Q3: number; TFeedIn: number } {
  const cpLiquid = 5000;
  // Section 1: feed stream entering at its own temperature
  const TFeedIn = flows.WFeed > 0 ? tempOfLiquidH(flows.hFeed) : ev.sections[0].T;
  const Q1 = transitStandingQ(
    H_TUBE_LIQUID * ev.sections[0].area,
    H_TUBE_NATURAL * ev.sections[0].area,
    flows.WFeed * cpLiquid,
    TFeedIn, ev.sections[0].T, metalTemps[0],
    // The economizer's wall ramps from the feed temperature to saturation
    // along its length; capping its water at the section-AVERAGE wall is what
    // left the Xe-100 economizer with no length that ends it.
    'ramping',
  );
  // Section 2: boiling at T_sat - huge film coefficient, pure standing form
  const Q2 = (H_TUBE_BOILING * ev.sections[1].area) * (metalTemps[1] - ev.sat.T);
  // Section 3: steam entering at saturation, heated toward its own wall -
  // which the boiling section can no longer clamp.
  const cpSteam = ev.sections[2].mass > 0 && ev.sections[2].T > ev.sat.T + 1
    ? Math.max(2000, (ev.sections[2].hBar - ev.sat.h_g) / (ev.sections[2].T - ev.sat.T))
    : 3000;
  const W23Guess = Math.max(0, flows.WSteamOut); // transit rate scale for the steam pass
  const Q3 = transitStandingQ(
    H_TUBE_STEAM * ev.sections[2].area,
    H_TUBE_NATURAL * ev.sections[2].area,
    W23Guess * cpSteam,
    ev.sat.T, ev.sections[2].T, metalTemps[2],
    'ramping',   // same for the superheater: saturation in, gas-hot out
  );
  return { Q1, Q2, Q3, TFeedIn };
}

export class OtsgRateOperator implements RateOperator {
  name = 'OTSG';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const [id, node] of state.flowNodes) {
      const cfg = node.otsg;
      if (!cfg) continue;

      const metals = cfg.metalNodeIds.map(mid => state.thermalNodes.get(mid));
      const shell = state.flowNodes.get(cfg.shellNodeId);
      if (metals.some(m => !m) || !shell) {
        throw new Error(`[OTSG] node '${id}' references metal nodes ` +
          `[${cfg.metalNodeIds.join(', ')}] / shell '${cfg.shellNodeId}' but one of them ` +
          `does not exist.`);
      }
      const [metal1, metal2, metal3] = metals as [any, any, any];

      // The sections are a description of the WATER, so they run at the
      // water's own partial pressure and account for the water's own share of
      // the node energy - identical to the stored totals unless gas has got
      // into the tubes (see tubeWaterState). Flows are classified by the
      // phase they actually carry, and the partition is solved from the
      // node's totals with this bundle's own metal as the superheat pin -
      // one shared path for operator, sensors, checks and probes.
      const { ev, flows } = evaluateOtsgSections(state, id, node);

      // Cache for the draw-enthalpy hook and displays (derived data)
      cfg.lastEval = {
        P: ev.P,
        hSteamOut: ev.hSteamOut,
        hLiquidOut: ev.sections[0].hBar,
        TSat: ev.sat.T,
        T3: ev.sections[2].T,
        lengthFracs: [ev.sections[0].lengthFrac, ev.sections[1].lengthFrac, ev.sections[2].lengthFrac],
      };

      // ----------------------------------------------------------------
      // Gas side: counterflow march against the metal temperature
      // ----------------------------------------------------------------
      const hGas = this.gasFilmCoefficient(shell, state);
      // March from the shell's INLET temperature (the upstream duct node),
      // not its bulk: with the duty evaluated from the inlet, the well-mixed
      // shell node's own energy balance lands its bulk exactly at the
      // plug-flow OUTLET temperature - the transit-branch principle applied
      // to the gas side. Marching from bulk instead left the cold leg 200 C
      // hot because the counterflow outlet never propagated downstream.
      let TGasIn = shell.fluid.temperature;
      for (const fc of state.flowConnections) {
        if (fc.toNodeId === shell.id && fc.massFlowRate > 1e-6) {
          const donor = state.flowNodes.get(fc.fromNodeId);
          if (donor && donor.fluid.temperature > TGasIn) TGasIn = donor.fluid.temperature;
        } else if (fc.fromNodeId === shell.id && fc.massFlowRate < -1e-6) {
          const donor = state.flowNodes.get(fc.toNodeId);
          if (donor && donor.fluid.temperature > TGasIn) TGasIn = donor.fluid.temperature;
        }
      }
      // Counterflow: gas physically meets the superheat section first, and
      // each section has its OWN metal - one shared wall cannot superheat
      // (boiling pins it to T_sat and clamps every other section's wall).
      // Parallel bundles in one shell each take their share of the gas
      // stream (equal areas -> equal flows), so each marches against its own
      // mdot*cp. Their duties then sum onto the shell node below, which is
      // the same total the single-bundle case delivers.
      const march = marchCounterflowGas(
        TGasIn,
        this.gasMcp(shell, state) * (cfg.gasShare ?? 1),
        [
          // The gas sees the same walls the water does, so it approaches each
          // one by that wall's own profile: ramping under the superheater and
          // the economizer, isothermal under the boiling section, whose wall
          // its water pins at T_sat end to end. Composed across the metal,
          // the two ramping half-steps give the standard counterflow result
          // with the wall as a series resistance (see WallProfile).
          { hA: hGas * ev.sections[2].area, TWall: metal3.temperature, wall: 'ramping' as const },
          { hA: hGas * ev.sections[1].area, TWall: metal2.temperature, wall: 'isothermal' as const },
          { hA: hGas * ev.sections[0].area, TWall: metal1.temperature, wall: 'ramping' as const },
        ],
      );
      const QGasTotal = march.Q[0] + march.Q[1] + march.Q[2];


      // ----------------------------------------------------------------
      // Water side: transit + standing branches per section
      // ----------------------------------------------------------------
      const { Q1, Q2, Q3 } = otsgWaterSideDuties(ev, flows,
        [metal1.temperature, metal2.temperature, metal3.temperature]);
      const QWaterTotal = Q1 + Q2 + Q3;

      // ----------------------------------------------------------------
      // Emit rates. The partition itself has no rates any more - it is
      // solved from the totals on every evaluation - so the wall heat on the
      // node's ordinary energy balance is the only thing this side emits.
      // ----------------------------------------------------------------
      const nodeRates = rates.flowNodes.get(id) ?? { dMass: 0, dEnergy: 0 };
      nodeRates.dEnergy += QWaterTotal;
      rates.flowNodes.set(id, nodeRates);

      const shellRates = rates.flowNodes.get(cfg.shellNodeId) ?? { dMass: 0, dEnergy: 0 };
      shellRates.dEnergy -= QGasTotal;
      rates.flowNodes.set(cfg.shellNodeId, shellRates);

      // Each section's metal balances its own gas-in vs water-out; axial
      // conduction along the bundle is negligible against either.
      const perMetal: Array<[string, any, number, number]> = [
        [cfg.metalNodeIds[0], metal1, march.Q[2], Q1],
        [cfg.metalNodeIds[1], metal2, march.Q[1], Q2],
        [cfg.metalNodeIds[2], metal3, march.Q[0], Q3],
      ];
      for (const [mid, m, qIn, qOut] of perMetal) {
        const mr = rates.thermalNodes.get(mid) ?? { dTemperature: 0 };
        mr.dTemperature += (qIn - qOut) / nodeHeatCapacity(m);
        rates.thermalNodes.set(mid, mr);
      }
    }

    return rates;
  }

  /** Shell-gas film coefficient (W/m2-K): Dittus-Boelter on the shell node's
   *  through-flow, mixture properties, with a natural-convection floor. */
  private gasFilmCoefficient(shell: FlowNode, state: SimulationState): number {
    let throughput = 0;
    for (const fc of state.flowConnections) {
      if (fc.fromNodeId === shell.id || fc.toNodeId === shell.id) {
        throughput += Math.abs(fc.massFlowRate);
      }
    }
    throughput /= 2; // in + out both counted
    const ncg = shell.fluid.ncg;
    const T = shell.fluid.temperature;
    const k = ncg && totalMoles(ncg) > 0 ? mixtureThermalConductivity(ncg, T) : 0.05;
    const mu = ncg && totalMoles(ncg) > 0 ? mixtureViscosity(ncg, T) : 3e-5;
    const cp = this.gasCpPerKg(shell);
    const rho = approxVaporDensity(shell);
    const D = 0.019; // tube OD - the crossflow characteristic length
    const v = shell.flowArea > 0 && rho > 0 ? throughput / (rho * shell.flowArea) : 0;
    const Re = mu > 0 ? (rho * v * D) / mu : 0;
    const Pr = k > 0 ? (cp * mu) / k : 0.7;
    const hForced = Re > 10
      ? 0.023 * Math.pow(Re, 0.8) * Math.pow(Math.max(0.1, Pr), 0.4) * k / D
      : 0;
    return Math.max(60, hForced);
  }

  private gasMcp(shell: FlowNode, state: SimulationState): number {
    let throughput = 0;
    for (const fc of state.flowConnections) {
      if (fc.fromNodeId === shell.id || fc.toNodeId === shell.id) {
        throughput += Math.abs(fc.massFlowRate);
      }
    }
    return (throughput / 2) * this.gasCpPerKg(shell);
  }

  private gasCpPerKg(shell: FlowNode): number {
    const ncg = shell.fluid.ncg;
    if (ncg && totalMoles(ncg) > 0) {
      const M = averageMolecularWeight(ncg);
      return M > 0 ? mixtureCp(ncg) / M : 5195;
    }
    return 2000; // steam-ish
  }
}

/** Liquid temperature from enthalpy (saturated-liquid-line inversion). */
function tempOfLiquidH(h: number): number {
  // h ~ u for liquid at these pressures within ~2%; invert along u_f
  let Tlo = 274, Thi = 640;
  const u = h; // Pv correction ~ 20 kJ/kg at 165 bar - inside correlation noise
  if (u <= saturatedLiquidEnergy(Tlo)) return Tlo;
  if (u >= saturatedLiquidEnergy(Thi)) return Thi;
  for (let i = 0; i < 50; i++) {
    const Tm = 0.5 * (Tlo + Thi);
    if (saturatedLiquidEnergy(Tm) < u) Tlo = Tm; else Thi = Tm;
    if (Thi - Tlo < 0.01) break;
  }
  return 0.5 * (Tlo + Thi);
}

/**
 * Is the steam section hotter than anything that could have heated it?
 *
 * With the partition solved from the node's totals and pinned by the wall,
 * steam hotter than every surface around it can only appear through the
 * closure's UNPINNED regimes - the post-depressurization transient where a
 * subcooled slug sits directly under flash-heated vapor. That state is
 * physical for a while and relaxes through Q3 running backwards; one that
 * PERSISTS means either the upstream physics is genuinely pumping energy in
 * (worth seeing) or a regime is stuck (a bug). Report, never clamp: the
 * number is the size of whatever is going on, and this is where it is
 * visible.
 *
 * Runs postAcceptOnly - trial stages routinely swing far harder than the
 * trajectory the plant actually follows, and a guard that cries wolf on them
 * is worse than no guard.
 */
export class OtsgLedgerCheckOperator implements ConstraintOperator {
  name = 'OtsgLedgerCheck';
  /** ACCEPTED states only - reporting on a candidate the solver then rejects
   *  is the crying-wolf this check exists to avoid. */
  postAcceptOnly = true;

  /** K - how far above the hottest wall a superheat section has to land before
   *  it is reported. Compression heating in a fast pressurization is worth
   *  tens of kelvin, so this sits above that. A reporting width only: no
   *  rate depends on it. */
  private static readonly REPORT_MARGIN = 50;
  /** Once per 10 s of SIM time per bundle - keyed on sim time, not wall time,
   *  so a replay reports identically. */
  private static readonly QUIET_SECONDS = 10;
  private lastReport = new Map<string, number>();

  applyConstraints(state: SimulationState): SimulationState {
    for (const [id, node] of state.flowNodes) {
      const cfg = node.otsg;
      if (!cfg) continue;
      const { ev, water } = evaluateOtsgSections(state, id, node);

      // The hottest surface this water can see: its own tube metal, or the gas
      // arriving at the shell.
      let TWallMax = state.flowNodes.get(cfg.shellNodeId)?.fluid.temperature ?? 0;
      for (const mid of cfg.metalNodeIds) {
        const m = state.thermalNodes.get(mid);
        if (m && m.temperature > TWallMax) TWallMax = m.temperature;
      }

      const excess = ev.sections[2].T - TWallMax;
      if (!(excess > OtsgLedgerCheckOperator.REPORT_MARGIN)) continue;
      const last = this.lastReport.get(id);
      if (last !== undefined && state.time - last < OtsgLedgerCheckOperator.QUIET_SECONDS) continue;
      this.lastReport.set(id, state.time);

      console.error(
        `[OTSG] ${id}: the steam section is ${excess.toFixed(0)} K ABOVE the hottest surface ` +
        `heating it (${(ev.sections[2].T - 273.15).toFixed(0)} C vs ` +
        `${(TWallMax - 273.15).toFixed(0)} C) at t=${state.time.toFixed(1)} s, and has been ` +
        `for longer than a depressurization transient explains. The partition is solved from ` +
        `the node's totals, so this cannot be ledger drift any more - either the totals ` +
        `really do hold this much energy (upstream physics) or the closure's unpinned regime ` +
        `is stuck. Node: ${(water.pressure / 1e5).toFixed(1)} bar, ` +
        `${node.fluid.mass.toFixed(0)} kg, ` +
        `u=${(water.energy / node.fluid.mass / 1e3).toFixed(0)} kJ/kg, ` +
        `v=${(node.volume / node.fluid.mass).toFixed(5)} m3/kg, ${node.fluid.phase}; ` +
        `sections ${ev.sections.map(x => x.mass.toFixed(0)).join('/')} kg, ` +
        `closure took the '${ev.regime}' branch.`
      );
    }
    return state;
  }
}
