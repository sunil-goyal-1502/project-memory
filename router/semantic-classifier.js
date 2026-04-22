"use strict";

/**
 * router/semantic-classifier.js
 *
 * Cosine-similarity classifier built on top of the existing
 * scripts/embeddings.js (ONNX Xenova/all-MiniLM-L6-v2 via @huggingface/transformers).
 *
 * Two reference banks (~30 prompts each) are embedded once and cached at
 *   ~/.ai-router/.refs.json
 * as { model, simple: [{text, vec}], complex: [{text, vec}] }.
 *
 * classify(text) → { category: 'simple'|'complex', confidence, scores: {simple, complex} }
 *
 * Latency: cached path ≈ 30–50ms (one embed + 60 dot products of length 384).
 * Cold path: ~3–5s on first model load.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  generateEmbedding,
  cosineSimilarity,
  MODEL_ID,
} = require("../scripts/embeddings.js");

const CACHE_DIR  = path.join(os.homedir(), ".ai-router");
const CACHE_FILE = path.join(CACHE_DIR, ".refs.json");

// ---------------------------------------------------------------------------
// Reference prompts.
// Aim: ~30 each, covering the breadth of "small-model-OK" vs "needs frontier".
// ---------------------------------------------------------------------------

const SIMPLE_REFS = [
  "Hi there!",
  "Hello, how are you?",
  "Thanks!",
  "What is the capital of France?",
  "Translate 'good morning' to Spanish.",
  "What does HTTP stand for?",
  "Convert 50 fahrenheit to celsius.",
  "Spell 'accommodation'.",
  "Summarize this paragraph in one sentence.",
  "Give me a synonym for 'happy'.",
  "What's 17 times 23?",
  "List three colors.",
  "Define the word 'ephemeral'.",
  "Format this date as YYYY-MM-DD: March 5, 2026",
  "Capitalize the first letter of each word in this sentence.",
  "Convert this JSON to YAML.",
  "What is the boiling point of water?",
  "Write a one-line bash command to count lines in a file.",
  "What's the difference between let and const in JavaScript?",
  "Tell me a joke.",
  "How do I check my Node.js version?",
  "What's the keyboard shortcut to copy text on Windows?",
  "Convert this markdown table to CSV.",
  "Replace all spaces with underscores in 'hello world'.",
  "What does the acronym SQL mean?",
  "Give me a regex to match an email address.",
  "What's the current year?",
  "Round 3.14159 to two decimal places.",
  "Is Python case-sensitive?",
  "What unit is GHz?",
];

const COMPLEX_REFS = [
  "Refactor this 800-line authentication module to use dependency injection and explain trade-offs.",
  "Design a multi-tenant rate limiter that handles bursty traffic across three regions.",
  "Migrate our Postgres schema from single-tenant to multi-tenant with zero downtime; produce the migration plan.",
  "Implement a custom React hook that synchronizes state across browser tabs using BroadcastChannel and SharedWorker, with fallbacks.",
  "Walk me through the architecture trade-offs between event sourcing and CRUD persistence for an e-commerce checkout flow.",
  "Debug this stack trace across these four files and propose a fix that doesn't introduce regressions in the cache layer.",
  "Restructure this monolith into bounded contexts following DDD principles and produce a phased rollout plan.",
  "Analyze the time and space complexity of this graph algorithm and rewrite it for streaming inputs.",
  "Implement a full OAuth 2.0 authorization-code-with-PKCE client that handles token refresh, revocation, and concurrent requests.",
  "Redesign this REST API as a GraphQL gateway, enumerating all breaking changes for existing clients.",
  "Architect a fault-tolerant background-job system using Redis streams that survives two-node failure.",
  "Reason about why this distributed lock implementation is unsafe under network partitions and propose a corrected design.",
  "Refactor these three React components into a single composable that supports controlled and uncontrolled modes; preserve all current props.",
  "Implement a streaming JSON parser in TypeScript that handles arrays of arbitrary depth with bounded memory.",
  "Walk me through how to instrument this service with OpenTelemetry traces, logs, and metrics, including sampling strategy.",
  "Migrate this codebase from CommonJS to ESM; identify every breaking import and circular dependency.",
  "Explain in detail how the V8 hidden-class optimization affects the performance of these object literals.",
  "Implement a CRDT-based collaborative text editor and show how concurrent edits converge.",
  "Design a multi-region active-active deployment with automatic failover and data replication; describe each failure mode.",
  "Refactor this 2000-line file into smaller modules without changing public API or breaking the 47 existing tests.",
  "Architect a pluggable event-driven plugin system in Node, including discovery, sandboxing, lifecycle, and version negotiation.",
  "Migrate from MongoDB to PostgreSQL while preserving denormalized read patterns; produce a dual-write transition plan.",
  "Implement an end-to-end encrypted chat protocol with forward secrecy and post-compromise security.",
  "Design a feature-flagging service with consistent percentage-based rollouts across multiple services and SDKs.",
  "Reason about the consistency guarantees of this saga implementation and identify all compensation gaps.",
  "Refactor the diff-based change detector to handle binary files, renames, and submodule changes.",
  "Implement a parser combinator library in TypeScript with proper error recovery, position tracking, and left-recursion support.",
  "Walk me through replacing this synchronous job queue with an async stream-processing pipeline using Kafka.",
  "Architect an LLM router that picks between local and cloud models based on heuristics, semantic embeddings, and cost.",
  "Implement a custom memory allocator in Rust optimized for short-lived objects in a request-scoped arena.",
];

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

let _refsCache = null; // in-process cache

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function loadCacheFromDisk() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    if (!data || data.model !== MODEL_ID) return null;
    if (!Array.isArray(data.simple) || !Array.isArray(data.complex)) return null;
    // Sanity: count must match (refresh if reference banks were edited).
    if (data.simple.length !== SIMPLE_REFS.length) return null;
    if (data.complex.length !== COMPLEX_REFS.length) return null;
    return data;
  } catch {
    return null;
  }
}

function saveCacheToDisk(refs) {
  try {
    ensureCacheDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(refs), "utf-8");
  } catch {
    // Non-fatal: we still have the in-memory copy.
  }
}

async function buildRefs() {
  const simple  = [];
  const complex = [];
  for (const text of SIMPLE_REFS) {
    const vec = await generateEmbedding(text);
    simple.push({ text, vec });
  }
  for (const text of COMPLEX_REFS) {
    const vec = await generateEmbedding(text);
    complex.push({ text, vec });
  }
  return { model: MODEL_ID, simple, complex };
}

/**
 * Get reference banks (in-memory cached, then on-disk cached, else built).
 * @returns {Promise<{model:string, simple:Array, complex:Array}>}
 */
