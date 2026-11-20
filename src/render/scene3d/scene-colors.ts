/**
 * Live colours for the 3D view's parts, resolved every frame from the
 * simulation - the same colours the 2.5D view paints for the same state:
 *  - a flow node: getFluidColor of the node's fluid, labelled the way the
 *    per-frame sync labels a component's fluid (volume, vapour space, steam
 *    partial); the shell's wall metal, when hot enough to glow, shows
 *    through as it does on a 2.5D pipe run (hotRunBody).
 *  - a connection: the fluid of its donor end - the end whose fluid the
 *    line is FULL of (display-flow.ts plug-flow ledger), with a separated
 *    two-phase donor giving the phase at that nozzle - exactly as canvas.ts
 *    getConnectionFluid picks it. Runs carry no wall glow (the 2.5D runs do
 *    not either).
 *  - fuel: getFuelColor of the fuel temperature; a pool's racks
 *    poolRackColor of the cladding temperature.
 * With no simulation (construction mode) the component's own display fluid
 * and temperatures are used, as the 2.5D view does then.
 */
import type { Fluid, PlantComponent, PlantState, ReactorVesselComponent } from '../../types';
import type { SimulationState, FlowConnection, FlowNode } from '../../simulation';
import { getFluidColor, getFuelColor, COLORS } from '../colors';
import { hotRunBody, incandescentIntensity, parseColor } from '../incandescence';
import { poolRackColor } from '../components';
import { PipeContentsTracker } from '../display-flow';
import { flowPhaseAt } from '../../simulation/operators/connection-hydraulics';
import { nodeGasVolume } from '../../simulation/mixture-properties';
import { steamPartialPressurePa } from '../../simulation/resume';
import type { Scene3DModel, PartColor } from './types';

/** Which end each line is full of. Display state only, advanced on every call. */
const tracker = new PipeContentsTracker();

/** Flow connections by id, rebuilt when the simulation's list changes. */
let flowIndex: { list: FlowConnection[]; length: number; byId: Map<string, FlowConnection> } | null = null;

function flowById(sim: SimulationState): Map<string, FlowConnection> {
  if (!flowIndex || flowIndex.list !== sim.flowConnections || flowIndex.length !== sim.flowConnections.length) {
    flowIndex = {
      list: sim.flowConnections,
      length: sim.flowConnections.length,
      byId: new Map(sim.flowConnections.map(f => [f.id, f])),
    };
  }
  return flowIndex.byId;
}

const missing = new Set<string>();
function warnMissing(key: string, what: string): void {
  if (missing.has(key)) return;
  missing.add(key);
  console.error(`[scene3d colours] ${what} - the part keeps its resting colour`);
}

/** A node's fluid labelled for getFluidColor (canvas.ts getConnectionFluid). */
function nodeFluid(node: FlowNode): Fluid {
  return {
    ...node.fluid,
    volume: node.volume,
    gasVolume: nodeGasVolume(node),
    steamPressure: steamPartialPressurePa(node),
    flowRate: 0,
  };
}

/** The display fluid a component carries for one of its nodes (construction mode). */
function displayFluid(c: PlantComponent, nodeId: string): Fluid | undefined {
  const r = c as unknown as Record<string, Fluid | Fluid[] | undefined>;
  if (c.type === 'heatExchanger') {
    if (nodeId.endsWith('-shell')) return r.secondaryFluid as Fluid | undefined;
    const m = /-tube-b(\d+)$/.exec(nodeId);
    if (m) return (r.bundleFluids as Fluid[] | undefined)?.[Number(m[1]) - 1] ?? r.primaryFluid as Fluid | undefined;
    return r.primaryFluid as Fluid | undefined;
  }
  if (c.type === 'crossVessel' && nodeId.endsWith('-annulus')) return (r.annulusFluid ?? c.fluid) as Fluid | undefined;
  if (c.type === 'turbine-generator' || c.type === 'turbine-driven-pump') return (r.inletFluid ?? c.fluid) as Fluid | undefined;
  return c.fluid;
}

/** Wall metal temperature behind a component's shell, K (undefined: no metal node). */
function wallTemperature(c: PlantComponent | undefined, nodeId: string, sim: SimulationState | null): number | undefined {
  if (!c || c.type === 'building') return undefined;   // concrete keeps its own colouring
  const metalId = c.type === 'crossVessel' && nodeId.endsWith('-annulus') ? `${c.id}-shell-wall` : `${c.id}-wall`;
  if (sim) return sim.thermalNodes.get(metalId)?.temperature;
  return c.type === 'crossVessel' && nodeId.endsWith('-annulus')
    ? (c as { outerShellTemperature?: number }).outerShellTemperature
    : c.wallTemperature;
}

