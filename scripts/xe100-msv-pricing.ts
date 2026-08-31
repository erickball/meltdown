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

console.log('\n=== MSSV tap pricing: what the transport charges vs what the state is worth ===');
console.log('   t(s)   msv_T(C)  |  msv: priced   true_h    delta  |  ' +
  'tube: priced   true_h    delta  |  net per cycle');

function line() {
  const node = st().flowNodes.get('hx-1-tube');
  if (!node?.otsg) { console.log('  (no otsg)'); return; }
  let ev: any;
  try { ev = evaluateOtsgSections(st(), 'hx-1-tube', node).ev; } catch { return; }
  const s3 = ev.sections[2];
  const u3 = ev.u3, v3 = s3.vBar;
  // What the code charges: u3 + P_bulk * v3.
  const hCharged = (u3 + ev.P * v3) / 1e3;
  // What that state is actually worth: its OWN pressure from the tables.
  let pImplied = NaN, hTrue = NaN, tState = NaN;
  try {
    const stt = calculateState(1, u3, v3);
    pImplied = stt.pressure;
    tState = stt.temperature - 273.15;
    hTrue = (u3 + pImplied * v3) / 1e3;
  } catch { /* off-grid */ }
  const cached = (node.otsg as any).lastEval?.hSteamOut;
  const msv = st().flowNodes.get('val-msv-1');
  const msvU = msv && msv.fluid.mass > 0
    ? (msv.fluid as any).internalEnergy / msv.fluid.mass : NaN;
  console.log(
    `${st().time.toFixed(0).padStart(7)} ${s3.mass.toFixed(1).padStart(8)} ` +
    `${tState.toFixed(0).padStart(7)} ` +
    `${(ev.hSteamOut / 1e3).toFixed(0).padStart(9)} ` +
    `${(cached === undefined ? NaN : cached / 1e3).toFixed(0).padStart(10)} ` +
    `${(cached === undefined ? NaN : (cached - ev.hSteamOut) / 1e3).toFixed(0).padStart(8)}   ` +
    `${((msv?.fluid.temperature ?? NaN) - 273.15).toFixed(0).padStart(8)} ` +
    `${(msvU / 1e3).toFixed(0).padStart(7)}`);
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
