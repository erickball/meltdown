/**
 * The four liquid-water properties the wall coefficient runs on, against
 * IAPWS, across the range a plant visits.
 *
 * Usage: npx tsx scripts/check-liquid-props.ts
 */

import {
  liquidViscosity, liquidThermalConductivity,
  liquidSpecificHeat, liquidThermalExpansivity,
} from '../src/simulation/water-properties';

// IAPWS saturated-liquid values. mu (Pa s), k (W/m-K), cp (J/kg-K), beta (1/K)
const IAPWS: Array<[number, number, number, number, number]> = [
  // T(C)   mu        k       cp      beta
  [20, 1.002e-3, 0.598, 4184, 2.07e-4],
  [50, 5.47e-4, 0.644, 4181, 4.51e-4],
  [100, 2.82e-4, 0.679, 4217, 7.52e-4],
  [150, 1.82e-4, 0.683, 4310, 1.02e-3],
  [200, 1.34e-4, 0.665, 4497, 1.35e-3],
  [250, 1.06e-4, 0.618, 4857, 1.80e-3],
  [300, 8.60e-5, 0.545, 5750, 2.72e-3],
  [330, 7.75e-5, 0.487, 6900, 3.90e-3],
];

console.log('\n  T(C)      mu (model / IAPWS)        k (model / IAPWS)      ' +
  ' cp (model / IAPWS)       beta (model / IAPWS)');
console.log('  ' + '-'.repeat(108));

let worst = { name: '', err: 0, T: 0 };
for (const [Tc, mu, k, cp, beta] of IAPWS) {
  const T = Tc + 273.15;
  const m = { mu: liquidViscosity(T), k: liquidThermalConductivity(T),
    cp: liquidSpecificHeat(T), beta: liquidThermalExpansivity(T) };
  const e = (a: number, b: number) => (a / b - 1) * 100;
  for (const [name, got, ref] of [
    ['mu', m.mu, mu], ['k', m.k, k], ['cp', m.cp, cp], ['beta', m.beta, beta],
  ] as Array<[string, number, number]>) {
    if (Math.abs(e(got, ref)) > Math.abs(worst.err)) worst = { name, err: e(got, ref), T: Tc };
  }
  console.log(
    `  ${Tc.toString().padStart(4)}  ` +
    `${m.mu.toExponential(2)} / ${mu.toExponential(2)} ${(e(m.mu, mu) >= 0 ? '+' : '')}${e(m.mu, mu).toFixed(0)}%`.padEnd(26) +
    `${m.k.toFixed(3)} / ${k.toFixed(3)} ${(e(m.k, k) >= 0 ? '+' : '')}${e(m.k, k).toFixed(0)}%`.padEnd(24) +
    `${m.cp.toFixed(0)} / ${cp} ${(e(m.cp, cp) >= 0 ? '+' : '')}${e(m.cp, cp).toFixed(0)}%`.padEnd(25) +
    `${m.beta.toExponential(2)} / ${beta.toExponential(2)} ${(e(m.beta, beta) >= 0 ? '+' : '')}${e(m.beta, beta).toFixed(0)}%`);
}
console.log(`\n  worst: ${worst.name} at ${worst.T} C, ${worst.err.toFixed(0)}%`);

console.log('\n  Prandtl number, which is where three of them meet:');
console.log('   T(C)   Pr(model)   Pr(IAPWS)   (the code used a flat 2.0)');
for (const [Tc, mu, k, cp] of IAPWS) {
  const T = Tc + 273.15;
  const prModel = (liquidSpecificHeat(T) * liquidViscosity(T)) / liquidThermalConductivity(T);
  console.log(`  ${Tc.toString().padStart(5)} ${prModel.toFixed(2).padStart(11)} ` +
    `${((cp * mu) / k).toFixed(2).padStart(11)}`);
}

console.log('\n  Expansivity near the 4 C density maximum, where beta passes through zero:');
for (const Tc of [1, 3, 4, 5, 8, 20]) {
  console.log(`   ${Tc.toString().padStart(3)} C: beta = ` +
    `${liquidThermalExpansivity(Tc + 273.15).toExponential(2)}`);
}
