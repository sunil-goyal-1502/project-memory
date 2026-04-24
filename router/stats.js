"use strict";

/**
 * Per-request stats log + aggregates.
 * SQLite at ~/.ai-router/stats.db.
 *
 * Auth headers are stripped before any data reaches the DB. record() only
 * accepts a controlled set of fields; arbitrary header dumps are rejected.
 */

const fs = require("fs");
const path = require("path");

const Database = require("better-sqlite3");
const config = require("./config.js");

// Resolved lazily so ROUTER_DB_DIR can be set after module load (tests).
function dbPath() {
  return path.join(config.ROUTER_DIR, "stats.db");
}

// Cost model — Claude Sonnet pricing as a conservative reference.
// $3 / 1M input tokens, $15 / 1M output tokens. Local = $0.
const COST_PER_M_PROMPT = 3.0;
const COST_PER_M_COMPLETION = 15.0;

const SENSITIVE_HEADER_RE = /^(authorization|x-api-key|cookie|proxy-authorization|x-auth-token|api-key)$/i;

let _db = null;

function ensureDir() {
  try { fs.mkdirSync(config.ROUTER_DIR, { recursive: true }); } catch {}
}

function getDb() {
  if (_db) return _db;
  ensureDir();
  _db = new Database(dbPath());
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      format TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      category TEXT,
      classification TEXT,
      provider TEXT,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      latency_ms INTEGER,
      fallback INTEGER DEFAULT 0,
      cache_hit TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_req_ts ON requests(ts);
    CREATE TABLE IF NOT EXISTS daily_summary (
      date TEXT PRIMARY KEY,
      total INTEGER,
      local_pct REAL,
      cloud_pct REAL,
      fallback_pct REAL,
      cache_hit_pct REAL,
      est_tokens_saved INTEGER,
      est_cost_saved_usd REAL
    );
  `);
  return _db;
}

/**
 * Strip sensitive headers from any object handed to us. Defensive — even
 * though we never write headers to the DB, callers might log records elsewhere.
 */
function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  for (const k of Object.keys(headers)) {
    if (SENSITIVE_HEADER_RE.test(k)) continue;
    out[k] = headers[k];
  }
  return out;
}

/**
 * Record a request. Only the explicit fields below reach the DB.
 *
 * @param {object} r
 * @param {string} r.format - 'anthropic' | 'openai' | 'codex' | etc
 * @param {string} r.endpoint - request path
 * @param {string} [r.category] - 'routed' | 'passthrough' | 'ops'
 * @param {string} [r.classification] - 'simple' | 'medium' | 'complex'
 * @param {string} [r.provider] - 'ollama' | 'anthropic' | 'openai'
 * @param {string} [r.model]
 * @param {number} [r.prompt_tokens]
 * @param {number} [r.completion_tokens]
 * @param {number} [r.latency_ms]
 * @param {boolean|number} [r.fallback]
 * @param {string} [r.cache_hit] - 'exact' | 'semantic' | null
 * @param {string} [r.error]
 */
function record(r) {
  if (!r || !r.format || !r.endpoint) return;
  const db = getDb();
  db.prepare(
    "INSERT INTO requests " +
    "(ts, format, endpoint, category, classification, provider, model, " +
    " prompt_tokens, completion_tokens, latency_ms, fallback, cache_hit, error) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    r.ts || Date.now(),
    String(r.format),
    String(r.endpoint),
    r.category || null,
    r.classification || null,
    r.provider || null,
    r.model || null,
    Number.isFinite(r.prompt_tokens) ? r.prompt_tokens : null,
    Number.isFinite(r.completion_tokens) ? r.completion_tokens : null,
    Number.isFinite(r.latency_ms) ? r.latency_ms : null,
    r.fallback ? 1 : 0,
    r.cache_hit || null,
    r.error ? String(r.error).slice(0, 500) : null,
  );
}

function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 1000) / 10; // one decimal
}

/**
 * Aggregate dashboard for the last 24h (default) or any window.
 */
function getDashboard(opts = {}) {
  const db = getDb();
  const sinceMs = opts.sinceMs || 24 * 3600 * 1000;
  const cutoff = Date.now() - sinceMs;

  const all = db.prepare(
    "SELECT provider, model, endpoint, classification, prompt_tokens, " +
    " completion_tokens, latency_ms, fallback, cache_hit, error " +
    "FROM requests WHERE ts >= ?"
  ).all(cutoff);

  const total = all.length;
  let local = 0, cloud = 0, fallback = 0, cacheHits = 0, errors = 0;
  let savedPrompt = 0, savedCompletion = 0;
  const byEndpoint = {};
  const latencies = [];

  const LOCAL_PROVIDERS = new Set(["ollama", "openai-local"]);
  for (const row of all) {
    const isLocal = LOCAL_PROVIDERS.has(row.provider);
    if (isLocal) local++;
    else if (row.provider && row.provider !== "cache") cloud++;
    if (row.fallback) fallback++;
    if (row.cache_hit) {
      cacheHits++;
      // Cache hit = full token cost saved
      savedPrompt += row.prompt_tokens || 0;
      savedCompletion += row.completion_tokens || 0;
    } else if (isLocal) {
      // Local serve = cost we would have paid to cloud
      savedPrompt += row.prompt_tokens || 0;
      savedCompletion += row.completion_tokens || 0;
    }
    if (row.error) errors++;
    if (Number.isFinite(row.latency_ms)) latencies.push(row.latency_ms);

    const ep = row.endpoint || "(unknown)";
    if (!byEndpoint[ep]) byEndpoint[ep] = { count: 0, local: 0, cloud: 0, cache: 0 };
    byEndpoint[ep].count++;
    if (isLocal) byEndpoint[ep].local++;
    else if (row.provider && row.provider !== "cache") byEndpoint[ep].cloud++;
    if (row.cache_hit) byEndpoint[ep].cache++;
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
  const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;
  const p99 = latencies.length ? latencies[Math.floor(latencies.length * 0.99)] : 0;

  const costSaved =
    (savedPrompt * COST_PER_M_PROMPT + savedCompletion * COST_PER_M_COMPLETION) / 1_000_000;

  return {
    window_ms: sinceMs,
    total,
    local_pct: pct(local, total),
    cloud_pct: pct(cloud, total),
    fallback_pct: pct(fallback, total),
    cache_hit_pct: pct(cacheHits, total),
    error_pct: pct(errors, total),
    est_tokens_saved: savedPrompt + savedCompletion,
    est_cost_saved_usd: Math.round(costSaved * 10000) / 10000,
    latency_ms: { p50, p95, p99 },
    by_endpoint: byEndpoint,
  };
}

/**
 * Recompute today's daily_summary row on demand.
 */
function rollupToday() {
  const db = getDb();
  const dayMs = 24 * 3600 * 1000;
  const dash = getDashboard({ sinceMs: dayMs });
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(
    "INSERT OR REPLACE INTO daily_summary " +
    "(date, total, local_pct, cloud_pct, fallback_pct, cache_hit_pct, est_tokens_saved, est_cost_saved_usd) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    date,
    dash.total,
    dash.local_pct,
    dash.cloud_pct,
    dash.fallback_pct,
    dash.cache_hit_pct,
    dash.est_tokens_saved,
    dash.est_cost_saved_usd,
  );
  return { date, ...dash };
}

/**
 * Prometheus exposition format.
 */
// Per Prom exposition spec, label values must escape \, ", and newline.
// Without this, an attacker-controlled provider/model string could inject
// extra labels or a fake metric line into the exporter output.
function escLabel(s) {
  return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function getPrometheusMetrics() {
  const db = getDb();
  const sinceMs = 24 * 3600 * 1000;
  const cutoff = Date.now() - sinceMs;

  const counters = db.prepare(
    "SELECT provider, model, " +
    "  SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END) AS ok, " +
    "  SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS err, " +
    "  COUNT(*) AS total " +
    "FROM requests WHERE ts >= ? GROUP BY provider, model"
  ).all(cutoff);

  const cacheRow = db.prepare(
    "SELECT " +
    "  SUM(CASE WHEN cache_hit IS NOT NULL THEN 1 ELSE 0 END) AS hits, " +
    "  COUNT(*) AS total " +
    "FROM requests WHERE ts >= ?"
  ).get(cutoff);

  const fallbackRow = db.prepare(
    "SELECT SUM(fallback) AS f, COUNT(*) AS total FROM requests WHERE ts >= ?"
  ).get(cutoff);

  const buckets = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  const histRows = db.prepare(
    "SELECT latency_ms FROM requests WHERE ts >= ? AND latency_ms IS NOT NULL"
  ).all(cutoff);

  const lines = [];
  lines.push("# HELP airouter_requests_total Total proxied requests by provider/model/status");
  lines.push("# TYPE airouter_requests_total counter");
  for (const c of counters) {
    const lbls = `provider="${escLabel(c.provider || "unknown")}",model="${escLabel(c.model || "unknown")}"`;
    lines.push(`airouter_requests_total{${lbls},status="ok"} ${c.ok || 0}`);
    lines.push(`airouter_requests_total{${lbls},status="error"} ${c.err || 0}`);
  }

  lines.push("# HELP airouter_cache_hit_ratio Cache hit ratio (0-1) over last 24h");
  lines.push("# TYPE airouter_cache_hit_ratio gauge");
  const ratio = cacheRow && cacheRow.total ? (cacheRow.hits || 0) / cacheRow.total : 0;
  lines.push(`airouter_cache_hit_ratio ${ratio.toFixed(4)}`);

  lines.push("# HELP airouter_fallback_ratio Fallback (local-to-cloud) ratio over last 24h");
  lines.push("# TYPE airouter_fallback_ratio gauge");
  const fr = fallbackRow && fallbackRow.total ? (fallbackRow.f || 0) / fallbackRow.total : 0;
  lines.push(`airouter_fallback_ratio ${fr.toFixed(4)}`);

  lines.push("# HELP airouter_request_latency_ms Request latency histogram (ms)");
  lines.push("# TYPE airouter_request_latency_ms histogram");
  let cum = 0;
  let sum = 0;
  for (const r of histRows) sum += r.latency_ms;
  for (const b of buckets) {
    const c = histRows.filter(r => r.latency_ms <= b).length;
    cum = c;
    lines.push(`airouter_request_latency_ms_bucket{le="${b}"} ${cum}`);
  }
  lines.push(`airouter_request_latency_ms_bucket{le="+Inf"} ${histRows.length}`);
  lines.push(`airouter_request_latency_ms_sum ${sum}`);
  lines.push(`airouter_request_latency_ms_count ${histRows.length}`);

  return lines.join("\n") + "\n";
}

function clear() {
  getDb().exec("DELETE FROM requests; DELETE FROM daily_summary;");
}

function close() {
  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
  }
}

module.exports = {
  record,
  redactHeaders,
  getDashboard,
  getPrometheusMetrics,
  rollupToday,
  clear,
  close,
  get DB_PATH() { return dbPath(); },
  SENSITIVE_HEADER_RE,
};
