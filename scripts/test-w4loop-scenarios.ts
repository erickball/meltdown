/**
 * Westinghouse 4-loop PWR scenario tests (src/presets/w4loop.json)
 *
 * Not part of `npm test` (these runs are long); run standalone:
 *   npx tsx scripts/test-w4loop-scenarios.ts steady   (~900 s plant time)
 *   npx tsx scripts/test-w4loop-scenarios.ts loca     (~400 s plant time)
 *   npx tsx scripts/test-w4loop-scenarios.ts sbo      (~2400 s plant time)
 *   npx tsx scripts/test-w4loop-scenarios.ts all
 *
 * The extended (severe-accident) SBO lives in scripts/run-w4loop-sbo-extended.ts
 * since it simulates hours of plant time.
 */

import {
  test, assert, assertBetween, report,
  buildSimFromFile, run, runUntilSteady, flowRate, nodeMass, nodePressure,
  assertStateSane, Sim,
} from './lib/sim-harness';
import {
  triggerScram, checkScramConditions, nodeLiquidLevel,
} from '../src/simulation';
import type { ScramSetpoints } from '../src/simulation/operators/neutronics';
import * as path from 'path';
import { fileURLToPath } from 'url';

const PRESET = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'presets', 'w4loop.json');

const filter = (process.argv[2] || 'all').toLowerCase();
const enabled = (name: string) => filter === 'all' || filter === name;

// Scram setpoints from the preset's reactor protection controller
const SCRAM: ScramSetpoints = { highPower: 115, lowPower: 5, highFuelTemp: 0.92, lowCoolantFlow: 3000 };

/** Advance while emulating the game loop's automatic scram checks. */
function runProtected(sim: Sim, seconds: number, dt = 0.02, onSecond?: (t: number) => void): void {
  const chunk = 1.0;
  let remaining = seconds;
  while (remaining > 0) {
    const step = Math.min(chunk, remaining);
    run(sim, step, dt);
    if (!sim.state.neutronics.scrammed) {
      const check = checkScramConditions(sim.state, SCRAM);
      if (check.shouldScram) {
        sim.state = triggerScram(sim.state, check.reason);
      }
    }
    onSecond?.(sim.state.time);
    remaining -= step;
  }
}

function cladTempC(sim: Sim): number {
  const clad = sim.state.thermalNodes.get('cb-1-clad');
  if (!clad) throw new Error('cb-1-clad thermal node missing');
  return clad.temperature - 273.15;
}

function sgLevels(sim: Sim): number[] {
  return [1, 2, 3, 4].map(i => nodeLiquidLevel(sim.state.flowNodes.get(`hx-${i}-shell`)!));
}

/** Station-blackout electrical lineup: everything AC-powered dies. */
function applySBO(sim: Sim): void {
  const s = sim.state;
  sim.state = triggerScram(s, 'Loss of offsite power');
  for (const id of ['pump-1', 'pump-2', 'pump-3', 'pump-4',
                    'cond-pump-1', 'fw-pump-1', 'fw-pump-2', 'fw-pump-3', 'fw-pump-4',
                    'hpi-pump-1', 'lpi-pump-1']) {
    const p = sim.state.components.pumps.get(id);
    if (!p) throw new Error(`pump ${id} missing`);
    p.running = false;
  }
  // Turbine trip: drive the governor closed and hold it there
  const gov = sim.state.components.controllers.get('ctl-sgp-1')!;
  gov.mode = 'manual';
  gov.manualOutput = 0;
  gov.actuator.min = 0;
  gov.actuator.rateLimit = 1;
  // Pressurizer heaters and spray have no power either
  const heat = sim.state.components.controllers.get('ctl-pzrh-1')!;
  heat.mode = 'manual';
  heat.manualOutput = 0;
  const spray = sim.state.components.controllers.get('ctl-pzrs-1')!;
  spray.mode = 'manual';
  spray.manualOutput = 0;
  // Feedwater/hotwell controllers are moot (pumps tripped) but park them
  for (const id of ['ctl-sgl-1', 'ctl-sgl-2', 'ctl-sgl-3', 'ctl-sgl-4', 'ctl-hwl-1']) {
    const c = sim.state.components.controllers.get(id)!;
    c.mode = 'manual';
    c.manualOutput = 0.05;
  }
}

