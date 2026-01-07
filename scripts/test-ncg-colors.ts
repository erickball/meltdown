/**
 * Test script for NCG (Non-Condensible Gas) color calculations.
 *
 * Tests the calculateNcgFraction function and rendering logic.
 */

import {
  emptyGasComposition,
  totalMoles,
  R_GAS,
  GasComposition,
} from '../src/simulation/gas-properties.js';
import {
  getNcgVisualization,
  isApproximatelyAir,
  getAirColor,
  rgbToString,
} from '../src/render/colors.js';
import { Fluid } from '../src/types.js';

// Replicate the calculateNcgFraction logic for testing
function calculateNcgFraction(fluid: Fluid): number {
  if (!fluid.ncg) return 0;
  if (fluid.phase === 'liquid') return 0;

  const ncgViz = getNcgVisualization(fluid.ncg);
  if (!ncgViz || ncgViz.totalMoles <= 0) return 0;

  // Steam pressure in bar (fluid.pressure is in Pa)
  const P_steam_bar = fluid.pressure / 1e5;

  // NCG partial pressure from moles using ideal gas law: P = nRT/V
  const ncgMoles = ncgViz.totalMoles;
  const R = 8.314; // J/(mol·K)
  const T = fluid.temperature || 400; // K
  const V = fluid.volume || 1; // m³

  const P_ncg_bar = (ncgMoles * R * T) / (V * 1e5);

  // Total partial pressure
  const P_total = P_steam_bar + P_ncg_bar;

  if (P_total <= 0) return 0;

  return P_ncg_bar / P_total;
}

// Helper to create NCG from partial pressures (like construction manager does)
function createNcgFromPressures(
  pressures: Partial<Record<string, number>>,
  temperature: number = 400
): GasComposition {
  const ncg = emptyGasComposition();
  const V = 1; // m³ - canonical volume
  const R = 8.314;

  for (const [species, P_bar] of Object.entries(pressures)) {
    if (P_bar && P_bar > 0) {
      const P_Pa = P_bar * 1e5;
      ncg[species as keyof GasComposition] = (P_Pa * V) / (R * temperature);
    }
  }

  return ncg;
}

console.log('=== NCG Color Calculation Tests ===\n');

// Test 1: Pure oxygen at 1 bar, tiny steam at 0.01 bar
console.log('Test 1: 1 bar O₂ + 0.01 bar steam (should be ~99% NCG)');
{
  const T = 400; // K
  const P_steam = 0.01 * 1e5; // Pa
  const ncg = createNcgFromPressures({ O2: 1.0 }, T);

  const fluid: Fluid = {
    temperature: T,
    pressure: P_steam,
    phase: 'vapor',
    flowRate: 0,
    ncg: ncg,
    volume: 1,
  };

  const fraction = calculateNcgFraction(fluid);
  const ncgViz = getNcgVisualization(ncg);

  console.log(`  NCG moles: ${totalMoles(ncg).toFixed(4)}`);
  console.log(`  Steam pressure: ${(P_steam / 1e5).toFixed(4)} bar`);
  console.log(`  NCG fraction: ${(fraction * 100).toFixed(1)}%`);
  console.log(`  Expected: ~99%`);

  if (ncgViz) {
    console.log(`  Is air: ${ncgViz.isAir}`);
    console.log(`  Blended color: rgb(${ncgViz.blendedColor.r.toFixed(0)}, ${ncgViz.blendedColor.g.toFixed(0)}, ${ncgViz.blendedColor.b.toFixed(0)})`);
    console.log(`  Gas colors: ${ncgViz.gasColors.map(g => `${g.species}:${(g.fraction*100).toFixed(0)}%`).join(', ')}`);
  }

  if (fraction > 0.95) {
    console.log('  ✓ PASS\n');
  } else {
    console.log('  ✗ FAIL - NCG fraction too low!\n');
  }
}

