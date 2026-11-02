/**
 * Creep life vs wall temperature for a component's pressure boundaries, from
 * the burst states the factory actually builds (so the rating/geometry/
 * material/strength-scatter convention is the live one).
 *
 * Usage: npx tsx scripts/probe-creep-life.ts [preset] [componentId]
 * Env:
 *   PRESSURES=60,70,1    gauge pressures to tabulate, bar (default: the node's initial gauge, plus 1 bar)
 *   TEMPS=300,400,...    wall temperatures, C
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { creepRuptureTime } from '../src/simulation/operators/burst-operator';
import { MATERIALS } from '../src/simulation/materials';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = (s: string) => process.stdout.write(s + '\n');
if (process.env.QUIET !== '0') { console.log = () => {}; console.warn = () => {}; }

const preset = process.argv[2] || path.join(HERE, '..', 'src', 'presets', 'xe100-plant.json');
const compId = process.argv[3] || 'rv-1';
const temps = (process.env.TEMPS || '300,350,400,450,500,550,600,650,700,750,800,850,900,1000')
  .split(',').map(Number);

function fmtLife(s: number): string {
  if (!isFinite(s)) return 'inf';
  const h = s / 3600;
  if (h >= 8760 * 1e4) return '>1e4 yr';
  if (h >= 8760) return `${(h / 8760).toPrecision(2)} yr`;
  if (h >= 24) return `${(h / 24).toPrecision(2)} d`;
  if (h >= 1) return `${h.toPrecision(2)} h`;
  if (s >= 60) return `${(s / 60).toPrecision(2)} min`;
  return `${s.toPrecision(2)} s`;
}

const sim = buildSimFromFile(preset);
const states = [...(sim.state.burstStates ?? new Map()).values()].filter(b => b.componentId === compId);
if (states.length === 0) throw new Error(`no burst state for '${compId}' in ${path.basename(preset)}`);

for (const b of states) {
  const node = sim.state.flowNodes.get(b.nodeId)!;
  const outside = b.shellNodeId ?? node.containerId;
  const P0 = node.fluid.pressure - (outside ? sim.state.flowNodes.get(outside)!.fluid.pressure : 101325);
  const pressures = process.env.PRESSURES
    ? process.env.PRESSURES.split(',').map(Number)
    : [Math.round(P0 / 1e4) / 10, 1];
  const m = MATERIALS[b.material];
  out(`${path.basename(preset)} ${b.componentLabel} [${b.nodeId}]  ${m.label}  rated ${(b.designPressure / 1e5).toFixed(0)} bar` +
    `  burst ${(b.burstPressure / 1e5).toFixed(0)} bar (strength x${b.strengthFactor.toFixed(3)})`);
  out('  wall T   ' + pressures.map(p => `${p} bar (s=${(p * 1e5 / b.burstPressure).toFixed(3)})`.padStart(22)).join(''));
  for (const T of temps) {
    out(`  ${String(T).padStart(5)} C ` + pressures.map(p =>
      fmtLife(creepRuptureTime(p * 1e5 / b.burstPressure, T + 273.15, b.material)).padStart(22)).join(''));
  }
}
