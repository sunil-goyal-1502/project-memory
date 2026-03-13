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
const PASCAL_CASE = /\b([A-Z][a-zA-Z]*[a-z][a-zA-Z]*[A-Z][a-zA-Z]*)\b/g; // PascalCase/camelCase with multiple capitals
const FILE_EXT = /\b([\w.-]+\.(?:cs|js|ts|py|json|xml|jsonl|sh|ps1|md))\b/g; // file names
const METHOD_CALL = /\b([a-z][a-zA-Z]+)\s*\(/g; // camelCase( = method call
const URL_API = /https?:\/\/[^\s"']+/g; // URLs

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
function extractEntitiesFromText(text) {
  if (!text) return [];
  const entities = new Set();

  // PascalCase classes/types
  let match;
  while ((match = PASCAL_CASE.exec(text)) !== null) {
    entities.add(match[1].toLowerCase());
  }

  // File names with extensions
  while ((match = FILE_EXT.exec(text)) !== null) {
    entities.add(match[1].toLowerCase());
  }

  // Method calls (camelCase followed by paren)
  while ((match = METHOD_CALL.exec(text)) !== null) {
    if (match[1].length > 3) { // skip short words like "if(", "for("
      entities.add(match[1].toLowerCase());
    }
  }

  // URLs → extract API path segments
  while ((match = URL_API.exec(text)) !== null) {
    try {
      const url = new URL(match[0]);
      const pathParts = url.pathname.split("/").filter(p => p.length > 2 && !p.match(/^\d+$/));
      for (const part of pathParts.slice(-2)) { // last 2 meaningful path segments
        entities.add(part.toLowerCase());
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

  // 3. Co-occurrence: all entity pairs get related_to (weak link)
  for (let i = 0; i < allEntities.length; i++) {
    for (let j = i + 1; j < allEntities.length; j++) {
      // Only if no stronger relationship already exists
      const hasStronger = rels.some(r =>
        (r.subject === allEntities[i] && r.object === allEntities[j]) ||
        (r.subject === allEntities[j] && r.object === allEntities[i])
      );
      if (!hasStronger) {
        triples.push({ subject: allEntities[i], predicate: "related_to", object: allEntities[j] });
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

module.exports = {
  addTriple, addTriples, readGraph,
  buildAdjacencyIndex, expandFromEntities,
  extractEntitiesFromText, extractRelationships, extractTriplesFromEntry,
  backfillGraph,
  GRAPH_FILE,
};
