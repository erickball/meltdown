/**
 * Steam-generator sizing probe for the Xe-100 presets: one long run, one line
 * of plant state per interval, so several SG sizes can be compared side by
 * side at the same times and the trend toward the settled state is visible.
 *
 * Optionally resizes the SG before building, the same way gen-xe100.ts does
 * (SG_AREA_FACTOR / SG_TUBE_COUNT there): `areaFactor` multiplies the helical
 * bundle's packing-derived tube length (hx-bundles.ts), `tubeCount` sets the
 * number of tubes that length is divided among. `circulatorSpeed` overrides the
 * helium circulator's fixed speed (pump-1), to look at the design helium flow.
 *
 * Flows, powers and the solver's step statistics are AVERAGED over each
 * interval; temperatures, pressures and controller outputs are the values at
 * its end.
 *
 * Usage: npx tsx scripts/probe-xe100-sg-size.ts <preset.json> <seconds> [printEvery] [areaFactor] [tubeCount] [circulatorSpeed]
 */
import * as fs from 'fs';
import { buildSimFromPlantJson } from './lib/sim-harness';
import { getTurbineCondenserState } from '../src/simulation';
import { helicalLengthFactor, hxTubeLength } from '../src/simulation/hx-bundles';
import type { SimulationState } from '../src/simulation/types';

const [presetPath, secArg, everyArg, factorArg, countArg, circArg] = process.argv.slice(2);
const seconds = parseFloat(secArg ?? '9000');
const every = parseFloat(everyArg ?? '900');

const plant = JSON.parse(fs.readFileSync(presetPath, 'utf-8'));
const hx = (plant.components as Array<[string, any]>).find(([id]) => id === 'hx-1')![1];
if (countArg !== undefined) hx.tubeCount = parseInt(countArg, 10);
if (factorArg !== undefined && parseFloat(factorArg) !== 1) {
  hx.tubeLengthFactor = helicalLengthFactor(hx) * parseFloat(factorArg);
}
if (circArg !== undefined) {
  const circ = (plant.components as Array<[string, any]>).find(([id]) => id === 'pump-1')![1];
  circ.speed = parseFloat(circArg);
  console.log(`Circulator pump-1 speed set to ${circ.speed}`);
}
const tubeLen = hxTubeLength(hx);
console.log(`SG: ${hx.tubeCount} tubes x ${tubeLen.toFixed(1)} m, OD ${(hx.tubeOD * 1e3).toFixed(0)} mm, ` +
  `area ${(Math.PI * hx.tubeOD * tubeLen * hx.tubeCount).toFixed(0)} m2, ` +
  `packing ${(100 * 0.20 * (hx.tubeLengthFactor ?? helicalLengthFactor(hx)) / helicalLengthFactor(hx)).toFixed(0)}% of the coil annulus`);

const sim = buildSimFromPlantJson(plant);

const node = (id: string) => sim.state.flowNodes.get(id);
const C = (id: string) => ((node(id)?.fluid.temperature ?? NaN) - 273.15).toFixed(1);
const bar = (id: string) => ((node(id)?.fluid.pressure ?? NaN) / 1e5).toFixed(2);

function flowBetween(state: SimulationState, fromId: string, toId: string): number {
  let w = 0;
  for (const c of state.flowConnections) {
    if (c.fromNodeId === fromId && c.toNodeId === toId) w += c.massFlowRate;
    else if (c.fromNodeId === toId && c.toNodeId === fromId) w -= c.massFlowRate;
  }
  return w;
}
const TUBES = ['hx-1-tube', 'hx-1-tube-b2'];

const TICK = 0.05;
let acc = { t: 0, q: 0, he: 0, steam: 0, bleed: 0, feed: 0, turb: 0, pump: 0, rej: 0 };
let lastSteps = 0, lastRejected = 0, lastWall = Date.now();
let next = every;
const end = sim.state.time + seconds;

