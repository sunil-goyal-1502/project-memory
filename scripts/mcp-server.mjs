#!/usr/bin/env node

/**
 * MCP Server for project-memory — 11 on-demand tools.
 *
 * Transport: stdio (JSON-RPC over stdin/stdout)
 * Registration: .mcp.json { command: "node", args: ["scripts/mcp-server.mjs"] }
 *
 * Tools:
 *   Memory:  get_context, memory_search, script_search, memory_save, session_summary, graph_context
 *   Code:    code_search, code_context, code_impact, code_structure
 *   Skills:  list_skills
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const shared = require(path.join(import.meta.dirname, "shared.js"));

// Lazy-loaded modules
let codeGraphMod = null;
let codeGraphDb = null;

function getCodeGraph(projectRoot) {
  if (!codeGraphMod) {
    codeGraphMod = require(path.join(import.meta.dirname, "code-graph.js"));
  }
  if (codeGraphDb && codeGraphDb.open) return codeGraphDb;
  try {
    codeGraphDb = codeGraphMod.open(projectRoot);
    return codeGraphDb;
  } catch {
    return null;
  }
}

// ── Project Resolution ──

function resolveProject() {
  const root = shared.findProjectRoot(process.cwd()) || shared.scanHomeForProjects();
  return root;
}

let projectRoot = resolveProject();
let mcpSession = shared.createMCPSessionState();

// ── Tool Definitions ──

const TOOLS = [
  {
    name: "get_context",
    description: "Get a compact overview (~100 tokens) of project memory state — stats, recent activity, suggestions. Call this FIRST when starting any task.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "memory_search",
    description: "Search prior research findings and project decisions using BM25 + ONNX embeddings + knowledge graph expansion. Returns matching findings with topics, tags, and full text.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query — keywords, topics, or natural language" },
        limit: { type: "number", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "script_search",
    description: "Find reusable script templates from the script library. Returns complete templates with {{parameter}} placeholders ready to fill in and run.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What kind of script you need — e.g. 'build timeline', 'test results', 'ADO API'" },
        limit: { type: "number", description: "Max results (default 3)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_save",
    description: "Save a research finding or project decision to persistent memory. Use type='research' for API behavior, error causes, workarounds, library quirks. Use type='decision' for architecture choices, conventions, constraints.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["research", "decision"], description: "What to save" },
        topic: { type: "string", description: "For research: 5-15 word noun phrase. For decision: the decision text." },
        tags: { type: "string", description: "Comma-separated keywords" },
        content: { type: "string", description: "For research: the finding. For decision: the rationale." },
        category: { type: "string", description: "For decisions only: architecture, constraint, convention, testing, scope, unresolved" },
        entities: { type: "string", description: "Comma-separated file/class/method names for indexing" },
        staleness: { type: "string", enum: ["stable", "versioned", "volatile"], description: "For research: how likely to change" },
      },
      required: ["type", "topic", "content"],
    },
  },
  {
    name: "session_summary",
    description: "Generate end-of-session summary. Shows saved findings count, pending saves, workflow candidates, and session stats. Call this before ending every session.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "graph_context",
    description: "Explore knowledge graph relationships. Given an entity name, returns connected entities, findings, and relationship paths.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Entity name (file, class, concept)" },
        depth: { type: "number", description: "Hops to traverse (default 2)" },
      },
      required: ["entity"],
    },
  },
  {
    name: "code_search",
    description: "FTS5 search over code identifiers — function names, class names, imports, signatures. Much faster than Grep/Glob for finding code entities. Returns qualified names, file paths, line numbers, signatures.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Code identifier or keyword to search for" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "code_context",
    description: "Get full context for a code entity: callers, callees, class members, inheritance, tests, signature. Eliminates the need to read multiple files to understand a function/class.",
    inputSchema: {
      type: "object",
      properties: {
        qualified_name: { type: "string", description: "Qualified name (e.g. 'Namespace.Class.Method' or 'file.js::functionName')" },
      },
      required: ["qualified_name"],
    },
  },
  {
    name: "code_impact",
    description: "Blast radius analysis: what files, functions, and tests are affected if the given entity changes. Shows direct and transitive callers up to N hops.",
    inputSchema: {
      type: "object",
      properties: {
        qualified_name: { type: "string", description: "Qualified name of the entity to analyze" },
        depth: { type: "number", description: "Hops to trace (default 2)" },
      },
      required: ["qualified_name"],
    },
  },
  {
    name: "code_structure",
    description: "Get module/file hierarchy or class hierarchy overview. Shows files, classes, and their containment relationships for a directory or class.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Directory path for module hierarchy, or class name for class hierarchy" },
        type: { type: "string", enum: ["module", "class"], description: "Type of structure to show (default: module)" },
      },
      required: ["target"],
    },
  },
  {
    name: "list_skills",
    description: "Show workflow candidates (detected multi-step command patterns), generated skills, and their occurrence counts.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// ── Tool Handlers ──

function handleGetContext() {
  if (!projectRoot) return shared.formatMCPResponse("get_context", "error", "No project root found", null, mcpSession);

  const memDir = path.join(projectRoot, ".ai-memory");
  let researchCount = 0, decisionCount = 0, scriptCount = 0, explorationCount = 0;

  try { researchCount = shared.readJsonl(path.join(memDir, "research.jsonl")).length; } catch {}
  try { decisionCount = shared.readJsonl(path.join(memDir, "decisions.jsonl")).length; } catch {}
  try { scriptCount = shared.readScripts(projectRoot).length; } catch {}
  try { explorationCount = shared.readExplorationsIndex(projectRoot).length; } catch {}

  let codeStats = null;
  const db = getCodeGraph(projectRoot);
  if (db) {
    try { codeStats = codeGraphMod.getStats(db); } catch {}
  }

  const sessionState = shared.readSessionState(projectRoot);
  const summary = [
    `Memory: ${researchCount} findings, ${decisionCount} decisions, ${scriptCount} scripts, ${explorationCount} explorations`,
    codeStats ? `Code graph: ${codeStats.nodes} nodes, ${codeStats.edges} edges, ${codeStats.files} files` : "Code graph: not built (run build-code-graph.js)",
    `Session: ${sessionState.taskTracker.toolCallsSinceSummary} tool calls this session`,
  ].join(". ");

  return shared.formatMCPResponse("get_context", "ok", summary, {
    projectRoot,
    research: researchCount,
    decisions: decisionCount,
    scripts: scriptCount,
    explorations: explorationCount,
    codeGraph: codeStats,
  }, mcpSession);
}

function handleMemorySearch(params) {
  if (!projectRoot) return shared.formatMCPResponse("memory_search", "error", "No project root", null, mcpSession);

  const query = params.query || "";
  const limit = params.limit || 5;
  const research = shared.readJsonl(path.join(projectRoot, ".ai-memory", "research.jsonl"));
  const decisions = shared.readJsonl(path.join(projectRoot, ".ai-memory", "decisions.jsonl"));

  // BM25 search over research
  const researchIndex = shared.buildBM25Index(research);
  const researchHits = shared.bm25Score(query, researchIndex).slice(0, limit);
  const researchMap = Object.fromEntries(research.map(r => [r.id, r]));

  // BM25 search over decisions
  const decisionSearchable = decisions.map(d => ({
    id: d.id, topic: d.category || "", tags: [],
    finding: [d.decision || "", d.rationale || "", d.category || ""].join(" "),
  }));
  const decisionIndex = shared.buildBM25Index(decisionSearchable);
  const decisionHits = shared.bm25Score(query, decisionIndex).slice(0, 3);
  const decisionMap = Object.fromEntries(decisions.map(d => [d.id, d]));

  // Graph expansion on research hits
  let graphConnections = [];
  try {
    const graphMod = require(path.join(import.meta.dirname, "graph.js"));
    const triples = graphMod.readGraph(projectRoot);
    const adj = graphMod.buildAdjacencyIndex(triples);
    const hitEntities = [];
    for (const { docId } of researchHits) {
      const entry = researchMap[docId];
      if (entry?.entities) hitEntities.push(...entry.entities);
    }
    if (hitEntities.length > 0) {
      const expanded = graphExpand(adj, hitEntities, 2);
      graphConnections = expanded.connections.slice(0, 10);
    }
  } catch {}

  const results = {
    research: researchHits.map(({ docId, score }) => {
      const entry = researchMap[docId];
      return entry ? { topic: entry.topic, finding: entry.finding, tags: entry.tags, score: +score.toFixed(2), date: entry.ts?.slice(0, 10) } : null;
    }).filter(Boolean),
    decisions: decisionHits.map(({ docId, score }) => {
      const entry = decisionMap[docId];
      return entry ? { category: entry.category, decision: entry.decision, rationale: entry.rationale, score: +score.toFixed(2) } : null;
    }).filter(Boolean),
    graphConnections: graphConnections.length > 0 ? graphConnections : undefined,
  };

  const totalHits = results.research.length + results.decisions.length;
  return shared.formatMCPResponse("memory_search", "ok",
    `Found ${totalHits} results for "${query}"`,
    results, mcpSession);
}

function graphExpand(adj, seedEntities, depth) {
  if (!adj || seedEntities.length === 0) return { connections: [], relatedFindingIds: new Set() };
  const visited = new Set();
  const connections = [];
  const relatedFindingIds = new Set();
  let frontier = seedEntities.map(e => e.toLowerCase());
  for (let hop = 1; hop <= depth; hop++) {
    const next = [];
    for (const entity of frontier) {
      if (visited.has(entity)) continue;
      visited.add(entity);
      const edges = adj[entity] || [];
      for (const edge of edges) {
        if (!visited.has(edge.target)) {
          connections.push({ from: entity, predicate: edge.predicate, to: edge.target, hop });
          relatedFindingIds.add(edge.src);
          next.push(edge.target);
        }
      }
    }
    frontier = next;
  }
  return { connections, relatedFindingIds };
}

function handleScriptSearch(params) {
  if (!projectRoot) return shared.formatMCPResponse("script_search", "error", "No project root", null, mcpSession);

  const query = params.query || "";
  const limit = params.limit || 3;
  const results = shared.searchScripts(projectRoot, query).slice(0, limit);

  const data = results.map(({ script, score }) => ({
    name: script.name,
    description: script.description,
    template: script.template,
    parameters: script.parameters,
    usage_count: script.usage_count || 1,
    score: +score.toFixed(2),
  }));

  return shared.formatMCPResponse("script_search", "ok",
    `Found ${data.length} scripts for "${query}"`,
    data, mcpSession);
}

function handleMemorySave(params) {
  if (!projectRoot) return shared.formatMCPResponse("memory_save", "error", "No project root", null, mcpSession);

  const memDir = path.join(projectRoot, ".ai-memory");
  const id = crypto.randomBytes(4).toString("hex");
  const ts = new Date().toISOString();

  if (params.type === "research") {
    const entry = {
      id, ts,
      topic: params.topic,
      tags: (params.tags || "").split(",").map(t => t.trim()).filter(Boolean),
      finding: params.content,
      entities: (params.entities || "").split(",").map(e => e.trim()).filter(Boolean),
      source_tool: "mcp",
      source_context: "Saved via MCP memory_save tool",
      confidence: 0.9,
      staleness: params.staleness || "stable",
      supersedes: null,
      version_anchored: null,
    };

    // Dedup check
    const existing = shared.readJsonl(path.join(memDir, "research.jsonl"));
    const similar = shared.findSimilarEntry(existing, entry.topic, entry.tags);
    if (similar) {
      return shared.formatMCPResponse("memory_save", "duplicate",
        `Similar entry already exists: "${similar.topic}"`,
        { existing_id: similar.id, existing_topic: similar.topic }, mcpSession);
    }

    shared.appendJsonl(path.join(memDir, "research.jsonl"), entry);
    shared.invalidateBM25Cache(projectRoot);

    // Entity index
    if (entry.entities.length > 0) {
      shared.addToEntityIndex(projectRoot, entry.entities, id);
    }

    // Sync tools
    try {
      const syncTools = require(path.join(import.meta.dirname, "sync-tools.js"));
      syncTools.syncAll(projectRoot);
    } catch {}

    return shared.formatMCPResponse("memory_save", "ok",
      `Saved research: "${params.topic}" (id: ${id})`,
      { id, type: "research" }, mcpSession);

  } else if (params.type === "decision") {
    const entry = {
      id, ts,
      category: params.category || "architecture",
      decision: params.topic,
      rationale: params.content,
      confidence: 1.0,
      source: "mcp",
    };

    shared.appendJsonl(path.join(memDir, "decisions.jsonl"), entry);

    try {
      const syncTools = require(path.join(import.meta.dirname, "sync-tools.js"));
      syncTools.syncAll(projectRoot);
    } catch {}

    return shared.formatMCPResponse("memory_save", "ok",
      `Saved decision: "${params.topic}" (id: ${id})`,
      { id, type: "decision" }, mcpSession);
  }

  return shared.formatMCPResponse("memory_save", "error", "Invalid type", null, mcpSession);
}

function handleSessionSummary() {
  if (!projectRoot) return shared.formatMCPResponse("session_summary", "error", "No project root", null, mcpSession);

  const memDir = path.join(projectRoot, ".ai-memory");
  const state = shared.readSessionState(projectRoot);
  const breadcrumbs = shared.getUnsavedBreadcrumbs(projectRoot);

  let researchCount = 0, decisionCount = 0;
  try { researchCount = shared.readJsonl(path.join(memDir, "research.jsonl")).length; } catch {}
  try { decisionCount = shared.readJsonl(path.join(memDir, "decisions.jsonl")).length; } catch {}

  const candidates = shared.readWorkflowCandidates(projectRoot);
  const pendingCandidates = candidates.filter(c => c.status === "suggested");

  const hasPending = breadcrumbs.length > 0;
  const summary = {
    toolCalls: state.taskTracker.toolCallsSinceSummary,
    tasksCreated: state.taskTracker.created,
    tasksCompleted: state.taskTracker.completed,
    researchEntries: researchCount,
    decisionEntries: decisionCount,
    unsavedBreadcrumbs: breadcrumbs.length,
    pendingWorkflows: pendingCandidates.length,
    status: hasPending ? "PENDING_SAVES" : "CLEAN",
  };

  // Reset counter
  state.taskTracker.toolCallsSinceSummary = 0;
  shared.writeSessionState(projectRoot, state);

  const statusText = hasPending
    ? `WARNING: ${breadcrumbs.length} unsaved breadcrumbs. Save discoveries before ending session!`
    : `Session clean. ${researchCount} research, ${decisionCount} decisions total.`;

  return shared.formatMCPResponse("session_summary", "ok", statusText, summary, mcpSession);
}

function handleGraphContext(params) {
  if (!projectRoot) return shared.formatMCPResponse("graph_context", "error", "No project root", null, mcpSession);

  const entity = params.entity || "";
  const depth = params.depth || 2;

  try {
    const graphMod = require(path.join(import.meta.dirname, "graph.js"));
    const triples = graphMod.readGraph(projectRoot);
    const adj = graphMod.buildAdjacencyIndex(triples);
    const expanded = graphExpand(adj, [entity], depth);

    return shared.formatMCPResponse("graph_context", "ok",
      `Found ${expanded.connections.length} connections for "${entity}"`,
      { connections: expanded.connections.slice(0, 20) }, mcpSession);
  } catch {
    return shared.formatMCPResponse("graph_context", "ok",
      "Knowledge graph not available",
      { connections: [] }, mcpSession);
  }
}

function handleCodeSearch(params) {
  const db = getCodeGraph(projectRoot);
  if (!db) return shared.formatMCPResponse("code_search", "error", "Code graph not built. Run: node scripts/build-code-graph.js", null, mcpSession);

  const query = params.query || "";
  const limit = params.limit || 20;
  const results = codeGraphMod.searchNodes(db, query, limit);

  const data = results.map(r => ({
    kind: r.kind,
    name: r.name,
    qualified_name: r.qualified_name,
    file_path: r.file_path,
    line_start: r.line_start,
    signature: r.signature,
  }));

  return shared.formatMCPResponse("code_search", "ok",
    `Found ${data.length} code entities matching "${query}"`,
    data, mcpSession);
}

function handleCodeContext(params) {
  const db = getCodeGraph(projectRoot);
  if (!db) return shared.formatMCPResponse("code_context", "error", "Code graph not built", null, mcpSession);

  const qn = params.qualified_name || "";
  let node = codeGraphMod.getNode(db, qn);

  // Try fuzzy match if exact not found
  if (!node) {
    const search = codeGraphMod.searchNodes(db, qn, 1);
    if (search.length > 0) node = search[0];
  }

  if (!node) return shared.formatMCPResponse("code_context", "ok", `Entity "${qn}" not found in code graph`, null, mcpSession);

  const callers = codeGraphMod.getCallers(db, node.qualified_name).map(e => ({
    name: e.source_qualified, kind: e.source_kind, signature: e.source_sig, line: e.line
  }));

  const callees = codeGraphMod.getCallees(db, node.qualified_name).map(e => ({
    name: e.target_qualified, kind: e.target_kind, line: e.line
  }));

  const inheritors = codeGraphMod.getInheritors(db, node.qualified_name).map(e => ({
    name: e.name || e.source_qualified, file: e.file_path
  }));

  const tests = codeGraphMod.getTests(db, node.qualified_name).map(e => ({
    name: e.name || e.source_qualified, file: e.file_path, signature: e.signature
  }));

  const members = codeGraphMod.getContains(db, node.qualified_name).map(m => ({
    kind: m.kind, name: m.name, signature: m.signature, line: m.line_start
  }));

  const data = {
    entity: {
      kind: node.kind, name: node.name, qualified_name: node.qualified_name,
      file_path: node.file_path, line_start: node.line_start, line_end: node.line_end,
      signature: node.signature, language: node.language,
    },
    callers: callers.slice(0, 20),
    callees: callees.slice(0, 20),
    inheritors: inheritors.slice(0, 10),
    tests,
    members: members.slice(0, 30),
  };

  const summary = [
    `${node.kind} ${node.name}`,
    `${callers.length} callers, ${callees.length} callees`,
    tests.length > 0 ? `${tests.length} tests` : "no tests",
    members.length > 0 ? `${members.length} members` : "",
  ].filter(Boolean).join(", ");

  return shared.formatMCPResponse("code_context", "ok", summary, data, mcpSession);
}

function handleCodeImpact(params) {
  const db = getCodeGraph(projectRoot);
  if (!db) return shared.formatMCPResponse("code_impact", "error", "Code graph not built", null, mcpSession);

  const qn = params.qualified_name || "";
  const depth = params.depth || 2;

  let node = codeGraphMod.getNode(db, qn);
  if (!node) {
    const search = codeGraphMod.searchNodes(db, qn, 1);
    if (search.length > 0) node = search[0];
  }
  if (!node) return shared.formatMCPResponse("code_impact", "ok", `Entity "${qn}" not found`, null, mcpSession);

  const impacted = codeGraphMod.getImpactRadius(db, node.qualified_name, depth);
  const affectedFiles = [...new Set(impacted.filter(i => i.file_path).map(i => i.file_path))];
  const tests = impacted.filter(i => i.kind === "Test");

  const data = {
    entity: node.qualified_name,
    impacted: impacted.slice(0, 30),
    affectedFiles,
    testsCovering: tests,
    totalImpacted: impacted.length,
  };

  return shared.formatMCPResponse("code_impact", "ok",
    `${impacted.length} entities affected by changes to ${node.name}, ${affectedFiles.length} files, ${tests.length} tests`,
    data, mcpSession);
}

function handleCodeStructure(params) {
  const db = getCodeGraph(projectRoot);
  if (!db) return shared.formatMCPResponse("code_structure", "error", "Code graph not built", null, mcpSession);

  const target = params.target || "";
  const type = params.type || "module";

  if (type === "class") {
    const hierarchy = codeGraphMod.getClassHierarchy(db, target);
    if (!hierarchy) return shared.formatMCPResponse("code_structure", "ok", `Class "${target}" not found`, null, mcpSession);

    return shared.formatMCPResponse("code_structure", "ok",
      `Class ${hierarchy.node.name}: ${hierarchy.members.length} members, ${hierarchy.parents.length} parents, ${hierarchy.children.length} children`,
      hierarchy, mcpSession);
  } else {
    const structure = codeGraphMod.getModuleHierarchy(db, target);
    return shared.formatMCPResponse("code_structure", "ok",
      `${structure.files.length} files, ${structure.classes.length} classes under "${target}"`,
      structure, mcpSession);
  }
}

function handleListSkills() {
  if (!projectRoot) return shared.formatMCPResponse("list_skills", "error", "No project root", null, mcpSession);

  const candidates = shared.readWorkflowCandidates(projectRoot);

  const data = {
    candidates: candidates.map(c => ({
      id: c.id,
      name: c.name,
      status: c.status,
      occurrences: (c.occurrences || []).length,
      steps: (c.steps || []).map(s => s.name).slice(0, 5),
      skillPath: c.skillPath,
    })),
    total: candidates.length,
    suggested: candidates.filter(c => c.status === "suggested").length,
    created: candidates.filter(c => c.status === "created").length,
  };

  return shared.formatMCPResponse("list_skills", "ok",
    `${data.total} workflow candidates (${data.suggested} suggested, ${data.created} created)`,
    data, mcpSession);
}

// ── Tool Dispatch ──

function handleToolCall(name, args) {
  shared.recordMCPToolCall(mcpSession, name, args);

  switch (name) {
    case "get_context": return handleGetContext();
    case "memory_search": return handleMemorySearch(args);
    case "script_search": return handleScriptSearch(args);
    case "memory_save": return handleMemorySave(args);
    case "session_summary": return handleSessionSummary();
    case "graph_context": return handleGraphContext(args);
    case "code_search": return handleCodeSearch(args);
    case "code_context": return handleCodeContext(args);
    case "code_impact": return handleCodeImpact(args);
    case "code_structure": return handleCodeStructure(args);
    case "list_skills": return handleListSkills();
    default:
      return { status: "error", summary: `Unknown tool: ${name}` };
  }
}

// ── Server Setup ──

const server = new Server(
  { name: "project-memory", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = handleToolCall(name, args || {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "error", summary: err.message }) }],
      isError: true,
    };
  }
});

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running on stdio
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
