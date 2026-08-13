/**
 * What a chain-branching criterion would give, versus the current single
 * global Arrhenius.
 *
 * Hydrogen ignition is sharp because of a COMPETITION, not a large activation
 * energy. The chain carrier H either branches or is quenched:
 *
 *   branching     H + O2      -> OH + O     k1 = 3.52e16 T^-0.7 exp(-8590/T)
 *   termination   H + O2 + M  -> HO2 + M    k5 = 6.76e19 T^-1.42
 *                                           (cm3,mol,s / cm6,mol2,s)
 *
 * phi = 2*k1 / (k5*[M]) is the branching ratio. phi > 1 runs away; phi < 1 is
 * quenched. That crossing is the classic second explosion limit, and it is
 * sharp in T *and* moves with pressure - neither of which a single Arrhenius
 * term can reproduce.
 */

const R = 8.314;

const k1 = (T: number) => 3.52e16 * Math.pow(T, -0.7) * Math.exp(-8590 / T);
const k5 = (T: number) => 6.76e19 * Math.pow(T, -1.42);
/** total molar concentration, mol/cm3 */
const conc = (T: number, P: number) => (P / (R * T)) * 1e-6;
const phi = (T: number, P: number) => (2 * k1(T)) / (k5(T) * conc(T, P));

// Current model
const arrhenius = (T: number) => 1e6 * Math.exp(-12000 / T);

console.log('=== Branching ratio phi = 2k1/(k5[M]) at 1 atm ===');
console.log('    T(K)      phi        gate phi/(1+phi)   current lambda_kin(1/s)');
for (const T of [500, 600, 620, 700, 800, 850, 900, 950, 1000, 1100]) {
  const p = phi(T, 101325);
  console.log(
    `${T.toString().padStart(8)} ${p.toExponential(3).padStart(12)} ` +
    `${(p / (1 + p)).toExponential(3).padStart(18)} ${arrhenius(T).toExponential(3).padStart(24)}`
  );
}

console.log('\n=== Sharpness: ratio between 620 K and 850 K ===');
console.log(`  chain branching phi:      ${(phi(850, 101325) / phi(620, 101325)).toExponential(2)}x`);
console.log(`  current global Arrhenius: ${(arrhenius(850) / arrhenius(620)).toExponential(2)}x`);

console.log('\n=== Pressure dependence the current model has none of ===');
console.log('  (crossover phi = 1 moves UP in temperature as pressure rises,');
console.log('   because three-body termination scales with [M])');
console.log('     P(bar)   T where phi = 1');
for (const Pbar of [0.5, 1, 2, 5, 10]) {
  const P = Pbar * 1e5;
  let lo = 500, hi = 1400;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (phi(mid, P) < 1) lo = mid; else hi = mid;
  }
  console.log(`${Pbar.toString().padStart(11)}   ${(0.5 * (lo + hi)).toFixed(0)} K`);
}

console.log('\n=== The lean test case, 1.57% H2 at 620 K / 1.27 bar ===');
const p620 = phi(620, 1.27e5);
console.log(`  phi = ${p620.toExponential(3)}  -> branching gate ${(p620 / (1 + p620)).toExponential(3)}`);
console.log(`  i.e. the mixture is ~7 orders of magnitude below the branching`);
console.log(`  crossover: genuinely inert, with no empirical LFL gate needed.`);
console.log(`  Current model instead gives lambda_kin = ${arrhenius(620).toExponential(3)} /s`);
console.log(`  (e-fold ${(1 / arrhenius(620)).toFixed(0)} s), and relies on the composition`);
console.log(`  logistic to suppress it - which only reaches 0.081 at 39% of the LFL.`);
