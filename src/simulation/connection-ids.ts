/**
 * Flow-connection naming.
 *
 * A simulation flow connection is named after the components it joins:
 * `flow-{from}-{to}`. That is unique for almost every plant, and it is the
 * name saved controller configs and presets reference, so it must not change.
 *
 * It stops being unique the moment two connections join the same PAIR of
 * components - a feedwater header feeding two tube bundles of one exchanger,
 * a hot leg entering a vessel through two nozzles. Two connections under one
 * id silently alias every lookup that resolves a connection by id, so the
 * SECOND and later collisions get their port names appended. First come,
 * first served: whichever connection the plant lists first keeps the plain
 * name it has always had.
 *
 * This is the one place that rule lives - the factory names connections with
 * it, and the renderer maps a simulation connection back to the plant
 * connection it was built from with it.
 */

export interface ConnectionEndpoints {
  fromComponentId: string;
  toComponentId: string;
  fromPortId: string;
  toPortId: string;
}

/** The plain component-pair name, before any collision handling. */
export function baseFlowConnectionId(conn: ConnectionEndpoints): string {
  return `flow-${conn.fromComponentId}-${conn.toComponentId}`;
}

/** Final connection ids for a plant's connections, in the same order. */
export function assignFlowConnectionIds(connections: readonly ConnectionEndpoints[]): string[] {
  const used = new Set<string>();
  return connections.map(conn => {
    let id = baseFlowConnectionId(conn);
    if (used.has(id)) {
      const base = `${id}-${conn.fromPortId}-${conn.toPortId}`;
      id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    }
    used.add(id);
    return id;
  });
}
