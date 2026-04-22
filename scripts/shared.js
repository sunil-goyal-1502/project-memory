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
  // SECURITY: cap file size before slurping into memory. Without this, an
  // attacker who can write to the .ai-memory directory (or a runaway
  // auto-capture loop) can OOM the daemon by appending to the JSONL.
  const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
  try {
    const st = fs.statSync(filePath);
    if (st.size > MAX_BYTES) {
      const msg = `[project-memory] WARNING: ${path.basename(filePath)} (${st.size} bytes) exceeds size cap ${MAX_BYTES} — skipping. Move/archive the file or raise the cap to read it.`;
      // Stderr so CLIs/MCP server callers see it; debug log so daemon ops can audit.
      try { process.stderr.write(msg + "\n"); } catch {}
      try {
        const logDir = path.dirname(filePath);
        fs.appendFileSync(path.join(logDir, ".hook-debug.log"),
          `[${new Date().toISOString()}] SIZE-CAP: skipping ${path.basename(filePath)} (${st.size} > ${MAX_BYTES})\n`,
          "utf-8");
      } catch {}
      return [];
    }
  } catch { return []; }
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  const entries = [];
  let corruptedCount = 0;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      corruptedCount++;
    }
  }
  if (corruptedCount > 0) {
    // Log corruption warning (visible in hook debug log and stderr)
    const msg = `[project-memory] WARNING: ${corruptedCount} corrupted line(s) in ${path.basename(filePath)} (${entries.length} valid entries loaded)`;
    try {
      const logDir = path.dirname(filePath);
      fs.appendFileSync(path.join(logDir, ".hook-debug.log"), `[${new Date().toISOString()}] CORRUPTION: ${msg}\n`, "utf-8");
    } catch {}
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
    .replace(/([a-z])([A-Z])/g, "$1 $2")           // camelCase split: "appiumSession" → "appium Session"
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")     // PascalCase split: "HTMLParser" → "HTML Parser"
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

// ── BM25 Cache ──

const BM25_CACHE_FILE = ".bm25-cache.json";

/**
 * Build BM25 index and write to cache file. Called at session-start.
 * Cache key: mtime of research.jsonl (fast check, no content hash needed).
 */
function buildAndCacheBM25(projectRoot) {
  const researchPath = path.join(projectRoot, ".ai-memory", "research.jsonl");
  const research = readJsonl(researchPath);
  const index = buildBM25Index(research);

  let mtime = 0;
  try { mtime = fs.statSync(researchPath).mtimeMs; } catch {}

  const cache = { mtime, ...index };
  const cachePath = path.join(projectRoot, ".ai-memory", BM25_CACHE_FILE);
  try {
    fs.writeFileSync(cachePath, JSON.stringify(cache), "utf-8");
  } catch {}

  return index;
}

/**
 * Load cached BM25 index. Returns null if stale or missing.
 */
function loadCachedBM25(projectRoot) {
  const cachePath = path.join(projectRoot, ".ai-memory", BM25_CACHE_FILE);
  const researchPath = path.join(projectRoot, ".ai-memory", "research.jsonl");
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    const currentMtime = fs.statSync(researchPath).mtimeMs;
    if (cache.mtime === currentMtime && cache.invertedIndex) {
      return { invertedIndex: cache.invertedIndex, docLengths: cache.docLengths, avgDocLen: cache.avgDocLen, N: cache.N };
    }
  } catch {}
  return null;
}

/**
 * Invalidate BM25 cache (called after save-research).
 */
