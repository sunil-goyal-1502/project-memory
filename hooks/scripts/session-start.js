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

/**
 * Format research findings with truncated content so Claude can actually USE them.
 * Returns a multi-line string with each finding's topic + truncated finding text.
 * Uses a total budget of ~12000 chars across all findings to stay within
 * reasonable system message limits while maximizing content per finding.
 */
function formatResearchFindings(research) {
  if (research.length === 0) return "";

  // Sort by timestamp descending (most recent first), cap at 30
  const sorted = [...research].sort((a, b) =>
    (b.ts || "").localeCompare(a.ts || "")
  );
  const capped = sorted.slice(0, 30);

  // Calculate per-finding budget from total budget
  const TOTAL_BUDGET = 12000; // ~3000 tokens total for all findings
  const perFinding = Math.max(200, Math.floor(TOTAL_BUDGET / capped.length));

  const lines = capped.map((r) => {
    const staleness = r.staleness || "stable";
    const badge = staleness === "stable" ? "" : ` [${staleness}]`;
    const finding = r.finding || "";
    const truncated = finding.length > perFinding
      ? finding.substring(0, perFinding) + "..."
      : finding;
    return `- **${r.topic || "untitled"}**${badge}: ${truncated}`;
  });

  return lines.join("\n");
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

  // ── 1. Stats banner (FIRST LINE) ──
  const stats = statsModule.getStats(projectRoot);
  const statsBanner = sessionTokensSaved > 0
    ? `**[project-memory]** Loaded: ${decisions.length} decisions, ${research.length} research | ${statsModule.formatStatsLine(sessionTokensSaved, sessionTimeSaved, stats)}`
    : `**[project-memory]** Loaded: ${decisions.length} decisions, ${research.length} research`;
  messageParts.push(statsBanner);

  // ── 2. Decision summary ──
  if (decisions.length > 0) {
    const summary = summarizeDecisions(decisions);
    messageParts.push(
      `\nProject Decisions [${summary}]:`
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
      "\nProject Memory: initialized but no decisions recorded yet. Use /memory:save to capture decisions."
    );
  }

  // ── 3. Research findings (with actual content so Claude can USE them) ──
  if (research.length > 0) {
    const findingsList = formatResearchFindings(research);
    messageParts.push(
      `\nResearch Memory: ${research.length} findings loaded. **USE these instead of re-investigating:**\n${findingsList}`
    );

    messageParts.push(
      `\n**READ FULL FINDINGS** — The summaries above are truncated. For full details, read \`.ai-memory/research.jsonl\` BEFORE reading source files. Reading 1 memory file replaces reading 20+ source files.`
    );

    if (research.length > 30) {
      messageParts.push(
        `(Showing 30 most recent of ${research.length}. Run check-memory.js for full search.)`
      );
    }

    if (research.length > 100) {
      messageParts.push(
        `Research memory has ${research.length} entries. Consider /project-memory:research-compact.`
      );
    }
  }

  // ── 4. CITE MEMORY instruction ──
  messageParts.push(
    `\n**CITE MEMORY** — The decisions and research findings above are REAL knowledge from previous sessions. When they are relevant to your current task:
1. START your response with: > [project-memory] Using saved finding: "<topic>" — <1-line summary>
2. USE the finding content directly — do NOT re-explore or re-investigate what is already saved above.
3. This proves to the user that memory is working and avoids wasting time on redundant research.`
  );

  // ── 5. CHECK FIRST instruction ──
  const pluginRoot = path.resolve(__dirname, "..", "..").replace(/\\/g, "/");

  messageParts.push(
    `\n**CHECK FIRST — DO NOT explore or investigate what you already know:**
1. Read the research summaries above — if a topic is covered, USE it. Do NOT re-read source files.
2. If you need full details beyond the summaries, read \`.ai-memory/research.jsonl\` (1 file vs 20+ source files).
3. For keyword search: \`node "${pluginRoot}/scripts/check-memory.js" "keywords"\`
4. ONLY read source files or launch Explore agents for topics NOT covered by saved research.`
  );

  // ── 6. IMMEDIATE SAVE TRIGGERS ──
  messageParts.push(
    `\n**IMMEDIATE SAVE TRIGGERS** — Save immediately (do NOT delay) after:
- ANY codebase exploration (Task/Explore agent, reading multiple files for research)
- ANY web search or URL fetch (WebSearch, WebFetch)
- When the user gives an instruction, constraint, or asks you to remember something
- When you discover API behavior, error causes, library quirks, or workarounds`
  );

  // ── 7. Auto-save instructions ──
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

**If in doubt, SAVE IT.** Saving too much is far better than losing knowledge.`
  );

  // ── 8. Auto-extract reminder (if pending) ──
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

  const output = { systemMessage: messageParts.join("\n") };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
});
