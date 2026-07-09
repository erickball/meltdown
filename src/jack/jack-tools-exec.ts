import type { JackHost } from './jack-host';
import type { PlantComponent } from '../types';
import { buildComponentCatalog, isKnownProperty } from './jack-catalog';
import {
  estimatePlantComponentCost,
  formatCost,
} from '../construction/cost-estimation';

const barFromPa = (pa: number) => Number((pa / 1e5).toFixed(3));
const cFromK = (k: number) => Number((k - 273.15).toFixed(2));

function resolveComponent(host: JackHost, ref: string): PlantComponent | null {
  const comps = host.plantState.components;
  if (comps.has(ref)) return comps.get(ref)!;
  const lower = ref.toLowerCase();
  for (const c of comps.values()) {
    if (c.id.toLowerCase() === lower) return c;
  }
  for (const c of comps.values()) {
    if (c.label && c.label.toLowerCase() === lower) return c;
  }
  return null;
}

function componentDetails(host: JackHost, comp: PlantComponent): unknown {
  // Full stored state minus internal cruft; units here are raw SI (this is
  // the live model, not dialog input).
  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(comp)) {
    if (k === 'ports' || typeof v === 'function') continue;
    raw[k] = v;
  }
  const ports = comp.ports.map((p) => ({
    id: p.id,
    direction: p.direction,
    connected: !!p.connectedTo,
  }));
  const connections = host.plantState.connections
    .filter(
      (c) => c.fromComponentId === comp.id || c.toComponentId === comp.id
    )
    .map((c) => `${c.fromPortId} -> ${c.toPortId}`);
  const est = estimatePlantComponentCost(comp as unknown as Record<string, unknown>);
  return {
    ...raw,
    unitsNote: 'stored values are SI (Pa, K, m, W); edits use catalog units',
    ports,
    connections,
    insideBuildingFootprint:
      comp.type === 'building' ? undefined : findContainingBuilding(host, comp.position)?.id ?? null,
    estimatedCost: est ? formatCost(est.total) : undefined,
  };
}

/** Footprint half-extents of a building (position = footprint center). */
export function buildingFootprint(b: any): { halfW: number; halfD: number } {
  const halfW = b.shape === 'cylinder' ? (b.diameter || 40) / 2 : (b.width || 40) / 2;
  const halfD = b.shape === 'cylinder' ? (b.diameter || 40) / 2 : (b.length || 40) / 2;
  return { halfW, halfD };
}

/** Same containment test the move UI uses (main.ts findContainingBuilding). */
export function findContainingBuilding(
  host: JackHost,
  pos: { x: number; y: number }
): PlantComponent | null {
  for (const comp of host.plantState.components.values()) {
    if (comp.type !== 'building') continue;
    const { halfW, halfD } = buildingFootprint(comp);
    const dx = pos.x - comp.position.x;
    const dy = pos.y - comp.position.y;
    const inside =
      (comp as any).shape === 'cylinder'
        ? (dx * dx) / (halfW * halfW) + (dy * dy) / (halfD * halfD) <= 1
        : Math.abs(dx) <= halfW && Math.abs(dy) <= halfD;
    if (inside) return comp;
  }
  return null;
}

function autoPosition(host: JackHost): { x: number; y: number } {
  const comps = [...host.plantState.components.values()];
  if (comps.length === 0) return { x: 0, y: 0 };
  const selectedId = host.getSelectedComponentId();
  const anchor = selectedId ? host.plantState.components.get(selectedId) : undefined;
  const maxX = Math.max(...comps.map((c) => c.position.x));
  const y = anchor ? anchor.position.y : comps[comps.length - 1].position.y;
  return { x: maxX + 12, y };
}

function requireConstruction(host: JackHost): string | null {
  if (host.getMode() !== 'construction') {
    return 'Plant changes are only possible in construction mode. The user must switch to construction mode (Build) first.';
  }
  return null;
}

const err = (message: string) => ({ ok: false as const, error: message });

/**
 * Execute one of Jack's tools against the live plant. Returns a JSON-able
 * result object; { ok: false, error } marks a tool error for the model.
 * `record` appends a line to the recent-changes journal.
 */