// Test 2: Equal pressures - 1 bar O₂, 1 bar steam
console.log('Test 2: 1 bar O₂ + 1 bar steam (should be ~50% NCG)');
{
  const T = 400;
  const P_steam = 1.0 * 1e5;
  const ncg = createNcgFromPressures({ O2: 1.0 }, T);

  const fluid: Fluid = {
    temperature: T,
    pressure: P_steam,
    phase: 'vapor',
    flowRate: 0,
    ncg: ncg,
    volume: 1,
  };

  const fraction = calculateNcgFraction(fluid);
  console.log(`  NCG fraction: ${(fraction * 100).toFixed(1)}%`);
  console.log(`  Expected: ~50%`);

  if (fraction > 0.45 && fraction < 0.55) {
    console.log('  ✓ PASS\n');
  } else {
    console.log('  ✗ FAIL\n');
  }
}

// Test 3: Air composition
console.log('Test 3: Air (0.78 bar N₂ + 0.21 bar O₂) + 0.01 bar steam');
{
  const T = 400;
  const P_steam = 0.01 * 1e5;
  const ncg = createNcgFromPressures({ N2: 0.78, O2: 0.21 }, T);

  const fluid: Fluid = {
    temperature: T,
    pressure: P_steam,
    phase: 'vapor',
    flowRate: 0,
    ncg: ncg,
    volume: 1,
  };

  const fraction = calculateNcgFraction(fluid);
  const ncgViz = getNcgVisualization(ncg);
  const isAir = isApproximatelyAir(ncg);

  console.log(`  Is air: ${isAir}`);
  console.log(`  NCG fraction: ${(fraction * 100).toFixed(1)}%`);

  if (ncgViz) {
    console.log(`  Blended color: rgb(${ncgViz.blendedColor.r.toFixed(0)}, ${ncgViz.blendedColor.g.toFixed(0)}, ${ncgViz.blendedColor.b.toFixed(0)})`);
  }

  const airColor = getAirColor();
  console.log(`  Air color: rgb(${airColor.r.toFixed(0)}, ${airColor.g.toFixed(0)}, ${airColor.b.toFixed(0)})`);

  if (isAir && fraction > 0.95) {
    console.log('  ✓ PASS\n');
  } else {
    console.log('  ✗ FAIL\n');
  }
}

// Test 4: Liquid phase should return 0
console.log('Test 4: Liquid phase with NCG (should return 0 - NCG not visible in liquid)');
{
  const T = 400;
  const P_steam = 1.0 * 1e5;
  const ncg = createNcgFromPressures({ O2: 1.0 }, T);

  const fluid: Fluid = {
    temperature: T,
    pressure: P_steam,
    phase: 'liquid',  // Liquid!
    flowRate: 0,
    ncg: ncg,
    volume: 1,
  };

  const fraction = calculateNcgFraction(fluid);
  console.log(`  NCG fraction: ${(fraction * 100).toFixed(1)}%`);
  console.log(`  Expected: 0%`);

  if (fraction === 0) {
    console.log('  ✓ PASS\n');
  } else {
    console.log('  ✗ FAIL\n');
  }
}

// Test 5: Verify mole calculation round-trip
console.log('Test 5: Verify pressure -> moles -> pressure round-trip');
{
  const T = 400;
  const V = 1;
  const R = 8.314;
  const P_original = 1.5; // bar

  // Forward: pressure to moles
  const moles = (P_original * 1e5 * V) / (R * T);

  // Reverse: moles to pressure
  const P_recovered = (moles * R * T) / (V * 1e5);

  console.log(`  Original pressure: ${P_original} bar`);
  console.log(`  Moles: ${moles.toFixed(4)}`);
  console.log(`  Recovered pressure: ${P_recovered.toFixed(4)} bar`);

  if (Math.abs(P_original - P_recovered) < 0.0001) {
    console.log('  ✓ PASS\n');
  } else {
    console.log('  ✗ FAIL\n');
  }
}

// Test 6: No NCG
console.log('Test 6: No NCG present (should return 0)');
{
  const fluid: Fluid = {
    temperature: 400,
    pressure: 1e5,
    phase: 'vapor',
    flowRate: 0,
    // No ncg field
  };

  const fraction = calculateNcgFraction(fluid);
  console.log(`  NCG fraction: ${(fraction * 100).toFixed(1)}%`);

  if (fraction === 0) {
    console.log('  ✓ PASS\n');
  } else {
    console.log('  ✗ FAIL\n');
  }
}

