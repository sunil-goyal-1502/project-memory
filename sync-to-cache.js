#!/usr/bin/env node
"use strict";

/**
 * Sync source repo files to all plugin cache directories.
 * Run this after making changes to hook scripts or plugin code.
 *
 * Usage: node sync-to-cache.js
 */

const fs = require("fs");
const path = require("path");

const sourceDir = __dirname;

// Read marketplace + plugin name from .claude-plugin metadata so cache path
// stays in sync if the marketplace is renamed (e.g. when forking).
function readPluginMeta() {
  try {
    const mp = JSON.parse(fs.readFileSync(path.join(sourceDir, ".claude-plugin", "marketplace.json"), "utf8"));
    const pl = JSON.parse(fs.readFileSync(path.join(sourceDir, ".claude-plugin", "plugin.json"), "utf8"));
    return { marketplaceName: mp.name, pluginName: pl.name };
  } catch (e) {
    console.error("Failed to read .claude-plugin metadata:", e.message);
    process.exit(1);
  }
}
const { marketplaceName, pluginName } = readPluginMeta();
const homeDir = process.env.USERPROFILE || process.env.HOME;
if (!homeDir) {
  console.error("Cannot determine home directory (USERPROFILE/HOME not set)");
  process.exit(1);
}
const cacheBase = path.join(homeDir, ".claude", "plugins", "cache", marketplaceName, pluginName);

const filesToSync = [
  "hooks/scripts/pre-tool-use.js",
  "hooks/scripts/post-tool-use.js",
  "hooks/scripts/session-start.js",
  "hooks/scripts/session-stop.js",
  "hooks/hooks.json",
  "scripts/shared.js",
  "scripts/check-memory.js",
  "scripts/save-research.js",
  "scripts/save-decision.js",
  "scripts/embeddings.js",
  "scripts/build-embeddings.js",
  "scripts/dashboard.js",
  "scripts/session-summary.js",
  "scripts/stats.js",
  "scripts/sync-tools.js",
  "scripts/condense-transcript.js",
  "scripts/recompute-stats.js",
  "scripts/check-coverage.js",
  ".claude-plugin/plugin.json",
];

if (!fs.existsSync(cacheBase)) {
  console.log("No cache directory found at", cacheBase);
  process.exit(0);
}

const versions = fs.readdirSync(cacheBase).filter(d =>
  fs.statSync(path.join(cacheBase, d)).isDirectory()
);

let synced = 0;
for (const ver of versions) {
  const cacheDir = path.join(cacheBase, ver);
  for (const file of filesToSync) {
    const src = path.join(sourceDir, file);
    const dst = path.join(cacheDir, file);
    if (!fs.existsSync(src)) continue;
    // Ensure target directory exists
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    synced++;
  }
  console.log(`  Synced ${ver}`);
}

console.log(`Done: ${synced} files synced across ${versions.length} cache versions.`);
console.log("Restart active sessions to pick up changes.");
