"use strict";

/**
 * router/fallback.js — orchestrator that wires classify + decide + breaker
 * + dispatch + confidence + cache + stats together.
 *
 * Public API:
 *   dispatch(commonRequest, format, kind, ctx) → { response, meta }
 *
 * ctx must include:
 *   - req:       http.IncomingMessage (read; body already consumed)
 *   - res:       http.ServerResponse
 *   - rawBody:   Buffer of original request body (for cloud passthrough)
 *   - endpoint:  string path (for stats)
 *
 * Critical invariants:
 *   1. EXACTLY ONE stats row recorded per request (no double-billing on fallback).
 *   2. circuit-breaker.recordSuccess/recordFailure called against the actual
 *      provider that was tried.
 *   3. Streaming fallback only possible BEFORE first chunk hits the wire.
 *   4. Confidence check skipped on streaming (deferred — see plan).
 *   5. Response cached only if confident:true (set() also enforces this).
 */

const adapter = require("./adapter.js");
const classifier = require("./classifier.js");
const router = require("./router.js");
const breaker = require("./circuit-breaker.js");
const confidence = require("./confidence.js");
const ollama = require("./ollama.js");
const upstream = require("./upstream.js");
const hooks = require("./server-hooks.js");
const { getConfig } = require("./config.js");

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildOllamaMessages(commonRequest) {
  // Ollama /api/chat accepts {role, content} plus tool_calls/tool messages.
  const out = [];
  if (commonRequest.system) {
    out.push({ role: "system", content: String(commonRequest.system) });
  }
  for (const m of commonRequest.messages || []) {
    out.push({
      role: m.role,
      content: typeof m.content === "string" ? m.content : "",
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    });
    // Anthropic tool_results tucked into _tool_results — emit as separate tool messages.
    if (m._tool_results && Array.isArray(m._tool_results)) {
      for (const tr of m._tool_results) out.push(tr);
    }
  }
  return out;
}

function buildOllamaTools(commonRequest) {
  if (!commonRequest.tools || !commonRequest.tools.length) return undefined;
  return commonRequest.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.parameters || {},
    },
  }));
}

function buildOllamaOptions(commonRequest) {
  const p = commonRequest.params || {};
  const opts = {};
  if (Number.isFinite(p.temperature)) opts.temperature = p.temperature;
  if (Number.isFinite(p.top_p)) opts.top_p = p.top_p;
  if (Number.isFinite(p.top_k)) opts.top_k = p.top_k;
  if (Number.isFinite(p.max_tokens)) opts.num_predict = p.max_tokens;
  if (p.stop) opts.stop = Array.isArray(p.stop) ? p.stop : [p.stop];
  return Object.keys(opts).length ? opts : undefined;
}

function writeJSON(res, status, obj) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
}

