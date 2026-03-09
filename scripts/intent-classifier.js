#!/usr/bin/env node
"use strict";

/**
 * Semantic intent classifier for Bash commands.
 * Uses pre-computed ONNX embeddings to classify command descriptions
 * as "exploratory" or "operational" — no keyword lists needed.
 *
 * Two modes:
 *   1. Build mode (slow, ~5s): Generate reference embeddings from example phrases
 *      Called once at session start or manually: node intent-classifier.js --build
 *
 *   2. Classify mode (fast, <5ms): Load cached reference embeddings, compute
 *      cosine similarity against the input description. Used by hooks.
 */

const fs = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "..", ".ai-memory", ".intent-embeddings.json");

// Reference phrases that define "exploratory" vs "operational" intent
const EXPLORATORY_EXAMPLES = [
  "Search for a pattern in the codebase",
  "Investigate why the build failed",
  "Check what files contain this function",
  "Look at the API response format",
  "Explore the directory structure",
  "Debug the error by examining logs",
  "Find where this class is defined",
  "Understand how the pipeline works",
  "Analyze the test results",
  "Research how to use this library",
  "Get the build status to investigate failure",
  "Fetch API data to understand the response",
  "List files to see what exists",
  "Read the config to understand settings",
  "Trace the execution path",
  "Inspect the database schema",
  "Check if the service is returning errors",
  "Verify the deployment output",
  "Examine the git history for changes",
  "Query the API to see what data comes back",
];

const OPERATIONAL_EXAMPLES = [
  "Create a new directory",
  "Install npm dependencies",
  "Build the project",
  "Run the test suite",
  "Push changes to remote",
  "Commit the staged files",
  "Start the development server",
  "Deploy to production",
  "Copy files to the output directory",
  "Delete temporary files",
  "Format the code",
  "Generate the build artifacts",
  "Restart the service",
  "Set up the environment",
  "Initialize the database",
  "Apply the migration",
  "Compile the TypeScript",
  "Run the linter",
  "Package the application",
  "Update the version number",
];

/**
 * Build reference embeddings and cache them.
 * Called at session start (background) or manually.
 */
async function buildReferenceEmbeddings() {
  const { generateEmbedding } = require(path.join(__dirname, "embeddings.js"));

  console.log("Building intent classifier reference embeddings...");

  // Generate embeddings for all examples
  const exploratoryVecs = [];
  for (const phrase of EXPLORATORY_EXAMPLES) {
    exploratoryVecs.push(await generateEmbedding(phrase));
  }

  const operationalVecs = [];
  for (const phrase of OPERATIONAL_EXAMPLES) {
    operationalVecs.push(await generateEmbedding(phrase));
  }

  // Compute centroid (average) for each class
  const dim = exploratoryVecs[0].length;

  const exploratoryCentroid = new Array(dim).fill(0);
  for (const vec of exploratoryVecs) {
    for (let i = 0; i < dim; i++) exploratoryCentroid[i] += vec[i];
  }
  for (let i = 0; i < dim; i++) exploratoryCentroid[i] /= exploratoryVecs.length;

  const operationalCentroid = new Array(dim).fill(0);
  for (const vec of operationalVecs) {
    for (let i = 0; i < dim; i++) operationalCentroid[i] += vec[i];
  }
  for (let i = 0; i < dim; i++) operationalCentroid[i] /= operationalVecs.length;

  // Save to cache
  const cache = { exploratoryCentroid, operationalCentroid, builtAt: new Date().toISOString() };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf-8");
  console.log("Intent classifier ready:", CACHE_FILE);
  return cache;
}

/**
 * Load cached reference embeddings.
 * Returns null if cache doesn't exist.
 */
function loadReferenceEmbeddings() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSim(a, b) {
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
 * Classify a description as exploratory or operational.
 * Uses cached reference embeddings + real-time embedding of the description.
 *
 * Returns: { isExploratory: boolean, confidence: number, exploratoryScore, operationalScore }
 * Returns null if classifier not ready (cache missing).
 *
 * FAST PATH: If description embedding is pre-computed, classification is ~1ms.
 * SLOW PATH: If embedding needs to be generated, ~50-200ms (after model warmup).
 */
async function classifyIntent(description) {
  const cache = loadReferenceEmbeddings();
  if (!cache) return null;

  const { generateEmbedding } = require(path.join(__dirname, "embeddings.js"));
  const descEmbedding = await generateEmbedding(description);

  const exploratoryScore = cosineSim(descEmbedding, cache.exploratoryCentroid);
  const operationalScore = cosineSim(descEmbedding, cache.operationalCentroid);

  return {
    isExploratory: exploratoryScore > operationalScore,
    confidence: Math.abs(exploratoryScore - operationalScore),
    exploratoryScore: Math.round(exploratoryScore * 1000) / 1000,
    operationalScore: Math.round(operationalScore * 1000) / 1000,
  };
}

/**
 * Synchronous classification using ONLY the cached centroid vectors
 * and a pre-computed description embedding.
 * This is the fast path for hooks — no async, no model loading.
 *
 * descriptionEmbedding: Float32Array or number[] of the description's embedding
 * Returns: { isExploratory, confidence, exploratoryScore, operationalScore } or null
 */
function classifyIntentSync(descriptionEmbedding) {
  const cache = loadReferenceEmbeddings();
  if (!cache || !descriptionEmbedding) return null;

  const exploratoryScore = cosineSim(descriptionEmbedding, cache.exploratoryCentroid);
  const operationalScore = cosineSim(descriptionEmbedding, cache.operationalCentroid);

  return {
    isExploratory: exploratoryScore > operationalScore,
    confidence: Math.abs(exploratoryScore - operationalScore),
    exploratoryScore: Math.round(exploratoryScore * 1000) / 1000,
    operationalScore: Math.round(operationalScore * 1000) / 1000,
  };
}

// CLI: node intent-classifier.js --build
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--build")) {
    buildReferenceEmbeddings().catch(err => {
      console.error("Build failed:", err.message);
      process.exit(1);
    });
  } else if (args.length > 0 && !args[0].startsWith("-")) {
    // Classify a description from CLI
    const desc = args.join(" ");
    classifyIntent(desc).then(result => {
      if (!result) {
        console.log("Classifier not ready. Run: node intent-classifier.js --build");
      } else {
        console.log(`Description: "${desc}"`);
        console.log(`Classification: ${result.isExploratory ? "EXPLORATORY" : "OPERATIONAL"}`);
        console.log(`Confidence: ${(result.confidence * 100).toFixed(1)}%`);
        console.log(`Exploratory score: ${result.exploratoryScore}`);
        console.log(`Operational score: ${result.operationalScore}`);
      }
    });
  } else {
    console.log("Usage:");
    console.log("  node intent-classifier.js --build           Build reference embeddings");
    console.log('  node intent-classifier.js "description"     Classify a description');
  }
}

module.exports = {
  buildReferenceEmbeddings,
  loadReferenceEmbeddings,
  classifyIntent,
  classifyIntentSync,
  cosineSim,
  CACHE_FILE,
};
