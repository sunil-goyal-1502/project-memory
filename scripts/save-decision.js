#!/usr/bin/env node
"use strict";

/**
 * Save a project decision to .ai-memory/decisions.jsonl.
 *
 * Usage: node save-decision.js <category> <decision> [rationale]
 */

const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { resolveProjectRoot, appendJsonl } = require(path.join(__dirname, "shared.js"));

const [, , category, decision, rationale] = process.argv;

if (!category || !decision) {
  console.error('Usage: node save-decision.js <category> "<decision>" ["rationale"]');
  process.exit(1);
}

const dir = resolveProjectRoot();

const entry = {
  id: crypto.randomBytes(4).toString("hex"),
  ts: new Date().toISOString(),
  category,
  decision,
  rationale: rationale || "Inferred from conversation",
  confidence: 1.0,
  source: "auto",
};

appendJsonl(path.join(dir, ".ai-memory", "decisions.jsonl"), entry);

// Sync
try {
  require(path.join(__dirname, "sync-tools.js")).syncAll(dir);
} catch { /* sync is best-effort */ }

// Auto-build embedding in background
try {
  const buildScript = path.join(__dirname, "build-embeddings.js");
  const child = spawn(process.execPath, [buildScript, dir], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.unref();
} catch { /* best-effort */ }

const statsModule = require(path.join(__dirname, "stats.js"));
const G = "\x1b[92m";
const R = "\x1b[0m";
console.log(`${G}\u2713 [project-memory] Saved decision: [${category}] "${decision}"${R}`);
console.log(statsModule.formatSavingsInsight("~150 tokens, ~15 sec saved per future session", dir));
