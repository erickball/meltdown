/**
 * Water/Steam Properties Module - Steam Table Based
 *
 * Uses interpolated steam table data for accurate saturation properties,
 * combined with physics-based correlations for single-phase regions.
 *
 * This approach gives:
 * - Accurate saturation curves (from IAPWS data)
 * - Reasonable single-phase properties (ideal gas for vapor, incompressible for liquid)
 * - Numerical stability through "softened" equations of state
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Physical Constants
// ============================================================================

const R_WATER = 461.5;      // J/kg-K - specific gas constant for water vapor
const CV_LIQUID = 4186;     // J/kg-K - liquid water specific heat
const T_CRIT = 647.096;     // K - critical temperature
const P_CRIT = 22.064e6;    // Pa - critical pressure
const RHO_CRIT = 322;       // kg/m³ - critical density
const T_TRIPLE = 273.16;    // K - triple point temperature
const T_REF = 273.15;       // K - reference temperature (0°C)

// ============================================================================
// Saturation Data from Steam Table
// ============================================================================

interface SaturationPoint {
  T: number;      // K
  P: number;      // Pa
  rho_f: number;  // kg/m³ - saturated liquid density
  rho_g: number;  // kg/m³ - saturated vapor density
  u_f: number;    // J/kg - saturated liquid internal energy
  u_g: number;    // J/kg - saturated vapor internal energy
}

// Saturation data indexed by temperature
let saturationData: SaturationPoint[] = [];
let satDataLoaded = false;

/**
 * Load saturation data from steam table file
 */
function loadSteamTable(): void {
  if (satDataLoaded) return;

  const steamTablePath = path.resolve(__dirname, '../../../steam-table.txt');

  try {
    const content = fs.readFileSync(steamTablePath, 'utf-8');
    const lines = content.trim().split('\n');

    // Parse saturated liquid and vapor entries
    const satLiquid: Map<number, { P: number; rho: number; u: number }> = new Map();
    const satVapor: Map<number, { P: number; rho: number; u: number }> = new Map();

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('\t');
      if (parts.length < 8) continue;

      const P_MPa = parseFloat(parts[0]);
      const T_C = parseFloat(parts[1]);
      const u_kJkg = parseFloat(parts[3]);
      const phase = parts[6];
      const rho = parseFloat(parts[7]);

      const T_K = T_C + 273.15;
      const P_Pa = P_MPa * 1e6;
      const u_Jkg = u_kJkg * 1000;

      // Round T to 0.1 K for matching
      const T_key = Math.round(T_K * 10) / 10;

      if (phase === 'saturated liquid') {
        satLiquid.set(T_key, { P: P_Pa, rho, u: u_Jkg });
      } else if (phase === 'saturated vapor') {
        satVapor.set(T_key, { P: P_Pa, rho, u: u_Jkg });
      }
    }

    // Combine into saturation points where we have both liquid and vapor data
    const allTemps = new Set([...satLiquid.keys(), ...satVapor.keys()]);
    const sortedTemps = Array.from(allTemps).sort((a, b) => a - b);

    for (const T of sortedTemps) {
      const liq = satLiquid.get(T);
      const vap = satVapor.get(T);

      if (liq && vap) {
        saturationData.push({
          T,
          P: (liq.P + vap.P) / 2,  // Should be same, average for robustness
          rho_f: liq.rho,
          rho_g: vap.rho,
          u_f: liq.u,
          u_g: vap.u,
        });
      } else if (liq) {
        // Only liquid data - estimate vapor from ideal gas
        const P = liq.P;
        const rho_g = P / (R_WATER * T);
        const u_g = liq.u + 2260000 * Math.pow(1 - T / T_CRIT, 0.38);  // Approx latent heat
        saturationData.push({
          T,
          P,
          rho_f: liq.rho,
          rho_g,
          u_f: liq.u,
          u_g,
        });
      }
    }

    // Sort by temperature
    saturationData.sort((a, b) => a.T - b.T);

    console.log(`[WaterProps] Loaded ${saturationData.length} saturation points from steam table`);
    satDataLoaded = true;
  } catch (e) {
    console.warn('[WaterProps] Could not load steam table, using correlations:', e);
    // Fall back to correlation-based data
    generateCorrelationData();
    satDataLoaded = true;
  }
}

