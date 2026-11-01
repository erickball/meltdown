/**
 * Graphite Oxidation Rate Operator - air ingress fires and steam gasification
 *
 * THE MODEL IS ONE RESISTANCE CHAIN, NOT THREE REGIMES. The classical
 * picture of graphite oxidation has three zones - chemical control at low
 * temperature, in-pore diffusion control in the middle, boundary-layer
 * control at high temperature - and it is tempting to implement them as
 * three branches with thresholds between. That would produce kinks, and the
 * thresholds would be wrong for any geometry other than the one they were
 * tuned on. Instead, every oxidant reaches the carbon through one series
 * chain and the zones emerge as its asymptotes:
 *
 *     N'' = C_bulk / ( 1/h_m  +  1/(eta * k_v * L_c) )
 *
 *     h_m   external mass transfer through the boundary layer
 *     k_v   volumetric rate constant, S_v(X) * k_s(T)
 *     eta   Thiele effectiveness, tanh(phi)/phi, phi = L_c sqrt(k_v/D_eff)
 *
 *   phi -> 0   eta -> 1     whole volume reacts     (zone I, apparent Ea = Ea)
 *   phi >> 1   eta -> 1/phi rate ~ sqrt(k D_eff)    (zone II, apparent Ea = Ea/2)
 *   k_eff >> h_m            rate -> h_m C_bulk      (zone III, nearly flat in T)
 *
 * The halving of the apparent activation energy in zone II is a DERIVED
 * consequence of eta ~ 1/phi with phi ~ sqrt(k). We never wrote a factor of
 * two anywhere - see the test that measures it.
 *
 * WHY IT IS NUMERICALLY WELL BEHAVED. C_bulk is the oxidant's own molar
 * density, so the whole expression is exactly first order in the available
 * moles: consumption is n * lambda, an exponential decay. Oxidant depletion
 * therefore glides to zero instead of needing a floor, and the transport
 * resistance 1/h_m puts a ceiling on how fast the reaction can possibly run
 * no matter how hot the graphite gets - which is also the physical reason
 * real graphite fires are limited by air supply rather than by chemistry.
 *
 * WHAT COMES OUT WITHOUT BEING ASKED FOR:
 *  - Air ingress is a fire (exothermic) and steam ingress is a slow
 *    gasification (endothermic). Only the signs of the reaction enthalpies
 *    differ; nothing branches on which gas is present.
 *  - Hot graphite makes mostly CO rather than CO2, keeping only a quarter
 *    of the heat at the surface and sending the rest downstream as fuel
 *    gas - which the existing combustion operator then burns wherever it
 *    next meets oxygen.
 *  - Steam gasification self-limits, because the H2 it makes inhibits it.
 *  - The pebbles burn before the reflector does, because fine-grain matrix
 *    graphite has more internal surface per gram than medium-grain NBG-18.
 */

import { SimulationState, FlowNode, ThermalNode } from '../types';
import { nodeGasVolume } from '../mixture-properties';
import { RateOperator, StateRates, createZeroRates } from '../rk45-solver';
import {
  NBG_18,
  A3_3,
  GraphiteGrade,
  GraphiteOxidant,
  oxidantRateConstant,
  oxidantPerCarbon,
  oxidantInhibition,
  reactionHeatPerCarbon,
  coFraction,
  internalSurfacePerVolume,
  characteristicPoreRadius,
  thieleEffectiveness,
  burnoffSurfaceFactor,
  burnoffPorosity,
} from '../graphite';
import {
  totalMoles,
  emptyGasComposition,
  mixtureViscosity,
  diffusivityInMixture,
  knudsenDiffusivity,
  effectivePoreDiffusivity,
  speciesMolecularWeight,
} from '../gas-properties';
import { nodeHeatCapacity, pieceFraction } from './rate-operators';
import { PEBBLE_BED_VOID_FRACTION } from './pebble-spill';
import { approxVaporDensity } from './connection-hydraulics';

const OXIDANTS: GraphiteOxidant[] = ['O2', 'H2O', 'CO2'];
const M_CARBON = 0.012011; // kg/mol

/** Per-node diagnostics for the UI and the check script */
export interface GraphiteOxidationDiagnostics {
  nodeId: string;
  burnoff: number;
  /** kg of carbon per second, by oxidant */
  carbonRate: Record<GraphiteOxidant, number>;
  /** Thiele effectiveness by oxidant - which zone each reaction is in */
  effectiveness: Record<GraphiteOxidant, number>;
  /** Net heat into the graphite (W); negative while gasification dominates */
  heatRate: number;
  /** Fraction of carbon leaving as CO rather than CO2 */
  coFraction: number;
}

