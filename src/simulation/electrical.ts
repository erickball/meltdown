/**
 * Electrical power: which loads are energized, what each piece of the
 * network carries, and what happens when something is overloaded or runs dry.
 *
 * Optional: a plant turns it on with PlantState.electrical.enabled. Without
 * it, SimulationState.electrical is absent and every load behaves as it
 * always has (powered). With it, a pump runs only while its motor's bus is
 * live, a controller scans only while its cabinet has power, and so on.
 *
 * WHAT IS MODELLED
 * - Real power only. No phases, no power factor, no voltage drop, no motor
 *   starting current: the question asked is whether the energy is there and
 *   whether a source is being asked for more than it can give.
 * - The network is the plant's `powerSupplyId` wiring (plus a bus's backup
 *   feed), sources upstream. It is solved once per accepted step, like the
 *   control system: flags written here are read by the physics on the next
 *   step, the way a relay's contacts follow the bus it watches.
 * - Energized: a source is live (grid there, diesel up to speed with fuel,
 *   battery with charge or a live charger); a transformer/breaker/bus is
 *   live when one of its feeds is live AND at the voltage it accepts. A feed
 *   at the wrong voltage is a wiring fault: it is reported and carries
 *   nothing.
 * - Load sharing: an element fed from several live feeds (a bus on its
 *   normal supply and its diesel) splits its load between them in proportion
 *   to what each can deliver - how paralleled sources on droop governors
 *   share.
 * - Overload: every rated element carries an inverse-time overcurrent relay,
 *   modelled as a first-order thermal element theta' = ((P/rating)^2 - theta)
 *   / tau. Its steady value at rated load is exactly 1 and it trips above 1:
 *   10% over takes ~1.7 tau, double load ~0.3 tau. A tripped element stays
 *   dead until someone resets it; the relay keeps its heat, so reclosing
 *   onto the same overload trips again almost at once rather than after the
 *   full first-trip time.
 * - Motors restart by themselves when their bus comes back (a load
 *   sequencer's job in a real plant). The operator's START/STOP switch is
 *   untouched by a loss of power.
 * - Loss of power to the rod drives or the reactor protection cabinet trips
 *   the reactor: both are de-energize-to-trip.
 */

import type { PlantState, PlantComponent } from '../types';
import type {
  SimulationState, ElectricalState, ElecElement, ElecLoad, FlowConnection,
} from './types';
import type { ConstraintOperator } from './rk45-solver';
import { cloneSimulationState } from './solver';
import { pumpHeadFraction } from './operators/pump-curve';
import {
  loadSpecFor, voltageClassOf, formatVoltage, formatPower, VOLTAGE_CLASS_LABEL,
  MOTOR_EFFICIENCY, CONTROL_CABINET_W, ROD_DRIVE_W, ELECTRICAL_ELEMENT_TYPES,
} from './electrical-rules';

const G = 9.81;

/**
 * Thermal time constant of the overcurrent relays (s). Motor-feeder and
 * transformer overload relays are set to ride through tens of seconds of
 * moderate overload and clear gross overloads in a few seconds; 30 s puts
 * 110% at ~50 s and 200% at ~9 s.
 */
export const RELAY_TIME_CONSTANT_S = 30;

/**
 * A diesel burns about a quarter of its full-load fuel rate idling; the rest
 * scales with the load it carries.
 */
export const DIESEL_NO_LOAD_FUEL_FRACTION = 0.25;

// ============================================================================
// Build
// ============================================================================

function num(v: unknown, what: string, id: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`[Electrical] '${id}': ${what} is ${JSON.stringify(v)}, not a number`);
  }
  return n;
}

function positive(v: unknown, what: string, id: string): number {
  const n = num(v, what, id);
  if (!(n > 0)) throw new Error(`[Electrical] '${id}': ${what} must be positive, got ${n}`);
  return n;
}

function fraction(v: unknown, what: string, id: string): number {
  const n = num(v, what, id);
  if (n < 0 || n > 1) throw new Error(`[Electrical] '${id}': ${what} must be between 0 and 1, got ${n}`);
  return n;
}

