#!/usr/bin/env node
"use strict";

/**
 * Memory daemon — single global TCP server that holds project-memory data
 * for ALL projects in memory. Hooks connect via TCP for fast searches (~10ms).
 *
 * Architecture: Per-project data Map. Projects are loaded lazily on first request.
 * Disk files are source of truth — daemon detects changes via fs.watchFile and reloads.
 *
 * Port/PID files: Global at ~/.ai-memory-daemon-port and ~/.ai-memory-daemon-pid
 *
 * Usage:
 *   node daemon.js                    — start global daemon
 *   node daemon.js --stop             — stop running daemon
 */

const fs = require("fs");
const path = require("path");
const net = require("net");

const shared = require(path.join(__dirname, "shared.js"));
const { EmbeddingCache } = require(path.join(__dirname, "embedding-cache.js"));
const {
  ANSI, MATCHED_TOOLS, LIGHTWEIGHT_TOOLS, IMMEDIATE_SAVE_TOOLS, TASK_TOOLS,
  ESCALATION_THRESHOLD, THROTTLE_MS, SUMMARY_CHECKPOINT_CALLS,
  isSelfCall, isExploratoryBash, isExploratoryTask,
  readSessionState, writeSessionState, getLastSaveTs,
  searchExplorationsForHook,
} = shared;

const { M, B, R, G, Y, C, D } = ANSI;

const home = process.env.USERPROFILE || process.env.HOME || "";
const portFile = path.join(home, ".ai-memory-daemon-port");
const pidFile = path.join(home, ".ai-memory-daemon-pid");
const tokenFile = path.join(home, ".ai-memory-daemon-token");
const pluginRoot = path.resolve(__dirname, "..").replace(/\\/g, "/");

// SECURITY: per-instance shared secret. Hooks read this file (mode 0600 where
// the OS supports it) and include the token in every IPC request. This blocks
// other local processes from impersonating the Claude Code hook and driving
// the daemon to read/write arbitrary paths under $HOME.
const crypto = require("crypto");
const DAEMON_TOKEN = crypto.randomBytes(32).toString("hex");

// SECURITY: cap per-IPC request size. Hook payloads are small JSON objects;
// 1 MB is well above any legitimate need and prevents memory pinning by a
// connection that never closes.
const MAX_IPC_BYTES = 1 * 1024 * 1024;

// ── Stop command ──
if (process.argv[2] === "--stop") {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    process.kill(pid, "SIGTERM");
    console.log(`Daemon stopped (PID ${pid})`);
  } catch {
    console.log("No daemon running");
  }
  process.exit(0);
}

// ══════════════════════════════════════════════════════════
// PER-PROJECT DATA STORE
// ══════════════════════════════════════════════════════════

const projects = new Map(); // projectRoot -> ProjectData
let lastActivity = Date.now();
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

function createEmptyProjectData(projectRoot) {
  return {
    projectRoot,
    memDir: path.join(projectRoot, ".ai-memory"),
    research: [],
    scripts: [],
    researchBM25: null,
    scriptBM25: null,
    graphAdj: null,
    explorations: [],
    config: {},
    watchersSetup: false,
    sourceWatcher: null,
    embeddingCache: new EmbeddingCache({ enabled: true, bitWidth: 3, useQJL: true }),
  };
}

function getOrLoadProject(projectRoot) {
  if (!projectRoot) return null;
  const normalized = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
  if (!projects.has(normalized)) {
    if (!fs.existsSync(path.join(normalized, ".ai-memory"))) return null;
    const data = createEmptyProjectData(normalized);
    projects.set(normalized, data);
    reloadProject(normalized, "all");
    setupProjectWatchers(normalized);
    setupSourceWatcher(normalized);
  }
  return projects.get(normalized);
}

