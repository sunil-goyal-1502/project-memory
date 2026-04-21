#!/usr/bin/env node
"use strict";

/**
 * Embedding Cache for daemon
 * 
 * Manages quantized embeddings in memory with statistics tracking.
 * Lazy-loads full embeddings as needed, quantizes them, and caches quantized forms.
 * 
 * Features:
 * - Automatic quantization on first load
 * - Compression stats (byte savings, ratio)
 * - Cache hit/miss tracking
 * - Dequantization on-demand for search
 */

const path = require('path');
const fs = require('fs');
const { Quantizer, serializeQuantized, deserializeQuantized } = require('./turbo-quant');

class EmbeddingCache {
  constructor(options = {}) {
    this.bitWidth = options.bitWidth !== undefined ? options.bitWidth : 3;
    this.quantizationEnabled = options.enabled !== false;
    this.seed = options.seed !== undefined ? options.seed : 0;
    this.useQJL = options.useQJL !== false;
    
    // In-memory cache: entryId -> { quantized, metadata, ts }
    this.cache = new Map();
    
    // Full embeddings (optional, kept for comparison/fallback)
    this.fullEmbeddings = new Map();
    
    // Statistics
    this.stats = {
      totalCached: 0,
      totalDequantized: 0,
      totalBytes: 0,
      originalBytes: 0,
      cacheHits: 0,
      cacheMisses: 0,
      dequantizationTimeMs: 0,
    };
    
    // Create quantizer (will be reused for all vectors)
    this.quantizer = new Quantizer(384, this.bitWidth, {
      seed: this.seed,
      useQJL: this.useQJL,
    });
    
    this.sizeInfo = this.quantizer.estimateSize();
  }
  
  /**
   * Cache an embedding entry.
   * If quantization is enabled, stores quantized form + metadata.
   * Otherwise, stores full embedding.
   * 
   * @param {string} entryId - unique identifier
   * @param {Float32Array|Array} embedding - 384-dim embedding vector
   * @param {Object} metadata - { topic, tags, ts } for tracking
   * @returns {Object} - { cached: bool, sizeBytes }
   */
  cacheEmbedding(entryId, embedding, metadata = {}) {
    if (!embedding || embedding.length !== 384) {
      return { cached: false, error: `Invalid embedding length: ${embedding?.length}` };
    }
    
    try {
      if (this.quantizationEnabled) {
        const quantized = this.quantizer.quantize(embedding);
        const serialized = serializeQuantized(quantized);
        
        this.cache.set(entryId, {
          quantized: serialized,
          metadata,
          ts: Date.now(),
        });
        
        this.stats.totalBytes += this.sizeInfo.total;
        this.stats.originalBytes += this.sizeInfo.original;
      } else {
        // Store full embedding uncompressed
        this.cache.set(entryId, {
          full: new Float32Array(embedding),
          metadata,
          ts: Date.now(),
        });
        
        this.stats.totalBytes += embedding.length * 4;
        this.stats.originalBytes += embedding.length * 4;
      }
      
      this.stats.totalCached++;
      return {
        cached: true,
        sizeBytes: this.quantizationEnabled ? this.sizeInfo.total : embedding.length * 4,
      };
    } catch (err) {
      return { cached: false, error: err.message };
    }
  }
  
  /**
   * Get embedding (full vector) for an entry.
   * If quantized, dequantizes on-demand.
   * Records cache hit/miss for statistics.
   * 
   * @param {string} entryId - unique identifier
   * @returns {Float32Array|null} - 384-dim embedding or null if not cached
   */
  getEmbedding(entryId) {
    const entry = this.cache.get(entryId);
    if (!entry) {
      this.stats.cacheMisses++;
      return null;
    }
    
    const startTime = Date.now();
    
    let embedding;
    if (entry.full) {
      // Already full vector
      embedding = entry.full;
    } else if (entry.quantized) {
      // Dequantize
      const deserialized = deserializeQuantized(entry.quantized);
      embedding = this.quantizer.dequantize(deserialized);
    } else {
      return null;
    }
    
    this.stats.cacheHits++;
    const elapsed = Date.now() - startTime;
    this.stats.dequantizationTimeMs += elapsed;
    this.stats.totalDequantized++;
    
    return embedding;
  }
  
  /**
   * Compute inner product between two cached embeddings.
   * Uses quantized form directly for speed if available.
   * 
   * @param {string} entryId1 - first entry ID
   * @param {string} entryId2 - second entry ID
   * @returns {number|null} - inner product or null if either entry not cached
   */
  computeInnerProduct(entryId1, entryId2) {
    const entry1 = this.cache.get(entryId1);
    const entry2 = this.cache.get(entryId2);
    
    if (!entry1 || !entry2) return null;
    
    if (this.quantizationEnabled && entry1.quantized && entry2.quantized) {
      // Use quantized inner product directly (fast)
      const q1 = deserializeQuantized(entry1.quantized);
      const q2 = deserializeQuantized(entry2.quantized);
      return this.quantizer.computeInnerProduct(q1, q2);
    } else {
      // Fall back to full embeddings
      const e1 = this.getEmbedding(entryId1);
      const e2 = this.getEmbedding(entryId2);
      if (!e1 || !e2) return null;
      
      let sum = 0;
      for (let i = 0; i < 384; i++) {
        sum += e1[i] * e2[i];
      }
      return sum;
    }
  }
  
  /**
   * Get compression statistics.
   * 
   * @returns {Object} - compression stats
   */
  getStats() {
    const avgDequantTime = this.stats.totalDequantized > 0 
      ? (this.stats.dequantizationTimeMs / this.stats.totalDequantized)
      : 0;
    
    const hitRate = this.stats.cacheHits + this.stats.cacheMisses > 0
      ? ((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100)
      : 0;
    
    const compressionRatio = this.stats.originalBytes > 0 
      ? (this.stats.totalBytes / this.stats.originalBytes)
      : 0;
    
    const savingsPercent = this.stats.originalBytes > 0
      ? ((1 - this.stats.totalBytes / this.stats.originalBytes) * 100)
      : 0;
    
    return {
      totalCached: this.stats.totalCached,
      totalBytes: this.stats.totalBytes,
      originalBytes: this.stats.originalBytes,
      compressionRatio: compressionRatio,
      savingsPercent: savingsPercent,
      cacheHits: this.stats.cacheHits,
      cacheMisses: this.stats.cacheMisses,
      hitRate: hitRate,
      totalDequantized: this.stats.totalDequantized,
      avgDequantTimeMs: avgDequantTime,
      quantizationEnabled: this.quantizationEnabled,
      bitWidth: this.bitWidth,
      bytesPerVector: this.sizeInfo.total,
    };
  }
  
  /**
   * Clear cache (for testing/reset).
   */
  clear() {
    this.cache.clear();
    this.fullEmbeddings.clear();
    this.stats = {
      totalCached: 0,
      totalDequantized: 0,
      totalBytes: 0,
      originalBytes: 0,
      cacheHits: 0,
      cacheMisses: 0,
      dequantizationTimeMs: 0,
    };
  }
  
  /**
   * Get cache size estimate.
   * 
   * @returns {number} - total bytes used
   */
  getMemoryUsageBytes() {
    return this.stats.totalBytes;
  }
}

module.exports = { EmbeddingCache };
