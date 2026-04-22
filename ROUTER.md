# AI Router

A local-first HTTP proxy that sits in front of Anthropic, OpenAI, and Codex
APIs and transparently serves a chunk of your traffic from a model running
on your own machine via [Ollama](https://ollama.com). Simple prompts and
embeddings stay local (zero tokens billed); complex prompts fall back to the
cloud upstream. Wire-format compatible with every major coding CLI and SDK
out of the box — point your client at `http://localhost:8081` and nothing else
changes.

> Status: Phases A–E shipped. Single dependency-light Node process, no
> Python, no Docker, no external services beyond Ollama.

---

## Quickstart

```bash
# 1. Install Ollama (https://ollama.com/download)
#    macOS:    brew install ollama
#    Windows:  winget install Ollama.Ollama
#    Linux:    curl -fsSL https://ollama.com/install.sh | sh

# 2. Pull the recommended models (one-time, ~6 GB total)
ollama pull llama3.2:3b          # simple/chat tier
ollama pull qwen2.5-coder:7b     # code tier
ollama pull nomic-embed-text     # embeddings tier

# 3. Start the router (binds 127.0.0.1:8081)
npm run router:start
# or directly:
node router/index.js
# or via the CLI shim:
node router/cli.js start

# 4. Point any client at it. For Claude Code:
export ANTHROPIC_BASE_URL=http://localhost:8081
claude

# 5. Watch traffic
node router/cli.js stats
curl -s http://localhost:8081/stats | jq
```

Per-client snippets (Claude CLI, Copilot CLI, Codex CLI, Cursor, OpenAI/Anthropic
SDKs, curl) live in [`docs/router-integration.md`](docs/router-integration.md).

---

## Configuration

All settings can be set via env var **or** via `~/.ai-router/config.json`
(env wins). The router watches the config file and hot-reloads on change;
you can also force a reload with `POST /admin/reload` or `node router/cli.js reload`.

| Env var | Default | Description |
|---------|---------|-------------|
| `ROUTER_PORT` | `8081` | TCP port to bind on `127.0.0.1`. |
| `MODEL_PROVIDER` | `ollama` | Local model provider. Only `ollama` is supported today. |
| `TIER_SIMPLE` | `llama3.2:3b` | Model used for chat / Q&A / summarization tier. |
| `TIER_COMPLEX` | `null` | Optional larger local model for "complex" tier. `null` means: send complex prompts to the cloud. |
| `TIER_CODE` | `qwen2.5-coder:7b` | Model used when the classifier detects a code/diff/refactor task. |
| `TIER_EMBED` | `nomic-embed-text` | Model used to serve `/v1/embeddings` locally. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama HTTP endpoint. |
| `OLLAMA_MODEL` | `llama3.2:3b` | Default model passed to Ollama when no tier-specific override applies. |
| `ROUTER_MODE` | `balanced` | Routing aggressiveness — see [Modes](#modes). |
| `ROUTER_PRIVACY_MODE` | `false` | If `true`, never fall back to cloud. Confidence misses return a 503 instead of leaking the prompt. |
| `ROUTER_FALLBACK_ON_LOW_CONFIDENCE` | `true` | If `false`, low-confidence local responses are returned as-is instead of retrying upstream. |
| `ROUTER_ROUTE_EMBEDDINGS` | `true` | When `false`, all `/v1/embeddings` calls bypass the local model. |
| `ANTHROPIC_UPSTREAM_URL` | `https://api.anthropic.com` | Cloud Anthropic upstream for fallback / passthrough. |
| `OPENAI_UPSTREAM_URL` | `https://api.openai.com` | Cloud OpenAI upstream for fallback / passthrough. |
| `ROUTER_CACHE_TTL_HOURS` | `24` | Prompt-cache entry TTL. |
| `ROUTER_CACHE_SEMANTIC_THRESHOLD` | `0.92` | Cosine similarity threshold for semantic cache hits. |
| `ROUTER_DB_DIR` | `~/.ai-router` | Directory for `stats.db`, `cache.db`, and `config.json`. Mostly for tests. |

### Auth headers

The router does not store or look at API keys. Whatever `Authorization` /
`x-api-key` header your client sends is forwarded verbatim to the upstream
when fallback or passthrough fires. If you only ever route locally (privacy
mode + simple traffic), you don't need a cloud API key at all.

---

## Modes

Set with `ROUTER_MODE` or in `config.json`. Affects the confidence threshold
the classifier needs to clear to keep a prompt local.

| Mode | Threshold | Behavior | Use when |
|------|-----------|----------|----------|
| `aggressive`   | low (≈0.40) | Routes anything plausibly local. ~40–60% of typical coding traffic stays on-device. May lose some quality on borderline prompts. | You want maximum cost savings and don't mind occasional re-tries. |
| `balanced`     | medium (≈0.60) | Default. Conservative on tool-using or long-context prompts; aggressive on Q&A / lookup / short edits. | Day-to-day use. |
| `conservative` | high (≈0.80) | Only obvious local wins (tiny prompts, embeddings, single-shot summarize). | You're shipping production traffic through the proxy. |
| `disabled`     | n/a | Pure passthrough. Every request is forwarded to the upstream. Useful as an escape hatch when debugging. | "Is the bug me or the router?" |

Concrete examples (balanced mode):

| Prompt | Decision |
|--------|----------|
| "What's the Python type for a deque?" | local (`tier_simple`) |
| `<5KB diff> "review this for bugs"` | local (`tier_code`) |
| `<60KB context> "refactor this module"` | cloud |
| `tools: [Bash, Edit, Read, Glob, ...]` (4+ tools) | cloud (forced) |
| Embeddings for semantic search | local (`tier_embed`) |

---

## Privacy mode

Set `ROUTER_PRIVACY_MODE=true` to guarantee that nothing in the request body
is ever sent to a cloud provider. The router will:

- Serve the request locally if confidence passes.
- Return HTTP `503 router_privacy_blocked` if the classifier or runtime
  fallback would have routed the prompt to the cloud.
- Continue to passthrough the auth-header-only ops endpoints (e.g.
  `/v1/models` listings) so clients don't break.

Combine with `ROUTER_FALLBACK_ON_LOW_CONFIDENCE=false` to silence retries
entirely.

---

## Stats and Prometheus metrics

Two endpoints expose what the router has done:

- **`GET /stats`** — JSON dashboard. Tokens saved, routed vs. fallback ratio,
  cache hit rate, p50/p95 latency per route, top models by usage. Same data
  is available pretty-printed via `node router/cli.js stats [--since 1h|24h|7d]`.
- **`GET /metrics`** — Prometheus exposition format. Series:
  - `router_up` (gauge)
  - `router_uptime_seconds` (gauge)
  - `airouter_requests_total{provider,model,status}` (counter)
  - `airouter_cache_hit_ratio` (gauge, 24h window)
  - `airouter_fallback_ratio` (gauge, 24h window)
  - `airouter_request_latency_ms` (histogram)

Scrape `/metrics` from Prometheus or any compatible agent. Both endpoints
bind to `127.0.0.1` only — there's no auth, so don't expose them externally.

---

## CLI reference

```text
ai-router — local LLM proxy router

Usage:
  ai-router <command> [options]

Commands:
  start [--port N] [--detach]   Start the router server.
                                --port overrides ROUTER_PORT for this run.
                                --detach forks the process and exits.
  stop                          Stop the running router (SIGTERM via PID file).
  status                        Print PID, port, uptime, and probe /health/ready.
  reload                        POST /admin/reload — re-reads config.json + env.
  stats [--since 24h|7d|1h]     Print the usage dashboard. --json emits raw JSON.
        [--json]
  test                          Send a battery of sample prompts and print the
                                routing decision (model + reason) for each. Does
                                not require Ollama to be running.
  config [--show|--edit]        --show prints the resolved config.
                                --edit opens ~/.ai-router/config.json in $EDITOR.
  models                        List installed Ollama models and recommend a
                                tier mapping for each.
  verify                        Fire Category 2 passthrough smoke tests against
                                a running router (requires upstream creds).
  --help, -h                    Show this message.
```

Invoke as `node router/cli.js <command>` or, after `npm install -g .`, simply
`ai-router <command>`.

---

## Troubleshooting

**Ollama not running.** `node router/cli.js status` shows
`ollama: unreachable`. Start it: `ollama serve` (Linux/macOS) or launch the
Ollama tray app (Windows). The router still serves passthrough traffic — only
the routed/local paths fail.

**Model not pulled.** The first request to a tier you haven't pulled returns
`502 model_not_found`. Run `ollama pull <model>` (e.g. `ollama pull llama3.2:3b`)
and retry. `node router/cli.js models` prints what's installed vs. what each
tier expects.

**Low-confidence loop.** If you see `fallback_ratio` climbing above 0.5 in
`/stats`, the classifier is sending things local that the local model can't
answer well. Bump `ROUTER_MODE` from `aggressive` → `balanced`, or set a
larger `TIER_COMPLEX` model so non-trivial prompts have a local home.

**Circuit breaker stuck open.** After repeated upstream failures the breaker
opens for 30s and short-circuits with `503 upstream_unavailable`. Wait, or
force-clear with `node router/cli.js reload`. Check `/stats` → `breakers`
for the per-upstream state.

**Port conflict.** `Error: listen EADDRINUSE :::8081`. Either stop whatever
owns 8081 (`netstat -ano | findstr 8081` on Windows) or set `ROUTER_PORT` to
a free port and update your client `BASE_URL` to match.

**Claude Code is broken.** Confirm `/v1/messages/count_tokens` is being
proxied correctly: `curl -s -X POST http://localhost:8081/v1/messages/count_tokens
-H 'x-api-key: $ANTHROPIC_API_KEY' -H 'anthropic-version: 2023-06-01' -d '{...}'`.
This endpoint is explicit passthrough — if it 404s, your `router-table.js` is
out of sync (run `npm run docs:router` to regenerate the matrix).

---

## Recommended Ollama models per tier

| Tier | Default | Lightweight (≤4 GB RAM) | Stronger (≥16 GB) |
|------|---------|-------------------------|-------------------|
| `tier_simple` (chat / Q&A / summarize) | `llama3.2:3b` | `llama3.2:1b`, `qwen2.5:1.5b` | `llama3.1:8b`, `qwen2.5:7b` |
| `tier_code`   (diffs / refactors)      | `qwen2.5-coder:7b` | `qwen2.5-coder:1.5b`, `deepseek-coder:1.3b` | `qwen2.5-coder:14b`, `deepseek-coder-v2:16b` |
| `tier_complex` (long-context reasoning, optional) | _disabled_ | leave unset → cloud | `llama3.1:70b-instruct-q4_K_M`, `qwen2.5:32b` |
| `tier_embed`  (semantic search)        | `nomic-embed-text` | same | `mxbai-embed-large` (1024-d) |

Set with the matching `TIER_*` env var. You can mix and match per machine.

---

## Performance characteristics

Numbers below are measured on an M2 Pro / 32 GB machine running
`llama3.2:3b` with `keep_alive: 5m`. Expect ±2× variation on other hardware.

| Metric | Typical |
|--------|---------|
| Classifier decision latency | < 5 ms (heuristics) / 15–40 ms (semantic) |
| Local first-token latency (warm) | 80–200 ms |
| Local throughput (3B model) | 60–120 tok/s |
| Cache hit (exact) latency | < 2 ms |
| Cache hit (semantic) latency | 20–50 ms |
| Cache hit rate, typical coding session | 20–35 % |
| Local routing rate, balanced mode | 35–55 % |
| Fallback rate (local→cloud, balanced) | < 10 % |

The classifier and embedding model both stay resident; first request after a
cold start pays a ~1 s warm-up.

---

## Related docs

- [`docs/router-integration.md`](docs/router-integration.md) — copy-paste
  client setup snippets.
- [`docs/router-api-coverage.md`](docs/router-api-coverage.md) — full
  endpoint matrix (auto-generated from `router/router-table.js`).