/**
 * Generate fallback saturation data from correlations
 */
function generateCorrelationData(): void {
  for (let T = 280; T < T_CRIT; T += 5) {
    const P = saturationPressureCorrelation(T);
    const tau = 1 - T / T_CRIT;

    const rho_f = RHO_CRIT + (1000 - RHO_CRIT) * Math.pow(tau, 0.35);
    const rho_g = P / (R_WATER * T * Math.max(0.23, 1 - 0.7 * Math.pow(T / T_CRIT, 4)));

    const u_f = CV_LIQUID * (T - T_REF);
    const L = 2.5e6 * Math.pow(tau, 0.38);
    const u_g = u_f + L;

    saturationData.push({ T, P, rho_f, rho_g, u_f, u_g });
  }
}

/**
 * Wagner equation for saturation pressure (correlation fallback)
 */
function saturationPressureCorrelation(T: number): number {
  if (T >= T_CRIT) return P_CRIT;
  if (T < T_TRIPLE) return 611.657;

  const tau = 1 - T / T_CRIT;
  const a1 = -7.85951783;
  const a2 = 1.84408259;
  const a3 = -11.7866497;
  const a4 = 22.6807411;
  const a5 = -15.9618719;
  const a6 = 1.80122502;

  const lnPr = (T_CRIT / T) * (
    a1 * tau +
    a2 * Math.pow(tau, 1.5) +
    a3 * Math.pow(tau, 3) +
    a4 * Math.pow(tau, 3.5) +
    a5 * Math.pow(tau, 4) +
    a6 * Math.pow(tau, 7.5)
  );

  return P_CRIT * Math.exp(lnPr);
}

// ============================================================================
// Interpolation Helpers
// ============================================================================

/**
 * Binary search for bracketing indices
 */
function findBracket(arr: SaturationPoint[], T: number): [number, number] {
  if (arr.length === 0) return [0, 0];
  if (T <= arr[0].T) return [0, 0];
  if (T >= arr[arr.length - 1].T) return [arr.length - 1, arr.length - 1];

  let lo = 0;
  let hi = arr.length - 1;

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (arr[mid].T <= T) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return [lo, hi];
}

/**
 * Linear interpolation
 */
function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

/**
 * Get interpolated saturation properties at temperature T
 */
function getSaturationProps(T: number): SaturationPoint {
  loadSteamTable();

  if (saturationData.length === 0) {
    // Emergency fallback
    return {
      T,
      P: saturationPressureCorrelation(T),
      rho_f: 958,
      rho_g: 0.6,
      u_f: CV_LIQUID * (T - T_REF),
      u_g: CV_LIQUID * (T - T_REF) + 2260000,
    };
  }

  const [lo, hi] = findBracket(saturationData, T);

  if (lo === hi) {
    return saturationData[lo];
  }

  const T_lo = saturationData[lo].T;
  const T_hi = saturationData[hi].T;
  const t = (T - T_lo) / (T_hi - T_lo);

  return {
    T,
    P: lerp(saturationData[lo].P, saturationData[hi].P, t),
    rho_f: lerp(saturationData[lo].rho_f, saturationData[hi].rho_f, t),
    rho_g: lerp(saturationData[lo].rho_g, saturationData[hi].rho_g, t),
    u_f: lerp(saturationData[lo].u_f, saturationData[hi].u_f, t),
    u_g: lerp(saturationData[lo].u_g, saturationData[hi].u_g, t),
  };
}

// ============================================================================
// Exported Saturation Functions
// ============================================================================

export function saturationPressure(T: number): number {
  if (T < T_TRIPLE) {
    const P_triple = 611.657;
    const dPdT = 44.4;
    return Math.max(100, P_triple + dPdT * (T - T_TRIPLE));
  }
  if (T >= T_CRIT) return P_CRIT;

  return getSaturationProps(T).P;
}

export function saturationTemperature(P: number): number {
  loadSteamTable();

  if (P >= P_CRIT) return T_CRIT;
  if (P < 611.657) return T_TRIPLE;

  // Binary search through saturation data
  let lo = 0;
  let hi = saturationData.length - 1;

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (saturationData[mid].P <= P) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Interpolate
  const P_lo = saturationData[lo].P;
  const P_hi = saturationData[hi].P;
  const t = (P - P_lo) / (P_hi - P_lo);

  return lerp(saturationData[lo].T, saturationData[hi].T, t);
}

