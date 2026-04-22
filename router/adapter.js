"use strict";

/**
 * adapter.js — format detection and bidirectional translation between
 * Anthropic Messages, OpenAI Chat Completions / Responses, and Ollama
 * native chat formats.
 *
 * Public API:
 *   detectFormat(path, headers, body) → 'anthropic' | 'openai' | 'responses'
 *   toCommon(req, format)             → CommonRequest
 *   fromCommon(commonResponse, fmt)   → format-specific response object
 *   translateStream(srcFmt, dstFmt)   → Transform stream
 *
 * CommonRequest shape:
 *   { messages: [{role, content[, tool_calls, tool_call_id]}],
 *     system: string|null,
 *     tools: [{name, description, parameters}] | null,
 *     params: { model, max_tokens, temperature, top_p, stream, stop, ... },
 *     raw }
 *
 * CommonResponse shape:
 *   { id, model, content: string, tool_calls: [], stop_reason: 'end_turn'|'max_tokens'|'tool_use'|'stop_sequence',
 *     usage: { input_tokens, output_tokens } }
 */

const { Transform } = require('stream');
const crypto = require('crypto');

// ─── Format detection ────────────────────────────────────────────────────────

function detectFormat(pathname, headers, body) {
  if (pathname === '/v1/messages' || pathname.startsWith('/v1/messages/')) return 'anthropic';
  if (pathname === '/v1/chat/completions' || pathname === '/v1/completions') return 'openai';
  if (pathname === '/v1/responses' || pathname.startsWith('/v1/responses/')) return 'responses';
  if (pathname === '/v1/embeddings') return 'openai';
  // Ambiguous: fall back to auth header.
  if (headers) {
    if (headers['x-api-key'] || headers['anthropic-version']) return 'anthropic';
    const auth = headers['authorization'];
    if (auth && /^Bearer\s/i.test(auth)) return 'openai';
  }
  // Last resort body sniffing.
  if (body && typeof body === 'object') {
    if (body.system !== undefined || body.anthropic_version) return 'anthropic';
    if (Array.isArray(body.messages) && body.messages.some((m) => m && m.role === 'system')) return 'openai';
  }
  return 'openai';
}

// ─── Field translation: REQUEST → common ─────────────────────────────────────

function toCommon(body, format) {
  if (format === 'anthropic') return anthropicToCommon(body);
  if (format === 'openai')    return openaiToCommon(body);
  if (format === 'responses') return responsesToCommon(body);
  throw new Error(`toCommon: unknown format ${format}`);
}

function anthropicToCommon(body) {
  const messages = (body.messages || []).map(normaliseAnthropicMessage);
  const system = normaliseAnthropicSystem(body.system);
  const tools = (body.tools || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    parameters: t.input_schema || {},
  }));
  return {
    messages,
    system,
    tools: tools.length ? tools : null,
    params: {
      model: body.model,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      stream: !!body.stream,
      stop: body.stop_sequences,
      tool_choice: body.tool_choice,
    },
    raw: body,
  };
}

function normaliseAnthropicSystem(sys) {
  if (sys == null) return null;
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) {
    return sys.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join('\n');
  }
  return String(sys);
}

function normaliseAnthropicMessage(msg) {
  // Content may be string or array of {type:'text'|'tool_use'|'tool_result',...}
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content };
  }
  if (!Array.isArray(msg.content)) return { role: msg.role, content: '' };
  const parts = [];
  const tool_calls = [];
  const tool_results = [];
  for (const block of msg.content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') parts.push(block.text || '');
    else if (block.type === 'tool_use') {
      tool_calls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      });
    } else if (block.type === 'tool_result') {
      tool_results.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => (c && c.text) || '').join('')
            : JSON.stringify(block.content || ''),
      });
    }
  }
  const out = { role: msg.role, content: parts.join('') };
  if (tool_calls.length) out.tool_calls = tool_calls;
  // Tool results in Anthropic come as user messages — split them out.
  if (tool_results.length) out._tool_results = tool_results;
  return out;
}

