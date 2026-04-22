"use strict";

/**
 * run-all.js — sequential test runner for test/router/.
 *
 * Spawns each *.test.js as a child process so each gets a clean module
 * state (env vars, require.cache, sandboxed DB dirs all start fresh). The
 * benchmark is run last and is optional (skip with --no-bench).
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HERE = __dirname;
const NO_BENCH = process.argv.includes("--no-bench");
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

// ── Discover *.test.js files ────────────────────────────────────────────────
const testFiles = fs.readdirSync(HERE)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

// Run order: put fast/pure tests first, integration last.
const ORDER = [
  "heuristics.test.js",
  "classifier.test.js",
  "adapter.test.js",
  "router-table.test.js",
  "router.test.js",
  "circuit-breaker.test.js",
  "prompt-cache.test.js",
  "streaming.test.js",
  "passthrough.test.js",
  "fallback.test.js",
  "count-tokens.test.js",
  "embeddings.test.js",
  "catch-all.test.js",
  "auth-leak.test.js",
  "integration.test.js",
];
const ordered = ORDER.filter((f) => testFiles.includes(f));
const extras = testFiles.filter((f) => !ORDER.includes(f));
const queue = ordered.concat(extras);

// ── Run helper ─────────────────────────────────────────────────────────────
function runOne(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, file)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("close", (code) => {
      const ms = Date.now() - t0;
      // Extract the trailing "X passed, Y failed" line if present.
      const summaryMatch = out.match(/(\w[\w\-]*\.test):\s+(\d+)\s+passed,\s+(\d+)\s+failed/);
      const passed = summaryMatch ? parseInt(summaryMatch[2], 10) : null;
      const failed = summaryMatch ? parseInt(summaryMatch[3], 10) : null;
      resolve({ file, code, ms, out, err, passed, failed });
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  const results = [];
  let totalPass = 0, totalFail = 0;
  let suiteFailed = 0;

  console.log(`Running ${queue.length} test file(s) sequentially …\n`);

  for (const f of queue) {
    process.stdout.write(`  ▶ ${f.padEnd(28)} … `);
    const r = await runOne(f);
    results.push(r);
    const status = r.code === 0 ? "OK  " : "FAIL";
    const counts = r.passed != null
      ? `${r.passed} pass / ${r.failed} fail`
      : "(no summary)";
    console.log(`${status}  ${counts.padEnd(20)}  ${r.ms}ms`);
    if (VERBOSE || r.code !== 0) {
      const lines = (r.out + r.err).split(/\r?\n/);
      for (const ln of lines) if (ln) console.log("       " + ln);
    }
    if (r.passed != null) totalPass += r.passed;
    if (r.failed != null) totalFail += r.failed;
    if (r.code !== 0) suiteFailed++;
  }

  console.log("");
  console.log("─".repeat(60));
  console.log(`  total : ${totalPass} pass / ${totalFail} fail across ${queue.length} files`);
  console.log(`  suites failed : ${suiteFailed}`);
  console.log("─".repeat(60));

  // ── Optional benchmark ──────────────────────────────────────────────────
  let benchOk = true;
  if (!NO_BENCH && fs.existsSync(path.join(HERE, "benchmark.js"))) {
    console.log("\nRunning benchmark.js …");
    const r = await runOne("benchmark.js");
    process.stdout.write(r.out);
    if (r.err) process.stderr.write(r.err);
    benchOk = r.code === 0;
    console.log(`\nbenchmark exit: ${r.code} (${r.ms}ms)`);
  }

  process.exitCode = (suiteFailed === 0 && benchOk) ? 0 : 1;
})().catch((e) => {
  console.error("run-all crashed:", e);
  process.exitCode = 2;
});
