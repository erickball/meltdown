import { Fluid } from '../types';

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

// Color stops for water (temperatures in Kelvin)
// Water: dark blue (0°C) -> light blue (near saturation)
const WATER_COLD: RGB = { r: 20, g: 50, b: 120 };       // 0°C - dark blue
const WATER_COOL: RGB = { r: 30, g: 80, b: 160 };       // ~30% to sat - medium dark blue
const WATER_WARM: RGB = { r: 50, g: 120, b: 200 };      // ~70% to sat - medium blue
const WATER_SAT_LOW_P: RGB = { r: 120, g: 180, b: 240 };// at saturation (low P) - light blue

// Color stops for steam
// Steam: white (saturated) -> yellow (100°C superheat) -> orange (500°C superheat)
const STEAM_SAT_LOW_P: RGB = { r: 255, g: 255, b: 255 };// saturated (low P) - white
const STEAM_SUPER_100: RGB = { r: 255, g: 240, b: 130 };// 100°C superheat - yellow
const STEAM_SUPER_500: RGB = { r: 255, g: 140, b: 50 }; // 500°C superheat - orange

// At the critical point (220.64 bar, 374°C), liquid and vapor become indistinguishable
// Both converge to a pale blue-white color
const CRITICAL_POINT: RGB = { r: 200, g: 220, b: 240 }; // pale blue-white

// Critical point temperature (374°C in Kelvin)
const T_CRITICAL = 647.3;

/**
 * Get saturated liquid color at a given pressure/temperature.
 * As pressure approaches critical, the color becomes paler (converging with vapor).
 */
function getSaturatedLiquidColor(T_sat: number): RGB {
  // Blend from light blue to critical color as T_sat approaches T_critical
  // Start blending around 300°C (573K) for gradual transition
  const T_BLEND_START = 573; // 300°C
  if (T_sat <= T_BLEND_START) {
    return WATER_SAT_LOW_P;
  } else if (T_sat >= T_CRITICAL) {
    return CRITICAL_POINT;
  } else {
    const t = (T_sat - T_BLEND_START) / (T_CRITICAL - T_BLEND_START);
    return lerpRGB(WATER_SAT_LOW_P, CRITICAL_POINT, t);
  }
}

/**
 * Get saturated vapor color at a given pressure/temperature.
 * As pressure approaches critical, the color gets a slight blue tinge (converging with liquid).
 */
function getSaturatedVaporColor(T_sat: number): RGB {
  // Blend from white to critical color as T_sat approaches T_critical
  const T_BLEND_START = 573; // 300°C
  if (T_sat <= T_BLEND_START) {
    return STEAM_SAT_LOW_P;
  } else if (T_sat >= T_CRITICAL) {
    return CRITICAL_POINT;
  } else {
    const t = (T_sat - T_BLEND_START) / (T_CRITICAL - T_BLEND_START);
    return lerpRGB(STEAM_SAT_LOW_P, CRITICAL_POINT, t);
  }
}

// Saturation temperature as function of pressure (simplified)
// For water: T_sat ≈ 373K at 1 atm, ~617K at 155 bar, ~647K at 220 bar (critical)
export function getSaturationTemp(pressure: number): number {
  // Antoine-like correlation fitted to steam tables
  // T_sat = 373 + 48.5 * ln(P/101325)
  // This gives: 1 bar -> 373K (100°C), 10 bar -> 485K (212°C),
  //            155 bar -> 617K (344°C), 220 bar -> 647K (374°C critical)
  const P_atm = pressure / 101325;
  if (P_atm <= 1) return 373;
  return 373 + 48.5 * Math.log(P_atm);
}

