"""unit tests for enforce-batch-on-direct-call.py."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

HOOKS_DIR = Path(__file__).parent.parent
HOOK_PATH = HOOKS_DIR / "enforce-batch-on-direct-call.py"


def _bash(cmd: str, session_id: str = "sess-1") -> dict:
    return {
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "session_id": session_id,
    }


def _run(payload: dict, home: Path) -> tuple[int, str, str]:
    proc = subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env={"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/local/bin"},
        timeout=10,
    )
    return proc.returncode, proc.stdout, proc.stderr


@pytest.fixture
def fake_home(tmp_path):
    home = tmp_path / "home"
    (home / ".claude" / "locks").mkdir(parents=True)
    (home / ".claude" / ".metrics").mkdir(parents=True)
    return home


def _ledger(home: Path) -> list[dict]:
    p = home / ".claude" / "locks" / "recent-direct-calls.json"
    if not p.exists():
        return []
    return json.loads(p.read_text())


def test_first_call_passes(fake_home):
    rc, _, _ = _run(_bash("~/.claude/bin/ts-direct call textDocument/hover foo"), fake_home)
    assert rc == 0
    assert len(_ledger(fake_home)) == 1


def test_second_distinct_file_within_window_blocks(fake_home):
    p1 = _bash('~/.claude/bin/ts-direct call textDocument/hover \'{"textDocument":{"uri":"file:///abs/a.ts"}}\'')
    p2 = _bash('~/.claude/bin/ts-direct call textDocument/hover \'{"textDocument":{"uri":"file:///abs/b.ts"}}\'')
    rc1, _, _ = _run(p1, fake_home)
    assert rc1 == 0
    rc2, _, err = _run(p2, fake_home)
    assert rc2 == 2
    assert "BLOCKED by enforce-batch-on-direct-call" in err
    assert "ts-direct batch" in err


def test_lsp_wrapper_block_message_includes_batch_convenience(fake_home):
    p1 = _bash('~/.claude/bin/py-direct call textDocument/documentSymbol \'{"textDocument":{"uri":"file:///abs/a.py"}}\'')
    p2 = _bash('~/.claude/bin/py-direct call textDocument/documentSymbol \'{"textDocument":{"uri":"file:///abs/b.py"}}\'')
    _run(p1, fake_home)
    _, _, err = _run(p2, fake_home)
    assert "py-direct batch textDocument/documentSymbol" in err
    assert "py-direct batch-json" in err


def test_non_lsp_wrapper_block_message_only_batch_json(fake_home):
    p1 = _bash("~/.claude/bin/prettier-direct call format-file '{\"filepath\":\"/a.ts\"}'")
    p2 = _bash("~/.claude/bin/prettier-direct call format-file '{\"filepath\":\"/b.ts\"}'")
    _run(p1, fake_home)
    _, _, err = _run(p2, fake_home)
    assert "prettier-direct batch-json" in err
    # non-LSP wrappers MUST NOT advertise the file-positional batch convenience
    assert "prettier-direct batch format-file /abs" not in err


def test_different_method_same_wrapper_passes(fake_home):
    p1 = _bash("~/.claude/bin/ts-direct call textDocument/hover foo")
    p2 = _bash("~/.claude/bin/ts-direct call textDocument/references bar")
    _run(p1, fake_home)
    rc2, _, _ = _run(p2, fake_home)
    assert rc2 == 0


def test_different_session_same_method_passes(fake_home):
    p1 = _bash("~/.claude/bin/ts-direct call textDocument/hover foo", session_id="A")
    p2 = _bash("~/.claude/bin/ts-direct call textDocument/hover foo", session_id="B")
    _run(p1, fake_home)
    rc2, _, _ = _run(p2, fake_home)
    assert rc2 == 0


def test_metals_direct_excluded(fake_home):
    """metals-direct uses MCP transport (no /batch surface) — NEVER blocks regardless of repeat."""
    payload = _bash("~/.claude/bin/metals-direct call glob-search foo")
    rc1, _, _ = _run(payload, fake_home)
    rc2, _, _ = _run(payload, fake_home)
    assert rc1 == 0
    assert rc2 == 0
    # ledger MUST stay empty for metals
    assert _ledger(fake_home) == []


def test_non_bash_tool_passes(fake_home):
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "Edit",
        "tool_input": {"file_path": "/x"},
        "session_id": "sess-1",
    }
    rc, _, _ = _run(payload, fake_home)
    assert rc == 0


def test_non_direct_command_passes(fake_home):
    rc, _, _ = _run(_bash("ls -la"), fake_home)
    assert rc == 0


def test_invalid_json_payload_passes(fake_home):
    proc = subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input="not json",
        capture_output=True,
        text=True,
        env={"HOME": str(fake_home), "PATH": "/usr/bin:/bin"},
        timeout=5,
    )
    assert proc.returncode == 0


def test_call_inside_quoted_string_does_not_match(fake_home):
    """codex review 2026-05-07 — substring `ts-direct call` inside a QUOTED arg of grep/cat/echo
    MUST NOT trigger the hook. shlex.split groups the quoted string into a single token, so
    the basename check fails correctly. Issuing the same cmd twice MUST stay rc=0 each time
    AND ledger MUST stay empty (no false-positive bookkeeping)."""
    cmd = 'grep "ts-direct call foo" /tmp/notes.md'
    rc1, _, _ = _run(_bash(cmd), fake_home)
    rc2, _, _ = _run(_bash(cmd), fake_home)
    assert rc1 == 0
    assert rc2 == 0
    assert _ledger(fake_home) == [], "FP detection MUST NOT pollute ledger with quoted-arg matches"


def test_chained_command_real_invocation_after_separator(fake_home):
    """when a real `ts-direct call` appears AFTER a `;` or `&&` chain separator,
    the hook MUST detect it (token-based scan walks the full token list)."""
    cmd1 = 'echo hi; ~/.claude/bin/ts-direct call textDocument/hover \'{"textDocument":{"uri":"file:///a.ts"}}\''
    cmd2 = 'echo hi && ~/.claude/bin/ts-direct call textDocument/hover \'{"textDocument":{"uri":"file:///b.ts"}}\''
    rc1, _, _ = _run(_bash(cmd1), fake_home)
    rc2, _, err = _run(_bash(cmd2), fake_home)
    assert rc1 == 0  # 1st pass
    assert rc2 == 2  # 2nd same-method, distinct file blocks
    assert "BLOCKED" in err


def test_path_prefixed_wrapper_token_matches(fake_home):
    """`/abs/.../ts-direct` and `~/.claude/bin/ts-direct` and bare `ts-direct` are equivalent
    after rsplit('/', -1) — basename check catches all three. Distinct files per call so the
    block fires on the file-set rule (not the old wall-clock rule)."""
    p1 = _bash('/Users/blanquitoh/.claude/bin/ts-direct call textDocument/hover \'{"textDocument":{"uri":"file:///a.ts"}}\'')
    p2 = _bash('ts-direct call textDocument/hover \'{"textDocument":{"uri":"file:///b.ts"}}\'')
    p3 = _bash('~/.claude/bin/ts-direct call textDocument/hover \'{"textDocument":{"uri":"file:///c.ts"}}\'')
    rc1, _, _ = _run(p1, fake_home)
    rc2, _, _ = _run(p2, fake_home)
    rc3, _, _ = _run(p3, fake_home)
    assert rc1 == 0
    assert rc2 == 2  # 2nd distinct-file blocks
    assert rc3 == 2  # 3rd distinct-file blocks


def test_malformed_quoting_passes_through(fake_home):
    """shlex.split raises ValueError on unclosed quotes — hook MUST NEVER block on parse failure
    (passing-through is the safe default; a true direct-call would parse cleanly)."""
    # unclosed double-quote → shlex raises
    rc, _, _ = _run(_bash('echo "unclosed'), fake_home)
    assert rc == 0


def test_window_expiry_allows_repeat(fake_home, monkeypatch):
    """entries older than WINDOW_SEC=60s MUST not block. Simulate by writing a stale ledger."""
    # write a synthetic stale entry beyond the 60s window
    ledger_path = fake_home / ".claude" / "locks" / "recent-direct-calls.json"
    stale = [{
        "ts": time.time() - 90,  # 90s ago, beyond 60s window
        "session_id": "sess-1",
        "wrapper": "ts-direct",
        "method": "textDocument/hover",
        "file": "/abs/a.ts",
    }]
    ledger_path.write_text(json.dumps(stale))
    rc, _, _ = _run(_bash("~/.claude/bin/ts-direct call textDocument/hover foo"), fake_home)
    assert rc == 0


def test_same_file_repeat_passes_through(fake_home):
    """same-file refresh within window MUST NOT block — idempotent retry, not batch-able fan-out."""
    ledger_path = fake_home / ".claude" / "locks" / "recent-direct-calls.json"
    seed = [{
        "ts": time.time() - 10,
        "session_id": "sess-1",
        "wrapper": "ts-direct",
        "method": "textDocument/hover",
        "file": "/abs/a.ts",
    }]
    ledger_path.write_text(json.dumps(seed))
    cmd = '~/.claude/bin/ts-direct call textDocument/hover \'{"textDocument":{"uri":"file:///abs/a.ts"},"position":{"line":1,"character":1}}\''
    rc, _, _ = _run(_bash(cmd), fake_home)
    assert rc == 0


def test_malformed_ledger_ts_does_not_crash(fake_home):
    """ledger with non-numeric ts (e.g. corrupted disk write) MUST NOT crash the hook —
    malformed entries coerce to ancient via _ts() and get pruned. (codex 2026-05-19 finding.)"""
    ledger_path = fake_home / ".claude" / "locks" / "recent-direct-calls.json"
    malformed = [
        {"ts": "bad", "session_id": "sess-1", "wrapper": "ts-direct", "method": "textDocument/hover", "file": "/a.ts"},
        {"ts": None, "session_id": "sess-1", "wrapper": "ts-direct", "method": "textDocument/hover", "file": "/b.ts"},
        {"session_id": "sess-1", "wrapper": "ts-direct", "method": "textDocument/hover", "file": "/c.ts"},  # missing ts
    ]
    ledger_path.write_text(json.dumps(malformed))
    rc, _, _ = _run(_bash('~/.claude/bin/ts-direct call textDocument/hover \'{"textDocument":{"uri":"file:///d.ts"}}\''), fake_home)
    assert rc == 0  # malformed pruned, new call passes through


def test_unparseable_params_passes_through(fake_home):
    """2nd call with unparseable JSON params (file_key extraction fails) MUST pass through —
    avoid FP on supported wrappers whose param shape doesn't match the regex set."""
    ledger_path = fake_home / ".claude" / "locks" / "recent-direct-calls.json"
    seed = [{
        "ts": time.time() - 10,
        "session_id": "sess-1",
        "wrapper": "ts-direct",
        "method": "textDocument/hover",
        "file": "/abs/a.ts",
    }]
    ledger_path.write_text(json.dumps(seed))
    # bare positional arg, no JSON params at all → file extraction returns ''
    rc, _, _ = _run(_bash("~/.claude/bin/ts-direct call textDocument/hover foo"), fake_home)
    assert rc == 0


