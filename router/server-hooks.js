"use strict";

/**
 * Lightweight facade over config + cache + stats that server.js (Phase A)
 * and fallback.js (Phase C) wire into. Keeps server.js free of heavy imports.
 */

const config = require("./config.js");
const cache = require("./prompt-cache.js");
const stats = require("./stats.js");

let _embedderInstalled = false;

/**
 * Install the embedding function for the semantic cache. Safe to call multiple
 * times. We dynamically require scripts/embeddings.js so the heavy ONNX model
 * load is deferred until actually needed.
 */
function ensureEmbedder() {
  if (_embedderInstalled) return;
  try {
    const emb = require("../scripts/embeddings.js");
    cache.setEmbedder(emb.generateEmbedding);
    _embedderInstalled = true;
  } catch (e) {
    process.stderr.write(`[router/server-hooks] embedder unavailable: ${e.message}\n`);
  }
}

/** GET /metrics handler — returns body + content-type. */
function prometheus() {
  return {
    body: stats.getPrometheusMetrics(),
    contentType: "text/plain; version=0.0.4",
  };
}

/** GET /stats handler — returns JSON dashboard. */
function dashboard(opts) {
  return stats.getDashboard(opts || {});
}

/** Convenience proxy around stats.record. */
function recordRequest(r) {
  return stats.record(r);
}

/** Convenience proxies around prompt-cache. */
async function cacheGet(req, opts) {
  ensureEmbedder();
  return cache.get(req, opts);
}

async function cacheSet(args) {
  ensureEmbedder();
  return cache.set(args);
}

/** POST /admin/reload handler — re-reads config from disk and env. */
function reloadAll() {
  return config.reloadConfig();
}

module.exports = {
  prometheus,
  dashboard,
  recordRequest,
  cacheGet,
  cacheSet,
  reloadAll,
  ensureEmbedder,
};
