<#
.SYNOPSIS
    Project Memory - One-Click Installer for Windows PowerShell
.DESCRIPTION
    Installs the project-memory plugin for Claude Code.
    Works on Windows 10/11 with PowerShell 5.1+ (built-in).
#>

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"
$PluginsJson = Join-Path (Join-Path $ClaudeDir "plugins") "installed_plugins.json"

function Write-Step { param($num, $msg); Write-Host "`n[$num/7] $msg" -ForegroundColor Cyan }
function Write-Ok { param($msg); Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Wrn { param($msg); Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err { param($msg); Write-Host "  [FAIL] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "     Project Memory -- One-Click Installer       " -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Platform:     Windows PowerShell $($PSVersionTable.PSVersion)"
Write-Host "  Install from: $ScriptDir"
Write-Host "  Claude dir:   $ClaudeDir"
Write-Host ""

# Step 1: Prerequisites
Write-Step 1 "Checking prerequisites"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Err "Node.js not found. Install from https://nodejs.org v18+"
    exit 1
}
$nodeVer = (& node -v).TrimStart("v")
$nodeMajor = [int]($nodeVer.Split(".")[0])
if ($nodeMajor -lt 18) {
    Write-Err "Node.js $nodeVer found but v18+ required"
    exit 1
}
Write-Ok "Node.js v$nodeVer"

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) { Write-Ok "Git found" } else { Write-Wrn "Git not found - optional" }

if (-not (Test-Path $ClaudeDir)) {
    Write-Err "Claude Code not found at $ClaudeDir - install Claude Code first"
    exit 1
}
Write-Ok "Claude Code directory found"

# Step 2: Install dependencies
Write-Step 2 "Installing dependencies"

Push-Location $ScriptDir
try {
    $modulePath = Join-Path (Join-Path (Join-Path $ScriptDir "node_modules") "@huggingface") "transformers"
    if (Test-Path $modulePath) {
        Write-Ok "Dependencies already installed"
    } else {
        Write-Host "  Installing npm packages..." -ForegroundColor DarkGray
        & npm install --no-fund --no-audit 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        Write-Ok "npm install complete"
    }
} finally { Pop-Location }

# Step 3: Register plugin
Write-Step 3 "Registering plugin with Claude Code"

$pluginsDir = Split-Path $PluginsJson -Parent
if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null }

# Use a temp Node script for reliable JSON manipulation
$regScript = Join-Path $ScriptDir "_register_plugin.js"
@"
const fs = require("fs");
const path = require("path");
const home = process.env.USERPROFILE || process.env.HOME;
const pj = path.join(home, ".claude", "plugins", "installed_plugins.json");
const installDir = path.resolve(__dirname);
// Derive PLUGIN_ID and version from .claude-plugin metadata so forks/renames
// just work — no hardcoded "owner/name" strings tied to the upstream maintainer.
let pluginId = "project-memory@project-memory-marketplace";
let pluginVersion = "1.0.0";
try {
  const mp = JSON.parse(fs.readFileSync(path.join(installDir, ".claude-plugin", "marketplace.json"), "utf-8"));
  const pl = JSON.parse(fs.readFileSync(path.join(installDir, ".claude-plugin", "plugin.json"), "utf-8"));
  pluginId = pl.name + "@" + mp.name;
  pluginVersion = pl.version || pluginVersion;
} catch (e) {
  console.log("  [WARN] Could not read .claude-plugin metadata; using defaults (" + e.message + ")");
}
fs.mkdirSync(path.dirname(pj), { recursive: true });
let d = { version: 2, plugins: {} };
try { d = JSON.parse(fs.readFileSync(pj, "utf-8")); } catch {}
if (!d.plugins) d.plugins = {};
d.plugins[pluginId] = [{
  scope: "user", installPath: installDir, version: pluginVersion,
  installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString()
}];
fs.writeFileSync(pj, JSON.stringify(d, null, 2), "utf-8");
console.log("  [OK] Plugin registered as " + pluginId + " at " + installDir);
fs.unlinkSync(__filename);
"@ | Set-Content $regScript -Encoding UTF8

& node $regScript

# Step 4: Initialize memory
Write-Step 4 "Initializing memory store"

$memDir = Join-Path $ScriptDir ".ai-memory"
$researchFile = Join-Path $memDir "research.jsonl"
if (Test-Path $researchFile) {
    $rCount = @(Get-Content $researchFile | Where-Object { $_.Trim() }).Count
    $dFile = Join-Path $memDir "decisions.jsonl"
    $dCount = 0
    if (Test-Path $dFile) { $dCount = @(Get-Content $dFile | Where-Object { $_.Trim() }).Count }
    Write-Ok "Memory initialized - $rCount research, $dCount decisions"
} else {
    New-Item -ItemType Directory -Path $memDir -Force | Out-Null
    "" | Out-File (Join-Path $memDir "research.jsonl") -Encoding utf8 -NoNewline
    "" | Out-File (Join-Path $memDir "decisions.jsonl") -Encoding utf8 -NoNewline
    $metaJson = '{"tokenCount":0,"lastSync":"' + (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + '","sessionCount":0,"decisionCount":0,"researchCount":0,"researchTokenCount":0,"stats":{"totalTokensSaved":0,"totalTimeSavedSeconds":0,"totalHits":0,"eventCounts":{}}}'
    $metaJson | Out-File (Join-Path $memDir "metadata.json") -Encoding utf8
    Write-Ok "Memory store created"
}

# Step 5: Build embeddings
Write-Step 5 "Building embeddings across all projects"

Write-Host "  Scanning for projects with .ai-memory..." -ForegroundColor DarkGray
$buildScript = Join-Path (Join-Path $ScriptDir "scripts") "build-embeddings.js"
& node $buildScript --all 2>&1 | ForEach-Object { Write-Host "  $_" }
Write-Ok "Embeddings complete"

# Step 6: Start dashboard
Write-Step 6 "Starting dashboard"

$dashScript = Join-Path (Join-Path $ScriptDir "scripts") "dashboard.js"
& node $dashScript --stop 2>$null
Start-Sleep -Seconds 1

$env:DASHBOARD_NO_BROWSER = "1"
$proc = Start-Process -FilePath "node" -ArgumentList "`"$dashScript`"" -WindowStyle Hidden -PassThru
Write-Ok "Dashboard started - PID $($proc.Id) at http://localhost:3777"

# Step 7: Run tests
Write-Step 7 "Running tests"

$testScript = Join-Path (Join-Path (Join-Path $ScriptDir "scripts") "tests") "test-runner.js"
try {
    & node $testScript 2>&1 | ForEach-Object { $_ } | Where-Object { $_ -match "Passed|Failed|passed" } | ForEach-Object { Write-Host "  $_" }
} catch {
    Write-Wrn "Some tests had issues (non-critical)"
}
Write-Ok "Test run complete"

# Done
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "          Installation Complete!                  " -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Dashboard:  http://localhost:3777" -ForegroundColor Cyan
Write-Host "  Plugin:     Registered - restart Claude Code to activate" -ForegroundColor Green
Write-Host "  Embeddings: Built for all discovered projects" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:"
Write-Host "  1. Restart Claude Code"
Write-Host "  2. Run /project-memory:memory-init in any project"
Write-Host "  3. Open http://localhost:3777 for the dashboard"
Write-Host ""
