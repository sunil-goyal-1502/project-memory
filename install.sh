#!/bin/bash
set -e

# ============================================================================
# Project Memory — One-Click Installer
# Works on Windows (Git Bash/MSYS2), macOS, and Linux
# ============================================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

print_step() { echo -e "\n${CYAN}${BOLD}[$1/7]${NC} ${BOLD}$2${NC}"; }
print_ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
print_warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
print_err()  { echo -e "  ${RED}✗${NC} $1"; }

# ── Detect platform ──
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
  Darwin*)              PLATFORM="macos" ;;
  Linux*)               PLATFORM="linux" ;;
  *)                    PLATFORM="unknown" ;;
esac

# ── Resolve paths ──
if [ "$PLATFORM" = "windows" ]; then
  HOME_DIR="${USERPROFILE:-$HOME}"
  CLAUDE_DIR="$HOME_DIR/.claude"
  PLUGINS_JSON="$CLAUDE_DIR/plugins/installed_plugins.json"
  # Normalize to forward slashes for JSON
  INSTALL_DIR="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"
  INSTALL_DIR_JSON=$(echo "$INSTALL_DIR" | sed 's|/|\\\\|g')
else
  HOME_DIR="$HOME"
  CLAUDE_DIR="$HOME_DIR/.claude"
  PLUGINS_JSON="$CLAUDE_DIR/plugins/installed_plugins.json"
  INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
  INSTALL_DIR_JSON=$(echo "$INSTALL_DIR" | sed 's|/|\\/|g')
fi

echo -e "${GREEN}${BOLD}"
echo "╔══════════════════════════════════════════════╗"
echo "║     Project Memory — One-Click Installer     ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  Platform:     ${BOLD}$PLATFORM${NC}"
echo -e "  Install from: ${BOLD}$INSTALL_DIR${NC}"
echo -e "  Claude dir:   ${BOLD}$CLAUDE_DIR${NC}"
echo ""

# ── Step 1: Check prerequisites ──
print_step 1 "Checking prerequisites"

if ! command -v node &>/dev/null; then
  print_err "Node.js not found. Install Node.js >= 18 from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  print_err "Node.js $NODE_VERSION found, but >= 18 required"
  exit 1
fi
print_ok "Node.js $(node -v)"

if ! command -v git &>/dev/null; then
  print_err "Git not found. Install Git from https://git-scm.com"
  exit 1
fi
print_ok "Git $(git --version | awk '{print $3}')"

if [ ! -d "$CLAUDE_DIR" ]; then
  print_warn "Claude Code directory not found at $CLAUDE_DIR"
  print_warn "Install Claude Code first, then re-run this script"
  exit 1
fi
print_ok "Claude Code directory found"

# ── Step 2: Install npm dependencies ──
print_step 2 "Installing dependencies"

cd "$INSTALL_DIR"
if [ -d "node_modules/@huggingface/transformers" ]; then
  print_ok "Dependencies already installed"
else
  npm install --no-fund --no-audit 2>&1 | tail -3
  print_ok "npm install complete"
fi

# ── Step 3: Register plugin with Claude Code ──
print_step 3 "Registering plugin with Claude Code"

PLUGINS_DIR="$(dirname "$PLUGINS_JSON")"
mkdir -p "$PLUGINS_DIR"

# Write a temp registration script (avoids shell escaping issues)
REG_SCRIPT="$INSTALL_DIR/_register_plugin.js"
cat > "$REG_SCRIPT" << 'ENDSCRIPT'
const fs = require("fs");
const path = require("path");
const home = process.env.USERPROFILE || process.env.HOME;
const pluginsJson = path.join(home, ".claude", "plugins", "installed_plugins.json");
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

// Ensure plugins directory exists
fs.mkdirSync(path.dirname(pluginsJson), { recursive: true });

let data = { version: 2, plugins: {} };
try { data = JSON.parse(fs.readFileSync(pluginsJson, "utf-8")); } catch {}
if (!data.plugins) data.plugins = {};

data.plugins[pluginId] = [{
  scope: "user",
  installPath: installDir,
  version: pluginVersion,
  installedAt: new Date().toISOString(),
  lastUpdated: new Date().toISOString()
}];

fs.writeFileSync(pluginsJson, JSON.stringify(data, null, 2), "utf-8");
console.log("  ✓ Plugin registered as " + pluginId + " at " + installDir);
console.log("  ✓ Config: " + pluginsJson);

// Self-cleanup
fs.unlinkSync(__filename);
ENDSCRIPT

node "$REG_SCRIPT"

# ── Step 4: Initialize memory in this project ──
print_step 4 "Initializing memory store"

MEMORY_DIR="$INSTALL_DIR/.ai-memory"
if [ -f "$MEMORY_DIR/research.jsonl" ]; then
  RESEARCH_COUNT=$(wc -l < "$MEMORY_DIR/research.jsonl" 2>/dev/null || echo 0)
  DECISION_COUNT=$(wc -l < "$MEMORY_DIR/decisions.jsonl" 2>/dev/null || echo 0)
  print_ok "Memory already initialized ($RESEARCH_COUNT research, $DECISION_COUNT decisions)"
else
  mkdir -p "$MEMORY_DIR"
  touch "$MEMORY_DIR/research.jsonl"
  touch "$MEMORY_DIR/decisions.jsonl"
  echo '{"tokenCount":0,"lastSync":"'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'","sessionCount":0,"decisionCount":0,"researchCount":0,"researchTokenCount":0,"stats":{"totalTokensSaved":0,"totalTimeSavedSeconds":0,"totalHits":0,"eventCounts":{}}}' > "$MEMORY_DIR/metadata.json"
  print_ok "Memory store created at $MEMORY_DIR"
fi

# ── Step 5: Build embeddings globally ──
print_step 5 "Building embeddings across all projects"

echo -e "  ${CYAN}Scanning for projects with .ai-memory...${NC}"
node "$INSTALL_DIR/scripts/build-embeddings.js" --all 2>&1 | while IFS= read -r line; do
  echo "  $line"
done
print_ok "Embeddings complete"

# ── Step 6: Start dashboard ──
print_step 6 "Starting dashboard"

# Stop any existing dashboard
node "$INSTALL_DIR/scripts/dashboard.js" --stop 2>/dev/null || true
sleep 1

# Start as background process
DASHBOARD_NO_BROWSER=1 node "$INSTALL_DIR/scripts/dashboard.js" --background 2>&1 | while IFS= read -r line; do
  echo "  $line"
done
print_ok "Dashboard running at http://localhost:3777"

# ── Step 7: Run tests ──
print_step 7 "Running tests"

node "$INSTALL_DIR/scripts/tests/test-runner.js" 2>&1 | tail -5
echo ""

# ── Done ──
echo -e "${GREEN}${BOLD}"
echo "╔══════════════════════════════════════════════╗"
echo "║          Installation Complete!              ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  ${GREEN}Dashboard:${NC}  http://localhost:3777"
echo -e "  ${GREEN}Plugin:${NC}     Registered — restart Claude Code to activate"
echo -e "  ${GREEN}Embeddings:${NC} Built for all discovered projects"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo -e "  1. Restart Claude Code (close and reopen)"
echo -e "  2. Run ${CYAN}/project-memory:memory-init${NC} in any project"
echo -e "  3. Open ${CYAN}http://localhost:3777${NC} for the dashboard"
echo ""