function reloadProject(projectRoot, what) {
  const normalized = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
  let data = projects.get(normalized);
  if (!data) {
    data = createEmptyProjectData(normalized);
    projects.set(normalized, data);
  }
  const t = Date.now();
  if (what === "all" || what === "research") {
    data.research = shared.readJsonl(path.join(data.memDir, "research.jsonl"));
    data.researchBM25 = shared.buildBM25Index(data.research);
  }
  if (what === "all" || what === "scripts") {
    data.scripts = shared.readScripts(normalized);
    const searchable = data.scripts.map(s => ({
      id: s.id, topic: s.name || "", tags: s.tags || [],
      finding: [s.name || "", s.description || "", (s.tags || []).join(" ")].join(" "),
    }));
    data.scriptBM25 = shared.buildBM25Index(searchable);
  }
  if (what === "all" || what === "graph") {
    try {
      const graphMod = require(path.join(__dirname, "graph.js"));
      const triples = graphMod.readGraph(normalized);
      data.graphAdj = graphMod.buildAdjacencyIndex(triples);
    } catch { data.graphAdj = null; }
  }
  if (what === "all" || what === "explorations") {
    data.explorations = shared.readExplorationsIndex(normalized);
  }
  if (what === "all" || what === "config") {
    try {
      const configMod = require(path.join(__dirname, "config.js"));
      data.config = configMod.readConfig(normalized);
      // Re-initialize embedding cache with config settings
      const qConfig = data.config.quantization || {};
      data.embeddingCache = new EmbeddingCache({
        enabled: qConfig.enabled !== false,
        bitWidth: qConfig.bitWidth || 3,
        useQJL: qConfig.useQJL !== false,
        seed: qConfig.seed || 0,
      });
    } catch { data.config = {}; }
  }
  if (what === "all" || what === "embeddings") {
    // Load and cache embeddings if they exist
    loadEmbeddingsIntoCache(normalized, data);
  }
  const elapsed = Date.now() - t;
  logForProject(normalized, `RELOAD ${what}: ${elapsed}ms (research=${data.research.length}, scripts=${data.scripts.length}, explorations=${data.explorations.length})`);
}

function logForProject(projectRoot, msg) {
  shared.debugLog(projectRoot, "DAEMON", msg);
}

function loadEmbeddingsIntoCache(projectRoot, data) {
  const embPath = path.join(data.memDir, "embeddings.json");
  if (!fs.existsSync(embPath)) return;
  
  try {
    const embeddings = JSON.parse(fs.readFileSync(embPath, "utf-8"));
    data.embeddingCache.clear();
    
    let cached = 0;
    for (const [entryId, embedding] of Object.entries(embeddings)) {
      if (Array.isArray(embedding) && embedding.length === 384) {
        data.embeddingCache.cacheEmbedding(entryId, embedding, { ts: Date.now() });
        cached++;
      }
    }
    
    const stats = data.embeddingCache.getStats();
    logForProject(projectRoot, `Loaded ${cached} embeddings (${stats.compressionRatio}x compressed, ${stats.savingsPercent}% savings)`);
  } catch (err) {
    logForProject(projectRoot, `Failed to load embeddings: ${err.message}`);
  }
}


// ── File watchers (per-project) ──
function setupProjectWatchers(projectRoot) {
  const normalized = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const data = projects.get(normalized);
  if (!data || data.watchersSetup) return;
  data.watchersSetup = true;
  const watch = (file, what) => {
    const fullPath = path.join(data.memDir, file);
    if (fs.existsSync(fullPath)) {
      fs.watchFile(fullPath, { interval: 500 }, () => { reloadProject(normalized, what); });
    }
  };
  watch("research.jsonl", "research");
  watch("scripts.jsonl", "scripts");
  watch("graph.jsonl", "graph");
  watch(path.join("explorations", "explorations.jsonl"), "explorations");
  watch("embeddings.json", "embeddings");
}

// ── Source file watcher (incremental code graph updates) ──

const SOURCE_SKIP_DIRS = new Set([
  "node_modules", ".git", "bin", "obj", "dist", "build", ".vs",
  "__pycache__", ".mypy_cache", ".pytest_cache", "venv", "env",
  ".ai-memory", ".next", ".nuxt", "coverage", ".cache",
  "packages", "TestResults",
]);

