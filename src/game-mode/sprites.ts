/**
 * Pixel portraits for the career-mode dialogue scenes.
 *
 * Deliberately corny 90s-PC-game art: 24x24 character grids, hand-authored
 * as strings (one char = one pixel, '.' = transparent), rendered to canvas
 * with image smoothing off. Each character has a base face, per-mood eye and
 * mouth patches, a 2-frame talk animation (mouth open/closed), and a blink
 * overlay. That's the whole animation system, as nature intended in 1994.
 */

export const SPRITE_SIZE = 24;

type Grid = string[];

/** Palette: char -> CSS color. Shared across characters. */
const PALETTE: Record<string, string> = {
  k: '#1a1208',   // outline / near-black
  s: '#e8b088',   // skin
  S: '#c8845c',   // skin shadow / jowl lines
  n: '#f0c8a0',   // skin highlight
  h: '#b0b0b0',   // gray hair
  H: '#7c4f28',   // brown hair
  w: '#f4f4f4',   // white (shirt, eyes)
  e: '#20242c',   // pupil
  g: '#4a4e58',   // suit gray
  G: '#343842',   // suit shadow
  r: '#a02828',   // tie red
  b: '#6b4226',   // cigar brown
  o: '#ff8020',   // cigar ember
  m: '#5c2020',   // open mouth dark
  t: '#ffffff',   // teeth
  y: '#e8c840',   // hard hat yellow
  Y: '#c0a020',   // hard hat shade
  p: '#f4a0a0',   // panic cheeks
  c: '#c8ccd4',   // clipboard / glasses glint
  q: '#9098a8',   // smoke gray
};

// ---------------------------------------------------------------------------
// MR. GRUBB - the boss. Bald on top, gray sides, jowls, three-pack-a-day
// cigar, a tie he bought in 1962 and a temper he bought with it.
// ---------------------------------------------------------------------------

const GRUBB_BASE: Grid = [
  '........................',
  '.......kkkkkkkkk........',
  '.....kkssssssssskk......',
  '....ksssssssssssssk.....',
  '...ksssssssssssssssk....',
  '..khsssssssssssssssk....',
  '..khssssssssssssssshk...',
  '..khssssssssssssssshk...',
  '..kssssssssssssssssk....',
  '..kssssssssssssssssk....',
  '..ksssssSnnSssssssk.....',
  '..kSsssssnnssssssSk.....',
  '..kSssssssssssssSSk.....',
  '..ksssssssssssssssk.....',
  '..kssssssssssssssk......',
  '...kSSssssssssSSk.......',
  '....kssssssssssk........',
  '...kkgggggggggggkk......',
  '..kggggwwwwwwggggGk.....',
  '.kgggggwwrrwwgggggGk....',
  '.kgggggwwrrwwgggggGk....',
  'kggggggswrrwsggggggGk...',
  'kgggggggwrrwgggggggGk...',
  'kgggggggggggggggggggk...',
];

// Patches are authored as (row, string, start-column) lines over the base.
interface PatchLine { r: number; s: string; c0?: number }
type Patch = PatchLine[];

const GRUBB_EYES_P: Record<string, Patch> = {
  neutral: [
    { r: 7, s: 'kkkk...kkkk', c0: 5 },
    { r: 8, s: 'wewk...kwew', c0: 5 },
  ],
  happy: [
    { r: 7, s: 'kkkk...kkkk', c0: 5 },
    { r: 8, s: 'kek.....kek', c0: 5 },
  ],
  angry: [
    { r: 6, s: 'kk.......kk', c0: 5 },
    { r: 7, s: '.kkk...kkk.', c0: 5 },
    { r: 8, s: 'wewk...kwew', c0: 5 },
  ],
  furious: [
    { r: 6, s: 'kk.......kk', c0: 5 },
    { r: 7, s: '.kkk...kkk.', c0: 5 },
    { r: 8, s: 'eek.....kee', c0: 5 },
    { r: 12, s: 'p..........p', c0: 4 },
  ],
  panic: [
    { r: 7, s: 'kkkk...kkkk', c0: 5 },
    { r: 8, s: 'wwew...weww', c0: 5 },
    { r: 9, s: 'kwwk...kwwk', c0: 5 },
  ],
};

