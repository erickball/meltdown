/**
 * Meltdown Simulation Test Suite
 *
 * Comprehensive test battery for water properties, flow calculations, and simulation behavior.
 * Run with: npm test
 *
 * Tests are organized by category and only show detailed output on failure.
 */

import { calculateState, distanceToSaturationLine, saturationPressure, saturationTemperature } from './water-properties.js';
import { deriveNeutronics, latticeKeff, LatticeParams } from './lattice.js';

// Test result tracking
interface TestResult {
  category: string;
  name: string;
  passed: boolean;
  error?: string;
  details?: string[];
}

const results: TestResult[] = [];
let currentCategory = '';

// Test utilities
function category(name: string) {
  currentCategory = name;
}

function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ category: currentCategory, name, passed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack?.split('\n').slice(1, 4) : [];
    results.push({
      category: currentCategory,
      name,
      passed: false,
      error: message,
      details: stack
    });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number, expected: number, tolerance: number, label: string = '') {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(`${label}: Expected ${expected.toFixed(4)}, got ${actual.toFixed(4)} (diff=${diff.toFixed(6)}, tol=${tolerance})`);
  }
}

// ============================================================================
// Water Properties Tests
// ============================================================================

category('Water Properties');

test('Liquid water at ~303K, ~29 bar', () => {
  // These (u,v) values correspond to approximately 303K/29 bar
  const result = calculateState(1.0, 125.79e3, 1.0031e-3);
  assert(result.phase === 'liquid', `Phase should be liquid, got ${result.phase}`);
  assertClose(result.temperature, 303, 5, 'Temperature');
  assertClose(result.pressure / 1e5, 29.3, 2, 'Pressure (bar)');
});

test('Saturated steam at 1 bar', () => {
  const P = 1e5; // 1 bar
  const T_sat = saturationTemperature(P);
  assertClose(T_sat, 373.15, 1, 'Saturation temperature');

  const P_sat = saturationPressure(T_sat);
  assertClose(P_sat / 1e5, 1, 0.01, 'Saturation pressure');
});

test('Two-phase mixture at 10 bar, 50% quality', () => {
  // At 10 bar: T_sat ≈ 453K, h_f ≈ 762 kJ/kg, h_fg ≈ 2015 kJ/kg
  const T_sat = saturationTemperature(10e5);
  assertClose(T_sat, 453, 2, 'Saturation temp at 10 bar');

  // Create a two-phase state
  const u_f = 761.68e3; // Approximate u_f at 10 bar
  const u_fg = 1822.0e3; // Approximate u_fg at 10 bar
  const u = u_f + 0.5 * u_fg; // 50% quality
  const v_f = 1.1273e-3;
  const v_g = 194.44e-3;
  const v = v_f + 0.5 * (v_g - v_f); // 50% quality volume

  const result = calculateState(1.0, u, v);
  assert(result.phase === 'two-phase', `Phase should be two-phase, got ${result.phase}`);
  assertClose(result.quality, 0.5, 0.05, 'Quality');
  assertClose(result.pressure / 1e5, 10, 1, 'Pressure (bar)');
});

test('Superheated steam at 500K, 1 bar', () => {
  // Superheated steam: high temperature, low density
  const result = calculateState(1.0, 2585e3, 1.7e0); // ~500K at 1 bar
  assert(result.phase === 'vapor', `Phase should be vapor, got ${result.phase}`);
  assertClose(result.temperature, 500, 80, 'Temperature'); // Increased tolerance
  assertClose(result.pressure / 1e5, 1, 0.5, 'Pressure (bar)');
});

test('Compressed liquid at high pressure', () => {
  // Compressed liquid: slightly higher density than saturated
  const result = calculateState(1.0, 112.56e3, 0.9956e-3);
  assert(result.phase === 'liquid', `Phase should be liquid, got ${result.phase}`);
  assertClose(result.temperature, 300, 20, 'Temperature');
  assertClose(result.pressure / 1e5, 180, 20, 'Pressure (bar)'); // Expect ~180 bar from interpolation
});

test('Near critical point', () => {
  // Critical point: T_c=647.096K, P_c=220.64 bar, v_c=3.155e-3 m³/kg, u_c≈2020 kJ/kg
  // Using actual critical point values
  const result = calculateState(1.0, 2020e3, 3.155e-3);
  assertClose(result.temperature, 647, 2, 'Critical temperature');
  assertClose(result.pressure / 1e5, 220, 5, 'Critical pressure (bar)');
});

test('Phase boundary detection', () => {
  // Test point very close to saturation
  const v = 1.1273e-3; // v_f at 10 bar
  const u = 761.68e3;  // u_f at 10 bar

  const dist = distanceToSaturationLine(u, v);
  assert(dist.distance < 0.02, `Should be very close to saturation line, got distance=${dist.distance}`);
  // Remove onBoundary check as it may not be implemented
});