function setupSourceWatcher(projectRoot) {
  const normalized = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const data = projects.get(normalized);
  if (!data || data.sourceWatcher) return;

  const codeParserMod = require(path.join(__dirname, "code-parser.js"));
  const codeGraphMod = require(path.join(__dirname, "code-graph.js"));
  const crypto = require("crypto");
  const supportedExts = new Set(Object.keys(codeParserMod.EXT_TO_LANG));

  // Debounce: collect changed files, batch-process after 500ms of quiet
  const pendingFiles = new Map(); // filePath -> timeoutId
  let parserInitialized = false;

  async function processFile(filePath) {
    try {
      if (!parserInitialized) {
        await codeParserMod.init();
        parserInitialized = true;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
      const { nodes, edges } = await codeParserMod.parseFile(filePath, content);
      for (const node of nodes) { if (node.kind === "File") node.file_hash = hash; }
      const db = codeGraphMod.open(normalized);
      codeGraphMod.replaceFile(db, filePath.replace(/\\/g, "/"), nodes, edges);
      codeGraphMod.close(db);
      logForProject(normalized, `SOURCE-WATCH-UPDATE: ${path.basename(filePath)} (+${nodes.length} nodes, +${edges.length} edges)`);
    } catch (err) {
      logForProject(normalized, `SOURCE-WATCH-ERROR: ${path.basename(filePath)}: ${err.message}`);
    }
  }

  try {
    // SECURITY: refuse to watch overly broad roots. A recursive fs.watch on
    // $HOME or a filesystem root explodes file-descriptor / memory usage and
    // can block the event loop while the OS enumerates the tree.
    const homeNorm = (process.env.USERPROFILE || process.env.HOME || "").replace(/\\/g, "/").replace(/\/$/, "");
    if (!normalized || normalized === homeNorm || normalized === "/" || /^[A-Za-z]:\/?$/.test(normalized)) {
      logForProject(normalized, `SOURCE-WATCHER-REFUSED: refusing to watch root/home`);
      return;
    }
    try {
      // Refuse projects with extreme top-level fan-out (likely an accidentally
      // very wide directory, not a real project).
      const topLevel = fs.readdirSync(normalized);
      if (topLevel.length > 5000) {
        logForProject(normalized, `SOURCE-WATCHER-REFUSED: top-level fan-out ${topLevel.length} > 5000`);
        return;
      }
    } catch { return; }

    const watcher = fs.watch(normalized, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      // Check extension
      const ext = path.extname(filename).toLowerCase();
      if (!supportedExts.has(ext)) return;

      // Check skip dirs — filename is relative to watched root
      const segments = filename.replace(/\\/g, "/").split("/");
      for (const seg of segments) {
        if (SOURCE_SKIP_DIRS.has(seg) || seg.startsWith(".")) return;
      }

      const fullPath = path.join(normalized, filename).replace(/\\/g, "/");

      // Debounce: reset timer for this file
      const existing = pendingFiles.get(fullPath);
      if (existing) clearTimeout(existing);
      pendingFiles.set(fullPath, setTimeout(() => {
        pendingFiles.delete(fullPath);
        // Only process if file still exists (not a delete event)
        if (fs.existsSync(fullPath)) {
          processFile(fullPath);
        }
      }, 500));
    });

    data.sourceWatcher = watcher;
    logForProject(normalized, `SOURCE-WATCHER: watching ${normalized} for code changes`);
  } catch (err) {
    logForProject(normalized, `SOURCE-WATCHER-INIT-ERROR: ${err.message}`);
  }
}

// ── BM25 search using in-memory index ──
function bm25Search(query, index, threshold, limit) {
  if (!index) return [];
  return shared.bm25Score(query, index).filter(r => r.score > threshold).slice(0, limit);
}

// ── Graph expansion using in-memory adjacency ──
function graphExpand(adj, seedEntities, depth) {
  if (!adj || seedEntities.length === 0) return { connections: [], relatedFindingIds: new Set() };
  const visited = new Set();
  const connections = [];
  const relatedFindingIds = new Set();
  let frontier = seedEntities.map(e => e.toLowerCase());
  for (let hop = 1; hop <= depth; hop++) {
    const next = [];
    for (const entity of frontier) {
      if (visited.has(entity)) continue;
      visited.add(entity);
      const edges = adj[entity] || [];
      for (const edge of edges) {
        if (!visited.has(edge.target)) {
          connections.push({ from: entity, predicate: edge.predicate, to: edge.target, src: edge.src, hop });
          relatedFindingIds.add(edge.src);
          next.push(edge.target);
        }
      }
    }
    frontier = next;
  }
  return { connections, relatedFindingIds };
}

