#!/usr/bin/env node
"use strict";

/**
 * Project Memory Dashboard — persistent global web UI.
 *
 * Auto-started by session-start.js as a detached background process.
 * Runs across all sessions, survives session restarts.
 *
 * Usage:
 *   node scripts/dashboard.js [port]          — start in foreground
 *   node scripts/dashboard.js --background    — start detached (used by hooks)
 *   node scripts/dashboard.js --stop          — stop running instance
 *   node scripts/dashboard.js --status        — check if running
 *
 * Default: http://localhost:3777
 */

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { resolveProjectRoot, readJsonl } = require(path.join(__dirname, "shared.js"));
const embeddingsModule = require(path.join(__dirname, "embeddings.js"));
const { readEmbeddings } = embeddingsModule;

const DEFAULT_PORT = 3777;
const primaryRoot = resolveProjectRoot(false) || process.cwd();
const primaryMemDir = path.join(primaryRoot, ".ai-memory");
const PID_FILE = path.join(primaryMemDir, ".dashboard.pid");

// ── Discover ALL projects with .ai-memory across the machine ──

function discoverAllProjects() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return [primaryRoot];

  const projects = new Set();
  if (fs.existsSync(path.join(primaryRoot, ".ai-memory"))) projects.add(primaryRoot);

  // Scan home up to 5 levels deep (includes nested projects)
  function scanDir(dir, depth) {
    if (depth > 5) return;
    try {
      const memDir = path.join(dir, ".ai-memory");
      if (fs.existsSync(memDir) && fs.existsSync(path.join(memDir, "research.jsonl"))) {
        projects.add(dir);
      }
      if (depth < 5) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
            // Allow scanning inside .claude for stray cache .ai-memory dirs
            scanDir(path.join(dir, entry.name), depth + 1);
          }
        }
      }
    } catch { /* permission errors */ }
  }

  scanDir(home, 0);
  return Array.from(projects);
}

// ── CLI commands ──

const args = process.argv.slice(2);

if (args.includes("--stop")) {
  stopDashboard();
  process.exit(0);
}

if (args.includes("--status")) {
  checkStatus();
  process.exit(0);
}

if (args.includes("--background")) {
  // Re-spawn self as detached process without --background flag
  const { spawn } = require("child_process");
  const port = getPortArg() || DEFAULT_PORT;
  const child = spawn(process.execPath, [__filename, String(port)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: primaryRoot,
  });
  child.unref();
  console.log(`Dashboard spawned in background (PID: ${child.pid}, port: ${port})`);
  process.exit(0);
}

function getPortArg() {
  for (const a of args) {
    const n = parseInt(a);
    if (!isNaN(n) && n > 0 && n < 65536) return n;
  }
  return null;
}

function stopDashboard() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim());
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(PID_FILE);
    console.log(`Dashboard stopped (PID: ${pid})`);
  } catch {
    console.log("No dashboard running.");
  }
}

function checkStatus() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim());
    process.kill(pid, 0); // check if alive
    console.log(`Dashboard running (PID: ${pid})`);
  } catch {
    console.log("Dashboard not running.");
  }
}

// ── Port availability check ──

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => { srv.close(); resolve(true); });
    srv.listen(port, "127.0.0.1");
  });
}

// ── Session history tracking (aggregated across all projects) ──

function readAllSessionHistory(projects) {
  const all = [];
  for (const p of projects) {
    const logPath = path.join(p, ".ai-memory", "session-history.jsonl");
    const entries = readJsonl(logPath);
    for (const e of entries) { e._project = path.basename(p); }
    all.push(...entries);
  }
  return all.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
}

function recordSessionEvent(event) {
  try {
    fs.appendFileSync(path.join(primaryMemDir, "session-history.jsonl"),
      JSON.stringify({ ...event, ts: new Date().toISOString() }) + "\n", "utf-8");
  } catch { /* non-critical */ }
}

// ── API data builder (aggregates ALL projects) ──

function getApiData() {
  const projects = discoverAllProjects();
  const home = process.env.USERPROFILE || process.env.HOME || "";

  const allResearch = [];
  const allDecisions = [];
  const allEmbeddedIds = new Set();
  const allExplorationLog = [];
  const projectList = [];
  let totalTokensSaved = 0, totalTimeSaved = 0, totalHits = 0;
  let memoryCheckHits = 0, sessionLoads = 0, researchSearchHits = 0, duplicatesAvoided = 0;

  for (const p of projects) {
    const memDir = path.join(p, ".ai-memory");
    const projectName = path.relative(home, p).replace(/\\/g, "/") || path.basename(p);

    // Read entries and tag with project name
    const research = readJsonl(path.join(memDir, "research.jsonl"));
    for (const r of research) { r._project = projectName; }
    allResearch.push(...research);

    const decisions = readJsonl(path.join(memDir, "decisions.jsonl"));
    for (const d of decisions) { d._project = projectName; }
    allDecisions.push(...decisions);

    // Read embeddings from this project
    const embeddings = readEmbeddings(p);
    for (const id of Object.keys(embeddings)) allEmbeddedIds.add(id);

    // Read exploration log
    try {
      const logPath = path.join(memDir, ".exploration-log");
      if (fs.existsSync(logPath)) {
        const log = readJsonl(logPath);
        for (const l of log) { l._project = projectName; }
        allExplorationLog.push(...log);
      }
    } catch {}

    // Aggregate stats
    let metadata = {};
    try { metadata = JSON.parse(fs.readFileSync(path.join(memDir, "metadata.json"), "utf-8")); } catch {}
    const stats = metadata.stats || {};
    const ec = stats.eventCounts || {};
    totalTokensSaved += stats.totalTokensSaved || 0;
    totalTimeSaved += stats.totalTimeSavedSeconds || 0;
    totalHits += stats.totalHits || 0;
    memoryCheckHits += ec.memory_check_hit || 0;
    sessionLoads += (ec.session_load_research || 0) + (ec.session_load_decision || 0);
    researchSearchHits += ec.research_search_hit || 0;
    duplicatesAvoided += ec.duplicate_save_avoided || 0;

    projectList.push({
      name: projectName,
      path: p,
      research: research.length,
      decisions: decisions.length,
      embedded: [...research, ...decisions].filter(e => allEmbeddedIds.has(e.id)).length,
    });
  }

  const allEntries = [...allResearch, ...allDecisions];
  const totalEntries = allEntries.length;
  const embeddedCount = allEntries.filter(e => allEmbeddedIds.has(e.id)).length;

  // Graph stats (cross-project)
  let graphStats = { totalTriples: 0, totalEntities: 0, avgConnections: 0, topEntities: [], projectTriples: [] };
  try {
    const graphMod = require(path.join(__dirname, "graph.js"));
    const globalGraph = graphMod.buildGlobalGraph(projects);
    const entityNames = Object.keys(globalGraph.adjacencyIndex);
    const topEntities = entityNames
      .map(e => ({ name: e, connections: globalGraph.adjacencyIndex[e].length }))
      .sort((a, b) => b.connections - a.connections)
      .slice(0, 20);

    graphStats = {
      totalTriples: globalGraph.triples.length,
      totalEntities: entityNames.length,
      avgConnections: entityNames.length > 0 ? Math.round(globalGraph.triples.length * 2 / entityNames.length * 10) / 10 : 0,
      topEntities,
      projectTriples: globalGraph.projectStats,
    };
  } catch { /* graph not available */ }

  // Timeline: group entries by date
  const timeline = {};
  for (const e of allEntries) {
    const date = (e.ts || "").substring(0, 10);
    if (!date) continue;
    if (!timeline[date]) timeline[date] = { research: 0, decisions: 0 };
    if (e.finding) timeline[date].research++;
    else timeline[date].decisions++;
  }

  // Session history across all projects
  const sessionHistory = readAllSessionHistory(projects);

  // Tag frequency
  const tagFreq = {};
  for (const r of allResearch) {
    for (const t of (r.tags || [])) tagFreq[t] = (tagFreq[t] || 0) + 1;
  }
  const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 20);

  // Heatmap: project × tag matrix
  const heatmapTags = topTags.slice(0, 12).map(t => t[0]); // top 12 tags
  const heatmap = {};
  for (const r of allResearch) {
    const proj = r._project || "unknown";
    if (!heatmap[proj]) heatmap[proj] = {};
    for (const t of (r.tags || [])) {
      if (heatmapTags.includes(t)) {
        heatmap[proj][t] = (heatmap[proj][t] || 0) + 1;
      }
    }
  }

  return {
    research: allResearch.map(r => ({ ...r, embedded: allEmbeddedIds.has(r.id) })),
    decisions: allDecisions.map(d => ({ ...d, embedded: allEmbeddedIds.has(d.id) })),
    stats: {
      totalResearch: allResearch.length,
      totalDecisions: allDecisions.length,
      totalEntries,
      embeddedCount,
      embeddingCoverage: totalEntries > 0 ? Math.round((embeddedCount / totalEntries) * 100) : 0,
      totalTokensSaved,
      totalTimeSavedSeconds: totalTimeSaved,
      totalHits,
      memoryCheckHits,
      researchSearchHits,
      sessionLoads,
      duplicatesAvoided,
      projectCount: projects.length,
    },
    timeline,
    topTags,
    projects: projectList,
    sessionHistory: sessionHistory.slice(-100),
    explorationLog: allExplorationLog.slice(-30),
    heatmap,
    heatmapTags,
    graphStats,
    primaryProject: path.relative(home, primaryRoot).replace(/\\/g, "/"),
    lastUpdated: new Date().toISOString(),
  };
}

