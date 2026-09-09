/**
 * Reproduce a fetched Corrective Action Report headless.
 *
 *   npx tsx scripts/repro-car.ts cars/<id> [--from T] [--run S] [--every E] [--nodes a,b] [--frame F]
 *
 *   --from T    replay the recorded history exactly from the latest replayable
 *               snapshot at or before sim time T up to the reported moment,
 *               printing the plant every E seconds; then check the replay
 *               landed bit-identically on the reported state
 *   --from 0    same, from the earliest replayable snapshot
 *   --run S     continue S sim seconds past the reported moment (live solver)
 *   --every E   print interval in sim seconds (default 10)
 *   --nodes     comma-separated flow node ids to print (default: all)
 *   --frame F   frame length for --run (default 0.05 s, like the browser)
 *
 * The bundle names the git commit that produced it. A different build may
 * still load it (same state format) but need not reproduce the same numbers;
 * the replay check tells you which. See scripts/car.ts to fetch bundles.
 *
 * What "exact" means here: a replay on the same JavaScript engine and build
 * is bit-identical (scripts/test-car-bundle.ts proves it). A bundle recorded
 * in a browser and replayed in Node differs at round-off level from the very
 * first step (the engines' math libraries are not the same) and the flow
 * solver amplifies that - a PWR startup transient reached ~1e-3 relative in
 * flow-solver quantities after 3 s. The drift table printed with --from
 * shows which case you are in: noise grows smoothly from step one; a
 * determinism bug jumps at one checkpoint. The trajectory is physically the
 * same either way, so the bug being reported still reproduces.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GameLoop } from '../src/game/loop';
import { createSimulationFromPlant, setSimulationRandomSeed } from '../src/simulation';
import { cloneSimulationState } from '../src/simulation/solver';
import { deserializePlantDesign } from '../src/simulation/serialization';
import { decodeCarBundle, bytesToBase64, describeBundle } from '../src/jack/jack-car-bundle';
import type { SimulationState } from '../src/simulation/types';
import { replayBundle, compareStates, describeDrift } from './lib/car-replay';
import type { StateDrift } from './lib/car-replay';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const target = process.argv[2];
if (!target || target.startsWith('--')) {
  console.log('Usage: npx tsx scripts/repro-car.ts cars/<id> [--from T] [--run S] [--every E] [--nodes a,b] [--frame F]');
  process.exit(2);
}
const fromArg = arg('--from');
const fromTime = fromArg === null ? null : Number(fromArg);
const runSeconds = Number(arg('--run') ?? '0');
const every = Number(arg('--every') ?? '10');
const frame = Number(arg('--frame') ?? '0.05');
const nodeFilter = arg('--nodes')?.split(',').map(s => s.trim()).filter(Boolean) ?? null;

function printState(state: SimulationState, note: string): void {
  console.log(`\n--- ${note} ---`);
  const nn = state.neutronics;
  if (nn && nn.nominalPower > 0) {
    console.log(`neutronics: P=${(nn.power / 1e6).toFixed(3)} MW (${(100 * nn.power / nn.nominalPower).toFixed(2)}%) ` +
      `reactivity=${nn.reactivity?.toExponential(3) ?? '?'}`);
  }
  let hottest: [string, number] | null = null;
  for (const [id, tn] of state.thermalNodes) {
    if (!hottest || tn.temperature > hottest[1]) hottest = [id, tn.temperature];
  }
  if (hottest) console.log(`hottest thermal node: ${hottest[0]} at ${(hottest[1] - 273.15).toFixed(1)} C`);
  for (const [id, node] of state.flowNodes) {
    if (nodeFilter && !nodeFilter.includes(id)) continue;
    const f = node.fluid;
    const ncg = f.ncg ? Object.values(f.ncg).reduce((a, b) => a + b, 0) : 0;
    console.log(
      `${id}: ${f.phase} T=${(f.temperature - 273.15).toFixed(1)}C P=${(f.pressure / 1e5).toFixed(3)}bar ` +
      `m=${f.mass.toFixed(2)}kg x=${f.quality.toFixed(4)}${ncg > 0 ? ` ncg=${ncg.toFixed(2)}mol` : ''}`
    );
  }
}

async function main(): Promise<void> {
  const file = fs.statSync(target).isDirectory() ? path.join(target, 'bundle.gz') : target;
  const bundle = await decodeCarBundle(bytesToBase64(new Uint8Array(fs.readFileSync(file))));
  const base64Length = Math.ceil(fs.statSync(file).size / 3) * 4;
  console.log(`Bundle from build ${bundle.build}, ${bundle.mode} mode, captured ${bundle.createdAt}`);
  for (const line of describeBundle({ ...bundle.summary, bytes: base64Length })) console.log(`  ${line}`);

  // Rebuild the sim from the design under THIS build, then swap in the
  // reported state - the same thing the app's save/load does. A design that
  // no longer builds the same nodes is a different plant, not a reproduction.
  const plant = deserializePlantDesign(bundle.plant);
  setSimulationRandomSeed(0);
  const fresh = createSimulationFromPlant(plant);
  const builtIds = [...fresh.flowNodes.keys()].sort();
  const reportedIds = [...bundle.simState.flowNodes.keys()].sort();
  if (JSON.stringify(builtIds) !== JSON.stringify(reportedIds)) {
    throw new Error(
      `This build makes different flow nodes from the reported design than the report's state holds ` +
      `(built ${builtIds.length}, reported ${reportedIds.length}). Check out build ${bundle.build}.`
    );
  }
  const loop = new GameLoop(fresh, { autoSlowdownEnabled: false });
  loop.setSimulationState(cloneSimulationState(bundle.simState));

  let state = loop.getState();
  const headTime = bundle.simState.time;

  if (fromTime !== null) {
    // Drift against every kept snapshot along the way: a replay on the same
    // engine and build is bit-identical; another JS engine (a report from a
    // browser, replayed in Node) differs at floating-point noise level that
    // grows smoothly; a determinism bug shows as a jump at one checkpoint.
    const drifts: Array<{ t: number; drift: StateDrift }> = [];
    const result = replayBundle(bundle, loop, {
      fromTime, every, log: printState,
      onSnapshotDrift: (snap, drift) => drifts.push({ t: snap.simTime, drift }),
    });
    console.log(
      `\nReplayed ${result.stepsReplayed} logged steps from t = ${result.base.simTime.toFixed(3)} s ` +
      `to t = ${result.state.time.toFixed(3)} s (${result.inputsAdopted} input snapshot(s) adopted).`
    );
    const nonzero = drifts.filter(d => d.drift.differing > 0 || d.drift.structural > 0);
    if (nonzero.length === 0) {
      console.log(`Replay matched all ${drifts.length} recorded checkpoint snapshots BIT-IDENTICALLY.`);
    } else {
      console.log(`Replay differs from ${nonzero.length} of ${drifts.length} recorded checkpoints; drift along the way:`);
      const show = nonzero.length <= 8 ? nonzero : [0, 1, 2, 3, nonzero.length - 3, nonzero.length - 2, nonzero.length - 1].map(i => nonzero[i]);
      for (const d of show) console.log(`  t = ${d.t.toFixed(3).padStart(10)} s: ${describeDrift(d.drift)}`);
    }
    if (Math.abs(result.state.time - headTime) > 1e-6) {
      console.log(`NOTE: the reported state is at t = ${headTime.toFixed(3)} s; the step log ends ` +
        `${(headTime - result.state.time).toFixed(3)} s earlier (the report was filed mid-frame).`);
    } else {
      const drift = compareStates(result.state, bundle.simState);
      console.log(drift.differing === 0 && drift.structural === 0
        ? 'Replay landed BIT-IDENTICALLY on the reported state.'
        : `Against the reported state: ${describeDrift(drift)}.`);
    }
    state = result.state;
    loop.setSimulationState(state);
  } else {
    printState(state, `reported state at t = ${headTime.toFixed(3)} s`);
  }

  if (runSeconds > 0) {
    const start = loop.getState().time;
    let nextLog = start + every;
    while (loop.getState().time < start + runSeconds - 1e-9) {
      loop.step(Math.min(frame, start + runSeconds - loop.getState().time));
      const t = loop.getState().time;
      if (t >= nextLog - 1e-9) {
        printState(loop.getState(), `live run, t = ${t.toFixed(3)} s`);
        nextLog += every;
      }
    }
    printState(loop.getState(), `end of live run, t = ${loop.getState().time.toFixed(3)} s`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});