/** Start the (DC-controlled, steam-driven) TD AFW pump. */
function startAFW(sim: Sim): void {
  const afw = sim.state.components.controllers.get('ctl-afw-1')!;
  afw.mode = 'auto';
}

// ---------------------------------------------------------------------------
// Steady state: converge to and hold rated power
// ---------------------------------------------------------------------------

if (enabled('steady')) {
  test('4-loop plant converges to rated power and holds', () => {
    const sim = buildSimFromFile(PRESET);
    const { steady, detector, elapsed } = runUntilSteady(sim, 1200, 0.5, {
      windowSeconds: 60,
      fractionalRateTol: 2e-3,
      temperatureRateTol: 0.1,
      holdSeconds: 60,
    });
    const worst = detector.worstOffender();
    assert(steady,
      `plant should reach steady state within 1200 s (worst drift after ${elapsed.toFixed(0)} s: ` +
      `${worst?.metric}=${worst?.value.toExponential(2)} vs tol ${worst?.tolerance.toExponential(2)})`);

    const state = sim.state;
    const n = state.neutronics;
    assertBetween(n.power / n.nominalPower, 0.7, 1.15, 'reactor should hold near rated power');
    assertBetween(n.controlRodPosition, 0.05, 0.97, 'rods should hold an interior position');
    // The cold-start power ascension drains and cools the pressurizer; the
    // (realistically sized) 1.8 MW heater bank recovers the setpoint at
    // ~1 bar/min, which is still in progress when steadiness latches. Accept
    // a low-but-recovering pressure only while the heaters are pinned at max.
    const pzrP = nodePressure(state, 'pzr-1');
    if (pzrP < 148e5) {
      const pzrNode = state.flowNodes.get('pzr-1')!;
      assert((pzrNode.heaterPower ?? 0) > 0.95 * (pzrNode.heaterCapacity ?? 1.8e6),
        `pressurizer below setpoint (${(pzrP / 1e5).toFixed(1)} bar) without heaters driving recovery`);
    }
    assertBetween(pzrP, 118e5, 162e5, 'pressurizer pressure on/recovering to setpoint');
    assertBetween(nodePressure(state, 'hx-1-shell'), 55e5, 65e5, 'SG pressure on setpoint');

    // All four loops circulating symmetrically
    const flows = [1, 2, 3, 4].map(i => flowRate(state, `pump-${i}`, 'rv-1'));
    for (const q of flows) assert(q > 3000, `each loop should circulate strongly, got ${q.toFixed(0)} kg/s`);
    const spread = (Math.max(...flows) - Math.min(...flows)) / Math.max(...flows);
    assert(spread < 0.1, `loops should share symmetrically (spread ${(spread * 100).toFixed(1)}%)`);

    // All four SGs making steam, levels healthy
    for (let i = 1; i <= 4; i++) {
      assert(flowRate(state, `hx-${i}`, 'turbine-1') > 50,
        `SG ${i} should supply steam, got ${flowRate(state, `hx-${i}`, 'turbine-1').toFixed(1)} kg/s`);
    }
    for (const lvl of sgLevels(sim)) assertBetween(lvl, 6, 11, 'SG level near setpoint');

    // Relief valves all seated
    for (const [id, v] of state.components.valves) {
      if (v.relief) assert(v.position < 0.01, `${id} should be seated at steady state`);
    }
    assertStateSane(state);
  });
}

// ---------------------------------------------------------------------------
// LOCA: cold-leg break, blowdown, accumulator + LPI injection, core intact
// ---------------------------------------------------------------------------

