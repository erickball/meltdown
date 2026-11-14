/**
 * Steam-above-metal watch: runs a preset and, for every moving-boundary
 * boiler tube, compares what the steam side reports against the metal that
 * heats it, on every accepted frame:
 *
 *   mean  - superheat section mean T3 minus the mean metal it covers
 *   peak  - T3 minus the HOTTEST metal zone of the bundle
 *   out   - the temperature of the steam the tube offers its outlet
 *           (hSteamOut at the tube's pressure) minus the hottest metal zone
 *   gas   - that same outlet temperature minus the gas entering the shell
 *
 * Prints a line whenever any of them sets a new maximum above MARGIN, and a
 * summary at the end. A positive `peak` or `out` is steam hotter than every
 * piece of tube it has touched.
 *
 * Usage: npx tsx scripts/probe-steam-over-metal.ts <preset.json> <seconds> [margin K] [snapshotIn] [snapshotOut]
 */
import * as fs from 'fs';
import { buildSimFromFile } from './lib/sim-harness';
import { serializeSimulationState, deserializeSimulationState } from '../src/simulation/serialization';
import { evaluateOtsgSections, otsgZoneTemps, otsgGasInletTemp, otsgWallPin } from '../src/simulation/operators/otsg-operator';
import { zoneMeanTemp, superheatedStateAtPT } from '../src/simulation/otsg';

const [presetPath, secArg, marginArg, snapIn, snapOut] = process.argv.slice(2);
const seconds = parseFloat(secArg ?? '600');
const MARGIN = parseFloat(marginArg ?? '2');
const sim = buildSimFromFile(presetPath);
if (snapIn && snapIn !== '-') sim.state = deserializeSimulationState(JSON.parse(fs.readFileSync(snapIn, 'utf-8')));

/** Temperature on the P-isobar whose enthalpy is h (bisection on the real surface). */
function tempOfSteamH(P: number, h: number, TSat: number): number {
  const hAt = (T: number) => { const s = superheatedStateAtPT(P, T); return s.u + P * s.v; };
  // Bracket upward from saturation so the search never probes steam far
  // hotter than the answer (off the table's edge at boiler pressures).
  let lo = TSat, hi = TSat + 25;
  for (let i = 0; i < 12 && hAt(hi) < h; i++) { lo = hi; hi = TSat + (hi - TSat) * 2; }
  for (let i = 0; i < 40; i++) {
    const Tm = 0.5 * (lo + hi);
    const s = superheatedStateAtPT(P, Tm);
    if (s.u + P * s.v < h) lo = Tm; else hi = Tm;
    if (hi - lo < 0.05) break;
  }
  return 0.5 * (lo + hi);
}

interface Worst { v: number; t: number; line: string }
const worst = new Map<string, Record<string, Worst>>();
const C = (T: number) => (T - 273.15).toFixed(1);

