// Component configuration definitions and dialog system

import { saturationTemperature } from '../simulation/water-properties';
import { estimateComponentCost, formatCost } from './cost-estimation';

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
  // For conditional visibility: show/hide based on another field's value
  dependsOn?: { field: string; value: any };
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
      { name: 'volume', type: 'number', label: 'Volume', default: 10, min: 0.1, max: 1000, step: 0.1, unit: 'm³' },
      { name: 'height', type: 'number', label: 'Height', default: 4, min: 0.5, max: 50, step: 0.5, unit: 'm' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 200, min: 1, max: 600, step: 10, unit: 'bar' },
      { name: 'initialLevel', type: 'number', label: 'Initial Water Level', default: 50, min: 0, max: 100, step: 5, unit: '%', help: 'For 0-100%, fluid is two-phase at saturation' },
      { name: 'initialPressure', type: 'number', label: 'Initial Pressure', default: 150, min: 1, max: 221, step: 1, unit: 'bar', help: 'For two-phase (0-100% level), determines saturation temperature' },
      { name: 'initialTemperature', type: 'number', label: 'Initial Temperature', default: 300, min: 20, max: 374, step: 5, unit: '°C', help: 'For two-phase, calculated from saturation pressure' },
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
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true },
      { name: 'elevation', type: 'number', label: 'Elevation (Bottom)', default: 10, min: -50, max: 100, step: 0.5, unit: 'm', help: 'Typically elevated above hot leg' },
      { name: 'volume', type: 'number', label: 'Volume', default: 40, min: 5, max: 100, step: 5, unit: 'm³' },
      { name: 'height', type: 'number', label: 'Height', default: 12, min: 5, max: 20, step: 1, unit: 'm' },
      { name: 'pressureRating', type: 'number', label: 'Pressure Rating', default: 175, min: 100, max: 250, step: 5, unit: 'bar' },
      { name: 'heaterPower', type: 'number', label: 'Heater Power', default: 2, min: 0, max: 10, step: 0.5, unit: 'MW' },
      { name: 'sprayFlow', type: 'number', label: 'Max Spray Flow', default: 50, min: 0, max: 200, step: 10, unit: 'kg/s' },
      { name: 'initialLevel', type: 'number', label: 'Initial Water Level', default: 60, min: 0, max: 100, step: 5, unit: '%', help: 'Pressurizers are always two-phase at saturation' },
      { name: 'initialPressure', type: 'number', label: 'Initial Pressure', default: 155, min: 1, max: 221, step: 1, unit: 'bar', help: 'Determines saturation temperature' },
      { name: 'initialTemperature', type: 'number', label: 'Initial Temperature', default: 345, min: 20, max: 374, step: 5, unit: '°C', help: 'Calculated from saturation pressure' },
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
      { name: 'pressureRating', type: 'number', label: 'Design Pressure', default: 175, min: 100, max: 250, step: 5, unit: 'bar' },
      { name: 'barrelDiameter', type: 'number', label: 'Core Barrel Dia (mid-wall)', default: 3.4, min: 1.5, max: 6, step: 0.1, unit: 'm', help: 'Diameter to center of barrel wall' },
      { name: 'barrelThickness', type: 'number', label: 'Barrel Wall Thickness', default: 0.05, min: 0.02, max: 0.15, step: 0.01, unit: 'm' },
      { name: 'barrelBottomGap', type: 'number', label: 'Barrel Bottom Gap', default: 1.0, min: 0, max: 3, step: 0.1, unit: 'm', help: 'Distance from lower head to barrel bottom' },
      { name: 'barrelTopGap', type: 'number', label: 'Barrel Top Gap', default: 0, min: 0, max: 3, step: 0.1, unit: 'm', help: 'Distance from upper head to barrel top' },
      { name: 'initialLevel', type: 'number', label: 'Initial Water Level', default: 100, min: 0, max: 100, step: 5, unit: '%', help: 'For 0-100%, fluid is two-phase at saturation' },
      { name: 'initialPressure', type: 'number', label: 'Initial Pressure', default: 155, min: 50, max: 221, step: 5, unit: 'bar', help: 'For two-phase (0-100% level), determines saturation temperature' },
      { name: 'initialTemperature', type: 'number', label: 'Initial Temperature', default: 290, min: 20, max: 374, step: 5, unit: '°C', help: 'For two-phase, calculated from saturation pressure' },
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
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: false },
      { name: 'length', type: 'number', label: 'Length', default: 10, min: 1, max: 100, step: 1, unit: 'm', help: 'Calculated from endpoint positions when editing' },
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
      { name: 'initialPressure', type: 'number', label: 'Initial Pressure', default: 150, min: 0.01, max: 221, step: 1, unit: 'bar', help: 'For two-phase, determines saturation temperature' },
      { name: 'initialTemperature', type: 'number', label: 'Initial Temperature', default: 290, min: 20, max: 374, step: 5, unit: '°C', help: 'For two-phase, calculated from saturation pressure' },
      { name: 'initialQuality', type: 'number', label: 'Initial Quality', default: 0.5, min: 0, max: 1, step: 0.01, help: 'Mass fraction of vapor (0=sat. liquid, 1=sat. vapor). Only for two-phase.' },
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
      { name: 'orientation', type: 'select', label: 'Flow Direction', default: 'left-right', options: [
        { value: 'left-right', label: 'Inlet Left → Outlet Right' },
        { value: 'right-left', label: 'Inlet Right → Outlet Left' },
        { value: 'bottom-top', label: 'Inlet Bottom → Outlet Top' },
        { value: 'top-bottom', label: 'Inlet Top → Outlet Bottom' }
      ]},
      { name: 'ratedFlow', type: 'number', label: 'Rated Flow', default: 1000, min: 10, max: 10000, step: 10, unit: 'kg/s' },
      { name: 'ratedHead', type: 'number', label: 'Rated Head', default: 100, min: 10, max: 1000, step: 10, unit: 'm' },
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
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true },
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
      { name: 'nqa1', type: 'checkbox', label: 'Use nuclear quality assurance standard', default: true },
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

  show(
    componentType: string,
    position: { x: number; y: number },
    callback: (config: ComponentConfig | null) => void,
    availableCores?: Array<{ id: string; label: string }>
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

    // Set title
    this.titleElement.textContent = `Configure ${definition.displayName}`;

    // Build form (pass available cores for controller dropdowns)
    this.buildForm(definition.options, availableCores);

    // Show dialog
    this.dialog.style.display = 'flex';

    // Focus first input
    const firstInput = this.bodyElement.querySelector('input, select') as HTMLElement;
    if (firstInput) {
      firstInput.focus();
    }
  }

  private buildForm(options: ComponentOption[], availableCores?: Array<{ id: string; label: string }>) {
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
            const shouldShow = currentValue === option.dependsOn.value;
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
      input.addEventListener('input', () => {
        updateCalculatedFields();
        updatePriceEstimate();
      });
      input.addEventListener('change', () => {
        updateCalculatedFields();
        updatePriceEstimate();
      });
    });

    // Initial calculations
    updateCalculatedFields();
    updatePriceEstimate();

    // Set up two-phase P/T coupling if this component has phase selection
    this.setupTwoPhaseCouplng();
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
    const updateSaturationTemp = () => {
      if (isTwoPhase()) {
        const pressureBar = parseFloat(pressureInput.value) || 150;
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
   * Validate that initial pressure does not exceed pressure rating
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
    availableCores?: Array<{ id: string; label: string }>
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
    this.availableCores = availableCores || [];
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
      'controller': 'scram-controller'
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
            const shouldShow = currentValue === option.dependsOn.value;
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
  }

  /**
   * Get existing value from component, handling property name mapping
   */
  private getExistingValue(optionName: string, component: Record<string, any>, defaultValue: any): any {
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
      return value;
    }

    // Map option names to component properties
    const propertyMappings: Record<string, string[]> = {
      'name': ['label'],
      'type': ['valveType', 'hxType', 'pumpType'],
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
      'shellDiameter': ['width'],
      'shellLength': ['height'],
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
      'highPower': ['setpoints.highPower'],
      'lowPower': ['setpoints.lowPower'],
      'highFuelTemp': ['setpoints.highFuelTemp'],
      'lowCoolantFlow': ['setpoints.lowCoolantFlow'],
      // Turbine-specific mappings
      'inletPressure': ['inletFluid.pressure'],
      'exhaustPressure': ['outletFluid.pressure'],
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
          if (prop === 'controlRodPosition') return (1 - component[prop]) * 100; // Inverted: 0=fully inserted, 1=withdrawn -> 0%=inserted, 100%=withdrawn
          return component[prop];
        }
      }
    }

    return defaultValue;
  }
}