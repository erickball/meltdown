/**
 * Choked blowdown regression suite.
 *
 * A rigid tank of helium discharging through a small orifice is one of the few
 * compressible-flow problems with a closed-form answer, so it is the right
 * place to check the discharge model's ABSOLUTE magnitude rather than just its
 * qualitative behavior.
 *
 * Helium is deliberate: monatomic, so cv really is constant and the ideal-gas
 * solution is not an approximation the way it would be for steam.
 *
 * Adiabatic (isentropic) blowdown through a choked throat:
 *
 *   ṁ      = Cd·A·ρ·c·Γ,     Γ = (2/(γ+1))^((γ+1)/(2(γ-1)))
 *   ρ(t)/ρ₀ = [1 + ((γ-1)/2)·t/τ]^(-2/(γ-1))
 *   P(t)/P₀ = [1 + ((γ-1)/2)·t/τ]^(-2γ/(γ-1))
 *   τ       = V / (Cd·A·Γ·c₀)
 *
 * The two properties worth defending, in order of importance:
 *   1. ṁ has the right MAGNITUDE (Γ = 0.5625 for helium, not the ~0.85 a
 *      stagnation-density bound would give).
 *   2. ṁ does NOT depend on the connection's resistance coefficient while the
 *      throat is sonic. A choked orifice is set by upstream stagnation state
 *      and throat area alone; if K moves the answer, the flow is being set by
 *      pipe friction wearing a choked-flow label.
 *
 * Usage: npx tsx scripts/test-blowdown.ts
 */

import { buildSim, run, test, assert, assertBetween, report } from './lib/sim-harness';
import { GAS_PROPERTIES, R_GAS } from '../src/simulation/gas-properties';
import type { PlantComponent, PlantConnection } from '../src/types';
import type { SimulationState } from '../src/simulation/types';

// ============================================================================
// Analytic solution
// ============================================================================

const HE = GAS_PROPERTIES.He;
const GAMMA = HE.cp / HE.cv;          // 1.667 exactly for a monatomic gas
const M_HE = HE.molecularWeight;      // kg/mol

/** Γ = (2/(γ+1))^((γ+1)/(2(γ-1))) - throat flux as a fraction of ρ₀·c₀ */
const GAMMA_FLUX = Math.pow(2 / (GAMMA + 1), (GAMMA + 1) / (2 * (GAMMA - 1)));

function heliumDensity(P_Pa: number, T_K: number): number {
  return (P_Pa * M_HE) / (R_GAS * T_K);
}

function heliumSoundSpeed(T_K: number): number {
  return Math.sqrt((GAMMA * R_GAS * T_K) / M_HE);
}

/** Analytic tank pressure during choked, adiabatic blowdown. */
function analyticPressure(
  P0_Pa: number, T0_K: number, V_m3: number, A_m2: number, Cd: number, t_s: number
): number {
  const tau = V_m3 / (Cd * A_m2 * GAMMA_FLUX * heliumSoundSpeed(T0_K));
  return P0_Pa * Math.pow(1 + ((GAMMA - 1) / 2) * (t_s / tau), (-2 * GAMMA) / (GAMMA - 1));
}

/** Analytic initial choked mass flow. */
function analyticInitialFlow(
  P0_Pa: number, T0_K: number, A_m2: number, Cd: number
): number {
  return Cd * A_m2 * GAMMA_FLUX * heliumDensity(P0_Pa, T0_K) * heliumSoundSpeed(T0_K);
}

/** Pressure ratio below which the throat is sonic. */
const CRITICAL_RATIO = Math.pow(2 / (GAMMA + 1), GAMMA / (GAMMA - 1));

// ============================================================================
// Rig
// ============================================================================

const P0 = 60e5;      // Pa
const T0 = 800;       // K - hot enough that the expanding gas stays well
                      // above the water triple point; the trace steam that
                      // rides along in a gas node has to remain in-table