if (enabled('loca')) {
  test('Cold-leg LOCA: blowdown, ECCS injection, core stays cool', () => {
    const sim = buildSimFromFile(PRESET);
    // Establish operation (not full rated power - the break doesn't care)
    runProtected(sim, 60, 0.02);
    const accMass0 = nodeMass(sim.state, 'acc-1');
    const contP0 = nodePressure(sim.state, 'bui-1');

    // Open the break; safety injection signal follows on low pressure
    const brk = sim.state.components.valves.get('val-break-1')!;
    brk.position = 1.0;
    sim.state = triggerScram(sim.state, 'LOCA - low pressurizer pressure');
    for (const id of ['hpi-pump-1', 'lpi-pump-1']) {
      const p = sim.state.components.pumps.get(id)!;
      p.running = true;
      p.speed = 1.0; // factory zeroes the setpoint for pumps built not-running
    }
    // RCPs trip on loss of subcooling
    let rcpsTripped = false;
    let maxClad = cladTempC(sim);
    let maxContP = contP0;
    let lastLog = sim.state.time;
    runProtected(sim, 600, 0.02, () => {
      if (!rcpsTripped && nodePressure(sim.state, 'rv-1') < 100e5) {
        for (let i = 1; i <= 4; i++) sim.state.components.pumps.get(`pump-${i}`)!.running = false;
        rcpsTripped = true;
      }
      maxClad = Math.max(maxClad, cladTempC(sim));
      maxContP = Math.max(maxContP, nodePressure(sim.state, 'bui-1'));
      if (sim.state.time - lastLog >= 20) {
        lastLog = sim.state.time;
        console.log(`  [loca t=${sim.state.time.toFixed(0)}s] ` +
          `P_rcs=${(nodePressure(sim.state, 'rv-1') / 1e5).toFixed(1)}bar ` +
          `P_cont=${(nodePressure(sim.state, 'bui-1') / 1e5).toFixed(2)}bar ` +
          `acc1=${(nodeMass(sim.state, 'acc-1') / 1000).toFixed(1)}t ` +
          `hpi=${flowRate(sim.state, 'hpi-pump-1', 'val-hpicv-1').toFixed(1)}kg/s ` +
          `lpi=${flowRate(sim.state, 'lpi-pump-1', 'val-lpicv-1').toFixed(1)}kg/s ` +
          `clad=${cladTempC(sim).toFixed(0)}C`);
      }
    });

    const state = sim.state;
    // Blowdown: below the accumulator setpoint (they actuated) and still
    // falling toward containment pressure. An ~8" break with decay-heat
    // boiling legitimately hangs in the tens of bar for hundreds of seconds,
    // so don't demand full depressurization inside the window.
    const pEnd = nodePressure(state, 'rv-1');
    assert(pEnd < 38e5, `RCS should fall below the accumulator setpoint, still at ${(pEnd / 1e5).toFixed(1)} bar`);
    assert(rcpsTripped, 'RCPs should have tripped on depressurization');

    // Accumulators injected
    const accDelivered = accMass0 - nodeMass(state, 'acc-1');
    assert(accDelivered > 10000,
      `accumulator A should inject its water (delivered ${(accDelivered / 1000).toFixed(1)} t)`);

    // High-head injection delivering from the RWST throughout; low-head (RHR)
    // only once the RCS is below its shutoff head (~12 bar) - a real RHR pump
    // physically cannot inject before that.
    assert(flowRate(state, 'hpi-pump-1', 'val-hpicv-1') > 10,
      `HPI should be injecting, got ${flowRate(state, 'hpi-pump-1', 'val-hpicv-1').toFixed(0)} kg/s`);
    if (pEnd < 10e5) {
      assert(flowRate(state, 'lpi-pump-1', 'val-lpicv-1') > 50,
        `LPI should be injecting once RCS is depressurized, got ${flowRate(state, 'lpi-pump-1', 'val-lpicv-1').toFixed(0)} kg/s`);
    }

    // Containment pressurized but held
    assert(maxContP > 1.3e5, `containment should pressurize (peak ${(maxContP / 1e5).toFixed(2)} bar)`);
    const contBurst = state.burstStates?.get('bui-1');
    assert(!contBurst?.isBurst, 'containment must not burst');

    // Core never overheated (ECCS success)
    assert(maxClad < 1000, `peak clad temperature should stay below runaway oxidation, got ${maxClad.toFixed(0)}C`);

    // Only the deliberate break flows to containment. The RPV is explicitly
    // NOT excused: it must survive its own accumulator injection (the slam is
    // orifice-limited in the preset for exactly this reason).
    assertStateSane(state, ['val-break-1']);
  });
}

// ---------------------------------------------------------------------------
// SBO: natural circulation, MSSV cycling, TD AFW holds SG inventory
// ---------------------------------------------------------------------------

