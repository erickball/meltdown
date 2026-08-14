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
 * machinery - this operator adds only the wall heat and the PARTITION rates
 * (dm1, dm3), plus the matching energy changes on the shell node and metal.
 * Section 2's mass and the superheat energy are derived from totals, so no
 * bookkeeping here can ever disagree with conservation.
 *
 * External flows and the partition: connection flows are classified by the
 * phase they are actually carrying (currentFlowPhase, set by the momentum
 * solve): liquid inflow is feed into section 1; vapor outflow is the steam
 * draw from section 3; mixture flows (e.g. a mid-bundle tube leak) touch
 * section 2, whose mass is derived - so they need no partition bookkeeping
 * at all. Draws from an emptying section blend smoothly to the neighbor
 * (same m/(m+1) weight as the draw enthalpy), so a section's death never
 * steps any rate.
 */

import { SimulationState, FlowNode } from '../types';
import { RateOperator, StateRates, createZeroRates } from '../rk45-solver';
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

/** Tube-side film coefficients (W/m2-K). The gas shell is the limiting
 *  resistance by an order of magnitude, so correlation-grade constants are
 *  adequate here; each is the standard scale for its regime. */
const H_TUBE_LIQUID = 4000;
const H_TUBE_BOILING = 25000;
const H_TUBE_STEAM = 1200;
/** Natural-convection floor for the standing branch (W/m2-K) - what keeps a
 *  bottled boiler heating. */
const H_TUBE_NATURAL = 250;

