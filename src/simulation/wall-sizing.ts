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
 * Containment / building walls. A composite steel + concrete shell is sized
 * with the Section VIII inside-radius formula on a blended allowable stress;
 * a rectangular building takes 1.5x the wall of a cylinder its size (flat
 * walls carry pressure in bending, not membrane tension). Floor of 0.3 m.
 * Shared by the construction dialog and the renderer so both show one wall.
 */
const BUILDING_S_STEEL = 172e6;    // Pa - SA-533 Grade B
const BUILDING_S_CONCRETE = 20e6;  // Pa - effective, reinforced concrete

function buildingAllowable(steelFraction: number): number {
  return steelFraction * BUILDING_S_STEEL + (1 - steelFraction) * BUILDING_S_CONCRETE;
}

function buildingShapeMultiplier(shape: string | undefined): number {
  return shape === 'rectangle' ? 1.5 : 1.0;
}

/** Building wall thickness (m). `span` is the diameter of a cylinder or the
 *  longer side of a rectangle. */
export function buildingWallThickness(
  pressureBar: number, span: number, steelFraction: number, shape: string | undefined
): number {
  const P = pressureBar * 1e5;
  const S = buildingAllowable(steelFraction);
  const t = buildingShapeMultiplier(shape) * P * (span / 2) / (S - 0.6 * P);
  return Math.max(0.3, t);
}

/** Highest building rating (bar) its wall formula holds for: wall at most
 *  half the radius. Cylinder P = S/2.6; rectangle (1.5x wall) P = S/3.6. */
export function maxBuildingDesignPressureBar(steelFraction: number, shape: string | undefined): number {
  const k = buildingShapeMultiplier(shape);
  return buildingAllowable(steelFraction) / (2 * k + 0.6) / 1e5;
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
