/**
 * Grid-view section views: a component contained by a standing sprite is
 * drawn ON that sprite at its elevation, connections between things in one
 * section view are drawn there, and a connection that leaves the container
 * is split at the wall. Checked on the Xe-100 plant layout (circulators
 * inside the SG vessel, above the bundle, discharging to the cross-vessel).
 *
 * Run: npx tsx scripts/test-grid-sections.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { GridView } from '../src/render/grid-view';
import { wallAnchor, sideFacing, footprintRect, componentFootprint } from '../src/render/grid-geometry';
import { getComponentSize } from '../src/render/component-size';
import { deserializePlantDesign } from '../src/simulation/serialization';
import { Connection, PlantComponent, Point, PumpComponent, TankComponent } from '../src/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const fmt = (p: Point) => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`;
const fmtBox = (b: { left: number; right: number; top: number; bottom: number }) =>
  `[x ${b.left.toFixed(0)}..${b.right.toFixed(0)}, y ${b.top.toFixed(0)}..${b.bottom.toFixed(0)}]`;

const plant = deserializePlantDesign(JSON.parse(fs.readFileSync(path.join(HERE, '../src/presets/xe100-plant.json'), 'utf8')));
const comp = (id: string): PlantComponent => {
  const c = plant.components.get(id);
  if (!c) throw new Error(`no component ${id}`);
  return c;
};
const conn = (from: string, fromPort: string, to: string, toPort: string): Connection => {
  const c = plant.connections.find(k => k.fromComponentId === from && k.fromPortId === fromPort &&
    k.toComponentId === to && k.toPortId === toPort);
  if (!c) throw new Error(`no connection ${from}:${fromPort} -> ${to}:${toPort}`);
  return c;
};

const grid = new GridView();
grid.setViewportSize(1600, 1000);
grid.centerOn(plant);
grid.setZoomFactor(1.5);

const sg = comp('tank-sg-1') as TankComponent;
const bundle = comp('hx-1');
const pumpA = comp('pump-1a') as PumpComponent;
const pumpB = comp('pump-1b') as PumpComponent;
const duct = comp('cv-1');

console.log('Xe-100 plant layout: SG vessel section view');
const sgBox = grid.spriteScreenBox(sg)!;
const bundleBox = grid.spriteScreenBox(bundle)!;
const pumpABox = grid.spriteScreenBox(pumpA)!;
const pumpBBox = grid.spriteScreenBox(pumpB)!;
check('the bundle is drawn inside the SG sprite',
  bundleBox.left >= sgBox.left - 1 && bundleBox.right <= sgBox.right + 1 &&
  bundleBox.top >= sgBox.top - 1 && bundleBox.bottom <= sgBox.bottom + 1,
  `bundle ${fmtBox(bundleBox)} sg ${fmtBox(sgBox)}`);
// The pump drawing (casing plus motor) is taller than its nominal diameter,
// so mounted at 16 m in an 18 m vessel its motor pokes above the dome; what
// the rule promises is that its BASE is at its elevation, inside the vessel
check('circulator A is drawn inside the SG sprite',
  pumpABox.left >= sgBox.left - 1 && pumpABox.right <= sgBox.right + 1 &&
  pumpABox.bottom >= sgBox.top - 1 && pumpABox.bottom <= sgBox.bottom + 1,
  `pump ${fmtBox(pumpABox)} sg ${fmtBox(sgBox)}`);
check('circulator A stands above the bundle', pumpABox.bottom <= bundleBox.top + 1,
  `pump bottom ${pumpABox.bottom.toFixed(0)} bundle top ${bundleBox.top.toFixed(0)}`);
check('the two circulators sit side by side at one height',
  near(pumpABox.top, pumpBBox.top, 0.5) && pumpBBox.left > pumpABox.left,
  `A ${fmtBox(pumpABox)} B ${fmtBox(pumpBBox)}`);
// The pump's elevation above the vessel bottom, in pixels, is exactly its
// height difference at the vessel's scale
const zoom = (sgBox.bottom - sgBox.top) / sg.height;
const expectedBase = sgBox.bottom - ((pumpA.elevation ?? 0) - (sg.elevation ?? 0)) * zoom;
check('circulator base sits at its elevation on the vessel sprite', near(pumpABox.bottom, expectedBase, 0.5),
  `base ${pumpABox.bottom.toFixed(1)} expected ${expectedBase.toFixed(1)}`);
check('the circulator sprite is at the vessel\'s scale, not the small-fitting minimum',
  near(pumpABox.right - pumpABox.left, getComponentSize(pumpA).width * zoom, 0.5),
  `pump width ${(pumpABox.right - pumpABox.left).toFixed(1)} expected ${(getComponentSize(pumpA).width * zoom).toFixed(1)}`);

// Clicking the circulator picks it, not the vessel behind it
const pumpCentre = { x: (pumpABox.left + pumpABox.right) / 2, y: (pumpABox.top + pumpABox.bottom) / 2 };
check('a click on the circulator hits the circulator', grid.componentAt(pumpCentre, plant)?.id === 'pump-1a',
  `got ${grid.componentAt(pumpCentre, plant)?.id}`);
const sgSkirt = { x: (sgBox.left + sgBox.right) / 2, y: sgBox.bottom - 2 };
check('a click on the vessel skirt hits the vessel', grid.componentAt(sgSkirt, plant)?.id === 'tank-sg-1',
  `got ${grid.componentAt(sgSkirt, plant)?.id}`);

console.log('Ports of contained components are drawn on the section view');
const outletPos = grid.portScreenPosition(pumpA, 'pump-1a-outlet')!;
check('circulator outlet is drawn on the pump sprite (left side, mid-height)',
  outletPos.x < pumpCentre.x && near(outletPos.y, pumpCentre.y, 0.5 * (pumpABox.bottom - pumpABox.top)),
  `outlet ${fmt(outletPos)} pump centre ${fmt(pumpCentre)}`);
// The vessel itself stands on the plan, so its own port MARKER stays a plan
// anchor on the footprint edge (that is where an outside pipe is laid to)
const suctionMarker = grid.portScreenPosition(sg, 'tank-sg-suction-a')!;
const sgRectScreen = {
  tl: grid.worldToScreen({ x: footprintRect(sg.position, componentFootprint(sg)).x0, y: footprintRect(sg.position, componentFootprint(sg)).y1 }),
  br: grid.worldToScreen({ x: footprintRect(sg.position, componentFootprint(sg)).x1, y: footprintRect(sg.position, componentFootprint(sg)).y0 }),
};
check('the vessel\'s own port marker stays on its footprint edge',
  suctionMarker.x >= sgRectScreen.tl.x - 1e-6 && suctionMarker.x <= sgRectScreen.br.x + 1e-6 &&
  suctionMarker.y >= sgRectScreen.tl.y - 1e-6 && suctionMarker.y <= sgRectScreen.br.y + 1e-6,
  `marker ${fmt(suctionMarker)} footprint ${fmt(sgRectScreen.tl)}..${fmt(sgRectScreen.br)}`);
// ...while a run from that port inside the section view starts where the
// port is on the sprite: 7.5 m above the vessel centre, under the dome
const suctionPos = { x: sgBox.left + (sgBox.right - sgBox.left) / 2 - 1.0 * zoom, y: (sgBox.top + sgBox.bottom) / 2 - 7.5 * zoom };
check('the suction port sits under the dome on the sprite', suctionPos.y < sgBox.top + 0.2 * (sgBox.bottom - sgBox.top),
  `suction ${fmt(suctionPos)} sg ${fmtBox(sgBox)}`);
const hit = grid.portAt({ x: outletPos.x, y: outletPos.y }, plant);
check('the outlet can be picked where it is drawn', hit?.component.id === 'pump-1a' && hit.port.id === 'pump-1a-outlet',
  `got ${hit?.component.id}:${hit?.port.id}`);
check('a route from it starts at the vessel wall, not at the pump', !!hit?.frameRoot && hit.frameRoot.id === 'tank-sg-1' &&
  (near(hit.anchor.point.x, footprintRect(sg.position, componentFootprint(sg)).x0) ||
   near(hit.anchor.point.x, footprintRect(sg.position, componentFootprint(sg)).x1)),
  `anchor ${hit ? fmt(hit.anchor.point) : 'none'} side ${hit?.anchor.side}`);

console.log('Connections');
// Vessel space -> circulator A: the circulator draws straight from the
// vessel's own space, so this is an opening at its inlet - no pipe anywhere
const suction = conn('tank-sg-1', 'tank-sg-suction-a', 'pump-1a', 'pump-1a-inlet');
const suctionDrawn = grid.connectionScreenPolylines(suction, plant);
check('suction opening has no lattice route', suctionDrawn.lattice === null);
check('suction opening draws no run in the section view', suctionDrawn.sections.length === 0);
const inlet = grid.portScreenPosition(pumpA, 'pump-1a-inlet')!;
const arrow = grid.connectionScreenEndpoints(suction, plant);
const nearInlet = (p: Point) => Math.hypot(p.x - inlet.x, p.y - inlet.y) <= 24;
check('its flow arrow sits on the pump inlet', !!arrow && nearInlet(arrow.fromPos) && nearInlet(arrow.toPos),
  arrow ? `${fmt(arrow.fromPos)} ${fmt(arrow.toPos)} inlet ${fmt(inlet)}` : 'none');

// Circulator A -> duct annulus. The duct is welded to the SG vessel, so the
// line is only the leg inside the vessel, to the duct's nozzle as drawn -
// nothing is routed across the plan
const discharge = conn('pump-1a', 'pump-1a-outlet', 'cv-1', 'cv-1-annulus-2');
const dischargeDrawn = grid.connectionScreenPolylines(discharge, plant);
check('discharge to a welded duct has no lattice route', dischargeDrawn.lattice === null);
check('discharge has one run inside the vessel', dischargeDrawn.sections.length === 1);
if (dischargeDrawn.sections.length === 1) {
  const inside = dischargeDrawn.sections[0];
  const end = inside[inside.length - 1];
  const ductBox = grid.spriteScreenBox(duct)!;
  check('  the inside run starts at the pump outlet', near(inside[0].x, outletPos.x, 1e-6) && near(inside[0].y, outletPos.y, 1e-6),
    `starts ${fmt(inside[0])} outlet ${fmt(outletPos)}`);
  check('  orthogonal', inside.every((p, i) => i === 0 || near(p.x, inside[i - 1].x, 1e-6) || near(p.y, inside[i - 1].y, 1e-6)));
  // The annulus nozzle: on the duct's SG end, on the TOP side of the inner
  // pipe - the circulators stand above the duct's axis
  check('  the run ends on the duct\'s annulus nozzle, on the side facing the pump', near(end.x, ductBox.right, 0.5) &&
    end.y < (ductBox.top + ductBox.bottom) / 2 && end.y >= ductBox.top,
    `ends ${fmt(end)} duct ${fmtBox(ductBox)}`);
  const drop = inside.find((p, i) => i > 0 && near(p.x, inside[0].x, 1e-6) && !near(p.y, inside[0].y, 1e-6));
  check('  the run drops from the pump to the nozzle\'s height', !!drop && near(drop.y, end.y, 1e-6) && drop.y > outletPos.y,
    `drop ${drop ? fmt(drop) : 'none'} nozzle y ${end.y.toFixed(1)} outlet y ${outletPos.y.toFixed(1)}`);
  check('  the discharge run is clickable inside the vessel', grid.connectionAt({ x: inside[0].x, y: end.y }, plant) === discharge);
  check('  it carries a flow arrow', grid.connectionScreenEndpoints(discharge, plant) !== null);
}

// Bundle shell outlet -> vessel space (a component to its own container): an
// opening on the bundle's nozzle, wherever the vessel's own port is
const shellOut = conn('hx-1', 'hx-1-shell-2', 'tank-sg-1', 'tank-sg-in');
const shellDrawn = grid.connectionScreenPolylines(shellOut, plant);
check('bundle-to-vessel opening draws nothing (no lattice route, no section run)',
  shellDrawn.lattice === null && shellDrawn.sections.length === 0);
const shellNozzle = grid.portScreenPosition(bundle, 'hx-1-shell-2')!;
const shellArrow = grid.connectionScreenEndpoints(shellOut, plant);
check('  its flow arrow sits on the bundle nozzle', !!shellArrow &&
  Math.hypot(shellArrow.fromPos.x - shellNozzle.x, shellArrow.fromPos.y - shellNozzle.y) <= 24,
  shellArrow ? `${fmt(shellArrow.fromPos)} nozzle ${fmt(shellNozzle)}` : 'none');

// The duct's other end is welded to the RPV: its annulus opens straight into
// the vessel's cold leg, so there is no line at all
const rv = comp('rv-1');
const coldLeg = conn('cv-1', 'cv-1-annulus-1', 'rv-1', 'rv-1-cold-leg');
const coldDrawn = grid.connectionScreenPolylines(coldLeg, plant);
check('the duct welded flush to the RPV draws no line', coldDrawn.lattice === null && coldDrawn.sections.length === 0);
// ...while the core outlet, inside the RPV, runs inside it to the duct's inner pipe
const hotLeg = conn('cb-1', 'cb-1-bottom', 'cv-1', 'cv-1-inner-in');
const hotDrawn = grid.connectionScreenPolylines(hotLeg, plant);
check('the core outlet to the welded duct is one run inside the RPV', hotDrawn.lattice === null && hotDrawn.sections.length === 1);
if (hotDrawn.sections.length === 1) {
  const run = hotDrawn.sections[0];
  const ductBox = grid.spriteScreenBox(duct)!;
  const end = run[run.length - 1];
  check('  ending on the duct\'s RPV end, on its axis', near(end.x, ductBox.left, 0.5) &&
    near(end.y, (ductBox.top + ductBox.bottom) / 2, 0.5), `ends ${fmt(end)} duct ${fmtBox(ductBox)}`);
}
check('a plan sprite stands on its footprint\'s south edge', near(grid.spriteScreenBox(rv)!.bottom,
  grid.worldToScreen({ x: rv.position.x, y: footprintRect(rv.position, componentFootprint(rv)).y0 }).y, 1e-6));
{
  // North is up the screen, as it is away from the 2.5D camera
  const south = grid.worldToScreen({ x: rv.position.x, y: rv.position.y - 5 });
  const north = grid.worldToScreen({ x: rv.position.x, y: rv.position.y + 5 });
  check('+y (north, away from the 2.5D camera) is up the screen', north.y < south.y, `north ${fmt(north)} south ${fmt(south)}`);
}

console.log('Wall anchors');
{
  const rect = footprintRect(sg.position, componentFootprint(sg));
  const port = pumpA.ports[1];
  const w = wallAnchor(sg, port, 'W', { x: sg.position.x - 20, y: rect.y1 + 5 });
  check('a partner north-west of the vessel meets the west wall at its north cell',
    w.side === 'W' && near(w.point.x, rect.x0) && near(w.point.y, rect.y1 - 0.5), fmt(w.point));
  const n = wallAnchor(sg, port, 'N', { x: rect.x1 + 3, y: rect.y1 + 10 });
  check('a partner north-east meets the north wall at its east cell',
    n.side === 'N' && near(n.point.y, rect.y1) && near(n.point.x, rect.x1 - 0.5), fmt(n.point));
  check('the out cell lies one half tile outside the wall', !!w.out && near(w.out.x, rect.x0 - 0.5) && near(w.out.y, w.point.y));
  check('sideFacing picks the dominant axis', sideFacing(sg, { x: sg.position.x - 3, y: sg.position.y + 1 }) === 'W' &&
    sideFacing(sg, { x: sg.position.x + 1, y: sg.position.y + 3 }) === 'N');
}

console.log('Plan routes');
{
  // SG vessel head -> primary safety valve, 4 m south of the head and 1 m
  // above it: a straight run from where the head nozzle stands to the face of
  // the valve turned to meet it (was a seven-leg tangle round the valve)
  const prel = conn('tank-sg-1', 'tank-sg-top', 'val-prel-1', 'val-prel-1-in');
  const runs = grid.planRuns(plant);
  const ends = grid.planRunEnds().get(prel);
  const r = runs.get(prel) ?? [];
  const valve = comp('val-prel-1');
  check('SG head to safety valve is one straight run', r.length === 2 &&
    near(r[0].x, sg.position.x) && near(r[0].y, sg.position.y) && near(r[1].x, valve.position.x) && near(r[1].y, valve.position.y + 0.5),
    r.map(fmt).join(' '));
  check('the head end is a vertical nozzle, the valve end a turned valve face',
    ends?.from?.vertical === 'up' && ends?.to?.side === 'N', JSON.stringify(ends));

  // No routed connection in any preset has a diagonal leg (the lattice used to
  // sit half a tile off every odd footprint centred on a whole metre)
  const dir = path.join(HERE, '../src/presets');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!Array.isArray(data.components) || !Array.isArray(data.connections)) continue;
    const p = deserializePlantDesign(data);
    const g = new GridView();
    g.setViewportSize(1600, 1000);
    g.centerOn(p);
    let diagonal = 0, total = 0;
    const bad: string[] = [];
    for (const [k, pts] of g.planRuns(p)) {
      if ((k as PlantComponent).type === 'pipe') continue;
      total++;
      if (pts.some((q, i) => i > 0 && Math.abs(q.x - pts[i - 1].x) > 1e-6 && Math.abs(q.y - pts[i - 1].y) > 1e-6)) {
        diagonal++;
        const c = k as Connection;
        if (bad.length < 3) bad.push(`${c.fromComponentId}:${c.fromPortId} -> ${c.toComponentId}:${c.toPortId} ${pts.map(fmt).join(' ')}`);
      }
    }
    check(`${file}: no diagonal legs in ${total} routed connections`, diagonal === 0, `${diagonal} diagonal; ${bad.join(' | ')}`);
  }
}

console.log(failures === 0 ? '\nAll grid section checks passed' : `\n${failures} grid section check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
