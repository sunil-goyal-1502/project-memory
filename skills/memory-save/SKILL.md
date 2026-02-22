---
description: Save an explicit project decision
allowed-tools: Read, Write, Edit, Bash
---

# Save a Project Decision

Save an explicit decision to the project's canonical decision store.

## Steps

1. **Parse the decision text** from `$ARGUMENTS`.
   - If `$ARGUMENTS` is empty or blank, ask the user what decision they want to save.

2. **Verify `.ai-memory/decisions.jsonl` exists** in the project root.
   - If not, tell the user to run `/project-memory:memory-init` first.

3. **Generate a decision entry** as a single JSON line:
   ```json
   {
     "id": "<8-character random hex string>",
     "ts": "<current ISO8601 timestamp>",
     "category": "explicit",
     "decision": "<the decision text from $ARGUMENTS>",
     "rationale": "Explicitly saved by user",
     "confidence": 1.0,
     "source": "manual"
   }
   ```

   Generate the 8-char hex ID and ISO timestamp. Then append this as a single line to `.ai-memory/decisions.jsonl`.

   Use Bash to append:
   ```bash
   echo '{"id":"<hex>","ts":"<iso>","category":"explicit","decision":"<text>","rationale":"Explicitly saved by user","confidence":1.0,"source":"manual"}' >> .ai-memory/decisions.jsonl
   ```

4. **Run sync** to update all tool-specific files:
   ```bash
   node -e "require('${CLAUDE_PLUGIN_ROOT}/scripts/sync-tools.js').syncAll(process.cwd())"
   ```

5. **Confirm** to the user what was saved and that all tool files were updated.

6. **Show projected savings**: Display:
   `"This decision will save ~150 tokens and ~15 seconds each time it's loaded in a future session."`

   Then show cumulative stats:
   ```bash
   node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/scripts/stats.js');const st=s.getStats(process.cwd());console.log(s.formatStatsLine(0,0,st))"
   ```
