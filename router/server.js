"use strict";

/**
 * server.js — Native Node http server. Dispatches requests through
 * router-table.js. Routed handlers are stubs in Phase A — they delegate to
 * upstream.forward but the call path is structured so Phase C can drop in
 * the classifier+router decision without touching the dispatcher.
 */

const http = require('http');

const table = require('./router-table.js');
const upstream = require('./upstream.js');
const passthrough = require('./passthrough.js');
const ollama = require('./ollama.js');

const PORT = parseInt(process.env.ROUTER_PORT || '8081', 10);
const HOST = '127.0.0.1';

// ─── Startup state ──────────────────────────────────────────────────────────
const startedAt = Date.now();

// ─── Logging helper (never logs sensitive header values) ────────────────────
function logRequest(req, route) {
  const t = new Date().toISOString();
  const r = route ? `${route.category}:${route.handler}` : 'unmatched';
  // eslint-disable-next-line no-console
  console.log(`[${t}] ${req.method} ${req.url} → ${r}`);
}

// ─── Handler registry ───────────────────────────────────────────────────────
const HANDLERS = {
  // Ops
  healthLive,
  healthReady,
  metrics,
  stats,
  adminReload,

  // Routed (Phase A stubs — Phase C will add classify+route+fallback)
  routedAnthropicMessages: makeRoutedStub('anthropic'),
  routedOpenAIChat:        makeRoutedStub('openai'),
  routedOpenAIResponses:   makeRoutedStub('responses'),
  routedOpenAICompletions: makeRoutedStub('openai'),
  routedOpenAIEmbeddings:  makeRoutedStub('openai'),

  // Passthrough
  passthrough: passthrough.handle,
};

// Phase-C extension point — if router.decideAndDispatch is registered, the
// stubs delegate to it; otherwise they fall straight through to upstream.
let _routedDispatcher = null;
function setRoutedDispatcher(fn) { _routedDispatcher = fn; }

function makeRoutedStub(format) {
  return async function routed(req, res, ctx) {
    const merged = { ...ctx, format };
    if (_routedDispatcher) {
      return _routedDispatcher(req, res, merged);
    }
    // Phase A behaviour: log + forward to cloud upstream untouched.
    // eslint-disable-next-line no-console
    console.log(`[routed-stub] ${format} ${req.method} ${req.url} — Phase C will classify; forwarding to upstream for now.`);
    return passthrough.handle(req, res, merged);
  };
}

// ─── Ops handlers ───────────────────────────────────────────────────────────

async function healthLive(req, res) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'live', uptime_ms: Date.now() - startedAt }));
}

async function healthReady(req, res) {
  const checks = {
    ollama:    await ollama.reachable(1500),
    anthropic: await reachable(upstream.PROVIDER_URLS.anthropic),
    openai:    await reachable(upstream.PROVIDER_URLS.openai),
  };
  const ready = checks.ollama || (checks.anthropic && checks.openai);
  res.statusCode = ready ? 200 : 503;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: ready ? 'ready' : 'degraded', checks }));
}

async function metrics(req, res) {
  // Phase D will fill this with real counters/histograms.
  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain; version=0.0.4');
  res.end(
    '# HELP router_up 1 if the router process is running.\n' +
    '# TYPE router_up gauge\n' +
    'router_up 1\n' +
    '# HELP router_uptime_seconds Seconds since router start.\n' +
    '# TYPE router_uptime_seconds gauge\n' +
    `router_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(2)}\n`
  );
}

async function stats(req, res) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    uptime_ms: Date.now() - startedAt,
    routes: table.ROUTES.length,
    note: 'Phase D will populate request/route/byte counters.',
  }));
}

async function adminReload(req, res) {
  // Phase D will reload config / refs / refs cache here.
  res.statusCode = 202;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'noop', message: 'Phase D will implement reload.' }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function reachable(baseUrl, timeoutMs = 1500) {
  if (!baseUrl) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    // HEAD on root often 4xx but proves reachability.
    const res = await fetch(baseUrl + '/', { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(t);
    return res.status > 0;
  } catch {
    return false;
  }
}

function notFound(req, res) {
  // Catch-all behaviour: try to forward via upstream if we can detect provider.
  const provider = upstream.detectProviderFromHeaders(req.headers);
  if (provider) {
    // eslint-disable-next-line no-console
    console.log(`[catchall] ${req.method} ${req.url} → ${provider} (auto-detected)`);
    return passthrough.handle(req, res, { provider });
  }
  res.statusCode = 404;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    error: {
      type: 'not_found',
      message: 'No route matched and no upstream provider could be detected. ' +
               'Provide x-api-key (Anthropic) or Authorization: Bearer (OpenAI).',
      method: req.method,
      path: req.url,
    },
  }));
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(req, res) {
  const qIdx = req.url.indexOf('?');
  const pathname = qIdx >= 0 ? req.url.slice(0, qIdx) : req.url;
  const route = table.findRoute(req.method, pathname);

  logRequest(req, route);

  try {
    if (!route) return notFound(req, res);
    const handler = HANDLERS[route.handler];
    if (!handler) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        error: { type: 'handler_missing', handler: route.handler, path: pathname },
      }));
    }
    await handler(req, res, { route, format: route.format });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[dispatch] ${req.method} ${pathname} crashed:`, err && err.stack || err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { type: 'internal', message: err.message } }));
    } else {
      try { res.end(); } catch { /* already torn down */ }
    }
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

function createServer() {
  const server = http.createServer(dispatch);
  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ }
  });
  return server;
}

function start({ port = PORT, host = HOST, warm = true } = {}) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      // eslint-disable-next-line no-console
      console.log(`ai-router listening on http://${host}:${port}`);
      // eslint-disable-next-line no-console
      console.log(`  routes: ${table.ROUTES.length} configured (+ catch-all)`);
      if (warm) ollama.warmup();
      resolve(server);
    });
  });
}

module.exports = {
  PORT, HOST,
  HANDLERS,
  createServer,
  start,
  dispatch,
  setRoutedDispatcher,
};
