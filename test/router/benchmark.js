"use strict";

/**
 * benchmark.js — synthetic 1000-prompt benchmark.
 *
 * Runs heuristics + classifier (semantic stubbed) on a mixed corpus and
 * reports:
 *   • % routed to local Ollama in aggressive mode
 *   • avg / p50 / p95 / p99 classifier latency (ms)
 *
 * Targets:
 *   • ≥ 40% local routing
 *   • <  5ms avg classifier latency
 *
 * Output: human-readable table + JSON line on the last line for machine
 * consumption. Exit code 0 if all targets met, 1 otherwise.
 */

const path = require("path");

// ── Stub semantic classifier (no ONNX during bench) ────────────────────────
const semPath = require.resolve("../../router/semantic-classifier.js");
require.cache[semPath] = {
  id: semPath, filename: semPath, loaded: true,
  exports: {
    classify: async (text) => {
      const t = (text || "").toLowerCase();
      if (/refactor|architect|design|migrate|debug/.test(t)) {
        return { category: "complex", confidence: 0.8, scores: {} };
      }
      if (/explain|summarize|describe|how|why/.test(t)) {
        return { category: "medium", confidence: 0.7, scores: {} };
      }
      return { category: "simple", confidence: 0.85, scores: {} };
    },
    warmup: async () => {},
  },
};

// Sandbox the DBs so the benchmark never touches the user's real router dir.
const fs = require("fs");
const os = require("os");
const SBX = path.join(os.tmpdir(), `ai-router-bench-${process.pid}-${Date.now()}`);
fs.mkdirSync(SBX, { recursive: true });
process.env.ROUTER_DB_DIR = SBX;
process.env.ROUTER_MODE = "aggressive";

const config = require("../../router/config.js");
config.refreshRouterDir();
config.reloadConfig();
const heuristics = require("../../router/heuristics.js");
const classifier = require("../../router/classifier.js");
const router = require("../../router/router.js");

// ── Synthetic corpus ───────────────────────────────────────────────────────
const greetings = [
  "hi", "hello", "hey there", "good morning", "good evening",
  "thanks", "thank you", "ok", "yes", "no",
];
const summarizers = [
  "summarize this paragraph: the quick brown fox jumps over the lazy dog",
  "tldr: long article about climate change effects on agriculture",
  "give me the gist of the third world war scenario in fiction",
  "bullet-point summary of the meeting transcript above",
  "shorten this email reply to two sentences",
];
const codeExplain = [
  "what does this Python list comprehension do: [x*2 for x in range(10)]",
  "explain the JavaScript event loop in simple terms",
  "how does a binary search tree work?",
  "why is my for loop off by one in C++?",
  "what's the time complexity of merge sort?",
];
const refactorAsks = [
  "refactor this React component to use hooks",
  "redesign the authentication module to use JWT",
  "migrate this MongoDB schema to Postgres",
  "debug why the worker thread hangs after 5 minutes",
  "rearchitect the queue to support multi-tenant isolation",
];
const multiStep = [
  "first parse the CSV, then group by region, then compute totals, then write results to S3",
  "read the file, validate the JSON, transform fields, push to Kafka",
  "set up a CI pipeline: lint, build, test, deploy to staging",
  "create user, send verification email, wait for click, activate account",
  "fetch from API, dedupe, enrich with second API, persist to db",
];

function buildCorpus(n) {
  const buckets = [greetings, summarizers, codeExplain, refactorAsks, multiStep];
  const out = [];
  for (let i = 0; i < n; i++) {
    const bucket = buckets[i % buckets.length];
    out.push(bucket[Math.floor(Math.random() * bucket.length)] + " #" + i);
  }
  return out;
}

(async () => {
  const N = 1000;
  const corpus = buildCorpus(N);

  let local = 0, cloud = 0;
  const latencies = new Array(N);

  // Warmup
  for (let i = 0; i < 10; i++) {
    const cr = { messages: [{ role: "user", content: corpus[i] }], system: null, tools: null, params: { model: "claude-3-5-sonnet-20241022" } };
    await classifier.classify(cr);
  }

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const text = corpus[i];
    const cr = {
      messages: [{ role: "user", content: text }],
      system: null, tools: null,
      params: { model: "claude-3-5-sonnet-20241022" },
      format: "anthropic",
    };

    const tStart = process.hrtime.bigint();
    const cls = await classifier.classify(cr);
    const tEnd = process.hrtime.bigint();
    latencies[i] = Number(tEnd - tStart) / 1e6;

    const decision = router.decide(cr, cls, "chat", "anthropic");
    if (decision.provider === "ollama") local++;
    else cloud++;
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Stats
  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);
  const avg = sum / N;
  const p50 = latencies[Math.floor(N * 0.50)];
  const p95 = latencies[Math.floor(N * 0.95)];
  const p99 = latencies[Math.floor(N * 0.99)];
  const localPct = (local / N) * 100;

  // ── Report ─────────────────────────────────────────────────────────────
  console.log("");
  console.log("=== AI Router benchmark (n=" + N + ", aggressive mode) ===");
  console.log("");
  console.log("  routing");
  console.log(`    local  : ${local.toString().padStart(4)} (${localPct.toFixed(1)}%)`);
  console.log(`    cloud  : ${cloud.toString().padStart(4)} (${(100 - localPct).toFixed(1)}%)`);
  console.log("");
  console.log("  classifier latency (ms)");
  console.log(`    avg    : ${avg.toFixed(3)}`);
  console.log(`    p50    : ${p50.toFixed(3)}`);
  console.log(`    p95    : ${p95.toFixed(3)}`);
  console.log(`    p99    : ${p99.toFixed(3)}`);
  console.log(`    total  : ${totalMs.toFixed(0)}ms wall`);
  console.log("");

  const targets = {
    local_pct_target: 40,
    avg_latency_target_ms: 5,
  };
  const localOk = localPct >= targets.local_pct_target;
  const latencyOk = avg < targets.avg_latency_target_ms;
  console.log("  targets");
  console.log(`    local ≥ ${targets.local_pct_target}%       : ${localOk ? "PASS" : "FAIL"} (${localPct.toFixed(1)}%)`);
  console.log(`    avg  <  ${targets.avg_latency_target_ms}ms  : ${latencyOk ? "PASS" : "FAIL"} (${avg.toFixed(3)}ms)`);
  console.log("");

  // Cleanup
  try { require("../../router/stats.js").close(); } catch {}
  try { require("../../router/prompt-cache.js").close(); } catch {}
  try { fs.rmSync(SBX, { recursive: true, force: true }); } catch {}

  const result = {
    n: N, local, cloud, local_pct: localPct,
    latency_ms: { avg, p50, p95, p99 },
    targets, pass: localOk && latencyOk,
  };
  console.log(JSON.stringify(result));

  process.exitCode = (localOk && latencyOk) ? 0 : 1;
})().catch((e) => {
  console.error("benchmark crashed:", e);
  process.exitCode = 2;
});
