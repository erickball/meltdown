// Preset equipment designs for the construction system.
//
// Each component type offers a list of named designs (a couple of RCP sizes,
// a condensate pump, a feedwater pump, ...) with a description of the service
// they're meant for. Selecting one fills the config dialog; the user can then
// tweak any field and save the result as a custom design (persisted in
// localStorage). Property names/units here are the DIALOG option names and
// display units from componentDefinitions (bar, °C, %, mm, RPM), not SI.

export interface ComponentPreset {
  id: string;
  /** Key into componentDefinitions ('pump', 'tank', ...) */
  type: string;
  name: string;
  /** What service/situation this design is appropriate for */
  description: string;
  /** Dialog property overrides; anything not listed keeps the type default */
  properties: Record<string, any>;
  /** True for user-saved designs (stored in localStorage) */
  custom?: boolean;
}

// ---------------------------------------------------------------------------
// Built-in catalog
// ---------------------------------------------------------------------------

const builtinPresets: ComponentPreset[] = [
  // ------------------------------------------------------------- pumps
  {
    id: 'pump-rcp-large', type: 'pump', name: 'Reactor Coolant Pump — Large',
    description: 'Main coolant circulation for a large PWR loop (~1100 MWe class, one per loop). Very high flow at moderate head, casing rated for full primary pressure.',
    properties: { nqa1: true, type: 'centrifugal', ratedFlow: 4700, ratedHead: 90, pressureRating: 175, speed: 1200, efficiency: 85, npshRequired: 25, initialState: 'on' },
  },
  {
    id: 'pump-rcp-small', type: 'pump', name: 'Reactor Coolant Pump — Compact',
    description: 'Primary loop pump for a smaller PWR (2-loop / SMR class). Same duty as the large RCP at roughly half the flow.',
    properties: { nqa1: true, type: 'centrifugal', ratedFlow: 2400, ratedHead: 80, pressureRating: 175, speed: 1200, efficiency: 84, npshRequired: 15, initialState: 'on' },
  },
  {
    id: 'pump-feedwater', type: 'pump', name: 'Main Feedwater Pump',
    description: 'Raises condensate/deaerator water to steam-generator pressure. High head; needs healthy suction pressure (deaerator or booster) to avoid cavitation.',
    properties: { nqa1: false, type: 'centrifugal', ratedFlow: 800, ratedHead: 700, pressureRating: 110, speed: 3600, efficiency: 82, npshRequired: 15, initialState: 'on' },
  },
  {
    id: 'pump-condensate', type: 'pump', name: 'Condensate Pump',
    description: 'Draws from the condenser hotwell at near-vacuum. Installed in a pit below the condenser so the hotwell level provides the little NPSH it needs.',
    properties: { nqa1: false, type: 'centrifugal', elevation: -4, ratedFlow: 800, ratedHead: 250, pressureRating: 30, speed: 1200, efficiency: 80, npshRequired: 2, initialState: 'on' },
  },
  {
    id: 'pump-charging', type: 'pump', name: 'Charging Pump (CVCS)',
    description: 'Small positive-displacement pump that injects makeup/seal water against full primary pressure. Low flow, very high head.',
    properties: { nqa1: true, type: 'positive', ratedFlow: 12, ratedHead: 1600, pressureRating: 210, speed: 900, efficiency: 75, npshRequired: 5, initialState: 'on' },
  },
  {
    id: 'pump-hpsi', type: 'pump', name: 'High-Pressure Safety Injection Pump',
    description: 'Emergency coolant injection against high primary pressure (small-break LOCA). Normally idle; start on demand.',
    properties: { nqa1: true, type: 'centrifugal', ratedFlow: 50, ratedHead: 1300, pressureRating: 180, speed: 3600, efficiency: 75, npshRequired: 5, initialState: 'off' },
  },
  {
    id: 'pump-lpsi', type: 'pump', name: 'Low-Pressure Injection / RHR Pump',
    description: 'High-flow low-head pump for residual heat removal and large-break injection once primary pressure is down. Normally idle.',
    properties: { nqa1: true, type: 'centrifugal', ratedFlow: 300, ratedHead: 120, pressureRating: 45, speed: 1800, efficiency: 80, npshRequired: 4, initialState: 'off' },
  },
  {
    id: 'pump-service-water', type: 'pump', name: 'Service / Cooling Water Pump',
    description: 'Moves large volumes of cooling water at low head (circulating water, component cooling, service water).',
    properties: { nqa1: false, type: 'centrifugal', ratedFlow: 1500, ratedHead: 30, pressureRating: 10, speed: 900, efficiency: 85, npshRequired: 4, initialState: 'on' },
  },

  // ------------------------------------------------------------- tanks
  {
    id: 'tank-rwst', type: 'tank', name: 'Refueling Water Storage Tank',
    description: 'Large vented tank of cold water — the suction source for safety injection and containment spray. Atmospheric, air-blanketed.',
    properties: { nqa1: true, volume: 1500, height: 12, pressureRating: 3, initialLevel: 90, initialPressure: 0.03, initialTemperature: 25, initialNcg: { N2: 0.78, O2: 0.21 } },
  },
  {
    id: 'tank-accumulator', type: 'tank', name: 'Safety Injection Accumulator',
    description: 'Passive injection tank pressurized with nitrogen. Pair with a check valve to the primary: it discharges by itself when primary pressure falls below the gas pressure.',
    properties: { nqa1: true, volume: 40, height: 5, pressureRating: 60, initialLevel: 70, initialPressure: 0.08, initialTemperature: 40, initialNcg: { N2: 44 } },
  },
  {
    id: 'tank-cst', type: 'tank', name: 'Condensate Storage Tank',
    description: 'Atmospheric reserve of clean condensate — feed source for auxiliary/emergency feedwater and makeup.',
    properties: { nqa1: false, volume: 1800, height: 10, pressureRating: 2, initialLevel: 80, initialPressure: 0.03, initialTemperature: 25, initialNcg: { N2: 0.78, O2: 0.21 } },
  },
  {
    id: 'tank-deaerator', type: 'tank', name: 'Deaerator / Feedwater Tank',
    description: 'Pressurized feedwater reservoir at saturation (~7 bar). Mounted high so the feedwater pumps below it get enough NPSH.',
    properties: { nqa1: false, volume: 150, height: 4, elevation: 25, pressureRating: 12, initialLevel: 60, initialPressure: 7, initialTemperature: 165 },
  },
  {
    id: 'tank-prt', type: 'tank', name: 'Pressurizer Relief Tank',
    description: 'Quench tank that receives PORV/safety-valve discharge into a water pool under a nitrogen blanket. Low pressure rating by design.',
    properties: { nqa1: false, volume: 40, height: 3.5, pressureRating: 7, initialLevel: 70, initialPressure: 0.07, initialTemperature: 40, initialNcg: { N2: 2 } },
  },

  // ------------------------------------------------------------- pressurizers
  {
    id: 'przr-large', type: 'pressurizer', name: 'Large PWR Pressurizer',
    description: 'Sized for a 4-loop plant (~1100 MWe): enough steam volume to ride out load transients without lifting the safeties.',
    properties: { nqa1: true, volume: 51, height: 12.8, pressureRating: 175, heaterPower: 1.8, sprayFlow: 60, initialLevel: 60, initialPressure: 155 },
  },
  {
    id: 'przr-compact', type: 'pressurizer', name: 'Compact Pressurizer',
    description: 'For 2-loop and small plants. Smaller steam cushion — expect livelier pressure response to the same transient.',
    properties: { nqa1: true, volume: 28, height: 10, pressureRating: 175, heaterPower: 1.2, sprayFlow: 40, initialLevel: 55, initialPressure: 155 },
  },

  // ------------------------------------------------------------- reactor vessels
  {
    id: 'rv-4loop', type: 'reactor-vessel', name: '4-Loop PWR Vessel',
    description: 'Large PWR vessel (~1100 MWe class): fits a ~3.4 m core with downcomer annulus, rated for full primary pressure.',
    properties: { nqa1: true, innerDiameter: 4.4, height: 13, pressureRating: 175, barrelDiameter: 3.7, barrelThickness: 0.06, barrelBottomGap: 1.5, initialLevel: 100, initialPressure: 155, initialTemperature: 290 },
  },
  {
    id: 'rv-2loop', type: 'reactor-vessel', name: '2-Loop PWR Vessel',
    description: 'Mid-size PWR vessel (~600 MWe class) for a ~2.5 m core.',
    properties: { nqa1: true, innerDiameter: 3.4, height: 11, pressureRating: 175, barrelDiameter: 2.8, barrelThickness: 0.05, barrelBottomGap: 1.2, initialLevel: 100, initialPressure: 155, initialTemperature: 290 },
  },
  {
    id: 'rv-bwr', type: 'reactor-vessel', name: 'BWR Vessel',
    description: 'Tall boiling-water vessel with a steam space: run two-phase at ~72 bar with the water level above the core. Pair with a BWR core (many rod banks).',
    properties: { nqa1: true, innerDiameter: 6.2, height: 20, pressureRating: 88, barrelDiameter: 4.8, barrelThickness: 0.05, barrelBottomGap: 2, barrelTopGap: 3, initialLevel: 65, initialPressure: 72, initialTemperature: 288 },
  },
  {
    id: 'rv-smr', type: 'reactor-vessel', name: 'Small Modular Vessel',
    description: 'Tall, narrow integral vessel for a small core, with generous space above the barrel for an internal steam volume.',
    properties: { nqa1: true, innerDiameter: 3.0, height: 17, pressureRating: 160, barrelDiameter: 1.8, barrelThickness: 0.04, barrelBottomGap: 1, barrelTopGap: 6, initialLevel: 95, initialPressure: 130, initialTemperature: 310 },
  },

  // ------------------------------------------------------------- cores
  {
    id: 'core-4loop', type: 'core', name: '4-Loop PWR Core',
    description: 'Standard large PWR core: 3400 MWt, 3.4 m diameter, 12.6 mm pitch lattice at ~4.5% enrichment. Fits the 4-loop vessel.',
    properties: { nqa1: true, thermalPower: 3400, height: 3.66, diameter: 3.4, fuelForm: 'rods', rodDiameter: 9.5, rodPitch: 12.6, cladThickness: 0.6, enrichmentPct: 4.5, fuelMaterial: 'UO2', controlRodBanks: 4, startCritical: true },
  },
  {
    id: 'core-2loop', type: 'core', name: '2-Loop PWR Core',
    description: 'Mid-size PWR core: 1800 MWt, 2.5 m diameter, same lattice as the large core. Fits the 2-loop vessel.',
    properties: { nqa1: true, thermalPower: 1800, height: 3.66, diameter: 2.5, fuelForm: 'rods', rodDiameter: 9.5, rodPitch: 12.6, cladThickness: 0.6, enrichmentPct: 4.5, fuelMaterial: 'UO2', controlRodBanks: 4, startCritical: true },
  },
  {
    id: 'core-bwr', type: 'core', name: 'BWR Core',
    description: 'Boiling-water core: wider lattice (12.3 mm rods on 16.2 mm pitch), lower enrichment, and many rod banks so rods alone can shut it down cold. Pair with the BWR vessel.',
    properties: { nqa1: true, thermalPower: 3300, height: 3.8, diameter: 4.6, fuelForm: 'rods', rodDiameter: 12.3, rodPitch: 16.2, cladThickness: 0.8, enrichmentPct: 3.8, fuelMaterial: 'UO2', controlRodBanks: 9, startCritical: true },
  },
  {
    id: 'core-smr', type: 'core', name: 'SMR Core',
    description: 'Small core (160 MWt) for an integral vessel; standard PWR lattice at maximum commercial enrichment.',
    properties: { nqa1: true, thermalPower: 160, height: 2.2, diameter: 1.5, fuelForm: 'rods', rodDiameter: 9.5, rodPitch: 12.6, cladThickness: 0.6, enrichmentPct: 4.95, fuelMaterial: 'UO2', controlRodBanks: 4, startCritical: true },
  },
  {
    id: 'core-pebble', type: 'core', name: 'Pebble-Bed Core (HTGR)',
    description: 'Graphite pebble bed for helium cooling: fill the vessel with He at 0% water level. Solid-moderated, high enrichment, thick reflector.',
    properties: { nqa1: true, thermalPower: 250, height: 5.5, diameter: 3.0, fuelForm: 'pebbles', pebbleDiameter: 60, pebbleCount: 420000, heavyMetalPerPebble: 7, reflectorThickness: 0.8, enrichmentPct: 8.5, controlRodBanks: 6, startCritical: true },
  },

  // ------------------------------------------------------------- valves
  {
    id: 'valve-rcs-gate', type: 'valve', name: 'Primary Loop Isolation (Gate)',
    description: 'Full-bore gate valve for reactor coolant loop isolation. Loop-pipe diameter, full primary pressure rating.',
    properties: { nqa1: true, type: 'gate', diameter: 0.7, pressureRating: 175 },
  },
  {
    id: 'valve-msiv', type: 'valve', name: 'Main Steam Isolation (Gate)',
    description: 'Steam-line-sized isolation valve on the SG outlet. Rated for secondary pressure plus margin.',
    properties: { nqa1: true, type: 'gate', diameter: 0.75, pressureRating: 90 },
  },
  {
    id: 'valve-steam-dump', type: 'valve', name: 'Steam Dump / Bypass (Globe)',
    description: 'Throttling globe valve for dumping steam to the condenser or atmosphere during startup and load rejection.',
    properties: { nqa1: false, type: 'globe', diameter: 0.3, pressureRating: 90 },
  },
  {
    id: 'valve-fw-reg', type: 'valve', name: 'Feedwater Regulating (Globe)',
    description: 'Throttling globe valve for feedwater flow control to a steam generator — the usual actuator for an SG level controller.',
    properties: { nqa1: false, type: 'globe', diameter: 0.4, pressureRating: 110 },
  },
  {
    id: 'valve-charging', type: 'valve', name: 'Charging / Letdown (Globe)',
    description: 'Small high-pressure globe valve for CVCS charging, letdown, and auxiliary spray lines.',
    properties: { nqa1: true, type: 'globe', diameter: 0.08, pressureRating: 210 },
  },
  {
    id: 'valve-cw-butterfly', type: 'valve', name: 'Cooling Water (Butterfly)',
    description: 'Large low-pressure butterfly valve for circulating/service water systems.',
    properties: { nqa1: false, type: 'butterfly', diameter: 0.6, pressureRating: 10 },
  },

  // ------------------------------------------------------------- check valves
  {
    id: 'check-fw', type: 'check-valve', name: 'Feedwater Check Valve',
    description: 'Stops reverse blowdown of the steam generator through the feed line if a feed pump trips or the line breaks.',
    properties: { nqa1: false, type: 'swing', diameter: 0.45, pressureRating: 110, crackingPressure: 0.1 },
  },
  {
    id: 'check-si', type: 'check-valve', name: 'Safety Injection Check Valve',
    description: 'Holds full primary pressure off the injection train until injection pressure exceeds RCS pressure (accumulator or pump discharge).',
    properties: { nqa1: true, type: 'tilting-disc', diameter: 0.2, pressureRating: 180, crackingPressure: 0.2 },
  },
  {
    id: 'check-condensate', type: 'check-valve', name: 'Condensate Check Valve',
    description: 'General low-pressure service on pump discharges to prevent backflow through idle pumps.',
    properties: { nqa1: false, type: 'swing', diameter: 0.4, pressureRating: 30, crackingPressure: 0.05 },
  },

  // ------------------------------------------------------------- relief valves
  {
    id: 'relief-przr', type: 'relief-valve', name: 'Pressurizer Safety Valve',
    description: 'Code safety valve on the pressurizer steam space. Set just above PORV pressure so it only lifts if the PORVs can\'t keep up.',
    properties: { nqa1: true, diameter: 0.15, pressureRating: 200, setpoint: 172, blowdown: 5 },
  },
  {
    id: 'relief-msv', type: 'relief-valve', name: 'Main Steam Safety Valve',
    description: 'Protects the steam generator secondary side and steam lines from overpressure (e.g. after turbine trip with MSIVs shut).',
    properties: { nqa1: true, diameter: 0.2, pressureRating: 110, setpoint: 86, blowdown: 5 },
  },
  {
    id: 'relief-lp', type: 'relief-valve', name: 'Low-Pressure System Relief',
    description: 'Small relief for low-pressure auxiliaries (RHR, CCW, tanks) that could be overpressurized by a valve lineup error.',
    properties: { nqa1: false, diameter: 0.1, pressureRating: 25, setpoint: 12, blowdown: 8 },
  },

  // ------------------------------------------------------------- PORVs
  {
    id: 'porv-przr', type: 'porv', name: 'Pressurizer PORV',
    description: 'Power-operated relief on the pressurizer: opens below the safety setpoint to shave pressure spikes; can also be opened deliberately for feed-and-bleed.',
    properties: { nqa1: true, diameter: 0.1, pressureRating: 200, setpoint: 162, blowdown: 3, hasBlockValve: true },
  },
  {
    id: 'porv-adv', type: 'porv', name: 'Atmospheric Dump Valve (Steam)',
    description: 'Steam-side power-operated relief: controlled secondary depressurization and decay-heat removal when the condenser is unavailable.',
    properties: { nqa1: true, diameter: 0.15, pressureRating: 110, setpoint: 82, blowdown: 4, hasBlockValve: true },
  },

  // ------------------------------------------------------------- heat exchangers
  {
    id: 'hx-sg-large', type: 'heat-exchanger', name: 'PWR Steam Generator — Large',
    description: 'Vertical U-tube recirculating SG for a large PWR loop (~900 MWt each). Primary through the tubes at full RCS pressure, boiling on the shell side.',
    properties: { nqa1: true, hxType: 'utube', orientation: 'vertical', elevation: 2, shellDiameter: 4.5, shellLength: 13, plenumLength: 1.5, tubeCount: 6500, tubeOD: 19, tubePressure: 175, shellPressure: 90 },
  },
  {
    id: 'hx-sg-compact', type: 'heat-exchanger', name: 'PWR Steam Generator — Compact',
    description: 'Smaller U-tube SG (~450 MWt) for 2-loop and mid-size plants.',
    properties: { nqa1: true, hxType: 'utube', orientation: 'vertical', elevation: 2, shellDiameter: 3.5, shellLength: 11, plenumLength: 1.2, tubeCount: 4200, tubeOD: 19, tubePressure: 175, shellPressure: 90 },
  },
  {
    id: 'hx-rhr', type: 'heat-exchanger', name: 'RHR Heat Exchanger',
    description: 'Residual heat removal cooler: primary water through the tubes at shutdown pressure, component cooling water on the shell.',
    properties: { nqa1: true, hxType: 'straight', orientation: 'vertical', elevation: 1, shellDiameter: 1.3, shellLength: 6, plenumLength: 0.4, tubeCount: 900, tubeOD: 19, tubePressure: 45, shellPressure: 12 },
  },
  {
    id: 'hx-fwh', type: 'heat-exchanger', name: 'Feedwater Heater',
    description: 'Horizontal U-tube heater: feedwater in the tubes, turbine extraction steam condensing on the shell. Improves cycle efficiency.',
    properties: { nqa1: false, hxType: 'utube', orientation: 'horizontal', elevation: 1, shellDiameter: 1.6, shellLength: 10, plenumLength: 0.6, tubeCount: 1200, tubeOD: 16, tubePressure: 110, shellPressure: 25 },
  },

  // ------------------------------------------------------------- condensers
  {
    id: 'cond-large', type: 'condenser', name: 'Main Condenser — Large',
    description: 'Sized for a ~1100 MWe turbine (rejects ~2300 MW). Comes with a condensate pump.',
    properties: { nqa1: false, volume: 500, height: 4, coolingCapacity: 2400, operatingPressure: 0.05, coolingWaterTemp: 20, coolingWaterFlow: 80000, includesPump: true },
  },
  {
    id: 'cond-medium', type: 'condenser', name: 'Main Condenser — Medium',
    description: 'Sized for a ~500 MWe turbine (rejects ~1100 MW).',
    properties: { nqa1: false, volume: 250, height: 3.5, coolingCapacity: 1100, operatingPressure: 0.06, coolingWaterTemp: 20, coolingWaterFlow: 45000, includesPump: true },
  },
  {
    id: 'cond-aux', type: 'condenser', name: 'Auxiliary Condenser',
    description: 'Small condenser for auxiliary turbines, steam dump, or decay-heat duty on a small plant.',
    properties: { nqa1: false, volume: 60, height: 2.5, coolingCapacity: 150, operatingPressure: 0.1, coolingWaterTemp: 20, coolingWaterFlow: 8000, includesPump: true },
  },

  // ------------------------------------------------------------- turbine-generators
  {
    id: 'tg-1150', type: 'turbine-generator', name: 'Saturated-Steam Turbine — 1150 MWe',
    description: 'Full-size nuclear turbine taking saturated steam at ~65 bar down to condenser vacuum. Extraction ports available for feedwater heating.',
    properties: { nqa1: false, stages: 3, ratedPower: 1150, inletPressure: 65, exhaustPressure: 0.05, turbineEfficiency: 85, generatorEfficiency: 98 },
  },
  {
    id: 'tg-500', type: 'turbine-generator', name: 'Saturated-Steam Turbine — 500 MWe',
    description: 'Mid-size machine for 2-loop plants and BWRs of similar output.',
    properties: { nqa1: false, stages: 3, ratedPower: 500, inletPressure: 60, exhaustPressure: 0.06, turbineEfficiency: 84, generatorEfficiency: 98 },
  },
  {
    id: 'tg-100', type: 'turbine-generator', name: 'Small Turbine — 100 MWe',
    description: 'Compact unit for SMRs and experimental plants; tolerates lower inlet pressure.',
    properties: { nqa1: false, stages: 2, ratedPower: 100, inletPressure: 45, exhaustPressure: 0.08, turbineEfficiency: 82, generatorEfficiency: 97 },
  },

  // ------------------------------------------------------------- turbine-driven pumps
  {
    id: 'tdp-afw', type: 'turbine-driven-pump', name: 'Turbine-Driven Aux Feedwater Pump',
    description: 'Emergency feedwater driven by SG steam — works with no electric power. Feeds the SGs against full secondary pressure.',
    properties: { nqa1: true, stages: 1, ratedPumpFlow: 60, ratedHead: 900, pressureRating: 130, pumpEfficiency: 72, inletPressure: 70, exhaustPressure: 1, turbineEfficiency: 65 },
  },
  {
    id: 'tdp-mfw', type: 'turbine-driven-pump', name: 'Turbine-Driven Main Feed Pump',
    description: 'Normal-duty feed pump driven by intermediate-pressure extraction steam, exhausting toward the condenser.',
    properties: { nqa1: false, stages: 2, ratedPumpFlow: 400, ratedHead: 650, pressureRating: 110, pumpEfficiency: 78, inletPressure: 11, exhaustPressure: 0.1, turbineEfficiency: 78 },
  },

  // ------------------------------------------------------------- buildings
  {
    id: 'bldg-dry', type: 'building', name: 'PWR Dry Containment',
    description: 'Large cylindrical containment with enough free volume to absorb a full primary blowdown at modest pressure.',
    properties: { nqa1: true, buildingShape: 'cylinder', height: 60, diameter: 42, pressureRating: 4.5, steelFraction: 0.1 },
  },
  {
    id: 'bldg-suppression', type: 'building', name: 'Compact Containment (higher rating)',
    description: 'Smaller, stronger containment for compact plants — less volume, higher design pressure.',
    properties: { nqa1: true, buildingShape: 'cylinder', height: 35, diameter: 26, pressureRating: 5.5, steelFraction: 0.15 },
  },
  {
    id: 'bldg-turbine', type: 'building', name: 'Turbine / Auxiliary Building',
    description: 'Conventional industrial building: weather enclosure only, not a pressure boundary.',
    properties: { nqa1: false, buildingShape: 'rectangle', height: 30, width: 50, length: 80, pressureRating: 1, steelFraction: 0.3 },
  },

  // ------------------------------------------------------------- standalone pipes
  {
    id: 'pipe-primary', type: 'pipe', name: 'Primary Loop Piping',
    description: 'Reactor coolant hot/cold leg: ~0.75 m bore at full primary pressure, filled with hot subcooled water.',
    properties: { nqa1: true, diameter: 0.75, pressureRating: 175, initialPhase: 'liquid', initialPressure: 155, initialTemperature: 292 },
  },
  {
    id: 'pipe-main-steam', type: 'pipe', name: 'Main Steam Line',
    description: 'SG outlet to turbine: large bore, saturated steam at secondary pressure.',
    properties: { nqa1: true, diameter: 0.75, pressureRating: 90, initialPhase: 'vapor', initialPressure: 70, initialTemperature: 288 },
  },
  {
    id: 'pipe-feedwater', type: 'pipe', name: 'Feedwater Line',
    description: 'Feed train piping: warm subcooled water at feed pressure.',
    properties: { nqa1: false, diameter: 0.45, pressureRating: 110, initialPhase: 'liquid', initialPressure: 70, initialTemperature: 227 },
  },
  {
    id: 'pipe-small-bore', type: 'pipe', name: 'Small-Bore High-Pressure Line',
    description: 'Charging, letdown, spray, and instrument lines: small diameter, rated above primary pressure.',
    properties: { nqa1: true, diameter: 0.1, pressureRating: 210, initialPhase: 'liquid', initialPressure: 155, initialTemperature: 60 },
  },
];

