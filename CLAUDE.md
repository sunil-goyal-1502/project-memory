# Project Context

<!-- project-memory-autosave:start -->
## MANDATORY: Auto-Save Memory (do this throughout EVERY session)
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

**You MUST save decisions and research automatically as you work. Do NOT wait to be asked.**

### IMMEDIATE save triggers (do NOT delay these):
- After ANY codebase exploration (Task/Explore agent, reading multiple files for research)
- After ANY web search or URL fetch
- When the user gives an instruction, constraint, or asks you to remember something
- When you discover API behavior, error causes, library quirks, or workarounds

### Check memory FIRST — before exploring code, web searches, or any investigation:
```bash
node "C:/Users/sungoyal/project-memory/scripts/check-memory.js" "search keywords"
```
If relevant info found, USE it directly — do NOT re-explore or re-investigate. Cite:
> [project-memory] Using saved finding: "<topic>"

### Save decisions — run this whenever a project decision is made:
```bash
node "C:/Users/sungoyal/project-memory/scripts/save-decision.js" "<category>" "<decision>" "<rationale>"
```
Categories: architecture, constraint, convention, testing, scope, unresolved.
Examples of decisions: tech stack choices, API design patterns, naming conventions, "X is out of scope", testing strategies, "must support Y".

### Save research — save EACH FACT as a SEPARATE entry:
```bash
node "C:/Users/sungoyal/project-memory/scripts/save-research.js" "<topic>" "<tags>" "<finding>" [staleness] [--entities "File,Class,Method"]
```
**ATOMIC FACTS**: Each save = ONE searchable fact (1-2 sentences). Never bundle multiple facts.
- BAD: One 500-word entry about "Windows verification pipeline architecture"
- GOOD: 4 entries: "DomService uses XPathDocument", "VerificationDetail has XmlQuery field", etc.
- Use `--entities` with file/class/method names for better search indexing.

**If in doubt, SAVE IT. Saving too much is better than losing knowledge.**

### MANDATORY: End-of-Session Summary
Before ending ANY session, you MUST run the session summary as your FINAL action:
```bash
node "C:/Users/sungoyal/project-memory/scripts/session-summary.js"
```
- If it shows "PENDING SAVES DETECTED", save all pending research/decisions FIRST, then re-run
- Do NOT end the session until the summary shows green (no pending saves)
- This is NON-NEGOTIABLE — always run this before your final response
<!-- project-memory-autosave:end -->

<!-- project-memory:start -->
## Project Decisions
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

## Architecture
- Fork plugin by pointing installed_plugins.json to source repo instead of cache — Plugin cache is non-durable — edits get wiped on cache refresh. Source repo at C:\Users\sungoyal\project-memory is version-controlled and durable.
- Use ONNX MiniLM-L6 embeddings as primary search — no BM25 fallback — @huggingface/transformers is a hard dependency installed with the plugin. Embeddings are the only search mechanism.

<!-- project-memory:end -->

<!-- project-memory-research:start -->
## Research Memory
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

12 research findings loaded (full content). **USE these — do NOT re-investigate:**

