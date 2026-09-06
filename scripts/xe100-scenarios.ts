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
const scenario = (process.argv[2] ?? 'lofc') as 'lofc' | 'sgtr';
// The fault sequences live in the scenario presets (gen-xe100.ts writes them;
// src/simulation/scenario-types.ts describes them) and fire from inside the
// solver, so this script only drives time and reports. PRESET=<path> runs a
// different preset file under its own sequence.
const PRESET = process.env.PRESET ??
  path.join(HERE, '..', 'src', 'presets', scenario === 'sgtr' ? 'xe100-sgtr.json' : 'xe100-sbo.json');
const seconds = parseFloat(process.argv[3] ?? '1800');
const SETTLE = 400; // s to steady state before the fault

const sim = buildSimFromFile(PRESET);

let minDt = Infinity;
function advance(secs: number, dt = 0.05) {
  const ticks = Math.round(secs / dt);
  for (let i = 0; i < ticks; i++) {
    const r = sim.solver.advance(sim.state, dt);
    sim.state = r.state;
    for (const ev of sim.state.pendingEvents ?? []) {
      if (ev.type === 'scenario') console.log(`--- ${ev.message} ---`);
    }
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
  const c = st().flowConnections.find(x => x.id === 'flow-cv-1-rv-1');
  return c ? c.massFlowRate : NaN;
};

/**
 * Cavity cooling duty, read the way the physics computes it: sigma * A_eff *
 * (T_vessel^4 - T_panel^4) summed over the declared radiant surfaces. Reading
 * it off the water side instead would lag by the loop transit and hide
 * exactly the T^4 self-strengthening the system exists for.
 */
const SIGMA_SB = 5.670374419e-8;
function rccsDuty(): number {
  let q = 0;
  for (const c of st().thermalConnections) {
    if (!c.radiationCoeff || !c.toNodeId.startsWith('rccs-')) continue;
    const from = st().thermalNodes.get(c.fromNodeId);
    const to = st().thermalNodes.get(c.toNodeId);
    if (!from || !to) continue;
    q += SIGMA_SB * c.radiationCoeff *
      (Math.pow(from.temperature, 4) - Math.pow(to.temperature, 4));
  }
  return q;
}
const rccsFlow = () => {
  const c = st().flowConnections.find(x => x.id === 'flow-rccs-tank-1-rccs-panel-1');
  return c ? c.massFlowRate : NaN;
};

function header() {
  console.log(
    '    t(s)  He(kg/s)  Pwr(MW)  T_fuel(C)  T_peb(C)  T_refl(C)  T_wall(C)  ' +
    'P_he(bar)  H2O_cb(kg)   H2(mol)   CO(mol)  gasif(g/s)  ' +
    'RCCS(MW)  w(kg/s)  T_pnl(C)  T_tnk(C)');
  console.log('  ' + '-'.repeat(160));
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
    `${gasif.toFixed(2).padStart(10)}  ` +
    `${(rccsDuty() / 1e6).toFixed(2).padStart(8)}  ` +
    `${rccsFlow().toFixed(1).padStart(7)}  ` +
    `${fT('rccs-panel-2').toFixed(0).padStart(8)}  ` +
    `${fT('rccs-tank-1').toFixed(0).padStart(8)}`);
}

console.log(`\n=== Xe-100 ${scenario.toUpperCase()} ===`);
console.log(`Settling ${SETTLE} s to steady state...`);
advance(SETTLE);
header();
line();

// --- The fault ---------------------------------------------------------------
// Fired by the preset's scenario events as time passes (see scenario-types);
// the solver reports each one through pendingEvents, echoed here.
const events = sim.state.scenario?.events ?? [];
if (events.length === 0) throw new Error(`${PRESET} carries no scenario events`);
for (const ev of events) console.log(`  scheduled t=${ev.time} s: ${ev.message}`);
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
console.log(`  Primary pressure: ${fP('cb-1').toFixed(1)} bar; SG shell: ${fP('hx-1-shell').toFixed(1)} bar`);

let bursts = 0;
for (const [id, b] of st().burstStates ?? []) {
  if ((b as any).isBurst) { console.log(`  BURST: ${id}`); bursts++; }
}
if (!bursts) console.log('  No bursts.');
console.log(`  Smallest dt: ${(minDt * 1000).toFixed(3)} ms`);
console.log();
