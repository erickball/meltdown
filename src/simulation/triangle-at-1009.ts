/**
 * Check what triangle contains query at u=1009 kJ/kg
 * (where the 35 bar interpolated point exists)
 */

import { calculateState, diagnoseUVLookup, lookupPressureFromUV } from './water-properties-v3.js';

// Trigger data load
calculateState(1000, 1e9, 1);

console.log('=== Triangle analysis at different u values ===\n');

// The interpolated 35 bar point is at u=1009.5 kJ/kg
// Let's check what triangles form at different query points

const tests = [
  { v: 0.001218, u: 1009.5e3, desc: 'exact interpolated 35 bar point' },
  { v: 0.001215, u: 1005e3, desc: 'between 30 bar sat (1005) and 35 bar (1009.5)' },
  { v: 0.001213, u: 1000e3, desc: 'target query (50 bar case)' },
  { v: 0.001213, u: 995e3, desc: 'slightly below target' },
];

for (const test of tests) {
  console.log(`\n--- Query: v=${test.v.toFixed(6)}, u=${(test.u/1e3).toFixed(1)} kJ/kg (${test.desc}) ---`);

  const diag = diagnoseUVLookup(test.u, test.v);

  console.log(`Found triangle: ${diag.foundTriangle}`);

  if (diag.triangleVertices) {
    console.log('Triangle vertices:');
    for (const vert of diag.triangleVertices) {
      const v = Math.pow(10, vert.logV);
      console.log(`  idx=${vert.idx}: P=${vert.P_bar.toFixed(1)}bar, v=${v.toFixed(6)}, u=${(vert.u/1e3).toFixed(1)}, ${vert.phase}`);
    }

    // Check if triangle mixes liquid and vapor
    const phases = diag.triangleVertices.map(v => v.phase);
    const hasLiquid = phases.some(p => p === 'liquid' || p === 'saturated liquid');
    const hasVapor = phases.some(p => p === 'vapor' || p === 'saturated vapor');

    if (hasLiquid && hasVapor) {
      console.log('  WARNING: Triangle mixes liquid and vapor phases!');
    }
  }

  // Try the lookup
  const P_lookup = lookupPressureFromUV(test.u, test.v);
  console.log(`lookupPressureFromUV result: ${P_lookup ? (P_lookup/1e5).toFixed(2) + ' bar' : 'null (rejected/not found)'}`);

  // Show 5 nearest points
  console.log('5 nearest points:');
  for (const pt of diag.nearestPoints.slice(0, 5)) {
    const v = Math.pow(10, pt.logV);
    console.log(`  idx=${pt.idx}: P=${pt.P_bar.toFixed(1)}bar, v=${v.toFixed(6)}, u=${(pt.u/1e3).toFixed(1)}, ${pt.phase}`);
  }
}

console.log('\n\n=== Key Observation ===\n');
console.log('If lookupPressureFromUV returns null at u=1000 kJ/kg but works at u=1005 or 1009,');
console.log('then the issue is that no valid liquid-only triangle contains u=1000.');
console.log('');
console.log('The solution might be to:');
console.log('1. Add more interpolated points at lower u values (below 1005 kJ/kg) at low pressures');
console.log('2. Or use the compressed liquid (P,u)->rho lookup result directly');
console.log('   and skip the (u,v)->P verification for points near saturation');