// ── HTML Dashboard ──

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Project Memory Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3;
    --dim: #8b949e; --green: #3fb950; --blue: #58a6ff; --yellow: #d29922;
    --red: #f85149; --purple: #bc8cff; --cyan: #39d353;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); padding: 20px; max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .subtitle { color: var(--dim); font-size: 0.85rem; margin-bottom: 20px; }
  .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--green); margin-right: 6px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  .stat-card .label { font-size: 0.7rem; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-card .value { font-size: 1.6rem; font-weight: 600; margin-top: 2px; }
  .stat-card .detail { font-size: 0.7rem; color: var(--dim); margin-top: 2px; }
  .stat-card.green .value{color:var(--green)} .stat-card.blue .value{color:var(--blue)}
  .stat-card.yellow .value{color:var(--yellow)} .stat-card.purple .value{color:var(--purple)}
  .stat-card.cyan .value{color:var(--cyan)} .stat-card.red .value{color:var(--red)}

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  @media(max-width:900px) { .two-col { grid-template-columns: 1fr; } }

  .section { margin-bottom: 24px; }
  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .section-title { font-size: 1rem; font-weight: 600; }
  .badge { font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
  .badge-green{background:rgba(63,185,80,0.15);color:var(--green)}
  .badge-yellow{background:rgba(210,153,34,0.15);color:var(--yellow)}
  .badge-blue{background:rgba(88,166,255,0.15);color:var(--blue)}

  .search-box { width: 100%; padding: 8px 12px; background: var(--card); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 0.9rem; margin-bottom: 12px; outline: none; }
  .search-box:focus { border-color: var(--blue); }

  .entry-list { display: flex; flex-direction: column; gap: 8px; max-height: 600px; overflow-y: auto; }
  .entry { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; transition: border-color 0.2s; }
  .entry:hover { border-color: var(--blue); }
  .entry-topic { font-weight: 600; font-size: 0.9rem; margin-bottom: 4px; }
  .entry-finding { color: var(--dim); font-size: 0.82rem; line-height: 1.4; margin-bottom: 6px; }
  .entry-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 0.7rem; color: var(--dim); }
  .entry-meta span { display: flex; align-items: center; gap: 3px; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 4px; background: rgba(88,166,255,0.1); color: var(--blue); font-size: 0.68rem; margin-right: 3px; }

  .progress-bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 3px; transition: width 0.5s; }

  .timeline-chart { display: flex; align-items: flex-end; gap: 3px; height: 80px; padding: 8px 0; }
  .timeline-bar { display: flex; flex-direction: column; align-items: center; flex: 1; min-width: 0; }
  .timeline-bar-inner { width: 100%; border-radius: 2px 2px 0 0; transition: height 0.3s; min-height: 2px; }
  .timeline-bar-label { font-size: 0.55rem; color: var(--dim); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .timeline-bar .research { background: var(--blue); }
  .timeline-bar .decisions { background: var(--purple); margin-top: 1px; }

  .tag-cloud { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag-pill { padding: 3px 10px; border-radius: 12px; font-size: 0.75rem; background: var(--card); border: 1px solid var(--border); }

  .exploration-item { font-size: 0.78rem; padding: 5px 10px; border-left: 3px solid var(--border); margin-bottom: 3px; color: var(--dim); }
  .exploration-item.unsaved { border-left-color: var(--yellow); }

  .session-item { font-size: 0.78rem; padding: 5px 10px; border-left: 3px solid var(--blue); margin-bottom: 3px; color: var(--dim); }

  .tabs { display: flex; gap: 0; margin-bottom: 12px; }
  .tab { padding: 7px 14px; cursor: pointer; border: 1px solid var(--border); background: var(--bg); color: var(--dim); font-size: 0.82rem; }
  .tab:first-child { border-radius: 6px 0 0 6px; }
  .tab:last-child { border-radius: 0 6px 6px 0; }
  .tab.active { background: var(--card); color: var(--text); border-color: var(--blue); }
  .tab:hover { color: var(--text); }

  .empty { text-align: center; padding: 30px; color: var(--dim); }
  .legend { display: flex; gap: 12px; font-size: 0.7rem; color: var(--dim); margin-bottom: 6px; }
  .legend-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
</style>
</head>
<body>

<h1>Project Memory Dashboard</h1>
<p class="subtitle"><span class="live-dot"></span>Global &mdash; aggregating <span id="projectCount"></span> projects &mdash; auto-refreshing every 3s</p>

<div class="stats-grid" id="statsGrid"></div>

<div class="two-col">
  <div class="section">
    <div class="section-header">
      <span class="section-title">Activity Timeline</span>
      <div class="legend">
        <span><span class="legend-dot" style="background:var(--blue)"></span>Research</span>
        <span><span class="legend-dot" style="background:var(--purple)"></span>Decisions</span>
      </div>
    </div>
    <div id="timeline" class="timeline-chart"></div>
  </div>
  <div class="section">
    <div class="section-header">
      <span class="section-title">Top Tags</span>
    </div>
    <div id="tagCloud" class="tag-cloud"></div>
    <div style="margin-top: 16px;">
      <div class="section-header">
        <span class="section-title">Embedding Coverage</span>
        <span id="embBadge" class="badge"></span>
      </div>
      <div class="progress-bar"><div id="embProgress" class="progress-fill" style="width:0;background:var(--green)"></div></div>
      <div id="embDetail" style="font-size:0.7rem;color:var(--dim);margin-top:4px"></div>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <span class="section-title">Research Heatmap</span>
    <div class="legend">
      <span><span class="legend-dot" style="background:#1a2233"></span>0</span>
      <span><span class="legend-dot" style="background:#1e4d8a"></span>Low</span>
      <span><span class="legend-dot" style="background:#2a7fff"></span>Med</span>
      <span><span class="legend-dot" style="background:#58a6ff"></span>High</span>
      <span><span class="legend-dot" style="background:#a5d6ff"></span>Most</span>
    </div>
  </div>
  <div id="heatmap" style="overflow-x:auto;"></div>
</div>

<div class="section">
  <div class="tabs">
    <div class="tab active" data-tab="research">Research</div>
    <div class="tab" data-tab="decisions">Decisions</div>
    <div class="tab" data-tab="projects">Projects</div>
    <div class="tab" data-tab="explorations">Explorations</div>
    <div class="tab" data-tab="sessions">Sessions</div>
    <div class="tab" data-tab="graph">Knowledge Graph</div>
  </div>
  <input type="text" class="search-box" id="searchBox" placeholder="Semantic search across all projects... (powered by embeddings)">
  <div id="searchResults" style="display:none;"></div>
  <div id="tabContent"></div>
</div>

<style>
  .pagination{display:flex;gap:6px;align-items:center;margin-top:12px;justify-content:center;}
  .page-btn{padding:5px 12px;border:1px solid var(--border);background:var(--card);color:var(--dim);border-radius:4px;cursor:pointer;font-size:0.8rem;}
  .page-btn:hover{color:var(--text);border-color:var(--blue);}
  .page-btn.active{background:var(--blue);color:#fff;border-color:var(--blue);}
  .page-btn:disabled{opacity:0.3;cursor:default;}
  .page-info{font-size:0.75rem;color:var(--dim);}
  .session-badge{display:inline-block;padding:1px 6px;border-radius:4px;background:rgba(57,211,83,0.1);color:var(--cyan);font-size:0.68rem;margin-right:3px;}
  .heatmap-table{border-collapse:collapse;width:100%;font-size:0.75rem;}
  .heatmap-table th{padding:4px 8px;text-align:left;color:var(--dim);font-weight:500;border-bottom:1px solid var(--border);white-space:nowrap;}
  .heatmap-table th.tag-header{text-align:center;max-width:70px;overflow:hidden;text-overflow:ellipsis;writing-mode:vertical-rl;transform:rotate(180deg);height:80px;vertical-align:bottom;}
  .heatmap-table td{padding:3px;text-align:center;border:1px solid var(--bg);}
  .heatmap-cell{display:block;width:100%;min-width:28px;height:24px;border-radius:3px;line-height:24px;font-size:0.65rem;color:var(--text);cursor:pointer;transition:transform 0.15s;}
  .heatmap-cell:hover{transform:scale(1.3);z-index:1;position:relative;}
  .heatmap-project{text-align:left;padding:4px 8px;color:var(--text);white-space:nowrap;cursor:pointer;}
  .heatmap-project:hover{color:var(--blue);}
</style>
<script>
let currentTab='research', currentData=null, currentPage={research:1,decisions:1,projects:1,explorations:1,sessions:1};
let projectFilter=null; // null = all projects, string = filter by project name
const PAGE_SIZE=10;

document.querySelectorAll('.tab').forEach(t=>{
  t.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    currentTab=t.dataset.tab;
    render();
  });
});

let searchTimer=null;
document.getElementById('searchBox').addEventListener('input',function(){
  const q=this.value.trim();
  if(!q){
    document.getElementById('searchResults').style.display='none';
    document.getElementById('tabContent').style.display='';
    return;
  }
  clearTimeout(searchTimer);
  searchTimer=setTimeout(()=>doSemanticSearch(q),500);
});

async function doSemanticSearch(query){
  document.getElementById('searchResults').innerHTML='<div class="empty">Searching...</div>';
  document.getElementById('searchResults').style.display='';
  document.getElementById('tabContent').style.display='none';
  try{
    const res=await fetch('/api/search?q='+encodeURIComponent(query));
    const data=await res.json();
    if(data.error){document.getElementById('searchResults').innerHTML='<div class="empty">Error: '+esc(data.error)+'</div>';return;}
    const results=data.results||[];
    if(!results.length){document.getElementById('searchResults').innerHTML='<div class="empty">No results for "'+esc(query)+'"</div>';return;}
    document.getElementById('searchResults').innerHTML='<div style="font-size:0.8rem;color:var(--dim);margin-bottom:8px">'+results.length+' results for "'+esc(query)+'" (semantic search)</div><div class="entry-list">'+results.map(e=>{
      const proj=e._project?'<span class="tag" style="background:rgba(188,140,255,0.15);color:var(--purple)">'+esc(e._project)+'</span>':'';
      const scoreColor=e._score>30?'var(--green)':e._score>15?'var(--blue)':'var(--dim)';
      const scoreBadge='<span style="color:'+scoreColor+';font-weight:600">'+e._score+'%</span>';
      if(e._type==='research'){
        const tags=(e.tags||[]).map(t=>'<span class="tag">'+esc(t)+'</span>').join('');
        return '<div class="entry"><div class="entry-topic">'+scoreBadge+' '+esc(e.topic||'untitled')+'</div>'
          +'<div class="entry-finding">'+esc(e.finding||'')+'</div>'
          +'<div class="entry-meta">'+proj+'<span>'+tags+'</span><span>'+(e.ts?e.ts.substring(0,10):'')+'</span></div></div>';
      }else{
        return '<div class="entry"><div class="entry-topic">'+scoreBadge+' ['+esc(e.category||'other')+'] '+esc(e.decision||'')+'</div>'
          +'<div class="entry-finding">'+esc(e.rationale||'')+'</div>'
          +'<div class="entry-meta">'+proj+'<span>'+(e.ts?e.ts.substring(0,10):'')+'</span></div></div>';
      }
    }).join('')+'</div>';
  }catch(err){document.getElementById('searchResults').innerHTML='<div class="empty">Failed: '+esc(err.message||String(err))+'</div>';}
}

function goPage(tab,page){currentPage[tab]=page;render();}

function filterByProject(name){
  projectFilter=name;
  currentPage.research=1;
  currentPage.decisions=1;
  // Switch to research tab
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  document.querySelector('[data-tab="research"]').classList.add('active');
  currentTab='research';
  render();
}

function clearProjectFilter(){
  projectFilter=null;
  currentPage.research=1;
  currentPage.decisions=1;
  render();
}

function fmt(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toString();}
function dur(s){if(s<60)return s+'s';if(s<3600)return(s/60).toFixed(1)+' min';return(s/3600).toFixed(1)+' hrs';}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

function renderStats(s){
  document.getElementById('statsGrid').innerHTML=[
    {l:'Research',v:s.totalResearch,c:'blue',d:'findings saved'},
    {l:'Decisions',v:s.totalDecisions,c:'purple',d:'decisions saved'},
    {l:'Tokens Saved',v:fmt(s.totalTokensSaved),c:'green',d:'~$'+(s.totalTokensSaved*0.000012).toFixed(2)+' saved'},
    {l:'Time Saved',v:dur(s.totalTimeSavedSeconds),c:'cyan',d:'investigation avoided'},
    {l:'Memory Lookups',v:s.totalHits,c:'blue',d:s.memoryCheckHits+' checks, '+s.sessionLoads+' loads'},
    {l:'Embedded',v:s.embeddingCoverage+'%',c:s.embeddingCoverage===100?'green':'yellow',d:s.embeddedCount+'/'+s.totalEntries},
    {l:'Projects',v:s.projectCount||1,c:'purple',d:'with .ai-memory'},
    {l:'Hit Rate',v:s.totalHits>0?Math.round(s.memoryCheckHits/(s.memoryCheckHits+s.sessionLoads)*100)+'%':'—',c:'cyan',d:'check hits vs session loads'},
  ].map(x=>'<div class="stat-card '+x.c+'"><div class="label">'+x.l+'</div><div class="value">'+x.v+'</div><div class="detail">'+x.d+'</div></div>').join('');
}

function renderTimeline(tl){
  const dates=Object.keys(tl).sort();
  if(!dates.length){document.getElementById('timeline').innerHTML='<div class="empty">No data yet</div>';return;}
  const maxVal=Math.max(...dates.map(d=>(tl[d].research||0)+(tl[d].decisions||0)),1);
  document.getElementById('timeline').innerHTML=dates.slice(-30).map(d=>{
    const r=tl[d].research||0,dec=tl[d].decisions||0;
    const rH=Math.round((r/maxVal)*60),dH=Math.round((dec/maxVal)*60);
    return '<div class="timeline-bar" title="'+d+': '+r+' research, '+dec+' decisions">'
      +'<div class="research timeline-bar-inner" style="height:'+rH+'px"></div>'
      +'<div class="decisions timeline-bar-inner" style="height:'+dH+'px"></div>'
      +'<div class="timeline-bar-label">'+d.slice(5)+'</div></div>';
  }).join('');
}

function renderTags(tags){
  document.getElementById('tagCloud').innerHTML=tags.map(([t,c])=>{
    const size=Math.max(0.7,Math.min(1.2,0.7+c*0.05));
    return '<span class="tag-pill" style="font-size:'+size+'rem">'+esc(t)+' <span style="color:var(--dim)">'+c+'</span></span>';
  }).join('');
}

function renderEmbedding(s){
  document.getElementById('embProgress').style.width=s.embeddingCoverage+'%';
  document.getElementById('embProgress').style.background=s.embeddingCoverage===100?'var(--green)':'var(--yellow)';
  document.getElementById('embBadge').textContent=s.embeddedCount+'/'+s.totalEntries;
  document.getElementById('embBadge').className='badge '+(s.embeddingCoverage===100?'badge-green':'badge-yellow');
  document.getElementById('embDetail').textContent=s.embeddingCoverage===100?'All entries embedded':(s.totalEntries-s.embeddedCount)+' pending';
}

function findSessionForEntry(entry, sessions) {
  if (!entry.ts || !sessions || !sessions.length) return null;
  // Find the session whose start is before this entry and end is after (or no end yet)
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (s.event === 'start' && s.ts <= entry.ts) {
      // Check if next session start is after this entry
      const nextStart = sessions.slice(i + 1).find(x => x.event === 'start');
      if (!nextStart || nextStart.ts > entry.ts) {
        const proj = s._project || '';
        const date = s.ts ? s.ts.substring(0, 10) : '';
        const time = s.ts ? s.ts.substring(11, 16) : '';
        return proj + ' ' + date + ' ' + time;
      }
    }
  }
  return null;
}

