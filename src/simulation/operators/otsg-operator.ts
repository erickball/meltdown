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
 *   water sections --[interface fluxes at h_f / h_g]--> partition motion
 *
 * The node's ordinary (mass, energy) totals stay owned by the existing flow
 * machinery - this operator adds only the wall heat and the ONE partition
 * rate dU1 (the subcooled section's energy balance), plus the matching energy
 * changes on the shell node and metal. Where the boiling section ends, and
 * whether there is a superheat section at all, is solved from the totals and
 * the tube volume inside evaluateOtsgAtP, so no bookkeeping here can disagree
 * with conservation OR with the room the tubes actually have.
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
  otsgRates,
  transitStandingQ,
  marchCounterflowGas,
  OtsgEval,
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
  const ncg = node.fluid.ncg;
  if (!ncg || totalMoles(ncg) <= 0) {
    return { pressure: node.fluid.pressure, energy: node.fluid.internalEnergy };
  }
  const mix = solveMixtureState(
    node.fluid.mass, node.fluid.internalEnergy, node.volume, ncg, node.fluid.temperature);
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
      // into the tubes (see tubeWaterState).
      const water = tubeWaterState(node);

      // ----------------------------------------------------------------
      // Classify attached connection flows by carried phase
      // ----------------------------------------------------------------
      const { WFeed, hFeed, uFeed, WSteamOut, WLiquidOut } =
        classifyOtsgFlows(state, id, node, water.pressure);

      // ----------------------------------------------------------------
      // Sectioned evaluation at the water's own pressure
      // ----------------------------------------------------------------
      const ev: OtsgEval = evaluateOtsgAtP(
        cfg.U1, node.fluid.mass,
        water.energy,
        water.pressure,
        uFeed,
        { tubeVolume: node.volume, tubeLength: 1, heatArea: cfg.heatArea },
      );

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
          { hA: hGas * ev.sections[2].area, TWall: metal3.temperature },
          { hA: hGas * ev.sections[1].area, TWall: metal2.temperature },
          { hA: hGas * ev.sections[0].area, TWall: metal1.temperature },
        ],
      );
      const QGasTotal = march.Q[0] + march.Q[1] + march.Q[2];


      // ----------------------------------------------------------------
      // Water side: transit + standing branches per section
      // ----------------------------------------------------------------
      const cpLiquid = 5000;
      // Section 1: feed stream entering at its own temperature
      const TFeedIn = WFeed > 0 ? tempOfLiquidH(hFeed) : ev.sections[0].T;
      const Q1 = transitStandingQ(
        H_TUBE_LIQUID * ev.sections[0].area,
        H_TUBE_NATURAL * ev.sections[0].area,
        WFeed * cpLiquid,
        TFeedIn, ev.sections[0].T, metal1.temperature,
      );
      // Section 2: boiling at T_sat - huge film coefficient, pure standing form
      const Q2 = (H_TUBE_BOILING * ev.sections[1].area) * (metal2.temperature - ev.sat.T);
      // Section 3: steam entering at saturation, heated toward its own wall -
      // which the boiling section can no longer clamp.
      const cpSteam = ev.sections[2].mass > 0 && ev.sections[2].T > ev.sat.T + 1
        ? Math.max(2000, (ev.sections[2].hBar - ev.sat.h_g) / (ev.sections[2].T - ev.sat.T))
        : 3000;
      const W23Guess = Math.max(0, WSteamOut); // transit rate scale for the steam pass
      const Q3 = transitStandingQ(
        H_TUBE_STEAM * ev.sections[2].area,
        H_TUBE_NATURAL * ev.sections[2].area,
        W23Guess * cpSteam,
        ev.sat.T, ev.sections[2].T, metal3.temperature,
      );
      const QWaterTotal = Q1 + Q2 + Q3;

      // ----------------------------------------------------------------
      // Partition rates from the interface fluxes
      // ----------------------------------------------------------------
      // Only the SUBCOOLED section is integrated, and it is integrated as an
      // ENERGY. Where the boiling section ends - and whether there is a
      // superheat section at all - is solved from the node's totals inside
      // evaluateOtsgAtP, so W23 is now a diagnostic rather than a state
      // derivative: the steam draw and any vapor backflow move the totals,
      // and the partition follows them.
      const r = otsgRates(ev, WFeed, hFeed, WSteamOut, Q1, Q2, Q3);
      // A liquid draw takes water out of section 1 at that section's own mean
      // enthalpy, weighted so an emptying section never steps its own rate.
      const m1Now = ev.sections[0].mass;
      const w1 = m1Now / (m1Now + 1);
      const WLiqOut = w1 * WLiquidOut;
      const dU1 = r.dU1 - WLiqOut * ev.sections[0].hBar
        + ev.P * (WLiqOut * ev.sections[0].vBar);   // P dV of the mass it takes with it

      // ----------------------------------------------------------------
      // Emit rates
      // ----------------------------------------------------------------
      const nodeRates = rates.flowNodes.get(id) ?? { dMass: 0, dEnergy: 0 };
      nodeRates.dEnergy += QWaterTotal;
      nodeRates.dOtsgU1 = (nodeRates.dOtsgU1 ?? 0) + dU1;
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
 * Is the economizer still describing water that is actually in the tube?
 *
 * The closure's arithmetic never looks at the wall. It subtracts the
 * economizer's claimed energy from the node and hands the remainder to the
 * steam, so an economizer that has drifted away from the tube's real contents
 * comes back as steam hotter than anything heating it. The tube's own totals
 * cannot catch that - a tube of cold water plus hot steam and a tube of
 * lukewarm mush have the same mass, energy and volume, which is precisely why
 * the sectioned model has to carry the extra information in the first place.
 *
 * The WALL can catch it. Nothing in a boiler tube gets hotter than the hottest
 * surface heating it except by compression, and a boiler's compression heating
 * is tens of kelvin in a fast transient, never hundreds. So this reports the
 * excess rather than clamping it: the number IS the size of the bookkeeping
 * error, and this is the only place it is visible.
 *
 * It runs as a finalOnly constraint - on ACCEPTED states only. The rate
 * operator is called on every RK stage, including trial states the solver
 * goes on to reject, and those routinely swing far harder than the trajectory
 * the plant actually follows; a guard that cried wolf on them would be worse
 * than no guard.
 */
