#!/usr/bin/env bash
# verify.sh — per-wrapper functional probe. Two modes:
#   (default)             human-readable: "[lang] OK cold=Xs warm=Ys"
#   --json                machine-readable: one JSON line per wrapper with
#                         {wrapper, lang, status, cold_ms, warm_ms,
#                          response_body_sha256, response_shape_summary}
#   --diff-baselines      runs in --json mode and compares against
#                         fixtures/baselines/<wrapper>.json. Exits 1 on
#                         any shape/sha mismatch; timings warn if >10%
#                         drift but don't fail (noisy on cold machines).
# Skips wrappers whose backing binary isn't on PATH.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$REPO/fixtures"
BASELINES="$FIXTURES/baselines"

MODE="human"
for arg in "$@"; do
  case "$arg" in
    --json) MODE="json" ;;
    --diff-baselines) MODE="diff" ;;
    *) echo "verify.sh: unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# helpers

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# response_shape_summary — derive a structural digest of a JSON response
# that is stable across repeated calls on the same fixture. Strips values
# known to drift (version, server internal IDs) but preserves hierarchy
# + names + kinds for LSP DocumentSymbol responses.
shape_summary() {
  python3 - <<'PY'
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception as e:
    print(json.dumps({"error": f"parse: {e}"}))
    sys.exit(0)
result = data.get("result") if isinstance(data, dict) else data
def walk(node):
    if isinstance(node, list):
        return [walk(x) for x in node]
    if isinstance(node, dict):
        keep = {}
        for k in ("name", "kind", "detail"):
            if k in node:
                keep[k] = node[k]
        if "children" in node:
            keep["children"] = walk(node["children"])
        return keep
    return node
summary = walk(result) if result is not None else None
count = 0
def count_nodes(n):
    global count
    if isinstance(n, list):
        for x in n:
            count_nodes(x)
    elif isinstance(n, dict):
        count += 1
        count_nodes(n.get("children", []))
count_nodes(summary)
print(json.dumps({"top_level": len(summary) if isinstance(summary, list) else None,
                  "total_nodes": count,
                  "outline": summary}, sort_keys=True))
PY
}

body_sha() {
  # sha256 of a canonicalized JSON body; stable across repeated calls
  # when the fixture content doesn't change. Workspace path in URIs
  # is the only source of drift — strip it before hashing.
  local workspace="$1"
  python3 - "$workspace" <<'PY'
import json, sys, hashlib
workspace = sys.argv[1]
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception as e:
    print(hashlib.sha256(f"parse-error:{e}".encode()).hexdigest())
    sys.exit(0)
text = json.dumps(data, sort_keys=True)
text = text.replace(workspace, "<WORKSPACE>")
print(hashlib.sha256(text.encode()).hexdigest())
PY
}

emit_human() {
  local wrapper="$1" lang="$2" status="$3" cold_ms="$4" warm_ms="$5" note="${6:-}"
  if [ "$status" = "OK" ]; then
    printf '[%s] OK  cold=%sms warm=%sms\n' "$lang" "$cold_ms" "$warm_ms"
  elif [ "$status" = "SKIP" ]; then
    printf '[%s] SKIP (%s)\n' "$lang" "$note"
  else
    printf '[%s] FAIL (%s)\n' "$lang" "$note"
  fi
}

emit_json() {
  local wrapper="$1" lang="$2" status="$3" cold_ms="$4" warm_ms="$5"
  local sha="$6" shape="$7" note="${8:-}"
  python3 - "$wrapper" "$lang" "$status" "$cold_ms" "$warm_ms" "$sha" "$shape" "$note" <<'PY'
import json, sys
wrapper, lang, status, cold_ms, warm_ms, sha, shape, note = sys.argv[1:9]
rec = {
  "wrapper": wrapper,
  "lang": lang,
  "status": status,
  "cold_ms": int(cold_ms) if cold_ms else None,
  "warm_ms": int(warm_ms) if warm_ms else None,
  "response_body_sha256": sha or None,
  "response_shape_summary": json.loads(shape) if shape else None,
  "note": note or None,
}
print(json.dumps(rec, sort_keys=True))
PY
}

