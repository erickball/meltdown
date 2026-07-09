import { componentDefinitions } from '../construction/component-config';

/**
 * Compact one-line-per-type catalog (~3KB): property names with units only.
 * Embedded in the first context block of a conversation so Jack can do
 * routine add/edit work without a list_component_types round trip; the tool
 * remains the source for ranges, defaults, and help text.
 */
export function buildCompactCatalog(): string {
  const lines: string[] = [];
  for (const [key, def] of Object.entries(componentDefinitions)) {
    const props = def.options
      .filter((o) => o.type !== 'calculated')
      .map((o) => (o.unit ? `${o.name}(${o.unit})` : o.name))
      .join(' ');
    lines.push(`  ${key} "${def.displayName}": ${props}`);
  }
  return lines.join('\n');
}

/** Every property name that exists in any component schema (for validating
 *  edit_component keys — updateComponent silently ignores unknown names). */
let knownPropertyNames: Set<string> | null = null;
export function isKnownProperty(name: string): boolean {
  if (!knownPropertyNames) {
    knownPropertyNames = new Set();
    for (const def of Object.values(componentDefinitions)) {
      for (const o of def.options) {
        if (o.type !== 'calculated') knownPropertyNames.add(o.name);
      }
    }
  }
  return knownPropertyNames.has(name);
}

/**
 * Machine-readable component catalog for the list_component_types tool,
 * generated straight from the construction dialog definitions so it can
 * never drift from what the dialog (and createComponent) actually accepts.
 *
 * With no filter, returns only type keys + display names (~0.5KB). The full
 * catalog is ~34KB and would live in the transcript for the rest of the
 * conversation, so property schemas are served per-type on request.
 */
export function buildComponentCatalog(types?: string[]): unknown {
  if (!types || types.length === 0) {
    return {
      note:
        'Call list_component_types again with types=[...] to get the property schema for specific types before adding/editing them.',
      types: Object.fromEntries(
        Object.entries(componentDefinitions).map(([k, d]) => [k, d.displayName])
      ),
    };
  }
  const catalog: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const key of types) {
    const def = componentDefinitions[key];
    if (!def) {
      unknown.push(key);
      continue;
    }
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
    ...(unknown.length > 0 ? { unknownTypes: unknown } : {}),
    types: catalog,
  };
}