let nextOutlet = -Infinity;
let nextStatus = -Infinity;
const STATUS_EVERY = parseFloat(process.env.STATUS_EVERY ?? '30');
function check() {
  const s = sim.state;
  // The outlet inversion runs twice a sim-second; the section checks every frame.
  const statusDue = s.time >= nextStatus;
  if (statusDue) nextStatus = s.time + STATUS_EVERY;
  const outletDue = statusDue || s.time >= nextOutlet;
  if (outletDue) nextOutlet = s.time + 0.5;
  for (const [id, node] of s.flowNodes) {
    if (!node.otsg || !(node.fluid.mass > 0)) continue;
    const { ev, flows } = evaluateOtsgSections(s, id, node);
    const s3 = ev.sections[2];
    if (!(s3.mass > 0)) continue;
    const zT = otsgZoneTemps(s, node);
    const TMax = Math.max(...zT);
    const L3 = s3.lengthFrac;
    const TWall3 = zoneMeanTemp(zT, 1 - L3, 1);
    const shell = s.flowNodes.get(node.otsg.shellNodeId)!;
    const TGasIn = otsgGasInletTemp(s, shell);
    const excess: Record<string, number> = {
      mean: s3.T - TWall3,
      peak: s3.T - TMax,
    };
    // The outlet inversion is a few dozen property calls - only when the
    // cheap enthalpy comparison says it could matter.
    let TOut = NaN;
    if (outletDue && ev.hSteamOut > ev.sat.h_g + 1e3) {
      TOut = tempOfSteamH(ev.P, ev.hSteamOut, ev.sat.T);
      excess.out = TOut - TMax;
      excess.gas = TOut - TGasIn;
    }
    if (statusDue) {
      console.log(`  ${id} t=${s.time.toFixed(0)} ${ev.regime} P=${(ev.P / 1e5).toFixed(1)} L3=${L3.toFixed(3)} ` +
        `Tsat=${C(ev.sat.T)} T3=${C(s3.T)} TOut=${Number.isFinite(TOut) ? C(TOut) : '-'} TWall3=${C(TWall3)} ` +
        `TmMax=${C(TMax)} TmMin=${C(Math.min(...zT))} TmEnd=${C(zT[zT.length - 1])} TGasIn=${C(TGasIn)} WSteam=${flows.WSteamOut.toFixed(2)} ` +
        `m=${ev.sections.map(x => x.mass.toFixed(1)).join('/')} impl=${node.otsg.wallImplicit?.arm ?? '-'} ` +
        `| mean=${excess.mean.toFixed(1)} peak=${excess.peak.toFixed(1)} out=${(excess.out ?? NaN).toFixed(1)}`);
    }
    let rec = worst.get(id);
    if (!rec) { rec = {}; worst.set(id, rec); }
    for (const [k, v] of Object.entries(excess)) {
      const prev = rec[k]?.v ?? MARGIN;
      if (v > prev + 1) {
        const pin = otsgWallPin(s, node, flows);
        const line = `t=${s.time.toFixed(2)} ${id} ${k}=+${v.toFixed(1)}K regime=${ev.regime} P=${(ev.P / 1e5).toFixed(3)}bar ` +
          `m=${ev.sections.map(x => x.mass.toFixed(2)).join('/')} L=${ev.sections.map(x => x.lengthFrac.toFixed(3)).join('/')} ` +
          `Tsat=${C(ev.sat.T)} T3=${C(s3.T)} TOut=${Number.isFinite(TOut) ? C(TOut) : '-'} TWall3=${C(TWall3)} TmMax=${C(TMax)} ` +
          `Tm(feed..steam)=${C(zT[0])}/${C(zT[Math.floor(zT.length / 2)])}/${C(zT[zT.length - 1])} TGasIn=${C(TGasIn)} Tshell=${C(shell.fluid.temperature)} ` +
          `WSteam=${flows.WSteamOut.toFixed(3)} WFeed=${flows.WFeed.toFixed(3)} pin.WSteam=${pin.WSteam.toFixed(3)}`;
        rec[k] = { v, t: s.time, line };
        console.log(line);
        if (k === 'mean') {
          // Is it the evaluation the physics is riding (a tangent off an
          // older anchor) or the closure itself? Re-solve this very state
          // exactly, with no cache and no anchor.
          const fresh = { ...node, otsg: { ...node.otsg, partitionCache: undefined, partitionLin: undefined } };
          const ex = evaluateOtsgSections(s, id, fresh as typeof node, { exact: true }).ev;
          const LX = ex.sections[2].lengthFrac;
          const lin = node.otsg.partitionLin;
          console.log(`     exact re-solve: T3=${C(ex.sections[2].T)} TWall3=${C(zoneMeanTemp(zT, 1 - LX, 1))} L3=${LX.toFixed(3)} ` +
            `P=${(ex.P / 1e5).toFixed(3)} regime=${ex.regime} | riding: cache.exact=${node.otsg.partitionCache?.exact} ` +
            `anchor dm=${lin ? (node.fluid.mass - lin.m).toExponential(2) : '-'} anchorT3=${lin ? C((lin.ev as typeof ex).sections[2].T) : '-'}`);
        }
      }
    }
  }
}

const wall0 = performance.now();
const end = sim.state.time + seconds;
let nextNote = sim.state.time;
while (sim.state.time < end) {
  const r = sim.solver.advance(sim.state, 0.05);
  sim.state = r.state;
  sim.state.pendingEvents = [];
  check();
  if (sim.state.time >= nextNote) {
    console.log(`  .. t=${sim.state.time.toFixed(0)} wall=${((performance.now() - wall0) / 1000).toFixed(0)}s`);
    nextNote += Math.max(60, seconds / 20);
  }
}
console.log('--- worst per tube ---');
for (const [id, rec] of worst) {
  for (const [k, w] of Object.entries(rec)) console.log(`${id} ${k}: +${w.v.toFixed(1)} K at t=${w.t.toFixed(1)}`);
}
if (worst.size === 0) console.log(`nothing above ${MARGIN} K`);
if (snapOut) fs.writeFileSync(snapOut, JSON.stringify(serializeSimulationState(sim.state)));