def test_different_file_within_window_blocks(fake_home):
    """different-file 2nd call within window MUST block — genuine batch case."""
    ledger_path = fake_home / ".claude" / "locks" / "recent-direct-calls.json"
    seed = [{
        "ts": time.time() - 10,
        "session_id": "sess-1",
        "wrapper": "ts-direct",
        "method": "textDocument/hover",
        "file": "/abs/a.ts",
    }]
    ledger_path.write_text(json.dumps(seed))
    cmd = '~/.claude/bin/ts-direct call textDocument/hover \'{"textDocument":{"uri":"file:///abs/b.ts"},"position":{"line":1,"character":1}}\''
    rc, _, stderr = _run(_bash(cmd), fake_home)
    assert rc == 2
    assert "distinct-file" in stderr


def test_ledger_max_age_pruning(fake_home):
    """entries older than 5 min MUST be pruned on every write."""
    ledger_path = fake_home / ".claude" / "locks" / "recent-direct-calls.json"
    # one ancient entry + one fresh entry; only fresh survives
    seed = [
        {"ts": time.time() - 600, "session_id": "old", "wrapper": "ts-direct", "method": "x"},
        {"ts": time.time() - 30, "session_id": "fresh", "wrapper": "ts-direct", "method": "y"},
    ]
    ledger_path.write_text(json.dumps(seed))
    # trigger a new write by issuing a non-blocking call
    _run(_bash("~/.claude/bin/cs-direct call textDocument/hover z"), fake_home)
    after = _ledger(fake_home)
    assert len(after) == 2
    assert all(e["session_id"] != "old" for e in after)
