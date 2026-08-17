/**
 * Tube-bundle naming for heat exchangers.
 *
 * A heat exchanger's shell can hold more than one independent tube bundle
 * (`bundleCount`). Each bundle is its own flow node, its own tube metal, its
 * own burst boundary and - for moving-boundary tubes - its own subcooled /
 * boiling / superheated partition; they share the shell fluid and split the
 * shell flow between them. This is what lets one OTSG shell feed two separate
 * steam headers, the way a modular helical boiler does.
 *
 * The FIRST bundle keeps the names a single-bundle exchanger has always had
 * (`id-tube`, `id-tubes`, ports `id-tube-top` ...); later bundles suffix
 * `-b{n}`, counting from 2. That asymmetry is deliberate and load-bearing:
 * adding a bundle to an existing exchanger must not rename anything that
 * already exists, or every saved plant, preset and drawn connection into the
 * original bundle would break.
 *
 * These helpers are the ONE place that convention lives - the factory, the
 * renderer and the UI all read it from here.
 */

/** Number of independent tube bundles in this exchanger's shell (>= 1). */
export function hxBundleCount(hx: { bundleCount?: number } | undefined): number {
  const n = Math.round(hx?.bundleCount ?? 1);
  return n >= 1 ? n : 1;
}

/** Name suffix for bundle `b` (0-based): empty for the first bundle. */
export function hxBundleSuffix(b: number): string {
  return b > 0 ? `-b${b + 1}` : '';
}

/** Flow-node ID of bundle `b` (0-based). */
export function hxTubeNodeId(componentId: string, b: number): string {
  return `${componentId}-tube${hxBundleSuffix(b)}`;
}

/** Thermal-node ID of bundle `b`'s tube metal (0-based). */
export function hxTubeMetalId(componentId: string, b: number): string {
  return `${componentId}-tubes${hxBundleSuffix(b)}`;
}

/** Every bundle's flow-node ID, in bundle order. */
export function hxTubeNodeIds(componentId: string, count: number): string[] {
  return Array.from({ length: count }, (_, b) => hxTubeNodeId(componentId, b));
}

/** True for any heat-exchanger tube-side flow node ID (`x-tube`, `x-tube-b3`). */
export function isHxTubeNodeId(nodeId: string): boolean {
  return /-tube(-b\d+)?$/.test(nodeId);
}

/**
 * Bundle index (0-based) a port ID refers to. Ports of the second and later
 * bundles end in `-b{n}`; anything else belongs to the first bundle.
 */
export function hxBundleIndexFromPortId(portId: string): number {
  const m = /-b(\d+)$/.exec(portId);
  return m ? Math.max(0, parseInt(m[1], 10) - 1) : 0;
}

/**
 * Per-tube length as a multiple of the bundle's height: a U-tube runs up,
 * around and back down; a straight tube runs once; a helical coil winds, and
 * how far it winds is geometry, not a guess.
 *
 * A helix of radius r and pitch P has length sqrt(1 + (2 pi r / P)^2) per unit
 * of axial rise, so the factor is set by how tightly the coil is wound - and
 * what sets THAT is packing. The bundle has to fit in the annulus between the
 * central riser and the shell wall, and the tubes it contains occupy
 *
 *     N * lambda * H * (pi/4) d^2   of   phi * pi (r_out^2 - r_in^2) * H
 *
 * so lambda = 4 phi (r_out^2 - r_in^2) / (N d^2). Fewer tubes in the same
 * shell means each one has to be longer to fill it - which is exactly the
 * trade a designer makes, and why tube count and tube length cannot be set
 * independently.
 *
 * phi = 0.2 is the volumetric packing of a GAS-side helical bundle: the tubes
 * take a fifth of the annulus and the rest is flow path, because a gas side
 * that packs tighter cannot pass its flow without eating the whole pressure
 * budget. (A liquid-side bundle packs 2-3x tighter, which is why this is a
 * helical-specific number.) For a 2.8 m shell with 300 tubes of 19 mm it
 * gives ~12, or ~170 m of tube - the right order for a 200 MW helical SG,
 * whose surface has to come out near 3000 m2.
 */
