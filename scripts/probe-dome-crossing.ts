/**
 * Dome-crossing rejection probe.
 *
 * For every REJECTED step attempt whose sanity reason names a node, prints /
 * tallies that node's start and predicted-end state relative to the
 * saturation dome, the compliance the pressure solve actually used (after
 * the secant pass), the pressure change the solve predicted, and the one the
 * EOS produced. The question it answers: do the rejections coincide with a
 * node crossing the dome edge WITHIN the step (in which case the closure was
 * priced on the wrong side), or with something else?
 *
 * Usage: npx tsx scripts/probe-dome-crossing.ts [seconds] [tripTime] [tickDt] [preset]
 * Env: TRIP=circulator|sbo|none   LIST=12  (per-rejection rows to print per node)
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { applyScenarioAction } from '../src/simulation/scenario';
import type { ScenarioAction } from '../src/simulation/scenario-types';
import { distanceToSaturationLine, calculateState } from '../src/simulation/water-properties';
import type { SimulationState, FlowNode } from '../src/simulation/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const seconds = parseFloat(args[0] || '180');
const tripTime = parseFloat(args[1] || '20');
const tickDt = parseFloat(args[2] || '0.1');
const preset = args[3] || path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const TRIP = (process.env.TRIP || 'circulator').toLowerCase();
const LIST = parseInt(process.env.LIST || '12', 10);

const sim = buildSimFromFile(preset);
const ps: any = (sim.solver as any).pressureSolver;

const TRIP_ACTIONS: Record<string, ScenarioAction[]> = {
  circulator: [{ kind: 'pump', id: 'pump-1', running: false, speed: 0 }],
  sbo: [
    { kind: 'pump', id: 'pump-1', running: false, speed: 0 },
    { kind: 'pump', id: 'fw-pump-1', running: false, speed: 0 },
    { kind: 'pump', id: 'cond-pump-1', running: false, speed: 0 },
    { kind: 'controller', id: 'ctl-fw-1', mode: 'manual', manualOutput: 0 },
    { kind: 'controller', id: 'ctl-msp-1', mode: 'manual', manualOutput: 0.02 },
    { kind: 'turbine-governor', id: 'turbine-1', value: 0.02 },
    { kind: 'valve', id: 'val-bleed-1', position: 0 },
    { kind: 'controller', id: 'ctl-fwh-1', mode: 'manual', manualOutput: 0 },
  ],
  none: [],
};
const actions = TRIP_ACTIONS[TRIP];
if (!actions) throw new Error(`unknown TRIP=${TRIP}`);

interface Row {
  node: string;
  t: number;
  dt: number;
  ph0: string; ph1: string;
  u0: number; v0: number; u1: number; v1: number;
  d0: number; d1: number;       // dome distance (mL/kg), >0 liquid side
  vf0: number;                  // v_f at start (mL/kg)
  mEdge: number;                // kg to liquid-full at start
  m0: number; m1: number;
  P0: number; P1: number;
  dPpred: number;
  c: number;
  secant: string;
  // EOS decomposition of the realized change at fixed volume:
  // P(m,U) evaluated at the four corners of (m0,m1)x(U0,U1)
  dPm: number;   // P(m1,U0) - P(m0,U0)
  dPu: number;   // P(m0,U1) - P(m0,U0)
  dPeos: number; // P(m1,U1) - P(m0,U0)
  eosOffset: number; // P(m0,U0) - P0 (0 unless something else owns the pressure)
}
const rows: Row[] = [];
const perNode = new Map<string, { n: number; cross: number; both: number; neither: number; secant: number }>();

function info(node: FlowNode) {
  const m = node.fluid.mass;
  const u = m > 0 ? node.fluid.internalEnergy / m : NaN;
  const v = m > 0 ? node.volume / m : NaN;
  let d = NaN, vf = NaN;
  if (isFinite(u) && isFinite(v)) {
    const sd = distanceToSaturationLine(u, v);
    d = sd.distance;
    vf = sd.v_f_closest;
  }
  return { m, u, v, d, vf, P: node.fluid.pressure, ph: node.fluid.phase };
}

sim.solver.onStepRejected = (from: SimulationState, cand: SimulationState, dt: number, reason: string) => {
  const id = reason.split(':')[0];
  const a = from.flowNodes.get(id);
  const b = cand.flowNodes.get(id);
  if (!a || !b) return;
  const A = info(a), B = info(b);
  const mEdge = A.vf > 0 ? a.volume / (A.vf * 1e-6) - A.m : NaN;
  const V = a.volume;
  const U0 = a.fluid.internalEnergy, U1 = b.fluid.internalEnergy;
  let P00 = NaN, P10 = NaN, P01 = NaN, P11 = NaN;
  try {
    P00 = calculateState(A.m, U0, V).pressure;
    P10 = calculateState(B.m, U0, V).pressure;
    P01 = calculateState(A.m, U1, V).pressure;
    P11 = calculateState(B.m, U1, V).pressure;
  } catch { /* out-of-table corner: leave NaN, it is itself diagnostic */ }
  const r: Row = {
    node: id, t: from.time, dt,
    ph0: A.ph, ph1: B.ph,
    u0: A.u / 1000, v0: A.v * 1e6, u1: B.u / 1000, v1: B.v * 1e6,
    d0: A.d, d1: B.d, vf0: A.vf, mEdge,
    m0: A.m, m1: B.m, P0: A.P, P1: B.P,
    dPpred: ps?.lastPredictedDP.get(id) ?? NaN,
    c: ps?.lastComplianceUsed.get(id) ?? NaN,
    secant: ps?.lastSecantNodes.get(id) ?? '',
    dPm: P10 - P00, dPu: P01 - P00, dPeos: P11 - P00, eosOffset: P00 - A.P,
  };
  rows.push(r);
  let s = perNode.get(id);
  if (!s) { s = { n: 0, cross: 0, both: 0, neither: 0, secant: 0 }; perNode.set(id, s); }
  s.n++;
  if (r.secant) s.secant++;
  // Dome-edge crossing: the sign of the liquid-line distance flips, i.e. the
  // node was on one side of v_f at the start and the other at the end.
  const crossed = isFinite(r.d0) && isFinite(r.d1) && (r.d0 > 0) !== (r.d1 > 0);
  if (crossed) s.cross++;
  else if (r.ph0 !== r.ph1) s.both++;
  else s.neither++;
};

