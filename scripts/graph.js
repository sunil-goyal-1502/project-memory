#!/usr/bin/env node
"use strict";

/**
 * Knowledge graph memory service.
 * Stores entity relationships as subject-predicate-object triples in JSONL.
 * Builds in-memory adjacency index for fast multi-hop traversal.
 * Zero external dependencies — pure Node.js.
 */

const fs = require("fs");
const path = require("path");
const { readJsonl, appendJsonl } = require(path.join(__dirname, "shared.js"));

const GRAPH_FILE = "graph.jsonl";

// ── Relationship verb patterns for extraction ──
const RELATION_PATTERNS = [
  { re: /\buses\b/i, p: "uses" },
  { re: /\bdepends\s+on\b/i, p: "depends_on" },
  { re: /\bcalls?\b/i, p: "calls" },
  { re: /\bimplements?\b/i, p: "implements" },
  { re: /\bextends?\b/i, p: "extends" },
  { re: /\breturns?\b/i, p: "returns" },
  { re: /\bfix(?:es|ed)?\b/i, p: "fixes" },
  { re: /\brequires?\b/i, p: "requires" },
  { re: /\bproduces?\b/i, p: "produces" },
  { re: /\bcontains?\b/i, p: "contains" },
  { re: /\bconsumes?\b/i, p: "consumes" },
  { re: /\bconverts?\b/i, p: "converts" },
  { re: /\bserializ(?:es|ed)?\b/i, p: "serializes" },
  { re: /\bpipes?\s+to\b/i, p: "pipes_to" },
];

