/**
 * The 3D view's scene description.
 *
 * The 3D view is built in two halves that meet here. `scene-model.ts` turns a
 * plant into this description - plain numbers, no DOM, no WebGL, so it runs
 * (and is tested) under Node. `view3d.ts` turns the description into meshes
 * and owns the camera. Nothing in this file may import three.js.
 *
 * Coordinates are the plant's own, in metres: x east, y north (the plan
 * axes every component `position` uses), z up. The renderer does the change
 * of axes to its own convention; nothing upstream of it should.
 */
import type { TerrainSpec } from '../../terrain-types';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** What a part is made of, as far as its resting appearance goes. */
export type Material3D =
  | 'steel'       // pressure boundary: vessels, pipe, pump casings, valve bodies
  | 'machinery'   // turbine casings, motors, generators, diesels
  | 'concrete'    // buildings, pads, pool walls
  | 'structure'   // scaffold and supports
  | 'electrical'  // buses, transformers, breakers, batteries, switchyard gear
  | 'fuel'        // core / fuel region
  | 'water';      // an open water surface (pool, terrain water body)

/**
 * Where a part's live colour comes from. Resolved against the simulation
 * state every frame by `scene-colors.ts`; a part with no source keeps its
 * material's resting colour.
 */
export type ColorSource3D =
  | { kind: 'flowNode'; nodeId: string }          // coloured as the fluid in that node
  | { kind: 'connection'; connectionId: string }  // coloured as the fluid flowing in that flow connection
  | { kind: 'fuel'; componentId: string };        // coloured by fuel temperature

interface PartBase {
  /** Unique within the scene; stable while the plant is unchanged (the renderer keys meshes and colours by it). */
  id: string;
  /** The plant component this part belongs to (pads and scaffold: the component they carry). */
  componentId?: string;
  /** For a connection's pipe run: the connection, as `fromComponentId:fromPortId>toComponentId:toPortId`. */
  connectionKey?: string;
  material: Material3D;
  color?: ColorSource3D;
  /**
   * Under 1 for a shell that has other things inside it (a vessel holding
   * internals, a building), so what it holds can be seen. Omitted = opaque.
   */
  opacity?: number;
  /**
   * The part is the vessel its colour node's water stands in (a tank or
   * vessel shell, a heat exchanger's shell, a condenser): its live colour
   * may carry a liquid level (PartColor.liquid), drawn on it as a
   * horizontal plane in the world - liquid colour below, the colour of the
   * space above it over the rest.
   */
  showsLevel?: boolean;
}

/**
 * A cylinder or cone frustum, optionally hollow, optionally with domed ends.
 * Covers vessels, tanks, pipe stubs, pump casings, nozzles, building shells.
 */
export interface CylinderPart extends PartBase {
  shape: 'cylinder';
  /** Centre of the end the cylinder starts from. */
  base: Vec3;
  /** Unit vector from `base` along the cylinder. */
  axis: Vec3;
  /** Length along the axis, excluding any domed heads. */
  length: number;
  /** Outer radius at `base`. */
  radius: number;
  /** Outer radius at the far end; omitted = same as `radius`. */
  radiusEnd?: number;
  /** End treatment at the base / far end. 'dome' is a 2:1 ellipsoidal head standing outside `length`. Default 'flat'. */
  capBase?: 'flat' | 'dome' | 'open';
  capEnd?: 'flat' | 'dome' | 'open';
  /** Wall thickness for an open-ended shell (so it reads as a wall, not a sheet). Ignored for closed cylinders. */
  wall?: number;
}

/** A rectangular box, optionally turned about the vertical. */
export interface BoxPart extends PartBase {
  shape: 'box';
  center: Vec3;
  /** Full extents along x, y, z before the turn. */
  size: Vec3;
  /** Turn about +z in radians, counter-clockwise seen from above. Default 0. */
  yaw?: number;
  /**
   * A box that is walls only: open at the top (a pool, a rectangular
   * building) with this wall thickness. Omitted = solid.
   */
  wall?: number;
  /** With `wall`: closed by a roof slab of the same thickness (a building), not open at the top. */
  roof?: boolean;
}

/** A round pipe along a polyline, with mitred/elbowed turns: connection runs and pipe components. */
export interface TubePart extends PartBase {
  shape: 'tube';
  path: Vec3[];
  /** Outer radius. */
  radius: number;
}

/** A flat horizontal surface: an open water level in a pool or a terrain water body's polygon. */
export interface SurfacePart extends PartBase {
  shape: 'surface';
  /** Outline, counter-clockwise seen from above; all at the same z. */
  outline: Vec3[];
  /**
   * A pool's water: the surface stands at bottom + level x (top - bottom),
   * the level being its colour node's liquid level (PartColor.surfaceZ).
   */
  levelRange?: { bottom: number; top: number };
  /** A terrain water body (its id): the surface follows the body's live level (PartColor.surfaceZ). */
  waterBody?: string;
}

export type Part3D = CylinderPart | BoxPart | TubePart | SurfacePart;

/** The ground. Either a height field or a flat plane sized to the plant. */
export interface Ground3D {
  /** The plant's terrain, if it has one (heights are absolute z, as in the spec). */
  terrain?: TerrainSpec;
  /** With no terrain: the flat ground's z and plan extent. */
  flat?: { z: number; x0: number; y0: number; x1: number; y1: number };
  /** Plan rectangles where the ground is cut away: what is sunk into it (a pool) is seen from above. */
  holes?: Array<{ x0: number; y0: number; x1: number; y1: number }>;
}

export interface Scene3DModel {
  parts: Part3D[];
  ground: Ground3D;
  /** Axis-aligned box around every part (not the ground): what the camera frames on entry. */
  bounds: { min: Vec3; max: Vec3 };
}

/** A part's live colour: sRGB components in 0..1 (the renderer converts to its working space). */
export interface PartColor {
  r: number;
  g: number;
  b: number;
  /** Emissive strength 0..1 for glowing-hot parts; 0 when not incandescent. */
  glow: number;
  /**
   * Only on a part that `showsLevel`, holding liquid with a space above it:
   * the liquid fills `fraction` (0..1) of the part's height from its lowest
   * point and has this sRGB colour; r/g/b above are then the space above.
   */
  liquid?: { fraction: number; r: number; g: number; b: number };
  /** Only on a surface part: the absolute height it stands at now (omitted: where the model put it). */
  surfaceZ?: number;
}
