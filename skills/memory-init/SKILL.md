---
description: Initialize project memory for cross-tool decision tracking
allowed-tools: Bash, Write, Read, Glob, Edit
---

# Initialize Project Memory

Set up the `.ai-memory/` directory in the current project root for cross-tool decision tracking.

## Steps

1. **Create the `.ai-memory/` directory** in the project root (current working directory).

2. **Create these files**:

   - `.ai-memory/decisions.jsonl` — empty file (canonical decision store)
   - `.ai-memory/research.jsonl` — empty file (canonical research store)
   - `.ai-memory/metadata.json` — with this content:
     ```json
     {
       "tokenCount": 0,
       "lastSync": null,
       "sessionCount": 0,
       "decisionCount": 0,
       "researchCount": 0,
       "researchTokenCount": 0
     }
     ```
   - `.ai-memory/.gitignore` — with this content:
     ```
     # Transcript data is ephemeral and potentially sensitive
     .last-session.txt
     ```

3. **Run the sync script** to generate tool-specific instruction files:
   Run via Bash: `node -e "require('${CLAUDE_PLUGIN_ROOT}/scripts/sync-tools.js').syncAll(process.cwd())"`

   This will create:
   - `.github/copilot-instructions.md` (with self-referential save instructions for Copilot)
   - `.cursor/rules/project-decisions.mdc` (with frontmatter + save instructions for Cursor)
   - `CLAUDE.md` (with project decisions section between markers, or update existing)

4. **Report success** with a summary:
   - List all created files
   - Suggest: "Add `.ai-memory/` to git to share decisions across the team"
   - Suggest: "Use `/project-memory:memory-save` to record your first decision"
   - Note: "Copilot and Cursor instruction files include self-referential save instructions — those tools can now save decisions directly to the canonical store"
