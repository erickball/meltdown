import { onRequest, Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { JACK_SYSTEM_PROMPT } from "./jack-prompt.js";
import { JACK_TOOLS } from "./jack-tools.js";

initializeApp();

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

const MODEL = "claude-opus-5-5";
// Opus 5.5's safety classifiers (cyber, bio) can decline a harmless request -
// a reactor sandbox talks about meltdowns and releases all day. When that
// happens the API re-runs the same request on this model inside the same
// call, so a false positive costs a slightly pricier reply instead of a
// silent Jack.
const FALLBACK_MODEL = "claude-opus-5";
// Generous cap: adaptive thinking counts against max_tokens, and starving it
// truncates the reply mid-tool-loop with no visible text. Output is only
// billed as used.
const MAX_OUTPUT_TOKENS = 8000;

// Hard monthly spend ceiling for the whole app, in USD.
const MONTHLY_BUDGET_USD = 25;

// List prices, USD per million tokens, for every model a reply can be served
// by. Cache write is the 5-minute-TTL rate.
interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}
const PRICES: Record<string, Price> = {
  [MODEL]: { input: 4.0, output: 20.0, cacheWrite: 5.0, cacheRead: 0.2 },
  [FALLBACK_MODEL]: { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
};

// Request sanity limits — the budget cap is the real backstop, these just
// keep any single request from being absurd.
const MAX_MESSAGES = 80;
const MAX_BODY_BYTES = 400_000;

const ALLOWED_ORIGINS = [
  "https://unityriskresearch.web.app",
  "https://unityriskresearch.firebaseapp.com",
  "https://unityriskresearch.com",
  "https://www.unityriskresearch.com",
  "https://unityriskresearch-meltdown.web.app",
  "https://unityriskresearch-meltdown.firebaseapp.com",
  "https://meltdown.unityriskresearch.com",
];
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req: Request, res: Response): boolean {
  const origin = req.headers.origin ?? "";
  if (ALLOWED_ORIGINS.includes(origin) || LOCALHOST_RE.test(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return false;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return false;
  }
  return true;
}

function usageCostUsd(
  u: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
  price: Price
): number {
  return (
    (u.input_tokens * price.input +
      u.output_tokens * price.output +
      (u.cache_creation_input_tokens ?? 0) * price.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * price.cacheRead) /
    1_000_000
  );
}

function monthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const jackChat = onRequest(
  {
    secrets: [anthropicApiKey],
    timeoutSeconds: 120,
    memory: "256MiB",
    maxInstances: 5,
    cors: false, // handled manually below so we control the origin list
  },
  async (req, res) => {
    const origin = req.headers.origin ?? "";
    if (ALLOWED_ORIGINS.includes(origin) || LOCALHOST_RE.test(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    }
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST only" });
      return;
    }

    const body = req.body;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ error: "body must be { messages: [...] }" });
      return;
    }
    if (
      body.messages.length > MAX_MESSAGES ||
      JSON.stringify(body.messages).length > MAX_BODY_BYTES
    ) {
      res.status(400).json({
        error: "conversation too long",
        jackSays:
          "Whoa, boss — this conversation's longer than a licensing hearing. Close the chat and start a fresh one.",
      });
      return;
    }

    const db = getFirestore();
    const usageRef = db.collection("jack-usage").doc(monthKey());

    // Budget gate. Read-then-call-then-increment means concurrent requests
    // can overshoot by a request or two — acceptable slop against a $25 cap.
    const snap = await usageRef.get();
    const spent: number = snap.exists ? (snap.data()!.costUsd ?? 0) : 0;
    if (spent >= MONTHLY_BUDGET_USD) {
      res.status(429).json({
        error: "monthly budget exhausted",
        jackSays:
          "Site office says I'm over my phone budget for the month, if you can believe that. I'll be back on the clock on the 1st. Blueprints still work — you just can't chat with me.",
      });
      return;
    }

    const client = new Anthropic({ apiKey: anthropicApiKey.value() });

    // Cache the conversation prefix: mark the last content block of the
    // final message so tool-loop rounds (seconds apart) and follow-up turns
    // re-read the transcript from cache instead of re-paying it in full.
    const lastContent = body.messages[body.messages.length - 1]?.content;
    if (Array.isArray(lastContent) && lastContent.length > 0) {
      lastContent[lastContent.length - 1].cache_control = { type: "ephemeral" };
    }

    let response: Anthropic.Beta.Messages.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: [{ model: FALLBACK_MODEL }],
        // Thinking is always on for this model; effort is the only control.
        // Low effort: quick chat replies, still smart enough for sizing math;
        // keeps think-time (Jack "getting stuck") down. Set explicitly - the
        // model's own default is medium.
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        tools: JACK_TOOLS,
        system: [
          {
            type: "text",
            text: JACK_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: body.messages,
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        console.error("Anthropic API error", err.status, err.message);
        res.status(502).json({
          error: `upstream ${err.status}: ${err.message}`,
          jackSays:
            "Radio's cutting out — home office isn't picking up. Give it a minute and try me again.",
        });
        return;
      }
      throw err;
    }

    // A reply the fallback model served is billed at that model's rates. The
    // declined first attempt, if it was billed at all, is in the same usage
    // totals; pricing the whole reply at the fallback's (higher) rates keeps
    // the ledger an upper bound on what was spent.
    const servedBy = (response.usage.iterations ?? []).some(
      (it) => it.type === "fallback_message"
    )
      ? FALLBACK_MODEL
      : MODEL;
    if (servedBy !== MODEL) {
      console.warn(`jackChat: ${MODEL} declined, reply served by ${servedBy}`);
    }
    if (response.stop_reason === "refusal") {
      console.warn("jackChat: request refused", response.stop_details);
    }
    const cost = usageCostUsd(response.usage, PRICES[servedBy]);
    await usageRef.set(
      {
        costUsd: FieldValue.increment(cost),
        inputTokens: FieldValue.increment(response.usage.input_tokens),
        outputTokens: FieldValue.increment(response.usage.output_tokens),
        cacheReadTokens: FieldValue.increment(
          response.usage.cache_read_input_tokens ?? 0
        ),
        cacheWriteTokens: FieldValue.increment(
          response.usage.cache_creation_input_tokens ?? 0
        ),
        requests: FieldValue.increment(1),
        updated: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    res.json({
      content: response.content,
      stop_reason: response.stop_reason,
      usage: response.usage,
      spentThisMonthUsd: Number((spent + cost).toFixed(4)),
    });
  }
);

