/**
 * Diagnose remaining round-trip failures
 */

import { diagnoseUVLookup, lookupCompressedLiquidDensity, saturationTemperature } from './water-properties-v3.js';

console.log('Analyzing remaining round-trip failures...\n');

// The failures from the test:
const failures = [
  // "No P found" failures - these have valid (P,u)->rho but fail (u,v)->P
  { P: 155e5, u: 1000e3, type: 'no_P' },
  { P: 160e5, u: 1000e3, type: 'no_P' },
  { P: 170e5, u: 1000e3, type: 'no_P' },

  // "No density found" failures - these fail at (P,u)->rho step
  { P: 50e5, u: 1500e3, type: 'no_rho' },
  { P: 50e5, u: 1600e3, type: 'no_rho' },
  { P: 50e5, u: 1650e3, type: 'no_rho' },
  { P: 80e5, u: 1650e3, type: 'no_rho' },
];

for (const test of failures) {
  console.log(`=== P=${(test.P/1e5).toFixed(0)} bar, u=${(test.u/1e3).toFixed(0)} kJ/kg ===`);

  // Check saturation conditions at this pressure
  const T_sat = saturationTemperature(test.P);
  console.log(`  T_sat at this P: ${(T_sat - 273.15).toFixed(1)}°C`);

  const rho = lookupCompressedLiquidDensity(test.P, test.u);
  if (rho === null) {
    console.log(`  (P,u)->rho: FAILED - no density found`);
    console.log(`  This point is likely ABOVE saturation (u > u_f at this P)`);
  } else {
    const v = 1 / rho;
    console.log(`  (P,u)->rho: rho=${rho.toFixed(2)} kg/m³, v=${v.toFixed(6)} m³/kg`);

    const diag = diagnoseUVLookup(test.u, v);
    console.log(`  (u,v)->P lookup:`);
    console.log(`    In grid: ${diag.inGrid}`);
    console.log(`    Found triangle: ${diag.foundTriangle}`);

    if (!diag.foundTriangle) {
      console.log(`    Nearest points:`);
      for (const pt of diag.nearestPoints.slice(0, 3)) {
        console.log(`      v=${Math.pow(10, pt.logV).toFixed(6)}, u=${(pt.u/1e3).toFixed(1)}kJ/kg, P=${pt.P_bar.toFixed(1)}bar, ${pt.phase}`);
      }
    }
  }
  console.log('');
}

// Summary
console.log('=== SUMMARY ===');
console.log('Failures at u=1000 kJ/kg are in compressed liquid region - triangulation gap');
console.log('Failures at u=1500-1650 kJ/kg at P=50-80 bar are above saturation - expected');
