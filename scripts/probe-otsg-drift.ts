/**
 * OTSG economizer-ledger drift probe.
 *
 * Runs the Xe-100 headless and logs, every second, the tube node's totals
 * against the integrated economizer ledger: U1, the mass it implies, the
 * leftover (u,v) the partition hands the boiling/superheat solve, and the
 * flow/duty terms feeding dU1. The point is to see WHICH term walks the
 * ledger away from the totals before the run corners itself at t~368s.
 *
 * Usage: npx tsx scripts/probe-otsg-drift.ts [seconds]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import type { SimulationState } from '../src/simulation/types';
import { evaluateOtsgAtP, otsgRates, subcooledSectionMean, saturationAtP } from '../src/simulation/otsg';
import { tubeWaterState, classifyOtsgFlows, otsgWaterSideDuties } from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const seconds = parseFloat(process.argv[2] || '400');

const sim = buildSimFromFile(PRESET);
const ID = 'hx-1-tube';

function line(state: SimulationState) {
  const node = state.flowNodes.get(ID)!;
  const cfg = node.otsg!;
  const water = tubeWaterState(node);
  const flows = classifyOtsgFlows(state, ID, node, water.pressure);
  let evStr = '(eval refused)';
  let ratesStr = '';
  try {
    const ev = evaluateOtsgAtP(
      cfg.U1, node.fluid.mass, water.energy, water.pressure, flows.uFeed,
      { tubeVolume: node.volume, tubeLength: 1, heatArea: cfg.heatArea },
    );
    const m1 = ev.sections[0].mass;
    const mLeft = node.fluid.mass - m1;
    const ULeft = water.energy - cfg.U1;
    const VLeft = node.volume - m1 * ev.sections[0].vBar;
    evStr =
      `m1=${m1.toFixed(1).padStart(6)} ` +
      `mL=${mLeft.toFixed(1).padStart(6)} ` +
      `uL=${(ULeft / mLeft / 1e3).toFixed(0).padStart(5)} ` +
      `vL=${(VLeft / mLeft).toFixed(4).padStart(7)} ` +
      `${ev.regime} L=${ev.sections.map(s => (100 * s.lengthFrac).toFixed(0)).join('/')}`;
    // Recompute the rate terms the operator would emit at this state
    const metalT = cfg.metalNodeIds.map(mid =>
      state.thermalNodes.get(mid)?.temperature ?? NaN) as [number, number, number];
    const duties = otsgWaterSideDuties(ev, flows, metalT);
    const r = otsgRates(ev, flows.WFeed, flows.hFeed, flows.WSteamOut,
      duties.Q1, duties.Q2, duties.Q3);
    ratesStr =
      `WF=${flows.WFeed.toFixed(2).padStart(6)} ` +
      `WS=${flows.WSteamOut.toFixed(2).padStart(6)} ` +
      `W12=${r.W12.toFixed(2).padStart(6)} ` +
      `Q1=${(duties.Q1 / 1e6).toFixed(2).padStart(6)} ` +
      `dU1=${(r.dU1 / 1e6).toFixed(2).padStart(7)} ` +
      `uF=${(flows.uFeed / 1e3).toFixed(0).padStart(4)}`;
  } catch (e) {
    evStr = `(eval refused: ${e instanceof Error ? e.message.slice(0, 80) : e})`;
  }
  const sat = saturationAtP(water.pressure);
  console.log(
    `${state.time.toFixed(1).padStart(7)} ` +
    `P=${(water.pressure / 1e5).toFixed(1).padStart(6)} ` +
    `m=${node.fluid.mass.toFixed(1).padStart(6)} ` +
    `U=${(water.energy / 1e9).toFixed(3).padStart(6)} ` +
    `U1=${(cfg.U1 / 1e9).toFixed(3).padStart(6)} ` +
    `u1b=${(subcooledSectionMean(flows.uFeed, sat) / 1e3).toFixed(0).padStart(4)} ` +
    `${evStr}  ${ratesStr}`
  );
}

line(sim.state);
for (let t = 0; t < seconds; t += 1) {
  try {
    run(sim, 1, 0.05);
  } catch (e: any) {
    console.log(`\n!!! THREW at t=${sim.state.time.toFixed(2)}s: ${e.message}`);
    break;
  }
  line(sim.state);
}
