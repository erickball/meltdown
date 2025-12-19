/**
 * Round-trip verification test runner
 * Run with: npx tsx src/simulation/roundtrip-test.ts
 */

import {
  setRoundTripVerification,
  runRoundTripTests,
  verifyPressureDensityRoundTrip,
  getCompressedLiquidDomainInfo,
  calculateState,
  diagnoseUVLookup,
  lookupCompressedLiquidDensity,
} from './water-properties-v3.js';

// Enable verbose logging
setRoundTripVerification(true);

// Trigger data loading by calling calculateState once
console.log('Triggering data load...');
calculateState(1000, 1e9, 1);  // dummy call to force data loading
console.log('');

console.log('='.repeat(70));
console.log('Round-Trip Verification Tests for (P,u)->ρ Interpolation');
console.log('='.repeat(70));
console.log('');

// First, check the compressed liquid domain info
const domainInfo = getCompressedLiquidDomainInfo();
console.log('Compressed Liquid Domain Info:');
console.log(`  Ready: ${domainInfo.ready}`);
console.log(`  Points: ${domainInfo.numPoints}`);
console.log(`  Triangles: ${domainInfo.numTriangles}`);
if (domainInfo.P_range_bar) {
  console.log(`  P range: ${domainInfo.P_range_bar[0].toFixed(2)} - ${domainInfo.P_range_bar[1].toFixed(2)} bar`);
}
if (domainInfo.u_range_kJ) {
  console.log(`  u range: ${domainInfo.u_range_kJ[0].toFixed(1)} - ${domainInfo.u_range_kJ[1].toFixed(1)} kJ/kg`);
}
console.log('');
console.log('Testing: P,u → ρ (lookup) → v=1/ρ → P (calculateState) → compare');
console.log('');

// Run the batch tests
const summary = runRoundTripTests();

console.log('');
console.log('='.repeat(70));
console.log('Detailed Results for Points with Errors > 5%:');
console.log('='.repeat(70));

for (const r of summary.results) {
  if (r.success && r.P_error_pct !== null && r.P_error_pct > 5) {
    console.log(`  P_in=${(r.P_input/1e5).toFixed(1)}bar, u=${(r.u_input/1e3).toFixed(0)}kJ/kg`);
    console.log(`    ρ_interp=${r.rho_interp?.toFixed(2)}kg/m³, v=${r.v_derived?.toFixed(6)}m³/kg`);
    console.log(`    P_recovered=${(r.P_recovered!/1e5).toFixed(2)}bar`);
    console.log(`    Error: ${r.P_error_pct?.toFixed(2)}% (${(r.P_error!/1e5).toFixed(2)}bar)`);
    console.log('');
  }
}

// Additional spot tests at specific conditions matching the user's data
console.log('');
console.log('='.repeat(70));
console.log('Spot Tests at User-Reported Conditions:');
console.log('='.repeat(70));

// User reported: u=1626 kJ/kg, rho=587, P_wp=161.4 bar, P_base=162.3 bar
const spotTests = [
  { P: 161.4e5, u: 1626e3, desc: 'hot-leg P_wp' },
  { P: 162.3e5, u: 1626e3, desc: 'hot-leg P_base' },
  { P: 155e5, u: 1500e3, desc: 'typical PWR' },
  { P: 155e5, u: 1300e3, desc: 'cold-leg typical' },
  { P: 155e5, u: 1600e3, desc: 'near saturation' },
];

for (const test of spotTests) {
  console.log(`\n--- ${test.desc}: P=${(test.P/1e5).toFixed(1)}bar, u=${(test.u/1e3).toFixed(0)}kJ/kg ---`);
  const result = verifyPressureDensityRoundTrip(test.P, test.u);
  if (result.success) {
    console.log(`  ρ_interp = ${result.rho_interp?.toFixed(2)} kg/m³`);
    console.log(`  v_derived = ${result.v_derived?.toFixed(6)} m³/kg`);
    console.log(`  P_recovered = ${(result.P_recovered!/1e5).toFixed(2)} bar`);
    console.log(`  Error = ${result.P_error_pct?.toFixed(2)}%`);
  }
}

