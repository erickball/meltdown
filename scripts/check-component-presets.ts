// Sanity check for the component preset catalog: every builtin preset must
// reference real dialog options for its component type, numeric values should
// sit inside the option's declared [min, max], and select values must be
// valid choices. Run: npx tsx scripts/check-component-presets.ts
import { componentDefinitions } from '../src/construction/component-config';
import { getPresetsForType, PIPE_SPECS, pipeSpecFlowArea } from '../src/construction/component-presets';

let errors = 0;
let warnings = 0;

for (const type of Object.keys(componentDefinitions)) {
  const presets = getPresetsForType(type);
  for (const preset of presets) {
    const def = componentDefinitions[type];
    const optionNames = new Map(def.options.map(o => [o.name, o]));
    for (const [key, value] of Object.entries(preset.properties)) {
      const opt = optionNames.get(key);
      if (!opt) {
        console.error(`ERROR: preset '${preset.id}' (${type}) sets unknown option '${key}'`);
        errors++;
        continue;
      }
      if (opt.type === 'calculated') {
        console.error(`ERROR: preset '${preset.id}' sets calculated option '${key}'`);
        errors++;
      }
      if (opt.type === 'number' && typeof value === 'number') {
        if (opt.min !== undefined && value < opt.min) {
          console.warn(`WARN: preset '${preset.id}' ${key}=${value} below min ${opt.min}`);
          warnings++;
        }
        if (opt.max !== undefined && value > opt.max) {
          console.warn(`WARN: preset '${preset.id}' ${key}=${value} above max ${opt.max}`);
          warnings++;
        }
      }
      if (opt.type === 'select' && opt.options && !opt.options.some(o => o.value === value)) {
        console.error(`ERROR: preset '${preset.id}' ${key}='${value}' not a valid choice`);
        errors++;
      }
    }
  }
}

for (const spec of PIPE_SPECS) {
  const area = pipeSpecFlowArea(spec);
  if (area < 0.001 || area > 10) {
    console.error(`ERROR: pipe spec '${spec.id}' area ${area.toFixed(4)} outside dialog range [0.001, 10]`);
    errors++;
  }
}

console.log(`Preset check done: ${errors} errors, ${warnings} range warnings`);
if (errors > 0) process.exit(1);
