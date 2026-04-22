"use strict";

/**
 * Router config — env vars take precedence over file (~/.ai-router/config.json).
 * Hot-reload via fs.watchFile and explicit reloadConfig() call.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
// ROUTER_DB_DIR allows test isolation — point stats/cache DBs at a sandbox dir
// without affecting other env-derived behavior. Falls back to ~/.ai-router.
function resolveRouterDir() {
  return process.env.ROUTER_DB_DIR
    ? path.resolve(process.env.ROUTER_DB_DIR)
    : path.join(HOME, ".ai-router");
}
let ROUTER_DIR = resolveRouterDir();
let CONFIG_FILE = path.join(ROUTER_DIR, "config.json");

const DEFAULTS = Object.freeze({
  router_port: 8081,
  model_provider: "ollama",
  tier_simple: "llama3.2:3b",
  tier_complex: null, // null = use cloud
  tier_code: "qwen2.5-coder:7b",
  tier_embed: "nomic-embed-text",
  ollama_url: "http://127.0.0.1:11434",
  ollama_model: "llama3.2:3b",
  router_mode: "balanced", // aggressive | balanced | conservative | disabled
  router_privacy_mode: false,
  router_fallback_on_low_confidence: true,
  router_route_embeddings: true,
  anthropic_upstream_url: "https://api.anthropic.com",
  openai_upstream_url: "https://api.openai.com",
  router_cache_ttl_hours: 24,
  router_cache_semantic_threshold: 0.92,
});

const ENV_KEYS = [
  "ROUTER_PORT",
  "MODEL_PROVIDER",
  "TIER_SIMPLE",
  "TIER_COMPLEX",
  "TIER_CODE",
  "TIER_EMBED",
  "OLLAMA_URL",
  "OLLAMA_MODEL",
  "ROUTER_MODE",
  "ROUTER_PRIVACY_MODE",
  "ROUTER_FALLBACK_ON_LOW_CONFIDENCE",
  "ROUTER_ROUTE_EMBEDDINGS",
  "ANTHROPIC_UPSTREAM_URL",
  "OPENAI_UPSTREAM_URL",
  "ROUTER_CACHE_TTL_HOURS",
  "ROUTER_CACHE_SEMANTIC_THRESHOLD",
];

let _current = null;
const _subscribers = new Set();
let _watching = false;

function ensureDir() {
  try { fs.mkdirSync(ROUTER_DIR, { recursive: true }); } catch {}
}

function readFileConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") return data;
  } catch {}
  return {};
}

function coerce(key, value) {
  if (value === undefined || value === null) return undefined;
  const def = DEFAULTS[key];
  if (typeof def === "boolean") {
    if (typeof value === "boolean") return value;
    const s = String(value).toLowerCase().trim();
    return s === "true" || s === "1" || s === "yes";
  }
  if (typeof def === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : def;
  }
  return value === "" ? undefined : value;
}

function buildConfig() {
  const fileCfg = readFileConfig();
  const merged = { ...DEFAULTS };

  // file overrides
  for (const k of Object.keys(DEFAULTS)) {
    if (k in fileCfg) {
      const v = coerce(k, fileCfg[k]);
      if (v !== undefined) merged[k] = v;
    }
  }
  // env overrides (highest)
  for (const envKey of ENV_KEYS) {
    if (envKey in process.env) {
      const k = envKey.toLowerCase();
      const v = coerce(k, process.env[envKey]);
      if (v !== undefined) merged[k] = v;
    }
  }

  return Object.freeze(merged);
}

function getConfig() {
  if (!_current) _current = buildConfig();
  return _current;
}

function reloadConfig() {
  const old = _current;
  _current = buildConfig();
  if (JSON.stringify(old) !== JSON.stringify(_current)) {
    for (const fn of _subscribers) {
      try { fn(_current, old); } catch (e) {
        // do not let one bad subscriber break others
        process.stderr.write(`[router/config] subscriber error: ${e.message}\n`);
      }
    }
  }
  return _current;
}

function subscribe(fn) {
  if (typeof fn !== "function") throw new TypeError("subscribe requires a function");
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

function startWatching() {
  if (_watching) return;
  ensureDir();
  // watchFile works even if file doesn't exist yet (polls)
  fs.watchFile(CONFIG_FILE, { interval: 1000 }, () => {
    reloadConfig();
  });
  _watching = true;
}

function stopWatching() {
  if (!_watching) return;
  fs.unwatchFile(CONFIG_FILE);
  _watching = false;
}

module.exports = {
  getConfig,
  reloadConfig,
  subscribe,
  startWatching,
  stopWatching,
  // Test hook: re-read ROUTER_DB_DIR (call after mutating env)
  refreshRouterDir() {
    ROUTER_DIR = resolveRouterDir();
    CONFIG_FILE = path.join(ROUTER_DIR, "config.json");
    module.exports.ROUTER_DIR = ROUTER_DIR;
    module.exports.CONFIG_FILE = CONFIG_FILE;
    return ROUTER_DIR;
  },
  CONFIG_FILE,
  ROUTER_DIR,
  DEFAULTS,
};
