/**
 * Flood debris: the junk a rising body of water picks up and carries, and
 * leaves lying where the water left it.
 *
 * This is DECORATION. Nothing here touches the simulation, and nothing in the
 * simulation reads it - a tsunami is modelled as a water body's surface (see
 * operators/surface-water.ts) and the surface is the only input this needs.
 * It is kept in its own file so the grid view calls one function.
 *
 * The behaviour is the one rule that makes a wave read as a wave:
 *
 *   - a field of debris is created the first time a body stands more than
 *     half a metre above its own declared surface, seeded along the water's
 *     edge (a wave picks up what is on the beach, not what is out at sea);
 *   - a floating piece rides at its own draught, so while the water rises it
 *     climbs the slope to stay in water that deep, each piece at its own
 *     speed - the slow ones fall behind the front;
 *   - when the water goes back down, nothing follows it. A piece grounds
 *     where it happened to be and STAYS there, which is why the hillside is
 *     left littered above the old shoreline.
 *
 * State is per water body and lives for the session; it is thrown away and
 * re-seeded whenever simulated time moves backwards (a rewind, a restart, a
 * new level), which is the only way a run can start over.
 */

export interface Point2 { x: number; y: number }

export interface DebrisScene {
  /** Terrain water body this field belongs to. */
  bodyId: string;
  /** The body's declared (no-wave) surface, m. */
  baseline: number;
  /** Its surface right now, m. */
  surface: number;
  /** Simulated time, s. */
  simTime: number;
  /** Ground height at a world point, m. */
  heightAt: (p: Point2) => number;
  /** Cell centres this body's water covers right now (computed once, lazily). */
  wetCells: () => Point2[];
  /** World -> screen. */
  toScreen: (p: Point2) => Point2;
  /** Screen pixels per world metre. */
  ppm: number;
}

type DebrisKind = 'log' | 'drum' | 'boat' | 'crate' | 'wreck';

interface DebrisPiece {
  x: number;
  y: number;
  kind: DebrisKind;
  /** Metres of water this piece needs under it to float. */
  draught: number;
  /** How fast it is carried, m/s of simulated time. */
  speed: number;
  /** Plan angle, radians. */
  angle: number;
  /** Long dimension, m. */
  size: number;
  /** Grounded: it does not move again. */
  stranded: boolean;
}

interface DebrisField {
  pieces: DebrisPiece[];
  lastTime: number;
}

/** How much water above its own level counts as a wave running. */
const WAVE_TRIGGER = 0.5;
/** Pieces per field. */
const COUNT = 44;

const fields = new Map<string, DebrisField>();

/**
 * A piece of plant the wave took (see simulation/wave-casualties.ts): a wreck
 * dropped into the body's field at the spot the component stood, to float
 * off and strand with the rest. The field is created empty if the view has
 * not seeded one yet (the perspective view never draws terrain); the next
 * render seeds the ordinary debris around it.
 */
export function addWreck(bodyId: string, p: Point2, simTime: number, size = 3): void {
  let field = fields.get(bodyId);
  if (!field) {
    field = { pieces: [], lastTime: simTime };
    fields.set(bodyId, field);
  }
  const i = field.pieces.length + 101;
  field.pieces.push({
    x: p.x, y: p.y, kind: 'wreck',
    draught: 0.4 + rand(i, 5) * 0.4,
    speed: 0.3 + rand(i, 6) * 0.6,
    angle: rand(i, 7) * Math.PI * 2,
    size,
    stranded: false,
  });
}

