/**
 * Water/Steam Properties Module v4 - (u,v) Grid with Saturation Anchoring
 * 
 * Claude is no longer allowed to modify this file without explicit user approval in advance.
 *
 * This version uses a custom-built (u,v) grid from IAPWS-IF97 equations instead of
 * triangulating steam table data. The key improvements:
 *
 * 1. True (u,v) grid: Points are placed at specific (u,v) coordinates, not mapped from (T,P)
 * 2. Saturation anchoring: For compressed liquid near saturation, interpolation is
 *    anchored to the saturation line for stability
 * 3. Polynomial saturation fits: Fast evaluation of saturation properties from IAPWS
 * 4. No triangulation: Uses direct interpolation from nearby grid points
 *
 * Phase detection follows the principle: u < u_sat(v) → two-phase
 */

// ============================================================================
// Constants
// ============================================================================

const T_CRIT = 647.096;     // K
const P_CRIT = 22.064e6;    // Pa
const RHO_CRIT = 322;       // kg/m³
const T_TRIPLE = 273.16;    // K
const R_WATER = 461.5;      // J/kg-K
const CV_LIQUID = 4186;     // J/kg-K

// ============================================================================
// Data Types
// ============================================================================

export interface WaterState {
  temperature: number;    // K
  pressure: number;       // Pa
  density: number;        // kg/m³
  phase: 'liquid' | 'two-phase' | 'vapor';
  quality: number;        // 0-1 for two-phase, 0 for liquid, 1 for vapor
  specificEnergy: number; // J/kg
}

interface PolynomialFit {
  x_min: number;
  x_max: number;
  degree: number;
  coeffs: number[];  // [a_n, a_{n-1}, ..., a_1, a_0] (highest degree first)
}

interface SaturationDomeData {
  critical_point: {
    T_K: number;
    T_C: number;
    P_MPa: number;
    u_c: number;  // kJ/kg
    v_c: number;  // m³/kg
  };
  u_g_max: {
    T_K: number;
    u_g: number;  // kJ/kg
  };
  polynomials: {
    P_sat_from_T: PolynomialFit[];
    u_f_from_T: PolynomialFit[];
    v_f_from_T: PolynomialFit[];
    u_g_from_T: PolynomialFit[];
    v_g_from_T: PolynomialFit[];
    T_from_u_f: PolynomialFit[];
    T_from_u_g_ascending: PolynomialFit[];
    T_from_u_g_descending: PolynomialFit[];
  };
  raw_data: Array<{
    T_K: number;
    T_C: number;
    P_MPa: number;
    u_f: number;  // kJ/kg
    v_f: number;  // m³/kg
    u_g: number;  // kJ/kg
    v_g: number;  // m³/kg
    h_f?: number; // kJ/kg
    h_g?: number; // kJ/kg
  }>;
}

interface GridPoint {
  u: number;      // kJ/kg
  v: number;      // m³/kg
  T_K: number;    // K
  T_C: number;    // °C
  P_MPa: number;  // MPa
  region: 'compressed_liquid' | 'vapor' | 'supercritical';
  curve?: number; // For liquid curves, which offset curve (0 = closest to saturation)
}

interface GridData {
  n_points: number;
  points: GridPoint[];
}

// ============================================================================
// Module State
// ============================================================================

let saturationDome: SaturationDomeData | null = null;
let gridPoints: GridPoint[] = [];
let dataLoaded = false;

// Spatial index for grid lookup (by region)
interface SpatialIndex {
  liquidPoints: GridPoint[];
  vaporPoints: GridPoint[];
  supercriticalPoints: GridPoint[];
  // Grid cells for fast lookup in (logV, u) space
  liquidGrid: Map<string, GridPoint[]>;
  vaporGrid: Map<string, GridPoint[]>;
}

let spatialIndex: SpatialIndex | null = null;

// Grid cell parameters
const GRID_CELL_SIZE_LOGV = 0.1;  // ~26% change in v per cell
const GRID_CELL_SIZE_U = 50;      // 50 kJ/kg per cell

// ============================================================================
// Polynomial Evaluation
// ============================================================================

function evalPolynomial(x: number, fits: PolynomialFit[]): number {
  // Find the appropriate segment
  for (const fit of fits) {
    if (x >= fit.x_min && x <= fit.x_max) {
      // Evaluate polynomial: coeffs = [a_n, a_{n-1}, ..., a_1, a_0]
      let result = 0;
      for (const coeff of fit.coeffs) {
        result = result * x + coeff;
      }
      return result;
    }
  }

  // Extrapolate from nearest segment
  if (x < fits[0].x_min) {
    const fit = fits[0];
    let result = 0;
    for (const coeff of fit.coeffs) {
      result = result * x + coeff;
    }
    return result;
  } else {
    const fit = fits[fits.length - 1];
    let result = 0;
    for (const coeff of fit.coeffs) {
      result = result * x + coeff;
    }
    return result;
  }
}

// ============================================================================
// Saturation Property Functions
// ============================================================================

/**
 * Get saturation pressure from temperature (K).
 * @returns Pressure in Pa
 */
function P_sat_from_T(T_K: number): number {
  if (!saturationDome) throw new Error('Saturation dome not loaded');
  const P_MPa = evalPolynomial(T_K, saturationDome.polynomials.P_sat_from_T);
  return P_MPa * 1e6;
}

/**
 * Get saturated liquid internal energy from temperature (K).
 * @returns Internal energy in J/kg
 */
function u_f_from_T(T_K: number): number {
  if (!saturationDome) throw new Error('Saturation dome not loaded');
  const u_kJkg = evalPolynomial(T_K, saturationDome.polynomials.u_f_from_T);
  return u_kJkg * 1000;
}

/**
 * Get saturated liquid specific volume from temperature (K).
 * @returns Specific volume in m³/kg
 */
function v_f_from_T(T_K: number): number {
  if (!saturationDome) throw new Error('Saturation dome not loaded');
  return evalPolynomial(T_K, saturationDome.polynomials.v_f_from_T);
}

/**
 * Get saturated vapor internal energy from temperature (K).
 * @returns Internal energy in J/kg
 */
function u_g_from_T(T_K: number): number {
  if (!saturationDome) throw new Error('Saturation dome not loaded');
  const u_kJkg = evalPolynomial(T_K, saturationDome.polynomials.u_g_from_T);
  return u_kJkg * 1000;
}

/**
 * Get saturated vapor specific volume from temperature (K).
 * @returns Specific volume in m³/kg
 */
function v_g_from_T(T_K: number): number {
  if (!saturationDome) throw new Error('Saturation dome not loaded');
  return evalPolynomial(T_K, saturationDome.polynomials.v_g_from_T);
}

/**
 * Get temperature from saturated liquid internal energy.
 * @param u_f Internal energy in J/kg
 * @returns Temperature in K
 */
function T_from_u_f(u_f_Jkg: number): number {
  if (!saturationDome) throw new Error('Saturation dome not loaded');
  const u_kJkg = u_f_Jkg / 1000;
  return evalPolynomial(u_kJkg, saturationDome.polynomials.T_from_u_f);
}

// ============================================================================
// Dome Boundary in (u,v) Space
// ============================================================================

/**
 * Find u_sat at a given v by interpolating directly on the saturation dome data.
 * Uses log(v) interpolation for accuracy across the wide range of specific volumes.
 *
 * This is the ONLY valid way to determine the saturation boundary for phase detection.
 * (except if u < 400 we should check v_sat(u) instead)
 *
 * We do NOT test if a state is two-phase by checking for a T where x_v = x_u.
 *
 * NOTE: This function is currently unused - replaced by simpler findSaturationPropsAtV.
 * Kept for potential debugging/future use.
 */
