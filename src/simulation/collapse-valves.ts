/**
 * EXPERIMENT (LUMP_VALVES=1 in the script harness): in-line valves without a
 * flow node of their own.
 *
 * A valve is a restriction, not a volume. It has a node today only because a
 * connection joins two nodes and the valve sits between two connections; that
 * node holds a valve body's worth of fluid plus half of each adjacent run, and
 * on a saturated drain or a steam tap it is a sliver sitting exactly on the
 * dome edge.
 *
 * The rule, with no size test in it:
 *  - A valve with exactly TWO connections is in-line. One of them carries its
 *    seat (connectedFlowPath). The body's fluid is contiguous with whatever
 *    is on the OTHER, open side, so the node's volume and contents join that
 *    neighbour, the open connection's run is added in series to the seat
 *    connection, and the node is gone.
 *  - A valve with any other number of connections is a header as well as a
 *    valve (two tube bundles joining at a stop valve) and keeps its node.
 *  - A neighbour that cannot take the body is left alone and reported: a
 *    boundary (the inventory would vanish) or a moving-boundary OTSG tube
 *    (its geometry is not the node volume alone).
 *
 * Returns what it did, so a probe can print it.
 */

import { SimulationState, FlowConnection, FlowNode } from './types';

export interface ValveCollapseReport {
  collapsed: Array<{ valveId: string; hostId: string; volume: number }>;
  kept: Array<{ valveId: string; reason: string }>;
}

export function collapseInlineValves(state: SimulationState): ValveCollapseReport {
  const report: ValveCollapseReport = { collapsed: [], kept: [] };
  const seats = new Map<string, string | undefined>();
  for (const [id, v] of state.components.valves) seats.set(id, v.connectedFlowPath);
  if (state.components.checkValves) {
    for (const [id, v] of state.components.checkValves) seats.set(id, v.connectedFlowPath);
  }

  for (const [valveId, seatId] of seats) {
    const node = state.flowNodes.get(valveId);
    if (!node) continue;
    const conns = state.flowConnections.filter(c => c.fromNodeId === valveId || c.toNodeId === valveId);
    if (conns.length !== 2) {
      report.kept.push({ valveId, reason: `${conns.length} connections (a header)` });
      continue;
    }
    const seat = conns.find(c => c.id === seatId);
    if (!seat) {
      report.kept.push({ valveId, reason: `seat connection '${seatId}' is not one of its two` });
      continue;
    }
    const open = conns[0] === seat ? conns[1] : conns[0];
    if (open.isBreakConnection || seat.isBreakConnection || open.openPort || seat.openPort) {
      report.kept.push({ valveId, reason: 'a break or an open nozzle is on it' });
      continue;
    }
    const hostId = open.fromNodeId === valveId ? open.toNodeId : open.fromNodeId;
    const host = state.flowNodes.get(hostId);
    if (!host) throw new Error(`[collapseInlineValves] ${valveId}: neighbour '${hostId}' has no flow node`);
    if (host.isBoundary) { report.kept.push({ valveId, reason: `open side is the boundary '${hostId}'` }); continue; }
    if (host.otsg) { report.kept.push({ valveId, reason: `open side is the OTSG tube '${hostId}'` }); continue; }
    const farId = seat.fromNodeId === valveId ? seat.toNodeId : seat.fromNodeId;
    if (farId === hostId) { report.kept.push({ valveId, reason: 'both sides are the same node' }); continue; }

    mergeContents(host, node);

    // The open run, in series with the seat's. Signed along the seat's own
    // direction; referred to the seat's bore so L/A and K*(1/A^2) both add.
    const openHostIsFrom = open.fromNodeId === hostId;
    const seatLeavesValve = seat.fromNodeId === valveId;
    const areaRatio = seat.flowArea / open.flowArea;
    // host -> valve along the open run is +open.elevation when the host is
    // its from-node. The seat wants host -> valve if it leaves the valve,
    // valve -> host if it arrives at it.
    const hostToValve = openHostIsFrom ? open.elevation : -open.elevation;
    seat.elevation += seatLeavesValve ? hostToValve : -hostToValve;
    seat.length += open.length * areaRatio;
    seat.resistanceCoeff += open.resistanceCoeff * areaRatio * areaRatio;
    const hostElevation = openHostIsFrom ? open.fromElevation : open.toElevation;
    const hostTolerance = openHostIsFrom ? open.fromPhaseTolerance : open.toPhaseTolerance;
    const hostOpening = openHostIsFrom ? open.fromOpeningHeight : open.toOpeningHeight;
    if (seatLeavesValve) {
      seat.fromNodeId = hostId;
      seat.fromElevation = hostElevation;
      seat.fromPhaseTolerance = hostTolerance;
      seat.fromOpeningHeight = hostOpening;
    } else {
      seat.toNodeId = hostId;
      seat.toElevation = hostElevation;
      seat.toPhaseTolerance = hostTolerance;
      seat.toOpeningHeight = hostOpening;
    }

    state.flowConnections = state.flowConnections.filter((c: FlowConnection) => c !== open);
    state.flowNodes.delete(valveId);
    renameConnection(state, open.id, seat.id);
    // The valve's metal now sees the fluid it is actually sitting in
    for (const cv of state.convectionConnections ?? []) {
      if (cv.flowNodeId === valveId) cv.flowNodeId = hostId;
    }
    report.collapsed.push({ valveId, hostId, volume: node.volume });
  }
  return report;
}

/**
 * The body takes the host's fluid: the host grows by the body's volume at its
 * own intensive state. (Adding the body's own initial contents instead put a
 * valve's default 350 K water - 130 kg of it - into a helium vessel.)
 */
function mergeContents(host: FlowNode, body: FlowNode): void {
  const factor = (host.volume + body.volume) / host.volume;
  host.volume += body.volume;
  host.fluid.mass *= factor;
  host.fluid.internalEnergy *= factor;
  if (host.fluid.gasVolume !== undefined) host.fluid.gasVolume *= factor;
  if (host.fluid.ncg) {
    for (const species of Object.keys(host.fluid.ncg)) {
      host.fluid.ncg[species as keyof typeof host.fluid.ncg]! *= factor;
    }
  }
}

/** Everything that named the removed connection by id now names the seat's. */
function renameConnection(state: SimulationState, oldId: string, newId: string): void {
  for (const [, pump] of state.components.pumps) {
    if (pump.connectedFlowPath === oldId) pump.connectedFlowPath = newId;
  }
  const walk = (o: unknown, depth: number): void => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (v === oldId) (o as Record<string, unknown>)[k] = newId;
      else if (typeof v === 'object') walk(v, depth + 1);
    }
  };
  const controllers = (state.components as unknown as { controllers?: Map<string, unknown> }).controllers;
  if (controllers) for (const [, ctl] of controllers) walk(ctl, 0);
}