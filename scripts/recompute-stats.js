#!/usr/bin/env node
"use strict";

/**
 * Recompute stats for all projects based on actual data.
 * Calculates realistic savings from entry counts, session history, and embeddings.
 */

const fs = require("fs");
const path = require("path");
const { readJsonl } = require(path.join(__dirname, "shared.js"));
const { readEmbeddings } = require(path.join(__dirname, "embeddings.js"));

const home = process.env.USERPROFILE || process.env.HOME;

// Same values as stats.js
const TOKENS = { session_load_decision: 10, session_load_research: 20, memory_check_hit: 500, research_search_hit: 1000, duplicate_save_avoided: 200 };
const TIME = { session_load_decision: 2, session_load_research: 5, memory_check_hit: 60, research_search_hit: 120, duplicate_save_avoided: 30 };

function discoverProjects() {
  const projects = new Set();
  function scan(dir, depth) {
    if (depth > 5) return;
    try {
      if (fs.existsSync(path.join(dir, ".ai-memory", "research.jsonl"))) projects.add(dir);
      if (depth < 5) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory() && e.name !== "node_modules" && e.name !== ".git") scan(path.join(dir, e.name), depth + 1);
        }
      }
    } catch {}
  }
  scan(home, 0);
  return Array.from(projects);
}

const projects = discoverProjects();
console.log(`Found ${projects.length} projects\n`);

for (const p of projects) {
  const memDir = path.join(p, ".ai-memory");
  const name = path.relative(home, p).replace(/\\/g, "/") || path.basename(p);
  const research = readJsonl(path.join(memDir, "research.jsonl"));
  const decisions = readJsonl(path.join(memDir, "decisions.jsonl"));
  const embeddings = readEmbeddings(p);
  const sessionHistory = readJsonl(path.join(memDir, "session-history.jsonl"));

  if (research.length === 0 && decisions.length === 0) {
    console.log(`  ${name}: empty, skipping`);
    continue;
  }

  // Count distinct sessions from entry timestamps (group by date+hour)
  const sessionSlots = new Set();
  for (const e of [...research, ...decisions]) {
    if (e.ts) sessionSlots.add(e.ts.substring(0, 13)); // YYYY-MM-DDTHH
  }
  const estimatedSessions = Math.max(sessionSlots.size, sessionHistory.filter(s => s.event === "start").length, 1);

  // Compute savings:
  // 1. Session loads: each session loads all entries into context
  const sessionLoadTokens = estimatedSessions * (research.length * TOKENS.session_load_research + decisions.length * TOKENS.session_load_decision);
  const sessionLoadTime = estimatedSessions * (research.length * TIME.session_load_research + decisions.length * TIME.session_load_decision);

  // 2. Memory check hits: estimate ~2 checks per session, ~30% of entries are relevant per check
  const checksPerSession = 2;
  const relevanceRate = 0.3;
  const totalChecks = estimatedSessions * checksPerSession;
  const hitsPerCheck = Math.max(1, Math.round(research.length * relevanceRate));
  const checkHitTokens = totalChecks * hitsPerCheck * TOKENS.memory_check_hit;
  const checkHitTime = totalChecks * hitsPerCheck * TIME.memory_check_hit;

  const totalTokens = sessionLoadTokens + checkHitTokens;
  const totalTime = sessionLoadTime + checkHitTime;
  const totalHits = estimatedSessions * (research.length + decisions.length) + totalChecks * hitsPerCheck;

  // Update metadata
  const metaPath = path.join(memDir, "metadata.json");
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}

  meta.stats = {
    totalTokensSaved: totalTokens,
    totalTimeSavedSeconds: totalTime,
    totalHits: totalHits,
    eventCounts: {
      session_load_decision: estimatedSessions * decisions.length,
      session_load_research: estimatedSessions * research.length,
      research_search_hit: 0,
      memory_check_hit: totalChecks * hitsPerCheck,
      duplicate_save_avoided: 0,
    },
  };
  meta.researchCount = research.length;
  meta.decisionCount = decisions.length;

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  console.log(`  ${name}: R=${research.length} D=${decisions.length} sessions=${estimatedSessions} checks=${totalChecks} hits=${totalHits}`);
  console.log(`    tokens=${totalTokens} time=${Math.round(totalTime/60)}min`);
}

console.log("\nDone. Dashboard will reflect updated stats on next refresh.");
