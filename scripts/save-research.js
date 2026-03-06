#!/usr/bin/env node
"use strict";

/**
 * Save a research finding to .ai-memory/research.jsonl.
 *
 * Usage: node save-research.js <topic> <tags> <finding> [staleness] [--entities "A,B,C"] [--related "id1,id2"]
 *   topic: short noun phrase (5-15 words) — ONE searchable fact
 *   tags: comma-separated keywords
 *   finding: the research finding text (1-2 sentences ideal)
 *   staleness: stable|versioned|volatile (optional, defaults to "stable")
 *   --entities: comma-separated file/class/method names for entity index (optional)
 *   --related: comma-separated IDs of related findings (optional)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { resolveProjectRoot, readJsonl, appendJsonl, addToEntityIndex, findSimilarEntry } = require(path.join(__dirname, "shared.js"));

// ── Parse CLI args: extract named flags before positional args ──
const rawArgs = process.argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--entities" && i + 1 < rawArgs.length) {
    flags.entities = rawArgs[++i];
  } else if (rawArgs[i] === "--related" && i + 1 < rawArgs.length) {
    flags.related = rawArgs[++i];
  } else {
    positional.push(rawArgs[i]);
  }
}

const [topic, tags, finding, staleness] = positional;

if (!topic || !tags || !finding) {
  console.error('Usage: node save-research.js "<topic>" "tag1,tag2" "<finding>" [staleness] [--entities "A,B"] [--related "id1"]');
  process.exit(1);
}

const dir = resolveProjectRoot();
const researchPath = path.join(dir, ".ai-memory", "research.jsonl");
const parsedTags = tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
const parsedEntities = flags.entities
  ? flags.entities.split(",").map(e => e.trim()).filter(Boolean)
  : [];
const parsedRelated = flags.related
  ? flags.related.split(",").map(r => r.trim()).filter(Boolean)
  : [];

// ── Dedup check ──
const statsModule = require(path.join(__dirname, "stats.js"));
const G = "\x1b[92m";
const Y = "\x1b[93m";
const R = "\x1b[0m";

const existingEntries = readJsonl(researchPath);
const similar = findSimilarEntry(existingEntries, topic, parsedTags);
if (similar) {
  console.log(`${Y}\u26A0 Similar finding exists: "${similar.topic}" (id: ${similar.id})${R}`);
  console.log(`${Y}  Saved anyway. Run /project-memory:research-compact to merge duplicates.${R}`);
}

// ── Build and save entry ──
const entry = {
  id: crypto.randomBytes(4).toString("hex"),
  ts: new Date().toISOString(),
  topic,
  tags: parsedTags,
  finding,
  entities: parsedEntities.map(e => e.toLowerCase()),
  related_to: parsedRelated,
  source_tool: "auto",
  source_context: "Auto-captured during session",
  confidence: 0.8,
  staleness: staleness || "stable",
  supersedes: null,
  version_anchored: null,
};

appendJsonl(researchPath, entry);

// ── Update entity index ──
if (parsedEntities.length > 0) {
  addToEntityIndex(dir, parsedEntities, entry.id);
}

// ── Sync to CLAUDE.md / Copilot / Cursor ──
try {
  require(path.join(__dirname, "sync-tools.js")).syncAll(dir);
} catch { /* sync is best-effort */ }

// ── Auto-build embedding in background ──
try {
  const buildScript = path.join(__dirname, "build-embeddings.js");
  const child = spawn(process.execPath, [buildScript, dir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
} catch { /* embedding build is best-effort */ }

console.log(`${G}\u2713 [project-memory] Saved research: "${topic}" [${entry.staleness}]${R}`);
if (parsedEntities.length > 0) {
  console.log(`${G}  Entities indexed: ${parsedEntities.join(", ")}${R}`);
}
if (parsedRelated.length > 0) {
  console.log(`${G}  Related to: ${parsedRelated.join(", ")}${R}`);
}
console.log(statsModule.formatSavingsInsight("~1K tokens, ~2 min saved per future lookup", dir));
