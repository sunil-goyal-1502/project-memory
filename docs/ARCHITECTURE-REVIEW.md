# 📐 Architectural Review: project-memory

How `project-memory` reduces LLM token usage at three layers — **the core
memory subsystem** (eliminate redundant generation), then **TurboQuant**
(shrink the memory footprint that powers it), and finally the **AI Router**
(send what's left to a local model when possible).

> Read order: §1 explains the baseline savings the plugin delivers out of the
> box. §2 shows how TurboQuant shrinks the data structures §1 depends on. §3
> shows how the AI Router cuts the cloud bill on whatever remains.

| Layer | Subsystem | What it eliminates |
|---|---|---|
| **§1** Memory | `scripts/*` + `hooks/*` + `mcp-server.mjs` + `daemon.js` | Re-investigation, re-research, re-explanation, lost session context |
| **§2** Quantization | `scripts/turbo-quant.js` + `scripts/embedding-cache.js` | RAM/disk needed by the §1 embedding cache |
| **§3** Routing | `router/*` (22 files) | Cloud tokens for prompts a local model can answer |

The three layers are **independent**. Disable any one (`router_mode=disabled`,
`bitWidth=null`, or simply don't load the plugin) and the others keep working.

---

# 1. Core Memory Subsystem — Eliminating Redundant LLM Work

## 1.1 The token problem this layer solves

A coding assistant typically:

1. Re-derives the same architectural facts every session ("how does auth work
   in this repo?") — costs thousands of tokens of file exploration each time.
2. Re-runs the same investigation pipelines ("fetch ADO build, parse logs,
   classify failures") — costs more tokens of trial-and-error reasoning.
3. Loses the *outcome* of all that work the moment the session ends.
4. Re-loads the entire codebase into context window for any structural query.

`project-memory` attacks each of these:

| Mechanism | What it stores | What it saves |
|---|---|---|
| **Decisions store** | Architectural choices, conventions, constraints | Re-litigating "what did we decide about X?" |
| **Research store** | API behavior, library versions, error root causes | Re-investigating the same question |
| **Script library** | Parameterized command templates with `{{slot}}` placeholders | Rebuilding multi-step shell commands |
| **Code graph** | SQLite + FTS5 of every function/class/edge | Re-grepping to understand structure |
| **Knowledge graph** | Subject-predicate-object triples linking entities | Following relationships across files |
| **Embeddings** | 384-dim semantic vectors per entry | Substring search misses semantically similar findings |
| **Explorations** | Full verbatim agent outputs as Markdown | Re-running the same exploration |
| **Auto-capture** | Reusable Bash commands detected post-tool-use | Forcing the user to remember to save |

## 1.2 On-disk layout (`.ai-memory/`)

Every file is plain JSONL/JSON/SQLite — no proprietary format, fully diffable.

```
.ai-memory/
├── decisions.jsonl          —  Project decisions (one JSON per line)
├── research.jsonl           —  Research findings (one JSON per line)
├── scripts.jsonl            —  Reusable command templates with {{params}}
├── graph.jsonl              —  Knowledge graph triples (S-P-O)
├── embeddings.json          —  { entryId → Float32[384] } (or quantized)
├── entity-index.json        —  { entity → [findingId, ...] } reverse index
├── explorations/            —  Verbatim agent outputs (.md with frontmatter)
│   └── 2026-04-22-*.md
├── explorations.jsonl       —  Index over explorations/
├── code-graph.db            —  SQLite + FTS5 (nodes, edges, nodes_fts)
├── workflow-candidates.jsonl—  Detected multi-step command sequences
├── session-history.jsonl    —  Per-session activity for analytics
├── config.json              —  Per-project settings
├── metadata.json            —  Plugin metadata
│
└── (caches & state — regenerable, gitignored)
    ├── .bm25-cache.json     —  Inverted index for research.jsonl
    ├── .graph-adj-cache.json—  Adjacency cache for fast traversal
    ├── .intent-embeddings.json
    ├── .session-state.json
    ├── .tool-history        —  Last 50 tool calls (auto-capture detector)
    ├── .exploration-log     —  Breadcrumb log for unsaved-detector
    ├── .last-session-summary
    ├── .session-start-ts
    └── .hook-debug.log
```

A live mature project on disk:

| File | Bytes | Contains |
|---|---|---|
| `research.jsonl` | 159,534 | 155 research findings |
| `scripts.jsonl` | 123,623 | 52 command templates |
| `graph.jsonl` | 832,156 | knowledge-graph triples |
| `embeddings.json` | 1,757,496 | Float32 cache (target of TurboQuant — see §2) |
| `code-graph.db` | 1,941,504 | 418 nodes, 2,372 edges, FTS5 over names |
| `entity-index.json` | 23,462 | reverse map |
| `.bm25-cache.json` | 360,327 | precomputed inverted index |
| `.graph-adj-cache.json` | 1,360,760 | adjacency lists |

## 1.3 Component map

```
                             ┌──────────────────────────────┐
                             │  Coding Assistant / IDE      │
                             │  (Claude Code, Cursor, …)    │
                             └──────────────────────────────┘
                                  ▲                   ▲
                  MCP (stdio)     │                   │ Hooks (stdin/stdout JSON)
                                  │                   │
       ┌──────────────────────────┴──┐   ┌────────────┴────────────────┐
       │  scripts/mcp-server.mjs     │   │  hooks/scripts/*.js          │
       │  11 on-demand tools:        │   │  • session-start.js          │
       │   get_context               │   │  • pre-tool-use.js           │
       │   memory_search             │   │  • post-tool-use.js          │
       │   script_search             │   │  • session-stop.js           │
       │   memory_save               │   │                              │
       │   session_summary           │   │  Proactive enforcement:      │
       │   graph_context             │   │   - inject relevant memory   │
       │   code_search               │   │   - escalate save reminders  │
       │   code_context              │   │   - log breadcrumbs          │
       │   code_impact               │   │   - auto-capture exploration │
       │   code_structure            │   │   - auto-extract scripts     │
       │   list_skills               │   └──────────────────────────────┘
       └─────────────────────────────┘                  │
                  │                                     │
                  └──────────────┬──────────────────────┘
                                 ▼
              ┌──────────────────────────────────────┐
              │   scripts/daemon.js (TCP localhost)  │
              │   Single global process              │
              │   Per-project Map<root, ProjectData> │
              │   Loads on first request, watches    │
              │   files, auto-reloads on change.     │
              │   2-hour inactivity timeout.         │
              └──────────────────────────────────────┘
                                 │
                                 ▼
              ┌──────────────────────────────────────┐
              │   scripts/shared.js  (54 KB)         │
              │   Pure-JS utilities used everywhere: │
              │     readJsonl / appendJsonl          │
              │     buildBM25Index / bm25Score       │
              │     loadCachedBM25 / invalidate…     │
              │     findSimilarEntry  (dedup)        │
              │     detectAutoCapture                │
              │     parameterizeCommand              │
              │     extractFilePathsFromText         │
              │     extractTagsFromPrompt            │
              │     searchExplorations               │
              │     isReusableScript / dedupScripts  │
              │     entity-index helpers             │
              └──────────────────────────────────────┘
                  │           │           │           │
                  ▼           ▼           ▼           ▼
              .ai-memory/   embeddings.js  graph.js   code-graph.js
              JSONL stores  (ONNX MiniLM)  (KG)       (SQLite+FTS5)
```

Two service surfaces:

- **MCP server** (`scripts/mcp-server.mjs`) — pulled by the LLM on demand
  ("search my memory", "show code structure"). Stateless across calls.
- **Hooks** (`hooks/scripts/*.js`) — fire on every tool call. Push relevant
  memory into context proactively; capture new artefacts after each call.

Both share `scripts/shared.js` and (when running) the global daemon.

## 1.4 Storage engines

### 1.4.1 JSONL append-only stores

`research.jsonl`, `decisions.jsonl`, `scripts.jsonl`, `graph.jsonl`,
`session-history.jsonl`, `workflow-candidates.jsonl`, `explorations.jsonl`.

```
Each line is one self-contained JSON object. Examples:

decisions.jsonl
  {"id":"3a2f…","ts":"2026-04-22T…","category":"architecture",
   "decision":"…","rationale":"…","confidence":1.0,"source":"copilot"}

research.jsonl
  {"id":"…","ts":"…","topic":"<5-15 word noun phrase>","tags":[…],
   "finding":"…","staleness":"stable|versioned|volatile",
   "confidence":0.95,"source_tool":"copilot","source_context":"…",
   "supersedes":null,"version_anchored":null,"entities":["File","Class"]}

scripts.jsonl
  {"id":"…","template":"curl -H Authorization $TOKEN \
     'https://.../builds/{{build_id}}/Timeline?api-version=7.1' …",
   "params":["build_id","token"], "tags":["ado","build","timeline"],
   "skeleton":"<normalized cmd>","occurrences":3, …}
```

Append-only buys: **atomic writes** (`appendJsonl()` is one `fs.appendFileSync`),
**zero corruption risk**, **trivial diff/merge** in git, **streamable reads**.

### 1.4.2 BM25 inverted index (`shared.js:164-200`)

```
buildBM25Index(entries) →
  invertedIndex: { term → [{docId, tf}, ...] }
  docLengths:    { docId → length }
  avgDocLen:     number
  N:             total docs

bm25Score(query, index, k1=1.2, b=0.75) →
  for each query term t:
    df = posting list length
    idf = log( (N - df + 0.5) / (df + 0.5) + 1 )
    for each (docId, tf) in postings:
      score += idf · ( tf·(k1+1) /
                       ( tf + k1·(1 - b + b·dl/avgDocLen) ) )
  → ranked [{docId, score}, ...]
```

The index is **cached on disk** at `.bm25-cache.json` keyed by the source
file's mtime. `loadCachedBM25()` returns null on mtime mismatch, forcing a
rebuild via `buildAndCacheBM25()`. Saves invalidate the cache via
`invalidateBM25Cache()`.

This single index makes search **<10 ms** even on 1,000+ entries — small
enough to ship inside a hook's response budget.

### 1.4.3 Semantic embeddings (`embeddings.js`)

```
Model:  Xenova/all-MiniLM-L6-v2  (ONNX, q8 quantized)
        ~22 MB on disk, ~50 ms per query, 384-dim output

generateEmbedding(text) →
  await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" })
  result = extractor(text, { pooling: "mean", normalize: true })
  return Array.from(result.data)   // Float32Array(384)

cosineSimilarity(a, b) → dot(a,b) / (||a|| · ||b||)
                       (vectors are pre-normalized, so dot is cosine)

readEmbeddings  → JSON.parse(.ai-memory/embeddings.json)
writeEmbeddings → JSON.stringify(...)

semanticSearch(query, storedEmbeddings, topK) →
  qE = generateEmbedding(query)
  for each (docId, emb) in storedEmbeddings:
    rank by cosineSimilarity(qE, emb)
  return topK
```

The ONNX model is **lazy-loaded once per process** (the pipeline is cached in
`_pipeline`). After the first query the per-call cost is dominated by the
model invocation (~50 ms), not the loop over stored embeddings.

> §2 (TurboQuant) replaces the raw `Float32Array(384)` storage in
> `embeddings.json` with an 8× smaller representation, without changing this
> API.

### 1.4.4 Code graph (`code-graph.js` + `code-parser.js`)

A SQLite database with **FTS5 virtual table** for code structure queries.

```sql
CREATE TABLE nodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,   -- File | Class | Function | Type | Test
  name            TEXT NOT NULL,
  qualified_name  TEXT UNIQUE NOT NULL,
  file_path       TEXT,
  line_start      INTEGER,
  line_end        INTEGER,
  language        TEXT,
  signature       TEXT,
  parent_name     TEXT,
  file_hash       TEXT,
  updated_at      REAL
);

CREATE TABLE edges (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL,  -- CALLS | IMPORTS | INHERITS | CONTAINS | TESTED_BY
  source_qualified TEXT NOT NULL,
  target_qualified TEXT NOT NULL,
  file_path        TEXT,
  line             INTEGER
);

CREATE VIRTUAL TABLE nodes_fts USING fts5(
  qualified_name, name, signature, content=nodes, content_rowid=id
);
```

Live counts on this very repo: **418 nodes, 2,372 edges** (374 Functions,
44 Files; 2,234 CALLS, 138 IMPORTS).

Code is parsed by `code-parser.js` using **tree-sitter** (`@vscode/tree-sitter-wasm`
+ `web-tree-sitter`), which yields per-language ASTs. The parser walks each
AST extracting nodes (function/class/method declarations) and edges (call
sites, imports, inheritance).

MCP tools that consume the graph:
- `code_search` — FTS5 query over `qualified_name` + `name` + `signature`
- `code_context` — node + callers + callees + class members + tests
- `code_impact` — N-hop blast radius traversal of `edges` table
- `code_structure` — module hierarchy or class hierarchy view

**Why this saves tokens**: instead of round-tripping through `grep` and
multiple `view` calls to understand a function's call graph (often
10K+ tokens of file content), one `code_context` call returns a compact
table of 30–100 entities (~500 tokens).

### 1.4.5 Knowledge graph (`graph.js`)

Subject-Predicate-Object triples in `graph.jsonl`, indexed in-memory as an
adjacency map cached at `.graph-adj-cache.json`.

```
Predicates auto-extracted from research findings:
  uses | depends_on | calls | implements | extends |
  returns | fixes | replaces | tested_by | configured_by | …

Triple example:
  { "s": "AppiumAndroidTestTearDown",
    "p": "calls",
    "o": "ClearAppDataAsync",
    "source": "research:abc12345",
    "ts": "…" }
```

`extractTriplesFromEntry()` runs regex patterns over a finding's text;
`extractEntitiesFromText()` mines proper-noun-like tokens (`PascalCase`,
file names, qualified identifiers) which feed both the graph and
`entity-index.json` (a reverse map: entity → finding IDs).

Used by `graph_context(entity, depth=2)` to return all findings within N
hops — letting the LLM ask "what do we know about X and everything related
to X?" in one call.

### 1.4.6 Explorations (verbatim capture)

When a sub-agent (e.g., `Task` tool) returns its result, the post-tool-use
hook captures the **full output** as a Markdown file under
`.ai-memory/explorations/` with YAML frontmatter and indexes it in
`explorations.jsonl`. Triples are extracted into the knowledge graph so
future sessions can retrieve the verbatim text by topic.

Per-decision: complete agent output is **preserved as-is**, not summarized
into atomic facts (a deliberate choice — see project decision in
`decisions.jsonl`).

## 1.5 Hooks pipeline (`hooks/scripts/*.js`)

```
session-start.js
   ├─ Self-heal plugin junction (cache → source)
   ├─ Build & cache BM25 index
   ├─ Inject decisions + recent research as system context
   └─ Track tokens "saved" (loaded once vs. re-derived)

pre-tool-use.js   (fires on EVERY tool call)
   ├─ Detect tool kind: matched | lightweight | immediate-save | task
   ├─ If exploratory (Bash/Task): search memory for relevant findings
   ├─ Inject hits as systemMessage (≤ N tokens)
   ├─ Throttle (THROTTLE_MS) to avoid spam
   └─ Escalate save-reminders after ESCALATION_THRESHOLD calls without save

post-tool-use.js
   ├─ Append breadcrumb to .exploration-log
   ├─ detectAutoCapture():
   │     looks at last few tool calls, decides whether the chain looks
   │     like a multi-step research workflow worth saving
   ├─ autoSaveCapture() if intent classifier ≥ threshold
   ├─ autoSaveScript() if Bash command passes isReusableScript()
   ├─ Auto-capture exploration markdown if Task agent returned
   └─ Update .tool-history (rolling 50)

session-stop.js / session-summary
   ├─ Compute unsaved breadcrumbs vs. saved findings
   ├─ Write workflow-candidates.jsonl (multi-step patterns)
   └─ Persist summary at .last-session-summary
```

The hook contract is the JSON-over-stdin/stdout protocol used by Claude Code
and similar assistants:
```
stdin  → { tool_name, tool_input, …context }
stdout ← { hookSpecificOutput?: {...}, systemMessage?: "…", reason?: "…" }
```

## 1.6 Save / dedup / version pipeline

```
save-research.js / save-decision.js / save-script.js
   │
   ▼
findSimilarEntry()  (shared.js:253)
   matches on:
     • topic substring (either direction)
     • ≥ 2 overlapping tags
   on match → warn user (or supersede in --force mode)
   │
   ▼
appendJsonl()
   │
   ├─ generateEmbedding(text) → push into embeddings.json
   ├─ extractTriplesFromEntry() → push into graph.jsonl
   ├─ extractEntitiesFromText() → push into entity-index.json
   └─ invalidateBM25Cache()  (next read rebuilds)
   │
   ▼
sync-tools.js
   updates CLAUDE.md / .cursor/rules / .github/copilot-instructions.md
   so other tools see the same memory without their own setup.
```

Versioning: each entry carries `staleness ∈ {stable, versioned, volatile}`
plus optional `supersedes: <prevId>` and `version_anchored: <semver>` fields.
Stale entries are filtered from default search results.

## 1.7 Daemon (`scripts/daemon.js`)

A single global Node process listens on a TCP port written to
`~/.ai-memory-daemon-port`, with PID at `~/.ai-memory-daemon-pid`.

```
Per-project state:  Map<projectRoot, ProjectData>

ProjectData = {
  research: [...],          scripts: [...],
  researchBM25: {...},      scriptBM25: {...},
  graphAdj: {...},          explorations: [...],
  config: {...},            embeddingCache: EmbeddingCache,
  watchersSetup: bool,      sourceWatcher: fs.watch handle
}
```

Hooks/MCP send a JSON request `{ projectRoot, op, args }`; the daemon does
the work in-process (BM25 already loaded, embeddings in RAM, graph adjacency
ready) and replies. Measured hook round-trip: **14–100 ms total, 1–9 ms
in-daemon**. Without the daemon every hook would re-parse the JSONL stores
(7+ `fs.readFileSync` per call).

Self-management:
- Lazy project load on first request (validates `.ai-memory/` exists).
- `fs.watchFile` per data file for auto-reload.
- 2-hour inactivity timeout → graceful shutdown.
- `node daemon.js --stop` for explicit shutdown.

## 1.8 MCP tool catalogue (`scripts/mcp-server.mjs`)

| Tool | Returns | Replaces |
|---|---|---|
| `get_context` | ~100 token overview: stats, recent activity, suggestions | "Tell me about this project" round-trips |
| `memory_search` | Top-K findings (BM25 + embeddings + graph expansion) | Re-investigation |
| `script_search` | Reusable script templates with `{{params}}` | Rebuilding shell pipelines |
| `memory_save` | Confirmation + dedup warning if similar exists | Manual JSONL editing |
| `session_summary` | Breadcrumbs, workflow candidates, save suggestions | Forgetting to save |
| `graph_context` | All findings within N hops of an entity | Multiple `memory_search` calls |
| `code_search` | FTS5 hits over qualified names / signatures | Multiple `grep` invocations |
| `code_context` | Function/class with callers, callees, members, tests | Multiple `view` calls |
| `code_impact` | N-hop blast radius of a change | Manual cross-reference walking |
| `code_structure` | Module or class hierarchy | Reading directory listings |
| `list_skills` | Auto-detected workflow candidates | Running scripts blindly |

Every tool answer is **tens to hundreds of tokens** vs. the **thousands** of
tokens that would be needed to reconstruct the same answer from raw files.

## 1.9 Token-economics summary (Layer 1 alone)

Measured in `stats.js` via `TOKENS_SAVED` constants (per-load and per-call):

| Activity | Without project-memory | With project-memory | Saved |
|---|---|---|---|
| Resume work next day on same project | Re-explore codebase (~15 K tok) | Read decisions + recent research (~1.5 K tok) | **~90%** |
| Look up a previously-investigated API | Re-investigate via web/docs | `memory_search` (one tool call, ~500 tok) | **~95%** |
| Understand a function's call graph | Multiple `view` + `grep` (~10 K tok) | `code_context` (~500 tok) | **~95%** |
| Re-run a multi-step ADO pipeline | Reconstruct curl chain (~3 K tok) | `script_search` + fill `{{slot}}` (~200 tok) | **~93%** |
| Tell a sibling tool (Cursor, Copilot) the same context | Manually re-prompt | `sync-tools.js` already wrote it | **100%** |

The plugin's stats dashboard (`scripts/dashboard.js`) tallies these per
session so the savings are observable, not asserted.

---

# 2. TurboQuant — Shrinking the Embedding Cache

Layer 1's embedding cache (`embeddings.json`) is a `Map<entryId, Float32[384]>`
that grows linearly with the project's memory. At Float32 it costs **1,536 B
per entry** — for a mature project (1,000–5,000 entries) that's **1.5–7.5 MB**
held by every long-lived hook process and reloaded on every daemon restart.

TurboQuant compresses it **8× with no API change**, by replacing
`Float32Array(384)` with a 192-byte payload that decodes back to a
near-original vector in < 1 ms.

## 2.1 The algorithm (paper: *arXiv:2504.19874*)

The core insight: **uniform random rotation makes any vector's coordinates
approximately Beta-distributed**, after which a per-coordinate scalar
quantizer is provably near-optimal at every bit-width.

```
                  TurboQuant pipeline (encode)
   ┌──────────────────────────────────────────────────────────┐
   │  Float32 vector v (384 dims, 1536 bytes)                 │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌──────────────────────────────────────────────────────────┐
   │  STEP 1 — Random rotation:   v' = R · v                  │
   │  R is an orthogonal 384×384 matrix built from a seeded   │
   │  Gram-Schmidt of normal noise. R is deterministic per    │
   │  process so encoder/decoder agree without storing R.     │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌──────────────────────────────────────────────────────────┐
   │  STEP 2 — Per-coord scalar quantize @ 3 bits             │
   │  Each rotated coord ∈ [-1,1] → level 0..7                │
   │  (Beta-aware uniform quantizer; alpha,beta from formula) │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌──────────────────────────────────────────────────────────┐
   │  STEP 3 — Bit-pack levels                                │
   │  ⌈384 × 3 / 8⌉ = 144 bytes (vs 1536 → 90.6% smaller)     │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌──────────────────────────────────────────────────────────┐
   │  STEP 4 — QJL bias correction (optional, default ON)     │
   │  Take dequant residual r = v' - dequant(level)           │
   │  Sign-quantize r to 1 bit → 48 bytes                     │
   │  Restores ~all of the cosine-similarity correlation.     │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
                     ┌───────────────┐
                     │ {packed:144,  │   total: 192 bytes
                     │  qjl:48,      │   compression: 8.0×
                     │  metadata}    │
                     └───────────────┘

Decode is the mirror image: unpack → scalar dequant → add QJL residual
→ apply Rᵀ (rotation is orthogonal, so inverse = transpose).
```

## 2.2 Component map

```
            ┌─────────────────────────────────────────┐
            │         scripts/turbo-quant.js          │
            │                                         │
            │  • computeRotationMatrix(dim, seed)     │
            │  • rotateVector / scalarQuantize        │
            │  • packLevels / unpackLevels            │
            │  • applyQJLTransform / dequantizeQJL    │
            │  • class Quantizer { quantize,          │
            │      dequantize, computeInnerProduct,   │
            │      estimateSize }                     │
            │  • serialize / deserialize (base64)     │
            └─────────────────────────────────────────┘
                            ▲
                            │ require
                            │
            ┌─────────────────────────────────────────┐
            │      scripts/embedding-cache.js         │
            │  EmbeddingCache class:                  │
            │  • Map<entryId, serializedQuantized>    │
            │  • cacheEmbedding() → quantize+store    │
            │  • getEmbedding() → deserialize+dequant │
            │  • stats: hits, misses, bytes saved     │
            └─────────────────────────────────────────┘
                            ▲
                            │ used by
                            │
            ┌─────────────────────────────────────────┐
            │    daemon / MCP search tools            │
            │  memory_search, code_search,            │
            │  graph_context — all read embeddings    │
            │  through EmbeddingCache.                │
            └─────────────────────────────────────────┘
```

## 2.3 Measured properties

(from `test/turbo-quant.test.js` + `test/search-quality.test.js`)

| Metric              | Float32 baseline | TurboQuant 3-bit + QJL    |
|---------------------|------------------|---------------------------|
| Bytes per vector    | 1,536            | **192** (8.0× smaller)    |
| Top-1 recall        | 100%             | **94%**                   |
| Top-3 recall        | 100%             | **88.9%**                 |
| Cosine correlation  | 1.000            | **0.71** (good for re-rank) |
| Encode latency      | —                | < 1 ms                    |
| Decode latency      | —                | < 1 ms                    |

Bit-width is configurable (`bitWidth: 2..8`) — 4-bit doubles size to 240 B
but pushes recall above 97%.

## 2.4 Where it plugs into Layer 1

`EmbeddingCache` is instantiated inside `daemon.js` per-project:
```js
embeddingCache: new EmbeddingCache({ enabled: true, bitWidth: 3, useQJL: true })
```
On every `memory_search`, `graph_context`, etc. the daemon looks the entry's
embedding up here instead of in `embeddings.json`. The `embeddings.json` file
itself can be rewritten in quantized form, shrinking the 1.7 MB file to
~210 KB.

## 2.5 Benefits over Layer 1 baseline

- **~88% memory reduction** on the embedding cache (1.5 MB → 0.19 MB at 1k
  entries; 7.5 MB → 0.95 MB at 5k).
- **Faster daemon cold-start** — less data to deserialize from disk.
- **Cheaper context for AI assistants** that read the embedding cache: smaller
  blobs, fewer tokens when surfaced.
- **Zero new dependencies** — pure JS, no native bindings, no GPU.
- **Deterministic** — same seed gives byte-identical output, so quantized
  blobs are diffable.
- **Drop-in** — `EmbeddingCache.quantizationEnabled = false` falls back to
  Float32 with no code changes elsewhere.

> Crucially, TurboQuant doesn't *eliminate* tokens — it makes the §1
> machinery cheap enough to run on a developer laptop and to load instantly
> on every session.

---

# 3. AI Router — Sending Surviving Prompts to a Local LLM

After §1 has eliminated redundant requests and §2 has shrunk the data
structures, every remaining LLM call goes out over the network. **Most of
those calls are still trivial** — embeddings, classifications, "rename this
var", small tab-completions — but are billed at frontier-model rates.

The AI Router intercepts those calls and routes the simple ones to a local
Ollama model, falling back to the original cloud provider when the prompt
genuinely needs frontier reasoning.

## 3.1 End-to-end request lifecycle

```
       client (Claude Code, Cursor, Codex, Aider, curl…)
              │  POST /v1/messages | /v1/chat/completions |
              │       /v1/responses | /v1/embeddings
              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  router/server.js   (native http on 127.0.0.1:8081)          │
   │  • Logs request (never logs auth headers or body)            │
   │  • router-table.js dispatches by path → handler              │
   └──────────────────────────────────────────────────────────────┘
              │
              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  router/adapter.js   toCommon()                              │
   │  Normalizes any wire format → commonRequest:                 │
   │  { format, kind, messages[], system, tools[], params,        │
   │    stream, _raw }                                            │
   └──────────────────────────────────────────────────────────────┘
              │
              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  router/fallback.js   dispatch()  (orchestrator)             │
   │                                                              │
   │  1. prompt-cache.js → semantic-similarity cache hit?         │
   │     ├─ HIT  ─────────────────────► return cached response    │
   │     └─ MISS                                                  │
   │  2. classifier.classify()  ─────► classification             │
   │  3. router.decide()        ─────► route { provider, model,   │
   │                                          fallback, reason }  │
   │  4. circuit-breaker.allow(provider)?                         │
   │     └─ open → skip to fallback                               │
   │  5. dispatch to provider:                                    │
   │       ollama.chat()  OR  upstream.forward()                  │
   │  6. confidence.check(response)                               │
   │     ├─ confident  → cache + return                           │
   │     └─ low conf   → if fallback set, re-issue to cloud       │
   │  7. stats.record() (exactly one row, even on retry)          │
   └──────────────────────────────────────────────────────────────┘
              │
              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  router/wire.js   Transcode response → caller's format       │
   │  (Ollama → Anthropic shape, etc.) and stream/buffer to res   │
   └──────────────────────────────────────────────────────────────┘
              ▼
                       client gets a response
                  identical in shape to the upstream
```

## 3.2 Classifier internals

(`classifier.js` + `heuristics.js` + `semantic-classifier.js`)

```
                    classify(commonRequest)
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
   guardrail short-circuits      heuristics.score()
   • req invalid → complex       15-feature vector:
   • kind=embedding → simple     promptTokens, toolCount,
                                 codeBlocks, diffMarkers,
                                 imperativeVerbs, multiFileRefs,
                                 reasoningRequest, ... → score∈[0,1]
                            │
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
       score < 0.40    0.40–0.70       score > 0.70
       → SIMPLE        BORDERLINE       → COMPLEX
                            │
                            ▼
            semantic-classifier.js (lazy-loaded)
            zero-shot ONNX MiniLM → {simple, complex} probs
                            │
                            ▼
          blend = 0.5·heuristic + 0.5·semantic_complex
          < 0.45 → simple   > 0.65 → complex   else → medium
                            │
                            ▼
       hard guardrail: tools.length > 1 → force COMPLEX
                            │
                            ▼
       { complexity, confidence, reasons[], heuristicScore,
         semanticScore? }
```

The lazy-load of the semantic model means **the heuristics-only path runs in
< 1 ms** and only the borderline ~10–20% of traffic pays the ~30–50 ms
cold-start.

## 3.3 Routing modes (`router.js`)

| Mode                  | Local picks                                 | Typical local-traffic share |
| --------------------- | ------------------------------------------- | --------------------------- |
| `aggressive`          | simple + medium → Ollama                    | 40–60%                      |
| `balanced` (default)  | simple → Ollama                             | 25–40%                      |
| `conservative`        | simple **and** no tools → Ollama            | 10–20%                      |
| `disabled`            | nothing                                     | 0% (pure passthrough)       |
| `privacy` (orthogonal flag) | same as picked mode, but **no cloud fallback ever** — returns 503 instead of leaking the prompt | — |

Local picks further upgrade `simple → code` tier when `looksCodeHeavy()`
detects fenced code in the last user turn — sending it to `qwen2.5-coder:7b`
instead of `llama3.2:3b`.

## 3.4 Reliability rails

```
   ┌─────────────────┐      ┌──────────────────────┐
   │ circuit-breaker │      │   prompt-cache       │
   │  per provider:  │      │  semantic similarity │
   │  closed/open/   │      │  threshold 0.92      │
   │  half-open      │      │  TTL 24 h            │
   │  (auto-recover) │      │  cache only on       │
   └─────────────────┘      │  confident=true      │
                            └──────────────────────┘
   ┌─────────────────┐      ┌──────────────────────┐
   │   confidence    │      │       stats          │
   │  inspect Ollama │      │  EXACTLY ONE row     │
   │  reply for low- │      │  per request even on │
   │  signal phrases │      │  fallback            │
   │  ("I don't      │      │  served at /stats    │
   │   know" etc.)   │      └──────────────────────┘
   └─────────────────┘
```

Hard invariants enforced in `fallback.js`:

1. Exactly one stats row per request — no double-billing on fallback.
2. Circuit-breaker recorded against the provider that was *actually* tried.
3. Streaming fallback only possible **before** the first chunk hits the wire.
4. Cache `set()` rejects responses that didn't pass the confidence check.
5. Privacy mode → cloud fallback is `null`, never even constructed.

## 3.5 Provider matrix

| Provider      | Direction      | Wire formats supported                                                         |
| ------------- | -------------- | ------------------------------------------------------------------------------ |
| **Ollama**    | local          | OpenAI-compat + native `/api/chat`, `/api/embeddings`                          |
| **Anthropic** | cloud upstream | `/v1/messages` (also accepts `/v1/messages?beta=…`)                            |
| **OpenAI**    | cloud upstream | `/v1/chat/completions`, `/v1/responses`, `/v1/completions`, `/v1/embeddings`   |

## 3.6 Benefits over §1 + §2 baseline

- **35–55% cloud-token savings** on typical coding traffic in `balanced` mode
  (higher in `aggressive`).
- **100% of embeddings** can stay local at zero billed tokens — directly
  feeding Layer 1's semantic search at no marginal cost.
- **Privacy mode** offers verifiable air-gap: any prompt that would touch the
  cloud returns 503 instead.
- **Wire-format compatible** — no client SDK changes; just
  `export ANTHROPIC_BASE_URL=http://localhost:8081`.
- **Resilient** — circuit breaker isolates provider outages; semantic prompt
  cache absorbs duplicate work; confidence check retries weak local answers.
- **Observable** — `/stats`, `/metrics`, `/healthz/ready` endpoints;
  per-request audit trail in `classification.reasons[]`.
- **Zero new npm deps** — reuses `better-sqlite3` and
  `@huggingface/transformers` already pulled in by `npm install`. Only external
  dependency is Ollama itself.

---

# 4. How the three layers compose

```
   ┌──────────────────────────────────────────────────────────────┐
   │                       User / Tool                            │
   └──────────────────────────────────────────────────────────────┘
            │                                   │
            │ "How does auth work in this        │ LLM call
            │  repo? Last decision on it?"       │ (chat / embed)
            ▼                                   ▼
   ┌──────────────────────────┐       ┌──────────────────────────┐
   │   project-memory MCP     │       │       AI Router :8081    │
   │   (§1)                   │       │   (§3) classify →        │
   │  get_context, memory_    │       │   local / cloud,         │
   │  search, code_context …  │       │   cache, breaker         │
   └──────────────────────────┘       └──────────────────────────┘
            │                                   │            │
            │ embed query for semantic search   │ embed      │ chat
            ▼                                   ▼            ▼
   ┌──────────────────────────┐       ┌──────────┐  ┌─────────────┐
   │     EmbeddingCache       │       │ Ollama   │  │ Anthropic / │
   │  ←─ TurboQuant (§2)      │       │ (local)  │  │ OpenAI      │
   │  (3-bit + QJL)           │       └──────────┘  └─────────────┘
   └──────────────────────────┘
```

A single "search this project for X" walk:

1. The tool calls `memory_search` → §1 returns hits in milliseconds (no LLM
   call at all). **Tokens saved: thousands.**
2. If a fresh embedding is needed, the embed request goes via §3 → Ollama
   serves it locally. **Cloud tokens for embed: zero.**
3. The embedding is stored in §2's quantized cache. **RAM for that vector:
   192 B instead of 1,536 B.**
4. If the user's follow-up needs a frontier-model reasoning step, §3 classifies
   it as complex and forwards to Anthropic/OpenAI **untouched**. **Quality
   preserved.**

## 4.1 Headline savings (cumulative)

| What                                            | Before any layer | After §1 only | After §1 + §2 | After §1 + §2 + §3 |
|-------------------------------------------------|------------------|---------------|---------------|--------------------|
| Daily session cold-start tokens                 | ~15,000          | ~1,500 (90% ↓)| ~1,500        | ~1,500             |
| RAM for embedding cache (5k entries)            | 7.5 MB           | 7.5 MB        | 0.95 MB (87% ↓)| 0.95 MB           |
| Cloud spend on embeddings                       | 100%             | 100%          | 100%          | ~0% (all local)    |
| Cloud spend on coding traffic (balanced mode)   | 100%             | 100%          | 100%          | 45–65% (35–55% ↓)  |
| New runtime deps added                          | —                | 0 (pure JS)   | 0             | 0 (Ollama optional)|

All three layers are **fail-open**: turning each off (don't load the plugin,
or `bitWidth=null`, or `router_mode=disabled`) returns the system to the
behaviour of the previous layer with no other changes required.

---

## See also

- [`README.md`](../README.md) — quickstart, prerequisites, install
- [`QUANTIZATION.md`](../QUANTIZATION.md) — TurboQuant configuration & tuning
- [`ROUTER.md`](../ROUTER.md) — AI Router setup, modes, and integration
- `scripts/turbo-quant.js`, `scripts/embedding-cache.js` — TurboQuant source
- `scripts/mcp-server.mjs`, `scripts/daemon.js`, `scripts/shared.js` — core memory
- `scripts/code-graph.js`, `scripts/code-parser.js` — SQLite/FTS5 + tree-sitter
- `scripts/embeddings.js`, `scripts/graph.js` — semantic search + knowledge graph
- `hooks/scripts/*.js` — proactive injection + auto-capture
- `router/` — AI Router (22 files)
