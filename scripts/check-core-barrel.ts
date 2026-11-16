/**
 * The core barrel's steel as a thermal node.
 *
 *   npx tsx scripts/check-core-barrel.ts
 *
 * A barrel behind a graphite reflector wraps the reflector: it takes heat by
 * conduction out of the graphite, loses it to the gas outside and radiates
 * to the vessel wall, and the reflector no longer sees the vessel at all. A
 * bare barrel (water reactors) is steel between the core coolant and the
 * downcomer.
 */
import { buildSimFromFile, test, assert, assertBetween, report } from './lib/sim-harness';
import { ConductionRateOperator } from '../src/simulation/operators/rate-operators';
import { nodeHeatCapacity } from '../src/simulation';
import { graphiteThermalConductivity, NBG_18 } from '../src/simulation/graphite';

test('a barrel around a reflector conducts from the graphite and shields the vessel', () => {
  const s = buildSimFromFile('src/presets/xe100.json').state;
  const barrel = s.thermalNodes.get('cb-1-wall');
  assert(!!barrel, 'the Xe-100 core barrel must have a steel node');
  // 4.4 m shell (2.4 m core + 1 m reflector each side), 11 m tall, 60 mm
  assertBetween(barrel!.mass, 70e3, 73e3, 'barrel steel mass (kg)');

  const ids = s.thermalConnections.map(c => c.id);
  assert(ids.includes('conduction-cb-1-reflector-barrel'), 'reflector must conduct into the barrel');
  assert(ids.includes('radiation-cb-1-wall-rv-1-wall'), 'barrel must radiate to the vessel wall');
  assert(!s.thermalConnections.some(c => c.fromNodeId === 'cb-1-reflector' && c.toNodeId === 'rv-1-wall'),
    'the reflector must not radiate past the barrel to the vessel wall');

  const conv = s.convectionConnections.filter(c => c.thermalNodeId === 'cb-1-wall');
  assert(conv.length === 1 && conv[0].flowNodeId === 'rv-1',
    `the barrel's only wetted face is the vessel gas outside it, got ` +
    conv.map(c => c.flowNodeId).join(', '));
  assert(barrel!.temperature === s.flowNodes.get('rv-1')!.fluid.temperature,
    'behind a reflector the barrel starts at the gas outside it');
});

test('reflector-to-barrel conduction follows live graphite conductivity', () => {
  const s = buildSimFromFile('src/presets/xe100.json').state;
  const conn = s.thermalConnections.find(c => c.id === 'conduction-cb-1-reflector-barrel')!;
  const path = conn.graphiteConduction!;
  const reflector = s.thermalNodes.get('cb-1-reflector')!;
  const barrel = s.thermalNodes.get('cb-1-wall')!;
  // Isolate the one link and put a known difference across it
  s.thermalConnections = [conn];
  const duty = (Tr: number, Tb: number) => {
    reflector.temperature = Tr;
    barrel.temperature = Tb;
    const rate = new ConductionRateOperator().computeRates(s).thermalNodes.get('cb-1-wall')!;
    return rate.dTemperature * nodeHeatCapacity(barrel);
  };
  const expected = (Tr: number, Tb: number) => {
    const k = graphiteThermalConductivity(0.5 * (Tr + Tb), NBG_18);
    return (Tr - Tb) / (1 / (k * path.shapeFactor) + 1 / path.seriesConductance!);
  };
  const cold = duty(500, 400), hot = duty(1500, 1400);
  assertBetween(cold / expected(500, 400), 0.999, 1.001, 'duty vs formula at 450 K');
  assertBetween(hot / expected(1500, 1400), 0.999, 1.001, 'duty vs formula at 1450 K');
  assert(cold > 0 && hot > 0, 'heat must run from the hot reflector into the barrel');
  assert(hot !== cold, 'the path must respond to graphite temperature');
  // The steel is a small part of the resistance, not the whole of it
  const k = graphiteThermalConductivity(450, NBG_18);
  assert(path.seriesConductance! > 5 * k * path.shapeFactor,
    'barrel half-thickness should be a minor resistance next to half a metre of graphite');
});

test('a bare barrel is steel between the core coolant and the downcomer', () => {
  const s = buildSimFromFile('src/presets/pwr.json').state;
  const walls = s.convectionConnections.filter(c =>
    /-wall$/.test(c.thermalNodeId) && s.flowNodes.has(c.thermalNodeId.replace(/-wall$/, '')));
  const barrelIds = [...s.thermalNodes.keys()].filter(id =>
    id.endsWith('-wall') && !s.thermalConnections.some(c => c.graphiteConduction && c.toNodeId === id) &&
    walls.filter(c => c.thermalNodeId === id).length === 2 &&
    s.thermalNodes.get(id.replace(/-wall$/, '-fuel')));
  assert(barrelIds.length === 1, `expected one fuelled barrel wall in the PWR, found ${barrelIds.join(', ') || 'none'}`);
  const id = barrelIds[0];
  const coreId = id.replace(/-wall$/, '');
  const faces = walls.filter(c => c.thermalNodeId === id).map(c => c.flowNodeId);
  assert(faces.includes(coreId), 'inner face must be wetted by the core coolant');
  const outside = faces.find(f => f !== coreId)!;
  const T = s.thermalNodes.get(id)!.temperature;
  const Tin = s.flowNodes.get(coreId)!.fluid.temperature;
  const Tout = s.flowNodes.get(outside)!.fluid.temperature;
  assertBetween(T, Math.min(Tin, Tout) - 1e-9, Math.max(Tin, Tout) + 1e-9,
    'bare barrel starts between the fluids on its two faces');
});

report('Core Barrel Suite');
