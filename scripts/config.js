#!/usr/bin/env node
"use strict";

/**
 * Configuration manager for project-memory plugin.
 * Reads from .ai-memory/config.json, falls back to defaults.
 * All settings previously hardcoded in hooks/scripts are now config-driven.
 */

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  searchMode: "hybrid", // "flat" | "graph" | "hybrid"
  graph: {
    enabled: true,
    expansionDepth: 2,   // hops in check-memory (async, can go deeper)
    hookExpansionDepth: 1, // hops in pre-tool-use hook (sync, must be fast)
    maxExpanded: 5,       // max graph-expanded findings to add
  },
  embeddings: {
    enabled: true,
    model: "Xenova/all-MiniLM-L6-v2",
  },
  quantization: {
    enabled: true,         // Enable TurboQuant by default
    bitWidth: 3,           // 2.5, 3, 4, or 8 bits per coordinate
    useQJL: true,          // Enable QJL bias correction
    seed: 0,               // Deterministic rotation matrix seed
    targetReduction: 0.90, // Target 90% storage reduction (informational)
  },
  bm25: {
    enabled: true,
    k1: 1.2,
    b: 0.75,
  },
  hooks: {
    cacheHitThreshold: 0.5,     // minimum BM25 score for cache hit
    maxInjectedFindings: 3,     // max findings in systemMessage
    memoryCheckTTLMinutes: 2,   // how long a memory check stays valid
    escalationThreshold: 2,     // reminders before hard block
    throttleMinutes: 3,         // min time between reminders
    summaryCheckpointCalls: 20, // force summary after N tool calls
  },
  autoCapture: {
    enabled: true,
    retryOverlapRatio: 0.3,     // token overlap for retry-success detection
    explorationMinCommands: 3,  // min exploratory commands for discovery pattern
  },
  scriptLibrary: {
    enabled: true,
    maxInjectedScripts: 2,      // max scripts in pre-tool-use systemMessage
    maxClaudeMdScripts: 10,     // max scripts shown in CLAUDE.md
    parameterizeOnCapture: true, // auto-parameterize captured commands
  },
};

/**
 * Deep merge: target gets all keys from source that it doesn't have.
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else if (result[key] === undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Read config from .ai-memory/config.json, merged with defaults.
 * Missing fields filled from DEFAULTS.
 */
function readConfig(projectRoot) {
  const configPath = path.join(projectRoot, ".ai-memory", "config.json");
  try {
    const userConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return deepMerge(userConfig, DEFAULTS);
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Write config to .ai-memory/config.json.
 */
function writeConfig(projectRoot, config) {
  const configPath = path.join(projectRoot, ".ai-memory", "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Get default config object.
 */
function getDefault() {
  return { ...DEFAULTS };
}

module.exports = { readConfig, writeConfig, getDefault, DEFAULTS };
