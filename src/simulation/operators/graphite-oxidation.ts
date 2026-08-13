/**
 * Graphite Oxidation Rate Operator - air ingress fires and steam gasification
 *
 * THE MODEL IS ONE RESISTANCE CHAIN, NOT THREE REGIMES. The classical
 * picture of graphite oxidation has three zones - chemical control at low
 * temperature, in-pore diffusion control in the middle, boundary-layer
 * control at high temperature - and it is tempting to implement them as
 * three branches with thresholds between. That would produce kinks, and the
 * thresholds would be wrong for any geometry other than the one they were
 * tuned on. Instead, every oxidant reaches the carbon through one series
 * chain and the zones emerge as its asymptotes:
 *
 *     N'' = C_bulk / ( 1/h_m  +  1/(eta * k_v * L_c) )
 *
 *     h_m   external mass transfer through the boundary layer
 *     k_v   volumetric rate constant, S_v(X) * k_s(T)
 *     eta   Thiele effectiveness, tanh(phi)/phi, phi = L_c sqrt(k_v/D_eff)
 *
 *   phi -> 0   eta -> 1     whole volume reacts     (zone I, apparent Ea = Ea)
 *   phi >> 1   eta -> 1/phi rate ~ sqrt(k D_eff)    (zone II, apparent Ea = Ea/2)
 *   k_eff >> h_m            rate -> h_m C_bulk      (zone III, nearly flat in T)
 *
 * The halving of the apparent activation energy in zone II is a DERIVED
 * consequence of eta ~ 1/phi with phi ~ sqrt(k). We never wrote a factor of
 * two anywhere - see the test that measures it.
 *
 * WHY IT IS NUMERICALLY WELL BEHAVED. C_bulk is the oxidant's own molar
 * density, so the whole expression is exactly first order in the available
 * moles: consumption is n * lambda, an exponential decay. Oxidant depletion
 * therefore glides to zero instead of needing a floor, and the transport
 * resistance 1/h_m puts a ceiling on how fast the reaction can possibly run
 * no matter how hot the graphite gets - which is also the physical reason
 * real graphite fires are limited by air supply rather than by chemistry.
 *
 * WHAT COMES OUT WITHOUT BEING ASKED FOR:
 *  - Air ingress is a fire (exothermic) and steam ingress is a slow
 *    gasification (endothermic). Only the signs of the reaction enthalpies
 *    differ; nothing branches on which gas is present.
 *  - Hot graphite makes mostly CO rather than CO2, keeping only a quarter
 *    of the heat at the surface and sending the rest downstream as fuel
 *    gas - which the existing combustion operator then burns wherever it
 *    next meets oxygen.
 *  - Steam gasification self-limits, because the H2 it makes inhibits it.
 *  - The pebbles burn before the reflector does, because fine-grain matrix
 *    graphite has more internal surface per gram than medium-grain NBG-18.
 */

import { SimulationState } from '../types';
import { RateOperator, StateRates, createZeroRates } from '../rk45-solver';
import {
  NBG_18,
  A3_3,
  GraphiteGrade,
  GraphiteOxidant,
  oxidantRateConstant,
  oxidantPerCarbon,
  oxidantInhibition,
  reactionHeatPerCarbon,
  coFraction,
  internalSurfacePerVolume,
  characteristicPoreRadius,
  thieleEffectiveness,
  burnoffSurfaceFactor,
  burnoffPorosity,
} from '../graphite';
import {
  totalMoles,
  emptyGasComposition,
  mixtureViscosity,
  diffusivityInMixture,
  knudsenDiffusivity,
  effectivePoreDiffusivity,
  speciesMolecularWeight,
} from '../gas-properties';
import { nodeHeatCapacity } from './rate-operators';
import { approxVaporDensity } from './connection-hydraulics';

const OXIDANTS: GraphiteOxidant[] = ['O2', 'H2O', 'CO2'];
const M_CARBON = 0.012011; // kg/mol

/** Per-node diagnostics for the UI and the check script */
export interface GraphiteOxidationDiagnostics {
  nodeId: string;
  burnoff: number;
  /** kg of carbon per second, by oxidant */
  carbonRate: Record<GraphiteOxidant, number>;
  /** Thiele effectiveness by oxidant - which zone each reaction is in */
  effectiveness: Record<GraphiteOxidant, number>;
  /** Net heat into the graphite (W); negative while gasification dominates */
  heatRate: number;
  /** Fraction of carbon leaving as CO rather than CO2 */
  coFraction: number;
}

