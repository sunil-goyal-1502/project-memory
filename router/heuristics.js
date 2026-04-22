"use strict";

/**
 * router/heuristics.js
 *
 * Pure-function 15-dimensional complexity feature vector for AI Router.
 *
 * Operates on a "commonRequest" shape produced by router/adapter.js (Phase A):
 *   {
 *     messages: [{ role, content }, ...],   // content may be string OR array of parts
 *     system:   string | array | undefined,
 *     tools:    array | undefined,
 *     params: {
 *       max_tokens?, temperature?, response_format?,
 *       stop?, stop_sequences?, ...
 *     },
 *     stream?:  boolean,
 *     kind?:    'chat' | 'embedding' | 'completion' | ...
 *   }
 *
 * Output:
 *   {
 *     score:      number in [0, 1],   // higher = more complex
 *     signals:    [{ name, value, weight, contribution }, ...],
 *     borderline: boolean (0.4 <= score <= 0.7),
 *     forced:     boolean (one of the hard "force complex" rules tripped)
 *   }
 *
 * Design note: weights are tuned conservatively. When in doubt, push toward
 * "complex" rather than risking quality loss by routing a hard prompt to a
 * small local model. The four FORCE_COMPLEX gates short-circuit scoring to 1.0.
 */

// ---------------------------------------------------------------------------
// Tunables — kept at top so they can be reviewed/adjusted from one place.
// Weights reflect "how strongly does this signal predict complex output?".
// They are normalized at the end so we don't have to balance them by hand.
// ---------------------------------------------------------------------------
const WEIGHTS = {
  promptTokens:        2.0,  // long prompt ≈ a lot for the model to track
  conversationDepth:   1.0,  // multi-turn → context-heavy
  toolCount:           2.5,  // any tool definition is a complexity smell
  toolByteSize:        1.0,  // big schemas are hard for small models
  codeBlocks:          1.5,  // code = structured output expected
  largestCodeBlock:    1.5,  // big code blob → likely refactor / explain
  structuredOutput:    1.5,  // JSON schema / response_format
  imperativeVerbs:     2.0,  // "implement / refactor / migrate / architect"
  multiFileRefs:       2.0,  // touches several files → cross-file reasoning
  diffMarkers:         2.5,  // diff/patch in prompt → real engineering work
  reasoningRequest:    1.5,  // "think step by step", "analyze", etc.
  urlCount:            0.5,  // research-style; only mild signal
  recentAssistantLen:  0.5,  // long prior reply → deep convo
  outputBudget:        1.0,  // big max_tokens → user expects depth
  temperature:         0.5,  // > 0.7 → creative work
  stopConstraints:     0.3,  // explicit stop seqs → format constraints
};

// Hard gates: if any of these fire, score is forced to 1.0 ("complex").
const FORCE_COMPLEX_TOOL_COUNT      = 1;     // strictly > 1 forces complex
const FORCE_COMPLEX_CODE_BLOCK_SIZE = 5000;
const FORCE_COMPLEX_FILE_REFS       = 3;     // strictly > 3 forces complex

// Borderline band — caller (classifier.js) escalates to semantic in this band.
const BORDERLINE_LOW  = 0.4;
const BORDERLINE_HIGH = 0.7;

// Aggregation: we combine raw weighted contributions via 1 - exp(-sum/K).
// This is the standard "any-of" combinator from probabilistic OR — strong
// signals push the score up without being diluted by all the silent dimensions.
// K is calibrated so a single strong signal (e.g. imperativeVerbs at full
// weight = 2.0) lands around 0.43 (borderline) and two strong signals push
// firmly into "complex".
const AGGREGATION_K = 3.5;

