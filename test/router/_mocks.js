"use strict";

/**
 * Shared HTTP mock servers for router tests. Self-contained — no network.
 *
 * mockAnthropic / mockOpenAI / mockOllama all return:
 *   { server, port, url, requests:[{method,path,headers,body}], close() }
 *
 * Each takes an optional handler({req, body}) → { status, headers, body, stream? }
 * If the handler returns stream:true, it should provide `chunks` (array of strings)
 * which will be written with a small delay between them.
 *
 * Also exports:
 *   - sandboxDir(label): unique temp dir; auto-resolves ROUTER_DB_DIR
 *   - resetRouterEnv(): wipes require cache for router/* + resets config DBs
 *   - sleep(ms)
 *   - tinyAssert: simple PASS/FAIL printer + summary helper
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function startMock(name, defaultHandler) {
  const requests = [];
  let userHandler = defaultHandler;

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const entry = {
      method: req.method,
      path: req.url,
      headers: { ...req.headers },
      body: body.toString("utf8"),
    };
    requests.push(entry);
    let result;
    try {
      result = await userHandler({ req, body, raw: body });
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { type: "mock_handler_error", message: e.message } }));
      return;
    }
    if (!result) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end("{}");
      return;
    }
    res.statusCode = result.status || 200;
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    }
    if (result.stream) {
      // result.contentType defaults per format
      const ct = result.contentType ||
        (name === "ollama" ? "application/x-ndjson" : "text/event-stream");
      res.setHeader("content-type", ct);
      for (const chunk of result.chunks || []) {
        res.write(chunk);
        await sleep(result.chunkDelayMs ?? 5);
      }
      res.end();
      return;
    }
    if (result.headers && result.headers["content-type"]) {
      // already set
    } else {
      res.setHeader("content-type", "application/json");
    }
    if (typeof result.body === "string") res.end(result.body);
    else if (Buffer.isBuffer(result.body)) res.end(result.body);
    else res.end(JSON.stringify(result.body || {}));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  return {
    name,
    server,
    port,
    url,
    requests,
    setHandler(fn) { userHandler = fn; },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function defaultAnthropic({ body }) {
  let parsed = {};
  try { parsed = JSON.parse(body.toString("utf8") || "{}"); } catch {}
  return {
    status: 200,
    body: {
      id: "msg_mock_" + Date.now(),
      type: "message",
      role: "assistant",
      model: parsed.model || "claude-mock",
      content: [{ type: "text", text: "mock anthropic reply" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 4 },
    },
  };
}

function defaultOpenAI({ body }) {
  let parsed = {};
  try { parsed = JSON.parse(body.toString("utf8") || "{}"); } catch {}
  return {
    status: 200,
    body: {
      id: "chatcmpl-mock-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: parsed.model || "gpt-mock",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "mock openai reply" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    },
  };
}

function defaultOllama({ req, body }) {
  let parsed = {};
  try { parsed = JSON.parse(body.toString("utf8") || "{}"); } catch {}
  if (req.url === "/api/version") {
    return { status: 200, body: { version: "mock-0.0.0" } };
  }
  if (req.url === "/api/tags") {
    return { status: 200, body: { models: [{ name: "llama3.2:3b" }] } };
  }
  if (req.url === "/api/embed") {
    const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input || ""];
    const dim = 8;
    const embeddings = inputs.map((t) => {
      const v = new Array(dim).fill(0);
      for (let i = 0; i < (t || "").length; i++) v[i % dim] += t.charCodeAt(i) / 1000;
      const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
      return v.map((x) => x / norm);
    });
    return { status: 200, body: {
      model: parsed.model || "nomic-embed-text",
      embeddings,
      prompt_eval_count: (inputs.join("").length || 0),
    } };
  }
  // /api/chat
  if (parsed.stream) {
    const model = parsed.model || "llama3.2:3b";
    const chunks = [
      JSON.stringify({ model, created_at: new Date().toISOString(),
        message: { role: "assistant", content: "mock " }, done: false }) + "\n",
      JSON.stringify({ model, created_at: new Date().toISOString(),
        message: { role: "assistant", content: "ollama " }, done: false }) + "\n",
      JSON.stringify({ model, created_at: new Date().toISOString(),
        message: { role: "assistant", content: "stream" }, done: false }) + "\n",
      JSON.stringify({ model, created_at: new Date().toISOString(),
        message: { role: "assistant", content: "" }, done: true,
        done_reason: "stop", prompt_eval_count: 7, eval_count: 5 }) + "\n",
    ];
    return { stream: true, contentType: "application/x-ndjson", chunks, chunkDelayMs: 2 };
  }
  return {
    status: 200,
    body: {
      model: parsed.model || "llama3.2:3b",
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: "mock ollama reply." },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 7,
      eval_count: 5,
    },
  };
}

async function mockAnthropic(handler) { return startMock("anthropic", handler || defaultAnthropic); }
async function mockOpenAI(handler)    { return startMock("openai",    handler || defaultOpenAI); }
async function mockOllama(handler)    { return startMock("ollama",    handler || defaultOllama); }

// ── Sandbox dirs ───────────────────────────────────────────────────────────

function sandboxDir(label) {
  const dir = path.join(os.tmpdir(), `ai-router-test-${process.pid}-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Wipe all router/* modules from require cache (so re-requiring picks up fresh env).
function clearRouterCache() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.sep + "router" + path.sep) && !k.includes("test")) {
      delete require.cache[k];
    }
  }
}

// ── Tiny assertion helper ──────────────────────────────────────────────────

function makeAssert() {
  let pass = 0, fail = 0;
  function ok(cond, msg) {
    if (cond) { pass++; console.log("PASS:", msg); }
    else      { fail++; console.error("FAIL:", msg); }
  }
  function eq(a, b, msg) {
    if (a === b) { pass++; console.log("PASS:", msg); }
    else { fail++; console.error("FAIL:", `${msg}\n   expected: ${JSON.stringify(b)}\n   actual:   ${JSON.stringify(a)}`); }
  }
  function throws(fn, msg) {
    try { fn(); fail++; console.error("FAIL:", msg + " (expected throw)"); }
    catch { pass++; console.log("PASS:", msg); }
  }
  function summary(label) {
    console.log("");
    console.log(`${label}: ${pass} passed, ${fail} failed`);
    return { pass, fail };
  }
  return { ok, eq, throws, summary, get pass() { return pass; }, get fail() { return fail; } };
}

// Collect a stream's output as a UTF-8 string.
function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

// HTTP request helper. Accepts either `url` or `host`+`port`+`path`.
// Returns {status, headers, body, bodyBuffer}.
function httpRequest(opts) {
  const {
    method = "POST", url, host = "127.0.0.1", port, path,
    headers = {}, body = "",
  } = opts;
  return new Promise((resolve, reject) => {
    let reqOpts;
    if (url) {
      const u = new URL(url);
      reqOpts = {
        method, hostname: u.hostname, port: u.port,
        path: u.pathname + u.search,
        headers: { "content-type": "application/json", ...headers },
      };
    } else {
      reqOpts = {
        method, hostname: host, port, path,
        headers: { "content-type": "application/json", ...headers },
      };
    }
    if (body) reqOpts.headers["content-length"] = Buffer.byteLength(body);
    const req = http.request(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buf.toString("utf8"),
          bodyBuffer: buf,
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = {
  mockAnthropic,
  mockOpenAI,
  mockOllama,
  defaultAnthropic,
  defaultOpenAI,
  defaultOllama,
  sandboxDir,
  rmrf,
  clearRouterCache,
  makeAssert,
  collectStream,
  httpRequest,
  sleep,
  readBody,
};
