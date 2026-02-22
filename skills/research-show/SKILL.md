---
description: Show research findings stored in project memory
allowed-tools: Read, Glob
---

# Show Research Findings

Display research findings from `.ai-memory/research.jsonl`.

## Steps

1. **Read** `.ai-memory/research.jsonl`. If it doesn't exist or is empty, tell the user: "No research findings recorded yet. Use /project-memory:research-save to capture findings."

2. **Parse optional filter**: If `$ARGUMENTS` is provided, use it as a keyword filter — match against tags (exact), topic (substring, case-insensitive), and finding text (substring, case-insensitive).

3. **Display as a grouped table** organized by primary tag (first tag in the tags array):

   For each group:
   ```
   ## <Primary Tag> (<count>)
   | # | Topic | Finding | Confidence | Staleness | Date |
   |---|-------|---------|------------|-----------|------|
   | 1 | <topic> | <finding truncated to 80 chars> | <confidence> | <staleness> | <date> |
   ```

   If a filter was applied, show only matching entries.

4. **Show summary**:
   - Total findings count (and filtered count if filter applied)
   - Estimated token usage: count total characters across all `topic` + `finding` + `source_context` fields, divide by 4
   - Staleness breakdown: how many stable / versioned / volatile
   - If any entries have `supersedes` set, note: "N entries have been superseded. Run /project-memory:research-compact to clean up."
   - Read cumulative stats from `.ai-memory/metadata.json` `stats` object and display:
     `"Cumulative memory savings: ~<totalTokens> tokens (~<totalCost>), ~<totalTime> saved across <totalHits> lookups"`
