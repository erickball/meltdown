/**
 * Put vertical heat exchangers' tube nozzles on their plenums, in the plants
 * that are stored as baked JSON (no generator to edit).
 *
 * For each vertical U-tube / helical / straight exchanger:
 *  1. If its lower header is drawn below the floor it stands on (the
 *     containing building's floor, or the ground), raise it until the header
 *     sits on the floor. A PWR steam generator stood at elevation 0 with a 1 m
 *     header drawn through the slab.
 *  2. Move the tube nozzles to where the construction manager puts them for
 *     any new exchanger (heatExchangerPorts): on the header of the bundle they
 *     open into - a U-tube's pair on its one lower header, a helical or
 *     straight bundle's inlet on the lower header and outlet on the upper.
 *     Existing port ids are kept (tube-1 = inlet/lower, tube-2 = outlet), so
 *     controllers and flow ids that name them are untouched.
 *  3. Move every connection's elevation at those nozzles to the nozzle, and a
 *     baked pipe stub on the other end by the same amount, so the drawn line
 *     still meets the pipe and the pipe still meets the nozzle.
 *
 * Shell-side connections keep their elevation relative to the shell (they
 * rise with it). Idempotent: a second run changes nothing.
 *
 * Usage: npx tsx scripts/fix-hx-plenum-nozzles.ts [--dry]
 */
import * as fs from 'fs';
import { heatExchangerPorts } from '../src/construction/construction-manager';

const DRY = process.argv.includes('--dry');

// Each group is edited together: a level's solution fragment wires into
// components that live in its site file.
const GROUPS: string[][] = [
  ['src/presets/pwr.json'],
  ['src/presets/sbo.json'],
  ['src/presets/two-loop.json'],
  ['src/presets/w4loop.json'],
  ['src/presets/htgr.json'],
  ['src/game-mode/levels/level1-site.json', 'src/game-mode/levels/level1-reactor-solution.json'],
];

