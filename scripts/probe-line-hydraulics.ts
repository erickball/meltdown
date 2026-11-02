/**
 * Per-connection hydraulics breakdown along a flow path: what is limiting it.
 * Prints flow, the node pressures either side, the driving and friction dP,
 * K_eff, throat area, velocity, density and the choke bound.
 *
 * Usage: npx tsx scripts/probe-line-hydraulics.ts [seconds] [preset]
 * Env:   CONNS=id,id,...   connections to break down (default: Xe-100 bleed line)
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile, run } from './lib/sim-harness';
import {
  computeConnectionHydraulics, computeChokeLimit, connectionRestriction,
} from '../src/simulation/operators/connection-hydraulics';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = (s: string) => process.stdout.write(s + '\n');
if (process.env.QUIET !== '0') { console.log = () => {}; console.warn = () => {}; }

const seconds = parseFloat(process.argv[2] || '300');
const preset = process.argv[3] || path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const conns = (process.env.CONNS ||
  'flow-hx-1-val-bleed-1,flow-hx-1-val-bleed-1-hx-1-tube-2-b2-val-bleed-1-in,flow-val-bleed-1-fwh-1').split(',');

const sim = buildSimFromFile(preset);
run(sim, seconds, 0.1);
const s = sim.state;
for (const id of conns) {
  const c = s.flowConnections.find(x => x.id === id);
  if (!c) { out(`${id}: not found`); continue; }
  const from = s.flowNodes.get(c.fromNodeId)!, to = s.flowNodes.get(c.toNodeId)!;
  const h = computeConnectionHydraulics(s, c, from, to);
  const r = connectionRestriction(s, c, to);
  const up = c.massFlowRate >= 0 ? from : to, dn = c.massFlowRate >= 0 ? to : from;
  const ch = computeChokeLimit(c, up, dn, h.flowPhase, h.rho_flow, r.throatArea);
  for (const [vid, v] of s.components.valves) {
    if (v.connectedFlowPath === id) out(`   valve ${vid}: position=${v.position.toFixed(3)}`);
  }
  out(`${id}  ${c.fromNodeId} -> ${c.toNodeId}`);
  out(`   W=${c.massFlowRate.toFixed(2)} kg/s  P ${(from.fluid.pressure / 1e5).toFixed(2)} -> ${(to.fluid.pressure / 1e5).toFixed(2)} bar` +
    `  A=${h.A} L=${h.L} K=${c.resistanceCoeff ?? '-'} K_eff=${h.K_eff.toPrecision(4)} open=${r.openFraction.toFixed(3)} throat=${r.throatArea.toExponential(2)}`);
  out(`   phase=${h.flowPhase} rho=${h.rho_flow.toPrecision(4)} v=${h.v.toFixed(1)} m/s  dP_drive=${(h.dP_driving / 1e5).toFixed(2)} bar` +
    `  dP_fric=${(h.dP_friction / 1e5).toFixed(2)} bar  dP_grav=${(h.dP_gravity / 1e5).toFixed(3)} bar`);
  if (ch) {
    out(`   choke: c=${ch.soundSpeed.toFixed(0)} m/s  W*=${ch.m_dot_choked.toFixed(2)} kg/s  crit=${ch.critRatio.toFixed(3)} ratio=${ch.actualRatio.toFixed(3)}` +
      `${ch.chokedByRatio ? ' CHOKED-by-ratio' : ''}`);
  }
}
