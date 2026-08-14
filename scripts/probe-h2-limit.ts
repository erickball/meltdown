/**
 * Where the second explosion limit lands with the operator's own numbers, and
 * whether steam inerting now falls out of the third-body chemistry instead of
 * being an added rule.
 */

const kBranch = (T: number) => 3.52e16 * Math.pow(T, -0.7) * Math.exp(-8590 / T);
const kTerminate = (T: number) => 2.90e19 * Math.pow(T, -1.42);
const R = 8.314;

/** alpha (1/s) for a gas of given composition at (T, P). */
function alpha(T: number, P: number, xO2: number, xSteam: number, xN2: number): number {
  const cTotal = (P / (R * T)) * 1e-6;                 // mol/cm3
  const cO2 = xO2 * cTotal;
  // third-body efficiencies: H2O 12, O2 0.78, N2 1.0
  const cM = cTotal * (xSteam * 12 + xO2 * 0.78 + xN2 * 1.0);
  return (2 * kBranch(T) - kTerminate(T) * cM) * cO2;
}

function crossover(P: number, xSteam: number): number {
  const xO2 = 0.21 * (1 - xSteam), xN2 = 0.79 * (1 - xSteam);
  let lo = 400, hi = 2000;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (alpha(mid, P, xO2, xN2 === 0 ? 0 : xSteam, xN2) < 0) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

console.log('=== Ignition threshold in dry air, vs pressure ===');
console.log('   P(bar)   T_crossover(K)   (C)');
for (const Pbar of [1, 2, 3, 5]) {
  const T = crossover(Pbar * 1e5, 0);
  console.log(`${Pbar.toString().padStart(9)} ${T.toFixed(0).padStart(16)}   ${(T - 273).toFixed(0)}`);
}

console.log('\n=== Steam inerting emerges from third-body efficiency (1 bar) ===');
console.log('  steam frac   T_crossover(K)   shift vs dry');
const dry = crossover(1e5, 0);
for (const xs of [0, 0.2, 0.4, 0.55, 0.7, 0.85]) {
  const T = crossover(1e5, xs);
  console.log(`${(xs * 100).toFixed(0).padStart(11)}% ${T.toFixed(0).padStart(16)}   +${(T - dry).toFixed(0)} K`);
}

console.log('\n=== The three plant-suite cases ===');
const cases: Array<[string, number, number, number, number, number]> = [
  // label, T, P, xO2, xSteam, xN2
  ['lean 1.57% H2, 620 K, 1.27 bar', 620, 1.27e5, 0.165, 0.196, 0.62],
  ['deflagration 12% H2, 620 K', 620, 1.3e5, 0.16, 0.19, 0.60],
  ['deflagration 12% H2, 950 K', 950, 1.3e5, 0.16, 0.19, 0.60],
  ['steam-inerted, 445 K', 445, 8e5, 0.02, 0.90, 0.07],
];
for (const [label, T, P, xO2, xSteam, xN2] of cases) {
  const a = alpha(T, P, xO2, xSteam, xN2);
  const verdict = a > 0 ? `IGNITES (induction ~${(23 / a).toExponential(1)} s)` : 'inert';
  console.log(`  ${label.padEnd(34)} alpha=${a.toExponential(3).padStart(11)} /s  -> ${verdict}`);
}
