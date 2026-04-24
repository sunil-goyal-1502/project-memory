"use strict";

/**
 * model-registry.js — resolve a client-supplied model name to a provider.
 *
 * Why this exists:
 *   Claude Code (and other Anthropic-format clients) let the user pick a model
 *   via `claude --model X` or the `/model X` slash command. The name flows
 *   through to the request body as `params.model`. Without this module, the
 *   router ignores that value and picks its own tier; with it, the user's
 *   explicit choice wins.
 *
 * Resolution order (first match wins):
 *   1. Explicit suffix: `model@<provider>` where provider ∈
 *      { anthropic, openai, ollama, local, vllm, openai-local }.
 *      `local`, `vllm`, `openai-local` are all aliases for openai-local.
 *   2. Exact match against the live Ollama model list (cached).
 *   3. Name-based heuristic for well-known cloud families:
 *        claude-*   → anthropic
 *        gpt-* / o1-* / o3-* / chatgpt-* → openai
 *   4. No match → returns null; caller falls through to tier system.
 *
 * The Ollama list is cached with a TTL so decide() can stay synchronous.
 * A background refresh kicks off on first use; until it completes, we fall
 * back to a conservative "looks like an Ollama tag" heuristic
 * (`name:tag` with a ':' in the middle).
 */

const VALID_SUFFIXES = new Set([
  "anthropic",
  "openai",
  "ollama",
  "local",
  "vllm",
  "openai-local",
]);

// How long to trust the cached Ollama list. Short enough that newly `ollama pull`ed
// models show up quickly, long enough that we're not hammering /api/tags.
const OLLAMA_LIST_TTL_MS = 60 * 1000;

let _ollamaList = null; // Set<string> of installed model names
let _ollamaListAt = 0;
let _ollamaRefreshInFlight = null;

function _normalizeSuffix(s) {
  const v = String(s || "").toLowerCase().trim();
  if (v === "local" || v === "vllm") return "openai-local";
  if (v === "openai-local") return "openai-local";
  return v;
}

/**
 * Parse an optional `@provider` suffix off the end of a model name.
 * Returns { cleanModel, provider|null }.
 */
function parseSuffix(model) {
  if (typeof model !== "string") return { cleanModel: model, provider: null };
  // Guard against garbage: model names are at most a few hundred chars.
  // Suffix must be the last `@…` segment and contain only [a-z0-9-].
  const atIdx = model.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === model.length - 1) {
    return { cleanModel: model, provider: null };
  }
  const candidate = model.slice(atIdx + 1);
  if (!/^[a-z0-9-]{1,32}$/i.test(candidate)) {
    return { cleanModel: model, provider: null };
  }
  const normalized = _normalizeSuffix(candidate);
  if (!VALID_SUFFIXES.has(candidate.toLowerCase())) {
    return { cleanModel: model, provider: null };
  }
  return { cleanModel: model.slice(0, atIdx), provider: normalized };
}

/**
 * Kick off a background refresh of the Ollama model list. Never throws;
 * on failure the cache is simply left empty / stale.
 */
function _refreshOllamaList() {
  if (_ollamaRefreshInFlight) return _ollamaRefreshInFlight;
  // Lazy require to avoid a hard dependency at require-time (e.g. in tests
  // that exercise model-registry without spinning up Ollama).
  let ollama;
  try { ollama = require("./ollama.js"); } catch { return Promise.resolve(null); }
  _ollamaRefreshInFlight = (async () => {
    try {
      const data = await ollama.listModels();
      const names = new Set();
      for (const m of (data && data.models) || []) {
        if (m && typeof m.name === "string") names.add(m.name);
      }
      _ollamaList = names;
      _ollamaListAt = Date.now();
    } catch {
      // keep previous snapshot (if any); don't poison the cache.
    } finally {
      _ollamaRefreshInFlight = null;
    }
  })();
  return _ollamaRefreshInFlight;
}

function _ollamaKnows(model) {
  // Trigger async refresh if stale. decide() runs sync, but we can use last
  // snapshot even while a refresh is in flight.
  if (!_ollamaList || Date.now() - _ollamaListAt > OLLAMA_LIST_TTL_MS) {
    _refreshOllamaList();
  }
  if (!_ollamaList) return false;
  if (_ollamaList.has(model)) return true;
  // Ollama tags default to `:latest` when omitted — let `qwen3.6` match
  // `qwen3.6:latest`.
  if (!model.includes(":") && _ollamaList.has(model + ":latest")) return true;
  return false;
}

// Conservative pattern for an Ollama-style tagged model name: `name:tag`
// where name is typical model-name chars and tag is typical tag chars.
// Used as a fallback when the live list is unavailable.
const OLLAMA_TAG_PATTERN = /^[a-z0-9][\w.+\-]{0,63}:[\w.+\-]{1,63}$/i;

const CLAUDE_PATTERN  = /^(claude|anthropic)[-._/]/i;
const OPENAI_PATTERN  = /^(gpt-|o1-|o1$|o3-|o3$|chatgpt-|text-embedding-|text-davinci-|dall-e-|tts-|whisper-)/i;

/**
 * @param {string} model - the model name as the client sent it
 * @param {object} [opts]
 * @param {boolean} [opts.allowHeuristic=true] - if false, only exact list matches
 *        and explicit suffixes return a provider.
 * @returns {null | { provider: string, cleanModel: string, reason: string }}
 */
function detectProviderFromModel(model, opts = {}) {
  if (!model || typeof model !== "string") return null;
  const trimmed = model.trim();
  if (!trimmed) return null;

  // 1. Explicit suffix
  const { cleanModel, provider } = parseSuffix(trimmed);
  if (provider) {
    return {
      provider,
      cleanModel,
      reason: `explicit suffix @${provider}`,
    };
  }

  // 2. Exact match against Ollama's installed models (cached).
  if (_ollamaKnows(trimmed)) {
    return { provider: "ollama", cleanModel: trimmed, reason: "matches installed Ollama model" };
  }

  if (opts.allowHeuristic === false) return null;

  // 3. Name heuristics for cloud families.
  if (CLAUDE_PATTERN.test(trimmed)) {
    return { provider: "anthropic", cleanModel: trimmed, reason: "name matches Anthropic family" };
  }
  if (OPENAI_PATTERN.test(trimmed)) {
    return { provider: "openai", cleanModel: trimmed, reason: "name matches OpenAI family" };
  }

  // 4. Conservative Ollama tag fallback (only if Ollama cache unreachable and
  //    name looks like an Ollama tagged model — avoids routing `claude-3-5-sonnet`
  //    here because colons aren't present in Anthropic names).
  if (!_ollamaList && OLLAMA_TAG_PATTERN.test(trimmed) && trimmed.includes(":")) {
    return {
      provider: "ollama",
      cleanModel: trimmed,
      reason: "matches Ollama tag pattern (live list unavailable)",
    };
  }

  return null;
}

// ─── Test hooks ────────────────────────────────────────────────────────────
// These are NOT part of the public contract; tests import them via
// `_internals` to stub the cache without spinning up Ollama.
const _internals = {
  setOllamaList(names) {
    _ollamaList = new Set(names || []);
    _ollamaListAt = Date.now();
  },
  clearOllamaCache() {
    _ollamaList = null;
    _ollamaListAt = 0;
    _ollamaRefreshInFlight = null;
  },
  getOllamaList() {
    return _ollamaList ? Array.from(_ollamaList) : null;
  },
};

module.exports = {
  detectProviderFromModel,
  parseSuffix,
  VALID_SUFFIXES,
  OLLAMA_LIST_TTL_MS,
  _internals,
};