function openaiToCommon(body) {
  let system = null;
  const messages = [];
  for (const m of body.messages || []) {
    if (m.role === 'system') {
      system = system ? system + '\n' + flattenContent(m.content) : flattenContent(m.content);
      continue;
    }
    const out = { role: m.role, content: flattenContent(m.content) };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    messages.push(out);
  }
  const tools = (body.tools || []).map((t) => ({
    name: t.function ? t.function.name : t.name,
    description: t.function ? t.function.description : t.description,
    parameters: t.function ? t.function.parameters : t.parameters,
  }));
  return {
    messages,
    system,
    tools: tools.length ? tools : null,
    params: {
      model: body.model,
      max_tokens: body.max_tokens || body.max_completion_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stream: !!body.stream,
      stop: body.stop,
      tool_choice: body.tool_choice,
      response_format: body.response_format,
    },
    raw: body,
  };
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((p) => {
    if (typeof p === 'string') return p;
    if (p && p.type === 'text') return p.text || '';
    return '';
  }).join('');
}

function responsesToCommon(body) {
  // OpenAI Responses API: `input` may be a string or list of message-like items.
  const messages = [];
  let system = body.instructions || null;
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item) continue;
      if (item.role === 'system') {
        system = system ? system + '\n' + flattenContent(item.content) : flattenContent(item.content);
      } else {
        messages.push({ role: item.role || 'user', content: flattenContent(item.content) });
      }
    }
  }
  const tools = (body.tools || []).map((t) => ({
    name: t.name || (t.function && t.function.name),
    description: t.description || (t.function && t.function.description),
    parameters: t.parameters || (t.function && t.function.parameters),
  }));
  return {
    messages,
    system,
    tools: tools.length ? tools : null,
    params: {
      model: body.model,
      max_tokens: body.max_output_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stream: !!body.stream,
    },
    raw: body,
  };
}

// ─── COMMON → format response ────────────────────────────────────────────────

const STOP_REASON_MAP = {
  // common stop_reason → openai finish_reason / ollama done_reason
  end_turn:      { openai: 'stop',         ollama: 'stop'   },
  max_tokens:    { openai: 'length',       ollama: 'length' },
  stop_sequence: { openai: 'stop',         ollama: 'stop'   },
  tool_use:      { openai: 'tool_calls',   ollama: 'stop'   },
};

const FINISH_REASON_TO_COMMON = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
};

function fromCommon(common, format) {
  if (format === 'anthropic') return commonToAnthropic(common);
  if (format === 'openai')    return commonToOpenAI(common);
  if (format === 'responses') return commonToResponses(common);
  throw new Error(`fromCommon: unknown format ${format}`);
}

function commonToAnthropic(c) {
  const content = [];
  if (c.content) content.push({ type: 'text', text: c.content });
  for (const tc of c.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave empty */ }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  return {
    id: c.id || 'msg_' + randomId(),
    type: 'message',
    role: 'assistant',
    model: c.model,
    content,
    stop_reason: c.stop_reason || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: (c.usage && c.usage.input_tokens) || 0,
      output_tokens: (c.usage && c.usage.output_tokens) || 0,
    },
  };
}

function commonToOpenAI(c) {
  return {
    id: c.id || 'chatcmpl-' + randomId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: c.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: c.content || '',
        ...(c.tool_calls && c.tool_calls.length ? { tool_calls: c.tool_calls } : {}),
      },
      finish_reason: (STOP_REASON_MAP[c.stop_reason] && STOP_REASON_MAP[c.stop_reason].openai) || 'stop',
    }],
    usage: {
      prompt_tokens:     (c.usage && c.usage.input_tokens) || 0,
      completion_tokens: (c.usage && c.usage.output_tokens) || 0,
      total_tokens:      ((c.usage && c.usage.input_tokens) || 0) + ((c.usage && c.usage.output_tokens) || 0),
    },
  };
}

