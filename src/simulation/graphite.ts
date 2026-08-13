/**
 * Graphite material properties and packed-bed effective conductivity.
 *
 * Two grades matter for a gas-cooled reactor, and they are genuinely
 * different materials - not the same graphite at two sizes:
 *
 *   A3-3   the fuel-pebble MATRIX. Resin-bonded moulded graphite, lower
 *          density (~1750 kg/m3), heavily irradiated in service.
 *   NBG-18 the REFLECTOR. Vibration-moulded, medium-grain (~1.6 mm) pitch
 *          coke, ~1850 kg/m3. Chosen because a pebble-bed side reflector is
 *          built from large blocks and only the large-billet grades can
 *          supply them - the fine-grain isostatic grades (IG-110) come in
 *          small billets and go into fuel elements and control-rod sleeves
 *          instead. NBG-18 was the PBMR reference reflector grade and is the
 *          best-characterised grade in INL's Advanced Graphite Creep
 *          programme, so its irradiation/strength/oxidation data all exist
 *          in the open literature.
 *
 * The grade choice also has a real consequence for oxidation (added
 * separately): medium-grain NBG-18 has larger pores and less internal
 * surface per gram than a fine-grain grade, so it stays reaction-controlled
 * to higher temperature and oxidises more slowly per gram than the pebbles.
 * The pebbles burn first, which is the correct qualitative story.
 */

/** Stefan-Boltzmann constant (W/m2-K4) */
export const SIGMA_SB = 5.67e-8;

export interface GraphiteGrade {
  /** Grade name, for error messages and labels */
  name: string;
  /** Bulk density including porosity (kg/m3) */
  density: number;
  /** Open porosity (-) - void volume fraction of the solid block */
  porosity: number;
  /** Total hemispherical emissivity (-) */
  emissivity: number;
  /**
   * Unirradiated thermal conductivity at 300 K (W/m-K). Falls with
   * temperature as Umklapp phonon scattering takes over - see
   * graphiteThermalConductivity.
   */
  k300: number;
  /**
   * BET specific surface area (m2/g). This is the INTERNAL area where
   * oxidation actually happens - four orders of magnitude more than the
   * geometric surface, which is why graphite oxidises throughout its volume
   * at low temperature instead of just at its face.
   */
  betArea: number;
  /**
   * Apparent activation energy for C + O2 (J/mol), from thermogravimetry in
   * the kinetic regime.
   */
  oxidationEa: number;
  /**
   * Published area-normalised pre-exponential in g/(h.m2) of GEOMETRIC
   * surface, measured in dry air at 1 atm. Converted to an intrinsic
   * per-internal-area rate constant by intrinsicOxidationRateConstant,
   * which needs the specimen size below to undo the normalisation.
   */
  oxidationAPublished: number;
  /** Side length (m) of the cubic TGA specimen the above was measured on */
  oxidationSpecimenSize: number;
  /** Literature source for the oxidation parameters */
  oxidationSource: string;
}

/**
 * Fuel-pebble matrix graphite (A3-3): the moulded binder-rich matrix.
 *
 * OXIDATION DATA IS A DOCUMENTED STAND-IN. Lee et al. measured the four
 * reflector-class grades, not A3-3, and no A3-3 thermogravimetry was
 * obtained here. A3-3 is moulded from fine graphite powder with a resin
 * binder, so the superfine-grain IG-110 is the closest measured analogue -
 * its numbers are used below. This is the least defensible constant in the
 * file: matrix graphite is generally MORE reactive than any reflector
 * grade, so the pebbles' oxidation rate is more likely under- than
 * over-stated. Replace with measured A3-3 data before drawing conclusions
 * about how fast a bed burns.
 */