function blankElement(c: PlantComponent): Pick<ElecElement, 'id' | 'label' | 'energized' | 'demandW' | 'overload' | 'tripped'> {
  return { id: c.id, label: c.label || c.id, energized: false, demandW: 0, overload: 0, tripped: false };
}

function elementFromComponent(component: PlantComponent): ElecElement | null {
  const c = component as Record<string, any>;
  const id = component.id;
  switch (component.type) {
    case 'switchyard':
      return {
        ...blankElement(component), kind: 'offsite', feeds: [],
        voltage: positive(c.transmissionVoltage ?? 345, 'transmission voltage (kV)', id) * 1000,
        dc: false,
        ratingW: positive(c.transformerRating ?? 1200, 'transformer rating (MW)', id) * 1e6,
        available: c.offsiteAvailable ?? true,
      };
    case 'bus':
      return {
        ...blankElement(component), kind: 'bus',
        feeds: [c.powerSupplyId, c.backupPowerSupplyId].filter((f): f is string => !!f),
        voltage: positive(c.voltage, 'voltage', id),
        dc: !!c.dc,
        ratingW: Infinity,
      };
    case 'transformer':
      return {
        ...blankElement(component), kind: 'transformer',
        feeds: c.powerSupplyId ? [c.powerSupplyId] : [],
        voltage: positive(c.secondaryVoltage, 'secondary voltage', id),
        inputVoltage: positive(c.primaryVoltage, 'primary voltage', id),
        dc: false,
        ratingW: positive(c.ratingMVA, 'rating (MVA)', id) * 1e6,
      };
    case 'breaker':
      return {
        ...blankElement(component), kind: 'breaker',
        feeds: c.powerSupplyId ? [c.powerSupplyId] : [],
        voltage: NaN,   // whatever its feed is: resolved every solve
        dc: false,
        ratingW: positive(c.ratingKW, 'rating (kW)', id) * 1e3,
        closed: c.closed ?? true,
      };
    case 'diesel-generator': {
      const ratingW = positive(c.ratingKW, 'rating (kW)', id) * 1e3;
      const startTime = num(c.startTime, 'start time', id);
      if (startTime < 0) throw new Error(`[Electrical] '${id}': start time must not be negative, got ${startTime}`);
      const fuelCapacityJ = ratingW * positive(c.fuelHours, 'fuel supply (h)', id) * 3600;
      const running = !!c.running;
      return {
        ...blankElement(component), kind: 'diesel', feeds: [],
        voltage: positive(c.voltage, 'voltage', id),
        dc: false,
        ratingW,
        running,
        startTime,
        // A diesel the plant is built with running is already up to speed
        startElapsed: running ? startTime : 0,
        autoStart: c.autoStart ?? true,
        fuelCapacityJ,
        fuelJ: fuelCapacityJ * fraction(c.fuelFraction ?? 1, 'fuel level', id),
      };
    }
    case 'battery': {
      const capacityJ = positive(c.capacityKWh, 'capacity (kWh)', id) * 3.6e6;
      const dischargeW = positive(c.dischargeKW, 'discharge rating (kW)', id) * 1e3;
      const chargerW = positive(c.chargerKW, 'charger rating (kW)', id) * 1e3;
      return {
        ...blankElement(component), kind: 'battery',
        feeds: c.powerSupplyId ? [c.powerSupplyId] : [],
        voltage: positive(c.voltage, 'voltage', id),
        dc: true,
        ratingW: dischargeW + chargerW,
        capacityJ,
        energyJ: capacityJ * fraction(c.chargeFraction ?? 1, 'state of charge', id),
        dischargeW,
        chargerW,
      };
    }
    default:
      return null;
  }
}

