#!/usr/bin/env python3
"""pretooluse:bash — block 2nd+ same-method <wrapper>-direct call against a DIFFERENT file within window; redirect to batch.

philosophy: when querying >=2 distinct files with the same method against the same direct-wrapper, callers MUST
use `<wrapper>-direct batch <method> <file>...` (LSP wrappers) or `batch-json '<json-array>'` (any wrapper)
NEVER N parallel `call` invocations. one HTTP roundtrip + one tool_result is the design floor.

scope (wrappers with /batch route): ts py cs java vue prettier eslint scalafmt sbt dotnet.
metals-direct excluded — MCP transport, no /batch surface.

trigger: same (session_id, wrapper, method) tuple within 60s window AND a DIFFERENT file URI from
any prior call in the window. first call NEVER blocked. same-file refreshes (refetch on same target)
NEVER blocked — they're idempotent retries, not batch-able fan-out. different-method same-wrapper
sequences NEVER blocked. unparseable-params calls (file_key extraction failed) NEVER blocked — pass
through with a generic ledger entry to avoid FP on unsupported param shapes.

ledger: ~/.claude/locks/recent-direct-calls.json — caps to entries <=5min old on every write.
telemetry: ~/.claude/.metrics/batch-enforcement.log (jsonl, rotates at 256KB → .log.1).
"""
from __future__ import annotations

import json
import os
import re
import shlex
import sys
import time
from pathlib import Path

HOME = Path(os.environ.get("HOME", str(Path.home())))
LEDGER = HOME / ".claude" / "locks" / "recent-direct-calls.json"
METRICS = HOME / ".claude" / ".metrics" / "batch-enforcement.log"

# wrappers with /batch endpoint; metals-direct excluded (MCP transport)
BATCH_LSP_WRAPPERS = {"ts-direct", "py-direct", "cs-direct", "java-direct", "vue-direct"}
BATCH_NON_LSP_WRAPPERS = {"prettier-direct", "eslint-direct", "scalafmt-direct", "sbt-direct", "dotnet-direct"}
BATCH_WRAPPERS = BATCH_LSP_WRAPPERS | BATCH_NON_LSP_WRAPPERS

WINDOW_SEC = 60        # tight wall-clock bounds the "consecutive fan-out" pattern; file-set is the primary signal
LEDGER_MAX_AGE = 300   # drop entries older than 5 min on every write

# wrapper basenames recognized as the COMMAND token (regex on the raw cmd string
# false-positives on quoted args like `grep "ts-direct call foo" ...` per codex review)
_BASENAMES = {f"{n}-direct" for n in ("ts", "py", "cs", "java", "vue", "prettier", "eslint", "scalafmt", "sbt", "dotnet")}

# extract file URI / path from the call's JSON params arg — best-effort, multi-pattern.
_FILE_URI_RE = re.compile(r'"uri"\s*:\s*"(file://[^"]+)"')
_FILE_PATH_RE = re.compile(r'"(?:file|filePath|filepath|filename|path|fileInFocus)"\s*:\s*"([^"]+)"', re.IGNORECASE)