function commonToResponses(c) {
  return {
    id: c.id || 'resp_' + randomId(),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: c.model,
    status: 'completed',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: c.content || '' }],
    }],
    usage: {
      input_tokens:  (c.usage && c.usage.input_tokens) || 0,
      output_tokens: (c.usage && c.usage.output_tokens) || 0,
      total_tokens:  ((c.usage && c.usage.input_tokens) || 0) + ((c.usage && c.usage.output_tokens) || 0),
    },
  };
}

/**
 * Translate an Ollama native chat response to a CommonResponse.
 */
function ollamaToCommon(resp) {
  const msg = resp.message || {};
  const tool_calls = (msg.tool_calls || []).map((tc, i) => ({
    id: tc.id || ('call_' + randomId() + '_' + i),
    type: 'function',
    function: {
      name: tc.function ? tc.function.name : tc.name,
      arguments: typeof (tc.function ? tc.function.arguments : tc.arguments) === 'string'
        ? (tc.function ? tc.function.arguments : tc.arguments)
        : JSON.stringify((tc.function ? tc.function.arguments : tc.arguments) || {}),
    },
  }));
  const stop_reason = resp.done_reason === 'length' ? 'max_tokens'
                    : tool_calls.length ? 'tool_use'
                    : 'end_turn';
  return {
    id: 'msg_' + randomId(),
    model: resp.model,
    content: msg.content || '',
    tool_calls,
    stop_reason,
    usage: {
      input_tokens:  resp.prompt_eval_count || 0,
      output_tokens: resp.eval_count || 0,
    },
  };
}

function randomId() {
  return crypto.randomBytes(8).toString('hex');
}

// ─── Streaming translation ───────────────────────────────────────────────────

/**
 * Returns a Transform stream that converts streamed bytes from sourceFormat
 * into chunks of targetFormat, emitting them downstream.
 *
 * Supported source/target formats: 'anthropic' (SSE), 'openai' (SSE), 'ollama' (NDJSON).
 *
 * Identity case (source === target) returns a passthrough Transform.
 */
function translateStream(sourceFormat, targetFormat, opts = {}) {
  if (sourceFormat === targetFormat) {
    return new Transform({ transform(chunk, _, cb) { cb(null, chunk); } });
  }
  const key = `${sourceFormat}->${targetFormat}`;
  const ctor = TRANSLATORS[key];
  if (!ctor) throw new Error(`translateStream: no translator for ${key}`);
  return ctor(opts);
}

// ── Source parsers ──────────────────────────────────────────────────────────

function makeSseLineParser() {
  // Splits on '\n\n' and yields {event, data} for each SSE event.
  let buf = '';
  return function feed(chunkStr, emit) {
    buf += chunkStr;
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = { event: 'message', data: '' };
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) ev.event = line.slice(6).trim();
        else if (line.startsWith('data:')) ev.data += (ev.data ? '\n' : '') + line.slice(5).trim();
      }
      if (ev.data === '[DONE]') { emit({ event: ev.event, done: true }); continue; }
      let parsed = null;
      try { parsed = ev.data ? JSON.parse(ev.data) : null; } catch { /* keep raw */ }
      emit({ event: ev.event, data: parsed, raw: ev.data });
    }
  };
}

function makeNdjsonParser() {
  let buf = '';
  return function feed(chunkStr, emit) {
    buf += chunkStr;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { emit(JSON.parse(line)); } catch { /* skip */ }
    }
  };
}

// ── Emitters ────────────────────────────────────────────────────────────────

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function sseData(data) { return `data: ${JSON.stringify(data)}\n\n`; }
function sseDone() { return `data: [DONE]\n\n`; }

function ndjson(obj) { return JSON.stringify(obj) + '\n'; }

// ── Translator builders ─────────────────────────────────────────────────────

