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
# escalation: repeated grep-on-source blocks for the same lang within a session →
# louder, tool-specific directive. counter reset by redeem-lsp-debt.py on <lang>-direct use.
# threshold = 2 (was 3 pre-2026-05-15): empirical observation on equinox#5943 — agents
# kept retrying grep through 28 cumulative blocks across 14 subagents (avg 2/each). After
# the 2nd block the model has had enough signal; the 3rd is wasted budget. Lower threshold
# triggers the "STATUS: PASS_PARTIAL" exit directive from ac-implementer.md § LSP-block
# recovery discipline sooner — short-circuits the same-shape retry waste.
BLOCK_COUNTS_FILE = HOME / ".claude" / "locks" / "lsp-grep-block-counts.json"
ESCALATE_THRESHOLD = 2
DIRECT_WRAPPER_NAME = {
    "scala": "scala-direct", "vue": "vue-direct", "python": "py-direct",
    "typescript": "ts-direct", "csharp": "cs-direct", "java": "java-direct",
}


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
    scala_direct = HOME / ".claude" / "bin" / "scala-direct"
    return {
        "tool": "scala-direct",
        "binary": str(scala_direct) if scala_direct.exists() else None,
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
# same as POS_CODE_FILE_RE but captures the FULL path so exempt-path filtering can inspect directory components
POS_CODE_FILE_PATH_RE = re.compile(r"""(?:^|\s)['"]?([^\s'"|&;<>]*\.(?:scala|sbt|sc|py|ts|tsx|js|jsx|cs|vue|java))['"]?(?:\s|$|[|>;&])""")
_QUOTED_RE = re.compile(r"""(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$'(?:\\.|[^'\\])*'|\$"(?:\\.|[^"\\])*")""")

# text-processing tools used as grep-equivalents on source — awk '/pat/' file.scala, sed -n '/pat/p' file.scala,
# perl -ne '/pat/' file.scala. all are scan-with-pattern shapes that bypass LSP → same enforcement as grep
TEXT_TOOL_HEADS = {"awk", "gawk", "mawk", "sed", "perl"}
# interpreter-with-inline-script heads — python -c '<script>' file.scala, perl -e '<script>' file.scala,
# ruby -e '<script>' file.rb. only block when -c/-e flag present AND positional source-file arg follows;
# bare `python script.py` is fine (running code, not scanning it)
INLINE_SCRIPT_HEADS = {"python", "python3", "perl", "ruby"}
INLINE_SCRIPT_FLAG_RE = re.compile(r"(?:^|\s)-[ce](?:\s|$|[A-Za-z])")

# find with one of these flags is metadata-filter intent (no content access) — no LSP equivalent
# for "files newer than N days" / "files larger than N bytes" / "empty files" etc.
# -name/-type/-maxdepth alone are NOT enough; require explicit time/size/perm/owner discriminator.
_FIND_METADATA_FLAGS_RE = re.compile(
    r"-(?:mtime|atime|ctime|mmin|amin|cmin|size|newer|empty|perm|user|group|uid|gid)\b"
)
# ANY -exec / -execdir flag invalidates the metadata-only exemption.
# direct form (-exec grep ...) is obvious content-scan; shell-wrapper forms
# (-exec sh -c 'grep ...' \;, -exec bash -c 'awk ...' \;) and arbitrary-binary
# forms (-exec /custom/scanner {} \;) smuggle content access through indirection.
# treating every -exec/-execdir as content-scan intent is safer than enumerating
# every wrapper shape (per codex 2026-05-25 audit on slice-c).
_FIND_EXEC_ANY_RE = re.compile(r"-exec(?:dir)?\b")

# exempt-path hints: source-extension files under these dirs are TEST FIXTURE / SNAPSHOT data;
# legitimate to text-scan because the content is non-semantic (golden output, captured payloads).
# matches when any path segment equals one of these names
EXEMPT_PATH_RE = re.compile(
    r"""(?:^|/)(?:fixtures?|__snapshots__|testdata|goldens?|test/resources|test/fixtures?|spec/fixtures?|tests?/data)/"""
)


def _strip_quoted(cmd: str) -> str:
    """remove shell-quoted substrings before POS_CODE_FILE_RE match — avoids FP on `grep "foo.ts" /a/b.md` where `.ts` is inside the search pattern, not a target filename"""
    return _QUOTED_RE.sub(" ", cmd)


def lsp_suggestion(lang: str, avail: dict) -> Optional[str]:
    """return enforcement message if LSP is ready; None if no enforcement applies"""
    info = avail.get("lsps", {}).get(lang) or lang_info_fallback(lang)
    if not info:
        return None
    if lang == "scala":
        if info.get("binary") and info.get("backend"):
            return (
                f"use scala-direct instead of grep on *.scala/*.sbt/*.sc:\n"
                f"  ~/.claude/bin/scala-direct call glob-search '{{\"query\":\"<symbol>\",\"fileInFocus\":\"<abs-path>\"}}' {info.get('workspace','')}\n"
                f"  ~/.claude/bin/scala-direct call get-usages '{{\"fqcn\":\"<fqcn>\",\"module\":\"<mod>\"}}' {info.get('workspace','')}\n"
                f"  ~/.claude/bin/scala-direct tools   # list all metals-mcp operations\n"
                f"grep remains valid for config/data files — NOT source code. state explicitly why scala-direct could not answer before falling back."
            )
        # scala workspace but scala-direct/metals-mcp missing → warn not block
        missing = []
        if not info.get("binary"):
            missing.append("~/.claude/bin/scala-direct wrapper")
        if not info.get("backend"):
            missing.append("metals-mcp binary (brew install metals or cs install metals-mcp)")
        return f"[WARN not block] scala stack detected but missing: {', '.join(missing)}. grep allowed until installed."
    if lang == "vue":
        if info.get("binary") and info.get("backend"):
            return (
                f"use vue-direct instead of grep on *.vue:\n"
                f"  ~/.claude/bin/vue-direct call textDocument/documentSymbol '{{\"textDocument\":{{\"uri\":\"file://<abs-path>\"}}}}' {info.get('workspace','')}\n"
                f"  ~/.claude/bin/vue-direct call textDocument/hover '{{\"textDocument\":{{\"uri\":\"file://<abs-path>\"}},\"position\":{{\"line\":N,\"character\":N}}}}' {info.get('workspace','')}\n"
                f"  ~/.claude/bin/vue-direct batch <method> /abs/A.vue /abs/B.vue /abs/C.vue   # MUST use batch when querying >=2 files with same method\n"
                f"  ~/.claude/bin/vue-direct batch-json '<json-array of {{method,params}}>'   # multi-method fan-out\n"
                f"  ~/.claude/bin/vue-direct tools   # list LSP method surface\n"
                f"grep remains valid for non-source files (template html, config). state explicitly why vue-direct could not answer before falling back."
            )
        missing = []
        if not info.get("binary"):
            missing.append("~/.claude/bin/vue-direct wrapper")
        if not info.get("backend"):
            missing.append("vue-language-server on PATH ('npm i -g @vue/language-server@3.2.6 @vue/typescript-plugin@3.2.6 typescript@5.9.3')")
        return f"[WARN not block] vue stack detected but missing: {', '.join(missing)}. grep allowed until installed."
    if lang in {"python", "typescript", "csharp", "java"}:
        # primary path after migration: direct wrapper (py-direct/ts-direct/cs-direct)
        wrapper_name, backend_bin = LANG_DIRECT_WRAPPER[lang]
        if info.get("tool") == wrapper_name and info.get("binary") and info.get("backend"):
            return (
                f"use {wrapper_name} instead of grep on source files:\n"
                f"  ~/.claude/bin/{wrapper_name} call textDocument/documentSymbol '{{\"textDocument\":{{\"uri\":\"file://<abs-path>\"}}}}'\n"
                f"  ~/.claude/bin/{wrapper_name} call textDocument/references '{{\"textDocument\":{{\"uri\":\"file://<abs-path>\"}},\"position\":{{\"line\":N,\"character\":N}},\"context\":{{\"includeDeclaration\":true}}}}'\n"
                f"  ~/.claude/bin/{wrapper_name} call workspace/symbol '{{\"query\":\"<name>\"}}'\n"
                f"  ~/.claude/bin/{wrapper_name} batch <method> /abs/A /abs/B /abs/C   # MUST use batch when querying >=2 files with same method\n"
                f"  ~/.claude/bin/{wrapper_name} batch-json '<json-array of {{method,params}}>'   # multi-method fan-out\n"
                f"  ~/.claude/bin/{wrapper_name} tools   # list LSP method surface\n"
                f"grep remains valid for non-source files (config, markdown, data)."
            )
        # fallback: native LSP plugin active
        if info.get("plugin_installed") and info.get("binary_on_path"):
            return (
                f"use the LSP tool for {lang} instead of grep (direct wrapper absent):\n"
                f"  LSP(operation=\"workspaceSymbol\", ...)\n"
                f"  LSP(operation=\"findReferences\", filePath=<path>, line=N, character=N)\n"
                f"  LSP(operation=\"goToDefinition\", filePath=<path>, line=N, character=N)\n"
                f"prefer ~/.claude/bin/{wrapper_name} when available (~100× faster per rules/lsp.md § lsp-workarounds).\n"
                f"grep remains valid for non-source files."
            )
        # neither direct wrapper nor plugin available → warn not block
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
    # text-processing tools (awk/sed/perl) used as grep-equivalents on source files
    # same enforcement: positional source-file arg with code extension → bypass shape
    if tool_head in TEXT_TOOL_HEADS:
        for m in POS_CODE_FILE_RE.finditer(_strip_quoted(cmd)):
            ext = m.group(1).lower()
            if ext in EXT_LANG:
                langs.add(EXT_LANG[ext])
    # interpreters with inline-script flag (-c/-e) + positional source-file arg
    # `python -c '<script>' file.scala`, `perl -e '<script>' file.scala`, `ruby -e '<script>' file.rb`
    # bare `python script.py` is NOT this shape — must have -c/-e
    if tool_head in INLINE_SCRIPT_HEADS and INLINE_SCRIPT_FLAG_RE.search(cmd):
        for m in POS_CODE_FILE_RE.finditer(_strip_quoted(cmd)):
            ext = m.group(1).lower()
            if ext in EXT_LANG:
                langs.add(EXT_LANG[ext])
    return langs


def _all_source_paths_exempt(cmd: str) -> bool:
    """true when EVERY source-extension positional path in cmd is under an exempt dir
    (fixtures/, __snapshots__/, testdata/, etc.). returns False if no source paths matched —
    caller decides whether absence-of-positional-arg means block or not (depends on tool shape).
    """
    paths = [m.group(1) for m in POS_CODE_FILE_PATH_RE.finditer(_strip_quoted(cmd))]
    if not paths:
        return False
    return all(EXEMPT_PATH_RE.search(p) is not None for p in paths)


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


SEARCH_TOOL_HEADS = {"grep", "egrep", "fgrep", "rg", "find", "fd", "ack", "ag"}
# extended set: heads where source-extension positional args still trigger the LSP-over-grep block.
# text-tools always do; inline-script interpreters only when -c/-e flag present (gated in is_search_tool)
_TEXT_AND_SCRIPT_HEADS = TEXT_TOOL_HEADS | INLINE_SCRIPT_HEADS


def is_search_tool(cmd: str) -> bool:
    """true when cmd head is a search tool OR a text-processing tool OR an inline-script
    interpreter (the latter only when -c/-e flag present — bare `python script.py` is NOT
    a text-scan shape).
    """
    head = cmd.strip().split()[0] if cmd.strip() else ""
    if head in SEARCH_TOOL_HEADS:
        return True
    if head in TEXT_TOOL_HEADS:
        return True
    if head in INLINE_SCRIPT_HEADS and INLINE_SCRIPT_FLAG_RE.search(cmd):
        return True
    return False


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


# --- compound-command decomposition --------------------------------------------------
# the head-only checks (is_search_tool / is_unscoped_recursive_grep) inspect cmd.split()[0]
# only — so `cd x && grep ...`, `VAR=y; grep ...`, `cat f | rg ...`, `bash -c 'grep ...'`,
# `( grep ... )`, `echo $(grep ...)`, `find ... | xargs grep ...` slipped past. decompose
# every Bash command into top-level segments + unwrap one level of `bash -c '<payload>'` and
# strip a leading `xargs [flags ...]`, then run the per-segment checks on each piece.
_BASH_C_RE = re.compile(
    r"""(?:^|[\s;&|(`])(?:bash|sh|zsh|dash)\s+-[A-Za-z]*c[A-Za-z]*\s+('(?:[^'])*'|"(?:\\.|[^"\\])*")"""
)
# xargs flags that consume the following token (so the command head is not mistaken for the value)
_XARGS_VALUE_FLAGS = {
    "-I", "-i", "-n", "-L", "-l", "-P", "-s", "-E", "-d", "-a",
    "--max-args", "--max-lines", "--max-procs", "--max-chars",
    "--replace", "--delimiter", "--arg-file", "--eof",
}
# top-level command separators: ; newline | || & && ( ) ` { } — split when NOT inside quotes
_SEP_CHARS = set(";\n|&()`{}")


def _split_top_level(cmd: str) -> list:
    """split a shell command line into command segments on unquoted separators.
    best-effort lexer — not a full shell parser; on unbalanced quotes, returns [cmd] whole
    (deny-gate floor: never less detection than the original head-only check)."""
    segs, buf, i, n, quote = [], [], 0, len(cmd), None
    while i < n:
        c = cmd[i]
        if quote is not None:
            buf.append(c)
            if c == "\\" and quote == '"' and i + 1 < n:
                buf.append(cmd[i + 1]); i += 2; continue
            if c == quote:
                quote = None
            i += 1; continue
        if c in ("'", '"'):
            quote = c; buf.append(c); i += 1; continue
        if c == "\\" and i + 1 < n:
            buf.append(c); buf.append(cmd[i + 1]); i += 2; continue
        if c in _SEP_CHARS:
            segs.append("".join(buf)); buf = []
            # collapse the two-char operators (&& || ) into a single boundary
            if c in ("&", "|") and i + 1 < n and cmd[i + 1] == c:
                i += 2
            else:
                i += 1
            continue
        buf.append(c); i += 1
    if quote is not None:
        return [cmd]
    segs.append("".join(buf))
    return segs


def _strip_xargs_prefix(seg: str) -> str:
    """strip a leading `xargs [flags ...]` so the wrapped command head is exposed."""
    toks = seg.split()
    if not toks or toks[0] != "xargs":
        return seg
    j = 1
    while j < len(toks):
        t = toks[j]
        if not t.startswith("-"):
            break
        bare = t.split("=", 1)[0]
        j += 1
        # `-n 1` / `-I {}` style: skip the following token too (unless it's another flag)
        if bare in _XARGS_VALUE_FLAGS and len(t) == len(bare) and j < len(toks) and not toks[j].startswith("-"):
            j += 1
    return " ".join(toks[j:])


def _shell_segments(cmd: str) -> list:
    """top-level segments of cmd, plus payloads of `bash -c '...'`, with xargs prefixes stripped.

    Special-case: `find ... -exec sh -c '...' \\;` — the bash/sh -c here is internal to find
    (lets find pass each match to a shell script), NOT a top-level indirection wrapper.
    Preserve the find segment intact so detect_langs sees the -name pattern + flags; otherwise
    the shell-wrapper bypass evades enforcement (per codex 2026-05-25 audit gap)."""
    out = []
    for top in _split_top_level(cmd):
        s = top.strip()
        if not s:
            continue
        head = s.split()[0] if s.split() else ""
        if head == "find":
            # keep find whole — its -exec sh -c '...' is find-internal, not top-level
            out.append(_strip_xargs_prefix(s))
            continue
        m = _BASH_C_RE.search(s)
        if m:
            inner = m.group(1)[1:-1]  # drop the surrounding quotes
            out.extend(_shell_segments(inner))
            continue
        out.append(_strip_xargs_prefix(s))
    return out


def _seg_head(s: str) -> str:
    """tool head of a single segment, '' if empty."""
    parts = s.strip().split()
    return parts[0] if parts else ""


def _is_metadata_only_find_segment(seg: str) -> bool:
    """True when find segment uses metadata-filter flag(s) AND has NO -exec/-execdir at all.
    Pure filesystem listing (find . -name '*.py' -mtime +60) has no LSP equivalent — exempt.
    ANY -exec/-execdir (including shell-wrapper indirection `-exec sh -c '...grep...' \\;`
    and arbitrary-binary forms `-exec /custom/scanner {} \\;`) smuggles content-scan intent
    and forfeits the metadata-only exemption — per codex 2026-05-25 audit gap on indirection."""
    if _seg_head(seg) != "find":
        return False
    if not _FIND_METADATA_FLAGS_RE.search(seg):
        return False
    if _FIND_EXEC_ANY_RE.search(seg):
        return False
    return True


def scan_bash_command(cmd: str) -> tuple:
    """analyze a (possibly compound) Bash command; returns (unscoped_recursive, langs).
    unscoped_recursive: any segment is an unscoped recursive grep/rg.
    langs: set of code languages targeted by extension across all search-tool segments,
    EXCLUDING segments where every positional source-path is under an exempt dir
    (fixtures/, __snapshots__/, testdata/, etc. — text-scan on fixture data is legitimate),
    AND EXCLUDING metadata-only find segments (find -name X -mtime/-size/...) when no
    downstream search-tool segment consumes find's output (`find ... | xargs grep` still blocks)."""
    segments = [s for s in (seg.strip() for seg in _shell_segments(cmd)) if s]
    if not any(is_search_tool(s) for s in segments):
        return (False, set())
    # non-find content-search tool present anywhere in the pipeline?
    # if yes, metadata-find segments STILL contribute langs (find feeding grep/awk via pipe/xargs)
    has_content_search = any(
        is_search_tool(s) and _seg_head(s) != "find"
        for s in segments
    )
    # whether any segment is a REAL search target (excludes pure metadata-find)
    has_real_search = has_content_search or any(
        is_search_tool(s) and _seg_head(s) == "find" and not _is_metadata_only_find_segment(s)
        for s in segments
    )
    if not has_real_search:
        return (False, set())
    unscoped = any(is_unscoped_recursive_grep(s) for s in segments)
    langs: set = set()
    for s in segments:
        if _is_metadata_only_find_segment(s) and not has_content_search:
            # pure metadata listing, no content-scan downstream → exempt
            continue
        seg_langs = detect_langs(s)
        # skip when this segment's source-paths are ALL under exempt dirs — fixture/snapshot data
        if seg_langs and _all_source_paths_exempt(s):
            continue
        langs |= seg_langs
    return (unscoped, langs)


# --- escalation ----------------------------------------------------------------------
def _bump_block_count(session_id: str, langs: list) -> dict:
    """increment per-(session,lang) block counters; return {lang: new_count} for the bumped langs.
    best-effort — disk errors are non-fatal (escalation is advisory polish, never the gate itself)."""
    if not session_id or not langs:
        return {}
    try:
        data = json.loads(BLOCK_COUNTS_FILE.read_text())
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    try:
        if BLOCK_COUNTS_FILE.exists() and BLOCK_COUNTS_FILE.stat().st_size > 64 * 1024:
            data = {}  # prune runaway file — keep only this session below
    except Exception:
        pass
    sess = data.setdefault(session_id, {})
    out = {}
    for lang in langs:
        try:
            sess[lang] = int(sess.get(lang, 0)) + 1
        except (TypeError, ValueError):
            sess[lang] = 1
        out[lang] = sess[lang]
    try:
        BLOCK_COUNTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = BLOCK_COUNTS_FILE.with_name(BLOCK_COUNTS_FILE.name + ".tmp")
        tmp.write_text(json.dumps(data))
        os.replace(str(tmp), str(BLOCK_COUNTS_FILE))
    except Exception:
        pass
    return out


def _escalation_banner(counts: dict) -> str:
    """counts: {lang: n}. loud directive for any lang at/over ESCALATE_THRESHOLD; '' otherwise."""
    hot = sorted(l for l, n in counts.items() if isinstance(n, int) and n >= ESCALATE_THRESHOLD)
    if not hot:
        return ""
    lines = ["🛑 ESCALATION — repeated grep-on-source blocks this session:"]
    for lang in hot:
        wrapper = DIRECT_WRAPPER_NAME.get(lang, f"{lang}-direct")
        lines.append(
            f"  {lang}: blocked {counts[lang]}× — STOP issuing Bash/Grep searches on {lang} source. "
            f"the ONLY acceptable next tool call for {lang} is ~/.claude/bin/{wrapper} (see per-language "
            f"commands below). do NOT vary the grep/find command and retry — switch tools."
        )
    lines.append(
        "subagents: per ac-implementer.md § LSP-block recovery discipline — after 2 blocks in the same "
        "exploration step, MUST emit `STATUS: PASS_PARTIAL` with the blocked shape recorded in GAPS + "
        "return to orchestrator. NEVER attempt a 3rd same-shape call. orchestrator decides respawn vs accept."
    )
    return "\n".join(lines) + "\n\n"


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
        if not cmd:
            sys.exit(0)
        unscoped, langs = scan_bash_command(cmd)
        if unscoped:
            sys.stderr.write(
                "BLOCKED by enforce-lsp-over-grep: unscoped recursive grep/rg\n"
                "philosophy: LSP for all source-code questions (see lib/rules-on-demand/lsp.md § philosophy). "
                "recursive grep/rg without --include/--type/-g has ambiguous intent — hook cannot tell if target "
                "tree contains source code, so defaults to MANDATORY-LSP rule.\n"
                f"Bash: {cmd[:300]}{'...' if len(cmd) > 300 else ''}\n\n"
                "resolve by declaring intent:\n"
                "  - targeting source code → use the appropriate <lang>-direct wrapper "
                "(metals-direct/vue-direct/py-direct/ts-direct/cs-direct/java-direct)\n"
                "  - targeting non-source files → add --include='*.<ext>' (e.g. *.sql, *.md, *.properties) or -g '*.<ext>' for rg\n"
                "  - scoped to a known non-code subtree → recurse inside conf/, docs/, .claude/, i18n/, etc. explicitly\n"
            )
            _log_block(payload, tool_name, cmd, "unscoped_recursive_grep_bash")
            sys.exit(2)
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
    blocked_langs = []
    for lang in sorted(langs):
        sug = lsp_suggestion(lang, avail)
        if sug is None:
            continue
        msgs.append(f"--- {lang} ---\n{sug}")
        if not sug.startswith("[WARN not block]"):
            block = True
            blocked_langs.append(lang)
    if not msgs:
        sys.exit(0)
    esc = ""
    if block:
        counts = _bump_block_count(payload.get("session_id", ""), blocked_langs)
        esc = _escalation_banner(counts)
    header = (
        "BLOCKED by enforce-lsp-over-grep: use semantic LSP tools on source code\n"
        "philosophy: LSP for all languages. grep/rg/find on code is lossy; misses renames, respects no semantics.\n"
        f"{source}\n\n"
    ) if block else (
        "WARN from enforce-lsp-over-grep: LSP setup incomplete\n"
        f"{source}\n\n"
    )
    sys.stderr.write(esc + header + "\n\n".join(msgs) + "\n")
    if block:
        _log_block(payload, tool_name, source, f"lsp_available_langs:{','.join(sorted(langs))}")
    sys.exit(2 if block else 0)


def _selftest() -> int:
    """inline self-test — POS_CODE_FILE_RE boundary fix + compound-command decomposition.
    run: `python3 enforce-lsp-over-grep.py --selftest`"""
    failed = 0
    pos_cases = [
        ('grep "x" /a/b.ts',                    True),   # plain positional code file
        ('grep "x" /a/b.ts | head -20',         True),   # pipe boundary
        ('grep "x" /a/b.ts > out',              True),   # redirect boundary
        ('grep "x" /a/b.md',                    False),  # non-source extension
        ('grep "foo.ts" /a/b.md',               False),  # code ext INSIDE quoted pattern, target is .md
        ('grep "pattern.ts;literal" file.md',   False),  # ext + separator inside quoted pattern
        ('grep "x" /a/b.ts;echo done',          True),   # real .ts file then ;echo separator
        ("grep 'foo.py' /a/b.md",               False),  # single-quoted pattern variant
    ]
    for cmd, expected_block in pos_cases:
        matched = bool(POS_CODE_FILE_RE.search(_strip_quoted(cmd)))
        ok = matched == expected_block
        print(f"{'OK' if ok else 'FAIL'}: POS {cmd!r} matched={matched} expected={expected_block}")
        if not ok:
            failed += 1
    # scan_bash_command: (cmd) -> (expect_unscoped, expect_langs) across compound segments
    scan_cases = [
        ('cd api && grep -rn "Foo" modules/core/',                  (True, set())),
        ('MEMDIR=x; grep -rln --include="*.scala" Foo /a/b',        (False, {"scala"})),
        ('git diff main | grep -n "def foo"',                       (False, set())),
        ('bash -c "grep -rn Foo /a/b --include=*.scala"',           (False, {"scala"})),
        ('cat foo.txt; rg "MatchUpId" /a/b/scala-dir',              (True, set())),
        ('find /x/api -name "*.scala" | xargs grep -l Foo',         (False, {"scala"})),
        ('echo $(grep -rn Foo /x --include=*.py)',                  (False, {"python"})),
        ('( grep -rn Foo /x/web --include=*.vue )',                 (False, {"vue"})),
        ('npm test 2>&1 | grep -i error',                           (False, set())),
        ('cat changelog.md; rg "v1.2.3" docs/',                     (False, set())),
        ('ls -la && echo done',                                     (False, set())),
        # text-processing bypass shapes (the session a7a0802b incident)
        ("awk '/findCollectorByUserIdAndGroupId/{print}' /a/b.scala",  (False, {"scala"})),
        ("awk '/x/{print NR}' /a/b/Foo.scala",                         (False, {"scala"})),
        ('sed -n \'/Foo/p\' /a/b/foo.py',                              (False, {"python"})),
        ("perl -ne 'print if /x/' /a/b.ts",                            (False, {"typescript"})),
        # inline-script interpreter shapes — block only when -c/-e flag present
        ("python3 -c 'open(\"/a/b.scala\").read()' /a/b.scala",         (False, {"scala"})),
        ("python /usr/bin/normal-script.py",                            (False, set())),  # no -c, just running code
        ("ruby -e 'puts File.read(ARGV[0])' /a/b.scala",                (False, {"scala"})),
        # indirection bypass through bash -c
        ('bash -c "awk \'/x/{print}\' /a/b.scala"',                    (False, {"scala"})),
        ('sh -c "sed -n \'/x/p\' /a/b.py"',                            (False, {"python"})),
        # exempt-path: fixture/snapshot dirs are legitimate text-scan targets
        ("awk '/x/{print}' /a/__snapshots__/snapshot.scala",            (False, set())),
        ("sed -n '/x/p' /a/test/fixtures/golden.py",                    (False, set())),
        ("grep 'foo' /a/fixtures/sample.ts",                            (False, set())),
        ("grep 'foo' /a/testdata/sample.scala",                         (False, set())),
        ("awk '/x/' /a/goldens/expected.py",                            (False, set())),
        # exempt-path doesn't cover unrelated dirs that happen to contain the word
        ("awk '/x/{print}' /a/src/main/scala/Foo.scala",                (False, {"scala"})),
        # git show piped to awk on source content → block (extracted source content is still source)
        ("git show HEAD:src/Foo.scala | awk '/pattern/{print}'",        (False, set())),  # awk has no positional file arg here; intent ambiguous, allow
        # find metadata-only — pure filesystem listing has no LSP equivalent; exempt
        ("find . -name '*.py' -mtime +60",                              (False, set())),
        ("find ~/.claude/hooks -name '*.py' -mtime +60 -maxdepth 1",    (False, set())),
        ("find /a -name '*.scala' -size +10c",                          (False, set())),
        ("find /a -name '*.ts' -newer ref.txt",                         (False, set())),
        ("find /a -name '*.py' -empty",                                 (False, set())),
        ("find /a -name '*.py' -perm 0644",                             (False, set())),
        # find -name without metadata flag → still blocks (content-scan intent ambiguous, conservatively block)
        ("find /a -name '*.py'",                                        (False, {"python"})),
        # find -name + -mtime + -exec grep → direct -exec → metadata-only off → block
        ("find /a -name '*.py' -mtime +60 -exec grep -l foo {} \\;",   (False, {"python"})),
        # find -name + -mtime piped to grep → has_content_search=True → block still applies
        ("find /a -name '*.py' -mtime +60 | xargs grep foo",            (False, {"python"})),
        # codex 2026-05-25 audit gap: shell-wrapper -exec smuggles content-scan via indirection
        ("find /a -name '*.py' -mtime +60 -exec sh -c 'grep foo \"$1\"' _ {} \\;",  (False, {"python"})),
        ("find /a -name '*.scala' -size +1k -exec bash -c 'awk /pat/ \"$1\"' _ {} \\;", (False, {"scala"})),
        ("find /a -name '*.ts' -mtime +1 -execdir /custom/scanner {} \\;",          (False, {"typescript"})),
        # -exec with non-content-scanner tool (e.g. ls, stat, rm) ALSO blocks now —
        # conservative: codex flagged enumeration as fragile; safer to forfeit exemption on any -exec
        ("find /a -name '*.py' -mtime +60 -exec ls -la {} \\;",        (False, {"python"})),
    ]
    for cmd, expected in scan_cases:
        got = scan_bash_command(cmd)
        ok = got == expected
        print(f"{'OK' if ok else 'FAIL'}: SCAN {cmd!r} -> {got} expected={expected}")
        if not ok:
            failed += 1
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        sys.exit(_selftest())
    main()
