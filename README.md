# Project Memory

A Claude Code plugin that gives Claude **persistent memory across sessions** and **structural code understanding**. Instead of re-reading 50+ files every session, Claude uses an MCP server with 11 on-demand tools, a SQLite code graph, and hybrid BM25 + ONNX search to answer questions in ~500 tokens instead of ~100K.

## The Problem: Token Waste in AI Coding Sessions

Every Claude Code session starts from scratch. Claude has no memory of what it learned yesterday. The typical workflow:

1. Claude reads 20-50 files to understand code structure (~50K-100K tokens)
2. You explain the same architecture decisions again (~2K tokens)
3. Claude re-discovers the same API quirks and workarounds (~5K tokens)
4. Repeat tomorrow

**Project Memory fixes this** by giving Claude a persistent knowledge layer that survives across sessions.

## Token Savings: Before vs After

### Example 1: "What files import shared.js?"

**Without Project Memory** (traditional approach):
```
Claude reads 18 files via Grep + Read tools
  grep -r "require.*shared" scripts/     →  800 tokens (results)
  Read scripts/daemon.js                 →  2,500 tokens
  Read scripts/mcp-server.mjs            →  3,200 tokens
  Read scripts/check-memory.js           →  1,800 tokens
  ... (15 more files)                    → ~35,000 tokens
  Total: ~45,000 tokens consumed
```

**With Project Memory** (one MCP call):
```
mcp__project-memory__code_impact qualified_name="scripts/shared.js"
  → "15 entities affected: daemon.js, check-memory.js, ..."
  Total: ~350 tokens consumed
```

**Savings: 99% fewer tokens** (45,000 → 350)

### Example 2: "How does the BM25 search work?"

**Without Project Memory**:
```
Claude searches for BM25 references across codebase
  Grep for "bm25" across all files       →  600 tokens
  Read shared.js (full file)             →  4,500 tokens
  Read daemon.js (to see how it's called) →  2,500 tokens
  Read mcp-server.mjs (integration)      →  3,200 tokens
  Total: ~11,000 tokens consumed
```

**With Project Memory** (search prior research):
```
mcp__project-memory__memory_search query="BM25 search"
  → Returns saved finding: "BM25 index built from research.jsonl..."
  Total: ~400 tokens consumed

mcp__project-memory__code_context qualified_name="shared.js::bm25Score"
  → Callers: daemon.js::bm25Search, mcp-server.mjs::handleMemorySearch
  → Signature: function bm25Score(query, index)
  Total: ~300 tokens consumed
```

**Savings: 93% fewer tokens** (11,000 → 700)

### Example 3: "We decided to use ONNX embeddings last week, why?"

**Without Project Memory**:
```
Claude has no memory. You re-explain the decision.
  User types explanation                  →  500 tokens
  Claude re-evaluates and asks questions →  2,000 tokens
  Total: ~2,500 tokens + your time
```

**With Project Memory** (instant recall):
```
mcp__project-memory__memory_search query="ONNX embeddings decision"
  → Decision: "Use ONNX MiniLM-L6 embeddings — @huggingface/transformers
     is a hard dependency. Runs locally, no API dependency."
  Total: ~200 tokens consumed
```

**Savings: 92% fewer tokens + zero re-explanation**

### Example 4: Reusing a script instead of rebuilding it

**Without Project Memory**:
```
User: "Fetch the ADO build timeline for build 12345"
Claude writes a new curl + jq script from scratch → 2,000 tokens
(same script was written 3 sessions ago)
```

**With Project Memory**:
```
mcp__project-memory__script_search query="ADO build timeline"
  → Returns parameterized template with {{build_id}} placeholder
  Claude fills in build_id=12345          → 300 tokens
```

**Savings: 85% fewer tokens + battle-tested script**

### Summary of Token Economics

| Scenario | Without | With | Savings |
|----------|---------|------|---------|
| Find importers of a module | ~45,000 | ~350 | 99% |
| Understand a function's role | ~11,000 | ~700 | 93% |
| Recall a past decision | ~2,500 | ~200 | 92% |
| Reuse a complex script | ~2,000 | ~300 | 85% |
| Start-of-session context load | ~50,000 | ~100 | 99.8% |

