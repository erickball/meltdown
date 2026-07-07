/**
 * Extended station blackout on the 4-loop preset - severe accident progression.
 *
 * Timeline: 60 s normal ops -> SBO (all AC lost, scram, turbine trip) with the
 * TD AFW pump running on SG steam -> AFW lost at battery depletion -> SG
 * boil-off -> primary heatup, PORV cycling on the pressurizer -> core
 * uncovery -> clad oxidation, fuel damage, fission product release.
 *
 * Usage: npx tsx scripts/run-w4loop-sbo-extended.ts [maxHours] [batterySeconds] [maxDt]
 *   maxHours       total plant time to simulate (default 8)
 *   batterySeconds AFW available for this long after SBO (default 1800;
 *                  0 = TD AFW never starts, i.e. SBO without AFW)
 *   maxDt          solver max timestep in s (default 0.2)
 */

import { buildSimFromFile, Sim } from './lib/sim-harness';
import {
  triggerScram, checkScramConditions, nodeLiquidLevel, meltFraction,
} from '../src/simulation';
import type { ScramSetpoints } from '../src/simulation/operators/neutronics';
import * as path from 'path';
import { fileURLToPath } from 'url';

const PRESET = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'presets', 'w4loop.json');
const maxHours = parseFloat(process.argv[2] || '8');
const batterySeconds = parseFloat(process.argv[3] || '1800');
const maxDt = parseFloat(process.argv[4] || '0.2');

const SCRAM: ScramSetpoints = { highPower: 115, lowPower: 5, highFuelTemp: 0.92, lowCoolantFlow: 3000 };

const sim: Sim = buildSimFromFile(PRESET, { maxDt });

function advance(seconds: number, dt = 0.05): void {
  let remaining = seconds;
  while (remaining > 0) {
    const step = Math.min(1.0, remaining);
    const ticks = Math.round(step / dt);
    for (let i = 0; i < ticks; i++) {
      sim.state = sim.solver.advance(sim.state, dt).state;
      if (sim.state.pendingEvents?.length) {
        for (const ev of sim.state.pendingEvents) {
          console.log(`[EVENT t=${sim.state.time.toFixed(0)}s] ${ev.type}: ${ev.message}`);
        }
        sim.state.pendingEvents = [];
      }
    }
    if (!sim.state.neutronics.scrammed) {
      const check = checkScramConditions(sim.state, SCRAM);
      if (check.shouldScram) sim.state = triggerScram(sim.state, check.reason);
    }
    remaining -= step;
  }
}

function applySBO(): void {
  sim.state = triggerScram(sim.state, 'Station blackout');
  for (const id of ['pump-1', 'pump-2', 'pump-3', 'pump-4',
                    'cond-pump-1', 'fw-pump-1', 'fw-pump-2', 'fw-pump-3', 'fw-pump-4',
                    'hpi-pump-1', 'lpi-pump-1']) {
    sim.state.components.pumps.get(id)!.running = false;
  }
  const gov = sim.state.components.controllers.get('ctl-sgp-1')!;
  gov.mode = 'manual'; gov.manualOutput = 0; gov.actuator.min = 0; gov.actuator.rateLimit = 1;
  const heat = sim.state.components.controllers.get('ctl-pzrh-1')!;
  heat.mode = 'manual'; heat.manualOutput = 0;
  const spray = sim.state.components.controllers.get('ctl-pzrs-1')!;
  spray.mode = 'manual'; spray.manualOutput = 0;
  for (const id of ['ctl-sgl-1', 'ctl-sgl-2', 'ctl-sgl-3', 'ctl-sgl-4', 'ctl-hwl-1']) {
    const c = sim.state.components.controllers.get(id)!;
    c.mode = 'manual'; c.manualOutput = 0.05;
  }
}

function fmt(x: number, d = 1): string { return x.toFixed(d); }

let porvCycles = 0;
let prevPorvOpen = false;

