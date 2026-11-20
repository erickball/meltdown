/**
 * Pressure-wall sizing: how thick a component's wall is, given what it is
 * rated for. One function for the factory (wall thermal nodes, tube bores,
 * burst pressures), the construction dialogs, the cost estimate and the
 * renderer, so the wall a player is shown is the wall that heats, weighs and
 * bursts.
 *
 * A rating is a DESIGN pressure, the way the codes use the word. Which code
 * sizes the wall follows the component's "nuclear quality assurance" box:
 *
 *   NQA-1  -> ASME Section III, Division 1, Class 1
 *             S = S_m = min(S_u/3, 2 S_y/3), every weld volumetrically
 *             examined (E = 1)
 *     shell on its inside radius   t = P R / (S_m - 0.5 P)      NB-3324.1
 *     pipe/tube on its outside     t = P D_o / 2(S_m + 0.4 P)   NB-3641.1
 *
 *   other  -> ASME Section VIII, Division 1
 *             S = min(S_u/3.5, 2 S_y/3); welded shells spot-radiographed
 *             (E = 0.85), seamless pipe/tube and cast bodies E = 1
 *     shell on its inside radius   t = P R / (S E - 0.6 P)      UG-27(c)(1)
 *     on its outside radius        t = P R_o / (S E + 0.4 P)    App. 1-1
 *
 * Section VIII walls come out a little THICKER than Section III ones for the
 * same material and pressure. That is real: Section III buys its lower
 * margin with design-by-analysis, full examination and QA.
 *
 * The wall then bursts where its hoop stress reaches the material's ultimate
 * strength (factory.ts initializeBurstStates): ~3x design for Section III,
 * ~4x for Section VIII.
 *
 * Allowables are room-temperature values. Design temperature is not a
 * component property, so the code's derating with temperature (and, in the
 * creep range, its switch to rupture-governed allowables) is not applied -
 * creep itself is modelled directly instead (materials.ts).
 */

import { MATERIALS, StructuralMaterial, resolveMaterial } from './materials';
import {
  buildingPlatePrice, REBAR_PRICE, REBAR_PLACING, CONCRETE_WALL_COST, FRAME_STEEL_PRICE,
  FRAME_MEMBER_COST, STEEL_DENSITY,
} from '../construction/cost-rates';

export type DesignCode = 'section-iii' | 'section-viii';

/** The code a component is designed to: NQA-1 means Section III. */
export function designCodeFor(nqa1: boolean | undefined): DesignCode {
  return nqa1 ? 'section-iii' : 'section-viii';
}

/** Allowable design stress (Pa) for a material under a design code. */
export function designStress(material: StructuralMaterial, code: DesignCode): number {
  const m = MATERIALS[material];
  const ultimateDivisor = code === 'section-iii' ? 3 : 3.5;
  return Math.min(m.ultimateMPa / ultimateDivisor, (2 / 3) * m.yieldMPa) * 1e6;
}

/**
 * How the wall is made: a WELDED plate shell (vessels, tanks, HX shells) or a
 * SEAMLESS one (pipe, tube, cast valve and pump bodies). Only matters for the
 * Section VIII joint efficiency.
 */
export type WallForm = 'welded' | 'seamless';

export function jointEfficiency(code: DesignCode, form: WallForm): number {
  if (code === 'section-iii') return 1;
  return form === 'welded' ? 0.85 : 1;
}

/**
 * Minimum wall for a shell of this diameter (m), whatever it holds: the
 * thickness that survives being fabricated, lifted and supported. A smooth
 * fit through practice rather than a code rule (Section VIII's UG-16 floor
 * of 1.5 mm is size-independent and far too thin for a large vessel):
 *
 *   t_min = 7 mm * sqrt(D / 1 m)
 *
 *   19 mm tube ~1.0 mm (commercial SG tubing runs 1.0-1.2 mm),
 *   0.4 m pump body ~4.4 mm, 2 m shell ~10 mm (TEMA's minimum for exchanger
 *   shells of that size is 8-13 mm), 20 m tank ~31 mm - heavier than an
 *   API 650 atmospheric tank (6-10 mm on stiffening rings) but still able to
 *   take full vacuum, which an unstiffened shell this model can describe
 *   needs. Grows with sqrt(D) because a wall's own stiffness against
 *   denting and ovalisation scales with t/D while the loads that dent it do
 *   not grow as fast as D.
 */
export function minimumWallThickness(diameter: number): number {
  return 0.007 * Math.sqrt(diameter);
}