function renderEntries(entries, type) {
  if (!entries.length) return '<div class="empty">No ' + type + ' found</div>';

  // Sort by creation time descending (newest first)
  const sorted = entries.slice().sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  // Pagination
  const page = currentPage[type] || 1;
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const start = (page - 1) * PAGE_SIZE;
  const pageEntries = sorted.slice(start, start + PAGE_SIZE);
  const sessions = currentData ? (currentData.sessionHistory || []) : [];

  let html = '<div class="entry-list">' + pageEntries.map(e => {
    const eI = e.embedded ? '\\u2713' : '\\u25CB', eC = e.embedded ? 'var(--green)' : 'var(--yellow)';
    const proj = e._project ? '<span class="tag" style="background:rgba(188,140,255,0.15);color:var(--purple)">' + esc(e._project) + '</span>' : '';
    const sess = findSessionForEntry(e, sessions);
    const sessBadge = sess ? '<span class="session-badge">\\u23F1 ' + esc(sess) + '</span>' : '';

    if (type === 'research') {
      const tags = (e.tags || []).map(t => '<span class="tag">' + esc(t) + '</span>').join('');
      return '<div class="entry"><div class="entry-topic">' + esc(e.topic || 'untitled') + '</div>'
        + '<div class="entry-finding">' + esc(e.finding || '') + '</div>'
        + '<div class="entry-meta">' + proj + sessBadge + '<span>' + tags + '</span><span>' + esc(e.staleness || 'stable') + '</span>'
        + '<span>' + (e.ts ? e.ts.substring(0, 19).replace('T', ' ') : '') + '</span>'
        + '<span style="color:' + eC + '">' + eI + ' embedded</span>'
        + (e.entities && e.entities.length ? '<span>entities: ' + esc(e.entities.join(', ')) + '</span>' : '')
        + '</div></div>';
    } else {
      return '<div class="entry"><div class="entry-topic">[' + esc(e.category || 'other') + '] ' + esc(e.decision || '') + '</div>'
        + '<div class="entry-finding">' + esc(e.rationale || '') + '</div>'
        + '<div class="entry-meta">' + proj + sessBadge + '<span>' + (e.ts ? e.ts.substring(0, 19).replace('T', ' ') : '') + '</span>'
        + '<span style="color:' + eC + '">' + eI + ' embedded</span></div></div>';
    }
  }).join('') + '</div>';

  // Pagination controls
  if (totalPages > 1) {
    const q = '&quot;'; // safe quote for onclick in HTML attributes
    html += '<div class="pagination">';
    html += '<button class="page-btn" onclick="goPage('+q+type+q+',1)" ' + (page <= 1 ? 'disabled' : '') + '>&laquo;</button>';
    html += '<button class="page-btn" onclick="goPage('+q+type+q+',' + (page - 1) + ')" ' + (page <= 1 ? 'disabled' : '') + '>&lsaquo;</button>';
    const startP = Math.max(1, page - 2), endP = Math.min(totalPages, page + 2);
    for (let p = startP; p <= endP; p++) {
      html += '<button class="page-btn' + (p === page ? ' active' : '') + '" onclick="goPage('+q+type+q+',' + p + ')">' + p + '</button>';
    }
    html += '<button class="page-btn" onclick="goPage('+q+type+q+',' + (page + 1) + ')" ' + (page >= totalPages ? 'disabled' : '') + '>&rsaquo;</button>';
    html += '<button class="page-btn" onclick="goPage('+q+type+q+','+totalPages+')" ' + (page >= totalPages ? 'disabled' : '') + '>&raquo;</button>';
    html += '<span class="page-info">' + (start + 1) + '-' + Math.min(start + PAGE_SIZE, sorted.length) + ' of ' + sorted.length + '</span>';
    html += '</div>';
  }

  return html;
}

