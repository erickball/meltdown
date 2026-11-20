/**
 * The 3D view's scene model: a plant turned into plain primitives (see
 * types.ts). Pure - no DOM, no three.js - so it runs and is tested under
 * Node.
 *
 * Every number comes from the same conventions the other two views draw
 * with, so the three agree:
 *  - plan position `component.position`; base `getComponentElevation`
 *    above the LOCAL ground (terrainHeightAt at the component's position, as
 *    the simulation and the 2.5D view read it); vertical extent
 *    `getComponentVisualHeight`; drawn width `getComponentSize`; plan
 *    footprint `componentFootprint`.
 *  - pipe runs are the grid's plan routes (GridView.planRuns) lifted into 3D
 *    by the 2.5D view's own `liftRoute` / `slopeRoute` / `ductContinuation`.
 *    Only the nozzles differ: the 2.5D view finds them through its screen
 *    projection, here a nozzle stands on the component's actual surface - a
 *    ray from inside the body, out through the plan side the route leaves by
 *    (or up/down for a nozzle on a head), at the connection's elevation.
 *  - the pads are the 2.5D foundations (foundations.ts).
 *
 * Heights are absolute: terrain height + elevation. A pipe-run vertex is
 * lifted by the ground under that vertex (as the 2.5D view lifts each one),
 * except the two nozzle ends, which ride with their component.
 */
import type {
  PlantComponent, PlantState, Connection, PipeComponent, Port, TankComponent, VesselComponent,
  ReactorVesselComponent, CoreBarrelComponent, ValveComponent, HeatExchangerComponent,
  TurbineGeneratorComponent, TurbineDrivenPumpComponent, BuildingComponent, CrossVesselComponent,
  PoolComponent, Point,
} from '../../types';
import { connectionDrawElevation, radiantRingOf, waterBodyOf } from '../../types';
import type { TerrainSpec } from '../../terrain-types';
import { terrainHeightAt, buildTerrainModel, cellCenter as terrainCellCenter } from '../../simulation/terrain';
import { hxBundleCount, hxTubeNodeId } from '../../simulation/hx-bundles';
import { reactorBarrelExtent } from '../../reactor-geometry';
import { getComponentElevation } from '../isometric';
import { getComponentVisualHeight, flowConnectionIdForPlantConnection } from '../components';
import { getComponentSize } from '../component-size';
import { GridView, RunEnds } from '../grid-view';
import {
  PortAnchor, Side, componentFootprint, footprintRect, pipeRoute, crossVesselJoint, sideVector,
  verticalNozzle, portSide,
} from '../grid-geometry';
import { Point3, liftRoute, slopeRoute, ductContinuation } from '../pipe-run-3d';
import { foundationsFor, padMargin, PAD_THICKNESS_M } from './foundations';
import type {
  Vec3, Part3D, CylinderPart, BoxPart, TubePart, SurfacePart, Material3D, ColorSource3D, Scene3DModel, Ground3D,
} from './types';

/** Opacity of a vessel shell with things inside it. */
const VESSEL_SHELL_OPACITY = 0.4;
/** Opacity of a building shell with things inside it. */
const BUILDING_SHELL_OPACITY = 0.25;
/** Flat ground with no terrain reaches this far past the plant, as a fraction of the plant's span (and at least FLAT_MARGIN_MIN_M). */
const FLAT_MARGIN_FRACTION = 0.5;
const FLAT_MARGIN_MIN_M = 30;

const UP: Vec3 = { x: 0, y: 0, z: 1 };
const EAST: Vec3 = { x: 1, y: 0, z: 0 };

/**
 * One grid view for the routes, kept between builds: its route cache is what
 * makes a rebuild cheap (the A* search only reruns for runs whose ends or
 * obstacles moved). Its camera is never moved, so the lanes are laid at the
 * default zoom - the 2.5D view lays them at the grid's current zoom, which
 * moves a laned run sideways by a fraction of a pipe width at most.
 */
const grid = new GridView();

// ---------------------------------------------------------------------------
// Building context
// ---------------------------------------------------------------------------

interface Ctx {
  plant: PlantState;
  spec: TerrainSpec | undefined;
  parts: Part3D[];
  /** Per component: the solid primitives its nozzles stand on (a subset of its parts, or pipe tube). */
  bodies: Map<string, Part3D[]>;
  /** Components something else is inside (their shells are see-through). */
  containers: Set<string>;
  usedIds: Set<string>;
}

function groundAt(ctx: Ctx, p: Point): number {
  return ctx.spec ? terrainHeightAt(ctx.spec, p) : 0;
}

function add(ctx: Ctx, part: Part3D, body: boolean): Part3D {
  if (ctx.usedIds.has(part.id)) throw new Error(`[scene3d] duplicate part id '${part.id}'`);
  ctx.usedIds.add(part.id);
  ctx.parts.push(part);
  if (body && part.componentId) {
    let list = ctx.bodies.get(part.componentId);
    if (!list) { list = []; ctx.bodies.set(part.componentId, list); }
    list.push(part);
  }
  return part;
}

function nodeId(c: PlantComponent): string {
  return c.simNodeId || c.id;
}

function flowNode(id: string): ColorSource3D {
  return { kind: 'flowNode', nodeId: id };
}

interface CylOpts {
  radiusEnd?: number;
  capBase?: 'flat' | 'dome' | 'open';
  capEnd?: 'flat' | 'dome' | 'open';
  wall?: number;
  color?: ColorSource3D;
  opacity?: number;
}

function cyl(id: string, componentId: string, material: Material3D, base: Vec3, axis: Vec3,
             length: number, radius: number, o: CylOpts = {}): CylinderPart {
  const p: CylinderPart = { id, componentId, material, shape: 'cylinder', base, axis, length, radius };
  if (o.radiusEnd !== undefined) p.radiusEnd = o.radiusEnd;
  if (o.capBase) p.capBase = o.capBase;
  if (o.capEnd) p.capEnd = o.capEnd;
  if (o.wall !== undefined) p.wall = o.wall;
  if (o.color) p.color = o.color;
  if (o.opacity !== undefined) p.opacity = o.opacity;
  return p;
}

function box(id: string, componentId: string, material: Material3D, center: Vec3, size: Vec3,
             o: { wall?: number; color?: ColorSource3D; opacity?: number } = {}): BoxPart {
  const p: BoxPart = { id, componentId, material, shape: 'box', center, size };
  if (o.wall !== undefined) p.wall = o.wall;
  if (o.color) p.color = o.color;
  if (o.opacity !== undefined) p.opacity = o.opacity;
  return p;
}

