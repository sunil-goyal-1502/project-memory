#!/usr/bin/env node
"use strict";

/**
 * router/classifier-test.js
 *
 * Smoke test for the hybrid classifier. Phase E adds the full suite; this is
 * a quick `node router/classifier-test.js` runner used during Phase B dev.
 *
 * Goals validated here:
 *   1. Pipeline end-to-end works.
 *   2. Heuristics-only path latency < 1ms (avg).
 *   3. Semantic-cached path latency < 50ms (avg, after warmup).
 *   4. Agreement rate ≥ 80% on hand-labeled prompts.
 *   5. tools.length > 1 always returns 'complex'.
 */

const { classify } = require("./classifier.js");
const heuristics   = require("./heuristics.js");
const semantic     = require("./semantic-classifier.js");

// `complex` and `simple` map to the labels the classifier emits;
// `medium` is also acceptable as a "soft complex" answer for borderline cases.
const CASES = [
  // ---------- clearly simple ----------
  { label: "simple", req: { messages: [{ role: "user", content: "Hi!" }], params: {} } },
  { label: "simple", req: { messages: [{ role: "user", content: "What is 2 + 2?" }], params: {} } },
  { label: "simple", req: { messages: [{ role: "user", content: "Translate 'hello' to French." }], params: {} } },
  { label: "simple", req: { messages: [{ role: "user", content: "Convert this JSON to YAML: {\"a\": 1}" }], params: {} } },

  // ---------- clearly complex ----------
  {
    label: "complex",
    req: {
      messages: [{
        role: "user",
        content: "Refactor this authentication module to use dependency injection and explain the trade-offs across src/auth/login.ts, src/auth/refresh.ts and src/auth/middleware.ts.",
      }],
      params: { max_tokens: 4096 },
    },
  },
  {
    label: "complex",
    req: {
      messages: [{
        role: "user",
        content: "Architect a multi-region active-active deployment with automatic failover. Walk me through every failure mode in detail.",
      }],
      params: {},
    },
  },
  {
    // diff/patch marker → forced complex
    label: "complex",
    req: {
      messages: [{
        role: "user",
        content: "Apply this patch and explain the regression risk:\n\ndiff --git a/foo.js b/foo.js\n--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n-old\n+new\n",
      }],
      params: {},
    },
  },
  {
    // Multi-tool → guardrail forced complex
    label: "complex",
    req: {
      messages: [{ role: "user", content: "Help me with this." }],
      tools: [
        { name: "read_file",  description: "Read a file", input_schema: { type: "object" } },
        { name: "write_file", description: "Write a file", input_schema: { type: "object" } },
      ],
      params: {},
    },
  },

  // ---------- embedding short-circuit ----------
  {
    label: "simple",
    req: {
      kind: "embedding",
      messages: [{ role: "user", content: "anything goes here" }],
      params: {},
    },
  },

  // ---------- borderline (medium acceptable) ----------
  {
    label: "complex", // we'd accept medium too — see acceptability rule below
    req: {
      messages: [{
        role: "user",
        content: "Walk me through how Promises work in JavaScript and analyze why this code logs in an unexpected order.\n\n```js\nPromise.resolve().then(() => console.log('a'));\nconsole.log('b');\n```",
      }],
      params: { temperature: 0.8 },
    },
  },
];

// Acceptable matches: heuristic-only "medium" is a soft complex; treat it
// as agreeing with a "complex" label.
function isAgreement(predicted, label) {
  if (predicted === label) return true;
  if (label === "complex" && predicted === "medium") return true;
  return false;
}

async function timeAvg(fn, n) {
  // discard first call (warmup), then time n
  await fn();
  let total = 0n;
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    total += process.hrtime.bigint() - t0;
  }
  return Number(total) / n / 1e6; // ms
}

(async function main() {
  console.log("=== Phase B classifier smoke test ===\n");

  // ---- 1. Run all cases ----
  let agree = 0;
  let toolCheckPassed = false;
  for (let i = 0; i < CASES.length; i++) {
    const { label, req } = CASES[i];
    const r = await classify(req);
    const ok = isAgreement(r.complexity, label);
    if (ok) agree++;

    const preview = (req.messages?.[0]?.content || "").slice(0, 60).replace(/\n/g, " ");
    console.log(
      `[${ok ? "OK " : "FAIL"}] case ${i + 1}: label=${label.padEnd(7)} ` +
      `pred=${r.complexity.padEnd(7)} h=${r.heuristicScore.toFixed(2)}` +
      (r.semanticScore ? ` sem=${r.semanticScore.category}(${r.semanticScore.scores.complex})` : "") +
      `  | "${preview}${preview.length === 60 ? "…" : ""}"`
    );
    for (const reason of r.reasons) console.log(`        · ${reason}`);

    // Verify tools.length > 1 guardrail
    if (Array.isArray(req.tools) && req.tools.length > 1) {
      toolCheckPassed = (r.complexity === "complex");
    }
  }
  const agreementRate = agree / CASES.length;
  console.log(`\nAgreement: ${agree}/${CASES.length} = ${(agreementRate * 100).toFixed(1)}%`);
  console.log(`tools.length > 1 → complex: ${toolCheckPassed ? "OK" : "FAIL"}`);

  // ---- 2. Latency: heuristics-only path ----
  // Pick a request that won't hit borderline so semantic isn't invoked.
  const fastReq = {
    messages: [{ role: "user", content: "What is the capital of France?" }],
    params: {},
  };
  const heurMs = await timeAvg(() => classify(fastReq), 200);
  console.log(`\nHeuristics-only avg latency: ${heurMs.toFixed(3)} ms (target <1ms)`);

  // ---- 3. Latency: semantic-cached path ----
  // Force semantic by crafting a borderline-scoring request.
  // Heuristic in band (0.4–0.7): moderate prompt + mild signals.
  const borderReq = {
    messages: [{
      role: "user",
      content: "Walk me through how Promises work in JavaScript and analyze why this code logs in an unexpected order.\n\n```js\nPromise.resolve().then(() => console.log('a'));\nconsole.log('b');\n```",
    }],
    params: { temperature: 0.8 },
  };
  // Warmup the semantic path (downloads model on very first run; can take seconds).
  console.log("\nWarming up semantic classifier (first call may take seconds)…");
  const warmStart = Date.now();
  await semantic.warmup();
  console.log(`Semantic warmup: ${Date.now() - warmStart} ms`);

  const semMs = await timeAvg(() => classify(borderReq), 20);
  console.log(`Semantic-cached avg latency: ${semMs.toFixed(2)} ms (target <50ms)`);

  // ---- Summary / exit code ----
  const failures = [];
  if (agreementRate < 0.8)        failures.push(`agreement ${(agreementRate * 100).toFixed(1)}% < 80%`);
  if (!toolCheckPassed)           failures.push("tools>1 guardrail did not force complex");
  if (heurMs > 1)                 failures.push(`heuristics latency ${heurMs.toFixed(3)} ms > 1 ms`);
  if (semMs > 50)                 failures.push(`semantic latency ${semMs.toFixed(2)} ms > 50 ms`);

  console.log("\n=== Summary ===");
  if (failures.length === 0) {
    console.log("✅ All Phase B smoke checks passed.");
    process.exit(0);
  } else {
    console.log("❌ Failures:");
    for (const f of failures) console.log("  · " + f);
    process.exit(1);
  }
})().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(2);
});
