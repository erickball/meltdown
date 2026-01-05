/**
 * Cost Estimation Module
 *
 * Provides realistic installed cost estimates for power plant components.
 *
 * Cost methodology:
 * - Steel vessels/tanks: Material cost + fabrication + field installation
 * - Rotating equipment: Based on power/flow rating with material multipliers
 * - Heat exchangers: Based on heat transfer area and tube count
 * - Nuclear components: Premium for reactor-grade materials and QA
 *
 * All costs are in 2024 USD and represent overnight construction cost
 * (installed cost including labor, excluding financing costs).
 *
 * NQA-1 (Nuclear Quality Assurance) typically adds 200-400% to component costs
 * due to: documentation, inspection, certified materials, specialized labor,
 * and regulatory compliance. We use a 3x multiplier as default.
 */

// Steel prices ($/kg) for different grades
const STEEL_PRICES = {
  carbonSteel: 2.5,           // SA-516 Gr 70, general purpose
  lowAlloySteel: 4.0,         // SA-533 Grade B, reactor vessels
  stainlessSteel: 8.0,        // 304/316 SS
  inconel: 45.0,              // Inconel 600/690 for SG tubes
};

// Fabrication cost multipliers (vs raw material cost)
const FABRICATION_MULTIPLIERS = {
  simpleTank: 3.0,            // Basic cylindrical vessel
  pressureVessel: 5.0,        // ASME code vessel with heads
  reactorVessel: 8.0,         // Complex forging, cladding
  heatExchanger: 6.0,         // Tube bundle assembly
  piping: 4.0,                // Including fittings, supports
  pump: 1.0,                  // (base cost includes fabrication)
  valve: 1.0,                 // (base cost includes fabrication)
  turbine: 1.0,               // (base cost includes fabrication)
};

// Installation cost multipliers (vs equipment cost)
const INSTALLATION_MULTIPLIERS = {
  simpleTank: 0.5,            // Basic rigging and setting
  pressureVessel: 0.8,        // Complex rigging, alignment
  reactorVessel: 1.5,         // Specialized heavy lift, internals
  heatExchanger: 0.7,         // Tube bundle insertion
  piping: 1.2,                // Welding, supports, hangers
  pump: 0.6,                  // Foundation, alignment, piping
  valve: 0.3,                 // Inline installation
  turbine: 1.0,               // Foundation, alignment, auxiliary systems
  condenser: 0.6,             // Placement, circulating water piping
  electrical: 0.4,            // Generator connections
};

// NQA-1 multiplier for nuclear quality components
const NQA1_MULTIPLIER = 5.0;

// Steel density (kg/m³)
const STEEL_DENSITY = 7850;

/**
 * Calculate the mass of steel for a cylindrical pressure vessel
 */
function cylindricalVesselSteelMass(
  innerDiameter: number,    // m
  height: number,           // m
  wallThickness: number,    // m
  hasDomes: boolean = true  // hemispherical heads
): number {
  const R = innerDiameter / 2;
  const t = wallThickness;

  // Cylindrical shell: V = 2*π*R*t*h (approximation for thin shell)
  const shellVolume = 2 * Math.PI * R * t * height;

  // Hemispherical heads: V = 2*π*R²*t (for each head, thin shell)
  const headVolume = hasDomes ? 2 * (2 * Math.PI * R * R * t) : 0;

  // Add 10% for nozzles, reinforcement pads, flanges
  const totalVolume = (shellVolume + headVolume) * 1.10;

  return totalVolume * STEEL_DENSITY;
}

/**
 * Calculate the mass of steel for a pipe
 */
function pipeSteelMass(
  innerDiameter: number,    // m
  wallThickness: number,    // m
  length: number            // m
): number {
  const outerDiameter = innerDiameter + 2 * wallThickness;
  const innerArea = Math.PI * (innerDiameter / 2) ** 2;
  const outerArea = Math.PI * (outerDiameter / 2) ** 2;
  const crossSection = outerArea - innerArea;

  // Add 20% for elbows, tees, flanges (typical for complex routing)
  return crossSection * length * STEEL_DENSITY * 1.20;
}

/**
 * Calculate wall thickness using ASME formula
 * t = P*R / (S*E - 0.6*P)
 */