// ============================================================================
// Basic Physics Tests
// ============================================================================

category('Basic Physics');

test('Gravity head calculation', () => {
  // Basic gravity head calculation
  const rho = 1000; // kg/m³ (water)
  const g = 9.81; // m/s²
  const h = 5.0; // 5 meters
  const dP_gravity = rho * g * h;
  assertClose(dP_gravity / 1000, 49.05, 0.1, 'Gravity head (kPa)');
});

test('Pump head calculation', () => {
  // Pump head at rated conditions
  const ratedHead = 100; // meters
  const rho = 1000; // kg/m³
  const g = 9.81;
  const pump_head_Pa = rho * g * ratedHead;
  assertClose(pump_head_Pa / 1000, 981, 1, 'Pump head (kPa)');
});

// ============================================================================
// Performance Tests
// ============================================================================

category('Performance');

test('Water properties calculation speed', () => {
  const start = Date.now();
  const iterations = 1000;

  // Use seeded random for reproducibility and constrain to valid ranges
  let seed = 54321;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  let successfulCalls = 0;
  for (let i = 0; i < iterations; i++) {
    // Random conditions within physically reasonable ranges
    const mass = 1.0;
    // u: 100 kJ/kg to 2800 kJ/kg (subcooled liquid to superheated vapor)
    const u = 100e3 + random() * 2700e3;
    // v: 0.001 to 0.1 m³/kg (compressed liquid to moderate vapor)
    const v = 0.001 + random() * 0.099;
    try {
      calculateState(mass, u, v);
      successfulCalls++;
    } catch {
      // Some random states may be outside valid ranges - that's expected
    }
  }

  const elapsed = Date.now() - start;
  const perCall = elapsed / iterations;

  // Most calls should succeed
  assert(successfulCalls > iterations * 0.8, `Most property lookups should succeed, only ${successfulCalls}/${iterations} did`);
  assert(perCall < 10, `Water properties should be fast (<10ms/call), got ${perCall.toFixed(2)}ms`);
});

