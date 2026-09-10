/**
 * The level-1 sea pump through the wave: built in the sea (dry, stopped),
 * drowned by the tsunami, started once the water is back down. Prints the
 * casing state and the two line flows around the start, and counts the
 * solver's sanity rejections, to see how it settles.
 *
 *   npx tsx scripts/probe-sfp-seapump.ts [x=236] [startAt=5100] [runTo=6300] [logEvery=30]
 */
import * as fs from 'fs';
import { buildSimFromPlantJson, run, flowRate } from './lib/sim-harness';
import { getPresetById, getPipeSpecById, pipeSpecFlowArea } from '../src/construction/component-presets';
import { nodeLiquidLevelFraction, steamPartialPressurePa } from '../src/simulation';

const x = parseFloat(process.argv[2] || '236');
const startAt = parseFloat(process.argv[3] || '5100');
const runTo = parseFloat(process.argv[4] || '6300');
const logEvery = parseFloat(process.argv[5] || '30');

const plant = JSON.parse(fs.readFileSync('src/game-mode/levels/spent-fuel-pool.json', 'utf-8'));
const preset = getPresetById('pump-service-water-lp')!.properties as Record<string, unknown>;
const area = pipeSpecFlowArea(getPipeSpecById('spec-12in-service')!);
const sea = plant.components.find((c: [string, unknown]) => c[0] === 'sea')[1];
const pool = plant.components.find((c: [string, unknown]) => c[0] === 'pool')[1];
const seaIntake = sea.height / 2 - sea.ports[0].position.y;
const poolPort = pool.depth / 2 - pool.ports.find((p: { id: string }) => p.id === 'pool-makeup-e').position.y;
const ratedFlow = preset.ratedFlow as number;
const diameter = 0.2 + Math.sqrt(ratedFlow / 1000) * 0.4;
const H = diameter * 1.3 * 2.2;
plant.components.push(['pmp', {
  id: 'pmp', type: 'pump', label: 'sea pump', position: { x, y: 75 }, rotation: 0, elevation: 0,
  diameter, running: false, speed: 1,
  ratedFlow, ratedHead: preset.ratedHead, orientation: 'left-right', npshRequired: preset.npshRequired,
  motorElevation: preset.motorElevation, initialFill: preset.initialFill, dischargeCheck: preset.dischargeCheck,
  ports: [
    { id: 'pmp-inlet', position: { x: 0, y: 0.55 }, direction: 'in' },
    { id: 'pmp-outlet', position: { x: 0.5, y: 0.12 }, direction: 'out' },
  ],
  fluid: { temperature: 288.15, pressure: 101325, phase: 'liquid', quality: 0, flowRate: 0 },
  pressureRating: preset.pressureRating,
}]);
plant.connections.push(
  { fromComponentId: 'sea', fromPortId: 'sea-out', toComponentId: 'pmp', toPortId: 'pmp-inlet',
    fromElevation: seaIntake, toElevation: H / 2 - 0.55, length: Math.max(10, x - 229), flowArea: area },
  { fromComponentId: 'pmp', fromPortId: 'pmp-outlet', toComponentId: 'pool', toPortId: 'pool-makeup-e',
    fromElevation: H / 2 - 0.12, toElevation: poolPort, length: x - 54 + 12, flowArea: area });

const sim = buildSimFromPlantJson(plant);
const casing = () => sim.state.flowNodes.get('pmp')!;
const p = () => sim.state.components.pumps.get('pmp')!;
let rejections = 0;
const origWarn = console.warn;
const origLog = console.log;
const count = (args: unknown[]) => { if (String(args[0]).includes('Sanity check failed')) rejections++; };
console.warn = (...args: unknown[]) => { count(args); };
console.log = (...args: unknown[]) => { count(args); };
const say = (s: string) => origLog(s);
say(`pump at x=${x}: ground ${casing().groundHeight?.toFixed(2)} m, casing ${casing().volume.toFixed(2)} m3 x ${casing().height?.toFixed(2)} m, motor ${p().motorElevation.toFixed(2)} m; start at ${startAt} s`);
say('     t   P_casing  P_steam  phase      liq%   q_sea->pump  q_pump->pool  speed  flooded  sea    rejections  dt');
let started = false;
let lastRej = 0;
let nextLog = 0;
while (sim.state.time < runTo) {
  const t = sim.state.time;
  if (!started && t >= startAt) { p().running = true; started = true; say(`  -- pump started at t=${t.toFixed(0)} s`); }
  const step = Math.min(logEvery, runTo - t);
  const before = performance.now();
  run(sim, step, 0.5);
  const wall = (performance.now() - before) / 1000;
  const c = casing();
  const seaSurface = sim.state.surfaceWater!.bodies.get('sea')!.surface;
  if (sim.state.time >= nextLog || rejections !== lastRej) {
    nextLog = sim.state.time + logEvery * 4;
    say(`${sim.state.time.toFixed(0).padStart(6)}  ${(c.fluid.pressure / 1e5).toFixed(3).padStart(8)}  ${(steamPartialPressurePa(c) / 1e5).toFixed(3).padStart(7)}  ${c.fluid.phase.padEnd(9)}  ${(100 * nodeLiquidLevelFraction(c)).toFixed(0).padStart(4)}  ${flowRate(sim.state, 'sea', 'pmp').toFixed(1).padStart(11)}  ${flowRate(sim.state, 'pmp', 'pool').toFixed(1).padStart(12)}  ${p().effectiveSpeed.toFixed(2)}  ${p().flooded ? 'Y' : 'n'}     ${seaSurface.toFixed(1).padStart(5)}   ${String(rejections - lastRej).padStart(6)} (${wall.toFixed(1)} s wall)`);
    lastRej = rejections;
  }
}
say(`total sanity rejections: ${rejections}`);
console.warn = origWarn; console.log = origLog;