/** Element ids with every feed before whatever it feeds. Throws on a loop. */
function feedOrder(elements: Record<string, ElecElement>): string[] {
  const order: string[] = [];
  const mark = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: string[]) => {
    const m = mark.get(id);
    if (m === 'done') return;
    if (m === 'visiting') {
      const loop = [...path.slice(path.indexOf(id)), id].map(x => elements[x]?.label ?? x);
      throw new Error(
        `[Electrical] The power wiring runs in a circle: ${loop.join(' -> ')}. ` +
        `Every element must be fed from upstream of itself - change one of these supplies.`);
    }
    mark.set(id, 'visiting');
    for (const f of elements[id].feeds) if (elements[f]) visit(f, [...path, id]);
    mark.set(id, 'done');
    order.push(id);
  };
  for (const id of Object.keys(elements).sort()) visit(id, []);
  return order;
}

/**
 * The plant's electrical network, as simulation state, or undefined when the
 * plant does not use the electrical model. `plant` must already be the
 * factory's filtered plant (no ghosts under construction).
 */
export function buildElectricalState(plant: PlantState): ElectricalState | undefined {
  if (!plant.electrical?.enabled) return undefined;
  const elements: Record<string, ElecElement> = {};
  const loads: Record<string, ElecLoad> = {};
  for (const component of plant.components.values()) {
    const el = elementFromComponent(component);
    if (el) {
      elements[component.id] = el;
      continue;
    }
    const spec = loadSpecFor(component as Record<string, any>);
    if (!spec) continue;
    loads[component.id] = {
      id: component.id,
      kind: spec.kind,
      label: component.label || component.id,
      supplyId: component.powerSupplyId || undefined,
      voltageClass: spec.voltageClass,
      ratedW: spec.ratedW,
      demandW: 0,
      powered: false,
    };
  }
  return { elements, loads, order: feedOrder(elements) };
}

// ============================================================================
// Solve
// ============================================================================

/** Why feed `f` cannot supply element `e`, or null if it can. */
function feedMismatch(e: ElecElement, f: ElecElement): string | null {
  if (!(f.voltage > 0)) return null;  // an unfed breaker: dead, not miswired
  switch (e.kind) {
    case 'bus':
      if (f.voltage !== e.voltage || f.dc !== e.dc) {
        return `fed from ${f.label} at ${formatVoltage(f.voltage, f.dc)}, but it is a ${formatVoltage(e.voltage, e.dc)} bus`;
      }
      return null;
    case 'transformer':
      if (f.dc || f.voltage !== e.inputVoltage) {
        return `its primary is ${formatVoltage(e.inputVoltage!, false)}, but ${f.label} is ${formatVoltage(f.voltage, f.dc)}`;
      }
      return null;
    case 'battery':
      if (voltageClassOf(f.voltage, f.dc) !== 'lv') {
        return `its charger needs ${VOLTAGE_CLASS_LABEL.lv}, but ${f.label} is ${formatVoltage(f.voltage, f.dc)}`;
      }
      return null;
    default:
      return null;
  }
}

function connectionIndex(state: SimulationState): Map<string, FlowConnection> {
  const m = new Map<string, FlowConnection>();
  for (const conn of state.flowConnections) m.set(conn.id, conn);
  return m;
}

/**
 * Electrical input a powered load draws right now (W).
 *
 * A pump's shaft power is its hydraulic power on its own head curve plus the
 * losses that make up its efficiency at the rated point, scaled by the cube
 * of speed (affinity). At the rated point this is exactly rated flow x g x
 * rated head / efficiency; at shutoff it is the loss term alone. The
 * hydraulic part is a magnitude: running against reverse flow the fluid
 * is not doing work on the motor, the motor is dissipating it.
 */