function calculateWallThickness(
  pressureRating: number,   // bar
  innerRadius: number,      // m
  allowableStress: number = 137e6,  // Pa (carbon steel default)
  jointEfficiency: number = 0.85
): number {
  const P = pressureRating * 1e5; // bar to Pa
  const S = allowableStress;
  const E = jointEfficiency;
  return P * innerRadius / (S * E - 0.6 * P);
}

export interface CostEstimate {
  materialCost: number;
  fabricationCost: number;
  installationCost: number;
  subtotal: number;
  nqa1Premium: number;
  total: number;
  breakdown: Record<string, number>;
}

/**
 * Estimate cost for a tank or simple pressure vessel
 */
export function estimateTankCost(props: {
  volume: number;           // m³
  height: number;           // m
  pressureRating: number;   // bar
  nqa1: boolean;
}): CostEstimate {
  // Derive radius from volume and height
  const radius = Math.sqrt(props.volume / (Math.PI * props.height));

  // Calculate wall thickness
  const wallThickness = calculateWallThickness(props.pressureRating, radius);

  // Steel mass
  const steelMass = cylindricalVesselSteelMass(
    radius * 2,
    props.height,
    wallThickness,
    true // has domes
  );

  // Material cost
  const materialCost = steelMass * STEEL_PRICES.carbonSteel;

  // Fabrication
  const fabricationCost = materialCost * FABRICATION_MULTIPLIERS.pressureVessel;

  // Installation
  const installationCost = (materialCost + fabricationCost) * INSTALLATION_MULTIPLIERS.pressureVessel;

  const subtotal = materialCost + fabricationCost + installationCost;
  const nqa1Premium = props.nqa1 ? subtotal * (NQA1_MULTIPLIER - 1) : 0;

  return {
    materialCost,
    fabricationCost,
    installationCost,
    subtotal,
    nqa1Premium,
    total: subtotal + nqa1Premium,
    breakdown: {
      steelMass,
      wallThickness: wallThickness * 1000, // mm
    },
  };
}

/**
 * Estimate cost for a reactor vessel (much more expensive than simple tanks)
 */
export function estimateReactorVesselCost(props: {
  innerDiameter: number;    // m
  height: number;           // m
  pressureRating: number;   // bar
  barrelDiameter: number;   // m
  barrelThickness: number;  // m
  nqa1: boolean;
}): CostEstimate {
  // Reactor vessel wall thickness (SA-533 Grade B Class 1)
  const wallThickness = calculateWallThickness(
    props.pressureRating,
    props.innerDiameter / 2,
    172e6,  // Higher allowable stress for SA-533
    1.0     // Full radiography
  );

  // Vessel steel mass (including cladding at ~3mm SS)
  const vesselMass = cylindricalVesselSteelMass(
    props.innerDiameter,
    props.height,
    wallThickness,
    true
  );

  // Add 8mm stainless steel cladding mass
  const claddingMass = cylindricalVesselSteelMass(
    props.innerDiameter,
    props.height,
    0.008, // 8mm cladding
    true
  );

  // Core barrel mass
  const barrelMass = cylindricalVesselSteelMass(
    props.barrelDiameter,
    props.height * 0.8, // Barrel is typically 80% of vessel height
    props.barrelThickness,
    false // No domes on barrel
  );

  // Material costs (reactor grade steel is more expensive)
  const vesselMaterialCost = vesselMass * STEEL_PRICES.lowAlloySteel;
  const claddingMaterialCost = claddingMass * STEEL_PRICES.stainlessSteel;
  const barrelMaterialCost = barrelMass * STEEL_PRICES.stainlessSteel;
  const materialCost = vesselMaterialCost + claddingMaterialCost + barrelMaterialCost;

  // Fabrication (complex forging, welding, cladding)
  const fabricationCost = materialCost * FABRICATION_MULTIPLIERS.reactorVessel;

  // Installation (heavy lift, internals installation, inspection)
  const installationCost = (materialCost + fabricationCost) * INSTALLATION_MULTIPLIERS.reactorVessel;

  // Reactor vessels are ALWAYS NQA-1 (force the multiplier)
  const subtotal = materialCost + fabricationCost + installationCost;
  const nqa1Premium = subtotal * (NQA1_MULTIPLIER - 1);

  return {
    materialCost,
    fabricationCost,
    installationCost,
    subtotal,
    nqa1Premium,
    total: subtotal + nqa1Premium,
    breakdown: {
      vesselMass,
      claddingMass,
      barrelMass,
      wallThickness: wallThickness * 1000, // mm
    },
  };
}

