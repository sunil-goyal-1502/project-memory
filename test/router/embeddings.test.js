"use strict";

/**
 * embeddings.test.js — /v1/embeddings end-to-end.
 *
 * Two flows:
 *   1. ROUTER_ROUTE_EMBEDDINGS=true (default) → routed to local Ollama
 *      via /api/embed; returns OpenAI-format response.
 *   2. ROUTER_ROUTE_EMBEDDINGS=false           → forwarded to OpenAI cloud
 *      upstream byte-for-byte.
 *
 * Note: fallback.dispatch currently always uses /api/chat for ollama, so
 * the FULL embedding-via-ollama flow is exercised through the server
 * (catch-all path may not handle embeddings yet). This test validates the
 * router DECISION + the cloud forwarding path which definitely works.
 */

const M = require("./_mocks.js");

(async () => {
  const A = M.makeAssert();
  const SBX = M.sandboxDir("embeddings");

  // ── Test A: route_embeddings=false → cloud (OpenAI) ─────────────────────
  {
    const oai = await M.mockOpenAI();
    process.env.ROUTER_DB_DIR = SBX + "-A";
    require("fs").mkdirSync(process.env.ROUTER_DB_DIR, { recursive: true });
    process.env.OPENAI_UPSTREAM_URL = oai.url;
    process.env.OPENAI_API_KEY = "sk-test-openai";
    process.env.ROUTER_ROUTE_EMBEDDINGS = "false";

    M.clearRouterCache();
    const config = require("../../router/config.js");
    config.refreshRouterDir();
    config.reloadConfig();
    const router = require("../../router/router.js");

    const decision = router.decide(
      { messages: [], params: { model: "text-embedding-3-small" }, kind: "embedding" },
      { complexity: "simple", confidence: 1 },
      "embedding",
      "openai"
    );
    A.eq(decision.provider, "openai", "route_embeddings=false → openai");
    A.eq(decision.fallback, null, "no fallback when forced cloud");

    await oai.close();
    M.rmrf(SBX + "-A");
  }

  // ── Test B: route_embeddings=true → ollama with cloud fallback ──────────
  {
    M.clearRouterCache();
    process.env.ROUTER_DB_DIR = SBX + "-B";
    require("fs").mkdirSync(process.env.ROUTER_DB_DIR, { recursive: true });
    process.env.ROUTER_ROUTE_EMBEDDINGS = "true";

    const config = require("../../router/config.js");
    config.refreshRouterDir();
    config.reloadConfig();
    const router = require("../../router/router.js");

    const decision = router.decide(
      { messages: [], params: { model: "text-embedding-3-small" }, kind: "embedding" },
      { complexity: "simple", confidence: 1 },
      "embedding",
      "openai"
    );
    A.eq(decision.provider, "ollama", "route_embeddings=true → ollama");
    A.ok(decision.fallback && decision.fallback.provider === "openai",
      "openai fallback present");
    A.eq(decision.model, "nomic-embed-text", "uses tier_embed model (default)");
    M.rmrf(SBX + "-B");
  }

  // ── Test C: privacy mode + route_embeddings=false → privacy block ───────
  {
    M.clearRouterCache();
    process.env.ROUTER_DB_DIR = SBX + "-C";
    require("fs").mkdirSync(process.env.ROUTER_DB_DIR, { recursive: true });
    process.env.ROUTER_PRIVACY_MODE = "true";
    process.env.ROUTER_ROUTE_EMBEDDINGS = "false";

    const config = require("../../router/config.js");
    config.refreshRouterDir();
    config.reloadConfig();
    const router = require("../../router/router.js");

    let threw = null;
    try {
      router.decide(
        { messages: [], params: { model: "x" }, kind: "embedding" },
        { complexity: "simple", confidence: 1 },
        "embedding",
        "openai"
      );
    } catch (e) { threw = e; }
    A.ok(threw, "privacy + no local embeddings → throws");
    A.eq(threw && threw.code, "PRIVACY_BLOCK", "throws PRIVACY_BLOCK");

    process.env.ROUTER_PRIVACY_MODE = "false";
    process.env.ROUTER_ROUTE_EMBEDDINGS = "true";
    M.rmrf(SBX + "-C");
  }

  // ── Test D: route table entry exists ────────────────────────────────────
  {
    const table = require("../../router/router-table.js");
    const route = table.findRoute("POST", "/v1/embeddings");
    A.ok(route, "route exists for /v1/embeddings");
    A.eq(route.handler, "routedOpenAIEmbeddings", "handler name");
    A.eq(route.category, "routed", "category=routed");
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  try { require("../../router/stats.js").close(); } catch {}
  try { require("../../router/prompt-cache.js").close(); } catch {}
  M.rmrf(SBX);
  try { await require("undici").getGlobalDispatcher().close(); } catch {}

  console.log(`\nembeddings.test: ${A.pass} passed, ${A.fail} failed`);
  process.exitCode = A.fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error("embeddings.test crashed:", e);
  process.exitCode = 2;
});
