#!/usr/bin/env node
"use strict";

/**
 * Memory daemon — long-running TCP server that holds all project-memory data
 * in memory. Hooks connect via TCP for fast searches (~30ms vs ~1500ms).
 *
 * Data model: Disk files are source of truth. Daemon is a read-through cache.
 * All writes go to disk first; daemon detects changes via fs.watchFile and reloads.
 * On restart, full state is recovered from disk in ~20ms.
 *
 * Usage:
 *   node daemon.js [projectRoot]    — start daemon
 *   node daemon.js --stop           — stop running daemon
 */

const fs = require("fs");
const path = require("path");
const net = require("net");

const shared = require(path.join(__dirname, "shared.js"));
const {
  ANSI, MATCHED_TOOLS, LIGHTWEIGHT_TOOLS, IMMEDIATE_SAVE_TOOLS, TASK_TOOLS,
  ESCALATION_THRESHOLD, THROTTLE_MS, SUMMARY_CHECKPOINT_CALLS,
  isSelfCall, isExploratoryBash, isExploratoryTask,
  readSessionState, writeSessionState, getLastSaveTs,
  searchExplorationsForHook,
} = shared;

const { M, B, R, G, Y, C, D } = ANSI;

// ── Resolve project root ──
const projectRoot = process.argv[2] && process.argv[2] !== "--stop"
  ? process.argv[2]
  : (shared.findProjectRoot(process.cwd()) || shared.scanHomeForProjects());

if (!projectRoot) {
  console.error("No .ai-memory/ found");
  process.exit(1);
}

const memDir = path.join(projectRoot, ".ai-memory");
const portFile = path.join(memDir, ".daemon-port");
const pidFile = path.join(memDir, ".daemon-pid");
const pluginRoot = path.resolve(__dirname, "..").replace(/\\/g, "/");

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

// ── In-memory data store ──
let research = [];
let scripts = [];
let researchBM25 = null;
let scriptBM25 = null;
let graphAdj = null;
let explorations = [];
let config = {};
let lastActivity = Date.now();

const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

function reload(what) {
  const t = Date.now();
  if (what === "all" || what === "research") {
    research = shared.readJsonl(path.join(memDir, "research.jsonl"));
    researchBM25 = shared.buildBM25Index(research);
  }
  if (what === "all" || what === "scripts") {
    scripts = shared.readScripts(projectRoot);
    const searchable = scripts.map(s => ({
      id: s.id, topic: s.name || "", tags: s.tags || [],
      finding: [s.name || "", s.description || "", (s.tags || []).join(" ")].join(" "),
    }));
    scriptBM25 = shared.buildBM25Index(searchable);
  }
  if (what === "all" || what === "graph") {
    try {
      const graphMod = require(path.join(__dirname, "graph.js"));
      const triples = graphMod.readGraph(projectRoot);
      graphAdj = graphMod.buildAdjacencyIndex(triples);
    } catch { graphAdj = null; }
  }
  if (what === "all" || what === "explorations") {
    explorations = shared.readExplorationsIndex(projectRoot);
  }
  if (what === "all" || what === "config") {
    try {
      const configMod = require(path.join(__dirname, "config.js"));
      config = configMod.readConfig(projectRoot);
    } catch { config = {}; }
  }
  const elapsed = Date.now() - t;
  log(`RELOAD ${what}: ${elapsed}ms (research=${research.length}, scripts=${scripts.length}, explorations=${explorations.length})`);
}

function log(msg) {
  shared.debugLog(projectRoot, "DAEMON", msg);
}

// ── File watchers ──
function setupWatchers() {
  const watch = (file, what) => {
    const fullPath = path.join(memDir, file);
    if (fs.existsSync(fullPath)) {
      fs.watchFile(fullPath, { interval: 500 }, () => { reload(what); });
    }
  };
  watch("research.jsonl", "research");
  watch("scripts.jsonl", "scripts");
  watch("graph.jsonl", "graph");
  watch(path.join("explorations", "explorations.jsonl"), "explorations");
}

// ── BM25 search using in-memory index ──
function bm25Search(query, index, threshold, limit) {
  if (!index) return [];
  return shared.bm25Score(query, index).filter(r => r.score > threshold).slice(0, limit);
}

