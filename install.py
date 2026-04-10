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

PLUGIN_ID = "project-memory@project-memory-marketplace"
MCP_SERVER_KEY = "project-memory"
PLUGIN_VERSION = "1.0.0"
REPO_URL = "https://github.com/sunil-goyal-1502/project-memory.git"

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
    """Run a subprocess command. On Windows, use shell=True for commands
    that need PATH resolution (like node, npm, git)."""
    if IS_WINDOWS and isinstance(args, list):
        # On Windows, shell=True is needed for PATH resolution of .cmd/.exe
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
        # Try apt-based install
        if shutil.which("apt-get"):
            print("  Running: NodeSource LTS setup + apt-get install nodejs")
            print_warn("This may require sudo access.")
            setup = run_cmd(
                "curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -",
                capture=False,
                shell=True,
            )
            if setup and setup.returncode == 0:
                result = run_cmd(
                    ["sudo", "apt-get", "install", "-y", "nodejs"], capture=False
                )
                if result and result.returncode == 0:
                    print_ok("Node.js installed via apt")
                    return True

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
    print_step(8, 8, "Building code graph")

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

    # Summary
    print("\n" + "=" * 60)
    print("  Installation complete!")
    print("=" * 60)
    print(f"\n  Install path:  {install_path}")
    print(f"  Plugin ID:     {PLUGIN_ID}")
    print(f"  Hooks:         {len(HOOKS)} registered in settings.json")
    print(f"  MCP server:    {MCP_SERVER_KEY} in settings.json")
    print(f"\n  -> Restart Claude Code to activate project-memory")
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