function invalidateBM25Cache(projectRoot) {
  const cachePath = path.join(projectRoot, ".ai-memory", BM25_CACHE_FILE);
  try { fs.unlinkSync(cachePath); } catch {}
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
        type: "script",
        topic: (currentCall.description || "").slice(0, 80),
        tags: ["auto-capture", "bash", "script", "retry-success", ...tags],
        command: currentCall.command || "",
        description: currentCall.description || "",
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
      type: "script",
      topic: (currentCall.description || "").slice(0, 80),
      tags: ["auto-capture", "bash", "script", "discovery", ...tags],
      command: currentCall.command || "",
      description: currentCall.description || "",
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
 * Auto-save a detected capture. Routes scripts to scripts.jsonl,
 * everything else to research.jsonl.
 */
function autoSaveCapture(projectRoot, capture) {
  // Route scripts to the script library (returns null if trivial one-liner)
  if (capture.type === "script" && capture.command) {
    const saved = autoSaveScript(projectRoot, capture);
    if (saved) return saved;
    return null; // trivial command, not worth saving anywhere
  }

  // Original research save path
  const crypto = require("crypto");
  const researchPath = path.join(projectRoot, ".ai-memory", "research.jsonl");

  // Dedup check: skip if similar entry already exists
  try {
    const existing = readJsonl(researchPath);
    const similar = findSimilarEntry(existing, capture.topic, capture.tags);
    if (similar) return similar; // already saved, return existing
  } catch { /* non-critical — save anyway if dedup fails */ }

  const entry = {
    id: crypto.randomBytes(4).toString("hex"),
    ts: new Date().toISOString(),
    topic: capture.topic,
    tags: capture.tags,
    finding: capture.finding || "",
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

/**
 * Auto-save a script to .ai-memory/scripts.jsonl with parameterization.
 * Only saves scripts with real logic — skips trivial one-liners.
 */
function autoSaveScript(projectRoot, capture) {
  // Filter out trivial one-liners that aren't worth saving
  if (!isReusableScript(capture.command)) {
    return null;
  }

  const crypto = require("crypto");
  const { template, parameters } = parameterizeCommand(capture.command, capture.description);

  // Dedup: if template already exists, just bump usage count
  const existing = readScripts(projectRoot);
  const duplicate = findDuplicateScript(existing, template);
  if (duplicate) {
    updateScript(projectRoot, duplicate.id, {
      usage_count: (duplicate.usage_count || 1) + 1,
      last_used: new Date().toISOString(),
    });
    return duplicate;
  }

  const entry = {
    id: "scr_" + crypto.randomBytes(4).toString("hex"),
    ts: new Date().toISOString(),
    name: capture.topic || capture.description || "Untitled script",
    description: capture.description || "",
    tags: (capture.tags || []).filter(t => t !== "auto-capture" && t !== "script"),
    template,
    parameters,
    original_command: capture.command,
    usage_count: 1,
    last_used: new Date().toISOString(),
    source: "auto-capture",
  };

  appendScript(projectRoot, entry);
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

// ── Script Library ──

const SCRIPTS_FILE = "scripts.jsonl";

/**
 * Determine if a command is a reusable script worth saving.
 * Filters out trivial one-liners (cat, grep, ls, find, head, tail, sed, etc.)
 * that Claude can generate on-the-fly with its standard tools.
 *
 * A reusable script has REAL LOGIC: multi-step pipelines, authentication,
 * loops, API calls with structured payloads, data processing chains.
 */
function isReusableScript(command) {
  if (!command) return false;
  const cmd = command.trim();

  // Must have meaningful length — short commands are never reusable scripts
  if (cmd.length < 100) return false;

  // Positive signals: real script patterns
  const SCRIPT_PATTERNS = [
    /\bTOKEN\s*=\s*\$\(/,              // authentication token retrieval
    /\bBearer\b/,                       // bearer auth
    /\baz\s+account\b/,                // Azure CLI auth
    /\bcurl\s.*-X\s*(POST|PUT|PATCH)/i, // HTTP mutations (not just GET)
    /\bfor\s+\w+\s+in\b/,              // for loops
    /\bwhile\b/,                        // while loops
    /\bif\s*\[/,                        // conditionals
    /\bnode\s+-e\s*"/,                  // inline Node.js scripts
    /\bpython[3]?\s+-[ce]\s/,          // inline Python scripts
    /process\.stdin/,                   // stdin processing (data pipelines)
    /-d\s*'\{/,                         // JSON payloads in curl
    /-d\s*'\[/,                         // JSON array payloads
    /\|\s*node\b/,                      // piping to node
    /\|\s*python/,                      // piping to python
  ];
  if (SCRIPT_PATTERNS.some(p => p.test(cmd))) return true;

  // Multi-statement commands (&&, ||, ;) with curl or API calls
  const statements = cmd.split(/\s*&&\s*|\s*\|\|\s*|\s*;\s*/).filter(s => s.trim().length > 10);
  if (statements.length >= 2 && /\bcurl\b/.test(cmd)) return true;

  // Negative signals: general-purpose one-liners Claude can always generate
  const TRIVIAL_PATTERNS = [
    /^\s*cat\s/,                // cat file
    /^\s*head\s/,               // head file
    /^\s*tail\s/,               // tail file
    /^\s*sed\s/,                // sed on file
    /^\s*awk\s/,                // awk on file
    /^\s*grep\s/,               // grep pattern
    /^\s*rg\s/,                 // ripgrep
    /^\s*find\s/,               // find files
    /^\s*ls\s/,                 // list files
    /^\s*wc\s/,                 // word count
    /^\s*diff\s/,               // diff files
    /^\s*sort\s/,               // sort
    /^\s*uniq\s/,               // unique
    /^\s*echo\s/,               // echo
    /^\s*pwd\s*$/,              // pwd
    /^\s*which\s/,              // which
    /^\s*type\s/,               // type
    /^\s*file\s/,               // file type
    /^\s*stat\s/,               // file stats
    /^\s*du\s/,                 // disk usage
    /^\s*test\s/,               // test conditionals
    /^\s*\[\s/,                 // test bracket
    /^\s*powershell\s+-Command\s+"Get-Content/,  // simple PS file read
  ];
  if (TRIVIAL_PATTERNS.some(p => p.test(cmd))) return false;

  // Simple pipes to basic tools (cat file | grep | head) are not reusable
  if (/^\s*(cat|head|tail|grep|find|ls)\s/.test(cmd) && cmd.split("|").length <= 3) return false;

  // curl GET without auth or complex processing — borderline, allow if long enough
  if (/^\s*curl\s/.test(cmd) && cmd.length >= 150) return true;

  // Default: only save if it has multiple statements or is sufficiently complex
  return statements.length >= 2 && cmd.length >= 120;
}

/**
 * Detect and replace variable parts of a command with {{param}} placeholders.
 * Returns: { template: string, parameters: [{name, description, default}] }
 */
function parameterizeCommand(command, description) {
  const params = [];
  let template = command;
  const usedNames = new Set();

  function addParam(name, desc, defaultVal) {
    let finalName = name;
    let suffix = 2;
    while (usedNames.has(finalName)) {
      finalName = `${name}_${suffix++}`;
    }
    usedNames.add(finalName);
    params.push({ name: finalName, description: desc, default: defaultVal });
    return `{{${finalName}}}`;
  }

  // 1. UUIDs — context-aware naming from preceding URL path
  template = template.replace(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
    (match, uuid, offset) => {
      const preceding = template.substring(Math.max(0, offset - 50), offset);
      let name = "uuid";
      if (/repositor(y|ies)\/?$/i.test(preceding)) name = "repo_id";
      else if (/projects?\/?$/i.test(preceding)) name = "project_id";
      else if (/builds?\/?$/i.test(preceding)) name = "build_id";
      else if (/pullrequests?\/?$/i.test(preceding)) name = "pr_id";
      else if (/--resource\s+$/i.test(preceding)) name = "resource_id";
      return addParam(name, name.replace(/_/g, " "), uuid);
    }
  );

  // 2. Numeric IDs in URL paths: /builds/12345, /logs/402, /runs/99
  template = template.replace(
    /\/(builds|logs|runs|pullrequests|workitems|iterations)\/(\d+)/gi,
    (match, resource, id) => {
      const singular = resource.replace(/s$/i, "");
      const name = `${singular}_id`;
      return `/${resource}/${addParam(name, `${singular} ID`, id)}`;
    }
  );

  // 3. Absolute file paths in double quotes (Windows and Unix)
  template = template.replace(
    /"([A-Z]:\\[^"]{10,})"/g,
    (match, winPath) => {
      if (winPath.includes("project-memory/scripts/") || winPath.includes("project-memory\\scripts\\")) return match;
      return `"${addParam("file_path", "file path", winPath)}"`;
    }
  );
  template = template.replace(
    /"(\/(?:tmp|home|var|usr|opt)\/[^"]{10,})"/g,
    (match, unixPath) => {
      return `"${addParam("file_path", "file path", unixPath)}"`;
    }
  );

  // 4. JSON body variable string values (titles, descriptions in POST bodies)
  template = template.replace(
    /"(title|description|name|message|value)":\s*"([^"]{20,})"/gi,
    (match, key, value) => {
      return `"${key}": "${addParam(key, `${key} text`, value)}"`;
    }
  );

  return { template, parameters: params };
}

/**
 * Normalize a template for dedup comparison.
 * Collapses whitespace and replaces param names with a generic placeholder.
 */
function normalizeTemplate(template) {
  return template
    .replace(/\s+/g, " ")
    .replace(/\{\{[^}]+\}\}/g, "{{PARAM}}")
    .trim();
}

