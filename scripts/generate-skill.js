#!/usr/bin/env node
"use strict";

/**
 * Generate a Claude Code skill (SKILL.md) from a workflow candidate.
 *
 * Usage:
 *   node generate-skill.js <workflow-id>       — generate skill from candidate
 *   node generate-skill.js --list              — list pending candidates
 */

const fs = require("fs");
const path = require("path");
const shared = require(path.join(__dirname, "shared.js"));

const G = "\x1b[92m";
const Y = "\x1b[93m";
const C = "\x1b[96m";
const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";

const projectRoot = shared.findProjectRoot(process.cwd()) || shared.scanHomeForProjects();
if (!projectRoot) {
  console.error("No .ai-memory/ found");
  process.exit(1);
}

const arg = process.argv[2];

if (arg === "--list") {
  listCandidates();
} else if (arg) {
  generateSkill(arg);
} else {
  console.log("Usage:");
  console.log("  node generate-skill.js <workflow-id>  — generate skill");
  console.log("  node generate-skill.js --list         — list candidates");
  process.exit(0);
}

function listCandidates() {
  const candidates = shared.readWorkflowCandidates(projectRoot);
  if (candidates.length === 0) {
    console.log(`${Y}No workflow candidates detected yet.${R}`);
    console.log(`${D}Candidates are created automatically when you repeat multi-step command patterns.${R}`);
    return;
  }

  console.log(`${C}${B}★ Workflow Candidates ──────────────────────────${R}\n`);
  for (const c of candidates) {
    const stepNames = (c.steps || []).map(s => s.name).join(" → ");
    const statusIcon = c.status === "created" ? "✓" : c.status === "suggested" ? "★" : "○";
    const occCount = (c.occurrences || []).length;
    console.log(`${G}  ${statusIcon} [${c.id}] ${c.name}${R} (${occCount}x, ${c.status})`);
    console.log(`${D}    Steps: ${stepNames}${R}`);
    if (c.sharedParams && c.sharedParams.length > 0) {
      console.log(`${Y}    Params: ${c.sharedParams.map(p => `{{${p.name}}}`).join(", ")}${R}`);
    }
    if (c.skillPath) {
      console.log(`${G}    Skill: ${c.skillPath}${R}`);
    }
    console.log("");
  }
}

function generateSkill(workflowId) {
  const candidates = shared.readWorkflowCandidates(projectRoot);
  const candidate = candidates.find(c => c.id === workflowId);

  if (!candidate) {
    console.error(`Workflow candidate not found: ${workflowId}`);
    console.error("Run with --list to see available candidates.");
    process.exit(1);
  }

  if (candidate.status === "created" && candidate.skillPath) {
    console.log(`${Y}Skill already exists at: ${candidate.skillPath}${R}`);
    console.log(`${D}Delete the existing skill directory to regenerate.${R}`);
    return;
  }

  // Generate skill name (kebab-case from workflow name)
  const skillName = (candidate.name || "unnamed-workflow")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  // Build SKILL.md content
  const steps = candidate.steps || [];
  const sharedParams = candidate.sharedParams || [];

  let md = "";
  md += "---\n";
  md += `name: ${skillName}\n`;
  md += `description: ${candidate.name || "Auto-generated workflow skill"}\n`;
  md += "user-invocable: true\n";
  md += "allowed-tools: Bash, Read, Grep, Glob\n";
  md += "---\n\n";

  md += `# ${candidate.name}\n\n`;
  md += `Auto-generated skill from ${(candidate.occurrences || []).length}x repeated workflow pattern.\n\n`;

  // Parameters section
  if (sharedParams.length > 0) {
    md += "## Parameters\n\n";
    md += "Replace these placeholders before running:\n\n";
    for (const p of sharedParams) {
      md += `- \`{{${p.name}}}\` — ${p.description || p.name}`;
      if (p.default) md += ` (default: \`${p.default}\`)`;
      md += "\n";
    }
    md += "\n";
    md += "If `$ARGUMENTS` is provided, extract parameter values from it (e.g., \"analyze build 46129929\" → `{{build_id}}` = 46129929).\n\n";
  }

  // Steps
  for (const step of steps) {
    md += `## Step ${step.order}: ${step.name}\n\n`;
    if (step.params && step.params.length > 0) {
      const stepParams = step.params.filter(p => sharedParams.some(sp => sp.name === p.name));
      if (stepParams.length > 0) {
        md += `Uses: ${stepParams.map(p => `\`{{${p.name}}}\``).join(", ")}\n\n`;
      }
    }
    md += "Run this command:\n";
    md += "```bash\n";
    md += step.template || step.command || "# (no template captured)";
    md += "\n```\n\n";
  }

  // Error handling
  md += "## Error Handling\n\n";
  md += "- If `az account get-access-token` fails: Run `az login` first to authenticate\n";
  md += "- If curl returns 401/403: Token may be expired, re-run the failing step\n";
  md += "- If Python script fails: Check file paths exist from previous steps\n";
  md += "- If a step fails, do NOT skip it — fix and retry before proceeding\n\n";

  md += `## Notes\n\n`;
  md += `- Generated: ${new Date().toISOString().slice(0, 10)}\n`;
  md += `- Source: workflow-candidates.jsonl (${candidate.id})\n`;
  md += `- Each step is a complete, tested command — run as-is after parameter substitution\n`;

  // Write SKILL.md
  const skillDir = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "skills", skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, md, "utf-8");

  // Update candidate status
  shared.updateWorkflowCandidate(projectRoot, candidate.id, {
    status: "created",
    skillPath: skillPath.replace(/\\/g, "/"),
  });

  console.log(`${G}${B}✓ Skill created: /${skillName}${R}`);
  console.log(`${G}  Path: ${skillPath}${R}`);
  console.log(`${D}  Steps: ${steps.length}${R}`);
  console.log(`${D}  Parameters: ${sharedParams.map(p => `{{${p.name}}}`).join(", ") || "none"}${R}`);
  console.log("");
  console.log(`${Y}  Invoke with: /${skillName}${R}`);
  if (sharedParams.length > 0) {
    console.log(`${Y}  Example: /${skillName} ${sharedParams[0].default || sharedParams[0].name}${R}`);
  }
}