const lastDiagnostics = new Map<string, GraphiteOxidationDiagnostics>();

/** Last computed per-node graphite oxidation diagnostics */
export function getGraphiteOxidationDiagnostics(): ReadonlyMap<string, GraphiteOxidationDiagnostics> {
  return lastDiagnostics;
}

function gradeFor(name: 'NBG-18' | 'A3-3'): GraphiteGrade {
  return name === 'NBG-18' ? NBG_18 : A3_3;
}

export class GraphiteOxidationRateOperator implements RateOperator {
  name = 'GraphiteOxidation';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();
    lastDiagnostics.clear();

    for (const [id, node] of state.thermalNodes) {
      const gox = node.graphiteOxidation;
      if (!gox) continue;

      const gasNode = state.flowNodes.get(gox.associatedGasNode);
      if (!gasNode) {
        throw new Error(
          `[GraphiteOxidation] Node '${id}' names gas node ` +
          `'${gox.associatedGasNode}', which does not exist. Oxidant supply and ` +
          `product release both depend on it; there is no sensible default.`
        );
      }

      const remaining = 1 - gox.burnoff;
      if (remaining <= 0) continue; // no carbon left to attack

      const grade = gradeFor(gox.grade);
      const T = node.temperature;

      // --- Structure at the current burn-off -----------------------------
      // Both DERIVED from burn-off, never integrated separately, so the
      // pore structure cannot drift away from the mass actually consumed.
      const surfaceFactor = burnoffSurfaceFactor(gox.burnoff);
      const S_v = internalSurfacePerVolume(grade) * surfaceFactor;
      const porosity = burnoffPorosity(grade.porosity, gox.burnoff);
      // Pores widen as the walls between them are eaten away: pore volume
      // grows while pore area follows the random-pore factor.
      const poreRadius = characteristicPoreRadius(grade) *
        (surfaceFactor > 0 ? (porosity / grade.porosity) / surfaceFactor : 1);

      // --- Gas state -----------------------------------------------------
      const ncg = gasNode.fluid.ncg ?? emptyGasComposition();
      const volume = gasNode.volume;
      const T_gas = gasNode.fluid.temperature;
      const P = gasNode.fluid.pressure;

      // Steam sharing the vapour space (all of it for a vapour node, the
      // vapour fraction for two-phase). This is the H2O oxidant inventory.
      const steamVaporMass = gasNode.fluid.phase === 'two-phase'
        ? gasNode.fluid.mass * (gasNode.fluid.quality ?? 0)
        : gasNode.fluid.mass;
      const steamMoles = Math.max(0, steamVaporMass / 0.018015);

      const nTotal = totalMoles(ncg) + steamMoles;
      const p_H2 = nTotal > 0 ? P * ((ncg.H2 ?? 0) / nTotal) : 0;

      // External mass-transfer coefficient. Sherwood for a sphere or a
      // surface in cross-flow: Sh = 2 + 0.6 Re^0.5 Sc^(1/3). The leading 2
      // is the stagnant-sphere limit, so h_m stays finite and positive with
      // every blower dead - which is exactly the condition an air-ingress
      // accident runs in.
      let totalMassFlow = 0;
      for (const fc of state.flowConnections) {
        if (fc.fromNodeId === gasNode.id || fc.toNodeId === gasNode.id) {
          totalMassFlow += Math.abs(fc.massFlowRate);
        }
      }
      const rho_g = approxVaporDensity(gasNode);
      const mu_g = mixtureViscosity(ncg, T_gas);
      const velocity = gasNode.flowArea > 0 && rho_g > 0
        ? totalMassFlow / (rho_g * gasNode.flowArea)
        : 0;
      const L_piece = 6 * gox.characteristicLength; // sphere diameter equivalent
      const Re = mu_g > 0 ? (rho_g * velocity * L_piece) / mu_g : 0;

      const nodeRates = rates.thermalNodes.get(id) ?? { dTemperature: 0 };
      const gasRates = rates.flowNodes.get(gasNode.id) ?? { dMass: 0, dEnergy: 0 };
      if (!gasRates.dNcg) gasRates.dNcg = emptyGasComposition();

      let carbonTotal = 0;      // kg/s
      let heatTotal = 0;        // W into the graphite
      const diagCarbon = { O2: 0, H2O: 0, CO2: 0 } as Record<GraphiteOxidant, number>;
      const diagEta = { O2: 1, H2O: 1, CO2: 1 } as Record<GraphiteOxidant, number>;
      const f_CO = coFraction(T);

      for (const oxidant of OXIDANTS) {
        const moles = oxidant === 'H2O' ? steamMoles : (ncg[oxidant] ?? 0);
        if (moles <= 0 || volume <= 0) continue;

        // Bulk molar concentration of this oxidant (mol/m3). Using the
        // inventory directly is what makes consumption first order in the
        // moles present, so depletion is a smooth exponential decay.
        const C_bulk = moles / volume;

        // Intrinsic kinetics, inhibited where the mechanism calls for it
        const k_s = oxidantRateConstant(grade, oxidant, T) *
          oxidantInhibition(oxidant, p_H2);
        const k_v = S_v * k_s; // 1/s

        // In-pore diffusion
        const D_bulk = diffusivityInMixture(oxidant, ncg, steamMoles, T_gas, P);
        const D_kn = knudsenDiffusivity(poreRadius, T, speciesMolecularWeight(oxidant));
        const D_eff = effectivePoreDiffusivity(D_bulk, D_kn, porosity);

        const phi = gox.characteristicLength * Math.sqrt(k_v / D_eff);
        const eta = thieleEffectiveness(phi);
        const k_eff = eta * k_v * gox.characteristicLength; // m/s

        // External transport
        const Sc = mu_g > 0 && rho_g > 0 ? mu_g / (rho_g * D_bulk) : 1;
        const Sh = 2 + 0.6 * Math.sqrt(Math.max(0, Re)) * Math.cbrt(Math.max(1e-6, Sc));
        const h_m = (Sh * D_bulk) / L_piece; // m/s

        // Series resistance, then carbon consumption
        const flux = C_bulk / (1 / h_m + 1 / k_eff);      // mol oxidant/(m2.s)
        const oxidantMolRate = flux * gox.externalArea;    // mol/s
        const carbonMolRate = oxidantMolRate / oxidantPerCarbon(oxidant, T);

        if (!(carbonMolRate > 0) || !Number.isFinite(carbonMolRate)) continue;

        carbonTotal += carbonMolRate * M_CARBON;
        heatTotal += carbonMolRate * reactionHeatPerCarbon(oxidant, T);
        diagCarbon[oxidant] = carbonMolRate * M_CARBON;
        diagEta[oxidant] = eta;

        // --- Products ----------------------------------------------------
        switch (oxidant) {
          case 'O2':
            gasRates.dNcg.O2 -= oxidantMolRate;
            gasRates.dNcg.CO += carbonMolRate * f_CO;
            gasRates.dNcg.CO2 += carbonMolRate * (1 - f_CO);
            break;
          case 'H2O': {
            // Steam is water, not an NCG: it leaves the flow node's mass.
            const steamMassRate = oxidantMolRate * 0.018015;
            gasRates.dMass -= steamMassRate;
            // Carry the steam's specific enthalpy out with it, matching how
            // the cladding oxidation operator books consumed steam.
            gasRates.dEnergy -= steamMassRate * 2.0e6;
            gasRates.dNcg.CO += carbonMolRate;
            gasRates.dNcg.H2 += carbonMolRate;
            break;
          }
          case 'CO2':
            gasRates.dNcg.CO2 -= oxidantMolRate;
            gasRates.dNcg.CO += 2 * carbonMolRate;
            break;
        }
      }

      if (carbonTotal <= 0) continue;

      // Reaction heat lands on the graphite. Gasification is endothermic,
      // so this can be negative - a steam-flooded core cools its own
      // graphite, which is why that path cannot run away.
      nodeRates.dTemperature += heatTotal / nodeHeatCapacity(node);
      rates.thermalNodes.set(id, nodeRates);

      // Burn-off advances in proportion to carbon consumed.
      nodeRates.dGraphiteBurnoff =
        (nodeRates.dGraphiteBurnoff ?? 0) + carbonTotal / gox.initialCarbonMass;

      rates.flowNodes.set(gasNode.id, gasRates);

      lastDiagnostics.set(id, {
        nodeId: id,
        burnoff: gox.burnoff,
        carbonRate: diagCarbon,
        effectiveness: diagEta,
        heatRate: heatTotal,
        coFraction: f_CO,
      });
    }

    return rates;
  }
}
