/**
 * Repro for a KNOWN, UNFIXED defect (found 2026-09-11): a small dry pump
 * casing breathing a SATURATED gas space hunts the dew point.
 *
 * A dry pump (ambient air, 20 C) stands on a shelf above a tank's water
 * surface with both nozzles in the tank's gas space (air saturated with steam
 * at 15 C). For ~13 s it takes in humid gas and cools - to 13.97 C, below
 * BOTH gases it is mixing, which no mixing can do - then breaks into an
 * oscillation, ~0.85 to 1.3 bar on a ~3 s cycle, two-phase at every low,
 * growing slowly. Three variants:
 *
 *   contained  - pump INSIDE the tank, nozzles opened into its gas space by
 *                the factory (openPumpPortsToAir)
 *   piped      - pump uncontained, two ORDINARY plant connections from the
 *                gas space at the same heights (pre-existing path; it also
 *                starts from a bad t=0 state and logs FluidState errors)
 *   atmosphere - pump uncontained, nozzles to the outside air (50% RH):
 *                steady at 1.0131 bar - the control
 *
 * contained and piped build identical lines and ring the same way, so the
 * defect is in the gas exchange with a saturated space, not in containment.
 *
 *   npx tsx scripts/probe-dry-pump-dewpoint.ts [contained|piped|atmosphere]
 */
import { buildSimFromPlantJson, run } from './lib/sim-harness';
import { saturationPressure } from '../src/simulation/water-properties';
import { ConstructionManager } from '../src/construction/construction-manager';
import type { PlantComponent, PlantState } from '../src/types';
import { getComponentVisualHeight } from '../src/render/components';
import { terrainHeightAt } from '../src/simulation/terrain';

const CELL = 10, COLS = 6, ROWS = 3;
const heights: number[] = [];
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) heights.push([6, 4, 2, 0.5, -1.5, -3][c]);
const terrain = {
  origin: { x: 0, y: 0 }, cellSize: CELL, cols: COLS, rows: ROWS, heights,
  infiltration: 1e-5, waters: [{ id: 'sea', seed: { x: 50, y: 10 }, surface: 0 }],
};
const T = 288.15;
const sea = {
  id: 'sea', type: 'tank', label: 'sea', position: { x: 50, y: 10 }, rotation: 0,
  elevation: 0, height: 6, width: 4, fillLevel: 0.5, pressureRating: 2, waterBody: 'sea',
  fluid: { temperature: T, pressure: saturationPressure(T), phase: 'two-phase', quality: 1e-4, flowRate: 0 },
  initialNcg: { N2: 0.79, O2: 0.21 },
  ports: [{ id: 'sea-bottom', position: { x: 0, y: 3 }, direction: 'both' }],
} as unknown as PlantComponent;

type Variant = 'contained' | 'atmosphere' | 'piped';

/**
 * contained  - the pump inside the sea, nozzles opened into its gas space by
 *              the factory (the new code path)
 * atmosphere - the pump uncontained, nozzles opened to the outside air
 * piped      - the pump uncontained, with two ORDINARY plant connections
 *              from the sea's gas space to its nozzles, at the same heights
 *              the contained variant uses: the pre-existing code path
 */
