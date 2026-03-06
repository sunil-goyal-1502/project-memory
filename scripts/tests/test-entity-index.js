#!/usr/bin/env node
"use strict";

const assert = require("assert");
const path = require("path");
const shared = require(path.join(__dirname, "..", "shared.js"));

function test_entity_index_created(testRoot) {
  shared.addToEntityIndex(testRoot, ["DomService", "XPathDocument"], "abc123");
  const index = shared.readEntityIndex(testRoot);
  assert.deepStrictEqual(index["domservice"], ["abc123"]);
  assert.deepStrictEqual(index["xpathdocument"], ["abc123"]);
}

function test_entity_index_appended(testRoot) {
  shared.addToEntityIndex(testRoot, ["DomService"], "abc123");
  shared.addToEntityIndex(testRoot, ["DomService", "FlaUI"], "def456");
  const index = shared.readEntityIndex(testRoot);
  assert.deepStrictEqual(index["domservice"], ["abc123", "def456"]);
  assert.deepStrictEqual(index["flaui"], ["def456"]);
}

function test_entity_index_no_duplicates(testRoot) {
  shared.addToEntityIndex(testRoot, ["DomService"], "abc123");
  shared.addToEntityIndex(testRoot, ["DomService"], "abc123");
  assert.deepStrictEqual(shared.readEntityIndex(testRoot)["domservice"], ["abc123"]);
}

function test_entity_index_case_insensitive(testRoot) {
  shared.addToEntityIndex(testRoot, ["DomService"], "abc123");
  const index = shared.readEntityIndex(testRoot);
  assert.deepStrictEqual(index["domservice"], ["abc123"]);
  assert.strictEqual(index["DomService"], undefined);
}

function test_entity_index_empty(testRoot) {
  shared.addToEntityIndex(testRoot, [], "abc123");
  assert.deepStrictEqual(shared.readEntityIndex(testRoot), {});
}

function test_entity_index_read_nonexistent(testRoot) {
  assert.deepStrictEqual(shared.readEntityIndex(testRoot), {});
}

function test_entity_lookup_from_query(testRoot) {
  shared.addToEntityIndex(testRoot, ["DomService", "XPathDocument"], "f1");
  shared.addToEntityIndex(testRoot, ["FlaUI", "DomService"], "f2");
  const index = shared.readEntityIndex(testRoot);
  const hitIds = new Set();
  for (const token of shared.tokenize("DomService verification")) {
    for (const id of (index[token] || [])) hitIds.add(id);
  }
  assert.ok(hitIds.has("f1"));
  assert.ok(hitIds.has("f2"));
}

function test_entity_missing_lookup(testRoot) {
  shared.addToEntityIndex(testRoot, ["DomService"], "f1");
  assert.deepStrictEqual(shared.readEntityIndex(testRoot)["nonexistent"] || [], []);
}

module.exports = {
  test_entity_index_created, test_entity_index_appended, test_entity_index_no_duplicates,
  test_entity_index_case_insensitive, test_entity_index_empty, test_entity_index_read_nonexistent,
  test_entity_lookup_from_query, test_entity_missing_lookup,
};
