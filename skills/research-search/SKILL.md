---
description: Search research memory before investigating (the "check first" skill)
allowed-tools: Read, Glob
---

# Search Research Memory

Search `.ai-memory/research.jsonl` for existing findings before starting new research.

## Steps

1. **Parse query**: `$ARGUMENTS` contains the search keywords. If empty, ask the user what they're looking for.

2. **Read** `.ai-memory/research.jsonl`. If it doesn't exist or is empty, tell the user: "No research findings recorded yet. Proceed with your investigation."

3. **Semantic evaluation** — YOU are the search engine. Read ALL entries and evaluate semantic relevance to the query:
   - Match on: **synonyms** ("DB" = "database"), **abbreviations** ("JWT" = "JSON Web Token"), **conceptual overlap** ("error handling" ≈ "exception strategy"), and **architectural relevance**.
   - Do NOT rely on exact keyword matching — use your understanding of meaning.

4. **Show the most relevant results** (up to 5) with full finding details and staleness assessment:

   For each match:
   ```
   ### [<STALENESS_BADGE>] <topic>
   **Tags**: <tags>  |  **Confidence**: <confidence>  |  **Date**: <date>
   **Finding**: <full finding text>
   **Source**: <source_tool> — <source_context>
   ```

   Staleness badges:
   - `[FRESH]` — staleness is "stable", or staleness is "versioned" and version_anchored matches a recent/current version
   - `[CHECK VERSION]` — staleness is "versioned" (user should verify version_anchored matches their current version)
   - `[VERIFY]` — staleness is "volatile" (user should verify finding is still accurate)

5. **Recommendation**:
   - If a `[FRESH]` match with confidence >= 0.8 is found: "**Recommendation**: Use this finding directly."
   - If a `[CHECK VERSION]` match is found: "**Recommendation**: Verify your current version matches `<version_anchored>` before using."
   - If a `[VERIFY]` match is found: "**Recommendation**: Use as a starting hypothesis but verify — this finding may have changed."
   - If no matches: "**No matching research found.** Proceed with your investigation, then save findings with /project-memory:research-save."

6. **Show savings** (if matches were found):
   - Compute: `matchCount * 1000` tokens saved, `matchCount * 120` seconds saved.
   - Display: `"By using cached research: ~<tokens> tokens saved, ~<time> of investigation avoided."`
   - Record the event by running:
     ```bash
     node -e "require('${CLAUDE_PLUGIN_ROOT}/scripts/stats.js').recordEvent(process.cwd(), 'research_search_hit', <matchCount>)"
     ```
   - Read cumulative stats and display:
     ```bash
     node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/scripts/stats.js');const st=s.getStats(process.cwd());console.log(s.formatStatsLine(0,0,st))"
     ```
