#!/usr/bin/env node
"use strict";

/**
 * ai-router CLI — start/stop/status/reload/stats/test/config/models/verify.
 *
 * Phase A may have written a thin start stub at router/index.js; this CLI
 * shells into that or directly into router/server.js when present. It
 * intentionally does NOT depend on Phase A files at require-time.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

const config = require("./config.js");
const stats = require("./stats.js");

const HOME = os.homedir();
const ROUTER_DIR = config.ROUTER_DIR;
const PID_FILE = path.join(ROUTER_DIR, "router.pid");
const LOG_FILE = path.join(ROUTER_DIR, "router.log");

// ── arg parsing ──────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) { out.flags[a.slice(2)] = next; i++; }
        else out.flags[a.slice(2)] = true;
      }
    } else out._.push(a);
  }
  return out;
}

function help() {
  console.log(`ai-router — local LLM proxy router

Usage:
  ai-router <command> [options]

Commands:
  start [--port N] [--detach]   Start the router server
  stop                          Stop the running router
  status                        Show running status + /health/ready probe
  reload                        Trigger POST /admin/reload (hot config reload)
  stats [--since 24h|7d|1h] [--json]
                                Show usage dashboard
  test                          Send sample prompts and print routing decisions
  config [--show|--edit]        Show current config or open config.json in $EDITOR
  models                        List installed Ollama models + tier recommendations
  verify                        Run Category 2 passthrough smoke tests
  --help, -h                    Show this help
`);
}

// ── PID + HTTP helpers ───────────────────────────────────────

function ensureDir() { try { fs.mkdirSync(ROUTER_DIR, { recursive: true }); } catch {} }

function readPid() {
  try { return Number(fs.readFileSync(PID_FILE, "utf-8").trim()) || null; }
  catch { return null; }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function httpJson(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request({
      method,
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: Object.assign({ "content-type": "application/json" }, headers || {}),
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        let data = text;
        try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, text });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    if (body !== undefined && body !== null) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function baseUrl() {
  const cfg = config.getConfig();
  return `http://127.0.0.1:${cfg.router_port}`;
}

// ── Commands ─────────────────────────────────────────────────

function locateServerEntry() {
  const candidates = [
    path.join(__dirname, "index.js"),
    path.join(__dirname, "server.js"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

async function cmdStart(flags) {
  const existing = readPid();
  if (isAlive(existing)) {
    console.log(`Router already running (pid ${existing})`);
    return 0;
  }
  const entry = locateServerEntry();
  if (!entry) {
    console.error("Cannot start: router/index.js or router/server.js not found (Phase A not yet implemented).");
    return 2;
  }
  ensureDir();
  if (flags.port) process.env.ROUTER_PORT = String(flags.port);

  if (flags.detach) {
    const out = fs.openSync(LOG_FILE, "a");
    const err = fs.openSync(LOG_FILE, "a");
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ["ignore", out, err],
      env: process.env,
    });
    fs.writeFileSync(PID_FILE, String(child.pid));
    child.unref();
    console.log(`Router started (pid ${child.pid}) — logs: ${LOG_FILE}`);
    return 0;
  }

  // Foreground
  fs.writeFileSync(PID_FILE, String(process.pid));
  require(entry);
  return 0;
}

function cmdStop() {
  const pid = readPid();
  if (!isAlive(pid)) {
    console.log("Router not running");
    try { fs.unlinkSync(PID_FILE); } catch {}
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to pid ${pid}`);
    try { fs.unlinkSync(PID_FILE); } catch {}
    return 0;
  } catch (e) {
    console.error(`Failed to stop pid ${pid}: ${e.message}`);
    return 1;
  }
}

async function cmdStatus() {
  const pid = readPid();
  const alive = isAlive(pid);
  console.log(`PID file: ${PID_FILE}`);
  console.log(`PID:      ${pid || "(none)"}`);
  console.log(`Process:  ${alive ? "running" : "not running"}`);
  if (!alive) return 0;
  try {
    const res = await httpJson("GET", baseUrl() + "/health/ready");
    console.log(`Health:   ${res.status} ${typeof res.body === "string" ? res.body : JSON.stringify(res.body)}`);
  } catch (e) {
    console.log(`Health:   unreachable (${e.message})`);
  }
  return 0;
}

async function cmdReload() {
  const local = config.reloadConfig();
  console.log(`Local config reloaded (port=${local.router_port}, mode=${local.router_mode})`);
  if (!isAlive(readPid())) { console.log("Router not running — local-only reload."); return 0; }
  try {
    const res = await httpJson("POST", baseUrl() + "/admin/reload", {});
    console.log(`Server reload: ${res.status}`);
    return res.status >= 200 && res.status < 300 ? 0 : 1;
  } catch (e) {
    console.error(`Server reload failed: ${e.message}`);
    return 1;
  }
}

function parseSince(s) {
  if (!s) return 24 * 3600 * 1000;
  const m = String(s).match(/^(\d+)\s*([smhd])$/i);
  if (!m) return 24 * 3600 * 1000;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  return n * (u === "s" ? 1000 : u === "m" ? 60000 : u === "h" ? 3600000 : 86400000);
}

function cmdStats(flags) {
  const sinceMs = parseSince(flags.since);
  const dash = stats.getDashboard({ sinceMs });
  if (flags.json) { console.log(JSON.stringify(dash, null, 2)); return 0; }
  const hrs = Math.round(sinceMs / 3600000);
  console.log(`AI Router — last ${hrs}h`);
  console.log("─".repeat(50));
  console.log(`Total requests:    ${dash.total}`);
  console.log(`Local (Ollama):    ${dash.local_pct}%`);
  console.log(`Cloud:             ${dash.cloud_pct}%`);
  console.log(`Fallback rate:     ${dash.fallback_pct}%`);
  console.log(`Cache hit rate:    ${dash.cache_hit_pct}%`);
  console.log(`Error rate:        ${dash.error_pct}%`);
  console.log(`Tokens saved:      ~${dash.est_tokens_saved.toLocaleString()}`);
  console.log(`Cost saved (est):  $${dash.est_cost_saved_usd.toFixed(4)}`);
  console.log(`Latency p50/p95/p99: ${dash.latency_ms.p50}/${dash.latency_ms.p95}/${dash.latency_ms.p99} ms`);
  if (Object.keys(dash.by_endpoint).length) {
    console.log("");
    console.log("By endpoint:");
    for (const [ep, v] of Object.entries(dash.by_endpoint)) {
      console.log(`  ${ep.padEnd(30)} total=${v.count}  local=${v.local}  cloud=${v.cloud}  cache=${v.cache}`);
    }
  }
  return 0;
}

const SAMPLE_PROMPTS = [
  { name: "simple",   format: "anthropic", body: { model: "claude-3-5-sonnet-20241022", max_tokens: 64,
    messages: [{ role: "user", content: "What is 2 + 2?" }] } },
  { name: "complex",  format: "anthropic", body: { model: "claude-3-5-sonnet-20241022", max_tokens: 512,
    messages: [{ role: "user", content: "Explain the CAP theorem and trade-offs in distributed databases." }] } },
  { name: "tools",    format: "anthropic", body: { model: "claude-3-5-sonnet-20241022", max_tokens: 256,
    tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    messages: [{ role: "user", content: "What's the weather in Paris?" }] } },
  { name: "stream",   format: "anthropic", body: { model: "claude-3-5-sonnet-20241022", max_tokens: 64, stream: true,
    messages: [{ role: "user", content: "Count to five." }] } },
  { name: "embed",    format: "openai",    path: "/v1/embeddings",
    body: { model: "text-embedding-3-small", input: "hello world" } },
];

async function cmdTest() {
  if (!isAlive(readPid())) { console.error("Router not running. Start it first: ai-router start --detach"); return 1; }
  console.log("Sending sample prompts...");
  for (const s of SAMPLE_PROMPTS) {
    const reqPath = s.path || (s.format === "anthropic" ? "/v1/messages" : "/v1/chat/completions");
    const t0 = Date.now();
    try {
      const res = await httpJson("POST", baseUrl() + reqPath, s.body);
      const dur = Date.now() - t0;
      const cls = (res.headers && res.headers["x-router-classification"]) || "?";
      const prov = (res.headers && res.headers["x-router-provider"]) || "?";
      console.log(`  ${s.name.padEnd(8)} status=${res.status}  classification=${cls}  provider=${prov}  latency=${dur}ms`);
    } catch (e) {
      console.log(`  ${s.name.padEnd(8)} ERROR: ${e.message}`);
    }
  }
  return 0;
}

function cmdConfig(flags) {
  if (flags.edit) {
    const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === "win32" ? "notepad" : "vi");
    ensureDir();
    if (!fs.existsSync(config.CONFIG_FILE)) {
      fs.writeFileSync(config.CONFIG_FILE, JSON.stringify(config.DEFAULTS, null, 2));
    }
    const child = spawn(editor, [config.CONFIG_FILE], { stdio: "inherit" });
    return new Promise(resolve => child.on("exit", code => resolve(code || 0)));
  }
  // default: --show
  const cfg = config.getConfig();
  console.log(JSON.stringify(cfg, null, 2));
  console.log("");
  console.log(`(file: ${config.CONFIG_FILE}${fs.existsSync(config.CONFIG_FILE) ? "" : " — not present, defaults shown"})`);
  return 0;
}

async function cmdModels() {
  const cfg = config.getConfig();
  const url = cfg.ollama_url.replace(/\/$/, "") + "/api/tags";
  try {
    const res = await httpJson("GET", url);
    if (res.status !== 200) {
      console.error(`Ollama returned ${res.status}`);
      return 1;
    }
    const list = (res.body && res.body.models) || [];
    console.log(`Ollama at ${cfg.ollama_url} — ${list.length} model(s):`);
    for (const m of list) {
      const sz = m.size ? `${(m.size / 1e9).toFixed(2)} GB` : "?";
      console.log(`  ${m.name.padEnd(40)} ${sz}`);
    }
    console.log("");
    console.log("Recommended tier mapping:");
    const names = list.map(m => m.name);
    const pick = (preferred) => names.find(n => preferred.some(p => n.includes(p))) || "(install one)";
    console.log(`  TIER_SIMPLE  = ${pick(["llama3.2:3b", "llama3.2", "phi", "qwen2.5:3b"])}`);
    console.log(`  TIER_CODE    = ${pick(["qwen2.5-coder", "deepseek-coder", "codellama"])}`);
    console.log(`  TIER_COMPLEX = ${pick(["llama3.1:70b", "qwen2.5:32b", "llama3.3"])}`);
    console.log(`  TIER_EMBED   = ${pick(["nomic-embed-text", "mxbai-embed", "bge-"])}`);
    return 0;
  } catch (e) {
    console.error(`Cannot reach Ollama at ${url}: ${e.message}`);
    return 1;
  }
}

async function cmdVerify() {
  const cfg = config.getConfig();
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;

  if (!hasAnthropic && !hasOpenAI) {
    console.log("Skipping verify — no ANTHROPIC_API_KEY or OPENAI_API_KEY in env.");
    return 0;
  }
  if (!isAlive(readPid())) {
    console.error("Router not running. Start it first: ai-router start --detach");
    return 1;
  }

  let pass = 0, fail = 0;

  async function compare(label, method, routerPath, upstreamUrl, body, authHeaders) {
    try {
      const direct = await httpJson(method, upstreamUrl, body, authHeaders);
      const proxied = await httpJson(method, baseUrl() + routerPath, body, authHeaders);
      const ok = direct.status === proxied.status;
      console.log(`  ${ok ? "PASS" : "FAIL"} ${label}  (direct=${direct.status} proxied=${proxied.status})`);
      ok ? pass++ : fail++;
    } catch (e) {
      console.log(`  FAIL ${label}  (${e.message})`);
      fail++;
    }
  }

  if (hasAnthropic) {
    const auth = { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" };
    await compare(
      "Anthropic /v1/messages/count_tokens",
      "POST",
      "/v1/messages/count_tokens",
      cfg.anthropic_upstream_url + "/v1/messages/count_tokens",
      { model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: "hi" }] },
      auth,
    );
  }
  if (hasOpenAI) {
    const auth = { authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
    await compare(
      "OpenAI GET /v1/models",
      "GET",
      "/v1/models",
      cfg.openai_upstream_url + "/v1/models",
      null,
      auth,
    );
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

// ── Dispatch ─────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help || args.flags.h || args._.length === 0) { help(); return 0; }
  const cmd = args._[0];
  switch (cmd) {
    case "start":   return cmdStart(args.flags);
    case "stop":    return cmdStop();
    case "status":  return cmdStatus();
    case "reload":  return cmdReload();
    case "stats":   return cmdStats(args.flags);
    case "test":    return cmdTest();
    case "config":  return cmdConfig(args.flags);
    case "models":  return cmdModels();
    case "verify":  return cmdVerify();
    default:
      console.error(`Unknown command: ${cmd}\n`);
      help();
      return 1;
  }
}

if (require.main === module) {
  main().then(code => process.exit(code || 0)).catch(e => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, parseSince };
