/**
 * PebbleSpillRateOperator - pebbles draining out of a pebble bed through a
 * break, and the heap they make where they land.
 *
 * WHERE PEBBLES CAN GET OUT. A pebble bed sits on a bottom reflector with a
 * discharge (defuel) chute running from the bottom of the bed down through
 * every boundary below it. Two kinds of break let pebbles out:
 *   - a hole in the bed's OWN boundary (the core barrel) at any height: the
 *     pebbles above the hole run out through it, and the bed's surface
 *     falls toward the hole;
 *   - a hole in an ENCLOSING vessel at or below the bottom of the bed: that
 *     severs the chute, and the bed drains through the vessel's opening.
 * A break higher up an enclosing vessel lets gas out but no pebbles - the
 * barrel is still in the way. The pebbles land in whatever region the
 * break opens into (the break connection's target), on a heap of their own.
 *
 * HOW FAST. Granular discharge through an orifice does not depend on the
 * head of material above it (the bed arches and carries its own weight on
 * the walls), and follows the Beverloo law:
 *
 *   W = C rho_bulk sqrt(g) (D_o - k d)^(5/2)       C = 0.58, k = 1.5
 *
 * (Beverloo, Leniger & van de Velde 1961; Nedderman, "Statics and
 * Kinematics of Granular Materials", 1992, ch. 10 - C 0.55-0.65 and k
 * 1.3-1.6 for spheres). It goes to zero continuously as the orifice closes
 * down to ~1.5 pebble diameters, so a ~60 mm nozzle break passes gas but
 * not 60 mm pebbles, which is the jamming every pebble-bed designer relies
 * on. The flow stops when the pebbles above the hole run out: it is scaled
 * by movable/(movable + rho_bulk D_o^3), the last term being the mass of
 * the flowing zone just above the orifice - with less than that left, the
 * hopper is no longer full enough for Beverloo to hold.
 *
 * BOOKKEEPING. Pebbles leave as whole pebbles: kernel and matrix mass go in
 * the bed's own proportion, each at its node's temperature, and the
 * matrix's graphite burn-off rides along with it. Fission-product inventory
 * stays booked on the core's kernel node (FissionProductReleaseOperator and
 * HeatGeneration share it out over the bed and the heaps by kernel mass,
 * via meltLocations) - so spilled kernels keep their decay heat and outgas
 * into the room they are in. Neutronics reads the fuel that has left as
 * relocated fuel (shutdown worth), and the bed's heat paths shrink with the
 * pebbles still in it (scaleWithMassOf).
 *
 * THE HEAP. A cone of loose pebbles at their angle of repose, lumped into a
 * matrix node and a kernel node. Heat leaves through two resistances in
 * series:
 *   - inside the heap, the packed-bed effective conductivity (the same
 *     Zehner-Schlunder + radiation correlation the core's bed uses, with
 *     the room's gas in the voids), average-to-surface as for a heated
 *     sphere: R = L/(5 k_eff A), L = 3V/A;
 *   - at the surface, the room fluid's own natural-convection (or
 *     condensation / liquid) coefficient plus gray-body radiation to the
 *     room, which a lumped room can only represent by its fluid
 *     temperature.
 * A big heap is limited by the first: decay heat in a few tens of tonnes of
 * pebbles cannot get out through the pile fast enough, which is why a
 * spilled core in air heats up - and starts to burn
 * (GraphiteOxidationRateOperator, against the room's oxygen).
 *
 * NOT MODELLED (on the todo list): the bed's coolant volume growing as it
 * drains (the flow node's volume is fixed); the heap's contact with the
 * floor; TRISO particle damage at the heap's own temperature (the particle
 * damage integral belongs to the core's kernels, and spilled particles share
 * it); room volume taken up by the heap.
 */

import { SimulationState, ConvectionConnection } from '../types';
import { RateOperator, StateRates, createZeroRates, ThermalNodeRates } from '../rk45-solver';
import { nodeHeatCapacity, vaporWallHeatTransfer, liquidWallHeatTransfer, pieceFraction } from './rate-operators';
import { nodeLiquidLevel } from './control-system';
import {
  A3_3, bedEffectiveConductivity, graphiteThermalConductivity, graphiteSpecificHeat,
} from '../graphite';
import { mixtureThermalConductivity } from '../gas-properties';

/** Void fraction of a randomly packed bed of spheres. */
export const PEBBLE_BED_VOID_FRACTION = 0.39;

const BEVERLOO_C = 0.58;
const BEVERLOO_K = 1.5;
const G = 9.81;
/** Angle of repose of a heap of graphite spheres (smooth spheres pile at
 *  ~22-25 degrees). Sets how tall and how wide a heap of a given mass is. */
const REPOSE_ANGLE = 25 * Math.PI / 180;
const SIGMA_SB = 5.670374419e-8;

