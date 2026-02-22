---
description: Save a research finding to project memory
allowed-tools: Read, Write, Edit, Bash, Glob
---

# Save Research Finding

Save a research finding to `.ai-memory/research.jsonl`.

## Steps

1. **Parse the input**: `$ARGUMENTS` contains the finding text. If empty, ask the user what finding they want to save.

2. **Auto-extract metadata** from the finding text:
   - **topic**: Extract a 5-15 word noun phrase summarizing the finding. Should be scannable and include library/tool names if relevant.
   - **tags**: Extract 1-5 keywords (lowercase). Include library names, concepts, and key technical terms.
   - **staleness**: Classify as:
     - `"stable"` — language behavior, protocol specs, math properties (won't change)
     - `"versioned"` — library/framework-specific behavior (set `version_anchored` if a version is mentioned)
     - `"volatile"` — external service behavior, API responses, rate limits (may change anytime)
   - **confidence**: Default to `0.9` for explicit user-provided findings.

3. **Check for overlapping entries**: Read `.ai-memory/research.jsonl` and look for entries with:
   - 2+ matching tags AND similar topic (substring match)
   - If found, show the existing entry and ask: "Existing finding found on this topic. Supersede it? (y/n)"
   - If superseding, set `"supersedes": "<existing-id>"` in the new entry.

4. **Generate the entry**:
   ```json
   {
     "id": "<8-char-random-hex>",
     "ts": "<ISO8601-timestamp>",
     "topic": "<extracted topic>",
     "tags": ["<extracted tags>"],
     "finding": "<the finding text from $ARGUMENTS>",
     "source_tool": "claude-code",
     "source_context": "Explicitly saved by user",
     "confidence": 0.9,
     "staleness": "<classified>",
     "supersedes": null,
     "version_anchored": null
   }
   ```

5. **Append** the JSON line to `.ai-memory/research.jsonl`.

6. **Run sync** to update tool-specific files:
   ```bash
   node -e "require('${CLAUDE_PLUGIN_ROOT}/scripts/sync-tools.js').syncAll(process.cwd())"
   ```

7. **Report**: Show the saved finding with its topic, tags, and staleness classification.

8. **Show projected savings**: Display:
   `"This finding will save ~300 tokens and ~45 sec each time it's loaded in a future session, plus ~1,000 tokens (~2 min) each time it matches a search query."`

   Then show cumulative stats:
   ```bash
   node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/scripts/stats.js');const st=s.getStats(process.cwd());console.log(s.formatStatsLine(0,0,st))"
   ```