const lastDiagnostics = new Map<string, GraphiteOxidationDiagnostics>();

/** Last computed per-node graphite oxidation diagnostics */
export function getGraphiteOxidationDiagnostics(): ReadonlyMap<string, GraphiteOxidationDiagnostics> {
  return lastDiagnostics;
}

function gradeFor(name: 'NBG-18' | 'A3-3'): GraphiteGrade {
  return name === 'NBG-18' ? NBG_18 : A3_3;
}

export class GraphiteOxidationRateOperator implements RateOperator {
  name = 'GraphiteOxidation';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();
    lastDiagnostics.clear();

    for (const [id, node] of state.thermalNodes) {
      const gox = node.graphiteOxidation;
      if (!gox) continue;

      const gasNode = state.flowNodes.get(gox.associatedGasNode);
      if (!gasNode) {
        throw new Error(
          `[GraphiteOxidation] Node '${id}' names gas node ` +
          `'${gox.associatedGasNode}', which does not exist. Oxidant supply and ` +
          `product release both depend on it; there is no sensible default.`
        );
      }

      const remaining = 1 - gox.burnoff;
      if (remaining <= 0) continue; // no carbon left to attack

      // Loose pieces (pebbles) can leave or arrive: the exposed area and the
      // carbon that burn-off is a fraction of both follow how many are here.
      const pieceScale = pieceFraction(node);
      if (!(pieceScale > 0)) continue; // nothing here to burn

      const grade = gradeFor(gox.grade);
      const T = node.temperature;

      // --- Structure at the current burn-off -----------------------------
      // Both DERIVED from burn-off, never integrated separately, so the
      // pore structure cannot drift away from the mass actually consumed.
      const surfaceFactor = burnoffSurfaceFactor(gox.burnoff);
      const S_v = internalSurfacePerVolume(grade) * surfaceFactor;
      const porosity = burnoffPorosity(grade.porosity, gox.burnoff);
      // Pores widen as the walls between them are eaten away: pore volume
      // grows while pore area follows the random-pore factor.
      const poreRadius = characteristicPoreRadius(grade) *
        (surfaceFactor > 0 ? (porosity / grade.porosity) / surfaceFactor : 1);

      // --- Gas state -----------------------------------------------------
      const ncg = gasNode.fluid.ncg ?? emptyGasComposition();
      // The gas space the oxidant is in (the whole node for a gas loop)
      const volume = nodeGasVolume(gasNode);
      const T_gas = gasNode.fluid.temperature;
      const P = gasNode.fluid.pressure;

      // Steam sharing the vapour space (all of it for a vapour node, the
      // vapour fraction for two-phase). This is the H2O oxidant inventory.
      const steamVaporMass = gasNode.fluid.phase === 'two-phase'
        ? gasNode.fluid.mass * (gasNode.fluid.quality ?? 0)
        : gasNode.fluid.mass;
      const steamMoles = Math.max(0, steamVaporMass / 0.018015);

      const nTotal = totalMoles(ncg) + steamMoles;
      const p_H2 = nTotal > 0 ? P * ((ncg.H2 ?? 0) / nTotal) : 0;

      // External mass-transfer coefficient. Sherwood for a sphere or a
      // surface in cross-flow: Sh = 2 + 0.6 Re^0.5 Sc^(1/3). The leading 2
      // is the stagnant-sphere limit, so h_m stays finite and positive with
      // every blower dead - which is exactly the condition an air-ingress
      // accident runs in.
      let totalMassFlow = 0;
      for (const fc of state.flowConnections) {
        if (fc.fromNodeId === gasNode.id || fc.toNodeId === gasNode.id) {
          totalMassFlow += Math.abs(fc.massFlowRate);
        }
      }
      const rho_g = approxVaporDensity(gasNode);
      const mu_g = mixtureViscosity(ncg, T_gas);
      const velocity = gasNode.flowArea > 0 && rho_g > 0
        ? totalMassFlow / (rho_g * gasNode.flowArea)
        : 0;
      const L_piece = 6 * gox.characteristicLength; // sphere diameter equivalent
      const Re = mu_g > 0 ? (rho_g * velocity * L_piece) / mu_g : 0;

      const nodeRates = rates.thermalNodes.get(id) ?? { dTemperature: 0 };
      const gasRates = rates.flowNodes.get(gasNode.id) ?? { dMass: 0, dEnergy: 0 };
      // Pebble bed: where along the bed the oxidant arrives, and how fast
      // it moves through it (see layerWeights)
      const front = gox.layers ? bedFront(state, gasNode, rho_g, gox.layers, pieceScale) : undefined;
      const layerCarbon = gox.layers ? new Array<number>(gox.layers.burnoff.length).fill(0) : undefined;
      if (!gasRates.dNcg) gasRates.dNcg = emptyGasComposition();

      let carbonTotal = 0;      // kg/s
      let heatTotal = 0;        // W into the graphite
      const diagCarbon = { O2: 0, H2O: 0, CO2: 0 } as Record<GraphiteOxidant, number>;
      const diagEta = { O2: 1, H2O: 1, CO2: 1 } as Record<GraphiteOxidant, number>;
      const f_CO = coFraction(T);

      for (const oxidant of OXIDANTS) {
        const moles = oxidant === 'H2O' ? steamMoles : (ncg[oxidant] ?? 0);
        if (moles <= 0 || volume <= 0) continue;

        // Bulk molar concentration of this oxidant (mol/m3). Using the
        // inventory directly is what makes consumption first order in the
        // moles present, so depletion is a smooth exponential decay.
        const C_bulk = moles / volume;

        // Intrinsic kinetics, inhibited where the mechanism calls for it
        const k_s = oxidantRateConstant(grade, oxidant, T) *
          oxidantInhibition(oxidant, p_H2);
        const k_v = S_v * k_s; // 1/s

        // In-pore diffusion
        const D_bulk = diffusivityInMixture(oxidant, ncg, steamMoles, T_gas, P);
        const D_kn = knudsenDiffusivity(poreRadius, T, speciesMolecularWeight(oxidant));
        const D_eff = effectivePoreDiffusivity(D_bulk, D_kn, porosity);

        const phi = gox.characteristicLength * Math.sqrt(k_v / D_eff);
        const eta = thieleEffectiveness(phi);
        const k_eff = eta * k_v * gox.characteristicLength; // m/s

        // External transport
        const Sc = mu_g > 0 && rho_g > 0 ? mu_g / (rho_g * D_bulk) : 1;
        const Sh = 2 + 0.6 * Math.sqrt(Math.max(0, Re)) * Math.cbrt(Math.max(1e-6, Sc));
        const h_m = (Sh * D_bulk) / L_piece; // m/s

        // Series resistance, then carbon consumption
        const flux = C_bulk / (1 / h_m + 1 / k_eff);      // mol oxidant/(m2.s)
        const oxidantMolRate = flux * gox.externalArea * pieceScale; // mol/s
        const carbonMolRate = oxidantMolRate / oxidantPerCarbon(oxidant, T);

        if (!(carbonMolRate > 0) || !Number.isFinite(carbonMolRate)) continue;

        carbonTotal += carbonMolRate * M_CARBON;
        heatTotal += carbonMolRate * reactionHeatPerCarbon(oxidant, T);
        diagCarbon[oxidant] = carbonMolRate * M_CARBON;
        diagEta[oxidant] = eta;

        // Which layers of a pebble bed this oxidant's carbon came out of
        if (front && layerCarbon) {
          const k_bed = (6 * (1 - PEBBLE_BED_VOID_FRACTION) / gox.layers!.pebbleDiameter) /
            (1 / h_m + 1 / k_eff);
          const w = layerWeights(gox.layers!.burnoff, front, D_bulk, k_bed, rho_g);
          for (let i = 0; i < w.length; i++) layerCarbon[i] += carbonMolRate * M_CARBON * w[i];
        }

        // --- Products ----------------------------------------------------
        switch (oxidant) {
          case 'O2':
            gasRates.dNcg.O2 -= oxidantMolRate;
            gasRates.dNcg.CO += carbonMolRate * f_CO;
            gasRates.dNcg.CO2 += carbonMolRate * (1 - f_CO);
            break;
          case 'H2O': {
            // Steam is water, not an NCG: it leaves the flow node's mass.
            const steamMassRate = oxidantMolRate * 0.018015;
            gasRates.dMass -= steamMassRate;
            // Carry the steam's specific enthalpy out with it, matching how
            // the cladding oxidation operator books consumed steam.
            gasRates.dEnergy -= steamMassRate * 2.0e6;
            gasRates.dNcg.CO += carbonMolRate;
            gasRates.dNcg.H2 += carbonMolRate;
            break;
          }
          case 'CO2':
            gasRates.dNcg.CO2 -= oxidantMolRate;
            gasRates.dNcg.CO += 2 * carbonMolRate;
            break;
        }
      }

      if (carbonTotal <= 0) continue;

      // Reaction heat lands on the graphite. Gasification is endothermic,
      // so this can be negative - a steam-flooded core cools its own
      // graphite, which is why that path cannot run away.
      nodeRates.dTemperature += heatTotal / nodeHeatCapacity(node);
      rates.thermalNodes.set(id, nodeRates);

      // Burn-off advances in proportion to carbon consumed.
      nodeRates.dGraphiteBurnoff =
        (nodeRates.dGraphiteBurnoff ?? 0) + carbonTotal / (gox.initialCarbonMass * pieceScale);
      // A node of loose pieces integrates its own mass (pieces come and go),
      // so the burned carbon leaves it as a mass rate; other graphite has
      // its mass set from burn-off when the step is applied.
      if (gox.fullMass !== undefined) nodeRates.dMass = (nodeRates.dMass ?? 0) - carbonTotal;
      // Each layer holds 1/N of the bed's carbon
      if (layerCarbon) {
        const perLayer = gox.initialCarbonMass * pieceScale / layerCarbon.length;
        nodeRates.dLayerBurnoff = layerCarbon.map(c => c / perLayer);
      }

      rates.flowNodes.set(gasNode.id, gasRates);

      lastDiagnostics.set(id, {
        nodeId: id,
        burnoff: gox.burnoff,
        carbonRate: diagCarbon,
        effectiveness: diagEta,
        heatRate: heatTotal,
        coFraction: f_CO,
      });
    }