const TRANSLATORS = {
  // Anthropic SSE → OpenAI SSE
  'anthropic->openai'(opts) {
    const parse = makeSseLineParser();
    const id = 'chatcmpl-' + randomId();
    const created = Math.floor(Date.now() / 1000);
    let model = opts.model || '';
    let stop_reason = 'end_turn';
    return new Transform({
      transform(chunk, _, cb) {
        parse(chunk.toString('utf8'), (ev) => {
          if (!ev.data) return;
          if (ev.event === 'message_start' && ev.data.message) {
            model = ev.data.message.model || model;
            this.push(sseData({
              id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            }));
          } else if (ev.event === 'content_block_delta' && ev.data.delta) {
            const text = ev.data.delta.text || '';
            if (text) {
              this.push(sseData({
                id, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
              }));
            }
          } else if (ev.event === 'message_delta' && ev.data.delta) {
            stop_reason = ev.data.delta.stop_reason || stop_reason;
          } else if (ev.event === 'message_stop') {
            const finish = (STOP_REASON_MAP[stop_reason] && STOP_REASON_MAP[stop_reason].openai) || 'stop';
            this.push(sseData({
              id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: {}, finish_reason: finish }],
            }));
            this.push(sseDone());
          }
        });
        cb();
      },
    });
  },

  // Anthropic SSE → Ollama NDJSON
  'anthropic->ollama'(opts) {
    const parse = makeSseLineParser();
    let model = opts.model || '';
    let stop_reason = 'end_turn';
    let prompt_tokens = 0, completion_tokens = 0;
    return new Transform({
      transform(chunk, _, cb) {
        parse(chunk.toString('utf8'), (ev) => {
          if (!ev.data) return;
          if (ev.event === 'message_start' && ev.data.message) {
            model = ev.data.message.model || model;
            const u = ev.data.message.usage || {};
            prompt_tokens = u.input_tokens || 0;
          } else if (ev.event === 'content_block_delta' && ev.data.delta) {
            const text = ev.data.delta.text || '';
            if (text) {
              this.push(ndjson({
                model,
                created_at: new Date().toISOString(),
                message: { role: 'assistant', content: text },
                done: false,
              }));
            }
          } else if (ev.event === 'message_delta') {
            if (ev.data.delta && ev.data.delta.stop_reason) stop_reason = ev.data.delta.stop_reason;
            if (ev.data.usage && ev.data.usage.output_tokens) completion_tokens = ev.data.usage.output_tokens;
          } else if (ev.event === 'message_stop') {
            this.push(ndjson({
              model,
              created_at: new Date().toISOString(),
              message: { role: 'assistant', content: '' },
              done: true,
              done_reason: stop_reason === 'max_tokens' ? 'length' : 'stop',
              prompt_eval_count: prompt_tokens,
              eval_count: completion_tokens,
            }));
          }
        });
        cb();
      },
    });
  },

  // OpenAI SSE → Anthropic SSE
  'openai->anthropic'(opts) {
    const parse = makeSseLineParser();
    const id = 'msg_' + randomId();
    let model = opts.model || '';
    let started = false;
    let blockOpen = false;
    let finish = 'stop';
    return new Transform({
      transform(chunk, _, cb) {
        parse(chunk.toString('utf8'), (ev) => {
          if (ev.done) {
            if (blockOpen) this.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
            this.push(sseEvent('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: FINISH_REASON_TO_COMMON[finish] || 'end_turn', stop_sequence: null },
              usage: { output_tokens: 0 },
            }));
            this.push(sseEvent('message_stop', { type: 'message_stop' }));
            return;
          }
          if (!ev.data) return;
          model = (ev.data.model) || model;
          if (!started) {
            started = true;
            this.push(sseEvent('message_start', {
              type: 'message_start',
              message: {
                id, type: 'message', role: 'assistant', model,
                content: [], stop_reason: null, stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            }));
            this.push(sseEvent('content_block_start', {
              type: 'content_block_start', index: 0,
              content_block: { type: 'text', text: '' },
            }));
            blockOpen = true;
          }
          const choice = (ev.data.choices && ev.data.choices[0]) || {};
          const text = choice.delta && choice.delta.content;
          if (text) {
            this.push(sseEvent('content_block_delta', {
              type: 'content_block_delta', index: 0,
              delta: { type: 'text_delta', text },
            }));
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        });
        cb();
      },
    });
  },

  // OpenAI SSE → Ollama NDJSON
  'openai->ollama'(opts) {
    const parse = makeSseLineParser();
    let model = opts.model || '';
    let finish = null;
    return new Transform({
      transform(chunk, _, cb) {
        parse(chunk.toString('utf8'), (ev) => {
          if (ev.done) {
            this.push(ndjson({
              model,
              created_at: new Date().toISOString(),
              message: { role: 'assistant', content: '' },
              done: true,
              done_reason: finish === 'length' ? 'length' : 'stop',
            }));
            return;
          }
          if (!ev.data) return;
          model = ev.data.model || model;
          const choice = (ev.data.choices && ev.data.choices[0]) || {};
          if (choice.finish_reason) finish = choice.finish_reason;
          const text = choice.delta && choice.delta.content;
          if (text) {
            this.push(ndjson({
              model,
              created_at: new Date().toISOString(),
              message: { role: 'assistant', content: text },
              done: false,
            }));
          }
        });
        cb();
      },
    });
  },

  // Ollama NDJSON → Anthropic SSE
  'ollama->anthropic'(opts) {
    const parse = makeNdjsonParser();
    const id = 'msg_' + randomId();
    let model = opts.model || '';
    let started = false;
    return new Transform({
      transform(chunk, _, cb) {
        parse(chunk.toString('utf8'), (obj) => {
          model = obj.model || model;
          const text = obj.message && obj.message.content;
          if (!started) {
            started = true;
            this.push(sseEvent('message_start', {
              type: 'message_start',
              message: {
                id, type: 'message', role: 'assistant', model,
                content: [], stop_reason: null, stop_sequence: null,
                usage: { input_tokens: obj.prompt_eval_count || 0, output_tokens: 0 },
              },
            }));
            this.push(sseEvent('content_block_start', {
              type: 'content_block_start', index: 0,
              content_block: { type: 'text', text: '' },
            }));
          }
          if (text) {
            this.push(sseEvent('content_block_delta', {
              type: 'content_block_delta', index: 0,
              delta: { type: 'text_delta', text },
            }));
          }
          if (obj.done) {
            this.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
            this.push(sseEvent('message_delta', {
              type: 'message_delta',
              delta: {
                stop_reason: obj.done_reason === 'length' ? 'max_tokens' : 'end_turn',
                stop_sequence: null,
              },
              usage: { output_tokens: obj.eval_count || 0 },
            }));
            this.push(sseEvent('message_stop', { type: 'message_stop' }));
          }
        });
        cb();
      },
    });
  },

  // Ollama NDJSON → OpenAI SSE
  'ollama->openai'(opts) {
    const parse = makeNdjsonParser();
    const id = 'chatcmpl-' + randomId();
    const created = Math.floor(Date.now() / 1000);
    let model = opts.model || '';
    let started = false;
    return new Transform({
      transform(chunk, _, cb) {
        parse(chunk.toString('utf8'), (obj) => {
          model = obj.model || model;
          if (!started) {
            started = true;
            this.push(sseData({
              id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            }));
          }
          const text = obj.message && obj.message.content;
          if (text) {
            this.push(sseData({
              id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            }));
          }
          if (obj.done) {
            this.push(sseData({
              id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: {}, finish_reason: obj.done_reason === 'length' ? 'length' : 'stop' }],
            }));
            this.push(sseDone());
          }
        });
        cb();
      },
    });
  },
};

module.exports = {
  detectFormat,
  toCommon,
  fromCommon,
  ollamaToCommon,
  translateStream,
  // exposed for tests:
  STOP_REASON_MAP,
  FINISH_REASON_TO_COMMON,
  _internals: { makeSseLineParser, makeNdjsonParser, sseEvent, sseData, sseDone, ndjson },
};