function probe(variant: Variant): void {
  const plant = { components: new Map(), connections: [], terrain } as unknown as PlantState;
  const cm = new ConstructionManager(plant);
  plant.components.set('sea', structuredClone(sea));
  const id = cm.createComponent({
    type: 'pump', name: 'dry', position: { x: 25, y: 10 },
    ...(variant === 'contained' ? { containedBy: 'sea' } : {}),
    properties: { name: 'dry', ratedFlow: 100, ratedHead: 15, elevation: 0, initialFill: 'dry' },
  } as any)!;
  const pump = plant.components.get(id)! as any;
  // Isolation switches for the piped variant: NO_MATCH=1 keeps the dry IC
  // (the factory's matchUpstream pass otherwise rebuilds the casing from the
  // sea's bulk fluid), NO_CHECK=1 takes the discharge check valve off
  if (process.env.NO_MATCH) pump.matchUpstream = false;
  if (process.env.NO_CHECK) pump.dischargeCheck = false;
  console.log(`(pump matchUpstream=${pump.matchUpstream} dischargeCheck=${pump.dischargeCheck} initialFill=${pump.initialFill})`);
  const connections: any[] = [];
  if (variant === 'piped') {
    const h = getComponentVisualHeight(pump);
    const nozzle = (port: { position: { y: number } }) => h / 2 - port.position.y;
    const pumpBase = terrainHeightAt(terrain as any, pump.position) + (pump.elevation ?? 0);
    const seaBase = terrainHeightAt(terrain as any, sea.position) + ((sea as any).elevation ?? 0);
    const inSea = (port: { position: { y: number } }) => pumpBase + nozzle(port) - seaBase;
    const area = Math.PI * Math.pow((pump.diameter || 0.3) / 2, 2);
    const [inlet, outlet] = pump.ports;
    connections.push(
      { fromComponentId: 'sea', fromPortId: 'sea-bottom', toComponentId: id, toPortId: inlet.id,
        fromElevation: inSea(inlet), toElevation: nozzle(inlet), flowArea: area, length: 1, resistanceCoeff: 1 },
      { fromComponentId: id, fromPortId: outlet.id, toComponentId: 'sea', toPortId: 'sea-bottom',
        fromElevation: nozzle(outlet), toElevation: inSea(outlet), flowArea: area, length: 1, resistanceCoeff: 1 },
    );
    console.log(`\n(piped: nozzles at ${nozzle(inlet).toFixed(3)} / ${nozzle(outlet).toFixed(3)} m on the pump, ` +
      `${inSea(inlet).toFixed(3)} / ${inSea(outlet).toFixed(3)} m up the sea node)`);
  }
  const sim = buildSimFromPlantJson({ components: Array.from(plant.components.entries()), connections, terrain });
  const node = () => sim.state.flowNodes.get(id)!;
  const seaNode = () => sim.state.flowNodes.get('sea')!;
  const p = sim.state.components.pumps.get(id)!;
  console.log(`\n=== dry pump: ${variant} - open ${p.openInlet ? 'suction ' : ''}${p.openOutlet ? 'discharge ' : ''}` +
    `into ${p.openInto ?? 'the air'}, running=${p.running}`);
  const lines = sim.state.flowConnections.filter(c => c.fromNodeId === id || c.toNodeId === id);
  for (const c of lines) {
    const a = c as any;
    console.log(`  line ${c.fromNodeId}->${c.toNodeId}: fromElev=${a.fromElevation} toElev=${a.toElevation} ` +
      `dz=${a.elevationChange} area=${c.flowArea}`);
  }
  let lo = Infinity, hi = -Infinity;
  for (let t = 0; t <= 30; t += 1) {
    if (t > 0) run(sim, 1, 0.02);
    const n = node();
    lo = Math.min(lo, n.fluid.pressure); hi = Math.max(hi, n.fluid.pressure);
    console.log(`t=${String(t).padStart(2)} s  casing ${(n.fluid.pressure / 1e5).toFixed(4)} bar ${n.fluid.phase} ` +
      `T=${(n.fluid.temperature - 273.15).toFixed(2)} C m=${(n.fluid.mass * 1000).toFixed(2)} g | ` +
      `sea ${(seaNode().fluid.pressure / 1e5).toFixed(4)} bar T=${(seaNode().fluid.temperature - 273.15).toFixed(2)} C`);
  }
  console.log(`casing pressure range over 30 s: ${(lo / 1e5).toFixed(4)} .. ${(hi / 1e5).toFixed(4)} bar`);
}

const only = process.argv[2] as Variant | undefined;
for (const v of ['contained', 'piped', 'atmosphere'] as Variant[]) {
  if (!only || only === v) probe(v);
}
