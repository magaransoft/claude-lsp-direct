#!/usr/bin/env python3
"""SessionStart hook — pre-warm every direct-wrapper state dir whose
server is no longer alive. Fires `<wrapper>-direct start <workspace>`
in the background for each dead slot so the first user `call` is warm.

Runs async + best-effort: failures are logged to the wrapper's own log
file and never block session start.

Detection: a wrapper is considered "cached" when
`~/.cache/<wrapper>-direct/<hash>/workspace` exists and names an
existing directory. Liveness probe via HTTP /health on the saved port.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

HOME = Path(os.environ.get("HOME", str(Path.home())))
CACHE_ROOT = HOME / ".cache"
BIN_ROOT = HOME / ".claude" / "bin"

# wrappers that support `<wrapper> start <workspace>` — skip read-only
# daemons / one-shot tools that would pay cold cost without warm benefit.
# metals-direct intentionally excluded: its adoption path reads
# <ws>/.metals/mcp.json written by the user's IDE, and SessionStart
# prewarm can race an IDE that just started — causing port conflicts
# or adoption of a stale server. Metals callers start it on-demand.
PREWARM_TARGETS = {
    "py-direct", "ts-direct", "cs-direct", "java-direct",
    "vue-direct",
    "prettier-direct", "eslint-direct",
}


def port_alive(port: str) -> bool:
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
        return True
    except Exception:
        return False


def prewarm_slot(wrapper: str, slot: Path) -> None:
    workspace_file = slot / "workspace"
    port_file = slot / "port"
    if not workspace_file.exists():
        return
    workspace = workspace_file.read_text().strip()
    if not workspace or not Path(workspace).is_dir():
        return
    if port_file.exists():
        port = port_file.read_text().strip()
        if port and port_alive(port):
            return  # already warm
    wrapper_bin = BIN_ROOT / wrapper
    if not wrapper_bin.exists():
        return
    # Probe backing-tool availability before firing. Skip cleanly when a
    # user has the state dir (prior session used the wrapper) but has
    # since uninstalled the backing tool — avoids daemon crash-loops at
    # preload time for prettier/eslint.
    if not _backing_tool_available(wrapper):
        return
    # fire-and-forget — wrapper's own background spawn writes new pid/port.
    # stdout + stderr both to DEVNULL: the wrapper normally prints
    # "started: ..." to stdout; we don't want that per-slot line cluttering
    # SessionStart output. Real spawn failures still land in slot/log
    # written by the coordinator itself (unchanged).
    try:
        subprocess.Popen(
            [str(wrapper_bin), "start", workspace],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as e:
        sys.stderr.write(f"[prewarm] {wrapper} {workspace}: {e}\n")


def _backing_tool_available(wrapper: str) -> bool:
    """True if the backing tool that the wrapper spawns exists on PATH
    or is resolvable via npm's global root. False → prewarm skips the slot."""
    import shutil
    tool = {
        "py-direct": "pyright-langserver",
        "ts-direct": "typescript-language-server",
        "cs-direct": "csharp-ls",
        "java-direct": "jdtls",
        "vue-direct": "vue-language-server",
    }.get(wrapper)
    if tool:
        return shutil.which(tool) is not None
    if wrapper in ("prettier-direct", "eslint-direct"):
        pkg = wrapper.split("-")[0]  # "prettier" | "eslint"
        # prettier/eslint load in-process via require; accept global OR
        # any parent node_modules. Cheap probe: global root install dir.
        try:
            out = subprocess.run(
                ["npm", "root", "-g"], capture_output=True, text=True, timeout=5,
            )
            if out.returncode == 0:
                root = Path(out.stdout.strip())
                if (root / pkg).is_dir():
                    return True
        except Exception:
            pass
        return False
    return True


def main() -> None:
    if not CACHE_ROOT.is_dir():
        return
    count = 0
    for wrapper in PREWARM_TARGETS:
        wdir = CACHE_ROOT / wrapper
        if not wdir.is_dir():
            continue
        for slot in wdir.iterdir():
            if not slot.is_dir():
                continue
            prewarm_slot(wrapper, slot)
            count += 1
    # non-blocking stdout — hook runner captures but doesn't require content
    print(json.dumps({"prewarm_slots_visited": count}))


if __name__ == "__main__":
    main()
