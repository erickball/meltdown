/**
 * Which end's fluid is actually sitting in each pipe, for line colouring.
 *
 * A connection is drawn in the colour of its donor node, and the donor used
 * to be picked from the instantaneous sign of the mass flow. Plenty of real
 * lines sit at zero NET flow while sloshing hard: the stub between the
 * Xe-100 steam generator and its shut tube-leak valve fills and empties at a
 * few Hz, reversing ~38 times a second, which strobed that line between the
 * tube's steam colour and the valve body's water colour.
 *
 * The sign of the flow is the wrong question. What the line CONTAINS is the
 * right one, and that is a plug-flow ledger: the pipe holds flowArea*length
 * of fluid, whatever enters one end pushes the interface toward the other,
 * and the line only changes what it is full of once a whole pipe volume has
 * gone through. So track the interface and colour by the end that last
 * flushed the line. Sloshing that moves less than a pipe volume never
 * flushes anything, so the colour holds; a genuine reversal changes it after
 * exactly the time it takes to sweep the line, which is the physical answer.
 *
 * The interface saturates at the two pipe ends. That is geometry, not a
 * numerical clamp: fluid pushed into a line that is already full of that
 * fluid leaves the contents unchanged.
 *
 * This is display state only - it lives in the renderer, never in
 * SimulationState, so it cannot perturb the physics, saves, or replay.
 */

import type { SimulationState, FlowConnection } from '../simulation';
import { drawCompositionAt, type DrawComposition } from '../simulation/operators/connection-hydraulics';

/** Reusable scratch for the per-frame draw sampling below (one call per
 *  connection per frame; the result is consumed immediately). */
const drawScratch = {} as DrawComposition;

/** Which end of a connection the fluid in it came from. */
export type PipeEnd = 'from' | 'to';

interface LineState {
  /** Volume of the pipe (m³, measured from the "from" end) occupied by fluid
   *  that came from the "from" node. 0 = full of the "to" node's fluid. */
  fromVolume: number;
  /** The end that last flushed the line - i.e. the last end the interface
   *  reached. Held while the interface sits somewhere in between. */
  end: PipeEnd;
}

export class PipeContentsTracker {
  private lines = new Map<string, LineState>();
  /** Sim time the ledger was last advanced to (null = never). */
  private lastTime: number | null = null;
  private degenerateWarned = new Set<string>();

  /**
   * Advance every line's contents to this state's sim time.
   *
   * dt <= 0 means the sim is paused or history was scrubbed backwards; hold
   * the ledger rather than integrating a negative interval.
   */
  update(state: SimulationState): void {
    const dt = this.lastTime === null ? 0 : state.time - this.lastTime;
    this.lastTime = state.time;

    for (const conn of state.flowConnections) {
      const pipeVolume = conn.flowArea * conn.length;
      if (!(pipeVolume > 0)) {
        if (!this.degenerateWarned.has(conn.id)) {
          this.degenerateWarned.add(conn.id);
          console.error(`[PipeContentsTracker] ${conn.id} has no volume ` +
            `(flowArea=${conn.flowArea}, length=${conn.length}) - line colour falls ` +
            `back to the instantaneous flow direction and may flicker`);
        }
        this.lines.delete(conn.id);
        continue;
      }

      let line = this.lines.get(conn.id);
      if (!line) {
        // A line first seen while flowing is already full of its upstream
        // fluid; start it there rather than at some arbitrary midpoint
        const forward = conn.massFlowRate >= 0;
        line = { fromVolume: forward ? pipeVolume : 0, end: forward ? 'from' : 'to' };
        this.lines.set(conn.id, line);
        continue;
      }

      if (!(dt > 0)) continue;

      // Volumetric rate of what is entering the line, at the density of the
      // end it is entering from (a bottom nozzle draws liquid, a top one
      // vapor, so the draw density - not the node's bulk - sets how fast the
      // interface moves)
      const donor = state.flowNodes.get(conn.massFlowRate >= 0 ? conn.fromNodeId : conn.toNodeId);
      if (!donor) continue;
      const elevation = conn.massFlowRate >= 0 ? conn.fromElevation : conn.toElevation;
      const rho = drawCompositionAt(
        donor, elevation, conn.massFlowRate, undefined, undefined, drawScratch).rho;
      if (!(rho > 0)) continue;

      const swept = line.fromVolume + (conn.massFlowRate / rho) * dt;
      if (swept >= pipeVolume) {
        line.fromVolume = pipeVolume;
        line.end = 'from';
      } else if (swept <= 0) {
        line.fromVolume = 0;
        line.end = 'to';
      } else {
        line.fromVolume = swept;
      }
    }

    // Rebuilding the plant retires connection ids; drop the ones that went
    // away so the ledger cannot grow across construction/run cycles
    if (this.lines.size > state.flowConnections.length) {
      const live = new Set(state.flowConnections.map(c => c.id));
      for (const id of this.lines.keys()) {
        if (!live.has(id)) this.lines.delete(id);
      }
    }
  }

  /**
   * The end whose fluid this line is full of. Falls back to the flow
   * direction for a line the ledger cannot track (no volume) or has not seen
   * yet (first frame after a plant change).
   */
  donorEnd(conn: FlowConnection): PipeEnd {
    const line = this.lines.get(conn.id);
    if (line) return line.end;
    return conn.massFlowRate >= 0 ? 'from' : 'to';
  }

  /** Fraction of the line filled from its "from" end, for tests/debug. */
  fromFraction(conn: FlowConnection): number {
    const line = this.lines.get(conn.id);
    const pipeVolume = conn.flowArea * conn.length;
    if (!line || !(pipeVolume > 0)) return NaN;
    return line.fromVolume / pipeVolume;
  }
}
