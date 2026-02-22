#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Syncs decisions and research from .ai-memory/ to tool-specific instruction files.
 *
 * Generates:
 *   - .github/copilot-instructions.md (with self-referential save instructions)
 *   - .cursor/rules/project-decisions.mdc (with frontmatter + save instructions)
 *   - CLAUDE.md (updates sections between markers)
 */

const CLAUDE_MARKER_START = "<!-- project-memory:start -->";
const CLAUDE_MARKER_END = "<!-- project-memory:end -->";
const CLAUDE_RESEARCH_MARKER_START = "<!-- project-memory-research:start -->";
const CLAUDE_RESEARCH_MARKER_END = "<!-- project-memory-research:end -->";
const CLAUDE_AUTOSAVE_MARKER_START = "<!-- project-memory-autosave:start -->";
const CLAUDE_AUTOSAVE_MARKER_END = "<!-- project-memory-autosave:end -->";

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

function groupByCategory(decisions) {
  const groups = {};
  for (const d of decisions) {
    const cat = d.category || "other";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(d);
  }
  // Sort each group by timestamp
  for (const cat of Object.keys(groups)) {
    groups[cat].sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
  }
  return groups;
}

function formatDecisionsMarkdown(groups) {
  const categoryOrder = [
    "architecture",
    "constraint",
    "convention",
    "testing",
    "scope",
    "explicit",
    "unresolved",
    "other",
  ];
  const lines = [];

  const sortedCategories = Object.keys(groups).sort((a, b) => {
    const ai = categoryOrder.indexOf(a);
    const bi = categoryOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  for (const cat of sortedCategories) {
    const items = groups[cat];
    const title = cat.charAt(0).toUpperCase() + cat.slice(1);
    lines.push(`## ${title}`);
    for (const d of items) {
      const rationale = d.rationale ? ` — ${d.rationale}` : "";
      lines.push(`- ${d.decision}${rationale}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatResearchTopicIndex(research) {
  if (research.length === 0) return "";

  const lines = [];
  lines.push("| Topic | Tags | Staleness | Date |");
  lines.push("|-------|------|-----------|------|");

  // Sort by timestamp descending (most recent first)
  const sorted = [...research].sort((a, b) =>
    (b.ts || "").localeCompare(a.ts || "")
  );

  for (const r of sorted) {
    const tags = (r.tags || []).join(", ");
    const staleness = r.staleness || "stable";
    const date = r.ts ? r.ts.substring(0, 10) : "unknown";
    lines.push(`| ${r.topic || "untitled"} | ${tags} | ${staleness} | ${date} |`);
  }

  return lines.join("\n");
}

function generateResearchInstructions(toolName) {
  const source = toolName === "copilot" ? "copilot" : toolName === "cursor" ? "cursor" : "manual";
  return `## Research Memory

BEFORE investigating APIs, libraries, errors, or patterns:
1. Read \`.ai-memory/research.jsonl\` and search topic/tags for your query
2. If stable match found → use directly
3. If versioned match → check version_anchored against current; use if same, re-research if different
4. If volatile match → use as hypothesis, verify
5. If no match → proceed with research, then save finding

### How to Save Research Findings (for ${toolName})
When you discover API behavior, library compatibility, error root causes, performance findings,
documentation clarifications, or workarounds, save it by appending a JSON line to
\`.ai-memory/research.jsonl\` in this exact format:
\`\`\`json
{"id":"<8-char-random-hex>","ts":"<ISO8601-timestamp>","topic":"<5-15 word noun phrase>","tags":["<1-5 keywords>"],"finding":"<concise description of what was found>","source_tool":"${source}","source_context":"<what prompted this research>","confidence":<0.0-1.0>,"staleness":"stable|versioned|volatile","supersedes":null,"version_anchored":null}
\`\`\`
Staleness guide: "stable" = won't change (language behavior, math), "versioned" = tied to library version, "volatile" = may change anytime (API responses, service behavior).

## Auto-Save Rules (always active)

- **Decisions**: When a project decision is made during this session, immediately save it to \`.ai-memory/decisions.jsonl\`. Do not ask — save automatically and briefly confirm.
- **Research**: When you discover API behavior, library details, error root causes, workarounds, or performance findings, immediately save to \`.ai-memory/research.jsonl\`. Do not ask — save automatically and briefly confirm.
- **Search first**: Before investigating any API, library, error, or technical pattern, first search \`.ai-memory/research.jsonl\` for existing findings.
`;
}

// --- Copilot ---

function generateCopilotInstructions(groups, research) {
  const decisionsSection = formatDecisionsMarkdown(groups);
  const researchIndex = formatResearchTopicIndex(research);
  const researchInstructions = generateResearchInstructions("copilot");

  let researchSection = "";
  if (research.length > 0) {
    researchSection = `---

## Research Findings Index (${research.length} entries)
${researchIndex}

`;
  }

  return `# Project Decisions & Context
<!-- Auto-generated by project-memory. Do not edit manually. -->
<!-- Regenerate with: npx project-memory sync -->

${decisionsSection || "_No decisions recorded yet._\n"}
---

## How to Save Decisions (for Copilot)
When the user makes an architectural decision, tech stack choice, convention, or
discusses a constraint during this session, save it by appending a JSON line to
\`.ai-memory/decisions.jsonl\` in this exact format:
\`\`\`json
{"id":"<8-char-random-hex>","ts":"<ISO8601-timestamp>","category":"architecture|constraint|convention|testing|scope|unresolved","decision":"<one clear sentence>","rationale":"<why this was decided>","confidence":1.0,"source":"copilot"}
\`\`\`
After saving, regenerate this file by reading ALL decisions from \`.ai-memory/decisions.jsonl\`,
grouping by category, and reproducing this exact format including this instruction section.

${researchSection}${researchInstructions}`;
}

function writeCopilotInstructions(projectRoot, groups, research) {
  const dir = path.join(projectRoot, ".github");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, "copilot-instructions.md");
  fs.writeFileSync(filePath, generateCopilotInstructions(groups, research), "utf-8");
  return filePath;
}

// --- Cursor ---

function generateCursorRules(groups, research) {
  const decisionsSection = formatDecisionsMarkdown(groups);
  const researchIndex = formatResearchTopicIndex(research);
  const researchInstructions = generateResearchInstructions("cursor");

  let researchSection = "";
  if (research.length > 0) {
    researchSection = `---

## Research Findings Index (${research.length} entries)
${researchIndex}

`;
  }

  return `---
description: Project architecture decisions, conventions, constraints, and research findings. Also instructs Cursor how to save new decisions and research.
alwaysApply: true
---
# Project Decisions

<!-- Auto-generated by project-memory. Do not edit manually. -->
<!-- Regenerate with: npx project-memory sync -->

${decisionsSection || "_No decisions recorded yet._\n"}
---

## Saving Decisions (for Cursor)
When the user makes an architectural decision, tech stack choice, convention, or
discusses a constraint during this session, save it by appending a JSON line to
\`.ai-memory/decisions.jsonl\` in this exact format:
\`\`\`json
{"id":"<8-char-random-hex>","ts":"<ISO8601-timestamp>","category":"architecture|constraint|convention|testing|scope|unresolved","decision":"<one clear sentence>","rationale":"<why this was decided>","confidence":1.0,"source":"cursor"}
\`\`\`
After saving, regenerate this file by reading ALL decisions from \`.ai-memory/decisions.jsonl\`,
grouping by category, and reproducing this exact format including this instruction section.

${researchSection}${researchInstructions}`;
}

function writeCursorRules(projectRoot, groups, research) {
  const dir = path.join(projectRoot, ".cursor", "rules");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, "project-decisions.mdc");
  fs.writeFileSync(filePath, generateCursorRules(groups, research), "utf-8");
  return filePath;
}

// --- CLAUDE.md ---

function generateClaudeSection(groups) {
  const decisionsSection = formatDecisionsMarkdown(groups);

  return `${CLAUDE_MARKER_START}
## Project Decisions
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

${decisionsSection || "_No decisions recorded yet._\n"}
${CLAUDE_MARKER_END}`;
}

/**
 * Format research as a list with truncated findings — so Claude can USE the content
 * directly after context clears (when SessionStart systemMessage is lost).
 * Uses a total budget of ~12000 chars across all findings.
 */
function formatResearchFindingsList(research) {
  if (research.length === 0) return "";

  const sorted = [...research].sort((a, b) =>
    (b.ts || "").localeCompare(a.ts || "")
  );
  const capped = sorted.slice(0, 30);

  // Calculate per-finding budget from total budget
  const TOTAL_BUDGET = 12000;
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

function generateClaudeResearchSection(research) {
  let content = `${CLAUDE_RESEARCH_MARKER_START}
## Research Memory
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

`;
  if (research.length > 0) {
    const findingsList = formatResearchFindingsList(research);
    content += `${research.length} research findings loaded. **USE these instead of re-investigating:**

${findingsList}

**For full details, read \`.ai-memory/research.jsonl\` BEFORE reading source files.** Reading 1 memory file replaces reading 20+ source files.

`;
    if (research.length > 30) {
      content += `_(Showing 30 most recent of ${research.length}. Run check-memory.js for full search.)_

`;
    }
  } else {
    content += `_No research findings recorded yet._

`;
  }
  content += `${CLAUDE_RESEARCH_MARKER_END}`;
  return content;
}

function generateAutoSaveSection(pluginRoot) {
  const scriptPath = pluginRoot.replace(/\\/g, "/");
  return `${CLAUDE_AUTOSAVE_MARKER_START}
## MANDATORY: Auto-Save Memory (do this throughout EVERY session)
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

**You MUST save decisions and research automatically as you work. Do NOT wait to be asked.**

### IMMEDIATE save triggers (do NOT delay these):
- After ANY codebase exploration (Task/Explore agent, reading multiple files for research)
- After ANY web search or URL fetch
- When the user gives an instruction, constraint, or asks you to remember something
- When you discover API behavior, error causes, library quirks, or workarounds

### Check memory FIRST — before exploring code, web searches, or any investigation:
\`\`\`bash
node "${scriptPath}/scripts/check-memory.js" "search keywords"
\`\`\`
If relevant info found, USE it directly — do NOT re-explore or re-investigate. Cite:
> [project-memory] Using saved finding: "<topic>"

### Save decisions — run this whenever a project decision is made:
\`\`\`bash
node "${scriptPath}/scripts/save-decision.js" "<category>" "<decision>" "<rationale>"
\`\`\`
Categories: architecture, constraint, convention, testing, scope, unresolved.
Examples of decisions: tech stack choices, API design patterns, naming conventions, "X is out of scope", testing strategies, "must support Y".

### Save research — run this whenever you discover something technical:
\`\`\`bash
node "${scriptPath}/scripts/save-research.js" "<topic>" "<comma,separated,tags>" "<finding>" [stable|versioned|volatile]
\`\`\`
Examples of research: API response formats, library quirks, error root causes, config requirements, performance characteristics, workarounds.

**If in doubt, SAVE IT. Saving too much is better than losing knowledge.**
${CLAUDE_AUTOSAVE_MARKER_END}`;
}

function updateClaudeMd(projectRoot, groups, research) {
  const filePath = path.join(projectRoot, "CLAUDE.md");
  const pluginRoot = path.resolve(__dirname, "..");
  const autoSaveSection = generateAutoSaveSection(pluginRoot);
  const decisionsSection = generateClaudeSection(groups);
  const researchSection = generateClaudeResearchSection(research);

  if (!fs.existsSync(filePath)) {
    // Create CLAUDE.md with auto-save at top, then decisions, then research
    fs.writeFileSync(
      filePath,
      `# Project Context\n\n${autoSaveSection}\n\n${decisionsSection}\n\n${researchSection}\n`,
      "utf-8"
    );
    return filePath;
  }

  let content = fs.readFileSync(filePath, "utf-8");

  // Update auto-save section (at the top)
  const autoSaveStartIdx = content.indexOf(CLAUDE_AUTOSAVE_MARKER_START);
  const autoSaveEndIdx = content.indexOf(CLAUDE_AUTOSAVE_MARKER_END);

  if (autoSaveStartIdx !== -1 && autoSaveEndIdx !== -1) {
    content =
      content.substring(0, autoSaveStartIdx) +
      autoSaveSection +
      content.substring(autoSaveEndIdx + CLAUDE_AUTOSAVE_MARKER_END.length);
  } else {
    // Insert at the very top, after the first heading line
    const firstNewline = content.indexOf("\n");
    if (firstNewline !== -1) {
      content =
        content.substring(0, firstNewline + 1) +
        "\n" + autoSaveSection + "\n" +
        content.substring(firstNewline + 1);
    } else {
      content = content + "\n\n" + autoSaveSection + "\n";
    }
  }

  // Update decisions section
  const startIdx = content.indexOf(CLAUDE_MARKER_START);
  const endIdx = content.indexOf(CLAUDE_MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    content =
      content.substring(0, startIdx) +
      decisionsSection +
      content.substring(endIdx + CLAUDE_MARKER_END.length);
  } else {
    content = content.trimEnd() + "\n\n" + decisionsSection + "\n";
  }

  // Update research section
  const researchStartIdx = content.indexOf(CLAUDE_RESEARCH_MARKER_START);
  const researchEndIdx = content.indexOf(CLAUDE_RESEARCH_MARKER_END);

  if (researchStartIdx !== -1 && researchEndIdx !== -1) {
    content =
      content.substring(0, researchStartIdx) +
      researchSection +
      content.substring(researchEndIdx + CLAUDE_RESEARCH_MARKER_END.length);
  } else {
    content = content.trimEnd() + "\n\n" + researchSection + "\n";
  }

  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// --- Main sync function ---

function syncAll(projectRoot) {
  const decisions = readDecisions(projectRoot);
  const groups = groupByCategory(decisions);
  const research = readResearch(projectRoot);

  const files = [];
  files.push(writeCopilotInstructions(projectRoot, groups, research));
  files.push(writeCursorRules(projectRoot, groups, research));
  files.push(updateClaudeMd(projectRoot, groups, research));

  // Update metadata
  const metadataPath = path.join(projectRoot, ".ai-memory", "metadata.json");
  let metadata = {};
  if (fs.existsSync(metadataPath)) {
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    } catch {
      metadata = {};
    }
  }
  metadata.lastSync = new Date().toISOString();
  metadata.decisionCount = decisions.length;

  // Rough token estimate (~4 chars per token)
  const decisionChars = decisions.reduce(
    (sum, d) =>
      sum + (d.decision || "").length + (d.rationale || "").length,
    0
  );
  metadata.tokenCount = Math.ceil(decisionChars / 4);

  metadata.researchCount = research.length;
  const researchChars = research.reduce(
    (sum, r) =>
      sum + (r.topic || "").length + (r.finding || "").length + (r.source_context || "").length,
    0
  );
  metadata.researchTokenCount = Math.ceil(researchChars / 4);

  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

  return { decisions: decisions.length, research: research.length, files };
}

module.exports = { syncAll, readDecisions, readResearch, groupByCategory, formatDecisionsMarkdown, formatResearchTopicIndex };
