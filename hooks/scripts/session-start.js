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

const STALENESS_DAYS = 7; // Research older than this is considered stale

/**
 * Format research findings — full content, no truncation.
 * Filters out stale research (older than STALENESS_DAYS).
 * Returns { text, freshCount, staleCount }.
 */
function formatResearchFindings(research) {
  if (research.length === 0) return { text: "", freshCount: 0, staleCount: 0 };

  const cutoff = new Date(Date.now() - STALENESS_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const fresh = [];
  const stale = [];
  for (const r of research) {
    if ((r.ts || "") < cutoff) {
      stale.push(r);
    } else {
      fresh.push(r);
    }
  }

  // Sort fresh findings by timestamp descending (most recent first)
  fresh.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));

  // Full content — no truncation
  const lines = fresh.map((r) => {
    const staleness = r.staleness || "stable";
    const badge = staleness === "stable" ? "" : ` [${staleness}]`;
    return `- **${r.topic || "untitled"}**${badge}: ${r.finding || ""}`;
  });

  return { text: lines.join("\n"), freshCount: fresh.length, staleCount: stale.length };
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

  // Clear memory-check gate so exploration requires a fresh check each session
  const memCheckPath = path.join(projectRoot, ".ai-memory", ".last-memory-check");
  try { fs.unlinkSync(memCheckPath); } catch { /* doesn't exist — fine */ }

  // Clear escalation state so reminders start fresh each session
  const reminderPath = path.join(projectRoot, ".ai-memory", ".last-reminder");
  try { fs.unlinkSync(reminderPath); } catch { /* doesn't exist — fine */ }

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

  // ── 3. Research findings (full content, staleness-filtered) ──
  if (research.length > 0) {
    const { text: findingsList, freshCount, staleCount } = formatResearchFindings(research);

    if (freshCount > 0) {
      messageParts.push(
        `\nResearch Memory: ${freshCount} findings loaded (full content). **USE these — do NOT re-investigate:**\n${findingsList}`
      );
    }

    if (staleCount > 0) {
      messageParts.push(
        `\n_(${staleCount} older findings filtered — older than ${STALENESS_DAYS} days. Run check-memory.js to search all including stale.)_`
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
- The research findings above contain FULL content from previous sessions. USE them directly.
- For keyword search across all findings (including stale): \`node "${pluginRoot}/scripts/check-memory.js" "keywords"\`
- ONLY read source files or launch Explore agents for topics NOT covered by saved research.`
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
