/**
 * Slow-mode probe: runs a preset with or without slow mode (projective
 * jumping, src/simulation/slow-mode.ts) and prints a trajectory of the slow
 * observables, so a slow-mode run can be compared against a fully resolved
 * reference.
 *
 * Usage: npx tsx scripts/probe-slow-mode.ts <preset.json> <seconds> <slow|ref> [every] [snapIn] [snapOut] [csvOut]
 *   SLOW_RELTOL / SLOW_TEMPTOL / SLOW_RELAX / SLOW_MEASURE / SLOW_MAXJUMP override the config.
 */
import * as fs from 'fs';
import { buildSimFromFile } from './lib/sim-harness';
import { serializeSimulationState, deserializeSimulationState } from '../src/simulation/serialization';
import { SlowModeController } from '../src/simulation/slow-mode';
import type { SimulationState } from '../src/simulation/types';

const [presetPath, secArg, mode, everyArg, snapIn, snapOut, csvOut] = process.argv.slice(2);
const seconds = parseFloat(secArg ?? '3600');
const every = parseFloat(everyArg ?? '300');
const sim = buildSimFromFile(presetPath);
if (snapIn && snapIn !== '-') sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(snapIn, 'utf-8')));

const env = (k: string) => process.env[k] !== undefined ? parseFloat(process.env[k]!) : undefined;
const cfg: Record<string, number> = {};
for (const [k, e] of [['relTol', 'SLOW_RELTOL'], ['tempTol', 'SLOW_TEMPTOL'], ['relaxSeconds', 'SLOW_RELAX'],
  ['measureSeconds', 'SLOW_MEASURE'], ['maxJump', 'SLOW_MAXJUMP']] as const) {
  const v = env(e);
  if (v !== undefined) cfg[k] = v;
}
const diagnose = process.env.SLOW_DIAG === '1';
const slow = mode === 'slow' ? new SlowModeController({ ...cfg, diagnose }) : null;
let lastLimitsPrinted: unknown = null;

const wall0 = performance.now();
let steps = 0, rej = 0;
const csv: string[] = ['t,wall,Tfuel,Tmax,TmaxId,Pcore,decayMW,burnoff,jumped'];

function observe(s: SimulationState) {
  let Tmax = -Infinity, TmaxId = '';
  for (const [id, t] of s.thermalNodes) if (t.temperature > Tmax) { Tmax = t.temperature; TmaxId = id; }
  const fuelEntry = [...s.thermalNodes].find(([id]) => id.endsWith('-fuel'));
  const fuel = fuelEntry?.[1];
  let burn = 0;
  for (const [, t] of s.thermalNodes) if (t.graphiteOxidation) burn += t.graphiteOxidation.burnoff * t.graphiteOxidation.initialCarbonMass;
  const decay = (s.neutronics.decayHeatPools ?? []).reduce((a, b) => a + b, 0);
  // Core coolant pressure: the flow node the fuel convects to
  const coreFlow = process.env.PNODE ?? [...s.convectionConnections].find(c => c.thermalNodeId === fuelEntry?.[0])?.flowNodeId
    ?? fuelEntry?.[0].replace(/-fuel$/, '');
  const P = coreFlow ? s.flowNodes.get(coreFlow)?.fluid.pressure ?? NaN : NaN;
  return { Tfuel: (fuel?.temperature ?? NaN) - 273.15, Tmax: Tmax - 273.15, TmaxId, P: P / 1e5, decay: decay / 1e6, burn };
}

function line() {
  const s = sim.state;
  const o = observe(s);
  const wall = (performance.now() - wall0) / 1000;
  const st = slow?.getStatus();
  console.log(`t=${s.time.toFixed(0)} wall=${wall.toFixed(0)}s x${(s.time - t0) / Math.max(wall, 1e-3) | 0} steps=${steps} rej=${rej} ` +
    `Tfuel=${o.Tfuel.toFixed(1)} Tmax=${o.Tmax.toFixed(1)}(${o.TmaxId}) P=${o.P.toFixed(3)}bar decay=${o.decay.toFixed(3)}MW ` +
    `burn=${o.burn.toFixed(2)}kg` +
    (st ? ` jumps=${st.jumps} skipped=${st.jumpedSeconds.toFixed(0)}s ceil=${st.maxJump.toFixed(0)} hold="${st.lastHold}"` : ''));
  csv.push([s.time, wall, o.Tfuel, o.Tmax, o.TmaxId, o.P, o.decay, o.burn, st?.jumpedSeconds ?? 0].join(','));
}

const t0 = sim.state.time;
const end = t0 + seconds;
let next = t0;
while (sim.state.time < end) {
  if (sim.state.time >= next) { line(); next += every; }
  const tick = Math.min(0.5, end - sim.state.time);
  const r = slow ? slow.advance(sim.solver, sim.state, tick) : sim.solver.advance(sim.state, tick);
  sim.state = r.state;
  if ('jump' in r && r.jump) {
    console.log(`   jump t=${r.jump.time.toFixed(0)} +${r.jump.jump.toFixed(0)}s limited by ${r.jump.limitedBy} ${r.jump.detail ?? ''}`);
  }
  sim.state.pendingEvents = [];
  if (diagnose && slow && slow.getLimits() !== lastLimitsPrinted) {
    lastLimitsPrinted = slow.getLimits();
    console.log(`   window t=${sim.state.time.toFixed(0)} tightest limits:\n` +
      slow.getLimits().map(l => `     ${l.J.toFixed(1).padStart(8)} s  ${l.key}  ${l.detail}`).join('\n'));
  }
  steps += r.metrics?.subcycleCount ?? 0;
  rej += r.metrics?.retriesThisFrame ?? 0;
}
line();
if (process.env.DUMP === '1') {
  // Where the oxygen and the burning are, for comparing two runs
  const s = sim.state;
  for (const [id, n] of s.flowNodes) {
    const g = n.fluid.ncg as unknown as Record<string, number> | undefined;
    if (g && (g.O2 > 1e-6 || g.CO > 1e-6 || g.CO2 > 1e-6)) {
      console.log(`  node ${id}: O2=${g.O2.toFixed(3)} N2=${g.N2.toFixed(2)} He=${g.He.toFixed(1)} CO=${g.CO.toFixed(3)} CO2=${g.CO2.toFixed(3)} T=${(n.fluid.temperature - 273.15).toFixed(0)}C`);
    }
  }
  for (const [id, t] of s.thermalNodes) {
    const go = t.graphiteOxidation;
    if (go && go.burnoff > 0) console.log(`  solid ${id}: burned=${(go.burnoff * go.initialCarbonMass).toFixed(3)} kg T=${(t.temperature - 273.15).toFixed(0)}C`);
  }
  for (const c of s.flowConnections) {
    const from = s.flowNodes.get(c.fromNodeId)?.fluid.ncg as unknown as Record<string, number> | undefined;
    if (from && from.O2 > 0.01 && Math.abs(c.massFlowRate) > 1e-4) console.log(`  flow ${c.id}: ${c.massFlowRate.toExponential(2)} kg/s`);
  }
}
if (snapOut && snapOut !== '-') fs.writeFileSync(snapOut, JSON.stringify(serializeSimulationState(sim.state)));
if (csvOut) fs.writeFileSync(csvOut, csv.join('\n'));