- **Dashboard upgraded to global aggregation across all projects**: Dashboard now discovers all .ai-memory directories under USERPROFILE (up to 3 levels deep), aggregates research/decisions/embeddings/stats across all projects. Each entry tagged with _project name. Projects tab shows per-project breakdown. build-embeddings.js supports --all flag for global embedding.
- **Xenova/all-MiniLM-L6-v2 ONNX model availability** [--entities]: Xenova/all-MiniLM-L6-v2 is the ONNX-converted version of sentence-transformers/all-MiniLM-L6-v2. Available on Hugging Face Hub. Can be loaded directly in transformers.js without explicit download. Model size varies (quantized ~22MB, full ~45MB). No separate model package needed on npm—models are fetched on-demand from Hugging Face CDN or cached locally. Works CPU-only, no GPU required.
- **Transformers.js feature-extraction pipeline for embeddings** [--entities]: Transformers.js provides 'feature-extraction' pipeline task that generates embeddings from text. Equivalent to Python Hugging Face pipeline('feature-extraction'). Returns numerical vector representation of input text. Requires specifying model ID (e.g., 'Xenova/all-MiniLM-L6-v2' for sentence embeddings). No separate MiniLM-specific package needed—all models are loaded via ONNX from Hugging Face Hub.
- **@huggingface/transformers vs @xenova/transformers** [--entities]: @huggingface/transformers v3.8.1 (newer fork by Hugging Face) uses both onnxruntime-node v1.21.0 AND onnxruntime-web v1.22.0-dev. @xenova/transformers v2.17.2 (older, by xenova) uses only onnxruntime-web v1.14.0. Hugging Face version has better Node.js CPU optimization with native onnxruntime-node.
- **@xenova/transformers for Node.js Embeddings** [--entities]: @xenova/transformers v2.17.2 is a popular JavaScript implementation of Hugging Face transformers using ONNX Runtime. It provides feature-extraction pipeline for generating embeddings. Uses onnxruntime-web v1.14.0, sharp, and @huggingface/jinja. Works in Node.js and browsers. Supports MiniLM and other sentence embedding models.
- **ONNX Runtime Node.js Embeddings** [--entities]: onnxruntime-node v1.24.2 is available on npm (MIT license, 220MB unpacked). It's the official ONNX Runtime Node.js binding from Microsoft. Depends on: adm-zip, global-agent, onnxruntime-common. Suitable for CPU-only inference on Windows and Linux.
- **session-start.js updated save instructions require atomic fact decomposition**: Save instructions in session-start.js and sync-tools.js (CLAUDE.md auto-save section) now explicitly require ATOMIC FACTS: each save should be ONE searchable fact (1-2 sentences), never bundled. Includes --entities guidance for better search indexing. BAD/GOOD examples provided in the instruction text.
- **post-tool-use.js logs exploration breadcrumbs for unsaved detection**: post-tool-use.js now calls logExplorationBreadcrumb() for every exploratory tool use, appending {ts, tool, subagent, prompt/query/url, saved:false} to .exploration-log. session-summary.js reads this log via shared.getUnsavedBreadcrumbs() and shows UNSAVED EXPLORATIONS warning as hard block. session-start.js clears the log each session.
- **check-memory.js large-store mode uses BM25 ranking + entity index instead of keyword filter**: Replaced keywordPreFilter() in check-memory.js with BM25 scoring (shared.buildBM25Index + bm25Score) merged with entity index lookup. Large store mode (>50 entries) now ranks candidates by BM25 relevance score and shows score in output. Entity index provides O(1) lookup for file/class/method names from query tokens.
- **save-research.js enhanced with --entities, --related flags and dedup warning**: save-research.js now accepts --entities 'A,B' and --related 'id1,id2' CLI flags. Entities are stored lowercase in entry and indexed in entity-index.json for O(1) lookup. Dedup check warns (but does not block) if similar topic + 2 matching tags found. Backward compatible — saves without flags get entities:[] and related_to:[].
- **project-memory shared.js DRY module extracts duplicated utilities**: Created scripts/shared.js extracting findProjectRoot, readJsonl, appendJsonl, tokenize, entity index CRUD, breadcrumb logging, BM25 search, and dedup checking. Previously duplicated across save-research.js, check-memory.js, session-summary.js, save-decision.js.
- **BM25 text search is implementable in pure JavaScript**: BM25 (Best Matching 25) can be implemented in ~50-80 lines of pure JavaScript with zero npm dependencies. Core algorithm: (1) build inverted index mapping terms to document IDs, (2) compute IDF = log((N - df + 0.5) / (df + 0.5) + 1) where N=total docs and df=docs containing term, (3) for each query term compute score = IDF * (tf * (k1+1)) / (tf + k1*(1-b+b*dl/avgdl)) where k1=1.2, b=0.75, tf=term frequency, dl=doc length, avgdl=average doc length. No tokenizer library needed — splitting on whitespace + lowercasing is sufficient for memory search. Packages like 'wink-bm25-text-search' exist but add unnecessary dependencies.

_(9 older findings filtered — older than 7 days. Run check-memory.js to search all including stale.)_

<!-- project-memory-research:end -->
