/**
 * CoriumRelocationRateOperator - molten fuel/clad slumping to the lower head.
 *
 * When the apparent-heat-capacity melt model says a fuel or clad node is
 * partially molten, mass "candles" down into the `${coreId}-corium` melt
 * pool created by the factory (rod cores in a vessel only). Continuous
 * rates, no thresholds beyond the physical onset of relocation:
 *
 *   dm/dt = (m - m_residual) * max(0, meltFraction - ONSET)^2 / TAU
 *
 * - ONSET 0.1: candling starts once a real molten fraction exists (liquefied
 *   material must wet and flow; the quadratic keeps the onset smooth).
 * - TAU 600 s: relocation over minutes at full melt (TMI-2 scale).
 * - m_residual = 1% of as-built mass: grid/structure stubs that never leave.
 *
 * Bookkeeping:
 * - Mass leaves the fuel/clad node at that node's temperature (energy rides
 *   with mass; a uniform node's temperature is unchanged by mass leaving,
 *   so only dMass is needed on the source).
 * - The corium node mixes the arriving mass in: dT = sum(r_i*cp_i*(T_i-T))
 *   / C_eff(corium), with C_eff from nodeHeatCapacity so the pool's own
 *   melting plateau participates.
 * - Fission-product INVENTORY stays booked on the fuel node (per-node
 *   initial-inventory fractions keep meaning); FissionProductReleaseOperator
 *   evaluates the release temperature as max(fuel, corium) so relocated
 *   melt keeps outgassing. Decay heat splits by mass between fuel and
 *   corium in HeatGenerationRateOperator.
 * - Neutronics: relocated fuel has left the lattice; a shutdown-scale
 *   negative reactivity proportional to the relocated fraction is applied
 *   in the reactivity sum (recriticality of a reflooded debris bed is real
 *   physics but out of scope; flagged in the code there).
 *
 * EX-VESSEL RELOCATION (vessel breach): the lower head has real melting
 * data; when the pool's attack melts it (meltFraction > onset), two more
 * candling flows open with the same law:
 *   - molten head steel drains into `${coreId}-corium-ex` (the ex-vessel
 *     debris bed on the containment floor), carrying its mass as
 *     unoxidized Fe (MCCI oxidation feedstock);
 *   - the pool itself pours through the growing hole (TAU_POUR ~ minutes -
 *     a gravity drain, much faster than in-core candling).
 * The melted-away head fraction doubles as the breach hole size for the
 * vessel's fluid break (BurstCheckOperator reads it). Concrete attack by
 * the ex-vessel debris lives in McciRateOperator.
 *
 * METAL BOOKKEEPING: relocating clad carries its unoxidized Zr fraction
 * into the pool's `metal` inventory; the pour moves metal (and any slag)
 * in proportion to the mass leaving. Fuel-oxide content stays derived
 * (mass - metal - slag), so composition can't drift from the total.
 *
 * NOT modeled (tracked on the todo list): flow-channel blockage, molten
 * pool natural-convection focusing.
 */

import { SimulationState } from '../types';
import { RateOperator, StateRates, createZeroRates, ThermalNodeRates } from '../rk45-solver';
import { meltFraction, nodeHeatCapacity } from './rate-operators';
import { nodeLiquidLevel } from './control-system';

export class CoriumRelocationRateOperator implements RateOperator {
  name = 'CoriumRelocation';