export interface WallSpec {
  /** Design pressure, bar (gauge). */
  pressureBar: number;
  /** The diameter the rating is applied on, m. */
  diameter: number;
  /** Whether `diameter` is the bore (shells, valve/pump bodies) or the
   *  outside (tubes and pipe specified by OD). */
  measuredOn: 'inner' | 'outer';
  material?: string;
  nqa1?: boolean;
  form: WallForm;
  /** For error messages. */
  label?: string;
}

/**
 * Wall thickness (m): the code's pressure thickness, or the handling
 * minimum where that is thicker (an atmospheric tank is not paper).
 *
 * Throws when the design pressure cannot be carried by any thickness of this
 * material under this code - the inside-radius formulas run out of
 * denominator at P = S_m/0.5 (III) or SE/0.6 (VIII), around 2000-4000 bar
 * for steels. A thick-wall (Lame) design is what such a vessel would need.
 */
export function designWallThickness(spec: WallSpec): number {
  const material = resolveMaterial(spec.material);
  const code = designCodeFor(spec.nqa1);
  const S = designStress(material, code);
  const E = jointEfficiency(code, spec.form);
  const P = spec.pressureBar * 1e5;
  const D = spec.diameter;
  let t: number;
  if (spec.measuredOn === 'outer') {
    t = code === 'section-iii'
      ? P * D / (2 * (S + 0.4 * P))
      : P * (D / 2) / (S * E + 0.4 * P);
  } else {
    const denom = code === 'section-iii' ? S - 0.5 * P : S * E - 0.6 * P;
    if (!(denom > 0)) {
      throw new Error(
        `[WallSizing] ${spec.label ?? 'component'}: ${spec.pressureBar} bar is beyond what a ` +
        `${MATERIALS[material].label} cylinder can be designed for under ` +
        `${code === 'section-iii' ? 'Section III' : 'Section VIII'} (allowable ` +
        `${(S / 1e6).toFixed(0)} MPa). Lower the rating.`);
    }
    t = P * (D / 2) / denom;
  }
  // The handling minimum is set on the outside diameter for both forms
  const outer = spec.measuredOn === 'outer' ? D : D + 2 * t;
  return Math.max(t, minimumWallThickness(outer));
}

/**
 * The highest design pressure (bar, gauge) the shell formulas above can be
 * trusted for with this material, code and wall form. They are thin-shell
 * formulas: the codes allow them only while the wall is no more than half
 * the inside radius - UG-27(c)(1) states it as t <= R/2 or P <= 0.385 SE.
 * Past that the hoop stress is no longer close to uniform through the wall
 * and a thick-wall (Lame) design is needed, which this model does not do.
 *
 * Setting t = R_i/2 in each formula:
 *   Section VIII, inside or outside radius   P = S E / 2.6
 *   Section III shell on its inside radius    P = S_m / 2.5
 *   Section III pipe/tube on its outside      P = S_m / 2.6
 *
 * Well below the point where the denominators run out (designWallThickness
 * only throws there), so a rating above this still sizes a wall - just not
 * one the code would accept.
 */
export function maxDesignPressureBar(spec: {
  material?: string; nqa1?: boolean; form: WallForm; measuredOn: 'inner' | 'outer';
}): number {
  const material = resolveMaterial(spec.material);
  const code = designCodeFor(spec.nqa1);
  const SE = designStress(material, code) * jointEfficiency(code, spec.form);
  const divisor = code === 'section-iii' && spec.measuredOn === 'inner' ? 2.5 : 2.6;
  return SE / divisor / 1e5;
}

/** The most any material/code combination allows for this kind of wall -
 *  the static ceiling a dialog field can offer before the per-material
 *  check (maxDesignPressureBar) applies. */
export function maxDesignPressureAnyMaterialBar(form: WallForm, measuredOn: 'inner' | 'outer'): number {
  let best = 0;
  for (const material of Object.keys(MATERIALS)) {
    for (const nqa1 of [true, false]) {
      best = Math.max(best, maxDesignPressureBar({ material, nqa1, form, measuredOn }));
    }
  }
  return best;
}