// @ts-ignore - Intentionally unused, kept for debugging
function _findSaturationAtV(v: number): {
  u_sat_liquid: number | null;  // u_f at this v (if v is on liquid line)
  u_sat_vapor: number | null;   // u_g at this v (if v is on vapor line)
  T_liquid: number | null;
  T_vapor: number | null;
} | null {
  if (!saturationDome) return null;

  const rawData = saturationDome.raw_data;
  const v_c = saturationDome.critical_point.v_c;
  const u_c = saturationDome.critical_point.u_c * 1000; // Convert to J/kg
  const logV = Math.log(v);

  // At critical point, both lines meet
  if (Math.abs(v - v_c) < 1e-8) {
    return {
      u_sat_liquid: u_c,
      u_sat_vapor: u_c,
      T_liquid: T_CRIT,
      T_vapor: T_CRIT,
    };
  }

  const result: {
    u_sat_liquid: number | null;
    u_sat_vapor: number | null;
    T_liquid: number | null;
    T_vapor: number | null;
  } = {
    u_sat_liquid: null,
    u_sat_vapor: null,
    T_liquid: null,
    T_vapor: null,
  };

  // Check liquid line (v_f increases with index)
  // rawData is sorted by T, and v_f increases with T
  if (v <= v_c) {
    const v_f_min = rawData[0].v_f;
    const v_f_max = rawData[rawData.length - 1].v_f;

    if (v >= v_f_min && v <= v_f_max) {
      // Binary search for bracketing points on liquid line
      let lo = 0;
      let hi = rawData.length - 1;

      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (rawData[mid].v_f < v) {
          lo = mid;
        } else {
          hi = mid;
        }
      }

      // Interpolate in log(v) space between points lo and hi
      const v_f_lo = rawData[lo].v_f;
      const v_f_hi = rawData[hi].v_f;
      const logV_lo = Math.log(v_f_lo);
      const logV_hi = Math.log(v_f_hi);

      const t = (logV - logV_lo) / (logV_hi - logV_lo);

      // Interpolate u_f (in kJ/kg, convert to J/kg)
      const u_f_lo = rawData[lo].u_f * 1000;
      const u_f_hi = rawData[hi].u_f * 1000;
      result.u_sat_liquid = u_f_lo + t * (u_f_hi - u_f_lo);

      // Interpolate T
      const T_lo = rawData[lo].T_K;
      const T_hi = rawData[hi].T_K;
      result.T_liquid = T_lo + t * (T_hi - T_lo);
    }
  }

  // Check vapor line (v_g decreases with index)
  // rawData is sorted by T, and v_g decreases with T
  // Use v_c as lower bound since that's where vapor line ends at critical point
  if (v >= v_c) {
    const v_g_max = rawData[0].v_g;  // Largest v_g at lowest T
    const v_g_last = rawData[rawData.length - 1].v_g;  // Smallest v_g in data (near critical)

    if (v <= v_g_max) {
      // Check if v is smaller than the smallest v_g in data (between v_c and v_g_last)
      if (v < v_g_last) {
        // Extrapolate to critical point: interpolate between last data point and critical point
        const logV_last = Math.log(v_g_last);
        const logV_crit = Math.log(v_c);
        const t = (logV - logV_last) / (logV_crit - logV_last);

        // At critical point, u_g = u_c
        const u_g_last = rawData[rawData.length - 1].u_g * 1000;
        result.u_sat_vapor = u_g_last + t * (u_c - u_g_last);

        // Temperature approaches T_CRIT
        const T_last = rawData[rawData.length - 1].T_K;
        result.T_vapor = T_last + t * (T_CRIT - T_last);
      } else {
        // Normal case: v is within the data range, binary search
        let lo = 0;
        let hi = rawData.length - 1;

        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (rawData[mid].v_g > v) {
            lo = mid;
          } else {
            hi = mid;
          }
        }

        // Interpolate in log(v) space between points lo and hi
        // Note: v_g[lo] > v > v_g[hi]
        const v_g_lo = rawData[lo].v_g;
        const v_g_hi = rawData[hi].v_g;
        const logV_lo = Math.log(v_g_lo);
        const logV_hi = Math.log(v_g_hi);

        const t = (logV - logV_lo) / (logV_hi - logV_lo);

        // Interpolate u_g (in kJ/kg, convert to J/kg)
        const u_g_lo = rawData[lo].u_g * 1000;
        const u_g_hi = rawData[hi].u_g * 1000;
        result.u_sat_vapor = u_g_lo + t * (u_g_hi - u_g_lo);

        // Interpolate T
        const T_lo = rawData[lo].T_K;
        const T_hi = rawData[hi].T_K;
        result.T_vapor = T_lo + t * (T_hi - T_lo);
      }
    }
  }

  if (result.u_sat_liquid === null && result.u_sat_vapor === null) {
    // v is outside the range of both saturation lines (e.g., v > 206 m³/kg)
    return null;
  }

  return result;
}


/**
 * Find saturation properties at the temperature where v = v_g(T).
 * Returns u_g, T_sat, and P_sat at that temperature.
 *
 * Returns null if v is outside the saturation dome range.
 * Claude, do not modify this function without express user permission in advance.
 */
function findSaturationPropsAtV(v: number): { u_g: number; T_sat: number; P_sat: number } | null {
  if (!saturationDome) return null;

  const rawData = saturationDome.raw_data;
  const v_g_max = rawData[0].v_g;  // ~206 m³/kg at triple point
  //const v_c = saturationDome.critical_point.v_c;  // ~0.003 m³/kg
  const v_min_unique = rawData[0].v_f; //0.00100022; // From the steam table: this is v_sat at u=0.
  // If v > v_min_unique, then there is a unique u_sat(v). For lower v, there may be two. -Erick

  if (v > v_g_max || v < v_min_unique) {
    return null;
  }

  // Binary search for T where v_g(T) = v
  // v_g decreases with increasing T (index)
  let lo = 0;
  let hi = rawData.length - 1;

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (rawData[mid].v_g > v) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Interpolate between lo and hi
  const v_g_lo = rawData[lo].v_g;
  const v_g_hi = rawData[hi].v_g;
  const t = (v - v_g_lo) / (v_g_hi - v_g_lo);

  const u_g_lo = rawData[lo].u_g * 1000;  // Convert kJ/kg to J/kg
  const u_g_hi = rawData[hi].u_g * 1000;
  const T_lo = rawData[lo].T_K;
  const T_hi = rawData[hi].T_K;
  const P_lo = rawData[lo].P_MPa * 1e6;  // Convert MPa to Pa
  const P_hi = rawData[hi].P_MPa * 1e6;

  return {
    u_g: u_g_lo + t * (u_g_hi - u_g_lo),
    T_sat: T_lo + t * (T_hi - T_lo),
    P_sat: P_lo + t * (P_hi - P_lo),
  };
}

/**
 * Find u_sat on the saturation dome boundary for a given specific volume v.
 * Convenience wrapper around findSaturationPropsAtV.
 */
function findSaturationU(v: number): number | null {
  const props = findSaturationPropsAtV(v);
  return props ? props.u_g : null;
}

