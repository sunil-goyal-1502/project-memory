# Project Memory

A Claude Code plugin that gives Claude **persistent memory across sessions** — decisions, research findings, reusable scripts, and auto-generated skills. Features a **global TCP daemon** for fast search (~10ms), **ONNX-powered semantic search**, a **knowledge graph**, **auto-skill generation** from repeated workflows, and a **real-time dashboard**.

## Key Features

### Single Global Daemon
- **One daemon serves ALL projects** — `Map<projectRoot, ProjectData>` with lazy loading
- TCP IPC from hooks: ~10ms round-trip (vs ~1500ms cold start per hook)
- Auto-starts on first session, lives at `~/.ai-memory-daemon-port`
- Per-project file watchers detect changes and reload in-memory indices

### Semantic Search (ONNX Embeddings)
- Local embeddings using `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers`
- 384-dimensional vectors, cosine similarity ranking
- Runs fully offline on CPU — no API keys, no cloud calls
- Graph expansion for multi-hop entity discovery

### Script Library with Full Template Injection
- Captures reusable multi-step scripts (curl pipelines, Python analysis, ADO API calls)
- **Full script templates injected** into Claude's context when a match is found
- Scripts surfaced for ALL Bash commands (not just exploratory), with directive messaging
- Parameterized templates with `{{build_id}}`, `{{resource_id}}`, etc.

### Auto-Skill Generation
- Detects recurring multi-step command chains from tool history
- Groups consecutive successful commands within 90-second temporal windows
- When a pattern appears 2+ times, suggests creating a `/slash-command` skill
- Generates complete `SKILL.md` with YAML frontmatter, step-by-step instructions, and parameters
- Skills immediately available as `/skill-name` in Claude Code

### Knowledge Graph
- Automatic triple extraction from research entries (entity relationships)
- Multi-hop graph expansion in hook searches
- Adjacency index for O(1) neighbor lookup

### Automatic Capture
- **Atomic fact decomposition** — each finding saved as a separate searchable entry
- **Entity indexing** — `--entities "DomService,FlaUI"` for targeted lookup
- **Exploration breadcrumbs** — every exploratory tool call logged automatically
- **Unsaved exploration detection** — session summary blocks until findings are saved
- **Retry-success detection** — captures scripts that worked after failures

### Cross-Tool Sync
- Generates instruction files for **Claude Code** (`CLAUDE.md`), **GitHub Copilot** (`.github/copilot-instructions.md`), and **Cursor** (`.cursor/rules/project-decisions.mdc`)
- Auto-synced on every save

### Dashboard
- Real-time web UI at `http://localhost:3777`
- Aggregates data across all projects
- Activity timeline, tag cloud, semantic search, session history

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and working
- Node.js >= 18
- Git

## Installation

### Quick Start

```bash
git clone https://github.com/sunil-goyal-1502/project-memory.git
cd project-memory
npm install
```

### Register the Plugin

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

### Register Hooks in Settings

Edit `~/.claude/settings.json` to register hooks with absolute paths (this is the recommended approach — avoids plugin cache path issues):

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

### Initialize Memory

In any project directory:
```bash
node /path/to/project-memory/scripts/save-decision.js "architecture" "Initial setup" "First decision"
```

This creates the `.ai-memory/` directory. Alternatively use `/project-memory:memory-init`.

### Restart Claude Code

Close and reopen Claude Code. You should see the session-start message with loaded decisions/research counts, and the daemon will auto-start.

## Verify Installation

```bash
# Check daemon is running
cat ~/.ai-memory-daemon-port  # Should show a port number

# Search memory
node scripts/check-memory.js "test query"

# Run tests (85 tests)
node scripts/test-e2e.js && node scripts/tests/test-runner.js

# Start dashboard
node scripts/dashboard.js --background
# Open http://localhost:3777
```

## Usage

### Slash Commands (Plugin Skills)

| Command | Description |
|---------|-------------|
| `/project-memory:memory-init` | Initialize `.ai-memory/` in the current project |
| `/project-memory:memory-save` | Save an explicit project decision |
| `/project-memory:memory-show` | Show all recorded decisions |
| `/project-memory:memory-sync` | Regenerate tool-specific files |
| `/project-memory:research-save` | Save a research finding |
| `/project-memory:research-search` | Search memory before investigating |

### Save Research

```bash
node scripts/save-research.js \
  "DomService uses XPathDocument for XPath evaluation" \
  "domservice,xpath,xml" \
  "DomService.ExecuteVerificationQueries uses XPathDocument at line 217" \
  stable \
  --entities "DomService,XPathDocument"
```

### Save Decisions

```bash
node scripts/save-decision.js \
  "architecture" \
  "Use ONNX embeddings for semantic search" \
  "Runs locally, no API dependency, 384-dim vectors"
```

### Search Memory

```bash
node scripts/check-memory.js "how does verification work"
```

### Generate Skills from Workflow Patterns