/**
 * Extract structural skeleton of a script for grouping near-duplicates.
 * Strips params, JSON payloads, specific URLs — keeps tool + flags + structure.
 * Scripts with the same skeleton are "the same template with different endpoints".
 */
function extractScriptSkeleton(template) {
  return (template || "")
    .replace(/\{\{[^}]+\}\}/g, "X")          // params → X
    .replace(/"[^"]{30,}"/g, '"..."')          // long strings → "..."
    .replace(/\{[^}]{50,}\}/g, "{...}")        // long JSON bodies → {...}
    .replace(/https?:\/\/[^\s"]+/g, "URL")     // URLs → URL
    .replace(/[0-9a-f]{8,}/gi, "HEX")         // hex strings → HEX
    .replace(/\d{5,}/g, "NUM")                 // long numbers → NUM
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200); // cap for comparison
}

/**
 * Group scripts by structural skeleton.
 * Returns: [{ skeleton, scripts: [...], totalUsage }] sorted by totalUsage desc.
 */
function groupScriptsByTemplate(scripts) {
  const groups = {};
  for (const s of scripts) {
    const skeleton = extractScriptSkeleton(s.template);
    if (!groups[skeleton]) groups[skeleton] = { skeleton, scripts: [], totalUsage: 0 };
    groups[skeleton].scripts.push(s);
    groups[skeleton].totalUsage += (s.usage_count || 1);
  }
  return Object.values(groups).sort((a, b) => b.totalUsage - a.totalUsage);
}

/**
 * Find an existing script with the same template (after normalization).
 */
function findDuplicateScript(scripts, newTemplate) {
  const normalized = normalizeTemplate(newTemplate);
  for (const script of scripts) {
    if (normalizeTemplate(script.template) === normalized) {
      return script;
    }
  }
  return null;
}

function readScripts(projectRoot) {
  return readJsonl(path.join(projectRoot, ".ai-memory", SCRIPTS_FILE));
}

function appendScript(projectRoot, entry) {
  appendJsonl(path.join(projectRoot, ".ai-memory", SCRIPTS_FILE), entry);
}

/**
 * Update a script entry by ID (rewrites file).
 */
function updateScript(projectRoot, scriptId, updates) {
  const scriptsPath = path.join(projectRoot, ".ai-memory", SCRIPTS_FILE);
  const scripts = readJsonl(scriptsPath);
  const updated = scripts.map(s => {
    if (s.id === scriptId) return { ...s, ...updates };
    return s;
  });
  fs.writeFileSync(scriptsPath, updated.map(s => JSON.stringify(s)).join("\n") + "\n", "utf-8");
}