/**
 * Find v_sat on the saturated liquid line for a given specific internal energy u.
 * Only valid for low energy values (u < 50 kJ/kg) where the liquid line
 * curves back in (u,v) space.
 * 
 * Returns null if u is outside the valid range.
 */
function findSaturationV(u: number): number | null {
  if (!saturationDome) return null;

  // Only valid for low u values
  if (u > 50000) {  // 50 kJ/kg in J/kg
    return null;
  }

  const rawData = saturationDome.raw_data;

  // At low T, u_f increases with T, so we search the first few points
  // Find where u_f(T) = u
  let lo = 0;
  let hi = 0;

  // Find the range where u_f brackets our target u
  for (let i = 0; i < rawData.length - 1; i++) {
    const u_f = rawData[i].u_f * 1000;  // Convert to J/kg
    const u_f_next = rawData[i + 1].u_f * 1000;
    if (u_f <= u && u <= u_f_next) {
      lo = i;
      hi = i + 1;
      break;
    }
  }

  if (lo === hi) {
    return null;  // u not found in range
  }

  // Interpolate to find v_f
  const u_f_lo = rawData[lo].u_f * 1000;
  const u_f_hi = rawData[hi].u_f * 1000;
  const t = (u - u_f_lo) / (u_f_hi - u_f_lo);

  const v_f_lo = rawData[lo].v_f;
  const v_f_hi = rawData[hi].v_f;

  return v_f_lo + t * (v_f_hi - v_f_lo);
}

/**
 * Determine if a point (u, v) is inside the two-phase dome.
 * ==============================================================
 * EXPLICIT USER APPROVAL IS REQUIRED FOR CHANGES TO THIS SECTION
 * ==============================================================
 *
 * For a given v, we find the corresponding point on the saturation dome.
 * The saturation dome is one continuous curve in (v,u) space that includes both 
 * saturated liquid and saturated vapor points and the critical point. 
 *
 *
 * SPECIAL CASE: Near the triple point (u < 50 kJ/kg), water has its density anomaly
 * where v_f first decreases then increases with T (max density around 4°C).
 * This means a single v value can correspond to two different u_f values.
 * For this region, the state is two-phase if v > v_sat(u).
 * Everywhere else, a point is two-phase iff u < u_sat(v).
 */
function isInsideTwoPhaseDome(u: number, v: number): {
  inside: boolean;
} {
  if (!saturationDome) {
    throw new Error('Saturation dome data not loaded');
  }

  const rawData = saturationDome.raw_data;
  const v_f_min = rawData[0].v_f;  // ~0.001 m³/kg at triple point
  const v_g_max = rawData[0].v_g;  // ~206 m³/kg at triple point

  // Quick bounds check: v must be within [v_f_min, v_g_max]
  if (v < v_f_min || v > v_g_max) {
    return { inside: false };
  }

  // Saturation data is in kJ/kg, convert to J/kg for comparison with u
  const u_f_min = rawData[0].u_f * 1000;  // ~0 J/kg at triple point
  const u_g_triple = rawData[0].u_g * 1000;  // ~2375 kJ/kg at triple point

  // Check if it's below the triple point pressure (bottom edge of dome):
  // Linear interpolation between (v_f, u_f) and (v_g, u_g) at triple point
  const t = (v - v_f_min) / (v_g_max - v_f_min);
  const u_bottom = u_f_min + t * (u_g_triple - u_f_min);
  if (u < u_bottom) {
    return { inside: false };
  }

  // Special low energy check (u < 50 kJ/kg = 50000 J/kg):
  // At low u, the liquid line curves back in (u,v) space
  if (u < 50000) {
    const v_sat = findSaturationV(u);
    if (v_sat === null) {
      // u is outside the range where we can find v_sat - treat as outside dome
      return { inside: false };
    }
    // If v <= v_sat (on or left of liquid line), it's compressed liquid (outside dome)
    // If v > v_sat, it's inside the dome (two-phase)
    return { inside: v > v_sat };
  }

  // Normal case: check if u < u_sat(v)
  const u_sat = findSaturationU(v);
  if (u_sat === null) {
    // v is outside the range where we can find u_sat - treat as outside dome
    return { inside: false };
  }
  return { inside: u < u_sat };
}

// ============================================================================
// Two-Phase State Calculation
// ============================================================================

/**
 * Find the saturation temperature where x_v = x_u for a given (u, v) state.
 * This is where the state is consistent on the saturation dome.
 */
function findTwoPhaseState(u: number, v: number): {
  T: number;
  P: number;
  quality: number;
} | null {
  if (!saturationDome) {
    throw new Error('[WaterProps v4] Saturation dome not loaded in findTwoPhaseState');
  }

  // Binary search for T where x_v(T) = x_u(T)
  // x_v = (v - v_f) / (v_g - v_f)
  // x_u = (u - u_f) / (u_g - u_f)

  let T_lo = T_TRIPLE + 0.1;
  let T_hi = T_CRIT - 0.5;

  function calcQualityDiff(T: number): { x_v: number; x_u: number; diff: number } {
    const v_f = v_f_from_T(T);
    const v_g = v_g_from_T(T);
    const u_f = u_f_from_T(T);
    const u_g = u_g_from_T(T);

    const x_v = (v - v_f) / (v_g - v_f);
    const x_u = (u - u_f) / (u_g - u_f);

    return { x_v, x_u, diff: x_v - x_u };
  }

  let diff_lo = calcQualityDiff(T_lo);
  let diff_hi = calcQualityDiff(T_hi);

  // Check if there's a sign change
  if (diff_lo.diff * diff_hi.diff > 0) {
    // No crossing - not a valid two-phase state
    return null;
  }

  // Binary search
  for (let iter = 0; iter < 50; iter++) {
    const T_mid = (T_lo + T_hi) / 2;
    const diff_mid = calcQualityDiff(T_mid);

    if (Math.abs(diff_mid.diff) < 1e-6) {
      // Found it
      const quality = Math.max(0, Math.min(1, (diff_mid.x_v + diff_mid.x_u) / 2));
      return {
        T: T_mid,
        P: P_sat_from_T(T_mid),
        quality,
      };
    }

    if (diff_lo.diff * diff_mid.diff < 0) {
      T_hi = T_mid;
      diff_hi = diff_mid;
    } else {
      T_lo = T_mid;
      diff_lo = diff_mid;
    }

    if (T_hi - T_lo < 0.001) {
      const T_final = (T_lo + T_hi) / 2;
      const diff_final = calcQualityDiff(T_final);
      const quality = Math.max(0, Math.min(1, (diff_final.x_v + diff_final.x_u) / 2));
      return {
        T: T_final,
        P: P_sat_from_T(T_final),
        quality,
      };
    }
  }

  return null;
}

// ============================================================================
// Spatial Index for Grid Lookup
// ============================================================================

function getCellKey(logV: number, u_kJkg: number): string {
  const cellX = Math.floor(logV / GRID_CELL_SIZE_LOGV);
  const cellY = Math.floor(u_kJkg / GRID_CELL_SIZE_U);
  return `${cellX},${cellY}`;
}