// ── Exploration search using in-memory data ──
function searchExplorationsForProject(data, query) {
  if (data.explorations.length === 0) return [];
  const searchable = data.explorations.map(e => ({
    id: e.id, topic: e.query || "", tags: e.tags || [],
    finding: [e.query || "", (e.files || []).join(" "), (e.entities || []).join(" "), (e.tags || []).join(" ")].join(" "),
    _raw: e,
  }));
  const index = shared.buildBM25Index(searchable);
  const results = shared.bm25Score(query, index);
  const entryMap = {};
  for (const e of data.explorations) entryMap[e.id] = e;
  return results.filter(r => r.score > 0.5).slice(0, 3).map(r => {
    const entry = entryMap[r.docId];
    if (!entry) return null;
    const explorationsDir = path.join(data.memDir, "explorations");
    return {
      agent: entry.agent || "unknown",
      date: entry.ts ? entry.ts.substring(0, 10) : "unknown",
      charCount: entry.charCount || 0,
      query: (entry.query || "").slice(0, 150),
      filePath: path.join(explorationsDir, entry.filename).replace(/\\/g, "/"),
    };
  }).filter(Boolean);
}

// ── Resolve projectRoot for fallback mode ──
function resolveProjectRoot(explicitRoot, input) {
  if (explicitRoot) return explicitRoot;
  const cwd = (input && input.cwd) || process.cwd();
  return shared.findProjectRoot(cwd) || shared.scanHomeForProjects();
}

// ── Embedding search handler ──
function handleEmbeddingSearch(projectRoot, input) {
  const root = resolveProjectRoot(projectRoot, input);
  const data = getOrLoadProject(root);
  if (!data) return { results: [], error: "project not found" };
  
  const { entryId, topK = 5 } = input;
  if (!entryId) return { results: [], error: "entryId required" };
  
  // Get the embedding for this entry
  const queryEmbedding = data.embeddingCache.getEmbedding(entryId);
  if (!queryEmbedding) return { results: [], error: `embedding not found for ${entryId}` };
  
  // Compute inner products with all cached embeddings
  const scores = [];
  for (const [id, ] of data.embeddingCache.cache) {
    if (id === entryId) continue;
    const score = data.embeddingCache.computeInnerProduct(entryId, id);
    if (score !== null) {
      scores.push({ id, score });
    }
  }
  
  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);
  
  // Return top-K
  const results = scores.slice(0, topK).map(s => ({
    id: s.id,
    score: s.score,
  }));
  
  return {
    results,
    stats: data.embeddingCache.getStats(),
  };
}


// ══════════════════════════════════════════════════════════
// PRE-TOOL-USE HANDLER
// ══════════════════════════════════════════════════════════

function handlePreToolUse(projectRoot, input) {
  const root = resolveProjectRoot(projectRoot, input);
  const data = getOrLoadProject(root);
  if (!data) return {};

  // Skip lightweight tools and self-calls entirely
  if (LIGHTWEIGHT_TOOLS.has(input.tool_name)) return {};
  if (!MATCHED_TOOLS.has(input.tool_name)) return {};
  if (input.tool_name === "Bash" && isSelfCall(input)) return {};

  // Escalation check — deny if too many save reminders ignored
  const state = readSessionState(root);
  if (state.reminder.reminderCount > ESCALATION_THRESHOLD) {
    const currentSaveTs = getLastSaveTs(root);
    if (!(currentSaveTs > state.reminder.lastSaveTs)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `${M}${B}[project-memory] BLOCKED: ${state.reminder.reminderCount} save reminders ignored.${R}\n${M}You MUST save your discoveries NOW.${R}`,
        },
      };
    }
  }

  // Lightweight nudge for exploratory tools: suggest MCP tools instead
  const isExploratory = input.tool_name === "Bash" ? isExploratoryBash(input)
    : input.tool_name === "Task" ? isExploratoryTask(input) : false;

  if (isExploratory && data.research.length > 0) {
    return {
      systemMessage: `${C}${B}★ TIP: Use MCP tools for faster context:${R}\n${G}  • mcp__project-memory__memory_search — prior research/decisions${R}\n${G}  • mcp__project-memory__code_search — code structure (FTS5)${R}\n${G}  • mcp__project-memory__script_search — reusable scripts${R}`,
    };
  }

  return {};
}