function renderExplorations(log){
  if(!log||!log.length)return '<div class="empty">No explorations logged this session</div>';
  return log.slice().reverse().map(b=>{
    const label=b.subagent?b.tool+'/'+b.subagent:b.tool;
    const detail=b.prompt||b.query||b.url||'';
    const time=b.ts?b.ts.substring(11,19):'';
    return '<div class="exploration-item'+(b.saved?'':' unsaved')+'">'
      +'<strong>'+esc(label)+'</strong> '+time+'<br>'+esc(detail.slice(0,120))
      +(b.saved?'':' <span class="badge badge-yellow">unsaved</span>')+'</div>';
  }).join('');
}

function renderSessions(sessions){
  if(!sessions||!sessions.length)return '<div class="empty">No session history recorded yet</div>';
  return sessions.slice().reverse().map(s=>{
    const time=s.ts?s.ts.substring(0,19).replace('T',' '):'';
    const detail=s.event==='start'?'Session started'
      :s.event==='end'?'Session ended — '+( s.research||0)+' research, '+(s.decisions||0)+' decisions saved'
      :s.event||'';
    const color=s.event==='start'?'var(--green)':s.event==='end'?'var(--blue)':'var(--dim)';
    return '<div class="session-item" style="border-left-color:'+color+'"><strong>'+time+'</strong> — '+esc(detail)+'</div>';
  }).join('');
}

