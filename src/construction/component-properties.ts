// Shared dialog <-> model property mapping for plant components.
//
// This is the SINGLE read path used to prefill the edit dialog AND to audit
// that an edit actually landed in the model (see auditComponentEditSync's
// caller in main.ts). ConstructionManager.updateComponent is the write path;
// whenever a mapping or unit conversion is added there, the matching read
// must be added here, or the round-trip audit will (deliberately, loudly)
// flag the field as out of sync.
//
// Unit conventions: the model stores SI (Pa, K, W, m, fractions); dialogs use
// display units (bar, °C, MW, mm, %). All conversions live here and in
// updateComponent - nowhere else.

/**
 * Volume of a tank/pressurizer (type 'tank') as the simulation will see it:
 * an explicit stored volume wins (preset plants may carry one), otherwise the
 * drawn cylinder. Matches simulation/factory.ts's tank node creation exactly.
 */
export function tankVolume(component: Record<string, any>): number {
  return component.volume !== undefined
    ? component.volume
    : Math.PI * Math.pow((component.width ?? 0) / 2, 2) * (component.height ?? 0);
}

/**
 * Volume of a condenser as the simulation will see it (square footprint,
 * width² × height - matches simulation/factory.ts).
 */
export function condenserVolume(component: Record<string, any>): number {
  return (component.width ?? 0) * (component.width ?? 0) * (component.height ?? 0);
}

/**
 * Heat exchangers store their drawn box as width/height and encode
 * orientation by which is which (vertical: width = shell diameter,
 * height = shell length; horizontal: swapped). Newer components carry an
 * explicit orientation field; older ones fall back to the aspect-ratio
 * convention (taller than wide = vertical), which is ambiguous only for
 * squat shells.
 */
export function hxIsVertical(component: Record<string, any>): boolean {
  if (component.orientation === 'vertical' || component.orientation === 'horizontal') {
    return component.orientation === 'vertical';
  }
  return (component.height ?? 0) >= (component.width ?? 0);
}

/**
 * Map a PlantComponent type to its dialog definition key.
 */
export function mapComponentTypeToDefinition(type: string, component?: Record<string, any>): string {
  // Special case: controller can be scram or pid
  if (type === 'controller' && component) {
    return component.controllerType === 'pid' ? 'pid-controller' : 'scram-controller';
  }

  // Special case: vessel can be either pressurizer or core
  if (type === 'vessel' && component) {
    // If it has fuelRodCount or controlRodCount, it's a core
    if (component.fuelRodCount !== undefined || component.controlRodCount !== undefined) {
      return 'core';
    }
    return 'pressurizer';
  }

  // Special case: valve can be check-valve, relief-valve, or porv based on valveType
  if (type === 'valve' && component) {
    if (component.valveType === 'check') {
      return 'check-valve';
    }
    if (component.valveType === 'relief') {
      return 'relief-valve';
    }
    if (component.valveType === 'porv') {
      return 'porv';
    }
    // Otherwise it's a standard valve (gate, globe, ball, butterfly)
    return 'valve';
  }

  const mapping: Record<string, string> = {
    'tank': 'tank',
    'vessel': 'pressurizer',
    'reactorVessel': 'reactor-vessel',
    'pipe': 'pipe',
    'valve': 'valve',
    'check-valve': 'check-valve',
    'relief-valve': 'relief-valve',
    'porv': 'porv',
    'pump': 'pump',
    'heatExchanger': 'heat-exchanger',
    'condenser': 'condenser',
    'turbine-generator': 'turbine-generator',
    'turbine-driven-pump': 'turbine-driven-pump',
    'fuelAssembly': 'core',
    'controller': 'scram-controller',
    'switchyard': 'switchyard',
    'building': 'building',
    'crossVessel': 'cross-vessel'
  };
  return mapping[type] || type;
}

/**
 * Read the current value of a dialog option from a stored component,
 * handling property-name mapping and model-unit -> display-unit conversion.
 * Returns defaultValue when the component genuinely has no such property.
 */
