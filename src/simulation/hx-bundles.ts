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
 * around and back down; a straight tube runs once.
 *
 * HELICAL IS KNOWN WRONG at 1.0 and is left there deliberately. A helical
 * coil is the whole point of a helix - real once-through coils run 3-8x the
 * shell height - so both the heat area and the tube friction are understated
 * for every helical exchanger in the plant library. Raising it changes the
 * duty of every HTGR-style SG built so far, which is a calibration decision
 * rather than a bug fix, so it wants deciding rather than sneaking in.
 */
export function hxTubeLengthFactor(hxType: string | undefined): number {
  return hxType === 'utube' ? 2.1 : 1.0;
}

/** Tube inner diameter (m). The wall is not modelled per tube; 12% of OD is
 *  the usual thin-wall ratio for boiler tubing at these pressures. */
export function hxTubeInnerDiameter(tubeOD: number | undefined): number {
  return (tubeOD || 0.022) * 0.88;
}

/** Length of one tube through the bundle (m). */
export function hxTubeLength(hx: { hxType?: string; height?: number; plenumLength?: number }): number {
  return hxTubeLengthFactor(hx.hxType) *
    Math.max(1, (hx.height || 5) - (hx.plenumLength ?? 0.5));
}
