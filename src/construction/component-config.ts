// Component configuration definitions and dialog system

import { saturationTemperature, saturationPressure } from '../simulation/water-properties';
import { estimateComponentCost, formatCost } from './cost-estimation';
import { ALL_GAS_SPECIES, GAS_PROPERTIES, type GasSpecies } from '../simulation/gas-properties';
import { deriveControlRodWorth, type LatticeParams } from '../simulation/lattice';
import { corePebbleGeometry } from '../simulation/factory';
import {
  ComponentPreset,
  getPresetsForType,
  hasPresetSupport,
  saveCustomPreset,
  deleteCustomPreset
} from './component-presets';
import { readComponentOption, mapComponentTypeToDefinition } from './component-properties';

// Minimum steam pressure to keep water above freezing (at 1°C = 274.15 K)
const MIN_STEAM_PRESSURE_PA = saturationPressure(274.15); // ~657 Pa
const MIN_STEAM_PRESSURE_BAR = MIN_STEAM_PRESSURE_PA / 1e5; // ~0.00657 bar

/**
 * Lattice params from the core dialog's current values, for the estimated
 * rod-worth readout. Uses nominal hot conditions (700 kg/m³ water for rod
 * lattices, trace steam for pebble beds, 900 K fuel) - the simulation
 * anchors at the actual initial plant state, so this is a design-time
 * estimate, not the exact in-game number.
 */
function dialogLatticeParams(p: Record<string, any>): LatticeParams {
  const isPebbleBed = p.fuelForm === 'pebbles';
  const coreDiameter = p.diameter || 3.2;
  const height = p.height || 3.66;
  if (isPebbleBed) {
    const geo = corePebbleGeometry({
      pebbleDiameter: p.pebbleDiameter ?? 60,
      pebbleCount: p.pebbleCount ?? 400000,
      heavyMetalPerPebble: p.heavyMetalPerPebble ?? 7,
      activeFuelHeight: height,
    } as any);
    return {
      enrichment: (p.enrichmentPct ?? 8.5) / 100,
      fuelMaterial: 'UO2',
      rodDiameter: geo.pebbleDiameter,
      rodCount: geo.pebbleCount,
      coreDiameter,
      activeHeight: height,
      refModeratorDensity: 0.05,
      refFuelTemp: 900,
      fuelVolume: geo.fuelVolume,
      dopplerLengthScale: 0.0005,
      solidModeratorVolume: geo.solidModeratorVolume,
      reflectorThickness: p.reflectorThickness ?? 0.8,
    };
  }
  const pitch = (p.rodPitch || 12.6) / 1000;
  const coreArea = Math.PI * Math.pow(coreDiameter / 2, 2);
  const rodCount = Math.floor(coreArea / (pitch * pitch) * 0.9);
  return {
    enrichment: (p.enrichmentPct ?? 5) / 100,
    fuelMaterial: p.fuelMaterial || 'UO2',
    rodDiameter: (p.rodDiameter || 9.5) / 1000,
    rodCount,
    coreDiameter,
    activeHeight: height,
    refModeratorDensity: 700,
    refFuelTemp: 900,
    reflectorThickness: 0,
  };
}

export interface ComponentConfig {
  type: string;
  name: string;
  position: { x: number; y: number };
  properties: Record<string, any>;
  containedBy?: string;  // ID of container component (tank, vessel, containment building)
}

/**
 * NCG (Non-Condensible Gas) initial condition.
 * Stored as partial pressures in bar for user-friendly input.
 */
export interface NcgInitialCondition {
  N2?: number;   // bar partial pressure
  O2?: number;
  H2?: number;
  He?: number;
  CO?: number;
  CO2?: number;
  Xe?: number;
  Ar?: number;
  CsI?: number;  // fission-product aerosol - transport product, not a fill gas
}

/** Display names for gas species */
const GAS_DISPLAY_NAMES: Record<GasSpecies, string> = {
  N2: 'Nitrogen (N₂)',
  O2: 'Oxygen (O₂)',
  H2: 'Hydrogen (H₂)',
  He: 'Helium (He)',
  CO: 'Carbon Monoxide (CO)',
  CO2: 'Carbon Dioxide (CO₂)',
  Xe: 'Xenon (Xe)',
  Ar: 'Argon (Ar)',
  CsI: 'Cesium Iodide (CsI, fission products)',
};

