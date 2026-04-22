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
FIND_NAME_RE = re.compile(r"""-(?:i?name|regex)\s+['"]*[^'"]*\*(\.\w+)['"]*""")
RG_TYPE_RE = re.compile(r"""--type[=\s](\w+)""")
RG_GLOB_RE = re.compile(r"""-g[=\s]['"]*\*(\.\w+)['"]*""")
# positional code-file argument to grep/rg: "grep pattern path/to/file.scala"
POS_CODE_FILE_RE = re.compile(r"""(?:^|\s)['"]?[^\s'"|&;<>]*(\.(?:scala|sbt|sc|py|ts|tsx|js|jsx|cs|vue|java))['"]?(?:\s|$)""")


def lsp_suggestion(lang: str, avail: dict) -> Optional[str]:
    """return enforcement message if LSP is ready; None if no enforcement applies"""
    info = avail.get("lsps", {}).get(lang) or lang_info_fallback(lang)
    if not info:
        return None
    if lang == "scala":
        if info.get("binary") and info.get("backend"):
            return (
                f"use metals-direct instead of grep on *.scala/*.sbt/*.sc:\n"
                f"  ~/.claude/bin/metals-direct call glob-search '{{\"query\":\"<symbol>\",\"fileInFocus\":\"<abs-path>\"}}' {info.get('workspace','')}\n"
                f"  ~/.claude/bin/metals-direct call get-usages '{{\"fqcn\":\"<fqcn>\",\"module\":\"<mod>\"}}' {info.get('workspace','')}\n"
                f"  ~/.claude/bin/metals-direct tools   # list all metals-mcp operations\n"
                f"grep remains valid for config/data files — NOT source code. state explicitly why metals-direct could not answer before falling back."
            )
        # scala workspace but metals-direct/metals-mcp missing → warn not block
        missing = []
        if not info.get("binary"):
            missing.append("~/.claude/bin/metals-direct wrapper")
        if not info.get("backend"):
            missing.append("metals-mcp binary (brew install metals or cs install metals-mcp)")
        return f"[WARN not block] scala stack detected but missing: {', '.join(missing)}. grep allowed until installed."
    if lang == "vue":
        if info.get("binary") and info.get("backend"):
            return (
                f"use vue-direct instead of grep on *.vue:\n"
                f"  ~/.claude/bin/vue-direct call textDocument/documentSymbol '{{\"textDocument\":{{\"uri\":\"file://<abs-path>\"}}}}' {info.get('workspace','')}\n"
                f"  ~/.claude/bin/vue-direct call textDocument/hover '{{\"textDocument\":{{\"uri\":\"file://<abs-path>\"}},\"position\":{{\"line\":N,\"character\":N}}}}' {info.get('workspace','')}\n"
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
        for m in POS_CODE_FILE_RE.finditer(cmd):
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
        langs = detect_langs(cmd)
        source = "Bash: " + cmd[:200] + ("..." if len(cmd) > 200 else "")
    elif tool_name == "Grep":
        langs = detect_langs_native_grep(inp)
        source = f"Grep(pattern={inp.get('pattern','')[:40]}, type={inp.get('type')}, glob={inp.get('glob')}, path={inp.get('path')})"
    elif tool_name == "mcp__ollama-filter__ollama_filter_call":
        # filter_bash bypass: catches grep/rg/find wrapped in the ollama compression layer
        sub_tool = (inp.get("tool") or "").strip()
        sub_args = inp.get("args") or {}
        if sub_tool != "filter_bash":
            sys.exit(0)
        cmd = sub_args.get("command", "") if isinstance(sub_args, dict) else ""
        if not cmd or not is_search_tool(cmd):
            sys.exit(0)
        langs = detect_langs(cmd)
        source = "ollama_filter_call(filter_bash): " + cmd[:200] + ("..." if len(cmd) > 200 else "")
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
        "BLOCKED by enforce-lsp-over-grep: use semantic LSP tools on source code\n"
        "philosophy: LSP for all languages. grep/rg/find on code is lossy; misses renames, respects no semantics.\n"
        f"{source}\n\n"
    ) if block else (
        "WARN from enforce-lsp-over-grep: LSP setup incomplete\n"
        f"{source}\n\n"
    )
    sys.stderr.write(header + "\n\n".join(msgs) + "\n")
    sys.exit(2 if block else 0)


if __name__ == "__main__":
    main()
