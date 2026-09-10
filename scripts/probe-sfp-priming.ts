/**
 * Watch a dry wet-pit pump prime in the sea on level 1: casing pressure,
 * phase and mass, and the flows on its two lines, over the first minute.
 *
 *   npx tsx scripts/probe-sfp-priming.ts [x=236] [seconds=60] [dt=0.02]
 */
import * as fs from 'fs';
import { buildSimFromPlantJson, run, flowRate } from './lib/sim-harness';
import { getPresetById, getPipeSpecById, pipeSpecFlowArea } from '../src/construction/component-presets';
import { nodeLiquidLevelFraction, steamPartialPressurePa } from '../src/simulation';
import { totalMoles } from '../src/simulation/gas-properties';

const x = parseFloat(process.argv[2] || '236');
const seconds = parseFloat(process.argv[3] || '60');
const dt = parseFloat(process.argv[4] || '0.02');

const plant = JSON.parse(fs.readFileSync('src/game-mode/levels/spent-fuel-pool.json', 'utf-8'));
const preset = getPresetById('pump-service-water-lp')!.properties as Record<string, unknown>;
const area = pipeSpecFlowArea(getPipeSpecById('spec-12in-service')!);
const sea = plant.components.find((c: [string, unknown]) => c[0] === 'sea')[1];
const pool = plant.components.find((c: [string, unknown]) => c[0] === 'pool')[1];
const seaIntake = sea.height / 2 - sea.ports[0].position.y;
const poolPort = process.env.POOL_PORT ? parseFloat(process.env.POOL_PORT) : pool.depth / 2 - pool.ports.find((p: { id: string }) => p.id === 'pool-makeup-e').position.y;
const ratedFlow = preset.ratedFlow as number;
plant.components.push(['pmp', {
  id: 'pmp', type: 'pump', label: 'probe pump', position: { x, y: 75 }, rotation: 0, elevation: 0,
  diameter: 0.2 + Math.sqrt(ratedFlow / 1000) * 0.4, running: process.env.STOPPED ? false : true, speed: 1,
  ratedFlow, ratedHead: preset.ratedHead, orientation: 'left-right', npshRequired: preset.npshRequired,
  motorElevation: preset.motorElevation, initialFill: preset.initialFill, dischargeCheck: preset.dischargeCheck,
  ports: [
    { id: 'pmp-inlet', position: { x: -0.5, y: 0 }, direction: 'in' },
    { id: 'pmp-outlet', position: { x: 0.5, y: 0 }, direction: 'out' },
  ],
  fluid: { temperature: 288.15, pressure: 101325, phase: 'liquid', quality: 0, flowRate: 0 },
  pressureRating: preset.pressureRating,
}]);
plant.connections.push(
  { fromComponentId: 'sea', fromPortId: 'sea-out', toComponentId: 'pmp', toPortId: 'pmp-inlet',
    fromElevation: seaIntake, toElevation: -0.07, length: Math.max(10, x - 229), flowArea: area });
// OPEN_DISCHARGE=1 leaves the discharge nozzle with no line on it (the factory
// opens it to the air), to see how the casing fills when it is not dead-ended
if (!process.env.OPEN_DISCHARGE) {
  plant.connections.push(
    { fromComponentId: 'pmp', fromPortId: 'pmp-outlet', toComponentId: 'pool', toPortId: 'pool-makeup-e',
      fromElevation: 0.36, toElevation: poolPort, length: x - 54 + 12, flowArea: area });
}
plant.scenario = undefined;

const sim = buildSimFromPlantJson(plant);
const casing = () => sim.state.flowNodes.get('pmp')!;
const p = () => sim.state.components.pumps.get('pmp')!;
console.log(`pump at x=${x}: ground ${casing().groundHeight?.toFixed(2)} m, casing ${casing().volume.toFixed(2)} m3 x ${casing().height?.toFixed(2)} m tall, motor ${p().motorElevation.toFixed(2)} m`);
console.log('   t    P_casing  P_steam   ncg_mol  phase      liq%   mass   q_sea->pump  q_pump->pool  speed  flooded  maxP');
let maxP = 0;
let t = 0;
const step = Math.min(0.5, seconds / 40);
const startAt = process.env.START_AT ? parseFloat(process.env.START_AT) : -1;
let started = false;
while (t < seconds) {
  if (!started && startAt >= 0 && t >= startAt) {
    p().running = true;
    started = true;
    console.log(`  -- pump started at t=${t.toFixed(1)} s`);
  }
  run(sim, step, dt);
  t = sim.state.time;
  const c = casing();
  maxP = Math.max(maxP, c.fluid.pressure);
  const toPool = process.env.OPEN_DISCHARGE ? flowRate(sim.state, 'pmp', 'atmosphere') : flowRate(sim.state, 'pmp', 'pool');
  console.log(`${t.toFixed(1).padStart(6)}  ${(c.fluid.pressure / 1e5).toFixed(3).padStart(8)}  ${(steamPartialPressurePa(c) / 1e5).toFixed(3).padStart(7)}  ${(c.fluid.ncg ? totalMoles(c.fluid.ncg) : 0).toFixed(0).padStart(7)}  ${c.fluid.phase.padEnd(9)}  ${(100 * nodeLiquidLevelFraction(c)).toFixed(0).padStart(4)}  ${c.fluid.mass.toFixed(0).padStart(5)}  ${flowRate(sim.state, 'sea', 'pmp').toFixed(1).padStart(11)}  ${toPool.toFixed(1).padStart(12)}  ${p().effectiveSpeed.toFixed(2)}  ${p().flooded ? 'Y' : 'n'}        ${(maxP / 1e5).toFixed(2)}`);
}
const bursts = sim.state.burstStates ? [...sim.state.burstStates.values()].filter(b => (b as { burst?: boolean }).burst) : [];
console.log(`bursts: ${bursts.length}`);