export class OtsgLedgerCheckOperator implements ConstraintOperator {
  name = 'OtsgLedgerCheck';
  finalOnly = true;

  /** K - how far above the hottest wall a superheat section has to land before
   *  it is reported. Compression heating in a fast pressurization is worth
   *  tens of kelvin, so this sits above that and well below the hundreds a
   *  drifted ledger produces. A reporting width only: no rate depends on it. */
  private static readonly REPORT_MARGIN = 50;
  /** Once per 10 s of SIM time per bundle - keyed on sim time, not wall time,
   *  so a replay reports identically. */
  private static readonly QUIET_SECONDS = 10;
  private lastReport = new Map<string, number>();

  applyConstraints(state: SimulationState): SimulationState {
    for (const [id, node] of state.flowNodes) {
      const cfg = node.otsg;
      if (!cfg) continue;
      const water = tubeWaterState(node);
      const flows = classifyOtsgFlows(state, id, node, water.pressure);
      const ev = evaluateOtsgAtP(
        cfg.U1, node.fluid.mass, water.energy, water.pressure, flows.uFeed,
        { tubeVolume: node.volume, tubeLength: 1, heatArea: cfg.heatArea },
      );

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
        `${(TWallMax - 273.15).toFixed(0)} C) at t=${state.time.toFixed(1)} s. Nothing in the ` +
        `tube can do that, so the economizer's energy ledger has drifted from the water ` +
        `actually in there: it claims ${(cfg.U1 / 1e9).toFixed(2)} GJ - ` +
        `${ev.sections[0].mass.toFixed(0)} kg at ${(ev.sections[0].T - 273.15).toFixed(0)} C, ` +
        `fed at ${(flows.uFeed / 1e3).toFixed(0)} kJ/kg - out of the node's ` +
        `${node.fluid.mass.toFixed(0)} kg, leaving ${ev.sections[2].mass.toFixed(0)} kg of ` +
        `steam to carry the rest. W12 drains it; if this persists, that flux is the suspect.`
      );
    }
    return state;
  }
}
