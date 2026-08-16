/**
 * Xe-100 heat-balance probe: where the 200 MWt goes and what fraction of it
 * leaves as electricity.
 *
 * Settles the preset, then reports the cycle terms - reactor power, main
 * steam conditions, turbine output, pump work, condenser rejection - and the
 * gross and net thermal efficiency. Use it to compare cycle changes (extra
 * bundles, feedwater heating) against the plant as it was.
 *
 * Usage: npx tsx scripts/xe100-efficiency.ts [settleSeconds] [presetPath]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import { getTurbineCondenserState } from '../src/simulation';
import type { SimulationState } from '../src/simulation/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const settle = parseFloat(process.argv[2] || '600');
const PRESET = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(HERE, '..', 'src', 'presets', 'xe100.json');

const sim = buildSimFromFile(PRESET);

const T = (id: string) => (sim.state.flowNodes.get(id)?.fluid.temperature ?? NaN) - 273.15;
const P = (id: string) => (sim.state.flowNodes.get(id)?.fluid.pressure ?? NaN) / 1e5;

/** Total mass flow into a node from every connection that feeds it. */
function inflow(state: SimulationState, nodeId: string): number {
  let w = 0;
  for (const c of state.flowConnections) {
    if (c.toNodeId === nodeId) w += c.massFlowRate;
    else if (c.fromNodeId === nodeId) w -= c.massFlowRate;
  }
  return w;
}

/** Mass flow leaving a node toward a named node (sums parallel lines). */
function flowBetween(state: SimulationState, fromId: string, toId: string): number {
  let w = 0;
  for (const c of state.flowConnections) {
    if (c.fromNodeId === fromId && c.toNodeId === toId) w += c.massFlowRate;
    else if (c.fromNodeId === toId && c.toNodeId === fromId) w -= c.massFlowRate;
  }
  return w;
}

/** Every tube-side node of the steam generator (one per bundle). */
function sgTubeNodes(state: SimulationState): string[] {
  return [...state.flowNodes.keys()].filter(id => /^hx-1-tube(-b\d+)?$/.test(id));
}

// Average the reported terms over a LONG window. This plant does not sit
// still - the governor cycles and steam flow swings between a trickle and
// well over design - so a short window reports whichever phase of the cycle
// it happened to land in (25% at 400 s against 35% at 600 s, same run). The
// window has to be long compared with that oscillation for the number to
// mean anything.
const WINDOW = 300;
const samples: Array<{ q: number; turb: number; pump: number; rej: number; steam: number }> = [];

console.log(`Settling ${settle} s...`);
for (let t = 0; t < settle; t++) {
  run(sim, 1, 0.05);
  if (settle - t <= WINDOW) {
    const tc = getTurbineCondenserState();
    samples.push({
      q: sim.state.neutronics.power,
      turb: tc.turbinePower,
      pump: tc.feedwaterPumpWork,
      rej: tc.condenserHeatRejection,
      steam: flowBetween(sim.state, 'hx-1-tube', 'turbine-1') +
        sgTubeNodes(sim.state).filter(id => id !== 'hx-1-tube')
          .reduce((s, id) => s + flowBetween(sim.state, id, 'turbine-1'), 0),
    });
  }
}

const mean = (k: keyof (typeof samples)[0]) =>
  samples.reduce((s, x) => s + x[k], 0) / Math.max(1, samples.length);

const qReactor = mean('q');
const wTurbine = mean('turb');
const wPump = mean('pump');
const qRejected = mean('rej');
const wSteam = mean('steam');

const tubes = sgTubeNodes(sim.state);
const feedT = T('val-fwcv-1');
const mainSteamT = Math.max(...tubes.map(id => T(id)));

console.log(`\n=== Heat balance at t=${sim.state.time.toFixed(0)} s ` +
  `(${WINDOW} s average) ===`);
console.log(`  Reactor thermal power     ${(qReactor / 1e6).toFixed(1).padStart(8)} MWt`);
console.log(`  Turbine gross output      ${(wTurbine / 1e6).toFixed(1).padStart(8)} MWe`);
console.log(`  Feed + condensate pumps   ${(wPump / 1e6).toFixed(2).padStart(8)} MW`);
console.log(`  Net electrical            ${((wTurbine - wPump) / 1e6).toFixed(1).padStart(8)} MWe`);
console.log(`  Condenser rejection       ${(qRejected / 1e6).toFixed(1).padStart(8)} MW`);
console.log(`\n  GROSS efficiency          ${(100 * wTurbine / qReactor).toFixed(2).padStart(8)} %`);
console.log(`  NET efficiency            ${(100 * (wTurbine - wPump) / qReactor).toFixed(2).padStart(8)} %`);

console.log(`\n=== Steam cycle ===`);
console.log(`  Main steam                ${wSteam.toFixed(1)} kg/s at ` +
  `${mainSteamT.toFixed(0)} C, ${P(tubes[0]).toFixed(1)} bar`);
console.log(`  Feedwater into the SG     ${feedT.toFixed(0)} C ` +
  `(${inflow(sim.state, 'val-fwcv-1').toFixed(1)} kg/s through the check valve)`);
console.log(`  Condensate leaving hotwell${T('cond-pump-1').toFixed(0).padStart(5)} C`);
console.log(`  Condenser                 ${T('condenser-1').toFixed(0)} C, ` +
  `${(P('condenser-1') * 1000).toFixed(0)} mbar`);

console.log(`\n=== Steam generator (${tubes.length} bundle${tubes.length > 1 ? 's' : ''}) ===`);
for (const id of tubes) {
  const node = sim.state.flowNodes.get(id)!;
  const o = node.otsg;
  const ev = o?.lastEval;
  const secs = ev ? ev.lengthFracs.map(f => (100 * f).toFixed(0)).join('/') : '-';
  console.log(`  ${id.padEnd(14)} ${node.fluid.mass.toFixed(0).padStart(6)} kg  ` +
    `${(node.fluid.pressure / 1e5).toFixed(1).padStart(6)} bar  ` +
    `${(node.fluid.temperature - 273.15).toFixed(0).padStart(5)} C  ` +
    `sections ${secs} %` +
    (ev ? `  steam out ${(ev.T3 - 273.15).toFixed(0)} C` : ''));
}
console.log(`  Helium: ${T('hx-1-shell').toFixed(0)} C shell, ` +
  `core ${T('rv-1').toFixed(0)} -> ${T('cb-1').toFixed(0)} C, ` +
  `${flowBetween(sim.state, 'cv-1-annulus', 'rv-1').toFixed(1)} kg/s`);

const stats = sim.solver.getMetrics();
console.log(`\nsolver: steps=${stats.totalSteps} rejected=${stats.rejectedSteps} ` +
  `(${(100 * stats.rejectedSteps / Math.max(1, stats.totalSteps)).toFixed(0)}%) ` +
  `dt=${(stats.currentDt * 1e3).toFixed(2)} ms`);