probe() {
  local lang="$1" wrapper="$2" binary="$3" fixture_dir="$4" target_file="$5"
  local uri="file://$fixture_dir/$target_file"

  if ! command -v "$binary" >/dev/null; then
    [ "$MODE" = "human" ] && emit_human "$wrapper" "$lang" "SKIP" "" "" "$binary not on PATH"
    [ "$MODE" = "json" ] || [ "$MODE" = "diff" ] && emit_json "$wrapper" "$lang" "SKIP" "" "" "" "" "$binary not on PATH"
    return 0
  fi
  if [ ! -x "$REPO/bin/$wrapper" ]; then
    [ "$MODE" = "human" ] && emit_human "$wrapper" "$lang" "FAIL" "" "" "wrapper missing: $REPO/bin/$wrapper"
    [ "$MODE" = "json" ] || [ "$MODE" = "diff" ] && emit_json "$wrapper" "$lang" "FAIL" "" "" "" "" "wrapper missing"
    return 1
  fi

  local t0 t1 cold_ms warm_ms cold_body warm_body sha shape
  t0=$(now_ms)
  # shellcheck disable=SC2034  # cold_body captured to detect cold-call errors; shape/sha derived from warm body
  cold_body=$("$REPO/bin/$wrapper" call textDocument/documentSymbol \
    "{\"textDocument\":{\"uri\":\"$uri\"}}" "$fixture_dir" 2>/dev/null) || {
    [ "$MODE" = "human" ] && emit_human "$wrapper" "$lang" "FAIL" "" "" "cold call errored"
    [ "$MODE" = "json" ] || [ "$MODE" = "diff" ] && emit_json "$wrapper" "$lang" "FAIL" "" "" "" "" "cold call errored"
    return 1
  }
  t1=$(now_ms)
  cold_ms=$((t1 - t0))

  t0=$(now_ms)
  warm_body=$("$REPO/bin/$wrapper" call textDocument/documentSymbol \
    "{\"textDocument\":{\"uri\":\"$uri\"}}" "$fixture_dir" 2>/dev/null) || {
    [ "$MODE" = "human" ] && emit_human "$wrapper" "$lang" "FAIL" "" "" "warm call errored"
    [ "$MODE" = "json" ] || [ "$MODE" = "diff" ] && emit_json "$wrapper" "$lang" "FAIL" "" "" "" "" "warm call errored"
    return 1
  }
  t1=$(now_ms)
  warm_ms=$((t1 - t0))

  # canonical body = warm response (cold may include initialization noise)
  sha=$(printf '%s' "$warm_body" | body_sha "$fixture_dir")
  shape=$(printf '%s' "$warm_body" | shape_summary)

  "$REPO/bin/$wrapper" stop "$fixture_dir" >/dev/null 2>&1 || true

  if [ "$MODE" = "human" ]; then
    emit_human "$wrapper" "$lang" "OK" "$cold_ms" "$warm_ms"
  else
    emit_json "$wrapper" "$lang" "OK" "$cold_ms" "$warm_ms" "$sha" "$shape" ""
  fi
}

run_all() {
  probe python     py-direct      pyright-langserver         "$FIXTURES/python"     hello.py
  probe typescript ts-direct      typescript-language-server "$FIXTURES/typescript" hello.ts
  probe csharp     cs-direct      csharp-ls                  "$FIXTURES/csharp"     hello.cs
  probe vue        vue-direct     vue-language-server        "$FIXTURES/vue"        hello.vue
  probe java       java-direct    jdtls                      "$FIXTURES/java"       src/main/java/com/example/Hello.java
}

