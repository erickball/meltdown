import { buildSimFromFile } from './lib/sim-harness';
import { solveMixtureState } from '../src/simulation/mixture-properties';
import { totalMoles } from '../src/simulation/gas-properties';
const sim = buildSimFromFile('src/presets/pwr.json');
for (const id of ['atmosphere','bui-1']) {
  const n = sim.state.flowNodes.get(id)!;
  const m = solveMixtureState(n.fluid.mass, n.fluid.internalEnergy, n.volume, n.fluid.ncg, n.fluid.temperature);
  console.log(`${id}: stored T=${n.fluid.temperature.toFixed(4)} K -> read-back T=${m.temperature.toFixed(4)} K, P_steam=${m.steamPressure.toFixed(2)} Pa, phase=${m.phase}, ice=${m.iceFraction}`);
}
