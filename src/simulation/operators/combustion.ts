/**
 * HydrogenCombustionRateOperator - continuous-rate hydrogen burning.
 *
 * 2 H2 + O2 -> 2 H2O(g), 240 kJ per mol H2 (constant-volume, vapor product).
 *
 * MODEL: one continuous rate equation per node, no discrete ignition event.
 *
 *   R (mol H2/s) = n_H2 * lambda,   lambda = min(lambda_kin, lambda_mix * g)
 *
 * - lambda_kin: CHAIN-BRANCHING kinetics. Whether hydrogen can ignite at all
 *   is decided by a competition for the chain carrier H:
 *
 *       branching     H + O2      -> OH + O      k1
 *       termination   H + O2 + M  -> HO2 + M     k5   (M = any third body)
 *
 *   Following the cycle through (O + H2 -> OH + H, OH + H2 -> H2O + H) one H
 *   goes in and three come out, so branching nets +2 carriers while
 *   termination nets -1. The radical pool therefore grows at
 *
 *       alpha = (2*k1 - k5*[M]) * [O2]        (1/s)
 *
 *   and its SIGN is the ignition threshold - the classic second explosion
 *   limit. Below it every H atom is quenched in microseconds and the mixture
 *   is inert no matter how long you wait; above it the pool multiplies and
 *   ignition follows after an induction time ~ ln(N)/alpha. At 1 bar the two
 *   terms cross within 0.2% of each other at ~924 K, and alpha swings from
 *   -1.2e5 to +1.5e5 /s across 850-1000 K. That is where the practical
 *   threshold comes from: a sign change, not a steep slope.
 *
 *   This replaced a single global Arrhenius (A0*exp(-Ta/T), A0=1e6, Ta=12000).
 *   That form is smooth by construction and cannot be both inert at 620 K and
 *   prompt at 850 K - it only moves 188x across that span where ~1e6 is
 *   needed - so a 2% H2 mixture at 620 K oxidised 38% in two minutes.
 *
 *   Two things fall out that used to be hand-placed:
 *     * OXYGEN STARVATION: alpha carries [O2] directly.
 *     * STEAM INERTING: water is a ~12x more efficient third body than N2 for
 *       the termination step, so a steam-rich gas space raises k5*[M] and
 *       drives alpha negative on its own.
 *
 *   SCOPE: this is the SECOND explosion limit only. Above a few bar there is a
 *   third limit where HO2 stops being a dead end (HO2 + H2 -> H2O2 + H, then
 *   H2O2 -> 2 OH) and ignition reopens by a different route. Deliberately not
 *   modelled - agreed with Erick that hydrogen ignition inside a pressurised
 *   primary is not a scenario of interest. Containment (1-5 bar) is squarely
 *   second-limit territory. If that ever changes, this is the gap.
 *
 * - The "pilot" contribution evaluates the same criterion at the hottest solid
 *   surface wetted by the node's gas, coupled through a small kernel volume
 *   fraction: a hot wall lights the gas next to it, the released heat raises
 *   the bulk temperature, and once the BULK crosses its own threshold the bulk
 *   term takes over. Ignition still EMERGES as thermal runaway rather than
 *   being a coded event - it just now runs away off a real threshold.
 * - lambda_mix = S_FLAME / V^(1/3): once burning, the rate is limited by
 *   flame propagation across the node (turbulent flame speed ~3 m/s over
 *   the node's linear scale), not by kinetics - a containment-sized volume
 *   deflagrates over tens of seconds, a small vessel in ~a second. This is
 *   the physical rate cap that keeps the burn resolvable.
 * - g: the flammability envelope, applied to the PROPAGATION term only. A
 *   lower flammability limit is a statement about whether a flame front can
 *   sustain itself against its own heat loss - it is not a statement about
 *   kinetics, and multiplying the kinetic term by it (as this used to) both
 *   double-counted the composition and left a fat tail: the logistic still
 *   passes 8% of the rate at 39% of the LFL.
 *
 *   The steam term in g is NOT a double-count of the third-body effect above.
 *   They are different physics on different questions: third-body efficiency
 *   decides whether the chain can branch (ignition), while steam's thermal
 *   ballast decides whether a front can propagate once lit. The empirical 55%
 *   figure is a propagation limit, so it belongs here. Reassuringly the two
 *   agree in magnitude - 55% steam raises the branching crossover by ~172 K.
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

// ---------------------------------------------------------------------------
// Chain-branching rate constants (cm3/mol/s and cm6/mol2/s, T in K)
// ---------------------------------------------------------------------------
/** H + O2 -> OH + O  (branching). Ea ~ 71 kJ/mol. */
function kBranch(T: number): number {
  return 3.52e16 * Math.pow(T, -0.7) * Math.exp(-8590 / T);
}
/** H + O2 + M -> HO2 + M  (termination), for M = N2. Species efficiencies
 *  are applied to the concentration, not here.
 *
 *  The prefactor is calibrated so that 2*kBranch = kTerminate*[M] lands the
 *  second explosion limit at ~855 K in dry air at 1 atm, which is where it is
 *  measured. Published low-pressure-limit values for M = N2 scatter by a
 *  factor of ~2-3 either side of this; the un-calibrated Troe form put the
 *  crossover at 920 K, i.e. the model would have been ~65 K MORE reluctant to
 *  ignite than reality - the wrong direction to err in a safety sandbox. */
