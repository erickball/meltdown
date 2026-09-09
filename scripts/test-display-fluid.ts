/**
 * Display fluids: the two pressure conventions, and the frame they used to
 * kill.
 *
 * `Fluid.pressure` on a component is a TOTAL pressure when the per-frame sync
 * wrote it and a STEAM PARTIAL when the construction write-back or the
 * gas-fill display helper did (that is the initial-condition convention the
 * factory reads back). The renderer cannot tell them apart from the object
 * alone, so it used to subtract the NCG partial from whatever it was handed.
 * On a cold air-blanketed tank - 17 mbar of steam under a bar of air, which
 * is what a demineralised water tank IS - that gave a NEGATIVE steam
 * pressure, the steam tables threw mid-frame, and because the canvas armed
 * its next animation frame at the END of the drawing code the whole loop
 * stopped for the rest of the session. Career level 1 froze on a picture of
 * an intact pool while the simulation went on draining it.
 *
 * `Fluid.steamPressure` now says which pressure the fluid is carrying, and
 * these tests pin that every producer sets it and that the colour code comes
 * back with a number rather than a throw.
 *
 * Usage: npx tsx scripts/test-display-fluid.ts
 */

import * as fs from 'fs';
import { test, assert, report } from './lib/sim-harness';
import {
  massQualityToVolumeFraction, getFluidColor, getTwoPhaseColors,
  steamPressureOf, totalPressureOf, ncgPartialPressure,
} from '../src/render/colors';
import { ConstructionManager } from '../src/construction/construction-manager';
import {
  createSimulationFromPlant, setSimulationRandomSeed,
  writeSimulationStateToPlant, steamPartialPressurePa,
} from '../src/simulation';
import type { Fluid, PlantComponent, PlantState } from '../src/types';
import type { SimulationState } from '../src/simulation/types';

const LEVEL = 'src/game-mode/levels/spent-fuel-pool.json';

/** Every fluid a component carries for the renderer to draw. */
function displayFluids(plant: PlantState): Array<[string, Fluid]> {
  const out: Array<[string, Fluid]> = [];
  for (const [id, component] of plant.components) {
    const c = component as unknown as Record<string, Fluid | undefined>;
    for (const field of ['fluid', 'primaryFluid', 'secondaryFluid', 'shellFluid', 'annulusFluid', 'outsideBarrelFluid']) {
      const f = c[field];
      if (f && typeof f === 'object' && typeof f.pressure === 'number') out.push([`${id}.${field}`, f]);
    }
  }
  return out;
}

/**
 * Everything the renderer asks of a fluid that goes through the steam tables.
 * Throws exactly where a frame would have thrown.
 */
function drawFluid(fluid: Fluid): { alpha: number; color: string } {
  const alpha = massQualityToVolumeFraction(fluid.quality ?? 0.5, fluid.pressure, fluid);
  const color = getFluidColor(fluid);
  if (fluid.phase === 'two-phase') getTwoPhaseColors(fluid);
  return { alpha, color };
}

function loadLevelPlant(): PlantState {
  const data = JSON.parse(fs.readFileSync(LEVEL, 'utf-8'));
  const plant: PlantState = {
    components: new Map<string, PlantComponent>(data.components),
    connections: data.connections ?? [],
    terrain: data.terrain,
    scenario: data.scenario,
  } as PlantState;
  return plant;
}

// ---------------------------------------------------------------------------
// 1. The construction-mode gas fill (ConstructionManager.normalizeLoadedPlant)
// ---------------------------------------------------------------------------

test('a loaded plant\'s display fluids all state their steam pressure', () => {
  const plant = loadLevelPlant();
  // normalizeLoadedPlant clears nothing; a ConstructionManager wired to this
  // plant would, so hand it the components afterwards the way main.ts does
  const manager = new ConstructionManager(plant);
  for (const [id, component] of loadLevelPlant().components) plant.components.set(id, component);
  manager.normalizeLoadedPlant();

  const fluids = displayFluids(plant);
  assert(fluids.length >= 4, `expected the level's four vessels, got ${fluids.length}`);
  let withGas = 0;
  for (const [where, fluid] of fluids) {
    if (!fluid.ncg) continue;
    withGas++;
    assert(fluid.steamPressure !== undefined,
      `${where}: the gas fill stamped NCG but left the pressure unlabelled`);
    assert(steamPressureOf(fluid) > 0, `${where}: steam pressure ${steamPressureOf(fluid)} Pa`);
    assert(totalPressureOf(fluid) > steamPressureOf(fluid),
      `${where}: a fluid carrying gas must have a total above its steam pressure`);
  }
  assert(withGas >= 4, `expected air over the pool, both tanks and the sea; got ${withGas}`);
});

