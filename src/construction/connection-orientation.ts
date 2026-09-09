/**
 * Connection orientation at pump ports.
 *
 * A plant connection has a from-side and a to-side, and the simulation's
 * positive flow direction runs from -> to. For most components that is a
 * pure sign convention. A pump is different: its head is applied along the
 * connection leaving its OUTLET port, so the factory needs every pump
 * connection oriented the way the pump pumps - inlet port on the to-side
 * (X -> pump), outlet port on the from-side (pump -> Y).
 *
 * The pipe tools let the user start a pipe at either end, so a line drawn
 * from a pump's suction nozzle to a tank arrives as pump -> tank. Until
 * 2026-09-09 the factory then took THAT line as the pump's discharge (it
 * chose the connection where the pump was the from-component, not the one
 * on the outlet port), and the pump pushed backwards - one drained a spent
 * fuel pool into the sea through what the user had drawn as the suction
 * line. This module makes the orientation a property of the ports, applied
 * when a connection is created and when a plant is loaded, and the factory
 * refuses any pump connection that still points the wrong way.
 */

import type { Connection, PlantComponent, Port } from '../types';

export type PumpPortRole = 'inlet' | 'outlet' | null;

/** Which nozzle of a pump a port is, or null when the component is not a pump. */
export function pumpPortRole(component: PlantComponent | undefined, portId: string): PumpPortRole {
  if (!component) return null;
  if (component.type !== 'pump' && component.type !== 'turbine-driven-pump') return null;
  const port: Port | undefined = component.ports?.find(p => p.id === portId);
  if (port) {
    if (port.direction === 'in') return 'inlet';
    if (port.direction === 'out') return 'outlet';
  }
  // Ports are named `${id}-inlet` / `${id}-outlet` (turbine-driven pumps also
  // have `-pump-suction` / `-pump-discharge` and a steam side, which is not a
  // pumped path and must not be reoriented)
  if (portId.endsWith('-inlet') || portId.endsWith('-pump-suction')) return 'inlet';
  if (portId.endsWith('-outlet') || portId.endsWith('-pump-discharge')) return 'outlet';
  return null;
}

/**
 * True when the connection runs against the pump: it leaves a pump's inlet
 * port, or arrives at a pump's outlet port.
 */
export function runsAgainstPump(
  conn: Pick<Connection, 'fromComponentId' | 'fromPortId' | 'toComponentId' | 'toPortId'>,
  components: ReadonlyMap<string, PlantComponent>,
): boolean {
  const fromRole = pumpPortRole(components.get(conn.fromComponentId), conn.fromPortId);
  const toRole = pumpPortRole(components.get(conn.toComponentId), conn.toPortId);
  return fromRole === 'inlet' || toRole === 'outlet';
}

/**
 * Swap the two ends of a connection in place: every from-* field becomes the
 * matching to-* field and the plan route is reversed (it is stored from the
 * from-port to the to-port).
 */
export function reverseConnection(conn: Connection): void {
  const swap = <K extends keyof Connection>(a: K, b: K) => {
    const t = conn[a];
    if (conn[b] === undefined) delete conn[a]; else conn[a] = conn[b];
    if (t === undefined) delete conn[b]; else conn[b] = t;
  };
  swap('fromComponentId', 'toComponentId');
  swap('fromPortId', 'toPortId');
  swap('fromElevation', 'toElevation');
  swap('fromPhaseTolerance', 'toPhaseTolerance');
  swap('fromOpeningHeight', 'toOpeningHeight');
  if (conn.route) conn.route = conn.route.slice().reverse();
}

/**
 * Orient a connection the way its pump ports pump. Returns true when the
 * connection was reversed. A connection joining a pump inlet to another
 * pump's inlet (or outlet to outlet) cannot be oriented by flipping and is
 * left alone for the factory to reject.
 */
export function orientConnectionByPumpPorts(
  conn: Connection,
  components: ReadonlyMap<string, PlantComponent>,
): boolean {
  if (!runsAgainstPump(conn, components)) return false;
  const fromRole = pumpPortRole(components.get(conn.fromComponentId), conn.fromPortId);
  const toRole = pumpPortRole(components.get(conn.toComponentId), conn.toPortId);
  const contradictory = (fromRole === 'inlet' && toRole === 'inlet') || (fromRole === 'outlet' && toRole === 'outlet');
  if (contradictory) return false;
  reverseConnection(conn);
  return true;
}
