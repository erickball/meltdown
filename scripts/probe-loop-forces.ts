/**
 * Loop-force probe: from a snapshot, every `every` s print, for each flow
 * connection around a named loop, the flow and the momentum-equation terms
 * computeConnectionHydraulics reports (node-pressure difference at the ports,
 * gravity head along the line and the density it used, friction), plus the
 * loop sums. Around a closed loop the node pressures cancel, so the summed
 * dP_pressure + dP_gravity is the net head actually driving circulation.
 *
 *   npx tsx scripts/probe-loop-forces.ts <preset> <snap> <seconds> <every> <conn,conn,...> [tick]
 *
 * Connections are named by id; prefix with '-' to traverse one against its
 * from->to sense so the loop is summed in one direction.
 */
import * as fs from 'fs';
import { buildSimFromFile } from './lib/sim-harness';
import { deserializeSimulationState } from '../src/simulation/serialization';
import { computeConnectionHydraulics } from '../src/simulation/operators/connection-hydraulics';

const [preset, snap, secArg, everyArg, loopArg, tickArg] = process.argv.slice(2);
const sim = buildSimFromFile(preset);
if (snap && snap !== '-') sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(snap, 'utf-8')));
const seconds = parseFloat(secArg), every = parseFloat(everyArg), tick = parseFloat(tickArg ?? '0.1');
const loop = loopArg.split(',').map(s => s.startsWith('-') ? { id: s.slice(1), sign: -1 } : { id: s, sign: 1 });

let printedGeometry = false;
const end = sim.state.time + seconds;
let next = sim.state.time;
while (sim.state.time < end - 1e-9) {
  if (sim.state.time >= next - 1e-9) {
    const s = sim.state;
    if (!printedGeometry) {
      for (const { id, sign } of loop) {
        const c = s.flowConnections.find(x => x.id === id);
        if (!c) throw new Error(`connection ${id} not found`);
        console.log(`  geom ${sign > 0 ? ' ' : '-'}${id}: ${c.fromNodeId}->${c.toNodeId} dz=${c.elevation?.toFixed(2)} ` +
          `fromElev=${c.fromElevation} toElev=${c.toElevation} L=${c.length?.toFixed(1)} A=${c.flowArea?.toFixed(3)}`);
      }
      printedGeometry = true;
    }
    let sumP = 0, sumG = 0, sumF = 0;
    const parts: string[] = [];
    for (const { id, sign } of loop) {
      const c = s.flowConnections.find(x => x.id === id)!;
      const h = computeConnectionHydraulics(s, c, s.flowNodes.get(c.fromNodeId)!, s.flowNodes.get(c.toNodeId)!);
      sumP += sign * h.dP_pressure; sumG += sign * h.dP_gravity; sumF += sign * h.dP_friction;
      parts.push(`${id.replace(/^flow-/, '').slice(0, 18)}: m=${(sign * c.massFlowRate).toFixed(2)} ` +
        `dP=${(sign * h.dP_pressure).toFixed(0)} g=${(sign * h.dP_gravity).toFixed(0)}(rho ${h.rho_flow.toFixed(2)}) f=${(sign * h.dP_friction).toFixed(0)}`);
    }
    const nodeIds = [...new Set(loop.flatMap(({ id }) => { const c = s.flowConnections.find(x => x.id === id)!; return [c.fromNodeId, c.toNodeId]; }))];
    const pRef = s.flowNodes.get(nodeIds[0])!.fluid.pressure;
    parts.push('P-P0[Pa]: ' + nodeIds.map(n => `${n}=${(s.flowNodes.get(n)!.fluid.pressure - pRef).toFixed(0)}`).join(' '));
    console.log(`t=${s.time.toFixed(2)} SUM dP=${sumP.toFixed(1)} grav=${sumG.toFixed(1)} drive=${(sumP + sumG).toFixed(1)} fric=${sumF.toFixed(1)} | ` + parts.join(' | '));
    next += every;
  }
  sim.state = sim.solver.advance(sim.state, Math.min(tick, end - sim.state.time)).state;
  sim.state.pendingEvents = [];
}
