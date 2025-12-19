/**
 * Simulation Module Index
 *
 * This is the main entry point for the physics simulation.
 */

// Core types
export * from './types';

// Solver
export { Solver, cloneSimulationState } from './solver';
export type { PhysicsOperator, SolverConfig } from './solver';

// Operators
export * from './operators';

// Factory for creating simulation state
export { createSimulationState, createDemoReactor } from './factory';

// Water properties (including debug functions)
export {
  setWaterPropsDebug,
  getWaterPropsDebugLog,
  calculateState as calculateWaterState,
  saturationPressure,
  saturationTemperature,
  enableCalculationDebug,
  getCalculationDebugLog,
  lookupCompressedLiquidDensity,
} from './water-properties';