// ══════════════════════════════════════════════════════════
// POST-TOOL-USE HANDLER
// ══════════════════════════════════════════════════════════

function handlePostToolUse(projectRoot, input) {
  const root = resolveProjectRoot(projectRoot, input);
  const data = getOrLoadProject(root);
  if (!data) return {};

  // Task completion tracking
  if (TASK_TOOLS.has(input.tool_name)) {
    const state = readSessionState(root);
    const tracker = state.taskTracker;
    if (input.tool_name === "TaskCreate") {
      tracker.created += 1;
      writeSessionState(root, state);
    } else if (input.tool_name === "TaskUpdate") {
      const status = (input.tool_input || {}).status;
      if (status === "completed") {
        tracker.completed += 1;
        writeSessionState(root, state);
        if (tracker.completed >= tracker.created && tracker.created > 0) {
          const border = "\u2500".repeat(49);
          return { decision: "block", reason: [
            `${G}${B}\u2605 All Tasks Complete ${border.slice(0,30)}${R}`,
            `${G}  \u2713 ${tracker.completed}/${tracker.created} tasks completed${R}`,
            `${G}  Run the session summary NOW:${R}`,
            `${G}  node "${pluginRoot}/scripts/session-summary.js"${R}`,
            `${G}${B}${border}${R}`,
          ].join("\n") };
        }
      } else if (status === "deleted") {
        tracker.created = Math.max(0, tracker.created - 1);
        writeSessionState(root, state);
      }
    }
  }

  // Code graph incremental update after file modifications (Write, Edit)
  if (input.tool_name === "Write" || input.tool_name === "Edit") {
    try {
      const toolInput = input.tool_input || {};
      const filePath = toolInput.file_path;
      if (filePath) {
        // SECURITY: refuse to read files outside the project root. Without
        // this check a malicious local IPC client could pass any file path
        // (e.g. ~/.aws/credentials) and have the daemon read & parse it.
        const resolvedFile = path.resolve(filePath);
        const resolvedRoot = path.resolve(root);
        if (!resolvedFile.startsWith(resolvedRoot + path.sep) && resolvedFile !== resolvedRoot) {
          logForProject(root, `CODE-GRAPH-REFUSED: file outside project root: ${filePath}`);
          return {};
        }
        const codeParserMod = require(path.join(__dirname, "code-parser.js"));
        const codeGraphMod = require(path.join(__dirname, "code-graph.js"));
        const ext = path.extname(filePath).toLowerCase();
        if (codeParserMod.EXT_TO_LANG[ext]) {
          // Async update — don't block the hook response
          setImmediate(async () => {
            try {
              await codeParserMod.init();
              const fs = require("fs");
              const content = fs.readFileSync(filePath, "utf-8");
              const { nodes, edges } = await codeParserMod.parseFile(filePath, content);
              const crypto = require("crypto");
              const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
              for (const node of nodes) { if (node.kind === "File") node.file_hash = hash; }
              const db = codeGraphMod.open(root);
              codeGraphMod.replaceFile(db, filePath.replace(/\\/g, "/"), nodes, edges);
              codeGraphMod.close(db);
              logForProject(root, `CODE-GRAPH-UPDATE: ${path.basename(filePath)} (+${nodes.length} nodes, +${edges.length} edges)`);
            } catch (err) {
              logForProject(root, `CODE-GRAPH-UPDATE-ERROR: ${err.message}`);
            }
          });
        }
      }
    } catch {}
  }

  if (!MATCHED_TOOLS.has(input.tool_name)) return {};
  if (input.tool_name === "Bash" && isSelfCall(input)) return {};

  // Periodic checkpoint
  const checkState = readSessionState(root);
  checkState.taskTracker.toolCallsSinceSummary += 1;
  writeSessionState(root, checkState);
  if (checkState.taskTracker.toolCallsSinceSummary >= SUMMARY_CHECKPOINT_CALLS) {
    const border = "\u2500".repeat(49);
    return { decision: "block", reason: [
      `${G}${B}\u2605 Summary Checkpoint ${border.slice(0,30)}${R}`,
      `${G}  ${checkState.taskTracker.toolCallsSinceSummary} tool calls since last summary${R}`,
      `${G}  Run the session summary NOW:${R}`,
      `${G}  node "${pluginRoot}/scripts/session-summary.js"${R}`,
      `${G}${B}${border}${R}`,
    ].join("\n") };
  }

  // Auto-capture for Bash (writes to disk — daemon will detect via watchFile)
  if (input.tool_name === "Bash") {
    try {
      const toolInput = input.tool_input || {};
      const toolResult = input.tool_result || {};
      const exitCode = toolResult.exit_code != null ? toolResult.exit_code : (toolResult.isError ? 1 : 0);
      const success = exitCode === 0 && !toolResult.isError;
      const record = {
        tool: input.tool_name, command: toolInput.command || "",
        description: toolInput.description || "", exitCode, success,
        exploratory: isExploratoryBash(input),
      };
      shared.appendToolHistory(root, record);
      if (success) {
        const capture = shared.detectAutoCapture(root, record);
        if (capture) {
          const saved = shared.autoSaveCapture(root, capture);
          if (saved) logForProject(root, `AUTO-CAPTURE: "${capture.topic}" (id: ${saved.id})`);
        }
      }

      // Workflow chain detection — detect multi-step patterns for skill generation
      if (success) {
        try {
          const chain = shared.extractChain(root, record);
          if (chain && chain.length >= 2) {
            const candidate = shared.matchOrCreateCandidate(root, chain, input.session_id);
            if (candidate && (candidate.occurrences || []).length >= 2 && candidate.status === "candidate") {
              shared.updateWorkflowCandidate(root, candidate.id, { status: "suggested" });
              const stepNames = (candidate.steps || []).map(s => s.name).slice(0, 4).join(" → ");
              const occCount = (candidate.occurrences || []).length;
              logForProject(root, `WORKFLOW-SUGGESTED: "${candidate.name}" (${occCount}x)`);
              // Return suggestion (non-blocking systemMessage)
              return { systemMessage: [
                `${C}${B}★ Skill Candidate Detected ─────────────────────${R}`,
                `${G}${B}  "${candidate.name}"${R} (seen ${occCount}x across sessions)`,
                `${G}  Steps: ${stepNames}${R}`,
                ``,
                `${Y}  To create a reusable /${candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)} skill:${R}`,
                `${Y}  node "${pluginRoot}/scripts/generate-skill.js" "${candidate.id}"${R}`,
                `${C}${B}─────────────────────────────────────────────────${R}`,
              ].join("\n") };
            }
          }
        } catch {}
      }
    } catch {}
  }

  // Intent-based exit
  if (input.tool_name === "Bash" && !isExploratoryBash(input)) return {};
  if (input.tool_name === "Task" && !isExploratoryTask(input)) return {};

  // Breadcrumb
  try {
    const toolInput = input.tool_input || {};
    const breadcrumb = { tool: input.tool_name };
    if (input.tool_name === "Task") breadcrumb.subagent = toolInput.subagent_type || "unknown";
    if (input.tool_name === "Bash") breadcrumb.prompt = (toolInput.description || "").slice(0, 200);
    shared.appendBreadcrumb(root, breadcrumb);
  } catch {}

  // Exploration capture (writes to disk)
  if (input.tool_name === "Task" && isExploratoryTask(input)) {
    try {
      const postMod = require(path.join(__dirname, "..", "hooks", "scripts", "post-tool-use-capture.js"));
      if (postMod && postMod.captureExploration) postMod.captureExploration(root, input);
    } catch {
      try {
        let rawOutput = typeof input.tool_response === "string" ? input.tool_response : "";
        if (rawOutput.length >= 200) {
          const crypto = require("crypto");
          const id = "exp_" + crypto.randomBytes(4).toString("hex");
          const ts = new Date().toISOString();
          const toolInput = input.tool_input || {};
          const filename = `${ts.replace(/[:.]/g, "-").slice(0, 19)}_${shared.sanitizeFilename(toolInput.description || "")}_${id.slice(-6)}.md`;
          const explDir = shared.ensureExplorationsDir(root);
          fs.writeFileSync(path.join(explDir, filename), rawOutput, "utf-8");
          shared.appendExplorationIndex(root, {
            id, ts, agent: toolInput.subagent_type || "unknown",
            query: (toolInput.prompt || "").slice(0, 300),
            tags: [], filename, charCount: rawOutput.length,
          });
          logForProject(root, `EXPLORATION-CAPTURE: ${id} chars=${rawOutput.length}`);
        }
      } catch {}
    }
  }

  // Immediate save tools blocking
  const state = readSessionState(root);
  if (IMMEDIATE_SAVE_TOOLS.has(input.tool_name)) {
    if (input.tool_name === "Task" && state.taskTracker.created > 0 && state.taskTracker.completed < state.taskTracker.created) return {};
    if (input.tool_name === "Task" && state.lastInjection && Date.now() - state.lastInjection.ts < 5000) return {};
    if (state.lastInjection && Date.now() - state.lastInjection.ts < 30000) {
      return { systemMessage: `${G}${B}★ Findings were injected — save any NEW discoveries when ready.${R}` };
    }

    const currentSaveTs = getLastSaveTs(root);
    if (currentSaveTs > state.reminder.lastSaveTs && state.reminder.lastSaveTs > 0) state.reminder.reminderCount = 0;
    state.reminder.reminderCount = ESCALATION_THRESHOLD + 1;
    state.reminder.ts = Date.now();
    state.reminder.lastSaveTs = Math.max(state.reminder.lastSaveTs, currentSaveTs);
    state.memoryCheck.lastCheckTs = 0;
    writeSessionState(root, state);

    const memChecked = state.memoryCheck.lastCheckTs > 0;
    const checkLine = memChecked ? "" : `\n${M}${B}STEP 1: Check memory FIRST:${R}\n${M}  node "${pluginRoot}/scripts/check-memory.js" "keywords"${R}\n${M}${B}STEP 2: Save NEW discoveries:${R}`;
    return { decision: "block", reason: `${M}${B}[project-memory] You just used ${input.tool_name} — knowledge WILL BE LOST if not saved.${R}${checkLine}\n${M}SAVE NOW:${R}\n${M}- node "${pluginRoot}/scripts/save-decision.js" "<cat>" "<decision>" "<rationale>"${R}\n${M}- node "${pluginRoot}/scripts/save-research.js" "<topic>" "<tags>" "<finding>"${R}\n${M}${B}Your next tool call will be DENIED until you save.${R}` };
  }

  // Gradual escalation for Bash
  if (Date.now() - state.reminder.ts < THROTTLE_MS) return {};
  const currentSaveTs = getLastSaveTs(root);
  if (currentSaveTs > state.reminder.lastSaveTs && state.reminder.lastSaveTs > 0) state.reminder.reminderCount = 0;
  state.reminder.reminderCount += 1;
  state.reminder.ts = Date.now();
  state.reminder.lastSaveTs = Math.max(state.reminder.lastSaveTs, currentSaveTs);
  writeSessionState(root, state);
  if (state.reminder.reminderCount <= ESCALATION_THRESHOLD) return {};

  return { decision: "block", reason: `${M}${B}[project-memory] Researching ~${state.reminder.reminderCount * 3}+ min without saving!${R}\n${M}STOP and save your discoveries:${R}\n${M}- node "${pluginRoot}/scripts/save-decision.js" "<cat>" "<decision>" "<rationale>"${R}\n${M}- node "${pluginRoot}/scripts/save-research.js" "<topic>" "<tags>" "<finding>"${R}` };
}

