/**
 * Bake auto-pipes into preset/level plants and clean up their layouts.
 *
 * Any connection wider than 0.1 m^2 AND longer than 1 m gets a real pipe
 * component (same rule the interactive connection dialog enforces), except
 * internal connections (one endpoint contained by the other - e.g. core
 * barrel to its own vessel, which is plenum space, not a pipe).
 *
 * Geometry follows the construction path (createConnectionWithPipe) but with
 * edge-attachment: each end starts at the component's plan-view edge facing
 * its partner, so the drawn pipe lines up with the equipment instead of
 * spearing through sprite centers.
 *
 * Also applies per-file component moves (FW trains out from behind the
 * turbine/condenser, out-of-containment gear pulled inside) and lays
 * controller cabinets out on a readable grid.
 *
 * Usage: node scripts/bake-pipes.cjs [--dry]
 */
const fs = require('fs');

const DRY = process.argv.includes('--dry');

// ---------------------------------------------------------------------------
// Per-file layout adjustments
// ---------------------------------------------------------------------------
const FW_TRAIN = {
  'cond-pump-1': { x: 96, y: 82 },
  'fw-pump-1': { x: 84, y: 86 },
  'val-fwcv-1': { x: 72, y: 86 },
};

const FILES = [
  {
    path: 'src/presets/pwr.json',
    moves: { ...FW_TRAIN },
    controllerGrid: { cols: [22, 32], y0: 60, dy: 7 },
  },
  {
    path: 'src/presets/two-loop.json',
    moves: {
      ...FW_TRAIN,
      'fw-pump-2': { x: 84, y: 90 },
      'val-fwcv-2': { x: 72, y: 90 },
      'hx-2': { x: 33, y: 73 },   // was (25,75): outside the containment footprint
      'pump-2': { x: 37, y: 86 },
    },
    controllerGrid: { cols: [22, 32], y0: 60, dy: 7 },
  },
  {
    path: 'src/presets/bwr.json',
    moves: { ...FW_TRAIN },
    controllerGrid: { cols: [22, 32], y0: 60, dy: 7 },
  },
  {
    path: 'src/presets/htgr.json',
    moves: { ...FW_TRAIN },
    controllerGrid: { cols: [22, 32], y0: 60, dy: 7 },
  },
  {
    path: 'src/presets/sbo.json',
    moves: { ...FW_TRAIN },
    controllerGrid: { cols: [22, 32], y0: 60, dy: 7 },
  },
  {
    path: 'src/presets/prompt-crit.json',
    moves: { ...FW_TRAIN },
    controllerGrid: { cols: [22, 32], y0: 60, dy: 7 },
  },
  {
    path: 'src/presets/meltdown-demo.json',
    moves: {},
  },
  {
    path: 'src/presets/w4loop.json',
    moves: {
      // accumulators + their check valves hugged / crossed the containment wall
      'acc-1': { x: 38, y: 96 }, 'val-acccv-1': { x: 39, y: 92 },
      'acc-2': { x: 44, y: 98 }, 'val-acccv-2': { x: 45, y: 93 },
      'acc-3': { x: 52, y: 98 }, 'val-acccv-3': { x: 51, y: 93 },
      'acc-4': { x: 58, y: 96 }, 'val-acccv-4': { x: 57, y: 92 },
    },
    controllerGrid: { cols: [6, 16], y0: 40, dy: 7 },
  },
  {
    path: 'src/game-mode/levels/level1-site.json',
    moves: { ...FW_TRAIN },
    controllerGrid: { cols: [22, 32], y0: 60, dy: 7 },
  },
  {
    // References stock components from level1-site: merge for lookups,
    // write pipes into the solution fragment.
    path: 'src/game-mode/levels/level1-reactor-solution.json',
    moves: {},
    lookupExtra: 'src/game-mode/levels/level1-site.json',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function halfExtent(comp, comps) {
  switch (comp.type) {
    case 'reactorVessel':
      return (comp.innerDiameter ?? 4) / 2 + (comp.wallThickness ?? 0);
    case 'coreBarrel': {
      const parent = comp.containedBy ? comps.get(comp.containedBy) : undefined;
      if (parent) return halfExtent(parent, comps);
      return (comp.innerDiameter ?? 3) / 2;
    }
    case 'heatExchanger': return (comp.width ?? 4) / 2;
    case 'condenser': return (comp.width ?? 8) / 2;
    case 'tank': return (comp.width ?? 2) / 2;
    case 'turbine-generator': return (comp.width ?? 15) / 2;
    case 'pump': return (comp.diameter ?? 0.5) * 0.9;
    case 'valve': return (comp.diameter ?? 0.2);
    default: return 1;
  }
}

function buildingOf(comp, comps) {
  let cur = comp;
  for (let i = 0; i < 5 && cur; i++) {
    if (!cur.containedBy) return undefined;
    const parent = comps.get(cur.containedBy);
    if (!parent) return undefined;
    if (parent.type === 'building') return parent.id;
    cur = parent;
  }
  return undefined;
}

function effectiveRating(comp, portId, comps) {
  if (comp.type === 'heatExchanger') {
    if (portId.includes('tube')) return comp.tubePressureRating ?? comp.pressureRating ?? 0;
    if (portId.includes('shell')) return comp.shellPressureRating ?? comp.pressureRating ?? 0;
    return comp.pressureRating ?? 0;
  }
  if (comp.type === 'coreBarrel' && comp.containedBy) {
    const parent = comps.get(comp.containedBy);
    if (parent) return parent.pressureRating ?? comp.pressureRating ?? 0;
  }
  return comp.pressureRating ?? 0;
}

/** Fluid state at a specific port/elevation (mirrors getFluidAtElevation). */
function fluidAtPort(comp, portId, relElev) {
  if (comp.type === 'heatExchanger') {
    if (portId.includes('tube')) return { f: comp.primaryFluid, ncg: comp.initialNcg };
    if (portId.includes('shell')) return { f: comp.secondaryFluid, ncg: undefined };
  }
  if (comp.inletFluid || comp.outletFluid) {
    const isOut = portId.includes('outlet') || portId === 'outlet';
    return { f: isOut ? (comp.outletFluid ?? comp.inletFluid) : (comp.inletFluid ?? comp.outletFluid), ncg: comp.initialNcg };
  }
  let f = comp.fluid;
  if (f && f.phase === 'two-phase') {
    // stored T for two-phase presets is Tsat, so it carries over directly
    const height = comp.height ?? 2;
    const level = (comp.fillLevel ?? 0.5) * height;
    f = relElev > level
      ? { temperature: f.temperature, pressure: f.pressure, phase: 'vapor', quality: 1, flowRate: 0 }
      : { temperature: f.temperature, pressure: f.pressure, phase: 'liquid', quality: 0, flowRate: 0 };
  }
  return { f, ncg: comp.initialNcg };
}

/** Pipe initial fluid: same-phase -> averaged T & P; mixed -> donor (from side). */
function pipeFluid(fromRes, toRes) {
  const a = fromRes.f, b = toRes.f;
  if (!a && !b) throw new Error('neither endpoint has a fluid');
  if (!a || !b) {
    const f = a ?? b;
    return { ...f, flowRate: 0 };
  }
  if (a.phase === b.phase) {
    return {
      temperature: (a.temperature + b.temperature) / 2,
      pressure: (a.pressure + b.pressure) / 2,
      phase: a.phase,
      quality: a.phase === 'vapor' ? 1 : a.phase === 'liquid' ? 0 : ((a.quality ?? 0) + (b.quality ?? 0)) / 2,
      flowRate: 0,
    };
  }
  return { ...a, flowRate: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
for (const spec of FILES) {
  const data = JSON.parse(fs.readFileSync(spec.path, 'utf8'));
  const comps = new Map(data.components);
  const lookup = new Map(data.components);
  if (spec.lookupExtra) {
    for (const [id, c] of JSON.parse(fs.readFileSync(spec.lookupExtra, 'utf8')).components) {
      if (!lookup.has(id)) lookup.set(id, c);
    }
  }

  // 1. moves
  for (const [id, pos] of Object.entries(spec.moves ?? {})) {
    const c = comps.get(id);
    if (!c) { console.log(`  [${spec.path}] move target ${id} not found`); continue; }
    c.position.x = pos.x;
    c.position.y = pos.y;
  }

  // 2. controller grid + cabinet size
  if (spec.controllerGrid) {
    const { cols, y0, dy } = spec.controllerGrid;
    const ctls = [...comps.values()].filter((c) => c.type === 'controller');
    const rows = Math.ceil(ctls.length / cols.length);
    ctls.forEach((c, i) => {
      const col = Math.floor(i / rows);
      const row = i % rows;
      c.position.x = cols[col];
      c.position.y = y0 + row * dy;
      c.width = 2.5;
      c.height = 2.5;
    });
  }

  // 3. bake pipes
  const newConnections = [];
  let baked = 0;
  for (const conn of data.connections ?? []) {
    const area = conn.flowArea ?? 0.1;
    const len = conn.length ?? 0;
    const from = lookup.get(conn.fromComponentId);
    const to = lookup.get(conn.toComponentId);
    if (!from || !to) { newConnections.push(conn); console.log(`  [${spec.path}] missing endpoint for ${conn.fromPortId}->${conn.toPortId}`); continue; }
    const internal = from.containedBy === to.id || to.containedBy === from.id;
    // idempotency: a connection touching a pipe already IS the piped form -
    // re-running the script must not split pipe halves into pipes-on-pipes
    const touchesPipe = from.type === 'pipe' || to.type === 'pipe';
    if (!(area > 0.1 && len > 1) || internal || touchesPipe) { newConnections.push(conn); continue; }

    const fromElev = conn.fromElevation ?? 0;
    const toElev = conn.toElevation ?? 0;
    const startElevation = (from.elevation ?? 0) + fromElev;
    const endElevation = (to.elevation ?? 0) + toElev;

    // edge-attach toward the partner
    const dx = to.position.x - from.position.x;
    const dy = to.position.y - from.position.y;
    const planDist = Math.hypot(dx, dy) || 1;
    const ux = dx / planDist, uy = dy / planDist;
    let rFrom = halfExtent(from, lookup);
    let rTo = halfExtent(to, lookup);
    // degenerate/overlapping components: fall back to fractional points
    if (rFrom + rTo > planDist - 0.5) {
      rFrom = planDist * 0.3;
      rTo = planDist * 0.3;
    }
    const startX = from.position.x + ux * rFrom;
    const startY = from.position.y + uy * rFrom;
    const endX = to.position.x - ux * rTo;
    const endY = to.position.y - uy * rTo;

    const dz = endElevation - startElevation;
    const actual = Math.hypot(endX - startX, endY - startY, dz);
    const pipeLength = Math.max(len, actual);
    let diameter = Math.round(Math.sqrt((area * 4) / Math.PI) * 1000) / 1000;

    // Turbine exhaust ducts are sized for capacity, not connection area: at
    // condenser pressure the steam is so thin that a connection-sized duct
    // holds ~20 kg while passing the full steam flow - a ~25 ms residence
    // time that pins the solver's advective (Courant) dt cap at a few ms.
    // Real LP exhaust trunks are huge for the same reason. Target ~0.25 s
    // residence at rated steam flow (~0.05 m^3 per kg/s empirically).
    if (from.type === 'turbine-generator' && from.ratedSteamFlow) {
      const targetVolume = 0.05 * from.ratedSteamFlow;
      const capacityDiameter = Math.sqrt((4 * targetVolume) / (Math.PI * pipeLength));
      diameter = Math.max(diameter, Math.round(capacityDiameter * 100) / 100);
    }

    let pipeId = `pipe-${conn.fromComponentId}-${conn.toComponentId}`;
    while (comps.has(pipeId)) pipeId += 'x';

    const fromRes = fluidAtPort(from, conn.fromPortId, fromElev);
    const toRes = fluidAtPort(to, conn.toPortId, toElev);
    const fluid = pipeFluid(fromRes, toRes);
    const ncg = fromRes.ncg && toRes.ncg ? fromRes.ncg : undefined;

    let rating = Math.max(
      effectiveRating(from, conn.fromPortId, lookup),
      effectiveRating(to, conn.toPortId, lookup)
    ) || 155;
    // Vacuum-service ducts (turbine exhaust, condensate at ~0.05 bar) need
    // external-pressure and startup-transient margin - same reasoning as the
    // condenser's own minimum-practical-thickness-for-vacuum-vessels rule.
    // Inheriting the condenser's ~2 bar rating leaves them one unlucky burst
    // margin away from imploding/bursting during the startup pressure spike.
    if (fluid.pressure < 0.5e5) rating = Math.max(rating, 6);
    // Turbine exhaust ducts see the full steam flow slam in while the duct's
    // outlet flow is still accelerating from zero (measured ~8 bar spike in a
    // 2.6 m^3 duct at 550 kg/s), and a stuck-open governor could expose them
    // to inlet pressure outright. Spec them for the turbine inlet pressure.
    if (from.type === 'turbine-generator' && from.inletFluid?.pressure) {
      rating = Math.max(rating, Math.ceil(from.inletFluid.pressure / 1e5));
    }
    // Hot gas ducts: creep strength collapses with wall temperature (the
    // pipe's burst wall-T proxy is its fluid T). Keep the operating stress
    // ratio low (~0.3) so the Larson-Miller life is long - a 700C helium hot
    // leg rated only to its neighbors' 90 bar ruptures in seconds.
    const totalBar = fluid.pressure / 1e5 + (ncg ? Object.values(ncg).reduce((s, v) => s + v, 0) : 0);
    if (fluid.temperature > 650) rating = Math.max(rating, Math.ceil(totalBar * 3.5 / 5) * 5);
    // Wall thickness consistent with the rating (ASME hoop-stress formula,
    // S=172 MPa full-radiograph steel), so collapse margins line up too.
    const asmeT = (rating * 1e5) * (diameter / 2) / (172e6 - 0.6 * rating * 1e5);
    const thickness = Math.max(0.01, Math.round(asmeT * 1000) / 1000);

    const container = buildingOf(from, lookup);
    const sameContainer = container !== undefined && container === buildingOf(to, lookup);

    const pipe = {
      id: pipeId,
      type: 'pipe',
      label: `Pipe: ${from.label ?? from.id} to ${to.label ?? to.id}`,
      position: { x: round2(startX), y: round2(startY) },
      rotation: Math.atan2(endY - startY, endX - startX),
      diameter,
      thickness,
      length: round2(pipeLength),
      pressureRating: rating,
      ports: [
        { id: `${pipeId}-left`, position: { x: 0, y: 0 }, direction: 'both' },
        { id: `${pipeId}-right`, position: { x: round2(pipeLength), y: 0 }, direction: 'both' },
      ],
      fluid,
      elevation: round2(startElevation),
      endPosition: { x: round2(endX), y: round2(endY) },
      endElevation: round2(endElevation),
    };
    if (ncg) pipe.initialNcg = ncg;
    if (sameContainer) pipe.containedBy = container;
    if (from.nqa1 || to.nqa1) pipe.nqa1 = true;

    comps.set(pipeId, pipe);
    data.components.push([pipeId, pipe]);

    const pipeRelElev = round2(diameter / 2);
    const halfLen = round2(len / 2);
    const halfK = conn.resistanceCoeff !== undefined ? conn.resistanceCoeff / 2 : undefined;
    const connA = {
      fromComponentId: conn.fromComponentId, fromPortId: conn.fromPortId,
      toComponentId: pipeId, toPortId: `${pipeId}-left`,
      fromElevation: fromElev, toElevation: pipeRelElev,
      flowArea: area, length: halfLen,
    };
    if (halfK !== undefined) connA.resistanceCoeff = halfK;
    if (conn.fromPhaseTolerance !== undefined) connA.fromPhaseTolerance = conn.fromPhaseTolerance;
    const connB = {
      fromComponentId: pipeId, fromPortId: `${pipeId}-right`,
      toComponentId: conn.toComponentId, toPortId: conn.toPortId,
      fromElevation: pipeRelElev, toElevation: toElev,
      flowArea: area, length: halfLen,
    };
    if (halfK !== undefined) connB.resistanceCoeff = halfK;
    if (conn.toPhaseTolerance !== undefined) connB.toPhaseTolerance = conn.toPhaseTolerance;

    newConnections.push(connA, connB);
    baked++;
    console.log(`  [${spec.path}] ${pipeId}: (${pipe.position.x},${pipe.position.y})e${pipe.elevation} -> (${pipe.endPosition.x},${pipe.endPosition.y})e${pipe.endElevation}  d=${diameter} L=${pipe.length} ${fluid.phase} ${(fluid.pressure / 1e5).toFixed(1)}bar${ncg ? ' +NCG' : ''}${sameContainer ? ' in ' + container : ''}`);
  }
  data.connections = newConnections;

  // Coincident pipe pairs (e.g. a recirc loop's suction and discharge running
  // the same corridor in opposite directions) draw on top of each other:
  // nudge each one perpendicular so both read as separate pipes.
  const pipes = [...comps.values()].filter((c) => c.type === 'pipe' && c.endPosition);
  for (let i = 0; i < pipes.length; i++) {
    for (let j = i + 1; j < pipes.length; j++) {
      const a = pipes[i], b = pipes[j];
      const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 2;
      const reversed = near(a.position, b.endPosition) && near(a.endPosition, b.position);
      const parallel = near(a.position, b.position) && near(a.endPosition, b.endPosition);
      if (!reversed && !parallel) continue;
      const dx = a.endPosition.x - a.position.x, dy = a.endPosition.y - a.position.y;
      const len = Math.hypot(dx, dy) || 1;
      const px = -dy / len, py = dx / len;
      const off = (a.diameter + b.diameter) / 2 + 0.4;
      for (const [pipe, sign] of [[a, 1], [b, -1]]) {
        pipe.position.x = round2(pipe.position.x + px * off * sign / 2);
        pipe.position.y = round2(pipe.position.y + py * off * sign / 2);
        pipe.endPosition.x = round2(pipe.endPosition.x + px * off * sign / 2);
        pipe.endPosition.y = round2(pipe.endPosition.y + py * off * sign / 2);
      }
      console.log(`  [${spec.path}] offset coincident pipes ${a.id} / ${b.id}`);
    }
  }

  console.log(`${spec.path}: ${baked} pipes baked`);
  if (!DRY) {
    fs.writeFileSync(spec.path, JSON.stringify(data, null, 2) + '\n');
  }
}

function round2(v) { return Math.round(v * 100) / 100; }
