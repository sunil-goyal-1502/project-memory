"use strict";

/**
 * Ollama client — native fetch only, no third-party deps.
 *
 * Endpoints used:
 *   POST /api/chat                 — native NDJSON streaming chat
 *   POST /v1/chat/completions      — OpenAI-compatible layer (no translation needed)
 *   POST /api/embed                — embeddings
 *   GET  /api/tags                 — list local models
 *   GET  /api/version              — server version (used by /health/ready)
 *   GET  /api/ps                   — currently loaded models
 *
 * Configuration:
 *   OLLAMA_URL                     — base URL, default http://localhost:11434
 *   OLLAMA_DEFAULT_MODEL           — model used for warm-up; default llama3.2:3b
 *   OLLAMA_KEEPALIVE               — keep_alive value, default '5m'
 */

const BASE_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
const DEFAULT_KEEPALIVE = process.env.OLLAMA_KEEPALIVE || '5m';
const DEFAULT_MODEL = process.env.OLLAMA_DEFAULT_MODEL || 'llama3.2:3b';

function url(p) {
  return BASE_URL + p;
}

async function jsonRequest(p, opts = {}) {
  const res = await fetch(url(p), {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Ollama ${p} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Native chat against /api/chat. Returns either a parsed full response
 * (when stream=false) or an async iterator yielding parsed NDJSON chunks.
 */
async function chat({ model, messages, tools, stream = false, options, format, keep_alive }) {
  const body = {
    model: model || DEFAULT_MODEL,
    messages,
    stream,
    keep_alive: keep_alive || DEFAULT_KEEPALIVE,
  };
  if (tools) body.tools = tools;
  if (options) body.options = options;
  if (format) body.format = format;

  const res = await fetch(url('/api/chat'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama /api/chat -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!stream) return res.json();
  return ndjsonIterator(res.body);
}

/**
 * OpenAI-compatible chat against Ollama's /v1/chat/completions.
 * Used when an OpenAI-format request is going local — no translation.
 * Returns the Response object so caller can stream raw bytes back to client.
 */
async function chatOpenAICompat(body, { stream = false } = {}) {
  const res = await fetch(url('/v1/chat/completions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream }),
  });
  return res;
}

async function embed({ model, input }) {
  return jsonRequest('/api/embed', {
    method: 'POST',
    body: { model: model || DEFAULT_MODEL, input },
  });
}

async function listModels() {
  return jsonRequest('/api/tags');
}

async function version() {
  return jsonRequest('/api/version');
}

async function ps() {
  return jsonRequest('/api/ps');
}

/**
 * Yield parsed JSON objects from an NDJSON byte stream (Web ReadableStream).
 */
async function* ndjsonIterator(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { yield JSON.parse(line); } catch { /* ignore malformed line */ }
    }
  }
  buf = buf.trim();
  if (buf) {
    try { yield JSON.parse(buf); } catch { /* ignore */ }
  }
}

/**
 * Fire-and-forget warm-up: ensure the default model is loaded so first
 * real request doesn't pay the cold-start cost.
 */
function warmup({ model } = {}) {
  const target = model || DEFAULT_MODEL;
  fetch(url('/api/chat'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: target,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      keep_alive: DEFAULT_KEEPALIVE,
      options: { num_predict: 1 },
    }),
  }).catch(() => { /* best-effort */ });
}

async function reachable(timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url('/api/version'), { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = {
  BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_KEEPALIVE,
  chat,
  chatOpenAICompat,
  embed,
  listModels,
  version,
  ps,
  warmup,
  reachable,
};
