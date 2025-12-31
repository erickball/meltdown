// Component configuration definitions and dialog system

export interface ComponentConfig {
  type: string;
  name: string;
  position: { x: number; y: number };
  properties: Record<string, any>;
  containedBy?: string;  // ID of container component (tank, vessel, containment building)
}

export interface ComponentOption {
  name: string;
  type: 'number' | 'text' | 'select' | 'checkbox' | 'calculated';
  label: string;
  default: any;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: any; label: string }>;
  unit?: string;
  help?: string;
  // For calculated fields: function that computes value from other properties
  calculate?: (props: Record<string, any>) => string;
}

export const componentDefinitions: Record<string, {
  displayName: string;
  options: ComponentOption[];
}> = {
  // Vessels
  'tank': {
    displayName: 'Tank',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Tank' },
      { name: 'elevation', type: 'number', label: 'Elevation (Bottom)', default: 0, min: -50, max: 100, step: 0.5, unit: 'm', help: 'Height of tank bottom above ground level' },
      { name: 'volume', type: 'number', label: 'Volume', default: 10, min: 0.1, max: 1000, step: 0.1, unit: 'm³' },
      { name: 'height', type: 'number', label: 'Height', default: 4, min: 0.5, max: 50, step: 0.5, unit: 'm' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 200, min: 1, max: 600, step: 10, unit: 'bar' },
      { name: 'initialPressure', type: 'number', label: 'Initial Pressure', default: 150, min: 1, max: 300, step: 1, unit: 'bar' },
      { name: 'initialTemperature', type: 'number', label: 'Initial Temperature', default: 300, min: 20, max: 350, step: 5, unit: '°C' },
      { name: 'initialLevel', type: 'number', label: 'Initial Water Level', default: 50, min: 0, max: 100, step: 5, unit: '%' },
      // Calculated fields
      { name: 'wallThickness', type: 'calculated', label: 'Wall Thickness', default: 0, unit: 'mm',
        calculate: (p) => {
          // ASME formula: t = P*R / (S*E - 0.6*P)
          // S = 137 MPa (carbon steel), E = 0.85 (spot radiograph)
          const P = (p.pressureRating || 200) * 1e5; // bar to Pa
          const vol = p.volume || 10;
          const h = p.height || 4;
          const R = Math.sqrt(vol / (Math.PI * h)); // Derive radius from volume and height
          const S = 137e6; // Pa
          const E = 0.85;
          const t = P * R / (S * E - 0.6 * P);
          return (t * 1000).toFixed(1); // Convert to mm
        }
      }
    ]
  },
  'pressurizer': {
    displayName: 'Pressurizer',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Pressurizer' },
      { name: 'elevation', type: 'number', label: 'Elevation (Bottom)', default: 10, min: -50, max: 100, step: 0.5, unit: 'm', help: 'Typically elevated above hot leg' },
      { name: 'volume', type: 'number', label: 'Volume', default: 40, min: 5, max: 100, step: 5, unit: 'm³' },
      { name: 'height', type: 'number', label: 'Height', default: 12, min: 5, max: 20, step: 1, unit: 'm' },
      { name: 'heaterPower', type: 'number', label: 'Heater Power', default: 2, min: 0, max: 10, step: 0.5, unit: 'MW' },
      { name: 'sprayFlow', type: 'number', label: 'Max Spray Flow', default: 50, min: 0, max: 200, step: 10, unit: 'kg/s' },
      { name: 'initialLevel', type: 'number', label: 'Initial Water Level', default: 60, min: 0, max: 100, step: 5, unit: '%' }
    ]
  },
  'reactor-vessel': {
    displayName: 'Reactor Vessel',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Reactor Vessel' },
      { name: 'elevation', type: 'number', label: 'Elevation (Bottom)', default: 0, min: -10, max: 50, step: 0.5, unit: 'm' },
      { name: 'innerDiameter', type: 'number', label: 'Vessel Inner Diameter', default: 4.4, min: 2, max: 8, step: 0.1, unit: 'm' },
      { name: 'height', type: 'number', label: 'Vessel Inner Height', default: 12, min: 5, max: 20, step: 0.5, unit: 'm', help: 'Total internal cavity height (including domes)' },
      { name: 'pressureRating', type: 'number', label: 'Design Pressure', default: 175, min: 100, max: 250, step: 5, unit: 'bar' },
      { name: 'barrelDiameter', type: 'number', label: 'Core Barrel Dia (mid-wall)', default: 3.4, min: 1.5, max: 6, step: 0.1, unit: 'm', help: 'Diameter to center of barrel wall' },
      { name: 'barrelThickness', type: 'number', label: 'Barrel Wall Thickness', default: 0.05, min: 0.02, max: 0.15, step: 0.01, unit: 'm' },
      { name: 'barrelBottomGap', type: 'number', label: 'Barrel Bottom Gap', default: 1.0, min: 0, max: 3, step: 0.1, unit: 'm', help: 'Distance from lower head to barrel bottom' },
      { name: 'barrelTopGap', type: 'number', label: 'Barrel Top Gap', default: 0, min: 0, max: 3, step: 0.1, unit: 'm', help: 'Distance from upper head to barrel top' },
      { name: 'initialPressure', type: 'number', label: 'Initial Pressure', default: 155, min: 50, max: 200, step: 5, unit: 'bar' },
      { name: 'initialTemperature', type: 'number', label: 'Initial Temperature', default: 290, min: 20, max: 350, step: 5, unit: '°C' },
      { name: 'initialLevel', type: 'number', label: 'Initial Water Level', default: 100, min: 0, max: 100, step: 5, unit: '%', help: 'Percentage of vessel filled with liquid' },
      // Calculated fields
      { name: 'wallThickness', type: 'calculated', label: 'Wall Thickness', default: 0, unit: 'mm',
        calculate: (p) => {
          // ASME formula: t = P*R / (S*E - 0.6*P)
          // S = 172 MPa (SA-533 Grade B Class 1 at ~320°C), E = 1.0 (full radiograph)
          const P = (p.pressureRating || 175) * 1e5; // bar to Pa
          const R = (p.innerDiameter || 4.4) / 2;
          const S = 172e6; // Pa - gives realistic wall thicknesses
          const E = 1.0;
          const t = P * R / (S * E - 0.6 * P);
          return (t * 1000).toFixed(0); // Convert to mm
        }
      },
      { name: 'insideVolume', type: 'calculated', label: 'Inside Barrel Volume', default: 0, unit: 'm³',
        calculate: (p) => {
          const vesselR = (p.innerDiameter ?? 4.4) / 2;
          const barrelOuterR = (p.barrelDiameter ?? 3.4) / 2 + (p.barrelThickness ?? 0.05);
          const barrelInnerR = (p.barrelDiameter ?? 3.4) / 2 - (p.barrelThickness ?? 0.05);
          const innerHeight = p.height ?? 12; // Inner height - volumes don't depend on wall thickness
          // Calculate dome intrusion at barrel outer radius
          const domeIntrusion = vesselR - Math.sqrt(vesselR * vesselR - barrelOuterR * barrelOuterR);
          // Barrel height (no wall thickness in formula since height is inner dimension)
          const barrelH = innerHeight - 2 * domeIntrusion - (p.barrelBottomGap ?? 1) - (p.barrelTopGap ?? 0);
          return (Math.PI * barrelInnerR * barrelInnerR * barrelH).toFixed(1);
        }
      },
      { name: 'outsideVolume', type: 'calculated', label: 'Annulus Volume', default: 0, unit: 'm³',
        calculate: (p) => {
          const vesselR = (p.innerDiameter ?? 4.4) / 2;
          const barrelOuterR = (p.barrelDiameter ?? 3.4) / 2 + (p.barrelThickness ?? 0.05);
          const innerHeight = p.height ?? 12; // Inner height - volumes don't depend on wall thickness
          // Calculate dome intrusion at barrel outer radius
          const domeIntrusion = vesselR - Math.sqrt(vesselR * vesselR - barrelOuterR * barrelOuterR);
          // Barrel height (no wall thickness in formula)
          const barrelH = innerHeight - 2 * domeIntrusion - (p.barrelBottomGap ?? 1) - (p.barrelTopGap ?? 0);
          // Total inner vessel volume (cylinder + 2 hemispherical domes)
          const innerCylinderH = innerHeight - 2 * vesselR;
          const domeVol = (4/3) * Math.PI * Math.pow(vesselR, 3) / 2;
          const cylVol = Math.PI * vesselR * vesselR * innerCylinderH;
          const totalVol = cylVol + 2 * domeVol;
          const barrelVol = Math.PI * barrelOuterR * barrelOuterR * barrelH;
          return (totalVol - barrelVol).toFixed(1);
        }
      }
    ]
  },

  // Flow components
  'pipe': {
    displayName: 'Pipe',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Pipe' },
      { name: 'length', type: 'number', label: 'Length', default: 10, min: 1, max: 100, step: 1, unit: 'm' },
      { name: 'diameter', type: 'number', label: 'Diameter', default: 0.5, min: 0.05, max: 2, step: 0.05, unit: 'm' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 155, min: 1, max: 300, step: 5, unit: 'bar' },
      { name: 'elevation', type: 'number', label: 'Elevation Change', default: 0, min: -50, max: 50, step: 0.5, unit: 'm', help: 'Height difference from inlet to outlet' },
      { name: 'roughness', type: 'number', label: 'Roughness', default: 0.0001, min: 0.00001, max: 0.01, step: 0.00001, unit: 'm' },
      // Calculated fields
      { name: 'wallThickness', type: 'calculated', label: 'Wall Thickness', default: 0, unit: 'mm',
        calculate: (p) => {
          // ASME B31.1 formula for pipe: t = P*D / (2*S*E + 2*y*P)
          // S = 137 MPa (carbon steel), E = 1.0, y = 0.4
          const P = (p.pressureRating || 155) * 1e5; // bar to Pa
          const D = (p.diameter || 0.5); // m
          const S = 137e6; // Pa
          const E = 1.0;
          const y = 0.4;
          const t = P * D / (2 * S * E + 2 * y * P);
          return (t * 1000).toFixed(1); // Convert to mm
        }
      }
    ]
  },
  'valve': {
    displayName: 'Valve',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Valve' },
      { name: 'type', type: 'select', label: 'Valve Type', default: 'gate', options: [
        { value: 'gate', label: 'Gate Valve' },
        { value: 'globe', label: 'Globe Valve' },
        { value: 'ball', label: 'Ball Valve' },
        { value: 'check', label: 'Check Valve' },
        { value: 'relief', label: 'Relief Valve' }
      ]},
      { name: 'diameter', type: 'number', label: 'Diameter', default: 0.3, min: 0.05, max: 2, step: 0.05, unit: 'm' },
      { name: 'cv', type: 'number', label: 'Flow Coefficient (Cv)', default: 500, min: 10, max: 10000, step: 10 },
      { name: 'initialPosition', type: 'number', label: 'Initial Position', default: 100, min: 0, max: 100, step: 5, unit: '%', help: '0% = closed, 100% = open' },
      { name: 'reliefSetpoint', type: 'number', label: 'Relief Setpoint', default: 170, min: 10, max: 600, step: 10, unit: 'bar', help: 'Only for relief valves' }
    ]
  },
  'pump': {
    displayName: 'Pump',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Pump' },
      { name: 'type', type: 'select', label: 'Pump Type', default: 'centrifugal', options: [
        { value: 'centrifugal', label: 'Centrifugal' },
        { value: 'positive', label: 'Positive Displacement' }
      ]},
      { name: 'ratedFlow', type: 'number', label: 'Rated Flow', default: 1000, min: 10, max: 10000, step: 10, unit: 'kg/s' },
      { name: 'ratedHead', type: 'number', label: 'Rated Head', default: 100, min: 10, max: 1000, step: 10, unit: 'm' },
      { name: 'speed', type: 'number', label: 'Speed', default: 1800, min: 900, max: 3600, step: 100, unit: 'RPM' },
      { name: 'efficiency', type: 'number', label: 'Efficiency', default: 85, min: 50, max: 95, step: 5, unit: '%' },
      { name: 'npshRequired', type: 'number', label: 'NPSH Required', default: 5, min: 1, max: 30, step: 1, unit: 'm' },
      { name: 'initialState', type: 'select', label: 'Initial State', default: 'on', options: [
        { value: 'on', label: 'Running' },
        { value: 'off', label: 'Stopped' }
      ]}
    ]
  },

  // Heat transfer
  'heat-exchanger': {
    displayName: 'Heat Exchanger',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Heat Exchanger' },
      { name: 'hxType', type: 'select', label: 'Type', default: 'utube', options: [
        { value: 'utube', label: 'U-Tube' },
        { value: 'straight', label: 'Straight Tube' },
        { value: 'helical', label: 'Helical Coil' }
      ]},
      { name: 'orientation', type: 'select', label: 'Orientation', default: 'vertical', options: [
        { value: 'vertical', label: 'Vertical' },
        { value: 'horizontal', label: 'Horizontal' }
      ]},
      { name: 'elevation', type: 'number', label: 'Elevation (Bottom)', default: 2, min: -10, max: 50, step: 0.5, unit: 'm', help: 'Height above ground level' },
      { name: 'shellDiameter', type: 'number', label: 'Shell Diameter', default: 2.5, min: 0.5, max: 10, step: 0.1, unit: 'm' },
      { name: 'shellLength', type: 'number', label: 'Shell Length', default: 8, min: 1, max: 25, step: 0.5, unit: 'm' },
      { name: 'tubeCount', type: 'number', label: 'Number of Tubes', default: 3000, min: 10, max: 20000, step: 100 },
      { name: 'tubeOD', type: 'number', label: 'Tube Outer Diameter', default: 19, min: 6, max: 50, step: 1, unit: 'mm' },
      { name: 'tubeThickness', type: 'number', label: 'Tube Wall Thickness', default: 1.2, min: 0.5, max: 5, step: 0.1, unit: 'mm' },
      { name: 'tubePressure', type: 'number', label: 'Tube-Side Pressure', default: 150, min: 1, max: 300, step: 10, unit: 'bar' },
      { name: 'shellPressure', type: 'number', label: 'Shell-Side Pressure', default: 60, min: 1, max: 100, step: 5, unit: 'bar' },
      // Calculated fields - displayed but not editable
      { name: 'heatTransferArea', type: 'calculated', label: 'Heat Transfer Area', default: 0, unit: 'm²',
        calculate: (p) => {
          const tubeOD_m = (p.tubeOD || 19) / 1000; // mm to m
          const tubeLength = p.hxType === 'utube' ? (p.shellLength || 8) * 1.8 : (p.shellLength || 8); // U-tubes are ~1.8x shell length
          const area = Math.PI * tubeOD_m * tubeLength * (p.tubeCount || 3000);
          return area.toFixed(0);
        }
      },
      { name: 'tubeSideVolume', type: 'calculated', label: 'Tube-Side Volume', default: 0, unit: 'm³',
        calculate: (p) => {
          const tubeOD_m = (p.tubeOD || 19) / 1000;
          const tubeThickness_m = (p.tubeThickness || 1.2) / 1000;
          const tubeID_m = tubeOD_m - 2 * tubeThickness_m;
          const tubeLength = p.hxType === 'utube' ? (p.shellLength || 8) * 1.8 : (p.shellLength || 8);
          const volume = Math.PI * Math.pow(tubeID_m / 2, 2) * tubeLength * (p.tubeCount || 3000);
          return volume.toFixed(1);
        }
      },
      { name: 'shellSideVolume', type: 'calculated', label: 'Shell-Side Volume', default: 0, unit: 'm³',
        calculate: (p) => {
          const shellDiam = p.shellDiameter || 2.5;
          const shellLen = p.shellLength || 8;
          const tubeOD_m = (p.tubeOD || 19) / 1000;
          const tubeLength = p.hxType === 'utube' ? shellLen * 1.8 : shellLen;
          const shellVolume = Math.PI * Math.pow(shellDiam / 2, 2) * shellLen;
          const tubeDisplacement = Math.PI * Math.pow(tubeOD_m / 2, 2) * tubeLength * (p.tubeCount || 3000);
          const volume = shellVolume - tubeDisplacement;
          return Math.max(0, volume).toFixed(1);
        }
      }
    ]
  },
  'condenser': {
    displayName: 'Condenser',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Condenser' },
      { name: 'elevation', type: 'number', label: 'Elevation (Bottom)', default: 0, min: -10, max: 50, step: 0.5, unit: 'm', help: 'Height above ground level (typically at ground level)' },
      { name: 'volume', type: 'number', label: 'Volume', default: 100, min: 10, max: 1000, step: 10, unit: 'm³' },
      { name: 'height', type: 'number', label: 'Height', default: 3, min: 1, max: 10, step: 0.5, unit: 'm' },
      { name: 'coolingCapacity', type: 'number', label: 'Cooling Capacity', default: 2000, min: 100, max: 5000, step: 100, unit: 'MW' },
      { name: 'operatingPressure', type: 'number', label: 'Operating Pressure', default: 0.05, min: 0.01, max: 1, step: 0.01, unit: 'bar' },
      { name: 'coolingWaterTemp', type: 'number', label: 'Cooling Water Temp', default: 20, min: 5, max: 40, step: 5, unit: '°C' },
      { name: 'coolingWaterFlow', type: 'number', label: 'Cooling Water Flow', default: 50000, min: 1000, max: 100000, step: 1000, unit: 'kg/s' },
      { name: 'includesPump', type: 'checkbox', label: 'Include Condensate Pump', default: true, help: 'Automatically includes a condensate pump' },
      // Calculated fields
      { name: 'width', type: 'calculated', label: 'Width', default: 0, unit: 'm',
        calculate: (p) => {
          // Calculate width from volume and height: V = W * W * H (assuming square footprint)
          const volume = p.volume || 100;
          const height = p.height || 3;
          const width = Math.sqrt(volume / height);
          return width.toFixed(1);
        }
      }
    ]
  },
  'turbine-generator': {
    displayName: 'Turbine-Generator',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Turbine-Generator' },
      { name: 'orientation', type: 'select', label: 'Orientation', default: 'left-right', options: [
        { value: 'left-right', label: 'Inlet Left → Exhaust Right' },
        { value: 'right-left', label: 'Inlet Right → Exhaust Left' }
      ]},
      { name: 'stages', type: 'number', label: 'Number of Stages', default: 3, min: 1, max: 5, step: 1 },
      { name: 'ratedPower', type: 'number', label: 'Rated Power', default: 1000, min: 100, max: 2000, step: 100, unit: 'MW' },
      { name: 'inletPressure', type: 'number', label: 'Inlet Pressure', default: 60, min: 10, max: 100, step: 5, unit: 'bar' },
      { name: 'exhaustPressure', type: 'number', label: 'Exhaust Pressure', default: 0.05, min: 0.01, max: 1, step: 0.01, unit: 'bar' },
      { name: 'turbineEfficiency', type: 'number', label: 'Turbine Isentropic Eff.', default: 85, min: 70, max: 95, step: 5, unit: '%' },
      { name: 'generatorEfficiency', type: 'number', label: 'Generator Efficiency', default: 98, min: 95, max: 99, step: 0.5, unit: '%' },
      { name: 'governorValve', type: 'number', label: 'Governor Valve Position', default: 100, min: 0, max: 100, step: 5, unit: '%' },
      // Calculated fields
      { name: 'ratedSteamFlow', type: 'calculated', label: 'Rated Steam Flow', default: 0, unit: 'kg/s',
        calculate: (p) => {
          // P = m_dot * eta_turbine * eta_gen * delta_h
          const P_in = (p.inletPressure || 60) * 1e5;  // Pa
          const P_out = (p.exhaustPressure || 0.05) * 1e5;  // Pa
          const eta_t = (p.turbineEfficiency || 85) / 100;
          const eta_g = (p.generatorEfficiency || 98) / 100;
          const power = (p.ratedPower || 1000) * 1e6;  // W

          // Approximate enthalpy drop: ~900 kJ/kg for typical 60 bar -> 0.05 bar
          const pressureRatio = P_in / P_out;
          const deltaH = 200000 * Math.log(pressureRatio);  // J/kg

          const steamFlow = power / (eta_t * eta_g * deltaH);
          return steamFlow.toFixed(0);
        }
      },
      { name: 'length', type: 'calculated', label: 'Turbine Length', default: 0, unit: 'm',
        calculate: (p) => {
          // Turbine length scales with power output
          // A single-casing turbine: ~3m minimum, ~13m for 1000 MW
          const power = p.ratedPower || 1000;
          const length = 3 + (power / 500) * 5;  // 3m base + 5m per 500 MW
          return length.toFixed(1);
        }
      },
      { name: 'diameter', type: 'calculated', label: 'Exhaust Diameter', default: 0, unit: 'm',
        calculate: (p) => {
          // Exhaust end diameter scales with steam flow (and thus power)
          // LP turbine casing diameter: ~1.5m minimum, ~3.5m for 1000 MW
          const power = p.ratedPower || 1000;
          const diameter = 1.5 + (power / 1000) * 2;  // 1.5m base + 2m per GW
          return diameter.toFixed(1);
        }
      }
    ]
  },
  'turbine-driven-pump': {
    displayName: 'Turbine-Driven Pump',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'TD Pump' },
      { name: 'orientation', type: 'select', label: 'Orientation', default: 'left-right', options: [
        { value: 'left-right', label: 'Steam Left → Pump Right' },
        { value: 'right-left', label: 'Steam Right → Pump Left' }
      ]},
      { name: 'stages', type: 'number', label: 'Turbine Stages', default: 1, min: 1, max: 3, step: 1 },
      // Pump properties
      { name: 'ratedPumpFlow', type: 'number', label: 'Rated Pump Flow', default: 50, min: 10, max: 500, step: 10, unit: 'kg/s' },
      { name: 'ratedHead', type: 'number', label: 'Rated Head', default: 500, min: 50, max: 2000, step: 50, unit: 'm' },
      { name: 'pumpEfficiency', type: 'number', label: 'Pump Efficiency', default: 75, min: 50, max: 90, step: 5, unit: '%' },
      // Turbine properties
      { name: 'inletPressure', type: 'number', label: 'Steam Inlet Pressure', default: 60, min: 5, max: 100, step: 5, unit: 'bar' },
      { name: 'exhaustPressure', type: 'number', label: 'Exhaust Pressure', default: 1, min: 0.1, max: 10, step: 0.1, unit: 'bar', help: 'Exhaust to feedwater heater or condenser' },
      { name: 'turbineEfficiency', type: 'number', label: 'Turbine Efficiency', default: 70, min: 50, max: 85, step: 5, unit: '%' },
      { name: 'governorValve', type: 'number', label: 'Governor Valve Position', default: 100, min: 0, max: 100, step: 5, unit: '%' },
      // Calculated fields
      { name: 'shaftPower', type: 'calculated', label: 'Required Shaft Power', default: 0, unit: 'kW',
        calculate: (p) => {
          // Pump power = rho * g * Q * H / eta
          const rho = 1000;  // kg/m³ (water)
          const g = 9.81;
          const Q = (p.ratedPumpFlow || 50) / rho;  // m³/s
          const H = p.ratedHead || 500;
          const eta = (p.pumpEfficiency || 75) / 100;
          const power = rho * g * Q * H / eta;
          return (power / 1000).toFixed(0);  // kW
        }
      },
      { name: 'ratedSteamFlow', type: 'calculated', label: 'Required Steam Flow', default: 0, unit: 'kg/s',
        calculate: (p) => {
          // Calculate pump shaft power
          const rho = 1000;
          const g = 9.81;
          const Q = (p.ratedPumpFlow || 50) / rho;
          const H = p.ratedHead || 500;
          const eta_p = (p.pumpEfficiency || 75) / 100;
          const shaftPower = rho * g * Q * H / eta_p;

          // Calculate steam flow needed
          const P_in = (p.inletPressure || 60) * 1e5;
          const P_out = (p.exhaustPressure || 1) * 1e5;
          const eta_t = (p.turbineEfficiency || 70) / 100;
          const pressureRatio = P_in / P_out;
          const deltaH = 200000 * Math.log(pressureRatio);  // J/kg

          const steamFlow = shaftPower / (eta_t * deltaH);
          return steamFlow.toFixed(1);
        }
      },
      { name: 'length', type: 'calculated', label: 'Assembly Length', default: 0, unit: 'm',
        calculate: (p) => {
          // Small turbine-pump assemblies are compact
          // TDAFW/RCIC units are typically 2-4m long
          const pumpFlow = p.ratedPumpFlow || 50;
          const length = 2 + (pumpFlow / 100) * 1.5;  // 2m base + 1.5m per 100 kg/s
          return length.toFixed(1);
        }
      },
      { name: 'diameter', type: 'calculated', label: 'Diameter', default: 0, unit: 'm',
        calculate: (p) => {
          // Small auxiliary turbines are ~0.5-1m diameter
          const pumpFlow = p.ratedPumpFlow || 50;
          const diameter = 0.5 + (pumpFlow / 200) * 0.5;  // 0.5m base + 0.5m per 200 kg/s
          return diameter.toFixed(1);
        }
      }
    ]
  },

  // Core
  'core': {
    displayName: 'Reactor Core',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Core' },
      { name: 'height', type: 'number', label: 'Active Height', default: 3.66, min: 1, max: 6, step: 0.1, unit: 'm', help: 'Height of the active fuel region' },
      { name: 'diameter', type: 'number', label: 'Core Diameter', default: 3.2, min: 1, max: 6, step: 0.1, unit: 'm' },
      { name: 'rodDiameter', type: 'number', label: 'Fuel Rod Diameter', default: 9.5, min: 5, max: 15, step: 0.5, unit: 'mm' },
      { name: 'rodPitch', type: 'number', label: 'Rod Pitch', default: 12.6, min: 8, max: 20, step: 0.5, unit: 'mm', help: 'Center-to-center spacing between rods' },
      { name: 'controlRodBanks', type: 'number', label: 'Control Rod Banks', default: 4, min: 1, max: 10, step: 1, help: 'Number of control rod banks (displayed as individual rods)' },
      { name: 'thermalPower', type: 'number', label: 'Thermal Power', default: 3000, min: 100, max: 5000, step: 100, unit: 'MWt' },
      { name: 'initialRodPosition', type: 'number', label: 'Initial Rod Position', default: 50, min: 0, max: 100, step: 5, unit: '%', help: '0% = fully inserted, 100% = fully withdrawn' },
      // Calculated fields
      { name: 'fuelRodCount', type: 'calculated', label: 'Fuel Rods (approx)', default: 0,
        calculate: (p) => {
          const coreDiam = (p.diameter || 3.37) * 1000; // m to mm
          const pitch = p.rodPitch || 12.6; // mm
          const coreArea = Math.PI * Math.pow(coreDiam / 2, 2); // mm²
          const rodsPerArea = 1 / (pitch * pitch); // rods per mm²
          const rodCount = Math.floor(coreArea * rodsPerArea * 0.9); // 90% packing efficiency
          return rodCount.toLocaleString();
        }
      }
    ]
  }
};

