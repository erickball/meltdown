/**
 * Creep watch on one pressure boundary: fluid state of the watched nodes,
 * the boundary's burst pressure, creep wall temperature and accumulated
 * creep damage, every PERIOD seconds of plant time.
 *
 * Usage: npx tsx scripts/probe-bleed-creep.ts [seconds] [preset]
 * Env:
 *   COMP=val-bleed-1     component whose burst state is watched
 *   NODES=a,b,c          flow nodes to print (default: the Xe-100 bleed line)
 *   PERIOD=30            print interval, s
 *   QUIET=0              keep the simulator's own console output
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import { evaluateOtsgSections } from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = (s: string) => process.stdout.write(s + '\n');
if (process.env.QUIET !== '0') { console.log = () => {}; console.warn = () => {}; }

const seconds = parseFloat(process.argv[2] || '1200');
const preset = process.argv[3] || path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const COMP = process.env.COMP || 'val-bleed-1';
const PERIOD = parseFloat(process.env.PERIOD || '30');
const ids = (process.env.NODES || 'hx-1-tube,hx-1-tube-b2,val-bleed-1,fwh-1-shell,val-msv-1').split(',');

const sim = buildSimFromFile(preset);
const tick = 0.1;
const every = Math.round(PERIOD / tick);
let state = sim.state;
for (let i = 1; i <= Math.round(seconds / tick); i++) {
  state = sim.solver.advance(state, tick).state;
  state.pendingEvents = [];
  sim.state = state;
  if (i % every !== 0) continue;
  const parts: string[] = [`t=${(i * tick).toFixed(0)} ${(state.neutronics.power / 1e6).toFixed(1)}MW`];
  for (const id of ids) {
    const n = state.flowNodes.get(id);
    if (!n) { parts.push(`${id}:-`); continue; }
    parts.push(`${id} ${(n.fluid.temperature - 273.15).toFixed(0)}C ${(n.fluid.pressure / 1e5).toFixed(1)}b ` +
      `${n.fluid.phase[0]} m=${n.fluid.mass.toPrecision(3)}`);
  }
  for (const id of ids) {
    const n = state.flowNodes.get(id);
    if (!n?.otsg) continue;
    const L = evaluateOtsgSections(state, id, n).ev.sections.map(s => (100 * s.lengthFrac).toFixed(0));
    parts.push(`${id} L=${L.join('/')}`);
  }
  const flows = (process.env.FLOWS || 'flow-fw-pump-1-val-fpcv-1,flow-hx-1-turbine-1,flow-hx-1-val-bleed-1').split(',');
  parts.push(flows.map(f => `${f.replace(/^flow-/, '')}=${(state.flowConnections.find(c => c.id === f)?.massFlowRate ?? NaN).toFixed(1)}`).join(' '));
  const b = (state as any).burstStates?.get?.(COMP)
    ?? [...((state as any).burstStates?.values?.() ?? [])].find((s: any) => s.componentId === COMP);
  if (b) {
    parts.push(`Pb=${(b.burstPressure / 1e5).toFixed(0)}b wallT=${((b.wallTemperature ?? NaN) - 273.15).toFixed(0)}C ` +
      `dmg=${(b.creepDamage ?? 0).toExponential(2)}${b.isBurst ? ' BURST' : ''}`);
  }
  out(parts.join(' | '));
}