    return rates;
  }
}

// ============================================================================
// Burn front in a pebble bed
// ============================================================================
//
// A pebble core is one lumped matrix node, so the oxidation rate above is the
// bed's total. Where in the bed that carbon comes from is not uniform: an
// oxidant entering a hot bed is consumed in the first layers it meets, and
// those pebbles burn through their fuel-free shells long before the rest
// lose anything. The bed's `layers` record that history (burn-off per axial
// layer, integrated), so fuel exposure can be read off the pebbles that
// actually burned. The TOTAL is unchanged - only its distribution.
//
// The distribution is the steady profile of advection, dispersion and a
// first-order sink along the bed, c ~ exp(-|z - z_in|/lambda), with the
// exact decay length of D c'' - u c' - k c = 0:
//
//   lambda = (u + sqrt(u^2 + 4 D k)) / (2 k)
//
// u: superficial velocity of the gas entering the bed; k = a_v k_ov, the
// per-bed-volume sink (pebble surface per bed volume a_v = 6(1-eps)/d,
// times the same series film + pore coefficient the total rate used);
// D = eps D_m / tau + d u / 2 (pore diffusion with tortuosity sqrt 2, plus
// axial dispersion). No flow: lambda = sqrt(D/k), the diffusion penetration
// depth. Fast flow or slow kinetics: lambda -> u/k or beyond the bed, and
// the burning spreads out evenly - the lumped answer is recovered.
//
// z_in is where the gas comes in, opening by opening: every opening into
// the core node supplies a share of the oxidant - the gas flowing in through
// it plus the diffusive exchange it would carry anyway (rho D A / H) - and
// each share decays along its own profile. A dead bed is attacked at all its
// openings by diffusion, a flowing one mostly from its inlet.
// Each layer's share is also weighted by its remaining carbon (1 - b_i): a
// burned-out layer has nothing left to consume, and the attack moves on.
//
// Simplifications: each profile is symmetric about its opening; the layers are
// fractions of the CURRENT bed (a draining bed's burn-off pattern does not
// slide down with the pebbles); the kinetics still run on the mean burn-off.

