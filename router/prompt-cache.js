"use strict";

/**
 * Two-layer prompt cache:
 *   1. Exact match — SHA-256 of normalized request
 *   2. Semantic match — cosine similarity over embedding of last user message
 *
 * Storage: SQLite at ~/.ai-router/prompt-cache.db.
 * Cache only confidence-passed responses (set() requires confident:true).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const Database = require("better-sqlite3");
const config = require("./config.js");
const { getConfig } = config;

// Resolved lazily so ROUTER_DB_DIR can be set after module load (tests).
function dbPath() {
  return path.join(config.ROUTER_DIR, "prompt-cache.db");
}

let _db = null;
let _embedFn = null; // injected to avoid circular load of heavy embedding model
const DEFAULT_MAX_ROWS = 5000;

function ensureDir() {
  try { fs.mkdirSync(config.ROUTER_DIR, { recursive: true }); } catch {}
}

function getDb() {
  if (_db) return _db;
  ensureDir();
  _db = new Database(dbPath());
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      hash TEXT PRIMARY KEY,
      embedding BLOB,
      request_format TEXT NOT NULL,
      response_json TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      ts INTEGER NOT NULL,
      hits INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cache_ts ON cache(ts);
  `);
  return _db;
}

/**
 * Inject async embedding function (text -> Float32Array-compatible array).
 * Call once at startup to enable semantic match. Without it, only exact match works.
 */
function setEmbedder(fn) {
  _embedFn = typeof fn === "function" ? fn : null;
}

// ── Normalization ────────────────────────────────────────────

const VOLATILE_PATHS = [
  ["metadata", "user_id"],
  ["metadata", "request_id"],
  ["user"], // OpenAI's per-user telemetry
  ["stream"], // streaming responses are not cached
];

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function stripVolatile(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const clone = deepClone(obj);
  for (const segs of VOLATILE_PATHS) {
    let cur = clone;
    for (let i = 0; i < segs.length - 1; i++) {
      if (cur && typeof cur === "object" && segs[i] in cur) cur = cur[segs[i]];
      else { cur = null; break; }
    }
    if (cur && typeof cur === "object") delete cur[segs[segs.length - 1]];
  }
  return clone;
}

function sortedStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(sortedStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + sortedStringify(value[k])).join(",") + "}";
}

function normalizeRequest(req) {
  const stripped = stripVolatile(req || {});
  const canonical = {
    model: stripped.model ?? null,
    messages: stripped.messages ?? null,
    system: stripped.system ?? null,
    tools: stripped.tools ?? null,
    params: stripped.params ?? {
      temperature: stripped.temperature,
      top_p: stripped.top_p,
      top_k: stripped.top_k,
      max_tokens: stripped.max_tokens,
      stop: stripped.stop ?? stripped.stop_sequences,
    },
  };
  return sortedStringify(canonical);
}

function hashRequest(req, authHeader) {
  // SECURITY: include a hash of the auth header so two callers with different
  // API keys cannot share a cache entry (which would leak responses across
  // accounts).
  const authHash = authHeader
    ? crypto.createHash("sha256").update(String(authHeader)).digest("hex").slice(0, 16)
    : "noauth";
  return crypto.createHash("sha256").update(authHash + "\0" + normalizeRequest(req)).digest("hex");
}

function lastUserMessage(req) {
  const msgs = req && req.messages;
  if (!Array.isArray(msgs)) return "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const parts = m.content
        .map(p => (typeof p === "string" ? p : (p && (p.text || p.input_text)) || ""))
        .filter(Boolean);
      return parts.join("\n");
    }
  }
  return "";
}

// ── Embedding (de)serialization ─────────────────────────────

function embeddingToBlob(arr) {
  if (!arr || !arr.length) return null;
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i], i * 4);
  return buf;
}

