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

## Testing
- E2E tests should cover save, search, graph, and session-summary pipeline — Validates the full project-memory lifecycle in a single pass

<!-- project-memory:end -->

<!-- project-memory-research:start -->
## Research Memory
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

117 research findings loaded (full content). **USE these — do NOT re-investigate:**

- **graph.js extractTriplesFromEntry**: extractTriplesFromEntry creates 3 types of triples: (1) provenance - finding ID 'mentions' entity, (2) semantic verbs via extractRelationships (uses, depends_on, calls), (3) co-occurrence 'related_to' fallback within sentences.
- **graph.js extractEntitiesFromText**: extractEntitiesFromText uses 9 regex patterns: PascalCase, file names, method calls, async methods, namespaces, CLI tools, URLs. All lowercased. Stops words filtered (50+ common words). Returns unique entity strings.
- **Script: Check what node_modules exist in source**: Check what node_modules exist in source: ls "<USER_HOME>/project-memory/node_modules" 2>/dev/null | head -10
- **Script: Check what node_modules exist in cache**: Check what node_modules exist in cache: ls "<USER_HOME>/.claude/plugins/cache/project-memory-marketplace/project-memory/1.0.0/node_modules" 2>/dev/null | head -10
- **Script: Read marketplace.json from cache**: Read marketplace.json from cache: cat "<USER_HOME>/.claude/plugins/cache/project-memory-marketplace/project-memory/1.0.0/.claude-plugin/marketplace.json"
- **Script: Read package.json to understand plugin structure**: Read package.json to understand plugin structure: find "<USER_HOME>/project-memory" -name "package.json" -exec cat {} \;
- **Script: List files in source project-memory directory**: List files in source project-memory directory: ls -la "<USER_HOME>/project-memory/" | head -20
- **Script: Find plugin config files in cache**: Find plugin config files in cache: find "<USER_HOME>/.claude/plugins/cache/project-memory-marketplace/project-memory/1.0.0" -maxdepth 2 -type f -name "*.json" -o -name ".claude-plugin" 2>&1 | head -10
- **Script: Search for plugin registry files**: Search for plugin registry files: find "<USER_HOME>/.claude" -name "*installed*" -o -name "*registry*" 2>&1 | head -20
- **Script: List all files in .claude directory**: List all files in .claude directory: ls -la "<USER_HOME>/.claude/" 2>&1
- **Script: Find all JSON files in plugins directory**: Find all JSON files in plugins directory: find "<USER_HOME>/.claude/plugins" -type f -name "*.json" 2>&1 | head -20
- **graph.hookExpansionDepth default**: graph.hookExpansionDepth defaults to 1 hop in config.js. Controls max graph traversal depth in pre-tool-use hook (sync/fast), vs expansionDepth=2 for async check-memory.
- **Config.js module structure**: config.js provides readConfig/writeConfig with deep-merge defaults. Stored at .ai-memory/config.json. Settings: searchMode, graph (enabled/depth), embeddings, BM25, hooks (thresholds/TTL), autoCapture.
- **Script: Check if other scripts also differ**: Check if other scripts also differ: for f in graph.js config.js build-embeddings.js stats.js; do echo "--- $f ---"; diff "<USER_HOME>/project-memory/scripts/$f" "<USER_HOME>/.claude/plugins/cache/project-memory-marketplace/project-memory/1.0.0/scripts/$f" > /dev/null 2>&1 && echo "SAME" || echo "DIFFERS"; done
- **Script: Check if shared.js also differs**: Check if shared.js also differs: diff "<USER_HOME>/project-memory/scripts/shared.js" "<USER_HOME>/.claude/plugins/cache/project-memory-marketplace/project-memory/1.0.0/scripts/shared.js" 2>/dev/null | head -5 && echo "---" && diff "<USER_HOME>/project-memory/scripts/shared.js" "<USER_HOME>/.claude/plugins/cache/project-memory-marketplace/project-memory/1.0.0/scripts/shared.js" 2>/dev/null | wc -l
- **Script: Create PR with linked work item**: Create PR with linked work item: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null)

# Create PR via ADO REST API
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/git/repositories/dfbb009c-c5c9-4519-b9b9-3d6fef17d5cb/pullrequests?api-version=7.1" \
  -d '{
    "sourceRefName": "refs/heads/users/sungoyal/framework-resilience-fixes",
    "targetRefName": "refs/heads/main",
    "title": "Add framework resilience fixes to reduce CI test failures",
    "description": "## Summary\n- **System crash detection**: Skip retries on \"Pixel Launcher isn'\''t responding\" / ANR / \"has stopped\" errors instead of retrying 3 more times against a crashed emulator\n- **Per-step retry budget** (max 10/15 per step): Prevent one stuck step from consuming all 100 execution steps in state-recovery loops\n- **DOM change detection**: Detect UI-stuck scenarios when 3 consecutive actions produce no DOM change, and fail fast\n- **App data clear on test failure**: New `ClearAppDataAsync` tool (Android `pm clear` + iOS `mobile:clearApp`) called in teardown to remove stale sign-in state between retries\n- **FRE/MFA/credential error handling**: Add system prompt guidance for both Android and iOS\n- **Progressive session recovery backoff**: Replace fixed 2s delay with 2s/5s/10s/15s + adb reconnect\n\n## Context\nBuild 46057316 (Android AI Assisted Daily Build) failed with 20+ test failures across 13 stages, wasting ~4 hours of CI time. Root causes: emulator crashes, stale sign-in state, UI-stuck loops, FRE blocking, MFA walls, and session loss.\n\n## Test Plan\n- [x] `dotnet build` passes (0 errors)\n- [x] Unit tests: 79 passed, 2 failed (pre-existing LLM token failures, same as main)\n- [ ] Run Android AI Assisted Daily Build pipeline with this branch\n- [ ] Verify mandatory sign-in tests pass on clean emulator\n- [ ] Verify FRE screens are dismissed correctly\n- [ ] Verify stuck-UI tests fail fast (< 30 steps) instead of consuming 60-80 steps\n\nLinked work item: #11304771",
    "workItemRefs": [{"id": "11304771"}]
  }' | node -e "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{const r=JSON.parse(Buffer.concat(c));console.log('PR ID:', r.pullRequestId);console.log('URL:', r.url);console.log('Web URL:', r.repository ? 'https://office.visualstudio.com/OC/_git/AIHubServices/pullrequest/' + r.pullRequestId : 'N/A');if(r.message) console.log('Error:', r.message)})"
