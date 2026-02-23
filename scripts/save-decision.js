#!/usr/bin/env node
"use strict";

/**
 * Simple helper to save a decision. Designed to be trivially easy for AI tools to call.
 *
 * Usage: node save-decision.js <category> <decision> [rationale]
 *   category: architecture|constraint|convention|testing|scope|unresolved
 *   decision: one clear sentence
 *   rationale: why this was decided (optional, defaults to "Inferred from conversation")
 *
 * Example: node save-decision.js architecture "Use PostgreSQL for data layer" "Best fit for relational data with JSON support"
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const [, , category, decision, rationale] = process.argv;

if (!category || !decision) {
  console.error('Usage: node save-decision.js <category> "<decision>" ["rationale"]');
  process.exit(1);
}

// Find project root
let dir = process.cwd();
while (dir) {
  if (fs.existsSync(path.join(dir, ".ai-memory"))) break;
  const parent = path.dirname(dir);
  if (parent === dir) { console.error("No .ai-memory/ found"); process.exit(1); }
  dir = parent;
}

const entry = {
  id: crypto.randomBytes(4).toString("hex"),
  ts: new Date().toISOString(),
  category: category,
  decision: decision,
  rationale: rationale || "Inferred from conversation",
  confidence: 1.0,
  source: "auto",
};

fs.appendFileSync(path.join(dir, ".ai-memory", "decisions.jsonl"), JSON.stringify(entry) + "\n", "utf-8");

// Sync
try {
  require(path.join(__dirname, "sync-tools.js")).syncAll(dir);
} catch { /* sync is best-effort */ }

const statsModule = require(path.join(__dirname, "stats.js"));
const G = "\x1b[92m";
const R = "\x1b[0m";
console.log(`${G}\u2713 [project-memory] Saved decision: [${category}] "${decision}"${R}`);
console.log(statsModule.formatSavingsInsight("~150 tokens, ~15 sec saved per future session", dir));
