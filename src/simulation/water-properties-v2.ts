/**
 * Water/Steam Properties Module v2 - (v, u) Based Lookup
 *
 * Uses the steam table to build saturation curves in (v, u) space.
 * Phase detection is done by checking if the point lies inside the two-phase dome.
 *
 * Key insight: In (v, u) space, the two-phase dome is bounded by:
 * - Left edge: saturated liquid line (v_f, u_f) vs T
 * - Right edge: saturated vapor line (v_g, u_g) vs T
 * - Top: critical point where they meet
 *
 * For a point (v, u):
 * 1. If v < v_f(u) for all T → compressed liquid
 * 2. If v > v_g(u) for all T → superheated vapor
 * 3. Otherwise → two-phase, find T where v_f(T) < v < v_g(T) AND u_f(T) < u < u_g(T)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Constants
// ============================================================================

const R_WATER = 461.5;      // J/kg-K
const CV_LIQUID = 4186;     // J/kg-K
const T_CRIT = 647.096;     // K
const P_CRIT = 22.064e6;    // Pa
const RHO_CRIT = 322;       // kg/m³
const T_TRIPLE = 273.16;    // K
const T_REF = 273.15;       // K

// ============================================================================
// Saturation Curve Data
// ============================================================================

interface SatPoint {
  T: number;    // K
  P: number;    // Pa
  v_f: number;  // m³/kg - saturated liquid specific volume
  v_g: number;  // m³/kg - saturated vapor specific volume
  u_f: number;  // J/kg
  u_g: number;  // J/kg
}

let satCurve: SatPoint[] = [];
let dataLoaded = false;

function loadData(): void {
  if (dataLoaded) return;

  const steamTablePath = path.resolve(__dirname, '../../../steam-table.txt');

  try {
    const content = fs.readFileSync(steamTablePath, 'utf-8');
    const lines = content.trim().split('\n');

    // Extract saturation data
    const satLiq = new Map<number, { P: number; v: number; u: number }>();
    const satVap = new Map<number, { P: number; v: number; u: number }>();

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('\t');
      if (parts.length < 8) continue;

      const P_MPa = parseFloat(parts[0]);
      const T_C = parseFloat(parts[1]);
      const v_m3kg = parseFloat(parts[2]);
      const u_kJkg = parseFloat(parts[3]);
      const phase = parts[6];

      const T_K = T_C + 273.15;
      const P_Pa = P_MPa * 1e6;
      const u_Jkg = u_kJkg * 1000;

      // Round T for matching
      const T_key = Math.round(T_K * 10) / 10;

      if (phase === 'saturated liquid') {
        satLiq.set(T_key, { P: P_Pa, v: v_m3kg, u: u_Jkg });
      } else if (phase === 'saturated vapor') {
        satVap.set(T_key, { P: P_Pa, v: v_m3kg, u: u_Jkg });
      }
    }

    // Combine where we have both
    for (const [T, liq] of satLiq) {
      const vap = satVap.get(T);
      if (vap) {
        satCurve.push({
          T,
          P: (liq.P + vap.P) / 2,
          v_f: liq.v,
          v_g: vap.v,
          u_f: liq.u,
          u_g: vap.u,
        });
      }
    }

    // Sort by temperature
    satCurve.sort((a, b) => a.T - b.T);

    console.log(`[WaterProps v2] Loaded ${satCurve.length} saturation points`);
    dataLoaded = true;
  } catch (e) {
    console.warn('[WaterProps v2] Could not load steam table:', e);
    generateFallbackData();
    dataLoaded = true;
  }
}

function generateFallbackData(): void {
  // Generate from correlations if no table
  for (let T = 280; T <= 645; T += 5) {
    const P = wagnerPsat(T);
    const tau = 1 - T / T_CRIT;

    const rho_f = RHO_CRIT + (1000 - RHO_CRIT) * Math.pow(tau, 0.35);
    const rho_g = P / (R_WATER * T * Math.max(0.23, 1 - 0.7 * Math.pow(T / T_CRIT, 4)));

    const u_f = CV_LIQUID * (T - T_REF);
    const L = 2.5e6 * Math.pow(Math.max(0, tau), 0.38);
    const u_g = u_f + L;

    satCurve.push({
      T,
      P,
      v_f: 1 / rho_f,
      v_g: 1 / rho_g,
      u_f,
      u_g,
    });
  }
}

function wagnerPsat(T: number): number {
  if (T >= T_CRIT) return P_CRIT;
  if (T < T_TRIPLE) return 611.657;

  const tau = 1 - T / T_CRIT;
  const lnPr = (T_CRIT / T) * (
    -7.85951783 * tau +
    1.84408259 * Math.pow(tau, 1.5) +
    -11.7866497 * Math.pow(tau, 3) +
    22.6807411 * Math.pow(tau, 3.5) +
    -15.9618719 * Math.pow(tau, 4) +
    1.80122502 * Math.pow(tau, 7.5)
  );
  return P_CRIT * Math.exp(lnPr);
}

// ============================================================================
// Interpolation
// ============================================================================

function findBracket(T: number): [number, number] {
  if (satCurve.length === 0) return [0, 0];
  if (T <= satCurve[0].T) return [0, 0];
  if (T >= satCurve[satCurve.length - 1].T) {
    const n = satCurve.length - 1;
    return [n, n];
  }

  let lo = 0, hi = satCurve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (satCurve[mid].T <= T) lo = mid;
    else hi = mid;
  }
  return [lo, hi];
}

function interpSat(T: number): SatPoint {
  loadData();
  if (satCurve.length === 0) {
    return { T, P: wagnerPsat(T), v_f: 0.001, v_g: 1, u_f: 0, u_g: 2500000 };
  }

  const [lo, hi] = findBracket(T);
  if (lo === hi) return satCurve[lo];

  const t = (T - satCurve[lo].T) / (satCurve[hi].T - satCurve[lo].T);
  const a = satCurve[lo], b = satCurve[hi];

  return {
    T,
    P: a.P + t * (b.P - a.P),
    v_f: a.v_f + t * (b.v_f - a.v_f),
    v_g: a.v_g + t * (b.v_g - a.v_g),
    u_f: a.u_f + t * (b.u_f - a.u_f),
    u_g: a.u_g + t * (b.u_g - a.u_g),
  };
}

// ============================================================================
// Phase Detection using (v, u)
// ============================================================================

/**
 * Find if (v, u) is inside the two-phase dome
 * Returns the saturation temperature if inside, null if outside
 *
 * IMPORTANT: For liquid, v ≈ v_f regardless of pressure (incompressible).
 * So we can only detect two-phase if:
 * 1. v is significantly greater than v_f (actual mixture with vapor)
 * 2. Quality from v and quality from u roughly agree
 *
 * Points with v ≈ v_f are treated as LIQUID, not two-phase, even if
 * u happens to equal u_f. This is the only sensible interpretation
 * since we can't determine pressure from (v, u) for liquid.
 */
