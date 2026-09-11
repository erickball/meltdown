// Electrical network solve: energization, voltage matching, load sharing,
// diesel auto-start and fuel, battery charge/discharge, overload trips, the
// de-energize-to-trip scram, commands, and the plant-level off switch.
//
// Run: npx tsx scripts/test-electrical.ts
import { buildElectricalState, solveElectrical, applyElectricalCommand, RELAY_TIME_CONSTANT_S } from '../src/simulation/electrical';
import { pumpMotorRatedW } from '../src/simulation/electrical-rules';
import { supplyStatus, unwiredParts } from '../src/construction/electrical-wiring';
import { unpoweredParts } from '../src/render/power-badge';
import type { PlantState, PlantComponent } from '../src/types';
import type { SimulationState } from '../src/simulation/types';

let failures = 0;
function check(cond: boolean, what: string): void {
  if (cond) console.log(`  ok   ${what}`);
  else { console.error(`  FAIL ${what}`); failures++; }
}
function near(a: number, b: number, rel: number): boolean {
  return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-12);
}

function comp(c: Record<string, unknown>): PlantComponent {
  return { position: { x: 0, y: 0 }, rotation: 0, ports: [], ...c } as unknown as PlantComponent;
}

/** A small but complete station: grid + diesel on the 4.16 kV bus, 480 V and DC below. */
function station(overrides: Record<string, Record<string, unknown>> = {}): PlantState {
  const parts: Record<string, unknown>[] = [
    { id: 'sy', type: 'switchyard', label: 'Switchyard', transmissionVoltage: 345, transformerRating: 100 },
    { id: 'tr', type: 'transformer', label: 'Startup XFMR', ratingMVA: 10, primaryVoltage: 345000, secondaryVoltage: 4160, powerSupplyId: 'sy' },
    { id: 'dg', type: 'diesel-generator', label: 'EDG A', ratingKW: 2000, voltage: 4160, startTime: 10, fuelHours: 1, fuelFraction: 1, autoStart: true, running: false },
    { id: 'mv', type: 'bus', label: '4.16 kV bus', voltage: 4160, dc: false, powerSupplyId: 'tr', backupPowerSupplyId: 'dg' },
    { id: 'brk', type: 'breaker', label: 'Pump breaker', ratingKW: 3000, closed: true, powerSupplyId: 'mv' },
    { id: 'tr2', type: 'transformer', label: 'Load center XFMR', ratingMVA: 2, primaryVoltage: 4160, secondaryVoltage: 480, powerSupplyId: 'mv' },
    { id: 'lv', type: 'bus', label: '480 V MCC', voltage: 480, dc: false, powerSupplyId: 'tr2' },
    { id: 'bat', type: 'battery', label: 'Battery 1', voltage: 125, capacityKWh: 10, dischargeKW: 20, chargerKW: 10, chargeFraction: 1, powerSupplyId: 'lv' },
    { id: 'dc', type: 'bus', label: '125 V DC bus', voltage: 125, dc: true, powerSupplyId: 'bat' },
    // Loads: a 1 MW-class motor on the breaker, a PID cabinet on DC, an MOV on the MCC
    { id: 'P1', type: 'pump', label: 'Pump 1', ratedFlow: 1000, ratedHead: 80, running: true, speed: 1, powerSupplyId: 'brk' },
    { id: 'C1', type: 'controller', controllerType: 'pid', label: 'Level controller', powerSupplyId: 'dc' },
    { id: 'V1', type: 'valve', valveType: 'gate', label: 'MOV 1', powerSupplyId: 'lv' },
  ];
  const components = new Map<string, PlantComponent>();
  for (const p of parts) {
    const id = p.id as string;
    components.set(id, comp({ ...p, ...(overrides[id] ?? {}) }));
  }
  return { components, connections: [], electrical: { enabled: true }, simTime: 0, simSpeed: 1, isPaused: false };
}

/** The physics side the solve writes flags into. */
function simFor(plant: PlantState): SimulationState {
  const state = {
    time: 0,
    thermalNodes: new Map(), flowNodes: new Map(),
    thermalConnections: [], convectionConnections: [],
    flowConnections: [{ id: 'c-p1', fromNodeId: 'a', toNodeId: 'b', massFlowRate: 1000 }],
    neutronics: { coreId: null, scrammed: false, controlRodPosition: 1 },
    components: {
      pumps: new Map([['P1', {
        id: 'P1', running: true, speed: 1, effectiveSpeed: 1, ratedHead: 80, ratedFlow: 1000,
        efficiency: 0.85, connectedFlowPath: 'c-p1', rampUpTime: 5, coastDownTime: 30,
        npshRequired: 5, motorElevation: 0, pumpType: 'centrifugal',
      }]]),
      valves: new Map([['V1', { id: 'V1', position: 1, failPosition: 0, connectedFlowPath: '' }]]),
      checkValves: new Map(),
      controllers: new Map([['C1', { id: 'C1' }]]),
    },
  } as unknown as SimulationState;
  state.electrical = buildElectricalState(plant);
  return state;
}

