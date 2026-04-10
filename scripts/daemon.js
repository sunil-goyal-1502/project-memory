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
    } catch { data.config = {}; }
  }
  const elapsed = Date.now() - t;
  logForProject(normalized, `RELOAD ${what}: ${elapsed}ms (research=${data.research.length}, scripts=${data.scripts.length}, explorations=${data.explorations.length})`);
}

function logForProject(projectRoot, msg) {
  shared.debugLog(projectRoot, "DAEMON", msg);
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

// ══════════════════════════════════════════════════════════
// PRE-TOOL-USE HANDLER
// ══════════════════════════════════════════════════════════

function handlePreToolUse(projectRoot, input) {
  const root = resolveProjectRoot(projectRoot, input);
  const data = getOrLoadProject(root);
  if (!data) return {};

  // Lightweight tools: inject only, never block
  if (LIGHTWEIGHT_TOOLS.has(input.tool_name)) {
    const toolInput = input.tool_input || {};
    const query = [toolInput.file_path || "", toolInput.pattern || "", toolInput.description || ""].join(" ").trim();
    if (query.length > 5 && data.research.length > 0) {
      const relevant = bm25Search(query, data.researchBM25, 0.5, 2);
      if (relevant.length > 0) {
        const researchMap = {}; for (const r of data.research) researchMap[r.id] = r;
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

  // Script search for ALL Bash commands (not just exploratory) — surface saved scripts
  // before Claude writes a new one from scratch
  if (input.tool_name === "Bash" && data.scriptBM25) {
    const toolInput = input.tool_input || {};
    const scriptQuery = [toolInput.command || "", toolInput.description || ""].join(" ").trim();
    if (scriptQuery.length > 5) {
      const scriptHits = bm25Search(scriptQuery, data.scriptBM25, 0.5, 2);
      if (scriptHits.length > 0) {
        const scriptMap = {}; for (const s of data.scripts) scriptMap[s.id] = s;
        const lines = [];
        lines.push(`${C}${B}★ REUSE THESE SCRIPTS — do NOT write new ones ──${R}`);
        lines.push(`${Y}  IMPORTANT: These are complete, tested scripts. Use them AS-IS.${R}`);
        lines.push(`${Y}  Only replace {{parameter}} placeholders with actual values.${R}`);
        lines.push(``);
        for (const { docId } of scriptHits) {
          const script = scriptMap[docId];
          if (!script) continue;
          lines.push(`${G}${B}  ${script.name}${R} (used ${script.usage_count || 1}x)`);
          if (script.parameters && script.parameters.length > 0) {
            lines.push(`${Y}  Parameters to fill in:${R}`);
            for (const p of script.parameters) {
              lines.push(`${Y}    {{${p.name}}}: ${p.description} (default: ${p.default || "none"})${R}`);
            }
          }
          lines.push(`${D}  ┌─ COMPLETE SCRIPT (copy-paste, replace {{params}}) ─┐${R}`);
          lines.push(`${G}${script.template}${R}`);
          lines.push(`${D}  └──────────────────────────────────────────────────┘${R}`);
          lines.push(``);
        }
        lines.push(`${Y}${B}  ▶ DO NOT recreate these scripts. Copy above, replace {{params}}, run.${R}`);
        lines.push(`${C}${B}─────────────────────────────────────────────────${R}`);
        return { systemMessage: lines.join("\n") };
      }
    }
  }

  const isExploratory = input.tool_name === "Bash" ? isExploratoryBash(input)
    : input.tool_name === "Task" ? isExploratoryTask(input) : true;

  if (!isExploratory) return {};

  if (data.research.length === 0) return {};

  const toolInput = input.tool_input || {};
  const query = [toolInput.description || "", toolInput.prompt || "", toolInput.query || ""].join(" ").trim();
  if (query.length <= 5) return {};

  // BM25 search (in-memory, ~0ms)
  let relevant = bm25Search(query, data.researchBM25, 0.5, 3);

  // Graph expansion (in-memory adjacency, ~0ms)
  if (data.config.graph?.enabled && relevant.length > 0) {
    const researchLookup = {}; for (const r of data.research) researchLookup[r.id] = r;
    const hitEntities = [];
    for (const { docId } of relevant) {
      const entry = researchLookup[docId];
      if (entry?.entities) hitEntities.push(...entry.entities);
    }
    if (hitEntities.length > 0) {
      const depth = data.config.graph?.hookExpansionDepth || 1;
      const expanded = graphExpand(data.graphAdj, hitEntities, depth);
      const existingIds = new Set(relevant.map(r => r.docId));
      for (const findingId of expanded.relatedFindingIds) {
        if (!existingIds.has(findingId) && researchLookup[findingId]) {
          relevant.push({ docId: findingId, score: 0.3 });
          existingIds.add(findingId);
        }
      }
      const maxFindings = data.config.hooks?.maxInjectedFindings || 3;
      relevant = relevant.slice(0, maxFindings + 2);
    }
  }

  if (relevant.length > 0) {
    const researchMap = {}; for (const r of data.research) researchMap[r.id] = r;
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
    const explorationHits = searchExplorationsForProject(data, query);
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
    const scriptResults = bm25Search(query, data.scriptBM25, 0.5, 2);
    if (scriptResults.length > 0) {
      const scriptMap = {}; for (const s of data.scripts) scriptMap[s.id] = s;
      lines.push(``);
      lines.push(`${C}${B}★ REUSE THESE SCRIPTS — do NOT write new ones ──${R}`);
      lines.push(`${Y}  IMPORTANT: These are complete, tested scripts. Use them AS-IS.${R}`);
      lines.push(`${Y}  Only replace {{parameter}} placeholders with actual values.${R}`);
      lines.push(``);
      for (const { docId } of scriptResults) {
        const script = scriptMap[docId];
        if (!script) continue;
        lines.push(`${G}${B}  ${script.name}${R} (used ${script.usage_count || 1}x)`);
        if (script.parameters && script.parameters.length > 0) {
          lines.push(`${Y}  Parameters to fill in:${R}`);
          for (const p of script.parameters) {
            lines.push(`${Y}    {{${p.name}}}: ${p.description} (default: ${p.default || "none"})${R}`);
          }
        }
        lines.push(`${D}  ┌─ COMPLETE SCRIPT (copy-paste, replace {{params}}) ─┐${R}`);
        lines.push(`${G}${script.template}${R}`);
        lines.push(`${D}  └──────────────────────────────────────────────────┘${R}`);
        lines.push(``);
      }
      lines.push(`${Y}${B}  ▶ DO NOT recreate these scripts. Copy above, replace {{params}}, run.${R}`);
      lines.push(`${C}${B}─────────────────────────────────────────────────${R}`);
    }

    // Record injection for double-block prevention
    try {
      const state = readSessionState(root);
      state.lastInjection = { ts: Date.now(), query: query.slice(0, 100) };
      state.memoryCheck.lastCheckTs = Date.now();
      writeSessionState(root, state);
    } catch {}

    return { systemMessage: lines.join("\n") };
  }

  // Cache miss — try explorations + scripts fallback
  const fallbackLines = [];
  const explorationHits = searchExplorationsForProject(data, query);
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
  const scriptResults = bm25Search(query, data.scriptBM25, 0.5, 2);
  if (scriptResults.length > 0) {
    const scriptMap = {}; for (const s of data.scripts) scriptMap[s.id] = s;
    fallbackLines.push(``);
    fallbackLines.push(`${C}${B}★ REUSE THESE SCRIPTS — do NOT write new ones ──${R}`);
    fallbackLines.push(`${Y}  IMPORTANT: These are complete, tested scripts. Use them AS-IS.${R}`);
    fallbackLines.push(``);
    for (const { docId } of scriptResults) {
      const script = scriptMap[docId];
      if (!script) continue;
      fallbackLines.push(`${G}${B}  ${script.name}${R} (used ${script.usage_count || 1}x)`);
      if (script.parameters && script.parameters.length > 0) {
        fallbackLines.push(`${Y}  Parameters to fill in:${R}`);
        for (const p of script.parameters) {
          fallbackLines.push(`${Y}    {{${p.name}}}: ${p.description} (default: ${p.default || "none"})${R}`);
        }
      }
      fallbackLines.push(`${D}  ┌─ COMPLETE SCRIPT (copy-paste, replace {{params}}) ─┐${R}`);
      fallbackLines.push(`${G}${script.template}${R}`);
      fallbackLines.push(`${D}  └──────────────────────────────────────────────────┘${R}`);
      fallbackLines.push(``);
    }
    fallbackLines.push(`${Y}${B}  ▶ DO NOT recreate. Copy above, replace {{params}}, run.${R}`);
    fallbackLines.push(`${C}${B}─────────────────────────────────────────────────${R}`);
  }
  if (fallbackLines.length > 0) return { systemMessage: fallbackLines.join("\n") };

  // Escalation check
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
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => {
      try {
        const lineEnd = data.indexOf("\n");
        const json = lineEnd >= 0 ? data.slice(0, lineEnd) : data;
        const request = JSON.parse(json);
        let response = {};

        const t = Date.now();
        if (request.type === "pre-tool-use") {
          response = handlePreToolUse(request.projectRoot, request.input || {});
        } else if (request.type === "post-tool-use") {
          response = handlePostToolUse(request.projectRoot, request.input || {});
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
    // Unwatch all project files
    for (const [, pData] of projects) {
      try {
        const files = ["research.jsonl", "scripts.jsonl", "graph.jsonl", path.join("explorations", "explorations.jsonl")];
        for (const f of files) {
          try { fs.unwatchFile(path.join(pData.memDir, f)); } catch {}
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