```bash
# List detected workflow candidates
node scripts/generate-skill.js --list

# Generate a skill from a candidate
node scripts/generate-skill.js wf_abc12345
```

### Daemon Management

```bash
# Stop daemon
node scripts/daemon.js --stop

# Daemon auto-starts on next session via session-start hook
# Or start manually:
node scripts/daemon.js
```

## Architecture

### Data Flow

```
Session Start
  ├─ session-start.js loads decisions + research into Claude's context
  ├─ Spawns global daemon (if not running) — single process for all projects
  ├─ Builds file-based caches as fallback
  └─ Registers session in ~/.ai-memory-sessions/{sessionId}

During Session (every tool call)
  ├─ pre-tool-use.js → TCP to daemon → BM25 search → inject findings + scripts
  │   ├─ Research findings with graph expansion
  │   ├─ Past explorations (markdown files)
  │   └─ Full script templates (copy-paste ready, no truncation)
  ├─ post-tool-use.js → TCP to daemon → save reminders + auto-capture
  │   ├─ Exploration breadcrumbs
  │   ├─ Retry-success script capture
  │   └─ Workflow chain detection (for auto-skill generation)
  └─ save-research.js → disk write → graph triples → background embeddings

Session End
  └─ session-summary.js checks for unsaved explorations
```

### Global Daemon Architecture

```
┌─────────────────────────────────────────┐
│  Global Daemon (TCP on localhost:PORT)   │
│  ~/.ai-memory-daemon-port               │
├─────────────────────────────────────────┤
│  projects Map<projectRoot, ProjectData> │
│  ├─ project-memory/                     │
│  │   ├─ research (BM25 index)           │
│  │   ├─ scripts (BM25 index)            │
│  │   ├─ graph (adjacency index)         │
│  │   └─ explorations                    │
│  ├─ AIHubServices/                      │
│  │   └─ (same per-project data)         │
│  └─ ... (lazy-loaded on first request)  │
├─────────────────────────────────────────┤
│  IPC: { type, projectRoot, input }      │
│  Response: { systemMessage } or {}      │
└─────────────────────────────────────────┘
```

### Directory Structure

```
project-memory/
├── .claude-plugin/plugin.json      # Plugin metadata
├── hooks/scripts/
│   ├── session-start.js            # Context loading, daemon start
│   ├── pre-tool-use.js             # TCP client → daemon search
│   ├── post-tool-use.js            # Auto-capture, chain detection
│   └── session-stop.js             # Session cleanup
├── scripts/
│   ├── daemon.js                   # Global TCP daemon (multi-project)
│   ├── shared.js                   # Core utilities, BM25, chain detection
│   ├── graph.js                    # Knowledge graph service
│   ├── generate-skill.js           # Workflow → SKILL.md generator
│   ├── check-memory.js             # Semantic search (ONNX embeddings)
│   ├── save-research.js            # Save findings with entities + graph
│   ├── save-decision.js            # Save decisions
│   ├── sync-tools.js               # Sync CLAUDE.md / Copilot / Cursor
│   ├── build-embeddings.js         # ONNX embedding builder
│   ├── dashboard.js                # Web dashboard
│   ├── session-summary.js          # End-of-session report
│   ├── test-e2e.js                 # E2E test suite (22 tests)
│   └── tests/                      # Unit tests (63 tests)
├── skills/                         # Plugin-defined slash commands
├── .ai-memory/                     # Per-project data (gitignored)
│   ├── research.jsonl              # Research findings
│   ├── decisions.jsonl             # Architecture decisions
│   ├── scripts.jsonl               # Reusable script templates
│   ├── graph.jsonl                 # Knowledge graph triples
│   ├── workflow-candidates.jsonl   # Detected workflow patterns
│   └── explorations/               # Auto-captured exploration outputs
├── CLAUDE.md                       # Auto-generated Claude instructions
└── .gitignore
```

## Auto-Generated Skills

The plugin can automatically detect and create Claude Code skills from your workflow patterns:

1. **Detection**: Post-tool-use hook tracks sequential command chains
2. **Fingerprinting**: Commands are parameterized and matched against existing patterns
3. **Suggestion**: When a pattern appears 2+ times: "Skill candidate detected — run generate-skill.js"
4. **Generation**: Creates `~/.claude/skills/<name>/SKILL.md` with full step-by-step instructions

Example auto-generated skill:
```yaml
---
name: analyze-ado-build
description: Download and analyze Azure DevOps build results
user-invocable: true
allowed-tools: Bash, Read, Grep
---

# Analyze ADO Build Results

## Step 1: Fetch build details
\```bash
TOKEN=$(az account get-access-token ...) && curl ...
\```

## Step 2: Get timeline
...
```

## Tests

```bash
# E2E tests (22 tests)
node scripts/test-e2e.js

# Unit tests (63 tests)
node scripts/tests/test-runner.js
```

## License

MIT