/**
 * Estimate cost for piping
 */
export function estimatePipeCost(props: {
  diameter: number;         // m (inner)
  length: number;           // m
  pressureRating: number;   // bar
  nqa1: boolean;
}): CostEstimate {
  // Wall thickness for pipe (ASME B31.1)
  const wallThickness = calculateWallThickness(
    props.pressureRating,
    props.diameter / 2,
    137e6,
    1.0
  );

  // Minimum wall thickness for handling
  const effectiveWallThickness = Math.max(wallThickness, 0.003); // 3mm minimum

  // Steel mass
  const steelMass = pipeSteelMass(props.diameter, effectiveWallThickness, props.length);

  // Material cost
  const materialCost = steelMass * STEEL_PRICES.carbonSteel;

  // Fabrication
  const fabricationCost = materialCost * FABRICATION_MULTIPLIERS.piping;

  // Installation (welding, supports, insulation prep)
  const installationCost = (materialCost + fabricationCost) * INSTALLATION_MULTIPLIERS.piping;

  const subtotal = materialCost + fabricationCost + installationCost;
  const nqa1Premium = props.nqa1 ? subtotal * (NQA1_MULTIPLIER - 1) : 0;

  return {
    materialCost,
    fabricationCost,
    installationCost,
    subtotal,
    nqa1Premium,
    total: subtotal + nqa1Premium,
    breakdown: {
      steelMass,
      wallThickness: effectiveWallThickness * 1000, // mm
    },
  };
}

/**
 * Estimate cost for a pump based on flow and head ratings
 *
 * Pump costs scale roughly with hydraulic power (flow × head)
 * Base costs:
 * - Small pump (100 kg/s, 50m): ~$50,000
 * - Medium pump (1000 kg/s, 100m): ~$500,000
 * - Large RCP (5000 kg/s, 100m): ~$5,000,000
 */
export function estimatePumpCost(props: {
  ratedFlow: number;        // kg/s
  ratedHead: number;        // m
  pumpType: 'centrifugal' | 'positive';
  nqa1: boolean;
}): CostEstimate {
  // Hydraulic power in kW
  const hydraulicPower = (props.ratedFlow * 9.81 * props.ratedHead) / 1000;

  // Base cost scales with power^0.7 (economy of scale)
  // Calibrated: 100 kW pump ≈ $50,000
  const baseCost = 5000 * Math.pow(hydraulicPower, 0.7);

  // Positive displacement pumps cost ~1.5x more
  const typeMultiplier = props.pumpType === 'positive' ? 1.5 : 1.0;

  const equipmentCost = baseCost * typeMultiplier;

  // Installation
  const installationCost = equipmentCost * INSTALLATION_MULTIPLIERS.pump;

  // Motor cost (roughly 30% of pump cost for large pumps)
  const motorCost = equipmentCost * 0.3;

  const subtotal = equipmentCost + installationCost + motorCost;
  const nqa1Premium = props.nqa1 ? subtotal * (NQA1_MULTIPLIER - 1) : 0;

  return {
    materialCost: equipmentCost,
    fabricationCost: motorCost, // Motor as "fabrication" for display
    installationCost,
    subtotal,
    nqa1Premium,
    total: subtotal + nqa1Premium,
    breakdown: {
      hydraulicPower,
    },
  };
}

/**
 * Estimate cost for valves
 *
 * Valve costs depend heavily on size, type, and pressure class.
 * Base costs (for 300mm, 150 bar):
 * - Gate valve: ~$15,000
 * - Globe valve: ~$20,000
 * - Ball valve: ~$25,000
 * - Butterfly valve: ~$8,000
 * - Check valve: ~$12,000
 * - Relief/Safety valve: ~$30,000
 * - PORV: ~$50,000
 */
