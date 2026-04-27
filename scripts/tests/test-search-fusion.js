#!/usr/bin/env node
"use strict";

/**
 * Tests for scripts/search-fusion.js — Reciprocal Rank Fusion hybrid search.
 */

const assert = require("node:assert/strict");
const path = require("path");
const { reciprocalRankFusion, bm25OnlySearch, RRF_K } = require(path.join(__dirname, "..", "search-fusion.js"));

const tests = {
  "RRF: single list preserves order"() {
    const list = [
      { docId: "a", score: 10 },
      { docId: "b", score: 5 },
      { docId: "c", score: 1 },
    ];
    const fused = reciprocalRankFusion([list]);
    assert.equal(fused[0].docId, "a");
    assert.equal(fused[1].docId, "b");
    assert.equal(fused[2].docId, "c");
    assert.ok(fused[0].score > fused[1].score);
  },

  "RRF: two lists boost shared entries"() {
    const bm25 = [
      { docId: "x", score: 10 },
      { docId: "shared", score: 5 },
    ];
    const embedding = [
      { docId: "shared", score: 0.95 },
      { docId: "y", score: 0.8 },
    ];
    const fused = reciprocalRankFusion([bm25, embedding]);
    // "shared" appears in both lists → should have highest fused score
    assert.equal(fused[0].docId, "shared");
    assert.ok(fused[0].sources.includes("bm25"));
    assert.ok(fused[0].sources.includes("embedding"));
  },

  "RRF: disjoint lists interleave fairly"() {
    const list1 = [{ docId: "a", score: 10 }, { docId: "b", score: 5 }];
    const list2 = [{ docId: "c", score: 10 }, { docId: "d", score: 5 }];
    const fused = reciprocalRankFusion([list1, list2]);
    // All 4 should appear, each rank-1 items get same RRF score
    assert.equal(fused.length, 4);
    const aScore = fused.find(f => f.docId === "a").score;
    const cScore = fused.find(f => f.docId === "c").score;
    assert.equal(aScore, cScore); // same rank → same score
  },

  "RRF: custom k parameter affects scores"() {
    const list = [{ docId: "a", score: 10 }, { docId: "b", score: 5 }];
    const k10 = reciprocalRankFusion([list], 10);
    const k100 = reciprocalRankFusion([list], 100);
    // With k=10, rank-1 score = 1/(10+1) = 0.0909
    // With k=100, rank-1 score = 1/(100+1) = 0.0099
    assert.ok(k10[0].score > k100[0].score);
  },

  "RRF: empty lists return empty"() {
    const fused = reciprocalRankFusion([[], []]);
    assert.equal(fused.length, 0);
  },

  "bm25OnlySearch: returns results with sources tag"() {
    const shared = {
      buildBM25Index: (entries) => {
        const invertedIndex = Object.create(null);
        const docLengths = Object.create(null);
        let totalLen = 0;
        for (const e of entries) {
          const tokens = (e.topic + " " + (e.finding || "")).toLowerCase().split(/\s+/);
          docLengths[e.id] = tokens.length;
          totalLen += tokens.length;
          const tf = {};
          for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
          for (const [term, count] of Object.entries(tf)) {
            if (!invertedIndex[term]) invertedIndex[term] = [];
            invertedIndex[term].push({ docId: e.id, tf: count });
          }
        }
        return { invertedIndex, docLengths, avgDocLen: totalLen / entries.length, N: entries.length };
      },
      bm25Score: (query, index) => {
        const terms = query.toLowerCase().split(/\s+/);
        const scores = Object.create(null);
        for (const term of terms) {
          const postings = index.invertedIndex[term];
          if (!postings) continue;
          for (const { docId, tf } of postings) {
            scores[docId] = (scores[docId] || 0) + tf;
          }
        }
        return Object.entries(scores).map(([docId, score]) => ({ docId, score })).sort((a, b) => b.score - a.score);
      },
    };
    const entries = [
      { id: "1", topic: "BM25 search algorithm", finding: "BM25 is a ranking function" },
      { id: "2", topic: "Embeddings for search", finding: "MiniLM embeddings are fast" },
    ];
    const results = bm25OnlySearch("BM25", entries, shared, 5);
    assert.ok(results.length > 0);
    assert.equal(results[0].docId, "1");
    assert.ok(results[0].sources.includes("bm25"));
  },

  "RRF K constant is 60"() {
    assert.equal(RRF_K, 60);
  },
};

async function run() {
  let pass = 0, fail = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      pass++;
      console.log(`  \u2714 ${name}`);
    } catch (e) {
      fail++;
      console.log(`  \u2718 ${name} — ${e.message}`);
    }
  }
  return { pass, fail };
}

if (require.main === module) {
  run().then(({ pass, fail }) => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });
}

module.exports = { run, tests };
