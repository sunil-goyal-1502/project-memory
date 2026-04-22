"use strict";

/**
 * Prompt cache tests — exact match, semantic match, TTL, eviction, normalization,
 * confidence gate, streaming exclusion, volatile field stripping.
 *
 * Run: node test/router/prompt-cache.test.js
 */

const { sandboxDir, rmrf, makeAssert, sleep } = require("./_mocks.js");

const SBX = sandboxDir("prompt-cache");
process.env.ROUTER_DB_DIR = SBX;
const config = require("../../router/config.js");
config.refreshRouterDir();

const cache = require("../../router/prompt-cache.js");
const A = makeAssert();

// Deterministic embedder: hashes text → 8-dim vector
function fakeEmbed(text) {
  const v = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[i % 8] += text.charCodeAt(i) / 1000;
  }
  return v;
}

(async function main() {
  cache.clear();

  const baseReq = {
    model: "claude",
    messages: [{ role: "user", content: "What is the capital of France?" }],
    params: { temperature: 0 },
  };
  const baseResp = { content: "Paris" };

  // ── Streaming requests must NOT cache ────────────────────────────────────
  {
    const ok = await cache.set({
      request: { ...baseReq, stream: true },
      response: baseResp,
      format: "anthropic",
      confident: true,
    });
    A.eq(ok, false, "streaming requests are not cached");
  }

  // ── Confidence gate ──────────────────────────────────────────────────────
  {
    const ok = await cache.set({
      request: baseReq, response: baseResp,
      format: "anthropic", confident: false,
    });
    A.eq(ok, false, "confident:false is rejected (no poisoning)");
    const miss = await cache.get(baseReq);
    A.eq(miss, null, "low-confidence write produced no row");
  }

  // ── Exact match ──────────────────────────────────────────────────────────
  {
    await cache.set({
      request: baseReq, response: baseResp,
      format: "anthropic", confident: true,
      prompt_tokens: 10, completion_tokens: 1,
    });
    const hit = await cache.get(baseReq);
    A.ok(hit, "exact match: hit returned");
    A.eq(hit.hit, "exact", "exact match: hit type");
    A.eq(hit.response.content, "Paris", "exact match: response payload");
    A.eq(hit.prompt_tokens, 10, "exact match: prompt_tokens preserved");
    A.eq(hit.completion_tokens, 1, "exact match: completion_tokens preserved");
  }

  // ── Hash determinism / volatile-field stripping ─────────────────────────
  {
    const hashA = cache.hashRequest(baseReq);
    const hashB = cache.hashRequest({
      ...baseReq, user: "alice",  // OpenAI per-user telemetry — should be stripped
      metadata: { user_id: "u1" }, // anthropic metadata — should be stripped
    });
    A.eq(hashA, hashB, "hashRequest strips volatile fields (user, metadata.user_id)");
    const hashC = cache.hashRequest({ ...baseReq, model: "claude-3" });
    A.ok(hashA !== hashC, "different model → different hash");
  }

  // ── normalizeRequest is order-stable ─────────────────────────────────────
  {
    const a = cache.normalizeRequest({ a: 1, b: 2, c: 3 });
    const b = cache.normalizeRequest({ c: 3, b: 2, a: 1 });
    A.eq(a, b, "normalizeRequest sort-stable across key order");
  }

  // ── Semantic match ───────────────────────────────────────────────────────
  cache.clear();
  cache.setEmbedder(fakeEmbed);

  await cache.set({
    request: {
      model: "claude",
      messages: [{ role: "user", content: "What is the capital of France?" }],
      params: { temperature: 0 },
    },
    response: { content: "Paris" },
    format: "anthropic",
    confident: true,
  });

  {
    // identical phrasing variant — embeddings will be very close
    const sim = await cache.get({
      model: "claude-different",  // changes hash so exact won't hit
      messages: [{ role: "user", content: "What is the capital of France?" }],
      params: { temperature: 0 },
    });
    A.ok(sim, "semantic match returns hit when query is identical text");
    A.eq(sim.hit, "semantic", "semantic hit type");
    A.ok(sim.similarity >= 0.92, `semantic similarity ≥ threshold (got ${sim?.similarity})`);
  }

  {
    // distinctly different topic should NOT semantic-match (8-dim cosine still likely <0.92)
    const miss = await cache.get({
      model: "claude-different",
      messages: [{ role: "user", content: "Z" }],
      params: { temperature: 0 },
    });
    A.eq(miss, null, "very different short text → no semantic match");
  }

  // skipSemantic option
  {
    const miss = await cache.get({
      model: "claude-different",
      messages: [{ role: "user", content: "What is the capital of France?" }],
      params: { temperature: 0 },
    }, { skipSemantic: true });
    A.eq(miss, null, "skipSemantic:true bypasses semantic layer");
  }

  // ── cosine util sanity ───────────────────────────────────────────────────
  {
    const a = [1, 0, 0]; const b = [1, 0, 0]; const c = [0, 1, 0];
    A.ok(Math.abs(cache.cosine(a, b) - 1) < 1e-6, "cosine identical = 1");
    A.eq(cache.cosine(a, c), 0, "cosine orthogonal = 0");
    A.eq(cache.cosine([], []), 0, "cosine empty = 0");
    A.eq(cache.cosine([1], [1, 2]), 0, "cosine length mismatch = 0");
  }

  // ── lastUserMessage extraction ──────────────────────────────────────────
  {
    A.eq(cache.lastUserMessage({ messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
      { role: "user", content: "ok" },
    ] }), "ok", "lastUserMessage returns last user");
    A.eq(cache.lastUserMessage({ messages: [
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }
    ] }), "a\nb", "lastUserMessage flattens array content");
    A.eq(cache.lastUserMessage({}), "", "lastUserMessage missing → ''");
  }

  // ── LRU eviction (pruneToMaxRows) ────────────────────────────────────────
  cache.clear();
  for (let i = 0; i < 10; i++) {
    await cache.set({
      request: { model: "m", messages: [{ role: "user", content: "Q" + i }], params: {} },
      response: { content: "A" + i },
      format: "anthropic",
      confident: true,
    });
  }
  A.eq(cache.stats().total, 10, "10 rows inserted");
  const removed = cache.pruneToMaxRows(5);
  A.eq(removed, 5, "pruneToMaxRows(5) removed 5 rows");
  A.eq(cache.stats().total, 5, "5 rows remain");

  // ── TTL expiry ────────────────────────────────────────────────────────────
  cache.clear();
  process.env.ROUTER_CACHE_TTL_HOURS = "1e-9"; // ~3.6 microsec
  config.reloadConfig();
  await cache.set({
    request: baseReq, response: baseResp,
    format: "anthropic", confident: true,
  });
  await sleep(20);
  const expired = await cache.get(baseReq);
  A.eq(expired, null, "TTL expired → miss + row deleted");
  delete process.env.ROUTER_CACHE_TTL_HOURS;
  config.reloadConfig();

  cache.close();
  rmrf(SBX);

  const { fail } = A.summary("prompt-cache.test");
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(2); });
