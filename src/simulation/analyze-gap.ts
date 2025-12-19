/**
 * Analyze the gap around u=1000 kJ/kg
 */

import { diagnoseUVLookup, lookupCompressedLiquidDensity } from './water-properties-v3.js';

console.log('Analyzing liquid data near u=1000 kJ/kg, v=0.00120 m³/kg...\n');

// The query point
const u_target = 1000e3; // J/kg
const v_target = 0.001203; // m³/kg

const diag = diagnoseUVLookup(u_target, v_target);

console.log('Nearest 10 data points to query (u=1000 kJ/kg, v=0.00120):');
console.log('idx      | v (m³/kg)   | u (kJ/kg) | P (bar) | phase');
console.log('-'.repeat(70));

for (const pt of diag.nearestPoints) {
  const v = Math.pow(10, pt.logV);
  console.log(`${pt.idx.toString().padStart(6)} | ${v.toFixed(6).padStart(11)} | ${(pt.u/1e3).toFixed(1).padStart(9)} | ${pt.P_bar.toFixed(1).padStart(7)} | ${pt.phase}`);
}

// Now let's understand what's happening:
// The steam table has liquid data at specific (P, T) pairs
// At T=235°C (u≈1000 kJ/kg), what pressures have liquid data?
// - Below ~30 bar: two-phase region (T_sat at 30 bar ≈ 234°C)
// - At 30 bar: saturated liquid (exactly at T_sat)
// - Above 30 bar: should be compressed liquid, but data might be sparse

console.log('\n\nThe problem: At u≈1000 kJ/kg (T≈235°C), the steam table has:');
console.log('  - Saturated liquid at P≈30 bar (T_sat≈234°C)');
console.log('  - Liquid data at P=250-300 bar');
console.log('  - But no liquid data in the 50-200 bar range!');
console.log('\nThis creates a triangulation gap where query points like');
console.log('(u=1000, v=0.00120, actual P=155 bar) fall outside all triangles.');
