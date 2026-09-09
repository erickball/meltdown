/**
 * Unfed spent-fuel-pool run: nobody touches anything, the liner tears, the
 * pool boils dry and the racks are left standing in air. Prints the whole
 * trajectory - level, clad temperature, the oxidation power against the
 * decay power, the oxygen left in the pool, and what has reached the
 * environment.
 *
 *   npx tsx scripts/probe-sfp-fire.ts [simSeconds] [dt] [reportEvery]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import { nodeLiquidLevel } from '../src/simulation';
import { getCladdingOxidationPower } from '../src/simulation/operators/rate-operators';

const FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'game-mode', 'levels', 'spent-fuel-pool.json');

const seconds = process.argv[2] ? parseFloat(process.argv[2]) : 60000;
const dt = process.argv[3] ? parseFloat(process.argv[3]) : 0.5;
const every = process.argv[4] ? parseFloat(process.argv[4]) : 600;

const sim = buildSimFromFile(FILE);
const pool = () => sim.state.flowNodes.get('pool')!;
const clad = () => sim.state.thermalNodes.get('pool-clad')!;
const fuel = () => sim.state.thermalNodes.get('pool-pellets')!;

const from = process.argv[5] ? parseFloat(process.argv[5]) : 0;
console.log('     t/s  level/m  Twater/C   Tclad/C  Tfuel/C   O2/mol  ' +
  'oxPower/MW  ZrOx/%      mass/kg      P/bar   ncg/mol  vent/kg/s break/kg/s   sev');

let next = 0;
try {
  while (sim.state.time < seconds) {
    run(sim, Math.min(60, seconds - sim.state.time), dt);
    sim.state.pendingEvents = [];
    if (sim.state.time >= next && sim.state.time >= from) {
      next = sim.state.time + every;
      const p = pool();
      const oxP = getCladdingOxidationPower().get('pool-clad') ?? 0;
      const rel = sim.state.environmentalRelease as Record<string, number> | undefined;
      const xe = rel?.Xe ?? 0, csi = rel?.CsI ?? 0;
      console.log(
        `${sim.state.time.toFixed(0).padStart(8)} ${nodeLiquidLevel(p).toFixed(2).padStart(8)} ` +
        `${(p.fluid.temperature - 273.15).toFixed(1).padStart(9)} ` +
        `${(clad().temperature - 273.15).toFixed(1).padStart(9)} ` +
        `${(fuel().temperature - 273.15).toFixed(1).padStart(8)} ` +
        `${(p.fluid.ncg?.O2 ?? 0).toFixed(0).padStart(8)} ` +
        `${(oxP / 1e6).toFixed(3).padStart(11)} ` +
        `${((clad().oxidation?.oxidizedFraction ?? 0) * 100).toFixed(2).padStart(7)} ` +
        `${p.fluid.mass.toExponential(3).padStart(12)} ` +
        `${(p.fluid.pressure / 1e5).toFixed(4).padStart(10)} ` +
        `${Object.values(p.fluid.ncg ?? {}).reduce((a: number, b) => a + (b as number), 0).toFixed(0).padStart(9)} ` +
        `${(sim.state.flowConnections.find(c => c.id === 'flow-pool-atmosphere')?.massFlowRate ?? 0).toFixed(3).padStart(10)} ` +
        `${(sim.state.flowConnections.find(c => c.id === 'break-pool')?.massFlowRate ?? 0).toFixed(3).padStart(10)} ` +
        `${(60 * csi + 0.02 * xe).toExponential(2).padStart(9)}`);
    }
  }
} catch (err) {
  console.log((err as Error).stack);
  console.log(`\nSTOPPED at t=${sim.state.time.toFixed(1)} s: ${err}`);
}