// Steam table data for saturated water (IAPWS-IF97)
// Used for accurate volume fraction calculations in two-phase display
const SATURATION_TABLE = [
  { P: 1e5,      v_f: 0.001043, v_g: 1.694 },
  { P: 5e5,      v_f: 0.001093, v_g: 0.3749 },
  { P: 10e5,     v_f: 0.001127, v_g: 0.1944 },
  { P: 20e5,     v_f: 0.001177, v_g: 0.09963 },
  { P: 50e5,     v_f: 0.001286, v_g: 0.03944 },
  { P: 100e5,    v_f: 0.001453, v_g: 0.01803 },
  { P: 150e5,    v_f: 0.001658, v_g: 0.01167 },
  { P: 155e5,    v_f: 0.001680, v_g: 0.01070 },
  { P: 200e5,    v_f: 0.002036, v_g: 0.00587 },
  { P: 220.64e5, v_f: 0.003155, v_g: 0.003155 }, // Critical point
];

/**
 * Interpolate saturation property from steam table using log-linear interpolation.
 * Log-linear is more accurate for properties that vary exponentially with pressure.
 */
function interpolateSaturationProperty(P: number, key: 'v_f' | 'v_g'): number {
  const table = SATURATION_TABLE;

  // Clamp to table range
  if (P <= table[0].P) return table[0][key];
  if (P >= table[table.length - 1].P) return table[table.length - 1][key];

  // Find bracketing entries and interpolate in log-log space
  for (let i = 0; i < table.length - 1; i++) {
    if (P >= table[i].P && P <= table[i + 1].P) {
      const logP = Math.log(P);
      const logP0 = Math.log(table[i].P);
      const logP1 = Math.log(table[i + 1].P);
      const t = (logP - logP0) / (logP1 - logP0);

      const logV0 = Math.log(table[i][key]);
      const logV1 = Math.log(table[i + 1][key]);
      return Math.exp(logV0 + t * (logV1 - logV0));
    }
  }
  return table[table.length - 1][key];
}

/**
 * Get saturated liquid specific volume (m³/kg) at given pressure
 * Uses steam table lookup with log-linear interpolation
 */
function getSaturatedLiquidVolume(pressure: number): number {
  return interpolateSaturationProperty(pressure, 'v_f');
}

/**
 * Get saturated vapor specific volume (m³/kg) at given pressure
 * Uses steam table lookup with log-linear interpolation
 */
function getSaturatedVaporVolume(pressure: number): number {
  return interpolateSaturationProperty(pressure, 'v_g');
}

/**
 * Convert mass quality (x) to volume fraction (α) for two-phase mixture
 * α = x·v_g / (x·v_g + (1-x)·v_f)
 *
 * Volume fraction represents the fraction of space occupied by vapor,
 * which is what we want for visual display (pixel fraction that is white/vapor)
 */
export function massQualityToVolumeFraction(quality: number, pressure: number): number {
  const x = Math.max(0, Math.min(1, quality));
  const v_f = getSaturatedLiquidVolume(pressure);
  const v_g = getSaturatedVaporVolume(pressure);

  // α = x·v_g / (x·v_g + (1-x)·v_f)
  const numerator = x * v_g;
  const denominator = x * v_g + (1 - x) * v_f;

  if (denominator <= 0) return x; // Fallback to mass quality
  return numerator / denominator;
}

export function getFluidColor(fluid: Fluid): string {
  const T = fluid.temperature;
  const T_sat = getSaturationTemp(fluid.pressure);

  // Handle two-phase specially - we return a simple blend here,
  // but components use getTwoPhaseColors for pixelated rendering
  if (fluid.phase === 'two-phase') {
    const liquidColor = getSaturatedLiquidColor(T_sat);
    const vaporColor = getSaturatedVaporColor(T_sat);
    // Default to 50% quality if undefined
    const quality = fluid.quality ?? 0.5;
    const blended = lerpRGB(liquidColor, vaporColor, quality);
    return rgbToString(blended, 0.85);
  }

  // Handle vapor explicitly - always use steam colors regardless of temperature
  // This ensures vapor is never shown as blue even with impossible state values
  if (fluid.phase === 'vapor') {
    const steamSat = getSaturatedVaporColor(T_sat);
    const superheat = T - T_sat;
    if (superheat <= 0) {
      return rgbToString(steamSat, 1.0);
    } else if (superheat <= 100) {
      return rgbToString(lerpRGB(steamSat, STEAM_SUPER_100, superheat / 100), 1.0);
    } else if (superheat <= 500) {
      return rgbToString(lerpRGB(STEAM_SUPER_100, STEAM_SUPER_500, (superheat - 100) / 400), 1.0);
    } else {
      return rgbToString(STEAM_SUPER_500, 1.0);
    }
  }

  // Liquid - use temperature-based color
  const color = getTemperatureColor(T, T_sat, 'liquid');
  return rgbToString(color, 1.0);
}

