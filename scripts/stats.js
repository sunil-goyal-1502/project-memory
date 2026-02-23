#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

// Conservative estimates for tokens/time saved per event
const TOKENS_SAVED = {
  session_load_decision: 150,
  session_load_research: 300,
  research_search_hit: 1000,
  memory_check_hit: 1000,
  duplicate_save_avoided: 200,
};

const TIME_SAVED_SEC = {
  session_load_decision: 15,
  session_load_research: 45,
  research_search_hit: 120,
  memory_check_hit: 120,
  duplicate_save_avoided: 30,
};

// Approximate average $/1K tokens across models
const COST_PER_1K_TOKENS = 0.012;

// ANSI color codes (consistent with hooks/scripts/pre-tool-use.js)
const C = {
  magenta: "\x1b[95m",  // bright magenta — "checking/consulting"
  green: "\x1b[92m",    // bright green — "found/saved/savings"
  yellow: "\x1b[93m",   // bright yellow — "no matches"
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

function getMetadataPath(projectRoot) {
  return path.join(projectRoot, ".ai-memory", "metadata.json");
}

function readMetadata(projectRoot) {
  const metadataPath = getMetadataPath(projectRoot);
  if (!fs.existsSync(metadataPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
  } catch {
    return {};
  }
}

function ensureStats(metadata) {
  if (!metadata.stats) {
    metadata.stats = {
      totalTokensSaved: 0,
      totalTimeSavedSeconds: 0,
      totalHits: 0,
      eventCounts: {
        session_load_decision: 0,
        session_load_research: 0,
        research_search_hit: 0,
        memory_check_hit: 0,
        duplicate_save_avoided: 0,
      },
    };
  }
  if (!metadata.stats.eventCounts) {
    metadata.stats.eventCounts = {
      session_load_decision: 0,
      session_load_research: 0,
      research_search_hit: 0,
      memory_check_hit: 0,
      duplicate_save_avoided: 0,
    };
  }
  // Ensure new event types exist in older metadata
  if (!metadata.stats.eventCounts.memory_check_hit) {
    metadata.stats.eventCounts.memory_check_hit = 0;
  }
  if (!metadata.stats.eventCounts.duplicate_save_avoided) {
    metadata.stats.eventCounts.duplicate_save_avoided = 0;
  }
  return metadata;
}

/**
 * Record a savings event. Updates cumulative stats in metadata.json.
 * @param {string} projectRoot - project root directory
 * @param {string} eventType - one of session_load_decision, session_load_research, research_search_hit
 * @param {number} count - how many items (e.g. number of decisions loaded)
 */
function recordEvent(projectRoot, eventType, count) {
  if (!TOKENS_SAVED[eventType]) return;
  if (!count || count <= 0) return;

  const metadataPath = getMetadataPath(projectRoot);
  let metadata = readMetadata(projectRoot);
  metadata = ensureStats(metadata);

  const tokensSaved = TOKENS_SAVED[eventType] * count;
  const timeSaved = TIME_SAVED_SEC[eventType] * count;

  metadata.stats.totalTokensSaved += tokensSaved;
  metadata.stats.totalTimeSavedSeconds += timeSaved;
  metadata.stats.totalHits += count;
  metadata.stats.eventCounts[eventType] =
    (metadata.stats.eventCounts[eventType] || 0) + count;

  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
  return { tokensSaved, timeSaved };
}

/**
 * Read cumulative stats from metadata.json.
 */
function getStats(projectRoot) {
  let metadata = readMetadata(projectRoot);
  metadata = ensureStats(metadata);
  return metadata.stats;
}

/**
 * Format a number for display: 1234 → "1,234", 45000 → "45K"
 */
function formatNumber(n) {
  if (n >= 1000000) {
    const val = n / 1000000;
    return val % 1 === 0 ? `${val}M` : `${val.toFixed(1)}M`;
  }
  if (n >= 10000) {
    const val = n / 1000;
    return val % 1 === 0 ? `${val}K` : `${val.toFixed(1)}K`;
  }
  return n.toLocaleString("en-US");
}

/**
 * Format seconds into human-readable duration: 90 → "1.5 min", 5400 → "1.5 hrs"
 */
function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} sec`;
  if (seconds < 3600) {
    const mins = seconds / 60;
    return mins % 1 === 0 ? `${mins} min` : `${mins.toFixed(1)} min`;
  }
  const hrs = seconds / 3600;
  return hrs % 1 === 0 ? `${hrs} hrs` : `${hrs.toFixed(1)} hrs`;
}

/**
 * Format a cost from tokens: tokens → "$0.03"
 */
function formatCost(tokens) {
  const cost = (tokens / 1000) * COST_PER_1K_TOKENS;
  return `$${cost.toFixed(2)}`;
}

/**
 * Format the standardized Memory Status block appended to every script output.
 * @param {object} opts
 * @param {string} opts.action - What happened ("Saved decision [arch]: ...", "Checked memory for ...")
 * @param {string} opts.checked - What was checked ("decisions.jsonl (4 entries)", etc.)
 * @param {string} opts.matches - Match summary ("0 duplicates", "2 matches found")
 * @param {string} opts.saved - What was saved this action ("~150 tokens, ~15 sec per future session load")
 * @param {string} opts.projectRoot - Project root for reading cumulative stats
 * @returns {string} The formatted status block
 */
function formatMemoryStatus({ action, checked, matches, saved, projectRoot }) {
  const lines = [];
  lines.push("");
  lines.push("--- Memory Status ---");
  lines.push(`Action: ${action}`);
  lines.push(`Checked: ${checked}`);
  lines.push(`Matches: ${matches}`);
  lines.push(`Saved: ${saved}`);

  if (projectRoot) {
    const stats = getStats(projectRoot);
    if (stats.totalTokensSaved > 0) {
      lines.push(
        `Cumulative: ~${formatNumber(stats.totalTokensSaved)} tokens (~${formatCost(stats.totalTokensSaved)}), ~${formatDuration(stats.totalTimeSavedSeconds)} saved across ${formatNumber(stats.totalHits)} lookups`
      );
    }
  }

  return lines.join("\n");
}

/**
 * Color-aware Insight-style savings box for check-memory terminal output.
 * Matches the ★ Insight format: top border with title, content, bottom border.
 * All in green ANSI for high visibility.
 */
function formatMemoryStatusColored({ action, checked, matches, saved, projectRoot }) {
  const G = `${C.green}`;
  const GB = `${C.green}${C.bold}`;
  const R = C.reset;
  const border = "\u2500".repeat(49);

  const lines = [];
  lines.push("");
  lines.push(`${GB}\u2605 Memory Savings \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${R}`);
  lines.push(`${G}  This check: ${saved}${R}`);

  if (projectRoot) {
    const stats = getStats(projectRoot);
    if (stats.totalTokensSaved > 0) {
      lines.push(
        `${G}  Cumulative: ~${formatNumber(stats.totalTokensSaved)} tokens (~${formatCost(stats.totalTokensSaved)}), ~${formatDuration(stats.totalTimeSavedSeconds)} saved across ${formatNumber(stats.totalHits)} lookups${R}`
      );
    }
  }

  lines.push(`${GB}${border}${R}`);
  return lines.join("\n");
}

/**
 * Reusable Insight-style savings box for save-research / save-decision.
 * Shows per-action estimate + cumulative stats in green.
 * @param {string} thisSave - e.g. "~1K tokens, ~2 min saved per future lookup"
 * @param {string} projectRoot - project root for reading cumulative stats
 */
function formatSavingsInsight(thisSave, projectRoot) {
  const G = `${C.green}`;
  const GB = `${C.green}${C.bold}`;
  const R = C.reset;
  const border = "\u2500".repeat(49);

  const lines = [];
  lines.push(`${GB}\u2605 Memory Savings \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${R}`);
  lines.push(`${G}  This save: ${thisSave}${R}`);

  if (projectRoot) {
    const stats = getStats(projectRoot);
    if (stats.totalTokensSaved > 0) {
      lines.push(
        `${G}  Cumulative: ~${formatNumber(stats.totalTokensSaved)} tokens (~${formatCost(stats.totalTokensSaved)}), ~${formatDuration(stats.totalTimeSavedSeconds)} saved across ${formatNumber(stats.totalHits)} lookups${R}`
      );
    }
  }

  lines.push(`${GB}${border}${R}`);
  return lines.join("\n");
}

/**
 * Return a formatted one-liner showing session + cumulative savings.
 */
function formatStatsLine(sessionTokensSaved, sessionTimeSaved, stats) {
  const parts = [];

  if (sessionTokensSaved > 0) {
    parts.push(
      `Memory savings this session: ~${formatNumber(sessionTokensSaved)} tokens (~${formatCost(sessionTokensSaved)})`
    );
  }

  if (stats && stats.totalTokensSaved > 0) {
    const cumulative = `Cumulative: ~${formatNumber(stats.totalTokensSaved)} tokens (~${formatCost(stats.totalTokensSaved)}), ~${formatDuration(stats.totalTimeSavedSeconds)} saved`;
    if (parts.length > 0) {
      parts.push(cumulative);
    } else {
      parts.push(`Cumulative memory savings: ~${formatNumber(stats.totalTokensSaved)} tokens (~${formatCost(stats.totalTokensSaved)}), ~${formatDuration(stats.totalTimeSavedSeconds)} saved across ${formatNumber(stats.totalHits)} lookups`);
    }
  }

  return parts.join(" | ");
}

module.exports = {
  C,
  TOKENS_SAVED,
  TIME_SAVED_SEC,
  COST_PER_1K_TOKENS,
  recordEvent,
  getStats,
  formatNumber,
  formatDuration,
  formatCost,
  formatStatsLine,
  formatMemoryStatus,
  formatMemoryStatusColored,
  formatSavingsInsight,
};