export const A3_3: GraphiteGrade = {
  name: 'A3-3 matrix',
  density: 1750,
  porosity: 0.22,
  emissivity: 0.85,
  // In-core matrix graphite runs at high fast fluence, where lattice damage
  // scatters phonons and collapses conductivity to a fraction of virgin.
  // The saturated irradiated value is what the pebble actually has in
  // service, so quote that directly rather than a virgin value we would
  // then have to de-rate.
  k300: 25,
  betArea: 0.224,             // IG-110 stand-in
  oxidationEa: 222.07e3,      // IG-110 stand-in
  oxidationAPublished: 5.41e14,
  oxidationSpecimenSize: 0.0125,
  oxidationSource: 'IG-110 stand-in, Lee/Contescu et al., ORNL (OSTI 1423049), Table 3',
};

/** Reflector graphite (NBG-18): large-billet vibration-moulded blocks. */
export const NBG_18: GraphiteGrade = {
  name: 'NBG-18',
  density: 1850,
  // Manufacturer/measured pore volume is 17-18% (Lee et al., Table 2).
  porosity: 0.175,
  emissivity: 0.85,
  // Virgin medium-grain nuclear graphite. The reflector sees far lower fast
  // fluence than the fuel, so it keeps most of its conductivity; this is
  // NOT de-rated for irradiation, which would need a dose model we do not
  // have. Conservative in the wrong direction for late-life reflectors, but
  // the reflector's own conduction is not the limiting resistance in the
  // passive heat path (the bed and the gas gap are), so the error barely
  // moves the answer.
  k300: 130,
  // Measured: BET 0.1 m2/g - less than half IG-110's 0.224, which is
  // exactly why the medium-grain grade resists oxidation better.
  betArea: 0.1,
  oxidationEa: 186.93e3,        // kJ/mol -> J/mol
  oxidationAPublished: 2.75e12, // g/(h.m2) of geometric area, dry air 1 atm
  oxidationSpecimenSize: 0.0125, // 12.5 mm cube
  oxidationSource: 'Lee/Contescu et al., ORNL (OSTI 1423049), Tables 2-3, 12.5 mm cubes, dry air',
};

/**
 * Specific heat of graphite (J/kg-K), Butland & Maddison correlation.
 * Valid ~200-3500 K, smooth and monotonic throughout.
 *
 * This matters: cp rises from ~710 J/kg-K at room temperature to ~1760 at
 * 1000 K and ~2020 at 2000 K. A flat value would misstate the reflector's
 * thermal inertia - the entire reason the node exists - by nearly 2x over
 * an accident transient.
 */
export function graphiteSpecificHeat(T: number): number {
  // Correlation is in cal/g-K; 4184 converts to J/kg-K.
  const cp_cal =
    0.54212 -
    2.42667e-6 * T -
    90.2725 / T -
    43449.3 / (T * T) +
    1.59309e7 / (T * T * T) -
    1.43688e9 / (T * T * T * T);
  return 4184 * cp_cal;
}

/**
 * Thermal conductivity of graphite (W/m-K) at temperature T.
 *
 * Above the Debye peak (~100 K, far below anything we simulate) phonon
 * conduction is Umklapp-limited and falls off as a power of temperature.
 * The exponent is fitted to the two standard anchors for medium-grain
 * nuclear graphite - ~130 W/m-K at 300 K falling to ~50 W/m-K at 1273 K -
 * which gives n = ln(130/50)/ln(1273/300) = 0.66.
 */
export function graphiteThermalConductivity(T: number, grade: GraphiteGrade): number {
  return grade.k300 * Math.pow(300 / T, 0.66);
}

/**
 * Radiative contribution to the effective conductivity of a packed bed
 * (W/m-K). Photons crossing the voids between particles carry heat as if
 * the bed had an extra conductivity
 *
 *     k_rad = 4 sigma T^3 d_p e/(2-e)
 *
 * which is the standard Damkohler form: one particle diameter of mean free
 * path per radiative exchange, with the gray-body factor for exchange
 * between two surfaces of emissivity e.
 *
 * The T^3 is the important part. It is why a pebble bed can shed decay heat
 * passively: the radial conductivity roughly triples between operating
 * temperature and accident temperature, exactly when it is needed. Nothing
 * about that behaviour is switched on - it is the same expression at 400 K
 * and 1600 K.
 */
