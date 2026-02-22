---
description: Show current project decisions
allowed-tools: Read, Glob
---

# Show Project Decisions

Display all recorded project decisions grouped by category.

## Steps

1. **Read `.ai-memory/decisions.jsonl`** from the project root.
   - If the file doesn't exist, tell the user to run `/project-memory:memory-init` first.
   - If the file is empty, tell the user no decisions have been recorded yet.

2. **Parse all decisions** (one JSON object per line). Skip any malformed lines.

3. **Group decisions by category** and sort within each group by timestamp (oldest first).

4. **Display in a clean format**:

   For each category, show a section like:

   ```
   ## Architecture (3 decisions)
   | # | Decision | Rationale | Source | Date |
   |---|----------|-----------|--------|------|
   | 1 | Using PostgreSQL for data layer | Best fit for relational data with JSON support | manual | 2025-01-15 |
   | 2 | REST API over GraphQL | Simpler for our team size | auto | 2025-01-16 |
   ```

   Categories to display (in order): architecture, constraint, convention, testing, scope, explicit, unresolved, other.

5. **Show summary**: Total decision count, last sync time (from `.ai-memory/metadata.json` if available), and estimated token count.
   - Also read cumulative stats from `.ai-memory/metadata.json` `stats` object and display:
     `"Cumulative memory savings: ~<totalTokens> tokens (~<totalCost>), ~<totalTime> saved across <totalHits> lookups"`
