/**
 * Water on the ground.
 *
 * Liquid that leaves the modelled system through a boundary node (a break
 * or a vent to atmosphere) lands on the ground under the component it came
 * from and runs to that cell's basin (see terrain.ts). A basin's water is a
 * volume: the surface it stands at comes from the basin's stage-storage
 * curve, and open ground drinks it through the wetted area at the terrain's
 * infiltration rate, so a leak makes a puddle that spreads until the ground
 * takes it as fast as it runs. Water above a basin's spill height crosses
 * into the neighbouring basin. A basin declared a water body (the sea, a
 * lake) has its surface set as a boundary condition instead - scripted by
 * scenario events (a tsunami is the sea's surface rising and falling).
 *
 * Anything whose base sits below the surface of the basin it stands in is
 * flooded. A flooded pump's motor is under water: it coasts down and cannot
 * restart until the water is gone (rate-operators.ts, PumpSpeedRateOperator).
 *
 * Two operators, the split the RK45 solver needs: the rate operator
 * integrates volumes (inflow minus infiltration); the constraint operator
 * does the bookkeeping that is not a rate - the scripted surfaces, overflow
 * across a lip, dry puddles, and the flooded flags.
 */
import { SimulationState, FlowNode } from '../types';
import { RateOperator, ConstraintOperator, StateRates, createZeroRates } from '../rk45-solver';
import { cloneSimulationState } from '../solver';
import { TerrainModel, cellAt, surfaceAtVolume, volumeAtSurface, wettedArea, DEFAULT_INFILTRATION } from '../terrain';
import { drawCompositionAt, approxLiquidDensity } from './connection-hydraulics';

/** A water body's surface: a level, or a ramp from one level to another over a scenario event. */
export interface WaterBodyState {
  basin: number;
  surface: number;
  from: number;
  to: number;
  /** Simulation time the ramp started; `over` seconds to reach `to` (0 = at once). */
  t0: number;
  over: number;
}

export interface SurfaceWaterState {
  /** Stored volume (m³) per basin that holds water (open ground only; bodies are surfaces). */
  volumes: Map<number, number>;
  bodies: Map<string, WaterBodyState>;
}

export function createSurfaceWaterState(model: TerrainModel): SurfaceWaterState {
  const bodies = new Map<string, WaterBodyState>();
  for (const b of model.basins) {
    if (b.water) {
      bodies.set(b.water.id, { basin: b.id, surface: b.water.surface, from: b.water.surface, to: b.water.surface, t0: 0, over: 0 });
    }
  }
  return { volumes: new Map(), bodies };
}

export function cloneSurfaceWaterState(sw: SurfaceWaterState): SurfaceWaterState {
  const bodies = new Map<string, WaterBodyState>();
  for (const [id, b] of sw.bodies) bodies.set(id, { ...b });
  return { volumes: new Map(sw.volumes), bodies };
}

/** Surface height (m above datum) of the water standing in a basin, or its sink height when dry. */
export function basinSurface(state: SimulationState, basinId: number): number {
  const model = state.terrain!;
  const basin = model.basins[basinId];
  if (basin.water) {
    for (const b of state.surfaceWater!.bodies.values()) {
      if (b.basin === basinId) return b.surface;
    }
  }
  return surfaceAtVolume(model, basin, state.surfaceWater!.volumes.get(basinId) ?? 0);
}

/** The water surface over a plan point, or undefined without terrain. */
export function surfaceUnder(state: SimulationState, p: { x: number; y: number }): number | undefined {
  if (!state.terrain || !state.surfaceWater) return undefined;
  const cell = cellAt(state.terrain.spec, p);
  return basinSurface(state, state.terrain.basinOf[cell]);
}

/** True when the water in the node's basin stands above the node's base. */
export function isFlooded(state: SimulationState, node: FlowNode | undefined): boolean {
  if (!node || !node.position) return false;
  const surface = surfaceUnder(state, node.position);
  return surface !== undefined && surface > node.elevation;
}

/**
 * True when the water over the pump stands above its MOTOR. The base can be
 * under water and the pump fine - a wet-pit intake pump is built that way -
 * it is the motor that must stay dry.
 */
export function isPumpDrowned(
  state: SimulationState, pump: { motorElevation: number }, node: FlowNode | undefined
): boolean {
  if (!node || !node.position) return false;
  const surface = surfaceUnder(state, node.position);
  return surface !== undefined && surface > pump.motorElevation;
}

