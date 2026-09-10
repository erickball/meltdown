/**
 * Where a reactor vessel's core barrel sits, measured up from the vessel's
 * base (m).
 *
 * One formula shared by the vessel painter (which draws the barrel inside the
 * vessel from the vessel's own gap fields) and anything that places the
 * core-barrel COMPONENT - a preset generator, say - so the barrel's ports land
 * on the ends of the barrel that is actually drawn.
 *
 * The gaps are measured from the inner dome surface at the barrel's outer
 * radius, so a barrel that nearly fills the vessel starts well above the
 * vessel's base: the hemispherical head curves up into the cylinder there.
 */
export interface BarrelGeometrySource {
  height: number;
  wallThickness: number;
  innerDiameter: number;
  barrelDiameter: number;      // centre-line diameter of the barrel wall
  barrelThickness: number;
  barrelBottomGap: number;
  barrelTopGap: number;
}

export function reactorBarrelExtent(v: BarrelGeometrySource): { bottom: number; top: number; height: number } {
  const vesselR = v.innerDiameter / 2;
  const barrelOuterR = v.barrelDiameter / 2 + v.barrelThickness / 2;
  if (!(barrelOuterR < vesselR)) {
    throw new Error(
      `[reactorBarrelExtent] barrel outer radius ${barrelOuterR.toFixed(3)} m does not fit ` +
      `inside the vessel's ${vesselR.toFixed(3)} m inner radius`);
  }
  const domeIntrusion = vesselR - Math.sqrt(vesselR * vesselR - barrelOuterR * barrelOuterR);
  const bottom = v.wallThickness + domeIntrusion + v.barrelBottomGap;
  const top = v.height - v.wallThickness - domeIntrusion - v.barrelTopGap;
  return { bottom, top, height: top - bottom };
}