export function saturatedLiquidDensity(T: number): number {
  if (T >= T_CRIT) return RHO_CRIT;
  if (T < T_TRIPLE) return 1000;
  return getSaturationProps(T).rho_f;
}

export function saturatedVaporDensity(T: number): number {
  if (T >= T_CRIT) return RHO_CRIT;
  if (T < T_TRIPLE) return 0.005;
  return getSaturationProps(T).rho_g;
}

export function saturatedLiquidEnergy(T: number): number {
  if (T < T_TRIPLE) return 0;
  if (T >= T_CRIT) return 2000000;
  return getSaturationProps(T).u_f;
}

export function saturatedVaporEnergy(T: number): number {
  if (T < T_TRIPLE) return 2500000;
  if (T >= T_CRIT) return 2000000;
  return getSaturationProps(T).u_g;
}

export function latentHeat(T: number): number {
  if (T >= T_CRIT) return 0;
  const props = getSaturationProps(Math.max(T_TRIPLE, T));
  return props.u_g - props.u_f;
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
  specificEnergy: number;   // J/kg
}

// ============================================================================
// Main State Calculation
// ============================================================================

/**
 * Calculate complete water state from mass, internal energy, and volume
 */
export function calculateState(
  mass: number,
  internalEnergy: number,
  volume: number
): WaterState {
  loadSteamTable();

  const rho = mass / volume;
  const u = internalEnergy / mass;

  if (!isFinite(rho) || rho <= 0 || !isFinite(u)) {
    return createDefaultState(rho, u);
  }

  // Try to find two-phase state first
  const twoPhaseResult = findTwoPhaseState(rho, u);
  if (twoPhaseResult) {
    return twoPhaseResult;
  }

  // Single phase
  return findSinglePhaseState(rho, u);
}

/**
 * Check if (density, u) falls within the two-phase dome
 *
 * Strategy: Binary search for temperature where BOTH density and energy
 * fall within the saturation bounds.
 */
function findTwoPhaseState(rho: number, u: number): WaterState | null {
  loadSteamTable();

  // Quick bounds check on energy
  // u_f at 273K ≈ 0, u_g at 273K ≈ 2500 kJ/kg
  // Both converge to ~2000 kJ/kg at critical
  if (u < -10000 || u > 2700000) {
    return null;
  }

  // Binary search for temperature where state is in two-phase region
  let T_low = T_TRIPLE;
  let T_high = T_CRIT - 0.1;
  let bestT: number | null = null;
  let bestScore = Infinity;

  for (let iter = 0; iter < 50; iter++) {
    const T_mid = (T_low + T_high) / 2;
    const props = getSaturationProps(T_mid);

    // Check if both density and energy are in range
    const rhoInRange = rho >= props.rho_g && rho <= props.rho_f;
    const uInRange = u >= props.u_f && u <= props.u_g;

    if (rhoInRange && uInRange) {
      // Found a valid two-phase temperature
      // Score by how well centered we are
      const x_rho = (1/rho - 1/props.rho_f) / (1/props.rho_g - 1/props.rho_f);
      const x_u = (u - props.u_f) / (props.u_g - props.u_f);
      const score = Math.abs(x_rho - x_u);

      if (score < bestScore) {
        bestScore = score;
        bestT = T_mid;
      }

      // Try to find better match by searching both directions
      if (x_u > x_rho) {
        // Energy suggests higher quality than density
        // Try higher T where densities decrease
        T_low = T_mid;
      } else {
        T_high = T_mid;
      }
    } else if (u < props.u_f) {
      // Energy too low for two-phase at this T - need lower T
      T_high = T_mid;
    } else if (u > props.u_g) {
      // Energy too high for two-phase at this T - need higher T (u_g decreases)
      T_low = T_mid;
    } else if (rho > props.rho_f) {
      // Density too high - compressed liquid, not two-phase
      return null;
    } else if (rho < props.rho_g) {
      // Density too low - superheated vapor, not two-phase
      return null;
    } else {
      // One is in range, other not - shouldn't happen much
      break;
    }

    if (T_high - T_low < 0.1) break;
  }

  if (bestT === null) {
    return null;
  }

  // Calculate quality at best temperature
  const props = getSaturationProps(bestT);

  const v = 1 / rho;
  const v_f = 1 / props.rho_f;
  const v_g = 1 / props.rho_g;
  const x_rho = Math.max(0, Math.min(1, (v - v_f) / (v_g - v_f)));
  const x_u = Math.max(0, Math.min(1, (u - props.u_f) / (props.u_g - props.u_f)));

  const quality = 0.3 * x_rho + 0.7 * x_u;

  return {
    temperature: bestT,
    pressure: props.P,
    density: rho,
    phase: 'two-phase',
    quality: Math.max(0, Math.min(1, quality)),
    specificEnergy: u,
  };
}

