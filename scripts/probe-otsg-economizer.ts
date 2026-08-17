/**
 * Where does the economizer ledger go wrong?
 *
 * OtsgLedgerCheckOperator reports that the subcooled section's energy and the
 * node's totals disagree by gigajoules in running plants, and that the error
 * scales with how cold the feed is. This probe watches the economizer's own
 * energy budget while a plant runs, using the operator's OWN classification
 * and duty functions so it cannot drift from the physics:
 *
 *   dU1 = W_feed h_in - W12 h_f + Q1 - P v1 dm1
 *
 * At steady state the section holds still when W12 = W_feed and
 *
 *   Q1 = W_feed (h_f - h_in)          <- the duty to heat feed to saturation
 *
 * so the columns to watch are Q1 against that requirement, and whether the
 * section-1 WALL is even above saturation - because if it is not, the water
 * in that section can never reach h_f, and the section has nowhere to end.
 *
 * Run: npx tsx scripts/probe-otsg-economizer.ts [seconds] [preset]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import type { SimulationState } from '../src/simulation/types';
import { evaluateOtsgAtP, saturationAtP, subcooledSectionMean } from '../src/simulation/otsg';
import {
  tubeWaterState, classifyOtsgFlows, otsgWaterSideDuties,
} from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const seconds = parseFloat(process.argv[2] || '90');
const preset = process.argv[3] || 'xe100';
const PRESET = path.join(HERE, '..', 'src', 'presets', `${preset}.json`);

const sim = buildSimFromFile(PRESET);
const C = (K: number) => (K - 273.15).toFixed(0);

function report(state: SimulationState) {
  for (const [id, node] of state.flowNodes) {
    const cfg = node.otsg;
    if (!cfg) continue;
    if (!id.endsWith('-tube')) continue;   // one bundle is enough

    const water = tubeWaterState(node);
    const flows = classifyOtsgFlows(state, id, node, water.pressure);
    const ev = evaluateOtsgAtP(
      cfg.U1, node.fluid.mass, water.energy, water.pressure, flows.uFeed,
      { tubeVolume: node.volume, tubeLength: 1, heatArea: cfg.heatArea },
    );
    const metals = cfg.metalNodeIds.map(mid => state.thermalNodes.get(mid)!.temperature);
    const { Q1, Q2, Q3 } = otsgWaterSideDuties(ev, flows, metals as [number, number, number]);

    // What the economizer needs to do its job, and what it is being given
    const need = flows.WFeed * (ev.sat.h_f - flows.hFeed);
    const u1Bar = subcooledSectionMean(flows.uFeed, ev.sat);
    const m1 = ev.sections[0].mass;

    console.log(
      `${state.time.toFixed(0).padStart(5)} ` +
      `${flows.WFeed.toFixed(1).padStart(6)} ` +
      `${(flows.hFeed / 1e3).toFixed(0).padStart(6)} ` +
      `${C(ev.sat.T).padStart(6)} ` +
      `${metals.map(t => C(t).padStart(5)).join('')} ` +
      `${(metals[0] - ev.sat.T).toFixed(0).padStart(7)} ` +
      `${(Q1 / 1e6).toFixed(1).padStart(7)} ${(need / 1e6).toFixed(1).padStart(7)} ` +
      `${(Q1 / Math.max(1e-6, need)).toFixed(2).padStart(6)} ` +
      `${(Q2 / 1e6).toFixed(1).padStart(7)} ${(Q3 / 1e6).toFixed(1).padStart(7)} ` +
      `${m1.toFixed(0).padStart(7)} ${(cfg.U1 / 1e9).toFixed(2).padStart(6)} ` +
      `${(u1Bar / 1e3).toFixed(0).padStart(6)} ` +
      `${ev.sections.map(s => (100 * s.lengthFrac).toFixed(0).padStart(4)).join('')} ` +
      `${C(ev.sections[2].T).padStart(7)}`
    );
  }
}

console.log(
  `\n${preset}: economizer energy budget. "need" is W_feed (h_f - h_feed) - the duty that\n` +
  `holds the section still. Twall1-Tsat below zero means the section-1 wall cannot bring\n` +
  `its water to saturation at all, so the section has no length that ends it.\n`);
console.log(
  '    t  W_fd  h_fd  Tsat  Tm1  Tm2  Tm3   dTwall     Q1   need  ratio     Q2     Q3      m1    U1  u1bar   L1  L2  L3      T3');
report(sim.state);
for (let t = 0; t < seconds; t++) {
  try {
    run(sim, 1, 0.05);
  } catch (e: any) {
    console.log(`\n!!! THREW at t=${sim.state.time.toFixed(2)}s: ${e.message}`);
    break;
  }
  if (t % Math.max(1, Math.round(seconds / 25)) === 0) report(sim.state);
}
report(sim.state);
console.log('');
