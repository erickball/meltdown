// The electrical model on a real plant: the two-loop PWR test plant given a
// grid connection, a startup transformer, 6.9 kV / 480 V / 125 V DC buses and
// a station battery, wired by autoWirePlant. Then a loss of offsite power:
// the pumps coast down, the rod drives let go (scram), the controllers ride
// through on the battery while the pressurizer heaters go cold; and the grid
// back: the pumps run up again.
//
// Run: npx tsx scripts/test-electrical-plant.ts
import * as fs from 'fs';
import { buildSimFromPlantJson, run, assertStateSane } from './lib/sim-harness';
import { autoWirePlant } from '../src/construction/electrical-wiring';
import { applyElectricalCommand } from '../src/simulation/electrical';
import { beginLivePlantEdit, commitLivePlantEdit } from '../src/simulation/live-edit';
import type { PlantState, PlantComponent } from '../src/types';

let failures = 0;
function check(cond: boolean, what: string): void {
  if (cond) console.log(`  ok   ${what}`);
  else { console.error(`  FAIL ${what}`); failures++; }
}

const data = JSON.parse(fs.readFileSync('scripts/test-plants/two-loop-pwr.json', 'utf-8'));
const part = (c: Record<string, unknown>): [string, PlantComponent] =>
  [c.id as string, { rotation: 0, elevation: 0, ports: [], width: 2, height: 2, ...c } as unknown as PlantComponent];
data.components.push(
  part({ id: 'sy', type: 'switchyard', label: 'Switchyard', position: { x: 0, y: 40 }, width: 15, height: 12,
    transmissionVoltage: 345, offsiteLines: 2, transformerRating: 1200, reliabilityClass: 'standard' }),
  part({ id: 'sut', type: 'transformer', label: 'Startup XFMR', position: { x: 12, y: 50 },
    ratingMVA: 40, primaryVoltage: 345000, secondaryVoltage: 6900 }),
  part({ id: 'bus-mv', type: 'bus', label: '6.9 kV Bus', position: { x: 18, y: 55 }, voltage: 6900, dc: false }),
  part({ id: 'lct', type: 'transformer', label: 'Load Center XFMR', position: { x: 18, y: 60 },
    ratingMVA: 6, primaryVoltage: 6900, secondaryVoltage: 480 }),
  part({ id: 'bus-lv', type: 'bus', label: '480 V MCC', position: { x: 22, y: 64 }, voltage: 480, dc: false }),
  part({ id: 'bat', type: 'battery', label: 'Station Battery', position: { x: 22, y: 68 },
    voltage: 125, capacityKWh: 250, dischargeKW: 100, chargerKW: 50, chargeFraction: 1 }),
  part({ id: 'bus-dc', type: 'bus', label: '125 V DC', position: { x: 24, y: 70 }, voltage: 125, dc: true }),
);
data.electrical = { enabled: true };

// Wire it the way the "Auto-wire" button does
const plant = { components: new Map<string, PlantComponent>(data.components), connections: data.connections,
  electrical: data.electrical, simTime: 0, simSpeed: 1, isPaused: false } as PlantState;
const wired = autoWirePlant(plant);
console.log(`auto-wired: ${wired.join(', ')}`);
// The wired design as built, before any simulation writes its live state back
// into these same component objects (the live edit in [2b] does exactly that)
const pristine = JSON.stringify(data);

console.log('\n[1] Wiring and the plant at rest on the grid');
const sim = buildSimFromPlantJson(data);
const E = () => sim.state.electrical!;
for (const l of Object.values(E().loads)) {
  check(!!l.supplyId && !l.fault, `${l.id} (${l.kind}, ${l.voltageClass}) wired to ${l.supplyId}${l.fault ? ` - ${l.fault}` : ''}`);
}
check(E().loads['pump-1'].voltageClass === 'mv' && E().loads['pump-1'].supplyId === 'bus-mv', 'RCP (5.7 MW motor) on the 6.9 kV bus');
check(E().loads['pzr-1']?.supplyId === 'bus-lv', 'pressurizer heaters on the 480 V MCC');
check(E().loads['ctl-pzrh-1'].supplyId === 'bus-dc', 'controller cabinets on the DC bus');
check(E().loads['rv-1']?.kind === 'rod-drive', 'reactor vessel carries the rod-drive load');