function renderGraph(gs){
  if(!gs || !gs.topEntities || !gs.topEntities.length) return '<div class="empty">No graph data. Run: node scripts/build-embeddings.js --all</div>';
  let html='<div style="margin-bottom:12px"><a href="/graph" target="_blank" style="color:var(--blue);font-size:0.9rem;text-decoration:none;padding:6px 14px;border:1px solid var(--blue);border-radius:6px;display:inline-block">Open Interactive Graph Visualization &rarr;</a></div>';
  html+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:16px">';
  html+='<div class="stat-card blue"><div class="label">Entities</div><div class="value">'+gs.totalEntities+'</div></div>';
  html+='<div class="stat-card purple"><div class="label">Triples</div><div class="value">'+gs.totalTriples+'</div></div>';
  html+='<div class="stat-card cyan"><div class="label">Avg Connections</div><div class="value">'+gs.avgConnections+'</div></div>';
  html+='</div>';
  // Per-project triple counts
  if(gs.projectTriples&&gs.projectTriples.length){
    html+='<div style="font-size:0.8rem;color:var(--dim);margin-bottom:12px">Per project: '
      +gs.projectTriples.filter(p=>p.triples>0).map(p=>esc(p.name)+' ('+p.triples+')').join(', ')+'</div>';
  }
  // Top entities as clickable cards
  html+='<div class="section-title" style="margin-bottom:8px">Top Entities by Connections</div>';
  html+='<div class="entry-list">';
  for(const e of gs.topEntities){
    const barW=Math.min(100,Math.round(e.connections/gs.topEntities[0].connections*100));
    html+='<div class="entry" style="padding:8px 12px"><div style="display:flex;justify-content:space-between;align-items:center">'
      +'<span style="font-weight:600;font-size:0.85rem">'+esc(e.name)+'</span>'
      +'<span style="color:var(--blue);font-size:0.75rem">'+e.connections+' connections</span></div>'
      +'<div class="progress-bar" style="margin-top:4px"><div class="progress-fill" style="width:'+barW+'%;background:var(--blue)"></div></div></div>';
  }
  html+='</div>';
  return html;
}

function renderProjects(projects){
  if(!projects||!projects.length)return '<div class="empty">No projects found</div>';
  return '<div class="entry-list">'+projects.map(p=>{
    const total=p.research+p.decisions;
    if(total===0)return '';
    const embPct=total>0?Math.round(p.embedded/total*100):0;
    const embColor=embPct===100?'var(--green)':'var(--yellow)';
    return '<div class="entry" style="cursor:pointer" onclick="filterByProject(&quot;'+esc(p.name)+'&quot;)"><div class="entry-topic">'+esc(p.name)+' <span style="font-size:0.7rem;color:var(--dim)">&rarr; click to view entries</span></div>'
      +'<div class="entry-finding" style="font-size:0.75rem">'+esc(p.path)+'</div>'
      +'<div class="entry-meta">'
      +'<span style="color:var(--blue)">'+p.research+' research</span>'
      +'<span style="color:var(--purple)">'+p.decisions+' decisions</span>'
      +'<span style="color:'+embColor+'">'+embPct+'% embedded ('+p.embedded+'/'+total+')</span>'
      +'</div></div>';
  }).filter(Boolean).join('')+'</div>';
}

function renderHeatmap(heatmap, tags, projects) {
  const el = document.getElementById('heatmap');
  if (!heatmap || !tags || !tags.length || !projects || !projects.length) {
    el.innerHTML = '<div class="empty" style="padding:15px">No data for heatmap</div>';
    return;
  }
  // Find max value for color scaling
  let maxVal = 1;
  for (const proj of Object.keys(heatmap)) {
    for (const tag of tags) {
      const v = (heatmap[proj] || {})[tag] || 0;
      if (v > maxVal) maxVal = v;
    }
  }

  function cellColor(val) {
    if (val === 0) return '#1a2233';
    const intensity = Math.min(val / maxVal, 1);
    if (intensity < 0.25) return '#1e3a5f';
    if (intensity < 0.5) return '#1e4d8a';
    if (intensity < 0.75) return '#2a7fff';
    return '#58a6ff';
  }

  // Only show projects that have at least one tag hit
  const activeProjects = (projects || []).filter(p => {
    const row = heatmap[p.name];
    return row && tags.some(t => (row[t] || 0) > 0);
  });

  let html = '<table class="heatmap-table"><thead><tr><th></th>';
  for (const t of tags) {
    html += '<th class="tag-header" title="' + esc(t) + '">' + esc(t) + '</th>';
  }
  html += '<th class="tag-header" style="color:var(--blue)">Total</th></tr></thead><tbody>';

  for (const p of activeProjects) {
    const row = heatmap[p.name] || {};
    let rowTotal = 0;
    html += '<tr><td class="heatmap-project" onclick="filterByProject(&quot;' + esc(p.name) + '&quot;)">' + esc(p.name) + '</td>';
    for (const t of tags) {
      const v = row[t] || 0;
      rowTotal += v;
      html += '<td><span class="heatmap-cell" style="background:' + cellColor(v) + '" title="' + esc(p.name) + ' / ' + esc(t) + ': ' + v + '">' + (v || '') + '</span></td>';
    }
    html += '<td><span class="heatmap-cell" style="background:transparent;color:var(--blue);font-weight:600">' + rowTotal + '</span></td>';
    html += '</tr>';
  }

  html += '</tbody></table>';
  el.innerHTML = html;
}

function render(){
  if(!currentData)return;
  renderStats(currentData.stats);
  renderTimeline(currentData.timeline);
  renderTags(currentData.topTags);
  renderEmbedding(currentData.stats);
  renderHeatmap(currentData.heatmap, currentData.heatmapTags, currentData.projects);
  document.getElementById('projectCount').textContent=currentData.stats.projectCount||1;

  // Apply project filter
  let research=currentData.research, decisions=currentData.decisions;
  if(projectFilter){
    research=research.filter(e=>e._project===projectFilter);
    decisions=decisions.filter(e=>e._project===projectFilter);
  }

  // Filter banner
  let filterBanner='';
  if(projectFilter){
    filterBanner='<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:8px 12px;background:rgba(88,166,255,0.1);border:1px solid var(--blue);border-radius:6px;font-size:0.85rem">'
      +'<span style="color:var(--blue)">Showing entries from: <strong>'+esc(projectFilter)+'</strong></span>'
      +'<span style="color:var(--dim)">('+research.length+' research, '+decisions.length+' decisions)</span>'
      +'<button onclick="clearProjectFilter()" style="margin-left:auto;padding:3px 10px;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:4px;cursor:pointer;font-size:0.8rem">Show All Projects</button>'
      +'</div>';
  }

  const c=document.getElementById('tabContent');
  if(currentTab==='research')c.innerHTML=filterBanner+renderEntries(research,'research');
  else if(currentTab==='decisions')c.innerHTML=filterBanner+renderEntries(decisions,'decisions');
  else if(currentTab==='projects')c.innerHTML=renderProjects(currentData.projects);
  else if(currentTab==='explorations')c.innerHTML=renderExplorations(currentData.explorationLog);
  else if(currentTab==='sessions')c.innerHTML=renderSessions(currentData.sessionHistory);
  else if(currentTab==='graph')c.innerHTML=renderGraph(currentData.graphStats);
}

