#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const shared = require(path.join(__dirname, "..", "shared.js"));

function test_tool_history_append(testRoot) {
  shared.appendToolHistory(testRoot, { tool: "Bash", command: "ls -la", success: true });
  shared.appendToolHistory(testRoot, { tool: "Bash", command: "cat foo", success: false });
  const history = shared.readToolHistory(testRoot);
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].command, "ls -la");
  assert.strictEqual(history[1].success, false);
}

function test_tool_history_clear(testRoot) {
  shared.appendToolHistory(testRoot, { tool: "Bash", command: "test", success: true });
  shared.clearToolHistory(testRoot);
  assert.strictEqual(shared.readToolHistory(testRoot).length, 0);
}

function test_tool_history_has_timestamp(testRoot) {
  shared.appendToolHistory(testRoot, { tool: "Bash", command: "echo hi", success: true });
  const h = shared.readToolHistory(testRoot);
  assert.ok(h[0].ts, "Should have timestamp");
}

function test_detect_retry_success(testRoot) {
  // Simulate: command fails, then similar command succeeds
  shared.appendToolHistory(testRoot, { tool: "Bash", command: "grep -r 'pattern' src/", exitCode: 1, success: false });
  shared.appendToolHistory(testRoot, { tool: "Bash", command: "echo filler", exitCode: 0, success: true });

  const successCall = { tool: "Bash", command: "grep -rn 'pattern' src/components/", description: "Search for pattern in components", exitCode: 0, success: true };
  const capture = shared.detectAutoCapture(testRoot, successCall);

  assert.notStrictEqual(capture, null, "Should detect retry success pattern");
  assert.ok(capture.tags.includes("retry-success"), "Should tag as retry-success");
  assert.ok(capture.tags.includes("auto-capture"), "Should tag as auto-capture");
  assert.ok(capture.finding.includes("grep"), "Finding should contain the command");
}

function test_no_capture_on_first_success(testRoot) {
  // Single successful command — no prior failure
  shared.appendToolHistory(testRoot, { tool: "Bash", command: "echo hello", exitCode: 0, success: true });
  const capture = shared.detectAutoCapture(testRoot, { tool: "Bash", command: "echo world", success: true });
  assert.strictEqual(capture, null, "Should not capture without prior failure");
}

function test_no_capture_on_failure(testRoot) {
  shared.appendToolHistory(testRoot, { tool: "Bash", command: "bad command", exitCode: 1, success: false });
  const capture = shared.detectAutoCapture(testRoot, { tool: "Bash", command: "still bad", success: false });
  assert.strictEqual(capture, null, "Should not capture failures");
}

function test_detect_exploration_success(testRoot) {
  // Simulate 3+ exploratory commands then a success
  shared.appendToolHistory(testRoot, { tool: "Bash", command: "grep foo", exploratory: true, success: false });
  shared.appendToolHistory(testRoot, { tool: "Bash", command: "grep bar", exploratory: true, success: false });
  shared.appendToolHistory(testRoot, { tool: "Bash", command: "grep baz", exploratory: true, success: true });

  const capture = shared.detectAutoCapture(testRoot, { tool: "Bash", command: "grep 'correct pattern' src/", exploratory: true, success: true, description: "Found the right pattern" });

  assert.notStrictEqual(capture, null, "Should detect exploration success");
  assert.ok(capture.tags.includes("script"), "Should tag as script");
  assert.ok(capture.tags.includes("discovery"), "Should tag as discovery");
}

function test_extract_command_tags(testRoot) {
  const tags = shared.extractCommandTags("node scripts/build.js --env production");
  assert.ok(tags.includes("node"), "Should detect node");
  assert.ok(tags.includes("js"), "Should detect .js extension");
}

function test_auto_save_capture(testRoot) {
  const capture = {
    topic: "Working command: grep pattern in src",
    tags: ["auto-capture", "bash", "grep"],
    finding: "Command: grep -rn 'pattern' src/",
    source_tool: "auto-capture",
  };
  const saved = shared.autoSaveCapture(testRoot, capture);
  assert.ok(saved.id, "Should have id");
  assert.strictEqual(saved.confidence, 0.7);
  assert.strictEqual(saved.source_tool, "auto-capture");

  const entries = shared.readJsonl(path.join(testRoot, ".ai-memory", "research.jsonl"));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].topic, capture.topic);
}

module.exports = {
  test_tool_history_append,
  test_tool_history_clear,
  test_tool_history_has_timestamp,
  test_detect_retry_success,
  test_no_capture_on_first_success,
  test_no_capture_on_failure,
  test_detect_exploration_success,
  test_extract_command_tags,
  test_auto_save_capture,
};