run(sim, 20, 0.5);
const pump = () => sim.state.components.pumps.get('pump-1')!;
check(pump().powered === true && Math.abs(pump().effectiveSpeed - 1) < 1e-9, 'RCP powered and at speed');
check(!sim.state.neutronics.scrammed, 'reactor not tripped');
const loads = Object.values(E().loads).reduce((s, l) => s + l.demandW, 0);
check(Math.abs(E().elements.sy.demandW - loads) / loads < 1e-6,
  `grid carries every load (${(loads / 1e6).toFixed(1)} MW, charger topping off a full battery with nothing)`);
check(E().elements.sut.demandW < E().elements.sut.ratingW, `startup transformer within rating (${(100 * E().elements.sut.demandW / E().elements.sut.ratingW).toFixed(0)}%)`);

console.log('\n[2] Loss of offsite power');
check(applyElectricalCommand(sim.state, 'sy', 'offsite-lost').ok, 'grid lost at the switchyard');
const speedAtLoss = pump().effectiveSpeed;
run(sim, 10, 0.5);
check(pump().powered === false, 'RCP lost power');
check(pump().running === true, 'its START/STOP switch is untouched');
check(pump().effectiveSpeed < speedAtLoss - 0.2 && pump().effectiveSpeed > 0, `RCP coasting down (${(100 * pump().effectiveSpeed).toFixed(0)}% after 10 s)`);
check(sim.state.neutronics.scrammed === true && /rod drives/.test(sim.state.neutronics.scramReason ?? ''),
  `reactor tripped: ${sim.state.neutronics.scramReason}`);
check(sim.state.components.controllers.get('ctl-pzrh-1')!.powered === true, 'controllers ride through on the battery');
check(sim.state.flowNodes.get('pzr-1')!.heaterPowered === false, 'pressurizer heaters dead');
check(E().elements.bat.cellsW! > 0, `battery carrying the DC load (${(E().elements.bat.cellsW! / 1e3).toFixed(1)} kW)`);
assertStateSane(sim.state);

console.log('\n[2b] A live edit in the middle of the outage keeps the electrical state');
{
  // Rename the switchyard: an edited component starts from its (written-back)
  // initial conditions, so the lost grid has to survive through the write-back;
  // the battery is untouched, so its charge has to be carried across.
  const energyBefore = E().elements.bat.energyJ!;
  const snap = beginLivePlantEdit(sim.state, plant);
  (plant.components.get('sy') as { label?: string }).label = 'Switchyard (renamed)';
  const { state, notes } = commitLivePlantEdit(plant, snap);
  sim.state = state;
  console.log(`  ${notes.join('; ')}`);
  check(E().elements.sy.available === false && !E().elements.sy.energized, 'grid still lost after the rebuild');
  check(E().elements.bat.energyJ === energyBefore, 'battery charge carried across the rebuild');
  check(sim.state.components.pumps.get('pump-1')!.powered === false, 'RCP still without power');
  check(sim.state.neutronics.scrammed === true, 'reactor still tripped');
}

console.log('\n[3] Grid restored');
check(applyElectricalCommand(sim.state, 'sy', 'offsite-restored').ok, 'grid back');
const speedAtRestore = pump().effectiveSpeed;
run(sim, 5, 0.5);
check(pump().powered === true && pump().effectiveSpeed > speedAtRestore + 0.3,
  `RCP running back up (${(100 * speedAtRestore).toFixed(0)}% -> ${(100 * pump().effectiveSpeed).toFixed(0)}%)`);
check(sim.state.flowNodes.get('pzr-1')!.heaterPowered === true, 'heaters powered again');
check(E().elements.bat.chargeW! > 0, 'battery recharging');
assertStateSane(sim.state);

// ---------------------------------------------------------------------------
// The generator: the same plant with its turbine-generator behind the
// switchyard. Losing the grid now leaves the generator carrying the house
// load by itself - which it does if its speed governor holds it, and which
// ends in an overspeed trip if nothing does.
// ---------------------------------------------------------------------------

