/**
 * Sanity table for the wall heat-transfer model that replaced the hard-coded
 * h_natural = 50 W/m2-K.
 *
 * Runs the REAL composed path (vaporWallHeatTransfer) rather than its pieces,
 * across the cases the plants actually contain, so the numbers can be read
 * against the literature instead of trusted. Uchida's containment
 * correlation, h = 380 (m_steam/m_air)^0.7, is printed alongside as a
 * yardstick - it is not used by the model, which derives the same behaviour
 * from diffusion, and it sits at the conservative end of the data.
 *
 * Usage: npx tsx scripts/check-condensation.ts
 */

import { vaporWallHeatTransfer } from '../src/simulation/operators/rate-operators';
import { createFluidState } from '../src/simulation/operators';
import type { FlowNode, SimulationState } from '../src/simulation/types';
import { saturationTemperature } from '../src/simulation/water-properties';
import { emptyGasComposition } from '../src/simulation/gas-properties';

const tsatC = (P_Pa: number) => saturationTemperature(P_Pa) - 273.15;

/** A bare state with one node in it - enough for the coefficient path. */
function makeState(node: FlowNode): SimulationState {
  return {
    flowNodes: new Map([[node.id, node]]),
    flowConnections: [],
    thermalNodes: new Map(),
    thermalConnections: [],
    convectionConnections: [],
    radiationConnections: [],
  } as unknown as SimulationState;
}

function gasNode(opts: {
  steamMoles: number; ncgMoles: number; T: number; P: number;
  species?: 'air' | 'He'; volume?: number;
}): FlowNode {
  const volume = opts.volume ?? 1000;
  const fluid = createFluidState(opts.T, opts.P, 'vapor', 1, volume, undefined);
  fluid.pressure = opts.P;
  fluid.temperature = opts.T;
  fluid.mass = opts.steamMoles * 0.018015;
  const ncg = emptyGasComposition();
  if (opts.species === 'He') {
    ncg.He = opts.ncgMoles;
  } else {
    ncg.N2 = opts.ncgMoles * 0.79;
    ncg.O2 = opts.ncgMoles * 0.21;
  }
  fluid.ncg = ncg;
  return {
    id: 'test', label: 'test', fluid, volume,
    hydraulicDiameter: 5, flowArea: 25, height: 10, elevation: 0,
  } as FlowNode;
}

// ---------------------------------------------------------------------------
console.log('\n=== Dry-wall natural convection (no steam to condense) ===');
console.log('  case                                 L(m)  dT(K)   h_nat   (old model: 50)');
{
  const cases: Array<[string, number, number, number, number, 'air' | 'He']> = [
    // label, L, T_bulk, T_wall, P(bar), gas
    ['Xe-100 RPV in cavity air', 4.6, 300, 530, 1.0, 'air'],
    ['RCCS panel back face in air', 6.0, 320, 340, 1.0, 'air'],
    ['containment dome, mild dT', 20, 320, 330, 1.0, 'air'],
    ['small pipe in air', 0.1, 320, 370, 1.0, 'air'],
    ['helium space at 60 bar, hot wall', 2.0, 800, 900, 60, 'He'],
  ];
  for (const [label, L, T, Tw, Pbar, species] of cases) {
    const P = Pbar * 1e5;
    // Trace steam only: a dry gas space, so nothing condenses anywhere.
    const nNcg = (P * 1000) / (8.31446 * T);
    const n = gasNode({ steamMoles: nNcg * 1e-6, ncgMoles: nNcg, T, P, species });
    const h = vaporWallHeatTransfer(n, makeState(n), L, Tw);
    console.log(`  ${label.padEnd(35)} ${L.toFixed(2).padStart(5)} ${(Tw - T).toFixed(0).padStart(6)} ` +
      `${h.natural.toFixed(1).padStart(7)}   cond=${h.condensation.toFixed(1)}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== Condensation on a containment wall (3 bar, 20 K subcooling) ===');
console.log('  steam%  T_bulk  T_wall   h_nat   h_cond   h_total   Uchida   ratio');
{
  for (const steamFrac of [0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 0.99, 1.0]) {
    const P = 3e5;
    const T_bulk = 273.15 + tsatC(steamFrac * P);
    const T_wall = T_bulk - 20;
    const totalMoles = (P * 1000) / (8.31446 * T_bulk);
    const nSteam = totalMoles * steamFrac;
    const nNcg = totalMoles - nSteam;
    const n = gasNode({ steamMoles: nSteam, ncgMoles: nNcg, T: T_bulk, P });
    const h = vaporWallHeatTransfer(n, makeState(n), 5, T_wall);
    const mSteam = nSteam * 0.018015;
    const mAir = nNcg * 0.029;
    const uchida = mAir > 0 ? 380 * Math.pow(mSteam / mAir, 0.7) : NaN;
    console.log(
      `  ${(100 * steamFrac).toFixed(0).padStart(6)} ` +
      `${(T_bulk - 273.15).toFixed(1).padStart(7)} ${(T_wall - 273.15).toFixed(1).padStart(7)} ` +
      `${h.natural.toFixed(1).padStart(7)} ${h.condensation.toFixed(0).padStart(8)} ` +
      `${h.total.toFixed(0).padStart(9)} ` +
      `${(Number.isFinite(uchida) ? uchida.toFixed(0) : 'n/a').padStart(8)} ` +
      `${(Number.isFinite(uchida) ? (h.total / uchida).toFixed(2) : '-').padStart(7)}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== The dew-point crossing is continuous ===');
{
  const P = 3e5, T_bulk = 273.15 + tsatC(0.5 * P) + 30;   // superheated bulk
  const dew = 273.15 + tsatC(0.5 * P);
  const totalMoles = (P * 1000) / (8.31446 * T_bulk);
  for (const offset of [10, 2, 0.5, 0, -0.5, -2, -10]) {
    const n = gasNode({
      steamMoles: totalMoles * 0.5, ncgMoles: totalMoles * 0.5, T: T_bulk, P,
    });
    const h = vaporWallHeatTransfer(n, makeState(n), 5, dew + offset);
    console.log(`  wall ${(offset >= 0 ? '+' : '')}${offset} K vs dew point: ` +
      `h_cond = ${h.condensation.toFixed(2).padStart(7)}, h_total = ${h.total.toFixed(2)}`);
  }
}
