---
description: Regenerate tool-specific instruction files from decisions
allowed-tools: Read, Write, Edit, Glob, Bash
---

# Sync Project Decisions to Tool Files

Regenerate all tool-specific instruction files from the canonical decision store.

## Steps

1. **Verify `.ai-memory/decisions.jsonl` exists**. If not, tell the user to run `/project-memory:memory-init` first.

2. **Run the sync script**:
   ```bash
   node -e "require('${CLAUDE_PLUGIN_ROOT}/scripts/sync-tools.js').syncAll(process.cwd())"
   ```

3. This will regenerate:
   - **`.github/copilot-instructions.md`** — Decisions grouped by category + self-referential save instructions for GitHub Copilot
   - **`.cursor/rules/project-decisions.mdc`** — Decisions with frontmatter + save instructions for Cursor
   - **`CLAUDE.md`** — Updated decisions section between `<!-- project-memory:start -->` and `<!-- project-memory:end -->` markers

4. **Report results**: Confirm which files were updated and how many decisions were synced.

5. **Show cumulative stats**: Read stats from `.ai-memory/metadata.json` and display cumulative savings line:
   ```bash
   node -e "const s=require('${CLAUDE_PLUGIN_ROOT}/scripts/stats.js');const st=s.getStats(process.cwd());console.log(s.formatStatsLine(0,0,st))"
   ```
