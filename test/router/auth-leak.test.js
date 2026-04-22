"use strict";

/**
 * auth-leak.test.js — Phase E full suite.
 *
 * Drives 100+ requests through the live router with secret API keys in
 * various headers, then scans the entire stats SQLite DB byte-for-byte to
 * confirm NO secret value or marker substring leaked into storage.
 *
 * Also extends the basic redactHeaders / hashRequest checks from the
 * Phase D smoke test (router/auth-leak.test.js).
 */

const fs = require("fs");
const path = require("path");
const M = require("./_mocks.js");

const SECRETS = [
  "sk-ant-api03-SUPER-SECRET-KEY-DO-NOT-LEAK-XYZ",
  "sk-proj-SUPER-SECRET-OPENAI-KEY-ABC123",
  "Bearer LONG-OAUTH-TOKEN-VALUE-987654321",
  "session=COOKIE-SECRET-VALUE.signed",
];
const MARKERS = [
  "SUPER-SECRET", "DO-NOT-LEAK", "COOKIE-SECRET", "LONG-OAUTH-TOKEN",
];

(async () => {
  const A = M.makeAssert();
  const SBX = M.sandboxDir("auth-leak");

  const ant = await M.mockAnthropic();
  const oai = await M.mockOpenAI();
  const oll = await M.mockOllama();

  process.env.ROUTER_DB_DIR = SBX;
  process.env.OLLAMA_URL = oll.url;
  process.env.ANTHROPIC_UPSTREAM_URL = ant.url;
  process.env.OPENAI_UPSTREAM_URL = oai.url;
  process.env.ANTHROPIC_API_KEY = SECRETS[0];
  process.env.OPENAI_API_KEY = SECRETS[1];
  process.env.ROUTER_MODE = "aggressive";

  M.clearRouterCache();
  const config = require("../../router/config.js");
  config.refreshRouterDir();
  config.reloadConfig();
  const upstream = require("../../router/upstream.js");
  upstream.refreshProviderUrls();

  const stats = require("../../router/stats.js");
  const cache = require("../../router/prompt-cache.js");

  const server = require("../../router/server.js");
  const wire = require("../../router/wire.js");
  wire.install();

  const httpServer = await server.start({ port: 0, warm: false });
  const port = httpServer.address().port;

  // ── 1. redactHeaders contract ───────────────────────────────────────────
  {
    const h = stats.redactHeaders({
      authorization: SECRETS[2],
      "x-api-key": SECRETS[0],
      "api-key": SECRETS[0],
      cookie: SECRETS[3],
      "proxy-authorization": SECRETS[2],
      "x-auth-token": SECRETS[2],
      "content-type": "application/json",
      "user-agent": "test-suite",
    });
    for (const k of ["authorization", "x-api-key", "api-key",
      "cookie", "proxy-authorization", "x-auth-token"]) {
      A.ok(!(k in h), `redactHeaders drops "${k}"`);
    }
    A.eq(h["content-type"], "application/json", "non-sensitive header preserved");
    A.eq(h["user-agent"], "test-suite", "user-agent preserved");
  }

  // ── 2. Drive 100 mixed requests with secret-bearing headers ─────────────
  const N = 100;
  const prompts = [
    "hello", "how are you", "what is 2+2", "summarize: the quick brown fox jumps",
    "translate to french: good morning", "write code: ", "explain monads",
  ];
  for (let i = 0; i < N; i++) {
    const p = prompts[i % prompts.length] + " (i=" + i + ")";
    const useAnthropic = i % 2 === 0;
    const r = await M.httpRequest({
      method: "POST", host: "127.0.0.1", port,
      path: useAnthropic ? "/v1/messages" : "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        "x-api-key": SECRETS[0],
        "authorization": SECRETS[2],
        "cookie": SECRETS[3],
        "user-agent": "auth-leak-test",
      },
      body: useAnthropic
        ? JSON.stringify({
            model: "claude-3-5-sonnet-20241022", max_tokens: 50,
            messages: [{ role: "user", content: p }],
          })
        : JSON.stringify({
            model: "gpt-4o-mini", max_tokens: 50,
            messages: [{ role: "user", content: p }],
          }),
    });
    if (!(r.status >= 200 && r.status < 600)) {
      A.ok(false, `i=${i}: bad status ${r.status}`);
    }
  }
  A.ok(true, `drove ${N} requests through the router`);

  // Force any pending writes to flush by closing/reopening
  // (better-sqlite3 is synchronous, so this should already be on disk)

  // ── 3. Byte-scan the stats DB for any secret or marker substring ────────
  const dbPath = stats.DB_PATH;
  A.ok(fs.existsSync(dbPath), `stats DB exists at ${dbPath}`);
  const dbBytes = fs.readFileSync(dbPath);
  const dbStr = dbBytes.toString("binary");
  for (const sec of SECRETS) {
    A.ok(!dbStr.includes(sec), `stats DB does NOT contain secret "${sec.slice(0, 24)}…"`);
  }
  for (const mk of MARKERS) {
    A.ok(!dbStr.includes(mk), `stats DB does NOT contain marker "${mk}"`);
  }

  // ── 4. Scan ALL .ai-router files for secrets (cache.db, .wal, .shm) ────
  const allFiles = fs.readdirSync(SBX).map((f) => path.join(SBX, f));
  for (const f of allFiles) {
    let bytes;
    try { bytes = fs.readFileSync(f); } catch { continue; }
    const s = bytes.toString("binary");
    for (const sec of SECRETS) {
      A.ok(!s.includes(sec), `${path.basename(f)}: no secret "${sec.slice(0, 16)}…"`);
    }
  }

  // ── 5. cache.hashRequest is volatile-field-stable ───────────────────────
  const a = cache.hashRequest({
    model: "x", messages: [{ role: "user", content: "hi" }],
    metadata: { user_id: "u1" }, user: "u1",
  });
  const b = cache.hashRequest({
    model: "x", messages: [{ role: "user", content: "hi" }],
    metadata: { user_id: "u2" }, user: "u2",
  });
  A.eq(a, b, "hashRequest ignores volatile per-user fields");

  // ── 6. config object frozen ─────────────────────────────────────────────
  A.ok(Object.isFrozen(config.getConfig()), "getConfig() frozen");

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await new Promise((res) => httpServer.close(res));
  await ant.close(); await oai.close(); await oll.close();
  try { stats.close(); } catch {}
  try { cache.close(); } catch {}
  M.rmrf(SBX);
  try { await require("undici").getGlobalDispatcher().close(); } catch {}

  console.log(`\nauth-leak.test: ${A.pass} passed, ${A.fail} failed`);
  process.exitCode = A.fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error("auth-leak.test crashed:", e);
  process.exitCode = 2;
});
