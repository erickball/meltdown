/**
 * Lattice-lite neutronics: derive reactivity coefficients and excess
 * reactivity from the core the player actually built, instead of typed-in
 * constants.
 *
 * Model: classic four-factor k-infinity plus thermal leakage, built on the
 * one quantity the construction UI already determines - the
 * moderator-to-fuel volume ratio - plus enrichment and fuel material:
 *
 *   k_eff(T_fuel, rho_mod) = eta(e) * epsilon * p(T_fuel, rho_mod)
 *                            * f(rho_mod) / (1 + M^2 B^2)
 *
 *   eta  - neutrons per thermal absorption in fuel: from enrichment via
 *          thermal cross sections (the enrichment lever)
 *   p    - resonance escape: exp(-c_p * sqrt(V_f/(V_m * rho~))), broadened
 *          by fuel temperature (Doppler: I_eff grows ~ sqrt(T_fuel))
 *   f    - thermal utilization: fuel absorption vs moderator absorption
 *          (scales with moderator density -> density/void coefficient)
 *   1/(1+M^2 B^2) - thermal+fast non-leakage; M^2 grows as the moderator
 *          thins, so small or voided cores leak more
 *
 * The derivatives of k_eff give every coefficient the point-kinetics model
 * needs, evaluated NUMERICALLY at the operating point - no per-reactor-type
 * special cases:
 *   - under-moderated lattices (tight rod pitch) come out with a positive
 *     density coefficient (loss of water = loss of reactivity), and
 *     over-moderated ones flip sign, exactly like the real k vs pitch curve
 *   - fatter rods self-shield more, weakening Doppler per kelvin
 *
 * SCOPE: water-moderated cores only. Solid-moderated designs (graphite /
 * pebble bed with gas coolant) need a solidModerationFraction parameter so
 * that p and f do not collapse when the coolant carries no moderation -
 * planned alongside the advanced-reactor components.
 *
 * This is a game-fidelity model: constants below are calibrated so a
 * standard 5 w/o UO2 PWR lattice lands in published ranges (Doppler -1..-4
 * pcm/K, density coefficient +10..+50 pcm per kg/m3, k_inf ~ 1.2-1.4), not
 * a licensing tool.
 */

export type FuelMaterial = 'UO2' | 'metal';

export interface LatticeParams {
  /** U-235 enrichment, weight fraction (0.007 natural .. 0.2 HALEU-ish) */
  enrichment: number;
  fuelMaterial: FuelMaterial;
  /** fuel rod outer diameter (m) */
  rodDiameter: number;
  /** number of fuel rods */
  rodCount: number;
  /** core (barrel inner) diameter (m) */
  coreDiameter: number;
  /** active fuel height (m) */
  activeHeight: number;
  /** reference moderator density at operating conditions (kg/m³) */
  refModeratorDensity: number;
  /** reference fuel temperature (K) */
  refFuelTemp: number;
}

export interface DerivedNeutronics {
  /** k_eff at reference conditions, all rods out */
  kEffRef: number;
  /** excess reactivity (k-1)/k at reference, rods out (>=0 means critical is reachable) */
  excessReactivity: number;
  /** Doppler: d(rho)/dT_fuel (1/K), evaluated at reference */
  fuelTempCoeff: number;
  /** d(rho)/d(rho_moderator) (per kg/m³), evaluated at reference */
  coolantDensityCoeff: number;
  /** small direct spectral term, d(rho)/dT_coolant at constant density (1/K) */
  coolantTempCoeff: number;
  /** moderator-to-fuel volume ratio (diagnostic; ~1.5-2.5 typical PWR) */
  moderationRatio: number;
  /** true when d(k)/d(rho_mod) < 0: MORE water reduces reactivity */
  overModerated: boolean;
}

// --- Calibration constants -------------------------------------------------
// Thermal cross-section data (barns), 2200 m/s values
const NU = 2.44;            // neutrons per U-235 fission
const SIGMA_F5 = 582;       // U-235 fission
const SIGMA_A5 = 694;       // U-235 absorption
const SIGMA_A8 = 2.7;       // U-238 absorption
// Moderator absorption relative to fuel: water sigma_a per molecule 0.66 b,
// folded with number densities into this ratio coefficient (calibrated).
const MOD_ABSORPTION_COEFF = 0.045;
// Resonance escape strength. Calibrated jointly with the other constants so
// that (a) a 5 w/o PWR lattice gives k_eff ~ 1.2-1.3 with Doppler in the
// -2..-4 pcm/K range, and (b) NATURAL uranium in light water stays
// subcritical (k ~ 0.85-0.9) - the classic result that forced graphite/heavy
// water for nat-U reactors.
const RESONANCE_COEFF = 0.6;
// Doppler broadening of the effective resonance integral:
// I_eff ~ I_0 * (1 + beta * (sqrt(T) - sqrt(T_ref0))), beta for a ~9.5 mm
// UO2 rod; thinner rods self-shield less and broaden harder.
const DOPPLER_BETA_REF = 0.004;    // 1/sqrt(K), at d = 9.5 mm
const DOPPLER_REF_ROD_D = 0.0095;  // m
const T_DOPPLER_ANCHOR = 300;      // K, resonance-integral anchor
// Fast fission factor
const EPSILON = 1.03;
// Migration area of water at reference density (m²) - leakage term
const M2_REF = 0.0060;             // 60 cm²
const RHO_WATER_REF = 750;         // kg/m³ scale for M² density dependence