/**
 * Beverloo discharge (kg/s) of a granular bed through a round orifice.
 * Exported for direct testing.
 */
export function beverlooMassFlow(
  bulkDensity: number, orificeDiameter: number, particleDiameter: number,
): number {
  const free = orificeDiameter - BEVERLOO_K * particleDiameter;
  if (!(free > 0)) return 0;
  return BEVERLOO_C * bulkDensity * Math.sqrt(G) * Math.pow(free, 2.5);
}

/**
 * A cone of loose pebbles at the angle of repose. Exported for testing and
 * display.
 */
export function heapGeometry(mass: number, bulkDensity: number): {
  volume: number; radius: number; height: number; area: number;
} {
  const volume = mass / bulkDensity;
  const tanA = Math.tan(REPOSE_ANGLE);
  const radius = Math.cbrt(3 * volume / (Math.PI * tanA));
  const height = radius * tanA;
  const area = Math.PI * radius * radius / Math.cos(REPOSE_ANGLE);
  return { volume, radius, height, area };
}

export class PebbleSpillRateOperator implements RateOperator {
  name = 'PebbleSpill';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();
    const addT = (id: string, f: (r: ThermalNodeRates) => void) => {
      const r = rates.thermalNodes.get(id) || { dTemperature: 0 };
      f(r);
      rates.thermalNodes.set(id, r);
    };

    // ------------------------------------------------------------------
    // Drain: every pebble bed, every open break that can let pebbles out
    // ------------------------------------------------------------------
    for (const [, bedNode] of state.thermalNodes) {
      const bed = bedNode.pebbleBed;
      if (!bed) continue;
      const fuel = state.thermalNodes.get(bed.fuelNodeId);
      if (!fuel || !(bedNode.initialMass && bedNode.initialMass > 0)) {
        throw new Error(`[PebbleSpill] bed '${bedNode.id}': kernel node '${bed.fuelNodeId}' ` +
          `missing or no as-built mass - factory wiring is broken`);
      }
      const pebbleMass = bedNode.mass + fuel.mass;
      if (!(pebbleMass > 0)) continue;
      const bedTop = bed.bedBottomElevation + bed.bedHeight * pieceFraction(bedNode);

      for (const bs of state.burstStates?.values() ?? []) {
        if (!bs.isBurst) continue;
        const k = bed.boundaryNodeIds.indexOf(bs.nodeId);
        if (k < 0) continue;
        const conn = state.flowConnections.find(c => c.id === `break-${bs.nodeId}`);
        if (!conn || !(conn.flowArea > 0)) continue;
        const holeElevation = bs.breakElevation ?? state.flowNodes.get(bs.nodeId)?.elevation ?? 0;
        // An enclosing vessel lets pebbles out only by severing the chute
        if (k > 0 && holeElevation > bed.bedBottomElevation) continue;
        const above = bedTop - Math.max(holeElevation, bed.bedBottomElevation);
        if (!(above > 0)) continue;
        const movable = pebbleMass * above / (bedTop - bed.bedBottomElevation);

        const orifice = Math.sqrt(4 * conn.flowArea / Math.PI);
        const W0 = beverlooMassFlow(bed.bulkDensity, orifice, bed.pebbleDiameter);
        if (!(W0 > 0)) continue;
        const flowingZone = bed.bulkDensity * orifice * orifice * orifice;
        const W = W0 * movable / (movable + flowingZone);

        const heap = bed.heaps.find(h => h.regionNodeId === conn.toNodeId);
        if (!heap) {
          throw new Error(`[PebbleSpill] bed '${bedNode.id}' drains through '${conn.id}' into ` +
            `'${conn.toNodeId}', which has no pebble heap - the factory builds one for each ` +
            `region outside the bed's boundaries (${bed.heaps.map(h => h.regionNodeId).join(', ')})`);
        }
        const heapMatrix = state.thermalNodes.get(heap.matrixNodeId);
        const heapFuel = state.thermalNodes.get(heap.fuelNodeId);
        if (!heapMatrix || !heapFuel) {
          throw new Error(`[PebbleSpill] heap nodes for '${heap.regionNodeId}' are missing`);
        }

        const wMatrix = W * bedNode.mass / pebbleMass;
        const wFuel = W - wMatrix;
        addT(bedNode.id, r => { r.dMass = (r.dMass ?? 0) - wMatrix; });
        addT(fuel.id, r => { r.dMass = (r.dMass ?? 0) - wFuel; });

        // Arriving pebbles mix their heat into the heap (graphite cp at the
        // mean of the two temperatures - it varies ~3x over the range)
        const cpMatrix = graphiteSpecificHeat(0.5 * (bedNode.temperature + heapMatrix.temperature));
        addT(heapMatrix.id, r => {
          r.dMass = (r.dMass ?? 0) + wMatrix;
          r.dTemperature += wMatrix * cpMatrix * (bedNode.temperature - heapMatrix.temperature) /
            nodeHeatCapacity(heapMatrix);
          // Burn-off is per pebble: arrivals carry the bed's. Mixed by
          // pebble COUNT - a burned pebble is lighter, not fewer.
          const bBed = bedNode.graphiteOxidation?.burnoff ?? 0;
          const bHeap = heapMatrix.graphiteOxidation?.burnoff ?? 0;
          r.dGraphiteBurnoff = (r.dGraphiteBurnoff ?? 0) +
            wMatrix * (1 - bHeap) / (heapMatrix.mass * (1 - bBed)) * (bBed - bHeap);
        });
        addT(heapFuel.id, r => {
          r.dMass = (r.dMass ?? 0) + wFuel;
          r.dTemperature += wFuel * fuel.specificHeat * (fuel.temperature - heapFuel.temperature) /
            nodeHeatCapacity(heapFuel);
        });
      }
    }

