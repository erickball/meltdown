/**
 * Xe-100 steam-generator gas-side probe: the numbers behind the SG duty.
 *
 * Prints, per report interval, the shell gas film coefficient and its
 * ingredients (throughput, velocity, density, flow area), the gas inlet and
 * outlet temperatures, and each bundle's section areas, section and metal
 * temperatures and flows, plus reactor power.
 *
 * Usage: npx tsx scripts/probe-xe100-sg.ts [seconds] [preset]
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import {
  evaluateOtsgSections, otsgGasFilmCoefficient, otsgGasMcp, otsgGasInletTemp,
} from '../src/simulation/operators/otsg-operator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const seconds = parseFloat(process.argv[2] ?? '200');
const preset = process.argv[3] ?? path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const sim = buildSimFromFile(preset);

// Ids only: the solver hands back a new state each step, so node objects
// captured here would go stale.
const tubeIds = [...sim.state.flowNodes.values()].filter(n => n.otsg).map(n => n.id);
const shellId = sim.state.flowNodes.get(tubeIds[0])!.otsg!.shellNodeId;
const C = (T: number) => (T - 273.15).toFixed(0);

function report() {
  const s = sim.state;
  const shell = s.flowNodes.get(shellId)!;
  const tubes = tubeIds.map(id => s.flowNodes.get(id)!);
  const h = otsgGasFilmCoefficient(shell, s, tubes[0].otsg!.gasSide);
  const mcp = otsgGasMcp(shell, s);
  let thr = 0;
  for (const fc of s.flowConnections) {
    if (fc.fromNodeId === shellId || fc.toNodeId === shellId) thr += Math.abs(fc.massFlowRate);
  }
  thr /= 2;
  console.log(`t=${s.time.toFixed(0)} P=${(s.neutronics.power / 1e6).toFixed(1)}MW ` +
    `shell: A=${shell.flowArea.toFixed(3)}m2 V=${shell.volume.toFixed(1)}m3 W=${thr.toFixed(1)}kg/s h=${h.toFixed(0)} ` +
    `mcp=${(mcp / 1e3).toFixed(0)}kW/K Tin=${C(otsgGasInletTemp(s, shell))} Tout=${C(shell.fluid.temperature)} ` +
    `Pshell=${(shell.fluid.pressure / 1e5).toFixed(1)}`);
  const ctl = (id: string) => (s as any).components.controllers?.get?.(id);
  const valve = (id: string) => s.components.valves?.get(id)?.position;
  const fwh = s.flowNodes.get('fwh-1-tube');
  const fwhShell = s.flowNodes.get('fwh-1-shell');
  console.log(`   feed: T_fwh_out=${fwh ? C(fwh.fluid.temperature) : '-'} fwhShell P=${fwhShell ? (fwhShell.fluid.pressure / 1e5).toFixed(1) : '-'}bar ` +
    `T=${fwhShell ? C(fwhShell.fluid.temperature) : '-'} bleed=${valve('val-bleed-1')?.toFixed(3)} drain=${valve('val-fwhdr-1')?.toFixed(3)} ` +
    `fwPump=${s.components.pumps.get('fw-pump-1')?.speed.toFixed(3)} gv=${(s.flowNodes.get('turbine-1') as any)?.governorValve?.toFixed(3)} ` +
    `Tcore_in=${C(s.flowNodes.get('rv-1')!.fluid.temperature)} Tcore_out=${C(s.flowNodes.get('cb-1')!.fluid.temperature)}`);
  for (const t of tubes) {
    const { ev, flows } = evaluateOtsgSections(s, t.id, t, { exact: true });
    const metals = t.otsg!.metalNodeIds.map(id => C(s.thermalNodes.get(id)!.temperature)).join('/');
    console.log(`   ${t.id}: Pw=${(ev.P / 1e5).toFixed(1)} A=${ev.sections.map(x => x.area.toFixed(0)).join('/')} ` +
      `Tsec=${ev.sections.map(x => C(x.T)).join('/')} metal=${metals} WFeed=${flows.WFeed.toFixed(1)} ` +
      `hFeed=${(flows.hFeed / 1e3).toFixed(0)} WSteam=${flows.WSteamOut.toFixed(1)} ` +
      `heatArea=${t.otsg!.heatArea.toFixed(0)} gasShare=${t.otsg!.gasShare}`);
  }
}
report();
const every = parseFloat(process.env.EVERY ?? '10');
for (let t = 0; t < seconds; t += every) {
  run(sim, every, 0.05);
  report();
}