export interface ComponentOption {
  name: string;
  type: 'number' | 'text' | 'select' | 'checkbox' | 'calculated' | 'ncg';
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
  // For conditional visibility: show/hide based on another field's value
  // (value may be an array: show when the field matches ANY entry)
  dependsOn?: { field: string; value: any | any[] };
  // For selects populated at dialog-open time from the current plant
  // (key into the dynamicChoices map passed via setDynamicChoices)
  dynamicOptions?: string;
  // Excluded from the dialog<->model round-trip audit: the model legitimately
  // recomputes this field from other inputs (document why at each use)
  syncExempt?: boolean;
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
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: false },
      { name: 'elevation', type: 'number', label: 'Elevation (Bottom)', default: 0, min: -50, max: 100, step: 0.5, unit: 'm', help: 'Height of tank bottom above ground level' },
      { name: 'volume', type: 'number', label: 'Volume', default: 10, min: 0.1, max: 5000, step: 0.1, unit: 'm³', help: 'Coupled to diameter: editing either one recalculates the other from the height' },
      { name: 'diameter', type: 'number', label: 'Diameter', default: 1.78, min: 0.05, max: 60, step: 0.05, unit: 'm', help: 'Inner diameter of the cylindrical tank. Coupled to volume: editing either one recalculates the other from the height.' },
      { name: 'height', type: 'number', label: 'Height', default: 4, min: 0.5, max: 50, step: 0.5, unit: 'm', help: 'Changing height keeps the volume and recalculates the diameter' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 200, min: 0.1, max: 600, step: 10, unit: 'bar', help: 'Must be at least enough to hold the hydrostatic head of water' },
      { name: 'initialLevel', type: 'number', label: 'Initial Water Level', default: 50, min: 0, max: 100, step: 5, unit: '%', help: 'For 0-100%, fluid is two-phase at saturation' },
      { name: 'initialPressure', type: 'number', label: 'Steam Pressure', default: 150, min: 0.01, max: 221, step: 1, unit: 'bar', help: 'Steam partial pressure (NCG adds to total). For two-phase, determines saturation temperature.' },
      { name: 'initialTemperature', type: 'number', label: 'Initial Temperature', default: 300, min: 20, max: 374, step: 5, unit: '°C', help: 'For two-phase, calculated from saturation pressure' },
      { name: 'initialNcg', type: 'ncg', label: 'Non-Condensible Gases', default: {}, help: 'Add gases like N₂, O₂, H₂, He to the vapor space' },
      // Calculated fields
      { name: 'minPressureRating', type: 'calculated', label: 'Min Pressure (Hydrostatic)', default: 0, unit: 'bar',
        calculate: (p) => {
          // Hydrostatic pressure: P = ρgh, where ρ = 1000 kg/m³, g = 9.81 m/s²
          const h = p.height || 4;
          const hydrostaticPa = 1000 * 9.81 * h; // Pa
          return (hydrostaticPa / 1e5).toFixed(2); // Convert to bar
        }
      },
      { name: 'wallThickness', type: 'calculated', label: 'Wall Thickness', default: 0, unit: 'mm',
        calculate: (p) => {
          // ASME formula: t = P*R / (S*E - 0.6*P)
          // S = 137 MPa (carbon steel), E = 0.85 (spot radiograph)
          // Use the higher of pressure rating or hydrostatic pressure
          const h = p.height || 4;
          const hydrostaticBar = (1000 * 9.81 * h) / 1e5;
          const effectivePressure = Math.max(p.pressureRating || 200, hydrostaticBar);
          const P = effectivePressure * 1e5; // bar to Pa
          const vol = p.volume || 10;
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
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true },
      { name: 'elevation', type: 'number', label: 'Elevation (Bottom)', default: 10, min: -50, max: 100, step: 0.5, unit: 'm', help: 'Typically elevated above hot leg' },
      { name: 'volume', type: 'number', label: 'Volume', default: 40, min: 5, max: 100, step: 5, unit: 'm³', help: 'Coupled to diameter: editing either one recalculates the other from the height' },
      { name: 'diameter', type: 'number', label: 'Diameter', default: 2.06, min: 0.05, max: 10, step: 0.05, unit: 'm', help: 'Inner diameter of the cylindrical shell. Coupled to volume: editing either one recalculates the other from the height.' },
      { name: 'height', type: 'number', label: 'Height', default: 12, min: 5, max: 20, step: 1, unit: 'm', help: 'Changing height keeps the volume and recalculates the diameter' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 175, min: 0.1, max: 600, step: 5, unit: 'bar', help: 'PWR pressurizers typically run ~172 bar. Anything goes - wall thickness, cost, and the burst point follow the rating you pick.' },
      { name: 'heaterPower', type: 'number', label: 'Heater Power', default: 2, min: 0, max: 10, step: 0.5, unit: 'MW' },
      { name: 'sprayFlow', type: 'number', label: 'Max Spray Flow', default: 50, min: 0, max: 200, step: 10, unit: 'kg/s' },
      { name: 'initialLevel', type: 'number', label: 'Initial Water Level', default: 60, min: 0, max: 100, step: 5, unit: '%', help: 'Pressurizers are always two-phase at saturation' },
      { name: 'initialPressure', type: 'number', label: 'Steam Pressure', default: 155, min: 0.01, max: 221, step: 1, unit: 'bar', help: 'Steam partial pressure (NCG adds to total). Determines saturation temperature.' },
      { name: 'initialTemperature', type: 'number', label: 'Initial Temperature', default: 345, min: 20, max: 374, step: 5, unit: '°C', help: 'Calculated from saturation pressure' },
      { name: 'initialNcg', type: 'ncg', label: 'Non-Condensible Gases', default: {}, help: 'Add gases like N₂, H₂ to the steam space' },
      // Calculated fields
      { name: 'wallThickness', type: 'calculated', label: 'Wall Thickness', default: 0, unit: 'mm',
        calculate: (p) => {
          // ASME formula: t = P*R / (S*E - 0.6*P)
          // S = 172 MPa (SA-533 Grade B Class 1), E = 1.0 (full radiograph)
          const P = (p.pressureRating || 175) * 1e5; // bar to Pa
          const vol = p.volume || 40;
          const h = p.height || 12;
          const R = Math.sqrt(vol / (Math.PI * h)); // Derive radius from volume and height
          const S = 172e6; // Pa
          const E = 1.0;
          const t = P * R / (S * E - 0.6 * P);
          return (t * 1000).toFixed(1); // Convert to mm
        }
      }
    ]
  },
  'reactor-vessel': {
    displayName: 'Reactor Vessel',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Reactor Vessel' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true },
      { name: 'elevation', type: 'number', label: 'Elevation (Bottom)', default: 0, min: -10, max: 50, step: 0.5, unit: 'm' },
      { name: 'innerDiameter', type: 'number', label: 'Vessel Inner Diameter', default: 4.4, min: 2, max: 8, step: 0.1, unit: 'm' },
      { name: 'height', type: 'number', label: 'Vessel Inner Height', default: 12, min: 5, max: 20, step: 0.5, unit: 'm', help: 'Total internal cavity height (including domes)' },
      { name: 'pressureRating', type: 'number', label: 'Design Pressure', default: 175, min: 0.1, max: 600, step: 5, unit: 'bar', help: 'PWR vessels typically run 160-175 bar, BWRs ~85. Anything goes - wall thickness, cost, and the burst point follow the rating you pick.' },
      { name: 'barrelDiameter', type: 'number', label: 'Core Barrel Dia (mid-wall)', default: 3.4, min: 1.5, max: 6, step: 0.1, unit: 'm', help: 'Diameter to center of barrel wall' },
      { name: 'barrelThickness', type: 'number', label: 'Barrel Wall Thickness', default: 0.05, min: 0.002, max: 0.3, step: 0.01, unit: 'm', help: 'Typical ~0.05 m. Thin barrels are allowed; they just carry less thermal mass and less strength.' },
      { name: 'barrelBottomGap', type: 'number', label: 'Barrel Bottom Gap', default: 1.0, min: 0, max: 3, step: 0.1, unit: 'm', help: 'Distance from lower head to barrel bottom' },
      { name: 'barrelTopGap', type: 'number', label: 'Barrel Top Gap', default: 0, min: 0, max: 8, step: 0.1, unit: 'm', help: 'Distance from upper head to barrel top. Integral (SMR-style) vessels use a tall gap as an internal steam space.' },
      { name: 'initialLevel', type: 'number', label: 'Initial Water Level', default: 100, min: 0, max: 100, step: 5, unit: '%', help: 'For 0-100%, fluid is two-phase at saturation' },
      { name: 'initialPressure', type: 'number', label: 'Steam Pressure', default: 155, min: 0.01, max: 221, step: 5, unit: 'bar', help: 'Steam partial pressure (NCG adds to total). For two-phase, determines saturation temperature.' },
      { name: 'initialTemperature', type: 'number', label: 'Initial Temperature', default: 290, min: 20, max: 374, step: 5, unit: '°C', help: 'For two-phase, calculated from saturation pressure' },
      { name: 'initialNcg', type: 'ncg', label: 'Non-Condensible Gases', default: {}, help: 'Add gases like N₂, H₂ to the vapor space' },
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
          // barrelDiameter is CENTER-LINE diameter (to middle of barrel wall)
          const barrelCenterR = (p.barrelDiameter ?? 3.4) / 2;
          const barrelThickness = p.barrelThickness ?? 0.05;
          const barrelOuterR = barrelCenterR + barrelThickness / 2;
          const barrelInnerR = barrelCenterR - barrelThickness / 2;
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
          // barrelDiameter is CENTER-LINE diameter (to middle of barrel wall)
          const barrelCenterR = (p.barrelDiameter ?? 3.4) / 2;
          const barrelThickness = p.barrelThickness ?? 0.05;
          const barrelOuterR = barrelCenterR + barrelThickness / 2;
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
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: false },
      // syncExempt: the model recomputes length from the endpoint positions,
      // so a typed length is only a request, not the stored value
      { name: 'length', type: 'number', label: 'Length', default: 10, min: 1, max: 100, step: 1, unit: 'm', help: 'Calculated from endpoint positions when editing', syncExempt: true },
      { name: 'diameter', type: 'number', label: 'Diameter', default: 0.5, min: 0.05, max: 2, step: 0.05, unit: 'm' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 155, min: 1, max: 300, step: 5, unit: 'bar' },
      // Start endpoint (inlet)
      { name: 'startX', type: 'number', label: 'Start X', default: 0, min: -200, max: 200, step: 0.5, unit: 'm', help: 'World X position of inlet end' },
      { name: 'startY', type: 'number', label: 'Start Y', default: 0, min: -200, max: 200, step: 0.5, unit: 'm', help: 'World Y position of inlet end' },
      { name: 'elevation', type: 'number', label: 'Start Elevation', default: 0, min: -20, max: 100, step: 0.5, unit: 'm', help: 'Height of inlet end above ground' },
      // End endpoint (outlet)
      { name: 'endX', type: 'number', label: 'End X', default: 10, min: -200, max: 200, step: 0.5, unit: 'm', help: 'World X position of outlet end' },
      { name: 'endY', type: 'number', label: 'End Y', default: 0, min: -200, max: 200, step: 0.5, unit: 'm', help: 'World Y position of outlet end' },
      { name: 'endElevation', type: 'number', label: 'End Elevation', default: 0, min: -20, max: 100, step: 0.5, unit: 'm', help: 'Height of outlet end above ground' },
      { name: 'roughness', type: 'number', label: 'Roughness', default: 0.0001, min: 0.00001, max: 0.01, step: 0.00001, unit: 'm' },
      { name: 'initialPhase', type: 'select', label: 'Initial Phase', default: 'liquid', options: [
        { value: 'liquid', label: 'Subcooled Liquid' },
        { value: 'two-phase', label: 'Two-Phase (Saturated)' },
        { value: 'vapor', label: 'Superheated Vapor' }
      ], help: 'Fluid phase at start of simulation' },
      { name: 'initialPressure', type: 'number', label: 'Steam Pressure', default: 150, min: 0.01, max: 221, step: 1, unit: 'bar', help: 'Steam partial pressure (NCG adds to total). For two-phase, determines saturation temperature.' },
      { name: 'initialTemperature', type: 'number', label: 'Initial Temperature', default: 290, min: 20, max: 374, step: 5, unit: '°C', help: 'For two-phase, calculated from saturation pressure' },
      { name: 'initialQuality', type: 'number', label: 'Initial Quality', default: 0.5, min: 0, max: 1, step: 0.01, help: 'Mass fraction of vapor (0=sat. liquid, 1=sat. vapor). Only for two-phase.' },
      { name: 'initialNcg', type: 'ncg', label: 'Non-Condensible Gases', default: {}, help: 'Add gases like N₂, H₂ to vapor' },
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
      },
      { name: 'calculatedLength', type: 'calculated', label: 'Actual Length', default: 0, unit: 'm',
        calculate: (p) => {
          // Calculate 3D length from endpoints
          const dx = (p.endX ?? 10) - (p.startX ?? 0);
          const dy = (p.endY ?? 0) - (p.startY ?? 0);
          const dz = (p.endElevation ?? 0) - (p.elevation ?? 0);
          const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
          return len.toFixed(2);
        }
      }
    ]
  },
  'valve': {
    displayName: 'Valve',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Valve' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: false },
      { name: 'type', type: 'select', label: 'Valve Type', default: 'gate', options: [
        { value: 'gate', label: 'Gate Valve' },
        { value: 'globe', label: 'Globe Valve' },
        { value: 'ball', label: 'Ball Valve' },
        { value: 'butterfly', label: 'Butterfly Valve' }
      ]},
      { name: 'diameter', type: 'number', label: 'Diameter', default: 0.3, min: 0.05, max: 2, step: 0.05, unit: 'm' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 155, min: 1, max: 600, step: 5, unit: 'bar', help: 'Body design pressure - the burst point and cost follow the rating you pick. Rate for the highest pressure the valve will see in service.' },
      { name: 'initialPosition', type: 'number', label: 'Initial Position', default: 100, min: 0, max: 100, step: 5, unit: '%', help: '0% = closed, 100% = open' },
      { name: 'matchUpstream', type: 'checkbox', label: 'Match upstream conditions', default: true, help: 'Automatically set initial P/T from connected upstream component' },
      { name: 'initialPressure', type: 'number', label: 'Initial Pressure', default: 10, min: 0.01, max: 250, step: 0.1, unit: 'bar', dependsOn: { field: 'matchUpstream', value: false } },
      { name: 'initialTemperature', type: 'number', label: 'Initial Temperature', default: 50, min: 0, max: 400, step: 1, unit: '°C', dependsOn: { field: 'matchUpstream', value: false } },
      // Cv calculated from diameter and valve type
      // Cv ≈ 29.84 * d² for gate/ball (full bore), less for globe/butterfly
      { name: 'cv', type: 'calculated', label: 'Flow Coefficient (Cv)', default: 0,
        calculate: (p) => {
          const d = p.diameter || 0.3;  // m
          const d_in = d * 39.37;  // Convert to inches for Cv formula
          // Cv = 29.84 * d² for full-bore valves (gate, ball)
          // Reduced for globe (~60%) and butterfly (~80%)
          const typeFactors: Record<string, number> = {
            'gate': 1.0,
            'ball': 1.0,
            'globe': 0.6,
            'butterfly': 0.8
          };
          const factor = typeFactors[p.type as string] || 1.0;
          const cv = 29.84 * d_in * d_in * factor;
          return cv.toFixed(0);
        }
      }
    ]
  },
  'check-valve': {
    displayName: 'Check Valve',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Check Valve' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: false },
      { name: 'type', type: 'select', label: 'Check Valve Type', default: 'swing', options: [
        { value: 'swing', label: 'Swing Check' },
        { value: 'lift', label: 'Lift Check' },
        { value: 'tilting-disc', label: 'Tilting Disc' }
      ]},
      { name: 'diameter', type: 'number', label: 'Diameter', default: 0.3, min: 0.05, max: 2, step: 0.05, unit: 'm' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 155, min: 1, max: 600, step: 5, unit: 'bar', help: 'Body design pressure - the burst point and cost follow the rating you pick. Rate for the highest (usually downstream) pressure the valve holds.' },
      { name: 'crackingPressure', type: 'number', label: 'Cracking Pressure', default: 0.1, min: 0.01, max: 5, step: 0.01, unit: 'bar', help: 'Minimum ΔP to open valve' },
      // Cv calculated from diameter and check valve type
      { name: 'cv', type: 'calculated', label: 'Flow Coefficient (Cv)', default: 0,
        calculate: (p) => {
          const d = p.diameter || 0.3;  // m
          const d_in = d * 39.37;  // Convert to inches
          // Check valves have more restriction than gate valves
          // Swing check ~85%, lift check ~50%, tilting disc ~75%
          const typeFactors: Record<string, number> = {
            'swing': 0.85,
            'lift': 0.50,
            'tilting-disc': 0.75
          };
          const factor = typeFactors[p.type as string] || 0.75;
          const cv = 29.84 * d_in * d_in * factor;
          return cv.toFixed(0);
        }
      }
    ]
  },
  'relief-valve': {
    displayName: 'Relief Valve',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Relief Valve' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true },
      { name: 'diameter', type: 'number', label: 'Diameter', default: 0.15, min: 0.025, max: 0.5, step: 0.025, unit: 'm' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 200, min: 1, max: 600, step: 5, unit: 'bar', help: 'Body design pressure - should comfortably exceed the set pressure. Burst point and cost follow the rating.' },
      { name: 'setpoint', type: 'number', label: 'Set Pressure', default: 170, min: 1, max: 300, step: 1, unit: 'bar', help: 'Pressure at which valve opens' },
      { name: 'blowdown', type: 'number', label: 'Blowdown', default: 5, min: 1, max: 20, step: 1, unit: '%', help: 'Pressure drop before reseating (% of setpoint)' },
      // Capacity calculated using critical (choked) flow for steam
      // For critical flow: m_dot = Cd * A * P * sqrt(k * M / (R * T)) * (2/(k+1))^((k+1)/(2*(k-1)))
      // Simplified: m_dot ≈ Cd * A * P * 0.67 / sqrt(T) for steam (k≈1.3)
      // Or use empirical: ~50 kg/s per 0.1m diameter at 170 bar (scales with d² and sqrt(P))
      { name: 'capacity', type: 'calculated', label: 'Relieving Capacity', default: 0, unit: 'kg/s',
        calculate: (p) => {
          const d = p.diameter || 0.15;  // m
          const setpoint = p.setpoint || 170;  // bar
          const A = Math.PI * (d / 2) * (d / 2);  // m²
          const Cd = 0.85;  // ASME certified nozzle coefficient
          // Critical flow constant for steam: C ≈ 2.11 kg/(s·m²·bar) at typical conditions
          // This accounts for choked flow thermodynamics
          const C = 2.11;
          // Capacity = Cd * A * C * P (with Kd knockdown factor ~0.975)
          const capacity = Cd * 0.975 * A * C * setpoint;
          return capacity.toFixed(1);
        }
      }
    ]
  },
  'porv': {
    displayName: 'PORV',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'PORV' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true },
      { name: 'diameter', type: 'number', label: 'Diameter', default: 0.1, min: 0.025, max: 0.3, step: 0.025, unit: 'm' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 200, min: 1, max: 600, step: 5, unit: 'bar', help: 'Body design pressure - should comfortably exceed the auto-open pressure. Burst point and cost follow the rating.' },
      { name: 'setpoint', type: 'number', label: 'Auto-Open Pressure', default: 165, min: 1, max: 300, step: 1, unit: 'bar', help: 'Pressure at which valve auto-opens' },
      { name: 'blowdown', type: 'number', label: 'Blowdown', default: 3, min: 1, max: 10, step: 1, unit: '%', help: 'Pressure drop before auto-reseating (% of setpoint)' },
      { name: 'initialPosition', type: 'select', label: 'Initial State', default: 'auto', options: [
        { value: 'auto', label: 'Auto (pressure-controlled)' },
        { value: 'open', label: 'Forced Open' },
        { value: 'closed', label: 'Forced Closed' }
      ]},
      { name: 'hasBlockValve', type: 'checkbox', label: 'Has Block Valve', default: true, help: 'Upstream isolation valve for maintenance' },
      // Capacity calculated using critical (choked) flow for steam
      { name: 'capacity', type: 'calculated', label: 'Relieving Capacity', default: 0, unit: 'kg/s',
        calculate: (p) => {
          const d = p.diameter || 0.1;  // m
          const setpoint = p.setpoint || 165;  // bar
          const A = Math.PI * (d / 2) * (d / 2);  // m²
          const Cd = 0.90;  // PORVs typically have better flow characteristics
          // Critical flow constant for steam
          const C = 2.11;  // kg/(s·m²·bar)
          const capacity = Cd * 0.975 * A * C * setpoint;
          return capacity.toFixed(1);
        }
      }
    ]
  },
  'pump': {
    displayName: 'Pump',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Pump' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: false },
      { name: 'elevation', type: 'number', label: 'Elevation', default: 0, min: -20, max: 50, step: 0.5, unit: 'm', help: 'Height above ground level (negative for basement placement, e.g. condensate pumps)' },
      { name: 'type', type: 'select', label: 'Pump Type', default: 'centrifugal', options: [
        { value: 'centrifugal', label: 'Centrifugal' },
        { value: 'positive', label: 'Positive Displacement' }
      ]},
      { name: 'orientation', type: 'select', label: 'Flow Direction', default: 'left-right', help: 'Which side the discharge nozzle faces. The pump always stands upright (suction below, motor on top) - real vertical process pumps are not laid on their side. Re-picked automatically whenever you connect the pump (it turns to face whatever it is connected to); edit it here afterward to override.', options: [
        { value: 'left-right', label: 'Discharge Right (suction below)' },
        { value: 'right-left', label: 'Discharge Left (suction below)' }
      ]},
      { name: 'ratedFlow', type: 'number', label: 'Rated Flow', default: 1000, min: 10, max: 10000, step: 10, unit: 'kg/s' },
      { name: 'ratedHead', type: 'number', label: 'Rated Head', default: 100, min: 10, max: 2000, step: 10, unit: 'm', help: 'Charging/HPSI service needs ~1300-1600 m to overcome full primary pressure' },
      { name: 'pressureRating', type: 'number', label: 'Casing Pressure Rating', default: 150, min: 1, max: 600, step: 5, unit: 'bar', help: 'Casing design pressure - rate for suction pressure plus shutoff head. Burst point and cost follow the rating.' },
      { name: 'speed', type: 'number', label: 'Speed', default: 1800, min: 900, max: 3600, step: 100, unit: 'RPM' },
      { name: 'efficiency', type: 'number', label: 'Efficiency', default: 85, min: 50, max: 95, step: 5, unit: '%' },
      { name: 'npshRequired', type: 'number', label: 'NPSH Required', default: 5, min: 1, max: 30, step: 1, unit: 'm' },
      { name: 'initialState', type: 'select', label: 'Initial State', default: 'on', options: [
        { value: 'on', label: 'Running' },
        { value: 'off', label: 'Stopped' }
      ]},
      { name: 'matchUpstream', type: 'checkbox', label: 'Match upstream conditions', default: true, help: 'Automatically set initial P/T from connected upstream component' },
      { name: 'initialPressure', type: 'number', label: 'Initial Pressure', default: 10, min: 0.01, max: 250, step: 0.1, unit: 'bar', dependsOn: { field: 'matchUpstream', value: false } },
      { name: 'initialTemperature', type: 'number', label: 'Initial Temperature', default: 50, min: 0, max: 400, step: 1, unit: '°C', dependsOn: { field: 'matchUpstream', value: false } },
      // Calculated fields
      { name: 'diameter', type: 'calculated', label: 'Pump Diameter', default: 0, unit: 'm',
        calculate: (p) => {
          // Pump diameter scales with flow capacity
          // Small pumps (~100 kg/s): ~0.3m, Large RCPs (~5000 kg/s): ~1.5m
          const flow = p.ratedFlow || 1000;
          const diameter = 0.2 + Math.sqrt(flow / 1000) * 0.4;
          return diameter.toFixed(2);
        }
      },
      { name: 'shaftPower', type: 'calculated', label: 'Shaft Power', default: 0, unit: 'kW',
        calculate: (p) => {
          // P = rho * g * Q * H / eta
          const rho = 1000;  // kg/m³ (water)
          const g = 9.81;
          const Q = (p.ratedFlow || 1000) / rho;  // m³/s
          const H = p.ratedHead || 100;
          const eta = (p.efficiency || 85) / 100;
          const power = rho * g * Q * H / eta;
          return (power / 1000).toFixed(0);  // kW
        }
      }
    ]
  },

  // Heat transfer
  'heat-exchanger': {
    displayName: 'Heat Exchanger',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Heat Exchanger' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true },
      { name: 'hxType', type: 'select', label: 'Type', default: 'utube', options: [
        { value: 'utube', label: 'U-Tube' },
        { value: 'straight', label: 'Straight Tube' },
        { value: 'helical', label: 'Helical Coil' }
      ]},
      { name: 'tubeModel', type: 'select', label: 'Tube-Side Model', default: 'lumped', options: [
        { value: 'lumped', label: 'Lumped (single node)' },
        { value: 'moving-boundary', label: 'Once-through boiler (moving boundary)' },
      ], help: 'Once-through boiler splits the tube side into subcooled / boiling / ' +
        'superheated sections whose boundaries move with the phase boundaries, so one ' +
        'component can turn feedwater into superheated steam against a counterflow hot ' +
        'stream. Use for OTSGs (helical HTGR steam generators); leave Lumped for ' +
        'condensers, feedwater heaters, and flooded U-tube SGs. The tubes are drawn in ' +
        'those three bands, in flow order from the feed end: blue subcooled water, ' +
        'speckled liquid/steam where it is boiling, then white superheated steam. ' +
        'A band you cannot see has no length - a flooded boiler is all speckle.' },
      { name: 'bundleCount', type: 'number', label: 'Tube Bundles', default: 1, min: 1, max: 8, step: 1,
        help: 'Independent tube bundles sharing one shell. Each bundle gets its own pair of ' +
          'tube-side connection points (top and bottom for straight/helical, both on the ' +
          'plenum for U-tube), its own tube metal, and its own boiling partition, and takes ' +
          'an equal share of the shell flow. The tube count below is the TOTAL and is split ' +
          'evenly between bundles, so adding bundles subdivides the exchanger rather than ' +
          'enlarging it. Use this for an OTSG whose bundles feed separate steam headers.' },
      { name: 'orientation', type: 'select', label: 'Orientation', default: 'vertical', options: [
        { value: 'vertical', label: 'Vertical' },
        { value: 'horizontal', label: 'Horizontal' }
      ]},
      { name: 'elevation', type: 'number', label: 'Elevation (Shell Bottom)', default: 2, min: -10, max: 50, step: 0.5, unit: 'm', help: 'Height above ground of shell bottom. Plenums extend below this for vertical HX.' },
      { name: 'shellDiameter', type: 'number', label: 'Shell Diameter', default: 2.5, min: 0.5, max: 10, step: 0.1, unit: 'm' },
      { name: 'shellLength', type: 'number', label: 'Shell Length', default: 8, min: 1, max: 25, step: 0.5, unit: 'm' },
      { name: 'plenumLength', type: 'number', label: 'Plenum Length', default: 0.8, min: 0.1, max: 5, step: 0.1, unit: 'm', help: 'Length of tube-side plenums (semi-ellipsoid caps). Capped to shell radius.' },
      { name: 'tubeCount', type: 'number', label: 'Number of Tubes', default: 3000, min: 10, max: 20000, step: 100 },
      { name: 'tubeOD', type: 'number', label: 'Tube Outer Diameter', default: 19, min: 6, max: 50, step: 1, unit: 'mm' },
      { name: 'tubePressure', type: 'number', label: 'Tube-Side Pressure Rating', default: 150, min: 1, max: 300, step: 10, unit: 'bar', help: 'Design pressure for tube side (determines tube wall thickness)' },
      { name: 'shellPressure', type: 'number', label: 'Shell-Side Pressure Rating', default: 60, min: 1, max: 100, step: 5, unit: 'bar', help: 'Design pressure for shell side (determines shell and plenum wall thickness)' },
      // Calculated fields - displayed but not editable
      { name: 'tubeWallThickness', type: 'calculated', label: 'Tube Wall Thickness', default: 0, unit: 'mm',
        calculate: (p) => {
          // ASME formula for thin-walled tubes: t = P*R / (S*E - 0.6*P)
          // Tube pressure is differential (tube side minus unpressurized shell)
          const P = (p.tubePressure || 150) * 1e5; // bar to Pa
          const R = (p.tubeOD || 19) / 2000;       // outer radius in m (from mm)
          const S = 137e6; // Inconel 690 allowable stress at 300°C (Pa)
          const E = 1.0;   // Joint efficiency (seamless tube)
          const thickness = P * R / (S * E - 0.6 * P);
          return (Math.max(0.0005, thickness) * 1000).toFixed(2); // m to mm
        }
      },
      { name: 'shellWallThickness', type: 'calculated', label: 'Shell Wall Thickness', default: 0, unit: 'mm',
        calculate: (p) => {
          // ASME formula for cylindrical vessels: t = P*R / (S*E - 0.6*P)
          const P = (p.shellPressure || 60) * 1e5; // bar to Pa
          const R = (p.shellDiameter || 2.5) / 2;   // inner radius in m
          const S = 172e6; // SA-533 Grade B Class 1 allowable stress (Pa)
          const E = 1.0;   // Joint efficiency
          const thickness = P * R / (S * E - 0.6 * P);
          return (Math.max(0.002, thickness) * 1000).toFixed(0); // m to mm
        }
      },
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
          // Calculate tube thickness from pressure rating
          const P = (p.tubePressure || 150) * 1e5;
          const R = tubeOD_m / 2;
          const S = 137e6; // Inconel 690
          const E = 1.0;
          const tubeThickness_m = Math.max(0.0005, P * R / (S * E - 0.6 * P));
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
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: false },
      { name: 'elevation', type: 'number', label: 'Elevation (Bottom)', default: 0, min: -10, max: 50, step: 0.5, unit: 'm', help: 'Height above ground level (typically at ground level)' },
      { name: 'volume', type: 'number', label: 'Volume', default: 100, min: 10, max: 1000, step: 10, unit: 'm³' },
      { name: 'height', type: 'number', label: 'Height', default: 3, min: 1, max: 10, step: 0.5, unit: 'm' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 1.1, min: 0.5, max: 10, step: 0.1, unit: 'bar', help: 'Design pressure (condensers operate under vacuum but must withstand external atmospheric pressure)' },
      { name: 'coolingCapacity', type: 'number', label: 'Cooling Capacity', default: 2000, min: 100, max: 5000, step: 100, unit: 'MW' },
      { name: 'operatingPressure', type: 'number', label: 'Operating Pressure', default: 0.05, min: 0.01, max: 1, step: 0.01, unit: 'bar' },
      { name: 'coolingWaterTemp', type: 'number', label: 'Cooling Water Temp', default: 20, min: 5, max: 40, step: 5, unit: '°C' },
      { name: 'coolingWaterFlow', type: 'number', label: 'Cooling Water Flow', default: 50000, min: 1000, max: 100000, step: 1000, unit: 'kg/s' },
      { name: 'includesPump', type: 'checkbox', label: 'Include Condensate Pump', default: true, help: 'Automatically includes a condensate pump (applies when the condenser is first placed; editing later does not add or remove the pump)' },
      { name: 'initialNcg', type: 'ncg', label: 'Non-Condensible Gases', default: {}, help: 'Air ingress or other NCGs in condenser (typically evacuated)' },
      // Calculated fields
      { name: 'width', type: 'calculated', label: 'Width', default: 0, unit: 'm',
        calculate: (p) => {
          // Calculate width from volume and height: V = W * W * H (assuming square footprint)
          const volume = p.volume || 100;
          const height = p.height || 3;
          const width = Math.sqrt(volume / height);
          return width.toFixed(1);
        }
      },
      { name: 'wallThickness', type: 'calculated', label: 'Wall Thickness', default: 0, unit: 'mm',
        calculate: (p) => {
          // For vacuum vessels, design is based on external pressure (atmospheric)
          // Shell buckling formula: t = D * sqrt(P_ext / (2.6 * E))
          // But for simplicity, use ASME pressure vessel formula with design pressure
          // t = P*R / (S*E - 0.6*P)
          // S = 137 MPa (carbon steel), E = 0.85
          const P = (p.pressureRating || 1.1) * 1e5; // bar to Pa
          const vol = p.volume || 100;
          const h = p.height || 3;
          const R = Math.sqrt(vol / h) / 2; // Half-width as radius
          const S = 137e6; // Pa
          const E = 0.85;
          const t = P * R / (S * E - 0.6 * P);
          // Minimum practical thickness for large vacuum vessels
          const minThickness = 6; // mm
          return Math.max(t * 1000, minThickness).toFixed(1);
        }
      }
    ]
  },
  'turbine-generator': {
    displayName: 'Turbine-Generator',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Turbine-Generator' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: false },
      { name: 'orientation', type: 'select', label: 'Orientation', default: 'left-right', options: [
        { value: 'left-right', label: 'Inlet Left → Exhaust Right' },
        { value: 'right-left', label: 'Inlet Right → Exhaust Left' }
      ]},
      { name: 'stages', type: 'number', label: 'Number of Stages', default: 3, min: 1, max: 5, step: 1 },
      { name: 'ratedPower', type: 'number', label: 'Rated Power', default: 1000, min: 100, max: 2000, step: 100, unit: 'MW' },
      { name: 'inletPressure', type: 'number', label: 'Inlet Pressure', default: 60, min: 10, max: 100, step: 5, unit: 'bar', help: 'Initial steam condition in the casing. After a simulation has run, this shows the CURRENT inlet condition (it becomes the restart condition if you edit the turbine).' },
      { name: 'designInletPressure', type: 'number', label: 'Design Inlet Pressure', default: 0, min: 0, max: 250, step: 5, unit: 'bar', help: 'Design point for the swallowing capacity (Stodola cone law, with Rated Steam Flow). 0 = freeze automatically at the inlet pressure when the simulation first starts; it does not move on mode-switch resumes.' },
      { name: 'exhaustPressure', type: 'number', label: 'Exhaust Pressure', default: 0.05, min: 0.01, max: 1, step: 0.01, unit: 'bar' },
      { name: 'turbineEfficiency', type: 'number', label: 'Turbine Isentropic Eff.', default: 85, min: 70, max: 95, step: 5, unit: '%' },
      { name: 'generatorEfficiency', type: 'number', label: 'Generator Efficiency', default: 98, min: 95, max: 99, step: 0.5, unit: '%' },
      { name: 'governorValve', type: 'number', label: 'Governor Valve Position', default: 100, min: 0, max: 100, step: 5, unit: '%' },
      // Extraction ports for feedwater heating
      { name: 'extraction1Pressure', type: 'number', label: 'Extraction 1 Pressure', default: 0, min: 0, max: 50, step: 1, unit: 'bar', help: 'Set to 0 to disable. High-pressure extraction for HP feedwater heater.' },
      { name: 'extraction2Pressure', type: 'number', label: 'Extraction 2 Pressure', default: 0, min: 0, max: 30, step: 0.5, unit: 'bar', help: 'Set to 0 to disable. Intermediate-pressure extraction.' },
      { name: 'extraction3Pressure', type: 'number', label: 'Extraction 3 Pressure', default: 0, min: 0, max: 10, step: 0.1, unit: 'bar', help: 'Set to 0 to disable. Low-pressure extraction for LP feedwater heater or deaerator.' },
      // Calculated fields
      { name: 'ratedSteamFlow', type: 'calculated', label: 'Rated Steam Flow', default: 0, unit: 'kg/s',
        calculate: (p) => {
          // P = m_dot * eta_turbine * eta_gen * delta_h
          // Sized at the DESIGN inlet pressure when one is set - inletPressure
          // holds the live/current condition after a simulation has run
          const P_in = ((p.designInletPressure > 0 ? p.designInletPressure : p.inletPressure) || 60) * 1e5;  // Pa
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
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true },
      { name: 'orientation', type: 'select', label: 'Orientation', default: 'left-right', options: [
        { value: 'left-right', label: 'Steam Left → Pump Right' },
        { value: 'right-left', label: 'Steam Right → Pump Left' }
      ]},
      { name: 'stages', type: 'number', label: 'Turbine Stages', default: 1, min: 1, max: 3, step: 1 },
      // Pump properties
      { name: 'ratedPumpFlow', type: 'number', label: 'Rated Pump Flow', default: 50, min: 10, max: 500, step: 10, unit: 'kg/s' },
      { name: 'ratedHead', type: 'number', label: 'Rated Head', default: 500, min: 50, max: 2000, step: 50, unit: 'm' },
      { name: 'pressureRating', type: 'number', label: 'Casing Pressure Rating', default: 150, min: 1, max: 600, step: 5, unit: 'bar', help: 'Pump casing design pressure - rate for suction pressure plus shutoff head. Burst point and cost follow the rating.' },
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
      { name: 'thermalPower', type: 'number', label: 'Thermal Power', default: 3000, min: 100, max: 5000, step: 100, unit: 'MWt', help: 'Rated thermal power. Drives fuel cost - size it to what the plant actually needs.' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true },
      { name: 'height', type: 'number', label: 'Active Height', default: 3.66, min: 1, max: 6, step: 0.1, unit: 'm', help: 'Height of the active fuel region' },
      { name: 'coreBottomElevation', type: 'number', label: 'Core Bottom Elevation', default: 0.5, min: 0, step: 0.1, unit: 'm', help: 'Height of core bottom above the bottom of the core barrel region. Affects heat transfer when liquid level drops.' },
      { name: 'diameter', type: 'number', label: 'Core Diameter', default: 3.2, min: 1, max: 6, step: 0.1, unit: 'm' },
      { name: 'fuelForm', type: 'select', label: 'Fuel Form', default: 'rods', options: [
        { value: 'rods', label: 'Fuel rods (clad pins)' },
        { value: 'pebbles', label: 'TRISO pebbles (graphite bed)' },
      ], help: 'Rods: water-moderated lattice of clad fuel pins. Pebbles: packed bed of graphite spheres with dispersed TRISO kernels - solid-moderated, meant for gas coolant (fill the vessel with helium and 0% water level).' },
      { name: 'rodDiameter', type: 'number', label: 'Fuel Rod Diameter', default: 9.5, min: 5, max: 15, step: 0.5, unit: 'mm',
        dependsOn: { field: 'fuelForm', value: 'rods' } },
      { name: 'rodPitch', type: 'number', label: 'Rod Pitch', default: 12.6, min: 8, max: 20, step: 0.5, unit: 'mm', help: 'Center-to-center spacing between rods',
        dependsOn: { field: 'fuelForm', value: 'rods' } },
      { name: 'cladThickness', type: 'number', label: 'Cladding Thickness', default: 0.6, min: 0.2, max: 2, step: 0.1, unit: 'mm', help: 'Zircaloy cladding wall. Thinner clad leaves more pellet volume but fails sooner in accidents.',
        dependsOn: { field: 'fuelForm', value: 'rods' } },
      { name: 'pebbleDiameter', type: 'number', label: 'Pebble Diameter', default: 60, min: 20, max: 120, step: 5, unit: 'mm',
        dependsOn: { field: 'fuelForm', value: 'pebbles' } },
      { name: 'pebbleCount', type: 'number', label: 'Pebble Count', default: 400000, min: 1000, step: 1000,
        dependsOn: { field: 'fuelForm', value: 'pebbles' },
        help: 'A randomly packed bed fills ~61% of the core volume with pebbles (see suggested count)' },
      { name: 'heavyMetalPerPebble', type: 'number', label: 'Heavy Metal per Pebble', default: 7, min: 1, max: 30, step: 0.5, unit: 'g',
        dependsOn: { field: 'fuelForm', value: 'pebbles' },
        help: 'Uranium mass in the TRISO kernels of each pebble (~7 g is typical)' },
      { name: 'reflectorThickness', type: 'number', label: 'Reflector Thickness', default: 0.8, min: 0, max: 2, step: 0.1, unit: 'm',
        dependsOn: { field: 'fuelForm', value: 'pebbles' },
        help: 'Graphite reflector surrounding the core - buys back neutron leakage (small cores need it to go critical)' },
      { name: 'enrichmentPct', type: 'number', label: 'Enrichment', default: 5, min: 0.7, max: 20, step: 0.1, unit: '% U-235', help: 'Fuel enrichment. Drives available excess reactivity and, with the lattice geometry, the reactivity feedback coefficients. 0.7% is natural uranium (will not go critical in a light-water lattice, but can in a graphite pile). Pebble beds typically use 8-15%.' },
      { name: 'fuelMaterial', type: 'select', label: 'Fuel Material', default: 'UO2', options: [
        { value: 'UO2', label: 'UO₂ ceramic' },
        { value: 'metal', label: 'U metal alloy' },
      ], help: 'Ceramic UO₂ runs hot inside (strong Doppler); metal fuel conducts better and has a slightly harder spectrum.',
        dependsOn: { field: 'fuelForm', value: 'rods' } },
      { name: 'autoPoison', type: 'checkbox', label: 'Auto-size burnable poison', default: true,
        help: 'Burnable absorbers in the fuel hold down excess reactivity. Auto: sized so that fully inserting the control rods leaves ~1000 pcm shutdown margin at the initial plant conditions. Uncheck to set the poison worth yourself.' },
      { name: 'burnablePoisonPcm', type: 'number', label: 'Burnable Poison Worth', default: 2000, min: 0, max: 100000, step: 100, unit: 'pcm',
        dependsOn: { field: 'autoPoison', value: false },
        help: 'Reactivity permanently held down by burnable absorbers. Too little and the rods cannot shut the core down; too much and it cannot go critical. Note: a core that starts cold loses several thousand pcm of moderator reactivity as it heats up to operating temperature, so leave extra excess if you plan a cold startup.' },
      { name: 'controlRodBanks', type: 'number', label: 'Control Rod Banks', default: 4, min: 1, max: 10, step: 1, help: 'Number of control rod banks. Total rod worth scales with bank count (see the estimate at right): ~4 banks is PWR-like (rods alone cannot hold a cold core down - pair with boron), 8-10 banks is BWR-like (enough authority for cold shutdown on rods alone, with generous excess for the cold-to-hot reactivity swing). Each bank adds drive mechanisms, so more authority costs more.' },
      { name: 'startCritical', type: 'checkbox', label: 'Start at critical rod position', default: true,
        help: 'Place the control rods where total reactivity is exactly zero at the initial plant conditions, so the reactor starts steady instead of ramping. Uncheck to set the position yourself (e.g. to start shut down).' },
      { name: 'initialRodPosition', type: 'number', label: 'Initial Rod Position', default: 50, min: 0, max: 100, step: 5, unit: '%',
        dependsOn: { field: 'startCritical', value: false },
        help: '0% = fully inserted, 100% = fully withdrawn' },
      // Calculated fields
      { name: 'fuelRodCount', type: 'calculated', label: 'Fuel Rods (approx)', default: 0,
        calculate: (p) => {
          if (p.fuelForm === 'pebbles') return '—';
          const coreDiam = (p.diameter || 3.37) * 1000; // m to mm
          const pitch = p.rodPitch || 12.6; // mm
          const coreArea = Math.PI * Math.pow(coreDiam / 2, 2); // mm²
          const rodsPerArea = 1 / (pitch * pitch); // rods per mm²
          const rodCount = Math.floor(coreArea * rodsPerArea * 0.9); // 90% packing efficiency
          return rodCount.toLocaleString();
        }
      },
      { name: 'pebbleCountSuggested', type: 'calculated', label: 'Pebbles at 61% packing', default: 0,
        calculate: (p) => {
          if (p.fuelForm !== 'pebbles') return '—';
          const coreVolume = Math.PI * Math.pow((p.diameter || 3.2) / 2, 2) * (p.height || 3.66);
          const pebbleVolume = (Math.PI / 6) * Math.pow((p.pebbleDiameter || 60) / 1000, 3);
          return Math.round(0.61 * coreVolume / pebbleVolume).toLocaleString();
        }
      },
      { name: 'estRodWorth', type: 'calculated', label: 'Est. rod worth (hot)', default: 0,
        calculate: (p) => {
          try {
            const worth = deriveControlRodWorth(dialogLatticeParams(p), p.controlRodBanks || 4);
            return `${Math.round(worth * 1e5).toLocaleString()} pcm`;
          } catch {
            return 'n/a';
          }
        }
      },
      { name: 'linearHeatRate', type: 'calculated', label: 'Avg heat rate', default: 0,
        calculate: (p) => {
          const powerW = (p.thermalPower || 3000) * 1e6;
          if (p.fuelForm === 'pebbles') {
            const kwPerPebble = powerW / 1000 / (p.pebbleCount || 400000);
            // Typical pebble beds run ~0.5-1 kW per pebble
            return `${kwPerPebble.toFixed(2)} kW/pebble${kwPerPebble > 2 ? ' ⚠ high' : ''}`;
          }
          const pitch = (p.rodPitch || 12.6) / 1000;
          const coreArea = Math.PI * Math.pow((p.diameter || 3.2) / 2, 2);
          const rodCount = Math.max(1, Math.floor(coreArea / (pitch * pitch) * 0.9));
          const kwPerM = powerW / 1000 / (rodCount * (p.height || 3.66));
          // Typical PWR average ~18 kW/m; peak rods run 2-2.5x average
          return `${kwPerM.toFixed(1)} kW/m${kwPerM > 25 ? ' ⚠ high' : ''}`;
        }
      }
    ]
  },

  // Controllers
  'scram-controller': {
    displayName: 'Scram Controller',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Scram Controller' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true },
      // Note: connectedCore will be populated dynamically in the dialog based on available cores
      { name: 'connectedCore', type: 'select', label: 'Connected Core', default: '', options: [], help: 'Select the reactor core this controller monitors' },
      { name: 'highPower', type: 'number', label: 'High Power Trip', default: 125, min: 100, max: 200, step: 5, unit: '%', help: 'Scram when power exceeds this % of nominal' },
      { name: 'lowPower', type: 'number', label: 'Low Power Trip', default: 12, min: 0, max: 50, step: 1, unit: '%', help: 'Scram when power drops below this % of nominal' },
      { name: 'highFuelTemp', type: 'number', label: 'High Fuel Temp Trip', default: 95, min: 80, max: 100, step: 1, unit: '%', help: 'Scram when fuel temp exceeds this % of melting point' },
      { name: 'lowCoolantFlow', type: 'number', label: 'Low Coolant Flow Trip', default: 10, min: 0, max: 100, step: 1, unit: 'kg/s', help: 'Scram when coolant flow drops below this value' }
    ]
  },

  'pid-controller': {
    displayName: 'PID Controller',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'PID Controller' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: false, help: 'Process controllers are typically non-safety related (the scram system is the safety backstop)' },
      { name: 'sensorKind', type: 'select', label: 'Measured Variable', default: 'node-level', options: [
        { value: 'node-level', label: 'Liquid level' },
        { value: 'node-pressure', label: 'Pressure' },
        { value: 'node-temperature', label: 'Temperature' },
        { value: 'connection-flow', label: 'Flow rate' },
        { value: 'reactor-power', label: 'Reactor power' },
      ], help: 'What the controller measures. Gains are auto-tuned from the plant physics - just state the intent.' },
      { name: 'sensorNode', type: 'select', label: 'Measured Component', default: '', options: [], dynamicOptions: 'flowNodes',
        dependsOn: { field: 'sensorKind', value: ['node-level', 'node-pressure', 'node-temperature'] },
        help: 'Component whose level/pressure/temperature is measured' },
      { name: 'sensorConnection', type: 'select', label: 'Measured Flow Path', default: '', options: [], dynamicOptions: 'flowConnections',
        dependsOn: { field: 'sensorKind', value: 'connection-flow' },
        help: 'Connection whose mass flow rate is measured' },
      { name: 'setpointLevel', type: 'number', label: 'Level Setpoint', default: 5, min: 0, step: 0.1, unit: 'm',
        dependsOn: { field: 'sensorKind', value: 'node-level' }, help: 'Liquid level above the bottom of the component' },
      { name: 'setpointPressure', type: 'number', label: 'Pressure Setpoint', default: 60, min: 0.01, step: 0.5, unit: 'bar',
        dependsOn: { field: 'sensorKind', value: 'node-pressure' } },
      { name: 'setpointTemperature', type: 'number', label: 'Temperature Setpoint', default: 300, step: 1, unit: '°C',
        dependsOn: { field: 'sensorKind', value: 'node-temperature' } },
      { name: 'setpointFlow', type: 'number', label: 'Flow Setpoint', default: 500, step: 10, unit: 'kg/s',
        dependsOn: { field: 'sensorKind', value: 'connection-flow' } },
      { name: 'setpointPower', type: 'number', label: 'Power Setpoint', default: 100, min: 0, max: 120, step: 1, unit: '% nominal',
        dependsOn: { field: 'sensorKind', value: 'reactor-power' } },
      { name: 'actuatorKind', type: 'select', label: 'Actuator', default: 'valve-position', options: [
        { value: 'valve-position', label: 'Valve position' },
        { value: 'pump-speed', label: 'Pump speed' },
        { value: 'governor-valve', label: 'Turbine governor valve' },
        { value: 'heater-power', label: 'Heater power' },
        { value: 'control-rods', label: 'Control rods' },
      ], help: 'What the controller drives. Control rods work with power, temperature, or pressure measurements (not level/flow).' },
      { name: 'actuatorValve', type: 'select', label: 'Controlled Valve', default: '', options: [], dynamicOptions: 'valves',
        dependsOn: { field: 'actuatorKind', value: 'valve-position' } },
      { name: 'actuatorPump', type: 'select', label: 'Controlled Pump', default: '', options: [], dynamicOptions: 'pumps',
        dependsOn: { field: 'actuatorKind', value: 'pump-speed' } },
      { name: 'actuatorTurbine', type: 'select', label: 'Controlled Turbine', default: '', options: [], dynamicOptions: 'turbines',
        dependsOn: { field: 'actuatorKind', value: 'governor-valve' } },
      { name: 'actuatorHeaterNode', type: 'select', label: 'Heated Component', default: '', options: [], dynamicOptions: 'flowNodes',
        dependsOn: { field: 'actuatorKind', value: 'heater-power' },
        help: 'Component containing the heaters (e.g. pressurizer)' },
      { name: 'heaterCapacityMW', type: 'number', label: 'Heater Capacity', default: 2, min: 0.01, step: 0.1, unit: 'MW',
        dependsOn: { field: 'actuatorKind', value: 'heater-power' } },
      { name: 'invert', type: 'checkbox', label: 'Reverse acting', default: false,
        help: 'Output increases when the measurement is ABOVE setpoint (e.g. spray on high pressure, steam-relief on high pressure, drain on high level)' },
      { name: 'aggressiveness', type: 'number', label: 'Aggressiveness', default: 1, min: 0.2, max: 5, step: 0.1,
        help: 'Closed-loop speed multiplier on the auto-tuned gains. 1 = commissioning defaults; higher is faster but less robust.' },
      { name: 'strokeTime', type: 'number', label: 'Actuator Stroke Time', default: 20, min: 1, step: 1, unit: 's',
        help: 'Time for the actuator to travel its full range (sets the rate limit). Control rod drives are much slower than valves - typically ~1000 s for a full stroke.' },
      { name: 'powerLimitPct', type: 'number', label: 'Rod Withdrawal Power Limit', default: 100, min: 10, max: 120, step: 1, unit: '%',
        dependsOn: { field: 'actuatorKind', value: 'control-rods' },
        help: 'Rods never withdraw above this reactor power (withdrawal permissive)' },
      { name: 'outputMinPct', type: 'number', label: 'Output Minimum', default: 0, min: 0, max: 100, step: 1, unit: '%',
        dependsOn: { field: 'actuatorKind', value: ['valve-position', 'pump-speed', 'governor-valve'] },
        help: 'Lower saturation limit (e.g. 5% minimum pump speed to protect the pump)' },
      { name: 'outputMaxPct', type: 'number', label: 'Output Maximum', default: 100, min: 0, max: 100, step: 1, unit: '%',
        dependsOn: { field: 'actuatorKind', value: ['valve-position', 'pump-speed', 'governor-valve'] } },
    ]
  },

  // Electrical
  'switchyard': {
    displayName: 'Switchyard',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Switchyard' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: false, help: 'Switchyards are typically non-safety related' },
      // Note: connectedGenerator will be populated dynamically in the dialog based on available turbine-generators
      { name: 'connectedGenerator', type: 'select', label: 'Connected Generator', default: '', options: [], help: 'Select the turbine-generator this switchyard connects to' },
      { name: 'offsiteLines', type: 'number', label: 'Offsite Power Lines', default: 2, min: 1, max: 4, step: 1, help: 'Number of independent transmission lines (more = lower LOOP probability)' },
      { name: 'transformerRating', type: 'number', label: 'Transformer Rating', default: 1200, min: 100, max: 2000, step: 50, unit: 'MW', help: 'Main power transformer capacity (should match or exceed generator output)' },
      { name: 'reliabilityClass', type: 'select', label: 'Reliability Class', default: 'standard', options: [
        { value: 'standard', label: 'Standard' },
        { value: 'enhanced', label: 'Enhanced' },
        { value: 'highly-reliable', label: 'Highly Reliable' }
      ], help: 'Affects equipment quality, redundancy, and maintenance programs' },
      // Calculated fields
      { name: 'transmissionVoltage', type: 'calculated', label: 'Transmission Voltage', default: 345, unit: 'kV',
        calculate: () => '345'  // Fixed at 345 kV (cosmetic)
      }
    ]
  },

  // Structures
  'building': {
    displayName: 'Building / Containment',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Containment' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true, help: 'Containment buildings are safety-related' },
      { name: 'buildingShape', type: 'select', label: 'Shape', default: 'cylinder', options: [
        { value: 'cylinder', label: 'Cylindrical' },
        { value: 'rectangle', label: 'Rectangular' }
      ], help: 'Cylindrical is typical for PWR containments' },
      { name: 'height', type: 'number', label: 'Height', default: 25, min: 10, max: 100, step: 1, unit: 'm' },
      { name: 'diameter', type: 'number', label: 'Diameter', default: 40, min: 10, max: 80, step: 1, unit: 'm', dependsOn: { field: 'buildingShape', value: 'cylinder' } },
      { name: 'width', type: 'number', label: 'Width', default: 40, min: 10, max: 100, step: 1, unit: 'm', dependsOn: { field: 'buildingShape', value: 'rectangle' } },
      { name: 'length', type: 'number', label: 'Length', default: 40, min: 10, max: 100, step: 1, unit: 'm', dependsOn: { field: 'buildingShape', value: 'rectangle' } },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 4, min: 1, max: 10, step: 0.5, unit: 'bar', help: 'Design pressure for containment (typically 3-5 bar for PWR)' },
      { name: 'steelFraction', type: 'number', label: 'Steel Liner Fraction', default: 0.1, min: 0, max: 0.5, step: 0.05, help: 'Fraction of wall that is steel (rest is concrete)' },
      { name: 'wallThickness', type: 'calculated', label: 'Wall Thickness', default: 0, unit: 'm',
        calculate: (p) => {
          // ASME formula with shape factor: t = shapeMultiplier * P*R / (S*E - 0.6*P)
          // For containment, blend steel (172 MPa) and concrete (~20 MPa) based on steelFraction
          const P = (p.pressureRating || 4) * 1e5; // bar to Pa
          const steelFrac = p.steelFraction || 0.1;
          const S_steel = 172e6; // Pa - SA-533 Grade B
          const S_concrete = 20e6; // Pa - typical concrete
          const S_effective = steelFrac * S_steel + (1 - steelFrac) * S_concrete;
          const E = 1.0;
          // Get radius based on shape
          let R: number;
          if (p.buildingShape === 'rectangle') {
            // For rectangle, use half of the larger dimension
            R = Math.max(p.width || 40, p.length || 40) / 2;
          } else {
            R = (p.diameter || 40) / 2;
          }
          // Shape multiplier: cylindrical is more efficient than rectangular
          const shapeMultiplier = p.buildingShape === 'rectangle' ? 1.5 : 1.0;
          const t = shapeMultiplier * P * R / (S_effective * E - 0.6 * P);
          return Math.max(0.3, t).toFixed(2); // Minimum 0.3m
        }
      },
      { name: 'initialLevel', type: 'number', label: 'Initial Water Level', default: 0, min: 0, max: 50, step: 1, unit: '%', help: 'Normally 0% (dry containment)' },
      { name: 'initialPressure', type: 'number', label: 'Initial Pressure', default: 1.01325, min: 0.5, max: 5, step: 0.1, unit: 'bar', help: 'Normally atmospheric (1.01 bar)' },
      { name: 'initialNcg', type: 'ncg', label: 'Atmosphere Gases', default: { N2: 0.78, O2: 0.21, Ar: 0.009 }, help: 'Containment atmosphere composition (default: air)' },
      // Calculated fields
      { name: 'volume', type: 'calculated', label: 'Free Volume', default: 0, unit: 'm³',
        calculate: (p) => {
          const h = p.height || 25;
          if (p.buildingShape === 'rectangle') {
            const w = p.width || 40;
            const l = p.length || 40;
            return (w * l * h).toFixed(0);
          } else {
            const d = p.diameter || 40;
            return (Math.PI * Math.pow(d / 2, 2) * h).toFixed(0);
          }
        }
      }
    ]
  },

  // Cross-vessel - structural extension for hot leg piping through cold annulus
  'cross-vessel': {
    displayName: 'Cross-Vessel',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Cross-Vessel' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true, help: 'Cross-vessels are part of the primary pressure boundary' },
      { name: 'outerDiameter', type: 'number', label: 'Outer Diameter', default: 1.0, min: 0.3, max: 3.0, step: 0.1, unit: 'm', help: 'Diameter of the outer shell (annulus boundary)' },
      { name: 'innerDiameter', type: 'number', label: 'Inner Pipe Diameter', default: 0.5, min: 0.1, max: 2.0, step: 0.05, unit: 'm', help: 'Diameter of the inner hot leg pipe' },
      { name: 'length', type: 'number', label: 'Length', default: 3.0, min: 0.5, max: 15.0, step: 0.5, unit: 'm', help: 'Will auto-adjust when annulus ports are connected' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 170, min: 50, max: 250, step: 5, unit: 'bar', help: 'Should match connected vessel' },
      { name: 'elevation', type: 'number', label: 'Elevation', default: 5, min: 0, max: 50, step: 0.5, unit: 'm', help: 'Height above ground' },
      { name: 'wallThickness', type: 'calculated', label: 'Outer Wall Thickness', default: 0, unit: 'm',
        calculate: (p) => {
          const P = (p.pressureRating || 170) * 1e5;
          const R = (p.outerDiameter || 1.0) / 2;
          const S = 172e6;
          const E = 1.0;
          const t = P * R / (S * E - 0.6 * P);
          return Math.max(0.02, t).toFixed(3);
        }
      },
      { name: 'innerWallThickness', type: 'calculated', label: 'Inner Pipe Wall Thickness', default: 0, unit: 'm',
        calculate: (p) => {
          const P = (p.pressureRating || 170) * 1e5;
          const R = (p.innerDiameter || 0.5) / 2;
          const S = 172e6;
          const E = 1.0;
          const t = P * R / (S * E - 0.6 * P);
          return Math.max(0.01, t).toFixed(3);
        }
      },
      { name: 'innerTemperature', type: 'number', label: 'Inner Pipe Temperature', default: 320, min: 100, max: 400, step: 5, unit: '°C', help: 'Hot leg temperature' },
      { name: 'annulusTemperature', type: 'number', label: 'Annulus Temperature', default: 290, min: 100, max: 400, step: 5, unit: '°C', help: 'Cold leg/downcomer temperature' },
      { name: 'annulusVolume', type: 'calculated', label: 'Annulus Volume', default: 0, unit: 'm³',
        calculate: (p) => {
          const outerR = (p.outerDiameter || 1.0) / 2;
          const innerR = (p.innerDiameter || 0.5) / 2;
          const P = (p.pressureRating || 170) * 1e5;
          const S = 172e6;
          const outerWall = Math.max(0.02, P * outerR / (S - 0.6 * P));
          const innerWall = Math.max(0.01, P * innerR / (S - 0.6 * P));
          const outerInner = outerR - outerWall;
          const innerOuter = innerR + innerWall;
          const length = p.length || 3.0;
          return (Math.PI * length * (outerInner * outerInner - innerOuter * innerOuter)).toFixed(2);
        }
      },
      { name: 'innerVolume', type: 'calculated', label: 'Inner Pipe Volume', default: 0, unit: 'm³',
        calculate: (p) => {
          const innerR = (p.innerDiameter || 0.5) / 2;
          const length = p.length || 3.0;
          return (Math.PI * innerR * innerR * length).toFixed(2);
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
  private availableCores: Array<{ id: string; label: string }> = [];
  private availableGenerators: Array<{ id: string; label: string }> = [];
  // Preset (equipment design) state for the create dialog
  private isCreateMode: boolean = false;
  private currentPresetId: string | null = null;
  private currentDefaultName?: string;
  private currentAvailableCoresForCreate?: Array<{ id: string; label: string }>;
  // Plant-derived choice lists for options with dynamicOptions (keyed by list
  // name, e.g. 'flowNodes', 'valves'). Set via setDynamicChoices before show().
  private dynamicChoices: Record<string, Array<{ id: string; label: string }>> = {};

  /**
   * Provide plant-derived choice lists for selects declared with
   * dynamicOptions. Call before show()/showEdit(); lists persist until
   * replaced.
   */
  setDynamicChoices(choices: Record<string, Array<{ id: string; label: string }>>): void {
    this.dynamicChoices = choices;
  }

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

    // Close on background click - but only if mousedown also started on backdrop
    // This prevents accidental closes when dragging to select text
    let mouseDownOnBackdrop = false;
    this.dialog.addEventListener('mousedown', (e) => {
      mouseDownOnBackdrop = (e.target === this.dialog);
    });
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog && mouseDownOnBackdrop) {
        this.handleCancel();
      }
      mouseDownOnBackdrop = false;
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.dialog.style.display !== 'none') {
        this.handleCancel();
      }
    });
  }

  show(
    componentType: string,
    position: { x: number; y: number },
    callback: (config: ComponentConfig | null) => void,
    availableCores?: Array<{ id: string; label: string }>,
    availableGenerators?: Array<{ id: string; label: string }>,
    defaultName?: string
  ) {
    const definition = componentDefinitions[componentType];
    if (!definition) {
      console.error(`Unknown component type: ${componentType}`);
      callback(null);
      return;
    }

    this.currentType = componentType;
    this.currentPosition = position;
    this.currentCallback = callback;
    this.availableGenerators = availableGenerators || [];

    // Set title
    this.titleElement.textContent = `Configure ${definition.displayName}`;

    // Preset state: default to the first standard design for this type (if any)
    this.isCreateMode = true;
    this.currentDefaultName = defaultName;
    this.currentAvailableCoresForCreate = availableCores;
    const presets = getPresetsForType(componentType);
    this.currentPresetId = presets.length > 0 ? presets[0].id : null;

    // Build form (pass available cores for controller dropdowns, and optional default name)
    this.rebuildCreateForm();

    // Show dialog
    this.dialog.style.display = 'flex';

    // Focus first input
    const firstInput = this.bodyElement.querySelector('input, select') as HTMLElement;
    if (firstInput) {
      firstInput.focus();
    }
  }

  /**
   * (Re)build the create-mode form: type defaults overridden by the currently
   * selected preset design. Called on open and whenever the design dropdown
   * changes - rebuilding the whole form keeps every behavior (two-phase
   * coupling, NCG panels, dependsOn visibility, calculated fields) consistent
   * with the new values for free.
   */
  private rebuildCreateForm() {
    const definition = componentDefinitions[this.currentType];
    if (!definition) return;
    const preset = getPresetsForType(this.currentType).find(p => p.id === this.currentPresetId) ?? null;
    const options = preset
      ? definition.options.map(o =>
          (o.type !== 'calculated' && o.name in preset.properties)
            ? { ...o, default: preset.properties[o.name] }
            : o)
      : definition.options;
    this.buildForm(options, this.currentAvailableCoresForCreate, this.currentDefaultName);
  }

  private buildForm(options: ComponentOption[], availableCores?: Array<{ id: string; label: string }>, defaultName?: string) {
    this.bodyElement.innerHTML = '';

    // Separate calculated options from input options
    const inputOptions = options.filter(o => o.type !== 'calculated');
    const calculatedOptions = options.filter(o => o.type === 'calculated');

    // Equipment design picker (presets) - create mode only
    if (this.isCreateMode && hasPresetSupport(this.currentType)) {
      this.bodyElement.appendChild(this.createDesignSection(options));
    }

    // Override default name if provided
    if (defaultName) {
      inputOptions.forEach(option => {
        if (option.name === 'name') {
          option = { ...option, default: defaultName };
          const idx = inputOptions.findIndex(o => o.name === 'name');
          if (idx >= 0) inputOptions[idx] = option;
        }
      });
    }

    // Add price estimate at the top
    const priceGroup = document.createElement('div');
    priceGroup.className = 'form-group';
    priceGroup.style.cssText = 'background: #2a2e38; padding: 10px; border-radius: 4px; margin-bottom: 15px;';

    const priceLabel = document.createElement('div');
    priceLabel.style.cssText = 'color: #7af; font-size: 12px; margin-bottom: 5px;';
    priceLabel.textContent = 'Estimated Installed Cost';

    const priceValue = document.createElement('div');
    priceValue.id = 'price-estimate';
    priceValue.style.cssText = 'font-size: 20px; font-weight: bold; color: #4a4;';
    priceValue.textContent = '$0';

    const priceBreakdown = document.createElement('div');
    priceBreakdown.id = 'price-breakdown';
    priceBreakdown.style.cssText = 'font-size: 10px; color: #889; margin-top: 5px; line-height: 1.4;';
    priceBreakdown.textContent = '';

    priceGroup.appendChild(priceLabel);
    priceGroup.appendChild(priceValue);
    priceGroup.appendChild(priceBreakdown);
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

    // Track form groups by option name for dependsOn visibility
    const formGroups: Map<string, HTMLElement> = new Map();

    // Build input fields
    inputOptions.forEach(option => {
      const formGroup = document.createElement('div');
      formGroup.className = 'form-group';
      formGroup.dataset.optionName = option.name;
      formGroups.set(option.name, formGroup);

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

          // Special case: dynamically populate core dropdown for controllers
          if (option.name === 'connectedCore' && availableCores) {
            // Add "None" option
            const noneOption = document.createElement('option');
            noneOption.value = '';
            noneOption.textContent = '-- Select a core --';
            input.appendChild(noneOption);

            // Add available cores
            availableCores.forEach(core => {
              const optionElement = document.createElement('option');
              optionElement.value = core.id;
              optionElement.textContent = core.label || core.id;
              input.appendChild(optionElement);
            });

            // Select first core by default if available
            if (availableCores.length > 0) {
              (input as HTMLSelectElement).value = availableCores[0].id;
            }
          } else if (option.name === 'connectedGenerator' && this.availableGenerators.length > 0) {
            // Special case: dynamically populate generator dropdown for switchyards
            // Add "None" option
            const noneOption = document.createElement('option');
            noneOption.value = '';
            noneOption.textContent = '-- Select a generator --';
            input.appendChild(noneOption);

            // Add available generators
            this.availableGenerators.forEach(gen => {
              const optionElement = document.createElement('option');
              optionElement.value = gen.id;
              optionElement.textContent = gen.label || gen.id;
              input.appendChild(optionElement);
            });

            // Select first generator by default if available
            if (this.availableGenerators.length > 0) {
              (input as HTMLSelectElement).value = this.availableGenerators[0].id;
            }
          } else if (option.dynamicOptions) {
            // Plant-derived choice list (flow nodes, valves, pumps, ...)
            this.populateDynamicSelect(input as HTMLSelectElement, option.dynamicOptions, undefined);
          } else if (option.options) {
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
          input.dataset.initialValue = input.value; // for range validation on confirm

          if (option.min !== undefined) input.min = String(option.min);
          if (option.max !== undefined) input.max = String(option.max);
          if (option.step !== undefined) input.step = String(option.step);
          break;

        case 'ncg':
          // NCG input is a button that opens an expandable panel
          input = document.createElement('input');
          input.type = 'hidden';
          input.id = `option-${option.name}`;
          input.name = option.name;
          input.value = JSON.stringify(option.default || {});

          // Create the NCG control panel
          const ncgPanel = this.createNcgPanel(option.name, option.default || {});
          formGroup.appendChild(ncgPanel);
          break;

        default: // text
          input = document.createElement('input');
          input.type = 'text';
          input.id = `option-${option.name}`;
          input.name = option.name;
          input.value = option.default;
          input.autocomplete = 'off';
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

    // Set up dependsOn visibility logic
    const updateDependentVisibility = () => {
      inputOptions.forEach(option => {
        if (option.dependsOn) {
          const formGroup = formGroups.get(option.name);
          const controllingInput = document.getElementById(`option-${option.dependsOn.field}`) as HTMLInputElement;
          if (formGroup && controllingInput) {
            let currentValue: any;
            if (controllingInput.type === 'checkbox') {
              currentValue = controllingInput.checked;
            } else {
              currentValue = controllingInput.value;
            }
            const depValue = option.dependsOn.value;
            const shouldShow = Array.isArray(depValue)
              ? depValue.some(v => String(v) === String(currentValue))
              : currentValue === depValue;
            formGroup.style.display = shouldShow ? '' : 'none';
          }
        }
      });
    };

    // Add change listeners for fields that control visibility
    const controllingFields = new Set(inputOptions.filter(o => o.dependsOn).map(o => o.dependsOn!.field));
    controllingFields.forEach(fieldName => {
      const input = document.getElementById(`option-${fieldName}`);
      if (input) {
        input.addEventListener('change', updateDependentVisibility);
      }
    });

    // Initial visibility update
    updateDependentVisibility();

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

    // Function to update price estimate
    const updatePriceEstimate = () => {
      const props = this.getCurrentProperties(options);
      const estimate = estimateComponentCost(this.currentType, props);

      const priceDisplay = document.getElementById('price-estimate');
      const breakdownDisplay = document.getElementById('price-breakdown');

      if (priceDisplay) {
        priceDisplay.textContent = formatCost(estimate.total);
      }

      if (breakdownDisplay) {
        const parts: string[] = [];
        if (estimate.materialCost > 0) {
          parts.push(`Material: ${formatCost(estimate.materialCost)}`);
        }
        if (estimate.fabricationCost > 0) {
          parts.push(`Fabrication: ${formatCost(estimate.fabricationCost)}`);
        }
        if (estimate.installationCost > 0) {
          parts.push(`Installation: ${formatCost(estimate.installationCost)}`);
        }
        if (estimate.nqa1Premium > 0) {
          parts.push(`NQA-1 Premium: ${formatCost(estimate.nqa1Premium)}`);
        }
        breakdownDisplay.innerHTML = parts.join('<br>');
      }
    };

    // Add event listeners to all inputs to update calculated fields and price
    const allInputs = inputContainer.querySelectorAll('input, select');
    allInputs.forEach(input => {
      // The design-picker's own controls are not part of the component config
      if ((input as HTMLElement).closest('.design-section')) return;
      input.addEventListener('input', () => {
        updateCalculatedFields();
        updatePriceEstimate();
      });
      input.addEventListener('change', () => {
        updateCalculatedFields();
        updatePriceEstimate();
      });
      // Flag the selected design as modified when any config field (except the
      // instance name) is edited, so the user knows they've departed from it
      if (input.id !== 'option-name') {
        const markModified = () => {
          const note = document.getElementById('design-modified-note');
          if (note) note.style.display = '';
        };
        input.addEventListener('input', markModified);
        input.addEventListener('change', markModified);
      }
    });

    // Initial calculations
    updateCalculatedFields();
    updatePriceEstimate();

    // Set up two-phase P/T coupling if this component has phase selection
    this.setupTwoPhaseCouplng();

    // Keep volume <-> diameter mutually consistent (tanks, pressurizers)
    this.setupGeometryCoupling();
  }

  /**
   * Build the "Equipment Design" picker shown at the top of the create
   * dialog: a dropdown of standard designs for this component type (plus the
   * user's saved designs), a description of what the selected design is for,
   * and controls to save the current settings as a new custom design.
   */
  private createDesignSection(options: ComponentOption[]): HTMLElement {
    const presets = getPresetsForType(this.currentType);
    const builtin = presets.filter(p => !p.custom);
    const custom = presets.filter(p => p.custom);
    const selected = presets.find(p => p.id === this.currentPresetId) ?? null;

    const section = document.createElement('div');
    section.className = 'design-section form-group';
    section.style.cssText = 'background: #232b3a; padding: 10px 12px; border-radius: 6px; border: 1px solid #3a4a6a; margin-bottom: 15px;';

    const label = document.createElement('div');
    label.style.cssText = 'color: #7af; font-size: 12px; margin-bottom: 6px;';
    label.textContent = 'Equipment Design';
    section.appendChild(label);

    // Design dropdown
    const select = document.createElement('select');
    select.id = 'design-preset-select';
    select.title = 'Pick a standard design to fill in all the fields below, then adjust anything you like';
    select.style.cssText = 'width: 100%;';

    const addGroup = (groupLabel: string, items: ComponentPreset[]) => {
      if (items.length === 0) return;
      const group = document.createElement('optgroup');
      group.label = groupLabel;
      items.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === this.currentPresetId) opt.selected = true;
        group.appendChild(opt);
      });
      select.appendChild(group);
    };
    addGroup('Standard designs', builtin);
    addGroup('My saved designs', custom);

    const genericOpt = document.createElement('option');
    genericOpt.value = '';
    genericOpt.textContent = 'Generic — start from type defaults';
    if (!this.currentPresetId) genericOpt.selected = true;
    select.appendChild(genericOpt);

    select.addEventListener('change', () => {
      this.currentPresetId = select.value || null;
      this.rebuildCreateForm();
    });
    section.appendChild(select);

    // Description of the selected design
    const desc = document.createElement('div');
    desc.style.cssText = 'font-size: 11px; color: #99aacc; margin-top: 6px; line-height: 1.4;';
    desc.textContent = selected
      ? selected.description || 'Saved custom design.'
      : 'Generic starting point - all fields at their type defaults.';
    section.appendChild(desc);

    // "Modified" note - hidden until the user edits a config field
    const modifiedNote = document.createElement('div');
    modifiedNote.id = 'design-modified-note';
    modifiedNote.style.cssText = 'display: none; font-size: 11px; color: #da5; margin-top: 6px;';
    modifiedNote.textContent = '✎ Modified from the selected design - save it below to reuse these settings later.';
    section.appendChild(modifiedNote);

    // Save-as-custom-design row
    const saveRow = document.createElement('div');
    saveRow.style.cssText = 'display: flex; gap: 6px; margin-top: 8px; align-items: center;';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'design-save-name';
    nameInput.placeholder = selected ? `${selected.name} (modified)` : 'Name for this design';
    nameInput.title = 'Save the current settings as a reusable design (stored in this browser)';
    nameInput.autocomplete = 'off';
    nameInput.style.cssText = 'flex: 1; min-width: 0; font-size: 11px;';
    saveRow.appendChild(nameInput);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save design';
    saveBtn.title = 'Save the current settings as a custom design you can pick from this list later';
    saveBtn.style.cssText = 'background: #3a4a5a; color: #adf; border: 1px solid #4a6a8a; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; white-space: nowrap;';
    saveBtn.addEventListener('click', () => {
      const name = nameInput.value.trim() || nameInput.placeholder;
      const properties = this.getCurrentProperties(options);
      delete properties.name; // instance name is not part of the design
      const preset: ComponentPreset = {
        id: `custom-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        type: this.currentType,
        name,
        description: `Custom ${componentDefinitions[this.currentType].displayName.toLowerCase()} design saved ${new Date().toLocaleDateString()}.`,
        properties,
        custom: true,
      };
      saveCustomPreset(preset);
      this.currentPresetId = preset.id;
      this.rebuildCreateForm();
    });
    saveRow.appendChild(saveBtn);

    // Delete button, only for a selected custom design
    if (selected?.custom) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Delete';
      deleteBtn.title = 'Delete this saved design (components already placed with it are unaffected)';
      deleteBtn.style.cssText = 'background: #3a2a2a; color: #faa; border: 1px solid #6a4a4a; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px;';
      deleteBtn.addEventListener('click', () => {
        deleteCustomPreset(selected.id);
        this.currentPresetId = null;
        this.rebuildCreateForm();
      });
      saveRow.appendChild(deleteBtn);
    }

    section.appendChild(saveRow);
    return section;
  }

  /**
   * Live coupling between a cylindrical component's volume and diameter
   * inputs (tanks, pressurizers): editing either recalculates the other via
   * V = π (d/2)² h, and editing the height keeps the volume while updating
   * the diameter. The synced value is written at 6 significant digits so the
   * pair stays consistent well inside the round-trip audit tolerance.
   * No-op on forms that lack the volume/diameter/height trio.
   */
  private setupGeometryCoupling(): void {
    const volumeInput = document.getElementById('option-volume') as HTMLInputElement | null;
    const diameterInput = document.getElementById('option-diameter') as HTMLInputElement | null;
    const heightInput = document.getElementById('option-height') as HTMLInputElement | null;
    if (!volumeInput || !diameterInput || !heightInput) return;
    // Only couple real inputs (on some forms 'diameter' is a calculated div)
    if (volumeInput.tagName !== 'INPUT' || diameterInput.tagName !== 'INPUT') return;

    const fmt = (v: number) => String(+v.toPrecision(6));
    let syncing = false;
    // Update the sibling and let its own listeners (price estimate,
    // calculated column) see the new value
    const setValue = (input: HTMLInputElement, value: number) => {
      if (!Number.isFinite(value) || value <= 0) return;
      syncing = true;
      input.value = fmt(value);
      input.dispatchEvent(new Event('input'));
      syncing = false;
    };

    const height = () => parseFloat(heightInput.value);
    const diameterFromVolume = () => {
      const v = parseFloat(volumeInput.value);
      const h = height();
      if (v > 0 && h > 0) setValue(diameterInput, 2 * Math.sqrt(v / (Math.PI * h)));
    };
    const volumeFromDiameter = () => {
      const d = parseFloat(diameterInput.value);
      const h = height();
      if (d > 0 && h > 0) setValue(volumeInput, Math.PI * Math.pow(d / 2, 2) * h);
    };

    volumeInput.addEventListener('input', () => { if (!syncing) diameterFromVolume(); });
    diameterInput.addEventListener('input', () => { if (!syncing) volumeFromDiameter(); });
    // Height changes preserve the volume (matches the model's write path)
    heightInput.addEventListener('input', () => { if (!syncing) diameterFromVolume(); });

    // Initial pass: the volume is authoritative on open (presets and stored
    // components define volume; the diameter field is derived from it).
    // Refresh initialValue afterwards so the derived prefill still counts as
    // untouched for range validation.
    diameterFromVolume();
    diameterInput.dataset.initialValue = diameterInput.value;
  }

  /**
   * Set up dynamic coupling between pressure and temperature for two-phase conditions.
   * When phase is "two-phase", temperature is calculated from saturation pressure
   * and the quality field is shown. For other phases, both P and T are independent
   * and quality is hidden.
   */
  private setupTwoPhaseCouplng(): void {
    const phaseSelect = document.getElementById('option-initialPhase') as HTMLSelectElement;
    const pressureInput = document.getElementById('option-initialPressure') as HTMLInputElement;
    const temperatureInput = document.getElementById('option-initialTemperature') as HTMLInputElement;
    const qualityInput = document.getElementById('option-initialQuality') as HTMLInputElement;
    const levelInput = document.getElementById('option-initialLevel') as HTMLInputElement;

    // Exit if this form doesn't have the relevant fields
    if (!pressureInput || !temperatureInput) return;

    // Get the form groups for showing/hiding and styling
    const tempFormGroup = temperatureInput.closest('.form-group') as HTMLElement;
    const qualityFormGroup = qualityInput?.closest('.form-group') as HTMLElement;

    // Helper to check if component is two-phase
    const isTwoPhase = (): boolean => {
      // If there's a phase selector, use it
      if (phaseSelect) {
        return phaseSelect.value === 'two-phase';
      }
      // If there's a level input (tanks, vessels), check if level is between 0-100%
      if (levelInput) {
        const level = parseFloat(levelInput.value);
        return level > 0 && level < 100;
      }
      return false;
    };

    // Helper to update saturation temperature from pressure
    // Also clamps pressure to minimum if below freezing point
    const updateSaturationTemp = () => {
      if (isTwoPhase()) {
        let pressureBar = parseFloat(pressureInput.value);
        if (isNaN(pressureBar)) pressureBar = 150;

        // Clamp to minimum pressure to keep water above freezing
        if (pressureBar < MIN_STEAM_PRESSURE_BAR) {
          pressureBar = MIN_STEAM_PRESSURE_BAR;
          // Update the pressure input to show the clamped value
          pressureInput.value = pressureBar.toFixed(5);
        }

        const pressurePa = pressureBar * 1e5;
        try {
          const satTempK = saturationTemperature(pressurePa);
          const satTempC = satTempK - 273.15;
          temperatureInput.value = satTempC.toFixed(1);
        } catch {
          // If saturation calculation fails (e.g., beyond critical point), leave as-is
        }
      }
    };

    // Helper to update form field visibility and state
    const updateFormState = () => {
      const twoPhase = isTwoPhase();

      if (tempFormGroup) {
        if (twoPhase) {
          // Make temperature read-only and show it's calculated
          temperatureInput.readOnly = true;
          temperatureInput.style.backgroundColor = '#1a1e28';
          temperatureInput.style.color = '#8cf';
          temperatureInput.style.cursor = 'not-allowed';

          // Update label to indicate it's calculated
          const tempLabel = tempFormGroup.querySelector('label');
          if (tempLabel && !tempLabel.textContent?.includes('(from sat.)')) {
            tempLabel.textContent = tempLabel.textContent?.replace(' (°C)', '') + ' (from sat.) (°C)';
          }

          // Update temperature from saturation
          updateSaturationTemp();
        } else {
          // Make temperature editable again
          temperatureInput.readOnly = false;
          temperatureInput.style.backgroundColor = '';
          temperatureInput.style.color = '';
          temperatureInput.style.cursor = '';

          // Restore label
          const tempLabel = tempFormGroup.querySelector('label');
          if (tempLabel) {
            tempLabel.textContent = tempLabel.textContent?.replace(' (from sat.)', '') || 'Initial Temperature (°C)';
          }
        }
      }

      // Show/hide quality field based on phase
      if (qualityFormGroup) {
        qualityFormGroup.style.display = twoPhase ? 'block' : 'none';
      }
    };

    // Set up event listeners
    if (phaseSelect) {
      phaseSelect.addEventListener('change', updateFormState);
    }
    if (levelInput) {
      levelInput.addEventListener('input', updateFormState);
    }
    pressureInput.addEventListener('input', () => {
      if (isTwoPhase()) {
        updateSaturationTemp();
      }
    });

    // Initial state update
    updateFormState();
  }

  /**
   * Create the NCG (Non-Condensible Gas) input panel.
   * Shows a button that expands to reveal partial pressure inputs for each gas species.
   */
  private createNcgPanel(optionName: string, initialValue: NcgInitialCondition): HTMLElement {
    const container = document.createElement('div');
    container.className = 'ncg-panel';
    container.style.cssText = 'margin-top: 4px;';

    // Summary line showing current NCG content
    const summaryLine = document.createElement('div');
    summaryLine.id = `ncg-summary-${optionName}`;
    summaryLine.style.cssText = 'font-size: 11px; color: #8af; margin-bottom: 6px;';
    this.updateNcgSummary(summaryLine, initialValue);
    container.appendChild(summaryLine);

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.textContent = '+ Add/Edit Gases';
    toggleBtn.style.cssText = `
      background: #3a4a5a; color: #adf; border: 1px solid #4a6a8a;
      padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px;
    `;
    container.appendChild(toggleBtn);

    // Expandable panel (hidden by default)
    const panel = document.createElement('div');
    panel.style.cssText = `
      display: none; margin-top: 8px; padding: 10px;
      background: #1a2a3a; border: 1px solid #3a5a7a; border-radius: 4px;
    `;

    // Gas species inputs
    const gasInputs: Map<GasSpecies, HTMLInputElement> = new Map();

    for (const species of ALL_GAS_SPECIES) {
      // CsI is a fission-product transport species, not a fill gas
      if (species === 'CsI') continue;
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; align-items: center; margin-bottom: 6px;';

      const label = document.createElement('label');
      label.style.cssText = 'width: 140px; font-size: 11px; color: #aaa;';
      label.textContent = GAS_DISPLAY_NAMES[species];

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '100';
      input.step = '0.001';
      input.value = String(initialValue[species] || 0);
      input.style.cssText = 'width: 70px; margin-right: 5px;';
      input.dataset.species = species;
      gasInputs.set(species, input);

      const unit = document.createElement('span');
      unit.style.cssText = 'font-size: 10px; color: #888;';
      unit.textContent = 'bar';

      // Color indicator
      const colorDot = document.createElement('span');
      colorDot.style.cssText = `
        width: 12px; height: 12px; border-radius: 50%; margin-left: 8px;
        background: ${GAS_PROPERTIES[species].color}; border: 1px solid #555;
      `;

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(unit);
      row.appendChild(colorDot);
      panel.appendChild(row);

      // Update hidden input and summary when value changes
      input.addEventListener('input', () => {
        this.updateNcgHiddenInput(optionName, gasInputs);
        const hiddenInput = document.getElementById(`option-${optionName}`) as HTMLInputElement;
        if (hiddenInput) {
          try {
            const val = JSON.parse(hiddenInput.value);
            this.updateNcgSummary(summaryLine, val);
          } catch { /* ignore */ }
        }
      });
    }

    // Quick-add buttons for common mixtures
    const quickAddDiv = document.createElement('div');
    quickAddDiv.style.cssText = 'margin-top: 10px; padding-top: 8px; border-top: 1px solid #3a5a7a;';

    const quickLabel = document.createElement('div');
    quickLabel.style.cssText = 'font-size: 10px; color: #888; margin-bottom: 6px;';
    quickLabel.textContent = 'Quick add:';
    quickAddDiv.appendChild(quickLabel);

    // Air button
    const airBtn = document.createElement('button');
    airBtn.type = 'button';
    airBtn.textContent = 'Air (1 bar)';
    airBtn.style.cssText = `
      background: #2a3a4a; color: #8cf; border: 1px solid #4a6a8a;
      padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 10px; margin-right: 6px;
    `;
    airBtn.addEventListener('click', () => {
      gasInputs.get('N2')!.value = '0.78';
      gasInputs.get('O2')!.value = '0.21';
      gasInputs.get('Ar')!.value = '0.009';
      this.updateNcgHiddenInput(optionName, gasInputs);
      const hiddenInput = document.getElementById(`option-${optionName}`) as HTMLInputElement;
      if (hiddenInput) {
        try {
          this.updateNcgSummary(summaryLine, JSON.parse(hiddenInput.value));
        } catch { /* ignore */ }
      }
    });
    quickAddDiv.appendChild(airBtn);

    // Clear button
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear All';
    clearBtn.style.cssText = `
      background: #3a2a2a; color: #faa; border: 1px solid #6a4a4a;
      padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 10px;
    `;
    clearBtn.addEventListener('click', () => {
      for (const input of gasInputs.values()) {
        input.value = '0';
      }
      this.updateNcgHiddenInput(optionName, gasInputs);
      this.updateNcgSummary(summaryLine, {});
    });
    quickAddDiv.appendChild(clearBtn);

    panel.appendChild(quickAddDiv);
    container.appendChild(panel);

    // Toggle expand/collapse
    toggleBtn.addEventListener('click', () => {
      const isHidden = panel.style.display === 'none';
      panel.style.display = isHidden ? 'block' : 'none';
      toggleBtn.textContent = isHidden ? '− Hide Gases' : '+ Add/Edit Gases';
    });

    return container;
  }

  /**
   * Update the hidden input field with current NCG values.
   */
  private updateNcgHiddenInput(optionName: string, gasInputs: Map<GasSpecies, HTMLInputElement>): void {
    const hiddenInput = document.getElementById(`option-${optionName}`) as HTMLInputElement;
    if (!hiddenInput) return;

    const ncg: NcgInitialCondition = {};
    for (const [species, input] of gasInputs) {
      const val = parseFloat(input.value) || 0;
      if (val > 0) {
        ncg[species] = val;
      }
    }
    hiddenInput.value = JSON.stringify(ncg);
  }

  /**
   * Update the NCG summary line showing total pressure and composition.
   */
  private updateNcgSummary(element: HTMLElement, ncg: NcgInitialCondition): void {
    let total = 0;
    const parts: string[] = [];

    for (const species of ALL_GAS_SPECIES) {
      const val = ncg[species] || 0;
      if (val > 0) {
        total += val;
        parts.push(`${species}: ${val.toFixed(3)} bar`);
      }
    }

    if (total === 0) {
      element.textContent = 'No NCGs (pure steam/water)';
      element.style.color = '#666';
    } else {
      element.textContent = `Total NCG: ${total.toFixed(3)} bar (${parts.join(', ')})`;
      element.style.color = '#8af';
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
      } else if (element.type === 'hidden' && option.type === 'ncg') {
        // Parse NCG JSON
        try {
          props[option.name] = JSON.parse(element.value);
        } catch {
          props[option.name] = {};
        }
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
      if (!name) return; // Skip unnamed inputs

      if (element.type === 'checkbox') {
        properties[name] = (element as HTMLInputElement).checked;
      } else if (element.type === 'number') {
        properties[name] = parseFloat(element.value);
      } else if (element.type === 'hidden' && name.includes('Ncg')) {
        // Parse NCG JSON from hidden input
        try {
          const parsed = JSON.parse(element.value);
          // Only store if there are actual values
          if (parsed && Object.keys(parsed).length > 0) {
            properties[name] = parsed;
          }
        } catch {
          // Ignore parse errors
        }
      } else {
        properties[name] = element.value;
      }
    });

    // Validate: every visible number field must hold a finite number inside
    // its declared range (catches NaN from garbage text and typos like
    // 3000500 MWt that HTML number inputs happily accept)
    const rangeError = this.validateNumberRanges(properties);
    if (rangeError) {
      this.showValidationError(rangeError);
      return;
    }

    // Validate: initial pressure must not exceed pressure rating
    const pressureError = this.validatePressure(properties);
    if (pressureError) {
      this.showValidationError(pressureError);
      return;
    }

    // Validate: two-phase fluid must not have extremely low density
    const densityError = this.validateFluidDensity(properties);
    if (densityError) {
      this.showValidationError(densityError);
      return;
    }

    // Validate: PID controller sensor/actuator wiring
    if (this.currentType === 'pid-controller') {
      const pidError = this.validatePidConfig(properties);
      if (pidError) {
        this.showValidationError(pidError);
        return;
      }
    }

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

  /**
   * Validate PID controller wiring: required targets must be selected, and
   * control rods only work with the sensor kinds the rod controller supports.
   */
  private validatePidConfig(props: Record<string, any>): string | null {
    const sensorKind = props.sensorKind;
    const actuatorKind = props.actuatorKind;

    if (sensorKind === 'connection-flow') {
      if (!props.sensorConnection) return 'Select the flow path to measure';
    } else if (sensorKind !== 'reactor-power') {
      if (!props.sensorNode) return 'Select the component to measure';
    }

    switch (actuatorKind) {
      case 'valve-position':
        if (!props.actuatorValve) return 'Select the valve to control';
        break;
      case 'pump-speed':
        if (!props.actuatorPump) return 'Select the pump to control';
        break;
      case 'governor-valve':
        if (!props.actuatorTurbine) return 'Select the turbine to control';
        break;
      case 'heater-power':
        if (!props.actuatorHeaterNode) return 'Select the component containing the heaters';
        break;
      case 'control-rods':
        if (sensorKind === 'node-level' || sensorKind === 'connection-flow') {
          return 'Control rods work with reactor power, temperature, or pressure measurements (not level or flow)';
        }
        break;
    }

    if (props.outputMinPct !== undefined && props.outputMaxPct !== undefined &&
        props.outputMinPct >= props.outputMaxPct) {
      return 'Output minimum must be below output maximum';
    }

    return null;
  }

  /**
   * Validate that initial pressure does not exceed pressure rating,
   * and that pressure rating is at least the hydrostatic head for tanks.
   */
  private validatePressure(properties: Record<string, any>): string | null {
    const initialPressure = properties.initialPressure;
    const pressureRating = properties.pressureRating;

    // Only validate if both fields exist
    if (initialPressure !== undefined && pressureRating !== undefined) {
      if (initialPressure > pressureRating) {
        return `Initial pressure (${initialPressure} bar) cannot exceed pressure rating (${pressureRating} bar)`;
      }
    }

    // For tanks, check that pressure rating is at least the hydrostatic head
    if (this.currentType === 'tank' || this.currentType === 'pressurizer') {
      const height = properties.height;
      if (height !== undefined && pressureRating !== undefined) {
        // Hydrostatic pressure: P = ρgh, where ρ = 1000 kg/m³, g = 9.81 m/s²
        const hydrostaticBar = (1000 * 9.81 * height) / 1e5;
        if (pressureRating < hydrostaticBar) {
          return `Pressure rating (${pressureRating} bar) must be at least ${hydrostaticBar.toFixed(2)} bar to contain a ${height}m water column`;
        }
      }
    }

    return null;
  }

  /**
   * Validate that two-phase fluid conditions won't result in extremely low density.
   * At very low pressures with high quality, steam density becomes extremely low,
   * causing simulation sanity check failures.
   */
  private validateFluidDensity(properties: Record<string, any>): string | null {
    const phase = properties.initialPhase;
    const quality = properties.initialQuality;
    const pressure = properties.initialPressure; // bar

    // Only check two-phase conditions
    if (phase !== 'two-phase' || quality === undefined || pressure === undefined) {
      return null;
    }

    // At low pressures, high-quality steam has very low density
    // Pure saturated steam at condenser pressures (~0.05 bar) has density ~0.03 kg/m³
    // This is physically normal for turbine exhaust and condensers.
    //
    // Only warn if density is extremely low (< 0.01 kg/m³), which would indicate
    // unrealistic conditions that might cause numerical issues.

    const P_Pa = pressure * 1e5;

    // Approximate saturation temperature from pressure (Clausius-Clapeyron approximation)
    // T_sat ≈ 373 + 42 * ln(P/101325) for rough estimate
    const T_sat = 373 + 42 * Math.log(P_Pa / 101325);

    // Saturated vapor density (ideal gas approximation)
    const R_WATER = 461.5;
    const rho_vapor = P_Pa / (R_WATER * T_sat);

    // Saturated liquid density (approximate)
    const T_C = T_sat - 273.15;
    const rho_liquid = T_C < 100 ? 1000 - 0.08 * T_C :
                       T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                       700 - 2.5 * (T_C - 300);

    // Two-phase mixture density
    const rho_mixture = 1 / (quality / rho_vapor + (1 - quality) / rho_liquid);

    // Only warn for extremely low densities that might cause numerical issues
    // Density < 0.01 kg/m³ corresponds to specific volume > 100 m³/kg
    if (rho_mixture < 0.01) {
      return `Two-phase conditions (${pressure.toFixed(2)} bar, ${(quality * 100).toFixed(0)}% quality) would result in extremely low density (${rho_mixture.toFixed(4)} kg/m³). Try lowering quality or increasing pressure.`;
    }

    return null;
  }

  /**
   * Show a validation error message in the dialog
   */
  /**
   * Every visible number input must contain a finite number within the
   * option's declared [min, max]. Fields hidden by dependsOn are skipped
   * (their values are not used). Fields the user did NOT touch are exempt
   * from the range check (edit dialogs can legitimately prefill values
   * outside the spinner range, e.g. a pipe length derived from endpoints) -
   * but never from the not-a-number check.
   */
  private validateNumberRanges(properties: Record<string, any>): string | null {
    const definition = componentDefinitions[this.currentType];
    if (!definition) return null;

    for (const option of definition.options) {
      if (option.type !== 'number') continue;
      const input = document.getElementById(`option-${option.name}`) as HTMLInputElement | null;
      if (!input) continue;

      // Skip fields hidden by dependsOn
      const group = input.closest('.form-group') as HTMLElement | null;
      if (group && group.style.display === 'none') continue;

      const value = properties[option.name];
      const label = option.label + (option.unit ? ` (${option.unit})` : '');
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${label}: '${input.value}' is not a number`;
      }

      const untouched = input.dataset.initialValue !== undefined &&
        input.value === input.dataset.initialValue;
      if (untouched) continue;

      if (option.min !== undefined && value < option.min) {
        return `${label}: ${value} is below the minimum of ${option.min}`;
      }
      if (option.max !== undefined && value > option.max) {
        return `${label}: ${value} is above the maximum of ${option.max}`;
      }
    }
    return null;
  }

  private showValidationError(message: string): void {
    // Remove any existing error message
    const existingError = this.bodyElement.querySelector('.validation-error');
    if (existingError) {
      existingError.remove();
    }

    // Create error message element
    const errorDiv = document.createElement('div');
    errorDiv.className = 'validation-error';
    errorDiv.style.cssText = 'background: #422; color: #f88; padding: 10px; border-radius: 4px; margin-bottom: 10px; border: 1px solid #633;';
    errorDiv.textContent = message;

    // Insert at the top of the form
    this.bodyElement.insertBefore(errorDiv, this.bodyElement.firstChild);

    // Scroll to show error
    this.bodyElement.scrollTop = 0;
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
    callback: (properties: Record<string, any> | null) => void,
    availableCores?: Array<{ id: string; label: string }>,
    availableGenerators?: Array<{ id: string; label: string }>
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
    this.isCreateMode = false; // no design picker when editing an existing component
    this.availableCores = availableCores || [];
    this.availableGenerators = availableGenerators || [];
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
   * (shared with the sync audit - see component-properties.ts)
   */
  private mapComponentTypeToDefinition(type: string, component?: Record<string, any>): string {
    return mapComponentTypeToDefinition(type, component);
  }

  /**
   * Build form with existing component values
   */
  private buildFormWithValues(options: ComponentOption[], component: Record<string, any>) {
    this.bodyElement.innerHTML = '';

    // Separate calculated options from input options
    const inputOptions = options.filter(o => o.type !== 'calculated');
    const calculatedOptions = options.filter(o => o.type === 'calculated');

    // Add price estimate at the top (also show for editing)
    const priceGroup = document.createElement('div');
    priceGroup.className = 'form-group';
    priceGroup.style.cssText = 'background: #2a2e38; padding: 10px; border-radius: 4px; margin-bottom: 15px;';

    const priceLabel = document.createElement('div');
    priceLabel.style.cssText = 'color: #7af; font-size: 12px; margin-bottom: 5px;';
    priceLabel.textContent = 'Estimated Installed Cost';

    const priceValue = document.createElement('div');
    priceValue.id = 'price-estimate';
    priceValue.style.cssText = 'font-size: 20px; font-weight: bold; color: #4a4;';
    priceValue.textContent = '$0';

    const priceBreakdown = document.createElement('div');
    priceBreakdown.id = 'price-breakdown';
    priceBreakdown.style.cssText = 'font-size: 10px; color: #889; margin-top: 5px; line-height: 1.4;';
    priceBreakdown.textContent = '';

    priceGroup.appendChild(priceLabel);
    priceGroup.appendChild(priceValue);
    priceGroup.appendChild(priceBreakdown);
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

    // Track form groups by option name for dependsOn visibility
    const formGroups: Map<string, HTMLElement> = new Map();

    // Build input fields with existing values
    inputOptions.forEach(option => {
      const formGroup = document.createElement('div');
      formGroup.className = 'form-group';
      formGroup.dataset.optionName = option.name;
      formGroups.set(option.name, formGroup);

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

          // Special case: dynamically populate core dropdown for controllers
          if (option.name === 'connectedCore' && this.availableCores.length > 0) {
            // Add "None" option
            const noneOption = document.createElement('option');
            noneOption.value = '';
            noneOption.textContent = '-- Select a core --';
            if (!existingValue) {
              noneOption.selected = true;
            }
            input.appendChild(noneOption);

            // Add available cores
            this.availableCores.forEach(core => {
              const optionElement = document.createElement('option');
              optionElement.value = core.id;
              optionElement.textContent = core.label || core.id;
              if (core.id === existingValue) {
                optionElement.selected = true;
              }
              input.appendChild(optionElement);
            });
          } else if (option.name === 'connectedGenerator' && this.availableGenerators.length > 0) {
            // Special case: dynamically populate generator dropdown for switchyards
            const noneOption = document.createElement('option');
            noneOption.value = '';
            noneOption.textContent = '-- Select a generator --';
            if (!existingValue) {
              noneOption.selected = true;
            }
            input.appendChild(noneOption);

            this.availableGenerators.forEach(gen => {
              const optionElement = document.createElement('option');
              optionElement.value = gen.id;
              optionElement.textContent = gen.label || gen.id;
              if (gen.id === existingValue) {
                optionElement.selected = true;
              }
              input.appendChild(optionElement);
            });
          } else if (option.dynamicOptions) {
            // Plant-derived choice list (flow nodes, valves, pumps, ...)
            this.populateDynamicSelect(input as HTMLSelectElement, option.dynamicOptions, existingValue);
          } else if (option.options) {
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
          input.dataset.initialValue = input.value; // for range validation on confirm

          if (option.min !== undefined) input.min = String(option.min);
          if (option.max !== undefined) input.max = String(option.max);
          if (option.step !== undefined) input.step = String(option.step);
          break;

        case 'ncg':
          // NCG input is a button that opens an expandable panel
          input = document.createElement('input');
          input.type = 'hidden';
          input.id = `option-${option.name}`;
          input.name = option.name;
          // existingValue may be an object or undefined
          const ncgValue = (existingValue && typeof existingValue === 'object') ? existingValue : {};
          input.value = JSON.stringify(ncgValue);

          // Create the NCG control panel with existing values
          const ncgPanelEdit = this.createNcgPanel(option.name, ncgValue);
          formGroup.appendChild(ncgPanelEdit);
          break;

        default: // text
          input = document.createElement('input');
          input.type = 'text';
          input.id = `option-${option.name}`;
          input.name = option.name;
          input.value = String(existingValue);
          input.autocomplete = 'off';
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

    // Set up dependsOn visibility logic
    const updateDependentVisibility = () => {
      inputOptions.forEach(option => {
        if (option.dependsOn) {
          const formGroup = formGroups.get(option.name);
          const controllingInput = document.getElementById(`option-${option.dependsOn.field}`) as HTMLInputElement;
          if (formGroup && controllingInput) {
            let currentValue: any;
            if (controllingInput.type === 'checkbox') {
              currentValue = controllingInput.checked;
            } else {
              currentValue = controllingInput.value;
            }
            const depValue = option.dependsOn.value;
            const shouldShow = Array.isArray(depValue)
              ? depValue.some(v => String(v) === String(currentValue))
              : currentValue === depValue;
            formGroup.style.display = shouldShow ? '' : 'none';
          }
        }
      });
    };

    // Add change listeners for fields that control visibility
    const controllingFields = new Set(inputOptions.filter(o => o.dependsOn).map(o => o.dependsOn!.field));
    controllingFields.forEach(fieldName => {
      const input = document.getElementById(`option-${fieldName}`);
      if (input) {
        input.addEventListener('change', updateDependentVisibility);
      }
    });

    // Initial visibility update
    updateDependentVisibility();

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

      // Initial calculation
      updateCalculatedFields();
    }

    // Function to update price estimate
    const updatePriceEstimate = () => {
      const props = this.getCurrentProperties(options);
      const estimate = estimateComponentCost(this.currentType, props);

      const priceDisplay = document.getElementById('price-estimate');
      const breakdownDisplay = document.getElementById('price-breakdown');

      if (priceDisplay) {
        priceDisplay.textContent = formatCost(estimate.total);
      }

      if (breakdownDisplay) {
        const parts: string[] = [];
        if (estimate.materialCost > 0) {
          parts.push(`Material: ${formatCost(estimate.materialCost)}`);
        }
        if (estimate.fabricationCost > 0) {
          parts.push(`Fabrication: ${formatCost(estimate.fabricationCost)}`);
        }
        if (estimate.installationCost > 0) {
          parts.push(`Installation: ${formatCost(estimate.installationCost)}`);
        }
        if (estimate.nqa1Premium > 0) {
          parts.push(`NQA-1 Premium: ${formatCost(estimate.nqa1Premium)}`);
        }
        breakdownDisplay.innerHTML = parts.join('<br>');
      }
    };

    // Add event listeners to all inputs to update calculated fields and price
    const allInputs = inputContainer.querySelectorAll('input, select');
    allInputs.forEach(input => {
      input.addEventListener('input', updatePriceEstimate);
      input.addEventListener('change', updatePriceEstimate);
    });

    // Initial price calculation
    updatePriceEstimate();

    // Set up two-phase P/T coupling if this component has phase selection
    this.setupTwoPhaseCouplng();

    // Keep volume <-> diameter mutually consistent (tanks, pressurizers)
    this.setupGeometryCoupling();
  }

  /**
   * Populate a select from a dynamicChoices list. Selects the existing value
   * when provided (edit), else the first entry (create).
   */
  private populateDynamicSelect(
    input: HTMLSelectElement,
    listName: string,
    existingValue: string | undefined
  ): void {
    const choices = this.dynamicChoices[listName] || [];
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = choices.length > 0 ? '-- Select --' : '-- None available --';
    input.appendChild(noneOption);
    choices.forEach(choice => {
      const optionElement = document.createElement('option');
      optionElement.value = choice.id;
      optionElement.textContent = choice.label || choice.id;
      if (choice.id === existingValue) {
        optionElement.selected = true;
      }
      input.appendChild(optionElement);
    });
    if (existingValue === undefined && choices.length > 0) {
      input.value = choices[0].id;
    }
  }

  /**
   * Get existing value from component, handling property name mapping.
   * Delegates to the shared read path in component-properties.ts so the
   * dialog, the cost panel, and the round-trip sync audit all agree.
   */
  private getExistingValue(optionName: string, component: Record<string, any>, defaultValue: any): any {
    return readComponentOption(optionName, component, defaultValue);
  }
}

/**
 * One dialog field that did not survive the round trip through the model.
 */
export interface SyncMismatch {
  name: string;
  label: string;
  submitted: any;
  actual: any;
}

/** Normalize an NCG object for comparison: drop zero/undefined species. */
function normalizeNcg(value: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (typeof v === 'number' && v > 0) out[key] = v;
    }
  }
  return out;
}

function optionValuesMatch(option: ComponentOption, submitted: any, actual: any): boolean {
  if (option.type === 'number') {
    const a = Number(submitted);
    const b = Number(actual);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return !Number.isFinite(a) && !Number.isFinite(b);
    // Relative 1e-4: loose enough for display-precision rounding of coupled
    // fields (volume<->diameter sync at 6 significant digits), tight enough
    // to catch every unit-conversion or offset bug (K vs °C, Pa vs bar, %).
    return Math.abs(a - b) <= Math.max(1e-9, 1e-4 * Math.max(Math.abs(a), Math.abs(b)));
  }
  if (option.type === 'checkbox') {
    return Boolean(submitted) === Boolean(actual);
  }
  if (option.type === 'ncg') {
    return JSON.stringify(normalizeNcg(submitted)) === JSON.stringify(normalizeNcg(actual));
  }
  return String(submitted ?? '') === String(actual ?? '');
}

/**
 * Round-trip audit: after an edit has been applied to the model, re-read
 * every dialog option from the component and compare it against what the
 * dialog submitted. Any surviving difference means the write path
 * (ConstructionManager.updateComponent) and the read path
 * (readComponentOption) disagree - i.e. the edit silently didn't stick, or
 * would reopen showing something else. Callers should surface mismatches
 * LOUDLY (anti-robustness principle): every entry returned here is a bug or
 * an intentional model-side adjustment the user must be told about.
 *
 * Fields hidden by dependsOn at the submitted values are skipped (their
 * values are not meant to be applied), as are options marked syncExempt
 * (documented one-way fields, e.g. pipe length which is recomputed from the
 * endpoints).
 */
export function auditComponentEditSync(
  component: Record<string, any>,
  submitted: Record<string, any>
): SyncMismatch[] {
  const definitionKey = mapComponentTypeToDefinition(component.type, component);
  const definition = componentDefinitions[definitionKey];
  if (!definition) return [];

  const mismatches: SyncMismatch[] = [];
  for (const option of definition.options) {
    if (option.type === 'calculated' || option.syncExempt) continue;
    const sub = submitted[option.name];
    if (sub === undefined) continue;

    // Skip fields that were hidden by dependsOn - their values are inert
    if (option.dependsOn) {
      const controlling = submitted[option.dependsOn.field];
      const dep = option.dependsOn.value;
      const active = Array.isArray(dep)
        ? dep.some(v => String(v) === String(controlling))
        : String(dep) === String(controlling);
      if (!active) continue;
    }

    const actual = readComponentOption(option.name, component, option.default);
    if (!optionValuesMatch(option, sub, actual)) {
      mismatches.push({ name: option.name, label: option.label, submitted: sub, actual });
    }
  }
  return mismatches;
}