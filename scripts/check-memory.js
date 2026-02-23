#!/usr/bin/env node
"use strict";

/**
 * Quick memory check — search research and decisions before investigating anything.
 *
 * Usage: node check-memory.js "search query keywords"
 *
 * Searches both research.jsonl and decisions.jsonl, scores results by relevance,
 * and shows top 3 matches from each store with staleness badges.
 */

const fs = require("fs");
const path = require("path");

const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  console.error('Usage: node check-memory.js "search query keywords"');
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

const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

// Score research entries
const researchPath = path.join(dir, ".ai-memory", "research.jsonl");
const research = readJsonl(researchPath);
const scoredResearch = [];

for (const r of research) {
  let score = 0;
  const tags = (r.tags || []).map((t) => t.toLowerCase());
  const topic = (r.topic || "").toLowerCase();
  const finding = (r.finding || "").toLowerCase();

  for (const kw of keywords) {
    if (tags.some((t) => t === kw || t.includes(kw))) score += 3;
    if (topic.includes(kw)) score += 2;
    if (finding.includes(kw)) score += 1;
  }

  if (score > 0) {
    scoredResearch.push({ entry: r, score });
  }
}

scoredResearch.sort((a, b) => b.score - a.score);
const topResearch = scoredResearch.slice(0, 10);

// Score decision entries
const decisionsPath = path.join(dir, ".ai-memory", "decisions.jsonl");
const decisions = readJsonl(decisionsPath);
const scoredDecisions = [];

for (const d of decisions) {
  let score = 0;
  const decision = (d.decision || "").toLowerCase();
  const rationale = (d.rationale || "").toLowerCase();
  const category = (d.category || "").toLowerCase();

  for (const kw of keywords) {
    if (decision.includes(kw)) score += 3;
    if (category === kw || category.includes(kw)) score += 2;
    if (rationale.includes(kw)) score += 1;
  }

  if (score > 0) {
    scoredDecisions.push({ entry: d, score });
  }
}

scoredDecisions.sort((a, b) => b.score - a.score);
const topDecisions = scoredDecisions.slice(0, 10);

// ── Magenta preamble header ──
console.log(`${C.magenta}${C.bold}[project-memory] Searching memory...${C.reset}`);
console.log(`${C.magenta}Query: "${query}"  |  Checking research.jsonl (${research.length} entries), decisions.jsonl (${decisions.length} entries)${C.reset}`);
console.log("");

// Display research matches
if (topResearch.length > 0) {
  console.log(`${C.green}${C.bold}=== Research Matches (${topResearch.length}) ===${C.reset}`);
  console.log("");
  for (const { entry: r, score } of topResearch) {
    const badge = stalenessBadge(r);
    const tags = (r.tags || []).join(", ");
    const date = r.ts ? r.ts.substring(0, 10) : "unknown";
    const confidence = r.confidence != null ? r.confidence : "?";
    const finding = r.finding || "";
    console.log(
      `${C.green}\u2713 ${badge} ${r.topic || "untitled"} (score: ${score})${C.reset}`
    );
    console.log(
      `  Tags: ${tags}  |  Confidence: ${confidence}  |  Date: ${date}`
    );
    console.log(`  Finding: ${finding}`);
    console.log("");
  }
} else {
  console.log(`${C.yellow}\u25CB No matching research found.${C.reset}`);
  console.log("");
}

// Display decision matches
if (topDecisions.length > 0) {
  console.log(`${C.green}${C.bold}=== Decision Matches (${topDecisions.length}) ===${C.reset}`);
  console.log("");
  for (const { entry: d, score } of topDecisions) {
    const rationale = d.rationale || "";
    const date = d.ts ? d.ts.substring(0, 10) : "unknown";
    console.log(
      `${C.green}\u2713 [${d.category || "other"}] ${d.decision} (score: ${score})${C.reset}`
    );
    console.log(`  Rationale: ${rationale}  |  Date: ${date}`);
    console.log("");
  }
} else {
  console.log(`${C.yellow}\u25CB No matching decisions found.${C.reset}`);
  console.log("");
}

// ── Record that memory was checked (unlocks PreToolUse gate) ──
const memCheckPath = path.join(dir, ".ai-memory", ".last-memory-check");
try {
  fs.writeFileSync(memCheckPath, String(Date.now()), "utf-8");
} catch {
  // Non-critical — skip silently
}

// Record stats and show Memory Status
const totalMatches = topResearch.length + topDecisions.length;

if (totalMatches > 0) {
  statsModule.recordEvent(dir, "memory_check_hit", totalMatches);
}

const tokensSaved =
  totalMatches > 0
    ? `~${statsModule.formatNumber(totalMatches * statsModule.TOKENS_SAVED.memory_check_hit)} tokens, ~${statsModule.formatDuration(totalMatches * statsModule.TIME_SAVED_SEC.memory_check_hit)} of investigation avoided`
    : "0 tokens (no matches)";

const checkedParts = [];
checkedParts.push(`research.jsonl (${research.length} entries)`);
checkedParts.push(`decisions.jsonl (${decisions.length} entries)`);

const matchDesc =
  totalMatches > 0
    ? `${totalMatches} matches found (${topResearch.length} research, ${topDecisions.length} decisions)`
    : "0 matches";

console.log(
  statsModule.formatMemoryStatusColored({
    action: `Checked memory for "${query}"`,
    checked: checkedParts.join(", "),
    matches: matchDesc,
    saved: tokensSaved,
    projectRoot: dir,
  })
);