function loadDemandW(load: ElecLoad, state: SimulationState, conns: Map<string, FlowConnection>): number {
  switch (load.kind) {
    case 'pump': {
      const p = state.components.pumps.get(load.id)!;
      if (!p.running) return 0;
      const s = p.effectiveSpeed;
      const mdot = conns.get(p.connectedFlowPath)?.massFlowRate ?? 0;
      const head = p.ratedHead * pumpHeadFraction(mdot, p.ratedFlow, s);
      const hydraulic = Math.abs(mdot * G * head);
      const losses = (1 / p.efficiency - 1) * p.ratedFlow * G * p.ratedHead * s * s * s;
      return (hydraulic + losses) / MOTOR_EFFICIENCY;
    }
    case 'heater':
      return state.flowNodes.get(load.id)?.heaterPower ?? 0;
    case 'controller':
    case 'rps':
      return CONTROL_CABINET_W;
    case 'rod-drive':
      return ROD_DRIVE_W;
    case 'mov':
    case 'porv':
      // A valve operator draws only while it strokes, for seconds at a time;
      // it needs a live bus to move but adds nothing to the steady load.
      return 0;
  }
}

function pushEvent(state: SimulationState, type: string, message: string): void {
  if (!state.pendingEvents) state.pendingEvents = [];
  state.pendingEvents.push({ type, message });
}

function trip(state: SimulationState, e: ElecElement): void {
  e.tripped = true;
  if (e.kind === 'breaker') e.closed = false;
  if (e.kind === 'diesel') e.running = false;
  const pct = isFinite(e.ratingW) ? ` at ${(100 * e.demandW / e.ratingW).toFixed(0)}% of its rating` : '';
  pushEvent(state, 'electrical', `${e.label} tripped on overload${pct}`);
}

/**
 * Solve the network on `state` (mutated in place) and advance its stores
 * (battery charge, diesel fuel and start-up, relay heating) by `dt`. dt = 0
 * solves without advancing - the factory's initial solve.
 */
