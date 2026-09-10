/**
 * Scenario event firing: the one place a preset's timed accident sequence
 * is applied to a running simulation, used by the game loop and by the
 * headless scripts alike so both see the same sequence.
 *
 * See scenario-types.ts for the data. Every action names a component that
 * must exist - a scenario written against a plant it does not describe is
 * a configuration error, reported loudly rather than skipped.
 */

import { SimulationState } from './types';
import { ScenarioAction, ScenarioEvent, ScenarioSpec } from './scenario-types';
import { applyScriptedBurst } from './operators/burst-operator';
import { applyElectricalCommand, ElectricalCommand } from './electrical';

export function initScenarioState(spec: ScenarioSpec | undefined): SimulationState['scenario'] {
  if (!spec || !spec.events || spec.events.length === 0) return undefined;
  const events = [...spec.events].sort((a, b) => a.time - b.time);
  for (const ev of events) {
    if (!(ev.time >= 0) || !Array.isArray(ev.actions)) {
      throw new Error(`[Scenario] malformed event ${JSON.stringify(ev)}`);
    }
  }
  return { events, fired: 0 };
}

export function applyScenarioAction(state: SimulationState, a: ScenarioAction): void {
  switch (a.kind) {
    case 'pump': {
      const p = state.components.pumps.get(a.id);
      if (!p) throw new Error(`[Scenario] pump '${a.id}' not found`);
      p.running = a.running;
      if (a.speed !== undefined) p.speed = a.speed;
      else if (!a.running) p.speed = 0;
      return;
    }
    case 'valve': {
      const v = state.components.valves.get(a.id);
      if (!v) throw new Error(`[Scenario] valve '${a.id}' not found`);
      v.position = a.position;
      return;
    }
    case 'controller': {
      const c = state.components.controllers?.get(a.id) as any;
      if (!c) throw new Error(`[Scenario] controller '${a.id}' not found`);
      c.mode = a.mode;
      if (a.manualOutput !== undefined) c.manualOutput = a.manualOutput;
      return;
    }
    case 'turbine-governor': {
      const n = state.flowNodes.get(a.id);
      if (!n) throw new Error(`[Scenario] turbine node '${a.id}' not found`);
      n.governorValve = a.value;
      return;
    }
    case 'burst': {
      applyScriptedBurst(state, a.id, {
        area: a.area,
        fraction: a.fraction,
        elevation: a.elevation,
        openingHeight: a.openingHeight,
        message: a.breachMessage,
      });
      return;
    }
    case 'shake': {
      // Nothing in the plant moves: this is queued for whoever is drawing.
      // A headless run has no camera and simply drops it.
      if (!(a.seconds > 0)) throw new Error(`[Scenario] shake needs a positive duration, got ${a.seconds}`);
      if (!state.pendingEvents) state.pendingEvents = [];
      state.pendingEvents.push({
        type: 'shake',
        message: `Ground motion for ${a.seconds.toFixed(0)} s`,
        data: { seconds: a.seconds, amplitude: a.amplitude },
      });
      return;
    }
    case 'water-level': {
      const body = state.surfaceWater?.bodies.get(a.id);
      if (!body) throw new Error(`[Scenario] water body '${a.id}' not found (the plant has no such terrain water)`);
      body.from = body.surface;
      body.to = a.surface;
      body.t0 = state.time;
      body.over = a.over ?? 0;
      return;
    }
    case 'offsite-power':
    case 'breaker':
    case 'diesel': {
      const cmd: ElectricalCommand = a.kind === 'offsite-power'
        ? (a.available ? 'offsite-restored' : 'offsite-lost')
        : a.kind === 'breaker'
          ? (a.closed ? 'close' : 'open')
          : (a.running ? 'start' : 'stop');
      const result = applyElectricalCommand(state, a.id, cmd);
      if (!result.ok) throw new Error(`[Scenario] ${a.kind} '${a.id}': ${result.message}`);
      return;
    }
    default:
      throw new Error(`[Scenario] unknown action ${JSON.stringify(a)}`);
  }
}

/**
 * Where a new event goes in a time-ordered list: after every event at or
 * before its time, searching from `from` on. The same rule on the plant's
 * scenario block (from 0) and on the running one (from the fired count)
 * keeps the two lists in the same order, which is what lets a rebuild carry
 * the fired count across (resume.ts carryScenarioProgress compares them).
 */
function insertionIndex(events: ScenarioEvent[], time: number, from: number): number {
  let i = from;
  while (i < events.length && events[i].time <= time) i++;
  return i;
}

function sameEvent(a: ScenarioEvent, b: ScenarioEvent): boolean {
  return a.time === b.time && a.message === b.message &&
    JSON.stringify(a.actions) === JSON.stringify(b.actions);
}

/**
 * Add an event to a plant's own scenario block (the design - what is saved
 * and exported), creating the block if the plant has none.
 */
export function addPlantScenarioEvent(plant: { scenario?: ScenarioSpec }, ev: ScenarioEvent): void {
  if (!plant.scenario) plant.scenario = { events: [] };
  const events = plant.scenario.events;
  events.splice(insertionIndex(events, ev.time, 0), 0, ev);
}

/** Take an event back out of a plant's scenario block. Returns whether it was there. */
export function removePlantScenarioEvent(plant: { scenario?: ScenarioSpec }, ev: ScenarioEvent): boolean {
  const events = plant.scenario?.events;
  if (!events) return false;
  const i = events.findIndex(e => sameEvent(e, ev));
  if (i < 0) return false;
  events.splice(i, 1);
  if (events.length === 0) delete plant.scenario;
  return true;
}

/**
 * Add an event to the RUNNING scenario, among the events still to fire. An
 * event scheduled for a time already past is a request to act now, and is
 * refused as a mistake rather than fired late.
 */
export function scheduleScenarioEvent(state: SimulationState, ev: ScenarioEvent): void {
  if (!(ev.time > state.time)) {
    throw new Error(
      `[Scenario] cannot schedule an event at t=${ev.time} s: the simulation is already at ` +
      `t=${state.time.toFixed(1)} s. Act now instead.`);
  }
  if (!state.scenario) state.scenario = { events: [], fired: 0 };
  const sc = state.scenario;
  sc.events.splice(insertionIndex(sc.events, ev.time, sc.fired), 0, ev);
}

/** Take a not-yet-fired event out of the running scenario. Returns whether it was there. */
export function unscheduleScenarioEvent(state: SimulationState, ev: ScenarioEvent): boolean {
  const sc = state.scenario;
  if (!sc) return false;
  for (let i = sc.fired; i < sc.events.length; i++) {
    if (sameEvent(sc.events[i], ev)) {
      sc.events.splice(i, 1);
      return true;
    }
  }
  return false;
}

/**
 * Fire every event whose time has come. Mutates the state (component
 * settings, the fired counter) and queues a 'scenario' pending event per
 * fired event for the UI. Returns the events fired, in order.
 */
export function fireDueScenarioEvents(state: SimulationState): ScenarioEvent[] {
  const sc = state.scenario;
  if (!sc) return [];
  const fired: ScenarioEvent[] = [];
  while (sc.fired < sc.events.length && sc.events[sc.fired].time <= state.time) {
    const ev = sc.events[sc.fired];
    for (const a of ev.actions) applyScenarioAction(state, a);
    sc.fired++;
    fired.push(ev);
    if (!state.pendingEvents) state.pendingEvents = [];
    state.pendingEvents.push({
      type: 'scenario',
      message: `t=${ev.time.toFixed(0)} s: ${ev.message}`,
      data: { time: ev.time },
    });
  }
  return fired;
}
