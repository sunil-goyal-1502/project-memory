"use strict";

/**
 * Adapter unit tests — request/response field translation, no streams.
 * Streaming is covered separately by streaming.test.js.
 *
 * Run: node test/router/adapter.test.js
 */

const adapter = require("../../router/adapter.js");
const { makeAssert } = require("./_mocks.js");
const A = makeAssert();

// ─── detectFormat ──────────────────────────────────────────────────────────
A.eq(adapter.detectFormat("/v1/messages", {}, {}), "anthropic", "detectFormat /v1/messages");
A.eq(adapter.detectFormat("/v1/messages/count_tokens", {}, {}), "anthropic", "messages/count_tokens");
A.eq(adapter.detectFormat("/v1/chat/completions", {}, {}), "openai", "openai chat");
A.eq(adapter.detectFormat("/v1/responses", {}, {}), "responses", "responses");
A.eq(adapter.detectFormat("/v1/embeddings", {}, {}), "openai", "embeddings → openai");
A.eq(adapter.detectFormat("/foo", { "x-api-key": "k" }, null), "anthropic",
  "x-api-key → anthropic");
A.eq(adapter.detectFormat("/foo", { authorization: "Bearer x" }, null), "openai",
  "Bearer → openai");
A.eq(adapter.detectFormat("/foo", {}, { anthropic_version: "2023" }), "anthropic",
  "body sniff anthropic_version");
A.eq(adapter.detectFormat("/foo", {}, {}), "openai", "default → openai");

// ─── toCommon: anthropic ──────────────────────────────────────────────────
{
  const body = {
    model: "claude-3-5-sonnet-latest",
    max_tokens: 1024,
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    stream: false,
    stop_sequences: ["END"],
    system: "You are a helper.",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: [
        { type: "text", text: "Continue" },
        { type: "tool_use", id: "tu_1", name: "calc", input: { x: 1 } },
      ] },
    ],
    tools: [{ name: "calc", description: "math", input_schema: { type: "object" } }],
  };
  const c = adapter.toCommon(body, "anthropic");
  A.eq(c.system, "You are a helper.", "anthropic: system flattened");
  A.eq(c.messages.length, 3, "anthropic: 3 messages");
  A.eq(c.messages[0].content, "Hello", "anthropic: string content preserved");
  A.eq(c.messages[2].content, "Continue", "anthropic: text-block flattened");
  A.ok(Array.isArray(c.messages[2].tool_calls) && c.messages[2].tool_calls.length === 1,
    "anthropic: tool_use → tool_calls");
  A.eq(c.messages[2].tool_calls[0].function.name, "calc", "anthropic: tool name");
  A.eq(c.tools.length, 1, "anthropic: tools translated");
  A.eq(c.tools[0].parameters.type, "object", "anthropic: input_schema → parameters");
  A.eq(c.params.model, "claude-3-5-sonnet-latest", "anthropic: model preserved");
  A.eq(c.params.max_tokens, 1024, "anthropic: max_tokens preserved");
  A.eq(c.params.stop[0], "END", "anthropic: stop_sequences → stop");
}

// ─── toCommon: openai ──────────────────────────────────────────────────────
{
  const body = {
    model: "gpt-4o-mini",
    max_tokens: 512,
    temperature: 0.5,
    stream: true,
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello", tool_calls: [
        { id: "c1", type: "function", function: { name: "x", arguments: "{}" } }
      ] },
      { role: "tool", tool_call_id: "c1", content: "42" },
    ],
    tools: [{ type: "function", function: { name: "x", description: "d", parameters: {} } }],
  };
  const c = adapter.toCommon(body, "openai");
  A.eq(c.system, "be brief", "openai: system extracted");
  A.eq(c.messages.length, 3, "openai: system filtered out, 3 remain");
  A.eq(c.messages[1].tool_calls[0].function.name, "x", "openai: tool_calls preserved");
  A.eq(c.messages[2].tool_call_id, "c1", "openai: tool_call_id preserved");
  A.eq(c.tools[0].name, "x", "openai: tools normalized");
  A.eq(c.params.stream, true, "openai: stream=true");
}

// ─── toCommon: responses ───────────────────────────────────────────────────
{
  const c = adapter.toCommon({
    model: "gpt-5",
    instructions: "be terse",
    input: "Hello world",
    max_output_tokens: 200,
  }, "responses");
  A.eq(c.system, "be terse", "responses: instructions → system");
  A.eq(c.messages[0].content, "Hello world", "responses: string input");
  A.eq(c.params.max_tokens, 200, "responses: max_output_tokens → max_tokens");
}

{
  const c = adapter.toCommon({
    model: "gpt-5",
    input: [
      { role: "system", content: "x" },
      { role: "user", content: "y" },
    ],
  }, "responses");
  A.eq(c.system, "x", "responses: array input system");
  A.eq(c.messages[0].content, "y", "responses: array input user");
}

A.throws(() => adapter.toCommon({}, "garbage"), /unknown format/, "toCommon: unknown format throws");