function findTwoPhaseT(v: number, u: number): number | null {
  loadData();
  if (satCurve.length === 0) return null;

  // Quick bounds on energy
  const minUf = satCurve[0].u_f;
  const maxUg = Math.max(...satCurve.map(p => p.u_g));
  if (u < minUf * 0.9 || u > maxUg * 1.1) return null;

  // Quick bounds on specific volume
  // Two-phase requires v > v_f (by a meaningful amount, not just numerical noise)
  const minVf = Math.min(...satCurve.map(p => p.v_f));
  const maxVg = Math.max(...satCurve.map(p => p.v_g));

  // If v is very close to saturated liquid values, it's liquid, not two-phase
  // Require v to be at least 5% above min v_f to consider two-phase
  if (v < minVf * 1.05) return null;
  if (v > maxVg * 1.1) return null;

  // Scan through saturation curve to find best match
  // For each T, check if (v, u) could be in the two-phase region
  let bestT: number | null = null;
  let bestScore = Infinity;
  let bestQuality = 0;

  for (const pt of satCurve) {
    // Check if v is in the two-phase range for this T
    // Must be strictly between v_f and v_g (within tolerance)
    if (v < pt.v_f * 0.95 || v > pt.v_g * 1.05) continue;

    // Check if u is in the two-phase range for this T
    // Must be strictly between u_f and u_g (within tolerance)
    if (u < pt.u_f * 0.95 || u > pt.u_g * 1.05) continue;

    // Calculate qualities from both v and u
    const x_v = (v - pt.v_f) / (pt.v_g - pt.v_f);
    const x_u = (u - pt.u_f) / (pt.u_g - pt.u_f);

    // For a true two-phase mixture, both qualities should agree
    // Score is how well they agree
    const score = Math.abs(x_v - x_u);

    // Accept if qualities agree within 25%
    if (score < bestScore && score < 0.25) {
      bestScore = score;
      bestT = pt.T;
      bestQuality = (x_v + x_u) / 2;
    }
  }

  // If quality is very close to 0 or 1, this is really single-phase
  // Only return two-phase for 0.05 < x < 0.95
  if (bestQuality < 0.05 || bestQuality > 0.95) {
    return null;
  }

  // If we found a reasonable match, refine it with interpolation
  if (bestT !== null && satCurve.length > 1) {
    // Fine-tune around the best T
    let T_lo = Math.max(satCurve[0].T, bestT - 10);
    let T_hi = Math.min(satCurve[satCurve.length - 1].T, bestT + 10);

    for (let iter = 0; iter < 20; iter++) {
      const T_mid = (T_lo + T_hi) / 2;
      const sat = interpSat(T_mid);

      if (v < sat.v_f * 0.95 || v > sat.v_g * 1.05) break;
      if (u < sat.u_f * 0.95 || u > sat.u_g * 1.05) break;

      const x_v = (v - sat.v_f) / (sat.v_g - sat.v_f);
      const x_u = (u - sat.u_f) / (sat.u_g - sat.u_f);
      const score = Math.abs(x_v - x_u);

      if (score < bestScore) {
        bestScore = score;
        bestT = T_mid;
      }

      // Refine: if x_u > x_v, need higher T (more energetic mixture)
      if (x_u > x_v) T_lo = T_mid;
      else T_hi = T_mid;

      if (T_hi - T_lo < 0.1) break;
    }
  }

  return bestT;
}

