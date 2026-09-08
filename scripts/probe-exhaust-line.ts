/**
 * Turbine exhaust line probe: the riser's inventory, what its two ports see
 * and what they draw. Usage: npx tsx scripts/probe-exhaust-line.ts <preset> [s] [every]
 */
import { buildSimFromFile } from './lib/sim-harness';
import { pressureAtConnection, drawCompositionAt, calculateSeparation, calculateLiquidLevelWithObstructions, approxLiquidDensity } from '../src/simulation/operators/connection-hydraulics';

const preset = process.argv[2];
const seconds = parseFloat(process.argv[3] || '60');
const every = parseFloat(process.argv[4] || '2');
const sim = buildSimFromFile(preset);
const PIPE = 'pipe-turbine-1-condenser-1';

function report() {
  const s = sim.state;
  const p = s.flowNodes.get(PIPE)!;
  const conns = s.flowConnections.filter(c => c.fromNodeId === PIPE || c.toNodeId === PIPE);
  const q = Math.max(0, Math.min(1, p.fluid.quality ?? 0));
  const liqV = p.fluid.mass * (1 - q) / approxLiquidDensity(p);
  const level = calculateLiquidLevelWithObstructions(p, liqV);
  const sep = calculateSeparation(p, conns.reduce((m, c) => Math.max(m, Math.abs(c.massFlowRate)), 0));
  console.log(`t=${s.time.toFixed(1)} ${p.fluid.phase} m=${p.fluid.mass.toFixed(1)}kg x=${q.toFixed(3)} P=${(p.fluid.pressure/1e5).toFixed(3)}bar T=${(p.fluid.temperature-273.15).toFixed(1)}C h=${(p.height??0).toFixed(1)}m liqV=${liqV.toFixed(3)} level=${level.toFixed(3)} sep=${sep.toFixed(3)}`);
  for (const c of conns) {
    const isFrom = c.fromNodeId === PIPE;
    const elev = isFrom ? c.fromElevation : c.toElevation;
    const P = pressureAtConnection(p, elev);
    const draw = drawCompositionAt(p, elev, c.massFlowRate, isFrom ? c.fromPhaseTolerance : c.toPhaseTolerance, isFrom ? c.fromOpeningHeight : c.toOpeningHeight);
    console.log(`   ${c.id.padEnd(40)} flow=${c.massFlowRate.toFixed(1).padStart(8)} ${isFrom?'out@':'in@ '}${(elev??-1).toFixed(2)}m P=${(P/1e5).toFixed(3)} dz=${c.elevation.toFixed(2)} draw=${draw.phase} rho=${draw.rho.toFixed(2)}`);
  }
}
report();
let next = every;
while (sim.state.time < seconds - 1e-9) {
  const r = sim.solver.advance(sim.state, 0.1);
  sim.state = r.state; sim.state.pendingEvents = [];
  if (sim.state.time >= next - 1e-9) { report(); next += every; }
}
