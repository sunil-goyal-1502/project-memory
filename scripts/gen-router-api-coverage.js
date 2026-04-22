#!/usr/bin/env node
"use strict";

/**
 * Generates docs/router-api-coverage.md from router/router-table.js so the
 * coverage matrix can never drift from runtime dispatch.
 *
 * Run: npm run docs:router
 */

const fs = require("fs");
const path = require("path");
const { ROUTES } = require("../router/router-table");

const CATEGORIES = [
  { key: "routed",      title: "Routed endpoints", blurb: "These endpoints are inspected by the classifier and dispatched to a local model when confidence is high enough; otherwise they fall back to the configured cloud upstream." },
  { key: "passthrough", title: "Passthrough endpoints", blurb: "Forwarded byte-for-byte to the upstream provider. Auth headers are preserved; no body inspection beyond what's required to pick the upstream." },
  { key: "ops",         title: "Ops endpoints", blurb: "Local router endpoints — never proxied. Safe to scrape from monitoring." },
  { key: "catchall",    title: "Catch-all", blurb: "Any path not matched by the rows above is forwarded to the upstream provider determined from the auth header. This guarantees forward compatibility with future provider endpoints." },
];

function fmt(v) {
  if (v === null || v === undefined) return "—";
  return String(v);
}

function renderTable(rows) {
  const lines = [];
  lines.push("| Method | Path | Format | Description |");
  lines.push("|--------|------|--------|-------------|");
  for (const r of rows) {
    lines.push(`| \`${r.method}\` | \`${r.path}\` | ${fmt(r.format)} | ${r.description} |`);
  }
  return lines.join("\n");
}

function build() {
  const out = [];
  out.push("# Router API Coverage");
  out.push("");
  out.push("> **Auto-generated** from `router/router-table.js`. Do not edit by hand —");
  out.push("> run `npm run docs:router` after changing the route table.");
  out.push("");
  out.push("This document is the authoritative endpoint matrix for the AI Router.");
  out.push("Every HTTP path the router accepts is listed below, grouped by how it is");
  out.push("handled.");
  out.push("");

  for (const cat of CATEGORIES) {
    const rows = ROUTES.filter(r => r.category === cat.key);
    out.push(`## ${cat.title}`);
    out.push("");
    out.push(cat.blurb);
    out.push("");
    if (rows.length === 0) {
      out.push("_No explicit rows — handled implicitly by the dispatcher._");
      out.push("");
      if (cat.key === "catchall") {
        out.push("| Method | Path | Format | Description |");
        out.push("|--------|------|--------|-------------|");
        out.push("| `*` | `/*` | auto | Forwarded to upstream determined by `Authorization` / `x-api-key` header. |");
        out.push("");
      }
      continue;
    }
    out.push(renderTable(rows));
    out.push("");
  }

  out.push("## Streaming format translation matrix");
  out.push("");
  out.push("The router accepts a request in any wire format and may answer it from a");
  out.push("local model whose native output uses a different format. The streaming");
  out.push("translator handles every (request format → local output) pair below.");
  out.push("");
  out.push("| Client request format | Local model native | Translation needed |");
  out.push("|-----------------------|--------------------|--------------------|");
  out.push("| Anthropic Messages SSE (`event:`/`data:`)        | Ollama NDJSON     | NDJSON → Anthropic SSE deltas (`message_start`, `content_block_delta`, `message_delta`, `message_stop`) |");
  out.push("| OpenAI Chat Completions SSE (`data: {…}\\n\\n`)    | Ollama NDJSON     | NDJSON → OpenAI `chat.completion.chunk` frames |");
  out.push("| OpenAI Responses SSE (typed events)              | Ollama NDJSON     | NDJSON → `response.created` / `response.output_text.delta` / `response.completed` |");
  out.push("| Anthropic Messages SSE                            | OpenAI SSE upstream | `chat.completion.chunk` → Anthropic event stream (cloud fallback case) |");
  out.push("| OpenAI Chat SSE                                   | Anthropic SSE upstream | Anthropic events → `chat.completion.chunk` |");
  out.push("| OpenAI Responses SSE                              | OpenAI Chat SSE       | `chat.completion.chunk` → Responses typed events |");
  out.push("");
  out.push("Fallback rule: a streaming request may be transparently retried against");
  out.push("the cloud upstream **only before the first chunk is emitted**. Once a byte");
  out.push("of the response body has reached the client, the router commits to the");
  out.push("local stream.");
  out.push("");

  out.push("## Field-level translation table");
  out.push("");
  out.push("| Concept | Anthropic Messages | OpenAI Chat | OpenAI Responses | Ollama |");
  out.push("|---------|--------------------|-------------|------------------|--------|");
  out.push("| Model               | `model`                              | `model`                       | `model`                       | `model` |");
  out.push("| System prompt       | top-level `system` (string or blocks) | first message `role: system` | `instructions`                | first message `role: system` |");
  out.push("| Conversation        | `messages[]` (`user`/`assistant`)    | `messages[]` (4 roles)        | `input` (string or items)     | `messages[]` |");
  out.push("| Tool definitions    | `tools[].input_schema`               | `tools[].function.parameters` | `tools[].parameters`          | `tools[].function.parameters` |");
  out.push("| Tool call           | content block `tool_use`             | message `tool_calls[]`        | output item `function_call`   | message `tool_calls[]` |");
  out.push("| Tool result         | content block `tool_result`          | message `role: tool`          | input item `function_call_output` | message `role: tool` |");
  out.push("| Stop reason         | `stop_reason`                        | `finish_reason`               | `status` / `incomplete_details` | `done_reason` |");
  out.push("| Usage tokens        | `usage.{input,output}_tokens`        | `usage.{prompt,completion}_tokens` | `usage.{input,output}_tokens` | `prompt_eval_count` / `eval_count` |");
  out.push("| Streaming flag      | `stream: true`                       | `stream: true`                | `stream: true`                | `stream: true` |");
  out.push("| Max tokens          | `max_tokens` (required)              | `max_tokens` (optional)       | `max_output_tokens`           | `options.num_predict` |");
  out.push("");

  return out.join("\n") + "\n";
}

function main() {
  const md = build();
  const outPath = path.join(__dirname, "..", "docs", "router-api-coverage.md");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, "utf-8");
  console.log(`Wrote ${outPath} (${md.length} bytes, ${ROUTES.length} routes)`);
}

if (require.main === module) main();

module.exports = { build };
