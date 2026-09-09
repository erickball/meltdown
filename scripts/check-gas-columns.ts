/**
 * Loop-closure check for the hydrostatic model.
 *
 * Builds every shipped preset, test plant and level, sets EVERY flow to zero,
 * and adds up the hydrostatic terms around every independent loop of the flow
 * network - the loops through the ATMOSPHERE included, which is how a vented
 * building or a pool with two openings closes.
 *
 * Two numbers per loop, and they answer different questions:
 *
 *  - UNIFORM: the same sum with one density everywhere. It MUST be zero (to
 *    round-off): with one density the columns inside the nodes and the
 *    columns along the lines between them telescope to nothing around any
 *    closed path. Anything else is a broken ladder - the two books
 *    (a connection's `elevation` and its two ports' local elevations)
 *    disagreeing, which is the 1.85 bar phantom head of
 *    docs/hydrostatic-loop-convention. Per connection the same defect shows
 *    up as the GEOMETRY RESIDUAL: conn.elevation minus the difference of the
 *    two ports' absolute elevations, as pressureAtConnection actually reads
 *    them (a port clamped into its node's body is a broken rung and shows
 *    here).
 *
 *  - REAL: the sum with the model's actual densities. This one is NOT
 *    expected to be zero. A loop whose two legs stand at different densities
 *    has a real buoyancy head, and that head is the whole point - it is what
 *    drives a thermosyphon, and (through the atmosphere) what makes a hot
 *    drained pool breathe. It is printed with the loop's density spread so
 *    a big number can be read as the physics it is.
 *
 * Usage: npx tsx scripts/check-gas-columns.ts [--verbose] [file ...]
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import {
  computeConnectionHydraulics, nodeGasSpaceDensity,
  calculateLiquidLevelWithObstructions, approxLiquidDensity,
} from '../src/simulation/operators/connection-hydraulics';
import type { SimulationState, FlowNode, FlowConnection } from '../src/simulation/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const G = 9.81;
/** The one density the UNIFORM check uses. Any value works - it scales out. */
const RHO_REF = 1000;

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const explicit = args.filter(a => !a.startsWith('--'));