// Test 7: Two-phase with NCG
console.log('Test 7: Two-phase with NCG (should show NCG in vapor space)');
{
  const T = 400;
  const P_steam = 0.5 * 1e5;
  const ncg = createNcgFromPressures({ H2: 0.5 }, T);

  const fluid: Fluid = {
    temperature: T,
    pressure: P_steam,
    phase: 'two-phase',
    quality: 0.5,
    flowRate: 0,
    ncg: ncg,
    volume: 1,
  };

  const fraction = calculateNcgFraction(fluid);
  console.log(`  NCG fraction: ${(fraction * 100).toFixed(1)}%`);
  console.log(`  Expected: ~50%`);

  if (fraction > 0.45 && fraction < 0.55) {
    console.log('  ✓ PASS\n');
  } else {
    console.log('  ✗ FAIL\n');
  }
}

// Test 8: Air + hydrogen (should show pixelated, not solid)
console.log('Test 8: Air + 5% H₂ (should show pixelated display with Air + H₂)');
{
  const T = 400;
  const P_steam = 0.01 * 1e5;
  // Air is 0.78 N₂ + 0.21 O₂, plus 5% H₂
  // Scale air down: 0.95 * 0.78 = 0.741, 0.95 * 0.21 = 0.1995
  const ncg = createNcgFromPressures({ N2: 0.741, O2: 0.1995, H2: 0.05 }, T);

  const ncgViz = getNcgVisualization(ncg);

  console.log(`  Is pure air: ${ncgViz?.isAir}`);
  console.log(`  Gas colors:`);
  if (ncgViz) {
    for (const gc of ncgViz.gasColors) {
      console.log(`    ${gc.species}: ${(gc.fraction * 100).toFixed(1)}% - rgb(${gc.color.r.toFixed(0)}, ${gc.color.g.toFixed(0)}, ${gc.color.b.toFixed(0)})`);
    }
  }

  // Should NOT be pure air (has H₂), and should show "Air" + "H2" in gasColors
  const hasAirPseudo = ncgViz?.gasColors.some(gc => gc.species === 'Air');
  const hasH2 = ncgViz?.gasColors.some(gc => gc.species === 'H2');

  if (!ncgViz?.isAir && hasAirPseudo && hasH2) {
    console.log('  ✓ PASS - Shows pixelated Air + H₂\n');
  } else {
    console.log('  ✗ FAIL\n');
  }
}

// Test 9: Pure oxygen (no nitrogen, should NOT be "Air")
console.log('Test 9: Pure O₂ (should show just O₂, not Air)');
{
  const T = 400;
  const ncg = createNcgFromPressures({ O2: 1.0 }, T);

  const ncgViz = getNcgVisualization(ncg);

  console.log(`  Is pure air: ${ncgViz?.isAir}`);
  console.log(`  Gas colors:`);
  if (ncgViz) {
    for (const gc of ncgViz.gasColors) {
      console.log(`    ${gc.species}: ${(gc.fraction * 100).toFixed(1)}%`);
    }
  }

  const hasAirPseudo = ncgViz?.gasColors.some(gc => gc.species === 'Air');
  const hasO2 = ncgViz?.gasColors.some(gc => gc.species === 'O2');

  if (!ncgViz?.isAir && !hasAirPseudo && hasO2) {
    console.log('  ✓ PASS - Shows O₂ only, not Air\n');
  } else {
    console.log('  ✗ FAIL\n');
  }
}

