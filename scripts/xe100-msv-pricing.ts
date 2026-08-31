/**
 * What price does each direction of the MSSV tap actually get?
 *
 * The valve heats past the primary while breathing in and out of a
 * dead-ended body. For that to happen, one direction has to be mis-priced:
 * a cycle that brings in h_source and takes out h_node is self-limiting once
 * h_node exceeds h_source, so the ratchet needs inflow credited above the
 * source's true enthalpy or outflow debited below the node's.
 *
 * This calls the operator's OWN getSpecificEnthalpy for both nodes each
 * sample - the same function the transport uses - and prints it against the
 * enthalpy the water tables give for those states. Where those two disagree
 * is the leak.
 *
 * Usage: npx tsx scripts/xe100-msv-pricing.ts [seconds]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import { FlowRateOperator } from '../src/simulation/operators/rate-operators';
import { calculateState } from '../src/simulation/water-properties';
import { evaluateOtsgSections } from '../src/simulation/operators/otsg-operator';
import { stateAtPh } from '../src/simulation/turbine-expansion';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const seconds = parseFloat(process.argv[2] ?? '400');

const sim = buildSimFromFile(PRESET);
const st = () => sim.state;
const op: any = new FlowRateOperator();

/** The operator's own price for a vapor draw out of this node (kJ/kg). */
const priced = (id: string) => {
  const n = st().flowNodes.get(id);
  if (!n) return NaN;
  return op.getSpecificEnthalpy(n, 'vapor') / 1e3;
};

/** What the water tables say the node's state is really worth (kJ/kg). */
function trueEnthalpy(id: string): { u: number; h: number; T: number; P: number } {
  const n = st().flowNodes.get(id);
  if (!n || !(n.fluid.mass > 0)) return { u: NaN, h: NaN, T: NaN, P: NaN };
  const u = (n.fluid as any).internalEnergy / n.fluid.mass;
  const v = n.volume / n.fluid.mass;
  try {
    const s = calculateState(n.fluid.mass, (n.fluid as any).internalEnergy, n.volume);
    return { u: u / 1e3, h: (u + s.pressure * v) / 1e3, T: s.temperature - 273.15,
      P: s.pressure / 1e5 };
  } catch {
    return { u: u / 1e3, h: NaN, T: NaN, P: NaN };
  }
}

console.log('\n=== Is the offered steam bounded by the gas heating it? ===');
console.log('  T_out = T(hSteamOut, P): what the extrapolated outlet enthalpy is');
console.log('  actually worth as a temperature. It may not exceed the helium INLET');
console.log('  (cv-1-inner) - the hottest gas the hot end of a counterflow bundle sees.');
console.log('  T_eq = T(hSteamOut, P_msv): where a correctly-priced dead-ended breather');
console.log('  equilibrates. If the valve tracks it, the valve is innocent.');
console.log('   t(s)  m2(kg)  m3(kg)  T3mean   h_out   T_out   T_He_in   ' +
  'msv_T    T_eq   msv-T_eq');

function line() {
  const node = st().flowNodes.get('hx-1-tube');
  if (!node?.otsg) { console.log('  (no otsg)'); return; }
  let ev: any;
  try { ev = evaluateOtsgSections(st(), 'hx-1-tube', node).ev; } catch { return; }
  const s3 = ev.sections[2];
  const T3 = s3.T - 273.15;
  const heIn = (st().flowNodes.get('cv-1-inner')?.fluid.temperature ?? NaN) - 273.15;
  const msv = st().flowNodes.get('val-msv-1');
  const msvT = (msv?.fluid.temperature ?? NaN) - 273.15;
  let tOut = NaN, tEq = NaN;
  try { tOut = stateAtPh(ev.P, ev.hSteamOut).T - 273.15; } catch { /* off-grid */ }
  try {
    if (msv) tEq = stateAtPh(msv.fluid.pressure, ev.hSteamOut).T - 273.15;
  } catch { /* off-grid */ }
  console.log(
    `${st().time.toFixed(0).padStart(7)} ` +
    `${ev.sections[1].mass.toFixed(1).padStart(7)} ` +
    `${s3.mass.toFixed(1).padStart(7)} ` +
    `${T3.toFixed(0).padStart(7)} ` +
    `${(ev.hSteamOut / 1e3).toFixed(0).padStart(7)} ` +
    `${tOut.toFixed(0).padStart(7)} ` +
    `${heIn.toFixed(0).padStart(9)} ` +
    `${msvT.toFixed(0).padStart(7)} ` +
    `${tEq.toFixed(0).padStart(7)} ` +
    `${(msvT - tEq).toFixed(0).padStart(9)}`);
}

line();
const every = Math.max(1, Math.round(seconds / 25));
for (let t = 0; t < seconds; t++) {
  try {
    run(sim, 1, 0.05);
  } catch (e: any) {
    console.log(`\n!!! THREW at t=${st().time.toFixed(1)}: ${e.message.split('\n')[0]}`);
    break;
  }
  if (t % every === 0) line();
}
line();
