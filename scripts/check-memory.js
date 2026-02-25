#!/usr/bin/env node
"use strict";

/**
 * Semantic memory check — presents research and decisions for Claude to evaluate.
 *
 * Usage: node check-memory.js "search query or natural language question"
 *
 * Strategy (two-tier based on store size):
 *
 *   SMALL store (≤50 total entries):
 *     Dump ALL entries with full findings. Claude reads everything and
 *     performs semantic relevance evaluation natively.
 *
 *   LARGE store (>50 total entries):
 *     1. Show a COMPACT INDEX of every entry (topic + tags only, ~1 line each)
 *        so Claude can semantically scan the full inventory.
 *     2. Use lightweight keyword pre-filtering to expand FULL details only
 *        for likely-relevant entries (candidates).
 *     3. Claude evaluates the index + expanded candidates together.
 *
 * This avoids blowing up the context window while still giving Claude
 * semantic visibility into the entire memory store.
 */

const fs = require("fs");
const path = require("path");

const SMALL_STORE_THRESHOLD = 50; // dump everything below this
const MAX_EXPANDED_CANDIDATES = 20; // max full-detail entries in large mode

const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  console.error('Usage: node check-memory.js "search query or natural language question"');
  process.exit(1);
}

// Find project root
let dir = process.cwd();
while (dir) {
  if (fs.existsSync(path.join(dir, ".ai-memory"))) break;
  const parent = path.dirname(dir);
  if (parent === dir) {
    console.error("No .ai-memory/ found");
    process.exit(1);
  }
  dir = parent;
}

const statsModule = require(path.join(__dirname, "stats.js"));
const { C } = statsModule;

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  const entries = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }
  return entries;
}

function stalenessBadge(entry) {
  const staleness = entry.staleness || "stable";
  if (staleness === "stable") return "[FRESH]";
  if (staleness === "versioned") return "[CHECK VERSION]";
  return "[VERIFY]";
}

/**
 * Lightweight keyword pre-filter for large stores.
 * Returns a Set of entry IDs that have ANY keyword overlap.
 * This is intentionally loose — it's a pre-filter, not the final judge.
 * Claude does the real semantic evaluation on the results.
 */
function keywordPreFilter(entries, queryStr, idField) {
  const keywords = queryStr.toLowerCase().split(/\s+/).filter(Boolean);
  const matchedIds = new Set();

  for (const entry of entries) {
    const text = JSON.stringify(entry).toLowerCase();
    for (const kw of keywords) {
      if (text.includes(kw)) {
        matchedIds.add(entry[idField || "id"]);
        break;
      }
    }
  }
  return matchedIds;
}

// ── Read all entries ──
const researchPath = path.join(dir, ".ai-memory", "research.jsonl");
const research = readJsonl(researchPath);
const decisionsPath = path.join(dir, ".ai-memory", "decisions.jsonl");
const decisions = readJsonl(decisionsPath);

const totalEntries = research.length + decisions.length;
const isLargeStore = totalEntries > SMALL_STORE_THRESHOLD;

// ── Header ──
console.log(`${C.magenta}${C.bold}[project-memory] Searching memory...${C.reset}`);
console.log(`${C.magenta}Query: "${query}"  |  research.jsonl (${research.length} entries), decisions.jsonl (${decisions.length} entries)${C.reset}`);
if (isLargeStore) {
  console.log(`${C.magenta}Mode: large store (${totalEntries} entries) — showing compact index + expanded candidates${C.reset}`);
}
console.log("");

