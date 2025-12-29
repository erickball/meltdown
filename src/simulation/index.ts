/**
 * Simulation Module Index
 *
 * This is the main entry point for the physics simulation.
 */

// Core types
export * from './types';

// Solver
export {
  Solver,
  cloneSimulationState,
  getSolverProfile,
  resetSolverProfile,
} from './solver';
export type { PhysicsOperator, SolverConfig, SolverProfile } from './solver';

// Operators
export * from './operators';

// Factory for creating simulation state
export { createSimulationState, createDemoReactor, createSimulationFromPlant } from './factory';

// Water properties (including debug and profiling functions)
export {
  setWaterPropsDebug,
  getWaterPropsDebugLog,
  calculateState as calculateWaterState,
  saturationPressure,
  saturationTemperature,
  enableCalculationDebug,
  getCalculationDebugLog,
  lookupCompressedLiquidDensity,
  distanceToSaturationLine,
  getWaterPropsProfile,
  resetWaterPropsProfile,
  clearStateCache,
  type WaterPropsProfile,
} from './water-properties';