/**
 * Decay length (m) of an oxidant entering a reacting bed: the exact
 * solution of D c'' - u c' - k c = 0 downstream of the inlet. u = 0 gives
 * the diffusion depth sqrt(D/k); u^2 >> Dk gives the advective u/k.
 */
export function burnFrontDecayLength(u: number, D: number, k: number): number {
  return (u + Math.sqrt(u * u + 4 * D * k)) / (2 * k);
}

export interface BedFront {
  /** current bed height (m) */
  H: number;
  /** openings into the core node: elevation above the bed bottom (m),
   *  inflowing mass rate (kg/s), area (m2) */
  openings: Array<{ z: number; inflow: number; area: number }>;
  /** superficial velocity of the gas entering the bed (m/s) */
  u: number;
  /** pebble diameter (m) */
  d: number;
}

function bedFront(
  state: SimulationState,
  gasNode: FlowNode,
  rho_g: number,
  layers: NonNullable<NonNullable<ThermalNode['graphiteOxidation']>['layers']>,
  pieceScale: number,
): BedFront {
  const H = layers.bedHeight * pieceScale;
  const openings: BedFront['openings'] = [];
  let inflowTotal = 0;
  const base = gasNode.elevation - layers.bedBottomElevation;
  const mid = (gasNode.height ?? 0) / 2;
  for (const c of state.flowConnections) {
    let inflow: number;
    let e: number | undefined;
    if (c.toNodeId === gasNode.id) {
      inflow = Math.max(0, c.massFlowRate);
      e = c.toElevation;
    } else if (c.fromNodeId === gasNode.id) {
      inflow = Math.max(0, -c.massFlowRate);
      e = c.fromElevation;
    } else {
      continue;
    }
    openings.push({ z: base + (e ?? mid), inflow, area: c.flowArea });
    inflowTotal += inflow;
  }
  const u = rho_g > 0 && layers.bedArea > 0 ? inflowTotal / (rho_g * layers.bedArea) : 0;
  return { H, openings, u, d: layers.pebbleDiameter };
}

