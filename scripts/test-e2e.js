#!/usr/bin/env node
"use strict";

/**
 * End-to-end test for the project-memory plugin pipeline.
 * Tests: save → search → graph → scripts → undo → session-summary
 *
 * Usage: node test-e2e.js
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const dir = path.resolve(__dirname, "..");
const scriptsDir = __dirname;
let passed = 0;
let failed = 0;

function run(cmd) {
  return execSync(cmd, { cwd: dir, encoding: "utf-8", timeout: 30000 }).trim();
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[92m\u2713 ${name}\x1b[0m`);
  } catch (err) {
    failed++;
    console.log(`  \x1b[91m\u2717 ${name}\x1b[0m`);
    console.log(`    ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

console.log("\n\x1b[1m=== Project-Memory E2E Tests ===\x1b[0m\n");

// ── 1. Shared.js module loads ──
console.log("\x1b[96m1. Module Loading\x1b[0m");
const shared = require(path.join(scriptsDir, "shared.js"));

test("shared.js exports all hook functions", () => {
  assert(typeof shared.isExploratoryBash === "function", "isExploratoryBash missing");
  assert(typeof shared.isExploratoryTask === "function", "isExploratoryTask missing");
  assert(typeof shared.readSessionState === "function", "readSessionState missing");
  assert(typeof shared.writeSessionState === "function", "writeSessionState missing");
  assert(typeof shared.debugLog === "function", "debugLog missing");
  assert(typeof shared.resolveHookProjectRoot === "function", "resolveHookProjectRoot missing");
  assert(typeof shared.isSelfCall === "function", "isSelfCall missing");
  assert(typeof shared.buildAndCacheBM25 === "function", "buildAndCacheBM25 missing");
  assert(typeof shared.loadCachedBM25 === "function", "loadCachedBM25 missing");
  assert(typeof shared.groupScriptsByTemplate === "function", "groupScriptsByTemplate missing");
  assert(typeof shared.isReusableScript === "function", "isReusableScript missing");
});

test("graph.js exports cache functions", () => {
  const graph = require(path.join(scriptsDir, "graph.js"));
  assert(typeof graph.buildAndCacheAdjacency === "function", "buildAndCacheAdjacency missing");
  assert(typeof graph.loadCachedAdjacency === "function", "loadCachedAdjacency missing");
  assert(typeof graph.expandFromEntitiesCached === "function", "expandFromEntitiesCached missing");
  assert(typeof graph.classifyEntityType === "function", "classifyEntityType missing");
  assert(typeof graph.extractTypedEntities === "function", "extractTypedEntities missing");
});

// ── 2. Save Research ──
console.log("\n\x1b[96m2. Save Research Pipeline\x1b[0m");
const testId = "e2e_" + Date.now();

test("save-research.js creates entry", () => {
  const out = run(`node "${scriptsDir}/save-research.js" "E2E test entry ${testId}" "e2e,test" "This is an automated test entry for the E2E pipeline validation ${testId}"`);
  assert(out.includes("Saved research"), `Expected 'Saved research' in output: ${out}`);
});

test("entry appears in research.jsonl", () => {
  const research = shared.readJsonl(path.join(dir, ".ai-memory", "research.jsonl"));
  const found = research.find(r => r.topic && r.topic.includes(testId));
  assert(found, `Entry with ${testId} not found in research.jsonl`);
});

test("BM25 cache was invalidated", () => {
  const cachePath = path.join(dir, ".ai-memory", ".bm25-cache.json");
  // After save-research, cache should be deleted
  assert(!fs.existsSync(cachePath), "BM25 cache should be invalidated after save");
});

// ── 3. Search (check-memory) ──
console.log("\n\x1b[96m3. Search Pipeline\x1b[0m");

test("check-memory.js finds the saved entry", () => {
  const out = run(`node "${scriptsDir}/check-memory.js" "E2E test entry ${testId}"`);
  assert(out.includes(testId), `check-memory output should contain ${testId}`);
});

// ── 4. BM25 Cache ──
console.log("\n\x1b[96m4. BM25 Caching\x1b[0m");

test("buildAndCacheBM25 creates cache file", () => {
  shared.buildAndCacheBM25(dir);
  const cachePath = path.join(dir, ".ai-memory", ".bm25-cache.json");
  assert(fs.existsSync(cachePath), "BM25 cache file should exist");
});

test("loadCachedBM25 returns valid index", () => {
  const cached = shared.loadCachedBM25(dir);
  assert(cached !== null, "Cached BM25 should not be null");
  assert(cached.invertedIndex, "Cached BM25 should have invertedIndex");
  assert(cached.N > 0, `Cached BM25 should have N>0, got ${cached.N}`);
});

test("BM25 search finds entry via cache", () => {
  const cached = shared.loadCachedBM25(dir);
  const results = shared.bm25Score(`E2E test entry ${testId}`, cached);
  assert(results.length > 0, "BM25 search should return results");
  assert(results[0].score > 0, "Top result should have positive score");
});

// ── 5. Graph ──
console.log("\n\x1b[96m5. Graph Pipeline\x1b[0m");
const graph = require(path.join(scriptsDir, "graph.js"));

test("buildAndCacheAdjacency creates cache file", () => {
  graph.buildAndCacheAdjacency(dir);
  const cachePath = path.join(dir, ".ai-memory", ".graph-adj-cache.json");
  assert(fs.existsSync(cachePath), "Graph adjacency cache should exist");
});

test("loadCachedAdjacency returns valid index", () => {
  const adj = graph.loadCachedAdjacency(dir);
  assert(adj !== null, "Cached adjacency should not be null");
  assert(typeof adj === "object", "Adjacency should be an object");
});

test("entity type classification works", () => {
  assert(graph.classifyEntityType("pre-tool-use.js") === "File", "Should classify .js as File");
  assert(graph.classifyEntityType("AppiumToolHandler") === "Class", "Should classify PascalCase as Class");
  assert(graph.classifyEntityType("curl") === "Tool", "Should classify curl as Tool");
  assert(graph.classifyEntityType("system.xml") === "Namespace", "Should classify system.xml as Namespace");
  assert(graph.classifyEntityType("microsoft.extensions") === "Namespace", "Should classify microsoft.extensions as Namespace");
});

// ── 6. Script Library ──
console.log("\n\x1b[96m6. Script Library\x1b[0m");

test("isReusableScript rejects trivial commands", () => {
  assert(!shared.isReusableScript("cat file.txt"), "cat should not be reusable");
  assert(!shared.isReusableScript("grep pattern file"), "short grep should not be reusable");
  assert(!shared.isReusableScript("ls -la /some/dir | head -20"), "ls pipe should not be reusable");
});

test("groupScriptsByTemplate groups near-duplicates", () => {
  const scripts = shared.readScripts(dir);
  if (scripts.length > 0) {
    const groups = shared.groupScriptsByTemplate(scripts);
    assert(groups.length > 0, "Should have at least 1 group");
    assert(groups.length <= scripts.length, "Groups should not exceed script count");
  }
});

// ── 7. Session State ──
console.log("\n\x1b[96m7. Session State\x1b[0m");

test("getDefaultSessionState returns valid structure", () => {
  const state = shared.getDefaultSessionState();
  assert(state.version === 1, "Version should be 1");
  assert(state.reminder, "Should have reminder");
  assert(state.taskTracker, "Should have taskTracker");
  assert(state.memoryCheck, "Should have memoryCheck");
});

test("writeSessionState + readSessionState roundtrip", () => {
  const state = shared.getDefaultSessionState();
  state.sessionId = "test-roundtrip";
  state.reminder.reminderCount = 42;
  shared.writeSessionState(dir, state);
  const loaded = shared.readSessionState(dir);
  assert(loaded.sessionId === "test-roundtrip", "sessionId should roundtrip");
  assert(loaded.reminder.reminderCount === 42, "reminderCount should roundtrip");
});

// ── 8. Intent Detection ──
console.log("\n\x1b[96m8. Intent Detection\x1b[0m");

test("isExploratoryBash detects exploratory commands", () => {
  assert(shared.isExploratoryBash({ tool_input: { command: "grep pattern file.js", description: "Search for pattern" } }), "grep should be exploratory");
  assert(shared.isExploratoryBash({ tool_input: { command: "git log --oneline", description: "Check history" } }), "git log should be exploratory");
});

test("isExploratoryBash allows operational commands", () => {
  assert(!shared.isExploratoryBash({ tool_input: { command: "npm install", description: "Install deps" } }), "npm install should be operational");
  assert(!shared.isExploratoryBash({ tool_input: { command: "git commit -m 'fix'", description: "Commit changes" } }), "git commit should be operational");
  assert(!shared.isExploratoryBash({ tool_input: { command: "mkdir /tmp/test", description: "Create directory" } }), "mkdir should be operational");
});

test("curl POST classified as operational", () => {
  assert(!shared.isExploratoryBash({ tool_input: { command: 'curl -X POST -d \'{"data":"test"}\' https://api.example.com/create', description: "Create resource" } }), "curl POST should be operational");
  assert(!shared.isExploratoryBash({ tool_input: { command: 'curl -X PATCH -H "Auth: Bearer" https://api.example.com/update', description: "Update item" } }), "curl PATCH should be operational");
});

test("isExploratoryTask detects exploration subagents", () => {
  assert(shared.isExploratoryTask({ tool_input: { subagent_type: "Explore" } }), "Explore should be exploratory");
  assert(shared.isExploratoryTask({ tool_input: { subagent_type: "Plan" } }), "Plan should be exploratory");
  assert(!shared.isExploratoryTask({ tool_input: { subagent_type: "gsd-executor" } }), "gsd-executor should not be exploratory");
});

// ── 9. Undo Save ──
console.log("\n\x1b[96m9. Undo Save\x1b[0m");

test("undo-save.js removes the test entry", () => {
  const research = shared.readJsonl(path.join(dir, ".ai-memory", "research.jsonl"));
  const entry = research.find(r => r.topic && r.topic.includes(testId));
  assert(entry, "Test entry should exist before undo");

  const out = run(`node "${scriptsDir}/undo-save.js" "${entry.id}"`);
  assert(out.includes("Removed research"), `Expected 'Removed research' in output: ${out}`);

  const afterUndo = shared.readJsonl(path.join(dir, ".ai-memory", "research.jsonl"));
  const stillThere = afterUndo.find(r => r.topic && r.topic.includes(testId));
  assert(!stillThere, "Test entry should be gone after undo");
});

// ── 10. Corruption Detection ──
console.log("\n\x1b[96m10. Corruption Detection\x1b[0m");

test("readJsonl handles corrupted lines gracefully", () => {
  const testFile = path.join(dir, ".ai-memory", ".test-corrupt.jsonl");
  fs.writeFileSync(testFile, '{"id":"good1","data":"ok"}\n{BROKEN JSON\n{"id":"good2","data":"ok"}\n', "utf-8");
  const entries = shared.readJsonl(testFile);
  assert(entries.length === 2, `Should load 2 valid entries, got ${entries.length}`);
  fs.unlinkSync(testFile);
});

// ── Summary ──
console.log(`\n\x1b[1m=== Results: ${passed} passed, ${failed} failed ===\x1b[0m`);
if (failed > 0) {
  console.log("\x1b[91mSome tests failed!\x1b[0m");
  process.exit(1);
} else {
  console.log("\x1b[92mAll tests passed!\x1b[0m");
}