function defaultFiles(): string[] {
  const dirs = [
    path.join(ROOT, 'src', 'presets'),
    path.join(ROOT, 'scripts', 'test-plants'),
    path.join(ROOT, 'src', 'game-mode', 'levels'),
  ];
  const out: string[] = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) {
      if (f.endsWith('.json')) out.push(path.join(d, f));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The geometry pressureAtConnection actually reads
// ---------------------------------------------------------------------------

/** The local elevation inside `node` that pressureAtConnection prices to. */
function effectiveLocalElevation(node: FlowNode, stated: number | undefined): number {
  const h = node.height ?? Math.cbrt(node.volume);
  if (h <= 0) return 0;                      // a point: no internal extent
  if (stated === undefined) return h / 2;
  if (node.isBoundary) return stated;        // the outside air has no walls
  return Math.max(0, Math.min(h, stated));
}

/** Absolute elevation of the node's liquid surface - the datum its pressure sits at. */
function surfaceElevation(node: FlowNode): number {
  const h = node.height ?? Math.cbrt(node.volume);
  if (h <= 0) return node.elevation;
  if (node.fluid.phase === 'liquid') return node.elevation + h;
  if (node.fluid.phase === 'vapor') return node.elevation;
  const quality = Math.max(0, Math.min(1, node.fluid.quality ?? 0));
  const rhoL = approxLiquidDensity(node);
  const liquidVolume = Math.min(node.volume, node.fluid.mass * (1 - quality) / rhoL);
  return node.elevation + calculateLiquidLevelWithObstructions(node, liquidVolume);
}

/** The density of what stands between the port and the surface, in the model's own terms. */
function columnDensity(node: FlowNode, localElev: number): number {
  const h = node.height ?? Math.cbrt(node.volume);
  if (h <= 0) return 0;
  const surface = surfaceElevation(node) - node.elevation;
  if (localElev < surface) {
    if (node.fluid.phase === 'liquid') return node.fluid.mass / node.volume;
    return approxLiquidDensity(node);
  }
  const quality = node.fluid.phase === 'two-phase'
    ? Math.max(0, Math.min(1, node.fluid.quality ?? 0)) : 0;
  const liquidVolume = node.fluid.phase === 'liquid' ? node.volume
    : node.fluid.phase === 'vapor' ? 0
      : Math.min(node.volume, node.fluid.mass * (1 - quality) / approxLiquidDensity(node));
  return nodeGasSpaceDensity(node, liquidVolume);
}

// ---------------------------------------------------------------------------
// Fundamental cycles of the flow network
// ---------------------------------------------------------------------------

interface Edge { conn: FlowConnection; a: string; b: string; }

/** Every non-tree edge closes exactly one fundamental cycle with the spanning tree. */
function fundamentalCycles(state: SimulationState): Array<Array<{ conn: FlowConnection; forward: boolean }>> {
  const edges: Edge[] = [];
  for (const conn of state.flowConnections) {
    if (!state.flowNodes.has(conn.fromNodeId) || !state.flowNodes.has(conn.toNodeId)) continue;
    if (conn.fromNodeId === conn.toNodeId) continue;
    edges.push({ conn, a: conn.fromNodeId, b: conn.toNodeId });
  }
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  for (const id of state.flowNodes.keys()) parent.set(id, id);

  // Spanning forest first, so every remaining edge closes a cycle
  const tree: Edge[] = [];
  const extra: Edge[] = [];
  for (const e of edges) {
    const ra = find(e.a), rb = find(e.b);
    if (ra === rb) extra.push(e);
    else { parent.set(ra, rb); tree.push(e); }
  }

  // Adjacency over the tree, for the path between the two ends of each extra edge
  const adj = new Map<string, Array<{ to: string; edge: Edge }>>();
  for (const e of tree) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a)!.push({ to: e.b, edge: e });
    adj.get(e.b)!.push({ to: e.a, edge: e });
  }

  const cycles: Array<Array<{ conn: FlowConnection; forward: boolean }>> = [];
  for (const closing of extra) {
    // BFS through the tree from closing.b back to closing.a
    const cameFrom = new Map<string, { from: string; edge: Edge }>();
    const seen = new Set<string>([closing.b]);
    const queue = [closing.b];
    let found = false;
    while (queue.length && !found) {
      const cur = queue.shift()!;
      for (const nb of adj.get(cur) ?? []) {
        if (seen.has(nb.to)) continue;
        seen.add(nb.to);
        cameFrom.set(nb.to, { from: cur, edge: nb.edge });
        if (nb.to === closing.a) { found = true; break; }
        queue.push(nb.to);
      }
    }
    if (!found) continue;   // should not happen: they are in the same tree
    const walk: Array<{ conn: FlowConnection; forward: boolean }> = [];
    let node = closing.a;
    while (node !== closing.b) {
      const step = cameFrom.get(node)!;
      // We traverse from `node` to `step.from`
      walk.push({ conn: step.edge.conn, forward: step.edge.conn.fromNodeId === node });
      node = step.from;
    }
    // Close it with the extra edge, traversed b -> a... we walked a -> b above
    walk.unshift({ conn: closing.conn, forward: closing.conn.fromNodeId === closing.b });
    cycles.push(walk);
  }
  return cycles;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface FileResult {
  file: string;
  connections: number;
  loops: number;
  worstGeometry: { conn: string; residual: number } | null;
  worstUniform: { loop: string; net: number } | null;
  worstReal: { loop: string; net: number; rhoSpread: string } | null;
  error?: string;
}

