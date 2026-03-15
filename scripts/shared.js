#!/usr/bin/env node
"use strict";

/**
 * Shared utility functions for project-memory plugin scripts.
 * DRY: these were previously duplicated across save-research.js,
 * save-decision.js, check-memory.js, session-summary.js, etc.
 */

const fs = require("fs");
const path = require("path");

// ── Project Root Discovery ──

function findProjectRoot(startDir) {
  let dir = startDir || process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, ".ai-memory"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function scanHomeForProjects() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return null;
  const candidates = [];
  if (fs.existsSync(path.join(home, ".ai-memory"))) candidates.push(home);
  try {
    const entries = fs.readdirSync(home, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const childPath = path.join(home, entry.name);
        if (fs.existsSync(path.join(childPath, ".ai-memory"))) candidates.push(childPath);
      }
    }
  } catch { /* permission errors */ }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  candidates.sort((a, b) => {
    try {
      return fs.statSync(path.join(b, ".ai-memory")).mtimeMs -
             fs.statSync(path.join(a, ".ai-memory")).mtimeMs;
    } catch { return 0; }
  });
  return candidates[0];
}

function resolveProjectRoot(exitOnMissing = true) {
  const root = findProjectRoot(process.cwd()) || scanHomeForProjects();
  if (!root && exitOnMissing) {
    console.error("No .ai-memory/ found");
    process.exit(1);
  }
  return root;
}

// ── JSONL Read/Write ──

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  const entries = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
  }
  return entries;
}

function appendJsonl(filePath, entry) {
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

// ── Tokenization ──

function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s\.\,\;\:\(\)\[\]\{\}\|\!\?\"\'\`\~\@\#\$\%\^\&\*\+\=\<\>\/\\]+/)
    .filter(t => t.length > 0);
}

// ── Entity Index ──

function readEntityIndex(projectRoot) {
  const indexPath = path.join(projectRoot, ".ai-memory", "entity-index.json");
  if (!fs.existsSync(indexPath)) return {};
  try { return JSON.parse(fs.readFileSync(indexPath, "utf-8")); } catch { return {}; }
}

function writeEntityIndex(projectRoot, index) {
  const indexPath = path.join(projectRoot, ".ai-memory", "entity-index.json");
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
}

function addToEntityIndex(projectRoot, entities, findingId) {
  if (!entities || entities.length === 0) return;
  const index = readEntityIndex(projectRoot);
  for (const entity of entities) {
    const key = entity.toLowerCase().trim();
    if (!key) continue;
    if (!index[key]) index[key] = [];
    if (!index[key].includes(findingId)) index[key].push(findingId);
  }
  writeEntityIndex(projectRoot, index);
}

// ── Exploration Breadcrumbs ──

const EXPLORATION_LOG_FILE = ".exploration-log";

function appendBreadcrumb(projectRoot, breadcrumb) {
  const logPath = path.join(projectRoot, ".ai-memory", EXPLORATION_LOG_FILE);
  const entry = { ts: new Date().toISOString(), tool: breadcrumb.tool, ...breadcrumb, saved: false };
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

function readExplorationLog(projectRoot) {
  return readJsonl(path.join(projectRoot, ".ai-memory", EXPLORATION_LOG_FILE));
}

function clearExplorationLog(projectRoot) {
  const logPath = path.join(projectRoot, ".ai-memory", EXPLORATION_LOG_FILE);
  try { fs.unlinkSync(logPath); } catch { /* doesn't exist */ }
}

function getUnsavedBreadcrumbs(projectRoot) {
  const breadcrumbs = readExplorationLog(projectRoot);
  if (breadcrumbs.length === 0) return [];
  let lastSaveTs = 0;
  for (const file of ["research.jsonl", "decisions.jsonl"]) {
    try {
      const stat = fs.statSync(path.join(projectRoot, ".ai-memory", file));
      if (stat.mtimeMs > lastSaveTs) lastSaveTs = stat.mtimeMs;
    } catch { /* file doesn't exist */ }
  }
  const lastSaveIso = lastSaveTs > 0 ? new Date(lastSaveTs).toISOString() : "";
  return breadcrumbs.filter(b => !lastSaveIso || (b.ts || "") > lastSaveIso);
}

// ── BM25 Search ──

function buildBM25Index(entries) {
  const invertedIndex = Object.create(null); // avoids prototype pollution (constructor, toString, etc.)
  const docLengths = Object.create(null);
  let totalLength = 0;
  for (const entry of entries) {
    const docId = entry.id;
    const text = [entry.topic || "", (entry.tags || []).join(" "), entry.finding || entry.decision || "", (entry.entities || []).join(" ")].join(" ");
    const tokens = tokenize(text);
    docLengths[docId] = tokens.length;
    totalLength += tokens.length;
    const tfMap = {};
    for (const token of tokens) tfMap[token] = (tfMap[token] || 0) + 1;
    for (const [term, tf] of Object.entries(tfMap)) {
      if (!invertedIndex[term]) invertedIndex[term] = [];
      invertedIndex[term].push({ docId, tf });
    }
  }
  return { invertedIndex, docLengths, avgDocLen: entries.length > 0 ? totalLength / entries.length : 0, N: entries.length };
}

function bm25Score(query, bm25Index, k1 = 1.2, b = 0.75) {
  const { invertedIndex, docLengths, avgDocLen, N } = bm25Index;
  const queryTerms = tokenize(query);
  const scores = Object.create(null);
  for (const term of queryTerms) {
    const postings = invertedIndex[term];
    if (!postings || !Array.isArray(postings)) continue;
    const df = postings.length;
    const idf = Math.max(0, Math.log((N - df + 0.5) / (df + 0.5) + 1));
    for (const { docId, tf } of postings) {
      const dl = docLengths[docId] || 0;
      const score = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / (avgDocLen || 1)))));
      scores[docId] = (scores[docId] || 0) + score;
    }
  }
  return Object.entries(scores).map(([docId, score]) => ({ docId, score })).sort((a, b) => b.score - a.score);
}

