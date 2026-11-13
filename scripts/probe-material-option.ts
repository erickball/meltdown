// Build a pipe and a tank in each structural material through the
// construction path, then print the wall the factory heats and bursts.
// npx tsx scripts/probe-material-option.ts
import { ConstructionManager } from '../src/construction/construction-manager';
import { createSimulationFromPlant } from '../src/simulation/factory';
import { MATERIALS } from '../src/simulation/materials';
import { estimatePlantComponentCost } from '../src/construction/cost-estimation';
import type { PlantState } from '../src/types';

const log = console.log;
console.log = () => {};
const plant: PlantState = { components: new Map(), connections: [], simTime: 0, simSpeed: 1, isPaused: true };
const m = new ConstructionManager(plant);
const ids: string[] = [];
let x = 0;
for (const material of Object.keys(MATERIALS)) {
  ids.push(m.createComponent({ type: 'pipe', name: `pipe ${material}`, position: { x, y: 0 },
    properties: { diameter: 0.5, length: 10, pressureRating: 155, nqa1: false, material, initialPressure: 1, initialTemperature: 20 } })!);
  ids.push(m.createComponent({ type: 'tank', name: `tank ${material}`, position: { x, y: 20 },
    properties: { volume: 10, height: 4, diameter: 1.78, pressureRating: 20, nqa1: false, material, initialPressure: 1, initialTemperature: 20, initialLevel: 50 } })!);
  x += 30;
}
// Edit path: switch the first pipe to 800H after it was built
m.updateComponent(ids[0], { material: 'alloy-800h' });
(plant.components.get(ids[0]) as any).label += ' -> 800h';
const sim = createSimulationFromPlant(plant) as any;
console.log = log;
const bursts = sim.burstStates instanceof Map ? sim.burstStates : new Map(Object.entries(sim.burstStates ?? {}));
for (const id of ids) {
  const c = plant.components.get(id) as any;
  const b = bursts.get(id) as any;
  const cost = estimatePlantComponentCost(c)?.total ?? 0;
  log(`${c.label.padEnd(30)} stored=${String(c.material).padEnd(16)} wall=${c.thickness !== undefined ? (c.thickness * 1000).toFixed(1) + ' mm' : '(sized)'}` +
    ` burst=${b ? (b.burstPressure / 1e5).toFixed(0) : '?'} bar (${b?.material}) cost=$${(cost / 1e3).toFixed(0)}k`);
}
