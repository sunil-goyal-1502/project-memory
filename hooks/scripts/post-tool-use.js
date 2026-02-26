#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * PostToolUse hook for project-memory plugin.
 *
 * Fires after Bash, WebFetch, WebSearch, or Task tool calls.
 * Injects escalating reminders to save decisions/research:
 *   - First 3 reminders (over ~9 min): gentle systemMessage nudge
 *   - After 3 ignored reminders: decision:"block" forcing acknowledgement
 * Resets counter when Claude actually saves (detected via file mtime).
 * Throttled to max once every 3 minutes.
 * Skips self-calls (save-decision.js, save-research.js, check-memory.js).
 *
 * Task completion tracking:
 *   - Tracks TaskCreate/TaskUpdate to detect when all planned tasks are done
 *   - When all tasks complete, blocks until session-summary.js is run
 *   - Also blocks after SUMMARY_CHECKPOINT_CALLS tool calls as periodic fallback
 *
 * Always exits 0 (hook contract).
 */

const THROTTLE_MS = 3 * 60 * 1000; // 3 minutes
const ESCALATION_THRESHOLD = 2; // escalate after this many ignored reminders
const SUMMARY_CHECKPOINT_CALLS = 20; // force summary after this many matched tool calls
const MATCHED_TOOLS = new Set(["Bash", "WebFetch", "WebSearch", "Task"]);
const IMMEDIATE_SAVE_TOOLS = new Set(["Task", "WebSearch", "WebFetch"]);
const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate"]);

// ANSI colors for visible memory messages
const M = "\x1b[95m"; // bright magenta
const B = "\x1b[1m";  // bold
const R = "\x1b[0m";  // reset
const G = "\x1b[92m"; // bright green
const Y = "\x1b[93m"; // bright yellow

