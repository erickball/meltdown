/**
 * Two-way flow through a break (src/simulation/operators/exchange-flow.ts).
 *
 * A sealed tank of water inside a building, torn below its water line. One
 * connection can only carry one flow, so before the exchange model the tank
 * could only lose water as fast as something else made room for it: a
 * knife-edge manometer that sat draining at the rate the tank warmed (and
 * that any disturbance tipped into alternating whole-opening slugs of air
 * and water). With the exchange the water runs out of the lower part of the
 * tear while air comes in over it, and the tank drains down to the tear.
 *
 *   npx tsx scripts/check-exchange-flow.ts
 */

import { test, assert, report, buildSim, run } from './lib/sim-harness';
import { saturationPressure } from '../src/simulation/water-properties';
import { applyScriptedBurst } from '../src/simulation/operators/burst-operator';
import { breakExchange } from '../src/simulation/operators/exchange-flow';
import { drawCompositionAt } from '../src/simulation/operators/connection-hydraulics';
import type { PlantComponent, Connection } from '../src/types';

const T_WATER = 300;

function building(): [string, PlantComponent] {
  return ['bld', {
    id: 'bld', type: 'building', label: 'Building',
    position: { x: 0, y: 0 }, rotation: 0, elevation: 0,
    shape: 'cylinder', height: 20, diameter: 30, wallThickness: 0.5, steelFraction: 0.05,
    pressureRating: 4, fillLevel: 0,
    fluid: { temperature: T_WATER, pressure: 101325, phase: 'vapor', quality: 1, flowRate: 0 },
    initialNcg: { N2: 0.79, O2: 0.21 },
    ports: [{ id: 'bld-p', position: { x: 0, y: 15 }, direction: 'both' }],
  } as unknown as PlantComponent];
}

// 4 m wide, 16 m tall (width = sqrt(height): the hydrostatic model's own
// shape, so its level is the drawn level), 80% full, air above, SEALED.
function tank(): [string, PlantComponent] {
  return ['tnk', {
    id: 'tnk', type: 'tank', label: 'Sealed Tank',
    position: { x: 0, y: 0 }, rotation: 0, elevation: 0,
    width: 4, height: 16, wallThickness: 0.012, fillLevel: 0.8, pressureRating: 10,
    fluid: { temperature: T_WATER, pressure: saturationPressure(T_WATER), phase: 'two-phase', quality: 1e-5, flowRate: 0 },
    initialNcg: { N2: 0.79, O2: 0.21 },
    containedBy: 'bld',
    ports: [{ id: 'tnk-top', position: { x: 0, y: -8 }, direction: 'both' }],
  } as unknown as PlantComponent];
}

const connections: Connection[] = [];
const TEAR_Z = 6;        // m up the tank side, ~6.8 m under water
const TEAR_H = 0.4;      // m - a 40 cm tall tear...
const TEAR_A = 0.12;     // m2 - ...30 cm wide

function torn(openingHeight = TEAR_H) {
  const sim = buildSim([building(), tank()], connections);
  applyScriptedBurst(sim.state, 'tnk', { area: TEAR_A, elevation: TEAR_Z, openingHeight });
  const conn = sim.state.flowConnections.find(c => c.id === 'break-tnk')!;
  return { sim, conn };
}

test('At zero net flow the exchange is the layered orifice law (neutral plane high for water against air)', () => {
  const { sim, conn } = torn();
  conn.massFlowRate = 0;
  const ex = breakExchange(sim.state, conn);
  assert(ex !== null, 'a tear under water into air should exchange');
  const tnk = sim.state.flowNodes.get('tnk')!;
  const bld = sim.state.flowNodes.get('bld')!;
  const rh = drawCompositionAt(tnk, conn.fromElevation, 0, conn.fromPhaseTolerance, conn.fromOpeningHeight).rho;
  const rl = drawCompositionAt(bld, conn.toElevation, 0, conn.toPhaseTolerance, conn.toOpeningHeight).rho;
  const Cd = conn.breakDischargeCoeff!;
  const W = TEAR_A / TEAR_H;
  // Q_h(z_n) = Q_l(z_n): z_n^1.5 / sqrt(rho_h) = (H - z_n)^1.5 / sqrt(rho_l)
  const zn = TEAR_H / (1 + Math.cbrt(rl / rh));
  const expected = (2 / 3) * Cd * W * Math.sqrt(2 * 9.81 * (rh - rl) / rh) * Math.pow(zn, 1.5);
  const err = Math.abs(ex!.volumeFlow / expected - 1);
  console.log(`  rho ${rh.toFixed(0)} / ${rl.toFixed(2)} kg/m3, neutral plane ${(zn / TEAR_H * 100).toFixed(0)}% up the tear, ` +
    `exchange ${(ex!.volumeFlow * 1e3).toFixed(1)} L/s (closed form ${(expected * 1e3).toFixed(1)})`);
  assert(err < 1e-6, `exchange ${ex!.volumeFlow} m3/s vs closed form ${expected} m3/s`);
  assert(Math.abs(ex!.heavy.massFlow / rh - ex!.light.massFlow / rl) < 1e-9 * ex!.volumeFlow,
    'the two legs must carry equal volumes');
});

