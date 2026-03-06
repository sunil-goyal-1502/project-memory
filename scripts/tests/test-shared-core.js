#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const shared = require(path.join(__dirname, "..", "shared.js"));

function test_tokenize_basic(testRoot) {
  assert.deepStrictEqual(shared.tokenize("DomService.cs uses XPath"), ["domservice", "cs", "uses", "xpath"]);
}

function test_tokenize_empty(testRoot) {
  assert.deepStrictEqual(shared.tokenize(""), []);
  assert.deepStrictEqual(shared.tokenize(null), []);
}

function test_tokenize_punctuation(testRoot) {
  assert.deepStrictEqual(shared.tokenize("foo(bar, baz) => 'result'"), ["foo", "bar", "baz", "result"]);
}

function test_readJsonl_empty_file(testRoot) {
  assert.deepStrictEqual(shared.readJsonl(path.join(testRoot, ".ai-memory", "research.jsonl")), []);
}

function test_readJsonl_with_entries(testRoot) {
  const fp = path.join(testRoot, ".ai-memory", "research.jsonl");
  fs.writeFileSync(fp, '{"id":"a","topic":"test"}\n{"id":"b","topic":"test2"}\n', "utf-8");
  const result = shared.readJsonl(fp);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].id, "a");
}

function test_readJsonl_skips_malformed(testRoot) {
  const fp = path.join(testRoot, ".ai-memory", "research.jsonl");
  fs.writeFileSync(fp, '{"id":"a"}\nINVALID\n{"id":"b"}\n', "utf-8");
  assert.strictEqual(shared.readJsonl(fp).length, 2);
}

function test_appendJsonl(testRoot) {
  const fp = path.join(testRoot, ".ai-memory", "research.jsonl");
  shared.appendJsonl(fp, { id: "x", topic: "appended" });
  const result = shared.readJsonl(fp);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].topic, "appended");
}

function test_findSimilarEntry_no_match(testRoot) {
  const existing = [{ topic: "FlaUI automation", tags: ["flaui", "automation"] }];
  assert.strictEqual(shared.findSimilarEntry(existing, "different", ["unrelated", "tags"]), null);
}

function test_findSimilarEntry_match(testRoot) {
  const existing = [{ id: "abc", topic: "FlaUI automation testing", tags: ["flaui", "automation", "testing"] }];
  const result = shared.findSimilarEntry(existing, "FlaUI automation", ["flaui", "automation"]);
  assert.strictEqual(result.id, "abc");
}

function test_findSimilarEntry_needs_two_tags(testRoot) {
  const existing = [{ id: "abc", topic: "FlaUI automation testing", tags: ["flaui", "automation", "testing"] }];
  assert.strictEqual(shared.findSimilarEntry(existing, "FlaUI something", ["flaui", "unrelated"]), null);
}

module.exports = {
  test_tokenize_basic, test_tokenize_empty, test_tokenize_punctuation,
  test_readJsonl_empty_file, test_readJsonl_with_entries, test_readJsonl_skips_malformed,
  test_appendJsonl,
  test_findSimilarEntry_no_match, test_findSimilarEntry_match, test_findSimilarEntry_needs_two_tags,
};
