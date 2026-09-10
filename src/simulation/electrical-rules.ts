/**
 * The rules of the electrical model that the simulation AND the construction
 * UI both need: voltage classes, which components are loads and what voltage
 * each wants, and what each piece of the network will accept from its feed.
 * One copy, so the dialog's "compatible supplies" and the solve's "powered"
 * can never disagree.
 *
 * See simulation/electrical.ts for the network solve itself.
 */

import type { ElecLoadKind, VoltageClass } from './types';

// ---------------------------------------------------------------------------
// Voltage classes
// ---------------------------------------------------------------------------

/** Low voltage is 1 kV and below (IEC 60038). */
export const LV_MAX_V = 1000;
/** Medium voltage runs up to 35 kV; above it is transmission. */
export const MV_MAX_V = 35000;

export function voltageClassOf(voltage: number, dc: boolean): VoltageClass {
  if (!(voltage > 0)) {
    throw new Error(`[Electrical] voltageClassOf: ${voltage} V is not a voltage`);
  }
  if (dc) return 'dc';
  if (voltage <= LV_MAX_V) return 'lv';
  if (voltage <= MV_MAX_V) return 'mv';
  return 'hv';
}

export const VOLTAGE_CLASS_LABEL: Record<VoltageClass, string> = {
  dc: 'DC control power',
  lv: 'low-voltage AC (1 kV or less)',
  mv: 'medium-voltage AC (1-35 kV)',
  hv: 'transmission voltage',
};

export function formatVoltage(voltage: number, dc: boolean): string {
  if (!(voltage > 0)) return 'no voltage';
  const v = voltage >= 1000 ? `${+(voltage / 1000).toFixed(2)} kV` : `${+voltage.toFixed(0)} V`;
  return `${v} ${dc ? 'DC' : 'AC'}`;
}

