/**
 * Moving-boundary OTSG rate operator.
 *
 * For every flow node carrying `otsg` state, this operator replaces the
 * ordinary bulk-temperature convection path (which the factory suppresses
 * for these nodes) with the sectioned model of docs/otsg-moving-boundary-
 * design.md:
 *
 *   shell gas --[counterflow march, section by section]--> tube metal
 *   tube metal --[transit + standing branches, per section]--> water sections
 *
 * The node's ordinary (mass, energy) totals stay owned by the existing flow
 * machinery - this operator adds ONLY the wall heat, plus the matching energy
 * changes on the shell node and metal. The partition itself is not integrated
 * at all: it is solved from the totals on every evaluation, with the
 * superheat section pinned by its own metal (evaluateOtsgPartition), so no
 * bookkeeping here can disagree with conservation, with the room the tubes
 * actually have, or with the walls doing the heating.
 *
 * External flows and the partition: an OUTFLOW is booked to the section that
 * physically occupies its nozzle - the partition's own phase-by-elevation
 * answer (drawCompositionAt), the same weights the energy side prices the
 * draw with - so slug water leaving a flooded tube is debited from the slug
 * whatever the momentum path's phase label says. Only that share needs
 * booking - the boiling and superheat masses are derived from the totals -
 * and the rest of what the bundle ships is the scale the steam pass transits
 * at. An INFLOW is the donor's business, classified by the DONOR's own draw
 * model: its non-vapor share, routed to section 1 in proportion to how
 * subcooled it is. Liquid draws leave section 1 weighted by m1/(m1+1), so an
 * emptying subcooled section never steps its own rate.
 */

import { SimulationState, FlowNode, ThermalNode } from '../types';
import { RateOperator, ConstraintOperator, StateRates, createZeroRates } from '../rk45-solver';
import {
  evaluateOtsgPartition,
  otsgRates,
  marchCounterflowGas,
  otsgZoneOverlaps,
  reconcileSlug,
  saturationAtP,
  OtsgEval,
  OtsgWallPin,
  marchSteamOverMetal,
} from '../otsg';
import { saturatedLiquidEnergy, saturatedLiquidDensity } from '../water-properties';
import { nodeHeatCapacity } from './rate-operators';
import {
  totalMoles,
  mixtureThermalConductivity,
  mixtureViscosity,
  mixtureCp,
  averageMolecularWeight,
} from '../gas-properties';
import { nodeVaporDensity, drawCompositionAt } from './connection-hydraulics';
import { solveMixtureState } from '../mixture-properties';

// Tube-side film coefficients live in otsg.ts so the factory's design-point
// seeding and this operator's duties use the same numbers by construction.
import { H_TUBE_LIQUID, H_TUBE_BOILING, H_TUBE_STEAM, H_TUBE_NATURAL } from '../otsg';

/**
 * The WATER's own state inside a tube node: its partial pressure and its
 * share of the node's internal energy.
 *
 * A flow node's `fluid.pressure` is the TOTAL pressure and `internalEnergy`
 * the TOTAL energy - steam plus any non-condensible gas sharing the volume
 * (Dalton, see mixture-properties.ts). Handing those to the sectioned model
 * asks it to place saturation boundaries at a pressure the water is not at
 * and to account for energy the water does not hold: helium leaking into a
 * depressurized bundle would have the model looking for a dome at, say, 60
 * bar around water that is really at 5, and the closure would rightly report
 * that the totals and the pressure disagree about what phase the tube is in.
 *
 * The water sub-problem is exactly the pure-water problem at its own partial
 * pressure - that is the whole point of the Dalton split - so this hands the
 * sections the water's half of it. With no gas present the mixture solve
 * short-circuits to the stored state, so this costs nothing in the ordinary
 * case.
 *
 * The gas shares the VAPOUR space with the steam (Dalton), so the water
 * sub-problem is still the pure-water problem in the whole tube volume and
 * the section volumes close over the full tube: the two conventions match.
 */
export function tubeWaterState(node: FlowNode): { pressure: number; energy: number; gasPressure: number } {
  // An empty node has no state to solve - the closure handles it by having
  // nothing to partition.
  if (!(node.fluid.mass > 0)) {
    return { pressure: node.fluid.pressure, energy: node.fluid.internalEnergy, gasPressure: 0 };
  }
  // Solve the state FRESH rather than reading fluid.pressure. That field is
  // written by FluidStateConstraintOperator, which runs on accepted states
  // only, while mass and energy move on every RK stage - so mid-step the
  // stored pressure belongs to totals the node no longer has. The sections
  // are far more sensitive to that than a bulk node is: the closure places
  // saturation boundaries with it, and a pressure 7 bar stale against its own
  // (u,v) puts the state below the saturation TIE LINE, where no partition
  // exists and
  // the closure rightly refuses. That is what a feedwater heater's surge
  // first surfaced.
  const mix = solveMixtureState(
    node.fluid.mass, node.fluid.internalEnergy, node.volume,
    node.fluid.ncg, node.fluid.temperature);
  return { pressure: mix.steamPressure, energy: mix.waterEnergy, gasPressure: mix.gasPressure };
}


/** What the attached connections are doing to a tube node, in the terms the
 *  sectioned model needs. Shared so the ledger check (which runs on ACCEPTED
 *  states) sees exactly what the rate operator saw. */
export interface OtsgFlows {
  WFeed: number;       // kg/s of liquid inflow routed to the subcooled section
  hFeed: number;       // J/kg - its mean enthalpy
  uFeed: number;       // J/kg - the same, as internal energy
  /** kg/s - everything the bundle ships that is NOT economizer water: the
   *  scale the steam pass transits at (see classifyOtsgFlows). Needs no
   *  section booking, because those sections are derived from the totals. */
  WSteamOut: number;
  /** kg/s - the share of the outflow drawn from the economizer, by the
   *  partition's own phase-by-elevation answer. The one draw the ledger has
   *  to be debited for. */
  WLiquidOut: number;
}