// ── Deduplication ──

function findSimilarEntry(existingEntries, newTopic, newTags) {
  const newTopicLower = (newTopic || "").toLowerCase();
  const newTagSet = new Set((newTags || []).map(t => t.toLowerCase().trim()));
  for (const entry of existingEntries) {
    const existingTopicLower = (entry.topic || "").toLowerCase();
    const topicMatch = existingTopicLower.includes(newTopicLower) || newTopicLower.includes(existingTopicLower);
    if (!topicMatch) continue;
    const existingTags = (entry.tags || []).map(t => t.toLowerCase());
    let matchingTags = 0;
    for (const tag of existingTags) { if (newTagSet.has(tag)) matchingTags++; }
    if (matchingTags >= 2) return entry;
  }
  return null;
}

// ── Tool History & Auto-Capture ──

const TOOL_HISTORY_FILE = ".tool-history";
const MAX_HISTORY = 50;

/**
 * Record a tool call result to the rolling history.
 * entry: { tool, command, description, exitCode, success, ts }
 */
function appendToolHistory(projectRoot, entry) {
  const histPath = path.join(projectRoot, ".ai-memory", TOOL_HISTORY_FILE);
  const record = { ...entry, ts: new Date().toISOString() };
  fs.appendFileSync(histPath, JSON.stringify(record) + "\n", "utf-8");

  // Trim to MAX_HISTORY lines
  try {
    const lines = fs.readFileSync(histPath, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length > MAX_HISTORY) {
      fs.writeFileSync(histPath, lines.slice(-MAX_HISTORY).join("\n") + "\n", "utf-8");
    }
  } catch { /* non-critical */ }
}

function readToolHistory(projectRoot) {
  return readJsonl(path.join(projectRoot, ".ai-memory", TOOL_HISTORY_FILE));
}

function clearToolHistory(projectRoot) {
  const histPath = path.join(projectRoot, ".ai-memory", TOOL_HISTORY_FILE);
  try { fs.unlinkSync(histPath); } catch {}
}

/**
 * Detect auto-capture patterns and return a research entry if found.
 * Returns null if no pattern detected.
 *
 * Patterns:
 * 1. RETRY_SUCCESS: Command failed previously, same/similar command now succeeded
 * 2. EXPLORATION_SUCCESS: Series of exploratory commands, final one succeeded
 */