export function formatPower(watts: number): string {
  const w = Math.abs(watts);
  if (w >= 1e6) return `${(watts / 1e6).toFixed(2)} MW`;
  if (w >= 1e3) return `${(watts / 1e3).toFixed(1)} kW`;
  return `${watts.toFixed(0)} W`;
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/**
 * Hydraulic efficiency of a motor-driven pump. The factory builds every
 * PumpState with this, and the motor rating below is sized on it, so both
 * read it from here.
 */
export const MOTOR_PUMP_EFFICIENCY = 0.85;
/** Induction motor efficiency at load (large motors run 0.93-0.97). */
export const MOTOR_EFFICIENCY = 0.95;
/**
 * Motors this size and up are built for medium voltage. Below ~200 kW
 * (~250 hp) a 480 V motor is the economical choice; above it the current at
 * 480 V gets unreasonable and plants go to 4.16 kV. A design rule for which
 * bus a motor may be put on - it decides nothing in the dynamics.
 */
export const MV_MOTOR_MIN_W = 200e3;
/** A DCS or protection cabinet: power supplies, I/O cards, fans. */
export const CONTROL_CABINET_W = 1e3;
/**
 * Control rod drive power: the motor-generator sets that hold magnetic-jack
 * CRDMs latched draw a few hundred kW on a large PWR.
 */
export const ROD_DRIVE_W = 200e3;

const G = 9.81;

/** Nameplate electrical input of a pump's motor (W): rated hydraulic power through both efficiencies. */
export function pumpMotorRatedW(ratedFlow: number, ratedHead: number): number {
  return ratedFlow * G * ratedHead / (MOTOR_PUMP_EFFICIENCY * MOTOR_EFFICIENCY);
}

export interface LoadSpec {
  kind: ElecLoadKind;
  voltageClass: VoltageClass;
  ratedW: number;
  /** What the power is for, in the operator's words. */
  what: string;
}

/**
 * Whether a plant component needs electrical power, and what kind. Null for
 * anything that does not: tanks without heaters, pipes, check and spring
 * relief valves (self-actuated), turbine-driven pumps (steam is their power).
 *
 * The defaults read here are the factory's defaults for the same fields.
 */
export function loadSpecFor(component: Record<string, any>): LoadSpec | null {
  switch (component.type) {
    case 'pump': {
      const w = pumpMotorRatedW(component.ratedFlow || 1000, component.ratedHead || 150);
      return { kind: 'pump', voltageClass: w >= MV_MOTOR_MIN_W ? 'mv' : 'lv', ratedW: w, what: 'pump motor' };
    }
    case 'valve': {
      const vt = component.valveType;
      if (vt === 'porv') return { kind: 'porv', voltageClass: 'dc', ratedW: 0, what: 'PORV solenoid' };
      if (vt === 'check' || vt === 'relief') return null;
      return { kind: 'mov', voltageClass: 'lv', ratedW: 0, what: 'valve motor operator' };
    }
    case 'controller':
      return component.controllerType === 'pid'
        ? { kind: 'controller', voltageClass: 'dc', ratedW: CONTROL_CABINET_W, what: 'controller cabinet' }
        : { kind: 'rps', voltageClass: 'dc', ratedW: CONTROL_CABINET_W, what: 'reactor protection cabinet' };
    case 'tank':
      if ((component.heaterCapacity ?? 0) > 0) {
        return { kind: 'heater', voltageClass: 'lv', ratedW: component.heaterCapacity, what: 'heaters' };
      }
      return null;
    case 'reactorVessel':
      return { kind: 'rod-drive', voltageClass: 'lv', ratedW: ROD_DRIVE_W, what: 'control rod drives' };
    case 'vessel':
      // A fuelled vessel is a standalone core (see mapComponentTypeToDefinition)
      if (component.fuelRodCount !== undefined || component.controlRodCount !== undefined) {
        return { kind: 'rod-drive', voltageClass: 'lv', ratedW: ROD_DRIVE_W, what: 'control rod drives' };
      }
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The network's own pieces
// ---------------------------------------------------------------------------

/** Plant component types that are part of the distribution network. */
export const ELECTRICAL_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  'switchyard', 'bus', 'transformer', 'breaker', 'diesel-generator', 'battery',
]);

/** The new electrical parts: no ports, no flow node, only built with the model on. */
export const ELECTRICAL_PART_TYPES: ReadonlySet<string> = new Set([
  'bus', 'transformer', 'breaker', 'diesel-generator', 'battery',
]);

/**
 * What a component will take from its feed. A bus is one voltage and one
 * kind of current; a transformer's primary is one AC voltage; a breaker
 * passes whatever it is given; a battery's charger wants low-voltage AC; a
 * load wants its class.
 */
export type SupplyRequirement =
  | { kind: 'exact'; voltage: number; dc: boolean }
  | { kind: 'class'; voltageClass: VoltageClass }
  | { kind: 'any' };

export function acceptsSupply(req: SupplyRequirement, voltage: number, dc: boolean): boolean {
  if (!(voltage > 0)) return false;
  switch (req.kind) {
    case 'any': return true;
    case 'exact': return voltage === req.voltage && dc === req.dc;
    case 'class': return voltageClassOf(voltage, dc) === req.voltageClass;
  }
}

export function describeRequirement(req: SupplyRequirement): string {
  switch (req.kind) {
    case 'any': return 'any supply';
    case 'exact': return formatVoltage(req.voltage, req.dc);
    case 'class': return VOLTAGE_CLASS_LABEL[req.voltageClass];
  }
}

/**
 * The requirement a plant component puts on its supply (`powerSupplyId`
 * and, for a bus, `backupPowerSupplyId`), or null if it takes no feed at all
 * (switchyards and diesels are sources; most components are not electrical).
 */
export function supplyRequirementFor(component: Record<string, any>): SupplyRequirement | null {
  switch (component.type) {
    case 'bus': return { kind: 'exact', voltage: component.voltage, dc: !!component.dc };
    case 'transformer': return { kind: 'exact', voltage: component.primaryVoltage, dc: false };
    case 'breaker': return { kind: 'any' };
    case 'battery': return { kind: 'class', voltageClass: 'lv' };
    case 'switchyard':
    case 'diesel-generator':
      return null;
  }
  const load = loadSpecFor(component);
  return load ? { kind: 'class', voltageClass: load.voltageClass } : null;
}

/**
 * Which network pieces may feed a component of this type. Loads hang off a
 * bus or a breaker (a motor is fed from switchgear, never straight off a
 * transformer); the network's own pieces follow how real distribution is
 * built.
 */
export function feederTypesFor(componentType: string): ReadonlySet<string> {
  switch (componentType) {
    case 'bus': return new Set(['transformer', 'breaker', 'diesel-generator', 'battery', 'bus']);
    case 'transformer': return new Set(['switchyard', 'bus', 'breaker']);
    case 'breaker': return new Set(['switchyard', 'bus', 'transformer', 'diesel-generator', 'battery']);
    case 'battery': return new Set(['bus', 'breaker']);
    default: return new Set(['bus', 'breaker']);
  }
}
