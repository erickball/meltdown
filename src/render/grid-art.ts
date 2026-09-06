/**
 * Ground and surface textures for the grid view.
 *
 * Every surface is a repeating tile pattern anchored to the world lattice,
 * regenerated for the current zoom so pixels never scale (which is what
 * makes a canvas texture look like a texture rather than a blurred photo).
 *
 * Two sources, in order of preference:
 *  1. Image files under public/art/ listed in public/art/manifest.json (see
 *     docs/grid-view-design.md and scripts/gen-grid-art.mjs, which asks
 *     Google's image model for seamless top-down tiles and updates the
 *     manifest). Each image covers ART_TILE_SPAN x ART_TILE_SPAN tiles.
 *  2. Procedural textures drawn here, used for any surface the manifest
 *     does not list.
 */

/** How many tiles one texture image spans (edge to edge, seamless). */
export const ART_TILE_SPAN = 8;

export type SurfaceKind = 'ground' | 'concrete' | 'pad';

interface CachedPattern {
  ppm: number;
  fromImage: boolean;
  pattern: CanvasPattern;
}

/** Lists the texture files present under public/art/ (scripts/gen-grid-art.mjs maintains it). */
const ART_MANIFEST = 'art/manifest.json';

const SURFACE_FILES: Record<SurfaceKind, string> = {
  ground: 'art/ground.png',
  concrete: 'art/concrete.png',
  pad: 'art/pad.png',
};

