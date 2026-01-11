/**
 * Gas Properties Module
 *
 * Provides thermodynamic properties and utility functions for non-condensible gases (NCGs).
 * These gases can accumulate in containment, accumulators, or leak into the primary system.
 *
 * Species supported:
 * - N₂ (nitrogen) - air component, inert blanket gas
 * - O₂ (oxygen) - air component
 * - H₂ (hydrogen) - from cladding oxidation, radiolysis
 * - He (helium) - advanced reactor coolant, cover gas
 * - CO (carbon monite) - from MCCI
 * - CO₂ (carbon dioxide) - advanced reactor coolant, from MCCI
 * - Xe (xenon) - fission product gas
 * - Ar (argon) - inert cover gas
 */

// ============================================================================
// Gas Species and Composition Types
// ============================================================================

/**
 * Gas species identifiers.
 * Each species has distinct thermodynamic properties.
 */
export type GasSpecies = 'N2' | 'O2' | 'H2' | 'He' | 'CO' | 'CO2' | 'Xe' | 'Ar';

/**
 * All supported gas species in order.
 */
export const ALL_GAS_SPECIES: readonly GasSpecies[] = ['N2', 'O2', 'H2', 'He', 'CO', 'CO2', 'Xe', 'Ar'] as const;

/**
 * Gas composition - moles of each species present.
 * Using moles (not mass) simplifies ideal gas law calculations.
 */
export interface GasComposition {
  N2: number;   // mol - nitrogen
  O2: number;   // mol - oxygen
  H2: number;   // mol - hydrogen
  He: number;   // mol - helium
  CO: number;   // mol - carbon monoxide
  CO2: number;  // mol - carbon dioxide
  Xe: number;   // mol - xenon
  Ar: number;   // mol - argon
}

/**
 * Create an empty gas composition (all zeros).
 */
export function emptyGasComposition(): GasComposition {
  return {
    N2: 0,
    O2: 0,
    H2: 0,
    He: 0,
    CO: 0,
    CO2: 0,
    Xe: 0,
    Ar: 0
  };
}

/**
 * Create a gas composition with specified amounts, defaulting others to zero.
 */
export function createGasComposition(partial: Partial<GasComposition>): GasComposition {
  return { ...emptyGasComposition(), ...partial };
}

/**
 * Clone a gas composition.
 */
export function cloneGasComposition(comp: GasComposition): GasComposition {
  return { ...comp };
}

// ============================================================================
// Gas Properties Data
// ============================================================================

/**
 * Physical properties for each gas species.
 */
export interface GasPropertyData {
  /** Molecular weight in kg/mol */
  molecularWeight: number;
  /** Specific heat at constant pressure (Cp) in J/(mol·K) at ~300K */
  cp: number;
  /** Specific heat at constant volume (Cv) in J/(mol·K) at ~300K */
  cv: number;
  /** Heat capacity ratio γ = Cp/Cv */
  gamma: number;
  /** Display color for rendering (CSS color string) */
  color: string;
  /** Human-readable name */
  name: string;
  /** Chemical formula for display */
  formula: string;
}

/**
 * Gas properties table.
 * Cp and Cv values are approximate at ~300K and 1 atm.
 * For accurate high-temperature calculations, temperature-dependent correlations
 * should be used, but these are sufficient for initial implementation.
 */
