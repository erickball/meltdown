/**
 * Diagnostic: print the hot-wall boiling curve q(dT) at a few pressures.
 * Expect the classic N-shape: nucleate rise to ~CHF, transition collapse
 * past the boiling crisis, slow film-boiling recovery with radiation
 * dominating at high superheat.
 *
 * Run: npx tsx scripts/check-boiling-curve.ts
 */
import { boilingCurve } from '../src/simulation/operators/rate-operators';

const cases = [
  { label: '1 bar (T_sat=373 K)', T: 373.15, P: 1.013e5 },
  { label: '70 bar (T_sat=559 K)', T: 559.0, P: 70e5 },
  { label: '155 bar (T_sat=618 K)', T: 618.0, P: 155e5 },
  { label: '215 bar (T_sat=643 K, near-critical)', T: 643.0, P: 215e5 },
];
const D = 0.0095; // fuel-rod-ish diameter
const h_conv = 500; // typical convective floor, scaled by f as in the operator

for (const c of cases) {
  console.log(`\n=== ${c.label} ===`);
  console.log('  dT[K]    f      h[W/m2K]   q[kW/m2]');
  for (const dT of [1, 3, 5, 10, 15, 20, 25, 30, 40, 60, 80, 100, 150, 200, 300, 500, 800, 1200]) {
    const { wettedFraction, h_phaseChange } = boilingCurve(c.T, c.P, c.T + dT, D);
    const h = wettedFraction * h_conv + h_phaseChange;
    const q = h * dT;
    console.log(
      `  ${dT.toString().padStart(5)}  ${wettedFraction.toFixed(3)}  ${h.toFixed(0).padStart(9)}  ${(q / 1000).toFixed(1).padStart(9)}`
    );
  }
}