const ticks = Math.round(seconds / tickDt);
let tripped = false;
for (let i = 0; i < ticks; i++) {
  if (!tripped && sim.state.time >= tripTime) {
    for (const a of actions) applyScenarioAction(sim.state, a);
    tripped = true;
  }
  const res = sim.solver.advance(sim.state, tickDt);
  sim.state = res.state;
  sim.state.pendingEvents = [];
}

const stats = sim.solver.getMetrics();
console.log(`\npreset=${path.basename(preset)} trip=${TRIP}@${tripTime}s  ${seconds}s`);
console.log(`steps=${stats.totalSteps} rejected=${stats.rejectedSteps} secantResolveSteps=${ps?.secantResolveSteps}`);

console.log('\nrejections by node (crossed = liquid-line side flipped within the step):');
console.log('  node                       rej  crossed  phaseChg  same-side  secant-fired |' +
  '  mean|dPreal|  mean|dPpred|  mean|dP_m|  mean|dP_u|  mean|eosOff|  (bar)');
for (const [id, s] of [...perNode.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const rs = rows.filter(r => r.node === id);
  const mean = (f: (r: Row) => number) =>
    (rs.reduce((a, r) => a + Math.abs(f(r) || 0), 0) / rs.length / 1e5).toFixed(2);
  console.log(`  ${id.padEnd(24)} ${String(s.n).padStart(5)} ${String(s.cross).padStart(8)} ` +
    `${String(s.both).padStart(9)} ${String(s.neither).padStart(10)} ${String(s.secant).padStart(13)} |` +
    `${mean(r => r.P1 - r.P0).padStart(13)} ${mean(r => r.dPpred).padStart(13)} ` +
    `${mean(r => r.dPm).padStart(11)} ${mean(r => r.dPu).padStart(11)} ${mean(r => r.eosOffset).padStart(13)}`);
}

const byNode = new Map<string, Row[]>();
for (const r of rows) {
  if (!byNode.has(r.node)) byNode.set(r.node, []);
  byNode.get(r.node)!.push(r);
}
for (const [id, rs] of [...byNode.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5)) {
  console.log(`\n--- ${id} (${rs.length} rejections; every ${Math.max(1, Math.ceil(rs.length / LIST))}th) ---`);
  console.log('   t     dt(ms)  phase0->phase1       d0(mL/kg)     d1  mEdge(kg)   m0->m1         du(kJ/kg)  P0(bar)  dPpred  dPreal | dP_m   dP_u   dP_eos  eosOff  dPdm(bar/kg) secant');
  const stride = Math.max(1, Math.ceil(rs.length / LIST));
  const b = (x: number) => (x / 1e5).toFixed(2);
  for (let i = 0; i < rs.length; i += stride) {
    const r = rs[i];
    const dPdm = isFinite(r.c) && r.c > 0 ? 1 / (r.c * r.dt) / 1e5 : NaN;
    console.log(
      `  ${r.t.toFixed(1).padStart(6)} ${(r.dt * 1e3).toFixed(2).padStart(7)}  ` +
      `${(r.ph0 + '->' + r.ph1).padEnd(22)}` +
      `${r.d0.toFixed(1).padStart(8)} ${r.d1.toFixed(1).padStart(7)} ` +
      `${r.mEdge.toFixed(2).padStart(9)}  ${r.m0.toFixed(2).padStart(7)}->${r.m1.toFixed(2).padStart(7)}  ` +
      `${(r.u1 - r.u0).toFixed(2).padStart(9)}  ` +
      `${(r.P0 / 1e5).toFixed(1).padStart(7)} ` +
      `${b(r.dPpred).padStart(7)} ${b(r.P1 - r.P0).padStart(7)} | ` +
      `${b(r.dPm).padStart(6)} ${b(r.dPu).padStart(6)} ${b(r.dPeos).padStart(7)} ${b(r.eosOffset).padStart(7)} ` +
      `${dPdm.toFixed(2).padStart(12)}  ${r.secant}`);
  }
}