/*
 * ---------------------------------------------------------------------------
 * Containment / building walls
 * ---------------------------------------------------------------------------
 *
 * Concrete carries no tension: once a wall under internal pressure cracks,
 * every newton of the membrane and bending tension is carried by its steel
 * (ASME III Division 2 / ACI 359 cracked-section design). `steelFraction` is
 * the steel's share of the wall cross-section; the rest is concrete, which
 * adds mass, shielding and compression capacity but no strength against
 * pressure. A wall with no steel cannot be rated for any pressure at all.
 *
 * The steel comes in one of two forms:
 *
 *   plate  - welded steel plate (a free-standing steel containment, a liner
 *            counted structurally, steel-concrete composite faceplates).
 *            Plate is biaxial: one sheet carries hoop and meridional stress
 *            together. It is sized exactly as the pressure-vessel shells
 *            above, by the building's material and NQA-1 box (Section III
 *            vs VIII), on the steel thickness f*t. At f = 1 the building IS
 *            a big welded vessel with an open-air outside.
 *   rebar  - reinforcing bar (ASTM A615 Grade 60: f_y 414 MPa, f_u 620 MPa)
 *            in a reinforced concrete wall. Bars carry load only along their
 *            own axis, so the steel is split between the two directions in
 *            proportion to the demand (a cylinder's hoop needs twice its
 *            meridional). Division 2 limits rebar to 0.9 f_y under the
 *            factored load, and the factored load for pressure is 1.5 P_a
 *            (CC-3422, CC-3230): 0.6 f_y = 248 MPa at the design pressure.
 *            The membrane force is exact equilibrium (N = P R_i), with no
 *            thick-wall correction - there is no solid wall to have a
 *            through-thickness stress gradient.
 *
 * Geometry: a cylinder is a shell with a hemispherical dome (a flat roof
 * cannot carry pressure in membrane action; real cylindrical containments
 * all have domes; the simulated free volume does not count the dome's).
 * A rectangular building is a steel frame with flat panels spanning
 * between its members, each panel fixed at its edges and carrying the
 * pressure in two-way plate bending (Roark, Table 11.4 case 8, all edges
 * fixed, max moment at the middle of a long edge) plus the in-plane tension
 * it takes from the panels around it. The frame spacing is chosen as the
 * cheapest that carries the rating (see the frame notes further down).
 *
 * Validity: the same rule as the vessels - a curved wall at most half its
 * inside radius - and for flat panels the plate formulas' own range, a
 * thickness at most a quarter of the panel's shorter side (Roark).
 *
 * No minimum thickness: the wall is what the pressure needs.
 */

export type BuildingSteelForm = 'plate' | 'rebar';

/** ASTM A615 Grade 60 reinforcing bar. */
const REBAR_YIELD = 414e6;     // Pa
const REBAR_ULTIMATE = 620e6;  // Pa
/** Rebar stress at the DESIGN pressure: 0.9 f_y under 1.5x the pressure. */
const REBAR_DESIGN_STRESS = 0.9 * REBAR_YIELD / 1.5;

export interface BuildingSpec {
  shape?: string;            // 'cylinder' (default) | 'rectangle'
  diameter?: number;         // m, cylinder
  width?: number;            // m, rectangle
  length?: number;           // m, rectangle
  height: number;            // m
  steelFraction: number;     // 0-1 share of the wall cross-section that is steel
  steelForm?: BuildingSteelForm;
  material?: string;         // plate only
  nqa1?: boolean;            // plate only: Section III vs VIII
  label?: string;
}

/** The building fields a component carries, as a sizing spec. Pre-model
 *  saves have no steel form: they were concrete containments, so rebar. */
export function buildingSpecOf(b: any): BuildingSpec {
  return {
    shape: b.shape ?? b.buildingShape, diameter: b.diameter, width: b.width, length: b.length,
    height: b.height, steelFraction: b.steelFraction, steelForm: b.steelForm ?? 'rebar',
    material: b.material, nqa1: b.nqa1, label: b.label ?? b.name ?? b.id,
  };
}

interface SteelBasis { S: number; ultimate: number; c: number; plate: boolean }

/** The steel's stress at design (S, already times any joint efficiency),
 *  its ultimate, and the shell formula's thick-wall coefficient. */
function steelBasis(spec: BuildingSpec, atUltimate: boolean): SteelBasis {
  if ((spec.steelForm ?? 'rebar') === 'rebar') {
    const S = atUltimate ? REBAR_ULTIMATE : REBAR_DESIGN_STRESS;
    return { S, ultimate: REBAR_ULTIMATE, c: 0, plate: false };
  }
  const material = resolveMaterial(spec.material);
  const code = designCodeFor(spec.nqa1);
  const E = jointEfficiency(code, 'welded');
  const ultimate = MATERIALS[material].ultimateMPa * 1e6;
  return {
    S: atUltimate ? ultimate * E : designStress(material, code) * E,
    ultimate, plate: true,
    // UG-27 0.6P / NB-3324.1 0.5P - none at ultimate (Barlow on the bore)
    c: atUltimate ? 0 : (code === 'section-iii' ? 0.5 : 0.6),
  };
}

