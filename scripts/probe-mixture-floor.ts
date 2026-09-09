/**
 * Jack's CAR: hx-1-shell pinned at 273.16 K. What does the mixture energy
 * split return when a helium + water node's total energy is at or below what
 * water at the triple point can hold? Does it throw, or hand back 273.16 K?
 */
import { solveMixtureState } from '../src/simulation/mixture-properties';
import { buildSimFromFile } from './lib/sim-harness';

const sim = buildSimFromFile('src/presets/xe100-sgtr.json');
const shell = sim.state.flowNodes.get('hx-1-shell')!;
const V = shell.volume;
console.log(`hx-1-shell volume=${V.toFixed(2)} m3`);

// Jack's state: 22 kg of two-phase water at 1.76 bar with helium, T reported 273.16 K.
const R = 8.31446, Cv_He = 1.5 * R;
const mW = 22;
const T = 273.16 + 117;  // what T_sat(1.76 bar) would be if the water set it
// helium moles for the reported total pressure at that T, minus the steam partial
const Psteam = 1.8e5 * 0.95, Pgas = 1.76e5 - Psteam > 0 ? 1.76e5 - Psteam : 0.2e5;
const nHe = Pgas * V / (R * T);
console.log(`helium ~${nHe.toFixed(0)} mol (${(nHe * 0.004).toFixed(1)} kg) at ${(Pgas / 1e5).toFixed(2)} bar`);

for (const uW of [2000e3, 800e3, 400e3, 200e3, 100e3, 50e3, 10e3, 1e3, 0.5e3]) {
  // water at specific energy uW plus helium at the same nominal temperature bracket start (300 K)
  const U = mW * uW + nHe * Cv_He * 300;
  try {
    const r = solveMixtureState(mW, U, V, { He: nHe } as any, 400);
    console.log(`u_water=${(uW / 1e3).toFixed(1)} kJ/kg U=${(U / 1e6).toFixed(2)} MJ -> T=${r.temperature.toFixed(2)} K P=${(r.pressure / 1e5).toFixed(3)} bar ${r.phase} x=${r.quality.toExponential(2)} iters=${r.iterations} waterU=${(r.waterEnergy / 1e6).toFixed(3)} gasU=${(r.gasEnergy / 1e6).toFixed(3)}`);
  } catch (e) {
    console.log(`u_water=${(uW / 1e3).toFixed(1)} kJ/kg -> THREW: ${String((e as Error).message).slice(0, 160)}`);
  }
}
// And well below: energy that water at 273.16 K plus gas at 273.16 K cannot hold
for (const U of [mW * 1e3 + nHe * Cv_He * 273.16, mW * 1e3 + nHe * Cv_He * 200, mW * 1e3 * 0.5]) {
  try {
    const r = solveMixtureState(mW, U, V, { He: nHe } as any, 300);
    console.log(`U=${(U / 1e6).toFixed(3)} MJ (below the floor) -> T=${r.temperature.toFixed(2)} K P=${(r.pressure / 1e5).toFixed(3)} bar ${r.phase} x=${r.quality.toExponential(2)} iters=${r.iterations}`);
  } catch (e) {
    console.log(`U=${(U / 1e6).toFixed(3)} MJ (below the floor) -> THREW: ${String((e as Error).message).slice(0, 160)}`);
  }
}