/** Deterministic [0,1) from two integers - the same field every run. */
function rand(i: number, salt: number): number {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(salt | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const KINDS: DebrisKind[] = ['log', 'log', 'log', 'drum', 'drum', 'crate', 'crate', 'boat'];

function seedField(scene: DebrisScene): DebrisField {
  const wet = scene.wetCells();
  const pieces: DebrisPiece[] = [];
  if (wet.length > 0) {
    // Prefer the shallow edge of the water: the beach is where the loose
    // stuff is. Cells are ranked by depth and the shallowest half is used.
    const ranked = wet
      .map(p => ({ p, depth: scene.surface - scene.heightAt(p) }))
      .filter(c => c.depth > 0)
      .sort((a, b) => a.depth - b.depth);
    const pool = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2)));
    for (let i = 0; i < COUNT; i++) {
      const cell = pool[Math.floor(rand(i, 1) * pool.length) % pool.length];
      const kind = KINDS[Math.floor(rand(i, 2) * KINDS.length) % KINDS.length];
      pieces.push({
        // Scatter inside the cell so the field does not read as a grid
        x: cell.p.x + (rand(i, 3) - 0.5) * 9,
        y: cell.p.y + (rand(i, 4) - 0.5) * 9,
        kind,
        draught: kind === 'boat' ? 0.6 + rand(i, 5) * 0.8 : 0.15 + rand(i, 5) * 0.7,
        speed: 0.15 + rand(i, 6) * 1.6,
        angle: rand(i, 7) * Math.PI * 2,
        size: kind === 'boat' ? 6 + rand(i, 8) * 3
          : kind === 'log' ? 3.5 + rand(i, 8) * 3
          : kind === 'drum' ? 1.2 : 1.8 + rand(i, 8) * 1.2,
        stranded: false,
      });
    }
  }
  return { pieces, lastTime: scene.simTime };
}

/** Uphill unit vector of the ground at a point, and the slope along it. */
function uphill(scene: DebrisScene, p: Point2): { ux: number; uy: number; slope: number } {
  const d = 2; // m - one finite-difference step, well inside a terrain cell
  const gx = (scene.heightAt({ x: p.x + d, y: p.y }) - scene.heightAt({ x: p.x - d, y: p.y })) / (2 * d);
  const gy = (scene.heightAt({ x: p.x, y: p.y + d }) - scene.heightAt({ x: p.x, y: p.y - d })) / (2 * d);
  const mag = Math.hypot(gx, gy);
  if (!(mag > 1e-6)) return { ux: 0, uy: 0, slope: 0 };
  return { ux: gx / mag, uy: gy / mag, slope: mag };
}

/**
 * Carry the field for `dt` seconds of simulated time. A floating piece climbs
 * towards water of its own draught; a piece with no water under it any more
 * is aground for good.
 */
function advance(scene: DebrisScene, field: DebrisField, dt: number): void {
  if (!(dt > 0)) return;
  for (const piece of field.pieces) {
    if (piece.stranded) continue;
    const depth = scene.surface - scene.heightAt(piece);
    if (depth <= 0) { piece.stranded = true; continue; }
    const excess = depth - piece.draught;
    if (excess <= 0) continue;              // already as shallow as it floats
    const { ux, uy, slope } = uphill(scene, piece);
    if (slope <= 0) continue;               // flat water, nothing to climb
    const want = excess / slope;            // metres uphill to shed that depth
    const step = Math.min(want, piece.speed * dt);
    piece.x += ux * step;
    piece.y += uy * step;
    piece.angle += (rand(Math.round(piece.x), Math.round(piece.y)) - 0.5) * 0.4 * dt;
  }
}