export function solveElectrical(state: SimulationState, dt: number): void {
  const E = state.electrical;
  if (!E) return;
  const els = E.elements;
  const weight: Record<string, number> = {};
  const liveFeeds: Record<string, string[]> = {};

  // ---- 1. What is energized, and what each element could deliver ----------
  for (const id of E.order) {
    const e = els[id];
    e.fault = undefined;
    // A breaker is whatever its feed is
    if (e.kind === 'breaker') {
      const f = els[e.feeds[0]];
      e.voltage = f ? f.voltage : NaN;
      e.dc = f ? f.dc : false;
    }
    const live: string[] = [];
    for (const fid of e.feeds) {
      const f = els[fid];
      if (!f) {
        e.fault = `its supply '${fid}' is not part of the electrical system`;
        continue;
      }
      const mismatch = feedMismatch(e, f);
      if (mismatch) {
        e.fault = mismatch;
        continue;
      }
      if (f.energized) live.push(fid);
    }
    liveFeeds[id] = live;
    const through = live.reduce((sum, f) => sum + weight[f], 0);

    switch (e.kind) {
      case 'offsite':
        e.energized = !!e.available && !e.tripped;
        weight[id] = e.energized ? e.ratingW : 0;
        break;
      case 'diesel':
        e.energized = !!e.running && !e.tripped && e.startElapsed! >= e.startTime! && e.fuelJ! > 0;
        weight[id] = e.energized ? e.ratingW : 0;
        break;
      case 'battery': {
        const chargerLive = live.length > 0;
        const cellsLive = e.energyJ! > 0;
        e.energized = !e.tripped && (chargerLive || cellsLive);
        weight[id] = e.energized ? (cellsLive ? e.dischargeW! : 0) + (chargerLive ? e.chargerW! : 0) : 0;
        break;
      }
      case 'transformer':
        e.energized = !e.tripped && live.length > 0;
        weight[id] = e.energized ? Math.min(e.ratingW, through) : 0;
        break;
      case 'breaker':
        e.energized = !!e.closed && !e.tripped && live.length > 0;
        weight[id] = e.energized ? Math.min(e.ratingW, through) : 0;
        break;
      case 'bus':
        e.energized = live.length > 0;
        weight[id] = e.energized ? through : 0;
        break;
    }
  }

  // ---- 2. Loads: powered, and what they draw --------------------------------
  const conns = connectionIndex(state);
  for (const load of Object.values(E.loads)) {
    load.fault = undefined;
    load.powered = false;
    const s = load.supplyId ? els[load.supplyId] : undefined;
    if (!load.supplyId) {
      load.fault = 'not connected to a power supply';
    } else if (!s) {
      load.fault = `its supply '${load.supplyId}' is not part of the electrical system`;
    } else if (!(s.voltage > 0)) {
      load.fault = `${s.label} is not fed from anything`;
    } else if (voltageClassOf(s.voltage, s.dc) !== load.voltageClass) {
      load.fault = `needs ${VOLTAGE_CLASS_LABEL[load.voltageClass]}, but ${s.label} is ${formatVoltage(s.voltage, s.dc)}`;
    } else {
      load.powered = s.energized;
    }
    load.demandW = load.powered ? loadDemandW(load, state, conns) : 0;
  }

  // ---- 3. Demand, from the loads back up to the sources ---------------------
  for (const id of E.order) els[id].demandW = 0;
  for (const load of Object.values(E.loads)) {
    if (load.powered) els[load.supplyId!].demandW += load.demandW;
  }
  for (let i = E.order.length - 1; i >= 0; i--) {
    const e = els[E.order[i]];
    let input = e.demandW;
    if (e.kind === 'battery') {
      // The charger carries the DC load first; the cells make up the rest,
      // and whatever the charger has spare goes into the cells, tapering to
      // nothing as they fill (a constant-voltage finish).
      const chargerLive = liveFeeds[e.id].length > 0;
      const fromCharger = chargerLive ? Math.min(e.demandW, e.chargerW!) : 0;
      e.cellsW = e.demandW - fromCharger;
      e.chargeW = chargerLive ? (e.chargerW! - fromCharger) * (1 - e.energyJ! / e.capacityJ!) : 0;
      input = fromCharger + e.chargeW;
    }
    if (input === 0) continue;
    if (!e.energized) {
      throw new Error(
        `[Electrical] '${e.id}' is dead but carries ${formatPower(input)} - a load was counted ` +
        `as powered from a dead supply. This is a bug in the electrical solve.`);
    }
    const feeds = liveFeeds[e.id];
    if (feeds.length === 0) continue;  // a source: the demand stops here
    const total = feeds.reduce((sum, f) => sum + weight[f], 0);
    if (!(total > 0)) {
      throw new Error(
        `[Electrical] '${e.id}' is energized from ${feeds.join(', ')} but they can deliver ` +
        `nothing (total capacity ${total} W). This is a bug in the electrical solve.`);
    }
    for (const f of feeds) els[f].demandW += input * weight[f] / total;
  }

  // ---- 4. Advance the stores by dt -----------------------------------------
  if (dt > 0) {
    const cool = Math.exp(-dt / RELAY_TIME_CONSTANT_S);
    for (const id of E.order) {
      const e = els[id];
      // Relay heating: the battery's rating is what it can deliver right now
      const rating = e.kind === 'battery' ? weight[id] : e.ratingW;
      if (isFinite(rating)) {
        const r = rating > 0 ? e.demandW / rating : 0;
        e.overload = r * r + (e.overload - r * r) * cool;
        if (!e.tripped && e.overload > 1) trip(state, e);
      }

      if (e.kind === 'battery') {
        const delivered = e.energyJ! > 0 ? Math.min(e.energyJ!, e.cellsW! * dt) : 0;
        e.energyJ = e.energyJ! - delivered + e.chargeW! * dt;
        if (e.energyJ > e.capacityJ!) {
          throw new Error(`[Electrical] Battery '${e.id}' charged past its capacity - the charge taper is broken.`);
        }
        if (e.energyJ <= 0 && delivered > 0) {
          pushEvent(state, 'electrical', `${e.label} is exhausted`);
        }
      }

      if (e.kind === 'diesel' && e.running) {
        e.startElapsed = e.startElapsed! + dt;
        const burnW = DIESEL_NO_LOAD_FUEL_FRACTION * e.ratingW + (1 - DIESEL_NO_LOAD_FUEL_FRACTION) * e.demandW;
        e.fuelJ = e.fuelJ! - Math.min(e.fuelJ!, burnW * dt);
        if (e.fuelJ <= 0) {
          e.running = false;
          pushEvent(state, 'electrical', `${e.label} has run out of fuel and stopped`);
        }
      }
    }
  }

  // Emergency diesels start on a dead bus they feed
  for (const id of E.order) {
    const d = els[id];
    if (d.kind !== 'diesel' || d.running || d.tripped || !d.autoStart || !(d.fuelJ! > 0)) continue;
    const deadBus = E.order.find(x => els[x].feeds.includes(id) && !els[x].energized);
    if (deadBus) {
      d.running = true;
      d.startElapsed = 0;
      pushEvent(state, 'electrical', `${d.label} auto-started: ${els[deadBus].label} is dead`);
    }
  }

  // ---- 5. Hand the result to the physics ------------------------------------
  let lostTripPower: ElecLoad | undefined;
  for (const load of Object.values(E.loads)) {
    switch (load.kind) {
      case 'pump': {
        const p = state.components.pumps.get(load.id);
        if (!p) throw new Error(`[Electrical] Pump load '${load.id}' has no pump in the simulation.`);
        p.powered = load.powered;
        break;
      }
      case 'mov':
      case 'porv': {
        const v = state.components.valves.get(load.id);
        if (!v) throw new Error(`[Electrical] Valve load '${load.id}' has no valve in the simulation.`);
        v.powered = load.powered;
        break;
      }
      case 'controller': {
        const c = state.components.controllers.get(load.id);
        if (!c) throw new Error(`[Electrical] Controller load '${load.id}' has no controller in the simulation.`);
        c.powered = load.powered;
        break;
      }
      case 'heater': {
        const n = state.flowNodes.get(load.id);
        if (!n) throw new Error(`[Electrical] Heater load '${load.id}' has no flow node in the simulation.`);
        n.heaterPowered = load.powered;
        break;
      }
      case 'rps':
      case 'rod-drive':
        if (!load.powered) lostTripPower = lostTripPower ?? load;
        break;
    }
  }

  // De-energize to trip: rod drives that lose power let go of the rods, and
  // a protection cabinet that loses power trips the reactor
  const n = state.neutronics;
  if (lostTripPower && n.coreId && !n.scrammed) {
    const reason = lostTripPower.kind === 'rod-drive'
      ? `loss of power to the control rod drives (${lostTripPower.label})`
      : `loss of power to the reactor protection cabinet (${lostTripPower.label})`;
    n.scrammed = true;
    n.scramTime = state.time;
    n.scramReason = reason;
    n.controlRodPosition = 0;
    pushEvent(state, 'scram', `SCRAM: ${reason}`);
  }
}

