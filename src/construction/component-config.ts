// Component configuration definitions and dialog system

import { saturationTemperature, saturationPressure } from '../simulation/water-properties';
import { estimateComponentCost, formatCost } from './cost-estimation';
import { ALL_GAS_SPECIES, GAS_PROPERTIES, type GasSpecies } from '../simulation/gas-properties';
import { deriveControlRodWorth, type LatticeParams } from '../simulation/lattice';
import { corePebbleGeometry } from '../simulation/factory';
import {
  ComponentPreset,
  getPresetsForType,
  getPresetById,
  hasPresetSupport,
  saveCustomPreset,
  deleteCustomPreset,
  PIPE_SPECS
} from './component-presets';
import { readComponentOption, mapComponentTypeToDefinition } from './component-properties';
import {
  STOCKABLE_TYPES, stockLineKey, storedTypeForPaletteKey, typeDisplayName,
} from '../game/stock';
import type { ComponentType, StockLine } from '../types';

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

/**
 * Why a placement form can be read but not changed. One string so the plate,
 * the tooltip on every locked field and the docs cannot drift apart.
 */
export const YARD_FIXED_DESIGN_TOOLTIP =
  'This part comes from the supply yard as-is: it is already built to this ' +
  'design, so only its name and where you put it are yours to set.';

