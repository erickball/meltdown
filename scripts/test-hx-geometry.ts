/**
 * Heat-exchanger geometry the simulation builds from:
 *  - tube-side volume is the bore over the real tube length (hxTubeLength,
 *    the length the area and friction use), not 2 x shell height at the OD;
 *  - the shell side is the shell cylinder less the tubes' displacement;
 *  - a horizontal shell gives the same exchanger as a vertical one;
 *  - an exchanger built in construction mode carries its real tube count
 *    (it used to reach the simulation as 5 tubes), and a save from before
 *    that is migrated.
 */
import { test, assert, report, buildSimFromPlantJson } from './lib/sim-harness';
import { ConstructionManager } from '../src/construction/construction-manager';
import { deserializePlantDesign } from '../src/simulation/serialization';
import { hxTubeLength, hxBundleCount } from '../src/simulation/hx-bundles';
import { hxTubeWall } from '../src/simulation/wall-sizing';
import type { PlantState, PlantComponent } from '../src/types';

const SG = { name: 'SG', hxType: 'utube', orientation: 'vertical', elevation: 2, shellDiameter: 4.5,
  shellLength: 13, plenumLength: 1.5, tubeCount: 6500, tubeOD: 19, tubePressure: 175, shellPressure: 90 };

function build(props: Record<string, unknown>) {
  const plant = { components: new Map(), connections: [] } as unknown as PlantState;
  const cm = new ConstructionManager(plant);
  const id = cm.createComponent({ type: 'heat-exchanger', name: 'SG', position: { x: 10, y: 10 }, properties: props })!;
  const comp = plant.components.get(id) as any;
  const sim = buildSimFromPlantJson({ components: Array.from(plant.components.entries()), connections: [] });
  return { id, comp, plant, tube: sim.state.flowNodes.get(`${id}-tube`)!, shell: sim.state.flowNodes.get(`${id}-shell`)! };
}

const close = (a: number, b: number, rel: number) => Math.abs(a - b) <= rel * Math.abs(b);

test('construction-built SG carries its real tube count into the simulation', () => {
  const { comp, tube } = build(SG);
  assert(comp.tubeCount === 6500, `component tubeCount ${comp.tubeCount}, expected 6500`);
  const bore = 0.019 - 2 * hxTubeWall(comp, 0.019);
  const expected = 6500 * Math.PI * bore * bore / 4 * hxTubeLength(comp);
  assert(close(tube.volume, expected, 1e-9), `tube volume ${tube.volume.toFixed(3)} vs ${expected.toFixed(3)} m3`);
  assert(close(tube.flowArea, 6500 * Math.PI * bore * bore / 4, 1e-9), `tube flow area ${tube.flowArea}`);
});

test('tube volume follows the tube length: a helical coil holds far more than 2 x shell height', () => {
  for (const hxType of ['utube', 'straight', 'helical']) {
    const { comp, tube } = build({ ...SG, hxType, tubeCount: 300, shellDiameter: 2.8, shellLength: 14 });
    const bore = 0.019 - 2 * hxTubeWall(comp, 0.019);
    const L = hxTubeLength(comp);
    const expected = 300 * Math.PI * bore * bore / 4 * L / hxBundleCount(comp);
    assert(close(tube.volume, expected, 1e-9), `${hxType}: tube volume ${tube.volume.toFixed(3)} vs ${expected.toFixed(3)} m3`);
    if (hxType === 'helical') assert(L > 5 * 14, `helical tube length ${L.toFixed(1)} m should be many shell lengths`);
  }
});

test('shell side = shell cylinder less tube displacement', () => {
  const { comp, shell } = build(SG);
  const displaced = 6500 * Math.PI * 0.019 * 0.019 / 4 * hxTubeLength(comp);
  const expected = Math.PI * 4.5 * 4.5 / 4 * 13 - displaced;
  assert(close(shell.volume, expected, 1e-9), `shell volume ${shell.volume.toFixed(2)} vs ${expected.toFixed(2)} m3`);
});

test('a horizontal shell is the same exchanger as a vertical one', () => {
  const v = build(SG), h = build({ ...SG, orientation: 'horizontal' });
  assert(h.comp.width === 13 && h.comp.height === 4.5, `horizontal footprint ${h.comp.width} x ${h.comp.height}`);
  for (const k of ['volume', 'flowArea'] as const) {
    assert(close(h.tube[k], v.tube[k], 1e-12), `tube ${k}: horizontal ${h.tube[k]} vs vertical ${v.tube[k]}`);
    assert(close(h.shell[k], v.shell[k], 1e-12), `shell ${k}: horizontal ${h.shell[k]} vs vertical ${v.shell[k]}`);
  }
});

test('a save with the old visual tube count is migrated on load and on build', () => {
  const { id, comp, tube } = build(SG);
  const legacy = { ...comp, tubeCount: 5, realTubeCount: 6500 } as PlantComponent;
  const loaded = deserializePlantDesign({ components: [[id, legacy]], connections: [] });
  const c = loaded.components.get(id) as any;
  assert(c.tubeCount === 6500 && c.realTubeCount === undefined,
    `loaded tubeCount ${c.tubeCount}, realTubeCount ${c.realTubeCount}`);
  const sim = buildSimFromPlantJson({ components: [[id, { ...comp, tubeCount: 5, realTubeCount: 6500 }]], connections: [] });
  assert(close(sim.state.flowNodes.get(`${id}-tube`)!.volume, tube.volume, 1e-12), 'factory migrates a legacy component too');
});

report('HX geometry');
