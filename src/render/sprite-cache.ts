/**
 * Offscreen caches for the 2.5D view.
 *
 * The 2.5D frame used to redraw every component from vector primitives
 * (arcs, gradients, text) on every animation frame, whether or not anything
 * about the component had changed. Grid view, which blits pre-rendered
 * tiles, ran noticeably faster on the same plant. These caches close that
 * gap: a component's picture is painted once into its own canvas, keyed on
 * everything the painter reads, and blitted until that key changes.
 *
 * Readings are quantized in the key (temperature to 1 K, everything else to
 * a fraction of a percent, below what any readout or fill height can show),
 * so a node sitting at steady state hits the cache even though its numbers
 * jitter in the last digits.
 *
 * A sprite is painted at the component's exact projected zoom and blitted
 * 1:1 at a device-pixel-snapped origin, so a still frame is pixel-identical
 * to the vector drawing. While the camera is moving, a sprite whose content
 * key still matches but whose zoom is a little off is blitted scaled rather
 * than repainted - the picture is slightly soft for the duration of the pan
 * and snaps back to crisp on the first still frame.
 */

import { Fluid } from '../types';

/** How far a stale sprite's zoom may be from the current one during a pan. */
const PAN_ZOOM_TOLERANCE = 0.2;

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** Drawing origin inside the sprite, CSS px from the top-left corner. */
  ox: number;
  oy: number;
  /** Sprite size in CSS px. */
  w: number;
  h: number;
  /** Zoom (px per meter) the sprite was painted at. */
  zoom: number;
}

interface Entry {
  key: string;
  sprite: Sprite;
  seen: number;
}

export interface SpriteCacheStats {
  hits: number;
  /** Blits of a content-matching sprite at a nearby zoom (camera moving). */
  scaledHits: number;
  misses: number;
  /** Total device pixels held by all sprites. */
  pixels: number;
}

function isFluid(v: unknown): v is Fluid {
  return typeof v === 'object' && v !== null && 'temperature' in v && 'phase' in v;
}

/** Relative quantization as a stable integer bucket (sign preserved). */
function relBucket(x: number, step: number): number {
  const a = Math.abs(x);
  if (!(a > 1e-12)) return 0;
  return Math.sign(x) * Math.round(Math.log(a) / Math.log(1 + step));
}

/**
 * JSON replacer that quantizes a fluid reading to what the painters can show
 * of it, so a node whose numbers drift in the last digits serializes to the
 * same key frame after frame. Design values (geometry, ratings, setpoints)
 * pass through exactly.
 *
 * What the component painters read from a fluid: temperature (color only),
 * pressure (saturation temperature for color, vapor volume fraction, NCG
 * partial pressures), quality and separation (fill heights and stratification),
 * volume and mass (NCG fraction), the ncg map (species mix and fraction).
 * flowRate is read only by the inline pipe path, which is never cached.
 *
 * Every other number (geometry, actuator positions that stroke continuously
 * under control, rod position, fuel temperature) is keyed to 0.1% - one
 * part in a thousand of a component's size is well under a pixel, and the
 * color ramps step slower than that.
 */
function quantizingReplacer(this: unknown, key: string, value: unknown): unknown {
  const holder = this as Record<string, unknown>;
  if (!isFluid(holder)) {
    if (typeof value === 'number') {
      const a = Math.abs(value);
      return a < 1 ? Math.round(value * 1000) : relBucket(value, 0.001);
    }
    return value;
  }
  if (key === 'ncg') {
    if (!value || typeof value !== 'object') return value;
    const mols = value as Record<string, number>;
    let total = 0;
    for (const sp in mols) total += mols[sp];
    const out: Record<string, number> = { _tot: relBucket(total, 0.01) };
    for (const sp in mols) out[sp] = total > 0 ? Math.round(100 * mols[sp] / total) : 0;
    return out;
  }
  if (typeof value !== 'number') return value;
  switch (key) {
    case 'temperature': return Math.round(value);
    case 'pressure': return relBucket(value, 0.005);
    case 'quality': case 'separation': return Math.round(value * 100);
    case 'flowRate': return 0;
    default: return relBucket(value, 0.01);
  }
}

/** Serialize a component (or any object) with quantized fluid readings. */
export function quantizedKey(obj: unknown): string {
  return JSON.stringify(obj, quantizingReplacer);
}

/**
 * Does this key describe a picture that animates on its own? Two-phase and
 * NCG-bearing fluids draw a speckle that re-seeds once a second.
 */
export function keyAnimates(key: string): boolean {
  return key.includes('"two-phase"') || /"ncg":\{[^}]*[1-9]/.test(key);
}

