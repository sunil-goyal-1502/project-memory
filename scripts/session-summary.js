#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Session Summary script for project-memory plugin.
 *
 * Outputs a green ★ Session Summary Insight box showing:
 *   - Research and decisions saved THIS session (delta from session start)
 *   - Session savings estimate
 *   - Cumulative savings from metadata.json
 *   - Total memory entries
 *
 * If pending unsaved research is detected (via .last-reminder state),
 * outputs a yellow WARNING before the summary, instructing Claude to
 * save first and re-run.
 *
 * Usage: node session-summary.js
 * Called by Claude as its mandatory final action before ending a session.
 */

const statsModule = require(path.join(__dirname, "stats.js"));
const { C } = statsModule;

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
 * Parse JSONL file and return array of parsed objects.
 */
function parseJsonl(filePath) {
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
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Read escalation state from .last-reminder.
 */
function readReminderState(memDir) {
  const reminderPath = path.join(memDir, ".last-reminder");
  try {
    const raw = fs.readFileSync(reminderPath, "utf-8").trim();
    if (!raw) return null;
    if (raw.startsWith("{")) {
      return JSON.parse(raw);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the most recent modification time of decisions.jsonl and research.jsonl.
 */
function getLastSaveTs(memDir) {
  let maxMtime = 0;
  for (const file of ["decisions.jsonl", "research.jsonl"]) {
    try {
      const stat = fs.statSync(path.join(memDir, file));
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
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.log("No .ai-memory directory found.");
    process.exit(0);
  }

  const memDir = path.join(projectRoot, ".ai-memory");
  const G = C.green;
  const GB = `${C.green}${C.bold}`;
  const Y = C.yellow;
  const YB = `${C.yellow}${C.bold}`;
  const R = C.reset;
  const border = "\u2500".repeat(49);

  // 1. Read session start timestamp
  let sessionStartTs = 0;
  try {
    sessionStartTs = Number(
      fs.readFileSync(path.join(memDir, ".session-start-ts"), "utf-8").trim()
    );
  } catch {}
  const sessionStartIso =
    sessionStartTs > 0
      ? new Date(sessionStartTs).toISOString()
      : new Date(0).toISOString();

  // 2. Parse research and decisions
  const research = parseJsonl(path.join(memDir, "research.jsonl"));
  const decisions = parseJsonl(path.join(memDir, "decisions.jsonl"));

  // 3. Count entries added THIS session (ts > sessionStartIso)
  let sessionResearch = 0;
  let sessionDecisions = 0;
  for (const r of research) {
    if ((r.ts || "") > sessionStartIso) sessionResearch++;
  }
  for (const d of decisions) {
    if ((d.ts || "") > sessionStartIso) sessionDecisions++;
  }

  // 4. Check for pending unsaved research
  const reminderState = readReminderState(memDir);
  let pendingSaves = false;
  if (reminderState && reminderState.reminderCount > 0) {
    // Check if a save happened after the last reminder
    const currentSaveTs = getLastSaveTs(memDir);
    if (currentSaveTs <= (reminderState.lastSaveTs || 0)) {
      pendingSaves = true;
    }
  }

  // 5. Output
  const pluginRoot = path.resolve(__dirname, "..").replace(/\\/g, "/");

  // Yellow WARNING if pending saves
  if (pendingSaves) {
    console.log("");
    console.log(
      `${YB}\u2605 PENDING SAVES DETECTED \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${R}`
    );
    console.log(
      `${Y}  \u26A0 You have unsaved research/decisions!${R}`
    );
    console.log(
      `${Y}  Save them NOW using:${R}`
    );
    console.log(
      `${Y}  node "${pluginRoot}/scripts/save-research.js" "<topic>" "<tags>" "<finding>"${R}`
    );
    console.log(
      `${Y}  node "${pluginRoot}/scripts/save-decision.js" "<category>" "<decision>" "<rationale>"${R}`
    );
    console.log(
      `${Y}  Then re-run: node "${pluginRoot}/scripts/session-summary.js"${R}`
    );
    console.log(`${YB}${border}${R}`);
    console.log("");
  }

  // Green ★ Session Summary
  console.log("");
  console.log(
    `${GB}\u2605 Session Summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${R}`
  );
  console.log(
    `${G}  Research saved this session: ${sessionResearch} ${sessionResearch === 1 ? "entry" : "entries"}${R}`
  );
  console.log(
    `${G}  Decisions saved this session: ${sessionDecisions} ${sessionDecisions === 1 ? "entry" : "entries"}${R}`
  );

  // Session savings estimate (what these saves will save in future sessions)
  const sessionTokens =
    sessionResearch * statsModule.TOKENS_SAVED.session_load_research +
    sessionDecisions * statsModule.TOKENS_SAVED.session_load_decision;
  const sessionTime =
    sessionResearch * statsModule.TIME_SAVED_SEC.session_load_research +
    sessionDecisions * statsModule.TIME_SAVED_SEC.session_load_decision;
  if (sessionTokens > 0) {
    console.log(
      `${G}  Session savings: ~${statsModule.formatNumber(sessionTokens)} tokens (~${statsModule.formatCost(sessionTokens)}), ~${statsModule.formatDuration(sessionTime)} per future session${R}`
    );
  }

  // Cumulative stats
  const stats = statsModule.getStats(projectRoot);
  if (stats.totalTokensSaved > 0) {
    console.log(
      `${G}  Cumulative: ~${statsModule.formatNumber(stats.totalTokensSaved)} tokens (~${statsModule.formatCost(stats.totalTokensSaved)}), ~${statsModule.formatDuration(stats.totalTimeSavedSeconds)} saved across ${statsModule.formatNumber(stats.totalHits)} lookups${R}`
    );
  }

  // Total memory
  console.log(
    `${G}  Total memory: ${research.length} research, ${decisions.length} decisions${R}`
  );
  console.log(`${GB}${border}${R}`);

  // Reset task tracker and write last-session-summary timestamp
  // This unblocks the PostToolUse task-completion and periodic-checkpoint gates
  try {
    fs.writeFileSync(
      path.join(memDir, ".task-tracker"),
      JSON.stringify({ created: 0, completed: 0, toolCallsSinceSummary: 0 }),
      "utf-8"
    );
  } catch {}
  try {
    fs.writeFileSync(
      path.join(memDir, ".last-session-summary"),
      String(Date.now()),
      "utf-8"
    );
  } catch {}
}

main();
