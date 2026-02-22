# project-memory

A Claude Code plugin that automatically captures project decisions and research findings across sessions, syncing context to Claude Code, GitHub Copilot, and Cursor.

## Features

- **Decision capture** — Records architectural decisions, constraints, conventions, and scope boundaries
- **Research memory** — Saves API behaviors, library quirks, error root causes, and workarounds with staleness tracking
- **Cross-tool sync** — Generates instruction files for Claude Code (`CLAUDE.md`), GitHub Copilot (`.github/copilot-instructions.md`), and Cursor (`.cursor/rules/project-decisions.mdc`)
- **Session continuity** — Loads all saved context at session start so knowledge persists across sessions
- **Auto-save reminders** — PostToolUse hook nudges Claude to save findings after research-indicative tool calls (throttled to once every 3 minutes)
- **Transcript extraction** — Condenses and extracts decisions/research from previous session transcripts
- **Memory compaction** — Deduplicates and merges related entries to keep context lean

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and working
- Node.js >= 18

## Installation

### 1. Copy the plugin to your plugins directory

Copy the `project-memory` folder into your Claude Code plugins cache:

```bash
# Windows
mkdir -p "%APPDATA%\.claude\plugins\cache\sungoyal-plugins"
cp -r project-memory "%APPDATA%\.claude\plugins\cache\sungoyal-plugins\project-memory\0.4.1"

# macOS / Linux
mkdir -p ~/.claude/plugins/cache/sungoyal-plugins
cp -r project-memory ~/.claude/plugins/cache/sungoyal-plugins/project-memory/0.4.1
```

The directory version (`0.4.1`) must match the version in `.claude-plugin/plugin.json`.

### 2. Register the plugin marketplace

Create or update `~/.claude/plugins/cache/sungoyal-plugins/project-memory/.claude-plugin/marketplace.json` to point to the plugin. This file is already included in the repository.

### 3. Initialize memory in your project

Open Claude Code in your project directory and run:

```
/project-memory:memory-init
```

This creates:
- `.ai-memory/decisions.jsonl` — Canonical decision store
- `.ai-memory/research.jsonl` — Canonical research store
- `.ai-memory/metadata.json` — Sync and stats metadata
- `.ai-memory/.gitignore` — Excludes ephemeral transcript data
- `.github/copilot-instructions.md` — Copilot instructions (auto-generated)
- `.cursor/rules/project-decisions.mdc` — Cursor rules (auto-generated)
- `CLAUDE.md` — Claude Code instructions (auto-generated or updated between markers)

### 4. Add `.ai-memory/` to version control

```bash
git add .ai-memory/
git commit -m "Initialize project memory"
```

This lets the team share decisions and research findings.

## Directory Structure

```
project-memory/
  .claude-plugin/
    plugin.json              # Plugin metadata and version
    marketplace.json         # Marketplace registry
  agents/
    decision-extractor.md    # Decision extraction agent prompt
    research-extractor.md    # Research extraction agent prompt
  cli/
    index.js                 # Standalone CLI (npx project-memory ...)
  hooks/
    hooks.json               # Hook definitions (SessionStart, PostToolUse, Stop)
    scripts/
      session-start.js       # Loads decisions/research at session start
      post-tool-use.js       # Auto-save reminder after research tool calls
      session-stop.js        # Condenses transcript on session end
  scripts/
    save-decision.js         # Save a decision via Bash
    save-research.js         # Save a research finding via Bash
    check-memory.js          # Search memory before investigating
    sync-tools.js            # Regenerate all tool-specific files
    condense-transcript.js   # Transcript condensation logic
    stats.js                 # Usage statistics and savings tracking
  skills/
    memory-init/             # /project-memory:memory-init
    memory-save/             # /project-memory:memory-save
    memory-show/             # /project-memory:memory-show
    memory-sync/             # /project-memory:memory-sync
    memory-compact/          # /project-memory:memory-compact
    memory-extract/          # /project-memory:memory-extract
    research-save/           # /project-memory:research-save
    research-show/           # /project-memory:research-show
    research-search/         # /project-memory:research-search
    research-compact/        # /project-memory:research-compact
    research-extract/        # /project-memory:research-extract
```

## Usage

### Slash Commands

All commands are available as Claude Code slash commands:

| Command | Description |
|---------|-------------|
| `/project-memory:memory-init` | Initialize `.ai-memory/` in the current project |
| `/project-memory:memory-save <text>` | Save an explicit project decision |
| `/project-memory:memory-show` | Show all recorded decisions grouped by category |
| `/project-memory:memory-sync` | Regenerate tool-specific files from the canonical store |
| `/project-memory:memory-compact` | Deduplicate and merge related decisions |
| `/project-memory:memory-extract` | Extract decisions from previous session transcript |
| `/project-memory:research-save <finding>` | Save a research finding |
| `/project-memory:research-show` | Show all research findings |
| `/project-memory:research-search <query>` | Search research memory for existing findings |
| `/project-memory:research-compact` | Condense and clean up research entries |
| `/project-memory:research-extract` | Extract research from previous session transcript |

### CLI

A standalone CLI is also available:

```bash
npx project-memory init                      # Initialize .ai-memory/
npx project-memory save "Use PostgreSQL"     # Save a decision
npx project-memory show                      # Show decisions
npx project-memory sync                      # Regenerate tool files
npx project-memory research-save "<finding>" # Save research
npx project-memory research-show             # Show research
```

### Automatic Behavior

The plugin works automatically through three hooks:

1. **SessionStart** — Loads all decisions and research into Claude's context at the start of every session. Also triggers auto-extraction of the previous session's transcript if pending.

2. **PostToolUse** — After research-indicative tool calls (`Bash`, `WebFetch`, `WebSearch`, `Task`), injects a brief reminder into Claude's context to save any discovered decisions or research. Throttled to max once every 3 minutes. Skips self-calls (when Claude is already running save-decision, save-research, or check-memory scripts).

3. **Stop** — Condenses the session transcript and saves it to `.ai-memory/.last-session.txt` for extraction at the next session start.

### Decision Categories

When saving decisions, use one of these categories:

| Category | Examples |
|----------|----------|
| `architecture` | Tech stack choices, API design patterns, database selection |
| `constraint` | "Must support IE11", "Can't use GPL libraries" |
| `convention` | Naming conventions, code style rules, file structure |
| `testing` | Testing strategy, coverage requirements |
| `scope` | "X is out of scope", "MVP excludes Y" |
| `unresolved` | Open questions, deferred decisions |

### Research Staleness

Research findings are classified by how quickly they may become outdated:

| Staleness | When to Use | Examples |
|-----------|-------------|----------|
| `stable` | Won't change | Language behavior, protocol specs, math |
| `versioned` | Tied to a specific version | Library APIs, framework behavior |
| `volatile` | May change anytime | Service responses, rate limits, pricing |

## How It Works

### Data Flow

```
Session Start
  └─ session-start.js loads decisions + research into Claude's system message

During Session
  ├─ Claude auto-saves decisions/research via scripts
  ├─ post-tool-use.js reminds Claude to save after research tools
  └─ sync-tools.js propagates changes to Copilot/Cursor/CLAUDE.md

Session End
  └─ session-stop.js condenses transcript → .last-session.txt

Next Session Start
  ├─ Loads all context (same as above)
  └─ Prompts Claude to run memory-extract + research-extract on pending transcript
```

### Storage Format

Decisions and research are stored as JSONL (one JSON object per line):

**decisions.jsonl**:
```json
{"id":"a1b2c3d4","ts":"2025-01-15T10:30:00Z","category":"architecture","decision":"Use PostgreSQL for the data layer","rationale":"Best fit for relational data with JSON support","confidence":1.0,"source":"manual"}
```

**research.jsonl**:
```json
{"id":"e5f6a7b8","ts":"2025-01-16T14:00:00Z","topic":"Express.js middleware execution order","tags":["express","middleware","ordering"],"finding":"Middleware runs in registration order; error handlers must have 4 params","source_tool":"claude-code","source_context":"Debugging middleware chain","confidence":0.95,"staleness":"versioned","version_anchored":"4.18","supersedes":null}
```

## Uninstalling

1. Remove the plugin from the cache:
   ```bash
   # Windows
   rm -rf "%APPDATA%\.claude\plugins\cache\sungoyal-plugins\project-memory"

   # macOS / Linux
   rm -rf ~/.claude/plugins/cache/sungoyal-plugins/project-memory
   ```

2. Optionally remove generated files from your project:
   ```bash
   rm -rf .ai-memory/
   rm .github/copilot-instructions.md
   rm .cursor/rules/project-decisions.mdc
   # Remove project-memory sections from CLAUDE.md between the marker comments
   ```

## License

MIT
