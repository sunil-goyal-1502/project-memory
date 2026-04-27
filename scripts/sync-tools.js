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
const CLAUDE_SCRIPTS_MARKER_START = "<!-- project-memory-scripts:start -->";
const CLAUDE_SCRIPTS_MARKER_END = "<!-- project-memory-scripts:end -->";

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

  // MCP tools section — Copilot CLI supports MCP via .mcp.json
  const mcpSection = `## Project Memory (MCP Tools)

This project has a memory system powered by MCP tools. If MCP is available,
**prefer these tools** over manual file reads for all memory operations:

| When you want to... | Use this MCP tool |
|---------------------|-------------------|
| Start any task | \`project-memory__get_context\` (call FIRST) |
| Find prior research/decisions | \`project-memory__memory_search\` |
| Find a reusable script | \`project-memory__script_search\` |
| Understand code structure | \`project-memory__code_search\` then \`code_context\` |
| Check impact of a change | \`project-memory__code_impact\` |
| Save a discovery | \`project-memory__memory_save\` |
| Run corpus maintenance | \`project-memory__run_maintenance\` |
| Get full corpus snapshot | \`project-memory__get_corpus_snapshot\` |
| End session | \`project-memory__session_summary\` |

If MCP tools are not available, fall back to the file-based instructions below.

---

`;

  return `# Project Decisions & Context
<!-- Auto-generated by project-memory. Do not edit manually. -->
<!-- Regenerate with: npx project-memory sync -->

${mcpSection}${decisionsSection || "_No decisions recorded yet._\n"}
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

const STALENESS_DAYS = 7; // Research older than this is considered stale
const MAX_RESEARCH_CHARS = 12000; // ~3K tokens budget for research in CLAUDE.md

/**
 * Format research as a list with full findings, filtered by staleness.
 * Caps output at MAX_RESEARCH_CHARS to prevent CLAUDE.md from exceeding token limits.
 * Returns { text, freshCount, staleCount, truncatedCount }.
 */
function formatResearchFindingsList(research) {
  if (research.length === 0) return { text: "", freshCount: 0, staleCount: 0, truncatedCount: 0 };

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

  fresh.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));

  const lines = [];
  let totalChars = 0;
  let truncatedCount = 0;
  for (const r of fresh) {
    const staleness = r.staleness || "stable";
    const badge = staleness === "stable" ? "" : ` [${staleness}]`;
    const line = `- **${r.topic || "untitled"}**${badge}: ${r.finding || ""}`;
    if (totalChars + line.length > MAX_RESEARCH_CHARS) {
      truncatedCount = fresh.length - lines.length;
      break;
    }
    lines.push(line);
    totalChars += line.length + 1; // +1 for newline
  }

  return { text: lines.join("\n"), freshCount: fresh.length, staleCount: stale.length, truncatedCount };
}

function generateClaudeResearchSection(research) {
  let content = `${CLAUDE_RESEARCH_MARKER_START}
## Research Memory
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

`;
  if (research.length > 0) {
    const { text: findingsList, freshCount, staleCount, truncatedCount } = formatResearchFindingsList(research);
    const shownCount = freshCount - truncatedCount;

    if (shownCount > 0) {
      content += `${shownCount} of ${freshCount} recent findings shown. **USE these — do NOT re-investigate:**

${findingsList}

`;
    }

    if (truncatedCount > 0) {
      content += `_(${truncatedCount} more recent findings omitted for size. Run \`check-memory.js\` to search all.)_

`;
    }

    if (staleCount > 0) {
      content += `_(${staleCount} older findings filtered — older than ${STALENESS_DAYS} days. Run check-memory.js to search all including stale.)_

`;
    }

    if (shownCount === 0 && staleCount > 0) {
      content += `_All ${staleCount} findings are older than ${STALENESS_DAYS} days. Run check-memory.js to search them._

`;
    }
  } else {
    content += `_No research findings recorded yet._

`;
  }
  content += `${CLAUDE_RESEARCH_MARKER_END}`;
  return content;
}

function readScripts(projectRoot) {
  const filePath = path.join(projectRoot, ".ai-memory", "scripts.jsonl");
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  const scripts = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { scripts.push(JSON.parse(trimmed)); } catch {}
  }
  return scripts;
}