export const GAS_PROPERTIES: Record<GasSpecies, GasPropertyData> = {
  N2: {
    molecularWeight: 0.028014,  // kg/mol
    cp: 29.12,                  // J/(mol·K)
    cv: 20.81,                  // J/(mol·K)
    gamma: 1.40,
    color: '#b8b8c8',           // pale gray with slight blue tint
    name: 'Nitrogen',
    formula: 'N₂'
  },
  O2: {
    molecularWeight: 0.032,     // kg/mol
    cp: 29.38,                  // J/(mol·K)
    cv: 21.07,                  // J/(mol·K)
    gamma: 1.39,
    color: '#d05050',           // red
    name: 'Oxygen',
    formula: 'O₂'
  },
  H2: {
    molecularWeight: 0.002016,  // kg/mol
    cp: 28.84,                  // J/(mol·K)
    cv: 20.52,                  // J/(mol·K)
    gamma: 1.41,
    color: '#80c080',           // green
    name: 'Hydrogen',
    formula: 'H₂'
  },
  He: {
    molecularWeight: 0.004003,  // kg/mol
    cp: 20.79,                  // J/(mol·K) - monatomic, Cp = 5/2 R
    cv: 12.47,                  // J/(mol·K) - monatomic, Cv = 3/2 R
    gamma: 1.67,                // monatomic
    color: '#c080c0',           // purple
    name: 'Helium',
    formula: 'He'
  },
  CO: {
    molecularWeight: 0.028010,  // kg/mol
    cp: 29.14,                  // J/(mol·K)
    cv: 20.83,                  // J/(mol·K)
    gamma: 1.40,
    color: '#404040',           // dark gray (almost black)
    name: 'Carbon Monoxide',
    formula: 'CO'
  },
  CO2: {
    molecularWeight: 0.044009,  // kg/mol
    cp: 37.11,                  // J/(mol·K) - triatomic, higher
    cv: 28.80,                  // J/(mol·K)
    gamma: 1.29,                // lower for polyatomic
    color: '#808080',           // medium gray
    name: 'Carbon Dioxide',
    formula: 'CO₂'
  },
  Xe: {
    molecularWeight: 0.131293,  // kg/mol
    cp: 20.79,                  // J/(mol·K) - monatomic
    cv: 12.47,                  // J/(mol·K)
    gamma: 1.67,                // monatomic
    color: '#a0a0d0',           // light blue-gray
    name: 'Xenon',
    formula: 'Xe'
  },
  Ar: {
    molecularWeight: 0.039948,  // kg/mol
    cp: 20.79,                  // J/(mol·K) - monatomic
    cv: 12.47,                  // J/(mol·K)
    gamma: 1.67,                // monatomic
    color: '#d0a0d0',           // light purple
    name: 'Argon',
    formula: 'Ar'
  }
};

// ============================================================================
// Universal Gas Constant
// ============================================================================

/** Universal gas constant in J/(mol·K) */
export const R_GAS = 8.31446;

// ============================================================================
// Gas Composition Calculations
// ============================================================================

/**
 * Get the total number of moles in a gas composition.
 */
export function totalMoles(comp: GasComposition): number {
  let sum = 0;
  for (const species of ALL_GAS_SPECIES) {
    sum += comp[species];
  }
  return sum;
}

/**
 * Get the mole fraction of a specific species.
 * Returns 0 if total moles is 0.
 */
export function moleFraction(comp: GasComposition, species: GasSpecies): number {
  const total = totalMoles(comp);
  if (total <= 0) return 0;
  return comp[species] / total;
}

/**
 * Get mole fractions for all species.
 */
export function allMoleFractions(comp: GasComposition): Record<GasSpecies, number> {
  const total = totalMoles(comp);
  const fractions: Partial<Record<GasSpecies, number>> = {};
  for (const species of ALL_GAS_SPECIES) {
    fractions[species] = total > 0 ? comp[species] / total : 0;
  }
  return fractions as Record<GasSpecies, number>;
}

/**
 * Get the total mass of a gas composition in kg.
 */
export function totalMass(comp: GasComposition): number {
  let mass = 0;
  for (const species of ALL_GAS_SPECIES) {
    mass += comp[species] * GAS_PROPERTIES[species].molecularWeight;
  }
  return mass;
}

/**
 * Get the average molecular weight of the mixture in kg/mol.
 * Returns 0 if no gas present.
 */
export function averageMolecularWeight(comp: GasComposition): number {
  const total = totalMoles(comp);
  if (total <= 0) return 0;
  return totalMass(comp) / total;
}

/**
 * Get the mixture Cp in J/(mol·K) using mole-fraction weighting.
 */
export function mixtureCp(comp: GasComposition): number {
  const total = totalMoles(comp);
  if (total <= 0) return 0;

  let cpSum = 0;
  for (const species of ALL_GAS_SPECIES) {
    cpSum += comp[species] * GAS_PROPERTIES[species].cp;
  }
  return cpSum / total;
}

/**
 * Get the mixture Cv in J/(mol·K) using mole-fraction weighting.
 */
