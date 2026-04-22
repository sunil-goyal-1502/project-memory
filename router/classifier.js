"use strict";

/**
 * router/classifier.js
 *
 * Pipeline: heuristics → (borderline?) → semantic → blend → guardrails.
 *
 * classify(commonRequest) → {
 *   complexity:    'simple' | 'medium' | 'complex',
 *   confidence:    0..1,
 *   reasons:       [string, ...],
 *   heuristicScore: number,
 *   semanticScore?: { category, confidence, scores },
 *   forced?:       boolean
 * }
 *
 * Latency targets:
 *   - heuristics-only path: < 1ms
 *   - semantic-cached path: < 50ms
 */

const heuristics = require("./heuristics.js");

// Lazy-load the semantic classifier so callers that never touch the
// borderline band don't pay the @huggingface/transformers cold-start cost.
let _semantic = null;
function getSemantic() {
  if (!_semantic) _semantic = require("./semantic-classifier.js");
  return _semantic;
}

// Decision band thresholds (mirror heuristics.js for clarity).
const SIMPLE_MAX  = 0.4;   // score < SIMPLE_MAX  → simple
const COMPLEX_MIN = 0.7;   // score > COMPLEX_MIN → complex
// Borderline blend → categorize via blended score:
const BLEND_SIMPLE_MAX  = 0.45;
const BLEND_COMPLEX_MIN = 0.65;

/**
 * Run the full hybrid classification pipeline.
 *
 * @param {object} req commonRequest from router/adapter.js
 * @returns {Promise<{complexity:string, confidence:number, reasons:string[], heuristicScore:number, semanticScore?:object, forced?:boolean}>}
 */
async function classify(req) {
  const reasons = [];

  // -----------------------------------------------------------------------
  // Guardrail: unparseable / unrecognized request → safe default.
  // -----------------------------------------------------------------------
  if (!req || typeof req !== "object") {
    return {
      complexity: "complex",
      confidence: 1,
      reasons: ["request body unparseable or missing — defaulting to complex"],
      heuristicScore: 1,
    };
  }

  // -----------------------------------------------------------------------
  // Guardrail: embeddings request → always simple (Ollama handles them well).
  // We check this BEFORE heuristics because it's a cheap short-circuit.
  // -----------------------------------------------------------------------
  if (req.kind === "embedding") {
    return {
      complexity: "simple",
      confidence: 1,
      reasons: ["kind=embedding → always routed simple"],
      heuristicScore: 0,
    };
  }

  // -----------------------------------------------------------------------
  // Step 1: heuristics
  // -----------------------------------------------------------------------
  let h;
  try {
    h = heuristics.score(req);
  } catch (err) {
    return {
      complexity: "complex",
      confidence: 1,
      reasons: [`heuristics threw (${err.message}) — defaulting to complex`],
      heuristicScore: 1,
    };
  }

  // Capture top contributing signals for the audit trail.
  const topSignals = [...h.signals]
    .filter((s) => s.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map((s) => `${s.name}(${s.contribution})`);
  if (topSignals.length) reasons.push(`top signals: ${topSignals.join(", ")}`);

  let complexity;
  let confidence;
  let semanticScore;

  if (h.forced) {
    complexity = "complex";
    confidence = 1;
    const forcedSig = h.signals.find((s) => s.name === "forced");
    reasons.push(`force-complex: ${forcedSig ? forcedSig.value : "rule fired"}`);
  } else if (h.score < SIMPLE_MAX) {
    complexity = "simple";
    confidence = 1 - h.score / SIMPLE_MAX; // 0 score → 1, 0.4 → 0
    reasons.push(`heuristic ${h.score.toFixed(2)} < ${SIMPLE_MAX} → simple`);
  } else if (h.score > COMPLEX_MIN) {
    complexity = "complex";
    confidence = (h.score - COMPLEX_MIN) / (1 - COMPLEX_MIN); // 0.7→0, 1→1
    reasons.push(`heuristic ${h.score.toFixed(2)} > ${COMPLEX_MIN} → complex`);
  } else {
    // ---------------------------------------------------------------------
    // Step 2: borderline → semantic classifier, blend 50/50
    // ---------------------------------------------------------------------
    reasons.push(`heuristic ${h.score.toFixed(2)} in borderline [${SIMPLE_MAX}, ${COMPLEX_MIN}] → escalating to semantic`);
    const userText = heuristics.lastUserText(req.messages);
    try {
      semanticScore = await getSemantic().classify(userText);
      reasons.push(
        `semantic: ${semanticScore.category} ` +
        `(simple=${semanticScore.scores.simple}, complex=${semanticScore.scores.complex}, ` +
        `conf=${semanticScore.confidence})`
      );
      // Blend: heuristic score (0..1, complex-leaning) with semantic complex score.
      const blended = 0.5 * h.score + 0.5 * semanticScore.scores.complex;
      reasons.push(`blended score: ${blended.toFixed(3)}`);
      if (blended < BLEND_SIMPLE_MAX) {
        complexity = "simple";
      } else if (blended > BLEND_COMPLEX_MIN) {
        complexity = "complex";
      } else {
        complexity = "medium";
      }
      // Confidence: distance from the medium midpoint.
      const mid = (BLEND_SIMPLE_MAX + BLEND_COMPLEX_MIN) / 2;
      confidence = Math.min(1, Math.abs(blended - mid) * 4);
    } catch (err) {
      // Semantic fallback: trust the heuristic, lean conservative.
      reasons.push(`semantic failed (${err.message}) — falling back to heuristic`);
      complexity = h.score >= 0.5 ? "complex" : "medium";
      confidence = 0.3;
    }
  }

  // -----------------------------------------------------------------------
  // Step 3: hard guardrails (applied last, can override above).
  // -----------------------------------------------------------------------
  const tools = Array.isArray(req.tools) ? req.tools : [];
  if (tools.length > 1) {
    if (complexity !== "complex") {
      reasons.push(`guardrail: tools.length=${tools.length} > 1 → forcing complex`);
    }
    complexity = "complex";
    confidence = 1;
  }

  return {
    complexity,
    confidence: +confidence.toFixed(4),
    reasons,
    heuristicScore: h.score,
    ...(semanticScore ? { semanticScore } : {}),
    ...(h.forced ? { forced: true } : {}),
  };
}

module.exports = {
  classify,
  // Exposed for tests
  SIMPLE_MAX,
  COMPLEX_MIN,
  BLEND_SIMPLE_MAX,
  BLEND_COMPLEX_MIN,
};
