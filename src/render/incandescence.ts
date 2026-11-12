/**
 * Incandescence: the colour a hot surface glows, from Planck's law.
 *
 * The pipeline is the physical one a camera follows:
 *   Planck spectral radiance B(lambda, T) x emissivity
 *   -> CIE 1931 XYZ (integrated against the colour-matching functions)
 *   -> linear sRGB (D65)
 *   -> scaled by a fixed exposure and ADDED to the light the cold surface
 *      reflects (the surface's own colour, linearised)
 *   -> sRGB-encoded for the canvas.
 *
 * Nothing here is a hand-picked colour ramp: the hue at each temperature is
 * the blackbody's chromaticity, and the brightness follows the real visible
 * luminance, which climbs by orders of magnitude between ~800 K (Draper
 * point, the first faint red) and ~1500 K. The one free choice is EXPOSURE:
 * how bright a given radiance looks on screen, like a camera's exposure
 * setting - plus a compressive brightness response (see GAMMA), and a
 * film-like channel response so very hot metal reads yellow-white rather
 * than as a clipped, saturated orange.
 *
 * Out-of-gamut handling is a display matter: a low-temperature blackbody is
 * redder than sRGB's red primary, so its negative green/blue components are
 * dropped. That changes no physics; it is the closest colour a monitor can
 * show.
 */

export interface RGB { r: number; g: number; b: number }

const H = 6.62607015e-34;
const C = 2.99792458e8;
const KB = 1.380649e-23;
const C2 = (H * C) / KB; // second radiation constant, m*K

/** CIE 1931 2-degree colour-matching functions, Wyman-Sloan-Shirley (2013)
 *  multi-lobe fit. Good to well under 1% of the tabulated values - far below
 *  anything visible here. lambda in nm. */
function g(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
function cmf(l: number): [number, number, number] {
  const x = 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
  const y = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
  const z = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
  return [x, y, z];
}

/** Blackbody XYZ (arbitrary but consistent radiance units) at temperature T. */
function blackbodyXYZ(T: number): [number, number, number] {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 5) {
    const lm = l * 1e-9;
    // Planck, dropping the constant 2hc^2 prefactor (absorbed into EXPOSURE)
    const B = 1 / (lm ** 5 * Math.expm1(C2 / (lm * T)));
    const [x, y, z] = cmf(l);
    X += B * x; Y += B * y; Z += B * z;
  }
  return [X, Y, Z];
}

function xyzToLinearSRGB(X: number, Y: number, Z: number): [number, number, number] {
  return [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.2040 * Y + 1.0570 * Z,
  ];
}

/** Below this the visible emission is ~1e-6 of the exposure scale: invisible. */
const T_MIN = 600;
const T_MAX = 4000;
const T_STEP = 10;

/**
 * Exposure: the temperature whose blackbody luminance is the unit of the
 * brightness response. With the response below, ~800 K is a barely-there
 * red on a dark surface, ~1000 K dull cherry red, ~1300 K orange-red, 1500 K
 * orange, ~2000 K yellow and ~3000 K near-white - in line with the
 * traditional heat-colour charts for steel.
 */
const T_EXPOSURE = 1500;

/** Linear-sRGB emission per unit emissivity, tabulated on a T grid. */
const TABLE: Float64Array = (() => {
  const n = Math.round((T_MAX - T_MIN) / T_STEP) + 1;
  const tab = new Float64Array(n * 3);
  const Yref = blackbodyXYZ(T_EXPOSURE)[1];
  for (let i = 0; i < n; i++) {
    const [X, Y, Z] = blackbodyXYZ(T_MIN + i * T_STEP);
    const rgb = xyzToLinearSRGB(X / Yref, Y / Yref, Z / Yref);
    for (let k = 0; k < 3; k++) tab[i * 3 + k] = Math.max(0, rgb[k]); // out of gamut: see header
  }
  return tab;
})();

/**
 * Linear-sRGB glow of a body at temperature T (K), relative to the exposure
 * scale (1 = full-scale). Above T_MAX the colour is held at T_MAX's
 * chromaticity, which is already far past full white at this exposure.
 */
export function blackbodyLinearRGB(T: number, emissivity = 1): [number, number, number] {
  if (!(T > T_MIN)) return [0, 0, 0];
  const f = (Math.min(T, T_MAX) - T_MIN) / T_STEP;
  const i = Math.min(Math.floor(f), TABLE.length / 3 - 2);
  const t = f - i;
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] = emissivity * (TABLE[i * 3 + k] * (1 - t) + TABLE[(i + 1) * 3 + k] * t);
  }
  return out;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(v: number): number {
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(255 * s);
}

/**
 * Brightness response. Visible luminance rises ~10 decades from 800 K to
 * 3000 K; a linear exposure would show nothing, then jump to white within
 * ~200 K. The eye (and a camera with any dynamic range) compresses this, so
 * the emission is scaled by (Y / Y_ref)^(GAMMA - 1): the chromaticity is
 * kept, but luminance goes as Y^GAMMA, roughly how perceived brightness
 * tracks luminance (Stevens' power law, exponent ~1/3 to 1/2).
 */
const GAMMA = 0.4;

/** Film-like channel response: x -> 1 - exp(-x). Applied to the TOTAL light
 *  (reflected + emitted), so a channel saturates smoothly and the others
 *  catch up as the glow brightens: over-exposed metal goes yellow-white
 *  instead of clipping at saturated orange. */
const film = (x: number) => 1 - Math.exp(-x);
const filmInv = (y: number) => -Math.log(1 - Math.min(y, 0.999));

/**
 * The on-screen colour of a surface of cold colour `base` at temperature T:
 * the light it reflects plus the light it emits. Emissivity defaults to 0.8,
 * typical of oxidised steel, oxidised zircaloy and UO2.
 */
export function incandescentColor(base: RGB, T: number, emissivity = 0.8): RGB {
  const e = blackbodyLinearRGB(T, emissivity);
  const Y = 0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2];
  const k = Y > 0 ? Y ** (GAMMA - 1) : 0;
  // The cold colour, read as the film's response to the reflected light, so
  // a body too cool to glow is drawn in exactly its base colour.
  const out = [base.r, base.g, base.b].map((c, i) =>
    linearToSrgb(film(filmInv(srgbToLinear(c)) + k * e[i])));
  return { r: out[0], g: out[1], b: out[2] };
}

/**
 * How strongly a body at T glows, 0..1: the emitted luminance on the
 * exposure scale. For secondary effects (halos) that should track the glow.
 */
export function incandescentIntensity(T: number, emissivity = 0.8): number {
  const [r, gg, b] = blackbodyLinearRGB(T, emissivity);
  return film((0.2126 * r + 0.7152 * gg + 0.0722 * b) ** GAMMA);
}
