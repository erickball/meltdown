/**
 * Loop acoustic-mode probe.
 *
 * Two things in one script:
 *  1. At t=0 (and again at the end) it builds the linearized, undamped
 *     acoustic system of the whole flow network from the SAME quantities the
 *     pressure solver uses - node compliance C_i = rho_i*V_i/K_i (kg/Pa) and
 *     connection inertance A_j/L_j (kg/s per Pa*s) - and prints the lowest
 *     eigenfrequencies with their mode shapes. That is the spectrum a step
 *     size has to resolve (or safely collapse).
 *  2. It runs the preset and reports, per sample window, the min/max flow on
 *     every connection touching a chosen node set (default: the ring through
 *     cv-1-inner, found by walking gas-phase nodes), the pressure swing on
 *     those nodes, and the dt / rejection counts - so a surge shows up as a
 *     band, not a single endpoint.
 *
 * Usage: npx tsx scripts/probe-loop-mode.ts [preset] [seconds] [tickDt] [sampleEvery] [--steps]
 * Knobs: MAX_DT=<s> caps solver dt (with tickDt=0.1 that quantizes to 100/n ms);
 *        LOOP=<nodeId,nodeId,...> overrides the watched node set;
 *        --steps prints every accepted step's loop flows (verbose).
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildSimFromFile } from './lib/sim-harness';
import type { SimulationState } from '../src/simulation/types';
import { totalMass as ncgTotalMass } from '../src/simulation/gas-properties';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const perStep = args.includes('--steps');
const pos = args.filter(a => !a.startsWith('--'));
const preset = pos[0] || path.join(HERE, '..', 'src', 'presets', 'xe100.json');
const seconds = parseFloat(pos[1] || '30');
const tickDt = parseFloat(pos[2] || '0.1');
const sampleEvery = parseFloat(pos[3] || '5');

const maxDtEnv = process.env.MAX_DT;
const sim = buildSimFromFile(preset, maxDtEnv ? { maxDt: parseFloat(maxDtEnv) } : {});

// ---------- watched node set ----------
function gasRingFrom(state: SimulationState, seed: string): string[] {
  const seen = new Set<string>([seed]);
  const queue = [seed];
  while (queue.length) {
    const id = queue.shift()!;
    for (const c of state.flowConnections) {
      const other = c.fromNodeId === id ? c.toNodeId : c.toNodeId === id ? c.fromNodeId : null;
      if (!other || seen.has(other)) continue;
      const n = state.flowNodes.get(other);
      if (!n || n.isBoundary) continue;
      if (n.fluid.phase === 'liquid' || n.fluid.phase === 'two-phase') continue;
      // Stay on the big gas path: skip tiny valve/leak nodes
      if (n.volume < 0.5) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  return [...seen];
}
const loopIds = process.env.LOOP ? process.env.LOOP.split(',') :
  (sim.state.flowNodes.has('cv-1-inner') ? gasRingFrom(sim.state, 'cv-1-inner') : []);
const loopSet = new Set(loopIds);
const loopConns = sim.state.flowConnections.filter(c => loopSet.has(c.fromNodeId) && loopSet.has(c.toNodeId));

console.log(`preset=${path.basename(preset)} seconds=${seconds} tickDt=${tickDt} maxDt=${maxDtEnv ?? 'free'}`);
console.log('watched nodes:');
for (const id of loopIds) {
  const n = sim.state.flowNodes.get(id)!;
  const gas = n.fluid.ncg ? ncgTotalMass(n.fluid.ncg) : 0;
  console.log(`  ${id.padEnd(16)} V=${n.volume.toFixed(2).padStart(8)} m3  m=${(n.fluid.mass + gas).toFixed(1).padStart(7)} kg` +
    `  P=${(n.fluid.pressure / 1e5).toFixed(3)} bar  T=${n.fluid.temperature.toFixed(0)} K  ${n.fluid.phase}`);
}
console.log('watched connections: ' + loopConns.map(c => `${c.id}(${c.fromNodeId}->${c.toNodeId} A=${c.flowArea} L=${c.length})`).join(', '));

// ---------- acoustic spectrum ----------
function jacobiEigen(a: number[][]): { values: number[]; vectors: number[][] } {
  const n = a.length;
  const A = a.map(r => r.slice());
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: A.map((r, i) => r[i]), vectors: V };
}

function acousticSpectrum(state: SimulationState, label: string, restrict?: Set<string>) {
  const ps = (sim.solver as any).pressureSolver;
  const ids: string[] = [];
  const C: number[] = [];
  for (const [id, n] of state.flowNodes) {
    if (n.isBoundary) continue;
    if (restrict && !restrict.has(id)) continue;
    const gas = n.fluid.ncg ? ncgTotalMass(n.fluid.ncg) : 0;
    const rho = (n.fluid.mass + gas) / n.volume;
    const K = ps.getEffectiveBulkModulus(n, rho);
    ids.push(id);
    C.push(rho * n.volume / K);
  }
  const idx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const Kmat: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const c of state.flowConnections) {
    const i = idx.get(c.fromNodeId), j = idx.get(c.toNodeId);
    if (i === undefined && j === undefined) continue;
    const L = c.length && c.length > 0 ? c.length : 10;
    const A = c.flowArea || 0.1;
    const g = A / L;
    if (i !== undefined) Kmat[i][i] += g;
    if (j !== undefined) Kmat[j][j] += g;
    if (i !== undefined && j !== undefined) { Kmat[i][j] -= g; Kmat[j][i] -= g; }
  }
  // Symmetrize: M = C^-1/2 K C^-1/2, eigenvalues = omega^2
  const M = Kmat.map((row, i) => row.map((v, j) => v / Math.sqrt(C[i] * C[j])));
  const { values, vectors } = jacobiEigen(M);
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  console.log(`\nacoustic spectrum (${label}, ${n} nodes, undamped):`);
  let shown = 0;
  for (const k of order) {
    const w2 = values[k];
    const f = Math.sqrt(Math.max(w2, 0)) / (2 * Math.PI);
    // Physical mode shape in pressure: x = C^-1/2 y
    const shape = ids.map((id, i) => ({ id, x: vectors[i][k] / Math.sqrt(C[i]) }));
    const norm = Math.max(...shape.map(s => Math.abs(s.x)));
    const top = shape.map(s => ({ id: s.id, r: s.x / norm })).filter(s => Math.abs(s.r) > 0.15)
      .sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 6)
      .map(s => `${s.id}:${s.r.toFixed(2)}`).join(' ');
    const T = f > 0 ? 1 / f : Infinity;
    console.log(`  f=${f.toFixed(2).padStart(8)} Hz  T=${(T * 1e3).toFixed(1).padStart(8)} ms  T/3=${(T / 3 * 1e3).toFixed(1).padStart(7)} ms  ${top}`);
    if (++shown >= 12) break;
  }
}

acousticSpectrum(sim.state, 'whole network, t=0');
if (loopIds.length) acousticSpectrum(sim.state, 'watched nodes only, t=0', loopSet);

// ---------- run ----------
type Band = { min: number; max: number };
const flowBands = new Map<string, Band>();
const pBands = new Map<string, Band>();
const prevP = new Map<string, number>();
let dtMin = Infinity, dtMax = 0, stepsInWindow = 0, rejInWindow = 0;
const rejCauses = new Map<string, number>();
function widen(map: Map<string, Band>, key: string, v: number) {
  const b = map.get(key);
  if (!b) map.set(key, { min: v, max: v });
  else { if (v < b.min) b.min = v; if (v > b.max) b.max = v; }
}
sim.solver.onSubstepComplete = (state, _n, dt) => {
  stepsInWindow++;
  if (dt < dtMin) dtMin = dt;
  if (dt > dtMax) dtMax = dt;
  for (const c of loopConns) widen(flowBands, c.id, c.massFlowRate);
  const live = state.flowConnections;
  for (const c of live) if (loopConns.some(l => l.id === c.id)) widen(flowBands, c.id, c.massFlowRate);
  for (const id of loopIds) widen(pBands, id, state.flowNodes.get(id)!.fluid.pressure);
  if (perStep) {
    const fl = live.filter(c => loopSet.has(c.fromNodeId) && loopSet.has(c.toNodeId))
      .map(c => `${c.fromNodeId.slice(0, 6)}>${c.toNodeId.slice(0, 6)}=${c.massFlowRate.toFixed(1)}`).join(' ');
    const pr = loopIds.map(id => `${id.slice(0, 8)}=${(state.flowNodes.get(id)!.fluid.pressure / 1e5).toFixed(3)}`).join(' ');
    console.log(`  t=${state.time.toFixed(3)} dt=${(dt * 1e3).toFixed(1)}ms ${fl} | ${pr}`);
    // Solver's predicted δP for this (accepted) attempt vs the realized ΔP (kPa)
    const pred = (sim.solver as any).pressureSolver?.lastPredictedDP as Map<string, number> | undefined;
    if (pred) {
      const cmp = loopIds.map(id => {
        const p = state.flowNodes.get(id)!.fluid.pressure;
        const prev = prevP.get(id);
        const real = prev === undefined ? NaN : (p - prev) / 1e3;
        return `${id.slice(0, 6)} ${((pred.get(id) ?? NaN) / 1e3).toFixed(0)}/${real.toFixed(0)}`;
      }).join('  ');
      console.log(`      pred/real dP kPa: ${cmp}`);
    }
  }
  for (const id of loopIds) prevP.set(id, state.flowNodes.get(id)!.fluid.pressure);
};
sim.solver.onStepRejected = (_from, _cand, _dt, reason) => {
  rejInWindow++;
  const key = reason.split(' ')[0];
  rejCauses.set(key, (rejCauses.get(key) || 0) + 1);
};

const ticks = Math.round(seconds / tickDt);
const ticksPerSample = Math.max(1, Math.round(sampleEvery / tickDt));
console.log('\nt(s)   power(MW)  dt(ms) min-max   steps rej | flow bands (kg/s) | pressure swing (kPa)');
const wallStart = performance.now();
for (let i = 1; i <= ticks; i++) {
  const r = sim.solver.advance(sim.state, tickDt);
  sim.state = r.state;
  sim.state.pendingEvents = [];
  if (i % ticksPerSample === 0 || i === ticks) {
    const flows = loopConns.map(c => {
      const b = flowBands.get(c.id)!;
      return `${c.fromNodeId.slice(0, 5)}>${c.toNodeId.slice(0, 5)} ${b.min.toFixed(0)}..${b.max.toFixed(0)}`;
    }).join('  ');
    const swings = loopIds.map(id => { const b = pBands.get(id)!; return `${id.slice(0, 8)} ${((b.max - b.min) / 1e3).toFixed(0)}`; }).join('  ');
    console.log(`${sim.state.time.toFixed(1).padStart(5)}  ${(sim.state.neutronics.power / 1e6).toFixed(1).padStart(7)}  ` +
      `${(dtMin * 1e3).toFixed(1)}-${(dtMax * 1e3).toFixed(1)}  ${String(stepsInWindow).padStart(5)} ${String(rejInWindow).padStart(3)} | ${flows} | ${swings}`);
    flowBands.clear(); pBands.clear();
    dtMin = Infinity; dtMax = 0; stepsInWindow = 0; rejInWindow = 0;
  }
}
const wallSec = (performance.now() - wallStart) / 1000;
const m = sim.solver.getMetrics();
console.log(`\nwall=${wallSec.toFixed(2)}s = ${(sim.state.time / wallSec).toFixed(2)}x realtime  steps=${m.totalSteps} rejected=${m.rejectedSteps}`);
console.log('rejection causes: ' + [...rejCauses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(', '));
acousticSpectrum(sim.state, `whole network, t=${sim.state.time.toFixed(0)}`);
