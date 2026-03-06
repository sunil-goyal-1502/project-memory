#!/usr/bin/env node
"use strict";

/**
 * Semantic memory search using ONNX embeddings.
 *
 * Usage: node check-memory.js "search query or natural language question"
 *
 * Strategy:
 *   1. Generate embedding for the query using MiniLM-L6-v2
 *   2. Compare against stored embeddings via cosine similarity
 *   3. Rank all entries by semantic relevance
 *   4. Present top results with full details + scores
 *   5. Show remaining entries in compact index
 *
 * If embeddings don't exist yet, builds them on first run.
 */

const fs = require("fs");
const path = require("path");

const MAX_EXPANDED = 20;

const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  console.error('Usage: node check-memory.js "search query or natural language question"');
  process.exit(1);
}

const shared = require(path.join(__dirname, "shared.js"));
const embeddingsModule = require(path.join(__dirname, "embeddings.js"));

// Find project root
const dir = shared.resolveProjectRoot();

const statsModule = require(path.join(__dirname, "stats.js"));
const { C } = statsModule;

function stalenessBadge(entry) {
  const staleness = entry.staleness || "stable";
  if (staleness === "stable") return "[FRESH]";
  if (staleness === "versioned") return "[CHECK VERSION]";
  return "[VERIFY]";
}

