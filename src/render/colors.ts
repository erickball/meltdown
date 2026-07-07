import { Fluid } from '../types';
import {
  saturationTemperature,
  saturatedLiquidDensity,
  saturatedVaporDensity,
  saturatedLiquidEnergy,
  saturatedVaporEnergy,
  vaporCv
} from '../simulation/water-properties';
import {
  GasComposition,
  GasSpecies,
  GAS_PROPERTIES,
  ALL_GAS_SPECIES,
  totalMoles,
  R_GAS,
} from '../simulation/gas-properties';

/**
 * Get the steam partial pressure from a fluid state.
 * For fluids with NCG, total pressure = steam + NCG, so we subtract NCG.
 * This is needed for saturation calculations which depend on steam pressure, not total.
 *
 * @param totalPressure - Total pressure (Pa)
 * @param ncg - NCG composition (if any)
 * @param temperature - Temperature (K)
 * @param volume - Volume (m³)
 */
function getSteamPartialPressure(
  totalPressure: number,
  ncg: GasComposition | undefined,
  temperature: number,
  volume: number
): number {
  if (!ncg || volume <= 0) return totalPressure;
  const ncgMoles = totalMoles(ncg);
  if (ncgMoles <= 0) return totalPressure;
  const P_ncg = ncgMoles * R_GAS * temperature / volume;
  return Math.max(0, totalPressure - P_ncg);
}

// Temperature color mapping for fluids
// Water: dark blue (cold 0°C) -> light blue (saturation)
// Steam: white (saturated) -> yellow (100°C superheat) -> orange (500°C superheat)

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

export function lerpRGB(c1: RGB, c2: RGB, t: number): RGB {
  return {
    r: lerp(c1.r, c2.r, t),
    g: lerp(c1.g, c2.g, t),
    b: lerp(c1.b, c2.b, t),
  };
}

export function rgbToString(c: RGB, alpha: number = 1): string {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;
}

// ============================================================================
// Internal-energy-based fluid color scale
// ============================================================================
// All water/steam colors derive from specific internal energy (kJ/kg):
// deep blue for cold liquid, fading to white at the critical-point energy
// (~2030 kJ/kg), then through very pale yellow at the maximum saturated-vapor
// energy (~2604 kJ/kg) into yellow/orange for strongly superheated steam.
// Two-phase nodes get a natural visual split (liquid at u_f, vapor at u_g)
// that fades as pressure approaches critical, where u_f and u_g converge.

// Critical point temperature (374°C in Kelvin)
const T_CRITICAL = 647.3;
// Steam table validity range for color lookups (triple point to just below critical)
const T_TABLE_MIN = 274;
const T_TABLE_MAX = 647.0;

interface EnergyStop {
  u: number; // kJ/kg
  color: RGB;
}

const ENERGY_COLOR_STOPS: EnergyStop[] = [
  { u: 0,    color: { r: 15, g: 40, b: 100 } },   // near-freezing liquid - deep blue
  { u: 420,  color: { r: 30, g: 80, b: 160 } },   // ~100°C liquid - dark blue
  { u: 850,  color: { r: 50, g: 120, b: 200 } },  // ~200°C liquid - medium blue
  { u: 1640, color: { r: 120, g: 180, b: 240 } }, // ~344°C liquid (PWR) - light blue
  { u: 2030, color: { r: 255, g: 255, b: 255 } }, // critical-point energy - white
  { u: 2604, color: { r: 255, g: 250, b: 208 } }, // max saturated vapor - very pale yellow
  { u: 3100, color: { r: 255, g: 240, b: 130 } }, // superheated steam - yellow
  { u: 3700, color: { r: 255, g: 140, b: 50 } },  // strongly superheated - orange
];

/**
 * Map specific internal energy (J/kg) to a fluid color.
 * Piecewise-linear through ENERGY_COLOR_STOPS; saturates at the scale ends.
 */