export function layerWeights(
  burnoff: number[],
  front: BedFront,
  D_molecular: number,
  k_bed: number,
  rho_g: number,
): number[] {
  const n = burnoff.length;
  const eps = PEBBLE_BED_VOID_FRACTION;
  const D = eps * D_molecular / Math.SQRT2 + 0.5 * front.d * front.u;
  const lambda = burnFrontDecayLength(front.u, D, k_bed);

  // Attenuation accumulates only through carbon that is still there: a
  // burned-out layer is no sink, so the oxidant passes it and attacks the
  // next. depth(z) is that optical depth measured from the bed bottom; the
  // gas plenum outside the bed consumes nothing, so an opening beyond the
  // bed delivers at the bed's nearest face.
  const dz = front.H / n;
  const cum = new Array<number>(n + 1);
  cum[0] = 0;
  for (let j = 0; j < n; j++) cum[j + 1] = cum[j] + (1 - burnoff[j]) * dz / lambda;
  const depth = (z: number): number => {
    const j = Math.min(n - 1, Math.floor(z / dz));
    return cum[j] + (1 - burnoff[j]) * (z - j * dz) / lambda;
  };
  const centres = new Array<number>(n);
  for (let i = 0; i < n; i++) centres[i] = depth((i + 0.5) * dz);

  // Every opening supplies its share - the gas flowing in through it plus
  // the diffusive exchange it carries anyway (rho D A / H) - and that share
  // is consumed along its own profile. Superposed, so a bed fed from both
  // ends burns at both ends, not in the middle.
  const w = new Array<number>(n).fill(0);
  const p = new Array<number>(n);
  let supplyTotal = 0;
  for (const o of front.openings) {
    supplyTotal += o.inflow + rho_g * D_molecular * o.area / front.H;
  }
  for (const o of front.openings) {
    const supply = o.inflow + rho_g * D_molecular * o.area / front.H;
    if (!(supply > 0)) continue;
    const aIn = depth(Math.min(front.H, Math.max(0, o.z)));
    // Normalised against the nearest live layer, so a front centimetres
    // deep in a metre-thick layer cannot underflow every weight to zero
    let tauMin = Infinity;
    for (let i = 0; i < n; i++) {
      if (burnoff[i] < 1) tauMin = Math.min(tauMin, Math.abs(centres[i] - aIn));
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
      p[i] = (1 - burnoff[i]) * Math.exp(-(Math.abs(centres[i] - aIn) - tauMin));
      sum += p[i];
    }
    if (!(sum > 0)) continue;
    for (let i = 0; i < n; i++) w[i] += (supply / supplyTotal) * p[i] / sum;
  }
  let total = 0;
  for (let i = 0; i < n; i++) total += w[i];
  if (!(total > 0)) return w.fill(1 / n);
  for (let i = 0; i < n; i++) w[i] /= total;
  return w;
}

/**
 * Fraction of a pebble bed's fuel particles whose matrix cover has burned
 * away (0-1). Burning works inward from a pebble's surface, so a layer's
 * particles start to be exposed once its burn-off passes the fuel-free
 * shell's share of the carbon, and are all exposed when it reaches 1.
 */
export function exposedParticleFraction(layers: { burnoff: number[]; shellFraction: number }): number {
  const s = layers.shellFraction;
  let e = 0;
  for (const b of layers.burnoff) e += Math.max(0, b - s) / (1 - s);
  return e / layers.burnoff.length;
}
