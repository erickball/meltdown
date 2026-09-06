/**
 * Per-step probe for one flow node: what its pressure, mass, phase and
 * adjacent flows do on ACCEPTED steps and on REJECTED attempts.
 *
 * Rejected attempts never reach onSubstepComplete, so the rejection-cause
 * histogram alone cannot show what the guard actually refused. This uses
 * RK45Solver.onStepRejected to print the start state and the refused
 * candidate side by side - the view that located the liquid-side secant
 * defect behind the condensate-pump rejections (2026-09-06).
 *
 * Usage: npx tsx scripts/probe-node-rejections.ts [nodeId] [seconds] [tickDt] [preset] [--all-accepted]
 *   default: cond-pump-1 20 0.1 src/presets/xe100.json, accepted rows every 25th step
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import type { SimulationState } from '../src/simulation/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const allAccepted = args.includes('--all-accepted');
const pos = args.filter(a => !a.startsWith('--'));
const NODE = pos[0] || 'cond-pump-1';
const seconds = parseFloat(pos[1] || '20');
const tickDt = parseFloat(pos[2] || '0.1');
const preset = pos[3] || path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const sim = buildSimFromFile(preset);

const conns = sim.state.flowConnections.filter(c => c.fromNodeId === NODE || c.toNodeId === NODE);
if (conns.length === 0) {
  console.error(`node '${NODE}' has no flow connections in ${path.basename(preset)}`);
  process.exit(1);
}
const neighbors = [...new Set(conns.flatMap(c => [c.fromNodeId, c.toNodeId]).filter(n => n !== NODE))];
console.log(`node ${NODE}: conns ${conns.map(c => c.id).join(', ')} ; neighbors ${neighbors.join(', ')}`);

function row(tag: string, s: SimulationState, cand: SimulationState | null, dt: number, extra = '') {
  const n = s.flowNodes.get(NODE)!;
  const c = cand?.flowNodes.get(NODE);
  const fl = (st: SimulationState) => st.flowConnections.filter(x => x.fromNodeId === NODE || x.toNodeId === NODE)
    .map(x => `${x.fromNodeId === NODE ? '-' : '+'}${x.massFlowRate.toFixed(2)}`).join('/');
  const nb = neighbors.map(id => `${id}=${((cand ?? s).flowNodes.get(id)!.fluid.pressure / 1e3).toFixed(1)}k`).join(' ');
  console.log(`${tag} t=${s.time.toFixed(4)} dt=${(dt * 1e3).toFixed(2)}ms P=${(n.fluid.pressure / 1e3).toFixed(2)}k` +
    (c ? `->${(c.fluid.pressure / 1e3).toFixed(2)}k` : '') +
    ` m=${n.fluid.mass.toFixed(1)}${c ? '->' + c.fluid.mass.toFixed(1) : ''} T=${n.fluid.temperature.toFixed(2)} ph=${n.fluid.phase}` +
    ` flows(old)=${fl(s)}${c ? ' (new)=' + fl(cand!) : ''} ${nb} ${extra}`);
}

let accepted = 0, rejected = 0, rejectedHere = 0;
sim.solver.onSubstepComplete = (state, _n, dt) => {
  accepted++;
  if (allAccepted || accepted % 25 === 0) row('ACC', state, null, dt);
};
sim.solver.onStepRejected = (from, cand, dt, reason) => {
  rejected++;
  if (reason.startsWith(NODE)) {
    rejectedHere++;
    if (rejectedHere <= 60 || rejectedHere % 50 === 0) row('REJ', from, cand, dt, reason);
  }
};

const ticks = Math.round(seconds / tickDt);
for (let i = 0; i < ticks; i++) {
  const r = sim.solver.advance(sim.state, tickDt);
  sim.state = r.state;
  sim.state.pendingEvents = [];
}
console.log(`\naccepted=${accepted} rejected=${rejected} rejected-on-${NODE}=${rejectedHere}`);