export function mixtureCv(comp: GasComposition): number {
  const total = totalMoles(comp);
  if (total <= 0) return 0;

  let cvSum = 0;
  for (const species of ALL_GAS_SPECIES) {
    cvSum += comp[species] * GAS_PROPERTIES[species].cv;
  }
  return cvSum / total;
}

/**
 * Get the mixture gamma (Cp/Cv) using mole-fraction weighting.
 */
export function mixtureGamma(comp: GasComposition): number {
  const cp = mixtureCp(comp);
  const cv = mixtureCv(comp);
  if (cv <= 0) return 1.4;  // Default to air-like value
  return cp / cv;
}

/**
 * Calculate sound speed in an NCG mixture (no steam).
 * c = sqrt(gamma * R * T / M)
 *
 * For ideal gas mixtures, sound speed depends on:
 * - gamma (Cp/Cv) of the mixture
 * - Temperature
 * - Average molecular weight of the mixture
 *
 * @param comp - Gas composition (moles)
 * @param T_K - Temperature in Kelvin
 * @returns Sound speed in m/s
 */
export function ncgSoundSpeed(comp: GasComposition, T_K: number): number {
  const total = totalMoles(comp);
  if (total <= 0) return 340;  // Default to air at room temp

  const gamma = mixtureGamma(comp);
  const M_avg = averageMolecularWeight(comp);  // kg/mol

  // c = sqrt(gamma * R * T / M)
  return Math.sqrt(gamma * R_GAS * T_K / M_avg);
}

/**
 * Calculate sound speed in a steam + NCG mixture.
 *
 * For a mixture of steam and NCG, we treat them as an ideal gas mixture
 * and calculate the effective gamma and molecular weight.
 *
 * @param ncg - NCG composition (moles)
 * @param steamMoles - Moles of steam in the mixture
 * @param T_K - Temperature in Kelvin
 * @returns Sound speed in m/s
 */
export function steamNcgSoundSpeed(ncg: GasComposition, steamMoles: number, T_K: number): number {
  const ncgMoles = totalMoles(ncg);
  const totalMol = ncgMoles + steamMoles;

  if (totalMol <= 0) return 400;  // Default to steam-like

  // Steam properties (approximate)
  const M_steam = 0.018015;  // kg/mol
  // Steam gamma varies with temperature, ~1.33 at low T, ~1.13 near critical
  const T_ratio = Math.min(1, Math.max(0, (T_K - 373) / (647 - 373)));
  const gamma_steam = 1.33 - 0.20 * T_ratio;
  // Steam Cp ≈ 37 J/(mol·K) at low pressure
  const cp_steam = 37;
  const cv_steam = cp_steam / gamma_steam;

  // Calculate mixture properties
  const steamFrac = steamMoles / totalMol;
  const ncgFrac = ncgMoles / totalMol;

  // Mole-weighted average molecular weight
  const M_ncg = ncgMoles > 0 ? averageMolecularWeight(ncg) : 0.029;  // Default to air M
  const M_mix = steamFrac * M_steam + ncgFrac * M_ncg;

  // Mole-weighted Cp and Cv
  const cp_ncg = ncgMoles > 0 ? mixtureCp(ncg) : 29;  // Default to N2
  const cv_ncg = ncgMoles > 0 ? mixtureCv(ncg) : 21;

  const cp_mix = steamFrac * cp_steam + ncgFrac * cp_ncg;
  const cv_mix = steamFrac * cv_steam + ncgFrac * cv_ncg;
  const gamma_mix = cp_mix / cv_mix;

  // c = sqrt(gamma * R * T / M)
  return Math.sqrt(gamma_mix * R_GAS * T_K / M_mix);
}

// ============================================================================
// Ideal Gas Law Calculations
// ============================================================================

/**
 * Calculate total NCG partial pressure using ideal gas law.
 * P_ncg = n_total * R * T / V
 *
 * @param comp - Gas composition (moles)
 * @param T_K - Temperature in Kelvin
 * @param V_m3 - Volume in cubic meters
 * @returns Partial pressure in Pa
 */
export function ncgPartialPressure(comp: GasComposition, T_K: number, V_m3: number): number {
  if (V_m3 <= 0) return 0;
  const n = totalMoles(comp);
  return n * R_GAS * T_K / V_m3;
}