// Convert a Web ReadableStream (from fetch().body) into an async iterator of
// Buffers — used to feed Ollama NDJSON bytes into translateStream Transforms.
async function* webStreamToBuffers(webStream) {
  const reader = webStream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      yield Buffer.from(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// ─── Local dispatch — non-streaming ─────────────────────────────────────────

async function dispatchLocalNonStream(commonRequest, primary, format) {
  const body = {
    model: primary.model,
    messages: buildOllamaMessages(commonRequest),
    stream: false,
  };
  const tools = buildOllamaTools(commonRequest);
  if (tools) body.tools = tools;
  const opts = buildOllamaOptions(commonRequest);
  if (opts) body.options = opts;

  const ollamaResp = await ollama.chat(body);
  const common = adapter.ollamaToCommon(ollamaResp);
  return common; // shape: {id, model, content, tool_calls, stop_reason, usage}
}

// ─── Local dispatch — streaming ─────────────────────────────────────────────

async function dispatchLocalStream(commonRequest, primary, format, ctx, beforeFirstChunk) {
  // We need a low-level fetch to get the raw body stream that translateStream
  // consumes. Replicate ollama.chat() but always stream:true and return Response.
  const url = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "") + "/api/chat";
  const body = {
    model: primary.model,
    messages: buildOllamaMessages(commonRequest),
    stream: true,
    keep_alive: process.env.OLLAMA_KEEPALIVE || "5m",
  };
  const tools = buildOllamaTools(commonRequest);
  if (tools) body.tools = tools;
  const opts = buildOllamaOptions(commonRequest);
  if (opts) body.options = opts;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    err.preFirstChunk = true; // safe to fall back
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error(`Ollama stream HTTP ${res.status}: ${txt.slice(0, 200)}`);
    err.preFirstChunk = true;
    throw err;
  }

  // Pick translator. For 'responses' there is no ollama→responses translator;
  // bail out so caller falls back to cloud (still pre-first-chunk).
  if (format === "responses") {
    const err = new Error("local streaming not supported for OpenAI Responses format (no translator)");
    err.preFirstChunk = true;
    throw err;
  }

  const translator = adapter.translateStream("ollama", format, { model: primary.model });
  const out = ctx.res;

  // Set headers for SSE before first byte. Anthropic + OpenAI both use SSE.
  if (!out.headersSent) {
    out.statusCode = 200;
    out.setHeader("content-type", "text/event-stream");
    out.setHeader("cache-control", "no-cache");
    out.setHeader("connection", "keep-alive");
  }

  let firstChunkSeen = false;
  let usage = { input_tokens: 0, output_tokens: 0 };
  // Sniff Ollama NDJSON to harvest usage for stats. Cheap: parse only `done` chunks.
  // Reuse a lightweight line parser.
  let buf = "";
  function sniff(chunkBuf) {
    buf += chunkBuf.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.done) {
          if (Number.isFinite(o.prompt_eval_count)) usage.input_tokens = o.prompt_eval_count;
          if (Number.isFinite(o.eval_count)) usage.output_tokens = o.eval_count;
        }
      } catch {}
    }
  }

  translator.on("data", (chunk) => {
    if (!firstChunkSeen) {
      firstChunkSeen = true;
      if (typeof beforeFirstChunk === "function") beforeFirstChunk();
    }
    if (!out.write(chunk)) {
      // best-effort backpressure
      out.once("drain", () => {});
    }
  });

  await new Promise((resolve, reject) => {
    translator.on("end", resolve);
    translator.on("error", reject);
    (async () => {
      try {
        for await (const chunk of webStreamToBuffers(res.body)) {
          sniff(chunk);
          translator.write(chunk);
        }
        translator.end();
      } catch (err) {
        if (!firstChunkSeen) err.preFirstChunk = true;
        translator.destroy(err);
      }
    })();
  });

  try { out.end(); } catch {}
  return { streamed: true, usage, firstChunkSeen };
}

// ─── Cloud dispatch (passthrough) ───────────────────────────────────────────

async function dispatchCloud(commonRequest, choice, format, ctx) {
  // Forward original raw body byte-for-byte to upstream and stream response back.
  await upstream.forward({
    req: ctx.req,
    res: ctx.res,
    provider: choice.provider,
    body: ctx.rawBody,
  });
  return { streamed: !!(commonRequest.params && commonRequest.params.stream) };
}

// ─── Stats helper ───────────────────────────────────────────────────────────

function recordOnce(ctx, fields) {
  if (ctx.__statsRecorded) return;
  ctx.__statsRecorded = true;
  try { hooks.recordRequest(fields); } catch (e) {
    process.stderr.write(`[router/fallback] stats record failed: ${e.message}\n`);
  }
}

// ─── Main entry ─────────────────────────────────────────────────────────────

/**
 * @param {object} commonRequest
 * @param {string} format - 'anthropic' | 'openai' | 'responses'
 * @param {string} kind   - 'chat' | 'embedding' | 'completion' | 'responses'
 * @param {object} ctx    - { req, res, rawBody, endpoint }
 */