console.log('');
console.log('='.repeat(70));
console.log('Diagnosing Failed Lookups (u=1626 kJ/kg):');
console.log('='.repeat(70));

// Diagnose the specific failing point: u=1626 kJ/kg, v=0.001715 m³/kg
const u_test = 1626e3;  // J/kg
const P_test = 161.4e5; // Pa

// First get the density from (P,u) lookup
const rho_test = lookupCompressedLiquidDensity(P_test, u_test);
if (rho_test !== null) {
  const v_test = 1 / rho_test;
  console.log(`\nPoint: u=${(u_test/1e3).toFixed(0)} kJ/kg, P=${(P_test/1e5).toFixed(1)} bar`);
  console.log(`  (P,u)→ρ lookup: ρ=${rho_test.toFixed(2)} kg/m³`);
  console.log(`  Derived: v=${v_test.toFixed(6)} m³/kg, logV=${Math.log10(v_test).toFixed(4)}`);

  // Diagnose why (u,v)→P fails
  const diag = diagnoseUVLookup(u_test, v_test);
  console.log(`\nDiagnostic for (u,v)→P lookup:`);
  console.log(`  Query: logV=${diag.logV.toFixed(4)}, u=${(u_test/1e3).toFixed(0)} kJ/kg`);
  console.log(`  In grid: ${diag.inGrid}`);
  if (diag.gridCell) {
    console.log(`  Grid cell: (${diag.gridCell.x}, ${diag.gridCell.y})`);
    console.log(`  Triangles in cell: ${diag.trianglesInCell}`);
  }
  console.log(`  Found triangle: ${diag.foundTriangle}`);

  if (diag.triangleVertices) {
    console.log(`\n  Triangle vertices:`);
    for (const v of diag.triangleVertices) {
      console.log(`    idx=${v.idx}: logV=${v.logV.toFixed(4)}, u=${(v.u/1e3).toFixed(1)}kJ/kg, P=${v.P_bar.toFixed(1)}bar, phase=${v.phase}`);
    }
  }

  console.log(`\n  10 nearest points to query:`);
  for (const pt of diag.nearestPoints) {
    const v_pt = Math.pow(10, pt.logV);
    console.log(`    idx=${pt.idx}: v=${v_pt.toFixed(6)}, u=${(pt.u/1e3).toFixed(1)}kJ/kg, P=${pt.P_bar.toFixed(1)}bar, phase=${pt.phase}, dist=${pt.distance.toFixed(4)}`);
  }

  // Show triangles that contain the nearest points
  console.log(`\n  Triangles containing the 5 nearest points: ${diag.trianglesWithNearestPoints.length} triangles`);
  if (diag.trianglesWithNearestPoints.length > 0) {
    console.log(`\n  First 10 triangles containing nearest points:`);
    for (const t of diag.trianglesWithNearestPoints.slice(0, 10)) {
      const phases = t.vertices.map(v => v.phase).join(', ');
      const indices = t.vertices.map(v => v.idx).join(', ');
      console.log(`    tri[${t.triIdx}]: indices=(${indices}), phases=(${phases})`);
      for (const v of t.vertices) {
        const v_val = Math.pow(10, v.logV);
        console.log(`      idx=${v.idx}: v=${v_val.toFixed(6)}, u=${(v.u/1e3).toFixed(1)}kJ/kg, P=${v.P_bar.toFixed(1)}bar, phase=${v.phase}`);
      }
    }
  }
} else {
  console.log(`\nFailed to get density at P=${(P_test/1e5).toFixed(1)}bar, u=${(u_test/1e3).toFixed(0)}kJ/kg`);
}

// Additional diagnostic: Manually check if query point is inside triangle 4639
console.log('');
console.log('='.repeat(70));
console.log('Manual Point-In-Triangle Test for tri[4639]:');
console.log('='.repeat(70));

