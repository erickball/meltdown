/**
 * Superheat pin check on one OTSG tube in a snapshot: the wall the pin
 * reads, the temperature it targets, the T3 the partition reports, and the
 * standing Q3 that results. The pin promises T3 <= the metal it covers; a
 * T3 above it drives Q3 negative - heat pumped from the steam into its own
 * wall, paid for by the boiling section.
 *
 * Usage: npx tsx scripts/probe-otsg-pin.ts <preset.json> <snapshot.json> <tubeId>
 */
import * as fs from 'fs';
import { buildSimFromFile } from './lib/sim-harness';
import { deserializeSimulationState } from '../src/simulation/serialization';
import {
  evaluateOtsgSections, otsgWallPin, otsgWaterSideDuties, otsgMetalZones,
} from '../src/simulation/operators/otsg-operator';
import { zoneMeanTemp } from '../src/simulation/otsg';

const [presetPath, snap, tubeId] = process.argv.slice(2);
const sim = buildSimFromFile(presetPath);
sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(snap, 'utf-8')));
const s = sim.state;
const node = s.flowNodes.get(tubeId)!;
const { ev, flows } = evaluateOtsgSections(s, tubeId, node, { exact: true });
const zones = otsgMetalZones(s, node);
const zT = zones.map(z => z.temperature);
const pin = otsgWallPin(s, node, flows);
const L = ev.sections.map(x => x.lengthFrac);
const L3 = L[2];
const hA3 = pin.hA3Full * L3;
const theta = hA3 > 0 ? hA3 / (2 * pin.WCp3 + hA3) : 0;
const TWall3 = zoneMeanTemp(zT, 1 - L3, 1);
const T3target = ev.sat.T + theta * Math.max(0, TWall3 - ev.sat.T);
const d = otsgWaterSideDuties(ev, flows, zT, node.otsg!.heatArea);
const C = (T: number) => (T - 273.15).toFixed(2);
console.log(`P=${(ev.P / 1e5).toFixed(3)} bar regime=${ev.regime} L=${L.map(x => x.toFixed(4)).join('/')} ` +
  `m=${ev.sections.map(x => x.mass.toFixed(3)).join('/')} WSteam=${flows.WSteamOut.toFixed(3)}`);
console.log(`Tsat=${C(ev.sat.T)} TWall3(mean over [1-L3,1])=${C(TWall3)} theta=${theta.toFixed(4)} ` +
  `T3target=${C(T3target)} T3 reported=${C(ev.sections[2].T)}`);
console.log(`Q1=${(d.Q1 / 1e6).toFixed(3)} Q2=${(d.Q2 / 1e6).toFixed(3)} Q3=${(d.Q3 / 1e6).toFixed(3)} MW`);
console.log('zone  T(C)   Q3_z(kW)  Q2_z(kW)');
zones.forEach((z, j) => {
  if (Math.abs(d.zoneQ3[j]) > 1 || Math.abs(d.zoneQ2[j]) > 1)
    console.log(`${String(j + 1).padStart(4)} ${C(zT[j]).padStart(7)} ${(d.zoneQ3[j] / 1e3).toFixed(1).padStart(9)} ${(d.zoneQ2[j] / 1e3).toFixed(1).padStart(9)}`);
});

// Where the pinned energy and the reported temperature part ways
import { superheatedStateAtPT } from '../src/simulation/otsg';
import { calculateState } from '../src/simulation/water-properties';
{
  const s3 = ev.sections[2];
  const u3 = s3.hBar - ev.P * s3.vBar;
  const atTarget = superheatedStateAtPT(ev.P, T3target);
  const atReported = superheatedStateAtPT(ev.P, ev.sections[2].T);
  console.log(`u3 held=${(u3 / 1e3).toFixed(2)} kJ/kg v3=${s3.vBar.toFixed(4)} | u(P,T3target)=${(atTarget.u / 1e3).toFixed(2)} v=${atTarget.v.toFixed(4)} ` +
    `| u(P,T3reported)=${(atReported.u / 1e3).toFixed(2)} v=${atReported.v.toFixed(4)}`);
  console.log(`calculateState(u3, v3).T=${C(calculateState(1, u3, s3.vBar).temperature)} ` +
    `P=${(calculateState(1, u3, s3.vBar).pressure / 1e5).toFixed(3)} bar`);
}
