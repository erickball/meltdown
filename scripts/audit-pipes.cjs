// Audit: connections exceeding the auto-pipe rule (flowArea>0.1 && length>1),
// plus quick layout checks (containment membership by footprint).
const fs = require('fs');

const files = [
  'src/presets/pwr.json', 'src/presets/two-loop.json', 'src/presets/bwr.json',
  'src/presets/htgr.json', 'src/presets/sbo.json', 'src/presets/prompt-crit.json',
  'src/presets/meltdown-demo.json', 'src/presets/w4loop.json',
  'src/game-mode/levels/level1-site.json', 'src/game-mode/levels/level1-reactor-solution.json',
];

for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const comps = new Map(d.components || []);
  const conns = d.connections || [];
  const isInternal = (c) => {
    const a = comps.get(c.fromComponentId), b = comps.get(c.toComponentId);
    return !!(a && b && (a.containedBy === b.id || b.containedBy === a.id));
  };
  const touchesPipe = (c) =>
    comps.get(c.fromComponentId)?.type === 'pipe' || comps.get(c.toComponentId)?.type === 'pipe';
  const offenders = conns.filter((c) =>
    (c.flowArea ?? 0.1) > 0.1 && (c.length ?? 0) > 1 && !touchesPipe(c) && !isInternal(c));
  console.log('===', f, `${offenders.length} over-threshold / ${conns.length} connections`);
  for (const c of offenders) {
    const a = comps.get(c.fromComponentId), b = comps.get(c.toComponentId);
    console.log(`    ${c.fromPortId} -> ${c.toPortId}  area=${c.flowArea} len=${c.length}` +
      `  from(${a?.position?.x},${a?.position?.y})e${a?.elevation ?? 0}+${c.fromElevation ?? 0}` +
      ` to(${b?.position?.x},${b?.position?.y})e${b?.elevation ?? 0}+${c.toElevation ?? 0}`);
  }
  // containment check: components with containedBy must sit inside the building footprint
  for (const [id, comp] of comps) {
    const cb = comp.containedBy;
    if (!cb) continue;
    const bld = comps.get(cb);
    if (!bld || bld.type !== 'building') continue;
    const r = (bld.diameter ?? Math.max(bld.width ?? 0, 0)) / 2;
    const dx = comp.position.x - bld.position.x, dy = comp.position.y - bld.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (r > 0 && dist > r - 0.5) {
      console.log(`    [LAYOUT] ${id} at (${comp.position.x},${comp.position.y}) is ${dist.toFixed(1)}m from ${cb} center, footprint radius ${r}`);
    }
  }
}
