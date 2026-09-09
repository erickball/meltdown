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
    default:
      throw new Error(`[Scenario] unknown action ${JSON.stringify(a)}`);
  }
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