export function bedRadiativeConductivity(
  T: number,
  particleDiameter: number,
  emissivity: number,
): number {
  return 4 * SIGMA_SB * T * T * T * particleDiameter * (emissivity / (2 - emissivity));
}

/**
 * Stagnant effective conductivity of a packed bed of spheres
 * (Zehner-Schlunder), excluding radiation.
 *
 * The bed conducts by two paths in parallel: gas that bypasses the
 * particles entirely (weighted 1 - sqrt(1-eps)) and the series
 * solid-gas-solid path through the flattened contact region between
 * touching spheres (weighted sqrt(1-eps)). The unit-cell integral for the
 * second path is the closed form below, with the sphere deformation
 * parameter B = 1.25 ((1-eps)/eps)^(10/9).
 *
 * Point contacts are why a pebble bed conducts so much worse than solid
 * graphite: k_solid ~ 40 W/m-K gives a stagnant bed of only ~3 W/m-K.
 *
 * @param kGas      gas conductivity (W/m-K)
 * @param kSolid    particle material conductivity (W/m-K)
 * @param voidFrac  void fraction (-), ~0.39 for randomly packed spheres
 */
export function bedStagnantConductivity(
  kGas: number,
  kSolid: number,
  voidFrac: number,
): number {
  const B = 1.25 * Math.pow((1 - voidFrac) / voidFrac, 10 / 9);
  const kappa = kSolid / kGas;

  // The Zehner-Schlunder unit cell is derived for a conducting solid in a
  // less-conducting gas. If the gas ever out-conducts the packing enough to
  // push kappa down to B the closed form goes singular and then negative,
  // which would silently produce nonsense. Nothing in a graphite/gas bed
  // comes near this (kappa ~ 130 against B ~ 2), so if it ever fires the
  // inputs are wrong, not the correlation.
  if (kappa <= B * 1.0001) {
    throw new Error(
      `[Graphite] Zehner-Schlunder is out of range: k_solid/k_gas = ${kappa.toFixed(3)} ` +
      `is not above the sphere deformation parameter B = ${B.toFixed(3)} ` +
      `(k_solid=${kSolid.toFixed(3)} W/m-K, k_gas=${kGas.toFixed(4)} W/m-K, ` +
      `void fraction=${voidFrac.toFixed(3)}). A packed bed whose gas conducts ` +
      `as well as its particles is not a physical configuration here - check ` +
      `the gas composition and the bed geometry.`
    );
  }

  const d = 1 - B / kappa;
  const cell =
    (2 / d) *
    (((kappa - 1) / (d * d)) * (B / kappa) * Math.log(kappa / B) -
      (B + 1) / 2 -
      (B - 1) / d);

  const rootSolid = Math.sqrt(1 - voidFrac);
  return kGas * ((1 - rootSolid) + rootSolid * cell);
}

/**
 * Total effective conductivity of a packed bed (W/m-K): stagnant
 * conduction plus radiation. Both terms are smooth in temperature and in
 * gas composition, so a bed that loses its gas (depressurisation) slides
 * continuously onto the radiation-only limit instead of stepping.
 */
export function bedEffectiveConductivity(
  kGas: number,
  kSolid: number,
  voidFrac: number,
  T: number,
  particleDiameter: number,
  emissivity: number,
): number {
  return (
    bedStagnantConductivity(kGas, kSolid, voidFrac) +
    bedRadiativeConductivity(T, particleDiameter, emissivity)
  );
}

// ============================================================================
// Oxidation kinetics
// ============================================================================

/**
 * Internal reacting surface per unit bulk volume (m2/m3).
 *
 * BET area is quoted per gram; multiplying by bulk density converts it to
 * the per-volume form the volumetric rate constant needs. For NBG-18 this
 * is ~1.9e5 m2 of reacting surface inside every cubic metre of block -
 * against ~6 m2 of geometric face. That ratio is the whole reason graphite
 * oxidation is a volume process at low temperature.
 */
