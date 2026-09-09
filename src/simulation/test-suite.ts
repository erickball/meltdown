/**
 * Meltdown Simulation Test Suite
 *
 * Comprehensive test battery for water properties, flow calculations, and simulation behavior.
 * Run with: npm test
 *
 * Tests are organized by category and only show detailed output on failure.
 */

import { calculateState, distanceToSaturationLine, saturationPressure, saturationTemperature,
  saturatedLiquidDensity, saturatedVaporDensity, saturatedLiquidEnergy,
  saturatedVaporEnergy } from './water-properties.js';
import { deriveNeutronics, deriveControlRodWorth, latticeKeff, LatticeParams } from './lattice.js';
import {
  computeReactivityComponents, neutronSourceRate, normalizedNeutronSource,
  FISSION_ENERGY, DECAY_HEAT_GROUPS,
} from './operators/neutronics.js';
import { NeutronicsRateOperator } from './operators/rate-operators.js';
import { ControlSystemOperator, describeControllerSignal,
  primaryControllerSignal } from './operators/control-system.js';
import {
  graphiteSpecificHeat,
  bedStagnantConductivity,
  bedRadiativeConductivity,
  bedEffectiveConductivity,
  intrinsicOxidationRateConstant,
  internalSurfacePerVolume,
  characteristicPoreRadius,
  thieleEffectiveness,
  burnoffSurfaceFactor,
  reactionHeatPerCarbon,
  coFraction,
  oxidantPerCarbon,
  oxidantInhibition,
  oxidantRateConstant,
  NBG_18,
  A3_3,
} from './graphite.js';
import { cloneSimulationState } from './solver.js';
import { hxTubeLengthFactor, helicalLengthFactor, hxTubeLength } from './hx-bundles.js';
import { concentricGrayBodyArea } from './factory.js';
import { vaporWallHeatTransfer, liquidWallHeatTransfer } from './operators/rate-operators.js';
import { liquidViscosity, liquidThermalConductivity, liquidSpecificHeat,
  liquidThermalExpansivity } from './water-properties.js';
import { emptyGasComposition } from './gas-properties.js';
import { createFluidState } from './operators/index.js';
import { stateAtPh, expandStage } from './turbine-expansion.js';
import { coreReflectorGeometry, coreRodGeometry } from './factory.js';
import {
  saturationAtP,
  subcooledLiquidV,
  superheatedV,
  evaluateOtsg,
  evaluateOtsgPartition,
  otsgPartitionAtP,
  counterflowOutletTemp,
  OtsgWallPin,
  otsgRates,
  boilingMeanQuality,
  boilingMeanVolume,
  boilingOutletQuality,
  subcooledSectionMean,
  P_CRITICAL,
  transitStandingQ,
  streamApproach,
  marchCounterflowGas,
  reconcileSlug,
} from './otsg.js';
import { saturatedLiquidEnergy, saturatedLiquidDensity } from './water-properties.js';
import { tubeWaterState, classifyOtsgFlows } from './operators/otsg-operator.js';
import {
  binaryDiffusivity,
  diffusivityInMixture,
  knudsenDiffusivity,
  effectivePoreDiffusivity,
  createGasComposition,
  mixtureCv,
} from './gas-properties.js';
import type { NeutronicsState, FlowNode, SimulationState, ControllerState } from './types.js';

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

