/**
 * Scripted-break probe: open a break in any plant, now or on a schedule, the
 * way the component panel's Scripted Break section does, and watch the
 * boundary and where it discharges.
 *
 *   npx tsx scripts/probe-scripted-break.ts <preset.json> <nodeId> <area m2> <elevation m> <at s> <run s>
 *   e.g. npx tsx scripts/probe-scripted-break.ts src/presets/xe100-plant.json hx-1-tube 4e-4 7 30 120
 *
 * The break is SCHEDULED (scheduleScenarioEvent) so the solver fires it
 * itself when it reaches `at`, which is the path a saved plant takes.
 */
import { buildSimFromFile, run } from './lib/sim-harness';
import { scheduleScenarioEvent } from '../src/simulation/scenario';

const [file, nodeId, areaArg, elevArg, atArg, runArg] = process.argv.slice(2);
if (!file || !nodeId) {
  console.error('usage: probe-scripted-break.ts <preset.json> <nodeId> <area m2> <elevation m> <at s> <run s>');
  process.exit(1);
}
const area = parseFloat(areaArg ?? '4e-4');
const elevation = parseFloat(elevArg ?? '0');
const at = parseFloat(atArg ?? '10');
const seconds = parseFloat(runArg ?? '60');

const sim = buildSimFromFile(file);
const bs = sim.state.burstStates?.get(nodeId);
if (!bs) throw new Error(`no burst state for ${nodeId}; have ${Array.from(sim.state.burstStates?.keys() ?? []).join(', ')}`);
const target = bs.shellNodeId ?? sim.state.flowNodes.get(nodeId)?.containerId ?? 'atmosphere';

scheduleScenarioEvent(sim.state, {
  time: at,
  message: `probe break in ${bs.componentLabel}`,
  actions: [{ kind: 'burst', id: nodeId, area, elevation }],
});

// Read the state each tick hands over: the solver replaces the state object
// as it steps, so sim.state is only the one it started from
type State = typeof sim.state;
const bar = (state: State, id: string) => ((state.flowNodes.get(id)?.fluid.pressure ?? NaN) / 1e5).toFixed(3);
const kg = (state: State, id: string) => (state.flowNodes.get(id)?.fluid.mass ?? NaN).toFixed(1);
console.log(`break ${nodeId} (${bs.componentLabel}) -> ${target}, ${(area * 1e4).toFixed(1)} cm2 at +${elevation} m, t=${at} s`);
console.log('    t(s)   P_node(bar)  m_node(kg)   P_target(bar)  m_target(kg)  break(kg/s)');
let next = 0;
run(sim, seconds, 0.05, state => {
  if (state.time + 1e-9 < next) return;
  next += 5;
  const brk = state.flowConnections.find(c => c.id === `break-${nodeId}`);
  console.log(
    `${state.time.toFixed(1).padStart(8)}   ${bar(state, nodeId).padStart(10)}  ${kg(state, nodeId).padStart(10)}   ` +
    `${bar(state, target).padStart(12)}  ${kg(state, target).padStart(12)}  ${brk ? brk.massFlowRate.toFixed(3).padStart(10) : '         -'}`);
});
const m = sim.solver.getMetrics();
console.log(`steps=${m.totalSteps} rejected=${(m as any).rejectedSteps ?? '?'}`);