export class ComponentDialog {
  private dialog: HTMLElement;
  private titleElement: HTMLElement;
  private bodyElement: HTMLElement;
  private confirmButton: HTMLElement;
  private cancelButton: HTMLElement;
  private closeButton: HTMLElement;
  private currentCallback: ((config: ComponentConfig | null) => void) | null = null;
  private currentType: string = '';
  private currentPosition: { x: number; y: number } = { x: 0, y: 0 };

  constructor() {
    this.dialog = document.getElementById('component-dialog')!;
    this.titleElement = document.getElementById('dialog-title')!;
    this.bodyElement = document.getElementById('dialog-body')!;
    this.confirmButton = document.getElementById('dialog-confirm')!;
    this.cancelButton = document.getElementById('dialog-cancel')!;
    this.closeButton = this.dialog.querySelector('.dialog-close')!;

    // Set up event handlers
    this.confirmButton.addEventListener('click', () => this.handleConfirm());
    this.cancelButton.addEventListener('click', () => this.handleCancel());
    this.closeButton.addEventListener('click', () => this.handleCancel());

    // Close on background click
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) {
        this.handleCancel();
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.dialog.style.display !== 'none') {
        this.handleCancel();
      }
    });
  }

  show(componentType: string, position: { x: number; y: number }, callback: (config: ComponentConfig | null) => void) {
    const definition = componentDefinitions[componentType];
    if (!definition) {
      console.error(`Unknown component type: ${componentType}`);
      callback(null);
      return;
    }

    this.currentType = componentType;
    this.currentPosition = position;
    this.currentCallback = callback;

    // Set title
    this.titleElement.textContent = `Configure ${definition.displayName}`;

    // Build form
    this.buildForm(definition.options);

    // Show dialog
    this.dialog.style.display = 'flex';

    // Focus first input
    const firstInput = this.bodyElement.querySelector('input, select') as HTMLElement;
    if (firstInput) {
      firstInput.focus();
    }
  }

  private buildForm(options: ComponentOption[]) {
    this.bodyElement.innerHTML = '';

    // Separate calculated options from input options
    const inputOptions = options.filter(o => o.type !== 'calculated');
    const calculatedOptions = options.filter(o => o.type === 'calculated');

    // Add price estimate at the top
    const priceGroup = document.createElement('div');
    priceGroup.className = 'form-group';
    priceGroup.style.cssText = 'background: #2a2e38; padding: 10px; border-radius: 4px; margin-bottom: 15px;';

    const priceLabel = document.createElement('div');
    priceLabel.style.cssText = 'color: #7af; font-size: 12px; margin-bottom: 5px;';
    priceLabel.textContent = 'Estimated Cost';

    const priceValue = document.createElement('div');
    priceValue.id = 'price-estimate';
    priceValue.style.cssText = 'font-size: 20px; font-weight: bold; color: #4a4;';
    priceValue.textContent = '$0'; // Will be updated dynamically

    const priceNote = document.createElement('div');
    priceNote.style.cssText = 'font-size: 11px; color: #667788; margin-top: 5px;';
    priceNote.textContent = 'Price calculation coming soon';

    priceGroup.appendChild(priceLabel);
    priceGroup.appendChild(priceValue);
    priceGroup.appendChild(priceNote);
    this.bodyElement.appendChild(priceGroup);

    // Add separator
    const separator = document.createElement('hr');
    separator.style.cssText = 'border: none; border-top: 1px solid #445566; margin: 15px 0;';
    this.bodyElement.appendChild(separator);

    // Create two-column layout if there are calculated fields
    let inputContainer: HTMLElement = this.bodyElement;
    let calculatedContainer: HTMLElement | null = null;

    if (calculatedOptions.length > 0) {
      const columnsWrapper = document.createElement('div');
      columnsWrapper.style.cssText = 'display: flex; gap: 20px;';

      inputContainer = document.createElement('div');
      inputContainer.style.cssText = 'flex: 1; min-width: 0;';

      calculatedContainer = document.createElement('div');
      calculatedContainer.style.cssText = 'width: 180px; flex-shrink: 0; background: #1a1e28; padding: 12px; border-radius: 6px; border: 1px solid #334;';

      const calcTitle = document.createElement('div');
      calcTitle.style.cssText = 'color: #8af; font-size: 11px; font-weight: bold; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px;';
      calcTitle.textContent = 'Calculated';
      calculatedContainer.appendChild(calcTitle);

      columnsWrapper.appendChild(inputContainer);
      columnsWrapper.appendChild(calculatedContainer);
      this.bodyElement.appendChild(columnsWrapper);
    }

    // Build input fields
    inputOptions.forEach(option => {
      const formGroup = document.createElement('div');
      formGroup.className = 'form-group';

      const label = document.createElement('label');
      label.textContent = option.label + (option.unit ? ` (${option.unit})` : '');
      label.setAttribute('for', `option-${option.name}`);
      formGroup.appendChild(label);

      let input: HTMLInputElement | HTMLSelectElement;

      switch (option.type) {
        case 'select':
          input = document.createElement('select');
          input.id = `option-${option.name}`;
          input.name = option.name;

          if (option.options) {
            option.options.forEach(opt => {
              const optionElement = document.createElement('option');
              optionElement.value = String(opt.value);
              optionElement.textContent = opt.label;
              if (opt.value === option.default) {
                optionElement.selected = true;
              }
              input.appendChild(optionElement);
            });
          }
          break;

        case 'checkbox':
          input = document.createElement('input');
          input.type = 'checkbox';
          input.id = `option-${option.name}`;
          input.name = option.name;
          (input as HTMLInputElement).checked = option.default;
          break;

        case 'number':
          input = document.createElement('input');
          input.type = 'number';
          input.id = `option-${option.name}`;
          input.name = option.name;
          input.value = String(option.default);

          if (option.min !== undefined) input.min = String(option.min);
          if (option.max !== undefined) input.max = String(option.max);
          if (option.step !== undefined) input.step = String(option.step);
          break;

        default: // text
          input = document.createElement('input');
          input.type = 'text';
          input.id = `option-${option.name}`;
          input.name = option.name;
          input.value = option.default;
      }

      formGroup.appendChild(input);

      if (option.help) {
        const helpText = document.createElement('div');
        helpText.className = 'help-text';
        helpText.textContent = option.help;
        formGroup.appendChild(helpText);
      }

      inputContainer.appendChild(formGroup);
    });

    // Build calculated fields in right column
    if (calculatedContainer && calculatedOptions.length > 0) {
      calculatedOptions.forEach(option => {
        const calcGroup = document.createElement('div');
        calcGroup.style.cssText = 'margin-bottom: 12px;';

        const calcLabel = document.createElement('div');
        calcLabel.style.cssText = 'color: #889; font-size: 10px; margin-bottom: 2px;';
        calcLabel.textContent = option.label;
        calcGroup.appendChild(calcLabel);

        const calcValue = document.createElement('div');
        calcValue.id = `option-${option.name}`;
        calcValue.style.cssText = 'color: #8cf; font-size: 16px; font-weight: bold;';
        calcValue.textContent = '—';
        calcGroup.appendChild(calcValue);

        if (option.unit) {
          const calcUnit = document.createElement('span');
          calcUnit.style.cssText = 'color: #667; font-size: 11px; font-weight: normal; margin-left: 4px;';
          calcUnit.textContent = option.unit;
          calcValue.appendChild(calcUnit);
        }

        calculatedContainer.appendChild(calcGroup);
      });
    }

    // Function to update calculated fields
    const updateCalculatedFields = () => {
      const props = this.getCurrentProperties(options);
      calculatedOptions.forEach(calcOption => {
        if (calcOption.calculate) {
          const display = document.getElementById(`option-${calcOption.name}`);
          if (display) {
            const value = calcOption.calculate(props);
            // Preserve the unit span if it exists
            const unitSpan = display.querySelector('span');
            display.textContent = value;
            if (unitSpan) {
              display.appendChild(unitSpan);
            } else if (calcOption.unit) {
              const newUnit = document.createElement('span');
              newUnit.style.cssText = 'color: #667; font-size: 11px; font-weight: normal; margin-left: 4px;';
              newUnit.textContent = calcOption.unit;
              display.appendChild(newUnit);
            }
          }
        }
      });
    };

    // Add event listeners to all inputs to update calculated fields
    if (calculatedOptions.length > 0) {
      const inputs = inputContainer.querySelectorAll('input, select');
      inputs.forEach(input => {
        input.addEventListener('input', updateCalculatedFields);
        input.addEventListener('change', updateCalculatedFields);
      });

      // Initial calculation
      updateCalculatedFields();
    }
  }

  private getCurrentProperties(options: ComponentOption[]): Record<string, any> {
    const props: Record<string, any> = {};
    options.forEach(option => {
      if (option.type === 'calculated') return;
      const element = document.getElementById(`option-${option.name}`) as HTMLInputElement | HTMLSelectElement;
      if (!element) return;

      if (element.type === 'checkbox') {
        props[option.name] = (element as HTMLInputElement).checked;
      } else if (element.type === 'number') {
        props[option.name] = parseFloat(element.value) || option.default;
      } else {
        props[option.name] = element.value;
      }
    });
    return props;
  }

  private handleConfirm() {
    const inputs = this.bodyElement.querySelectorAll('input, select');
    const properties: Record<string, any> = {};

    inputs.forEach((input: Element) => {
      const element = input as HTMLInputElement | HTMLSelectElement;
      const name = element.name;

      if (element.type === 'checkbox') {
        properties[name] = (element as HTMLInputElement).checked;
      } else if (element.type === 'number') {
        properties[name] = parseFloat(element.value);
      } else {
        properties[name] = element.value;
      }
    });

    const config: ComponentConfig = {
      type: this.currentType,
      name: properties.name || componentDefinitions[this.currentType].displayName,
      position: this.currentPosition,
      properties
    };

    this.dialog.style.display = 'none';

    if (this.currentCallback) {
      this.currentCallback(config);
      this.currentCallback = null;
    }
  }

  private handleCancel() {
    this.dialog.style.display = 'none';

    if (this.currentCallback) {
      this.currentCallback(null);
      this.currentCallback = null;
    }
  }

  /**
   * Show the dialog for editing an existing component
   */
  showEdit(
    component: Record<string, any>,
    callback: (properties: Record<string, any> | null) => void
  ) {
    const componentType = this.mapComponentTypeToDefinition(component.type, component);
    const definition = componentDefinitions[componentType];
    if (!definition) {
      console.error(`Unknown component type for editing: ${component.type}`);
      callback(null);
      return;
    }

    this.currentType = componentType;
    this.currentPosition = component.position || { x: 0, y: 0 };
    this.currentCallback = (config) => {
      if (config) {
        callback(config.properties);
      } else {
        callback(null);
      }
    };

    // Set title
    this.titleElement.textContent = `Edit ${component.label || definition.displayName}`;

    // Build form with existing values
    this.buildFormWithValues(definition.options, component);

    // Show dialog
    this.dialog.style.display = 'flex';

    // Focus first input
    const firstInput = this.bodyElement.querySelector('input, select') as HTMLElement;
    if (firstInput) {
      firstInput.focus();
    }
  }

  /**
   * Map component type from PlantComponent to definition key
   * For vessels, detect if it's a core (has fuelRodCount) vs pressurizer
   */
  private mapComponentTypeToDefinition(type: string, component?: Record<string, any>): string {
    // Special case: vessel can be either pressurizer or core
    if (type === 'vessel' && component) {
      // If it has fuelRodCount or controlRodCount, it's a core
      if (component.fuelRodCount !== undefined || component.controlRodCount !== undefined) {
        return 'core';
      }
      return 'pressurizer';
    }

    const mapping: Record<string, string> = {
      'tank': 'tank',
      'vessel': 'pressurizer',
      'reactorVessel': 'reactor-vessel',
      'pipe': 'pipe',
      'valve': 'valve',
      'pump': 'pump',
      'heatExchanger': 'heat-exchanger',
      'condenser': 'condenser',
      'turbine-generator': 'turbine-generator',
      'turbine-driven-pump': 'turbine-driven-pump',
      'fuelAssembly': 'core'
    };
    return mapping[type] || type;
  }

  /**
   * Build form with existing component values
   */
  private buildFormWithValues(options: ComponentOption[], component: Record<string, any>) {
    this.bodyElement.innerHTML = '';

    // Separate calculated options from input options
    const inputOptions = options.filter(o => o.type !== 'calculated');
    const calculatedOptions = options.filter(o => o.type === 'calculated');

    // Skip price estimate for editing
    const separator = document.createElement('hr');
    separator.style.cssText = 'border: none; border-top: 1px solid #445566; margin: 15px 0;';
    this.bodyElement.appendChild(separator);

    // Create two-column layout if there are calculated fields
    let inputContainer: HTMLElement = this.bodyElement;
    let calculatedContainer: HTMLElement | null = null;

    if (calculatedOptions.length > 0) {
      const columnsWrapper = document.createElement('div');
      columnsWrapper.style.cssText = 'display: flex; gap: 20px;';

      inputContainer = document.createElement('div');
      inputContainer.style.cssText = 'flex: 1; min-width: 0;';

      calculatedContainer = document.createElement('div');
      calculatedContainer.style.cssText = 'width: 180px; flex-shrink: 0; background: #1a1e28; padding: 12px; border-radius: 6px; border: 1px solid #334;';

      const calcTitle = document.createElement('div');
      calcTitle.style.cssText = 'color: #8af; font-size: 11px; font-weight: bold; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px;';
      calcTitle.textContent = 'Calculated';
      calculatedContainer.appendChild(calcTitle);

      columnsWrapper.appendChild(inputContainer);
      columnsWrapper.appendChild(calculatedContainer);
      this.bodyElement.appendChild(columnsWrapper);
    }

    // Build input fields with existing values
    inputOptions.forEach(option => {
      const formGroup = document.createElement('div');
      formGroup.className = 'form-group';

      const label = document.createElement('label');
      label.textContent = option.label + (option.unit ? ` (${option.unit})` : '');
      label.setAttribute('for', `option-${option.name}`);
      formGroup.appendChild(label);

      // Get existing value from component
      let existingValue = this.getExistingValue(option.name, component, option.default);

      let input: HTMLInputElement | HTMLSelectElement;

      switch (option.type) {
        case 'select':
          input = document.createElement('select');
          input.id = `option-${option.name}`;
          input.name = option.name;

          if (option.options) {
            option.options.forEach(opt => {
              const optionElement = document.createElement('option');
              optionElement.value = String(opt.value);
              optionElement.textContent = opt.label;
              if (opt.value === existingValue || String(opt.value) === String(existingValue)) {
                optionElement.selected = true;
              }
              input.appendChild(optionElement);
            });
          }
          break;

        case 'checkbox':
          input = document.createElement('input');
          input.type = 'checkbox';
          input.id = `option-${option.name}`;
          input.name = option.name;
          (input as HTMLInputElement).checked = !!existingValue;
          break;

        case 'number':
          input = document.createElement('input');
          input.type = 'number';
          input.id = `option-${option.name}`;
          input.name = option.name;
          input.value = String(existingValue);

          if (option.min !== undefined) input.min = String(option.min);
          if (option.max !== undefined) input.max = String(option.max);
          if (option.step !== undefined) input.step = String(option.step);
          break;

        default: // text
          input = document.createElement('input');
          input.type = 'text';
          input.id = `option-${option.name}`;
          input.name = option.name;
          input.value = String(existingValue);
      }

      formGroup.appendChild(input);

      if (option.help) {
        const helpText = document.createElement('div');
        helpText.className = 'help-text';
        helpText.textContent = option.help;
        formGroup.appendChild(helpText);
      }

      inputContainer.appendChild(formGroup);
    });

    // Build calculated fields (same as buildForm)
    if (calculatedContainer && calculatedOptions.length > 0) {
      calculatedOptions.forEach(option => {
        const calcGroup = document.createElement('div');
        calcGroup.style.cssText = 'margin-bottom: 12px;';

        const calcLabel = document.createElement('div');
        calcLabel.style.cssText = 'color: #889; font-size: 10px; margin-bottom: 2px;';
        calcLabel.textContent = option.label;
        calcGroup.appendChild(calcLabel);

        const calcValue = document.createElement('div');
        calcValue.id = `option-${option.name}`;
        calcValue.style.cssText = 'color: #8cf; font-size: 16px; font-weight: bold;';
        calcValue.textContent = '—';
        calcGroup.appendChild(calcValue);

        if (option.unit) {
          const calcUnit = document.createElement('span');
          calcUnit.style.cssText = 'color: #667; font-size: 11px; font-weight: normal; margin-left: 4px;';
          calcUnit.textContent = option.unit;
          calcValue.appendChild(calcUnit);
        }

        calculatedContainer.appendChild(calcGroup);
      });

      // Function to update calculated fields
      const updateCalculatedFields = () => {
        const props = this.getCurrentProperties(options);
        calculatedOptions.forEach(calcOption => {
          if (calcOption.calculate) {
            const display = document.getElementById(`option-${calcOption.name}`);
            if (display) {
              const value = calcOption.calculate(props);
              const unitSpan = display.querySelector('span');
              display.textContent = value;
              if (unitSpan) {
                display.appendChild(unitSpan);
              } else if (calcOption.unit) {
                const newUnit = document.createElement('span');
                newUnit.style.cssText = 'color: #667; font-size: 11px; font-weight: normal; margin-left: 4px;';
                newUnit.textContent = calcOption.unit;
                display.appendChild(newUnit);
              }
            }
          }
        });
      };

      // Add event listeners
      const inputs = inputContainer.querySelectorAll('input, select');
      inputs.forEach(input => {
        input.addEventListener('input', updateCalculatedFields);
        input.addEventListener('change', updateCalculatedFields);
      });

      // Initial calculation
      updateCalculatedFields();
    }
  }

  /**
   * Get existing value from component, handling property name mapping
   */
  private getExistingValue(optionName: string, component: Record<string, any>, defaultValue: any): any {
    // Direct property match
    if (component[optionName] !== undefined) {
      return component[optionName];
    }

    // Map option names to component properties
    const propertyMappings: Record<string, string[]> = {
      'name': ['label'],
      'type': ['valveType', 'hxType', 'pumpType'],
      'initialPosition': ['opening'],
      'initialState': ['running'],
      'initialPressure': ['fluid.pressure'],
      'initialTemperature': ['fluid.temperature'],
      'initialLevel': ['fillLevel'],
      'ratedFlow': ['ratedFlow'],
      'ratedHead': ['ratedHead'],
      'volume': ['volume'],
      'shellDiameter': ['width'],
      'shellLength': ['height'],
      // Core-specific mappings
      'diameter': ['innerDiameter'],
      'controlRodBanks': ['controlRodCount'],
      'initialRodPosition': ['controlRodPosition'],
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
            if (prop === 'fluid.temperature') return (value as unknown as number) - 273; // K to C
            return value;
          }
        } else if (component[prop] !== undefined) {
          // Handle special conversions
          if (prop === 'opening') return component[prop] * 100; // 0-1 to %
          if (prop === 'running') return component[prop] ? 'on' : 'off';
          if (prop === 'fillLevel') return component[prop] * 100; // 0-1 to %
          if (prop === 'controlRodPosition') return (1 - component[prop]) * 100; // Inverted: 0=fully inserted, 1=withdrawn -> 0%=inserted, 100%=withdrawn
          return component[prop];
        }
      }
    }

    return defaultValue;
  }
}