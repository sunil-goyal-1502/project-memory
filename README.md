# Project Memory

A Claude Code plugin that captures project decisions and research findings across sessions, with **ONNX-powered semantic search**, a **real-time global dashboard**, and **automatic embedding generation** — all running locally with zero API dependencies.

## Key Features

### Semantic Search (ONNX Embeddings)
- Local embeddings using `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers`
- 384-dimensional vectors, cosine similarity ranking
- Runs fully offline on CPU — no API keys, no cloud calls
- Entries ranked by semantic relevance with percentage scores

### Global Dashboard
- Real-time web UI at `http://localhost:3777`
- Aggregates data across **all projects** with `.ai-memory` directories
- Activity timeline, tag cloud, research heatmap (project × tag)
- Semantic search bar powered by embeddings
- Clickable projects with per-project filtering and pagination
- Auto-starts on session start, persists across sessions

### Automatic Capture
- **Atomic fact decomposition** — saves each fact as a separate searchable entry
- **Entity indexing** — `--entities "DomService,FlaUI"` for O(1) lookup
- **Exploration breadcrumbs** — every exploratory tool call is logged automatically
- **Unsaved exploration detection** — session summary blocks until findings are saved
- **Dedup warnings** — alerts on similar entries without blocking saves

### Auto-Embedding
- Background file watcher monitors all projects every 5 seconds
- New entries auto-embedded within ~8 seconds of save
- Triggered on session start (`--all` flag) and after every save
- Per-project `embeddings.json` storage

### Cross-Tool Sync
- Generates instruction files for **Claude Code** (`CLAUDE.md`), **GitHub Copilot** (`.github/copilot-instructions.md`), and **Cursor** (`.cursor/rules/project-decisions.mdc`)
- Auto-synced on every save

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and working
- Node.js >= 18
- Git

## Installation

### Step 1: Clone the repository

```bash
git clone https://github.com/sungoyal_microsoft/project-memory.git
cd project-memory
```

### Step 2: Install dependencies

```bash
npm install
```

This installs `@huggingface/transformers` and `onnxruntime-node` (~270MB). The ONNX model (~22MB) downloads automatically on first use.

### Step 3: Register the plugin with Claude Code

Edit `~/.claude/plugins/installed_plugins.json` and add the plugin entry. If the file doesn't exist, create it.

