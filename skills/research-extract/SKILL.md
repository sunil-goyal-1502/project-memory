---
description: Extract research findings from previous session transcript
allowed-tools: Read, Write, Edit, Bash, Task, Glob
---

# Extract Research from Previous Session

Analyze the condensed transcript from the previous session and extract research findings.

## Steps

1. **Check for pending transcript**: Read `.ai-memory/.last-session.txt`.
   - If it doesn't exist or is empty, tell the user: "No previous session transcript found. Research findings are captured from session transcripts saved by the session-end hook."

2. **Read the condensed transcript** from `.ai-memory/.last-session.txt`.

3. Perform the extraction yourself using these rules:

   **Focus on tagged content**: Look for lines prefixed with `[RESEARCH]` (tool calls to WebFetch, WebSearch, or MCP tools) and `[RESEARCH-CANDIDATE]` (assistant text containing research signals). Also scan untagged content.

   **INCLUDE** (these ARE research findings):
   - API behavior: response formats, rate limits, edge cases, error codes
   - Library compatibility: version-specific behavior, breaking changes, feature support
   - Error root causes: why errors happen and confirmed fixes
   - Performance findings: measured or observed characteristics
   - Documentation clarifications: corrections to or clarifications of docs
   - Workarounds: solutions to known issues
   - Configuration discoveries: non-obvious settings or requirements

   **EXCLUDE** (these are NOT research findings):
   - Decisions (architectural choices, conventions, constraints) — those go to decisions.jsonl
   - Implementation steps (code that was written, files created)
   - Transient debugging (print statements, breakpoints)
   - Project-specific code locations
   - Git operations, progress updates

   **STALENESS HEURISTIC**:
   - Mentions a specific version (e.g., "in React 18", "with Node 20") → `"versioned"` with `version_anchored` set
   - Mentions an external service/API (e.g., "GitHub API", "Stripe webhook") → `"volatile"`
   - Otherwise → `"stable"`

   **DEDUPLICATION**:
   - Read existing `.ai-memory/research.jsonl` first
   - If an extracted finding overlaps with an existing entry (2+ shared tags AND similar topic), skip it unless the new finding is more complete — in that case, set `supersedes` to the existing entry's id

   **OUTPUT FORMAT**: For each finding, produce a JSON line:
   ```json
   {"id":"<8-hex>","ts":"<ISO8601>","topic":"<5-15 word noun phrase>","tags":["<1-5 keywords>"],"finding":"<concise description>","source_tool":"auto","source_context":"<what prompted this>","confidence":<0.0-1.0>,"staleness":"stable|versioned|volatile","supersedes":null,"version_anchored":null}
   ```

4. **Append extracted findings** to `.ai-memory/research.jsonl` (one JSON line per finding).

5. **Do NOT delete** `.ai-memory/.last-session.txt` — the memory-extract skill handles that.

6. **Run sync** to update tool-specific files:
   ```bash
   node -e "require('${CLAUDE_PLUGIN_ROOT}/scripts/sync-tools.js').syncAll(process.cwd())"
   ```

7. **Report results**: Show how many research findings were extracted with their topics and staleness classifications.
