/**
 * Probe: thermodynamic state of a helium volume with a small amount of steam.
 *
 * Sweeps water mass over many decades at fixed helium inventory and fixed
 * TOTAL internal energy per unit water added, and reports the (T, P, phase)
 * that FluidStateConstraintOperator produces. A physically consistent model
 * must be smooth in water mass: P_total should rise monotonically and
 * continuously as steam is injected into the gas space.
 *
 * Usage: npx tsx scripts/probe-he-steam.ts
 */

import { FluidStateConstraintOperator } from '../src/simulation/operators/rate-operators';
import { preloadWaterProperties } from '../src/simulation/water-properties-v4';
import { emptyGasComposition, mixtureCv, R_GAS } from '../src/simulation/gas-properties';
import type { SimulationState, FlowNode } from '../src/simulation/types';

await preloadWaterProperties();

function blankState(node: FlowNode): SimulationState {
  return {
    time: 0,
    thermalNodes: new Map(),
    flowNodes: new Map([[node.id, node]]),
    thermalConnections: [],
    convectionConnections: [],
    flowConnections: [],
    neutronics: {} as any,
    components: {
      pumps: new Map(), valves: new Map(), checkValves: new Map(), controllers: new Map(),
    },
  };
}

// Xe-100-like SG primary (helium) side
const V = 20;          // m³
const T0 = 750;        // K  (~477 C, He between core outlet and SG outlet)
const P_He = 60e5;     // Pa

const he = emptyGasComposition();
he.He = (P_He * V) / (R_GAS * T0);
const Cv_He = mixtureCv(he);
const U_he = he.He * Cv_He * T0;

console.log(`Helium: ${he.He.toFixed(1)} mol, Cv=${Cv_He.toFixed(2)} J/mol-K, U=${(U_he / 1e6).toFixed(2)} MJ`);
console.log(`Volume ${V} m³, T0=${T0} K, P_He=${(P_He / 1e5).toFixed(2)} bar\n`);

// Steam injected at the same temperature: u_g ~ 2.375e6 + 1900*(T-273)
const u_steam = 2375000 + 1900 * (T0 - 273);

const op = new FluidStateConstraintOperator();

console.log('   m_water(kg)   v_water(m3/kg)        T(K)      P(bar)   P_steam(bar)   phase     x');
console.log('-'.repeat(95));

let prevP: number | null = null;
let prevM = 0;
const rows: Array<{ m: number; T: number; P: number; phase: string }> = [];

for (let e = -6; e <= 3.001; e += 0.125) {
  const m = Math.pow(10, e);
  const node: FlowNode = {
    id: 'sg-primary',
    label: 'SG primary',
    fluid: {
      mass: m,
      internalEnergy: U_he + m * u_steam,
      temperature: T0,
      pressure: P_He,
      phase: 'vapor',
      quality: 1,
      ncg: { ...he },
    },
    volume: V,
    hydraulicDiameter: 0.05,
    flowArea: 1,
    height: 10,
    elevation: 0,
  };

  const st = blankState(node);
  op.applyConstraintsMutating(st);
  const f = st.flowNodes.get('sg-primary')!.fluid;
  const P_ncg = (he.He * R_GAS * f.temperature) / V;
  const P_steam = f.pressure - P_ncg;

  const jump = prevP !== null && Math.abs(f.pressure - prevP) > 0.05 * Math.abs(prevP) + 5e3;
  rows.push({ m, T: f.temperature, P: f.pressure, phase: f.phase });

  console.log(
    `${m.toExponential(3).padStart(13)} ${(V / m).toExponential(3).padStart(15)} ` +
    `${f.temperature.toFixed(2).padStart(11)} ${(f.pressure / 1e5).toFixed(4).padStart(11)} ` +
    `${(P_steam / 1e5).toFixed(5).padStart(14)}   ${f.phase.padEnd(10)} ${(f.quality ?? 0).toFixed(4)}` +
    (jump ? `   <-- JUMP from ${(prevP! / 1e5).toFixed(4)} bar (m was ${prevM.toExponential(2)})` : '')
  );
  prevP = f.pressure;
  prevM = m;
}

// Monotonicity / smoothness summary
console.log('\nSmoothness check (d ln P_total / d ln m should be smooth and >= 0):');
for (let i = 1; i < rows.length; i++) {
  const dlnP = Math.log(rows[i].P / rows[i - 1].P);
  const dlnm = Math.log(rows[i].m / rows[i - 1].m);
  const slope = dlnP / dlnm;
  if (slope < -1e-6 || slope > 2) {
    console.log(`  m=${rows[i].m.toExponential(3)}: slope=${slope.toFixed(4)} ` +
      `(P ${(rows[i - 1].P / 1e5).toFixed(4)} -> ${(rows[i].P / 1e5).toFixed(4)} bar, ` +
      `T ${rows[i - 1].T.toFixed(1)} -> ${rows[i].T.toFixed(1)} K, ` +
      `phase ${rows[i - 1].phase} -> ${rows[i].phase})`);
  }
}
console.log('done');
