/**
 * McciRateOperator - molten core-concrete interaction (ex-vessel).
 *
 * Runs on `${coreId}-corium-ex` debris beds (created by the factory for
 * cores whose vessel stands inside a building; filled by the vessel-breach
 * pour in CoriumRelocationRateOperator). All terms are continuous rates -
 * no ignition/attack events.
 *
 * CONTACT AREA: like the in-vessel pool, the debris footprint is
 * mass-scaled - it spreads over the building floor until it is
 * SPREAD_DEPTH deep over the full footprint (a static full-floor coupling
 * on the 1 kg seed node would be a stiffness bomb).
 *
 * UPWARD HEAT TRANSFER (to the building flow node):
 * - Water quench while building water covers the floor: crust-limited
 *   h = 500 W/m2K, same debris-bed scale as the in-vessel quench (violent
 *   fuel-coolant interaction / steam explosions are not modeled).
 * - Dry surface: thermal radiation (eps 0.7) + weak gas convection to the
 *   building atmosphere. At 2000+ K radiation dominates, ~200 kW/m2.
 *
 * CONCRETE ABLATION (downward/sideward, lumped into one contact):
 *   Q_abl = h_abl * A * (T_debris - T_ablation)      for T > T_ablation
 *   dm_concrete/dt = Q_abl / H_decomposition
 * h_abl = 200 W/m2K across the crust/slag film gives ~100-300 kW/m2 at
 * typical melt superheats -> 10-20 cm/h early erosion, the CCI/SURC
 * experiment scale. H_decomp = 2.2 MJ/kg is the effective enthalpy to
 * heat, dehydrate, decarbonate, and melt generic structural concrete.
 * The decomposed mass splits into:
 * - slag oxides (stirred into the debris at T_ablation - the arrival
 *   mixing term is what dilutes and cools the melt over time), and
 * - gases: H2O (bound water) and CO2 (calcite), which sparge UP THROUGH
 *   the melt and oxidize its unoxidized metal inventory on the way:
 *     Zr + 2 H2O -> ZrO2 + 2 H2    (+293 kJ per mol H2O, vigorous)
 *     Zr + 2 CO2 -> ZrO2 + 2 CO    (+267 kJ per mol CO2)
 *     Fe +   H2O -> FeO  + H2      (+30 kJ per mol H2O, mild)
 *     Fe +   CO2 -> FeO  + CO      (-11 kJ per mol CO2, mildly endothermic)
 *   Zr reacts first (far more reactive); each metal's conversion fraction
 *   is a smooth function of how much remains (dilute metal in a mostly
 *   oxidic melt is less accessible to the gas). The oxygen taken up by the
 *   metal stays in the debris mass; H2/CO/CO2/steam vent to the building
 *   atmosphere, where the combustion operator can burn them.
 *
 * CONCRETE COMPOSITION: generic limestone/common-sand structural concrete
 * (5.5 wt% water, 21 wt% CO2). Siliceous concretes release ~10x less CO2 -
 * a per-building `concreteType` property can refine this later.
 *
 * BASEMAT INVENTORY: the `${buildingId}-basemat` node's mass covers the
 * structural basemat PLUS an equal notional layer of silicate ground, so
 * ablation continues smoothly after melt-through; the melt-through EVENT
 * (fired by BurstCheckOperator) triggers when the eroded depth passes the
 * structural thickness (basemat.characteristicLength). The remaining-mass
 * factor only matters if the whole inventory is consumed - it fades the
 * attack out smoothly instead of stepping to zero.
 */

import { SimulationState } from '../types';
import { RateOperator, StateRates, createZeroRates } from '../rk45-solver';
import { nodeHeatCapacity } from './rate-operators';
import { nodeLiquidLevel } from './control-system';
import { emptyGasComposition } from '../gas-properties';

// Generic structural concrete (limestone/common-sand)
export const CONCRETE_DENSITY = 2300;           // kg/m3
export const CONCRETE_H2O_FRACTION = 0.055;     // bound + evaporable water (mass)
export const CONCRETE_CO2_FRACTION = 0.21;      // calcite decarbonation (mass)
export const CONCRETE_DECOMPOSITION_ENTHALPY = 2.2e6; // J/kg (heat + dehydrate + decarbonate + melt)
export const CONCRETE_ABLATION_T = 1500;        // K - decomposition/ablation front

/** Debris spreads until this deep over the full floor (mass-scaled area) */
const SPREAD_DEPTH = 0.05;    // m
const DEBRIS_DENSITY = 7000;  // kg/m3 - oxide melt with slag

/** Mass-scaled contact footprint of a debris bed (see class header). */
export function debrisContactArea(debris: { mass: number; surfaceArea: number }): number {
  const depthIfSpread = debris.mass / (DEBRIS_DENSITY * debris.surfaceArea);
  return debris.surfaceArea * Math.min(1, depthIfSpread / SPREAD_DEPTH);
}