/**
 * Calculate partial pressure of a specific species.
 * P_i = x_i * P_total = n_i * R * T / V
 *
 * @param comp - Gas composition (moles)
 * @param species - Which gas species
 * @param T_K - Temperature in Kelvin
 * @param V_m3 - Volume in cubic meters
 * @returns Partial pressure of species in Pa
 */
export function speciesPartialPressure(
  comp: GasComposition,
  species: GasSpecies,
  T_K: number,
  V_m3: number
): number {
  if (V_m3 <= 0) return 0;
  return comp[species] * R_GAS * T_K / V_m3;
}

/**
 * Calculate NCG density from composition, temperature, and pressure.
 * Uses ideal gas law: ρ = P * M_avg / (R * T)
 *
 * @param comp - Gas composition
 * @param T_K - Temperature in Kelvin
 * @param P_Pa - Pressure in Pa
 * @returns Density in kg/m³
 */
export function ncgDensity(comp: GasComposition, T_K: number, P_Pa: number): number {
  const M = averageMolecularWeight(comp);
  if (M <= 0 || T_K <= 0) return 0;
  return P_Pa * M / (R_GAS * T_K);
}

// ============================================================================
// Hydrogen Flammability
// ============================================================================

/**
 * Flammability status for hydrogen-containing atmospheres.
 */
export type FlammabilityStatus = 'safe' | 'flammable' | 'detonable';

/**
 * Hydrogen flammability limits in air (volume/mole fraction).
 * Note: Steam dilutes flammability, high pressure increases it.
 * These are simplified limits for normal conditions.
 */
export const H2_FLAMMABILITY = {
  /** Lower flammability limit in dry air */
  lowerLimit: 0.04,         // 4% H₂
  /** Upper flammability limit in dry air */
  upperLimit: 0.75,         // 75% H₂
  /** Detonation threshold (roughly) */
  detonationLimit: 0.15,    // 15% H₂
  /** Steam inerting threshold - above this steam fraction, not flammable */
  steamInertingLimit: 0.55  // 55% steam
};

/**
 * Evaluate hydrogen flammability in a gas mixture.
 *
 * Simplified model:
 * - If steam fraction > 55%, mixture is inerted (safe)
 * - If H₂ < 4%, safe
 * - If 4% <= H₂ < 7%, flammable warning threshold (we'll use 7% as the display threshold per user request)
 * - If 7% <= H₂ < 15%, flammable
 * - If H₂ >= 15%, detonable
 *
 * @param comp - NCG composition
 * @param steamMoleFraction - Mole fraction of steam in total atmosphere (0-1)
 * @param pressure_Pa - Total pressure (higher pressure lowers limits slightly)
 * @returns Flammability status
 */
export function evaluateFlammability(
  comp: GasComposition,
  steamMoleFraction: number = 0,
  pressure_Pa: number = 101325
): FlammabilityStatus {
  // Check steam inerting
  if (steamMoleFraction >= H2_FLAMMABILITY.steamInertingLimit) {
    return 'safe';
  }

  // Calculate H₂ mole fraction in the NCG mixture
  const total = totalMoles(comp);
  if (total <= 0) return 'safe';

  const h2Fraction = comp.H2 / total;

  // Need oxygen present for combustion - check O₂ fraction
  const o2Fraction = comp.O2 / total;
  if (o2Fraction < 0.05) {
    // Less than 5% O₂ - limiting oxidizer
    return 'safe';
  }

  // Pressure correction factor (simplified - higher pressure lowers limits)
  // At 2 bar, limits are ~10% lower; at 10 bar, ~30% lower
  const pressureRatio = pressure_Pa / 101325;
  const pressureFactor = Math.max(0.7, 1 - 0.03 * (pressureRatio - 1));

  // Apply steam dilution factor (linear reduction)
  const steamFactor = 1 - steamMoleFraction / H2_FLAMMABILITY.steamInertingLimit;

  // Effective H₂ fraction for flammability evaluation
  const effectiveH2 = h2Fraction / (pressureFactor * steamFactor);

  // User-specified thresholds: 7% flammable, 15% detonable
  if (effectiveH2 >= 0.15) {
    return 'detonable';
  } else if (effectiveH2 >= 0.07) {
    return 'flammable';
  }

  return 'safe';
}

/**
 * Get the hydrogen mole fraction as a percentage.
 * Useful for display purposes.
 */
