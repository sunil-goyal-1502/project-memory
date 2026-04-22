"use strict";

/**
 * router/wire.js — connects Phase A's server.js dispatcher to Phase C's
 * orchestrator. Called once at startup (from index.js).
 *
 * For each routed format, it builds a (req, res, ctx) handler that:
 *   1. reads the raw request body
 *   2. parses JSON, calls adapter.toCommon()
 *   3. delegates to fallback.dispatch()
 */

const server = require("./server.js");
const adapter = require("./adapter.js");
const upstream = require("./upstream.js");
const fallback = require("./fallback.js");

function readBody(req) {
  return upstream.readBody(req);
}

function classifyKind(format, pathname) {
  if (pathname === "/v1/embeddings") return "embedding";
  if (format === "responses") return "responses";
  if (pathname === "/v1/completions") return "completion";
  return "chat";
}

async function routedHandler(req, res, ctx) {
  const format = ctx.format;
  const pathname = (req.url.split("?")[0]) || "/";
  const kind = classifyKind(format, pathname);

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { type: "bad_body", message: err.message } }));
    }
    return;
  }

  let body = {};
  if (raw && raw.length) {
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { type: "invalid_json", message: err.message } }));
      }
      return;
    }
  }

  // Embeddings have no `messages` shape — synthesize a minimal common form.
  let commonRequest;
  if (kind === "embedding") {
    commonRequest = {
      messages: [],
      system: null,
      tools: null,
      params: { model: body.model, stream: false },
      raw: body,
      kind: "embedding",
    };
  } else {
    try {
      commonRequest = adapter.toCommon(body, format);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { type: "adapter_failed", message: err.message } }));
      }
      return;
    }
  }
  commonRequest.format = format;

  const dispatchCtx = {
    req,
    res,
    rawBody: raw,
    endpoint: pathname,
  };

  try {
    await fallback.dispatch(commonRequest, format, kind, dispatchCtx);
  } catch (err) {
    // Last-ditch error path — fallback.dispatch normally writes its own.
    process.stderr.write(`[router/wire] dispatch crashed: ${err && err.stack || err}\n`);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { type: "router_internal", message: err.message } }));
    } else {
      try { res.end(); } catch {}
    }
  }
}

let _wired = false;

function install() {
  if (_wired) return;
  server.setRoutedDispatcher(routedHandler);
  _wired = true;
}

module.exports = { install, routedHandler };
