#!/usr/bin/env node
"use strict";

/**
 * Code graph store — SQLite-backed with FTS5 for fast code structure queries.
 *
 * Tables:
 *   nodes  — code entities (files, classes, functions, types, tests)
 *   edges  — relationships (CALLS, IMPORTS, INHERITS, CONTAINS, TESTED_BY)
 *   nodes_fts — FTS5 virtual table for fast identifier search
 *
 * Usage:
 *   const cg = require('./code-graph');
 *   const db = cg.open(projectRoot);       // opens/creates .ai-memory/code-graph.db
 *   cg.upsertNode(db, { kind, name, ... });
 *   cg.insertEdge(db, { kind, source, target, ... });
 *   const results = cg.searchNodes(db, 'TestOrchestrator');
 *   cg.close(db);
 */

const path = require("path");
const fs = require("fs");

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  // Graceful degradation if better-sqlite3 not installed
  Database = null;
}

const DB_FILE = "code-graph.db";

// ── Schema ──

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT UNIQUE NOT NULL,
  file_path TEXT,
  line_start INTEGER,
  line_end INTEGER,
  language TEXT,
  signature TEXT,
  parent_name TEXT,
  file_hash TEXT,
  updated_at REAL
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  source_qualified TEXT NOT NULL,
  target_qualified TEXT NOT NULL,
  file_path TEXT,
  line INTEGER
);

CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_name);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_qualified);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_qualified);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_file ON edges(file_path);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, qualified_name, file_path, signature,
  content=nodes,
  content_rowid=id,
  tokenize='unicode61'
);
`;

const FTS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, qualified_name, file_path, signature)
  VALUES (new.id, new.name, new.qualified_name, new.file_path, new.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, file_path, signature)
  VALUES ('delete', old.id, old.name, old.qualified_name, old.file_path, old.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, file_path, signature)
  VALUES ('delete', old.id, old.name, old.qualified_name, old.file_path, old.signature);
  INSERT INTO nodes_fts(rowid, name, qualified_name, file_path, signature)
  VALUES (new.id, new.name, new.qualified_name, new.file_path, new.signature);
END;
`;

// ── Database Management ──

function open(projectRoot) {
  if (!Database) throw new Error("better-sqlite3 not installed");
  const memDir = path.join(projectRoot, ".ai-memory");
  if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });

  const dbPath = path.join(memDir, DB_FILE);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create schema
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);
  db.exec(FTS_TRIGGERS_SQL);

  return db;
}

function close(db) {
  if (db && db.open) db.close();
}

// ── Node Operations ──

const UPSERT_NODE_SQL = `
  INSERT INTO nodes (kind, name, qualified_name, file_path, line_start, line_end, language, signature, parent_name, file_hash, updated_at)
  VALUES (@kind, @name, @qualified_name, @file_path, @line_start, @line_end, @language, @signature, @parent_name, @file_hash, @updated_at)
  ON CONFLICT(qualified_name) DO UPDATE SET
    kind=@kind, name=@name, file_path=@file_path, line_start=@line_start, line_end=@line_end,
    language=@language, signature=@signature, parent_name=@parent_name,
    file_hash=@file_hash, updated_at=@updated_at
`;

function upsertNode(db, node) {
  const stmt = db.prepare(UPSERT_NODE_SQL);
  return stmt.run({
    kind: node.kind || "Unknown",
    name: node.name || "",
    qualified_name: node.qualified_name || node.name || "",
    file_path: node.file_path || null,
    line_start: node.line_start || null,
    line_end: node.line_end || null,
    language: node.language || null,
    signature: node.signature || null,
    parent_name: node.parent_name || null,
    file_hash: node.file_hash || null,
    updated_at: Date.now(),
  });
}

function upsertNodes(db, nodes) {
  const stmt = db.prepare(UPSERT_NODE_SQL);
  const tx = db.transaction((items) => {
    for (const node of items) {
      stmt.run({
        kind: node.kind || "Unknown",
        name: node.name || "",
        qualified_name: node.qualified_name || node.name || "",
        file_path: node.file_path || null,
        line_start: node.line_start || null,
        line_end: node.line_end || null,
        language: node.language || null,
        signature: node.signature || null,
        parent_name: node.parent_name || null,
        file_hash: node.file_hash || null,
        updated_at: Date.now(),
      });
    }
  });
  tx(nodes);
}

function getNode(db, qualifiedName) {
  return db.prepare("SELECT * FROM nodes WHERE qualified_name = ?").get(qualifiedName);
}

function getNodesByFile(db, filePath) {
  return db.prepare("SELECT * FROM nodes WHERE file_path = ?").all(filePath);
}