The `get_context` entry point returns ~100 tokens. Claude only escalates to deeper queries when needed, keeping most interactions lightweight.

## How It Works

Project Memory has two layers:

1. **MCP Server** (on-demand) -- 11 tools Claude calls explicitly for search, code structure, save, and session management. Context is injected only when Claude asks for it (~100-500 tokens per call).

2. **Hooks** (proactive) -- Lightweight enforcement that fires on every tool call: save reminders, escalation blocking, auto-capture of scripts/explorations, workflow chain detection, and code graph updates after file edits.

## Architecture

```
                          ┌──────────────────────────────────────────────────────────┐
                          │              Claude Code Session                         │
                          │                                                          │
                          │  User: "What imports shared.js?"                         │
                          │  Claude: calls code_impact(shared.js) → 15 files, 350tok │
                          └─────────┬────────────────────────┬───────────────────────┘
                                    │                        │
                     MCP calls (on-demand)          Hook calls (every tool)
                                    │                        │
                          ┌─────────▼────────────┐  ┌───────▼──────────────────────┐
                          │   MCP Server (stdio)  │  │   Hooks (thin IPC clients)   │
                          │   mcp-server.mjs      │  │                              │
                          │                       │  │  PreToolUse:                  │
                          │  MEMORY TOOLS         │  │   └─ Nudge: "use MCP tools"  │
                          │  ├─ get_context       │  │                              │
                          │  ├─ memory_search     │  │  PostToolUse:                │
                          │  ├─ script_search     │  │   ├─ Auto-capture scripts    │
                          │  ├─ memory_save       │  │   ├─ Workflow chain detect   │
                          │  ├─ session_summary   │  │   ├─ Save reminders          │
                          │  └─ graph_context     │  │   └─ Code graph update ──┐   │
                          │                       │  │      (after Write/Edit)  │   │
                          │  CODE TOOLS           │  │                          │   │
                          │  ├─ code_search (FTS5)│  │  SessionStart:           │   │
                          │  ├─ code_context      │  │   └─ Start daemon,       │   │
                          │  ├─ code_impact       │  │      register session    │   │
                          │  ├─ code_structure    │  └──────────────────────────┘   │
                          │  └─ list_skills       │                                 │
                          └─────────┬─────────────┘                                 │
                                    │ reads                                          │
                          ┌─────────▼──────────────────────────────────────────────┐ │
                          │                    Storage Layer                        │ │
                          │                                                        │ │
                          │  SQLite (code-graph.db)      JSONL Files               │ │
                          │  ├─ nodes (FTS5 indexed)     ├─ research.jsonl         │ │
                          │  ├─ edges (CALLS, IMPORTS,   ├─ decisions.jsonl        │ │
                          │  │   INHERITS, CONTAINS,     ├─ scripts.jsonl          │ │
                          │  │   TESTED_BY)              ├─ graph.jsonl            │ │
                          │  └─ WAL mode for concurrency └─ explorations/*.md      │ │
                          │                                                        │ │
                          └──────────────────────────┬─────────────────────────────┘ │
                                                     │ watched by                    │
                          ┌──────────────────────────▼─────────────────────────────┐ │
                          │           Global TCP Daemon (daemon.js)                 │ │
                          │                                                        │ │
                          │  ├─ In-memory BM25 index (rebuilt on file change)      │ │
                          │  ├─ ONNX embedding cache                               │ │
                          │  ├─ fs.watchFile on .ai-memory/*.jsonl metadata         │ │
                          │  ├─ fs.watch (recursive) on source files ◄─────────────┘ │
                          │  │   └─ Debounced incremental re-parse (500ms)           │
                          │  └─ Per-project data Map (serves multiple sessions)      │
                          │                                                          │
                          │  Port: ~/.ai-memory-daemon-port                          │
                          │  Auto-shutdown: 2hr inactivity                           │
                          └──────────────────────────────────────────────────────────┘
```