// ══════════════════════════════════════════════════════════
// TCP SERVER
// ══════════════════════════════════════════════════════════

function startServer() {
  const server = net.createServer((socket) => {
    lastActivity = Date.now();
    let data = "";
    let aborted = false;

    // SECURITY: hook IPC is sub-second by design. A 5s ceiling guarantees a
    // never-closing connection cannot pin memory or a socket forever.
    socket.setTimeout(5000, () => { aborted = true; try { socket.destroy(); } catch {} });

    socket.on("data", (chunk) => {
      if (aborted) return;
      data += chunk.toString();
      if (data.length > MAX_IPC_BYTES) {
        aborted = true;
        try { socket.end(JSON.stringify({ error: "request too large" }) + "\n"); } catch {}
        try { socket.destroy(); } catch {}
      }
    });
    socket.on("end", () => {
      if (aborted) return;
      try {
        const lineEnd = data.indexOf("\n");
        const json = lineEnd >= 0 ? data.slice(0, lineEnd) : data;
        const request = JSON.parse(json);

        // ── AuthN: shared-secret token (constant-time compare) ──
        // Skip auth ONLY for ping (used by liveness probes that may not have
        // the token yet, e.g. during startup races). All read/write handlers
        // require the token.
        if (request.type !== "ping") {
          const got = String(request && request.token || "");
          const want = DAEMON_TOKEN;
          let ok = got.length === want.length;
          if (ok) {
            try { ok = crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); }
            catch { ok = false; }
          }
          if (!ok) {
            socket.end(JSON.stringify({ error: "unauthorized" }) + "\n");
            return;
          }
        }

        // ── AuthZ: projectRoot must exist and contain .ai-memory ──
        // Without this an authenticated-but-malicious caller could still
        // point fs.watch at an arbitrary path. Hooks are the only legitimate
        // caller and they always supply a real project they've already
        // discovered via findMemDir().
        if (request.projectRoot) {
          const pr = String(request.projectRoot);
          const norm = path.resolve(pr);
          if (norm.split(path.sep).includes("..") ||
              !fs.existsSync(path.join(norm, ".ai-memory"))) {
            socket.end(JSON.stringify({ error: "invalid projectRoot" }) + "\n");
            return;
          }
          request.projectRoot = norm;
        }

        let response = {};

        const t = Date.now();
        if (request.type === "pre-tool-use") {
          response = handlePreToolUse(request.projectRoot, request.input || {});
        } else if (request.type === "post-tool-use") {
          response = handlePostToolUse(request.projectRoot, request.input || {});
        } else if (request.type === "embedding-search") {
          response = handleEmbeddingSearch(request.projectRoot, request.input || {});
        } else if (request.type === "ping") {
          const totalEntries = Array.from(projects.values()).reduce((sum, p) => sum + p.research.length, 0);
          response = { type: "pong", uptime: Math.round((Date.now() - startTime) / 1000), projects: projects.size, entries: totalEntries };
        }
        const elapsed = Date.now() - t;
        if (request.projectRoot) {
          logForProject(request.projectRoot, `IPC ${request.type}: ${elapsed}ms`);
        }

        socket.end(JSON.stringify(response) + "\n");
      } catch (err) {
        socket.end(JSON.stringify({}) + "\n");
      }
    });
    socket.on("error", () => {});
  });

  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    fs.writeFileSync(portFile, String(port), "utf-8");
    fs.writeFileSync(pidFile, String(process.pid), "utf-8");
    // SECURITY: write token with 0600 where the OS honours it. On Windows
    // the file lives under USERPROFILE (per-user ACLs) which is acceptable.
    fs.writeFileSync(tokenFile, DAEMON_TOKEN, { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(tokenFile, 0o600); } catch {}
    console.log(`Memory daemon started on 127.0.0.1:${port} (PID ${process.pid})`);
  });

  // Inactivity timeout
  setInterval(() => {
    if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
      cleanup();
      process.exit(0);
    }
  }, 60000);

  // Graceful shutdown
  function cleanup() {
    try { fs.unlinkSync(portFile); } catch {}
    try { fs.unlinkSync(pidFile); } catch {}
    try { fs.unlinkSync(tokenFile); } catch {}
    // Unwatch all project files and source watchers
    for (const [, pData] of projects) {
      try {
        const files = ["research.jsonl", "scripts.jsonl", "graph.jsonl", path.join("explorations", "explorations.jsonl")];
        for (const f of files) {
          try { fs.unwatchFile(path.join(pData.memDir, f)); } catch {}
        }
        if (pData.sourceWatcher) {
          try { pData.sourceWatcher.close(); } catch {}
        }
      } catch {}
    }
    server.close();
  }
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);
}

const startTime = Date.now();

// Export for fallback mode (hooks import directly)
module.exports = { handlePreToolUse, handlePostToolUse, startServer };

// Start server if run directly
if (require.main === module) {
  startServer();
}
