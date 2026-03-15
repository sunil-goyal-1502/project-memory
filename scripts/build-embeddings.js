#!/usr/bin/env node
"use strict";

/**
 * Build/update embeddings for research and decision entries.
 * Idempotent — skips entries that already have embeddings.
 *
 * Usage:
 *   node build-embeddings.js [projectRoot]   — embed entries for one project
 *   node build-embeddings.js --all           — embed entries across ALL projects
 *
 * Each project stores its own embeddings.json in its .ai-memory/ directory.
 * Auto-triggered by save-research.js (single project) and session-start.js.
 */

const fs = require("fs");
const path = require("path");
const { resolveProjectRoot, readJsonl, readExplorationsIndex, scanHomeForProjects, findProjectRoot } = require(path.join(__dirname, "shared.js"));
const { generateEmbedding, readEmbeddings, writeEmbeddings } = require(path.join(__dirname, "embeddings.js"));

const G = "\x1b[92m";
const Y = "\x1b[93m";
const R = "\x1b[0m";

function discoverAllProjects() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return [];
  const projects = new Set();
  function scanDir(dir, depth) {
    if (depth > 5) return;
    try {
      const memDir = path.join(dir, ".ai-memory");
      if (fs.existsSync(memDir) && fs.existsSync(path.join(memDir, "research.jsonl"))) {
        projects.add(dir);
      }
      if (depth < 5) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
            scanDir(path.join(dir, entry.name), depth + 1);
          }
        }
      }
    } catch { /* permission errors */ }
  }
  scanDir(home, 0);
  return Array.from(projects);
}

async function buildForProject(projectRoot) {
  const memDir = path.join(projectRoot, ".ai-memory");
  const projectName = path.basename(projectRoot);

  const research = readJsonl(path.join(memDir, "research.jsonl"));
  const decisions = readJsonl(path.join(memDir, "decisions.jsonl"));

  // Include exploration index entries (query + entities + tags as embeddable text)
  const explorations = readExplorationsIndex(projectRoot).map(e => ({
    id: e.id,
    topic: e.query || "",
    tags: e.tags || [],
    finding: [e.query || "", (e.files || []).join(" "), (e.entities || []).join(" ")].join(" "),
  }));

  const allEntries = [...research, ...decisions, ...explorations];

  if (allEntries.length === 0) return 0;

  const existing = readEmbeddings(projectRoot);
  const missing = allEntries.filter(e => !existing[e.id]);

  if (missing.length === 0) return 0;

  console.log(`${G}[${projectName}] Building embeddings for ${missing.length} new entries (${allEntries.length} total)...${R}`);

  for (let i = 0; i < missing.length; i++) {
    const entry = missing[i];
    const text = [
      entry.topic || "",
      (entry.tags || []).join(" "),
      entry.finding || entry.decision || "",
    ].join(" ").trim();

    try {
      const embedding = await generateEmbedding(text);
      existing[entry.id] = embedding;
      if ((i + 1) % 10 === 0 || i === missing.length - 1) {
        console.log(`${G}  [${projectName}] ${i + 1}/${missing.length} embedded${R}`);
      }
    } catch (err) {
      console.error(`${Y}  [${projectName}] Failed to embed ${entry.id}: ${err.message}${R}`);
    }
  }

  // Clean up orphaned embeddings
  const validIds = new Set(allEntries.map(e => e.id));
  for (const id of Object.keys(existing)) {
    if (!validIds.has(id)) delete existing[id];
  }

  writeEmbeddings(projectRoot, existing);
  console.log(`${G}[${projectName}] Embeddings saved: ${Object.keys(existing).length} entries${R}`);

  // Backfill graph triples for entries without them
  try {
    const configMod = require(path.join(__dirname, "config.js"));
    const config = configMod.readConfig(projectRoot);
    if (config.graph?.enabled) {
      const graphMod = require(path.join(__dirname, "graph.js"));
      const graphAdded = graphMod.backfillGraph(projectRoot);
      if (graphAdded > 0) {
        console.log(`${G}[${projectName}] Graph: ${graphAdded} triples added${R}`);
      }
    }
  } catch { /* graph is optional */ }

  return missing.length;
}

async function main() {
  const args = process.argv.slice(2);
  const isGlobal = args.includes("--all");

  let projects;
  if (isGlobal) {
    projects = discoverAllProjects();
    console.log(`${G}Discovered ${projects.length} projects with .ai-memory${R}`);
  } else {
    const root = args.find(a => !a.startsWith("-")) || resolveProjectRoot();
    projects = [root];
  }

  let totalBuilt = 0;
  for (const p of projects) {
    try {
      totalBuilt += await buildForProject(p);
    } catch (err) {
      console.error(`${Y}[${path.basename(p)}] Error: ${err.message}${R}`);
    }
  }

  if (totalBuilt === 0) {
    console.log(`${G}All entries across ${projects.length} project(s) already have embeddings.${R}`);
  } else {
    console.log(`${G}Done. Built ${totalBuilt} new embeddings across ${projects.length} project(s).${R}`);
  }
}

main().catch(err => {
  console.error(`Embedding build failed: ${err.message}`);
  process.exit(1);
});