function blobToEmbedding(blob) {
  if (!blob || !blob.length) return null;
  const len = blob.length / 4;
  const out = new Array(len);
  for (let i = 0; i < len; i++) out[i] = blob.readFloatLE(i * 4);
  return out;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── TTL helpers ──────────────────────────────────────────────

function ttlMs() {
  const cfg = getConfig();
  return Math.max(0, Number(cfg.router_cache_ttl_hours) || 24) * 3600 * 1000;
}

function isExpired(ts) {
  const ttl = ttlMs();
  if (ttl === 0) return false;
  return Date.now() - ts > ttl;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Look up a cached response. Returns null on miss.
 *
 * @returns {{ response: any, format: string, hit: 'exact'|'semantic',
 *             prompt_tokens: number, completion_tokens: number }|null}
 */
async function get(req, opts = {}) {
  // Streaming requests never cached
  if (req && req.stream) return null;

  const db = getDb();
  const hash = hashRequest(req, opts && opts.authHeader);

  // 1. Exact match
  const row = db.prepare("SELECT * FROM cache WHERE hash = ?").get(hash);
  if (row) {
    if (isExpired(row.ts)) {
      db.prepare("DELETE FROM cache WHERE hash = ?").run(hash);
    } else {
      db.prepare("UPDATE cache SET hits = hits + 1 WHERE hash = ?").run(hash);
      return {
        response: JSON.parse(row.response_json),
        format: row.request_format,
        hit: "exact",
        prompt_tokens: row.prompt_tokens || 0,
        completion_tokens: row.completion_tokens || 0,
      };
    }
  }

  // 2. Semantic match — only if embedder configured and skipSemantic not set
  if (opts.skipSemantic || !_embedFn) return null;

  const userText = lastUserMessage(req);
  if (!userText || userText.length < 4) return null;

  let queryEmb;
  try { queryEmb = await _embedFn(userText); }
  catch { return null; }
  if (!queryEmb || !queryEmb.length) return null;

  const cfg = getConfig();
  const threshold = Number(cfg.router_cache_semantic_threshold) || 0.92;

  const cutoff = Date.now() - ttlMs();
  const candidates = db.prepare(
    "SELECT hash, embedding, request_format, response_json, prompt_tokens, completion_tokens, ts " +
    "FROM cache WHERE embedding IS NOT NULL AND ts >= ? ORDER BY ts DESC"
  ).all(cutoff);

  for (const c of candidates) {
    const emb = blobToEmbedding(c.embedding);
    if (!emb || emb.length !== queryEmb.length) continue;
    const sim = cosine(queryEmb, emb);
    if (sim >= threshold) {
      db.prepare("UPDATE cache SET hits = hits + 1 WHERE hash = ?").run(c.hash);
      return {
        response: JSON.parse(c.response_json),
        format: c.request_format,
        hit: "semantic",
        prompt_tokens: c.prompt_tokens || 0,
        completion_tokens: c.completion_tokens || 0,
        similarity: sim,
      };
    }
  }
  return null;
}

/**
 * Store a response. Required: confident:true (no poisoning of low-confidence).
 *
 * @param {object} args { request, response, format, prompt_tokens, completion_tokens, confident }
 */
async function set(args) {
  if (!args || !args.request || !args.response) return false;
  if (args.confident !== true) return false; // no poisoning
  if (args.request && args.request.stream) return false; // streaming not cached

  const db = getDb();
  const hash = hashRequest(args.request, args.authHeader);

  let embBlob = null;
  if (_embedFn) {
    const text = lastUserMessage(args.request);
    if (text && text.length >= 4) {
      try {
        const v = await _embedFn(text);
        embBlob = embeddingToBlob(v);
      } catch {}
    }
  }

  db.prepare(
    "INSERT OR REPLACE INTO cache " +
    "(hash, embedding, request_format, response_json, prompt_tokens, completion_tokens, ts, hits) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT hits FROM cache WHERE hash = ?), 0))"
  ).run(
    hash,
    embBlob,
    args.format || "anthropic",
    JSON.stringify(args.response),
    args.prompt_tokens || 0,
    args.completion_tokens || 0,
    Date.now(),
    hash,
  );
  return true;
}

/**
 * LRU prune: keep newest+most-hit N rows. Default 5000.
 */
function pruneToMaxRows(maxRows = DEFAULT_MAX_ROWS) {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) AS c FROM cache").get().c;
  if (total <= maxRows) return 0;
  const toDelete = total - maxRows;
  // LRU score: order ascending by (hits, ts) — lowest first removed
  const result = db.prepare(
    "DELETE FROM cache WHERE hash IN (" +
    "  SELECT hash FROM cache ORDER BY hits ASC, ts ASC LIMIT ?" +
    ")"
  ).run(toDelete);
  return result.changes;
}

function clear() {
  getDb().exec("DELETE FROM cache");
}

function stats() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) AS c FROM cache").get().c;
  const hits = db.prepare("SELECT COALESCE(SUM(hits),0) AS h FROM cache").get().h;
  const oldest = db.prepare("SELECT MIN(ts) AS t FROM cache").get().t;
  const newest = db.prepare("SELECT MAX(ts) AS t FROM cache").get().t;
  return { total, hits, oldest, newest };
}

function close() {
  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
  }
}

module.exports = {
  get,
  set,
  pruneToMaxRows,
  clear,
  stats,
  close,
  setEmbedder,
  // exposed for tests
  hashRequest,
  normalizeRequest,
  lastUserMessage,
  cosine,
  get DB_PATH() { return dbPath(); },
};
