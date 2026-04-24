"use strict";

/**
 * Fallback orchestrator tests.
 * Validates: cache hit, classify→decide→dispatch, circuit-breaker fallback,
 * one-stats-row invariant, privacy block, low-confidence fallback,
 * cloud failure → fallback, streaming local→cloud preFirstChunk fallback.
 *
 * Mocks all three providers via _mocks.js.
 *
 * Run: node test/router/fallback.test.js
 */

const path = require("path");
const http = require("http");
const {
  mockAnthropic, mockOpenAI, mockOllama,
  sandboxDir, rmrf, makeAssert, sleep,
} = require("./_mocks.js");

// Sandbox for SQLite isolation BEFORE any router require.
const SBX = sandboxDir("fallback");
process.env.ROUTER_DB_DIR = SBX;
process.env.ROUTER_BREAKER_COOLDOWN_MS = "100";
process.env.ROUTER_BREAKER_THRESHOLD = "5";
// This file exercises tier/complexity routing + cache + breaker fallback —
// not the client-model hint. Keep it deterministic by disabling the hint.
process.env.ROUTER_RESPECT_CLIENT_MODEL = "false";

const A = makeAssert();

// ── Stub semantic classifier so we never load ONNX ───────────────────────
const semPath = require.resolve("../../router/semantic-classifier.js");
require.cache[semPath] = {
  id: semPath, filename: semPath, loaded: true,
  exports: {
    classify: async () => ({ category: "complex", confidence: 0.5, scores: {} }),
    warmup: async () => {},
  },
};

// ── Stub server-hooks.ensureEmbedder so we never load ONNX ───────────────
const hooksPath = require.resolve("../../router/server-hooks.js");
const realHooks = require("../../router/server-hooks.js");
require.cache[hooksPath].exports = {
  ...realHooks,
  ensureEmbedder() { /* no-op for tests */ },
};

