/**
 * Neutron-source restart probe.
 *
 * The question: after a long shutdown, how far down does fission power fall,
 * and how long does it take to climb back to a readable level when the
 * operator pulls rods? Without a neutron source the kinetics have no
 * equilibrium below critical - N and C decay exponentially forever (a scram
 * plus 3000 s of soak leaves the core at ~1e-90 of nominal), and the restart
 * ramp has to climb out of whatever absurd level the soak reached. With a
 * source the subcritical steady state is N_ss = S*Lambda/(-rho) and the ramp
 * starts from a physical place.
 *
 * Usage: npx tsx scripts/probe-neutron-source.ts [preset] [soakSeconds] [mode]
 *   preset       path to a plant JSON (default src/presets/pwr.json)
 *   soakSeconds  time held shut down before pulling rods (default 1500)
 *   mode         'on' (default) | 'off' - 'off' zeroes every source term,
 *                reproducing the pre-source kinetics for comparison
 *
 * The rod controller is removed from the plant so the probe, not a PID, owns
 * rod position. Everything else about the preset is untouched.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromPlantJson, run, type Sim } from './lib/sim-harness';
import { triggerScram } from '../src/simulation/operators';
import {
  neutronSourceRate, normalizedNeutronSource,
} from '../src/simulation/operators/neutronics';
import type { SimulationState } from '../src/simulation/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const presetPath = args[0] || path.join(HERE, '..', 'src', 'presets', 'pwr.json');
const soakSeconds = parseFloat(args[1] || '1500');
const mode = (args[2] || 'on') as 'on' | 'off';

// Reactivity to restart on, in dollars. +0.5 $ is a brisk but ordinary
// startup ramp: the one-group stable period is (beta - rho)/(lambda*rho),
// about 12 s at this reactivity, so the ramp time is essentially
// 12 s * ln(target/start) and therefore a direct readout of how far down
// the shutdown level was.
const RESTART_DOLLARS = 0.5;
const TARGET_FRACTION = 0.01; // "readable range": 1% of nominal fission power

const plant = JSON.parse(fs.readFileSync(presetPath, 'utf-8'));
// Drop rod controllers: the probe drives the rods itself.
const dropped: string[] = [];
plant.components = (plant.components as Array<[string, any]>).filter(([id, c]) => {
  if (c.type === 'controller' && c.pid?.actuator?.kind === 'control-rods') {
    dropped.push(id);
    return false;
  }
  return true;
});

const sim: Sim = buildSimFromPlantJson(plant);
const n0: any = sim.state.neutronics;
if (mode === 'off') {
  n0.spontaneousFissionSource = 0;
  n0.irradiatedFuelSource = 0;
  n0.startupSourceRate = 0;
}

const nominal = sim.state.neutronics.nominalPower;
console.log(`preset=${path.basename(presetPath)} mode=source-${mode} ` +
  `P_nom=${(nominal / 1e6).toFixed(0)} MW  dropped controllers: ${dropped.join(',') || 'none'}`);
console.log(`source: s_n=${neutronSourceRate(sim.state.neutronics).toExponential(3)} n/s ` +
  `(spontaneous ${(n0.spontaneousFissionSource ?? 0).toExponential(2)}, ` +
  `irradiated-equilibrium ${(n0.irradiatedFuelSource ?? 0).toExponential(2)}, ` +
  `installed ${(n0.startupSourceRate ?? 0).toExponential(2)})  ` +
  `S=${normalizedNeutronSource(sim.state.neutronics).toExponential(3)} 1/s`);

const frac = (s: SimulationState) => s.neutronics.power / s.neutronics.nominalPower;
const dollars = (s: SimulationState) => s.neutronics.reactivity / s.neutronics.delayedNeutronFraction;
const line = (s: SimulationState, tag: string) =>
  console.log(`  t=${s.time.toFixed(0).padStart(6)}s  ${tag.padEnd(10)} ` +
    `P_fis=${frac(s).toExponential(3)} of nominal  rho=${(dollars(s)).toFixed(3)} $  ` +
    `C=${s.neutronics.precursorConcentration.toExponential(3)}  ` +
    `Q_decay=${(s.neutronics.decayHeatPools!.reduce((a, b) => a + b, 0) / 1e6).toFixed(2)} MW`);

// ---- 1. settle at the preset's initial power ------------------------------
run(sim, 60, 0.2);
line(sim.state, 'at power');

// ---- 2. scram and soak ----------------------------------------------------
// Solver cost of the soak is the evidence for whether deeply-subcritical
// kinetics need any special handling (they don't: the source turns them into
// a slow relaxation on the precursor timescale).
const stepsBefore = sim.solver.getMetrics().totalSteps;
const rejectsBefore = sim.solver.getMetrics().rejectedSteps;
sim.state = triggerScram(sim.state, 'neutron-source probe');
let nextReport = 0;
const soakStart = sim.state.time;
const marks = [1, 10, 100, 300, 1000, 1500, 2000, 3000];
while (sim.state.time - soakStart < soakSeconds) {
  run(sim, 5, 0.2);
  const elapsed = sim.state.time - soakStart;
  while (nextReport < marks.length && elapsed >= marks[nextReport]) {
    if (marks[nextReport] <= soakSeconds) line(sim.state, `+${marks[nextReport]}s`);
    nextReport++;
  }
}
const shutdownFraction = frac(sim.state);
const rhoShutdown = sim.state.neutronics.reactivity;
line(sim.state, 'soaked');
const soakSteps = sim.solver.getMetrics().totalSteps - stepsBefore;
const soakRejects = sim.solver.getMetrics().rejectedSteps - rejectsBefore;
console.log(`  soak cost: ${soakSteps} solver steps, ${soakRejects} rejected ` +
  `(${(soakSeconds / soakSteps * 1e3).toFixed(1)} ms mean dt)`);

// Analytic check on the subcritical steady state.
const S = normalizedNeutronSource(sim.state.neutronics);
const nSteady = S * sim.state.neutronics.promptNeutronLifetime / -rhoShutdown;
console.log(`  subcritical steady state S*Lambda/(-rho) = ${nSteady.toExponential(3)} ` +
  `vs measured ${shutdownFraction.toExponential(3)} ` +
  `(ratio ${(shutdownFraction / nSteady).toFixed(3)})`);

// ---- 3. pull rods to +RESTART_DOLLARS and time the climb ------------------
const nn = sim.state.neutronics;
const target = RESTART_DOLLARS * nn.delayedNeutronFraction;
const pos = nn.controlRodPosition + (target - nn.reactivity) / nn.controlRodWorth;
if (pos < 0 || pos > 1) {
  throw new Error(
    `[Probe] Cannot reach +${RESTART_DOLLARS} $ : rod position would be ${pos.toFixed(3)} ` +
    `(rho=${nn.reactivity.toExponential(3)}, worth=${nn.controlRodWorth})`
  );
}
sim.state.neutronics.controlRodPosition = pos;
console.log(`  rods withdrawn to ${(pos * 100).toFixed(1)}% for +${RESTART_DOLLARS} $`);

const rampStart = sim.state.time;
const maxRamp = 20000; // s of simulated time before giving up
let reached = -1;
let decade = Math.ceil(Math.log10(Math.max(frac(sim.state), 1e-300)));
while (sim.state.time - rampStart < maxRamp) {
  run(sim, 2, 0.2);
  const f = frac(sim.state);
  while (f >= Math.pow(10, decade) && decade <= -2) {
    console.log(`    1e${decade} of nominal at +${(sim.state.time - rampStart).toFixed(1)}s`);
    decade++;
  }
  if (f >= TARGET_FRACTION) { reached = sim.state.time - rampStart; break; }
}

console.log('');
console.log(`mode=source-${mode}  preset=${path.basename(presetPath)}`);
console.log(`  shutdown level after ${soakSeconds}s at rho=${(rhoShutdown / nn.delayedNeutronFraction).toFixed(2)} $ : ` +
  `${shutdownFraction.toExponential(3)} of nominal`);
console.log(`  time from there to ${(TARGET_FRACTION * 100).toFixed(0)}% of nominal at ` +
  `+${RESTART_DOLLARS} $ : ${reached < 0 ? `NOT REACHED in ${maxRamp}s` : `${reached.toFixed(1)}s`}`);