// Get liquid and vapor colors at saturation for two-phase rendering
// Returns volumeFraction (not mass quality) for proper visual representation
export function getTwoPhaseColors(fluid: Fluid): { liquid: RGB; vapor: RGB; quality: number } {
  const massQuality = fluid.quality ?? 0.5;
  // Convert mass quality to volume fraction for visual display
  // Volume fraction represents what fraction of SPACE is occupied by vapor
  // which is what we want for pixel-based rendering
  const volumeFraction = massQualityToVolumeFraction(massQuality, fluid.pressure);
  // Get temperature-dependent saturation colors (converge near critical point)
  const T_sat = getSaturationTemp(fluid.pressure);
  return {
    liquid: getSaturatedLiquidColor(T_sat),
    vapor: getSaturatedVaporColor(T_sat),
    quality: volumeFraction,  // Note: this is actually volume fraction now
  };
}

function getTemperatureColor(T: number, T_sat: number, phase: 'liquid' | 'vapor' | 'two-phase'): RGB {
  // Get temperature-dependent saturation colors
  const waterSat = getSaturatedLiquidColor(T_sat);
  const steamSat = getSaturatedVaporColor(T_sat);

  if (phase === 'liquid') {
    // Liquid water color based on absolute temperature
    // Reference points:
    //   20°C (293K) = very dark blue (cold water)
    //   180°C (453K) = medium blue (BWR conditions, ~70 bar saturation)
    //   344°C (617K) = light blue (PWR conditions, ~155 bar saturation)
    //   374°C (647K) = pale blue-white (critical point)
    //
    // The gradient goes from cold to the current saturation color
    const T_COLD = 293;      // 20°C - very cold water
    const T_PWR_SAT = 617;   // 344°C - PWR saturation temperature at 155 bar

    // Clamp T to valid range
    const T_clamped = Math.max(T_COLD, Math.min(T, T_sat));

    // Calculate how far we are from cold to PWR saturation temp
    // This gives a consistent color scale regardless of current pressure
    const t = (T_clamped - T_COLD) / (T_PWR_SAT - T_COLD);

    if (t <= 0.25) {
      // 20°C to ~100°C: very dark blue -> dark blue
      return lerpRGB(WATER_COLD, WATER_COOL, t / 0.25);
    } else if (t <= 0.55) {
      // ~100°C to ~200°C: dark blue -> medium blue (around BWR temps)
      return lerpRGB(WATER_COOL, WATER_WARM, (t - 0.25) / 0.3);
    } else {
      // ~200°C to saturation: medium blue -> pressure-dependent saturation color
      return lerpRGB(WATER_WARM, waterSat, (t - 0.55) / 0.45);
    }
  } else if (phase === 'two-phase') {
    // Two-phase: handled in getFluidColor, but if we get here, blend based on quality
    // This shouldn't normally be called for two-phase, but provide a reasonable fallback
    // Blend from light blue (liquid) to white (vapor) using pressure-dependent colors
    return lerpRGB(waterSat, steamSat, 0.5); // Default to 50% blend
  } else {
    // Vapor/steam: white (saturated) -> yellow (100°C SH) -> orange (500°C SH)
    const superheat = T - T_sat;

    if (superheat <= 0) {
      return steamSat;
    } else if (superheat <= 100) {
      // 0 to 100°C superheat: saturation color -> yellow
      return lerpRGB(steamSat, STEAM_SUPER_100, superheat / 100);
    } else if (superheat <= 500) {
      // 100 to 500°C superheat: yellow -> orange
      return lerpRGB(STEAM_SUPER_100, STEAM_SUPER_500, (superheat - 100) / 400);
    } else {
      return STEAM_SUPER_500;
    }
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
