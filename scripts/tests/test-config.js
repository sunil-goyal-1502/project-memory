#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const config = require(path.join(__dirname, "..", "config.js"));

function test_default_config(testRoot) {
  const cfg = config.readConfig(testRoot);
  assert.strictEqual(cfg.searchMode, "hybrid");
  assert.strictEqual(cfg.graph.enabled, true);
  assert.strictEqual(cfg.graph.expansionDepth, 2);
  assert.strictEqual(cfg.bm25.k1, 1.2);
  assert.strictEqual(cfg.hooks.escalationThreshold, 2);
}

function test_read_write_config(testRoot) {
  const custom = { searchMode: "flat", graph: { enabled: false } };
  config.writeConfig(testRoot, custom);
  const cfg = config.readConfig(testRoot);
  assert.strictEqual(cfg.searchMode, "flat");
  assert.strictEqual(cfg.graph.enabled, false);
}

function test_merge_with_defaults(testRoot) {
  // Partial config — missing fields should come from defaults
  config.writeConfig(testRoot, { searchMode: "graph" });
  const cfg = config.readConfig(testRoot);
  assert.strictEqual(cfg.searchMode, "graph");
  assert.strictEqual(cfg.graph.enabled, true); // from defaults
  assert.strictEqual(cfg.bm25.k1, 1.2); // from defaults
  assert.strictEqual(cfg.hooks.memoryCheckTTLMinutes, 2); // from defaults
}

function test_search_mode_toggle(testRoot) {
  config.writeConfig(testRoot, { searchMode: "flat" });
  assert.strictEqual(config.readConfig(testRoot).searchMode, "flat");

  config.writeConfig(testRoot, { searchMode: "hybrid" });
  assert.strictEqual(config.readConfig(testRoot).searchMode, "hybrid");

  config.writeConfig(testRoot, { searchMode: "graph" });
  assert.strictEqual(config.readConfig(testRoot).searchMode, "graph");
}

module.exports = {
  test_default_config, test_read_write_config, test_merge_with_defaults, test_search_mode_toggle,
};