/**
 * Search scripts library by BM25 on name + description + tags.
 * Returns: [{ docId, score, script }]
 */
function searchScripts(projectRoot, query) {
  const scripts = readScripts(projectRoot);
  if (scripts.length === 0) return [];

  const searchable = scripts.map(s => ({
    id: s.id,
    topic: s.name || "",
    tags: s.tags || [],
    finding: [s.name || "", s.description || "", (s.tags || []).join(" ")].join(" "),
  }));

  const index = buildBM25Index(searchable);
  const results = bm25Score(query, index);

  const scriptMap = {};
  for (const s of scripts) scriptMap[s.id] = s;

  return results.map(r => ({
    ...r,
    script: scriptMap[r.docId],
  })).filter(r => r.script);
}

// ── Hook Shared Functions ──
// Previously duplicated across pre-tool-use.js, post-tool-use.js, session-start.js

// ANSI color constants
const ANSI = {
  M: "\x1b[95m",  // bright magenta
  B: "\x1b[1m",   // bold
  R: "\x1b[0m",   // reset
  G: "\x1b[92m",  // bright green
  Y: "\x1b[93m",  // bright yellow
  C: "\x1b[96m",  // bright cyan
  D: "\x1b[2m",   // dim
};

// Hook constants
const MATCHED_TOOLS = new Set(["Bash", "WebFetch", "WebSearch", "Task"]);
const LIGHTWEIGHT_TOOLS = new Set(["Read", "Grep", "Glob"]);
const IMMEDIATE_SAVE_TOOLS = new Set(["Task", "WebSearch", "WebFetch"]);
const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate"]);
const EXPLORATION_SUBAGENTS = new Set(["Explore", "Plan", "general-purpose", "feature-dev:code-explorer", "feature-dev:code-architect"]);
const ESCALATION_THRESHOLD = 2;
const THROTTLE_MS = 3 * 60 * 1000;
const MEMORY_CHECK_TTL_MS = 2 * 60 * 1000;
const SUMMARY_CHECKPOINT_CALLS = 40;

/**
 * Debug logging for hooks.
 * @param {string} projectRoot - project root path (can be null)
 * @param {string} prefix - "PRE" or "POST" or "START"
 * @param {string} msg - log message
 */