async function fetchData(){
  try{
    const r=await fetch('/api/data');
    currentData=await r.json();
    try{render();}catch(renderErr){
      console.error('Render error:',renderErr);
      document.getElementById('tabContent').innerHTML='<div class="empty" style="color:var(--red)">Render error: '+esc(renderErr.message||String(renderErr))+'</div>';
    }
  }catch(e){console.error('Fetch failed:',e);}
}
fetchData();
setInterval(fetchData,3000);
</script>
</body>
</html>`;

// ── Server ──

const PORT = getPortArg() || DEFAULT_PORT;

const GRAPH_VIZ_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Knowledge Graph - Project Memory</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; }
  canvas { display: block; cursor: grab; }
  canvas:active { cursor: grabbing; }
  #controls { position: fixed; top: 12px; left: 12px; z-index: 10; display: flex; gap: 8px; align-items: center; }
  #controls button, #controls select { padding: 5px 12px; background: #161b22; border: 1px solid #30363d; color: #e6edf3; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
  #controls button:hover { border-color: #58a6ff; }
  #info { position: fixed; top: 12px; right: 12px; z-index: 10; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; font-size: 0.8rem; max-width: 300px; }
  #info h3 { margin-bottom: 6px; color: #58a6ff; }
  #info .stat { color: #8b949e; margin: 2px 0; }
  #tooltip { position: fixed; z-index: 20; background: #161b22; border: 1px solid #58a6ff; border-radius: 6px; padding: 8px 12px; font-size: 0.78rem; pointer-events: none; display: none; max-width: 250px; }
  #tooltip .name { font-weight: 600; color: #58a6ff; margin-bottom: 4px; }
  #tooltip .connections { color: #3fb950; }
  #legend { position: fixed; bottom: 12px; left: 12px; z-index: 10; font-size: 0.7rem; color: #8b949e; display: flex; gap: 12px; }
  #legend span { display: flex; align-items: center; gap: 4px; }
  #legend .dot { width: 8px; height: 8px; border-radius: 50%; }
  a { color: #58a6ff; text-decoration: none; }
</style>
</head>
<body>
<div id="controls">
  <a href="/">&#8592; Dashboard</a>
  <select id="nodeCount" onchange="reload()">
    <option value="30">30 nodes</option>
    <option value="50" selected>50 nodes</option>
    <option value="100">100 nodes</option>
    <option value="200">200 nodes</option>
  </select>
  <button onclick="resetZoom()">Reset View</button>
</div>
<div id="info">
  <h3>Knowledge Graph</h3>
  <div class="stat" id="statNodes">Nodes: ...</div>
  <div class="stat" id="statEdges">Edges: ...</div>
  <div class="stat" id="statTotal">Total entities: ...</div>
  <div class="stat" style="margin-top:6px;color:#58a6ff">Drag to pan, scroll to zoom, hover for details</div>
</div>
<div id="tooltip"><div class="name"></div><div class="connections"></div><div class="edges"></div></div>
<div id="legend">
  <span><span class="dot" style="background:#58a6ff"></span>Entity</span>
  <span><span class="dot" style="background:#3fb950"></span>High connections</span>
  <span style="color:#30363d">--- related_to</span>
  <span style="color:#58a6ff">--- uses/calls/depends</span>
</div>
<canvas id="canvas"></canvas>
<script>
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let W, H, nodes = [], edges = [], dragging = null, hoveredNode = null;
let camX = 0, camY = 0, zoom = 1;

function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
window.addEventListener('resize', resize);
resize();

const EDGE_COLORS = {
  uses: '#58a6ff', calls: '#58a6ff', depends_on: '#58a6ff', implements: '#58a6ff',
  returns: '#bc8cff', extends: '#bc8cff', fixes: '#3fb950', requires: '#d29922',
  produces: '#3fb950', contains: '#8b949e', converts: '#39d353', serializes: '#39d353',
  pipes_to: '#d29922', related_to: '#21262d', consumes: '#d29922',
};

async function reload() {
  const count = document.getElementById('nodeCount').value;
  const res = await fetch('/api/graph?nodes=' + count);
  const data = await res.json();
  document.getElementById('statNodes').textContent = 'Nodes: ' + data.nodes.length;
  document.getElementById('statEdges').textContent = 'Edges: ' + data.edges.length;
  document.getElementById('statTotal').textContent = 'Total entities: ' + data.totalEntities;

  // Initialize node positions in a circle
  nodes = data.nodes.map((n, i) => {
    const angle = (i / data.nodes.length) * Math.PI * 2;
    const radius = Math.min(W, H) * 0.35;
    return { ...n, x: W/2 + Math.cos(angle) * radius, y: H/2 + Math.sin(angle) * radius, vx: 0, vy: 0 };
  });
  edges = data.edges;

  // Build node lookup
  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);
  edges.forEach(e => { e.sourceNode = nodeMap[e.source]; e.targetNode = nodeMap[e.target]; });
}

let alpha = 1.0; // cooling factor — starts hot, cools to stable
const ALPHA_DECAY = 0.995; // how fast it cools (closer to 1 = slower)
const ALPHA_MIN = 0.001; // stop simulating below this

function tick() {
  if (alpha < ALPHA_MIN && !dragging) return; // simulation settled

  const k = 0.005;
  const repulsion = 3000 * alpha; // repulsion decreases as it cools
  const damping = 0.6;
  const centerPull = 0.001;

  // Repulsion between all nodes
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      let dx = nodes[j].x - nodes[i].x;
      let dy = nodes[j].y - nodes[i].y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      if (dist > 500) continue; // skip far-apart nodes
      let force = repulsion / (dist * dist);
      let fx = (dx / dist) * force;
      let fy = (dy / dist) * force;
      nodes[i].vx -= fx; nodes[i].vy -= fy;
      nodes[j].vx += fx; nodes[j].vy += fy;
    }
  }

  // Attraction along edges
  for (const e of edges) {
    if (!e.sourceNode || !e.targetNode) continue;
    let dx = e.targetNode.x - e.sourceNode.x;
    let dy = e.targetNode.y - e.sourceNode.y;
    let dist = Math.sqrt(dx * dx + dy * dy) || 1;
    let force = (dist - 150) * k * alpha;
    let fx = (dx / dist) * force;
    let fy = (dy / dist) * force;
    e.sourceNode.vx += fx; e.sourceNode.vy += fy;
    e.targetNode.vx -= fx; e.targetNode.vy -= fy;
  }

  // Center pull + damping + cooling
  for (const n of nodes) {
    n.vx += (W/2 - n.x) * centerPull;
    n.vy += (H/2 - n.y) * centerPull;
    n.vx *= damping; n.vy *= damping;
    if (n !== dragging) { n.x += n.vx; n.y += n.vy; }
  }

  // Cool down
  alpha *= ALPHA_DECAY;
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(camX, camY);
  ctx.scale(zoom, zoom);

  // Draw edges with labels
  for (const e of edges) {
    if (!e.sourceNode || !e.targetNode) continue;
    const sx = e.sourceNode.x, sy = e.sourceNode.y;
    const tx = e.targetNode.x, ty = e.targetNode.y;
    const isWeak = e.predicate === 'related_to';

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx, ty);
    ctx.strokeStyle = EDGE_COLORS[e.predicate] || '#21262d';
    ctx.lineWidth = isWeak ? 0.3 : 0.8;
    ctx.stroke();

    // Edge label at midpoint (skip weak related_to, show when zoomed in)
    if (!isWeak && zoom > 0.6) {
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      ctx.fillStyle = EDGE_COLORS[e.predicate] || '#8b949e';
      ctx.font = '7px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(e.predicate, mx, my - 3);
    }
  }

  // Draw nodes
  for (const n of nodes) {
    const isHovered = n === hoveredNode;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size * (isHovered ? 1.5 : 1), 0, Math.PI * 2);
    const connPct = n.size / 20;
    ctx.fillStyle = isHovered ? '#58a6ff' : connPct > 0.5 ? '#3fb950' : connPct > 0.2 ? '#58a6ff' : '#8b949e';
    ctx.fill();
    ctx.strokeStyle = isHovered ? '#fff' : 'rgba(88,166,255,0.3)';
    ctx.lineWidth = isHovered ? 2 : 0.5;
    ctx.stroke();

    // Label for larger or hovered nodes
    if (n.size > 6 || isHovered) {
      ctx.fillStyle = isHovered ? '#fff' : '#8b949e';
      ctx.font = (isHovered ? 'bold ' : '') + Math.max(8, n.size * 0.8) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(n.id, n.x, n.y + n.size + 12);
    }
  }

  ctx.restore();
}

function animate() {
  tick();
  draw();
  requestAnimationFrame(animate);
}

// Mouse interaction
let mouseX = 0, mouseY = 0, isPanning = false, panStartX = 0, panStartY = 0;

canvas.addEventListener('mousemove', e => {
  mouseX = (e.clientX - camX) / zoom;
  mouseY = (e.clientY - camY) / zoom;

  if (dragging) {
    dragging.x = mouseX;
    dragging.y = mouseY;
    return;
  }

  if (isPanning) {
    camX = e.clientX - panStartX;
    camY = e.clientY - panStartY;
    return;
  }

  // Hover detection
  hoveredNode = null;
  for (const n of nodes) {
    const dx = mouseX - n.x, dy = mouseY - n.y;
    if (dx*dx + dy*dy < (n.size * 1.5) * (n.size * 1.5)) {
      hoveredNode = n;
      break;
    }
  }

  const tooltip = document.getElementById('tooltip');
  if (hoveredNode) {
    const connEdges = edges.filter(e => e.source === hoveredNode.id || e.target === hoveredNode.id);
    const grouped = {};
    connEdges.forEach(e => {
      const p = e.predicate;
      if (!grouped[p]) grouped[p] = [];
      grouped[p].push(e.source === hoveredNode.id ? e.target : e.source);
    });
    tooltip.querySelector('.name').textContent = hoveredNode.id;
    tooltip.querySelector('.connections').textContent = connEdges.length + ' connections';
    tooltip.querySelector('.edges').innerHTML = Object.entries(grouped)
      .map(([p, targets]) => '<div style="color:' + (EDGE_COLORS[p]||'#8b949e') + '">' + p + ': ' + targets.slice(0,3).join(', ') + (targets.length > 3 ? ' +' + (targets.length-3) + ' more' : '') + '</div>').join('');
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 15) + 'px';
    tooltip.style.top = (e.clientY - 10) + 'px';
    canvas.style.cursor = 'pointer';
  } else {
    tooltip.style.display = 'none';
    canvas.style.cursor = isPanning ? 'grabbing' : 'grab';
  }
});

canvas.addEventListener('mousedown', e => {
  if (hoveredNode) {
    dragging = hoveredNode;
    alpha = 0.3; // reheat on drag so nearby nodes adjust
    canvas.style.cursor = 'grabbing';
  } else {
    isPanning = true;
    panStartX = e.clientX - camX;
    panStartY = e.clientY - camY;
  }
});

canvas.addEventListener('mouseup', () => { dragging = null; isPanning = false; });
canvas.addEventListener('mouseleave', () => { dragging = null; isPanning = false; });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 0.92 : 1.08;
  const newZoom = Math.max(0.1, Math.min(5, zoom * factor));
  // Zoom towards mouse cursor: keep the point under cursor fixed
  camX = e.clientX - (e.clientX - camX) * (newZoom / zoom);
  camY = e.clientY - (e.clientY - camY) * (newZoom / zoom);
  zoom = newZoom;
}, { passive: false });

function resetZoom() {
  zoom = 1;
  // Center the graph in the viewport
  if (nodes.length > 0) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    camX = W/2 - cx; camY = H/2 - cy;
  } else {
    camX = 0; camY = 0;
  }
}

reload().then(animate);
</script>
</body>
</html>`;