/**
 * Find single-phase state
 *
 * Key insight: use ENERGY to determine phase, not just density.
 * - Subcooled liquid: u < u_f at T implied by density
 * - Superheated vapor: u > u_g at T implied by density
 */
function findSinglePhaseState(rho: number, u: number): WaterState {
  // For high density (> 500 kg/m³), almost certainly liquid
  if (rho > 500) {
    return findLiquidState(rho, u);
  }

  // For very low density (< 10 kg/m³), almost certainly vapor
  if (rho < 10) {
    return findVaporState(rho, u);
  }

  // Middle range - use energy to decide
  // Find the saturation energy at this density level
  // If rho ~ rho_f(T), then subcooled if u < u_f(T)
  // If rho ~ rho_g(T), then superheated if u > u_g(T)

  // Estimate T from energy first (rough)
  const T_from_liquid_u = T_REF + u / CV_LIQUID;
  const T_from_vapor_u = 373 + (u - 2500000) / 1500;  // rough

  // Check saturation at these temperatures
  if (T_from_liquid_u > T_TRIPLE && T_from_liquid_u < T_CRIT) {
    const props = getSaturationProps(T_from_liquid_u);
    if (rho > props.rho_f * 0.8 && u < props.u_f * 1.1) {
      // Looks like subcooled liquid
      return findLiquidState(rho, u);
    }
  }

  if (T_from_vapor_u > 300 && T_from_vapor_u < 3000) {
    // High energy, moderate density - likely vapor
    return findVaporState(rho, u);
  }

  // Default: use density threshold
  if (rho > 100) {
    return findLiquidState(rho, u);
  } else {
    return findVaporState(rho, u);
  }
}

/**
 * Find subcooled liquid state
 *
 * For subcooled liquid, temperature is determined from internal energy.
 * Pressure is tricky - for nearly incompressible liquid, we can't determine
 * P from (ρ, u) alone. We use P_sat as a lower bound approximation.
 *
 * Note: This means subcooled liquid pressure won't be accurate, but that's
 * acceptable for the simulation - we mainly care about:
 * 1. Correct phase detection
 * 2. Correct temperature
 * 3. Reasonable pressure (at least P_sat)
 */
function findLiquidState(rho: number, u: number): WaterState {
  // Temperature from energy: u = cv * (T - T_ref)
  const T = T_REF + u / CV_LIQUID;
  const T_clamped = Math.max(T_TRIPLE, Math.min(T, T_CRIT - 1));
  const props = getSaturationProps(T_clamped);

  // For pressure, we can't accurately determine it from (ρ, u) for liquid
  // because liquid is nearly incompressible.
  //
  // Best we can do: P >= P_sat(T)
  // If rho > rho_sat, we're compressed, so P > P_sat
  // Use a soft model: P = P_sat + K * (rho - rho_sat) / rho_sat
  // where K is a soft bulk modulus (~100 MPa)

  let P = props.P;  // Start with saturation pressure

  if (rho > props.rho_f) {
    // Compressed liquid
    const K = 100e6;  // 100 MPa soft bulk modulus
    const compression = (rho - props.rho_f) / props.rho_f;
    P = props.P + K * compression;
  }

  // Clamp to reasonable range
  P = Math.max(props.P, Math.min(P, P_CRIT * 10));

  return {
    temperature: T,
    pressure: P,
    density: rho,
    phase: 'liquid',
    quality: 0,
    specificEnergy: u,
  };
}

/**
 * Find superheated vapor state
 */
