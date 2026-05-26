#!/usr/bin/env python3
"""pretooluse:bash + pretooluse:grep — block text search on code extensions when a working LSP is available.

philosophy: LSP for all. grep/rg/find on source code is lossy text search; use semantic LSP tools instead.
covers claude native `Grep` tool (type/glob/path fields) and Bash shell invocations (grep/rg/find/fd/ack/ag).
reads ~/.claude/locks/lsp-availability.json written by prewarm-lsp-on-cwd.py.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Optional

HOME = Path(os.environ.get("HOME", str(Path.home())))
AVAIL_FILE = HOME / ".claude" / "locks" / "lsp-availability.json"
PLUGINS_FILE = HOME / ".claude" / "plugins" / "installed_plugins.json"
METRICS_LOG = HOME / ".claude" / ".metrics" / "lsp-grep-blocks.log"


def _log_block(payload: dict, tool_name: str, pattern_excerpt: str, reason: str) -> None:
    """append single jsonl entry to metrics log; silent-pass on any failure.
    disk-only — never emits to stdout/stderr/additionalContext (zero-token invariant)."""
    try:
        from datetime import datetime, timezone
        # rotate when oversized: rename to .log.1 (overwriting any prior backup), start fresh
        try:
            if METRICS_LOG.exists() and METRICS_LOG.stat().st_size > 256 * 1024:
                os.replace(str(METRICS_LOG), str(METRICS_LOG) + ".1")
        except Exception:
            pass
        excerpt = (pattern_excerpt or "")[:80]
        # redact secret-looking content (long hex/base64 or key= tokens)
        if re.search(r"(?i)(api[_-]?key|secret|token|password|bearer)\s*[:=]", excerpt) or re.search(r"[A-Za-z0-9+/=]{40,}", excerpt):
            excerpt = "[REDACTED]"
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "session_id": payload.get("session_id", ""),
            "tool_name": tool_name,
            "pattern_excerpt": excerpt,
            "reason": reason,
        }
        METRICS_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(METRICS_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass

# plugin + binary fallback when avail file lacks an entry (prewarm hasn't run for this cwd yet)
PLUGIN_BINARY_MAP = {
    "python":     ("pyright-lsp@claude-plugins-official",    "pyright-langserver"),
    "typescript": ("typescript-lsp@claude-plugins-official", "typescript-language-server"),
    "csharp":     ("csharp-lsp@claude-plugins-official",     "csharp-ls"),
    "java":       ("jdtls-lsp@claude-plugins-official",      "jdtls"),
}


def load_plugins() -> set:
    try:
        return set(json.loads(PLUGINS_FILE.read_text()).get("plugins", {}).keys())
    except Exception:
        return set()


def scala_info_fallback() -> dict:
    metals_direct = HOME / ".claude" / "bin" / "metals-direct"
    return {
        "tool": "metals-direct",
        "binary": str(metals_direct) if metals_direct.exists() else None,
        "backend": "metals-mcp" if shutil.which("metals-mcp") else None,
        "workspace": "",
    }


def vue_info_fallback() -> dict:
    vue_direct = HOME / ".claude" / "bin" / "vue-direct"
    return {
        "tool": "vue-direct",
        "binary": str(vue_direct) if vue_direct.exists() else None,
        "backend": "vue-language-server" if shutil.which("vue-language-server") else None,
        "workspace": "",
    }


# direct wrapper names per language (primary path after migration)
LANG_DIRECT_WRAPPER = {
    "python":     ("py-direct", "pyright-langserver"),
    "typescript": ("ts-direct", "typescript-language-server"),
    "csharp":     ("cs-direct", "csharp-ls"),
    "java":       ("java-direct", "jdtls"),
}


def direct_info_fallback(lang: str) -> dict:
    wrapper_name, backend_bin = LANG_DIRECT_WRAPPER[lang]
    wrapper_path = HOME / ".claude" / "bin" / wrapper_name
    return {
        "tool": wrapper_name,
        "binary": str(wrapper_path) if wrapper_path.exists() else None,
        "backend": backend_bin if shutil.which(backend_bin) else None,
        "workspace": "",
    }


def lang_info_fallback(lang: str) -> Optional[dict]:
    if lang == "scala":
        return scala_info_fallback()
    if lang == "vue":
        return vue_info_fallback()
    if lang in LANG_DIRECT_WRAPPER:
        direct = direct_info_fallback(lang)
        # if direct wrapper + backend both present → preferred primary path
        if direct.get("binary") and direct.get("backend"):
            return direct
        # else fall through to native LSP plugin check
    if lang in PLUGIN_BINARY_MAP:
        plugin_id, binary = PLUGIN_BINARY_MAP[lang]
        plugins = load_plugins()
        return {
            "tool": "claude-lsp",
            "plugin_installed": plugin_id in plugins,
            "binary_on_path": shutil.which(binary) is not None,
            "binary_name": binary,
            "workspace": "",
        }
    return None

# ext set to guard — only code extensions where semantic search matters
CODE_EXT = {
    ".scala", ".sbt", ".sc",
    ".py",
    ".ts", ".tsx", ".js", ".jsx",
    ".cs",
    ".vue",
    ".java",
}
EXT_LANG = {
    ".scala": "scala", ".sbt": "scala", ".sc": "scala",
    ".py": "python",
    ".ts": "typescript", ".tsx": "typescript", ".js": "typescript", ".jsx": "typescript",
    ".cs": "csharp",
    ".vue": "vue",
    ".java": "java",
}

# rg --type maps to extensions
RG_TYPE_LANG = {
    "scala": "scala", "py": "python", "python": "python",
    "ts": "typescript", "tsx": "typescript", "js": "typescript", "jsx": "typescript",
    "cs": "csharp", "csharp": "csharp",
    "vue": "vue",
    "java": "java",
}

# patterns detected in shell command strings
INCLUDE_RE = re.compile(r"""--include[=\s]['"]*\*(\.\w+)['"]*""")
GLOB_STAR_RE = re.compile(r"""['"]?\*(\.\w{1,5})['"]?""")
FIND_NAME_RE = re.compile(r"""-(?:i?name|regex)\s+['"]*[^'"]*\*?(\.\w+)['"]*""")
RG_TYPE_RE = re.compile(r"""--type[=\s](\w+)""")
RG_GLOB_RE = re.compile(r"""-g[=\s]['"]*\*(\.\w+)['"]*""")
# positional code-file argument to grep/rg: "grep pattern path/to/file.scala"
# trailing boundary includes pipe/redirect/semicolon/ampersand to catch
# `grep "x" /a/b.ts | head` and `grep "x" /a/b.ts > out` and `grep "x" /a/b.ts;echo`
POS_CODE_FILE_RE = re.compile(r"""(?:^|\s)['"]?[^\s'"|&;<>]*(\.(?:scala|sbt|sc|py|ts|tsx|js|jsx|cs|vue|java))['"]?(?:\s|$|[|>;&])""")
_QUOTED_RE = re.compile(r"""(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$'(?:\\.|[^'\\])*'|\$"(?:\\.|[^"\\])*")""")


