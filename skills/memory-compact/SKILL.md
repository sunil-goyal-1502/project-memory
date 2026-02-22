---
description: Compact and deduplicate project decisions
allowed-tools: Read, Write, Task, Bash
---

# Compact Project Decisions

Reduce the size of the decision store by merging related decisions, removing superseded ones, and deduplicating.

## Steps

1. **Read `.ai-memory/decisions.jsonl`** and parse all decisions.
   - If fewer than 5 decisions, tell the user compaction isn't needed yet.

2. **Read `.ai-memory/metadata.json`** and check the token count.
   - Report current count to user.

3. **Analyze decisions for compaction opportunities**:

   Look for these patterns:
   - **Duplicates**: Decisions with essentially the same meaning (even if worded differently)
   - **Superseded**: A later decision that overrides an earlier one (e.g., "Using MySQL" then later "Switched to PostgreSQL" — keep only the latter)
   - **Mergeable**: Multiple decisions in the same category that can be combined into one (e.g., three naming conventions → one combined convention)

4. **Produce a compacted set** of decisions:
   - For merged entries, use the oldest timestamp from the merged decisions
   - Preserve all categories
   - Keep `confidence` as the max of merged entries
   - Set `source` to "compacted"
   - Add a note in rationale about what was merged if helpful
   - Preserve any "unresolved" decisions unless they were clearly resolved by later decisions

5. **Show the proposed changes** to the user:
   - Decisions to remove (with reason: duplicate/superseded)
   - Decisions to merge (showing before → after)
   - Ask user to confirm before applying

6. **Write the compacted decisions** back to `.ai-memory/decisions.jsonl` (overwrite the file).

7. **Run sync** to update tool-specific files:
   ```bash
   node -e "require('${CLAUDE_PLUGIN_ROOT}/scripts/sync-tools.js').syncAll(process.cwd())"
   ```

8. **Report results**: Show before/after decision count and estimated token savings.
