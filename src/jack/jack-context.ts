import type { JackHost, PlantChange } from './jack-host';

const barFromPa = (pa: number) => (pa / 1e5).toFixed(2);
const cFromK = (k: number) => (k - 273.15).toFixed(1);

/**
 * Build the machine-generated CONTEXT block that rides along with each user
 * message. Kept deliberately compact — Jack has tools for full detail.
 */
export function buildContextBlock(host: JackHost, changes: PlantChange[]): string {
  const lines: string[] = ['[CONTEXT]'];
  lines.push(`mode: ${host.getMode()}`);

  const selected = host.getSelectedComponentId();
  if (selected) {
    const comp = host.plantState.components.get(selected);
    lines.push(
      `selected component: ${selected}${comp?.label ? ` ("${comp.label}")` : ''}`
    );
  }

  // Plant inventory: one line per component, connections summarized.
  const comps = [...host.plantState.components.values()];
  lines.push(`plant: ${comps.length} components`);
  for (const c of comps) {
    let line = `  ${c.id} [${c.type}]`;
    if (c.label && c.label !== c.id) line += ` "${c.label}"`;
    if (c.elevation !== undefined && c.elevation !== 0) line += ` elev=${c.elevation}m`;
    if (c.containedBy) line += ` in ${c.containedBy}`;
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
