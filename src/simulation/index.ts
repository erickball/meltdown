/**
 * Simulation Module Index
 *
 * This is the main entry point for the physics simulation.
 */

// Core types
export * from './types';

// Solver (Euler)
export {
  Solver,
  cloneSimulationState,
  getSolverProfile,
  resetSolverProfile,
} from './solver';
export type { PhysicsOperator, SolverConfig, SolverProfile } from './solver';

// RK45 Solver
export {
  RK45Solver,
  createZeroRates,
  addRates,
  scaleRates,
  applyRatesToState,
  checkPreConstraintSanity,
} from './rk45-solver';
export type {
  RateOperator,
  ConstraintOperator,
  StateRates,
  FlowNodeRates,
  FlowConnectionRates,
  ThermalNodeRates,
  NeutronicsRates,
  PumpRates,
  RK45Config,
} from './rk45-solver';

// Rate-based operators for RK45
export {
  ConductionRateOperator,
  ConvectionRateOperator,
  HeatGenerationRateOperator,
  NeutronicsRateOperator,
  FlowRateOperator,
  FlowMomentumRateOperator,
  TurbineCondenserRateOperator,
  FluidStateConstraintOperator,
  FlowDynamicsConstraintOperator,
  PumpSpeedRateOperator,
  PumpSpeedConstraintOperator,  // deprecated, kept for compatibility
  setSeparationDebug,  // Debug toggle for phase separation calculation
} from './operators/rate-operators';

// Semi-implicit pressure solver
export { PressureSolver } from './operators/pressure-solver';
export type { PressureSolverStatus } from './operators/pressure-solver';

// Operators
export * from './operators';

// Factory for creating simulation state
export { createSimulationState, createDemoReactor, createSimulationFromPlant } from './factory';
// Note: createDemoReactor is OBSOLETE - throws error if used

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
  preloadWaterProperties,
  isWaterPropertiesLoaded,
  setDebugNodeId,
  clearPressureHistory,
  bulkModulus,
  numericalBulkModulus,
  type WaterPropsProfile,
} from './water-properties';
