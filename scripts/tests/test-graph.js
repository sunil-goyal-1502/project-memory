#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const graph = require(path.join(__dirname, "..", "graph.js"));
const shared = require(path.join(__dirname, "..", "shared.js"));

function test_add_and_read_triples(testRoot) {
  graph.addTriple(testRoot, "DomService", "uses", "XPathDocument", "f1");
  graph.addTriple(testRoot, "DomService", "calls", "ExecuteVerificationQueries", "f1");
  const triples = graph.readGraph(testRoot);
  assert.strictEqual(triples.length, 2);
  assert.strictEqual(triples[0].s, "domservice");
  assert.strictEqual(triples[0].p, "uses");
  assert.strictEqual(triples[0].o, "xpathdocument");
}

function test_add_triples_batch(testRoot) {
  graph.addTriples(testRoot, [
    { subject: "A", predicate: "uses", object: "B" },
    { subject: "B", predicate: "calls", object: "C" },
  ], "f1");
  assert.strictEqual(graph.readGraph(testRoot).length, 2);
}

function test_adjacency_index(testRoot) {
  graph.addTriple(testRoot, "A", "uses", "B", "f1");
  graph.addTriple(testRoot, "A", "calls", "C", "f2");
  graph.addTriple(testRoot, "B", "returns", "D", "f3");

  const adj = graph.buildAdjacencyIndex(graph.readGraph(testRoot));
  assert.ok(adj["a"], "A should be in index");
  assert.strictEqual(adj["a"].length, 2); // uses B, calls C
  assert.ok(adj["b"], "B should be in index");
  // B has: incoming 'uses' from A + outgoing 'returns' to D
  const bEdges = adj["b"];
  assert.ok(bEdges.some(e => e.direction === "in" && e.target === "a"));
  assert.ok(bEdges.some(e => e.direction === "out" && e.target === "d"));
}

function test_expand_1_hop(testRoot) {
  graph.addTriple(testRoot, "DomService", "uses", "XPathDocument", "f1");
  graph.addTriple(testRoot, "DomService", "calls", "FetchDomXml", "f2");
  graph.addTriple(testRoot, "FlaUI", "related_to", "DomService", "f3");

  const result = graph.expandFromEntities(testRoot, ["DomService"], 1);
  assert.ok(result.entities.has("domservice"));
  assert.ok(result.entities.has("xpathdocument"), "Should find XPathDocument at 1 hop");
  assert.ok(result.entities.has("fetchdomxml"), "Should find FetchDomXml at 1 hop");
  assert.ok(result.entities.has("flaui"), "Should find FlaUI at 1 hop (reverse edge)");
  assert.ok(result.relatedFindingIds.size > 0, "Should collect finding IDs");
}

function test_expand_2_hop(testRoot) {
  graph.addTriple(testRoot, "A", "uses", "B", "f1");
  graph.addTriple(testRoot, "B", "uses", "C", "f2");
  graph.addTriple(testRoot, "C", "uses", "D", "f3");

  // 1 hop from A: finds B
  const r1 = graph.expandFromEntities(testRoot, ["A"], 1);
  assert.ok(r1.entities.has("b"));
  assert.ok(!r1.entities.has("c"), "C should NOT be at 1 hop");

  // 2 hops from A: finds B and C
  const r2 = graph.expandFromEntities(testRoot, ["A"], 2);
  assert.ok(r2.entities.has("b"));
  assert.ok(r2.entities.has("c"), "C should be at 2 hops");
  assert.ok(!r2.entities.has("d"), "D should NOT be at 2 hops");
}

function test_extract_entities_from_text(testRoot) {
  const text = "DomService.cs uses XPathDocument. The FindAllDescendants() method returns AutomationElement objects.";
  const entities = graph.extractEntitiesFromText(text);
  assert.ok(entities.includes("domservice"), "Should extract PascalCase class");
  assert.ok(entities.includes("domservice.cs"), "Should extract file name");
  assert.ok(entities.includes("xpathdocument"), "Should extract PascalCase class");
  assert.ok(entities.includes("findalldescendants"), "Should extract method call");
  assert.ok(entities.includes("automationelement"), "Should extract PascalCase class");
}

function test_extract_relationships(testRoot) {
  const text = "DomService uses XPathDocument for evaluation";
  const entities = ["domservice", "xpathdocument"];
  const rels = graph.extractRelationships(text, entities);
  assert.ok(rels.length > 0, "Should find relationship");
  assert.strictEqual(rels[0].subject, "domservice");
  assert.strictEqual(rels[0].predicate, "uses");
  assert.strictEqual(rels[0].object, "xpathdocument");
}

function test_co_occurrence(testRoot) {
  const entry = {
    id: "test1",
    topic: "Test finding",
    finding: "FlaUI and DomService work together",
    entities: ["flaui", "domservice"],
  };
  const triples = graph.extractTriplesFromEntry(entry, entry.entities);

  // Should have mentions + co-occurrence
  const mentions = triples.filter(t => t.predicate === "mentions");
  assert.ok(mentions.length >= 2, "Should have mention triples for both entities");

  const coOccur = triples.filter(t => t.predicate === "related_to");
  assert.ok(coOccur.length > 0, "Should have co-occurrence triple");
}

function test_extract_triples_from_entry(testRoot) {
  const entry = {
    id: "abc123",
    topic: "DomService uses XPathDocument for XPath evaluation",
    finding: "DomService.ExecuteVerificationQueries uses XPathDocument at line 217. It depends on System.Xml.",
    entities: ["domservice", "xpathdocument"],
  };
  const triples = graph.extractTriplesFromEntry(entry, entry.entities);

  // Should have mentions
  const mentions = triples.filter(t => t.predicate === "mentions");
  assert.ok(mentions.length >= 2);

  // Should have 'uses' relationship
  const uses = triples.filter(t => t.predicate === "uses");
  assert.ok(uses.length > 0, "Should extract 'uses' relationship");
}

function test_backfill_graph(testRoot) {
  // Add research entries
  shared.appendJsonl(path.join(testRoot, ".ai-memory", "research.jsonl"), {
    id: "r1", topic: "DomService uses XPathDocument", finding: "DomService uses XPathDocument for XPath", entities: ["domservice", "xpathdocument"],
  });
  shared.appendJsonl(path.join(testRoot, ".ai-memory", "research.jsonl"), {
    id: "r2", topic: "FlaUI exposes FindAll", finding: "FlaUI exposes FindAllDescendants method", entities: ["flaui", "findalldescendants"],
  });

  const added = graph.backfillGraph(testRoot);
  assert.ok(added > 0, "Should add triples for existing entries");

  // Second call should add 0 (idempotent)
  const added2 = graph.backfillGraph(testRoot);
  assert.strictEqual(added2, 0, "Backfill should be idempotent");
}

function test_empty_graph(testRoot) {
  const result = graph.expandFromEntities(testRoot, ["anything"], 2);
  assert.strictEqual(result.connections.length, 0);
  assert.strictEqual(result.relatedFindingIds.size, 0);
}

module.exports = {
  test_add_and_read_triples, test_add_triples_batch, test_adjacency_index,
  test_expand_1_hop, test_expand_2_hop,
  test_extract_entities_from_text, test_extract_relationships,
  test_co_occurrence, test_extract_triples_from_entry,
  test_backfill_graph, test_empty_graph,
};