// Saturation points — values >= these contribute the FULL weight; below
// they contribute proportionally. Picked from informal observation of
// "what's a long Claude Code prompt vs a short one".
const SAT = {
  promptTokens:       4000,    // ~16k chars
  conversationDepth:  10,
  toolByteSize:       8000,    // bytes of JSON.stringify(tools)
  codeBlocks:         3,
  largestCodeBlock:   2000,    // chars (anything > 5000 is forced anyway)
  multiFileRefs:      3,
  reasoningHits:      2,
  urlCount:           3,
  recentAssistantLen: 2000,
  outputBudgetLow:    2048,    // below this → 0 contribution
  outputBudgetHigh:   8192,    // at this and above → full contribution
  temperatureLow:     0.7,     // below this → 0 contribution
  temperatureHigh:    1.0,
};

// ---------------------------------------------------------------------------
// Pattern banks
// ---------------------------------------------------------------------------
const IMPERATIVE_VERBS = [
  "implement", "design", "architect", "refactor", "migrate",
  "redesign", "restructure",
];
const IMPERATIVE_RE = new RegExp(
  `\\b(?:${IMPERATIVE_VERBS.join("|")})\\b`,
  "gi"
);

const REASONING_PHRASES = [
  /think\s+step\s+by\s+step/gi,
  /reason\s+about/gi,
  /\banalyz[e|ing]\b/gi,
  /walk\s+me\s+through/gi,
  /explain\s+in\s+detail/gi,
  /chain\s+of\s+thought/gi,
];

