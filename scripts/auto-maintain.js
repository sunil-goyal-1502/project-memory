#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const shared = require(path.join(__dirname, "shared.js"));
const { generateEmbedding, readEmbeddings, writeEmbeddings, cosineSimilarity } = require(path.join(__dirname, "embeddings.js"));
const graph = require(path.join(__dirname, "graph.js"));

// ── Constants ──

const VOLATILE_STALE_DAYS = 14;
const VERSIONED_STALE_DAYS = 60;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.92;
const MAX_DUPLICATE_COMPARISONS = 50000; // cap O(n²) pair checks

// ── Helpers ──

function msPerDay() {
  return 24 * 60 * 60 * 1000;
}

function daysSince(isoTimestamp) {
  const then = new Date(isoTimestamp);
  if (isNaN(then.getTime())) return Infinity;
  return (Date.now() - then.getTime()) / msPerDay();
}

function memDir(projectRoot) {
  return path.join(projectRoot, ".ai-memory");
}

// ── Task 1: Detect Stale Entries ──

function detectStale(projectRoot) {
  const researchPath = path.join(memDir(projectRoot), "research.jsonl");
  const entries = shared.readJsonl(researchPath);

  const staleEntries = [];
  for (const entry of entries) {
    if (!entry.id || !entry.ts || !entry.staleness) continue;
    const age = daysSince(entry.ts);
    const isStale =
      (entry.staleness === "volatile" && age > VOLATILE_STALE_DAYS) ||
      (entry.staleness === "versioned" && age > VERSIONED_STALE_DAYS);
    if (isStale) {
      staleEntries.push({
        id: entry.id,
        topic: entry.topic || "",
        staleness: entry.staleness,
        ageDays: Math.round(age),
      });
    }
  }

  return { staleCount: staleEntries.length, entries: staleEntries };
}

// ── Task 2: Detect Duplicates ──

function detectDuplicates(projectRoot) {
  const researchPath = path.join(memDir(projectRoot), "research.jsonl");
  const entries = shared.readJsonl(researchPath);
  const embeddings = readEmbeddings(projectRoot);

  const duplicatePairs = [];
  const seenPairs = new Set();

  // Phase 1: Exact topic duplicates (case-insensitive)
  const topicMap = new Map();
  for (const entry of entries) {
    if (!entry.id) continue;
    const key = (entry.topic || "").toLowerCase().trim();
    if (!key) continue;
    if (!topicMap.has(key)) topicMap.set(key, []);
    topicMap.get(key).push(entry);
  }

  for (const [, group] of topicMap) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length - 1; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const pairKey = [group[i].id, group[j].id].sort().join(":");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        duplicatePairs.push({
          id1: group[i].id,
          id2: group[j].id,
          similarity: 1.0,
          topic1: group[i].topic || "",
          topic2: group[j].topic || "",
        });
      }
    }
  }

  // Phase 2: Embedding-based duplicates
  const withEmbeddings = entries.filter(
    (e) => e.id && embeddings[e.id] && Array.isArray(embeddings[e.id])
  );

  let comparisons = 0;
  for (let i = 0; i < withEmbeddings.length - 1; i++) {
    for (let j = i + 1; j < withEmbeddings.length; j++) {
      if (++comparisons > MAX_DUPLICATE_COMPARISONS) break;
      const pairKey = [withEmbeddings[i].id, withEmbeddings[j].id].sort().join(":");
      if (seenPairs.has(pairKey)) continue;

      const sim = cosineSimilarity(
        embeddings[withEmbeddings[i].id],
        embeddings[withEmbeddings[j].id]
      );
      if (sim > DUPLICATE_SIMILARITY_THRESHOLD) {
        seenPairs.add(pairKey);
        duplicatePairs.push({
          id1: withEmbeddings[i].id,
          id2: withEmbeddings[j].id,
          similarity: Math.round(sim * 10000) / 10000,
          topic1: withEmbeddings[i].topic || "",
          topic2: withEmbeddings[j].topic || "",
        });
      }
    }
    if (comparisons > MAX_DUPLICATE_COMPARISONS) break;
  }

  return { duplicatePairs };
}

// ── Task 3: Prune Graph ──

function pruneGraph(projectRoot, dryRun) {
  const researchPath = path.join(memDir(projectRoot), "research.jsonl");
  const entries = shared.readJsonl(researchPath);
  const triples = graph.readGraph(projectRoot);

  // Build entity set from research entries
  const entitySet = new Set();
  for (const entry of entries) {
    // Explicit entities field
    if (entry.entities) {
      const names = typeof entry.entities === "string"
        ? entry.entities.split(",")
        : Array.isArray(entry.entities) ? entry.entities : [];
      for (const name of names) {
        const trimmed = name.trim().toLowerCase();
        if (trimmed) entitySet.add(trimmed);
      }
    }
    // Extract entities from topic and finding text
    const combined = [entry.topic || "", entry.finding || ""].join(" ");
    const extracted = graph.extractEntitiesFromText(combined);
    for (const e of extracted) {
      entitySet.add(e.toLowerCase());
    }
  }

  const totalBefore = triples.length;
  const kept = [];
  let orphanedRemoved = 0;

  for (const t of triples) {
    const s = (t.s || "").toLowerCase();
    const o = (t.o || "").toLowerCase();
    // Orphaned = BOTH subject AND object are not in entity set
    if (s && o && !entitySet.has(s) && !entitySet.has(o)) {
      orphanedRemoved++;
    } else {
      kept.push(t);
    }
  }

  if (!dryRun && orphanedRemoved > 0) {
    // Rewrite graph.jsonl with kept triples only
    const gp = path.join(memDir(projectRoot), "graph.jsonl");
    fs.writeFileSync(gp, kept.map((t) => JSON.stringify(t)).join("\n") + (kept.length ? "\n" : ""), "utf-8");

    // Rebuild entity-index.json from remaining data
    const newIndex = {};
    for (const entry of entries) {
      if (!entry.id) continue;
      const names = new Set();
      if (entry.entities) {
        const list = typeof entry.entities === "string"
          ? entry.entities.split(",")
          : Array.isArray(entry.entities) ? entry.entities : [];
        for (const n of list) {
          const k = n.trim().toLowerCase();
          if (k) names.add(k);
        }
      }
      const combined = [entry.topic || "", entry.finding || ""].join(" ");
      for (const e of graph.extractEntitiesFromText(combined)) {
        names.add(e.toLowerCase());
      }
      for (const name of names) {
        if (!newIndex[name]) newIndex[name] = [];
        if (!newIndex[name].includes(entry.id)) newIndex[name].push(entry.id);
      }
    }
    shared.writeEntityIndex(projectRoot, newIndex);
  }

  return { orphanedRemoved, totalBefore, totalAfter: kept.length };
}

