# Router API Coverage

> **Auto-generated** from `router/router-table.js`. Do not edit by hand —
> run `npm run docs:router` after changing the route table.

This document is the authoritative endpoint matrix for the AI Router.
Every HTTP path the router accepts is listed below, grouped by how it is
handled.

## Routed endpoints

These endpoints are inspected by the classifier and dispatched to a local model when confidence is high enough; otherwise they fall back to the configured cloud upstream.

| Method | Path | Format | Description |
|--------|------|--------|-------------|
| `POST` | `/v1/messages` | anthropic | Anthropic Messages API — routed local-or-cloud. |
| `POST` | `/v1/chat/completions` | openai | OpenAI Chat Completions — routed local-or-cloud. |
| `POST` | `/v1/responses` | responses | OpenAI Responses API (Codex CLI) — routed. |
| `POST` | `/v1/completions` | openai | OpenAI legacy completions — routed. |
| `POST` | `/v1/embeddings` | openai | Embeddings — preferentially routed to local Ollama. |

## Passthrough endpoints

Forwarded byte-for-byte to the upstream provider. Auth headers are preserved; no body inspection beyond what's required to pick the upstream.

| Method | Path | Format | Description |
|--------|------|--------|-------------|
| `POST` | `/v1/messages/count_tokens` | anthropic | Anthropic token counter — Claude Code calls this constantly. |
| `*` | `/v1/messages/batches` | anthropic | Anthropic message batches root. |
| `*` | `/v1/messages/batches/*` | anthropic | Anthropic message batches by id. |
| `*` | `/v1/skills` | anthropic | Anthropic skills (beta). |
| `*` | `/v1/skills/*` | anthropic | Anthropic skills (beta). |
| `*` | `/v1/agents` | anthropic | Anthropic agents (beta). |
| `*` | `/v1/agents/*` | anthropic | Anthropic agents (beta). |
| `*` | `/v1/sessions` | anthropic | Anthropic sessions (beta). |
| `*` | `/v1/sessions/*` | anthropic | Anthropic sessions (beta). |
| `*` | `/v1/environments` | anthropic | Anthropic environments (beta). |
| `*` | `/v1/environments/*` | anthropic | Anthropic environments (beta). |
| `*` | `/v1/moderations` | openai | OpenAI moderations. |
| `*` | `/v1/audio/*` | openai | OpenAI audio (transcribe, translate, speech). |
| `*` | `/v1/images/*` | openai | OpenAI images (generate, edit, variations). |
| `*` | `/v1/fine_tuning/*` | openai | OpenAI fine-tuning APIs. |
| `*` | `/v1/batches` | openai | OpenAI batches root. |
| `*` | `/v1/batches/*` | openai | OpenAI batches by id. |
| `*` | `/v1/responses/*` | openai | GET responses/{id}, POST responses/{id}/cancel — stateful, never local. |
| `*` | `/v1/files` | — | Files endpoint (provider auto-detected from auth). |
| `*` | `/v1/files/*` | — | Files endpoint (provider auto-detected). |
| `GET` | `/v1/models` | — | Models list — passthrough; Phase G synthesizes local entries. |
| `GET` | `/v1/models/*` | — | Single model lookup. |

## Ops endpoints

Local router endpoints — never proxied. Safe to scrape from monitoring.

| Method | Path | Format | Description |
|--------|------|--------|-------------|
| `GET` | `/health/live` | — | Liveness probe — 200 if process is running. |
| `GET` | `/health/ready` | — | Readiness probe — checks Ollama and upstream reachability. |
| `GET` | `/metrics` | — | Prometheus metrics endpoint (Phase D fills it). |
| `GET` | `/stats` | — | JSON stats snapshot (Phase D fills it). |
| `POST` | `/admin/reload` | — | Reload config without restart (Phase D). |

## Catch-all

Any path not matched by the rows above is forwarded to the upstream provider determined from the auth header. This guarantees forward compatibility with future provider endpoints.

_No explicit rows — handled implicitly by the dispatcher._

| Method | Path | Format | Description |
|--------|------|--------|-------------|
| `*` | `/*` | auto | Forwarded to upstream determined by `Authorization` / `x-api-key` header. |

## Streaming format translation matrix

The router accepts a request in any wire format and may answer it from a
local model whose native output uses a different format. The streaming
translator handles every (request format → local output) pair below.

| Client request format | Local model native | Translation needed |
|-----------------------|--------------------|--------------------|
| Anthropic Messages SSE (`event:`/`data:`)        | Ollama NDJSON     | NDJSON → Anthropic SSE deltas (`message_start`, `content_block_delta`, `message_delta`, `message_stop`) |
| OpenAI Chat Completions SSE (`data: {…}\n\n`)    | Ollama NDJSON     | NDJSON → OpenAI `chat.completion.chunk` frames |
| OpenAI Responses SSE (typed events)              | Ollama NDJSON     | NDJSON → `response.created` / `response.output_text.delta` / `response.completed` |
| Anthropic Messages SSE                            | OpenAI SSE upstream | `chat.completion.chunk` → Anthropic event stream (cloud fallback case) |
| OpenAI Chat SSE                                   | Anthropic SSE upstream | Anthropic events → `chat.completion.chunk` |
| OpenAI Responses SSE                              | OpenAI Chat SSE       | `chat.completion.chunk` → Responses typed events |

Fallback rule: a streaming request may be transparently retried against
the cloud upstream **only before the first chunk is emitted**. Once a byte
of the response body has reached the client, the router commits to the
local stream.

## Field-level translation table

| Concept | Anthropic Messages | OpenAI Chat | OpenAI Responses | Ollama |
|---------|--------------------|-------------|------------------|--------|
| Model               | `model`                              | `model`                       | `model`                       | `model` |
| System prompt       | top-level `system` (string or blocks) | first message `role: system` | `instructions`                | first message `role: system` |
| Conversation        | `messages[]` (`user`/`assistant`)    | `messages[]` (4 roles)        | `input` (string or items)     | `messages[]` |
| Tool definitions    | `tools[].input_schema`               | `tools[].function.parameters` | `tools[].parameters`          | `tools[].function.parameters` |
| Tool call           | content block `tool_use`             | message `tool_calls[]`        | output item `function_call`   | message `tool_calls[]` |
| Tool result         | content block `tool_result`          | message `role: tool`          | input item `function_call_output` | message `role: tool` |
| Stop reason         | `stop_reason`                        | `finish_reason`               | `status` / `incomplete_details` | `done_reason` |
| Usage tokens        | `usage.{input,output}_tokens`        | `usage.{prompt,completion}_tokens` | `usage.{input,output}_tokens` | `prompt_eval_count` / `eval_count` |
| Streaming flag      | `stream: true`                       | `stream: true`                | `stream: true`                | `stream: true` |
| Max tokens          | `max_tokens` (required)              | `max_tokens` (optional)       | `max_output_tokens`           | `options.num_predict` |