function checkSteel(spec: BuildingSpec): number {
  const f = spec.steelFraction;
  if (!(f > 0 && f <= 1)) {
    throw new Error(
      `[WallSizing] building '${spec.label ?? '?'}': steel fraction ${f} - concrete carries no ` +
      `tension, so a pressure-rated wall needs some steel (0 < fraction <= 1).`);
  }
  return f;
}

/** Fixed-edge rectangular plate under uniform pressure q, short side b,
 *  long side a: Roark's max stress sigma = beta1 q b^2 / t^2 at the middle
 *  of a long edge, i.e. a moment per unit length M = beta1 q b^2 / 6. */
const ROARK_FIXED: Array<[number, number]> = [
  [1.0, 0.3078], [1.2, 0.3834], [1.4, 0.4356], [1.6, 0.4680], [1.8, 0.4872], [2.0, 0.4974], [Infinity, 0.5],
];
function roarkBeta1(aOverB: number): number {
  for (let i = 1; i < ROARK_FIXED.length; i++) {
    const [r1, b1] = ROARK_FIXED[i];
    if (aOverB <= r1) {
      const [r0, b0] = ROARK_FIXED[i - 1];
      if (!Number.isFinite(r1)) {
        // 2 -> infinity: approach 0.5 as 1 - b/a vanishes
        return b0 + (b1 - b0) * (1 - 2 / aOverB);
      }
      return b0 + (b1 - b0) * (aOverB - r0) / (r1 - r0);
    }
  }
  return 0.5;
}

interface Panel { b: number; a: number; N: number }

/** Panel thickness (m) for pressure P (Pa) on the steel basis given:
 *  N/(phiN S t) + M/(k S t^2) = 1 with the steel in two face layers. */
function panelThickness(panel: Panel, P: number, f: number, basis: SteelBasis): number {
  // Rebar runs both ways: half the steel per direction
  const phi = basis.plate ? f : f / 2;
  const k = (phi / 2) * (1 - phi / 2);  // = 1/4 for solid plate: S t^2/4 = 1.5 S t^2/6
  const M = roarkBeta1(panel.a / panel.b) * P * panel.b * panel.b / 6;
  const a = panel.N / (phi * basis.S);
  const c = M / (k * basis.S);
  return (a + Math.sqrt(a * a + 4 * c)) / 2;
}

/*
 * Rectangular buildings are framed. Flat walls carry pressure in bending,
 * and a panel's bending moment grows with the square of its span, so a
 * real one is a frame of steel members with the wall panels spanning
 * between them: vertical columns along every wall (fixed at the basemat and
 * at the roof) and roof beams across the roof's shorter dimension, landing
 * on the columns of the two long walls. One bay spacing runs through all of
 * it (roof beams sit on columns).
 *
 * The spacing is not a design input: it is whatever carries the rating at
 * the lowest cost. The panels get thinner as the bays shrink, while the
 * frame's tonnage barely changes (each member carries its tributary width,
 * and there are proportionally more of them) - what stops the bays from
 * shrinking forever is the cost of each member's lift and end connections
 * (cost-rates.ts FRAME_MEMBER_COST). An unframed box (one bay per wall) is
 * one of the candidates, so a building that needs no frame gets none.
 *
 * Members are I-sections, fixed at both ends under their tributary
 * pressure (M = w l^2/12, V = w l/2), at a depth of 1/20 of their span (the
 * usual deflection-governed proportion for steel beams): two flanges for
 * the moment, a web for the shear (von Mises, S/sqrt 3), plus area for the
 * axial pull a column takes from the roof beams it holds down. Frame steel
 * is the building's own plate steel in a plate building (stiffeners welded
 * to the shell) and A992 structural steel (F_y 345, F_u 450 MPa, AISC ASD
 * 0.6 F_y) in a reinforced concrete one.
 */
const A992_ALLOWABLE = 0.6 * 345e6;
const A992_ULTIMATE = 450e6;
const FRAME_SPAN_TO_DEPTH = 20;
/** The most bays the spacing search tries along the long wall. */
const MAX_BAYS = 1000;

function frameStress(spec: BuildingSpec): { S: number; ultimate: number } {
  if ((spec.steelForm ?? 'rebar') === 'rebar') return { S: A992_ALLOWABLE, ultimate: A992_ULTIMATE };
  const material = resolveMaterial(spec.material);
  return { S: designStress(material, designCodeFor(spec.nqa1)), ultimate: MATERIALS[material].ultimateMPa * 1e6 };
}

/** Cross-section area (m2) of a fixed-ended frame member of this span
 *  carrying w N/m of pressure load and an axial pull N (N). */