// ---------------------------------------------------------------------------
// Custom (user-saved) presets — persisted in localStorage
// ---------------------------------------------------------------------------

const CUSTOM_PRESETS_KEY = 'meltdown-custom-components';

export function loadCustomPresets(): ComponentPreset[] {
  // Headless (node) contexts have no localStorage - no custom presets there
  if (typeof localStorage === 'undefined') return [];
  try {
    const json = localStorage.getItem(CUSTOM_PRESETS_KEY);
    if (!json) return [];
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      console.error('[Presets] Custom preset store is not an array - ignoring it');
      return [];
    }
    return parsed.filter((p: any) => p && typeof p.id === 'string' && typeof p.type === 'string' && p.properties);
  } catch (e) {
    console.error('[Presets] Failed to load custom presets:', e);
    return [];
  }
}

export function saveCustomPreset(preset: ComponentPreset): void {
  const all = loadCustomPresets().filter(p => p.id !== preset.id);
  all.push({ ...preset, custom: true });
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(all));
}

export function deleteCustomPreset(id: string): void {
  const all = loadCustomPresets().filter(p => p.id !== id);
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(all));
}

/** Types that get a Design picker in the create dialog */
const presetSupportedTypes = new Set(builtinPresets.map(p => p.type));

export function hasPresetSupport(type: string): boolean {
  return presetSupportedTypes.has(type);
}

