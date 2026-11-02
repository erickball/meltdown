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
