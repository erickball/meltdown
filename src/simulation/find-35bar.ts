/**
 * Find all points at/near 35 bar (3.5 MPa) in the steam table
 */

import * as fs from 'fs';

// Read the steam table JSON directly
const steamTablePath = 'c:/Users/eball/OneDrive - X-energy/Source/meltdown/src/simulation/steam-table.json';
const rawData = JSON.parse(fs.readFileSync(steamTablePath, 'utf-8'));

console.log('=== Points near 35 bar (3.5 MPa = 35e5 Pa) ===\n');

// Find all points at P ~ 35 bar (3.5 MPa = 3500 kPa)
// The steam table uses different units - need to check
const first5 = rawData.slice(0, 5);
console.log('First 5 entries in steam table (to check format):');
for (const pt of first5) {
  console.log(`  P=${pt.P}, T=${pt.T}, v=${pt.v}, u=${pt.u}, phase=${pt.phase}`);
}

console.log('\n');

// Find range of P values
const allP = rawData.map((pt: any) => pt.P);
const minP = Math.min(...allP);
const maxP = Math.max(...allP);
console.log(`P range in steam table: ${minP} to ${maxP}`);

// Find unique pressures near 35 bar
// Need to figure out units first - could be bar, kPa, MPa, or Pa
const P_35bar_Pa = 35e5;
const P_35bar_kPa = 3500;
const P_35bar_bar = 35;
const P_35bar_MPa = 3.5;

console.log('\nSearching for P near 35 bar...');

// Check each unit possibility
const nearPa = rawData.filter((pt: any) => Math.abs(pt.P - P_35bar_Pa) < 0.5e5);
const nearKPa = rawData.filter((pt: any) => Math.abs(pt.P - P_35bar_kPa) < 50);
const nearBar = rawData.filter((pt: any) => Math.abs(pt.P - P_35bar_bar) < 0.5);
const nearMPa = rawData.filter((pt: any) => Math.abs(pt.P - P_35bar_MPa) < 0.05);

console.log(`  Points with P near ${P_35bar_Pa} Pa: ${nearPa.length}`);
console.log(`  Points with P near ${P_35bar_kPa} kPa: ${nearKPa.length}`);
console.log(`  Points with P near ${P_35bar_bar} bar: ${nearBar.length}`);
console.log(`  Points with P near ${P_35bar_MPa} MPa: ${nearMPa.length}`);

// The steam table probably uses bar or kPa
// Let's find all liquid points with P in range 30-50 (assuming bar or 0.1*kPa)
console.log('\n=== Liquid points with P in [30, 50] (assuming units from file) ===\n');

const liquidInRange = rawData.filter((pt: any) =>
  pt.phase === 'liquid' && pt.P >= 30 && pt.P <= 50
);

console.log(`Found ${liquidInRange.length} liquid points with P in [30, 50]`);

if (liquidInRange.length > 0 && liquidInRange.length <= 50) {
  console.log('\nAll liquid points in range:');
  console.log('  P      |  T      |    v        |    u');
  console.log('-'.repeat(50));
  for (const pt of liquidInRange.sort((a: any, b: any) => a.P - b.P || a.T - b.T)) {
    console.log(`${pt.P.toString().padStart(6)} | ${pt.T.toString().padStart(6)} | ${pt.v.toFixed(6).padStart(10)} | ${pt.u.toFixed(1).padStart(8)}`);
  }
}

// Now check for 3.5 MPa range
console.log('\n=== Liquid points with P in [3, 4] (checking if MPa) ===\n');

const liquidInMPaRange = rawData.filter((pt: any) =>
  pt.phase === 'liquid' && pt.P >= 3 && pt.P <= 4
);

console.log(`Found ${liquidInMPaRange.length} liquid points with P in [3, 4]`);

// Also check 3500-4000 range for kPa
console.log('\n=== Liquid points with P in [3500, 4000] (checking if kPa) ===\n');

const liquidInKPaRange = rawData.filter((pt: any) =>
  pt.phase === 'liquid' && pt.P >= 3500 && pt.P <= 4000
);

console.log(`Found ${liquidInKPaRange.length} liquid points with P in [3500, 4000]`);

if (liquidInKPaRange.length > 0 && liquidInKPaRange.length <= 30) {
  console.log('\nAll liquid points in range:');
  for (const pt of liquidInKPaRange.sort((a: any, b: any) => a.T - b.T)) {
    console.log(`  P=${pt.P}kPa, T=${pt.T}, v=${pt.v.toFixed(6)}, u=${pt.u.toFixed(1)}`);
  }
}

// Check at 50 bar = 5000 kPa = 5 MPa = 50e5 Pa
console.log('\n=== Checking 50 bar = 5000 kPa ===\n');

const near5000 = rawData.filter((pt: any) =>
  pt.phase === 'liquid' && Math.abs(pt.P - 5000) < 100
);

console.log(`Found ${near5000.length} liquid points near P=5000`);

if (near5000.length > 0 && near5000.length <= 20) {
  console.log('\nPoints near P=5000:');
  for (const pt of near5000.sort((a: any, b: any) => a.T - b.T)) {
    console.log(`  P=${pt.P}, T=${pt.T}, v=${pt.v.toFixed(6)}, u=${pt.u.toFixed(1)}`);
  }
}
