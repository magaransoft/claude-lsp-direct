"""unit tests for enforce-lsp-over-grep.py."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

HOOKS_DIR = Path(__file__).parent.parent
HOOK_PATH = HOOKS_DIR / "enforce-lsp-over-grep.py"


def _bash(cmd: str) -> dict:
    return {
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
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
    (home / ".claude" / "plugins").mkdir(parents=True)
    (home / ".claude" / "bin").mkdir(parents=True)
    return home


def _write_availability(home: Path, avail: dict) -> None:
    (home / ".claude" / "locks" / "lsp-availability.json").write_text(json.dumps(avail))


def _write_plugins(home: Path, plugin_ids: list) -> None:
    data = {"plugins": {pid: [] for pid in plugin_ids}}
    (home / ".claude" / "plugins" / "installed_plugins.json").write_text(json.dumps(data))


# ---------- extension detection ----------


@pytest.mark.parametrize("cmd,lang", [
    ('grep -rn foo ~/x --include="*.scala"',   "scala"),
    ('grep -rn foo ~/x --include="*.py"',      "python"),
    ('grep -rn foo ~/x --include="*.ts"',      "typescript"),
    ('grep -rn foo ~/x --include="*.tsx"',     "typescript"),
    ('grep -rn foo ~/x --include="*.cs"',      "csharp"),
    ('grep -rn foo ~/x --include="*.vue"',     "vue"),
    ('rg --type scala FooService ~/x',         "scala"),
    ('rg --type python FooService ~/x',        "python"),
    ('rg -g "*.ts" foo ~/x',                   "typescript"),
    ('rg -g "*.vue" foo ~/x',                  "vue"),
    ('find ~/x -name "*.cs"',                  "csharp"),
    ('find ~/x -name "*.vue"',                 "vue"),
    ('grep -l pattern ~/src/*.py',             "python"),
    ('grep -rn foo ~/x --include="*.java"',    "java"),
    ('rg --type java FooService ~/x',          "java"),
    ('find ~/x -name "*.java"',                "java"),
])
def test_blocks_when_lsp_available(fake_home, cmd, lang):
    # write fake direct-wrapper binaries so fallback treats all as ready
    for name in ("vue-direct", "py-direct", "ts-direct", "cs-direct", "java-direct"):
        (fake_home / ".claude" / "bin" / name).write_text("#!/bin/sh\nexit 0")
        (fake_home / ".claude" / "bin" / name).chmod(0o755)
    _write_availability(fake_home, {"lsps": {
        "scala":      {"tool":"scala-direct","binary":"/x","backend":"metals-mcp","workspace":"/w"},
        "python":     {"tool":"py-direct","binary":str(fake_home / ".claude" / "bin" / "py-direct"),"backend":"pyright-langserver","workspace":"/w"},
        "typescript": {"tool":"ts-direct","binary":str(fake_home / ".claude" / "bin" / "ts-direct"),"backend":"typescript-language-server","workspace":"/w"},
        "csharp":     {"tool":"cs-direct","binary":str(fake_home / ".claude" / "bin" / "cs-direct"),"backend":"csharp-ls","workspace":"/w"},
        "vue":        {"tool":"vue-direct","binary":str(fake_home / ".claude" / "bin" / "vue-direct"),"backend":"vue-language-server","workspace":"/w"},
        "java":       {"tool":"java-direct","binary":str(fake_home / ".claude" / "bin" / "java-direct"),"backend":"jdtls","workspace":"/w"},
    }})
    rc, _, err = _run(_bash(cmd), fake_home)
    assert rc == 2
    assert lang in err
    assert "BLOCKED" in err


# ---------- passthrough ----------


@pytest.mark.parametrize("cmd", [
    'grep -rn foo ~/notes --include="*.md"',
    'grep -rn foo ~/x --include="*.txt"',
    'find ~/x -name "*.json"',
    'rg --type markdown foo ~/x',
    'rg --type yaml foo ~/x',
    'cat /tmp/foo.scala',
    'ls -la',
    'echo "*.scala"',
    'git log',
])
def test_passthrough_non_code_and_non_search(fake_home, cmd):
    _write_availability(fake_home, {"lsps": {
        "scala": {"tool":"scala-direct","binary":"/x","backend":"metals-mcp","workspace":"/w"},
    }})
    rc, _, _ = _run(_bash(cmd), fake_home)
    assert rc == 0


# ---------- unscoped recursive grep ----------


@pytest.mark.parametrize("cmd", [
    'grep -rn foo ~/x',
    'grep -Rn foo api/',
    'grep -r foo api/modules/core/src/main/scala/',
    'rg pattern api/app',
])
def test_unscoped_recursive_grep_blocked(fake_home, cmd):
    _write_availability(fake_home, {})
    rc, _, err = _run(_bash(cmd), fake_home)
    assert rc == 2, f"expected BLOCK for: {cmd}\n{err}"


def test_find_literal_code_filename_blocked(fake_home):
    # -name with literal filename carrying a code extension must route the same as -name '*.scala'
    _write_availability(fake_home, {"lsps": {
        "scala": {"tool":"scala-direct","binary":"/x","backend":"metals-mcp","workspace":"/w"},
    }})
    rc, _, err = _run(_bash('find api/app -name "Foo.scala"'), fake_home)
    assert rc == 2, f"expected BLOCK\n{err}"


@pytest.mark.parametrize("cmd", [
    'grep -rn foo api/conf/',
    'grep -rn foo .claude/',
    'grep -rn foo docs/',
    'grep -rn foo web/locales/',
    'grep -rn foo fixtures/',
    'grep -rn foo api/ --include="*.sql"',
    'grep -rn foo api/ --include="*.md"',
    'rg -g "*.yaml" foo api/',
])
def test_unscoped_recursive_grep_allowed_when_scoped(fake_home, cmd):
    _write_availability(fake_home, {})
    rc, _, err = _run(_bash(cmd), fake_home)
    assert rc == 0, f"expected PASS for: {cmd}\n{err}"


# ---------- warn when LSP missing ----------


def test_scala_warn_when_metals_mcp_missing(fake_home):
    _write_availability(fake_home, {"lsps": {
        "scala": {"tool":"scala-direct","binary":"/x","backend":None,"workspace":"/w"},
    }})
    rc, _, err = _run(_bash('grep -rn foo ~/x --include="*.scala"'), fake_home)
    assert rc == 0
    assert "WARN" in err
    assert "metals-mcp" in err


def test_python_warn_when_plugin_and_binary_both_missing(fake_home):
    # empty plugins + no binary on PATH (our test PATH doesn't include pyright-langserver)
    _write_plugins(fake_home, [])
    _write_availability(fake_home, {})
    rc, _, err = _run(_bash('grep -rn foo ~/x --include="*.py"'), fake_home)
    assert rc == 0
    assert "WARN" in err
    assert "python" in err


def test_vue_warn_when_wrapper_and_binary_both_missing(fake_home):
    # no vue-direct wrapper + no vue-language-server on PATH → warn not block
    _write_availability(fake_home, {})
    rc, _, err = _run(_bash('grep -rn foo ~/x --include="*.vue"'), fake_home)
    assert rc == 0
    assert "WARN" in err
    assert "vue" in err


# ---------- fallback when avail file missing ----------


def test_fallback_uses_plugins_file(fake_home):
    # no avail file; plugin listed + binary not on PATH → warn (plugin present, binary missing)
    _write_plugins(fake_home, ["typescript-lsp@claude-plugins-official"])
    rc, _, err = _run(_bash('grep -rn foo ~/x --include="*.ts"'), fake_home)
    assert rc == 0
    assert "WARN" in err


# ---------- native Grep tool ----------


def _grep_tool(pattern: str = "foo", **kw) -> dict:
    inp = {"pattern": pattern}
    inp.update(kw)
    return {"hook_event_name": "PreToolUse", "tool_name": "Grep", "tool_input": inp}


@pytest.mark.parametrize("kw,lang", [
    ({"type": "scala"},          "scala"),
    ({"type": "py"},              "python"),
    ({"type": "python"},          "python"),
    ({"type": "ts"},              "typescript"),
    ({"type": "tsx"},             "typescript"),
    ({"type": "cs"},              "csharp"),
    ({"type": "vue"},             "vue"),
    ({"glob": "**/*.scala"},      "scala"),
    ({"glob": "*.py"},            "python"),
    ({"glob": "src/**/*.ts"},     "typescript"),
    ({"glob": "**/*.vue"},        "vue"),
    ({"path": "/tmp/Foo.scala"},  "scala"),
    ({"path": "/tmp/foo.py"},     "python"),
    ({"path": "/tmp/App.tsx"},    "typescript"),
    ({"path": "/tmp/Foo.cs"},     "csharp"),
    ({"path": "/tmp/App.vue"},    "vue"),
    ({"type": "java"},            "java"),
    ({"glob": "**/*.java"},       "java"),
    ({"path": "/tmp/Foo.java"},   "java"),
])
def test_native_grep_blocks_when_lsp_available(fake_home, kw, lang):
    for name in ("vue-direct", "py-direct", "ts-direct", "cs-direct", "java-direct"):
        (fake_home / ".claude" / "bin" / name).write_text("#!/bin/sh\nexit 0")
        (fake_home / ".claude" / "bin" / name).chmod(0o755)
    _write_availability(fake_home, {"lsps": {
        "scala":      {"tool":"scala-direct","binary":"/x","backend":"metals-mcp","workspace":"/w"},
        "python":     {"tool":"py-direct","binary":str(fake_home / ".claude" / "bin" / "py-direct"),"backend":"pyright-langserver","workspace":"/w"},
        "typescript": {"tool":"ts-direct","binary":str(fake_home / ".claude" / "bin" / "ts-direct"),"backend":"typescript-language-server","workspace":"/w"},
        "csharp":     {"tool":"cs-direct","binary":str(fake_home / ".claude" / "bin" / "cs-direct"),"backend":"csharp-ls","workspace":"/w"},
        "vue":        {"tool":"vue-direct","binary":str(fake_home / ".claude" / "bin" / "vue-direct"),"backend":"vue-language-server","workspace":"/w"},
        "java":       {"tool":"java-direct","binary":str(fake_home / ".claude" / "bin" / "java-direct"),"backend":"jdtls","workspace":"/w"},
    }})
    rc, _, err = _run(_grep_tool(**kw), fake_home)
    assert rc == 2
    assert lang in err


@pytest.mark.parametrize("kw", [
    {"type": "markdown"},
    {"type": "yaml"},
    {"glob": "*.md"},
    {"glob": "**/*.json"},
    {"path": "/tmp/foo.txt"},
    {},  # bare pattern search — no lang signal
])
def test_native_grep_passthrough(fake_home, kw):
    _write_availability(fake_home, {"lsps": {"scala": {"tool":"scala-direct","binary":"/x","backend":"metals-mcp","workspace":"/w"}}})
    rc, _, _ = _run(_grep_tool(**kw), fake_home)
    assert rc == 0


# ---------- bash positional code file ----------


@pytest.mark.parametrize("cmd,lang", [
    ('grep foo /tmp/Foo.scala',    "scala"),
    ('grep foo path/to/bar.py',    "python"),
    ('rg pattern ~/src/App.tsx',   "typescript"),
    ('grep -n class /tmp/Foo.cs',  "csharp"),
    ('grep -n ref /tmp/App.vue',   "vue"),
    ('grep -n class /tmp/Hello.java', "java"),
])
def test_bash_blocks_positional_code_file(fake_home, cmd, lang):
    for name in ("vue-direct", "py-direct", "ts-direct", "cs-direct", "java-direct"):
        (fake_home / ".claude" / "bin" / name).write_text("#!/bin/sh\nexit 0")
        (fake_home / ".claude" / "bin" / name).chmod(0o755)
    _write_availability(fake_home, {"lsps": {
        "scala":      {"tool":"scala-direct","binary":"/x","backend":"metals-mcp","workspace":"/w"},
        "python":     {"tool":"py-direct","binary":str(fake_home / ".claude" / "bin" / "py-direct"),"backend":"pyright-langserver","workspace":"/w"},
        "typescript": {"tool":"ts-direct","binary":str(fake_home / ".claude" / "bin" / "ts-direct"),"backend":"typescript-language-server","workspace":"/w"},
        "csharp":     {"tool":"cs-direct","binary":str(fake_home / ".claude" / "bin" / "cs-direct"),"backend":"csharp-ls","workspace":"/w"},
        "vue":        {"tool":"vue-direct","binary":str(fake_home / ".claude" / "bin" / "vue-direct"),"backend":"vue-language-server","workspace":"/w"},
        "java":       {"tool":"java-direct","binary":str(fake_home / ".claude" / "bin" / "java-direct"),"backend":"jdtls","workspace":"/w"},
    }})
    rc, _, err = _run(_bash(cmd), fake_home)
    assert rc == 2
    assert lang in err


def test_bash_positional_non_code_passes(fake_home):
    rc, _, _ = _run(_bash('grep foo /etc/passwd'), fake_home)
    assert rc == 0
    rc, _, _ = _run(_bash('grep foo /var/log/system.log'), fake_home)
    assert rc == 0


# ---------- non-bash non-grep ----------


def test_ignores_non_bash_tool(fake_home):
    _write_availability(fake_home, {"lsps": {
        "scala": {"tool":"scala-direct","binary":"/x","backend":"metals-mcp","workspace":"/w"},
    }})
    payload = {"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path":"/x.scala"}}
    rc, _, _ = _run(payload, fake_home)
    assert rc == 0


def test_invalid_json_exits_zero(fake_home):
    proc = subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input="not json", capture_output=True, text=True,
        env={"HOME": str(fake_home)}, timeout=5,
    )
    assert proc.returncode == 0


def test_empty_command_passes(fake_home):
    rc, _, _ = _run(_bash(""), fake_home)
    assert rc == 0


# ---------- _log_block telemetry ----------


@pytest.fixture
def hook_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("enforce_lsp_over_grep", HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def test_log_block_writes_jsonl_entry(hook_module, tmp_path, monkeypatch):
    log_path = tmp_path / "log.jsonl"
    monkeypatch.setattr(hook_module, "METRICS_LOG", log_path)
    hook_module._log_block({"session_id": "abc"}, "Bash", "grep x /a/b.ts", "positional")
    lines = log_path.read_text().splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert "ts" in entry
    assert entry["session_id"] == "abc"
    assert entry["tool_name"] == "Bash"
    assert "grep x" in entry["pattern_excerpt"]
    assert entry["reason"] == "positional"


def test_log_block_redacts_secrets(hook_module, tmp_path, monkeypatch):
    log_path = tmp_path / "log.jsonl"
    monkeypatch.setattr(hook_module, "METRICS_LOG", log_path)
    hook_module._log_block({"session_id": "s"}, "Bash", "api_key=AKIA1234", "x")
    entry = json.loads(log_path.read_text().splitlines()[0])
    assert entry["pattern_excerpt"] == "[REDACTED]"
    # 45-char alphanumeric string
    log_path.write_text("")
    hook_module._log_block({"session_id": "s"}, "Bash", "A" * 45, "x")
    entry = json.loads(log_path.read_text().splitlines()[0])
    assert entry["pattern_excerpt"] == "[REDACTED]"


def test_log_block_silent_pass_on_io_error(hook_module, monkeypatch):
    monkeypatch.setattr(hook_module, "METRICS_LOG", Path("/nonexistent-root-dir/log.jsonl"))
    # MUST NOT raise
    result = hook_module._log_block({"session_id": "s"}, "Bash", "grep x /a/b.ts", "x")
    assert result is None


def test_log_block_rotates_when_oversized(hook_module, tmp_path, monkeypatch):
    log_path = tmp_path / "lsp-grep-blocks.log"
    backup_path = tmp_path / "lsp-grep-blocks.log.1"
    # pre-fill with 260 KB of dummy content
    dummy = "x" * (260 * 1024)
    log_path.write_text(dummy)
    monkeypatch.setattr(hook_module, "METRICS_LOG", log_path)
    hook_module._log_block({"session_id": "s"}, "Bash", "grep x /a/b.ts", "rot")
    # .log now small + only has new entry
    new_contents = log_path.read_text()
    assert len(new_contents) < 1024, f"expected small fresh log, got {len(new_contents)} bytes"
    assert '"reason": "rot"' in new_contents
    # .log.1 exists, holds the previous oversized content
    assert backup_path.exists()
    assert backup_path.read_text() == dummy


def test_log_block_overwrites_old_rotation(hook_module, tmp_path, monkeypatch):
    log_path = tmp_path / "lsp-grep-blocks.log"
    backup_path = tmp_path / "lsp-grep-blocks.log.1"
    fresh = "y" * (260 * 1024)
    stale = "STALE-OLD-BACKUP"
    log_path.write_text(fresh)
    backup_path.write_text(stale)
    monkeypatch.setattr(hook_module, "METRICS_LOG", log_path)
    hook_module._log_block({"session_id": "s"}, "Bash", "grep x /a/b.ts", "rot")
    # .log.1 now holds fresh (what .log had pre-rotation); stale backup overwritten
    assert backup_path.read_text() == fresh
    assert "STALE" not in backup_path.read_text()


# ---------- backslash/single-quote escape in positional regex ----------


def test_strip_quoted_handles_backslash_escape_inside_double_quote(hook_module):
    cmd = r'''grep "it\"s a .ts" /a/b.md'''
    langs = hook_module.detect_langs(cmd)
    assert langs == set(), f"expected no lang detection, got {langs}"


def test_strip_quoted_handles_single_quote_literal(hook_module):
    cmd = '''grep 'a"b.ts' /a/b.md'''
    langs = hook_module.detect_langs(cmd)
    assert langs == set(), f"expected no lang detection, got {langs}"


def test_strip_quoted_handles_ansi_c_dollar_single(hook_module):
    # bash ANSI-C quoting: $'...' — `.ts` inside pattern, target is .md
    cmd = r"""grep $'foo.ts\n' /a/b.md"""
    langs = hook_module.detect_langs(cmd)
    assert langs == set(), f"expected no lang detection, got {langs}"


def test_strip_quoted_handles_locale_dollar_double(hook_module):
    # locale-translation quoting: $"..." — `.ts` inside pattern, target is .md
    cmd = '''grep $"x.ts" /a/b.md'''
    langs = hook_module.detect_langs(cmd)
    assert langs == set(), f"expected no lang detection, got {langs}"


# ---------- compound-command decomposition (close the head-only bypass) ----------


def _scala_ready(home: Path) -> None:
    """fake_home with scala (metals-direct), python (py-direct), vue (vue-direct) all ready."""
    for name in ("py-direct", "vue-direct"):
        (home / ".claude" / "bin" / name).write_text("#!/bin/sh\nexit 0")
        (home / ".claude" / "bin" / name).chmod(0o755)
    _write_availability(home, {"lsps": {
        "scala":  {"tool": "scala-direct", "binary": "/x", "backend": "metals-mcp", "workspace": "/w"},
        "python": {"tool": "py-direct", "binary": str(home / ".claude" / "bin" / "py-direct"),
                   "backend": "pyright-langserver", "workspace": "/w"},
        "vue":    {"tool": "vue-direct", "binary": str(home / ".claude" / "bin" / "vue-direct"),
                   "backend": "vue-language-server", "workspace": "/w"},
    }})


@pytest.mark.parametrize("cmd,needle", [
    # search tool is NOT the first token — was a silent bypass before
    ('cd api && grep -rn Foo modules/core/',                  "unscoped recursive"),
    ('MEMDIR=x; grep -rln --include="*.scala" Foo /repo/api', "scala-direct"),
    ('cat list.txt | rg MatchUpId /repo/api/scala-src',       "unscoped recursive"),
    ('find /repo/api -name "*.scala" | xargs grep -l Foo',    "scala-direct"),
    ('bash -c "grep -rn Foo /repo --include=*.scala"',        "scala-direct"),
    ('echo $(grep -rn Foo /repo --include=*.py)',             "py-direct"),
    ('( grep -rn Foo /repo/web --include=*.vue )',            "vue-direct"),
])
def test_compound_command_still_blocked(fake_home, cmd, needle):
    _scala_ready(fake_home)
    rc, _, err = _run(_bash(cmd), fake_home)
    assert rc == 2, f"expected BLOCK for compound cmd: {cmd}\n{err}"
    assert needle in err, f"expected {needle!r} in:\n{err}"


@pytest.mark.parametrize("cmd", [
    'git diff main | grep -n "def foo"',          # grepping git output, no source target
    'npm test 2>&1 | grep -i error',              # grepping command output
    'ls -la && echo done',                        # no search tool at all
    'cd conf && grep -n key messages_es.properties',  # non-source positional file
    'cat changelog.md; rg "v1.2.3" docs/',        # rg scoped to docs/
])
def test_compound_command_legit_passthrough(fake_home, cmd):
    _scala_ready(fake_home)
    rc, _, err = _run(_bash(cmd), fake_home)
    assert rc == 0, f"expected PASS for: {cmd}\n{err}"


# ---------- escalation after repeated blocks ----------


def test_escalation_banner_after_threshold(fake_home):
    # ESCALATE_THRESHOLD = 2 (2026-05-15): banner fires AT the 2nd block, not the 3rd.
    # Empirical: equinox#5943 audit showed 28 cumulative grep-on-source blocks across
    # 14 subagents because the prior threshold (3) gave too much rope.
    _scala_ready(fake_home)
    sid = "esc-session"
    rc, _, err = _run({**_bash('grep -rn Foo /repo --include="*.scala"'), "session_id": sid}, fake_home)
    assert rc == 2 and "ESCALATION" not in err, err  # 1st block: no banner
    rc, _, err = _run({**_bash('grep -rn Foo /repo --include="*.scala"'), "session_id": sid}, fake_home)
    assert rc == 2
    assert "ESCALATION" in err and "scala-direct" in err  # 2nd block: banner
    # different session is unaffected
    rc, _, err = _run({**_bash('grep -rn Foo /repo --include="*.scala"'), "session_id": "other"}, fake_home)
    assert rc == 2 and "ESCALATION" not in err, err
    counts = json.loads((fake_home / ".claude" / "locks" / "lsp-grep-block-counts.json").read_text())
    assert counts[sid]["scala"] >= 2
    assert counts["other"]["scala"] == 1


def test_unscoped_block_does_not_escalate(fake_home):
    # unscoped recursive grep has no resolved lang → no counter bump, no banner
    _write_availability(fake_home, {})
    for _ in range(5):
        rc, _, err = _run({**_bash('grep -rn Foo api/'), "session_id": "u"}, fake_home)
        assert rc == 2 and "ESCALATION" not in err, err
    assert not (fake_home / ".claude" / "locks" / "lsp-grep-block-counts.json").exists()


# ---------- scan_bash_command / escalation helpers (direct) ----------


@pytest.mark.parametrize("cmd,expected", [
    ('cd api && grep -rn Foo modules/',                  (True, set())),
    ('VAR=x; grep -rln --include=*.scala Foo /a/b',      (False, {"scala"})),
    ('find /x -name "*.scala" | xargs grep -l Foo',      (False, {"scala"})),
    ('bash -c "grep -rn Foo /a --include=*.py"',         (False, {"python"})),
    ('echo $(grep -rn Foo /a --include=*.vue)',          (False, {"vue"})),
    ('git diff | grep -n def',                           (False, set())),
    ('ls -la && echo hi',                                (False, set())),
    ('grep -rn Foo /a/b.ts',                             (False, {"typescript"})),
])
def test_scan_bash_command(hook_module, cmd, expected):
    assert hook_module.scan_bash_command(cmd) == expected


def test_bump_block_count_and_banner(hook_module, tmp_path, monkeypatch):
    counts_file = tmp_path / "block-counts.json"
    monkeypatch.setattr(hook_module, "BLOCK_COUNTS_FILE", counts_file)
    assert hook_module._bump_block_count("", ["scala"]) == {}          # no session → no-op
    assert hook_module._bump_block_count("s", []) == {}                # no langs → no-op
    assert hook_module._bump_block_count("s", ["scala"]) == {"scala": 1}
    assert hook_module._bump_block_count("s", ["scala"]) == {"scala": 2}
    assert hook_module._bump_block_count("s", ["scala"]) == {"scala": 3}
    # ESCALATE_THRESHOLD = 2 (2026-05-15): banner fires AT count 2, not 3.
    assert hook_module._escalation_banner({"scala": 1}) == ""          # below threshold
    banner = hook_module._escalation_banner({"scala": 2, "python": 1})
    assert "ESCALATION" in banner and "scala-direct" in banner
    assert "py-direct" not in banner                                   # python under threshold
    assert json.loads(counts_file.read_text())["s"]["scala"] == 3


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
