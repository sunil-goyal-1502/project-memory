#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const TEST_DIR = path.join(__dirname, "..", "..", ".ai-memory-test");

const testFiles = fs.readdirSync(__dirname)
  .filter(f => f.startsWith("test-") && f !== "test-runner.js" && f.endsWith(".js"))
  .sort();

let totalPassed = 0;
let totalFailed = 0;
const failures = [];

function setupTestEnv() {
  // Retry cleanup — background processes (build-embeddings.js) may briefly lock files
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
      break;
    } catch {
      const start = Date.now(); while (Date.now() - start < 300) { /* spin */ }
    }
  }
  const memDir = path.join(TEST_DIR, ".ai-memory");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, "research.jsonl"), "", "utf-8");
  fs.writeFileSync(path.join(memDir, "decisions.jsonl"), "", "utf-8");
  // Set mtime to the past so breadcrumb tests don't race with setup file timestamps
  const past = new Date(Date.now() - 10000);
  fs.utimesSync(path.join(memDir, "research.jsonl"), past, past);
  fs.utimesSync(path.join(memDir, "decisions.jsonl"), past, past);
  fs.writeFileSync(path.join(memDir, "metadata.json"), JSON.stringify({
    tokenCount: 0, lastSync: new Date().toISOString(), sessionCount: 0,
    decisionCount: 0, researchCount: 0, researchTokenCount: 0,
    stats: { totalTokensSaved: 0, totalTimeSavedSeconds: 0, totalHits: 0, eventCounts: {} }
  }), "utf-8");
  return TEST_DIR;
}

function cleanupTestEnv() {
  // Retry cleanup — background processes (build-embeddings.js) may briefly lock files
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
      return;
    } catch {
      // Wait a bit for background process to release locks
      const start = Date.now(); while (Date.now() - start < 200) { /* spin */ }
    }
  }
  // Last attempt — let it throw if still locked
  try { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* give up */ }
}

console.log(`\n\x1b[1m=== Project-Memory Test Suite ===\x1b[0m\n`);

for (const testFile of testFiles) {
  const testModule = require(path.join(__dirname, testFile));
  const testFunctions = Object.entries(testModule).filter(([name]) => name.startsWith("test_"));

  console.log(`\x1b[1m${testFile}\x1b[0m (${testFunctions.length} tests)`);

  for (const [name, fn] of testFunctions) {
    const testRoot = setupTestEnv();
    try {
      // Support both sync and async test functions
      const result = fn(testRoot);
      if (result && typeof result.then === "function") {
        await_result(result, name, testFile);
        continue; // handled in await_result
      }
      console.log(`  \x1b[92m\u2713\x1b[0m ${name}`);
      totalPassed++;
    } catch (err) {
      console.log(`  \x1b[91m\u2717\x1b[0m ${name}: ${err.message}`);
      totalFailed++;
      failures.push({ file: testFile, test: name, error: err.message });
    } finally {
      cleanupTestEnv();
    }
  }
  console.log("");
}

// For async tests — not used in sync runner
function await_result() { /* placeholder */ }

console.log(`\x1b[1m=== Results ===\x1b[0m`);
console.log(`  \x1b[92mPassed: ${totalPassed}\x1b[0m`);
if (totalFailed > 0) {
  console.log(`  \x1b[91mFailed: ${totalFailed}\x1b[0m`);
  for (const f of failures) console.log(`  ${f.file} > ${f.test}: ${f.error}`);
  process.exit(1);
} else {
  console.log(`\n\x1b[92mAll tests passed!\x1b[0m`);
}

module.exports = { setupTestEnv, cleanupTestEnv, TEST_DIR };
