"use strict";

/**
 * Tests for router/model-registry.js — client-model-driven provider routing.
 *
 * Runner expectations (matches other router tests): a top-level object with
 * named `testX()` methods plus an exported `run()` driver. The harness in
 * test/router/run-all.js auto-discovers any file ending in `.test.js`.
 */

const assert = require("node:assert/strict");
const path = require("node:path");

// Reset the require cache for model-registry on each test so cache state is
// isolated. We also reset ollama.js to prevent a real fetch in _refreshOllamaList.
function freshRegistry() {
  const regPath = path.resolve(__dirname, "../../router/model-registry.js");
  const ollPath = path.resolve(__dirname, "../../router/ollama.js");
  delete require.cache[regPath];
  delete require.cache[ollPath];
  return require(regPath);
}

const tests = {

  "parseSuffix: no suffix returns cleanModel unchanged"() {
    const { parseSuffix } = freshRegistry();
    assert.deepEqual(parseSuffix("qwen3.6:latest"), { cleanModel: "qwen3.6:latest", provider: null });
    assert.deepEqual(parseSuffix("claude-3-5-sonnet"), { cleanModel: "claude-3-5-sonnet", provider: null });
  },

  "parseSuffix: @ollama @anthropic @openai are recognized"() {
    const { parseSuffix } = freshRegistry();
    assert.deepEqual(parseSuffix("qwen3.6:latest@ollama"),   { cleanModel: "qwen3.6:latest", provider: "ollama" });
    assert.deepEqual(parseSuffix("claude-opus-4@anthropic"), { cleanModel: "claude-opus-4", provider: "anthropic" });
    assert.deepEqual(parseSuffix("gpt-4o@openai"),           { cleanModel: "gpt-4o", provider: "openai" });
  },

  "parseSuffix: @local / @vllm normalize to openai-local"() {
    const { parseSuffix } = freshRegistry();
    assert.deepEqual(parseSuffix("Qwen2.5-72B@local"), { cleanModel: "Qwen2.5-72B", provider: "openai-local" });
    assert.deepEqual(parseSuffix("mistral@vllm"),      { cleanModel: "mistral", provider: "openai-local" });
    assert.deepEqual(parseSuffix("x@openai-local"),    { cleanModel: "x", provider: "openai-local" });
  },

  "parseSuffix: unknown / malformed suffixes are rejected"() {
    const { parseSuffix } = freshRegistry();
    assert.deepEqual(parseSuffix("foo@nonsense"),      { cleanModel: "foo@nonsense", provider: null });
    assert.deepEqual(parseSuffix("foo@"),              { cleanModel: "foo@", provider: null });
    assert.deepEqual(parseSuffix("@ollama"),           { cleanModel: "@ollama", provider: null });
    // Injection attempt: suffix must be [a-z0-9-]{1,32}.
    assert.deepEqual(parseSuffix("x@ollama;rm -rf /"), { cleanModel: "x@ollama;rm -rf /", provider: null });
    assert.deepEqual(parseSuffix("x@" + "a".repeat(33)), { cleanModel: "x@" + "a".repeat(33), provider: null });
  },

  "detect: null/empty model returns null"() {
    const { detectProviderFromModel } = freshRegistry();
    assert.equal(detectProviderFromModel(null), null);
    assert.equal(detectProviderFromModel(""), null);
    assert.equal(detectProviderFromModel("   "), null);
    assert.equal(detectProviderFromModel(42), null);
  },

  "detect: claude-* routes to anthropic"() {
    const { detectProviderFromModel } = freshRegistry();
    const r = detectProviderFromModel("claude-3-5-sonnet-20241022");
    assert.equal(r.provider, "anthropic");
    assert.equal(r.cleanModel, "claude-3-5-sonnet-20241022");
  },

  "detect: gpt-* / o1 / o3 route to openai"() {
    const { detectProviderFromModel } = freshRegistry();
    assert.equal(detectProviderFromModel("gpt-4o").provider, "openai");
    assert.equal(detectProviderFromModel("gpt-4o-mini").provider, "openai");
    assert.equal(detectProviderFromModel("o1-preview").provider, "openai");
    assert.equal(detectProviderFromModel("o3-mini").provider, "openai");
    assert.equal(detectProviderFromModel("chatgpt-4o-latest").provider, "openai");
  },

  "detect: installed ollama model wins over heuristics"() {
    const reg = freshRegistry();
    reg._internals.setOllamaList(["qwen3.6:latest", "llama3.2:3b"]);
    const r = reg.detectProviderFromModel("qwen3.6:latest");
    assert.equal(r.provider, "ollama");
    assert.equal(r.cleanModel, "qwen3.6:latest");
  },

  "detect: bare name resolves to :latest when installed"() {
    const reg = freshRegistry();
    reg._internals.setOllamaList(["qwen3.6:latest"]);
    const r = reg.detectProviderFromModel("qwen3.6");
    assert.equal(r.provider, "ollama");
  },

  "detect: fallback tag pattern only fires when list is unavailable"() {
    const reg = freshRegistry();
    reg._internals.clearOllamaCache();
    // No list → tag pattern fires. Use a tag pattern that doesn't trigger the
    // async refresh (the call WILL schedule one, but that's fine for this
    // unit test — it fails silently if Ollama isn't reachable).
    const r = reg.detectProviderFromModel("my-custom:v1");
    assert.ok(r, "expected a detection when list unavailable and pattern matches");
    assert.equal(r.provider, "ollama");
  },

  "detect: unknown name with no tag returns null"() {
    const reg = freshRegistry();
    reg._internals.setOllamaList([]);
    assert.equal(reg.detectProviderFromModel("mysterious-model"), null);
  },

  "detect: allowHeuristic=false only matches list + suffix"() {
    const reg = freshRegistry();
    reg._internals.setOllamaList([]);
    assert.equal(reg.detectProviderFromModel("claude-opus-4", { allowHeuristic: false }), null);
    assert.equal(reg.detectProviderFromModel("gpt-4o", { allowHeuristic: false }), null);
    // Suffix still wins:
    assert.equal(reg.detectProviderFromModel("gpt-4o@openai", { allowHeuristic: false }).provider, "openai");
  },
};

async function run() {
  let pass = 0, fail = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      pass++;
      console.log(`  \u2714 ${name}`);
    } catch (e) {
      fail++;
      console.log(`  \u2718 ${name} — ${e.message}`);
    }
  }
  return { pass, fail };
}

if (require.main === module) {
  run().then(({ pass, fail }) => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });
}

module.exports = { run, tests };
