#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * PreToolUse hook for project-memory plugin.
 *
 * Enforces the escalation from post-tool-use.js by DENYING research tool
 * calls when the reminder count exceeds the threshold and no save has
 * occurred. This is the hard enforcement — PostToolUse sends advisory
 * messages, but only PreToolUse can physically prevent tool execution.
 *
 * Save commands (save-decision, save-research, check-memory) are always
 * allowed through to avoid deadlock.
 *
 * Unblocks automatically when JSONL file mtime shows a save occurred.
 * Always exits 0 (hook contract).
 */

const ESCALATION_THRESHOLD = 2; // deny after this many ignored reminders
const MATCHED_TOOLS = new Set(["Bash", "WebFetch", "WebSearch", "Task"]);

// ── Debug logging ──
function debugLog(projectRoot, msg) {
  try {
    const logPath = projectRoot
      ? path.join(projectRoot, ".ai-memory", ".hook-debug.log")
      : path.join(process.env.USERPROFILE || process.env.HOME || "/tmp", ".hook-debug.log");
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] PRE: ${msg}\n`, "utf-8");
  } catch { /* non-critical */ }
}
const EXPLORATION_SUBAGENTS = new Set(["Explore", "Plan", "general-purpose", "feature-dev:code-explorer", "feature-dev:code-architect"]);
const MEMORY_CHECK_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ANSI colors for visible memory messages
const M = "\x1b[95m"; // bright magenta
const B = "\x1b[1m";  // bold
const R = "\x1b[0m";  // reset

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

  // Fallback: look up session registry written by session-start
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

function isSaveCall(input) {
  if (!input || !input.tool_input) return false;
  const cmd = input.tool_input.command || "";
  return (
    cmd.includes("save-decision") ||
    cmd.includes("save-research") ||
    cmd.includes("check-memory") ||
    cmd.includes("session-summary")
  );
}

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

/**
 * Check if check-memory.js was run recently (within MEMORY_CHECK_TTL_MS).
 */
function wasMemoryChecked(projectRoot) {
  const memCheckPath = path.join(projectRoot, ".ai-memory", ".last-memory-check");
  try {
    const ts = Number(fs.readFileSync(memCheckPath, "utf-8").trim());
    return Date.now() - ts < MEMORY_CHECK_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Check if research.jsonl has any entries.
 */
function hasResearch(projectRoot) {
  try {
    const stat = fs.statSync(path.join(projectRoot, ".ai-memory", "research.jsonl"));
    return stat.size > 50; // more than just whitespace
  } catch {
    return false;
  }
}

function readState(projectRoot) {
  const reminderPath = path.join(projectRoot, ".ai-memory", ".last-reminder");
  const defaultState = { ts: 0, reminderCount: 0, lastSaveTs: 0 };
  try {
    const raw = fs.readFileSync(reminderPath, "utf-8").trim();
    if (!raw) return defaultState;
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      return {
        ts: parsed.ts || 0,
        reminderCount: parsed.reminderCount || 0,
        lastSaveTs: parsed.lastSaveTs || 0,
      };
    }
    const ts = Number(raw);
    if (!isNaN(ts)) {
      return { ts, reminderCount: 0, lastSaveTs: 0 };
    }
    return defaultState;
  } catch {
    return defaultState;
  }
}

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
      // File doesn't exist
    }
  }
  return maxMtime;
}

function main() {
  let input = {};
  let parseError = null;
  try {
    const raw = fs.readFileSync(0, "utf-8");
    input = JSON.parse(raw);
  } catch (e) {
    parseError = e.message;
  }

  debugLog(null, `CALLED tool=${input.tool_name || "NONE"} subagent=${(input.tool_input || {}).subagent_type || "NONE"} cwd=${input.cwd || "NONE"} parseError=${parseError || "NONE"}`);

  // Only gate research-indicative tools
  if (!MATCHED_TOOLS.has(input.tool_name)) {
    debugLog(null, `ALLOW: tool ${input.tool_name} not in MATCHED_TOOLS`);
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Always allow save/check-memory commands through (prevent deadlock)
  if (input.tool_name === "Bash" && isSaveCall(input)) {
    debugLog(null, `ALLOW: save/check-memory call`);
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  const projectRoot = resolveProjectRoot(cwd, input.session_id);

  debugLog(projectRoot, `projectRoot=${projectRoot || "NULL"} cwd=${cwd} session=${input.session_id || "NONE"}`);

  if (!projectRoot) {
    debugLog(null, `ALLOW: no projectRoot found from cwd=${cwd}`);
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  const pluginRoot = path.resolve(__dirname, "..", "..").replace(/\\/g, "/");

  // ── GATE 1: Exploration tools require memory check first ──
  // If research exists but check-memory hasn't been run recently, DENY
  // exploration subagent calls. This forces Claude to consult memory before
  // re-investigating things already researched in previous sessions.
  if (input.tool_name === "Task") {
    const subagentType = (input.tool_input || {}).subagent_type || "";
    const researchExists = hasResearch(projectRoot);
    const memChecked = wasMemoryChecked(projectRoot);
    debugLog(projectRoot, `GATE1: Task subagent=${subagentType} inSet=${EXPLORATION_SUBAGENTS.has(subagentType)} research=${researchExists} memChecked=${memChecked}`);
    if (EXPLORATION_SUBAGENTS.has(subagentType) && researchExists) {
      if (!memChecked) {
        const reason = `${M}${B}[project-memory] BLOCKED: You MUST check memory before exploring.${R}
${M}Research findings exist from previous sessions. Run check-memory FIRST:${R}
${M}  node "${pluginRoot}/scripts/check-memory.js" "relevant keywords"${R}
${M}If memory covers what you need, USE it directly. Only explore if no matches found.${R}`;

        debugLog(projectRoot, `DENY: GATE1 — Task/${subagentType} blocked, memory not checked`);
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          })
        );
        process.exit(0);
      } else {
        debugLog(projectRoot, `ALLOW: GATE1 — Task/${subagentType} allowed, memory was checked`);
      }
    }
  }

  // ── GATE 2: Research tools require memory check first ──
  // Blocks WebSearch, WebFetch, and Task until check-memory.js has been run.
  // Bash is only blocked when the command is exploratory (curl, grep, git log, etc.)
  // Operational Bash (mkdir, git commit, npm install, etc.) always passes through.
  // Self-calls (save-*/check-memory/session-summary) are already exempted above.
  const isExploratory = input.tool_name !== "Bash" || isExploratoryBash(input);
  if (isExploratory && hasResearch(projectRoot)) {
    debugLog(projectRoot, `GATE2: ${input.tool_name} memChecked=${wasMemoryChecked(projectRoot)} exploratory=${isExploratory}`);
    if (!wasMemoryChecked(projectRoot)) {
      const reason = `${M}${B}[project-memory] BLOCKED: You MUST check memory before proceeding.${R}
${M}Research findings from previous sessions may already have what you need.${R}
${M}Run check-memory FIRST:${R}
${M}  node "${pluginRoot}/scripts/check-memory.js" "relevant keywords for your current task"${R}
${M}If memory covers what you need, USE it directly. Only proceed if no matches found.${R}`;

      debugLog(projectRoot, `DENY: GATE2 — ${input.tool_name} blocked, memory not checked`);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        })
      );
      process.exit(0);
    }
  } else if (input.tool_name === "Bash" && !isExploratory) {
    debugLog(projectRoot, `ALLOW: GATE2 — Bash pass-through (non-exploratory)`);
  }

  // ── GATE 3: Escalation-based denial (save reminders exceeded) ──
  // Non-exploratory Bash is exempt from escalation blocking too.
  if (!isExploratory) {
    debugLog(projectRoot, `ALLOW: GATE3 — Bash pass-through (non-exploratory)`);
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  const state = readState(projectRoot);

  // Not escalated yet — allow
  if (state.reminderCount <= ESCALATION_THRESHOLD) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Check if a save happened since last reminder (unblocks after saving)
  const currentSaveTs = getLastSaveTs(projectRoot);
  if (currentSaveTs > state.lastSaveTs) {
    // Save detected — allow through (PostToolUse will reset counter next time)
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Escalated and no save — DENY the tool call
  const reason = `${M}${B}[project-memory] BLOCKED: ${state.reminderCount} save reminders ignored.${R}
${M}You MUST save your discoveries NOW before using any more research tools:${R}
${M}- node "${pluginRoot}/scripts/save-decision.js" "<category>" "<decision>" "<rationale>"${R}
${M}- node "${pluginRoot}/scripts/save-research.js" "<topic>" "<tags>" "<finding>"${R}`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

main();