// ============================================================================
// Exported Interface
// ============================================================================

export interface WaterState {
  temperature: number;
  pressure: number;
  density: number;
  phase: 'liquid' | 'two-phase' | 'vapor';
  quality: number;
  specificEnergy: number;
}

export function calculateState(mass: number, internalEnergy: number, volume: number): WaterState {
  loadData();

  const rho = mass / volume;
  const v = volume / mass;  // specific volume
  const u = internalEnergy / mass;

  if (!isFinite(rho) || rho <= 0 || !isFinite(u)) {
    return { temperature: 400, pressure: 1e6, density: 1000, phase: 'liquid', quality: 0, specificEnergy: 500000 };
  }

  // Check for two-phase
  const T_sat = findTwoPhaseT(v, u);

  if (T_sat !== null) {
    const sat = interpSat(T_sat);
    const x_v = Math.max(0, Math.min(1, (v - sat.v_f) / (sat.v_g - sat.v_f)));
    const x_u = Math.max(0, Math.min(1, (u - sat.u_f) / (sat.u_g - sat.u_f)));
    const quality = 0.5 * x_v + 0.5 * x_u;

    return {
      temperature: T_sat,
      pressure: sat.P,
      density: rho,
      phase: 'two-phase',
      quality,
      specificEnergy: u,
    };
  }

  // Single phase - determine which
  // Use energy to decide: liquid has u < ~1800 kJ/kg typically, vapor > ~2400 kJ/kg
  if (u < 1800000 && rho > 300) {
    return findLiquidState(rho, u);
  } else if (u > 2000000 || rho < 100) {
    return findVaporState(rho, u);
  } else {
    // Ambiguous region near critical - use density
    if (rho > RHO_CRIT) {
      return findLiquidState(rho, u);
    } else {
      return findVaporState(rho, u);
    }
  }
}

function findLiquidState(rho: number, u: number): WaterState {
  const T = T_REF + u / CV_LIQUID;
  const T_clamped = Math.max(T_TRIPLE, Math.min(T, T_CRIT - 1));
  const sat = interpSat(T_clamped);

  // Pressure: P >= P_sat, increase with compression
  let P = sat.P;
  const rho_sat = 1 / sat.v_f;
  if (rho > rho_sat) {
    const K = 100e6;  // Soft bulk modulus
    P = sat.P + K * (rho - rho_sat) / rho_sat;
  }
  P = Math.max(sat.P, Math.min(P, P_CRIT * 10));

  return { temperature: T, pressure: P, density: rho, phase: 'liquid', quality: 0, specificEnergy: u };
}

function findVaporState(rho: number, u: number): WaterState {
  // For vapor: P = ρ R T (ideal gas) and u = f(T, P)
  //
  // At low pressures, u ≈ u_ref + cv(T) * (T - T_ref)
  // At high pressures near saturation, real gas effects matter
  //
  // Strategy: Use ideal gas for P, then temperature from energy with
  // cv that accounts for pressure effects through saturation curve.

  const cv_0 = 1400;      // cv at 373K
  const alpha = 0.47;     // d(cv)/dT

  // Initial T from simple quadratic cv model: u = u_ref + cv_0*(T-T_ref) + α/2*(T-T_ref)²
  const u_ref = 2500000;  // reference internal energy (J/kg)
  const T_ref = 373;      // reference temperature (K)

  const du = u - u_ref;
  let T: number;

  if (du > 0) {
    // Solve: du = cv_0 * dT + (α/2) * dT²  for dT = T - T_ref
    // α/2 * dT² + cv_0 * dT - du = 0
    const disc = cv_0 * cv_0 + 2 * alpha * du;
    T = disc > 0 ? T_ref + (-cv_0 + Math.sqrt(disc)) / alpha : T_ref + du / cv_0;
  } else {
    // u below reference - find T from saturation curve
    // Binary search for T where u_g(T) matches
    let T_lo = T_TRIPLE, T_hi = T_ref;
    for (let iter = 0; iter < 20; iter++) {
      const T_mid = (T_lo + T_hi) / 2;
      const sat = interpSat(T_mid);
      if (u > sat.u_g) T_lo = T_mid;
      else T_hi = T_mid;
      if (T_hi - T_lo < 0.5) break;
    }
    T = (T_lo + T_hi) / 2;
  }

  T = Math.max(300, T);
  const P = Math.max(1000, rho * R_WATER * T);

  return { temperature: T, pressure: P, density: rho, phase: 'vapor', quality: 1, specificEnergy: u };
}

