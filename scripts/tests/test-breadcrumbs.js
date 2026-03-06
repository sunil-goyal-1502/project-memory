#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const shared = require(path.join(__dirname, "..", "shared.js"));

function test_breadcrumb_append(testRoot) {
  shared.appendBreadcrumb(testRoot, { tool: "Task", subagent: "Explore", prompt: "understand FlaUI" });
  assert.strictEqual(shared.readExplorationLog(testRoot).length, 1);
}

function test_breadcrumb_format(testRoot) {
  shared.appendBreadcrumb(testRoot, { tool: "WebSearch", query: "BM25 pure JS" });
  const log = shared.readExplorationLog(testRoot);
  assert.ok(log[0].ts);
  assert.strictEqual(log[0].tool, "WebSearch");
  assert.strictEqual(log[0].saved, false);
}

function test_breadcrumb_multiple(testRoot) {
  shared.appendBreadcrumb(testRoot, { tool: "Task", prompt: "first" });
  shared.appendBreadcrumb(testRoot, { tool: "WebSearch", query: "second" });
  shared.appendBreadcrumb(testRoot, { tool: "Bash", prompt: "grep" });
  assert.strictEqual(shared.readExplorationLog(testRoot).length, 3);
}

function test_breadcrumb_clear(testRoot) {
  shared.appendBreadcrumb(testRoot, { tool: "Task", prompt: "test" });
  shared.clearExplorationLog(testRoot);
  assert.strictEqual(shared.readExplorationLog(testRoot).length, 0);
}

function test_unsaved_all(testRoot) {
  shared.appendBreadcrumb(testRoot, { tool: "Task", prompt: "explore 1" });
  shared.appendBreadcrumb(testRoot, { tool: "WebSearch", query: "search 1" });
  assert.strictEqual(shared.getUnsavedBreadcrumbs(testRoot).length, 2);
}

function test_unsaved_after_save(testRoot) {
  shared.appendBreadcrumb(testRoot, { tool: "Task", prompt: "explore old" });
  const researchPath = path.join(testRoot, ".ai-memory", "research.jsonl");
  fs.writeFileSync(researchPath, '{"id":"x","ts":"' + new Date().toISOString() + '"}\n', "utf-8");
  const start = Date.now(); while (Date.now() - start < 50) { /* spin */ }
  shared.appendBreadcrumb(testRoot, { tool: "Task", prompt: "explore new" });
  const unsaved = shared.getUnsavedBreadcrumbs(testRoot);
  assert.strictEqual(unsaved.length, 1);
  assert.strictEqual(unsaved[0].prompt, "explore new");
}

function test_unsaved_empty(testRoot) {
  assert.deepStrictEqual(shared.getUnsavedBreadcrumbs(testRoot), []);
}

module.exports = {
  test_breadcrumb_append, test_breadcrumb_format, test_breadcrumb_multiple,
  test_breadcrumb_clear, test_unsaved_all, test_unsaved_after_save, test_unsaved_empty,
};