export function estimateValveCost(props: {
  diameter: number;         // m
  valveType: 'gate' | 'globe' | 'ball' | 'butterfly' | 'check' | 'relief' | 'porv';
  nqa1: boolean;
}): CostEstimate {
  // Base costs for 300mm valve
  const baseCosts: Record<string, number> = {
    'gate': 15000,
    'globe': 20000,
    'ball': 25000,
    'butterfly': 8000,
    'check': 12000,
    'swing': 12000,
    'lift': 14000,
    'tilting-disc': 15000,
    'relief': 30000,
    'porv': 50000,
  };

  const baseCost = baseCosts[props.valveType] || 15000;

  // Size scaling: cost ∝ diameter^2.5 (valve body volume plus trim complexity)
  const referenceSize = 0.3; // 300mm reference
  const sizeMultiplier = Math.pow(props.diameter / referenceSize, 2.5);

  const equipmentCost = baseCost * sizeMultiplier;

  // Installation
  const installationCost = equipmentCost * INSTALLATION_MULTIPLIERS.valve;

  const subtotal = equipmentCost + installationCost;
  const nqa1Premium = props.nqa1 ? subtotal * (NQA1_MULTIPLIER - 1) : 0;

  return {
    materialCost: equipmentCost,
    fabricationCost: 0,
    installationCost,
    subtotal,
    nqa1Premium,
    total: subtotal + nqa1Premium,
    breakdown: {
      sizeMultiplier,
    },
  };
}

/**
 * Estimate cost for heat exchangers
 *
 * HX costs depend on heat transfer area, tube material, and design pressure.
 * Typical costs:
 * - Shell & tube (carbon steel): $500-1000 per m² of HT area
 * - PWR Steam Generator: $50-100M each
 */
export function estimateHeatExchangerCost(props: {
  shellDiameter: number;    // m
  shellLength: number;      // m
  tubeCount: number;
  tubeOD: number;           // mm
  tubeThickness: number;    // mm
  hxType: 'utube' | 'straight' | 'helical';
  shellPressure: number;    // bar
  tubePressure: number;     // bar
  nqa1: boolean;
}): CostEstimate {
  // Calculate heat transfer area
  const tubeOD_m = props.tubeOD / 1000;
  const tubeLength = props.hxType === 'utube' ? props.shellLength * 1.8 : props.shellLength;
  const htArea = Math.PI * tubeOD_m * tubeLength * props.tubeCount;

  // Shell mass
  const shellWallThickness = calculateWallThickness(
    props.shellPressure,
    props.shellDiameter / 2,
    172e6,
    1.0
  );
  const shellMass = cylindricalVesselSteelMass(
    props.shellDiameter,
    props.shellLength,
    Math.max(shellWallThickness, 0.010), // 10mm minimum
    true
  );

  // Tube bundle mass (assume Inconel for SG, SS for others)
  const tubeID_m = tubeOD_m - 2 * (props.tubeThickness / 1000);
  const tubeVolume = Math.PI * ((tubeOD_m/2)**2 - (tubeID_m/2)**2) * tubeLength * props.tubeCount;
  const tubeMass = tubeVolume * STEEL_DENSITY;

  // Tube support plates (~10% of tube mass)
  const supportMass = tubeMass * 0.1;

  // Material costs
  const shellMaterialCost = shellMass * STEEL_PRICES.lowAlloySteel;

  // Use Inconel for high-pressure tube side (like SG tubes)
  const tubeMaterial = props.tubePressure > 100 ? STEEL_PRICES.inconel : STEEL_PRICES.stainlessSteel;
  const tubeMaterialCost = (tubeMass + supportMass) * tubeMaterial;

  const materialCost = shellMaterialCost + tubeMaterialCost;

  // Fabrication (tube bundle assembly is labor intensive)
  const fabricationCost = materialCost * FABRICATION_MULTIPLIERS.heatExchanger;

  // Installation
  const installationCost = (materialCost + fabricationCost) * INSTALLATION_MULTIPLIERS.heatExchanger;

  const subtotal = materialCost + fabricationCost + installationCost;
  const nqa1Premium = props.nqa1 ? subtotal * (NQA1_MULTIPLIER - 1) : 0;

  return {
    materialCost,
    fabricationCost,
    installationCost,
    subtotal,
    nqa1Premium,
    total: subtotal + nqa1Premium,
    breakdown: {
      htArea,
      shellMass,
      tubeMass,
    },
  };
}

/**
 * Estimate cost for turbine-generator
 *
 * Turbine-generator sets are very expensive capital equipment.
 * Typical costs: $300-500 per kW for large steam turbines
 * A 1000 MW turbine-generator: ~$300-500M
 */
