#!/usr/bin/env python3
"""
Cross-platform installer for project-memory Claude Code plugin.

Usage:
    python install.py              # Full install (interactive prompts)
    python install.py --uninstall  # Clean removal of all registrations

Works on Windows, macOS, and Linux with zero Python dependencies beyond stdlib.
"""

import json
import os
import subprocess
import shutil
import sys
import datetime
import platform
import re
from pathlib import Path

# ─── Constants ───────────────────────────────────────────────────────────────

# Derive PLUGIN_ID from .claude-plugin metadata so forks/renames Just Work.
def _read_plugin_id():
    here = Path(__file__).resolve().parent
    try:
        mp = json.loads((here / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))
        pl = json.loads((here / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
        return f"{pl['name']}@{mp['name']}", pl.get("version", "1.0.0")
    except Exception as e:
        print(f"WARNING: Could not read .claude-plugin metadata ({e}); falling back to defaults", file=sys.stderr)
        return "project-memory@project-memory-marketplace", "1.0.0"

PLUGIN_ID, PLUGIN_VERSION = _read_plugin_id()
MCP_SERVER_KEY = "project-memory"

# REPO_URL is used only when the user runs install.py without first cloning.
# Priority: env var > git remote of this checkout > None (will prompt).
# SECURITY: validate against a safe-character allow-list before using in any
# subprocess call, so a hostile env var can't smuggle shell metacharacters
# into git's argument vector even if a future call accidentally re-enables
# shell=True.
_REPO_URL_RE = re.compile(r"^(https?://|git@|ssh://|git://)[A-Za-z0-9._@:/~+\-]{1,512}$")

def _safe_repo_url(value):
    if not value:
        return None
    value = value.strip()
    return value if _REPO_URL_RE.match(value) else None

def _detect_repo_url():
    env = _safe_repo_url(os.environ.get("PROJECT_MEMORY_REPO_URL"))
    if env:
        return env
    try:
        here = Path(__file__).resolve().parent
        result = subprocess.run(
            ["git", "-C", str(here), "config", "--get", "remote.origin.url"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return _safe_repo_url(result.stdout.strip())
    except Exception:
        pass
    return None

REPO_URL = _detect_repo_url()

HOOKS = [
    ("SessionStart", "hooks/scripts/session-start.js", 5),
    ("PreToolUse", "hooks/scripts/pre-tool-use.js", 3),
    ("PostToolUse", "hooks/scripts/post-tool-use.js", 3),
    ("Stop", "hooks/scripts/session-stop.js", 15),
]

IS_WINDOWS = platform.system() == "Windows"

# ─── Utilities ───────────────────────────────────────────────────────────────


def print_step(n, total, msg):
    print(f"\n[{n}/{total}] {msg}")


def print_ok(msg):
    print(f"  + {msg}")


def print_warn(msg):
    print(f"  ! {msg}")


def print_err(msg):
    print(f"  X {msg}", file=sys.stderr)


def to_forward_slashes(p):
    """Convert path to forward slashes for use in JSON command strings."""
    return str(p).replace("\\", "/")


def run_cmd(args, capture=True, check=False, **kwargs):
    """Run a subprocess command safely without shell=True for list args.

    SECURITY: never pass shell=True with a list — that re-joins the list
    into a string and re-parses through cmd.exe, which is shell-injection
    prone if any element later contains user input. Instead, on Windows we
    resolve the executable through shutil.which() so PATH lookup of .cmd /
    .exe still works without invoking a shell.
    """
    if isinstance(args, list) and args:
        # Force shell=False for list args; resolve the binary explicitly.
        kwargs["shell"] = False
        if IS_WINDOWS:
            resolved = shutil.which(args[0])
            if resolved:
                args = [resolved] + args[1:]
    elif isinstance(args, str):
        # String commands may legitimately need a shell (kept for the few
        # places that pass a literal pipeline). Caller controls these.
        kwargs.setdefault("shell", True)
    try:
        result = subprocess.run(
            args,
            capture_output=capture,
            text=True,
            check=check,
            **kwargs,
        )
        return result
    except FileNotFoundError:
        return None
    except subprocess.CalledProcessError as e:
        return e


def cmd_version(cmd):
    """Return version string from a command, or None if not found."""
    result = run_cmd([cmd, "--version"])
    if result and hasattr(result, "stdout") and result.returncode == 0:
        output = (result.stdout or "").strip()
        # Extract version number from output like "v20.11.0" or "node v20.11.0"
        match = re.search(r"v?(\d+\.\d+\.\d+)", output)
        return match.group(0) if match else output
    return None


def read_json(path):
    """Read a JSON file, return parsed dict or None."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def write_json(path, data):
    """Write data as formatted JSON to path, creating parent dirs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def claude_home():
    """Return ~/.claude/ as a Path."""
    return Path.home() / ".claude"


def copilot_home():
    """Return ~/.copilot/ as a Path."""
    return Path.home() / ".copilot"


def settings_path():
    return claude_home() / "settings.json"


def plugins_path():
    return claude_home() / "plugins" / "installed_plugins.json"


def prompt_yn(question, default=False):
    """Prompt user for yes/no, return bool."""
    suffix = " [Y/n] " if default else " [y/N] "
    answer = input(question + suffix).strip().lower()
    if not answer:
        return default
    return answer in ("y", "yes")


# ─── Step 1: Preflight Checks ───────────────────────────────────────────────


def check_git():
    ver = cmd_version("git")
    if ver:
        print_ok(f"Git {ver} found")
        return True
    print_err("Git not found. Please install Git: https://git-scm.com/downloads")
    return False


def check_node():
    ver = cmd_version("node")
    if ver:
        print_ok(f"Node.js {ver} found")
        return True
    return False


def check_npm():
    ver = cmd_version("npm")
    if ver:
        print_ok(f"npm {ver} found")
        return True
    return False


def install_node():
    """Attempt to auto-install Node.js LTS."""
    system = platform.system()
    print_warn("Node.js not found. Attempting auto-install...")

    if system == "Windows":
        print("  Running: winget install OpenJS.NodeJS.LTS")
        result = run_cmd(["winget", "install", "OpenJS.NodeJS.LTS", "--accept-source-agreements", "--accept-package-agreements"])
        if result and result.returncode == 0:
            print_ok("Node.js installed via winget")
            print_warn("You may need to restart your terminal for PATH changes.")
            return True

    elif system == "Darwin":
        # Check for Homebrew
        brew = run_cmd(["brew", "--version"])
        if brew and brew.returncode == 0:
            print("  Running: brew install node")
            result = run_cmd(["brew", "install", "node"], capture=False)
            if result and result.returncode == 0:
                print_ok("Node.js installed via Homebrew")
                return True
        else:
            print_warn("Homebrew not found.")

    elif system == "Linux":
        # SECURITY: We previously piped a remote shell script straight into
        # `sudo bash`, which is a textbook supply-chain risk (whoever
        # controls deb.nodesource.com owns root on the user's machine in the
        # window between download and execution). Refuse to do that and
        # instead point the user at their distribution's official path.
        print_warn("Auto-install of Node.js on Linux is disabled for safety.")
        print_warn("Please install Node.js manually using your package manager:")
        print("  Debian / Ubuntu: sudo apt-get install nodejs npm")
        print("  Fedora / RHEL  : sudo dnf install nodejs npm")
        print("  Arch           : sudo pacman -S nodejs npm")
        print("  Other          : https://nodejs.org/en/download/")
        return False

    print_err("Could not auto-install Node.js.")
    print_err("Please install manually: https://nodejs.org/en/download/")
    return False


def check_claude():
    """Check if Claude Code is installed (check for ~/.claude/ directory)."""
    if claude_home().is_dir():
        print_ok("Claude Code directory found (~/.claude/)")
        return True
    # Also try the CLI
    ver = cmd_version("claude")
    if ver:
        print_ok(f"Claude Code {ver} found")
        return True
    print_warn("Claude Code directory not found. Will create ~/.claude/ during install.")
    return True  # Non-fatal — we'll create dirs as needed


def preflight():
    """Run all preflight checks. Returns True if ready to proceed."""
    print_step(1, 8, "Preflight checks")

    ok = check_git()
    if not ok:
        return False

    node_ok = check_node()
    npm_ok = check_npm() if node_ok else False

    if not node_ok:
        installed = install_node()
        if not installed:
            return False
        # Re-check after install
        node_ok = check_node()
        npm_ok = check_npm()
        if not node_ok or not npm_ok:
            print_err("Node.js installed but not available in PATH. Restart your terminal and re-run.")
            return False

    if not npm_ok:
        print_err("npm not found despite Node.js being present. Please reinstall Node.js.")
        return False

    check_claude()
    return True


# ─── Step 2: Determine Install Path ─────────────────────────────────────────


def determine_install_path():
    """Determine where project-memory is (or should be) installed."""
    print_step(2, 8, "Determining install path")

    # Default: where this script lives
    script_dir = Path(__file__).resolve().parent
    if (script_dir / "package.json").is_file():
        print_ok(f"Using repo at: {script_dir}")
        return script_dir

    # Fallback: clone to ~/project-memory
    default_path = Path.home() / "project-memory"
    if (default_path / "package.json").is_file():
        print_ok(f"Using existing clone at: {default_path}")
        return default_path

    print(f"  Cloning {REPO_URL} to {default_path}...")
    if not REPO_URL:
        print_err("No REPO_URL detected. Set PROJECT_MEMORY_REPO_URL or clone the repo manually first.")
        return None
    result = run_cmd(["git", "clone", REPO_URL, str(default_path)], capture=False)
    if result and result.returncode == 0:
        print_ok(f"Cloned to: {default_path}")
        return default_path

    print_err(f"Failed to clone repo. Please clone manually to {default_path}")
    return None


# ─── Step 3: npm install ────────────────────────────────────────────────────


def npm_install(install_path):
    print_step(3, 8, "Installing npm dependencies")
    result = run_cmd(["npm", "install"], capture=False, cwd=str(install_path))
    if result and result.returncode == 0:
        print_ok("npm install completed")
        return True
    print_err("npm install failed. Check the output above.")
    return False


# ─── Step 4: Register Plugin ────────────────────────────────────────────────


def register_plugin(install_path):
    print_step(4, 8, "Registering plugin in installed_plugins.json")

    pp = plugins_path()
    data = read_json(pp)
    if data is None:
        data = {"version": 2, "plugins": {}}
        pp.parent.mkdir(parents=True, exist_ok=True)
        print_ok("Created installed_plugins.json")

    if "plugins" not in data:
        data["plugins"] = {}

    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    # Use OS-native path separators for installPath (matching existing entries)
    native_path = str(install_path)

    existing = data["plugins"].get(PLUGIN_ID)
    if existing and isinstance(existing, list) and len(existing) > 0:
        # Update existing
        existing[0]["installPath"] = native_path
        existing[0]["lastUpdated"] = now
        existing[0]["version"] = PLUGIN_VERSION
        print_ok(f"Updated existing plugin entry (installPath={native_path})")
    else:
        data["plugins"][PLUGIN_ID] = [
            {
                "scope": "user",
                "installPath": native_path,
                "version": PLUGIN_VERSION,
                "installedAt": now,
                "lastUpdated": now,
            }
        ]
        print_ok(f"Added plugin entry (installPath={native_path})")

    write_json(pp, data)
    return True


# ─── Step 5: Register Hooks ─────────────────────────────────────────────────


def register_hooks(install_path):
    print_step(5, 8, "Registering hooks in settings.json")

    sp = settings_path()
    data = read_json(sp)
    if data is None:
        data = {}
        sp.parent.mkdir(parents=True, exist_ok=True)
        print_ok("Created settings.json")

    if "hooks" not in data:
        data["hooks"] = {}

    fwd_path = to_forward_slashes(install_path)
    added = 0

    for event, script, timeout in HOOKS:
        command = f'node "{fwd_path}/{script}"'

        if event not in data["hooks"]:
            data["hooks"][event] = []

        # Dedup: check if a hook command containing "project-memory" already exists
        already_exists = False
        for entry in data["hooks"][event]:
            inner_hooks = entry.get("hooks", [])
            for h in inner_hooks:
                if "project-memory" in h.get("command", ""):
                    already_exists = True
                    # Update the command and timeout in case path changed
                    h["command"] = command
                    h["timeout"] = timeout
                    break
            if already_exists:
                break

        if already_exists:
            print_ok(f"Updated existing {event} hook")
        else:
            data["hooks"][event].append(
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": command,
                            "timeout": timeout,
                        }
                    ]
                }
            )
            added += 1
            print_ok(f"Added {event} hook (timeout={timeout}s)")

    write_json(sp, data)
    if added == 0:
        print_ok("All hooks already registered (updated paths)")
    return True


# ─── Step 6: Register MCP Server ────────────────────────────────────────────


def register_mcp_server(install_path):
    print_step(6, 8, "Registering MCP server + enabledPlugins in settings.json")

    sp = settings_path()
    data = read_json(sp)
    if data is None:
        data = {}

    fwd_path = to_forward_slashes(install_path)
    mcp_script = f"{fwd_path}/scripts/mcp-server.mjs"

    # Register MCP server
    if "mcpServers" not in data:
        data["mcpServers"] = {}

    data["mcpServers"][MCP_SERVER_KEY] = {
        "command": "node",
        "args": [mcp_script],
    }
    print_ok(f"MCP server registered: node {mcp_script}")

    # Register enabledPlugins
    if "enabledPlugins" not in data:
        data["enabledPlugins"] = {}

    data["enabledPlugins"][PLUGIN_ID] = True
    print_ok(f"Plugin enabled: {PLUGIN_ID}")

    write_json(sp, data)
    return True


# ─── Step 7: Initialize .ai-memory ──────────────────────────────────────────


def init_ai_memory(install_path):
    print_step(7, 8, "Initializing .ai-memory")

    save_decision = install_path / "scripts" / "save-decision.js"
    if not save_decision.is_file():
        print_err(f"save-decision.js not found at {save_decision}")
        return False

    result = run_cmd(
        [
            "node",
            str(save_decision),
            "setup",
            "Installed project-memory",
            "Initial setup via install.py",
        ],
        cwd=str(install_path),
    )
    if result and result.returncode == 0:
        print_ok(".ai-memory/ initialized")
        return True

    # Even if it errored, .ai-memory may already exist
    if (install_path / ".ai-memory").is_dir():
        print_ok(".ai-memory/ already exists")
        return True

    print_err("Failed to initialize .ai-memory/")
    return False


# ─── Step 8: Build Code Graph ───────────────────────────────────────────────


def build_code_graph(install_path):
    print_step(8, 9, "Building code graph")

    build_script = install_path / "scripts" / "build-code-graph.js"
    if not build_script.is_file():
        print_warn("build-code-graph.js not found, skipping code graph build")
        return True

    result = run_cmd(
        ["node", str(build_script), str(install_path)],
        capture=False,
        cwd=str(install_path),
    )
    if result and result.returncode == 0:
        print_ok("Code graph built")
        return True

    print_warn("Code graph build had issues (non-fatal)")
    return True  # Non-fatal


# ─── AI Router Setup (optional) ─────────────────────────────────────────────


ROUTER_RECOMMENDED_MODELS = [
    ("llama3.2:3b", "general chat (TIER_SIMPLE) — ~2 GB"),
    ("nomic-embed-text", "embeddings (TIER_EMBED) — ~275 MB"),
    ("qwen2.5-coder:7b", "code-heavy tasks (TIER_CODE) — ~4.5 GB"),
]

ROUTER_DEFAULT_CONFIG = {
    "router_port": 8081,
    "router_mode": "balanced",
    "router_privacy_mode": False,
    "router_fallback_on_low_confidence": True,
    "router_route_embeddings": True,
    "ollama_url": "http://127.0.0.1:11434",
    "tier_simple": "llama3.2:3b",
    "tier_complex": None,
    "tier_code": "qwen2.5-coder:7b",
    "tier_embed": "nomic-embed-text",
    "anthropic_upstream_url": "https://api.anthropic.com",
    "openai_upstream_url": "https://api.openai.com",
    "router_cache_ttl_hours": 24,
    "router_cache_semantic_threshold": 0.92,
}


def check_ollama():
    """Return Ollama version string, or None if not installed/reachable."""
    return cmd_version("ollama")


def list_ollama_models():
    """Return list of installed Ollama model names, or [] on error."""
    result = run_cmd(["ollama", "list"])
    if not result or result.returncode != 0:
        return []
    lines = (result.stdout or "").strip().splitlines()
    if len(lines) <= 1:
        return []
    # First line is header; subsequent lines: NAME  ID  SIZE  MODIFIED
    names = []
    for line in lines[1:]:
        parts = line.split()
        if parts:
            names.append(parts[0])
    return names


def write_router_config(router_dir):
    """Write default ~/.ai-router/config.json if missing. Returns the file path."""
    router_dir.mkdir(parents=True, exist_ok=True)
    config_file = router_dir / "config.json"
    if config_file.exists():
        print_ok(f"Existing config preserved: {config_file}")
        return config_file
    write_json(config_file, ROUTER_DEFAULT_CONFIG)
    print_ok(f"Wrote default config: {config_file}")
    return config_file


def pull_ollama_model(model):
    """Pull an Ollama model. Streams output (large download)."""
    print(f"  -> Pulling {model} (this can take several minutes)...")
    result = run_cmd(["ollama", "pull", model], capture=False)
    if result and result.returncode == 0:
        print_ok(f"Pulled {model}")
        return True
    print_warn(f"Failed to pull {model} (you can run 'ollama pull {model}' later)")
    return False


def setup_ai_router(install_path):
    """
    Step 9: Optional AI Router setup.

    - Detects Ollama. If absent, prints install hint and skips.
    - Writes ~/.ai-router/config.json with sensible defaults (no overwrite).
    - Optionally pulls recommended models per tier.
    - Prints integration snippets.

    No new npm packages are required — the router uses dependencies already
    installed by `npm install` (better-sqlite3, @huggingface/transformers).
    """
    print_step(9, 9, "Configuring AI Router (optional, local-first LLM proxy)")

    if not (install_path / "router" / "index.js").is_file():
        print_warn("router/ not present in this checkout — skipping")
        return True

    ollama_version = check_ollama()
    if not ollama_version:
        print_warn("Ollama not found on PATH.")
        print(
            "    Install from https://ollama.com/download to enable local-first "
            "routing,\n    then re-run this installer or just run 'ollama pull "
            "llama3.2:3b'."
        )
        print_ok("Skipping router setup (router can be enabled later)")
        return True

    print_ok(f"Ollama detected: {ollama_version}")

    if not prompt_yn(
        "  Configure AI Router now (writes ~/.ai-router/config.json)?",
        default=True,
    ):
        print_ok("Skipped router setup")
        return True

    router_dir = Path.home() / ".ai-router"
    write_router_config(router_dir)

    installed = set(list_ollama_models())
    missing = [
        (m, desc)
        for m, desc in ROUTER_RECOMMENDED_MODELS
        if not any(m == name or name.startswith(m + ":") for name in installed)
    ]

    if missing:
        print()
        print("  Recommended Ollama models not yet installed:")
        for m, desc in missing:
            print(f"    - {m:<22} {desc}")
        if prompt_yn(
            "  Pull these models now? (large downloads; you can defer)",
            default=False,
        ):
            for m, _ in missing:
                pull_ollama_model(m)
        else:
            print_ok(
                "Skipped model pull — fetch later with 'ollama pull <model>'"
            )
    else:
        print_ok("All recommended Ollama models already installed")

    print()
    print("  To start the router:")
    print(f"    cd {install_path}")
    print("    npm run router:start         # or: node router/index.js")
    print()
    print("  Then point your client at it:")
    print("    export ANTHROPIC_BASE_URL=http://localhost:8081")
    print("    export OPENAI_BASE_URL=http://localhost:8081/v1")
    print()
    print("  Documentation:")
    print(f"    {install_path / 'ROUTER.md'}")
    print(f"    {install_path / 'docs' / 'router-integration.md'}")

    return True


# ─── Copilot CLI MCP Registration (optional) ───────────────────────────────


def register_copilot_cli_mcp(install_path):
    """Register project-memory MCP server with GitHub Copilot CLI."""
    copilot_dir = copilot_home()
    if not copilot_dir.is_dir():
        print_warn("GitHub Copilot CLI not found (~/.copilot/ missing), skipping")
        return True

    print_step("9b", 10, "Registering MCP server with GitHub Copilot CLI")

    mcp_config_path = copilot_dir / "mcp.json"
    data = read_json(mcp_config_path)
    if data is None:
        data = {}

    fwd_path = to_forward_slashes(install_path)
    mcp_script = f"{fwd_path}/scripts/mcp-server.mjs"

    if "mcpServers" not in data:
        data["mcpServers"] = {}

    data["mcpServers"][MCP_SERVER_KEY] = {
        "command": "node",
        "args": [mcp_script],
    }

    write_json(mcp_config_path, data)
    print_ok(f"MCP server registered in {mcp_config_path}")
    return True


# ─── Install Entrypoint ─────────────────────────────────────────────────────


def install():
    print("=" * 60)
    print("  project-memory installer")
    print(f"  Platform: {platform.system()} ({platform.machine()})")
    print("=" * 60)

    # Step 1
    if not preflight():
        print_err("\nPreflight checks failed. Fix the issues above and re-run.")
        return False

    # Step 2
    install_path = determine_install_path()
    if not install_path:
        return False

    # Step 3
    if not npm_install(install_path):
        return False

    # Step 4
    if not register_plugin(install_path):
        return False

    # Step 5
    if not register_hooks(install_path):
        return False

    # Step 6
    if not register_mcp_server(install_path):
        return False

    # Step 7
    init_ai_memory(install_path)  # Non-fatal

    # Step 8
    build_code_graph(install_path)  # Non-fatal

    # Step 9
    setup_ai_router(install_path)  # Non-fatal

    # Step 9b
    register_copilot_cli_mcp(install_path)  # Non-fatal

    # Summary
    print("\n" + "=" * 60)
    print("  Installation complete!")
    print("=" * 60)
    print(f"\n  Install path:  {install_path}")
    print(f"  Plugin ID:     {PLUGIN_ID}")
    print(f"  Hooks:         {len(HOOKS)} registered in settings.json")
    print(f"  MCP server:    {MCP_SERVER_KEY} in settings.json")
    copilot_mcp = copilot_home() / "mcp.json"
    if copilot_mcp.is_file():
        print(f"  Copilot CLI:   MCP registered in {copilot_mcp}")
    router_config = Path.home() / ".ai-router" / "config.json"
    if router_config.is_file():
        print(f"  AI Router:     enabled (config at {router_config})")
    else:
        print(f"  AI Router:     not configured (run installer again or see ROUTER.md)")
    print(f"\n  -> Restart Claude Code / Copilot CLI to activate project-memory")
    print()
    return True


# ─── Uninstall ───────────────────────────────────────────────────────────────


def uninstall():
    print("=" * 60)
    print("  project-memory uninstaller")
    print("=" * 60)

    # Step 1: Detect install path
    print_step(1, 5, "Detecting install path")
    script_dir = Path(__file__).resolve().parent
    if (script_dir / "package.json").is_file():
        install_path = script_dir
    elif (Path.home() / "project-memory" / "package.json").is_file():
        install_path = Path.home() / "project-memory"
    else:
        install_path = script_dir  # Best guess
    print_ok(f"Install path: {install_path}")

    # Step 2: Remove from settings.json
    print_step(2, 5, "Removing hooks, MCP server, and plugin from settings.json")
    sp = settings_path()
    data = read_json(sp)
    if data:
        # Remove hook entries containing "project-memory"
        hooks = data.get("hooks", {})
        for event in list(hooks.keys()):
            original_len = len(hooks[event])
            hooks[event] = [
                entry
                for entry in hooks[event]
                if not any(
                    "project-memory" in h.get("command", "")
                    for h in entry.get("hooks", [])
                )
            ]
            removed = original_len - len(hooks[event])
            if removed:
                print_ok(f"Removed {removed} {event} hook(s)")
            # Clean up empty lists
            if not hooks[event]:
                del hooks[event]

        # Remove MCP server
        mcp = data.get("mcpServers", {})
        if MCP_SERVER_KEY in mcp:
            del mcp[MCP_SERVER_KEY]
            print_ok("Removed MCP server registration")

        # Remove enabled plugin
        ep = data.get("enabledPlugins", {})
        if PLUGIN_ID in ep:
            del ep[PLUGIN_ID]
            print_ok(f"Removed {PLUGIN_ID} from enabledPlugins")

        write_json(sp, data)
    else:
        print_warn("settings.json not found or empty")

    # Step 3: Remove from installed_plugins.json
    print_step(3, 5, "Removing plugin registration")
    pp = plugins_path()
    data = read_json(pp)
    if data:
        plugins = data.get("plugins", {})
        if PLUGIN_ID in plugins:
            del plugins[PLUGIN_ID]
            print_ok(f"Removed {PLUGIN_ID} from installed_plugins.json")
            write_json(pp, data)
        else:
            print_ok("Plugin not found in installed_plugins.json (already clean)")
    else:
        print_warn("installed_plugins.json not found or empty")

    # Step 4: Stop daemon
    print_step(4, 5, "Stopping daemon")
    daemon_script = install_path / "scripts" / "daemon.js"
    if daemon_script.is_file():
        result = run_cmd(["node", str(daemon_script), "--stop"])
        if result and result.returncode == 0:
            print_ok("Daemon stopped")
        else:
            print_ok("Daemon was not running (or already stopped)")
    else:
        print_warn("daemon.js not found")

    # Step 5: Ask about repo deletion
    print_step(5, 5, "Cleanup")
    if install_path.is_dir() and (install_path / "package.json").is_file():
        if prompt_yn(f"Delete the project-memory directory ({install_path})?", default=False):
            try:
                shutil.rmtree(install_path)
                print_ok(f"Deleted {install_path}")
            except OSError as e:
                print_err(f"Could not delete: {e}")
        else:
            print_ok("Kept project-memory directory")

    # Summary
    print("\n" + "=" * 60)
    print("  Uninstall complete!")
    print("=" * 60)
    print("\n  -> Restart Claude Code to finalize removal")
    print()
    return True


# ─── Main ────────────────────────────────────────────────────────────────────


def main():
    if "--uninstall" in sys.argv:
        success = uninstall()
    else:
        success = install()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