// ── Graph expansion using in-memory adjacency ──
function graphExpand(seedEntities, depth) {
  if (!graphAdj || seedEntities.length === 0) return { connections: [], relatedFindingIds: new Set() };
  const visited = new Set();
  const connections = [];
  const relatedFindingIds = new Set();
  let frontier = seedEntities.map(e => e.toLowerCase());
  for (let hop = 1; hop <= depth; hop++) {
    const next = [];
    for (const entity of frontier) {
      if (visited.has(entity)) continue;
      visited.add(entity);
      const edges = graphAdj[entity] || [];
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

// ── Exploration search using in-memory index ──
function searchExplorations(query) {
  if (explorations.length === 0) return [];
  const searchable = explorations.map(e => ({
    id: e.id, topic: e.query || "", tags: e.tags || [],
    finding: [e.query || "", (e.files || []).join(" "), (e.entities || []).join(" "), (e.tags || []).join(" ")].join(" "),
    _raw: e,
  }));
  const index = shared.buildBM25Index(searchable);
  const results = shared.bm25Score(query, index);
  const entryMap = {};
  for (const e of explorations) entryMap[e.id] = e;
  return results.filter(r => r.score > 0.5).slice(0, 3).map(r => {
    const entry = entryMap[r.docId];
    if (!entry) return null;
    const explorationsDir = path.join(memDir, "explorations");
    return {
      agent: entry.agent || "unknown",
      date: entry.ts ? entry.ts.substring(0, 10) : "unknown",
      charCount: entry.charCount || 0,
      query: (entry.query || "").slice(0, 150),
      filePath: path.join(explorationsDir, entry.filename).replace(/\\/g, "/"),
    };
  }).filter(Boolean);
}

// ══════════════════════════════════════════════════════════
// PRE-TOOL-USE HANDLER
// ══════════════════════════════════════════════════════════

function handlePreToolUse(input) {
  // Lightweight tools: inject only, never block
  if (LIGHTWEIGHT_TOOLS.has(input.tool_name)) {
    const toolInput = input.tool_input || {};
    const query = [toolInput.file_path || "", toolInput.pattern || "", toolInput.description || ""].join(" ").trim();
    if (query.length > 5 && research.length > 0) {
      const relevant = bm25Search(query, researchBM25, 0.5, 2);
      if (relevant.length > 0) {
        const researchMap = {}; for (const r of research) researchMap[r.id] = r;
        const lines = [`${C}${B}★ Memory Context ───────────────────────────────${R}`];
        for (const { docId } of relevant) {
          const entry = researchMap[docId];
          if (entry) lines.push(`${G}  • ${entry.topic || "untitled"}: ${(entry.finding || "").slice(0, 200)}${R}`);
        }
        lines.push(`${C}${B}─────────────────────────────────────────────────${R}`);
        return { systemMessage: lines.join("\n") };
      }
    }
    return {};
  }

  if (!MATCHED_TOOLS.has(input.tool_name)) return {};
  if (input.tool_name === "Bash" && isSelfCall(input)) return {};

  const isExploratory = input.tool_name === "Bash" ? isExploratoryBash(input)
    : input.tool_name === "Task" ? isExploratoryTask(input) : true;

  if (!isExploratory) return {};

  if (research.length === 0) return {};

  const toolInput = input.tool_input || {};
  const query = [toolInput.description || "", toolInput.prompt || "", toolInput.query || ""].join(" ").trim();
  if (query.length <= 5) return {};

  // BM25 search (in-memory, ~0ms)
  let relevant = bm25Search(query, researchBM25, 0.5, 3);

  // Graph expansion (in-memory adjacency, ~0ms)
  if (config.graph?.enabled && relevant.length > 0) {
    const researchLookup = {}; for (const r of research) researchLookup[r.id] = r;
    const hitEntities = [];
    for (const { docId } of relevant) {
      const entry = researchLookup[docId];
      if (entry?.entities) hitEntities.push(...entry.entities);
    }
    if (hitEntities.length > 0) {
      const depth = config.graph?.hookExpansionDepth || 1;
      const expanded = graphExpand(hitEntities, depth);
      const existingIds = new Set(relevant.map(r => r.docId));
      for (const findingId of expanded.relatedFindingIds) {
        if (!existingIds.has(findingId) && researchLookup[findingId]) {
          relevant.push({ docId: findingId, score: 0.3 });
          existingIds.add(findingId);
        }
      }
      const maxFindings = config.hooks?.maxInjectedFindings || 3;
      relevant = relevant.slice(0, maxFindings + 2);
    }
  }

  if (relevant.length > 0) {
    const researchMap = {}; for (const r of research) researchMap[r.id] = r;
    const lines = [];
    lines.push(`${C}${B}★ Memory Cache Hit ─────────────────────────────${R}`);
    lines.push(`${C}  ${relevant.length} saved finding(s) match your current task:${R}`);
    lines.push(``);
    for (let ri = 0; ri < relevant.length; ri++) {
      const { docId, score } = relevant[ri];
      const entry = researchMap[docId];
      if (!entry) continue;
      const sourceTag = score < 0.5 ? ` ${D}[via graph]${R}` : "";
      const tags = (entry.tags || []).slice(0, 4).join(", ");
      lines.push(`${G}${B}  ${ri + 1}. ${entry.topic || "untitled"}${R}${sourceTag}`);
      if (tags) lines.push(`${D}     Tags: ${tags}${R}`);
      lines.push(`${G}     ${entry.finding || ""}${R}`);
      lines.push(``);
    }
    lines.push(`${Y}${B}  ▶ USE the findings above directly. Only re-explore if they are genuinely insufficient.${R}`);
    lines.push(`${C}${B}─────────────────────────────────────────────────${R}`);

    // Explorations
    const explorationHits = searchExplorations(query);
    if (explorationHits.length > 0) {
      lines.push(``);
      lines.push(`${C}${B}★ Past Explorations Found ──────────────────────${R}`);
      for (const hit of explorationHits) {
        lines.push(`${G}${B}  • ${hit.agent} (${hit.date}) — ${hit.charCount} chars${R}`);
        lines.push(`${D}    Query: ${hit.query}${R}`);
        lines.push(`${G}    Full output: ${hit.filePath}${R}`);
        lines.push(``);
      }
      lines.push(`${Y}${B}  ▶ Read the exploration file(s) above for complete context.${R}`);
      lines.push(`${C}${B}─────────────────────────────────────────────────${R}`);
    }

    // Scripts
    const scriptResults = bm25Search(query, scriptBM25, 0.5, 2);
    if (scriptResults.length > 0) {
      const scriptMap = {}; for (const s of scripts) scriptMap[s.id] = s;
      lines.push(``);
      lines.push(`${C}${B}★ Reusable Scripts Found ───────────────────────${R}`);
      for (const { docId } of scriptResults) {
        const script = scriptMap[docId];
        if (!script) continue;
        lines.push(`${G}${B}  ${script.name}${R} (used ${script.usage_count || 1}x)`);
        lines.push(`${D}  Template:${R}`);
        lines.push(`${G}  ${script.template.slice(0, 300)}${R}`);
        if (script.parameters && script.parameters.length > 0) {
          lines.push(`${Y}  Parameters:${R}`);
          for (const p of script.parameters) {
            lines.push(`${Y}    {{${p.name}}}: ${p.description} (default: ${p.default || "none"})${R}`);
          }
        }
        lines.push(``);
      }
      lines.push(`${Y}${B}  ▶ Fill in {{parameters}} and reuse — no need to reconstruct.${R}`);
      lines.push(`${C}${B}─────────────────────────────────────────────────${R}`);
    }

    // Record injection for double-block prevention
    try {
      const state = readSessionState(projectRoot);
      state.lastInjection = { ts: Date.now(), query: query.slice(0, 100) };
      state.memoryCheck.lastCheckTs = Date.now();
      writeSessionState(projectRoot, state);
    } catch {}

    return { systemMessage: lines.join("\n") };
  }

  // Cache miss — try explorations + scripts fallback
  const fallbackLines = [];
  const explorationHits = searchExplorations(query);
  if (explorationHits.length > 0) {
    fallbackLines.push(`${C}${B}★ Past Exploration Found ───────────────────────${R}`);
    for (const hit of explorationHits) {
      fallbackLines.push(`${G}${B}  • ${hit.agent} (${hit.date}) — ${hit.charCount} chars${R}`);
      fallbackLines.push(`${D}    Query: ${hit.query}${R}`);
      fallbackLines.push(`${G}    Full output: ${hit.filePath}${R}`);
      fallbackLines.push(``);
    }
    fallbackLines.push(`${Y}${B}  ▶ Read the exploration file(s) above with the Read tool.${R}`);
    fallbackLines.push(`${C}${B}─────────────────────────────────────────────────${R}`);
  }
  const scriptResults = bm25Search(query, scriptBM25, 0.5, 2);
  if (scriptResults.length > 0) {
    const scriptMap = {}; for (const s of scripts) scriptMap[s.id] = s;
    fallbackLines.push(``);
    fallbackLines.push(`${C}${B}★ Reusable Scripts Found ───────────────────────${R}`);
    for (const { docId } of scriptResults) {
      const script = scriptMap[docId];
      if (!script) continue;
      fallbackLines.push(`${G}${B}  ${script.name}${R} (used ${script.usage_count || 1}x)`);
      fallbackLines.push(`${G}  ${script.template.slice(0, 300)}${R}`);
      fallbackLines.push(``);
    }
    fallbackLines.push(`${Y}${B}  ▶ Fill in {{parameters}} and reuse.${R}`);
    fallbackLines.push(`${C}${B}─────────────────────────────────────────────────${R}`);
  }
  if (fallbackLines.length > 0) return { systemMessage: fallbackLines.join("\n") };

  // Escalation check
  const state = readSessionState(projectRoot);
  if (state.reminder.reminderCount > ESCALATION_THRESHOLD) {
    const currentSaveTs = getLastSaveTs(projectRoot);
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

  return {};
}

// ══════════════════════════════════════════════════════════
// POST-TOOL-USE HANDLER
// ══════════════════════════════════════════════════════════

function handlePostToolUse(input) {
  // Task completion tracking
  if (TASK_TOOLS.has(input.tool_name)) {
    const state = readSessionState(projectRoot);
    const tracker = state.taskTracker;
    if (input.tool_name === "TaskCreate") {
      tracker.created += 1;
      writeSessionState(projectRoot, state);
    } else if (input.tool_name === "TaskUpdate") {
      const status = (input.tool_input || {}).status;
      if (status === "completed") {
        tracker.completed += 1;
        writeSessionState(projectRoot, state);
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
        writeSessionState(projectRoot, state);
      }
    }
  }

  if (!MATCHED_TOOLS.has(input.tool_name)) return {};
  if (input.tool_name === "Bash" && isSelfCall(input)) return {};

  // Periodic checkpoint
  const checkState = readSessionState(projectRoot);
  checkState.taskTracker.toolCallsSinceSummary += 1;
  writeSessionState(projectRoot, checkState);
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
      shared.appendToolHistory(projectRoot, record);
      if (success) {
        const capture = shared.detectAutoCapture(projectRoot, record);
        if (capture) {
          const saved = shared.autoSaveCapture(projectRoot, capture);
          if (saved) log(`AUTO-CAPTURE: "${capture.topic}" (id: ${saved.id})`);
        }
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
    shared.appendBreadcrumb(projectRoot, breadcrumb);
  } catch {}

  // Exploration capture (writes to disk)
  if (input.tool_name === "Task" && isExploratoryTask(input)) {
    try {
      // Delegate to post-tool-use captureExploration logic
      const postMod = require(path.join(__dirname, "..", "hooks", "scripts", "post-tool-use-capture.js"));
      if (postMod && postMod.captureExploration) postMod.captureExploration(projectRoot, input);
    } catch {
      // Inline minimal capture
      try {
        let rawOutput = typeof input.tool_response === "string" ? input.tool_response : "";
        if (rawOutput.length >= 200) {
          const crypto = require("crypto");
          const id = "exp_" + crypto.randomBytes(4).toString("hex");
          const ts = new Date().toISOString();
          const toolInput = input.tool_input || {};
          const filename = `${ts.replace(/[:.]/g, "-").slice(0, 19)}_${shared.sanitizeFilename(toolInput.description || "")}_${id.slice(-6)}.md`;
          const explDir = shared.ensureExplorationsDir(projectRoot);
          fs.writeFileSync(path.join(explDir, filename), rawOutput, "utf-8");
          shared.appendExplorationIndex(projectRoot, {
            id, ts, agent: toolInput.subagent_type || "unknown",
            query: (toolInput.prompt || "").slice(0, 300),
            tags: [], filename, charCount: rawOutput.length,
          });
          log(`EXPLORATION-CAPTURE: ${id} chars=${rawOutput.length}`);
        }
      } catch {}
    }
  }

  // Immediate save tools blocking
  const state = readSessionState(projectRoot);
  if (IMMEDIATE_SAVE_TOOLS.has(input.tool_name)) {
    // Parallel Task skip
    if (input.tool_name === "Task" && state.taskTracker.created > 0 && state.taskTracker.completed < state.taskTracker.created) return {};
    // Cooldown skip
    if (input.tool_name === "Task" && state.lastInjection && Date.now() - state.lastInjection.ts < 5000) return {};
    // Double-block skip
    if (state.lastInjection && Date.now() - state.lastInjection.ts < 30000) {
      return { systemMessage: `${G}${B}★ Findings were injected — save any NEW discoveries when ready.${R}` };
    }

    // Block
    const currentSaveTs = getLastSaveTs(projectRoot);
    if (currentSaveTs > state.reminder.lastSaveTs && state.reminder.lastSaveTs > 0) state.reminder.reminderCount = 0;
    state.reminder.reminderCount = ESCALATION_THRESHOLD + 1;
    state.reminder.ts = Date.now();
    state.reminder.lastSaveTs = Math.max(state.reminder.lastSaveTs, currentSaveTs);
    state.memoryCheck.lastCheckTs = 0;
    writeSessionState(projectRoot, state);

    const memChecked = state.memoryCheck.lastCheckTs > 0;
    const checkLine = memChecked ? "" : `\n${M}${B}STEP 1: Check memory FIRST:${R}\n${M}  node "${pluginRoot}/scripts/check-memory.js" "keywords"${R}\n${M}${B}STEP 2: Save NEW discoveries:${R}`;
    return { decision: "block", reason: `${M}${B}[project-memory] You just used ${input.tool_name} — knowledge WILL BE LOST if not saved.${R}${checkLine}\n${M}SAVE NOW:${R}\n${M}- node "${pluginRoot}/scripts/save-decision.js" "<cat>" "<decision>" "<rationale>"${R}\n${M}- node "${pluginRoot}/scripts/save-research.js" "<topic>" "<tags>" "<finding>"${R}\n${M}${B}Your next tool call will be DENIED until you save.${R}` };
  }

  // Gradual escalation for Bash
  if (Date.now() - state.reminder.ts < THROTTLE_MS) return {};
  const currentSaveTs = getLastSaveTs(projectRoot);
  if (currentSaveTs > state.reminder.lastSaveTs && state.reminder.lastSaveTs > 0) state.reminder.reminderCount = 0;
  state.reminder.reminderCount += 1;
  state.reminder.ts = Date.now();
  state.reminder.lastSaveTs = Math.max(state.reminder.lastSaveTs, currentSaveTs);
  writeSessionState(projectRoot, state);
  if (state.reminder.reminderCount <= ESCALATION_THRESHOLD) return {};

  return { decision: "block", reason: `${M}${B}[project-memory] Researching ~${state.reminder.reminderCount * 3}+ min without saving!${R}\n${M}STOP and save your discoveries:${R}\n${M}- node "${pluginRoot}/scripts/save-decision.js" "<cat>" "<decision>" "<rationale>"${R}\n${M}- node "${pluginRoot}/scripts/save-research.js" "<topic>" "<tags>" "<finding>"${R}` };
}

// ══════════════════════════════════════════════════════════
// TCP SERVER
// ══════════════════════════════════════════════════════════

function startServer() {
  reload("all");
  setupWatchers();

  const server = net.createServer((socket) => {
    lastActivity = Date.now();
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => {
      try {
        const lineEnd = data.indexOf("\n");
        const json = lineEnd >= 0 ? data.slice(0, lineEnd) : data;
        const request = JSON.parse(json);
        let response = {};

        const t = Date.now();
        if (request.type === "pre-tool-use") {
          response = handlePreToolUse(request.input || {});
        } else if (request.type === "post-tool-use") {
          response = handlePostToolUse(request.input || {});
        } else if (request.type === "ping") {
          response = { type: "pong", uptime: Math.round((Date.now() - startTime) / 1000), entries: research.length };
        }
        const elapsed = Date.now() - t;
        log(`IPC ${request.type}: ${elapsed}ms`);

        socket.end(JSON.stringify(response) + "\n");
      } catch (err) {
        log(`IPC-ERROR: ${err.message}`);
        socket.end(JSON.stringify({}) + "\n");
      }
    });
    socket.on("error", () => {}); // ignore client disconnects
  });

  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    fs.writeFileSync(portFile, String(port), "utf-8");
    fs.writeFileSync(pidFile, String(process.pid), "utf-8");
    log(`STARTED on 127.0.0.1:${port} (PID ${process.pid})`);
  });

  // Inactivity timeout
  setInterval(() => {
    if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
      log(`SHUTDOWN: inactivity timeout (${Math.round(INACTIVITY_TIMEOUT_MS / 60000)} min)`);
      cleanup();
      process.exit(0);
    }
  }, 60000);

  // Graceful shutdown
  function cleanup() {
    try { fs.unlinkSync(portFile); } catch {}
    try { fs.unlinkSync(pidFile); } catch {}
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
