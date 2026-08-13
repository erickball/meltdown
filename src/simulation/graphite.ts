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
}

/** Fuel-pebble matrix graphite (A3-3): the moulded binder-rich matrix. */
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
};

/** Reflector graphite (NBG-18): large-billet vibration-moulded blocks. */
export const NBG_18: GraphiteGrade = {
  name: 'NBG-18',
  density: 1850,
  porosity: 0.19,
  emissivity: 0.85,
  // Virgin medium-grain nuclear graphite. The reflector sees far lower fast
  // fluence than the fuel, so it keeps most of its conductivity; this is
  // NOT de-rated for irradiation, which would need a dose model we do not
  // have. Conservative in the wrong direction for late-life reflectors, but
  // the reflector's own conduction is not the limiting resistance in the
  // passive heat path (the bed and the gas gap are), so the error barely
  // moves the answer.
  k300: 130,
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