export function getEnergyColor(u_Jkg: number): RGB {
  const u = u_Jkg / 1000; // kJ/kg
  const stops = ENERGY_COLOR_STOPS;
  if (u <= stops[0].u) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    if (u <= stops[i].u) {
      const t = (u - stops[i - 1].u) / (stops[i].u - stops[i - 1].u);
      return lerpRGB(stops[i - 1].color, stops[i].color, t);
    }
  }
  return stops[stops.length - 1].color;
}

/** Clamp a temperature into the steam-table range for color lookups only. */
function clampTableT(T: number): number {
  return Math.max(T_TABLE_MIN, Math.min(T_TABLE_MAX, T));
}

/**
 * Saturated liquid color at a given saturation temperature: the color of
 * u_f(T_sat). Converges to white as T_sat approaches critical.
 */
function getSaturatedLiquidColor(T_sat: number): RGB {
  if (T_sat >= T_CRITICAL) return getEnergyColor(2030e3);
  return getEnergyColor(saturatedLiquidEnergy(clampTableT(T_sat)));
}

/**
 * Saturated vapor color at a given saturation temperature: the color of
 * u_g(T_sat). Pale yellow at typical pressures, converging to white near critical.
 */
function getSaturatedVaporColor(T_sat: number): RGB {
  if (T_sat >= T_CRITICAL) return getEnergyColor(2030e3);
  return getEnergyColor(saturatedVaporEnergy(clampTableT(T_sat)));
}

// Saturation temperature as function of pressure
// Uses the actual steam table for consistency with physics calculations
export function getSaturationTemp(pressure: number): number {
  return saturationTemperature(pressure);
}

/**
 * Get saturated liquid specific volume (m³/kg) at given pressure
 * Uses the actual steam table for consistency with physics calculations
 */
function getSaturatedLiquidVolume(pressure: number): number {
  const T_sat = saturationTemperature(pressure);
  const rho_f = saturatedLiquidDensity(T_sat);
  return 1 / rho_f;
}

/**
 * Get saturated vapor specific volume (m³/kg) at given pressure
 * Uses the actual steam table for consistency with physics calculations
 */
function getSaturatedVaporVolume(pressure: number): number {
  const T_sat = saturationTemperature(pressure);
  const rho_g = saturatedVaporDensity(T_sat);
  return 1 / rho_g;
}

/**
 * Convert mass quality (x) to volume fraction (α) for two-phase mixture
 * α = x·v_g / (x·v_g + (1-x)·v_f)
 *
 * Volume fraction represents the fraction of space occupied by vapor,
 * which is what we want for visual display (pixel fraction that is white/vapor)
 *
 * IMPORTANT: When NCG is present, we must use steam partial pressure (not total)
 * for saturation calculations. Pass fluid with ncg, temperature, and volume to enable this.
 */
export function massQualityToVolumeFraction(
  quality: number,
  pressure: number,
  fluid?: Fluid
): number {
  const x = Math.max(0, Math.min(1, quality));

  // Use steam partial pressure for saturation calculations when NCG is present
  let steamPressure = pressure;
  if (fluid?.ncg && fluid.volume && fluid.volume > 0) {
    steamPressure = getSteamPartialPressure(pressure, fluid.ncg, fluid.temperature, fluid.volume);
  }

  const v_f = getSaturatedLiquidVolume(steamPressure);
  const v_g = getSaturatedVaporVolume(steamPressure);

  // α = x·v_g / (x·v_g + (1-x)·v_f)
  const numerator = x * v_g;
  const denominator = x * v_g + (1 - x) * v_f;

  if (denominator <= 0) return x; // Fallback to mass quality
  return numerator / denominator;
}

// Debug flag for fluid color tracing
let debugFluidColor = false;
let debugFluidColorCount = 0;
export function setDebugFluidColor(enabled: boolean): void {
  debugFluidColor = enabled;
  debugFluidColorCount = 0;
}

