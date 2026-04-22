"use strict";

/**
 * count-tokens.test.js — Claude Code regression: /v1/messages/count_tokens
 * MUST work. It is classified as passthrough → forwarded byte-for-byte to
 * the Anthropic upstream. The router must not 404, must not 500, and the
 * response body must be returned untouched.
 */

const path = require("path");
const M = require("./_mocks.js");

(async () => {
  const A = M.makeAssert();
  const SBX = M.sandboxDir("count-tokens");

  const ant = await M.mockAnthropic();
  process.env.ROUTER_DB_DIR = SBX;
  process.env.ANTHROPIC_UPSTREAM_URL = ant.url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";

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

  // ── 1. Route table maps /v1/messages/count_tokens → passthrough ─────────
  const table = require("../../router/router-table.js");
  const route = table.findRoute("POST", "/v1/messages/count_tokens");
  A.ok(route, "route exists for /v1/messages/count_tokens");
  A.eq(route.handler, "passthrough", "handler is passthrough");
  A.eq(route.format, "anthropic", "format is anthropic");

  // ── 2. Request returns 200 with mock anthropic count payload ───────────
  ant.setHandler(({ req }) => {
    if (req.url === "/v1/messages/count_tokens") {
      return { status: 200, body: { input_tokens: 42 } };
    }
    return { status: 404, body: { error: "no" } };
  });

  const r = await M.httpRequest({
    method: "POST", host: "127.0.0.1", port, path: "/v1/messages/count_tokens",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  A.eq(r.status, 200, "/v1/messages/count_tokens → 200");
  const body = JSON.parse(r.body.toString("utf8"));
  A.eq(body.input_tokens, 42, "input_tokens echoed from upstream");

  // ── 3. Mock saw the request with full body ──────────────────────────────
  A.eq(ant.requests.length, 1, "anthropic mock saw exactly 1 request");
  const upReq = ant.requests[0];
  A.eq(upReq.method, "POST", "method preserved");
  A.eq(upReq.path, "/v1/messages/count_tokens", "path preserved");
  const upBody = JSON.parse(upReq.body.toString("utf8"));
  A.eq(upBody.model, "claude-3-5-sonnet-20241022", "model body preserved");
  A.eq(upBody.messages[0].content, "hello", "message body preserved");

  // ── 4. Auth header was forwarded ────────────────────────────────────────
  A.eq(upReq.headers["x-api-key"], "sk-ant-test", "x-api-key forwarded");

  // ── 5. Multiple consecutive count_tokens calls all succeed ──────────────
  for (let i = 0; i < 5; i++) {
    const ri = await M.httpRequest({
      method: "POST", host: "127.0.0.1", port, path: "/v1/messages/count_tokens",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
      body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "n=" + i }] }),
    });
    A.eq(ri.status, 200, `iter ${i}: 200`);
  }
  A.eq(ant.requests.length, 6, "anthropic mock saw 6 total requests");

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await new Promise((res) => httpServer.close(res));
  await ant.close();
  try { require("../../router/stats.js").close(); } catch {}
  try { require("../../router/prompt-cache.js").close(); } catch {}
  M.rmrf(SBX);
  try { await require("undici").getGlobalDispatcher().close(); } catch {}

  console.log(`\ncount-tokens.test: ${A.pass} passed, ${A.fail} failed`);
  process.exitCode = A.fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error("count-tokens.test crashed:", e);
  process.exitCode = 2;
});