/**
 * The domes a vertical vessel of drawn height H and radius R can carry. The
 * contract's dome is a 2:1 ellipsoidal head R/2 deep standing outside the
 * cylinder's length, so each costs R/2 of the height. A vessel too squat
 * for its heads gets flat ends, with a loud error: the drawing would
 * otherwise stand taller than the vessel the physics has.
 */
function domedLength(c: PlantComponent, H: number, R: number, top: boolean, bottom: boolean): { length: number; top: boolean; bottom: boolean } {
  const n = (top ? 1 : 0) + (bottom ? 1 : 0);
  const length = H - n * R / 2;
  if (n > 0 && !(length > 0)) {
    console.error(`[scene3d] ${c.id}: drawn height ${H.toFixed(2)} m cannot hold ${n} head(s) of radius ` +
      `${R.toFixed(2)} m - drawn with flat ends`);
    return { length: H, top: false, bottom: false };
  }
  return { length, top, bottom };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Absolute z of a component's base. Buildings, switchyards and warehouses
 * are drawn from the ground plane up whatever their elevation field says,
 * as both other views draw them.
 */
function baseZ(ctx: Ctx, c: PlantComponent): number {
  const G = groundAt(ctx, c.position);
  return c.type === 'building' || c.type === 'switchyard' || c.type === 'warehouse' ? G : G + getComponentElevation(c);
}

function addComponent(ctx: Ctx, c: PlantComponent): void {
  const G = groundAt(ctx, c.position);
  const z0 = baseZ(ctx, c);
  const H = getComponentVisualHeight(c);
  const size = getComponentSize(c);
  const { x: cx, y: cy } = c.position;
  const id = c.id;
  const shellOpacity = ctx.containers.has(id) ? VESSEL_SHELL_OPACITY : undefined;

  switch (c.type) {
    case 'tank': {
      const tank = c as TankComponent;
      // A tank that IS a terrain water body is drawn by the terrain section
      // (addTerrainWater), which has already checked the body exists
      if (waterBodyOf(tank)) return;
      const ring = radiantRingOf(tank);
      if (ring) {
        // A bank of standpipes on a circle round its own position, as many
        // as the node's water would fill (components.ts renderStandpipeRing)
        const R = ring.diameter / 2;
        const bore = ring.hydraulicDiameter ?? ring.diameter;
        const od = bore + 2 * ring.thickness;
        const stored = (tank as { volume?: number }).volume;
        const volume = stored !== undefined ? stored : Math.PI * Math.pow(tank.width / 2, 2) * tank.height;
        const perTube = Math.PI / 4 * bore * bore * tank.height;
        const count = Math.max(1, Math.round(volume / perTube));
        for (let k = 0; k < count; k++) {
          const th = (2 * Math.PI * (k + 0.5)) / count;
          add(ctx, cyl(`${id}:tube${k}`, id, 'steel', { x: cx + R * Math.cos(th), y: cy + R * Math.sin(th), z: z0 },
            UP, H, od / 2, { color: flowNode(nodeId(c)) }), false);
        }
        const headerH = 2.5 * od;
        for (const [k, zb] of [[0, z0], [1, z0 + H - headerH]] as const) {
          add(ctx, cyl(`${id}:header${k}`, id, 'steel', { x: cx, y: cy, z: zb }, UP, headerH, R + od / 2,
            { capBase: 'open', capEnd: 'open', wall: od }), false);
        }
        // Nozzles stand on the ring's outer face / its header tops
        ctx.bodies.set(id, [cyl(`${id}:body`, id, 'steel', { x: cx, y: cy, z: z0 }, UP, H, R + od / 2)]);
        return;
      }
      add(ctx, cyl(`${id}:shell`, id, 'steel', { x: cx, y: cy, z: z0 }, UP, H, size.width / 2,
        { color: flowNode(nodeId(c)), opacity: shellOpacity }), true);
      return;
    }

    case 'vessel': {
      const v = c as VesselComponent;
      const R = size.width / 2;
      const d = domedLength(c, H, R, !!v.hasDome, !!v.hasBottom);
      add(ctx, cyl(`${id}:shell`, id, 'steel', { x: cx, y: cy, z: z0 + (d.bottom ? R / 2 : 0) }, UP, d.length, R, {
        capBase: d.bottom ? 'dome' : 'flat', capEnd: d.top ? 'dome' : 'flat',
        color: flowNode(nodeId(c)), opacity: shellOpacity,
      }), true);
      return;
    }

    case 'reactorVessel': {
      const rv = c as ReactorVesselComponent;
      const R = size.width / 2;
      const d = domedLength(c, H, R, true, true);
      const barrel = rv.coreBarrelId ? ctx.plant.components.get(rv.coreBarrelId) : undefined;
      const barrelDrawnApart = !!barrel && !(barrel as { isHydraulicOnly?: boolean }).isHydraulicOnly;
      add(ctx, cyl(`${id}:shell`, id, 'steel', { x: cx, y: cy, z: z0 + (d.bottom ? R / 2 : 0) }, UP, d.length, R, {
        capBase: d.bottom ? 'dome' : 'flat', capEnd: d.top ? 'dome' : 'flat',
        color: flowNode(nodeId(c)),
        opacity: shellOpacity ?? (rv.coreBarrelId ? VESSEL_SHELL_OPACITY : undefined),
      }), true);
      if (!barrelDrawnApart) {
        // No core-barrel component of its own to draw: the barrel the
        // vessel's own fields describe (reactor-geometry.ts)
        const ext = reactorBarrelExtent(rv);
        add(ctx, cyl(`${id}:barrel`, id, 'steel', { x: cx, y: cy, z: z0 + ext.bottom }, UP, ext.height,
          rv.barrelDiameter / 2 + rv.barrelThickness, { capBase: 'open', capEnd: 'open', wall: rv.barrelThickness }), false);
      }
      return;
    }

    case 'coreBarrel': {
      const cb = c as CoreBarrelComponent;
      const Ro = cb.innerDiameter / 2 + cb.thickness;
      add(ctx, cyl(`${id}:barrel`, id, 'steel', { x: cx, y: cy, z: z0 }, UP, H, Ro, {
        capBase: 'open', capEnd: 'open', wall: cb.thickness, color: flowNode(nodeId(c)), opacity: VESSEL_SHELL_OPACITY,
      }), false);
      if (cb.activeFuelHeight !== undefined) {
        add(ctx, cyl(`${id}:fuel`, id, 'fuel', { x: cx, y: cy, z: z0 + (cb.coreBottomElevation ?? 0) }, UP,
          cb.activeFuelHeight, cb.innerDiameter / 2, { color: { kind: 'fuel', componentId: id } }), false);
      }
      ctx.bodies.set(id, [cyl(`${id}:body`, id, 'steel', { x: cx, y: cy, z: z0 }, UP, H, Ro)]);
      return;
    }

    case 'pump': {
      // components.ts renderPump, scale s = 1.3 x diameter; the drawing's
      // centre stands at half the visual height (2.2 s) above the base, and
      // its local y runs down: z = centre - y
      const s = ((c as { diameter?: number }).diameter || 0.3) * 1.3;
      const zc = z0 + 1.1 * s;
      const color = flowNode(nodeId(c));
      add(ctx, cyl(`${id}:motor`, id, 'machinery', { x: cx, y: cy, z: zc + 0.05 * s }, UP, 0.9 * s, 0.25 * s), false);
      add(ctx, cyl(`${id}:coupling`, id, 'steel', { x: cx, y: cy, z: zc - 0.1 * s }, UP, 0.15 * s, 0.1 * s), false);
      add(ctx, cyl(`${id}:casing`, id, 'steel', { x: cx, y: cy, z: zc - 0.6 * s }, UP, 0.5 * s, 0.375 * s, { color }), true);
      add(ctx, cyl(`${id}:suction`, id, 'steel', { x: cx, y: cy, z: zc - 0.95 * s }, UP, 0.35 * s, 0.14 * s,
        { radiusEnd: 0.375 * s, color }), true);
      add(ctx, cyl(`${id}:inlet`, id, 'steel', { x: cx, y: cy, z: zc - 1.25 * s }, UP, 0.3 * s, 0.14 * s, { color }), true);
      return;
    }

    case 'valve': {
      const v = c as ValveComponent;
      const d = v.diameter || 0.2;
      // Drawn bodies are 1.3x (check, relief, PORV) or 1.15x the bore
      const k = v.valveType === 'check' || v.valveType === 'relief' || v.valveType === 'porv' ? 1.3 : 1.15;
      const bodyR = 0.75 * d * k;   // half the drawn body length
      const bodyH = d * k;
      const zc = z0 + H / 2;
      add(ctx, cyl(`${id}:body`, id, 'steel', { x: cx, y: cy, z: zc - bodyH / 2 }, UP, bodyH, bodyR,
        { color: flowNode(nodeId(c)) }), true);
      const actuatorH = 0.15 * d;
      const stemBase = zc + bodyH / 2;
      const stemLen = z0 + H - actuatorH - stemBase;
      if (stemLen > 0) {
        add(ctx, cyl(`${id}:stem`, id, 'steel', { x: cx, y: cy, z: stemBase }, UP, stemLen, 0.08 * d), false);
      }
      add(ctx, cyl(`${id}:actuator`, id, 'machinery', { x: cx, y: cy, z: z0 + H - actuatorH }, UP, actuatorH, 0.4 * d), false);
      return;
    }

    case 'heatExchanger': {
      const hx = c as HeatExchangerComponent;
      const w = size.width, h = size.height;
      const hxType = hx.hxType || 'utube';
      const nb = hxBundleCount(hx);
      const tubeNode = (b: number) => b === 0 ? (hx.simNodeId || hxTubeNodeId(id, 0)) : hxTubeNodeId(id, b);
      const shellColor = flowNode(`${id}-shell`);
      const L = hx.plenumLength || 0;
      const horizontal = w > h;
      if (!horizontal) {
        // Upright shell; a U-tube's bend bulges out of the top
        add(ctx, cyl(`${id}:shell`, id, 'steel', { x: cx, y: cy, z: z0 }, UP, h, w / 2, {
          capEnd: hxType === 'utube' ? 'dome' : 'flat', color: shellColor, opacity: shellOpacity,
        }), true);
        if (L > 0) {
          const rp = w / 2 / nb;
          for (let b = 0; b < nb; b++) {
            const px = cx - w / 2 + (2 * b + 1) * rp;
            add(ctx, cyl(`${id}:plenum-bottom${b}`, id, 'steel', { x: px, y: cy, z: z0 - L }, UP, L, rp,
              { color: flowNode(tubeNode(b)) }), true);
            if (hxType !== 'utube') {
              add(ctx, cyl(`${id}:plenum-top${b}`, id, 'steel', { x: px, y: cy, z: z0 + h }, UP, L, rp,
                { color: flowNode(tubeNode(b)) }), true);
            }
          }
        }
      } else {
        const zAxis = z0 + h / 2;
        add(ctx, cyl(`${id}:shell`, id, 'steel', { x: cx - w / 2, y: cy, z: zAxis }, EAST, w, h / 2, {
          capEnd: hxType === 'utube' ? 'dome' : 'flat', color: shellColor, opacity: shellOpacity,
        }), true);
        if (L > 0) {
          const rp = h / 2 / nb;
          for (let b = 0; b < nb; b++) {
            const pz = z0 + h - (2 * b + 1) * rp;
            add(ctx, cyl(`${id}:plenum-west${b}`, id, 'steel', { x: cx - w / 2 - L, y: cy, z: pz }, EAST, L, rp,
              { color: flowNode(tubeNode(b)) }), true);
            if (hxType !== 'utube') {
              add(ctx, cyl(`${id}:plenum-east${b}`, id, 'steel', { x: cx + w / 2, y: cy, z: pz }, EAST, L, rp,
                { color: flowNode(tubeNode(b)) }), true);
            }
          }
        }
      }
      return;
    }

    case 'turbine-generator': {
      const t = c as TurbineGeneratorComponent;
      const w = size.width, h = size.height;
      const lr = t.orientation !== 'right-left';
      const dir: Vec3 = { x: lr ? 1 : -1, y: 0, z: 0 };
      const zAxis = z0 + h / 2;
      const inletX = cx - dir.x * w / 2;
      // Casing: small at the HP inlet (40% of the exhaust diameter), full at the exhaust
      add(ctx, cyl(`${id}:casing`, id, 'machinery', { x: inletX, y: cy, z: zAxis }, dir, w, 0.2 * h,
        { radiusEnd: 0.5 * h, color: flowNode(nodeId(c)) }), true);
      // Generator on the shaft beyond the exhaust end (diameter 2/3 of the exhaust)
      const genR = h / 3;
      add(ctx, cyl(`${id}:generator`, id, 'machinery', { x: cx + dir.x * w / 2, y: cy, z: zAxis }, dir, 2 * genR, genR), false);
      return;
    }

    case 'turbine-driven-pump': {
      const t = c as TurbineDrivenPumpComponent;
      const w = size.width, h = size.height;
      const lr = t.orientation !== 'right-left';
      const dir: Vec3 = { x: lr ? 1 : -1, y: 0, z: 0 };
      const zAxis = z0 + h / 2;
      const inletX = cx - dir.x * w / 2;
      // Turbine over the inlet 60% of the length, pump over the rest
      add(ctx, cyl(`${id}:turbine`, id, 'machinery', { x: inletX, y: cy, z: zAxis }, dir, 0.6 * w, 0.2 * h,
        { radiusEnd: 0.5 * h, color: flowNode(nodeId(c)) }), true);
      add(ctx, cyl(`${id}:pump`, id, 'steel', { x: inletX + dir.x * 0.6 * w, y: cy, z: zAxis }, dir, 0.4 * w, 0.4 * h,
        { color: flowNode(`${id}-pump`) }), true);
      return;
    }

    case 'condenser': {
      const w = size.width, h = size.height;
      add(ctx, box(`${id}:shell`, id, 'steel', { x: cx, y: cy, z: z0 + h / 2 }, { x: w, y: Math.min(w, h), z: h },
        { color: flowNode(nodeId(c)), opacity: shellOpacity }), true);
      return;
    }

    case 'controller':
    case 'bus':
    case 'transformer':
    case 'breaker':
    case 'battery':
    case 'diesel-generator': {
      // Front-view drawings with no plan depth of their own: as deep as the
      // footprint the grid gives them (the smaller drawn dimension)
      const w = size.width, h = size.height;
      add(ctx, box(`${id}:box`, id, c.type === 'diesel-generator' ? 'machinery' : 'electrical',
        { x: cx, y: cy, z: z0 + h / 2 }, { x: w, y: Math.min(w, h), z: h }), true);
      return;
    }

    case 'switchyard': {
      // Plan-native: width x depth on the ground. A gravelled slab with the
      // main transformer bank standing on it
      const w = size.width, d = size.height;
      add(ctx, box(`${id}:slab`, id, 'concrete', { x: cx, y: cy, z: G + 0.1 }, { x: w, y: d, z: 0.2 }), true);
      add(ctx, box(`${id}:gear`, id, 'electrical', { x: cx, y: cy, z: G + 0.2 + 2 }, { x: 0.3 * w, y: 0.3 * d, z: 4 }), false);
      return;
    }

    case 'warehouse': {
      // Plan-native: width x depth, as tall as getComponentVisualHeight says
      const w = size.width, d = size.height;
      add(ctx, box(`${id}:shed`, id, 'structure', { x: cx, y: cy, z: G + H / 2 }, { x: w, y: d, z: H }), true);
      return;
    }

    case 'building': {
      // Drawn from the ground plane up whatever its elevation field says, as
      // both other views draw it
      const b = c as BuildingComponent;
      const opacity = ctx.containers.has(id) ? BUILDING_SHELL_OPACITY : undefined;
      if (b.shape === 'cylinder') {
        add(ctx, cyl(`${id}:shell`, id, 'concrete', { x: cx, y: cy, z: G }, UP, b.height, (b.diameter || 40) / 2, {
          capEnd: 'open', wall: b.wallThickness, color: flowNode(nodeId(c)), opacity,
        }), true);
      } else {
        add(ctx, box(`${id}:shell`, id, 'concrete', { x: cx, y: cy, z: G + b.height / 2 },
          { x: b.width || 40, y: b.length || 40, z: b.height },
          { wall: b.wallThickness, color: flowNode(nodeId(c)), opacity }), true);
      }
      return;
    }

    case 'crossVessel': {
      const cv = c as CrossVesselComponent;
      const L = cv.length || 3;
      const R = (cv.outerDiameter || 1) / 2;
      const a = cv.orientation === 'angled' ? (cv.angle ?? 0) * Math.PI / 180 : 0;
      const axis: Vec3 = { x: Math.cos(a), y: 0, z: Math.sin(a) };
      const centre = { x: cx, y: cy, z: z0 + R };
      const base = { x: centre.x - axis.x * L / 2, y: centre.y, z: centre.z - axis.z * L / 2 };
      add(ctx, cyl(`${id}:shell`, id, 'steel', base, axis, L, R,
        { color: flowNode(`${id}-annulus`), opacity: VESSEL_SHELL_OPACITY }), true);
      add(ctx, cyl(`${id}:inner`, id, 'steel', base, axis, L, cv.innerDiameter / 2 + cv.innerWallThickness,
        { color: flowNode(`${id}-inner`) }), false);
      return;
    }

    case 'pool': {
      // Open-topped concrete box sunk to its depth; the water standing in it
      // at its fill level; the racks on the floor where the model puts them
      const p = c as PoolComponent;
      const side = p.side || 12, D = p.depth || 12, t = p.wallThickness || 1.5;
      add(ctx, box(`${id}:walls`, id, 'concrete', { x: cx, y: cy, z: z0 + D / 2 }, { x: side, y: side, z: D }, { wall: t }), true);
      const inner = side - 2 * t;
      const floor = z0 + t;
      const zw = floor + (p.fillLevel ?? 0) * (D - t);
      add(ctx, {
        id: `${id}:water`, componentId: id, material: 'water', shape: 'surface', color: flowNode(nodeId(c)),
        outline: square(cx, cy, inner / 2, zw),
      } as SurfacePart, false);
      const rackH = p.rackHeight || 3.66;
      add(ctx, box(`${id}:racks`, id, 'fuel', { x: cx, y: cy, z: floor + (p.rackBottomElevation ?? 0.5) + rackH / 2 },
        { x: 0.8 * inner, y: 0.8 * inner, z: rackH }, { color: { kind: 'fuel', componentId: id } }), false);
      return;
    }

    case 'pipe': {
      const pipe = c as PipeComponent;
      const path = pipeComponentPath(ctx, pipe);
      if (path.length < 2) {
        console.error(`[scene3d] pipe ${id} has a zero-length run - nothing to draw`);
        return;
      }
      add(ctx, {
        id: `${id}:run`, componentId: id, material: 'steel', shape: 'tube', path,
        radius: (pipe.diameter || 0.3) / 2 + (pipe.thickness || 0), color: flowNode(nodeId(c)),
      } as TubePart, true);
      return;
    }

    default:
      throw new Error(`[scene3d] no 3D shape for component type '${(c as { type: string }).type}' (${(c as { id: string }).id})`);
  }
}

function square(cx: number, cy: number, half: number, z: number): Vec3[] {
  return [
    { x: cx - half, y: cy - half, z }, { x: cx + half, y: cy - half, z },
    { x: cx + half, y: cy + half, z }, { x: cx - half, y: cy + half, z },
  ];
}

/** The plan route a pipe component is drawn along: the grid's laned route, else its own. */
let currentRuns: Map<Connection | PipeComponent, Point[]> = new Map();
let currentEnds: Map<Connection, RunEnds> = new Map();

function pipeComponentPath(ctx: Ctx, pipe: PipeComponent): Vec3[] {
  const plan = currentRuns.get(pipe) ?? pipeRoute(pipe);
  const startZ = pipe.elevation ?? 0;
  const rel = slopeRoute(plan, startZ, pipe.endElevation ?? startZ);
  return rel.map(p => ({ x: p.x, y: p.y, z: p.z + groundAt(ctx, p) }));
}

/**
 * Terrain water bodies as level surfaces. The water is drawn as the
 * rectangle round its basin's cells at the body's declared surface: where
 * the ground inside that rectangle stands higher than the water, the ground
 * covers it, so the visible shoreline is the true waterline. A tank that IS
 * the body (TankComponent.waterBody) colours it from its node.
 */
function addTerrainWater(ctx: Ctx): void {
  const components = Array.from(ctx.plant.components.values());
  const claimed = new Map<string, PlantComponent>();
  for (const c of components) {
    const body = waterBodyOf(c as never);
    if (!body) continue;
    if (!ctx.spec?.waters?.some(w => w.id === body)) {
      throw new Error(`[scene3d] tank ${c.id} is drawn as terrain water body '${body}', but the plant's terrain has no such body`);
    }
    claimed.set(body, c);
  }
  const spec = ctx.spec;
  if (!spec?.waters?.length) return;
  const model = buildTerrainModel(spec);
  const half = spec.cellSize / 2;
  for (const basin of model.basins) {
    if (!basin.water) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const cell of basin.cells) {
      const p = terrainCellCenter(spec, cell);
      x0 = Math.min(x0, p.x - half); x1 = Math.max(x1, p.x + half);
      y0 = Math.min(y0, p.y - half); y1 = Math.max(y1, p.y + half);
    }
    const z = basin.water.surface;
    const owner = claimed.get(basin.water.id);
    const part: SurfacePart = {
      id: `water:${basin.water.id}`, material: 'water', shape: 'surface',
      outline: [{ x: x0, y: y0, z }, { x: x1, y: y0, z }, { x: x1, y: y1, z }, { x: x0, y: y1, z }],
    };
    if (owner) {
      part.componentId = owner.id;
      part.color = flowNode(nodeId(owner));
    }
    add(ctx, part, false);
  }
}

