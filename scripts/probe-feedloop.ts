/**
 * Three-element feedwater loop probe.
 *
 * Watches ctl-fw-1's own state (lastError, lastOutput) against an independent
 * evaluation of its pv and setpoint pieces, plus the pump's commanded target
 * and actual speed - to see where the loop's action leaves its error.
 *
 * Usage: npx tsx scripts/probe-feedloop.ts [seconds]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import type { SimulationState } from '../src/simulation/types';
import { nodeLiquidLevel } from '../src/simulation/operators/control-system';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const seconds = parseFloat(process.argv[2] || '200');

const sim = buildSimFromFile(PRESET);

function flow(state: SimulationState, connId: string): number {
  const c = state.flowConnections.find(x => x.id === connId);
  return c ? c.massFlowRate : NaN;
}

console.log('   t(s)     pv=WF   WS_main     WS_b2   lvl(m)    trim      SP     err   ctl.lastErr  out   spdTgt  spdEff');
for (let t = 0; t < seconds; t += 1) {
  try {
    run(sim, 1, 0.05);
  } catch (e: any) {
    console.log(`\n!!! THREW at t=${sim.state.time.toFixed(2)}s: ${e.message}`);
    break;
  }
  const s = sim.state;
  const ctl = s.components.controllers.get('ctl-fw-1');
  const pump = s.components.pumps.get('fw-pump-1');
  const pv = flow(s, 'flow-fw-pump-1-fwh-1');
  const wsMain = flow(s, 'flow-hx-1-turbine-1');
  const wsB2 = flow(s, 'flow-hx-1-turbine-1-hx-1-tube-2-b2-inlet');
  const node = s.flowNodes.get('hx-1-tube')!;
  const lvl = nodeLiquidLevel(node);
  const trim = 4.0 - 1.0 * lvl;
  const sp = wsMain + wsB2 + trim;
  console.log(
    `${s.time.toFixed(1).padStart(7)} ` +
    `${pv.toFixed(2).padStart(9)} ${wsMain.toFixed(2).padStart(9)} ${wsB2.toFixed(2).padStart(9)} ` +
    `${lvl.toFixed(2).padStart(7)} ${trim.toFixed(2).padStart(7)} ${sp.toFixed(2).padStart(7)} ` +
    `${(sp - pv).toFixed(2).padStart(7)} ` +
    `${(ctl?.lastError ?? NaN).toFixed(2).padStart(9)} ` +
    `${(ctl?.lastOutput ?? NaN).toFixed(3).padStart(7)} ` +
    `${(pump?.speed ?? NaN).toFixed(3).padStart(7)} ` +
    `${(pump?.effectiveSpeed ?? NaN).toFixed(3).padStart(7)}`
  );
}
