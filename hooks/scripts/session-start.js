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

// ── Self-healing: ensure plugin cache junction exists ──
// CLAUDE_PLUGIN_ROOT resolves to cache path which gets wiped on updates.
// This repairs the junction at startup so plugin-framework hooks also work.
// Marketplace + plugin name are read from .claude-plugin metadata so this
// works after a fork/rename without code changes.
function readPluginMeta(repoRoot) {
  try {
    const mp = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    const pl = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "plugin.json"), "utf8"));
    return { marketplaceName: mp && mp.name, pluginName: pl && pl.name, version: (pl && pl.version) || "1.0.0" };
  } catch { return null; }
}
function ensureCacheJunction() {
  try {
    if (process.platform !== "win32") return; // junction is Windows-only
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return;
    const sourceRepo = path.resolve(__dirname, "..", "..");
    const meta = readPluginMeta(sourceRepo);
    if (!meta || !meta.marketplaceName || !meta.pluginName) return;
    // Defense-in-depth: validate metadata against a strict allowlist before
    // using it in a shell-style mklink call. Rejects anything that could
    // smuggle path traversal or cmd metacharacters.
    const SAFE = /^[A-Za-z0-9._-]+$/;
    if (!SAFE.test(meta.marketplaceName) || !SAFE.test(meta.pluginName) || !SAFE.test(meta.version)) {
      return;
    }
    const cacheLink = path.join(home, ".claude", "plugins", "cache", meta.marketplaceName, meta.pluginName, meta.version);
    // Quick check: does the junction already resolve?
    if (fs.existsSync(path.join(cacheLink, "hooks", "hooks.json"))) return;
    // Create parent dirs + junction
    fs.mkdirSync(path.dirname(cacheLink), { recursive: true });
    // Use spawnSync with discrete argv (no shell concat) — even though we've
    // validated the inputs above, this removes the entire injection class.
    require("child_process").spawnSync(
      "cmd.exe",
      ["/c", "mklink", "/J", cacheLink, sourceRepo],
      { windowsHide: true, stdio: "ignore" }
    );
  } catch { /* best-effort, non-critical */ }
}
ensureCacheJunction();

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

  // ── Initialize session state (replaces 6 separate dot-files) ──
  const shared = require(path.resolve(__dirname, "..", "..", "scripts", "shared.js"));
  const freshState = shared.getDefaultSessionState();
  freshState.sessionId = sessionId || "unknown";
  freshState.startTs = Date.now();
  shared.writeSessionState(projectRoot, freshState);

  // Also clear legacy dot-files (backward compat — remove after a few sessions)
  for (const f of [".last-memory-check", ".last-reminder", ".exploration-log", ".tool-history", ".cache-hits"]) {
    try { fs.unlinkSync(path.join(projectRoot, ".ai-memory", f)); } catch {}
  }

  // Record session start timestamp for session-summary.js delta tracking
  try {
    fs.writeFileSync(path.join(projectRoot, ".ai-memory", ".session-start-ts"), String(Date.now()), "utf-8");
  } catch {}

  // Ensure explorations directory exists
  const explorationsDir = path.join(projectRoot, ".ai-memory", "explorations");
  if (!fs.existsSync(explorationsDir)) {
    try { fs.mkdirSync(explorationsDir, { recursive: true }); } catch {}
  }

  // ── Auto-purge old explorations (>30 days) ──
  try {
    const PURGE_DAYS = 30;
    const purgeCutoff = Date.now() - PURGE_DAYS * 24 * 60 * 60 * 1000;
    const exploFiles = fs.readdirSync(explorationsDir).filter(f => f.endsWith(".md"));
    let purgedCount = 0;
    for (const file of exploFiles) {
      try {
        const stat = fs.statSync(path.join(explorationsDir, file));
        if (stat.mtimeMs < purgeCutoff) {
          fs.unlinkSync(path.join(explorationsDir, file));
          purgedCount++;
        }
      } catch {}
    }
    if (purgedCount > 0) {
      // Also clean the index
      const indexPath = path.join(explorationsDir, "explorations.jsonl");
      if (fs.existsSync(indexPath)) {
        const indexLines = fs.readFileSync(indexPath, "utf-8").trim().split("\n").filter(l => {
          try {
            const entry = JSON.parse(l.trim());
            return !entry.ts || new Date(entry.ts).getTime() >= purgeCutoff;
          } catch { return true; }
        });
        fs.writeFileSync(indexPath, indexLines.join("\n") + "\n", "utf-8");
      }
    }
  } catch { /* purging is best-effort */ }

  // ── Background services (non-blocking) ──
  try {
    const { spawn } = require("child_process");

    // Build intent classifier reference embeddings (if not cached)
    const classifierScript = path.join(projectRoot, "scripts", "intent-classifier.js");
    if (fs.existsSync(classifierScript) && !fs.existsSync(path.join(projectRoot, ".ai-memory", ".intent-embeddings.json"))) {
      const child0 = spawn(process.execPath, [classifierScript, "--build"], {
        detached: true, stdio: "ignore", windowsHide: true, cwd: projectRoot,
      });
      child0.unref();
    }

    // Build embeddings globally (all projects with .ai-memory)
    const buildScript = path.join(projectRoot, "scripts", "build-embeddings.js");
    if (fs.existsSync(buildScript)) {
      const child = spawn(process.execPath, [buildScript, "--all"], {
        detached: true, stdio: "ignore", windowsHide: true,
        cwd: projectRoot,
      });
      child.unref();
    }

    // Auto-start global dashboard (skips if already running)
    const dashboardScript = path.join(projectRoot, "scripts", "dashboard.js");
    if (fs.existsSync(dashboardScript)) {
      const child2 = spawn(process.execPath, [dashboardScript, "--background"], {
        detached: true, stdio: "ignore", windowsHide: true,
        env: { ...process.env, DASHBOARD_NO_BROWSER: "1" },
      });
      child2.unref();
    }

    // Start global memory daemon if not already running (single daemon serves all projects)
    const pluginRoot = path.resolve(__dirname, "..", "..");
    const daemonScript = path.join(pluginRoot, "scripts", "daemon.js");
    const daemonHome = process.env.USERPROFILE || process.env.HOME || "";
    const daemonPidFile = path.join(daemonHome, ".ai-memory-daemon-pid");
    let daemonRunning = false;
    try {
      const pid = Number(fs.readFileSync(daemonPidFile, "utf-8").trim());
      if (pid > 0) { process.kill(pid, 0); daemonRunning = true; } // signal 0 = check if alive
    } catch { /* not running */ }

    if (!daemonRunning && fs.existsSync(daemonScript)) {
      const daemonChild = spawn(process.execPath, [daemonScript], {
        detached: true, stdio: "ignore", windowsHide: true,
      });
      daemonChild.unref();
    }

    // Also build file-based caches as fallback (in case daemon isn't ready for first hook call)
    try { shared.buildAndCacheBM25(projectRoot); } catch {}
    try {
      const graphMod = require(path.join(pluginRoot, "scripts", "graph.js"));
      graphMod.buildAndCacheAdjacency(projectRoot);
    } catch {}
  } catch { /* non-critical */ }

  // ── Record session start in dashboard history ──
  try {
    const historyPath = path.join(projectRoot, ".ai-memory", "session-history.jsonl");
    fs.appendFileSync(historyPath, JSON.stringify({
      event: "start", ts: new Date().toISOString(), sessionId: sessionId || "unknown",
    }) + "\n", "utf-8");
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
  let scriptCount = 0;
  try {
    const scriptsPath = path.join(projectRoot, ".ai-memory", "scripts.jsonl");
    if (fs.existsSync(scriptsPath)) {
      const sc = fs.readFileSync(scriptsPath, "utf-8").trim();
      if (sc) scriptCount = sc.split("\n").filter(l => l.trim()).length;
    }
  } catch {}

  const stats = statsModule.getStats(projectRoot);
  const loadedLabel = `${decisions.length} decisions, ${research.length} research${scriptCount > 0 ? `, ${scriptCount} scripts` : ""}`;
  const statsBanner = sessionTokensSaved > 0
    ? `**[project-memory]** Loaded: ${loadedLabel} | ${statsModule.formatStatsLine(sessionTokensSaved, sessionTimeSaved, stats)}`
    : `**[project-memory]** Loaded: ${loadedLabel}`;
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

  // ── Sections 3-8 removed: research findings, CITE MEMORY, CHECK FIRST, ──
  // ── SAVE TRIGGERS, AUTO-SAVE, SESSION SUMMARY instructions are already ──
  // ── in CLAUDE.md (synced by sync-tools.js). No need to duplicate here. ──

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