export function classifyOtsgFlows(
  state: SimulationState, id: string, node: FlowNode, waterPressure: number,
): OtsgFlows {
  let WFeed = 0;
  let WSteamOut = 0, WLiquidOut = 0;
  // THE ECONOMIZER'S INLET ENTHALPY is accumulated WITHOUT any flow rate in
  // it - see the note where hFeed is formed below - so it cannot step when
  // the feed stops.
  let hInNum = 0, hInDen = 0;
  // Saturated liquid enthalpy in the tube itself: the top of the
  // economizer's profile, and the reference every inlet's subcooling is
  // measured against. It is the saturation at the tube's own PRESSURE.
  // Reading it off node.fluid.temperature instead - which the partition
  // publishes as the mass-weighted MEAN of the three sections - put it
  // wherever the superheat section happened to be: a bundle holding 18 kg of
  // 450 C steam reported a mean 30 K above its own T_sat, so feed that was
  // 6 kJ/kg ABOVE saturation was scored 30 K subcooled and routed into the
  // economizer at full weight. That is the routing ramp's whole job -
  // near-saturated inflow belongs in the boiling section, whose mass is
  // derived - and it was reading the wrong thermometer. Measured: on a
  // blackout with a hot feed line it drove the slug's mean at 7 kJ/kg-s
  // toward a saturation 28 kJ/kg away while Q1 ran backwards, and the
  // partition ran out of leftovers.
  const satNow = saturationAtP(waterPressure);
  const hfNow = satNow.h_f;
  // WHICH connection is the economizer's inlet is GEOMETRY, not flow: a
  // once-through tube takes its feed at the bottom and gives up steam at the
  // top, which is the same convention the partition's own phase-by-elevation
  // answer rests on. Selecting it by elevation makes the inlet enthalpy
  // independent of both the flow rate and the momentum solve's phase LABEL -
  // and the label matters here, because a flooded tube ships water out its
  // steam nozzle, and letting those (2-5 kg, wildly swinging) sliver valve
  // nodes price a 73 kg slug put their noise straight into the published
  // pressure.
  let minElev = Infinity;
  for (const conn of state.flowConnections) {
    if (conn.fromNodeId === id) minElev = Math.min(minElev, conn.fromElevation ?? 0);
    else if (conn.toNodeId === id) minElev = Math.min(minElev, conn.toElevation ?? 0);
  }
  for (const conn of state.flowConnections) {
    const isFrom = conn.fromNodeId === id;
    const isTo = conn.toNodeId === id;
    if (!isFrom && !isTo) continue;
    // Signed flow INTO this node
    const w = isTo ? conn.massFlowRate : -conn.massFlowRate;
    // The water on the OTHER side of this connection, as subcooled liquid at
    // its own temperature (u_f(T) + P v_f(T) - compressibility negligible).
    // Which end is the donor depends on the flow's sign, but which node is
    // the OTHER one does not - and the inlet's own enthalpy is a fact about
    // the water standing there either way.
    const other = state.flowNodes.get(isTo ? conn.fromNodeId : conn.toNodeId);
    if (!other) {
      throw new Error(`[OTSG] node '${id}': connection '${conn.id}' names a node ` +
        `('${isTo ? conn.fromNodeId : conn.toNodeId}') that does not exist.`);
    }
    const hIn = saturatedLiquidEnergy(other.fluid.temperature) +
      waterPressure / saturatedLiquidDensity(other.fluid.temperature);
    // Liquid inflow feeds the SUBCOOLED section only to the extent it is
    // actually subcooled: water within ~12 K of saturation flashes into
    // the boiling region essentially on entry, so it routes to section 2
    // (whose mass is derived - no bookkeeping). The 50 kJ/kg ramp is a
    // smoothing width, not a threshold: routing varies continuously with
    // subcooling, and a transiently near-saturated stream (leak backflow,
    // recirculation) can no longer poison the subcooled section's
    // mean-enthalpy closure - which is exactly how this line's absence
    // killed a run.
    const wSub = Math.min(1, Math.max(0, (hfNow - hIn) / 50e3));
    // Vapor inflow (backflow from a steam header) needs no bookkeeping: it
    // lands in the node's totals and the solved partition picks it up as
    // vapor region on the next evaluation. A vapor line is also not part of
    // the economizer's inlet.
    const elevHere = (isTo ? conn.toElevation : conn.fromElevation) ?? 0;
    if (elevHere === minElev) {
      hInNum += wSub * hIn;
      hInDen += wSub;
    }
    // WHAT LEAVES IS DECIDED BY THE PARTITION, NOT BY A LABEL.
    //
    // This used to book an outflow by conn.currentFlowPhase - the momentum
    // path's phase LABEL. That label is written last, before the rates run,
    // by FlowDynamicsConstraintOperator's own phase model, which knows
    // nothing about the partition: it estimates the node's height from its
    // volume as a cylinder (1.2 m for an Xe-100 bundle whose real tubes are
    // 14 m) and compares the connection's elevation against a bulk-quality
    // liquid level inside it. Every nozzle above ~1 m therefore reads
    // 'vapor' whatever is actually there. On a FLOODED tube - the whole
    // second half of a circulator trip - that booked 20-25 kg/s of boiling
    // water leaving the top nozzle to the steam section and NOTHING to the
    // slug, and a mid-bundle leak draining the economizer to the steam
    // section too. The node's totals lost that water; the ledger did not,
    // so m1 drifted up over the inventory, hit the closure's cap
    // ("economizer ledger claims 99.x%"), and the partition it then asked
    // for needed more than 220 bar to pack.
    //
    // The section that owns a draw is the one PHYSICALLY at the nozzle, and
    // the partition already answers that question - drawCompositionAt reads
    // its own section boundaries by elevation (economizer / boiling /
    // superheat), which is the same convention the feed nozzle is selected
    // by above. It is also the answer the ENERGY side already uses: both
    // FlowRateOperator and the pressure solver price a draw by blending
    // these same mass weights over the section enthalpies (hLiquidOut for
    // the slug's mean, hSteamOut for the superheat outlet). So booking the
    // mass by the same weights makes the section debit and the energy the
    // node loses describe one event instead of two.
    //
    // An INFLOW is the DONOR's business, so it is classified by the DONOR's
    // own draw model at its own nozzle: what the other node ships is what
    // arrives, and (1 - wVapor) is the non-vapor share - the continuous form
    // of the 'not labelled vapor' test it replaces. For the single-phase
    // feed line that is every plant's normal case it is exactly 1, as the
    // label was; where it differs, it is the answer the ENERGY side already
    // uses, since FlowRateOperator prices what arrives by this same
    // composition of the same donor.
    //
    // WHY THE ELEVATION ANSWER GOVERNS THE LEDGER BUT NOT THE TRANSIT
    // SCALE. Only the LIQUID share needs booking - the boiling and superheat
    // masses are derived from the totals - so WLiquidOut is the whole of the
    // mass-conservation question, and it is the elevation's to answer: water
    // leaving at 5 m came out of whatever section holds 5 m.
    //
    // WSteamOut is not a second booking; it is the scale the steam pass
    // transits at (the wall pin's theta and the superheater's transit
    // branch). The sections of a once-through tube are in SERIES, so what
    // the bundle ships had to flow through the sections above the water it
    // came from - the outlet is the top of the tube, and the drawn nozzle's
    // 0.5 m of stub below it is drawing-frame detail, not a bypass. So the
    // transit scale is the bundle's whole non-liquid throughput, and it does
    // not step when a section boundary sweeps past a nozzle. Booking it by
    // elevation instead was measured: the moment the boiling section's top
    // rose past the steam nozzle on a flooding tube, the pin's theta stepped
    // from ~0.1 to 1 (a dead-ended pocket soaking to its metal, T3 270 ->
    // 390 C) and, on a tube that is 99% water, that step lands in the
    // published pressure through the last cubic centimetres of vapour -
    // circulator-trip rejections 649 -> 1201 for it. A discontinuity in an
    // ARGUMENT, which no timestep can shrink.
    if (w > 0) {
      const compIn = drawCompositionAt(
        other, isTo ? conn.fromElevation : conn.toElevation, w,
        isTo ? conn.fromPhaseTolerance : conn.toPhaseTolerance,
        isTo ? conn.fromOpeningHeight : conn.toOpeningHeight, undefined, false);
      WFeed += w * wSub * (1 - compIn.wVapor);
    } else if (w < 0) {
      const compOut = drawCompositionAt(
        node, elevHere, -w,
        isTo ? conn.toPhaseTolerance : conn.fromPhaseTolerance,
        isTo ? conn.toOpeningHeight : conn.fromOpeningHeight, undefined, false);
      WLiquidOut += -w * compOut.wLiquid;
      WSteamOut += -w * (1 - compOut.wLiquid);
    }
  }
  // The inlet enthalpy that prices the economizer's linear profile - and
  // therefore the ENERGY of the whole slug, m1 * (u_in + u_f)/2 - must not
  // depend on the feed's flow RATE. It used to: `WFeed > 0 ? mean : h_f(473 K)`
  // handed the profile a hard-coded 200 C the instant the feed stopped.
  // Measured on a blacked-out Xe-100 bundle: uFeed stepped 1136 -> 840 kJ/kg
  // in one step, which repriced a 73 kg slug by 11 MJ - 6% of the node's
  // energy, landing entirely on the 31 kg of leftovers that set the pressure
  // - and the published pressure jumped 81 -> 99 bar. The closure itself is
  // smooth in this argument (0.045 bar per kJ/kg over the whole span); the
  // jump was the argument's. It drove 79% of that run's rejections, and no
  // amount of dt could shrink it.
  //
  // So the inlet is what it physically is: the enthalpy of the water
  // standing at the tube's LOWEST connections - its feed nozzle - weighted
  // by how subcooled each one is, the same weight that decides how much of
  // an inflow the economizer takes at all. With one feed line this is
  // exactly the value the flow-weighted mean gave, flowing or not. With
  // nothing subcooled there the weights vanish together with (h_f - h_in),
  // so the ratio tends to h_f itself: an economizer with no colder water to
  // draw on degenerates to zero subcooling, continuously.
  const hFeed = hInDen > 0 ? hInNum / hInDen : hfNow;
  return {
    WFeed, hFeed,
    uFeed: hFeed - waterPressure * 0.0012,   // u = h - Pv, liquid v ~ 1.2 L/kg
    WSteamOut, WLiquidOut,
  };
}


