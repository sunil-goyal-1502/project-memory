#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { condenseTranscript } = require("../../scripts/condense-transcript");

/**
 * Stop hook for project-memory plugin.
 *
 * Reads from stdin: { session_id, transcript_path, cwd }
 * Condenses the session transcript and saves to .ai-memory/.last-session.txt
 * Outputs {} to stdout. Always exits 0.
 */

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

async function main() {
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf-8");
    input = JSON.parse(raw);
  } catch {
    // No input or invalid JSON
  }

  const cwd = input.cwd || process.cwd();
  const transcriptPath = input.transcript_path;
  const sessionId = input.session_id;

  // Clean up session registry entry
  if (sessionId) {
    try {
      const sessFile = path.join(
        process.env.USERPROFILE || process.env.HOME || "/tmp",
        ".ai-memory-sessions",
        sessionId
      );
      fs.unlinkSync(sessFile);
    } catch { /* doesn't exist — fine */ }
  }

  // Try cwd first, then session registry fallback (Windows cwd bug)
  let projectRoot = findProjectRoot(cwd);
  if (!projectRoot && sessionId) {
    try {
      const sessFile = path.join(
        process.env.USERPROFILE || process.env.HOME || "/tmp",
        ".ai-memory-sessions",
        sessionId
      );
      const savedRoot = fs.readFileSync(sessFile, "utf-8").trim();
      if (savedRoot && fs.existsSync(path.join(savedRoot, ".ai-memory"))) {
        projectRoot = savedRoot;
      }
    } catch { /* not found */ }
  }
  if (!projectRoot) {
    // Not initialized - skip
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Write session summary to file for persistence (backup if Claude didn't run session-summary.js)
  try {
    const statsModule = require("../../scripts/stats.js");

    // Read session start timestamp
    let sessionStartTs = 0;
    try {
      sessionStartTs = Number(
        fs.readFileSync(path.join(projectRoot, ".ai-memory", ".session-start-ts"), "utf-8").trim()
      );
    } catch {}
    const sessionStartIso = sessionStartTs > 0
      ? new Date(sessionStartTs).toISOString()
      : new Date(0).toISOString();

    // Count entries added this session
    let sessionResearch = 0;
    let sessionDecisions = 0;

    const researchPath = path.join(projectRoot, ".ai-memory", "research.jsonl");
    if (fs.existsSync(researchPath)) {
      const content = fs.readFileSync(researchPath, "utf-8").trim();
      if (content) {
        for (const line of content.split("\n")) {
          try {
            const entry = JSON.parse(line.trim());
            if ((entry.ts || "") > sessionStartIso) sessionResearch++;
          } catch {}
        }
      }
    }

    const decisionsPath = path.join(projectRoot, ".ai-memory", "decisions.jsonl");
    if (fs.existsSync(decisionsPath)) {
      const content = fs.readFileSync(decisionsPath, "utf-8").trim();
      if (content) {
        for (const line of content.split("\n")) {
          try {
            const entry = JSON.parse(line.trim());
            if ((entry.ts || "") > sessionStartIso) sessionDecisions++;
          } catch {}
        }
      }
    }

    const stats = statsModule.getStats(projectRoot);
    const summaryLines = [
      `Session Summary (${new Date().toISOString()})`,
      `Research saved this session: ${sessionResearch}`,
      `Decisions saved this session: ${sessionDecisions}`,
      `Cumulative: ~${statsModule.formatNumber(stats.totalTokensSaved)} tokens (~${statsModule.formatCost(stats.totalTokensSaved)}), ~${statsModule.formatDuration(stats.totalTimeSavedSeconds)} saved`,
      "",
    ];
    fs.writeFileSync(
      path.join(projectRoot, ".ai-memory", ".session-summary.txt"),
      summaryLines.join("\n"),
      "utf-8"
    );
  } catch {
    // Non-critical — don't fail the hook
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    // No transcript available
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  try {
    const condensed = condenseTranscript(transcriptPath);
    if (condensed && condensed.trim().length > 0) {
      const outputPath = path.join(
        projectRoot,
        ".ai-memory",
        ".last-session.txt"
      );
      fs.writeFileSync(outputPath, condensed, "utf-8");
    }
  } catch {
    // Don't fail the hook on transcript processing errors
  }

  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
});