/** Built-in designs first, then the user's saved designs, for one component type */
export function getPresetsForType(type: string): ComponentPreset[] {
  return [
    ...builtinPresets.filter(p => p.type === type),
    ...loadCustomPresets().filter(p => p.type === type),
  ];
}

// ---------------------------------------------------------------------------
// Standardized pipe specs for connections
// ---------------------------------------------------------------------------

export interface PipeSpec {
  id: string;
  label: string;
  /** Inner diameter, m */
  diameter: number;
  /** Design pressure, bar */
  pressureRating: number;
  description: string;
}

export const PIPE_SPECS: PipeSpec[] = [
  {
    id: 'spec-2in', label: 'Small-bore line — 2″ (0.05 m), 250 bar',
    diameter: 0.05, pressureRating: 250,
    description: 'Charging, letdown, spray, sampling, and instrument lines. Rated above primary pressure so a valve lineup error can\'t burst it.',
  },
  {
    id: 'spec-6in', label: 'Injection line — 6″ (0.15 m), 180 bar',
    diameter: 0.15, pressureRating: 180,
    description: 'Safety injection headers and other medium-flow lines that must stand full primary pressure.',
  },
  {
    id: 'spec-10in', label: 'Auxiliary line — 10″ (0.25 m), 60 bar',
    diameter: 0.25, pressureRating: 60,
    description: 'General auxiliary service: RHR suction, aux feedwater, CVCS headers, medium-pressure process lines.',
  },
  {
    id: 'spec-14in', label: 'Surge line — 14″ (0.35 m), 175 bar',
    diameter: 0.35, pressureRating: 175,
    description: 'Pressurizer surge line and other full-primary-pressure runs below loop size.',
  },
  {
    id: 'spec-18in', label: 'Feedwater line — 18″ (0.45 m), 110 bar',
    diameter: 0.45, pressureRating: 110,
    description: 'Condensate and feedwater trains between pumps, heaters, and steam generators.',
  },
  {
    id: 'spec-30in-steam', label: 'Main steam line — 30″ (0.75 m), 90 bar',
    diameter: 0.75, pressureRating: 90,
    description: 'Steam generator outlet to the turbine; sized for high-volume saturated steam.',
  },
  {
    id: 'spec-30in-primary', label: 'Primary loop — 30″ (0.75 m), 175 bar',
    diameter: 0.75, pressureRating: 175,
    description: 'Reactor coolant hot and cold legs: loop-size bore at full primary pressure.',
  },
  {
    id: 'spec-48in', label: 'Low-pressure duct — 48″ (1.2 m), 20 bar',
    diameter: 1.2, pressureRating: 20,
    description: 'Condenser necks, LP steam crossovers, and circulating water — big bore, low pressure.',
  },
];

export function pipeSpecFlowArea(spec: PipeSpec): number {
  return Math.PI * spec.diameter * spec.diameter / 4;
}

/** Find the spec whose flow area matches (within 2%), e.g. when re-opening an edit dialog */
export function findMatchingPipeSpec(flowArea: number): PipeSpec | null {
  for (const spec of PIPE_SPECS) {
    const area = pipeSpecFlowArea(spec);
    if (Math.abs(area - flowArea) / area < 0.02) return spec;
  }
  return null;
}