- **Script: Create ADO work item with single quotes to preserve $Task**: Create ADO work item with single quotes to preserve $Task: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null)

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json-patch+json" \
  'https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/wit/workitems/$Task?api-version=7.1' \
  -d '[
    {"op": "add", "path": "/fields/System.Title", "value": "Framework resilience fixes to reduce Android AI test automation CI failures"},
    {"op": "add", "path": "/fields/System.Description", "value": "Build 46057316 failed with 20+ test failures across 13 stages. This task implements P0+P1 framework fixes: system crash detection, per-step retry budgets, DOM change detection, app data clear on failure, FRE/MFA/credential handling in prompts, and progressive session recovery backoff."},
    {"op": "add", "path": "/fields/System.AreaPath", "value": "OC"},
    {"op": "add", "path": "/fields/Microsoft.VSTS.Common.Priority", "value": 1}
  ]' 2>&1 | head -20
- **Script: Create ADO work item with simpler area path**: Create ADO work item with simpler area path: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null)

# Try with full response to see what happened
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json-patch+json" \
  "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/wit/workitems/\$Task?api-version=7.1" \
  -d '[
    {"op": "add", "path": "/fields/System.Title", "value": "Framework resilience fixes to reduce Android AI test automation CI failures"},
    {"op": "add", "path": "/fields/System.Description", "value": "Build 46057316 failed with 20+ test failures across 13 stages. This task implements P0+P1 framework fixes: system crash detection, per-step retry budgets, DOM change detection, app data clear on failure, FRE/MFA/credential handling in prompts, and progressive session recovery backoff."},
    {"op": "add", "path": "/fields/System.AreaPath", "value": "OC"},
    {"op": "add", "path": "/fields/Microsoft.VSTS.Common.Priority", "value": 1}
  ]' 2>&1 | head -30
- **Script: Create ADO work item**: Create ADO work item: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null)

# Create a work item (Task type) in the OC project
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json-patch+json" \
  "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/wit/workitems/\$Task?api-version=7.1" \
  -d '[
    {"op": "add", "path": "/fields/System.Title", "value": "Framework resilience fixes to reduce Android AI test automation CI failures"},
    {"op": "add", "path": "/fields/System.Description", "value": "<p>Build 46057316 (Android AI Assisted Daily Build) failed with 20+ test failures across 13 stages due to 5 systemic framework gaps:</p><ol><li><b>System crash not detected</b>: Pixel Launcher crashes caused 3 wasted retries per test</li><li><b>No per-step retry budget</b>: Stuck UI consumed 60-80 of 100 execution steps</li><li><b>Stale sign-in state</b>: App data not cleared between retries, sign-in tests failed 4/4 times</li><li><b>No FRE/MFA/credential guidance</b>: LLM wasted retries on first-run screens and MFA walls</li><li><b>Fixed session recovery delay</b>: 2s wait insufficient for crashed emulators</li></ol><p>This task implements P0+P1 fixes across 8 files (264 lines) to address all 5 categories. Changes are cross-platform (Android + iOS).</p>"},
    {"op": "add", "path": "/fields/System.AreaPath", "value": "OC\\M365 Copilot Hub Front Door Service"},
    {"op": "add", "path": "/fields/Microsoft.VSTS.Common.Priority", "value": 1}
  ]' | node -e "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{const r=JSON.parse(Buffer.concat(c));console.log('Work Item ID:', r.id);console.log('URL:', r._links?.html?.href || r.url)})"
