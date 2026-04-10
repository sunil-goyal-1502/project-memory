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
- DOM progress tracking belongs in platform-specific guard rails, not common execution service — Jagadish review: SubstrateLlmAssistedTestExecutionService is shared across all platforms/MCP clients. Guard rail's ApplyGuardRails receives executionHistory with DomXml per step, so it can detect stuck UI by examining history. Moved CheckDomProgressGuardRail + IsReadOnlyTool + ComputeSimpleHash to AndroidAppiumToolExecutionGuardRails.
- Single daemon serving all projects via per-project data map — User wants one daemon process, not per-project daemons. Single daemon with Map<projectRoot, {research, bm25, graph, scripts, explorations}> to serve multiple sessions. Port file at ~/.ai-memory-daemon-port (global). Hooks pass projectRoot in IPC request.

## Constraint
- Only store reusable scripts with real logic — not trivial one-liner commands — Commands like cat, grep, find, ls, head, tail, sed are general-purpose tools Claude can generate on-the-fly. isReusableScript() filters these out. Only multi-step scripts with auth, API calls, loops, or data processing pipelines are saved to scripts.jsonl.

## Testing
- E2E tests should cover save, search, graph, and session-summary pipeline — Validates the full project-memory lifecycle in a single pass

<!-- project-memory:end -->

<!-- project-memory-research:start -->
## Research Memory
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

_(122 older findings filtered — older than 7 days. Run check-memory.js to search all including stale.)_

_All 122 findings are older than 7 days. Run check-memory.js to search them._

<!-- project-memory-research:end -->

<!-- project-memory-scripts:start -->
## Script Library
<!-- Auto-managed by project-memory plugin. Do not edit between markers. -->

10 script templates (50 total scripts). **Reuse these — fill in {{params}} instead of rebuilding commands:**

- **Analyze high-value and low-value entries** (5 variants, 5x total): `node -e "
const fs = require('fs');
const readline = require('readline');

let entries = [];
const rl = readline.createInterface({
  input: fs.createReadStream('<USER_HOME>/project-memory/.ai-memory/research.jsonl'),
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  try {
    entries.push(JSON.parse(line));
  } catch (e) {}
});

rl.on('close', () => {
  // Find high-value entries (non-script, good tag coverage, reasonable length, recent)
  const nonScriptEntries = entries.filter(e => !e.topic?.startsWith('Script:'));
  
  // Score entries for quality
  const scored = nonScriptEntries.map(e => {
    let score = 0;
    score += e.tags?.length || 0; // tag count
    score += Math.min((e.finding?.length || 0) / 500, 2); // length (max 2 points)
    score += e.confidence || 0; // confidence
    const days = (new Date() - new Date(e.ts)) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 7 - days) / 7; // recency (max 1 point)
    return { entry: e, score };
  }).sort((a, b) => b.score - a.score);
  
  console.log('=== HIGH-VALUE ENTRIES (top 10) ===');
  console.log('');
  scored.slice(0, 10).forEach((item, i) => {
    const e = item.entry;
    const days = ((new Date() - new Date(e.ts)) / (1000 * 60 * 60 * 24)).toFixed(1);
    console.log('[HIGH ' + (i+1) + '] Score:', item.score.toFixed(2));
    console.log('  Topic:', e.topic);
    console.log('  Finding:', e.finding.substring(0, 150) + (e.finding.length > 150 ? '...' : ''));
    console.log('  Tags:', e.tags?.join(', '));
    console.log('  Age:', days, 'days | Confidence:', e.confidence);
    console.log('');
  });
  
  // Low-value entries (script-only, very short, low tags)
  const lowValue = entries.filter(e => {
    const isScript = e.topic?.startsWith('Script:');
    const short = (e.finding?.length || 0) < 120;
    const lowTags = (e.tags?.length || 0) < 2;
    return isScript || (short && lowTags);
  });
  
  console.log('=== LOW-VALUE ENTRIES (script + low metadata) ===');
  console.log('Count:', lowValue.length, 'of', entries.length, '(' + (lowValue.length/entries.length*100).toFixed(1) + '%)');
  console.log('');
  
  lowValue.slice(0, 8).forEach((e, i) => {
    console.log('[LOW ' + (i+1) + ']');
    console.log('  Topic:', e.topic?.substring(0, 60) || '(empty)');
    console.log('  Finding:', e.finding?.substring(0, 100) || '(empty)');
    console.log('  Tags:', (e.tags?.length || 0), '| Length:', (e.finding?.length || 0), 'chars');
    console.log('');
  });
});
"
`
  Variants: Analyze high-value and low-value entries, Check what Script: references remain in research, Debug script BM25 search +2 more
