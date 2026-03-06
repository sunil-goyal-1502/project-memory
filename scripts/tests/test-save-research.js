#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const shared = require(path.join(__dirname, "..", "shared.js"));

const SAVE_SCRIPT = path.join(__dirname, "..", "save-research.js");

function runSave(testRoot, args) {
  const claudeMd = path.join(testRoot, "CLAUDE.md");
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(claudeMd, "# Test\n<!-- project-memory-autosave:start -->\n<!-- project-memory-autosave:end -->\n<!-- project-memory:start -->\n<!-- project-memory:end -->\n<!-- project-memory-research:start -->\n<!-- project-memory-research:end -->\n", "utf-8");
  }
  return execSync(`node "${SAVE_SCRIPT}" ${args}`, { cwd: testRoot, encoding: "utf-8" });
}

function test_basic_save(testRoot) {
  runSave(testRoot, '"Test topic" "tag1,tag2" "Test finding" stable');
  const entries = shared.readJsonl(path.join(testRoot, ".ai-memory", "research.jsonl"));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].topic, "Test topic");
  assert.deepStrictEqual(entries[0].tags, ["tag1", "tag2"]);
}

function test_entities_flag(testRoot) {
  runSave(testRoot, '"Topic" "t1,t2" "Finding" stable --entities "DomService,FlaUI"');
  const entries = shared.readJsonl(path.join(testRoot, ".ai-memory", "research.jsonl"));
  assert.deepStrictEqual(entries[0].entities, ["domservice", "flaui"]);
}

function test_related_flag(testRoot) {
  runSave(testRoot, '"Topic" "t1,t2" "Finding" stable --related "abc123,def456"');
  assert.deepStrictEqual(shared.readJsonl(path.join(testRoot, ".ai-memory", "research.jsonl"))[0].related_to, ["abc123", "def456"]);
}

function test_backward_compat(testRoot) {
  runSave(testRoot, '"Topic" "t1" "Finding"');
  const entry = shared.readJsonl(path.join(testRoot, ".ai-memory", "research.jsonl"))[0];
  assert.deepStrictEqual(entry.entities, []);
  assert.deepStrictEqual(entry.related_to, []);
}

function test_entity_index_created(testRoot) {
  runSave(testRoot, '"Topic" "t1" "Finding" stable --entities "MyClass,MyService"');
  const index = shared.readEntityIndex(testRoot);
  assert.ok(index["myclass"]);
  assert.ok(index["myservice"]);
}

function test_entity_index_accumulated(testRoot) {
  runSave(testRoot, '"Topic A" "t1" "Finding A" stable --entities "SharedEntity"');
  runSave(testRoot, '"Topic B" "t2" "Finding B" stable --entities "SharedEntity,Unique"');
  const index = shared.readEntityIndex(testRoot);
  assert.strictEqual(index["sharedentity"].length, 2);
  assert.strictEqual(index["unique"].length, 1);
}

function test_dedup_warning(testRoot) {
  runSave(testRoot, '"FlaUI automation testing" "flaui,automation,testing" "First"');
  const output = runSave(testRoot, '"FlaUI automation" "flaui,automation" "Similar"');
  assert.ok(output.includes("Similar finding exists"));
}

function test_dedup_saves_anyway(testRoot) {
  runSave(testRoot, '"FlaUI automation testing" "flaui,automation,testing" "First"');
  runSave(testRoot, '"FlaUI automation" "flaui,automation" "Second"');
  assert.strictEqual(shared.readJsonl(path.join(testRoot, ".ai-memory", "research.jsonl")).length, 2);
}

function test_no_dedup_for_unique(testRoot) {
  runSave(testRoot, '"Topic A" "t1,t2" "Finding A"');
  const output = runSave(testRoot, '"Different" "other,tags" "Different"');
  assert.ok(!output.includes("Similar finding exists"));
}

module.exports = {
  test_basic_save, test_entities_flag, test_related_flag, test_backward_compat,
  test_entity_index_created, test_entity_index_accumulated,
  test_dedup_warning, test_dedup_saves_anyway, test_no_dedup_for_unique,
};