function addPads(ctx: Ctx, components: PlantComponent[]): void {
  for (const [id, f] of foundationsFor(ctx.plant, components)) {
    if (!f.onGround) continue;
    const c = ctx.plant.components.get(id)!;
    const G = groundAt(ctx, c.position);
    const m = padMargin(f.rect);
    add(ctx, box(`pad:${id}`, id, 'concrete',
      { x: (f.rect.x0 + f.rect.x1) / 2, y: (f.rect.y0 + f.rect.y1) / 2, z: G + PAD_THICKNESS_M / 2 },
      { x: f.rect.x1 - f.rect.x0 + 2 * m, y: f.rect.y1 - f.rect.y0 + 2 * m, z: PAD_THICKNESS_M }), false);
  }
}

// ---------------------------------------------------------------------------
// Nozzles
// ---------------------------------------------------------------------------

/** How a nozzle leaves its component: through a plan side, or up/down out of a head. */
type Leave = { side: Side } | { vertical: 'up' | 'down' };

/**
 * Where a connection meets a component, in absolute coordinates, and the
 * ground the component stands on (the run's end vertex rides with it).
 *
 * A pipe's nozzle is its run's end. Anything else: a ray from inside the
 * component's body - its axis at the connection's drawn elevation for a side
 * nozzle (offset by the port's lateral position for a north/south one), or
 * from the middle of its height at the nozzle's plan point for a head nozzle
 * - out through the body's surface; the nozzle is where it leaves.
 */
