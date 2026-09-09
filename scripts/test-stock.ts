/**
 * Warehouse stock regression test.
 *
 * Drives the SAME functions the UI drives - ConstructionManager for placing,
 * connecting and deleting, src/game/stock.ts for the connection-length edit
 * that main.ts performs in the dialog callback - with no DOM anywhere, and
 * asserts the contract in docs/warehouse-stock.md:
 *
 *   - a plant with no warehouse is unlimited and behaves exactly as before
 *   - what is already standing when the warehouse appears is not charged
 *   - placing spends, deleting refunds, and a refusal changes nothing
 *   - a connection costs its length; an edit pays or refunds the difference
 *   - an auto-pipe costs the pipe it lays, once
 *   - stock survives a save/load round trip
 *   - stock can never go negative: spending past a refusal throws
 *   - a DESIGN line hands out exactly that design: placing from it stamps the
 *     design on the component, the wrong design is refused, and the refund
 *     goes back to the line the part came out of
 *   - a yard that names a pipe spec exposes it to the connection dialog
 *
 * Usage: npx tsx scripts/test-stock.ts
 */

import { ConstructionManager } from '../src/construction/construction-manager';
import {
  getStock, pipeMetersRemaining, componentsRemaining, findWarehouse,
  chargeForPipe, chargeForComponent, checkCharge, spend,
  applyConnectionLengthEdit, stockedPipeSpecId, paletteKeyForStockLine,
  stockLineDisplayName, findStockLine,
} from '../src/game/stock';
import type { PlantState, PlantComponent, Connection } from '../src/types';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}
function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function emptyPlant(): PlantState {
  return {
    components: new Map<string, PlantComponent>(), connections: [],
    simTime: 0, simSpeed: 1, isPaused: true,
  } as PlantState;
}

function tankProps(name: string): Record<string, any> {
  return {
    name, volume: 10, height: 3, initialLevel: 50,
    initialTemperature: 25, initialPressure: 1, elevation: 0, pressureRating: 10,
  };
}

console.log('\n=== Warehouse stock ===\n');

// ---------------------------------------------------------------------------
// 1. No warehouse: unlimited
// ---------------------------------------------------------------------------
console.log('--- A plant with no warehouse is unlimited ---');
{
  const plant = emptyPlant();
  const cm = new ConstructionManager(plant);
  check('getStock is null', getStock(plant) === null);
  check('pipeMetersRemaining is null', pipeMetersRemaining(plant) === null);
  check('componentsRemaining is null', componentsRemaining(plant, 'pump') === null);

  let placed = 0;
  for (let i = 0; i < 5; i++) {
    const id = cm.createComponent({
      type: 'pump', name: `P${i}`, position: { x: 10 * i, y: 0 },
      properties: { name: `P${i}`, ratedFlow: 100, ratedHead: 50, elevation: 0 },
    });
    if (id) placed++;
  }
  check('five pumps place with no warehouse', placed === 5, `${placed} placed`);
  check('a huge charge is affordable',
    checkCharge(plant, chargeForPipe(1e9)).ok);
}

// ---------------------------------------------------------------------------
// 2. The level fixture: two tanks already standing, then a warehouse
// ---------------------------------------------------------------------------
console.log('\n--- 100 m of pipe and one pump in the yard ---');
const plant = emptyPlant();
const cm = new ConstructionManager(plant);

const tankA = cm.createComponent({
  type: 'tank', name: 'Tank A', position: { x: 0, y: 0 }, properties: tankProps('Tank A'),
})!;
const tankB = cm.createComponent({
  type: 'tank', name: 'Tank B', position: { x: 40, y: 0 }, properties: tankProps('Tank B'),
})!;
check('two tanks stand before the warehouse arrives',
  plant.components.size === 2, `${plant.components.size}`);

const warehouseId = cm.createComponent({
  type: 'warehouse', name: 'Yard', position: { x: 20, y: 30 },
  properties: {
    name: 'Yard', width: 6, depth: 4,
    stockPipeMeters: 100,
    stockLines: [{ type: 'pump', count: 1 }],
  },
})!;
const warehouse = findWarehouse(plant)!;
check('the warehouse is found', warehouse?.id === warehouseId);
check('it holds 100 m of pipe', near(pipeMetersRemaining(plant)!, 100));
check('it holds 1 pump', componentsRemaining(plant, 'pump') === 1);
check('the two tanks already standing were NOT charged',
  componentsRemaining(plant, 'tank') === 0);
check('putting up the warehouse itself cost nothing',
  componentsRemaining(plant, 'warehouse') === 0 && near(pipeMetersRemaining(plant)!, 100));