function memberArea(span: number, w: number, N: number, S: number): number {
  const M = w * span * span / 12;
  const V = w * span / 2;
  const d = span / FRAME_SPAN_TO_DEPTH;
  return 2 * M / (S * d) + Math.sqrt(3) * V / S + N / S;
}

interface RectLayout {
  W: number; L: number; H: number;
  /** Roof beams span the roof's short side Wr, spaced along its long side Lr */
  Wr: number; Lr: number;
}
function rectLayout(spec: BuildingSpec): RectLayout {
  const W = spec.width ?? 40, L = spec.length ?? 40;
  return { W, L, H: spec.height, Wr: Math.min(W, L), Lr: Math.max(W, L) };
}

/** Bays on a wall of this length at the target spacing (ceil so no bay is
 *  wider than the target), and the bay width that results. */
function bays(length: number, spacing: number): { n: number; bay: number } {
  const n = Math.max(1, Math.ceil(length / spacing - 1e-9));
  return { n, bay: length / n };
}

interface RectDesign {
  wall: number; roof: number;
  wallArea: number; roofArea: number;
  panelVolume: number;
  frameVolume: number;   // m3 of frame steel
  members: number;
  spacing: number;       // bay spacing along the long wall (= its length: unframed)
  valid: boolean;        // every panel within the plate formulas' range
  panels: Array<{ panel: Panel; isRoof: boolean }>;
}

/** The framed design at pressure P (Pa) with this bay spacing (m). */
function rectDesign(spec: BuildingSpec, P: number, spacing: number, f: number, basis: SteelBasis,
                    frameS: number): RectDesign {
  const g = rectLayout(spec);
  const panels: RectDesign['panels'] = [];
  let wall = 0, frameVolume = 0, members = 0, valid = true;
  // The roof's uplift on the wall tops, per metre of wall
  const vertical = P * g.W * g.L / (2 * (g.W + g.L));
  // Two walls of each length; the end walls pull on the long walls and back
  for (const [length, other] of [[g.L, g.W], [g.W, g.L]] as const) {
    const { n, bay } = bays(length, spacing);
    const panel: Panel = { b: Math.min(bay, g.H), a: Math.max(bay, g.H), N: Math.max(P * other / 2, vertical) };
    const t = panelThickness(panel, P, f, basis);
    wall = Math.max(wall, t);
    valid = valid && t <= panel.b / 4;
    panels.push({ panel, isRoof: false });
    // Interior columns: tributary one bay; those on the long walls hold the
    // roof beams down (half a beam's load each)
    const columns = n - 1;
    if (columns > 0) {
      const pull = length === g.Lr ? P * bay * g.Wr / 2 : 0;
      frameVolume += 2 * columns * memberArea(g.H, P * bay, pull, frameS) * g.H;
      members += 2 * columns;
    }
  }
  // Roof: beams across Wr at the long wall's bay spacing
  const { n: nr, bay: bayR } = bays(g.Lr, spacing);
  const roofPanel: Panel = { b: Math.min(bayR, g.Wr), a: Math.max(bayR, g.Wr), N: P * g.H / 2 };
  const roof = panelThickness(roofPanel, P, f, basis);
  valid = valid && roof <= roofPanel.b / 4;
  panels.push({ panel: roofPanel, isRoof: true });
  if (nr - 1 > 0) {
    frameVolume += (nr - 1) * memberArea(g.Wr, P * bayR, 0, frameS) * g.Wr;
    members += nr - 1;
  }
  // All walls are built to the thickest panel's need: one wall thickness
  // is what heats, is drawn and bursts
  const wallArea = 2 * (g.W + g.L) * g.H;
  const roofArea = g.W * g.L;
  return {
    wall, roof, wallArea, roofArea, panelVolume: wallArea * wall + roofArea * roof,
    frameVolume, members, spacing: bays(g.Lr, spacing).bay, valid, panels,
  };
}

/** Installed cost of a design's walls, roof and frame (no basemat,
 *  penetrations or QA factor - those do not depend on the spacing). */
function rectDesignCost(spec: BuildingSpec, d: RectDesign, f: number): number {
  const plate = (spec.steelForm ?? 'rebar') === 'plate';
  const platePrice = buildingPlatePrice(spec.material);
  const panelSteelPrice = plate ? platePrice : REBAR_PRICE + REBAR_PLACING;
  const frameSteelPrice = plate ? platePrice : FRAME_STEEL_PRICE;
  return f * d.panelVolume * STEEL_DENSITY * panelSteelPrice +
    (1 - f) * d.panelVolume * CONCRETE_WALL_COST +
    d.frameVolume * STEEL_DENSITY * frameSteelPrice +
    d.members * FRAME_MEMBER_COST;
}

