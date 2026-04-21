"""unit tests for enforce-lsp-workspace-root.py."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

HOOKS_DIR = Path(__file__).parent.parent
HOOK_PATH = HOOKS_DIR / "enforce-lsp-workspace-root.py"


def _run(payload: dict, cwd: Path, cs_direct: bool = False) -> tuple[int, str, str]:
    # isolate HOME so the hook's ~/.claude/bin/cs-direct presence check is deterministic per test
    import os
    fake_home = cwd / "_home"
    fake_home.mkdir(exist_ok=True)
    bin_dir = fake_home / ".claude" / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    if cs_direct:
        wrapper = bin_dir / "cs-direct"
        wrapper.write_text("#!/bin/sh\nexit 0")
        wrapper.chmod(0o755)
    env = {"HOME": str(fake_home), "PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    proc = subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=str(cwd),
        env=env,
        timeout=10,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _edit(file_path: str, tool: str = "Edit") -> dict:
    return {
        "hook_event_name": "PreToolUse",
        "session_id": "s1",
        "tool_name": tool,
        "tool_input": {"file_path": file_path},
    }


# ---------- csharp ----------


def test_cs_blocks_when_cwd_outside(tmp_path):
    project = tmp_path / "Core.Client"
    project.mkdir()
    (project / "Core.Client.csproj").write_text("<Project/>\n")
    cs_file = project / "Foo.cs"
    cs_file.write_text("")
    outside = tmp_path / "other"
    outside.mkdir()
    rc, _, err = _run(_edit(str(cs_file)), outside)
    assert rc == 2
    assert "csharp-lsp" in err
    assert str(project) in err


def test_cs_passes_when_cwd_inside(tmp_path):
    project = tmp_path / "Core.Client"
    project.mkdir()
    (project / "Core.Client.csproj").write_text("")
    cs_file = project / "Foo.cs"
    cs_file.write_text("")
    rc, _, _ = _run(_edit(str(cs_file)), project)
    assert rc == 0


def test_cs_passes_when_cwd_is_subdir(tmp_path):
    project = tmp_path / "Core.Client"
    subdir = project / "Security"
    subdir.mkdir(parents=True)
    (project / "Core.Client.csproj").write_text("")
    cs_file = subdir / "Attr.cs"
    cs_file.write_text("")
    rc, _, _ = _run(_edit(str(cs_file)), subdir)
    assert rc == 0


def test_cs_finds_slnx_marker(tmp_path):
    project = tmp_path / "Core"
    project.mkdir()
    (project / "Core.slnx").write_text("")
    cs_file = project / "Foo.cs"
    cs_file.write_text("")
    outside = tmp_path / "away"
    outside.mkdir()
    rc, _, _ = _run(_edit(str(cs_file)), outside)
    assert rc == 2


def test_cs_loose_file_passes(tmp_path):
    loose = tmp_path / "Untracked.cs"
    loose.write_text("")
    rc, _, _ = _run(_edit(str(loose)), tmp_path)
    assert rc == 0


# ---------- passthrough ----------


@pytest.mark.parametrize("ext", [".ts", ".py", ".js", ".md", ".json", ".scala", ".sbt", ".sc"])
def test_non_target_extensions_pass(tmp_path, ext):
    f = tmp_path / f"file{ext}"
    f.write_text("")
    rc, _, _ = _run(_edit(str(f)), tmp_path)
    assert rc == 0


@pytest.mark.parametrize("tool", ["Read", "Bash", "Grep", "Glob", "WebFetch"])
def test_non_edit_tools_pass(tmp_path, tool):
    project = tmp_path / "Core"
    project.mkdir()
    (project / "Core.csproj").write_text("")
    cs_file = project / "Foo.cs"
    cs_file.write_text("")
    outside = tmp_path / "away"
    outside.mkdir()
    rc, _, _ = _run(_edit(str(cs_file), tool=tool), outside)
    assert rc == 0


def test_multiedit_blocks_same_as_edit(tmp_path):
    project = tmp_path / "Core"
    project.mkdir()
    (project / "Core.csproj").write_text("")
    cs_file = project / "Foo.cs"
    cs_file.write_text("")
    outside = tmp_path / "away"
    outside.mkdir()
    rc, _, _ = _run(_edit(str(cs_file), tool="MultiEdit"), outside)
    assert rc == 2


def test_missing_file_path_passes(tmp_path):
    payload = {"hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {}}
    rc, _, _ = _run(payload, tmp_path)
    assert rc == 0


def test_cs_direct_presence_bypasses_cwd_check(tmp_path):
    # cs-direct wrapper handles per-workspace rootUri binding → hook must bypass the cwd-in-.sln check
    project = tmp_path / "Core.Client"
    project.mkdir()
    (project / "Core.Client.csproj").write_text("<Project/>\n")
    cs_file = project / "Foo.cs"
    cs_file.write_text("")
    outside = tmp_path / "other"
    outside.mkdir()
    rc, _, _ = _run(_edit(str(cs_file)), outside, cs_direct=True)
    assert rc == 0


def test_invalid_json_exits_zero(tmp_path):
    proc = subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input="not json",
        capture_output=True,
        text=True,
        cwd=str(tmp_path),
        timeout=5,
    )
    assert proc.returncode == 0


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
