"use strict";

/**
 * catch-all.test.js — unmatched paths should:
 *   1. Forward to upstream if x-api-key (anthropic) or Authorization Bearer
 *      (openai) is detectable from headers.
 *   2. Return 404 with a helpful error if no provider can be detected.
 */

const M = require("./_mocks.js");

(async () => {
  const A = M.makeAssert();
  const SBX = M.sandboxDir("catch-all");

  const ant = await M.mockAnthropic();
  const oai = await M.mockOpenAI();

  process.env.ROUTER_DB_DIR = SBX;
  process.env.ANTHROPIC_UPSTREAM_URL = ant.url;
  process.env.OPENAI_UPSTREAM_URL = oai.url;

  M.clearRouterCache();
  const config = require("../../router/config.js");
  config.refreshRouterDir();
  config.reloadConfig();
  const upstream = require("../../router/upstream.js");
  upstream.refreshProviderUrls();

  const server = require("../../router/server.js");
  const wire = require("../../router/wire.js");
  wire.install();

  const httpServer = await server.start({ port: 0, warm: false });
  const port = httpServer.address().port;

  // ── 1. Unmatched POST with x-api-key → routed to anthropic ──────────────
  ant.setHandler(({ req }) => {
    if (req.url === "/v1/some/new/anthropic/endpoint") {
      return { status: 200, body: { from: "anthropic-mock" } };
    }
    return { status: 404, body: { error: "no" } };
  });
  const r1 = await M.httpRequest({
    method: "POST", host: "127.0.0.1", port,
    path: "/v1/some/new/anthropic/endpoint",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-test",
    },
    body: JSON.stringify({ hello: "world" }),
  });
  A.eq(r1.status, 200, "catch-all POST + x-api-key → 200 anthropic");
  A.eq(JSON.parse(r1.body.toString("utf8")).from, "anthropic-mock", "anthropic mock answered");
  A.eq(ant.requests.length, 1, "anthropic mock saw the catch-all forward");

  // ── 2. Unmatched POST with Bearer → routed to openai ────────────────────
  oai.setHandler(({ req }) => {
    if (req.url === "/v1/some/new/openai/endpoint") {
      return { status: 200, body: { from: "openai-mock" } };
    }
    return { status: 404, body: { error: "no" } };
  });
  const r2 = await M.httpRequest({
    method: "POST", host: "127.0.0.1", port,
    path: "/v1/some/new/openai/endpoint",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer sk-openai-test",
    },
    body: JSON.stringify({ hello: "world" }),
  });
  A.eq(r2.status, 200, "catch-all POST + Bearer → 200 openai");
  A.eq(JSON.parse(r2.body.toString("utf8")).from, "openai-mock", "openai mock answered");
  A.eq(oai.requests.length, 1, "openai mock saw the catch-all forward");

  // ── 3. Unmatched POST with NO auth → 404 with helpful message ───────────
  const r3 = await M.httpRequest({
    method: "POST", host: "127.0.0.1", port,
    path: "/v1/some/random/endpoint",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  A.eq(r3.status, 404, "no-auth catch-all → 404");
  const err3 = JSON.parse(r3.body.toString("utf8"));
  A.eq(err3.error.type, "not_found", "error type=not_found");
  A.ok(/x-api-key|Bearer/.test(err3.error.message),
    "error message hints at supported auth headers");

  // ── 4. Unmatched GET (e.g., a poking probe) with no auth → 404 ──────────
  const r4 = await M.httpRequest({
    method: "GET", host: "127.0.0.1", port,
    path: "/totally/unknown",
  });
  A.eq(r4.status, 404, "GET unmatched → 404");

  // ── 5. /v1/messages/batches/<id> matches passthrough route directly ─────
  ant.setHandler(({ req }) => ({ status: 200, body: { batch: "ok", path: req.url } }));
  const r5 = await M.httpRequest({
    method: "GET", host: "127.0.0.1", port,
    path: "/v1/messages/batches/abc123",
    headers: { "x-api-key": "sk-ant-test" },
  });
  A.eq(r5.status, 200, "/v1/messages/batches/<id> → 200");
  const b5 = JSON.parse(r5.body.toString("utf8"));
  A.eq(b5.path, "/v1/messages/batches/abc123", "wildcard path forwarded intact");

  // ── 6. Auth never leaked into the 404 body ──────────────────────────────
  const r6 = await M.httpRequest({
    method: "POST", host: "127.0.0.1", port,
    path: "/lonely/endpoint",
    body: "x",
  });
  A.ok(!r6.body.toString("utf8").includes("sk-"), "no API key string in 404 body");

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await new Promise((res) => httpServer.close(res));
  await ant.close();
  await oai.close();
  try { require("../../router/stats.js").close(); } catch {}
  try { require("../../router/prompt-cache.js").close(); } catch {}
  M.rmrf(SBX);
  try { await require("undici").getGlobalDispatcher().close(); } catch {}

  console.log(`\ncatch-all.test: ${A.pass} passed, ${A.fail} failed`);
  process.exitCode = A.fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error("catch-all.test crashed:", e);
  process.exitCode = 2;
});
