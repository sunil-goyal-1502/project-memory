#!/usr/bin/env node
"use strict";

/**
 * Migrate "Script: ..." entries from research.jsonl to scripts.jsonl.
 *
 * 1. Reads all entries from research.jsonl
 * 2. Identifies Script: entries (topic starts with "Script:" or source_tool="auto-capture" + tags include "script")
 * 3. Parameterizes each command
 * 4. Deduplicates against existing scripts.jsonl
 * 5. Writes to scripts.jsonl
 * 6. Removes migrated entries from research.jsonl
 * 7. Syncs CLAUDE.md
 *
 * Usage: node migrate-scripts.js [--dry-run]
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const shared = require(path.join(__dirname, "shared.js"));

const isDryRun = process.argv.includes("--dry-run");
const dir = shared.resolveProjectRoot();

const researchPath = path.join(dir, ".ai-memory", "research.jsonl");
const research = shared.readJsonl(researchPath);

// Identify script entries
const scriptEntries = [];
const keepEntries = [];

for (const entry of research) {
  const isScript = (
    (entry.topic || "").startsWith("Script:") ||
    (entry.source_tool === "auto-capture" && (entry.tags || []).includes("script"))
  );
  if (isScript) {
    scriptEntries.push(entry);
  } else {
    keepEntries.push(entry);
  }
}

console.log(`Found ${scriptEntries.length} script entries to migrate (${keepEntries.length} research entries to keep)`);

if (isDryRun) {
  for (const s of scriptEntries.slice(0, 20)) {
    console.log(`  \u2192 ${(s.topic || s.finding || "").slice(0, 100)}`);
  }
  if (scriptEntries.length > 20) {
    console.log(`  ... and ${scriptEntries.length - 20} more`);
  }
  console.log("\n--dry-run: No changes made.");
  process.exit(0);
}

if (scriptEntries.length === 0) {
  console.log("No script entries to migrate.");
  process.exit(0);
}

// Backup research.jsonl
const backupPath = researchPath + ".bak";
fs.copyFileSync(researchPath, backupPath);
console.log(`Backup created: ${backupPath}`);

// Migrate each script entry
const existingScripts = shared.readScripts(dir);
let migrated = 0;
let deduped = 0;
let skipped = 0;

for (const entry of scriptEntries) {
  // Extract command from finding (format: "Description: command" or just command)
  const finding = entry.finding || "";
  const colonIdx = finding.indexOf(": ");
  const command = colonIdx > 0 ? finding.substring(colonIdx + 2) : finding;
  const description = colonIdx > 0 ? finding.substring(0, colonIdx) : (entry.topic || "").replace(/^Script:\s*/, "");

  if (!command || command.length < 10 || !shared.isReusableScript(command)) {
    skipped++;
    continue;
  }

  const { template, parameters } = shared.parameterizeCommand(command, description);

  // Dedup against existing + already migrated
  const duplicate = shared.findDuplicateScript(existingScripts, template);
  if (duplicate) {
    // Bump usage count of existing
    shared.updateScript(dir, duplicate.id, {
      usage_count: (duplicate.usage_count || 1) + 1,
      last_used: new Date().toISOString(),
    });
    deduped++;
    continue;
  }

  const scriptEntry = {
    id: "scr_" + crypto.randomBytes(4).toString("hex"),
    ts: entry.ts || new Date().toISOString(),
    name: description.slice(0, 80) || "Migrated script",
    description: description,
    tags: (entry.tags || []).filter(t => !["auto-capture", "script"].includes(t)),
    template,
    parameters,
    original_command: command,
    usage_count: 1,
    last_used: entry.ts || new Date().toISOString(),
    source: "migrated",
  };

  shared.appendScript(dir, scriptEntry);
  existingScripts.push(scriptEntry); // for dedup within migration batch
  migrated++;
}

// Rewrite research.jsonl without script entries
fs.writeFileSync(researchPath, keepEntries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");

// Sync CLAUDE.md
try { require(path.join(__dirname, "sync-tools.js")).syncAll(dir); } catch (err) {
  console.error(`CLAUDE.md sync failed: ${err.message}`);
}

// Rebuild embeddings in background
try {
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, [path.join(__dirname, "build-embeddings.js"), dir], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.unref();
} catch {}

console.log(`\nMigration complete:`);
console.log(`  \u2713 ${migrated} scripts migrated to scripts.jsonl`);
console.log(`  \u2713 ${deduped} duplicates merged (usage count bumped)`);
if (skipped > 0) console.log(`  \u2022 ${skipped} entries skipped (too short)`);
console.log(`  \u2713 ${keepEntries.length} research entries preserved`);
console.log(`  \u2713 ${scriptEntries.length} script entries removed from research.jsonl`);
console.log(`  \u2022 Backup: ${backupPath}`);
