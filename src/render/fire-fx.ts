/**
 * Fire effects: flames and smoke over something that is burning.
 *
 * Kept in its own file, out of the view modules, because a fire is drawn the
 * same way wherever it is seen and because the view files are big and busy.
 *
 * THE INTENSITY IS PHYSICS, THE FLAMES ARE NOT. Nothing in here decides
 * whether anything is burning: it reads the chemical power the oxidation
 * operator actually released this step and draws that much fire. When the
 * zirconium is spent, or the oxygen runs out, the power falls and the
 * flames go with it - there is no separate "the fire is out" rule to get out
 * of step with the model.
 *
 * The drawing itself is procedural: a set of tongues per source, each a
 * quadratic curve whose tip wanders on a couple of sine terms at
 * incommensurate frequencies (so the flicker never repeats visibly), and a
 * plume of smoke puffs rising and spreading above them. Everything is
 * derived from the source's seed and the clock, so nothing has to be stored
 * between frames and a paused simulation holds a still flame.
 */

/** Chemical power (W) that reads as a fully developed fire. */
export const FULL_FIRE_POWER = 20e6;

/**
 * One burning thing, in screen coordinates.
 *
 * `x, y, w, h` is the rectangle the flames rise from - the top of the
 * burning object as it is drawn. `intensity` is 0..1.
 */
export interface FireSource {
  x: number;
  y: number;
  w: number;
  h: number;
  intensity: number;
  /** Stable per-source number so its tongues do not jump between frames. */
  seed: number;
}

/**
 * Map a chemical power to a 0..1 fire intensity.
 *
 * Logarithmic, because a fire that has just caught and a fire in full cry
 * are two orders of magnitude apart in watts and both have to be visible.
 * Below a hundredth of the reference the answer is 0 and nothing is drawn -
 * that is a DISPLAY floor (a flame one pixel high is noise), not a physical
 * one; the reaction goes on underneath it whatever this returns.
 */
export function fireIntensity(powerW: number, referenceW = FULL_FIRE_POWER): number {
  if (!(powerW > 0) || !(referenceW > 0)) return 0;
  const ratio = powerW / referenceW;
  if (ratio < 0.01) return 0;
  // 0 at 1% of reference, 1 at reference, saturating above it.
  const t = (Math.log10(ratio) + 2) / 2;
  return Math.max(0, Math.min(1, t));
}

/** Deterministic 0..1 hash of an integer-ish seed. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Draw flames and smoke for every source. `timeMs` is any monotonic clock -
 * performance.now() is what the canvas passes - and only differences matter.
 */