// ---------------------------------------------------------------------------
// 3. Placing: one pump goes, the second is refused
// ---------------------------------------------------------------------------
console.log('\n--- Placing spends; running out refuses ---');
const pumpProps = { name: 'Pump', ratedFlow: 100, ratedHead: 50, elevation: 0 };
const pumpId = cm.createComponent({
  type: 'pump', name: 'Pump 1', position: { x: 20, y: 0 }, properties: { ...pumpProps },
});
check('the first pump places', pumpId !== null);
check('the pump pile is now empty', componentsRemaining(plant, 'pump') === 0);

const componentsBefore = plant.components.size;
const secondPump = cm.createComponent({
  type: 'pump', name: 'Pump 2', position: { x: 25, y: 0 }, properties: { ...pumpProps },
});
check('the second pump is refused', secondPump === null);
check('the refusal names the part',
  (() => {
    const reason = cm.takeStockRefusal();
    return !!reason && /no more pumps/i.test(reason);
  })());
check('the refused placement changed nothing',
  plant.components.size === componentsBefore, `${plant.components.size} vs ${componentsBefore}`);
check('the pump pile is still 0, not -1', componentsRemaining(plant, 'pump') === 0);

// ---------------------------------------------------------------------------
// 4. Connections cost their length
// ---------------------------------------------------------------------------
console.log('\n--- A run costs its length ---');
const portA = plant.components.get(tankA)!.ports.find(p => p.id.endsWith('-right'))!.id;
const portB = plant.components.get(tankB)!.ports.find(p => p.id.endsWith('-left'))!.id;
const portA2 = plant.components.get(tankA)!.ports.find(p => p.id.endsWith('-top'))!.id;
const portB2 = plant.components.get(tankB)!.ports.find(p => p.id.endsWith('-top'))!.id;

const made60 = cm.createConnection(portA, portB, undefined, undefined, 0.01, 60);
check('a 60 m run is laid', made60);
check('40 m are left', near(pipeMetersRemaining(plant)!, 40),
  String(pipeMetersRemaining(plant)));

const connsBefore = plant.connections.length;
const made50 = cm.createConnection(portA2, portB2, undefined, undefined, 0.01, 50);
check('a 50 m run is refused', !made50);
check('the refusal quotes the 10 m shortfall',
  (() => {
    const reason = cm.takeStockRefusal();
    return !!reason && /10 m short/i.test(reason) &&
      /50 m needed/.test(reason) && /40 m in stock/.test(reason);
  })());
check('the refused run was not added',
  plant.connections.length === connsBefore, `${plant.connections.length} vs ${connsBefore}`);
check('40 m are still left', near(pipeMetersRemaining(plant)!, 40));

// ---------------------------------------------------------------------------
// 5. Editing a run's length pays or refunds the difference
// ---------------------------------------------------------------------------
console.log('\n--- Editing a run adjusts by the delta ---');
const run = plant.connections.find(c => c.fromPortId === portA || c.toPortId === portA)!;
check('the run is 60 m', near(run.length ?? 0, 60));

const lengthen = applyConnectionLengthEdit(plant, run, 90);
check('lengthening 60 -> 90 m is allowed', lengthen.ok);
check('10 m are left', near(pipeMetersRemaining(plant)!, 10), String(pipeMetersRemaining(plant)));
check('the run is 90 m', near(run.length ?? 0, 90));

const tooFar = applyConnectionLengthEdit(plant, run, 200);
check('lengthening past the stock is refused', !tooFar.ok);
check('the refusal quotes the shortfall',
  !tooFar.ok && /100 m short/i.test(tooFar.reason), !tooFar.ok ? tooFar.reason : '');
check('the refused edit left the run at 90 m', near(run.length ?? 0, 90));
check('and left 10 m in stock', near(pipeMetersRemaining(plant)!, 10));

const shorten = applyConnectionLengthEdit(plant, run, 25);
check('shortening 90 -> 25 m refunds', shorten.ok && near(pipeMetersRemaining(plant)!, 75),
  String(pipeMetersRemaining(plant)));
applyConnectionLengthEdit(plant, run, 60);
check('back at 60 m leaves 40 m', near(pipeMetersRemaining(plant)!, 40));

// ---------------------------------------------------------------------------
// 6. An auto-pipe costs the pipe it lays, once
// ---------------------------------------------------------------------------
console.log('\n--- An auto-created pipe component is charged as pipe ---');
{
  const before = pipeMetersRemaining(plant)!;
  const laid = cm.createConnectionWithPipe(portA2, portB2, 0.2, 30, 1.5, 1.5);
  check('a big-bore 30 m run creates a pipe component', laid);
  const pipe = [...plant.components.values()].find(c => c.type === 'pipe') as
    { length: number } | undefined;
  check('the pipe component exists', pipe !== undefined);
  const spent = before - pipeMetersRemaining(plant)!;
  check('exactly the pipe length was spent (the two stub runs are zero-length)',
    pipe !== undefined && near(spent, pipe.length),
    `spent ${spent}, pipe ${pipe?.length}`);

  // ...and deleting it puts back exactly what it cost
  const pipeId = [...plant.components.entries()].find(([, c]) => c.type === 'pipe')![0];
  cm.deleteComponent(pipeId);
  check('deleting the pipe component refunds the same metres',
    near(pipeMetersRemaining(plant)!, before), String(pipeMetersRemaining(plant)));
}

