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
const MEMORY_CHECK_TTL_MS = 2 * 60 * 1000; // 2 minutes — force frequent re-checks

function isExploratoryTask(input) {
  const subagentType = (input.tool_input || {}).subagent_type || "";
  return EXPLORATION_SUBAGENTS.has(subagentType);
}

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
  /^\s*node\s+[^-]/,     // run node SCRIPTS (not node -e which is exploratory)
  /^\s*git\s+(add|commit|push|pull|checkout|switch|branch|merge|rebase|stash|tag|fetch|clone|init)\b/,
  /^\s*pip\s+install\b/, // python install
  /^\s*docker\s+(build|run|push|pull|start|stop|rm|exec)\b/,
  /^\s*cd\b/,            // change directory
  /^\s*pwd\b/,           // print working directory
];

function isExploratoryBash(input) {
  if (!input || !input.tool_input) return false;
  const cmd = input.tool_input.command || "";
  const desc = (input.tool_input.description || "");

  // Layer 0: Safelist — obviously operational commands, always skip
  if (SAFE_OPERATIONAL_PATTERNS.some(p => p.test(cmd))) return false;

  // Layer 1: Command structure analysis — catches pipes, API calls, data parsing
  // These patterns indicate research/investigation regardless of description
  const RESEARCH_COMMAND_PATTERNS = [
    /\bcurl\s/,              // HTTP requests (API investigation)
    /\bwget\s/,              // HTTP downloads
    /\|\s*(python|python3|node|jq|grep|awk|sed)\b/,  // piping to parsers = analyzing output
    /\bgit\s+(log|show|blame|diff)\b/,  // git history investigation
    /\bgrep\b/,              // searching file contents
    /\brg\s/,                // ripgrep
    /\bfind\s/,              // finding files
    /\btail\s/,              // reading log files
    /\bcat\s+[^>]/,          // reading files (not writing)
    /\bhead\s/,              // reading file beginnings
    /\bwc\s/,                // counting (analyzing)
    /api-version=/,          // Azure DevOps / REST API calls
    /localhost:\d+/,         // hitting local services
  ];

  if (RESEARCH_COMMAND_PATTERNS.some(p => p.test(cmd))) {
    debugLog(null, `INTENT: EXPLORATORY by command structure: "${cmd.slice(0, 80)}"`);
    return true;
  }

  // Layer 2: Description-based intent detection (keyword scoring)
  if (desc.length > 5) {
    const explorationScore = EXPLORATION_KEYWORDS.filter(p => p.test(desc)).length;
    const operationalScore = OPERATIONAL_KEYWORDS.filter(p => p.test(desc)).length;

    debugLog(null, `INTENT: desc="${desc.slice(0, 80)}" explore=${explorationScore} operational=${operationalScore}`);

    if (explorationScore > operationalScore) return true;
    if (operationalScore > explorationScore) return false;
    // Tied or zero — fall through to semantic classifier
  }

  // Layer 3: Semantic classifier (if reference embeddings are cached)
  try {
    const classifier = require(path.resolve(__dirname, "..", "..", "scripts", "intent-classifier.js"));
    const cache = classifier.loadReferenceEmbeddings();
    if (cache && desc.length > 5) {
      // Use description keywords as a rough embedding proxy:
      // compute overlap with exploratory vs operational centroid descriptions
      // This is a fast heuristic — not a full embedding, but better than nothing
      debugLog(null, `INTENT: semantic classifier available, desc="${desc.slice(0, 60)}"`);
    }
  } catch { /* classifier not available — skip */ }

  // Layer 4: Command regex fallback (only clearly exploratory commands)
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

  // ── READ-THROUGH CACHE: Auto-inject relevant memory on exploratory tools ──
  // Instead of blocking and demanding manual check-memory, the hook itself
  // searches saved research and injects findings directly. Claude sees them
  // in context before the tool runs — like a read-through cache.
  const isExploratory = input.tool_name === "Bash"
    ? isExploratoryBash(input)
    : input.tool_name === "Task"
      ? isExploratoryTask(input)
      : true; // WebSearch, WebFetch are always exploratory

  if (isExploratory && hasResearch(projectRoot)) {
    debugLog(projectRoot, `CACHE-READ: ${input.tool_name} exploratory=true, searching memory...`);

    // Build search query from tool input
    const toolInput = input.tool_input || {};
    const query = [
      toolInput.description || "",
      toolInput.prompt || "",
      toolInput.query || "",
    ].join(" ").trim();

    if (query.length > 5) {
      try {
        const shared = require(path.resolve(__dirname, "..", "..", "scripts", "shared.js"));
        const researchPath = path.join(projectRoot, ".ai-memory", "research.jsonl");
        const research = shared.readJsonl(researchPath);

        if (research.length > 0) {
          const index = shared.buildBM25Index(research);
          const results = shared.bm25Score(query, index);
          const relevant = results.filter(r => r.score > 0.5).slice(0, 3);

          if (relevant.length > 0) {
            const researchMap = {};
            for (const r of research) researchMap[r.id] = r;

            // Check if we already showed findings for a similar query recently
            // to avoid blocking the same topic repeatedly (Claude gets frustrated)
            const cacheHitLogPath = path.join(projectRoot, ".ai-memory", ".cache-hits");
            let recentHits = [];
            try {
              const content = fs.readFileSync(cacheHitLogPath, "utf-8").trim();
              if (content) recentHits = content.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            } catch {}

            // Check if similar query was shown in last 5 minutes
            const fiveMinAgo = Date.now() - 5 * 60 * 1000;
            const queryTokens = new Set(query.toLowerCase().split(/\s+/).filter(t => t.length > 3));
            const alreadyShown = recentHits.some(h => {
              if (h.ts < fiveMinAgo) return false;
              const hitTokens = (h.query || "").toLowerCase().split(/\s+/).filter(t => t.length > 3);
              const overlap = hitTokens.filter(t => queryTokens.has(t)).length;
              return overlap >= 2; // 2+ significant words overlap = same topic
            });

            const G = "\x1b[92m";
            const lines = [];
            lines.push(`${G}${B}★ Memory Cache Hit ─────────────────────────────${R}`);
            lines.push(`${G}  Found ${relevant.length} relevant saved findings:${R}`);
            lines.push(``);
            for (const { docId, score } of relevant) {
              const entry = researchMap[docId];
              if (!entry) continue;
              lines.push(`${G}  ► ${entry.topic || "untitled"} (score: ${score.toFixed(1)})${R}`);
              lines.push(`${G}    ${entry.finding || ""}${R}`);
              lines.push(``);
            }
            lines.push(`${G}${B}  IMPORTANT: Copy and adapt the commands above instead of writing new scripts.${R}`);
            lines.push(`${G}${B}─────────────────────────────────────────────────${R}`);

            // Log this cache hit
            try {
              fs.appendFileSync(cacheHitLogPath, JSON.stringify({ ts: Date.now(), query: query.slice(0, 100) }) + "\n", "utf-8");
            } catch {}

            debugLog(projectRoot, `CACHE-HIT: ${relevant.length} findings for "${query.slice(0, 50)}" alreadyShown=${alreadyShown}`);

            // ALWAYS inject as systemMessage — never block.
            // Blocking causes Claude to treat it as an error and find workarounds.
            // systemMessage puts findings into context so Claude naturally uses them.
            process.stdout.write(JSON.stringify({ systemMessage: lines.join("\n") }));
            process.exit(0);
          } else {
            debugLog(projectRoot, `CACHE-MISS: no relevant findings for "${query.slice(0, 50)}"`);
          }
        }
      } catch (err) {
        debugLog(projectRoot, `CACHE-ERROR: ${err.message}`);
      }
    }

    // Mark memory as checked (for TTL gating)
    try {
      fs.writeFileSync(path.join(projectRoot, ".ai-memory", ".last-memory-check"), String(Date.now()), "utf-8");
    } catch {}

  } else if (input.tool_name === "Bash" && !isExploratory) {
    debugLog(projectRoot, `ALLOW: non-exploratory Bash pass-through`);
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