function checkFile(file: string): FileResult {
  const res: FileResult = {
    file: path.relative(ROOT, file).replace(/\\/g, '/'),
    connections: 0, loops: 0,
    worstGeometry: null, worstUniform: null, worstReal: null,
  };
  let sim;
  try {
    sim = buildSimFromFile(file);
  } catch (e) {
    res.error = (e as Error).message.split('\n')[0];
    return res;
  }
  const state = sim.state;
  for (const conn of state.flowConnections) conn.massFlowRate = 0;
  res.connections = state.flowConnections.length;

  // Per-connection geometry residual: does the line's own elevation change
  // agree with the two ports pressureAtConnection prices head to?
  for (const conn of state.flowConnections) {
    const from = state.flowNodes.get(conn.fromNodeId);
    const to = state.flowNodes.get(conn.toNodeId);
    if (!from || !to) continue;
    const pFrom = from.elevation + effectiveLocalElevation(from, conn.fromElevation);
    const pTo = to.elevation + effectiveLocalElevation(to, conn.toElevation);
    const residual = (conn.elevation ?? 0) - (pTo - pFrom);
    if (!res.worstGeometry || Math.abs(residual) > Math.abs(res.worstGeometry.residual)) {
      res.worstGeometry = { conn: conn.id, residual };
    }
  }

  const cycles = fundamentalCycles(state);
  res.loops = cycles.length;
  for (const cycle of cycles) {
    let uniform = 0;
    let real = 0;
    let rhoMin = Infinity, rhoMax = -Infinity;
    const names: string[] = [];
    for (const step of cycle) {
      const conn = step.conn;
      const from = state.flowNodes.get(conn.fromNodeId)!;
      const to = state.flowNodes.get(conn.toNodeId)!;
      const sign = step.forward ? 1 : -1;
      names.push(`${sign > 0 ? '' : '-'}${conn.id}`);

      // REAL: exactly what the momentum equation sees, at zero flow
      const h = computeConnectionHydraulics(state, conn, from, to);
      real += sign * (h.dP_pressure + h.dP_gravity);
      // The node pressures telescope around the loop, so subtract them out
      // and what is left is the hydrostatic content alone.
      real -= sign * (from.fluid.pressure - to.fluid.pressure);

      // UNIFORM: the same terms with one density everywhere
      const zFrom = effectiveLocalElevation(from, conn.fromElevation);
      const zTo = effectiveLocalElevation(to, conn.toElevation);
      const surfFrom = surfaceElevation(from) - (from.elevation + zFrom);
      const surfTo = surfaceElevation(to) - (to.elevation + zTo);
      uniform += sign * RHO_REF * G * (surfFrom - surfTo - (conn.elevation ?? 0));

      for (const [node, z] of [[from, zFrom], [to, zTo]] as Array<[FlowNode, number]>) {
        const rho = columnDensity(node, z);
        if (rho > 0) { rhoMin = Math.min(rhoMin, rho); rhoMax = Math.max(rhoMax, rho); }
      }
    }
    const label = names.join(' ');
    if (!res.worstUniform || Math.abs(uniform) > Math.abs(res.worstUniform.net)) {
      res.worstUniform = { loop: label, net: uniform };
    }
    if (!res.worstReal || Math.abs(real) > Math.abs(res.worstReal.net)) {
      res.worstReal = {
        loop: label, net: real,
        rhoSpread: rhoMin <= rhoMax ? `${rhoMin.toPrecision(3)}..${rhoMax.toPrecision(3)} kg/m3` : 'n/a',
      };
    }
    if (verbose) {
      console.log(`    loop ${label}`);
      console.log(`      uniform ${uniform.toExponential(2)} Pa   real ${real.toFixed(1)} Pa`);
    }
  }
  return res;
}

const files = explicit.length ? explicit : defaultFiles();
const results: FileResult[] = [];
for (const f of files) {
  if (verbose) console.log(`\n--- ${f}`);
  results.push(checkFile(f));
}

console.log('');
console.log('Loop closure of the hydrostatic model (all flows zeroed)');
console.log('  UNIFORM = net head around the loop with one density everywhere; MUST be ~0');
console.log('  REAL    = net head with the model\'s own densities; a buoyancy loop is SUPPOSED to be nonzero');
console.log('');
console.log('plant                                  conns loops   geom resid    UNIFORM Pa       REAL Pa');
let worstUniform = 0;
let worstGeom = 0;
let failures = 0;
for (const r of results) {
  if (r.error) {
    console.log(`${r.file.padEnd(38)} ERROR ${r.error}`);
    failures++;
    continue;
  }
  const g = r.worstGeometry ? r.worstGeometry.residual : 0;
  const u = r.worstUniform ? r.worstUniform.net : 0;
  const rl = r.worstReal ? r.worstReal.net : 0;
  worstUniform = Math.max(worstUniform, Math.abs(u));
  worstGeom = Math.max(worstGeom, Math.abs(g));
  console.log(
    `${r.file.padEnd(38)} ${String(r.connections).padStart(5)} ${String(r.loops).padStart(5)} ` +
    `${g.toExponential(2).padStart(12)} ${u.toExponential(3).padStart(12)} ${rl.toFixed(1).padStart(13)}`);
}
console.log('');
for (const r of results) {
  if (r.error || !r.worstReal || Math.abs(r.worstReal.net) < 1) continue;
  console.log(`${r.file}: strongest buoyancy loop ${r.worstReal.net.toFixed(1)} Pa over ` +
    `${r.worstReal.rhoSpread}`);
  console.log(`    ${r.worstReal.loop}`);
}
console.log('');
console.log(`worst geometry residual ${worstGeom.toExponential(2)} m, ` +
  `worst uniform-density loop head ${worstUniform.toExponential(2)} Pa`);
if (failures > 0) {
  console.log(`${failures} plant(s) failed to build`);
  process.exit(1);
}