function generateClaudeScriptsSection(scripts) {
  // Import grouping from shared.js
  const sharedMod = require(path.join(__dirname, "shared.js"));

  let content = `${CLAUDE_SCRIPTS_MARKER_START}
## Script Library
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

`;
  if (scripts.length === 0) {
    content += `_No reusable scripts captured yet._

`;
  } else {
    const groups = sharedMod.groupScriptsByTemplate(scripts);
    const topGroups = groups.slice(0, 10);

    content += `${topGroups.length} script templates (${scripts.length} total scripts). **Reuse these — fill in {{params}} instead of rebuilding commands:**

`;
    for (const group of topGroups) {
      const representative = group.scripts[0]; // best example
      const variantCount = group.scripts.length;
      const paramNames = (representative.parameters || []).map(p => `\`{{${p.name}}}\``).join(", ");
      const truncTemplate = representative.template;

      if (variantCount === 1) {
        content += `- **${representative.name}** (${representative.usage_count || 1}x): \`${truncTemplate}\`\n`;
      } else {
        // Show as grouped template with variant names
        const variantNames = group.scripts.slice(0, 3).map(s => s.name).join(", ");
        const moreCount = variantCount > 3 ? ` +${variantCount - 3} more` : "";
        content += `- **${representative.name}** (${variantCount} variants, ${group.totalUsage}x total): \`${truncTemplate}\`\n`;
        content += `  Variants: ${variantNames}${moreCount}\n`;
      }
      if (paramNames) {
        content += `  Params: ${paramNames}\n`;
      }
    }
    content += "\n";
  }

  content += `${CLAUDE_SCRIPTS_MARKER_END}`;
  return content;
}

function generateAutoSaveSection(pluginRoot) {
  const scriptPath = pluginRoot.replace(/\\/g, "/");
  return `${CLAUDE_AUTOSAVE_MARKER_START}
## Project Memory (MCP Tools)
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

**ALWAYS use these MCP tools instead of manual file exploration:**

| When you want to... | Use this tool |
|---------------------|---------------|
| Start any task | \`mcp__project-memory__get_context\` (call FIRST) |
| Find prior research/decisions | \`mcp__project-memory__memory_search\` |
| Find a reusable script | \`mcp__project-memory__script_search\` |
| Understand code structure | \`mcp__project-memory__code_search\` then \`code_context\` |
| Check impact of a change | \`mcp__project-memory__code_impact\` |
| Save a discovery | \`mcp__project-memory__memory_save\` |
| End session | \`mcp__project-memory__session_summary\` |

**IMPORTANT**: Call \`code_search\` or \`code_context\` BEFORE using Read/Grep/Glob.
The code graph has structural knowledge that eliminates redundant file reads.

### CLI fallbacks (if MCP unavailable):
\`\`\`bash
node "${scriptPath}/scripts/check-memory.js" "search keywords"
node "${scriptPath}/scripts/save-research.js" "<topic>" "<tags>" "<finding>"
node "${scriptPath}/scripts/save-decision.js" "<category>" "<decision>" "<rationale>"
node "${scriptPath}/scripts/session-summary.js"
\`\`\`

### Auto-save rules:
- **Decisions**: Save automatically via \`mcp__project-memory__memory_save\` (type=decision)
- **Research**: Save automatically via \`mcp__project-memory__memory_save\` (type=research)
- **Session end**: ALWAYS call \`mcp__project-memory__session_summary\` before final response
${CLAUDE_AUTOSAVE_MARKER_END}`;
}

