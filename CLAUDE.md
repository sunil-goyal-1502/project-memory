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
node "<USER_HOME>/project-memory/scripts/check-memory.js" "search keywords"
```
If relevant info found, USE it directly — do NOT re-explore or re-investigate. Cite:
> [project-memory] Using saved finding: "<topic>"

### Save decisions — run this whenever a project decision is made:
```bash
node "<USER_HOME>/project-memory/scripts/save-decision.js" "<category>" "<decision>" "<rationale>"
```
Categories: architecture, constraint, convention, testing, scope, unresolved.
Examples of decisions: tech stack choices, API design patterns, naming conventions, "X is out of scope", testing strategies, "must support Y".

### Save research — save EACH FACT as a SEPARATE entry:
```bash
node "<USER_HOME>/project-memory/scripts/save-research.js" "<topic>" "<tags>" "<finding>" [staleness] [--entities "File,Class,Method"]
```
**ATOMIC FACTS**: Each save = ONE searchable fact (1-2 sentences). Never bundle multiple facts.
- BAD: One 500-word entry about "Windows verification pipeline architecture"
- GOOD: 4 entries: "DomService uses XPathDocument", "VerificationDetail has XmlQuery field", etc.
- Use `--entities` with file/class/method names for better search indexing.

**If in doubt, SAVE IT. Saving too much is better than losing knowledge.**

### MANDATORY: End-of-Session Summary
Before ending ANY session, you MUST run the session summary as your FINAL action:
```bash
node "<USER_HOME>/project-memory/scripts/session-summary.js"
```
- If it shows "PENDING SAVES DETECTED", save all pending research/decisions FIRST, then re-run
- Do NOT end the session until the summary shows green (no pending saves)
- This is NON-NEGOTIABLE — always run this before your final response
<!-- project-memory-autosave:end -->

<!-- project-memory:start -->
## Project Decisions
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

## Architecture
- Fork plugin by pointing installed_plugins.json to source repo instead of cache — Plugin cache is non-durable — edits get wiped on cache refresh. Source repo at <USER_HOME>\project-memory is version-controlled and durable.
- Use ONNX MiniLM-L6 embeddings as primary search — no BM25 fallback — @huggingface/transformers is a hard dependency installed with the plugin. Embeddings are the only search mechanism.
- Raw exploration output auto-captured to .ai-memory/explorations/ as verbatim markdown files with YAML frontmatter — User wants complete agent output preserved as-is for future sessions, not summaries or atomic facts. Graph-indexed for relevant retrieval.
- Directory junction from plugin cache to source repo for permanent sync — CLAUDE_PLUGIN_ROOT resolves to cache copy regardless of installPath. Junction at cache/project-memory-marketplace/project-memory/1.0.0/ -> <USER_HOME>/project-memory makes all source edits instantly active in running hooks.
- Separate script library from research: scripts.jsonl with parameterized templates — Auto-captured scripts (52% of research.jsonl) pollute BM25 search, drowning out real findings. Scripts need parameterization ({{build_id}}, {{log_id}}) for reuse. Separate store enables different search+injection UX.
- Hook-based architecture creates synchronous performance bottlenecks: pre/post-tool-use fire on EVERY tool call (100+ per session). Critical path includes BM25 index rebuild, JSONL parsing, and multiple fs.readFileSync calls per invocation. Recommend: extract intent detection to shared module, cache keyword patterns, implement read-through cache for frequently accessed files. — Pre-tool-use.js performs 7+ fs.readFileSync ops per exploratory call (research.jsonl, config.json, graph.jsonl, .last-memory-check, .cache-hits, session registry). Post-tool-use.js writes to 3+ files per exploration. No caching between hook calls. Graph expansion disabled in hooks (hookExpansionDepth=1) but still reads graph.jsonl. With 100+ research entries and keyword pattern matching on every call, BM25 rebuilds entire inverted index each time.

## Constraint
- Only store reusable scripts with real logic — not trivial one-liner commands — Commands like cat, grep, find, ls, head, tail, sed are general-purpose tools Claude can generate on-the-fly. isReusableScript() filters these out. Only multi-step scripts with auth, API calls, loops, or data processing pipelines are saved to scripts.jsonl.

## Testing
- E2E tests should cover save, search, graph, and session-summary pipeline — Validates the full project-memory lifecycle in a single pass

<!-- project-memory:end -->

<!-- project-memory-research:start -->
## Research Memory
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

19 of 79 recent findings shown. **USE these — do NOT re-investigate:**

- **Daemon achieves 1-9ms processing, 14-100ms total hook time**: Memory daemon on TCP localhost achieves: daemon processing 1-9ms (in-memory BM25+graph), POST hooks 14ms total, PRE hooks 99ms warm (Node.js startup dominates). Cold PRE ~2s on Windows (Node binary not cached by OS). Fallback works correctly when daemon killed. Port written to .daemon-port, PID to .daemon-pid, auto-shutdown after 2hr inactivity.
- **Daemon architecture for persistent in-memory caching**: Hook-per-process architecture costs ~1500ms per call (Node.js startup + require). File-based caching saves only 11ms (BM25 cache read 4ms vs rebuild 14ms). Solution: TCP localhost daemon spawned at session-start, holds BM25 index + graph adjacency + research entries in memory, hooks connect via net.connect to localhost:PORT (port written to .daemon-port), fallback to direct execution if daemon down.
- **data-files-pipeline**: Data file pipeline: (1) Source: research.jsonl, decisions.jsonl, graph.jsonl, explorations/explorations.jsonl, scripts.jsonl. (2) Cached indices: .bm25-cache.json (mtime-keyed), .graph-adj-cache.json (large 1MB+ adjacency index), .intent-embeddings.json (classifier refs). (3) Runtime state: .session-state.json, .exploration-log, .tool-history (.max 50 entries). (4) Metadata: entity-index.json, metadata.json, embeddings.json (1.2MB ONNX embedding cache). (5) Session tracking: session-history.jsonl, .session-start-ts. Total ~2.5MB working data for single project.
- **hook-contract-json-io**: Hook I/O contract: stdin=valid JSON {tool_name, tool_input:{command,description,query,prompt,url,subagent_type}, cwd, session_id, tool_response, tool_result, transcript_path}. Stdout=JSON {systemMessage?:string, hookSpecificOutput?:{hookEventName:string, permissionDecision:(allow|deny), permissionDecisionReason?}, decision?:(block|allow), reason?:string} or {}. Exit always 0. Pre-tool-use injects memory findings (0.5+ BM25 score max 5 findings). Post-tool-use blocks on IMMEDIATE_SAVE_TOOLS or escalation. Session state persists: .session-state.json v1 with reminder, memoryCheck, taskTracker, lastInjection, cacheHits fields.
- **daemon-candidate-design**: Daemon candidate design: persistent Node.js process listening on TCP localhost (port from .daemon-port file). Responsibilities: (1) Watch research.jsonl, decisions.jsonl, graph.jsonl, explorations.jsonl via fs.watchFile, (2) Rebuild BM25 index atomically on research.jsonl mtime change, (3) Rebuild graph adjacency index on graph.jsonl change, (4) Serve indices + search queries via IPC for hooks (eliminates per-hook rebuild cost). Hooks query daemon via net.connect(port), receive cached results. Session-start can spawn daemon if not running. Daemon detaches, logs to .daemon.log, writes .daemon-port on startup, reads it on shutdown.
- **windows-ipc-net-patterns**: Windows Node.js IPC options: (1) net.createServer() with named pipes pattern \\.\pipe\name (requires fs.exists check for duplicate server), (2) TCP localhost on random port (listen(0, 127.0.0.1)) — simpler, no FS race conditions. Daemon detection: write port to .daemon-port file, child checks if file exists + tries net.connect with short timeout. On Windows, can also use env variable to pass port. TCP approach preferred over named pipes for cross-platform simplicity. Port 0 lets OS choose ephemeral port.
- **session-start-background-processes**: Session-start.js spawns 3 detached background processes using spawn(execPath, args, {detached:true, stdio:ignore, windowsHide:true}): (1) intent-classifier.js --build if not cached, (2) build-embeddings.js --all (embeddings + graph cache), (3) dashboard.js --background. All use child.unref() to detach. Also synchronously builds BM25 and graph adjacency caches via graphMod.buildAndCacheAdjacency(). Spawns use cwd:projectRoot or inherit env. No daemon process exists — only one-shot background tasks per session start.
- **hooks-side-effects**: Pre-tool-use writes lastInjection timestamp to session state for double-block detection, sets memoryCheck.lastCheckTs for TTL gating. Post-tool-use: (1) logs exploration breadcrumb, (2) writes exploration markdown + JSONL index + graph triples + entities, (3) spawns detached build-embeddings.js child (unref, stdio:ignore), (4) appends tool history for auto-capture patterns. Exploration capture extracts entities via graph.js extractEntitiesFromText (50 limit), files via regex, tags from prompt.
- **hooks-blocking-logic**: Pre-tool-use blocks on escalation: if reminderCount > 2 AND no save since last reminder. Post-tool-use blocks immediately on IMMEDIATE_SAVE_TOOLS (Task/WebSearch/WebFetch). Bash gets gradual escalation with THROTTLE_MS=3min between reminders. Blocks skip when: (1) double-block within 30s of pre-injection, (2) parallel Task cooldown <5s, (3) more tasks pending completion. Task completion triggers session-summary block when all created tasks are completed. Periodic checkpoint blocks after 40 tool calls.
- **hooks-data-files**: Hooks read during execution: research.jsonl (BM25 search), graph.jsonl (adjacency expansion), entity-index.json (entity lookup), explorations/explorations.jsonl (past explorations BM25), scripts.jsonl (script library search), .session-state.json (session reminder/task state), config.json (graph settings). Pre-tool-use caches BM25 index to .bm25-cache.json keyed by research.jsonl mtime. Post-tool-use writes to: research.jsonl (auto-capture), explorations.jsonl (exploration index), graph.jsonl (exploration triples), entity-index.json (exploration entities), .exploration-log (breadcrumb), .tool-history (for auto-capture detection).
- **hooks-architecture**: Pre-tool-use hook stdin contains: tool_name, tool_input (query/command/description), cwd, session_id, transcript_path. Stdout must be valid JSON: {systemMessage?, hookSpecificOutput?{hookEventName, permissionDecision:(allow|deny), permissionDecisionReason?}}. Post-tool-use hook receives tool_response (full agent output string, not tool_result). Outputs {decision:(block|empty), reason?} for blocking, or {} to allow. Both hooks write to session state (.session-state.json) for reminder count, memory check TTL, task tracker, and lastInjection timestamp. Session state persists across tool calls within a session.
- **E2E test suite: 22 tests covering full plugin pipeline**: test-e2e.js validates: module loading (shared.js + graph.js exports), save pipeline (save-research creates entry, BM25 cache invalidated), search (check-memory finds entries), BM25 caching (build/load/score roundtrip), graph caching (adjacency build/load), entity types (File/Class/Tool/Namespace), script library (isReusableScript filter, grouping), session state (write/read roundtrip), intent detection (exploratory vs operational, curl POST fix), undo-save (remove + verify gone), corruption detection (malformed JSONL lines).
- **All 4 refactoring phases complete: DRY, caching, UX, scalability**: Phase 1: DRY extraction (pre-tool-use 679->350, post-tool-use 991->472), session state consolidated into .session-state.json, corruption detection in readJsonl, curl POST fix, timing metrics. Phase 2: BM25 + graph adjacency cached at session-start (.bm25-cache.json + .graph-adj-cache.json), hooks use cached data, save-research invalidates cache. Phase 3: parallel Task cooldown, session-start trimmed to ~500 tokens, double-block prevention via lastInjection flag, Read/Grep/Glob lightweight injection. Phase 4: script grouping by skeleton (36->28 templates), exploration auto-purge >30 days, entity type system (File/Class/Function/Tool/Concept).
- **Phase 1A complete: DRY extraction eliminated 850+ LOC from hooks**: Extracted all duplicated code from pre-tool-use.js and post-tool-use.js to shared.js: debugLog, isSelfCall, isExploratoryBash/Task, intent keywords, readSessionState/writeSessionState, getLastSaveTs, hasResearch, searchExplorationsForHook, ANSI constants, MATCHED_TOOLS. pre-tool-use: 679->347 lines. post-tool-use: 991->472 lines. Also added: LIGHTWEIGHT_TOOLS (Read/Grep/Glob), session state consolidation, timing metrics, curl POST fix, double-block prevention, parallel Task cooldown.
- **Comprehensive plugin audit: 3 critical, 8 high, 6 medium issues found**: 3 parallel audit agents found: CRITICAL: BM25 rebuilt every hook call (O(n) per tool use), 300+ LOC duplicated across hooks (intent detection, root discovery, state mgmt), research.jsonl corruption silently drops entries. HIGH: Read/Grep/Glob not hooked, session-start systemMessage too long (competes with CLAUDE.md), 9 scattered state files, double-blocking on Task agents, no staleness/archival mechanism. See full audit in conversation.
- **Missing features: no delete/archive, no merge/consolidate, no per-project isolation, no versioning**: No way to delete stale/wrong entries from research.jsonl — must manually edit. No merge/consolidate UI for duplicate findings. Multi-project users on same machine: no project isolation (e.g., project-A research appears in project-B searches). No backup versioning — only .bak files from manual saves. Exploration capture auto-saves to disk but no way to delete/review/organize explorations before they bloat .ai-memory/. Auto-capture detects retry-success but no manual audit/approval before saving. Scripts library grows indefinitely without dedup enforcement. CLAUDE.md can exceed token budget if 500+ entries.
- **Architecture: dual-search strategy (BM25 in hooks + embeddings in check-memory) creates inconsistent UX**: pre-tool-use.js uses BM25 for all searches (line 428: shared.buildBM25Index). check-memory.js uses embeddings for search (ONNX MiniLM). This creates inconsistency: (1) cache-hit in hooks shows different results than check-memory, (2) no embeddings fallback in hooks despite embeddings being primary architecture, (3) config.json has searchMode 'hybrid'|'flat'|'graph' but hooks ignore it and always use BM25. Recommend: unify to embeddings everywhere (hooks + check-memory), or if BM25 needed in hooks for speed, cache embeddings.json per-session.
- **Stateful dot-files sprawl: 9 separate .ai-memory files track ephemeral state per session**: .last-reminder tracks escalation state (reminderCount, lastSaveTs, ts) [post-tool-use.js 648-684]. .last-memory-check tracks TTL [pre-tool-use.js 276-284]. .task-tracker tracks task completion [post-tool-use.js 591-613]. .exploration-log tracks exploration breadcrumbs [shared.js 115-147]. .tool-history tracks command history for auto-capture [shared.js 207-235]. .cache-hits logs recent cache lookups [pre-tool-use.js 471-513]. .session-start-ts records session start [session-start.js 226-233]. .hook-debug.log for debug output [pre-tool-use.js 26-34]. .intent-embeddings.json caches intent classifier [session-start.js 250-255]. Total: 9 separate files with unclear consolidation path. Recommend: single .ai-memory/.session-state.json for all ephemeral data with versioned schema.
- **BM25 scalability: index rebuilt on every hook invocation, O(n) cost**: BM25 index (shared.js lines 150-168) rebuilt during EVERY pre-tool-use hook call for exploratory tools. buildBM25Index tokenizes entire research.jsonl (150+ lines each), builds inverted index, computes IDF for all terms. At 100 research entries: O(100 * avg_200_tokens) = O(20K token operations) per hook. With 40+ tool calls/session, that's 800K+ token ops just for BM25. Remediation: cache index in memory, invalidate on save; or defer to async embeddings-based search instead. Graph expansion in hooks also reads graph.jsonl despite hookExpansionDepth=1 limiting traversal.

_(60 more recent findings omitted for size. Run `check-memory.js` to search all.)_

_(22 older findings filtered — older than 7 days. Run check-memory.js to search all including stale.)_

<!-- project-memory-research:end -->

<!-- project-memory-scripts:start -->
## Script Library
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

10 script templates (38 total scripts). **Reuse these — fill in {{params}} instead of rebuilding commands:**

- **Analyze high-value and low-value entries** (4 variants, 4x total): `node -e "
const fs = require('fs');
const readline = require('readline');