- **Exploration capture test**: Running E2E test of exploration capture pipeline - first exploration dispatched to verify capture and retrieval
- **Script: **: find "<USER_HOME>/project-memory/hooks" -type f | head -20
- **Script: Check explorations index**: Check explorations index: test -f "<USER_HOME>/project-memory/.ai-memory/explorations.jsonl" && wc -l "<USER_HOME>/project-memory/.ai-memory/explorations.jsonl" || echo "NO explorations.jsonl"
- **Exploration retrieval: pre-tool-use searches explorations via BM25 + graph, injects as systemMessage**: pre-tool-use.js searchExplorations() function: reads explorations.jsonl, BM25 scores against new prompt, also checks for research-only and exploration-only matches. Injects past exploration file path + metadata as systemMessage banner so Claude can Read the full file.
- **Exploration capture pipeline: PostToolUse -> markdown file + JSONL index + graph triples + entity index**: captureExploration() in post-tool-use.js: reads tool_response, extracts file paths + entities + tags, writes YAML-frontmatter markdown to explorations/, appends to explorations.jsonl index, extracts graph triples via extractTriplesFromEntry, updates entity-index.json, spawns background embedding build.
- **PostToolUse hook tool_response field contains Task agent output**: The Claude Code PostToolUse hook receives the agent's complete output in the 'tool_response' field (not 'tool_result'). The old code used input.tool_result which was always null. tool_response contains the full verbatim string for Task/Explore agents.
- **Script: Check which tools support both platforms**: Check which tools support both platforms: grep -n "supportedPlatforms.*AndroidMobile.*IosMobile\|supportedPlatforms.*IosMobile.*AndroidMobile" /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/DeviceInteractionServices/LocalTools/AppiumLocalToolsService.cs | head -5
- **Framework fixes must be cross-platform: Android AND iOS**: AppiumLocalTools codebase runs for both Android and iOS. Any fixes in Appium layer (ToolHandler, SessionManager, LocalToolsService) must support both platforms. ClearAppDataAsync should work on iOS too (use terminateApp or uninstall/reinstall pattern). System prompt additions should also be added to iOS system prompt.
- **Script: Verify inputSchema escaping matches existing tools**: Verify inputSchema escaping matches existing tools: grep -A1 'inputSchema.*appId' /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/DeviceInteractionServices/LocalTools/AppiumLocalToolsService.cs | head -6
- **Script: Read HandleResetApp exact code**: Read HandleResetApp exact code: sed -n '850,876p' /tmp/AIHubServices-fixes/tools/AppiumLocalTools/Handlers/AppiumToolHandler.cs
- **Script: Read HandleResetApp area for insertion point**: Read HandleResetApp area for insertion point: sed -n '875,895p' /tmp/AIHubServices-fixes/tools/AppiumLocalTools/Handlers/AppiumToolHandler.cs
- **Script: Read full TestOrchestrator for precise editing**: Read full TestOrchestrator for precise editing: cat /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/TestOrchestrator.cs
- **Script: Read CloseApp and ResetApp tool definitions**: Read CloseApp and ResetApp tool definitions: sed -n '295,330p' /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/DeviceInteractionServices/LocalTools/AppiumLocalToolsService.cs
- **Script: Find existing app lifecycle tools pattern**: Find existing app lifecycle tools pattern: grep -n "ResetAppAsync\|CloseAppAsync\|TerminateApp\|LocalTool.*reset\|LocalTool.*close" /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/DeviceInteractionServices/LocalTools/AppiumLocalToolsService.cs | head -15
- **Script: Read session recovery call site**: Read session recovery call site: sed -n '80,115p' /tmp/AIHubServices-fixes/tools/AppiumLocalTools/Handlers/AppiumToolHandler.cs
- **Script: Read TryRecoverSessionAsync implementation**: Read TryRecoverSessionAsync implementation: sed -n '55,110p' /tmp/AIHubServices-fixes/tools/AppiumLocalTools/SessionManagement/AppiumSessionManager.cs
- **Script: Read HandleResetApp and surrounding context**: Read HandleResetApp and surrounding context: sed -n '840,890p' /tmp/AIHubServices-fixes/tools/AppiumLocalTools/Handlers/AppiumToolHandler.cs
- **Script: Read SubstrateLlmAssistedTestExecutionService.cs**: Read SubstrateLlmAssistedTestExecutionService.cs: cat -n /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/IntelligenceServices/SubstrateLlmAssistedTestExecutionService.cs
- **Script: Read TestOrchestrator.cs**: Read TestOrchestrator.cs: cat -n /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/TestOrchestrator.cs
- **Script: Read IGUIInteractionService interface**: Read IGUIInteractionService interface: cat /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/DeviceInteractionServices/IGUIInteractionService.cs
- **Script: Find IGUIInteractionService interface**: Find IGUIInteractionService interface: grep -r "IGUIInteractionService" /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/Interfaces/ --include="*.cs" -l 2>/dev/null && cat /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/DeviceInteractionServices/IGUIInteractionService.cs 2>/dev/null | head -40 || grep -rl "interface IGUIInteractionService" /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/ --include="*.cs" | head -3
- **Script: Find TestStatus enum**: Find TestStatus enum: cat /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/Common/Models/TestStatus.cs 2>/dev/null || grep -r "enum TestStatus" /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/ --include="*.cs" -l
- **Script: Read TestCase model**: Read TestCase model: cat /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/Data/Models/TestCase.cs
- **Script: Read GuardRailResult model**: Read GuardRailResult model: cat /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/IntelligenceServices/Models/GuardRailResult.cs
- **Script: Read TestFileResult model**: Read TestFileResult model: cat /tmp/AIHubServices-fixes/tools/AIAssistedTestAutomation/Reporting/Models/TestFileResult.cs
- **Build 46057316 session loss: emulator died mid-test, 4 recovery attempts failed**: In ADALAISKU Bucket 2 (log 507), 59_TC_PreviewerPresentation_v2.md: Appium session lost after submitting positive feedback. TryRecoverSessionAsync tried 4 times — no connected Android device found within timeout. SessionManager only waits 2 seconds between retries, insufficient for crashed emulator.
- **Build 46057316 FRE blocking: ScanLaunch spent 50+ steps dismissing First Run Experience screens**: In ADALBCWAF Bucket 4 (log 499), 14_TC_ScanLaunch_v2.md: After Create → Scan, FRE privacy screen appeared. LLM tried Close → hit home, Next → hit another FRE (Dont send optional data), dismissed → landed on Copilot home. Repeated hamburger → Create → Scan → FRE loop consumed 50+ steps. No automated FRE suppression exists in framework.
- **Build 46057316 UI stuck pattern: Pages WebView consumed 66 steps with no DOM change**: In ADALAISKU Bucket 2 (log 524), 49_TC_LibPageRecallWeb_v2.md Step 19 (navigate back from Pages): LLM tried Back arrow by accessibilityId, resource-id XPath, Android BACK key x4. All returned success but no DOM change. 66 steps consumed. Similarly 59_TC_PreviewerFileOpen_v2.md bounced between Search screen and Word previewer for 80+ steps trying to find Show key takeaways button.
- **Build 46057316 MSA Premium: incorrect password + MFA + already-signed-in across 4 attempts**: In MSAPREMIUM Bucket 1 (log 406), 01_TC_SignIn_MSA_PREM.md: Attempt 1-2 hit Verify your phone number MFA screen. Attempt 3 found app already signed in. Attempt 4 reached password entry but got That password is incorrect for your Microsoft account error. Test account credentials expired or MFA policy changed.
- **Build 46057316 sign-in failure: already-signed-in state persists across all 4 retries**: In ADALAISKU Bucket 1 (log 402), 01_TC_SignIn_ADAL_SKU.md failed because app was already signed in — hamburger Menu visible, no Sign in button. LLM correctly detected mismatch at Step 2. All 4 retries hit same state because teardown only calls CloseAppAsync (not pm clear). Retries 2-4 also hit Pixel Launcher isn't responding system dialog.
- **Key architectural gap: LLM failure categories not propagated to orchestrator**: The LLM correctly distinguishes system crash vs stale state vs missing element vs UI stuck in its reasoning field, but reports all as flat TestStatus.Failed. The TestOrchestrator then retries blindly. Adding FailureCategory enum (SystemCrash, StaleState, MissingElement, UIStuck, CredentialError) to TestFileResult would enable smart retry decisions at orchestrator level.
- **Framework fix priorities for Android AI test automation pipeline**: P0 fixes: (1) Per-step retry budget + DOM change detection in execution loop, (2) ClearAppDataAsync before sign-in retries in teardown, (3) System crash pattern detection to skip retries + restart emulator. P1: (4) FRE suppression via shared prefs before tests, (5) Emulator restart on session loss, (6) MFA detection + credential pre-validation. P2: (7) Test precondition validation for missing UI elements.
- **Build 46057316: 5 root cause categories across 20+ failed tests**: Build 46057316 (Android AI Assisted Daily, branch jagadishp/android_issue_fixes_part2) failed with 5 root causes: (1) emulator instability - Pixel Launcher crashes, (2) stale sign-in state - app already signed in, (3) invalid credentials/MFA wall - MSA Premium, (4) UI stuck in WebView/context loss loops consuming 60-80 steps, (5) missing UI elements likely from feature changes. Mandatory sign-in failures blocked 8 of 13 stages.
- **System prompt has no MFA handling, no already-signed-in guidance**: AndroidAppiumSystemPrompt Section 5 says ANR/system-not-responding = terminate + fail + no retry. Section 7 LOGIN FLOW only covers email/password field text verification + retry approach (terminate+relaunch twice). No guidance for MFA screens, no guidance for already-signed-in state detection, no guidance for invalid credentials.
- **SubstrateLlmAssistedTestExecutionService: maxSteps=100 is only backstop for stuck UI**: InvokeExecutionAsync() runs a while loop up to maxSteps=100. No per-step retry budget exists — one test step can consume all 100 steps in state-recovery loops. LLM completion deferral allows up to 3 deferrals before forcing status. Critical errors (No devices found, fatal) break immediately.
- **Guard rails are mostly TODO stubs — only ActivateApp has real logic**: AndroidAppiumToolExecutionGuardRails.cs has per-tool guard rail methods (Click, Swipe, SendKeys, GetPageSource, LaunchApp, FindElement, Clear) but ALL return GuardRailResult.Allow() with TODO comments. Only ActivateAppAsync has real logic: blocks after 3 calls for non-mandatory tests.
- **Teardown does NOT clear app data between retries**: AppiumAndroidTestTearDown.ExecuteAsync() only calls CloseAppAsync for two packages (officehubrow + officehubrow.internal) and EndSessionAsync. Does NOT clear app data/cache via adb pm clear. This means stale sign-in state persists across retries.
- **TestOrchestrator retry logic: blind retries without failure category awareness**: TestOrchestrator.ExecuteWithRetriesAsync() retries with 1-second delay but does NOT inspect failure reason. Mandatory tests get 3 retries (RetryCount=3), regular tests get 1. Circuit breaker only triggers on device patterns (No devices found, ECONNREFUSED, session creation failed) — misses system crashes like Pixel Launcher isn't responding.
- **Script: Read teardown implementation**: Read teardown implementation: cat /tmp/AIHubServices/tools/AIAssistedTestAutomation/IntelligenceServices/AppiumAndroidTestTearDown.cs
- **Script: Read Android guard rails implementation**: Read Android guard rails implementation: cat /tmp/AIHubServices/tools/AIAssistedTestAutomation/IntelligenceServices/AndroidAppiumToolExecutionGuardRails.cs
- **Script: Read guard rails implementation**: Read guard rails implementation: cat /tmp/AIHubServices/tools/AIAssistedTestAutomation/Services/ToolExecutionGuardRails.cs 2>/dev/null || find /tmp/AIHubServices/tools/AIAssistedTestAutomation -name "*GuardRail*" -o -name "*guardRail*" -o -name "*guardrail*" | head -5
- **Script: Read Android system prompt (first 400 lines)**: Read Android system prompt (first 400 lines): cat /tmp/AIHubServices/tools/AIAssistedTestAutomation/SystemPrompts/AndroidAppiumSystemPrompt.cs | head -400
- **Script: Read LLM execution service source**: Read LLM execution service source: cat /tmp/AIHubServices/tools/AIAssistedTestAutomation/IntelligenceServices/SubstrateLlmAssistedTestExecutionService.cs
- **Script: Read TestOrchestrator source**: Read TestOrchestrator source: cat /tmp/AIHubServices/tools/AIAssistedTestAutomation/TestOrchestrator.cs
- **TestCase retry count configuration**: TestCase.UpdateProperties(sourceFolder) sets: isTestSetup = (sourceFolder == 'testsetup'), MandatoryToPass = isTestSetup. RetryCount = 3 if testsetup, 1 otherwise. Called in TestCase constructor when parsing test files from Data folder. Determines retry behavior: testsetup tests get 3 retries, regular tests get 1 retry.
- **Appium session recovery mechanism**: AppiumSessionManager stores _lastPlatformName, _lastAppiumServerUrl, _lastCapabilities for recovery. IsSessionHealthy() tries _driver.PageSource operation - returns false if exception. TryRecoverSessionAsync(): verifies stored config exists, forces cleanup of old driver (ForceCleanupDriver catches exceptions), waits 2s, calls StartSession() with saved config to create new session. Recovery used when session crashes to restore automation state.
- **AppiumAndroidTestTearDown workflow**: AppiumAndroidTestTearDown.ExecuteAsync() runs three independent steps: (1) CaptureScreenshotAsync - captures final screenshot with status timestamp to FinalScreenshotPath, (2) TerminateAppsAsync - loops through AppPackageNames (com.microsoft.office.officehubrow, internal) calling CloseAppAsync for each, (3) EndSessionAsync - calls EndSessionAsync to terminate Appium session. Each step catches/logs exceptions without propagating.
- **Retry decision framework in prompt**: AndroidAppiumSystemPrompt RETRY DECISION FRAMEWORK: Analyze execution history patterns for repetitive failures. Transient errors (network, loading) -> retry immediately. UI state changes -> retry once then alternative. Element not found -> wait and retry. App crashes/freezes -> mark Failed, no retry. UI stuck/unresponsive -> mark Failed, no retry. Same error 3x -> try alternative approach. Examples: loading spinner -> wait 3-5s then retry; element not found -> retry listing 5-6x then scroll.
- **Android system dialog handling in prompt**: AndroidAppiumSystemPrompt section 5 (APP NOT RESPONDING): 'If app not responding or system not responding error message comes, then terminate the app and mark test as Failed with proper reasoning and screenshot. No retry required.' Section 8: Device unavailability after 4 retries marks test Failed. Framework expects LLM to detect error patterns and decide termination vs retry.
- **SubstrateLlmAssistedTestExecutionService execution loop**: Execution loop in InvokeExecutionAsync: while stepNumber <= maxSteps (100). Gets LLM recommendation, captures DOM via CapturePageSourceAsync(). If LLM declares Passed/Failed + pending tool, defers completion (completionDeferralCount <3) to execute tool first. On Passed/Failed, sets testResult.TestStatus and exits loop. Tracks FailedSteps/SuccessfulSteps. Exits if stepNumber > maxSteps with error message.
- **Mandatory test failure stops execution**: When a test has MandatoryToPass=true and fails environment variable processing or final attempt fails after retries, TestOrchestrator logs '🛑 Mandatory test case X failed' and calls break to stop further test execution. Applies to testsetup tests from UpdateProperties().
- **TestOrchestrator retry logic**: TestOrchestrator uses ExecuteWithRetriesAsync loop: retryAttempt starts at 0, maxRetries from testCase.RetryCount. For testsetup (mandatory) tests: RetryCount=3, for regular tests: RetryCount=1. Circuit breaker detects device failures via error message patterns (No devices found, session creation failed, ECONNREFUSED, ECONNRESET). Stops after 2 consecutive device failures with health check.
- **Script: **: cat /tmp/AIHubServices/tools/AIAssistedTestAutomation/IntelligenceServices/SubstrateLlmAssistedTestExecutionService.cs | sed -n '300,500p'
- **Script: **: cat /tmp/AIHubServices/tools/AIAssistedTestAutomation/IntelligenceServices/SubstrateLlmAssistedTestExecutionService.cs | sed -n '140,300p'
- **Script: **: cat /tmp/AIHubServices/tools/AIAssistedTestAutomation/IntelligenceServices/SubstrateLlmAssistedTestExecutionService.cs | grep -A 10 -B 5 "already\|signed in\|Pixel Launcher\|isn't responding" | head -80
- **Script: **: cat /tmp/AIHubServices/tools/AIAssistedTestAutomation/IntelligenceServices/SubstrateLlmAssistedTestExecutionService.cs | head -150
- **Script: **: wc -l /tmp/AIHubServices/tools/AIAssistedTestAutomation/IntelligenceServices/SubstrateLlmAssistedTestExecutionService.cs
- **Script: **: cat /tmp/AIHubServices/tools/AIAssistedTestAutomation/TestOrchestrator.cs | grep -A 60 "ExecuteWithRetriesAsync"
- **Script: **: cat /tmp/AIHubServices/tools/AIAssistedTestAutomation/TestOrchestrator.cs | tail -400 | head -200
- **Script: SignIn ADAL SKU retry attempts 2-4 detailed flow**: SignIn ADAL SKU retry attempts 2-4 detailed flow: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null)

