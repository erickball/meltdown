/**
 * HydrogenCombustionRateOperator - continuous-rate hydrogen burning.
 *
 * 2 H2 + O2 -> 2 H2O(g), 240 kJ per mol H2 (constant-volume, vapor product).
 *
 * MODEL: one continuous rate equation per node, no discrete ignition event.
 *
 *   R (mol H2/s) = n_H2 * lambda,   lambda = min(lambda_mix, lambda_kin) * g
 *
 * - lambda_kin = A0 * exp(-Ta/T): global Arrhenius kinetics evaluated at the
 *   gas temperature, plus a weak "pilot" contribution evaluated at the
 *   hottest solid surface wetted by the node's gas (a hot wall ignites the
 *   adjacent mixture; the released heat raises the bulk temperature and the
 *   bulk term runs away - ignition EMERGES as thermal runaway of the rate
 *   equation rather than being a coded event). Constants anchored so that a
 *   flammable mixture is inert for hours below ~500 K and lights within
 *   seconds above the ~850 K autoignition range.
 * - lambda_mix = S_FLAME / V^(1/3): once burning, the rate is limited by
 *   flame propagation across the node (turbulent flame speed ~3 m/s over
 *   the node's linear scale), not by kinetics - a containment-sized volume
 *   deflagrates over tens of seconds, a small vessel in ~a second. This is
 *   the physical rate cap that keeps the burn resolvable.
 * - g: the flammability envelope as smooth composition factors - logistic
 *   gates at the empirical limits (4% H2 lower limit, ~5% O2 oxidizer
 *   starvation, 55% steam inerting, from H2_FLAMMABILITY). The limits are
 *   physically sharp; the narrow logistic widths represent the real
 *   marginal-propagation band around each, not numerical smoothing.
 *
 * Ignition sources represented:
 * - Bulk gas temperature (autoignition).
 * - Hot solid surfaces (fuel debris, overheated structures) via the pilot
 *   term over the node's convection connections.
 * - PLACEHOLDER until the electrical system exists: a node that IS a
 *   running pump is treated as containing a ~700 K igniter surface
 *   (brushes/windings arcing). Deterministic-but-weak rather than
 *   stochastic; revisit when electric power is modeled.
 *
 * Bookkeeping (exactly conservative by construction):
 * - dNcg.H2 -= R, dNcg.O2 -= R/2: the removed moles' thermal energy stays
 *   in the node's internalEnergy (the NCG/water split re-attributes it).
 * - dMass += R * 0.018: product steam joins the water inventory.
 * - dEnergy += R * DELTA_U: the constant-volume reaction energy; heating the
 *   product steam from the reference state is paid out of this release.
 *
 * CO COMBUSTION (MCCI generates CO): CO + 1/2 O2 -> CO2, 280 kJ/mol CO
 * (constant volume). CO rides the same rate machinery as H2 - one lambda,
 * shared O2 budget - with two differences grounded in the chemistry:
 * - Flammability: the fuels support each other. The lower-limit gate is a
 *   Le Chatelier sum (xH2/4% + xCO/12.5%), so a mixture lean in both can
 *   still burn if the sum crosses 1, and MCCI's H2 makes its CO ignitable.
 * - Rate: CO oxidation (via OH radicals) is distinctly slower than H2 -
 *   its laminar flame speed is ~1/3 of hydrogen's - so the CO burn rate
 *   carries that factor.
 */

import { SimulationState } from '../types';
import { RateOperator, StateRates, createZeroRates } from '../rk45-solver';
import { emptyGasComposition, totalMoles, H2_FLAMMABILITY } from '../gas-properties';

/** Smooth logistic gate: ~0 below (x0 - few*width), ~1 above (x0 + few*width) */
function gateAbove(x: number, x0: number, width: number): number {
  return 1 / (1 + Math.exp(-(x - x0) / width));
}

export class HydrogenCombustionRateOperator implements RateOperator {
  name = 'HydrogenCombustion';

