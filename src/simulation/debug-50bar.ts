/**
 * Debug the 50 bar, u=1000 kJ/kg case
 */

import { calculateState, lookupCompressedLiquidDensity, diagnoseUVLookup, lookupPressureFromUV } from './water-properties-v3.js';

// Trigger load
calculateState(1000, 1e9, 1);

// Test the (P,u)->rho lookup at 50 bar, u=1000 kJ/kg
const P = 50e5;  // Pa
const u = 1000e3;  // J/kg

console.log('=== Debug: P=50 bar, u=1000 kJ/kg ===');
console.log('');

const rho = lookupCompressedLiquidDensity(P, u);
console.log('(P,u) -> rho lookup:');
console.log('  rho =', rho ? rho.toFixed(2) + ' kg/m3' : 'null');

if (rho) {
  const v = 1 / rho;
  console.log('  v =', v.toFixed(6), 'm3/kg');

  // Diagnose the (u,v) -> P lookup
  console.log('');
  console.log('(u,v) -> P lookup diagnosis:');
  const diag = diagnoseUVLookup(u, v);
  console.log('  Query: logV=' + diag.logV.toFixed(4) + ', u=' + (u/1e3).toFixed(0) + ' kJ/kg');
  console.log('  In grid:', diag.inGrid);
  console.log('  Found triangle:', diag.foundTriangle);

  if (diag.foundTriangle && diag.triangleVertices) {
    console.log('');
    console.log('  Triangle vertices (from diagnoseUVLookup):');
    for (const vert of diag.triangleVertices) {
      const v_val = Math.pow(10, vert.logV);
      console.log('    v=' + v_val.toFixed(6) + ', u=' + (vert.u/1e3).toFixed(1) + 'kJ/kg, P=' + vert.P_bar.toFixed(1) + 'bar, ' + vert.phase);
    }
  }

  console.log('');
  console.log('  Nearest 5 points:');
  for (const pt of diag.nearestPoints.slice(0, 5)) {
    const v_pt = Math.pow(10, pt.logV);
    console.log('    v=' + v_pt.toFixed(6) + ', u=' + (pt.u/1e3).toFixed(1) + 'kJ/kg, P=' + pt.P_bar.toFixed(1) + 'bar, ' + pt.phase);
  }

  // Check lookupPressureFromUV result (what the round-trip test actually uses)
  const P_lookup = lookupPressureFromUV(u, v);
  console.log('');
  console.log('lookupPressureFromUV result:');
  console.log('  P_recovered:', P_lookup ? (P_lookup / 1e5).toFixed(2) + ' bar' : 'null (rejected bad triangle)');
  console.log('  Expected P: 50.00 bar');
  if (P_lookup) {
    console.log('  Error:', ((P_lookup / 1e5 - 50) / 50 * 100).toFixed(1) + '%');
  }
}
