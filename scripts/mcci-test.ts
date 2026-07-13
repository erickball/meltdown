/**
 * MCCI integration driver.
 *
 * Starts scripts/melt-test.json from an already-degraded state (molten
 * core, partially oxidized clad, lower head near melting) so the ex-vessel
 * chain runs in minutes of sim time instead of hours:
 *
 *   relocation -> lower-head melt-through -> pour to containment floor ->
 *   concrete ablation -> H2O/CO2 -> H2/CO via metal oxidation -> burn
 *
 * Observational driver with a few hard checks at the end. Usage:
 *   npx tsx scripts/mcci-test.ts [seconds]
 */

import { buildSimFromFile } from './lib/sim-harness';
import {
  meltFraction, basematErodedDepth,
  RK45Solver,
  HeatGenerationRateOperator,
  NeutronicsRateOperator,
  ConductionRateOperator,
  CoriumRelocationRateOperator,
  McciRateOperator,
  HydrogenCombustionRateOperator,
  FissionProductReleaseOperator,
  FluidStateConstraintOperator,
  BurstCheckOperator,
} from '../src/simulation';
import type { SimulationState } from '../src/simulation/types';

const T_END = parseFloat(process.argv[2] || '1200');

const sim = buildSimFromFile('scripts/melt-test.json');
let state: SimulationState = sim.state;

// Reduced operator set: the full flow stack is deliberately absent. A
// breached, dried-out core node thrashes the error controller at sub-ms dt
// (pre-existing pathology of near-empty flow nodes - the same wall the
// as-committed melt-test hits at ~t=197 s on unmodified HEAD), and none of
// the physics under test here lives in flow transport. This harness runs
// the severe-accident thermal/chemistry chain on a frozen flow field:
// relocation, head melt-through, pour, MCCI ablation + gas chemistry,
// combustion of the generated H2/CO, decay heat, FP release, burst events.
// implicitMomentum OFF and no momentum rate operator: connection flows stay
// frozen at zero, so the dried-core acoustic sloshing (dt < mass/throughput,
// the pre-existing severe-accident bottleneck) cannot throttle this harness.
const solver = new RK45Solver({ pressureSolver: { implicitMomentum: false } });
solver.addRateOperator(new NeutronicsRateOperator());
solver.addRateOperator(new HeatGenerationRateOperator());
solver.addRateOperator(new ConductionRateOperator());
solver.addRateOperator(new CoriumRelocationRateOperator());
solver.addRateOperator(new McciRateOperator());
solver.addRateOperator(new HydrogenCombustionRateOperator());
// FissionProductRelease is NOT registered: with the flow field frozen, its
// Xe/energy stream into the core coolant node has no outlet and cooks that
// node to divergence. FP-release targeting is covered by the live-plant runs.
solver.addConstraintOperator(new FluidStateConstraintOperator());
solver.addConstraintOperator(new BurstCheckOperator());
sim.solver = solver;

// --- Degrade the initial state -------------------------------------------
{
  const fuel = state.thermalNodes.get('cb-1-fuel');
  const clad = state.thermalNodes.get('cb-1-clad');
  const corium = state.thermalNodes.get('cb-1-corium');
  const head = state.thermalNodes.get('rv-1-lowerhead');
  const debris = state.thermalNodes.get('cb-1-corium-ex');
  const basemat = state.thermalNodes.get('bui-1-basemat');
  if (!fuel || !clad || !corium || !head) throw new Error('melt-test nodes missing');
  if (!debris || !basemat) throw new Error('MCCI nodes missing - factory pass did not run');

  fuel.temperature = 2950;   // molten (UO2 melting 2800 K)
  clad.temperature = 2950;
  if (clad.oxidation) clad.oxidation.oxidizedFraction = 0.3; // 70% of clad Zr still metal
  corium.temperature = 2900;
  // Pool already relocated (skip the ~10 min candling transient): move most
  // of the core inventory into the pool, with the unoxidized clad Zr
  corium.mass = 15000;
  corium.metal = { zr: 1500, fe: 0 };
  fuel.mass -= 12000;
  clad.mass -= 2999;
  head.temperature = 1690;   // melt onset - pour and breach start immediately

  // Vessel water mostly gone (post-boiloff): skip the blowdown transient
  const rv = state.flowNodes.get('rv-1');
  const cb = state.flowNodes.get('cb-1');
  if (rv) { rv.fluid.mass = 20; rv.fluid.internalEnergy = 20 * 2.7e6; }
  if (cb) { cb.fluid.mass = 3; cb.fluid.internalEnergy = 3 * 2.7e6; }

  console.log(`Initial: fuel=${(fuel.mass / 1000).toFixed(1)}t clad=${(clad.mass / 1000).toFixed(1)}t ` +
    `head=${(head.mass / 1000).toFixed(1)}t basemat=${(basemat.mass / 1000).toFixed(0)}t ` +
    `floor=${debris.surfaceArea.toFixed(0)}m2`);
}