export function getFluidColor(fluid: Fluid): string {
  const T = fluid.temperature;
  const T_sat = getSaturationTemp(fluid.pressure);

  // Check for NCG-dominated vapor/gas mixtures
  // When NCG is present in vapor phase, blend steam color with NCG color
  // based on mole fraction
  const ncgMoles = fluid.ncg ? totalMoles(fluid.ncg) : 0;

  // Handle two-phase specially - we return a simple blend here,
  // but components use getTwoPhaseColors for pixelated rendering
  if (fluid.phase === 'two-phase') {
    const liquidColor = getSaturatedLiquidColor(T_sat);
    const vaporColor = getSaturatedVaporColor(T_sat);
    // Default to 50% quality if undefined
    const quality = fluid.quality ?? 0.5;
    let blended = lerpRGB(liquidColor, vaporColor, quality);

    // If NCG is present, blend with NCG color based on partial pressure fraction
    // This prevents abrupt color changes when steam transitions to two-phase
    if (ncgMoles > 0 && fluid.ncg && fluid.volume && fluid.volume > 0) {
      const P_ncg = ncgMoles * R_GAS * T / fluid.volume;
      const P_total = fluid.pressure;
      const ncgFraction = Math.min(1, Math.max(0, P_ncg / P_total));

      if (debugFluidColor && debugFluidColorCount++ < 20) {
        console.log(`[getFluidColor] TWO-PHASE: T=${T?.toFixed(1)}K, P=${(P_total/1e5)?.toFixed(3)}bar, ncgMoles=${ncgMoles.toFixed(1)}, vol=${fluid.volume?.toFixed(1)}m³, P_ncg=${(P_ncg/1e5).toFixed(3)}bar, ncgFrac=${ncgFraction.toFixed(3)}, quality=${quality.toFixed(3)}`);
      }

      if (ncgFraction > 0.001) {
        const ncgColor = getNcgColor(fluid.ncg);
        blended = lerpRGB(blended, ncgColor, ncgFraction);
        if (debugFluidColor && debugFluidColorCount < 25) {
          console.log(`  -> blending with ncgColor: r=${ncgColor.r}, g=${ncgColor.g}, b=${ncgColor.b}, result: r=${blended.r.toFixed(0)}, g=${blended.g.toFixed(0)}, b=${blended.b.toFixed(0)}`);
        }
      }
    } else if (debugFluidColor && ncgMoles > 0 && debugFluidColorCount++ < 20) {
      console.log(`[getFluidColor] TWO-PHASE (no blend): ncgMoles=${ncgMoles.toFixed(1)}, vol=${fluid.volume}, hasNcg=${!!fluid.ncg}`);
    }

    return rgbToString(blended, 1.0);  // Use same opacity as vapor for consistency
  }

  // Handle vapor explicitly - always use steam colors regardless of temperature
  // This ensures vapor is never shown as blue even with impossible state values
  if (fluid.phase === 'vapor') {
    // Steam color from specific internal energy (see getTemperatureColor)
    const steamColor = getTemperatureColor(T, T_sat, 'vapor');

    // If NCG is present, blend with NCG color based on partial pressure fraction
    // Using pressure ratio instead of mole ratio because fluid.mass may not be set
    if (ncgMoles > 0 && fluid.ncg && fluid.volume && fluid.volume > 0) {
      // Calculate NCG partial pressure: P_ncg = n * R * T / V
      const P_ncg = ncgMoles * R_GAS * T / fluid.volume;
      const P_total = fluid.pressure;

      // NCG fraction by partial pressure (which equals mole fraction for ideal gases)
      const ncgFraction = Math.min(1, Math.max(0, P_ncg / P_total));

      if (debugFluidColor && debugFluidColorCount++ < 20) {
        console.log(`[getFluidColor] VAPOR: T=${T?.toFixed(1)}K, P=${(P_total/1e5)?.toFixed(3)}bar, ncgMoles=${ncgMoles.toFixed(1)}, vol=${fluid.volume?.toFixed(1)}m³, P_ncg=${(P_ncg/1e5).toFixed(3)}bar, ncgFrac=${ncgFraction.toFixed(3)}`);
      }

      if (ncgFraction > 0.001) {  // Only blend if NCG is significant (> 0.1%)
        // Get NCG color by blending component colors
        const ncgColor = getNcgColor(fluid.ncg);

        // Blend steam and NCG colors
        const blended = lerpRGB(steamColor, ncgColor, ncgFraction);
        if (debugFluidColor && debugFluidColorCount < 25) {
          console.log(`  -> blending with ncgColor: r=${ncgColor.r}, g=${ncgColor.g}, b=${ncgColor.b}, result: r=${blended.r.toFixed(0)}, g=${blended.g.toFixed(0)}, b=${blended.b.toFixed(0)}`);
        }
        return rgbToString(blended, 1.0);
      }
    } else if (debugFluidColor && ncgMoles > 0 && debugFluidColorCount++ < 20) {
      console.log(`[getFluidColor] VAPOR (no blend): ncgMoles=${ncgMoles.toFixed(1)}, vol=${fluid.volume}, hasNcg=${!!fluid.ncg}`);
    }

    return rgbToString(steamColor, 1.0);
  }

  // Liquid - use temperature-based color
  const color = getTemperatureColor(T, T_sat, 'liquid');
  return rgbToString(color, 1.0);
}

