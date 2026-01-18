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
  CladdingOxidationRateOperator,  // Zr + 2H₂O → ZrO₂ + 2H₂ (generates H₂)
  ChokedFlowDisplayOperator,  // Sets conn.isChoked for debug display
  setSeparationDebug,  // Debug toggle for phase separation calculation
} from './operators/rate-operators';

// Semi-implicit pressure solver
export { PressureSolver } from './operators/pressure-solver';
export type { PressureSolverStatus } from './operators/pressure-solver';

// Operators
export * from './operators';

// Factory for creating simulation state
export { createSimulationState, createDemoReactor, createSimulationFromPlant, setSimulationRandomSeed } from './factory';
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

// Gas properties (non-condensible gases)
export {
  // Types
  type GasSpecies,
  type GasComposition,
  type GasPropertyData,
  type FlammabilityStatus,

  // Constants
  ALL_GAS_SPECIES,
  GAS_PROPERTIES,
  R_GAS,
  H2_FLAMMABILITY,
  DRY_AIR_COMPOSITION,

  // Composition creation
  emptyGasComposition,
  createGasComposition,
  cloneGasComposition,
  createAirComposition,

  // Composition calculations
  totalMoles,
  moleFraction,
  allMoleFractions,
  totalMass,
  averageMolecularWeight,
  mixtureCp,
  mixtureCv,

  // Ideal gas law
  ncgPartialPressure,
  speciesPartialPressure,
  ncgDensity,
  molesFromPVT,

  // Composition arithmetic
  addCompositions,
  subtractCompositions,
  scaleComposition,
  isCompositionEmpty,

  // Flammability
  evaluateFlammability,
  hydrogenPercentage,

  // Display
  mixedGasColor,
  compositionSummary,
} from './gas-properties';