// ---------------------------------------------------------------------------
// 7. Deleting refunds
// ---------------------------------------------------------------------------
console.log('\n--- Deleting puts parts back ---');
check('the 60 m run is still there', plant.connections.some(c => c === run));
cm.deleteConnection(run.fromComponentId, run.toComponentId);
check('deleting the run refunds its 60 m', near(pipeMetersRemaining(plant)!, 100),
  String(pipeMetersRemaining(plant)));

cm.deleteComponent(pumpId!);
check('deleting the pump puts it back on the shelf',
  componentsRemaining(plant, 'pump') === 1);
check('the pump is gone from the plant', !plant.components.has(pumpId!));

// ---------------------------------------------------------------------------
// 8. Save / load round trip
// ---------------------------------------------------------------------------
console.log('\n--- Stock survives a save/load round trip ---');
{
  // Spend something first so the saved stock is not just the authored one
  cm.createComponent({
    type: 'pump', name: 'Pump 3', position: { x: 30, y: 0 }, properties: { ...pumpProps },
  });
  cm.createConnection(portA2, portB2, undefined, undefined, 0.01, 12);
  const savedPipe = pipeMetersRemaining(plant)!;
  const savedPumps = componentsRemaining(plant, 'pump')!;

  // serializePlantState / deserializePlantState in main.ts are exactly this
  const json = JSON.stringify({
    components: Array.from(plant.components.entries()),
    connections: plant.connections,
  });
  const data = JSON.parse(json);
  const reloaded = emptyPlant();
  for (const [id, component] of data.components) reloaded.components.set(id, component);
  reloaded.connections = data.connections as Connection[];

  check('pipe metres survive the round trip',
    near(pipeMetersRemaining(reloaded)!, savedPipe),
    `${pipeMetersRemaining(reloaded)} vs ${savedPipe}`);
  check('the pump count survives the round trip',
    componentsRemaining(reloaded, 'pump') === savedPumps);
  check('the reloaded warehouse is the one the plant builds from',
    findWarehouse(reloaded)!.id === warehouseId);
}

// ---------------------------------------------------------------------------
// 9. Nothing is clamped: spending past a refusal throws
// ---------------------------------------------------------------------------
console.log('\n--- Negative stock is impossible ---');
{
  const stock = getStock(plant)!;
  const have = stock.pipeMeters;
  let threw = false;
  try {
    spend(plant, chargeForPipe(have + 1));
  } catch {
    threw = true;
  }
  check('spending more pipe than exists throws', threw);
  check('the stock is untouched by the throw', near(stock.pipeMeters, have));

  let threwCount = false;
  const bare = emptyPlant();
  const bareCm = new ConstructionManager(bare);
  bareCm.createComponent({
    type: 'warehouse', name: 'Empty Yard', position: { x: 0, y: 0 },
    properties: { name: 'Empty Yard', width: 6, depth: 4, stockPipeMeters: 0 },
  });
  try {
    spend(bare, chargeForComponent('pump'));
  } catch {
    threwCount = true;
  }
  check('spending a part that is not stocked throws', threwCount);
  check('no negative pile was created',
    (componentsRemaining(bare, 'pump') ?? -1) === 0);
}