/**
 * Solves the network once per ACCEPTED step: a trip, a start or a battery
 * running down is an event in the plant's history, and candidates the solver
 * throws away must not have them. The physics reads the flags this leaves
 * on the next step.
 */
export class ElectricalOperator implements ConstraintOperator {
  name = 'Electrical';
  postAcceptOnly = true;

  applyConstraints(state: SimulationState, dt?: number): SimulationState {
    if (!state.electrical || dt === undefined || !(dt > 0)) return state;
    const next = cloneSimulationState(state);
    solveElectrical(next, dt);
    return next;
  }
}

// ============================================================================
// Operator commands (panel buttons, scenario actions)
// ============================================================================

export type ElectricalCommand =
  | 'open' | 'close'          // breakers
  | 'start' | 'stop'          // diesels
  | 'reset'                   // clear an overload trip
  | 'offsite-lost' | 'offsite-restored';  // the grid, at a switchyard

export interface CommandResult { ok: boolean; message: string }

/**
 * Apply one operator command to the running network (mutates `state`).
 * Refusals (not a breaker, no fuel, ...) come back as ok = false with the
 * reason, for the panel to show; scenario scripts treat them as errors.
 * Nothing stops an operator reclosing onto an overload: the relay still
 * holds its heat and trips again, which is what the operator learns from.
 */