/**
 * Get the color for an NCG mixture based on composition.
 */
function getNcgColor(ncg: GasComposition): RGB {
  const total = totalMoles(ncg);
  if (total <= 0) return { r: 128, g: 128, b: 128 };  // Default gray

  let r = 0, g = 0, b = 0;

  for (const species of ALL_GAS_SPECIES) {
    const fraction = ncg[species] / total;
    if (fraction <= 0) continue;

    const color = GAS_PROPERTIES[species].color;
    // Parse hex color #RRGGBB
    const parsed = parseInt(color.slice(1), 16);
    r += ((parsed >> 16) & 0xFF) * fraction;
    g += ((parsed >> 8) & 0xFF) * fraction;
    b += (parsed & 0xFF) * fraction;
  }

  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

// Get liquid and vapor colors at saturation for two-phase rendering
// Returns volumeFraction (not mass quality) for proper visual representation
export function getTwoPhaseColors(fluid: Fluid): { liquid: RGB; vapor: RGB; quality: number } {
  const massQuality = fluid.quality ?? 0.5;
  // Convert mass quality to volume fraction for visual display
  // Volume fraction represents what fraction of SPACE is occupied by vapor
  // which is what we want for pixel-based rendering
  // Pass fluid for NCG-aware pressure correction
  const volumeFraction = massQualityToVolumeFraction(massQuality, fluid.pressure, fluid);
  // Get temperature-dependent saturation colors (converge near critical point)
  const T_sat = getSaturationTemp(fluid.pressure);
  return {
    liquid: getSaturatedLiquidColor(T_sat),
    vapor: getSaturatedVaporColor(T_sat),
    quality: volumeFraction,  // Note: this is actually volume fraction now
  };
}

function getTemperatureColor(T: number, T_sat: number, phase: 'liquid' | 'vapor' | 'two-phase'): RGB {
  if (phase === 'liquid') {
    // Subcooled/saturated liquid: color from u_f(T). Compressed-liquid internal
    // energy is very close to saturated-liquid energy at the same temperature,
    // so this puts every liquid on the single energy color scale.
    const T_eff = Math.min(T, Math.max(T_sat, T_TABLE_MIN));
    return getEnergyColor(saturatedLiquidEnergy(clampTableT(T_eff)));
  } else if (phase === 'two-phase') {
    // Two-phase should be handled in getFluidColor with quality parameter
    // If we get here, that's a bug in the calling code
    throw new Error(`[Colors] getTemperatureColor called for two-phase without quality. ` +
      `Use getFluidColor instead. T=${T.toFixed(1)}K, T_sat=${T_sat.toFixed(1)}K`);
  } else {
    // Vapor/steam: u ≈ u_g(T_sat) + cv·(T − T_sat). White near the critical
    // energy, pale yellow for typical saturated steam, orange when strongly
    // superheated.
    const u_sat = saturatedVaporEnergy(clampTableT(Math.min(T_sat, T)));
    const superheat = Math.max(0, T - T_sat);
    return getEnergyColor(u_sat + vaporCv(T) * superheat);
  }
}

// Component colors (structural elements)
export const COLORS = {
  // Structural
  steel: '#667788',
  steelDark: '#445566',
  steelHighlight: '#8899aa',
  concrete: '#555555',

  // Accents
  warning: '#ffaa00',
  danger: '#ff4444',
  safe: '#44ff88',

  // UI
  gridLine: 'rgba(100, 100, 150, 0.2)',
  gridLineMajor: 'rgba(100, 100, 150, 0.4)',
  selectionHighlight: 'rgba(100, 150, 255, 0.5)',
  portAvailable: '#44ff88',
  portConnected: '#888888',
  // Port direction colors
  portInlet: '#44ff88',      // Green for inlet
  portOutlet: '#ff5544',     // Red for outlet
  portBidirectional: '#4488ff', // Blue for bidirectional
};

// Get color for component based on temperature stress
export function getComponentStressColor(temperature: number, maxSafeTemp: number): string {
  const ratio = temperature / maxSafeTemp;
  if (ratio < 0.7) return COLORS.steel;
  if (ratio < 0.9) return lerpColor(COLORS.steel, COLORS.warning, (ratio - 0.7) / 0.2);
  if (ratio < 1.0) return lerpColor(COLORS.warning, COLORS.danger, (ratio - 0.9) / 0.1);
  return COLORS.danger;
}

function lerpColor(hex1: string, hex2: string, t: number): string {
  const c1 = hexToRGB(hex1);
  const c2 = hexToRGB(hex2);
  return rgbToString(lerpRGB(c1, c2, t));
}

function hexToRGB(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  } : { r: 0, g: 0, b: 0 };
}

