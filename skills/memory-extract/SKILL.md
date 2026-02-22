---
description: Extract decisions from the previous session transcript
allowed-tools: Read, Write, Edit, Bash, Task, Glob
---

# Extract Decisions from Previous Session

Analyze the condensed transcript from the previous session and extract project decisions.

## Steps

1. **Check for pending transcript**: Read `.ai-memory/.last-session.txt`.
   - If it doesn't exist or is empty, tell the user: "No previous session transcript found. Decisions are captured automatically when a session ends and extracted at next session start."

2. **Read the condensed transcript** from `.ai-memory/.last-session.txt`.

3. Perform the extraction yourself using these rules:

   **INCLUDE** (these ARE decisions):
   - Why-decisions: "We chose X because Y", "Let's use X for Y"
   - Constraints: "We can't use X because Y", "X must be Y"
   - Scope: "Let's not do X for now", "X is out of scope"
   - Conventions: "Let's name X as Y", "We'll follow X pattern"
   - Unresolved: "We need to figure out X", "TODO: decide on X"

   **EXCLUDE** (these are NOT decisions):
   - Implementation details (specific code changes, debugging steps)
   - Git operations and file management
   - Questions that were fully resolved in the same session
   - Tool usage and progress updates

   **DEDUPLICATION**:
   - If the same decision appears multiple times, keep only the most refined version
   - If a decision was made and then changed, keep only the final version

   **OUTPUT FORMAT**: For each decision, produce a JSON line:
   ```json
   {"id":"<8-hex>","ts":"<ISO8601>","category":"architecture|constraint|convention|testing|scope|unresolved","decision":"<one sentence>","rationale":"<why>","confidence":<0.0-1.0>,"source":"auto"}
   ```

4. **Append extracted decisions** to `.ai-memory/decisions.jsonl` (one JSON line per decision).

5. **Delete** `.ai-memory/.last-session.txt` (it has been processed).

6. **Run sync** to update tool-specific files:
   ```bash
   node -e "require('${CLAUDE_PLUGIN_ROOT}/scripts/sync-tools.js').syncAll(process.cwd())"
   ```

7. **Report results**: Show how many decisions were extracted, grouped by category.

8. **Suggest research extraction**: If the transcript contained research-like activities (API investigations, library explorations, error debugging — look for `[RESEARCH]` or `[RESEARCH-CANDIDATE]` tags, or mentions of WebFetch/WebSearch tool usage), suggest: "The transcript also contained research activities. Run `/project-memory:research-extract` to capture those findings into research memory."