function updateClaudeMd(projectRoot, groups, research) {
  const filePath = path.join(projectRoot, "CLAUDE.md");
  const pluginRoot = path.resolve(__dirname, "..");
  const autoSaveSection = generateAutoSaveSection(pluginRoot);
  const decisionsSection = generateClaudeSection(groups);
  const researchSection = generateClaudeResearchSection(research);
  const scripts = readScripts(projectRoot);
  const scriptsSection = generateClaudeScriptsSection(scripts);

  if (!fs.existsSync(filePath)) {
    // Create CLAUDE.md with auto-save at top, then decisions, then research, then scripts
    fs.writeFileSync(
      filePath,
      `# Project Context\n\n${autoSaveSection}\n\n${decisionsSection}\n\n${researchSection}\n\n${scriptsSection}\n`,
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

  // Update scripts section
  const scriptsStartIdx = content.indexOf(CLAUDE_SCRIPTS_MARKER_START);
  const scriptsEndIdx = content.indexOf(CLAUDE_SCRIPTS_MARKER_END);

  if (scriptsStartIdx !== -1 && scriptsEndIdx !== -1) {
    content =
      content.substring(0, scriptsStartIdx) +
      scriptsSection +
      content.substring(scriptsEndIdx + CLAUDE_SCRIPTS_MARKER_END.length);
  } else if (scripts.length > 0) {
    // Insert after research section
    const afterResearch = content.indexOf(CLAUDE_RESEARCH_MARKER_END);
    if (afterResearch !== -1) {
      const insertPoint = afterResearch + CLAUDE_RESEARCH_MARKER_END.length;
      content = content.substring(0, insertPoint) + "\n\n" + scriptsSection + content.substring(insertPoint);
    } else {
      content = content.trimEnd() + "\n\n" + scriptsSection + "\n";
    }
  }

  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// --- AGENTS.md (read by GitHub Copilot CLI alongside CLAUDE.md) ---

function generateAgentsMd() {
  return `# Project Memory Agent Instructions

<!-- Auto-generated by project-memory. Do not edit manually. -->
<!-- Regenerate with: npx project-memory sync -->

## Overview

This project uses **project-memory** — a persistent knowledge management system
that stores research findings, architectural decisions, script templates, and a
knowledge graph. It works across sessions and across tools (Claude Code, GitHub
Copilot CLI, Cursor).

## MCP Tools Available

This project registers an MCP server (\`.mcp.json\`) with 13 tools. Use them
instead of reading \`.ai-memory/\` files directly:

| Tool | Purpose |
|------|---------|
| \`get_context\` | Start of every task — shows memory stats and suggestions |
| \`memory_search\` | Hybrid BM25 + embedding search over research and decisions |
| \`memory_save\` | Save a research finding or project decision |
| \`script_search\` | Find reusable parameterized script templates |
| \`graph_context\` | Explore knowledge graph relationships from an entity |
| \`code_search\` | FTS5 search over code identifiers (functions, classes) |
| \`code_context\` | Full context for a code entity (callers, callees, tests) |
| \`code_impact\` | Blast radius analysis — what breaks if this entity changes |
| \`code_structure\` | Module or class hierarchy overview |
| \`list_skills\` | Show detected workflow patterns and generated skills |
| \`run_maintenance\` | Detect stale entries, merge duplicates, prune graph, refresh embeddings |
| \`get_corpus_snapshot\` | Complete structured markdown of entire memory corpus |
| \`session_summary\` | End-of-session stats and pending saves |

## Workflow

1. **Start**: Call \`get_context\` first to see memory state
2. **Before researching**: Call \`memory_search\` to check existing findings
3. **After discovering**: Call \`memory_save\` to persist findings
4. **End of session**: Call \`session_summary\` to see what was saved

## Auto-Save Rules

- **Decisions**: When the user makes an architectural decision, immediately save
  it using \`memory_save\` (type=decision). Do not ask — save and confirm.
- **Research**: When you discover API behavior, error root causes, workarounds,
  or library details, immediately save using \`memory_save\` (type=research).
- **Search first**: Before investigating any API, library, error, or pattern,
  first call \`memory_search\` for existing findings.
`;
}

function writeAgentsMd(projectRoot) {
  const filePath = path.join(projectRoot, "AGENTS.md");
  fs.writeFileSync(filePath, generateAgentsMd(), "utf-8");
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
  files.push(writeAgentsMd(projectRoot));

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

  const scripts = readScripts(projectRoot);
  metadata.scriptCount = scripts.length;

  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

  return { decisions: decisions.length, research: research.length, scripts: scripts.length, files };
}

module.exports = { syncAll, readDecisions, readResearch, groupByCategory, formatDecisionsMarkdown, formatResearchTopicIndex };