function detectAutoCapture(projectRoot, currentCall) {
  if (!currentCall.success) return null; // only capture successes
  if (!currentCall.command && !currentCall.description) return null;

  const history = readToolHistory(projectRoot);
  if (history.length < 2) return null;

  const currentCmd = (currentCall.command || "").toLowerCase().trim();
  const currentDesc = (currentCall.description || "").toLowerCase().trim();

  // Pattern 1: RETRY_SUCCESS — same command failed earlier, now succeeded
  // Look for a failed command in the last 10 entries that's similar
  const recentFails = history.slice(-10).filter(h =>
    h.tool === "Bash" && !h.success && h.command
  );

  for (const fail of recentFails) {
    const failCmd = (fail.command || "").toLowerCase().trim();
    // Similar if: same first word (command name) and >50% token overlap
    const failTokens = tokenize(failCmd);
    const currentTokens = tokenize(currentCmd);
    if (failTokens.length === 0 || currentTokens.length === 0) continue;

    // Same command name (first token)
    if (failTokens[0] !== currentTokens[0]) continue;

    // Token overlap check
    const failSet = new Set(failTokens);
    const overlap = currentTokens.filter(t => failSet.has(t)).length;
    const overlapRatio = overlap / Math.max(failTokens.length, currentTokens.length);

    if (overlapRatio > 0.3) {
      // Extract meaningful tags from the command
      const tags = extractCommandTags(currentCall.command || currentCall.description || "");
      return {
        topic: "Script: " + (currentCall.description || "").slice(0, 80),
        tags: ["auto-capture", "bash", "script", "retry-success", ...tags],
        finding: (currentCall.description ? currentCall.description + ": " : "")
          + (currentCall.command || ""),
        source_tool: "auto-capture",
      };
    }
  }

  // Pattern 2: EXPLORATION_SUCCESS — exploratory command succeeded
  // after 3+ exploratory commands in a row
  const recentExploratory = history.slice(-5).filter(h =>
    h.tool === "Bash" && h.exploratory
  );

  if (recentExploratory.length >= 3 && currentCall.exploratory && currentCall.success) {
    const tags = extractCommandTags(currentCall.command || currentCall.description || "");
    return {
      topic: "Script: " + (currentCall.description || "").slice(0, 80),
      tags: ["auto-capture", "bash", "script", "discovery", ...tags],
      finding: (currentCall.description ? currentCall.description + ": " : "")
        + (currentCall.command || ""),
      source_tool: "auto-capture",
    };
  }

  return null;
}

/**
 * Extract meaningful tags from a command string.
 * Identifies tools, file extensions, and key terms.
 */
function extractCommandTags(cmdStr) {
  const tags = new Set();
  const lower = cmdStr.toLowerCase();

  // Tool names
  const tools = ["node", "npm", "git", "docker", "curl", "grep", "find", "dotnet", "python", "pip", "powershell"];
  for (const t of tools) { if (lower.includes(t)) tags.add(t); }

  // File extensions
  const extMatch = cmdStr.match(/\.\w{1,6}\b/g);
  if (extMatch) {
    for (const ext of extMatch) {
      const e = ext.toLowerCase();
      if ([".js", ".ts", ".py", ".cs", ".json", ".xml", ".sh", ".ps1", ".md"].includes(e)) {
        tags.add(e.slice(1)); // remove dot
      }
    }
  }

  // Limit to 5 tags
  return Array.from(tags).slice(0, 5);
}

/**
 * Auto-save a detected capture as research.
 * Directly appends to research.jsonl (fast, no subprocess spawn).
 */
function autoSaveCapture(projectRoot, capture) {
  const crypto = require("crypto");
  const researchPath = path.join(projectRoot, ".ai-memory", "research.jsonl");

  const entry = {
    id: crypto.randomBytes(4).toString("hex"),
    ts: new Date().toISOString(),
    topic: capture.topic,
    tags: capture.tags,
    finding: capture.finding,
    entities: [],
    related_to: [],
    source_tool: capture.source_tool || "auto-capture",
    source_context: "Automatically captured from tool usage pattern",
    confidence: 0.7,
    staleness: "stable",
    supersedes: null,
    version_anchored: null,
  };

  appendJsonl(researchPath, entry);
  return entry;
}

// ── Exploration Capture Helpers ──

const EXPLORATIONS_DIR = "explorations";
const EXPLORATIONS_INDEX = "explorations.jsonl";

/**
 * Ensure the explorations directory exists under .ai-memory/.
 */