export function internalSurfacePerVolume(grade: GraphiteGrade): number {
  return grade.betArea * 1000 * grade.density;
}

/**
 * Characteristic pore radius (m), DERIVED from the measured pore volume and
 * BET area rather than assumed: for a bundle of cylindrical pores,
 * S = 2 V / r, so r = 2 V / S.
 *
 * For NBG-18 this returns ~1.9 um, which is where mercury porosimetry puts
 * a medium-grain grade - a useful check that the two measurements are
 * mutually consistent. Deriving it removes a free parameter that would
 * otherwise have to be guessed, and it correctly makes the fine-grain
 * grades come out with narrower pores (more Knudsen resistance).
 */
export function characteristicPoreRadius(grade: GraphiteGrade): number {
  const poreVolumePerKg = grade.porosity / grade.density;   // m3/kg
  const areaPerKg = grade.betArea * 1000;                   // m2/kg
  return (2 * poreVolumePerKg) / areaPerKg;
}

/**
 * Thiele effectiveness factor: the fraction of the internal surface that
 * actually sees oxidant.
 *
 *   eta = tanh(phi)/phi
 *
 * This single expression is what makes the three classical oxidation
 * regimes emerge instead of being switched between:
 *
 *   phi -> 0   eta -> 1        uniform volumetric attack, apparent Ea = Ea
 *   phi >> 1   eta -> 1/phi    in-pore diffusion control, apparent Ea = Ea/2
 *
 * The halving of the apparent activation energy in the second regime is a
 * DERIVED consequence of eta ~ 1/phi with phi ~ sqrt(k), not a fitted
 * parameter. That is the test of whether this is mechanistic: we never put
 * the factor of two in.
 */
export function thieleEffectiveness(phi: number): number {
  if (!(phi >= 0)) {
    throw new Error(`[Graphite] Thiele modulus must be non-negative, got ${phi}`);
  }
  // tanh(phi)/phi is 0/0 at the origin. The series limit 1 - phi^2/3 is
  // exact there and agrees with the closed form to well past double
  // precision at this crossover, so the function stays smooth - this is a
  // floating-point guard, not a regime switch.
  if (phi < 1e-6) return 1 - (phi * phi) / 3;
  return Math.tanh(phi) / phi;
}

/**
 * Intrinsic surface rate constant for C + O2 (m/s), referenced to INTERNAL
 * (BET) area and first order in oxygen concentration:
 *
 *   mol C consumed per m2 of internal surface per second = k_s * C_O2
 *
 * WHY THIS NEEDS DERIVING. The literature reports an area-normalised rate
 * per GEOMETRIC surface, measured on a specimen of a particular size, in
 * air at one atmosphere. That number is not transferable: it embeds the
 * specimen's volume-to-surface ratio and the test's oxygen concentration.
 * Applying it directly to a 60 mm pebble or an 0.8 m reflector block would
 * be wrong by whatever the size ratio happens to be.
 *
 * So we invert the measurement. In the kinetic regime the whole specimen
 * volume reacts (eta ~ 1), which means
 *
 *   rate per geometric area = eta * S_v * k_s * C_O2 * L_c * M_C
 *
 * with L_c = V/A_ext of the TEST SPECIMEN. Everything on the right except
 * k_s is known, so k_s follows. One correction pass for eta closes the
 * loop, since eta itself depends on k_s.
 *
 * FIRST ORDER, DELIBERATELY. The source reports an apparent order of 1.25
 * for NBG-18. An order above one is not physically meaningful for a surface
 * reaction - Langmuir-Hinshelwood mechanisms give orders between zero and
 * one - and the authors note their apparent parameters are sensitive to
 * specimen size and air flow rate, i.e. contaminated by exactly the
 * transport resistances this model represents explicitly. Carrying their
 * apparent order forward while ALSO applying our own transport terms would
 * double-count. We therefore take first order and anchor the magnitude to
 * their measurement at the calibration temperature.
 *
 * @param T_K temperature to evaluate at
 */