// Deterministic noise so the texture is the same every regeneration
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export class GridArt {
  private images: Partial<Record<SurfaceKind, HTMLImageElement>> = {};
  private cache: Partial<Record<SurfaceKind, CachedPattern>> = {};

  constructor() {
    if (typeof Image === 'undefined' || typeof fetch === 'undefined') return; // headless
    // The manifest lists which texture files exist, so a plant with no
    // generated art makes one small request rather than a 404 per surface
    fetch(ART_MANIFEST).then(r => r.ok ? r.json() : { files: [] }).then((manifest: { files?: string[] }) => {
      const files = new Set(manifest.files ?? []);
      for (const kind of Object.keys(SURFACE_FILES) as SurfaceKind[]) {
        const file = SURFACE_FILES[kind];
        if (!files.has(file.slice('art/'.length))) continue;
        const img = new Image();
        img.onload = () => {
          this.images[kind] = img;
          delete this.cache[kind];
        };
        img.onerror = () => console.warn(`[GridArt] ${file} is listed in ${ART_MANIFEST} but failed to load`);
        img.src = file;
      }
    }).catch(err => console.warn('[GridArt] Could not read the art manifest:', err));
  }

  /**
   * Repeating pattern for a surface at a zoom (px per metre), anchored so a
   * tile boundary sits at world (0,0) projected to `originScreen`.
   */
  pattern(ctx: CanvasRenderingContext2D, kind: SurfaceKind, ppm: number, originScreen: { x: number; y: number }): CanvasPattern | string {
    // Patterns are regenerated per integer zoom bucket; below a few pixels a
    // tile has no texture to show and a flat colour is the honest rendering
    if (ppm < 4) return GridArt.flatColor(kind);
    const bucket = Math.round(ppm);
    const img = this.images[kind];
    let cached = this.cache[kind];
    if (!cached || cached.ppm !== bucket || cached.fromImage !== !!img) {
      const tile = this.buildTile(kind, bucket, img);
      const pattern = ctx.createPattern(tile, 'repeat');
      if (!pattern) return GridArt.flatColor(kind);
      cached = { ppm: bucket, fromImage: !!img, pattern };
      this.cache[kind] = cached;
    }
    // Slide the pattern so its tile lattice coincides with the world lattice
    // (the pattern repeats infinitely, so the plain origin translation is
    // enough) and scale it from the integer bucket to the true zoom
    const s = ppm / bucket;
    cached.pattern.setTransform(new DOMMatrix().translate(originScreen.x, originScreen.y).scale(s, s));
    return cached.pattern;
  }

  static flatColor(kind: SurfaceKind): string {
    switch (kind) {
      case 'ground': return '#a9a283';
      case 'concrete': return '#9d9c96';
      case 'pad': return '#7d807f';
    }
  }

  private buildTile(kind: SurfaceKind, ppm: number, img?: HTMLImageElement): HTMLCanvasElement {
    const px = ART_TILE_SPAN * ppm;
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d')!;
    if (img) {
      ctx.drawImage(img, 0, 0, px, px);
      return canvas;
    }
    switch (kind) {
      case 'ground': GridArt.drawGround(ctx, px, ppm); break;
      case 'concrete': GridArt.drawConcrete(ctx, px, ppm, 2, '#9d9c96', '#8c8b86', '#aaa9a3'); break;
      case 'pad': GridArt.drawConcrete(ctx, px, ppm, 1, '#7d807f', '#6c6f6e', '#8b8e8c'); break;
    }
    return canvas;
  }

  /**
   * Dry gravel-and-grass site: a warm base, soft mottling at the scale of
   * a few tiles, and fine speckle for grit. Everything is placed by a
   * seeded hash of position so the pattern tiles seamlessly.
   */
  private static drawGround(ctx: CanvasRenderingContext2D, px: number, ppm: number): void {
    ctx.fillStyle = '#aba585';
    ctx.fillRect(0, 0, px, px);

    // Mottling: overlapping soft blobs, wrapped at the edges for seamlessness
    const blobs = 28;
    for (let i = 0; i < blobs; i++) {
      const cx = seededRandom(i * 7 + 1) * px;
      const cy = seededRandom(i * 7 + 2) * px;
      const r = (0.8 + seededRandom(i * 7 + 3) * 1.8) * ppm;
      const green = seededRandom(i * 7 + 4) > 0.55;
      const color = green ? '150, 156, 110' : '190, 178, 140';
      const alpha = 0.10 + seededRandom(i * 7 + 5) * 0.12;
      for (const [dx, dy] of [[0, 0], [px, 0], [-px, 0], [0, px], [0, -px], [px, px], [-px, -px], [px, -px], [-px, px]]) {
        const g = ctx.createRadialGradient(cx + dx, cy + dy, 0, cx + dx, cy + dy, r);
        g.addColorStop(0, `rgba(${color}, ${alpha})`);
        g.addColorStop(1, `rgba(${color}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(cx + dx - r, cy + dy - r, r * 2, r * 2);
      }
    }

    // Grit: small speckles, density per tile fixed in world terms
    const speckles = Math.round(ART_TILE_SPAN * ART_TILE_SPAN * 26);
    const dotR = Math.max(0.6, ppm * 0.035);
    for (let i = 0; i < speckles; i++) {
      const x = seededRandom(1000 + i * 3) * px;
      const y = seededRandom(1000 + i * 3 + 1) * px;
      const shade = seededRandom(1000 + i * 3 + 2);
      ctx.fillStyle = shade < 0.45 ? 'rgba(120, 112, 84, 0.45)'
        : shade < 0.8 ? 'rgba(210, 204, 176, 0.5)' : 'rgba(96, 104, 70, 0.4)';
      ctx.beginPath();
      ctx.arc(x, y, dotR * (0.6 + shade * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }

    // Grass tufts, a few per tile, only once they can be resolved
    if (ppm >= 14) {
      const tufts = Math.round(ART_TILE_SPAN * ART_TILE_SPAN * 3);
      ctx.strokeStyle = 'rgba(96, 120, 64, 0.55)';
      ctx.lineWidth = Math.max(1, ppm * 0.03);
      ctx.lineCap = 'round';
      for (let i = 0; i < tufts; i++) {
        const x = seededRandom(5000 + i * 4) * px;
        const y = seededRandom(5000 + i * 4 + 1) * px;
        const h = ppm * (0.08 + seededRandom(5000 + i * 4 + 2) * 0.1);
        ctx.beginPath();
        for (let b = -1; b <= 1; b++) {
          ctx.moveTo(x, y);
          ctx.lineTo(x + b * h * 0.5, y - h);
        }
        ctx.stroke();
      }
    }
  }

  /**
   * Poured concrete: a flat base with fine grain and expansion joints every
   * `jointEvery` tiles (aligned to the lattice so slabs line up with cells).
   */
  private static drawConcrete(
    ctx: CanvasRenderingContext2D, px: number, ppm: number,
    jointEvery: number, base: string, dark: string, light: string
  ): void {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, px, px);

    const grains = Math.round(ART_TILE_SPAN * ART_TILE_SPAN * 40);
    const dotR = Math.max(0.5, ppm * 0.025);
    for (let i = 0; i < grains; i++) {
      const x = seededRandom(9000 + i * 3) * px;
      const y = seededRandom(9000 + i * 3 + 1) * px;
      const shade = seededRandom(9000 + i * 3 + 2);
      ctx.fillStyle = shade < 0.5 ? dark : light;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (ppm >= 8) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.lineWidth = Math.max(1, ppm * 0.04);
      ctx.beginPath();
      for (let k = 0; k < ART_TILE_SPAN; k += jointEvery) {
        const v = k * ppm + 0.5;
        ctx.moveTo(v, 0); ctx.lineTo(v, px);
        ctx.moveTo(0, v); ctx.lineTo(px, v);
      }
      ctx.stroke();
    }
  }
}