/** Fuel (or pool rack cladding) temperature of a component, K. */
function fuelTemperature(c: PlantComponent | undefined, componentId: string, plant: PlantState,
                         sim: SimulationState | null): number | undefined {
  if (c?.type === 'pool') {
    return sim ? sim.thermalNodes.get(`${componentId}-clad`)?.temperature
      : (c as { rackTemperature?: number }).rackTemperature;
  }
  if (!sim) return (c as { fuelTemperature?: number } | undefined)?.fuelTemperature;
  const own = sim.thermalNodes.get(`${componentId}-fuel`);
  if (own) return own.temperature;
  // A core barrel's fuel node is named after the reactor vessel holding it (main.ts sync)
  for (const v of plant.components.values()) {
    if (v.type === 'reactorVessel' && (v as ReactorVesselComponent).coreBarrelId === componentId) {
      return sim.thermalNodes.get(`${v.id}-fuel`)?.temperature;
    }
  }
  return undefined;
}

function toPartColor(css: string, glow: number): PartColor {
  const c = parseColor(css);
  return { r: c.r / 255, g: c.g / 255, b: c.b / 255, glow };
}

export function partColors(model: Scene3DModel, plantState: PlantState, simState: SimulationState | null): Map<string, PartColor> {
  const out = new Map<string, PartColor>();
  if (simState) tracker.update(simState);
  const flows = simState ? flowById(simState) : null;

  for (const part of model.parts) {
    const src = part.color;
    if (!src) continue;
    const comp = part.componentId ? plantState.components.get(part.componentId) : undefined;

    if (src.kind === 'flowNode') {
      let fluid: Fluid | undefined;
      if (simState) {
        const node = simState.flowNodes.get(src.nodeId);
        if (!node) { warnMissing(`node:${src.nodeId}`, `part ${part.id}: no flow node '${src.nodeId}'`); continue; }
        fluid = nodeFluid(node);
      } else {
        fluid = comp ? displayFluid(comp, src.nodeId) : undefined;
        if (!fluid) continue;
      }
      const css = getFluidColor(fluid);
      const T = wallTemperature(comp, src.nodeId, simState);
      out.set(part.id, T === undefined
        ? toPartColor(css, 0)
        : toPartColor(hotRunBody(css, COLORS.steel, T), incandescentIntensity(T)));
      continue;
    }

    if (src.kind === 'connection') {
      let fluid: Fluid | undefined;
      if (simState && flows) {
        const flow = flows.get(src.connectionId);
        if (!flow) { warnMissing(`flow:${src.connectionId}`, `part ${part.id}: no flow connection '${src.connectionId}'`); continue; }
        const forward = tracker.donorEnd(flow) === 'from';
        const donor = simState.flowNodes.get(forward ? flow.fromNodeId : flow.toNodeId);
        if (!donor) { warnMissing(`donor:${flow.id}`, `part ${part.id}: flow connection ${flow.id} has no donor node`); continue; }
        fluid = nodeFluid(donor);
        fluid.flowRate = flow.massFlowRate;
        if (fluid.phase === 'two-phase') {
          const phase = flowPhaseAt(donor, forward ? flow.fromElevation : flow.toElevation, flow.massFlowRate);
          if (phase === 'liquid') { fluid.phase = 'liquid'; fluid.quality = 0; }
          else if (phase === 'vapor') { fluid.phase = 'vapor'; fluid.quality = 1; }
        }
      } else {
        // Construction mode: the from component's own fluid (canvas.ts getConnectionFluid)
        const key = part.connectionKey;
        const fromId = key ? key.slice(0, key.indexOf(':')) : undefined;
        fluid = fromId ? plantState.components.get(fromId)?.fluid : undefined;
        if (!fluid) continue;
      }
      out.set(part.id, toPartColor(getFluidColor(fluid), 0));
      continue;
    }

    // Fuel
    const fuelComp = plantState.components.get(src.componentId);
    const T = fuelTemperature(fuelComp, src.componentId, plantState, simState);
    if (T === undefined) {
      if (simState) warnMissing(`fuel:${src.componentId}`, `part ${part.id}: no fuel temperature for ${src.componentId}`);
      continue;
    }
    if (fuelComp?.type === 'pool') {
      const c = poolRackColor(T);
      out.set(part.id, { r: c.r / 255, g: c.g / 255, b: c.b / 255, glow: incandescentIntensity(T) });
    } else {
      out.set(part.id, toPartColor(getFuelColor(T), incandescentIntensity(T)));
    }
  }
  return out;
}
