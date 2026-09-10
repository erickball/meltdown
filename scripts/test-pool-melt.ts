/**
 * Spent-fuel racks melt and relocate (CAR XCmawu8J0DjvuAS2mFc0: a drained
 * pool's racks heated almost adiabatically to 4759 C and took the pool gas
 * past the steam tables' 5000 K top, because nothing ever took their heat).
 *
 * Racks that melt now slump straight onto the pool floor - there is no
 * vessel in between - into a debris bed that McciRateOperator sets against
 * the floor slab, the same pair of nodes a core gets once its lower head has
 * gone. And a state saved before relocation was wired explicitly
 * (relocatesTo / meltLocations) is rewired on load, so old saves keep
 * relocating their cores.
 *
 *   npx tsx scripts/test-pool-melt.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, assert, report, buildSimFromPlantJson, run } from './lib/sim-harness';
import { wireSavedRelocation } from '../src/simulation/operators/corium';
import { meltFraction } from '../src/simulation/operators/rate-operators';
import type { SimulationState, ThermalNode } from '../src/simulation/types';

// Run from the repo root, as npm test does
const fixture = JSON.parse(fs.readFileSync(path.resolve('scripts', 'test-plants', 'pool-level1.json'), 'utf-8'));

/** Level 1's pool alone, drained, its racks already at `rackK`, vented to the air. */
function drainedPool(rackK: number) {
  const comps = new Map<string, any>(fixture.components);
  const pool = { ...comps.get('pool') };
  pool.fillLevel = 0.001;
  pool.rackTemperature = rackK;
  pool.fluid = { ...pool.fluid, temperature: 330, pressure: 2000, phase: 'two-phase', quality: 0.5 };
  return buildSimFromPlantJson({
    components: [['pool', pool]],
    connections: fixture.connections.filter((c: any) => c.fromComponentId === 'pool' && c.toComponentId === 'atmosphere'),
  } as any);
}

test('Molten rack cladding slumps onto the pool floor and attacks the slab', () => {
  const sim = drainedPool(2750);
  const s0 = sim.state;
  const clad0 = s0.thermalNodes.get('pool-clad')!;
  const pellets0 = s0.thermalNodes.get('pool-pellets')!;
  assert(clad0.relocatesTo === 'pool-corium-ex', `clad should relocate to the floor debris bed, got ${clad0.relocatesTo}`);
  assert(pellets0.relocatesTo === 'pool-corium-ex', `pellets should relocate to the floor debris bed, got ${pellets0.relocatesTo}`);
  assert(pellets0.meltLocations?.some(l => l.nodeId === 'pool-corium-ex' && l.releaseTo === 'pool') === true,
    'decay heat and fission products should follow the fuel onto the floor');
  assert(meltFraction(clad0) > 0.5, `clad at 2750 K should be well molten (melt fraction ${meltFraction(clad0).toFixed(2)})`);
  const cladMass0 = clad0.mass;
  const slab0 = s0.thermalNodes.get('pool-basemat')!.mass;

  let hottestSolid = 0;
  let gasMax = 0;
  run(sim, 1800, 0.5, (st) => {
    const solids = ['pool-pellets', 'pool-clad', 'pool-corium-ex'].map(id => st.thermalNodes.get(id)!.temperature);
    hottestSolid = Math.max(hottestSolid, ...solids);
    gasMax = Math.max(gasMax, st.flowNodes.get('pool')!.fluid.temperature);
  });

  const st = sim.state;
  const clad = st.thermalNodes.get('pool-clad')!;
  const debris = st.thermalNodes.get('pool-corium-ex')!;
  const slab = st.thermalNodes.get('pool-basemat')!;
  const relocated = cladMass0 - clad.mass;
  console.log(`    after 30 min: clad ${(clad.mass / 1e3).toFixed(1)} of ${(cladMass0 / 1e3).toFixed(1)} t, ` +
    `debris ${(debris.mass / 1e3).toFixed(1)} t at ${(debris.temperature - 273.15).toFixed(0)} C ` +
    `(Zr ${((debris.metal?.zr ?? 0) / 1e3).toFixed(1)} t, slag ${((debris.slagMass ?? 0) / 1e3).toFixed(2)} t), ` +
    `slab eroded ${((slab0 - slab.mass) / 1e3).toFixed(2)} t, gas peak ${(gasMax - 273.15).toFixed(0)} C`);

  assert(relocated > 0.5 * cladMass0, `most of the molten clad should have slumped (${(relocated / 1e3).toFixed(1)} t moved)`);
  assert(debris.mass > 0.9 * relocated, `the floor should hold what left the racks (${(debris.mass / 1e3).toFixed(1)} t)`);
  assert((debris.metal?.zr ?? 0) > 0, 'relocating clad carries its unoxidized zirconium to the floor');
  assert(slab.mass < slab0, 'hot debris on the floor ablates the slab');
  assert(gasMax <= hottestSolid, `the pool gas (${gasMax.toFixed(0)} K) cannot be hotter than the hottest solid heating it (${hottestSolid.toFixed(0)} K)`);
});

test('A save from before explicit relocation wiring keeps relocating its core', () => {
  const node = (id: string, extra: Partial<ThermalNode> = {}): ThermalNode => ({
    id, label: id, temperature: 600, mass: 1000, specificHeat: 300, thermalConductivity: 3,
    characteristicLength: 0.01, surfaceArea: 1, heatGeneration: 0, maxTemperature: 3000, ...extra,
  });
  const state = {
    thermalNodes: new Map<string, ThermalNode>([
      ['core-fuel', node('core-fuel')],
      ['core-clad', node('core-clad')],
      ['core-corium', node('core-corium', { associatedVesselNode: 'rv' })],
      ['core-corium-ex', node('core-corium-ex', { associatedVesselNode: 'bldg' })],
    ]),
  } as unknown as SimulationState;
  wireSavedRelocation(state);
  const fuel = state.thermalNodes.get('core-fuel')!;
  assert(fuel.relocatesTo === 'core-corium', `fuel -> ${fuel.relocatesTo}`);
  assert(state.thermalNodes.get('core-clad')!.relocatesTo === 'core-corium', 'clad -> in-vessel pool');
  assert(JSON.stringify(fuel.meltLocations) ===
    JSON.stringify([{ nodeId: 'core-corium' }, { nodeId: 'core-corium-ex', releaseTo: 'bldg' }]),
    `melt locations ${JSON.stringify(fuel.meltLocations)}`);
});

report('Pool melt and relocation');