/** The cheapest valid framed design at P (Pa), or null when no spacing
 *  keeps the panels within the plate formulas (that limit does not depend
 *  on the span: t/b is set by P/(fS) alone). Memoized - the renderer asks
 *  every frame. */
const rectCache = new Map<string, RectDesign | null>();
function bestRectDesign(spec: BuildingSpec, P: number, basis: SteelBasis, frameS: number): RectDesign | null {
  const f = spec.steelFraction;
  const key = [spec.width, spec.length, spec.height, f, spec.steelForm, spec.material, !!spec.nqa1,
    P, basis.S, frameS].join('|');
  const hit = rectCache.get(key);
  if (hit !== undefined) return hit;
  const Lr = rectLayout(spec).Lr;
  let best: RectDesign | null = null, bestCost = Infinity;
  for (let k = 1; k <= MAX_BAYS; k++) {
    const d = rectDesign(spec, P, Lr / k, f, basis, frameS);
    if (!d.valid) continue;
    const cost = rectDesignCost(spec, d, f);
    if (cost < bestCost) { bestCost = cost; best = d; }
  }
  if (rectCache.size > 2000) rectCache.clear();
  rectCache.set(key, best);
  return best;
}

export interface BuildingWalls {
  /** Side wall thickness (m) - the thickest wall panel of a rectangle. */
  wall: number;
  /** Dome (cylinder) or roof (rectangle) thickness, m. */
  roof: number;
  /** Surface areas (m2) the two thicknesses cover: dome = hemisphere. */
  wallArea: number;
  roofArea: number;
  steelVolume: number;     // m3 in the walls and roof (frame not included)
  concreteVolume: number;  // m3, walls and roof (basemat not included)
  /** Rectangular buildings: the frame the spacing search chose. */
  frame?: { spacing: number; members: number; steelVolume: number };
  /** The rating (Pa) these walls were sized for. */
  designPressure?: number;
}

function cylinderThicknesses(spec: BuildingSpec, P: number, basis: SteelBasis, f: number): { wall: number; roof: number } {
  const R = (spec.diameter ?? 40) / 2;
  if (basis.plate) {
    // The steel layer is a vessel shell; concrete adds bulk around it
    const shellDen = basis.S - basis.c * P;
    const domeDen = 2 * basis.S - (basis.c > 0 ? 0.2 : 0) * P;
    if (!(shellDen > 0)) {
      throw new Error(`[WallSizing] building '${spec.label ?? '?'}': ${P / 1e5} bar is beyond any plate thickness.`);
    }
    return { wall: P * R / shellDen / f, roof: P * R / domeDen / f };
  }
  // Rebar: hoop gets 2/3 of the steel, meridional 1/3 - both then need the
  // same wall. Dome: half each way.
  return { wall: P * R / ((2 / 3) * f * basis.S), roof: P * R / (f * basis.S) };
}

/** A building's walls at its design pressure (bar, gauge). */
export function buildingWalls(spec: BuildingSpec, pressureBar: number): BuildingWalls {
  const f = checkSteel(spec);
  const P = pressureBar * 1e5;
  const basis = steelBasis(spec, false);
  if (spec.shape === 'rectangle') {
    const d = bestRectDesign(spec, P, basis, frameStress(spec).S);
    if (!d) {
      throw new Error(
        `[WallSizing] building '${spec.label ?? '?'}': ${pressureBar} bar needs flat panels thicker than ` +
        `a quarter of their span, beyond the plate formulas - more steel, or a cylinder.`);
    }
    return {
      wall: d.wall, roof: d.roof, wallArea: d.wallArea, roofArea: d.roofArea,
      steelVolume: f * d.panelVolume, concreteVolume: (1 - f) * d.panelVolume,
      frame: { spacing: d.spacing, members: d.members, steelVolume: d.frameVolume },
      designPressure: P,
    };
  }
  const D = spec.diameter ?? 40;
  const { wall, roof } = cylinderThicknesses(spec, P, basis, f);
  const wallArea = Math.PI * D * spec.height;
  const roofArea = 2 * Math.PI * (D / 2) ** 2;
  const total = wallArea * wall + roofArea * roof;
  return { wall, roof, wallArea, roofArea, steelVolume: f * total, concreteVolume: (1 - f) * total, designPressure: P };
}

/** The highest rating (bar) the wall formulas hold for: a curved wall at
 *  most half its radius, a flat panel at most a quarter of its short span. */