def _strip_quoted(cmd: str) -> str:
    """remove shell-quoted substrings before POS_CODE_FILE_RE match — avoids FP on `grep "foo.ts" /a/b.md` where `.ts` is inside the search pattern, not a target filename"""
    return _QUOTED_RE.sub(" ", cmd)


def lsp_suggestion(lang: str, avail: dict) -> Optional[str]:
    """return enforcement message if LSP is ready; None if no enforcement applies.
    2026-05-26 W1 compression: emission compressed ~75% — method surface enumerated via
    `<wrapper> tools`; agent knows JSON shapes via rules/lsp.md auto-load."""
    info = avail.get("lsps", {}).get(lang) or lang_info_fallback(lang)
    if not info:
        return None
    if lang == "scala":
        if info.get("binary") and info.get("backend"):
            return (
                "use metals-direct on *.scala/*.sbt/*.sc; methods: glob-search | get-usages | "
                "tools (~/.claude/bin/metals-direct tools for surface). grep valid for config/data only."
            )
        missing = []
        if not info.get("binary"):
            missing.append("~/.claude/bin/metals-direct wrapper")
        if not info.get("backend"):
            missing.append("metals-mcp binary")
        return f"[WARN not block] scala stack detected but missing: {', '.join(missing)}. grep allowed until installed."
    if lang == "vue":
        if info.get("binary") and info.get("backend"):
            return (
                "use vue-direct on *.vue; methods: documentSymbol | hover | references "
                "(~/.claude/bin/vue-direct tools for surface). grep valid for html templates + config only."
            )
        missing = []
        if not info.get("binary"):
            missing.append("~/.claude/bin/vue-direct wrapper")
        if not info.get("backend"):
            missing.append("vue-language-server on PATH")
        return f"[WARN not block] vue stack detected but missing: {', '.join(missing)}. grep allowed until installed."
    if lang in {"python", "typescript", "csharp", "java"}:
        wrapper_name, backend_bin = LANG_DIRECT_WRAPPER[lang]
        if info.get("tool") == wrapper_name and info.get("binary") and info.get("backend"):
            return (
                f"use {wrapper_name} on source; methods: documentSymbol | references | "
                f"workspace/symbol (~/.claude/bin/{wrapper_name} tools for surface). "
                f"grep valid for non-source only."
            )
        if info.get("plugin_installed") and info.get("binary_on_path"):
            return (
                f"use LSP tool for {lang} (direct wrapper absent): workspaceSymbol | "
                f"findReferences | goToDefinition. prefer {wrapper_name} when available "
                f"(~100× faster). grep valid for non-source only."
            )
        missing = []
        if not info.get("plugin_installed") and info.get("tool") != wrapper_name:
            missing.append(f"{wrapper_name} wrapper or {lang}-lsp plugin")
        elif not info.get("plugin_installed"):
            missing.append(f"plugin ({lang}-lsp not in installed_plugins.json)")
        if not info.get("binary_on_path") and not info.get("backend"):
            missing.append(f"binary ({backend_bin})")
        return f"[WARN not block] {lang} stack detected but missing: {', '.join(missing)}. grep allowed until installed."
    return None