export class ComponentSpriteCache {
  private entries = new Map<string, Entry>();
  private frame = 0;
  stats: SpriteCacheStats = { hits: 0, scaledHits: 0, misses: 0, pixels: 0 };

  /** Call once per frame; entries not touched for a while are released. */
  beginFrame(): void {
    this.frame++;
    this.stats.hits = 0;
    this.stats.scaledHits = 0;
    this.stats.misses = 0;
    if (this.frame % 120 === 0) {
      for (const [id, e] of this.entries) {
        if (this.frame - e.seen > 120) {
          this.stats.pixels -= e.sprite.canvas.width * e.sprite.canvas.height;
          this.entries.delete(id);
        }
      }
    }
  }

  /**
   * Fetch the sprite for `id` matching content `key` at `zoom`, painting it
   * if needed. While `cameraMoving`, a sprite with the same content at a
   * nearby zoom is returned instead of repainting (blit scales it).
   * `halfW`/`halfH` are the component's nominal half extents in CSS px at
   * `zoom`, after `verticalScale`; the sprite is given a margin around them
   * for labels, readouts and highlights that overhang.
   */
  get(
    id: string,
    key: string,
    zoom: number,
    cameraMoving: boolean,
    halfW: number,
    halfH: number,
    verticalScale: number,
    dpr: number,
    paint: (ctx: CanvasRenderingContext2D) => void
  ): Sprite {
    const existing = this.entries.get(id);
    if (existing && existing.key === key) {
      if (existing.sprite.zoom === zoom) {
        existing.seen = this.frame;
        this.stats.hits++;
        return existing.sprite;
      }
      if (cameraMoving && Math.abs(existing.sprite.zoom / zoom - 1) < PAN_ZOOM_TOLERANCE) {
        existing.seen = this.frame;
        this.stats.scaledHits++;
        return existing.sprite;
      }
    }
    this.stats.misses++;

    // Sized in whole device pixels, with the origin on a device pixel, so
    // the blit at a snapped origin maps 1:1 and never resamples
    const mx = 0.5 * halfW + 48;
    const my = 0.5 * halfH + 48;
    const pw = 2 * Math.ceil((halfW + mx) * dpr);
    const ph = 2 * Math.ceil((halfH + my) * dpr);
    const w = pw / dpr;
    const h = ph / dpr;

    let canvas = existing?.sprite.canvas;
    if (canvas && canvas.width === pw && canvas.height === ph) {
      const c = canvas.getContext('2d')!;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, pw, ph);
    } else {
      if (canvas) this.stats.pixels -= canvas.width * canvas.height;
      canvas = document.createElement('canvas');
      canvas.width = pw;
      canvas.height = ph;
      this.stats.pixels += pw * ph;
    }

    const sctx = canvas.getContext('2d')!;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.translate(w / 2, h / 2);
    sctx.scale(1, verticalScale);
    paint(sctx);

    const sprite: Sprite = { canvas, ox: w / 2, oy: h / 2, w, h, zoom };
    this.entries.set(id, { key, sprite, seen: this.frame });
    return sprite;
  }

  /** Blit a sprite at the current origin, scaled from its zoom to `zoom`. */
  static blit(ctx: CanvasRenderingContext2D, sprite: Sprite, zoom: number): void {
    const s = zoom / sprite.zoom;
    ctx.save();
    ctx.scale(s, s);
    ctx.drawImage(sprite.canvas, -sprite.ox, -sprite.oy, sprite.w, sprite.h);
    ctx.restore();
  }

  clear(): void {
    this.entries.clear();
    this.stats.pixels = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Whole-frame layer cache: one offscreen canvas keyed on a string. Used for
 * the ground (sky, sand, shrubs, mountains), which only changes when the
 * camera or the viewport does.
 */
export class LayerCache {
  private canvas: HTMLCanvasElement | null = null;
  private key = '';
  hits = 0;
  misses = 0;

  draw(
    ctx: CanvasRenderingContext2D,
    key: string,
    width: number,
    height: number,
    dpr: number,
    paint: (ctx: CanvasRenderingContext2D) => void
  ): void {
    const pw = Math.ceil(width * dpr);
    const ph = Math.ceil(height * dpr);
    if (!this.canvas || this.key !== key || this.canvas.width !== pw || this.canvas.height !== ph) {
      this.misses++;
      if (!this.canvas || this.canvas.width !== pw || this.canvas.height !== ph) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = pw;
        this.canvas.height = ph;
      }
      const c = this.canvas.getContext('2d')!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, width, height);
      paint(c);
      this.key = key;
    } else {
      this.hits++;
    }
    // Device pixel to device pixel, so a fractional CSS size never resamples
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.canvas, 0, 0);
    ctx.restore();
  }

  clear(): void {
    this.canvas = null;
    this.key = '';
  }
}
