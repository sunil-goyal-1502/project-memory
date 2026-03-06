#!/usr/bin/env node
"use strict";

/**
 * Shared utility functions for project-memory plugin scripts.
 * DRY: these were previously duplicated across save-research.js,
 * save-decision.js, check-memory.js, session-summary.js, etc.
 */

const fs = require("fs");
const path = require("path");

// ── Project Root Discovery ──

function findProjectRoot(startDir) {
  let dir = startDir || process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, ".ai-memory"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function scanHomeForProjects() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return null;
  const candidates = [];
  if (fs.existsSync(path.join(home, ".ai-memory"))) candidates.push(home);
  try {
    const entries = fs.readdirSync(home, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const childPath = path.join(home, entry.name);
        if (fs.existsSync(path.join(childPath, ".ai-memory"))) candidates.push(childPath);
      }
    }
  } catch { /* permission errors */ }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  candidates.sort((a, b) => {
    try {
      return fs.statSync(path.join(b, ".ai-memory")).mtimeMs -
             fs.statSync(path.join(a, ".ai-memory")).mtimeMs;
    } catch { return 0; }
  });
  return candidates[0];
}

function resolveProjectRoot(exitOnMissing = true) {
  const root = findProjectRoot(process.cwd()) || scanHomeForProjects();
  if (!root && exitOnMissing) {
    console.error("No .ai-memory/ found");
    process.exit(1);
  }
  return root;
}

// ── JSONL Read/Write ──

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  const entries = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
  }
  return entries;
}

function appendJsonl(filePath, entry) {
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

// ── Tokenization ──

function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s\.\,\;\:\(\)\[\]\{\}\|\!\?\"\'\`\~\@\#\$\%\^\&\*\+\=\<\>\/\\]+/)
    .filter(t => t.length > 0);
}

// ── Entity Index ──

function readEntityIndex(projectRoot) {
  const indexPath = path.join(projectRoot, ".ai-memory", "entity-index.json");
  if (!fs.existsSync(indexPath)) return {};
  try { return JSON.parse(fs.readFileSync(indexPath, "utf-8")); } catch { return {}; }
}

function writeEntityIndex(projectRoot, index) {
  const indexPath = path.join(projectRoot, ".ai-memory", "entity-index.json");
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
}

function addToEntityIndex(projectRoot, entities, findingId) {
  if (!entities || entities.length === 0) return;
  const index = readEntityIndex(projectRoot);
  for (const entity of entities) {
    const key = entity.toLowerCase().trim();
    if (!key) continue;
    if (!index[key]) index[key] = [];
    if (!index[key].includes(findingId)) index[key].push(findingId);
  }
  writeEntityIndex(projectRoot, index);
}

// ── Exploration Breadcrumbs ──

const EXPLORATION_LOG_FILE = ".exploration-log";

function appendBreadcrumb(projectRoot, breadcrumb) {
  const logPath = path.join(projectRoot, ".ai-memory", EXPLORATION_LOG_FILE);
  const entry = { ts: new Date().toISOString(), tool: breadcrumb.tool, ...breadcrumb, saved: false };
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

function readExplorationLog(projectRoot) {
  return readJsonl(path.join(projectRoot, ".ai-memory", EXPLORATION_LOG_FILE));
}

function clearExplorationLog(projectRoot) {
  const logPath = path.join(projectRoot, ".ai-memory", EXPLORATION_LOG_FILE);
  try { fs.unlinkSync(logPath); } catch { /* doesn't exist */ }
}

function getUnsavedBreadcrumbs(projectRoot) {
  const breadcrumbs = readExplorationLog(projectRoot);
  if (breadcrumbs.length === 0) return [];
  let lastSaveTs = 0;
  for (const file of ["research.jsonl", "decisions.jsonl"]) {
    try {
      const stat = fs.statSync(path.join(projectRoot, ".ai-memory", file));
      if (stat.mtimeMs > lastSaveTs) lastSaveTs = stat.mtimeMs;
    } catch { /* file doesn't exist */ }
  }
  const lastSaveIso = lastSaveTs > 0 ? new Date(lastSaveTs).toISOString() : "";
  return breadcrumbs.filter(b => !lastSaveIso || (b.ts || "") > lastSaveIso);
}

// ── BM25 Search ──

function buildBM25Index(entries) {
  const invertedIndex = {};
  const docLengths = {};
  let totalLength = 0;
  for (const entry of entries) {
    const docId = entry.id;
    const text = [entry.topic || "", (entry.tags || []).join(" "), entry.finding || entry.decision || "", (entry.entities || []).join(" ")].join(" ");
    const tokens = tokenize(text);
    docLengths[docId] = tokens.length;
    totalLength += tokens.length;
    const tfMap = {};
    for (const token of tokens) tfMap[token] = (tfMap[token] || 0) + 1;
    for (const [term, tf] of Object.entries(tfMap)) {
      if (!invertedIndex[term]) invertedIndex[term] = [];
      invertedIndex[term].push({ docId, tf });
    }
  }
  return { invertedIndex, docLengths, avgDocLen: entries.length > 0 ? totalLength / entries.length : 0, N: entries.length };
}

function bm25Score(query, bm25Index, k1 = 1.2, b = 0.75) {
  const { invertedIndex, docLengths, avgDocLen, N } = bm25Index;
  const queryTerms = tokenize(query);
  const scores = {};
  for (const term of queryTerms) {
    const postings = invertedIndex[term];
    if (!postings) continue;
    const df = postings.length;
    const idf = Math.max(0, Math.log((N - df + 0.5) / (df + 0.5) + 1));
    for (const { docId, tf } of postings) {
      const dl = docLengths[docId] || 0;
      const score = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / (avgDocLen || 1)))));
      scores[docId] = (scores[docId] || 0) + score;
    }
  }
  return Object.entries(scores).map(([docId, score]) => ({ docId, score })).sort((a, b) => b.score - a.score);
}

// ── Deduplication ──

function findSimilarEntry(existingEntries, newTopic, newTags) {
  const newTopicLower = (newTopic || "").toLowerCase();
  const newTagSet = new Set((newTags || []).map(t => t.toLowerCase().trim()));
  for (const entry of existingEntries) {
    const existingTopicLower = (entry.topic || "").toLowerCase();
    const topicMatch = existingTopicLower.includes(newTopicLower) || newTopicLower.includes(existingTopicLower);
    if (!topicMatch) continue;
    const existingTags = (entry.tags || []).map(t => t.toLowerCase());
    let matchingTags = 0;
    for (const tag of existingTags) { if (newTagSet.has(tag)) matchingTags++; }
    if (matchingTags >= 2) return entry;
  }
  return null;
}

module.exports = {
  findProjectRoot, scanHomeForProjects, resolveProjectRoot,
  readJsonl, appendJsonl, tokenize,
  readEntityIndex, writeEntityIndex, addToEntityIndex,
  appendBreadcrumb, readExplorationLog, clearExplorationLog, getUnsavedBreadcrumbs, EXPLORATION_LOG_FILE,
  buildBM25Index, bm25Score,
  findSimilarEntry,
};