/** The bundle's tube-metal zones, feed end to steam end. */
export function otsgMetalZones(state: SimulationState, node: FlowNode): ThermalNode[] {
  const cfg = node.otsg!;
  const zones = cfg.metalNodeIds.map(mid => state.thermalNodes.get(mid));
  if (zones.length === 0 || zones.some(z => !z)) {
    throw new Error(`[OTSG] node '${node.id}': tube metal zones ` +
      `[${cfg.metalNodeIds.join(', ')}] missing or empty.`);
  }
  return zones as ThermalNode[];
}

export function otsgZoneTemps(state: SimulationState, node: FlowNode): number[] {
  return otsgMetalZones(state, node).map(z => z.temperature);
}

/** The wall pin for a bundle's superheat section - the one piece of closure
 *  information the totals cannot supply (see evaluateOtsgPartition). Built from the
 *  bundle's own metal and its steam draw. */
export function otsgWallPin(
  state: SimulationState, node: FlowNode, flows: OtsgFlows,
): OtsgWallPin {
  const cfg = node.otsg!;
  return {
    zoneTemps: otsgZoneTemps(state, node),
    hA3Full: H_TUBE_STEAM * cfg.heatArea,
    WSteam: Math.max(0, flows.WSteamOut),
  };
}

/**
 * The gas temperature entering the bundle's shell - the upstream donor's,
 * not the shell's own bulk. A well-mixed shell node sits at its OUTLET
 * temperature, and both the march and the superheat outlet's ceiling need
 * the other end of it.
 */
export function otsgGasInletTemp(state: SimulationState, shell: FlowNode): number {
  let TGasIn = shell.fluid.temperature;
  for (const fc of state.flowConnections) {
    if (fc.toNodeId === shell.id && fc.massFlowRate > 1e-6) {
      const donor = state.flowNodes.get(fc.fromNodeId);
      if (donor && donor.fluid.temperature > TGasIn) TGasIn = donor.fluid.temperature;
    } else if (fc.fromNodeId === shell.id && fc.massFlowRate < -1e-6) {
      const donor = state.flowNodes.get(fc.toNodeId);
      if (donor && donor.fluid.temperature > TGasIn) TGasIn = donor.fluid.temperature;
    }
  }
  return TGasIn;
}

/** Shell-side film coefficient (W/m2-K): crossflow Dittus-Boelter on the
 *  actual gas mixture, floored at natural convection. */
export function otsgGasFilmCoefficient(shell: FlowNode, state: SimulationState): number {
  const throughput = otsgShellThroughput(shell, state);
  const ncg = shell.fluid.ncg;
  const T = shell.fluid.temperature;
  const k = ncg && totalMoles(ncg) > 0 ? mixtureThermalConductivity(ncg, T) : 0.05;
  const mu = ncg && totalMoles(ncg) > 0 ? mixtureViscosity(ncg, T) : 3e-5;
  const cp = otsgGasCpPerKg(shell);
  const rho = nodeVaporDensity(shell);
  const D = 0.019; // tube OD - the crossflow characteristic length
  const v = shell.flowArea > 0 && rho > 0 ? throughput / (rho * shell.flowArea) : 0;
  const Re = mu > 0 ? (rho * v * D) / mu : 0;
  const Pr = k > 0 ? (cp * mu) / k : 0.7;
  const hForced = Re > 10
    ? 0.023 * Math.pow(Re, 0.8) * Math.pow(Math.max(0.1, Pr), 0.4) * k / D
    : 0;
  return Math.max(60, hForced);
}

/** Gas capacity rate mdot*cp through the shell (W/K). */
export function otsgGasMcp(shell: FlowNode, state: SimulationState): number {
  return otsgShellThroughput(shell, state) * otsgGasCpPerKg(shell);
}

function otsgShellThroughput(shell: FlowNode, state: SimulationState): number {
  let throughput = 0;
  for (const fc of state.flowConnections) {
    if (fc.fromNodeId === shell.id || fc.toNodeId === shell.id) {
      throughput += Math.abs(fc.massFlowRate);
    }
  }
  return throughput / 2; // in + out both counted
}

function otsgGasCpPerKg(shell: FlowNode): number {
  const ncg = shell.fluid.ncg;
  if (ncg && totalMoles(ncg) > 0) {
    const M = averageMolecularWeight(ncg);
    return M > 0 ? mixtureCp(ncg) / M : 5195;
  }
  return 2000; // steam-ish
}

/**
 * The one-stop sectioned evaluation of a bundle: water's own state, flows
 * classified by carried phase, wall pin from its own metal, partition from
 * the totals. EVERY consumer - the rate operator, sensors, checks, probes -
 * goes through here, because a diagnostic that re-derives any of these
 * ingredients differently will quietly disagree with the physics (the
 * section display once read far healthier than the operator by using the
 * feed-energy ceiling instead of the classified feed).
 */
