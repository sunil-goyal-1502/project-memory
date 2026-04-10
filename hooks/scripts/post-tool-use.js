#!/usr/bin/env node
"use strict";

/**
 * PostToolUse hook — thin IPC client.
 * Connects to global memory daemon for fast in-memory processing (~10ms).
 * Falls back to direct execution if daemon unavailable.
 */

const fs = require("fs");
const path = require("path");
const net = require("net");

const home = process.env.USERPROFILE || process.env.HOME || "";

function main() {
  const startMs = Date.now();
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf-8")); } catch {}

  const memDir = findMemDir(input.cwd || process.cwd(), input.session_id);
  if (!memDir) { process.stdout.write("{}"); process.exit(0); }

  const projectRoot = path.dirname(memDir); // memDir = projectRoot/.ai-memory

  // Global daemon port file (single daemon serves all projects)
  const portFile = path.join(home, ".ai-memory-daemon-port");
  let port = 0;
  try { port = Number(fs.readFileSync(portFile, "utf-8").trim()); } catch {}

  if (port > 0) {
    // Fast path: TCP to global daemon with projectRoot
    const client = net.createConnection({ host: "127.0.0.1", port, timeout: 800 }, () => {
      client.end(JSON.stringify({ type: "post-tool-use", projectRoot, input }) + "\n");
    });

    let data = "";
    client.on("data", (chunk) => { data += chunk.toString(); });
    client.on("end", () => {
      const elapsed = Date.now() - startMs;
      debugLog(memDir, `DAEMON-IPC: ${elapsed}ms`);
      try {
        const response = JSON.parse(data.split("\n")[0]);
        if (response.decision) {
          process.stdout.write(JSON.stringify({ decision: response.decision, reason: response.reason || "" }));
        } else if (response.systemMessage) {
          process.stdout.write(JSON.stringify({ systemMessage: response.systemMessage }));
        } else {
          process.stdout.write("{}");
        }
      } catch {
        process.stdout.write("{}");
      }
      process.exit(0);
    });
    client.on("error", () => { fallback(projectRoot, input, memDir, startMs); });
    client.on("timeout", () => { client.destroy(); fallback(projectRoot, input, memDir, startMs); });
  } else {
    fallback(projectRoot, input, memDir, startMs);
  }
}

function fallback(projectRoot, input, memDir, startMs) {
  debugLog(memDir, `DAEMON-FALLBACK: daemon unavailable, direct execution`);
  try {
    const daemon = require(path.resolve(__dirname, "..", "..", "scripts", "daemon.js"));
    const response = daemon.handlePostToolUse(projectRoot, input);
    if (response.decision) {
      process.stdout.write(JSON.stringify({ decision: response.decision, reason: response.reason || "" }));
    } else if (response.systemMessage) {
      process.stdout.write(JSON.stringify({ systemMessage: response.systemMessage }));
    } else {
      process.stdout.write("{}");
    }
  } catch (err) {
    debugLog(memDir, `FALLBACK-ERROR: ${err.message}`);
    process.stdout.write("{}");
  }
  const elapsed = Date.now() - startMs;
  debugLog(memDir, `TIMING: ${elapsed}ms (fallback)`);
  process.exit(0);
}

function findMemDir(cwd, sessionId) {
  let dir = cwd;
  while (dir) {
    const memPath = path.join(dir, ".ai-memory");
    if (fs.existsSync(memPath)) return memPath;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (sessionId) {
    try {
      const sessFile = path.join(home, ".ai-memory-sessions", sessionId);
      const savedRoot = fs.readFileSync(sessFile, "utf-8").trim();
      if (savedRoot && fs.existsSync(path.join(savedRoot, ".ai-memory"))) {
        return path.join(savedRoot, ".ai-memory");
      }
    } catch {}
  }
  try {
    const cached = fs.readFileSync(path.join(home, ".ai-memory-cached-root"), "utf-8").trim();
    if (cached && fs.existsSync(path.join(cached, ".ai-memory"))) return path.join(cached, ".ai-memory");
  } catch {}
  return null;
}

function debugLog(memDir, msg) {
  try {
    const logPath = memDir ? path.join(memDir, ".hook-debug.log") : null;
    if (logPath) fs.appendFileSync(logPath, `[${new Date().toISOString()}] POST: ${msg}\n`, "utf-8");
  } catch {}
}

main();
