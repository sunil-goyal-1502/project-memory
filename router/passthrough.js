"use strict";

/**
 * passthrough.js — Category 2 handler.
 *
 * Thin wrapper around upstream.forward. Phase D will register hooks here
 * (request-count, byte-count stats) without touching the dispatcher.
 */

const upstream = require('./upstream.js');

const _hooks = {
  onResponse: [],
};

/**
 * Register a hook fired with { status, headers, provider } once the upstream
 * status line is known but before the body finishes streaming.
 */
function onResponse(fn) {
  if (typeof fn === 'function') _hooks.onResponse.push(fn);
}

/**
 * Handler signature compatible with server.js dispatch:
 *   (req, res, ctx) => Promise<void>
 *
 * ctx may include:
 *   - route:   the matched route object
 *   - format:  hint for upstream selection ('anthropic' | 'openai' | null)
 *   - body:    pre-read request body Buffer (optional)
 */
async function handle(req, res, ctx = {}) {
  const provider = ctx.provider || formatToProvider(ctx.format) || null;
  await upstream.forward({
    req,
    res,
    provider, // falsy ⇒ upstream.forward auto-detects from headers
    body: ctx.body,
    onResponse: (info) => {
      for (const h of _hooks.onResponse) {
        try { h({ ...info, route: ctx.route }); } catch { /* swallow hook errors */ }
      }
    },
  });
}

function formatToProvider(format) {
  if (format === 'anthropic') return 'anthropic';
  if (format === 'openai' || format === 'responses') return 'openai';
  return null;
}

module.exports = {
  handle,
  onResponse,
  formatToProvider,
};