export function evaluateOtsgSections(
  state: SimulationState, id: string, node: FlowNode,
  opts?: { exact?: boolean },
): { ev: OtsgEval; flows: OtsgFlows; water: { pressure: number; energy: number; gasPressure: number }; exact: boolean } {
  const cfg = node.otsg;
  if (!cfg) {
    throw new Error(`[OTSG] node '${id}' has no otsg state - it is not a ` +
      `moving-boundary boiler tube node.`);
  }
  const water = tubeWaterState(node);
  // Warm start the pressure solve from the node's last PUBLISHED pressure
  // (the partition's own, once OtsgPartitionConstraintOperator has run once)
  // less the gas partial; the very first evaluation starts from the uniform
  // read, which is all there is at t=0.
  const PStart = Math.max(800, node.fluid.pressure - water.gasPressure);
  const flows = classifyOtsgFlows(state, id, node, PStart);
  // The partition costs a pressure solve with property calls inside; the
  // constraint, the rate operator and any sensors all want it on the SAME
  // stage state, so the constraint leaves its solution behind keyed on the
  // exact inputs. A consumer whose state has moved re-solves - or, within a
  // small band of the last anchored solve, rides its tangent (see
  // types.ts partitionLin): internal RK stages sit within fractions of a
  // percent of their step's anchor, and re-solving the partition exactly on
  // each was ~95% of the simulation's property traffic.
  const c = cfg.partitionCache;
  if (c && c.forMass === node.fluid.mass && c.forEnergy === water.energy && c.forM1 === cfg.m1 &&
      c.forU1 === cfg.U1 && c.forUFRef === cfg.uFRef && (c.exact || !opts?.exact)) {
    return { ev: c.ev as OtsgEval, flows, water, exact: c.exact };
  }
  // Diagnostics, tests and once-per-step consumers ask for exact: the
  // tangent's frozen sections are anchored up to ~0.4% of mass away, which
  // is fine for stage rates and fatal for invariants checked at 1e-6.
  const lin = opts?.exact ? undefined : cfg.partitionLin;
  if (lin) {
    const dm = node.fluid.mass - lin.m;
    const dU = water.energy - lin.U;
    const BAND = 0.004;
    // The slug is a (ledger, reference) pair that the partition re-bases
    // whenever it solves exactly, and the anchor object is SHARED by every
    // clone of a state - so neither side's raw ledger is a stable thing to
    // compare. Compare what is invariant under re-basing: this state's slug
    // reconciled to the ANCHOR's pressure, against the anchor's own slug.
    // (Uncapped reconciliation: this decides a band, not the physics.)
    const evA = lin.ev as OtsgEval;
    const satA = saturationAtP(lin.P);
    const here = reconcileSlug(Math.min(cfg.m1, node.fluid.mass),
      cfg.m1 > 0 ? cfg.U1 * Math.min(1, node.fluid.mass / cfg.m1) : 0,
      cfg.uFRef ?? NaN, satA.u_f, node.fluid.mass);
    const dm1 = here.m1 - evA.sections[0].mass;
    const U1A = evA.sections[0].mass * (evA.sections[0].hBar - lin.P * evA.sections[0].vBar);
    const dU1 = here.U1 - U1A;
    const P = lin.P + lin.dPdm * dm + lin.dPdU * dU + lin.dPdm1 * dm1 + lin.dPdU1 * dU1;
    // The state bands above bound how stale the anchor's SECTIONS are; this
    // one bounds the linearization itself, in the only variable the tangent
    // predicts. It matters because the tube's pressure is not equally
    // sensitive everywhere: on a nearly water-solid tube the leftovers are a
    // difference of two large integrated numbers and dP/dU1 is enormous, so
    // a slug-energy move well inside its own band can imply tens of bar.
    // Measured on a circulator trip once the slug carried its own energy:
    // without this gate the linearized pressure failed the solver's own
    // 20%-per-step sanity check 943 times and the run paid 1714 rejections;
    // with it, 634 and none from the tube. Where the tangent is this stiff
    // the correct price is an exact solve, which is what falling through to
    // one below does.
    if (Math.abs(dm) < BAND * lin.m && Math.abs(dU) < BAND * Math.abs(lin.U) &&
        Math.abs(dm1) < BAND * Math.max(evA.sections[0].mass, 0.02 * lin.m) &&
        Math.abs(dU1) < BAND * Math.max(U1A, 0.02 * Math.abs(lin.U)) &&
        Math.abs(P - lin.P) < BAND * lin.P) {
      const ev: OtsgEval = { ...evA, P };
      cfg.partitionCache = { forMass: node.fluid.mass, forEnergy: water.energy, forM1: cfg.m1, forU1: cfg.U1, forUFRef: cfg.uFRef, ev, exact: false };
      return { ev, flows, water, exact: false };
    }
  }
  const ev = evaluateOtsgPartition(
    node.fluid.mass, water.energy,
    { m1: cfg.m1, U1: cfg.U1, uFRef: cfg.uFRef },
    { tubeVolume: node.volume, tubeLength: 1, heatArea: cfg.heatArea },
    otsgWallPin(state, node, flows),
    PStart, { hFeed: flows.hFeed },
  );
  // Anchor the tangent from the closure's own implicit-function derivatives
  // (OtsgEval.tangent): residual evaluations at the solved pressure, not
  // three more root finds. Absent at a regime edge - every state in that
  // neighborhood then pays for its own exact solve, the correct price there.
  cfg.partitionLin = ev.tangent
    ? { m: node.fluid.mass, U: water.energy, m1: cfg.m1, U1: cfg.U1, uFRef: cfg.uFRef, P: ev.P,
        dPdm: ev.tangent.dPdm, dPdU: ev.tangent.dPdU, dPdm1: ev.tangent.dPdm1,
        dPdU1: ev.tangent.dPdU1, ev }
    : undefined;
  cfg.partitionCache = { forMass: node.fluid.mass, forEnergy: water.energy, forM1: cfg.m1, forU1: cfg.U1, forUFRef: cfg.uFRef, ev, exact: true };
  return { ev, flows, water, exact: true };
}

/**
 * Wall-to-water duty for each section (W into the water), by the parallel
 * transit + standing branches of design doc section 5. Exported so a probe
 * can ask what the operator is actually doing to a bundle without
 * re-deriving it - a re-derivation that drifts is how the section display
 * came to read far healthier than the physics.
 */
export function otsgWaterSideDuties(
  ev: OtsgEval, flows: OtsgFlows, zoneTemps: readonly number[], heatArea: number,
): { Q1: number; Q2: number; Q3: number; TFeedIn: number; zoneQ: number[]; zoneQ2: number[]; zoneQ3: number[] } {
  const cpLiquid = 5000;
  const N = zoneTemps.length;
  const ov = otsgZoneOverlaps(
    [ev.sections[0].lengthFrac, ev.sections[1].lengthFrac, ev.sections[2].lengthFrac], N);
  const zoneQ = new Array<number>(N).fill(0);
  // The boiling section's share of each zone's duty - the part
  // applyStiffOtsgWallExchange can take out of the stages
  const zoneQ2 = new Array<number>(N).fill(0);
  const zoneQ3 = new Array<number>(N).fill(0);
  // A transiting stream marches through the zones its section covers, in
  // the water's flow direction, approaching each zone's wall across that
  // piece (a piece has one metal temperature, so the isothermal form is
  // exact for it - the wall's ramp along the section is the zones' own
  // temperatures now); the standing branch heats the section's bulk from
  // every piece in parallel. See transitStandingQ for the two branches.
  // Section 1: feed stream entering at its own temperature
  const TFeedIn = flows.WFeed > 0 ? tempOfLiquidH(flows.hFeed) : ev.sections[0].T;
  const mcp1 = flows.WFeed * cpLiquid;
  let Q1 = 0;
  {
    let T = TFeedIn;
    for (let k = 0; k < N; k++) {
      const a = heatArea * ov[k][0];
      if (!(a > 0)) continue;
      let q = H_TUBE_NATURAL * a * (zoneTemps[k] - ev.sections[0].T);
      if (mcp1 > 0) {
        const transit = (1 - Math.exp(-H_TUBE_LIQUID * a / mcp1)) * mcp1 * (zoneTemps[k] - T);
        T += transit / mcp1;
        q += transit;
      }
      zoneQ[k] += q;
      Q1 += q;
    }
  }
  // Section 2: boiling at T_sat - huge film coefficient, pure standing form
  let Q2 = 0;
  for (let k = 0; k < N; k++) {
    const q = H_TUBE_BOILING * heatArea * ov[k][1] * (zoneTemps[k] - ev.sat.T);
    zoneQ[k] += q;
    zoneQ2[k] += q;
    Q2 += q;
  }
  // Section 3: steam entering at saturation, heated toward its own wall -
  // which the boiling section can no longer clamp. The transit branch is the
  // partition's own march on the partition's own isobar (marchSteamOverMetal):
  // the heat each zone gives the stream is the enthalpy the stream gains
  // crossing it, so the steam offered at the outlet is the steam heated here.
  let Q3 = 0;
  if (ev.sections[2].lengthFrac > 0) {
    if (!ev.steamIsobar) {
      throw new Error(`[OTSG] a superheat section ${(100 * ev.sections[2].lengthFrac).toFixed(1)}% of ` +
        `the tube long (regime '${ev.regime}') came without its steam isobar - the wall duty ` +
        `has no property surface to price the stream on.`);
    }
    const { transit } = marchSteamOverMetal(ev.steamIsobar, zoneTemps, ov.map(o => o[2]),
      H_TUBE_STEAM * heatArea, Math.max(0, flows.WSteamOut), ev.sat.T);
    for (let k = 0; k < N; k++) {
      const a = heatArea * ov[k][2];
      if (!(a > 0)) continue;
      const q = H_TUBE_NATURAL * a * (zoneTemps[k] - ev.sections[2].T) + transit[k];
      zoneQ[k] += q;
      zoneQ3[k] += q;
      Q3 += q;
    }
  }
  return { Q1, Q2, Q3, TFeedIn, zoneQ, zoneQ2, zoneQ3 };
}

