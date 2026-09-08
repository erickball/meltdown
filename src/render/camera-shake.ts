/**
 * Camera shake: the view jolting during ground motion.
 *
 * This is a RENDER effect and nothing else. It lives entirely in the canvas
 * transform, so no component moves, no hit test changes and the simulation
 * never hears about it - a scenario's `shake` action queues an event, the
 * canvas starts one of these, and every frame until it runs out the whole
 * picture is drawn from a slightly different place.
 *
 * The offset is fresh random noise each frame (which is what reads as ground
 * motion rather than as a swing), inside an envelope that decays to nothing
 * over the requested duration, and the transform is a small scale-up about
 * the canvas centre as well as a translation, so the shifted picture still
 * covers the canvas and no bare edge is exposed.
 */

export interface ShakeOffset {
  /** Screen-pixel translation for this frame. */
  x: number;
  y: number;
  /** Scale about the canvas centre that keeps the shifted picture covering it. */
  scale: number;
}

/** Peak camera offset (px) when a shake asks for no amplitude of its own. */
const DEFAULT_AMPLITUDE = 12;

export class CameraShake {
  /** Wall-clock ms at which the current jolt started, or null when at rest. */
  private startedAt: number | null = null;
  private durationMs = 0;
  private amplitude = 0;

  /**
   * Start (or restart) a jolt. `seconds` is REAL time: a scenario firing at
   * 60x would otherwise be over before a frame was drawn.
   */
  start(seconds: number, amplitude?: number): void {
    if (!(seconds > 0)) return;
    this.startedAt = performance.now();
    this.durationMs = seconds * 1000;
    this.amplitude = amplitude !== undefined && amplitude > 0 ? amplitude : DEFAULT_AMPLITUDE;
  }

  get active(): boolean {
    return this.startedAt !== null;
  }

  /**
   * This frame's offset, or null when nothing is shaking. Call once per
   * frame: it advances the decay and retires the jolt when it is spent.
   */
  offset(width: number, height: number): ShakeOffset | null {
    if (this.startedAt === null) return null;
    const t = (performance.now() - this.startedAt) / this.durationMs;
    if (!(t < 1)) {
      this.startedAt = null;
      return null;
    }
    // Linear decay of the envelope, squared so the first half carries most of
    // the motion the way a real shock does
    const envelope = (1 - t) * (1 - t);
    const a = this.amplitude * envelope;
    const x = (Math.random() * 2 - 1) * a;
    const y = (Math.random() * 2 - 1) * a;
    const span = Math.max(1, Math.min(width, height));
    return { x, y, scale: 1 + (2 * this.amplitude) / span };
  }

  /** Apply an offset to a context (save/translate/scale). Caller restores. */
  static apply(ctx: CanvasRenderingContext2D, o: ShakeOffset, width: number, height: number): void {
    ctx.save();
    ctx.translate(width / 2 + o.x, height / 2 + o.y);
    ctx.scale(o.scale, o.scale);
    ctx.translate(-width / 2, -height / 2);
  }
}