/**
 * k_eff for the lattice at the given fuel temperature and moderator density.
 * Exposed for tests and (later) an "estimated critical position" display.
 */
export function latticeKeff(params: LatticeParams, T_fuel: number, rhoMod: number): number {
  const e = Math.max(0.003, Math.min(0.3, params.enrichment));

  // Geometry: fuel and moderator volumes
  const V_fuel = params.rodCount * Math.PI * Math.pow(params.rodDiameter / 2, 2) * params.activeHeight;
  const V_core = Math.PI * Math.pow(params.coreDiameter / 2, 2) * params.activeHeight;
  const V_mod = Math.max(1e-6, V_core - V_fuel);
  const r = V_mod / V_fuel; // moderation ratio
  // Moderator density relative to nominal cold water scale
  const rhoTilde = Math.max(1e-3, rhoMod / RHO_WATER_REF);

  // eta: fission neutrons per absorption in fuel (enrichment lever).
  // Metal fuel has a slightly harder spectrum captured as a small bonus.
  const etaBonus = params.fuelMaterial === 'metal' ? 1.03 : 1.0;
  const eta = etaBonus * (NU * e * SIGMA_F5) / (e * SIGMA_A5 + (1 - e) * SIGMA_A8);

  // f: thermal utilization - moderator absorption scales with how much
  // water (by mass) shares the cell with the fuel
  const f = 1 / (1 + MOD_ABSORPTION_COEFF * r * rhoTilde);

  // p: resonance escape - less moderator (volume OR density) means more
  // resonance capture in U-238; fuel temperature broadens the resonances
  const beta = DOPPLER_BETA_REF * Math.sqrt(DOPPLER_REF_ROD_D / Math.max(1e-3, params.rodDiameter));
  const doppler = 1 + beta * (Math.sqrt(Math.max(1, T_fuel)) - Math.sqrt(T_DOPPLER_ANCHOR));
  const p = Math.exp((-RESONANCE_COEFF * doppler) / (r * rhoTilde));

  // Leakage: buckling from core dimensions, migration area grows as the
  // moderator thins (longer neutron travel)
  const R = params.coreDiameter / 2;
  const H = params.activeHeight;
  const B2 = Math.pow(2.405 / R, 2) + Math.pow(Math.PI / H, 2); // 1/m²
  const M2 = M2_REF / Math.pow(rhoTilde, 2);
  const nonLeakage = 1 / (1 + M2 * B2);

  return eta * EPSILON * p * f * nonLeakage;
}

/**
 * Derive point-kinetics feedback coefficients by numerical differentiation
 * of k_eff at the reference operating point.
 */
export function deriveNeutronics(params: LatticeParams): DerivedNeutronics {
  const T0 = params.refFuelTemp;
  const rho0 = params.refModeratorDensity;

  const k0 = latticeKeff(params, T0, rho0);
  const rhoOf = (k: number) => (k - 1) / k;

  // Doppler: drho/dT_fuel over +-25 K
  const dT = 25;
  const kTplus = latticeKeff(params, T0 + dT, rho0);
  const kTminus = latticeKeff(params, T0 - dT, rho0);
  const fuelTempCoeff = (rhoOf(kTplus) - rhoOf(kTminus)) / (2 * dT);

  // Density coefficient: drho/drho_mod over +-2% of reference density
  const dRho = Math.max(1, 0.02 * rho0);
  const kRplus = latticeKeff(params, T0, rho0 + dRho);
  const kRminus = latticeKeff(params, T0, rho0 - dRho);
  const coolantDensityCoeff = (rhoOf(kRplus) - rhoOf(kRminus)) / (2 * dRho);

  // Direct spectral coolant-temperature term (constant density): small and
  // negative - thermal spectrum hardening loses a little eta*f. Represented
  // as a fixed -1 pcm/K; the dominant moderator feedback is the density term.
  const coolantTempCoeff = -1e-5;

  const V_fuel = params.rodCount * Math.PI * Math.pow(params.rodDiameter / 2, 2) * params.activeHeight;
  const V_core = Math.PI * Math.pow(params.coreDiameter / 2, 2) * params.activeHeight;

  return {
    kEffRef: k0,
    excessReactivity: rhoOf(k0),
    fuelTempCoeff,
    coolantDensityCoeff,
    coolantTempCoeff,
    moderationRatio: (V_core - V_fuel) / V_fuel,
    overModerated: coolantDensityCoeff < 0,
  };
}
