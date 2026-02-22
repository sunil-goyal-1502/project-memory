#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * SessionStart hook for project-memory plugin.
 *
 * Reads from stdin: { session_id, cwd, transcript_path }
 * Outputs JSON to stdout with systemMessage containing loaded decisions and research summary.
 * Always exits 0 (hook contract).
 */

function findProjectRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, ".ai-memory", "decisions.jsonl"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readDecisions(projectRoot) {
  const filePath = path.join(projectRoot, ".ai-memory", "decisions.jsonl");
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  const decisions = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      decisions.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }
  return decisions;
}

function readResearch(projectRoot) {
  const filePath = path.join(projectRoot, ".ai-memory", "research.jsonl");
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  const research = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      research.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }
  return research;
}

function summarizeDecisions(decisions) {
  const categories = {};
  for (const d of decisions) {
    const cat = d.category || "other";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(d.decision);
  }

  const parts = [];
  for (const [cat, items] of Object.entries(categories)) {
    parts.push(`${cat} (${items.length})`);
  }
  return parts.join(", ");
}

function summarizeResearch(research) {
  if (research.length === 0) return "";

  // Sort by timestamp descending (most recent first), cap at 50
  const sorted = [...research].sort((a, b) =>
    (b.ts || "").localeCompare(a.ts || "")
  );
  const capped = sorted.slice(0, 50);

  const topicParts = capped.map((r) => {
    const staleness = r.staleness || "stable";
    const version = r.version_anchored ? `:${r.version_anchored}` : "";
    return `${r.topic || "untitled"} [${staleness}${version}]`;
  });

  return topicParts.join(", ");
}

async function main() {
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf-8");
    input = JSON.parse(raw);
  } catch {
    // No input or invalid JSON - use defaults
  }

  const cwd = input.cwd || process.cwd();
  const projectRoot = findProjectRoot(cwd);

  if (!projectRoot) {
    // No .ai-memory found - output empty (no message)
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  const decisions = readDecisions(projectRoot);
  const research = readResearch(projectRoot);
  const messageParts = [];

  // Track savings
  const statsModule = require(path.join(__dirname, "..", "..", "scripts", "stats.js"));
  let sessionTokensSaved = 0;
  let sessionTimeSaved = 0;

  if (decisions.length > 0) {
    const summary = summarizeDecisions(decisions);
    messageParts.push(
      `Project Memory: ${decisions.length} decisions loaded [${summary}].`
    );

    // Include the actual decisions as concise context
    const categories = {};
    for (const d of decisions) {
      const cat = d.category || "other";
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(d.decision);
    }
    const lines = [];
    for (const [cat, items] of Object.entries(categories)) {
      lines.push(`**${cat}**: ${items.join("; ")}`);
    }
    messageParts.push(lines.join("\n"));
  } else {
    messageParts.push(
      "Project Memory: initialized but no decisions recorded yet. Use /memory:save to capture decisions."
    );
  }

  // Research summary
  if (research.length > 0) {
    const topicIndex = summarizeResearch(research);
    messageParts.push(
      `\nResearch Memory: ${research.length} findings. Topics: ${topicIndex}`
    );
    messageParts.push(
      "Check .ai-memory/research.jsonl before investigating APIs, libraries, errors, or patterns."
    );

    if (research.length > 100) {
      messageParts.push(
        `Research memory has ${research.length} entries. Consider /project-memory:research-compact.`
      );
    }
  }

  // Record savings events and compute session totals
  if (decisions.length > 0) {
    statsModule.recordEvent(projectRoot, "session_load_decision", decisions.length);
    sessionTokensSaved += decisions.length * statsModule.TOKENS_SAVED.session_load_decision;
    sessionTimeSaved += decisions.length * statsModule.TIME_SAVED_SEC.session_load_decision;
  }
  if (research.length > 0) {
    statsModule.recordEvent(projectRoot, "session_load_research", research.length);
    sessionTokensSaved += research.length * statsModule.TOKENS_SAVED.session_load_research;
    sessionTimeSaved += research.length * statsModule.TIME_SAVED_SEC.session_load_research;
  }

  // Append savings line
  if (sessionTokensSaved > 0) {
    const stats = statsModule.getStats(projectRoot);
    messageParts.push(statsModule.formatStatsLine(sessionTokensSaved, sessionTimeSaved, stats));
  }

  // Check for pending transcript extraction — instruct Claude to auto-extract
  const lastSessionPath = path.join(
    projectRoot,
    ".ai-memory",
    ".last-session.txt"
  );
  if (fs.existsSync(lastSessionPath)) {
    const stat = fs.statSync(lastSessionPath);
    if (stat.size > 0) {
      messageParts.push(
        "\n**AUTO-EXTRACT**: Previous session transcript is pending. Immediately run /project-memory:memory-extract followed by /project-memory:research-extract to capture decisions and research from the last session. Do this now before responding to the user's first message."
      );
    }
  }

  // Standing instructions for automatic saving during conversation
  const pluginRoot = path.resolve(__dirname, "..", "..").replace(/\\/g, "/");

  messageParts.push(
    `\n**MANDATORY AUTO-SAVE** — You MUST do this throughout the ENTIRE session without being asked:

**Save decisions** — When ANY project decision is made, IMMEDIATELY run:
\`\`\`bash
node "${pluginRoot}/scripts/save-decision.js" "<category>" "<decision>" "<rationale>"
\`\`\`
Categories: architecture|constraint|convention|testing|scope|unresolved. Examples: tech choices, patterns, naming conventions, scope boundaries, constraints.

**Save research** — When you discover ANYTHING technical, IMMEDIATELY run:
\`\`\`bash
node "${pluginRoot}/scripts/save-research.js" "<topic>" "<tags>" "<finding>" [stable|versioned|volatile]
\`\`\`
Examples: API behavior, library quirks, error root causes, config requirements, workarounds, performance findings.

**Search first** — Before investigating any API/library/error, FIRST read \`.ai-memory/research.jsonl\` for existing findings.

**If in doubt, SAVE IT.** Saving too much is far better than losing knowledge.`
  );

  const output = { systemMessage: messageParts.join("\n") };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
});
