/**
 * A pipe from the placement dialog is built from its two ends.
 *
 * The dialog sends a new pipe as its start (the placement position), its far
 * end as a plan offset from the start (`endOffset`), a rise
 * (`elevationChange`) and the distance between the ends (`length`). This
 * drives ConstructionManager.createComponent the way the dialog's confirm
 * does and checks that:
 *   - the pipe's ends, elevations, length and outlet port come from the offset
 *   - the length is derived when not given
 *   - a length that contradicts the ends, or an offset alongside a drawn
 *     route, fails loudly
 *   - without an offset the pipe still runs east by its length
 *
 * Usage: npx tsx scripts/test-pipe-endpoints.ts
 */

import { ConstructionManager } from '../src/construction/construction-manager';
import type { PlantState, PlantComponent, PipeComponent } from '../src/types';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}
function near(a: number | undefined, b: number): boolean {
  return a !== undefined && Math.abs(a - b) < 1e-9;
}

function emptyPlant(): PlantState {
  return {
    components: new Map<string, PlantComponent>(), connections: [],
    simTime: 0, simSpeed: 1, isPaused: true,
  } as PlantState;
}

function pipeProps(extra: Record<string, any>): Record<string, any> {
  return {
    name: 'P', diameter: 0.3, pressureRating: 16, elevation: 0.15,
    initialPhase: 'liquid', initialPressure: 1, initialTemperature: 25,
    ...extra,
  };
}

function place(extra: Record<string, any>): PipeComponent {
  const plant = emptyPlant();
  const cm = new ConstructionManager(plant);
  const id = cm.createComponent({
    type: 'pipe', name: 'P', position: { x: 5, y: -2 }, properties: pipeProps(extra),
  });
  if (!id) throw new Error('createComponent returned no id');
  return plant.components.get(id) as PipeComponent;
}

function throws(fn: () => unknown): boolean {
  try { fn(); } catch { return true; }
  return false;
}

console.log('\n=== Pipe built from its ends ===\n');

{
  // 3-4-5 in plan, 12 up: 13 m between the ends
  const pipe = place({ endOffset: { x: 3, y: 4 }, elevationChange: 12, length: 13 });
  check('start is the placement position', near(pipe.position.x, 5) && near(pipe.position.y, -2),
    JSON.stringify(pipe.position));
  check('end is the start plus the offset', near(pipe.endPosition?.x, 8) && near(pipe.endPosition?.y, 2),
    JSON.stringify(pipe.endPosition));
  check('start elevation as given', near(pipe.elevation, 0.15), String(pipe.elevation));
  check('end elevation is start plus the rise', near(pipe.endElevation, 12.15), String(pipe.endElevation));
  check('length is the distance between the ends', near(pipe.length, 13), String(pipe.length));
  const right = pipe.ports.find(p => p.id.endsWith('-right'));
  check('outlet port sits at the length', near(right?.position.x, 13), JSON.stringify(right?.position));
}

{
  const pipe = place({ endOffset: { x: 0, y: -7 } });
  check('length derived when not given', near(pipe.length, 7), String(pipe.length));
  check('end runs south when the offset says so',
    near(pipe.endPosition?.x, 5) && near(pipe.endPosition?.y, -9), JSON.stringify(pipe.endPosition));
}

check('a length that contradicts the ends throws',
  throws(() => place({ endOffset: { x: 3, y: 4 }, length: 10 })));
check('ends at the same point throw',
  throws(() => place({ endOffset: { x: 0, y: 0 }, elevationChange: 0 })));
check('an offset alongside a drawn route throws',
  throws(() => place({ endOffset: { x: 3, y: 4 }, route: [{ x: 5, y: -2 }, { x: 9, y: -2 }] })));

{
  const pipe = place({ length: 6 });
  check('without an offset the pipe runs east by its length',
    near(pipe.endPosition?.x, 11) && near(pipe.endPosition?.y, -2) && near(pipe.length, 6),
    `${JSON.stringify(pipe.endPosition)}, length ${pipe.length}`);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} pipe-endpoint check(s) FAILED`);
  process.exit(1);
}
console.log('All pipe-endpoint checks passed');