export function maxBuildingDesignPressureBar(spec: BuildingSpec): number {
  if (!(spec.steelFraction > 0)) return 0;
  const f = Math.min(spec.steelFraction, 1);
  const basis = steelBasis(spec, false);
  if (spec.shape !== 'rectangle') {
    // Wall governs (the dome is thinner): t = R/2
    return (basis.plate ? f * basis.S / (2 + f * basis.c) : f * basis.S / 3) / 1e5;
  }
  // t/b grows monotonically with P and does not depend on the span, so the
  // unframed layout finds the same ceiling as any other: bisect on it
  const g = rectLayout(spec);
  const frameS = frameStress(spec).S;
  let lo = 0, hi = basis.S;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (rectDesign(spec, mid, g.Lr, f, basis, frameS).valid) lo = mid; else hi = mid;
  }
  return lo / 1e5;
}

/** Static ceiling for the rating field: solid plate, best material, cylinder. */
export function maxBuildingDesignPressureAnyBar(): number {
  let best = 0;
  for (const material of Object.keys(MATERIALS)) {
    for (const nqa1 of [true, false]) {
      best = Math.max(best, maxBuildingDesignPressureBar({
        height: 1, diameter: 1, steelFraction: 1, steelForm: 'plate', material, nqa1,
      }));
    }
  }
  return best;
}

/**
 * Burst pressure (Pa, gauge) of a building's walls as built: the steel at
 * its ultimate strength (times the drawn strength factor) carrying the
 * membrane tension (Barlow on a plate shell, exact equilibrium for rebar)
 * or the panel's plastic bending plus tension; for a framed rectangle also
 * its frame members, whose demand is linear in the pressure. The weakest.
 */
export function buildingBurstPressure(spec: BuildingSpec, walls: BuildingWalls, strengthFactor: number): number {
  const f = checkSteel(spec);
  const u = steelBasis(spec, true);
  const sigma = u.S * strengthFactor;
  if (spec.shape !== 'rectangle') {
    const R = (spec.diameter ?? 40) / 2;
    if (u.plate) {
      const ts = f * walls.wall, td = f * walls.roof;
      return Math.min(sigma * ts / (R + ts), 2 * sigma * td / (R + td));
    }
    return Math.min((2 / 3) * f * sigma * walls.wall / R, f * sigma * walls.roof / R);
  }
  const basis = { ...u, S: sigma };
  const fs = frameStress(spec);
  const spacing = walls.frame?.spacing ?? rectLayout(spec).Lr;
  // Panels as built (spans from the chosen spacing; the layout's panel
  // spans and tensions scale with P the same way at any pressure)
  const fails = (P: number) => rectDesign(spec, P, spacing, f, basis, fs.S).panels
    .some(({ panel, isRoof }) => panelThickness(panel, P, f, basis) > (isRoof ? walls.roof : walls.wall));
  let lo = 0, hi = sigma;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (fails(mid)) hi = mid; else lo = mid;
  }
  // Frame members were sized at the design stress for the rating; every
  // load on them is proportional to pressure
  if ((walls.frame?.members ?? 0) > 0 && walls.designPressure !== undefined) {
    lo = Math.min(lo, walls.designPressure * (fs.ultimate * strengthFactor) / fs.S);
  }
  return lo;
}

/**
 * The wall a component has (inner diameter and thickness, m), or null when
 * it is not described as a cylinder at all (turbine casings, condensers...).
 *
 * Explicit walls are honoured - a preset's or a player's own thickness is the
 * wall that exists. Everything else is the wall its rating sizes, by the code
 * its NQA-1 box names (wall-sizing.ts). This one function feeds the wall
 * thermal node, the burst and collapse pressures and the HX tube bore, so
 * the metal that heats is the metal that bursts.
 *
 * Tanks built in the construction UI used to store a 0.05 m placeholder
 * whatever their rating; new ones store no thickness and are sized here.
 * (Saves made before that keep the 0.05 m they were saved with.)
 */
