#!/usr/bin/env node
"use strict";

/**
 * Remove a research or decision entry by ID.
 *
 * Usage: node undo-save.js <entry-id>
 *
 * Searches both research.jsonl and decisions.jsonl.
 * Removes the entry, syncs CLAUDE.md, invalidates BM25 cache.
 */

const fs = require("fs");
const path = require("path");
const shared = require(path.join(__dirname, "shared.js"));

const entryId = process.argv[2];
if (!entryId) {
  console.error("Usage: node undo-save.js <entry-id>");
  console.error("  Find IDs via: node check-memory.js \"keywords\"");
  process.exit(1);
}

const dir = shared.resolveProjectRoot();
const researchPath = path.join(dir, ".ai-memory", "research.jsonl");
const decisionsPath = path.join(dir, ".ai-memory", "decisions.jsonl");
const scriptsPath = path.join(dir, ".ai-memory", "scripts.jsonl");

let found = false;
let removedTopic = "";

// Search and remove from research.jsonl
const research = shared.readJsonl(researchPath);
const filteredResearch = research.filter(e => {
  if (e.id === entryId) {
    found = true;
    removedTopic = e.topic || e.finding?.slice(0, 60) || "unknown";
    return false;
  }
  return true;
});

if (found) {
  fs.writeFileSync(researchPath, filteredResearch.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  console.log(`\x1b[92m\u2713 Removed research entry: "${removedTopic}" (id: ${entryId})\x1b[0m`);
}

// Search decisions.jsonl
if (!found) {
  const decisions = shared.readJsonl(decisionsPath);
  const filteredDecisions = decisions.filter(e => {
    if (e.id === entryId) {
      found = true;
      removedTopic = e.decision || "unknown";
      return false;
    }
    return true;
  });

  if (found) {
    fs.writeFileSync(decisionsPath, filteredDecisions.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    console.log(`\x1b[92m\u2713 Removed decision: "${removedTopic}" (id: ${entryId})\x1b[0m`);
  }
}

// Search scripts.jsonl
if (!found) {
  const scripts = shared.readScripts(dir);
  const filteredScripts = scripts.filter(e => {
    if (e.id === entryId) {
      found = true;
      removedTopic = e.name || "unknown";
      return false;
    }
    return true;
  });

  if (found) {
    fs.writeFileSync(scriptsPath, filteredScripts.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    console.log(`\x1b[92m\u2713 Removed script: "${removedTopic}" (id: ${entryId})\x1b[0m`);
  }
}

if (!found) {
  console.error(`\x1b[91mEntry not found: ${entryId}\x1b[0m`);
  console.error("Search for entries: node check-memory.js \"keywords\"");
  process.exit(1);
}

// Invalidate BM25 cache and sync CLAUDE.md
try { shared.invalidateBM25Cache(dir); } catch {}
try { require(path.join(__dirname, "sync-tools.js")).syncAll(dir); } catch {}

// Rebuild embeddings in background
try {
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, [path.join(__dirname, "build-embeddings.js"), dir], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.unref();
} catch {}

console.log(`\x1b[92m  CLAUDE.md synced, BM25 cache invalidated.\x1b[0m`);
