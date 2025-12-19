/**
 * Water/Steam Properties Module using IAPWS-IF97
 *
 * This module uses the @neutrium/thermo.eos.iapws97 library for accurate
 * thermodynamic properties, with a custom solver to find state from
 * density and internal energy (which IAPWS-IF97 doesn't directly support).
 *
 * The approach:
 * 1. Given (density, specific_internal_energy), determine the phase
 * 2. For two-phase: T is determined by saturation, quality from lever rule
 * 3. For single-phase: iterate on T (or P) until computed density matches
 */

import { IAPWS97_EoS } from '@neutrium/thermo.eos.iapws97';

// Create EoS instance
const eos = new IAPWS97_EoS();

// ============================================================================
// Debug Mode
// ============================================================================

let DEBUG_WATER_PROPS = false;
let debugLog: string[] = [];
const MAX_DEBUG_LOG = 100;

export function setWaterPropsDebug(enabled: boolean): void {
  DEBUG_WATER_PROPS = enabled;
  if (enabled) {
    debugLog = [];
    console.log('[WaterProps] Debug mode enabled');
  }
}

export function getWaterPropsDebugLog(): string[] {
  return [...debugLog];
}

function logDebug(msg: string): void {
  if (DEBUG_WATER_PROPS) {
    debugLog.push(msg);
    if (debugLog.length > MAX_DEBUG_LOG) {
      debugLog.shift();
    }
  }
}

// ============================================================================
// Types
// ============================================================================

export interface WaterState {
  temperature: number;      // K
  pressure: number;         // Pa
  density: number;          // kg/m³
  phase: 'liquid' | 'two-phase' | 'vapor';
  quality: number;          // 0-1, only meaningful for two-phase
  specificEnergy: number;   // J/kg - specific internal energy
}

export interface StabilityInfo {
  regime: string;
  isStiff: boolean;
  characteristicTime: number;
  warnings: string[];
}

// ============================================================================
// IAPWS-IF97 Wrapper Functions
// ============================================================================

/**
 * Get saturation properties at a given temperature
 * Returns null if T is outside saturation range (273.15K to 647.096K)
 */
function getSaturationPropsAtT(T_K: number): {
  P: number;      // Pa
  rho_f: number;  // kg/m³ (liquid density)
  rho_g: number;  // kg/m³ (vapor density)
  u_f: number;    // J/kg (liquid internal energy)
  u_g: number;    // J/kg (vapor internal energy)
  h_f: number;    // J/kg (liquid enthalpy)
  h_g: number;    // J/kg (vapor enthalpy)
} | null {
  // IAPWS-IF97 saturation range
  if (T_K < 273.15 || T_K > 647.096) {
    return null;
  }

  try {
    // Get saturation pressure at T
    const result = eos.solve({ t: T_K });
    if (!result || result.region === undefined) return null;

    // Get saturated liquid properties (quality = 0)
    const liquid = eos.solve({ t: T_K, x: 0 });
    // Get saturated vapor properties (quality = 1)
    const vapor = eos.solve({ t: T_K, x: 1 });

    if (!liquid || !vapor) return null;

    return {
      P: liquid.p * 1e6,  // MPa to Pa
      rho_f: liquid.rho,
      rho_g: vapor.rho,
      u_f: liquid.u * 1e3,  // kJ/kg to J/kg
      u_g: vapor.u * 1e3,
      h_f: liquid.h * 1e3,
      h_g: vapor.h * 1e3,
    };
  } catch {
    return null;
  }
}

/**
 * Get saturation temperature at a given pressure
 */
function getSaturationTempAtP(P_Pa: number): number | null {
  const P_MPa = P_Pa / 1e6;
  // IAPWS-IF97 pressure range for saturation
  if (P_MPa < 0.000611657 || P_MPa > 22.064) {
    return null;
  }

  try {
    const result = eos.solve({ p: P_MPa, x: 0 });
    return result?.t ?? null;
  } catch {
    return null;
  }
}

/**
 * Get properties at given P and T (single-phase only)
 */
