import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { JACK_SYSTEM_PROMPT } from "./jack-prompt.js";
import { JACK_TOOLS } from "./jack-tools.js";

initializeApp();

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

const MODEL = "claude-sonnet-5";
const MAX_OUTPUT_TOKENS = 2000;

// Hard monthly spend ceiling for the whole app, in USD.
const MONTHLY_BUDGET_USD = 10;

// claude-sonnet-5 list prices, USD per million tokens. Intro pricing
// (through 2026-08-31) is lower; using list prices keeps the cap conservative.
const PRICE = {
  input: 3.0,
  output: 15.0,
  cacheWrite: 3.75,
  cacheRead: 0.3,
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
];
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function usageCostUsd(u: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): number {
  return (
    (u.input_tokens * PRICE.input +
      u.output_tokens * PRICE.output +
      (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead) /
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
    // can overshoot by a request or two — acceptable slop against a $10 cap.
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

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
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

    const cost = usageCostUsd(response.usage);
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