- **Reply to T31 with refactoring details** (2 variants, 4x total): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv 2>/dev/null)

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://office.visualstudio.com/{{uuid}}/_apis/git/repositories/{{repo_id}}/pullRequests/{{pullRequest_id}}/threads/62184012/comments?api-version=7.1" \
  -d '{"content":"Refactored in commit 3a895d9. Moved all DOM progress tracking out of the common SubstrateLlmAssistedTestExecutionService and into AndroidAppiumToolExecutionGuardRails as a guard rail (CheckDomProgressGuardRail). The guard rail examines DomXml from executionHistory to detect stuck UI. IsReadOnlyTool and ComputeSimpleHash are now private to the guard rail class. The execution service is fully platform-agnostic again — 65 lines removed from it, 72 lines added to the platform-specific guard rail.","parentCommentId":1}' 2>&1 | python3 -c "import sys,json;print('Reply:', json.load(sys.stdin).get('id','ERR'))"`
  Variants: Reply to T31 with refactoring details, Reply to T31 with shorter message
  Params: `{{resource_id}}`, `{{uuid}}`, `{{repo_id}}`, `{{pullRequest_id}}`
- **Fetch build timeline - all stages/jobs/tasks with pass/fail status** (3 variants, 3x total): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/{{uuid}}/_apis/build/builds/{{build_id}}/Timeline?api-version=7.1" | node -e "
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
"`
  Variants: Fetch build timeline - all stages/jobs/tasks with pass/fail status, Fetch test runs associated with this build, Extract all failed records with error details and log IDs
  Params: `{{resource_id}}`, `{{uuid}}`, `{{build_id}}`
- **Fetch Analyze Retry Results log for test outcome details** (2 variants, 3x total): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/{{uuid}}/_apis/build/builds/{{build_id}}/logs/{{log_id}}" | grep -E "(Test completed|test case|Passed|Failed|Mandatory|FAILED|results|retries|test_)" | head -30`
  Variants: Fetch Analyze Retry Results log for test outcome details, Fetch ADALAISKU Bucket 4/5 test outcome details
  Params: `{{resource_id}}`, `{{uuid}}`, `{{build_id}}`, `{{log_id}}`
- **Fetch Run UI Automation CLI log (ADALAISKU Bucket 2/5) for test details** (2x): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv 2>/dev/null) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/{{uuid}}/_apis/build/builds/{{build_id}}/logs/{{log_id}}" | tail -100`
  Params: `{{resource_id}}`, `{{uuid}}`, `{{build_id}}`, `{{log_id}}`
- **Analyze research.jsonl structure and compute statistics** (2 variants, 2x total): `cat "<USER_HOME>/project-memory/.ai-memory/research.jsonl" | node -e "
const readline = require('readline');
const fs = require('fs');

let total = 0;
let scriptEntries = 0;
let tags0 = 0, tags1 = 0, tags2plus = 0;
let findingLengths = [];
let byTopic = {};
let scriptSamples = [];
let noisePatterns = {};
let staleDates = [];
let entries = [];

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  try {
    const entry = JSON.parse(line);
    total++;
    entries.push(entry);
    
    // Count script entries
    if (entry.finding && entry.finding.startsWith('Script: ')) {
      scriptEntries++;
      if (scriptSamples.length < 5) scriptSamples.push(entry);
    }
    
    // Tag distribution
    const tagCount = (entry.tags || []).length;
    if (tagCount === 0) tags0++;
    else if (tagCount === 1) tags1++;
    else tags2plus++;
    
    // Finding length
    const len = (entry.finding || '').length;
    findingLengths.push(len);
    
    // Topic distribution
    if (!byTopic[entry.topic]) byTopic[entry.topic] = 0;
    byTopic[entry.topic]++;
    
    // Staleness dates
    if (entry.ts) staleDates.push(entry.ts);
    
  } catch (e) {
    console.error('Parse error:', e.message);
  }
});

rl.on('close', () => {
  console.log('=== BASIC STATS ===');
  console.log('Total entries:', total);
  console.log('Script entries:', scriptEntries, '(' + (scriptEntries / total * 100).toFixed(1) + '%)');
  console.log('');
  
  console.log('=== TAG DISTRIBUTION ===');
  console.log('0 tags:', tags0, '(' + (tags0 / total * 100).toFixed(1) + '%)');
  console.log('1 tag:', tags1, '(' + (tags1 / total * 100).toFixed(1) + '%)');
  console.log('2+ tags:', tags2plus, '(' + (tags2plus / total * 100).toFixed(1) + '%)');
  console.log('');
  
  console.log('=== FINDING LENGTH STATS ===');
  findingLengths.sort((a,b) => a-b);
  const avg = findingLengths.reduce((a,b) => a+b, 0) / findingLengths.length;
  const median = findingLengths[Math.floor(findingLengths.length / 2)];
  console.log('Average length:', avg.toFixed(0), 'chars');
  console.log('Median length:', median, 'chars');
  console.log('Min length:', findingLengths[0], 'chars');
  console.log('Max length:', findingLengths[findingLengths.length-1], 'chars');
  console.log('< 50 chars:', findingLengths.filter(x => x < 50).length);
  console.log('50-200 chars:', findingLengths.filter(x => x >= 50 && x < 200).length);
  console.log('200-500 chars:', findingLengths.filter(x => x >= 200 && x < 500).length);
  console.log('> 500 chars:', findingLengths.filter(x => x >= 500).length);
  console.log('');
  
  console.log('=== TOP TOPICS (noise concentration) ===');
  const topicsSorted = Object.entries(byTopic).sort((a,b) => b[1] - a[1]).slice(0, 15);
  topicsSorted.forEach(([topic, count]) => {
    console.log(topic.padEnd(50), count.toString().padStart(3), '(' + (count/total*100).toFixed(1) + '%)');
  });
  console.log('');
  
  console.log('=== STALENESS ANALYSIS ===');
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  let stale = 0;
  staleDates.sort();
  staleDates.forEach(date => {
    const d = new Date(date);
    if (d < sevenDaysAgo) stale++;
  });
  console.log('Oldest entry:', staleDates[0]);
  console.log('Newest entry:', staleDates[staleDates.length-1]);
  console.log('Entries > 7 days old:', stale, '(' + (stale/total*100).toFixed(1) + '%)');
  console.log('');
  
  console.log('=== SCRIPT SAMPLES ===');
  scriptSamples.forEach((e, i) => {
    console.log('[' + (i+1) + '] Topic:', e.topic);
    console.log('    Finding:', e.finding.substring(0, 120) + '...');
    console.log('');
  });
});
"
`
  Variants: Analyze research.jsonl structure and compute statistics, Analyze script entries and duplicate topics
