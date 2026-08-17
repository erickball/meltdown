/**
 * Why does the Xe-100 feed train surge?
 *
 * The feed swings between 0 and 150 kg/s with the pump at a fixed speed, so
 * before designing a controller it is worth knowing what actually stops the
 * flow. The candidates each leave a different fingerprint here:
 *
 *   - the check valve shutting because the SG has out-pressured the pump
 *     -> dP = P_pump_out - P_SG goes negative right as the flow dies
 *   - feedwater flashing in the heater or the line
 *     -> the heater's tube node leaves the liquid phase
 *   - the pump itself running out of curve
 *     -> flow dies with dP still positive and the pump at full speed
 *
 * Run: npx tsx scripts/probe-feedtrain.ts [seconds]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import type { SimulationState } from '../src/simulation/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const seconds = parseFloat(process.argv[2] || '120');
const sim = buildSimFromFile(path.join(HERE, '..', 'src', 'presets', 'xe100.json'));

const bar = (Pa: number) => (Pa / 1e5);
const C = (K: number) => K - 273.15;
function conn(state: SimulationState, id: string) {
  return state.flowConnections.find(c => c.id === id);
}
function node(state: SimulationState, id: string) {
  return state.flowNodes.get(id);
}

function line(state: SimulationState) {
  const feed = conn(state, 'flow-fw-pump-1-fwh-1');
  // Both bundles hang off the same header - sum them, and report the SPLIT,
  // because two parallel boiling channels swapping flow is its own failure.
  const toSgA = conn(state, 'flow-val-fwcv-1-hx-1');
  const toSgB = conn(state, 'flow-val-fwcv-1-hx-1-val-fwcv-1-out-hx-1-tube-1-b2');
  const toSg = { massFlowRate: (toSgA?.massFlowRate ?? 0) + (toSgB?.massFlowRate ?? 0) };
  const split = (toSgA?.massFlowRate ?? 0) - (toSgB?.massFlowRate ?? 0);
  const bleed = conn(state, 'flow-val-bleed-1-fwh-1');
  const steam = conn(state, 'flow-hx-1-turbine-1');
  const pumpOut = node(state, 'fw-pump-1');
  const fwhTube = node(state, 'fwh-1-tube');
  const fwhShell = node(state, 'fwh-1-shell');
  const sg = node(state, 'hx-1-tube');
  const pump = state.components.pumps.get('fw-pump-1');
  const cv = state.components.valves.get('val-fwcv-1');
  const bv = state.components.valves.get('val-bleed-1');
  const dv = state.components.valves.get('val-fwhdr-1');
  const drain = conn(state, 'flow-fwh-1-val-fwhdr-1');
  const sgPhase = state.flowNodes.get('hx-1-tube')?.fluid.phase ?? '?';
  if (!pumpOut || !fwhTube || !fwhShell || !sg) return;

  console.log(
    `${state.time.toFixed(0).padStart(5)} ` +
    `${(feed?.massFlowRate ?? NaN).toFixed(1).padStart(7)} ` +
    `${(toSg?.massFlowRate ?? NaN).toFixed(1).padStart(7)} ` +
    `${(steam?.massFlowRate ?? NaN).toFixed(1).padStart(7)} ` +
    `${split.toFixed(1).padStart(7)} ` +
    `${(bleed?.massFlowRate ?? NaN).toFixed(2).padStart(6)} | ` +
    `${bar(pumpOut.fluid.pressure).toFixed(1).padStart(7)} ` +
    `${bar(sg.fluid.pressure).toFixed(1).padStart(7)} ` +
    `${(bar(pumpOut.fluid.pressure) - bar(sg.fluid.pressure)).toFixed(1).padStart(7)} | ` +
    `${bar(fwhTube.fluid.pressure).toFixed(1).padStart(7)} ` +
    `${C(fwhTube.fluid.temperature).toFixed(0).padStart(6)} ` +
    `${fwhTube.fluid.phase.padStart(10)} ` +
    `${fwhTube.fluid.mass.toFixed(0).padStart(6)} | ` +
    `${bar(fwhShell.fluid.pressure).toFixed(1).padStart(7)} ` +
    `${C(fwhShell.fluid.temperature).toFixed(0).padStart(6)} ` +
    `${fwhShell.fluid.mass.toFixed(0).padStart(6)} | ` +
    `${(pump?.speed ?? NaN).toFixed(2).padStart(5)} ` +
    `${(bv?.position ?? NaN).toFixed(2).padStart(5)} | ` +
    // What the shell is actually being handed, and what it is losing: the
    // bleed's DONOR state (a flooded SG hands its 'steam' port water), the
    // drain, and the shell's own quality.
    `${sgPhase.padStart(10)} ` +
    `${(drain?.massFlowRate ?? NaN).toFixed(1).padStart(6)} ` +
    `${(fwhShell.fluid.quality ?? NaN).toFixed(3).padStart(6)} ` +
    `${(dv?.position ?? NaN).toFixed(2).padStart(5)}`
  );
}

console.log('\nXe-100 feed train. dP is pump discharge minus SG tube pressure: the check');
console.log('valve shuts when it goes negative. "fwh tube" is the feedwater inside the');
console.log('heater - it leaving the liquid phase means the feed line is flashing.\n');
console.log(
  '    t  W_pump  W_toSG  W_stm  split  bleed |  P_pump    P_SG      dP |  P_fwh  T_fwh      phase   m_fwh |' +
  ' P_shl  T_shl  m_shl | speed bleed |  SG phase  drain     x_s drainV');
line(sim.state);
for (let t = 0; t < seconds; t++) {
  try {
    run(sim, 1, 0.05);
  } catch (e: any) {
    console.log(`\n!!! THREW at t=${sim.state.time.toFixed(2)}s: ${e.message}`);
    break;
  }
  if (t % Math.max(1, Math.round(seconds / 30)) === 0) line(sim.state);
}
line(sim.state);
console.log('');
