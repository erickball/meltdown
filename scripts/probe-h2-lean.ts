/**
 * Isolate the lean-H2 flammability case: print the vessel state and the
 * flammability verdict over time, so a change in burn behaviour can be traced
 * to the composition/temperature it came from.
 */

import { buildSim, run } from './lib/sim-harness';
import { evaluateFlammability, hydrogenPercentage, totalMoles, moleFraction } from '../src/simulation/gas-properties';

function h2VesselPlant(h2Bar: number, airBar: number, tempK: number, steamFill: number) {
  return [
    ['ves', {
      id: 'ves', type: 'tank', label: 'Test Vessel',
      position: { x: 40, y: 90 }, rotation: 0, elevation: 0,
      width: 4, height: 5.2, wallThickness: 0.08, fillLevel: steamFill, pressureRating: 40,
      ports: [],
      fluid: {
        temperature: tempK,
        pressure: steamFill > 0 ? 800000 : 25000,
        phase: steamFill > 0 ? 'two-phase' : 'vapor',
        quality: 1, flowRate: 0,
      },
      initialNcg: { N2: airBar * 0.79, O2: airBar * 0.21, H2: h2Bar },
    }],
  ] as any;
}

const sim = buildSim(h2VesselPlant(0.02, 1.0, 620, 0), []);

function report(t: number) {
  const n = sim.state.flowNodes.get('ves')!;
  const g = n.fluid.ncg!;
  const steamMol = n.fluid.mass / 0.018;
  const gasMol = totalMoles(g);
  // Mole fraction of H2 including the steam in the gas space
  const xH2_wet = g.H2 / (gasMol + steamMol);
  const fl = evaluateFlammability(g, n.fluid.temperature, steamMol);
  console.log(
    `t=${t.toFixed(0).padStart(4)}s  T=${n.fluid.temperature.toFixed(1)}K  ` +
    `P=${(n.fluid.pressure / 1e5).toFixed(4)}bar  phase=${n.fluid.phase.padEnd(9)} ` +
    `m_H2O=${n.fluid.mass.toFixed(3)}kg (${steamMol.toFixed(1)}mol)  ` +
    `H2=${g.H2.toFixed(2)}mol  O2=${g.O2.toFixed(2)}  ` +
    `xH2_dry=${(hydrogenPercentage(g)).toFixed(2)}%  xH2_wet=${(xH2_wet * 100).toFixed(2)}%  ` +
    `flammable=${JSON.stringify(fl)}`
  );
  void moleFraction;
}

report(0);
for (let t = 0; t < 120; t += 20) {
  run(sim, 20, 0.05);
  report(sim.state.time);
}