async function dispatch(commonRequest, format, kind, ctx) {
  const t0 = Date.now();
  const cfg = getConfig();
  const isStream = !!(commonRequest && commonRequest.params && commonRequest.params.stream);
  const endpoint = ctx.endpoint || (ctx.req && ctx.req.url) || "/";

  // ── 1. Cache check ────────────────────────────────────────────────────────
  if (!isStream) {
    try {
      const cacheReq = {
        model: commonRequest.params && commonRequest.params.model,
        messages: commonRequest.messages,
        system: commonRequest.system,
        tools: commonRequest.tools,
        params: commonRequest.params,
      };
      const authHeader =
        (ctx.req && ctx.req.headers &&
         (ctx.req.headers.authorization || ctx.req.headers["x-api-key"])) || "";
      const hit = await hooks.cacheGet(cacheReq, { authHeader });
      if (hit) {
        // Write cached response in caller's format. Cached payload is already
        // in `format` (we cache after fromCommon).
        if (!ctx.res.headersSent) {
          ctx.res.statusCode = 200;
          ctx.res.setHeader("content-type", "application/json");
          ctx.res.end(JSON.stringify(hit.response));
        }
        recordOnce(ctx, {
          format, endpoint, category: "routed",
          classification: null, provider: "cache", model: null,
          prompt_tokens: hit.prompt_tokens, completion_tokens: hit.completion_tokens,
          latency_ms: Date.now() - t0,
          fallback: 0, cache_hit: hit.hit, error: null,
        });
        return { response: hit.response, meta: { provider: "cache", cacheHit: hit.hit, latencyMs: Date.now() - t0 } };
      }
    } catch (e) {
      // Cache failure is non-fatal — continue to live dispatch.
      process.stderr.write(`[router/fallback] cache lookup failed: ${e.message}\n`);
    }
  }

  // ── 2. Classify ───────────────────────────────────────────────────────────
  // Mark `kind` on the commonRequest so the classifier short-circuits embeddings.
  if (kind === "embedding") commonRequest.kind = "embedding";

  let classification;
  try {
    classification = await classifier.classify(commonRequest);
  } catch (e) {
    classification = { complexity: "complex", confidence: 0, reasons: [`classifier error: ${e.message}`] };
  }

  // ── 3. Decide ─────────────────────────────────────────────────────────────
  let primary;
  try {
    primary = router.decide(commonRequest, classification, kind, format);
  } catch (e) {
    if (e.code === "PRIVACY_BLOCK") {
      writeJSON(ctx.res, 503, {
        error: { type: "privacy_blocked", message: e.message },
      });
      recordOnce(ctx, {
        format, endpoint, category: "routed",
        classification: classification.complexity, provider: null, model: null,
        latency_ms: Date.now() - t0, fallback: 0, error: "privacy_blocked",
      });
      return { response: null, meta: { error: "privacy_blocked", classification, latencyMs: Date.now() - t0 } };
    }
    throw e;
  }

  // ── 4. Circuit breaker on primary ────────────────────────────────────────
  let activeChoice = primary;
  let usedFallback = false;
  let breakerSkipReason = null;
  if (!breaker.isAvailable(primary.provider)) {
    if (primary.fallback) {
      breakerSkipReason = `breaker OPEN for ${primary.provider}`;
      activeChoice = primary.fallback;
      usedFallback = true;
    } else {
      writeJSON(ctx.res, 503, {
        error: {
          type: "service_unavailable",
          provider: primary.provider,
          message: `Circuit breaker open for ${primary.provider} and no fallback available`,
        },
      });
      recordOnce(ctx, {
        format, endpoint, category: "routed",
        classification: classification.complexity, provider: primary.provider,
        model: primary.model, latency_ms: Date.now() - t0, fallback: 0,
        error: "breaker_open_no_fallback",
      });
      return { response: null, meta: { error: "breaker_open", classification, latencyMs: Date.now() - t0 } };
    }
  }

  // ── 5. Dispatch primary (or fallback if breaker pre-empted) ──────────────
  let lastError = null;
  let finalResponse = null;
  let finalUsage = { input_tokens: 0, output_tokens: 0 };

  // Inner helper to attempt one route. Returns {ok, response?, usage?, error?, preFirstChunk?, streamed?}
  async function attempt(choice) {
    try {
      if (choice.provider === "ollama") {
        if (isStream) {
          const r = await dispatchLocalStream(commonRequest, choice, format, ctx);
          breaker.recordSuccess("ollama");
          return { ok: true, streamed: true, usage: r.usage };
        }
        const common = await dispatchLocalNonStream(commonRequest, choice, format);
        breaker.recordSuccess("ollama");
        return { ok: true, common, usage: common.usage || {} };
      } else {
        // Cloud
        if (!breaker.isAvailable(choice.provider)) {
          return { ok: false, error: new Error(`breaker open for ${choice.provider}`), preFirstChunk: true };
        }
        await dispatchCloud(commonRequest, choice, format, ctx);
        breaker.recordSuccess(choice.provider);
        return { ok: true, streamed: isStream, cloud: true };
      }
    } catch (err) {
      breaker.recordFailure(choice.provider);
      return { ok: false, error: err, preFirstChunk: !!err.preFirstChunk };
    }
  }

  // First attempt
  let result = await attempt(activeChoice);

  // Confidence check (non-streaming local only) — discard + fallback if low.
  if (result.ok && !isStream && activeChoice.provider === "ollama" && result.common) {
    const conf = confidence.check(result.common, commonRequest);
    if (!conf.confident && primary.fallback && cfg.router_fallback_on_low_confidence !== false) {
      // Switch to fallback (cloud).
      usedFallback = true;
      breakerSkipReason = `low_confidence: ${conf.reasons.join("; ")}`;
      activeChoice = primary.fallback;
      result = await attempt(activeChoice);
    } else {
      // Confident or no fallback available → commit local response.
      finalResponse = adapter.fromCommon(result.common, format);
      finalUsage = result.common.usage || {};
    }
  }

  // If primary attempt failed and a fallback is available, try it once.
  // For streaming, only safe BEFORE first chunk hits the wire (preFirstChunk).
  // For non-streaming, always safe (response not yet written).
  if (!result.ok && primary.fallback && !usedFallback) {
    const safeToFallback = !isStream || result.preFirstChunk === true;
    if (safeToFallback) {
      usedFallback = true;
      activeChoice = primary.fallback;
      result = await attempt(activeChoice);
    }
  }

  // Now produce the final response/state.
  if (result.ok) {
    if (result.streamed) {
      // Streaming: response already piped to ctx.res by attempt().
      finalUsage = result.usage || finalUsage;
    } else if (result.cloud) {
      // Cloud non-stream: bytes already piped by upstream.forward.
    } else if (!finalResponse && result.common) {
      // Local non-stream confident-skip case.
      finalResponse = adapter.fromCommon(result.common, format);
      finalUsage = result.common.usage || {};
    }
  } else {
    lastError = result.error;
    // Both attempts (or single attempt with no fallback) failed.
    if (!ctx.res.headersSent) {
      writeJSON(ctx.res, 502, {
        error: {
          type: "all_routes_failed",
          provider: activeChoice.provider,
          message: lastError ? lastError.message : "unknown",
          fallback_used: usedFallback,
        },
      });
    } else {
      try { ctx.res.end(); } catch {}
    }
  }

  // Write non-stream local final response (if not already written by cloud/stream).
  if (finalResponse && !ctx.res.headersSent) {
    ctx.res.statusCode = 200;
    ctx.res.setHeader("content-type", "application/json");
    ctx.res.end(JSON.stringify(finalResponse));
  }

  // ── 6. Cache (only confident, non-stream local) ──────────────────────────
  if (finalResponse && !isStream && activeChoice.provider === "ollama" && !lastError) {
    try {
      await hooks.cacheSet({
        request: {
          model: commonRequest.params && commonRequest.params.model,
          messages: commonRequest.messages,
          system: commonRequest.system,
          tools: commonRequest.tools,
          params: commonRequest.params,
        },
        authHeader:
          (ctx.req && ctx.req.headers &&
           (ctx.req.headers.authorization || ctx.req.headers["x-api-key"])) || "",
        response: finalResponse,
        format,
        prompt_tokens: finalUsage.input_tokens || 0,
        completion_tokens: finalUsage.output_tokens || 0,
        confident: true,
      });
    } catch (e) {
      process.stderr.write(`[router/fallback] cache set failed: ${e.message}\n`);
    }
  }

  // ── 7. Stats — exactly one row ───────────────────────────────────────────
  recordOnce(ctx, {
    format,
    endpoint,
    category: "routed",
    classification: classification.complexity,
    provider: activeChoice.provider,
    model: activeChoice.model,
    prompt_tokens: finalUsage.input_tokens || null,
    completion_tokens: finalUsage.output_tokens || null,
    latency_ms: Date.now() - t0,
    fallback: usedFallback ? 1 : 0,
    cache_hit: null,
    error: lastError ? String(lastError.message).slice(0, 500)
                     : (breakerSkipReason ? `note:${breakerSkipReason}` : null),
  });

  return {
    response: finalResponse,
    meta: {
      provider: activeChoice.provider,
      model: activeChoice.model,
      classification: classification.complexity,
      fallback: usedFallback,
      latencyMs: Date.now() - t0,
      cacheHit: null,
      error: lastError ? lastError.message : null,
      reason: primary.reason,
    },
  };
}

module.exports = {
  dispatch,
  // exposed for tests
  buildOllamaMessages,
  buildOllamaTools,
  buildOllamaOptions,
};
