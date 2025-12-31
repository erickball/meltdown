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
} from './operators/rate-operators';

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
  preloadWaterProperties,
  isWaterPropertiesLoaded,
  type WaterPropsProfile,
} from './water-properties';
