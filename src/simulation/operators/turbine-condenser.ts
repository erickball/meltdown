/**
 * Turbine / condenser display state.
 *
 * The physics lives in TurbineCondenserRateOperator (rate-operators.ts), which
 * publishes its totals here each step for the UI, the game-mode ledger and the
 * test scripts to read.
 */

export interface TurbineCondenserState {
  turbinePower: number;           // W - total electrical power generated
  condenserHeatRejection: number; // W - heat rejected to cooling water
  feedwaterPumpWork: number;      // W - work done by feedwater pumps
  netPower: number;               // W - turbine power - pump work
}

// Module-level state for UI access
let lastTurbineCondenserState: TurbineCondenserState = {
  turbinePower: 0,
  condenserHeatRejection: 0,
  feedwaterPumpWork: 0,
  netPower: 0,
};

export function getTurbineCondenserState(): TurbineCondenserState {
  return { ...lastTurbineCondenserState };
}

/**
 * Update the turbine/condenser state from the rate operator
 */
export function updateTurbineCondenserState(
  turbinePower: number,
  condenserHeatRejection: number,
  pumpWork: number = 0
): void {
  lastTurbineCondenserState = {
    turbinePower,
    condenserHeatRejection,
    feedwaterPumpWork: pumpWork,
    netPower: turbinePower - pumpWork,
  };
}