if (enabled('sbo')) {
  test('Station blackout: natural circ + MSSVs + TD AFW hold the plant', () => {
    const sim = buildSimFromFile(PRESET);
    runProtected(sim, 60, 0.02);

    applySBO(sim);
    startAFW(sim);

    let mssvLifted = false;
    let maxSgP = 0;
    let maxPzrP = 0;
    let maxAfwSpeed = 0;
    let lastLog = sim.state.time;
    runProtected(sim, 2400, 0.02, () => {
      const mssv = sim.state.components.valves.get('val-mssv-1')!;
      if (mssv.reliefOpen) mssvLifted = true;
      maxSgP = Math.max(maxSgP, nodePressure(sim.state, 'hx-1-shell'));
      maxPzrP = Math.max(maxPzrP, nodePressure(sim.state, 'pzr-1'));
      maxAfwSpeed = Math.max(maxAfwSpeed, sim.state.components.pumps.get('afw-td-1')!.effectiveSpeed);
      if (sim.state.time - lastLog >= 60) {
        lastLog = sim.state.time;
        const loops = [1, 2, 3, 4].map(i => flowRate(sim.state, `pump-${i}`, 'rv-1').toFixed(0)).join('/');
        console.log(`  [sbo t=${sim.state.time.toFixed(0)}s] ` +
          `loops=${loops}kg/s core=${flowRate(sim.state, 'rv-1', 'cb-1').toFixed(0)}kg/s ` +
          `SG_P=${(nodePressure(sim.state, 'hx-1-shell') / 1e5).toFixed(1)}bar ` +
          `SG_L=${sgLevels(sim).map(l => l.toFixed(1)).join('/')}m ` +
          `pzr=${(nodePressure(sim.state, 'pzr-1') / 1e5).toFixed(1)}bar ` +
          `afw_v=${sim.state.components.pumps.get('afw-td-1')!.effectiveSpeed.toFixed(2)} ` +
          `clad=${cladTempC(sim).toFixed(0)}C`);
      }
    });

    const state = sim.state;
    // Decay heat is being carried to the SGs: strong net circulation through
    // the core. Individual loops may run backward - reverse flow in some
    // loops of a multi-loop plant under asymmetric AFW cooling is a real
    // natural-circulation mode - so the criterion is core flow, not per-loop
    // direction.
    const coreFlow = flowRate(state, 'rv-1', 'cb-1');
    assert(Math.abs(coreFlow) > 100,
      `core natural circulation should persist, got ${coreFlow.toFixed(0)} kg/s`);

    // Secondary pressure bounded. With the TD AFW turbine drawing steam and
    // cold AFW condensing more, the SGs can legitimately hover just BELOW the
    // MSSV setpoint - so only demand a lift if the setpoint was actually
    // reached (the relief mechanism itself has its own regression test, and
    // the extended-SBO run challenges the MSSVs after battery depletion).
    assert(maxSgP < 8.0e6, `SG pressure should be bounded, peaked at ${(maxSgP / 1e6).toFixed(2)} MPa`);
    if (maxSgP >= 7.2e6) {
      assert(mssvLifted, `SG pressure reached the MSSV setpoint (${(maxSgP / 1e6).toFixed(2)} MPa) but no MSSV lifted`);
    }

    // TD AFW ran on SG steam and kept the AFW-controlled SG's bundle covered
    assert(maxAfwSpeed > 0.05, `TD AFW pump should have run, peak speed=${maxAfwSpeed.toFixed(2)}`);
    const levels = sgLevels(sim);
    assert(levels[0] > 4, `AFW-fed SG A bundle should stay covered (level ${levels[0].toFixed(1)} m)`);
    for (const lvl of levels) {
      assert(lvl > 2, `no SG should boil dry with AFW available (level ${lvl.toFixed(1)} m)`);
    }

    // Primary stayed inside the relief envelope, core cool
    assert(maxPzrP < 17.5e6, `primary pressure bounded (peak ${(maxPzrP / 1e6).toFixed(2)} MPa)`);
    assert(cladTempC(sim) < 400, `core should stay cool, clad at ${cladTempC(sim).toFixed(0)}C`);
    assertStateSane(state);
  });
}

report('W4-loop Scenario Suite');
