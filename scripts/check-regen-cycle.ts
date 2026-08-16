/**
 * What regenerative feedwater heating is worth, at the Xe-100's conditions.
 *
 * This is a closed-form Rankine calculation on the SAME expansion model the
 * plant runs (src/simulation/turbine-expansion.ts), so the numbers are
 * comparable with what the simulator reports - it is the cycle the plant
 * would settle into with a working feedwater train, without having to hold
 * that train stable through a transient first.
 *
 * For each bleed, the heater's energy balance sets the fraction of steam
 * drawn: the bleed condenses from its extraction state to saturated liquid
 * at its own pressure, and that heat raises the feedwater from the previous
 * heater's outlet to this heater's saturation temperature less a terminal
 * difference.
 *
 * Run: npx tsx scripts/check-regen-cycle.ts
 */

import { stateAtPh, expandStage } from '../src/simulation/turbine-expansion';
import {
  saturatedVaporEnthalpy,
  saturatedLiquidEnthalpy,
  saturationTemperature,
} from '../src/simulation/water-properties';

const ETA_TURBINE = 0.87;   // the operator's isentropic efficiency
const TTD = 3;              // K - terminal temperature difference in a heater
const CP_WATER = 4200;      // J/kg-K

/** Feedwater enthalpy leaving a heater whose shell condenses at P_bleed. */
function feedEnthalpyAfterHeater(P_bleed: number): number {
  const tOut = saturationTemperature(P_bleed) - TTD;
  return CP_WATER * (tOut - 273.15);
}

/**
 * Cycle efficiency with the given bleed pressures (highest first).
 * Returns the work per kg of BOILER steam and the heat added in the boiler.
 */
function cycle(P_throttle: number, h_throttle: number, P_cond: number, bleeds: number[]) {
  const hCondensate = saturatedLiquidEnthalpy(P_cond);

  // March the expansion, recording each bleed's state
  const bleedStates: Array<{ P: number; h: number; workBefore: number }> = [];
  let state = stateAtPh(P_throttle, h_throttle);
  let work = 0;
  for (const P of bleeds) {
    const r = expandStage(state, P, ETA_TURBINE);
    work += r.work;
    state = r.outlet;
    bleedStates.push({ P, h: state.h, workBefore: work });
  }
  const last = expandStage(state, P_cond, ETA_TURBINE);
  const workToExhaust = work + last.work;

  // Heater balances, coldest first: each heater raises the feed from the
  // previous stage's outlet to its own saturation temperature less the
  // terminal difference, and the bleed fraction follows.
  const order = [...bleeds].sort((a, b) => a - b);
  let hFeed = hCondensate;
  let flowFraction = 1;              // of boiler flow still heading to the condenser
  let workLost = 0;                  // work the bleeds would have made downstream
  const draws: Array<{ P: number; y: number; tFeed: number }> = [];

  for (const P of order) {
    const bs = bleedStates.find(b => b.P === P)!;
    const hDrain = saturatedLiquidEnthalpy(P);
    const hFeedOut = feedEnthalpyAfterHeater(P);
    // y (per kg of boiler steam) condensing to warm the feed:
    //   y * (h_bleed - h_drain) = 1 * (h_feed_out - h_feed_in)
    // The feed side carries the FULL boiler flow, since every kilogram that
    // leaves the boiler comes back through the heaters.
    const y = (hFeedOut - hFeed) / (bs.h - hDrain);
    draws.push({ P, y, tFeed: hFeedOut / CP_WATER + 273.15 });
    // That kilogram stops making work at this bleed point
    workLost += y * (workToExhaust - bs.workBefore);
    flowFraction -= y;
    hFeed = hFeedOut;
  }

  const workNet = workToExhaust - workLost;
  const qBoiler = h_throttle - hFeed;
  return {
    efficiency: workNet / qBoiler,
    workNet, qBoiler, hFeed, draws, flowFraction,
    workNoRegen: workToExhaust,
  };
}

// The plant's measured operating point: saturated steam off a flooded
// once-through boiler, 18 C feedwater, a deep condenser vacuum.
const P_THROTTLE = 157.6e5;
const H_THROTTLE = saturatedVaporEnthalpy(P_THROTTLE);
const P_COND = 0.029e5;

console.log(`\nXe-100 measured operating point: ${(P_THROTTLE / 1e5).toFixed(1)} bar saturated ` +
  `(h=${(H_THROTTLE / 1e3).toFixed(0)} kJ/kg), condenser ${(P_COND / 100).toFixed(0)} mbar\n`);

const cases: Array<[string, number[]]> = [
  ['no feedwater heating', []],
  ['one heater  (3 bar bleed)', [3e5]],
  ['two heaters (25 / 3 bar)', [25e5, 3e5]],
  ['three heaters (40/12/3 bar)', [40e5, 12e5, 3e5]],
];

for (const [label, bleeds] of cases) {
  const r = cycle(P_THROTTLE, H_THROTTLE, P_COND, bleeds);
  const feedC = r.hFeed / CP_WATER;
  console.log(
    `${label.padEnd(30)} feed ${feedC.toFixed(0).padStart(3)} C  ` +
    `bleed ${(100 * (1 - r.flowFraction)).toFixed(1).padStart(4)}%  ` +
    `w=${(r.workNet / 1e3).toFixed(0).padStart(4)} kJ/kg  ` +
    `q=${(r.qBoiler / 1e3).toFixed(0).padStart(4)} kJ/kg  ` +
    `eta=${(100 * r.efficiency).toFixed(2)} %`
  );
}

// And at the design point the SG was sized for, to show what the cycle is
// capable of once the boiler makes superheated steam
console.log(`\nAt the SG's DESIGN steam conditions (165 bar, 565 C):\n`);
const H_DESIGN = 3465e3;
for (const [label, bleeds] of cases) {
  const r = cycle(165e5, H_DESIGN, P_COND, bleeds);
  const feedC = r.hFeed / CP_WATER;
  console.log(
    `${label.padEnd(30)} feed ${feedC.toFixed(0).padStart(3)} C  ` +
    `bleed ${(100 * (1 - r.flowFraction)).toFixed(1).padStart(4)}%  ` +
    `w=${(r.workNet / 1e3).toFixed(0).padStart(4)} kJ/kg  ` +
    `q=${(r.qBoiler / 1e3).toFixed(0).padStart(4)} kJ/kg  ` +
    `eta=${(100 * r.efficiency).toFixed(2)} %`
  );
}
console.log();
