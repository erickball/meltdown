/**
 * Feed-loop trace for the Xe-100 presets: what the feedwater controller is
 * asked for, what it delivers, and what the boiler does with it.
 *
 * Every PRINT_EVERY seconds (flows are also AVERAGED over the interval - the
 * feed pulses, and an instantaneous sample aliases it): measured feed, the four steam draws the
 * feedforward sums, the controller's error and output, the pump's actual
 * speed, each bundle's inventory / superheat fraction / outlet steam
 * temperature, and reactor power.
 *
 * Usage: npx tsx scripts/probe-xe100-feed-trim.ts <preset.json> <seconds> [printEvery]
 */
import { buildSimFromFile } from './lib/sim-harness';
import { evaluateOtsgSections } from '../src/simulation/operators/otsg-operator';

const [presetPath, secArg, everyArg] = process.argv.slice(2);
const seconds = parseFloat(secArg ?? '1200');
const every = parseFloat(everyArg ?? '150');
const sim = buildSimFromFile(presetPath);
const DRAWS = [
  'flow-hx-1-turbine-1', 'flow-hx-1-turbine-1-hx-1-tube-2-b2-inlet',
  'flow-hx-1-val-bleed-1', 'flow-hx-1-val-bleed-1-hx-1-tube-2-b2-val-bleed-1-in',
];
const flow = (id: string) => sim.state.flowConnections.find(c => c.id === id)?.massFlowRate ?? NaN;
const C = (T: number) => (T - 273.15).toFixed(1);

let next = 0;
let accT = 0, accFeed = 0, accDraw = 0, accIn = 0;
const tubeIn = ['flow-val-fwcv-1-hx-1', 'flow-val-fwcv-1-hx-1-val-fwcv-1-out-hx-1-tube-1-b2'];
const end = sim.state.time + seconds;
while (sim.state.time < end) {
  sim.state = sim.solver.advance(sim.state, 0.05).state;
  sim.state.pendingEvents = [];
  accT += 0.05;
  accFeed += 0.05 * flow('flow-fw-pump-1-val-fpcv-1');
  accDraw += 0.05 * DRAWS.map(flow).reduce((a, b) => a + b, 0);
  accIn += 0.05 * tubeIn.map(flow).reduce((a, b) => a + b, 0);
  if (sim.state.time < next) continue;
  next += every;
  const s = sim.state;
  const anyS = s as unknown as { controllers?: Map<string, any>; components?: { controllers?: Map<string, any>; pumps?: Map<string, any> }; neutronics?: { power: number } };
  const ctl = (anyS.controllers ?? anyS.components?.controllers)?.get('ctl-fw-1');
  const pump = anyS.components?.pumps?.get('fw-pump-1');
  const draws = DRAWS.map(flow);
  const tubes = ['hx-1-tube', 'hx-1-tube-b2'].map(id => {
    const node = s.flowNodes.get(id)!;
    const ev = evaluateOtsgSections(s, id, node).ev;
    return `${id.replace('hx-1-', '')}: m=${node.fluid.mass.toFixed(0)} L3=${ev.sections[2].lengthFrac.toFixed(3)} ` +
      `TOut=${C(ev.TSteamOut)} T3=${C(ev.sections[2].T)}`;
  });
  console.log(`t=${s.time.toFixed(0)} P=${((anyS.neutronics?.power ?? NaN) / 1e6).toFixed(1)}MWt ` +
    `feed=${flow('flow-fw-pump-1-val-fpcv-1').toFixed(2)} draws=${draws.map(d => d.toFixed(2)).join('+')}=${draws.reduce((a, b) => a + b, 0).toFixed(2)} ` +
    `AVG feed=${(accFeed / accT).toFixed(2)} intoTubes=${(accIn / accT).toFixed(2)} draws=${(accDraw / accT).toFixed(2)} ` +
    `ctl: err=${ctl?.lastError?.toFixed(3)} out=${ctl?.lastOutput?.toFixed(3)} actual=${ctl?.actual?.toFixed(3)} mode=${ctl?.mode} ` +
    `pump: speed=${pump?.speed?.toFixed(3)} | ${tubes.join(' | ')}`);
  accT = 0; accFeed = 0; accDraw = 0; accIn = 0;
}
