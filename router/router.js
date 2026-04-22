"use strict";

/**
 * router/router.js — Decision logic.
 *
 * Given a parsed commonRequest + a classification result + a "kind" hint,
 * pick the primary route and (if local) a cloud fallback.
 *
 * decide(commonRequest, classification, kind) → {
 *   provider: 'ollama' | 'anthropic' | 'openai',
 *   model:    string,
 *   reason:   string,
 *   fallback: { provider, model } | null,
 * }
 *
 * Modes (config.router_mode):
 *   - aggressive   : simple+medium → ollama; complex → cloud; embeddings → ollama (if route-embeddings)
 *   - balanced     : simple → ollama; medium+complex → cloud
 *   - conservative : simple → ollama (only if no tools); else cloud
 *   - disabled     : always cloud
 *
 * Privacy mode (config.router_privacy_mode):
 *   - Cloud fallback is never offered (fallback = null).
 *   - If the primary decision selects a cloud provider, decide() throws so the
 *     caller can decide how to handle it (typically: 503 to the client). The
 *     orchestrator inspects the error type via err.code === 'PRIVACY_BLOCK'.
 */

const { getConfig } = require("./config.js");

// Cloud format → cloud provider (for both primary cloud picks AND fallback picks).
function cloudProviderForFormat(format) {
  if (format === "anthropic") return "anthropic";
  // 'openai' and 'responses' both go to OpenAI upstream.
  return "openai";
}

// Pick the model for a given provider + tier signal.
function pickModel(provider, tier, kind, classification, commonRequest) {
  const cfg = getConfig();
  if (provider === "ollama") {
    if (kind === "embedding") return cfg.tier_embed || cfg.ollama_model;
    if (tier === "code")      return cfg.tier_code   || cfg.ollama_model;
    if (tier === "complex")   return cfg.tier_complex || cfg.ollama_model;
    return cfg.tier_simple || cfg.ollama_model;
  }
  // Cloud: respect whatever model the caller asked for. The router does not
  // re-write cloud model selection — that's the client's contract with the
  // upstream. Fall back to whatever was on the request.
  return (commonRequest && commonRequest.params && commonRequest.params.model) || null;
}

/**
 * Lightweight "is this a code-heavy prompt?" check used to upgrade the local
 * tier from `simple` → `code`. Cheap signals only — full code detection lives
 * in heuristics.js (which has already run by the time decide() is called).
 */
function looksCodeHeavy(commonRequest, classification) {
  // 1. classifier reasons mention codeBlocks signal
  const reasons = (classification && classification.reasons) || [];
  for (const r of reasons) {
    if (typeof r === "string" && /codeBlocks/i.test(r)) return true;
  }
  // 2. raw scan for fenced code in last user message — keep cheap
  const msgs = (commonRequest && commonRequest.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    const c = typeof m.content === "string" ? m.content : "";
    if (c.indexOf("```") >= 0) return true;
    break;
  }
  return false;
}

/**
 * @param {object} commonRequest - parsed via adapter.toCommon()
 * @param {object} classification - from classifier.classify()
 * @param {string} kind - 'chat' | 'embedding' | 'completion' | 'responses'
 * @param {string} [format] - inbound request format ('anthropic' | 'openai' | 'responses')
 *                            Used to derive cloud provider. Defaults to commonRequest.format.
 */
function decide(commonRequest, classification, kind, format) {
  const cfg = getConfig();
  const fmt = format || (commonRequest && commonRequest.format) || "openai";
  const cloud = cloudProviderForFormat(fmt);
  const mode = cfg.router_mode || "balanced";
  const privacy = !!cfg.router_privacy_mode;
  const complexity = (classification && classification.complexity) || "complex";

  // Disabled mode → straight to cloud, no fallback.
  if (mode === "disabled") {
    if (privacy) throwPrivacy("router_mode=disabled forces cloud, blocked by privacy mode");
    return {
      provider: cloud,
      model: pickModel(cloud, complexity, kind, classification, commonRequest),
      reason: "router_mode=disabled — pass-through to cloud",
      fallback: null,
    };
  }

  // Embeddings: prefer local if route-embeddings is on AND not disabled.
  if (kind === "embedding") {
    if (cfg.router_route_embeddings) {
      return {
        provider: "ollama",
        model: pickModel("ollama", "embed", "embedding", classification, commonRequest),
        reason: "embedding → local Ollama (route_embeddings=true)",
        fallback: privacy ? null : {
          provider: cloud,
          model: pickModel(cloud, "embed", "embedding", classification, commonRequest),
        },
      };
    }
    if (privacy) throwPrivacy("embedding requires cloud (route_embeddings=false), blocked");
    return {
      provider: cloud,
      model: pickModel(cloud, "embed", "embedding", classification, commonRequest),
      reason: "embedding → cloud (route_embeddings=false)",
      fallback: null,
    };
  }

  const hasTools = Array.isArray(commonRequest && commonRequest.tools) &&
                   commonRequest.tools.length > 0;

  // Per-mode decision
  let pickLocal = false;
  let reason;
  switch (mode) {
    case "aggressive":
      pickLocal = (complexity === "simple" || complexity === "medium");
      reason = `aggressive: complexity=${complexity} → ${pickLocal ? "local" : "cloud"}`;
      break;
    case "conservative":
      pickLocal = (complexity === "simple" && !hasTools);
      reason = `conservative: complexity=${complexity}, hasTools=${hasTools} → ${pickLocal ? "local" : "cloud"}`;
      break;
    case "balanced":
    default:
      pickLocal = (complexity === "simple");
      reason = `balanced: complexity=${complexity} → ${pickLocal ? "local" : "cloud"}`;
      break;
  }

  // Local tier selection: code-heavy upgrade.
  let tier = complexity;
  if (pickLocal && looksCodeHeavy(commonRequest, classification)) {
    tier = "code";
    reason += " (code-heavy → tier_code)";
  }

  if (pickLocal) {
    return {
      provider: "ollama",
      model: pickModel("ollama", tier, kind, classification, commonRequest),
      reason,
      fallback: privacy ? null : {
        provider: cloud,
        model: pickModel(cloud, complexity, kind, classification, commonRequest),
      },
    };
  }

  // Cloud primary
  if (privacy) throwPrivacy(`primary route is cloud (${reason}), blocked by privacy mode`);
  return {
    provider: cloud,
    model: pickModel(cloud, complexity, kind, classification, commonRequest),
    reason,
    fallback: null, // No local fallback after a cloud decision (per plan).
  };
}

function throwPrivacy(msg) {
  const err = new Error(`Privacy mode blocked cloud route: ${msg}`);
  err.code = "PRIVACY_BLOCK";
  throw err;
}

module.exports = {
  decide,
  // exposed for tests
  cloudProviderForFormat,
  looksCodeHeavy,
};