function run(state: SimulationState, seconds: number, dt = 0.5): void {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    state.time += dt;
    solveElectrical(state, dt);
  }
}

const el = (s: SimulationState, id: string) => s.electrical!.elements[id];
const load = (s: SimulationState, id: string) => s.electrical!.loads[id];

// ---------------------------------------------------------------------------
console.log('\n[1] Off switch: no electrical state, nothing written');
{
  const plant = station();
  plant.electrical = { enabled: false };
  const s = simFor(plant);
  check(s.electrical === undefined, 'plant with electrical disabled builds no network');
  solveElectrical(s, 1);
  check(s.components.pumps.get('P1')!.powered === undefined, 'pump carries no powered flag');
}

console.log('\n[2] Normal lineup: grid feeds everything');
{
  const s = simFor(station());
  solveElectrical(s, 0);
  for (const id of ['sy', 'tr', 'mv', 'brk', 'tr2', 'lv', 'bat', 'dc']) {
    check(el(s, id).energized, `${id} energized`);
  }
  check(!el(s, 'dg').running, 'diesel stays stopped with the bus live');
  check(s.components.pumps.get('P1')!.powered === true, 'pump powered');
  check(s.components.controllers.get('C1')!.powered === true, 'controller powered');
  check(s.components.valves.get('V1')!.powered === true, 'MOV powered');
  // At the rated point the motor draws rated flow x g x head / (eta_pump eta_motor)
  const rated = pumpMotorRatedW(1000, 80);
  check(near(load(s, 'P1').demandW, rated, 1e-9), `pump at rated point draws its nameplate (${(rated / 1e3).toFixed(0)} kW)`);
  check(load(s, 'P1').voltageClass === 'mv', 'a ~1 MW motor is a medium-voltage load');
  // Everything the loads draw comes out of the grid (the charger tops a full
  // battery with nothing: the taper is (1 - SOC) = 0)
  const loadsTotal = Object.values(s.electrical!.loads).reduce((a, l) => a + l.demandW, 0);
  check(near(el(s, 'sy').demandW, loadsTotal, 1e-9), 'grid carries the sum of the loads');
  check(near(el(s, 'bat').cellsW!, 0, 1e-12) && el(s, 'bat').chargeW === 0, 'charger carries the DC load, full battery takes no charge');
}

console.log('\n[3] Loss of offsite power: diesel starts, loads come back, battery bridges DC');
{
  const s = simFor(station());
  solveElectrical(s, 0);
  const r = applyElectricalCommand(s, 'sy', 'offsite-lost');
  check(r.ok, 'offsite-lost accepted');
  run(s, 0.5);
  check(!el(s, 'mv').energized, '4.16 kV bus dead');
  check(el(s, 'dg').running === true, 'diesel auto-started');
  check(s.components.pumps.get('P1')!.powered === false, 'pump lost power');
  check(s.components.controllers.get('C1')!.powered === true, 'controller rides through on the battery');
  check(el(s, 'bat').cellsW! > 0, 'battery cells carry the DC load');
  const e0 = el(s, 'bat').energyJ!;
  run(s, 9);
  check(!el(s, 'mv').energized, 'still dead before the diesel is up to speed');
  check(el(s, 'bat').energyJ! < e0, 'battery discharging');
  run(s, 1.5);
  check(el(s, 'mv').energized, 'bus re-energized by the diesel after its start time');
  check(s.components.pumps.get('P1')!.powered === true, 'pump powered again');
  check(el(s, 'dg').demandW > 0 && el(s, 'tr').demandW === 0, 'diesel carries the bus, dead grid carries nothing');
  run(s, 1);
  check(el(s, 'bat').chargeW! > 0, 'battery recharging from the diesel-backed MCC');

  // Grid back: both feeds live, load shared by what each can deliver
  applyElectricalCommand(s, 'sy', 'offsite-restored');
  run(s, 0.5);
  const tr = el(s, 'tr').demandW, dg = el(s, 'dg').demandW;
  // transformer can pass min(10 MW, 100 MW) = 10 MW, diesel 2 MW
  check(near(tr / dg, 10 / 2, 1e-9), `parallel feeds share 10:2 (got ${(tr / dg).toFixed(3)})`);
}