export function estimateTurbineGeneratorCost(props: {
  ratedPower: number;       // MW
  stages: number;
  nqa1: boolean;
}): CostEstimate {
  // Base cost: $350/kW for reference 1000 MW unit
  // Smaller units cost more per kW (economy of scale)
  const scaleFactor = Math.pow(props.ratedPower / 1000, -0.15); // Mild economy of scale
  const costPerKW = 350 * scaleFactor;

  const turbineCost = props.ratedPower * 1000 * costPerKW * 0.6; // 60% turbine
  const generatorCost = props.ratedPower * 1000 * costPerKW * 0.4; // 40% generator

  const equipmentCost = turbineCost + generatorCost;

  // Installation (foundation, alignment, aux systems)
  const installationCost = equipmentCost * INSTALLATION_MULTIPLIERS.turbine;

  // Electrical (generator leads, transformer, switchgear)
  const electricalCost = generatorCost * INSTALLATION_MULTIPLIERS.electrical;

  const subtotal = equipmentCost + installationCost + electricalCost;

  // Turbine-generators are NOT nuclear safety-related (balance of plant)
  // NQA-1 doesn't typically apply, but user can check if they want
  const nqa1Premium = props.nqa1 ? subtotal * (NQA1_MULTIPLIER - 1) : 0;

  return {
    materialCost: turbineCost,
    fabricationCost: generatorCost,
    installationCost: installationCost + electricalCost,
    subtotal,
    nqa1Premium,
    total: subtotal + nqa1Premium,
    breakdown: {
      turbineCost,
      generatorCost,
      costPerKW,
    },
  };
}

/**
 * Estimate cost for turbine-driven pump (like RCIC or TDAFWP)
 */
export function estimateTurbineDrivenPumpCost(props: {
  ratedPumpFlow: number;    // kg/s
  ratedHead: number;        // m
  stages: number;
  nqa1: boolean;
}): CostEstimate {
  // Small steam turbine cost
  const shaftPower = (props.ratedPumpFlow * 9.81 * props.ratedHead) / 1000 / 0.75; // kW (assuming 75% pump efficiency)

  // Small steam turbines: ~$1000/kW (much higher than large ones)
  const turbineCost = shaftPower * 1000;

  // Pump cost (same as regular pump)
  const pumpCost = 5000 * Math.pow(shaftPower, 0.7);

  const equipmentCost = turbineCost + pumpCost;

  // Installation
  const installationCost = equipmentCost * INSTALLATION_MULTIPLIERS.pump * 1.3; // More complex than motor-driven

  const subtotal = equipmentCost + installationCost;
  const nqa1Premium = props.nqa1 ? subtotal * (NQA1_MULTIPLIER - 1) : 0;

  return {
    materialCost: turbineCost,
    fabricationCost: pumpCost,
    installationCost,
    subtotal,
    nqa1Premium,
    total: subtotal + nqa1Premium,
    breakdown: {
      shaftPower,
    },
  };
}

/**
 * Estimate cost for condenser
 *
 * Condensers are large heat exchangers with many tubes.
 * Typical costs: $100-200 per kW of thermal capacity
 */
export function estimateCondenserCost(props: {
  volume: number;           // m³
  coolingCapacity: number;  // MW
  nqa1: boolean;
}): CostEstimate {
  // Cost based on cooling capacity
  // Reference: $150/kW for 2000 MW thermal condenser
  const costPerKW = 150;

  const equipmentCost = props.coolingCapacity * 1000 * costPerKW;

  // Installation (placement, CW piping, vacuum systems)
  const installationCost = equipmentCost * INSTALLATION_MULTIPLIERS.condenser;

  // Circulating water pumps (typically included in condenser system)
  // Roughly 2% of thermal capacity as CW pump cost
  const cwPumpCost = props.coolingCapacity * 1000 * 20; // $20/kW thermal

  const subtotal = equipmentCost + installationCost + cwPumpCost;

  // Condensers are balance of plant (not usually NQA-1)
  const nqa1Premium = props.nqa1 ? subtotal * (NQA1_MULTIPLIER - 1) : 0;

  return {
    materialCost: equipmentCost,
    fabricationCost: cwPumpCost,
    installationCost,
    subtotal,
    nqa1Premium,
    total: subtotal + nqa1Premium,
    breakdown: {
      costPerKW,
    },
  };
}

/**
 * Estimate cost for reactor core (fuel assemblies)
 *
 * Nuclear fuel is extremely expensive due to:
 * - Enriched uranium (LEU at 3-5%)
 * - Zircaloy cladding
 * - Complex assembly manufacturing
 * - Licensing and QA
 *
 * Typical initial core: $150-200M for a 1000 MWe plant
 * (This is fuel fabrication cost only, not uranium or enrichment)
 */