export function executeJackTool(
  name: string,
  input: Record<string, unknown>,
  host: JackHost,
  record: (description: string) => void
): unknown {
  switch (name) {
    case 'list_component_types':
      return buildComponentCatalog(
        Array.isArray(input.types) ? (input.types as string[]) : undefined
      );

    case 'get_component_details': {
      const comp = resolveComponent(host, String(input.component ?? ''));
      if (!comp) return err(`No component named "${input.component}"`);
      return componentDetails(host, comp);
    }

    case 'get_simulation_state': {
      const sim = host.getSimState();
      if (!sim) return err('No simulation has been run yet.');
      const wanted = Array.isArray(input.components)
        ? (input.components as string[])
        : null;
      if (wanted && wanted.length > 0) {
        const out: Record<string, unknown> = {};
        for (const ref of wanted) {
          const comp = resolveComponent(host, ref);
          if (!comp) {
            out[ref] = { error: 'not found' };
            continue;
          }
          const nodeId = comp.simNodeId ?? comp.id;
          const node =
            sim.flowNodes.get(nodeId) ?? sim.flowNodes.get(`${comp.id}-primary`);
          const flows = sim.flowConnections
            .filter((f) => f.fromNodeId === nodeId || f.toNodeId === nodeId)
            .map((f) => ({
              path: `${f.fromNodeId} -> ${f.toNodeId}`,
              massFlowKgS: Number(((f as any).massFlowRate ?? 0).toFixed(2)),
            }));
          out[comp.id] = node
            ? {
                pressureBar: barFromPa(node.fluid.pressure),
                temperatureC: cFromK(node.fluid.temperature),
                massKg: Math.round(node.fluid.mass),
                volumeM3: Number(node.volume.toFixed(2)),
                phase: node.fluid.phase,
                quality:
                  node.fluid.phase === 'two-phase'
                    ? Number(node.fluid.quality.toFixed(3))
                    : undefined,
                flows,
              }
            : { error: 'no flow node for this component' };
        }
        return { simTimeS: Math.round(sim.time), components: out };
      }
      // Plant-wide summary
      const n = sim.neutronics;
      const nodes: Record<string, unknown> = {};
      for (const [id, node] of sim.flowNodes) {
        nodes[id] = {
          pressureBar: barFromPa(node.fluid.pressure),
          temperatureC: cFromK(node.fluid.temperature),
          massKg: Math.round(node.fluid.mass),
          phase: node.fluid.phase,
        };
      }
      return {
        simTimeS: Math.round(sim.time),
        reactor: n
          ? {
              powerMW: Number((n.power / 1e6).toFixed(2)),
              nominalMW: Number((n.nominalPower / 1e6).toFixed(1)),
              scrammed: n.scrammed,
              reactivity: n.reactivity,
            }
          : undefined,
        nodes,
      };
    }

    case 'add_component': {
      const modeErr = requireConstruction(host);
      if (modeErr) return err(modeErr);
      const type = String(input.type ?? '');
      const compName = String(input.name ?? '');
      if (!type || !compName) return err('type and name are required');
      let containedById: string | undefined;
      let container: PlantComponent | null = null;
      if (input.containedBy) {
        container = resolveComponent(host, String(input.containedBy));
        if (!container) return err(`No container named "${input.containedBy}"`);
        containedById = container.id;
      }
      const posIn = input.position as { x?: unknown; y?: unknown } | undefined;
      let position: { x: number; y: number };
      if (posIn && Number.isFinite(posIn.x) && Number.isFinite(posIn.y)) {
        position = { x: Number(posIn.x), y: Number(posIn.y) };
      } else if (container) {
        // Default into the container's footprint center
        position = { x: container.position.x, y: container.position.y };
      } else {
        position = autoPosition(host);
      }
      const id = host.constructionManager.createComponent({
        type,
        name: compName,
        position,
        properties: {
          name: compName,
          ...((input.properties as Record<string, unknown>) ?? {}),
        },
        containedBy: containedById,
      });
      if (!id) {
        return err(
          `createComponent rejected type "${type}". Check the type key against list_component_types.`
        );
      }
      host.refreshCostPanel();
      record(`Jack added ${type} "${compName}" (${id})`);
      const comp = host.plantState.components.get(id)!;
      return { ok: true, created: componentDetails(host, comp) };
    }

    case 'edit_component': {
      const modeErr = requireConstruction(host);
      if (modeErr) return err(modeErr);
      const comp = resolveComponent(host, String(input.component ?? ''));
      if (!comp) return err(`No component named "${input.component}"`);
      const changes = (input.changes as Record<string, unknown>) ?? {};
      if (Object.keys(changes).length === 0) return err('changes is empty');
      // updateComponent silently ignores property names it doesn't know, so
      // catch typos/hallucinated names before reporting success. Use the
      // union of all schemas (per-type mapping is looser than the dialog's).
      const unknownKeys = Object.keys(changes).filter((k) => !isKnownProperty(k));
      if (unknownKeys.length === Object.keys(changes).length) {
        return err(
          `None of these are real property names: ${unknownKeys.join(', ')}. ` +
            'Property names come from the parts catalog (use move_component for position).'
        );
      }
      const ok = host.constructionManager.updateComponent(comp.id, changes);
      if (!ok) return err(`updateComponent failed for ${comp.id}`);
      host.refreshCostPanel();
      record(
        `Jack edited ${comp.id}: set ${Object.entries(changes)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ')}`
      );
      return {
        ok: true,
        ...(unknownKeys.length > 0
          ? {
              warning: `These property names don't exist in any schema and were IGNORED: ${unknownKeys.join(
                ', '
              )}. Do not report them as changed.`,
            }
          : {}),
        updated: componentDetails(host, comp),
      };
    }

    case 'move_component': {
      const modeErr = requireConstruction(host);
      if (modeErr) return err(modeErr);
      const comp = resolveComponent(host, String(input.component ?? ''));
      if (!comp) return err(`No component named "${input.component}"`);
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
        return err('x and y must be numbers (plan meters)');
      }
      const x = Number(input.x);
      const y = Number(input.y);
      const dx = x - comp.position.x;
      const dy = y - comp.position.y;
      comp.position.x = x;
      comp.position.y = y;
      // Pipes carry a second endpoint; translate it with the move
      const end = (comp as any).endPosition;
      if (end && Number.isFinite(end.x) && Number.isFinite(end.y)) {
        end.x += dx;
        end.y += dy;
      }
      // Update building containment from the destination, like the move UI.
      // Non-building containment (e.g. a core inside a vessel) is left alone.
      let containment = 'unchanged';
      const currentContainer = comp.containedBy
        ? host.plantState.components.get(comp.containedBy)
        : undefined;
      const containedByNonBuilding = currentContainer && currentContainer.type !== 'building';
      if (comp.type !== 'building' && !containedByNonBuilding) {
        const b = findContainingBuilding(host, comp.position);
        const prevB = currentContainer?.type === 'building' ? currentContainer.id : null;
        if ((b?.id ?? null) !== prevB) {
          if (b) (comp as any).containedBy = b.id;
          else delete (comp as any).containedBy;
          containment = b
            ? `now inside ${b.label ?? b.id}`
            : 'now outside any building';
          host.refreshCostPanel();
        }
      }
      record(`Jack moved ${comp.id} to (${x}, ${y}) — containment ${containment}`);
      return { ok: true, moved: comp.id, position: { x, y }, containment };
    }

    case 'connect_components': {
      const modeErr = requireConstruction(host);
      if (modeErr) return err(modeErr);
      const from = resolveComponent(host, String(input.from ?? ''));
      const to = resolveComponent(host, String(input.to ?? ''));
      if (!from) return err(`No component named "${input.from}"`);
      if (!to) return err(`No component named "${input.to}"`);

      const pickPort = (
        comp: PlantComponent,
        nameHint: unknown,
        outward: boolean
      ) => {
        const dirOk = (d: string) => d === 'both' || d === (outward ? 'out' : 'in');
        if (nameHint) {
          const hint = String(nameHint).toLowerCase();
          const named = comp.ports.find((p) =>
            p.id.toLowerCase().endsWith(`-${hint}`) || p.id.toLowerCase() === hint
          );
          if (!named) {
            return {
              error: `No port matching "${nameHint}" on ${comp.id}. Ports: ${comp.ports
                .map((p) => p.id)
                .join(', ')}`,
            };
          }
          return { port: named };
        }
        const free = comp.ports.find((p) => !p.connectedTo && dirOk(p.direction));
        const any = comp.ports.find((p) => dirOk(p.direction)) ?? comp.ports[0];
        const port = free ?? any;
        if (!port) return { error: `${comp.id} has no ports` };
        return { port };
      };

      const fromPick = pickPort(from, input.fromPort, true);
      if ('error' in fromPick) return err(fromPick.error!);
      const toPick = pickPort(to, input.toPort, false);
      if ('error' in toPick) return err(toPick.error!);

      const props = (input.properties as Record<string, unknown>) ?? {};
      let flowArea = typeof props.flowArea === 'number' ? props.flowArea : undefined;
      if (flowArea === undefined && typeof props.diameter === 'number') {
        flowArea = (Math.PI * props.diameter * props.diameter) / 4;
      }
      const ok = host.constructionManager.createConnection(
        fromPick.port!.id,
        toPick.port!.id,
        typeof props.fromElevation === 'number' ? props.fromElevation : undefined,
        typeof props.toElevation === 'number' ? props.toElevation : undefined,
        flowArea,
        typeof props.length === 'number' ? props.length : undefined
      );
      if (!ok) {
        return err(
          `createConnection failed (${fromPick.port!.id} -> ${toPick.port!.id}) â€” see console`
        );
      }
      host.refreshCostPanel();
      record(`Jack connected ${fromPick.port!.id} -> ${toPick.port!.id}`);
      return {
        ok: true,
        connected: `${fromPick.port!.id} -> ${toPick.port!.id}`,
        flowArea,
      };
    }

    case 'delete_component': {
      const modeErr = requireConstruction(host);
      if (modeErr) return err(modeErr);
      const comp = resolveComponent(host, String(input.component ?? ''));
      if (!comp) return err(`No component named "${input.component}"`);
      const label = comp.label ?? comp.id;
      const ok = host.constructionManager.deleteComponent(comp.id);
      if (!ok) return err(`deleteComponent failed for ${comp.id}`);
      host.refreshCostPanel();
      record(`Jack deleted ${comp.type} "${label}" (${comp.id})`);
      return { ok: true, deleted: comp.id };
    }

    default:
      return err(`Unknown tool: ${name}`);
  }
}