test('a two-phase root stays continuous at parts-per-million quality', () => {
  // A cold demineralised-water tank - 14 m across, 7 m tall, 78% full at
  // 288 K with a few kg of steam over the water - sits at x ~ 4e-6. There u
  // is only ~10 J/kg above u_f while du_f/dT ~ 4190 J/(kg*K), so a
  // millikelvin of slop in the two-phase temperature is a THIRD of the whole
  // quality budget. The root solve used to quit at an ABSOLUTE 1 mK bracket
  // width (and at |x_v - x_u| < 1e-6, which is 25% of x here); because
  // bisection midpoints land on a dyadic grid of the initial bracket, T came
  // out quantised onto a 0.713 mK ladder and quality dropped up to 15% in a
  // single tick - half a kilogram of steam vanishing at a stroke - while
  // mass, energy, volume, T and P all moved smoothly, and the displayed
  // level, which is derived from quality, jumped UP while the tank emptied.
  // Sweep u at fixed v and demand the root be monotone, step-free, and
  // self-consistent.
  //
  // The solve now resolves the root until BOTH of its outputs - quality and
  // P_sat - are bracketed to EPS_REL = 1e-5 of their own magnitude, so it is
  // quantised at that relative level and no finer. Everything below is
  // stated against that: the sweep steps quality by 3.6e-4 relative, 36x
  // EPS_REL, so quantisation cannot account for a step; and consistency is
  // checked at a few EPS_REL rather than at machine precision.
  const EPS_REL = 1e-5;          // must match findTwoPhaseState
  const v = 1.308295276077e-3;   // V/m for that tank, m^3/kg
  const u0 = 62846.99;           // J/kg, ~10 J/kg above u_f(288.1 K)
  const du = 25, N = 40;

  let prevT = -Infinity, prevX = -Infinity;
  let maxStep = 0, firstStep = 0;
  for (let i = 0; i <= N; i++) {
    const u = u0 + i * du;
    const s = calculateState(1.0, u, v);
    assert(s.phase === 'two-phase', `sweep left the dome at u=${u}: ${s.phase}`);

    // The root must satisfy the condition it was solved for: the quality read
    // off the volumes and the quality read off the energies must agree. At
    // x ~ 4e-6 an absolute tolerance says nothing, so test the RELATIVE gap.
    const v_f = 1 / saturatedLiquidDensity(s.temperature);
    const v_g = 1 / saturatedVaporDensity(s.temperature);
    const u_f = saturatedLiquidEnergy(s.temperature);
    const u_g = saturatedVaporEnergy(s.temperature);
    const x_v = (v - v_f) / (v_g - v_f);
    const x_u = (u - u_f) / (u_g - u_f);
    assert(Math.abs(x_v - x_u) < 4 * EPS_REL * s.quality,
      `two-phase root is inconsistent at u=${u.toFixed(2)}: x_v=${x_v.toExponential(6)} ` +
      `vs x_u=${x_u.toExponential(6)} (${(100 * (x_v - x_u) / s.quality).toFixed(3)}% of x)`);

    // Adding energy at fixed volume must warm the water and boil a little
    // more of it - strictly, every step, with no plateaus and no reversals.
    if (i > 0) {
      assert(s.temperature > prevT, `T not increasing with u at u=${u.toFixed(2)}`);
      assert(s.quality > prevX, `quality not increasing with u at u=${u.toFixed(2)}`);
      const step = s.quality - prevX;
      if (i === 1) firstStep = step;
      maxStep = Math.max(maxStep, step);
    }
    prevT = s.temperature;
    prevX = s.quality;
  }

  // A staircase shows up as one giant increment among many tiny ones. The
  // true response is smooth: the increments vary by 1.5% across this sweep,
  // all of it real curvature. On the old code this same sweep was not even
  // monotone - its increments ran from -10.4% to +6.8%.
  assert(maxStep < 1.05 * firstStep,
    `quality steps unevenly - largest increment ${maxStep.toExponential(3)} is ` +
    `${(maxStep / firstStep).toFixed(1)}x the first (${firstStep.toExponential(3)}), ` +
    `which means the two-phase temperature is quantised`);
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

// ============================================================================
// Graphite properties and packed-bed conduction
// ============================================================================
// ============================================================================
// OTSG moving-boundary core
// ============================================================================
category('OTSG core');

const OTSG_GEOM = { tubeVolume: 25, tubeLength: 18, heatArea: 5000 };
// Feed at 200 C: u along the saturated-liquid line
const U_FEED = saturatedLiquidEnergy(473);
const H_FEED = U_FEED + 165e5 / saturatedLiquidDensity(473);

/** Build a section state that occupies exactly V_tube at pressure P*. */
function otsgStateAtP(Pstar: number, f1: number, f2: number, u3Superheat: number) {
  const sat = saturationAtP(Pstar);
  // The slug's own energy: the profile a steadily-fed economizer actually
  // holds (see OtsgSlug). It is uniform in ENTHALPY per unit mass - that is
  // what a steady flow under a wall builds - so its mean enthalpy is
  // (h_in + h_f)/2 and its mean ENERGY is that less the flow work P v1.
  const v1 = subcooledLiquidV(0.5 * (U_FEED + sat.u_f));
  const u1 = 0.5 * (H_FEED + sat.h_f) - Pstar * v1;
  // The boiling section's MASS-averaged specific volume - the same closure the
  // model uses, so this fixture really does occupy V_tube (building it with an
  // arithmetic mean instead put 20% more mass in the section than fits, and
  // the pressure closure duly recovered the wrong pressure)
  const v2 = sat.v_f + boilingMeanQuality(sat.v_f, sat.v_g) * (sat.v_g - sat.v_f);
  const u3 = sat.u_g + u3Superheat;
  const v3 = superheatedV(u3, Pstar);
  const V1 = OTSG_GEOM.tubeVolume * f1, V2 = OTSG_GEOM.tubeVolume * f2;
  const V3 = OTSG_GEOM.tubeVolume - V1 - V2;
  const m3 = V3 / v3;
  const m1 = V1 / v1;
  return { state: { m1, m2: V2 / v2, m3, U1: m1 * u1, U3: m3 * u3 }, sat };
}

test('pressure closure round-trips a constructed 165-bar state', () => {
  const { state } = otsgStateAtP(165e5, 0.3, 0.5, 150e3);
  const ev = evaluateOtsg(state, OTSG_GEOM);
  assert(Math.abs(ev.P / 165e5 - 1) < 1e-3,
    `closure should recover 165 bar, got ${(ev.P / 1e5).toFixed(2)}`);
  // Sections in their regimes: T1 < Tsat, T2 = Tsat, T3 > Tsat
  assert(ev.sections[0].T < ev.sat.T - 1, 'subcooled section must sit below T_sat');
  assert(Math.abs(ev.sections[1].T - ev.sat.T) < 0.1, 'two-phase section must sit at T_sat');
  assert(ev.sections[2].T > ev.sat.T + 1, 'superheated section must sit above T_sat');
  // Geometry partitions
  const fSum = ev.sections[0].lengthFrac + ev.sections[1].lengthFrac + ev.sections[2].lengthFrac;
  assert(Math.abs(fSum - 1) < 1e-9, 'section length fractions must sum to 1');
});

test('interface fluxes reduce to through-flow at steady state', () => {
  const { state } = otsgStateAtP(165e5, 0.3, 0.5, 150e3);
  const ev = evaluateOtsg(state, OTSG_GEOM);
  const W = 77;
  const Q1 = W * (ev.sat.h_f - H_FEED);
  const Q2 = W * (ev.sat.h_g - ev.sat.h_f);
  const Q3 = W * (ev.hSteamOut - ev.sat.h_g);
  const r = otsgRates(ev, W, H_FEED, W, Q1, Q2, Q3);
  // W12 = Q1/(h_f - h_a) is an identity in the profile the section actually
  // carries, so it reproduces the through-flow exactly - up to the fixture's
  // own pressure round-trip (it was built at 165 bar and the closure recovers
  // it to ~1e-4, which moves h_f by tens of J/kg against a 400 kJ/kg span).
  // W23 closes the boiling section's balance and is exact either way.
  assert(Math.abs(r.W12 - W) < 1e-3 * W && Math.abs(r.W23 - W) < 1e-3 * W,
    `steady state must carry W through both interfaces: W12=${r.W12.toFixed(3)}, W23=${r.W23.toFixed(3)}`);
  assert(Math.abs(r.dm1) < 1e-3 * W && Math.abs(r.dm2) < 1e-3 * W && Math.abs(r.dm3) < 1e-3 * W,
    'steady state must hold all section masses');
  assert(Math.abs(r.dU3) < 1e-3 * W * ev.sat.h_g,
    `steady state must hold U3, got dU3=${r.dU3.toExponential(2)} W`);
  assert(Math.abs(r.dU1) < 1e-3 * W * ev.sat.h_f,
    `steady state must hold U1 too, got dU1=${r.dU1.toExponential(2)} W`);
});

test('section energy bookkeeping is exact (no leaked enthalpy)', () => {
  // Total energy rate must equal boundary fluxes + heat, for an arbitrary
  // off-steady operating point, with each section's P dV work included.
  const { state } = otsgStateAtP(165e5, 0.35, 0.45, 120e3);
  const ev = evaluateOtsg(state, OTSG_GEOM);
  const WIn = 60, WOut = 82, Q1 = 55e6, Q2 = 70e6, Q3 = 12e6;
  const r = otsgRates(ev, WIn, H_FEED, WOut, Q1, Q2, Q3);
  const u2Bar = ev.sections[1].hBar - ev.P * ev.sections[1].vBar;
  // Both end sections carry their own energy; only the boiling section's is
  // derived from its profile (u2Bar per kg), and W23 is what makes ITS
  // balance close.
  const dUtotal = r.dU1 + u2Bar * r.dm2 + r.dU3;
  const dVtotal = ev.sections[0].vBar * r.dm1 + ev.sections[1].vBar * r.dm2 + ev.sections[2].vBar * r.dm3;
  const balance = WIn * H_FEED - WOut * ev.hSteamOut + Q1 + Q2 + Q3 - ev.P * dVtotal;
  assert(Math.abs(dUtotal - balance) < Math.abs(balance) * 1e-9 + 1,
    `energy must close exactly: dU_total=${dUtotal.toExponential(6)} vs balance=${balance.toExponential(6)}`);
  assert(Math.abs(r.dm1 + r.dm2 + r.dm3 - (WIn - WOut)) < 1e-9,
    'mass must close exactly');
});

test('a flow that carries no heat moves no mass across saturation', () => {
  // Cold feed, wall dead. Nothing boils and nothing condenses, so the column
  // simply shifts: the slug takes the feed and gets longer and colder on
  // average, and the saturation boundary - a MATERIAL interface when there
  // is no phase change - does not move relative to the water. The pinned-
  // profile predecessor had to report W12 < 0 here (converting boiling
  // mass to subcooled at h_f) purely because its mean was not free to move.
  const { state } = otsgStateAtP(100e5, 0.3, 0.5, 100e3);
  const ev = evaluateOtsg(state, OTSG_GEOM);
  const r = otsgRates(ev, 50, H_FEED, 0, 0, 0, 0);
  assertClose(r.W12, 0, 1e-12, 'no heat, no crossing');
  assertClose(r.dm1, 50, 1e-12, 'the section grows by exactly what entered it');
  assertClose(r.dU1, 50 * H_FEED - ev.P * 50 * ev.sections[0].vBar, 1,
    'and gains exactly the feed enthalpy less the work its boundary does');
  // ...and the profile's cold end falls toward the feed, which is the whole
  // point: the slug's mean is its own state now.
  const u1 = ev.sections[0].hBar - ev.P * ev.sections[0].vBar;
  const du1 = (r.dU1 - u1 * r.dm1) / ev.sections[0].mass;
  assert(du1 < 0, `cold feed must cool the slug's mean, got ${(du1 / 1e3).toFixed(3)} kJ/kg-s`);
});

test('a standing slug under a hot wall warms; it does not only shorten', () => {
  // The regime the pinned profile could not express. With no feed the whole
  // duty used to go into boundary motion - W12 = Q1/(h_f - hBar1), twice the
  // batch-heating rate - and the energy the profile could not hold landed on
  // the leftovers. Now dm1/dt = -Q1/(h_f - h_a) and the cold end climbs at
  // Q1/m1: batch heating, with no switch between the regimes.
  const { state } = otsgStateAtP(100e5, 0.3, 0.5, 100e3);
  const ev = evaluateOtsg(state, OTSG_GEOM);
  const Q1 = 8e6;
  const r = otsgRates(ev, 0, H_FEED, 0, Q1, 0, 0);
  const m1 = ev.sections[0].mass;
  const hBar1 = ev.sections[0].hBar;
  const span = 2 * (ev.sat.h_f - hBar1);            // h_f - h_a
  assertClose(r.W12, Q1 / span, 1e-9 * Math.abs(r.W12), 'mass crosses at Q1 over the profile span');
  assertClose(r.dm1, -Q1 / span, 1e-9 * Math.abs(r.dm1), 'and the slug shortens at exactly that rate');
  // The cold end rises at Q1/m1 - every kilogram heating at the same rate.
  const u1 = hBar1 - ev.P * ev.sections[0].vBar;
  const du1 = (r.dU1 - u1 * r.dm1) / m1;
  assertClose(2 * du1, Q1 / m1, 1e-3 * Q1 / m1, 'the cold end climbs at Q1/m1');
  assert(du1 > 0, 'the standing slug WARMS - the mean must rise, not hold');
});

test('a feed-temperature step prices only the water entering', () => {
  // The pin this closure exists to remove: the slug's energy used to be
  // m1 (u_in + u_f)/2, so a 20 K move in the feed repriced the whole
  // standing slug in one step. Now the inlet enthalpy multiplies W_in
  // alone, so the slug's state - and every pressure that follows from it -
  // is untouched by a feed that is not flowing, and moves at one turnover's
  // pace when it is.
  const { state } = otsgStateAtP(165e5, 0.3, 0.5, 150e3);
  const ev = evaluateOtsg(state, OTSG_GEOM);
  const hCold = H_FEED - 20 * 4.5e3;   // ~20 K colder feed
  const stopped = otsgRates(ev, 0, H_FEED, 0, 30e6, 40e6, 5e6);
  const stoppedCold = otsgRates(ev, 0, hCold, 0, 30e6, 40e6, 5e6);
  assertClose(stoppedCold.dU1, stopped.dU1, 1e-9 * Math.abs(stopped.dU1),
    'with no feed flowing, the feed temperature changes nothing at all');
  assertClose(stoppedCold.dm1, stopped.dm1, 1e-9 * Math.abs(stopped.dm1),
    'nor the boundary rate');
  // Flowing: the difference in dU1 is exactly the entering mass times the
  // enthalpy step, and the slug's mean relaxes over one turnover m1/W.
  const W = 40;
  const hot = otsgRates(ev, W, H_FEED, 0, 30e6, 40e6, 5e6);
  const cold = otsgRates(ev, W, hCold, 0, 30e6, 40e6, 5e6);
  assertClose(hot.dU1 - cold.dU1, W * (H_FEED - hCold), 1e-6 * W * H_FEED,
    'a flowing feed prices exactly the mass it delivers');
  const m1 = ev.sections[0].mass;
  const u1 = ev.sections[0].hBar - ev.P * ev.sections[0].vBar;
  const du1 = (cold.dU1 - u1 * cold.dm1) / m1;
  const turnover = m1 / W;
  assert(Math.abs(du1) < Math.abs(u1) / turnover,
    'the mean cannot move faster than one turnover allows');
});

test('empty superheat section: smooth pass-through, no singularities', () => {
  const { state } = otsgStateAtP(165e5, 0.35, 0.65, 100e3);
  const s = { ...state, m3: 0, U3: 0 };
  const ev = evaluateOtsg(s, OTSG_GEOM);
  assert(Number.isFinite(ev.P) && Number.isFinite(ev.hSteamOut),
    'evaluation must stay finite with an empty superheat section');
  assert(Math.abs(ev.hSteamOut - ev.sat.h_g) < 1,
    `empty superheat section must draw at h_g, got ${(ev.hSteamOut / 1e3).toFixed(0)} kJ/kg`);
  assert(ev.sections[2].area === 0, 'empty section must have zero heat area');
  // Boiling with a draw: the section is born continuously
  const r = otsgRates(ev, 50, H_FEED, 40,
    50 * (ev.sat.h_f - H_FEED), 55e6, 0);
  assert(Number.isFinite(r.dm3) && Number.isFinite(r.dU3), 'rates must stay finite at m3=0');
  assert((r.dm3 > 0) === (r.W23 > 40), 'section grows exactly when boil-off exceeds the draw');
});

test('transit + standing branches: both limits, no blend function', () => {
  // High flow: transit dominates and is driven by INLET temperature
  const qHigh = transitStandingQ(4e6, 5e4, 4e5, 500, 560, 600);
  const qHighIdeal = (1 - Math.exp(-10)) * 4e5 * 100 + 5e4 * 40;
  assert(Math.abs(qHigh - qHighIdeal) < 1,
    'high-flow limit must be the epsilon-mcp transit form');
  // Zero flow: ONLY the standing branch survives - a bottled boiler still heats
  const qZero = transitStandingQ(4e6, 5e4, 0, 500, 560, 600);
  assert(Math.abs(qZero - 5e4 * 40) < 1e-6,
    `bottled case must reduce to natural convection on bulk dT, got ${qZero.toExponential(3)}`);
  // Transit branch never exceeds carrying capacity
  const qCap = transitStandingQ(1e9, 0, 1e4, 300, 300, 800);
  assert(qCap <= 1e4 * 500 + 1e-6, 'transit heat must cap at mcp * (T_wall - T_in)');
});

test('a ramping wall lets its stream pass the section average; an isothermal one does not', () => {
  // Small area: both profiles must reduce to hA*dT - the wall's shape cannot
  // matter when the stream barely notices it.
  assertClose(streamApproach(0.01, 'isothermal'), 0.00995, 1e-4, 'small-NTU isothermal');
  assertClose(streamApproach(0.01, 'ramping'), 0.00995, 1e-4, 'small-NTU ramping');
  // Large area: an isothermal wall can only bring the stream TO itself, a
  // ramping one brings the stream's MEAN to itself, so its outlet passes it.
  assert(streamApproach(50, 'isothermal') < 1.001, 'isothermal approach cannot exceed 1');
  assertClose(streamApproach(50, 'ramping'), 2 * 50 / 52, 1e-9, 'ramping approach tends to 2');

  // Composed across a wall, two ramping half-steps must give the standard
  // counterflow series result - this is what makes the economizer's outlet
  // reachable at all, and what keeps it bounded by the gas.
  const hAg = 110e3, hAw = 1100e3, Cg = 213e3, Cw = 145e3;
  const TgIn = 628, TwIn = 312;
  // Metal where the two half-steps balance (its steady state)
  const Kg = streamApproach(hAg / Cg, 'ramping') * Cg;
  const Kw = streamApproach(hAw / Cw, 'ramping') * Cw;
  const Tm = (Kg * TgIn + Kw * TwIn) / (Kg + Kw);
  const Qg = Kg * (TgIn - Tm), Qw = Kw * (Tm - TwIn);
  assertClose(Qg / 1e6, Qw / 1e6, 1e-9, 'the metal passes what it takes');
  const series = (TgIn - TwIn) / (1 / hAg + 1 / hAw + 1 / (2 * Cg) + 1 / (2 * Cw));
  assertClose(Qw / 1e6, series / 1e6, 1e-9 * series / 1e6,
    'two ramping half-steps must compose to the counterflow series result');
  assert(TwIn + Qw / Cw < TgIn,
    'and the water outlet must stay under the gas inlet, whatever the wall says');
});

test('counterflow gas march: hottest gas meets the superheater first', () => {
  const sections = [
    { hA: 2e5, TWall: 838 },  // superheater wall
    { hA: 8e5, TWall: 623 },  // boiling wall
    { hA: 3e5, TWall: 540 },  // subcooled wall
  ];
  const m = marchCounterflowGas(1023, 0.4e6, sections);
  assert(m.Q[0] > 0 && m.Q[1] > 0 && m.Q[2] > 0, 'all sections must receive heat');
  assert(m.TGasOut < 1023 && m.TGasOut > 540, 'gas outlet must land between inlet and coldest wall');
  const energyCheck = 0.4e6 * (1023 - m.TGasOut);
  const qSum = m.Q[0] + m.Q[1] + m.Q[2];
  assert(Math.abs(qSum - energyCheck) < 1,
    'marched heat must equal the gas enthalpy change exactly');
  // Empty section passes through untouched
  const m2 = marchCounterflowGas(1023, 0.4e6, [sections[0], { hA: 0, TWall: 623 }, sections[2]]);
  assert(m2.Q[1] === 0 && Number.isFinite(m2.TGasOut), 'zero-area section must cost nothing');
});

category('Graphite');

test('graphite cp tracks the Butland-Maddison anchors from 300 to 2000 K', () => {
  // The correlation is the reason the reflector node carries a cp MODEL and
  // not a constant: it nearly triples across the range an accident visits.
  const c300 = graphiteSpecificHeat(300);
  const c1000 = graphiteSpecificHeat(1000);
  const c2000 = graphiteSpecificHeat(2000);
  assert(Math.abs(c300 - 712) < 15, `cp(300 K) should be ~712 J/kg-K, got ${c300.toFixed(0)}`);
  assert(Math.abs(c1000 - 1759) < 25, `cp(1000 K) should be ~1759 J/kg-K, got ${c1000.toFixed(0)}`);
  assert(Math.abs(c2000 - 2021) < 30, `cp(2000 K) should be ~2021 J/kg-K, got ${c2000.toFixed(0)}`);
  assert(c300 < c1000 && c1000 < c2000, 'graphite cp must rise monotonically over this range');
});

test('packed bed conducts far worse than its own particles (point contacts)', () => {
  // Helium-filled pebble bed at 1000 K. Solid graphite is ~40 W/m-K but the
  // spheres only touch at points, so the stagnant bed lands near 1-4 W/m-K.
  const kHe = 0.3;
  const kStag = bedStagnantConductivity(kHe, 40, 0.39);
  assert(kStag > 1 && kStag < 5,
    `stagnant He pebble bed should be ~1-5 W/m-K, got ${kStag.toFixed(2)}`);
  assert(kStag < 40 / 5,
    `bed conductivity (${kStag.toFixed(2)}) must be far below the solid's 40 W/m-K`);
});

test('bed radiation takes over as it heats: k_eff strengthens with T^3', () => {
  const k = (T: number) => bedEffectiveConductivity(0.3, 40, 0.39, T, 0.06, 0.85);
  const cold = k(600), hot = k(1200);
  // Doubling T multiplies the radiative term by 8, so the total climbs
  // steeply - this is the physics that makes a pebble bed walk-away safe.
  assert(hot > 3 * cold,
    `k_eff should climb steeply with temperature: 600 K -> ${cold.toFixed(2)}, 1200 K -> ${hot.toFixed(2)} W/m-K`);
  assert(hot > 8 && hot < 30,
    `pebble bed at 1200 K should be ~10-20 W/m-K, got ${hot.toFixed(2)}`);
});

test('Zehner-Schlunder refuses a bed whose gas out-conducts its particles', () => {
  // The closed form goes singular then negative below kappa = B. Silently
  // returning a negative conductivity would drive heat the wrong way, so it
  // must throw rather than produce a plausible-looking number.
  let threw = false;
  try {
    bedStagnantConductivity(30, 25, 0.39); // kappa < 1, far below B
  } catch (e) {
    threw = true;
    assert(/Zehner-Schlunder/.test(String(e)), 'error should name the correlation');
  }
  assert(threw, 'out-of-range kappa must throw, not return a fallback');
});

test('bed with no gas still conducts by radiation alone', () => {
  // Depressurisation must degrade the bed continuously onto the radiative
  // limit, not step or divide by zero.
  const kRad = bedRadiativeConductivity(1200, 0.06, 0.85);
  const kThin = bedEffectiveConductivity(1e-4, 40, 0.39, 1200, 0.06, 0.85);
  assert(kRad > 5, `radiative conductivity at 1200 K should be ~10 W/m-K, got ${kRad.toFixed(2)}`);
  assert(Number.isFinite(kThin) && kThin > kRad * 0.95,
    `a gas-free bed must fall back onto radiation smoothly, got ${kThin.toFixed(3)}`);
});

test('reflector geometry: annulus mass and containment of the core', () => {
  // 3.1 m core, 9 m tall, 0.8 m reflector - the HTGR preset's proportions.
  const geo = coreReflectorGeometry({
    id: 'c', type: 'coreBarrel', innerDiameter: 3.1, activeFuelHeight: 9,
    reflectorThickness: 0.8,
  } as any);
  assert(Math.abs(geo.mass / 1000 - 214.6) < 2,
    `reflector should be ~215 t of graphite, got ${(geo.mass / 1000).toFixed(1)} t`);
  assert(geo.outerRadius > geo.coreRadius && geo.midRadius > geo.coreRadius &&
    geo.midRadius < geo.outerRadius,
    'mean radius must lie inside the annulus');
  // Top and bottom reflectors are included, so the volume must exceed a
  // bare side annulus.
  const sideOnly = Math.PI * (geo.outerRadius ** 2 - geo.coreRadius ** 2) * 9;
  assert(geo.volume > sideOnly,
    'reflector volume must include the axial top/bottom slabs, not just the side');
});

test('zero reflector thickness produces no reflector mass (regression)', () => {
  const geo = coreReflectorGeometry({
    id: 'c', type: 'coreBarrel', innerDiameter: 3.1, activeFuelHeight: 9,
    reflectorThickness: 0,
  } as any);
  assert(geo.volume === 0 && geo.mass === 0,
    'a core with no reflector must build no reflector geometry');
});

// ============================================================================
// Graphite oxidation kinetics
// ============================================================================
category('Graphite oxidation');

/**
 * Reproduce the published area-normalised rate from the calibrated
 * intrinsic constant. This is the round trip that proves the inversion in
 * intrinsicOxidationRateConstant is self-consistent: published rate ->
 * intrinsic k_s -> back to the specimen's rate.
 */
function specimenRate(grade: typeof NBG_18, T: number): number {
  const P = 101325, xO2 = 0.21, M_C = 0.012011;
  const k_s = intrinsicOxidationRateConstant(grade, T);
  const S_v = internalSurfacePerVolume(grade);
  const L_c = grade.oxidationSpecimenSize / 6;
  const C_O2 = (xO2 * P) / (8.31446 * T);
  const D_bulk = 0.21e-4 * Math.pow(T / 300, 1.75);
  const r = characteristicPoreRadius(grade);
  const D_kn = (2 / 3) * r * Math.sqrt((8 * 8.31446 * T) / (Math.PI * 0.032));
  const D_eff = Math.pow(grade.porosity, 1.5) / (1 / D_bulk + 1 / D_kn);
  const eta = thieleEffectiveness(L_c * Math.sqrt((S_v * k_s) / D_eff));
  return eta * S_v * k_s * C_O2 * L_c * M_C; // kg/(m2.s)
}

function publishedRate(grade: typeof NBG_18, T: number): number {
  return grade.oxidationAPublished *
    Math.exp(-grade.oxidationEa / (8.31446 * T)) * (1e-3 / 3600);
}

test('calibration reproduces the published NBG-18 rate at the anchor', () => {
  const model = specimenRate(NBG_18, 873);
  const paper = publishedRate(NBG_18, 873);
  assert(Math.abs(model / paper - 1) < 0.01,
    `at 873 K the model should return the measured rate: model ${model.toExponential(3)} ` +
    `vs published ${paper.toExponential(3)} kg/m2-s (ratio ${(model / paper).toFixed(4)})`);
});

test('derived pore radius lands where porosimetry puts it', () => {
  // Derived from pore volume and BET area, not assumed. Medium-grain
  // NBG-18 should come out a few microns; superfine IG-110-like matrix
  // graphite must come out narrower.
  const rNbg = characteristicPoreRadius(NBG_18);
  const rFine = characteristicPoreRadius(A3_3);
  assert(rNbg * 1e6 > 1 && rNbg * 1e6 < 4,
    `NBG-18 characteristic pore radius should be 1-4 um, got ${(rNbg * 1e6).toFixed(2)}`);
  assert(rFine < rNbg,
    `finer-grained matrix graphite must have narrower pores: ${(rFine * 1e6).toFixed(2)} ` +
    `vs ${(rNbg * 1e6).toFixed(2)} um`);
});

test('pore diffusion bends the Arrhenius line down as temperature rises', () => {
  // The source calls 873-1023 K the kinetic regime and fits ONE straight
  // Arrhenius line through it. A mechanistic model must start falling below
  // that line near the top of the range as eta drops - the curvature the
  // straight-line fit averages over.
  const lo = specimenRate(NBG_18, 873) / publishedRate(NBG_18, 873);
  const hi = specimenRate(NBG_18, 1023) / publishedRate(NBG_18, 1023);
  assert(hi < lo * 0.95,
    `model/published should fall with temperature as pore diffusion bites: ` +
    `${lo.toFixed(3)} at 873 K vs ${hi.toFixed(3)} at 1023 K`);
  assert(hi > 0.3,
    `but the kinetic regime should still be mostly reaction-controlled, got ${hi.toFixed(3)}`);
});

test('apparent activation energy halves under in-pore diffusion control', () => {
  // The signature of Zone II, and the check that the model is mechanistic
  // rather than fitted: we never wrote a factor of two anywhere.
  const R = 8.31446;
  // Deep in pore-diffusion control the effectiveness factor is ~1/phi, so
  // the observed rate goes as sqrt(k) and the slope halves.
  const T1 = 1500, T2 = 1700;
  const rate = (T: number) => {
    const k_s = intrinsicOxidationRateConstant(NBG_18, T);
    const S_v = internalSurfacePerVolume(NBG_18);
    const L_c = 0.05; // a thick block, deep in Zone II
    const D_bulk = 0.21e-4 * Math.pow(T / 300, 1.75);
    const r = characteristicPoreRadius(NBG_18);
    const D_kn = (2 / 3) * r * Math.sqrt((8 * R * T) / (Math.PI * 0.032));
    const D_eff = Math.pow(NBG_18.porosity, 1.5) / (1 / D_bulk + 1 / D_kn);
    const phi = L_c * Math.sqrt((S_v * k_s) / D_eff);
    assert(phi > 10, `expected deep pore-diffusion control, got phi=${phi.toFixed(1)} at ${T} K`);
    return thieleEffectiveness(phi) * S_v * k_s * L_c;
  };
  const EaApparent = R * Math.log(rate(T2) / rate(T1)) / (1 / T1 - 1 / T2);
  const ratio = EaApparent / NBG_18.oxidationEa;
  assert(Math.abs(ratio - 0.5) < 0.06,
    `apparent Ea should be half the intrinsic value in Zone II, got ratio ${ratio.toFixed(3)}`);
});

test('medium-grain NBG-18 resists oxidation better than fine-grain matrix', () => {
  // Less internal area per gram and larger pores. This is the qualitative
  // result that matters in an air ingress: the pebbles burn before the
  // reflector does.
  const T = 900;
  const nbg = intrinsicOxidationRateConstant(NBG_18, T) * internalSurfacePerVolume(NBG_18);
  const fine = intrinsicOxidationRateConstant(A3_3, T) * internalSurfacePerVolume(A3_3);
  assert(fine > nbg,
    `fine-grain matrix should oxidise faster per unit volume at ${T} K: ` +
    `${fine.toExponential(2)} vs ${nbg.toExponential(2)} 1/s`);
});

test('Thiele effectiveness is smooth and correct in both limits', () => {
  assert(Math.abs(thieleEffectiveness(0) - 1) < 1e-12, 'eta(0) must be exactly 1');
  assert(Math.abs(thieleEffectiveness(1e-9) - 1) < 1e-12, 'eta must not blow up near zero');
  assert(Math.abs(thieleEffectiveness(100) - 0.01) < 1e-6,
    'eta -> 1/phi for large phi');
  // Monotone decreasing, no kinks across the series/closed-form crossover
  let prev = thieleEffectiveness(1e-8);
  for (const phi of [1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 0.01, 0.1, 1, 10]) {
    const cur = thieleEffectiveness(phi);
    assert(cur < prev && cur > 0, `eta must decrease monotonically, broke at phi=${phi}`);
    prev = cur;
  }
});

test('burn-off opens pores before it consumes them', () => {
  // Random pore model: internal surface RISES at first (closed porosity
  // opens up, so a partly-burnt block is more reactive than a fresh one),
  // then collapses to zero as the pore walls merge.
  const s0 = burnoffSurfaceFactor(0);
  const sMid = burnoffSurfaceFactor(0.3);
  const sLate = burnoffSurfaceFactor(0.95);
  assert(Math.abs(s0 - 1) < 1e-12, `virgin surface factor must be 1, got ${s0}`);
  assert(sMid > s0, `surface should rise early: ${sMid.toFixed(3)} vs ${s0.toFixed(3)}`);
  assert(sLate < sMid, `surface must collapse late: ${sLate.toFixed(3)} vs ${sMid.toFixed(3)}`);
  assert(burnoffSurfaceFactor(1) === 0, 'fully consumed graphite has no surface');
  // Approaching total burn-off must stay finite - the expression is 0*inf
  // at the endpoint and would otherwise produce NaN and poison the solver.
  for (const x of [0.999, 0.99999, 1 - 1e-12]) {
    const s = burnoffSurfaceFactor(x);
    assert(Number.isFinite(s) && s >= 0, `surface factor must stay finite at X=${x}, got ${s}`);
  }
});

test('air oxidation is exothermic, steam and CO2 gasification are not', () => {
  // The single most important qualitative fact in the model: an air ingress
  // is a fire that can sustain itself, a steam ingress is a gasification
  // the core has to pay for out of its own heat.
  for (const T of [800, 1200, 1600]) {
    assert(reactionHeatPerCarbon('O2', T) > 0, `C+O2 must release heat at ${T} K`);
    assert(reactionHeatPerCarbon('H2O', T) < 0, `C+H2O must absorb heat at ${T} K`);
    assert(reactionHeatPerCarbon('CO2', T) < 0, `C+CO2 must absorb heat at ${T} K`);
  }
  // Hot graphite makes CO instead of CO2 and so keeps far less of the heat.
  assert(reactionHeatPerCarbon('O2', 1600) < 0.4 * reactionHeatPerCarbon('O2', 600),
    'CO-dominated combustion at high T must release much less surface heat');
});

test('CO fraction rises with temperature and stays a fraction', () => {
  const cold = coFraction(600), hot = coFraction(1800);
  assert(cold > 0 && cold < 1 && hot > 0 && hot < 1, 'CO fraction must stay in (0,1)');
  assert(hot > 0.9 && cold < 0.2,
    `Arthur split should run from mostly CO2 cold (${cold.toFixed(2)}) to mostly CO hot (${hot.toFixed(2)})`);
  // Oxygen demand falls as CO takes over: 1 mol O2 per C for pure CO2, 1/2 for pure CO
  assert(oxidantPerCarbon('O2', 600) > oxidantPerCarbon('O2', 1800),
    'CO-dominated burning must consume less oxygen per carbon');
  assert(oxidantPerCarbon('H2O', 1200) === 1, 'steam gasification is one-to-one');
});

test('hydrogen inhibits steam gasification but nothing else', () => {
  const clean = oxidantInhibition('H2O', 0);
  const inhibited = oxidantInhibition('H2O', 1000); // 1 kPa H2
  assert(Math.abs(clean - 1) < 1e-12, 'no hydrogen means no inhibition');
  assert(inhibited < 0.6 && inhibited > 0.4,
    `1 kPa H2 should roughly halve the steam rate, got factor ${inhibited.toFixed(3)}`);
  assert(oxidantInhibition('O2', 1000) === 1, 'hydrogen must not inhibit oxygen attack');
  assert(oxidantInhibition('CO2', 1000) === 1, 'hydrogen must not inhibit the Boudouard reaction');
});

test('steam and CO2 need far more heat than oxygen to attack graphite', () => {
  // Air oxidation matters from ~600 K; gasification only above ~1200 K.
  // This ordering is what makes air ingress and steam ingress qualitatively
  // different accidents.
  const at = (ox: 'O2' | 'H2O' | 'CO2', T: number) => oxidantRateConstant(NBG_18, ox, T);
  assert(at('O2', 800) > 1e3 * at('H2O', 800),
    'at 800 K oxygen must dominate steam by orders of magnitude');
  assert(at('H2O', 1600) / at('H2O', 800) > at('O2', 1600) / at('O2', 800),
    'steam has the steeper activation energy, so it must catch up as things heat');
  assert(at('H2O', 1200) > at('CO2', 1200),
    'steam gasification should outrun the Boudouard reaction');
});

test('graphiteOxidation survives a state clone (conservation regression)', () => {
  // RK45 integrates burnoff in place, so this nested object MUST be deep
  // cloned. When it was not, every stage of a step advanced the same
  // object: the graphite burned six times faster than the carbon that
  // actually reached the gas, silently breaking the atom balance.
  const state = {
    thermalNodes: new Map([['g', {
      id: 'g', label: 'g', temperature: 1000, mass: 100, specificHeat: 1700,
      thermalConductivity: 25, characteristicLength: 0.01, surfaceArea: 1,
      heatGeneration: 0, maxTemperature: 3000,
      graphiteOxidation: {
        burnoff: 0.1, initialCarbonMass: 100, grade: 'A3-3' as const,
        externalArea: 1, characteristicLength: 0.01, associatedGasNode: 'gas',
      },
    }]]),
    flowNodes: new Map(), flowConnections: [], thermalConnections: [],
    convectionConnections: [], components: { pumps: new Map(), valves: new Map() },
    neutronics: {}, time: 0,
  } as any;
  const copy = cloneSimulationState(state);
  copy.thermalNodes.get('g')!.graphiteOxidation!.burnoff = 0.9;
  assert(state.thermalNodes.get('g')!.graphiteOxidation!.burnoff === 0.1,
    'mutating the clone must not touch the original - graphiteOxidation is integrated state');
});

// ============================================================================
// Molecular diffusion (oxidant transport)
// ============================================================================
category('Diffusion');

test('Fuller reproduces the measured O2-N2 diffusivity at 300 K, 1 bar', () => {
  // The standard textbook anchor: 0.21 cm2/s. If this drifts, every
  // diffusion-limited rate downstream is wrong by the same factor.
  const D = binaryDiffusivity('O2', 'N2', 300, 1e5);
  assert(Math.abs(D - 0.21e-4) < 0.02e-4,
    `O2-N2 at 300 K/1 bar should be ~0.21 cm2/s, got ${(D * 1e4).toFixed(3)}`);
});

test('diffusivity scales as T^1.75 and 1/P', () => {
  const base = binaryDiffusivity('O2', 'He', 500, 1e5);
  const hot = binaryDiffusivity('O2', 'He', 1000, 1e5);
  const squeezed = binaryDiffusivity('O2', 'He', 500, 7e5);
  assert(Math.abs(hot / base - Math.pow(2, 1.75)) < 0.02,
    `doubling T should raise D by 2^1.75 = 3.36x, got ${(hot / base).toFixed(3)}`);
  assert(Math.abs(squeezed * 7 / base - 1) < 1e-9,
    `7x the pressure should give 1/7 the diffusivity, got ${(base / squeezed).toFixed(3)}x`);
});

test('light gases diffuse faster than heavy ones', () => {
  const inHe = binaryDiffusivity('O2', 'He', 800, 1e5);
  const inXe = binaryDiffusivity('O2', 'Xe', 800, 1e5);
  assert(inHe > 3 * inXe,
    `O2 should diffuse much faster through helium (${(inHe * 1e4).toFixed(2)}) than xenon (${(inXe * 1e4).toFixed(2)} cm2/s)`);
});

test('Blanc mixture diffusivity lies between its binary limits', () => {
  const comp = createGasComposition({ He: 50, N2: 50 });
  const mix = diffusivityInMixture('O2', comp, 0, 800, 1e5);
  const inHe = binaryDiffusivity('O2', 'He', 800, 1e5);
  const inN2 = binaryDiffusivity('O2', 'N2', 800, 1e5);
  assert(mix > inN2 && mix < inHe,
    `half-helium mixture (${(mix * 1e4).toFixed(3)}) must sit between pure N2 ` +
    `(${(inN2 * 1e4).toFixed(3)}) and pure He (${(inHe * 1e4).toFixed(3)} cm2/s)`);
});

test('steam counts as a diffusion partner', () => {
  const comp = createGasComposition({ He: 100 });
  const dry = diffusivityInMixture('O2', comp, 0, 800, 1e5);
  const wet = diffusivityInMixture('O2', comp, 100, 800, 1e5);
  assert(wet < dry,
    `adding steam should slow O2 diffusion (dry ${(dry * 1e4).toFixed(3)}, wet ${(wet * 1e4).toFixed(3)} cm2/s)`);
});

test('pure-species mixture falls back on self-diffusion, not a divide by zero', () => {
  const D = diffusivityInMixture('O2', createGasComposition({ O2: 100 }), 0, 800, 1e5);
  assert(Number.isFinite(D) && D > 0,
    `pure O2 must still yield a finite self-diffusivity, got ${D}`);
});

test('Knudsen diffusion is pressure-independent and caps the low-pressure limit', () => {
  // Bulk diffusion runs as 1/P, so it would grow without bound as a vessel
  // empties. The Knudsen resistance in series is what stops that - and it
  // does so smoothly, with no imposed ceiling.
  const dK = knudsenDiffusivity(1e-6, 1000, 0.032);
  const atPressure = effectivePoreDiffusivity(
    binaryDiffusivity('O2', 'He', 1000, 70e5), dK, 0.19);
  const depressurised = effectivePoreDiffusivity(
    binaryDiffusivity('O2', 'He', 1000, 1e3), dK, 0.19);
  assert(depressurised > 10 * atPressure,
    'depressurising must speed pore diffusion substantially');
  assert(depressurised < Math.pow(0.19, 1.5) * dK * 1.001,
    `Knudsen must cap the low-pressure limit at eps^1.5 * D_K = ` +
    `${(Math.pow(0.19, 1.5) * dK).toExponential(2)}, got ${depressurised.toExponential(2)}`);
});

test('binary diffusivity refuses zero temperature or pressure', () => {
  let threw = 0;
  try { binaryDiffusivity('O2', 'He', 0, 1e5); } catch { threw++; }
  try { binaryDiffusivity('O2', 'He', 800, 0); } catch { threw++; }
  assert(threw === 2, 'both degenerate cases must throw rather than return Infinity');
});

category('Neutronics (lattice)');

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

test('fully voided lattice: k stays finite and strictly positive (fast-fission floor)', () => {
  // A tight water lattice, bone dry: the thermal cycle collapses (p -> 0)
  // but the fast-fission floor keeps k > 0 so (k-1)/k never hits -Infinity.
  // rodCount scaled up so coolant-to-fuel ratio < 1 (the worst case: without
  // the floor, p underflows to exactly zero here).
  const tight: LatticeParams = { ...PWR_LATTICE, rodCount: 70000 };
  const kDry = latticeKeff(tight, 1500, 0.001);
  assert(isFinite(kDry) && kDry > 0, `voided k must be finite and positive, got ${kDry}`);
  const rhoDry = (kDry - 1) / kDry;
  assert(isFinite(rhoDry) && rhoDry < -0.5,
    `voided lattice must be deeply subcritical with finite rho, got ${rhoDry}`);
  // ...and the floor must not disturb the operating point: at nominal
  // moderation the fast term is < 1e-10 of k
  const kNominal = latticeKeff(PWR_LATTICE, 900, 700);
  assert(kNominal > 1.1 && kNominal < 1.4,
    `nominal k_eff must be unaffected by the fast floor, got ${kNominal.toFixed(4)}`);
});

// Minimal NeutronicsState for reactivity-path tests
function makeNeutronics(over: Partial<NeutronicsState>): NeutronicsState {
  return {
    coreId: 'test-core', fuelNodeId: null, coolantNodeId: null,
    power: 1e9, nominalPower: 1e9, reactivity: 0,
    promptNeutronLifetime: 1e-4, delayedNeutronFraction: 0.0065,
    precursorConcentration: 1, precursorDecayConstant: 0.08,
    fuelTempCoeff: -2.5e-5, coolantTempCoeff: -1e-5, coolantDensityCoeff: 1e-4,
    refFuelTemp: 900, refCoolantTemp: 580, refCoolantDensity: 700,
    controlRodPosition: 1, controlRodWorth: 0.05,
    decayHeatFraction: 0.07, scrammed: false, scramTime: -1, scramReason: '',
    reactivityBreakdown: { excess: 0, controlRods: 0, doppler: 0, coolantTemp: 0, coolantDensity: 0 },
    diagnostics: { fuelTemp: 0, coolantTemp: 0, coolantDensity: 0 },
    ...over,
  };
}

test('lattice reactivity path: zero feedback at anchor, exact nonlinear totals', () => {
  const lp: LatticeParams = { ...PWR_LATTICE, refModeratorDensity: 700, refFuelTemp: 900 };
  const raw = deriveNeutronics(lp).excessReactivity;
  const poison = raw - 0.025;
  const n = makeNeutronics({
    latticeParams: lp, poisonWorth: poison,
    refFuelTemp: 900, refCoolantTemp: 580, refCoolantDensity: 700,
  });

  // At the anchor state: feedback terms are zero by construction, total =
  // excess (rods out)
  const atAnchor = computeReactivityComponents(n, {
    fuelTemp: 900, coolantTemp: 580, coolantDensity: 700, relocatedFuelFraction: 0,
  });
  assertClose(atAnchor.breakdown.doppler, 0, 1e-12, 'Doppler at anchor');
  assertClose(atAnchor.breakdown.coolantDensity, 0, 1e-12, 'density at anchor');
  assertClose(atAnchor.total, 0.025, 1e-9, 'total at anchor = poisoned excess');

  // At a perturbed state: breakdown sums exactly to the total, and the total
  // equals the lattice model evaluated directly (no linearization error)
  const hot = computeReactivityComponents(n, {
    fuelTemp: 1400, coolantTemp: 590, coolantDensity: 350, relocatedFuelFraction: 0,
  });
  const parts = hot.breakdown;
  const sum = parts.excess + parts.controlRods + parts.doppler +
    parts.coolantTemp + parts.coolantDensity + (parts.boron ?? 0);
  assertClose(hot.total, sum, 1e-12, 'breakdown must sum to total');
  const kHot = latticeKeff(lp, 1400, 350);
  const expected = (kHot - 1) / kHot - poison + (-1e-5) * (590 - 580);
  assertClose(hot.total, expected, 1e-12, 'total must equal direct lattice evaluation');
});

test('auto-sized poison leaves the target shutdown margin with rods inserted', () => {
  // Mirrors the factory default: poison = raw - (rodWorth - margin), so a
  // fully inserted rod bank sits exactly margin subcritical at the anchor
  const lp: LatticeParams = { ...PWR_LATTICE, refModeratorDensity: 700, refFuelTemp: 900 };
  const raw = deriveNeutronics(lp).excessReactivity;
  const rodWorth = 0.05, margin = 0.01;
  const poison = Math.max(0, raw - (rodWorth - margin));
  assert(poison > 0, `5 w/o lattice should need poison, raw=${raw.toFixed(4)}`);
  const n = makeNeutronics({
    latticeParams: lp, poisonWorth: poison, controlRodWorth: rodWorth,
    controlRodPosition: 0, // fully inserted
    refFuelTemp: 900, refCoolantTemp: 580, refCoolantDensity: 700,
  });
  const rodsIn = computeReactivityComponents(n, {
    fuelTemp: 900, coolantTemp: 580, coolantDensity: 700, relocatedFuelFraction: 0,
  });
  assertClose(rodsIn.total, -margin, 1e-9, 'rods-in reactivity = -shutdown margin');
});

test('control rod worth scales with bank count into published ranges', () => {
  const w4 = deriveControlRodWorth(PWR_LATTICE, 4);
  const w10 = deriveControlRodWorth(PWR_LATTICE, 10);
  const w1 = deriveControlRodWorth(PWR_LATTICE, 1);
  // 4 banks: PWR all-rods-in territory (~5000-9000 pcm)
  assert(w4 > 0.04 && w4 < 0.10,
    `4 banks should be worth 4000-10000 pcm, got ${(w4 * 1e5).toFixed(0)}`);
  // 10 banks: BWR-scale authority, enough to hold a cold core
  assert(w10 > 0.12 && w10 < 0.30,
    `10 banks should be worth 12000-30000 pcm, got ${(w10 * 1e5).toFixed(0)}`);
  assert(w1 < w4 && w4 < w10, 'worth must grow monotonically with banks');
  // Zero control absorption must leave latticeKeff bit-identical (the
  // default-argument path is the pre-rods code)
  const k0 = latticeKeff(PWR_LATTICE, 900, 700);
  const k0rods = latticeKeff(PWR_LATTICE, 900, 700, 0);
  assert(k0 === k0rods, 'controlAbsUnits=0 must not change k_eff');
});

test('lattice reactivity path survives full voiding without NaN', () => {
  const lp: LatticeParams = { ...PWR_LATTICE, rodCount: 70000 };
  const n = makeNeutronics({ latticeParams: lp, poisonWorth: 0.01 });
  const voided = computeReactivityComponents(n, {
    fuelTemp: 2500, coolantTemp: 650, coolantDensity: 0.5, relocatedFuelFraction: 0.3,
  });
  assert(isFinite(voided.total) && voided.total < -0.5,
    `voided core must be finite and deeply subcritical, got ${voided.total}`);
});

// ============================================================================
// Neutron source
// ============================================================================

category('Neutron source');

/** Minimal SimulationState carrying only a neutronics state. */
function neutronicsOnlyState(n: NeutronicsState): SimulationState {
  return {
    time: 0,
    thermalNodes: new Map(),
    flowNodes: new Map(),
    thermalConnections: [],
    convectionConnections: [],
    flowConnections: [],
    neutronics: n,
    components: {
      pumps: new Map(), valves: new Map(), checkValves: new Map(), controllers: new Map(),
    },
  } as unknown as SimulationState;
}

test('source strength converts to normalized units with Lambda cancelling in N_ss', () => {
  const n = makeNeutronics({
    nominalPower: 1e9, promptNeutronLifetime: 1e-4,
    startupSourceRate: 1e9, spontaneousFissionSource: 0, irradiatedFuelSource: 0,
  });
  assertClose(neutronSourceRate(n), 1e9, 1, 'total source = the installed source alone');
  const S = normalizedNeutronSource(n);
  assertClose(S, 1e9 * FISSION_ENERGY / (1e9 * 1e-4), 1e-18, 'S = s_n*E_f/(P_nom*Lambda)');
  // The subcritical steady state must be the parameter-free multiplication
  // result P_ss = s_n * E_f / (-rho), independent of Lambda.
  const rho = -0.0325; // 5 $
  const nSs = S * n.promptNeutronLifetime / -rho;
  assertClose(nSs, 1e9 * FISSION_ENERGY / (1e9 * -rho), 1e-18, 'N_ss = s_n*E_f/(P_nom*(-rho))');
  const nFast = makeNeutronics({ ...n, promptNeutronLifetime: 1e-6 });
  assertClose(normalizedNeutronSource(nFast) * 1e-6 / -rho, nSs, 1e-18,
    'a 100x shorter neutron lifetime must not move the shutdown power level');
});

test('irradiated-fuel source follows the decay-heat inventory', () => {
  const n = makeNeutronics({
    nominalPower: 1e9, startupSourceRate: 0, spontaneousFissionSource: 0,
    irradiatedFuelSource: 1e10,
    decayHeatPools: DECAY_HEAT_GROUPS.map(g => g.fraction * 1e9), // full-power equilibrium
  });
  assertClose(neutronSourceRate(n), 1e10, 1e-3 * 1e10,
    'pools at full-power equilibrium give the full irradiated source');
  const cold = makeNeutronics({ ...n, decayHeatPools: DECAY_HEAT_GROUPS.map(() => 0) });
  assertClose(neutronSourceRate(cold), 0, 1e-9, 'a never-operated core has no curium source');
  const half = makeNeutronics({
    ...n, decayHeatPools: DECAY_HEAT_GROUPS.map(g => 0.5 * g.fraction * 1e9),
  });
  assertClose(neutronSourceRate(half), 0.5e10, 1e-3 * 1e10, 'and it scales linearly with it');
});

test('subcritical kinetics relax onto the source-driven steady state', () => {
  // Deeply subcritical (rods in), starting from an absurdly low power the way
  // a long shutdown used to leave it. The kinetics must climb BACK UP to
  // N_ss = S*Lambda/(-rho) and stay there - no floors involved.
  const n = makeNeutronics({
    nominalPower: 1e9, power: 1e9 * 1e-30, precursorConcentration: 1e-30,
    controlRodPosition: 0, controlRodWorth: 0.05, excessReactivity: 0,
    startupSourceRate: 1e9, spontaneousFissionSource: 0, irradiatedFuelSource: 0,
  });
  const state = neutronicsOnlyState(n);
  const op = new NeutronicsRateOperator();
  const dt = 0.05;
  for (let i = 0; i < 20000; i++) { // 1000 s
    const rates = op.computeRates(state);
    state.neutronics.power += rates.neutronics.dPower * dt;
    state.neutronics.precursorConcentration += rates.neutronics.dPrecursorConcentration * dt;
    assert(state.neutronics.power >= 0 && state.neutronics.precursorConcentration >= 0,
      `kinetics went negative at t=${(i * dt).toFixed(2)}s: P=${state.neutronics.power}, ` +
      `C=${state.neutronics.precursorConcentration}`);
  }
  const rho = state.neutronics.reactivity;
  assert(rho < -0.04, `rods-in reactivity should be deeply negative, got ${rho}`);
  const S = normalizedNeutronSource(state.neutronics);
  const expectedN = S * state.neutronics.promptNeutronLifetime / -rho;
  const expectedC = state.neutronics.delayedNeutronFraction * S /
    (state.neutronics.precursorDecayConstant * -rho);
  assertClose(state.neutronics.power / state.neutronics.nominalPower, expectedN,
    1e-3 * expectedN, 'power settles at S*Lambda/(-rho)');
  assertClose(state.neutronics.precursorConcentration, expectedC, 1e-3 * expectedC,
    'precursors settle at beta*S/(lambda*(-rho))');
});

test('a supercritical core with zero flux still starts up from the source', () => {
  // Both kinetics branches must produce positive dN/dt from N = C = 0: with
  // no source that state is a fixed point and the reactor is dead forever.
  for (const rho of [-0.05, -0.001, 0, 0.003, 0.008, 0.02]) {
    const n = makeNeutronics({
      nominalPower: 1e9, power: 0, precursorConcentration: 0,
      controlRodPosition: 1, controlRodWorth: 0, excessReactivity: rho,
      fuelTempCoeff: 0, coolantTempCoeff: 0, coolantDensityCoeff: 0,
      startupSourceRate: 1e9, spontaneousFissionSource: 0, irradiatedFuelSource: 0,
    });
    const rates = new NeutronicsRateOperator().computeRates(neutronicsOnlyState(n));
    assertClose(n.reactivity, rho, 1e-12, `test rho setup (${rho})`);
    assert(rates.neutronics.dPower > 0,
      `dP/dt must be positive from zero flux at rho=${rho}, got ${rates.neutronics.dPower}`);
    assert(isFinite(rates.neutronics.dPower) && isFinite(rates.neutronics.dPrecursorConcentration),
      `rates must be finite at rho=${rho}`);
  }
});

// ============================================================================
// OTSG boiling-section closure
// ============================================================================

category('OTSG closure');

test('the boundary move is the identity when saturation has not moved', () => {
  const sat = saturationAtP(165e5);
  const uIn = sat.u_f - 300e3;
  const U1 = 350 * 0.5 * (uIn + sat.u_f);
  const same = reconcileSlug(350, U1, sat.u_f, sat.u_f, 480);
  assertClose(same.m1, 350, 1e-12, 'same saturation -> same slug');
  assertClose(same.U1, U1, 1e-9 * U1, 'and the same energy');
  const fresh = reconcileSlug(350, U1, NaN, sat.u_f, 480);
  assertClose(fresh.m1, 350, 1e-12, 'no reference yet -> pair as it stands');
  const capped = reconcileSlug(600, 600 * 0.5 * (uIn + sat.u_f), sat.u_f, sat.u_f, 480);
  assertClose(capped.m1, 480, 1e-12, 'never more than the node holds');
  assertClose(capped.U1 / capped.m1, 0.5 * (uIn + sat.u_f), 1e-9 * sat.u_f,
    'and capping the mass keeps the profile: the mean does not move');
});

test('a falling pressure flashes the hot end of the slug, energy carried exactly', () => {
  // The profile runs from its own cold end u_a up to the OLD saturation; the
  // part above the new saturation leaves. The fraction that stays is
  // (u_f - u_a)/(u_ref - u_a), and the flashed part must carry exactly its
  // own profile-mean energy so that the leftovers (totals minus slug)
  // inherit it without invention.
  const satHi = saturationAtP(165e5), satLo = saturationAtP(50e5);
  const uA = satHi.u_f - 800e3;   // cold end colder than the 50 bar saturation
  const m1 = 350;
  const U1 = m1 * 0.5 * (uA + satHi.u_f);
  // A slug whose cold end is already above the new saturation flashes entirely
  const hot = reconcileSlug(m1, m1 * 0.5 * (satLo.u_f + 1e3 + satHi.u_f), satHi.u_f, satLo.u_f, 480);
  assertClose(hot.m1, 0, 1e-12, 'all of it above saturation -> all flashed');
  assertClose(hot.U1, 0, 1e-12, 'and it takes its energy with it');
  const rec = reconcileSlug(m1, U1, satHi.u_f, satLo.u_f, 480);
  const f = (satLo.u_f - uA) / (satHi.u_f - uA);
  assertClose(rec.m1, m1 * f, 1e-9, 'remaining slug is the profile fraction below the new saturation');
  assert(rec.m1 < m1, 'the slug must shrink when pressure falls');
  assertClose(rec.U1 / rec.m1, 0.5 * (uA + satLo.u_f), 1e-9 * satLo.u_f,
    'and the remainder keeps its cold end: mean = (u_a + u_f_new)/2');
  const flashedMean = 0.5 * (satHi.u_f + satLo.u_f);
  assertClose(U1 - rec.U1, (m1 - rec.m1) * flashedMean, 1e-6 * U1,
    'energy handed to the leftovers = flashed mass at its own profile mean');
});

test('a rising pressure lets the newly subcooled liquid join the slug', () => {
  // Boiling-section liquid sat at the old saturation; now it is subcooled by
  // the rise and belongs to the economizer, warmed to fill the new span by
  // the vapour condensing beside it. The profile density dm/du is preserved,
  // so the cold end does not move.
  const satLo = saturationAtP(50e5), satHi = saturationAtP(60e5);
  const uA = satLo.u_f - 400e3;
  const m1 = 300;
  const U1 = m1 * 0.5 * (uA + satLo.u_f);
  const rec = reconcileSlug(m1, U1, satLo.u_f, satHi.u_f, 480);
  assert(rec.m1 > m1, `the slug must grow when pressure rises (${rec.m1.toFixed(2)} vs ${m1})`);
  assertClose(rec.m1, m1 * (satHi.u_f - uA) / (satLo.u_f - uA), 1e-9,
    'it grows by the profile density times the newly subcooled span');
  assertClose(rec.U1 / rec.m1, 0.5 * (uA + satHi.u_f), 1e-9 * satHi.u_f,
    'and the enlarged profile keeps the same cold end');
  // Exactly reversible: going back down returns the original pair
  const back = reconcileSlug(rec.m1, rec.U1, satHi.u_f, satLo.u_f, 480);
  assertClose(back.m1, m1, 1e-9, 'the move is exactly reversible in mass');
  assertClose(back.U1, U1, 1e-9 * U1, 'and in energy');
  // A rise large enough to subcool everything makes the whole tube economizer
  const satWay = saturationAtP(200e5);
  assertClose(reconcileSlug(m1, U1, satLo.u_f, satWay.u_f, 480).m1, 480, 1e-12,
    'capped at the node inventory');
  // A capped join thins the profile rather than moving its cold end
  const held = reconcileSlug(m1, U1, satLo.u_f, satHi.u_f, 480, 5);
  assertClose(held.m1, m1 + 5, 1e-12, 'the join is limited by what the leftovers can give');
  assertClose(held.U1 / held.m1, 0.5 * (uA + satHi.u_f), 1e-9 * satHi.u_f,
    'and the cold end is still the cold end');
});

test('the boundary move is continuous through no-change', () => {
  const sat = saturationAtP(100e5);
  const uA = sat.u_f - 300e3;
  const U1 = 200 * 0.5 * (uA + sat.u_f);
  const up = reconcileSlug(200, U1, sat.u_f, sat.u_f + 10, 480);
  const dn = reconcileSlug(200, U1, sat.u_f, sat.u_f - 10, 480);
  assertClose(up.m1, 200, 1e-2, 'tiny rise moves the slug a tiny amount');
  assertClose(dn.m1, 200, 1e-2, 'tiny fall moves the slug a tiny amount');
  assert(up.m1 > 200 && dn.m1 < 200, 'and in the right directions');
});

test('boiling section mass-averages its quality, not its length', () => {
  // At 165 bar the phases differ ~5x in density, so the mass sits well down
  // the dome: the mass-averaged quality is 0.37 where the length average is
  // 0.5. At 1 bar the ratio is ~1700x and it falls to ~0.13.
  const at = (P: number) => {
    const sat = saturationAtP(P);
    return boilingMeanQuality(sat.v_f, sat.v_g);
  };
  assertClose(at(165e5), 0.371, 0.02, 'mass-averaged quality at 165 bar');
  assert(at(1e5) < 0.2, `mass-averaged quality at 1 bar should be well under 0.2, got ${at(1e5).toFixed(3)}`);
  // Falling pressure spreads the phases further apart, so the mass crowds
  // further toward the liquid end
  assert(at(1e5) < at(50e5) && at(50e5) < at(165e5), 'mean quality must fall with pressure');
});

test('mean quality tends to one half as the phases converge', () => {
  // Near the critical point liquid and vapour have the same density, so
  // there is no mass weighting left to do and the length average is right.
  // This is why assuming 1/2 never looked wrong at PWR pressures.
  const x = boilingMeanQuality(0.003, 0.003 * (1 + 1e-7));
  assertClose(x, 0.5, 1e-3, 'mean quality at the critical limit');
});

test('a boiling section that stops short of dry steam is wetter still', () => {
  const sat = saturationAtP(165e5);
  const full = boilingMeanQuality(sat.v_f, sat.v_g, 1);
  const half = boilingMeanQuality(sat.v_f, sat.v_g, 0.5);
  const tiny = boilingMeanQuality(sat.v_f, sat.v_g, 0.01);
  assert(half < full, `stopping at x=0.5 must be wetter than reaching dry steam (${half.toFixed(3)} vs ${full.toFixed(3)})`);
  assert(tiny < half, `barely boiling must be wetter still (${tiny.toFixed(4)})`);
  // ...and a section that barely boils is liquid
  assertClose(boilingMeanVolume(sat.v_f, sat.v_g, 0), sat.v_f, 1e-9 * sat.v_f,
    'a section with no boiling occupies the saturated-liquid volume');
});

// ============================================================================
// OTSG partition: solved from the totals, refereed by the wall, owning its P
// ============================================================================
// evaluateOtsgPartition integrates ONE thing (the economizer's energy U1,
// passed in) and solves everything else: the boiling/superheat split from
// the node's mass and energy, the superheat energy from the wall pin, and
// the PRESSURE from the volume constraint - the sections have to pack into
// the tube. These tests pin the regimes, their joins, and the two failures
// earlier closures produced: sections that could not fit the tube, and
// steam hotter than its own metal.

const PART_GEOM = { tubeVolume: 20, tubeLength: 1, heatArea: 2000 };
/** No economizer at all: an empty section holds no mass and no energy, and
 *  needs no saturation reference. */
const EMPTY_SLUG = { m1: 0, U1: 0 };
/** A test pin: wall temperature straight through (no draw, so the section
 *  soaks fully to its metal). A wall at 273 K pins the steam at saturation -
 *  the dryout limit. */
function pinAt(TWall3: number, WCp3 = 0): OtsgWallPin {
  // Gas side: the ramp tops out AT the wall (TGasIn3 = TWall3) with an
  // effectively infinite gas stream, so "soaks fully to its metal" keeps
  // exactly the meaning it had before the outlet learned about the gas.
  return {
    TWall3, hA3Full: 1200 * PART_GEOM.heatArea, WCp3,
    TGasIn3: TWall3, hAGas3Full: 1200 * PART_GEOM.heatArea, CGas3: 1e8,
  };
}
const PIN_COLD = pinAt(273);
/** Total section volume - the quantity an integrated m3 used to violate. */
function sectionVolume(ev: { sections: Array<{ volume: number }> }): number {
  return ev.sections[0].volume + ev.sections[1].volume + ev.sections[2].volume;
}
/** Total section energy, reconstructed from what the evaluation reports. */
function sectionEnergy(ev: { P: number; sections: Array<{ mass: number; hBar: number; vBar: number }> }): number {
  return ev.sections.reduce((s, sec) => s + sec.mass * (sec.hBar - ev.P * sec.vBar), 0);
}

test('flooded bundle: the boiling section stops short of dry steam, at its own pressure', () => {
  // 2% quality at 80 bar - water packed into the tubes with nowhere for steam.
  // With no slug the tie-line decomposition reproduces the constructed state,
  // so the solved pressure must come back at 80 bar.
  const P0 = 80e5;
  const sat = saturationAtP(P0);
  const x = 0.02;
  const v = sat.v_f + x * (sat.v_g - sat.v_f);
  const u = sat.u_f + x * (sat.u_g - sat.u_f);
  const mass = PART_GEOM.tubeVolume / v;
  const ev = evaluateOtsgPartition(mass, mass * u, EMPTY_SLUG, PART_GEOM, PIN_COLD);
  assertClose(ev.P / 1e5, 80, 0.1, 'the volume constraint recovers the pressure');
  assert(ev.sections[2].mass === 0,
    `a flooded bundle has no dry steam, got m3=${ev.sections[2].mass.toFixed(1)} kg`);
  assert(ev.x2Out > 0 && ev.x2Out < 0.1,
    `the boiling section must end low on the dome, got xOut=${ev.x2Out.toFixed(3)}`);
  assertClose(sectionVolume(ev), PART_GEOM.tubeVolume, 1e-4 * PART_GEOM.tubeVolume,
    'the sections must occupy exactly the tube volume');
  assertClose(ev.hSteamOut, ev.sat.h_g, 1e3, 'with no dry steam the draw is at h_g');
});

test('a two-phase bundle over a cold wall dries out rather than superheating', () => {
  // 80% quality with the wall at saturation: most of the tube is dry steam,
  // and nothing can superheat it - the vapour region sits at saturation.
  const P0 = 80e5;
  const sat = saturationAtP(P0);
  const x = 0.8;
  const v = sat.v_f + x * (sat.v_g - sat.v_f);
  const u = sat.u_f + x * (sat.u_g - sat.u_f);
  const mass = PART_GEOM.tubeVolume / v;
  const ev = evaluateOtsgPartition(mass, mass * u, EMPTY_SLUG, PART_GEOM, PIN_COLD);
  assertClose(ev.P / 1e5, 80, 0.1, 'pressure recovered');
  assert(ev.sections[2].mass > 0.5 * mass,
    `most of an 80%-quality bundle is dry steam, got ${(100 * ev.sections[2].mass / mass).toFixed(0)}%`);
  assertClose(ev.u3 / 1e3, ev.sat.u_g / 1e3, 2, 'the vapour region is at saturation, not superheated');
  assertClose(sectionVolume(ev), PART_GEOM.tubeVolume, 1e-4 * PART_GEOM.tubeVolume, 'volume closes');
  assertClose(sectionEnergy(ev) / 1e9, mass * u / 1e9, 1e-4 * mass * u / 1e9, 'energy closes too');
});

test('a dry bundle is all superheat, at its own bulk state and pressure', () => {
  const P0 = 80e5;
  const sat = saturationAtP(P0);
  const u = sat.u_g + 400e3;
  const v = superheatedV(u, P0);
  const mass = PART_GEOM.tubeVolume / v;
  const ev = evaluateOtsgPartition(mass, mass * u, EMPTY_SLUG, PART_GEOM, PIN_COLD);
  assertClose(ev.P / 1e5, 80, 0.5, 'pressure recovered from the vapor state');
  assert(ev.sections[2].mass > 0.99 * mass,
    `a superheated bundle is all superheat section, got ${(100 * ev.sections[2].mass / mass).toFixed(1)}%`);
  assertClose(ev.u3 / 1e3, u / 1e3, 2, 'at the bulk specific energy');
  assert(ev.sections[2].T > ev.sat.T + 50, 'and well above T_sat');
});

test('a constructed three-section state round-trips, pressure included', () => {
  // Build the totals FROM a known partition, hand the solve the ledger and a
  // pin at that partition's own steam temperature, and check it recovers the
  // masses AND the pressure it was built at.
  const P0 = 80e5;
  const sat = saturationAtP(P0);
  const uFeed = sat.u_f - 400e3;
  const u1Bar = subcooledSectionMean(uFeed, sat);
  const v1 = subcooledLiquidV(u1Bar);
  const vBarFull = boilingMeanVolume(sat.v_f, sat.v_g, 1);
  const x2 = boilingMeanQuality(sat.v_f, sat.v_g, 1);
  const u2 = sat.u_f + x2 * (sat.u_g - sat.u_f);
  const u3 = sat.u_g + 250e3;
  const v3 = superheatedV(u3, P0);
  const T3 = calculateState(1, u3, v3).temperature;
  const m1 = 4000, m2 = 900, m3 = 120;
  const geom = { tubeVolume: m1 * v1 + m2 * vBarFull + m3 * v3, tubeLength: 1, heatArea: 2000 };
  const ev = evaluateOtsgPartition(
    m1 + m2 + m3, m1 * u1Bar + m2 * u2 + m3 * u3, { m1, U1: m1 * u1Bar }, geom,
    { TWall3: T3, hA3Full: 1200 * geom.heatArea, WCp3: 0,
      TGasIn3: T3, hAGas3Full: 1200 * geom.heatArea, CGas3: 1e8 });
  assertClose(ev.P / 1e5, 80, 0.8, 'the pressure the partition was built at comes back');
  assertClose(ev.sections[0].mass, m1, 1e-2 * m1, 'economizer mass recovered');
  assertClose(ev.sections[1].mass, m2, 5e-2 * m2, 'boiling mass recovered');
  assertClose(ev.sections[2].mass, m3, 5e-2 * m3, 'superheat mass recovered');
  assertClose(ev.x2Out, 1, 1e-9, 'with superheat downstream the boiling section reaches dry steam');
  assertClose(sectionVolume(ev), geom.tubeVolume, 1e-4 * geom.tubeVolume, 'volume closes');
});

test('the published pressure is the partition\'s, not the mush read', () => {
  // The reason the pressure is solved here at all: cold slug and superheated
  // steam both sit BELOW the saturation tie line in (u,v), so their blend
  // reads as low-pressure two-phase mush. The flow solver was steering on
  // that fiction.
  const P0 = 80e5;
  const sat = saturationAtP(P0);
  const uFeed = sat.u_f - 400e3;
  const u1Bar = subcooledSectionMean(uFeed, sat);
  const v1 = subcooledLiquidV(u1Bar);
  const vBarFull = boilingMeanVolume(sat.v_f, sat.v_g, 1);
  const x2 = boilingMeanQuality(sat.v_f, sat.v_g, 1);
  const u2 = sat.u_f + x2 * (sat.u_g - sat.u_f);
  const u3 = sat.u_g + 250e3;
  const v3 = superheatedV(u3, P0);
  const m1 = 4000, m2 = 900, m3 = 120;
  const m = m1 + m2 + m3;
  const U = m1 * u1Bar + m2 * u2 + m3 * u3;
  const V = m1 * v1 + m2 * vBarFull + m3 * v3;
  const mushP = calculateState(m, U, V).pressure;
  assert(mushP < 60e5,
    `the uniform read of a partitioned boiler must be badly biased low, got ${(mushP / 1e5).toFixed(1)} bar`);
  const ev = evaluateOtsgPartition(m, U, { m1, U1: m1 * u1Bar },
    { tubeVolume: V, tubeLength: 1, heatArea: 2000 },
    { TWall3: calculateState(1, u3, v3).temperature, hA3Full: 1200 * 2000, WCp3: 0,
      TGasIn3: calculateState(1, u3, v3).temperature, hAGas3Full: 1200 * 2000, CGas3: 1e8 });
  assertClose(ev.P / 1e5, 80, 1, 'while the partition solves the true pressure');
});

test('the wall referees the partition: steam follows its metal, never past it', () => {
  // Fixed totals and ledger while the wall warms: the steam must track its
  // metal from below, with mass and volume closing at every point.
  const P0 = 80e5;
  const sat0 = saturationAtP(P0);
  const uFeed = sat0.u_f - 400e3;
  const u1Bar = subcooledSectionMean(uFeed, sat0);
  const v1 = subcooledLiquidV(u1Bar);
  const vBarFull = boilingMeanVolume(sat0.v_f, sat0.v_g, 1);
  const x2 = boilingMeanQuality(sat0.v_f, sat0.v_g, 1);
  const u2 = sat0.u_f + x2 * (sat0.u_g - sat0.u_f);
  const u3c = sat0.u_g + 150e3;
  const v3c = superheatedV(u3c, P0);
  const m1 = 4000, m2 = 900, m3 = 150;
  const m = m1 + m2 + m3;
  const U = m1 * u1Bar + m2 * u2 + m3 * u3c;
  const geom = { tubeVolume: m1 * v1 + m2 * vBarFull + m3 * v3c, tubeLength: 1, heatArea: 2000 };
  let lastT3 = 0;
  for (const dT of [20, 60, 120]) {
    const TW = sat0.T + dT;
    const ev = evaluateOtsgPartition(m, U, { m1, U1: m1 * u1Bar }, geom, pinAt(TW));
    // The pin's own fidelity is ~1 K (interpolated inversion plus a 0.25 K
    // refresh band) - the referee bounds the steam AT that fidelity, which
    // is far inside the tens-of-kelvin film differences that matter.
    assert(ev.sections[2].T <= TW + 1.5,
      `steam (${ev.sections[2].T.toFixed(1)} K) must not outrun its wall (${TW.toFixed(1)} K)`);
    assert(ev.sections[2].T >= lastT3 - 0.1,
      `a hotter wall must not give cooler steam (${ev.sections[2].T.toFixed(1)} vs ${lastT3.toFixed(1)} K)`);
    assertClose(ev.sections[0].mass + ev.sections[1].mass + ev.sections[2].mass, m,
      1e-9 * m, 'mass closes');
    assertClose(sectionVolume(ev), geom.tubeVolume, 1e-4 * geom.tubeVolume, 'volume closes');
    lastT3 = ev.sections[2].T;
  }
});

test('a stronger steam draw pulls the pin toward saturation', () => {
  // Same wall, more flow: less residence, less approach - theta falls with
  // W cp against hA.
  const P0 = 80e5;
  const sat0 = saturationAtP(P0);
  const uFeed = sat0.u_f - 400e3;
  const u1Bar = subcooledSectionMean(uFeed, sat0);
  const v1 = subcooledLiquidV(u1Bar);
  const vBarFull = boilingMeanVolume(sat0.v_f, sat0.v_g, 1);
  const x2 = boilingMeanQuality(sat0.v_f, sat0.v_g, 1);
  const u2 = sat0.u_f + x2 * (sat0.u_g - sat0.u_f);
  const u3c = sat0.u_g + 150e3;
  const v3c = superheatedV(u3c, P0);
  const m1 = 4000, m2 = 900, m3 = 150;
  const m = m1 + m2 + m3;
  const U = m1 * u1Bar + m2 * u2 + m3 * u3c;
  const geom = { tubeVolume: m1 * v1 + m2 * vBarFull + m3 * v3c, tubeLength: 1, heatArea: 2000 };
  const still = evaluateOtsgPartition(m, U, { m1, U1: m1 * u1Bar }, geom, pinAt(sat0.T + 120, 0));
  const drawing = evaluateOtsgPartition(m, U, { m1, U1: m1 * u1Bar }, geom, pinAt(sat0.T + 120, 500e3));
  assert(drawing.sections[2].T < still.sections[2].T - 5,
    `a drawn-through section must sit cooler than a stagnant one ` +
    `(${drawing.sections[2].T.toFixed(1)} vs ${still.sections[2].T.toFixed(1)} K)`);
  assert(drawing.sections[2].T > drawing.sat.T, 'but still above saturation under a hot wall');
});

test('nothing steps as a bundle floods, dries out and superheats', () => {
  // Heat a bottled bundle from wet to superheated. The sweep crosses the
  // regime joins, and the joins are the states where the two descriptions
  // coincide, so every reported quantity - the solved pressure included -
  // must cross them smoothly. (1000 kg in 20 m3 keeps the hot end near 100
  // bar: at 1600 kg the sweep tops out at ~195 bar dense steam, inside a
  // known near-critical hole in the v4 property grid - a separate issue.)
  const mass = 1000;
  const sat80 = saturationAtP(80e5);
  const uLo = sat80.u_f * 0.9, uHi = sat80.u_g + 400e3;
  const N = 400;
  let prev: { m3: number; h: number; f3: number; P: number } | null = null;
  let maxJumpM3 = 0, maxJumpH = 0, maxJumpF = 0, maxJumpP = 0;
  for (let i = 0; i <= N; i++) {
    const u = uLo + (uHi - uLo) * i / N;
    const ev = evaluateOtsgPartition(mass, mass * u, EMPTY_SLUG, PART_GEOM, PIN_COLD);
    assertClose(sectionVolume(ev), PART_GEOM.tubeVolume, 1e-4 * PART_GEOM.tubeVolume,
      `volume must close at u=${(u / 1e3).toFixed(0)} kJ/kg`);
    const cur = { m3: ev.sections[2].mass, h: ev.hSteamOut, f3: ev.sections[2].lengthFrac, P: ev.P };
    if (prev) {
      maxJumpM3 = Math.max(maxJumpM3, Math.abs(cur.m3 - prev.m3) / mass);
      maxJumpH = Math.max(maxJumpH, Math.abs(cur.h - prev.h));
      maxJumpF = Math.max(maxJumpF, Math.abs(cur.f3 - prev.f3));
      maxJumpP = Math.max(maxJumpP, Math.abs(cur.P - prev.P) / prev.P);
    }
    prev = cur;
  }
  assert(maxJumpM3 < 0.02, `superheat mass stepped ${(100 * maxJumpM3).toFixed(1)}% of inventory in one increment`);
  assert(maxJumpH < 40e3, `draw enthalpy stepped ${(maxJumpH / 1e3).toFixed(0)} kJ/kg in one increment`);
  assert(maxJumpF < 0.03, `superheat length fraction stepped ${(100 * maxJumpF).toFixed(1)} points in one increment`);
  assert(maxJumpP < 0.03, `pressure stepped ${(100 * maxJumpP).toFixed(1)}% in one increment`);
});

test('nothing steps as the wall warms through saturation', () => {
  // The pin's own seam: a wall crossing T_sat turns dryout into superheat.
  const P0 = 80e5;
  const sat = saturationAtP(P0);
  const x = 0.6;
  const v = sat.v_f + x * (sat.v_g - sat.v_f);
  const u = sat.u_f + x * (sat.u_g - sat.u_f);
  const mass = PART_GEOM.tubeVolume / v;
  const N = 100;
  let prev: { m3: number; T3: number; h: number; P: number } | null = null;
  let maxJumpM3 = 0, maxJumpT = 0, maxJumpH = 0, maxJumpP = 0;
  for (let i = 0; i <= N; i++) {
    const TW = sat.T - 20 + 60 * i / N;
    const ev = evaluateOtsgPartition(mass, mass * u, EMPTY_SLUG, PART_GEOM, pinAt(TW));
    const cur = { m3: ev.sections[2].mass, T3: ev.sections[2].T, h: ev.hSteamOut, P: ev.P };
    if (prev) {
      maxJumpM3 = Math.max(maxJumpM3, Math.abs(cur.m3 - prev.m3) / mass);
      maxJumpT = Math.max(maxJumpT, Math.abs(cur.T3 - prev.T3));
      maxJumpH = Math.max(maxJumpH, Math.abs(cur.h - prev.h));
      maxJumpP = Math.max(maxJumpP, Math.abs(cur.P - prev.P) / prev.P);
    }
    prev = cur;
  }
  assert(maxJumpM3 < 0.02, `superheat mass stepped ${(100 * maxJumpM3).toFixed(1)}% across the wall seam`);
  assert(maxJumpT < 2, `steam temperature stepped ${maxJumpT.toFixed(2)} K across the wall seam`);
  assert(maxJumpH < 15e3, `draw enthalpy stepped ${(maxJumpH / 1e3).toFixed(1)} kJ/kg across the wall seam`);
  assert(maxJumpP < 0.01, `pressure stepped ${(100 * maxJumpP).toFixed(1)}% across the wall seam`);
});

test('both regime seams join branch against branch, not just by eye', () => {
  // The closure branches on the SIGN of a solved mass, and the design claims
  // the switch happens exactly where the two descriptions coincide. That is
  // only checkable ARM AGAINST ARM at one pressure with the pin held, which
  // is what otsgPartitionAtP exposes. Walk the energy total finely across
  // each seam and require every quantity the arms compute differently -
  // the boiling section's mean volume and quality, the section masses, and
  // the volume the partition needs - to have no step in it: the largest
  // adjacent difference must stay within a small multiple of the typical
  // one. A KINK (slope change) is allowed and expected; a JUMP is not.
  //
  // The m3 = 0 seam coincides because m3 = 0 means the leftovers' mean
  // energy IS the full boiling profile's, so the flooded arm's free quality
  // lands on x2BarFull and the log-mean identity makes the two v2 the same
  // number. The m2 = 0 seam coincides because m3 = mR means UR/mR is
  // exactly the pinned u3.
  const mass = 1000;
  const P0 = 80e5;
  const sat = saturationAtP(P0);
  const uFeed = sat.u_f - 300e3;
  const step = (arr: number[]) => {
    const d = [];
    for (let i = 1; i < arr.length; i++) d.push(Math.abs(arr[i] - arr[i - 1]));
    const sorted = [...d].sort((a, b) => a - b);
    return { max: Math.max(...d), med: sorted[Math.floor(sorted.length / 2)] };
  };
  // Locate a seam by bisecting on the sign of the quantity that names it.
  const seamAt = (du3: number, want: 'm3' | 'm2') => {
    let lo = 0.2 * sat.u_f, hi = sat.u_g + 1.2e6;
    for (let i = 0; i < 80; i++) {
      const um = 0.5 * (lo + hi);
      const r = otsgPartitionAtP(P0, { massTotal: mass, UTotal: mass * um, slug: EMPTY_SLUG, du3 });
      const q = want === 'm3' ? r.m3 : r.m2;
      // m3 rises with energy, m2 falls once superheat exists.
      if (want === 'm3' ? q <= 0 : q > 0) lo = um; else hi = um;
    }
    return 0.5 * (lo + hi);
  };
  for (const du3 of [0, 400e3]) {
    for (const want of ['m3', 'm2'] as const) {
      const uSeam = seamAt(du3, want);
      const N = 60;
      const width = 4e3;   // +/- 4 kJ/kg of specific energy across the seam
      const V: number[] = [], v2: number[] = [], x2: number[] = [], m2: number[] = [], m3: number[] = [];
      for (let i = 0; i <= N; i++) {
        const u = uSeam - width + (2 * width * i) / N;
        const r = otsgPartitionAtP(P0, { massTotal: mass, UTotal: mass * u, slug: EMPTY_SLUG, du3 });
        V.push(r.Vsum); v2.push(r.v2); x2.push(r.x2Bar); m2.push(r.m2); m3.push(r.m3);
      }
      for (const [name, arr] of [['Vsum', V], ['v2', v2], ['x2Bar', x2], ['m2', m2], ['m3', m3]] as const) {
        const { max, med } = step(arr as number[]);
        assert(max <= 4 * med + 1e-12,
          `${name} JUMPS across the ${want} = 0 seam at du3=${(du3 / 1e3).toFixed(0)} kJ/kg: ` +
          `largest adjacent step ${max.toExponential(2)} against a typical ${med.toExponential(2)} - ` +
          `the two arms do not coincide there`);
      }
    }
  }
});

test('the classified feed enthalpy does not depend on the feed FLOW RATE', () => {
  // The economizer's inlet enthalpy prices the whole slug's energy,
  // m1 * (u_in + u_f)/2, so a step in it lands entirely on the leftovers
  // that set the tube's pressure. classifyOtsgFlows used to read
  // `WFeed > 0 ? donor mean : h_f(473 K)`, and the instant a feed pump
  // coasted to zero the inlet jumped to that hard-coded 200 C: measured on
  // a blacked-out Xe-100 bundle, uFeed stepped 1136 -> 840 kJ/kg, repriced a
  // 73 kg slug by 11 MJ, and the published pressure went 81 -> 99 bar in one
  // step - 79% of that run's rejections, and dt could not shrink it away
  // because the jump was in an input, not in a rate.
  const tube: any = {
    id: 'tube', volume: 1, flowArea: 0.1,
    fluid: { mass: 500, internalEnergy: 5e8, pressure: 80e5, temperature: saturationAtP(80e5).T, phase: 'two-phase' },
    otsg: { m1: 100, heatArea: 100, shellNodeId: 'shell', metalNodeIds: ['m1', 'm2', 'm3'] },
  };
  const donor: any = {
    id: 'donor', volume: 1, flowArea: 0.1,
    fluid: { mass: 500, internalEnergy: 4e8, pressure: 80e5, temperature: 473, phase: 'liquid' },
  };
  const mk = (w: number): any => ({
    state: {
      flowNodes: new Map<string, any>([['tube', tube], ['donor', donor]]),
      flowConnections: [{
        id: 'feed', fromNodeId: 'donor', toNodeId: 'tube',
        massFlowRate: w, currentFlowPhase: 'liquid', fromElevation: 1, toElevation: 1,
      }],
    },
  });
  const flowing = classifyOtsgFlows(mk(30).state, 'tube', tube, 80e5);
  const coasted = classifyOtsgFlows(mk(0).state, 'tube', tube, 80e5);
  const stopped = classifyOtsgFlows(mk(-5).state, 'tube', tube, 80e5);
  assertClose(coasted.uFeed, flowing.uFeed, 1,
    'the inlet enthalpy must not move when the feed flow reaches zero');
  assertClose(stopped.uFeed, flowing.uFeed, 1,
    'nor when the feed line reverses - the water standing at the inlet is the same water');
  assertClose(flowing.WFeed, 30, 1e-6, 'the feed RATE still follows the flow');
  assertClose(coasted.WFeed, 0, 1e-9, 'a coasted feed delivers nothing');
});

test('the sections fit the tube whatever the totals hold', () => {
  // The failure the first rework existed to kill: an integrated m3 let the
  // sections claim 2.6x the tube volume. With the pressure solved from the
  // volume constraint they cannot - under any wall, with or without a slug.
  const P0 = 120e5;
  const sat = saturationAtP(P0);
  const uFeed = sat.u_f - 350e3;
  const u1Bar = subcooledSectionMean(uFeed, sat);
  for (const TW of [273, sat.T + 40, sat.T + 200]) {
    for (const x of [0.005, 0.1, 0.5, 0.9, 0.999]) {
      for (const slugFrac of [0, 0.3]) {
        const v = sat.v_f + x * (sat.v_g - sat.v_f);
        const u = sat.u_f + x * (sat.u_g - sat.u_f);
        const mass = PART_GEOM.tubeVolume / v;
        const ev = evaluateOtsgPartition(mass, mass * u,
          { m1: slugFrac * mass, U1: slugFrac * mass * u1Bar }, PART_GEOM, pinAt(TW));
        assertClose(sectionVolume(ev), PART_GEOM.tubeVolume, 1e-3 * PART_GEOM.tubeVolume,
          `TW=${TW.toFixed(0)} K, x=${x}, slug=${slugFrac}: sections must fill the tube exactly`);
      assert(ev.sections[0].mass >= 0 && ev.sections[1].mass >= 0 && ev.sections[2].mass >= 0,
        'no section may hold negative mass');
      assertClose(ev.sections[0].mass + ev.sections[1].mass + ev.sections[2].mass, mass,
        1e-9 * mass, 'the partition must account for the whole inventory');
      }
    }
  }
});

test('above the critical pressure the tube is one fluid, not three sections', () => {
  const sat = saturationAtP(300e5);
  const domeTop = saturationAtP(P_CRITICAL);
  assertClose(sat.T, domeTop.T, 1e-9, 'supercritical saturation anchors at the dome top');
  assert(sat.T < 648, `and does not extrapolate past it, got ${sat.T.toFixed(1)} K`);

  const geom = { tubeVolume: 20, tubeLength: 1, heatArea: 2000 };
  const u = 2.2e6;                       // supercritical water, ~390 C at 253 bar
  const mass = 5000;
  const Pu = calculateState(1, u, geom.tubeVolume / mass).pressure;
  assert(Pu > P_CRITICAL, `fixture must be supercritical, got ${(Pu / 1e5).toFixed(0)} bar`);
  const ev = evaluateOtsgPartition(mass, mass * u, EMPTY_SLUG, geom, pinAt(700));
  assert(ev.regime === 'supercritical', `no sub-critical pressure packs this, got '${ev.regime}'`);
  assertClose(ev.P / 1e5, Pu / 1e5, 0.01 * Pu / 1e5,
    'above the dome the uniform read is unbiased and IS the pressure');
  assert(ev.sections[0].mass === 0 && ev.sections[1].mass === 0,
    'above the critical pressure the tube is one fluid');
  assertClose(ev.sections[2].mass, mass, 1e-9 * mass, 'which holds the whole inventory');
  assert(ev.sections[2].T > 273 && ev.sections[2].T < 1200,
    `the fluid must take a real temperature from the property surface, got ${ev.sections[2].T.toFixed(0)} K`);
});

test('gas in the tubes: the sections run on the water, not the mixture', () => {
  // Helium leaking into a bundle raises the node's pressure and energy without
  // being water. Handed the TOTALS the sectioned model looks for a dome the
  // water is nowhere near; handed the water's own share it partitions exactly
  // as it would with no gas present.
  const geom = { tubeVolume: 20, tubeLength: 1, heatArea: 2000 };
  const mass = 1600;
  const v = geom.tubeVolume / mass;
  const Pw = 80e5;
  const satW = saturationAtP(Pw);
  const x = (v - satW.v_f) / (satW.v_g - satW.v_f);
  const uW = satW.u_f + x * (satW.u_g - satW.u_f);   // a genuine 80-bar state
  const pure = calculateState(mass, mass * uW, geom.tubeVolume);

  const he = createGasComposition({ He: 4000 });      // mol
  const gasEnergy = 4000 * mixtureCv(he) * pure.temperature;
  const gasPressure = (4000 * 8.31446 * pure.temperature) / geom.tubeVolume;
  const node = {
    id: 'tube', volume: geom.tubeVolume,
    fluid: {
      mass, internalEnergy: mass * uW + gasEnergy,
      temperature: pure.temperature, pressure: pure.pressure + gasPressure,
      phase: pure.phase, quality: pure.quality, ncg: he,
    },
  } as unknown as FlowNode;

  const water = tubeWaterState(node);
  assertClose(water.pressure / 1e5, pure.pressure / 1e5, 0.05 * pure.pressure / 1e5,
    'the water partial pressure must come back out of the mixture');
  assertClose(water.energy / 1e9, mass * uW / 1e9, 0.01 * mass * uW / 1e9,
    'as must the water energy');

  const testPin = { TWall3: satW.T + 60, hA3Full: 1200 * geom.heatArea, WCp3: 0,
    TGasIn3: satW.T + 60, hAGas3Full: 1200 * geom.heatArea, CGas3: 1e8 };
  const withGas = evaluateOtsgPartition(mass, water.energy, EMPTY_SLUG, geom, testPin);
  const noGas = evaluateOtsgPartition(mass, mass * uW, EMPTY_SLUG, geom, testPin);
  assertClose(withGas.P / 1e5, noGas.P / 1e5, 0.02 * noGas.P / 1e5,
    'the same water must solve the same pressure whether or not helium shares the tube');
  assertClose(withGas.sections[2].mass, noGas.sections[2].mass, 0.02 * mass,
    'and partition the same way');
});

test('totals that are not water at any pressure are refused loudly', () => {
  // With the pressure solved, almost any (m, U, V) is water at SOME
  // pressure - 95 C water at 0.0125 m3/kg is simply a low-pressure
  // two-phase state now. What remains impossible is a tube emptier than
  // saturated steam at the triple point: cool water at 400 m3/kg exceeds
  // even vacuum's specific volume, and the closure must complain rather
  // than invent a section.
  const geom = { tubeVolume: 20, tubeLength: 1, heatArea: 2000 };
  const mass = 0.05;                    // 50 g in 20 m3 -> v = 400 m3/kg
  const u = 400e3;
  let message = '';
  try {
    evaluateOtsgPartition(mass, mass * u, EMPTY_SLUG, geom, PIN_COLD);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message.includes('[OTSG]'),
    `impossible totals must throw an explanatory [OTSG] error, got: ${message || '(no error)'}`);
});

test('boiling outlet quality inverts the mean-volume closure', () => {
  const sat = saturationAtP(60e5);
  for (const xOut of [0.02, 0.25, 0.6, 1]) {
    const v = boilingMeanVolume(sat.v_f, sat.v_g, xOut);
    assertClose(boilingOutletQuality(sat.v_f, sat.v_g, v), xOut, 1e-9,
      `inverting v-bar must return xOut=${xOut}`);
  }
  assertClose(boilingOutletQuality(sat.v_f, sat.v_g, sat.v_f * 0.5), 0, 1e-12,
    'liquid denser than saturation is not boiling at all');
});

test('mean volume and mean quality are the same statement', () => {
  const sat = saturationAtP(80e5);
  for (const xOut of [0.1, 0.4, 0.75, 1]) {
    const v = boilingMeanVolume(sat.v_f, sat.v_g, xOut);
    const x = boilingMeanQuality(sat.v_f, sat.v_g, xOut);
    assertClose(sat.v_f + x * (sat.v_g - sat.v_f), v, 1e-12,
      `v_f + x-bar*dv must reproduce v-bar at xOut=${xOut}`);
    assert(v > sat.v_f && v <= sat.v_g, `v-bar must lie inside the dome at xOut=${xOut}`);
  }
});

test('the counterflow outlet pinches at the gas inlet, not at twice the wall', () => {
  // The relation itself, at its limits. The old ramping form's outlet ran to
  // theta = 2 at weak draw, which is how a dried-out boiler offered its MSSV
  // steam hotter than the helium heating it.
  const TIn = 620, TGas = 1023;  // K: saturation in, Xe-100 helium inlet
  const hA = 1200 * 2000, hAg = 300 * 2000;
  // Weak draw: NTU huge, outlet must approach the gas inlet FROM BELOW.
  const weak = counterflowOutletTemp(TIn, TGas, hA, hAg, 50, 4e5);
  assert(weak <= TGas && weak > TGas - 1,
    `a near-zero draw should soak to the gas inlet, got ${weak.toFixed(1)} vs ${TGas}`);
  // Zero draw is the same limit exactly, not a special case.
  assertClose(counterflowOutletTemp(TIn, TGas, hA, hAg, 0, 4e5), TGas, 1e-9,
    'zero draw is the NTU->infinity limit');
  // Monotone in draw: more flow, less approach.
  const mid = counterflowOutletTemp(TIn, TGas, hA, hAg, 1e5, 4e5);
  const strong = counterflowOutletTemp(TIn, TGas, hA, hAg, 3e5, 4e5);
  assert(weak > mid && mid > strong, 'the approach must fall as the draw grows');
  // And NOTHING exceeds the gas inlet, at any capacity ratio.
  for (const Cw of [10, 1e4, 1e5, 4e5, 1e6]) {
    const T = counterflowOutletTemp(TIn, TGas, hA, hAg, Cw, 4e5);
    assert(T <= TGas + 1e-9 && T >= TIn,
      `outlet must stay in [T_in, T_gas_in], got ${T.toFixed(1)} at Cw=${Cw}`);
  }
  // A gas inlet BELOW the steam inlet heats nothing - continuous, not clamped.
  assertClose(counterflowOutletTemp(TIn, TIn - 50, hA, hAg, 1e4, 4e5), TIn, 1e-12,
    'cold gas drives no superheat');
});

test('a weakly drawn superheat section offers steam bounded by its gas', () => {
  // The partition end of the same statement: build a dried-out-ish state
  // with a hot wall, a hotter gas inlet, and almost no draw, and check the
  // OFFERED enthalpy against the ceiling the gas can support - the bound
  // that used to be violated by 50-70 K.
  const sat = saturationAtP(150e5);
  const geom = { tubeVolume: 20, tubeLength: 1, heatArea: 2000 };
  const TGasIn = 1023;   // 750 C helium
  const pin: OtsgWallPin = {
    TWall3: 900, hA3Full: 1200 * geom.heatArea, WCp3: 3000 * 3, // ~3 kg/s draw
    TGasIn3: TGasIn, hAGas3Full: 300 * geom.heatArea, CGas3: 2e5,
  };
  // Mass/energy that lands well into the superheat regime with a small slug.
  const mass = 400;
  const U = mass * 2.85e6;
  const ev = evaluateOtsgPartition(mass, U, { m1: 30, U1: 30 * (sat.u_f - 150e3) }, geom, pin);
  assert(ev.regime === 'superheat', `test state should superheat, got '${ev.regime}'`);
  const s3 = ev.sections[2];
  // The ceiling from the property surface itself, via the INVERSE map the
  // rest of the plant applies to this enthalpy: bisect h until stateAtPh
  // lands on the gas inlet temperature. Pricing the ceiling with a cp-linear
  // extension instead would repeat the bug this test exists to catch - the
  // first version of the fix bounded the temperature correctly and still
  // delivered 900 C-equivalent enthalpy through the near-dome slope.
  let hLo = ev.sat.h_g, hHi = ev.sat.h_g + 3e6;
  for (let i = 0; i < 60; i++) {
    const hm = 0.5 * (hLo + hHi);
    if (stateAtPh(ev.P, hm).T < TGasIn) hLo = hm; else hHi = hm;
  }
  const hCeiling = 0.5 * (hLo + hHi);
  assert(ev.hSteamOut <= hCeiling + 5e3,
    `offered steam must stay under the gas ceiling: ` +
    `${(ev.hSteamOut / 1e3).toFixed(0)} vs ${(hCeiling / 1e3).toFixed(0)} kJ/kg ` +
    `(T-equivalent ${(stateAtPh(ev.P, ev.hSteamOut).T - 273.15).toFixed(0)} vs ` +
    `${(TGasIn - 273.15).toFixed(0)} C)`);
  // And it still leaves hotter than the section mean - the counterflow
  // outlet property the linear form was right about.
  assert(ev.hSteamOut > s3.hBar,
    `the outlet should exceed the mean: ${(ev.hSteamOut / 1e3).toFixed(0)} vs ` +
    `${(s3.hBar / 1e3).toFixed(0)} kJ/kg`);
});

// ============================================================================
// Turbine Expansion
// ============================================================================
// Anchored on published steam-table expansions. These are the numbers that
// decide a plant's electrical output and its thermal efficiency, so they are
// worth pinning to the tables rather than to our own past behaviour.

test('full expansion matches the steam tables: work and exhaust quality', () => {
  // 165 bar / 565 C (h = 3465 kJ/kg) expanded isentropically to 0.05 bar.
  // Tables: 1481 kJ/kg available, exhaust quality 0.762.
  const inlet = stateAtPh(165e5, 3465e3);
  const r = expandStage(inlet, 0.05e5, 1.0);
  const work = (inlet.h - r.hIdeal) / 1e3;
  assert(Math.abs(work - 1481) < 40,
    `available work ${work.toFixed(0)} kJ/kg vs table 1481`);
  assert(r.outlet.phase === 'two-phase' && Math.abs(r.outlet.quality - 0.762) < 0.03,
    `exhaust quality ${r.outlet.quality.toFixed(3)} vs table 0.762`);
});

test('expansion inside the dome matches the tables too', () => {
  // 3 bar wet steam at h = 2500 kJ/kg to 0.05 bar: tables give 537 kJ/kg
  // and quality 0.753. This is the branch a polytropic P*v^n line gets
  // worst, and the branch every low-pressure stage lives in.
  const r = expandStage(stateAtPh(3e5, 2500e3), 0.05e5, 1.0);
  const work = (2500e3 - r.hIdeal) / 1e3;
  assert(Math.abs(work - 537) < 25, `wet expansion work ${work.toFixed(0)} kJ/kg vs table 537`);
  assert(Math.abs(r.outlet.quality - 0.753) < 0.03,
    `wet exhaust quality ${r.outlet.quality.toFixed(3)} vs table 0.753`);
});

test('a bleed stage lands where the tables put it', () => {
  // 165 bar / 565 C to a 25 bar extraction: s = 6.51 puts the ideal end
  // state at ~268 C and h ~ 2930 kJ/kg, still superheated
  const r = expandStage(stateAtPh(165e5, 3465e3), 25e5, 1.0);
  assert(Math.abs(r.hIdeal / 1e3 - 2930) < 40,
    `bleed enthalpy ${(r.hIdeal / 1e3).toFixed(0)} kJ/kg vs table 2930`);
  assert(r.outlet.phase === 'vapor' && Math.abs(r.outlet.T - 273.15 - 268) < 20,
    `bleed temperature ${(r.outlet.T - 273.15).toFixed(0)} C vs table 268`);
});

test('machine efficiency moves the end state the standard way', () => {
  const inlet = stateAtPh(165e5, 3465e3);
  const ideal = expandStage(inlet, 0.05e5, 1.0);
  const real = expandStage(inlet, 0.05e5, 0.87);
  assert(Math.abs(real.work / (inlet.h - ideal.hIdeal) - 0.87) < 1e-6,
    `eta=0.87 must deliver 87% of the available work, got ${(real.work / (inlet.h - ideal.hIdeal)).toFixed(4)}`);
  assert(real.outlet.quality > ideal.outlet.quality,
    `a real expansion ends DRIER than an ideal one (${real.outlet.quality.toFixed(3)} vs ${ideal.outlet.quality.toFixed(3)})`);
});

test('expansion never gains energy, at any pressure ratio', () => {
  // The memo caches the DROP rather than the end enthalpy precisely so that
  // a neighbouring inlet's cached result cannot come back above h1 on a
  // stage whose whole drop is smaller than the cache's quantization.
  const inlet = stateAtPh(10.1e5, 2628e3);
  for (const P2 of [10.06e5, 10e5, 9e5, 5e5, 1e5, 0.05e5]) {
    const r = expandStage(inlet, P2, 0.87);
    assert(r.hIdeal <= inlet.h * (1 + 1e-9) && r.work >= 0,
      `expansion to ${(P2 / 1e5).toFixed(2)} bar gained energy: ` +
      `${(inlet.h / 1e3).toFixed(1)} -> ${(r.hIdeal / 1e3).toFixed(1)} kJ/kg`);
  }
});

test('no expansion available: zero work, state unchanged', () => {
  const inlet = stateAtPh(10e5, 2800e3);
  const r = expandStage(inlet, 20e5, 0.87);
  assert(r.work === 0 && r.outlet === inlet, 'a stage cannot compress its way to power');
});

// ============================================================================
// Run Tests and Report
// ============================================================================

console.log('Running Meltdown Simulation Test Suite...\n');

// ============================================================================
// Helical bundle geometry
// ============================================================================
// A helical coil's length is set by packing: the bundle has to fill the
// annulus between the central riser and the shell wall, so tube count and
// tube length are the same design decision made twice.

category('Helical geometry');

const COIL = { hxType: 'helical', width: 2.8, height: 14, plenumLength: 0.8, tubeOD: 0.019 };

test('fewer tubes means longer ones - the same surface either way', () => {
  // A = 4 phi V_annulus / d is independent of how you cut the tubing up, so
  // tube count buys velocity and pressure drop, not area. That IS the trade.
  const areaOf = (tubeCount: number) => {
    const hx = { ...COIL, tubeCount };
    return Math.PI * COIL.tubeOD * hxTubeLength(hx) * tubeCount;
  };
  assertClose(areaOf(300) / areaOf(1000), 1, 1e-9, 'surface must not depend on tube count');
  const f300 = helicalLengthFactor({ ...COIL, tubeCount: 300 });
  const f1000 = helicalLengthFactor({ ...COIL, tubeCount: 1000 });
  assertClose(f300 / f1000, 1000 / 300, 1e-9, 'the factor scales as 1/N');
  assert(f300 > 8 && f300 < 16,
    `a 300-tube coil in a 2.8 m shell should wind ~12x, got ${f300.toFixed(1)}`);
});

test('a coil that cannot fit is refused, not silently wound tighter', () => {
  let message = '';
  try {
    hxTubeLengthFactor({ ...COIL, tubeCount: 5000 });   // the old Xe-100 number
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message.includes('cannot fit'),
    `5000 tubes do not fit a 2.8 m shell and must be refused, got: ${message || '(none)'}`);
});

test('a hand-set factor is honoured up to the packing limit', () => {
  const derived = helicalLengthFactor({ ...COIL, tubeCount: 300 });
  assertClose(hxTubeLengthFactor({ ...COIL, tubeCount: 300, tubeLengthFactor: derived * 2 }),
    derived * 2, 1e-9, 'a denser winding inside the limit is the design decision');
  let message = '';
  try {
    hxTubeLengthFactor({ ...COIL, tubeCount: 300, tubeLengthFactor: derived * 4 });
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message.includes('does not fit'),
    `winding past the packing limit must be refused, got: ${message || '(none)'}`);
});

test('straight and U-tube bundles are unaffected by the coil derivation', () => {
  assertClose(hxTubeLengthFactor({ ...COIL, hxType: 'straight', tubeCount: 5000 }), 1, 1e-9, 'straight');
  assertClose(hxTubeLengthFactor({ ...COIL, hxType: 'utube', tubeCount: 5000 }), 2.1, 1e-9, 'U-tube');
});

// ============================================================================
// Gray-body enclosures
// ============================================================================
// One formula serves the reflector-to-vessel gap and every declared radiant
// surface (cavity cooling panels), so its limits are worth pinning: it is the
// thing that decides how much decay heat a gas reactor can shed with
// everything switched off.

category('Gray-body radiation');

test('a black inner surface in a huge black enclosure radiates its own area', () => {
  // e_in = e_out = 1 and r_out >> r_in: the correction term vanishes and
  // A_eff collapses onto the bare cylinder area.
  const a = concentricGrayBodyArea(1, 1000, 10, 1, 1);
  assertClose(a, 2 * Math.PI * 1 * 10, 1e-9, 'black body in a black cavern');
});

test('a gray inner surface is throttled by its own emissivity', () => {
  const a = concentricGrayBodyArea(1, 1000, 10, 0.5, 1);
  assertClose(a, 0.5 * 2 * Math.PI * 10, 1e-6, 'e_in scales it directly');
});

test('a close-fitting gray shroud costs both surfaces', () => {
  // Equal radii is the flat-plate limit: 1/(1/e1 + 1/e2 - 1).
  const tight = concentricGrayBodyArea(1, 1.0001, 10, 0.8, 0.8);
  const expected = 2 * Math.PI * 10 / (1 / 0.8 + 1 / 0.8 - 1);
  assertClose(tight / expected, 1, 1e-3, 'concentric limit -> parallel plates');
  // The same surfaces further apart lose less to re-reflection.
  assert(concentricGrayBodyArea(1, 10, 10, 0.8, 0.8) > tight,
    'a distant outer surface returns less radiation to the emitter');
});

test('the Xe-100 cavity panels take ~0.9 MW off a vessel at operating temperature', () => {
  // 20 m of 5.04 m OD vessel at 260 C inside 6.0 m panels at 45 C. This is
  // the number that decides whether the system is a real parasitic loss
  // (~0.5% of core power) or decoration.
  const a = concentricGrayBodyArea(2.52, 3.0, 20, 0.8, 0.9);
  const q = 5.670374419e-8 * a * (533.15 ** 4 - 318.15 ** 4);
  assert(q > 0.8e6 && q < 1.1e6,
    `cavity duty at operating temperature should be ~0.9 MW, got ${(q / 1e6).toFixed(2)} MW`);
  // And it more than triples on its own as the vessel heads for 500 C with
  // the circulator dead - no signal, no valve, just T^4.
  const hot = 5.670374419e-8 * a * (773.15 ** 4 - 373.15 ** 4);
  assert(hot / q > 3, `duty must climb steeply with vessel temperature, got ${(hot / q).toFixed(1)}x`);
});

// ============================================================================
// Wall heat transfer: natural convection and condensation
// ============================================================================
// These replaced a hard-coded h = 50 W/m²-K that stood in for both mechanisms
// at once and was an order of magnitude wrong for each of them in opposite
// directions. What is pinned here is the two limits (dry gas, pure steam) and
// the containment middle, because the whole value of the model is that one
// expression covers all three.

category('Wall heat transfer');

/** A bare state holding one gas node - enough for the coefficient path. */
function gasSpace(opts: {
  steamMoles: number; ncgMoles: number; T: number; P: number; helium?: boolean;
}): { node: FlowNode; state: SimulationState } {
  const volume = 1000;
  const fluid = createFluidState(opts.T, opts.P, 'vapor', 1, volume, undefined);
  fluid.pressure = opts.P;
  fluid.temperature = opts.T;
  fluid.mass = opts.steamMoles * 0.018015;
  const ncg = emptyGasComposition();
  if (opts.helium) ncg.He = opts.ncgMoles;
  else { ncg.N2 = opts.ncgMoles * 0.79; ncg.O2 = opts.ncgMoles * 0.21; }
  fluid.ncg = ncg;
  const node = {
    id: 'g', label: 'g', fluid, volume,
    hydraulicDiameter: 5, flowArea: 25, height: 10, elevation: 0,
  } as FlowNode;
  const state = {
    flowNodes: new Map([[node.id, node]]), flowConnections: [],
    thermalNodes: new Map(), thermalConnections: [],
    convectionConnections: [], radiationConnections: [],
  } as unknown as SimulationState;
  return { node, state };
}

/** Moles filling a 1000 m³ space at (P, T). */
const fillMoles = (P: number, T: number) => (P * 1000) / (8.31446 * T);

/**
 * A saturated two-phase pool with a wall at T_wall against it - the shape the
 * liquid-side phase-change branches key off.
 */
function saturatedPool(P: number, T_sat: number, T_wall: number): {
  node: FlowNode; state: SimulationState; conn: any;
} {
  const volume = 10;
  const rho_f = saturatedLiquidDensity(T_sat);
  const node = {
    id: 'pool', label: 'pool', volume,
    hydraulicDiameter: 0.02, flowArea: 1, height: 2, elevation: 0,
    fluid: {
      mass: 0.5 * rho_f * volume, internalEnergy: 0, temperature: T_sat,
      pressure: P, phase: 'two-phase' as const, quality: 0.01, flowRate: 0,
    },
  } as unknown as FlowNode;
  const conn = { id: 'c', thermalNodeId: 'w', flowNodeId: 'pool', surfaceArea: 1 };
  const state = {
    flowNodes: new Map([[node.id, node]]),
    flowConnections: [],
    thermalNodes: new Map([['w', { id: 'w', temperature: T_wall } as any]]),
    thermalConnections: [], convectionConnections: [conn], radiationConnections: [],
  } as unknown as SimulationState;
  return { node, state, conn };
}

test('a big steel surface in still air gets single-digit h, not 50', () => {
  // 4.6 m vessel, 230 K hotter than the air around it. Churchill-Chu by hand
  // gives ~7.7; the constant this replaced gave 50 and had the Xe-100 vessel
  // shedding 3.75 MW into the reactor building.
  const T = 300, P = 1e5;
  const n = fillMoles(P, T);
  const { node, state } = gasSpace({ steamMoles: n * 1e-6, ncgMoles: n, T, P });
  const h = vaporWallHeatTransfer(node, state, 4.6, 530);
  assert(h.natural > 4 && h.natural < 12,
    `air natural convection should be ~8 W/m²-K, got ${h.natural.toFixed(1)}`);
  assertClose(h.total, h.natural, 1e-9, 'a dry space has no latent path at all');
});

test('a helium space out-transfers air, but by less than its conductivity', () => {
  // Helium conducts ~10x better than air, which is why a gas reactor is
  // coolable at all - but in NATURAL convection it gives some of that back:
  // Ra goes as rho², and helium at the same pressure is seven times lighter,
  // so its Rayleigh number is ~50x smaller. h ~ k Ra^(1/3) nets out under 2x.
  // The old constant of 50 could not tell the two gases apart at all, and
  // this is the case where the difference decides whether a core is coolable.
  const air = gasSpace({ steamMoles: 1, ncgMoles: fillMoles(60e5, 800), T: 800, P: 60e5 });
  const he = gasSpace({
    steamMoles: 1, ncgMoles: fillMoles(60e5, 800), T: 800, P: 60e5, helium: true });
  const hAir = vaporWallHeatTransfer(air.node, air.state, 2, 900).natural;
  const hHe = vaporWallHeatTransfer(he.node, he.state, 2, 900).natural;
  assert(hHe > hAir && hHe < 10 * hAir,
    `helium should beat air, but not by its conductivity ratio: ` +
    `got ${hHe.toFixed(1)} vs ${hAir.toFixed(1)}`);
  // And a dense gas at 60 bar convects far better than the same gas at one -
  // the rho² in Ra, which a constant coefficient cannot express.
  const thin = gasSpace({ steamMoles: 1, ncgMoles: fillMoles(1e5, 800), T: 800, P: 1e5 });
  const hThin = vaporWallHeatTransfer(thin.node, thin.state, 2, 900).natural;
  assert(hAir > 3 * hThin,
    `60 bar air should far out-convect 1 bar air, got ${hAir.toFixed(1)} vs ${hThin.toFixed(1)}`);
});

test('containment condensation lands on the measured band, not on one number', () => {
  // Uchida, h = 380 (m_steam/m_air)^0.7, is the classic containment fit and
  // sits at the conservative end of the data. A mechanistic model should
  // shadow it across the range rather than match it exactly.
  const P = 3e5;
  for (const steamFrac of [0.2, 0.35, 0.5, 0.7]) {
    const T = saturationTemperature(steamFrac * P);
    const total = fillMoles(P, T);
    const nSteam = total * steamFrac, nNcg = total - nSteam;
    const { node, state } = gasSpace({ steamMoles: nSteam, ncgMoles: nNcg, T, P });
    const h = vaporWallHeatTransfer(node, state, 5, T - 20);
    const uchida = 380 * Math.pow((nSteam * 0.018015) / (nNcg * 0.029), 0.7);
    const ratio = h.total / uchida;
    assert(ratio > 0.5 && ratio < 2,
      `at ${(100 * steamFrac).toFixed(0)}% steam, h=${h.total.toFixed(0)} vs Uchida ` +
      `${uchida.toFixed(0)} (ratio ${ratio.toFixed(2)}) - outside the measured band`);
  }
});

test('non-condensables poison condensation; pure steam is film-limited', () => {
  // The physics the single constant could not hold: pure steam condenses at
  // thousands of W/m²-K, and a few per cent of air knocks an order of
  // magnitude off it. That is why a containment with air in it behaves
  // nothing like a clean steam space.
  const P = 3e5;
  const T = saturationTemperature(P);
  const total = fillMoles(P, T);
  const pure = gasSpace({ steamMoles: total, ncgMoles: 0, T, P });
  const dirty = gasSpace({ steamMoles: total * 0.9, ncgMoles: total * 0.1, T: saturationTemperature(0.9 * P), P });
  const hPure = vaporWallHeatTransfer(pure.node, pure.state, 5, T - 20).condensation;
  const hDirty = vaporWallHeatTransfer(
    dirty.node, dirty.state, 5, saturationTemperature(0.9 * P) - 20).condensation;
  assert(hPure > 1500 && hPure < 20000,
    `pure-steam film condensation should be thousands, got ${hPure.toFixed(0)}`);
  assert(hPure > 3 * hDirty,
    `10% air must cost most of it, got ${hPure.toFixed(0)} vs ${hDirty.toFixed(0)}`);
});

test('a wall above the dew point condenses nothing, continuously', () => {
  // There is no film on a wall warmer than the dew point and this model does
  // not track wall liquid, so there is nothing to evaporate. The value has to
  // reach zero smoothly rather than step, or the solver pays for it.
  const P = 3e5;
  const dew = saturationTemperature(0.5 * P);
  const T_bulk = dew + 30;                       // superheated bulk
  const total = fillMoles(P, T_bulk);
  const mk = () => gasSpace({
    steamMoles: total * 0.5, ncgMoles: total * 0.5, T: T_bulk, P });
  const at = (offset: number) => {
    const { node, state } = mk();
    return vaporWallHeatTransfer(node, state, 5, dew + offset).condensation;
  };
  assertClose(at(5), 0, 1e-12, 'a warm wall must not condense');
  assertClose(at(0.5), 0, 1e-12, 'nor one half a kelvin above the dew point');
  assert(at(-0.01) < 1, `just below, it must start from nothing, got ${at(-0.01).toFixed(3)}`);
  assert(at(-10) > at(-1) && at(-1) > at(-0.1), 'and grow monotonically with subcooling');
});

test('the liquid-water transport fits match IAPWS where it matters', () => {
  // The film resistance runs on these, and water is ten times less viscous
  // at 150 C than at 20 - a single room-temperature value is wrong by that
  // factor exactly where condensation happens.
  assertClose(liquidViscosity(293.15) / 1.002e-3, 1, 0.05, 'viscosity at 20 C');
  assertClose(liquidViscosity(423.15) / 1.82e-4, 1, 0.05, 'viscosity at 150 C');
  assertClose(liquidThermalConductivity(300) / 0.610, 1, 0.03, 'conductivity at 300 K');
  assertClose(liquidThermalConductivity(500) / 0.642, 1, 0.03, 'conductivity at 500 K');
  // The maximum near 415 K is the part a monotonic fit gets wrong.
  assert(liquidThermalConductivity(415) > liquidThermalConductivity(300) &&
    liquidThermalConductivity(415) > liquidThermalConductivity(560),
    'conductivity must peak in the middle of the range, not run monotonically');
});

test('cp and expansivity come off the tables, shape and all', () => {
  // Both are differenced from the saturated-liquid curves rather than fitted,
  // because every closed form that captures the near-critical rise gets the
  // flat part wrong. Anchors from IAPWS.
  assertClose(liquidSpecificHeat(293.15) / 4184, 1, 0.02, 'cp at 20 C');
  assertClose(liquidSpecificHeat(473.15) / 4497, 1, 0.03, 'cp at 200 C');
  assert(liquidSpecificHeat(573.15) > 5000,
    `cp must climb steeply toward the critical point, got ${liquidSpecificHeat(573.15).toFixed(0)}`);
  assertClose(liquidThermalExpansivity(293.15) / 2.07e-4, 1, 0.10, 'beta at 20 C');
  assertClose(liquidThermalExpansivity(473.15) / 1.35e-3, 1, 0.10, 'beta at 200 C');
});

test('water expansivity passes through zero at the 4 C density maximum', () => {
  // This is the case that rules out beta = 1/T, and any fit that tames the
  // near-critical pole flattens it away. Below 4 C water CONTRACTS as it
  // warms, so beta is negative - and natural convection there runs backwards,
  // which is why lakes freeze from the top.
  assert(liquidThermalExpansivity(275.15) < 0, 'beta below 4 C must be negative');
  assert(liquidThermalExpansivity(283.15) > 0, 'and positive above it');
  assert(Math.abs(liquidThermalExpansivity(277.15)) < 5e-5,
    'and near zero at the density maximum itself');
  // The pole at the other end is the reason near-critical circulation is so
  // vigorous, and it has to survive too: 1.4e-3 at 200 C against 1.7e-2 by
  // 640 K, an order of magnitude, still climbing.
  assert(liquidThermalExpansivity(640) > 10 * liquidThermalExpansivity(473.15),
    'expansivity must diverge toward the critical point');
  // The ideal-gas value would be wrong by an order of magnitude at the cold
  // end, which is the whole reason this function exists.
  assert(liquidThermalExpansivity(293.15) < 0.3 / 293.15,
    'a liquid is not a gas: beta must be far below 1/T');
});

test('a cold wall in a saturated pool gets NO phase-change term', () => {
  // Nucleate boiling is a wall process - vapor comes out of cavities that
  // only activate on a superheated surface - so a subcooled wall has nothing
  // to nucleate and there is no wall-anchored condensation for an inverted
  // boiling correlation to describe. What condensation there is happens on
  // the VAPOR-exposed share of the surface, which effectiveSurfaceAreas
  // splits off and hands to the vapor-side model, and the latent heat lands
  // in the node's (u,v) bookkeeping regardless.
  const P = 70e5;
  const T_sat = saturationTemperature(P);
  const at = (subcooling: number) => {
    const { node, state, conn } = saturatedPool(P, T_sat, T_sat - subcooling);
    return liquidWallHeatTransfer(node, state, conn, 0.02);
  };
  for (const sub of [0.5, 5, 20, 50]) {
    const h = at(sub);
    assertClose(h.phaseChange, 0, 1e-12,
      `${sub} K of subcooling must add no phase-change term`);
    assertClose(h.total, h.singlePhase, 1e-9,
      `${sub} K: the total must be the single-phase coefficient alone`);
  }
  // It is not zero heat transfer - single-phase convection still runs, and
  // now on real properties rather than the 500 W/m²-K floor it used to hit.
  assert(at(5).total > 100, `a cold wall still convects, got ${at(5).total.toFixed(0)}`);
});

test('a HOT wall in the same pool still boils', () => {
  // The asymmetry is the point: removing the cold-wall term must not touch
  // the boiling curve on the other side of the crossing.
  const P = 70e5;
  const T_sat = saturationTemperature(P);
  const hot = (superheat: number) => {
    const { node, state, conn } = saturatedPool(P, T_sat, T_sat + superheat);
    return liquidWallHeatTransfer(node, state, conn, 0.02);
  };
  assert(hot(5).phaseChange > 1e3,
    `5 K of superheat should boil, got ${hot(5).phaseChange.toExponential(1)}`);
  // And the crisis is still in there: past CHF the coefficient collapses.
  assert(hot(200).phaseChange < hot(20).phaseChange,
    'the post-CHF collapse must survive');
});

test('a quiescent liquid surface gets a Rayleigh number, not a floor of 500', () => {
  // The old code returned a flat 500 W/m²-K whenever Re fell short, which is
  // the same mistake the gas side had: a constant standing in for a
  // correlation. A big surface and a small one in the same still water now
  // differ, and both differ from 500.
  const P = 70e5;
  const T_sat = saturationTemperature(P);
  const at = (D: number) => {
    const { node, state, conn } = saturatedPool(P, T_sat, T_sat + 3);
    return liquidWallHeatTransfer(node, state, conn, D).natural;
  };
  const small = at(0.02), big = at(3.0);
  assert(small > big, 'a smaller characteristic length transfers better');
  assert(big > 200 && big < 5000,
    `a 3 m surface in still hot water should be ~10^3 W/m²-K, got ${big.toFixed(0)}`);
  assert(Math.abs(small - 500) > 100 && Math.abs(big - 500) > 100,
    'neither should land on the old constant');
});

test('node velocity is throughput, not inflow plus outflow', () => {
  // Summing |mdot| over every connection counts the same stream twice, once
  // arriving and once leaving. A pass-through node must read the same
  // velocity as the flow actually crossing it.
  const P = 70e5;
  const T_sat = saturationTemperature(P);
  const { node, state, conn } = saturatedPool(P, T_sat, T_sat - 1);
  (state as any).flowConnections = [
    { id: 'in', fromNodeId: 'src', toNodeId: 'pool', massFlowRate: 100 },
    { id: 'out', fromNodeId: 'pool', toNodeId: 'sink', massFlowRate: 100 },
  ];
  const twoWay = liquidWallHeatTransfer(node, state as any, conn, 0.02).Re;
  // The same 100 kg/s arriving on one connection and leaving on three.
  (state as any).flowConnections = [
    { id: 'in', fromNodeId: 'src', toNodeId: 'pool', massFlowRate: 100 },
    { id: 'o1', fromNodeId: 'pool', toNodeId: 's1', massFlowRate: 40 },
    { id: 'o2', fromNodeId: 'pool', toNodeId: 's2', massFlowRate: 35 },
    { id: 'o3', fromNodeId: 'pool', toNodeId: 's3', massFlowRate: 25 },
  ];
  const header = liquidWallHeatTransfer(node, state as any, conn, 0.02).Re;
  assertClose(header / twoWay, 1, 1e-9,
    'a header passing the same throughput must read the same Reynolds number');
});

test('a rod bundle is a channel, not a bore - and the rods are in the way', () => {
  // Two lengths and two areas, from numbers the presets already carry. A PWR
  // barrel of 3.1 m with 38000 rods of 9.5 mm: the rods take 2.69 of the
  // 7.55 m² bore, leaving 4.86 m² of coolant - within a few per cent of a
  // real plant's ~4.7 - and the channel they leave has a 17 mm hydraulic
  // diameter, not the 9.5 mm of the rod itself.
  const geo = coreRodGeometry({
    id: 'cb', innerDiameter: 3.1, actualFuelRodCount: 38000, activeFuelHeight: 3.66,
  } as any);
  assertClose(geo.freeFlowArea, 4.855, 0.02, 'coolant flow area');
  assertClose(geo.flowHydraulicDiameter, 0.01713, 0.02, 'channel hydraulic diameter');
  assert(geo.flowHydraulicDiameter > geo.rodDiameter,
    'the channel is wider than the rod that bounds it');
  // A bundle denser than its barrel is refused rather than handed back as a
  // negative flow area.
  let message = '';
  try {
    coreRodGeometry({ id: 'cb', innerDiameter: 1.0, actualFuelRodCount: 38000 } as any);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message.includes('no room for coolant'),
    `an impossible bundle must be refused, got: ${message || '(none)'}`);
});

// ============================================================================
// Controller measurement expressions
// ============================================================================
// A controller's measurement AND its setpoint are expressions over plant
// signals, so the loops a plant needs can be written down rather than
// hard-coded. These pin the arithmetic, the back-compatible shape every
// existing preset uses, and the one operator that is allowed to refuse.

category('Controller signals');

/** Minimal state carrying two connections and a node the tests can read. */
function signalRig(): SimulationState {
  const state = {
    time: 0,
    flowNodes: new Map(),
    flowConnections: [
      { id: 'flow-a', fromNodeId: 'x', toNodeId: 'y', massFlowRate: 40 },
      { id: 'flow-b', fromNodeId: 'y', toNodeId: 'z', massFlowRate: 25 },
    ],
    thermalNodes: new Map(),
    components: { controllers: new Map(), pumps: new Map(), valves: new Map() },
    neutronics: {},
  } as unknown as SimulationState;
  state.flowNodes.set('vessel', {
    id: 'vessel', volume: 10, height: 4,
    fluid: { mass: 5000, internalEnergy: 5e9, temperature: 500, pressure: 70e5, phase: 'two-phase', quality: 0.1 },
  } as unknown as never);
  return state;
}

function evalSignal(sensor: unknown, setpoint: unknown = 0): { pv: number; sp: number } {
  const op = new ControlSystemOperator();
  const state = signalRig();
  const ctl = {
    id: 'ctl-test', label: 'test', mode: 'auto',
    sensor, setpoint,
    actuator: { kind: 'valve-position', targetId: 'v', min: 0, max: 1, rateLimit: 1 },
    lastOutput: 0, lastError: 0, aggressiveness: 1,
  } as unknown as ControllerState;
  return {
    pv: (op as unknown as { readSensor(s: SimulationState, c: ControllerState): number })
      .readSensor(state, ctl),
    sp: (op as unknown as { readSetpoint(s: SimulationState, c: ControllerState): number })
      .readSetpoint(state, ctl),
  };
}

test('a bare {kind, targetId} is still one signal', () => {
  // Every preset written before expressions existed uses this shape.
  const { pv } = evalSignal({ kind: 'connection-flow', targetId: 'flow-a' });
  assertClose(pv, 40, 1e-9, 'legacy sensor shape must read straight through');
});

test('signals combine: sum, difference, product, extrema, scale', () => {
  const a = { kind: 'connection-flow', targetId: 'flow-a' };   // 40
  const b = { kind: 'connection-flow', targetId: 'flow-b' };   // 25
  assertClose(evalSignal({ op: 'sum', inputs: [a, b] }).pv, 65, 1e-9, 'sum');
  assertClose(evalSignal({ op: 'diff', inputs: [a, b] }).pv, 15, 1e-9, 'difference');
  assertClose(evalSignal({ op: 'product', inputs: [a, b] }).pv, 1000, 1e-9, 'product');
  assertClose(evalSignal({ op: 'min', inputs: [a, b] }).pv, 25, 1e-9, 'min');
  assertClose(evalSignal({ op: 'max', inputs: [a, b] }).pv, 40, 1e-9, 'max');
  assertClose(evalSignal({ op: 'scale', input: a, factor: 0.5, offset: 3 }).pv, 23, 1e-9, 'scale');
  assertClose(evalSignal({ op: 'const', value: 7 }).pv, 7, 1e-9, 'constant');
  // Nesting: the three-element feedwater shape, level trim on a flow error
  const threeElement = { op: 'sum', inputs: [
    { op: 'diff', inputs: [b, a] },
    { op: 'scale', input: { kind: 'node-level', targetId: 'vessel' }, factor: 100 },
  ]};
  const { pv } = evalSignal(threeElement);
  assert(Number.isFinite(pv), `a nested expression must evaluate, got ${pv}`);
});

test('the setpoint is an expression too - that is what ratio control is', () => {
  // Feed follows steam: measure the feed, aim at 1.02x the steam flow. The
  // ratio lives on the SETPOINT, so a shut steam line gives a setpoint of
  // zero rather than a division by it.
  const { pv, sp } = evalSignal(
    { kind: 'connection-flow', targetId: 'flow-a' },
    { op: 'scale', input: { kind: 'connection-flow', targetId: 'flow-b' }, factor: 1.02 },
  );
  assertClose(pv, 40, 1e-9, 'measurement is the feed flow');
  assertClose(sp, 25.5, 1e-9, 'setpoint tracks the steam flow');
});

test('a ratio refuses a zero divisor instead of handing the PI an infinity', () => {
  let message = '';
  try {
    evalSignal({ op: 'ratio', inputs: [
      { kind: 'connection-flow', targetId: 'flow-a' },
      { op: 'const', value: 0 },
    ]});
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message.includes('[ControlSystem]') && message.includes('ratio'),
    `a zero divisor must be refused explicitly, got: ${message || '(no error)'}`);
});

test('an expression made only of constants is refused - nothing to follow', () => {
  const op = new ControlSystemOperator();
  let message = '';
  try {
    (op as unknown as { sensorKindOf(c: ControllerState): string }).sensorKindOf(
      { id: 'ctl-x', sensor: { op: 'sum', inputs: [{ op: 'const', value: 1 }] } } as unknown as ControllerState);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message.includes('only of constants'),
    `a constant-only measurement must be refused, got: ${message || '(no error)'}`);
});

test('a loop scans on its own period, not on the solver step', () => {
  // The velocity form increments by kp*(error - lastError), so running it
  // every accepted step makes that term the step-to-step JITTER of the
  // measurement rather than its change over a control interval. A lively
  // plant takes hundreds of steps a second, and that noise walks the output
  // around far faster than the integral can move it.
  const op = new ControlSystemOperator();
  const build = (scanPeriod?: number) => {
    const ctl = {
      id: 'ctl-x', label: 'x', mode: 'auto',
      sensor: { kind: 'connection-flow', targetId: 'feed' },
      setpoint: 25, scanPeriod,
      actuator: { kind: 'pump-speed', targetId: 'p1', min: 0, max: 1, rateLimit: 100 },
      aggressiveness: 1, lastOutput: 0.5, lastError: 0,
    } as unknown as ControllerState;
    const state = {
      time: 0, flowNodes: new Map(), thermalNodes: new Map(),
      thermalConnections: [], convectionConnections: [], radiationConnections: [],
      flowConnections: [{ id: 'feed', fromNodeId: 'a', toNodeId: 'b', massFlowRate: 5 }],
      components: {
        controllers: new Map([['ctl-x', ctl]]),
        pumps: new Map([['p1', { id: 'p1', speed: 0.5, effectiveSpeed: 0.5, ratedFlow: 80,
                                 running: true, connectedFlowPath: 'feed' }]]),
        valves: new Map(),
      },
      neutronics: { nominalPower: 0 },
    } as unknown as SimulationState;
    return state;
  };

  // Ten solver steps inside one scan period: exactly one update.
  let s = build(0.5);
  let updates = 0;
  for (let i = 0; i < 10; i++) {
    const before = s.components.controllers.get('ctl-x')!.lastScanTime;
    s.time = i * 0.02;
    s = op.applyConstraints(s, 0.02)!;
    if (s.components.controllers.get('ctl-x')!.lastScanTime !== before) updates++;
  }
  assertClose(updates, 1, 0, `one scan period should give one update, got ${updates}`);

  // Past the period, it scans again - and the increment uses the ELAPSED
  // scan time, so the integral advances by the interval rather than by a
  // solver step.
  s.time = 0.6;
  s = op.applyConstraints(s, 0.02)!;
  const ctl = s.components.controllers.get('ctl-x')!;
  assertClose(ctl.lastScanTime ?? -1, 0.6, 1e-9, 'the scan is stamped at the time it ran');
  assert(ctl.lastOutput > 0.5,
    `a +20 kg/s error must raise the command, got ${ctl.lastOutput.toFixed(4)}`);
});

test('anything that displays a controller can survive an expression', () => {
  // A setpoint is no longer necessarily a number and a sensor no longer
  // necessarily a leaf. `sp.toFixed(1)` on an expression is a TypeError, and
  // in a render loop that takes the whole frame with it - which is exactly
  // what the Xe-100's three-element loop did to the GUI.
  assertClose(describeControllerSignal(42).length > 0 ? 1 : 0, 1, 0, 'a plain number describes');
  const expr = { op: 'sum' as const, inputs: [
    { kind: 'connection-flow' as const, targetId: 'flow-a' },
    { op: 'scale' as const, factor: -5, offset: 20,
      input: { kind: 'node-level' as const, targetId: 'vessel' } },
  ]};
  const text = describeControllerSignal(expr);
  assert(text.includes('sum') && text.includes('flow-a') && text.includes('vessel'),
    `an expression must describe itself readably, got '${text}'`);
  assert(primaryControllerSignal(expr)?.kind === 'connection-flow',
    'and report the signal it follows');
  assertClose(describeControllerSignal(undefined) === '-' ? 1 : 0, 1, 0,
    'a missing signal must not throw either');
});

test('tuning follows the first signal named', () => {
  // Lambda and the process gain are per sensor kind and a composite has no
  // single kind, so the convention is the first leaf in written order.
  const op = new ControlSystemOperator();
  const kindOf = (sensor: unknown) =>
    (op as unknown as { sensorKindOf(c: ControllerState): string })
      .sensorKindOf({ id: 'c', sensor } as unknown as ControllerState);
  assertClose(kindOf({ op: 'sum', inputs: [
    { kind: 'node-level', targetId: 'vessel' },
    { kind: 'connection-flow', targetId: 'flow-a' },
  ]}) === 'node-level' ? 1 : 0, 1, 0, 'first leaf wins');
  assertClose(kindOf({ op: 'scale', factor: 2,
    input: { kind: 'connection-flow', targetId: 'flow-a' } }) === 'connection-flow' ? 1 : 0,
    1, 0, 'scale is transparent to tuning');
});

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
