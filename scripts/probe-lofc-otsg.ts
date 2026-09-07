/**
 * What the OTSG partition's pressure is sensitive to during a loss of
 * primary flow.
 *
 * The partition's pressure comes from the volume constraint sum(m_i v_i) = V
 * with the economizer slug m1 supplied by its own mass ledger. When the tube
 * floods (or bottles up), m1 approaches the whole node inventory and the
 * leftovers mR = mass - m1 that set the pressure become a difference of two
 * nearly equal large numbers - the same for their energy UR = U - m1*u1.
 * This probe prints, once a second, the closure's OWN implicit-function
 * tangent (OtsgEval.tangent: dP/dm, dP/dU, dP/dm1) beside the section masses,
 * so the conditioning can be read as bar-per-kg rather than inferred from
 * rejection counts.
 *
 * Usage: npx tsx scripts/probe-lofc-otsg.ts [seconds] [tripTime] [preset]
 * Env:   TRIP=circulator|sbo|none
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { applyScenarioAction } from '../src/simulation/scenario';
import type { ScenarioAction } from '../src/simulation/scenario-types';
import { evaluateOtsgSections, tubeWaterState } from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const seconds = parseFloat(args[0] || '180');
const tripTime = parseFloat(args[1] || '20');
const preset = args[2] || path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const TRIP = (process.env.TRIP || 'circulator').toLowerCase();
const TUBE = process.env.TUBE || 'hx-1-tube';

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
const actions = ACTIONS[TRIP];
if (!actions) throw new Error(`unknown TRIP=${TRIP}`);

const sim = buildSimFromFile(preset);
console.log(`\n${TUBE} partition conditioning, trip=${TRIP}@${tripTime}s`);
console.log('   t(s)   P(bar)  Pbulk  regime      mass    m1     mR     m2     m3   ' +
  'UR(MJ)  U(MJ)  UR/U   dP/dm(bar/kg)  dP/dU(bar/MJ)  dP/dm1(bar/kg)  Wfeed  Wdraw');

let tripped = false;
let nextPrint = 0;
for (let i = 0; i < Math.round(seconds / 0.1); i++) {
  if (!tripped && sim.state.time >= tripTime) {
    for (const a of actions) applyScenarioAction(sim.state, a);
    if (actions.length) console.log(`  --- t=${sim.state.time.toFixed(1)}: ${TRIP} trip ---`);
    tripped = true;
  }
  try {
    sim.state = sim.solver.advance(sim.state, 0.1).state;
  } catch (e) {
    console.log(`!! diverged at ${sim.state.time.toFixed(2)}: ${(e as Error).message.slice(0, 200)}`);
    break;
  }
  sim.state.pendingEvents = [];
  if (sim.state.time < nextPrint - 1e-9) continue;
  nextPrint += 2;
  const node = sim.state.flowNodes.get(TUBE)!;
  let ev, flows;
  try {
    const r = evaluateOtsgSections(sim.state, TUBE, node, { exact: true });
    ev = r.ev; flows = r.flows;
  } catch (e) {
    console.log(`  ${sim.state.time.toFixed(0).padStart(5)}  partition refused: ${(e as Error).message.slice(0, 160)}`);
    continue;
  }
  const water = tubeWaterState(node);
  const m1 = ev.sections[0].mass, m2 = ev.sections[1].mass, m3 = ev.sections[2].mass;
  const mR = node.fluid.mass - m1;
  const u1 = ev.sections[0].hBar - ev.P * ev.sections[0].vBar;
  const UR = water.energy - m1 * u1;
  const t = ev.tangent;
  console.log(
    `  ${sim.state.time.toFixed(0).padStart(5)} ` +
    `${(ev.P / 1e5).toFixed(1).padStart(8)} ` +
    `${(water.pressure / 1e5).toFixed(1).padStart(6)} ` +
    `${ev.regime.padEnd(13)} ` +
    `${node.fluid.mass.toFixed(0).padStart(5)} ` +
    `${m1.toFixed(0).padStart(5)} ` +
    `${mR.toFixed(1).padStart(6)} ` +
    `${m2.toFixed(1).padStart(6)} ` +
    `${m3.toFixed(1).padStart(6)} ` +
    `${(UR / 1e6).toFixed(1).padStart(7)} ` +
    `${(water.energy / 1e6).toFixed(0).padStart(6)} ` +
    `${(100 * UR / water.energy).toFixed(2).padStart(6)}% ` +
    `${t ? (t.dPdm / 1e5).toExponential(2).padStart(13) : '-'.padStart(13)} ` +
    `${t ? (1e6 * t.dPdU / 1e5).toExponential(2).padStart(14) : '-'.padStart(14)} ` +
    `${t ? (t.dPdm1 / 1e5).toExponential(2).padStart(15) : '-'.padStart(15)} ` +
    `${flows.WFeed.toFixed(1).padStart(6)} ` +
    `${flows.WSteamOut.toFixed(1).padStart(6)}`);
}

// --- branch sweep -----------------------------------------------------------
// SWEEP=1: at the end of the run, hold the node's totals fixed and walk the
// economizer ledger m1 across the flooded/superheat boundary, printing the
// pressure the volume closure returns. A continuous closure gives a smooth
// curve; a jump here is the step-to-step limit cycle the rejection log shows.
if (process.env.SWEEP === '1') {
  const { evaluateOtsgPartition } = await import('../src/simulation/otsg');
  const { otsgWallPin, classifyOtsgFlows } = await import('../src/simulation/operators/otsg-operator');
  const node = sim.state.flowNodes.get(TUBE)!;
  const water = tubeWaterState(node);
  const cfg: any = node.otsg;
  const flows = classifyOtsgFlows(sim.state, TUBE, node, node.fluid.pressure);
  const pin = otsgWallPin(sim.state, node, flows);
  const geom = { tubeVolume: node.volume, tubeLength: 1, heatArea: cfg.heatArea };
  console.log(`\nledger sweep at t=${sim.state.time.toFixed(1)}: mass=${node.fluid.mass.toFixed(1)} kg, ` +
    `U=${(water.energy / 1e6).toFixed(1)} MJ, V=${node.volume.toFixed(3)} m3, ledger m1=${cfg.m1.toFixed(1)} kg`);
  console.log('    m1(kg)   P(bar)   regime        m2      m3     UR(MJ)');
  const m1c = cfg.m1;
  for (let f = -0.06; f <= 0.0601; f += 0.004) {
    const m1 = m1c * (1 + f);
    try {
      const ev = evaluateOtsgPartition(node.fluid.mass, water.energy, m1, flows.uFeed,
        geom, pin, node.fluid.pressure, cfg.uFRef);
      const u1 = ev.sections[0].hBar - ev.P * ev.sections[0].vBar;
      console.log(`  ${m1.toFixed(1).padStart(8)} ${(ev.P / 1e5).toFixed(2).padStart(8)}   ` +
        `${ev.regime.padEnd(13)} ${ev.sections[1].mass.toFixed(1).padStart(6)} ` +
        `${ev.sections[2].mass.toFixed(2).padStart(7)} ` +
        `${((water.energy - ev.sections[0].mass * u1) / 1e6).toFixed(1).padStart(8)}`);
    } catch (e) {
      console.log(`  ${m1.toFixed(1).padStart(8)}   REFUSED  ${(e as Error).message.slice(0, 110)}`);
    }
  }
}
