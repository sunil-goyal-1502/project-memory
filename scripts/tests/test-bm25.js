#!/usr/bin/env node
"use strict";

const assert = require("assert");
const path = require("path");
const shared = require(path.join(__dirname, "..", "shared.js"));

function test_bm25_empty_store(testRoot) {
  const index = shared.buildBM25Index([]);
  const results = shared.bm25Score("test", index);
  assert.deepStrictEqual(results, []);
}

function test_bm25_single_entry(testRoot) {
  const entries = [{ id: "a", topic: "DomService XPath", tags: ["xml"], finding: "verification" }];
  const results = shared.bm25Score("DomService xpath", shared.buildBM25Index(entries));
  assert.strictEqual(results.length, 1);
  assert.ok(results[0].score > 0);
}

function test_bm25_ranking(testRoot) {
  const entries = [
    { id: "r1", topic: "DomService XPath", tags: ["xpath", "xml"], finding: "XPath evaluation" },
    { id: "r2", topic: "XPath verification", tags: ["xpath", "verification"], finding: "UI verification" },
    { id: "r3", topic: "VerificationDetail XPath", tags: ["xpath"], finding: "XPath syntax" },
    { id: "u1", topic: "FlaUI button click", tags: ["flaui"], finding: "Click element" },
    { id: "u2", topic: "Git push", tags: ["git"], finding: "Push to remote" },
  ];
  const results = shared.bm25Score("xpath verification", shared.buildBM25Index(entries));
  const top3 = results.slice(0, 3).map(r => r.docId);
  assert.ok(top3.includes("r1"));
  assert.ok(top3.includes("r2"));
  assert.ok(top3.includes("r3"));
}

function test_bm25_no_match(testRoot) {
  const entries = [{ id: "a", topic: "FlaUI", tags: ["flaui"], finding: "Click" }];
  assert.strictEqual(shared.bm25Score("database sql", shared.buildBM25Index(entries)).length, 0);
}

function test_bm25_includes_entities(testRoot) {
  const entries = [
    { id: "a", topic: "Services", tags: ["svc"], finding: "A finding", entities: ["domservice"] },
    { id: "b", topic: "Other", tags: ["other"], finding: "Another" },
  ];
  const results = shared.bm25Score("domservice", shared.buildBM25Index(entries));
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].docId, "a");
}

module.exports = {
  test_bm25_empty_store, test_bm25_single_entry, test_bm25_ranking,
  test_bm25_no_match, test_bm25_includes_entities,
};