function buildSpatialIndex(): void {
  if (gridPoints.length === 0) return;

  spatialIndex = {
    liquidPoints: [],
    vaporPoints: [],
    supercriticalPoints: [],
    liquidGrid: new Map(),
    vaporGrid: new Map(),
  };

  for (const pt of gridPoints) {
    const logV = Math.log10(pt.v);
    const key = getCellKey(logV, pt.u);

    if (pt.region === 'compressed_liquid') {
      spatialIndex.liquidPoints.push(pt);

      if (!spatialIndex.liquidGrid.has(key)) {
        spatialIndex.liquidGrid.set(key, []);
      }
      spatialIndex.liquidGrid.get(key)!.push(pt);
    } else if (pt.region === 'vapor') {
      spatialIndex.vaporPoints.push(pt);

      if (!spatialIndex.vaporGrid.has(key)) {
        spatialIndex.vaporGrid.set(key, []);
      }
      spatialIndex.vaporGrid.get(key)!.push(pt);
    } else {
      spatialIndex.supercriticalPoints.push(pt);
      // Supercritical goes in vapor grid for now
      if (!spatialIndex.vaporGrid.has(key)) {
        spatialIndex.vaporGrid.set(key, []);
      }
      spatialIndex.vaporGrid.get(key)!.push(pt);
    }
  }

  console.log(`[WaterProps v4] Spatial index built: ${spatialIndex.liquidPoints.length} liquid, ` +
    `${spatialIndex.vaporPoints.length} vapor, ${spatialIndex.supercriticalPoints.length} supercritical`);
}

// ============================================================================
// Grid-Based Interpolation
// ============================================================================

/**
 * Find nearby grid points for interpolation.
 * Uses spatial index for efficient lookup.
 */
function findNearbyPoints(u: number, v: number, phase: 'liquid' | 'vapor'): GridPoint[] {
  if (!spatialIndex) return [];

  const logV = Math.log10(v);
  const u_kJkg = u / 1000;

  const grid = phase === 'liquid' ? spatialIndex.liquidGrid : spatialIndex.vaporGrid;

  // Get points from current cell and neighboring cells
  const nearby: GridPoint[] = [];

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const cellX = Math.floor(logV / GRID_CELL_SIZE_LOGV) + dx;
      const cellY = Math.floor(u_kJkg / GRID_CELL_SIZE_U) + dy;
      const neighborKey = `${cellX},${cellY}`;

      const cellPoints = grid.get(neighborKey);
      if (cellPoints) {
        nearby.push(...cellPoints);
      }
    }
  }

  return nearby;
}

/**
 * Interpolate T and P from nearby grid points using inverse distance weighting.
 * For compressed liquid near saturation, uses saturation anchoring.
 */
function interpolateFromGrid(
  u: number,
  v: number,
  phase: 'liquid' | 'vapor'
): { T: number; P: number } | null {
  const nearby = findNearbyPoints(u, v, phase);

  if (nearby.length === 0) {
    return null;
  }

  const logV = Math.log10(v);
  const u_kJkg = u / 1000;

  // Calculate inverse distance weights
  // Use (logV, u) space with appropriate scaling
  let totalWeight = 0;
  let T_weighted = 0;
  let P_weighted = 0;

  // Scale factors to make logV and u comparable
  // logV range: about -3 to 2 (5 units)
  // u range: about 0 to 3300 kJ/kg (3300 units)
  // Scale u down by ~600 to make them comparable
  const U_SCALE = 1 / 600;

  for (const pt of nearby) {
    const pt_logV = Math.log10(pt.v);
    const dLogV = logV - pt_logV;
    const dU = (u_kJkg - pt.u) * U_SCALE;

    // Distance in normalized space
    const distSq = dLogV * dLogV + dU * dU;

    if (distSq < 1e-12) {
      // Almost exactly on a point
      return { T: pt.T_K, P: pt.P_MPa * 1e6 };
    }

    // Inverse distance weighting with power = 2
    const weight = 1 / distSq;
    totalWeight += weight;
    T_weighted += weight * pt.T_K;
    P_weighted += weight * pt.P_MPa;
  }

  if (totalWeight === 0) {
    return null;
  }

  return {
    T: T_weighted / totalWeight,
    P: (P_weighted / totalWeight) * 1e6,  // Convert MPa to Pa
  };
}

/**
 * Find saturation properties at a given u by interpolating directly on the raw data.
 * This is consistent with findSaturationAtV - both use the same raw data.
 */
function findSaturationAtU(u: number): {
  T_sat: number;
  v_f: number;
  P_sat: number;
} | null {
  if (!saturationDome) return null;

  const rawData = saturationDome.raw_data;
  const u_kJkg = u / 1000;  // Convert J/kg to kJ/kg

  // u_f increases with index (sorted by T, and u_f increases with T)
  const u_f_min = rawData[0].u_f;  // ~0 at triple point
  const u_f_max = rawData[rawData.length - 1].u_f;

  if (u_kJkg < u_f_min || u_kJkg > u_f_max) {
    return null;
  }

  // Binary search for bracketing points
  let lo = 0;
  let hi = rawData.length - 1;

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (rawData[mid].u_f < u_kJkg) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Linear interpolation between points lo and hi
  const u_f_lo = rawData[lo].u_f;
  const u_f_hi = rawData[hi].u_f;
  const t = (u_kJkg - u_f_lo) / (u_f_hi - u_f_lo);

  const T_sat = rawData[lo].T_K + t * (rawData[hi].T_K - rawData[lo].T_K);
  const v_f = rawData[lo].v_f + t * (rawData[hi].v_f - rawData[lo].v_f);
  const P_sat = (rawData[lo].P_MPa + t * (rawData[hi].P_MPa - rawData[lo].P_MPa)) * 1e6;  // Convert MPa to Pa

  return { T_sat, v_f, P_sat };
}

/**
 * Saturation-anchored interpolation for compressed liquid.
 *
 * Uses direct interpolation on raw saturation data (consistent with phase detection).
 * For compressed liquid, T ≈ T_sat(u) and P = P_sat + K * compression.
 */
function interpolateLiquidWithSaturationAnchor(
  u: number,
  v: number
): { T: number; P: number } | null {
  if (!saturationDome) {
    throw new Error('[WaterProps v4] Saturation dome not loaded in interpolateLiquidWithSaturationAnchor');
  }

  // Find saturation properties at this u by interpolating on raw data
  const satProps = findSaturationAtU(u);

  if (!satProps) {
    // u is outside saturation range - likely supercritical
    // Return null so caller can try grid interpolation
    return null;
  }

  const { T_sat, v_f, P_sat } = satProps;

  // Calculate how far we are from saturation
  const dv = v - v_f;  // Negative for compressed liquid (v < v_f)

  // Allow tiny tolerance for numerical precision (1e-9 relative, ~0.000001 mL/kg)
  const tolerance = v_f * 1e-9;
  if (dv > tolerance) {
    // We're above saturation volume - should have been caught as two-phase
    throw new Error(`[WaterProps v4] Liquid state has v=${(v*1e6).toFixed(6)} mL/kg > v_f=${(v_f*1e6).toFixed(6)} mL/kg at T=${T_sat.toFixed(3)} K, u=${(u/1e3).toFixed(6)} kJ/kg - should be two-phase, not liquid`);
  }

  // We're compressed. Use bulk modulus to estimate pressure.
  // For compressed liquid, temperature is nearly independent of pressure
  // (liquid is nearly incompressible), so T ≈ T_sat(u).
  //
  // Pressure increases with compression: P = P_sat + K * |dv/v|
  // where K is the bulk modulus, which varies with temperature.

  const T_C = T_sat - 273.15;
  const K = bulkModulus(T_C);  // Pa

  // Compression ratio (positive for compressed liquid)
  const compressionRatio = Math.abs(dv) / v_f;

  // Pressure from compression
  const P = P_sat + K * compressionRatio;

  // Temperature: liquid u(T) is nearly independent of P
  const T = T_sat;

  return { T, P };
}

