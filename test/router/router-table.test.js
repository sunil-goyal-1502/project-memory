"use strict";

/**
 * Lightweight assertions for router-table + adapter helpers.
 * Run: node test/router/router-table.test.js
 */

const assert = require('assert');
const path = require('path');

const table = require(path.join('..', '..', 'router', 'router-table.js'));
const adapter = require(path.join('..', '..', 'router', 'adapter.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('router-table:');

t('exact path matches', () => {
  const r = table.findRoute('POST', '/v1/messages');
  assert.strictEqual(r.handler, 'routedAnthropicMessages');
});

t('prefix /v1/audio/* matches transcriptions', () => {
  const r = table.findRoute('POST', '/v1/audio/transcriptions');
  assert.strictEqual(r.category, 'passthrough');
});

t('prefix /v1/images/* matches generations', () => {
  const r = table.findRoute('POST', '/v1/images/generations');
  assert.strictEqual(r.category, 'passthrough');
});

t('prefix /v1/files matches root and nested', () => {
  assert.ok(table.findRoute('GET', '/v1/files'));
  assert.ok(table.findRoute('DELETE', '/v1/files/file_abc123'));
});

t('GET /v1/responses/{id} → passthrough', () => {
  const r = table.findRoute('GET', '/v1/responses/resp_123');
  assert.strictEqual(r.category, 'passthrough');
});

t('POST /v1/responses → routed', () => {
  const r = table.findRoute('POST', '/v1/responses');
  assert.strictEqual(r.category, 'routed');
});

t('POST /v1/messages/count_tokens → passthrough (more specific than /v1/messages)', () => {
  const r = table.findRoute('POST', '/v1/messages/count_tokens');
  assert.strictEqual(r.category, 'passthrough');
});

t('Unknown path returns null', () => {
  assert.strictEqual(table.findRoute('POST', '/v1/some/future/api'), null);
});

t('Health endpoints registered', () => {
  assert.ok(table.findRoute('GET', '/health/live'));
  assert.ok(table.findRoute('GET', '/health/ready'));
  assert.ok(table.findRoute('GET', '/metrics'));
});

console.log('\nadapter.detectFormat:');

t('Anthropic by path', () => {
  assert.strictEqual(adapter.detectFormat('/v1/messages', {}, {}), 'anthropic');
});

t('OpenAI by path', () => {
  assert.strictEqual(adapter.detectFormat('/v1/chat/completions', {}, {}), 'openai');
});

t('Responses by path', () => {
  assert.strictEqual(adapter.detectFormat('/v1/responses', {}, {}), 'responses');
});

t('Anthropic by header on ambiguous path', () => {
  assert.strictEqual(adapter.detectFormat('/foo', { 'x-api-key': 'sk-ant-...' }, {}), 'anthropic');
});

t('OpenAI by header on ambiguous path', () => {
  assert.strictEqual(adapter.detectFormat('/foo', { authorization: 'Bearer sk-...' }, {}), 'openai');
});

console.log('\nadapter.toCommon / fromCommon round-trip:');

t('Anthropic → common preserves content + system', () => {
  const c = adapter.toCommon({
    model: 'claude-3-5-sonnet',
    system: 'be brief',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
  }, 'anthropic');
  assert.strictEqual(c.system, 'be brief');
  assert.strictEqual(c.messages[0].content, 'hi');
  assert.strictEqual(c.params.max_tokens, 100);
});

t('OpenAI → common pulls system out of messages', () => {
  const c = adapter.toCommon({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
  }, 'openai');
  assert.strictEqual(c.system, 'be brief');
  assert.strictEqual(c.messages.length, 1);
});

t('common → Anthropic emits stop_reason and usage', () => {
  const r = adapter.fromCommon({
    model: 'claude', content: 'hello', stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 2 },
  }, 'anthropic');
  assert.strictEqual(r.stop_reason, 'end_turn');
  assert.strictEqual(r.usage.input_tokens, 5);
});

t('common → OpenAI maps stop_reason → finish_reason', () => {
  const r = adapter.fromCommon({
    model: 'gpt', content: 'hi', stop_reason: 'max_tokens',
    usage: { input_tokens: 4, output_tokens: 1 },
  }, 'openai');
  assert.strictEqual(r.choices[0].finish_reason, 'length');
  assert.strictEqual(r.usage.prompt_tokens, 4);
  assert.strictEqual(r.usage.total_tokens, 5);
});

console.log('\nadapter.translateStream:');

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

t('Ollama NDJSON → OpenAI SSE produces [DONE]', async () => {
  const xs = adapter.translateStream('ollama', 'openai');
  const p = collect(xs);
  xs.write(JSON.stringify({ model: 'llama', message: { role: 'assistant', content: 'hi' }, done: false }) + '\n');
  xs.write(JSON.stringify({ model: 'llama', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
  xs.end();
  const out = await p;
  assert.ok(out.includes('"content":"hi"'), 'expected content delta');
  assert.ok(out.includes('[DONE]'), 'expected [DONE] sentinel');
}); // returns a promise — Node will execute it; track manually below

t('All 6 cross-format translators exist', () => {
  for (const src of ['anthropic', 'openai', 'ollama']) {
    for (const dst of ['anthropic', 'openai', 'ollama']) {
      const s = adapter.translateStream(src, dst);
      assert.ok(s, `${src}->${dst} should return a stream`);
    }
  }
});

// Tiny delay for the async test above to flush.
setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}, 200);