test('A thin slit of the same area exchanges as sqrt(H): capacity goes as W H^1.5', () => {
  const a = torn(TEAR_H); a.conn.massFlowRate = 0;
  const b = torn(TEAR_H / 16); b.conn.massFlowRate = 0;
  const qa = breakExchange(a.sim.state, a.conn)!.volumeFlow;
  const qb = breakExchange(b.sim.state, b.conn)!.volumeFlow;
  console.log(`  ${(TEAR_H * 100).toFixed(0)} cm tall: ${(qa * 1e3).toFixed(1)} L/s; ${(TEAR_H / 16 * 100).toFixed(1)} cm slit: ${(qb * 1e3).toFixed(1)} L/s`);
  assert(Math.abs(qb / qa - 0.25) < 0.01, `slit/square ratio ${(qb / qa).toFixed(3)}, expected 0.25`);
});

test('A net flow past what the opening can run against shuts the exchange', () => {
  const { sim, conn } = torn();
  conn.massFlowRate = 0;
  const q0 = breakExchange(sim.state, conn)!.volumeFlow;
  conn.massFlowRate = 0.5 * q0 * 1000;     // half the exchange, outward
  const half = breakExchange(sim.state, conn);
  assert(half !== null && half.volumeFlow < q0 && half.volumeFlow > 0,
    'a moderate outflow should narrow the counter-current, not end it');
  conn.massFlowRate = 50 * q0 * 1000;      // far past it, outward
  assert(breakExchange(sim.state, conn) === null, 'a strong outflow leaves no room for air to come in');
  conn.massFlowRate = -50 * q0 * 1.2;      // far past it, inward (air)
  assert(breakExchange(sim.state, conn) === null, 'a strong inflow leaves no room for water to go out');
});

test('The torn tank drains down to the tear while air comes in, then stops', () => {
  const { sim } = torn();
  const tnk0 = sim.state.flowNodes.get('tnk')!;
  const water0 = tnk0.fluid.mass;
  const gas0 = Object.values(tnk0.fluid.ncg ?? {}).reduce((x, y) => x + y, 0);
  // Water down to the bottom of the tear: 4 m wide, so pi m2 per metre
  const areaPerM = Math.PI * 4;
  const waterAtTear = (TEAR_Z - TEAR_H / 2) * areaPerM * 996;
  run(sim, 900, 0.5);
  const tnk = sim.state.flowNodes.get('tnk')!;
  const gas = Object.values(tnk.fluid.ncg ?? {}).reduce((x, y) => x + y, 0);
  console.log(`  water ${(water0 / 1e3).toFixed(1)} -> ${(tnk.fluid.mass / 1e3).toFixed(1)} t ` +
    `(tear bottom holds ${(waterAtTear / 1e3).toFixed(1)} t), tank gas ${gas0.toFixed(0)} -> ${gas.toFixed(0)} mol, ` +
    `tank ${(tnk.fluid.pressure / 1e5).toFixed(3)} bar vs building ${(sim.state.flowNodes.get('bld')!.fluid.pressure / 1e5).toFixed(3)}`);
  assert(gas > gas0 * 1.5, 'air should have bubbled into the tank');
  assert(Math.abs(tnk.fluid.mass / waterAtTear - 1) < 0.05,
    `the tank should have drained to the tear (${(waterAtTear / 1e3).toFixed(1)} t), holds ${(tnk.fluid.mass / 1e3).toFixed(1)} t`);
});

report('Exchange flow');
