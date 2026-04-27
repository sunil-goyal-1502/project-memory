#!/usr/bin/env node
"use strict";

/**
 * BPE-based text compressor for reducing token count in context injections.
 *
 * Inspired by Karpathy's minbpe RegexTokenizer. This is NOT tokenization for
 * LLM input — it's text-level compression of repeated patterns in research
 * findings so that context injections fit more information in fewer tokens.
 *
 * Algorithm:
 *   1. Pre-tokenize text using GPT-4-style regex (words, numbers, punctuation)
 *   2. Count all adjacent SPACE-SEPARATED token pairs across the corpus
 *   3. Greedily merge the most frequent pair into a new token
 *   4. Repeat until vocabSize merges are learned
 *   5. Compress: replace merged sequences with «N» placeholders
 *   6. Decompress: expand «N» back to original text (lossless)
 *
 * Lossless guarantee: only merges tokens separated by exactly one space.
 * Decompression restores that space. Non-space gaps are never touched.
 */

const fs = require("fs");
const path = require("path");
const shared = require(path.join(__dirname, "shared.js"));

// Unicode guillemets used as placeholder delimiters — unlikely in normal text.
// If source text naturally contains «\d+» patterns, those sequences will be
// left as-is during compression (they won't match any merge pair).
const L_GUILL = "\u00AB"; // «
const R_GUILL = "\u00BB"; // »

const MAX_VOCAB_SIZE = 2048;
const MAX_TEXT_BYTES = 1024 * 1024; // 1 MB per input text