function ensureExplorationsDir(projectRoot) {
  const dir = path.join(projectRoot, ".ai-memory", EXPLORATIONS_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Read the explorations index (lightweight JSONL with metadata per exploration).
 */
function readExplorationsIndex(projectRoot) {
  const indexPath = path.join(projectRoot, ".ai-memory", EXPLORATIONS_DIR, EXPLORATIONS_INDEX);
  return readJsonl(indexPath);
}

/**
 * Append an entry to the explorations index.
 */
function appendExplorationIndex(projectRoot, entry) {
  const indexPath = path.join(projectRoot, ".ai-memory", EXPLORATIONS_DIR, EXPLORATIONS_INDEX);
  appendJsonl(indexPath, entry);
}

/**
 * Extract file paths mentioned in text.
 * Matches common source file extensions.
 */
function extractFilePathsFromText(text) {
  if (!text) return [];
  const paths = new Set();
  // Match file paths with extensions (e.g., hooks/scripts/post-tool-use.js, src/App.tsx)
  // Order matters: longer extensions first to avoid partial matches (tsx before ts)
  const FILE_PATH_RE = /(?:[\w./-]+\/)?[\w.-]+\.(?:tsx|jsx|jsonl|csproj|yaml|toml|hpp|cpp|sln|bat|vue|css|html|json|xml|js|ts|py|cs|sh|ps1|md|yml|rb|go|rs|java|c|h)/gi;
  let match;
  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    const p = match[0];
    // Skip very short matches that are likely just extensions mentioned in text
    if (p.length > 4) paths.add(p);
  }
  return Array.from(paths);
}

/**
 * Sanitize a string for use as a filename.
 * Removes unsafe chars, truncates, lowercases.
 */
function sanitizeFilename(str, maxLen = 60) {
  if (!str) return "exploration";
  return str
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")  // replace unsafe chars with hyphens
    .replace(/-+/g, "-")             // collapse consecutive hyphens
    .replace(/^-|-$/g, "")           // trim leading/trailing hyphens
    .slice(0, maxLen) || "exploration";
}

/**
 * Extract tags from a prompt/query string.
 * Identifies meaningful keywords for search.
 */
function extractTagsFromPrompt(prompt) {
  if (!prompt) return [];
  const tags = new Set();
  const lower = prompt.toLowerCase();

  // Action keywords
  const actions = ["explore", "search", "investigate", "analyze", "understand", "check", "review", "find", "debug", "trace"];
  for (const a of actions) { if (lower.includes(a)) tags.add(a); }

  // Technical terms (extract multi-word identifiers split by hyphens/underscores)
  const techTerms = prompt.match(/\b[a-z][a-z0-9]*[-_][a-z0-9]+[-_a-z0-9]*/gi) || [];
  for (const t of techTerms) {
    if (t.length > 3 && t.length < 30) tags.add(t.toLowerCase());
  }

  // File extensions mentioned
  const exts = prompt.match(/\.(?:js|ts|py|cs|json|xml|md|yaml)\b/gi) || [];
  for (const e of exts) tags.add(e.slice(1).toLowerCase());

  return Array.from(tags).slice(0, 10);
}

/**
 * Search explorations using BM25 on the index entries.
 * Returns: [{ docId, score, entry }] sorted by score descending.
 */
function searchExplorations(projectRoot, query) {
  const entries = readExplorationsIndex(projectRoot);
  if (entries.length === 0) return [];

  // Build searchable text for each entry
  const searchableEntries = entries.map(e => ({
    id: e.id,
    topic: e.query || "",
    tags: e.tags || [],
    finding: [e.query || "", (e.files || []).join(" "), (e.entities || []).join(" "), (e.tags || []).join(" ")].join(" "),
    entities: e.entities || [],
    _raw: e,
  }));

  const index = buildBM25Index(searchableEntries);
  const results = bm25Score(query, index);

  // Attach the raw entry to each result
  const entryMap = {};
  for (const e of entries) entryMap[e.id] = e;

  return results.map(r => ({
    ...r,
    entry: entryMap[r.docId],
  })).filter(r => r.entry);
}

module.exports = {
  findProjectRoot, scanHomeForProjects, resolveProjectRoot,
  readJsonl, appendJsonl, tokenize,
  readEntityIndex, writeEntityIndex, addToEntityIndex,
  appendBreadcrumb, readExplorationLog, clearExplorationLog, getUnsavedBreadcrumbs, EXPLORATION_LOG_FILE,
  buildBM25Index, bm25Score,
  findSimilarEntry,
  appendToolHistory, readToolHistory, clearToolHistory, detectAutoCapture, autoSaveCapture, extractCommandTags,
  TOOL_HISTORY_FILE,
  // Exploration capture
  ensureExplorationsDir, readExplorationsIndex, appendExplorationIndex,
  extractFilePathsFromText, sanitizeFilename, extractTagsFromPrompt, searchExplorations,
  EXPLORATIONS_DIR, EXPLORATIONS_INDEX,
};