async function getRefs() {
  if (_refsCache) return _refsCache;
  const onDisk = loadCacheFromDisk();
  if (onDisk) {
    _refsCache = onDisk;
    return _refsCache;
  }
  _refsCache = await buildRefs();
  saveCacheToDisk(_refsCache);
  return _refsCache;
}

/**
 * Pre-warm the embedding pipeline + reference cache. Optional but useful at
 * server startup so the first real request doesn't pay the cold-start cost.
 */
async function warmup() {
  await getRefs();
}

// ---------------------------------------------------------------------------
// classify(text)
// ---------------------------------------------------------------------------

/**
 * Classify a snippet of natural language as 'simple' or 'complex'.
 *
 * Strategy: max cosine similarity in each reference bank, then normalize.
 *   confidence = |simpleMax - complexMax|  (closer to 1 = more confident)
 *
 * @param {string} text  Last user message (or any prompt fragment).
 * @returns {Promise<{category:'simple'|'complex', confidence:number, scores:{simple:number, complex:number}}>}
 */
async function classify(text) {
  const safeText = (typeof text === "string" && text.trim()) ? text : "";
  if (!safeText) {
    // Empty input → conservative default
    return {
      category: "complex",
      confidence: 0,
      scores: { simple: 0, complex: 0 },
    };
  }

  const refs = await getRefs();
  const queryVec = await generateEmbedding(safeText);

  let simpleMax = -Infinity;
  for (const { vec } of refs.simple) {
    const s = cosineSimilarity(queryVec, vec);
    if (s > simpleMax) simpleMax = s;
  }
  let complexMax = -Infinity;
  for (const { vec } of refs.complex) {
    const s = cosineSimilarity(queryVec, vec);
    if (s > complexMax) complexMax = s;
  }

  // Cosine sim ranges in [-1, 1]; normalize to [0, 1].
  const simpleScore  = (simpleMax  + 1) / 2;
  const complexScore = (complexMax + 1) / 2;

  const category   = complexScore >= simpleScore ? "complex" : "simple";
  const confidence = Math.min(1, Math.abs(complexScore - simpleScore) * 4);
  // ×4 because cosine differences in this regime are small (~0.05–0.25);
  // capping at 1 means: a 0.25 raw delta → confidence 1.0.

  return {
    category,
    confidence: +confidence.toFixed(4),
    scores: {
      simple:  +simpleScore.toFixed(4),
      complex: +complexScore.toFixed(4),
    },
  };
}

module.exports = {
  classify,
  warmup,
  getRefs,
  // Exposed for tests
  SIMPLE_REFS,
  COMPLEX_REFS,
  CACHE_FILE,
};