**Windows:**
```json
{
  "version": 2,
  "plugins": {
    "project-memory@sungoyal-plugins": [
      {
        "scope": "user",
        "installPath": "C:\\Users\\YOUR_USERNAME\\project-memory",
        "version": "1.0.0",
        "installedAt": "2025-01-01T00:00:00.000Z",
        "lastUpdated": "2025-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

**macOS / Linux:**
```json
{
  "version": 2,
  "plugins": {
    "project-memory@sungoyal-plugins": [
      {
        "scope": "user",
        "installPath": "/Users/YOUR_USERNAME/project-memory",
        "version": "1.0.0",
        "installedAt": "2025-01-01T00:00:00.000Z",
        "lastUpdated": "2025-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

> **Important:** Set `installPath` to the **absolute path** where you cloned the repository. This points Claude Code directly to the source — changes to the source take effect immediately.

If `installed_plugins.json` already has other plugins, add the `"project-memory@sungoyal-plugins"` entry inside the existing `"plugins"` object.

### Step 4: Restart Claude Code

Close and reopen Claude Code (or start a new session). The plugin hooks will load automatically.

### Step 5: Initialize memory in your project

Open Claude Code in any project directory and run:

```
/project-memory:memory-init
```

This creates the `.ai-memory/` directory with the required files.

### Step 6: Build initial embeddings

```bash
# Embed entries for the current project
node /path/to/project-memory/scripts/build-embeddings.js

# Or embed all projects globally
node /path/to/project-memory/scripts/build-embeddings.js --all
```

First run downloads the ONNX model (~22MB). Subsequent runs are fast (~50ms per entry).

## Verify Installation

After restarting Claude Code, verify the plugin is working:

1. **Check session start message** — You should see `[project-memory] Loaded: X decisions, Y research` at the start of every session.

2. **Test memory search:**
   ```bash
   node /path/to/project-memory/scripts/check-memory.js "test query"
   ```
   You should see entries ranked by semantic similarity with relevance percentages.

3. **Start the dashboard:**
   ```bash
   node /path/to/project-memory/scripts/dashboard.js
   ```
   Opens `http://localhost:3777` in your browser.

4. **Run tests:**
   ```bash
   node /path/to/project-memory/scripts/tests/test-runner.js
   ```
   All 39 tests should pass.

## Dashboard

The dashboard provides a global view of all project memory across your machine.

### Starting the Dashboard

```bash
# Foreground (opens browser)
node scripts/dashboard.js

# Background (persistent, survives sessions)
node scripts/dashboard.js --background

# Custom port
node scripts/dashboard.js 8080

# Check status
node scripts/dashboard.js --status

# Stop
node scripts/dashboard.js --stop
```

The dashboard auto-starts on every Claude Code session via the `session-start.js` hook.

### Dashboard Features

| Section | Description |
|---------|-------------|
| **Stats Cards** | Research count, decisions, tokens saved, time saved, hit rate, projects, embedding coverage |
| **Activity Timeline** | Bar chart of research + decisions saved per day across all sessions |
| **Top Tags** | Tag cloud with frequency counts |
| **Research Heatmap** | Project × tag matrix showing research density (color-coded) |
| **Embedding Coverage** | Progress bar showing % of entries with embeddings |
| **Research Tab** | All research entries, paginated (10/page), sorted by creation time, with project badges |
| **Decisions Tab** | All decisions with category, rationale, project badge |
| **Projects Tab** | Per-project breakdown — click to filter entries |
| **Explorations Tab** | Current session breadcrumb log (unsaved highlighted) |
| **Sessions Tab** | Session start/end history with save counts |
| **Semantic Search** | Search bar queries all entries via ONNX embeddings, ranked by relevance % |

## Directory Structure

```
project-memory/
├── .claude-plugin/
│   ├── plugin.json              # Plugin metadata (v1.0.0)
│   └── marketplace.json         # Marketplace registry
├── hooks/
│   ├── hooks.json               # Hook definitions
│   └── scripts/
│       ├── session-start.js     # Load context, start dashboard, build embeddings
│       ├── pre-tool-use.js      # Gate exploratory tools until memory checked
│       ├── post-tool-use.js     # Save reminders + breadcrumb logging
│       └── session-stop.js      # Condense transcript, record session end
├── scripts/
│   ├── shared.js                # DRY utilities (readJsonl, tokenize, BM25, entity index)
│   ├── embeddings.js            # ONNX embedding service (MiniLM-L6-v2)
│   ├── build-embeddings.js      # Batch embedding builder (--all for global)
│   ├── dashboard.js             # Persistent web dashboard with file watcher
│   ├── check-memory.js          # Semantic memory search
│   ├── save-research.js         # Save research with --entities, --related, dedup
│   ├── save-decision.js         # Save decisions with auto-embed
│   ├── session-summary.js       # Session stats + unsaved exploration detection
│   ├── check-coverage.js        # Check embedding coverage
│   ├── recompute-stats.js       # Recalculate metrics from actual data
│   ├── sync-tools.js            # Regenerate CLAUDE.md / Copilot / Cursor files
│   ├── condense-transcript.js   # Transcript condensation
│   ├── stats.js                 # Usage statistics (hit-rate based)
│   └── tests/
│       ├── test-runner.js       # Test harness (39 tests)
│       ├── test-shared-core.js  # Tokenize, JSONL, dedup tests
│       ├── test-entity-index.js # Entity index CRUD tests
│       ├── test-bm25.js         # BM25 scoring tests
│       ├── test-breadcrumbs.js  # Exploration log tests
│       └── test-save-research.js # Save with entities/dedup tests
├── skills/                      # 11 slash commands
├── agents/                      # Extraction agent prompts
├── cli/                         # Standalone CLI
├── package.json                 # @huggingface/transformers dependency
└── node_modules/                # (gitignored)
```

## Usage

### Slash Commands

| Command | Description |
|---------|-------------|
| `/project-memory:memory-init` | Initialize `.ai-memory/` in the current project |
| `/project-memory:memory-save` | Save an explicit project decision |
| `/project-memory:memory-show` | Show all recorded decisions |
| `/project-memory:memory-sync` | Regenerate tool-specific files |
| `/project-memory:memory-compact` | Deduplicate and merge decisions |
| `/project-memory:memory-extract` | Extract decisions from previous session |
| `/project-memory:research-save` | Save a research finding |
| `/project-memory:research-show` | Show all research findings |
| `/project-memory:research-search` | Search memory before investigating |
| `/project-memory:research-compact` | Clean up research entries |
| `/project-memory:research-extract` | Extract research from previous session |

### Save Research (with entities)

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

Returns entries ranked by semantic similarity:
```
1. [FRESH] Windows verification pipeline... | Relevance: 35.5%
2. [FRESH] AIAssistedTestAutomation local tool... | Relevance: 30.3%
```

### Build Embeddings

```bash
# Single project
node scripts/build-embeddings.js

# All projects globally
node scripts/build-embeddings.js --all
```

## How It Works

### Data Flow

```
Session Start
  ├─ session-start.js loads decisions + research into Claude's context
  ├─ Spawns build-embeddings.js --all (background, global)
  ├─ Spawns dashboard.js --background (if not already running)
  ├─ Records session-start event to session-history.jsonl
  └─ Clears exploration breadcrumb log

During Session
  ├─ pre-tool-use.js gates exploratory tools until memory is checked
  ├─ Claude saves research/decisions via scripts (atomic facts)
  ├─ post-tool-use.js logs exploration breadcrumbs + save reminders
  ├─ save-research.js auto-triggers embedding build (background)
  ├─ Dashboard file watcher detects changes, auto-embeds within 8s
  └─ sync-tools.js propagates changes to Copilot/Cursor/CLAUDE.md

Session End
  ├─ session-stop.js condenses transcript → .last-session.txt
  └─ Records session-end event with save counts

Dashboard (persistent background process)
  ├─ Aggregates all projects with .ai-memory (scans 5 levels deep)
  ├─ Polls files every 5s, auto-embeds new entries
  ├─ Serves real-time UI at localhost:3777
  └─ Semantic search API at /api/search?q=query
```

### Storage Format

**research.jsonl** (one entry per line):
```json
{"id":"e5f6a7b8","ts":"2025-01-16T14:00:00Z","topic":"DomService uses XPathDocument","tags":["domservice","xpath"],"finding":"ExecuteVerificationQueries uses XPathDocument at line 217","entities":["domservice","xpathdocument"],"related_to":[],"confidence":0.8,"staleness":"stable"}
```

**decisions.jsonl**:
```json
{"id":"a1b2c3d4","ts":"2025-01-15T10:30:00Z","category":"architecture","decision":"Use ONNX embeddings","rationale":"Local, no API dependency","confidence":1.0}
```

**embeddings.json** (per-project, gitignored):
```json
{"entry-id-1": [0.123, -0.456, ...384 floats...], "entry-id-2": [...]}
```

### Metrics Calculation

Savings are computed based on **actual memory hits**, not inflated load counts:

| Event | Tokens | Time | When Counted |
|-------|--------|------|-------------|
| Session load (research) | 20/entry | 5s/entry | Every session start |
| Session load (decision) | 10/entry | 2s/entry | Every session start |
| Memory check hit | 500/hit | 60s/hit | Only entries >20% semantic similarity |
| Search hit | 1000/hit | 120s/hit | Actual research reuse |

## Uninstalling

1. Remove the plugin registration:
   ```bash
   # Edit ~/.claude/plugins/installed_plugins.json
   # Remove the "project-memory@sungoyal-plugins" entry
   ```

2. Optionally remove generated files from your projects:
   ```bash
   rm -rf .ai-memory/
   rm .github/copilot-instructions.md
   rm .cursor/rules/project-decisions.mdc
   # Remove project-memory sections from CLAUDE.md between marker comments
   ```

3. Stop the dashboard:
   ```bash
   node /path/to/project-memory/scripts/dashboard.js --stop
   ```

## License

MIT
