/**
 * Is the OTSG partition's volume residual MONOTONE in pressure?
 *
 * KNOWN OPEN at the time of writing: on ~0.7% of tube-ticks of an Xe-100
 * station blackout it is NOT - R(P) folds and there are three roots. See the
 * commit that added this probe for the mechanism (the economizer's
 * reconciled mass rises with the TRIAL pressure, which concentrates the
 * leftover energy on fewer kilograms of steam and asks for more volume, and
 * near the critical point that beats compression). It is latent rather than
 * loud because the warm start normally sits on one root and stays there.
 *
 *  The closure gets its pressure by a 1-D root find on R(P) = sum(m_i v_i) - V,
 *  warm-started from the last published pressure, and takes the first sign
 *  change it walks into. That is only well posed if R is monotone: a fold
 *  gives several roots, the warm start picks one, and the published pressure
 *  becomes hysteretic - it can jump with nothing in the totals jumping.
 *
 *  This runs the plant and, every tick, scans R(P) across a wide pressure
 *  band at the node's own inputs (reconciliation reference held, as the
 *  closure holds it) and counts sign reversals of dR/dP. Reported per tube.
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { applyScenarioAction } from '../src/simulation/scenario';
import type { ScenarioAction } from '../src/simulation/scenario-types';
import { otsgPartitionAtP, P_CRITICAL } from '../src/simulation/otsg';
import { classifyOtsgFlows, tubeWaterState } from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const seconds = parseFloat(process.argv[2] || '180');
const tripTime = parseFloat(process.argv[3] || '20');
const preset = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const TRIP = (process.env.TRIP || 'sbo').toLowerCase();
const TUBES = (process.env.TUBES || 'hx-1-tube,hx-1-tube-b2').split(',');
const DU3S = (process.env.DU3 || '0,200000,400000,800000').split(',').map(Number);

const ACTIONS: Record<string, ScenarioAction[]> = {
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
const sim = buildSimFromFile(preset);
let tripped = false;
let nTick = 0, nFold = 0;
let worst = { t: 0, tube: '', du3: 0, roots: 1, detail: '' };
const rows: string[] = [];
const NP = 40;
for (let i = 0; i < Math.round(seconds / 0.1); i++) {
  if (!tripped && sim.state.time >= tripTime) {
    for (const a of ACTIONS[TRIP]) applyScenarioAction(sim.state, a);
    tripped = true;
  }
  try { sim.state = sim.solver.advance(sim.state, 0.1).state; }
  catch (e) { console.log(`!! diverged ${sim.state.time.toFixed(2)}: ${(e as Error).message.slice(0, 150)}`); break; }
  sim.state.pendingEvents = [];
  if (sim.state.time < tripTime) continue;
  for (const TUBE of TUBES) {
    const node = sim.state.flowNodes.get(TUBE);
    if (!node || !(node.fluid.mass > 0)) continue;
    const cfg: any = node.otsg;
    let water, flows;
    try { water = tubeWaterState(node); flows = classifyOtsgFlows(sim.state, TUBE, node, node.fluid.pressure); }
    catch { continue; }
    const V = node.volume;
    const P0 = Math.max(1e5, water.pressure);
    nTick++;
    for (const du3 of DU3S) {
      let prevR = NaN, reversals = 0;
      const trace: string[] = [];
      for (let k = 0; k <= NP; k++) {
        const P = (P0 / 3) * Math.pow(9, k / NP);
        if (P > 0.998 * P_CRITICAL) break;   // no dome above it; scan ends
        let R: number;
        try {
          R = otsgPartitionAtP(P, {
            massTotal: node.fluid.mass, UTotal: water.energy, m1Ledger: cfg.m1,
            uFeedIn: flows.uFeed, uFRef: cfg.uFRef, du3,
          }).Vsum - V;
        } catch { prevR = NaN; continue; }
        // The sliver sentinel deliberately returns a huge volume ("this
        // pressure is far too low"); it is not part of the smooth branch.
        if (Math.abs(R) > 100 * V) { prevR = NaN; continue; }
        // Count ZERO CROSSINGS of R, which is what "several roots" means -
        // a slope reversal far from zero (the flooded branch turns over by
        // ~1e-5 m3 near the critical point, at R = -0.7 m3) cannot make an
        // extra root and does not concern the solver.
        if (Number.isFinite(prevR) && Math.sign(R) !== Math.sign(prevR)) reversals++;
        prevR = R;
        trace.push(`${(P / 1e5).toFixed(0)}:${R.toExponential(1)}`);
      }
      if (reversals > 1) {
        nFold++;
        if (reversals >= worst.roots) worst = { t: sim.state.time, tube: TUBE, du3, roots: reversals, detail: trace.join(' ') };
        if (rows.length < 12) rows.push(`  t=${sim.state.time.toFixed(1)} ${TUBE} du3=${(du3 / 1e3).toFixed(0)} roots=${reversals} (mass=${node.fluid.mass.toFixed(1)} m1L=${cfg.m1.toFixed(1)})`);
      }
    }
  }
}
console.log(`\nR(P) monotonicity: ${nFold} folded scans of ${nTick * DU3S.length} (${nTick} tube-ticks x ${DU3S.length} pin offsets)`);
if (nFold) {
  console.log(`worst: t=${worst.t.toFixed(1)} ${worst.tube} du3=${(worst.du3 / 1e3).toFixed(0)} kJ/kg, ${worst.roots} roots`);
  console.log(`  ${worst.detail}`);
}
for (const r of rows) console.log(r);