let entries = [];
const rl = readline.createI...`
  Variants: Analyze high-value and low-value entries, Check what Script: references remain in research, Debug script BM25 search +1 more
- **Fetch build timeline - all stages/jobs/tasks with pass/fail status** (3 variants, 3x total): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv 2>/dev/null) && curl -s -H "Au...`
  Variants: Fetch build timeline - all stages/jobs/tasks with pass/fail status, Fetch test runs associated with this build, Extract all failed records with error details and log IDs
  Params: `{{resource_id}}`, `{{uuid}}`, `{{build_id}}`
- **Fetch Analyze Retry Results log for test outcome details** (2 variants, 3x total): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv 2>/dev/null) && curl -s -H "Au...`
  Variants: Fetch Analyze Retry Results log for test outcome details, Fetch ADALAISKU Bucket 4/5 test outcome details
  Params: `{{resource_id}}`, `{{uuid}}`, `{{build_id}}`, `{{log_id}}`
- **Fetch Run UI Automation CLI log (ADALAISKU Bucket 2/5) for test details** (2x): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv 2>/dev/null) && curl -s -H "Au...`
  Params: `{{resource_id}}`, `{{uuid}}`, `{{build_id}}`, `{{log_id}}`
- **Analyze research.jsonl structure and compute statistics** (2 variants, 2x total): `cat "<USER_HOME>/project-memory/.ai-memory/research.jsonl" | node -e "
const readline = require('readline');
const...`
  Variants: Analyze research.jsonl structure and compute statistics, Analyze script entries and duplicate topics
- **Identify exact duplicates and confidence analysis** (2x): `node -e "
const fs = require('fs');
const readline = require('readline');

let entries = [];
const rl = readline.createI...`
- **Fetch ADO work item details** (2x): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv) && curl -s -H "Authorization:...`
  Params: `{{resource_id}}`, `{{uuid}}`, `{{workitem_id}}`
- **Debug T13 reply failure** (2 variants, 2x total): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv 2>/dev/null)
REPO="{{uuid}}"
P...`
  Variants: Debug T13 reply failure, Post T14 reply and check T15 status
  Params: `{{resource_id}}`, `{{uuid}}`, `{{uuid_2}}`
- **Check raw API response** (1x): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv 2>/dev/null) && curl -s -X PAT...`
  Params: `{{resource_id}}`, `{{uuid}}`, `{{repo_id}}`
- **Fetch build details via ADO REST API** (1x): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv 2>/dev/null) && curl -s -H "Au...`
  Params: `{{resource_id}}`, `{{build_id}}`, `{{build_id_2}}`

<!-- project-memory-scripts:end -->
