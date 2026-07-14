/**
 * Give every unrated fluid-holding preset component an explicit pressureRating
 * (1.5x its initial total pressure - steam partial + NCG partials - rounded up
 * to 5 bar, floor 6; turbines use their inlet pressure, matching the
 * construction convention). Without a rating the factory derives one and
 * warns; shipped content should be explicit.
 *
 * Usage: node scripts/add-ratings.cjs [--dry]
 */
const fs = require('fs');

const DRY = process.argv.includes('--dry');

const FILES = [
  'src/presets/pwr.json', 'src/presets/two-loop.json', 'src/presets/bwr.json',
  'src/presets/htgr.json', 'src/presets/sbo.json', 'src/presets/prompt-crit.json',
  'src/presets/meltdown-demo.json', 'src/presets/w4loop.json',
  'src/game-mode/levels/level1-site.json', 'src/game-mode/levels/level1-reactor-solution.json',
];

// Types that hold fluid and need a burst rating. Core barrels are exempt
// (the vessel is the boundary); buildings/tanks/HXs/condensers/pipes/RVs
// already carry ratings everywhere.
const NEEDS_RATING = new Set(['pump', 'valve', 'turbine-generator', 'turbine-driven-pump', 'condenser', 'tank', 'pipe']);

/**
 * A component's characteristic SERVICE pressure (bar), not just its initial
 * pressure: pumps discharge at suction + rated head (a feedwater pump filled
 * with condensate at 0.05 bar runs at ~65 bar), turbines see their inlet,
 * heat exchangers differ per side.
 */
function servicePressureBar(c, portId) {
  if (c.type === 'turbine-generator' || c.type === 'turbine-driven-pump') {
    return (c.inletFluid?.pressure ?? c.fluid?.pressure ?? 0) / 1e5;
  }
  let fluid = c.fluid;
  if (c.type === 'heatExchanger') {
    fluid = portId && portId.includes('shell') ? c.secondaryFluid : c.primaryFluid;
  }
  if (!fluid) return 0;
  let bar = fluid.pressure / 1e5;
  if (c.initialNcg) bar += Object.values(c.initialNcg).reduce((s, v) => s + v, 0);
  if (c.type === 'pump' && c.ratedHead) bar += (1000 * 9.81 * c.ratedHead) / 1e5;
  return bar;
}

for (const f of FILES) {
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  const comps = new Map(data.components);
  let patched = 0;
  for (const [id, c] of data.components) {
    if (!NEEDS_RATING.has(c.type)) continue;
    if (c.pressureRating !== undefined && c.pressureRating > 0) continue;
    let ref = servicePressureBar(c);
    // Valves (and anything else static) must hold whatever their NEIGHBORS
    // run at - an accumulator check valve sees full RCS pressure on one side.
    for (const conn of data.connections ?? []) {
      let otherId = null, otherPort = null;
      if (conn.fromComponentId === id) { otherId = conn.toComponentId; otherPort = conn.toPortId; }
      if (conn.toComponentId === id) { otherId = conn.fromComponentId; otherPort = conn.fromPortId; }
      if (!otherId) continue;
      const other = comps.get(otherId);
      if (other) ref = Math.max(ref, servicePressureBar(other, otherPort));
    }
    if (ref <= 0) { console.log(`  [${f}] ${id} (${c.type}): no reference pressure, skipped`); continue; }
    const rating = Math.max(6, Math.ceil((1.5 * ref) / 5) * 5);
    c.pressureRating = rating;
    patched++;
    console.log(`  [${f}] ${id} (${c.type}): rated ${rating} bar (1.5x ${ref.toFixed(1)} bar service)`);
  }
  console.log(`${f}: ${patched} components rated`);
  if (!DRY && patched > 0) fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n');
}