// ── Debug logging ──
function debugLog(projectRoot, msg) {
  try {
    const logPath = projectRoot
      ? path.join(projectRoot, ".ai-memory", ".hook-debug.log")
      : path.join(process.env.USERPROFILE || process.env.HOME || "/tmp", ".hook-debug.log");
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] POST: ${msg}\n`, "utf-8");
  } catch { /* non-critical */ }
}

function findProjectRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, ".ai-memory"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * On Windows, hook cwd can be C:\WINDOWS\system32 instead of the project dir.
 * Session-start writes the real project root to ~/.ai-memory-sessions/<session_id>.
 * This function tries findProjectRoot first, then falls back to the session registry.
 */
/**
 * Windows fallback: when cwd is C:\Windows\System32 (or any system dir),
 * scan $USERPROFILE and its immediate children for .ai-memory directories.
 * Returns the most recently modified project root, or null.
 */
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
        if (fs.existsSync(path.join(childPath, ".ai-memory"))) {
          candidates.push(childPath);
        }
      }
    }
  } catch {}

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  candidates.sort((a, b) => {
    try {
      const aStat = fs.statSync(path.join(a, ".ai-memory"));
      const bStat = fs.statSync(path.join(b, ".ai-memory"));
      return bStat.mtimeMs - aStat.mtimeMs;
    } catch { return 0; }
  });
  return candidates[0];
}

function resolveProjectRoot(cwd, sessionId) {
  const root = findProjectRoot(cwd);
  if (root) return root;

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

  // Windows fallback: scan USERPROFILE children for .ai-memory
  return scanHomeForProjects();
}

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

// ── Intent detection (mirrored from pre-tool-use.js) ──

/**
 * Layered intent detection for Bash commands.
 *
 * Layer 1 (primary): Keyword scoring on tool_input.description — Claude's
 *   human-readable intent (e.g. "Search for auth patterns" vs "Create dir").
 *   If exploration keywords outscore operational keywords → exploratory.
 *   If operational outscore exploration → operational. Ties fall through.
 *
 * Layer 2 (fallback): Regex on the command string for clearly exploratory
 *   commands (grep, curl, git log, etc.). Ambiguous commands like find are
 *   NOT matched here — they require the description layer to classify.
 */
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

const EXPLORATION_PATTERNS = [
  /\bcurl\s/,          // web fetching for research
  /\bwget\s/,          // web fetching
  /\bgit\s+log\b/,     // investigating commit history
  /\bgit\s+show\b/,    // inspecting commits/objects
  /\bgit\s+blame\b/,   // investigating code authorship
  /\bgrep\s/,          // searching file contents
  /\brg\s/,            // ripgrep search
  /\bag\s/,            // silver searcher
  /\back\s/,           // ack search
  /\blocate\s/,        // finding files via index
  /\bnpm\s+(info|search|view)\b/, // package research
  /\bpip\s+(show|search)\b/,     // python package research
];

/**
 * Commands that are ALWAYS operational — never exploratory.
 * Checked before any keyword scoring to prevent false positives
 * from description keywords (e.g., "Create directory for checking memory").
 */
const SAFE_OPERATIONAL_PATTERNS = [
  /^\s*mkdir\b/,         // create directories
  /^\s*touch\b/,         // create empty files
  /^\s*cp\b/,            // copy files
  /^\s*mv\b/,            // move/rename files
  /^\s*rm\b/,            // remove files
  /^\s*chmod\b/,         // change permissions
  /^\s*chown\b/,         // change ownership
  /^\s*ln\b/,            // create links
  /^\s*echo\b/,          // print/write text
  /^\s*printf\b/,        // print formatted text
  /^\s*cat\s*>/,         // write to file via cat redirect
  /^\s*npm\s+(install|ci|run|start|build|test)\b/,  // npm operational
  /^\s*npx\b/,           // run package binaries
  /^\s*node\b/,          // run node scripts
  /^\s*git\s+(add|commit|push|pull|checkout|switch|branch|merge|rebase|stash|tag|fetch|clone|init)\b/,
  /^\s*pip\s+install\b/, // python install
  /^\s*docker\s+(build|run|push|pull|start|stop|rm|exec)\b/,
  /^\s*cd\b/,            // change directory
  /^\s*pwd\b/,           // print working directory
  /^\s*ls\b/,            // list files (borderline but usually operational)
];

function isExploratoryBash(input) {
  if (!input || !input.tool_input) return false;
  const cmd = input.tool_input.command || "";
  const desc = (input.tool_input.description || "");

  // Layer 0: Safelist — obviously operational commands, always skip
  if (SAFE_OPERATIONAL_PATTERNS.some(p => p.test(cmd))) return false;

  // Layer 1: Description-based intent detection
  if (desc.length > 5) {
    const explorationScore = EXPLORATION_KEYWORDS.filter(p => p.test(desc)).length;
    const operationalScore = OPERATIONAL_KEYWORDS.filter(p => p.test(desc)).length;

    debugLog(null, `INTENT: desc="${desc.slice(0, 80)}" explore=${explorationScore} operational=${operationalScore}`);

    if (explorationScore > operationalScore) return true;
    if (operationalScore > explorationScore) return false;
    // Tied or zero — fall through to command regex
  }

  // Layer 2: Command regex fallback (only clearly exploratory commands)
  return EXPLORATION_PATTERNS.some(p => p.test(cmd));
}

const EXPLORATION_SUBAGENTS = new Set([
  "Explore", "Plan", "general-purpose",
  "feature-dev:code-explorer", "feature-dev:code-architect",
]);

function isExploratoryTask(input) {
  const subagentType = (input.tool_input || {}).subagent_type || "";
  return EXPLORATION_SUBAGENTS.has(subagentType);
}

// ── Task completion tracking ──

/**
 * Read task tracker state from .ai-memory/.task-tracker.
 * Tracks: created (count), completed (count), toolCallsSinceSummary (count).
 */
function readTaskTracker(projectRoot) {
  const trackerPath = path.join(projectRoot, ".ai-memory", ".task-tracker");
  const defaults = { created: 0, completed: 0, toolCallsSinceSummary: 0 };
  try {
    const raw = fs.readFileSync(trackerPath, "utf-8").trim();
    if (!raw || !raw.startsWith("{")) return defaults;
    const parsed = JSON.parse(raw);
    return {
      created: parsed.created || 0,
      completed: parsed.completed || 0,
      toolCallsSinceSummary: parsed.toolCallsSinceSummary || 0,
    };
  } catch {
    return defaults;
  }
}

function writeTaskTracker(projectRoot, tracker) {
  const trackerPath = path.join(projectRoot, ".ai-memory", ".task-tracker");
  try {
    fs.writeFileSync(trackerPath, JSON.stringify(tracker), "utf-8");
  } catch { /* non-critical */ }
}

/**
 * Build a green Insight-style banner for task completion.
 */
function buildTaskCompletionBanner(projectRoot, tracker, pluginRoot) {
  const border = "\u2500".repeat(49);
  const lines = [];
  lines.push(`${G}${B}\u2605 All Tasks Complete \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${R}`);
  lines.push(`${G}  \u2713 ${tracker.completed}/${tracker.created} tasks completed${R}`);
  lines.push(`${G}  Run the session summary NOW:${R}`);
  lines.push(`${G}  node "${pluginRoot}/scripts/session-summary.js"${R}`);
  lines.push(`${G}${B}${border}${R}`);
  return lines.join("\n");
}

/**
 * Build a green Insight-style banner for periodic summary checkpoint.
 */
function buildPeriodicCheckpointBanner(projectRoot, tracker, pluginRoot) {
  const border = "\u2500".repeat(49);
  const lines = [];
  lines.push(`${G}${B}\u2605 Summary Checkpoint \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${R}`);
  lines.push(`${G}  ${tracker.toolCallsSinceSummary} tool calls since last summary${R}`);
  lines.push(`${G}  Run the session summary NOW:${R}`);
  lines.push(`${G}  node "${pluginRoot}/scripts/session-summary.js"${R}`);
  lines.push(`${G}${B}${border}${R}`);
  return lines.join("\n");
}

/**
 * Read escalation state from .ai-memory/.last-reminder.
 * Backward-compatible: if file contains a plain number (old format),
 * treats it as { ts: <number>, reminderCount: 0, lastSaveTs: 0 }.
 */
function readState(projectRoot) {
  const reminderPath = path.join(projectRoot, ".ai-memory", ".last-reminder");
  const defaultState = { ts: 0, reminderCount: 0, lastSaveTs: 0 };
  try {
    const raw = fs.readFileSync(reminderPath, "utf-8").trim();
    if (!raw) return defaultState;
    // Try JSON first
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      return {
        ts: parsed.ts || 0,
        reminderCount: parsed.reminderCount || 0,
        lastSaveTs: parsed.lastSaveTs || 0,
      };
    }
    // Backward compat: plain timestamp from old format
    const ts = Number(raw);
    if (!isNaN(ts)) {
      return { ts, reminderCount: 0, lastSaveTs: 0 };
    }
    return defaultState;
  } catch {
    return defaultState;
  }
}

/**
 * Write escalation state to .ai-memory/.last-reminder as JSON.
 */
function writeState(projectRoot, state) {
  const reminderPath = path.join(projectRoot, ".ai-memory", ".last-reminder");
  try {
    fs.writeFileSync(reminderPath, JSON.stringify(state), "utf-8");
  } catch {
    // Non-critical — skip silently
  }
}

/**
 * Get the most recent modification time of decisions.jsonl and research.jsonl.
 * Returns 0 if neither file exists.
 */
function getLastSaveTs(projectRoot) {
  let maxMtime = 0;
  const files = ["decisions.jsonl", "research.jsonl"];
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(projectRoot, ".ai-memory", file));
      if (stat.mtimeMs > maxMtime) {
        maxMtime = stat.mtimeMs;
      }
    } catch {
      // File doesn't exist — skip
    }
  }
  return maxMtime;
}

/**
 * Build a green/yellow Insight-style banner showing memory consultation status.
 * Prepended to visible block messages so the user always sees evidence.
 * Returns { text, memoryChecked } so callers can add check-memory instructions.
 */
function buildMemoryStatusBanner(projectRoot) {
  const border = "\u2500".repeat(49);

  // Check if memory was consulted this session
  let memoryChecked = false;
  try {
    const ts = Number(
      fs.readFileSync(path.join(projectRoot, ".ai-memory", ".last-memory-check"), "utf-8").trim()
    );
    memoryChecked = !isNaN(ts) && ts > 0;
  } catch {}

  // Count available entries
  let researchCount = 0;
  let decisionsCount = 0;
  try {
    const rc = fs.readFileSync(path.join(projectRoot, ".ai-memory", "research.jsonl"), "utf-8").trim();
    if (rc) researchCount = rc.split("\n").filter((l) => l.trim()).length;
  } catch {}
  try {
    const dc = fs.readFileSync(path.join(projectRoot, ".ai-memory", "decisions.jsonl"), "utf-8").trim();
    if (dc) decisionsCount = dc.split("\n").filter((l) => l.trim()).length;
  } catch {}

  // Read cumulative stats
  let cumulativeLine = "";
  try {
    const statsModule = require(path.join(__dirname, "..", "..", "scripts", "stats.js"));
    const stats = statsModule.getStats(projectRoot);
    if (stats.totalTokensSaved > 0) {
      cumulativeLine = `  Cumulative: ~${statsModule.formatNumber(stats.totalTokensSaved)} tokens (~${statsModule.formatCost(stats.totalTokensSaved)}), ~${statsModule.formatDuration(stats.totalTimeSavedSeconds)} saved`;
    }
  } catch {}

  const lines = [];
  if (memoryChecked) {
    lines.push(`${G}${B}\u2605 Memory Consulted \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${R}`);
    lines.push(`${G}  \u2713 Memory was checked (${researchCount} research, ${decisionsCount} decisions available)${R}`);
    if (cumulativeLine) lines.push(`${G}${cumulativeLine}${R}`);
    lines.push(`${G}${B}${border}${R}`);
  } else {
    lines.push(`${Y}${B}\u2605 Memory NOT Consulted \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${R}`);
    lines.push(`${Y}  \u25CB Memory was NOT checked before this search!${R}`);
    if (researchCount > 0 || decisionsCount > 0) {
      lines.push(`${Y}  ${researchCount} research + ${decisionsCount} decisions available \u2014 run check-memory first${R}`);
    }
    lines.push(`${Y}${B}${border}${R}`);
  }

  return { text: lines.join("\n"), memoryChecked };
}

function main() {
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf-8");
    input = JSON.parse(raw);
  } catch {
    // No input or invalid JSON
  }

  debugLog(null, `CALLED tool=${input.tool_name || "NONE"} cwd=${input.cwd || "NONE"}`);

  // ── Task completion tracking (fires for TaskCreate/TaskUpdate) ──
  // This runs BEFORE the MATCHED_TOOLS filter since TaskCreate/TaskUpdate
  // are not in MATCHED_TOOLS but we need to track them.
  if (TASK_TOOLS.has(input.tool_name)) {
    const taskCwd = input.cwd || process.cwd();
    const taskRoot = resolveProjectRoot(taskCwd, input.session_id);
    if (taskRoot) {
      const tracker = readTaskTracker(taskRoot);
      const pluginRoot = path.resolve(__dirname, "..", "..").replace(/\\/g, "/");

      if (input.tool_name === "TaskCreate") {
        tracker.created += 1;
        writeTaskTracker(taskRoot, tracker);
      } else if (input.tool_name === "TaskUpdate") {
        const status = (input.tool_input || {}).status;
        if (status === "completed") {
          tracker.completed += 1;
          writeTaskTracker(taskRoot, tracker);

          // Check if ALL tasks are now complete
          if (tracker.completed >= tracker.created && tracker.created > 0) {
            debugLog(taskRoot, `TASK-COMPLETE: ${tracker.completed}/${tracker.created} — blocking for session-summary`);
            const banner = buildTaskCompletionBanner(taskRoot, tracker, pluginRoot);
            process.stdout.write(
              JSON.stringify({ decision: "block", reason: banner })
            );
            process.exit(0);
          }
        } else if (status === "deleted") {
          tracker.created = Math.max(0, tracker.created - 1);
          writeTaskTracker(taskRoot, tracker);
        }
      }
    }
    // TaskCreate/TaskUpdate are not in MATCHED_TOOLS — fall through to exit
  }

  // Only fire for research-indicative tools
  if (!MATCHED_TOOLS.has(input.tool_name)) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  const projectRoot = resolveProjectRoot(cwd, input.session_id);

  debugLog(projectRoot, `projectRoot=${projectRoot || "NULL"} cwd=${cwd} session=${input.session_id || "NONE"}`);

  // No .ai-memory directory — no-op
  if (!projectRoot) {
    debugLog(null, `ALLOW: no projectRoot from cwd=${cwd}`);
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Skip self-calls (save-decision, save-research, check-memory, session-summary)
  if (input.tool_name === "Bash" && isSelfCall(input)) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // ── Periodic summary checkpoint ──
  // Increment tool call counter; block after SUMMARY_CHECKPOINT_CALLS
  {
    const tracker = readTaskTracker(projectRoot);
    tracker.toolCallsSinceSummary += 1;
    writeTaskTracker(projectRoot, tracker);

    if (tracker.toolCallsSinceSummary >= SUMMARY_CHECKPOINT_CALLS) {
      const plugRoot = path.resolve(__dirname, "..", "..").replace(/\\/g, "/");
      debugLog(projectRoot, `PERIODIC-CHECKPOINT: ${tracker.toolCallsSinceSummary} calls — blocking for session-summary`);
      const banner = buildPeriodicCheckpointBanner(projectRoot, tracker, plugRoot);
      process.stdout.write(
        JSON.stringify({ decision: "block", reason: banner })
      );
      process.exit(0);
    }
  }

  // ── Intent-based early exit for operational tools ──
  // Skip save reminders for operational Bash commands (mkdir, git push, npm install, etc.)
  if (input.tool_name === "Bash" && !isExploratoryBash(input)) {
    debugLog(projectRoot, `SKIP: non-exploratory Bash — no save reminder`);
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Skip save reminders for operational Task subagents (code-simplifier, gsd-executor, etc.)
  if (input.tool_name === "Task" && !isExploratoryTask(input)) {
    debugLog(projectRoot, `SKIP: non-exploratory Task/${(input.tool_input || {}).subagent_type} — no save reminder`);
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Read current escalation state
  const state = readState(projectRoot);
  const pluginRoot = path.resolve(__dirname, "..", "..").replace(/\\/g, "/");

  // ── Immediate blocking for high-value research tools ──
  // Task, WebSearch, WebFetch produce ephemeral knowledge that must be saved
  // immediately. Skip the gentle escalation — block right away AND poison state
  // so PreToolUse denies the next tool call unless Claude saves first.
  if (IMMEDIATE_SAVE_TOOLS.has(input.tool_name)) {
    // Check if a save happened since last state write — if so, reset
    const currentSaveTs = getLastSaveTs(projectRoot);
    if (currentSaveTs > state.lastSaveTs && state.lastSaveTs > 0) {
      state.reminderCount = 0;
    }
    // Force escalation — set count above threshold so PreToolUse blocks next call
    state.reminderCount = ESCALATION_THRESHOLD + 1;
    state.ts = Date.now();
    state.lastSaveTs = Math.max(state.lastSaveTs, currentSaveTs);
    writeState(projectRoot, state);

    // Build banner BEFORE clearing gate (so it shows current consultation status)
    const { text: memBanner, memoryChecked } = buildMemoryStatusBanner(projectRoot);

    // Clear memory-check gate so the NEXT search requires a fresh check-memory
    try { fs.unlinkSync(path.join(projectRoot, ".ai-memory", ".last-memory-check")); } catch {}

    const checkMemoryLine = memoryChecked ? "" : `
${M}${B}STEP 1: Check memory FIRST — your answer may already be saved:${R}
${M}  node "${pluginRoot}/scripts/check-memory.js" "relevant keywords for your current task"${R}
${M}${B}STEP 2: Save any NEW discoveries:${R}`;

    const blockReason = `${memBanner}

${M}${B}[project-memory] You just used ${input.tool_name} — knowledge WILL BE LOST if not saved.${R}${checkMemoryLine}
${M}SAVE NOW before doing anything else:${R}
${M}- Decision: node "${pluginRoot}/scripts/save-decision.js" "<category>" "<decision>" "<rationale>"${R}
${M}- Research: node "${pluginRoot}/scripts/save-research.js" "<topic>" "<tags>" "<finding>"${R}
${M}${B}Your next tool call will be DENIED until you save.${R}`;

    process.stdout.write(
      JSON.stringify({ decision: "block", reason: blockReason })
    );
    process.exit(0);
  }

  // ── Gradual escalation for Bash and other tools ──

  // Throttle — max once every 3 minutes
  if (Date.now() - state.ts < THROTTLE_MS) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Check if Claude saved since last reminder (via file mtime)
  const currentSaveTs = getLastSaveTs(projectRoot);
  if (currentSaveTs > state.lastSaveTs && state.lastSaveTs > 0) {
    // A save happened — reset the escalation counter
    state.reminderCount = 0;
  }

  // Increment reminder count and update timestamps
  state.reminderCount += 1;
  state.ts = Date.now();
  state.lastSaveTs = Math.max(state.lastSaveTs, currentSaveTs);
  writeState(projectRoot, state);

  if (state.reminderCount <= ESCALATION_THRESHOLD) {
    // Gentle nudge via systemMessage
    const reminder = `${M}[project-memory] You just used a research tool. Save any findings NOW:${R}
${M}- Decision: node "${pluginRoot}/scripts/save-decision.js" "<category>" "<decision>" "<rationale>"${R}
${M}- Research: node "${pluginRoot}/scripts/save-research.js" "<topic>" "<tags>" "<finding>"${R}
${M}- Check first: node "${pluginRoot}/scripts/check-memory.js" "keywords"${R}
${M}Do NOT skip this. Save immediately, then continue your task.${R}`;

    process.stdout.write(JSON.stringify({ systemMessage: reminder }));
  } else {
    // Escalated block — force Claude to acknowledge
    const { text: memBanner2, memoryChecked: memChecked2 } = buildMemoryStatusBanner(projectRoot);

    const checkMemLine2 = memChecked2 ? "" : `
${M}${B}STEP 1: Check memory FIRST — your answer may already be saved:${R}
${M}  node "${pluginRoot}/scripts/check-memory.js" "relevant keywords for your current task"${R}
${M}${B}STEP 2: Save any NEW discoveries:${R}`;

    const blockReason = `${memBanner2}

${M}${B}[project-memory] Researching ~${state.reminderCount * 3}+ min without saving!${R}${checkMemLine2}
${M}STOP and save your discoveries before continuing:${R}
${M}- Decision: node "${pluginRoot}/scripts/save-decision.js" "<category>" "<decision>" "<rationale>"${R}
${M}- Research: node "${pluginRoot}/scripts/save-research.js" "<topic>" "<tags>" "<finding>"${R}
${M}After saving, you may continue your task.${R}`;

    process.stdout.write(
      JSON.stringify({ decision: "block", reason: blockReason })
    );
  }

  process.exit(0);
}

main();