def detect_langs(cmd: str) -> set:
    """parse shell command, return set of languages the command targets by extension"""
    langs = set()
    # grep --include + find -name patterns
    for pat in (INCLUDE_RE, FIND_NAME_RE):
        for m in pat.finditer(cmd):
            ext = m.group(1).lower()
            if ext in EXT_LANG:
                langs.add(EXT_LANG[ext])
    # rg --type
    for m in RG_TYPE_RE.finditer(cmd):
        t = m.group(1).lower()
        if t in RG_TYPE_LANG:
            langs.add(RG_TYPE_LANG[t])
    # rg -g glob
    for m in RG_GLOB_RE.finditer(cmd):
        ext = m.group(1).lower()
        if ext in EXT_LANG:
            langs.add(EXT_LANG[ext])
    # bare glob *.scala / *.py as last arg to grep/rg/find
    # only if command starts with grep/rg/find or their variants
    tool_head = cmd.strip().split()[0] if cmd.strip() else ""
    if tool_head in {"grep", "rg", "find", "fd"}:
        for m in GLOB_STAR_RE.finditer(cmd):
            ext = m.group(1).lower()
            if ext in EXT_LANG:
                langs.add(EXT_LANG[ext])
    # positional code-file argument (e.g. `grep foo path/to/file.scala`)
    if tool_head in {"grep", "egrep", "fgrep", "rg", "ack", "ag"}:
        for m in POS_CODE_FILE_RE.finditer(_strip_quoted(cmd)):
            ext = m.group(1).lower()
            if ext in EXT_LANG:
                langs.add(EXT_LANG[ext])
    return langs


def detect_langs_native_grep(inp: dict) -> set:
    """Claude native Grep tool — check type, glob, path fields"""
    langs = set()
    t = (inp.get("type") or "").strip().lower()
    if t in RG_TYPE_LANG:
        langs.add(RG_TYPE_LANG[t])
    glob = inp.get("glob") or ""
    # any glob ending in a code extension (*.scala, **/*.py, etc.)
    m = re.search(r"\.(\w+)\s*$", glob)
    if m:
        ext = "." + m.group(1).lower()
        if ext in EXT_LANG:
            langs.add(EXT_LANG[ext])
    path = inp.get("path") or ""
    # path pointing at a specific code file
    for ext_code in EXT_LANG:
        if path.lower().endswith(ext_code):
            langs.add(EXT_LANG[ext_code])
            break
    return langs


def is_search_tool(cmd: str) -> bool:
    head = cmd.strip().split()[0] if cmd.strip() else ""
    return head in {"grep", "egrep", "fgrep", "rg", "find", "fd", "ack", "ag"}


# recursive grep/rg without any file-type scope is an ambiguous-intent bypass of enforce-lsp-over-grep:
# hook cannot tell if target tree contains source code. force explicit scope declaration.
SCOPE_FLAGS_RE = re.compile(r"(--include|--exclude|--type[=\s]|-\s*t\s|-\s*g\s|--glob)")
# path args pointing at a single file (not a directory recursion) → skip
POS_FILE_ARG_RE = re.compile(r"""\s['"]?[^\s'"|&;<>]*\.(\w{1,6})['"]?(?:\s|$)""")
# safe-list non-code top-level dirs: if recursion is scoped to conf/, docs/, .github/ etc. → allow
NON_CODE_DIR_HINT_RE = re.compile(
    r"""\s['"]?(?:[\w.-]+/)*(?:conf|docs?|\.github|\.claude|i18n|locales?|messages?|migrations?|sql|fixtures?|data|public|static|assets)/[^\s'"|&;<>]*['"]?"""
)


