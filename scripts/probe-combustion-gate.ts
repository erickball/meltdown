/**
 * Decompose the hydrogen burn rate into its factors, to see what actually
 * sets the sub-LFL rate: the composition gate g, or the bulk kinetics.
 *
 *   lambda = min(lambda_mix, lambda_kin) * g
 *   lambda_kin = A0 * exp(-TA/T)          A0 = 1e6 /s, TA = 12000 K
 *   lambda_mix = S_FLAME / V^(1/3)        S_FLAME = 3 m/s
 *   g          = gateAbove(fuelIndex, 1, 0.25) * ...
 */

const A0 = 1e6, TA = 12000, S_FLAME = 3;
const LFL = 0.04;

const gateAbove = (x: number, x0: number, w: number) => 1 / (1 + Math.exp(-(x - x0) / w));
const arrhenius = (T: number) => A0 * Math.exp(-TA / T);

console.log('=== The composition gate g vs fuel index (width 0.25 normalized) ===');
console.log('  xH2      %of LFL   fuelIndex   g_lower');
for (const xH2 of [0.005, 0.010, 0.0157, 0.020, 0.030, 0.040, 0.060, 0.080]) {
  const fi = xH2 / LFL;
  console.log(
    `${(xH2 * 100).toFixed(2).padStart(7)}% ${(fi * 100).toFixed(0).padStart(9)}% ` +
    `${fi.toFixed(3).padStart(11)} ${gateAbove(fi, 1, 0.25).toExponential(3).padStart(12)}`
  );
}

console.log('\n=== Bulk kinetics lambda_kin(T) with the current A0/TA ===');
console.log('    T(K)   lambda_kin(1/s)   e-fold time');
for (const T of [300, 400, 500, 600, 620, 700, 773, 850, 1000]) {
  const l = arrhenius(T);
  const tau = 1 / l;
  const s = tau > 3.15e7 ? `${(tau / 3.15e7).toFixed(1)} yr`
    : tau > 86400 ? `${(tau / 86400).toFixed(1)} d`
    : tau > 3600 ? `${(tau / 3600).toFixed(1)} h`
    : `${tau.toFixed(1)} s`;
  console.log(`${T.toString().padStart(8)} ${l.toExponential(3).padStart(17)}   ${s}`);
}

console.log('\n=== The lean test case: 1.57% H2, 620 K, 65 m3 vessel ===');
const xH2 = 0.0157, T = 620, V = 65;
const g = gateAbove(xH2 / LFL, 1, 0.25);
const lKin = arrhenius(T);
const lMix = S_FLAME / Math.cbrt(V);
const lambda = Math.min(lMix, lKin) * g;
console.log(`  g          = ${g.toExponential(3)}   <- gate is still ${(g * 100).toFixed(1)}% at 39% of the LFL`);
console.log(`  lambda_kin = ${lKin.toExponential(3)} /s  (e-fold ${(1 / lKin).toFixed(0)} s)`);
console.log(`  lambda_mix = ${lMix.toExponential(3)} /s  (kinetics is the binding limit)`);
console.log(`  lambda     = ${lambda.toExponential(3)} /s`);
console.log(`  burned in 120 s = ${((1 - Math.exp(-lambda * 120)) * 100).toFixed(2)}%   (observed 4.0%)`);

console.log('\n=== How much of it is the gate vs the kinetics? ===');
console.log(`  with g as-is (0.081):        ${((1 - Math.exp(-lambda * 120)) * 100).toFixed(2)}% in 120 s`);
const lambdaNoGate = Math.min(lMix, lKin);
console.log(`  with g = 1 (kinetics alone): ${((1 - Math.exp(-lambdaNoGate * 120)) * 100).toFixed(2)}% in 120 s`);
console.log(`  -> even a PERFECT gate cannot make this negligible; the bulk`);
console.log(`     Arrhenius alone burns ${((1 - Math.exp(-lambdaNoGate * 120)) * 100).toFixed(0)}% in two minutes at 620 K.`);

console.log('\n=== Why one global Arrhenius cannot be both inert at 620 K and prompt at 850 K ===');
const ratio = arrhenius(850) / arrhenius(620);
console.log(`  lambda_kin(850)/lambda_kin(620) = ${ratio.toFixed(0)}x with TA = ${TA} K`);
console.log(`  To be inert at 620 K (1e-6/s) AND prompt at 850 K (0.75/s) needs`);
const needRatio = 0.75 / 1e-6;
const needTA = Math.log(needRatio) / (1 / 620 - 1 / 850);
const needA0 = 0.75 * Math.exp(needTA / 850);
console.log(`  a ratio of ${needRatio.toExponential(1)} -> TA = ${needTA.toFixed(0)} K, A0 = ${needA0.toExponential(2)} /s`);
console.log(`  (elementary H + O2 -> OH + O has Ea ~ 70 kJ/mol, i.e. TA ~ 8400 K:`);
console.log(`   real autoignition sharpness is NOT a large activation energy, it is`);
console.log(`   the chain-branching crossover against H + O2 + M -> HO2 + M.)`);

console.log('\n  With that steeper pair:');
const arr2 = (T: number) => needA0 * Math.exp(-needTA / T);
for (const Tq of [500, 620, 700, 773, 850, 1000]) {
  const l = arr2(Tq);
  const tau = 1 / l;
  const s = tau > 3.15e7 ? `${(tau / 3.15e7).toExponential(1)} yr`
    : tau > 86400 ? `${(tau / 86400).toFixed(1)} d`
    : tau > 3600 ? `${(tau / 3600).toFixed(1)} h` : `${tau.toFixed(2)} s`;
  console.log(`    T=${Tq.toString().padStart(4)}  lambda=${l.toExponential(2).padStart(10)} /s   e-fold ${s}`);
}