function debugLog(projectRoot, prefix, msg) {
  try {
    const logPath = projectRoot
      ? path.join(projectRoot, ".ai-memory", ".hook-debug.log")
      : path.join(process.env.USERPROFILE || process.env.HOME || "/tmp", ".hook-debug.log");
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] ${prefix}: ${msg}\n`, "utf-8");
  } catch { /* non-critical */ }
}

/**
 * Resolve project root for hooks (differs from script resolveProjectRoot by accepting cwd+sessionId).
 */
function resolveHookProjectRoot(cwd, sessionId) {
  // Fast path: walk up from cwd (works when cwd is inside project)
  const root = findProjectRoot(cwd);
  if (root) return root;

  // Session registry: written by session-start, avoids filesystem scan
  if (sessionId) {
    try {
      const sessFile = path.join(
        process.env.USERPROFILE || process.env.HOME || "/tmp",
        ".ai-memory-sessions",
        sessionId
      );
      const savedRoot = fs.readFileSync(sessFile, "utf-8").trim();
      if (savedRoot && fs.existsSync(path.join(savedRoot, ".ai-memory"))) {
        return savedRoot;
      }
    } catch { /* not found */ }
  }

  // Cached project root from session state (avoids expensive scanHomeForProjects)
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const cachedStatePath = path.join(home, ".ai-memory-cached-root");
  try {
    const cached = fs.readFileSync(cachedStatePath, "utf-8").trim();
    if (cached && fs.existsSync(path.join(cached, ".ai-memory"))) {
      return cached;
    }
  } catch {}

  // Expensive fallback: scan USERPROFILE children
  const scanned = scanHomeForProjects();
  if (scanned) {
    // Cache for future hook calls in this session
    try { fs.writeFileSync(cachedStatePath, scanned, "utf-8"); } catch {}
  }
  return scanned;
}

/**
 * Check if a Bash command is a save/check-memory self-call.
 */
function isSelfCall(input) {
  if (!input || !input.tool_input) return false;
  const cmd = input.tool_input.command || "";
  return (
    cmd.includes("save-decision") ||
    cmd.includes("save-research") ||
    cmd.includes("check-memory") ||
    cmd.includes("session-summary")
  );
}

// ── Intent Detection ──

const EXPLORATION_KEYWORDS = [
  /\bsearch/i, /\binvestigat/i, /\bexplor/i, /\bexamin/i,
  /\binspect/i, /\bunderstand/i, /\banalyz/i, /\bresearch/i,
  /\bdebug/i, /\btrac(e|ing)\b/i, /\blook\s*(for|at|into|up)\b/i,
  /\bfind\s+(out|where|how|what|why)\b/i, /\bidentif/i,
  /\bdetermin/i, /\bfigure\s+out/i, /\bbrows/i, /\bscan/i,
  /\bcheck\s+(if|whether|what|how|where|content)/i,
  /\bwhat\s+(is|are|does)/i, /\bhow\s+(does|do|is|to)/i,
  /\bwhere\s+(is|are|does)/i, /\blist\s+(all|the|every|content)/i,
  /\bshow\s+(the|all|me|current)/i, /\bread\b/i, /\bview/i,
];

const OPERATIONAL_KEYWORDS = [
  /\bcreat/i, /\bbuild/i, /\brebuild/i, /\binstall/i, /\brun\b/i,
  /\bstart/i, /\bdeploy/i, /\bpush/i, /\bcommit/i,
  /\bcompil/i, /\btest/i, /\bserv/i, /\bclean/i,
  /\bdelet/i, /\bmov/i, /\bcopy/i, /\brenam/i,
  /\bset\s*up/i, /\bconfigur/i, /\binitializ/i, /\bgenerat/i,
  /\bwrit/i, /\bmak/i, /\bupdat/i, /\bfix/i,
  /\bapply/i, /\bexecut/i, /\blaunch/i, /\brestart/i,
  /\bstop\b/i, /\bkill/i, /\bformat/i, /\blint/i,
  /\bpropagate/i, /\bcopy.*to\b/i, /\bsync/i,
];

const SAFE_OPERATIONAL_PATTERNS = [
  /^\s*mkdir\b/,
  /^\s*touch\b/,
  /^\s*cp\b/,
  /^\s*mv\b/,
  /^\s*rm\b/,
  /^\s*chmod\b/,
  /^\s*chown\b/,
  /^\s*ln\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*cat\s*>/,
  /^\s*npm\s+(install|ci|run|start|build|test)\b/,
  /^\s*npx\b/,
  /^\s*node\s+[^-]/,
  /^\s*git\s+(add|commit|push|pull|checkout|switch|branch|merge|rebase|stash|tag|fetch|clone|init)\b/,
  /^\s*pip\s+install\b/,
  /^\s*docker\s+(build|run|push|pull|start|stop|rm|exec)\b/,
  /^\s*cd\b/,
  /^\s*pwd\b/,
  /^\s*curl\s.*-X\s*(POST|PUT|PATCH|DELETE)\b/i,  // HTTP mutations are operational
];

const EXPLORATION_PATTERNS = [
  /\bcurl\s/,
  /\bwget\s/,
  /\bgit\s+log\b/,
  /\bgit\s+show\b/,
  /\bgit\s+blame\b/,
  /\bgrep\s/,
  /\brg\s/,
  /\bag\s/,
  /\back\s/,
  /\blocate\s/,
  /\bnpm\s+(info|search|view)\b/,
  /\bpip\s+(show|search)\b/,
];

const RESEARCH_COMMAND_PATTERNS = [
  /\bwget\s/,
  /\|\s*(python|python3|node|jq|grep|awk|sed)\b/,
  /\bgit\s+(log|show|blame|diff)\b/,
  /\bgrep\b/,
  /\brg\s/,
  /\bfind\s/,
  /\btail\s/,
  /\bcat\s+[^>]/,
  /\bhead\s/,
  /\bwc\s/,
  /api-version=/,
  /localhost:\d+/,
];

/**
 * Layered intent detection for Bash commands.
 */
function isExploratoryBash(input) {
  if (!input || !input.tool_input) return false;
  const cmd = input.tool_input.command || "";
  const desc = (input.tool_input.description || "");

  // Layer 0: Safelist — obviously operational commands
  if (SAFE_OPERATIONAL_PATTERNS.some(p => p.test(cmd))) return false;

  // Layer 1: Command structure — but exclude curl POST/PUT/PATCH/DELETE (operational mutations)
  if (/\bcurl\s/.test(cmd) && /\b-X\s*(POST|PUT|PATCH|DELETE)\b/i.test(cmd)) {
    // curl mutation — operational, not research
  } else if (RESEARCH_COMMAND_PATTERNS.some(p => p.test(cmd))) {
    return true;
  }

  // Layer 2: Description keyword scoring
  if (desc.length > 5) {
    const explorationScore = EXPLORATION_KEYWORDS.filter(p => p.test(desc)).length;
    const operationalScore = OPERATIONAL_KEYWORDS.filter(p => p.test(desc)).length;
    if (explorationScore > operationalScore) return true;
    if (operationalScore > explorationScore) return false;
  }

  // Layer 3: Command regex fallback
  return EXPLORATION_PATTERNS.some(p => p.test(cmd));
}

function isExploratoryTask(input) {
  const subagentType = (input.tool_input || {}).subagent_type || "";
  return EXPLORATION_SUBAGENTS.has(subagentType);
}

// ── Session State Management ──

const SESSION_STATE_FILE = ".session-state.json";
const SESSION_STATE_VERSION = 1;

function getDefaultSessionState() {
  return {
    version: SESSION_STATE_VERSION,
    sessionId: "",
    startTs: Date.now(),
    reminder: { ts: 0, reminderCount: 0, lastSaveTs: 0 },
    memoryCheck: { lastCheckTs: 0 },
    taskTracker: { created: 0, completed: 0, toolCallsSinceSummary: 0 },
    cacheHits: [],
    lastInjection: { ts: 0, query: "" },
    hookTimings: [],
  };
}

function readSessionState(projectRoot) {
  const statePath = path.join(projectRoot, ".ai-memory", SESSION_STATE_FILE);
  const defaults = getDefaultSessionState();
  try {
    const raw = fs.readFileSync(statePath, "utf-8").trim();
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (parsed.version !== SESSION_STATE_VERSION) return defaults;
    // Deep merge with defaults to fill missing fields
    return {
      ...defaults,
      ...parsed,
      reminder: { ...defaults.reminder, ...(parsed.reminder || {}) },
      memoryCheck: { ...defaults.memoryCheck, ...(parsed.memoryCheck || {}) },
      taskTracker: { ...defaults.taskTracker, ...(parsed.taskTracker || {}) },
      lastInjection: { ...defaults.lastInjection, ...(parsed.lastInjection || {}) },
    };
  } catch {
    return defaults;
  }
}

function writeSessionState(projectRoot, state) {
  const statePath = path.join(projectRoot, ".ai-memory", SESSION_STATE_FILE);
  try {
    fs.writeFileSync(statePath, JSON.stringify(state), "utf-8");
  } catch { /* non-critical */ }
}

/**
 * Check if research.jsonl has any entries (fast stat check).
 */
function hasResearch(projectRoot) {
  try {
    const stat = fs.statSync(path.join(projectRoot, ".ai-memory", "research.jsonl"));
    return stat.size > 50;
  } catch {
    return false;
  }
}

/**
 * Get the most recent mtime of decisions.jsonl and research.jsonl.
 */
function getLastSaveTs(projectRoot) {
  let maxMtime = 0;
  for (const file of ["decisions.jsonl", "research.jsonl"]) {
    try {
      const stat = fs.statSync(path.join(projectRoot, ".ai-memory", file));
      if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
    } catch {}
  }
  return maxMtime;
}

/**
 * Search past explorations and format for hook injection.
 */
function searchExplorationsForHook(projectRoot, query) {
  const results = searchExplorations(projectRoot, query);
  const hits = results.filter(r => r.score > 0.5).slice(0, 3);
  if (hits.length === 0) return [];

  const explorationsDir = path.join(projectRoot, ".ai-memory", "explorations");
  return hits.map(h => {
    const entry = h.entry;
    return {
      agent: entry.agent || "unknown",
      date: entry.ts ? entry.ts.substring(0, 10) : "unknown",
      charCount: entry.charCount || 0,
      query: (entry.query || "").slice(0, 150),
      filePath: path.join(explorationsDir, entry.filename).replace(/\\/g, "/"),
    };
  });
}

// ── Workflow Chain Detection & Skill Generation ──

const WORKFLOW_CANDIDATES_FILE = "workflow-candidates.jsonl";
const CHAIN_GAP_MS = 90000; // 90 seconds max gap between chain steps
const MIN_CHAIN_LENGTH = 2;
const MAX_CHAIN_LENGTH = 8;

const TRIVIAL_COMMANDS = /^\s*(ls|dir|cat|head|tail|echo|cd|pwd|whoami|date|clear|cls|type|set|env|which|where)\b/i;

function isTrivialCommand(entry) {
  if (!entry || !entry.command) return true;
  const cmd = entry.command.trim();
  if (cmd.length < 30) return true;
  if (TRIVIAL_COMMANDS.test(cmd)) return true;
  // Skip pure read/navigation commands
  if (/^\s*(ls|find|dir|tree)\s/i.test(cmd) && !/\|\s*(node|python|grep)/i.test(cmd)) return true;
  return false;
}

/**
 * Extract a chain of consecutive successful non-trivial commands from tool history.
 * Groups commands within CHAIN_GAP_MS temporal windows.
 * Returns array of history entries or null if chain too short.
 */
function extractChain(projectRoot, currentCall) {
  const history = readToolHistory(projectRoot);
  if (history.length < 1) return null;

  const chain = [];
  // Walk backwards, collect non-trivial successful commands within gap
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!entry.success) break; // chain breaks on failure
    if (isTrivialCommand(entry)) continue;
    if (chain.length > 0) {
      const gap = new Date(chain[0].ts).getTime() - new Date(entry.ts).getTime();
      if (gap > CHAIN_GAP_MS) break;
    }
    chain.unshift(entry);
    if (chain.length >= MAX_CHAIN_LENGTH) break;
  }

  // Add current call if non-trivial
  if (currentCall && currentCall.success && !isTrivialCommand(currentCall)) {
    chain.push(currentCall);
  }

  return chain.length >= MIN_CHAIN_LENGTH ? chain : null;
}

/**
 * Create a fingerprint from a chain for deduplication.
 * Uses script skeletons — strips parameters, keeps structure.
 */
function fingerprintChain(chain) {
  return chain.map(entry => {
    const cmd = (entry.command || "").trim();
    return extractScriptSkeleton(parameterizeCommand(cmd, entry.description || "").template);
  });
}

/**
 * Check fingerprint overlap between two chains.
 * Returns overlap ratio (0-1).
 */
function chainOverlap(fp1, fp2) {
  if (fp1.length === 0 || fp2.length === 0) return 0;
  let matches = 0;
  const shorter = fp1.length <= fp2.length ? fp1 : fp2;
  const longer = fp1.length <= fp2.length ? fp2 : fp1;
  for (let i = 0; i < shorter.length; i++) {
    // Check if skeleton i in shorter matches any in longer (within ±1 position)
    for (let j = Math.max(0, i - 1); j <= Math.min(longer.length - 1, i + 1); j++) {
      if (shorter[i] === longer[j]) { matches++; break; }
    }
  }
  return matches / Math.max(fp1.length, fp2.length);
}

/**
 * Build workflow steps from a chain, matching against existing scripts.
 */
function buildWorkflowSteps(projectRoot, chain) {
  const scripts = readScripts(projectRoot);
  const steps = [];

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const cmd = (entry.command || "").trim();
    const { template, parameters } = parameterizeCommand(cmd, entry.description || "");

    // Try matching to an existing script
    let matchedScript = null;
    const entrySkeleton = extractScriptSkeleton(template);
    for (const script of scripts) {
      const scriptSkeleton = extractScriptSkeleton(script.template);
      if (entrySkeleton === scriptSkeleton) {
        matchedScript = script;
        break;
      }
    }

    steps.push({
      order: i + 1,
      scriptId: matchedScript ? matchedScript.id : null,
      name: matchedScript ? matchedScript.name : (entry.description || `Step ${i + 1}`),
      template: matchedScript ? matchedScript.template : template,
      params: matchedScript ? matchedScript.parameters : parameters,
      command: cmd,
    });
  }

  return steps;
}

/**
 * Extract shared parameters across workflow steps.
 */
function mergeWorkflowParams(steps) {
  const paramMap = new Map(); // name -> { description, default }
  for (const step of steps) {
    for (const p of (step.params || [])) {
      if (!paramMap.has(p.name)) {
        paramMap.set(p.name, { name: p.name, description: p.description, default: p.default });
      }
    }
  }
  return Array.from(paramMap.values());
}

/**
 * Generate a human-readable name for a workflow from its steps.
 */
function generateWorkflowName(steps) {
  const keywords = new Set();
  for (const step of steps) {
    const name = (step.name || "").toLowerCase();
    for (const kw of ["build", "test", "deploy", "analyze", "download", "fetch", "parse", "log", "timeline", "artifact", "results"]) {
      if (name.includes(kw)) keywords.add(kw);
    }
  }
  if (keywords.size === 0) return `Workflow: ${steps[0].name}`;
  const parts = Array.from(keywords).slice(0, 3);
  return parts.map(w => w[0].toUpperCase() + w.slice(1)).join(" + ") + " Pipeline";
}

function readWorkflowCandidates(projectRoot) {
  return readJsonl(path.join(projectRoot, ".ai-memory", WORKFLOW_CANDIDATES_FILE));
}

function appendWorkflowCandidate(projectRoot, candidate) {
  appendJsonl(path.join(projectRoot, ".ai-memory", WORKFLOW_CANDIDATES_FILE), candidate);
}

function updateWorkflowCandidate(projectRoot, candidateId, updates) {
  const filePath = path.join(projectRoot, ".ai-memory", WORKFLOW_CANDIDATES_FILE);
  const candidates = readJsonl(filePath);
  const updated = candidates.map(c => c.id === candidateId ? { ...c, ...updates } : c);
  fs.writeFileSync(filePath, updated.map(c => JSON.stringify(c)).join("\n") + "\n", "utf-8");
}

/**
 * Match a chain against existing workflow candidates, or create a new one.
 * Returns the matched/created candidate, or null if chain doesn't qualify.
 */
function matchOrCreateCandidate(projectRoot, chain, sessionId) {
  const steps = buildWorkflowSteps(projectRoot, chain);

  // Minimum quality: at least 1 step matches an existing script or is a reusable command
  const hasRealWork = steps.some(s =>
    s.scriptId || isReusableScript(s.command)
  );
  if (!hasRealWork) return null;

  // Combined template must be substantial
  const totalLength = steps.reduce((sum, s) => sum + (s.template || s.command || "").length, 0);
  if (totalLength < 200) return null;

  const fp = fingerprintChain(chain);
  const candidates = readWorkflowCandidates(projectRoot);

  // Try matching existing candidate
  for (const candidate of candidates) {
    if (candidate.status === "created") continue; // skip already-created skills
    const existingFp = (candidate.steps || []).map(s => extractScriptSkeleton(s.template || ""));
    if (chainOverlap(fp, existingFp) >= 0.7) {
      // Match found — add occurrence
      const occurrences = candidate.occurrences || [];
      occurrences.push({ sessionId: sessionId || "unknown", ts: new Date().toISOString() });
      updateWorkflowCandidate(projectRoot, candidate.id, { occurrences });
      return { ...candidate, occurrences };
    }
  }

  // No match — create new candidate
  const crypto = require("crypto");
  const newCandidate = {
    id: "wf_" + crypto.randomBytes(4).toString("hex"),
    name: generateWorkflowName(steps),
    steps,
    sharedParams: mergeWorkflowParams(steps),
    fingerprint: fp,
    occurrences: [{ sessionId: sessionId || "unknown", ts: new Date().toISOString() }],
    status: "candidate",
    skillPath: null,
    ts: new Date().toISOString(),
  };
  appendWorkflowCandidate(projectRoot, newCandidate);
  return newCandidate;
}

// ── MCP Hint Generation ──

/**
 * Generate _hints for an MCP tool response.
 * Guides Claude to the right follow-up tool based on current results.
 */
function generateHints(toolName, result, sessionState) {
  const hints = { next_steps: [], related: [], warnings: [] };

  if (toolName === "code_search" && result.data && result.data.length > 0) {
    const first = result.data[0];
    hints.next_steps.push(
      { tool: "code_context", suggestion: `Get callers/callees of ${first.qualified_name || first.name}` },
      { tool: "code_impact", suggestion: `Check blast radius of changes to ${first.name}` }
    );
    hints.related = result.data.slice(0, 5).map(n => n.file_path).filter(Boolean);
  } else if (toolName === "code_context") {
    if (result.callers && result.callers.length > 0) {
      hints.next_steps.push({ tool: "code_impact", suggestion: "Analyze blast radius" });
    }
    if (result.tests && result.tests.length === 0) {
      hints.warnings.push("No tests found (TESTED_BY edges missing)");
    }
    hints.next_steps.push({ tool: "code_structure", suggestion: "See module hierarchy" });
  } else if (toolName === "code_impact") {
    hints.next_steps.push({ tool: "code_search", suggestion: "Search for related code" });
  } else if (toolName === "memory_search") {
    hints.next_steps.push(
      { tool: "code_search", suggestion: "Search code graph for related entities" },
      { tool: "script_search", suggestion: "Find reusable scripts" }
    );
  } else if (toolName === "get_context") {
    hints.next_steps.push(
      { tool: "memory_search", suggestion: "Search prior research/decisions" },
      { tool: "code_search", suggestion: "Search code structure" }
    );
  }

  // Suppress tools already called this session
  if (sessionState && sessionState.toolsCalled) {
    const recentTools = new Set(sessionState.toolsCalled.slice(-10).map(t => t.tool));
    hints.next_steps = hints.next_steps.filter(s => !recentTools.has(s.tool));
  }

  return hints;
}

/**
 * Format a compact MCP response with hints.
 */
function formatMCPResponse(toolName, status, summary, data, sessionState) {
  const response = { status, summary };
  if (data !== undefined) response.data = data;
  response._hints = generateHints(toolName, { data, ...response }, sessionState);
  return response;
}

// ── MCP Session State (in-memory, per-server-process) ──

function createMCPSessionState() {
  return {
    toolsCalled: [],       // deque of last 20 {tool, ts}
    entitiesQueried: new Set(),
    filesExplored: new Set(),
    inferredIntent: "exploring",
  };
}

function recordMCPToolCall(sessionState, toolName, params) {
  if (!sessionState) return;
  sessionState.toolsCalled.push({ tool: toolName, ts: Date.now() });
  if (sessionState.toolsCalled.length > 20) {
    sessionState.toolsCalled.shift();
  }
  // Track queried entities
  if (params) {
    if (params.query) {
      for (const word of tokenize(params.query)) {
        sessionState.entitiesQueried.add(word);
      }
    }
    if (params.qualified_name) {
      sessionState.entitiesQueried.add(params.qualified_name);
    }
  }
}

module.exports = {
  findProjectRoot, scanHomeForProjects, resolveProjectRoot,
  readJsonl, appendJsonl, tokenize,
  readEntityIndex, writeEntityIndex, addToEntityIndex,
  appendBreadcrumb, readExplorationLog, clearExplorationLog, getUnsavedBreadcrumbs, EXPLORATION_LOG_FILE,
  buildBM25Index, bm25Score, buildAndCacheBM25, loadCachedBM25, invalidateBM25Cache,
  findSimilarEntry,
  appendToolHistory, readToolHistory, clearToolHistory, detectAutoCapture, autoSaveCapture, extractCommandTags,
  TOOL_HISTORY_FILE,
  // Exploration capture
  ensureExplorationsDir, readExplorationsIndex, appendExplorationIndex,
  extractFilePathsFromText, sanitizeFilename, extractTagsFromPrompt, searchExplorations,
  EXPLORATIONS_DIR, EXPLORATIONS_INDEX,
  // Script library
  isReusableScript, parameterizeCommand, normalizeTemplate, extractScriptSkeleton, groupScriptsByTemplate, findDuplicateScript,
  readScripts, appendScript, updateScript, searchScripts,
  SCRIPTS_FILE,
  // Hook shared functions
  ANSI, MATCHED_TOOLS, LIGHTWEIGHT_TOOLS, IMMEDIATE_SAVE_TOOLS, TASK_TOOLS,
  EXPLORATION_SUBAGENTS, ESCALATION_THRESHOLD, THROTTLE_MS, MEMORY_CHECK_TTL_MS, SUMMARY_CHECKPOINT_CALLS,
  debugLog, resolveHookProjectRoot, isSelfCall,
  isExploratoryBash, isExploratoryTask,
  SESSION_STATE_FILE, SESSION_STATE_VERSION, getDefaultSessionState, readSessionState, writeSessionState,
  hasResearch, getLastSaveTs, searchExplorationsForHook,
  // Workflow chain detection
  isTrivialCommand, extractChain, fingerprintChain, chainOverlap,
  buildWorkflowSteps, mergeWorkflowParams, generateWorkflowName,
  readWorkflowCandidates, appendWorkflowCandidate, updateWorkflowCandidate,
  matchOrCreateCandidate,
  WORKFLOW_CANDIDATES_FILE,
  // MCP hints + session state
  generateHints, formatMCPResponse, createMCPSessionState, recordMCPToolCall,
};