while (sim.state.time < end) {
  sim.state = sim.solver.advance(sim.state, TICK).state;
  sim.state.pendingEvents = [];
  const s = sim.state;
  const tc = getTurbineCondenserState();
  acc.t += TICK;
  acc.q += TICK * s.neutronics.power;
  acc.he += TICK * flowBetween(s, 'cv-1-annulus', 'rv-1');
  // Off the main steam header (pipe-ms-1) since the bundles stopped
  // feeding the turbine and the bleed directly.
  acc.steam += TICK * flowBetween(s, 'pipe-ms-1', 'turbine-1');
  acc.bleed += TICK * flowBetween(s, 'pipe-ms-1', 'val-bleed-1');
  acc.feed += TICK * TUBES.reduce((a, id) => a + flowBetween(s, 'val-fwcv-1', id), 0);
  acc.turb += TICK * tc.turbinePower;
  acc.pump += TICK * tc.feedwaterPumpWork;
  acc.rej += TICK * tc.condenserHeatRejection;
  if (s.time < next) continue;
  next += every;

  const m = sim.solver.getMetrics();
  const steps = m.totalSteps - lastSteps, rejected = m.rejectedSteps - lastRejected;
  const wall = (Date.now() - lastWall) / 1000;
  lastSteps = m.totalSteps; lastRejected = m.rejectedSteps; lastWall = Date.now();
  const anyS = s as unknown as {
    controllers?: Map<string, any>;
    components?: { controllers?: Map<string, any>; pumps?: Map<string, any> };
  };
  const ctls = anyS.controllers ?? anyS.components?.controllers;
  const ctl = (id: string) => {
    const c = ctls?.get(id);
    return `${id.replace('ctl-', '').replace('-1', '')}=${c?.lastOutput?.toFixed(3)}`;
  };
  const pumpSpeed = (id: string) => anyS.components?.pumps?.get(id)?.speed?.toFixed(3);
  const a = (k: keyof typeof acc, scale = 1) => (acc[k] / acc.t / scale).toFixed(1);
  const tubes = TUBES.map(id => {
    const n = node(id)!;
    const ev = n.otsg?.lastEval;
    return `${id.replace('hx-1-', '')} ${n.fluid.mass.toFixed(0)}kg ${(n.fluid.pressure / 1e5).toFixed(1)}bar ` +
      `out ${ev ? (ev.TSteamOut - 273.15).toFixed(0) : '-'}C sec ${ev ? ev.lengthFracs.map(f => (100 * f).toFixed(0)).join('/') : '-'}`;
  });
  console.log(
    `t=${s.time.toFixed(0)} | Q ${a('q', 1e6)} MWt | He ${a('he')} kg/s core ${C('rv-1')}->${C('cb-1')} C, ` +
    `shell ${C('hx-1-shell')} sgv ${C('tank-sg-1')} | P(bar) duct ${bar('cv-1-inner')} shell ${bar('hx-1-shell')} ` +
    `sgv ${bar('tank-sg-1')} circ ${bar('pump-1')} rv ${bar('rv-1')} cb ${bar('cb-1')} | ` +
    `steam ${a('steam')} bleed ${a('bleed')} feed ${a('feed')} kg/s | ${tubes.join(' ; ')} | ` +
    `feedT ${C('val-fwcv-1')} C, P(bar) fwpump ${bar('fw-pump-1')} fwcv ${bar('val-fwcv-1')} fwh-shell ${bar('fwh-1-shell')} ` +
    `turbine ${bar('turbine-1')} | gross ${a('turb', 1e6)} MWe pumps ${(acc.pump / acc.t / 1e6).toFixed(2)} MW ` +
    `rej ${a('rej', 1e6)} MW eff ${(100 * acc.turb / acc.q).toFixed(1)}% | ` +
    `ctl ${['ctl-rods-1', 'ctl-msp-1', 'ctl-fw-1', 'ctl-fwh-1', 'ctl-fwhlvl-1'].map(ctl).join(' ')} ` +
    `speed fw=${pumpSpeed('fw-pump-1')} circ=${pumpSpeed('pump-1')} | ` +
    `steps ${steps} rej ${rejected} (${(100 * rejected / Math.max(1, steps)).toFixed(1)}%) ` +
    `mean dt ${(1e3 * acc.t / Math.max(1, steps - rejected)).toFixed(2)} ms, ${wall.toFixed(0)} s wall` +
    // Running totals since the build, most frequent first
    ` | rejected by ${[...sim.solver.rejectionStats.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4)
      .map(([cause, n]) => `${cause} ${n}`).join(', ') || 'nothing'}`);
  acc = { t: 0, q: 0, he: 0, steam: 0, bleed: 0, feed: 0, turb: 0, pump: 0, rej: 0 };
}