export function intrinsicOxidationRateConstant(grade: GraphiteGrade, T_K: number): number {
  // Anchor low in the kinetic regime (873 K is its bottom end per the
  // source), where eta is closest to one and the inversion is least
  // sensitive to the pore-diffusion correction.
  const T_anchor = 873;
  const P_anchor = 101325;          // 1 atm
  const xO2_air = 0.21;             // dry air
  const M_C = 0.012011;             // kg/mol

  // Published rate at the anchor, converted g/(h.m2) -> kg/(m2.s)
  const ratePublished = grade.oxidationAPublished *
    Math.exp(-grade.oxidationEa / (R_GAS_GRAPHITE * T_anchor)) * (1e-3 / 3600);

  const C_O2 = (xO2_air * P_anchor) / (R_GAS_GRAPHITE * T_anchor); // mol/m3
  const S_v = internalSurfacePerVolume(grade);
  const L_c = grade.oxidationSpecimenSize / 6; // cube: V/A = a/6

  // First pass assumes eta = 1, then correct once using the eta that the
  // resulting rate constant implies. The correction is a couple of percent
  // at 873 K, so a single pass converges it well inside the scatter of the
  // underlying measurement.
  let k_s = ratePublished / (S_v * C_O2 * L_c * M_C);
  const eta = anchorEffectiveness(grade, k_s, T_anchor, P_anchor);
  k_s = k_s / eta;

  // Arrhenius extrapolation from the anchor to the requested temperature.
  const A_s = k_s / Math.exp(-grade.oxidationEa / (R_GAS_GRAPHITE * T_anchor));
  return A_s * Math.exp(-grade.oxidationEa / (R_GAS_GRAPHITE * T_K));
}

/** Universal gas constant (J/mol-K) - local copy to keep this module standalone */
const R_GAS_GRAPHITE = 8.31446;

/** The three gases that attack graphite. */
export type GraphiteOxidant = 'O2' | 'H2O' | 'CO2';

/**
 * Intrinsic activation energies (J/mol) for the three attacking gases.
 *
 * O2 is measured for our grades. The other two are not, and the ordering is
 * what matters most: steam and CO2 need far more thermal help than oxygen,
 * which is why an air ingress is a fire and a steam ingress is a slow
 * gasification.
 */
const OXIDANT_ACTIVATION_ENERGY: Record<GraphiteOxidant, number> = {
  // Per-grade, from thermogravimetry - see GraphiteGrade.oxidationEa.
  O2: NaN,
  // Wang & Sun, IG-110 in steam, 850-1100 C: the apparent activation energy
  // falls from 318.6 to 148.9 kJ/mol as temperature rises. That is the
  // intrinsic value and its own halving under pore-diffusion control - the
  // same Zone I -> Zone II signature this model produces from eta, which is
  // a satisfying independent confirmation. We take the 318.6 as intrinsic
  // and let eta generate the fall on its own.
  H2O: 318.6e3,
  // Boudouard. No measurement to hand; this sits mid-range of the values
  // usually quoted for nuclear graphite (300-360 kJ/mol). ESTIMATE.
  CO2: 330e3,
};

/**
 * Relative intrinsic reactivity at 1073 K (800 C) and equal oxidant
 * concentration, normalised to CO2 = 1.
 *
 * ESTIMATE, and the least certain numbers in this file. The ~1e5 : 3 : 1
 * ordering for O2 : H2O : CO2 is the classic result from Walker, Rusinko &
 * Austin, "Gas Reactions of Carbon" (Advances in Catalysis 11, 1959), which
 * is the standard reference for carbon gasification. The magnitudes here
 * are order-of-magnitude anchors, not measurements: they set how much
 * hotter graphite must be before steam or CO2 matter, and the qualitative
 * conclusion (oxygen dominates wherever it is present; steam only bites
 * above ~900 C) is robust to being wrong by a factor of a few.
 */