// Fuel rod temperature color: black (cold) -> dark red -> red -> orange -> bright red/white (melting)
// Temperature in Kelvin, meltingPoint is typically 2800K for UO2
const FUEL_COLD: RGB = { r: 20, g: 20, b: 20 };           // Below 200°C (473K) - nearly black
const FUEL_WARM: RGB = { r: 80, g: 20, b: 10 };           // ~600K - dark red
const FUEL_HOT: RGB = { r: 180, g: 50, b: 20 };           // ~1200K - red
const FUEL_VERY_HOT: RGB = { r: 255, g: 120, b: 30 };     // ~2000K - orange
const FUEL_MELTING: RGB = { r: 255, g: 220, b: 180 };     // Near melting - bright orange/white

export function getFuelColor(temperature: number, meltingPoint: number = 2800): string {
  const T = temperature;
  const T_cold = 473;  // 200°C - below this is "cold"
  const T_melt = meltingPoint;

  if (T <= T_cold) {
    return rgbToString(FUEL_COLD);
  } else if (T <= 600) {
    // Cold to warm: black -> dark red
    const t = (T - T_cold) / (600 - T_cold);
    return rgbToString(lerpRGB(FUEL_COLD, FUEL_WARM, t));
  } else if (T <= 1200) {
    // Warm to hot: dark red -> red
    const t = (T - 600) / (1200 - 600);
    return rgbToString(lerpRGB(FUEL_WARM, FUEL_HOT, t));
  } else if (T <= 2000) {
    // Hot to very hot: red -> orange
    const t = (T - 1200) / (2000 - 1200);
    return rgbToString(lerpRGB(FUEL_HOT, FUEL_VERY_HOT, t));
  } else if (T <= T_melt) {
    // Very hot to melting: orange -> bright
    const t = (T - 2000) / (T_melt - 2000);
    return rgbToString(lerpRGB(FUEL_VERY_HOT, FUEL_MELTING, t));
  } else {
    // Above melting point - pulsing bright
    return rgbToString(FUEL_MELTING);
  }
}