/**
 * The wall exchange of a tube whose water answers it faster than the step:
 * the OTSG counterpart of the stiff wall-fluid pairs (stiff-convection.ts), in two halves -
 * stampStiffOtsgTubes before the first stage, completeStiffOtsgTubes right
 * after it.
 *
 * Two arms, by which side of the seam (steam at the wall pin) the tube is on:
 *
 *  - Pinned arm (a boiling section present): the variable that answers is
 *    Q2. The partition gives the boiling section from the energy - at fixed
 *    pressure dm2/dU = -1/(u3 - u2), so adding dU* = m2 (u3 - u2) closes it -
 *    and the film is 25 kW/m2K, so Q2 falls as the water's energy rises at
 *    k = -dQ2/dU. Two routes: the section's own length (k >= Q2 / dU*), and
 *    the pressure, because boiling packs steam into the tube and raises
 *    T_sat under the whole film. On a dried-out tube blowing down (a sliver
 *    of grams that expansion keeps re-creating) the first is ~4 ms at 1 bar,
 *    ~0.4 ms at condenser vacuum; on a healthy flowing evaporator the second
 *    is ~20 ms (52 /s measured on the steady xe100). Q3, priced at the pin,
 *    does not depend on the water's energy (to the pin's theta ~ 1), so it
 *    stays constant over the step.
 *  - Free arm (no boiling section, steam off the pin): the variable is Q3,
 *    pulling grams of steam toward its wall across the whole bundle
 *    (k = hA3 / (m3 cv) ~ 2 ms at 0.6 kg).
 *  k is measured from the partition itself by a small energy probe (one more
 *  solve; the free arm probes closer in if the first probe already reaches
 *  the seam, where the slope is the other arm's).
 *
 * Stepped explicitly those time constants became the plant's step (the
 * xe100-dlofc crawl past ~7200 s, scripts/probe-step-limiter.ts). Where
 * k*dt > 1 - the resolution boundary, the same criterion as the convection
 * pairs - the tube is stamped: the rate operator leaves the stiff duty
 * (Q2 + Q3) out of its evaluation and adds instead a CONSTANT duty per zone
 * that integrates the stiff variable exactly over the step. Constant across
 * the stages, it integrates to exactly duty * dt in the 5th-order solution,
 * cancels out of the embedded error estimate (the E weights sum to zero),
 * and is booked in the step's rates (the pressure solver's measured heat
 * source sees it).
 *
 * The integral is of the whole tube's linearized energy balance, not the wall
 * term alone. With q the stiff duty and R everything else the tube's energy
 * receives (feed, steam out, Q1, and in the pinned arm the constant Q3 -
 * read from the first stage's rates, which are evaluated with the stiff duty
 * left out; completeStiffOtsgTubes), q' = -k (q + R), so
 *   q(t) = (q0 + R) e^{-kt} - R,   integral = (q0 + R)(1 - e^{-k dt})/k - R dt.
 * Leaving R out relaxes q toward zero - the fixed point of a sealed tube -
 * and on a flowing evaporator that under-booked the boiling by two thirds at
 * a 55 ms step (feed and steam out hold q at -R in steady state, which this
 * form returns exactly: q0 = -R gives q0 dt). Boiling cannot go negative on a
 * wall above saturation: when R > 0 (other heat closing the section) q stops
 * at zero at t* = ln((q0 + R)/R)/k, and the integral is q0/k - R t* if that
 * falls inside the step. The mass route of the drift (feed arriving changes
 * Q2 at fixed energy) is not linearized: in steady state it is zero, in a
 * transient it is the ordinary first-order splitting error.
 *
 * Zones: in both arms each zone's duty is H a_z (T_z - T_fluid) with ONE
 * fluid temperature for all of them (T_sat under the boiling section, T3
 * under free steam), and what relaxes over the step is that one temperature.
 * So the zones share the relaxation by area while their differences - heat
 * carried from metal above the fluid's temperature to metal below it - are
 * not stiff and stay whole: zone z gives Q_z - (a_z / A)(q0 - integral/dt),
 * plus, in the pinned arm, its Q3 whole. NEVER by scaling each zone's duty by
 * integral/(q0 dt). On the free arm that suppressed the mixing and drove the
 * feed-end metal 11 K colder in 120 s. On the pinned arm it is unbounded: a
 * boiling section lying over metal both hotter and colder than saturation
 * (a tripped bundle whose section has slid over the cold feed end) has a q0
 * that is the small difference of megawatts, and the ratio multiplied every
 * zone's duty by it - 679 W against a 4.6 MW mean threw the zones 80 GW
 * apart and left metal below absolute zero in one accepted step. (The area
 * split is exact for the pressure route, where T_sat moves under the whole
 * film; for the length route, where the change really sits at the moving
 * boundary, it spreads it over the section.)
 *
 * The metal gives up exactly what the water receives. Where k*dt <= 1, or
 * the tube is flooded (no seam), the stages are the better integrator and
 * nothing changes. Returns the number of tubes stamped.
 */
export function stampStiffOtsgTubes(state: SimulationState, dt: number): number {
  let n = 0;
  for (const [id, node] of state.flowNodes) {
    const cfg = node.otsg;
    if (!cfg) continue;
    cfg.wallImplicit = undefined;
    if (node.isBoundary || !(node.fluid.mass > 0)) continue;
    const { ev, flows } = evaluateOtsgSections(state, id, node, { exact: true });
    if (ev.regime !== 'superheat' && ev.regime !== 'dryout') continue;
    const [, s2, s3] = ev.sections;
    if (!(s3.mass > 0)) continue;
    const zoneT = otsgMetalZones(state, node).map(z => z.temperature);
    const d = otsgWaterSideDuties(ev, flows, zoneT, cfg.heatArea);
    if (s2.mass > 0) {
      if (!(d.Q2 > 0)) continue;
      const u2 = s2.hBar - ev.P * s2.vBar;
      const u3 = s3.hBar - ev.P * s3.vBar;
      const closeSection = s2.mass * (u3 - u2);
      if (!(closeSection > 0)) continue;
      // The probe stays inside the boiling section so the slope is this arm's
      const dU = Math.min(0.5 * closeSection, 1e-4 * Math.abs(node.fluid.internalEnergy));
      const probe: FlowNode = {
        ...node,
        fluid: { ...node.fluid, internalEnergy: node.fluid.internalEnergy + dU },
        otsg: { ...cfg, partitionCache: undefined, partitionLin: undefined },
      };
      const moved = evaluateOtsgSections(state, id, probe, { exact: true });
      const k = Math.max(d.Q2 / closeSection,
        -(otsgWaterSideDuties(moved.ev, moved.flows, zoneT, cfg.heatArea).Q2 - d.Q2) / dU);
      if (!(k * dt > 1)) continue;
      const N = zoneT.length;
      const ov = otsgZoneOverlaps(
        [ev.sections[0].lengthFrac, ev.sections[1].lengthFrac, ev.sections[2].lengthFrac], N);
      const L2 = ov.reduce((a, o) => a + o[1], 0);
      if (!(L2 > 0)) continue;
      cfg.wallImplicit = {
        arm: 'pinned', k, q0: d.Q2, zoneQ2: d.zoneQ2, zoneQ3: d.zoneQ3,
        share: ov.map(o => o[1] / L2),
      };
    } else {
      if (d.Q3 === 0) continue;
      // Probe toward where Q3 is heading, a thousandth of the tube's energy;
      // closer in if that already reaches the seam
      let k = NaN;
      for (const frac of [1e-3, 1e-5]) {
        const dU = frac * Math.abs(node.fluid.internalEnergy) * Math.sign(d.Q3);
        const probe: FlowNode = {
          ...node,
          fluid: { ...node.fluid, internalEnergy: node.fluid.internalEnergy + dU },
          otsg: { ...cfg, partitionCache: undefined, partitionLin: undefined },
        };
        const moved = evaluateOtsgSections(state, id, probe, { exact: true });
        if (moved.ev.sections[1].mass > 0) continue;
        k = -(otsgWaterSideDuties(moved.ev, moved.flows, zoneT, cfg.heatArea).Q3 - d.Q3) / dU;
        break;
      }
      if (!(k * dt > 1)) continue;
      const N = zoneT.length;
      const ov = otsgZoneOverlaps(
        [ev.sections[0].lengthFrac, ev.sections[1].lengthFrac, ev.sections[2].lengthFrac], N);
      const L3 = ov.reduce((a, o) => a + o[2], 0);
      if (!(L3 > 0)) continue;
      cfg.wallImplicit = {
        arm: 'free', k, q0: d.Q3, zoneQ2: d.zoneQ2, zoneQ3: d.zoneQ3,
        share: ov.map(o => o[2] / L3),
      };
    }
    n++;
  }
  return n;
}