async function main() {
  // ── Read all entries ──
  const research = shared.readJsonl(path.join(dir, ".ai-memory", "research.jsonl"));
  const decisions = shared.readJsonl(path.join(dir, ".ai-memory", "decisions.jsonl"));
  const totalEntries = research.length + decisions.length;

  // ── Header ──
  console.log(`${C.magenta}${C.bold}[project-memory] Searching memory...${C.reset}`);
  console.log(`${C.magenta}Query: "${query}"  |  research.jsonl (${research.length} entries), decisions.jsonl (${decisions.length} entries)${C.reset}`);
  console.log(`${C.magenta}Mode: semantic search (ONNX embeddings)${C.reset}`);
  console.log("");

  if (totalEntries === 0) {
    console.log(`${C.yellow}\u25CB No research or decisions saved yet.${C.reset}`);
    console.log("");
  } else {
    // ── Read existing embeddings (built in background by save/session-start) ──
    const storedEmbeddings = embeddingsModule.readEmbeddings(dir);
    const embeddedCount = Object.keys(storedEmbeddings).length;
    const missingCount = totalEntries - embeddedCount;

    if (missingCount > 0) {
      console.log(`${C.yellow}${missingCount} entries not yet embedded (background build may be in progress).${C.reset}`);
      console.log(`${C.yellow}Run: node "${path.resolve(__dirname).replace(/\\/g, "/")}/build-embeddings.js" to build now.${C.reset}`);
      console.log("");
    }

    // ── Semantic search ──
    const semanticResults = await embeddingsModule.semanticSearch(query, storedEmbeddings);
    const scoreMap = {};
    for (const { docId, score } of semanticResults) {
      scoreMap[docId] = score;
    }

    // Sort entries by semantic score (descending)
    const rankedResearch = [...research].sort((a, b) => (scoreMap[b.id] || 0) - (scoreMap[a.id] || 0));
    const rankedDecisions = [...decisions].sort((a, b) => (scoreMap[b.id] || 0) - (scoreMap[a.id] || 0));

    // ── Instruction block for Claude ──
    console.log(`${C.green}${C.bold}=== SEMANTIC SEARCH RESULTS ===${C.reset}`);
    console.log(`${C.green}Entries ranked by semantic similarity to your query.${C.reset}`);
    console.log(`${C.green}Higher scores = more relevant. Use findings directly — do NOT re-investigate.${C.reset}`);
    console.log("");

    // ── Research findings (ranked by semantic score) ──
    if (rankedResearch.length > 0) {
      console.log(`${C.green}${C.bold}=== Research Findings (${rankedResearch.length}) ===${C.reset}`);
      console.log("");
      for (let i = 0; i < rankedResearch.length; i++) {
        const r = rankedResearch[i];
        const badge = stalenessBadge(r);
        const tags = (r.tags || []).join(", ");
        const date = r.ts ? r.ts.substring(0, 10) : "unknown";
        const confidence = r.confidence != null ? r.confidence : "?";
        const score = scoreMap[r.id];
        const scoreFmt = score != null ? ` | Relevance: ${(score * 100).toFixed(1)}%` : "";
        console.log(`${C.green}${i + 1}. ${badge} ${r.topic || "untitled"}${scoreFmt}${C.reset}`);
        console.log(`   Tags: ${tags}  |  Confidence: ${confidence}  |  Date: ${date}`);
        console.log(`   Finding: ${r.finding || ""}`);
        console.log("");
      }
    }

    // ── Decisions (ranked by semantic score) ──
    if (rankedDecisions.length > 0) {
      console.log(`${C.green}${C.bold}=== Decisions (${rankedDecisions.length}) ===${C.reset}`);
      console.log("");
      for (let i = 0; i < rankedDecisions.length; i++) {
        const d = rankedDecisions[i];
        const date = d.ts ? d.ts.substring(0, 10) : "unknown";
        const score = scoreMap[d.id];
        const scoreFmt = score != null ? ` | Relevance: ${(score * 100).toFixed(1)}%` : "";
        console.log(`${C.green}${i + 1}. [${d.category || "other"}] ${d.decision}${scoreFmt}${C.reset}`);
        console.log(`   Rationale: ${d.rationale || ""}  |  Date: ${date}`);
        console.log("");
      }
    }

    // ── Closing directive with mandatory banner template ──
    console.log(`${C.green}${C.bold}>>> EVALUATE the entries above for semantic relevance to: "${query}" <<<${C.reset}`);
    console.log("");
    console.log(`${C.green}${C.bold}MANDATORY: If ANY entry is relevant, you MUST:${C.reset}`);
    console.log(`${C.green}1. Display this green banner (fill in the blanks):${C.reset}`);
    console.log("");
    console.log(`${C.green}   \u2605 Memory Hit \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${C.reset}`);
    console.log(`${C.green}     \u2713 Found relevant research in project memory — skipping further exploration.${C.reset}`);
    console.log(`${C.green}     Matched: "<topic1>", "<topic2>", ...${C.reset}`);
    console.log(`${C.green}     Savings: ~X,000 tokens, ~Y min of investigation avoided${C.reset}`);
    console.log(`${C.green}   \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${C.reset}`);
    console.log("");
    console.log(`${C.green}2. USE the matched findings directly in your response — do NOT re-investigate.${C.reset}`);
    console.log(`${C.green}3. Estimate savings: ~1,000 tokens and ~2 min per matched finding used.${C.reset}`);
    console.log(`${C.green}4. If NO entries are relevant: proceed with your investigation (no banner needed).${C.reset}`);
    console.log("");
  }

  // ── Record that memory was checked (unlocks PreToolUse gate) ──
  try {
    fs.writeFileSync(path.join(dir, ".ai-memory", ".last-memory-check"), String(Date.now()), "utf-8");
  } catch { /* non-critical */ }

  // ── Record stats — only count entries with >20% semantic relevance as hits ──
  const RELEVANCE_THRESHOLD = 0.20;
  const relevantCount = semanticResults.filter(r => r.score >= RELEVANCE_THRESHOLD).length;

  if (relevantCount > 0) {
    statsModule.recordEvent(dir, "memory_check_hit", relevantCount);
  }

  const tokensSaved = relevantCount > 0
    ? `~${statsModule.formatNumber(relevantCount * statsModule.TOKENS_SAVED.memory_check_hit)} tokens, ~${statsModule.formatDuration(relevantCount * statsModule.TIME_SAVED_SEC.memory_check_hit)} of investigation avoided`
    : "0 tokens (no relevant hits)";

  console.log(statsModule.formatMemoryStatusColored({
    action: `Checked memory for "${query}"`,
    checked: `research.jsonl (${research.length} entries), decisions.jsonl (${decisions.length} entries)`,
    matches: `${relevantCount} relevant hits (>20% similarity) out of ${totalEntries} entries`,
    saved: tokensSaved,
    projectRoot: dir,
  }));
}

main().catch(err => {
  console.error(`Memory check failed: ${err.message}`);
  process.exit(1);
});