function nozzle(ctx: Ctx, conn: Connection, end: 'from' | 'to', c: PlantComponent, port: Port, leave: Leave,
                planPoint: Point | null): { p: Vec3; ground: number } {
  const elev = connectionDrawElevation(conn, end, ctx.plant.components);
  if (c.type === 'pipe') {
    const pipe = c as PipeComponent;
    const run = pipeComponentPath(ctx, pipe);
    const atEnd = port.position.x > pipe.length / 2;
    const q = atEnd ? run[run.length - 1] : run[0];
    const ground = groundAt(ctx, q);
    const endElev = atEnd && pipe.endElevation !== undefined ? pipe.endElevation : (pipe.elevation ?? 0);
    // A connection elevation is measured from the pipe's bottom, half a bore under its centreline
    return { p: { x: q.x, y: q.y, z: ground + endElev + elev - (pipe.diameter || 0) / 2 }, ground };
  }
  const ground = groundAt(ctx, c.position);
  const z0 = baseZ(ctx, c);
  const body = ctx.bodies.get(c.id);
  if (!body || body.length === 0) {
    // Nothing solid to stand on (a water body): the nozzle is its plan anchor at the connection's height
    const q = planPoint ?? c.position;
    return { p: { x: q.x, y: q.y, z: z0 + elev }, ground };
  }
  let origin: Vec3, dir: Vec3;
  if ('vertical' in leave) {
    const q = planPoint ?? { x: c.position.x + port.position.x, y: c.position.y };
    origin = { x: q.x, y: q.y, z: z0 + getComponentVisualHeight(c) / 2 };
    dir = { x: 0, y: 0, z: leave.vertical === 'up' ? 1 : -1 };
  } else {
    const v = sideVector(leave.side);
    // A north/south nozzle keeps its lateral place on the front view - except
    // on a valve, which is turned in plan to suit its piping, so its ports'
    // front-view offsets run along whichever side its line leaves by
    const lateral = (leave.side === 'N' || leave.side === 'S') && c.type !== 'valve' ? port.position.x : 0;
    origin = { x: c.position.x + lateral, y: c.position.y, z: z0 + elev };
    dir = { x: v.x, y: v.y, z: 0 };
  }
  let tMax = exitThrough(body, origin, dir);
  if (tMax === -Infinity && !('vertical' in leave)) {
    // A side nozzle whose stored elevation lies above or below the drawn
    // body at that line (a valve's line stored at its base, 0 m, where the
    // body stands round its mid-height; a turbine inlet at grade): the
    // nozzle meets the body at the nearest height the body has there (a
    // drawing choice only: the physics keeps the stored elevation). "There"
    // is under the port as the front view places it - an east/west nozzle
    // stands at its lateral offset (a turbine's inlet at the inlet end) -
    // or, when that is off the body, on the line the ray was cast along.
    const far = 1e4;
    const lines: Point[] = [];
    if (dir.x !== 0) lines.push({ x: c.position.x + dir.x * Math.abs(port.position.x) * 0.999, y: c.position.y });
    lines.push({ x: origin.x, y: origin.y });
    for (const q of lines) {
      const up = exitThrough(body, { x: q.x, y: q.y, z: origin.z - far }, UP);
      const down = exitThrough(body, { x: q.x, y: q.y, z: origin.z + far }, { x: 0, y: 0, z: -1 });
      if (up === -Infinity || down === -Infinity) continue;
      const zhi = origin.z - far + up, zlo = origin.z + far - down;
      const inset = 0.02 * (zhi - zlo);
      const moved = { ...origin, z: origin.z < zlo ? zlo + inset : zhi - inset };
      const t = exitThrough(body, moved, dir);
      if (t > -Infinity) { origin = moved; tMax = t; break; }
    }
  }
  if (tMax === -Infinity) {
    // The ray never meets the body: the connection's elevation is outside
    // the drawn component (or the nozzle's plan point is off its head).
    // Draw the nozzle at the footprint edge so the run still lands
    // somewhere visible, and say so.
    warnOnce(`${c.id}:${port.id}`, `[scene3d] nozzle ${c.id}:${port.id} does not meet the drawn component ` +
      `(connection elevation ${elev.toFixed(2)} m, drawn height ${getComponentVisualHeight(c).toFixed(2)} m) - ` +
      `placed on the footprint edge`);
    const r = footprintRect(c.position, componentFootprint(c));
    const half = Math.abs(dir.x) > 0 ? (r.x1 - r.x0) / 2 : Math.abs(dir.y) > 0 ? (r.y1 - r.y0) / 2 : 0;
    tMax = 'vertical' in leave ? getComponentVisualHeight(c) / 2 : half;
  }
  return { p: { x: origin.x + dir.x * tMax, y: origin.y + dir.y * tMax, z: origin.z + dir.z * tMax }, ground };
}

