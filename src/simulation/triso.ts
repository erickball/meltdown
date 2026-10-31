/**
 * TRISO coated-particle retention.
 *
 * A TRISO particle is a fuel kernel inside a porous carbon buffer and three
 * dense layers: inner pyrocarbon, silicon carbide, outer pyrocarbon. The
 * SiC is the pressure vessel and the barrier that matters: intact SiC holds
 * cesium, and intact pyrocarbon holds the noble gases. In the AGR-1
 * post-irradiation heating tests (ORNL/LTR-2014/486 and the CCCTF series)
 * cesium came out ONLY with SiC failure, and krypton only with failure of
 * all three dense layers - diffusion through intact SiC at 1600-1800 C was
 * visible for silver, europium and strontium, none of which this model
 * tracks. So the release model is: intact particles retain everything;
 * failed particles release at the bare-kernel rate.
 *
 * WHICH PARTICLES HAVE FAILED. Each particle survives a time t_f(T) at
 * temperature; across the population t_f is log-normally distributed
 * (SiC thickness, local flaws, kernel position, burnup). Under a varying
 * temperature history, the life consumed is a time-fraction (Miner's rule)
 * integral, the same construction the creep-rupture model uses:
 *
 *     D(t) = integral dt / t_med(T)
 *     F_thermal = Phi( ln(D) / s )          (log-normal CDF)
 *     F = 1 - (1 - f_defect)(1 - F_thermal)
 *
 * D only ever grows, so the failed fraction is monotone - a particle that
 * cracked stays cracked when the core cools - without a ratchet or a
 * remembered maximum. There is no failure temperature: at 1600 C the median
 * lifetime is decades and the log-normal tail is ~1e-10 after 500 h; it is
 * the same expression that fails most of the core within hours at 2300 C.
 *
 * f_defect is the as-manufactured population: particles with defective or
 * missing SiC plus heavy-metal contamination of the matrix. Production
 * specifications put it at 1e-5..1e-4; this is what drives release in every
 * mild accident, as it does in the real safety case.
 *
 * CALIBRATION (fit, not mechanism - the anchors below are what it must hit):
 *   1600 C, 500 h      no SiC failures beyond defects       (AGR-1, KUFA)
 *   1700 C, 300 h      no SiC failures in ~4000 particles   (AGR-1)
 *   1800 C, ~200 h     first failures, ~1e-3                (AGR-1 compacts)
 *   2100 C, ~20 h      tens of percent failed               (German tests)
 *   ramp 50 K/h        ~all failed by 2500 C, Cs ~100%      (Nabielek 1989)
 * Above ~2000 C the mechanism is thermal decomposition of the SiC (Petti
 * 2004: ~1e-10 m/s at 2170 K, 1e-9 m/s at 2440 K); at 1700-1800 C it is
 * fission-product (Pd) corrosion of the SiC. One Arrhenius lifetime with
 * Q = 663 kJ/mol spans both; the steeper-than-decomposition activation
 * energy is what the low-temperature corrosion data asks for.
 *
 * NOT MODELLED (yet): burnup and internal-pressure dependence of t_f, the
 * matrix's sorption hold-up of cesium, oxidation of exposed particles in
 * an air ingress (OPyC burn-off, passive/active SiC oxidation).
 */

/** Temperature the lifetime is referenced to (K) - 1800 C, where AGR-1 saw failures begin */
export const SIC_REFERENCE_TEMPERATURE = 2073;
/** Median particle lifetime at the reference temperature (s) - 4400 h */
export const SIC_MEDIAN_LIFETIME_AT_REF = 4400 * 3600;
/** Activation temperature of the lifetime, Q/R (K) - 663 kJ/mol */
export const SIC_LIFETIME_Q_OVER_R = 79800;
/** Log-normal spread of particle lifetime (natural-log standard deviation) */
export const SIC_LIFETIME_LOG_SPREAD = 1.0;
/** As-manufactured defective-SiC + matrix contamination fraction (good modern fuel) */
export const DEFAULT_TRISO_DEFECT_FRACTION = 5e-5;

/**
 * Rate at which a particle's life is consumed, 1/t_med(T) (1/s). Written
 * relative to the reference point so cold temperatures underflow to zero
 * instead of overflowing a lifetime to Infinity.
 */
export function sicDamageRate(T: number): number {
  return Math.exp(-SIC_LIFETIME_Q_OVER_R * (1 / T - 1 / SIC_REFERENCE_TEMPERATURE)) /
    SIC_MEDIAN_LIFETIME_AT_REF;
}

/**
 * Complementary error function, Chebyshev fit (Numerical Recipes erfcc).
 * Fractional error < 1.2e-7 EVERYWHERE, tails included - the failure
 * fractions that matter (1e-10..1e-4) live in the tail, where 1 - erf(x)
 * would cancel to garbage.
 */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 +
    t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 +
    t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Fraction of intact particles whose life is used up at damage D (log-normal CDF) */
export function thermalFailureFraction(damage: number): number {
  if (Number.isNaN(damage)) {
    throw new Error('[TRISO] particle damage is NaN - the life-consumed integral has been corrupted upstream');
  }
  // The lifetime is a positive random variable, so its CDF is exactly 0 for
  // D <= 0 - the continuous extension, not a floor. It matters: D starts at
  // 0 and Dormand-Prince stages have negative coefficients, so a trial
  // stage can see D ~ -1e-27, where ln(D) would be NaN.
  if (damage <= 0) return 0;
  return 0.5 * erfc(-Math.log(damage) / (SIC_LIFETIME_LOG_SPREAD * Math.SQRT2));
}

/** Total failed (releasing) particle fraction: defects plus thermal failures */
export function trisoFailedFraction(damage: number, defectFraction: number): number {
  return 1 - (1 - defectFraction) * (1 - thermalFailureFraction(damage));
}