// ============================================================================
// Exported Saturation Functions
// ============================================================================

export function saturationPressure(T: number): number {
  if (T < T_TRIPLE) return 611.657 + 44.4 * (T - T_TRIPLE);
  if (T >= T_CRIT) return P_CRIT;
  return interpSat(T).P;
}

export function saturationTemperature(P: number): number {
  loadData();
  if (P >= P_CRIT) return T_CRIT;
  if (P < 611.657) return T_TRIPLE;

  // Binary search
  let lo = 0, hi = satCurve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (satCurve[mid].P <= P) lo = mid;
    else hi = mid;
  }
  const t = (P - satCurve[lo].P) / (satCurve[hi].P - satCurve[lo].P);
  return satCurve[lo].T + t * (satCurve[hi].T - satCurve[lo].T);
}

export function saturatedLiquidDensity(T: number): number {
  if (T >= T_CRIT) return RHO_CRIT;
  if (T < T_TRIPLE) return 1000;
  return 1 / interpSat(T).v_f;
}

export function saturatedVaporDensity(T: number): number {
  if (T >= T_CRIT) return RHO_CRIT;
  if (T < T_TRIPLE) return 0.005;
  return 1 / interpSat(T).v_g;
}

export function saturatedLiquidEnergy(T: number): number {
  if (T < T_TRIPLE) return 0;
  if (T >= T_CRIT) return 2000000;
  return interpSat(T).u_f;
}

export function saturatedVaporEnergy(T: number): number {
  if (T < T_TRIPLE) return 2500000;
  if (T >= T_CRIT) return 2000000;
  return interpSat(T).u_g;
}

export function latentHeat(T: number): number {
  if (T >= T_CRIT) return 0;
  const sat = interpSat(Math.max(T_TRIPLE, T));
  return sat.u_g - sat.u_f;
}

// ============================================================================
// Compatibility exports
// ============================================================================

export function liquidCv(T: number): number {
  return T > 600 ? CV_LIQUID * (1 + (T - 600) / (T_CRIT - 600) * 0.5) : CV_LIQUID;
}

export function vaporCv(T: number): number {
  return 1400 + 0.47 * Math.max(0, T - 373);
}

export function setWaterPropsDebug(enabled: boolean): void {}
export function getWaterPropsDebugLog(): string[] { return []; }

export function addEnergy(mass: number, energy: number, volume: number, added: number): WaterState {
  return calculateState(mass, energy + added, volume);
}

export function effectiveSpecificHeat(state: WaterState): number {
  if (state.phase === 'liquid') return liquidCv(state.temperature);
  if (state.phase === 'vapor') return vaporCv(state.temperature);
  return latentHeat(state.temperature) / 10;
}

export function energyFromTemperature(T: number, phase: 'liquid' | 'two-phase' | 'vapor', quality = 0): number {
  if (phase === 'liquid') return saturatedLiquidEnergy(T);
  if (phase === 'vapor') return saturatedVaporEnergy(T);
  const u_f = saturatedLiquidEnergy(T);
  const u_g = saturatedVaporEnergy(T);
  return u_f + quality * (u_g - u_f);
}

export function massFromDensityVolume(density: number, volume: number): number {
  return density * volume;
}

export interface StabilityInfo {
  regime: string;
  isStiff: boolean;
  characteristicTime: number;
  warnings: string[];
}

export function analyzeStability(state: WaterState, volume: number): StabilityInfo {
  const L = Math.cbrt(volume);
  const ct = state.phase === 'liquid' ? L / 1500 : L / 500;
  return { regime: state.phase, isStiff: state.phase === 'liquid', characteristicTime: ct, warnings: [] };
}

export function suggestMaxTimestep(state: WaterState, volume: number): number {
  return Math.max(1e-6, Math.min(analyzeStability(state, volume).characteristicTime * 0.1, 0.1));
}
