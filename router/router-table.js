"use strict";

/**
 * Router table — single source of truth for endpoint dispatch.
 *
 * Each row: { path, method, handler, category, format, description }
 *  - path: string. Exact match, OR ends with '*' for prefix match.
 *  - method: HTTP verb in uppercase, or '*' for any.
 *  - handler: name of the handler to invoke (resolved by server.js).
 *  - category: 'routed' | 'passthrough' | 'ops' | 'catchall'
 *  - format:   'anthropic' | 'openai' | 'responses' | null (for ops/passthrough where format doesn't matter)
 *  - description: human-readable summary used in docs (Phase F).
 *
 * Order matters: more specific entries should appear before generic prefixes.
 * The catch-all '*' row is appended automatically by the server.
 */

const ROUTES = [
  // ─── Ops ──────────────────────────────────────────────────────────────────
  { path: '/health/live',   method: 'GET',  handler: 'healthLive',   category: 'ops', format: null, description: 'Liveness probe — 200 if process is running.' },
  { path: '/health/ready',  method: 'GET',  handler: 'healthReady',  category: 'ops', format: null, description: 'Readiness probe — checks Ollama and upstream reachability.' },
  { path: '/metrics',       method: 'GET',  handler: 'metrics',      category: 'ops', format: null, description: 'Prometheus metrics endpoint (Phase D fills it).' },
  { path: '/stats',         method: 'GET',  handler: 'stats',        category: 'ops', format: null, description: 'JSON stats snapshot (Phase D fills it).' },
  { path: '/admin/reload',  method: 'POST', handler: 'adminReload',  category: 'ops', format: null, description: 'Reload config without restart (Phase D).' },

  // ─── Category 1: Routed (chat / completions / embeddings) ─────────────────
  { path: '/v1/messages',         method: 'POST', handler: 'routedAnthropicMessages', category: 'routed', format: 'anthropic', description: 'Anthropic Messages API — routed local-or-cloud.' },
  { path: '/v1/chat/completions', method: 'POST', handler: 'routedOpenAIChat',        category: 'routed', format: 'openai',    description: 'OpenAI Chat Completions — routed local-or-cloud.' },
  { path: '/v1/responses',        method: 'POST', handler: 'routedOpenAIResponses',   category: 'routed', format: 'responses', description: 'OpenAI Responses API (Codex CLI) — routed.' },
  { path: '/v1/completions',      method: 'POST', handler: 'routedOpenAICompletions', category: 'routed', format: 'openai',    description: 'OpenAI legacy completions — routed.' },
  { path: '/v1/embeddings',       method: 'POST', handler: 'routedOpenAIEmbeddings',  category: 'routed', format: 'openai',    description: 'Embeddings — preferentially routed to local Ollama.' },

  // ─── Category 2: Known passthrough — Anthropic ────────────────────────────
  { path: '/v1/messages/count_tokens', method: 'POST', handler: 'passthrough', category: 'passthrough', format: 'anthropic', description: 'Anthropic token counter — Claude Code calls this constantly.' },
  { path: '/v1/messages/batches',      method: '*',    handler: 'passthrough', category: 'passthrough', format: 'anthropic', description: 'Anthropic message batches root.' },
  { path: '/v1/messages/batches/*',    method: '*',    handler: 'passthrough', category: 'passthrough', format: 'anthropic', description: 'Anthropic message batches by id.' },
  { path: '/v1/skills',                method: '*',    handler: 'passthrough', category: 'passthrough', format: 'anthropic', description: 'Anthropic skills (beta).' },
  { path: '/v1/skills/*',              method: '*',    handler: 'passthrough', category: 'passthrough', format: 'anthropic', description: 'Anthropic skills (beta).' },
  { path: '/v1/agents',                method: '*',    handler: 'passthrough', category: 'passthrough', format: 'anthropic', description: 'Anthropic agents (beta).' },
  { path: '/v1/agents/*',              method: '*',    handler: 'passthrough', category: 'passthrough', format: 'anthropic', description: 'Anthropic agents (beta).' },
  { path: '/v1/sessions',              method: '*',    handler: 'passthrough', category: 'passthrough', format: 'anthropic', description: 'Anthropic sessions (beta).' },
  { path: '/v1/sessions/*',            method: '*',    handler: 'passthrough', category: 'passthrough', format: 'anthropic', description: 'Anthropic sessions (beta).' },
  { path: '/v1/environments',          method: '*',    handler: 'passthrough', category: 'passthrough', format: 'anthropic', description: 'Anthropic environments (beta).' },
  { path: '/v1/environments/*',        method: '*',    handler: 'passthrough', category: 'passthrough', format: 'anthropic', description: 'Anthropic environments (beta).' },

  // ─── Category 2: Known passthrough — OpenAI ──────────────────────────────
  { path: '/v1/moderations',     method: '*', handler: 'passthrough', category: 'passthrough', format: 'openai', description: 'OpenAI moderations.' },
  { path: '/v1/audio/*',         method: '*', handler: 'passthrough', category: 'passthrough', format: 'openai', description: 'OpenAI audio (transcribe, translate, speech).' },
  { path: '/v1/images/*',        method: '*', handler: 'passthrough', category: 'passthrough', format: 'openai', description: 'OpenAI images (generate, edit, variations).' },
  { path: '/v1/fine_tuning/*',   method: '*', handler: 'passthrough', category: 'passthrough', format: 'openai', description: 'OpenAI fine-tuning APIs.' },
  { path: '/v1/batches',         method: '*', handler: 'passthrough', category: 'passthrough', format: 'openai', description: 'OpenAI batches root.' },
  { path: '/v1/batches/*',       method: '*', handler: 'passthrough', category: 'passthrough', format: 'openai', description: 'OpenAI batches by id.' },
  // Stateful Responses retrieval/cancel are stateful and must hit upstream:
  { path: '/v1/responses/*',     method: '*', handler: 'passthrough', category: 'passthrough', format: 'openai', description: 'GET responses/{id}, POST responses/{id}/cancel — stateful, never local.' },

  // ─── Category 2: Either provider ─────────────────────────────────────────
  { path: '/v1/files',           method: '*', handler: 'passthrough', category: 'passthrough', format: null, description: 'Files endpoint (provider auto-detected from auth).' },
  { path: '/v1/files/*',         method: '*', handler: 'passthrough', category: 'passthrough', format: null, description: 'Files endpoint (provider auto-detected).' },
  { path: '/v1/models',          method: 'GET', handler: 'passthrough', category: 'passthrough', format: null, description: 'Models list — passthrough; Phase G synthesizes local entries.' },
  { path: '/v1/models/*',        method: 'GET', handler: 'passthrough', category: 'passthrough', format: null, description: 'Single model lookup.' },
];

/**
 * Match a path against a route pattern.
 * Supports exact match and trailing-'*' prefix match.
 */
function pathMatches(pattern, actual) {
  if (pattern === actual) return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    return actual === prefix || actual.startsWith(prefix + '/');
  }
  if (pattern.endsWith('*')) {
    return actual.startsWith(pattern.slice(0, -1));
  }
  return false;
}

function methodMatches(routeMethod, actualMethod) {
  return routeMethod === '*' || routeMethod === actualMethod;
}

/**
 * Find the first matching route for a given method + path.
 * Returns the route object or null.
 */
function findRoute(method, path) {
  for (const route of ROUTES) {
    if (methodMatches(route.method, method) && pathMatches(route.path, path)) {
      return route;
    }
  }
  return null;
}

module.exports = {
  ROUTES,
  pathMatches,
  methodMatches,
  findRoute,
};
