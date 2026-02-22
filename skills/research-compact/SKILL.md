---
description: Condense and clean up research memory
allowed-tools: Read, Write, Edit, Bash, Glob
---

# Compact Research Memory

Clean up `.ai-memory/research.jsonl` by removing superseded entries, merging duplicates, and flagging stale findings.

## Steps

1. **Read** `.ai-memory/research.jsonl`. If it doesn't exist or is empty, tell the user: "No research findings to compact."

2. **Identify superseded entries**: Find entries whose `id` is referenced by another entry's `supersedes` field. These are old findings that have been replaced.

3. **Identify duplicate candidates**: Find pairs of entries that share:
   - 2+ matching tags AND
   - Similar topic (one topic is a substring of the other, case-insensitive)
   - If both exist and neither supersedes the other, propose merging — keep the more recent one and combine findings.

4. **Flag stale entries**:
   - **Volatile entries > 90 days old**: Flag as "May be outdated — volatile finding from <date>"
   - **Versioned entries with outdated version**: If `version_anchored` is set, flag as "Anchored to <version> — check if still current"
   - **Low-confidence entries > 60 days old**: Entries with `confidence < 0.5` older than 60 days — flag as "Low confidence and aging — consider verifying or removing"

5. **Show proposed changes** to the user:
   ```
   ## Research Compaction Proposal

   ### Remove (superseded): <count>
   - <id>: <topic> (superseded by <superseding-id>)

   ### Merge (duplicates): <count>
   - <id1> + <id2>: <topic> → keep <newer-id>, combine findings

   ### Flagged (possibly stale): <count>
   - <id>: <topic> — <reason>

   ### After compaction: <new-count> entries (was <old-count>)
   ```

6. **Ask for confirmation**: "Apply these changes? (Flagged entries will NOT be removed — only superseded and merged entries will be cleaned up.)"

7. **If confirmed**:
   - Remove superseded entries
   - Merge duplicates: keep the newer entry, append the older entry's finding as additional context, set `supersedes` to the older entry's id
   - Write back the cleaned `.ai-memory/research.jsonl`

8. **Run sync** to update tool-specific files:
   ```bash
   node -e "require('${CLAUDE_PLUGIN_ROOT}/scripts/sync-tools.js').syncAll(process.cwd())"
   ```

9. **Report**: Show final count and estimated token savings.