// --- Run ------------------------------------------------------------------
const dt = 0.02;
const wall0 = Date.now();
let lastLog = -1e9;
const events: string[] = [];
let lastMetrics: { actualDt: number; dtLimitedBy: string; rejectsThisFrame?: number } | undefined;

while (state.time < T_END) {
  const res = sim.solver.advance(state, dt);
  state = res.state;
  lastMetrics = res.metrics as typeof lastMetrics;
  if (state.pendingEvents?.length) {
    for (const e of state.pendingEvents) {
      const line = `[EVENT t=${state.time.toFixed(1)}s] ${e.message}`;
      events.push(line);
      console.log(line);
    }
    state.pendingEvents = [];
  }
  if (state.time - lastLog >= 20) {
    lastLog = state.time;
    const fuel = state.thermalNodes.get('cb-1-fuel')!;
    const corium = state.thermalNodes.get('cb-1-corium')!;
    const head = state.thermalNodes.get('rv-1-lowerhead')!;
    const debris = state.thermalNodes.get('cb-1-corium-ex')!;
    const bui = state.flowNodes.get('bui-1')!;
    const ncg = bui.fluid.ncg;
    const wallSpeed = state.time / ((Date.now() - wall0) / 1000);
    console.log(
      `t=${state.time.toFixed(0).padStart(5)}s ` +
      `fuel=${(fuel.mass / 1000).toFixed(1)}t ` +
      `pool=${(corium.mass / 1000).toFixed(1)}t@${corium.temperature.toFixed(0)}K ` +
      `head=${(head.mass / 1000).toFixed(1)}t@${head.temperature.toFixed(0)}K(melt ${(meltFraction(head) * 100).toFixed(0)}%) ` +
      `debris=${(debris.mass / 1000).toFixed(1)}t@${debris.temperature.toFixed(0)}K ` +
      `[Zr ${((debris.metal?.zr ?? 0) / 1000).toFixed(2)}t Fe ${((debris.metal?.fe ?? 0) / 1000).toFixed(2)}t ` +
      `slag ${((debris.slagMass ?? 0) / 1000).toFixed(2)}t] ` +
      `eroded=${(basematErodedDepth(state, 'bui-1') * 100).toFixed(1)}cm ` +
      `bui[H2 ${ncg?.H2.toFixed(0)} CO ${ncg?.CO.toFixed(0)} CO2 ${ncg?.CO2.toFixed(0)} O2 ${ncg?.O2.toFixed(0)}mol] ` +
      `(${wallSpeed.toFixed(1)}x RT, dt=${((lastMetrics?.actualDt ?? 0) * 1000).toFixed(2)}ms by ${lastMetrics?.dtLimitedBy})`
    );
  }
}

// --- Checks ----------------------------------------------------------------
const debris = state.thermalNodes.get('cb-1-corium-ex')!;
const eroded = basematErodedDepth(state, 'bui-1');
const bui = state.flowNodes.get('bui-1')!;
const co2 = bui.fluid.ncg?.CO2 ?? 0;
const coPlusCo2 = (bui.fluid.ncg?.CO ?? 0) + co2;

const checks: Array<[string, boolean]> = [
  ['lower head melted through (event fired)', events.some(e => e.includes('melt') || e.includes('BREACH'))],
  [`corium poured ex-vessel (debris ${(debris.mass / 1000).toFixed(1)} t > 5 t)`, debris.mass > 5000],
  [`concrete eroded (${(eroded * 100).toFixed(1)} cm > 1 cm)`, eroded > 0.01],
  [`MCCI carbon gases in containment (CO+CO2 ${coPlusCo2.toFixed(0)} mol > 100)`, coPlusCo2 > 100],
  [`debris carries slag (${((debris.slagMass ?? 0) / 1000).toFixed(2)} t > 0)`, (debris.slagMass ?? 0) > 100],
];

console.log('\n=== MCCI chain checks ===');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) failed++;
}
process.exit(failed === 0 ? 0 : 1);
