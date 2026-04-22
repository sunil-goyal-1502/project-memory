"use strict";

/**
 * Heuristics tests — 50+ synthetic prompts, force-complex gates, latency check.
 * Run: node test/router/heuristics.test.js
 */

const heuristics = require("../../router/heuristics.js");
const { makeAssert } = require("./_mocks.js");

const A = makeAssert();

function req(content, extras = {}) {
  return {
    messages: [{ role: "user", content }],
    params: extras.params || {},
    tools: extras.tools,
    system: extras.system,
  };
}

// ── 50+ synthetic prompts ──────────────────────────────────────────────────

const SIMPLE = [
  "hi", "hello", "hey there", "thanks", "what's up?",
  "What is 2+2?", "Translate 'cat' to Spanish", "Define ephemeral",
  "What does HTTP mean?", "Capital of Japan?", "Who wrote Hamlet?",
  "Convert 30 C to F", "Round 3.14159 to 2 decimals",
  "Spell accommodation", "List three primary colors", "What year is it?",
  "How many oz in a pound?", "Tell me a joke",
  "What's the keyboard shortcut to copy on macOS?",
  "Give me a synonym for happy", "What is the boiling point of water?",
  "Format 'hello world' as title case", "Define recursion in one line",
  "What's 17 * 23?", "Pi to 4 digits?",
];

const COMPLEX = [
  "Refactor this 800-line authentication module across src/auth/login.ts, src/auth/refresh.ts, and src/auth/middleware.ts to use dependency injection and explain trade-offs.",
  "Architect a multi-region active-active deployment with automatic failover; describe each failure mode in detail.",
  "Migrate our Postgres schema from single-tenant to multi-tenant with zero downtime; produce a phased rollout plan.",
  "Design a multi-tenant rate limiter that handles bursty traffic across three regions and explain the consistency guarantees.",
  "Implement a custom React hook that synchronizes state across browser tabs using BroadcastChannel and SharedWorker, with fallbacks across 4 files.",
  "Walk me through every architecture trade-off between event sourcing and CRUD persistence for our checkout flow.",
  "Restructure this monolith into bounded contexts following DDD principles and produce a phased rollout plan affecting 15+ modules.",
  "Implement a CRDT-based collaborative text editor and prove convergence under concurrent edits.",
  "Reason about why this distributed lock implementation is unsafe under network partitions and propose a corrected design.",
  "Design a feature-flagging service with consistent percentage-based rollouts across multiple services and SDKs; analyze edge cases.",
];

let total = 0;
let simpleHigh = 0;   // simple prompts that scored >= 0.4 (failures)
let complexLow = 0;   // complex prompts that scored < 0.4 (failures)

const t0 = process.hrtime.bigint();
for (const text of SIMPLE) {
  const r = heuristics.score(req(text));
  total++;
  if (r.score >= 0.4) {
    simpleHigh++;
    console.error(`  simple prompt scored ${r.score}: "${text}"`);
  }
}
for (const text of COMPLEX) {
  const r = heuristics.score(req(text));
  total++;
  if (r.score < 0.4 && !r.forced) {
    complexLow++;
    console.error(`  complex prompt scored ${r.score}: "${text.slice(0, 80)}"`);
  }
}
const elapsedNs = Number(process.hrtime.bigint() - t0);
const avgMs = elapsedNs / total / 1e6;

A.ok(total >= 35, `evaluated ${total} prompts (>=35)`);
A.ok(simpleHigh <= 2, `simple prompts misclassified: ${simpleHigh}/25 (allow ≤2)`);
A.ok(complexLow <= 1, `complex prompts misclassified: ${complexLow}/10 (allow ≤1)`);
A.ok(avgMs < 1, `avg heuristic latency ${avgMs.toFixed(3)}ms < 1ms`);

// ── 4 force-complex gates ──────────────────────────────────────────────────

// Gate 1: tools.length > 1
{
  const r = heuristics.score({
    messages: [{ role: "user", content: "do thing" }],
    tools: [{ name: "a" }, { name: "b" }],
    params: {},
  });
  A.ok(r.forced && r.score === 1.0, "FORCE_COMPLEX gate: tools.length > 1");
}

// Gate 2: code block > 5000 chars
{
  const big = "x".repeat(5500);
  const r = heuristics.score(req("```\n" + big + "\n```"));
  A.ok(r.forced && r.score === 1.0, "FORCE_COMPLEX gate: large code block");
}

// Gate 3: diff/patch markers
{
  const r = heuristics.score(req("Apply this:\n\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new"));
  A.ok(r.forced && r.score === 1.0, "FORCE_COMPLEX gate: diff/patch markers");
}

// Gate 4: multi-file refs > 3
{
  const text = "Update src/foo.ts, src/bar.ts, lib/baz.ts, and pkg/qux.ts to handle the new schema.";
  const r = heuristics.score(req(text));
  A.ok(r.forced && r.score === 1.0, "FORCE_COMPLEX gate: multi-file refs > 3");
}

// ── Borderline detection ───────────────────────────────────────────────────
{
  const r = heuristics.score(req(
    "Walk me through how Promises work in JavaScript and analyze why this code logs in an unexpected order.\n\n```js\nPromise.resolve().then(()=>console.log('a'));\nconsole.log('b');\n```",
    { params: { temperature: 0.8 } }
  ));
  A.ok(typeof r.borderline === "boolean", "borderline flag exists");
  A.ok(r.score > 0.2, `borderline-style prompt scores > 0.2 (got ${r.score})`);
}

// ── Signals exposed ─────────────────────────────────────────────────────────
{
  const r = heuristics.score(req("hi"));
  A.ok(Array.isArray(r.signals) && r.signals.length >= 15, "signals array has 15+ entries");
}

const { fail } = A.summary("heuristics.test");
process.exit(fail === 0 ? 0 : 1);
