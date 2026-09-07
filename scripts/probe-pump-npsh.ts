/**
 * Pump suction probe: for every pump in a preset, print the suction state the
 * head-degradation model sees (phase, P, T, Psat, NPSH_a, head factor) beside
 * the upstream port pressure feeding it, over the first seconds of a run.
 *
 * Usage: npx tsx scripts/probe-pump-npsh.ts <preset.json> [seconds] [every]
 */
import { buildSimFromFile } from './lib/sim-harness';
import { pumpHeadFactor, pressureAtConnection, nodeBulkDensity } from '../src/simulation/operators/connection-hydraulics';
import { saturationPressure } from '../src/simulation/water-properties';

const preset = process.argv[2];
const seconds = parseFloat(process.argv[3] || '20');
const every = parseFloat(process.argv[4] || '5');
const sim = buildSimFromFile(preset);

function report() {
  const s = sim.state;
  for (const [id, pump] of s.components.pumps) {
    const node = s.flowNodes.get(id);
    if (!node) continue;
    const inlet = s.flowConnections.find(c => c.toNodeId === id);
    const up = inlet ? s.flowNodes.get(inlet.fromNodeId) : undefined;
    const upP = inlet && up ? pressureAtConnection(up, inlet.fromElevation) : NaN;
    const rho = nodeBulkDensity(node);
    let psat = NaN;
    try { psat = saturationPressure(node.fluid.temperature); } catch { /* above critical */ }
    const npsh = (node.fluid.pressure - psat) / (rho * 9.81);
    const f = pumpHeadFactor(pump, node, rho);
    console.log(
      `t=${s.time.toFixed(1).padStart(6)} ${id.padEnd(12)} ${node.fluid.phase.padEnd(9)} ` +
      `P=${(node.fluid.pressure / 1e5).toFixed(3)}bar T=${node.fluid.temperature.toFixed(1)}K ` +
      `Psat=${(psat / 1e5).toFixed(3)}bar rho=${rho.toFixed(1)} NPSHa=${npsh.toFixed(2)}m ` +
      `factor=${f.toFixed(3)} type=${pump.pumpType} npshR=${pump.npshRequired} ` +
      `| upstream ${inlet?.fromNodeId ?? '-'} port P=${(upP / 1e5).toFixed(3)}bar dz=${inlet?.elevation?.toFixed(2)} ` +
      `flow=${inlet?.massFlowRate?.toFixed(1)}kg/s`
    );
  }
}

report();
let next = every;
const tick = 0.1;
while (sim.state.time < seconds - 1e-9) {
  const r = sim.solver.advance(sim.state, tick);
  sim.state = r.state;
  sim.state.pendingEvents = [];
  if (sim.state.time >= next - 1e-9) { report(); next += every; }
}