console.log('\n[4] Diesel fuel runs out');
{
  const s = simFor(station({ dg: { fuelHours: 1, fuelFraction: 0.01 } }));
  solveElectrical(s, 0);
  applyElectricalCommand(s, 'sy', 'offsite-lost');
  // 1% of 1 h at rated, burning at least the no-load quarter: at most 144 s
  run(s, 200, 1);
  check(el(s, 'dg').running === false && el(s, 'dg').fuelJ === 0, 'diesel stopped with an empty tank');
  check(!el(s, 'mv').energized, 'bus dead again');
  const r = applyElectricalCommand(s, 'dg', 'start');
  check(!r.ok, `restart refused: ${r.message}`);
}

console.log('\n[5] Battery runs flat');
{
  const s = simFor(station({ bat: { capacityKWh: 0.001 }, dg: { autoStart: false } }));
  solveElectrical(s, 0);
  applyElectricalCommand(s, 'sy', 'offsite-lost');
  // 3.6 kJ at the 1 kW cabinet: under 4 s
  run(s, 5, 0.25);
  check(el(s, 'bat').energyJ! <= 0, 'cells empty');
  check(!el(s, 'dc').energized, 'DC bus dead');
  check(s.components.controllers.get('C1')!.powered === false, 'controller lost power');
}

console.log('\n[6] Overload: inverse-time trip; the relay remembers its heat');
{
  // Pump draws ~971 kW; a 700 kW breaker sees r = 1.39: trips at tau ln(r2/(r2-1))
  const s = simFor(station({ brk: { ratingKW: 700 } }));
  solveElectrical(s, 0);
  const r = load(s, 'P1').demandW / 700e3;
  const expected = RELAY_TIME_CONSTANT_S * Math.log((r * r) / (r * r - 1));
  let t = 0;
  const dt = 0.05;
  while (!el(s, 'brk').tripped && t < 300) { t += dt; s.time = t; solveElectrical(s, dt); }
  check(el(s, 'brk').tripped && Math.abs(t - expected) < 2 * dt,
    `breaker tripped at ${t.toFixed(2)} s (inverse-time law says ${expected.toFixed(2)} s)`);
  check(el(s, 'brk').closed === false, 'trip opened the breaker');
  solveElectrical(s, dt);
  check(s.components.pumps.get('P1')!.powered === false, 'pump lost power');
  // Reclose at once onto the same overload: the relay is still hot, so it
  // trips again in a small fraction of the first-trip time
  check(applyElectricalCommand(s, 'brk', 'close').ok, 'immediate reclose accepted');
  solveElectrical(s, 0);   // the pump is back on the bus before any time passes
  let t2 = 0;
  while (!el(s, 'brk').tripped && t2 < 300) { t2 += dt; s.time += dt; solveElectrical(s, dt); }
  check(el(s, 'brk').tripped && t2 < 0.1 * expected,
    `hot reclose re-trips in ${t2.toFixed(2)} s (first trip took ${t.toFixed(2)} s)`);
  // Left open to cool for three time constants, a reclose rides much longer
  run(s, 3 * RELAY_TIME_CONSTANT_S, 0.5);
  check(el(s, 'brk').overload < 0.1, `relay cooled while open (theta ${el(s, 'brk').overload.toFixed(3)})`);
}

console.log('\n[7] Wiring faults: wrong voltage carries nothing, loops are refused');
{
  const s = simFor(station({ lv: { voltage: 4160 } }));
  solveElectrical(s, 0);
  check(!el(s, 'lv').energized && /480 V AC/.test(el(s, 'lv').fault ?? ''), `4160 V bus on a 480 V transformer is dead: "${el(s, 'lv').fault}"`);
  check(s.components.valves.get('V1')!.powered === false, 'MOV on it unpowered');

  const s2 = simFor(station({ P1: { powerSupplyId: 'lv' } }));
  solveElectrical(s2, 0);
  check(load(s2, 'P1').powered === false && /medium-voltage/.test(load(s2, 'P1').fault ?? ''),
    `MV motor on the 480 V MCC refused: "${load(s2, 'P1').fault}"`);

  let threw = '';
  try { buildElectricalState(station({ sy: {}, tr: { powerSupplyId: 'lv' } })); } catch (e) { threw = (e as Error).message; }
  check(/circle/.test(threw), `feed loop refused: ${threw.slice(0, 90)}...`);

  const s3 = simFor(station({ C1: { powerSupplyId: undefined } }));
  solveElectrical(s3, 0);
  check(load(s3, 'C1').powered === false && load(s3, 'C1').fault === 'not connected to a power supply', 'unwired load reports it');
}