### Data Flow

```
Session Start
  ├─ session-start.js spawns global daemon (if not running)
  ├─ Registers session in ~/.ai-memory-sessions/{sessionId}
  └─ MCP server started by Claude Code via .mcp.json

During Session
  ├─ Claude calls MCP tools on-demand for search/save/code queries
  │   └─ MCP server reads SQLite code graph + JSONL memory files
  ├─ pre-tool-use.js → nudge to use MCP tools before file exploration
  ├─ post-tool-use.js → TCP to daemon
  │   ├─ Code graph update (after Write/Edit — re-parses changed file)
  │   ├─ Auto-capture of reusable scripts
  │   ├─ Workflow chain detection for skill generation
  │   ├─ Exploration breadcrumbs
  │   └─ Save reminders with escalation
  ├─ Source file watcher → auto re-parses on external edits (VS Code, git pull)
  └─ memory_save → disk write → graph triples → sync CLAUDE.md

Session End
  └─ session_summary checks for unsaved explorations
```

## Key Features

### MCP Tools (11 on-demand tools)

| Tool | Category | Description | Typical Response |
|------|----------|-------------|------------------|
| `get_context` | Entry | Project memory overview -- stats, suggestions | ~100 tokens |
| `memory_search` | Memory | BM25 + ONNX search over research findings and decisions | ~200-500 tokens |
| `script_search` | Memory | Find reusable script templates with `{{params}}` | ~200-500 tokens |
| `memory_save` | Memory | Save research finding or project decision | ~50 tokens |
| `session_summary` | Memory | End-of-session report with pending save detection | ~150 tokens |
| `graph_context` | Memory | Knowledge graph entity relationship traversal | ~200 tokens |
| `code_search` | Code | FTS5 search over function names, classes, imports | ~100-300 tokens |
| `code_context` | Code | Callers, callees, members, tests for any entity | ~200-500 tokens |
| `code_impact` | Code | Blast radius: what breaks if entity X changes | ~200-400 tokens |
| `code_structure` | Code | Module or class hierarchy overview | ~200-500 tokens |
| `list_skills` | Skills | Show detected workflow candidates and created skills | ~200 tokens |

Every response includes `_hints.next_steps` guiding Claude to the right follow-up tool.

### Code Graph (SQLite + tree-sitter)

Parses your codebase into a searchable graph of functions, classes, and their relationships:

- **Languages**: C#, Python, JavaScript, TypeScript (via `@vscode/tree-sitter-wasm` -- no native compilation)
- **Storage**: SQLite with WAL mode + FTS5 full-text search
- **Speed**: ~0.3s to index 40 files, ~5ms per FTS5 query
- **Entities**: File, Class, Interface, Function, Method, Property, Constructor, Type
- **Relationships**: CALLS, IMPORTS, INHERITS, CONTAINS, TESTED_BY
- **Incremental updates**: PostToolUse hook re-parses files after Write/Edit automatically
- **Source file watching**: Daemon watches the project directory with `fs.watch(recursive)` and auto-re-parses files changed externally (VS Code edits, `git pull`, etc.) with 500ms debounce
- **Import resolution**: `require()` and ES `import` paths are resolved to absolute file paths, including `require(path.join(__dirname, "foo.js"))` patterns

### Hooks (lightweight enforcement)

Hooks are thin IPC clients that connect to a global TCP daemon:

- **PreToolUse**: Nudges Claude to use MCP tools before file exploration. Blocks if save reminders are ignored.
- **PostToolUse**: Auto-captures scripts, tracks workflow chains, logs breadcrumbs, triggers code graph updates, enforces save reminders after research tools.
- **SessionStart**: Loads context, starts daemon, registers session.

### Persistent Memory

- **Research findings** -- atomic facts saved to `research.jsonl`, searchable by BM25 + ONNX embeddings
- **Project decisions** -- architecture, constraints, conventions in `decisions.jsonl`
- **Script library** -- parameterized templates in `scripts.jsonl` with `{{build_id}}`, `{{resource_id}}` placeholders
- **Knowledge graph** -- entity relationship triples in `graph.jsonl`
- **Explorations** -- full agent output captured as markdown in `explorations/`