/**
 * Second half of the stiff wall exchange (see stampStiffOtsgTubes): with the
 * first stage's rates k0 in hand - evaluated with the stamped tubes' stiff
 * duty left out, so k0's tube energy rate is R (less the pinned arm's
 * constant Q3) - set each stamped tube's constant zone duties for the step
 * and add them to k0, which was evaluated before they existed. Later stages
 * get them from the rate operator.
 */
export function completeStiffOtsgTubes(state: SimulationState, k0: StateRates, dt: number): void {
  for (const [id, node] of state.flowNodes) {
    const w = node.otsg?.wallImplicit;
    if (!w) continue;
    const zones = otsgMetalZones(state, node);
    const N = zones.length;
    const nodeRates = k0.flowNodes.get(id) ?? { dMass: 0, dEnergy: 0 };
    const Q3Const = w.arm === 'pinned' ? w.zoneQ3.reduce((a, b) => a + b, 0) : 0;
    const R = nodeRates.dEnergy + Q3Const;
    const { k, q0 } = w;
    // Boiling stops at zero inside the step when other heat closes the section
    const tStop = w.arm === 'pinned' && R > 0 ? Math.log((q0 + R) / R) / k : Infinity;
    const integral = tStop < dt
      ? q0 / k - R * tStop
      : (q0 + R) * (1 - Math.exp(-k * dt)) / k - R * dt;
    if (!Number.isFinite(integral)) {
      throw new Error(`[OTSG] stiff wall exchange on '${id}' produced a non-finite duty ` +
        `(arm ${w.arm}, k=${k}, q0=${q0}, R=${R}, dt=${dt})`);
    }
    const qMean = integral / dt;
    const zoneRate = new Array<number>(N);
    // The step-mean duty differs from the starting one by (q0 - qMean), and
    // the zones under the stiff section give that difference up by area;
    // what each zone was exchanging at the start stays whole.
    const notRelaxed = q0 - qMean;
    if (w.arm === 'pinned') {
      for (let j = 0; j < N; j++) zoneRate[j] = w.zoneQ2[j] + w.zoneQ3[j] - w.share[j] * notRelaxed;
    } else {
      for (let j = 0; j < N; j++) zoneRate[j] = w.zoneQ3[j] - w.share[j] * notRelaxed;
    }
    w.zoneRate = zoneRate;
    let total = 0;
    zones.forEach((z, j) => {
      total += zoneRate[j];
      const mr = k0.thermalNodes.get(z.id) ?? { dTemperature: 0 };
      mr.dTemperature -= zoneRate[j] / nodeHeatCapacity(z);
      k0.thermalNodes.set(z.id, mr);
    });
    nodeRates.dEnergy += total;
    k0.flowNodes.set(id, nodeRates);
  }
}

export class OtsgRateOperator implements RateOperator {
  name = 'OTSG';

  computeRates(state: SimulationState): StateRates {
    const rates = createZeroRates();

    for (const [id, node] of state.flowNodes) {
      const cfg = node.otsg;
      if (!cfg) continue;

      const zones = otsgMetalZones(state, node);
      const zoneT = zones.map(z => z.temperature);
      const N = zones.length;
      const shell = state.flowNodes.get(cfg.shellNodeId);
      if (!shell) {
        throw new Error(`[OTSG] node '${id}' references shell '${cfg.shellNodeId}', ` +
          `which does not exist.`);
      }

      // The sections are a description of the WATER, so they run at the
      // water's own partial pressure and account for the water's own share of
      // the node energy - identical to the stored totals unless gas has got
      // into the tubes (see tubeWaterState). Flows are classified by the
      // phase they actually carry, and the partition is solved from the
      // node's totals with this bundle's own metal as the superheat pin -
      // one shared path for operator, sensors, checks and probes.
      const { ev, flows } = evaluateOtsgSections(state, id, node);
      const { WFeed, hFeed, WSteamOut, WLiquidOut } = flows;

      // (The draw-enthalpy cache otsg.lastEval is owned by
      // OtsgPartitionConstraintOperator, which runs on every state before
      // rates - including the once-per-step pressure solve this operator
      // never sees.)

      // ----------------------------------------------------------------
      // Gas side: counterflow march against the metal temperature
      // ----------------------------------------------------------------
      const hGas = this.gasFilmCoefficient(shell, state);
      // March from the shell's INLET temperature (the upstream duct node),
      // not its bulk: with the duty evaluated from the inlet, the well-mixed
      // shell node's own energy balance lands its bulk exactly at the
      // plug-flow OUTLET temperature - the transit-branch principle applied
      // to the gas side. Marching from bulk instead left the cold leg 200 C
      // hot because the counterflow outlet never propagated downstream.
      const TGasIn = otsgGasInletTemp(state, shell);
      // Counterflow: the gas meets the steam end of the bundle first and
      // works down to the feed end, across each metal zone in turn. Every
      // zone has its own temperature - one shared wall cannot superheat
      // (boiling pins it to T_sat and clamps every other section's wall) -
      // and one temperature per zone makes the isothermal approach exact for
      // it; the wall's ramp along the bundle is the zones' own profile.
      // Parallel bundles in one shell each take their share of the gas
      // stream (equal areas -> equal flows), so each marches against its own
      // mdot*cp. Their duties then sum onto the shell node below, which is
      // the same total the single-bundle case delivers.
      const hAZone = hGas * cfg.heatArea / N;
      const gasOrder = zones.map((_, j) => N - 1 - j);
      const march = marchCounterflowGas(
        TGasIn,
        this.gasMcp(shell, state) * (cfg.gasShare ?? 1),
        gasOrder.map(k => ({ hA: hAZone, TWall: zoneT[k], wall: 'isothermal' as const })),
      );
      const gasQ = new Array<number>(N);
      gasOrder.forEach((k, j) => { gasQ[k] = march.Q[j]; });
      const QGasTotal = march.Q.reduce((a, b) => a + b, 0);


      // ----------------------------------------------------------------
      // Water side: transit + standing branches per section
      // ----------------------------------------------------------------
      const { Q1, Q2, Q3, zoneQ, zoneQ2, zoneQ3 } = otsgWaterSideDuties(ev, flows, zoneT, cfg.heatArea);
      // A tube stamped for this step (stampStiffOtsgTubes) takes its boiling
      // + superheat exchange as the step's constant zone duties instead of
      // the live Q2 + Q3; before completeStiffOtsgTubes has set them (the
      // first stage) it takes none, and the solver adds them to that stage.
      const implicitWall = cfg.wallImplicit;
      const zoneRate = implicitWall?.zoneRate;
      const QWaterTotal = implicitWall
        ? Q1 + (zoneRate ? zoneRate.reduce((a, b) => a + b, 0) : 0)
        : Q1 + Q2 + Q3;
      // OTSG_TRACE=<nodeId>: one line per 0.5 s of sim time with the
      // partition, the metal and the duties - the view that found the
      // bottled-boiler ring. Reads an env var once per evaluation; the
      // string compare is nothing next to the partition solve.
      const traceId = (globalThis as any).process?.env?.OTSG_TRACE;
      if (traceId === id) {
        const g: any = globalThis as any;
        const slot = Math.floor(state.time * 2);
        if (g.__otsgTraceSlot !== slot) {
          g.__otsgTraceSlot = slot;
          const sec = ev.sections;
          console.log(`[OTSG_TRACE] t=${state.time.toFixed(2)} P=${(ev.P / 1e5).toFixed(2)}bar ` +
            `m=${node.fluid.mass.toFixed(2)}kg u=${(node.fluid.internalEnergy / node.fluid.mass / 1e3).toFixed(0)}kJ/kg ` +
            `regime=${ev.regime} m123=${sec[0].mass.toFixed(2)}/${sec[1].mass.toFixed(2)}/${sec[2].mass.toFixed(2)} ` +
            `A123=${sec[0].area.toFixed(1)}/${sec[1].area.toFixed(1)}/${sec[2].area.toFixed(1)} ` +
            `T123=${(sec[0].T - 273).toFixed(0)}/${(sec[1].T - 273).toFixed(0)}/${(sec[2].T - 273).toFixed(0)} ` +
            `Tm=${zoneT.map(T => (T - 273).toFixed(0)).join('/')} ` +
            `Q123=${(Q1 / 1e6).toFixed(2)}/${(Q2 / 1e6).toFixed(2)}/${(Q3 / 1e6).toFixed(2)}MW Qgas=${(QGasTotal / 1e6).toFixed(2)}MW ` +
            `WFeed=${flows.WFeed.toFixed(2)} WSteam=${flows.WSteamOut.toFixed(2)} WLiq=${WLiquidOut.toFixed(2)}`);
        }
      }

      // ----------------------------------------------------------------
      // Partition rates: the economizer's own transit AND energy balances.
      // Feed enters at its enthalpy, mass crosses the boundary at h_f as
      // fast as the wall can heat it there (W12 = Q1/(h_f - h_a)), the wall
      // adds Q1, and a liquid draw takes slug water with it - weighted so
      // an emptying section never steps its own rate, and at the SAME
      // weighted mass on both books so the pair keeps describing a profile.
      // A draw's energy costs the section u1 per kg: its enthalpy out less
      // the boundary work the vacated volume does, which is the flow work
      // it left with. The boiling/superheat split (and the pressure) are
      // solved, not stepped.
      // ----------------------------------------------------------------
      // A domeless tube (supercritical) has no phase boundary for the
      // transit balance to move - otsgRates' interface algebra divides by
      // widths that do not exist there and returns garbage that once walked
      // the ledger from 227 to 373 kg in a second. The ledger holds still
      // and resumes when the dome comes back.
      let dM1 = 0, dU1 = 0;
      if (ev.regime !== 'supercritical') {
        const r = otsgRates(ev, WFeed, hFeed, WSteamOut, Q1, Q2, Q3);
        const m1Now = ev.sections[0].mass;
        const w1 = m1Now / (m1Now + 1);
        const WSlugOut = w1 * WLiquidOut;
        const u1Now = ev.sections[0].hBar - ev.P * ev.sections[0].vBar;
        dM1 = r.dm1 - WSlugOut;
        dU1 = r.dU1 - WSlugOut * u1Now;
      }

      const nodeRates = rates.flowNodes.get(id) ?? { dMass: 0, dEnergy: 0 };
      nodeRates.dEnergy += QWaterTotal;
      nodeRates.dOtsgM1 = (nodeRates.dOtsgM1 ?? 0) + dM1;
      nodeRates.dOtsgU1 = (nodeRates.dOtsgU1 ?? 0) + dU1;
      rates.flowNodes.set(id, nodeRates);

      const shellRates = rates.flowNodes.get(cfg.shellNodeId) ?? { dMass: 0, dEnergy: 0 };
      shellRates.dEnergy -= QGasTotal;
      rates.flowNodes.set(cfg.shellNodeId, shellRates);

      // Each zone balances its own gas-in against whatever water covers it;
      // axial conduction along the bundle is negligible against either.
      zones.forEach((z, k) => {
        const mr = rates.thermalNodes.get(z.id) ?? { dTemperature: 0 };
        const waterQ = implicitWall
          ? zoneQ[k] - zoneQ2[k] - zoneQ3[k] + (zoneRate ? zoneRate[k] : 0)
          : zoneQ[k];
        mr.dTemperature += (gasQ[k] - waterQ) / nodeHeatCapacity(z);
        rates.thermalNodes.set(z.id, mr);
      });
    }

    return rates;
  }

