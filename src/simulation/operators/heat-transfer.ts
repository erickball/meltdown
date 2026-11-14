/**
 * Initial fluid state from declared conditions (T, P, phase, quality, NCG).
 *
 * This file used to hold the forward-Euler conduction / convection / fluid
 * state operators as well. The RK45 rate and constraint operators in
 * rate-operators.ts replaced them; only the state builder remains.
 */

import { FluidState } from '../types';
import * as Water from '../water-properties';
import { superheatedFromTP } from '../water-inverse';
import { vapourSpace } from '../mixture-properties';
import { type GasSpecies, emptyGasComposition, R_GAS, ALL_GAS_SPECIES, totalMoles, mixtureCv } from '../gas-properties';

/**
 * NCG initial condition as partial pressures in bar.
 * Used for specifying initial gas content in components.
 */
export interface NcgPartialPressures {
  N2?: number;   // bar
  O2?: number;
  H2?: number;
  He?: number;
  CO?: number;
  CO2?: number;
  Xe?: number;
  Ar?: number;
  CsI?: number;  // fission-product aerosol (never a sensible initial fill)
}

// ============================================================================
// Utility function to initialize fluid state from T, P, phase
// ============================================================================

/**
 * Create a FluidState from temperature, pressure, phase, and volume
 * Calculates mass and internal energy for the new energy-conserving formulation
 */
/**
 * Create a FluidState with proper density calculation for the given conditions.
 *
 * @param temperature - Temperature in Kelvin
 * @param pressure - Steam/water pressure in Pascals (NOT including NCG partial pressure)
 * @param phase - Phase of the fluid
 * @param quality - Vapor mass fraction (0-1, only meaningful for two-phase)
 * @param volume - Volume in m³
 * @param ncgPartialPressures - Optional NCG content as partial pressures in bar
 * @returns FluidState with calculated mass, energy, and optionally NCG moles
 */