const HELICAL_PACKING = 0.20;
/** The tightest a bundle could be wound before tubes touch - the fit limit a
 *  hand-set factor is checked against. */
const HELICAL_PACKING_MAX = 0.55;
/** The coil annulus as fractions of the shell radius: a central riser inside,
 *  a clearance outside. */
const COIL_R_IN = 0.30, COIL_R_OUT = 0.95;

export interface HxTubeGeometry {
  hxType?: string;
  width?: number;
  height?: number;
  plenumLength?: number;
  tubeOD?: number;
  tubeCount?: number;
  /** Hand-set length factor, overriding the packing derivation. Refused if
   *  the tubes would not physically fit. */
  tubeLengthFactor?: number;
}

/** Coil annulus cross-section (m2) available to the tubes. */
function coilAnnulusArea(hx: HxTubeGeometry): number {
  const R = (hx.width ?? 3) / 2;
  return Math.PI * ((COIL_R_OUT * R) ** 2 - (COIL_R_IN * R) ** 2);
}

/** The length factor a helical bundle's own geometry implies. */
export function helicalLengthFactor(hx: HxTubeGeometry): number {
  const d = hx.tubeOD || 0.022;
  const n = Math.max(1, hx.tubeCount || 1000);
  const tubeCrossSection = Math.PI * d * d / 4;
  return HELICAL_PACKING * coilAnnulusArea(hx) / (n * tubeCrossSection);
}

export function hxTubeLengthFactor(hx: HxTubeGeometry | string | undefined): number {
  // Callers that only have the type keep the simple behaviour.
  if (typeof hx === 'string' || hx === undefined) {
    return hx === 'utube' ? 2.1 : 1.0;
  }
  const derived = hx.hxType === 'utube' ? 2.1
    : hx.hxType === 'helical' ? helicalLengthFactor(hx)
    : 1.0;
  const manual = hx.tubeLengthFactor;
  if (manual === undefined) {
    if (derived < 1) {
      throw new Error(
        `[HX] ${hx.tubeCount} tubes of ${((hx.tubeOD || 0.022) * 1e3).toFixed(0)} mm cannot fit ` +
        `a ${(hx.width ?? 3).toFixed(1)} m shell: even wound flat they need ` +
        `${(1 / derived).toFixed(1)}x the annulus there is. Fewer tubes, or a wider shell.`);
    }
    return derived;
  }
  // A hand-set factor is honoured as long as the tubes fit. Winding tighter
  // than the derivation means packing denser, and there is a limit.
  const maxFactor = derived * (HELICAL_PACKING_MAX / HELICAL_PACKING);
  if (!(manual >= 1)) {
    throw new Error(
      `[HX] tubeLengthFactor ${manual} is below 1 - a tube cannot be shorter than the ` +
      `bundle it runs through.`);
  }
  if (hx.hxType === 'helical' && manual > maxFactor) {
    throw new Error(
      `[HX] tubeLengthFactor ${manual.toFixed(1)} does not fit: ${hx.tubeCount} tubes that long ` +
      `would pack ${(HELICAL_PACKING * manual / derived * 100).toFixed(0)}% of the coil annulus, ` +
      `past the ${(HELICAL_PACKING_MAX * 100).toFixed(0)}% where tubes touch. The most that fits ` +
      `is ${maxFactor.toFixed(1)}.`);
  }
  return manual;
}

/** Tube inner diameter (m). The wall is not modelled per tube; 12% of OD is
 *  the usual thin-wall ratio for boiler tubing at these pressures. */
export function hxTubeInnerDiameter(tubeOD: number | undefined): number {
  return (tubeOD || 0.022) * 0.88;
}

/** Length of one tube through the bundle (m). */
export function hxTubeLength(hx: HxTubeGeometry): number {
  return hxTubeLengthFactor(hx) *
    Math.max(1, (hx.height || 5) - (hx.plenumLength ?? 0.5));
}