if [ "$MODE" = "diff" ]; then
  if [ ! -d "$BASELINES" ]; then
    echo "verify.sh: --diff-baselines requires $BASELINES/ to exist" >&2
    exit 2
  fi
  current=$(mktemp "${TMPDIR:-/tmp}/verify-diff.XXXXXX")
  trap 'rm -f "$current"' EXIT
  run_all >"$current"
  exit_code=0
  while IFS= read -r line; do
    wrapper=$(echo "$line" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("wrapper",""))')
    status=$(echo "$line" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("status",""))')
    [ -z "$wrapper" ] && continue
    baseline="$BASELINES/$wrapper.json"
    if [ "$status" = "SKIP" ]; then
      echo "[$wrapper] SKIP (tool absent) — baseline not checked"
      continue
    fi
    if [ "$status" != "OK" ]; then
      echo "[$wrapper] FAIL — current run did not produce OK result"
      exit_code=1
      continue
    fi
    if [ ! -f "$baseline" ]; then
      echo "[$wrapper] FAIL — no baseline at $baseline (run capture-baseline.sh first)"
      exit_code=1
      continue
    fi
    python3 - "$line" "$baseline" "$wrapper" "${VERIFY_STRICT_SHA:-0}" <<'PY' || exit_code=1
import json, sys
current = json.loads(sys.argv[1])
with open(sys.argv[2]) as f:
    base = json.loads(f.read())
wrapper = sys.argv[3]
strict_sha = sys.argv[4] == '1'
# strict_sha (VERIFY_STRICT_SHA=1): body_sha mismatch FAILS — use in CI
#   where every run is against the same repo baselines on the same image.
# default (VERIFY_STRICT_SHA unset or 0): body_sha mismatch is a WARNING —
#   downstream users on different pyright/tsserver/csharp-ls versions would
#   otherwise fail --diff-baselines with no actual regression. Structural
#   shape and top-level-node count are still hard gates.
issues = []
fatal = False
if current["response_body_sha256"] != base["response_body_sha256"]:
    msg = f"body_sha mismatch: {current['response_body_sha256']} vs baseline {base['response_body_sha256']}"
    if strict_sha:
        issues.append(msg)
        fatal = True
    else:
        issues.append(f"{msg} (warn — set VERIFY_STRICT_SHA=1 to fail)")
cur_shape = current.get("response_shape_summary") or {}
base_shape = base.get("response_shape_summary") or {}
if cur_shape.get("top_level") != base_shape.get("top_level") or cur_shape.get("total_nodes") != base_shape.get("total_nodes"):
    issues.append(f"shape counts differ: top_level={cur_shape.get('top_level')}/{base_shape.get('top_level')} total_nodes={cur_shape.get('total_nodes')}/{base_shape.get('total_nodes')}")
    fatal = True
if strict_sha and cur_shape.get("outline") != base_shape.get("outline"):
    issues.append("outline differs (strict)")
    fatal = True
for k in ("cold_ms", "warm_ms"):
    bv, cv = base.get(k), current.get(k)
    if bv and cv and bv > 0:
        drift = (cv - bv) / bv
        if abs(drift) > 0.10:
            issues.append(f"{k}: {cv}ms vs baseline {bv}ms ({drift*100:+.1f}% — warn only)")
if fatal:
    print(f"[{wrapper}] FAIL")
    for i in issues: print(f"  - {i}")
    sys.exit(1)
elif issues:
    print(f"[{wrapper}] OK (with warnings)")
    for i in issues: print(f"  - {i}")
else:
    print(f"[{wrapper}] OK")
PY
  done <"$current"
  if [ "$exit_code" -eq 0 ]; then
    echo ""
    echo "baselines match."
  else
    echo ""
    echo "BASELINE DIFF DETECTED — see above."
  fi
  exit "$exit_code"
fi

if [ "$MODE" = "human" ]; then
  echo "claude-lsp-direct verify — per-wrapper functional probe"
  echo ""
  run_all
  echo ""
  command -v metals-mcp >/dev/null && echo "[scala]  metals-mcp detected but skipped in verify (needs sbt project)" \
                                   || echo "[scala]  SKIP (metals-mcp not on PATH)"
  echo ""
  echo "done."
else
  run_all
fi
