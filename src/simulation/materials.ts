/**
 * Structural materials for pressure boundaries - creep-rupture behaviour.
 *
 * Whether a component survives depends as much on WHAT IT IS MADE OF as on how
 * hard you push it. A low-alloy steel duct carrying 750 C helium at 60 bar
 * ruptures in under two minutes; the same duct in Alloy 800H lasts days. That
 * factor of thousands is why gas reactors are buildable at all, and it is the
 * kind of thing a player should be able to get wrong.
 *
 * MODEL: Larson-Miller time-temperature parameter.
 *
 *   LMP = T_K * (C + log10(t_rupture[h]))
 *   LMP_required(s) = A - B * log10(s),   s = sigma / sigma_ultimate
 *
 * Stress enters as the RATIO to ultimate, because the rest of the burst model
 * already defines burst pressure as "where the wall reaches ultimate strength".
 * So s = P_gauge / P_burst falls straight out with no extra geometry.
 *
 * Each material's (C, A, B) is fitted to two published stress-rupture points
 * and checked against a third - see the per-material notes. Cold components
 * get astronomically long rupture times from the same formula, so there is no
 * threshold anywhere.
 */

export type StructuralMaterial =
  | 'low-alloy-steel'
  | 'stainless-304'
  | 'alloy-800h';

export interface MaterialCreepData {
  label: string;
  /** Larson-Miller constant C in LMP = T*(C + log10 t_h) */
  lmC: number;
  /** LMP_required(s) = lmA - lmB*log10(s) */
  lmA: number;
  lmB: number;
  /** Rough room-temperature ultimate tensile strength (MPa) - documentation
   *  only; the stress ratio is taken against the component's burst pressure. */
  ultimateMPa: number;
  /** Temperature above which this alloy is outside its qualified range (K).
   *  Not a cliff - creep already handles the physics - but useful for UI. */
  serviceLimitK: number;
  notes: string;
}

export const MATERIALS: Record<StructuralMaterial, MaterialCreepData> = {
  // SA-533B-class pressure-vessel steel. The original hard-coded correlation.
  // Anchors: s=0.22 at 811 K ruptures in ~1000 h; s=0.027 at 1273 K in ~6 min.
  'low-alloy-steel': {
    label: 'Low-alloy steel (SA-533B)',
    lmC: 20,
    lmA: 14660,
    lmB: 6074,
    ultimateMPa: 550,
    serviceLimitK: 700,
    notes: 'PWR/BWR pressure boundary. Loses strength fast above ~700 K.',
  },

  // Type 304/304H austenitic stainless. Between low-alloy steel and 800H.
  // Anchors (304H): 10,000 h rupture ~45 MPa at 973 K and ~19 MPa at 1073 K,
  // sigma_u ~ 515 MPa, C = 15.
  //   973*(15+4)  = 18487 = A + B*log10(515/45)  -> A + 1.0585*B
  //   1073*(15+4) = 20387 = A + B*log10(515/19)  -> A + 1.4330*B
  //   => B = 5074, A = 13116
  // Check: 100,000 h at 1023 K predicts LMP 20767 vs 20460 actual (1.5% high).
  // NOTE the ordering this has to reproduce: 304H and 800H are comparable up
  // to ~800 K, but 800H pulls decisively ahead above it (5.5x the rupture life
  // at 1173 K). An earlier fit here used an over-optimistic 60 MPa anchor and
  // made 304H beat 800H everywhere, which is backwards - 800H exists precisely
  // because austenitic stainless runs out of creep strength (and oxidation
  // resistance) in that range.
  'stainless-304': {
    label: 'Stainless 304H',
    lmC: 15,
    lmA: 13116,
    lmB: 5074,
    ultimateMPa: 515,
    serviceLimitK: 1090,
    notes: 'General high-temperature service; oxidation-limited around 1090 K.',
  },

  // Alloy 800H (UNS N08810) - Fe-Ni-Cr, the standard HTGR hot-duct liner and
  // helical SG tube material, ASME qualified to 1173 K.
  // Anchors: 10,000 h rupture ~28 MPa at 1073 K and ~12 MPa at 1173 K,
  // sigma_u ~ 500 MPa, C = 15.
  //   1073*(15+4) = 20387 = A + B*log10(500/28)  -> A + 1.2518*B
  //   1173*(15+4) = 22287 = A + B*log10(500/12)  -> A + 1.6198*B
  //   => B = 5163, A = 13923
  // Check: 100,000 h at 973 K predicts LMP 19323 vs 19460 actual (0.7% low).
  'alloy-800h': {
    label: 'Alloy 800H',
    lmC: 15,
    lmA: 13923,
    lmB: 5163,
    ultimateMPa: 500,
    serviceLimitK: 1173,
    notes: 'HTGR hot-duct liner and helical SG tubing. ASME qualified to 1173 K.',
  },
};

export const DEFAULT_MATERIAL: StructuralMaterial = 'low-alloy-steel';

/** Resolve a material name, falling back loudly-but-safely to the default. */
export function resolveMaterial(name: string | undefined): StructuralMaterial {
  if (!name) return DEFAULT_MATERIAL;
  if (name in MATERIALS) return name as StructuralMaterial;
  console.warn(
    `[Materials] Unknown structural material '${name}' - falling back to ` +
    `${DEFAULT_MATERIAL}. Known: ${Object.keys(MATERIALS).join(', ')}`
  );
  return DEFAULT_MATERIAL;
}