### Auto-Skill Generation

- Detects recurring multi-step command chains from tool history
- When a pattern appears 2+ times, suggests creating a `/slash-command` skill
- Generates complete `SKILL.md` with parameters and step-by-step instructions

### Cross-Tool Sync

Generates instruction files for **Claude Code** (`CLAUDE.md`), **GitHub Copilot** (`.github/copilot-instructions.md`), and **Cursor** (`.cursor/rules/project-decisions.mdc`) -- auto-synced on every save.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and working
- Node.js >= 18
- Git

## Installation

### Step 1: Clone and Install

```bash
git clone https://github.com/sunil-goyal-1502/project-memory.git
cd project-memory
npm install
```

This installs:
- `@modelcontextprotocol/sdk` -- MCP server framework
- `better-sqlite3` -- SQLite for code graph (prebuilt binaries, no compilation)
- `web-tree-sitter` + `@vscode/tree-sitter-wasm` -- AST parsing (WASM, no native build)
- `@huggingface/transformers` -- ONNX embeddings for semantic search

**No native compilation required** -- all dependencies use prebuilt binaries or WASM.

### Step 2: Register the Plugin

Edit `~/.claude/plugins/installed_plugins.json`:

```json
{
  "plugins": {
    "project-memory@project-memory-marketplace": [{
      "scope": "user",
      "installPath": "/absolute/path/to/project-memory",
      "version": "1.0.0",
      "installedAt": "2025-01-01T00:00:00.000Z"
    }]
  }
}
```

Set `installPath` to the **absolute path** where you cloned the repo.

### Step 3: Register Hooks in Settings

Edit `~/.claude/settings.json` to register hooks with absolute paths:

```json
{
  "hooks": {
    "SessionStart": [{
      "type": "command",
      "command": "node \"/path/to/project-memory/hooks/scripts/session-start.js\""
    }],
    "PreToolUse": [{
      "type": "command",
      "command": "node \"/path/to/project-memory/hooks/scripts/pre-tool-use.js\""
    }],
    "PostToolUse": [{
      "type": "command",
      "command": "node \"/path/to/project-memory/hooks/scripts/post-tool-use.js\""
    }]
  },
  "enabledPlugins": {
    "project-memory@project-memory-marketplace": true
  }
}
```

**Important**: Use absolute paths in hooks, not relative. This avoids plugin cache path issues -- hooks registered in `settings.json` bypass the `CLAUDE_PLUGIN_ROOT` entirely.

### Step 4: Register MCP Server

The `.mcp.json` file at the repo root auto-registers the MCP server when Claude Code opens a session in this directory. For **other projects**, either:

**Option A**: Copy `.mcp.json` to the other project root:
```json
{
  "mcpServers": {
    "project-memory": {
      "command": "node",
      "args": ["/absolute/path/to/project-memory/scripts/mcp-server.mjs"]
    }
  }
}
```

**Option B**: Add to `~/.claude/settings.json` for global registration:
```json
{
  "mcpServers": {
    "project-memory": {
      "command": "node",
      "args": ["/absolute/path/to/project-memory/scripts/mcp-server.mjs"]
    }
  }
}
```

### Step 5: Initialize Memory

In any project directory:
```bash
node /path/to/project-memory/scripts/save-decision.js "architecture" "Initial setup" "First decision"
```

This creates the `.ai-memory/` directory. Alternatively use `/project-memory:memory-init`.

### Step 6: Build Code Graph (optional but recommended)

```bash
# Index the current project's source files
node /path/to/project-memory/scripts/build-code-graph.js /path/to/your/project

# Or from the project directory:
node /path/to/project-memory/scripts/build-code-graph.js .

# Incremental update (only re-parse files changed since last git commit):
node /path/to/project-memory/scripts/build-code-graph.js /path/to/project --diff

# Show stats without rebuilding:
node /path/to/project-memory/scripts/build-code-graph.js /path/to/project --stats
```

