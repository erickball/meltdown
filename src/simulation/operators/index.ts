/**
 * Physics Operators Index
 *
 * Re-exports all operators for convenient importing.
 */

export {
  ConductionOperator,
  ConvectionOperator,
  HeatGenerationOperator,
  FluidStateUpdateOperator,
  getFluidSpecificHeat,
  createFluidState,
  enableFluidStateDebug,
} from './heat-transfer';

export {
  FlowOperator,
  getFlowOperatorProfile,
  resetFlowOperatorProfile,
  type FlowOperatorProfile,
} from './fluid-flow';

export {
  NeutronicsOperator,
  triggerScram,
  resetScram,
  checkScramConditions,
  DEFAULT_SCRAM_SETPOINTS,
  type ScramSetpoints,
} from './neutronics';

export {
  TurbineCondenserOperator,  // OBSOLETE: throws error if used
  createDefaultTurbineCondenserConfig,  // OBSOLETE: throws error if used
  createTurbineCondenserConfigFromPlant,  // OBSOLETE: throws error if used
  getTurbineCondenserState,
  updateTurbineCondenserState,
  type TurbineCondenserConfig,
  type TurbineCondenserState,
} from './turbine-condenser';