console.log('\n[8] De-energize to trip: rod drives');
{
  const plant = station();
  plant.components.set('core', comp({ id: 'core', type: 'vessel', label: 'Core', fuelRodCount: 10, controlRodCount: 4, powerSupplyId: 'lv' }));
  const s = simFor(plant);
  (s.neutronics as any).coreId = 'core';
  solveElectrical(s, 0);
  check(!s.neutronics.scrammed, 'powered rod drives: no scram');
  plant.components.get('dg')!;
  applyElectricalCommand(s, 'dg', 'stop');
  (s.electrical!.elements.dg).autoStart = false;
  applyElectricalCommand(s, 'sy', 'offsite-lost');
  run(s, 0.5);
  check(s.neutronics.scrammed === true && s.neutronics.controlRodPosition === 0, `scram on loss of rod-drive power: ${s.neutronics.scramReason}`);
  check((s.pendingEvents ?? []).some(e => e.type === 'scram'), 'scram event queued for the UI');
}

console.log('\n[9] Breaker commands');
{
  const s = simFor(station());
  solveElectrical(s, 0);
  check(applyElectricalCommand(s, 'brk', 'open').ok, 'open accepted');
  solveElectrical(s, 0.1);
  check(!el(s, 'brk').energized && s.components.pumps.get('P1')!.powered === false, 'open breaker de-energizes its load');
  check(!applyElectricalCommand(s, 'mv', 'open').ok, 'a bus cannot be "opened"');
  check(applyElectricalCommand(s, 'brk', 'close').ok, 'close accepted');
  solveElectrical(s, 0.1);
  check(s.components.pumps.get('P1')!.powered === true, 'closed again, pump powered');
}

console.log('\n[10] Wiring as designed: supply status, the auto-wire report, the no-power badges');
{
  const at = (p: PlantState, id: string) => supplyStatus(p, p.components.get(id) as never);
  const ok = station();
  check(at(ok, 'P1')?.problem === undefined && at(ok, 'P1')?.supplyLabel === 'Pump breaker',
    'pump on its breaker: can be powered, and names its supply');
  check(at(ok, 'sy') === null && at(ok, 'dg') === null, 'sources take no supply');

  const unwired = station({ C1: { powerSupplyId: undefined } });
  check(at(unwired, 'C1')?.problem === 'not connected - needs DC control power',
    `unwired cabinet: "${at(unwired, 'C1')?.problem}"`);
  const report = unwiredParts(unwired);
  check(report.length === 1 && report[0].id === 'C1' && report[0].needs === 'DC control power',
    `auto-wire report lists it with what it needs: ${JSON.stringify(report)}`);

  const wrong = station({ lv: { voltage: 4160 } });
  check(/is 4\.16 kV AC, but this needs low-voltage AC/.test(at(wrong, 'V1')?.problem ?? ''),
    `MOV on a 4.16 kV bus: "${at(wrong, 'V1')?.problem}"`);

  // The MCC is 480 V as the valve wants, but its transformer's primary does
  // not match the bus feeding it, so nothing reaches the MCC
  const deadEnd = station({ tr2: { primaryVoltage: 13800 } });
  check(/no path back to a source/.test(at(deadEnd, 'V1')?.problem ?? ''),
    `MCC cut off upstream: "${at(deadEnd, 'V1')?.problem}"`);

  // A bus whose normal feed cannot work is fine on its backup
  const backup = station({ tr: { primaryVoltage: 138000 } });
  check(!at(backup, 'mv')?.problem && at(backup, 'mv')?.supplyId === 'dg', 'bus with a broken normal feed runs from its diesel backup');

  const badgesBuilding = unpoweredParts(unwired, null, true);
  check(badgesBuilding.includes('C1') && !badgesBuilding.includes('P1'),
    `building: badge on the unwired cabinet only (${badgesBuilding.join(', ')})`);
  check(unpoweredParts({ ...unwired, electrical: { enabled: false } }, null, true).length === 0,
    'no badges with the electrical model off');

  const s = simFor(station());
  solveElectrical(s, 0);
  applyElectricalCommand(s, 'brk', 'open');
  solveElectrical(s, 0.1);
  const badgesRunning = unpoweredParts(station(), s, false);
  check(badgesRunning.includes('P1') && badgesRunning.includes('brk') && !badgesRunning.includes('C1'),
    `running: badges follow the solve - open breaker and its pump (${badgesRunning.join(', ')})`);
}

if (failures > 0) {
  console.error(`\n${failures} electrical check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll electrical checks passed.');