const OXIDANT_RELATIVE_REACTIVITY: Record<GraphiteOxidant, number> = {
  O2: 1e5,
  H2O: 3,
  CO2: 1,
};

/** Temperature the relative reactivities above are referenced to (K) */
const REACTIVITY_ANCHOR_T = 1073;

/**
 * Intrinsic surface rate constant (m/s) for any of the three oxidants,
 * referenced to internal (BET) area and first order in oxidant
 * concentration.
 *
 * O2 comes straight from the calibrated measurement. Steam and CO2 are
 * pinned to it at the anchor temperature through the relative-reactivity
 * ratio, then carried to other temperatures by their OWN activation
 * energies - so the ratio between the three reactions changes with
 * temperature the way it physically should, rather than being frozen.
 */
export function oxidantRateConstant(
  grade: GraphiteGrade,
  oxidant: GraphiteOxidant,
  T_K: number,
): number {
  if (oxidant === 'O2') return intrinsicOxidationRateConstant(grade, T_K);

  const kO2Anchor = intrinsicOxidationRateConstant(grade, REACTIVITY_ANCHOR_T);
  const kAnchor = kO2Anchor *
    (OXIDANT_RELATIVE_REACTIVITY[oxidant] / OXIDANT_RELATIVE_REACTIVITY.O2);

  const Ea = OXIDANT_ACTIVATION_ENERGY[oxidant];
  return kAnchor * Math.exp(-(Ea / R_GAS_GRAPHITE) * (1 / T_K - 1 / REACTIVITY_ANCHOR_T));
}

/**
 * Fraction of carbon leaving as CO rather than CO2 when oxygen is the
 * attacker (Arthur, 1951): CO/CO2 = 10^3.4 exp(-51.9 kJ/mol / RT).
 *
 * This matters more than it looks. CO2 releases 393.5 kJ per mole of carbon
 * at the surface, CO only 110.5 - so hot graphite dumps barely a quarter of
 * the heat into itself and sends the rest downstream as flammable CO, which
 * the combustion operator can then burn in the gas space wherever it next
 * meets oxygen. The split is a smooth Arrhenius ratio, so nothing switches.
 */
export function coFraction(T_K: number): number {
  const ratio = Math.pow(10, 3.4) * Math.exp(-51.9e3 / (R_GAS_GRAPHITE * T_K));
  return ratio / (1 + ratio);
}

/**
 * Heat released per mole of carbon consumed (J/mol), positive = exothermic.
 *
 * The sign difference between the three reactions is the single most
 * important qualitative fact in this whole model:
 *
 *   C + O2  -> CO/CO2   +110 to +394 kJ/mol   EXOthermic - can self-sustain
 *   C + H2O -> CO + H2  -131 kJ/mol           ENDOthermic - cannot run away
 *   C + CO2 -> 2 CO     -172 kJ/mol           ENDOthermic - cannot run away
 *
 * An air ingress is therefore a fire, and a steam ingress is a slow
 * gasification limited by whatever heat the core can supply. Neither
 * behaviour is special-cased anywhere - it falls out of these signs.
 */
export function reactionHeatPerCarbon(oxidant: GraphiteOxidant, T_K: number): number {
  switch (oxidant) {
    case 'O2': {
      const f = coFraction(T_K);
      return f * 110.5e3 + (1 - f) * 393.5e3;
    }
    case 'H2O': return -131.3e3;
    case 'CO2': return -172.5e3;
  }
}

/**
 * Moles of oxidant consumed per mole of carbon. Oxygen is the only one that
 * is not one-to-one, because the CO/CO2 split changes how much O it takes.
 */
export function oxidantPerCarbon(oxidant: GraphiteOxidant, T_K: number): number {
  if (oxidant !== 'O2') return 1;
  // f mol CO + (1-f) mol CO2 per C needs (2-f)/2 mol O2.
  return (2 - coFraction(T_K)) / 2;
}