async function startServer() {
  // Check if port is already in use (another dashboard instance)
  const free = await isPortFree(PORT);
  if (!free) {
    console.log(`Dashboard already running on port ${PORT}`);
    process.exit(0);
  }

  // ── Security: localhost-only access guard ───────────────────────────────
  // The dashboard exposes cross-project memory data and a write endpoint, so
  // we MUST refuse any request that didn't originate from this machine.
  //
  //   1. Bind socket to 127.0.0.1 (done at server.listen below)
  //   2. Validate Host header against a strict allowlist — defends against
  //      DNS-rebinding attacks where a malicious public site resolves its
  //      hostname to 127.0.0.1 and the victim's browser dutifully forwards
  //      the request to the local dashboard with the attacker's Origin.
  //   3. Browser-borne requests must come from a same-origin page; reject
  //      any request that carries a foreign Origin header. CLI/curl
  //      requests have no Origin, which is fine.
  //   4. Drop the wildcard CORS header entirely. The dashboard UI is served
  //      from the same origin as the API, so no cross-origin access is ever
  //      legitimate.
  const ALLOWED_HOSTS = new Set([
    `127.0.0.1:${PORT}`,
    `localhost:${PORT}`,
    `[::1]:${PORT}`,
  ]);
  function verifyLocalRequest(req, res) {
    const host = (req.headers.host || "").toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: dashboard accepts requests only via 127.0.0.1/localhost");
      return false;
    }
    const origin = req.headers.origin;
    if (origin) {
      const allowedOrigins = new Set([
        `http://127.0.0.1:${PORT}`,
        `http://localhost:${PORT}`,
        `http://[::1]:${PORT}`,
      ]);
      if (!allowedOrigins.has(origin.toLowerCase())) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: cross-origin requests are not permitted");
        return false;
      }
    }
    return true;
  }

  const server = http.createServer(async (req, res) => {
    if (!verifyLocalRequest(req, res)) return;
    // Same-origin only — no wildcard CORS. The dashboard UI is served from
    // the same origin as the API, so cross-origin access is never legitimate.
    const headers = { "Content-Type": "application/json" };
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/api/data") {
      res.writeHead(200, headers);
      try { res.end(JSON.stringify(getApiData())); }
      catch (err) { res.end(JSON.stringify({ error: err.message })); }

    } else if (url.pathname === "/api/search" && url.searchParams.get("q")) {
      // Semantic search endpoint using embeddings
      res.writeHead(200, headers);
      try {
        const query = url.searchParams.get("q");
        const results = await semanticSearchAll(query);
        res.end(JSON.stringify(results));
      } catch (err) {
        res.end(JSON.stringify({ error: err.message, results: [] }));
      }

    } else if (url.pathname === "/api/graph") {
      // Graph data for visualization
      res.writeHead(200, headers);
      try {
        const graphMod = require(path.join(__dirname, "graph.js"));
        const projects = discoverAllProjects();
        const allTriples = [];
        for (const p of projects) {
          const triples = graphMod.readGraph(p);
          const projName = path.basename(p);
          for (const t of triples) { t._project = projName; }
          allTriples.push(...triples);
        }
        // Build nodes and edges for visualization
        // Filter to top entities to keep it readable
        const adj = graphMod.buildAdjacencyIndex(allTriples);
        const entityList = Object.keys(adj).map(e => ({ id: e, connections: adj[e].length }))
          .sort((a, b) => b.connections - a.connections);

        // Take top N entities + all edges between them
        const maxNodes = parseInt(url.searchParams.get("nodes")) || 50;
        const topIds = new Set(entityList.slice(0, maxNodes).map(e => e.id));

        const nodes = entityList.slice(0, maxNodes).map(e => ({
          id: e.id, size: Math.max(4, Math.min(20, e.connections / 2)),
        }));
        const edges = [];
        const edgeSet = new Set();
        for (const t of allTriples) {
          if (topIds.has(t.s) && topIds.has(t.o) && t.p !== "mentions") {
            const key = t.s + "|" + t.p + "|" + t.o;
            if (!edgeSet.has(key)) {
              edgeSet.add(key);
              edges.push({ source: t.s, target: t.o, predicate: t.p });
            }
          }
        }
        res.end(JSON.stringify({ nodes, edges, totalEntities: entityList.length, totalTriples: allTriples.length }));
      } catch (err) {
        res.end(JSON.stringify({ error: err.message, nodes: [], edges: [] }));
      }

    } else if (url.pathname === "/graph") {
      // Interactive graph visualization page
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(GRAPH_VIZ_HTML);

    } else if (url.pathname === "/api/session-event" && req.method === "POST") {
      // Cap body size to defeat memory-exhaustion writes from a buggy/hostile
      // local client (Host check above already prevents remote callers).
      const MAX_BODY = 64 * 1024; // 64 KB is plenty for a session event
      let body = "";
      let aborted = false;
      req.on("data", (c) => {
        if (aborted) return;
        body += c;
        if (body.length > MAX_BODY) {
          aborted = true;
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("Payload too large");
          req.destroy();
        }
      });
      req.on("end", () => {
        if (aborted) return;
        try {
          const parsed = JSON.parse(body);
          // SECURITY: whitelist only known event fields and trim them. Without
          // this, any local caller could append arbitrary keys (or huge
          // strings) into session-history.jsonl and pollute the dashboard UI.
          if (parsed && typeof parsed === "object") {
            const STR = (v, max) => typeof v === "string" ? v.slice(0, max || 256) : "";
            const safe = {
              event: STR(parsed.event, 64),
              ts: STR(parsed.ts, 64),
              sessionId: STR(parsed.sessionId, 128),
              project: STR(parsed.project, 512),
              tool: STR(parsed.tool, 64),
              summary: STR(parsed.summary, 1024),
            };
            recordSessionEvent(safe);
          }
        } catch {}
        res.writeHead(200); res.end("ok");
      });
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(DASHBOARD_HTML);
    }
  });

  /**
   * Semantic search across ALL projects using embeddings.
   * Returns entries ranked by cosine similarity.
   */
  async function semanticSearchAll(query) {
    const projects = discoverAllProjects();
    const allEntries = [];
    const allEmbeddings = {};

    for (const p of projects) {
      const memDir = path.join(p, ".ai-memory");
      const projectName = path.relative(process.env.USERPROFILE || process.env.HOME || "", p).replace(/\\/g, "/") || path.basename(p);
      const research = readJsonl(path.join(memDir, "research.jsonl"));
      const decisions = readJsonl(path.join(memDir, "decisions.jsonl"));
      for (const r of research) { r._project = projectName; r._type = "research"; }
      for (const d of decisions) { d._project = projectName; d._type = "decision"; }
      allEntries.push(...research, ...decisions);

      const emb = embeddingsModule.readEmbeddings(p);
      Object.assign(allEmbeddings, emb);
    }

    // Generate query embedding and rank
    const queryEmbedding = await embeddingsModule.generateEmbedding(query);
    const scored = allEntries.map(e => {
      const emb = allEmbeddings[e.id];
      const score = emb ? embeddingsModule.cosineSimilarity(queryEmbedding, emb) : 0;
      return { ...e, _score: Math.round(score * 1000) / 10 }; // percentage with 1 decimal
    });

    scored.sort((a, b) => b._score - a._score);
    return { query, results: scored.filter(e => e._score > 5) }; // filter out noise below 5%
  }

  server.listen(PORT, "127.0.0.1", () => {
    // Write PID file for lifecycle management
    try { fs.writeFileSync(PID_FILE, String(process.pid), "utf-8"); } catch {}

    const url = `http://localhost:${PORT}`;
    console.log(`\x1b[92m\u2605 Project Memory Dashboard\x1b[0m`);
    console.log(`  \x1b[92mRunning at: ${url}\x1b[0m`);
    console.log(`  \x1b[92mPrimary:    ${primaryRoot}\x1b[0m`);
    console.log(`  \x1b[92mPID:        ${process.pid}\x1b[0m`);
    console.log(`  \x1b[92mPersistent: survives session restarts\x1b[0m`);
    console.log(`  \x1b[92mStop with:  node scripts/dashboard.js --stop\x1b[0m`);

    // Open browser only in foreground mode (not when spawned by hooks)
    if (!process.env.DASHBOARD_NO_BROWSER) {
      const { spawn } = require("child_process");
      // Use spawn (no shell) to eliminate any chance of metacharacter injection
      // via the URL string. Args are passed as discrete argv entries.
      try {
        if (process.platform === "win32") {
          // `start` is a cmd.exe builtin; first quoted arg is the window title.
          spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
        } else if (process.platform === "darwin") {
          spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
        } else {
          spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
        }
      } catch { /* best-effort — browser open is non-critical */ }
    }
  });

  // Cleanup PID file on exit
  process.on("SIGTERM", () => { try { fs.unlinkSync(PID_FILE); } catch {} process.exit(0); });
  process.on("SIGINT", () => { try { fs.unlinkSync(PID_FILE); } catch {} process.exit(0); });

  // ── Persistent file watcher + auto-embedding agent ──
  startFileWatcher();
}