/**
 * Eroded basemat depth (m) for a building, from the basemat node's mass
 * deficit. Used by the melt-through check and displays.
 *
 * The ablation front is LOCALIZED under the debris pool, not spread over
 * the whole floor, so the deficit is averaged over the current contact
 * area of the building's debris beds. (Both grow together as the pool
 * spreads; a small pool eroding a small patch reads its true local depth.)
 */
export function basematErodedDepth(state: SimulationState, buildingId: string): number {
  const basemat = state.thermalNodes.get(`${buildingId}-basemat`);
  if (!basemat || !basemat.initialMass) return 0;
  const ablated = basemat.initialMass - basemat.mass;
  if (ablated <= 0) return 0;
  let contact = 0;
  for (const [id, node] of state.thermalNodes) {
    if (id.endsWith('-corium-ex') && node.associatedVesselNode === buildingId) {
      contact += debrisContactArea(node);
    }
  }
  const area = contact > 0
    ? Math.min(contact, basemat.surfaceArea)
    : basemat.surfaceArea; // no debris bed left to attribute it to
  return ablated / (CONCRETE_DENSITY * area);
}

const H2O_MOLAR = 0.018015;  // kg/mol
const CO2_MOLAR = 0.044009;
const ZR_MOLAR = 0.09122;
const FE_MOLAR = 0.055845;
const O_MOLAR = 0.015999;

export class McciRateOperator implements RateOperator {
  name = 'MCCI';

  /** Crust/slag-film-limited melt -> ablation front conductance */
  private static readonly H_ABLATION = 200;     // W/m2K
  /** Crusted debris bed -> overlying water (matches in-vessel quench) */
  private static readonly H_QUENCH = 500;       // W/m2K
  /** Dry debris surface -> building atmosphere */
  private static readonly EMISSIVITY = 0.7;
  private static readonly SIGMA = 5.67e-8;      // W/m2K4
  private static readonly H_GAS = 10;           // W/m2K natural convection
  /** Pre-ablation conduction into the cold slab (crust + ~10 cm concrete) */
  private static readonly H_CONDUCTION = 15;    // W/m2K

  // Reaction enthalpies per mol of GAS converted (see header)
  private static readonly DH_ZR_H2O = 293e3;    // J/mol H2O
  private static readonly DH_ZR_CO2 = 267e3;    // J/mol CO2
  private static readonly DH_FE_H2O = 30e3;     // J/mol H2O
  private static readonly DH_FE_CO2 = -11e3;    // J/mol CO2