// ─── fromCommon round-trips ────────────────────────────────────────────────
const common = {
  id: "msg_abc",
  model: "claude-3-5-sonnet-latest",
  content: "Hello!",
  tool_calls: [
    { id: "c1", type: "function", function: { name: "calc", arguments: '{"x":1}' } }
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
};

{
  const r = adapter.fromCommon(common, "anthropic");
  A.eq(r.type, "message", "anthropic resp: type=message");
  A.eq(r.role, "assistant", "anthropic resp: role=assistant");
  A.eq(r.content[0].type, "text", "anthropic resp: text block");
  A.eq(r.content[0].text, "Hello!", "anthropic resp: text content");
  A.eq(r.content[1].type, "tool_use", "anthropic resp: tool_use block");
  A.eq(r.content[1].name, "calc", "anthropic resp: tool name");
  A.eq(r.content[1].input.x, 1, "anthropic resp: tool input parsed");
  A.eq(r.usage.input_tokens, 10, "anthropic resp: usage.input_tokens");
  A.eq(r.usage.output_tokens, 5, "anthropic resp: usage.output_tokens");
  A.eq(r.stop_reason, "end_turn", "anthropic resp: stop_reason");
}

{
  const r = adapter.fromCommon(common, "openai");
  A.eq(r.object, "chat.completion", "openai resp: chat.completion");
  A.eq(r.choices[0].message.content, "Hello!", "openai resp: content");
  A.eq(r.choices[0].message.tool_calls[0].function.name, "calc", "openai resp: tool_calls");
  A.eq(r.choices[0].finish_reason, "stop", "openai resp: end_turn → stop");
  A.eq(r.usage.prompt_tokens, 10, "openai resp: prompt_tokens");
  A.eq(r.usage.completion_tokens, 5, "openai resp: completion_tokens");
  A.eq(r.usage.total_tokens, 15, "openai resp: total_tokens");
}

// finish_reason mapping for tool_use
{
  const c2 = { ...common, stop_reason: "tool_use" };
  const r = adapter.fromCommon(c2, "openai");
  A.eq(r.choices[0].finish_reason, "tool_calls", "openai resp: tool_use → tool_calls");
}
{
  const c3 = { ...common, stop_reason: "max_tokens" };
  const r = adapter.fromCommon(c3, "openai");
  A.eq(r.choices[0].finish_reason, "length", "openai resp: max_tokens → length");
}

{
  const r = adapter.fromCommon(common, "responses");
  A.eq(r.object, "response", "responses resp: object=response");
  A.eq(r.status, "completed", "responses resp: status=completed");
  A.eq(r.output[0].content[0].text, "Hello!", "responses resp: text content");
  A.eq(r.usage.input_tokens, 10, "responses resp: input_tokens");
  A.eq(r.usage.total_tokens, 15, "responses resp: total_tokens");
}

A.throws(() => adapter.fromCommon(common, "garbage"), /unknown format/, "fromCommon: unknown format throws");

// ─── ollamaToCommon ────────────────────────────────────────────────────────
{
  const r = adapter.ollamaToCommon({
    model: "llama3.2:3b",
    message: { role: "assistant", content: "Hi", tool_calls: [
      { function: { name: "calc", arguments: { x: 1 } } }
    ] },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 7,
    eval_count: 3,
  });
  A.eq(r.content, "Hi", "ollamaToCommon: content");
  A.eq(r.model, "llama3.2:3b", "ollamaToCommon: model");
  A.eq(r.tool_calls[0].function.name, "calc", "ollamaToCommon: tool name");
  A.eq(typeof r.tool_calls[0].function.arguments, "string",
    "ollamaToCommon: arguments stringified");
  A.eq(JSON.parse(r.tool_calls[0].function.arguments).x, 1,
    "ollamaToCommon: arguments preserved");
  A.eq(r.stop_reason, "tool_use", "ollamaToCommon: tool_calls → stop_reason=tool_use");
  A.eq(r.usage.input_tokens, 7, "ollamaToCommon: prompt_eval_count → input_tokens");
  A.eq(r.usage.output_tokens, 3, "ollamaToCommon: eval_count → output_tokens");
}

{
  const r = adapter.ollamaToCommon({
    model: "llama3.2:3b",
    message: { role: "assistant", content: "ok" },
    done_reason: "length",
    prompt_eval_count: 1,
    eval_count: 1,
  });
  A.eq(r.stop_reason, "max_tokens", "ollamaToCommon: done_reason=length → max_tokens");
}

// ─── translateStream existence (all 6 + 3 identities) ─────────────────────
const FORMATS = ["anthropic", "openai", "ollama"];
for (const src of FORMATS) {
  for (const dst of FORMATS) {
    const t = adapter.translateStream(src, dst);
    A.ok(t && typeof t.write === "function" && typeof t.read === "function",
      `translateStream(${src}→${dst}) returns Transform`);
  }
}

A.throws(() => adapter.translateStream("xx", "yy"), /no translator/,
  "translateStream: unknown pair throws");

// ─── STOP_REASON_MAP coverage ─────────────────────────────────────────────
A.eq(adapter.STOP_REASON_MAP.end_turn.openai, "stop", "STOP_REASON_MAP.end_turn.openai");
A.eq(adapter.STOP_REASON_MAP.tool_use.openai, "tool_calls", "STOP_REASON_MAP.tool_use.openai");
A.eq(adapter.STOP_REASON_MAP.max_tokens.ollama, "length", "STOP_REASON_MAP.max_tokens.ollama");
A.eq(adapter.FINISH_REASON_TO_COMMON.length, "max_tokens", "FINISH_REASON_TO_COMMON.length");
A.eq(adapter.FINISH_REASON_TO_COMMON.tool_calls, "tool_use", "FINISH_REASON_TO_COMMON.tool_calls");

const { fail } = A.summary("adapter.test");
process.exit(fail === 0 ? 0 : 1);
