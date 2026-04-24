"use strict";

/**
 * Router decision tests.
 * decide(commonRequest, classification, kind, format) — covers all 4 modes
 * × {simple, medium, complex} × {chat, embedding} × {anthropic, openai}.
 *
 * Run: node test/router/router.test.js
 */

const path = require("path");
const { makeAssert } = require("./_mocks.js");

// We need to vary config.router_mode per case. Easiest: monkey-patch config.getConfig.
const configPath = require.resolve("../../router/config.js");
const realConfig = require("../../router/config.js");

let _override = {};
// These tests exercise tier/mode/classification logic. Client-model routing
// is a separate feature with its own tests — disable it globally here so the
// heuristic (claude-* → anthropic) doesn't short-circuit the tier picks.
function setConfig(o) { _override = { router_respect_client_model: false, ...o }; }

require.cache[configPath].exports = {
  ...realConfig,
  getConfig: () => Object.freeze({ ...realConfig.getConfig(), ..._override }),
};

const router = require("../../router/router.js");
const A = makeAssert();

function classification(complexity, opts = {}) {
  return {
    complexity,
    confidence: opts.confidence ?? 0.9,
    reasons: opts.reasons || [],
    heuristicScore: opts.heuristicScore ?? 0.5,
  };
}

function chatReq(extras = {}) {
  return {
    messages: [{ role: "user", content: extras.content || "hello" }],
    tools: extras.tools || null,
    params: extras.params || { model: extras.model || "claude-3-5-sonnet" },
    system: null,
  };
}

// ── Mode × complexity × format matrix ─────────────────────────────────────

const MODES = ["aggressive", "balanced", "conservative", "disabled"];
const COMPLEXITIES = ["simple", "medium", "complex"];
const FORMATS = ["anthropic", "openai", "responses"];

for (const mode of MODES) {
  for (const cx of COMPLEXITIES) {
    for (const fmt of FORMATS) {
      setConfig({ router_mode: mode, router_privacy_mode: false, router_respect_client_model: false });
      const d = router.decide(chatReq(), classification(cx), "chat", fmt);
      const cloud = fmt === "anthropic" ? "anthropic" : "openai";

      let expectedLocal;
      if (mode === "disabled") expectedLocal = false;
      else if (mode === "aggressive") expectedLocal = (cx !== "complex");
      else if (mode === "conservative") expectedLocal = (cx === "simple");
      else expectedLocal = (cx === "simple"); // balanced

      const expectedProvider = expectedLocal ? "ollama" : cloud;
      A.eq(d.provider, expectedProvider,
        `mode=${mode} cx=${cx} fmt=${fmt} → provider=${expectedProvider}`);

      // Local picks always have a fallback (unless privacy)
      if (expectedLocal) {
        A.ok(d.fallback && d.fallback.provider === cloud,
          `local pick has cloud fallback (${cloud})`);
      } else {
        A.eq(d.fallback, null, `cloud pick has no fallback (mode=${mode} cx=${cx})`);
      }
    }
  }
}

// ── Embeddings routing ─────────────────────────────────────────────────────
{
  setConfig({ router_mode: "balanced", router_route_embeddings: true, router_privacy_mode: false });
  const d = router.decide(chatReq(), classification("simple"), "embedding", "openai");
  A.eq(d.provider, "ollama", "embedding routes to ollama when route_embeddings=true");
  A.ok(d.fallback && d.fallback.provider === "openai", "embedding has cloud fallback");
}

{
  setConfig({ router_mode: "balanced", router_route_embeddings: false });
  const d = router.decide(chatReq(), classification("simple"), "embedding", "openai");
  A.eq(d.provider, "openai", "embedding → cloud when route_embeddings=false");
}

// ── Code-heuristic upgrade to TIER_CODE ────────────────────────────────────
{
  setConfig({ router_mode: "aggressive", router_privacy_mode: false,
    tier_simple: "llama3.2:3b", tier_code: "qwen2.5-coder:7b" });
  const d = router.decide(
    chatReq({ content: "Explain this:\n\n```js\nconst x=1;\n```" }),
    classification("simple", { reasons: ["top signals: codeBlocks(1.5)"] }),
    "chat", "openai"
  );
  A.eq(d.provider, "ollama", "code-heavy still routes local");
  A.eq(d.model, "qwen2.5-coder:7b", "code-heavy upgrades to tier_code");
  A.ok(/code-heavy/i.test(d.reason), "decision reason mentions code-heavy");
}

// ── Privacy mode ───────────────────────────────────────────────────────────
{
  setConfig({ router_mode: "balanced", router_privacy_mode: true });
  // simple → local; fallback should be null
  const d = router.decide(chatReq(), classification("simple"), "chat", "anthropic");
  A.eq(d.provider, "ollama", "privacy: simple still local");
  A.eq(d.fallback, null, "privacy: no cloud fallback");
}

{
  setConfig({ router_mode: "balanced", router_privacy_mode: true });
  let threw = null;
  try {
    router.decide(chatReq(), classification("complex"), "chat", "anthropic");
  } catch (e) { threw = e; }
  A.ok(threw && threw.code === "PRIVACY_BLOCK",
    "privacy: cloud-primary throws PRIVACY_BLOCK");
}

{
  // Privacy + disabled mode → also blocked
  setConfig({ router_mode: "disabled", router_privacy_mode: true });
  let threw = null;
  try { router.decide(chatReq(), classification("simple"), "chat", "openai"); }
  catch (e) { threw = e; }
  A.ok(threw && threw.code === "PRIVACY_BLOCK",
    "privacy + disabled → blocks cloud");
}

// ── Conservative + tools = always cloud ────────────────────────────────────
{
  setConfig({ router_mode: "conservative", router_privacy_mode: false });
  const d = router.decide(
    chatReq({ tools: [{ name: "x" }] }),
    classification("simple"),
    "chat", "anthropic"
  );
  A.eq(d.provider, "anthropic", "conservative + tools → cloud");
}

// ── Aggressive + medium = local ────────────────────────────────────────────
{
  setConfig({ router_mode: "aggressive" });
  const d = router.decide(chatReq(), classification("medium"), "chat", "openai");
  A.eq(d.provider, "ollama", "aggressive + medium → local");
}

// ── Cloud provider derivation from format ──────────────────────────────────
A.eq(router.cloudProviderForFormat("anthropic"), "anthropic", "fmt anthropic → anthropic");
A.eq(router.cloudProviderForFormat("openai"),    "openai",    "fmt openai → openai");
A.eq(router.cloudProviderForFormat("responses"), "openai",    "fmt responses → openai");
A.eq(router.cloudProviderForFormat("xyz"),       "openai",    "unknown fmt → openai default");

const { fail } = A.summary("router.test");
process.exit(fail === 0 ? 0 : 1);
