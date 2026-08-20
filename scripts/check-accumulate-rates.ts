/**
 * Prove accumulateRates is arithmetically identical to the
 * addRates(target, scaleRates(source, factor)) pair it replaced.
 *
 * Builds StateRates carrying every optional field (and some carried by only
 * one side), accumulates both ways, and compares the results field by field
 * at BIT precision - a difference of one ULP in a rate is enough to move the
 * error controller onto a different step-size trajectory.
 */

import { addRates, scaleRates, accumulateRates, createZeroRates } from '../src/simulation/rk45-solver';
import type { StateRates } from '../src/simulation/types';
import { emptyGasComposition } from '../src/simulation/gas-properties';

function rnd(seed: { s: number }): number {
  seed.s = (seed.s * 1103515245 + 12345) & 0x7fffffff;
  return seed.s / 0x7fffffff;
}

function makeRates(seed: { s: number }, nodeIds: string[], thermalIds: string[],
                   opts: { ncg?: boolean; pools?: number; env?: boolean; optionals?: boolean }): StateRates {
  const r = createZeroRates();
  for (const id of nodeIds) {
    const fr: any = { dMass: rnd(seed) * 10 - 5, dEnergy: rnd(seed) * 1e6 };
    if (opts.optionals) {
      fr.dOtsgM1 = rnd(seed) * 3;
      fr.dDepositedCsI = rnd(seed) * 1e-3;
    }
    if (opts.ncg) {
      fr.dNcg = emptyGasComposition();
      for (const k of Object.keys(fr.dNcg)) fr.dNcg[k] = rnd(seed) * 2 - 1;
    }
    r.flowNodes.set(id, fr);
  }
  for (const id of thermalIds) {
    const tr: any = { dTemperature: rnd(seed) * 20 - 10 };
    if (opts.optionals) {
      tr.dMass = rnd(seed); tr.dOxidizedFraction = rnd(seed) * 1e-4;
      tr.dGraphiteBurnoff = rnd(seed) * 1e-5; tr.dFpNobleGas = rnd(seed);
      tr.dFpVolatile = rnd(seed); tr.dMetalZr = rnd(seed);
      tr.dMetalFe = rnd(seed); tr.dSlag = rnd(seed);
    }
    r.thermalNodes.set(id, tr);
  }
  r.flowConnections.set('c1', { dMassFlowRate: rnd(seed) * 100 });
  r.flowConnections.set('c2', { dMassFlowRate: rnd(seed) * 100 });
  r.neutronics.dPower = rnd(seed) * 1e7;
  r.neutronics.dPrecursorConcentration = rnd(seed);
  if (opts.pools) r.neutronics.dDecayHeatPools = Array.from({ length: opts.pools }, () => rnd(seed));
  r.pumps.set('p1', { dEffectiveSpeed: rnd(seed) });
  if (opts.env) {
    r.environmentalRelease = emptyGasComposition();
    for (const k of Object.keys(r.environmentalRelease)) (r.environmentalRelease as any)[k] = rnd(seed);
  }
  return r;
}

const diffs: string[] = [];
function cmp(path: string, a: unknown, b: unknown) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (!Object.is(a, b)) diffs.push(`${path}: ${a} !== ${b}`);
    return;
  }
  if (a === undefined && b === undefined) return;
  if (a === undefined || b === undefined) { diffs.push(`${path}: ${a} vs ${b}`); return; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) diffs.push(`${path}.length: ${a.length} !== ${b.length}`);
    for (let i = 0; i < Math.max(a.length, b.length); i++) cmp(`${path}[${i}]`, a[i], b[i]);
    return;
  }
  if (a instanceof Map && b instanceof Map) {
    const keys = new Set([...a.keys(), ...b.keys()]);
    for (const k of keys) cmp(`${path}.${k}`, a.get(k), b.get(k));
    // Insertion order matters: it sets the summation order downstream.
    const ka = [...a.keys()].join(','), kb = [...b.keys()].join(',');
    if (ka !== kb) diffs.push(`${path} key ORDER: [${ka}] !== [${kb}]`);
    return;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) cmp(`${path}.${k}`, (a as any)[k], (b as any)[k]);
    return;
  }
  if (a !== b) diffs.push(`${path}: ${a} !== ${b}`);
}

const cases: Array<{ name: string; a: any; b: any; factor: number }> = [];
{
  const s = { s: 7 };
  cases.push({
    name: 'identical key sets, all optionals + ncg + pools + env',
    a: makeRates(s, ['n1', 'n2'], ['t1'], { ncg: true, pools: 3, env: true, optionals: true }),
    b: makeRates(s, ['n1', 'n2'], ['t1'], { ncg: true, pools: 3, env: true, optionals: true }),
    factor: 0.31640625,
  });
  cases.push({
    name: 'source has keys/fields target lacks',
    a: makeRates(s, ['n1'], ['t1'], {}),
    b: makeRates(s, ['n1', 'n2'], ['t1', 't2'], { ncg: true, pools: 2, env: true, optionals: true }),
    factor: -0.5,
  });
  cases.push({
    name: 'target has keys/fields source lacks',
    a: makeRates(s, ['n1', 'n2'], ['t1', 't2'], { ncg: true, pools: 4, env: true, optionals: true }),
    b: makeRates(s, ['n1'], ['t1'], {}),
    factor: 2,
  });
  cases.push({
    name: 'pool-length mismatch (target longer)',
    a: makeRates(s, ['n1'], ['t1'], { pools: 5 }),
    b: makeRates(s, ['n1'], ['t1'], { pools: 2 }),
    factor: 1,
  });
  cases.push({
    name: 'pool-length mismatch (source longer)',
    a: makeRates(s, ['n1'], ['t1'], { pools: 2 }),
    b: makeRates(s, ['n1'], ['t1'], { pools: 5 }),
    factor: 1,
  });
  cases.push({
    name: 'disjoint node sets',
    a: makeRates(s, ['n1'], ['t1'], { optionals: true }),
    b: makeRates(s, ['n9'], ['t9'], { optionals: true }),
    factor: 0.125,
  });
}

for (const c of cases) {
  const viaOld = addRates(c.a, scaleRates(c.b, c.factor));
  const viaNew = structuredCloneRates(c.a);
  accumulateRates(viaNew, c.b, c.factor);
  const before = diffs.length;
  cmp(`[${c.name}]`, viaOld, viaNew);
  console.log(`${diffs.length === before ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c.name}`);
}

if (diffs.length) {
  console.log('\nDIFFERENCES:');
  for (const d of diffs) console.log(`  ${d}`);
  process.exit(1);
}
console.log('\n\x1b[32m✓ accumulateRates matches addRates(scaleRates(...)) exactly\x1b[0m');

/** Deep copy so the in-place accumulate starts from the same values. */
function structuredCloneRates(r: StateRates): StateRates {
  const out = createZeroRates();
  for (const [id, v] of r.flowNodes) out.flowNodes.set(id, { ...v, ...(v.dNcg ? { dNcg: { ...v.dNcg } } : {}) });
  for (const [id, v] of r.flowConnections) out.flowConnections.set(id, { ...v });
  for (const [id, v] of r.thermalNodes) out.thermalNodes.set(id, { ...v });
  for (const [id, v] of r.pumps) out.pumps.set(id, { ...v });
  out.neutronics = { ...r.neutronics };
  if (r.neutronics.dDecayHeatPools) out.neutronics.dDecayHeatPools = [...r.neutronics.dDecayHeatPools];
  if (r.environmentalRelease) out.environmentalRelease = { ...r.environmentalRelease };
  return out;
}
