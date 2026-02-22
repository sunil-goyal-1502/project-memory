#!/usr/bin/env node
"use strict";

/**
 * Standalone CLI for project-memory.
 *
 * Usage:
 *   npx project-memory init                          # Initialize .ai-memory/ in current project
 *   npx project-memory save "text"                   # Save an explicit decision
 *   npx project-memory show                          # Show current decisions
 *   npx project-memory sync                          # Regenerate all tool-specific files
 *   npx project-memory research-save "<finding>"     # Save a research finding
 *   npx project-memory research-show [filter]        # Show research findings
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");
const { recordEvent, getStats, formatStatsLine, formatNumber, formatDuration, formatCost, TOKENS_SAVED, TIME_SAVED_SEC } = require(path.join(SCRIPTS_DIR, "stats.js"));

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

function generateId() {
  return crypto.randomBytes(4).toString("hex");
}

// --- Commands ---

function cmdInit() {
  const cwd = process.cwd();
  const aiMemoryDir = path.join(cwd, ".ai-memory");

  if (fs.existsSync(aiMemoryDir)) {
    console.log(".ai-memory/ already exists. Skipping initialization.");
    console.log("Run 'project-memory sync' to regenerate tool files.");
    return;
  }

  fs.mkdirSync(aiMemoryDir, { recursive: true });

  // decisions.jsonl (empty)
  fs.writeFileSync(path.join(aiMemoryDir, "decisions.jsonl"), "", "utf-8");

  // research.jsonl (empty)
  fs.writeFileSync(path.join(aiMemoryDir, "research.jsonl"), "", "utf-8");

  // metadata.json
  fs.writeFileSync(
    path.join(aiMemoryDir, "metadata.json"),
    JSON.stringify(
      {
        tokenCount: 0,
        lastSync: null,
        sessionCount: 0,
        decisionCount: 0,
        researchCount: 0,
        researchTokenCount: 0,
        stats: {
          totalTokensSaved: 0,
          totalTimeSavedSeconds: 0,
          totalHits: 0,
          eventCounts: {
            session_load_decision: 0,
            session_load_research: 0,
            research_search_hit: 0,
          },
        },
      },
      null,
      2
    ),
    "utf-8"
  );

  // .gitignore
  fs.writeFileSync(
    path.join(aiMemoryDir, ".gitignore"),
    "# Transcript data is ephemeral and potentially sensitive\n.last-session.txt\n",
    "utf-8"
  );

  console.log("Initialized .ai-memory/ in", cwd);

  // Run sync to generate tool files
  const { syncAll } = require(path.join(SCRIPTS_DIR, "sync-tools.js"));
  const result = syncAll(cwd);
  console.log(`Generated ${result.files.length} tool-specific files:`);
  for (const f of result.files) {
    console.log(`  - ${path.relative(cwd, f)}`);
  }

  console.log("\nNext steps:");
  console.log('  - Run: project-memory save "Your first decision"');
  console.log("  - Add .ai-memory/ to git to share decisions with your team");
}

function cmdSave(args) {
  const decisionText = args.join(" ").trim();
  if (!decisionText) {
    console.error("Usage: project-memory save \"<decision text>\"");
    process.exit(1);
  }

  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error(
      "No .ai-memory/ found. Run 'project-memory init' first."
    );
    process.exit(1);
  }

  const entry = {
    id: generateId(),
    ts: new Date().toISOString(),
    category: "explicit",
    decision: decisionText,
    rationale: "Explicitly saved by user",
    confidence: 1.0,
    source: "manual",
  };

  const filePath = path.join(projectRoot, ".ai-memory", "decisions.jsonl");
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");

  console.log(`Saved: "${decisionText}"`);

  // Run sync
  const { syncAll } = require(path.join(SCRIPTS_DIR, "sync-tools.js"));
  const result = syncAll(projectRoot);
  console.log(
    `Synced ${result.decisions} decision(s) and ${result.research} research finding(s) to ${result.files.length} tool files.`
  );

  // Show projected savings
  console.log(`This decision will save ~150 tokens and ~15 seconds each time it's loaded in a future session.`);
  const stats = getStats(projectRoot);
  const line = formatStatsLine(0, 0, stats);
  if (line) console.log(line);
}

function cmdShow() {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error(
      "No .ai-memory/ found. Run 'project-memory init' first."
    );
    process.exit(1);
  }

  const { readDecisions, groupByCategory } = require(
    path.join(SCRIPTS_DIR, "sync-tools.js")
  );
  const decisions = readDecisions(projectRoot);

  if (decisions.length === 0) {
    console.log("No decisions recorded yet.");
    console.log('Use: project-memory save "Your decision"');
    return;
  }

  const groups = groupByCategory(decisions);
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

  const sortedCategories = Object.keys(groups).sort((a, b) => {
    const ai = categoryOrder.indexOf(a);
    const bi = categoryOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  for (const cat of sortedCategories) {
    const items = groups[cat];
    const title = cat.charAt(0).toUpperCase() + cat.slice(1);
    console.log(`\n${title} (${items.length}):`);
    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      const date = d.ts ? d.ts.substring(0, 10) : "unknown";
      const rationale = d.rationale ? ` -- ${d.rationale}` : "";
      console.log(`  ${i + 1}. ${d.decision}${rationale} [${d.source}, ${date}]`);
    }
  }

  // Summary
  console.log(`\nTotal: ${decisions.length} decision(s)`);

  const metadataPath = path.join(projectRoot, ".ai-memory", "metadata.json");
  if (fs.existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      if (metadata.lastSync) {
        console.log(`Last sync: ${metadata.lastSync}`);
      }
      if (metadata.tokenCount) {
        console.log(`Estimated tokens: ${metadata.tokenCount}`);
      }
    } catch {
      // ignore
    }
  }

  // Show cumulative savings
  const stats = getStats(projectRoot);
  const line = formatStatsLine(0, 0, stats);
  if (line) console.log(line);
}

function cmdSync() {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error(
      "No .ai-memory/ found. Run 'project-memory init' first."
    );
    process.exit(1);
  }

  const { syncAll } = require(path.join(SCRIPTS_DIR, "sync-tools.js"));
  const result = syncAll(projectRoot);

  console.log(`Synced ${result.decisions} decision(s) and ${result.research} research finding(s) to tool files:`);
  for (const f of result.files) {
    console.log(`  - ${path.relative(projectRoot, f)}`);
  }

  // Show cumulative savings
  const stats = getStats(projectRoot);
  const line = formatStatsLine(0, 0, stats);
  if (line) console.log(line);
}

function cmdResearchSave(args) {
  // Parse --topic, --tags, --staleness flags
  let finding = "";
  let topic = "";
  let tags = [];
  let staleness = "stable";

  const remaining = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--topic" && i + 1 < args.length) {
      topic = args[++i];
    } else if (args[i] === "--tags" && i + 1 < args.length) {
      tags = args[++i].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    } else if (args[i] === "--staleness" && i + 1 < args.length) {
      const val = args[++i];
      if (["stable", "versioned", "volatile"].includes(val)) {
        staleness = val;
      }
    } else {
      remaining.push(args[i]);
    }
  }

  finding = remaining.join(" ").trim();
  if (!finding) {
    console.error(
      'Usage: project-memory research-save "<finding>" --topic "..." --tags "tag1,tag2" --staleness stable|versioned|volatile'
    );
    process.exit(1);
  }

  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error(
      "No .ai-memory/ found. Run 'project-memory init' first."
    );
    process.exit(1);
  }

  // Auto-generate topic if not provided
  if (!topic) {
    // Use first 15 words of finding as topic
    topic = finding.split(/\s+/).slice(0, 15).join(" ");
  }

  // Auto-generate tags if not provided
  if (tags.length === 0) {
    // Extract keywords: lowercase words > 3 chars, skip common words
    const stopWords = new Set([
      "the", "that", "this", "with", "from", "have", "been", "when",
      "will", "they", "them", "then", "than", "also", "into", "only",
      "does", "should", "would", "could", "about", "each", "which",
      "their", "there", "were", "what", "some", "other", "more",
    ]);
    const words = finding
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));
    // Take up to 5 unique keywords
    tags = [...new Set(words)].slice(0, 5);
  }

  const entry = {
    id: generateId(),
    ts: new Date().toISOString(),
    topic,
    tags,
    finding,
    source_tool: "manual",
    source_context: "Saved via CLI",
    confidence: 0.9,
    staleness,
    supersedes: null,
    version_anchored: null,
  };

  const filePath = path.join(projectRoot, ".ai-memory", "research.jsonl");
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");

  console.log(`Saved research finding:`);
  console.log(`  Topic: ${topic}`);
  console.log(`  Tags: ${tags.join(", ")}`);
  console.log(`  Staleness: ${staleness}`);
  console.log(`  Finding: ${finding}`);

  // Run sync
  const { syncAll } = require(path.join(SCRIPTS_DIR, "sync-tools.js"));
  const result = syncAll(projectRoot);
  console.log(
    `\nSynced ${result.decisions} decision(s) and ${result.research} research finding(s) to ${result.files.length} tool files.`
  );

  // Show projected savings
  console.log(`This finding will save ~300 tokens and ~45 sec each time it's loaded, plus ~1,000 tokens (~2 min) per search hit.`);
  const stats = getStats(projectRoot);
  const line = formatStatsLine(0, 0, stats);
  if (line) console.log(line);
}

function cmdResearchShow(args) {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error(
      "No .ai-memory/ found. Run 'project-memory init' first."
    );
    process.exit(1);
  }

  const { readResearch } = require(path.join(SCRIPTS_DIR, "sync-tools.js"));
  const research = readResearch(projectRoot);

  if (research.length === 0) {
    console.log("No research findings recorded yet.");
    console.log('Use: project-memory research-save "<finding>"');
    return;
  }

  const filter = args.join(" ").trim().toLowerCase();

  let filtered = research;
  if (filter) {
    filtered = research.filter((r) => {
      const tagMatch = (r.tags || []).some((t) => t.toLowerCase().includes(filter));
      const topicMatch = (r.topic || "").toLowerCase().includes(filter);
      const findingMatch = (r.finding || "").toLowerCase().includes(filter);
      return tagMatch || topicMatch || findingMatch;
    });
  }

  if (filtered.length === 0) {
    console.log(`No research findings matching "${filter}".`);
    return;
  }

  // Group by primary tag
  const groups = {};
  for (const r of filtered) {
    const primaryTag = (r.tags && r.tags[0]) || "untagged";
    if (!groups[primaryTag]) groups[primaryTag] = [];
    groups[primaryTag].push(r);
  }

  for (const [tag, items] of Object.entries(groups)) {
    console.log(`\n${tag} (${items.length}):`);
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      const date = r.ts ? r.ts.substring(0, 10) : "unknown";
      const finding =
        r.finding && r.finding.length > 80
          ? r.finding.substring(0, 80) + "..."
          : r.finding || "";
      console.log(
        `  ${i + 1}. [${r.staleness || "stable"}] ${r.topic || "untitled"}`
      );
      console.log(`     ${finding}`);
      console.log(
        `     confidence: ${r.confidence || "?"}, date: ${date}, source: ${r.source_tool || "?"}`
      );
    }
  }

  // Summary
  const stalenessCount = { stable: 0, versioned: 0, volatile: 0 };
  for (const r of filtered) {
    const s = r.staleness || "stable";
    if (stalenessCount[s] !== undefined) stalenessCount[s]++;
  }

  console.log(
    `\nTotal: ${filtered.length} finding(s)${filter ? ` (filtered from ${research.length})` : ""}`
  );
  console.log(
    `Staleness: ${stalenessCount.stable} stable, ${stalenessCount.versioned} versioned, ${stalenessCount.volatile} volatile`
  );

  const totalChars = filtered.reduce(
    (sum, r) =>
      sum +
      (r.topic || "").length +
      (r.finding || "").length +
      (r.source_context || "").length,
    0
  );
  console.log(`Estimated tokens: ${Math.ceil(totalChars / 4)}`);

  // Show cumulative savings
  const stats = getStats(projectRoot);
  const line = formatStatsLine(0, 0, stats);
  if (line) console.log(line);
}

function showHelp() {
  console.log(`project-memory - Cross-tool project decision and research tracking

Commands:
  init                        Initialize .ai-memory/ in current project
  save "text"                 Save an explicit decision
  show                        Show all recorded decisions
  sync                        Regenerate tool-specific instruction files
  research-save "<finding>"   Save a research finding
                              Options: --topic "..." --tags "t1,t2" --staleness stable|versioned|volatile
  research-show [filter]      Show research findings, optional keyword filter

Examples:
  project-memory init
  project-memory save "Using PostgreSQL for the data layer"
  project-memory show
  project-memory sync
  project-memory research-save "Axios interceptors run LIFO for responses" --tags "axios,http" --staleness stable
  project-memory research-show axios
`);
}

// --- Main ---

const [, , command, ...args] = process.argv;

switch (command) {
  case "init":
    cmdInit();
    break;
  case "save":
    cmdSave(args);
    break;
  case "show":
    cmdShow();
    break;
  case "sync":
    cmdSync();
    break;
  case "research-save":
    cmdResearchSave(args);
    break;
  case "research-show":
    cmdResearchShow(args);
    break;
  case "help":
  case "--help":
  case "-h":
    showHelp();
    break;
  default:
    if (command) {
      console.error(`Unknown command: ${command}`);
    }
    showHelp();
    process.exit(command ? 1 : 0);
}
