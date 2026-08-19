// Round-trip check for the component edit dialog: for every dialog-editable
// component type, create the component from its dialog defaults, apply an
// edit that perturbs every editable field (the way the dialog would submit
// it), and verify auditComponentEditSync reports zero mismatches - i.e. the
// write path (ConstructionManager.updateComponent) and the read path
// (readComponentOption) agree on every field.
//
// Run: npx tsx scripts/check-dialog-sync.ts
import {
  componentDefinitions,
  auditComponentEditSync,
  ComponentOption,
} from '../src/construction/component-config';
import { ConstructionManager } from '../src/construction/construction-manager';
import { saturationTemperature } from '../src/simulation/water-properties';
import { PlantState } from '../src/types';

// Types the generic edit path (main.ts setComponentEditCallback ->
// updateComponent) covers. Cores, controllers, switchyards, and buildings go
// through their own paths or need plant context, so they are not built here.
const TYPES = [
  'tank', 'pressurizer', 'pipe', 'valve', 'check-valve', 'relief-valve',
  'porv', 'pump', 'heat-exchanger', 'condenser', 'turbine-generator',
  'turbine-driven-pump',
];

function editableOptions(defKey: string): ComponentOption[] {
  return componentDefinitions[defKey].options.filter(o => o.type !== 'calculated');
}

function defaultsFor(defKey: string): Record<string, any> {
  const props: Record<string, any> = {};
  for (const o of editableOptions(defKey)) props[o.name] = o.default;
  return props;
}

/** Deterministic perturbation of one option, staying inside [min, max]. */
function perturbOption(o: ComponentOption): any {
  switch (o.type) {
    case 'number': {
      const d = Number(o.default) || 0;
      const lo = o.min ?? d - 10;
      const hi = o.max ?? d + 10;
      const bump = Math.max((hi - lo) * 0.13, o.step ?? 0.01);
      let v = d + bump;
      if (v > hi) v = d - bump;
      if (v < lo) v = (lo + hi) / 2;
      return +v.toPrecision(6);
    }
    case 'checkbox':
      return !o.default;
    case 'select': {
      const choices = o.options ?? [];
      if (choices.length < 2) return o.default;
      const idx = choices.findIndex(c => c.value === o.default);
      return choices[(idx + 1) % choices.length].value;
    }
    case 'ncg':
      return { N2: 0.5 };
    default: // text
      return `${o.default}-edited`;
  }
}

/**
 * Build the property set the dialog would submit for an "edit everything"
 * pass, respecting the couplings the dialog itself enforces (volume<->
 * diameter, two-phase saturation temperature, descending extractions,
 * plenum cap, integer bundle count).
 */
function perturbedProps(defKey: string): Record<string, any> {
  const props: Record<string, any> = {};
  for (const o of editableOptions(defKey)) {
    props[o.name] = o.syncExempt ? o.default : perturbOption(o);
  }

  // Tank/pressurizer: dialog keeps diameter consistent with volume & height
  if (props.volume !== undefined && props.diameter !== undefined && props.height !== undefined) {
    props.diameter = +(2 * Math.sqrt(props.volume / (Math.PI * props.height))).toPrecision(6);
  }
  // Two-phase: dialog derives temperature from saturation at the steam pressure
  const twoPhase =
    (props.initialLevel !== undefined && props.initialLevel > 0 && props.initialLevel < 100) ||
    props.initialPhase === 'two-phase';
  if (twoPhase && props.initialPressure !== undefined && props.initialTemperature !== undefined) {
    props.initialTemperature = +(saturationTemperature(props.initialPressure * 1e5) - 273.15).toPrecision(6);
  }
  // Turbine extractions: the three slots are high/intermediate/low pressure
  // (the model stores them sorted descending)
  if (props.extraction1Pressure !== undefined) {
    props.extraction1Pressure = 30;
    props.extraction2Pressure = 12;
    props.extraction3Pressure = 3;
  }
  // Plenum length must respect the shell-radius cap or the write path caps it
  if (props.plenumLength !== undefined && props.shellDiameter !== undefined) {
    props.plenumLength = Math.min(props.plenumLength, +(props.shellDiameter * 0.4).toPrecision(6));
  }
  // Bundle count is rounded to an integer by the write path
  if (props.bundleCount !== undefined) props.bundleCount = 2;
  return props;
}

const plantState: PlantState = {
  components: new Map(),
  connections: [],
  simTime: 0,
  simSpeed: 1,
  isPaused: true,
};
const manager = new ConstructionManager(plantState);

let failures = 0;
for (const type of TYPES) {
  const defaults = defaultsFor(type);
  const id = manager.createComponent({
    type,
    name: String(defaults.name ?? type),
    position: { x: 0, y: 0 },
    properties: defaults,
  });
  if (!id) {
    console.error(`ERROR: could not create '${type}'`);
    failures++;
    continue;
  }
  const component = plantState.components.get(id) as Record<string, any>;

  const edited = perturbedProps(type);
  manager.updateComponent(id, edited);
  const mismatches = auditComponentEditSync(component, edited);
  if (mismatches.length > 0) {
    failures++;
    console.error(`ERROR: '${type}' edit did not round-trip (${mismatches.length} field(s)):`);
    for (const m of mismatches) {
      console.error(`    ${m.name} (${m.label}): submitted ${JSON.stringify(m.submitted)}, model reads ${JSON.stringify(m.actual)}`);
    }
  } else {
    console.log(`OK: ${type} (${editableOptions(type).length} fields round-trip)`);
  }
}

console.log(failures === 0
  ? 'Dialog sync check passed for all component types'
  : `Dialog sync check FAILED for ${failures} component type(s)`);
if (failures > 0) process.exit(1);
