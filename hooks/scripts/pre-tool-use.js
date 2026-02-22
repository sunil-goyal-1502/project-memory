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

function isSaveCall(input) {
  if (!input || !input.tool_input) return false;
  const cmd = input.tool_input.command || "";
  return (
    cmd.includes("save-decision") ||
    cmd.includes("save-research") ||
    cmd.includes("check-memory")
  );
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
  try {
    const raw = fs.readFileSync(0, "utf-8");
    input = JSON.parse(raw);
  } catch {
    // No input — allow by default
  }

  // Only gate research-indicative tools
  if (!MATCHED_TOOLS.has(input.tool_name)) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Always allow save/check-memory commands through (prevent deadlock)
  if (input.tool_name === "Bash" && isSaveCall(input)) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  const projectRoot = findProjectRoot(cwd);

  if (!projectRoot) {
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
  const pluginRoot = path.resolve(__dirname, "..", "..").replace(/\\/g, "/");
  const reason = `[project-memory] BLOCKED: You have received ${state.reminderCount} save reminders without saving any findings.\nYou MUST save your discoveries NOW before using any more research tools:\n- node "${pluginRoot}/scripts/save-decision.js" "<category>" "<decision>" "<rationale>"\n- node "${pluginRoot}/scripts/save-research.js" "<topic>" "<tags>" "<finding>"`;

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
