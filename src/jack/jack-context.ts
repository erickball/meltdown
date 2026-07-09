import type { JackHost, PlantChange } from './jack-host';
import { buildingFootprint } from './jack-tools-exec';
import { buildCompactCatalog } from './jack-catalog';

const barFromPa = (pa: number) => (pa / 1e5).toFixed(2);
const cFromK = (k: number) => (k - 273.15).toFixed(1);
const m = (v: number) => Number(v.toFixed(1));

/**
 * Build the machine-generated CONTEXT block that rides along with each user
 * message. Kept deliberately compact — Jack has tools for full detail.
 */
export function buildContextBlock(
  host: JackHost,
  changes: PlantChange[],
  includeCatalog = false
): string {
  const lines: string[] = ['[CONTEXT]'];
  lines.push(`mode: ${host.getMode()}`);

  if (includeCatalog) {
    // First message of a conversation only: the compact parts catalog stays
    // in the transcript (and prompt cache) from here on.
    lines.push(
      'parts catalog (type "displayName": properties with units — values for ' +
        'add/edit use these units; list_component_types has ranges/defaults/help):'
    );
    lines.push(buildCompactCatalog());
  }

  const selected = host.getSelectedComponentId();
  if (selected) {
    const comp = host.plantState.components.get(selected);
    lines.push(
      `selected component: ${selected}${comp?.label ? ` ("${comp.label}")` : ''}`
    );
  }

  // Plant inventory: one line per component, connections summarized.
  // Positions are plan-view meters; buildings list their footprints so
  // placement inside/outside containment can be checked geometrically.
  const comps = [...host.plantState.components.values()];
  lines.push(
    `plant: ${comps.length} components (positions are plan-view meters; ` +
      'a component is inside a building when its position is within the footprint)'
  );
  for (const c of comps) {
    let line = `  ${c.id} [${c.type}]`;
    if (c.label && c.label !== c.id) line += ` "${c.label}"`;
    line += ` @(${m(c.position.x)},${m(c.position.y)})`;
    if (c.elevation !== undefined && c.elevation !== 0) line += ` elev=${c.elevation}m`;
    if (c.containedBy) line += ` in ${c.containedBy}`;
    if (c.type === 'building') {
      const b = c as any;
      const { halfW, halfD } = buildingFootprint(b);
      const shape = b.shape === 'cylinder' ? `cylinder d=${b.diameter}m` : `rect ${b.width}x${b.length}m`;
      line += ` footprint: ${shape}, x ${m(c.position.x - halfW)}..${m(c.position.x + halfW)}, y ${m(
        c.position.y - halfD
      )}..${m(c.position.y + halfD)}`;
    }
    lines.push(line);
  }
  if (host.plantState.connections.length > 0) {
    lines.push('connections:');
    for (const conn of host.plantState.connections) {
      lines.push(`  ${conn.fromPortId} -> ${conn.toPortId}`);
    }
  }

  const sim = host.getSimState();
  if (sim) {
    lines.push(`simulation: t=${sim.time.toFixed(0)}s`);
    const n = sim.neutronics;
    if (n) {
      lines.push(
        `  reactor: power=${(n.power / 1e6).toFixed(1)}MW` +
          ` nominal=${(n.nominalPower / 1e6).toFixed(0)}MW` +
          (n.scrammed ? ' SCRAMMED' : '')
      );
    }
    // Key readings per flow node, capped so a big plant can't blow up the prompt.
    const nodes = [...sim.flowNodes.entries()].slice(0, 40);
    for (const [id, node] of nodes) {
      lines.push(
        `  ${id}: P=${barFromPa(node.fluid.pressure)}bar T=${cFromK(node.fluid.temperature)}C` +
          ` m=${node.fluid.mass.toFixed(0)}kg ${node.fluid.phase}`
      );
    }
    if (sim.flowNodes.size > nodes.length) {
      lines.push(`  ...and ${sim.flowNodes.size - nodes.length} more nodes`);
    }
  } else {
    lines.push('simulation: not run yet');
  }

  if (changes.length > 0) {
    lines.push('recent plant edits (newest last):');
    for (const ch of changes.slice(-10)) {
      lines.push(`  [${ch.source}] ${ch.description}`);
    }
  }

  lines.push('[/CONTEXT]');
  return lines.join('\n');
}