test('a loaded plant draws without leaving the steam tables', () => {
  const plant = loadLevelPlant();
  const manager = new ConstructionManager(plant);
  for (const [id, component] of loadLevelPlant().components) plant.components.set(id, component);
  manager.normalizeLoadedPlant();

  for (const [where, fluid] of displayFluids(plant)) {
    const { alpha, color } = drawFluid(fluid);
    assert(Number.isFinite(alpha) && alpha >= 0 && alpha <= 1,
      `${where}: vapour volume fraction ${alpha}`);
    assert(/^rgba?\(/.test(color), `${where}: colour ${color}`);
  }
});

// ---------------------------------------------------------------------------
// 2. The write-back (entering construction mode / starting a live edit)
// ---------------------------------------------------------------------------

test('the write-back labels its steam pressure and still draws', () => {
  const plant = loadLevelPlant();
  setSimulationRandomSeed(0);
  const sim: SimulationState = createSimulationFromPlant(plant);
  writeSimulationStateToPlant(sim, plant);

  let checked = 0;
  for (const [where, fluid] of displayFluids(plant)) {
    if (!fluid.ncg) continue;
    checked++;
    assert(fluid.steamPressure !== undefined, `${where}: write-back left the pressure unlabelled`);
    assert(steamPressureOf(fluid) > 0, `${where}: steam pressure ${steamPressureOf(fluid)} Pa`);
    const { alpha } = drawFluid(fluid);
    assert(Number.isFinite(alpha) && alpha >= 0 && alpha <= 1, `${where}: vapour fraction ${alpha}`);
  }
  assert(checked >= 4, `expected four gas-bearing fluids after write-back, got ${checked}`);
});

// ---------------------------------------------------------------------------
// 3. The per-frame sync convention: pressure is the TOTAL, and the two agree
// ---------------------------------------------------------------------------

test('a synced fluid reconstructs its node total from steam + gas', () => {
  const plant = loadLevelPlant();
  setSimulationRandomSeed(0);
  const sim: SimulationState = createSimulationFromPlant(plant);

  let checked = 0;
  for (const [id, node] of sim.flowNodes) {
    if (!node.fluid.ncg) continue;
    // What syncSimulationToVisuals writes
    const displayed: Fluid = {
      temperature: node.fluid.temperature,
      pressure: node.fluid.pressure,
      steamPressure: steamPartialPressurePa(node),
      phase: node.fluid.phase,
      quality: node.fluid.quality,
      flowRate: 0,
      ncg: node.fluid.ncg,
      volume: node.volume,
    };
    checked++;
    const total = totalPressureOf(displayed);
    assert(Math.abs(total - node.fluid.pressure) < 1e-6 * Math.max(1, node.fluid.pressure),
      `${id}: steam ${steamPressureOf(displayed).toFixed(0)} + gas ${ncgPartialPressure(displayed).toFixed(0)} ` +
      `= ${total.toFixed(0)} Pa, but the node is at ${node.fluid.pressure.toFixed(0)} Pa`);
    const { alpha } = drawFluid(displayed);
    assert(Number.isFinite(alpha), `${id}: vapour fraction ${alpha}`);
  }
  assert(checked >= 4, `expected gas-bearing nodes in the level, got ${checked}`);
});

// ---------------------------------------------------------------------------
// 4. The exact fluid that took the canvas down
// ---------------------------------------------------------------------------

test('17 mbar of steam under a bar of air draws instead of throwing', () => {
  // A demineralised water tank at 15 C: the steam pressure is its saturation
  // pressure and the air above it is at atmospheric. Read as a TOTAL, the
  // steam pressure comes out at -0.98 bar.
  const V = 1;
  const T = 288.15;
  const R = 8.314;
  const airMoles = (1.0e5 * V) / (R * T);
  const fluid: Fluid = {
    temperature: T,
    pressure: 1706,
    steamPressure: 1706,
    phase: 'two-phase',
    quality: 1e-4,
    flowRate: 0,
    volume: V,
    ncg: { N2: airMoles * 0.79, O2: airMoles * 0.21, H2: 0, He: 0, CO: 0, CO2: 0, Xe: 0, Ar: 0, CsI: 0 },
  };
  assert(Math.abs(steamPressureOf(fluid) - 1706) < 1e-9, 'the label is the steam pressure');
  // (the gas constant here is the full CODATA value, not the 8.314 above)
  assert(Math.abs(totalPressureOf(fluid) - (1706 + 1.0e5)) < 20,
    `total ${totalPressureOf(fluid).toFixed(0)} Pa, expected ~101706`);
  const { alpha, color } = drawFluid(fluid);
  assert(Number.isFinite(alpha) && alpha > 0 && alpha < 1, `vapour volume fraction ${alpha}`);
  assert(/^rgba?\(/.test(color), `colour ${color}`);
});

// ---------------------------------------------------------------------------
// 5. The one component that stores a TOTAL: a building
// ---------------------------------------------------------------------------

test('a containment keeps its total pressure and states the steam left in it', () => {
  const data = JSON.parse(fs.readFileSync('src/presets/pwr.json', 'utf-8'));
  const plant: PlantState = {
    components: new Map<string, PlantComponent>(data.components),
    connections: data.connections ?? [],
  } as PlantState;
  const manager = new ConstructionManager(plant);
  for (const [id, component] of new Map<string, PlantComponent>(data.components)) plant.components.set(id, component);
  manager.normalizeLoadedPlant();

  const building = Array.from(plant.components.values()).find(c => c.type === 'building') as
    { fluid?: Fluid } | undefined;
  assert(!!building?.fluid, 'the PWR preset should carry a containment with a fluid');
  const f = building!.fluid!;
  // A building's fluid.pressure IS the total: the factory subtracts the NCG
  // spec from it, so the display must too rather than adding the air twice.
  assert(f.steamPressure !== undefined, 'the containment fluid is unlabelled');
  assert(steamPressureOf(f) < f.pressure,
    `containment steam ${steamPressureOf(f).toFixed(0)} Pa should be below its total ${f.pressure.toFixed(0)} Pa`);
  assert(Math.abs(totalPressureOf(f) - f.pressure) < 0.02 * f.pressure,
    `containment total reads ${totalPressureOf(f).toFixed(0)} Pa, stored ${f.pressure.toFixed(0)} Pa`);
  const { alpha } = drawFluid(f);
  assert(Number.isFinite(alpha), `containment vapour fraction ${alpha}`);
});

report('Display fluids');
