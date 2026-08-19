/**
 * Shared size law for readouts drawn over the plant: pressure gauges,
 * thermometers, flow-rate labels, MW readouts, valve and elevation text.
 *
 * `raw` is the true perspective scale of whatever the readout is attached to
 * (1 = nominal camera distance). In perspective mode that is the projection
 * scale from worldToScreenPerspective (screen px = meters * 50 * raw); text
 * drawn inside a component renderer can pass `view.zoom / 50`.
 *
 * Close in (raw >= 1) the readout scales directly - realistic, pinned to its
 * component - capped at READOUT_MAX_SCALE so an extreme close-up doesn't fill
 * the screen with a single dial. Zoomed out (raw < 1) it follows
 * raw^READOUT_FAR_EXPONENT instead, shrinking more slowly than reality so it
 * stays readable longer, but with NO floor: readouts still taper smoothly
 * away to nothing in the far distance.
 */
// Tuning notes: typical raw scales in play are ~0.35-0.5 at the default view
// and ~0.08-0.2 zoomed out to the whole plant; raw >= 1 only when inspecting a
// component up close. 0.3 keeps a 12px label ~7px at whole-plant distance
// (the old floors pinned it at 11px; fully realistic would be ~1.5px).
export const READOUT_FAR_EXPONENT = 0.3; // 1 = realistic shrink, 0 = never shrinks
export const READOUT_MAX_SCALE = 2.5; // close-up cap (matches the old gauge cap)

export function readoutScale(raw: number): number {
  if (!(raw > 0)) return 0;
  return Math.min(READOUT_MAX_SCALE, raw < 1 ? Math.pow(raw, READOUT_FAR_EXPONENT) : raw);
}