/** Exit parameter of a ray through the union of a body's parts (-Infinity: it misses them all). */
function exitThrough(body: Part3D[], o: Vec3, d: Vec3): number {
  let tMax = -Infinity;
  for (const part of body) {
    const t = rayExit(part, o, d);
    if (t !== null && t > tMax) tMax = t;
  }
  return tMax;
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(msg);
}

/** How a nozzle with a plan anchor leaves; without one (inside a section view) the way toward `toward`. */
function leaveOf(c: PlantComponent, portId: string, anchor: PortAnchor | null, toward: Point | null): Leave {
  if (anchor) return anchor.vertical ? { vertical: anchor.vertical } : { side: anchor.side };
  const vertical = verticalNozzle(c, portId);
  if (vertical) return { vertical };
  if (toward) {
    const dx = toward.x - c.position.x, dy = toward.y - c.position.y;
    if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) {
      // canvas.ts leaveAxis: the axis whose footprint edge the point is nearer, relative to the footprint's half extents
      const r = footprintRect(c.position, componentFootprint(c));
      const nx = Math.abs(dx) / ((r.x1 - r.x0) / 2);
      const ny = Math.abs(dy) / ((r.y1 - r.y0) / 2);
      return { side: nx >= ny ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'N' : 'S') };
    }
  }
  const port = c.ports.find(p => p.id === portId)!;
  return { side: portSide(port, getComponentSize(c)) };
}