// Corrective Action Reports: Jack's in-character bug reports, persisted to
// Firestore ("jack-cars" collection) and read on our side with
// scripts/car.ts. No auth (same anonymous posture as jackChat); size caps
// and a per-document shape check keep abuse boring.
//
// A report may carry a reproduction bundle (src/jack/jack-car-bundle.ts): a
// gzip+base64 blob of the plant design, live sim state and rewind history.
// Firestore documents top out at 1 MiB, so the blob is stored as ordered
// slices in the report's "car-chunks" subcollection and the report itself
// holds only the metadata (length, chunk count, sha256, summary).
//
// Nothing here is meant to accumulate. Every report and every chunk carries
// `expireAt`, and the Firestore TTL policy on that field (enabled with
// `gcloud firestore fields ttls update expireAt --collection-group=...`)
// deletes them after CAR_TTL_DAYS. The normal path is shorter: `scripts/car.ts
// close <id>` deletes a report the moment it has been dealt with.
const MAX_CAR_REPORT_BYTES = 20_000;
// Must match CAR_BUNDLE_BUDGET on the client (jack-car-bundle.ts).
const MAX_BUNDLE_CHARS = 6_000_000;
// Base64 chars per chunk document; well under Firestore's 1 MiB document cap.
const BUNDLE_CHUNK_CHARS = 750_000;
const CAR_TTL_DAYS = 90;

export const fileCar = onRequest(
  { timeoutSeconds: 60, memory: "512MiB", maxInstances: 2, cors: false },
  async (req, res) => {
    if (!applyCors(req, res)) return;

    const body = req.body;
    if (!body || typeof body.title !== "string" || typeof body.description !== "string") {
      res.status(400).json({ error: "body must include title and description strings" });
      return;
    }
    const { bundle, ...report } = body;
    if (JSON.stringify(report).length > MAX_CAR_REPORT_BYTES) {
      res.status(400).json({ error: "report too large" });
      return;
    }

    let bundleData: string | null = null;
    let bundleSummary: unknown = null;
    if (bundle !== undefined) {
      if (
        typeof bundle !== "object" || bundle === null ||
        bundle.encoding !== "gzip+base64" || typeof bundle.data !== "string"
      ) {
        res.status(400).json({ error: "bundle must be { encoding: 'gzip+base64', data: <base64> }" });
        return;
      }
      if (bundle.data.length > MAX_BUNDLE_CHARS) {
        res.status(400).json({
          error: `bundle too large (${bundle.data.length} chars, limit ${MAX_BUNDLE_CHARS})`,
        });
        return;
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(bundle.data)) {
        res.status(400).json({ error: "bundle data is not base64" });
        return;
      }
      bundleData = bundle.data;
      bundleSummary =
        typeof bundle.summary === "object" && bundle.summary !== null
          ? JSON.parse(JSON.stringify(bundle.summary).slice(0, 4000))
          : null;
    }

    const db = getFirestore();
    const expireAt = Timestamp.fromMillis(Date.now() + CAR_TTL_DAYS * 86_400_000);
    const docRef = db.collection("jack-cars").doc();

    // Chunks go in first, so a reader never finds a report whose bundle is
    // still arriving; the report document is the commit.
    let bundleMeta: Record<string, unknown> | null = null;
    if (bundleData !== null) {
      const chunks = Math.ceil(bundleData.length / BUNDLE_CHUNK_CHARS);
      for (let i = 0; i < chunks; i++) {
        await docRef.collection("car-chunks").doc(String(i).padStart(4, "0")).set({
          index: i,
          data: bundleData.slice(i * BUNDLE_CHUNK_CHARS, (i + 1) * BUNDLE_CHUNK_CHARS),
          expireAt,
        });
      }
      bundleMeta = {
        encoding: "gzip+base64",
        chars: bundleData.length,
        chunks,
        chunkChars: BUNDLE_CHUNK_CHARS,
        sha256: createHash("sha256").update(bundleData).digest("hex"),
        summary: bundleSummary,
      };
    }

    await docRef.set({
      title: String(report.title).slice(0, 300),
      description: String(report.description).slice(0, 8000),
      severity: ["low", "medium", "high"].includes(report.severity) ? report.severity : "medium",
      component: typeof report.component === "string" ? report.component.slice(0, 200) : null,
      context: typeof report.context === "object" && report.context !== null ? report.context : null,
      bundle: bundleMeta,
      origin: req.headers.origin ?? null,
      created: FieldValue.serverTimestamp(),
      expireAt,
    });
    res.json({ ok: true, carId: docRef.id, bundleChunks: bundleMeta ? bundleMeta.chunks : 0 });
  }
);
