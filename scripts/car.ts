/**
 * Jack's Corrective Action Reports (bug reports) on our side.
 *
 *   npx tsx scripts/car.ts list                     newest first
 *   npx tsx scripts/car.ts fetch <id> [--out DIR]   download one (default DIR = cars/<id>)
 *   npx tsx scripts/car.ts close <id> [<id> ...]    delete processed reports from Firestore
 *
 * `fetch` writes:
 *   report.json   title, description, severity, context, bundle metadata
 *   bundle.gz     the reproduction bundle as sent (gzip; see jack-car-bundle.ts)
 *   design.json   the plant + sim state in the app's save format - the Import
 *                 button in the app loads it and resumes paused at the reported
 *                 moment; scripts/repro-car.ts replays it headless
 *
 * Reports are meant to be closed once dealt with: `close` removes the report
 * and its bundle chunks so Firestore does not fill up with other people's
 * plants. Anything nobody closes is deleted by the TTL policy on `expireAt`
 * (see functions/src/index.ts).
 *
 * Auth: the Firestore REST API with a gcloud user token (the project owner
 * account). `gcloud auth login` first if the token call fails.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { decodeCarBundle, base64ToBytes, describeBundle } from '../src/jack/jack-car-bundle';
import { serializeSimulationState } from '../src/simulation/serialization';

const PROJECT = 'unityriskresearch';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// ---------------------------------------------------------------------------
// Firestore REST plumbing
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;
function token(): string {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = execSync('gcloud auth print-access-token', { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString().trim();
  } catch (e) {
    throw new Error(`Could not get a gcloud access token (run 'gcloud auth login'): ${String(e)}`);
  }
  return cachedToken;
}

async function rest(method: 'GET' | 'DELETE', url: string): Promise<unknown> {
  const resp = await fetch(url, { method, headers: { Authorization: `Bearer ${token()}` } });
  if (!resp.ok) {
    throw new Error(`${method} ${url} -> HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

/** Firestore's typed value encoding -> plain JS. */
function fromValue(v: Record<string, unknown>): unknown {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return fromFields((v.mapValue as { fields?: Record<string, Record<string, unknown>> }).fields ?? {});
  if ('arrayValue' in v) {
    return ((v.arrayValue as { values?: Array<Record<string, unknown>> }).values ?? []).map(fromValue);
  }
  return v;
}

function fromFields(fields: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromValue(v);
  return out;
}

interface FirestoreDoc { name: string; fields?: Record<string, Record<string, unknown>>; createTime?: string }

async function listAll(collectionUrl: string, mask?: string[]): Promise<Array<{ id: string; data: Record<string, unknown>; createTime: string }>> {
  const out: Array<{ id: string; data: Record<string, unknown>; createTime: string }> = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ pageSize: '300' });
    if (pageToken) params.set('pageToken', pageToken);
    for (const m of mask ?? []) params.append('mask.fieldPaths', m);
    const page = (await rest('GET', `${collectionUrl}?${params}`)) as { documents?: FirestoreDoc[]; nextPageToken?: string } | null;
    for (const d of page?.documents ?? []) {
      out.push({ id: d.name.slice(d.name.lastIndexOf('/') + 1), data: fromFields(d.fields ?? {}), createTime: d.createTime ?? '' });
    }
    pageToken = page?.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function list(): Promise<void> {
  // Everything but the bundle metadata's summary is small; the chunks live
  // in subcollections and are not listed here.
  const docs = await listAll(`${BASE}/jack-cars`);
  docs.sort((a, b) => (b.createTime > a.createTime ? 1 : -1));
  if (docs.length === 0) {
    console.log('No open reports.');
    return;
  }
  for (const d of docs) {
    const bundle = d.data.bundle as Record<string, unknown> | null;
    const ctx = (d.data.context ?? {}) as Record<string, unknown>;
    console.log(
      `${d.id}  ${String(d.data.created ?? d.createTime).slice(0, 19)}  ${String(d.data.severity).padEnd(6)}  ` +
      `${bundle ? `bundle ${(Number(bundle.chars) / 1e6).toFixed(2)} MB` : 'no bundle       '}  ` +
      `build ${String(ctx.build ?? '?').padEnd(13)}  ${d.data.title}`
    );
  }
  console.log(`\n${docs.length} open report(s). Fetch one with: npx tsx scripts/car.ts fetch <id>`);
}