export function estimateCoreCost(props: {
  thermalPower: number;     // MWt
  fuelRodCount: number;
  height: number;           // m (active fuel height)
  diameter: number;         // m (core diameter)
  nqa1: boolean;
}): CostEstimate {
  // Fuel fabrication cost scales with power
  // Reference: $50/kWt for initial core
  const fuelFabCost = props.thermalPower * 1000 * 50;

  // Control rod drive mechanisms: ~$200K each
  // Assume 1 CRDM per 4 assemblies, and about 200-300 assemblies for a typical PWR
  const assemblyCount = Math.ceil(props.fuelRodCount / 264); // 17x17 array minus some
  const crdmCount = Math.ceil(assemblyCount / 4);
  const crdmCost = crdmCount * 200000;

  // Core support structures
  const coreSupportCost = 5000000 + props.thermalPower * 1000; // $5M base + $1/Wt

  const equipmentCost = fuelFabCost;
  const fabricationCost = crdmCost + coreSupportCost;

  // Installation (core loading is specialized and slow)
  const installationCost = fuelFabCost * 0.1; // 10% for loading operations

  const subtotal = equipmentCost + fabricationCost + installationCost;

  // Nuclear fuel is ALWAYS NQA-1 by definition
  const nqa1Premium = subtotal * (NQA1_MULTIPLIER - 1);

  return {
    materialCost: equipmentCost,
    fabricationCost,
    installationCost,
    subtotal,
    nqa1Premium,
    total: subtotal + nqa1Premium,
    breakdown: {
      assemblyCount,
      crdmCount,
    },
  };
}

/**
 * Estimate cost for a scram controller
 *
 * Reactor protection system instrumentation and controls.
 * This includes: sensors, logic cabinets, power supplies, cabling.
 */
export function estimateControllerCost(_props: {
  controllerType: 'scram';
  nqa1: boolean;
}): CostEstimate {
  // RPS channel cost (4 channels for safety)
  const channelCost = 500000; // Per redundant channel
  const numChannels = 4;

  // Logic cabinets
  const cabinetCost = 200000;

  // Sensors per channel (temperature, pressure, flow, neutron flux)
  const sensorCost = numChannels * 4 * 50000; // 4 sensor types per channel

  const equipmentCost = channelCost * numChannels + cabinetCost + sensorCost;

  // Installation (cabling, testing, commissioning)
  const installationCost = equipmentCost * 0.5;

  const subtotal = equipmentCost + installationCost;

  // RPS is ALWAYS NQA-1 (safety system)
  const nqa1Premium = subtotal * (NQA1_MULTIPLIER - 1);

  return {
    materialCost: equipmentCost,
    fabricationCost: 0,
    installationCost,
    subtotal,
    nqa1Premium,
    total: subtotal + nqa1Premium,
    breakdown: {
      numChannels,
    },
  };
}

/**
 * Format a dollar amount for display
 */
export function formatCost(amount: number): string {
  if (amount >= 1e9) {
    return `$${(amount / 1e9).toFixed(2)}B`;
  } else if (amount >= 1e6) {
    return `$${(amount / 1e6).toFixed(2)}M`;
  } else if (amount >= 1e3) {
    return `$${(amount / 1e3).toFixed(0)}K`;
  } else {
    return `$${amount.toFixed(0)}`;
  }
}

/**
 * Estimate cost for any component type
 */