export function hydrogenPercentage(comp: GasComposition): number {
  const total = totalMoles(comp);
  if (total <= 0) return 0;
  return (comp.H2 / total) * 100;
}

// ============================================================================
// Air Composition
// ============================================================================

/**
 * Standard dry air composition (mole fractions).
 */
export const DRY_AIR_COMPOSITION = {
  N2: 0.7808,
  O2: 0.2095,
  Ar: 0.0093,
  CO2: 0.0004
  // Other trace gases ignored
};

/**
 * Create a gas composition representing dry air with specified total moles.
 */
export function createAirComposition(totalMol: number): GasComposition {
  return createGasComposition({
    N2: totalMol * DRY_AIR_COMPOSITION.N2,
    O2: totalMol * DRY_AIR_COMPOSITION.O2,
    Ar: totalMol * DRY_AIR_COMPOSITION.Ar,
    CO2: totalMol * DRY_AIR_COMPOSITION.CO2
  });
}

/**
 * Calculate moles of air from P, V, T using ideal gas law.
 * n = PV / RT
 */
export function molesFromPVT(P_Pa: number, V_m3: number, T_K: number): number {
  if (T_K <= 0 || V_m3 <= 0) return 0;
  return (P_Pa * V_m3) / (R_GAS * T_K);
}

// ============================================================================
// Composition Arithmetic
// ============================================================================

/**
 * Add two gas compositions together.
 */
export function addCompositions(a: GasComposition, b: GasComposition): GasComposition {
  const result = emptyGasComposition();
  for (const species of ALL_GAS_SPECIES) {
    result[species] = a[species] + b[species];
  }
  return result;
}

/**
 * Subtract composition b from a (clamped to non-negative).
 */
export function subtractCompositions(a: GasComposition, b: GasComposition): GasComposition {
  const result = emptyGasComposition();
  for (const species of ALL_GAS_SPECIES) {
    result[species] = Math.max(0, a[species] - b[species]);
  }
  return result;
}

/**
 * Scale a gas composition by a factor.
 */
export function scaleComposition(comp: GasComposition, factor: number): GasComposition {
  const result = emptyGasComposition();
  for (const species of ALL_GAS_SPECIES) {
    result[species] = comp[species] * factor;
  }
  return result;
}

/**
 * Check if a composition is effectively empty (total moles < threshold).
 */
export function isCompositionEmpty(comp: GasComposition, threshold: number = 1e-10): boolean {
  return totalMoles(comp) < threshold;
}

// ============================================================================
// Display Helpers
// ============================================================================

/**
 * Get the dominant color for rendering a gas mixture.
 * Uses mole-fraction weighted blending.
 */
export function mixedGasColor(comp: GasComposition): string {
  const total = totalMoles(comp);
  if (total <= 0) return 'transparent';

  // Parse colors and blend by mole fraction
  let r = 0, g = 0, b = 0;

  for (const species of ALL_GAS_SPECIES) {
    const fraction = comp[species] / total;
    if (fraction <= 0) continue;

    const color = GAS_PROPERTIES[species].color;
    // Parse hex color #RRGGBB
    const parsed = parseInt(color.slice(1), 16);
    r += ((parsed >> 16) & 0xFF) * fraction;
    g += ((parsed >> 8) & 0xFF) * fraction;
    b += (parsed & 0xFF) * fraction;
  }

  const rHex = Math.round(r).toString(16).padStart(2, '0');
  const gHex = Math.round(g).toString(16).padStart(2, '0');
  const bHex = Math.round(b).toString(16).padStart(2, '0');

  return `#${rHex}${gHex}${bHex}`;
}

/**
 * Get a text summary of the composition for display.
 * Only shows species with > 0.1% mole fraction.
 */
export function compositionSummary(comp: GasComposition): string {
  const total = totalMoles(comp);
  if (total <= 0) return 'No NCG';

  const parts: string[] = [];
  for (const species of ALL_GAS_SPECIES) {
    const fraction = comp[species] / total;
    if (fraction >= 0.001) {  // > 0.1%
      const pct = (fraction * 100).toFixed(1);
      parts.push(`${GAS_PROPERTIES[species].formula}: ${pct}%`);
    }
  }

  return parts.length > 0 ? parts.join(', ') : 'Trace NCG';
}
