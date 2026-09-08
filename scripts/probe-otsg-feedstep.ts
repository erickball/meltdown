/**
 * Does a step in the FEED temperature step the tube's published pressure?
 *
 * It used to have to. The economizer was a MASS ledger priced on a linear
 * profile pinned at the INSTANTANEOUS inlet enthalpy, U1 = m1 (u_in +
 * u_f(P))/2, so the inlet multiplied the whole slug's energy: on an Xe-100
 * bundle a 20 K move in the feed is ~10 MJ across a 220 kg slug, all of it
 * landing on the leftovers that set the pressure. Now the slug carries its
 * own (m1, U1) and the profile is derived from the pair, so the inlet prices
 * only the mass entering. This probe is the demonstration: per step it
 * prints the feed enthalpy the classifier sees, the profile the pair implies
 * (its cold end u_a and its mean u1), the slug, the published pressure -
 * and, for contrast, the pressure the SAME totals and the SAME slug MASS
 * would publish under the old pricing (Pold), which is what the pressure
 * used to do.
 *
 *   MODE=step (default)  chill the water standing at the tube's feed nozzle
 *                        by DT kelvin and HOLD it there (a Dirichlet
 *                        boundary on that node, re-imposed every tick - this
 *                        is a probe lever, not conserved physics)
 *   MODE=reversal        trip fw-pump-1 so the feed check valves seat: the
 *                        feed goes to zero and reverses, and neither the
 *                        slug nor the pressure may step beyond what the flow
 *                        change itself implies
 *
 * Usage: npx tsx scripts/probe-otsg-feedstep.ts [warmup s] [window s]
 * Env:   TUBE=hx-1-tube  MODE=step|reversal  DT=20  FINE=0.05
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { applyScenarioAction } from '../src/simulation/scenario';
import type { ScenarioAction } from '../src/simulation/scenario-types';
import {
  tubeWaterState, evaluateOtsgSections, classifyOtsgFlows, otsgWallPin,
} from '../src/simulation/operators/otsg-operator';
import { evaluateOtsgPartition, saturationAtP, subcooledSectionMean } from '../src/simulation/otsg';
import { saturatedLiquidEnergy } from '../src/simulation/water-properties';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const warm = parseFloat(process.argv[2] || '30');
const window = parseFloat(process.argv[3] || '20');
const fine = parseFloat(process.env.FINE || '0.05');
const DT = parseFloat(process.env.DT || '20');
const MODE = (process.env.MODE || 'step').toLowerCase();
const TUBE = process.env.TUBE || 'hx-1-tube';
const preset = path.join(HERE, '..', 'src', 'presets', 'xe100.json');

const sim = buildSimFromFile(preset);

/** The node whose water the closure reads as the economizer's inlet: the
 *  donor across the tube's LOWEST connection (classifyOtsgFlows' rule). */
function inletDonorId(): string {
  const st = sim.state;
  let minElev = Infinity, best = '';
  for (const c of st.flowConnections) {
    if (c.fromNodeId === TUBE) { const e = c.fromElevation ?? 0; if (e < minElev) { minElev = e; best = c.toNodeId; } }
    else if (c.toNodeId === TUBE) { const e = c.toElevation ?? 0; if (e < minElev) { minElev = e; best = c.fromNodeId; } }
  }
  return best;
}

for (let i = 0; i < Math.round(warm / 0.1); i++) {
  sim.state = sim.solver.advance(sim.state, 0.1).state;
  sim.state.pendingEvents = [];
}

const donorId = inletDonorId();
const donor0: any = sim.state.flowNodes.get(donorId)!;
const Thold = donor0.fluid.temperature - DT;
console.log(`\n${TUBE} feed probe, MODE=${MODE} from t=${sim.state.time.toFixed(1)} s, request ${fine} s`);
console.log(`  inlet donor '${donorId}' at ${(donor0.fluid.temperature - 273.15).toFixed(1)} C` +
  (MODE === 'step' ? ` -> held at ${(Thold - 273.15).toFixed(1)} C` : ''));

const REVERSAL: ScenarioAction[] = [{ kind: 'pump', id: 'fw-pump-1', running: false, speed: 0 }];

console.log('      t   dt(ms) rej   hFeed     u_a      u1      m1     Ppub    Pold      T3    Wfeed  regime');
let applied = false;
let lastRej = sim.solver.getMetrics().rejectedSteps;
for (let i = 0; i < Math.round(window / fine); i++) {
  // Two steps of warm window first, so the "before" rows are visible.
  const doIt = i >= 2;
  if (doIt && !applied) {
    if (MODE === 'reversal') for (const a of REVERSAL) applyScenarioAction(sim.state, a);
    applied = true;
  }
  if (MODE === 'step' && applied) {
    const d: any = sim.state.flowNodes.get(donorId)!;
    if (d.fluid.mass > 0) d.fluid.internalEnergy = d.fluid.mass * saturatedLiquidEnergy(Thold);
  }
  sim.state = sim.solver.advance(sim.state, fine).state;
  sim.state.pendingEvents = [];

  const node: any = sim.state.flowNodes.get(TUBE)!;
  const cfg = node.otsg;
  const rej = sim.solver.getMetrics().rejectedSteps - lastRej;
  lastRej = sim.solver.getMetrics().rejectedSteps;
  let ev: any = null, fl: any = null, Pold = NaN, err = '';
  let uA = NaN, u1 = NaN;
  try {
    const r = evaluateOtsgSections(sim.state, TUBE, node, { exact: true });
    ev = r.ev; fl = r.flows;
    const s1 = ev.sections[0];
    u1 = s1.mass > 0 ? s1.hBar - ev.P * s1.vBar : NaN;
    uA = 2 * u1 - ev.sat.u_f;
    const water = tubeWaterState(node);
    const PStart = Math.max(800, node.fluid.pressure - water.gasPressure);
    const flows = classifyOtsgFlows(sim.state, TUBE, node, PStart);
    // The counterfactual: the same totals and the same slug MASS, but priced
    // the old way - a profile pinned at the feed enthalpy of THIS instant.
    const satNow = saturationAtP(PStart);
    Pold = evaluateOtsgPartition(
      node.fluid.mass, water.energy,
      { m1: cfg.m1, U1: cfg.m1 * subcooledSectionMean(flows.uFeed, satNow), uFRef: cfg.uFRef },
      { tubeVolume: node.volume, tubeLength: 1, heatArea: cfg.heatArea },
      otsgWallPin(sim.state, node, flows), PStart,
    ).P / 1e5;
  } catch (e) { err = (e as Error).message.slice(0, 70); }
  console.log(
    `  ${sim.state.time.toFixed(2).padStart(7)} ${(sim.solver.getMetrics().currentDt * 1e3).toFixed(1).padStart(6)} ` +
    `${rej.toString().padStart(3)} ` +
    `${((fl?.hFeed ?? NaN) / 1e3).toFixed(1).padStart(7)} ${(uA / 1e3).toFixed(1).padStart(8)} ` +
    `${(u1 / 1e3).toFixed(1).padStart(7)} ${cfg.m1.toFixed(1).padStart(7)} ` +
    `${(node.fluid.pressure / 1e5).toFixed(2).padStart(8)} ${Pold.toFixed(2).padStart(7)} ` +
    `${((ev?.sections?.[2]?.T ?? NaN) - 273.15).toFixed(0).padStart(6)} ` +
    `${(fl?.WFeed ?? NaN).toFixed(2).padStart(7)}  ${(ev?.regime ?? err)}`);
}