// ── Task 4: Refresh Embeddings ──

async function refreshEmbeddings(projectRoot, maxEntries = 20) {
  const researchPath = path.join(memDir(projectRoot), "research.jsonl");
  const entries = shared.readJsonl(researchPath);
  const embeddings = readEmbeddings(projectRoot);

  const missing = entries.filter(
    (e) => e.id && !embeddings[e.id]
  );

  const cap = Math.min(missing.length, maxEntries);
  let refreshed = 0;

  for (let i = 0; i < cap; i++) {
    const entry = missing[i];
    const text = [entry.topic || "", entry.finding || ""].filter(Boolean).join(". ");
    if (!text.trim()) continue;
    try {
      embeddings[entry.id] = await generateEmbedding(text);
      refreshed++;
    } catch (err) {
      // Log but continue — partial progress is still useful
      try { process.stderr.write(`[auto-maintain] embedding error for ${entry.id}: ${err.message}\n`); } catch {}
    }
  }

  if (refreshed > 0) {
    writeEmbeddings(projectRoot, embeddings);
  }

  return { refreshed, remaining: missing.length - refreshed };
}

// ── Orchestrator ──

async function runMaintenance(projectRoot, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const dir = memDir(projectRoot);

  // Ensure .ai-memory directory exists
  if (!fs.existsSync(dir)) {
    return { error: ".ai-memory directory not found", projectRoot };
  }

  const results = {};

  // Task 1
  results.stale = detectStale(projectRoot);

  // Task 2
  results.duplicates = detectDuplicates(projectRoot);

  // Task 3
  results.graph = pruneGraph(projectRoot, dryRun);

  // Task 4
  if (!dryRun) {
    results.embeddings = await refreshEmbeddings(projectRoot, opts.maxEmbeddings || 20);
  } else {
    // In dry-run, still report what's missing without generating
    const entries = shared.readJsonl(path.join(dir, "research.jsonl"));
    const embeddings = readEmbeddings(projectRoot);
    const missing = entries.filter((e) => e.id && !embeddings[e.id]);
    results.embeddings = { refreshed: 0, remaining: missing.length, dryRun: true };
  }

  results.dryRun = dryRun;
  results.ts = new Date().toISOString();

  // Write maintenance log and last-run timestamp
  if (!dryRun) {
    const logPath = path.join(dir, "maintenance-log.jsonl");
    shared.appendJsonl(logPath, results);

    const lastRunPath = path.join(dir, ".last-maintenance");
    fs.writeFileSync(lastRunPath, results.ts, "utf-8");
  }

  return results;
}

// ── CLI ──

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const projectRoot = args.find((a) => !a.startsWith("--")) || shared.findProjectRoot(process.cwd());

  if (!projectRoot) {
    console.error("[auto-maintain] Cannot determine project root. Pass it as an argument or run from a project directory.");
    process.exit(1);
  }

  console.log(`[auto-maintain] Running maintenance on: ${projectRoot}${dryRun ? " (DRY RUN)" : ""}`);

  runMaintenance(projectRoot, { dryRun }).then((results) => {
    console.log("\n=== Maintenance Results ===\n");

    console.log(`Stale entries: ${results.stale.staleCount}`);
    if (results.stale.staleCount > 0) {
      for (const e of results.stale.entries.slice(0, 10)) {
        console.log(`  - [${e.staleness}] ${e.topic} (${e.ageDays}d old)`);
      }
      if (results.stale.staleCount > 10) {
        console.log(`  ... and ${results.stale.staleCount - 10} more`);
      }
    }

    console.log(`\nDuplicate pairs: ${results.duplicates.duplicatePairs.length}`);
    for (const p of results.duplicates.duplicatePairs.slice(0, 10)) {
      console.log(`  - sim=${p.similarity}: "${p.topic1}" vs "${p.topic2}"`);
    }

    console.log(`\nGraph: ${results.graph.orphanedRemoved} orphaned triples removed (${results.graph.totalBefore} → ${results.graph.totalAfter})`);

    console.log(`\nEmbeddings: ${results.embeddings.refreshed} refreshed, ${results.embeddings.remaining} remaining`);

    if (dryRun) {
      console.log("\n(Dry run — no files were modified)");
    }
  }).catch((err) => {
    console.error("[auto-maintain] Fatal error:", err);
    process.exit(1);
  });
}

module.exports = { runMaintenance, detectStale, detectDuplicates, pruneGraph, refreshEmbeddings };