function generatorPlant(speedGovernor: boolean) {
  const d = JSON.parse(pristine);
  for (const [id, c] of d.components as Array<[string, Record<string, unknown>]>) {
    if (id === 'sy') c.connectedGeneratorId = 'turbine-1';
    if (id === 'turbine-1') c.speedGovernor = speedGovernor;
  }
  return buildSimFromPlantJson(d);
}

/** Run a loss of the grid, tracking the fastest the rotor went and any trip message. */
function loseGrid(s: ReturnType<typeof generatorPlant>, seconds: number) {
  let maxSpeed = 0;
  applyElectricalCommand(s.state, 'sy', 'offsite-lost');
  run(s, seconds, 0.05, st => { maxSpeed = Math.max(maxSpeed, st.electrical!.elements['turbine-1'].speed!); });
  return maxSpeed;
}

console.log('\n[4] Generator on the grid, then islanded onto the house load (speed governor)');
{
  const s = generatorPlant(true);
  const g = () => s.state.electrical!.elements['turbine-1'];
  run(s, 20, 0.5);
  check(g().synchronized === true && g().speed === 1, 'synchronized: the grid holds the rotor at rated speed');
  const house = s.state.electrical!.elements.sy.demandW + g().demandW;
  check(Math.abs(g().exportW! - (g().mechW! * g().genEfficiency! - house)) < 1e-6 * house,
    `exports shaft power less the house load (${(g().mechW! / 1e6).toFixed(1)} MW shaft, ${(g().exportW! / 1e6).toFixed(1)} MW out)`);
  const maxSpeed = loseGrid(s, 60);
  check(maxSpeed > 1.001 && maxSpeed < g().overspeedTrip!,
    `load rejection: rotor peaks at ${(100 * maxSpeed).toFixed(2)}%, below the ${(100 * g().overspeedTrip!).toFixed(0)}% trip`);
  check(!g().turbineTripped && g().online === true && g().synchronized === false, 'islanded: on line, no grid, turbine running');
  check(Math.abs(g().speed! - 1) < 0.01, `governor reset brings the island back to rated speed (${(100 * g().speed!).toFixed(2)}%)`);
  check(s.state.electrical!.elements.sy.energized && s.state.components.pumps.get('pump-1')!.powered === true,
    'the generator carries the house load: switchyard live, RCP powered');
  check(!s.state.neutronics.scrammed, 'reactor still at power (rod drives never lost power)');
  assertStateSane(s.state);

  check(applyElectricalCommand(s.state, 'sy', 'offsite-restored').ok, 'grid back');
  run(s, 10, 0.5);
  check(g().synchronized === true && Math.abs(g().speed! - 1) < 1e-3, 'resynchronized: the grid pulls the rotor back into step');
  check(g().exportW! > 0, `exporting again (${(g().exportW! / 1e6).toFixed(1)} MW)`);
}

console.log('\n[5] Loss of the grid with no speed governor: overspeed trip');
{
  const s = generatorPlant(false);
  const g = () => s.state.electrical!.elements['turbine-1'];
  run(s, 20, 0.5);
  const maxSpeed = loseGrid(s, 30);
  check(g().turbineTripped === true && maxSpeed >= g().overspeedTrip!,
    `rotor ran up to ${(100 * maxSpeed).toFixed(2)}% and the turbine tripped on overspeed`);
  check(g().online === false && s.state.flowNodes.get('turbine-1')!.turbineTripped === true,
    'stop valves shut, generator breaker open');
  check(g().speed! < maxSpeed, `rotor coasting down (${(100 * g().speed!).toFixed(2)}%)`);
  check(!s.state.electrical!.elements.sy.energized && s.state.components.pumps.get('pump-1')!.powered === false,
    'house loads dead with the generator gone');
  check(s.state.neutronics.scrammed === true, `reactor tripped: ${s.state.neutronics.scramReason}`);
  const close = applyElectricalCommand(s.state, 'turbine-1', 'close');
  check(!close.ok, `breaker will not close on a tripped turbine: ${close.message}`);
  assertStateSane(s.state);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nElectrical plant checks passed.');
