"use strict";

/**
 * Streaming translator end-to-end tests — all 6 cross-format combos plus 3 identities.
 * Feeds canonical source streams into translateStream() and asserts target byte semantics.
 *
 * Run: node test/router/streaming.test.js
 */

const adapter = require("../../router/adapter.js");
const { makeAssert, collectStream } = require("./_mocks.js");
const { Readable } = require("stream");

const A = makeAssert();

// ── Source generators ──────────────────────────────────────────────────────

function anthropicSseSource(text = "Hello world") {
  const evt = (event, data) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const parts = [];
  parts.push(evt("message_start", {
    type: "message_start",
    message: {
      id: "msg_1", type: "message", role: "assistant", model: "claude-3-5-sonnet",
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 0 },
    },
  }));
  parts.push(evt("content_block_start", {
    type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" },
  }));
  for (const ch of text) {
    parts.push(evt("content_block_delta", {
      type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: ch },
    }));
  }
  parts.push(evt("content_block_stop", { type: "content_block_stop", index: 0 }));
  parts.push(evt("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: text.length },
  }));
  parts.push(evt("message_stop", { type: "message_stop" }));
  return Readable.from(parts.map((p) => Buffer.from(p, "utf8")));
}

function openaiSseSource(text = "Hello world") {
  const data = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const parts = [];
  parts.push(data({
    id: "chatcmpl-1", object: "chat.completion.chunk",
    created: 1, model: "gpt-4o-mini",
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  }));
  for (const ch of text) {
    parts.push(data({
      id: "chatcmpl-1", object: "chat.completion.chunk",
      created: 1, model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { content: ch }, finish_reason: null }],
    }));
  }
  parts.push(data({
    id: "chatcmpl-1", object: "chat.completion.chunk",
    created: 1, model: "gpt-4o-mini",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }));
  parts.push("data: [DONE]\n\n");
  return Readable.from(parts.map((p) => Buffer.from(p, "utf8")));
}

function ollamaNdjsonSource(text = "Hello world", model = "llama3.2:3b") {
  const parts = [];
  for (const ch of text) {
    parts.push(JSON.stringify({
      model,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: ch },
      done: false,
    }) + "\n");
  }
  parts.push(JSON.stringify({
    model,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 11,
    eval_count: text.length,
  }) + "\n");
  return Readable.from(parts.map((p) => Buffer.from(p, "utf8")));
}

// ── Pipe helper ────────────────────────────────────────────────────────────

async function pipe(src, translator) {
  return new Promise((resolve, reject) => {
    src.on("error", reject);
    translator.on("error", reject);
    src.pipe(translator);
    collectStream(translator).then(resolve, reject);
  });
}