const GRUBB_BLINK: Patch = [
  { r: 7, s: 'kkkk...kkkk', c0: 5 },
  { r: 8, s: 'kkkk...kkkk', c0: 5 },
];

/** Mouth patches on rows 13-14; cigar rides the right corner. */
const GRUBB_MOUTH_P: Record<string, { closed: Patch; open: Patch }> = {
  neutral: {
    closed: [
      { r: 13, s: 'kkkkkk', c0: 6 },
      { r: 13, s: 'bbbbo', c0: 13 },
      { r: 12, s: 'q', c0: 18 },
    ],
    open: [
      { r: 13, s: 'kmmmmk', c0: 6 },
      { r: 14, s: 'kttk', c0: 7 },
      { r: 13, s: 'bbbbo', c0: 13 },
      { r: 12, s: 'q', c0: 18 },
    ],
  },
  happy: {
    closed: [
      { r: 12, s: 'k....k', c0: 6 },
      { r: 13, s: 'kkkkkk', c0: 6 },
      { r: 13, s: 'bbbbo', c0: 13 },
    ],
    open: [
      { r: 12, s: 'k....k', c0: 6 },
      { r: 13, s: 'kttttk', c0: 6 },
      { r: 14, s: 'kmmk', c0: 7 },
      { r: 13, s: 'bbbbo', c0: 13 },
    ],
  },
  angry: {
    closed: [
      { r: 13, s: 'kkkkkkk', c0: 6 },
      { r: 14, s: 'k.....k', c0: 6 },
      { r: 13, s: 'bbbo', c0: 14 },
    ],
    open: [
      { r: 13, s: 'kmmmmmk', c0: 6 },
      { r: 14, s: 'ktmmtk', c0: 7 },
      { r: 13, s: 'bbbo', c0: 14 },
    ],
  },
  furious: {
    closed: [
      { r: 12, s: 'kk', c0: 6 },
      { r: 13, s: 'kmmmmmmk', c0: 6 },
      { r: 14, s: 'ktttttk', c0: 7 },
      { r: 13, s: 'bo', c0: 16 },
    ],
    open: [
      { r: 12, s: 'kmmk', c0: 6 },
      { r: 13, s: 'kmmmmmmk', c0: 6 },
      { r: 14, s: 'kttmmttk', c0: 6 },
      { r: 13, s: 'bo', c0: 16 },
    ],
  },
  panic: {
    closed: [
      { r: 13, s: 'kmmk', c0: 8 },
      { r: 14, s: 'kk', c0: 9 },
    ],
    open: [
      { r: 12, s: 'kmmmk', c0: 8 },
      { r: 13, s: 'kmmmk', c0: 8 },
      { r: 14, s: 'kkk', c0: 9 },
    ],
  },
};

// ---------------------------------------------------------------------------
// INSPECTOR PRUITT - NRC. Hard hat, glasses, clipboard, seen everything,
// impressed by none of it.
// ---------------------------------------------------------------------------

const PRUITT_BASE: Grid = [
  '........................',
  '......kkkkkkkkkkk.......',
  '.....kyyyyyyyyyyyk......',
  '....kyyyyyyyyyyyyyk.....',
  '...kyYyyyyyyyyyyYyk.....',
  '...kyyyyyyyyyyyyyyk.....',
  '...kkkkkkkkkkkkkkkk.....',
  '....kssssssssssssk......',
  '....kssssssssssssk......',
  '....kssssssssssssk......',
  '....kssssSnSsssssk......',
  '....ksssssnssssssk......',
  '....kssssssssssssk......',
  '....ksssssssssssk.......',
  '....kSsssssssssSk.......',
  '.....kssssssssskk.......',
  '.....kksssssssk.........',
  '....kkgggggggggkk.......',
  '...kgggwwwwwwwgggk......',
  '..kggggwwwwwwwggggk.....',
  '..kgggggwwwwwgggggkcc...',
  '.kggggggwwwwwggggggkcc..',
  '.kggggggwwwwwggggggkcc..',
  'kgggggggwwwwwgggggggkc..',
];