export function readComponentOption(optionName: string, component: Record<string, any>, defaultValue: any): any {
  // PID controller fields live in the nested pid config with SI units
  if (component.controllerType === 'pid' && component.pid) {
    const pid = component.pid;
    const sKind = pid.sensor?.kind;
    const aKind = pid.actuator?.kind;
    // This panel edits ONE signal against ONE number. A controller whose
    // measurement or setpoint is an expression cannot be represented here,
    // so its fields read blank rather than NaN - and the panel must not
    // offer to overwrite what it cannot show. (The expression editor is the
    // piece that replaces this; until then, edit those in the preset.)
    const sp = typeof pid.setpoint === 'number' ? pid.setpoint : undefined;
    switch (optionName) {
      case 'sensorKind': return sKind;
      case 'sensorNode':
      case 'sensorConnection': return pid.sensor?.targetId ?? '';
      case 'setpointLevel': if (sKind === 'node-level') return sp; break;
      case 'setpointPressure': if (sKind === 'node-pressure') return sp === undefined ? undefined : sp / 1e5; break;
      case 'setpointTemperature': if (sKind === 'node-temperature') return sp === undefined ? undefined : sp - 273.15; break;
      case 'setpointFlow': if (sKind === 'connection-flow') return sp; break;
      case 'setpointPower': if (sKind === 'reactor-power') return sp === undefined ? undefined : sp * 100; break;
      case 'actuatorKind': return aKind;
      case 'actuatorValve':
      case 'actuatorPump':
      case 'actuatorTurbine':
      case 'actuatorHeaterNode': return pid.actuator?.targetId ?? '';
      case 'heaterCapacityMW':
        if (aKind === 'heater-power') return (pid.actuator?.max ?? 2e6) / 1e6;
        break;
      case 'invert': return !!pid.invert;
      case 'aggressiveness': return pid.aggressiveness ?? 1;
      case 'strokeTime': {
        const min = pid.actuator?.min ?? 0;
        const max = pid.actuator?.max ?? 1;
        const rl = pid.actuator?.rateLimit ?? 0.1;
        return Math.round((max - min) / Math.max(rl, 1e-12));
      }
      case 'powerLimitPct': return (pid.powerLimit ?? 1) * 100;
      case 'outputMinPct': return (pid.actuator?.min ?? 0) * 100;
      case 'outputMaxPct': return (pid.actuator?.max ?? 1) * 100;
    }
  }

  // --- Geometry that the model stores as drawn dimensions, not as the ---
  // --- quantity the dialog edits. These must come before the direct   ---
  // --- property match so stray same-named fields can't shadow them.   ---

  const isFueled = component.fuelRodCount !== undefined || component.controlRodCount !== undefined;

  if (component.type === 'tank' && !isFueled) {
    // Tanks/pressurizers: cylinder drawn as width (diameter) × height
    if (optionName === 'volume') return tankVolume(component);
    if (optionName === 'diameter') return component.width;
    // Pressurizer heaters: stored as capacity in W (what the simulation uses)
    if (optionName === 'heaterPower' && component.heaterCapacity !== undefined) {
      return component.heaterCapacity / 1e6; // W to MW
    }
  }

  if (component.type === 'condenser' && optionName === 'volume') {
    return condenserVolume(component);
  }

  if (component.type === 'heatExchanger') {
    // Orientation: explicit field, or encoded in which of width/height is
    // the shell diameter
    const vertical = hxIsVertical(component);
    if (optionName === 'orientation') return vertical ? 'vertical' : 'horizontal';
    if (optionName === 'shellDiameter') return vertical ? component.width : component.height;
    if (optionName === 'shellLength') return vertical ? component.height : component.width;
    // Pressure ratings are stored under *Rating names
    if (optionName === 'tubePressure' && component.tubePressureRating !== undefined) {
      return component.tubePressureRating;
    }
    if (optionName === 'shellPressure' && component.shellPressureRating !== undefined) {
      return component.shellPressureRating;
    }
  }

  if (component.type === 'valve') {
    // PORV initial state is a select (auto/open/closed) stored as controlMode,
    // NOT the numeric opening used by ordinary valves
    if (optionName === 'initialPosition' && component.valveType === 'porv') {
      return component.controlMode ?? 'auto';
    }
  }

  // The 'type' option (valve type, pump type) must NEVER fall through to the
  // direct property match: component.type is the component KIND ('valve',
  // 'pump'), not a dialog value
  if (optionName === 'type') {
    if (component.type === 'valve') {
      // Check valves keep valveType === 'check' (it selects their behavior
      // and dialog); the swing/lift/tilting-disc flavor lives in checkValveType
      return component.valveType === 'check'
        ? (component.checkValveType ?? defaultValue)
        : (component.valveType ?? defaultValue);
    }
    if (component.type === 'pump') return component.pumpType ?? defaultValue;
    return defaultValue;
  }

  if (component.type === 'pump' && optionName === 'speed' && component.speed !== undefined) {
    return component.speed * 3600; // stored as fraction of 3600 RPM
  }

  // tubeCount must read the real engineering count; component.tubeCount is
  // the VISUAL count (capped at ~10 for rendering) and must never reach the
  // dialog, so this check has to precede the direct property match
  if (optionName === 'tubeCount' && component.realTubeCount !== undefined) {
    return component.realTubeCount;
  }

  // Turbine extractions are stored as an extractionPorts array (Pa, sorted
  // by pressure descending); the dialog edits them as three bar fields
  if (optionName === 'extraction1Pressure' || optionName === 'extraction2Pressure' || optionName === 'extraction3Pressure') {
    if (component.extractionPorts !== undefined || component.type === 'turbine-generator') {
      const idx = Number(optionName.charAt('extraction'.length)) - 1;
      const port = component.extractionPorts?.[idx];
      return port ? port.pressure / 1e5 : 0; // Pa to bar, 0 = disabled
    }
  }

  // Direct property match with unit conversions for pressure values stored in Pa
  if (component[optionName] !== undefined) {
    const value = component[optionName];
    // Convert Pa to bar for pressure fields
    if (optionName === 'crackingPressure' || optionName === 'setpoint') {
      return value / 1e5;  // Pa to bar
    }
    // Convert W to MW for power fields (turbine ratedPower, core thermalPower, condenser coolingCapacity stored in W)
    if (optionName === 'ratedPower' || optionName === 'thermalPower' || optionName === 'coolingCapacity') {
      return value / 1e6;  // W to MW
    }
    // Convert K to C for temperature fields stored in K
    if (optionName === 'coolingWaterTemp') {
      return value - 273.15;  // K to C
    }
    // Convert Pa to bar for pressure fields
    if (optionName === 'operatingPressure') {
      return value / 1e5;  // Pa to bar
    }
    // Convert 0-1 to % for efficiency, valve, and blowdown fields
    if (optionName === 'turbineEfficiency' || optionName === 'generatorEfficiency' ||
        optionName === 'pumpEfficiency' || optionName === 'governorValve' || optionName === 'efficiency' ||
        optionName === 'blowdown') {
      return value * 100;  // 0-1 to %
    }
    // Convert m to mm for tube OD (stored in meters)
    if (optionName === 'tubeOD') {
      return value * 1000;  // m to mm
    }
    return value;
  }

  // Map option names to component properties
  const propertyMappings: Record<string, string[]> = {
    'name': ['label'],
    'initialPosition': ['opening'],
    'initialState': ['running'],
    'initialPressure': ['fluid.pressure'],
    'initialTemperature': ['fluid.temperature'],
    'initialPhase': ['fluid.phase'],
    'initialQuality': ['fluid.quality'],
    'initialLevel': ['fillLevel'],
    'ratedFlow': ['ratedFlow'],
    'ratedHead': ['ratedHead'],
    'volume': ['volume'],
    // Pipe endpoint mappings
    'startX': ['position.x'],
    'startY': ['position.y'],
    'endX': ['endPosition.x'],
    'endY': ['endPosition.y'],
    // Core-specific mappings
    'diameter': ['innerDiameter'],
    'controlRodBanks': ['controlRodCount'],
    'initialRodPosition': ['controlRodPosition'],
    // Controller setpoint mappings
    'connectedCore': ['connectedCoreId'],
    'connectedGenerator': ['connectedGeneratorId'],
    'highPower': ['setpoints.highPower'],
    'lowPower': ['setpoints.lowPower'],
    'highFuelTemp': ['setpoints.highFuelTemp'],
    'lowCoolantFlow': ['setpoints.lowCoolantFlow'],
    // Turbine-specific mappings
    'inletPressure': ['inletFluid.pressure'],
    'exhaustPressure': ['outletFluid.pressure'],
    // Building-specific mappings
    'buildingShape': ['shape'],
  };

  const mappings = propertyMappings[optionName];
  if (mappings) {
    for (const prop of mappings) {
      if (prop.includes('.')) {
        // Nested property like 'fluid.pressure'
        const parts = prop.split('.');
        let value = component;
        for (const part of parts) {
          value = value?.[part];
        }
        if (value !== undefined) {
          // Convert units if needed
          if (prop === 'fluid.pressure') return (value as unknown as number) / 1e5; // Pa to bar
          if (prop === 'fluid.temperature') return (value as unknown as number) - 273.15; // K to C
          if (prop === 'setpoints.highFuelTemp') return (value as unknown as number) * 100; // 0-1 to %
          if (prop === 'inletFluid.pressure') return (value as unknown as number) / 1e5; // Pa to bar
          if (prop === 'outletFluid.pressure') return (value as unknown as number) / 1e5; // Pa to bar
          return value;
        }
      } else if (component[prop] !== undefined) {
        // Handle special conversions
        if (prop === 'opening') return component[prop] * 100; // 0-1 to %
        if (prop === 'running') return component[prop] ? 'on' : 'off';
        if (prop === 'fillLevel') return component[prop] * 100; // 0-1 to %
        // Same convention everywhere: 0 = fully inserted, 1 = fully withdrawn
        if (prop === 'controlRodPosition') return component[prop] * 100;
        return component[prop];
      }
    }
  }

  return defaultValue;
}