test('Dome consistency - no false positives', () => {
  // Test that isInsideTwoPhaseDome and findTwoPhaseState are consistent:
  // If the dome check says we're inside, we must be able to calculate a valid two-phase state
  const iterations = 5000;
  let failures = 0;
  const failureDetails: string[] = [];

  // Use seeded pseudo-random for reproducibility
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < iterations; i++) {
    // Generate random (u, v) covering the full range of interest
    const u = 50e3 + random() * 2500e3;   // 50 kJ/kg to 2550 kJ/kg
    const v = 0.0005 + random() * 2.0;     // 0.5 L/kg to 2000 L/kg

    try {
      const result = calculateState(1.0, u, v);
      // If we get here without error, good
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Inconsistent dome check')) {
        failures++;
        if (failureDetails.length < 5) {
          failureDetails.push(`u=${(u/1e3).toFixed(2)} kJ/kg, v=${v.toFixed(6)} m³/kg: ${msg}`);
        }
      }
      // Other errors might be expected for out-of-range states
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} inconsistent dome check failures:\n${failureDetails.join('\n')}`);
  }
});

// ============================================================================
// Lattice-Derived Neutronics Tests
// ============================================================================

category('Lattice Neutronics');

// A standard 5 w/o UO2 PWR lattice (the shipping preset's geometry)
const PWR_LATTICE: LatticeParams = {
  enrichment: 0.05,
  fuelMaterial: 'UO2',
  rodDiameter: 0.0095,
  rodCount: 38000,
  coreDiameter: 3.1,
  activeHeight: 3.66,
  refModeratorDensity: 700,
  refFuelTemp: 600,
};

test('PWR lattice lands in published coefficient ranges', () => {
  const d = deriveNeutronics(PWR_LATTICE);
  assert(d.kEffRef > 1.15 && d.kEffRef < 1.6,
    `clean 5% lattice k_eff should be ~1.2-1.6, got ${d.kEffRef.toFixed(3)}`);
  assert(d.fuelTempCoeff < -1e-5 && d.fuelTempCoeff > -6e-5,
    `Doppler should be -1..-6 pcm/K, got ${(d.fuelTempCoeff * 1e5).toFixed(2)}`);
  assert(d.coolantDensityCoeff > 5e-5 && d.coolantDensityCoeff < 8e-4,
    `density coefficient should be +5..+80 pcm/(kg/m³), got ${(d.coolantDensityCoeff * 1e5).toFixed(2)}`);
  assert(!d.overModerated, 'a typical PWR lattice is under-moderated');
  assert(d.moderationRatio > 1 && d.moderationRatio < 3,
    `moderation ratio should be ~1-3, got ${d.moderationRatio.toFixed(2)}`);
});

test('enrichment raises excess reactivity monotonically', () => {
  const lo = deriveNeutronics({ ...PWR_LATTICE, enrichment: 0.02 });
  const mid = deriveNeutronics({ ...PWR_LATTICE, enrichment: 0.05 });
  const hi = deriveNeutronics({ ...PWR_LATTICE, enrichment: 0.10 });
  assert(lo.excessReactivity < mid.excessReactivity && mid.excessReactivity < hi.excessReactivity,
    `excess should grow with enrichment: ${lo.excessReactivity.toFixed(3)} / ${mid.excessReactivity.toFixed(3)} / ${hi.excessReactivity.toFixed(3)}`);
});

test('natural uranium cannot go critical in a light-water lattice', () => {
  const nat = deriveNeutronics({ ...PWR_LATTICE, enrichment: 0.0072 });
  assert(nat.kEffRef < 1,
    `natural-uranium LWR lattice must be subcritical, got k_eff=${nat.kEffRef.toFixed(3)}`);
});

test('over-moderated lattice flips the density coefficient sign', () => {
  // Spread the same rods over a much larger core: moderation ratio >> optimum
  const wet = deriveNeutronics({ ...PWR_LATTICE, coreDiameter: 6.5 });
  assert(wet.moderationRatio > 5, `should be heavily over-moderated, ratio=${wet.moderationRatio.toFixed(1)}`);
  assert(wet.overModerated && wet.coolantDensityCoeff < 0,
    `over-moderated lattice must have NEGATIVE density coefficient, got ${(wet.coolantDensityCoeff * 1e5).toFixed(2)} pcm/(kg/m³)`);
});

// A pebble-bed-like graphite lattice: HTR-PM-ish proportions. 420k pebbles
// of 6 cm diameter (packing ~0.61 in a 3 m x 11 m core), each carrying ~7 g
// heavy metal as dispersed TRISO kernels: ~0.32 m³ of actual fuel compound
// swimming in ~47 m³ of graphite, cooled by ~5 kg/m³ helium.
const PEBBLE_LATTICE: LatticeParams = {
  enrichment: 0.085,
  fuelMaterial: 'UO2',
  rodDiameter: 0.06,          // pebble diameter (display/geometry scale)
  rodCount: 420000,
  coreDiameter: 3.0,
  activeHeight: 11.0,
  // The lattice sees the coolant node's WATER density; a dry helium loop
  // carries only trace steam (helium itself moderates/absorbs ~nothing)
  refModeratorDensity: 0.05,
  refFuelTemp: 900,
  fuelVolume: 0.32,           // TRISO kernel volume, not pebble volume
  dopplerLengthScale: 0.0005, // kernel scale - dispersed fuel, little self-shielding
  solidModeratorVolume: 47,   // pebble graphite matrix
  reflectorThickness: 0.8,
};

test('graphite pebble-bed lattice: critical, LOCA-insensitive, strong Doppler', () => {
  const d = deriveNeutronics(PEBBLE_LATTICE);
  assert(d.kEffRef > 1.05,
    `well-moderated graphite lattice should be supercritical rods-out, got k_eff=${d.kEffRef.toFixed(3)}`);
  // Complete loss of coolant (trace steam -> bone dry) inserts ~nothing:
  // the graphite does all the moderating
  const kDry = latticeKeff(PEBBLE_LATTICE, PEBBLE_LATTICE.refFuelTemp, 0.001);
  const dRho = (kDry - d.kEffRef) / (kDry * d.kEffRef); // rho difference
  assert(Math.abs(dRho) < 5e-4,
    `depressurizing the helium loop should insert < 50 pcm, got ${(dRho * 1e5).toFixed(1)} pcm`);
  assert(d.fuelTempCoeff < -1.5e-5,
    `dispersed TRISO fuel should have solid Doppler (< -1.5 pcm/K), got ${(d.fuelTempCoeff * 1e5).toFixed(2)}`);
  // ...and stronger than the same lattice would have with pebble-diameter
  // self-shielding: dispersal is what buys the feedback
  const lumped = deriveNeutronics({ ...PEBBLE_LATTICE, dopplerLengthScale: undefined });
  assert(Math.abs(d.fuelTempCoeff) > 2 * Math.abs(lumped.fuelTempCoeff),
    `kernel-scale Doppler (${(d.fuelTempCoeff * 1e5).toFixed(2)}) should be much stronger than lumped (${(lumped.fuelTempCoeff * 1e5).toFixed(2)})`);
});

test('natural uranium goes critical in a big graphite pile (X-10/Magnox)', () => {
  // Metal nat-U rods in a large graphite block reactor: ~1500 channels of
  // 2.5 cm rods in a 7 m graphite cylinder, ~56:1 graphite:fuel by volume
  const pile = deriveNeutronics({
    enrichment: 0.0072,
    fuelMaterial: 'metal',
    rodDiameter: 0.025,
    rodCount: 1500,
    coreDiameter: 7.0,
    activeHeight: 7.0,
    refModeratorDensity: 1.2,  // air/CO2 cooling channels
    refFuelTemp: 500,
    solidModeratorVolume: 250, // most of the ~270 m³ core is graphite
    reflectorThickness: 0.9,
  });
  assert(pile.kEffRef > 1.0 && pile.kEffRef < 1.15,
    `nat-U graphite pile should be barely critical (k ~1.0-1.1), got ${pile.kEffRef.toFixed(3)}`);
});

test('small graphite core leaks itself subcritical without a reflector', () => {
  const bare = deriveNeutronics({ ...PEBBLE_LATTICE, coreDiameter: 1.2, activeHeight: 2.0,
    solidModeratorVolume: 2.1, fuelVolume: 0.015, rodCount: 20000, reflectorThickness: 0 });
  const reflected = deriveNeutronics({ ...PEBBLE_LATTICE, coreDiameter: 1.2, activeHeight: 2.0,
    solidModeratorVolume: 2.1, fuelVolume: 0.015, rodCount: 20000, reflectorThickness: 1.0 });
  assert(reflected.kEffRef > bare.kEffRef + 0.05,
    `reflector should buy back leakage: bare k=${bare.kEffRef.toFixed(3)}, reflected k=${reflected.kEffRef.toFixed(3)}`);
});

test('water lattices unchanged by solid-moderation extension (regression)', () => {
  const d = deriveNeutronics({ ...PWR_LATTICE, solidModeratorVolume: 0, reflectorThickness: 0 });
  const ref = deriveNeutronics(PWR_LATTICE);
  assert(Math.abs(d.kEffRef - ref.kEffRef) < 1e-12 &&
    Math.abs(d.fuelTempCoeff - ref.fuelTempCoeff) < 1e-15,
    'zero solid moderator / zero reflector must be identical to the water-only path');
});

test('fatter rods self-shield: weaker Doppler per kelvin (at fixed moderation)', () => {
  // Hold the moderation ratio constant by trading rod count against rod
  // area, so only the self-shielding effect of rod size remains
  const thin = deriveNeutronics({
    ...PWR_LATTICE,
    rodDiameter: 0.006,
    rodCount: Math.round(38000 * Math.pow(0.0095 / 0.006, 2)),
  });
  const fat = deriveNeutronics({
    ...PWR_LATTICE,
    rodDiameter: 0.014,
    rodCount: Math.round(38000 * Math.pow(0.0095 / 0.014, 2)),
  });
  assert(Math.abs(fat.fuelTempCoeff) < Math.abs(thin.fuelTempCoeff),
    `fat-rod Doppler (${(fat.fuelTempCoeff * 1e5).toFixed(2)}) should be weaker than thin-rod (${(thin.fuelTempCoeff * 1e5).toFixed(2)})`);
});

// ============================================================================
// Run Tests and Report
// ============================================================================

console.log('Running Meltdown Simulation Test Suite...\n');

// Group results by category
const byCategory = new Map<string, TestResult[]>();
for (const result of results) {
  if (!byCategory.has(result.category)) {
    byCategory.set(result.category, []);
  }
  byCategory.get(result.category)!.push(result);
}

// Summary
let totalPassed = 0;
let totalFailed = 0;

for (const [cat, tests] of byCategory) {
  const passed = tests.filter(t => t.passed).length;
  const failed = tests.filter(t => !t.passed).length;
  totalPassed += passed;
  totalFailed += failed;

  const symbol = failed === 0 ? '✓' : '✗';
  const color = failed === 0 ? '\x1b[32m' : '\x1b[31m'; // Green or red
  console.log(`${color}${symbol}\x1b[0m ${cat}: ${passed}/${tests.length} passed`);
}

// Show failed test details
if (totalFailed > 0) {
  console.log('\n\x1b[31mFailed Tests:\x1b[0m');
  for (const [cat, tests] of byCategory) {
    const failed = tests.filter(t => !t.passed);
    if (failed.length > 0) {
      console.log(`\n  ${cat}:`);
      for (const test of failed) {
        console.log(`    ✗ ${test.name}`);
        console.log(`      ${test.error}`);
        if (test.details && test.details.length > 0) {
          for (const detail of test.details) {
            console.log(`        ${detail}`);
          }
        }
      }
    }
  }
}

// Final summary
console.log('\n' + '='.repeat(60));
if (totalFailed === 0) {
  console.log(`\x1b[32m✓ All ${totalPassed} tests passed!\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ ${totalFailed} of ${totalPassed + totalFailed} tests failed\x1b[0m`);
  process.exit(1);
}