if (totalEntries === 0) {
  console.log(`${C.yellow}\u25CB No research or decisions saved yet.${C.reset}`);
  console.log("");
} else {
  // ── Instruction block for Claude (the LLM reading this output) ──
  console.log(`${C.green}${C.bold}=== SEMANTIC EVALUATION REQUIRED ===${C.reset}`);
  console.log(`${C.green}You are Claude, the LLM reading this output. Evaluate entries below for relevance to the query.${C.reset}`);
  console.log(`${C.green}Match on: synonyms, abbreviations, conceptual overlap, related architecture — not just exact keywords.${C.reset}`);
  console.log(`${C.green}If ANY entry is relevant: USE its finding/decision directly. Do NOT re-investigate what is already known.${C.reset}`);
  console.log(`${C.green}If NO entries are relevant: proceed with your investigation.${C.reset}`);
  console.log("");

  if (!isLargeStore) {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // SMALL STORE: dump everything with full details
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    if (research.length > 0) {
      console.log(`${C.green}${C.bold}=== All Research Findings (${research.length}) ===${C.reset}`);
      console.log("");
      for (let i = 0; i < research.length; i++) {
        const r = research[i];
        const badge = stalenessBadge(r);
        const tags = (r.tags || []).join(", ");
        const date = r.ts ? r.ts.substring(0, 10) : "unknown";
        const confidence = r.confidence != null ? r.confidence : "?";
        console.log(`${C.green}${i + 1}. ${badge} ${r.topic || "untitled"}${C.reset}`);
        console.log(`   Tags: ${tags}  |  Confidence: ${confidence}  |  Date: ${date}`);
        console.log(`   Finding: ${r.finding || ""}`);
        console.log("");
      }
    }

    if (decisions.length > 0) {
      console.log(`${C.green}${C.bold}=== All Decisions (${decisions.length}) ===${C.reset}`);
      console.log("");
      for (let i = 0; i < decisions.length; i++) {
        const d = decisions[i];
        const date = d.ts ? d.ts.substring(0, 10) : "unknown";
        console.log(`${C.green}${i + 1}. [${d.category || "other"}] ${d.decision}${C.reset}`);
        console.log(`   Rationale: ${d.rationale || ""}  |  Date: ${date}`);
        console.log("");
      }
    }

  } else {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // LARGE STORE: compact index + expanded candidates
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    // Pre-filter to find candidate IDs
    const researchCandidateIds = keywordPreFilter(research, query, "id");
    const decisionCandidateIds = keywordPreFilter(decisions, query, "id");

    // ── SECTION 1: Compact index of ALL research ──
    if (research.length > 0) {
      console.log(`${C.green}${C.bold}=== Research Index (${research.length} entries — scan for semantic relevance) ===${C.reset}`);
      console.log("");
      for (let i = 0; i < research.length; i++) {
        const r = research[i];
        const badge = stalenessBadge(r);
        const tags = (r.tags || []).join(", ");
        const marker = researchCandidateIds.has(r.id) ? " *" : "";
        console.log(`${C.green}  ${i + 1}. ${badge} ${r.topic || "untitled"} [${tags}]${marker}${C.reset}`);
      }
      console.log("");
      if (researchCandidateIds.size > 0) {
        console.log(`${C.dim}  (* = keyword match, expanded below. Other entries may also be relevant — evaluate the full index semantically.)${C.reset}`);
        console.log("");
      }
    }

    // ── SECTION 2: Compact index of ALL decisions ──
    if (decisions.length > 0) {
      console.log(`${C.green}${C.bold}=== Decision Index (${decisions.length} entries — scan for semantic relevance) ===${C.reset}`);
      console.log("");
      for (let i = 0; i < decisions.length; i++) {
        const d = decisions[i];
        const marker = decisionCandidateIds.has(d.id) ? " *" : "";
        console.log(`${C.green}  ${i + 1}. [${d.category || "other"}] ${d.decision}${marker}${C.reset}`);
      }
      console.log("");
      if (decisionCandidateIds.size > 0) {
        console.log(`${C.dim}  (* = keyword match, expanded below.)${C.reset}`);
        console.log("");
      }
    }

    // ── SECTION 3: Full details for keyword-matched candidates ──
    const expandedResearch = research.filter(r => researchCandidateIds.has(r.id)).slice(0, MAX_EXPANDED_CANDIDATES);
    const expandedDecisions = decisions.filter(d => decisionCandidateIds.has(d.id)).slice(0, MAX_EXPANDED_CANDIDATES);

    if (expandedResearch.length > 0) {
      console.log(`${C.green}${C.bold}=== Expanded Research Candidates (${expandedResearch.length}) ===${C.reset}`);
      console.log("");
      for (let i = 0; i < expandedResearch.length; i++) {
        const r = expandedResearch[i];
        const badge = stalenessBadge(r);
        const tags = (r.tags || []).join(", ");
        const date = r.ts ? r.ts.substring(0, 10) : "unknown";
        const confidence = r.confidence != null ? r.confidence : "?";
        console.log(`${C.green}${i + 1}. ${badge} ${r.topic || "untitled"}${C.reset}`);
        console.log(`   Tags: ${tags}  |  Confidence: ${confidence}  |  Date: ${date}`);
        console.log(`   Finding: ${r.finding || ""}`);
        console.log("");
      }
    }

    if (expandedDecisions.length > 0) {
      console.log(`${C.green}${C.bold}=== Expanded Decision Candidates (${expandedDecisions.length}) ===${C.reset}`);
      console.log("");
      for (let i = 0; i < expandedDecisions.length; i++) {
        const d = expandedDecisions[i];
        const date = d.ts ? d.ts.substring(0, 10) : "unknown";
        console.log(`${C.green}${i + 1}. [${d.category || "other"}] ${d.decision}${C.reset}`);
        console.log(`   Rationale: ${d.rationale || ""}  |  Date: ${date}`);
        console.log("");
      }
    }

    // ── Hint about non-expanded entries ──
    const totalCandidates = expandedResearch.length + expandedDecisions.length;
    const nonExpanded = totalEntries - totalCandidates;
    if (nonExpanded > 0 && totalCandidates > 0) {
      console.log(`${C.dim}${nonExpanded} other entries shown in index only. If any index entry looks semantically relevant to "${query}", ask for its full details.${C.reset}`);
      console.log("");
    } else if (totalCandidates === 0) {
      console.log(`${C.yellow}No keyword candidates found — review the index above for semantic matches.${C.reset}`);
      console.log(`${C.yellow}If an index entry looks relevant, it may use different terminology. Proceed with investigation if nothing matches.${C.reset}`);
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
const memCheckPath = path.join(dir, ".ai-memory", ".last-memory-check");
try {
  fs.writeFileSync(memCheckPath, String(Date.now()), "utf-8");
} catch {
  // Non-critical — skip silently
}

// ── Record stats ──
if (totalEntries > 0) {
  statsModule.recordEvent(dir, "memory_check_hit", totalEntries);
}

const tokensSaved =
  totalEntries > 0
    ? `~${statsModule.formatNumber(totalEntries * statsModule.TOKENS_SAVED.memory_check_hit)} tokens, ~${statsModule.formatDuration(totalEntries * statsModule.TIME_SAVED_SEC.memory_check_hit)} of investigation avoided`
    : "0 tokens (no entries)";

console.log(
  statsModule.formatMemoryStatusColored({
    action: `Checked memory for "${query}"`,
    checked: `research.jsonl (${research.length} entries), decisions.jsonl (${decisions.length} entries)`,
    matches: `${totalEntries} entries presented for semantic evaluation`,
    saved: tokensSaved,
    projectRoot: dir,
  })
);