const DIFF_RE      = /(^|\n)(?:diff --git|@@ |\+\+\+ |--- )/;
const URL_RE       = /https?:\/\/\S+/g;
// path-like: foo/bar.ext, deep/nested/file.ts, or a Windows absolute path
const POSIX_PATH_RE   = /\b[\w-]+(?:\/[\w.-]+){1,}\.[a-z0-9]+\b/gi;
const WIN_PATH_RE     = /[A-Za-z]:\\[\w.\\-]+/g;
const CODE_FENCE_RE   = /```/g;
// Captures content of fenced code blocks for size measurement
const CODE_BLOCK_BODY = /```[\w-]*\n?([\s\S]*?)```/g;

const STRUCT_OUTPUT_HINT = /\b(?:respond|reply|return|output)\s+(?:in|as|with)\s+(?:json|yaml|xml)\b/i;
const JSON_SCHEMA_HINT   = /"\$schema"|"type"\s*:\s*"object"/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flatten Anthropic-style content (string OR array of parts) into plain text. */
function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (!p || typeof p !== "object") return "";
        if (typeof p.text === "string") return p.text;
        if (typeof p.content === "string") return p.content;
        // tool_use / tool_result blocks: stringify input/content for sizing
        if (p.input != null) return JSON.stringify(p.input);
        if (Array.isArray(p.content)) return contentToText(p.content);
        return "";
      })
      .join("\n");
  }
  return "";
}

/** Coalesce all messages into a single text blob (cheap; chars/4 token est). */
function allMessagesText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages.map((m) => contentToText(m && m.content)).join("\n");
}

/** Estimate token count with the conventional chars/4 rule. */
function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

/** Linear ramp 0..1 between lo and hi. Saturates at endpoints. */
function ramp(value, lo, hi) {
  if (value <= lo) return 0;
  if (value >= hi) return 1;
  return (value - lo) / (hi - lo);
}

/** Saturating 0..sat ramp (anything below 0 → 0, above sat → 1). */
function sat(value, ceiling) {
  if (!ceiling) return 0;
  if (value <= 0) return 0;
  if (value >= ceiling) return 1;
  return value / ceiling;
}

/** Find the last user message text in a messages array. */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return contentToText(m.content);
  }
  return "";
}

/** Find the last assistant message text. */
function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") return contentToText(m.content);
  }
  return "";
}

// ---------------------------------------------------------------------------
// score(commonRequest) — main export
// ---------------------------------------------------------------------------

/**
 * Compute the 15-dim heuristic complexity score for a commonRequest.
 *
 * Always returns synchronously and within ~1ms even for very large requests:
 * all per-message work is one pass of string concatenation + a handful of
 * regex scans. No allocations beyond the signals array.
 *
 * @param {object} req commonRequest produced by router/adapter.js
 * @returns {{score:number, signals:Array, borderline:boolean, forced:boolean}}
 */
function score(req) {
  const safe = req && typeof req === "object" ? req : {};
  const messages = Array.isArray(safe.messages) ? safe.messages : [];
  const tools    = Array.isArray(safe.tools)    ? safe.tools    : [];
  const params   = (safe.params && typeof safe.params === "object") ? safe.params : {};

  const fullText  = allMessagesText(messages) + "\n" + contentToText(safe.system);
  const userText  = lastUserText(messages);
  const asstText  = lastAssistantText(messages);

  const signals = [];
  let weightedSum = 0;
  const add = (name, value, weight, contribution01) => {
    const w = weight;
    const c = Math.max(0, Math.min(1, contribution01));
    const contribution = w * c;
    weightedSum += contribution;
    signals.push({ name, value, weight: w, contribution: +contribution.toFixed(3) });
  };

  // ---- 1. Total prompt tokens (chars/4 estimate) ------------------------
  const promptTokens = estimateTokens(fullText);
  add("promptTokens", promptTokens, WEIGHTS.promptTokens,
      sat(promptTokens, SAT.promptTokens));

  // ---- 2. Conversation depth -------------------------------------------
  const turns = messages.length;
  add("conversationDepth", turns, WEIGHTS.conversationDepth,
      sat(turns, SAT.conversationDepth));

  // ---- 3. Tool definitions count ---------------------------------------
  const toolCount = tools.length;
  add("toolCount", toolCount, WEIGHTS.toolCount,
      // 0 → 0, 1 → 0.5, ≥2 → 1.0 (and FORCE_COMPLEX fires anyway)
      toolCount === 0 ? 0 : toolCount === 1 ? 0.5 : 1);

  // ---- 4. Tool definition byte size ------------------------------------
  let toolBytes = 0;
  if (toolCount > 0) {
    try { toolBytes = JSON.stringify(tools).length; } catch { toolBytes = 0; }
  }
  add("toolByteSize", toolBytes, WEIGHTS.toolByteSize,
      sat(toolBytes, SAT.toolByteSize));

  // ---- 5. Code block count + largest size ------------------------------
  const fences = (fullText.match(CODE_FENCE_RE) || []).length;
  const codeBlocks = Math.floor(fences / 2);
  let largestCode = 0;
  let m;
  CODE_BLOCK_BODY.lastIndex = 0;
  while ((m = CODE_BLOCK_BODY.exec(fullText)) !== null) {
    if (m[1] && m[1].length > largestCode) largestCode = m[1].length;
  }
  add("codeBlocks", codeBlocks, WEIGHTS.codeBlocks,
      sat(codeBlocks, SAT.codeBlocks));
  add("largestCodeBlock", largestCode, WEIGHTS.largestCodeBlock,
      sat(largestCode, SAT.largestCodeBlock));

  // ---- 6. Structured output requested ----------------------------------
  let structured = 0;
  if (params.response_format) structured = 1;
  if (!structured && STRUCT_OUTPUT_HINT.test(userText)) structured = 1;
  if (!structured && toolCount > 0) {
    try {
      const blob = JSON.stringify(tools);
      if (JSON_SCHEMA_HINT.test(blob)) structured = 0.5;
    } catch { /* ignore */ }
  }
  add("structuredOutput", structured, WEIGHTS.structuredOutput, structured);

  // ---- 7. Imperative architectural verbs -------------------------------
  // A single occurrence of "refactor"/"architect"/"migrate"/etc. is already
  // a strong signal — full weight on first hit, no diminishing scaling.
  const verbHits = (fullText.match(IMPERATIVE_RE) || []).length;
  add("imperativeVerbs", verbHits, WEIGHTS.imperativeVerbs,
      verbHits === 0 ? 0 : 1);

  // ---- 8. Multi-file references ----------------------------------------
  const posixPaths = (fullText.match(POSIX_PATH_RE) || []).length;
  const winPaths   = (fullText.match(WIN_PATH_RE)   || []).length;
  const fileRefs   = posixPaths + winPaths;
  add("multiFileRefs", fileRefs, WEIGHTS.multiFileRefs,
      sat(fileRefs, SAT.multiFileRefs));

  // ---- 9. Diff/patch markers -------------------------------------------
  const hasDiff = DIFF_RE.test(fullText) ? 1 : 0;
  add("diffMarkers", hasDiff, WEIGHTS.diffMarkers, hasDiff);

  // ---- 10. Explicit reasoning request ----------------------------------
  let reasoningHits = 0;
  for (const re of REASONING_PHRASES) {
    re.lastIndex = 0;
    const matches = fullText.match(re);
    if (matches) reasoningHits += matches.length;
  }
  add("reasoningRequest", reasoningHits, WEIGHTS.reasoningRequest,
      sat(reasoningHits, SAT.reasoningHits));

  // ---- 11. URL count ----------------------------------------------------
  const urls = (fullText.match(URL_RE) || []).length;
  add("urlCount", urls, WEIGHTS.urlCount, sat(urls, SAT.urlCount));

  // ---- 12. Recent assistant message length -----------------------------
  add("recentAssistantLen", asstText.length, WEIGHTS.recentAssistantLen,
      sat(asstText.length, SAT.recentAssistantLen));

  // ---- 13. Output token budget -----------------------------------------
  const maxTok = Number(params.max_tokens) || 0;
  add("outputBudget", maxTok, WEIGHTS.outputBudget,
      ramp(maxTok, SAT.outputBudgetLow, SAT.outputBudgetHigh));

  // ---- 14. Temperature --------------------------------------------------
  const temp = (typeof params.temperature === "number") ? params.temperature : 0;
  add("temperature", temp, WEIGHTS.temperature,
      ramp(temp, SAT.temperatureLow, SAT.temperatureHigh));

  // ---- 15. Stop sequences / format constraints --------------------------
  const stopVal = params.stop || params.stop_sequences;
  const hasStop = (typeof stopVal === "string" && stopVal.length > 0) ||
                  (Array.isArray(stopVal) && stopVal.length > 0);
  add("stopConstraints", hasStop ? 1 : 0, WEIGHTS.stopConstraints, hasStop ? 1 : 0);

  // -----------------------------------------------------------------------
  // Hard FORCE_COMPLEX gates — applied AFTER signal accounting so the
  // signals array still records what we observed, but the score saturates.
  // -----------------------------------------------------------------------
  let forced = false;
  const forceReasons = [];
  if (toolCount > FORCE_COMPLEX_TOOL_COUNT) {
    forced = true;
    forceReasons.push(`toolCount=${toolCount} > ${FORCE_COMPLEX_TOOL_COUNT}`);
  }
  if (largestCode > FORCE_COMPLEX_CODE_BLOCK_SIZE) {
    forced = true;
    forceReasons.push(`largestCodeBlock=${largestCode} > ${FORCE_COMPLEX_CODE_BLOCK_SIZE}`);
  }
  if (hasDiff) {
    forced = true;
    forceReasons.push("diff/patch markers present");
  }
  if (fileRefs > FORCE_COMPLEX_FILE_REFS) {
    forced = true;
    forceReasons.push(`multiFileRefs=${fileRefs} > ${FORCE_COMPLEX_FILE_REFS}`);
  }

  let finalScore = 1 - Math.exp(-weightedSum / AGGREGATION_K);
  if (forced) {
    finalScore = 1.0;
    signals.push({
      name: "forced",
      value: forceReasons.join("; "),
      weight: 0,
      contribution: 0,
    });
  }
  // Clamp to [0,1] to defend against future weight changes.
  if (finalScore < 0) finalScore = 0;
  if (finalScore > 1) finalScore = 1;

  const borderline =
    !forced && finalScore >= BORDERLINE_LOW && finalScore <= BORDERLINE_HIGH;

  return {
    score: +finalScore.toFixed(4),
    signals,
    borderline,
    forced,
  };
}

module.exports = {
  score,
  // Exposed for tests / classifier.js
  WEIGHTS,
  BORDERLINE_LOW,
  BORDERLINE_HIGH,
  contentToText,
  lastUserText,
  lastAssistantText,
  estimateTokens,
};
