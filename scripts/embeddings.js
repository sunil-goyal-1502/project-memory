#!/usr/bin/env node
"use strict";

/**
 * Embedding service for project-memory plugin.
 * Uses @huggingface/transformers with Xenova/all-MiniLM-L6-v2 (ONNX)
 * for local semantic search — no API keys, runs fully offline after first download.
 *
 * First call downloads the model (~22MB quantized). Subsequent calls are fast (~50ms).
 */

const fs = require("fs");
const path = require("path");

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

let _pipeline = null;
let _pipelinePromise = null;

/**
 * Lazily initialize the feature-extraction pipeline.
 * Returns a cached pipeline instance.
 */
async function getPipeline() {
  if (_pipeline) return _pipeline;
  if (_pipelinePromise) return _pipelinePromise;

  _pipelinePromise = (async () => {
    // Dynamic import for ESM module
    const { pipeline, env } = await import("@huggingface/transformers");
    // Disable remote model checks for offline-first after initial download
    env.allowLocalModels = true;
    _pipeline = await pipeline("feature-extraction", MODEL_ID, {
      dtype: "q8", // quantized for smaller size + faster inference
    });
    return _pipeline;
  })();

  return _pipelinePromise;
}

/**
 * Generate embedding vector for a text string.
 * Returns Float32Array of length 384.
 */
async function generateEmbedding(text) {
  const extractor = await getPipeline();
  const result = await extractor(text, { pooling: "mean", normalize: true });
  // result.data is a Float32Array
  return Array.from(result.data);
}

/**
 * Compute cosine similarity between two embedding vectors.
 * Both must be the same length. Returns number in [-1, 1].
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Read stored embeddings from .ai-memory/embeddings.json.
 * Returns object mapping entry ID → embedding array.
 */
function readEmbeddings(projectRoot) {
  const embPath = path.join(projectRoot, ".ai-memory", "embeddings.json");
  if (!fs.existsSync(embPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(embPath, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Write embeddings to .ai-memory/embeddings.json.
 */
function writeEmbeddings(projectRoot, embeddings) {
  const embPath = path.join(projectRoot, ".ai-memory", "embeddings.json");
  fs.writeFileSync(embPath, JSON.stringify(embeddings), "utf-8");
}

/**
 * Semantic search: rank entries by cosine similarity to query.
 * Returns array of { docId, score } sorted descending.
 *
 * @param {string} query - search query text
 * @param {Object} storedEmbeddings - { entryId: [...embedding] }
 * @param {number} topK - max results to return (default: all)
 */
async function semanticSearch(query, storedEmbeddings, topK = 0) {
  const queryEmbedding = await generateEmbedding(query);
  const results = [];

  for (const [docId, embedding] of Object.entries(storedEmbeddings)) {
    const score = cosineSimilarity(queryEmbedding, embedding);
    results.push({ docId, score });
  }

  results.sort((a, b) => b.score - a.score);
  return topK > 0 ? results.slice(0, topK) : results;
}

module.exports = {
  generateEmbedding,
  cosineSimilarity,
  readEmbeddings,
  writeEmbeddings,
  semanticSearch,
  MODEL_ID,
  EMBEDDING_DIM,
};
