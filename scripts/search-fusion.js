#!/usr/bin/env node
"use strict";

/**
 * Search Fusion: Reciprocal Rank Fusion (RRF) of BM25 + Embedding search.
 *
 * Inspired by arxiv-sanity-lite's TF-IDF + SVM hybrid approach (Karpathy).
 *
 * Strategy:
 *   1. BM25 keyword search → top N candidates (exact keyword matching)
 *   2. Embedding cosine search → top N candidates (semantic similarity)
 *   3. RRF merge: score_i = Σ 1/(k + rank_in_list_j)  with k=60
 *   4. Return fused top-K results
 *
 * This gives the best of both worlds: embedding search finds semantically
 * similar results while BM25 ensures exact keyword matches rank highly.
 */

const path = require("path");

// Lazy-loaded to avoid slow ONNX initialization unless needed
let embeddingsMod = null;
function getEmbeddings() {
  if (!embeddingsMod) embeddingsMod = require(path.join(__dirname, "embeddings.js"));
  return embeddingsMod;
}

const RRF_K = 60; // Standard RRF constant — controls how much rank matters vs score

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists into one.
 *
 * @param {Array<Array<{docId: string, score: number}>>} rankedLists
 * @param {number} k - RRF constant (default 60)
 * @returns {Array<{docId: string, score: number, sources: string[]}>}
 */
function reciprocalRankFusion(rankedLists, k = RRF_K) {
  const scores = Object.create(null);
  const sources = Object.create(null);
  const listNames = ["bm25", "embedding", "svm"]; // label each list

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const list = rankedLists[listIdx];
    for (let rank = 0; rank < list.length; rank++) {
      const { docId } = list[rank];
      if (!scores[docId]) { scores[docId] = 0; sources[docId] = []; }
      scores[docId] += 1 / (k + rank + 1); // rank is 0-indexed, RRF uses 1-indexed
      const label = listNames[listIdx] || `list_${listIdx}`;
      if (!sources[docId].includes(label)) sources[docId].push(label);
    }
  }

  return Object.entries(scores)
    .map(([docId, score]) => ({ docId, score, sources: sources[docId] }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Hybrid search: BM25 + embeddings + RRF fusion.
 *
 * @param {string} query - search query text
 * @param {Array} entries - array of JSONL entries (research or decision)
 * @param {Object} storedEmbeddings - { entryId: [384-dim vector] }
 * @param {Object} shared - shared.js module (for buildBM25Index, bm25Score)
 * @param {Object} opts - { limit: number, embeddingTopK: number, bm25TopK: number }
 * @returns {Promise<Array<{docId: string, score: number, sources: string[]}>>}
 */
async function hybridSearch(query, entries, storedEmbeddings, shared, opts = {}) {
  const limit = opts.limit || 10;
  const topK = opts.topK || 20;

  // 1. BM25 keyword search
  const bm25Index = shared.buildBM25Index(entries);
  const bm25Hits = shared.bm25Score(query, bm25Index).slice(0, topK);

  // 2. Embedding semantic search (only if we have embeddings)
  let embeddingHits = [];
  const embeddingIds = Object.keys(storedEmbeddings || {});
  if (embeddingIds.length > 0) {
    try {
      const emb = getEmbeddings();
      embeddingHits = await emb.semanticSearch(query, storedEmbeddings, topK);
    } catch {
      // ONNX not available — fall back to BM25 only
    }
  }

  // 3. RRF merge
  const lists = [bm25Hits];
  if (embeddingHits.length > 0) lists.push(embeddingHits);
  const fused = reciprocalRankFusion(lists);

  return fused.slice(0, limit);
}

/**
 * Synchronous BM25-only search (no embeddings). Fast fallback when ONNX
 * is unavailable or for hook-context where async isn't possible.
 */
function bm25OnlySearch(query, entries, shared, limit = 10) {
  const bm25Index = shared.buildBM25Index(entries);
  const hits = shared.bm25Score(query, bm25Index).slice(0, limit);
  return hits.map(h => ({ ...h, sources: ["bm25"] }));
}

module.exports = {
  reciprocalRankFusion,
  hybridSearch,
  bm25OnlySearch,
  RRF_K,
};