The code graph is stored in `.ai-memory/code-graph.db` and automatically updated:
- **PostToolUse hook**: Re-parses files after Claude's Write/Edit operations
- **Source file watcher**: Daemon detects external edits (VS Code, git pull) via `fs.watch(recursive)` and re-parses with 500ms debounce

### Step 7: Restart Claude Code

Close and reopen Claude Code. You should see:
- Session-start message with loaded decisions/research counts
- 11 MCP tools available as `mcp__project-memory__*`
- The daemon auto-started

## Verify Installation

```bash
# Check daemon is running
cat ~/.ai-memory-daemon-port  # Should show a port number

# Check code graph
node scripts/build-code-graph.js . --stats

# Search memory
node scripts/check-memory.js "test query"

# Test MCP server (should return JSON with tools list)
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node scripts/mcp-server.mjs

# Run tests (63 unit + 22 E2E)
node scripts/tests/test-runner.js && node scripts/test-e2e.js

# Start dashboard
node scripts/dashboard.js --background
# Open http://localhost:3777
```

## Usage

### MCP Tools (primary interface)

Claude automatically calls these tools when instructed by CLAUDE.md. You can also invoke them directly:

```
# Start any task -- get memory overview (~100 tokens)
mcp__project-memory__get_context

# Search prior research before re-investigating
mcp__project-memory__memory_search query="how does authentication work"

# Find a reusable script template
mcp__project-memory__script_search query="ADO build timeline"

# Understand code structure (instead of reading 20 files)
mcp__project-memory__code_search query="TestOrchestrator"
mcp__project-memory__code_context qualified_name="Namespace.TestOrchestrator.Execute"
mcp__project-memory__code_impact qualified_name="AppiumToolHandler.HandleClick"
mcp__project-memory__code_structure target="src/services" type="module"

# Save discoveries
mcp__project-memory__memory_save type="research" topic="API returns 429 on burst" content="Rate limit is 10 req/s" tags="api,rate-limit"
mcp__project-memory__memory_save type="decision" topic="Use Redis for caching" content="In-memory too volatile" category="architecture"

# End session
mcp__project-memory__session_summary
```

### CLI Scripts (fallback / manual use)

```bash
# Save research
node scripts/save-research.js \
  "DomService uses XPathDocument" \
  "domservice,xpath,xml" \
  "DomService.ExecuteVerificationQueries uses XPathDocument at line 217" \
  stable \
  --entities "DomService,XPathDocument"

# Save decisions
node scripts/save-decision.js \
  "architecture" \
  "Use ONNX embeddings for semantic search" \
  "Runs locally, no API dependency"

# Search memory
node scripts/check-memory.js "how does verification work"

# Build code graph
node scripts/build-code-graph.js /path/to/project
node scripts/build-code-graph.js /path/to/project --diff    # incremental
node scripts/build-code-graph.js /path/to/project --stats   # show stats

# Session summary
node scripts/session-summary.js

# Generate skills from workflow patterns
node scripts/generate-skill.js --list
node scripts/generate-skill.js wf_abc12345
```

### Slash Commands (Plugin Skills)

| Command | Description |
|---------|-------------|
| `/project-memory:memory-init` | Initialize `.ai-memory/` in the current project |
| `/project-memory:memory-save` | Save an explicit project decision |
| `/project-memory:memory-show` | Show all recorded decisions |
| `/project-memory:memory-sync` | Regenerate tool-specific files |
| `/project-memory:research-save` | Save a research finding |
| `/project-memory:research-search` | Search memory before investigating |
| `/project-memory:research-compact` | Condense and clean up research memory |
| `/project-memory:memory-analytics` | Analyze data quality |

### Daemon Management

```bash
# Stop daemon
node scripts/daemon.js --stop

# Daemon auto-starts on next session via session-start hook
# Or start manually:
node scripts/daemon.js
```

## Directory Structure