// Query point
const qLogV = Math.log10(0.001715);
const qU = 1626e3;  // J/kg

// Triangle 4639 vertices (from diagnostic output)
const t1_logV = Math.log10(0.001703);  // idx=2671
const t1_u = 1628e3;
const t2_logV = Math.log10(0.001709);  // idx=2672
const t2_u = 1622e3;
const t3_logV = Math.log10(0.001727);  // idx=2673
const t3_u = 1637e3;

console.log(`Query: logV=${qLogV.toFixed(6)}, u=${(qU/1e3).toFixed(0)} kJ/kg`);
console.log(`Tri vertices:`);
console.log(`  v1: logV=${t1_logV.toFixed(6)}, u=${(t1_u/1e3).toFixed(0)}`);
console.log(`  v2: logV=${t2_logV.toFixed(6)}, u=${(t2_u/1e3).toFixed(0)}`);
console.log(`  v3: logV=${t3_logV.toFixed(6)}, u=${(t3_u/1e3).toFixed(0)}`);

// Barycentric coordinates
const denom = (t2_u - t3_u) * (t1_logV - t3_logV) + (t3_logV - t2_logV) * (t1_u - t3_u);
console.log(`\nBarycentric calculation:`);
console.log(`  denom = ${denom.toFixed(6)}`);

const a = ((t2_u - t3_u) * (qLogV - t3_logV) + (t3_logV - t2_logV) * (qU - t3_u)) / denom;
const b = ((t3_u - t1_u) * (qLogV - t3_logV) + (t1_logV - t3_logV) * (qU - t3_u)) / denom;
const c = 1 - a - b;

console.log(`  a = ${a.toFixed(6)}`);
console.log(`  b = ${b.toFixed(6)}`);
console.log(`  c = ${c.toFixed(6)}`);
console.log(`  a+b+c = ${(a+b+c).toFixed(6)}`);
console.log(`\n  Inside (a,b,c >= -0.001)? a>=${(a >= -0.001)}, b>=${(b >= -0.001)}, c>=${(c >= -0.001)}`);
console.log(`  Result: ${(a >= -0.001 && b >= -0.001 && c >= -0.001) ? 'INSIDE' : 'OUTSIDE'}`);

// Also check what phase calculateState returns for this point
const testM = 1000;  // 1000 kg
const testV = 0.001715;  // m³/kg
const testU_val = 1626e3;  // J/kg
const testState = calculateState(testM, testM * testU_val, testM * testV);
console.log(`\nPhase detection for query point:`);
console.log(`  Result: phase=${testState.phase}, T=${(testState.temperature - 273.15).toFixed(1)}°C, P=${(testState.pressure / 1e5).toFixed(2)}bar`);
if (testState.phase === 'two-phase') {
  console.log(`  Quality: ${(testState.quality * 100).toFixed(2)}%`);
}

// The query needs a triangle that extends to the right of the saturation curve.
// Currently triangle 4639 doesn't cover the query because the query is "below" the edge v1-v3.
// We need a triangle connecting v2 (sat liq) to points at higher v and lower u.
//
// The gap exists because the Delaunay triangulation naturally connects points,
// but there are no data points in the steam table at v=0.001715, u=1626 (just to the right
// of the saturation curve).
//
// Solution: Add synthetic points along the saturation curve boundary to ensure
// triangles extend into the near-saturation liquid region.

console.log(`\n--- GAP ANALYSIS ---`);
console.log(`The query (logV=-2.7657, u=1626) falls outside triangle 4639 because:`);
console.log(`  - The triangle extends UP (toward higher u) from the sat. liq. point`);
console.log(`  - But the query is at lower u (1626) than the "up" direction (1637)`);
console.log(`  - There's no triangle connecting v2 (sat.liq) down-right to this region`);
console.log(`\nTo fix: Need a data point at approximately v=0.001720, u=1615 (sat.liq at ~155 bar)`);
console.log(`that would create a triangle covering the query point.`)

console.log('');
console.log('='.repeat(70));
console.log('Test complete.');
