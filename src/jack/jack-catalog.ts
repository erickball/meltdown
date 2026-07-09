import { componentDefinitions } from '../construction/component-config';

/**
 * Machine-readable component catalog for the list_component_types tool,
 * generated straight from the construction dialog definitions so it can
 * never drift from what the dialog (and createComponent) actually accepts.
 */
export function buildComponentCatalog(): unknown {
  const catalog: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(componentDefinitions)) {
    catalog[key] = {
      displayName: def.displayName,
      properties: def.options
        .filter((o) => o.type !== 'calculated')
        .map((o) => {
          const entry: Record<string, unknown> = {
            name: o.name,
            label: o.label,
            type: o.type,
            default: o.default,
          };
          if (o.unit !== undefined) entry.unit = o.unit;
          if (o.min !== undefined) entry.min = o.min;
          if (o.max !== undefined) entry.max = o.max;
          if (o.options) entry.choices = o.options.map((c) => c.value);
          if (o.help) entry.help = o.help;
          if (o.dependsOn) entry.onlyWhen = o.dependsOn;
          return entry;
        }),
    };
  }
  return {
    note:
      'Property values for add_component/edit_component use these units (bar, °C, %, MW, m...), not raw SI. ' +
      "The 'ncg' type takes an object of partial pressures in bar, e.g. {\"N2\": 1.0}.",
    types: catalog,
  };
}
