import * as fs from 'fs';
import { deserializeSimulationState } from '../src/simulation/serialization';
const [a, b] = process.argv.slice(2).map(f => deserializeSimulationState(JSON.parse(fs.readFileSync(f, 'utf-8'))));
console.log('time', a.time, b.time);
const rows: [number, string][] = [];
let Ua = 0, Ub = 0;
for (const [id, t] of a.thermalNodes) {
  const u = b.thermalNodes.get(id)!;
  const C = t.mass * (t as any).specificHeat;
  Ua += C * t.temperature; Ub += C * u.temperature;
  rows.push([Math.abs(C * (u.temperature - t.temperature)), `solid ${id}: T ${(t.temperature - 273.15).toFixed(2)} -> ${(u.temperature - 273.15).toFixed(2)} (dT ${(u.temperature - t.temperature).toFixed(3)}) dE=${(C * (u.temperature - t.temperature) / 1e6).toFixed(1)} MJ`]);
}
console.log('solid energy diff (slow - ref), MJ:', ((Ub - Ua) / 1e6).toFixed(1));
let Fa = 0, Fb = 0;
for (const [id, n] of a.flowNodes) {
  const m = b.flowNodes.get(id)!;
  if (n.isBoundary) continue;
  Fa += n.fluid.internalEnergy; Fb += m.fluid.internalEnergy;
  const g = (x: any) => Object.values(x.fluid.ncg ?? {}).reduce((p: number, q: any) => p + q, 0) as number;
  rows.push([Math.abs(m.fluid.internalEnergy - n.fluid.internalEnergy), `fluid ${id}: m ${n.fluid.mass.toFixed(1)} -> ${m.fluid.mass.toFixed(1)} mol ${g(n).toFixed(0)} -> ${g(m).toFixed(0)} T ${(n.fluid.temperature - 273.15).toFixed(2)} -> ${(m.fluid.temperature - 273.15).toFixed(2)} P ${(n.fluid.pressure / 1e5).toFixed(3)} -> ${(m.fluid.pressure / 1e5).toFixed(3)} dU=${((m.fluid.internalEnergy - n.fluid.internalEnergy) / 1e6).toFixed(1)} MJ`]);
}
console.log('fluid energy diff, MJ:', ((Fb - Fa) / 1e6).toFixed(1));
rows.sort((x, y) => y[0] - x[0]);
for (const r of rows.slice(0, 22)) console.log(r[1]);
