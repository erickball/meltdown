/**
 * Xe-100 accident scenarios: loss of primary flow and SG tube rupture.
 *
 *   npx tsx scripts/xe100-scenarios.ts lofc [seconds]   - circulator trip
 *   npx tsx scripts/xe100-scenarios.ts sgtr [seconds]   - tube rupture into primary
 *
 * Both start from the preset, settle to steady state, then inject the fault.
 *
 * LOFC (loss of forced cooling): trip the helium circulator, no scram. The
 * expected story is the pebble-bed safety case itself: negative temperature
 * feedback shuts the fission power down without rods, decay heat soaks into
 * 100+ tonnes of graphite, and the reflector conducts/radiates it to the
 * vessel wall. Peak fuel must stay under the ~1900-2100 K TRISO failure
 * band with everything switched off. Watch for recriticality as xenon-free
 * graphite cools back through the power coefficient hours later - a real
 * HTGR phenomenon (we run minutes here, so what shows is the shutdown and
 * the slow heatup toward conduction equilibrium).
 *
 * SGTR: open the tube-leak valve. 165-bar steam pushes into the 60-70 bar
 * helium shell, pressurizing the primary and carrying steam to the hot
 * graphite - where the new oxidation chain gasifies it: C + H2O -> CO + H2,
 * ENDOthermic, so it cannot run away, but it loads the primary with
 * flammable gas. Also watch water-ingress reactivity (our lattice reads
 * slightly negative for it) and the relief path.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import type { SimulationState } from '../src/simulation/types';
import { getGraphiteOxidationDiagnostics } from '../src/simulation/operators/graphite-oxidation';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET = path.join(HERE, '..', 'src', 'presets', 'xe100.json');

const scenario = (process.argv[2] ?? 'lofc') as 'lofc' | 'sgtr';
const seconds = parseFloat(process.argv[3] ?? '1800');
const SETTLE = 400; // s to steady state before the fault

const sim = buildSimFromFile(PRESET);

let minDt = Infinity;
function advance(secs: number, dt = 0.05) {
  const ticks = Math.round(secs / dt);
  for (let i = 0; i < ticks; i++) {
    const r = sim.solver.advance(sim.state, dt);
    sim.state = r.state;
    sim.state.pendingEvents = [];
    const used = r.metrics?.minDtUsed;
    if (Number.isFinite(used)) minDt = Math.min(minDt, used);
  }
}

const st = () => sim.state;
const fT = (id: string) => (st().flowNodes.get(id)?.fluid.temperature ?? NaN) - 273.15;
const fP = (id: string) => (st().flowNodes.get(id)?.fluid.pressure ?? NaN) / 1e5;
const tT = (id: string) => (st().thermalNodes.get(id)?.temperature ?? NaN) - 273.15;
const ncg = (id: string, sp: string) => (st().flowNodes.get(id)?.fluid.ncg as any)?.[sp] ?? 0;
const heFlow = () => {
  const c = st().flowConnections.find(x => x.id === 'flow-pipe-pumpdisch-rv-1');
  return c ? c.massFlowRate : NaN;
};

function header() {
  console.log(
    '    t(s)  He(kg/s)  Pwr(MW)  T_fuel(C)  T_peb(C)  T_refl(C)  T_wall(C)  ' +
    'P_he(bar)  H2O_cb(kg)   H2(mol)   CO(mol)  gasif(g/s)');
  console.log('  ' + '-'.repeat(124));
}

function line() {
  const wall = st().thermalNodes.get('rv-1-wall');
  const cb = st().flowNodes.get('cb-1')!;
  const d = getGraphiteOxidationDiagnostics().get('cb-1-clad');
  const gasif = d ? (d.carbonRate.H2O + d.carbonRate.CO2 + d.carbonRate.O2) * 1000 : 0;
  console.log(
    `  ${st().time.toFixed(0).padStart(6)}  ` +
    `${heFlow().toFixed(1).padStart(8)}  ` +
    `${(st().neutronics.power / 1e6).toFixed(1).padStart(7)}  ` +
    `${tT('cb-1-fuel').toFixed(0).padStart(9)}  ` +
    `${tT('cb-1-clad').toFixed(0).padStart(8)}  ` +
    `${tT('cb-1-reflector').toFixed(0).padStart(9)}  ` +
    `${(wall ? wall.temperature - 273.15 : NaN).toFixed(0).padStart(9)}  ` +
    `${fP('cb-1').toFixed(1).padStart(9)}  ` +
    `${cb.fluid.mass.toFixed(2).padStart(10)}  ` +
    `${ncg('cb-1', 'H2').toFixed(1).padStart(8)}  ` +
    `${ncg('cb-1', 'CO').toFixed(1).padStart(8)}  ` +
    `${gasif.toFixed(2).padStart(10)}`);
}

console.log(`\n=== Xe-100 ${scenario.toUpperCase()} ===`);
console.log(`Settling ${SETTLE} s to steady state...`);
advance(SETTLE);
header();
line();

// --- Inject the fault -------------------------------------------------------
if (scenario === 'lofc') {
  const pump = st().components.pumps.get('pump-1');
  if (!pump) throw new Error('pump-1 not found');
  pump.running = false;
  console.log(`--- Circulator tripped at t=${st().time.toFixed(0)} s (no scram) ---`);
} else {
  // Turbine trip first: the bottled secondary pressurizes toward the steam
  // dump setpoint, so the tube sees full boiler pressure against 58-bar
  // helium when it lets go. (At the plant's settled state the tube side runs
  // NEAR primary pressure, so an at-power rupture would mostly just swap a
  // little gas - trip-then-rupture is the sequence that drives real water
  // ingress, and turbine trip + SGTR is a bona fide compound accident.)
  const gov = st().components.controllers?.get
    ? st().components.controllers.get('ctl-msp-1')
    : undefined;
  if (gov) { (gov as any).mode = 'manual'; (gov as any).manualOutput = 0.02; }
  const turbNode = st().flowNodes.get('turbine-1');
  if (turbNode) turbNode.governorValve = 0.02;
  console.log(`--- Turbine tripped at t=${st().time.toFixed(0)} s; boiler bottling up ---`);
  advance(150);
  line();
  const v = st().components.valves.get('val-leak-1');
  if (!v) throw new Error('val-leak-1 not found');
  v.position = 1.0;
  console.log(`--- SG tube ruptured at t=${st().time.toFixed(0)} s (full 3e-4 m2 double-ended) ---`);
}

const step = Math.max(20, Math.round(seconds / 25));
for (let t = 0; t < seconds; t += step) {
  advance(step);
  line();
}

// --- Post-mortem ------------------------------------------------------------
console.log('\nPost-mortem:');
const fuel = st().thermalNodes.get('cb-1-fuel')!;
console.log(`  Peak-ish fuel T now: ${(fuel.temperature - 273.15).toFixed(0)} C ` +
  `(TRISO failure band ~1620-1830 C)`);
const gox = st().thermalNodes.get('cb-1-clad')?.graphiteOxidation;
if (gox) {
  console.log(`  Pebble graphite burn-off: ${(gox.burnoff * 100).toFixed(4)}% ` +
    `(${(gox.burnoff * gox.initialCarbonMass).toFixed(1)} kg)`);
}
console.log(`  Core gas: ${ncg('cb-1', 'H2').toFixed(1)} mol H2, ${ncg('cb-1', 'CO').toFixed(1)} mol CO, ` +
  `${ncg('cb-1', 'He').toFixed(0)} mol He, ${(st().flowNodes.get('cb-1')!.fluid.mass).toFixed(2)} kg H2O`);
console.log(`  Primary pressure: ${fP('cb-1').toFixed(1)} bar; SG shell: ${fP('hx-ev-1-shell').toFixed(1)} bar`);

let bursts = 0;
for (const [id, b] of st().burstStates ?? []) {
  if ((b as any).isBurst) { console.log(`  BURST: ${id}`); bursts++; }
}
if (!bursts) console.log('  No bursts.');
console.log(`  Smallest dt: ${(minDt * 1000).toFixed(3)} ms`);
console.log();
