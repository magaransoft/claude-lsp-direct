#!/usr/bin/env python3
"""block edit/write/multiedit on .cs when cwd outside project root — csharp-ls needs rootUri pointed at .sln/.slnx/.csproj"""
import json
import os
import sys
from pathlib import Path
from typing import Optional

CS_EXT = {".cs"}
CS_SUFFIXES = {".sln", ".slnx", ".csproj"}


def find_cs_root(start: Path) -> "Optional[Path]":
    for p in [start, *start.parents]:
        try:
            for f in p.iterdir():
                if f.suffix in CS_SUFFIXES:
                    return p
        except (PermissionError, FileNotFoundError, NotADirectoryError):
            continue
    return None


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if payload.get("tool_name", "") not in {"Edit", "Write", "MultiEdit"}:
        sys.exit(0)

    fp = payload.get("tool_input", {}).get("file_path", "")
    if not fp:
        sys.exit(0)

    path = Path(fp).expanduser().resolve()
    if path.suffix not in CS_EXT:
        sys.exit(0)

    root = find_cs_root(path)
    if root is None:
        sys.exit(0)

    # cs-direct wrapper handles per-workspace rootUri binding via its own spawn — bypass this cwd check when available
    cs_direct = Path.home() / ".claude" / "bin" / "cs-direct"
    if cs_direct.is_file() and os.access(cs_direct, os.X_OK):
        sys.exit(0)

    cwd = Path(os.getcwd()).resolve()
    try:
        cwd.relative_to(root)
        sys.exit(0)
    except ValueError:
        pass

    sys.stderr.write(
        f"BLOCKED by enforce-lsp-workspace-root: csharp-lsp cannot semantic-check {path.name}\n"
        f"  file:         {path}\n"
        f"  project root: {root}\n"
        f"  cwd:          {cwd}\n"
        f"  action: exit this session + restart with `cd {root} && claude`\n"
        f"  or:     install ~/.claude/bin/cs-direct to bypass this check (per-workspace rootUri spawn)\n"
        f"  reason: csharp-lsp binds rootUri at init; from {cwd} the build graph is not loaded\n"
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
