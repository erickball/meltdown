/** Dump the OTSG volume residual R(P) = sum(m_i v_i) - V at a captured plant
 *  state, with the partition's internals, at several pin offsets du3. A
 *  monotone R has one root; a fold means the published pressure is
 *  multi-valued. */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { applyScenarioAction } from '../src/simulation/scenario';
import type { ScenarioAction } from '../src/simulation/scenario-types';
import { otsgPartitionAtP } from '../src/simulation/otsg';
import { otsgWallPin, classifyOtsgFlows, tubeWaterState } from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const seconds = parseFloat(process.argv[2] || '31.2');
const tripTime = parseFloat(process.argv[3] || '20');
const TUBE = process.env.TUBE || 'hx-1-tube';
const preset = path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const PLO = parseFloat(process.env.PLO || '100');
const PHI = parseFloat(process.env.PHI || '210');
const NP = parseInt(process.env.NP || '55', 10);
const DU3S = (process.env.DU3 || '0').split(',').map(Number);

const actions: ScenarioAction[] = [
  { kind: 'pump', id: 'pump-1', running: false, speed: 0 },
  { kind: 'pump', id: 'fw-pump-1', running: false, speed: 0 },
  { kind: 'pump', id: 'cond-pump-1', running: false, speed: 0 },
  { kind: 'controller', id: 'ctl-fw-1', mode: 'manual', manualOutput: 0 },
  { kind: 'controller', id: 'ctl-msp-1', mode: 'manual', manualOutput: 0.02 },
  { kind: 'turbine-governor', id: 'turbine-1', value: 0.02 },
  { kind: 'valve', id: 'val-bleed-1', position: 0 },
  { kind: 'controller', id: 'ctl-fwh-1', mode: 'manual', manualOutput: 0 },
];
const sim = buildSimFromFile(preset);
let tripped = false;
for (let i = 0; i < Math.round(seconds / 0.1); i++) {
  if (!tripped && sim.state.time >= tripTime) { for (const a of actions) applyScenarioAction(sim.state, a); tripped = true; }
  sim.state = sim.solver.advance(sim.state, 0.1).state;
  sim.state.pendingEvents = [];
}
const node = sim.state.flowNodes.get(TUBE)!;
const cfg: any = node.otsg;
const water = tubeWaterState(node);
const flows = classifyOtsgFlows(sim.state, TUBE, node, node.fluid.pressure);
const pin = otsgWallPin(sim.state, node, flows);
const V = node.volume;
console.log(`${TUBE} at t=${sim.state.time.toFixed(1)}: mass=${node.fluid.mass.toFixed(2)} U=${(water.energy / 1e6).toFixed(2)} MJ ` +
  `V=${V.toFixed(4)} m3 m1L=${cfg.m1.toFixed(2)} uFRef=${(cfg.uFRef / 1e3).toFixed(1)} uFeed=${(flows.uFeed / 1e3).toFixed(1)} ` +
  `published P=${(node.fluid.pressure / 1e5).toFixed(2)} TWall3=${(pin.TWall3 - 273.15).toFixed(0)}C WCp3=${(pin.WCp3 / 1e3).toFixed(2)}kW/K`);

for (const du3 of DU3S) {
  console.log(`\ndu3=${(du3 / 1e3).toFixed(0)} kJ/kg`);
  console.log('   P(bar)   uf(kJ/kg)     m1      mR    UR(MJ)  uR(kJ/kg)     m2      m3   regime       R=Vsum-V(m3)');
  for (let i = 0; i <= NP; i++) {
    const P = (PLO + ((PHI - PLO) * i) / NP) * 1e5;
    try {
      const r = otsgPartitionAtP(P, {
        massTotal: node.fluid.mass, UTotal: water.energy,
        slug: { m1: cfg.m1, U1: cfg.U1, uFRef: cfg.uFRef }, du3,
      });
      const mR = node.fluid.mass - r.m1;
      const UR = water.energy - r.m1 * r.u1;
      console.log(`  ${(P / 1e5).toFixed(2).padStart(7)} ${(r.sat.u_f / 1e3).toFixed(1).padStart(9)} ` +
        `${r.m1.toFixed(2).padStart(8)} ${mR.toFixed(2).padStart(7)} ${(UR / 1e6).toFixed(2).padStart(8)} ` +
        `${(UR / mR / 1e3).toFixed(1).padStart(9)} ${r.m2.toFixed(2).padStart(8)} ${r.m3.toFixed(2).padStart(7)} ` +
        `${r.regime.padEnd(13)} ${(r.Vsum - V).toExponential(3).padStart(11)}`);
    } catch (e) {
      console.log(`  ${(P / 1e5).toFixed(2).padStart(7)}  THREW ${(e as Error).message.slice(0, 90)}`);
    }
  }
}
