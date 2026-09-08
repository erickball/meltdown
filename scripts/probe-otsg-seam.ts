/**
 * Sweep ONE input across an OTSG regime seam at a captured plant state and
 * print what the closure returns, column by column.
 *
 * The closure branches on the sign of a solved mass (m3 < 0 flooded, m2 < 0
 * all-superheated) and claims the arms coincide where they meet. This runs
 * the plant to a chosen instant, freezes the node's totals, the ledger, the
 * wall pin and the warm start, and walks one of them - the energy total, the
 * mass, the economizer ledger, or the classified feed enthalpy - across the
 * seam. A continuous closure gives smooth columns; anything that steps names
 * itself. Pair it with probe-otsg-step.ts, which says which input actually
 * moved in the plant.
 *
 * Usage: npx tsx scripts/probe-otsg-seam.ts [t of capture] [trip s]
 * Env:   TUBE=hx-1-tube  TRIP=sbo|circulator|none  VAR=U|m|m1|uf
 *        SPAN=0.02 (fractional half-width)  N=60
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { applyScenarioAction } from '../src/simulation/scenario';
import type { ScenarioAction } from '../src/simulation/scenario-types';
import { evaluateOtsgPartition } from '../src/simulation/otsg';
import { otsgWallPin, classifyOtsgFlows, tubeWaterState } from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const warm = parseFloat(process.argv[2] || '100.9');
const tripTime = parseFloat(process.argv[3] || '20');
const TUBE = process.env.TUBE || 'hx-1-tube';
const VAR = process.env.VAR || 'U';       // U | m | m1
const SPAN = parseFloat(process.env.SPAN || '0.02');
const N = parseInt(process.env.N || '60', 10);
const TRIP = (process.env.TRIP || 'sbo').toLowerCase();
const preset = path.join(HERE, '..', 'src', 'presets', 'xe100.json');

const ACT: Record<string, ScenarioAction[]> = {
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
  circulator: [{ kind: 'pump', id: 'pump-1', running: false, speed: 0 }],
  none: [],
};
const sim = buildSimFromFile(preset);
let tripped = false;
for (let i = 0; i < Math.round(warm / 0.1); i++) {
  if (!tripped && sim.state.time >= tripTime) { for (const a of ACT[TRIP]) applyScenarioAction(sim.state, a); tripped = true; }
  sim.state = sim.solver.advance(sim.state, 0.1).state;
  sim.state.pendingEvents = [];
}
const node = sim.state.flowNodes.get(TUBE)!;
const cfg: any = node.otsg;
const water = tubeWaterState(node);
const flows = classifyOtsgFlows(sim.state, TUBE, node, node.fluid.pressure);
const pin = otsgWallPin(sim.state, node, flows);
const geom = { tubeVolume: node.volume, tubeLength: 1, heatArea: cfg.heatArea };
const PStart = node.fluid.pressure - water.gasPressure;
console.log(`\n${TUBE} at t=${sim.state.time.toFixed(2)}: mass=${node.fluid.mass.toFixed(3)} U=${(water.energy / 1e6).toFixed(3)} MJ ` +
  `V=${geom.tubeVolume.toFixed(4)} m1L=${cfg.m1.toFixed(3)} uFRef=${(cfg.uFRef / 1e3).toFixed(1)} uFeed=${(flows.uFeed / 1e3).toFixed(1)} ` +
  `PStart=${(PStart / 1e5).toFixed(2)} TWall3=${(pin.TWall3 - 273.15).toFixed(0)}C WCp3=${(pin.WCp3 / 1e3).toFixed(2)}kW/K`);
console.log(`sweep ${VAR} +/-${(100 * SPAN).toFixed(2)}%`);
console.log('       var      P(bar)  regime          m1      m2      m3    x2bar  v2(L/kg)  u3(MJ/kg)  du3(kJ/kg)  T3(C)  hOut(MJ/kg)');
let prev: any = null;
for (let i = 0; i <= N; i++) {
  const f = -SPAN + (2 * SPAN * i) / N;
  const m = VAR === 'm' ? node.fluid.mass * (1 + f) : node.fluid.mass;
  const U = VAR === 'U' ? water.energy * (1 + f) : water.energy;
  const m1 = VAR === 'm1' ? cfg.m1 * (1 + f) : cfg.m1;
  const uf = VAR === 'uf' ? flows.uFeed * (1 + f) : flows.uFeed;
  const varVal = VAR === 'U' ? U / 1e6 : VAR === 'm' ? m : VAR === 'uf' ? uf / 1e3 : m1;
  try {
    const ev = evaluateOtsgPartition(m, U,
      { m1, U1: cfg.m1 > 0 ? cfg.U1 * (m1 / cfg.m1) : 0, uFRef: cfg.uFRef },
      geom, pin, PStart);
    const sat = ev.sat;
    const u2 = ev.sections[1].hBar - ev.P * ev.sections[1].vBar;
    const x2 = (u2 - sat.u_f) / (sat.u_g - sat.u_f);
    const jump = prev ? Math.abs(ev.P - prev.P) / 1e5 : 0;
    console.log(
      `  ${varVal.toFixed(4).padStart(10)} ${(ev.P / 1e5).toFixed(3).padStart(9)} ${ev.regime.padEnd(13)} ` +
      `${ev.sections[0].mass.toFixed(2).padStart(7)} ${ev.sections[1].mass.toFixed(3).padStart(7)} ` +
      `${ev.sections[2].mass.toFixed(3).padStart(7)} ${x2.toFixed(4).padStart(8)} ` +
      `${(1e3 * ev.sections[1].vBar).toFixed(3).padStart(8)} ${(ev.u3 / 1e6).toFixed(4).padStart(9)} ` +
      `${((ev.u3 - sat.u_g) / 1e3).toFixed(1).padStart(10)} ${(ev.sections[2].T - 273.15).toFixed(0).padStart(6)} ` +
      `${(ev.hSteamOut / 1e6).toFixed(4).padStart(10)}` +
      `${jump > 0.5 ? `   << JUMP ${jump.toFixed(2)} bar` : ''}`);
    prev = ev;
  } catch (e) {
    console.log(`  ${varVal.toFixed(4).padStart(10)}   REFUSED ${(e as Error).message.slice(0, 100)}`);
  }
}
