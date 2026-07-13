/**
 * Quick profiler: where does non-operator solver time go?
 * Runs a plant headless and prints the SolverProfile split
 * (cloneSimulationState vs operators vs everything else).
 *
 *   npx tsx scripts/clone-profile.ts [plant.json] [seconds]
 */
import { buildSimFromFile, run } from './lib/sim-harness';
import { getSolverProfile, resetSolverProfile } from '../src/simulation';
import { getCloneTimeAccumulator } from '../src/simulation/solver';

const plant = process.argv[2] || 'src/presets/pwr.json';
const seconds = parseFloat(process.argv[3] || '60');

const sim = buildSimFromFile(plant);
resetSolverProfile();
const wall0 = performance.now();
run(sim, seconds, 0.1);
const wall = performance.now() - wall0;

const p = getSolverProfile();
const cloneMs = getCloneTimeAccumulator(); // accumulates across the whole run (RK45 never resets it)
console.log(`\nplant=${plant} sim=${seconds}s wall=${(wall / 1000).toFixed(1)}s ` +
  `(${(seconds / (wall / 1000)).toFixed(2)}x RT)`);
console.log(`cloneState:  ${(cloneMs / 1000).toFixed(2)}s (${(100 * cloneMs / wall).toFixed(1)}%)`);
console.log(`cloneState (euler profile): ${(p.cloneStateTime / 1000).toFixed(2)}s`);
console.log(`operators:   ${(p.operatorApplyTime / 1000).toFixed(2)}s (${(100 * p.operatorApplyTime / wall).toFixed(1)}%)`);
console.log(`maxStableDt: ${(p.maxStableDtTime / 1000).toFixed(2)}s (${(100 * p.maxStableDtTime / wall).toFixed(1)}%)`);
console.log(`sanitize:    ${(p.sanitizeTime / 1000).toFixed(2)}s (${(100 * p.sanitizeTime / wall).toFixed(1)}%)`);
console.log(`(clone time overlaps operator time where constraints clone internally)`);