async function fetchOne(id: string, outDir: string): Promise<void> {
  const doc = (await rest('GET', `${BASE}/jack-cars/${id}`)) as FirestoreDoc;
  const data = fromFields(doc.fields ?? {});
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ id, ...data }, null, 2));

  console.log(`\n=== CAR ${id} ===`);
  console.log(`Title:     ${data.title}`);
  console.log(`Severity:  ${data.severity}${data.component ? `   Component: ${data.component}` : ''}`);
  console.log(`Created:   ${data.created}`);
  console.log(`Context:   ${JSON.stringify(data.context)}`);
  console.log(`\n${data.description}\n`);

  const meta = data.bundle as Record<string, unknown> | null;
  if (!meta) {
    console.log('No reproduction bundle attached.');
    console.log(`Wrote ${outDir}/report.json`);
    return;
  }

  const chunks = await listAll(`${BASE}/jack-cars/${id}/car-chunks`);
  chunks.sort((a, b) => Number(a.data.index) - Number(b.data.index));
  if (chunks.length !== Number(meta.chunks)) {
    throw new Error(`Bundle metadata says ${meta.chunks} chunks; found ${chunks.length}`);
  }
  const base64 = chunks.map(c => String(c.data.data)).join('');
  if (base64.length !== Number(meta.chars)) {
    throw new Error(`Reassembled bundle is ${base64.length} chars; metadata says ${meta.chars}`);
  }
  const sha = createHash('sha256').update(base64).digest('hex');
  if (sha !== meta.sha256) {
    throw new Error(`Reassembled bundle sha256 ${sha} does not match the recorded ${meta.sha256}`);
  }
  fs.writeFileSync(path.join(outDir, 'bundle.gz'), base64ToBytes(base64));

  const bundle = await decodeCarBundle(base64);
  const design = { ...bundle.plant, simState: serializeSimulationState(bundle.simState) };
  fs.writeFileSync(path.join(outDir, 'design.json'), JSON.stringify(design));

  console.log(`Reproduction bundle (built ${bundle.createdAt}, build ${bundle.build}, ${bundle.mode} mode):`);
  for (const line of describeBundle({ ...bundle.summary, bytes: base64.length })) console.log(`  ${line}`);
  console.log(`\nWrote ${outDir}/report.json, bundle.gz, design.json`);
  console.log(`Replay it:   npx tsx scripts/repro-car.ts ${outDir} --run 60`);
  console.log(`Or import design.json with the app's Import button (resumes paused at t = ${bundle.simState.time.toFixed(1)} s).`);
  console.log(`When done:   npx tsx scripts/car.ts close ${id}`);
}

async function close(ids: string[]): Promise<void> {
  for (const id of ids) {
    // Subcollection documents do not go away with their parent; delete them
    // first so a failure leaves the report (and its metadata) to retry from.
    const chunks = await listAll(`${BASE}/jack-cars/${id}/car-chunks`, ['index']);
    for (const c of chunks) await rest('DELETE', `${BASE}/jack-cars/${id}/car-chunks/${c.id}`);
    await rest('DELETE', `${BASE}/jack-cars/${id}`);
    console.log(`Closed ${id} (${chunks.length} bundle chunk(s) removed).`);
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [cmd, ...rest_] = process.argv.slice(2);
  const outIdx = rest_.indexOf('--out');
  const outDir = outIdx >= 0 ? rest_[outIdx + 1] : null;
  const ids = rest_.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
  switch (cmd) {
    case 'list':
      await list();
      break;
    case 'fetch':
      if (ids.length !== 1) throw new Error('fetch takes exactly one report id');
      await fetchOne(ids[0], outDir ?? path.join('cars', ids[0]));
      break;
    case 'close':
      if (ids.length === 0) throw new Error('close takes one or more report ids');
      await close(ids);
      break;
    default:
      console.log('Usage: npx tsx scripts/car.ts list | fetch <id> [--out DIR] | close <id> [<id> ...]');
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