/**
 * Bulk modulus data for saturated liquid water.
 * Source: IAPWS-IF97 at saturation pressure.
 * Format: [temperature °C, bulk modulus MPa]
 */
const BULK_MODULUS_DATA: [number, number][] = [
  [0.01, 1964.64],
  [10, 2091.18],
  [20, 2178.65],
  [30, 2233.14],
  [40, 2259.89],
  [50, 2263.47],
  [60, 2246.69],
  [70, 2213.37],
  [80, 2166.38],
  [90, 2107.93],
  [100, 2039.98],
  [110, 1964.25],
  [120, 1882.18],
  [130, 1795.33],
  [140, 1705.03],
  [150, 1611.86],
  [160, 1516.76],
  [170, 1420.66],
  [180, 1323.98],
  [190, 1227.75],
  [200, 1132.25],
  [210, 1037.99],
  [220, 945.18],
  [230, 855.43],
  [240, 767.46],
  [250, 682.59],
  [260, 600.96],
  [270, 523.01],
  [280, 448.63],
  [290, 378.50],
  [300, 312.70],
  [310, 251.51],
  [320, 195.35],
  [330, 144.51],
  [340, 99.21],
  [350, 59.56],
  [360, 26.68],
];

/**
 * Temperature-dependent bulk modulus for liquid water.
 * Uses linear interpolation on tabulated IAPWS-IF97 data.
 */
export function bulkModulus(T_C: number): number {
  const data = BULK_MODULUS_DATA;

  // Clamp to data range
  if (T_C <= data[0][0]) {
    return data[0][1] * 1e6; // Convert MPa to Pa
  }
  if (T_C >= data[data.length - 1][0]) {
    return data[data.length - 1][1] * 1e6;
  }

  // Binary search for bracket
  let lo = 0, hi = data.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (data[mid][0] <= T_C) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Linear interpolation
  const [T1, K1] = data[lo];
  const [T2, K2] = data[hi];
  const t = (T_C - T1) / (T2 - T1);
  const K_MPa = K1 + t * (K2 - K1);

  return K_MPa * 1e6; // Convert MPa to Pa
}

/**
 * Get bulk modulus with optional numerical softening.
 * The numerical limit prevents extreme stiffness at low temperatures
 * which can cause instability in the pressure-flow solver.
 *
 * @param T_celsius - Temperature in degrees Celsius
 * @param K_max - Maximum allowed bulk modulus in Pa (undefined = no limit)
 * @returns Bulk modulus in Pa
 */
export function numericalBulkModulus(T_celsius: number, K_max?: number): number {
  const K_physical = bulkModulus(T_celsius);

  if (K_max === undefined || K_physical <= K_max) {
    return K_physical;
  }

  // Smooth transition using tanh blending (C-infinity smooth)
  const blend_width = K_max * 0.2; // 20% transition zone
  const x = (K_physical - K_max) / blend_width;
  const blend = 0.5 * (1 - Math.tanh(x));

  return K_max + blend * (K_physical - K_max);
}

// ============================================================================
// High-Temperature Vapor (Ideal Gas Approximation)
// ============================================================================

/**
 * Ideal gas approximation for superheated vapor outside the steam table grid.
 *
 * Valid regions:
 *   - v > 100 m³/kg AND u > u_sat(v) (low pressure superheated vapor)
 *   - v > 10 m³/kg AND u > 2800 kJ/kg (high temperature, sparse grid region)
 *
 * To avoid discontinuity at the transition from steam tables, we anchor the
 * approximation to saturation curve values:
 *   - T = T_sat + (u - u_g) / cv
 *   - P = Z * rho * R * T, where Z is calibrated to match P_sat at the boundary
 */
function idealGasApproximation(u: number, v: number): { T: number; P: number } {
  const rho = 1 / v;
  const cv_steam = 1500;  // J/(kg·K) - approximate cv for superheated steam

  // Check valid range
  const u_kJ = u / 1000;  // Convert to kJ/kg for comparison
  const inLowPressureRegion = v > 100;
  const inHighTempRegion = v > 10 && u_kJ > 2800;

  if (!inLowPressureRegion && !inHighTempRegion) {
    throw new Error(
      `[WaterProps v4] idealGasApproximation called outside valid range: ` +
      `u=${u_kJ.toFixed(2)} kJ/kg, v=${v.toFixed(4)} m³/kg. ` +
      `Valid regions: (v > 100 m³/kg) OR (v > 10 m³/kg AND u > 2800 kJ/kg).`
    );
  }

  // Get saturation properties at the boundary (or nearest saturation point)
  // For v > v_g_max (~206 m³/kg), use triple point as reference
  let satProps = findSaturationPropsAtV(v);

  if (!satProps) {
    // v is beyond saturation curve (v > 206 m³/kg), use triple point
    if (!saturationDome) {
      throw new Error('[WaterProps v4] Saturation dome not loaded in idealGasApproximation');
    }
    const triple = saturationDome.raw_data[0];
    satProps = {
      u_g: triple.u_g * 1000,  // Convert to J/kg
      T_sat: triple.T_K,
      P_sat: triple.P_MPa * 1e6,  // Convert to Pa
    };
  }

  // Check that u is above saturation (superheated)
  if (u < satProps.u_g && inLowPressureRegion) {
    throw new Error(
      `[WaterProps v4] idealGasApproximation called for sub-saturation energy: ` +
      `u=${u_kJ.toFixed(2)} kJ/kg < u_g=${(satProps.u_g/1000).toFixed(2)} kJ/kg at v=${v.toFixed(4)} m³/kg. ` +
      `This state should be two-phase, not ideal gas.`
    );
  }

  // Calculate temperature: T = T_sat + (u - u_g) / cv
  const T = satProps.T_sat + (u - satProps.u_g) / cv_steam;

  // Calculate compressibility factor Z to match P_sat at the saturation point
  // At saturation: P_sat = Z * rho_sat * R * T_sat
  // So: Z = P_sat / (rho_sat * R * T_sat)
  const rho_sat = 1 / v;  // Use current v as reference density
  const Z = satProps.P_sat / (rho_sat * R_WATER * satProps.T_sat);

  // Calculate pressure using the calibrated Z
  const P = Z * rho * R_WATER * T;

  return { T, P };
}

// ============================================================================
// Data Loading
// ============================================================================

// Node.js modules (loaded dynamically to avoid bundler issues)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nodeFs: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nodePath: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nodeUrl: any;

// Initialize Node.js modules using top-level await (works in ESM)
try {
  if (typeof window === 'undefined') {
    // Node.js environment - load modules dynamically
    // Using string concatenation to prevent Vite from trying to bundle these
    const fsModule = 'fs';
    const pathModule = 'path';
    const urlModule = 'url';
    nodeFs = await import(/* @vite-ignore */ fsModule);
    nodePath = await import(/* @vite-ignore */ pathModule);
    nodeUrl = await import(/* @vite-ignore */ urlModule);
  }
} catch {
  // Browser or unsupported environment - ignore
}