def is_unscoped_recursive_grep(cmd: str) -> bool:
    """true when grep -r/-R or rg is called without --include/--type/-g and not piped a file list"""
    stripped = cmd.strip()
    head = stripped.split()[0] if stripped else ""
    if head in {"grep", "egrep", "fgrep"}:
        # require -r or -R flag for recursion
        if not re.search(r"(?:^|\s)-[A-Za-z]*[rR](?:\s|$|[A-Za-z])", stripped):
            return False
    elif head == "rg":
        pass  # rg defaults to recursive
    else:
        return False
    # explicit scope flag present → not unscoped
    if SCOPE_FLAGS_RE.search(stripped):
        return False
    # POS_FILE_ARG_RE: grep/rg given specific files (.md, .sql, .json, etc.) → not a recursive scan
    if POS_FILE_ARG_RE.search(stripped):
        return False
    # recursion explicitly scoped to a known non-code subtree → allow
    if NON_CODE_DIR_HINT_RE.search(stripped):
        return False
    return True


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    tool_name = payload.get("tool_name", "")
    inp = payload.get("tool_input", {}) or {}
    langs: set = set()
    source = ""
    if tool_name == "Bash":
        cmd = inp.get("command", "")
        if not cmd or not is_search_tool(cmd):
            sys.exit(0)
        if is_unscoped_recursive_grep(cmd):
            sys.stderr.write(
                "BLOCKED by enforce-lsp-over-grep: unscoped recursive grep/rg\n"
                f"Bash: {cmd[:200]}{'...' if len(cmd) > 200 else ''}\n"
                "resolve by declaring intent:\n"
                "  - source code → <lang>-direct wrapper (metals/vue/py/ts/cs/java)\n"
                "  - non-source files → add --include='*.<ext>' OR rg -g '*.<ext>'\n"
                "  - non-code subtree → recurse inside conf/ docs/ .claude/ i18n/ explicitly\n"
            )
            _log_block(payload, tool_name, cmd, "unscoped_recursive_grep_bash")
            sys.exit(2)
        langs = detect_langs(cmd)
        source = "Bash: " + cmd[:200] + ("..." if len(cmd) > 200 else "")
    elif tool_name == "Grep":
        langs = detect_langs_native_grep(inp)
        source = f"Grep(pattern={inp.get('pattern','')[:40]}, type={inp.get('type')}, glob={inp.get('glob')}, path={inp.get('path')})"
    else:
        sys.exit(0)
    if not langs:
        sys.exit(0)
    try:
        avail = json.loads(AVAIL_FILE.read_text())
    except Exception:
        avail = {}
    msgs = []
    block = False
    for lang in sorted(langs):
        sug = lsp_suggestion(lang, avail)
        if sug is None:
            continue
        msgs.append(f"--- {lang} ---\n{sug}")
        if not sug.startswith("[WARN not block]"):
            block = True
    if not msgs:
        sys.exit(0)
    header = (
        f"BLOCKED by enforce-lsp-over-grep: use semantic LSP tools on source code\n{source}\n\n"
    ) if block else (
        f"WARN from enforce-lsp-over-grep: LSP setup incomplete\n{source}\n\n"
    )
    sys.stderr.write(header + "\n\n".join(msgs) + "\n")
    if block:
        _log_block(payload, tool_name, source, f"lsp_available_langs:{','.join(sorted(langs))}")
    sys.exit(2 if block else 0)


def _selftest() -> int:
    """inline regex self-test for POS_CODE_FILE_RE pipe/redirect boundary fix.
    run: `python3 enforce-lsp-over-grep.py --selftest`"""
    cases = [
        ('grep "x" /a/b.ts',                    True),   # plain positional code file
        ('grep "x" /a/b.ts | head -20',         True),   # pipe boundary
        ('grep "x" /a/b.ts > out',              True),   # redirect boundary
        ('grep "x" /a/b.md',                    False),  # non-source extension
        ('grep "foo.ts" /a/b.md',               False),  # code ext INSIDE quoted pattern, target is .md
        ('grep "pattern.ts;literal" file.md',   False),  # ext + separator inside quoted pattern
        ('grep "x" /a/b.ts;echo done',          True),   # real .ts file then ;echo separator
        ("grep 'foo.py' /a/b.md",               False),  # single-quoted pattern variant
    ]
    failed = 0
    for cmd, expected_block in cases:
        matched = bool(POS_CODE_FILE_RE.search(_strip_quoted(cmd)))
        ok = matched == expected_block
        print(f"{'OK' if ok else 'FAIL'}: {cmd!r} matched={matched} expected={expected_block}")
        if not ok:
            failed += 1
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        sys.exit(_selftest())
    main()