export function createFluidState(
  temperature: number,
  pressure: number,
  phase: 'liquid' | 'two-phase' | 'vapor',
  quality: number,
  volume: number,
  ncgPartialPressures?: NcgPartialPressures
): FluidState {
  // Calculate density based on phase
  let density: number;

  if (phase === 'liquid') {
    // For compressed liquid, use steam table lookup to get the density that
    // corresponds exactly to this (P, u) point. This ensures dP_feedback = 0
    // at initialization, since the feedback model uses the same lookup.
    const u_specific = Water.energyFromTemperature(temperature, 'liquid', 0);
    const rho_table = Water.lookupCompressedLiquidDensity(pressure, u_specific);

    if (rho_table !== null) {
      // Use exact steam table density - this minimizes initial pressure feedback
      density = rho_table;
    } else {
      // Fallback to bulk modulus approximation if outside table range
      const rho_sat = Water.saturatedLiquidDensity(temperature);
      const P_sat = Water.saturationPressure(temperature);
      const T_C = temperature - 273.15;
      const K_physical = Water.bulkModulus(T_C);
      const dP = Math.max(0, pressure - P_sat);
      density = rho_sat * (1 + dP / K_physical);
    }
  } else if (phase === 'vapor') {
    // For vapor, use ideal gas with given pressure
    // ρ = P / (R * T), with R = 461.5 J/kg-K for water vapor
    const R_WATER = 461.5;
    density = pressure / (R_WATER * temperature);

    // Check if this is superheated steam (P < P_sat at this T)
    const P_sat = Water.saturationPressure(temperature);
    if (pressure < P_sat * 0.99) {
      // Superheated steam. Invert the steam tables for the (u, v) that
      // actually reads back as this (T, P) - see water-inverse.ts.
      //
      // The old closed form here was ideal-gas density plus
      //   u = u_g(T_sat(P)) + 1500*(T - T_sat(P))
      // which is the same crude caloric fit that used to sit in the NCG
      // mixture solve, and it is wrong by the same kind of margin: a node
      // declared "6 MPa, 700 K" was built with an energy whose temperature
      // reads back as 626 K. Every superheated node therefore started with a
      // ~70 K step that the solver had to absorb in the first milliseconds -
      // worse at high pressure, where steam is least ideal, which is exactly
      // where a once-through SG or a main steam line lives.
      let specificEnergy: number;
      const inverted = superheatedFromTP(temperature, pressure);
      if (inverted) {
        density = 1 / inverted.specificVolume;
        specificEnergy = inverted.specificEnergy;
      } else {
        // Fall back to the closed form, but SAY SO - a silent fallback here
        // reintroduces the initialization step it exists to avoid.
        const T_sat = Water.saturationTemperature(pressure);
        const u_sat_g = Water.saturatedVaporEnergy(T_sat);
        specificEnergy = u_sat_g + 1500 * (temperature - T_sat);
        console.warn(
          `[createFluidState] Could not invert the steam tables for superheated vapour at ` +
          `T=${temperature.toFixed(1)}K, P=${(pressure / 1e5).toFixed(3)}bar - falling back to the ` +
          `ideal-gas/linear-cv estimate. This node will start with a temperature step.`
        );
      }

      const mass = density * volume;
      const internalEnergy = mass * specificEnergy;

      // Create fluid state for superheated vapor
      const fluidState: FluidState = {
        mass,
        internalEnergy,
        temperature,
        pressure,
        phase,
        quality,
      };

      // Add NCG if specified (a gas-only node: the gas has the whole volume)
      fluidState.gasVolume = volume;
      if (ncgPartialPressures && Object.keys(ncgPartialPressures).length > 0) {
        const ncg = emptyGasComposition();
        let hasNcg = false;
        let totalNcgPressure = 0; // Pa

        for (const species of ALL_GAS_SPECIES) {
          const P_bar = ncgPartialPressures[species as GasSpecies];
          if (P_bar && P_bar > 0) {
            const P_Pa = P_bar * 1e5; // bar to Pa
            // n = PV / RT
            const moles = (P_Pa * volume) / (R_GAS * temperature);
            ncg[species as GasSpecies] = moles;
            totalNcgPressure += P_Pa;
            hasNcg = true;
          }
        }

        if (hasNcg) {
          fluidState.ncg = ncg;
          // Add NCG partial pressure to total pressure (Dalton's law)
          fluidState.pressure += totalNcgPressure;
          // Add NCG internal energy: U_ncg = n * Cv * T
          // This is crucial - without it, subtracting NCG energy later would go negative
          const ncgMoles = totalMoles(ncg);
          const Cv_ncg = mixtureCv(ncg);
          fluidState.internalEnergy += ncgMoles * Cv_ncg * temperature;
        }
      }

      return fluidState;
    }
  } else {
    // Two-phase mixture - pressure is locked to saturation
    const rho_f = Water.saturatedLiquidDensity(temperature);
    const rho_g = Water.saturatedVaporDensity(temperature);
    density = 1 / (quality / rho_g + (1 - quality) / rho_f);
  }

  const mass = density * volume;
  const specificEnergy = Water.energyFromTemperature(temperature, phase, quality);
  const internalEnergy = mass * specificEnergy;

  // Create base fluid state
  const fluidState: FluidState = {
    mass,
    internalEnergy,
    temperature,
    pressure,
    phase,
    quality,
  };

  // The room the gas has: what the liquid leaves it. A declared partial
  // pressure means that pressure IN THAT ROOM, so the moles follow from the
  // vapour space, not the node - a 78%-full tank with "0.79 bar of N2" holds
  // 0.79 bar of N2 over its water, and a liquid-full node with a gas partial
  // holds only the little the gas can squeeze room for (see vapourSpace).
  const liquidMass = phase === 'vapor' ? 0 : mass * (1 - Math.max(0, Math.min(1, phase === 'liquid' ? 0 : quality)));
  const liquidVolume0 = liquidMass > 0 ? liquidMass / Water.saturatedLiquidDensity(temperature) : 0;
  fluidState.gasVolume = vapourSpace(liquidVolume0, volume, 0, temperature);

  // Add NCG if specified
  if (ncgPartialPressures && Object.keys(ncgPartialPressures).length > 0) {
    // Convert partial pressures (bar) to moles using ideal gas law over the
    // vapour space: n = P V_gas / RT. The gas's own pressure opens a little
    // more room by compressing the liquid (V_gas = free + V_liq0 P_gas / K,
    // the same balance vapourSpace solves the other way round).
    const ncg = emptyGasComposition();
    let hasNcg = false;
    let totalNcgPressure = 0; // Pa
    for (const species of ALL_GAS_SPECIES) {
      const P_bar = ncgPartialPressures[species as GasSpecies];
      if (P_bar && P_bar > 0) totalNcgPressure += P_bar * 1e5;
    }
    const free = Math.max(0, volume - liquidVolume0);
    const gasVolume = liquidVolume0 > 0
      ? free + liquidVolume0 * totalNcgPressure / Water.bulkModulus(temperature - 273.15)
      : volume;
    totalNcgPressure = 0;

    for (const species of ALL_GAS_SPECIES) {
      const P_bar = ncgPartialPressures[species as GasSpecies];
      if (P_bar && P_bar > 0) {
        const P_Pa = P_bar * 1e5; // bar to Pa
        const moles = (P_Pa * gasVolume) / (R_GAS * temperature);
        ncg[species as GasSpecies] = moles;
        totalNcgPressure += P_Pa;
        hasNcg = true;
      }
    }

    if (hasNcg) {
      fluidState.ncg = ncg;
      fluidState.gasVolume = gasVolume;
      // Add NCG partial pressure to total pressure (Dalton's law)
      // This makes the pressure field consistent with what constraint operator expects
      fluidState.pressure += totalNcgPressure;
      // Add NCG internal energy: U_ncg = n * Cv * T
      // This is crucial - without it, subtracting NCG energy later would go negative
      const ncgMoles = totalMoles(ncg);
      const Cv_ncg = mixtureCv(ncg);
      fluidState.internalEnergy += ncgMoles * Cv_ncg * temperature;
    }
  }

  return fluidState;
}
