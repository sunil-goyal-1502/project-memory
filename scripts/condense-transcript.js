#!/usr/bin/env node
"use strict";

const fs = require("fs");

/**
 * Condenses a Claude Code JSONL transcript file into a concise text summary.
 *
 * Extracts: user messages, assistant text (skipping tool_use blocks),
 * tool names + file paths (for context).
 * Typically produces output 5-10x smaller than raw JSONL.
 *
 * Tags research-relevant content with [RESEARCH] and [RESEARCH-CANDIDATE] prefixes
 * to help the research-extractor agent focus on findings.
 */

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB safety limit

const RESEARCH_TOOL_NAMES = ["WebFetch", "WebSearch"];
const RESEARCH_SIGNAL_PHRASES = [
  "i found that",
  "the documentation says",
  "this api returns",
  "testing shows",
  "according to",
  "the docs mention",
  "the error occurs because",
  "the root cause is",
  "this library requires",
  "the behavior is",
  "it turns out that",
  "the issue was",
];

function condenseTranscript(transcriptPath) {
  const stat = fs.statSync(transcriptPath);
  if (stat.size > MAX_FILE_SIZE) {
    return "[Transcript too large to process]";
  }

  const raw = fs.readFileSync(transcriptPath, "utf-8");
  const lines = raw.split("\n");
  const parts = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // Skip malformed lines
    }

    const role = entry.role || entry.type;

    if (role === "user") {
      const content = extractTextContent(entry.content);
      if (content && !isSystemMessage(content)) {
        parts.push(`USER: ${content}`);
      }
    } else if (role === "assistant") {
      const { text, tools } = extractAssistantContent(entry.content);
      if (text) {
        // Check if text contains research-signal phrases
        const lower = text.toLowerCase();
        const hasResearchSignal = RESEARCH_SIGNAL_PHRASES.some((phrase) =>
          lower.includes(phrase)
        );
        if (hasResearchSignal) {
          parts.push(`[RESEARCH-CANDIDATE] ASSISTANT: ${text}`);
        } else {
          parts.push(`ASSISTANT: ${text}`);
        }
      }
      if (tools.length > 0) {
        parts.push(`  [Tools: ${tools.join(", ")}]`);
      }
    }
  }

  return parts.join("\n\n");
}

function extractTextContent(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const textParts = [];
    for (const block of content) {
      if (typeof block === "string") {
        textParts.push(block);
      } else if (block.type === "text" && block.text) {
        textParts.push(block.text);
      }
    }
    return textParts.join("\n").trim();
  }
  if (content && typeof content === "object" && content.text) {
    return content.text.trim();
  }
  return "";
}

function extractAssistantContent(content) {
  const result = { text: "", tools: [] };

  if (typeof content === "string") {
    result.text = content.trim();
    return result;
  }

  if (!Array.isArray(content)) return result;

  const textParts = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      const toolName = block.name || "unknown";
      // Check if this is a research-relevant tool
      const isResearchTool =
        RESEARCH_TOOL_NAMES.includes(toolName) || toolName.startsWith("mcp__");
      const prefix = isResearchTool ? "[RESEARCH] " : "";

      // Extract file path context from tool inputs
      let context = `${prefix}${toolName}`;
      if (block.input) {
        const filePath =
          block.input.file_path ||
          block.input.path ||
          block.input.file ||
          block.input.url ||
          block.input.command;
        if (filePath && typeof filePath === "string") {
          // Truncate long commands
          const short =
            filePath.length > 80 ? filePath.substring(0, 80) + "..." : filePath;
          context = `${prefix}${toolName}(${short})`;
        }
      }
      result.tools.push(context);
    }
  }

  result.text = textParts.join("\n").trim();
  return result;
}

function isSystemMessage(text) {
  const lower = text.toLowerCase();
  return (
    lower.startsWith("/") ||
    lower.startsWith("[system") ||
    lower.startsWith("system:") ||
    lower.includes("<system-reminder>")
  );
}

module.exports = { condenseTranscript };
