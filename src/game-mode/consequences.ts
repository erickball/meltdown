/**
 * Radiological source-term summary for career mode: turn the simulation's
 * environmentalRelease (moles of Xe and CsI that crossed the plant boundary)
 * into a released-radioactivity figure and a severity index used for the
 * level's release limit.
 *
 * Weighting: CsI aerosol deposits downwind and dominates the significance of a
 * release; noble-gas xenon disperses and is far less significant per mole. The
 * weights are chosen so a full-core volatile release from a ~3 GWt core
 * (~750 mol CsI-equivalent) lands at a severity of order 10^4, and a stuck-
 * valve whiff lands well below 1. Approximate released activity is reported for
 * flavor (roughly 5e14 Bq per mole of CsI-equivalent, 5e11 per mole of Xe).
 */

const CSI_WEIGHT = 60;
const XE_WEIGHT = 0.02;
const BQ_PER_MOL_CSI = 5e14;
const BQ_PER_MOL_XE = 5e11;

export interface ReleaseAssessment {
  csiMoles: number;
  xenonMoles: number;
  becquerels: number;   // approximate released activity
  severity: number;     // dimensionless release index (drives the level limit)
  verdict: string;      // player-facing description of the release size
}

export function assessRelease(
  environmentalRelease: Record<string, number> | undefined
): ReleaseAssessment {
  const csi = environmentalRelease?.CsI ?? 0;
  const xe = environmentalRelease?.Xe ?? 0;
  const severity = CSI_WEIGHT * csi + XE_WEIGHT * xe;
  const becquerels = BQ_PER_MOL_CSI * csi + BQ_PER_MOL_XE * xe;
  return {
    csiMoles: csi,
    xenonMoles: xe,
    becquerels,
    severity,
    verdict: verdictText(severity, becquerels),
  };
}

/** Format approximate released activity in becquerels. */
export function formatActivity(bq: number): string {
  if (bq >= 1e15) return `${(bq / 1e15).toFixed(1)} PBq`;
  if (bq >= 1e12) return `${(bq / 1e12).toFixed(1)} TBq`;
  if (bq >= 1e9) return `${(bq / 1e9).toFixed(1)} GBq`;
  if (bq >= 1e6) return `${(bq / 1e6).toFixed(1)} MBq`;
  return `${bq.toFixed(0)} Bq`;
}

function verdictText(severity: number, bq: number): string {
  if (severity < 0.001) {
    return 'Only a trace of noble gas reached the environment - barely a twitch on the fence monitors.';
  }
  if (severity < 0.1) {
    return `You vented roughly ${formatActivity(bq)} of radioactivity, mostly noble gas that disperses on the wind. Expect a strongly worded letter.`;
  }
  if (severity < 1) {
    return `A genuine release: about ${formatActivity(bq)}, including cesium-iodine aerosol that settles downwind. This one makes the news.`;
  }
  return `A major release on the order of ${formatActivity(bq)}, much of it long-lived aerosol spread across the countryside. An unambiguous disaster.`;
}
