/**
 * MACCS-lite: turn the simulation's radiological source term
 * (state.environmentalRelease, moles of Xe and CsI that crossed the plant
 * boundary) into the game's consequence number - statistical cancers.
 *
 * The hand-wave chain, so the constants are defensible in spirit:
 *   CsI moles -> Cs-137-equivalent activity: the volatile fission product
 *   inventory is modeled as ~250 mol per GWt, standing in for the whole
 *   cesium/iodine group. A 3 GWt core carries very roughly 4e17 Bq of
 *   Cs-137; that maps to ~5e14 Bq per mole of game-CsI.
 *   Activity -> collective dose: generic mid-latitude site, Gaussian plume,
 *   ~1e6 people within influence; Chernobyl's ~8.5e16 Bq of Cs-137 produced
 *   a few 1e5 person-Sv worldwide -> ~3e-12 person-Sv/Bq.
 *   Dose -> cancers: LNT, 5% per person-Sv.
 * Net: ~75 cancers per mole of game-CsI. We use 60 (some of the group decays
 * fast or is iodine that is gone in weeks). Noble gases disperse and do not
 * deposit: ~3 orders of magnitude weaker per mole.
 *
 * A full-core volatile release (~750 mol from 3 GWt) then lands at ~45,000 -
 * Chernobyl-order - and a whiff from a stuck-open valve lands far below one
 * statistical cancer. Fuzzy by design; the game never pretends otherwise.
 */

export interface ReleaseAssessment {
  cancers: number;        // central estimate of statistical cancers
  csiMoles: number;
  xenonMoles: number;
  /** Display string with the mandated epistemic humility. */
  verdict: string;
}

const CANCERS_PER_MOL_CSI = 60;
const CANCERS_PER_MOL_XE = 0.02;

export function assessRelease(
  environmentalRelease: Record<string, number> | undefined
): ReleaseAssessment {
  const csi = environmentalRelease?.CsI ?? 0;
  const xe = environmentalRelease?.Xe ?? 0;
  const cancers = CANCERS_PER_MOL_CSI * csi + CANCERS_PER_MOL_XE * xe;
  return { cancers, csiMoles: csi, xenonMoles: xe, verdict: verdictText(cancers) };
}

function verdictText(cancers: number): string {
  if (cancers < 0.001) {
    return 'No measurable public health impact. The lawyers are pleased.';
  }
  if (cancers < 0.1) {
    return `Statistically, about ${cancers.toFixed(3)} extra cancers. ` +
      `Less than the coal plant next door emits on a Tuesday. Still... paperwork.`;
  }
  if (cancers < 1) {
    return `Somewhere between 0 and ${Math.ceil(cancers * 3)} people may develop ` +
      `cancer because of this. Probably zero. Probably.`;
  }
  const low = Math.max(1, Math.round(cancers / 3));
  const high = Math.round(cancers * 3);
  return `You may have given somewhere between ${fmtPeople(low)} and ` +
    `${fmtPeople(high)} people cancer. But we'll never know for certain.`;
}

function fmtPeople(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} million`;
  if (n >= 1000) return `${Math.round(n / 100) / 10} thousand`;
  return `${n}`;
}