// ── Entity extraction patterns ──
const PASCAL_CASE = /\b([A-Z][a-zA-Z]*[a-z][a-zA-Z]*[A-Z][a-zA-Z]*)\b/g; // PascalCase with multiple capitals
const UPPER_CAMEL = /\b([A-Z][a-z]{2,}(?:[A-Z][a-z]+)+)\b/g; // Standard PascalCase: DomService, TestRunner
const FILE_EXT = /\b([\w.-]+\.(?:cs|js|ts|tsx|py|json|xml|jsonl|sh|ps1|md|yaml|yml|toml|csproj|sln|bat))\b/g;
const METHOD_CALL = /\b([a-z][a-zA-Z]+)\s*\(/g; // camelCase( = method call
const METHOD_ASYNC = /\b([A-Z][a-zA-Z]+Async)\b/g; // GetPageSourceAsync, FetchDomXmlAsync
const URL_API = /https?:\/\/[^\s"']+/g; // URLs
const NAMESPACE = /\b([A-Z][a-z]+(?:\.[A-Z][a-z]+)+)\b/g; // System.Xml, FlaUI.Core
const CLI_TOOL = /\b(az|curl|git|node|npm|npx|dotnet|docker|python3?|pip|powershell|bash)\b/g;
const ENV_VAR = /\b([A-Z][A-Z_]{2,})\b/g; // USERPROFILE, BUILD_ID
const CONFIG_KEY = /\b([\w]+(?:\.[\w]+){2,})\b/g; // hooks.cacheHitThreshold style paths

// ── Triple CRUD ──

function graphPath(projectRoot) {
  return path.join(projectRoot, ".ai-memory", GRAPH_FILE);
}

function addTriple(projectRoot, subject, predicate, object, sourceId) {
  const triple = {
    s: subject.toLowerCase(),
    p: predicate,
    o: object.toLowerCase(),
    src: sourceId,
    ts: new Date().toISOString(),
  };
  appendJsonl(graphPath(projectRoot), triple);
  return triple;
}

function addTriples(projectRoot, triples, sourceId) {
  const gp = graphPath(projectRoot);
  for (const t of triples) {
    appendJsonl(gp, {
      s: (t.subject || t.s || "").toLowerCase(),
      p: t.predicate || t.p,
      o: (t.object || t.o || "").toLowerCase(),
      src: sourceId,
      ts: new Date().toISOString(),
    });
  }
}

function readGraph(projectRoot) {
  return readJsonl(graphPath(projectRoot));
}

// ── Adjacency Index ──

/**
 * Build bidirectional adjacency index from triples.
 * Returns: { "entity": [{ predicate, target, src, direction }] }
 * direction: "out" (entity is subject) or "in" (entity is object)
 */
function buildAdjacencyIndex(triples) {
  const index = Object.create(null);

  for (const t of triples) {
    const s = t.s || "";
    const o = t.o || "";
    const p = t.p || "related_to";
    const src = t.src || "";

    if (!index[s]) index[s] = [];
    index[s].push({ predicate: p, target: o, src, direction: "out" });

    if (!index[o]) index[o] = [];
    index[o].push({ predicate: p, target: s, src, direction: "in" });
  }

  return index;
}

/**
 * Expand from a set of seed entities, traversing the graph N hops.
 * Returns: {
 *   entities: Set of all discovered entity names,
 *   connections: [{ from, predicate, to, src, hop }],
 *   relatedFindingIds: Set of source finding IDs from graph edges
 * }
 */
function expandFromEntities(projectRoot, seedEntities, depth = 2) {
  const triples = readGraph(projectRoot);
  if (triples.length === 0) {
    return { entities: new Set(seedEntities), connections: [], relatedFindingIds: new Set() };
  }

  const adj = buildAdjacencyIndex(triples);
  const visited = new Set();
  const connections = [];
  const relatedFindingIds = new Set();
  let frontier = seedEntities.map(e => e.toLowerCase());

  for (let hop = 1; hop <= depth; hop++) {
    const nextFrontier = [];
    for (const entity of frontier) {
      if (visited.has(entity)) continue;
      visited.add(entity);

      const edges = adj[entity] || [];
      for (const edge of edges) {
        if (!visited.has(edge.target)) {
          connections.push({
            from: entity,
            predicate: edge.predicate,
            to: edge.target,
            src: edge.src,
            hop,
          });
          relatedFindingIds.add(edge.src);
          nextFrontier.push(edge.target);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Collect ALL discovered entities (seeds + visited + frontier targets)
  const allEntities = new Set(visited);
  for (const e of seedEntities) allEntities.add(e.toLowerCase());
  for (const c of connections) {
    allEntities.add(c.from);
    allEntities.add(c.to);
  }

  return { entities: allEntities, connections, relatedFindingIds };
}

// ── Entity Extraction ──

/**
 * Extract entity names from text using regex patterns.
 * Returns: string[] of lowercase entity names.
 */
// Common words to exclude from entity extraction
const STOP_ENTITIES = new Set([
  "the", "this", "that", "with", "from", "into", "have", "been", "were", "will",
  "should", "could", "would", "does", "each", "when", "then", "than", "more",
  "also", "just", "only", "both", "after", "before", "between", "about", "which",
  "where", "while", "using", "true", "false", "null", "undefined", "error", "string",
  "number", "object", "array", "function", "const", "return", "async", "await",
  "import", "export", "require", "module", "class", "interface", "type", "enum",
  "void", "boolean", "default", "value", "result", "data", "item", "entry",
  "status", "message", "content", "name", "path", "file", "line", "found",
  "used", "like", "make", "take", "give", "need", "want", "know", "think",
]);

function extractEntitiesFromText(text) {
  if (!text) return [];
  const entities = new Set();

  let match;

  // PascalCase with mixed case (XPathDocument, FlaUIToolHandler)
  PASCAL_CASE.lastIndex = 0;
  while ((match = PASCAL_CASE.exec(text)) !== null) {
    const e = match[1].toLowerCase();
    if (e.length > 3 && !STOP_ENTITIES.has(e)) entities.add(e);
  }

  // Standard PascalCase (DomService, TestRunner)
  UPPER_CAMEL.lastIndex = 0;
  while ((match = UPPER_CAMEL.exec(text)) !== null) {
    const e = match[1].toLowerCase();
    if (e.length > 3 && !STOP_ENTITIES.has(e)) entities.add(e);
  }

  // File names with extensions
  FILE_EXT.lastIndex = 0;
  while ((match = FILE_EXT.exec(text)) !== null) {
    entities.add(match[1].toLowerCase());
  }

  // Method calls: camelCase(
  METHOD_CALL.lastIndex = 0;
  while ((match = METHOD_CALL.exec(text)) !== null) {
    const e = match[1].toLowerCase();
    if (e.length > 3 && !STOP_ENTITIES.has(e)) entities.add(e);
  }

  // Async methods: GetPageSourceAsync, FetchDomXmlAsync
  METHOD_ASYNC.lastIndex = 0;
  while ((match = METHOD_ASYNC.exec(text)) !== null) {
    entities.add(match[1].toLowerCase());
  }

  // Namespaces: System.Xml, FlaUI.Core
  NAMESPACE.lastIndex = 0;
  while ((match = NAMESPACE.exec(text)) !== null) {
    entities.add(match[1].toLowerCase());
  }

  // CLI tools
  CLI_TOOL.lastIndex = 0;
  while ((match = CLI_TOOL.exec(text)) !== null) {
    entities.add(match[1].toLowerCase());
  }

  // URLs → extract domain + API path segments
  URL_API.lastIndex = 0;
  while ((match = URL_API.exec(text)) !== null) {
    try {
      const url = new URL(match[0]);
      // Add domain as entity
      if (url.hostname !== "localhost") entities.add(url.hostname.toLowerCase());
      // Add meaningful path segments
      const pathParts = url.pathname.split("/").filter(p => p.length > 2 && !p.match(/^\d+$/) && p !== "_apis");
      for (const part of pathParts.slice(-3)) {
        if (!STOP_ENTITIES.has(part.toLowerCase())) entities.add(part.toLowerCase());
      }
    } catch { /* invalid URL */ }
  }

  return Array.from(entities);
}

/**
 * Extract relationship triples from finding text + known entities.
 * Uses verb patterns to find subject-predicate-object relationships.
 */
function extractRelationships(findingText, entities) {
  if (!findingText || entities.length < 2) return [];
  const triples = [];
  const textLower = findingText.toLowerCase();

  // For each pair of entities, check if a relationship verb appears between them
  for (let i = 0; i < entities.length; i++) {
    for (let j = 0; j < entities.length; j++) {
      if (i === j) continue;
      const eLower = entities[i].toLowerCase();
      const fLower = entities[j].toLowerCase();

      // Check if both entities appear in the text
      if (!textLower.includes(eLower) || !textLower.includes(fLower)) continue;

      // Find the text between them
      const eIdx = textLower.indexOf(eLower);
      const fIdx = textLower.indexOf(fLower);
      if (eIdx >= fIdx) continue; // only subject→object order

      const between = textLower.substring(eIdx + eLower.length, fIdx).trim();

      // Check for relationship verbs in the between text
      for (const { re, p } of RELATION_PATTERNS) {
        if (re.test(between)) {
          triples.push({ subject: eLower, predicate: p, object: fLower });
          break; // one relationship per pair per finding
        }
      }
    }
  }

  return triples;
}

/**
 * Extract all triples from a research entry.
 * Combines: explicit entities, text-extracted entities, relationships, co-occurrence.
 */
function extractTriplesFromEntry(entry, explicitEntities = []) {
  const triples = [];
  const findingText = [entry.topic || "", entry.finding || entry.decision || ""].join(" ");

  // Combine explicit entities with text-extracted ones
  const textEntities = extractEntitiesFromText(findingText);
  const allEntities = [...new Set([
    ...explicitEntities.map(e => e.toLowerCase()),
    ...textEntities,
  ])];

  if (allEntities.length === 0) return triples;

  // 1. Finding → mentions → entity (provenance link)
  for (const entity of allEntities) {
    triples.push({ subject: entry.id, predicate: "mentions", object: entity });
  }

  // 2. Relationship verb extraction
  const rels = extractRelationships(findingText, allEntities);
  triples.push(...rels);

  // 3. Co-occurrence: entity pairs in the SAME SENTENCE get related_to (not entire finding)
  // This reduces noise from unrelated entities that happen to be in the same entry
  const sentences = findingText.split(/[.!?\n]+/).filter(s => s.trim().length > 5);
  for (const sentence of sentences) {
    const sentLower = sentence.toLowerCase();
    const sentEntities = allEntities.filter(e => sentLower.includes(e));
    for (let i = 0; i < sentEntities.length; i++) {
      for (let j = i + 1; j < sentEntities.length; j++) {
        const hasStronger = rels.some(r =>
          (r.subject === sentEntities[i] && r.object === sentEntities[j]) ||
          (r.subject === sentEntities[j] && r.object === sentEntities[i])
        );
        if (!hasStronger) {
          triples.push({ subject: sentEntities[i], predicate: "related_to", object: sentEntities[j] });
        }
      }
    }
  }

  return triples;
}

/**
 * Backfill graph triples for all existing entries that don't have them.
 * Idempotent: checks which finding IDs already have triples.
 */
function backfillGraph(projectRoot) {
  const shared = require(path.join(__dirname, "shared.js"));
  const research = shared.readJsonl(path.join(projectRoot, ".ai-memory", "research.jsonl"));
  const decisions = shared.readJsonl(path.join(projectRoot, ".ai-memory", "decisions.jsonl"));
  const allEntries = [...research, ...decisions];

  if (allEntries.length === 0) return 0;

  // Find which entries already have triples
  const existingTriples = readGraph(projectRoot);
  const coveredIds = new Set(existingTriples.map(t => t.src));

  let added = 0;
  for (const entry of allEntries) {
    if (coveredIds.has(entry.id)) continue;

    const entities = entry.entities || [];
    const triples = extractTriplesFromEntry(entry, entities);
    if (triples.length > 0) {
      addTriples(projectRoot, triples, entry.id);
      added += triples.length;
    }
  }

  return added;
}

// ── Temporal Queries ──

/**
 * Get the timeline of an entity — all findings that mention it, ordered by time.
 * Returns: [{ ts, findingId, topic, finding, predicate }]
 */
function getEntityTimeline(projectRoot, entity) {
  const shared = require(path.join(__dirname, "shared.js"));
  const triples = readGraph(projectRoot);
  const entityLower = entity.toLowerCase();

  // Find all triples involving this entity
  const relevantSrcs = new Set();
  const predicateMap = {}; // findingId → [predicates]
  for (const t of triples) {
    if (t.s === entityLower || t.o === entityLower) {
      relevantSrcs.add(t.src);
      if (!predicateMap[t.src]) predicateMap[t.src] = [];
      predicateMap[t.src].push(t.p);
    }
  }

  // Fetch the actual findings
  const research = shared.readJsonl(path.join(projectRoot, ".ai-memory", "research.jsonl"));
  const decisions = shared.readJsonl(path.join(projectRoot, ".ai-memory", "decisions.jsonl"));
  const allEntries = [...research, ...decisions];

  const timeline = [];
  for (const entry of allEntries) {
    if (relevantSrcs.has(entry.id)) {
      timeline.push({
        ts: entry.ts,
        findingId: entry.id,
        topic: entry.topic || entry.decision || "",
        finding: entry.finding || entry.rationale || "",
        predicates: predicateMap[entry.id] || [],
      });
    }
  }

  return timeline.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
}

/**
 * Get findings changed since a given timestamp.
 * Useful for "what's new since last session?" queries.
 */
function getChangesSince(projectRoot, sinceIso) {
  const shared = require(path.join(__dirname, "shared.js"));
  const research = shared.readJsonl(path.join(projectRoot, ".ai-memory", "research.jsonl"));
  const decisions = shared.readJsonl(path.join(projectRoot, ".ai-memory", "decisions.jsonl"));

  const newResearch = research.filter(r => (r.ts || "") > sinceIso);
  const newDecisions = decisions.filter(d => (d.ts || "") > sinceIso);
  const newTriples = readGraph(projectRoot).filter(t => (t.ts || "") > sinceIso);

  return { research: newResearch, decisions: newDecisions, triples: newTriples };
}

// ── Cross-Project Graph ──

/**
 * Build a merged graph across all projects.
 * Tags each triple with its source project.
 * Returns: { triples, adjacencyIndex, projectStats }
 */
function buildGlobalGraph(projects) {
  const allTriples = [];
  const projectStats = [];

  for (const p of projects) {
    const projName = path.basename(p);
    const triples = readGraph(p);
    for (const t of triples) {
      t._project = projName;
    }
    allTriples.push(...triples);
    projectStats.push({ name: projName, path: p, triples: triples.length });
  }

  const adjacencyIndex = buildAdjacencyIndex(allTriples);
  const entityCount = Object.keys(adjacencyIndex).length;

  return { triples: allTriples, adjacencyIndex, entityCount, projectStats };
}

/**
 * Expand entities across all projects (global graph traversal).
 */
function expandFromEntitiesGlobal(projects, seedEntities, depth = 2) {
  const allTriples = [];
  for (const p of projects) {
    allTriples.push(...readGraph(p));
  }

  if (allTriples.length === 0) {
    return { entities: new Set(seedEntities), connections: [], relatedFindingIds: new Set() };
  }

  const adj = buildAdjacencyIndex(allTriples);
  const visited = new Set();
  const connections = [];
  const relatedFindingIds = new Set();
  let frontier = seedEntities.map(e => e.toLowerCase());

  for (let hop = 1; hop <= depth; hop++) {
    const nextFrontier = [];
    for (const entity of frontier) {
      if (visited.has(entity)) continue;
      visited.add(entity);
      const edges = adj[entity] || [];
      for (const edge of edges) {
        if (!visited.has(edge.target)) {
          connections.push({ from: entity, predicate: edge.predicate, to: edge.target, src: edge.src, hop });
          relatedFindingIds.add(edge.src);
          nextFrontier.push(edge.target);
        }
      }
    }
    frontier = nextFrontier;
  }

  const allEntities = new Set(visited);
  for (const e of seedEntities) allEntities.add(e.toLowerCase());
  for (const c of connections) { allEntities.add(c.from); allEntities.add(c.to); }

  return { entities: allEntities, connections, relatedFindingIds };
}

/**
 * Rebuild graph from scratch for a project (delete + backfill).
 * Use when extraction quality improves and old triples are stale.
 */
function rebuildGraph(projectRoot) {
  const gp = graphPath(projectRoot);
  try { fs.unlinkSync(gp); } catch {}
  return backfillGraph(projectRoot);
}

module.exports = {
  addTriple, addTriples, readGraph,
  buildAdjacencyIndex, expandFromEntities,
  extractEntitiesFromText, extractRelationships, extractTriplesFromEntry,
  backfillGraph, rebuildGraph,
  getEntityTimeline, getChangesSince,
  buildGlobalGraph, expandFromEntitiesGlobal,
  GRAPH_FILE,
};