// Test 10: 90% N₂ + 10% O₂ (should show Air + excess N₂)
console.log('Test 10: 0.9 bar N₂ + 0.1 bar O₂ (should show ~50% Air + ~50% excess N₂)');
{
  const T = 400;
  const ncg = createNcgFromPressures({ N2: 0.9, O2: 0.1 }, T);

  const ncgViz = getNcgVisualization(ncg);

  console.log(`  Is pure air: ${ncgViz?.isAir}`);
  console.log(`  Gas colors:`);
  if (ncgViz) {
    for (const gc of ncgViz.gasColors) {
      console.log(`    ${gc.species}: ${(gc.fraction * 100).toFixed(1)}%`);
    }
  }

  // With 0.9 N₂ + 0.1 O₂, O₂ is limiting
  // Air needs 0.78 N₂ per 0.21 O₂, so 0.1 O₂ can make 0.1/0.21 = 0.476 "air"
  // That uses 0.476 * 0.78 = 0.37 N₂, leaving 0.53 N₂ excess
  // Air fraction = (0.37 + 0.1) / 1.0 = 0.47 = 47%
  // Excess N₂ = 0.53 / 1.0 = 53%
  const hasAirPseudo = ncgViz?.gasColors.some(gc => gc.species === 'Air');
  const hasN2 = ncgViz?.gasColors.some(gc => gc.species === 'N2');
  const hasO2 = ncgViz?.gasColors.some(gc => gc.species === 'O2');

  // Should show Air + excess N₂, no excess O₂
  if (hasAirPseudo && hasN2 && !hasO2) {
    console.log('  ✓ PASS - Shows Air + excess N₂\n');
  } else {
    console.log('  ✗ FAIL\n');
  }
}

// Test 11: Air + 2% H₂ (should trigger pixelated, not solid)
console.log('Test 11: Air + 2% H₂ (should show pixelated display, not solid air)');
{
  const T = 400;
  // Air is 0.78 N₂ + 0.21 O₂, plus 2% H₂
  // Scale air down: 0.98 * 0.78 = 0.7644, 0.98 * 0.21 = 0.2058
  const ncg = createNcgFromPressures({ N2: 0.7644, O2: 0.2058, H2: 0.02 }, T);

  const ncgViz = getNcgVisualization(ncg);

  console.log(`  Is pure air: ${ncgViz?.isAir}`);
  console.log(`  Gas colors:`);
  if (ncgViz) {
    for (const gc of ncgViz.gasColors) {
      console.log(`    ${gc.species}: ${(gc.fraction * 100).toFixed(1)}%`);
    }
  }

  // Should NOT be pure air (has 2% H₂), and should show "Air" + "H2" in gasColors
  const hasH2 = ncgViz?.gasColors.some(gc => gc.species === 'H2');

  if (!ncgViz?.isAir && hasH2) {
    console.log('  ✓ PASS - Shows pixelated display with H₂ visible\n');
  } else {
    console.log('  ✗ FAIL\n');
  }
}

// Test 12: 0.78 bar N₂ + 0.14 bar O₂ + 0.009 bar Ar (should show Air + excess N₂)
console.log('Test 12: 0.78 bar N₂ + 0.14 bar O₂ + 0.009 bar Ar (user bug report case)');
{
  const T = 400;
  const ncg = createNcgFromPressures({ N2: 0.78, O2: 0.14, Ar: 0.009 }, T);

  const ncgViz = getNcgVisualization(ncg);

  console.log(`  Is pure air: ${ncgViz?.isAir}`);
  console.log(`  Gas colors:`);
  if (ncgViz) {
    for (const gc of ncgViz.gasColors) {
      console.log(`    ${gc.species}: ${(gc.fraction * 100).toFixed(1)}%`);
    }
  }

  // N₂:O₂ ratio is 5.57, not air-like (3.5-4)
  // Should show Air + excess N₂, possibly Ar (at ~1%)
  const hasAirPseudo = ncgViz?.gasColors.some(gc => gc.species === 'Air');
  const hasN2 = ncgViz?.gasColors.some(gc => gc.species === 'N2');

  if (!ncgViz?.isAir && hasAirPseudo && hasN2) {
    console.log('  ✓ PASS - Shows Air + excess N₂\n');
  } else {
    console.log('  ✗ FAIL - Should show Air + excess N₂\n');
  }
}

console.log('=== Tests Complete ===');