function getNodesByKind(db, kind) {
  return db.prepare("SELECT * FROM nodes WHERE kind = ?").all(kind);
}

function deleteNodesByFile(db, filePath) {
  db.prepare("DELETE FROM nodes WHERE file_path = ?").run(filePath);
}

function getFileHash(db, filePath) {
  const row = db.prepare("SELECT file_hash FROM nodes WHERE file_path = ? AND kind = 'File' LIMIT 1").get(filePath);
  return row ? row.file_hash : null;
}

// ── Edge Operations ──

const INSERT_EDGE_SQL = `
  INSERT INTO edges (kind, source_qualified, target_qualified, file_path, line)
  VALUES (@kind, @source_qualified, @target_qualified, @file_path, @line)
`;

function insertEdge(db, edge) {
  return db.prepare(INSERT_EDGE_SQL).run({
    kind: edge.kind || "UNKNOWN",
    source_qualified: edge.source_qualified || "",
    target_qualified: edge.target_qualified || "",
    file_path: edge.file_path || null,
    line: edge.line || null,
  });
}

function insertEdges(db, edges) {
  const stmt = db.prepare(INSERT_EDGE_SQL);
  const tx = db.transaction((items) => {
    for (const edge of items) {
      stmt.run({
        kind: edge.kind || "UNKNOWN",
        source_qualified: edge.source_qualified || "",
        target_qualified: edge.target_qualified || "",
        file_path: edge.file_path || null,
        line: edge.line || null,
      });
    }
  });
  tx(edges);
}

function deleteEdgesByFile(db, filePath) {
  db.prepare("DELETE FROM edges WHERE file_path = ?").run(filePath);
}

function getCallers(db, qualifiedName) {
  return db.prepare(
    "SELECT e.*, n.kind as source_kind, n.signature as source_sig FROM edges e LEFT JOIN nodes n ON n.qualified_name = e.source_qualified WHERE e.target_qualified = ? AND e.kind = 'CALLS'"
  ).all(qualifiedName);
}

function getCallees(db, qualifiedName) {
  return db.prepare(
    "SELECT e.*, n.kind as target_kind, n.signature as target_sig FROM edges e LEFT JOIN nodes n ON n.qualified_name = e.target_qualified WHERE e.source_qualified = ? AND e.kind = 'CALLS'"
  ).all(qualifiedName);
}

function getInheritors(db, qualifiedName) {
  return db.prepare(
    "SELECT e.*, n.name, n.file_path FROM edges e LEFT JOIN nodes n ON n.qualified_name = e.source_qualified WHERE e.target_qualified = ? AND e.kind = 'INHERITS'"
  ).all(qualifiedName);
}

function getTests(db, qualifiedName) {
  return db.prepare(
    "SELECT e.*, n.name, n.file_path, n.signature FROM edges e LEFT JOIN nodes n ON n.qualified_name = e.source_qualified WHERE e.target_qualified = ? AND e.kind = 'TESTED_BY'"
  ).all(qualifiedName);
}

function getContains(db, qualifiedName) {
  return db.prepare(
    "SELECT * FROM nodes WHERE parent_name = ? ORDER BY line_start"
  ).all(qualifiedName);
}

function getImports(db, filePath) {
  return db.prepare(
    "SELECT * FROM edges WHERE file_path = ? AND kind = 'IMPORTS'"
  ).all(filePath);
}

// ── FTS5 Search ──

function searchNodes(db, query, limit = 20) {
  if (!query || !query.trim()) return [];
  // Escape FTS5 special chars and make prefix search
  const terms = query.trim().split(/\s+/).map(t => `"${t.replace(/"/g, '""')}"*`).join(" ");
  try {
    return db.prepare(`
      SELECT n.*, nodes_fts.rank
      FROM nodes_fts
      JOIN nodes n ON n.id = nodes_fts.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY nodes_fts.rank
      LIMIT ?
    `).all(terms, limit);
  } catch {
    // Fallback to LIKE search if FTS fails
    const pattern = `%${query}%`;
    return db.prepare(
      "SELECT * FROM nodes WHERE name LIKE ? OR qualified_name LIKE ? LIMIT ?"
    ).all(pattern, pattern, limit);
  }
}

// ── Impact Analysis ──