/**
 * Langmuir-Hinshelwood inhibition of the steam reaction by its own hydrogen
 * product: rate is divided by (1 + K p_H2).
 *
 * This is a real mechanism, not a fudge - hydrogen back-reacts with the
 * surface oxygen complex and blocks sites. It matters because it makes
 * steam gasification self-limiting: the H2 it produces slows it down. Wang
 * & Sun observed the inhibition saturating above ~1 kPa H2, which sets K.
 *
 * Returns 1 (no inhibition) for the other two oxidants.
 */
export function oxidantInhibition(
  oxidant: GraphiteOxidant,
  hydrogenPartialPressure: number,
): number {
  if (oxidant !== 'H2O') return 1;
  const K_H2 = 1e-3; // 1/Pa - half the rate at ~1 kPa H2
  return 1 / (1 + K_H2 * Math.max(0, hydrogenPartialPressure));
}

/**
 * Random-pore (Bhatia-Perlmutter) structural parameter. Controls how much
 * the internal surface grows as pores open before they merge and collapse.
 * ESTIMATE - typical fitted values for chars and graphites run 1-20; 3 is a
 * mid-range choice for a low-porosity graphite.
 */
export const RANDOM_PORE_PSI = 3;

/**
 * Internal surface area at burn-off X, relative to the virgin value
 * (Bhatia-Perlmutter random pore model):
 *
 *   S(X)/S0 = (1-X) sqrt(1 - psi ln(1-X))
 *
 * The surface RISES at first - oxidation opens closed porosity and exposes
 * new area, so a partly-burnt block is more reactive than a fresh one -
 * then falls to zero as the pore walls merge and the solid is consumed.
 * Both limits are smooth, and because the reaction rate is proportional to
 * this factor, X = 1 is an asymptotically approached fixed point rather
 * than something the integrator can run through.
 */
export function burnoffSurfaceFactor(burnoff: number): number {
  const remaining = 1 - burnoff;
  // No carbon left means no surface and no reaction. This is the exact
  // physical statement, not a threshold: the expression below is 0 * inf
  // at remaining = 0 and needs the limit taken explicitly.
  if (remaining <= 0) return 0;
  return remaining * Math.sqrt(1 - RANDOM_PORE_PSI * Math.log(remaining));
}

/**
 * Porosity at burn-off X. Every kilogram of carbon removed becomes void, so
 * porosity climbs towards 1 as the block is consumed - which raises the
 * effective diffusivity and lets oxidant reach deeper, a real positive
 * feedback on the way to burnout.
 */
export function burnoffPorosity(porosity0: number, burnoff: number): number {
  return porosity0 + (1 - porosity0) * Math.min(1, Math.max(0, burnoff));
}

/**
 * Effectiveness factor of the calibration specimen at the anchor condition,
 * used to close the loop in intrinsicOxidationRateConstant. Kept separate
 * so the calibration reads as the physical inversion it is.
 */
function anchorEffectiveness(
  grade: GraphiteGrade,
  k_s: number,
  T_K: number,
  P_Pa: number,
): number {
  const S_v = internalSurfacePerVolume(grade);
  const k_v = S_v * k_s;                        // 1/s
  const L_c = grade.oxidationSpecimenSize / 6;

  // O2 through air at the anchor condition. Fuller's correlation scaled from
  // the measured 0.21 cm2/s for O2-N2 at 300 K, 1 bar.
  const D_bulk = 0.21e-4 * Math.pow(T_K / 300, 1.75) * (1e5 / P_Pa);
  const r_pore = characteristicPoreRadius(grade);
  const D_kn = (2 / 3) * r_pore *
    Math.sqrt((8 * R_GAS_GRAPHITE * T_K) / (Math.PI * 0.032));
  const D_pore = 1 / (1 / D_bulk + 1 / D_kn);
  const D_eff = Math.pow(grade.porosity, 1.5) * D_pore;

  return thieleEffectiveness(L_c * Math.sqrt(k_v / D_eff));
}