  // Internal energy of steam leaving the ablation front (u_g(373 K) plus
  // superheat at cv ~ 1.6 kJ/kg-K). Part of the decomposition enthalpy the
  // debris already paid - NOT extra energy.
  private static readonly U_STEAM =
    2.51e6 + 1600 * (CONCRETE_ABLATION_T - 373); // J/kg

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const [debrisId, debris] of state.thermalNodes) {
      if (!debrisId.endsWith('-corium-ex')) continue;
      if (debris.mass <= 1.5) continue; // seed node - nothing has arrived yet

      const buildingId = debris.associatedVesselNode;
      const building = buildingId ? state.flowNodes.get(buildingId) : undefined;
      if (!building) {
        throw new Error(`[MCCI] Debris node ${debrisId} has no building flow node ` +
          `('${buildingId}') - factory wiring is broken`);
      }

      // Mass-scaled contact footprint (see header)
      const area = debrisContactArea(debris);
      if (area <= 0) continue;

      const C_debris = nodeHeatCapacity(debris);
      const debRates = rates.thermalNodes.get(debrisId) || { dTemperature: 0 };
      const bldRates = rates.flowNodes.get(buildingId!) || { dMass: 0, dEnergy: 0 };

      // ----------------------------------------------------------------
      // Upward heat transfer: quench under water, radiate when dry
      // ----------------------------------------------------------------
      let wet = 0;
      if (building.fluid.phase !== 'vapor') {
        const level = nodeLiquidLevel(building);
        wet = Math.min(1, level / 0.1);
      }
      if (wet > 0 && debris.temperature > building.fluid.temperature) {
        const Q = McciRateOperator.H_QUENCH * area * wet *
          (debris.temperature - building.fluid.temperature);
        debRates.dTemperature -= Q / C_debris;
        bldRates.dEnergy += Q;
      }
      if (wet < 1) {
        const Tg = building.fluid.temperature;
        const Td = debris.temperature;
        const Q = (1 - wet) * area * (
          McciRateOperator.EMISSIVITY * McciRateOperator.SIGMA *
            (Td * Td * Td * Td - Tg * Tg * Tg * Tg) +
          McciRateOperator.H_GAS * (Td - Tg)
        );
        debRates.dTemperature -= Q / C_debris;
        bldRates.dEnergy += Q;
      }

      // ----------------------------------------------------------------
      // Concrete attack
      // ----------------------------------------------------------------
      const basemat = state.thermalNodes.get(`${buildingId}-basemat`);
      if (basemat) {
        // Pre-ablation conduction warms the slab (large mass, slow)
        if (debris.temperature > basemat.temperature) {
          const Q = McciRateOperator.H_CONDUCTION * area *
            (debris.temperature - basemat.temperature);
          debRates.dTemperature -= Q / C_debris;
          const bmRates = rates.thermalNodes.get(basemat.id) || { dTemperature: 0 };
          bmRates.dTemperature += Q / nodeHeatCapacity(basemat);
          rates.thermalNodes.set(basemat.id, bmRates);
        }

        if (debris.temperature > CONCRETE_ABLATION_T && basemat.mass > 0) {
          // Fades smoothly if the whole (basemat + ground) inventory is
          // ever consumed; ~1 in any realistic run
          const bm0 = basemat.initialMass ?? basemat.mass;
          const supply = basemat.mass / (basemat.mass + 0.01 * bm0);

          const Q_abl = McciRateOperator.H_ABLATION * area *
            (debris.temperature - CONCRETE_ABLATION_T) * supply;
          const dmConcrete = Q_abl / CONCRETE_DECOMPOSITION_ENTHALPY; // kg/s

          debRates.dTemperature -= Q_abl / C_debris;
          const bmRates = rates.thermalNodes.get(basemat.id) || { dTemperature: 0 };
          bmRates.dMass = (bmRates.dMass ?? 0) - dmConcrete;
          rates.thermalNodes.set(basemat.id, bmRates);

          // Slag oxides stir into the melt at the ablation temperature
          // (the mixing term is the dilution cooling)
          const slagIn = dmConcrete *
            (1 - CONCRETE_H2O_FRACTION - CONCRETE_CO2_FRACTION);
          debRates.dMass = (debRates.dMass ?? 0) + slagIn;
          debRates.dSlag = (debRates.dSlag ?? 0) + slagIn;
          debRates.dTemperature += slagIn * debris.specificHeat *
            (CONCRETE_ABLATION_T - debris.temperature) / C_debris;

          // Decomposition gases sparge through the melt: metal oxidation
          const molH2O = dmConcrete * CONCRETE_H2O_FRACTION / H2O_MOLAR;
          const molCO2 = dmConcrete * CONCRETE_CO2_FRACTION / CO2_MOLAR;

          const mZr = debris.metal?.zr ?? 0;
          const mFe = debris.metal?.fe ?? 0;
          // Smooth accessibility: conversion approaches 1 while the metal
          // is a meaningful fraction of the melt, falls off as it dilutes
          const gZr = mZr / (mZr + 0.01 * debris.mass);
          const gFe = mFe / (mFe + 0.01 * debris.mass);

          const h2oToZr = molH2O * gZr;
          const h2oToFe = (molH2O - h2oToZr) * gFe;
          const co2ToZr = molCO2 * gZr;
          const co2ToFe = (molCO2 - co2ToZr) * gFe;

          const zrConsumed = (h2oToZr + co2ToZr) / 2 * ZR_MOLAR;  // kg/s
          const feConsumed = (h2oToFe + co2ToFe) * FE_MOLAR;
          const oUptake = (h2oToZr + h2oToFe + co2ToZr + co2ToFe) * O_MOLAR;
          if (zrConsumed > 0) debRates.dMetalZr = (debRates.dMetalZr ?? 0) - zrConsumed;
          if (feConsumed > 0) debRates.dMetalFe = (debRates.dMetalFe ?? 0) - feConsumed;
          // The metal keeps its oxygen: debris mass grows by the uptake
          debRates.dMass = (debRates.dMass ?? 0) + oUptake;

          const Q_chem =
            h2oToZr * McciRateOperator.DH_ZR_H2O +
            co2ToZr * McciRateOperator.DH_ZR_CO2 +
            h2oToFe * McciRateOperator.DH_FE_H2O +
            co2ToFe * McciRateOperator.DH_FE_CO2;
          debRates.dTemperature += Q_chem / C_debris;

          // Vent the gas mix to the building atmosphere at the ablation
          // temperature (its energy was paid out of H_decomp / Q_chem)
          const molH2 = h2oToZr + h2oToFe;
          const molCO = co2ToZr + co2ToFe;
          const steamOut = (molH2O - h2oToZr - h2oToFe) * H2O_MOLAR; // kg/s
          const co2Out = molCO2 - co2ToZr - co2ToFe;

          bldRates.dMass += steamOut;
          bldRates.dEnergy += steamOut * McciRateOperator.U_STEAM;
          if (!bldRates.dNcg) bldRates.dNcg = emptyGasComposition();
          bldRates.dNcg.H2 += molH2;
          bldRates.dNcg.CO += molCO;
          bldRates.dNcg.CO2 += co2Out;
          // NCG thermal energy at cv (mol basis): H2 20.5, CO 20.8, CO2 28.8
          bldRates.dEnergy += CONCRETE_ABLATION_T *
            (molH2 * 20.5 + molCO * 20.8 + co2Out * 28.8);
        }
      }

      rates.thermalNodes.set(debrisId, debRates);
      rates.flowNodes.set(buildingId!, bldRates);
    }

    return rates;
  }
}
