/**
 * Xe-100 steam generator sizing sweep.
 *
 * The helium-side coefficient is the limiting resistance in this exchanger,
 * so UA scales roughly as
 *
 *     UA ~ A * h ~ (W^2 H / d) * (mdot / (rho W^2))^0.8  ~  W^0.4 * H / d
 *
 * - height and tube diameter are the real levers, and WIDTH almost is not:
 * widening buys area and gives most of it straight back as lost velocity.
 * This sweeps the two that work and prints where the plant settles, because
 * the lumped shell sits at its OUTLET temperature and an analytic UA target
 * off an LMTD would be answering a different question.
 *
 * READ THIS BEFORE TRUSTING A ROW. The Xe-100 secondary does not settle: it
 * holds near 130-160 MW for ~900 s and then falls off a cliff to ~2.9 kg/s of
 * steam at 86 bar, and stays there. So a single reading is a sample of
 * WHENEVER that case happened to collapse, not of its equilibrium, and two
 * rows are only comparable if neither has gone over yet. Measured on the
 * baseline geometry:
 *
 *     t(s)     1    201    601    881    921    961   1200
 *     stm   26.8   19.1   15.0   16.9    4.5    2.9    2.8
 *     bar  168.2  155.9  164.0  166.1  114.0   88.1   86.2
 *
 * At 300 s bigger was monotonically better (119.6 -> 136.1 MW across a 2x
 * area change, core inlet 425.7 -> 416.1 C). At 800 s the same ranking had
 * inverted, because the thinner-tube cases had collapsed and the baseline had
 * not. Sizing is worth ~14% for 2x the area; the cliff is worth ~80%. Fix the
 * cliff first, and only then size anything against it.
 *
 * Runs ARE bit-reproducible within a checkout - the same 200 s probe gives
 * 8841 steps / 836 rejected twice over, foreground or backgrounded - so the
 * spread above is the plant, not the harness.
 *
 * Usage: npx tsx scripts/xe100-sg-sweep.ts [seconds]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';
import { buildSim, run } from './lib/sim-harness';
import type { SimulationState } from '../src/simulation/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const seconds = parseFloat(process.argv[2] ?? '300');

// height (m), tubeOD (m). Baseline first.
const CASES: Array<[number, number]> = [
  [14, 0.019],
  [14, 0.014],
  [18, 0.014],
];

const raw = fs.readFileSync(PRESET, 'utf-8');

console.log(`\n=== Xe-100 SG sizing sweep, ${seconds} s each ===`);
console.log('  H(m)  tubeOD  |  Pwr(MW)  Tcore_in  stm(kg/s)  P_stm(bar)  T_stm(C)  ' +
  'm_tube(kg)  L1/L2/L3      dt(ms)  rej');
console.log('  ' + '-'.repeat(112));

for (const [H, tubeOD] of CASES) {
  const data = JSON.parse(raw);
  for (const entry of data.components) {
    const c = Array.isArray(entry) ? entry[1] : entry;
    if (c.id === 'hx-1') { c.height = H; c.tubeOD = tubeOD; }
    // Keep the bundle inside its vessel with the same 1 m clearances, and
    // carry the dome (and the circulator standing on it) up with the top.
    if (c.id === 'tank-sg-1') c.height = H + 2;
    if (c.id === 'pump-1') c.elevation = -10 + (H + 2) + 0.3;
  }
  for (const conn of data.connections) {
    if (conn.fromComponentId === 'tank-sg-1' && conn.toComponentId === 'pump-1') {
      conn.fromElevation = H + 2;
    }
  }

  let line = `  ${H.toString().padStart(4)}  ${(tubeOD * 1000).toFixed(0).padStart(6)}  |`;
  try {
    const sim = buildSim(data.components, data.connections ?? []);
    run(sim, seconds, 0.05);
    const s: SimulationState = sim.state;
    const T = (id: string) => (s.flowNodes.get(id)?.fluid.temperature ?? NaN) - 273.15;
    const P = (id: string) => (s.flowNodes.get(id)?.fluid.pressure ?? NaN) / 1e5;
    const flow = (id: string) =>
      s.flowConnections.find(c => c.id === id)?.massFlowRate ?? 0;
    const steam = flow('flow-hx-1-turbine-1') +
      flow('flow-hx-1-turbine-1-hx-1-tube-2-b2-inlet');
    const tube = s.flowNodes.get('hx-1-tube');
    line +=
      `${(s.neutronics.power / 1e6).toFixed(1).padStart(9)} ` +
      `${T('rv-1').toFixed(1).padStart(9)} ` +
      `${steam.toFixed(1).padStart(10)} ` +
      `${P('hx-1-tube').toFixed(1).padStart(11)} ` +
      `${T('hx-1-tube').toFixed(0).padStart(9)} ` +
      `${(tube?.fluid.mass ?? NaN).toFixed(0).padStart(11)}`;
  } catch (e: any) {
    line += `  THREW: ${e.message.split('\n')[0].slice(0, 60)}`;
  }
  console.log(line);
}

console.log('\n  design point for reference: 200 MW, core in 260 C, ~77 kg/s at 165 bar, 565 C');
