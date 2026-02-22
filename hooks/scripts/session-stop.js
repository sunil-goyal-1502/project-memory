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

  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    // Not initialized - skip
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
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