  /** Shell-gas film coefficient (W/m2-K): Dittus-Boelter on the shell node's
   *  through-flow, mixture properties, with a natural-convection floor. */
  private gasFilmCoefficient(shell: FlowNode, state: SimulationState): number {
    return otsgGasFilmCoefficient(shell, state);
  }

  private gasMcp(shell: FlowNode, state: SimulationState): number {
    return otsgGasMcp(shell, state);
  }
}

/** Liquid temperature from enthalpy (saturated-liquid-line inversion). */
function tempOfLiquidH(h: number): number {
  // h ~ u for liquid at these pressures within ~2%; invert along u_f
  let Tlo = 274, Thi = 640;
  const u = h; // Pv correction ~ 20 kJ/kg at 165 bar - inside correlation noise
  if (u <= saturatedLiquidEnergy(Tlo)) return Tlo;
  if (u >= saturatedLiquidEnergy(Thi)) return Thi;
  for (let i = 0; i < 50; i++) {
    const Tm = 0.5 * (Tlo + Thi);
    if (saturatedLiquidEnergy(Tm) < u) Tlo = Tm; else Thi = Tm;
    if (Thi - Tlo < 0.01) break;
  }
  return 0.5 * (Tlo + Thi);
}

/**
 * Publish the partition's own pressure (and mean temperature and vapor
 * fraction) as the tube node's fluid state.
 *
 * FluidStateConstraintOperator writes every node's (P, T, phase) from the
 * uniform (u, v) read - and for a boiler tube that read is biased tens of
 * bar LOW, because cold slug and superheated steam both sit below the
 * saturation tie line and their blend looks like low-pressure two-phase
 * mush (a partition built at 80 bar reads back at 53). The flow solver, the
 * relief valves and the governor were all steering on that fiction. This
 * runs AFTER FluidState on every stage and overwrites the tube's published
 * state with the partition's: the pressure that actually packs the sections
 * into the tube volume (plus any NCG partial), the mass-weighted section
 * temperature, and the partition's vapor fraction.
 */
export class OtsgPartitionConstraintOperator implements ConstraintOperator {
  name = 'OtsgPartition';

  applyConstraints(state: SimulationState): SimulationState {
    return this.applyImpl(state);
  }

  applyConstraintsMutating(state: SimulationState): SimulationState {
    return this.applyImpl(state);
  }

  private applyImpl(state: SimulationState): SimulationState {
    for (const [id, node] of state.flowNodes) {
      if (!node.otsg) continue;
      if (!(node.fluid.mass > 0)) continue;
      const { ev, water, exact } = evaluateOtsgSections(state, id, node);
      node.fluid.pressure = ev.P + water.gasPressure;
      // The economizer boundary moved with this state's pressure (flash /
      // joining, reconcileSlug): make the moved (mass, energy) pair the
      // ledger and record the saturation it is now consistent with. Only from an EXACT
      // solve - a tangent-riding evaluation carries its anchor's sections,
      // and writing those over the integrated ledger would erase the
      // step's transit. At the same pressure the reconciliation of the
      // written pair is the identity, so the cached evaluation stays valid
      // for it: re-key the cache instead of paying for a second solve on the
      // same state.
      if (exact && ev.regime !== 'supercritical') {
        const m1New = ev.sections[0].mass;
        const U1New = m1New * (ev.sections[0].hBar - ev.P * ev.sections[0].vBar);
        node.otsg.m1 = m1New;
        node.otsg.U1 = U1New;
        node.otsg.uFRef = ev.sat.u_f;
        // Replace, never mutate: the cache and tangent objects are shared by
        // every clone of this state (otsg is spread-copied). The tangent
        // anchor is left alone - its band test reconciles both sides to the
        // anchor's pressure, so re-basing this state does not move it.
        if (node.otsg.partitionCache) {
          node.otsg.partitionCache = { ...node.otsg.partitionCache, forM1: m1New, forU1: U1New, forUFRef: ev.sat.u_f };
        }
      }
      // Refresh the draw-enthalpy cache HERE, where every state passes -
      // the rate operator's write lands on stage clones and never reaches
      // the accepted state or the once-per-step pressure solve, and a vapor
      // draw priced at the bulk instead (2x too cheap on a slug-heavy tube)
      // leaves the vapor's energy behind: the totals inflate over the
      // ledger until no pressure can pack the partition. Measured on the
      // bundle rig: 93 kg drawn at 1.46 MJ/kg where the superheat section
      // held ~3.
      // The pressure solver's compliance stiffness rides the same tangent
      // the stage evaluations use (partitionLin); a neighborhood with no
      // tangent (regime edge) reports 0 and the generic compliance carries
      // it, which is the correct price at a boundary.
      const dPdm = Math.max(0, node.otsg.partitionLin?.dPdm ?? 0);
      node.otsg.lastEval = {
        P: ev.P,
        dPdm,
        hSteamOut: ev.hSteamOut,
        hLiquidOut: ev.sections[0].hBar,
        vSteamOut: ev.vSteamOut,
        vLiquidOut: ev.sections[0].vBar,
        TSat: ev.sat.T,
        T3: ev.sections[2].T,
        lengthFracs: [ev.sections[0].lengthFrac, ev.sections[1].lengthFrac, ev.sections[2].lengthFrac],
      };
      if (ev.regime === 'supercritical') {
        // One fluid: the uniform read FluidState already wrote is unbiased
        // above the dome - only the (identical) pressure is restated.
        continue;
      }
      const m = node.fluid.mass;
      const [s1, s2, s3] = ev.sections;
      node.fluid.temperature = (s1.mass * s1.T + s2.mass * s2.T + s3.mass * s3.T) / m;
      // Vapor MASS fraction: the boiling section's mean quality carries its
      // share, the superheat section is all vapor.
      const x2Bar = (s2.vBar - ev.sat.v_f) / (ev.sat.v_g - ev.sat.v_f);
      const quality = (s2.mass * Math.max(0, x2Bar) + s3.mass) / m;
      node.fluid.quality = quality;
      node.fluid.phase = quality <= 0 ? 'liquid' : quality >= 1 ? 'vapor' : 'two-phase';
    }
    return state;
  }
}