export function componentWall(
  component: { type: string; id?: string; label?: string },
  ratingBar: number
): { innerDiameter: number; thickness: number; length?: number } | null {
  const comp = component as any;
  const sized = (diameter: number, form: WallForm) => designWallThickness({
    pressureBar: ratingBar, diameter, measuredOn: 'inner', form,
    material: comp.material, nqa1: comp.nqa1, label: component.label || component.id,
  });
  switch (component.type) {
    case 'pipe':
      if (!comp.diameter) return null;
      return { innerDiameter: comp.diameter, thickness: comp.thickness ?? sized(comp.diameter, 'seamless'), length: comp.length };
    case 'vessel':
    case 'reactorVessel':
      if (!comp.innerDiameter) return null;
      return { innerDiameter: comp.innerDiameter, thickness: comp.wallThickness ?? sized(comp.innerDiameter, 'welded'), length: comp.height };
    case 'tank': {
      const D = comp.innerDiameter ?? comp.width;
      if (!D) return null;
      return { innerDiameter: D, thickness: comp.wallThickness ?? sized(D, 'welded'), length: comp.height };
    }
    case 'valve':
    case 'pump':
      // Cast (or forged) bodies: no welded seam to derate
      if (!comp.diameter) return null;
      // Body ~ a cylinder two bores long (the wall node's area uses the same)
      return { innerDiameter: comp.diameter, thickness: sized(comp.diameter, 'seamless'), length: 2 * comp.diameter };
    case 'coreBarrel':
      // Thin shell inside the vessel; its geometry sets both the Barlow
      // burst differential and the buckling collapse differential
      if (!comp.innerDiameter) return null;
      return { innerDiameter: comp.innerDiameter, thickness: comp.thickness ?? comp.barrelThickness ?? 0.05, length: comp.height };
    default:
      return null;
  }
}

/** A heat exchanger's shell wall, sized from its shell-side rating. The
 *  shell is drawn as a cylinder of its smaller dimension. */
export function hxShellWall(hx: any): { innerDiameter: number; thickness: number; length: number } {
  const D = Math.min(hx.width || 1, hx.height || 1);
  return {
    innerDiameter: D,
    length: Math.max(hx.width || 1, hx.height || 1),
    thickness: designWallThickness({
      pressureBar: hx.shellPressureRating ?? hx.pressureRating ?? 20, diameter: D,
      measuredOn: 'inner', form: 'welded', material: hx.material, nqa1: hx.nqa1,
      label: `${hx.label || hx.id} shell`,
    }),
  };
}

/** A heat exchanger's tube wall (m): seamless tubing specified by its OD. */
export function hxTubeWall(hx: any, tubeOD: number): number {
  return designWallThickness({
    pressureBar: hx.tubePressureRating || hx.pressureRating || 100, diameter: tubeOD,
    measuredOn: 'outer', form: 'seamless', material: hx.material, nqa1: hx.nqa1,
    label: `${hx.label || hx.id} tubes`,
  });
}

/**
 * A coaxial cross-vessel's two walls (m): the outer shell sized on its
 * outside diameter (the dimension the component is specified by), the inner
 * pipe on its bore. Both for the full rating - the inner pipe normally sees
 * only the inner-to-annulus differential, but it is what holds the boundary
 * if the annulus is lost.
 */
export function crossVesselWalls(
  ratingBar: number, outerDiameter: number, innerDiameter: number, nqa1: boolean, material?: string
): { outerWallThickness: number; innerWallThickness: number } {
  return {
    outerWallThickness: designWallThickness({
      pressureBar: ratingBar, diameter: outerDiameter, measuredOn: 'outer',
      form: 'welded', nqa1, material, label: 'cross-vessel shell',
    }),
    innerWallThickness: designWallThickness({
      pressureBar: ratingBar, diameter: innerDiameter, measuredOn: 'inner',
      form: 'seamless', nqa1, material, label: 'cross-vessel inner pipe',
    }),
  };
}

/**
 * A cross-vessel's internal hot-duct insulation: the gas bore it leaves
 * (m) and its conductive resistance (m2K/W) referred to the gas-side surface
 * at that bore - the exact cylindrical-shell value, r_g ln(r_pipe/r_g) / k,
 * so that Q = A_gas (T_gas - T_pipe) / (1/h + R). A bare pipe returns its
 * own bore and R = 0.
 */
export function crossVesselInsulation(cv: {
  id?: string; innerDiameter: number;
  innerInsulationThickness?: number; innerInsulationConductivity?: number;
}): { gasBore: number; resistance: number } {
  const t = cv.innerInsulationThickness ?? 0;
  if (!(t > 0)) return { gasBore: cv.innerDiameter, resistance: 0 };
  const k = cv.innerInsulationConductivity;
  if (!(k! > 0)) {
    throw new Error(`[wall-sizing] cross-vessel '${cv.id ?? '?'}' has ${t} m of hot-duct insulation ` +
      `but no innerInsulationConductivity - the insulation's resistance cannot be computed`);
  }
  const rPipe = cv.innerDiameter / 2;
  const rGas = rPipe - t;
  if (!(rGas > 0)) {
    throw new Error(`[wall-sizing] cross-vessel '${cv.id ?? '?'}': ${t} m of insulation fills the ` +
      `${cv.innerDiameter} m inner pipe - no gas bore is left`);
  }
  return { gasBore: 2 * rGas, resistance: (rGas * Math.log(rPipe / rGas)) / k! };
}