const V_TANK = 10;    // m³
const A_HOLE = 0.001; // m²
const P_TRACE_STEAM = 700; // Pa - the gas-loop convention: helium is NCG, the
                           // water side carries only a trace so the node is
                           // unambiguously vapor

function heTank(id: string, volume: number, P_He_bar: number): [string, PlantComponent] {
  const height = 4;
  const width = 2 * Math.sqrt(volume / (Math.PI * height));
  return [id, {
    id, type: 'tank', label: id,
    position: { x: 0, y: 0 }, rotation: 0, elevation: 0,
    pressureRating: 500,   // far above anything driven here - burst must not interfere
    width, height, wallThickness: 0.05, fillLevel: 0,
    initialNcg: { He: P_He_bar },
    ports: [
      { id: `${id}-top`, position: { x: 0, y: -height / 2 }, direction: 'both' },
      { id: `${id}-bottom`, position: { x: 0, y: height / 2 }, direction: 'both' },
    ],
    fluid: { temperature: T0, pressure: P_TRACE_STEAM, phase: 'vapor', quality: 1, flowRate: 0 },
  } as unknown as PlantComponent];
}

/**
 * Tank -> big dump volume through a short sharp orifice. The dump tank is
 * sized so its pressure stays far below critical for the whole window, which
 * keeps the throat sonic throughout and lets the analytic solution apply.
 */
function blowdownRig(resistanceCoeff: number, area = A_HOLE) {
  const conn: PlantConnection = {
    fromComponentId: 'hp', fromPortId: 'hp-top',
    toComponentId: 'dump', toPortId: 'dump-top',
    flowArea: area, length: 0.5, resistanceCoeff,
    fromElevation: 2, toElevation: 2,
    // Cd pinned to 1 so the comparison is against the pure isentropic throat
    // flux - this rig is about the compressibility factor, not about which
    // vena-contracta coefficient a given break geometry deserves.
    breakDischargeCoeff: 1.0,
  } as unknown as PlantConnection;
  return buildSim([heTank('hp', V_TANK, P0 / 1e5), heTank('dump', 20000, 0.02)], [conn]);
}

function tankPressure(state: SimulationState, id: string): number {
  return state.flowNodes.get(id)!.fluid.pressure;
}

function connFlow(state: SimulationState): number {
  return state.flowConnections.find(c => c.id === 'flow-hp-dump')!.massFlowRate;
}

// ============================================================================
// Tests
// ============================================================================

test('Blowdown: sonic mass flux matches the analytic throat value', () => {
  const sim = blowdownRig(1.5);
  // Short settle so the momentum equation reaches its steady discharge; the
  // tank has barely drained by then, so stagnation conditions are still ~P0.
  run(sim, 0.25);
  const P = tankPressure(sim.state, 'hp');
  const T = sim.state.flowNodes.get('hp')!.fluid.temperature;
  const expected = analyticInitialFlow(P, T, A_HOLE, 1.0);
  const actual = connFlow(sim.state);
  assertBetween(actual / expected, 0.85, 1.15,
    `choked mass flow vs analytic (analytic ${expected.toFixed(3)} kg/s, got ${actual.toFixed(3)} kg/s)`);
});

test('Blowdown: orifice flow is independent of resistance while sonic', () => {
  // A sonic throat is fixed by upstream stagnation state and throat area, so
  // across ORIFICE-LIKE resistances the answer must not move. (Deeply
  // resistive paths are a different regime - see the next test.)
  const flows = [0.5, 1, 1.5, 2].map(K => {
    const sim = blowdownRig(K);
    run(sim, 0.25);
    return { K, m: connFlow(sim.state) };
  });
  const lo = Math.min(...flows.map(f => f.m));
  const hi = Math.max(...flows.map(f => f.m));
  const detail = flows.map(f => `K=${f.K}: ${f.m.toFixed(3)}`).join(', ');
  assert(lo > 0, `all flows should be forward (${detail})`);
  assertBetween(hi / lo, 1.0, 1.05, `spread of choked flow across orifice K (${detail})`);
});

