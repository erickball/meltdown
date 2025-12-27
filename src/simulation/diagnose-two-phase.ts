/**
 * Diagnose why two-phase detection is using fallback for core-coolant
 */

import { calculateState, saturationPressure, setPhaseDebug, enableCalculationDebug, getCalculationDebugLog, getBisectionStats } from './water-properties-v3.js';

// From the debug output:
// core-coolant: 352C, 170.00bar, 14069kg, two-phase x=0% ρ=563
// u=1664kJ/kg

const mass = 14069;
const rho = 563;
const volume = mass / rho;
const u_specific = 1664e3;  // J/kg
const U = mass * u_specific; // total internal energy

console.log('=== Diagnosing two-phase detection ===\n');
console.log('Input:');
console.log(`  mass = ${mass} kg`);
console.log(`  volume = ${volume.toFixed(2)} m³`);
console.log(`  U = ${(U/1e6).toFixed(3)} MJ`);
console.log(`  u = ${(u_specific/1000).toFixed(0)} kJ/kg`);
console.log(`  v = ${(volume/mass).toFixed(6)} m³/kg`);
console.log(`  ρ = ${rho} kg/m³`);

// Enable debug
setPhaseDebug(true);
enableCalculationDebug(true);

// Get the water state
const state = calculateState(mass, U, volume);

console.log('\nResult:');
console.log(`  T = ${(state.temperature - 273.15).toFixed(1)}°C`);
console.log(`  P = ${(state.pressure / 1e5).toFixed(2)} bar`);
console.log(`  phase = ${state.phase}`);
console.log(`  quality = ${(state.quality * 100).toFixed(1)}%`);

// Check bisection stats
const bisStats = getBisectionStats();
console.log('\nBisection stats:');
console.log(`  total: ${bisStats.total}`);
console.log(`  failures: ${bisStats.failures}`);
console.log(`  failure rate: ${(bisStats.failureRate * 100).toFixed(1)}%`);

// Get debug log
const debugLog = getCalculationDebugLog();
if (debugLog.length > 0) {
  console.log('\n=== Calculation debug log ===\n');
  for (const entry of debugLog) {
    console.log('Entry:', JSON.stringify(entry, null, 2));
  }
}

// What is the saturation pressure at T=352°C = 625.15K?
const T_test = 352 + 273.15;
const P_sat = saturationPressure(T_test);
console.log(`\nSaturation pressure at T=${(T_test-273.15).toFixed(0)}°C: ${(P_sat/1e5).toFixed(2)} bar`);

// Also check nearby temperatures
for (const T of [350, 351, 352, 353, 354, 355]) {
  const T_K = T + 273.15;
  const P = saturationPressure(T_K);
  console.log(`  T=${T}°C -> P_sat=${(P/1e5).toFixed(2)} bar`);
}