export function drawFires(
  ctx: CanvasRenderingContext2D,
  sources: FireSource[],
  timeMs: number
): void {
  if (sources.length === 0) return;
  const t = timeMs / 1000;

  for (const src of sources) {
    const i = Math.max(0, Math.min(1, src.intensity));
    if (i <= 0) continue;

    // Smoke first, so the flames sit in front of it.
    drawSmoke(ctx, src, t, i);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // More tongues, taller and brighter, as the fire develops.
    const tongues = Math.max(3, Math.round(4 + 10 * i));
    const baseHeight = src.h * (0.5 + 2.5 * i);

    for (let k = 0; k < tongues; k++) {
      const s = src.seed + k * 7.13;
      const px = src.x + src.w * (0.08 + 0.84 * hash(s));
      const py = src.y + src.h * (0.15 + 0.7 * hash(s + 1.7));

      // Two incommensurate wobbles: the tip never traces the same path twice.
      const speed = 1.1 + 0.9 * hash(s + 2.3) + 0.8 * i;
      const phase = 6.283 * hash(s + 3.1);
      const flicker = 0.55 + 0.45 * Math.sin(t * speed * 2.7 + phase)
        * Math.sin(t * speed * 1.31 + phase * 1.7);
      const height = baseHeight * (0.45 + 0.75 * hash(s + 4.9)) * flicker;
      if (height < 1) continue;
      const lean = (hash(s + 5.5) - 0.5) * height * 0.5
        + Math.sin(t * speed * 0.9 + phase) * height * 0.18;
      const width = Math.max(1.5, src.w * (0.05 + 0.10 * hash(s + 6.7)) + height * 0.10);

      // Body of the tongue: hot core low, orange upper, transparent tip.
      const grad = ctx.createLinearGradient(px, py, px + lean * 0.6, py - height);
      grad.addColorStop(0, `rgba(255, 250, 200, ${0.55 * i + 0.25})`);
      grad.addColorStop(0.35, `rgba(255, 170, 40, ${0.5 * i + 0.2})`);
      grad.addColorStop(0.75, `rgba(220, 80, 20, ${0.3 * i + 0.1})`);
      grad.addColorStop(1, 'rgba(120, 30, 10, 0)');
      ctx.fillStyle = grad;

      ctx.beginPath();
      ctx.moveTo(px - width / 2, py);
      ctx.quadraticCurveTo(px - width * 0.55 + lean * 0.4, py - height * 0.55,
        px + lean, py - height);
      ctx.quadraticCurveTo(px + width * 0.55 + lean * 0.4, py - height * 0.55,
        px + width / 2, py);
      ctx.closePath();
      ctx.fill();
    }

    // A glow pooled over the whole source, so a big fire lights its own area.
    const cx = src.x + src.w / 2;
    const cy = src.y + src.h * 0.5;
    const r = Math.max(src.w, src.h) * (0.6 + 0.6 * i);
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const pulse = 0.8 + 0.2 * Math.sin(t * 3.3 + src.seed);
    glow.addColorStop(0, `rgba(255, 160, 60, ${0.30 * i * pulse})`);
    glow.addColorStop(1, 'rgba(255, 120, 40, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

/**
 * A plume of smoke above a source: puffs launched on a fixed cycle, rising,
 * spreading and thinning. Drawn in normal composition (smoke hides what is
 * behind it) under the flames.
 */
function drawSmoke(
  ctx: CanvasRenderingContext2D,
  src: FireSource,
  t: number,
  intensity: number
): void {
  const puffs = Math.round(6 + 14 * intensity);
  const rise = src.h * (3 + 9 * intensity);
  const period = 3.2;
  ctx.save();
  for (let k = 0; k < puffs; k++) {
    const s = src.seed + 100 + k * 3.77;
    // Each puff has its own launch offset within the cycle.
    const age = ((t / period) + hash(s)) % 1;
    const y = src.y + src.h * 0.3 - age * rise;
    const drift = (hash(s + 0.5) - 0.5) * src.w * 1.6 * age
      + Math.sin(t * 0.7 + s) * src.w * 0.25 * age;
    const x = src.x + src.w * (0.2 + 0.6 * hash(s + 1.1)) + drift;
    const radius = src.w * (0.12 + 0.25 * hash(s + 2.2)) * (0.4 + 2.2 * age);
    if (radius < 0.5) continue;
    // Dark and dense near the fire, pale and thin as it climbs and cools.
    const alpha = 0.35 * intensity * (1 - age) * (1 - age);
    const grey = Math.round(40 + 110 * age);
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, `rgba(${grey}, ${grey}, ${grey}, ${alpha})`);
    g.addColorStop(1, `rgba(${grey}, ${grey}, ${grey}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ============================================================================
// Collecting the fires from the simulation
// ============================================================================

/**
 * Every cladding node releasing chemical power, as a fire source over the
 * component it belongs to.
 *
 * `powerByNode` is what the oxidation operator reported for its last rate
 * evaluation, keyed by thermal-node id (`<component>-clad`). `bounds` gives
 * the screen rectangle the flames should rise from - the caller decides what
 * that means in its own projection, which is the only thing the two views
 * disagree about.
 */
export function collectCladdingFires(
  componentIds: Iterable<string>,
  powerByNode: ReadonlyMap<string, number>,
  bounds: (componentId: string) => { x: number; y: number; w: number; h: number } | null
): FireSource[] {
  const out: FireSource[] = [];
  let seed = 1;
  for (const componentId of componentIds) {
    const power = powerByNode.get(`${componentId}-clad`);
    if (power === undefined) continue;
    const intensity = fireIntensity(power);
    if (intensity <= 0) continue;
    const rect = bounds(componentId);
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) continue;
    out.push({ ...rect, intensity, seed: seed++ * 13.7 });
  }
  return out;
}