async function loadSaturationDome(): Promise<void> {
  const isBrowser = typeof window !== 'undefined';

  try {
    let content: string;

    if (isBrowser) {
      const response = await fetch('/saturation_dome_iapws.json');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      content = await response.text();
    } else {
      // Node.js - use pre-loaded modules
      if (!nodeFs || !nodePath || !nodeUrl) {
        throw new Error('Node.js modules not loaded - ensure top-level await completed');
      }
      const __filename = nodeUrl.fileURLToPath(import.meta.url);
      const __dirname = nodePath.dirname(__filename);
      const dataPath = nodePath.resolve(__dirname, '../../scripts/saturation_dome_iapws.json');
      content = nodeFs.readFileSync(dataPath, 'utf-8');
    }

    saturationDome = JSON.parse(content);
    console.log(`[WaterProps v4] Loaded saturation dome: ${saturationDome!.raw_data.length} points`);
  } catch (e) {
    console.error('[WaterProps v4] Failed to load saturation dome:', e);
    throw e;
  }
}

async function loadGridData(): Promise<void> {
  const isBrowser = typeof window !== 'undefined';

  try {
    let content: string;

    if (isBrowser) {
      const response = await fetch('/uv_grid_data_v13_filtered.json');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      content = await response.text();
    } else {
      // Node.js - use pre-loaded modules
      if (!nodeFs || !nodePath || !nodeUrl) {
        throw new Error('Node.js modules not loaded - ensure top-level await completed');
      }
      const __filename = nodeUrl.fileURLToPath(import.meta.url);
      const __dirname = nodePath.dirname(__filename);
      const dataPath = nodePath.resolve(__dirname, '../../scripts/uv_grid_data_v13_filtered.json');
      content = nodeFs.readFileSync(dataPath, 'utf-8');
    }

    const data: GridData = JSON.parse(content);
    gridPoints = data.points;
    console.log(`[WaterProps v4] Loaded grid data: ${gridPoints.length} points`);

    // Build spatial index
    buildSpatialIndex();
  } catch (e) {
    console.error('[WaterProps v4] Failed to load grid data:', e);
    throw e;
  }
}

function loadDataSync(): void {
  if (dataLoaded) return;

  // For synchronous loading in browser, use XMLHttpRequest
  const isBrowser = typeof window !== 'undefined';

  if (isBrowser) {
    // Load saturation dome
    {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/saturation_dome_iapws.json', false);
      xhr.send();
      if (xhr.status === 200) {
        saturationDome = JSON.parse(xhr.responseText);
      } else {
        throw new Error(`Failed to load saturation dome: HTTP ${xhr.status}`);
      }
    }

    // Load grid data
    {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/uv_grid_data_v13_filtered.json', false);
      xhr.send();
      if (xhr.status === 200) {
        const data: GridData = JSON.parse(xhr.responseText);
        gridPoints = data.points;
      } else {
        throw new Error(`Failed to load grid data: HTTP ${xhr.status}`);
      }
    }
  } else {
    // Node.js - use pre-loaded modules
    if (!nodeFs || !nodePath || !nodeUrl) {
      throw new Error('Node.js modules not loaded - ensure top-level await completed');
    }

    const __filename = nodeUrl.fileURLToPath(import.meta.url);
    const __dirname = nodePath.dirname(__filename);
    const scriptsDir = nodePath.resolve(__dirname, '../../scripts');

    const domeContent = nodeFs.readFileSync(nodePath.join(scriptsDir, 'saturation_dome_iapws.json'), 'utf-8');
    saturationDome = JSON.parse(domeContent);

    const gridContent = nodeFs.readFileSync(nodePath.join(scriptsDir, 'uv_grid_data_v13_filtered.json'), 'utf-8');
    const data: GridData = JSON.parse(gridContent);
    gridPoints = data.points;
  }

  buildSpatialIndex();
  dataLoaded = true;

  console.log(`[WaterProps v4] Data loaded: ${saturationDome?.raw_data.length} saturation points, ${gridPoints.length} grid points`);
}

// ============================================================================
// Main State Calculation
// ============================================================================