export function applyElectricalCommand(state: SimulationState, id: string, cmd: ElectricalCommand): CommandResult {
  const e = state.electrical?.elements[id];
  if (!e) {
    return { ok: false, message: state.electrical
      ? `'${id}' is not part of the electrical system`
      : 'This plant does not use the electrical model' };
  }
  switch (cmd) {
    case 'open':
      if (e.kind !== 'breaker') return { ok: false, message: `${e.label} is not a breaker` };
      e.closed = false;
      return { ok: true, message: `${e.label} opened` };
    case 'close':
      if (e.kind !== 'breaker') return { ok: false, message: `${e.label} is not a breaker` };
      e.tripped = false;
      e.closed = true;
      return { ok: true, message: `${e.label} closed` };
    case 'start':
      if (e.kind !== 'diesel') return { ok: false, message: `${e.label} is not a diesel generator` };
      if (e.tripped) return { ok: false, message: `${e.label} is tripped - reset it first` };
      if (!(e.fuelJ! > 0)) return { ok: false, message: `${e.label} has no fuel` };
      if (!e.running) {
        e.running = true;
        e.startElapsed = 0;
      }
      return { ok: true, message: `${e.label} starting (${e.startTime} s to load)` };
    case 'stop':
      if (e.kind !== 'diesel') return { ok: false, message: `${e.label} is not a diesel generator` };
      e.running = false;
      e.startElapsed = 0;
      return { ok: true, message: `${e.label} stopped` };
    case 'reset':
      if (!e.tripped) return { ok: false, message: `${e.label} is not tripped` };
      e.tripped = false;
      return { ok: true, message: e.kind === 'breaker'
        ? `${e.label} reset (still open - close it to re-energize)`
        : `${e.label} reset` };
    case 'offsite-lost':
    case 'offsite-restored':
      if (e.kind !== 'offsite') return { ok: false, message: `${e.label} is not a switchyard` };
      e.available = cmd === 'offsite-restored';
      return { ok: true, message: e.available ? `Offsite power restored at ${e.label}` : `Loss of offsite power at ${e.label}` };
  }
}

// ============================================================================
// Resume (construction round trip, live edits)
// ============================================================================

/**
 * Carry the running network's state across a rebuild: breaker positions,
 * trips, relay heating, diesel run state and fuel, battery charge, the grid.
 * `isDirty` says whether a component was edited, in which case it starts from
 * its (new) initial conditions instead.
 */
export function carryElectricalState(
  fresh: SimulationState, saved: SimulationState, isDirty: (id: string) => boolean
): void {
  if (!fresh.electrical || !saved.electrical) return;
  for (const id in fresh.electrical.elements) {
    const s = saved.electrical.elements[id];
    const f = fresh.electrical.elements[id];
    if (!s || s.kind !== f.kind || isDirty(id)) continue;
    f.overload = s.overload;
    f.tripped = s.tripped;
    f.available = s.available;
    f.closed = s.closed;
    f.running = s.running;
    f.startElapsed = s.startElapsed;
    f.fuelJ = s.fuelJ;
    f.energyJ = s.energyJ;
  }
  // Re-solve so the flags the physics reads match the carried state at once
  solveElectrical(fresh, 0);
}

/**
 * Write the running network's state into the plant's initial conditions,
 * so a rebuild (or the edit dialog) starts from where the plant is now.
 */
export function writeElectricalToPlant(sim: SimulationState, plant: PlantState): void {
  const E = sim.electrical;
  if (!E) return;
  for (const [id, component] of plant.components) {
    const e = E.elements[id];
    if (!e || !ELECTRICAL_ELEMENT_TYPES.has(component.type)) continue;
    const c = component as Record<string, any>;
    switch (e.kind) {
      case 'offsite': c.offsiteAvailable = e.available; break;
      case 'breaker': c.closed = !!e.closed; break;
      case 'diesel':
        c.running = !!e.running;
        c.fuelFraction = e.fuelJ! / e.fuelCapacityJ!;
        break;
      case 'battery': c.chargeFraction = e.energyJ! / e.capacityJ!; break;
    }
  }
}