  /** Constant-volume heat of reaction per mol H2 (vapor product) */
  private static readonly DELTA_U = 240e3;         // J/mol H2
  /** Constant-volume heat of reaction per mol CO */
  private static readonly DELTA_U_CO = 280e3;      // J/mol CO
  /** CO lower flammability limit in air (dry CO ~12.5%) */
  private static readonly CO_LOWER_LIMIT = 0.125;
  /** CO burns ~3x slower than H2 (flame-speed ratio, moist CO) */
  private static readonly CO_RATE_FACTOR = 0.3;
  /** Arrhenius prefactor and activation temperature: inert (<1e-11/s) at
   *  300 K, ~2e-3/s at 600 K, runaway-fast near the ~850 K autoignition
   *  range. */
  private static readonly A0 = 1e6;                // 1/s
  private static readonly TA = 12000;              // K
  /** Turbulent flame speed for the propagation-limited (mixing) cap */
  private static readonly S_FLAME = 3;             // m/s
  /** Pilot coupling: kernel volume fraction a hot surface can light directly */
  private static readonly PILOT_COUPLING = 1e-3;
  /** Electric-equipment placeholder igniter temperature (see header) */
  private static readonly ELECTRIC_IGNITER_T = 700; // K
  private static readonly H2O_MOLAR_MASS = 0.018;   // kg/mol

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const [id, node] of state.flowNodes) {
      if (node.isBoundary) continue;
      const ncg = node.fluid.ncg;
      if (!ncg || (ncg.H2 <= 1e-9 && ncg.CO <= 1e-9) || ncg.O2 <= 1e-9) continue;
      // Combustion happens in a gas space; a liquid-full node has none
      if (node.fluid.phase === 'liquid') continue;

      // --- Composition envelope -------------------------------------------
      // Steam shares the gas space with the NCG: mole fractions over
      // (vapor water + NCG)
      const vaporWaterMass = node.fluid.phase === 'vapor'
        ? node.fluid.mass
        : node.fluid.mass * (node.fluid.quality ?? 0);
      const steamMoles = vaporWaterMass / HydrogenCombustionRateOperator.H2O_MOLAR_MASS;
      const gasMoles = totalMoles(ncg) + steamMoles;
      if (gasMoles <= 0) continue;
      const xH2 = ncg.H2 / gasMoles;
      const xCO = ncg.CO / gasMoles;
      const xO2 = ncg.O2 / gasMoles;
      const xSteam = steamMoles / gasMoles;

      // Lower limit as a Le Chatelier sum over both fuels (>1 = flammable);
      // the normalized width matches the old per-fuel gate (0.01/0.04)
      const fuelIndex = xH2 / H2_FLAMMABILITY.lowerLimit +
        xCO / HydrogenCombustionRateOperator.CO_LOWER_LIMIT;
      const g =
        gateAbove(fuelIndex, 1, 0.25) *
        gateAbove(xO2, 0.05, 0.01) *
        gateAbove(H2_FLAMMABILITY.steamInertingLimit - xSteam, 0, 0.05);
      if (g < 1e-9) continue;

      // --- Ignition kinetics ----------------------------------------------
      const arrhenius = (T: number) =>
        HydrogenCombustionRateOperator.A0 *
        Math.exp(-HydrogenCombustionRateOperator.TA / Math.max(T, 200));

      let lambdaKin = arrhenius(node.fluid.temperature);

      // Hot-surface pilot: hottest solid wetted by this node
      let hotSurfaceT = 0;
      for (const conv of state.convectionConnections) {
        if (conv.flowNodeId !== id) continue;
        const solid = state.thermalNodes.get(conv.thermalNodeId);
        if (solid && solid.temperature > hotSurfaceT) hotSurfaceT = solid.temperature;
      }
      // Electric-equipment placeholder: a running pump is an igniter
      const pump = state.components.pumps.get(id);
      if (pump && pump.running && pump.effectiveSpeed > 0.05) {
        hotSurfaceT = Math.max(hotSurfaceT, HydrogenCombustionRateOperator.ELECTRIC_IGNITER_T);
      }
      if (hotSurfaceT > 0) {
        lambdaKin += HydrogenCombustionRateOperator.PILOT_COUPLING * arrhenius(hotSurfaceT);
      }

      // --- Propagation (mixing) cap ---------------------------------------
      const lambdaMix = HydrogenCombustionRateOperator.S_FLAME / Math.cbrt(node.volume);

      const lambda = Math.min(lambdaMix, lambdaKin) * g;
      if (lambda < 1e-12) continue;

      // Both fuels burn at the shared rate (CO slower - see header), then
      // scale back together so O2 consumption stays within its own lambda
      // (the stoichiometric limitation the H2-only version had)
      let rH2 = ncg.H2 * lambda;
      let rCO = ncg.CO * lambda * HydrogenCombustionRateOperator.CO_RATE_FACTOR;
      const o2Demand = (rH2 + rCO) / 2;
      if (o2Demand > ncg.O2 * lambda) {
        const scale = ncg.O2 * lambda / o2Demand;
        rH2 *= scale;
        rCO *= scale;
      }
      if (rH2 <= 0 && rCO <= 0) continue;

      const nodeRates = rates.flowNodes.get(id) || { dMass: 0, dEnergy: 0 };
      if (!nodeRates.dNcg) nodeRates.dNcg = emptyGasComposition();
      nodeRates.dNcg.H2 -= rH2;
      nodeRates.dNcg.CO -= rCO;
      nodeRates.dNcg.CO2 += rCO;
      nodeRates.dNcg.O2 -= (rH2 + rCO) / 2;
      nodeRates.dMass += rH2 * HydrogenCombustionRateOperator.H2O_MOLAR_MASS;
      nodeRates.dEnergy += rH2 * HydrogenCombustionRateOperator.DELTA_U +
        rCO * HydrogenCombustionRateOperator.DELTA_U_CO;
      rates.flowNodes.set(id, nodeRates);
    }

    return rates;
  }

  /**
   * The burn itself is rate-capped at lambda_mix <= S_FLAME/V^(1/3); the
   * fastest case (a ~1 m^3 node, lambda ~3/s) needs dt below ~0.1 s for the
   * explicit integration of the depletion to stay well inside the stability
   * region. Same mechanism as the neutronics prompt-jump cap.
   */
  getMaxStableDt(state: SimulationState): number {
    for (const [, node] of state.flowNodes) {
      if (node.isBoundary || !node.fluid.ncg) continue;
      if ((node.fluid.ncg.H2 > 1e-3 || node.fluid.ncg.CO > 1e-3) &&
          node.fluid.ncg.O2 > 1e-3 && node.fluid.phase !== 'liquid') {
        return 0.1;
      }
    }
    return Infinity;
  }
}