function getImpactRadius(db, qualifiedName, depth = 2) {
  const visited = new Set();
  const impacted = [];
  let frontier = [qualifiedName];

  for (let hop = 1; hop <= depth; hop++) {
    const next = [];
    for (const qn of frontier) {
      if (visited.has(qn)) continue;
      visited.add(qn);

      // Find callers (reverse edges)
      const callers = db.prepare(
        "SELECT source_qualified FROM edges WHERE target_qualified = ? AND kind = 'CALLS'"
      ).all(qn);

      // Find importers (files that import this module)
      const importers = db.prepare(
        "SELECT source_qualified FROM edges WHERE target_qualified = ? AND kind = 'IMPORTS'"
      ).all(qn);

      // Find inheritors
      const inheritors = db.prepare(
        "SELECT source_qualified FROM edges WHERE target_qualified = ? AND kind = 'INHERITS'"
      ).all(qn);

      for (const row of [...callers, ...importers, ...inheritors]) {
        if (!visited.has(row.source_qualified)) {
          const node = getNode(db, row.source_qualified);
          impacted.push({
            qualified_name: row.source_qualified,
            hop,
            kind: node ? node.kind : "Unknown",
            file_path: node ? node.file_path : null,
            name: node ? node.name : row.source_qualified,
          });
          next.push(row.source_qualified);
        }
      }
    }
    frontier = next;
  }

  // Also find tests
  const tests = getTests(db, qualifiedName);
  for (const t of tests) {
    if (!visited.has(t.source_qualified)) {
      impacted.push({
        qualified_name: t.source_qualified,
        hop: 0,
        kind: "Test",
        file_path: t.file_path,
        name: t.name || t.source_qualified,
      });
    }
  }

  return impacted;
}

// ── Structure Queries ──

function getFileStructure(db, filePath) {
  return db.prepare(
    "SELECT kind, name, qualified_name, line_start, line_end, signature, parent_name FROM nodes WHERE file_path = ? ORDER BY line_start"
  ).all(filePath);
}

function getModuleHierarchy(db, rootDir) {
  const pattern = rootDir ? `${rootDir.replace(/\\/g, "/")}%` : "%";
  const files = db.prepare(
    "SELECT DISTINCT file_path FROM nodes WHERE file_path LIKE ? ORDER BY file_path"
  ).all(pattern);

  const classes = db.prepare(
    "SELECT kind, name, qualified_name, file_path, parent_name FROM nodes WHERE kind IN ('Class', 'Interface') AND file_path LIKE ? ORDER BY file_path, name"
  ).all(pattern);

  return { files: files.map(f => f.file_path), classes };
}

function getClassHierarchy(db, className) {
  const node = getNode(db, className) || db.prepare("SELECT * FROM nodes WHERE name = ? AND kind IN ('Class', 'Interface') LIMIT 1").get(className);
  if (!node) return null;

  const parents = db.prepare(
    "SELECT target_qualified FROM edges WHERE source_qualified = ? AND kind = 'INHERITS'"
  ).all(node.qualified_name);

  const children = db.prepare(
    "SELECT source_qualified FROM edges WHERE target_qualified = ? AND kind = 'INHERITS'"
  ).all(node.qualified_name);

  const members = getContains(db, node.qualified_name);

  return {
    node,
    parents: parents.map(p => p.target_qualified),
    children: children.map(c => c.source_qualified),
    members: members.map(m => ({ kind: m.kind, name: m.name, signature: m.signature, line_start: m.line_start })),
  };
}

// ── Stats ──

function getStats(db) {
  const nodeCount = db.prepare("SELECT COUNT(*) as count FROM nodes").get().count;
  const edgeCount = db.prepare("SELECT COUNT(*) as count FROM edges").get().count;
  const fileCount = db.prepare("SELECT COUNT(DISTINCT file_path) as count FROM nodes").get().count;
  const kindCounts = db.prepare("SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind").all();
  const edgeKindCounts = db.prepare("SELECT kind, COUNT(*) as count FROM edges GROUP BY kind").all();

  return {
    nodes: nodeCount,
    edges: edgeCount,
    files: fileCount,
    nodesByKind: Object.fromEntries(kindCounts.map(r => [r.kind, r.count])),
    edgesByKind: Object.fromEntries(edgeKindCounts.map(r => [r.kind, r.count])),
  };
}

// ── File replacement (for incremental updates) ──

function replaceFile(db, filePath, nodes, edges) {
  const tx = db.transaction(() => {
    deleteNodesByFile(db, filePath);
    deleteEdgesByFile(db, filePath);
    if (nodes.length > 0) upsertNodes(db, nodes);
    if (edges.length > 0) insertEdges(db, edges);
  });
  tx();
}

module.exports = {
  open, close,
  upsertNode, upsertNodes, getNode, getNodesByFile, getNodesByKind,
  deleteNodesByFile, getFileHash,
  insertEdge, insertEdges, deleteEdgesByFile,
  getCallers, getCallees, getInheritors, getTests, getContains, getImports,
  searchNodes,
  getImpactRadius,
  getFileStructure, getModuleHierarchy, getClassHierarchy,
  getStats, replaceFile,
  DB_FILE,
};
