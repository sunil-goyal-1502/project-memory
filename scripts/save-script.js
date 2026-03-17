#!/usr/bin/env node
"use strict";

/**
 * Save a reusable script to .ai-memory/scripts.jsonl with auto-parameterization.
 *
 * Usage: node save-script.js "<name>" "tag1,tag2" "<command>" [--description "desc"]
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const shared = require(path.join(__dirname, "shared.js"));

// Parse CLI args
const rawArgs = process.argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--description" && i + 1 < rawArgs.length) {
    flags.description = rawArgs[++i];
  } else {
    positional.push(rawArgs[i]);
  }
}

const [name, tags, command] = positional;

if (!name || !tags || !command) {
  console.error('Usage: node save-script.js "<name>" "tag1,tag2" "<command>" [--description "desc"]');
  process.exit(1);
}

const dir = shared.resolveProjectRoot();
const parsedTags = tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);

// Parameterize
const { template, parameters } = shared.parameterizeCommand(command, name);

// Dedup check
const existing = shared.readScripts(dir);
const duplicate = shared.findDuplicateScript(existing, template);
if (duplicate) {
  shared.updateScript(dir, duplicate.id, {
    usage_count: (duplicate.usage_count || 1) + 1,
    last_used: new Date().toISOString(),
  });
  console.log(`\x1b[93m\u26A0 Script already exists: "${duplicate.name}" (id: ${duplicate.id}) \u2014 usage count incremented.\x1b[0m`);
  process.exit(0);
}

const entry = {
  id: "scr_" + crypto.randomBytes(4).toString("hex"),
  ts: new Date().toISOString(),
  name,
  description: flags.description || "",
  tags: parsedTags,
  template,
  parameters,
  original_command: command,
  usage_count: 1,
  last_used: new Date().toISOString(),
  source: "manual",
};

shared.appendScript(dir, entry);

// Sync to CLAUDE.md
try { require(path.join(__dirname, "sync-tools.js")).syncAll(dir); } catch {}

// Background embedding build
try {
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, [path.join(__dirname, "build-embeddings.js"), dir], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.unref();
} catch {}

const paramInfo = parameters.length > 0 ? ` (${parameters.length} params: ${parameters.map(p => p.name).join(", ")})` : "";
console.log(`\x1b[92m\u2713 [project-memory] Saved script: "${name}"${paramInfo}\x1b[0m`);
