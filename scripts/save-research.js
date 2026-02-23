#!/usr/bin/env node
"use strict";

/**
 * Simple helper to save a research finding. Designed to be trivially easy for AI tools to call.
 *
 * Usage: node save-research.js <topic> <tags> <finding> [staleness]
 *   topic: short noun phrase (5-15 words)
 *   tags: comma-separated keywords
 *   finding: the research finding text
 *   staleness: stable|versioned|volatile (optional, defaults to "stable")
 *
 * Example: node save-research.js "Axios interceptor execution order" "axios,interceptors,http" "Axios response interceptors run in LIFO order" stable
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const [, , topic, tags, finding, staleness] = process.argv;

if (!topic || !tags || !finding) {
  console.error('Usage: node save-research.js "<topic>" "tag1,tag2" "<finding>" [staleness]');
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
  topic: topic,
  tags: tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean),
  finding: finding,
  source_tool: "auto",
  source_context: "Auto-captured during session",
  confidence: 0.8,
  staleness: staleness || "stable",
  supersedes: null,
  version_anchored: null,
};

fs.appendFileSync(path.join(dir, ".ai-memory", "research.jsonl"), JSON.stringify(entry) + "\n", "utf-8");

// Sync
try {
  require(path.join(__dirname, "sync-tools.js")).syncAll(dir);
} catch { /* sync is best-effort */ }

const statsModule = require(path.join(__dirname, "stats.js"));
const G = "\x1b[92m";
const R = "\x1b[0m";
console.log(`${G}\u2713 [project-memory] Saved research: "${topic}" [${entry.staleness}]${R}`);
console.log(statsModule.formatSavingsInsight("~1K tokens, ~2 min saved per future lookup", dir));
