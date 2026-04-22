"use strict";

/**
 * Classifier tests — covers all pipeline branches.
 * - Pure heuristic path (simple, complex)
 * - Borderline → semantic path (semantic mocked out)
 * - Force-complex guardrails
 * - Embedding short-circuit
 * - Tool-count guardrail (>1)
 *
 * Semantic classifier is monkey-patched in require.cache to avoid loading
 * the ONNX model.
 *
 * Run: node test/router/classifier.test.js
 */

const path = require("path");
const Module = require("module");
const { makeAssert } = require("./_mocks.js");

// Inject a fake semantic classifier BEFORE classifier.js is required.
const semPath = require.resolve("../../router/semantic-classifier.js");
let semCalls = 0;
let semStub = async () => ({
  category: "complex",
  confidence: 0.5,
  scores: { simple: 0.3, complex: 0.7 },
});
require.cache[semPath] = {
  id: semPath,
  filename: semPath,
  loaded: true,
  exports: {
    classify: async (text) => { semCalls++; return semStub(text); },
    warmup: async () => {},
    SIMPLE_REFS: [], COMPLEX_REFS: [],
  },
};

const classifier = require("../../router/classifier.js");

const A = makeAssert();

(async function main() {

  // 1. Pure heuristic — simple
  {
    semCalls = 0;
    const r = await classifier.classify({
      messages: [{ role: "user", content: "Hi!" }],
      params: {},
    });
    A.eq(r.complexity, "simple", "pure heuristic: 'Hi!' → simple");
    A.eq(semCalls, 0, "pure heuristic path doesn't call semantic");
    A.ok(r.confidence >= 0 && r.confidence <= 1, "confidence in [0,1]");
  }

  // 2. Pure heuristic — complex (force-complex via diff)
  {
    semCalls = 0;
    const r = await classifier.classify({
      messages: [{ role: "user", content: "Apply:\n\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b" }],
      params: {},
    });
    A.eq(r.complexity, "complex", "force-complex (diff) → complex");
    A.eq(r.forced, true, "forced flag set");
    A.eq(semCalls, 0, "force-complex skips semantic");
  }

  // 3. Borderline → semantic (semantic returns complex)
  {
    semCalls = 0;
    semStub = async () => ({ category: "complex", confidence: 0.7,
      scores: { simple: 0.2, complex: 0.8 } });
    const r = await classifier.classify({
      messages: [{ role: "user",
        content: "Walk me through how Promises work in JavaScript and analyze why this code logs in an unexpected order.\n\n```js\nPromise.resolve().then(()=>console.log('a'));\nconsole.log('b');\n```",
      }],
      params: { temperature: 0.8 },
    });
    A.eq(semCalls, 1, "borderline → semantic was invoked once");
    A.ok(r.semanticScore, "semanticScore populated on borderline path");
    A.ok(r.complexity === "complex" || r.complexity === "medium",
      `borderline+semantic complex → complex/medium (got ${r.complexity})`);
  }

  // 4. Borderline → semantic (semantic says simple → blended → could be simple/medium)
  {
    semCalls = 0;
    semStub = async () => ({ category: "simple", confidence: 0.6,
      scores: { simple: 0.85, complex: 0.15 } });
    const r = await classifier.classify({
      messages: [{ role: "user",
        content: "Walk me through how Promises work in JavaScript and analyze why this code logs in an unexpected order.\n\n```js\nPromise.resolve().then(()=>console.log('a'));\nconsole.log('b');\n```",
      }],
      params: { temperature: 0.8 },
    });
    A.eq(semCalls, 1, "borderline path again invokes semantic");
    A.ok(["simple", "medium"].includes(r.complexity),
      `semantic-simple should pull blend toward simple/medium (got ${r.complexity})`);
  }

  // 5. Embedding short-circuit
  {
    semCalls = 0;
    const r = await classifier.classify({
      kind: "embedding",
      messages: [{ role: "user", content: "any text" }],
      params: {},
    });
    A.eq(r.complexity, "simple", "embedding kind → simple");
    A.eq(r.confidence, 1, "embedding kind → confidence 1");
    A.eq(semCalls, 0, "embedding skips semantic");
  }

  // 6. tools.length > 1 guardrail (must override even simple-leaning)
  {
    const r = await classifier.classify({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "a" }, { name: "b" }],
      params: {},
    });
    A.eq(r.complexity, "complex", "tools.length>1 → forced complex");
    A.eq(r.confidence, 1, "tool-guardrail confidence = 1");
  }

  // 7. tools.length === 1 should NOT trigger guardrail (only contributes to score)
  {
    const r = await classifier.classify({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "a" }],
      params: {},
    });
    A.ok(r.complexity !== "complex" || r.heuristicScore >= 0.7,
      "single tool alone does not force complex unless score warrants");
  }

  // 8. Semantic failure → graceful fallback
  {
    semStub = async () => { throw new Error("semantic blew up"); };
    const r = await classifier.classify({
      messages: [{ role: "user",
        content: "Walk me through how Promises work in JavaScript and analyze why this code logs in an unexpected order.\n\n```js\nPromise.resolve().then(()=>console.log('a'));\nconsole.log('b');\n```",
      }],
      params: { temperature: 0.8 },
    });
    A.ok(["medium", "complex", "simple"].includes(r.complexity),
      "semantic crash → still returns a complexity");
    A.ok(r.reasons.some((s) => /semantic failed/i.test(s)),
      "reasons mention semantic failure");
  }

  // 9. Unparseable request → safe complex default
  {
    const r = await classifier.classify(null);
    A.eq(r.complexity, "complex", "null request → complex");
    A.eq(r.confidence, 1, "null request → confidence 1");
  }

  const { fail } = A.summary("classifier.test");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