function snapshot(label = ''): void {
  const s = sim.state;
  const n = s.neutronics;
  const decay = (n.decayHeatPools ?? []).reduce((a, b) => a + b, 0);
  const fuel = s.thermalNodes.get('cb-1-fuel')!;
  const clad = s.thermalNodes.get('cb-1-clad')!;
  const rv = s.flowNodes.get('rv-1')!;
  const cb = s.flowNodes.get('cb-1')!;
  const pzr = s.flowNodes.get('pzr-1')!;
  const sg1 = s.flowNodes.get('hx-1-shell')!;
  const bui = s.flowNodes.get('bui-1')!;
  const prt = s.flowNodes.get('prt-1')!;
  const cst = s.flowNodes.get('cst-1')!;
  const porv = s.components.valves.get('val-porv-1')!;
  const srv = s.components.valves.get('val-srv-1')!;
  const mssv = s.components.valves.get('val-mssv-1')!;
  const afw = s.components.pumps.get('afw-td-1')!;
  const natCirc = s.flowConnections.find(c => c.id === 'flow-pump-1-rv-1')!.massFlowRate;
  const afwFlow = s.flowConnections.find(c => c.id === 'flow-afw-td-1-val-afwcv-1')!.massFlowRate;
  const sgLvls = [1, 2, 3, 4].map(i => nodeLiquidLevel(s.flowNodes.get(`hx-${i}-shell`)!));
  const oxid = clad.oxidation?.oxidizedFraction ?? 0;
  const melt = meltFraction(fuel);
  const rel = s.environmentalRelease;

  console.log(
    `t=${fmt(s.time / 3600, 2)}h${label} ` +
    `P=${fmt((n.power + decay) / 1e6, 0)}MW ` +
    `RCS[T=${fmt(cb.fluid.temperature - 273.15, 0)}C P=${fmt(rv.fluid.pressure / 1e5, 0)}bar m=${fmt((rv.fluid.mass + cb.fluid.mass) / 1000, 0)}t] ` +
    `pzr[P=${fmt(pzr.fluid.pressure / 1e5, 0)}bar x=${fmt(pzr.fluid.quality ?? 0, 2)}] ` +
    `SG1[P=${fmt(sg1.fluid.pressure / 1e5, 0)}bar L=${sgLvls.map(l => fmt(l, 1)).join('/')}m] ` +
    `natcirc=${fmt(natCirc, 0)}kg/s afw[v=${fmt(afw.effectiveSpeed, 2)} q=${fmt(afwFlow, 1)}kg/s] ` +
    `cst=${fmt(cst.fluid.mass / 1000, 0)}t ` +
    `fuel=${fmt(fuel.temperature - 273.15, 0)}C clad=${fmt(clad.temperature - 273.15, 0)}C ` +
    `oxid=${fmt(oxid * 100, 1)}% melt=${fmt(melt * 100, 1)}% ` +
    `valves[porv=${porv.reliefOpen ? 'O' : '-'} srv=${srv.reliefOpen ? 'O' : '-'} mssv=${mssv.reliefOpen ? 'O' : '-'}] ` +
    `cont[P=${fmt(bui.fluid.pressure / 1e5, 2)}bar] prt[P=${fmt(prt.fluid.pressure / 1e5, 2)}bar m=${fmt(prt.fluid.mass / 1000, 0)}t] ` +
    (rel && ((rel.Xe ?? 0) > 0.01 || (rel.CsI ?? 0) > 0.001)
      ? `RELEASE[Xe=${fmt(rel.Xe ?? 0, 1)}mol CsI=${fmt(rel.CsI ?? 0, 2)}mol] ` : '') +
    `porvCycles=${porvCycles}`
  );
}

console.log(`Extended SBO: maxHours=${maxHours}, battery=${batterySeconds}s, maxDt=${maxDt}s`);
const wallStart = performance.now();

advance(60);
snapshot(' (pre-SBO)');
applySBO();
if (batterySeconds > 0) {
  const afwCtl = sim.state.components.controllers.get('ctl-afw-1')!;
  afwCtl.mode = 'auto';
  console.log(`[SCENARIO t=${sim.state.time.toFixed(0)}s] SBO applied; TD AFW started (battery for ${batterySeconds}s)`);
} else {
  console.log(`[SCENARIO t=${sim.state.time.toFixed(0)}s] SBO applied; TD AFW UNAVAILABLE`);
}

const sboStart = sim.state.time;
let afwFailed = batterySeconds <= 0;
let lastSnap = sim.state.time;
let lastWallReport = performance.now();

const endTime = maxHours * 3600;
while (sim.state.time < endTime) {
  advance(10, 0.05);

  // Battery depletion: AFW governor control lost -> valve drifts shut
  if (!afwFailed && sim.state.time - sboStart >= batterySeconds) {
    const afwCtl = sim.state.components.controllers.get('ctl-afw-1')!;
    afwCtl.mode = 'manual'; afwCtl.manualOutput = 0;
    afwFailed = true;
    console.log(`[SCENARIO t=${sim.state.time.toFixed(0)}s] Battery depleted - TD AFW control lost, valve closing`);
  }

  // Count PORV cycles
  const porv = sim.state.components.valves.get('val-porv-1')!;
  if (porv.reliefOpen && !prevPorvOpen) porvCycles++;
  prevPorvOpen = porv.reliefOpen ?? false;

  const sinceSnap = sim.state.time - lastSnap;
  const fuel = sim.state.thermalNodes.get('cb-1-fuel')!;
  const interesting = fuel.temperature > 700 + 273; // heatup underway: log faster
  if (sinceSnap >= (interesting ? 60 : 180)) {
    snapshot();
    lastSnap = sim.state.time;
  }
  if (performance.now() - lastWallReport > 60000) {
    const wallMin = (performance.now() - wallStart) / 60000;
    console.log(`[perf] ${fmt(sim.state.time / 3600, 2)}h plant time in ${fmt(wallMin, 1)} min wall ` +
      `(${fmt(sim.state.time / ((performance.now() - wallStart) / 1000), 1)}x realtime)`);
    lastWallReport = performance.now();
  }

  if (meltFraction(fuel) > 0.6) {
    console.log('[SCENARIO] Bulk fuel melt reached - stopping');
    break;
  }
}

snapshot(' (final)');
console.log(`\nDone: ${fmt(sim.state.time / 3600, 2)} h plant time, porvCycles=${porvCycles}`);
if (sim.state.burstStates) {
  for (const [id, b] of sim.state.burstStates) {
    if (b.isBurst) console.log(`BURST: ${b.componentLabel} (${id}) at t=${fmt((b.burstTime ?? 0) / 3600, 2)}h`);
  }
}