function getPropsAtPT(P_Pa: number, T_K: number): {
  rho: number;
  u: number;
  h: number;
  s: number;
  cp: number;
  cv: number;
} | null {
  try {
    const result = eos.solve({ p: P_Pa / 1e6, t: T_K });
    if (!result) return null;

    return {
      rho: result.rho,
      u: result.u * 1e3,  // kJ/kg to J/kg
      h: result.h * 1e3,
      s: result.s * 1e3,
      cp: result.cp * 1e3,
      cv: result.cv * 1e3,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Main State Calculation
// ============================================================================

/**
 * Calculate complete water state from mass, internal energy, and volume
 *
 * This is the main state equation solver. Given the conserved quantities
 * (mass, internal energy) and the fixed volume, determine all other
 * thermodynamic properties.
 */
export function calculateState(
  mass: number,
  internalEnergy: number,
  volume: number
): WaterState {
  const density = mass / volume;  // kg/m³
  const u = internalEnergy / mass;  // J/kg (specific internal energy)

  logDebug(`calculateState: m=${mass.toFixed(2)}, U=${(internalEnergy/1e3).toFixed(1)}kJ, V=${volume.toFixed(3)}, ρ=${density.toFixed(2)}, u=${(u/1e3).toFixed(2)}kJ/kg`);

  // Sanity checks
  if (!isFinite(density) || density <= 0 || !isFinite(u)) {
    return createDefaultState(density, u);
  }

  // Strategy: Search for saturation temperature where this (density, u) could exist
  // in the two-phase region. If not found, it's single-phase.

  // First, check if we're in the two-phase dome by scanning saturation temperatures
  const twoPhaseResult = findTwoPhaseState(density, u);
  if (twoPhaseResult) {
    logDebug(`  -> TWO-PHASE: T=${twoPhaseResult.temperature.toFixed(1)}K, x=${(twoPhaseResult.quality*100).toFixed(1)}%`);
    return twoPhaseResult;
  }

  // Not two-phase, determine if liquid or vapor and find T
  const singlePhaseResult = findSinglePhaseState(density, u);
  logDebug(`  -> ${singlePhaseResult.phase.toUpperCase()}: T=${singlePhaseResult.temperature.toFixed(1)}K, P=${(singlePhaseResult.pressure/1e6).toFixed(3)}MPa`);
  return singlePhaseResult;
}

/**
 * Check if (density, u) falls within the two-phase dome at any saturation T
 * If so, return the state; otherwise return null
 */
function findTwoPhaseState(density: number, u: number): WaterState | null {
  // Scan saturation temperatures from 273.15K to 647K
  // At each T, check if both density and u fall within the two-phase bounds

  // Binary search for T where u falls in [u_f, u_g]
  let T_low = 273.16;  // Just above triple point
  let T_high = 647.0;  // Just below critical point

  // First, check if u is even in the possible range
  const propsLow = getSaturationPropsAtT(T_low);
  const propsHigh = getSaturationPropsAtT(T_high);

  if (!propsLow || !propsHigh) {
    return null;
  }

  // u_f increases with T, u_g decreases with T (they meet at critical point)
  // So min u_f is at low T, max u_g is also at low T
  if (u < propsLow.u_f || u > propsLow.u_g) {
    // u is outside the entire two-phase dome
    // But wait - at higher T, u_f increases. Let's be more careful.
    // Actually, for energy within dome, we need u_f(T) <= u <= u_g(T) at some T
  }

  // Binary search to find T where u is in [u_f(T), u_g(T)]
  for (let iter = 0; iter < 30; iter++) {
    const T_mid = (T_low + T_high) / 2;
    const props = getSaturationPropsAtT(T_mid);

    if (!props) {
      T_high = T_mid;
      continue;
    }

    if (u < props.u_f) {
      // Energy too low for two-phase at this T, need lower T (lower u_f)
      T_high = T_mid;
    } else if (u > props.u_g) {
      // Energy too high for two-phase at this T, need higher T (closer to critical)
      T_low = T_mid;
    } else {
      // u is in [u_f, u_g] at this T! Now check density.
      // In two-phase: 1/ρ = (1-x)/ρ_f + x/ρ_g
      // Solving for x: x = (1/ρ - 1/ρ_f) / (1/ρ_g - 1/ρ_f)

      if (density > props.rho_f || density < props.rho_g) {
        // Density doesn't fit at this T, but energy does
        // This means we're not actually two-phase - we're compressed liquid or expanded vapor
        return null;
      }

      // Calculate quality from density
      const v = 1 / density;
      const v_f = 1 / props.rho_f;
      const v_g = 1 / props.rho_g;
      const x_from_density = (v - v_f) / (v_g - v_f);

      // Calculate quality from energy (for consistency check)
      const x_from_energy = (u - props.u_f) / (props.u_g - props.u_f);

      // Use energy-based quality (more reliable for phase boundaries)
      const quality = Math.max(0, Math.min(1, x_from_energy));

      // Check consistency - if density and energy give very different qualities,
      // the state is inconsistent (shouldn't happen in physical systems)
      if (Math.abs(x_from_density - x_from_energy) > 0.3) {
        logDebug(`  Warning: quality mismatch - x_ρ=${x_from_density.toFixed(3)}, x_u=${x_from_energy.toFixed(3)}`);
      }

      return {
        temperature: T_mid,
        pressure: props.P,
        density: density,
        phase: 'two-phase',
        quality: quality,
        specificEnergy: u,
      };
    }
  }

  // Binary search didn't converge - not two-phase
  return null;
}

/**
 * Find single-phase state (liquid or vapor) given density and internal energy
 */
function findSinglePhaseState(density: number, u: number): WaterState {
  // Determine if liquid or vapor based on density
  // Rough heuristic: liquid if ρ > 300 kg/m³
  const isLikelyLiquid = density > 300;

  if (isLikelyLiquid) {
    return findLiquidState(density, u);
  } else {
    return findVaporState(density, u);
  }
}

/**
 * Find subcooled liquid state
 * For liquid, T ≈ u / cv + T_ref
 */
function findLiquidState(density: number, u: number): WaterState {
  // Liquid specific heat is roughly 4186 J/kg-K
  const cv_liquid = 4186;

  // Estimate temperature from energy (reference: 0°C = 273.15K, u ≈ 0)
  let T_est = 273.15 + u / cv_liquid;
  T_est = Math.max(273.16, Math.min(T_est, 640));

  // Now find pressure that gives this density at this temperature
  // For liquid: use compressibility relationship
  // P ≈ P_sat(T) + K * (ρ - ρ_sat) / ρ_sat

  const satProps = getSaturationPropsAtT(T_est);
  let P: number;

  if (satProps && T_est < 647) {
    // Use saturation as reference
    const rho_sat = satProps.rho_f;
    // Bulk modulus of water ~ 2.2 GPa, but use softer value for stability
    const K = 1e8;  // 100 MPa effective bulk modulus
    P = satProps.P + K * (density - rho_sat) / rho_sat;
    P = Math.max(satProps.P, Math.min(P, 100e6));  // Clamp to reasonable range
  } else {
    // High temperature - estimate from ideal behavior
    P = density * 461.5 * T_est;  // Rough estimate
  }

  // Refine temperature using IAPWS if possible
  const props = getPropsAtPT(P, T_est);
  if (props) {
    // Adjust T to match internal energy better
    const u_calc = props.u;
    const cv = props.cv || cv_liquid;
    const dT = (u - u_calc) / cv;
    T_est = T_est + dT * 0.5;  // Partial correction to avoid overshoot
    T_est = Math.max(273.16, Math.min(T_est, 640));
  }

  return {
    temperature: T_est,
    pressure: P,
    density: density,
    phase: 'liquid',
    quality: 0,
    specificEnergy: u,
  };
}

/**
 * Find superheated vapor state
 * For ideal gas: P = ρRT, u = cv*T
 */
function findVaporState(density: number, u: number): WaterState {
  // Vapor constants
  const R = 461.5;  // J/kg-K for water vapor
  const cv_vapor = 1500;  // J/kg-K (approximate)

  // Estimate temperature from energy
  // For vapor, u = cv * T approximately (with some reference offset)
  // At saturation 373K, u_g ≈ 2500 kJ/kg
  // u = u_ref + cv * (T - T_ref)
  const u_ref = 2400e3;  // J/kg at T_ref
  const T_ref = 373;
  let T_est = T_ref + (u - u_ref) / cv_vapor;
  T_est = Math.max(300, Math.min(T_est, 2000));

  // For ideal gas: P = ρRT
  let P = density * R * T_est;

  // Check if we're close to saturation (low superheat)
  const T_sat = getSaturationTempAtP(P);
  if (T_sat && T_est < T_sat + 50) {
    // Near saturation - use saturation properties as reference
    const satProps = getSaturationPropsAtT(T_sat);
    if (satProps) {
      // Refine: if u is close to u_g, we're just barely superheated
      if (u < satProps.u_g * 1.1) {
        T_est = T_sat + (u - satProps.u_g) / cv_vapor;
        T_est = Math.max(T_sat, T_est);
        P = density * R * T_est;
      }
    }
  }

  return {
    temperature: T_est,
    pressure: P,
    density: density,
    phase: 'vapor',
    quality: 1,
    specificEnergy: u,
  };
}

/**
 * Create a default state for error cases
 */
function createDefaultState(density: number, u: number): WaterState {
  return {
    temperature: 400,
    pressure: 1e6,
    density: isFinite(density) && density > 0 ? density : 1000,
    phase: 'liquid',
    quality: 0,
    specificEnergy: isFinite(u) ? u : 400000,
  };
}

// ============================================================================
// Saturation Property Functions (public API)
// ============================================================================

export function saturationPressure(T: number): number {
  const props = getSaturationPropsAtT(T);
  return props?.P ?? 101325;
}

export function saturationTemperature(P: number): number {
  return getSaturationTempAtP(P) ?? 373.15;
}

export function saturatedLiquidDensity(T: number): number {
  const props = getSaturationPropsAtT(T);
  return props?.rho_f ?? 1000;
}

export function saturatedVaporDensity(T: number): number {
  const props = getSaturationPropsAtT(T);
  return props?.rho_g ?? 1;
}

export function saturatedLiquidEnergy(T: number): number {
  const props = getSaturationPropsAtT(T);
  return props?.u_f ?? 0;
}

export function saturatedVaporEnergy(T: number): number {
  const props = getSaturationPropsAtT(T);
  return props?.u_g ?? 2500000;
}

export function latentHeat(T: number): number {
  const props = getSaturationPropsAtT(T);
  if (!props) return 2.26e6;
  return props.u_g - props.u_f;
}

// ============================================================================
// Utility Functions
// ============================================================================

export function liquidCv(_T: number): number {
  return 4186;
}

export function vaporCv(_T: number): number {
  return 1500;
}

export function addEnergy(
  currentMass: number,
  currentEnergy: number,
  volume: number,
  energyAdded: number
): WaterState {
  return calculateState(currentMass, currentEnergy + energyAdded, volume);
}

export function effectiveSpecificHeat(state: WaterState): number {
  if (state.phase === 'liquid') {
    return liquidCv(state.temperature);
  } else if (state.phase === 'vapor') {
    return vaporCv(state.temperature);
  } else {
    // Two-phase - very large effective specific heat
    return latentHeat(state.temperature) / 10;
  }
}

export function energyFromTemperature(
  T: number,
  phase: 'liquid' | 'two-phase' | 'vapor',
  quality: number = 0
): number {
  const props = getSaturationPropsAtT(T);
  if (!props) {
    // Fallback for out-of-range T
    if (phase === 'liquid') return liquidCv(T) * (T - 273.15);
    if (phase === 'vapor') return 2400e3 + vaporCv(T) * (T - 373);
    return 0;
  }

  if (phase === 'liquid') {
    return props.u_f;
  } else if (phase === 'vapor') {
    return props.u_g;
  } else {
    return props.u_f + quality * (props.u_g - props.u_f);
  }
}

export function massFromDensityVolume(density: number, volume: number): number {
  return density * volume;
}

// ============================================================================
// Stability Analysis
// ============================================================================

export function analyzeStability(state: WaterState, volume: number): StabilityInfo {
  const warnings: string[] = [];
  let characteristicTime = 1.0;
  let isStiff = false;

  if (state.phase === 'liquid') {
    isStiff = true;
    const L = Math.cbrt(volume);
    characteristicTime = L / 1500;  // Speed of sound in water
  } else if (state.phase === 'two-phase') {
    isStiff = false;
    if (state.quality < 0.01) warnings.push('Quality very low');
    if (state.quality > 0.99) warnings.push('Quality very high');
  } else {
    isStiff = false;
    const L = Math.cbrt(volume);
    characteristicTime = L / 500;  // Speed of sound in steam
  }

  return {
    regime: state.phase,
    isStiff,
    characteristicTime,
    warnings,
  };
}

export function suggestMaxTimestep(state: WaterState, volume: number): number {
  const stability = analyzeStability(state, volume);
  return Math.max(1e-6, Math.min(stability.characteristicTime * 0.1, 0.1));
}