/**
 * Exit parameter of the ray o + t d (d unit) from a part treated as solid,
 * or null when it misses. The largest t >= 0 at which the ray crosses the
 * part's surface.
 */
function rayExit(part: Part3D, o: Vec3, d: Vec3): number | null {
  if (part.shape === 'box') {
    const yaw = part.yaw ?? 0;
    const cs = Math.cos(-yaw), sn = Math.sin(-yaw);
    const px = o.x - part.center.x, py = o.y - part.center.y, pz = o.z - part.center.z;
    const lo = [cs * px - sn * py, sn * px + cs * py, pz];
    const ld = [cs * d.x - sn * d.y, sn * d.x + cs * d.y, d.z];
    const half = [part.size.x / 2, part.size.y / 2, part.size.z / 2];
    let t0 = -Infinity, t1 = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(ld[i]) < 1e-12) {
        if (Math.abs(lo[i]) > half[i]) return null;
        continue;
      }
      const a = (-half[i] - lo[i]) / ld[i], b = (half[i] - lo[i]) / ld[i];
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    return t0 <= t1 && t1 >= 0 ? t1 : null;
  }
  if (part.shape !== 'cylinder') return null;
  const u = part.axis;
  const [e1, e2] = perpendiculars(u);
  const p = { x: o.x - part.base.x, y: o.y - part.base.y, z: o.z - part.base.z };
  const ox = dot(p, e1), oy = dot(p, e2), os = dot(p, u);
  const dx = dot(d, e1), dy = dot(d, e2), ds = dot(d, u);
  const L = part.length, r0 = part.radius, r1 = part.radiusEnd ?? part.radius;
  const k = (r1 - r0) / L;
  let best = -Infinity;
  const take = (t: number) => { if (t >= -1e-9 && t > best) best = t; };
  // Lateral surface (cone when r1 != r0)
  {
    const A = dx * dx + dy * dy - k * k * ds * ds;
    const B = 2 * (ox * dx + oy * dy - k * ds * (r0 + k * os));
    const C = ox * ox + oy * oy - (r0 + k * os) * (r0 + k * os);
    for (const t of quadRoots(A, B, C)) {
      const s = os + ds * t;
      if (s >= 0 && s <= L) take(t);
    }
  }
  // Ends: a flat disc, or a 2:1 head standing outside the length
  const endAt = (sEnd: number, r: number, cap: 'flat' | 'dome' | 'open' | undefined, outward: number) => {
    if (cap === 'dome') {
      const h = r / 2;
      const A = (dx * dx + dy * dy) / (r * r) + (ds * ds) / (h * h);
      const B = 2 * ((ox * dx + oy * dy) / (r * r) + ((os - sEnd) * ds) / (h * h));
      const C = (ox * ox + oy * oy) / (r * r) + ((os - sEnd) * (os - sEnd)) / (h * h) - 1;
      for (const t of quadRoots(A, B, C)) {
        if ((os + ds * t - sEnd) * outward >= 0) take(t);
      }
    } else if (Math.abs(ds) > 1e-12) {
      const t = (sEnd - os) / ds;
      const x = ox + dx * t, y = oy + dy * t;
      if (x * x + y * y <= r * r) take(t);
    }
  };
  endAt(0, r0, part.capBase, -1);
  endAt(L, r1, part.capEnd, 1);
  return best > -Infinity ? best : null;
}