export class SurfaceWaterRateOperator implements RateOperator {
  name = 'SurfaceWater';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();
    const model = state.terrain;
    const sw = state.surfaceWater;
    if (!model || !sw) return rates;
    const out = new Map<number, number>();
    const add = (basin: number, dV: number) => out.set(basin, (out.get(basin) ?? 0) + dV);

    // Liquid crossing into a boundary node lands on the ground under its source
    for (const conn of state.flowConnections) {
      const from = state.flowNodes.get(conn.fromNodeId);
      const to = state.flowNodes.get(conn.toNodeId);
      if (!from || !to) continue;
      let source: FlowNode | undefined;
      let mdot = 0;
      let elevation: number | undefined;
      let tolerance: number | undefined;
      let opening: number | undefined;
      if (to.isBoundary && !from.isBoundary && conn.massFlowRate > 0) {
        source = from; mdot = conn.massFlowRate;
        elevation = conn.fromElevation; tolerance = conn.fromPhaseTolerance; opening = conn.fromOpeningHeight;
      } else if (from.isBoundary && !to.isBoundary && conn.massFlowRate < 0) {
        source = to; mdot = -conn.massFlowRate;
        elevation = conn.toElevation; tolerance = conn.toPhaseTolerance; opening = conn.toOpeningHeight;
      }
      if (!source || !source.position || mdot <= 0) continue;
      // Mass share of the draw that is liquid (vapor rises away)
      const draw = drawCompositionAt(source, elevation, conn.massFlowRate, tolerance, opening, undefined, false);
      const liquidShare = draw.wLiquid + draw.wMixture * (1 - Math.max(0, Math.min(1, source.fluid.quality ?? 0)));
      if (liquidShare <= 0) continue;
      const cell = cellAt(model.spec, source.position);
      add(model.basinOf[cell], mdot * liquidShare / approxLiquidDensity(source));
    }

    // Open ground drinks every puddle through its wetted area
    const k = model.spec.infiltration ?? DEFAULT_INFILTRATION;
    for (const [basinId, volume] of sw.volumes) {
      if (volume <= 0) continue;
      const basin = model.basins[basinId];
      if (basin.water) continue;
      const area = wettedArea(model, basin, surfaceAtVolume(model, basin, volume));
      add(basinId, -k * area);
    }

    if (out.size > 0) rates.surfaceWater = out;
    return rates;
  }
}

export class SurfaceWaterConstraintOperator implements ConstraintOperator {
  name = 'SurfaceWater';

  applyConstraints(state: SimulationState): SimulationState {
    return this.applyImpl(cloneSimulationState(state));
  }

  applyConstraintsMutating(state: SimulationState): SimulationState {
    return this.applyImpl(state);
  }

  private applyImpl(state: SimulationState): SimulationState {
    const model = state.terrain;
    const sw = state.surfaceWater;
    if (!model || !sw) return state;

    // Scripted surfaces (a tsunami: the sea rises over `over` seconds, then falls the same way)
    for (const b of sw.bodies.values()) {
      const f = b.over > 0 ? Math.max(0, Math.min(1, (state.time - b.t0) / b.over)) : 1;
      b.surface = b.from + (b.to - b.from) * f;
    }

    // Dry puddles: infiltration integrated past empty leaves nothing on the ground
    for (const [basinId, volume] of sw.volumes) {
      if (!(volume > 0)) sw.volumes.delete(basinId);
    }

    // Overflow: water above a basin's lip crosses to the neighbour it spills
    // into (and vanishes into a water body). Repeat while anything moves -
    // a chain of basins passes it along; bounded by the number of basins.
    for (let pass = 0; pass < model.basins.length + 1; pass++) {
      let moved = false;
      for (const [basinId, volume] of sw.volumes) {
        const basin = model.basins[basinId];
        if (basin.water || basin.spillTo < 0 || !Number.isFinite(basin.spillHeight)) continue;
        const capacity = volumeAtSurface(model, basin, basin.spillHeight);
        if (volume <= capacity) continue;
        const excess = volume - capacity;
        sw.volumes.set(basinId, capacity);
        const target = model.basins[basin.spillTo];
        if (!target.water) sw.volumes.set(target.id, (sw.volumes.get(target.id) ?? 0) + excess);
        moved = true;
      }
      if (!moved) break;
    }

    // Whose motor is under water
    for (const [id, pump] of state.components.pumps) {
      pump.flooded = isPumpDrowned(state, pump, state.flowNodes.get(id));
    }
    return state;
  }
}
