/**
 * Test script for fill level to quality conversion.
 *
 * Verifies that the factory correctly converts volume-based fill level
 * to mass-based quality for two-phase states.
 */

import * as Water from '../src/simulation/water-properties.js';

console.log('=== Fill Level to Quality Conversion Test ===\n');

// Test case: 50% fill level at various steam pressures

const fillLevel = 0.5;
const volume = 10; // m³

console.log(`Fill level: ${fillLevel * 100}%`);
console.log(`Tank volume: ${volume} m³\n`);

// Test at different pressures
const testPressures = [
  { P_Pa: 657, label: '657 Pa (1°C, minimum)' },
  { P_Pa: 1e5, label: '1 bar (100°C)' },
  { P_Pa: 1e6, label: '10 bar (180°C)' },
  { P_Pa: 15e6, label: '150 bar (342°C)' },
];

for (const { P_Pa, label } of testPressures) {
  console.log(`--- ${label} ---`);

  const T_sat = Water.saturationTemperature(P_Pa);
  const rho_f = Water.saturatedLiquidDensity(T_sat);
  const rho_g = Water.saturatedVaporDensity(T_sat);

  // Factory calculation
  const m_liquid = rho_f * fillLevel * volume;
  const m_vapor = rho_g * (1 - fillLevel) * volume;
  const totalMass = m_liquid + m_vapor;
  const quality = m_vapor / totalMass;

  // Verify: convert quality back to volume fraction
  // α = x·v_g / (x·v_g + (1-x)·v_f)
  const v_f = 1 / rho_f;
  const v_g = 1 / rho_g;
  const vaporVolFrac = quality * v_g / (quality * v_g + (1 - quality) * v_f);
  const liquidVolFrac = 1 - vaporVolFrac;

  console.log(`  T_sat: ${(T_sat - 273.15).toFixed(1)}°C`);
  console.log(`  rho_f: ${rho_f.toFixed(1)} kg/m³`);
  console.log(`  rho_g: ${rho_g.toFixed(4)} kg/m³`);
  console.log(`  m_liquid: ${m_liquid.toFixed(1)} kg`);
  console.log(`  m_vapor: ${m_vapor.toFixed(4)} kg`);
  console.log(`  quality: ${(quality * 100).toFixed(6)}%`);
  console.log(`  Back-calculated liquid vol fraction: ${(liquidVolFrac * 100).toFixed(2)}%`);
  console.log(`  Expected: ${(fillLevel * 100).toFixed(0)}%`);

  if (Math.abs(liquidVolFrac - fillLevel) < 0.01) {
    console.log('  ✓ PASS\n');
  } else {
    console.log(`  ✗ FAIL - Expected ${(fillLevel * 100).toFixed(0)}%, got ${(liquidVolFrac * 100).toFixed(2)}%\n`);
  }
}

console.log('\n=== Checking Two-Phase Dome Detection ===\n');

// Use 1 bar for easier numbers
const P = 1e5;
const T_sat = Water.saturationTemperature(P);
const rho_f = Water.saturatedLiquidDensity(T_sat);
const rho_g = Water.saturatedVaporDensity(T_sat);

const m_liquid = rho_f * fillLevel * volume;
const m_vapor = rho_g * (1 - fillLevel) * volume;
const totalMass = m_liquid + m_vapor;
const quality = m_vapor / totalMass;

// Calculate (u, v) for the mixture
const u_f = Water.saturatedLiquidEnergy(T_sat);
const u_g = Water.saturatedVaporEnergy(T_sat);
const u_avg = (1 - quality) * u_f + quality * u_g;
const v_avg = (1 - quality) / rho_f + quality / rho_g;

console.log(`At 1 bar (${(T_sat - 273.15).toFixed(1)}°C):`);
console.log(`  quality: ${(quality * 100).toFixed(4)}%`);
console.log(`  u_avg: ${(u_avg / 1000).toFixed(2)} kJ/kg`);
console.log(`  v_avg: ${(v_avg * 1000).toFixed(4)} L/kg`);
console.log(`  u_f: ${(u_f / 1000).toFixed(2)} kJ/kg`);
console.log(`  u_g: ${(u_g / 1000).toFixed(2)} kJ/kg`);
console.log(`  v_f: ${(1 / rho_f * 1000).toFixed(4)} L/kg`);
console.log(`  v_g: ${(1 / rho_g * 1000).toFixed(2)} L/kg`);

// Test calculateState with these values
console.log('\n=== Testing calculateState ===\n');
const totalEnergy = totalMass * u_avg;
console.log(`Input: mass=${totalMass.toFixed(2)} kg, energy=${(totalEnergy / 1e6).toFixed(2)} MJ, volume=${volume} m³`);

try {
  const state = Water.calculateState(totalMass, totalEnergy, volume);
  console.log(`Output:`);
  console.log(`  phase: ${state.phase}`);
  console.log(`  temperature: ${(state.temperature - 273.15).toFixed(1)}°C`);
  console.log(`  pressure: ${(state.pressure / 1e5).toFixed(2)} bar`);
  console.log(`  quality: ${state.quality !== undefined ? (state.quality * 100).toFixed(4) + '%' : 'N/A'}`);

  if (state.phase === 'two-phase') {
    // Convert quality back to volume fraction
    const v_f_out = 1 / Water.saturatedLiquidDensity(state.temperature);
    const v_g_out = 1 / Water.saturatedVaporDensity(state.temperature);
    const vaporVolFrac_out = state.quality! * v_g_out / (state.quality! * v_g_out + (1 - state.quality!) * v_f_out);
    const liquidVolFrac_out = 1 - vaporVolFrac_out;
    console.log(`  liquid volume fraction: ${(liquidVolFrac_out * 100).toFixed(2)}%`);
    console.log(`  Expected fill level: ${(fillLevel * 100).toFixed(0)}%`);

    if (Math.abs(liquidVolFrac_out - fillLevel) < 0.05) {
      console.log('  ✓ calculateState produces consistent fill level');
    } else {
      console.log(`  ✗ Inconsistent! Expected ${(fillLevel * 100).toFixed(0)}%, got ${(liquidVolFrac_out * 100).toFixed(2)}%`);
    }
  } else {
    console.log(`  ✗ Expected two-phase, got ${state.phase}`);
  }
} catch (e) {
  console.log(`  Error: ${e}`);
}

console.log('\n=== Tests Complete ===');
