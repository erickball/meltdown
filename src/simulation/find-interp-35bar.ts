/**
 * Find interpolated points at 35 bar specifically
 */

import { calculateState, diagnoseUVLookup } from './water-properties-v3.js';

// Trigger data load
calculateState(1000, 1e9, 1);

// Look for points near 35 bar using a broader search
// The issue is that diagnoseUVLookup only returns 10 nearest points
// Let's search in a wider u range to find the 35 bar points

console.log('=== Searching for 35 bar (3.5 MPa) points ===\n');

// Search at different u values to find the 35 bar data
const testUs = [
  { u: 986e3, desc: '986 kJ/kg (35 bar 230°C)' },
  { u: 1009e3, desc: '1009 kJ/kg (expected interpolated)' },
  { u: 1033e3, desc: '1033 kJ/kg (35 bar 240°C)' },
  { u: 1000e3, desc: '1000 kJ/kg (query)' },
];

// Use expected v at 35 bar
const v_35bar_230 = 0.001208;
const v_35bar_240 = 0.001229;
const v_interp = (v_35bar_230 + v_35bar_240) / 2;  // ~0.001218

for (const test of testUs) {
  console.log(`\n--- Query: u=${(test.u/1e3).toFixed(0)} kJ/kg, v=${v_interp.toFixed(6)} (${test.desc}) ---`);

  const diag = diagnoseUVLookup(test.u, v_interp);

  // Look for 35 bar points
  const near35 = diag.nearestPoints.filter(pt => pt.P_bar >= 33 && pt.P_bar <= 37);

  if (near35.length > 0) {
    console.log('Found points at ~35 bar:');
    for (const pt of near35) {
      const v = Math.pow(10, pt.logV);
      console.log(`  idx=${pt.idx}: P=${pt.P_bar.toFixed(1)}bar, v=${v.toFixed(6)}, u=${(pt.u/1e3).toFixed(1)}, ${pt.phase}, dist=${pt.distance.toFixed(6)}`);
    }
  } else {
    console.log('No points at 35 bar in nearest 10');
    console.log('Nearest points:');
    for (const pt of diag.nearestPoints.slice(0, 5)) {
      const v = Math.pow(10, pt.logV);
      console.log(`  idx=${pt.idx}: P=${pt.P_bar.toFixed(1)}bar, v=${v.toFixed(6)}, u=${(pt.u/1e3).toFixed(1)}, ${pt.phase}, dist=${pt.distance.toFixed(6)}`);
    }
  }
}

// Now let's specifically search for ANY points at exactly 35 bar
console.log('\n\n=== Searching for points at exactly P=35 bar ===\n');

// Try different u values at the expected v for 35 bar
for (let u = 980; u <= 1040; u += 10) {
  const v = 0.001208 + (u - 986) / (1033 - 986) * (0.001229 - 0.001208);  // Interpolate v too
  const diag = diagnoseUVLookup(u * 1e3, v);

  const at35 = diag.nearestPoints.filter(pt => Math.abs(pt.P_bar - 35) < 1);
  if (at35.length > 0) {
    console.log(`u=${u} kJ/kg, v=${v.toFixed(6)}: Found ${at35.length} points at ~35 bar`);
    for (const pt of at35) {
      const v_pt = Math.pow(10, pt.logV);
      console.log(`  idx=${pt.idx}: P=${pt.P_bar.toFixed(1)}bar, v=${v_pt.toFixed(6)}, u=${(pt.u/1e3).toFixed(1)}, ${pt.phase}`);
    }
  }
}

console.log('\n\n=== Analysis ===\n');
console.log('The 35 bar points exist in the steam table at:');
console.log('  - v=0.001208, u=986.1 (230°C)');
console.log('  - v=0.001229, u=1033 (240°C)');
console.log('');
console.log('The gap is 46.9 kJ/kg, which should trigger 1 interpolated point.');
console.log('');
console.log('Expected interpolated point at 35 bar:');
console.log('  - v ~ 0.001218, u ~ 1009.5 kJ/kg');
console.log('');
console.log('But the distance metric in (logV, u/1e6) space means:');
console.log('  - Points with matching u are MUCH closer than points with matching P');
console.log('  - The 120 bar interpolated points at u=1000 are closest');
console.log('  - The 35 bar points at u=986 and u=1033 are far away');