  private static readonly ONSET = 0.1;
  private static readonly TAU = 600;        // s
  private static readonly RESIDUAL = 0.01;  // fraction of as-built mass
  /** Pour time constant once the head is open: a gravity drain of a molten
   *  pool through a growing hole - minutes, not the 10-minute candle. */
  private static readonly TAU_POUR = 120;   // s

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const [coriumId, corium] of state.thermalNodes) {
      if (!coriumId.endsWith('-corium')) continue;
      const coreId = coriumId.slice(0, -'-corium'.length);

      let totalIn = 0;      // kg/s
      let zrIn = 0;         // kg/s of unoxidized Zr riding with the clad
      let mixingPower = 0;  // W of sensible heat carried relative to corium T

      for (const suffix of ['-fuel', '-clad']) {
        const source = state.thermalNodes.get(`${coreId}${suffix}`);
        if (!source) continue;
        const melt = meltFraction(source);
        if (melt <= CoriumRelocationRateOperator.ONSET) continue;

        const m0 = source.initialMass ?? source.mass;
        const movable = source.mass - CoriumRelocationRateOperator.RESIDUAL * m0;
        if (movable <= 0) continue;

        const driver = Math.pow(melt - CoriumRelocationRateOperator.ONSET, 2);
        const r = movable * driver / CoriumRelocationRateOperator.TAU;
        if (r <= 0) continue;

        const srcRates: ThermalNodeRates =
          rates.thermalNodes.get(source.id) || { dTemperature: 0 };
        srcRates.dMass = (srcRates.dMass ?? 0) - r;
        rates.thermalNodes.set(source.id, srcRates);

        totalIn += r;
        // Relocating clad carries its unoxidized Zr along (the oxidized
        // fraction is ZrO2 - already spent as an MCCI reductant)
        if (suffix === '-clad' && source.oxidation) {
          zrIn += r * Math.max(0, 1 - source.oxidation.oxidizedFraction);
        }
        mixingPower += r * source.specificHeat * (source.temperature - corium.temperature);
      }

      if (totalIn > 0) {
        const corRates: ThermalNodeRates =
          rates.thermalNodes.get(coriumId) || { dTemperature: 0 };
        corRates.dMass = (corRates.dMass ?? 0) + totalIn;
        if (zrIn > 0) corRates.dMetalZr = (corRates.dMetalZr ?? 0) + zrIn;
        corRates.dTemperature += mixingPower / nodeHeatCapacity(corium);
        rates.thermalNodes.set(coriumId, corRates);
      }

      // ----------------------------------------------------------------
      // Pool heat transfer, with MASS-SCALED contact area: the pool's
      // footprint grows linearly with inventory until it is ~5 cm deep
      // over the full head (a static full-area coupling on the 1 kg seed
      // node gave it a ~60 ms time constant that throttled the solver).
      // ----------------------------------------------------------------
      if (corium.mass > 1.5) {
        const poolArea = corium.surfaceArea; // full-head footprint (factory)
        const depthIfSpread = corium.mass / (CORIUM_DENSITY * poolArea);
        const contact = poolArea * Math.min(1, depthIfSpread / SPREAD_DEPTH);
        if (contact > 0) {
          // Crust-limited pool -> lower head conduction (~1 MW/m2 at a
          // 2000 K pool-to-wall difference, in-vessel-retention scale)
          const vesselId = corium.associatedVesselNode;
          const head = vesselId ? state.thermalNodes.get(`${vesselId}-lowerhead`) : undefined;
          if (head) {
            const Q = 500 * contact * (corium.temperature - head.temperature);
            const corRates = rates.thermalNodes.get(coriumId) || { dTemperature: 0 };
            corRates.dTemperature -= Q / nodeHeatCapacity(corium);
            rates.thermalNodes.set(coriumId, corRates);
            const headRates = rates.thermalNodes.get(head.id) || { dTemperature: 0 };
            headRates.dTemperature += Q / nodeHeatCapacity(head);
            rates.thermalNodes.set(head.id, headRates);
          }

          // Quench to the vessel water while any covers the pool. h is
          // crust-limited (debris-bed scale, deliberately on the slow side
          // - violent fuel-coolant interaction is not modeled).
          const vesselNode = vesselId ? state.flowNodes.get(vesselId) : undefined;
          if (vesselNode && vesselNode.fluid.phase !== 'vapor') {
            const level = nodeLiquidLevel(vesselNode);
            const wet = Math.min(1, level / 0.3);
            if (wet > 0 && corium.temperature > vesselNode.fluid.temperature) {
              const Q = 500 * contact * wet *
                (corium.temperature - vesselNode.fluid.temperature);
              const corRates = rates.thermalNodes.get(coriumId) || { dTemperature: 0 };
              corRates.dTemperature -= Q / nodeHeatCapacity(corium);
              rates.thermalNodes.set(coriumId, corRates);
              const flowRates = rates.flowNodes.get(vesselId!) || { dMass: 0, dEnergy: 0 };
              flowRates.dEnergy += Q;
              rates.flowNodes.set(vesselId!, flowRates);
            }
          }
        }
      }

      // ----------------------------------------------------------------
      // Vessel breach: the pool's attack melts the lower head. Molten
      // head steel candles out with the melt (as unoxidized Fe) and the
      // pool pours through the growing hole into the ex-vessel debris
      // bed - the same smooth candling law, with a fast pour time
      // constant. The melted-away head fraction is also the vessel's
      // fluid breach size (BurstCheckOperator reads it).
      // ----------------------------------------------------------------
      const debris = state.thermalNodes.get(`${coreId}-corium-ex`);
      const headNode = corium.associatedVesselNode
        ? state.thermalNodes.get(`${corium.associatedVesselNode}-lowerhead`)
        : undefined;
      if (debris && headNode) {
        const headMelt = meltFraction(headNode);
        if (headMelt > CoriumRelocationRateOperator.ONSET) {
          const driver = Math.pow(headMelt - CoriumRelocationRateOperator.ONSET, 2);
          let poured = 0;      // kg/s arriving at the debris bed
          let zrFlow = 0, feFlow = 0, slagFlow = 0;
          let mixPower = 0;    // W of sensible heat relative to debris T

          // Molten head steel drains out with the melt
          const headM0 = headNode.initialMass ?? headNode.mass;
          const movableSteel = headNode.mass - CoriumRelocationRateOperator.RESIDUAL * headM0;
          if (movableSteel > 0) {
            const rSteel = movableSteel * driver / CoriumRelocationRateOperator.TAU;
            const headRates = rates.thermalNodes.get(headNode.id) || { dTemperature: 0 };
            headRates.dMass = (headRates.dMass ?? 0) - rSteel;
            rates.thermalNodes.set(headNode.id, headRates);
            poured += rSteel;
            feFlow += rSteel;
            mixPower += rSteel * headNode.specificHeat * (headNode.temperature - debris.temperature);
          }

          // The pool pours through the hole (gravity drain, down to the
          // seed mass - a fully drained node breaks dT/dt)
          const movablePool = corium.mass - (corium.initialMass ?? 1);
          if (movablePool > 0) {
            const rPour = movablePool * driver / CoriumRelocationRateOperator.TAU_POUR;
            const zrOut = rPour * (corium.metal?.zr ?? 0) / corium.mass;
            const feOut = rPour * (corium.metal?.fe ?? 0) / corium.mass;
            const slagOut = rPour * (corium.slagMass ?? 0) / corium.mass;
            const corRates = rates.thermalNodes.get(coriumId) || { dTemperature: 0 };
            corRates.dMass = (corRates.dMass ?? 0) - rPour;
            if (zrOut > 0) corRates.dMetalZr = (corRates.dMetalZr ?? 0) - zrOut;
            if (feOut > 0) corRates.dMetalFe = (corRates.dMetalFe ?? 0) - feOut;
            if (slagOut > 0) corRates.dSlag = (corRates.dSlag ?? 0) - slagOut;
            rates.thermalNodes.set(coriumId, corRates);
            poured += rPour;
            zrFlow += zrOut;
            feFlow += feOut;
            slagFlow += slagOut;
            mixPower += rPour * corium.specificHeat * (corium.temperature - debris.temperature);
          }

          if (poured > 0) {
            const debRates = rates.thermalNodes.get(debris.id) || { dTemperature: 0 };
            debRates.dMass = (debRates.dMass ?? 0) + poured;
            if (zrFlow > 0) debRates.dMetalZr = (debRates.dMetalZr ?? 0) + zrFlow;
            if (feFlow > 0) debRates.dMetalFe = (debRates.dMetalFe ?? 0) + feFlow;
            if (slagFlow > 0) debRates.dSlag = (debRates.dSlag ?? 0) + slagFlow;
            debRates.dTemperature += mixPower / nodeHeatCapacity(debris);
            rates.thermalNodes.set(debris.id, debRates);
          }
        }
      }
    }

    return rates;
  }
}

const CORIUM_DENSITY = 8000;  // kg/m3 - UO2/Zr melt
const SPREAD_DEPTH = 0.05;    // m - depth at which the pool wets the full head

/**
 * Relocated-fuel fraction for a core (0 = intact, 1 = everything movable
 * has left). Used by neutronics (shutdown reactivity) and displays.
 */
export function relocatedFuelFraction(state: SimulationState, coreId: string): number {
  const fuel = state.thermalNodes.get(`${coreId}-fuel`);
  if (!fuel || !fuel.initialMass || fuel.initialMass <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - fuel.mass / fuel.initialMass));
}
