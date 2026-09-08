/**
 * How much water leaves an OTSG tube WITHOUT being booked to a section?
 *
 * The economizer is a mass ledger, so every kilogram of slug water that
 * leaves the node has to be debited from it. Booking an outflow by the
 * momentum path's phase LABEL cannot do that: the label comes from a
 * phase model that knows nothing about the partition (it reads the node as
 * a cylinder as tall as the cube root of its volume), so a nozzle 13.5 m up
 * a 14 m tube reads 'vapor' whatever is standing there. This probe runs a
 * transient and integrates, per accepted tick, the mass each rule books
 * where - the label's answer against the partition's own phase-by-elevation
 * answer (drawCompositionAt) - so the size of the disagreement is a number
 * rather than an inference from rejection counts.
 *
 * Usage: npx tsx scripts/probe-otsg-draw.ts [seconds] [tripTime]
 * Env:   TUBE=hx-1-tube  TRIP=circulator|sbo|none  WINDOW=20
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { applyScenarioAction } from '../src/simulation/scenario';
import type { ScenarioAction } from '../src/simulation/scenario-types';
import { drawCompositionAt } from '../src/simulation/operators/connection-hydraulics';
import { evaluateOtsgSections } from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const seconds = parseFloat(process.argv[2] || '180');
const tripTime = parseFloat(process.argv[3] || '20');
const TUBE = process.env.TUBE || 'hx-1-tube';
const TRIP = (process.env.TRIP || 'circulator').toLowerCase();
const WINDOW = parseFloat(process.env.WINDOW || '20');
const preset = path.join(HERE, '..', 'src', 'presets', 'xe100.json');

const TRIPS: Record<string, ScenarioAction[]> = {
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
const actions = TRIPS[TRIP];
if (!actions) throw new Error(`unknown TRIP=${TRIP}`);

const sim = buildSimFromFile(preset);
const dt = 0.1;
let tripped = false;
// Integrated mass (kg) each rule books to each account, over the whole run.
let labSteam = 0, labLiq = 0, labNone = 0;
let cmpSteam = 0, cmpLiq = 0;
let out = 0;                 // total mass that left the tube
let clipped = 0, ticks = 0;  // accepted ticks with the ledger at its ceiling

console.log(`  window   Mtube   m1/M   out(kg)  slug booked: label / partition   ledger at ceiling`);
let wSlab = { out: 0, lab: 0, cmp: 0, clip: 0, n: 0 };
for (let i = 0; i < Math.round(seconds / dt); i++) {
  if (!tripped && sim.state.time >= tripTime) {
    for (const a of actions) applyScenarioAction(sim.state, a);
    tripped = true;
  }
  sim.state = sim.solver.advance(sim.state, dt).state;
  sim.state.pendingEvents = [];
  const node: any = sim.state.flowNodes.get(TUBE)!;
  if (!node.otsg || !(node.fluid.mass > 0)) continue;
  ticks++; wSlab.n++;
  const atCeiling = node.otsg.m1 >= node.fluid.mass * (1 - 1e-9);
  if (atCeiling) { clipped++; wSlab.clip++; }
  for (const c of sim.state.flowConnections) {
    const isFrom = c.fromNodeId === TUBE, isTo = c.toNodeId === TUBE;
    if (!isFrom && !isTo) continue;
    const w = isTo ? c.massFlowRate : -c.massFlowRate;   // into the node
    if (!(w < 0)) continue;
    const m = -w * dt;
    out += m; wSlab.out += m;
    const ph = c.currentFlowPhase ?? 'liquid';
    if (ph === 'vapor') labSteam += m;
    else if (ph === 'liquid') { labLiq += m; wSlab.lab += m; }
    else labNone += m;
    const comp = drawCompositionAt(node, (isTo ? c.toElevation : c.fromElevation) ?? 0, -w,
      isTo ? c.toPhaseTolerance : c.fromPhaseTolerance,
      isTo ? c.toOpeningHeight : c.fromOpeningHeight, undefined, false);
    cmpLiq += m * comp.wLiquid; wSlab.cmp += m * comp.wLiquid;
    cmpSteam += m * (1 - comp.wLiquid);
  }
  if (sim.state.time % WINDOW < dt * 0.5 || i === Math.round(seconds / dt) - 1) {
    const ev = evaluateOtsgSections(sim.state, TUBE, node, { exact: true }).ev;
    console.log(`  ${sim.state.time.toFixed(0).padStart(6)} ${node.fluid.mass.toFixed(0).padStart(7)} ` +
      `${(100 * node.otsg.m1 / node.fluid.mass).toFixed(1).padStart(6)}% ${wSlab.out.toFixed(1).padStart(8)} ` +
      `${wSlab.lab.toFixed(1).padStart(14)} / ${wSlab.cmp.toFixed(1).padStart(9)} ` +
      `${(100 * wSlab.clip / Math.max(1, wSlab.n)).toFixed(0).padStart(15)}%   ` +
      `L=${ev.sections.map((s: any) => s.lengthFrac.toFixed(2)).join('/')}`);
    wSlab = { out: 0, lab: 0, cmp: 0, clip: 0, n: 0 };
  }
}
console.log(`\ntotal ${out.toFixed(1)} kg left the tube in ${seconds} s`);
console.log(`  label rule    -> steam ${labSteam.toFixed(1)} kg, slug ${labLiq.toFixed(1)} kg, unbooked(mixture) ${labNone.toFixed(1)} kg`);
console.log(`  partition     -> steam ${cmpSteam.toFixed(1)} kg, slug ${cmpLiq.toFixed(1)} kg`);
console.log(`  slug water the label rule never debits: ${(cmpLiq - labLiq).toFixed(1)} kg ` +
  `(${(100 * (cmpLiq - labLiq) / Math.max(1e-9, out)).toFixed(1)}% of everything that left)`);
console.log(`  ledger at its ceiling on ${(100 * clipped / Math.max(1, ticks)).toFixed(0)}% of accepted ticks`);