function quadRoots(A: number, B: number, C: number): number[] {
  if (Math.abs(A) < 1e-14) return Math.abs(B) < 1e-14 ? [] : [-C / B];
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Two unit vectors perpendicular to unit `u` and to each other. */
export function perpendiculars(u: Vec3): [Vec3, Vec3] {
  const ref = Math.abs(u.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  let e1 = { x: u.y * ref.z - u.z * ref.y, y: u.z * ref.x - u.x * ref.z, z: u.x * ref.y - u.y * ref.x };
  const n = Math.hypot(e1.x, e1.y, e1.z);
  e1 = { x: e1.x / n, y: e1.y / n, z: e1.z / n };
  const e2 = { x: u.y * e1.z - u.z * e1.y, y: u.z * e1.x - u.x * e1.z, z: u.x * e1.y - u.y * e1.x };
  return [e1, e2];
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export function connectionKey(conn: Connection): string {
  return `${conn.fromComponentId}:${conn.fromPortId}>${conn.toComponentId}:${conn.toPortId}`;
}

function isCrossVesselTargetPair(a: PlantComponent, b: PlantComponent): boolean {
  const cv = a.type === 'crossVessel' ? a : b.type === 'crossVessel' ? b : undefined;
  const mateId = cv ? (cv as CrossVesselComponent).targetComponentId : undefined;
  return !!mateId && (mateId === a.id || mateId === b.id);
}

function isHydraulicOnly(c: PlantComponent): boolean {
  return !!(c as { isHydraulicOnly?: boolean }).isHydraulicOnly;
}

function addConnections(ctx: Ctx): void {
  const keys = new Map<string, number>();
  for (const conn of ctx.plant.connections) {
    const from = ctx.plant.components.get(conn.fromComponentId);
    const to = ctx.plant.components.get(conn.toComponentId);
    // A line to the open air (no component at one end) is a vent, drawn by neither perspective view
    if (!from || !to || isHydraulicOnly(from) || isHydraulicOnly(to)) continue;
    const fromPort = from.ports.find(p => p.id === conn.fromPortId);
    const toPort = to.ports.find(p => p.id === conn.toPortId);
    if (!fromPort || !toPort) continue;
    // An opening between a component and its own container: no pipe
    if (from.containedBy === to.id || to.containedBy === from.id) continue;

    let path: Vec3[] | null = null;
    const joint = crossVesselJoint(conn, ctx.plant);
    if (joint) {
      if (joint.kind === 'flush') continue;   // nozzle to nozzle at the weld: nothing between them
      // Inside the vessel the duct is welded to: the duct's inner pipe goes
      // on to the nozzle it serves; an annulus line runs inside the vessel
      // to the duct's end. Both laid out from the duct
      const ductIsFrom = joint.crossVessel === from;
      const duct = ductIsFrom ? from : to, other = ductIsFrom ? to : from;
      const ductPort = ductIsFrom ? fromPort : toPort, otherPort = ductIsFrom ? toPort : fromPort;
      const ductEnd = ductIsFrom ? 'from' : 'to', otherEnd = ductIsFrom ? 'to' : 'from';
      const a = nozzle(ctx, conn, ductEnd, duct, ductPort, leaveOf(duct, ductPort.id, null, null), null);
      const b = nozzle(ctx, conn, otherEnd, other, otherPort, leaveOf(other, otherPort.id, null, duct.position), null);
      const laid = ductContinuation(a.p, b.p);
      path = ductIsFrom ? laid : laid.reverse();
    } else if (isCrossVesselTargetPair(from, to)) {
      continue;   // drawn mating face to face (canvas.ts isCrossVesselTargetPair)
    } else {
      const plan = currentRuns.get(conn);
      if (plan && plan.length >= 2) {
        const ends = currentEnds.get(conn);
        const fa = ends?.from ?? null, ta = ends?.to ?? null;
        const a = nozzle(ctx, conn, 'from', from, fromPort, leaveOf(from, fromPort.id, fa, plan[0]), fa?.point ?? null);
        const b = nozzle(ctx, conn, 'to', to, toPort, leaveOf(to, toPort.id, ta, plan[plan.length - 1]), ta?.point ?? null);
        const axisOf = (c: PlantComponent, anchor: PortAnchor | null, endPt: Point): 'x' | 'y' => {
          if (anchor) return anchor.side === 'E' || anchor.side === 'W' ? 'x' : 'y';
          if (c.type === 'pipe') return 'x';
          const r = footprintRect(c.position, componentFootprint(c));
          const nx = Math.abs(endPt.x - c.position.x) / ((r.x1 - r.x0) / 2);
          const ny = Math.abs(endPt.y - c.position.y) / ((r.y1 - r.y0) / 2);
          return nx >= ny ? 'x' : 'y';
        };
        // Laid in heights above local ground, then each vertex lifted by its ground
        const rel = (q: { p: Vec3; ground: number }): Point3 => ({ x: q.p.x, y: q.p.y, z: q.p.z - q.ground });
        const lifted = liftRoute(rel(a), axisOf(from, fa, plan[0]), plan, rel(b), axisOf(to, ta, plan[plan.length - 1]),
          fa?.vertical ?? null, ta?.vertical ?? null);
        path = lifted.map((v, i) => ({
          x: v.x, y: v.y,
          z: v.z + (i === 0 ? a.ground : i === lifted.length - 1 ? b.ground : groundAt(ctx, v)),
        }));
      } else {
        // No plan route: both ends in one vessel's section view (or a route
        // the grid could not find). A square run between the two nozzles,
        // each leaving toward the other
        const a = nozzle(ctx, conn, 'from', from, fromPort, leaveOf(from, fromPort.id, null, to.position), null);
        const b = nozzle(ctx, conn, 'to', to, toPort, leaveOf(to, toPort.id, null, from.position), null);
        path = ductContinuation(a.p, b.p);
      }
    }
    if (!path || path.length < 2) continue;
    const base = connectionKey(conn);
    const n = keys.get(base) ?? 0;
    keys.set(base, n + 1);
    const flowId = flowConnectionIdForPlantConnection(conn, ctx.plant);
    if (!flowId) throw new Error(`[scene3d] connection ${base} has no simulation flow-connection id`);
    const bore = conn.flowArea && conn.flowArea > 0 ? Math.sqrt(4 * conn.flowArea / Math.PI) : 0.3;
    add(ctx, {
      id: n === 0 ? `conn:${base}` : `conn:${base}#${n}`,
      connectionKey: base, material: 'steel', shape: 'tube', path, radius: bore / 2,
      color: { kind: 'connection', connectionId: flowId },
    } as TubePart, false);
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export function buildScene3D(plantState: PlantState): Scene3DModel {
  const components = Array.from(plantState.components.values()).filter(c => !isHydraulicOnly(c));
  const containers = new Set<string>();
  for (const c of components) if (c.containedBy) containers.add(c.containedBy);
  const ctx: Ctx = {
    plant: plantState, spec: plantState.terrain, parts: [], bodies: new Map(), containers, usedIds: new Set(),
  };
  currentRuns = grid.planRuns(plantState);
  currentEnds = grid.planRunEnds();

  addTerrainWater(ctx);
  for (const c of components) addComponent(ctx, c);
  addPads(ctx, components);
  addConnections(ctx);

  const bounds = partsBounds(ctx.parts);
  let ground: Ground3D;
  if (plantState.terrain) {
    ground = { terrain: plantState.terrain };
  } else {
    const span = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y);
    const m = Math.max(FLAT_MARGIN_MIN_M, FLAT_MARGIN_FRACTION * span);
    ground = { flat: { z: 0, x0: bounds.min.x - m, y0: bounds.min.y - m, x1: bounds.max.x + m, y1: bounds.max.y + m } };
  }
  return { parts: ctx.parts, ground, bounds };
}

/** Axis-aligned box round every part (empty plant: a unit box at the origin). */
function partsBounds(parts: Part3D[]): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  const grow = (x: number, y: number, z: number, r: number) => growXYZ(x, y, z, r, r, r);
  const growXYZ = (x: number, y: number, z: number, ex: number, ey: number, ez: number) => {
    min.x = Math.min(min.x, x - ex); min.y = Math.min(min.y, y - ey); min.z = Math.min(min.z, z - ez);
    max.x = Math.max(max.x, x + ex); max.y = Math.max(max.y, y + ey); max.z = Math.max(max.z, z + ez);
  };
  for (const p of parts) {
    switch (p.shape) {
      case 'cylinder': {
        // An end disc of radius r normal to u reaches r*sqrt(1 - u_i^2) along
        // world axis i; a 2:1 head (semi-axes r, r, r/2) round the same
        // centre reaches sqrt(r^2 (1 - u_i^2) + (r/2)^2 u_i^2) - the whole
        // ellipsoid's box, which holds the outward half that is the head
        const u = p.axis;
        const disc = (c: Vec3, r: number, dome: boolean) => {
          const e = (ui: number) => Math.sqrt(r * r * (1 - ui * ui) + (dome ? (r / 2) * (r / 2) * ui * ui : 0));
          growXYZ(c.x, c.y, c.z, e(u.x), e(u.y), e(u.z));
        };
        const end = { x: p.base.x + u.x * p.length, y: p.base.y + u.y * p.length, z: p.base.z + u.z * p.length };
        disc(p.base, p.radius, p.capBase === 'dome');
        disc(end, p.radiusEnd ?? p.radius, p.capEnd === 'dome');
        break;
      }
      case 'box': {
        const yaw = p.yaw ?? 0;
        const hx = p.size.x / 2, hy = p.size.y / 2;
        const ex = Math.abs(Math.cos(yaw)) * hx + Math.abs(Math.sin(yaw)) * hy;
        const ey = Math.abs(Math.sin(yaw)) * hx + Math.abs(Math.cos(yaw)) * hy;
        grow(p.center.x - ex, p.center.y - ey, p.center.z - p.size.z / 2, 0);
        grow(p.center.x + ex, p.center.y + ey, p.center.z + p.size.z / 2, 0);
        break;
      }
      case 'tube':
        for (const q of p.path) grow(q.x, q.y, q.z, p.radius);
        break;
      case 'surface':
        for (const q of p.outline) grow(q.x, q.y, q.z, 0);
        break;
    }
  }
  if (min.x === Infinity) return { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } };
  return { min, max };
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/** Fields that shape or place a component's drawing (never live state). */
const GEOMETRY_FIELDS = [
  'type', 'elevation', 'rotation', 'width', 'height', 'depth', 'side', 'length', 'diameter', 'thickness',
  'innerDiameter', 'outerDiameter', 'wallThickness', 'innerWallThickness', 'hasDome', 'hasBottom',
  'barrelDiameter', 'barrelThickness', 'barrelBottomGap', 'barrelTopGap', 'coreBarrelId',
  'activeFuelHeight', 'coreBottomElevation', 'hxType', 'bundleCount', 'plenumLength', 'shape',
  'orientation', 'angle', 'endElevation', 'containedBy', 'waterBody', 'rackHeight', 'rackBottomElevation',
  'fillLevel', 'valveType', 'volume', 'isHydraulicOnly', 'simNodeId', 'targetComponentId',
] as const;

const terrainSerial = new WeakMap<TerrainSpec, number>();
let nextTerrainSerial = 1;

/**
 * A string that changes whenever buildScene3D's output would: components
 * added, removed, moved, resized or re-shaped, ports moved, connections
 * added, removed, re-routed or re-sized, the terrain replaced. Plain field
 * reads and one join - no geometry - so it is cheap to call every frame.
 */
export function sceneSignature(plantState: PlantState): string {
  const out: string[] = [];
  for (const c of plantState.components.values()) {
    const r = c as unknown as Record<string, unknown>;
    out.push(c.id, String(c.position.x), String(c.position.y));
    for (const k of GEOMETRY_FIELDS) {
      const v = r[k];
      if (v !== undefined) out.push(k, String(v));
    }
    const pipe = c as PipeComponent;
    if (pipe.endPosition) out.push('end', String(pipe.endPosition.x), String(pipe.endPosition.y));
    if (pipe.route) for (const q of pipe.route) out.push(String(q.x), String(q.y));
    const ring = c.radiantSurface;
    if (ring) out.push('ring', String(ring.diameter), String(ring.height), String(ring.thickness), String(ring.hydraulicDiameter));
    for (const p of c.ports) out.push(p.id, String(p.position.x), String(p.position.y), p.planSide ?? '');
    out.push('|');
  }
  for (const k of plantState.connections) {
    out.push(k.fromComponentId, k.fromPortId, k.toComponentId, k.toPortId,
      String(k.fromElevation), String(k.toElevation), String(k.flowArea));
    if (k.route) for (const q of k.route) out.push(String(q.x), String(q.y));
    out.push(';');
  }
  const spec = plantState.terrain;
  if (spec) {
    let n = terrainSerial.get(spec);
    if (n === undefined) { n = nextTerrainSerial++; terrainSerial.set(spec, n); }
    out.push('terrain', String(n));
  }
  return out.join(',');
}