export function estimateComponentCost(
  componentType: string,
  props: Record<string, any>
): CostEstimate {
  const nqa1 = props.nqa1 ?? false;

  switch (componentType) {
    case 'tank':
    case 'pressurizer':
      return estimateTankCost({
        volume: props.volume || 10,
        height: props.height || 4,
        pressureRating: props.pressureRating || 200,
        nqa1,
      });

    case 'reactor-vessel':
      return estimateReactorVesselCost({
        innerDiameter: props.innerDiameter || 4.4,
        height: props.height || 12,
        pressureRating: props.pressureRating || 175,
        barrelDiameter: props.barrelDiameter || 3.4,
        barrelThickness: props.barrelThickness || 0.05,
        nqa1: true, // Always NQA-1
      });

    case 'pipe':
      return estimatePipeCost({
        diameter: props.diameter || 0.5,
        length: props.length || 10,
        pressureRating: props.pressureRating || 155,
        nqa1,
      });

    case 'pump':
      return estimatePumpCost({
        ratedFlow: props.ratedFlow || 1000,
        ratedHead: props.ratedHead || 100,
        pumpType: props.type || 'centrifugal',
        nqa1,
      });

    case 'valve':
    case 'check-valve':
    case 'relief-valve':
    case 'porv':
      return estimateValveCost({
        diameter: props.diameter || 0.3,
        valveType: props.type || props.valveType || 'gate',
        nqa1,
      });

    case 'heat-exchanger':
      return estimateHeatExchangerCost({
        shellDiameter: props.shellDiameter || 2.5,
        shellLength: props.shellLength || 8,
        tubeCount: props.tubeCount || 3000,
        tubeOD: props.tubeOD || 19,
        tubeThickness: props.tubeThickness || 1.2,
        hxType: props.hxType || 'utube',
        shellPressure: props.shellPressure || 60,
        tubePressure: props.tubePressure || 150,
        nqa1,
      });

    case 'turbine-generator':
      // Expects ratedPower in MW
      return estimateTurbineGeneratorCost({
        ratedPower: props.ratedPower || 1000,
        stages: props.stages || 3,
        nqa1,
      });

    case 'turbine-driven-pump':
      return estimateTurbineDrivenPumpCost({
        ratedPumpFlow: props.ratedPumpFlow || 50,
        ratedHead: props.ratedHead || 500,
        stages: props.stages || 1,
        nqa1,
      });

    case 'condenser':
      // Expects coolingCapacity in MW
      return estimateCondenserCost({
        volume: props.volume || 100,
        coolingCapacity: props.coolingCapacity || 2000,
        nqa1,
      });

    case 'core':
      return estimateCoreCost({
        thermalPower: props.thermalPower || 3000,
        fuelRodCount: parseInt(props.fuelRodCount?.replace(/,/g, '') || '50000'),
        height: props.height || 3.66,
        diameter: props.diameter || 3.2,
        nqa1: true, // Always NQA-1
      });

    case 'scram-controller':
      return estimateControllerCost({
        controllerType: 'scram',
        nqa1: true, // Always NQA-1
      });

    default:
      // Unknown component type - return zero cost
      return {
        materialCost: 0,
        fabricationCost: 0,
        installationCost: 0,
        subtotal: 0,
        nqa1Premium: 0,
        total: 0,
        breakdown: {},
      };
  }
}

/**
 * Calculate total plant construction cost from all components
 */
export function calculateTotalPlantCost(
  components: Map<string, Record<string, any>>,
  _componentDefinitions: Record<string, { type: string; properties: Record<string, any> }>
): { total: number; breakdown: Map<string, CostEstimate> } {
  const breakdown = new Map<string, CostEstimate>();
  let total = 0;

  for (const [id, component] of components) {
    // Map component type to definition key
    const defKey = mapComponentTypeToDefinition(component.type, component);
    const estimate = estimateComponentCost(defKey, component);
    breakdown.set(id, estimate);
    total += estimate.total;
  }

  return { total, breakdown };
}

/**
 * Map component type from PlantComponent to cost estimation key
 */
function mapComponentTypeToDefinition(type: string, component?: Record<string, any>): string {
  // Special case: vessel can be either pressurizer or core
  if (type === 'vessel' && component) {
    if (component.fuelRodCount !== undefined || component.controlRodCount !== undefined) {
      return 'core';
    }
    return 'pressurizer';
  }

  // Special case: valve types
  if (type === 'valve' && component) {
    if (component.valveType === 'check') return 'check-valve';
    if (component.valveType === 'relief') return 'relief-valve';
    if (component.valveType === 'porv') return 'porv';
    return 'valve';
  }

  const mapping: Record<string, string> = {
    'tank': 'tank',
    'vessel': 'pressurizer',
    'reactorVessel': 'reactor-vessel',
    'pipe': 'pipe',
    'pump': 'pump',
    'heatExchanger': 'heat-exchanger',
    'condenser': 'condenser',
    'turbine-generator': 'turbine-generator',
    'turbine-driven-pump': 'turbine-driven-pump',
    'fuelAssembly': 'core',
    'coreBarrel': 'core', // Core barrel is part of reactor vessel cost
    'controller': 'scram-controller',
  };

  return mapping[type] || type;
}