function kTerminate(T: number): number {
  return 2.90e19 * Math.pow(T, -1.42);
}

/**
 * Third-body efficiency for H + O2 + M -> HO2 + M, relative to N2 = 1.
 *
 * These are why steam inerting is not a separate rule: water is an order of
 * magnitude better than nitrogen at carrying off the collision energy, so a
 * steam-rich gas space quenches the chain on its own.
 */
const THIRD_BODY_EFFICIENCY: Record<string, number> = {
  H2O: 12,    // steam - the reason steam inerts
  CO2: 3.8,
  H2: 2.5,
  CO: 1.9,
  N2: 1.0,
  O2: 0.78,
  Ar: 0.5,
  He: 0.5,
  Xe: 0.5,
  CsI: 1.0,   // aerosol trace; efficiency immaterial at its concentrations
};

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
  /** Radical amplification needed to go from a seed concentration to a burn:
   *  the induction time is ln(N)/alpha, and e^23 ~ 1e10 is the usual order for
   *  the pool growth required. Converts the branching growth rate into a
   *  first-order consumption rate. */
  private static readonly LN_AMPLIFICATION = 23;
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

      // --- Ignition kinetics: chain-branching criterion --------------------
      // Concentrations in mol/cm3 (the rate constants' units).
      const volumeCm3 = node.volume * 1e6;
      const cO2 = ncg.O2 / volumeCm3;
      // Effective third-body concentration: every species weighted by how
      // well it carries off the termination collision, steam included.
      let cThirdBody = steamMoles * THIRD_BODY_EFFICIENCY.H2O / volumeCm3;
      for (const species of Object.keys(THIRD_BODY_EFFICIENCY)) {
        const n = (ncg as unknown as Record<string, number>)[species];
        if (n && n > 0) cThirdBody += (n * THIRD_BODY_EFFICIENCY[species]) / volumeCm3;
      }

      /** Radical-pool growth rate (1/s) at temperature T. Negative means the
       *  chain dies out: no ignition, on any timescale. */
      const growthRate = (T: number): number =>
        (2 * kBranch(T) - kTerminate(T) * cThirdBody) * cO2;

      // Bulk gas. Below the crossover this is exactly zero - the honest
      // statement that a sub-second-limit mixture does not ignite. (The slow
      // HO2-mediated oxidation that does proceed is negligible at these
      // temperatures, which is the whole content of the second limit.)
      let lambdaKin = Math.max(0, growthRate(node.fluid.temperature)) /
        HydrogenCombustionRateOperator.LN_AMPLIFICATION;

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
      if (hotSurfaceT > node.fluid.temperature) {
        // The kernel of gas against the hot surface sits at the surface
        // temperature and can be over the threshold while the bulk is not.
        lambdaKin += HydrogenCombustionRateOperator.PILOT_COUPLING *
          Math.max(0, growthRate(hotSurfaceT)) /
          HydrogenCombustionRateOperator.LN_AMPLIFICATION;
      }

      // --- Propagation (mixing) cap ---------------------------------------
      // g gates PROPAGATION, not kinetics: the flammability limits say whether
      // a flame front can sustain itself, which is a different question from
      // whether the chain branches.
      const lambdaMix = HydrogenCombustionRateOperator.S_FLAME / Math.cbrt(node.volume);

      const lambda = Math.min(lambdaKin, lambdaMix * g);
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
