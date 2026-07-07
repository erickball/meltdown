/**
 * Fuel melting and fission-product release tests.
 *
 * Verifies:
 * 1. The apparent-heat-capacity latent plateau absorbs ~m*L crossing the
 *    melting range while temperature stalls.
 * 2. meltFraction ramps 0 -> 1 across the melting point.
 * 3. Arrhenius fission-product release: hot fuel releases Xe/CsI to the
 *    coolant with inventory conservation; cold fuel releases ~nothing.
 *
 * Run: npx tsx scripts/test-fuel-melt.ts
 */
import {
  meltFraction,
  nodeHeatCapacity,
  FissionProductReleaseOperator,
} from '../src/simulation/operators/rate-operators';
import type { ThermalNode, SimulationState } from '../src/simulation/types';
import { emptyGasComposition } from '../src/simulation/gas-properties';

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ' - ' + detail}`);
  if (!cond) failures++;
}

function makeFuelNode(T: number): ThermalNode {
  return {
    id: 'fuel', label: 'Test Fuel',
    temperature: T,
    mass: 80000, specificHeat: 300, thermalConductivity: 3,
    characteristicLength: 0.004, surfaceArea: 4000,
    heatGeneration: 0, maxTemperature: 2800,
    meltingPoint: 2800, latentHeatFusion: 274e3,
  };
}

// --- Test 1: latent plateau energy bookkeeping ------------------------------
{
  const node = makeFuelNode(2600);
  // March the node from 2600 K to 3000 K with explicit Euler on
  // dT = P / C_eff(T); count the energy required.
  const P = 200e6; // W
  const dt = 0.01;
  let energy = 0;
  let plateauTime = 0; // time spent within +-50 K of the melting point
  while (node.temperature < 3000) {
    const C = nodeHeatCapacity(node);
    node.temperature += (P / C) * dt;
    energy += P * dt;
    if (Math.abs(node.temperature - 2800) < 50) plateauTime += dt;
  }
  const sensible = node.mass * node.specificHeat * (3000 - 2600);
  const latent = node.mass * node.latentHeatFusion!;
  const expected = sensible + latent;
  const err = Math.abs(energy - expected) / expected;
  check('melting absorbs sensible + latent heat',
    err < 0.03,
    `expected ${(expected / 1e9).toFixed(2)} GJ, integrated ${(energy / 1e9).toFixed(2)} GJ (err ${(err * 100).toFixed(1)}%)`);
  // 80 t * 274 kJ/kg at 200 MW is ~110 s of plateau vs ~1.2 s per 100 K sensible
  check('temperature stalls across the melting range',
    plateauTime > 0.7 * (latent / P),
    `plateau ${plateauTime.toFixed(1)}s vs latent/P ${(latent / P).toFixed(1)}s`);
}

// --- Test 2: melt fraction ramp ---------------------------------------------
{
  const below = meltFraction(makeFuelNode(2600));
  const at = meltFraction(makeFuelNode(2800));
  const above = meltFraction(makeFuelNode(3000));
  check('meltFraction ~0 well below the melting point', below < 0.01, `got ${below.toFixed(4)}`);
  check('meltFraction 0.5 at the melting point', Math.abs(at - 0.5) < 1e-6, `got ${at.toFixed(4)}`);
  check('meltFraction ~1 well above the melting point', above > 0.99, `got ${above.toFixed(4)}`);
  const noMelt = meltFraction({ temperature: 5000 } as ThermalNode);
  check('nodes without melting data never melt', noMelt === 0, `got ${noMelt}`);
}

// --- Test 3: fission-product release ----------------------------------------
function makeReleaseState(T_fuel: number): SimulationState {
  const fuel = makeFuelNode(T_fuel);
  fuel.fissionProducts = { nobleGas: 700, volatile: 250, associatedCoolantNode: 'coolant' };
  const state: any = {
    time: 0,
    thermalNodes: new Map([[fuel.id, fuel]]),
    flowNodes: new Map([['coolant', {
      id: 'coolant', label: 'Coolant',
      fluid: {
        temperature: 600, pressure: 70e5, phase: 'vapor', quality: 1,
        mass: 10, internalEnergy: 3e7, flowRate: 0, ncg: emptyGasComposition(),
      },
      volume: 30, hydraulicDiameter: 0.01, flowArea: 5, elevation: 0,
    }]]),
    thermalConnections: [], convectionConnections: [], flowConnections: [],
    neutronics: { power: 0, precursorConcentration: 0 },
    components: { pumps: new Map(), valves: new Map(), checkValves: new Map(), controllers: new Map() },
  };
  return state as SimulationState;
}

{
  const op = new FissionProductReleaseOperator();

  // Hot fuel (2500 K): substantial release rate
  const hot = makeReleaseState(2500);
  const hotRates = op.computeRates(hot);
  const fuelRates = hotRates.thermalNodes.get('fuel')!;
  const coolRates = hotRates.flowNodes.get('coolant')!;
  check('hot fuel releases noble gas', (fuelRates.dFpNobleGas ?? 0) < -1e-3,
    `dNG=${fuelRates.dFpNobleGas}`);
  check('release conserves moles (fuel loss = coolant gain)',
    Math.abs((fuelRates.dFpNobleGas ?? 0) + (coolRates.dNcg?.Xe ?? 0)) < 1e-12 &&
    Math.abs((fuelRates.dFpVolatile ?? 0) + (coolRates.dNcg?.CsI ?? 0)) < 1e-12,
    `Xe ${coolRates.dNcg?.Xe} vs ${fuelRates.dFpNobleGas}; CsI ${coolRates.dNcg?.CsI} vs ${fuelRates.dFpVolatile}`);
  check('volatiles release slower than noble gases',
    Math.abs(fuelRates.dFpVolatile ?? 0) / 250 < Math.abs(fuelRates.dFpNobleGas ?? 0) / 700,
    `fractional rates vol=${(fuelRates.dFpVolatile ?? 0) / 250} ng=${(fuelRates.dFpNobleGas ?? 0) / 700}`);

  // Timescale sanity: at 2500 K, noble-gas fractional rate should sit in the
  // "minutes-to-tens-of-minutes" band
  const k_ng = Math.abs(fuelRates.dFpNobleGas ?? 0) / 700;
  check('release timescale at 2500 K is minutes-scale',
    k_ng > 1e-4 && k_ng < 1e-1, `k=${k_ng.toExponential(2)}/s`);

  // Warm fuel (1200 K): negligible
  const warm = makeReleaseState(1200);
  const warmRates = op.computeRates(warm);
  const warmFuel = warmRates.thermalNodes.get('fuel');
  const k_warm = Math.abs(warmFuel?.dFpNobleGas ?? 0) / 700;
  check('1200 K fuel releases very slowly (days-scale)', k_warm < 1e-6, `k=${k_warm.toExponential(2)}/s`);

  // Cold fuel (900 K): skipped entirely
  const cold = makeReleaseState(900);
  const coldRates = op.computeRates(cold);
  check('cold fuel releases nothing', coldRates.thermalNodes.size === 0, 'rates present');
}

console.log(failures === 0 ? '\n=== All fuel-melt tests passed ===' : `\n=== ${failures} FAILURES ===`);
process.exit(failures === 0 ? 0 : 1);