/**
 * Is the steam section hotter than anything that could have heated it?
 *
 * With the partition solved from the node's totals and pinned by the wall,
 * steam hotter than every surface around it can only appear through the
 * closure's UNPINNED regimes - the post-depressurization transient where a
 * subcooled slug sits directly under flash-heated vapor. That state is
 * physical for a while and relaxes through Q3 running backwards; one that
 * PERSISTS means either the upstream physics is genuinely pumping energy in
 * (worth seeing) or a regime is stuck (a bug). Report, never clamp: the
 * number is the size of whatever is going on, and this is where it is
 * visible.
 *
 * Runs postAcceptOnly - trial stages routinely swing far harder than the
 * trajectory the plant actually follows, and a guard that cries wolf on them
 * is worse than no guard.
 */
export class OtsgLedgerCheckOperator implements ConstraintOperator {
  name = 'OtsgLedgerCheck';
  /** ACCEPTED states only - reporting on a candidate the solver then rejects
   *  is the crying-wolf this check exists to avoid. */
  postAcceptOnly = true;

  /** K - how far above the hottest wall a superheat section has to land before
   *  it is reported. Compression heating in a fast pressurization is worth
   *  tens of kelvin, so this sits above that. A reporting width only: no
   *  rate depends on it. */
  private static readonly REPORT_MARGIN = 50;
  /** Once per 10 s of SIM time per bundle - keyed on sim time, not wall time,
   *  so a replay reports identically. */
  private static readonly QUIET_SECONDS = 10;
  private lastReport = new Map<string, number>();

  applyConstraints(state: SimulationState): SimulationState {
    for (const [id, node] of state.flowNodes) {
      const cfg = node.otsg;
      if (!cfg) continue;
      // NOT { exact: true }. This watch asks whether the ledger the physics
      // is running has drifted, so it has to read the evaluation the physics
      // actually used - the one OtsgPartitionConstraintOperator just cached
      // for this very accepted state. Asking for `exact` re-solved the
      // partition AND re-anchored its tangent (four warm-started solves per
      // bundle) on every accepted step, purely to feed a diagnostic: on the
      // Xe-100 that was 49% of total simulation wall time. It also judged the
      // physics against numbers the physics never saw, which is the quiet
      // disagreement the single-entry-point rule above exists to prevent.
      // Both tests below are gross - a 50 K margin and a 99.5% claim - while
      // the tangent band is 0.4% of mass, orders of magnitude inside them.
      const { ev, water } = evaluateOtsgSections(state, id, node);

      // The hottest surface this water can see: its own tube metal, or the gas
      // arriving at the shell.
      let TWallMax = state.flowNodes.get(cfg.shellNodeId)?.fluid.temperature ?? 0;
      for (const mid of cfg.metalNodeIds) {
        const m = state.thermalNodes.get(mid);
        if (m && m.temperature > TWallMax) TWallMax = m.temperature;
      }

      // Two distinct diseases, one watch. (1) Steam hotter than every
      // surface around it: only the unpinned (post-depressurization) regime
      // can produce it, and it should relax through Q3 - persisting means
      // upstream physics is pumping energy in or a regime is stuck.
      // (2) The ledger claiming the whole inventory: the economizer's
      // transit balance has walked away from the water actually in the tube
      // - this is the drift this closure is designed to make VISIBLE rather
      // than absorb. (It also fires on a tube that has genuinely gone water
      // solid, where a 99.8% claim is the truth; the condition that would
      // separate the two is the integrator's ceiling CLIPPING the pair,
      // which scripts/probe-otsg-draw.ts measures directly.)
      const m1Claim = ev.sections[0].mass / node.fluid.mass;
      const excess = ev.sections[2].T - TWallMax;
      const hotSteam = excess > OtsgLedgerCheckOperator.REPORT_MARGIN;
      const overClaim = m1Claim > 0.995 && node.fluid.phase !== 'liquid';
      if (!hotSteam && !overClaim) continue;
      const last = this.lastReport.get(id);
      if (last !== undefined && state.time - last < OtsgLedgerCheckOperator.QUIET_SECONDS) continue;
      this.lastReport.set(id, state.time);

      // The slug's own state, as the profile the pair describes: mean u,
      // and the cold end 2 u1 - u_f it implies. A drifting pair shows up
      // here first - as a cold end below the coldest water the plant has,
      // or one that has climbed to saturation.
      const s1 = ev.sections[0];
      const u1 = s1.mass > 0 ? s1.hBar - ev.P * s1.vBar : NaN;
      const where = `Node: ${(node.fluid.pressure / 1e5).toFixed(1)} bar published, ` +
        `${node.fluid.mass.toFixed(0)} kg, ` +
        `u=${(water.energy / node.fluid.mass / 1e3).toFixed(0)} kJ/kg, ` +
        `v=${(node.volume / node.fluid.mass).toFixed(5)} m3/kg; ` +
        `sections ${ev.sections.map(x => x.mass.toFixed(0)).join('/')} kg, ` +
        `economizer ledger=${node.otsg!.m1.toFixed(0)} kg carrying ` +
        `${(node.otsg!.U1 / 1e6).toFixed(0)} MJ (profile ` +
        `${((2 * u1 - ev.sat.u_f) / 1e3).toFixed(0)} -> ${(ev.sat.u_f / 1e3).toFixed(0)} kJ/kg, ` +
        `mean ${(u1 / 1e3).toFixed(0)}), '${ev.regime}' branch.`;
      if (hotSteam) {
        console.error(
          `[OTSG] ${id}: the steam section is ${excess.toFixed(0)} K ABOVE the hottest surface ` +
          `heating it (${(ev.sections[2].T - 273.15).toFixed(0)} C vs ` +
          `${(TWallMax - 273.15).toFixed(0)} C) at t=${state.time.toFixed(1)} s, longer than a ` +
          `depressurization transient explains. ${where}`
        );
      } else {
        console.error(
          `[OTSG] ${id}: the economizer ledger claims ${(100 * m1Claim).toFixed(1)}% of the ` +
          `node's inventory at t=${state.time.toFixed(1)} s while the node is not liquid - ` +
          `its transit balance has drifted from the water actually in the tube. ${where}`
        );
      }
    }
    return state;
  }
}