export function calculateState(mass: number, internalEnergy: number, volume: number): WaterState {
  loadDataSync();

  const rho = mass / volume;
  const v = volume / mass;  // Specific volume (m³/kg)
  const u = internalEnergy / mass;  // Specific internal energy (J/kg)

  // Validate inputs - no fallbacks, fail loudly
  if (!isFinite(rho) || rho <= 0) {
    throw new Error(`[WaterProps v4] Invalid density: rho=${rho} kg/m³ (mass=${mass} kg, volume=${volume} m³)`);
  }
  if (!isFinite(u)) {
    throw new Error(`[WaterProps v4] Invalid specific energy: u=${u} J/kg (internalEnergy=${internalEnergy} J, mass=${mass} kg)`);
  }
  if (v <= 0) {
    throw new Error(`[WaterProps v4] Invalid specific volume: v=${v} m³/kg (volume=${volume} m³, mass=${mass} kg)`);
  }

  // Phase detection: check if inside two-phase dome
  const domeCheck = isInsideTwoPhaseDome(u, v);

  if (domeCheck.inside) {
    // Two-phase: find consistent T, P, quality
    const twoPhase = findTwoPhaseState(u, v);

    if (twoPhase) {
      return {
        temperature: twoPhase.T,
        pressure: twoPhase.P,
        density: rho,
        phase: 'two-phase',
        quality: twoPhase.quality,
        specificEnergy: u,
      };
    }
    // If we get here, dome check said inside but findTwoPhaseState couldn't find consistent T.
    // This should not happen if dome check is correct. Throw an error.
    throw new Error(
      `[WaterProps v4] Inconsistent dome check: isInsideTwoPhaseDome returned true but ` +
      `findTwoPhaseState failed. u=${(u/1e3).toFixed(2)} kJ/kg, v=${(v*1e6).toFixed(2)} mL/kg. ` +
      `This indicates a bug in the dome detection logic.`
    );
  }

  // Single-phase: determine liquid vs vapor
  // But first, check for thermodynamically impossible states that indicate simulation errors.
  //
  // A state is impossible if it has:
  // - Compressed liquid density (v < v_f_min) with vapor-like energy (u >> u_f_max)
  //
  // These combinations cannot physically exist and indicate mass/energy balance errors.
  // This check was too strict, now should be ok. It was ruling out high pressure supercritical states that are in the steam table. -Erick
  const rawData = saturationDome!.raw_data;
  const v_f_max = 0.002; //rawData[rawData.length - 1].v_f;        // ~0.00288 m³/kg at critical point
  const u_g_min = 2195.0; //rawData[rawData.length - 1].u_g * 1000; // ~2056 kJ/kg at critical point

  // Check for impossible compressed-liquid-density + vapor-energy state
  if (v < v_f_max && u > u_g_min) {
    throw new Error(
      `[WaterProps v4] IMPOSSIBLE STATE: Compressed liquid density with vapor-like energy.\n` +
      `  v=${(v * 1e6).toFixed(2)} mL/kg (< v_f_max=${(v_f_max * 1e6).toFixed(2)} mL/kg at critical point)\n` +
      `  u=${(u / 1e3).toFixed(2)} kJ/kg (> u_g_min=${(u_g_min / 1e3).toFixed(2)} kJ/kg at critical point)\n` +
      `  This combination is thermodynamically impossible.\n` +
      `  Check mass/energy balance in the simulation - likely a flow or NCG calculation error.`
    );
  }

  // Check for states below the triple point pressure, which are ice-vapor mixes.
  const v_f_min = rawData[0].v_f;  // ~0.001 m³/kg at triple point
  const v_g_max = rawData[0].v_g;  // ~206 m³/kg at triple point

  // Saturation data is in kJ/kg, convert to J/kg for comparison with u
  const u_f_min = rawData[0].u_f * 1000;  // ~0 J/kg at triple point
  const u_g_triple = rawData[0].u_g * 1000;  // ~2375 kJ/kg at triple point

  // Check if it's below the triple point pressure (bottom edge of dome):
  // Linear interpolation between (v_f, u_f) and (v_g, u_g) at triple point
  const t = (v - v_f_min) / (v_g_max - v_f_min);
  const u_bottom = u_f_min + t * (u_g_triple - u_f_min);
  if (u < u_bottom) {
    let x_est = (v - v_f_min) / (v_g_max - v_f_min)
    if (x_est < 1.0) { // later maybe we change this so high-quality ice-vapor mix acts like vapor.
      throw new Error(
        `[WaterProps v4] IMPOSSIBLE STATE: below triple point with substantial ice component.\n` +
        `  v=${(v * 1e6).toFixed(2)} mL/kg (< v_f_max=${(v_f_max * 1e6).toFixed(2)} mL/kg at critical point)\n` +
        `  u=${(u / 1e3).toFixed(2)} kJ/kg (> u_g_min=${(u_g_min / 1e3).toFixed(2)} kJ/kg at critical point)\n` +
        `  Check mass/energy balance in the simulation - likely a flow or NCG calculation error.`
      );
    }
  }

  // Primary criterion is density - liquid is much denser than vapor
  // Use density relative to critical as the main check
  // Secondary check for low-energy states that might have intermediate density
  const v_crit = saturationDome?.critical_point.v_c ?? 0.00288;
  const isLiquid = rho > 0.5 * RHO_CRIT && v < v_crit * 2;  // Must be dense AND not too expanded
  const phase: 'liquid' | 'vapor' = isLiquid ? 'liquid' : 'vapor';

  let T: number;
  let P: number;
  let calculationPath: string = 'unknown';

  if (phase === 'liquid') {
    // Try saturation-anchored interpolation for liquid first
    // This may fail for supercritical states (u above critical energy)
    let result: { T: number; P: number } | null = null;
    try {
      result = interpolateLiquidWithSaturationAnchor(u, v);
    } catch {
      // Saturation anchor failed - likely supercritical, will try grid below
    }

    if (result) {
      T = result.T;
      P = result.P;
      calculationPath = 'liquid_saturation_anchor';
    } else {
      // Saturation-anchored failed (likely supercritical) - try grid interpolation
      // Supercritical points are stored in the vapor grid, so try vapor first
      let gridResult = interpolateFromGrid(u, v, 'vapor');
      if (gridResult) {
        T = gridResult.T;
        P = gridResult.P;
        calculationPath = 'supercritical_grid_vapor';
      } else {
        // Try liquid grid as fallback
        gridResult = interpolateFromGrid(u, v, 'liquid');
        if (gridResult) {
          T = gridResult.T;
          P = gridResult.P;
          calculationPath = 'supercritical_grid_liquid';
        } else {
          throw new Error(`[WaterProps v4] Liquid/supercritical interpolation failed: u=${(u/1e3).toFixed(2)} kJ/kg, v=${(v*1e6).toFixed(2)} mL/kg, rho=${rho.toFixed(1)} kg/m³`);
        }
      }
    }
  } else {
    // Vapor: use grid interpolation first
    const gridResult = interpolateFromGrid(u, v, 'vapor');

    if (gridResult) {
      T = gridResult.T;
      P = gridResult.P;
      calculationPath = 'vapor_grid';
    } else {
      // ========================================================================
      // DO NOT ADD A FALLBACK HERE
      // ========================================================================
      // If vapor grid interpolation fails, the simulation has produced a state
      // that is outside the valid range of our steam table data.
      //
      // DO NOT use "near saturation" approximations.
      // DO NOT use ideal gas for states that should be in the grid.
      //
      // The ONLY acceptable use of ideal gas is for very low density vapor
      // (v > 100 m³/kg) which is physically outside the steam table range.
      // ========================================================================

      const v_g_max = 206;  // m³/kg at triple point
      if (v > v_g_max * 0.5) {
        // Very low density vapor - use ideal gas approximation
        const idealResult = idealGasApproximation(u, v);
        T = idealResult.T;
        P = idealResult.P;
        calculationPath = 'vapor_ideal_gas';
      } else {
        throw new Error(
          `[WaterProps v4] Vapor grid interpolation failed: u=${(u/1e3).toFixed(2)} kJ/kg, v=${(v*1e6).toFixed(2)} mL/kg, rho=${rho.toFixed(1)} kg/m³. ` +
          `This state is outside the valid range of the steam table grid. ` +
          `Check simulation mass/energy balance.`
        );
      }
    }
  }

  // Validate results - no clamping, fail if out of range
  // For ideal gas path (very low density vapor), allow much lower pressures
  const minPressure = calculationPath === 'vapor_ideal_gas' ? 0.1 : 1000;  // 0.1 Pa for ideal gas, 1000 Pa otherwise
  if (P < minPressure || P > P_CRIT * 10) {
    throw new Error(`[WaterProps v4] Pressure out of range: P=${(P/1e6).toFixed(4)} MPa (u=${(u/1e3).toFixed(2)} kJ/kg, v=${(v*1e6).toFixed(2)} mL/kg, path=${calculationPath})`);
  }
  if (T < T_TRIPLE || T > 3000) {
    throw new Error(`[WaterProps v4] Temperature out of range: T=${T.toFixed(2)} K (u=${(u/1e3).toFixed(2)} kJ/kg, v=${(v*1e6).toFixed(2)} mL/kg)`);
  }

  // Debug tracking for pressure jumps
  if (debugNodeId) {
    trackDebugState(debugNodeId, u, v, T, P, phase, calculationPath);
  }

  return {
    temperature: T,
    pressure: P,
    density: rho,
    phase,
    quality: phase === 'vapor' ? 1 : 0,
    specificEnergy: u,
  };
}

// ============================================================================
// Exported Saturation Functions
// ============================================================================

export function saturationPressure(T: number): number {
  loadDataSync();
  return P_sat_from_T(T);
}

export function saturationTemperature(P: number): number {
  loadDataSync();
  if (!saturationDome) throw new Error('Saturation dome not loaded');

  // Binary search on raw data
  const rawData = saturationDome.raw_data;
  const P_MPa = P / 1e6;

  let lo = 0, hi = rawData.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rawData[mid].P_MPa <= P_MPa) lo = mid;
    else hi = mid;
  }

  if (lo === hi) return rawData[lo].T_K;

  const t = (P_MPa - rawData[lo].P_MPa) / (rawData[hi].P_MPa - rawData[lo].P_MPa);
  return rawData[lo].T_K + t * (rawData[hi].T_K - rawData[lo].T_K);
}

export function saturatedLiquidDensity(T: number): number {
  loadDataSync();
  const v_f = v_f_from_T(T);
  return 1 / v_f;
}

export function saturatedVaporDensity(T: number): number {
  loadDataSync();
  const v_g = v_g_from_T(T);
  return 1 / v_g;
}

export function saturatedLiquidEnergy(T: number): number {
  loadDataSync();
  return u_f_from_T(T);
}

export function saturatedVaporEnergy(T: number): number {
  loadDataSync();
  return u_g_from_T(T);
}

export function latentHeat(T: number): number {
  loadDataSync();
  return u_g_from_T(T) - u_f_from_T(T);
}