function drawPiece(ctx: CanvasRenderingContext2D, piece: DebrisPiece, scene: DebrisScene): void {
  const s = scene.toScreen(piece);
  const L = Math.max(3, piece.size * scene.ppm);
  const afloat = !piece.stranded;
  // A floating piece rocks; a stranded one lies still and dries out.
  const bob = afloat ? Math.sin(scene.simTime * 0.9 + piece.angle * 3) * 0.12 : 0;
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(piece.angle + bob);
  ctx.lineWidth = Math.max(0.5, L * 0.06);
  switch (piece.kind) {
    case 'log': {
      const w = Math.max(2, L * 0.22);
      ctx.fillStyle = afloat ? '#6b4a2a' : '#5a3f24';
      ctx.strokeStyle = 'rgba(30, 20, 10, 0.8)';
      ctx.beginPath();
      ctx.roundRect(-L / 2, -w / 2, L, w, w / 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'drum': {
      const w = Math.max(2, L * 0.7);
      ctx.fillStyle = afloat ? '#3d7ea6' : '#356b8c';
      ctx.strokeStyle = 'rgba(15, 30, 40, 0.8)';
      ctx.beginPath();
      ctx.roundRect(-L / 2, -w / 2, L, w, Math.min(L, w) * 0.35);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -w / 2); ctx.lineTo(0, w / 2);
      ctx.stroke();
      break;
    }
    case 'crate': {
      const w = Math.max(2, L * 0.8);
      ctx.fillStyle = afloat ? '#8a7042' : '#75603a';
      ctx.strokeStyle = 'rgba(35, 25, 10, 0.8)';
      ctx.fillRect(-L / 2, -w / 2, L, w);
      ctx.strokeRect(-L / 2, -w / 2, L, w);
      break;
    }
    case 'wreck': {
      // A machine on its side: a grey block with its motor stub, a hazard
      // stripe, and the pipe stubs that came away with it
      const w = Math.max(3, L * 0.6);
      ctx.fillStyle = afloat ? '#6d7480' : '#5a606a';
      ctx.strokeStyle = 'rgba(20, 22, 28, 0.85)';
      ctx.fillRect(-L / 2, -w / 2, L, w);
      ctx.strokeRect(-L / 2, -w / 2, L, w);
      ctx.fillStyle = afloat ? '#c9a227' : '#a5851f';
      ctx.fillRect(-L / 2, -w / 2, L * 0.18, w);
      ctx.fillStyle = afloat ? '#4a5160' : '#3d434f';
      ctx.fillRect(L * 0.1, -w * 0.9, L * 0.3, w * 0.4);
      ctx.beginPath();
      ctx.moveTo(-L / 2, w * 0.2); ctx.lineTo(-L * 0.75, w * 0.35);
      ctx.moveTo(L / 2, -w * 0.1); ctx.lineTo(L * 0.8, -w * 0.3);
      ctx.stroke();
      break;
    }
    case 'boat': {
      const w = Math.max(3, L * 0.34);
      ctx.fillStyle = afloat ? '#d8d2c4' : '#b9b2a2';
      ctx.strokeStyle = 'rgba(40, 40, 45, 0.85)';
      ctx.beginPath();
      ctx.moveTo(L / 2, 0);
      ctx.quadraticCurveTo(L * 0.1, -w / 2, -L / 2, -w * 0.35);
      ctx.lineTo(-L / 2, w * 0.35);
      ctx.quadraticCurveTo(L * 0.1, w / 2, L / 2, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // A stranded boat lies over on its side
      ctx.strokeStyle = 'rgba(40, 40, 45, 0.6)';
      ctx.beginPath();
      ctx.moveTo(-L * 0.2, afloat ? -w * 0.2 : 0);
      ctx.lineTo(L * 0.15, 0);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

/**
 * Draw (and carry) the debris on one water body. Call it per body, per frame,
 * after the water itself is painted. Does nothing until that body has risen
 * above its declared surface at least once.
 */
export function renderFloodDebris(ctx: CanvasRenderingContext2D, scene: DebrisScene): void {
  let field = fields.get(scene.bodyId);
  // Simulated time running backwards means a different run: start over.
  if (field && scene.simTime < field.lastTime) {
    fields.delete(scene.bodyId);
    field = undefined;
  }
  if (!field) {
    if (!(scene.surface > scene.baseline + WAVE_TRIGGER)) return;
    field = seedField(scene);
    fields.set(scene.bodyId, field);
  }
  advance(scene, field, scene.simTime - field.lastTime);
  field.lastTime = scene.simTime;
  if (field.pieces.length === 0) return;

  ctx.save();
  for (const piece of field.pieces) drawPiece(ctx, piece, scene);
  ctx.restore();
}