    // ------------------------------------------------------------------
    // Heaps: cooling from the pile to the room
    // ------------------------------------------------------------------
    for (const [, heap] of state.thermalNodes) {
      const cfg = heap.pebbleHeap;
      if (!cfg) continue;
      const region = state.flowNodes.get(cfg.regionNodeId);
      const heapFuel = state.thermalNodes.get(cfg.fuelNodeId);
      const source = state.thermalNodes.get(cfg.sourceMatrixNodeId)?.pebbleBed;
      if (!region || !heapFuel || !source) {
        throw new Error(`[PebbleSpill] heap '${heap.id}': region, kernel node or source bed missing`);
      }
      const ncg = region.fluid.ncg;
      if (!ncg) {
        throw new Error(`[PebbleSpill] heap '${heap.id}' sits in '${region.id}', which carries no ` +
          `gas inventory - the heap's void conductivity is undefined (a pebble heap is only ` +
          `wired for gas-filled rooms and vessels)`);
      }
      const geo = heapGeometry(heap.mass + heapFuel.mass, source.bulkDensity);
      const T = heap.temperature;
      const Tf = region.fluid.temperature;

      // Inside the pile
      const kEff = bedEffectiveConductivity(
        mixtureThermalConductivity(ncg, 0.5 * (T + Tf)),
        graphiteThermalConductivity(T, A3_3),
        PEBBLE_BED_VOID_FRACTION, T, source.pebbleDiameter, A3_3.emissivity);
      const L = 3 * geo.volume / geo.area;
      const rInside = L / (5 * kEff * geo.area);

      // At its surface: the part standing in water (if the room holds any)
      // and the part in gas
      const wet = region.fluid.phase === 'vapor'
        ? 0
        : Math.min(1, nodeLiquidLevel(region) / geo.height);
      const D = 2 * geo.radius;
      let hA = 0;
      if (wet < 1) {
        const hGas = vaporWallHeatTransfer(region, state, D, T).total;
        const hRad = A3_3.emissivity * SIGMA_SB * (T + Tf) * (T * T + Tf * Tf);
        hA += (1 - wet) * geo.area * (hGas + hRad);
      }
      if (wet > 0) {
        const surface: ConvectionConnection = {
          id: `heap-${heap.id}`, thermalNodeId: heap.id, flowNodeId: region.id,
          surfaceArea: geo.area,
        };
        hA += wet * geo.area * liquidWallHeatTransfer(region, state, surface, D).total;
      }
      if (!(hA > 0)) continue;

      const Q = (T - Tf) / (rInside + 1 / hA);
      addT(heap.id, r => { r.dTemperature -= Q / nodeHeatCapacity(heap); });
      const fr = rates.flowNodes.get(region.id) || { dMass: 0, dEnergy: 0 };
      fr.dEnergy += Q;
      rates.flowNodes.set(region.id, fr);
    }

    return rates;
  }
}

/**
 * Spilled pebbles out of a bed (kg, kernels + matrix) and where they are,
 * for displays and scenario reports.
 */
export function pebbleSpillSummary(state: SimulationState, bedMatrixId: string): {
  spilledFraction: number;
  heaps: Array<{ regionNodeId: string; mass: number; temperature: number; burnoff: number }>;
} {
  const bedNode = state.thermalNodes.get(bedMatrixId);
  const bed = bedNode?.pebbleBed;
  if (!bedNode || !bed || !bedNode.initialMass) return { spilledFraction: 0, heaps: [] };
  return {
    spilledFraction: 1 - pieceFraction(bedNode),
    heaps: bed.heaps.map(h => {
      const m = state.thermalNodes.get(h.matrixNodeId)!;
      const f = state.thermalNodes.get(h.fuelNodeId)!;
      return {
        regionNodeId: h.regionNodeId,
        mass: m.mass + f.mass,
        temperature: m.temperature,
        burnoff: m.graphiteOxidation?.burnoff ?? 0,
      };
    }),
  };
}
