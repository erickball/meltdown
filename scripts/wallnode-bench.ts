/**
 * Wall thermal-node experiment benchmark (see createWallThermalNodes).
 *
 * For the current WALL_NODES policy, runs the first ~2 minutes of each
 * w4loop transient and prints wall-clock speed plus a few physics readouts
 * (containment pressure, creep-relevant temperatures) so the policies can
 * be compared on both cost and effect:
 *   - startup: t=0..120 s of the normal ascension
 *   - loca:    60 s pre-run, then 120 s after the cold-leg break + SI
 *   - sbo:     60 s pre-run, then 120 s after station blackout
 *
 * Usage: WALL_NODES=none|rpv-bui|thick|all npx tsx scripts/wallnode-bench.ts
 */

import { buildSimFromFile, Sim } from './lib/sim-harness';
import { triggerScram } from '../src/simulation';
import * as path from 'path';
import { fileURLToPath } from 'url';

const PRESET = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'presets', 'w4loop.json');
const policy = process.env.WALL_NODES ?? 'none';

function advance(sim: Sim, seconds: number, dt = 0.02): void {
  const ticks = Math.round(seconds / dt);
  for (let i = 0; i < ticks; i++) {
    sim.state = sim.solver.advance(sim.state, dt).state;
    sim.state.pendingEvents = [];
  }
}

function timed(label: string, sim: Sim, seconds: number): void {
  const t0 = performance.now();
  advance(sim, seconds);
  const wall = (performance.now() - t0) / 1000;
  const bui = sim.state.flowNodes.get('bui-1')!;
  const buiWall = sim.state.thermalNodes.get('bui-1-wall');
  const rvWall = sim.state.thermalNodes.get('rv-1-wall');
  console.log(`BENCH policy=${policy} ${label}: ${seconds}s plant in ${wall.toFixed(1)}s wall ` +
    `(${(seconds / wall).toFixed(2)}x realtime) ` +
    `contP=${(bui.fluid.pressure / 1e5).toFixed(3)}bar` +
    (buiWall ? ` contWallT=${(buiWall.temperature - 273.15).toFixed(1)}C` : '') +
    (rvWall ? ` rvWallT=${(rvWall.temperature - 273.15).toFixed(1)}C` : ''));
}

// --- startup ---------------------------------------------------------------
{
  const sim = buildSimFromFile(PRESET);
  console.log(`BENCH policy=${policy} thermalNodes=${sim.state.thermalNodes.size}`);
  timed('startup', sim, 120);
}

// --- LOCA -------------------------------------------------------------------
{
  const sim = buildSimFromFile(PRESET);
  advance(sim, 60);
  sim.state.components.valves.get('val-break-1')!.position = 1.0;
  sim.state = triggerScram(sim.state, 'LOCA bench');
  for (const id of ['hpi-pump-1', 'lpi-pump-1']) {
    const p = sim.state.components.pumps.get(id)!;
    p.running = true; p.speed = 1.0;
  }
  timed('loca', sim, 120);
}

// --- SBO --------------------------------------------------------------------
{
  const sim = buildSimFromFile(PRESET);
  advance(sim, 60);
  sim.state = triggerScram(sim.state, 'SBO bench');
  for (const id of ['pump-1', 'pump-2', 'pump-3', 'pump-4',
                    'cond-pump-1', 'fw-pump-1', 'fw-pump-2', 'fw-pump-3', 'fw-pump-4']) {
    sim.state.components.pumps.get(id)!.running = false;
  }
  const gov = sim.state.components.controllers.get('ctl-sgp-1')!;
  gov.mode = 'manual'; gov.manualOutput = 0; gov.actuator.min = 0; gov.actuator.rateLimit = 1;
  timed('sbo', sim, 120);
}