function findVaporState(rho: number, u: number): WaterState {
  // Temperature-dependent cv: cv(T) = 1400 + 0.47*(T - 373)
  const u_ref = 2500000;  // J/kg at 373K
  const T_ref = 373;
  const cv_0 = 1400;
  const alpha = 0.47;

  const du = u - u_ref;
  let T: number;

  if (du > 0) {
    const discriminant = cv_0 * cv_0 + 2 * alpha * du;
    if (discriminant > 0) {
      const dT = (-cv_0 + Math.sqrt(discriminant)) / alpha;
      T = T_ref + dT;
    } else {
      T = T_ref + du / cv_0;
    }
  } else {
    // Near saturation - find T where u_g(T) ≈ u
    T = findTempForVaporEnergy(u);
  }

  T = Math.max(300, T);
  const P = rho * R_WATER * T;

  return {
    temperature: T,
    pressure: Math.max(1000, P),
    density: rho,
    phase: 'vapor',
    quality: 1,
    specificEnergy: u,
  };
}

/**
 * Find temperature where saturated vapor has given internal energy
 */
function findTempForVaporEnergy(u: number): number {
  loadSteamTable();

  // Binary search
  let lo = 0;
  let hi = saturationData.length - 1;

  // u_g generally decreases with increasing T (toward critical)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (saturationData[mid].u_g > u) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Interpolate
  const u_lo = saturationData[lo].u_g;
  const u_hi = saturationData[hi].u_g;

  if (Math.abs(u_hi - u_lo) < 1) {
    return saturationData[lo].T;
  }

  const t = (u - u_lo) / (u_hi - u_lo);
  return lerp(saturationData[lo].T, saturationData[hi].T, t);
}

/**
 * Create default state for error cases
 */
function createDefaultState(rho: number, u: number): WaterState {
  return {
    temperature: 400,
    pressure: 1e6,
    density: isFinite(rho) && rho > 0 ? rho : 1000,
    phase: 'liquid',
    quality: 0,
    specificEnergy: isFinite(u) ? u : 500000,
  };
}

// ============================================================================
// Utility Functions (for compatibility)
// ============================================================================

export function liquidCv(T: number): number {
  if (T > 600) {
    const t = (T - 600) / (T_CRIT - 600);
    return CV_LIQUID * (1 + t * 0.5);
  }
  return CV_LIQUID;
}

export function vaporCv(T: number): number {
  const cv_0 = 1400;
  const alpha = 0.47;
  return cv_0 + alpha * Math.max(0, T - 373);
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
    return latentHeat(state.temperature) / 10;
  }
}

export function energyFromTemperature(
  T: number,
  phase: 'liquid' | 'two-phase' | 'vapor',
  quality: number = 0
): number {
  if (phase === 'liquid') {
    return saturatedLiquidEnergy(T);
  } else if (phase === 'vapor') {
    return saturatedVaporEnergy(T);
  } else {
    const u_f = saturatedLiquidEnergy(T);
    const u_g = saturatedVaporEnergy(T);
    return u_f + quality * (u_g - u_f);
  }
}

export function massFromDensityVolume(density: number, volume: number): number {
  return density * volume;
}

// ============================================================================
// Debug Functions
// ============================================================================

let DEBUG_WATER_PROPS = false;

export function setWaterPropsDebug(enabled: boolean): void {
  DEBUG_WATER_PROPS = enabled;
}

export function getWaterPropsDebugLog(): string[] {
  return [];
}

// ============================================================================
// Stability Analysis (simplified)
// ============================================================================

export interface StabilityInfo {
  regime: string;
  isStiff: boolean;
  characteristicTime: number;
  warnings: string[];
}

export function analyzeStability(state: WaterState, volume: number): StabilityInfo {
  const warnings: string[] = [];
  let characteristicTime = 1.0;
  let isStiff = state.phase === 'liquid';

  if (state.phase === 'liquid') {
    const L = Math.cbrt(volume);
    characteristicTime = L / 1500;
  } else if (state.phase === 'vapor') {
    const L = Math.cbrt(volume);
    characteristicTime = L / 500;
  }

  return { regime: state.phase, isStiff, characteristicTime, warnings };
}

export function suggestMaxTimestep(state: WaterState, volume: number): number {
  const stability = analyzeStability(state, volume);
  return Math.max(1e-6, Math.min(stability.characteristicTime * 0.1, 0.1));
}
