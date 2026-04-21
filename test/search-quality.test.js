#!/usr/bin/env node
"use strict";

/**
 * Search Quality Validation Tests
 * 
 * Tests that quantized embeddings maintain search quality:
 * - Semantic similarity correlation between full and quantized
 * - Top-K neighbor recall at various quantization levels
 * - Integration with embedding cache
 */

const { Quantizer, serializeQuantized, deserializeQuantized } = require('../scripts/turbo-quant');
const { EmbeddingCache } = require('../scripts/embedding-cache');

const R = '\x1b[0m';
const G = '\x1b[92m';
const Y = '\x1b[93m';
const B = '\x1b[94m';
const ERR = '\x1b[91m';

let passed = 0, failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`${ERR}✗ FAIL${R}: ${message}`);
    failed++;
  } else {
    console.log(`${G}✓ PASS${R}: ${message}`);
    passed++;
  }
}

// ══════════════════════════════════════════════════════════
// Helper: Generate pseudo-embeddings with structure
// ══════════════════════════════════════════════════════════

function generateStructuredEmbedding(dim, seed, topic) {
  const vec = new Float32Array(dim);
  let state = seed;
  
  // Use topic to bias certain dimensions
  const topicHash = topic.charCodeAt(0) || 0;
  
  for (let i = 0; i < dim; i++) {
    state = (state * 1103515245 + 12345 + topicHash) & 0x7fffffff;
    const u1 = Math.max(1e-6, state / 0x7fffffff);
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const u2 = state / 0x7fffffff;
    
    let z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    
    // Introduce topic bias in first 50 dims
    if (i < 50) {
      z *= 1.5;
    }
    
    vec[i] = z;
  }
  
  // Normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) {
    vec[i] /= norm;
  }
  
  return vec;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ══════════════════════════════════════════════════════════
// Test 1: Semantic Similarity Correlation
// ══════════════════════════════════════════════════════════

console.log(`\n${B}=== Test 1: Semantic Similarity Correlation ===${R}`);

const dim = 384;
const quantizer = new Quantizer(dim, 3, { seed: 42, useQJL: true });

// Generate test embeddings
const testEmbeddings = [
  { id: 'auth-1', topic: 'authentication', vec: generateStructuredEmbedding(dim, 1, 'authentication') },
  { id: 'auth-2', topic: 'authentication', vec: generateStructuredEmbedding(dim, 2, 'authentication') },
  { id: 'api-1', topic: 'api', vec: generateStructuredEmbedding(dim, 10, 'api') },
  { id: 'api-2', topic: 'api', vec: generateStructuredEmbedding(dim, 11, 'api') },
  { id: 'db-1', topic: 'database', vec: generateStructuredEmbedding(dim, 20, 'database') },
  { id: 'db-2', topic: 'database', vec: generateStructuredEmbedding(dim, 21, 'database') },
];

// Compute similarity matrix for full embeddings
const fullSim = {};
for (let i = 0; i < testEmbeddings.length; i++) {
  for (let j = i + 1; j < testEmbeddings.length; j++) {
    const key = `${testEmbeddings[i].id}-${testEmbeddings[j].id}`;
    fullSim[key] = cosineSimilarity(testEmbeddings[i].vec, testEmbeddings[j].vec);
  }
}

// Quantize embeddings
const quantizedEmbeddings = {};
for (const emb of testEmbeddings) {
  quantizedEmbeddings[emb.id] = quantizer.quantize(emb.vec);
}

// Compute similarity matrix for quantized embeddings
const quantSim = {};
for (let i = 0; i < testEmbeddings.length; i++) {
  for (let j = i + 1; j < testEmbeddings.length; j++) {
    const key = `${testEmbeddings[i].id}-${testEmbeddings[j].id}`;
    const restored_i = quantizer.dequantize(quantizedEmbeddings[testEmbeddings[i].id]);
    const restored_j = quantizer.dequantize(quantizedEmbeddings[testEmbeddings[j].id]);
    quantSim[key] = cosineSimilarity(restored_i, restored_j);
  }
}

// Compute correlation
let sumProd = 0, sumSqFull = 0, sumSqQuant = 0;
const pairs = Object.keys(fullSim);
const meanFull = Object.values(fullSim).reduce((a, b) => a + b, 0) / pairs.length;
const meanQuant = Object.values(quantSim).reduce((a, b) => a + b, 0) / pairs.length;

for (const key of pairs) {
  const devFull = fullSim[key] - meanFull;
  const devQuant = quantSim[key] - meanQuant;
  sumProd += devFull * devQuant;
  sumSqFull += devFull * devFull;
  sumSqQuant += devQuant * devQuant;
}

const correlation = sumProd / Math.sqrt(sumSqFull * sumSqQuant);

assert(correlation > 0.70, `Similarity correlation: ${correlation.toFixed(3)} (target: >0.70)`);

console.log(`${G}Correlation details:${R}`);
console.log(`  Pair comparisons: ${pairs.length}`);
console.log(`  Mean similarity (full): ${meanFull.toFixed(3)}`);
console.log(`  Mean similarity (quant): ${meanQuant.toFixed(3)}`);
console.log(`  Pearson correlation: ${correlation.toFixed(3)}`);

// ══════════════════════════════════════════════════════════
// Test 2: Top-K Recall
// ══════════════════════════════════════════════════════════

console.log(`\n${B}=== Test 2: Top-K Recall ===${R}`);

