/**
 * Check for interpolated points near the 3.5 MPa (35 bar) isobar
 * and near the query point (v=0.001213, u=1000 kJ/kg)
 */

import { calculateState, diagnoseUVLookup } from './water-properties-v3.js';

// Trigger data load
calculateState(1000, 1e9, 1);

// Query point
const v_target = 0.001213;  // m3/kg
const u_target = 1000e3;    // J/kg (1000 kJ/kg)

console.log('=== Checking points near query (v=0.001213, u=1000 kJ/kg) ===\n');

// Get diagnostic info which includes nearest points
const diag = diagnoseUVLookup(u_target, v_target);

console.log('Query point:');
console.log('  v = 0.001213 m3/kg');
console.log('  u = 1000 kJ/kg');
console.log('  logV =', Math.log10(v_target).toFixed(4));
console.log('');

console.log('Nearest 15 points (sorted by distance in logV-u space):');
console.log('');
console.log('  idx  |   v (m3/kg)   |  u (kJ/kg)  | P (bar) | phase           | dist');
console.log('-'.repeat(85));

for (const pt of diag.nearestPoints.slice(0, 15)) {
  const v = Math.pow(10, pt.logV);
  const P_bar = pt.P_bar;
  console.log(
    `${pt.idx.toString().padStart(5)} | ${v.toFixed(6).padStart(12)} | ${(pt.u/1e3).toFixed(1).padStart(10)} | ${P_bar.toFixed(1).padStart(7)} | ${pt.phase.padEnd(15)} | ${pt.distance.toFixed(6)}`
  );
}

// Now specifically look for points in the 30-50 bar range
console.log('\n\n=== Points in 30-50 bar range with u in [980, 1040] kJ/kg ===\n');

// The diagnose function gives us the 10 nearest, but we need to check more specifically
// Let's filter from nearestPoints for now
const inRange = diag.nearestPoints.filter(pt => {
  const P_bar = pt.P_bar;
  const u_kJ = pt.u / 1e3;
  return P_bar >= 30 && P_bar <= 50 && u_kJ >= 980 && u_kJ <= 1040;
});

if (inRange.length > 0) {
  console.log('Found', inRange.length, 'points in the target range:');
  console.log('');
  for (const pt of inRange) {
    const v = Math.pow(10, pt.logV);
    console.log(`  P=${pt.P_bar.toFixed(1)}bar, v=${v.toFixed(6)}, u=${(pt.u/1e3).toFixed(1)}kJ/kg, phase=${pt.phase}`);
  }
} else {
  console.log('No points found in 30-50 bar range with u in [980, 1040] kJ/kg among the 10 nearest.');
  console.log('This suggests the interpolated points are too far away in (logV, u) space.');
}

// Check what triangles contain these nearest points
console.log('\n\n=== Triangle analysis ===\n');
console.log('Found triangle:', diag.foundTriangle);
console.log('In grid:', diag.inGrid);

if (diag.triangleVertices) {
  console.log('\nTriangle vertices:');
  for (const vert of diag.triangleVertices) {
    const v = Math.pow(10, vert.logV);
    console.log(`  idx=${vert.idx}: v=${v.toFixed(6)}, u=${(vert.u/1e3).toFixed(1)}kJ/kg, P=${vert.P_bar.toFixed(1)}bar, ${vert.phase}`);
  }
}

// Summary of what we're looking for
console.log('\n\n=== Expected points (from user) ===\n');
console.log('Saturated liquid at 30 bar:');
console.log('  v ~ 0.001217, u ~ 1005.1 kJ/kg');
console.log('');
console.log('Interpolated sat. liquid (expected):');
console.log('  v ~ 0.001213, u ~ 996 kJ/kg');
console.log('');
console.log('3.5 MPa (35 bar) isobar original points:');
console.log('  230 C: v = 0.001208, u = 986.1 kJ/kg');
console.log('  240 C: v = 0.001229, u = 1033 kJ/kg');
console.log('  Gap = 46.9 kJ/kg (should trigger 1 interpolation point)');
console.log('');
console.log('Expected interpolated point at 35 bar:');
console.log('  v ~ 0.001218, u ~ 1009.6 kJ/kg');