/**
 * Persistent watcher that monitors all .ai-memory directories for changes.
 * When research.jsonl or decisions.jsonl changes, auto-triggers embedding build.
 * Polls every 5 seconds (more reliable than fs.watch on Windows/network drives).
 */
function startFileWatcher() {
  const POLL_INTERVAL = 5000; // 5 seconds
  const DEBOUNCE_MS = 3000;  // wait 3s after last change before building
  const embeddingsModule = require(path.join(__dirname, "embeddings.js"));

  // Track file mtimes
  const fileMtimes = {};
  let buildTimer = null;
  let isBuilding = false;

  function getWatchedFiles() {
    const projects = discoverAllProjects();
    const files = [];
    for (const p of projects) {
      files.push(path.join(p, ".ai-memory", "research.jsonl"));
      files.push(path.join(p, ".ai-memory", "decisions.jsonl"));
    }
    return files;
  }

  function checkForChanges() {
    const files = getWatchedFiles();
    let changed = false;

    for (const f of files) {
      try {
        const stat = fs.statSync(f);
        const mtime = stat.mtimeMs;
        if (fileMtimes[f] && mtime > fileMtimes[f]) {
          changed = true;
        }
        fileMtimes[f] = mtime;
      } catch { /* file doesn't exist */ }
    }

    if (changed && !isBuilding) {
      // Debounce: wait for writes to settle before building
      if (buildTimer) clearTimeout(buildTimer);
      buildTimer = setTimeout(() => buildEmbeddingsForAll(), DEBOUNCE_MS);
    }
  }

  async function buildEmbeddingsForAll() {
    if (isBuilding) return;
    isBuilding = true;

    try {
      const projects = discoverAllProjects();
      let totalBuilt = 0;

      for (const p of projects) {
        const memDir = path.join(p, ".ai-memory");
        const research = readJsonl(path.join(memDir, "research.jsonl"));
        const decisions = readJsonl(path.join(memDir, "decisions.jsonl"));
        const allEntries = [...research, ...decisions];
        if (allEntries.length === 0) continue;

        const existing = embeddingsModule.readEmbeddings(p);
        const missing = allEntries.filter(e => !existing[e.id]);
        if (missing.length === 0) continue;

        for (const entry of missing) {
          const text = [
            entry.topic || "",
            (entry.tags || []).join(" "),
            entry.finding || entry.decision || "",
          ].join(" ").trim();

          try {
            existing[entry.id] = await embeddingsModule.generateEmbedding(text);
            totalBuilt++;
          } catch { /* skip failed entries */ }
        }

        // Clean up orphaned embeddings
        const validIds = new Set(allEntries.map(e => e.id));
        for (const id of Object.keys(existing)) {
          if (!validIds.has(id)) delete existing[id];
        }

        embeddingsModule.writeEmbeddings(p, existing);
      }

      if (totalBuilt > 0) {
        console.log(`[watcher] Embedded ${totalBuilt} new entries`);
      }
    } catch (err) {
      console.error(`[watcher] Embedding error: ${err.message}`);
    } finally {
      isBuilding = false;
    }
  }

  // Initialize mtimes on first run
  const files = getWatchedFiles();
  for (const f of files) {
    try { fileMtimes[f] = fs.statSync(f).mtimeMs; } catch {}
  }

  // Start polling
  setInterval(checkForChanges, POLL_INTERVAL);

  // Also do an initial build to catch any unembedded entries
  buildEmbeddingsForAll();

  console.log(`  \x1b[92mWatcher:    monitoring ${files.length} files across ${discoverAllProjects().length} projects\x1b[0m`);
  console.log(`  \x1b[92mAuto-embed: new entries embedded within ${(POLL_INTERVAL + DEBOUNCE_MS) / 1000}s of save\x1b[0m`);
}

startServer();