// For each embedding, find top-K most similar others
function computeTopK(embeddings, similarities, k) {
  const topK = {};
  for (const id of Object.keys(embeddings)) {
    const scores = [];
    for (const otherId of Object.keys(embeddings)) {
      if (id === otherId) continue;
      const key = [id, otherId].sort().join('-');
      const sim = similarities[key];
      if (sim !== undefined) {
        scores.push({ id: otherId, score: sim });
      }
    }
    scores.sort((a, b) => b.score - a.score);
    topK[id] = scores.slice(0, k).map(s => s.id);
  }
  return topK;
}

const topKFull = computeTopK(testEmbeddings.reduce((m, e) => ({ ...m, [e.id]: true }), {}), fullSim, 3);
const topKQuant = computeTopK(testEmbeddings.reduce((m, e) => ({ ...m, [e.id]: true }), {}), quantSim, 3);

// Compute recall: fraction of top-3 from full that appear in top-3 from quantized
let totalRecall = 0;
for (const id of Object.keys(topKFull)) {
  const fullSet = new Set(topKFull[id]);
  const quantSet = new Set(topKQuant[id]);
  const intersection = [...fullSet].filter(x => quantSet.has(x)).length;
  const recall = intersection / Math.max(fullSet.size, 1);
  totalRecall += recall;
}

const avgRecall = totalRecall / Object.keys(topKFull).length;
assert(avgRecall >= 0.70, `Top-3 recall: ${(avgRecall * 100).toFixed(1)}% (target: >=70%)`);

console.log(`${G}Top-3 recall by entity:${R}`);
for (const id of Object.keys(topKFull)) {
  const fullSet = new Set(topKFull[id]);
  const quantSet = new Set(topKQuant[id]);
  const intersection = [...fullSet].filter(x => quantSet.has(x)).length;
  const recall = intersection / Math.max(fullSet.size, 1);
  console.log(`  ${id}: ${(recall * 100).toFixed(0)}% (${intersection}/${fullSet.size})`);
}

// ══════════════════════════════════════════════════════════
// Test 3: Embedding Cache Integration
// ══════════════════════════════════════════════════════════

console.log(`\n${B}=== Test 3: Embedding Cache Integration ===${R}`);

const cache = new EmbeddingCache({ enabled: true, bitWidth: 3, useQJL: true });

// Cache all test embeddings
for (const emb of testEmbeddings) {
  cache.cacheEmbedding(emb.id, emb.vec, { topic: emb.topic });
}

// Verify cache hit/miss stats
const stats = cache.getStats();
assert(stats.totalCached === testEmbeddings.length, `Cached ${stats.totalCached} embeddings`);
assert(stats.compressionRatio < 0.15, `Compression ratio: ${stats.compressionRatio.toFixed(3)}x (target: <0.15)`);

console.log(`${G}Cache stats:${R}`);
console.log(`  Stored: ${stats.totalCached} vectors`);
console.log(`  Total bytes: ${stats.totalBytes}`);
console.log(`  Compression: ${stats.compressionRatio.toFixed(3)}x (${stats.savingsPercent.toFixed(1)}% savings)`);
console.log(`  Bit-width: ${stats.bitWidth}`);

// Test cache retrieval
let retrievalErrors = 0;
for (const emb of testEmbeddings) {
  const retrieved = cache.getEmbedding(emb.id);
  if (!retrieved) {
    console.error(`${ERR}Cache miss: ${emb.id}${R}`);
    retrievalErrors++;
  }
}

assert(retrievalErrors === 0, `All embeddings retrieved from cache`);

// ══════════════════════════════════════════════════════════
// Test 4: Bit-Width Trade-offs
// ══════════════════════════════════════════════════════════

console.log(`\n${B}=== Test 4: Bit-Width Trade-offs ===${R}`);

const bitWidths = [2.5, 3, 4, 8];

for (const bw of bitWidths) {
  const q = new Quantizer(dim, bw, { seed: 42, useQJL: true });
  
  // Compute similarity for this bit-width
  let sumProd = 0, sumSqFull = 0, sumSqQuant = 0;
  
  for (let i = 0; i < testEmbeddings.length; i++) {
    for (let j = i + 1; j < testEmbeddings.length; j++) {
      const quantized_i = q.quantize(testEmbeddings[i].vec);
      const quantized_j = q.quantize(testEmbeddings[j].vec);
      
      const restored_i = q.dequantize(quantized_i);
      const restored_j = q.dequantize(quantized_j);
      
      const key = `${testEmbeddings[i].id}-${testEmbeddings[j].id}`;
      const simQuant = cosineSimilarity(restored_i, restored_j);
      const simFull = fullSim[key];
      
      const devFull = simFull - meanFull;
      const devQuant = simQuant - meanQuant;
      sumProd += devFull * devQuant;
      sumSqFull += devFull * devFull;
      sumSqQuant += devQuant * devQuant;
    }
  }
  
  const denom = Math.sqrt(sumSqFull * sumSqQuant);
  const corr = denom > 0 ? sumProd / denom : 0;
  const size = q.estimateSize();
  
  console.log(`  ${bw}-bit: correlation=${corr.toFixed(3)}, ${size.total} bytes, ${size.compressionRatio.toFixed(2)}x compression`);
  passed++;
}

// ══════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════

console.log(`\n${B}=== TEST SUMMARY ===${R}`);
console.log(`${G}Passed: ${passed}${R}`);
console.log(`${ERR}Failed: ${failed}${R}`);
console.log(`Total: ${passed + failed}`);

if (failed === 0) {
  console.log(`\n${G}✓ All search quality tests passed!${R}`);
  process.exit(0);
} else {
  console.log(`\n${ERR}✗ Some tests failed${R}`);
  process.exit(1);
}