# Log 402: ADAL_SKU retry attempts 2-4 (already signed in pattern)
curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/logs/402" | grep -E "(═══ Step|testStep|testStatus|reasoning|hamburger|Menu|Sign in|already signed|Pixel Launcher|Attempt)" | sed -n '30,80p'
- **Script: Parse MSA Premium full failure flow**: Parse MSA Premium full failure flow: cat "<USER_HOME>\.claude\projects\C--Users-sungoyal-project-memory\044b978d-9a86-4419-a0d0-9218925adb54\tool-results\bgw3goskk.txt" | grep -E "(═══ Step|testStep|testStatus|reasoning|password|MFA|Verify your phone|incorrect|already signed|attempt|Mandatory|retries)" | head -80
- **Script: Deep dive into MSA Premium sign-in failure flow**: Deep dive into MSA Premium sign-in failure flow: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null)

# Deep dive: SignIn_MSA_PREM password/MFA failure (Log 406) - all 4 attempts
curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/logs/406" | grep -E "(═══ Step|toolName|toolType|testStep|testStatus|reasoning|password|MFA|Verify your phone|incorrect|Sign in|already signed|attempt)" | head -100
- **Script: Deep dive into SignIn already-signed-in failure flow**: Deep dive into SignIn already-signed-in failure flow: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null)

