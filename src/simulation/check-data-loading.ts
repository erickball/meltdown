/**
 * Check if 35 bar (3.5 MPa) data points are being loaded correctly
 */

import { calculateState, diagnoseUVLookup } from './water-properties-v3.js';

// Trigger data load
calculateState(1000, 1e9, 1);

// Now let's look at ALL points near the query region in (logV, u) space
// Query: v=0.001213, u=1000 kJ/kg, logV=-2.916

// The 35 bar points should be at:
// - v=0.001208, u=986.1 kJ/kg -> logV = -2.918
// - v=0.001229, u=1033 kJ/kg -> logV = -2.911
// - Expected interpolated point: v=0.001218, u=1009.6 -> logV = -2.914

console.log('=== Data at 35 bar (3.5 MPa) ===\n');
console.log('Expected points from steam-table.txt:');
console.log('  230°C: v=0.001208, u=986.1, logV=' + Math.log10(0.001208).toFixed(4));
console.log('  240°C: v=0.001229, u=1033, logV=' + Math.log10(0.001229).toFixed(4));
console.log('');
console.log('Expected interpolated point:');
console.log('  ~235°C: v=0.001218, u=1009.6, logV=' + Math.log10(0.001218).toFixed(4));
console.log('');
console.log('Query point:');
console.log('  v=0.001213, u=1000, logV=' + Math.log10(0.001213).toFixed(4));

// Get nearest 20 points and look for 35 bar data
const diag = diagnoseUVLookup(1000e3, 0.001213);

console.log('\n\n=== Checking if 35 bar points are in nearest neighbors ===\n');

// Filter for points near 35 bar (3.5 MPa = 35e5 Pa)
// In the diagnosis output, P is in bar
const near35bar = diag.nearestPoints.filter(pt => pt.P_bar >= 30 && pt.P_bar <= 40);

console.log('Points in 30-40 bar range among nearest 10:');
if (near35bar.length > 0) {
  for (const pt of near35bar) {
    const v = Math.pow(10, pt.logV);
    console.log(`  idx=${pt.idx}: P=${pt.P_bar.toFixed(1)}bar, v=${v.toFixed(6)}, u=${(pt.u/1e3).toFixed(1)}, ${pt.phase}`);
  }
} else {
  console.log('  NONE FOUND!');
}

console.log('\n\n=== Distance comparison ===\n');

// Calculate distance to 35 bar points
const logV_query = Math.log10(0.001213);
const u_query = 1000e3;

const logV_35bar_230 = Math.log10(0.001208);
const u_35bar_230 = 986.1e3;

const logV_35bar_240 = Math.log10(0.001229);
const u_35bar_240 = 1033e3;

// The distance in (logV, u) space - need to know normalization
// The diagnose function uses some distance metric
const dist_230 = Math.sqrt(
  Math.pow(logV_35bar_230 - logV_query, 2) +
  Math.pow((u_35bar_230 - u_query) / 1e6, 2)  // Normalize u by 1e6 to match typical scaling
);

const dist_240 = Math.sqrt(
  Math.pow(logV_35bar_240 - logV_query, 2) +
  Math.pow((u_35bar_240 - u_query) / 1e6, 2)
);

console.log('Distance to 35 bar 230°C point: logV diff=' + (logV_35bar_230 - logV_query).toFixed(6) +
            ', u diff=' + ((u_35bar_230 - u_query)/1e3).toFixed(1) + ' kJ/kg');
console.log('Distance to 35 bar 240°C point: logV diff=' + (logV_35bar_240 - logV_query).toFixed(6) +
            ', u diff=' + ((u_35bar_240 - u_query)/1e3).toFixed(1) + ' kJ/kg');

console.log('\nCompare to nearest found points:');
for (const pt of diag.nearestPoints.slice(0, 5)) {
  const v = Math.pow(10, pt.logV);
  const logV_diff = pt.logV - logV_query;
  const u_diff = (pt.u - u_query) / 1e3;
  console.log(`  idx=${pt.idx}: P=${pt.P_bar.toFixed(0)}bar, logV diff=${logV_diff.toFixed(6)}, u diff=${u_diff.toFixed(1)} kJ/kg, reported dist=${pt.distance.toFixed(6)}`);
}

// The issue might be that the 35 bar points ARE in the data but the triangulation
// connects them to vapor points instead of forming liquid-only triangles

console.log('\n\n=== Key Insight ===\n');
console.log('The 35 bar points (P=3.5 MPa) may be in the data, but:');
console.log('1. The general Delaunay triangulation in (logV, u) space');
console.log('   connects points based on geometry, not pressure');
console.log('2. The 35 bar liquid points at u~1000 kJ/kg are very close');
console.log('   to the saturation curve (sat liquid at 3.5 MPa is at T=242.6°C)');
console.log('3. The triangulation may connect these to vapor points,');
console.log('   creating invalid triangles');
console.log('');
console.log('The compressed liquid triangulation uses (logP, u) space,');
console.log('which keeps isobars together. But lookupPressureFromUV uses');
console.log('the general (logV, u) triangulation.');
