/**
 * Export interpolated points to JSON for visualization
 */

import * as fs from 'fs';
import { getAllDataPoints } from './water-properties-v3.js';

// Get all data points
const allPoints = getAllDataPoints();

// Separate into original and interpolated
const interpolatedPoints = allPoints.filter(pt => pt.isInterpolated);

// Further categorize by type
const interpolatedSatLiquid = interpolatedPoints.filter(pt => pt.phase === 'saturated liquid');
const interpolatedSatVapor = interpolatedPoints.filter(pt => pt.phase === 'saturated vapor');
const interpolatedLiquid = interpolatedPoints.filter(pt => pt.phase === 'liquid');

console.log(`Total points: ${allPoints.length}`);
console.log(`Interpolated points: ${interpolatedPoints.length}`);
console.log(`  - Saturated liquid: ${interpolatedSatLiquid.length}`);
console.log(`  - Saturated vapor: ${interpolatedSatVapor.length}`);
console.log(`  - Compressed liquid: ${interpolatedLiquid.length}`);

// Export to JSON for the HTML visualization
const exportData = {
  interpolatedSatLiquidPoints: interpolatedSatLiquid.map(pt => ({
    v: pt.v,
    u: pt.u,
    P: pt.P,
    T: pt.T,
  })),
  interpolatedSatVaporPoints: interpolatedSatVapor.map(pt => ({
    v: pt.v,
    u: pt.u,
    P: pt.P,
    T: pt.T,
  })),
  interpolatedCompressedLiquidPoints: interpolatedLiquid.map(pt => ({
    v: pt.v,
    u: pt.u,
    P: pt.P,
    T: pt.T,
  })),
};

// Write to public folder for browser access
const outputPath = 'c:/Users/eball/OneDrive - X-energy/Source/meltdown/public/interpolated-points.json';
fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));
console.log(`\nExported to: ${outputPath}`);
