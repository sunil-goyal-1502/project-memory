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
    if (fs.existsSync(path.join(dir, ".ai-memory"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Windows fallback: when cwd is C:\Windows\System32 (or any system dir),
 * scan $USERPROFILE and its immediate children for .ai-memory directories.
 * Returns the most recently modified project root, or null.
 */
function scanHomeForProjects() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return null;

  const candidates = [];

  // Check home itself
  if (fs.existsSync(path.join(home, ".ai-memory"))) {
    candidates.push(home);
  }

  // Check immediate children
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
  } catch { /* permission errors, etc */ }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple projects: use the one with the most recently modified .ai-memory
  candidates.sort((a, b) => {
    try {
      const aStat = fs.statSync(path.join(a, ".ai-memory"));
      const bStat = fs.statSync(path.join(b, ".ai-memory"));
      return bStat.mtimeMs - aStat.mtimeMs;
    } catch {
      return 0;
    }
  });
  return candidates[0];
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
  let projectRoot = findProjectRoot(cwd);

  // Windows fallback: cwd is often C:\Windows\System32 instead of project dir
  if (!projectRoot) {
    projectRoot = scanHomeForProjects();
  }

  if (!projectRoot) {
    // No .ai-memory found - output empty (no message)
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // ── Register project root for this session ──
  // On Windows, hook subprocess cwd can be C:\WINDOWS\system32 instead of
  // the project directory. Session-start gets the correct cwd, so we persist
  // it for PreToolUse/PostToolUse to look up by session_id.
  const sessionId = input.session_id;
  if (sessionId) {
    const sessDir = path.join(
      process.env.USERPROFILE || process.env.HOME || "/tmp",
      ".ai-memory-sessions"
    );
    try {
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, sessionId), projectRoot, "utf-8");
    } catch { /* non-critical */ }
  }

  // Clear memory-check gate so exploration requires a fresh check each session
  const memCheckPath = path.join(projectRoot, ".ai-memory", ".last-memory-check");
  try { fs.unlinkSync(memCheckPath); } catch { /* doesn't exist — fine */ }

  // Clear escalation state so reminders start fresh each session
  const reminderPath = path.join(projectRoot, ".ai-memory", ".last-reminder");
  try { fs.unlinkSync(reminderPath); } catch { /* doesn't exist — fine */ }

  // Record session start timestamp for session-summary.js delta tracking
  try {
    fs.writeFileSync(
      path.join(projectRoot, ".ai-memory", ".session-start-ts"),
      String(Date.now()),
      "utf-8"
    );
  } catch { /* non-critical */ }

  // Clear task tracker so task completion detection starts fresh each session
  try {
    fs.writeFileSync(
      path.join(projectRoot, ".ai-memory", ".task-tracker"),
      JSON.stringify({ created: 0, completed: 0, toolCallsSinceSummary: 0 }),
      "utf-8"
    );
  } catch { /* non-critical */ }

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

  // ── 4. CITE MEMORY instruction with mandatory banner ──
  messageParts.push(
    `\n**CITE MEMORY** — The decisions and research findings above are REAL knowledge from previous sessions. When they are relevant to your current task, you MUST:

1. **Display this green banner** (using backtick code block with the ★ format):

\`★ Memory Hit ──────────────────────────────────────\`
\`  ✓ Found relevant research in project memory — skipping further exploration.\`
\`  Matched: "<topic1>", "<topic2>", ...\`
\`  Savings: ~X,000 tokens, ~Y min of investigation avoided\`
\`──────────────────────────────────────────────────────\`

2. **USE the finding content directly** — do NOT re-explore or re-investigate what is already saved.
3. **Estimate savings**: ~1,000 tokens and ~2 min per matched finding used.
4. This banner is **MANDATORY** every time you use saved memory. It proves to the user that memory is working and shows the value.`
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

  // ── 8. MANDATORY end-of-session summary ──
  messageParts.push(
    `\n**MANDATORY: End-of-Session Summary** — Before ending ANY session, you MUST run as your FINAL action:
\`\`\`bash
node "${pluginRoot}/scripts/session-summary.js"
\`\`\`
- If it shows "PENDING SAVES DETECTED", save all pending research/decisions FIRST, then re-run
- Do NOT end the session until the summary shows green (no pending saves)
- This is your FINAL action before responding to the user — NON-NEGOTIABLE`
  );

  // ── 9. Auto-extract reminder (if pending) ──
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