export interface ComponentConfig {
  type: string;
  name: string;
  position: { x: number; y: number };
  properties: Record<string, any>;
  containedBy?: string;  // ID of container component (tank, vessel, containment building)
  // The equipment design (component-presets id) this was configured from,
  // when one was selected. Rides onto the built component so a warehouse
  // refund goes back to the line the part came out of.
  design?: string;
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
  // 'stockLines' is the warehouse's equipment list: a repeatable list of
  // { type, design?, count } rows, edited as the same array the model stores.
  type: 'number' | 'text' | 'select' | 'checkbox' | 'calculated' | 'ncg' | 'stockLines';
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
  // Shown only when the plant has the electrical model on (the power supply
  // fields). With it off the field is not in the form and nothing is submitted.
  electricalOnly?: boolean;
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
      { name: 'waterBody', type: 'text', label: 'Draw As Water Body', default: '',
        help: 'ID of a terrain water body (the sea or lake on this site) that this tank IS. Leave blank for an ordinary tank. Set, and no vessel is drawn at all: the blue water the map already paints for that body becomes the component picture, only its nozzle is shown - at the water edge, where a pipe can be dragged to it - and selecting it lights up the whole body. Nothing about the physics changes: it is still one tank node with a finite inventory, so a sea can be pumped dry.' },
      // Radiant cavity surface (reactor cavity cooling panels and the like)
      { name: 'radiantSurface', type: 'checkbox', label: 'Radiant cavity surface', default: false,
        help: 'Make this tank a cooled panel that absorbs THERMAL RADIATION from another component across an open gas gap. This is how a reactor cavity cooling system works: water-filled standpipes ringing a hot vessel, taking its heat with no pump, no valve and no signal in the path. The duty follows T⁴, so it strengthens by itself as the thing it faces heats up.' },
      { name: 'radiantFaces', type: 'text', label: 'Faces Component', default: '', dependsOn: { field: 'radiantSurface', value: true },
        help: 'ID of the component whose wall this surface trades radiation with (e.g. rv-1). That component needs a wall thermal node, and one of the two must enclose the other - they are treated as concentric cylinders.' },
      { name: 'radiantDiameter', type: 'number', label: 'Surface Diameter', default: 6, min: 0.1, max: 60, step: 0.1, unit: 'm', dependsOn: { field: 'radiantSurface', value: true },
        help: 'Diameter of the cylinder this surface forms - for a ring of standpipes, the circle they stand on. Deliberately separate from the tank\'s own width, which sets the WATER inventory: a lumped bank of tubes has a bore, not a diameter. The views draw the tank as that ring of standpipes (as many tubes as the water volume fills at the passage bore) centred on the tank\'s own position, so place the tank at the position of the vessel it faces to wrap it. Only the back half of the ring is drawn, so the vessel inside stays in view.' },
      { name: 'radiantHeight', type: 'number', label: 'Surface Height', default: 10, min: 0.1, max: 60, step: 0.5, unit: 'm', dependsOn: { field: 'radiantSurface', value: true },
        help: 'Vertical extent of the exchange. Only the height both surfaces share does any radiating.' },
      { name: 'radiantEmissivity', type: 'number', label: 'Surface Emissivity', default: 0.9, min: 0.05, max: 1, step: 0.05, dependsOn: { field: 'radiantSurface', value: true },
        help: 'This surface. Cavity panels are deliberately blackened for exactly this reason - painted steel is ~0.9.' },
      { name: 'radiantFacingEmissivity', type: 'number', label: 'Facing Emissivity', default: 0.8, min: 0.05, max: 1, step: 0.05, dependsOn: { field: 'radiantSurface', value: true },
        help: 'The other component\'s wall. Oxidised carbon steel is ~0.8; polished metal is far lower and would cripple the path.' },
      { name: 'radiantThickness', type: 'number', label: 'Surface Metal Thickness', default: 6, min: 0.5, max: 100, step: 0.5, unit: 'mm', dependsOn: { field: 'radiantSurface', value: true },
        help: 'Sets the panel\'s thermal mass - how long it takes to respond, not how much it eventually carries.' },
      { name: 'radiantBore', type: 'number', label: 'Coolant Passage Bore', default: 60, min: 1, max: 2000, step: 5, unit: 'mm', dependsOn: { field: 'radiantSurface', value: true },
        help: 'Bore of the tubes the coolant actually runs in, used for the panel-to-water convection. The tank is one well-mixed lump, so its nominal diameter is not a flow passage and using it would price the water side as a plenum.' },
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
      { name: 'ratedRpm', type: 'number', label: 'Rated Speed', default: 1800, min: 900, max: 3600, step: 100, unit: 'RPM', help: "Motor speed at 100%. Informational: the rated flow and head above are what the pump does at 100% speed. The running speed is set from the pump's panel once it is built." },
      { name: 'efficiency', type: 'number', label: 'Efficiency', default: 85, min: 50, max: 95, step: 5, unit: '%' },
      { name: 'npshRequired', type: 'number', label: 'NPSH Required', default: 5, min: 1, max: 30, step: 0.5, unit: 'm', help: "Net positive suction head the impeller needs: (suction pressure - vapour pressure) as metres of liquid. Below it the pump cavitates and loses head. A pump lifting from below has only the atmosphere's ~10 m to spend, less the lift and the friction, so a high-NPSHr pump must stand near or below its source." },
      { name: 'motorElevation', type: 'number', label: 'Motor Height', default: 0.5, min: 0, max: 30, step: 0.5, unit: 'm', help: "Height of the motor above the pump's base - the part that drowns. Standing water above it stops the pump; a wave above it carries the pump away. A horizontal pump keeps its motor at shaft height (~0.5 m). A vertical wet-pit intake pump stands its motor on a column several metres above the bowl, so the bowl can sit under water while the motor stays dry." },
      { name: 'initialFill', type: 'select', label: 'Casing Fill', default: 'primed', help: "What the casing holds when the pump is built. Primed: full of liquid, as a commissioned plant's pumps are. Dry: air - a pump delivered from the yard. A dry pump fills only if its suction is flooded (the source stands higher than its nozzle, or is pressurised); a centrifugal pump full of air cannot draw water up to itself.", options: [
        { value: 'primed', label: 'Primed (full of liquid)' },
        { value: 'dry', label: 'Dry (air - fills only from a flooded suction)' }
      ]},
      { name: 'dischargeCheck', type: 'checkbox', label: 'Discharge check valve', default: false, help: "A non-return flap on the discharge nozzle, as vertical wet-pit pumps and most service pumps carry. Without one a stopped pump is an open pipe: a line from a tank standing above the pump siphons back through it." },
      { name: 'initialState', type: 'select', label: 'Initial State', default: 'on', help: "Whether the pump runs when the plant starts. A pump with a line missing on either side never starts by itself - its open nozzle simply faces the air - and can be started from its panel once built.", options: [
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
      { name: 'inletPressure', type: 'number', label: 'Inlet Pressure', default: 60, min: 10, max: 100, step: 5, unit: 'bar', help: 'Steam supply (throttle) pressure the machine is built for - sets the rated steam flow and the design point below. The casing itself starts at exhaust pressure (a machine before steam admission holds condenser-side steam, not live steam). After a simulation has run, this shows the CURRENT casing condition (it becomes the restart condition if you edit the turbine).' },
      { name: 'designInletPressure', type: 'number', label: 'Design Inlet Pressure', default: 0, min: 0, max: 250, step: 5, unit: 'bar', help: 'Design point for the swallowing capacity (Stodola cone law, with Rated Steam Flow). 0 = freeze automatically at the inlet pressure when the simulation first starts; it does not move on mode-switch resumes.' },
      { name: 'exhaustPressure', type: 'number', label: 'Exhaust Pressure', default: 0.05, min: 0.01, max: 1, step: 0.01, unit: 'bar' },
      { name: 'turbineEfficiency', type: 'number', label: 'Turbine Isentropic Eff.', default: 85, min: 70, max: 95, step: 5, unit: '%' },
      { name: 'generatorEfficiency', type: 'number', label: 'Generator Efficiency', default: 98, min: 95, max: 99, step: 0.5, unit: '%' },
      { name: 'governorValve', type: 'number', label: 'Governor Valve Position', default: 100, min: 0, max: 100, step: 5, unit: '%' },
      // Generator and rotor (electrical model only)
      { name: 'terminalVoltage', type: 'number', label: 'Generator Terminal Voltage', default: 22000, min: 400, max: 30000, step: 100, unit: 'V',
        electricalOnly: true,
        help: 'What a transformer or bus fed straight from the generator (a unit auxiliary transformer) must be built for. Large units generate at 18-25 kV. The switchyard steps it up to transmission voltage itself.' },
      { name: 'inertiaH', type: 'number', label: 'Rotor Inertia Constant H', default: 4, min: 0.5, max: 15, step: 0.5, unit: 's',
        electricalOnly: true,
        help: 'Kinetic energy of the turbine-generator shaft at rated speed, in seconds of rated output. Large steam sets are 3-5 s. On a loss of the grid at full power the rotor gains about 1/(2H) of rated speed per second until something takes the steam away.' },
      { name: 'speedGovernor', type: 'checkbox', label: 'Speed governor', default: true,
        electricalOnly: true,
        help: 'Closes the control valves as speed rises above rated (droop), then resets to hold an island at rated speed. Without one, a loss of the grid at power runs the rotor straight up to the overspeed trip.' },
      { name: 'speedDroop', type: 'number', label: 'Governor Droop', default: 5, min: 1, max: 12, step: 0.5, unit: '%',
        electricalOnly: true, dependsOn: { field: 'speedGovernor', value: true },
        help: 'Speed rise that closes the control valves completely: at 5%, 105% speed means fully shut. Smaller is stiffer.' },
      { name: 'overspeedTrip', type: 'number', label: 'Overspeed Trip', default: 110, min: 103, max: 120, step: 1, unit: '% speed',
        electricalOnly: true,
        help: 'Above this speed the turbine trips: stop valves shut, generator breaker opens, and the rotor coasts down. Real machines trip at about 110%.' },
      // Extraction ports for feedwater heating
      { name: 'extraction1Pressure', type: 'number', label: 'Extraction 1 Pressure', default: 0, min: 0, max: 50, step: 1, unit: 'bar', help: 'High-pressure extraction for HP feedwater heater. A nonzero pressure adds a connectable extraction port on the casing bottom; set to 0 to remove it (disconnect its piping first). Steam is only bled while the pressure sits inside the machine\'s live inlet-to-exhaust range.' },
      { name: 'extraction2Pressure', type: 'number', label: 'Extraction 2 Pressure', default: 0, min: 0, max: 30, step: 0.5, unit: 'bar', help: 'Intermediate-pressure extraction. A nonzero pressure adds a connectable extraction port on the casing bottom; set to 0 to remove it (disconnect its piping first).' },
      { name: 'extraction3Pressure', type: 'number', label: 'Extraction 3 Pressure', default: 0, min: 0, max: 10, step: 0.1, unit: 'bar', help: 'Low-pressure extraction for LP feedwater heater or deaerator. A nonzero pressure adds a connectable extraction port on the casing bottom; set to 0 to remove it (disconnect its piping first).' },
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
      { name: 'startupSourceNps', type: 'number', label: 'Startup Neutron Source', default: 1e9, min: 0, step: 1e8, unit: 'n/s',
        help: 'Strength of the installed startup source (a californium capsule or activated antimony-beryllium rods), in neutrons per second. ' +
          'It is what a shut-down core multiplies: fission power settles at s·E_fission·k/(1-k), so at 5 $ subcritical this default (10⁹ n/s) ' +
          'holds a 1000 MWt core near 1 W, about 1e-9 of rated - the bottom of a real source range. Real assemblies run 1e8 to 1e9 n/s. ' +
          'Set 0 for no installed source: the core then relies on spontaneous fission of its own U-238 (and, once it has been operated, of the ' +
          'curium in irradiated fuel), which is thousands of times weaker - a cold, fresh core would take far longer to bring up, which is ' +
          'exactly why real plants install one.' },
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

  // Supply yard: the level's parts list, standing on the map
  'warehouse': {
    displayName: 'Warehouse',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Warehouse' },
      { name: 'width', type: 'number', label: 'Width', default: 6, min: 2, max: 60, step: 0.5, unit: 'm',
        help: 'Plan width of the yard. Cosmetic - it does not change what the yard holds.' },
      { name: 'depth', type: 'number', label: 'Depth', default: 4, min: 2, max: 60, step: 0.5, unit: 'm',
        help: 'Plan depth of the yard. Cosmetic - it does not change what the yard holds.' },
      { name: 'stockPipeMeters', type: 'number', label: 'Pipe in Stock', default: 0, min: 0, max: 100000, step: 10, unit: 'm',
        help: 'Total metres of pipe on the racks. Every connection and every pipe component spends its own length; deleting one puts the metres back, and editing a run pays or refunds the difference.' },
      { name: 'stockPipeSpec', type: 'select', label: 'Pipe Line Size', default: '',
        options: [{ value: '', label: 'Any size - the builder picks' },
          ...PIPE_SPECS.map(s => ({ value: s.id, label: s.label }))],
        help: 'The one standardized line size this pipe IS. Pick a size and the connection dialog shows it fixed, with only the route and the length left to the builder. Leave it on "Any size" for a yard that just holds bulk pipe.' },
      { name: 'stockLines', type: 'stockLines', label: 'Equipment in Stock', default: [],
        help: 'What is standing in the yard, one line per part. Pick an equipment DESIGN and that is exactly what gets placed - no design choice at placement, because the part is already built. Choose "Generic" instead to hand out an unspecified part of that type, which is what a yard held before designs. All four valve buttons draw on a valve line, and a pressurizer draws on a tank line.' },
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
  // Spent-fuel pool
  'pool': {
    displayName: 'Spent Fuel Pool',
    options: [
      { name: 'name', type: 'text', label: 'Name', default: 'Spent Fuel Pool' },
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true },
      { name: 'elevation', type: 'number', label: 'Elevation (Floor)', default: -12, min: -50, max: 50, step: 0.5, unit: 'm',
        help: 'Height of the pool FLOOR above the local ground. Elevation is measured from the ground everywhere in the plant, so a pool sunk to grade sits at minus its depth (-12 m for a 12 m pool) and its rim lands at 0.' },
      { name: 'side', type: 'number', label: 'Side Length', default: 12, min: 2, max: 60, step: 0.5, unit: 'm',
        help: 'The pool is square in plan. Water volume is side x side x depth, less what the fuel rods displace.' },
      { name: 'depth', type: 'number', label: 'Depth', default: 12, min: 1, max: 30, step: 0.5, unit: 'm',
        help: 'Floor to rim. The water standing over the racks is the whole safety margin: it is both the heat sink and the shield.' },
      { name: 'wallThickness', type: 'number', label: 'Wall Thickness', default: 1.5, min: 0.1, max: 4, step: 0.1, unit: 'm',
        help: 'Reinforced concrete wall behind the stainless liner. Drawn thickness only - the pool is not a pressure vessel.' },
      { name: 'fuelPower', type: 'number', label: 'Decay Heat', default: 5, min: 0, max: 100, step: 0.5, unit: 'MW',
        help: 'Total heat generated by the stored fuel. CONSTANT - the racks do not follow a decay curve, so the hazard does not fade while you work.' },
      { name: 'fuelAgeDays', type: 'number', label: 'Out of the Reactor', default: 30, min: 1, max: 36500, step: 1, unit: 'days',
        help: 'How long ago this fuel was discharged. It does NOT change the heat (that is the Decay Heat above) - it says how RADIOACTIVE the racks are. The same 5 MW made by month-old fuel came off a far bigger core than the same 5 MW made by decade-old fuel, and carries far more caesium and xenon with it.' },
      { name: 'assemblyCount', type: 'number', label: 'Stored Assemblies', default: 800, min: 1, max: 10000, step: 10,
        help: 'How many spent assemblies stand in the racks. With the rod design below this sets the wetted surface and the metal that has to be cooled.' },
      { name: 'rodsPerAssembly', type: 'number', label: 'Rods per Assembly', default: 264, min: 1, max: 1000, step: 1,
        help: '264 is a 17x17 PWR assembly (289 lattice positions less 25 guide tubes).' },
      { name: 'rodDiameter', type: 'number', label: 'Fuel Rod Diameter', default: 9.5, min: 5, max: 15, step: 0.5, unit: 'mm' },
      { name: 'cladThickness', type: 'number', label: 'Cladding Thickness', default: 0.6, min: 0.2, max: 2, step: 0.1, unit: 'mm',
        help: 'Zircaloy. Uncovered and hot, this is the metal that oxidises in steam and makes hydrogen.' },
      { name: 'rackHeight', type: 'number', label: 'Active Fuel Height', default: 3.66, min: 0.5, max: 6, step: 0.1, unit: 'm',
        help: 'Vertical extent of the heat-producing part of a stored assembly. Heat transfer follows the water level across exactly this band.' },
      { name: 'rackBottomElevation', type: 'number', label: 'Rack Bottom', default: 0.5, min: 0, max: 10, step: 0.1, unit: 'm',
        help: 'Height of the bottom of the active fuel above the pool floor. Water below this cools nothing.' },
      { name: 'initialLevel', type: 'number', label: 'Initial Water Level', default: 60, min: 0, max: 100, step: 5, unit: '%',
        help: 'Fraction of the pool volume filled with water (not a height). Fuel is normally covered by several metres.' },
      { name: 'initialTemperature', type: 'number', label: 'Initial Water Temperature', default: 30, min: 4, max: 100, step: 1, unit: '°C',
        help: 'The pool is open to the air, so its steam pressure is whatever water at this temperature exerts - there is no separate pressure to set.' },
      { name: 'initialNcg', type: 'ncg', label: 'Gas Above the Water', default: { N2: 0.78, O2: 0.21 }, help: 'Air over the pool. Leave as N₂/O₂ unless the pool stands in an inerted room.' },
      // Calculated fields
      { name: 'waterVolume', type: 'calculated', label: 'Water Volume (full)', default: 0, unit: 'm³',
        calculate: (p) => {
          const side = p.side || 12, depth = p.depth || 12;
          const d = (p.rodDiameter || 9.5) / 1000;
          const rods = (p.assemblyCount || 800) * (p.rodsPerAssembly || 264);
          const displaced = rods * Math.PI * d * d / 4 * (p.rackHeight || 3.66);
          return (side * side * depth - displaced).toFixed(0);
        }
      },
      { name: 'coolingTime', type: 'calculated', label: 'Heat-up to boiling', default: 0,
        calculate: (p) => {
          const side = p.side || 12, depth = p.depth || 12;
          const d = (p.rodDiameter || 9.5) / 1000;
          const rods = (p.assemblyCount || 800) * (p.rodsPerAssembly || 264);
          const displaced = rods * Math.PI * d * d / 4 * (p.rackHeight || 3.66);
          const water = (side * side * depth - displaced) * ((p.initialLevel ?? 60) / 100) * 995;
          const power = (p.fuelPower || 5) * 1e6;
          if (!(power > 0) || !(water > 0)) return 'never';
          const hours = water * 4180 * (100 - (p.initialTemperature ?? 30)) / power / 3600;
          return hours < 1 ? `${(hours * 60).toFixed(0)} min` : `${hours.toFixed(1)} h`;
        }
      },
      { name: 'volatileInventory', type: 'calculated', label: 'Volatile FP Inventory', default: 0, unit: 'mol',
        calculate: (p) => {
          // Way-Wigner run backwards: the rated power this fuel came off,
          // times the core model's 250 mol of CsI-class volatiles per GWt.
          const t = Math.max(1, (p.fuelAgeDays ?? 30) * 86400);
          const T_OP = 4 * 365.25 * 86400;
          const frac = 0.0622 * (Math.pow(t, -0.2) - Math.pow(t + T_OP, -0.2));
          if (!(frac > 0)) return 'n/a';
          const rated = (p.fuelPower || 5) * 1e6 / frac;
          return (250e-9 * rated).toFixed(0);
        }
      },
      { name: 'wettedArea', type: 'calculated', label: 'Rod Surface', default: 0, unit: 'm²',
        calculate: (p) => {
          const d = (p.rodDiameter || 9.5) / 1000;
          const rods = (p.assemblyCount || 800) * (p.rodsPerAssembly || 264);
          return (rods * Math.PI * d * (p.rackHeight || 3.66)).toFixed(0);
        }
      },
    ]
  },

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

// ---------------------------------------------------------------------------
// Electrical distribution (offered only when the plant uses the electrical
// model; see simulation/electrical.ts for what each field does)
// ---------------------------------------------------------------------------

const VOLTAGE_HELP =
  'Nominal voltage, V. A supply and whatever it feeds must agree exactly. ' +
  'Common AC levels: 13800, 6900, 4160, 480, 208, 120 V. DC control buses: 250 or 125 V.';

/** The "fed from" select every powered component carries. */
function powerSupplyOption(label: string, help: string): ComponentOption {
  return {
    name: 'powerSupply', type: 'select', label, default: '', options: [],
    dynamicOptions: 'powerSupplies', electricalOnly: true,
    help: `${help} The list shows compatible supplies first, nearest first; the wire is drawn and routed for you.`,
  };
}

componentDefinitions['bus'] = {
  displayName: 'Bus',
  options: [
    { name: 'name', type: 'text', label: 'Name', default: 'Bus' },
    { name: 'voltage', type: 'number', label: 'Voltage', default: 4160, min: 12, max: 35000, step: 1, unit: 'V',
      help: VOLTAGE_HELP },
    { name: 'dc', type: 'checkbox', label: 'DC bus', default: false,
      help: 'A DC bus is fed from a battery (with its charger) and carries control power: controller cabinets, the protection system, PORV solenoids.' },
    powerSupplyOption('Normal Supply', 'Where this bus normally gets its power: a transformer, a breaker, a battery, or another bus.'),
    { name: 'backupPowerSupply', type: 'select', label: 'Backup Supply', default: '', options: [],
      dynamicOptions: 'backupPowerSupplies', electricalOnly: true,
      help: 'A second feed, usually the emergency diesel. When both are live they share the load in proportion to what each can deliver. A diesel set to auto-start starts by itself when this bus goes dead.' },
  ]
};

componentDefinitions['transformer'] = {
  displayName: 'Transformer',
  options: [
    { name: 'name', type: 'text', label: 'Name', default: 'Transformer' },
    { name: 'ratingMVA', type: 'number', label: 'Rating', default: 10, min: 0.01, max: 2000, step: 0.1, unit: 'MVA',
      help: 'Continuous rating. Power factor is not modelled, so 1 MVA carries 1 MW. Its overcurrent relay rides through a short overload and trips on a sustained one (10% over trips in about 50 s, double load in about 9 s).' },
    { name: 'primaryVoltage', type: 'number', label: 'Primary Voltage', default: 345000, min: 12, max: 1000000, step: 1, unit: 'V',
      help: `Must match what feeds it (a switchyard is at its transmission voltage, e.g. 345000 V). ${VOLTAGE_HELP}` },
    { name: 'secondaryVoltage', type: 'number', label: 'Secondary Voltage', default: 4160, min: 12, max: 1000000, step: 1, unit: 'V',
      help: `What it delivers to the buses it feeds. ${VOLTAGE_HELP}` },
    powerSupplyOption('Primary Fed From', 'The switchyard, bus or breaker on the transformer\'s primary side.'),
  ]
};

componentDefinitions['breaker'] = {
  displayName: 'Breaker',
  options: [
    { name: 'name', type: 'text', label: 'Name', default: 'Breaker' },
    { name: 'ratingKW', type: 'number', label: 'Rating', default: 2000, min: 1, max: 100000, step: 10, unit: 'kW',
      help: 'Continuous rating. Trips open on a sustained overload (inverse-time: the further over, the sooner). Reclosing onto the same overload trips again almost at once - the relay remembers its heat.' },
    { name: 'closed', type: 'checkbox', label: 'Closed', default: true,
      help: 'Initial position. While the plant runs, open and close it from its panel.' },
    powerSupplyOption('Fed From', 'A breaker passes on whatever voltage feeds it.'),
  ]
};

componentDefinitions['diesel-generator'] = {
  displayName: 'Diesel Generator',
  options: [
    { name: 'name', type: 'text', label: 'Name', default: 'Emergency Diesel' },
    { name: 'ratingKW', type: 'number', label: 'Rating', default: 4000, min: 10, max: 30000, step: 10, unit: 'kW',
      help: 'Continuous electrical output. Overloading it trips it (and a tripped diesel stops).' },
    { name: 'voltage', type: 'number', label: 'Output Voltage', default: 4160, min: 120, max: 35000, step: 1, unit: 'V',
      help: `AC. ${VOLTAGE_HELP}` },
    { name: 'startTime', type: 'number', label: 'Start Time', default: 10, min: 0, max: 600, step: 1, unit: 's',
      help: 'From the start signal to carrying load. Nuclear plant emergency diesels are required to reach rated speed and voltage in about 10 s.' },
    { name: 'fuelHours', type: 'number', label: 'Fuel Supply', default: 168, min: 0.1, max: 5000, step: 1, unit: 'h at rated load',
      help: 'Day tank plus storage, as hours at full load (US plants keep about seven days). Idling burns about a quarter of the full-load rate, so at light load it lasts longer.' },
    { name: 'fuelLevel', type: 'number', label: 'Fuel On Hand', default: 100, min: 0, max: 100, step: 1, unit: '%',
      help: 'How full the tanks are when the plant starts.' },
    { name: 'autoStart', type: 'checkbox', label: 'Auto-start on dead bus', default: true,
      help: 'Start by itself when a bus it feeds loses its other supply, as an emergency diesel does on a loss of offsite power. It keeps running when the grid comes back until you stop it.' },
    { name: 'running', type: 'checkbox', label: 'Running at start', default: false,
      help: 'Already up to speed when the plant is loaded.' },
  ]
};

componentDefinitions['battery'] = {
  displayName: 'Battery',
  options: [
    { name: 'name', type: 'text', label: 'Name', default: 'Station Battery' },
    { name: 'voltage', type: 'number', label: 'Voltage', default: 125, min: 12, max: 1000, step: 1, unit: 'V DC',
      help: 'DC. Feeds a DC bus of the same voltage.' },
    { name: 'capacityKWh', type: 'number', label: 'Capacity', default: 250, min: 0.01, max: 100000, step: 1, unit: 'kWh',
      help: 'Stored energy when full. A station battery is sized to carry its DC loads for a few hours with no charger (the station blackout coping time).' },
    { name: 'dischargeKW', type: 'number', label: 'Discharge Rating', default: 100, min: 0.01, max: 100000, step: 1, unit: 'kW',
      help: 'The most the cells can deliver. More than that (with the charger) trips the battery\'s output breaker.' },
    { name: 'chargerKW', type: 'number', label: 'Charger Rating', default: 50, min: 0.01, max: 100000, step: 1, unit: 'kW',
      help: 'The charger carries the DC load first while it has AC power; the cells make up the rest, and whatever the charger has spare recharges them, tapering off as they fill.' },
    { name: 'initialCharge', type: 'number', label: 'State of Charge', default: 100, min: 0, max: 100, step: 1, unit: '%',
      help: 'How full the battery is when the plant starts.' },
    powerSupplyOption('Charger Fed From', 'The low-voltage AC bus or breaker the charger runs from.'),
  ]
};

// Every component that needs power gets a "fed from" select (shown only with
// the electrical model on). The help says what losing it does.
const POWERED_DEFINITIONS: Record<string, [string, string]> = {
  'pump': ['Motor Power Supply',
    'The bus or breaker the motor is fed from. Motors of 200 kW and up need medium-voltage AC (1-35 kV, e.g. 4160 V); smaller ones low-voltage AC (e.g. 480 V). With no live supply the pump coasts down, and it runs back up when the power returns.'],
  'valve': ['Motor Operator Supply',
    'Low-voltage AC (e.g. 480 V). Without power the valve stays where it is (fail as-is): neither a controller nor the operator can stroke it.'],
  'porv': ['Solenoid Supply',
    'DC control power. The PORV is held open by its solenoid: with no DC power it closes and cannot relieve.'],
  'pressurizer': ['Heater Supply',
    'Low-voltage AC (e.g. 480 V). Heaters on a dead bus heat nothing. (Only a pressurizer with heaters needs one.)'],
  'scram-controller': ['Cabinet Power',
    'DC control power. The protection system is de-energize-to-trip: losing this power scrams the reactor.'],
  'pid-controller': ['Cabinet Power',
    'DC control power. A cabinet without power stops scanning, and its actuator stays where it was.'],
  'reactor-vessel': ['Rod Drive Supply',
    'Low-voltage AC for the control rod drive mechanisms, which hold the rods out electrically: losing this power drops the rods (scram).'],
  'core': ['Rod Drive Supply',
    'Low-voltage AC for the control rod drive mechanisms, which hold the rods out electrically: losing this power drops the rods (scram).'],
};
for (const [key, [label, help]] of Object.entries(POWERED_DEFINITIONS)) {
  const def = componentDefinitions[key];
  if (!def) throw new Error(`[component-config] POWERED_DEFINITIONS names '${key}', which has no dialog definition`);
  def.options.push(powerSupplyOption(label, help));
}

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
  /**
   * Set when the part being placed comes out of a supply yard: the design is
   * already built and standing there, so the form shows it and locks every
   * field but the name. Null for ordinary palette placement, where the design
   * dropdown is a starting point the player may edit.
   */
  private fixedDesignId: string | null = null;
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

  // Whether the plant uses the electrical model: options marked
  // electricalOnly (the power supply selects) appear only when it does.
  private electricalEnabled = false;

  setElectricalEnabled(enabled: boolean): void {
    this.electricalEnabled = enabled;
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
    defaultName?: string,
    // Placing from a warehouse stock LINE: the id of the equipment design the
    // yard holds. The form is filled from it and locked - the part is already
    // built, so there is no design left to choose.
    fixedDesignId?: string
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
    this.fixedDesignId = fixedDesignId ?? null;
    if (fixedDesignId && !getPresetById(fixedDesignId)) {
      // Loud: a yard line naming a design nothing knows must not quietly
      // place a generic part instead.
      throw new Error(
        `[Dialog] Cannot place from equipment design '${fixedDesignId}': no such ` +
        `design in src/construction/component-presets.ts (or the saved custom ` +
        `designs). The warehouse stock line that names it is wrong.`);
    }
    const presets = getPresetsForType(componentType);
    this.currentPresetId = fixedDesignId
      ?? (presets.length > 0 ? presets[0].id : null);

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
   * Place a fully specified yard part with NO dialog: the design already says
   * what the thing is, and the only two questions the form would ask - what to
   * call it and how high to put it - have right answers (the auto-generated
   * name, and standing on the ground). One click, one pump.
   *
   * The form is still built and submitted through the ordinary confirm path,
   * so the config, the validation and the design stamp are the dialog's own -
   * it simply never gets a chance to paint, because show() and handleConfirm()
   * run in the same task. If validation DOES refuse the yard's design, the
   * dialog is left open showing why, which is exactly the loud failure that
   * case deserves.
   */
  showYardPlacement(
    componentType: string,
    position: { x: number; y: number },
    callback: (config: ComponentConfig | null) => void,
    availableCores: Array<{ id: string; label: string }> | undefined,
    availableGenerators: Array<{ id: string; label: string }> | undefined,
    defaultName: string | undefined,
    fixedDesignId: string
  ): void {
    this.show(componentType, position, callback, availableCores, availableGenerators,
      defaultName, fixedDesignId);
    const elevation = document.getElementById('option-elevation') as HTMLInputElement | null;
    if (elevation) elevation.value = '0';   // on the ground where it was put
    this.handleConfirm();
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
    options = options.filter(o => this.electricalEnabled || !o.electricalOnly);

    // Separate calculated options from input options
    const inputOptions = options.filter(o => o.type !== 'calculated');
    const calculatedOptions = options.filter(o => o.type === 'calculated');

    // Equipment design picker (presets) - create mode only. A part out of the
    // supply yard has no picker at all: it is already built.
    if (this.isCreateMode && this.fixedDesignId) {
      this.bodyElement.appendChild(this.createFixedDesignSection());
    } else if (this.isCreateMode && hasPresetSupport(this.currentType)) {
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

        case 'stockLines':
          input = this.createStockLinesInput(option.name,
            Array.isArray(option.default) ? option.default : []);
          formGroup.appendChild(
            this.createStockLinesPanel(input as HTMLInputElement));
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
    if (this.isCreateMode && this.fixedDesignId) this.lockFieldsToYardDesign();
  }

  /**
   * A part from the supply yard: the design is stated, not chosen. Everything
   * else in the form is locked by lockFieldsToYardDesign(); this plate is what
   * says why.
   */
  private createFixedDesignSection(): HTMLElement {
    const preset = getPresetById(this.fixedDesignId!);

    const section = document.createElement('div');
    section.className = 'design-section form-group';
    section.style.cssText = 'background: #232b3a; padding: 10px 12px; border-radius: 6px; border: 1px solid #3a4a6a; margin-bottom: 15px;';
    section.title = YARD_FIXED_DESIGN_TOOLTIP;

    const label = document.createElement('div');
    label.style.cssText = 'color: #7af; font-size: 12px; margin-bottom: 6px;';
    label.textContent = 'From the Supply Yard';
    section.appendChild(label);

    const name = document.createElement('div');
    name.id = 'yard-design-name';
    name.style.cssText = 'font-size: 14px; font-weight: bold; color: #cde;';
    name.textContent = preset ? preset.name : `UNKNOWN DESIGN '${this.fixedDesignId}'`;
    section.appendChild(name);

    const desc = document.createElement('div');
    desc.style.cssText = 'font-size: 11px; color: #99aacc; margin-top: 6px; line-height: 1.4;';
    desc.textContent = preset?.description ?? '';
    section.appendChild(desc);

    const note = document.createElement('div');
    note.style.cssText = 'font-size: 11px; color: #da5; margin-top: 6px; line-height: 1.4;';
    note.textContent = YARD_FIXED_DESIGN_TOOLTIP;
    section.appendChild(note);

    return section;
  }

  /**
   * Lock every field of a yard part except its name. The values still SUBMIT
   * (handleConfirm reads .value, which a disabled input still carries), so the
   * component is built to the yard's design exactly; the explanation hangs on
   * the enclosing form group, which is not disabled and so keeps its tooltip.
   */
  private lockFieldsToYardDesign(): void {
    const groups = this.bodyElement.querySelectorAll<HTMLElement>('.form-group');
    groups.forEach(group => {
      if (group.classList.contains('design-section')) return;
      const optionName = group.dataset.optionName;
      // Name and elevation are WHERE you put it and what you call it - the two
      // things the yard does not decide. Everything else is the design.
      if (optionName === undefined || optionName === 'name' || optionName === 'elevation') return;
      group.title = YARD_FIXED_DESIGN_TOOLTIP;
      group.style.opacity = '0.65';
      group.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select, button')
        .forEach(el => { el.disabled = true; });
    });
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
  /**
   * The hidden input that carries the warehouse's equipment list: the very
   * array of { type, design?, count } the model stores, as JSON. The visible
   * rows write through to it, and `dataset.jsonList` is what tells
   * getCurrentProperties/handleConfirm to submit it parsed rather than as a
   * string. (Same trick as the NCG panel: one field instead of a dozen.)
   */
  private createStockLinesInput(optionName: string, lines: StockLine[]): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.id = `option-${optionName}`;
    input.name = optionName;
    input.dataset.jsonList = '1';
    input.value = JSON.stringify(lines.map(l => l.design
      ? { type: l.type, design: l.design, count: l.count }
      : { type: l.type, count: l.count }));
    return input;
  }

  /**
   * Every part a yard line can name, as one grouped select: the generic
   * "any design of this type" entries first, then the standard and saved
   * DESIGNS. The option value is the line key ('pump',
   * 'pump:pump-service-water-lp'), which is exactly how src/game/stock.ts
   * identifies a pile.
   */
  private stockPartChoices(): Array<{ group: string; value: string; label: string }> {
    const out: Array<{ group: string; value: string; label: string }> = [];
    for (const type of STOCKABLE_TYPES) {
      out.push({
        group: 'Generic - any design',
        value: stockLineKey(type),
        label: `Generic ${typeDisplayName(type)}`,
      });
    }
    for (const defKey of Object.keys(componentDefinitions)) {
      // Pipe is measured in metres on its own field, never counted as a line
      if (defKey === 'pipe' || defKey === 'warehouse') continue;
      if (!hasPresetSupport(defKey)) continue;
      let storedType: ComponentType;
      try {
        storedType = storedTypeForPaletteKey(defKey);
      } catch {
        continue;   // a form with presets but no palette button holds no stock
      }
      for (const preset of getPresetsForType(defKey)) {
        out.push({
          group: componentDefinitions[defKey].displayName,
          value: stockLineKey(storedType, preset.id),
          label: preset.name,
        });
      }
    }
    return out;
  }

  /**
   * The repeatable equipment list: one row per stock line (part + count +
   * remove), and an "Add a part" button. Every change rewrites the hidden
   * input, so the dialog submits the same array shape the model stores and
   * the round-trip audit compares like with like.
   */
  private createStockLinesPanel(input: HTMLInputElement): HTMLElement {
    const container = document.createElement('div');
    container.className = 'stock-lines-panel';
    container.style.cssText = 'margin-top: 6px;';

    const rowsEl = document.createElement('div');
    rowsEl.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
    container.appendChild(rowsEl);

    const choices = this.stockPartChoices();
    const read = (): StockLine[] => {
      try {
        const parsed = JSON.parse(input.value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    const write = (lines: StockLine[]): void => {
      input.value = JSON.stringify(lines);
    };

    const render = (): void => {
      const lines = read();
      rowsEl.innerHTML = '';

      if (lines.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size: 11px; color: #889; font-style: italic;';
        empty.textContent = 'Nothing in the yard - every equipment button will be greyed out.';
        rowsEl.appendChild(empty);
      }

      lines.forEach((line, index) => {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; gap: 6px; align-items: center;';

        const partSelect = document.createElement('select');
        partSelect.style.cssText = 'flex: 1; min-width: 0; font-size: 11px;';
        partSelect.title = 'What this pile IS. Pick a design and placing from it ' +
          'produces exactly that design with no design choice; pick a generic ' +
          'entry to hand out an unspecified part of that type.';
        const groups = new Map<string, HTMLOptGroupElement>();
        const wanted = stockLineKey(line.type, line.design || undefined);
        let matched = false;
        for (const choice of choices) {
          let group = groups.get(choice.group);
          if (!group) {
            group = document.createElement('optgroup');
            group.label = choice.group;
            groups.set(choice.group, group);
            partSelect.appendChild(group);
          }
          const opt = document.createElement('option');
          opt.value = choice.value;
          opt.textContent = choice.label;
          if (choice.value === wanted) { opt.selected = true; matched = true; }
          group.appendChild(opt);
        }
        if (!matched) {
          // A design this browser does not know (renamed, or a custom design
          // saved elsewhere). Show it as what it is rather than silently
          // snapping the line to some other part.
          const opt = document.createElement('option');
          opt.value = wanted;
          opt.textContent = `UNKNOWN DESIGN: ${wanted}`;
          opt.selected = true;
          partSelect.insertBefore(opt, partSelect.firstChild);
        }
        partSelect.addEventListener('change', () => {
          const [type, design] = partSelect.value.split(':');
          const next = read();
          next[index] = design
            ? { type: type as ComponentType, design, count: next[index].count }
            : { type: type as ComponentType, count: next[index].count };
          write(next);
          render();
        });
        row.appendChild(partSelect);

        const countInput = document.createElement('input');
        countInput.type = 'number';
        countInput.min = '0';
        countInput.step = '1';
        countInput.value = String(line.count ?? 0);
        countInput.title = 'How many are standing in the yard. Each one placed ' +
          'takes one off this line; deleting one puts it back.';
        countInput.style.cssText = 'width: 70px; flex: none; font-size: 11px;';
        countInput.addEventListener('input', () => {
          const next = read();
          next[index] = { ...next[index], count: Math.max(0, Number(countInput.value) || 0) };
          write(next);
        });
        row.appendChild(countInput);

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = '\u00d7';
        removeBtn.title = 'Take this line out of the yard entirely';
        removeBtn.style.cssText = 'background: #3a2a2a; color: #faa; border: 1px solid #6a4a4a; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 12px;';
        removeBtn.addEventListener('click', () => {
          const next = read();
          next.splice(index, 1);
          write(next);
          render();
        });
        row.appendChild(removeBtn);

        rowsEl.appendChild(row);
      });
    };

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '+ Add a part';
    addBtn.title = 'Add another line to the yard\u2019s equipment list';
    addBtn.style.cssText = 'margin-top: 6px; background: #3a4a5a; color: #adf; border: 1px solid #4a6a8a; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px;';
    addBtn.addEventListener('click', () => {
      const next = read();
      const first = choices[0];
      const [type, design] = first.value.split(':');
      next.push(design
        ? { type: type as ComponentType, design, count: 1 }
        : { type: type as ComponentType, count: 1 });
      write(next);
      render();
    });
    container.appendChild(addBtn);

    render();
    return container;
  }

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
      } else if (element.dataset.jsonList === '1') {
        props[option.name] = JSON.parse(element.value);
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
      } else if (element.dataset.jsonList === '1') {
        // A repeatable list (the warehouse's stock lines) carried as JSON in
        // a hidden input, submitted as the array the model stores.
        properties[name] = JSON.parse(element.value);
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
      properties,
      // Only a YARD part carries its design id. A design picked from the
      // dropdown is a starting point the player may edit field by field, so
      // stamping it would be a claim the component cannot keep - and it would
      // send the refund to a stock line the placement never charged.
      design: this.fixedDesignId ?? undefined,
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
    this.fixedDesignId = null;
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
    options = options.filter(o => this.electricalEnabled || !o.electricalOnly);

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

        case 'stockLines':
          input = this.createStockLinesInput(option.name,
            Array.isArray(existingValue) ? existingValue : []);
          formGroup.appendChild(
            this.createStockLinesPanel(input as HTMLInputElement));
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

/**
 * Normalize a warehouse stock list for comparison: drop empty rows, sort by
 * line key so the order the rows happen to be in is not a difference.
 */
function normalizeStockLines(value: any): Array<[string, number]> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(l => l && typeof l.type === 'string' && Number(l.count) > 0)
    .map(l => [stockLineKey(l.type, l.design || undefined), Number(l.count)] as [string, number])
    .sort((a, b) => a[0].localeCompare(b[0]));
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
  if (option.type === 'stockLines') {
    return JSON.stringify(normalizeStockLines(submitted)) ===
      JSON.stringify(normalizeStockLines(actual));
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