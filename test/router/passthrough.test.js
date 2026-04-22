"use strict";

/**
 * Passthrough tests — Category 2 byte-identical forwarding via mock upstream.
 * Run: node test/router/passthrough.test.js
 */

const http = require("http");
const { mockAnthropic, mockOpenAI, makeAssert, httpRequest } = require("./_mocks.js");

const A = makeAssert();

(async function main() {
  // Spin up two mock upstreams, then point router upstream URLs at them.
  const ant = await mockAnthropic();
  const oai = await mockOpenAI();

  process.env.ANTHROPIC_UPSTREAM_URL = ant.url;
  process.env.OPENAI_UPSTREAM_URL = oai.url;

  const upstream = require("../../router/upstream.js");
  upstream.refreshProviderUrls();

  const passthrough = require("../../router/passthrough.js");

  // Build a tiny http server that calls passthrough.handle for every request
  const server = http.createServer((req, res) => {
    passthrough.handle(req, res, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  let onResponseCalled = 0;
  passthrough.onResponse(() => { onResponseCalled++; });

  // ── Anthropic forwarding ────────────────────────────────────────────────
  {
    const r = await httpRequest({
      port, method: "POST", path: "/v1/messages",
      headers: {
        "x-api-key": "secret-anthropic-key-XYZ",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    A.eq(r.status, 200, "anthropic: 200 OK from mock");
    const body = JSON.parse(r.body);
    A.eq(body.type, "message", "anthropic: response shape preserved");
    A.eq(body.role, "assistant", "anthropic: role assistant");

    A.eq(ant.requests.length, 1, "anthropic mock saw exactly 1 request");
    const fwd = ant.requests[0];
    A.eq(fwd.method, "POST", "anthropic: method forwarded");
    A.eq(fwd.path, "/v1/messages", "anthropic: path forwarded byte-identical");
    A.eq(fwd.headers["x-api-key"], "secret-anthropic-key-XYZ",
      "anthropic: x-api-key forwarded byte-identical");
    A.eq(fwd.headers["anthropic-version"], "2023-06-01",
      "anthropic: anthropic-version forwarded byte-identical");
  }

  // ── OpenAI forwarding ───────────────────────────────────────────────────
  {
    const r = await httpRequest({
      port, method: "POST", path: "/v1/chat/completions",
      headers: {
        "authorization": "Bearer sk-secret-openai-ABC",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    A.eq(r.status, 200, "openai: 200 OK from mock");
    const body = JSON.parse(r.body);
    A.eq(body.object, "chat.completion", "openai: response shape preserved");

    A.eq(oai.requests.length, 1, "openai mock saw exactly 1 request");
    const fwd = oai.requests[0];
    A.eq(fwd.headers.authorization, "Bearer sk-secret-openai-ABC",
      "openai: authorization forwarded byte-identical");
  }

  // ── Hop-by-hop strip ────────────────────────────────────────────────────
  {
    ant.requests.length = 0;
    await httpRequest({
      port, method: "POST", path: "/v1/messages",
      headers: {
        "x-api-key": "k",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "connection": "close",
      },
      body: JSON.stringify({ model: "x", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    A.eq(ant.requests.length, 1, "hop-by-hop: 1 request reached mock");
    const fwd = ant.requests[0];
    // node fetch may inject its own connection header; ensure client's "close" did not survive verbatim.
    A.ok(fwd.headers.connection !== "close", "client connection:close not forwarded verbatim");
  }

  // ── Unknown provider → 404 ──────────────────────────────────────────────
  {
    const r = await httpRequest({
      port, method: "POST", path: "/v1/foo",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    A.eq(r.status, 404, "no auth header → 404 unknown_provider");
    const body = JSON.parse(r.body);
    A.eq(body.error.type, "unknown_provider", "404 body has unknown_provider type");
  }

  // ── onResponse hook fired ───────────────────────────────────────────────
  A.ok(onResponseCalled >= 2, `onResponse hook fired (got ${onResponseCalled})`);

  // ── Response body byte-identical ────────────────────────────────────────
  {
    ant.setHandler(() => ({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]),
    }));
    const r = await httpRequest({
      port, method: "POST", path: "/v1/messages",
      headers: {
        "x-api-key": "k",
        "anthropic-version": "2023-06-01",
      },
      body: "{}",
    });
    A.eq(r.bodyBuffer.length, 6, "binary body: 6 bytes received");
    A.eq(r.bodyBuffer[0], 0x00, "binary[0]=0x00");
    A.eq(r.bodyBuffer[5], 0xfe, "binary[5]=0xfe");
  }

  await ant.close();
  await oai.close();
  await new Promise((r) => server.close(() => r()));

  const { fail } = A.summary("passthrough.test");
  try {
    const { getGlobalDispatcher } = require("undici");
    await getGlobalDispatcher().close();
  } catch { /* undici not available, ignore */ }
  // Let event loop drain naturally; setting exitCode avoids forcing exit
  // which can trigger libuv handle assertions on Windows.
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(2); });