export function saturatedLiquidEnthalpy(P: number): number {
  loadDataSync();
  const T = saturationTemperature(P);
  const u_f = u_f_from_T(T);
  const v_f = v_f_from_T(T);
  return u_f + P * v_f;  // h = u + Pv
}

export function saturatedVaporEnthalpy(P: number): number {
  loadDataSync();
  const T = saturationTemperature(P);
  const u_g = u_g_from_T(T);
  const v_g = v_g_from_T(T);
  return u_g + P * v_g;
}

export function latentHeatEnthalpy(P: number): number {
  return saturatedVaporEnthalpy(P) - saturatedLiquidEnthalpy(P);
}

// ============================================================================
// Compatibility Functions
// ============================================================================

export function liquidCv(_T: number): number {
  return CV_LIQUID;
}

export function vaporCv(T: number): number {
  return 1400 + 0.47 * Math.max(0, T - 373);
}

export async function preloadWaterProperties(): Promise<void> {
  if (dataLoaded) return;

  console.log('[WaterProps v4] Preloading water properties...');

  await loadSaturationDome();
  await loadGridData();

  dataLoaded = true;
  console.log('[WaterProps v4] Preload complete');
}

export function isWaterPropertiesLoaded(): boolean {
  return dataLoaded;
}

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

// Profiling stubs
export interface WaterPropsProfile {
  calculateStateCalls: number;
  calculateStateCacheHits: number;
  calculateStateTime: number;
  pressureFeedbackCalls: number;
  pressureFeedbackTime: number;
}

export function getWaterPropsProfile(): WaterPropsProfile {
  return {
    calculateStateCalls: 0,
    calculateStateCacheHits: 0,
    calculateStateTime: 0,
    pressureFeedbackCalls: 0,
    pressureFeedbackTime: 0,
  };
}

export function resetWaterPropsProfile(): void {}
export function clearStateCache(): void {}
export function setWaterPropsDebug(_enabled: boolean): void {}
export function getWaterPropsDebugLog(): string[] { return []; }

// Debug utilities
let debugNodeId: string | null = null;
let debugPressureJumpThreshold = 0.5; // Log if pressure changes by more than 50%
const pressureHistory = new Map<string, { P: number; phase: string; u: number; v: number }>();

export function setDebugNodeId(nodeId: string | null): void {
  debugNodeId = nodeId;
}

export function clearPressureHistory(): void {
  pressureHistory.clear();
}

/**
 * Track state changes for a specific node and log pressure jumps
 */
function trackDebugState(
  nodeId: string,
  u: number,
  v: number,
  T: number,
  P: number,
  phase: string,
  calculationPath: string
): void {
  const prev = pressureHistory.get(nodeId);

  if (prev) {
    const pressureRatio = P / prev.P;
    const phaseChanged = phase !== prev.phase;

    if (phaseChanged || pressureRatio > (1 + debugPressureJumpThreshold) || pressureRatio < 1 / (1 + debugPressureJumpThreshold)) {
      const jumpType = phaseChanged ? `PHASE TRANSITION (${prev.phase}→${phase})` : 'PRESSURE JUMP';

      console.warn(`[${jumpType}] Node ${nodeId}: ${(prev.P/1e5).toFixed(2)} bar → ${(P/1e5).toFixed(2)} bar (${((pressureRatio-1)*100).toFixed(0)}% change)`);
      console.warn(`  Path: ${calculationPath}`);
      console.warn(`  Previous: u=${(prev.u/1e3).toFixed(2)} kJ/kg, v=${(prev.v*1e6).toFixed(2)} mL/kg`);
      console.warn(`  Current:  u=${(u/1e3).toFixed(2)} kJ/kg, v=${(v*1e6).toFixed(2)} mL/kg`);
      console.warn(`  T=${(T-273.15).toFixed(1)}°C, ρ=${(1/v).toFixed(1)} kg/m³`);
    }
  }

  pressureHistory.set(nodeId, { P, phase, u, v });
}

// Debug/calculation logging stubs (compatibility with v3)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function enableCalculationDebug(_enabled: boolean): void {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCalculationDebugLog(): any[] { return []; }

/**
 * Lookup compressed liquid density from (P, u).
 * Uses saturation curve + bulk modulus compression.
 */
export function lookupCompressedLiquidDensity(P: number, u: number): number | null {
  loadDataSync();

  // Estimate temperature from energy
  const T = T_from_u_f(u);
  if (!isFinite(T) || T < T_TRIPLE || T > T_CRIT) {
    return null;
  }

  // Get saturation density at this temperature
  const v_f = v_f_from_T(T);
  const P_sat = P_sat_from_T(T);

  if (P <= P_sat) {
    // At or below saturation - return saturation liquid density
    return 1 / v_f;
  }

  // Compressed liquid: use bulk modulus
  const T_C = T - 273.15;
  const K = bulkModulus(T_C);
  const dP = P - P_sat;
  const compressionRatio = dP / K;
  const v = v_f * (1 - compressionRatio);

  return 1 / v;
}

/**
 * Lookup pressure from (u, v) for liquid.
 * Uses saturation-anchored interpolation.
 */
export function lookupPressureFromUV(u: number, v: number): number | null {
  loadDataSync();

  const result = interpolateLiquidWithSaturationAnchor(u, v);
  return result ? result.P : null;
}

export interface SaturationDistanceResult {
  distance: number;
  v_mLkg: number;
  u_kJkg: number;
  P_sat_closest: number;
  v_f_closest: number;
}

export function distanceToSaturationLine(u_Jkg: number, v_m3kg: number): SaturationDistanceResult {
  loadDataSync();

  const v_mLkg = v_m3kg * 1e6;
  const u_kJkg = u_Jkg / 1000;

  // Find saturation state at this u
  const T_sat = T_from_u_f(u_Jkg);
  const v_f = v_f_from_T(T_sat);
  const P_sat = P_sat_from_T(T_sat);

  const v_f_mLkg = v_f * 1e6;
  const dv = v_mLkg - v_f_mLkg;

  // Distance in mL/kg (same scale as u in kJ/kg)
  const distance = dv < 0 ? Math.abs(dv) : -Math.abs(dv);

  return {
    distance,
    v_mLkg,
    u_kJkg,
    P_sat_closest: P_sat,
    v_f_closest: v_f_mLkg,
  };
}

export interface StabilityInfo {
  regime: string;
  isStiff: boolean;
  characteristicTime: number;
  warnings: string[];
}

export function analyzeStability(state: WaterState, volume: number): StabilityInfo {
  // Use thermal diffusion timescale, not acoustic timescale
  // Thermal equilibration happens on timescales of seconds, not microseconds
  const L = Math.cbrt(volume);  // characteristic length
  const alpha = 1.5e-7;  // thermal diffusivity of water (m²/s)
  const thermalTime = L * L / alpha;

  const warnings: string[] = [];
  let regime = 'normal';

  if (state.phase === 'two-phase') {
    regime = 'two-phase';
    if (state.quality > 0.9) {
      warnings.push('High quality - approaching dry-out');
    }
  } else if (state.temperature > 600) {
    regime = 'high-temperature';
    warnings.push('High temperature - near critical region');
  }

  return {
    regime,
    isStiff: thermalTime < 0.01,  // Stiff if thermal time < 10ms
    characteristicTime: thermalTime,
    warnings,
  };
}

export function suggestMaxTimestep(_state: WaterState, _volume: number): number {
  return 0.1;
}
