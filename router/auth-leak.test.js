"use strict";

/**
 * Auth-leak smoke test for stats.js.
 * Confirms sensitive header values never appear in the SQLite DB.
 *
 * Phase D minimal assertion. Phase E adds the full suite.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// Use a sandbox dir to avoid touching the real ~/.ai-router
const SANDBOX = path.join(os.tmpdir(), "ai-router-test-" + process.pid);
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
fs.mkdirSync(SANDBOX, { recursive: true });

// Force a fresh require so config/stats pick up the sandboxed HOME
for (const k of Object.keys(require.cache)) {
  if (k.includes(path.sep + "router" + path.sep)) delete require.cache[k];
}

const stats = require("./stats.js");
const cache = require("./prompt-cache.js");
const config = require("./config.js");

const SECRET = "sk-ant-api03-SUPER-SECRET-KEY-DO-NOT-LEAK-XYZ";
const COOKIE_SECRET = "session=abc.SECRET-COOKIE.def";

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("PASS:", msg);
}

// 1. redactHeaders strips sensitive keys
{
  const h = stats.redactHeaders({
    authorization: `Bearer ${SECRET}`,
    "x-api-key": SECRET,
    cookie: COOKIE_SECRET,
    "content-type": "application/json",
    "user-agent": "test",
  });
  assert(!("authorization" in h), "redactHeaders drops authorization");
  assert(!("x-api-key" in h), "redactHeaders drops x-api-key");
  assert(!("cookie" in h), "redactHeaders drops cookie");
  assert(h["content-type"] === "application/json", "redactHeaders keeps non-sensitive");
}

// 2. record() never persists header data — write a request, scan DB
stats.record({
  format: "anthropic",
  endpoint: "/v1/messages",
  category: "routed",
  classification: "simple",
  provider: "ollama",
  model: "llama3.2:3b",
  prompt_tokens: 10,
  completion_tokens: 20,
  latency_ms: 42,
  fallback: 0,
  cache_hit: null,
  error: null,
});

const dbBytes = fs.readFileSync(stats.DB_PATH);
const dbStr = dbBytes.toString("binary");
assert(!dbStr.includes(SECRET), "stats DB does not contain API key");
assert(!dbStr.includes("SUPER-SECRET"), "stats DB does not contain secret marker");
assert(!dbStr.includes("SECRET-COOKIE"), "stats DB does not contain cookie value");

// 3. Even if a buggy caller passes an `error` field containing a secret,
//    we want it stored only as the error string (caller bug). Verify the
//    explicit fields don't auto-pull from headers.
stats.record({
  format: "openai",
  endpoint: "/v1/chat/completions",
  error: "upstream 500",
  // these extra fields should be ignored — record() only takes the schema
  authorization: `Bearer ${SECRET}`,
  headers: { authorization: `Bearer ${SECRET}` },
});
const after = fs.readFileSync(stats.DB_PATH).toString("binary");
assert(!after.includes(SECRET), "stats DB still clean after malicious caller");

// 4. cache hashing is deterministic regardless of volatile fields
const a = cache.hashRequest({
  model: "x", messages: [{ role: "user", content: "hi" }],
  metadata: { user_id: "u1" }, user: "u1",
});
const b = cache.hashRequest({
  model: "x", messages: [{ role: "user", content: "hi" }],
  metadata: { user_id: "u2" }, user: "u2",
});
assert(a === b, "hashRequest ignores volatile fields");

// 5. config returns a frozen object
const cfg = config.getConfig();
assert(Object.isFrozen(cfg), "getConfig() returns frozen object");

// Cleanup
stats.close();
cache.close();
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}

console.log("");
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