// Optional name filters (e.g. `pwr sbo`): only the groups whose first file
// contains one of them. No filters = every group.
const ONLY = process.argv.slice(2).filter(a => !a.startsWith('--'));
const SELECTED = ONLY.length === 0 ? GROUPS : GROUPS.filter(g => ONLY.some(o => g[0].includes(o)));
if (ONLY.length > 0 && SELECTED.length !== ONLY.length) {
  throw new Error(`filters ${ONLY.join(', ')} matched ${SELECTED.map(g => g[0]).join(', ') || 'nothing'} - give one filter per group`);
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

interface Doc { path: string; crlf: boolean; data: any; changed: boolean }

for (const group of SELECTED) {
  const docs: Doc[] = group.map(p => {
    const text = fs.readFileSync(p, 'utf8');
    return { path: p, crlf: text.includes('\r\n'), data: JSON.parse(text), changed: false };
  });
  // Every component in the group, and which document holds it
  const owner = new Map<string, Doc>();
  const comps = new Map<string, any>();
  for (const d of docs) {
    for (const [id, c] of d.data.components ?? []) {
      if (!comps.has(id)) { comps.set(id, c); owner.set(id, d); }
    }
  }

  for (const [id, hx] of comps) {
    if (hx.type !== 'heatExchanger') continue;
    const isVertical = hx.orientation ? hx.orientation === 'vertical' : hx.height > hx.width;
    if (!isVertical) {
      console.log(`  ${id}: horizontal - not handled here`);
      continue;
    }
    const hxType: string = hx.hxType || 'utube';
    const plenum: number = hx.plenumLength ?? 0;
    const bundleCount = Math.max(1, Math.round(hx.bundleCount ?? 1));

    // 1. Floor: the containing building's, or the ground. Inside a vessel the
    //    exchanger stands wherever its designer put it.
    const container = hx.containedBy ? comps.get(hx.containedBy) : undefined;
    let raise = 0;
    if (!container || container.type === 'building') {
      const floor = container?.elevation ?? 0;
      raise = Math.max(0, r3(floor - (hx.elevation - plenum)));
    }
    const oldElev: number = hx.elevation;
    const newElev = r3(oldElev + raise);

    // 2. Where the nozzles go
    const canonical = heatExchangerPorts({
      id, isVertical: true, hxType,
      shellDiameter: hx.width, shellLength: hx.height,
      plenumLength: plenum, bundleCount,
    });
    const canonicalPos = new Map(canonical.map(p => [p.id, p.position]));
    const target = (portId: string): { x: number; y: number } | undefined => {
      if (canonicalPos.has(portId)) return canonicalPos.get(portId);
      if (hxType === 'utube') return undefined;
      // Helical / straight: tube-1 is the inlet (lower header), tube-2 the outlet
      const m = portId.match(new RegExp(`^${id}-tube-([12])(-b\\d+)?$`));
      if (!m) return undefined;
      return canonicalPos.get(`${id}-tube-${m[1] === '1' ? 'bottom' : 'top'}${m[2] ?? ''}`);
    };
    const newPortPos = new Map<string, { x: number; y: number }>();
    for (const p of hx.ports) {
      if (!p.id.includes('-tube')) continue;
      const t = target(p.id);
      if (!t) { console.log(`  ${id}: tube port ${p.id} has no header position - left where it is`); continue; }
      // A single U-tube header's two nozzles keep the side they were on: a
      // plant laid out mirror-image (inlet nozzle toward a reactor on the
      // right) must not have its pair swapped across the divider.
      const x = hxType === 'utube' && bundleCount === 1 && p.position.x !== 0
        ? Math.sign(p.position.x) * Math.abs(t.x)
        : t.x;
      newPortPos.set(p.id, { x: r3(x), y: r3(t.y) });
    }

    // 3. Connections at this exchanger, in every document of the group
    let moved = 0;
    for (const d of docs) {
      for (const k of d.data.connections ?? []) {
        const atFrom = k.fromComponentId === id;
        const atTo = k.toComponentId === id;
        if (!atFrom && !atTo) continue;
        const portId: string = atFrom ? k.fromPortId : k.toPortId;
        const oldRel: number = (atFrom ? k.fromElevation : k.toElevation) ?? 0;
        const pos = newPortPos.get(portId);
        const newRel = pos ? r3(hx.height / 2 - pos.y) : oldRel;
        const delta = r3((newElev + newRel) - (oldElev + oldRel));
        if (atFrom) k.fromElevation = newRel; else k.toElevation = newRel;
        if (newRel !== oldRel) d.changed = true;

        const otherId: string = atFrom ? k.toComponentId : k.fromComponentId;
        const other = comps.get(otherId);
        if (other?.type === 'pipe' && delta !== 0) {
          const otherPort: string = atFrom ? k.toPortId : k.fromPortId;
          const oldLength: number = other.length;
          if (otherPort.endsWith('-left')) other.elevation = r2(other.elevation + delta);
          else if (otherPort.endsWith('-right')) other.endElevation = r2(other.endElevation + delta);
          else throw new Error(`${otherId}: connected at ${otherPort}, neither end of the pipe`);
          const plan = Math.hypot(other.endPosition.x - other.position.x, other.endPosition.y - other.position.y);
          const run = Math.hypot(plan, other.endElevation - other.elevation);
          if (run > oldLength) {
            other.length = r2(run);
            const right = other.ports.find((p: any) => p.id.endsWith('-right'));
            if (right && Math.abs(right.position.x - oldLength) < 1e-6) right.position.x = other.length;
          }
          owner.get(otherId)!.changed = true;
          console.log(`  ${id}.${portId}: ${otherId} end moved ${delta >= 0 ? '+' : ''}${delta} m (now ${other.elevation} -> ${other.endElevation}, L=${other.length})`);
        }
        moved++;
      }
    }

    for (const p of hx.ports) {
      const pos = newPortPos.get(p.id);
      if (pos && (pos.x !== p.position.x || pos.y !== p.position.y)) {
        console.log(`  ${id}.${p.id}: (${p.position.x}, ${p.position.y}) -> (${pos.x}, ${pos.y})`);
        p.position = pos;
        owner.get(id)!.changed = true;
      }
    }
    if (raise > 0) {
      hx.elevation = newElev;
      owner.get(id)!.changed = true;
      console.log(`  ${id}: raised ${raise} m (${oldElev} -> ${newElev}) so its lower header sits on the floor`);
    }
    console.log(`${group[0]} ${id}: ${moved} connection end(s) checked`);
  }

  for (const d of docs) {
    if (!d.changed) continue;
    let out = JSON.stringify(d.data, null, 2) + '\n';
    if (d.crlf) out = out.replace(/\n/g, '\r\n');
    if (!DRY) fs.writeFileSync(d.path, out);
    console.log(`${DRY ? '(dry) ' : ''}wrote ${d.path}`);
  }
}