```
project-memory/
├── .mcp.json                      # MCP server registration
├── .claude-plugin/plugin.json     # Plugin metadata
├── hooks/scripts/
│   ├── session-start.js           # Context loading, daemon start
│   ├── pre-tool-use.js            # Thin IPC client -> nudge only
│   ├── post-tool-use.js           # Auto-capture, code graph update
│   └── session-stop.js            # Session cleanup
├── scripts/
│   ├── mcp-server.mjs             # MCP server (11 tools, stdio transport)
│   ├── daemon.js                  # Global TCP daemon (in-memory indexes + source watcher)
│   ├── shared.js                  # Core utilities, BM25, hints
│   ├── code-graph.js              # SQLite code graph store (FTS5, impact analysis)
│   ├── code-parser.js             # Tree-sitter WASM AST parser (require + import resolution)
│   ├── build-code-graph.js        # Full/incremental code graph build
│   ├── graph.js                   # Knowledge graph service
│   ├── generate-skill.js          # Workflow -> SKILL.md generator
│   ├── check-memory.js            # BM25 + semantic search CLI
│   ├── save-research.js           # Save findings with entities
│   ├── save-decision.js           # Save decisions
│   ├── sync-tools.js              # Sync CLAUDE.md / Copilot / Cursor
│   ├── session-summary.js         # End-of-session report
│   ├── dashboard.js               # Web dashboard (http://localhost:3777)
│   ├── test-e2e.js                # E2E test suite (22 tests)
│   └── tests/                     # Unit tests (63 tests)
├── skills/                        # Plugin-defined slash commands
├── .ai-memory/                    # Per-project data (gitignored)
│   ├── research.jsonl             # Research findings (BM25 + ONNX indexed)
│   ├── decisions.jsonl            # Architecture decisions
│   ├── scripts.jsonl              # Reusable script templates
│   ├── graph.jsonl                # Knowledge graph triples
│   ├── code-graph.db              # SQLite code graph (FTS5 + WAL)
│   ├── workflow-candidates.jsonl  # Detected workflow patterns
│   └── explorations/              # Auto-captured exploration outputs
├── CLAUDE.md                      # Auto-generated MCP tool directory
└── package.json
```

## Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `@modelcontextprotocol/sdk` | MCP server framework (stdio transport) | ~200KB |
| `better-sqlite3` | SQLite for code graph (prebuilt binaries) | ~8MB |
| `web-tree-sitter` | Tree-sitter WASM runtime | ~500KB |
| `@vscode/tree-sitter-wasm` | Prebuilt WASM parsers (C#, Python, JS, TS) | ~4MB |
| `@huggingface/transformers` | ONNX embeddings for semantic search | ~50MB |

All dependencies use prebuilt binaries or WASM -- **no native compilation required** (no node-gyp, no Visual Studio).

## Tests

```bash
# Unit tests (63 tests -- BM25, breadcrumbs, auto-capture, graph, entity index, etc.)
node scripts/tests/test-runner.js

# E2E tests (22 tests -- save/search/graph/session pipeline)
node scripts/test-e2e.js

# Both
node scripts/tests/test-runner.js && node scripts/test-e2e.js
```

## Recent Changes

### Code Graph: require() IMPORTS Resolution
- `require("./foo")` and `require(path.join(__dirname, "foo.js"))` are now captured as IMPORTS edges with resolved absolute paths
- ES module `import` statements also get path resolution
- `code_impact` now traces IMPORTS edges (in addition to CALLS and INHERITS), so `code_impact("shared.js")` shows all 15 files that import it
- Result: 129 IMPORTS edges captured (was 4 before the fix)

### Daemon: Source File Watching
- The daemon now watches the project source directory using `fs.watch(recursive: true)` for OS-native file events
- External edits (VS Code, `git pull`, branch switch) trigger automatic incremental re-parse
- 500ms debounce per file to coalesce rapid saves
- Filters by supported extensions, skips `node_modules/.git/dist/build/etc.`
- Tree-sitter is lazy-initialized on first file change

## License

MIT