def _log_block(payload: dict, wrapper: str, method: str, file_key: str) -> None:
    """append jsonl entry to telemetry log; rotate at 256KB; silent-pass on any failure.
    disk-only — never emits to stdout/stderr (zero-token invariant)."""
    try:
        from datetime import datetime, timezone
        try:
            if METRICS.exists() and METRICS.stat().st_size > 256 * 1024:
                os.replace(str(METRICS), str(METRICS) + ".1")
        except OSError:
            pass
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "session_id": payload.get("session_id", ""),
            "wrapper": wrapper,
            "method": method,
            "file": file_key,
        }
        METRICS.parent.mkdir(parents=True, exist_ok=True)
        with open(METRICS, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def _ts(v: object) -> float:
    """coerce ledger ts field — numeric passes through; anything else returns 0.0 (treated as
    ancient → pruned on next write). Guards arithmetic from crashing on malformed entries
    (e.g. {'ts': 'bad'} or missing field) per codex 2026-05-19 robustness review."""
    return v if isinstance(v, (int, float)) else 0.0


def _read_ledger() -> list[dict]:
    if not LEDGER.exists():
        return []
    try:
        data = json.loads(LEDGER.read_text())
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _write_ledger(entries: list[dict]) -> None:
    """atomic write; cap entries to LEDGER_MAX_AGE; never crash on IO."""
    try:
        LEDGER.parent.mkdir(parents=True, exist_ok=True)
        tmp = LEDGER.with_suffix(LEDGER.suffix + ".tmp")
        tmp.write_text(json.dumps(entries))
        os.replace(str(tmp), str(LEDGER))
    except OSError:
        pass


def _extract_file(cmd: str) -> str:
    """best-effort file URI / path extraction from call params JSON.
    returns the normalized file path (without file:// prefix) or '' when no file marker found.
    same-file detection relies on this being stable across same-file calls — slight normalization
    only (strip file:// scheme), no resolution / canonicalization."""
    if not cmd:
        return ""
    m = _FILE_URI_RE.search(cmd)
    if m:
        uri = m.group(1)
        return uri[len("file://"):] if uri.startswith("file://") else uri
    m = _FILE_PATH_RE.search(cmd)
    if m:
        return m.group(1)
    return ""


def _detect(cmd: str) -> tuple[str, str, str] | None:
    """parse cmd via shlex tokenization for first <wrapper>-direct call <method> command;
    return (wrapper, method, file_key) or None.

    structural parsing (NOT regex) is required to avoid false-positives on quoted
    arguments like `grep "ts-direct call foo" /tmp/notes.md` where the wrapper-name
    substring appears INSIDE a quoted arg. shlex respects quoting, so the literal
    string is grouped into one token and the basename check fails correctly.
    """
    if not cmd:
        return None
    try:
        tokens = shlex.split(cmd, posix=True)
    except ValueError:
        # malformed quoting → cannot parse safely; pass through (NEVER block on parse error)
        return None
    # walk tokens looking for `[path/]<wrapper>-direct call <method>` triplet.
    # token-bounded — substring matches inside quoted args are excluded by shlex framing.
    for i in range(len(tokens) - 2):
        tok = tokens[i]
        # tok may be plain `ts-direct`, or `~/.claude/bin/ts-direct`, or `/abs/.../ts-direct`
        basename = tok.rsplit("/", 1)[-1]
        if basename not in _BASENAMES:
            continue
        if tokens[i + 1] != "call":
            continue
        method = tokens[i + 2]
        if basename not in BATCH_WRAPPERS:
            return None
        file_key = _extract_file(cmd)
        return basename, method, file_key
    return None


def _suggest(wrapper: str, method: str, prior_files: list[str], new_file: str) -> str:
    distinct = [f for f in (prior_files + [new_file]) if f]
    files_listed = ", ".join(f"`{f}`" for f in distinct)
    head = (
        f"BLOCKED by enforce-batch-on-direct-call: {len(distinct)} distinct-file `{wrapper} call {method}` invocations within {WINDOW_SEC}s\n"
        f"detected files: {files_listed or '(file path not extractable — JSON pattern mismatch)'}\n"
        f"philosophy: querying >=2 DISTINCT files with same method MUST use batch — one HTTP roundtrip + one tool_result.\n"
        f"same-file refreshes pass through unblocked; this fires only on multi-file fan-out.\n\n"
    )
    if wrapper in BATCH_LSP_WRAPPERS:
        return head + (
            f"resolve via:\n"
            f"  ~/.claude/bin/{wrapper} batch {method} /abs/A /abs/B /abs/C   # multi-file fan-out, builds {{textDocument:{{uri:'file://<abs>'}}}} per file\n"
            f"  ~/.claude/bin/{wrapper} batch-json '<json-array of {{method,params}}>'   # raw multi-call passthrough\n\n"
            f"return shape: {{results:[{{ok:true,value}}|{{ok:false,error}}]}} per sub-call — one bad uri NEVER poisons siblings.\n"
            f"override (single intentional re-call on same file): caller waits >{WINDOW_SEC}s."
        )
    return head + (
        f"resolve via:\n"
        f"  ~/.claude/bin/{wrapper} batch-json '<json-array of {{method,params}}>'   # multi-call fan-out\n\n"
        f"return shape: {{results:[{{ok:true,value}}|{{ok:false,error}}]}} per sub-call — one bad sub-call NEVER poisons siblings.\n"
        f"override (single intentional re-call on same file): caller waits >{WINDOW_SEC}s."
    )


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)
    if payload.get("tool_name") != "Bash":
        sys.exit(0)
    cmd = (payload.get("tool_input") or {}).get("command", "")
    detected = _detect(cmd)
    if not detected:
        sys.exit(0)
    wrapper, method, file_key = detected
    session_id = payload.get("session_id", "")
    now = time.time()

    entries = _read_ledger()
    # prune entries older than LEDGER_MAX_AGE — runs on every write.
    # malformed `ts` coerces to 0.0 via _ts → entry is treated as ancient and pruned.
    entries = [e for e in entries if isinstance(e, dict) and (now - _ts(e.get("ts"))) < LEDGER_MAX_AGE]

    # collect prior (session, wrapper, method) entries within WINDOW_SEC
    same_method = [
        e for e in entries
        if e.get("session_id") == session_id
        and e.get("wrapper") == wrapper
        and e.get("method") == method
        and (now - _ts(e.get("ts"))) < WINDOW_SEC
    ]
    if same_method:
        prior_files = [e.get("file", "") for e in same_method]
        prior_distinct_files = {f for f in prior_files if f}
        # block only when this call introduces a NEW distinct file (genuine batch case).
        # same-file refreshes pass through — idempotent retries are NOT batch-able.
        # file_key == '' means extraction failed; pass through (avoid FP on unparseable params).
        if file_key:
            is_new_file = file_key not in prior_distinct_files
            if is_new_file and prior_distinct_files:
                sys.stderr.write(_suggest(wrapper, method, sorted(prior_distinct_files), file_key) + "\n")
                _log_block(payload, wrapper, method, file_key)
                sys.exit(2)
        # same-file repeat or unparseable params — pass through, update fresh ts on matching entry
        updated = False
        for e in entries:
            if (
                e.get("session_id") == session_id
                and e.get("wrapper") == wrapper
                and e.get("method") == method
                and e.get("file") == file_key
            ):
                e["ts"] = now
                updated = True
                break
        if not updated:
            entries.append({
                "ts": now,
                "session_id": session_id,
                "wrapper": wrapper,
                "method": method,
                "file": file_key,
            })
        _write_ledger(entries)
        sys.exit(0)

    # append + persist; first call passes through unblocked
    entries.append({
        "ts": now,
        "session_id": session_id,
        "wrapper": wrapper,
        "method": method,
        "file": file_key,
    })
    _write_ledger(entries)
    sys.exit(0)


if __name__ == "__main__":
    main()