// ============================================================================
// NCG (Non-Condensible Gas) Visualization
// ============================================================================

/**
 * Check if a gas composition is approximately PURE air (N₂ + O₂ in ~4:1 ratio)
 * with no significant other gases. If true, use solid blended rendering.
 *
 * Returns true only when:
 * - N₂ and O₂ are in approximately air ratio (78:21)
 * - Other gases (H₂, He, etc.) are < 1% of total (very strict - any meaningful
 *   amount of other gas should trigger pixelated display)
 */
export function isApproximatelyPureAir(comp: GasComposition): boolean {
  const total = totalMoles(comp);
  if (total <= 0) return false;

  const n2Frac = comp.N2 / total;
  const o2Frac = comp.O2 / total;
  const otherFrac = 1 - n2Frac - o2Frac;

  // Air is ~78% N₂, ~21% O₂ (ratio 3.71:1)
  // Air-like ratio range is 3.5-4:1, which corresponds to:
  //   N₂: 77.8-80%, O₂: 20-22.2%
  // Use slightly tighter range to avoid false positives
  // Only use solid rendering when other gases are < 1%
  return n2Frac >= 0.77 && n2Frac <= 0.80 &&
         o2Frac >= 0.19 && o2Frac <= 0.23 &&
         otherFrac < 0.01;
}

// Keep old name as alias for backwards compatibility
export const isApproximatelyAir = isApproximatelyPureAir;

/**
 * Get the color for air - blends N₂ and O₂ colors.
 * Air is ~78% N₂ (gray-blue) + ~21% O₂ (reddish pink).
 */
export function getAirColor(): RGB {
  // N₂ color: #b8b8c8 = rgb(184, 184, 200)
  // O₂ color: #e8a0a0 = rgb(232, 160, 160)
  // Blend at ~78% N₂, ~22% O₂
  const n2 = hexToRGBColor(GAS_PROPERTIES.N2.color);
  const o2 = hexToRGBColor(GAS_PROPERTIES.O2.color);
  return {
    r: n2.r * 0.78 + o2.r * 0.22,
    g: n2.g * 0.78 + o2.g * 0.22,
    b: n2.b * 0.78 + o2.b * 0.22,
  };
}

/**
 * Parse a hex color string to RGB.
 */
export function hexToRGBColor(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  } : { r: 128, g: 128, b: 128 };
}

/**
 * Get an array of gas species present in the composition with their colors and fractions.
 * Used for pixelated NCG rendering.
 * Returns species sorted by mole fraction (highest first).
 *
 * Special handling for N₂ and O₂:
 * - If they're in air-like ratio (~78:21), combine them into pseudo-species "Air"
 * - Any excess N₂ or O₂ beyond the air ratio is shown separately
 * - Other gases (H₂, He, etc.) always shown with their own colors
 */
export interface GasColorInfo {
  species: GasSpecies | 'Air';  // Allow pseudo-species "Air"
  color: RGB;
  fraction: number;  // mole fraction
}