const PRUITT_EYES_P: Record<string, Patch> = {
  neutral: [
    { r: 9, s: 'kkkkk.kkkkk', c0: 6 },
    { r: 10, s: 'kwewk.kwewk', c0: 6 },
    { r: 11, s: 'kkkkk.kkkkk', c0: 6 },
  ],
  unimpressed: [
    { r: 9, s: 'kkkkk.kkkkk', c0: 6 },
    { r: 10, s: 'kkewk.kkewk', c0: 6 },
    { r: 11, s: 'kkkkk.kkkkk', c0: 6 },
  ],
  alarmed: [
    { r: 8, s: 'kk....kk', c0: 7 },
    { r: 9, s: 'kkkkk.kkkkk', c0: 6 },
    { r: 10, s: 'kwwek.kwewk', c0: 6 },
    { r: 11, s: 'kkkkk.kkkkk', c0: 6 },
  ],
};

const PRUITT_BLINK: Patch = [
  { r: 10, s: 'kkkkk.kkkkk', c0: 6 },
];

const PRUITT_MOUTH_P: Record<string, { closed: Patch; open: Patch }> = {
  neutral: {
    closed: [{ r: 13, s: 'kkkkk', c0: 8 }],
    open: [
      { r: 13, s: 'kmmmk', c0: 8 },
      { r: 14, s: 'kkk', c0: 9 },
    ],
  },
  unimpressed: {
    closed: [{ r: 13, s: 'kkkkkk', c0: 7 }],
    open: [
      { r: 13, s: 'kmmmmk', c0: 7 },
      { r: 14, s: 'kkkk', c0: 8 },
    ],
  },
  alarmed: {
    closed: [{ r: 13, s: 'kmk', c0: 9 }],
    open: [
      { r: 12, s: 'kmmk', c0: 9 },
      { r: 13, s: 'kmmk', c0: 9 },
      { r: 14, s: 'kk', c0: 10 },
    ],
  },
};

// ---------------------------------------------------------------------------

interface CharacterArt {
  base: Grid;
  eyes: Record<string, Patch>;
  mouths: Record<string, { closed: Patch; open: Patch }>;
  blink: Patch;
  fallbackMood: string;
  displayName: string;
  nameColor: string;
}

const CHARACTERS: Record<string, CharacterArt> = {
  grubb: {
    base: GRUBB_BASE,
    eyes: GRUBB_EYES_P,
    mouths: GRUBB_MOUTH_P,
    blink: GRUBB_BLINK,
    fallbackMood: 'neutral',
    displayName: 'MR. GRUBB',
    nameColor: '#f0c040',
  },
  inspector: {
    base: PRUITT_BASE,
    eyes: PRUITT_EYES_P,
    mouths: PRUITT_MOUTH_P,
    blink: PRUITT_BLINK,
    fallbackMood: 'neutral',
    displayName: 'INSPECTOR PRUITT',
    nameColor: '#80c0f0',
  },
};

export function characterDisplayName(who: string): { name: string; color: string } {
  const art = CHARACTERS[who];
  if (!art) return { name: who.toUpperCase(), color: '#c0c0c0' };
  return { name: art.displayName, color: art.nameColor };
}

function drawGrid(ctx: CanvasRenderingContext2D, grid: Grid): void {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === '.' || ch === ' ') continue;
      const color = PALETTE[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(c, r, 1, 1);
    }
  }
}

function drawPatch(ctx: CanvasRenderingContext2D, patch: Patch): void {
  for (const line of patch) {
    const c0 = line.c0 ?? 0;
    for (let i = 0; i < line.s.length; i++) {
      const ch = line.s[i];
      if (ch === '.' || ch === ' ') continue;
      const color = PALETTE[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(c0 + i, line.r, 1, 1);
    }
  }
}

/**
 * Render a character portrait into a canvas 2D context.
 * The context is assumed scaled so 1 unit = 1 sprite pixel.
 */
export function renderPortrait(
  ctx: CanvasRenderingContext2D,
  who: string,
  mood: string,
  opts: { talking: boolean; talkFrame: boolean; blinking: boolean }
): void {
  const art = CHARACTERS[who] ?? CHARACTERS.grubb;
  const moodKey = art.eyes[mood] ? mood : art.fallbackMood;

  ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  drawGrid(ctx, art.base);
  drawPatch(ctx, art.eyes[moodKey]);
  if (opts.blinking) drawPatch(ctx, art.blink);
  const mouth = art.mouths[moodKey] ?? art.mouths[art.fallbackMood];
  drawPatch(ctx, opts.talking && opts.talkFrame ? mouth.open : mouth.closed);
}
