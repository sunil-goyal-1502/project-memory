#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * PostToolUse hook for project-memory plugin.
 *
 * Fires after Bash, WebFetch, WebSearch, or Task tool calls.
 * Injects a brief additionalContext reminder to save decisions/research.
 * Throttled to max once every 3 minutes via .ai-memory/.last-reminder file.
 * Skips self-calls (save-decision.js, save-research.js, check-memory.js).
 * Always exits 0 (hook contract).
 */

const THROTTLE_MS = 3 * 60 * 1000; // 3 minutes
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

function isSelfCall(input) {
  if (!input || !input.tool_input) return false;
  const cmd = input.tool_input.command || "";
  return (
    cmd.includes("save-decision") ||
    cmd.includes("save-research") ||
    cmd.includes("check-memory")
  );
}

function isThrottled(projectRoot) {
  const reminderPath = path.join(projectRoot, ".ai-memory", ".last-reminder");
  try {
    const stat = fs.statSync(reminderPath);
    return Date.now() - stat.mtimeMs < THROTTLE_MS;
  } catch {
    // File doesn't exist — not throttled
    return false;
  }
}

function touchReminder(projectRoot) {
  const reminderPath = path.join(projectRoot, ".ai-memory", ".last-reminder");
  try {
    fs.writeFileSync(reminderPath, String(Date.now()), "utf-8");
  } catch {
    // Non-critical — skip silently
  }
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

  // No .ai-memory → no-op
  if (!projectRoot) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Skip self-calls (save-decision, save-research, check-memory)
  if (input.tool_name === "Bash" && isSelfCall(input)) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Throttle — max once every 3 minutes
  if (isThrottled(projectRoot)) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Touch the throttle file
  touchReminder(projectRoot);

  // Build the reminder
  const pluginRoot = path.resolve(__dirname, "..", "..").replace(/\\/g, "/");

  const reminder = `[project-memory] If you discovered any decisions or research findings, save them NOW before continuing:
- Decision: node "${pluginRoot}/scripts/save-decision.js" "<category>" "<decision>" "<rationale>"
- Research: node "${pluginRoot}/scripts/save-research.js" "<topic>" "<tags>" "<finding>"
- Check first: node "${pluginRoot}/scripts/check-memory.js" "keywords"`;

  const output = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: reminder,
    },
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main();