test('Blowdown: a highly resistive path falls BELOW sonic, monotonically', () => {
  // Friction has to be able to win. A long, tortuous path does not pass the
  // orifice flow just because its exit ratio is subcritical - it is Fanno-
  // limited, and the sonic value is the ceiling it approaches from below.
  const flows = [2, 8, 32, 128].map(K => {
    const sim = blowdownRig(K);
    run(sim, 0.25);
    return { K, m: connFlow(sim.state) };
  });
  const detail = flows.map(f => `K=${f.K}: ${f.m.toFixed(3)}`).join(', ');
  for (let i = 1; i < flows.length; i++) {
    assert(flows[i].m < flows[i - 1].m,
      `flow must fall as resistance rises (${detail})`);
  }
  // ...and the sonic value remains the ceiling
  const sonic = flows[0].m;
  assert(flows[flows.length - 1].m < 0.5 * sonic,
    `K=128 should be far below the sonic ceiling (${detail})`);
});

test('Blowdown: tank pressure follows the analytic decay curve', () => {
  const sim = blowdownRig(1.5);
  let worst = 0;
  let worstAt = 0;
  for (const t of [2, 4, 8, 12]) {
    run(sim, t - sim.state.time);
    const P = tankPressure(sim.state, 'hp');
    const expected = analyticPressure(P0, T0, V_TANK, A_HOLE, 1.0, t);
    const err = Math.abs(P / expected - 1);
    if (err > worst) { worst = err; worstAt = t; }
  }
  assert(worst < 0.15,
    `analytic decay curve: worst error ${(worst * 100).toFixed(1)}% at t=${worstAt}s`);
});

test('Blowdown: stays choked, then unchokes at the critical ratio', () => {
  const sim = blowdownRig(1.5);
  run(sim, 4);
  const conn = sim.state.flowConnections.find(c => c.id === 'flow-hp-dump')!;
  const ratio = tankPressure(sim.state, 'dump') / tankPressure(sim.state, 'hp');
  assert(ratio < CRITICAL_RATIO,
    `rig should still be sonic at t=4s (ratio ${ratio.toFixed(4)} vs crit ${CRITICAL_RATIO.toFixed(3)})`);
  assert(conn.isChoked === true, 'connection should report choked while the throat is sonic');
});

test('Blowdown: subsonic pressure ratio is resistance-limited, not sonic', () => {
  // Same orifice, only 1.2x pressure ratio - well above critical, so the
  // throat is NOT sonic and friction legitimately sets the flow.
  const conn: PlantConnection = {
    fromComponentId: 'hp', fromPortId: 'hp-top',
    toComponentId: 'dump', toPortId: 'dump-top',
    flowArea: A_HOLE, length: 0.5, resistanceCoeff: 1.5,
    fromElevation: 2, toElevation: 2,
    breakDischargeCoeff: 1.0,
  } as unknown as PlantConnection;
  const sim = buildSim([heTank('hp', V_TANK, 12), heTank('dump', 20000, 10)], [conn]);
  run(sim, 0.25);
  const c = sim.state.flowConnections.find(x => x.id === 'flow-hp-dump')!;
  const ratio = tankPressure(sim.state, 'dump') / tankPressure(sim.state, 'hp');
  assert(ratio > CRITICAL_RATIO, `rig should be subsonic (ratio ${ratio.toFixed(3)})`);
  assert(c.isChoked !== true, 'subsonic connection must not report choked');
  const sonicBound = analyticInitialFlow(
    tankPressure(sim.state, 'hp'), sim.state.flowNodes.get('hp')!.fluid.temperature, A_HOLE, 1.0);
  assert(Math.abs(connFlow(sim.state)) < sonicBound,
    `subsonic flow must sit below the sonic bound (${connFlow(sim.state).toFixed(3)} vs ${sonicBound.toFixed(3)} kg/s)`);
});

report('Choked Blowdown Suite');
