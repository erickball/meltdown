/**
 * Condensate line probe: hotwell level, the suction pipe's state, the pump's
 * suction pressure and the driving-pressure terms of the two connections
 * between them, printed every few seconds.
 *
 * Usage: npx tsx scripts/probe-condensate-line.ts <preset.json> [seconds] [every]
 */
import { buildSimFromFile } from './lib/sim-harness';
import { pressureAtConnection, pumpHeadFactor, nodeBulkDensity } from '../src/simulation/operators/connection-hydraulics';

const preset = process.argv[2];
const seconds = parseFloat(process.argv[3] || '60');
const every = parseFloat(process.argv[4] || '2');
const sim = buildSimFromFile(preset);

const COND = 'condenser-1';
const PIPE = 'pipe-condenser-1-cond-pump-1';
const PUMP = 'cond-pump-1';

function node(id: string) { return sim.state.flowNodes.get(id)!; }
function conn(from: string, to: string) { return sim.state.flowConnections.find(c => c.fromNodeId === from && c.toNodeId === to)!; }

function report() {
  const s = sim.state;
  const c = node(COND), p = node(PIPE), m = node(PUMP);
  const c1 = conn(COND, PIPE), c2 = conn(PIPE, PUMP);
  const pump = s.components.pumps.get(PUMP)!;
  const f = pumpHeadFactor(pump, m, nodeBulkDensity(m));
  const level = (n: typeof c) => {
    const q = Math.max(0, Math.min(1, n.fluid.quality ?? (n.fluid.phase === 'liquid' ? 0 : 1)));
    return n.fluid.mass * (1 - q) / 990;
  };
  const line = (id: string, n: typeof c) =>
    `${id.padEnd(8)} ${n.fluid.phase.padEnd(9)} m=${n.fluid.mass.toFixed(1).padStart(8)}kg ` +
    `P=${(n.fluid.pressure / 1e5).toFixed(3)}bar T=${(n.fluid.temperature - 273.15).toFixed(1)}C ` +
    `liqV=${level(n).toFixed(2)}m3/V=${n.volume.toFixed(2)}`;
  console.log(`t=${s.time.toFixed(1)}`);
  console.log('  ' + line('hotwell', c));
  console.log('  ' + line('pipe', p));
  console.log('  ' + line('pump', m) + ` factor=${f.toFixed(3)} speed=${pump.effectiveSpeed.toFixed(3)}`);
  for (const [k, cc, a, b] of [['cond->pipe', c1, c, p], ['pipe->pump', c2, p, m]] as const) {
    const Pa = pressureAtConnection(a, cc.fromElevation), Pb = pressureAtConnection(b, cc.toElevation);
    console.log(`  ${k.padEnd(11)} flow=${cc.massFlowRate.toFixed(1).padStart(7)}kg/s ` +
      `P_from=${(Pa / 1e5).toFixed(3)} P_to=${(Pb / 1e5).toFixed(3)} dz=${cc.elevation.toFixed(2)}m ` +
      `(dP - rho g dz)=${((Pa - Pb - 990 * 9.81 * cc.elevation) / 1e5).toFixed(3)}bar`);
  }
}

report();
let next = every;
while (sim.state.time < seconds - 1e-9) {
  const r = sim.solver.advance(sim.state, 0.1);
  sim.state = r.state;
  sim.state.pendingEvents = [];
  if (sim.state.time >= next - 1e-9) { report(); next += every; }
}