export function getGasColorInfo(comp: GasComposition): GasColorInfo[] {
  const total = totalMoles(comp);
  if (total <= 0) return [];

  const result: GasColorInfo[] = [];
  const n2 = comp.N2;
  const o2 = comp.O2;

  // Always try to extract maximum "air" from any N₂+O₂ mixture
  // Air is 78% N₂, 21% O₂, so the limiting component determines how much "air" we have
  // For every 0.78 mol N₂, we need 0.21 mol O₂ (ratio 3.71:1)
  if (n2 > 0 && o2 > 0) {
    const airRatioN2 = 0.78;
    const airRatioO2 = 0.21;

    // How much air can we make from available N₂ and O₂?
    const airFromN2 = n2 / airRatioN2;  // mol of "air" if N₂ is limiting
    const airFromO2 = o2 / airRatioO2;  // mol of "air" if O₂ is limiting
    const airMoles = Math.min(airFromN2, airFromO2);

    // N₂ and O₂ used for air
    const n2UsedForAir = airMoles * airRatioN2;
    const o2UsedForAir = airMoles * airRatioO2;

    // Excess N₂ or O₂
    const excessN2 = n2 - n2UsedForAir;
    const excessO2 = o2 - o2UsedForAir;

    // Add "Air" as a pseudo-species if significant
    const airFraction = (n2UsedForAir + o2UsedForAir) / total;
    if (airFraction > 0.01) {
      result.push({
        species: 'Air',
        color: getAirColor(),
        fraction: airFraction,
      });
    }

    // Add excess N₂ if significant
    if (excessN2 > total * 0.01) {
      result.push({
        species: 'N2',
        color: hexToRGBColor(GAS_PROPERTIES.N2.color),
        fraction: excessN2 / total,
      });
    }

    // Add excess O₂ if significant
    if (excessO2 > total * 0.01) {
      result.push({
        species: 'O2',
        color: hexToRGBColor(GAS_PROPERTIES.O2.color),
        fraction: excessO2 / total,
      });
    }
  } else {
    // Only N₂ or only O₂ (no air possible) - show them separately
    if (n2 > 0) {
      result.push({
        species: 'N2',
        color: hexToRGBColor(GAS_PROPERTIES.N2.color),
        fraction: n2 / total,
      });
    }
    if (o2 > 0) {
      result.push({
        species: 'O2',
        color: hexToRGBColor(GAS_PROPERTIES.O2.color),
        fraction: o2 / total,
      });
    }
  }

  // Add all other gas species (not N₂ or O₂)
  for (const species of ALL_GAS_SPECIES) {
    if (species === 'N2' || species === 'O2') continue;

    const moles = comp[species];
    if (moles > 0) {
      result.push({
        species,
        color: hexToRGBColor(GAS_PROPERTIES[species].color),
        fraction: moles / total,
      });
    }
  }

  // Sort by fraction descending
  result.sort((a, b) => b.fraction - a.fraction);

  return result;
}

/**
 * Get the blended color for a gas mixture (used for air or simple display).
 * Returns mole-fraction weighted average of component colors.
 */
export function getBlendedGasColor(comp: GasComposition): RGB {
  const total = totalMoles(comp);
  if (total <= 0) return { r: 128, g: 128, b: 128 };

  let r = 0, g = 0, b = 0;

  for (const species of ALL_GAS_SPECIES) {
    const fraction = comp[species] / total;
    if (fraction <= 0) continue;

    const color = hexToRGBColor(GAS_PROPERTIES[species].color);
    r += color.r * fraction;
    g += color.g * fraction;
    b += color.b * fraction;
  }

  return { r, g, b };
}

/**
 * Get NCG visualization data for a fluid.
 * Returns null if no NCG present.
 *
 * isAir = true means pure air (N₂+O₂ in ~78:21, <3% other gases) -> solid rendering
 * isAir = false means use pixelated rendering with gasColors
 *
 * gasColors handles air-like mixtures intelligently:
 * - If N₂+O₂ are in air ratio, they appear as "Air" pseudo-species
 * - Any excess N₂ or O₂ beyond the ratio appears separately
 * - Other gases (H₂, He, etc.) always appear with their own colors
 */
export interface NcgVisualization {
  isAir: boolean;            // True = pure air, use solid blended rendering
  blendedColor: RGB;         // For pure air or fallback solid rendering
  gasColors: GasColorInfo[]; // For pixelated rendering (includes "Air" pseudo-species)
  totalMoles: number;
}

export function getNcgVisualization(ncg: GasComposition | undefined): NcgVisualization | null {
  if (!ncg) return null;

  const total = totalMoles(ncg);
  if (total <= 0) return null;

  const isAir = isApproximatelyPureAir(ncg);

  return {
    isAir,
    blendedColor: isAir ? getAirColor() : getBlendedGasColor(ncg),
    gasColors: getGasColorInfo(ncg),
    totalMoles: total,
  };
}

