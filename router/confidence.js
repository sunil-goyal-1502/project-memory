"use strict";

/**
 * router/confidence.js — post-hoc quality check on a non-streaming local
 * response. Pure, no side effects.
 *
 * check(commonResponse, originalRequest) → { confident: bool, reasons: [...] }
 *
 * Returns NOT confident if any of these rules fire:
 *   1. Empty / whitespace-only assistant content AND no tool_calls.
 *   2. stop_reason / finish_reason is `length` AND completion_tokens < 50
 *      (the model bailed out early under the cap).
 *   3. Refusal/hedge phrases at the start of the content (case-insensitive),
 *      e.g. "I cannot", "I can't", "I am unable", "I don't have access",
 *      "I do not have", "Sorry, I…".
 *   4. Tools were provided in the request, the assistant produced no
 *      tool_calls, AND the content reads like an apology/refusal.
 *   5. Truncated mid-sentence: no terminal `.!?` and length < 100 chars.
 *      (Heuristic — long answers often end at a paragraph break.)
 *   6. Repetitive output: the same trigram repeated > 5 times in a row
 *      (a degenerate-loop sign in small local models).
 *
 * Each reason string starts with the rule number for easy debugging.
 */

const REFUSAL_RE = /^\s*(I (cannot|can'?t|am unable|don'?t have access|do not have)|Sorry,?\s*I)/i;

function getContent(resp) {
  if (!resp) return "";
  if (typeof resp.content === "string") return resp.content;
  // Defensive: if content is array-of-blocks, join text parts.
  if (Array.isArray(resp.content)) {
    return resp.content.map((b) => (b && b.text) || "").join("");
  }
  return "";
}

function getToolCalls(resp) {
  return (resp && Array.isArray(resp.tool_calls)) ? resp.tool_calls : [];
}

function getStopReason(resp) {
  if (!resp) return null;
  return resp.stop_reason || resp.finish_reason || (resp.usage && resp.usage.stop_reason) || null;
}

function getCompletionTokens(resp) {
  if (!resp || !resp.usage) return null;
  return resp.usage.output_tokens
      ?? resp.usage.completion_tokens
      ?? null;
}

function endsTerminally(text) {
  const t = text.trimEnd();
  if (!t) return false;
  const last = t.charAt(t.length - 1);
  return last === "." || last === "!" || last === "?" || last === '"' || last === "”" || last === ")" || last === "`";
}

function hasRepetitiveTrigrams(text, threshold = 5) {
  if (!text || text.length < 30) return false;
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 3 + threshold) return false;
  let last = null, run = 0;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const tri = tokens[i] + " " + tokens[i + 1] + " " + tokens[i + 2];
    if (tri === last) {
      run++;
      if (run > threshold) return true;
    } else {
      last = tri;
      run = 1;
    }
  }
  return false;
}

function looksApology(text) {
  // Cheap secondary check used in rule 4. Distinct from REFUSAL_RE so a
  // mid-sentence apology counts even if the response doesn't open with one.
  return /\b(sorry|apolog(y|ize)|unable to|cannot help|can'?t help)\b/i.test(text);
}

/**
 * @param {object} commonResponse - shape produced by adapter.ollamaToCommon()
 *                                   { content, tool_calls, stop_reason, usage }
 * @param {object} originalRequest - the commonRequest that produced it
 * @returns {{ confident: boolean, reasons: string[] }}
 */
function check(commonResponse, originalRequest) {
  const reasons = [];
  const content = getContent(commonResponse);
  const trimmed = content.trim();
  const toolCalls = getToolCalls(commonResponse);
  const stopReason = getStopReason(commonResponse);
  const completionTokens = getCompletionTokens(commonResponse);
  const requestedTools = !!(originalRequest && Array.isArray(originalRequest.tools) && originalRequest.tools.length);

  // Rule 1: empty / whitespace-only AND no tool_calls.
  if (!trimmed && toolCalls.length === 0) {
    reasons.push("1: empty assistant content and no tool_calls");
  }

  // Rule 2: bailed early under the length cap.
  if ((stopReason === "length" || stopReason === "max_tokens") &&
      Number.isFinite(completionTokens) && completionTokens < 50) {
    reasons.push(`2: stop_reason=${stopReason} with completion_tokens=${completionTokens} (<50)`);
  }

  // Rule 3: opens with a refusal/hedge.
  if (trimmed && REFUSAL_RE.test(trimmed)) {
    reasons.push("3: refusal/hedge phrase at start of response");
  }

  // Rule 4: tools requested but ignored, AND content looks like apology.
  if (requestedTools && toolCalls.length === 0 && looksApology(trimmed)) {
    reasons.push("4: tools provided but model returned apology/refusal instead of tool_call");
  }

  // Rule 5: truncated mid-sentence (short).
  if (trimmed && trimmed.length < 100 && !endsTerminally(trimmed) && toolCalls.length === 0) {
    reasons.push(`5: truncated mid-sentence (len=${trimmed.length}, no terminal punctuation)`);
  }

  // Rule 6: degenerate trigram loop.
  if (trimmed && hasRepetitiveTrigrams(trimmed)) {
    reasons.push("6: repetitive trigram loop detected");
  }

  return { confident: reasons.length === 0, reasons };
}

module.exports = {
  check,
  // exposed for tests
  REFUSAL_RE,
  hasRepetitiveTrigrams,
  endsTerminally,
};