// ---------------------------------------------------------------------------
// 10. Design lines: a yard that hands out a specified part
// ---------------------------------------------------------------------------
console.log('\n--- A stock line that names an equipment design ---');
{
  const yard = emptyPlant();
  const ycm = new ConstructionManager(yard);
  ycm.createComponent({
    type: 'warehouse', name: 'Service Yard', position: { x: 0, y: 0 },
    properties: {
      name: 'Service Yard', width: 8, depth: 6,
      stockPipeMeters: 300,
      stockPipeSpec: 'spec-12in-service',
      stockLines: [
        { type: 'pump', design: 'pump-service-water-lp', count: 2 },
        { type: 'valve', design: 'valve-service-water', count: 1 },
        { type: 'pump', count: 1 },     // a generic pile beside the design one
      ],
    },
  });

  check('the yard holds 2 service water pumps',
    componentsRemaining(yard, 'pump', 'pump-service-water-lp') === 2);
  check('the generic pump pile is a DIFFERENT line',
    componentsRemaining(yard, 'pump') === 1);
  check('it holds no RCPs at all',
    componentsRemaining(yard, 'pump', 'pump-rcp-large') === 0);
  check('the yard names its line size',
    stockedPipeSpecId(yard) === 'spec-12in-service');
  check('the design line is named by its design, not its type',
    stockLineDisplayName('pump', 'pump-service-water-lp')
      === 'Low-Pressure Service Water Pump',
    stockLineDisplayName('pump', 'pump-service-water-lp'));
  check('a design line knows which palette form builds it',
    paletteKeyForStockLine({ type: 'valve', design: 'valve-service-water', count: 1 }) === 'valve');
  check('a line naming a design nothing knows throws',
    (() => {
      try {
        paletteKeyForStockLine({ type: 'pump', design: 'pump-imaginary', count: 1 });
        return false;
      } catch { return true; }
    })());

  // Placing from the design line
  const svcPumpProps = { name: 'SW Pump 1', ratedFlow: 200, ratedHead: 60, elevation: 0 };
  const svcId = ycm.createComponent({
    type: 'pump', name: 'SW Pump 1', position: { x: 10, y: 0 },
    design: 'pump-service-water-lp', properties: { ...svcPumpProps },
  });
  check('a pump places off the design line', svcId !== null);
  check('the placed pump carries the design',
    yard.components.get(svcId!)!.design === 'pump-service-water-lp');
  check('it came off the DESIGN line',
    componentsRemaining(yard, 'pump', 'pump-service-water-lp') === 1);
  check('the generic pile was not touched', componentsRemaining(yard, 'pump') === 1);

  // The wrong design is refused, even though pumps are in stock
  const wrong = ycm.createComponent({
    type: 'pump', name: 'RCP', position: { x: 20, y: 0 },
    design: 'pump-rcp-large', properties: { ...svcPumpProps, name: 'RCP' },
  });
  check('a pump of a design the yard does not stock is refused', wrong === null);
  check('the refusal names the DESIGN, not just the type',
    (() => {
      const reason = ycm.takeStockRefusal();
      return !!reason && /Reactor Coolant Pump/i.test(reason);
    })());
  check('nothing was spent on the refusal',
    componentsRemaining(yard, 'pump', 'pump-service-water-lp') === 1 &&
    componentsRemaining(yard, 'pump') === 1);

  // Deleting refunds to the line it came from
  ycm.deleteComponent(svcId!);
  check('deleting it puts it back on ITS line',
    componentsRemaining(yard, 'pump', 'pump-service-water-lp') === 2);
  check('and not on the generic pile', componentsRemaining(yard, 'pump') === 1);

  // A part with no design goes back to the generic line
  const genericId = ycm.createComponent({
    type: 'pump', name: 'Any Pump', position: { x: 30, y: 0 },
    properties: { ...svcPumpProps, name: 'Any Pump' },
  });
  check('a pump with no design comes off the generic line',
    genericId !== null && componentsRemaining(yard, 'pump') === 0);
  ycm.deleteComponent(genericId!);
  check('and goes back to the generic line', componentsRemaining(yard, 'pump') === 1);
  check('leaving the design line alone',
    componentsRemaining(yard, 'pump', 'pump-service-water-lp') === 2);

  // Salvage: a design line the yard never stocked is created by the refund
  const salvage = ycm.createComponent({
    type: 'valve', name: 'V1', position: { x: 40, y: 0 },
    design: 'valve-service-water',
    properties: { name: 'V1', diameter: 0.3, pressureRating: 16, elevation: 0 },
  })!;
  ycm.deleteComponent(salvage);
  check('a design part deleted twice over is salvaged onto its own line',
    componentsRemaining(yard, 'valve', 'valve-service-water') === 1);
  check('the yard did not grow a generic valve pile',
    findStockLine(getStock(yard)!, 'valve') === undefined);
}

// ---------------------------------------------------------------------------
// 11. A yard saved in the old type-keyed form still builds
// ---------------------------------------------------------------------------
console.log('\n--- An old save migrates to generic lines ---');
{
  const legacy = emptyPlant();
  legacy.components.set('yard', {
    id: 'yard', type: 'warehouse', label: 'Old Yard',
    position: { x: 0, y: 0 }, rotation: 0, elevation: 0,
    width: 6, depth: 4, ports: [],
    stock: { pipeMeters: 50, components: { pump: 3, valve: 1 } },
  } as never);
  check('the old pump pile reads as a generic line',
    componentsRemaining(legacy, 'pump') === 3);
  check('and is an array now', Array.isArray(getStock(legacy)!.components));
}

console.log(failures === 0
  ? '\n=== ALL PASS ===\n'
  : `\n=== ${failures} FAILURE(S) ===\n`);
process.exit(failures === 0 ? 0 : 1);
