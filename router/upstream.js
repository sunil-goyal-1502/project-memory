"use strict";

/**
 * upstream.js — cloud passthrough core.
 *
 * forward({ req, res, provider }) reads the inbound request body, replays it
 * verbatim against the upstream provider preserving all auth/version headers,
 * and streams the response back byte-for-byte.
 *
 * Provider URL map (overridable for tests):
 *   anthropic → ANTHROPIC_UPSTREAM_URL || https://api.anthropic.com
 *   openai    → OPENAI_UPSTREAM_URL    || https://api.openai.com
 */

const PROVIDER_URLS = {
  anthropic: (process.env.ANTHROPIC_UPSTREAM_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
  openai:    (process.env.OPENAI_UPSTREAM_URL    || 'https://api.openai.com').replace(/\/+$/, ''),
};

// Test hook: re-read upstream URLs from env after mutation.
function refreshProviderUrls() {
  PROVIDER_URLS.anthropic = (process.env.ANTHROPIC_UPSTREAM_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  PROVIDER_URLS.openai    = (process.env.OPENAI_UPSTREAM_URL    || 'https://api.openai.com').replace(/\/+$/, '');
  return PROVIDER_URLS;
}

// RFC 7230 §6.1 — hop-by-hop headers must not be forwarded.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', // recomputed by fetch / node
  'host',           // set per upstream
]);

const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie']);

/**
 * Detect provider from request headers when path doesn't determine it.
 * Returns 'anthropic' | 'openai' | null.
 */
function detectProviderFromHeaders(headers) {
  if (!headers) return null;
  if (headers['x-api-key']) return 'anthropic';
  const auth = headers['authorization'];
  if (auth && /^Bearer\s/i.test(auth)) return 'openai';
  return null;
}

function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (v == null) continue;
    out[k] = v;
  }
  return out;
}

function readBody(req) {
  // SECURITY: cap to prevent OOM. The largest legitimate payload is a model
  // request with a very long context; 50 MB is far above any current model
  // window. Larger requests get a 413 from the caller.
  const MAX_BODY = 50 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      received += c.length;
      if (received > MAX_BODY) {
        aborted = true;
        const err = new Error('payload too large');
        err.code = 'EPAYLOADTOOLARGE';
        try { req.destroy(); } catch {}
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function safeLogHeaders(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '<redacted>' : headers[k];
  }
  return out;
}

/**
 * Forward an incoming request to the appropriate upstream provider and
 * stream the response back to the client.
 *
 * @param {object} opts
 * @param {http.IncomingMessage} opts.req
 * @param {http.ServerResponse}  opts.res
 * @param {string}               [opts.provider] — explicit; otherwise auto-detected from headers.
 * @param {Buffer}               [opts.body]     — pre-read body (avoids double-consume).
 * @param {function}             [opts.onResponse] — hook called with { status, headers } pre-stream.
 */
async function forward({ req, res, provider, body, onResponse }) {
  const detected = provider || detectProviderFromHeaders(req.headers);
  if (!detected || !PROVIDER_URLS[detected]) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      error: {
        type: 'unknown_provider',
        message: 'No upstream provider could be determined. ' +
                 'Provide x-api-key (Anthropic) or Authorization: Bearer (OpenAI).',
        path: req.url,
      },
    }));
    return;
  }

  const upstreamBase = PROVIDER_URLS[detected];
  // SECURITY: req.url must be origin-form (starts with "/"). An absolute-form
  // request line ("http://evil/path") would let a caller redirect the proxy
  // to an arbitrary upstream by string-concatenation.
  if (typeof req.url !== 'string' || req.url.length === 0 || req.url[0] !== '/') {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { type: 'bad_request', message: 'expected origin-form request URI' } }));
    return;
  }
  const targetUrl = upstreamBase + req.url;

  let payload = body;
  if (payload === undefined && req.method !== 'GET' && req.method !== 'HEAD') {
    payload = await readBody(req);
  }

  const fwdHeaders = filterHeaders(req.headers);

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: payload && payload.length ? payload : undefined,
      // Don't follow redirects — let the client handle them.
      redirect: 'manual',
    });
  } catch (err) {
    // Never log header values — only the failure.
    console.error(`[upstream] ${detected} ${req.method} ${req.url} → fetch error: ${err.message}`);
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      error: {
        type: 'upstream_unreachable',
        provider: detected,
        message: err.message,
      },
    }));
    return;
  }

  // Copy response headers (after hop-by-hop filtering).
  res.statusCode = upstream.status;
  upstream.headers.forEach((v, k) => {
    if (HOP_BY_HOP.has(k.toLowerCase())) return;
    try { res.setHeader(k, v); } catch { /* ignore invalid header */ }
  });

  if (typeof onResponse === 'function') {
    try { onResponse({ status: upstream.status, headers: upstream.headers, provider: detected }); }
    catch { /* hook errors are non-fatal */ }
  }

  // Stream body back byte-for-byte.
  if (!upstream.body) { res.end(); return; }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        // Respect backpressure.
        await new Promise((r) => res.once('drain', r));
      }
    }
  } catch (err) {
    console.error(`[upstream] ${detected} stream error: ${err.message}`);
  } finally {
    res.end();
  }
}

module.exports = {
  PROVIDER_URLS,
  HOP_BY_HOP,
  detectProviderFromHeaders,
  filterHeaders,
  readBody,
  safeLogHeaders,
  forward,
  refreshProviderUrls,
};