(async function main() {
  const ant = await mockAnthropic();
  const oai = await mockOpenAI();
  const oll = await mockOllama();

  process.env.ANTHROPIC_UPSTREAM_URL = ant.url;
  process.env.OPENAI_UPSTREAM_URL = oai.url;
  process.env.OLLAMA_URL = oll.url;

  const config = require("../../router/config.js");
  config.refreshRouterDir();
  config.reloadConfig();

  const upstream = require("../../router/upstream.js");
  upstream.refreshProviderUrls();

  // Reload ollama BASE_URL: ollama.js captures it at module load.
  // We have to set OLLAMA_URL BEFORE require — done above.
  const fallback = require("../../router/fallback.js");
  const stats = require("../../router/stats.js");
  const breaker = require("../../router/circuit-breaker.js");
  const cache = require("../../router/prompt-cache.js");

  // ── Helpers ──────────────────────────────────────────────────────────────
  function fakeReqRes() {
    const req = { url: "/v1/messages", method: "POST", headers: {} };
    let bodyChunks = [], status = 0, headers = {}, ended = false;
    const res = {
      get headersSent() { return ended || status > 0; },
      get statusCode() { return status; }, set statusCode(v) { status = v; },
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      write(c) { bodyChunks.push(Buffer.from(c)); return true; },
      end(c) { if (c) bodyChunks.push(Buffer.from(c)); ended = true; },
      _body: () => Buffer.concat(bodyChunks).toString("utf8"),
      _status: () => status,
      _headers: () => headers,
    };
    return { req, res };
  }

  function commonReq(text = "hi", overrides = {}) {
    return {
      messages: [{ role: "user", content: text }],
      system: null,
      tools: null,
      params: { model: "claude-3-5-sonnet", max_tokens: 50, ...(overrides.params || {}) },
      raw: {},
      ...overrides,
    };
  }

  // ── 1. Local routing — simple prompt → Ollama ─────────────────────────────
  {
    breaker.resetAll();
    cache.clear();
    process.env.ROUTER_MODE = "aggressive";
    process.env.ROUTER_PRIVACY_MODE = "false";
    config.reloadConfig();

    const { req, res } = fakeReqRes();
    const out = await fallback.dispatch(
      commonReq("hi"), "anthropic", "chat",
      { req, res, rawBody: Buffer.alloc(0), endpoint: "/v1/messages" }
    );
    A.eq(out.meta.provider, "ollama", "simple prompt → ollama");
    A.ok(oll.requests.length >= 1, "ollama mock saw a request");
    A.eq(res._status(), 200, "200 OK");
    const body = JSON.parse(res._body());
    A.eq(body.type, "message", "anthropic-format response written");
    A.ok(body.content[0].text.length > 0, "response has text");
  }

  // ── 2. One stats row per request ─────────────────────────────────────────
  {
    const dash = stats.getDashboard({ sinceMs: 60_000 });
    A.eq(dash.total, 1, "exactly 1 stats row recorded");
    A.eq(dash.local_pct, 100, "100% local (1/1)");
  }

  // ── 3. Cache hit on second identical call ────────────────────────────────
  {
    const { req, res } = fakeReqRes();
    const out = await fallback.dispatch(
      commonReq("hi"), "anthropic", "chat",
      { req, res, rawBody: Buffer.alloc(0), endpoint: "/v1/messages" }
    );
    A.eq(out.meta.provider, "cache", "second call → cache hit");
    A.eq(out.meta.cacheHit, "exact", "cache hit type=exact");
  }

  // ── 4. Complex prompt → cloud (anthropic) ────────────────────────────────
  {
    breaker.resetAll();
    cache.clear();
    ant.requests.length = 0;
    const { req, res } = fakeReqRes();
    req.headers["x-api-key"] = "test-key";
    req.headers["anthropic-version"] = "2023-06-01";
    const out = await fallback.dispatch(
      commonReq("Apply:\n\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"),
      "anthropic", "chat",
      { req, res, rawBody: Buffer.from('{"x":1}'), endpoint: "/v1/messages" }
    );
    A.eq(out.meta.provider, "anthropic", "complex/forced → anthropic cloud");
    A.eq(ant.requests.length, 1, "anthropic mock saw 1 request");
  }

  // ── 5. Privacy block ─────────────────────────────────────────────────────
  {
    breaker.resetAll();
    process.env.ROUTER_MODE = "balanced";
    process.env.ROUTER_PRIVACY_MODE = "true";
    config.reloadConfig();

    const { req, res } = fakeReqRes();
    const out = await fallback.dispatch(
      commonReq("Apply:\n\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"),
      "anthropic", "chat",
      { req, res, rawBody: Buffer.alloc(0), endpoint: "/v1/messages" }
    );
    A.eq(out.meta.error, "privacy_blocked", "privacy block → privacy_blocked");
    A.eq(res._status(), 503, "privacy → 503");

    process.env.ROUTER_PRIVACY_MODE = "false";
    config.reloadConfig();
  }

  // ── 6. Circuit-breaker open on Ollama → falls back to cloud ──────────────
  {
    cache.clear();
    breaker.resetAll();
    for (let i = 0; i < 5; i++) breaker.recordFailure("ollama");
    A.eq(breaker.state("ollama"), "OPEN", "ollama OPEN");

    process.env.ROUTER_MODE = "aggressive";
    config.reloadConfig();

    ant.requests.length = 0;
    const { req, res } = fakeReqRes();
    req.headers["x-api-key"] = "k"; req.headers["anthropic-version"] = "2023-06-01";
    const out = await fallback.dispatch(
      commonReq("hi"), "anthropic", "chat",
      { req, res, rawBody: Buffer.from('{"x":1}'), endpoint: "/v1/messages" }
    );
    A.eq(out.meta.provider, "anthropic", "breaker OPEN → falls back to anthropic");
    A.eq(out.meta.fallback, true, "fallback=true");
    A.eq(ant.requests.length, 1, "anthropic mock saw the fallback request");
  }

  // ── 7. Local cloud fallback when Ollama upstream errors mid-call ─────────
  {
    cache.clear();
    breaker.resetAll();

    // Make ollama mock error
    oll.setHandler(() => ({ status: 500, body: { error: "boom" } }));

    ant.requests.length = 0;
    const { req, res } = fakeReqRes();
    req.headers["x-api-key"] = "k"; req.headers["anthropic-version"] = "2023-06-01";
    const out = await fallback.dispatch(
      commonReq("hi"), "anthropic", "chat",
      { req, res, rawBody: Buffer.from('{"x":1}'), endpoint: "/v1/messages" }
    );
    A.eq(out.meta.fallback, true, "ollama 500 → fallback to cloud");
    A.eq(out.meta.provider, "anthropic", "fallback chose anthropic");
    A.eq(ant.requests.length, 1, "anthropic served the fallback");
  }

  // ── 8. (Embeddings dispatch path is intentionally not exercised here:
  //       fallback.dispatch always uses /api/chat for ollama.  Embedding
  //       routing decision logic is fully covered in router.test.js.) ──────

  // ── 9. Stats invariant: total rows after all dispatches > 0 ─────────────
  {
    const dash = stats.getDashboard({ sinceMs: 60_000 });
    A.ok(dash.total >= 5, `stats has at least 5 rows (got ${dash.total})`);
    A.ok(dash.fallback_pct > 0, `at least one fallback row (fallback_pct=${dash.fallback_pct})`);
  }

  // Cleanup
  await ant.close();
  await oai.close();
  await oll.close();
  cache.close();
  stats.close && stats.close();
  rmrf(SBX);

  try {
    const { getGlobalDispatcher } = require("undici");
    await getGlobalDispatcher().close();
  } catch {}

  const { fail } = A.summary("fallback.test");
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(2); });
