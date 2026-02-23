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
 * Always exits 0 (hook contract).
 */

const THROTTLE_MS = 3 * 60 * 1000; // 3 minutes
const ESCALATION_THRESHOLD = 2; // escalate after this many ignored reminders
const MATCHED_TOOLS = new Set(["Bash", "WebFetch", "WebSearch", "Task"]);
const IMMEDIATE_SAVE_TOOLS = new Set(["Task", "WebSearch", "WebFetch"]);

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

function isSelfCall(input) {
  if (!input || !input.tool_input) return false;
  const cmd = input.tool_input.command || "";
  return (
    cmd.includes("save-decision") ||
    cmd.includes("save-research") ||
    cmd.includes("check-memory")
  );
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

function main() {
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf-8");
    input = JSON.parse(raw);
  } catch {
    // No input or invalid JSON
  }

  // Only fire for research-indicative tools
  if (!MATCHED_TOOLS.has(input.tool_name)) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  const projectRoot = findProjectRoot(cwd);

  // No .ai-memory directory — no-op
  if (!projectRoot) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Skip self-calls (save-decision, save-research, check-memory)
  if (input.tool_name === "Bash" && isSelfCall(input)) {
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

    const blockReason = `${M}${B}[project-memory] You just used ${input.tool_name} — knowledge WILL BE LOST if not saved.${R}
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
    const blockReason = `${M}${B}[project-memory] Researching ~${state.reminderCount * 3}+ min without saving!${R}
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
