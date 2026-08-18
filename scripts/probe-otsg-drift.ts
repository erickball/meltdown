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
import { otsgRates } from '../src/simulation/otsg';
import { evaluateOtsgSections, tubeWaterState, otsgWaterSideDuties } from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const seconds = parseFloat(process.argv[2] || '400');

const sim = buildSimFromFile(PRESET);
const ID = 'hx-1-tube';
const ID2 = 'hx-1-tube-b2';

function line(state: SimulationState) {
  const node = state.flowNodes.get(ID)!;
  const cfg = node.otsg!;
  const water = tubeWaterState(node);
  let evStr = '(eval refused)';
  let ratesStr = '';
  try {
    const { ev, flows } = evaluateOtsgSections(state, ID, node);
    const m1 = ev.sections[0].mass;
    const mLeft = node.fluid.mass - m1;
    const ULeft = water.energy - m1 * (ev.sections[0].hBar - ev.P * ev.sections[0].vBar);
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
  console.log(
    `${state.time.toFixed(1).padStart(7)} ` +
    `P=${(node.fluid.pressure / 1e5).toFixed(1).padStart(6)} ` +
    `Pu=${(water.pressure / 1e5).toFixed(1).padStart(6)} ` +
    `m=${node.fluid.mass.toFixed(1).padStart(6)} ` +
    `U=${(water.energy / 1e9).toFixed(3).padStart(6)} ` +
    `m1L=${cfg.m1.toFixed(0).padStart(5)} ` +
    `${evStr}  ${ratesStr}`
  );
}

function line2(state: SimulationState) {
  const b2 = state.flowNodes.get(ID2);
  if (!b2) return;
  const conns = state.flowConnections
    .filter(c => c.fromNodeId === ID || c.toNodeId === ID)
    .map(c => `${c.toNodeId === ID ? '<-' : '->'}${(c.toNodeId === ID ? c.fromNodeId : c.toNodeId).slice(0, 12)}:${c.massFlowRate.toFixed(1)},${c.currentFlowPhase ?? '?'}`)
    .join(' ');
  console.log(`        b2: m=${b2.fluid.mass.toFixed(1)} P=${(b2.fluid.pressure / 1e5).toFixed(1)} m1L=${b2.otsg!.m1.toFixed(0)}  b1 conns: ${conns}`);
}

// Ceiling watch: the property surface now EVALUATES dense states beyond the
// IF97 boundary so transients can transit them - but no accepted plant state
// should LIVE up there. Track the worst accepted pressure per node.
const maxP = new Map<string, number>();
function scanPressures(state: SimulationState) {
  for (const [id, n] of state.flowNodes) {
    if (n.isBoundary) continue;
    if ((n.fluid.pressure ?? 0) > (maxP.get(id) ?? 0)) maxP.set(id, n.fluid.pressure);
  }
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
  line2(sim.state);
  scanPressures(sim.state);
}
console.log('Worst accepted pressures (nodes over 25 MPa):');
let any = false;
for (const [id, P] of [...maxP.entries()].sort((a, b) => b[1] - a[1])) {
  if (P > 25e6) { console.log(`  ${id}: ${(P / 1e5).toFixed(0)} bar`); any = true; }
}
if (!any) console.log('  none - every sampled node stayed under 250 bar');