(async function main() {

  // ── 6 cross-format translators ──

  // A → O
  {
    const out = await pipe(anthropicSseSource("Hi"), adapter.translateStream("anthropic", "openai"));
    A.ok(out.includes('"chat.completion.chunk"'), "A→O: emits chat.completion.chunk frames");
    A.ok(/"content":"H"/.test(out), "A→O: streams 'H' delta");
    A.ok(/"content":"i"/.test(out), "A→O: streams 'i' delta");
    A.ok(/"finish_reason":"stop"/.test(out), "A→O: end_turn → stop");
    A.ok(out.endsWith("data: [DONE]\n\n"), "A→O: ends with [DONE]");
  }

  // A → Ol
  {
    const out = await pipe(anthropicSseSource("Hi"), adapter.translateStream("anthropic", "ollama"));
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    A.ok(lines.length >= 3, "A→Ol: multiple ndjson lines");
    A.ok(lines.slice(0, -1).every((l) => l.done === false), "A→Ol: pre-last lines done=false");
    const last = lines[lines.length - 1];
    A.eq(last.done, true, "A→Ol: last line done=true");
    A.eq(last.done_reason, "stop", "A→Ol: end_turn → stop");
    A.eq(last.eval_count, 2, "A→Ol: eval_count populated");
    A.eq(last.prompt_eval_count, 11, "A→Ol: prompt_eval_count carried over");
  }

  // O → A
  {
    const out = await pipe(openaiSseSource("Hi"), adapter.translateStream("openai", "anthropic"));
    A.ok(/event: message_start/.test(out), "O→A: message_start");
    A.ok(/event: content_block_start/.test(out), "O→A: content_block_start");
    A.ok(/event: content_block_delta/.test(out), "O→A: content_block_delta");
    A.ok(/"text":"H"/.test(out), "O→A: 'H' delta");
    A.ok(/event: content_block_stop/.test(out), "O→A: content_block_stop");
    A.ok(/event: message_stop/.test(out), "O→A: message_stop");
    A.ok(/"stop_reason":"end_turn"/.test(out), "O→A: stop → end_turn");
  }

  // O → Ol
  {
    const out = await pipe(openaiSseSource("Hi"), adapter.translateStream("openai", "ollama"));
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    A.ok(lines.length >= 3, "O→Ol: multiple ndjson lines");
    A.eq(lines[lines.length - 1].done, true, "O→Ol: last done=true");
    A.eq(lines[lines.length - 1].done_reason, "stop", "O→Ol: stop reason mapped");
  }

  // Ol → A
  {
    const out = await pipe(ollamaNdjsonSource("Hi"), adapter.translateStream("ollama", "anthropic"));
    A.ok(/event: message_start/.test(out), "Ol→A: message_start");
    A.ok(/event: content_block_delta/.test(out), "Ol→A: content_block_delta");
    A.ok(/"text":"H"/.test(out), "Ol→A: 'H' delta");
    A.ok(/event: message_stop/.test(out), "Ol→A: message_stop");
  }

  // Ol → O
  {
    const out = await pipe(ollamaNdjsonSource("Hi"), adapter.translateStream("ollama", "openai"));
    A.ok(out.includes('"chat.completion.chunk"'), "Ol→O: chat.completion.chunk");
    A.ok(/"content":"H"/.test(out), "Ol→O: 'H' delta");
    A.ok(/"finish_reason":"stop"/.test(out), "Ol→O: stop finish_reason");
    A.ok(out.endsWith("data: [DONE]\n\n"), "Ol→O: ends with [DONE]");
  }

  // ── 3 identities (passthrough) ──

  for (const fmt of ["anthropic", "openai", "ollama"]) {
    const src = fmt === "anthropic" ? anthropicSseSource("X")
              : fmt === "openai"    ? openaiSseSource("X")
              : ollamaNdjsonSource("X");
    const t = adapter.translateStream(fmt, fmt);
    const out = await pipe(src, t);
    A.ok(out.length > 0, `identity ${fmt}: passthrough has bytes`);
  }

  // ── Chunked input across event boundaries ──
  {
    const text = anthropicSseSource("Hello").read?.() || null;
    // Re-create as small chunks to test buffering
    const parts = [];
    const evt = (e, d) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
    let raw = evt("message_start", {
      type: "message_start",
      message: { id: "x", type: "message", role: "assistant", model: "m",
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1 } },
    });
    raw += evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "AB" } });
    raw += evt("message_stop", { type: "message_stop" });
    // Slice into 7-byte chunks
    const buf = Buffer.from(raw, "utf8");
    const chunks = [];
    for (let i = 0; i < buf.length; i += 7) chunks.push(buf.slice(i, i + 7));
    const src = Readable.from(chunks);
    const out = await pipe(src, adapter.translateStream("anthropic", "openai"));
    A.ok(/"content":"AB"/.test(out), "chunked input: AB delta reassembled");
    A.ok(out.endsWith("data: [DONE]\n\n"), "chunked input: ends with [DONE]");
  }

  const { fail } = A.summary("streaming.test");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