- **Identify exact duplicates and confidence analysis** (2x): `node -e "
const fs = require('fs');
const readline = require('readline');

let entries = [];
const rl = readline.createInterface({
  input: fs.createReadStream('<USER_HOME>/project-memory/.ai-memory/research.jsonl'),
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  try {
    entries.push(JSON.parse(line));
  } catch (e) {}
});

rl.on('close', () => {
  // Identify exact duplicates
  const topicDuplicates = {};
  entries.forEach((e, idx) => {
    const topic = e.topic;
    if (!topicDuplicates[topic]) topicDuplicates[topic] = [];
    topicDuplicates[topic].push(idx);
  });
  
  const exactDupes = Object.entries(topicDuplicates)
    .filter(([_, indices]) => indices.length > 1)
    .map(([topic, indices]) => {
      return {
        topic,
        count: indices.length,
        indices,
        entries: indices.map(i => entries[i])
      };
    });
  
  console.log('=== EXACT DUPLICATE TOPICS ===');
  exactDupes.forEach(dup => {
    console.log('Topic: ' + dup.topic);
    console.log('Count: ' + dup.count);
    dup.entries.forEach((e, i) => {
      console.log('  Entry ' + (i+1) + ' (id=' + e.id + ', date=' + e.ts.substring(0, 10) + ')');
      console.log('    Finding len: ' + e.finding.length + ' | Tags: ' + e.tags.length);
      const finding = e.finding.substring(0, 100);
      console.log('    \"' + finding + (e.finding.length > 100 ? '...\"' : '\"'));
    });
    console.log('');
  });
  
  // Finding length by confidence
  console.log('=== ENTRIES BY CONFIDENCE LEVEL ===');
  const byConfidence = {};
  entries.forEach(e => {
    const conf = e.confidence || 0.5;
    if (!byConfidence[conf]) byConfidence[conf] = [];
    byConfidence[conf].push(e);
  });
  
  Object.entries(byConfidence)
    .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
    .forEach(([conf, list]) => {
      console.log('Confidence ' + conf + ': ' + list.length + ' entries');
      const avgLen = list.reduce((sum, e) => sum + (e.finding?.length || 0), 0) / list.length;
      console.log('  Avg finding length: ' + avgLen.toFixed(0) + ' chars');
    });
});
"
`
- **Fetch ADO work item details** (2x): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv) && curl -s -H "Authorization: Bearer $TOKEN" "https://office.visualstudio.com/{{uuid}}/_apis/wit/workitems/{{workitem_id}}?api-version=7.1"`
  Params: `{{resource_id}}`, `{{uuid}}`, `{{workitem_id}}`
- **Debug T13 reply failure** (2 variants, 2x total): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv 2>/dev/null)
REPO="{{uuid}}"
PROJECT="{{uuid_2}}"
PR=4969737

# Debug: try T13 reply and see full response
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://office.visualstudio.com/${PROJECT}/_apis/git/repositories/${REPO}/pullRequests/${PR}/threads/62162793/comments?api-version=7.1" \
  -d '{"content":"Good catch, fixed in commit 525b97f. ClearAppData is now scoped to sign-in tests only (01_TC_SignIn*). Regular test failures no longer trigger a data clear, so credentials stay intact for subsequent tests in the bucket. See IsMandatorySignInTest() helper in AppiumAndroidTestTearDown.cs.","parentCommentId":1}' 2>&1 | head -5`
  Variants: Debug T13 reply failure, Post T14 reply and check T15 status
  Params: `{{resource_id}}`, `{{uuid}}`, `{{uuid_2}}`
- **Check raw API response** (1x): `TOKEN=$(az account get-access-token --resource {{resource_id}} --query accessToken -o tsv 2>/dev/null) && curl -s -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isDisabled": false}' \
  "https://office.visualstudio.com/{{uuid}}/_apis/git/repositories/{{repo_id}}?api-version=7.1"`
  Params: `{{resource_id}}`, `{{uuid}}`, `{{repo_id}}`

<!-- project-memory-scripts:end -->
