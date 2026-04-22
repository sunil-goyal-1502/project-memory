# Router Integration Guide

Point any client that speaks the Anthropic, OpenAI Chat Completions, or OpenAI
Responses wire format at `http://localhost:8081` (or wherever you set
`ROUTER_PORT`) and you're done. No API changes; the router answers in the
same wire format the client used.

All snippets below assume the router is already running — see
[`ROUTER.md`](../ROUTER.md#quickstart) for setup.

---

## Claude Code (Anthropic CLI)

```bash
export ANTHROPIC_BASE_URL=http://localhost:8081
# Optional but recommended — keeps the auth header attached even when
# the proxy serves the request locally:
export ANTHROPIC_API_KEY=sk-ant-...
claude
```

Persist via your shell rc (`~/.zshrc`, `~/.bashrc`, `~/.config/fish/config.fish`)
or PowerShell `$PROFILE`:

```powershell
[System.Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', 'http://localhost:8081', 'User')
```

---

## Copilot CLI (this CLI)

Copilot CLI talks both Anthropic and OpenAI flavors depending on the model
selected. Set whichever base URL applies to the model you actually use:

```bash
# If using a Claude model
export ANTHROPIC_BASE_URL=http://localhost:8081

# If using a GPT model
export OPENAI_BASE_URL=http://localhost:8081/v1
```

Or pin both in `~/.copilot/config.json`:

```json
{
  "anthropic": { "baseUrl": "http://localhost:8081" },
  "openai":    { "baseUrl": "http://localhost:8081/v1" }
}
```

---

## Codex CLI

Codex uses the OpenAI Responses API. Edit `~/.codex/config.toml`:

```toml
[providers.local-router]
name      = "Local AI Router"
base_url  = "http://localhost:8081/v1"
wire_api  = "responses"
env_key   = "OPENAI_API_KEY"

[default]
provider  = "local-router"
model     = "gpt-4.1"
```

Verify Codex is going through the proxy:

```bash
codex "summarize this file" path/to/file.py
curl -s http://localhost:8081/stats | jq '.routes."/v1/responses"'
```

---

## Cursor

Settings → "OpenAI API Key" panel → "Override OpenAI Base URL":

```
http://localhost:8081/v1
```

Or in `settings.json` (Cursor → Preferences → Open Settings JSON):

```json
{
  "cursor.cpp.disabledLanguages": [],
  "openai.baseUrl": "http://localhost:8081/v1",
  "openai.apiKey": "sk-..."
}
```

Cursor pings `/v1/models` on startup; the router passes that through to
upstream so model picker behavior is unchanged.

---

## OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8081/v1",
    api_key="sk-...",  # forwarded to upstream on fallback
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "hello from the router"}],
)
print(resp.choices[0].message.content)
```

Streaming and tool-calling work unchanged.

---

## OpenAI Node SDK

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8081/v1",
  apiKey:  process.env.OPENAI_API_KEY,
});

const stream = await client.chat.completions.create({
  model: "gpt-4o-mini",
  stream: true,
  messages: [{ role: "user", content: "hi" }],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

---

## Anthropic Python SDK

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:8081",
    api_key="sk-ant-...",
)

resp = client.messages.create(
    model="claude-3-5-sonnet-latest",
    max_tokens=1024,
    messages=[{"role": "user", "content": "hello"}],
)
print(resp.content[0].text)
```

---

## Anthropic Node SDK

```js
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:8081",
  apiKey:  process.env.ANTHROPIC_API_KEY,
});

const msg = await client.messages.create({
  model: "claude-3-5-sonnet-latest",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hello" }],
});
console.log(msg.content[0].text);
```

---

## curl

**Anthropic Messages:**

```bash
curl -s http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-latest",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "What is 17 * 23?"}]
  }'
```

**OpenAI Chat Completions:**

```bash
curl -s http://localhost:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "What is 17 * 23?"}]
  }'
```

**OpenAI Embeddings (served locally by default):**

```bash
curl -s http://localhost:8081/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "text-embedding-3-small",
    "input": "the quick brown fox"
  }'
```

---

## Verify traffic is flowing through the proxy

```bash
# Liveness — should print {"status":"ok"}
curl -s http://localhost:8081/health/live

# Live JSON dashboard
curl -s http://localhost:8081/stats | jq

# Prometheus scrape
curl -s http://localhost:8081/metrics | head -20

# Per-decision trace
node router/cli.js stats --since 1h
```

If you see `requests_total` ticking up while you use your client, the proxy
is wired correctly. If `routed_local_total` is 0 but you expect local routes,
check `node router/cli.js status` for Ollama reachability and confirm
`ROUTER_MODE` isn't `disabled`.

See also: [`ROUTER.md` → Troubleshooting](../ROUTER.md#troubleshooting).