# Deep dive: SignIn_ADAL_SKU already-signed-in failure (Log 402) - full execution flow
curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/logs/402" | grep -E "(═══ Step|toolName|toolType|testStep|testStatus|reasoning|Pixel Launcher|Sign in|already signed|hamburger|Menu|content-desc)" | head -80
- **Script: Extract failure reasoning from all main test logs**: Extract failure reasoning from all main test logs: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null)

# Get reasoning for key failures
for log_id in 402 406 472 499 507 524 525; do
  echo "=== LOG $log_id: FAILURE REASONS ==="
  curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/logs/$log_id" | grep -E "(\"reasoning\".*Failed|test case '.*' (passed|failed)|testStatus.*Failed)" | head -10
  echo ""
done
- **Script: Extract test completion summaries from all bucket logs**: Extract test completion summaries from all bucket logs: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null)

# Get all Run UI Automation CLI and Retry logs, extract test completion lines
for log_id in 402 406 472 499 507 508 516 524 525; do
  echo "=== LOG $log_id ==="
  curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/logs/$log_id" | grep -E "(🏁 Test completed|✅ Successful|test case '.*' passed|test case '.*' failed|Mandatory test case|Retrying test)" | head -20
  echo ""
done
- **Script: Fetch TestScenarios Bucket 2/5 test outcome details**: Fetch TestScenarios Bucket 2/5 test outcome details: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/logs/507" | grep -E "(Test completed|test case|Passed|Failed|Mandatory|FAILED|results|retries)" | head -30
- **Script: Fetch TestScenarios Bucket 5/5 test outcome details**: Fetch TestScenarios Bucket 5/5 test outcome details: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/logs/524" | grep -E "(Test completed|test case|Passed|Failed|Mandatory|FAILED|results|retries)" | head -30
- **Script: Fetch ADALAISKU Bucket 4/5 test outcome details**: Fetch ADALAISKU Bucket 4/5 test outcome details: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/logs/499" | grep -E "(Test completed|test case|Passed|Failed|Mandatory|FAILED|results|retries)" | head -30
- **Script: Fetch Analyze Retry Results log for test outcome details**: Fetch Analyze Retry Results log for test outcome details: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/logs/590" | grep -E "(Test completed|test case|Passed|Failed|Mandatory|FAILED|results|retries|test_)" | head -30
- **Script: Fetch Run UI Automation CLI log (MSAPREMIUM Bucket 1/1)**: Fetch Run UI Automation CLI log (MSAPREMIUM Bucket 1/1): TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/logs/472" | tail -100
- **Script: Fetch Run UI Automation CLI log (ADALAISKU Bucket 4/5)**: Fetch Run UI Automation CLI log (ADALAISKU Bucket 4/5): TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/logs/406" | tail -100
- **Script: Fetch Run UI Automation CLI log (ADALAISKU Bucket 2/5) for test details**: Fetch Run UI Automation CLI log (ADALAISKU Bucket 2/5) for test details: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/logs/402" | tail -100
- **Script: Extract all failed records with error details and log IDs**: Extract all failed records with error details and log IDs: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/Timeline?api-version=7.1" | node -e "
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  const data = JSON.parse(Buffer.concat(chunks));
  const records = data.records || [];
  // Show failed items with details
  const failed = records.filter(r => r.result === 'failed');
  console.log('=== FAILED RECORDS (' + failed.length + ') ===\n');
  failed.forEach(r => {
    console.log('Type:', r.type, '| Name:', r.name);
    console.log('  Log ID:', r.log?.id, '| Log URL:', r.log?.url?.substring(0, 120));
    if (r.issues) r.issues.forEach(i => console.log('  ISSUE:', i.type, '-', i.message?.substring(0, 300)));
    console.log();
  });
  
  // Also show all stages/jobs summary
  console.log('=== ALL STAGES ===');
  records.filter(r => r.type === 'Stage').forEach(r => console.log(' ', (r.result||r.state).padEnd(12), r.name));
  console.log('\n=== ALL JOBS ===');
  records.filter(r => r.type === 'Job').forEach(r => console.log(' ', (r.result||r.state).padEnd(12), r.name));
});
"
- **Script: Fetch test runs associated with this build**: Fetch test runs associated with this build: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/OC/_apis/test/runs?buildUri=vstfs:///Build/Build/46057316&api-version=7.1" | node -e "
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  const data = JSON.parse(Buffer.concat(chunks));
  console.log('Test runs found:', data.count);
  (data.value || []).forEach(r => {
    console.log('Run:', r.id, '|', r.name, '| State:', r.state, '| Total:', r.totalTests, '| Passed:', r.passedTests, '| Failed:', r.unanalyzedTests || r.totalTests - r.passedTests);
  });
});
"
- **Script: Fetch build timeline - all stages/jobs/tasks with pass/fail status**: Fetch build timeline - all stages/jobs/tasks with pass/fail status: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/build/builds/46057316/Timeline?api-version=7.1" | node -e "
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  const data = JSON.parse(Buffer.concat(chunks));
  const records = data.records || [];
  // Show all records with their result/state
  records.forEach(r => {
    if (r.type === 'Stage' || r.type === 'Job' || r.type === 'Task') {
      const icon = r.result === 'succeeded' ? 'PASS' : r.result === 'failed' ? 'FAIL' : r.result === 'skipped' ? 'SKIP' : r.state || r.result || '???';
      console.log(icon.padEnd(10), r.type.padEnd(6), r.name);
      if (r.result === 'failed' && r.issues && r.issues.length > 0) {
        r.issues.forEach(i => console.log('           ERROR:', i.message?.substring(0, 200)));
      }
    }
  });
});
"
- **Script: Fetch build details via ADO REST API**: Fetch build details via ADO REST API: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/OC/_apis/build/builds/46057316?api-version=7.1" | python3 -m json.tool 2>/dev/null || curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/OC/_apis/build/builds/46057316?api-version=7.1" | node -e "process.stdin.on('data',d=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
- **Script: Check recent graph triples**: Check recent graph triples: tail -10 "<USER_HOME>/project-memory/.ai-memory/graph.jsonl"
- **E2E test: project-memory pipeline validation** [30]: End-to-end test verifying save-research, check-memory, graph extraction, and session-summary all work correctly in sequence
- **Script: **: find "<USER_HOME>/project-memory/.ai-memory" -type f -name "*.json" | head -15
- **Script: **: find "<USER_HOME>/project-memory/hooks/scripts" -type f -name "*.js"
- **Script: **: ls -la "<USER_HOME>/project-memory/hooks/" | head -20
- **Hybrid graph+embeddings architecture for code memory search**: Best approach: embeddings find semantically similar entry points, graph traversal expands context with related entities. Flow: (1) embed query, (2) cosine similarity finds top entries, (3) graph traverse from those entries to find dependencies/relationships/fixes, (4) return enriched results. Microsoft GraphRAG uses similar pattern: entity extraction → graph build → community detection → hybrid search. LevelGraph for structure, ONNX MiniLM for similarity.
- **LevelGraph: lightweight embedded graph DB for Node.js**: LevelGraph is a graph DB built on LevelDB via the 'level' npm package. Runs in Node.js and browsers. Uses hexastore approach (6 indices per triple) for fast graph traversal. Stores triples as subject-predicate-object. Supports JSON-LD, Turtle, N3 formats. npm package: levelgraph. Zero external server dependency — fully embedded. Ideal for local knowledge graphs in plugins.
- **GraphRAG entity and relationship extraction using LLMs**: GraphRAG combines text extraction, network analysis, LLM prompting into end-to-end RAG system. Extraction: LLM prompted to extract named entities + descriptions, relationships between entity pairs in each text unit. FastGraphRAG substitutes LLM reasoning with traditional NLP (NLTK, spaCy for noun phrases). Process: slice input into TextUnits, extract entities/relationships/claims, build community hierarchy, generate summaries. Local search combines structured KG + unstructured documents at query time. Entity/relationship extraction implementation customizable via LangChain/LlamaIndex.
- **Neo4j embedded and lightweight alternatives for Node.js**: True embedded Neo4j for Node.js is limited: node-neo4j-embedded package exists but appears outdated. Neo4j alternatives for Node.js: Titan, MongoDB, Cassandra, OrientDB, JanusGraph, Supabase, Prisma, PostgreSQL, Redis, Hasura, MySQL, CockroachDB. SQLite offers embedded, serverless, local storage without server but is not graph-specialized. For modern local graph DB with Node.js, consider running lightweight Neo4j service via Docker or exploring LevelGraph/TerminusDB/Gun alternatives instead.
- **Hybrid embeddings + graph structure for knowledge representation**: Embeddings (numerical vectors) and knowledge graphs (structured nodes+edges) are complementary: embeddings capture semantic/contextual similarity, graphs model real-world entities and relationships explicitly. GNNs unify both via differentiable message passing combining statistical learning + symbolic logic. Embeddings enhance KGs by adding numerical semantics, KGs improve embeddings through graph-based constraints. Models like TGrail combine topological + entity-type information. Hybrid approach useful for RAG, link prediction, recommendations, QA systems.
- **Knowledge graphs for code memory and dependency traversal**: Knowledge graphs for code capture structural relationships (inheritance, composition, method calls, imports) as explicit edges enabling multi-hop reasoning for dependency discovery. Build by parsing files with AST to identify classes, methods, variables. Queries like 'refactor auth flow' use vector search for semantic relevance then graph traversal for structural dependencies. Hybrid indexing combines embeddings, keyword search, graph traversal for rapid retrieval independent of graph scale.
- **RDF triple stores and semantic web in JavaScript**: RDF triplestore is purpose-built database for SPO (subject-predicate-object) triples. JavaScript options: rdflib.js (semantic web database, Fetcher helper for read-write web), rdfstore-js (pure JS RDF graph store with SPARQL support, browser/Node.js), 33+ RDF libraries on rdf.js.org. Many expose SPARQL endpoints queryable from JS via fetch. RDF extends web linking with URIs for relationships.
- **SQLite graph database using adjacency lists and CTEs**: SQLite has no built-in graph model but supports adjacency lists effectively: nodes table + relationships/edges table with foreign keys. Query traversals via CTEs and transitive_closure extension for recursive queries. Tools: Graphlite (adjacency lists + graph traversals), simple-graph (JSON nodes, edge pairs, traversal functions via CTEs), sqlite-graph extension (nodes+edges with properties, Cypher queries).
- **Relationship extraction from text using dependency parsing and GNNs**: Relationships extracted from text using: (1) dependency parsing structure, (2) co-occurrence analysis (entities in same sentence = related), (3) GNNs + attention mechanisms for inference/validation. Graph-based extraction organizes analysis results into graph structure. LLMs can extract relationships directly from text contextually without predefined labels, more adaptive than rule-based approaches.
- **Entity extraction from text for knowledge graphs**: Entity extraction uses NER (Named Entity Recognition) to identify entities from text (concepts, people, organizations, locations, products). Entities become nodes in knowledge graph. Entity types grouped into categories: Person, Organization, Location, Product, Event. LLMs can extract entities without predefined labels, adaptive to context, more robust for unseen data than rule-based NER.
- **Cayley: Open-source graph database inspired by Google Knowledge Graph**: Cayley is open-source graph database inspired by Google's Knowledge Graph. Written in Go with official JavaScript client library (@cayleygraph/cayley). Supports RDF/Linked Data (NQuads, JSON-LD), works on top of SQL/NoSQL/KV databases. Query languages: Gizmo (Gremlin dialect), MQL, GraphQL. Node-cayley npm package available as alternative.
- **Gun.js: Decentralized offline-first graph database**: GUN is open-source, offline-first, real-time, decentralized graph database in JavaScript for web/Node.js. Fully P2P (peer-to-peer, multi-master), no centralized server. Uses CRDT (commutative replicated data type) for sync. Lightweight (~9KB gzipped), 20M+ API ops/sec. Data stored as graph with records connected by references ('souls'). Supports offline + eventual consistency sync.
- **Microsoft GraphRAG: Graph-based RAG combining text extraction, network analysis, LLM prompting**: GraphRAG (Graphs + RAG) combines text extraction, network analysis, and LLM prompting/summarization into end-to-end system. Local implementations: use OpenAI-compatible APIs with local models (Ollama, Nomic-Embed-Text). GraphRAG-Local-UI project provides FastAPI server + Gradio interface. Models can be GGUF format for reduced size/faster loading via llama.cpp.
- **TerminusDB: Open-source graph database with JSON document API**: TerminusDB is an open-source graph database and document store linking/processing structured/unstructured JSON documents in a knowledge graph via simple document API. Provides Node.js/browser client (npm registry). Features: closed-world RDF knowledge graph, high in-memory performance, controlled document API with JSON-LD syntax, GraphQL queries, datalog logical engine.
- **LevelGraph: LevelDB-based graph database for Node.js**: LevelGraph is a graph database built on LevelDB through the level library, usable in Node.js and browsers. Follows Hexastore approach with six indices per triple for fast access. Supports Linked Data formats: JSON-LD, Turtle, N3. Lightweight alternative to traditional graph DBs.
- **HydraDB architecture and capabilities**: HydraDB is a serverless context infrastructure for AI systems that stores context, relationships, decisions, and timeline evolution. Positions itself differently from vector databases: stores relationships, decisions, and timeline (vector DBs are flat document indexes with no relationships). Ultra-low latency in-memory data stores with highest precision recall and relational awareness.
- **Script: Check raw API response**: Check raw API response: TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null) && curl -s -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isDisabled": false}' \
  "https://office.visualstudio.com/e853b87d-318c-4879-bedc-5855f3483b54/_apis/git/repositories/af16575a-e946-4581-8a77-efdeac7bea84?api-version=7.1"

_(22 older findings filtered — older than 7 days. Run check-memory.js to search all including stale.)_

<!-- project-memory-research:end -->
