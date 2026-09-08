/**
 * Step-by-step trace of what an OTSG tube PUBLISHES, beside every input the
 * closure was handed.
 *
 * The 20%-per-step pressure guard rejects on the partition's output, so when
 * a run is losing half its steps to `sanity:<tube>:pressure` the question is
 * always the same: did an INPUT jump, or did the closure jump on smooth
 * inputs? Both answers are in one row here - the totals, the ledger and its
 * reference, the classified feed and draw, the wall temperature, the pin's
 * own du3, the sections, and an EXACT re-solve (Pex) beside the published
 * pressure so a tangent-riding evaluation drifting from the curve is visible
 * too. This is how the hard-coded 200 C feed-enthalpy fallback was found:
 * uFeed stepping 1136 -> 840 kJ/kg in one row, with everything else smooth.
 *
 * Usage: npx tsx scripts/probe-otsg-step.ts [warmup s] [window s] [trip s]
 * Env:   TUBE=hx-1-tube  FINE=0.02 (seconds per advance request)
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { applyScenarioAction } from '../src/simulation/scenario';
import type { ScenarioAction } from '../src/simulation/scenario-types';
import { tubeWaterState, evaluateOtsgSections, classifyOtsgFlows, otsgWallPin } from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const warm = parseFloat(process.argv[2] || '100');
const window = parseFloat(process.argv[3] || '6');
const tripTime = parseFloat(process.argv[4] || '20');
const fine = parseFloat(process.env.FINE || '0.02');
const preset = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const TUBE = process.env.TUBE || 'hx-1-tube';
const actions: ScenarioAction[] = [
  { kind: 'pump', id: 'pump-1', running: false, speed: 0 },
  { kind: 'pump', id: 'fw-pump-1', running: false, speed: 0 },
  { kind: 'pump', id: 'cond-pump-1', running: false, speed: 0 },
  { kind: 'controller', id: 'ctl-fw-1', mode: 'manual', manualOutput: 0 },
  { kind: 'controller', id: 'ctl-msp-1', mode: 'manual', manualOutput: 0.02 },
  { kind: 'turbine-governor', id: 'turbine-1', value: 0.02 },
  { kind: 'valve', id: 'val-bleed-1', position: 0 },
  { kind: 'controller', id: 'ctl-fwh-1', mode: 'manual', manualOutput: 0 },
];
const sim = buildSimFromFile(preset);
let tripped = false;
for (let i = 0; i < Math.round(warm / 0.1); i++) {
  if (!tripped && sim.state.time >= tripTime) { for (const a of actions) applyScenarioAction(sim.state, a); tripped = true; }
  sim.state = sim.solver.advance(sim.state, 0.1).state;
  sim.state.pendingEvents = [];
}
let lastRej = sim.solver.getMetrics().rejectedSteps;
console.log(`\n${TUBE} step trace from t=${sim.state.time.toFixed(1)} (SBO@${tripTime}s), request ${fine}s`);
console.log('     t     dt(ms)  rej   Ppub(bar)  dP%   mass(kg)   U(MJ)   m1L(kg)  m1sec  m2     m3    uFRef   du3  Wstm  Wfeed  uFeed  TW3  regime');
let prevP = NaN;
for (let i = 0; i < Math.round(window / fine); i++) {
  const r = sim.solver.advance(sim.state, fine);
  sim.state = r.state;
  sim.state.pendingEvents = [];
  const node: any = sim.state.flowNodes.get(TUBE)!;
  const cfg = node.otsg;
  const water = tubeWaterState(node);
  const rej = sim.solver.getMetrics().rejectedSteps - lastRej;
  lastRej = sim.solver.getMetrics().rejectedSteps;
  const P = node.fluid.pressure;
  let ev: any = null, err = '', fl: any = null, pin: any = null;
  try {
    const r = evaluateOtsgSections(sim.state, TUBE, node, { exact: true });
    ev = r.ev; fl = r.flows;
    pin = otsgWallPin(sim.state, node, fl);
  } catch (e) { err = (e as Error).message.slice(0, 60); }
  const dP = Number.isFinite(prevP) ? (100 * (P - prevP)) / Math.max(prevP, 2e5) : 0;
  console.log(
    `  ${sim.state.time.toFixed(3)} ${(sim.solver.getMetrics().currentDt * 1e3).toFixed(2).padStart(8)} ` +
    `${rej.toString().padStart(4)} ${(P / 1e5).toFixed(2).padStart(10)} ${dP.toFixed(1).padStart(6)} ` +
    `${node.fluid.mass.toFixed(2).padStart(9)} ${(water.energy / 1e6).toFixed(2).padStart(8)} ` +
    `${cfg.m1.toFixed(2).padStart(8)} ` +
    `${(ev?.sections?.[0]?.mass ?? NaN).toFixed(2).padStart(7)} ${(ev?.sections?.[1]?.mass ?? NaN).toFixed(2).padStart(6)} ` +
    `${(ev?.sections?.[2]?.mass ?? NaN).toFixed(2).padStart(6)} ` +
    `${((cfg.uFRef ?? NaN) / 1e3).toFixed(1).padStart(7)} ${(ev ? (ev.u3 - ev.sat.u_g) / 1e3 : NaN).toFixed(0).padStart(6)} ` +
    `${(fl?.WSteamOut ?? NaN).toFixed(2).padStart(6)} ${(fl?.WFeed ?? NaN).toFixed(2).padStart(6)} ` +
    `${(fl?.uFeed / 1e3 ?? NaN).toFixed(0).padStart(6)} ${((pin?.TWall3 ?? NaN) - 273.15).toFixed(0).padStart(5)} ` +
    `${(ev?.regime ?? '-').padEnd(11)} Pex=${ev ? (ev.P / 1e5).toFixed(2) : err}`);
  prevP = P;
}