// GPT-4-style pre-tokenization regex: words (with contractions), numbers, single non-whitespace
const PRE_TOKENIZE_RE = /(?:[a-zA-Z]+(?:'[a-zA-Z]+)*)|(?:\d+(?:\.\d+)?)|(?:\S)/g;

// Regex to find «N» placeholders during decompression
const PLACEHOLDER_RE = new RegExp(L_GUILL + "(\\d+)" + R_GUILL, "g");

/**
 * Pre-tokenize text into an array of word/number/punctuation tokens.
 * Each token records the gap (whitespace/chars) that preceded it in the
 * original text, so reconstruction is lossless.
 */
function preTokenize(text) {
  const tokens = [];
  let lastEnd = 0;
  let match;
  PRE_TOKENIZE_RE.lastIndex = 0;
  while ((match = PRE_TOKENIZE_RE.exec(text)) !== null) {
    const gap = text.slice(lastEnd, match.index);
    tokens.push({ text: match[0], gap: gap });
    lastEnd = match.index + match[0].length;
  }
  // Trailing text (whitespace/other after last token)
  if (lastEnd < text.length) {
    tokens.push({ text: "", gap: text.slice(lastEnd) });
  }
  return tokens;
}

/**
 * Count adjacent SPACE-SEPARATED pair frequencies across all sequences.
 * Only counts pairs where the gap between tokens is exactly " ".
 * Returns Map<"tok1\0tok2", count>.
 */
function countSpaceSeparatedPairs(sequences) {
  const counts = new Map();
  for (const seq of sequences) {
    for (let i = 0; i < seq.tokens.length - 1; i++) {
      if (seq.gaps[i + 1] === " ") {
        const key = seq.tokens[i] + "\0" + seq.tokens[i + 1];
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * Merge all space-separated occurrences of (tokenA, tokenB) in every sequence.
 * Mutates sequences in-place for performance.
 */
function mergeSpacePairInSequences(sequences, tokenA, tokenB, merged) {
  for (const seq of sequences) {
    let i = 0;
    while (i < seq.tokens.length - 1) {
      if (seq.tokens[i] === tokenA && seq.tokens[i + 1] === tokenB && seq.gaps[i + 1] === " ") {
        seq.tokens[i] = merged;
        seq.tokens.splice(i + 1, 1);
        seq.gaps.splice(i + 1, 1);
        // Don't advance — re-check this position for chain merges
      } else {
        i++;
      }
    }
  }
}

// ── BPECompressor class ─────────────────────────────────────────────────────

class BPECompressor {
  constructor(vocabPath) {
    // merges: ordered array of { a, b, merged } — the merge table
    this.merges = [];
    if (vocabPath && fs.existsSync(vocabPath)) {
      this.load(vocabPath);
    }
  }

  /**
   * Train BPE merge table from an array of text strings.
   * Only learns merges for space-separated token pairs to guarantee lossless
   * round-trips (non-space adjacency like punctuation is never merged).
   * @param {string[]} texts - corpus of text strings
   * @param {number} vocabSize - number of merges to learn (capped at 2048)
   */
  train(texts, vocabSize) {
    vocabSize = Math.min(vocabSize || 512, MAX_VOCAB_SIZE);

    // Pre-tokenize each text, preserving gaps for space-only pair counting
    const sequences = [];
    for (const text of texts) {
      if (!text || typeof text !== "string") continue;
      const safe = text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text;
      const tokenObjs = preTokenize(safe);
      if (tokenObjs.length > 1) {
        sequences.push({
          tokens: tokenObjs.map(function (t) { return t.text; }),
          gaps: tokenObjs.map(function (t) { return t.gap; })
        });
      }
    }

    if (sequences.length === 0) return;

    this.merges = [];

    for (let step = 0; step < vocabSize; step++) {
      const counts = countSpaceSeparatedPairs(sequences);
      if (counts.size === 0) break;

      // Find the most frequent pair
      let bestKey = null;
      let bestCount = 0;
      for (const [key, count] of counts) {
        if (count > bestCount) {
          bestCount = count;
          bestKey = key;
        }
      }

      // Stop if no pair occurs more than once — no further compression gain
      if (bestCount < 2) break;

      const sep = bestKey.indexOf("\0");
      const a = bestKey.slice(0, sep);
      const b = bestKey.slice(sep + 1);
      const merged = a + " " + b;

      this.merges.push({ a, b, merged });
      mergeSpacePairInSequences(sequences, a, b, merged);
    }
  }

  /**
   * Save merge table to a JSON file.
   */
  save(vocabPath) {
    const dir = path.dirname(vocabPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = {
      version: 1,
      mergeCount: this.merges.length,
      merges: this.merges.map(function (m) { return [m.a, m.b]; })
    };
    fs.writeFileSync(vocabPath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Load merge table from a JSON file.
   */
  load(vocabPath) {
    const raw = fs.readFileSync(vocabPath, "utf-8");
    const data = JSON.parse(raw);
    this.merges = [];
    const pairs = data.merges || [];
    for (let i = 0; i < pairs.length; i++) {
      const a = pairs[i][0];
      const b = pairs[i][1];
      const merged = a + " " + b;
      this.merges.push({ a, b, merged });
    }
  }

  /**
   * Compress text by applying learned merges and replacing merged sequences
   * with «N» placeholders. Only merges space-separated tokens to guarantee
   * lossless round-trip.
   * @param {string} text
   * @returns {string} compressed text
   */
  compress(text) {
    if (!text || typeof text !== "string" || this.merges.length === 0) return text;
    const safe = text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text;

    // Pre-tokenize preserving whitespace gaps
    const tokenObjs = preTokenize(safe);
    if (tokenObjs.length === 0) return safe;

    // Build mutable arrays for the merge loop
    var tokens = tokenObjs.map(function (t) { return t.text; });
    var gaps = tokenObjs.map(function (t) { return t.gap; });
    // Track which merge produced each token (-1 = original, unmerged)
    var mergeOf = new Array(tokens.length).fill(-1);

    // Apply each merge in order, using the merged text (not placeholders)
    // so that hierarchical merges chain correctly.
    for (let mi = 0; mi < this.merges.length; mi++) {
      const m = this.merges[mi];
      let i = 0;
      while (i < tokens.length - 1) {
        if (tokens[i] === m.a && tokens[i + 1] === m.b && gaps[i + 1] === " ") {
          tokens[i] = m.merged;
          mergeOf[i] = mi;
          tokens.splice(i + 1, 1);
          gaps.splice(i + 1, 1);
          mergeOf.splice(i + 1, 1);
          // Don't advance — re-check for adjacent matches
        } else {
          i++;
        }
      }
    }

    // Replace merged tokens with «N» placeholders
    for (let i = 0; i < tokens.length; i++) {
      if (mergeOf[i] >= 0) {
        tokens[i] = L_GUILL + mergeOf[i] + R_GUILL;
      }
    }

    // Reconstruct text from gaps + tokens
    let out = "";
    for (let i = 0; i < tokens.length; i++) {
      out += gaps[i] + tokens[i];
    }
    return out;
  }

  /**
   * Decompress text by expanding «N» placeholders back to original text.
   * Lossless: decompress(compress(text)) === text.
   *
   * Each placeholder «N» expands to merges[N].a + " " + merges[N].b.
   * Since merged tokens store the fully-expanded multi-word string (not
   * nested placeholders), a single regex pass suffices.
   * @param {string} text
   * @returns {string} decompressed text
   */
  decompress(text) {
    if (!text || typeof text !== "string" || this.merges.length === 0) return text;
    var merges = this.merges;
    return text.replace(PLACEHOLDER_RE, function (match, idxStr) {
      var idx = parseInt(idxStr, 10);
      if (idx < 0 || idx >= merges.length) return match;
      var m = merges[idx];
      return m.a + " " + m.b;
    });
  }

  /**
   * Compute compression ratio: original_length / compressed_length.
   * Values > 1.0 indicate compression; < 1.0 means expansion.
   * @param {string} text
   * @returns {number}
   */
  compressionRatio(text) {
    if (!text || text.length === 0) return 1.0;
    const compressed = this.compress(text);
    if (compressed.length === 0) return 1.0;
    return text.length / compressed.length;
  }
}

// ── Helper functions ────────────────────────────────────────────────────────

/**
 * Train from the project corpus (.ai-memory/*.jsonl) and save vocab.
 * @param {string} projectRoot - root directory containing .ai-memory/
 * @param {number} vocabSize - number of merges (default 512, max 2048)
 * @returns {{ vocabSize: number, corpusSize: number, avgCompressionRatio: number }}
 */
async function trainFromCorpus(projectRoot, vocabSize) {
  vocabSize = Math.min(vocabSize || 512, MAX_VOCAB_SIZE);
  const memDir = path.join(projectRoot, ".ai-memory");

  // Gather texts from all JSONL sources
  const texts = [];
  const files = ["research.jsonl", "scripts.jsonl", "decisions.jsonl"];
  for (const file of files) {
    const entries = shared.readJsonl(path.join(memDir, file));
    for (const entry of entries) {
      const parts = [];
      if (entry.topic) parts.push(entry.topic);
      if (entry.finding) parts.push(entry.finding);
      if (entry.content) parts.push(entry.content);
      if (entry.decision) parts.push(entry.decision);
      if (entry.rationale) parts.push(entry.rationale);
      if (Array.isArray(entry.tags)) parts.push(entry.tags.join(" "));
      if (parts.length > 0) texts.push(parts.join(" "));
    }
  }

  if (texts.length === 0) {
    return { vocabSize: 0, corpusSize: 0, avgCompressionRatio: 1.0 };
  }

  const compressor = new BPECompressor();
  compressor.train(texts, vocabSize);

  const vocabPath = path.join(memDir, "bpe-vocab.json");
  compressor.save(vocabPath);

  // Compute average compression ratio on the training corpus
  let totalRatio = 0;
  let counted = 0;
  for (const text of texts) {
    if (text.length > 20) {
      totalRatio += compressor.compressionRatio(text);
      counted++;
    }
  }
  const avgCompressionRatio = counted > 0 ? totalRatio / counted : 1.0;

  return {
    vocabSize: compressor.merges.length,
    corpusSize: texts.length,
    avgCompressionRatio: Math.round(avgCompressionRatio * 1000) / 1000
  };
}

/**
 * Quick-load a cached compressor for a project.
 * @param {string} projectRoot
 * @returns {BPECompressor|null}
 */
function loadVocab(projectRoot) {
  const vocabPath = path.join(projectRoot, ".ai-memory", "bpe-vocab.json");
  if (!fs.existsSync(vocabPath)) return null;
  return new BPECompressor(vocabPath);
}

/**
 * Convenience: compress text using the project's trained vocab.
 * @param {string} text
 * @param {string} projectRoot
 * @returns {string}
 */
function compressText(text, projectRoot) {
  const compressor = loadVocab(projectRoot);
  if (!compressor) return text;
  return compressor.compress(text);
}

/**
 * Convenience: decompress text using the project's trained vocab.
 * @param {string} text
 * @param {string} projectRoot
 * @returns {string}
 */
function decompressText(text, projectRoot) {
  const compressor = loadVocab(projectRoot);
  if (!compressor) return text;
  return compressor.decompress(text);
}

// ── CLI entry point ─────────────────────────────────────────────────────────

if (require.main === module) {
  (async function main() {
    const projectRoot = shared.resolveProjectRoot(true);
    console.log("Training BPE compressor from corpus...");
    console.log("Project root:", projectRoot);

    const stats = await trainFromCorpus(projectRoot);
    console.log("");
    console.log("=== Training Results ===");
    console.log("Corpus size:              ", stats.corpusSize, "texts");
    console.log("Merges learned:           ", stats.vocabSize);
    console.log("Avg compression ratio:    ", stats.avgCompressionRatio + "x");

    // Show a few example compressions
    const compressor = loadVocab(projectRoot);
    if (compressor && compressor.merges.length > 0) {
      console.log("");
      console.log("=== Top 10 Merges ===");
      const top = compressor.merges.slice(0, 10);
      for (let i = 0; i < top.length; i++) {
        console.log("  " + i + ": \"" + top[i].a + "\" + \"" + top[i].b + "\"");
      }

      // Round-trip test on a sample
      const memDir = path.join(projectRoot, ".ai-memory");
      const entries = shared.readJsonl(path.join(memDir, "research.jsonl"));
      if (entries.length > 0) {
        const sample = entries[0].finding || entries[0].topic || "";
        if (sample.length > 0) {
          console.log("");
          console.log("=== Round-trip Test ===");
          const compressed = compressor.compress(sample);
          const decompressed = compressor.decompress(compressed);
          const ratio = compressor.compressionRatio(sample);
          console.log("Original length:   ", sample.length);
          console.log("Compressed length: ", compressed.length);
          console.log("Ratio:             ", Math.round(ratio * 1000) / 1000 + "x");
          console.log("Lossless:          ", decompressed === sample ? "YES" : "MISMATCH");
          if (decompressed !== sample) {
            console.log("  Original:     ", sample.slice(0, 200));
            console.log("  Decompressed: ", decompressed.slice(0, 200));
          }
        }
      }
    }

    const vocabPath = path.join(projectRoot, ".ai-memory", "bpe-vocab.json");
    console.log("");
    console.log("Vocab saved to:", vocabPath);
  })().catch(function (err) {
    console.error("Error:", err.message);
    process.exit(1);
  });
}

module.exports = { BPECompressor, trainFromCorpus, loadVocab, compressText, decompressText };