// ============================================================================
// Color Legend Rendering
// ============================================================================

/**
 * Water color stops for legend gradient (cold liquid up to critical energy)
 */
const WATER_GRADIENT_STOPS: RGB[] = ENERGY_COLOR_STOPS
  .filter(s => s.u <= 2030)
  .map(s => s.color);

/**
 * Steam color stops for legend gradient (critical energy through superheated)
 */
const STEAM_GRADIENT_STOPS: RGB[] = ENERGY_COLOR_STOPS
  .filter(s => s.u >= 2030)
  .map(s => s.color);

/**
 * Legend item definition
 */
interface LegendItem {
  label: string;
  color?: string;        // For solid colors
  gradient?: RGB[];      // For gradient colors
}

/**
 * Render a color/gas legend at the bottom of the canvas.
 * Shows water gradient, steam gradient, air, and all NCG species.
 */
export function renderColorLegend(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number
): void {
  const legendHeight = 24;
  const itemHeight = 14;
  const itemSpacing = 8;
  const gradientWidth = 50;
  const solidWidth = 14;
  const padding = 10;
  const fontSize = 10;

  // Build legend items
  const items: LegendItem[] = [
    { label: 'Water', gradient: WATER_GRADIENT_STOPS },
    { label: 'Steam', gradient: STEAM_GRADIENT_STOPS },
    { label: 'Air', color: rgbToString(getAirColor()) },
  ];

  // Add all gas species
  for (const species of ALL_GAS_SPECIES) {
    const props = GAS_PROPERTIES[species];
    items.push({
      label: props.formula,
      color: props.color,
    });
  }

  // Calculate total width needed
  let totalWidth = padding;
  for (const item of items) {
    const colorWidth = item.gradient ? gradientWidth : solidWidth;
    ctx.font = `${fontSize}px sans-serif`;
    const labelWidth = ctx.measureText(item.label).width;
    totalWidth += colorWidth + 4 + labelWidth + itemSpacing;
  }
  totalWidth -= itemSpacing; // Remove last spacing
  totalWidth += padding;

  // Position legend at bottom center, above the status bar (~35px tall)
  const statusBarHeight = 40; // Account for status bar at bottom of viewport
  const legendX = (canvasWidth - totalWidth) / 2;
  const legendY = canvasHeight - legendHeight - statusBarHeight;

  // Draw background
  ctx.fillStyle = 'rgba(20, 30, 40, 0.85)';
  ctx.fillRect(legendX, legendY, totalWidth, legendHeight);
  ctx.strokeStyle = 'rgba(100, 120, 140, 0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(legendX, legendY, totalWidth, legendHeight);

  // Draw items
  let x = legendX + padding;
  const y = legendY + (legendHeight - itemHeight) / 2;

  ctx.font = `${fontSize}px sans-serif`;
  ctx.textBaseline = 'middle';

  for (const item of items) {
    const colorWidth = item.gradient ? gradientWidth : solidWidth;

    if (item.gradient) {
      // Draw gradient
      const gradient = ctx.createLinearGradient(x, 0, x + gradientWidth, 0);
      const stops = item.gradient;
      for (let i = 0; i < stops.length; i++) {
        gradient.addColorStop(i / (stops.length - 1), rgbToString(stops[i]));
      }
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, gradientWidth, itemHeight);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, gradientWidth, itemHeight);
    } else if (item.color) {
      // Draw solid color
      ctx.fillStyle = item.color;
      ctx.fillRect(x, y, solidWidth, itemHeight);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, solidWidth, itemHeight);
    }

    // Draw label
    ctx.fillStyle = '#ccc';
    ctx.fillText(item.label, x + colorWidth + 4, y + itemHeight / 2);

    const labelWidth = ctx.measureText(item.label).width;
    x += colorWidth + 4 + labelWidth + itemSpacing;
  }
}