export class OtsgRateOperator implements RateOperator {
  name = 'OTSG';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const [id, node] of state.flowNodes) {
      const cfg = node.otsg;
      if (!cfg) continue;

      const metal = state.thermalNodes.get(cfg.metalNodeId);
      const shell = state.flowNodes.get(cfg.shellNodeId);
      if (!metal || !shell) {
        throw new Error(`[OTSG] node '${id}' references metal '${cfg.metalNodeId}' / ` +
          `shell '${cfg.shellNodeId}' but ${!metal ? 'the metal node' : 'the shell node'} ` +
          `does not exist.`);
      }

      // ----------------------------------------------------------------
      // Classify attached connection flows by carried phase
      // ----------------------------------------------------------------
      let WFeed = 0, hFeedNum = 0;        // liquid inflow -> section 1
      let WSteamOut = 0;                   // vapor outflow <- section 3
      let WLiquidOut = 0;                  // liquid outflow <- section 1
      let WVaporIn = 0;                    // vapor inflow -> section 3 (backflow)
      for (const conn of state.flowConnections) {
        const isFrom = conn.fromNodeId === id;
        const isTo = conn.toNodeId === id;
        if (!isFrom && !isTo) continue;
        // Signed flow INTO this node
        const w = isTo ? conn.massFlowRate : -conn.massFlowRate;
        const phase = conn.currentFlowPhase ?? 'liquid';
        if (w > 0) {
          if (phase === 'vapor') { WVaporIn += w; }
          else {
            WFeed += w;
            // Feed enthalpy from the donor node: subcooled liquid at its
            // temperature (u_f(T) + P v_f(T) - compressibility negligible)
            const donor = state.flowNodes.get(isTo ? conn.fromNodeId : conn.toNodeId);
            const Td = donor?.fluid.temperature ?? 473;
            const hIn = saturatedLiquidEnergy(Td) + node.fluid.pressure / saturatedLiquidDensity(Td);
            hFeedNum += w * hIn;
          }
        } else if (w < 0) {
          if (phase === 'vapor') WSteamOut += -w;
          else if (phase === 'liquid') WLiquidOut += -w;
          // mixture draws come from section 2: derived mass, no bookkeeping
        }
      }
      const hFeed = WFeed > 0 ? hFeedNum / WFeed : saturatedLiquidEnergy(473);
      const uFeed = hFeed - node.fluid.pressure * 0.0012; // u = h - Pv, liquid v ~ 1.2 L/kg

      // ----------------------------------------------------------------
      // Sectioned evaluation at the node's bulk pressure
      // ----------------------------------------------------------------
      const ev: OtsgEval = evaluateOtsgAtP(
        cfg.m1, cfg.m3, node.fluid.mass,
        node.fluid.internalEnergy,
        node.fluid.pressure,
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
      // Counterflow: gas physically meets the superheat section first
      const march = marchCounterflowGas(
        TGasIn,
        this.gasMcp(shell, state),
        [
          { hA: hGas * ev.sections[2].area, TWall: metal.temperature },
          { hA: hGas * ev.sections[1].area, TWall: metal.temperature },
          { hA: hGas * ev.sections[0].area, TWall: metal.temperature },
        ],
      );
      const QGasTotal = march.Q[0] + march.Q[1] + march.Q[2];

      // ----------------------------------------------------------------
      // Water side: transit + standing branches per section
      // ----------------------------------------------------------------
      const TM = metal.temperature;
      const cpLiquid = 5000;
      // Section 1: feed stream entering at its own temperature
      const TFeedIn = WFeed > 0 ? tempOfLiquidH(hFeed) : ev.sections[0].T;
      const Q1 = transitStandingQ(
        H_TUBE_LIQUID * ev.sections[0].area,
        H_TUBE_NATURAL * ev.sections[0].area,
        WFeed * cpLiquid,
        TFeedIn, ev.sections[0].T, TM,
      );
      // Section 2: boiling at T_sat - huge film coefficient, pure standing form
      const Q2 = (H_TUBE_BOILING * ev.sections[1].area) * (TM - ev.sat.T);
      // Section 3: steam entering at saturation, heated toward the wall
      const cpSteam = ev.sections[2].mass > 0 && ev.sections[2].T > ev.sat.T + 1
        ? Math.max(2000, (ev.sections[2].hBar - ev.sat.h_g) / (ev.sections[2].T - ev.sat.T))
        : 3000;
      const W23Guess = Math.max(0, WSteamOut); // transit rate scale for the steam pass
      const Q3 = transitStandingQ(
        H_TUBE_STEAM * ev.sections[2].area,
        H_TUBE_NATURAL * ev.sections[2].area,
        W23Guess * cpSteam,
        ev.sat.T, ev.sections[2].T, TM,
      );
      const QWaterTotal = Q1 + Q2 + Q3;

      // ----------------------------------------------------------------
      // Partition rates from the interface fluxes
      // ----------------------------------------------------------------
      const r = otsgRates(ev, WFeed, hFeed, WSteamOut, Q1, Q2, Q3);
      // Draws from emptying sections shift smoothly onto their neighbor
      // (same weight as the draw-enthalpy blend)
      const w3 = cfg.m3 / (cfg.m3 + 1);
      const w1 = cfg.m1 / (cfg.m1 + 1);
      const dm1 = WFeed - r.W12 - w1 * WLiquidOut;
      const dm3 = r.W23 - w3 * WSteamOut + WVaporIn;

      // ----------------------------------------------------------------
      // Emit rates
      // ----------------------------------------------------------------
      const nodeRates = rates.flowNodes.get(id) ?? { dMass: 0, dEnergy: 0 };
      nodeRates.dEnergy += QWaterTotal;
      nodeRates.dOtsgM1 = (nodeRates.dOtsgM1 ?? 0) + dm1;
      nodeRates.dOtsgM3 = (nodeRates.dOtsgM3 ?? 0) + dm3;
      rates.flowNodes.set(id, nodeRates);

      const shellRates = rates.flowNodes.get(cfg.shellNodeId) ?? { dMass: 0, dEnergy: 0 };
      shellRates.dEnergy -= QGasTotal;
      rates.flowNodes.set(cfg.shellNodeId, shellRates);

      const metalRates = rates.thermalNodes.get(cfg.metalNodeId) ?? { dTemperature: 0 };
      metalRates.dTemperature += (QGasTotal - QWaterTotal) / nodeHeatCapacity(metal);
      rates.thermalNodes.set(cfg.metalNodeId, metalRates);
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
