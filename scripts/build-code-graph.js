#!/usr/bin/env node
"use strict";

/**
 * Build or incrementally update the code graph for a project.
 *
 * Usage:
 *   node build-code-graph.js [projectRoot]           — full build
 *   node build-code-graph.js [projectRoot] --diff     — incremental (git diff)
 *   node build-code-graph.js [projectRoot] --stats    — show stats only
 *
 * Walks source files respecting .gitignore, parses with tree-sitter,
 * stores nodes + edges in SQLite (.ai-memory/code-graph.db).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const codeGraph = require(path.join(__dirname, "code-graph.js"));
const codeParser = require(path.join(__dirname, "code-parser.js"));

const SUPPORTED_EXTS = new Set(Object.keys(codeParser.EXT_TO_LANG));

// Directories to always skip
const SKIP_DIRS = new Set([
  "node_modules", ".git", "bin", "obj", "dist", "build", ".vs",
  "__pycache__", ".mypy_cache", ".pytest_cache", "venv", "env",
  ".ai-memory", ".next", ".nuxt", "coverage", ".cache",
  "packages", "TestResults",
]);

// ── File Discovery ──

function walkFiles(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, files);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function fileHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── Git Diff for Incremental ──

function getChangedFiles(projectRoot) {
  try {
    const output = execSync("git diff --name-only HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    if (!output) return [];
    return output.split("\n").map(f => path.resolve(projectRoot, f)).filter(f => {
      const ext = path.extname(f).toLowerCase();
      return SUPPORTED_EXTS.has(ext) && fs.existsSync(f);
    });
  } catch {
    return null; // git not available or not a repo
  }
}

// ── Build ──

async function fullBuild(projectRoot) {
  const t0 = Date.now();
  await codeParser.init();
  const db = codeGraph.open(projectRoot);

  const files = walkFiles(projectRoot);
  console.log(`Found ${files.length} source files to index`);

  let processed = 0;
  let totalNodes = 0;
  let totalEdges = 0;
  let errors = 0;

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const hash = fileHash(content);

      // Skip if unchanged (compare with stored hash)
      const existingHash = codeGraph.getFileHash(db, filePath.replace(/\\/g, "/"));
      if (existingHash === hash) {
        processed++;
        continue;
      }

      const { nodes, edges } = await codeParser.parseFile(filePath, content);

      // Add file hash to the File node
      for (const node of nodes) {
        if (node.kind === "File") node.file_hash = hash;
      }

      codeGraph.replaceFile(db, filePath.replace(/\\/g, "/"), nodes, edges);
      totalNodes += nodes.length;
      totalEdges += edges.length;
      processed++;

      if (processed % 100 === 0) {
        process.stdout.write(`  ${processed}/${files.length} files...\r`);
      }
    } catch (err) {
      errors++;
      if (errors <= 5) console.error(`  Error parsing ${path.basename(filePath)}: ${err.message}`);
    }
  }

  const stats = codeGraph.getStats(db);
  codeGraph.close(db);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nCode graph built in ${elapsed}s`);
  console.log(`  Files: ${stats.files} | Nodes: ${stats.nodes} | Edges: ${stats.edges}`);
  console.log(`  By kind:`, JSON.stringify(stats.nodesByKind));
  console.log(`  Edge types:`, JSON.stringify(stats.edgesByKind));
  if (errors > 0) console.log(`  Errors: ${errors}`);
  return stats;
}

async function incrementalUpdate(projectRoot, changedFiles) {
  const t0 = Date.now();
  await codeParser.init();
  const db = codeGraph.open(projectRoot);

  let totalNodes = 0;
  let totalEdges = 0;

  for (const filePath of changedFiles) {
    try {
      if (!fs.existsSync(filePath)) {
        // File deleted — remove from graph
        codeGraph.replaceFile(db, filePath.replace(/\\/g, "/"), [], []);
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const hash = fileHash(content);
      const existingHash = codeGraph.getFileHash(db, filePath.replace(/\\/g, "/"));
      if (existingHash === hash) continue;

      const { nodes, edges } = await codeParser.parseFile(filePath, content);
      for (const node of nodes) {
        if (node.kind === "File") node.file_hash = hash;
      }

      codeGraph.replaceFile(db, filePath.replace(/\\/g, "/"), nodes, edges);
      totalNodes += nodes.length;
      totalEdges += edges.length;
    } catch (err) {
      console.error(`  Error updating ${path.basename(filePath)}: ${err.message}`);
    }
  }

  const stats = codeGraph.getStats(db);
  codeGraph.close(db);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Incremental update in ${elapsed}s — ${changedFiles.length} files, +${totalNodes} nodes, +${totalEdges} edges`);
  return stats;
}

async function showStats(projectRoot) {
  const db = codeGraph.open(projectRoot);
  const stats = codeGraph.getStats(db);
  codeGraph.close(db);
  console.log(JSON.stringify(stats, null, 2));
  return stats;
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const projectRoot = args.find(a => !a.startsWith("--")) || process.cwd();
  const isDiff = args.includes("--diff");
  const isStats = args.includes("--stats");

  if (!fs.existsSync(path.join(projectRoot, ".ai-memory"))) {
    console.error(`No .ai-memory/ found in ${projectRoot}`);
    process.exit(1);
  }

  if (isStats) {
    await showStats(projectRoot);
    return;
  }

  if (isDiff) {
    const changed = getChangedFiles(projectRoot);
    if (changed === null) {
      console.log("Git not available, falling back to full build");
      await fullBuild(projectRoot);
    } else if (changed.length === 0) {
      console.log("No changed source files detected");
    } else {
      console.log(`${changed.length} changed files detected`);
      await incrementalUpdate(projectRoot, changed);
    }
  } else {
    await fullBuild(projectRoot);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error("Build failed:", err.message);
    process.exit(1);
  });
}

module.exports = { fullBuild, incrementalUpdate, showStats, getChangedFiles };
